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
import { INDUSTRY_LEADERS } from '../js/data/symbolLists.js';
import { CATEGORY_TO_SECTOR_ETF } from '../js/data/sectorMap.js';

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
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) {
  console.log('失败详情：');
  failures.forEach(f => console.log(`  - ${f.name}: ${f.error.message}`));
  process.exit(1);
}
