/**
 * ============================================================================
 * Universe Statistics（股票池统计）—— V2 第四阶段新增
 * ----------------------------------------------------------------------------
 * 两组统计口径，刻意不合并成一个函数，因为两种输入数据的字段覆盖范围不同，
 * 强行合并会掩盖"这个统计到底能不能算出来"：
 *
 *  1. fromScanResults(results)：输入是"扫描/历史回溯"产出的 SymbolAnalysis[]，
 *     有技术面/信号数据(综合分/RS/ATR/量能)，但没有静态分类字段(国家/是否ETF/
 *     是否ADR——这些SymbolAnalysis里从来没算过)，所以这部分统计里国家分布、
 *     ETF/ADR数量不会出现。
 *
 *  2. fromMasterUniverseRows(rows)：输入是 db.js master_universe 表查出的行，
 *     有静态分类字段(国家/交易所/是否ETF/ADR/REIT/市值)，但技术面评分字段
 *     只有"被扫描/同步过的股票"才有值，未同步的行这些字段是 NULL，
 *     统计时会明确说明"覆盖N/总数M"，不是假装全量都有数据。
 *
 * 两个函数都是纯函数，不依赖数据库连接或浏览器环境，方便单元测试。
 * ============================================================================
 */
'use strict';

function avgOf(values) {
  const v = values.filter(x => x != null && !Number.isNaN(x));
  if (!v.length) return null;
  return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100;
}

function bucketDistribution(values, buckets) {
  // buckets: [{label, min, max(exclusive)}], 返回每个桶的计数
  const counts = buckets.map(b => ({ ...b, count: 0 }));
  for (const v of values) {
    if (v == null) continue;
    const b = counts.find(b => v >= b.min && v < b.max);
    if (b) b.count++;
  }
  return counts;
}

const SCORE_BUCKETS = [
  { label: '0-20', min: 0, max: 20 }, { label: '20-40', min: 20, max: 40 },
  { label: '40-60', min: 40, max: 60 }, { label: '60-80', min: 60, max: 80 },
  { label: '80-100', min: 80, max: 101 },
];
const RS_BUCKETS = [
  { label: '0-25', min: 0, max: 25 }, { label: '25-50', min: 25, max: 50 },
  { label: '50-75', min: 50, max: 75 }, { label: '75-90', min: 75, max: 90 },
  { label: '90-100', min: 90, max: 101 },
];
const MCAP_BUCKETS = [
  { label: '<2B(小盘)', min: 0, max: 2e9 }, { label: '2B-10B(中盘)', min: 2e9, max: 10e9 },
  { label: '10B-50B(大盘)', min: 10e9, max: 50e9 }, { label: '50B-200B(超大盘)', min: 50e9, max: 200e9 },
  { label: '>200B(巨型)', min: 200e9, max: Infinity },
];

export const UniverseStats = {

  SCORE_BUCKETS, RS_BUCKETS, MCAP_BUCKETS,

  /**
   * 基于扫描结果统计：数量/多空分布/均值指标/板块分布/评分与RS分布。
   * 多空判定沿用系统里已有的阈值口径（riskWorkbench.reviewHolding 用 <40 作为
   * 卖出预警线，compositeScore 的分数范围是0-100）：
   *   >=70 看多(Bullish)，40~70 中性(Neutral)，<40 看空(Bearish)，null 不计入多空统计。
   */
  fromScanResults(results) {
    const valid = (results || []).filter(r => !r.isError);
    const total = valid.length;
    if (!total) return { total: 0 };

    const scores = valid.map(r => r.composite ? r.composite.score : null);
    const bullish = scores.filter(s => s != null && s >= 70).length;
    const bearish = scores.filter(s => s != null && s < 40).length;
    const neutral = scores.filter(s => s != null && s >= 40 && s < 70).length;
    const scoreUnavailable = scores.filter(s => s == null).length;

    const rsValues = valid.map(r => r.institutional && r.institutional.rs ? r.institutional.rs.percentile : null);
    const atrValues = valid.map(r => r.raw ? r.raw.atrNow : null);
    const volValues = valid.map(r => r.raw ? r.raw.volNow : null);
    const dollarVolValues = valid.map(r => (r.raw && r.raw.volNow != null && r.price != null) ? r.raw.volNow * r.price : null);

    const sectorCounts = {};
    for (const r of valid) {
      const key = r.sectorEtf || '未归类';
      sectorCounts[key] = (sectorCounts[key] || 0) + 1;
    }
    const sectorDistribution = Object.entries(sectorCounts)
      .map(([sector, count]) => ({ sector, count, pct: Math.round((count / total) * 1000) / 10 }))
      .sort((a, b) => b.count - a.count);

    return {
      total,
      bullish, neutral, bearish, scoreUnavailable,
      avgScore: avgOf(scores), avgRS: avgOf(rsValues), avgATR: avgOf(atrValues),
      avgVolume: avgOf(volValues), avgDollarVolume: avgOf(dollarVolValues),
      sectorCount: sectorDistribution.length,
      sectorDistribution,
      scoreDistribution: bucketDistribution(scores, SCORE_BUCKETS),
      rsDistribution: bucketDistribution(rsValues, RS_BUCKETS),
    };
  },

  /**
   * 基于 master_universe 表的行统计：交易所/国家/ETF/ADR/REIT数量、市值分布。
   * 会明确标注每个技术面字段(rs_percentile等)的"已知覆盖数"，不假装全量可用。
   */
  fromMasterUniverseRows(rows) {
    const total = (rows || []).length;
    if (!total) return { total: 0 };

    const exchangeCounts = {}, countryCounts = {};
    let etfCount = 0, adrCount = 0, reitCount = 0, delistedCount = 0;
    const mcapValues = [];
    for (const r of rows) {
      if (r.exchange) exchangeCounts[r.exchange] = (exchangeCounts[r.exchange] || 0) + 1;
      if (r.country) countryCounts[r.country] = (countryCounts[r.country] || 0) + 1;
      if (r.is_etf) etfCount++;
      if (r.is_adr) adrCount++;
      if (r.is_reit) reitCount++;
      if (r.is_delisted) delistedCount++;
      if (r.market_cap != null) mcapValues.push(r.market_cap);
    }
    const withComposite = rows.filter(r => r.composite_score != null).length;
    const withRS = rows.filter(r => r.rs_percentile != null).length;
    const withSector = rows.filter(r => r.sector != null).length;

    return {
      total,
      etfCount, adrCount, reitCount, delistedCount,
      exchangeDistribution: Object.entries(exchangeCounts).map(([exchange, count]) => ({ exchange, count })).sort((a, b) => b.count - a.count),
      countryDistribution: Object.entries(countryCounts).map(([country, count]) => ({ country, count })).sort((a, b) => b.count - a.count),
      marketCapDistribution: bucketDistribution(mcapValues, MCAP_BUCKETS),
      coverage: {
        composite_score: { known: withComposite, pct: Math.round((withComposite / total) * 1000) / 10 },
        rs_percentile: { known: withRS, pct: Math.round((withRS / total) * 1000) / 10 },
        sector: { known: withSector, pct: Math.round((withSector / total) * 1000) / 10 },
      },
    };
  },
};
