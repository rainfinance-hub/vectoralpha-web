/**
 * ============================================================================
 * 主界面控制器 (App / UI Glue)
 * ----------------------------------------------------------------------------
 * 本文件只负责："监听DOM事件 -> 调用核心模块 -> 把结果渲染回DOM"。
 * 不包含任何指标计算或信号判断逻辑——那些都在 core/ 和 signals/ 目录下。
 * 这样即使以后完全换一套UI框架(比如换成React)，核心引擎代码也不需要动。
 * ============================================================================
 */
'use strict';
import { UniverseEngine } from '../core/universeEngine.js';
import { ScanEngine } from '../core/scanEngine.js';
import { HistoryEngine } from '../core/historyEngine.js';
import { RiskWorkbench } from '../core/riskWorkbench.js';
import { RSBenchmark } from '../core/rsBenchmark.js';
import { Notify } from '../core/notify.js';
import { CloudSync } from '../core/cloudSync.js';
import { MarketContext } from '../signals/marketContext.js';
import { AlpacaClient } from '../data/alpacaClient.js';
import { Fundamentals } from '../data/fundamentals.js';
import { DataSource } from '../data/dataSource.js';
import { HELP_HTML } from './helpContent.js';
// ---- V2 新增模块（Dynamic Universe Builder / Master Universe / 股票池运算 / 统计 / 风险分析 / 信号跟踪 / 本地数据库） ----
import { VADB } from '../core/db.js';
import { MasterUniverseSync } from '../core/masterUniverseSync.js';
import { UniverseBuilder } from '../core/universeBuilder.js';
import { UniverseOps } from '../core/universeOps.js';
import { UniverseStats } from '../core/universeStats.js';
import { RiskAnalytics } from '../core/riskAnalytics.js';
import { SignalTracking } from '../core/signalTracking.js';

const STATE = {
  currentPoolSymbols: [],
  lastScanResult: null,
  lastHistoryBatch: null,
  scanning: false,
  stopRequested: false,
};

// "当前扫描池"落盘到 localStorage（2026-07 新增）：之前 STATE.currentPoolSymbols
// 只存在内存里，用户反馈"点了派生池的载入按钮、也弹出了确认提示，但切到「股票池」
// 页文本框是空的"——排查后最合理的解释是浏览器在两步操作之间刷新/重新打开了页面，
// 内存状态被清空了，而这个字段之前没有像观察池/持仓/自定义池那样持久化，
// 一刷新就"凭空消失"，看起来像是bug。现在统一落盘，刷新页面也不会丢。
const LS_CURRENT_POOL = 'va_current_pool_symbols';
function setCurrentPool(symbols) {
  STATE.currentPoolSymbols = symbols;
  const box = document.querySelector('#currentPoolBox');
  const count = document.querySelector('#currentPoolCount');
  if (box) box.value = symbols.join(', ');
  if (count) count.textContent = symbols.length;
  try { localStorage.setItem(LS_CURRENT_POOL, JSON.stringify(symbols)); } catch (e) { /* 存储配额不足时静默失败，不影响本次内存里的状态 */ }
}
function restoreCurrentPool() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_CURRENT_POOL) || '[]');
    if (Array.isArray(saved) && saved.length) setCurrentPool(saved);
  } catch (e) { /* 忽略损坏的缓存数据 */ }
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
function fmtNum(v, d = 2) { return v == null ? 'N/A' : Number(v).toFixed(d); }
function fmtPct(v, d = 1) { return v == null ? 'N/A' : Number(v).toFixed(d) + '%'; }
function tagHtml(pass, textTrue = '通过', textFalse = '未通过', textNA = 'N/A') {
  if (pass == null) return `<span class="tag tag-na">${textNA}</span>`;
  return pass ? `<span class="tag tag-pass">${textTrue}</span>` : `<span class="tag tag-fail">${textFalse}</span>`;
}
function scoreColor(score) {
  if (score == null) return 'var(--text3)';
  if (score >= 70) return 'var(--green)';
  if (score >= 40) return 'var(--amber)';
  return 'var(--red)';
}
function log(msg, level = 'info') {
  const box = $('#logBox');
  if (!box) return;
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  line.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}
function setProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('#scanProgressBar').style.width = pct + '%';
  $('#scanProgressText').textContent = `${done}/${total} (${pct}%)`;
}

// ---------------------------------------------------------------------------
// Tab 切换
// ---------------------------------------------------------------------------
function initTabs() {
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`#page-${btn.dataset.page}`).classList.add('active');
    });
  });
}

// ---------------------------------------------------------------------------
// 股票池页面
// ---------------------------------------------------------------------------
function renderPoolRegistry() {
  const box = $('#poolRegistryList');
  box.innerHTML = UniverseEngine.registry().map(p => `
    <div class="pool-card">
      <div><span class="pn">${p.name}</span><span class="pw">${p.weight}</span></div>
      <div class="pd">${p.desc}</div>
      <div class="pk">${p.kind === 'SEED' ? '种子池·可直接扫描' : p.kind === 'DERIVED' ? '派生池·需先扫描' : '事件池·依赖可选Key'}</div>
      ${p.kind === 'SEED' ? `<button class="btn-s mt8" data-load-pool="${p.id}">➡ 载入</button>` : ''}
    </div>
  `).join('');
  box.querySelectorAll('[data-load-pool]').forEach(btn => {
    btn.addEventListener('click', () => loadSeedPool(btn.dataset.loadPool));
  });
}

async function loadSeedPool(poolId) {
  log(`正在加载股票池: ${poolId} ...`, 'info');
  try {
    const { symbols, meta } = await UniverseEngine.getSeedSymbols(poolId);
    setCurrentPool(symbols);
    log(`✓ 已载入 ${symbols.length} 只 (${poolId})，meta=${JSON.stringify(meta)}`, 'ok');
  } catch (e) {
    log(`✗ 加载失败: ${e.message}`, 'err');
    alert('加载股票池失败: ' + e.message);
  }
}

function initUniversePage() {
  renderPoolRegistry();
  $('#btnUseCustom').addEventListener('click', () => {
    const raw = $('#customPoolInput').value.trim();
    const symbols = raw.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    UniverseEngine.saveCustomPool(symbols);
    setCurrentPool(symbols);
    log(`✓ 已载入自定义列表 ${symbols.length} 只`, 'ok');
  });
  initUniverseOps();
}

// ---------------------------------------------------------------------------
// 股票池运算 Universe Operations（V2 第五阶段新增）
// 对"当前扫描池"和"第二个池子输入框"做集合运算，结果替换当前扫描池；
// 另外支持把当前扫描池存成命名快照(依赖本地SQLite数据库)，随时恢复/克隆/导出。
// ---------------------------------------------------------------------------
function secondPoolSymbols() {
  const raw = $('#opsSecondPoolInput').value.trim();
  return raw.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
}

function initUniverseOps() {
  $('#btnOpsUnion').addEventListener('click', () => {
    const result = UniverseOps.union(STATE.currentPoolSymbols, secondPoolSymbols());
    setCurrentPool(result);
    log(`✓ 并集运算完成，当前扫描池共 ${result.length} 只`, 'ok');
  });
  $('#btnOpsIntersect').addEventListener('click', () => {
    const result = UniverseOps.intersection(STATE.currentPoolSymbols, secondPoolSymbols());
    setCurrentPool(result);
    log(`✓ 交集运算完成，当前扫描池共 ${result.length} 只`, 'ok');
  });
  $('#btnOpsDifference').addEventListener('click', () => {
    const result = UniverseOps.difference(STATE.currentPoolSymbols, secondPoolSymbols());
    setCurrentPool(result);
    log(`✓ 差集运算完成(当前池−第二个池)，当前扫描池共 ${result.length} 只`, 'ok');
  });
  $('#btnOpsDedup').addEventListener('click', () => {
    const before = STATE.currentPoolSymbols.length;
    const result = UniverseOps.removeDuplicates(STATE.currentPoolSymbols);
    setCurrentPool(result);
    log(`✓ 去重完成，${before} → ${result.length} 只`, 'ok');
  });
  $('#btnOpsExport').addEventListener('click', () => {
    const json = UniverseOps.exportJSON('当前扫描池', STATE.currentPoolSymbols, { source: 'current_pool' });
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `vectoralpha_pool_${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  });
  $('#opsImportFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const text = await file.text();
      const { name, symbols } = UniverseOps.importJSON(text);
      setCurrentPool(symbols);
      log(`✓ 已导入「${name}」共 ${symbols.length} 只，载入到当前扫描池`, 'ok');
    } catch (err) {
      alert('导入失败: ' + err.message);
    } finally {
      e.target.value = '';
    }
  });
  $('#btnOpsSnapshot').addEventListener('click', async () => {
    const name = $('#opsSnapshotName').value.trim();
    if (!name) { alert('请先输入快照名字'); return; }
    if (!STATE.currentPoolSymbols.length) { alert('当前扫描池为空，没有可保存的内容'); return; }
    try {
      await UniverseOps.snapshot(name, STATE.currentPoolSymbols, 'manual', `保存于 ${new Date().toLocaleString('zh-CN')}`);
      log(`✓ 已保存快照「${name}」`, 'ok');
      $('#opsSnapshotName').value = '';
      renderSnapshotsTable();
    } catch (e) {
      alert('保存快照失败(本地数据库): ' + e.message);
    }
  });
  renderSnapshotsTable();
}

async function renderSnapshotsTable() {
  try {
    const list = await UniverseOps.listSnapshots();
    $('#tblSnapshots thead').innerHTML = `<tr><th>名字</th><th>股票数</th><th>来源</th><th>创建时间</th><th></th></tr>`;
    $('#tblSnapshots tbody').innerHTML = list.map(s => `<tr>
      <td>${s.name}</td><td>${s.symbolCount}</td><td>${s.source || ''}</td><td>${(s.created_at || '').replace('T', ' ').slice(0, 19)}</td>
      <td>
        <button class="btn-s" data-snap-restore="${s.id}">恢复</button>
        <button class="btn-s" data-snap-clone="${s.id}">克隆</button>
        <button class="btn-s" data-snap-del="${s.id}">删除</button>
      </td>
    </tr>`).join('');
    $('#tblSnapshots').querySelectorAll('[data-snap-restore]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { symbols, name } = await UniverseOps.restore(Number(btn.dataset.snapRestore));
        setCurrentPool(symbols);
        log(`✓ 已恢复快照「${name}」，共 ${symbols.length} 只，载入到当前扫描池`, 'ok');
      });
    });
    $('#tblSnapshots').querySelectorAll('[data-snap-clone]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newName = prompt('克隆后的新名字'); if (!newName) return;
        await UniverseOps.clone(Number(btn.dataset.snapClone), newName);
        renderSnapshotsTable();
      });
    });
    $('#tblSnapshots').querySelectorAll('[data-snap-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await UniverseOps.deleteSnapshot(Number(btn.dataset.snapDel));
        renderSnapshotsTable();
      });
    });
  } catch (e) {
    $('#tblSnapshots thead').innerHTML = '';
    $('#tblSnapshots tbody').innerHTML = `<tr><td style="color:var(--text3)">本地数据库尚未初始化或不可用: ${e.message}</td></tr>`;
  }
}

// ---------------------------------------------------------------------------
// 扫描页面
// ---------------------------------------------------------------------------
function initScanPage() {
  $('#btnStartScan').addEventListener('click', runScan);
  $('#btnStopScan').addEventListener('click', () => { STATE.stopRequested = true; });
}

async function runScan() {
  if (!STATE.currentPoolSymbols.length) { alert('请先在「股票池」页载入一个扫描池'); return; }
  if (!AlpacaClient.hasCredentials()) { log('⚠ 未配置 Alpaca Key，将自动降级使用 Yahoo Finance 免费接口（小时线可能不可用）', 'warn'); }
  STATE.scanning = true; STATE.stopRequested = false;
  $('#btnStartScan').disabled = true; $('#btnStopScan').disabled = false;
  $('#logBox').innerHTML = '';
  log(`开始扫描 ${STATE.currentPoolSymbols.length} 只股票...`, 'info');
  const sectorEnabled = $('#cfgSectorEnabled').checked;

  const result = await ScanEngine.scan(STATE.currentPoolSymbols, { sectorEnabled }, (done, total, sym) => {
    setProgress(done, total);
    if (done % 10 === 0 || done === total) log(`进度 ${done}/${total}（最近: ${sym}）`, 'info');
  });

  STATE.lastScanResult = result;
  STATE.scanning = false;
  $('#btnStartScan').disabled = false; $('#btnStopScan').disabled = true;
  const errCount = result.results.filter(r => r.isError).length;
  log(`✓ 扫描完成，成功 ${result.results.length - errCount}/${result.results.length}`, 'ok');
  renderScanResultsTable(result.results);
}

function renderScanResultsTable(results) {
  const valid = results.filter(r => !r.isError).sort((a, b) => (b.composite?.score ?? -1) - (a.composite?.score ?? -1));
  const errored = results.filter(r => r.isError);
  $('#scanResultCount').textContent = results.length;
  const thead = `<tr><th>代码</th><th>价格</th><th>综合评分</th><th>三频共振</th><th>RS%</th><th>Minervini</th><th>Weinstein</th><th>CANSLIM</th><th>数据源</th><th></th></tr>`;
  const rows = valid.map(r => `
    <tr>
      <td class="sym-link" data-sym="${r.sym}">${r.sym}</td>
      <td>$${fmtNum(r.price)}</td>
      <td style="color:${scoreColor(r.composite?.score)};font-weight:700">${r.composite?.score ?? 'N/A'}</td>
      <td>${r.resonance ? `${r.resonance.passCount}/${r.resonance.totalChecked}` : 'N/A'} ${r.resonance?.allPass ? '🎯' : ''}</td>
      <td>${r.institutional?.rs?.percentile ?? 'N/A'}</td>
      <td>${tagHtml(r.institutional?.minervini?.trendTemplatePass)}</td>
      <td>${r.institutional?.weinstein?.stage != null ? 'Stage ' + r.institutional.weinstein.stage : 'N/A'}</td>
      <td>${r.institutional?.canslim?.score ?? 'N/A'}</td>
      <td>${r.dataSource?.daily ?? ''}/${r.dataSource?.hourly ?? ''}</td>
      <td><button class="btn-s" data-detail-sym="${r.sym}">详情</button></td>
    </tr>`).join('');
  const errRows = errored.map(r => `<tr><td>${r.sym}</td><td colspan="9" style="color:var(--red)">${r.error}</td></tr>`).join('');
  $('#tblScanResults thead').innerHTML = thead;
  $('#tblScanResults tbody').innerHTML = rows + errRows;
  $('#tblScanResults').querySelectorAll('[data-detail-sym]').forEach(btn => {
    btn.addEventListener('click', () => openDetailModal(valid.find(r => r.sym === btn.dataset.detailSym)));
  });
  $('#tblScanResults').querySelectorAll('.sym-link').forEach(el => {
    el.addEventListener('click', () => openDetailModal(valid.find(r => r.sym === el.dataset.sym)));
  });
}

// ---------------------------------------------------------------------------
// 详情弹窗（扫描结果 / 历史回溯 共用）
// ---------------------------------------------------------------------------
function openDetailModal(r) {
  if (!r) return;
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-mask" id="modalMask"><div class="modal-box">
    <button class="modal-close" id="modalCloseBtn">✕</button>
    ${renderDetailContent(r)}
  </div></div>`;
  $('#modalCloseBtn').addEventListener('click', () => root.innerHTML = '');
  $('#modalMask').addEventListener('click', (e) => { if (e.target.id === 'modalMask') root.innerHTML = ''; });
}

function renderDetailContent(r) {
  const c = r.composite;
  let html = `<h2 style="margin-top:0">${r.sym} <span style="color:${scoreColor(c?.score)}">综合评分 ${c?.score ?? 'N/A'}</span></h2>`;
  html += `<div class="hint">价格 $${fmtNum(r.price)} · 数据日期 ${r.effectiveDate || r.requestedDate || ''} · 数据源(日线/小时线): ${r.dataSource?.daily}/${r.dataSource?.hourly} · 板块归属: ${r.sectorEtf || '未归类'}</div>`;

  if (r.isHistorical) {
    if (r.isNonTradingDay) html += `<div class="warn-banner">⚠️ ${r.requestedDate} 非交易日，已自动使用最近交易日 ${r.effectiveDate}</div>`;
    if (r.nonPointInTimeWarning) html += `<div class="warn-banner">${r.nonPointInTimeWarning}</div>`;
    if (r.rsNote) html += `<div class="warn-banner">${r.rsNote}</div>`;
  }

  // 综合评分明细
  if (c && c.breakdown) {
    html += `<h3>综合评分明细（分层组合）</h3><table><thead><tr><th>层</th><th>是否可用</th><th>原始分</th><th>实际权重</th><th>贡献分</th></tr></thead><tbody>`;
    html += c.breakdown.map(b => `<tr><td>${b.layer}</td><td>${b.available ? '✓' : '✗ 不参与'}</td><td>${b.score ?? '-'}</td><td>${b.weight}%</td><td>${b.contribution}</td></tr>`).join('');
    html += `</tbody></table>`;
  }

  // 三频共振
  html += `<h3>③ 三频共振 Resonance（${r.resonance?.passCount ?? 0}/${r.resonance?.totalChecked ?? 0} 通过）</h3><ul class="detail-list">`;
  for (const key of ['weekly', 'daily', 'short']) {
    const p = r.resonance?.[key];
    if (!p) { html += `<li><span class="ck">${tagHtml(null)}</span><div>${key} 数据不足</div></li>`; continue; }
    html += `<li><span class="ck">${tagHtml(p.pass)}</span><div><b>${p.label}</b><br><span class="hint">收盘${fmtNum(p.lastClose)} / 均线${fmtNum(p.ma)} / RSI${fmtNum(p.rsi, 1)}${p.macdHist != null ? ' / MACD柱' + fmtNum(p.macdHist, 4) : ''}</span></div></li>`;
  }
  if (r.resonance?.hourly) {
    const h = r.resonance.hourly;
    html += `<li><span class="ck">${tagHtml(h.pass)}</span><div><b>${h.label}</b>（确认层，不计入通过数）</div></li>`;
  }
  html += `</ul>`;

  // 机构多因子
  const inst = r.institutional || {};
  html += `<h3>④ 机构多因子 Institutional</h3>`;
  if (inst.minervini) {
    html += `<b>Minervini 趋势模板</b>（${inst.minervini.trendTemplatePass ? '✅全部通过' : '未全部通过'}，评分${inst.minervini.score ?? 'N/A'}）<ul class="detail-list">`;
    html += inst.minervini.detail.map(d => `<li><span class="ck">${tagHtml(d.pass)}</span><div>${d.label}</div></li>`).join('');
    html += `</ul>`;
  }
  if (inst.weinstein) {
    html += `<b>Weinstein 阶段分析</b>：${inst.weinstein.label || inst.weinstein.note || 'N/A'}`;
  }
  if (inst.canslim) {
    html += `<b>CANSLIM</b>（评分 ${inst.canslim.score ?? 'N/A'}，数据覆盖 ${inst.canslim.coverage ?? inst.canslim.sampleSize + '/' + inst.canslim.totalItems}，置信度：${inst.canslim.confidenceLabel ?? 'N/A'}）<ul class="detail-list">`;
    html += inst.canslim.detail.map(d => `<li><span class="ck">${d.available ? tagHtml(d.pass) : '<span class="tag tag-na">不可用</span>'}</span><div>[${d.key}] ${d.label}${d.note ? ' · ' + d.note : ''}</div></li>`).join('');
    html += `</ul>`;
  }
  if (inst.rs) html += `<div class="hint">RS 相对强度百分位：${inst.rs.percentile ?? 'N/A'}${inst.rs.basis ? `（${inst.rs.basis === 'benchmark' ? '✓ 相对全市场RS基准池，跨扫描可比' : '⚠️ 相对本次样本内，基准池不可用时的回退算法，换一批股票扫描结果会不同'}）` : ''}</div>`;

  // 质量层
  if (r.quality) {
    html += `<h3>⑤ 质量评分 Quality</h3>`;
    if (!r.quality.available) html += `<div class="hint">数据不可用（未配置 Finnhub Key 或该股票数据缺失）</div>`;
    else {
      html += `评分：${r.quality.score ?? 'N/A'}<ul class="detail-list">`;
      html += (r.quality.detail || []).map(d => `<li><div>${d.label}: ${d.score}</div></li>`).join('');
      html += `</ul>`;
    }
  }
  return html;
}

// ---------------------------------------------------------------------------
// 派生池页面
// ---------------------------------------------------------------------------
function initDerivedPage() {
  $('#btnDeriveNow').addEventListener('click', () => {
    if (!STATE.lastScanResult) { alert('请先在「扫描」页完成一次扫描'); return; }
    const valid = STATE.lastScanResult.results.filter(r => !r.isError);
    const pools = UniverseEngine.deriveDynamicPools(valid);
    renderDerivedPools(pools);
  });
}

function renderDerivedPools(pools) {
  const meta = [
    { key: 'momentum', name: 'Momentum Universe 趋势池', metric: r => `RS ${r.institutional.rs.percentile}` },
    { key: 'quality', name: 'Quality Universe 质量池', metric: r => `质量分 ${r.quality.score}` },
    { key: 'highRS', name: 'High Relative Strength 高强度池', metric: r => `RS ${r.institutional.rs.percentile}` },
    { key: 'newHighs', name: 'New Highs 新高池', metric: r => `价格 $${fmtNum(r.price)} / 52周高 $${fmtNum(r.raw.high52w)}` },
    { key: 'institutional', name: 'Institutional Buying 机构买入代理池 ⚠️非真实机构数据', metric: r => `CMF ${fmtNum(r.raw.cmfNow, 3)}` },
    { key: 'canslim', name: 'CANSLIM Candidates', metric: r => `评分 ${r.institutional.canslim.score}（数据覆盖${r.institutional.canslim.coverage ?? 'N/A'}，置信度${r.institutional.canslim.confidence ?? 'N/A'}）` },
    { key: 'minervini', name: 'Minervini Candidates', metric: r => `RS ${r.institutional.rs.percentile}` },
  ];
  const box = $('#derivedPoolsBox');
  // 之前这里只是把派生池结果列出来看，没有办法把某个派生池"送回"当前扫描池，
  // 导致用户没法拿着"Momentum趋势池"这14只股票再去跑历史回溯/加观察池——
  // 现在每个有数据的池子都加一个"➡ 载入到当前扫描池"按钮，点击后行为和
  // 「股票池」页的种子池"载入"按钮完全一致：把这批代码写进 STATE.currentPoolSymbols，
  // 之后就可以去「扫描」「历史回溯」「观察池」等页面直接使用这批股票。
  //
  // 2026-07新增：用户反馈"只能一个一个池子单独载入，不能合并"——比如想同时拿
  // Momentum趋势池+Quality质量池这两批股票一起做后续分析，之前只能载入A再载入B，
  // 但每次载入都是"整体替换"而不是"追加"，B会把A覆盖掉。现在每个非空池子前面加一个
  // 勾选框，可以勾多个池子后点顶部"合并勾选的池"按钮，把选中的几个池子的股票代码
  // 去重合并成一份，一次性载入当前扫描池。
  const mergeBar = `<div class="card mt12" id="derivedMergeBar">
    <div class="hint">勾选下面想要一起用的池子（可多选），点击"合并勾选的池"可以把它们的股票去重合并后一次性载入「当前扫描池」，不用一个一个单独载入再覆盖。</div>
    <div class="mt8"><button class="btn-s" id="btnMergeSelectedDerived">🔗 合并勾选的池 → 载入当前扫描池</button>
    <span id="derivedMergeCount" class="hint" style="margin-left:8px;">未勾选</span></div>
  </div>`;
  box.innerHTML = mergeBar + meta.map(m => {
    const list = pools[m.key] || [];
    return `<div class="card mt12"><div class="card-h">
      ${list.length ? `<input type="checkbox" class="derived-pool-chk" data-pool-key="${m.key}" style="margin-right:6px;">` : ''}
      ${m.name} <span class="badge">${list.length}</span></div>
      ${list.length ? `<div class="hint">${list.slice(0, 30).map(r => `${r.sym}(${m.metric(r)})`).join(' · ')}${list.length > 30 ? ` 等共${list.length}只` : ''}</div>
      <button class="btn-s mt8" data-load-derived="${m.key}">➡ 载入到当前扫描池（共${list.length}只）</button>` : '<div class="hint">本次扫描样本中暂无符合条件的股票</div>'}
    </div>`;
  }).join('');
  box.querySelectorAll('[data-load-derived]').forEach(btn => {
    btn.addEventListener('click', () => loadDerivedPool(btn.dataset.loadDerived, pools));
  });
  box.querySelectorAll('.derived-pool-chk').forEach(chk => {
    chk.addEventListener('change', () => updateDerivedMergeCount(pools));
  });
  $('#btnMergeSelectedDerived')?.addEventListener('click', () => mergeSelectedDerivedPools(pools));
  updateDerivedMergeCount(pools);
}

function loadDerivedPool(key, pools) {
  const list = pools[key] || [];
  if (!list.length) { alert('该派生池当前没有符合条件的股票，无法载入'); return; }
  const symbols = list.map(r => r.sym);
  setCurrentPool(symbols);
  log(`✓ 已把派生池「${key}」的 ${symbols.length} 只股票载入到当前扫描池`, 'ok');
  alert(`已载入 ${symbols.length} 只股票到"当前扫描池"，可以去「扫描」页或「历史回溯」页对这批股票做进一步分析。`);
}

function _selectedDerivedSymbols(pools) {
  const box = $('#derivedPoolsBox');
  const checkedKeys = [...box.querySelectorAll('.derived-pool-chk:checked')].map(el => el.dataset.poolKey);
  const symbolSet = new Set();
  checkedKeys.forEach(key => (pools[key] || []).forEach(r => symbolSet.add(r.sym)));
  return { checkedKeys, symbols: [...symbolSet] };
}

function updateDerivedMergeCount(pools) {
  const countEl = $('#derivedMergeCount');
  if (!countEl) return;
  const { checkedKeys, symbols } = _selectedDerivedSymbols(pools);
  countEl.textContent = checkedKeys.length ? `已勾选 ${checkedKeys.length} 个池，去重合并后共 ${symbols.length} 只` : '未勾选';
}

function mergeSelectedDerivedPools(pools) {
  const { checkedKeys, symbols } = _selectedDerivedSymbols(pools);
  if (!checkedKeys.length) { alert('请先勾选至少一个派生池（每个池子标题左边有勾选框）'); return; }
  if (!symbols.length) { alert('勾选的池子里没有符合条件的股票'); return; }
  setCurrentPool(symbols);
  log(`✓ 已合并 ${checkedKeys.length} 个派生池（${checkedKeys.join('、')}），去重后共 ${symbols.length} 只，载入到当前扫描池`, 'ok');
  alert(`已合并 ${checkedKeys.length} 个派生池，去重后共 ${symbols.length} 只股票，载入到"当前扫描池"，可以去「扫描」页或「历史回溯」页对这批股票做进一步分析。`);
}

// ---------------------------------------------------------------------------
// 历史回溯页面
// ---------------------------------------------------------------------------
function initHistoryPage() {
  $('#histDate').value = new Date().toISOString().slice(0, 10);
  $('#histBatchDate').value = new Date().toISOString().slice(0, 10);
  $('#btnHistRun').addEventListener('click', runHistorySingle);
  $('#btnHistBatchRun').addEventListener('click', runHistoryBatch);
}

async function runHistorySingle() {
  const sym = $('#histSym').value.trim().toUpperCase();
  const date = $('#histDate').value;
  if (!sym || !date) { alert('请输入股票代码和日期'); return; }
  $('#histSingleResult').innerHTML = '<div class="hint">分析中...</div>';
  try {
    const result = await HistoryEngine.lookbackSingle(sym, date, { sectorEnabled: $('#cfgSectorEnabled')?.checked || false });
    $('#histSingleResult').innerHTML = renderDetailContent(result);
  } catch (e) {
    $('#histSingleResult').innerHTML = `<div class="warn-banner">✗ ${e.message}</div>`;
  }
}

async function runHistoryBatch() {
  if (!STATE.currentPoolSymbols.length) { alert('请先在「股票池」页载入一个扫描池'); return; }
  const date = $('#histBatchDate').value;
  if (!date) { alert('请选择日期'); return; }
  $('#histBatchProgress').textContent = '开始批量回溯...';
  const result = await HistoryEngine.lookbackBatch(STATE.currentPoolSymbols, date, { sectorEnabled: $('#cfgSectorEnabled')?.checked || false }, (done, total, sym) => {
    $('#histBatchProgress').textContent = `进度 ${done}/${total}（最近: ${sym}）`;
  });
  STATE.lastHistoryBatch = result;
  $('#histBatchProgress').innerHTML = `✓ 完成，共 ${result.results.length} 只（${date}${result.nonPointInTimeWarning ? '，' + result.nonPointInTimeWarning : ''}）`;
  renderHistBatchTable(result.results);
}

function renderHistBatchTable(results) {
  const valid = results.filter(r => !r.isError).sort((a, b) => (b.composite?.score ?? -1) - (a.composite?.score ?? -1));
  const thead = `<tr><th>代码</th><th>当天价格</th><th>综合评分</th><th>三频共振</th><th>RS%</th><th>Minervini</th><th></th></tr>`;
  const rows = valid.map(r => `<tr>
    <td>${r.sym}</td><td>$${fmtNum(r.price)}</td>
    <td style="color:${scoreColor(r.composite?.score)};font-weight:700">${r.composite?.score ?? 'N/A'}</td>
    <td>${r.resonance ? `${r.resonance.passCount}/${r.resonance.totalChecked}` : 'N/A'}</td>
    <td>${r.institutional?.rs?.percentile ?? 'N/A'}</td>
    <td>${tagHtml(r.institutional?.minervini?.trendTemplatePass)}</td>
    <td><button class="btn-s" data-hist-detail="${r.sym}">详情</button></td>
  </tr>`).join('');
  $('#tblHistBatch thead').innerHTML = thead;
  $('#tblHistBatch tbody').innerHTML = rows;
  $('#tblHistBatch').querySelectorAll('[data-hist-detail]').forEach(btn => {
    btn.addEventListener('click', () => openDetailModal(valid.find(r => r.sym === btn.dataset.histDetail)));
  });
}

// ---------------------------------------------------------------------------
// 持仓风控页面
// ---------------------------------------------------------------------------
function initRiskPage() {
  renderPortfolioTable();
  $('#btnAddPos').addEventListener('click', () => {
    const sym = prompt('股票代码'); if (!sym) return;
    const shares = Number(prompt('股数')); const cost = Number(prompt('成本价'));
    if (!shares || !cost) { alert('股数/成本价无效'); return; }
    UniverseEngine.addPosition({ sym, shares, cost });
    renderPortfolioTable();
  });
  $('#btnBuildWorkbench').addEventListener('click', () => {
    if (!STATE.lastScanResult) { alert('请先完成一次扫描'); return; }
    const ranked = STATE.lastScanResult.results.filter(r => !r.isError && r.composite?.score != null && r.composite.score >= 60)
      .sort((a, b) => b.composite.score - a.composite.score);
    const maxSectorPctInput = Number($('#rmMaxSector').value);
    const cfg = {
      equity: Number($('#rmEquity').value), riskPct: Number($('#rmRiskPct').value),
      maxPosPct: Number($('#rmMaxPos').value), maxSectorPct: maxSectorPctInput > 0 ? maxSectorPctInput : null,
      stopMode: $('#rmStopMode').value,
    };
    const wb = RiskWorkbench.buildWorkbench(ranked, cfg);
    renderWorkbenchTable(wb);
  });
  $('#btnReviewHoldings').addEventListener('click', reviewHoldings);
  $('#btnRunRiskAnalytics').addEventListener('click', runRiskAnalytics);
}

// ---------------------------------------------------------------------------
// 组合风险分析 Portfolio Risk Analytics（V2 第七阶段新增）
// 基于"持仓列表"+ 最近一次扫描结果(取现价/止损/板块归属)，计算组合层面的
// Open Risk / Portfolio Heat / 板块与主题敞口 / 相关性 / 三种仓位权重算法对比。
// ---------------------------------------------------------------------------
function runRiskAnalytics() {
  const positions = UniverseEngine.getPortfolio();
  if (!positions.length) { alert('还没有持仓，请先在上方"持仓列表"添加'); return; }
  if (!STATE.lastScanResult) { alert('请先扫描一个包含这些持仓代码的股票池，用来取最新现价/止损/板块归属'); return; }
  const bySym = {}; STATE.lastScanResult.results.forEach(r => { bySym[r.sym] = r; });

  const equity = Number($('#rmEquity').value) || 0;
  const enriched = positions.map(p => {
    const r = bySym[p.sym];
    if (!r || r.isError || r.price == null) return { sym: p.sym, shares: p.shares, price: null, stopPrice: null, sectorEtf: null };
    const stopPrice = p.customStop || RiskWorkbench.computeStopPrice(r.raw, r.price, 'combo');
    return { sym: p.sym, shares: p.shares, price: r.price, stopPrice, sectorEtf: r.sectorEtf, atrPct: r.raw && r.raw.atrNow != null ? (r.raw.atrNow / r.price) * 100 : null };
  });
  const missing = enriched.filter(p => p.price == null).map(p => p.sym);

  const openRisk = RiskAnalytics.computeOpenRisk(enriched);
  const heat = RiskAnalytics.computePortfolioHeat(enriched, equity);
  const sectorExposure = RiskAnalytics.computeSectorExposure(enriched, equity);
  const themeExposure = RiskAnalytics.computeThemeExposure(enriched, equity);
  const violations = RiskAnalytics.checkRiskBudget({
    openRisk, equity,
    maxOpenRiskPct: Number($('#raMaxOpenRisk').value) || null,
    sectorExposure, maxSectorRiskPct: Number($('#raMaxSectorRisk').value) || null,
    themeExposure, maxThemeRiskPct: Number($('#raMaxThemeRisk').value) || null,
  });
  const volCandidates = enriched.filter(p => p.atrPct != null);
  const volSizing = RiskAnalytics.volatilityPositionSizing(volCandidates, equity);
  const riskParity = RiskAnalytics.riskParityWeights(volCandidates.map(p => ({ sym: p.sym, volatilityPct: p.atrPct })));

  let html = `<div class="stat-tiles">
    <div class="stat-tile"><div class="stv">$${openRisk}</div><div class="stl">Open Risk</div></div>
    <div class="stat-tile"><div class="stv">${heat ?? 'N/A'}%</div><div class="stl">Portfolio Heat</div></div>
    <div class="stat-tile"><div class="stv">${sectorExposure.length}</div><div class="stl">涉及板块数</div></div>
    <div class="stat-tile"><div class="stv">${themeExposure.length}</div><div class="stl">涉及主题数</div></div>
  </div>`;
  if (missing.length) html += `<div class="warn-banner">⚠️ 以下持仓在最近一次扫描结果里没找到，未计入计算：${missing.join('、')}</div>`;
  if (violations.length) {
    html += `<div class="warn-banner">⚠️ Risk Budget 超限提示：<ul>${violations.map(v => `<li>${v.message}</li>`).join('')}</ul></div>`;
  } else {
    html += `<div class="hint">✓ 当前组合未超过设定的风险上限</div>`;
  }
  html += `<h3>板块敞口 Sector Exposure</h3>` + (sectorExposure.length
    ? sectorExposure.map(s => `<div class="dist-bar-row"><span class="dist-bar-label">${s.sector}</span><div class="dist-bar-track"><div class="dist-bar-fill" style="width:${Math.min(100, s.pctOfEquity)}%"></div></div><span class="dist-bar-count">${s.pctOfEquity}%</span></div>`).join('')
    : '<div class="hint">暂无可计算数据</div>');
  html += `<h3>主题敞口 Theme Exposure</h3>` + (themeExposure.length
    ? themeExposure.map(t => `<div class="dist-bar-row"><span class="dist-bar-label">${t.theme}</span><div class="dist-bar-track"><div class="dist-bar-fill" style="width:${Math.min(100, t.pctOfEquity)}%"></div></div><span class="dist-bar-count">${t.pctOfEquity}%</span></div>`).join('')
    : '<div class="hint">暂无可计算数据</div>');

  // 相关性矩阵：需要拉取每只持仓的日线收盘序列，用 DataSource 缓存(扫描时已大概率预取过)
  html += `<h3>持仓相关性 Correlation（高相关提示，阈值${$('#raCorrThreshold').value}）</h3><div id="raCorrBox" class="hint">计算中...</div>`;

  // 三种仓位权重算法对比
  html += `<h3>仓位权重算法对比（供参考，不自动应用）</h3>`;
  if (volSizing.length) {
    html += `<b>波动率反比仓位法 Volatility Position Sizing</b><table><thead><tr><th>代码</th><th>ATR%</th><th>建议权重</th><th>建议金额</th></tr></thead><tbody>` +
      volSizing.map(v => `<tr><td>${v.sym}</td><td>${fmtPct(v.atrPct)}</td><td>${v.weight}%</td><td>$${v.capitalAmount}</td></tr>`).join('') + `</tbody></table>`;
  }
  if (riskParity.length) {
    html += `<b class="mt12" style="display:block">简化风险平价 Naive Risk Parity（反比波动率近似，非完整迭代优化）</b><table><thead><tr><th>代码</th><th>波动率%</th><th>建议权重</th></tr></thead><tbody>` +
      riskParity.map(v => `<tr><td>${v.sym}</td><td>${fmtPct(v.volatilityPct)}</td><td>${v.weight}%</td></tr>`).join('') + `</tbody></table>`;
  }
  html += `<div class="hint mt12">Kelly 仓位法需要"胜率/平均盈亏比"统计数据，建议先去「信号跟踪」页积累一段时间的信号表现数据后再使用；也可以在浏览器控制台直接调用 <code>RiskAnalytics.computeKellyFraction({winRate, avgWinPct, avgLossPct})</code> 手动输入参数试算。</div>`;

  $('#riskAnalyticsResult').innerHTML = html;

  // 异步补算相关性矩阵，不阻塞上面已经能立即展示的部分
  (async () => {
    try {
      const closeMap = {};
      for (const p of enriched) {
        if (p.price == null) continue;
        const daily = await DataSource.getDaily(p.sym, { yearsBack: 1 });
        closeMap[p.sym] = daily.bars.map(b => b.c);
      }
      const corrResult = RiskAnalytics.computeCorrelationMatrix(closeMap);
      const pairs = RiskAnalytics.findHighCorrelationPairs(corrResult, Number($('#raCorrThreshold').value) || 0.75);
      const box = $('#raCorrBox');
      if (!box) return;
      box.innerHTML = pairs.length
        ? `<ul class="detail-list">${pairs.map(p => `<li>${p.a} ↔ ${p.b}：相关系数 ${p.correlation}</li>`).join('')}</ul>`
        : '未发现相关性超过阈值的持仓对（或数据不足30个交易日，无法计算）';
    } catch (e) {
      const box = $('#raCorrBox');
      if (box) box.textContent = '相关性计算失败: ' + e.message;
    }
  })();
}

function renderPortfolioTable() {
  const list = UniverseEngine.getPortfolio();
  $('#tblPortfolio thead').innerHTML = `<tr><th>代码</th><th>股数</th><th>成本</th><th>买入日期</th><th></th></tr>`;
  $('#tblPortfolio tbody').innerHTML = list.map(p => `<tr>
    <td>${p.sym}</td><td>${p.shares}</td><td>$${fmtNum(p.cost)}</td><td>${p.buyDate}</td>
    <td><button class="btn-s" data-remove-pos="${p.id}">删除</button></td>
  </tr>`).join('');
  $('#tblPortfolio').querySelectorAll('[data-remove-pos]').forEach(btn => {
    btn.addEventListener('click', () => { UniverseEngine.removePosition(Number(btn.dataset.removePos)); renderPortfolioTable(); });
  });
}

function renderWorkbenchTable(wb) {
  $('#tblWorkbench thead').innerHTML = `<tr><th>代码</th><th>板块</th><th>现价</th><th>止损价</th><th>止损%</th><th>止盈价</th><th>建议股数</th><th>占用资金</th><th>风险金额</th><th>状态</th></tr>`;
  $('#tblWorkbench tbody').innerHTML = wb.rows.map(r => `<tr>
    <td>${r.sym}</td><td>${r.sectorEtf || '未归类'}</td><td>$${fmtNum(r.price)}</td><td>${r.ok ? '$' + fmtNum(r.stopPrice) : '-'}</td>
    <td>${r.ok ? fmtPct(r.stopPct) : '-'}</td><td>${r.ok ? '$' + fmtNum(r.targetPrice) : '-'}</td>
    <td>${r.ok ? r.shares : '-'}</td><td>${r.ok ? '$' + r.capitalNeeded : '-'}</td><td>${r.ok ? '$' + r.riskAmount : '-'}</td>
    <td>${r.ok ? (r.capped ? `已按上限缩减(${(r.capReasons || []).join('、')})` : '正常') + (r.sectorNote ? `<br><span class="hint">${r.sectorNote}</span>` : '') : r.reason}</td>
  </tr>`).join('') + `<tr><td colspan="10" style="color:var(--green)">已分配资金 $${wb.allocatedCapital} / 剩余 $${wb.remainingCapital}（账户总资产 $${wb.equity}）</td></tr>`;

  // 行业分布汇总（2026-07 新增）：一眼看出这次仓位建议有没有在某个行业过度集中
  const sumBox = $('#workbenchSectorSummary');
  if (sumBox) {
    sumBox.innerHTML = (wb.sectorSummary && wb.sectorSummary.length)
      ? `行业资金分布：${wb.sectorSummary.map(s => `${s.sectorEtf} $${s.allocated}(${s.pctOfEquity}%)`).join(' · ')}`
      : '';
  }
}

function reviewHoldings() {
  const positions = UniverseEngine.getPortfolio();
  if (!positions.length) { alert('还没有持仓'); return; }
  if (!STATE.lastScanResult) { alert('请先扫描一个包含这些持仓代码的股票池'); return; }
  const bySym = {}; STATE.lastScanResult.results.forEach(r => { bySym[r.sym] = r; });
  const reviews = positions.map(p => RiskWorkbench.reviewHolding(p, bySym[p.sym]));
  $('#holdingsReview').innerHTML = `<table><thead><tr><th>代码</th><th>现价</th><th>成本</th><th>浮盈亏</th><th>综合评分</th><th>建议</th><th>理由</th></tr></thead><tbody>` +
    reviews.map(r => `<tr>
      <td>${r.sym}</td><td>${r.price != null ? '$' + fmtNum(r.price) : 'N/A'}</td><td>$${fmtNum(r.cost)}</td>
      <td style="color:${r.plPct >= 0 ? 'var(--green)' : 'var(--red)'}">${r.plPct != null ? fmtPct(r.plPct) : 'N/A'}</td>
      <td>${r.compositeScore ?? 'N/A'}</td><td><b>${r.action}</b></td><td class="hint">${(r.reasons || []).join('；')}</td>
    </tr>`).join('') + `</tbody></table>`;
}

// ---------------------------------------------------------------------------
// 观察池页面
// ---------------------------------------------------------------------------
function initWatchlistPage() {
  renderWatchlistTable();
  $('#btnAddWl').addEventListener('click', () => {
    const raw = $('#wlInput').value.trim();
    const note = $('#wlNote').value.trim();
    raw.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean).forEach(sym => UniverseEngine.addToWatchlist(sym, note));
    $('#wlInput').value = ''; $('#wlNote').value = '';
    renderWatchlistTable();
  });
}
function renderWatchlistTable() {
  const list = UniverseEngine.getWatchlist();
  $('#tblWatchlist thead').innerHTML = `<tr><th>代码</th><th>添加日期</th><th>备注</th><th></th></tr>`;
  $('#tblWatchlist tbody').innerHTML = list.map(w => `<tr>
    <td>${w.sym}</td><td>${w.addedDate}</td><td>${w.note || ''}</td>
    <td><button class="btn-s" data-rm-wl="${w.sym}">删除</button></td>
  </tr>`).join('');
  $('#tblWatchlist').querySelectorAll('[data-rm-wl]').forEach(btn => {
    btn.addEventListener('click', () => { UniverseEngine.removeFromWatchlist(btn.dataset.rmWl); renderWatchlistTable(); });
  });
}

// ---------------------------------------------------------------------------
// 云端结果页面
// ---------------------------------------------------------------------------
function initCloudPage() {
  $('#btnLoadCloud').addEventListener('click', async () => {
    try {
      const list = await CloudSync.getHistory();
      $('#tblCloud thead').innerHTML = `<tr><th>日期</th><th>策略</th><th>数据源</th><th>样本数</th><th>触发数</th><th>代码</th></tr>`;
      $('#tblCloud tbody').innerHTML = list.slice(0, 30).map(r => `<tr>
        <td>${r.date}</td><td>${r.strategy}</td><td>${r.dataSource}</td><td>${r.total}</td>
        <td style="color:${r.triggered > 0 ? 'var(--green)' : 'var(--text3)'}">${r.triggered}</td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${(r.tickers || []).join(', ') || '-'}</td>
      </tr>`).join('');
    } catch (e) { alert('加载失败: ' + e.message); }
  });
}

// ---------------------------------------------------------------------------
// 构建器页面 Dynamic Universe Builder（V2 第一阶段新增）
// ---------------------------------------------------------------------------
let builderConditions = [];
let builderSeq = 0;

function newConditionRow() {
  const firstField = Object.keys(UniverseBuilder.FIELD_DEFS)[0];
  const def = UniverseBuilder.FIELD_DEFS[firstField];
  return { rowId: ++builderSeq, field: firstField, op: def.ops[0], value: '', value2: '' };
}

function renderBuilderConditions() {
  const box = $('#builderConditionsBox');
  if (!builderConditions.length) {
    box.innerHTML = '<div class="hint">还没有条件，点击下方"添加条件"开始，比如：交易所=NASDAQ AND 市值 &gt; 100亿 AND RS百分位 &gt; 80</div>';
    return;
  }
  box.innerHTML = builderConditions.map(c => {
    const def = UniverseBuilder.FIELD_DEFS[c.field];
    const fieldOptions = Object.entries(UniverseBuilder.FIELD_DEFS).map(([k, d]) => `<option value="${k}" ${k === c.field ? 'selected' : ''}>${d.label}</option>`).join('');
    const opOptions = def.ops.map(op => `<option value="${op}" ${op === c.op ? 'selected' : ''}>${opLabel(op)}</option>`).join('');
    let valueInputs = '';
    if (def.type === 'boolean') {
      valueInputs = ''; // is_true/is_false 操作符本身已经表达了值，不需要额外输入框
    } else if (c.op === 'between') {
      valueInputs = `<div class="fg"><label>最小值</label><input data-cond-value="${c.rowId}" value="${c.value}" placeholder="min"></div>
        <div class="fg"><label>最大值</label><input data-cond-value2="${c.rowId}" value="${c.value2}" placeholder="max"></div>`;
    } else {
      valueInputs = `<div class="fg"><label>值${c.op === 'in' ? '(逗号分隔多个)' : ''}</label><input data-cond-value="${c.rowId}" value="${c.value}" placeholder="${def.type === 'number' ? '数字' : '文本'}"></div>`;
    }
    return `<div class="cond-row" data-row="${c.rowId}">
      <div class="fg"><label>字段</label><select data-cond-field="${c.rowId}">${fieldOptions}</select></div>
      <div class="fg"><label>操作符</label><select data-cond-op="${c.rowId}">${opOptions}</select></div>
      ${valueInputs}
      <button class="btn-s" data-cond-remove="${c.rowId}">✕ 删除</button>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-cond-field]').forEach(el => el.addEventListener('change', () => {
    const row = builderConditions.find(c => c.rowId === Number(el.dataset.condField));
    row.field = el.value;
    row.op = UniverseBuilder.FIELD_DEFS[el.value].ops[0];
    row.value = ''; row.value2 = '';
    renderBuilderConditions();
  }));
  box.querySelectorAll('[data-cond-op]').forEach(el => el.addEventListener('change', () => {
    const row = builderConditions.find(c => c.rowId === Number(el.dataset.condOp));
    row.op = el.value;
    renderBuilderConditions();
  }));
  box.querySelectorAll('[data-cond-value]').forEach(el => el.addEventListener('input', () => {
    const row = builderConditions.find(c => c.rowId === Number(el.dataset.condValue));
    row.value = el.value;
  }));
  box.querySelectorAll('[data-cond-value2]').forEach(el => el.addEventListener('input', () => {
    const row = builderConditions.find(c => c.rowId === Number(el.dataset.condValue2));
    row.value2 = el.value;
  }));
  box.querySelectorAll('[data-cond-remove]').forEach(el => el.addEventListener('click', () => {
    builderConditions = builderConditions.filter(c => c.rowId !== Number(el.dataset.condRemove));
    renderBuilderConditions();
  }));
}

function opLabel(op) {
  return { '=': '等于', '!=': '不等于', '>': '大于', '<': '小于', '>=': '大于等于', '<=': '小于等于', 'between': '介于', 'contains': '包含', 'in': '属于列表', 'is_true': '是', 'is_false': '否' }[op] || op;
}

/** 把UI里的条件行转换成 universeBuilder.js 需要的 {field, op, value, value2} 格式，数字类型的字段自动转成 Number */
function conditionsForQuery() {
  return builderConditions.map(c => {
    const def = UniverseBuilder.FIELD_DEFS[c.field];
    const conv = v => (def.type === 'number' && v !== '' ? Number(v) : v);
    return { field: c.field, op: c.op, value: conv(c.value), value2: conv(c.value2) };
  });
}

function renderBuilderResultTable(rows) {
  const box = $('#builderResult');
  if (!rows.length) { box.innerHTML = '<div class="hint">没有命中任何股票（可能是条件太严格，或者 Master Universe 数据库里符合条件字段的数据还不够多——建议先去「设置」页做一次全量同步，并多扫描几次积累评分数据）</div>'; return; }
  box.innerHTML = `<div class="hint">共命中 ${rows.length} 只（最多显示2000条，按综合评分降序）</div>
    <div class="tbl-wrap"><table><thead><tr><th>代码</th><th>公司</th><th>交易所</th><th>板块</th><th>市值</th><th>综合评分</th><th>RS%</th></tr></thead><tbody>` +
    rows.map(r => `<tr><td>${r.symbol}</td><td>${r.company || ''}</td><td>${r.exchange || ''}</td><td>${r.sector || ''}</td><td>${r.market_cap != null ? '$' + Math.round(r.market_cap / 1e8) / 10 + 'B' : 'N/A'}</td><td>${r.composite_score ?? 'N/A'}</td><td>${r.rs_percentile ?? 'N/A'}</td></tr>`).join('') +
    `</tbody></table></div>
    <button class="btn-s mt8" id="btnBuilderLoadToPool">➡ 载入到当前扫描池</button>`;
  $('#btnBuilderLoadToPool')?.addEventListener('click', () => {
    setCurrentPool(rows.map(r => r.symbol));
    log(`✓ 已把构建器查询结果(${rows.length}只)载入到当前扫描池`, 'ok');
  });
}

async function renderSavedBuildersTable() {
  try {
    const list = await UniverseBuilder.listSaved();
    $('#tblSavedBuilders thead').innerHTML = `<tr><th>名字</th><th>条件数</th><th>关系</th><th>更新时间</th><th></th></tr>`;
    $('#tblSavedBuilders tbody').innerHTML = list.map(b => `<tr>
      <td>${b.name}</td><td>${b.conditions.length}</td><td>${b.match_mode}</td><td>${(b.updated_at || '').replace('T', ' ').slice(0, 19)}</td>
      <td><button class="btn-s" data-builder-load="${b.id}">载入编辑</button><button class="btn-s" data-builder-del="${b.id}">删除</button></td>
    </tr>`).join('');
    $('#tblSavedBuilders').querySelectorAll('[data-builder-load]').forEach(btn => {
      btn.addEventListener('click', () => {
        const b = list.find(x => x.id === Number(btn.dataset.builderLoad));
        builderConditions = b.conditions.map(c => ({ rowId: ++builderSeq, value: '', value2: '', ...c }));
        $('#builderMatchMode').value = b.match_mode;
        $('#builderSaveName').value = b.name;
        renderBuilderConditions();
      });
    });
    $('#tblSavedBuilders').querySelectorAll('[data-builder-del]').forEach(btn => {
      btn.addEventListener('click', async () => { await UniverseBuilder.deleteSaved(Number(btn.dataset.builderDel)); renderSavedBuildersTable(); });
    });
  } catch (e) {
    $('#tblSavedBuilders thead').innerHTML = '';
    $('#tblSavedBuilders tbody').innerHTML = `<tr><td style="color:var(--text3)">本地数据库尚未初始化或不可用: ${e.message}</td></tr>`;
  }
}

function initBuilderPage() {
  renderBuilderConditions();
  renderSavedBuildersTable();
  $('#btnBuilderAddCondition').addEventListener('click', () => { builderConditions.push(newConditionRow()); renderBuilderConditions(); });
  $('#btnBuilderRun').addEventListener('click', async () => {
    $('#builderResult').innerHTML = '<div class="hint">查询中...</div>';
    try {
      const rows = await UniverseBuilder.execute(conditionsForQuery(), $('#builderMatchMode').value);
      renderBuilderResultTable(rows);
    } catch (e) {
      $('#builderResult').innerHTML = `<div class="warn-banner">✗ ${e.message}</div>`;
    }
  });
  $('#btnBuilderSave').addEventListener('click', async () => {
    const name = $('#builderSaveName').value.trim();
    if (!name) { alert('请输入名字'); return; }
    try {
      await UniverseBuilder.saveQuery(name, conditionsForQuery(), $('#builderMatchMode').value);
      log(`✓ 已保存构建器查询「${name}」`, 'ok');
      renderSavedBuildersTable();
    } catch (e) { alert('保存失败: ' + e.message); }
  });
}

// ---------------------------------------------------------------------------
// 统计页面 Universe Statistics（V2 第四阶段新增）
// ---------------------------------------------------------------------------
function renderDistBars(distribution, labelKey, countKey) {
  const max = Math.max(1, ...distribution.map(d => d[countKey]));
  return distribution.map(d => `<div class="dist-bar-row">
    <span class="dist-bar-label">${d[labelKey]}</span>
    <div class="dist-bar-track"><div class="dist-bar-fill" style="width:${Math.round((d[countKey] / max) * 100)}%"></div></div>
    <span class="dist-bar-count">${d[countKey]}</span>
  </div>`).join('');
}

function initStatsPage() {
  $('#btnStatsFromScan').addEventListener('click', () => {
    if (!STATE.lastScanResult) { $('#statsScanResult').innerHTML = '<div class="hint">请先在「扫描」页完成一次扫描</div>'; return; }
    const s = UniverseStats.fromScanResults(STATE.lastScanResult.results);
    if (!s.total) { $('#statsScanResult').innerHTML = '<div class="hint">没有可统计的有效结果</div>'; return; }
    $('#statsScanResult').innerHTML = `
      <div class="stat-tiles">
        <div class="stat-tile"><div class="stv">${s.total}</div><div class="stl">股票数量</div></div>
        <div class="stat-tile"><div class="stv" style="color:var(--green)">${s.bullish}</div><div class="stl">看多 Bullish(≥70)</div></div>
        <div class="stat-tile"><div class="stv" style="color:var(--amber)">${s.neutral}</div><div class="stl">中性 Neutral(40~70)</div></div>
        <div class="stat-tile"><div class="stv" style="color:var(--red)">${s.bearish}</div><div class="stl">看空 Bearish(&lt;40)</div></div>
        <div class="stat-tile"><div class="stv">${s.avgScore ?? 'N/A'}</div><div class="stl">平均综合评分</div></div>
        <div class="stat-tile"><div class="stv">${s.avgRS ?? 'N/A'}</div><div class="stl">平均RS百分位</div></div>
        <div class="stat-tile"><div class="stv">${fmtNum(s.avgATR)}</div><div class="stl">平均ATR</div></div>
        <div class="stat-tile"><div class="stv">${s.sectorCount}</div><div class="stl">涉及板块数</div></div>
      </div>
      <h3>板块分布 Sector Heatmap</h3>${renderDistBars(s.sectorDistribution, 'sector', 'count')}
      <h3>综合评分分布 Score Distribution</h3>${renderDistBars(s.scoreDistribution, 'label', 'count')}
      <h3>RS百分位分布 RS Distribution</h3>${renderDistBars(s.rsDistribution, 'label', 'count')}
    `;
  });

  $('#btnStatsFromMaster').addEventListener('click', async () => {
    const box = $('#statsMasterResult');
    box.innerHTML = '<div class="hint">查询中...</div>';
    try {
      await VADB.init();
      const rows = VADB.query('SELECT * FROM master_universe');
      const s = UniverseStats.fromMasterUniverseRows(rows);
      if (!s.total) { box.innerHTML = '<div class="hint">master_universe 表目前是空的，请先去「设置」页做一次全量同步</div>'; return; }
      box.innerHTML = `
        <div class="stat-tiles">
          <div class="stat-tile"><div class="stv">${s.total}</div><div class="stl">总股票数</div></div>
          <div class="stat-tile"><div class="stv">${s.etfCount}</div><div class="stl">ETF数量(启发式判断)</div></div>
          <div class="stat-tile"><div class="stv">${s.adrCount}</div><div class="stl">ADR数量</div></div>
          <div class="stat-tile"><div class="stv">${s.reitCount}</div><div class="stl">REIT数量</div></div>
        </div>
        <div class="hint">评分类字段覆盖率：综合评分 ${s.coverage.composite_score.pct}%(${s.coverage.composite_score.known}/${s.total}) · RS百分位 ${s.coverage.rs_percentile.pct}% · 板块归属 ${s.coverage.sector.pct}%</div>
        <h3>交易所分布 Exchange Distribution</h3>${renderDistBars(s.exchangeDistribution, 'exchange', 'count')}
        <h3>国家分布 Country Distribution</h3>${s.countryDistribution.length ? renderDistBars(s.countryDistribution, 'country', 'count') : '<div class="hint">暂无国家数据(需要配置Finnhub Key并同步基本面数据)</div>'}
        <h3>市值分布 Market Cap Distribution</h3>${renderDistBars(s.marketCapDistribution, 'label', 'count')}
      `;
    } catch (e) {
      box.innerHTML = `<div class="warn-banner">✗ ${e.message}</div>`;
    }
  });
}

// ---------------------------------------------------------------------------
// 信号跟踪页面 Signal Tracking（V2 第九阶段新增）
// ---------------------------------------------------------------------------
async function renderSignalPerformanceTable() {
  try {
    const summary = await SignalTracking.getPerformanceSummary();
    $('#tblSignalPerformance thead').innerHTML = `<tr><th>持有期(交易日)</th><th>样本数</th><th>平均前瞻收益</th><th>平均最大涨幅</th><th>平均最大回撤</th><th>跑赢SPY胜率</th></tr>`;
    $('#tblSignalPerformance tbody').innerHTML = summary.length
      ? summary.map(s => `<tr>
          <td>${s.horizonDays}</td><td>${s.samples}</td>
          <td style="color:${s.avgForwardReturnPct >= 0 ? 'var(--green)' : 'var(--red)'}">${s.avgForwardReturnPct != null ? fmtPct(s.avgForwardReturnPct) : 'N/A'}</td>
          <td>${s.avgMaxGainPct != null ? fmtPct(s.avgMaxGainPct) : 'N/A'}</td>
          <td>${s.avgMaxDrawdownPct != null ? fmtPct(s.avgMaxDrawdownPct) : 'N/A'}</td>
          <td>${s.winRateVsSpyPct != null ? s.winRateVsSpyPct + '%' : 'N/A'}</td>
        </tr>`).join('')
      : `<tr><td colspan="6" style="color:var(--text3)">还没有已复核的数据，先扫描积累信号，再点上方"复核到期信号"</td></tr>`;
  } catch (e) {
    $('#tblSignalPerformance tbody').innerHTML = `<tr><td colspan="6" style="color:var(--text3)">本地数据库尚未初始化或不可用: ${e.message}</td></tr>`;
  }
}

function initSignalsPage() {
  $('#btnSignalPendingCheck').addEventListener('click', async () => {
    const box = $('#signalPendingStatus');
    try {
      const p = await SignalTracking.getPendingCount();
      box.textContent = `信号历史累计 ${p.totalSignals} 条 · 已算出前瞻收益 ${p.totalReturns} 条 · 预计还有约 ${p.pendingOrNotYetDue} 条待到期/待复核`;
    } catch (e) { box.textContent = '查询失败: ' + e.message; }
  });
  $('#btnSignalReview').addEventListener('click', async () => {
    const progressBox = $('#signalReviewProgress');
    progressBox.textContent = '复核中...';
    try {
      const r = await SignalTracking.reviewPendingSignals(undefined, (done, total, horizon) => {
        progressBox.textContent = `持有期${horizon}日: ${done}/${total}`;
      });
      progressBox.textContent = `✓ 完成，本次新算出 ${r.totalComputed} 条前瞻收益，跳过(未到期或获取失败) ${r.totalSkipped} 条`;
      renderSignalPerformanceTable();
    } catch (e) { progressBox.textContent = '✗ 复核失败: ' + e.message; }
  });
  renderSignalPerformanceTable();
}

// ---------------------------------------------------------------------------
// 设置页面
// ---------------------------------------------------------------------------
function initSettingsPage() {
  const cred = AlpacaClient.getCredentials();
  $('#setAlpacaKeyId').value = cred.keyId;
  $('#setAlpacaSecret').value = cred.secret;
  $('#setAlpacaEnv').value = cred.paper ? 'paper' : 'live';
  $('#setFinnhubKey').value = Fundamentals.getKey();
  const nc = Notify.getConfig();
  $('#setTgToken').value = nc.telegramToken; $('#setTgChat').value = nc.telegramChatId;
  $('#setDiscordUrl').value = nc.discordWebhook; $('#setFeishuUrl').value = nc.feishuWebhook;
  $('#setCloudBase').value = CloudSync.getBaseUrl();

  $('#btnSaveAlpaca').addEventListener('click', () => {
    const isPaper = $('#setAlpacaEnv').value === 'paper';
    AlpacaClient.saveCredentials($('#setAlpacaKeyId').value.trim(), $('#setAlpacaSecret').value.trim(), isPaper);
    alert('已保存');
  });
  $('#btnTestAlpaca').addEventListener('click', async () => {
    $('#alpacaTestResult').textContent = '测试中...';
    const r = await AlpacaClient.testConnection();
    $('#alpacaTestResult').textContent = r.ok ? `✓ 连接成功 (账户状态: ${r.accountStatus})` : `✗ 失败: ${r.error}`;
  });
  $('#btnSaveFinnhub').addEventListener('click', () => { Fundamentals.saveKey($('#setFinnhubKey').value.trim()); alert('已保存'); });
  $('#btnSaveNotify').addEventListener('click', () => {
    Notify.saveConfig({ telegramToken: $('#setTgToken').value.trim(), telegramChatId: $('#setTgChat').value.trim(), discordWebhook: $('#setDiscordUrl').value.trim(), feishuWebhook: $('#setFeishuUrl').value.trim() });
    alert('已保存');
  });
  $('#btnTestNotify').addEventListener('click', async () => {
    const r = await Notify.sendAll(`✅ VectorAlpha 测试消息 · ${new Date().toLocaleString('zh-CN')}`);
    alert('发送结果: ' + JSON.stringify(r));
  });
  $('#btnSaveCloud').addEventListener('click', () => { CloudSync.saveBaseUrl($('#setCloudBase').value.trim()); alert('已保存'); });

  // 全市场RS基准池状态 + 手动刷新（2026-07 新增，见 rsBenchmark.js）
  // 注意：这个页面(和其他所有页面)只在应用启动时init一次，之后切标签页只是
  // CSS层面的显示/隐藏，不会重新执行这段代码——如果只在这里设一次文本，
  // 用户在「设置」页之前跑过的扫描会静默建立好基准池，但这里还是显示"尚未建立"，
  // 容易误导用户以为没生效。所以额外给"设置"这个tab按钮加一个点击监听，
  // 每次点进「设置」页都重新读一次最新状态。
  $('#rsBenchmarkStatus').textContent = RSBenchmark.getStatusText();
  document.querySelector('.tab-btn[data-page="settings"]')?.addEventListener('click', () => {
    $('#rsBenchmarkStatus').textContent = RSBenchmark.getStatusText();
  });
  $('#btnRefreshRsBenchmark').addEventListener('click', async () => {
    $('#rsBenchmarkStatus').textContent = '正在重新构建基准池，样本约700~900只，可能需要几十秒...';
    try {
      await RSBenchmark.forceRebuild(null);
      $('#rsBenchmarkStatus').textContent = RSBenchmark.getStatusText();
    } catch (e) {
      $('#rsBenchmarkStatus').textContent = `✗ 构建失败: ${e.message}（不影响正常扫描，会自动回退为样本内百分位）`;
    }
  });

  initDbAndMasterUniverseSettings();
}

// ---------------------------------------------------------------------------
// 本地数据库(SQLite) + Master Universe 同步（V2 第八/第二阶段新增）
// ---------------------------------------------------------------------------
async function refreshDbStatus() {
  const box = $('#dbStatusBox');
  try {
    await VADB.init();
    const counts = VADB.getTableCounts();
    box.innerHTML = `✓ 数据库已就绪 · ` + Object.entries(counts).map(([t, c]) => `${t}: ${c}行`).join(' · ');
  } catch (e) {
    box.innerHTML = `✗ 数据库初始化失败: ${e.message}（可能是sql.js的CDN不可达/被拦截，不影响其它核心功能，只是Universe Builder/信号跟踪/快照这几个新功能会不可用）`;
  }
}
async function refreshMasterUniverseStatus() {
  const box = $('#masterUniverseStatus');
  try {
    await VADB.init();
    const stats = MasterUniverseSync.getCoverageStats();
    if (!stats || !stats.total) { box.textContent = 'master_universe 表目前是空的，请先点击"全量同步"或者去「扫描」页跑一次扫描（扫描结果会自动写入部分字段）'; return; }
    box.innerHTML = `共 ${stats.total} 条记录 · 字段覆盖率：` + Object.entries(stats.coverage).map(([f, c]) => `${f} ${c.pct}%(${c.known}/${stats.total})`).join(' · ');
  } catch (e) {
    box.textContent = '获取状态失败: ' + e.message;
  }
}
function initDbAndMasterUniverseSettings() {
  $('#btnDbStatus').addEventListener('click', refreshDbStatus);
  $('#btnDbExport').addEventListener('click', async () => {
    try {
      await VADB.init();
      const blob = VADB.exportDatabase();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `vectoralpha_${new Date().toISOString().slice(0, 10)}.sqlite`;
      a.click(); URL.revokeObjectURL(url);
    } catch (e) { alert('导出失败: ' + e.message); }
  });
  $('#btnDbReset').addEventListener('click', async () => {
    if (!confirm('确定要清空本地数据库吗？Master Universe/信号历史/快照/构建器保存的查询 全部会被删除，且无法恢复。')) return;
    try {
      await VADB.resetDatabase();
      alert('已重置');
      refreshDbStatus();
    } catch (e) { alert('重置失败: ' + e.message); }
  });
  $('#btnMasterUniverseStatus').addEventListener('click', refreshMasterUniverseStatus);
  $('#btnMasterUniverseSync').addEventListener('click', async () => {
    const box = $('#masterUniverseStatus');
    box.textContent = '同步中...（Alpaca全市场资产列表通常上万条，可能需要一段时间）';
    try {
      const r = await MasterUniverseSync.syncTradableAssets();
      box.textContent = `✓ 已同步 ${r.total} 条资产记录（来源: ${r.source}，只有基础字段，评分类字段会随扫描逐步补全）`;
    } catch (e) {
      box.textContent = '✗ 同步失败: ' + e.message;
    }
  });
  refreshDbStatus();
}

// ---------------------------------------------------------------------------
// 总览页面
// ---------------------------------------------------------------------------
function initDashboard() {
  $('#btnLoadMarket').addEventListener('click', async () => {
    $('#marketRegimeBox').textContent = '加载中...';
    try {
      const m = await MarketContext.getMarketRegime(null);
      $('#marketRegimeBox').innerHTML = m.available
        ? `<div style="color:${m.trendUp ? 'var(--green)' : 'var(--amber)'};font-weight:700">${m.label}</div><div class="hint">评分 ${m.score} · SPY $${fmtNum(m.price)} · 50MA $${fmtNum(m.sma50)} · 200MA $${fmtNum(m.sma200)}</div>`
        : `<div class="hint">数据不可用: ${m.note || m.error}</div>`;
    } catch (e) { $('#marketRegimeBox').textContent = '获取失败: ' + e.message; }
  });
}

// ---------------------------------------------------------------------------
// 帮助页面
// ---------------------------------------------------------------------------
function initHelpPage() {
  $('#helpContent').innerHTML = `<div class="help-content">${HELP_HTML}</div>`;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
function init() {
  initTabs();
  initDashboard();
  initUniversePage();
  restoreCurrentPool(); // 恢复上次载入的"当前扫描池"（防止刷新页面后数据丢失）
  initScanPage();
  initDerivedPage();
  initHistoryPage();
  initRiskPage();
  initWatchlistPage();
  initCloudPage();
  initBuilderPage();
  initStatsPage();
  initSignalsPage();
  initSettingsPage();
  initHelpPage();
  // 本地SQLite数据库(V2新增)在后台异步初始化，不阻塞页面其它部分渲染；
  // 失败(比如sql.js的CDN不可达)只会静默记录到控制台，Builder/信号跟踪/快照
  // 这几个新功能会在用户实际点击时看到明确的错误提示，不影响核心扫描功能。
  VADB.init().catch(e => console.warn('[VADB] 启动时初始化本地数据库失败: ' + e.message));
  log('系统就绪。请先在「设置」页配置 Alpaca API Key。', 'info');
}

window.addEventListener('DOMContentLoaded', init);
