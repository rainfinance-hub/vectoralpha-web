/**
 * ============================================================================
 * 质量评分模块 (Quality Score) —— 支撑 Quality Universe
 * ----------------------------------------------------------------------------
 * 纯基本面维度，把 ROE / ROIC / 毛利率 / 净利率 / FCF margin / 营收增速 /
 * EPS增速 / 负债率 八项指标各打0-100分再平均。任何一项缺失数据的字段
 * 直接跳过、不计入平均（不会因为数据缺口拉低分数）。
 * 若 fundamentals bundle 完全不可用(没配置Key)，上层不会调用本函数，
 * 直接把 quality.available 设为 false，UI 显示"数据不可用"。
 * ============================================================================
 */
'use strict';

function scoreRange(value, lowBad, highGood) {
  if (value == null) return null;
  if (highGood >= lowBad) {
    if (value <= lowBad) return 0;
    if (value >= highGood) return 100;
    return Math.round((value - lowBad) / (highGood - lowBad) * 100);
  } else { // 负债率这类"越低越好"的指标，lowBad实际是"好"的上界，highGood是"差"的下界
    if (value >= lowBad) return 0;
    if (value <= highGood) return 100;
    return Math.round((lowBad - value) / (lowBad - highGood) * 100);
  }
}

export function computeQualityScore(fund) {
  if (!fund || !fund.available) return null;
  const { ratios, growth } = fund;
  const items = [
    { label: 'ROE', score: scoreRange(ratios.roe, 0, 30) },
    { label: 'ROIC', score: scoreRange(ratios.roic, 0, 20) },
    { label: '毛利率', score: scoreRange(ratios.grossMargin, 20, 70) },
    { label: '净利率', score: scoreRange(ratios.netMargin, 0, 25) },
    { label: 'FCF利润率', score: scoreRange(ratios.fcfMargin, 0, 20) },
    { label: '营收增速(TTM)', score: scoreRange(growth.revenueGrowthTTM, 0, 30) },
    { label: 'EPS增速(TTM)', score: scoreRange(growth.epsGrowthTTM, 0, 30) },
    { label: '负债权益比', score: scoreRange(ratios.debtToEquity, 150, 0) }, // 越低越好
  ].filter(i => i.score != null);
  if (!items.length) return null;
  return { score: Math.round(items.reduce((s, i) => s + i.score, 0) / items.length), detail: items };
}
