#!/usr/bin/env node
/**
 * ============================================================================
 * 云端定时扫描脚本 (Cloud Scan Script) —— 配合 GitHub Actions 使用
 * ----------------------------------------------------------------------------
 * 设计要点：这个脚本直接复用 js/ 目录下和浏览器共用的同一套模块
 * (indicators / timeframe / universeEngine / signals / scanEngine)，
 * 不重新实现一遍指标逻辑——这是"模块化解耦"的直接好处：核心计算逻辑
 * 只有一份，浏览器端和 Node 云端跑的是完全相同的代码。
 *
 * 由于 alpacaClient.js / fundamentals.js / notify.js 是为浏览器写的，
 * 依赖 localStorage 存取 Key，这里在 Node 环境里用一个极简的 in-memory
 * localStorage polyfill、把 GitHub Actions Secrets(环境变量) 写进去，
 * 上层模块完全不需要改动就能在 Node 里跑。
 *
 * 用法（本地测试）：
 *   ALPACA_KEY_ID=xxx ALPACA_SECRET=yyy node cloud/scan.mjs
 * GitHub Actions 里通过 workflow 的 env 从 Secrets 注入，见
 * .github/workflows/daily-scan.yml
 * ============================================================================
 */
'use strict';

// ---- localStorage polyfill（必须在 import 其他模块之前执行）----
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: (k) => _store.delete(k),
};
globalThis.localStorage.setItem('va_alpaca_key_id', process.env.ALPACA_KEY_ID || '');
globalThis.localStorage.setItem('va_alpaca_secret', process.env.ALPACA_SECRET || '');
globalThis.localStorage.setItem('va_finnhub_key', process.env.FINNHUB_KEY || '');
globalThis.localStorage.setItem('va_notify_tg_token', process.env.TG_BOT_TOKEN || '');
globalThis.localStorage.setItem('va_notify_tg_chat', process.env.TG_CHAT_ID || '');
globalThis.localStorage.setItem('va_notify_discord_url', process.env.DISCORD_WEBHOOK || '');
globalThis.localStorage.setItem('va_notify_feishu_url', process.env.FEISHU_WEBHOOK || '');

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScanEngine } from '../js/core/scanEngine.js';
import { UniverseEngine } from '../js/core/universeEngine.js';
import { Notify } from '../js/core/notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const poolId = process.env.SCAN_POOL || 'core';        // 想扫哪个 Universe 池子，见 universeEngine.js 的 PoolRegistry
  const limit = Number(process.env.SCAN_LIMIT || 600);   // 免费数据源+限流环境下建议分批，避免单次跑太久
  console.log(`[cloud-scan] 池子=${poolId} 上限=${limit} 开始拉取股票池...`);

  const { symbols, meta } = await UniverseEngine.getSeedSymbols(poolId);
  const targets = symbols.slice(0, limit);
  console.log(`[cloud-scan] 股票池获取完成，共 ${symbols.length} 只（本次扫描前 ${targets.length} 只），meta=${JSON.stringify(meta)}`);

  const concurrency = Number(process.env.SCAN_CONCURRENCY || 5); // 并发worker数，GitHub Actions环境网络较好，可以适当调高
  const result = await ScanEngine.scan(targets, { concurrency }, (done, total, sym) => {
    if (done % 25 === 0 || done === total) console.log(`[cloud-scan] 进度 ${done}/${total} (最近: ${sym})`);
  });

  const triggered = result.results.filter(r => !r.isError && r.resonance && r.resonance.allPass);
  console.log(`[cloud-scan] 扫描完成：${result.results.length} 只，三频共振全部通过 ${triggered.length} 只`);

  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);

  const record = {
    date: dateStr,
    strategy: '三频共振 + 机构多因子分层组合',
    dataSource: globalThis.localStorage.getItem('va_alpaca_key_id') ? 'Alpaca' : 'Yahoo Finance(兜底)',
    pool: poolId,
    total: result.results.length,
    triggered: triggered.length,
    tickers: triggered.map(r => r.sym),
  };

  const listFile = path.join(outDir, 'history.json');
  let history = [];
  if (fs.existsSync(listFile)) {
    try { history = JSON.parse(fs.readFileSync(listFile, 'utf-8')); } catch { history = []; }
  }
  history.unshift(record);
  history = history.slice(0, 90); // 只保留最近90次运行记录，避免文件无限增长
  fs.writeFileSync(listFile, JSON.stringify(history, null, 2));

  // 保存完整明细（前端"云端结果"页可选加载，展示综合评分/三频细节）
  const slim = result.results.map(r => r.isError
    ? { sym: r.sym, error: r.error }
    : { sym: r.sym, price: r.price, composite: r.composite, resonance: { passCount: r.resonance.passCount, allPass: r.resonance.allPass }, rsPercentile: r.institutional?.rs?.percentile ?? null });
  fs.writeFileSync(path.join(outDir, `detail-${dateStr}.json`), JSON.stringify(slim, null, 2));
  fs.writeFileSync(path.join(outDir, 'latest-full.json'), JSON.stringify(slim, null, 2));

  if (process.env.NOTIFY_ON_SIGNAL === 'true' && triggered.length > 0) {
    console.log('[cloud-scan] 发送 Webhook 通知...');
    const sendResult = await Notify.sendAll(Notify.formatScanSummary(result));
    console.log('[cloud-scan] 通知结果:', JSON.stringify(sendResult));
  }

  console.log('[cloud-scan] 完成，结果已写入 cloud/results/');
}

main().catch((e) => {
  console.error('[cloud-scan] 运行失败:', e);
  process.exit(1);
});
