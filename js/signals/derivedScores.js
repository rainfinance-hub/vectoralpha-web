/**
 * ============================================================================
 * 衍生评分：Growth Score / Momentum Score —— V2 第一阶段(Universe Builder)新增
 * ----------------------------------------------------------------------------
 * Dynamic Universe Builder 支持按 "Growth Score" / "Momentum Score" 筛选，
 * 但项目原有的评分体系(qualityScore.js / compositeScore.js)里没有这两个
 * 独立数值字段——三频共振和机构多因子层已经隐含了"动量"的判断，但没有
 * 单独产出一个0-100分。这里新增两个纯函数，风格和 qualityScore.js 保持
 * 一致：每项子指标各打0-100分，缺失的子指标直接跳过、不计入平均，
 * 全部子指标都缺失时返回 null（不是0分，"不可用"≠"差"）。
 * ============================================================================
 */
'use strict';

function scoreRange(value, lowBad, highGood) {
  if (value == null) return null;
  if (highGood >= lowBad) {
    if (value <= lowBad) return 0;
    if (value >= highGood) return 100;
    return Math.round((value - lowBad) / (highGood - lowBad) * 100);
  }
  if (value >= lowBad) return 0;
  if (value <= highGood) return 100;
  return Math.round((lowBad - value) / (lowBad - highGood) * 100);
}

/**
 * Growth Score：基于基本面增速数据(EPS/营收 TTM 增速 + EPS 5年增速)，
 * 需要 Fundamentals.getBundle() 的 growth 字段，未配置 Finnhub Key 时
 * fund.available=false，本函数直接返回 null。
 */
export function computeGrowthScore(fund) {
  if (!fund || !fund.available) return null;
  const { growth } = fund;
  const items = [
    { label: '营收增速(TTM)', score: scoreRange(growth.revenueGrowthTTM, 0, 40) },
    { label: 'EPS增速(TTM)', score: scoreRange(growth.epsGrowthTTM, 0, 40) },
    { label: 'EPS增速(5年)', score: scoreRange(growth.epsGrowth5Y, 0, 30) },
  ].filter(i => i.score != null);
  if (!items.length) return null;
  return { score: Math.round(items.reduce((s, i) => s + i.score, 0) / items.length), detail: items };
}

/**
 * Momentum Score：基于技术面动量特征，不依赖基本面Key，只要有日线数据就能算。
 * 子指标：RS百分位(权重最大，动量的核心定义) + 均线多头排列(50>150>200) +
 * 量能是否放大(现量>50日均量)。
 * @param {{ sma50Now, sma150Now, sma200Now, volNow, avgVol50 }} raw analysisPipeline产出的raw字段
 * @param {number|null} rsPercentile
 */
export function computeMomentumScore(raw, rsPercentile) {
  if (!raw) return null;
  const items = [];
  if (rsPercentile != null) items.push({ label: 'RS百分位', score: rsPercentile, weight: 0.6 });
  if (raw.sma50Now != null && raw.sma150Now != null && raw.sma200Now != null) {
    const maStack = raw.sma50Now > raw.sma150Now && raw.sma150Now > raw.sma200Now;
    items.push({ label: '均线多头排列', score: maStack ? 100 : 0, weight: 0.25 });
  }
  if (raw.volNow != null && raw.avgVol50 != null) {
    const volUp = raw.volNow > raw.avgVol50;
    items.push({ label: '量能放大', score: volUp ? 100 : 0, weight: 0.15 });
  }
  if (!items.length) return null;
  const weightSum = items.reduce((s, i) => s + i.weight, 0);
  const score = items.reduce((s, i) => s + i.score * (i.weight / weightSum), 0);
  return { score: Math.round(score), detail: items };
}
