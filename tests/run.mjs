#!/usr/bin/env node
/**
 * ============================================================================
 * 核心指标 + 评分逻辑 单元测试 (2026-07 新增)
 * ----------------------------------------------------------------------------
 * 背景：项目一直只有"语法检查"，没有真正验证过指标/评分的计算结果对不对——
 * 评审明确指出这是个缺口："以后改一个指标，很容易静默影响全部扫描结果"。
 * 这里补上核心指标(SMA/RSI/MACD/ATR/百分位)和"分层组合评分"的已知样本测试，
 * 尤其是今天(2026-07)修的几个bug都配了回归测试，防止以后不小心改回去：
 *   - 行业层关闭时不再强制给中性50分（之前的真实bug）
 *   - 板块映射表能查到已知股票、查不到的返回null（不是瞎猜）
 *   - 风控工作台的单行业仓位上限真正生效（之前从来没生效过）
 *
 * 不依赖任何测试框架(没有npm install的前提下也能跑)，只用Node内置的
 * assert模块 + 一个几十行的极简测试收集器。
 *
 * 本地怎么跑：node tests/run.mjs
 * 更推荐：交给 .github/workflows/tests.yml，每次push到GitHub都会自动跑一遍，
 * 你不需要本地装Node环境——在GitHub仓库的"Actions"标签页就能看到红勾/绿勾。
 * ============================================================================
 */
import assert from 'node:assert/strict';
import { Indicators } from '../js/core/indicators.js';
import { Timeframe } from '../js/core/timeframe.js';
import { CompositeScore } from '../js/signals/compositeScore.js';
import { InstitutionalEngine } from '../js/signals/institutional.js';
import { getSectorForSymbol } from '../js/data/sectorMap.js';
import { RiskWorkbench } from '../js/core/riskWorkbench.js';
import { INDUSTRY_LEADERS, GROWTH_THEMES, getThemeForSymbol } from '../js/data/symbolLists.js';
import { CATEGORY_TO_SECTOR_ETF } from '../js/data/sectorMap.js';
// ---- V2 新增模块 ----
import { buildWhereClause, FIELD_DEFS } from '../js/core/universeBuilder.js';
import { UniverseOps } from '../js/core/universeOps.js';
import { UniverseStats } from '../js/core/universeStats.js';
import { RiskAnalytics } from '../js/core/riskAnalytics.js';
import { computeReturnMetrics } from '../js/core/signalTracking.js';
import { computeGrowthScore, computeMomentumScore } from '../js/signals/derivedScores.js';
import { SCHEMA_SQL_FOR_TEST } from '../js/core/db.js';

let pass = 0, fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
  }
}

function makeBar(t, c, extra = {}) { return { t, o: c, h: c + 0.5, l: c - 0.5, c, v: 1000, ...extra }; }

// ============================================================================
console.log('\n[1] Indicators — 核心技术指标（已知样本验证）');
// ============================================================================

test('sma: 已知样本 [1,2,3,4,5] period=3', () => {
  const out = Indicators.sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out, [null, null, 2, 3, 4]);
});

test('sma: 数据不足时全部返回null', () => {
  const out = Indicators.sma([1, 2], 5);
  assert.deepEqual(out, [null, null]);
});

test('rsi: 连续上涨(无下跌)应该趋近100', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i); // 100,101,...,119 纯上涨
  const out = Indicators.rsi(closes, 14);
  assert.equal(out[14], 100); // period内avgLoss=0 -> RSI=100
  assert.equal(out[19], 100);
});

test('rsi: 连续下跌应该趋近0', () => {
  const closes = Array.from({ length: 20 }, (_, i) => 200 - i);
  const out = Indicators.rsi(closes, 14);
  assert.equal(out[14], 0); // avgGain=0 -> RSI=0
});

test('macd: hist = macdLine - signalLine（逐点核对，不只是形状检查）', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.3);
  const { macdLine, signalLine, hist } = Indicators.macd(closes);
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] != null && signalLine[i] != null) {
      assert.ok(Math.abs(hist[i] - (macdLine[i] - signalLine[i])) < 1e-9, `index ${i} hist不等于macd-signal`);
    } else {
      assert.equal(hist[i], null);
    }
  }
});

test('atr: 手工构造样本核对第一个输出值', () => {
  // 4根bar，period=3：TR分别为 h-l=2,2,2,2；第3个索引(period-1=2)时 out=前3个TR均值=2
  const high = [10, 10, 10, 10], low = [8, 8, 8, 8], close = [9, 9, 9, 9];
  const out = Indicators.atr(high, low, close, 3);
  assert.equal(out[2], 2);
  assert.equal(out[0], null); // period不够时为null（除了tr数组本身，atr的out在period-1之前都是null）
});

test('highN/lowN: 不含未来数据(endIdx之后的bar不应该被看到)', () => {
  const high = [10, 20, 30, 5, 1];
  // endIdx=2 时只看 high[0..2]=[10,20,30]，看不到后面的5和1
  assert.equal(Indicators.highN(high, 3, 2), 30);
  const low = [10, 20, 3, 50, 1];
  assert.equal(Indicators.lowN(low, 3, 2), 3);
});

test('percentileRank: 已知有序数组', () => {
  const sorted = [10, 20, 30, 40, 50];
  assert.equal(Indicators.percentileRank(30, sorted), 50); // idx=2 -> 2/4*100=50
  assert.equal(Indicators.percentileRank(50, sorted), 100);
  assert.equal(Indicators.percentileRank(5, sorted), 0);
  assert.equal(Indicators.percentileRank(100, []), null); // 空数组
});

// ============================================================================
console.log('\n[2] Timeframe — 周期转换 / 历史日期截断');
// ============================================================================

test('truncateByDate: 截断到指定日期，且不包含之后的数据', () => {
  const bars = [
    makeBar('2026-01-05T20:00:00Z', 100),
    makeBar('2026-01-06T20:00:00Z', 101),
    makeBar('2026-01-07T20:00:00Z', 102),
    makeBar('2026-01-08T20:00:00Z', 103),
  ];
  const { bars: trunc, effectiveDate, isNonTradingDay } = Timeframe.truncateByDate(bars, '2026-01-06');
  assert.equal(trunc.length, 2);
  assert.equal(effectiveDate, '2026-01-06');
  assert.equal(isNonTradingDay, false);
});

test('truncateByDate: 非交易日(周末)自动回退到最近交易日，并标注isNonTradingDay', () => {
  const bars = [
    makeBar('2026-01-02T20:00:00Z', 100), // 周五
    makeBar('2026-01-05T20:00:00Z', 101), // 周一
  ];
  // 2026-01-03/04 是周末，没有bar；请求周六(01-03)应该回退到01-02
  const { bars: trunc, effectiveDate, isNonTradingDay } = Timeframe.truncateByDate(bars, '2026-01-03');
  assert.equal(effectiveDate, '2026-01-02');
  assert.equal(isNonTradingDay, true);
  assert.equal(trunc.length, 1);
});

test('truncateByDate: 请求日期早于所有数据时返回空+错误标注', () => {
  const bars = [makeBar('2026-01-05T20:00:00Z', 100)];
  const { bars: trunc, error } = Timeframe.truncateByDate(bars, '2020-01-01');
  assert.equal(trunc.length, 0);
  assert.ok(error);
});

test('aggregateWeekly: 同一周的多根日线正确聚合成一根周线(O=第一天开盘,C=最后一天收盘,H/L=区间最值)', () => {
  // 2026-01-05(周一) ~ 2026-01-09(周五) 是同一周
  const bars = [
    { t: '2026-01-05T20:00:00Z', o: 100, h: 105, l: 99, c: 102, v: 1000 },
    { t: '2026-01-06T20:00:00Z', o: 102, h: 110, l: 101, c: 108, v: 1000 },
    { t: '2026-01-09T20:00:00Z', o: 108, h: 109, l: 95, c: 106, v: 1000 },
  ];
  const weekly = Timeframe.aggregateWeekly(bars);
  assert.equal(weekly.length, 1);
  assert.equal(weekly[0].o, 100); // 周一开盘
  assert.equal(weekly[0].c, 106); // 周五收盘
  assert.equal(weekly[0].h, 110); // 区间最高
  assert.equal(weekly[0].l, 95);  // 区间最低
  assert.equal(weekly[0].v, 3000); // 成交量求和
});

// ============================================================================
console.log('\n[3] CompositeScore — 分层组合评分（含 2026-07 行业层修复的回归测试）');
// ============================================================================

const FULL_RESONANCE = { passCount: 3, totalChecked: 3 };
const FULL_INSTITUTIONAL = { minervini: { score: 80 }, weinstein: { stage: 2 }, canslim: { score: 70 }, rs: { percentile: 90 } };

test('回归测试(关键)：行业层关闭时不应该强制给50分参与加权', () => {
  // 构造两组完全相同的输入，唯一区别是 sectorEnabled，对比总分是否真的不一样
  // (如果bug还在，sectorEnabled=false时sector会被强制塞50分，改变总分)
  const withoutSector = CompositeScore.compute({
    marketScore: 80, sectorScore: null, sectorEnabled: false,
    resonance: FULL_RESONANCE, institutional: FULL_INSTITUTIONAL, quality: { available: true, score: 90 },
  });
  // 手算：market(15%) resonance(35%) institutional(30%) quality(10%) 四层可用，sector被排除，权重按比例重分配
  // 可用层权重和 = 0.15+0.35+0.30+0.10 = 0.90
  const instScore = Math.round((80 + 100 + 70 + 90) / 4); // minervini+weinstein(stage2=100)+canslim+rs 均值
  const resonanceScore = 100; // 3/3通过
  const expected = Math.round((80 * 0.15 + resonanceScore * 0.35 + instScore * 0.30 + 90 * 0.10) / 0.90);
  assert.equal(withoutSector.score, expected);
  // 断言breakdown里sector层明确标注不可用，而不是"可用且=50"
  const sectorLayer = withoutSector.breakdown.find(b => b.layer === 'sector');
  assert.equal(sectorLayer.available, false);
  assert.equal(sectorLayer.score, null);
});

test('sectorEnabled=true 且有真实sectorScore时，行业层应该真正参与加权（不是恒定50或恒定不可用）', () => {
  const withSector = CompositeScore.compute({
    marketScore: 80, sectorScore: 20, sectorEnabled: true, // 故意给一个明显不是50的值，验证真的被用上了
    resonance: FULL_RESONANCE, institutional: FULL_INSTITUTIONAL, quality: { available: true, score: 90 },
  });
  const sectorLayer = withSector.breakdown.find(b => b.layer === 'sector');
  assert.equal(sectorLayer.available, true);
  assert.equal(sectorLayer.score, 20);
  // 五层全部可用时权重不重分配，sector应该正好是15%配置的10%权重
  assert.equal(sectorLayer.weight, 10);
});

test('quality层不可用时权重按比例分给其他层，且不会拖累总分(不是当0分)', () => {
  const result = CompositeScore.compute({
    marketScore: 80, sectorScore: null, sectorEnabled: false,
    resonance: FULL_RESONANCE, institutional: FULL_INSTITUTIONAL, quality: { available: false, score: null },
  });
  const qualityLayer = result.breakdown.find(b => b.layer === 'quality');
  assert.equal(qualityLayer.available, false);
  assert.equal(qualityLayer.contribution, 0);
  // 其余可用层的权重之和应该等于100%
  const totalWeight = result.breakdown.filter(b => b.available).reduce((s, b) => s + b.weight, 0);
  assert.ok(Math.abs(totalWeight - 100) < 0.2, `权重之和应≈100%，实际=${totalWeight}`);
});

test('所有层都不可用时返回null分数而不是抛错或返回0', () => {
  const result = CompositeScore.compute({
    marketScore: null, sectorScore: null, sectorEnabled: false,
    resonance: null, institutional: {}, quality: { available: false, score: null },
  });
  assert.equal(result.score, null);
});

// ============================================================================
console.log('\n[4] Institutional — CANSLIM 数据覆盖率/置信度标注（2026-07 新增）');
// ============================================================================

test('CANSLIM: 基本面数据完全缺失时置信度应为Low(可用维度少)', () => {
  const ctx = { price: 100, high52w: 105, avgVol50: 1000, volNow: 1200, vol10: 900 };
  const fund = { available: false }; // 没有Finnhub Key
  const result = InstitutionalEngine.canslim(ctx, fund, 85, true); // rsPercentile=85, market上升
  // 没有C/A/I，只剩N/S/L/M最多4项可用
  assert.ok(result.sampleSize <= 4);
  assert.equal(result.confidence, result.sampleSize >= 6 ? 'High' : result.sampleSize >= 4 ? 'Medium' : 'Low');
  assert.ok(result.coverage.includes('/7'));
});

test('CANSLIM: 基本面数据完整 + RS + 市场方向都可用时置信度应为High', () => {
  const ctx = { price: 100, high52w: 102, avgVol50: 1000, volNow: 1500, vol10: 800 };
  const fund = { available: true, growth: { epsGrowthTTM: 30, revenueGrowthTTM: 20 } };
  const result = InstitutionalEngine.canslim(ctx, fund, 85, true);
  // C/A/N/S/L/M 六项应该都可用(I恒定不可用)
  assert.equal(result.sampleSize, 6);
  assert.equal(result.confidence, 'High');
});

// ============================================================================
console.log('\n[5] SectorMap — 板块归属映射（覆盖完整性 + 查不到返回null）');
// ============================================================================

test('已知股票(NVDA)能查到板块归属', () => {
  assert.equal(getSectorForSymbol('NVDA'), 'XLK');
});

test('查不到的股票返回null，不是瞎猜一个板块', () => {
  assert.equal(getSectorForSymbol('ZZZZ_NOT_A_REAL_TICKER'), null);
});

test('完整性检查：INDUSTRY_LEADERS里的每个行业分类，CATEGORY_TO_SECTOR_ETF里都要有对应映射', () => {
  const missing = Object.keys(INDUSTRY_LEADERS).filter(cat => !CATEGORY_TO_SECTOR_ETF[cat]);
  assert.deepEqual(missing, [], `以下行业分类在sectorMap.js里没有映射(很可能是两个文件的分类名拼写不一致): ${missing.join(', ')}`);
});

// ============================================================================
console.log('\n[6] RiskWorkbench — 仓位建议 / 单行业仓位上限（2026-07 新增，真正生效）');
// ============================================================================

function makeFakeResult(sym, sectorEtf, score, price = 100) {
  return {
    sym, sectorEtf, price,
    composite: { score },
    raw: { recentLow3: price - 5, atrNow: 2, recentHigh22: price + 5 },
  };
}

test('单行业仓位上限：同一行业的多只股票，总分配资金不应超过 equity*maxSectorPct%', () => {
  // 6只全部属于XLK(半导体/AI)，评分从高到低，equity=100000, maxSectorPct=20% => 行业上限=20000
  const rows = [
    makeFakeResult('NVDA', 'XLK', 95, 100),
    makeFakeResult('AMD', 'XLK', 92, 100),
    makeFakeResult('AVGO', 'XLK', 90, 100),
    makeFakeResult('ARM', 'XLK', 88, 100),
    makeFakeResult('MU', 'XLK', 85, 100),
    makeFakeResult('SMCI', 'XLK', 82, 100),
  ];
  const wb = RiskWorkbench.buildWorkbench(rows, {
    equity: 100000, riskPct: 5, maxPosPct: 50, maxSectorPct: 20, stopMode: 'structural',
  });
  const xlkAllocated = wb.sectorSummary.find(s => s.sectorEtf === 'XLK');
  assert.ok(xlkAllocated, '应该有XLK的行业汇总记录');
  assert.ok(xlkAllocated.allocated <= 20000 + 1, `XLK分配资金 ${xlkAllocated.allocated} 不应超过上限20000`); // +1容差舍入
});

test('未设置maxSectorPct(null)时，不应该限制行业集中度(向后兼容旧行为)', () => {
  const rows = [
    makeFakeResult('NVDA', 'XLK', 95, 100),
    makeFakeResult('AMD', 'XLK', 92, 100),
  ];
  const wb = RiskWorkbench.buildWorkbench(rows, {
    equity: 100000, riskPct: 5, maxPosPct: 50, maxSectorPct: null, stopMode: 'structural',
  });
  assert.equal(wb.rows.every(r => r.ok), true);
});

test('查不到板块归属(sectorEtf=null)的股票不受行业上限约束，但会标注sectorNote', () => {
  const rows = [makeFakeResult('UNKNOWNSYM', null, 90, 100)];
  const wb = RiskWorkbench.buildWorkbench(rows, {
    equity: 100000, riskPct: 5, maxPosPct: 50, maxSectorPct: 5, stopMode: 'structural',
  });
  assert.equal(wb.rows[0].ok, true);
  assert.ok(wb.rows[0].sectorNote && wb.rows[0].sectorNote.includes('未查到板块归属'));
});

// ============================================================================
console.log('\n[7] db.js — 数据库Schema完整性（V2 第八阶段，不依赖sql.js运行时也能核对表结构文本）');
// ============================================================================

test('SCHEMA_SQL 包含所有V2需要的核心表', () => {
  for (const table of ['master_universe', 'saved_builders', 'universe_snapshots', 'signal_history', 'signal_returns']) {
    assert.ok(SCHEMA_SQL_FOR_TEST.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `schema里缺少表: ${table}`);
  }
});

test('master_universe 表包含需求里明确点名的字段', () => {
  const required = ['market_cap', 'price', 'avg_volume', 'avg_dollar_volume', 'country', 'ipo_date', 'is_etf', 'is_adr', 'is_reit', 'dividend_yield', 'beta'];
  for (const field of required) {
    assert.ok(SCHEMA_SQL_FOR_TEST.includes(field), `master_universe schema里缺少字段: ${field}`);
  }
});

// ============================================================================
console.log('\n[8] Dynamic Universe Builder — 条件 -> SQL WHERE 子句翻译（V2 第一阶段）');
// ============================================================================

test('buildWhereClause: 空条件返回1=1(不限制)', () => {
  const { sql, params } = buildWhereClause([]);
  assert.equal(sql, '1=1');
  assert.deepEqual(params, []);
});

test('buildWhereClause: 单个数值大于条件', () => {
  const { sql, params } = buildWhereClause([{ field: 'market_cap', op: '>', value: 10e9 }]);
  assert.equal(sql, '(market_cap > ?)');
  assert.deepEqual(params, [10e9]);
});

test('buildWhereClause: 多条件AND组合，参数顺序与条件顺序一致', () => {
  const { sql, params } = buildWhereClause([
    { field: 'exchange', op: '=', value: 'NASDAQ' },
    { field: 'market_cap', op: '>', value: 10e9 },
    { field: 'rs_percentile', op: '>=', value: 80 },
  ], 'AND');
  assert.equal(sql, '(exchange = ?) AND (market_cap > ?) AND (rs_percentile >= ?)');
  assert.deepEqual(params, ['NASDAQ', 10e9, 80]);
});

test('buildWhereClause: OR模式正确拼接', () => {
  const { sql } = buildWhereClause([{ field: 'is_etf', op: 'is_true' }, { field: 'is_reit', op: 'is_true' }], 'OR');
  assert.equal(sql, '(is_etf = 1) OR (is_reit = 1)');
});

test('buildWhereClause: between需要value和value2', () => {
  const { sql, params } = buildWhereClause([{ field: 'price', op: 'between', value: 10, value2: 50 }]);
  assert.equal(sql, '(price BETWEEN ? AND ?)');
  assert.deepEqual(params, [10, 50]);
  assert.throws(() => buildWhereClause([{ field: 'price', op: 'between', value: 10 }]), /value2/);
});

test('buildWhereClause: in操作符支持数组和逗号分隔字符串两种输入', () => {
  const r1 = buildWhereClause([{ field: 'exchange', op: 'in', value: ['NASDAQ', 'NYSE'] }]);
  assert.equal(r1.sql, '(exchange IN (?,?))');
  assert.deepEqual(r1.params, ['NASDAQ', 'NYSE']);
  const r2 = buildWhereClause([{ field: 'exchange', op: 'in', value: 'NASDAQ, NYSE' }]);
  assert.deepEqual(r2.params, ['NASDAQ', 'NYSE']);
});

test('buildWhereClause: is_true/is_false不需要额外参数', () => {
  const { sql, params } = buildWhereClause([{ field: 'is_adr', op: 'is_false' }]);
  assert.equal(sql, '(is_adr = 0)');
  assert.deepEqual(params, []);
});

test('buildWhereClause: 未知字段名直接抛错(白名单保护，防SQL注入/拼写错误)', () => {
  assert.throws(() => buildWhereClause([{ field: 'DROP TABLE master_universe;--', op: '=', value: 1 }]), /未知的筛选字段/);
});

test('buildWhereClause: 字段不支持的操作符直接抛错', () => {
  assert.throws(() => buildWhereClause([{ field: 'is_etf', op: '>', value: 1 }]), /不支持操作符/);
});

test('FIELD_DEFS 覆盖需求里点名的所有筛选维度', () => {
  const required = ['exchange', 'market_cap', 'price', 'avg_dollar_volume', 'avg_volume', 'country', 'industry', 'sector', 'is_etf', 'is_adr', 'is_reit', 'ipo_age_days', 'dividend_yield', 'beta', 'rs_percentile', 'quality_score', 'momentum_score', 'growth_score', 'composite_score'];
  for (const f of required) assert.ok(FIELD_DEFS[f], `FIELD_DEFS里缺少字段: ${f}`);
});

// ============================================================================
console.log('\n[9] Universe Operations — 股票池集合运算（V2 第五阶段）');
// ============================================================================

test('union: 多个池子去重合并', () => {
  const r = UniverseOps.union(['AAPL', 'MSFT'], ['MSFT', 'NVDA'], ['aapl']); // 故意混大小写测试标准化
  assert.deepEqual(r, ['AAPL', 'MSFT', 'NVDA']);
});

test('merge是union的别名，结果一致', () => {
  assert.deepEqual(UniverseOps.merge(['A', 'B'], ['B', 'C']), UniverseOps.union(['A', 'B'], ['B', 'C']));
});

test('intersection: 只保留所有池子都出现的代码', () => {
  const r = UniverseOps.intersection(['AAPL', 'MSFT', 'NVDA'], ['MSFT', 'NVDA', 'AMD'], ['NVDA', 'MSFT']);
  assert.deepEqual(r.sort(), ['MSFT', 'NVDA']);
});

test('difference: A有B没有的部分', () => {
  const r = UniverseOps.difference(['AAPL', 'MSFT', 'NVDA'], ['MSFT']);
  assert.deepEqual(r, ['AAPL', 'NVDA']);
});

test('removeDuplicates: 保留首次出现顺序去重', () => {
  const r = UniverseOps.removeDuplicates(['NVDA', 'AMD', 'nvda', 'MSFT', 'AMD']);
  assert.deepEqual(r, ['NVDA', 'AMD', 'MSFT']);
});

test('sortBy: 按分数降序，缺失分数的排最后', () => {
  const r = UniverseOps.sortBy(['A', 'B', 'C'], { A: 50, C: 90 }, 'desc');
  assert.deepEqual(r, ['C', 'A', 'B']);
});

test('sortBy: 升序模式', () => {
  const r = UniverseOps.sortBy(['A', 'B'], { A: 50, B: 10 }, 'asc');
  assert.deepEqual(r, ['B', 'A']);
});

test('exportJSON / importJSON 往返一致', () => {
  const json = UniverseOps.exportJSON('测试池', ['NVDA', 'AMD']);
  const { name, symbols } = UniverseOps.importJSON(json);
  assert.equal(name, '测试池');
  assert.deepEqual(symbols, ['NVDA', 'AMD']);
});

test('importJSON: 非法JSON/缺少symbols字段时明确抛错', () => {
  assert.throws(() => UniverseOps.importJSON('not json'), /JSON/);
  assert.throws(() => UniverseOps.importJSON('{"name":"x"}'), /symbols/);
});

// ============================================================================
console.log('\n[10] Universe Statistics — 股票池统计（V2 第四阶段）');
// ============================================================================

function fakeScanResult(sym, score, rs, sectorEtf, atrNow = 2, volNow = 1e6, price = 100) {
  return { sym, isError: false, price, sectorEtf, composite: { score }, institutional: { rs: { percentile: rs } }, raw: { atrNow, volNow } };
}

test('fromScanResults: 多空分布阈值(>=70看多, <40看空, 其余中性)正确分类', () => {
  const results = [fakeScanResult('A', 80, 90, 'XLK'), fakeScanResult('B', 50, 50, 'XLK'), fakeScanResult('C', 30, 20, 'XLF'), fakeScanResult('D', null, null, null)];
  const s = UniverseStats.fromScanResults(results);
  assert.equal(s.total, 4);
  assert.equal(s.bullish, 1);
  assert.equal(s.neutral, 1);
  assert.equal(s.bearish, 1);
  assert.equal(s.scoreUnavailable, 1);
});

test('fromScanResults: 板块分布统计正确，未归类股票单独归入"未归类"', () => {
  const results = [fakeScanResult('A', 80, 90, 'XLK'), fakeScanResult('B', 70, 80, 'XLK'), fakeScanResult('C', 60, 60, null)];
  const s = UniverseStats.fromScanResults(results);
  const xlk = s.sectorDistribution.find(d => d.sector === 'XLK');
  const unclassified = s.sectorDistribution.find(d => d.sector === '未归类');
  assert.equal(xlk.count, 2);
  assert.equal(unclassified.count, 1);
});

test('fromScanResults: 空结果返回 total=0，不抛错', () => {
  assert.deepEqual(UniverseStats.fromScanResults([]), { total: 0 });
});

test('fromMasterUniverseRows: ETF/ADR/REIT计数与市值分桶', () => {
  const rows = [
    { symbol: 'SPY', is_etf: 1, is_adr: 0, is_reit: 0, market_cap: null, exchange: 'ARCA' },
    { symbol: 'NVDA', is_etf: 0, is_adr: 0, is_reit: 0, market_cap: 3e12, exchange: 'NASDAQ' },
    { symbol: 'PLD', is_etf: 0, is_adr: 0, is_reit: 1, market_cap: 100e9, exchange: 'NYSE' },
  ];
  const s = UniverseStats.fromMasterUniverseRows(rows);
  assert.equal(s.total, 3);
  assert.equal(s.etfCount, 1);
  assert.equal(s.reitCount, 1);
  const mega = s.marketCapDistribution.find(b => b.label === '>200B(巨型)');
  assert.equal(mega.count, 1); // NVDA 3万亿
});

// ============================================================================
console.log('\n[11] Risk Analytics — 组合风险分析（V2 第七阶段）');
// ============================================================================

test('computeOpenRisk: 已跌破止损的持仓风险按0计入(不倒扣)', () => {
  const positions = [
    { shares: 10, price: 100, stopPrice: 90 },  // 未跌破，风险=10*10=100
    { shares: 5, price: 80, stopPrice: 90 },    // 已跌破止损，risk按0算
  ];
  assert.equal(RiskAnalytics.computeOpenRisk(positions), 100);
});

test('computePortfolioHeat: Open Risk占净值百分比', () => {
  const positions = [{ shares: 10, price: 100, stopPrice: 90 }];
  assert.equal(RiskAnalytics.computePortfolioHeat(positions, 10000), 1); // 100/10000*100=1%
});

test('computeSectorExposure / computeThemeExposure: 按板块和主题汇总市值占比', () => {
  const positions = [
    { sym: 'NVDA', shares: 10, price: 100, sectorEtf: 'XLK' },
    { sym: 'AMD', shares: 10, price: 100, sectorEtf: 'XLK' },
    { sym: 'XOM', shares: 10, price: 100, sectorEtf: 'XLE' },
  ];
  const sectorExp = RiskAnalytics.computeSectorExposure(positions, 4000);
  const xlk = sectorExp.find(s => s.sector === 'XLK');
  assert.equal(xlk.value, 2000);
  assert.equal(xlk.pctOfEquity, 50);

  const themeExp = RiskAnalytics.computeThemeExposure(positions, 4000);
  const aiTheme = themeExp.find(t => t.theme.includes('AI'));
  assert.ok(aiTheme, 'NVDA/AMD应该被归入AI/半导体主题');
  assert.equal(aiTheme.value, 2000);
});

test('checkRiskBudget: 超过上限时返回明确的违规项', () => {
  const violations = RiskAnalytics.checkRiskBudget({
    openRisk: 700, equity: 10000, maxOpenRiskPct: 5, // heat=7% > 5%
    sectorExposure: [{ sector: 'XLK', pctOfEquity: 60 }], maxSectorRiskPct: 30,
    themeExposure: [], maxThemeRiskPct: null,
  });
  assert.equal(violations.length, 2);
  assert.ok(violations.some(v => v.type === 'openRisk'));
  assert.ok(violations.some(v => v.type === 'sector'));
});

test('checkRiskBudget: 全部合规时返回空数组', () => {
  const violations = RiskAnalytics.checkRiskBudget({
    openRisk: 200, equity: 10000, maxOpenRiskPct: 5,
    sectorExposure: [{ sector: 'XLK', pctOfEquity: 20 }], maxSectorRiskPct: 30,
  });
  assert.deepEqual(violations, []);
});

test('computeKellyFraction: 已知胜率/盈亏比手算验证', () => {
  // winRate=0.6, avgWin=10%, avgLoss=5% => payoffRatio=2 => f = 0.6 - 0.4/2 = 0.4
  const f = RiskAnalytics.computeKellyFraction({ winRate: 0.6, avgWinPct: 10, avgLossPct: 5 });
  assert.equal(f, 0.4);
});

test('computeKellyFraction: 期望值为负的策略应该算出负Kelly(调用方应视为0仓位)', () => {
  const f = RiskAnalytics.computeKellyFraction({ winRate: 0.3, avgWinPct: 5, avgLossPct: 10 });
  assert.ok(f < 0);
});

test('kellyPositionSize: 半Kelly + 单仓上限双重约束', () => {
  const r = RiskAnalytics.kellyPositionSize({ equity: 100000, kellyFraction: 0.4, kellyMultiplier: 0.5, maxPositionPct: 15 });
  // 0.4*0.5=0.2=20%，但maxPositionPct=15%封顶
  assert.equal(r.fraction, 15);
  assert.equal(r.capitalAmount, 15000);
});

test('volatilityPositionSizing: 波动率越高分配权重越低，权重和为1', () => {
  const candidates = [{ sym: 'LOW_VOL', atrPct: 1 }, { sym: 'HIGH_VOL', atrPct: 4 }];
  const r = RiskAnalytics.volatilityPositionSizing(candidates, 10000);
  const low = r.find(x => x.sym === 'LOW_VOL'), high = r.find(x => x.sym === 'HIGH_VOL');
  assert.ok(low.weight > high.weight, '低波动应该分配更高权重');
  const weightSum = r.reduce((s, x) => s + x.weight, 0);
  assert.ok(Math.abs(weightSum - 100) < 0.5);
});

test('riskParityWeights: 反比波动率近似，权重和为100%', () => {
  const r = RiskAnalytics.riskParityWeights([{ sym: 'A', volatilityPct: 2 }, { sym: 'B', volatilityPct: 2 }]);
  assert.equal(r[0].weight, 50); // 波动率相同 -> 权重相等
  assert.equal(r[1].weight, 50);
});

test('computeCorrelationMatrix + findHighCorrelationPairs: 完全相同的价格序列相关系数应为1', () => {
  const closeSeries = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5 + Math.sin(i / 3));
  const map = { A: closeSeries, B: closeSeries, C: closeSeries.map(v => 200 - v) }; // C与A/B完全负相关
  const corrResult = RiskAnalytics.computeCorrelationMatrix(map);
  const idxA = corrResult.symbols.indexOf('A'), idxB = corrResult.symbols.indexOf('B');
  assert.ok(Math.abs(corrResult.matrix[idxA][idxB] - 1) < 1e-6);
  const pairs = RiskAnalytics.findHighCorrelationPairs(corrResult, 0.9);
  assert.ok(pairs.some(p => (p.a === 'A' && p.b === 'B') || (p.a === 'B' && p.b === 'A')));
});

// ============================================================================
console.log('\n[12] Signal Tracking — 前瞻收益计算（V2 第九阶段）');
// ============================================================================

test('computeReturnMetrics: 数据不够(未到期)时返回null', () => {
  const r = computeReturnMetrics({ entryPrice: 100, futureCloses: [101, 102], horizonDays: 5 });
  assert.equal(r, null);
});

test('computeReturnMetrics: 已知序列手算验证前瞻收益/最大涨幅/最大回撤', () => {
  // entry=100，之后5天收盘: 105, 110, 95, 108, 102（horizon=5取第5天=102）
  const r = computeReturnMetrics({ entryPrice: 100, futureCloses: [105, 110, 95, 108, 102], horizonDays: 5 });
  assert.equal(r.forwardReturnPct, 2); // (102-100)/100*100=2%
  assert.equal(r.maxGainPct, 10); // 最高110 -> +10%
  assert.equal(r.maxDrawdownPct, -5); // 最低95 -> -5%
});

test('computeReturnMetrics: 附带SPY数据时正确计算是否跑赢SPY', () => {
  const r = computeReturnMetrics({
    entryPrice: 100, futureCloses: [100, 100, 100, 100, 110], horizonDays: 5, // 个股+10%
    spyEntryPrice: 100, spyFutureCloses: [100, 100, 100, 100, 105], // SPY+5%
  });
  assert.equal(r.forwardReturnPct, 10);
  assert.equal(r.spyReturnPct, 5);
  assert.equal(r.beatSpy, true);
});

test('computeReturnMetrics: entryPrice缺失或<=0时返回null，不产生NaN/Infinity', () => {
  assert.equal(computeReturnMetrics({ entryPrice: null, futureCloses: [1, 2, 3], horizonDays: 2 }), null);
  assert.equal(computeReturnMetrics({ entryPrice: 0, futureCloses: [1, 2, 3], horizonDays: 2 }), null);
});

// ============================================================================
console.log('\n[13] Indicators新增 — Beta / Correlation（V2 第一/第七阶段）');
// ============================================================================

test('computeBeta: 完全同步涨跌(同样的收益率序列)beta应该为1', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.001, i) + Math.sin(i / 4));
  const beta = Indicators.computeBeta(closes, closes);
  assert.ok(Math.abs(beta - 1) < 0.01);
});

test('computeBeta: 波动是基准两倍的资产，beta应该接近2', () => {
  const bench = Array.from({ length: 60 }, () => 100);
  const benchRet = []; let p = 100;
  const benchClose = [100]; const symClose = [100];
  for (let i = 1; i < 60; i++) {
    const r = Math.sin(i / 5) * 0.01; // 基准每天的收益率
    benchClose.push(benchClose[i - 1] * (1 + r));
    symClose.push(symClose[i - 1] * (1 + r * 2)); // 个股收益率恒为基准的2倍
  }
  const beta = Indicators.computeBeta(symClose, benchClose);
  assert.ok(Math.abs(beta - 2) < 0.05, `beta应该接近2，实际=${beta}`);
});

test('computeBeta: 数据不足(少于30个交易日)返回null', () => {
  assert.equal(Indicators.computeBeta([100, 101, 102], [100, 101, 102]), null);
});

test('computeCorrelation: 完全相同序列相关系数为1，逐日收益率完全相反的序列相关系数为-1', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i + Math.sin(i / 3) * 5);
  assert.ok(Math.abs(Indicators.computeCorrelation(closes, closes) - 1) < 1e-6);
  // 构造一个"每日收益率恰好是closes相反数"的序列(不是简单的价格镜像，价格镜像的收益率
  // 并不是原序列收益率的相反数，因为分母(前一日价格)不同，会导致相关系数不精确等于-1)
  const retA = Indicators.dailyReturns(closes);
  const inverseClose = [100];
  for (const r of retA) inverseClose.push(inverseClose[inverseClose.length - 1] * (1 - r));
  assert.ok(Math.abs(Indicators.computeCorrelation(closes, inverseClose) - (-1)) < 1e-6);
});

test('dailyReturns: 长度比输入少1，已知样本验证', () => {
  assert.deepEqual(Indicators.dailyReturns([100, 110, 99]), [0.1, -0.1]);
});

// ============================================================================
console.log('\n[14] Derived Scores — Growth/Momentum Score（V2 第一阶段）');
// ============================================================================

test('computeGrowthScore: 基本面不可用时返回null', () => {
  assert.equal(computeGrowthScore({ available: false }), null);
});

test('computeGrowthScore: 高增速应该打高分', () => {
  const r = computeGrowthScore({ available: true, growth: { revenueGrowthTTM: 40, epsGrowthTTM: 40, epsGrowth5Y: 30 } });
  assert.equal(r.score, 100);
});

test('computeMomentumScore: 均线多头排列+RS高+放量 应该打高分', () => {
  const r = computeMomentumScore({ sma50Now: 110, sma150Now: 100, sma200Now: 90, volNow: 2000, avgVol50: 1000 }, 95);
  assert.ok(r.score >= 90);
});

test('computeMomentumScore: 均线空头排列+RS低 应该打低分', () => {
  const r = computeMomentumScore({ sma50Now: 90, sma150Now: 100, sma200Now: 110, volNow: 500, avgVol50: 1000 }, 10);
  assert.ok(r.score <= 20);
});

test('computeMomentumScore: 完全没有数据时返回null', () => {
  assert.equal(computeMomentumScore({}, null), null);
  assert.equal(computeMomentumScore(null, null), null);
});

// ============================================================================
console.log('\n[15] Growth Themes — 主题映射（V2 第七阶段 Theme Exposure 依赖）');
// ============================================================================

test('getThemeForSymbol: 已知AI/半导体股票能查到主题', () => {
  assert.ok(getThemeForSymbol('NVDA').includes('AI'));
});

test('getThemeForSymbol: 查不到返回null，不瞎猜', () => {
  assert.equal(getThemeForSymbol('ZZZZ_NOT_REAL'), null);
});

test('GROWTH_THEMES: 每个主题分组都非空', () => {
  for (const [theme, symbols] of Object.entries(GROWTH_THEMES)) {
    assert.ok(symbols.length > 0, `主题分组"${theme}"不应该是空数组`);
  }
});

// ============================================================================
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) {
  console.log('失败详情：');
  failures.forEach(f => console.log(`  - ${f.name}: ${f.error.message}`));
  process.exit(1);
}
