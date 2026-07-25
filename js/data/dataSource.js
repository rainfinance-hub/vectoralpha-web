/**
 * ============================================================================
 * 数据源统一门面 (Data Source Facade)
 * ----------------------------------------------------------------------------
 * 上层模块（Universe/Signal/History Engine）只应该调用这个文件里的函数，
 * 不应该直接 import AlpacaClient 或 YahooFallback —— 这样未来想换/加数据源
 * （比如接入 Polygon、IEX Cloud），只需要改这一个文件。
 *
 * 策略：优先 Alpaca（用户在"设置"页配置了 Key 时），失败或未配置 Key 时
 * 自动降级到 Yahoo Finance 免费接口，并在返回结果里标注实际使用的数据源，
 * 前端据此提示用户"本次结果小时线来自XX/已降级为短周期日线"等。
 * ============================================================================
 */
'use strict';
import { AlpacaClient } from './alpacaClient.js';
import { YahooFallback } from './yahooFallback.js';
import { Timeframe } from '../core/timeframe.js';

// 简单内存缓存：同一个 symbol+timeframe+asOfDate 在一次扫描会话内不重复请求
const _cache = new Map();
function cacheKey(...parts) { return parts.join('|'); }

export const DataSource = {

  async getDaily(symbol, { yearsBack = 2, asOfDate = null } = {}) {
    const key = cacheKey('D', symbol, yearsBack, asOfDate);
    if (_cache.has(key)) return _cache.get(key);

    let bars, source;
    if (AlpacaClient.hasCredentials()) {
      try {
        bars = await AlpacaClient.getDailyBars(symbol, yearsBack, asOfDate);
        source = 'alpaca';
      } catch (e) {
        console.warn(`[DataSource] Alpaca 日线失败(${symbol})，降级 Yahoo: ${e.message}`);
      }
    }
    if (!bars) {
      bars = await YahooFallback.getDailyBars(symbol, yearsBack);
      source = 'yahoo';
    }
    // 历史回溯：截断到 asOfDate（Yahoo 分支没有服务端截断参数，这里统一在客户端截断一次）
    const trunc = Timeframe.truncateByDate(bars, asOfDate);
    const result = { bars: trunc.bars, effectiveDate: trunc.effectiveDate, requestedDate: asOfDate, isNonTradingDay: trunc.isNonTradingDay, source };
    _cache.set(key, result);
    return result;
  },

  async getHourly(symbol, { monthsBack = 6, asOfDate = null } = {}) {
    const key = cacheKey('H', symbol, monthsBack, asOfDate);
    if (_cache.has(key)) return _cache.get(key);

    let bars = [], source = 'unavailable';
    if (AlpacaClient.hasCredentials()) {
      try {
        bars = await AlpacaClient.getHourlyBars(symbol, monthsBack, asOfDate);
        source = 'alpaca';
      } catch (e) {
        console.warn(`[DataSource] Alpaca 小时线失败(${symbol}): ${e.message}`);
      }
    }
    if (!bars.length) {
      try {
        bars = await YahooFallback.getHourlyBars(symbol);
        source = bars.length ? 'yahoo' : 'unavailable';
      } catch (e) {
        source = 'unavailable';
      }
    }
    if (asOfDate) bars = Timeframe.truncateHourlyByDate(bars, asOfDate);
    const result = { bars, source, degraded: source === 'unavailable' };
    _cache.set(key, result);
    return result;
  },

  clearCache() { _cache.clear(); },
};
