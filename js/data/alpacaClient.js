/**
 * ============================================================================
 * 数据层：Alpaca 客户端 (Data Layer - Alpaca Client)
 * ----------------------------------------------------------------------------
 * 说明：
 *  - 本模块只负责"从 Alpaca 拿原始数据"，不做任何指标计算，不关心业务逻辑。
 *  - Alpaca Market Data API 免费版(IEX feed)支持 1Min/1Hour/1Day 等多种 timeframe，
 *    可以拿到真实的小时线历史数据，这是相对 Yahoo Finance 免费接口的最大优势
 *    （Yahoo 免费接口不提供长历史的小时线）。
 *  - 节假日/周末：Alpaca 只返回真实交易日/交易时段的 bar，天然不会出现缺失日期的
 *    "空洞"，因此这里不需要做补齐，只需要正确处理"该股票在某段时间内没有任何
 *    bar"（新股上市不久、代码错误、退市等）这种情况——统一抛出明确的错误信息。
 *  - API Key 只保存在浏览器 localStorage，不经过任何服务器中转。
 * ============================================================================
 */
'use strict';

const LS_KEY_ID = 'va_alpaca_key_id';
const LS_KEY_SECRET = 'va_alpaca_secret';
const LS_KEY_PAPER = 'va_alpaca_paper'; // 'true' | 'false'，纸上交易环境仅影响交易端点，行情数据两者通用

export const AlpacaClient = {

  getCredentials() {
    return {
      keyId: localStorage.getItem(LS_KEY_ID) || '',
      secret: localStorage.getItem(LS_KEY_SECRET) || '',
      paper: localStorage.getItem(LS_KEY_PAPER) !== 'false',
    };
  },
  saveCredentials(keyId, secret, paper = true) {
    localStorage.setItem(LS_KEY_ID, keyId || '');
    localStorage.setItem(LS_KEY_SECRET, secret || '');
    localStorage.setItem(LS_KEY_PAPER, String(paper));
  },
  hasCredentials() {
    const c = this.getCredentials();
    return !!(c.keyId && c.secret);
  },

  _headers() {
    const c = this.getCredentials();
    return {
      'APCA-API-KEY-ID': c.keyId,
      'APCA-API-SECRET-KEY': c.secret,
    };
  },

  // 行情数据固定用 data.alpaca.markets（免费 IEX feed），与交易环境(paper/live)无关
  _dataBase() { return 'https://data.alpaca.markets'; },

  // 交易类端点(账户信息/资产列表/日历)必须区分 Paper(模拟盘) / Live(实盘)，
  // 两者的Key不能混用——这是之前版本的bug：写死了Live地址，导致Paper Key测试连接必定401。
  // 免费获取行情数据只需要 Paper 账户的 Key 即可，无需入金，因此默认 paper=true。
  _tradingBase() {
    const c = this.getCredentials();
    return c.paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
  },

  /**
   * 带指数退避的 fetch 封装：429限流自动重试，403/404等直接抛错不重试。
   */
  async _fetchWithRetry(url, opts = {}, maxRetries = 3) {
    let attempt = 0;
    while (true) {
      const resp = await fetch(url, { ...opts, headers: { ...this._headers(), ...(opts.headers || {}) } });
      if (resp.status === 429 && attempt < maxRetries) {
        const wait = 800 * Math.pow(2, attempt); // 0.8s, 1.6s, 3.2s
        await new Promise(r => setTimeout(r, wait));
        attempt++;
        continue;
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Alpaca API ${resp.status}: ${text.slice(0, 200) || resp.statusText}`);
      }
      return resp.json();
    }
  },

  /**
   * 获取历史 K 线（自动翻页）。
   * @param {string} symbol
   * @param {'1Hour'|'1Day'|'1Week'} timeframe
   * @param {string} start ISO日期 'YYYY-MM-DD'
   * @param {string} end ISO日期 'YYYY-MM-DD'（含）
   */
  async getBars(symbol, timeframe, start, end) {
    if (!this.hasCredentials()) throw new Error('尚未配置 Alpaca API Key，请在"设置"页填写');
    let pageToken = null;
    const allBars = [];
    do {
      const params = new URLSearchParams({
        timeframe, start, end, limit: '10000', adjustment: 'split', feed: 'iex',
      });
      if (pageToken) params.set('page_token', pageToken);
      const url = `${this._dataBase()}/v2/stocks/${symbol}/bars?${params.toString()}`;
      const data = await this._fetchWithRetry(url);
      const bars = (data.bars || []).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }));
      allBars.push(...bars);
      pageToken = data.next_page_token || null;
    } while (pageToken);
    if (!allBars.length) {
      throw new Error(`${symbol}: 未获取到任何 ${timeframe} 数据（可能是新股/退市/代码错误/超出订阅范围）`);
    }
    return allBars;
  },

  /** 便捷方法：拿约2年日线（覆盖200MA、52周高低所需的最长窗口） */
  async getDailyBars(symbol, yearsBack = 2, asOfDate = null) {
    const end = asOfDate || new Date().toISOString().slice(0, 10);
    const startDate = new Date(end);
    startDate.setFullYear(startDate.getFullYear() - yearsBack);
    return this.getBars(symbol, '1Day', startDate.toISOString().slice(0, 10), end);
  },

  /** 便捷方法：拿约6个月小时线（免费IEX feed历史深度有限，6个月足够做4H/1H共振） */
  async getHourlyBars(symbol, monthsBack = 6, asOfDate = null) {
    const end = asOfDate || new Date().toISOString().slice(0, 10);
    const startDate = new Date(end);
    startDate.setMonth(startDate.getMonth() - monthsBack);
    return this.getBars(symbol, '1Hour', startDate.toISOString().slice(0, 10), end);
  },

  /**
   * 批量获取多只股票的K线（一次请求打包最多 CHUNK_SIZE 只股票的数据）。
   * ----------------------------------------------------------------------------
   * 背景（2026-07 真实测速后追加）：v1.3 的"worker池并发"优化上线后，用户实测
   * 517只股票仍然要 11分37秒，几乎没有改善。真正原因不是并发数不够，而是
   * 请求总数太多——原来的写法是"每只股票单独发1次日线请求+1次小时线请求"，
   * 517只股票 = 1000+次独立HTTP请求，很容易撞上 Alpaca 免费额度"每分钟请求数"
   * 的限流；一旦触发429，_fetchWithRetry 的指数退避(0.8s/1.6s/3.2s)会让等待
   * 时间迅速累积，5个并发worker也救不回来。
   * 真正的解法是"减少请求总数"而不是"加大并发"：Alpaca 的 /v2/stocks/bars
   * 端点支持一次传入多个逗号分隔的symbol，一次请求就能拿回一批股票的K线。
   * 517只股票打包成约100只/批，日线+小时线加起来只需要几十次请求，
   * 而不是1000+次——这是量级上的差异，不是简单调参能达到的效果。
   * @param {string[]} symbols
   * @param {'1Hour'|'1Day'|'1Week'} timeframe
   * @param {string} start
   * @param {string} end
   * @returns {Promise<Map<string, Array>>} symbol -> bar数组（按时间升序）
   */
  async getBarsMulti(symbols, timeframe, start, end) {
    if (!this.hasCredentials()) throw new Error('尚未配置 Alpaca API Key，请在"设置"页填写');
    if (!symbols.length) return new Map();

    const CHUNK_SIZE = 100; // 单次请求打包的股票数，兼顾URL长度限制和请求数量
    const chunks = [];
    for (let i = 0; i < symbols.length; i += CHUNK_SIZE) chunks.push(symbols.slice(i, i + CHUNK_SIZE));

    const resultMap = new Map();
    let ci = 0;
    // chunk之间也用小并发(最多3个)跑，chunk内部的分页请求(next_page_token)必须串行，
    // 因为下一页依赖上一页返回的token
    const chunkWorker = async () => {
      while (true) {
        const idx = ci++;
        if (idx >= chunks.length) return;
        const chunkSymbols = chunks[idx];
        let pageToken = null;
        do {
          const params = new URLSearchParams({
            symbols: chunkSymbols.join(','), timeframe, start, end, limit: '10000', adjustment: 'split', feed: 'iex',
          });
          if (pageToken) params.set('page_token', pageToken);
          const url = `${this._dataBase()}/v2/stocks/bars?${params.toString()}`;
          const data = await this._fetchWithRetry(url);
          const barsBySymbol = data.bars || {};
          for (const sym of Object.keys(barsBySymbol)) {
            const bars = (barsBySymbol[sym] || []).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }));
            if (!resultMap.has(sym)) resultMap.set(sym, []);
            resultMap.get(sym).push(...bars);
          }
          pageToken = data.next_page_token || null;
        } while (pageToken);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, chunkWorker));

    // 分页返回的顺序不一定100%按时间排列（多symbol混合分页），这里统一按时间升序排一次，
    // 保证后续 Timeframe 模块（依赖"数组已按时间升序"这个约定）能正常工作
    for (const [sym, bars] of resultMap) {
      bars.sort((a, b) => new Date(a.t) - new Date(b.t));
    }
    return resultMap;
  },

  /** 最新报价（用于Dashboard快速展示，不用于历史回溯计算） */
  async getLatestQuote(symbol) {
    const url = `${this._dataBase()}/v2/stocks/${symbol}/quotes/latest?feed=iex`;
    const data = await this._fetchWithRetry(url);
    return data.quote || null;
  },

  /** 获取全市场可交易美股资产列表（用于"全市场"扫描池子，量很大，谨慎使用） */
  async listAssets({ status = 'active', assetClass = 'us_equity' } = {}) {
    const url = `${this._tradingBase()}/v2/assets?status=${status}&asset_class=${assetClass}`;
    return this._fetchWithRetry(url);
  },

  /** 交易日历：用于判断某天是否为交易日、以及获取该日的开盘/收盘时间 */
  async getCalendar(start, end) {
    const url = `${this._tradingBase()}/v2/calendar?start=${start}&end=${end}`;
    return this._fetchWithRetry(url);
  },

  /** 连通性自检：用账户端点验证 Key 是否有效 */
  async testConnection() {
    const url = `${this._tradingBase()}/v2/account`;
    try {
      const data = await this._fetchWithRetry(url);
      return { ok: true, accountStatus: data.status, equity: data.equity };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
};
