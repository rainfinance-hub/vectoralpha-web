/**
 * ============================================================================
 * Universe Engine（股票池引擎）
 * ----------------------------------------------------------------------------
 * 这是整个系统的"股票从哪来"的唯一入口。所有选股模块（三频共振、CANSLIM、
 * Minervini、Weinstein、RS、质量评分等）都从这里取股票列表，不各自维护
 * 硬编码的股票数组——这样以后要换/扩池子，只改这一个文件。
 *
 * 15 类股票池分两种性质：
 *  A) 种子池 / 用户池（SEED）：不依赖任何计算结果，可以直接喂给数据层去扫描。
 *     Core / ETF / Sector / Industry / Growth / Watchlist / Portfolio / Custom
 *  B) 派生池（DERIVED）：必须先对某个种子池跑完"信号引擎"分析，
 *     再从分析结果里按条件筛选/排序得到——因为"动量强不强""质量高不高"
 *     这些判断本身就需要先算出指标。
 *     Momentum / Quality / High RS / New Highs / Institutional Buying /
 *     CANSLIM Candidates / Minervini Candidates
 *  C) 事件池（EVENT）：依赖外部日历类数据（财报日期），免费数据源覆盖有限。
 *     Earnings Watch
 *
 * 派生池所需要的 SymbolAnalysis 对象结构（由 signals/ 目录下的引擎产出）：
 *   {
 *     sym, price, effectiveDate, sector,
 *     resonance: { weekly, daily, short, hourly, passCount, allPass },
 *     institutional: { canslim, minervini, weinstein, rs },
 *     quality: { score, detail, available },
 *     composite: { score, breakdown },
 *     raw: { sma50Now, sma150Now, sma200Now, high52w, low52w, avgVol50, volNow, obv, cmf }
 *   }
 * ============================================================================
 */
'use strict';
import { DOW30, NASDAQ100, SECTOR_ETFS, ETF_UNIVERSE, INDUSTRY_LEADERS, GROWTH_SEEDS, fetchSP500 } from '../data/symbolLists.js';

const LS_WATCHLIST = 'va_watchlist';   // [{sym, addedDate, note}]
const LS_PORTFOLIO = 'va_portfolio';   // [{sym, shares, cost, buyDate, note, tag, customStop, customTarget}]
const LS_CUSTOM = 'va_custom_pool';    // [sym,...]

export const PoolRegistry = [
  { id: 'core',          name: 'Core Universe 核心池',        kind: 'SEED',    weight: '★★★★★', desc: 'S&P500 + Nasdaq100 + Dow30 去重，流动性最好、数据最完整的默认扫描池。' },
  { id: 'etf',            name: 'ETF Universe',                kind: 'SEED',    weight: '★★★★',  desc: '宽基+板块+主题ETF，代表机构资金的板块轮动方向。' },
  { id: 'sector',        name: 'Sector Universe 板块池',       kind: 'SEED',    weight: '★★★',   desc: '11个SPDR板块ETF，用于板块相对强度对比。' },
  { id: 'industry',      name: 'Industry Universe 行业池',     kind: 'SEED',    weight: '★★★★',  desc: '每个细分行业的3-5家龙头，扫描快、覆盖面好。' },
  { id: 'growth',        name: 'Growth Universe 成长池',       kind: 'SEED',    weight: '★★★★★', desc: '高成长候选种子池，实际成长性由信号引擎二次确认。' },
  { id: 'quality',       name: 'Quality Universe 质量池',      kind: 'DERIVED', weight: '★★★★',  desc: '基于ROE/FCF/负债/利润率等质量评分从Core+Growth派生，适合长期持有筛选。' },
  { id: 'momentum',      name: 'Momentum Universe 趋势池',     kind: 'DERIVED', weight: '★★★★',  desc: 'RS>80 + 创新高 + 均线多头排列 + 放量，每次扫描后动态变化。' },
  { id: 'watchlist',     name: 'Watchlist 观察池',              kind: 'SEED',    weight: '★★★',   desc: '用户手动维护的自选股，带日期/备注。' },
  { id: 'portfolio',     name: 'Portfolio 持仓池',              kind: 'SEED',    weight: '★★★★★', desc: '当前持仓，扫描后进入风控工作台复核。' },
  { id: 'earningsWatch', name: 'Earnings Watch 财报关注池',    kind: 'EVENT',   weight: '★★★',   desc: '未来N天内有财报的股票，依赖可选的Finnhub财报日历Key，无Key则标注不可用。' },
  { id: 'highRS',        name: 'High Relative Strength 高强度池', kind: 'DERIVED', weight: '★★★★', desc: 'RS百分位排名前10%（相对本次扫描样本，非全市场IBD RS Rating）。' },
  { id: 'newHighs',      name: 'New Highs 新高池',             kind: 'DERIVED', weight: '★★★',   desc: '收盘价创52周新高或逼近新高(1%以内)的股票。' },
  { id: 'institutional', name: 'Institutional Buying 机构买入池(代理指标)', kind: 'DERIVED', weight: '★★', desc: '⚠️免费数据源拿不到真实13F/机构持仓变化，本池用"持续放量+OBV/CMF资金流向上"作为代理指标，不代表真实机构调仓，仅供参考。' },
  { id: 'canslim',       name: 'CANSLIM Candidates 候选池',     kind: 'DERIVED', weight: '★★★★',  desc: 'CANSLIM各分项评分达标的候选股（由信号引擎B计算）。' },
  { id: 'minervini',     name: 'Minervini Candidates 候选池',   kind: 'DERIVED', weight: '★★★★',  desc: '通过Minervini趋势模板(Trend Template)全部条件的候选股。' },
  { id: 'custom',        name: 'Custom Universe 自定义池',     kind: 'SEED',    weight: '自定义', desc: '用户手动输入的任意代码列表，一次性使用，不落盘（如需保存请用观察池）。' },
];

export const UniverseEngine = {

  registry() { return PoolRegistry; },

  // ---------------- 种子池 ----------------
  async getSeedSymbols(poolId, opts = {}) {
    switch (poolId) {
      case 'core': {
        const sp500 = await fetchSP500();
        const merged = [...new Set([...sp500.symbols, ...NASDAQ100, ...DOW30])];
        return { symbols: merged, meta: { sp500Source: sp500.source, count: merged.length } };
      }
      case 'etf':
        return { symbols: [...ETF_UNIVERSE], meta: { count: ETF_UNIVERSE.length } };
      case 'sector':
        return { symbols: SECTOR_ETFS.map(s => s.sym), meta: { count: SECTOR_ETFS.length, detail: SECTOR_ETFS } };
      case 'industry': {
        const all = Object.values(INDUSTRY_LEADERS).flat();
        return { symbols: [...new Set(all)], meta: { count: all.length, byIndustry: INDUSTRY_LEADERS } };
      }
      case 'growth':
        return { symbols: [...GROWTH_SEEDS], meta: { count: GROWTH_SEEDS.length, note: '种子候选池，最终是否算"成长股"由信号引擎的成长性子项确认' } };
      case 'watchlist': {
        const list = this.getWatchlist();
        return { symbols: list.map(x => x.sym), meta: { count: list.length, detail: list } };
      }
      case 'portfolio': {
        const list = this.getPortfolio();
        return { symbols: list.map(x => x.sym), meta: { count: list.length, detail: list } };
      }
      case 'custom':
        return { symbols: opts.customList || [], meta: { count: (opts.customList || []).length } };
      default:
        throw new Error(`未知或非种子池: ${poolId}`);
    }
  },

  // ---------------- 用户池：观察池 Watchlist ----------------
  getWatchlist() { try { return JSON.parse(localStorage.getItem(LS_WATCHLIST) || '[]'); } catch { return []; } },
  saveWatchlist(list) { localStorage.setItem(LS_WATCHLIST, JSON.stringify(list)); },
  addToWatchlist(sym, note = '') {
    const list = this.getWatchlist();
    const s = sym.toUpperCase();
    const existing = list.find(x => x.sym === s);
    if (existing) { existing.note = note || existing.note; existing.addedDate = existing.addedDate || new Date().toISOString().slice(0, 10); }
    else list.push({ sym: s, addedDate: new Date().toISOString().slice(0, 10), note });
    this.saveWatchlist(list);
    return list;
  },
  removeFromWatchlist(sym) {
    const list = this.getWatchlist().filter(x => x.sym !== sym.toUpperCase());
    this.saveWatchlist(list);
    return list;
  },

  // ---------------- 用户池：持仓 Portfolio ----------------
  getPortfolio() { try { return JSON.parse(localStorage.getItem(LS_PORTFOLIO) || '[]'); } catch { return []; } },
  savePortfolio(list) { localStorage.setItem(LS_PORTFOLIO, JSON.stringify(list)); },
  addPosition(pos) {
    const list = this.getPortfolio();
    list.push({ id: Date.now(), sym: pos.sym.toUpperCase(), shares: Number(pos.shares), cost: Number(pos.cost), buyDate: pos.buyDate || new Date().toISOString().slice(0, 10), note: pos.note || '', tag: pos.tag || '', customStop: pos.customStop ? Number(pos.customStop) : null, customTarget: pos.customTarget ? Number(pos.customTarget) : null });
    this.savePortfolio(list);
    return list;
  },
  removePosition(id) {
    const list = this.getPortfolio().filter(p => p.id !== id);
    this.savePortfolio(list);
    return list;
  },

  // ---------------- 用户池：自定义 Custom ----------------
  getCustomPool() { try { return JSON.parse(localStorage.getItem(LS_CUSTOM) || '[]'); } catch { return []; } },
  saveCustomPool(list) { localStorage.setItem(LS_CUSTOM, JSON.stringify(list)); },

  /**
   * 派生池：从已完成分析的 SymbolAnalysis[] 里按条件筛选/排序。
   * 必须先对某个种子池（通常是 core + growth 去重后的样本）跑完信号引擎，
   * 再调用本函数得到 Momentum/Quality/High RS/New Highs/机构买入代理/CANSLIM/Minervini 候选。
   */
  deriveDynamicPools(resultsPool, cfg = {}) {
    const rsPctThreshold = cfg.rsPctThreshold ?? 80;
    const highRSThreshold = cfg.highRSThreshold ?? 90;
    const newHighTolerance = cfg.newHighTolerance ?? 0.01; // 1%以内视为逼近新高
    const qualityThreshold = cfg.qualityThreshold ?? 70;
    const canslimThreshold = cfg.canslimThreshold ?? 70;

    const momentum = resultsPool.filter(r => {
      const rs = r.institutional?.rs?.percentile;
      const raw = r.raw || {};
      const maStack = raw.sma50Now != null && raw.sma150Now != null && raw.sma200Now != null && raw.sma50Now > raw.sma150Now && raw.sma150Now > raw.sma200Now;
      const nearHigh = raw.high52w != null && r.price != null && r.price >= raw.high52w * (1 - 0.08); // 距52周高点8%以内
      const volUp = raw.volNow != null && raw.avgVol50 != null && raw.volNow > raw.avgVol50;
      return rs != null && rs >= rsPctThreshold && maStack && nearHigh && volUp;
    }).sort((a, b) => (b.institutional?.rs?.percentile ?? 0) - (a.institutional?.rs?.percentile ?? 0));

    const quality = resultsPool.filter(r => r.quality?.available && r.quality.score >= qualityThreshold)
      .sort((a, b) => b.quality.score - a.quality.score);

    const highRS = resultsPool.filter(r => (r.institutional?.rs?.percentile ?? -1) >= highRSThreshold)
      .sort((a, b) => (b.institutional?.rs?.percentile ?? 0) - (a.institutional?.rs?.percentile ?? 0));

    const newHighs = resultsPool.filter(r => {
      const raw = r.raw || {};
      return raw.high52w != null && r.price != null && r.price >= raw.high52w * (1 - newHighTolerance);
    }).sort((a, b) => (b.price / (b.raw.high52w || 1)) - (a.price / (a.raw.high52w || 1)));

    // 机构买入代理：连续放量 + OBV/CMF 向上，明确标注"代理指标"
    const institutional = resultsPool.filter(r => {
      const raw = r.raw || {};
      const volSurge = raw.volNow != null && raw.avgVol50 != null && raw.volNow > raw.avgVol50 * 1.2;
      const obvUp = raw.obvTrendUp === true;
      const cmfPositive = raw.cmfNow != null && raw.cmfNow > 0.05;
      return volSurge && (obvUp || cmfPositive);
    }).sort((a, b) => (b.raw.cmfNow ?? 0) - (a.raw.cmfNow ?? 0));

    const canslim = resultsPool.filter(r => (r.institutional?.canslim?.score ?? 0) >= canslimThreshold)
      .sort((a, b) => (b.institutional.canslim.score) - (a.institutional.canslim.score));

    const minervini = resultsPool.filter(r => r.institutional?.minervini?.trendTemplatePass === true)
      .sort((a, b) => (b.institutional?.rs?.percentile ?? 0) - (a.institutional?.rs?.percentile ?? 0));

    return { momentum, quality, highRS, newHighs, institutional, canslim, minervini };
  },
};
