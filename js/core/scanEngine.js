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
 * 并发说明（2026-07 性能优化）：
 * 早期版本是完全串行的 for 循环 + 每只股票固定sleep 200ms，500只股票实测要
 * 8~10分钟——太慢。现在改成"worker池"并发模式：同时开 N 个worker，各自从
 * 股票队列里领任务，互不等待。免费数据源(Alpaca/Finnhub)都有请求频率限制，
 * 并发太高会触发 429，所以默认并发数选得比较保守(5)，且 alpacaClient.js
 * 里的 429 会自动指数退避重试——即使偶尔撞到限流也不会整体失败，只是那一只
 * 股票会稍微慢一点。如果你的Key额度更高、想更快，可以调大 opts.concurrency；
 * 如果发现日志里大量"速率限制重试"，就调小一点。
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

    const concurrency = Math.max(1, Math.min(opts.concurrency || 5, symbols.length));
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
