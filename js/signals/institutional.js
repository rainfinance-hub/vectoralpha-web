/**
 * ============================================================================
 * 信号引擎 B：机构多因子框架 (Institutional Multi-Factor Signal Engine)
 * ----------------------------------------------------------------------------
 * 实现四套经典机构方法论的"技术面可计算部分"：
 *   - Minervini 趋势模板 (Trend Template)：8条经典条件，全部满足才算通过。
 *   - Weinstein 阶段分析 (Stage Analysis)：基于30周均线及其斜率判断1-4阶段。
 *   - CANSLIM：C/A/N/S/L/I/M 七个字母里，技术面可计算的部分(N创新高、L领涨、
 *     S供需/量能、M大盘方向)用技术数据算；C/A(季度/年度盈利增长)、I(机构持仓)
 *     需要基本面数据，若未配置 Finnhub Key 则该子项显式标注"数据不可用"，
 *     不参与打分而不是当0分处理(0分会误导为"差"，而实际是"未知")。
 *   - RS 相对强度：个股 vs SPY 的动量比较 + 同批扫描样本内的百分位排名。
 *
 * 与三频共振引擎(resonance.js)是完全独立、互不依赖的两套框架，
 * 由 compositeScore.js 负责把两套结果分层组合成最终评分。
 * ============================================================================
 */
'use strict';
import { Indicators as I } from '../core/indicators.js';

export const InstitutionalEngine = {

  /**
   * Minervini 趋势模板：
   *  1. 股价 > 150日均线 且 > 200日均线
   *  2. 150日均线 > 200日均线
   *  3. 200日均线至少上行1个月（这里用"20日前的200MA vs 现在的200MA"近似判断斜率向上）
   *  4. 50日均线 > 150日均线 且 > 200日均线
   *  5. 股价 > 50日均线
   *  6. 股价至少比52周低点高25%
   *  7. 股价距52周高点不超过25%（即在高点附近，不是刚脱离深跌）
   *  8. RS 百分位 ≥ 70（相对本次扫描样本；真实IBD RS Rating需要全市场数据，免费源做不到）
   */
  minervini(ctx, rsPercentile) {
    const { price, sma50Now, sma150Now, sma200Now, sma200Series, idx, high52w, low52w } = ctx;
    const cond1 = sma150Now != null && sma200Now != null && price > sma150Now && price > sma200Now;
    const cond2 = sma150Now != null && sma200Now != null && sma150Now > sma200Now;
    const sma200_20agoIdx = idx - 20;
    const sma200_20ago = sma200_20agoIdx >= 0 ? sma200Series[sma200_20agoIdx] : null;
    const cond3 = sma200Now != null && sma200_20ago != null && sma200Now > sma200_20ago;
    const cond4 = sma50Now != null && sma150Now != null && sma200Now != null && sma50Now > sma150Now && sma50Now > sma200Now;
    const cond5 = sma50Now != null && price > sma50Now;
    const cond6 = low52w != null && price >= low52w * 1.25;
    const cond7 = high52w != null && price >= high52w * 0.75;
    const cond8 = rsPercentile != null ? rsPercentile >= 70 : null;

    const detail = [
      { label: '股价 > 150日均线 且 > 200日均线', pass: cond1 },
      { label: '150日均线 > 200日均线', pass: cond2 },
      { label: '200日均线呈上升趋势(近1个月)', pass: cond3 },
      { label: '50日均线 > 150日均线 且 > 200日均线（均线多头排列）', pass: cond4 },
      { label: '股价 > 50日均线', pass: cond5 },
      { label: '股价至少比52周低点高25%', pass: cond6 },
      { label: '股价距52周高点不超过25%', pass: cond7 },
      { label: `RS百分位 ≥ 70（样本内，当前=${rsPercentile ?? 'N/A'}）`, pass: cond8 },
    ];
    const known = detail.filter(d => d.pass !== null);
    const trendTemplatePass = known.length === detail.length && known.every(d => d.pass);
    const score = known.length ? Math.round(known.filter(d => d.pass).length / known.length * 100) : null;
    return { score, detail, trendTemplatePass };
  },

  /**
   * Weinstein 阶段分析：基于30周均线(约150日均线的周线版)及其近4周斜率。
   * Stage 1 筑底(横盘，均线走平) / Stage 2 上升(价格>均线且均线向上，最佳买点阶段)
   * Stage 3 派发(横盘，前期涨幅大) / Stage 4 下降(价格<均线且均线向下)
   */
  weinstein(ctx) {
    const { weeklyClose, weeklySma30, wIdx } = ctx;
    if (!weeklyClose || wIdx < 4 || weeklySma30[wIdx] == null || weeklySma30[wIdx - 4] == null) {
      return { stage: null, detail: [], note: '周线数据不足，无法判断阶段' };
    }
    const price = weeklyClose[wIdx];
    const ma = weeklySma30[wIdx];
    const maSlope = (weeklySma30[wIdx] - weeklySma30[wIdx - 4]) / Math.abs(weeklySma30[wIdx - 4]);
    const priceAboveMA = price > ma;
    const maUp = maSlope > 0.005; // 4周内均线上移>0.5%视为向上
    const maDown = maSlope < -0.005;

    let stage, label;
    if (priceAboveMA && maUp) { stage = 2; label = 'Stage 2 上升阶段（价格站上30周均线且均线向上，理论最佳买点区间）'; }
    else if (!priceAboveMA && maDown) { stage = 4; label = 'Stage 4 下降阶段（价格跌破30周均线且均线向下，应规避/清仓）'; }
    else if (priceAboveMA && !maUp) { stage = 3; label = 'Stage 3 派发阶段（价格仍在均线上方但均线走平/转向，警惕见顶）'; }
    else { stage = 1; label = 'Stage 1 筑底阶段（价格在均线下方震荡，等待放量突破确认Stage2）'; }

    return {
      stage, label,
      detail: [
        { label: '价格 vs 30周均线', pass: priceAboveMA, value: `${price.toFixed(2)} vs ${ma.toFixed(2)}` },
        { label: '30周均线斜率(近4周)', pass: maUp, value: (maSlope * 100).toFixed(2) + '%' },
      ],
    };
  },

  /**
   * CANSLIM（技术面部分 + 可选基本面部分）
   * C/A: 需要基本面(EPS同比/环比增长)，无Key时标注不可用
   * N: 股价创/接近新高（技术面）
   * S: 缩量整理后放量突破（供需，技术面）
   * L: 相对同批样本是否领涨（RS百分位，技术面）
   * I: 机构持仓（免费数据源做不到时点级别，标注不可用）
   * M: 大盘方向（由 marketRegime 传入，技术面）
   */
  canslim(ctx, fund, rsPercentile, marketRegimeUp) {
    const { price, high52w, avgVol50, volNow, vol10 } = ctx;
    const nPass = high52w != null && price != null ? price >= high52w * 0.95 : null; // N: 逼近或创新高
    const volDryUp = vol10 != null && avgVol50 != null ? vol10 < avgVol50 * 0.85 : null;
    const breakout = volNow != null && avgVol50 != null ? volNow > avgVol50 * 1.4 : null;
    const sPass = (volDryUp != null && breakout != null) ? (volDryUp || breakout) : null; // S: 缩量整理或放量突破
    const lPass = rsPercentile != null ? rsPercentile >= 80 : null; // L: 领涨
    const mPass = marketRegimeUp; // M: 可能为 null(未知)

    const fundAvailable = fund && fund.available;
    const aPass = fundAvailable ? (fund.growth.epsGrowthTTM != null ? fund.growth.epsGrowthTTM > 20 : null) : null; // A: 年度EPS增长>20%
    const cPass = fundAvailable ? (fund.growth.revenueGrowthTTM != null ? fund.growth.revenueGrowthTTM > 15 : null) : null; // C: 当季营收增长>15%(近似)
    const iPass = null; // I: 免费数据源拿不到时点级机构持仓变化，恒定标注不可用

    const detail = [
      { key: 'C', label: '当期营收/盈利加速增长', pass: cPass, available: fundAvailable },
      { key: 'A', label: '年度EPS增长 > 20%', pass: aPass, available: fundAvailable },
      { key: 'N', label: '股价创新高或接近新高(95%以内)', pass: nPass, available: true },
      { key: 'S', label: '供需关系良好(缩量整理/放量突破)', pass: sPass, available: true },
      { key: 'L', label: '同批样本内是龙头(RS百分位≥80)', pass: lPass, available: rsPercentile != null },
      { key: 'I', label: '机构持仓变化', pass: iPass, available: false, note: '免费数据源无时点级13F数据，恒定不可用' },
      { key: 'M', label: '大盘处于上升趋势', pass: mPass, available: mPass != null },
    ];
    const known = detail.filter(d => d.available && d.pass !== null);
    const score = known.length ? Math.round(known.filter(d => d.pass).length / known.length * 100) : null;
    // 2026-07 新增：数据覆盖率 + 置信度标注。评审里点出的真实问题——CANSLIM混合了
    // C/A/N/S/L/I/M七个维度，免费Finnhub额度经常缺C/A/I，score只是"可用维度里的通过率"，
    // 78分如果只是4/7维度可用算出来的，含金量和7/7全可用的78分完全不一样，
    // 之前只在文字里提了sampleSize/totalItems，没有一个直接可读的置信度结论，
    // 容易被误解成"78分=很强"。这里显式给出 coverage 字符串 + High/Medium/Low 置信度，
    // 前端(detail modal + 派生池列表)据此提示，而不是让用户自己去算 sampleSize/totalItems。
    const coverage = `${known.length}/${detail.length}`;
    const confidence = known.length >= 6 ? 'High' : known.length >= 4 ? 'Medium' : 'Low';
    const confidenceLabel = { High: '高（≥6/7项可用）', Medium: '中（4~5/7项可用）', Low: '低（≤3/7项可用，评分参考意义有限）' }[confidence];
    return { score, detail, sampleSize: known.length, totalItems: detail.length, coverage, confidence, confidenceLabel };
  },

  /** RS：个股相对SPY的N日收益率差，横截面百分位在 analysisPipeline 里批量回填 */
  computeRawRS(dailyClose, spyDailyClose, lookback = 63) {
    const n = dailyClose.length - 1, m = spyDailyClose.length - 1;
    if (n < lookback || m < lookback) return null;
    const stockRet = (dailyClose[n] - dailyClose[n - lookback]) / dailyClose[n - lookback];
    const spyRet = (spyDailyClose[m] - spyDailyClose[m - lookback]) / spyDailyClose[m - lookback];
    return (stockRet - spyRet) * 100; // 百分点形式的超额收益，作为原始RS值参与横截面排名
  },
};
