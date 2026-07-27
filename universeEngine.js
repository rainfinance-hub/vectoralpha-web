/**
 * ============================================================================
 * 分析流水线 (Analysis Pipeline) —— 把 数据层 / 指标层 / 时间周期层 /
 * 信号引擎A / 信号引擎B / 组合评分器 串起来，对单只股票产出一份完整的
 * SymbolAnalysis。这是"扫描"和"历史回溯"共用的核心逻辑——
 * 历史回溯只是多传一个 asOfDate 参数，走的是完全相同的代码路径，
 * 这保证了"回溯出来的信号"和"当时如果真的扫描会得到的信号"是一致的。
 * ============================================================================
 */
'use strict';
import { DataSource } from '../data/dataSource.js';
import { Fundamentals } from '../data/fundamentals.js';
import { getSectorForSymbol } from '../data/sectorMap.js';
import { Indicators as I } from '../core/indicators.js';
import { Timeframe as TF } from '../core/timeframe.js';
import { ResonanceEngine } from '../signals/resonance.js';
import { InstitutionalEngine } from '../signals/institutional.js';
import { CompositeScore } from '../signals/compositeScore.js';
import { MarketContext } from '../signals/marketContext.js';

/** 构建单只股票的"技术上下文"：日/周/短周期/（可选）小时线 close 序列 + 原始统计字段 */
async function buildTechnicalContext(sym, asOfDate) {
  const daily = await DataSource.getDaily(sym, { yearsBack: 2, asOfDate });
  if (daily.bars.length < 60) throw new Error(`${sym}: 日线数据不足(${daily.bars.length}根)，可能是新股/代码错误`);
  const dailySeries = TF.toSeries(daily.bars);
  const weeklyBars = TF.aggregateWeekly(daily.bars);
  const weeklySeries = TF.toSeries(weeklyBars);

  const idx = dailySeries.c.length - 1;
  const sma50Series = I.sma(dailySeries.c, 50);
  const sma150Series = I.sma(dailySeries.c, 150);
  const sma200Series = I.sma(dailySeries.c, 200);
  const wIdx = weeklySeries.c.length - 1;
  const weeklySma30 = I.sma(weeklySeries.c, 30);

  // 短周期：优先尝试真实小时线（Alpaca），拿不到则用短期日线(近30日)代替，明确标注
  let shortClose = dailySeries.c.slice(Math.max(0, idx - 29), idx + 1);
  let shortIsRealHourly = false, hourly4Close = null, hourlySource = 'daily-proxy';
  try {
    const hourly = await DataSource.getHourly(sym, { monthsBack: 6, asOfDate });
    if (hourly.bars.length >= 40) {
      const hSeries = TF.toSeries(hourly.bars);
      shortClose = hSeries.c.slice(-60); // 近60根小时线做短周期RSI/均线
      shortIsRealHourly = true;
      const h4 = TF.aggregateHours(hourly.bars, 4);
      if (h4.length >= 30) hourly4Close = TF.toSeries(h4).c;
      hourlySource = hourly.source;
    }
  } catch (e) { /* 小时线拿不到就静默降级，不中断整体分析 */ }

  const avgVol50 = I.sma_at(dailySeries.v, 50, idx);
  const vol10 = I.sma_at(dailySeries.v, 10, idx);
  const high52w = I.highN(dailySeries.h, Math.min(252, dailySeries.h.length), idx);
  const low52w = I.lowN(dailySeries.l, Math.min(252, dailySeries.l.length), idx);
  const obvArr = I.obv(dailySeries.c, dailySeries.v);
  const cmfArr = I.cmf(dailySeries.h, dailySeries.l, dailySeries.c, dailySeries.v, 20);
  const obvTrendUp = idx >= 20 ? obvArr[idx] > obvArr[idx - 20] : null;
  // 风控工作台需要的字段：ATR14、结构止损参考(近3日低点)、Chandelier参考(近22日高点)
  const atrSeries = I.atr(dailySeries.h, dailySeries.l, dailySeries.c, 14);
  const atrNow = atrSeries[idx];
  const recentLow3 = I.lowN(dailySeries.l, 3, idx);
  const recentHigh22 = I.highN(dailySeries.h, 22, idx);

  return {
    sym, effectiveDate: daily.effectiveDate, requestedDate: daily.requestedDate, isNonTradingDay: daily.isNonTradingDay, dataSource: { daily: daily.source, hourly: hourlySource },
    price: dailySeries.c[idx], idx, dailyClose: dailySeries.c, dailyHigh: dailySeries.h, dailyLow: dailySeries.l, dailyVol: dailySeries.v,
    weeklyClose: weeklySeries.c, wIdx, weeklySma30,
    shortClose, shortIsRealHourly, hourly4Close,
    sma50Now: sma50Series[idx], sma150Now: sma150Series[idx], sma200Now: sma200Series[idx], sma200Series,
    high52w, low52w, avgVol50, vol10, volNow: dailySeries.v[idx],
    obvNow: obvArr[idx], obvTrendUp, cmfNow: cmfArr[idx],
    atrNow, recentLow3, recentHigh22,
  };
}

/**
 * 分析单只股票（不含横截面RS百分位——那需要整批分析完之后才能算，见 finalizeCrossSectional）
 * @returns 半成品 SymbolAnalysis（rs.percentile 待回填）
 */
export async function analyzeSymbol(sym, { asOfDate = null, marketRegime = null, sectorRotation = null, sectorEnabled = false, resonanceCfg = {}, spyDailyClose = null } = {}) {
  const ctx = await buildTechnicalContext(sym, asOfDate);

  let fund = { available: false, warnings: ['尚未查询'] };
  try { fund = await Fundamentals.getBundle(sym); } catch (e) { fund = { available: false, warnings: ['基本面获取异常: ' + e.message] }; }

  const rawRS = spyDailyClose ? InstitutionalEngine.computeRawRS(ctx.dailyClose, spyDailyClose) : null;

  const resonance = ResonanceEngine.analyze({
    weeklyClose: ctx.weeklyClose, dailyClose: ctx.dailyClose, shortClose: ctx.shortClose,
    hourly4Close: ctx.hourly4Close, shortIsRealHourly: ctx.shortIsRealHourly,
  }, resonanceCfg);

  const minervini = InstitutionalEngine.minervini(ctx, null); // rsPercentile 稍后回填重算
  const weinstein = InstitutionalEngine.weinstein(ctx);
  const canslim = InstitutionalEngine.canslim(ctx, fund, null, marketRegime ? marketRegime.trendUp : null);

  // 2026-07 修复：之前这里恒定 sectorEtf=null / sectorScore=50(或null，取决于开关)，
  // 两个变量算出来之后从未被用到返回对象里，行业层实际上从来没有真正生效过
  // （详见 compositeScore.js 和 marketContext.js 的同批修复说明）。现在改成：
  // 用 sectorMap.js 查真实板块归属，开启行业轮动时用 MarketContext.sectorScoreFor()
  // 算出该股票在本次板块轮动排名里的真实百分位，并把两者都放进返回对象，
  // 供 finalizeCrossSectional 传给 CompositeScore、以及风控工作台的行业仓位上限使用。
  const sectorEtf = getSectorForSymbol(sym);
  const sectorScore = sectorEnabled ? MarketContext.sectorScoreFor(sectorEtf, sectorRotation) : null;

  return {
    sym, price: ctx.price, effectiveDate: ctx.effectiveDate, requestedDate: ctx.requestedDate, isNonTradingDay: ctx.isNonTradingDay,
    dataSource: ctx.dataSource,
    sectorEtf, sectorScore,
    rawRS,
    resonance,
    institutional: { minervini, weinstein, canslim, rs: { value: rawRS, percentile: null } },
    quality: { available: fund.available, score: null, fund }, // score 由 UI 层用简单加权算(见 qualityScore.js)，此处先占位
    raw: {
      sma50Now: ctx.sma50Now, sma150Now: ctx.sma150Now, sma200Now: ctx.sma200Now,
      high52w: ctx.high52w, low52w: ctx.low52w, avgVol50: ctx.avgVol50, volNow: ctx.volNow,
      obvTrendUp: ctx.obvTrendUp, cmfNow: ctx.cmfNow,
      atrNow: ctx.atrNow, recentLow3: ctx.recentLow3, recentHigh22: ctx.recentHigh22,
    },
    _ctx: ctx, // 内部保留，供 finalize 阶段重算 minervini/canslim 用（不建议 UI 直接使用下划线字段）
  };
}

/**
 * 横截面收尾：批量分析完成后，计算 RS 百分位并回填到每条结果，
 * 同时用回填后的 RS 重新计算依赖 RS 的 Minervini / CANSLIM 子项，
 * 再调用组合评分器算出最终 composite。
 *
 * 2026-07 新增 rsBenchmark 参数：如果调用方(scanEngine/historyEngine)传入了
 * 一份"全市场RS基准池"(见 rsBenchmark.js)，RS百分位就相对这个统一、跨扫描
 * 稳定的基准分布来算，不再单纯依赖"这次扫描样本恰好有哪些股票"；每条结果
 * 都会标注 institutional.rs.basis = 'benchmark'|'sample'，方便前端/用户知道
 * 这个百分位的可信度和口径。rsBenchmark 缺失或样本太小时自动回退为旧的
 * "样本内百分位"算法，不影响主流程。
 */
export function finalizeCrossSectional(results, { marketRegime = null, sectorRotation = null, sectorEnabled = false, qualityScorer = null, rsBenchmark = null } = {}) {
  const useBenchmark = !!(rsBenchmark && Array.isArray(rsBenchmark.rsValues) && rsBenchmark.rsValues.length >= 30);
  const sampleRsValues = results.map(r => r.rawRS).filter(v => v != null).sort((a, b) => a - b);
  for (const r of results) {
    let pct = null, rsBasis = 'sample';
    if (r.rawRS != null) {
      if (useBenchmark) { pct = I.percentileRank(r.rawRS, rsBenchmark.rsValues); rsBasis = 'benchmark'; }
      else { pct = I.percentileRank(r.rawRS, sampleRsValues); rsBasis = 'sample'; }
    }
    r.institutional.rs.percentile = pct;
    r.institutional.rs.basis = rsBasis;
    r.institutional.minervini = InstitutionalEngine.minervini(r._ctx, pct);
    r.institutional.canslim = InstitutionalEngine.canslim(r._ctx, r.quality.fund, pct, marketRegime ? marketRegime.trendUp : null);
    if (qualityScorer && r.quality.available) {
      const q = qualityScorer(r.quality.fund);
      r.quality.score = q ? q.score : null;
      r.quality.detail = q ? q.detail : [];
      r.quality.available = q != null;
    }
    r.composite = CompositeScore.compute({
      marketScore: marketRegime && marketRegime.available ? marketRegime.score : null,
      sectorScore: r.sectorScore, sectorEnabled,
      resonance: r.resonance,
      institutional: r.institutional,
      quality: r.quality,
    });
    delete r._ctx; // 清理内部字段，避免把庞大的原始序列一直带在结果对象里占内存
  }
  return results;
}
