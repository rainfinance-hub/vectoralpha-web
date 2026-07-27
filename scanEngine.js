/**
 * ============================================================================
 * 基本面数据模块 (Fundamentals) —— 可选，用于 Quality Universe 和 CANSLIM 基本面子项
 * ----------------------------------------------------------------------------
 * Alpaca 不提供公司基本面数据，本模块用 Finnhub 免费额度作为可选补充数据源。
 * 原则：没有配置 Key，或该字段免费额度不提供时，一律返回 available:false / null，
 * 绝不编造数字——前端据此显示"数据不可用"而不是假装算出了一个分数。
 * 历史回溯时：基本面数据源的免费额度大多只提供"最新快照"，不是历史某天的
 * 时点数据，因此历史回溯结果里所有基本面相关字段都会被标注"⚠️非时点数据"。
 * ============================================================================
 */
'use strict';

const LS_FINNHUB_KEY = 'va_finnhub_key';

export const Fundamentals = {
  getKey() { return localStorage.getItem(LS_FINNHUB_KEY) || ''; },
  saveKey(key) { localStorage.setItem(LS_FINNHUB_KEY, key || ''); },
  hasKey() { return !!this.getKey(); },

  async _get(path) {
    const key = this.getKey();
    if (!key) return null;
    const sep = path.includes('?') ? '&' : '?';
    const resp = await fetch(`https://finnhub.io/api/v1${path}${sep}token=${key}`);
    if (!resp.ok) throw new Error(`Finnhub ${resp.status}`);
    return resp.json();
  },

  /**
   * 获取一揽子基本面字段，供 Quality / CANSLIM 使用。
   * 返回 { available, profile, growth, ratios, ownership, warnings }
   */
  async getBundle(symbol) {
    if (!this.hasKey()) {
      return { available: false, warnings: ['未配置 Finnhub API Key，基本面/质量评分不可用'], profile: {}, growth: {}, ratios: {}, ownership: {} };
    }
    const warnings = [];
    let profile = {}, metrics = {}, ownership = {};
    try {
      profile = await this._get(`/stock/profile2?symbol=${symbol}`) || {};
    } catch (e) { warnings.push('公司概况获取失败: ' + e.message); }
    try {
      const m = await this._get(`/stock/metric?symbol=${symbol}&metric=all`);
      metrics = (m && m.metric) || {};
    } catch (e) { warnings.push('财务指标获取失败: ' + e.message); }
    try {
      const own = await this._get(`/stock/ownership?symbol=${symbol}&limit=10`);
      ownership = own || {};
    } catch (e) { warnings.push('机构持仓获取失败: ' + e.message); }

    return {
      available: Object.keys(metrics).length > 0,
      profile: { sector: profile.finnhubIndustry || null, marketCap: profile.marketCapitalization || null, name: profile.name || null },
      growth: {
        epsGrowthTTM: metrics.epsGrowthTTMYoy ?? null,
        revenueGrowthTTM: metrics.revenueGrowthTTMYoy ?? null,
        epsGrowth5Y: metrics.epsGrowth5Y ?? null,
      },
      ratios: {
        roe: metrics.roeTTM ?? null,
        roic: metrics.roicTTM ?? null,
        netMargin: metrics.netProfitMarginTTM ?? null,
        grossMargin: metrics.grossMarginTTM ?? null,
        debtToEquity: metrics['totalDebt/totalEquityQuarterly'] ?? null,
        fcfMargin: metrics.fcfMarginTTM ?? null,
        peTTM: metrics.peTTM ?? null,
      },
      ownership: { institutionCount: (ownership.ownership || []).length || null },
      warnings,
    };
  },

  /** 简单财报日历（可选，用于 Earnings Watch 池）；free tier 通常只支持有限查询范围 */
  async getEarningsCalendar(fromDate, toDate) {
    if (!this.hasKey()) return { available: false, items: [] };
    try {
      const data = await this._get(`/calendar/earnings?from=${fromDate}&to=${toDate}`);
      return { available: true, items: (data && data.earningsCalendar) || [] };
    } catch (e) {
      return { available: false, items: [], error: e.message };
    }
  },
};
