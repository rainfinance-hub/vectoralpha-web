/**
 * ============================================================================
 * 时间周期转换模块 (Timeframe Module)
 * ----------------------------------------------------------------------------
 * 职责单一：只做"K线聚合"和"按日期截断"，不涉及任何指标计算或信号判断。
 *
 * Bar 数据结构统一约定（整个项目都用这个格式）：
 *   { t: 'YYYY-MM-DDTHH:mm:ssZ' (ISO字符串), o, h, l, c, v }
 *
 * 美股节假日/周末缺失数据的处理原则：
 *   - 行情数据源（Alpaca）本身只返回真实交易日的bar，节假日/周末自然不会出现，
 *     所以聚合函数不需要"补齐"缺失日期，只需要正确地按"自然周/自然月"分组。
 *   - 历史回溯传入的 asOfDate 如果恰好是非交易日（周末/节假日），
 *     truncateByDate 会自动回退到该日期之前最近的一个交易日，并在返回结果里
 *     标注 effectiveDate 与 requestedDate 是否一致，方便前端提示用户。
 * ============================================================================
 */
'use strict';

export const Timeframe = {

  /**
   * 按请求日期截断日线数组，返回截断后的数组 + 实际生效日期。
   * 用于历史回溯：所有"历史当天"的计算都基于「不包含未来数据」的截断结果。
   * @param {Array} dailyBars 已按时间升序排列的日线数组
   * @param {string|null} asOfDate 'YYYY-MM-DD'，null 表示不截断（取全部/最新）
   */
  truncateByDate(dailyBars, asOfDate) {
    if (!asOfDate) return { bars: dailyBars, effectiveDate: dailyBars.length ? dailyBars[dailyBars.length - 1].t.slice(0, 10) : null, requestedDate: null, isNonTradingDay: false };
    const targetTs = new Date(asOfDate + 'T23:59:59Z').getTime();
    let cutIdx = -1;
    for (let i = 0; i < dailyBars.length; i++) {
      if (new Date(dailyBars[i].t).getTime() <= targetTs) cutIdx = i; else break;
    }
    if (cutIdx < 0) {
      return { bars: [], effectiveDate: null, requestedDate: asOfDate, isNonTradingDay: true, error: '所选日期早于可获取的数据范围' };
    }
    const bars = dailyBars.slice(0, cutIdx + 1);
    const effectiveDate = bars[bars.length - 1].t.slice(0, 10);
    return { bars, effectiveDate, requestedDate: asOfDate, isNonTradingDay: effectiveDate !== asOfDate };
  },

  /** 日线 → 周线聚合（自然周，周一为一周开始，遵循ISO周） */
  aggregateWeekly(dailyBars) {
    const groups = new Map();
    for (const b of dailyBars) {
      const d = new Date(b.t);
      const weekKey = this._isoWeekKey(d);
      if (!groups.has(weekKey)) groups.set(weekKey, []);
      groups.get(weekKey).push(b);
    }
    const out = [];
    for (const [, bars] of groups) {
      out.push(this._mergeBars(bars));
    }
    out.sort((a, b) => new Date(a.t) - new Date(b.t));
    return out;
  },

  /** 日线 → 月线聚合 */
  aggregateMonthly(dailyBars) {
    const groups = new Map();
    for (const b of dailyBars) {
      const key = b.t.slice(0, 7); // YYYY-MM
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    const out = [];
    for (const [, bars] of groups) out.push(this._mergeBars(bars));
    out.sort((a, b) => new Date(a.t) - new Date(b.t));
    return out;
  },

  /**
   * 小时线 → N小时线聚合（默认4小时）。
   * 美股常规交易时段每天约6.5小时，按"每N根合并"而非"按整点对齐"，
   * 这是业界处理美股分钟/小时数据的常见简化方式：每天bar数不严格均匀，
   * 但足够用来做日内趋势确认，且实现简单、不依赖交易所精确时段表。
   */
  aggregateHours(hourlyBars, n = 4) {
    const out = [];
    for (let i = 0; i < hourlyBars.length; i += n) {
      const chunk = hourlyBars.slice(i, i + n);
      if (chunk.length) out.push(this._mergeBars(chunk));
    }
    return out;
  },

  /** 按 asOfDate 截断小时线（历史回溯时小时线也要同步截断，避免用到"未来"的小时线） */
  truncateHourlyByDate(hourlyBars, asOfDate) {
    if (!asOfDate) return hourlyBars;
    const targetTs = new Date(asOfDate + 'T23:59:59-04:00').getTime(); // 美东时区收盘视角
    return hourlyBars.filter(b => new Date(b.t).getTime() <= targetTs);
  },

  // ---- 内部工具 ----
  _mergeBars(bars) {
    bars.sort((a, b) => new Date(a.t) - new Date(b.t));
    return {
      t: bars[bars.length - 1].t,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
      v: bars.reduce((s, b) => s + (b.v || 0), 0),
    };
  },
  _isoWeekKey(d) {
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = (date.getUTCDay() + 6) % 7; // 周一=0
    date.setUTCDate(date.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return `${date.getUTCFullYear()}-W${week}`;
  },

  /** 拆分 OHLCV 数组为多个平行序列，供指标模块使用 */
  toSeries(bars) {
    return {
      t: bars.map(b => b.t),
      o: bars.map(b => b.o),
      h: bars.map(b => b.h),
      l: bars.map(b => b.l),
      c: bars.map(b => b.c),
      v: bars.map(b => b.v),
    };
  },
};
