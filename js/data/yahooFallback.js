/**
 * ============================================================================
 * 数据层：Yahoo Finance 兜底客户端 (Fallback Data Source)
 * ----------------------------------------------------------------------------
 * 用途：当用户没有配置 Alpaca Key，或 Alpaca 某个标的取数失败时的兜底方案。
 * 局限：Yahoo 免费接口不提供长历史小时线（通常只有最近约60天的60m数据），
 *      因此"小时线共振"在纯 Yahoo 模式下会自动降级为"短周期日线替代"，
 *      并在结果中明确标注，不会假装自己有小时线数据。
 * 与 AlpacaClient 保持完全一致的返回格式：{t,o,h,l,c,v}[]，
 * 这样上层（Universe/Signal/History 引擎）不需要关心数据到底来自哪个源。
 * ============================================================================
 */
'use strict';

export const YahooFallback = {
  _rangeParam(yearsBack) {
    if (yearsBack <= 0.3) return '3mo';
    if (yearsBack <= 1) return '1y';
    if (yearsBack <= 2) return '2y';
    return '5y';
  },

  async getDailyBars(symbol, yearsBack = 2) {
    const range = this._rangeParam(yearsBack);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&events=div,split`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Yahoo Finance ${resp.status}: ${symbol} 获取失败`);
    const json = await resp.json();
    const result = json.chart && json.chart.result && json.chart.result[0];
    if (!result) throw new Error(`Yahoo Finance: ${symbol} 无数据（代码错误或已退市）`);
    const ts = result.timestamp || [];
    const q = result.indicators.quote[0];
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close[i] == null) continue; // 停牌/缺失日直接跳过，不编造
      bars.push({
        t: new Date(ts[i] * 1000).toISOString(),
        o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0,
      });
    }
    if (!bars.length) throw new Error(`Yahoo Finance: ${symbol} 无有效K线数据`);
    return bars;
  },

  /** Yahoo 免费接口 60m 数据通常只覆盖近60天，超出部分拿不到就返回能拿到的部分 */
  async getHourlyBars(symbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=60d&interval=60m`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Yahoo Finance ${resp.status}: ${symbol} 小时线获取失败`);
    const json = await resp.json();
    const result = json.chart && json.chart.result && json.chart.result[0];
    if (!result) return []; // 拿不到小时线时返回空数组，由上层降级处理，不抛出致命错误
    const ts = result.timestamp || [];
    const q = result.indicators.quote[0];
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close[i] == null) continue;
      bars.push({ t: new Date(ts[i] * 1000).toISOString(), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
    }
    return bars;
  },
};
