/**
 * ============================================================================
 * 全市场 RS 基准池 (RS Benchmark) —— 2026-07 新增
 * ----------------------------------------------------------------------------
 * 问题背景：之前 RS 百分位是"相对本次扫描的这批股票"现算的，样本一变
 * (比如观察池30只 vs Core池600只)，同一只股票的RS百分位会完全不同，
 * 没法跨扫描比较，也不符合"RS Rating"本该是"相对全市场"的定义——
 * 这是之前几个版本一直没解决、评审里明确点出来的问题。
 *
 * 解决思路：单独维护一个样本量较大、相对稳定的"基准池"，每天(或每个历史
 * 日期)只计算一次这批股票的RS原始值分布并缓存，之后所有扫描/批量回溯的
 * RS百分位都查这个统一分布表算，不再随"这次具体扫了哪些股票"变化。
 *
 * 基准池的股票范围：Core(S&P500+Nasdaq100+Dow30) + Growth + Industry Leaders
 * 去重后大约700~900只，是免费数据源下能做到的"全市场代理"，不是官方
 * Russell 3000/Wilshire 5000完整成分股——如实说明，不假装更精确。
 * 得益于 v1.4 的"多symbol批量打包请求"，构建这个规模的基准池现在只需要
 * 几十次网络请求，不是几百上千次，所以做到"每天自动重建一次"是可行的。
 *
 * 缓存策略：
 *  - 实时(asOfDate=null)：缓存按"今天的日期"失效，每天第一次扫描时自动重建。
 *  - 历史(asOfDate=具体日期)：历史价格不会变，缓存永久有效；为避免
 *    localStorage 无限增长，只保留最近构建过的10个历史日期，超出后
 *    按"最久未构建"淘汰。
 *  - 构建失败(没配置Key/网络问题/样本太小)会抛错，调用方(scanEngine/
 *    historyEngine)会自动捕获并回退到"本次扫描样本内百分位"，不影响主流程，
 *    只是retro到旧版本的行为，并在结果里标注 rsBasis:'sample'。
 * ============================================================================
 */
'use strict';
import { DataSource } from '../data/dataSource.js';
import { InstitutionalEngine } from '../signals/institutional.js';
import { UniverseEngine } from './universeEngine.js';
import { GROWTH_SEEDS, INDUSTRY_LEADERS } from '../data/symbolLists.js';

const LS_KEY = 'va_rs_benchmark_cache_v1';
const MAX_HISTORICAL_ENTRIES = 10;
const MIN_SAMPLE_FOR_USE = 30; // 基准样本量低于这个数就不采信，回退为样本内百分位

function todayStr() { return new Date().toISOString().slice(0, 10); }

function loadCacheStore() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function saveCacheStore(store) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) { /* 存储配额不足时静默失败，不影响本次内存里已经拿到的基准 */ }
}

export const RSBenchmark = {

  /**
   * 参与基准计算的股票范围：Core + Growth + Industry Leaders 去重。
   * 免费数据源下"全市场"的近似代理，见文件头注释。
   */
  async _getBenchmarkUniverse() {
    const core = await UniverseEngine.getSeedSymbols('core').catch(() => ({ symbols: [] }));
    const industryAll = Object.values(INDUSTRY_LEADERS).flat();
    return [...new Set([...core.symbols, ...GROWTH_SEEDS, ...industryAll])];
  },

  async build(asOfDate = null) {
    const symbols = await this._getBenchmarkUniverse();
    if (symbols.length < 50) throw new Error('基准股票池样本量过小，放弃构建');

    const spy = await DataSource.getDaily('SPY', { yearsBack: 1, asOfDate });
    const spyClose = spy.bars.map(b => b.c);

    // 复用 v1.4 的批量预取：把这700~900只股票的日线一次性打包请求回来，
    // 之后逐只调用 DataSource.getDaily 基本都是缓存命中，不会产生额外网络请求。
    await DataSource.getDailyBatch(symbols, { yearsBack: 1, asOfDate }).catch(() => { /* 批量失败会逐只回退，不阻断构建 */ });

    const rsValues = [];
    let ok = 0, fail = 0;
    for (const sym of symbols) {
      try {
        const { bars } = await DataSource.getDaily(sym, { yearsBack: 1, asOfDate });
        const close = bars.map(b => b.c);
        const rs = InstitutionalEngine.computeRawRS(close, spyClose);
        if (rs != null) { rsValues.push(rs); ok++; } else { fail++; }
      } catch (e) { fail++; }
    }
    rsValues.sort((a, b) => a - b);
    const benchmark = { asOfDate, builtAt: new Date().toISOString(), universeSize: symbols.length, sampleOk: ok, sampleFail: fail, rsValues };
    if (benchmark.rsValues.length < MIN_SAMPLE_FOR_USE) {
      throw new Error(`基准构建后有效样本仅 ${benchmark.rsValues.length} 只，太少，放弃使用`);
    }
    this._persist(benchmark);
    return benchmark;
  },

  _persist(benchmark) {
    const store = loadCacheStore();
    if (!benchmark.asOfDate) {
      store.live = benchmark;
    } else {
      store.historical = store.historical || {};
      store.historical[benchmark.asOfDate] = benchmark;
      const dates = Object.keys(store.historical);
      if (dates.length > MAX_HISTORICAL_ENTRIES) {
        // 按构建时间淘汰最久的一个（LRU），而不是按日期新旧
        dates.sort((a, b) => new Date(store.historical[a].builtAt) - new Date(store.historical[b].builtAt));
        delete store.historical[dates[0]];
      }
    }
    saveCacheStore(store);
  },

  _readCached(asOfDate) {
    const store = loadCacheStore();
    if (!asOfDate) {
      if (store.live && store.live.builtAt && store.live.builtAt.slice(0, 10) === todayStr()) return store.live;
      return null;
    }
    return (store.historical && store.historical[asOfDate]) || null;
  },

  /**
   * 确保拿到一份可用的基准（优先用缓存，缓存失效才重新构建）。
   * 构建失败时会抛错，调用方(scanEngine/historyEngine)负责 catch 并回退。
   */
  async ensureFresh(asOfDate = null) {
    const cached = this._readCached(asOfDate);
    if (cached && cached.rsValues && cached.rsValues.length >= MIN_SAMPLE_FOR_USE) return cached;
    return await this.build(asOfDate);
  },

  /** 强制重新构建(忽略缓存)，供设置页"手动刷新"按钮使用 */
  async forceRebuild(asOfDate = null) {
    return await this.build(asOfDate);
  },

  /** 给设置页展示当前基准状态用 */
  getStatusText() {
    const store = loadCacheStore();
    if (!store.live) return '尚未建立（下次扫描时会自动建立一次，约需几十秒，取决于网络状况）';
    const isToday = store.live.builtAt && store.live.builtAt.slice(0, 10) === todayStr();
    return `${isToday ? '✓ 今日基准已建立' : '⚠️ 基准已过期(非今天建立)，下次扫描会自动重建'} · 样本 ${store.live.sampleOk}/${store.live.universeSize} 只 · 建立于 ${store.live.builtAt ? store.live.builtAt.replace('T', ' ').slice(0, 19) : 'N/A'}`;
  },
};
