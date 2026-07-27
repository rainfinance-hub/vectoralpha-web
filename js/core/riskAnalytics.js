/**
 * ============================================================================
 * Portfolio Risk Analytics（组合风险分析）—— V2 第七阶段新增
 * ----------------------------------------------------------------------------
 * 和 riskWorkbench.js 的分工：riskWorkbench.js 负责"给单只候选股票算建议
 * 仓位/止损/止盈"，是逐只计算的；这个文件负责"组合整体层面"的风险度量，
 * 是把已有持仓/候选仓位汇总起来算的，两者互补，不重复、不冲突。
 *
 * 覆盖范围（均为纯函数，不依赖数据库或网络，方便单元测试）：
 *  - Open Risk / Portfolio Heat：组合"如果所有止损都被触发，会亏多少钱/占净值百分比"。
 *  - Sector Exposure / Theme Exposure：按板块ETF(sectorMap.js)/成长主题(symbolLists.js
 *    的GROWTH_THEMES)汇总持仓市值占比，识别"看似分散、实际集中"的组合。
 *  - Correlation：两两持仓的相关系数矩阵(用 indicators.js 新增的 computeCorrelation)，
 *    高相关的持仓即使分属不同代码，实际承担的是同一种风险来源。
 *  - Risk Budget / Max Open Risk / Max Sector Risk / Max Theme Risk：把上面算出来的
 *    敞口和用户设定的上限比较，超限的输出违规提示，供UI直接展示。
 *  - Kelly Position / Volatility Position / Risk Parity：三种不同哲学的仓位权重算法，
 *    供用户参考对比（不是"取代"riskWorkbench.js既有的止损距离仓位法，是"另一个角度"）。
 *
 * ATR Position Sizing 已经在 riskWorkbench.js 的 stopMode='atr' 里实现了(用
 * price - N×ATR 作为止损价再按风险预算反推股数)，这里不重复实现，避免同一件
 * 事有两份不同的代码维护，容易出现两者结果不一致的bug。
 * ============================================================================
 */
'use strict';
import { Indicators } from './indicators.js';
import { getThemeForSymbol } from '../data/symbolLists.js';

export const RiskAnalytics = {

  /**
   * Open Risk：组合里所有持仓"现价->止损价"之间的浮动风险金额加总。
   * 已经跌破止损价的持仓按0计入(那部分风险已经实际发生，不再是"未来风险")。
   * @param {Array<{shares, price, stopPrice}>} positions
   */
  computeOpenRisk(positions) {
    let openRisk = 0;
    for (const p of positions || []) {
      if (p.shares == null || p.price == null || p.stopPrice == null) continue;
      const perShareRisk = Math.max(0, p.price - p.stopPrice);
      openRisk += perShareRisk * p.shares;
    }
    return Math.round(openRisk);
  },

  /** Portfolio Heat：Open Risk 占账户净值的百分比，机构常用术语，衡量"组合整体在冒多大的险" */
  computePortfolioHeat(positions, equity) {
    if (!equity || equity <= 0) return null;
    const openRisk = this.computeOpenRisk(positions);
    return Math.round((openRisk / equity) * 1000) / 10;
  },

  /** Sector Exposure：按板块ETF汇总持仓市值占净值百分比。positions需带 sectorEtf 字段（见 sectorMap.js）。 */
  computeSectorExposure(positions, equity) {
    if (!equity || equity <= 0) return [];
    const bySector = {};
    for (const p of positions || []) {
      if (p.shares == null || p.price == null) continue;
      const key = p.sectorEtf || '未归类';
      bySector[key] = (bySector[key] || 0) + p.shares * p.price;
    }
    return Object.entries(bySector)
      .map(([sector, value]) => ({ sector, value: Math.round(value), pctOfEquity: Math.round((value / equity) * 1000) / 10 }))
      .sort((a, b) => b.value - a.value);
  },

  /** Theme Exposure：按成长主题(GROWTH_THEMES)汇总，查不到主题的股票归入"无主题标签"，不强行归类 */
  computeThemeExposure(positions, equity) {
    if (!equity || equity <= 0) return [];
    const byTheme = {};
    for (const p of positions || []) {
      if (p.shares == null || p.price == null) continue;
      const theme = getThemeForSymbol(p.sym) || '无主题标签';
      byTheme[theme] = (byTheme[theme] || 0) + p.shares * p.price;
    }
    return Object.entries(byTheme)
      .map(([theme, value]) => ({ theme, value: Math.round(value), pctOfEquity: Math.round((value / equity) * 1000) / 10 }))
      .sort((a, b) => b.value - a.value);
  },

  /**
   * 相关系数矩阵：closeSeriesMap = { sym: closeArray(时间升序) }。
   * 返回 { symbols: [...], matrix: number[][] }，matrix[i][j] 是 symbols[i] 与 symbols[j] 的相关系数。
   * 数据不足(<30个交易日重叠)的股票对返回 null，不是0（0代表"确认不相关"，null代表"算不出来"，两者含义不同）。
   */
  computeCorrelationMatrix(closeSeriesMap) {
    const symbols = Object.keys(closeSeriesMap || {});
    const matrix = symbols.map(() => new Array(symbols.length).fill(null));
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i; j < symbols.length; j++) {
        if (i === j) { matrix[i][j] = 1; continue; }
        const corr = Indicators.computeCorrelation(closeSeriesMap[symbols[i]], closeSeriesMap[symbols[j]]);
        matrix[i][j] = corr;
        matrix[j][i] = corr;
      }
    }
    return { symbols, matrix };
  },

  /**
   * 找出组合里相关性过高的持仓对（高相关意味着"看似分散、实际暴露在同一个风险来源下"）。
   * @param {{symbols, matrix}} corrResult computeCorrelationMatrix 的返回值
   * @param {number} threshold 相关系数超过这个值就标记出来，默认0.75
   */
  findHighCorrelationPairs(corrResult, threshold = 0.75) {
    const { symbols, matrix } = corrResult;
    const pairs = [];
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const c = matrix[i][j];
        if (c != null && Math.abs(c) >= threshold) pairs.push({ a: symbols[i], b: symbols[j], correlation: c });
      }
    }
    return pairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  },

  /**
   * Kelly 仓位分数：kellyFraction = winRate - (1-winRate)/payoffRatio。
   * payoffRatio = 平均盈利% / 平均亏损%(取绝对值)。结果可能为负(说明策略期望值为负，
   * 不建议用这个信号做仓位分配)，调用方需要自行处理负值(通常直接视为0仓位)。
   * 现实中很少用"满Kelly"(波动极大)，界面上建议提供 kellyMultiplier(如0.5=半Kelly)。
   * @param {{winRate, avgWinPct, avgLossPct}} stats winRate是0~1小数，avgWinPct/avgLossPct是百分比(正数)
   */
  computeKellyFraction({ winRate, avgWinPct, avgLossPct }) {
    if (winRate == null || avgWinPct == null || avgLossPct == null || avgLossPct <= 0) return null;
    const payoffRatio = avgWinPct / avgLossPct;
    const f = winRate - (1 - winRate) / payoffRatio;
    return Math.round(f * 1000) / 1000;
  },

  /** 把 Kelly 分数换算成建议分配的资金金额，kellyMultiplier 默认用半Kelly(0.5)，更保守 */
  kellyPositionSize({ equity, kellyFraction, kellyMultiplier = 0.5, maxPositionPct = 25 }) {
    if (equity == null || kellyFraction == null) return null;
    const effectiveFraction = Math.max(0, kellyFraction) * kellyMultiplier;
    const cappedFraction = Math.min(effectiveFraction, maxPositionPct / 100);
    return { fraction: Math.round(cappedFraction * 1000) / 10, capitalAmount: Math.round(equity * cappedFraction) };
  },

  /**
   * 波动率反比仓位法(Volatility Position Sizing)：候选股票的建议权重与其波动率成反比，
   * 波动率越高分配越少，从而让每只股票对组合贡献的"风险"趋于一致。
   * @param {Array<{sym, atrPct}>} candidates atrPct = ATR14/现价*100，代表相对波动率
   * @param {number} totalBudget 要分配的总资金
   */
  volatilityPositionSizing(candidates, totalBudget) {
    const valid = (candidates || []).filter(c => c.atrPct != null && c.atrPct > 0);
    if (!valid.length) return [];
    const invVols = valid.map(c => 1 / c.atrPct);
    const sumInv = invVols.reduce((a, b) => a + b, 0);
    return valid.map((c, i) => {
      const weight = invVols[i] / sumInv;
      return { sym: c.sym, atrPct: c.atrPct, weight: Math.round(weight * 1000) / 10, capitalAmount: Math.round(totalBudget * weight) };
    }).sort((a, b) => b.weight - a.weight);
  },

  /**
   * 简化版风险平价(Naive Risk Parity)：用"波动率反比"权重近似等风险贡献组合。
   * 严格意义上的风险平价需要迭代求解协方差矩阵下的等风险贡献权重，这里用业界
   * 常见的简化近似(反比波动率加权)，如实标注不是完整迭代优化版本。
   * @param {Array<{sym, volatilityPct}>} positions volatilityPct 建议用年化波动率或ATR%
   */
  riskParityWeights(positions) {
    const valid = (positions || []).filter(p => p.volatilityPct != null && p.volatilityPct > 0);
    if (!valid.length) return [];
    const invVols = valid.map(p => 1 / p.volatilityPct);
    const sumInv = invVols.reduce((a, b) => a + b, 0);
    return valid.map((p, i) => ({ sym: p.sym, volatilityPct: p.volatilityPct, weight: Math.round((invVols[i] / sumInv) * 1000) / 10 }))
      .sort((a, b) => b.weight - a.weight);
  },

  /**
   * Risk Budget 检查：把已算出的敞口和用户设定的上限比较，返回违规项列表(空数组=全部合规)。
   * @param {object} params { openRisk, equity, maxOpenRiskPct, sectorExposure, maxSectorRiskPct, themeExposure, maxThemeRiskPct }
   */
  checkRiskBudget({ openRisk, equity, maxOpenRiskPct, sectorExposure = [], maxSectorRiskPct, themeExposure = [], maxThemeRiskPct }) {
    const violations = [];
    if (equity > 0 && maxOpenRiskPct != null) {
      const heat = (openRisk / equity) * 100;
      if (heat > maxOpenRiskPct) violations.push({ type: 'openRisk', message: `组合总风险敞口(Portfolio Heat) ${Math.round(heat * 10) / 10}% 超过上限 ${maxOpenRiskPct}%` });
    }
    if (maxSectorRiskPct != null) {
      for (const s of sectorExposure) {
        if (s.pctOfEquity > maxSectorRiskPct) violations.push({ type: 'sector', sector: s.sector, message: `板块「${s.sector}」仓位占比 ${s.pctOfEquity}% 超过上限 ${maxSectorRiskPct}%` });
      }
    }
    if (maxThemeRiskPct != null) {
      for (const t of themeExposure) {
        if (t.pctOfEquity > maxThemeRiskPct) violations.push({ type: 'theme', theme: t.theme, message: `主题「${t.theme}」仓位占比 ${t.pctOfEquity}% 超过上限 ${maxThemeRiskPct}%` });
      }
    }
    return violations;
  },
};
