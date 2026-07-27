/**
 * ============================================================================
 * 市场环境模块 (Market Context) —— Market Regime + Sector Rotation
 * ----------------------------------------------------------------------------
 * 独立于个股分析之外，每次扫描只需要算一次，结果被所有个股共享：
 *  - Market Regime：SPY 是否处于上升趋势（价格 vs 50/200日均线 + 200日均线斜率），
 *    用于综合评分的"市场层"权重，以及 CANSLIM 的 M 条件。
 *  - Sector Rotation：11个板块ETF过去1/3个月相对SPY的超额收益排名，
 *    用于综合评分的"行业层"权重（默认关闭，用户可在设置里打开，
 *    关闭时行业层固定给中性50分，相当于自动退化为"市场层+个股层"）。
 * ============================================================================
 */
'use strict';
import { Indicators as I } from '../core/indicators.js';
import { DataSource } from '../data/dataSource.js';
import { SECTOR_ETFS } from '../data/symbolLists.js';

export const MarketContext = {

  async getMarketRegime(asOfDate = null) {
    const { bars, source } = await DataSource.getDaily('SPY', { yearsBack: 2, asOfDate });
    if (bars.length < 210) return { available: false, note: 'SPY 历史数据不足' };
    const close = bars.map(b => b.c);
    const n = close.length - 1;
    const sma50 = I.sma(close, 50), sma200 = I.sma(close, 200);
    const priceAboveBoth = sma50[n] != null && sma200[n] != null && close[n] > sma50[n] && close[n] > sma200[n];
    const sma200Slope = sma200[n] != null && sma200[n - 20] != null ? sma200[n] - sma200[n - 20] : null;
    const trendUp = priceAboveBoth && sma200Slope != null && sma200Slope > 0;
    const score = (priceAboveBoth ? 60 : 20) + (sma200Slope != null && sma200Slope > 0 ? 40 : 0);
    return {
      available: true, trendUp, score: Math.min(100, score),
      price: close[n], sma50: sma50[n], sma200: sma200[n], sma200Slope, source,
      label: trendUp ? '大盘：上升趋势（SPY站上50/200日均线，200日均线向上）' : '大盘：非明确上升趋势，谨慎对待多头信号',
    };
  },

  async getSectorRotation(asOfDate = null, lookbackDays = 63) {
    const results = [];
    for (const s of SECTOR_ETFS) {
      try {
        const { bars } = await DataSource.getDaily(s.sym, { yearsBack: 1, asOfDate });
        const close = bars.map(b => b.c);
        const n = close.length - 1;
        if (n < lookbackDays) { results.push({ ...s, ret: null }); continue; }
        const ret = (close[n] - close[n - lookbackDays]) / close[n - lookbackDays] * 100;
        results.push({ ...s, ret });
      } catch (e) {
        results.push({ ...s, ret: null, error: e.message });
      }
    }
    const valid = results.filter(r => r.ret != null).sort((a, b) => b.ret - a.ret);
    valid.forEach((r, i) => { r.rank = i + 1; });
    const bySymbol = {};
    results.forEach(r => { bySymbol[r.sym] = r; });
    return { available: valid.length > 0, ranking: valid, bySymbol, lookbackDays };
  },

  /**
   * 给定某个股所属板块ETF代码，返回它在板块轮动排名里的百分位分数(0-100)。
   * 2026-07 修复：之前这里查不到数据时会返回中性50分，导致"不知道"被当成
   * "中性"参与打分，还会让 compositeScore.js 误以为该层"可用"从而占满整个
   * 10%权重。现在统一返回 null，明确表示"这一层这只股票算不出来"，
   * 由 compositeScore.js 把权重按比例分给其他真正可用的层。
   */
  sectorScoreFor(sectorEtfSym, sectorRotation) {
    if (!sectorEtfSym) return null; // 该股票没有可识别的板块归属(见 sectorMap.js 的局限性说明)
    if (!sectorRotation || !sectorRotation.available) return null; // 行业轮动数据本身不可用
    const item = sectorRotation.bySymbol[sectorEtfSym];
    if (!item || item.rank == null) return null;
    const total = sectorRotation.ranking.length;
    return Math.round((1 - (item.rank - 1) / Math.max(1, total - 1)) * 100);
  },
};
