/**
 * ============================================================================
 * VectorAlpha 嵌入式数据库引擎 (Embedded SQLite Engine) —— V2 第八阶段新增
 * ----------------------------------------------------------------------------
 * 背景：VectorAlpha 部署在 GitHub Pages 上，是纯静态网站，没有服务器后端，
 * 传统意义上"服务器端 SQLite 数据库"跑不起来。这里用 sql.js（真正的 SQLite
 * 引擎，编译成 WebAssembly，在浏览器里原生运行，不是模拟/抽象层）+ IndexedDB
 * 做持久化：sql.js 提供完整的 SQL 查询能力（真正的 SELECT/JOIN/WHERE/聚合函数），
 * IndexedDB 负责把整个数据库文件（一份二进制 Uint8Array）存到浏览器本地，
 * 下次打开网页时读回来继续用。
 *
 * 明确的能力边界（如实说明，不假装是服务器数据库）：
 *  1. 数据只保存在"当前使用的这一台电脑/这一个浏览器"里，换设备或清浏览器
 *     数据会丢失，不会像服务器数据库那样自动跨设备同步。如果需要跨设备，
 *     可以用下面的 exportDatabase() 导出成 .sqlite 文件手动搬运，或者继续
 *     使用已有的 GitHub Actions 云端同步(cloudSync.js)保存关键结果的JSON快照。
 *  2. sql.js 本体（约1.5MB的wasm文件）从CDN(jsdelivr)按需异步加载，不打包进
 *     仓库，也不需要任何构建步骤——这与整个项目"纯ES Modules、无打包器"的
 *     架构保持一致。加载失败(网络问题/CDN被墙)时所有依赖数据库的功能会
 *     明确报错并提示原因，不会静默假装成功。
 *  3. 是单机嵌入式数据库，没有多用户并发写入的问题，防抖持久化(600ms)
 *     足够应对这个场景，不需要事务锁之类的复杂机制。
 *
 * 这个文件只负责"数据库引擎本身"（建表、连接、通用查询/执行、持久化），
 * 不包含任何业务语义(什么是master_universe、怎么筛选、怎么算信号表现)——
 * 那些逻辑分别在 masterUniverseSync.js / universeBuilder.js / signalTracking.js /
 * universeOps.js 里，符合"数据库引擎"和"业务逻辑"解耦的模块化要求。
 * ============================================================================
 */
'use strict';

const SQLJS_CDN_BASE = 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/';
const IDB_NAME = 'va_sqlite_db';
const IDB_STORE = 'kv';
const IDB_KEY = 'main.sqlite';
const SAVE_DEBOUNCE_MS = 600;

// 完整表结构：见文件头。所有业务模块共用这一份 schema，新增字段/表只改这里。
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS master_universe (
  symbol TEXT PRIMARY KEY,
  company TEXT,
  exchange TEXT,
  sector TEXT,
  industry TEXT,
  country TEXT,
  market_cap REAL,
  price REAL,
  avg_volume REAL,
  avg_dollar_volume REAL,
  ipo_date TEXT,
  asset_type TEXT,
  is_etf INTEGER DEFAULT 0,
  is_adr INTEGER DEFAULT 0,
  is_reit INTEGER DEFAULT 0,
  is_delisted INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  tradable INTEGER DEFAULT 1,
  dividend_yield REAL,
  beta REAL,
  rs_percentile REAL,
  quality_score REAL,
  momentum_score REAL,
  growth_score REAL,
  composite_score REAL,
  data_source TEXT,
  last_updated TEXT
);
CREATE INDEX IF NOT EXISTS idx_master_universe_sector ON master_universe(sector);
CREATE INDEX IF NOT EXISTS idx_master_universe_exchange ON master_universe(exchange);

CREATE TABLE IF NOT EXISTS saved_builders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  conditions_json TEXT NOT NULL,
  match_mode TEXT DEFAULT 'AND',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS universe_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  symbols_json TEXT NOT NULL,
  source TEXT,
  note TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS signal_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  price REAL,
  composite_score REAL,
  rs_percentile REAL,
  resonance_pass_count INTEGER,
  quality_score REAL,
  canslim_score REAL,
  sector_etf TEXT,
  is_historical INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_signal_history_symbol_date ON signal_history(symbol, scan_date);
CREATE INDEX IF NOT EXISTS idx_signal_history_date ON signal_history(scan_date);

CREATE TABLE IF NOT EXISTS signal_returns (
  signal_id INTEGER NOT NULL,
  horizon_days INTEGER NOT NULL,
  forward_return_pct REAL,
  max_gain_pct REAL,
  max_drawdown_pct REAL,
  beat_spy INTEGER,
  spy_return_pct REAL,
  computed_at TEXT,
  PRIMARY KEY (signal_id, horizon_days)
);
`;

let _SQL = null;        // initSqlJs() 返回的模块对象
let _db = null;         // sql.js Database 实例（真正的SQLite连接）
let _initPromise = null;
let _saveTimer = null;
let _lastError = null;

function _loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (window.initSqlJs) { resolve(); return; }
    const existing = document.querySelector(`script[data-vadb-sqljs]`);
    if (existing) { existing.addEventListener('load', () => resolve()); existing.addEventListener('error', () => reject(new Error('sql.js 加载失败'))); return; }
    const s = document.createElement('script');
    s.src = src;
    s.setAttribute('data-vadb-sqljs', '1');
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('sql.js 加载失败(CDN不可达或被浏览器拦截)'));
    document.head.appendChild(s);
  });
}

async function _loadSqlJs() {
  await _loadScriptOnce(SQLJS_CDN_BASE + 'sql-wasm.js');
  if (!window.initSqlJs) throw new Error('sql.js 脚本已加载但未找到 initSqlJs 全局函数，CDN返回内容可能异常');
  return window.initSqlJs;
}

function _idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  });
}
async function _idbGet() {
  const conn = await _idbOpen();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function _idbSet(uint8arr) {
  const conn = await _idbOpen();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(uint8arr, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function _scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try {
      const data = _db.export();
      await _idbSet(data);
    } catch (e) {
      _lastError = e.message;
      console.warn('[VADB] 持久化到IndexedDB失败(本次查询/写入结果仍在内存里有效，只是刷新页面会丢): ' + e.message);
    }
  }, SAVE_DEBOUNCE_MS);
}

export const VADB = {

  /** 初始化数据库：加载sql.js → 读IndexedDB里已有的数据库文件(没有就新建) → 建表。幂等，多次调用只会真正初始化一次。 */
  async init() {
    if (_db) return _db;
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      const initSqlJs = await _loadSqlJs();
      _SQL = await initSqlJs({ locateFile: f => SQLJS_CDN_BASE + f });
      let saved = null;
      try { saved = await _idbGet(); } catch (e) { console.warn('[VADB] 读取IndexedDB历史数据库失败，将新建一份空库: ' + e.message); }
      _db = saved ? new _SQL.Database(new Uint8Array(saved)) : new _SQL.Database();
      _db.run(SCHEMA_SQL);
      if (!saved) _scheduleSave();
      return _db;
    })();
    return _initPromise;
  },

  isReady() { return !!_db; },
  lastError() { return _lastError; },

  /** 执行不返回结果集的SQL(INSERT/UPDATE/DELETE/CREATE)，自动触发防抖持久化 */
  run(sql, params = []) {
    if (!_db) throw new Error('数据库尚未初始化，请先调用 VADB.init()（一般在应用启动时已自动调用）');
    _db.run(sql, params);
    _scheduleSave();
  },

  /** 查询，返回 [{列名: 值, ...}, ...] 数组格式，方便上层直接用，而不是sql.js原始的列式结果集 */
  query(sql, params = []) {
    if (!_db) throw new Error('数据库尚未初始化，请先调用 VADB.init()');
    const stmt = _db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  },

  /** 单行查询的便捷方法，查不到返回 null */
  queryOne(sql, params = []) {
    const rows = this.query(sql, params);
    return rows.length ? rows[0] : null;
  },

  /** 事务：把多个写操作包在一个事务里，减少防抖持久化触发次数、保证原子性 */
  transaction(fn) {
    if (!_db) throw new Error('数据库尚未初始化');
    _db.run('BEGIN TRANSACTION');
    try {
      const result = fn();
      _db.run('COMMIT');
      _scheduleSave();
      return result;
    } catch (e) {
      _db.run('ROLLBACK');
      throw e;
    }
  },

  /** 导出整个数据库为可下载的 .sqlite 文件（真正的SQLite文件格式，能被任何SQLite工具打开），供"导出数据库"按钮使用 */
  exportDatabase() {
    if (!_db) throw new Error('数据库尚未初始化');
    const data = _db.export();
    return new Blob([data], { type: 'application/x-sqlite3' });
  },

  /** 清空重建（保留表结构，删除全部数据），供"设置"页"重置本地数据库"按钮使用 */
  async resetDatabase() {
    if (!_db) throw new Error('数据库尚未初始化');
    _db.close();
    _db = new _SQL.Database();
    _db.run(SCHEMA_SQL);
    await _idbSet(_db.export());
  },

  /** 各表行数统计，供"设置"页展示数据库状态用 */
  getTableCounts() {
    if (!_db) return null;
    const tables = ['master_universe', 'saved_builders', 'universe_snapshots', 'signal_history', 'signal_returns'];
    const counts = {};
    for (const t of tables) {
      const row = this.queryOne(`SELECT COUNT(*) AS c FROM ${t}`);
      counts[t] = row ? row.c : 0;
    }
    return counts;
  },
};

export const SCHEMA_SQL_FOR_TEST = SCHEMA_SQL; // 仅供单元测试核对schema用，不建议业务代码依赖这个导出
