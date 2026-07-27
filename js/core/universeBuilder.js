/**
 * ============================================================================
 * Dynamic Universe Builder（动态股票池构建器）—— V2 第一阶段新增
 * ----------------------------------------------------------------------------
 * 用户可以自由组合任意条件（Exchange / Market Cap / Price / Average Dollar
 * Volume / Average Volume / Country / Industry / Sector / ETF / ADR / REIT /
 * IPO Age / Dividend / Beta / RS / Quality Score / Momentum Score / Growth
 * Score / Composite Score），比如"NASDAQ AND Market Cap > 10B AND RS > 80"，
 * 自动查询 db.js 的 master_universe 表生成股票池；查询条件本身也可以保存/
 * 修改/删除（存进 saved_builders 表），下次直接复用。
 *
 * 设计上分两层，解耦"条件怎么拼SQL"和"怎么存取"：
 *  - buildWhereClause(conditions, matchMode)：纯函数，把条件数组翻译成
 *    参数化的 SQL WHERE 子句 + 参数数组。不依赖数据库连接，可以脱离浏览器
 *    环境单独做单元测试(见 tests/run.mjs)，这样即使以后 sql.js/IndexedDB
 *    的部分改动，条件翻译逻辑的正确性也能独立验证。
 *  - UniverseBuilder.execute/save/list/delete：依赖 VADB，只在浏览器里跑。
 *
 * 安全性：字段名不是直接拼用户输入，而是必须命中 FIELD_DEFS 白名单才会被
 * 接受，白名单外的字段直接抛错——防止SQL注入，也防止拼错字段名导致的
 * 静默查询错误。
 * ============================================================================
 */
'use strict';
import { VADB } from './db.js';

// 可筛选字段白名单：字段名 -> { column, type, ops(允许的操作符) }
// type 决定了 UI 应该渲染成什么输入控件，也用来做基本的值校验。
export const FIELD_DEFS = {
  exchange:         { column: 'exchange', type: 'text', label: '交易所 (Exchange)', ops: ['=', '!=', 'in'] },
  country:          { column: 'country', type: 'text', label: '国家 (Country)', ops: ['=', '!=', 'in'] },
  sector:           { column: 'sector', type: 'text', label: '板块 (Sector ETF)', ops: ['=', '!=', 'in'] },
  industry:         { column: 'industry', type: 'text', label: '行业 (Industry)', ops: ['=', '!=', 'contains'] },
  asset_type:       { column: 'asset_type', type: 'text', label: '资产类型 (Asset Type)', ops: ['=', '!='] },
  market_cap:       { column: 'market_cap', type: 'number', label: '市值 (Market Cap)', ops: ['>', '<', '>=', '<=', 'between'] },
  price:            { column: 'price', type: 'number', label: '价格 (Price)', ops: ['>', '<', '>=', '<=', 'between'] },
  avg_volume:       { column: 'avg_volume', type: 'number', label: '平均成交量 (Avg Volume)', ops: ['>', '<', '>=', '<='] },
  avg_dollar_volume:{ column: 'avg_dollar_volume', type: 'number', label: '平均成交额 (Avg $ Volume)', ops: ['>', '<', '>=', '<='] },
  dividend_yield:   { column: 'dividend_yield', type: 'number', label: '股息率 (Dividend Yield %)', ops: ['>', '<', '>=', '<='] },
  beta:             { column: 'beta', type: 'number', label: 'Beta', ops: ['>', '<', '>=', '<=', 'between'] },
  rs_percentile:    { column: 'rs_percentile', type: 'number', label: 'RS 百分位', ops: ['>', '<', '>=', '<='] },
  quality_score:    { column: 'quality_score', type: 'number', label: 'Quality Score', ops: ['>', '<', '>=', '<='] },
  momentum_score:   { column: 'momentum_score', type: 'number', label: 'Momentum Score', ops: ['>', '<', '>=', '<='] },
  growth_score:     { column: 'growth_score', type: 'number', label: 'Growth Score', ops: ['>', '<', '>=', '<='] },
  composite_score:  { column: 'composite_score', type: 'number', label: 'Composite Score', ops: ['>', '<', '>=', '<='] },
  ipo_age_days:     { column: "CAST(julianday('now') - julianday(ipo_date) AS INTEGER)", type: 'number', label: 'IPO Age (天数)', ops: ['>', '<', '>=', '<='], rawExpr: true },
  is_etf:           { column: 'is_etf', type: 'boolean', label: 'ETF', ops: ['is_true', 'is_false'] },
  is_adr:           { column: 'is_adr', type: 'boolean', label: 'ADR', ops: ['is_true', 'is_false'] },
  is_reit:          { column: 'is_reit', type: 'boolean', label: 'REIT', ops: ['is_true', 'is_false'] },
  is_delisted:      { column: 'is_delisted', type: 'boolean', label: '已退市 (Delisted)', ops: ['is_true', 'is_false'] },
  active:           { column: 'active', type: 'boolean', label: '在市 (Active)', ops: ['is_true', 'is_false'] },
  tradable:         { column: 'tradable', type: 'boolean', label: '可交易 (Tradable)', ops: ['is_true', 'is_false'] },
};

/**
 * 把单个条件翻译成 "column OP ?" 片段 + 对应参数。
 * @param {{field, op, value, value2}} cond
 */
function _clauseForCondition(cond) {
  const def = FIELD_DEFS[cond.field];
  if (!def) throw new Error(`未知的筛选字段: ${cond.field}（不在 FIELD_DEFS 白名单内，可能是拼写错误或需要先在 universeBuilder.js 里注册）`);
  if (!def.ops.includes(cond.op)) throw new Error(`字段 "${cond.field}" 不支持操作符 "${cond.op}"，允许的操作符: ${def.ops.join('/')}`);
  const col = def.column;

  switch (cond.op) {
    case '=': return { sql: `${col} = ?`, params: [cond.value] };
    case '!=': return { sql: `${col} != ?`, params: [cond.value] };
    case '>': return { sql: `${col} > ?`, params: [cond.value] };
    case '<': return { sql: `${col} < ?`, params: [cond.value] };
    case '>=': return { sql: `${col} >= ?`, params: [cond.value] };
    case '<=': return { sql: `${col} <= ?`, params: [cond.value] };
    case 'between': {
      if (cond.value == null || cond.value2 == null) throw new Error(`字段 "${cond.field}" 的 between 操作需要同时提供 value 和 value2`);
      return { sql: `${col} BETWEEN ? AND ?`, params: [cond.value, cond.value2] };
    }
    case 'contains': return { sql: `${col} LIKE ?`, params: [`%${cond.value}%`] };
    case 'in': {
      const list = Array.isArray(cond.value) ? cond.value : String(cond.value).split(',').map(s => s.trim()).filter(Boolean);
      if (!list.length) throw new Error(`字段 "${cond.field}" 的 in 操作需要至少一个值`);
      return { sql: `${col} IN (${list.map(() => '?').join(',')})`, params: list };
    }
    case 'is_true': return { sql: `${col} = 1`, params: [] };
    case 'is_false': return { sql: `${col} = 0`, params: [] };
    default:
      throw new Error(`未实现的操作符: ${cond.op}`);
  }
}

/**
 * 纯函数：条件数组 -> 参数化 WHERE 子句。matchMode='AND'|'OR'。
 * 空条件数组返回 { sql: '1=1', params: [] }（不加任何限制，即"全部"）。
 * 这是本文件里唯一不依赖数据库、可以在 Node 环境单元测试的函数。
 */
export function buildWhereClause(conditions, matchMode = 'AND') {
  if (!conditions || !conditions.length) return { sql: '1=1', params: [] };
  const joiner = matchMode === 'OR' ? ' OR ' : ' AND ';
  const parts = [];
  const params = [];
  for (const cond of conditions) {
    const { sql, params: p } = _clauseForCondition(cond);
    parts.push(`(${sql})`);
    params.push(...p);
  }
  return { sql: parts.join(joiner), params };
}

export const UniverseBuilder = {
  FIELD_DEFS,
  buildWhereClause,

  /** 执行一组条件，返回命中的 master_universe 行（按 composite_score 降序，NULL排最后） */
  async execute(conditions, matchMode = 'AND', opts = {}) {
    await VADB.init();
    const { sql, params } = buildWhereClause(conditions, matchMode);
    const limit = opts.limit ? Math.min(opts.limit, 5000) : 2000;
    const rows = VADB.query(
      `SELECT * FROM master_universe WHERE ${sql} ORDER BY (composite_score IS NULL), composite_score DESC LIMIT ?`,
      [...params, limit]
    );
    return rows;
  },

  /** 保存一份查询条件（按name upsert），供以后直接复用/编辑 */
  async saveQuery(name, conditions, matchMode = 'AND') {
    if (!name || !name.trim()) throw new Error('保存的构建器查询需要一个名字');
    await VADB.init();
    const ts = new Date().toISOString();
    VADB.run(
      `INSERT INTO saved_builders (name, conditions_json, match_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET conditions_json=excluded.conditions_json, match_mode=excluded.match_mode, updated_at=excluded.updated_at`,
      [name.trim(), JSON.stringify(conditions), matchMode, ts, ts]
    );
    return this.listSaved();
  },

  async listSaved() {
    await VADB.init();
    return VADB.query('SELECT * FROM saved_builders ORDER BY updated_at DESC').map(r => ({ ...r, conditions: JSON.parse(r.conditions_json) }));
  },

  async deleteSaved(id) {
    await VADB.init();
    VADB.run('DELETE FROM saved_builders WHERE id = ?', [id]);
    return this.listSaved();
  },
};
