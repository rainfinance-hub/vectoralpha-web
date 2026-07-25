/**
 * ============================================================================
 * 持仓与风控工作台 (Risk & Portfolio Workbench)
 * ----------------------------------------------------------------------------
 * 两大功能：
 *  1. 仓位建议：给定账户资金、单笔风险%、单仓/单行业资金上限，按"综合评分从高
 *     到低"依次分配资金，算出建议股数/止损价/止盈价/风险金额，资金不够时
 *     明确标注"组合资金不足"，不会无视账户上限硬算。
 *  2. 持仓复核：对已有持仓，结合最新扫描出的评分与用户自定义止损/成本价，
 *     给出"继续持有/加仓/减仓/卖出"建议，并说明触发的具体规则。
 *
 * 止损模式（均为"当前时点参考价"，不是会随股价上涨自动上移的动态追踪止损，
 * 每次重新计算都会用最新数据重新算一次）：
 *   structural  = 近3日低点
 *   atr         = 现价 - N×ATR14
 *   chandelier  = 近22日高点 - 3×ATR14
 *   combo       = 取以上更保守（更高）的一个
 * ============================================================================
 */
'use strict';

export const RiskWorkbench = {

  computeStopPrice(raw, price, mode = 'combo', atrMultiple = 2.5) {
    const { atrNow, recentLow3, recentHigh22 } = raw;
    const candidates = {};
    if (recentLow3 != null) candidates.structural = recentLow3;
    if (atrNow != null) candidates.atr = price - atrMultiple * atrNow;
    if (recentHigh22 != null && atrNow != null) candidates.chandelier = recentHigh22 - 3 * atrNow;
    if (mode !== 'combo') return candidates[mode] ?? null;
    const vals = Object.values(candidates).filter(v => v != null);
    return vals.length ? Math.max(...vals) : null; // combo取更高(更保守)的止损价
  },

  /**
   * 按综合评分从高到低分配资金，返回每只股票的建议仓位。
   * @param {Array} rankedResults SymbolAnalysis[]，需已按 composite.score 降序排列
   * @param {object} cfg { equity, riskPct, maxPosPct, maxSectorPct, stopMode, atrMultiple, targetRMultiple }
   */
  buildWorkbench(rankedResults, cfg) {
    const { equity, riskPct, maxPosPct, stopMode, atrMultiple = 2.5, targetRMultiple = 2 } = cfg;
    let allocatedCapital = 0;
    const rows = [];
    for (const r of rankedResults) {
      if (r.isError || r.price == null) continue;
      const stopPrice = this.computeStopPrice(r.raw, r.price, stopMode, atrMultiple);
      if (stopPrice == null || stopPrice >= r.price) {
        rows.push({ sym: r.sym, price: r.price, ok: false, reason: '无法计算有效止损价(数据不足或止损价高于现价)' });
        continue;
      }
      const riskPerShare = r.price - stopPrice;
      const riskBudget = equity * (riskPct / 100);
      let shares = Math.floor(riskBudget / riskPerShare);
      let capitalNeeded = shares * r.price;
      const maxCapitalForThisPos = equity * (maxPosPct / 100);
      let capped = false;
      if (capitalNeeded > maxCapitalForThisPos) {
        shares = Math.floor(maxCapitalForThisPos / r.price);
        capitalNeeded = shares * r.price;
        capped = true;
      }
      if (allocatedCapital + capitalNeeded > equity) {
        const remaining = equity - allocatedCapital;
        if (remaining <= 0 || remaining < r.price) {
          rows.push({ sym: r.sym, price: r.price, ok: false, reason: '组合资金已分配完，无法再买入' });
          continue;
        }
        shares = Math.floor(remaining / r.price);
        capitalNeeded = shares * r.price;
        capped = true;
      }
      if (shares <= 0) {
        rows.push({ sym: r.sym, price: r.price, ok: false, reason: '按当前风险预算计算出的股数为0' });
        continue;
      }
      allocatedCapital += capitalNeeded;
      const riskAmount = shares * riskPerShare;
      const targetPrice = r.price + riskPerShare * targetRMultiple;
      rows.push({
        sym: r.sym, price: r.price, ok: true, capped,
        stopPrice: Math.round(stopPrice * 100) / 100, stopPct: Math.round((riskPerShare / r.price) * 1000) / 10,
        targetPrice: Math.round(targetPrice * 100) / 100, shares, capitalNeeded: Math.round(capitalNeeded),
        riskAmount: Math.round(riskAmount), riskPctOfAccount: Math.round((riskAmount / equity) * 1000) / 10,
        compositeScore: r.composite ? r.composite.score : null,
      });
    }
    return { rows, allocatedCapital: Math.round(allocatedCapital), remainingCapital: Math.round(equity - allocatedCapital), equity };
  },

  /**
   * 持仓复核：position = {sym, shares, cost, customStop, customTarget}，
   * latest = 该股票最新一次扫描/回溯得到的 SymbolAnalysis。
   */
  reviewHolding(position, latest) {
    if (!latest || latest.isError || latest.price == null) {
      return { sym: position.sym, action: '数据不可用', reasons: ['最新分析失败或数据不足'] };
    }
    const price = latest.price;
    const structuralStop = this.computeStopPrice(latest.raw, price, 'combo');
    const stopPrice = position.customStop || structuralStop;
    const compositeScore = latest.composite ? latest.composite.score : null;
    const passCount = latest.resonance ? latest.resonance.passCount : null;
    const plPct = ((price - position.cost) / position.cost) * 100;

    const stopTriggered = stopPrice != null && price <= stopPrice;
    const sellWarning = stopTriggered || (compositeScore != null && compositeScore < 40);
    const weakening = !sellWarning && passCount != null && passCount <= 1;
    const canAdd = !sellWarning && latest.resonance && latest.resonance.allPass && compositeScore != null && compositeScore >= 70 && plPct > 0;

    let action = '继续持有';
    const reasons = [];
    if (stopTriggered) { action = '止损触发/建议卖出'; reasons.push(`现价 ${price} ≤ 止损参考价 ${stopPrice}`); }
    else if (sellWarning) { action = '卖出预警'; reasons.push(`综合评分 ${compositeScore} < 40`); }
    else if (canAdd) { action = '可考虑加仓'; reasons.push('三频全部通过 + 综合评分≥70 + 浮盈 + 未触发止损'); }
    else if (weakening) { action = '信号减弱，密切关注'; reasons.push(`三频通过数 ${passCount}/3，接近失效`); }
    else { reasons.push('各项指标暂无明确恶化/加仓信号'); }

    return {
      sym: position.sym, price, cost: position.cost, plPct: Math.round(plPct * 100) / 100,
      compositeScore, passCount, stopPrice, action, reasons,
      direction: plPct >= 0 ? '浮盈中' : '浮亏中',
    };
  },
};
