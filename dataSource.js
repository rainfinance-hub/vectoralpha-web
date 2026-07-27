/**
 * ============================================================================
 * 信号引擎 A：三频共振框架 (Resonance Signal Engine)
 * ----------------------------------------------------------------------------
 * 对应你最初的需求示例："日线级别 MACD 在零轴上方金叉，且周线级别收盘价站上
 * 20 MA，小时线 RSI 突破 50" —— 本模块把这类"多周期条件同时满足"的判断
 * 标准化成一套可配置框架，而不是写死某一条规则。
 *
 * 三个核心周期 + 一个确认层：
 *   周线 weekly  —— 大方向/中期趋势
 *   日线 daily   —— 中期动量（MACD/RSI/均线）
 *   短周期 short —— 短线动量（默认用短期日线RSI，若有小时线数据则优先小时线）
 *   小时线确认层 hourly（可选）—— 4H EMA20 + MACD柱 + RSI，作为"日内趋势确认"标签，
 *     不计入 passCount（避免免费数据源小时线深度不足时，直接让整套体系失效）
 *
 * 输入：technicalContext（由 analysisPipeline 构建，包含 weekly/daily/short/hourly
 *      各周期的 close/high/low/volume 数组），以及一份可配置的 cfg。
 * 输出：{ weekly, daily, short, hourly, passCount, allPass }，每个周期的结果里
 *      都带有 label/detail 字符串，方便 UI 直接展示"为什么通过/不通过"。
 * ============================================================================
 */
'use strict';
import { Indicators as I } from '../core/indicators.js';

export const DEFAULT_RESONANCE_CONFIG = {
  weekly: { maType: 'sma', maPeriod: 20, maCond: 'above', rsiEnabled: true, rsiPeriod: 14, rsiCond: 'above50', macdCond: 'any' },
  daily: { macdCond: 'golden_or_hist_pos', fast: 12, slow: 26, signal: 9, maType: 'ema', maPeriod: 50, maCond: 'above', rsiPeriod: 14, rsiCond: 'above50' },
  short: { rsiPeriod: 6, rsiCond: '40_65', maType: 'ema', maPeriod: 5, maCond: 'above' },
};

function rsiCheck(v, cond) {
  if (v == null) return true; // 数据不足时不因为这一项直接判失败，交给 UI 显示"N/A"
  switch (cond) {
    case 'above50': return v > 50;
    case 'below50': return v < 50;
    case '40_65': return v >= 40 && v <= 65;
    case '30_55': return v >= 30 && v <= 55;
    case 'above30': return v > 30;
    case 'below70': return v < 70;
    default: return true;
  }
}

function checkWeekly(closeArr, cfg) {
  const ma = I.ma(closeArr, cfg.maPeriod, cfg.maType);
  const rsi = cfg.rsiEnabled ? I.rsi(closeArr, cfg.rsiPeriod) : null;
  const { hist, macdLine } = I.macd(closeArr, 12, 26, 9);
  const n = closeArr.length - 1;
  const lastClose = closeArr[n], lma = ma[n], lr = rsi ? rsi[n] : null, lh = hist[n], lml = macdLine[n];
  const maPass = lma != null && (cfg.maCond === 'above' ? lastClose > lma : lastClose < lma);
  const rsiPass = cfg.rsiEnabled ? rsiCheck(lr, cfg.rsiCond) : true;
  let macdPass = true;
  if (cfg.macdCond === 'hist_pos') macdPass = lh != null && lh > 0;
  else if (cfg.macdCond === 'hist_neg') macdPass = lh != null && lh < 0;
  else if (cfg.macdCond === 'above_zero') macdPass = lml != null && lml > 0;
  return {
    pass: maPass && rsiPass && macdPass, maPass, rsiPass, macdPass,
    lastClose, ma: lma, rsi: lr, macdHist: lh,
    label: `周线：收盘${cfg.maCond === 'above' ? '站上' : '跌破'} ${cfg.maType.toUpperCase()}${cfg.maPeriod}${cfg.rsiEnabled ? ` + RSI(${cfg.rsiPeriod}) ${cfg.rsiCond}` : ''}`,
  };
}

function checkDaily(closeArr, cfg) {
  const { hist, macdLine, signalLine } = I.macd(closeArr, cfg.fast, cfg.slow, cfg.signal);
  const ma = I.ma(closeArr, cfg.maPeriod, cfg.maType);
  const rsi = I.rsi(closeArr, cfg.rsiPeriod);
  const n = closeArr.length - 1;
  const lastClose = closeArr[n], lma = ma[n], lr = rsi[n], lh = hist[n], lml = macdLine[n];
  const pml = macdLine[n - 1], psl = signalLine[n - 1], psig = signalLine[n];
  const golden = lml != null && psig != null && pml != null && psl != null && lml > psig && pml <= psl;
  let macdPass;
  if (cfg.macdCond === 'golden') macdPass = golden;
  else if (cfg.macdCond === 'hist_pos') macdPass = lh != null && lh > 0;
  else if (cfg.macdCond === 'golden_or_hist_pos') macdPass = golden || (lh != null && lh > 0 && lml != null && lml > 0); // 零轴上方金叉/维持多头，对应用户示例场景
  else macdPass = true;
  const maPass = lma != null && (cfg.maCond === 'above' ? lastClose > lma : lastClose < lma);
  const rsiPass = rsiCheck(lr, cfg.rsiCond);
  return {
    pass: macdPass && maPass && rsiPass, macdPass, maPass, rsiPass, golden,
    lastClose, ma: lma, rsi: lr, macdHist: lh, macdLine: lml,
    label: `日线：MACD ${cfg.macdCond} + 收盘${cfg.maCond === 'above' ? '站上' : '跌破'} ${cfg.maType.toUpperCase()}${cfg.maPeriod} + RSI ${cfg.rsiCond}`,
  };
}

function checkShort(closeArr, cfg, isHourlyProxy) {
  const ma = I.ma(closeArr, cfg.maPeriod, cfg.maType);
  const rsi = I.rsi(closeArr, cfg.rsiPeriod);
  const n = closeArr.length - 1;
  const lastClose = closeArr[n], lma = ma[n], lr = rsi[n];
  const maPass = lma != null && (cfg.maCond === 'above' ? lastClose > lma : lastClose < lma);
  const rsiPass = rsiCheck(lr, cfg.rsiCond);
  return {
    pass: maPass && rsiPass, maPass, rsiPass, lastClose, ma: lma, rsi: lr,
    label: `${isHourlyProxy ? '小时线' : '短周期日线(替代小时线)'}：RSI(${cfg.rsiPeriod}) ${cfg.rsiCond} + 站上 ${cfg.maType.toUpperCase()}${cfg.maPeriod}`,
  };
}

/** 4H 简化趋势确认层：仅作展示标签，不计入 passCount */
function checkHourlyConfirm(h4CloseArr) {
  if (!h4CloseArr || h4CloseArr.length < 30) return null;
  const ema20 = I.ema(h4CloseArr, 20);
  const { hist } = I.macd(h4CloseArr, 12, 26, 9);
  const rsi = I.rsi(h4CloseArr, 14);
  const n = h4CloseArr.length - 1;
  const lastClose = h4CloseArr[n], lema = ema20[n], lh = hist[n], lr = rsi[n];
  const maPass = lema != null && lastClose > lema;
  const macdPass = lh != null && lh > 0;
  return { pass: maPass && macdPass, maPass, macdPass, rsi: lr, lastClose, ema20: lema, label: '4H确认层：EMA20上方 + MACD柱>0' };
}

export const ResonanceEngine = {
  /**
   * @param {object} ctx technicalContext: { weeklyClose, dailyClose, shortClose, hourly4Close(optional) }
   * @param {object} cfg 可选覆盖 DEFAULT_RESONANCE_CONFIG
   */
  analyze(ctx, cfg = {}) {
    const c = {
      weekly: { ...DEFAULT_RESONANCE_CONFIG.weekly, ...(cfg.weekly || {}) },
      daily: { ...DEFAULT_RESONANCE_CONFIG.daily, ...(cfg.daily || {}) },
      short: { ...DEFAULT_RESONANCE_CONFIG.short, ...(cfg.short || {}) },
    };
    const weekly = ctx.weeklyClose && ctx.weeklyClose.length >= 25 ? checkWeekly(ctx.weeklyClose, c.weekly) : null;
    const daily = ctx.dailyClose && ctx.dailyClose.length >= 60 ? checkDaily(ctx.dailyClose, c.daily) : null;
    const short = ctx.shortClose && ctx.shortClose.length >= 20 ? checkShort(ctx.shortClose, c.short, ctx.shortIsRealHourly) : null;
    const hourly = ctx.hourly4Close ? checkHourlyConfirm(ctx.hourly4Close) : null;

    const parts = [weekly, daily, short].filter(Boolean);
    const passCount = parts.filter(p => p.pass).length;
    const allPass = parts.length === 3 && passCount === 3;

    return { weekly, daily, short, hourly, passCount, totalChecked: parts.length, allPass };
  },
};
