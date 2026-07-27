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
 * 2026-07 修复：之前 maxSectorPct(单行业资金上限) 只在README里提过、cfg参数
 * 名字也留了位置，但 buildWorkbench 实际从来没用过它——这是评审指出的真实
 * 实现缺口：系统可能同时给 NVDA/AMD/AVGO/ARM/MU/SMCI 各分配15%仓位，单只看
 * 都合理，组合实际却高度集中在半导体。现在真正接入：每只候选股票用
 * analysisPipeline.js 算出的 sectorEtf(见 sectorMap.js) 归类，按板块累计已分配
 * 资金，超过 equity*maxSectorPct% 时对该行业后续候选自动缩减股数/跳过，
 * 和"单仓上限""组合总资金上限"三层依次生效，谁先卡住就按谁的上限来。
 * 查不到板块归属的股票(sectorEtf=null)不受这层约束，会在结果里标注清楚，
 * 不是"漏掉了"，是"数据源覆盖不到，无法归类"。
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
    const { equity, riskPct, maxPosPct, maxSectorPct = null, stopMode, atrMultiple = 2.5, targetRMultiple = 2 } = cfg;
    let allocatedCapital = 0;
    const sectorAllocated = {}; // sectorEtf -> 已分配资金，用于行业上限判断
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
      let capped = false;
      const capReasons = [];

      // ① 单仓上限
      const maxCapitalForThisPos = equity * (maxPosPct / 100);
      if (shares * r.price > maxCapitalForThisPos) {
        shares = Math.floor(maxCapitalForThisPos / r.price);
        capped = true; capReasons.push('单仓上限');
      }

      // ② 单行业上限（2026-07 新增，真正生效）：sectorEtf 未知的股票不受约束，明确标注原因
      const sectorEtf = r.sectorEtf || null;
      let sectorNote = null;
      if (maxSectorPct != null && maxSectorPct > 0) {
        if (sectorEtf) {
          const sectorCap = equity * (maxSectorPct / 100);
          const sectorUsed = sectorAllocated[sectorEtf] || 0;
          const sectorRemaining = sectorCap - sectorUsed;
          if (sectorRemaining < r.price) {
            rows.push({ sym: r.sym, price: r.price, ok: false, sectorEtf, reason: `已达该行业(${sectorEtf})资金上限，跳过` });
            continue;
          }
          const maxSharesForSector = Math.floor(sectorRemaining / r.price);
          if (shares > maxSharesForSector) {
            shares = maxSharesForSector;
            capped = true; capReasons.push(`行业上限(${sectorEtf})`);
          }
        } else {
          sectorNote = '⚠️未查到板块归属，不受行业仓位上限约束';
        }
      }

      // ③ 组合总资金上限
      let capitalNeeded = shares * r.price;
      if (allocatedCapital + capitalNeeded > equity) {
        const remaining = equity - allocatedCapital;
        if (remaining <= 0 || remaining < r.price) {
          rows.push({ sym: r.sym, price: r.price, ok: false, reason: '组合资金已分配完，无法再买入' });
          continue;
        }
        shares = Math.floor(remaining / r.price);
        capitalNeeded = shares * r.price;
        capped = true; capReasons.push('组合总资金');
      }

      if (shares <= 0) {
        rows.push({ sym: r.sym, price: r.price, ok: false, reason: '按当前风险预算/上限计算出的股数为0' });
        continue;
      }
      allocatedCapital += capitalNeeded;
      if (sectorEtf) sectorAllocated[sectorEtf] = (sectorAllocated[sectorEtf] || 0) + capitalNeeded;
      const riskAmount = shares * riskPerShare;
      const targetPrice = r.price + riskPerShare * targetRMultiple;
      rows.push({
        sym: r.sym, price: r.price, ok: true, capped, capReasons: capReasons.length ? capReasons : undefined, sectorEtf, sectorNote,
        stopPrice: Math.round(stopPrice * 100) / 100, stopPct: Math.round((riskPerShare / r.price) * 1000) / 10,
        targetPrice: Math.round(targetPrice * 100) / 100, shares, capitalNeeded: Math.round(capitalNeeded),
        riskAmount: Math.round(riskAmount), riskPctOfAccount: Math.round((riskAmount / equity) * 1000) / 10,
        compositeScore: r.composite ? r.composite.score : null,
      });
    }
    const sectorSummary = Object.entries(sectorAllocated).map(([etf, cap]) => ({
      sectorEtf: etf, allocated: Math.round(cap), pctOfEquity: Math.round((cap / equity) * 1000) / 10,
    })).sort((a, b) => b.allocated - a.allocated);
    return { rows, allocatedCapital: Math.round(allocatedCapital), remainingCapital: Math.round(equity - allocatedCapital), equity, sectorSummary };
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
