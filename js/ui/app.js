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
import { Notify } from '../core/notify.js';
import { CloudSync } from '../core/cloudSync.js';
import { MarketContext } from '../signals/marketContext.js';
import { AlpacaClient } from '../data/alpacaClient.js';
import { Fundamentals } from '../data/fundamentals.js';
import { HELP_HTML } from './helpContent.js';

const STATE = {
  currentPoolSymbols: [],
  lastScanResult: null,
  lastHistoryBatch: null,
  scanning: false,
  stopRequested: false,
};

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
    STATE.currentPoolSymbols = symbols;
    $('#currentPoolBox').value = symbols.join(', ');
    $('#currentPoolCount').textContent = symbols.length;
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
    STATE.currentPoolSymbols = symbols;
    $('#currentPoolBox').value = symbols.join(', ');
    $('#currentPoolCount').textContent = symbols.length;
    log(`✓ 已载入自定义列表 ${symbols.length} 只`, 'ok');
  });
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
  html += `<div class="hint">价格 $${fmtNum(r.price)} · 数据日期 ${r.effectiveDate || r.requestedDate || ''} · 数据源(日线/小时线): ${r.dataSource?.daily}/${r.dataSource?.hourly}</div>`;

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
    html += `<b>CANSLIM</b>（评分 ${inst.canslim.score ?? 'N/A'}，样本 ${inst.canslim.sampleSize}/${inst.canslim.totalItems} 项可用）<ul class="detail-list">`;
    html += inst.canslim.detail.map(d => `<li><span class="ck">${d.available ? tagHtml(d.pass) : '<span class="tag tag-na">不可用</span>'}</span><div>[${d.key}] ${d.label}${d.note ? ' · ' + d.note : ''}</div></li>`).join('');
    html += `</ul>`;
  }
  if (inst.rs) html += `<div class="hint">RS 相对强度百分位（样本内）：${inst.rs.percentile ?? 'N/A'}</div>`;

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
    { key: 'canslim', name: 'CANSLIM Candidates', metric: r => `评分 ${r.institutional.canslim.score}` },
    { key: 'minervini', name: 'Minervini Candidates', metric: r => `RS ${r.institutional.rs.percentile}` },
  ];
  const box = $('#derivedPoolsBox');
  box.innerHTML = meta.map(m => {
    const list = pools[m.key] || [];
    return `<div class="card mt12"><div class="card-h">${m.name} <span class="badge">${list.length}</span></div>
      ${list.length ? `<div class="hint">${list.slice(0, 30).map(r => `${r.sym}(${m.metric(r)})`).join(' · ')}</div>` : '<div class="hint">本次扫描样本中暂无符合条件的股票</div>'}
    </div>`;
  }).join('');
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
    const cfg = {
      equity: Number($('#rmEquity').value), riskPct: Number($('#rmRiskPct').value),
      maxPosPct: Number($('#rmMaxPos').value), stopMode: $('#rmStopMode').value,
    };
    const wb = RiskWorkbench.buildWorkbench(ranked, cfg);
    renderWorkbenchTable(wb);
  });
  $('#btnReviewHoldings').addEventListener('click', reviewHoldings);
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
  $('#tblWorkbench thead').innerHTML = `<tr><th>代码</th><th>现价</th><th>止损价</th><th>止损%</th><th>止盈价</th><th>建议股数</th><th>占用资金</th><th>风险金额</th><th>状态</th></tr>`;
  $('#tblWorkbench tbody').innerHTML = wb.rows.map(r => `<tr>
    <td>${r.sym}</td><td>$${fmtNum(r.price)}</td><td>${r.ok ? '$' + fmtNum(r.stopPrice) : '-'}</td>
    <td>${r.ok ? fmtPct(r.stopPct) : '-'}</td><td>${r.ok ? '$' + fmtNum(r.targetPrice) : '-'}</td>
    <td>${r.ok ? r.shares : '-'}</td><td>${r.ok ? '$' + r.capitalNeeded : '-'}</td><td>${r.ok ? '$' + r.riskAmount : '-'}</td>
    <td>${r.ok ? (r.capped ? '已按上限缩减' : '正常') : r.reason}</td>
  </tr>`).join('') + `<tr><td colspan="9" style="color:var(--green)">已分配资金 $${wb.allocatedCapital} / 剩余 $${wb.remainingCapital}（账户总资产 $${wb.equity}）</td></tr>`;
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
// 设置页面
// ---------------------------------------------------------------------------
function initSettingsPage() {
  const cred = AlpacaClient.getCredentials();
  $('#setAlpacaKeyId').value = cred.keyId;
  $('#setAlpacaSecret').value = cred.secret;
  $('#setFinnhubKey').value = Fundamentals.getKey();
  const nc = Notify.getConfig();
  $('#setTgToken').value = nc.telegramToken; $('#setTgChat').value = nc.telegramChatId;
  $('#setDiscordUrl').value = nc.discordWebhook; $('#setFeishuUrl').value = nc.feishuWebhook;
  $('#setCloudBase').value = CloudSync.getBaseUrl();

  $('#btnSaveAlpaca').addEventListener('click', () => {
    AlpacaClient.saveCredentials($('#setAlpacaKeyId').value.trim(), $('#setAlpacaSecret').value.trim());
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
  initScanPage();
  initDerivedPage();
  initHistoryPage();
  initRiskPage();
  initWatchlistPage();
  initCloudPage();
  initSettingsPage();
  initHelpPage();
  log('系统就绪。请先在「设置」页配置 Alpaca API Key。', 'info');
}

window.addEventListener('DOMContentLoaded', init);
