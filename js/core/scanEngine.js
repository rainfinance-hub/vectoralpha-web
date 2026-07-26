/**
 * ============================================================================
 * 实时扫描引擎 (Scan Engine)
 * ----------------------------------------------------------------------------
 * 和 historyEngine.lookbackBatch 走完全相同的 analysisPipeline，唯一区别是
 * asOfDate=null（取最新数据）。之所以单独封装一个文件而不是让 UI 直接调用
 * historyEngine 传 null，是为了让"扫描"和"回溯"在代码语义上保持清晰区分，
 * 避免以后维护时搞混"这是实时结果还是回溯结果"。
 *
 * 扫描完成后的结果可以直接喂给 UniverseEngine.deriveDynamicPools()，
 * 得到 Momentum / Quality / High RS / New Highs / 机构买入代理 /
 * CANSLIM候选 / Minervini候选 这几个派生池。
 *
 * 并发说明（2026-07 性能优化，v1.3 → v1.4）：
 * v1.3 版本是"worker池"并发模式（同时开5个worker各自领任务），理论上应该比
 * 纯串行快不少，但用户实测517只股票仍然要11分37秒，几乎没有改善。
 * 复盘后发现：瓶颈根本不是"并发数不够"，而是"请求总数太多"——每只股票
 * 都要单独发1次日线请求+1次小时线请求，517只 = 1000+次独立HTTP请求，
 * 很容易撞上 Alpaca 免费额度"每分钟请求数"的限流；一旦触发429，
 * 退避等待(0.8s/1.6s/3.2s)会迅速累积，光靠加并发数救不回来
 * （并发只是让更多请求同时排队等限流，不会减少总请求量）。
 * v1.4 改成"批量预取"：扫描开始前，先用 DataSource.getDailyBatch/
 * getHourlyBatch 把整批股票的K线用"多symbol打包"的方式一次性请求回来
 * （Alpaca支持一次请求传入上百个symbol），517只股票的日线+小时线加起来
 * 只需要几十次请求，而不是1000+次——这是数量级上的差别。批量预取完之后，
 * 下面的 worker池循环里 analyzeSymbol→DataSource.getDaily/getHourly 基本
 * 都会直接命中缓存，不再发起新请求，所以把默认并发数调高到8也是安全的。
 * 如果批量预取因为网络问题失败，会自动静默降级为"逐只请求"（兜底不受影响，
 * 只是速度退回v1.3水平），不会导致扫描失败。
 * ============================================================================
 */
'use strict';
import { analyzeSymbol, finalizeCrossSectional } from './analysisPipeline.js';
import { MarketContext } from '../signals/marketContext.js';
import { computeQualityScore } from '../signals/qualityScore.js';
import { DataSource } from '../data/dataSource.js';

export const ScanEngine = {
  async scan(symbols, opts = {}, onProgress = null) {
    const marketRegime = await MarketContext.getMarketRegime(null).catch(e => ({ available: false, error: e.message }));
    const sectorRotation = opts.sectorEnabled ? await MarketContext.getSectorRotation(null).catch(() => ({ available: false })) : null;
    let spyDailyClose = null;
    try {
      const spy = await DataSource.getDaily('SPY', { yearsBack: 1 });
      spyDailyClose = spy.bars.map(b => b.c);
    } catch (e) { /* ignore */ }

    // 批量预取（见上方注释）：把整批股票的日线/小时线一次性打包请求回来塞进缓存，
    // 是这次真正解决"扫描慢"问题的关键改动，不是单纯调并发数。
    try {
      await Promise.all([
        DataSource.getDailyBatch(symbols, { yearsBack: 2 }),
        DataSource.getHourlyBatch(symbols, { monthsBack: 6 }),
      ]);
    } catch (e) { /* 批量预取失败不阻断，后面逐只请求会自动兜底 */ }

    const concurrency = Math.max(1, Math.min(opts.concurrency || 8, symbols.length));
    const results = new Array(symbols.length);
    let nextIndex = 0;
    let doneCount = 0;

    const worker = async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= symbols.length) return;
        const sym = symbols[i];
        try {
          results[i] = await analyzeSymbol(sym, { asOfDate: null, marketRegime, sectorRotation, sectorEnabled: opts.sectorEnabled || false, resonanceCfg: opts.resonanceCfg || {}, spyDailyClose });
        } catch (e) {
          results[i] = { sym, error: e.message, isError: true };
        }
        doneCount++;
        if (onProgress) onProgress(doneCount, symbols.length, sym);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    const valid = results.filter(r => !r.isError);
    finalizeCrossSectional(valid, { marketRegime, sectorRotation, sectorEnabled: opts.sectorEnabled || false, qualityScorer: computeQualityScore });

    return {
      isHistorical: false, marketRegime, sectorRotation,
      results: [...valid, ...results.filter(r => r.isError)],
      scannedAt: new Date().toISOString(),
    };
  },
};
