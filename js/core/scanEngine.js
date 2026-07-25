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

    const results = [];
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      try {
        const r = await analyzeSymbol(sym, { asOfDate: null, marketRegime, sectorRotation, sectorEnabled: opts.sectorEnabled || false, resonanceCfg: opts.resonanceCfg || {}, spyDailyClose });
        results.push(r);
      } catch (e) {
        results.push({ sym, error: e.message, isError: true });
      }
      if (onProgress) onProgress(i + 1, symbols.length, sym);
      await new Promise(r => setTimeout(r, 200));
    }
    const valid = results.filter(r => !r.isError);
    finalizeCrossSectional(valid, { marketRegime, sectorRotation, sectorEnabled: opts.sectorEnabled || false, qualityScorer: computeQualityScore });

    return {
      isHistorical: false, marketRegime, sectorRotation,
      results: [...valid, ...results.filter(r => r.isError)],
      scannedAt: new Date().toISOString(),
    };
  },
};
