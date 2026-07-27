/**
 * ============================================================================
 * 分层组合评分器 (Composite Score) —— 把"三频共振"和"机构多因子"两套独立框架
 * 按分层权重合并成一个 0-100 的最终评分，并保留完整的分项明细。
 * ----------------------------------------------------------------------------
 * 五层结构（对应你选择的"两者都要，分层组合"）：
 *   ① 市场层 Market Regime      权重 15%（自动生效）
 *   ② 行业层 Sector Rotation    权重 10%（关闭"启用行业轮动评分"时该层不参与打分；
 *                                          开启时用该股票所属板块ETF在轮动排名里的真实百分位）
 *   ③ 三频共振层 Resonance      权重 35%（短中期择时：weekly+daily+short 三项通过比例）
 *   ④ 机构多因子层 Institutional 权重 30%（Minervini + Weinstein + CANSLIM + RS 的平均）
 *   ⑤ 质量层 Quality            权重 10%（基本面，未配置Key时该层不参与，权重按比例分给其他层）
 *
 * 任何一层数据不可用时，不会被当作0分拖累总分，而是把该层权重按比例重新分配给
 * 其余可用层——这是从三个历史版本里学到的经验：免费数据源必然有缺口，
 * "不可用"不等于"差"，不能让数据缺口变成误导性的低分。
 *
 * 2026-07 修复：之前不管"启用行业轮动评分"这个开关开没开，行业层实际上要么
 * 恒定按中性50分参与加权(关闭时)，要么恒定不可用(开启时，因为压根没把
 * 真实板块轮动数据接到具体某只股票上)——相当于这个开关和它触发的额外API请求
 * 从来没有真正生效过。现在改成：关闭时 sectorScore=null(该层不参与，权重
 * 按比例分给其他层，不再假装"中性")；开启时用 sectorMap.js 查出该股票的
 * 板块归属，再用 MarketContext.sectorScoreFor() 算出它在本次板块轮动排名
 * 里的真实百分位（查不到板块归属或轮动数据不可用时仍然是null，不兜底成50）。
 * ============================================================================
 */
'use strict';

export const LAYER_WEIGHTS = {
  market: 0.15,
  sector: 0.10,
  resonance: 0.35,
  institutional: 0.30,
  quality: 0.10,
};

function resonanceLayerScore(resonance) {
  if (!resonance || resonance.totalChecked === 0) return null;
  return Math.round((resonance.passCount / resonance.totalChecked) * 100);
}

function institutionalLayerScore(institutional) {
  const scores = [];
  if (institutional.minervini?.score != null) scores.push(institutional.minervini.score);
  if (institutional.weinstein?.stage != null) {
    // Stage 2=100分, Stage1/3=50分(过渡期), Stage4=0分
    const stageScore = { 1: 50, 2: 100, 3: 50, 4: 0 }[institutional.weinstein.stage];
    scores.push(stageScore);
  }
  if (institutional.canslim?.score != null) scores.push(institutional.canslim.score);
  if (institutional.rs?.percentile != null) scores.push(institutional.rs.percentile);
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

export const CompositeScore = {

  /**
   * @param {object} layers { marketScore, sectorScore(可为null表示未开启), resonance, institutional, quality }
   *   marketScore: number|null (来自 MarketContext.getMarketRegime().score)
   *   sectorScore: number|null (来自 MarketContext.sectorScoreFor()，未开启行业轮动时传 null)
   *   resonance: ResonanceEngine.analyze() 的返回值
   *   institutional: { minervini, weinstein, canslim, rs }
   *   quality: { available, score }
   */
  compute(layers) {
    const raw = {
      market: layers.marketScore,
      // 关闭时该层不参与打分；开启时用真实板块轮动百分位(仍可能为null，比如该股票查不到板块归属)
      sector: layers.sectorEnabled ? layers.sectorScore : null,
      resonance: resonanceLayerScore(layers.resonance),
      institutional: institutionalLayerScore(layers.institutional),
      quality: (layers.quality && layers.quality.available) ? layers.quality.score : null,
    };

    const available = Object.entries(raw).filter(([k, v]) => v != null);
    const availableWeightSum = available.reduce((s, [k]) => s + LAYER_WEIGHTS[k], 0);
    if (availableWeightSum === 0) return { score: null, breakdown: [], note: '所有评分层均不可用' };

    const breakdown = [];
    let total = 0;
    for (const [key, weight] of Object.entries(LAYER_WEIGHTS)) {
      const val = raw[key];
      if (val == null) {
        breakdown.push({ layer: key, available: false, score: null, weight: 0, contribution: 0 });
        continue;
      }
      const adjWeight = weight / availableWeightSum; // 按比例重新分配不可用层的权重
      const contribution = val * adjWeight;
      total += contribution;
      breakdown.push({ layer: key, available: true, score: val, weight: Math.round(adjWeight * 1000) / 10, contribution: Math.round(contribution * 10) / 10 });
    }
    return { score: Math.round(total), breakdown };
  },

  layerNameCN(key) {
    return { market: '① 市场层 Market Regime', sector: '② 行业层 Sector Rotation', resonance: '③ 三频共振层 Resonance', institutional: '④ 机构多因子层 Institutional', quality: '⑤ 质量层 Quality' }[key] || key;
  },
};
