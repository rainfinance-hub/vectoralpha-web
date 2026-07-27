/**
 * ============================================================================
 * 历史特定日期回溯引擎 (History Lookback Engine) —— 项目最核心的功能
 * ----------------------------------------------------------------------------
 * 用户输入一个历史日期(YYYY-MM-DD)，本模块会：
 *   1. 把该日期传给整条分析流水线（analysisPipeline），所有价格类数据
 *      (日/周/短周期/小时线、均线、MACD、RSI、52周高低点等)都基于
 *      "只使用截止到该日期为止的数据"重新计算——不是简单地在最新数据上
 *      标个日期，而是真正地把时间"倒回去"。
 *   2. 如果该日期是周末/节假日（非交易日），自动回退到之前最近的交易日，
 *      并在结果里用 isNonTradingDay 标注，前端会提示"已自动使用最近交易日 XXXX-XX-XX"。
 *   3. 基本面/机构持仓类数据（Quality层、CANSLIM的C/A/I子项）因为免费数据源
 *      只提供最新快照，无法真正回溯到历史时点，所有相关字段都会被打上
 *      ⚠️ NON_POINT_IN_TIME 标记，前端必须原样展示这个警告，不能悄悄隐藏。
 *   4. 输出内容覆盖：当天各周期指标状态、三频共振结果、机构多因子结果、
 *      综合评分明细、多周期共振情况一览——而不仅仅是"是否触发信号"这一个布尔值。
 * ============================================================================
 */
'use strict';
import { analyzeSymbol, finalizeCrossSectional } from './analysisPipeline.js';
import { MarketContext } from '../signals/marketContext.js';
import { computeQualityScore } from '../signals/qualityScore.js';
import { DataSource } from '../data/dataSource.js';
import { RSBenchmark } from './rsBenchmark.js';

export const HistoryEngine = {

  /**
   * 单只股票历史回溯（最常用入口：对应"输入股票代码+历史日期"）。
   * 会构造一个只含这一只股票的"横截面"，RS百分位在单样本下没有统计意义，
   * 因此额外返回 rsNote 提示用户：单只查询时RS百分位不可用，
   * 建议在"批量回溯"里把它和一批股票一起跑，RS排名才有意义。
   */
  async lookbackSingle(symbol, asOfDate, opts = {}) {
    if (!asOfDate) throw new Error('必须提供历史日期 (YYYY-MM-DD)');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw new Error('日期格式应为 YYYY-MM-DD');
    const today = new Date().toISOString().slice(0, 10);
    if (asOfDate > today) throw new Error('不能查询未来日期');

    const marketRegime = await MarketContext.getMarketRegime(asOfDate).catch(e => ({ available: false, error: e.message }));
    let spyDailyClose = null;
    try {
      const spy = await DataSource.getDaily('SPY', { yearsBack: 1, asOfDate });
      spyDailyClose = spy.bars.map(b => b.c);
    } catch (e) { /* 拿不到SPY就跳过RS计算，不阻断主流程 */ }

    const result = await analyzeSymbol(symbol.toUpperCase(), {
      asOfDate, marketRegime, spyDailyClose, sectorEnabled: opts.sectorEnabled || false, resonanceCfg: opts.resonanceCfg || {},
    });
    finalizeCrossSectional([result], { marketRegime, sectorEnabled: opts.sectorEnabled || false, qualityScorer: computeQualityScore });

    return {
      ...result,
      isHistorical: true,
      marketRegime,
      rsNote: '⚠️ 单只股票查询时 RS 百分位样本量为1，不具备统计意义；如需真实RS排名请使用"批量回溯"对一批股票同时查询',
      nonPointInTimeWarning: '⚠️ 基本面/机构持仓相关字段(Quality层、CANSLIM的C/A/I子项)使用的是当前最新快照数据，并非该历史日期的真实时点数据（免费数据源限制）',
    };
  },

  /**
   * 批量回溯：对一批股票（通常来自某个Universe池）在同一个历史日期下重新计算，
   * RS百分位在这批样本内部有意义，可以看到"当天谁最强"。
   */
  async lookbackBatch(symbols, asOfDate, opts = {}, onProgress = null) {
    if (!asOfDate) throw new Error('必须提供历史日期 (YYYY-MM-DD)');
    const marketRegime = await MarketContext.getMarketRegime(asOfDate).catch(e => ({ available: false, error: e.message }));
    const sectorRotation = opts.sectorEnabled ? await MarketContext.getSectorRotation(asOfDate).catch(() => ({ available: false })) : null;
    let spyDailyClose = null;
    try {
      const spy = await DataSource.getDaily('SPY', { yearsBack: 1, asOfDate });
      spyDailyClose = spy.bars.map(b => b.c);
    } catch (e) { /* ignore */ }

    // 批量预取（2026-07 速度优化，原理和 scanEngine.js 完全一致，详见该文件顶部注释）：
    // 用"多symbol打包请求"一次性把整批股票的K线取回塞进缓存，把请求总数从
    // "股票数×2"降到几十次，这是解决批量回溯慢的关键，不是单纯调并发数。
    try {
      await Promise.all([
        DataSource.getDailyBatch(symbols, { yearsBack: 2, asOfDate }),
        DataSource.getHourlyBatch(symbols, { monthsBack: 6, asOfDate }),
      ]);
    } catch (e) { /* 批量预取失败不阻断，后面逐只请求会自动兜底 */ }

    // 全市场RS基准池（2026-07 新增）：历史回溯用"该历史日期"对应的基准分布，
    // 不是今天的基准——历史价格不变，这份基准一旦为某个日期建立过就会一直缓存复用。
    const rsBenchmark = await RSBenchmark.ensureFresh(asOfDate).catch(e => {
      console.warn(`[HistoryEngine] 全市场RS基准(${asOfDate})不可用，回退为样本内百分位: ${e.message}`);
      return null;
    });

    // 并发worker池扫描，原理和 scanEngine.js 一致（预取后基本命中缓存，默认并发调到8）
    const concurrency = Math.max(1, Math.min(opts.concurrency || 8, symbols.length));
    const results = new Array(symbols.length);
    let nextIndex = 0, doneCount = 0;
    const worker = async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= symbols.length) return;
        const sym = symbols[i];
        try {
          results[i] = await analyzeSymbol(sym, { asOfDate, marketRegime, sectorRotation, sectorEnabled: opts.sectorEnabled || false, resonanceCfg: opts.resonanceCfg || {}, spyDailyClose });
        } catch (e) {
          results[i] = { sym, error: e.message, isError: true };
        }
        doneCount++;
        if (onProgress) onProgress(doneCount, symbols.length, sym);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    const valid = results.filter(r => !r.isError);
    finalizeCrossSectional(valid, { marketRegime, sectorRotation, sectorEnabled: opts.sectorEnabled || false, qualityScorer: computeQualityScore, rsBenchmark });

    return {
      asOfDate, marketRegime, sectorRotation, isHistorical: true,
      rsBenchmarkMeta: rsBenchmark ? { universeSize: rsBenchmark.universeSize, sampleOk: rsBenchmark.sampleOk, builtAt: rsBenchmark.builtAt, asOfDate: rsBenchmark.asOfDate } : null,
      results: [...valid, ...results.filter(r => r.isError)],
      nonPointInTimeWarning: '⚠️ 基本面/机构持仓相关字段使用当前最新快照数据，非该历史日期时点数据（免费数据源限制）',
    };
  },
};
