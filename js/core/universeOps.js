/**
 * ============================================================================
 * Universe Operations（股票池集合运算 + 快照管理）—— V2 第五阶段新增
 * ----------------------------------------------------------------------------
 * 两类功能：
 *  1. 纯集合运算（Merge/Union/Intersection/Difference/去重/排序/过滤）——
 *     全部是不依赖数据库、不依赖浏览器环境的纯函数，输入输出都是股票代码
 *     数组，可以在 Node 环境直接单元测试。
 *  2. 快照管理（Snapshot/Restore/Rename/Clone/Export/Import）—— 依赖 db.js
 *     的 universe_snapshots 表，把"某一份股票池"存成一条带名字的记录，
 *     方便以后一键恢复，或者导出成 JSON 文件备份/分享给自己的另一台设备。
 *
 * 命名说明：需求里的 Merge 和 Union 语义相同（多个池子取并集去重），这里统一
 * 用 union() 实现，merge() 作为别名保留，避免调用方混淆用哪个函数。
 * ============================================================================
 */
'use strict';
import { VADB } from './db.js';

function normalize(list) {
  return (list || []).map(s => String(s).trim().toUpperCase()).filter(Boolean);
}

export const UniverseOps = {

  /** 并集去重：多个股票池的股票代码合并成一份，重复的只保留一次 */
  union(...lists) {
    const set = new Set();
    for (const list of lists) for (const s of normalize(list)) set.add(s);
    return [...set];
  },
  merge(...lists) { return this.union(...lists); }, // Merge 与 Union 语义相同，保留别名避免调用方困惑

  /** 交集：只保留在"所有"传入池子里都出现过的股票代码 */
  intersection(...lists) {
    if (!lists.length) return [];
    const normed = lists.map(normalize);
    const [first, ...rest] = normed;
    return first.filter(s => rest.every(list => list.includes(s)));
  },

  /** 差集：在 listA 里但不在 listB 里的股票代码（顺序：A 有 B 没有） */
  difference(listA, listB) {
    const a = normalize(listA), b = new Set(normalize(listB));
    return a.filter(s => !b.has(s));
  },

  /** 去重（保持原有出现顺序的第一次出现位置） */
  removeDuplicates(list) {
    return [...new Set(normalize(list))];
  },

  /**
   * 过滤：predicate 收到 (symbol) 返回 true/false。
   * 如果需要按分数过滤，调用方应先准备一个 symbol -> 分数的 Map，
   * 在 predicate 里查表判断（本函数不关心分数从哪来，保持纯粹）。
   */
  filter(list, predicate) {
    return normalize(list).filter(predicate);
  },

  /**
   * 排序：scoreMap 是 { symbol: number }，缺失分数的排在最后（不管升降序）。
   * @param {string[]} list
   * @param {Object<string,number>} scoreMap
   * @param {'asc'|'desc'} dir
   */
  sortBy(list, scoreMap, dir = 'desc') {
    const arr = normalize(list);
    const withScore = arr.filter(s => scoreMap[s] != null);
    const withoutScore = arr.filter(s => scoreMap[s] == null);
    withScore.sort((a, b) => dir === 'asc' ? scoreMap[a] - scoreMap[b] : scoreMap[b] - scoreMap[a]);
    return [...withScore, ...withoutScore];
  },

  /** 导出成可下载的 JSON 字符串（symbols + 元信息），供"导出"按钮使用 */
  exportJSON(name, symbols, meta = {}) {
    return JSON.stringify({ name, symbols: normalize(symbols), exportedAt: new Date().toISOString(), ...meta }, null, 2);
  },

  /** 导入：解析用户上传/粘贴的 JSON 文本，校验结构，返回 { name, symbols } */
  importJSON(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('不是合法的JSON格式: ' + e.message); }
    if (!data || !Array.isArray(data.symbols)) throw new Error('JSON里缺少 symbols 数组字段，不是本系统导出的股票池文件');
    return { name: data.name || '导入的股票池', symbols: normalize(data.symbols) };
  },

  // ---------------- 快照（依赖数据库，浏览器环境专用） ----------------

  /** 保存一份命名快照 */
  async snapshot(name, symbols, source = 'manual', note = '') {
    if (!name || !name.trim()) throw new Error('快照需要一个名字');
    await VADB.init();
    VADB.run(
      'INSERT INTO universe_snapshots (name, symbols_json, source, note, created_at) VALUES (?, ?, ?, ?, ?)',
      [name.trim(), JSON.stringify(normalize(symbols)), source, note, new Date().toISOString()]
    );
    return this.listSnapshots();
  },

  async listSnapshots() {
    await VADB.init();
    return VADB.query('SELECT id, name, source, note, created_at, symbols_json FROM universe_snapshots ORDER BY created_at DESC')
      .map(r => ({ ...r, symbolCount: JSON.parse(r.symbols_json).length }));
  },

  /** 恢复：取回某个快照的股票代码数组 */
  async restore(id) {
    await VADB.init();
    const row = VADB.queryOne('SELECT * FROM universe_snapshots WHERE id = ?', [id]);
    if (!row) throw new Error(`快照 #${id} 不存在（可能已被删除）`);
    return { name: row.name, symbols: JSON.parse(row.symbols_json), source: row.source, note: row.note, createdAt: row.created_at };
  },

  async rename(id, newName) {
    if (!newName || !newName.trim()) throw new Error('新名字不能为空');
    await VADB.init();
    VADB.run('UPDATE universe_snapshots SET name = ? WHERE id = ?', [newName.trim(), id]);
    return this.listSnapshots();
  },

  /** 克隆：复制一份快照(带新名字)，原快照保留不动 */
  async clone(id, newName) {
    const original = await this.restore(id);
    return this.snapshot(newName || `${original.name} 副本`, original.symbols, 'clone', `克隆自快照 #${id}`);
  },

  async deleteSnapshot(id) {
    await VADB.init();
    VADB.run('DELETE FROM universe_snapshots WHERE id = ?', [id]);
    return this.listSnapshots();
  },
};
