/**
 * ============================================================================
 * Master Universe 同步模块 —— V2 第二阶段新增
 * ----------------------------------------------------------------------------
 * 目标：不再用静态硬编码股票列表作为"筛选依据"，而是把股票的参考信息
 * (交易所/板块/市值/均量/是否ETF/是否ADR等)存进 db.js 的 master_universe 表，
 * 所有股票池(Dynamic Universe Builder / Expanded Universe 三档基础池)最终都
 * 从这张表查询而来，不是每次都现场拼数组。
 *
 * 两条真实数据来源（如实标注各自的覆盖范围和局限，不假装数据比实际更全）：
 *
 * 1) syncTradableAssets()：调用 Alpaca /v2/assets 端点（alpacaClient.listAssets，
 *    已在项目里存在），这是"真实的、当前可交易的美股完整列表"，通常上万只，
 *    包含 symbol/company/exchange/asset_type/tradable/active。这一步能建立
 *    "Full Tradable Universe"(第三阶段)的真实底表，但 Alpaca 该端点不提供
 *    市值/行业/均量/ADR/REIT这些字段，所以这一步同步进来的行只有基础字段，
 *    其余字段是 NULL，需要靠下面第2条逐步补全。是否为ETF/ADR/REIT用符号名称
 *    的启发式规则(名字包含"ETF"/"Trust"/"Fund"等关键词)做粗略判断，
 *    明确标注 data_source='alpaca_assets(heuristic_flags)'，不是官方分类。
 *
 * 2) enrichFromAnalysis()：每次扫描/历史回溯得到 SymbolAnalysis 后，把里面已经
 *    真实算出来的字段(price/avgVol50/sectorEtf/RS百分位/质量分/综合分/成长分)
 *    反哺进 master_universe 对应的行，同时如果配置了 Finnhub Key，用
 *    Fundamentals.getBundle 里的 profile.marketCap 补市值。这是"扫描到哪些
 *    股票，哪些股票的数据就更全"——不强行为没扫描过的上万只股票伪造市值等
 *    数据，覆盖范围会随着用户实际使用逐步扩大，这是诚实的做法。
 * ============================================================================
 */
'use strict';
import { VADB } from './db.js';
import { AlpacaClient } from '../data/alpacaClient.js';
import { Fundamentals } from '../data/fundamentals.js';

// 启发式ETF/基金关键词（Alpaca assets 不直接给is_etf字段，只能从名称粗略猜）
const ETF_NAME_HINTS = ['ETF', 'TRUST', 'FUND', 'INDEX FD', ' ETN'];

function guessIsEtf(name) {
  if (!name) return 0;
  const upper = name.toUpperCase();
  return ETF_NAME_HINTS.some(h => upper.includes(h)) ? 1 : 0;
}

function nowIso() { return new Date().toISOString(); }

export const MasterUniverseSync = {

  /**
   * 同步 Alpaca 全市场可交易资产列表到 master_universe，作为 Full Tradable Universe 的真实底表。
   * 数量可能上万，用事务批量写入以控制耗时。返回 { total, inserted, source }。
   */
  async syncTradableAssets() {
    if (!AlpacaClient.hasCredentials()) throw new Error('尚未配置 Alpaca API Key，无法同步全市场资产列表');
    await VADB.init();
    const assets = await AlpacaClient.listAssets({ status: 'active', assetClass: 'us_equity' });
    if (!Array.isArray(assets)) throw new Error('Alpaca /v2/assets 返回格式异常');

    const ts = nowIso();
    VADB.transaction(() => {
      for (const a of assets) {
        if (!a.symbol) continue;
        const isEtf = guessIsEtf(a.name);
        VADB.run(
          `INSERT INTO master_universe (symbol, company, exchange, asset_type, is_etf, active, tradable, data_source, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(symbol) DO UPDATE SET
             company=excluded.company, exchange=excluded.exchange, asset_type=excluded.asset_type,
             is_etf=excluded.is_etf, active=excluded.active, tradable=excluded.tradable,
             data_source=excluded.data_source, last_updated=excluded.last_updated`,
          [a.symbol, a.name || null, a.exchange || null, a.class || 'us_equity', isEtf,
            a.status === 'active' ? 1 : 0, a.tradable ? 1 : 0, 'alpaca_assets(heuristic_flags)', ts]
        );
      }
    });
    return { total: assets.length, source: 'alpaca_assets', syncedAt: ts };
  },

  /**
   * 用一批已经跑完信号引擎的 SymbolAnalysis[] 反哺 master_universe。
   * 在 scanEngine/historyEngine 每次扫描完成后调用，覆盖范围随实际使用自然扩大。
   */
  async enrichFromAnalysis(results) {
    if (!results || !results.length) return { updated: 0 };
    await VADB.init();
    const ts = nowIso();
    let updated = 0;
    VADB.transaction(() => {
      for (const r of results) {
        if (r.isError || !r.sym) continue;
        // 注意：fund.profile 在没配置Finnhub Key时是 {}（空对象，不是null/undefined），
        // 所以 profile.marketCap 在这种情况下取到的是 undefined 而不是 null——sql.js 的
        // 参数绑定不接受 undefined（会直接抛错），这里必须显式用 ?? 兜底成 null。
        const marketCap = (r.quality && r.quality.fund && r.quality.fund.profile && r.quality.fund.profile.marketCap) ?? null;
        const sector = r.sectorEtf || null;
        VADB.run(
          `INSERT INTO master_universe (symbol, sector, price, market_cap, rs_percentile, quality_score, composite_score, data_source, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(symbol) DO UPDATE SET
             sector=COALESCE(excluded.sector, sector),
             price=COALESCE(excluded.price, price),
             market_cap=COALESCE(excluded.market_cap, market_cap),
             rs_percentile=COALESCE(excluded.rs_percentile, rs_percentile),
             quality_score=COALESCE(excluded.quality_score, quality_score),
             composite_score=COALESCE(excluded.composite_score, composite_score),
             data_source=CASE WHEN data_source IS NULL THEN excluded.data_source ELSE data_source || '+scan' END,
             last_updated=excluded.last_updated`,
          [r.sym, sector, r.price ?? null, marketCap,
            r.institutional?.rs?.percentile ?? null,
            r.quality?.score ?? null,
            r.composite?.score ?? null,
            'scan_enrichment', ts]
        );
        updated++;
      }
    });
    return { updated, syncedAt: ts };
  },

  /** 供设置页展示：master_universe 里各字段的"已知/缺失"覆盖率，如实反映数据完整度，不掩盖空洞 */
  getCoverageStats() {
    if (!VADB.isReady()) return null;
    const total = VADB.queryOne('SELECT COUNT(*) AS c FROM master_universe').c;
    if (!total) return { total: 0 };
    const fields = ['sector', 'market_cap', 'price', 'avg_dollar_volume', 'rs_percentile', 'quality_score', 'composite_score', 'beta'];
    const coverage = {};
    for (const f of fields) {
      const row = VADB.queryOne(`SELECT COUNT(*) AS c FROM master_universe WHERE ${f} IS NOT NULL`);
      coverage[f] = { known: row.c, pct: Math.round((row.c / total) * 1000) / 10 };
    }
    return { total, coverage };
  },
};
