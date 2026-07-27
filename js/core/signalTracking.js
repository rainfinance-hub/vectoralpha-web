/**
 * ============================================================================
 * Signal Tracking（信号跟踪 / 信号表现看板）—— V2 第九阶段新增
 * ----------------------------------------------------------------------------
 * 每一次扫描（实时扫描或历史回溯）都把当时的综合评分/RS/各子分数存进
 * db.js 的 signal_history 表；之后随着时间推移，达到 5/10/20/60/120 个
 * 交易日后自动补算"如果当时买入，实际涨跌幅是多少"，存进 signal_returns
 * 表，最终汇总成 Signal Performance Dashboard——用于验证"综合评分高的
 * 股票，后续表现是不是真的更好"，这是从"选股器"升级到"可回测/可验证"
 * 系统的关键一步。
 *
 * 拆成两层，和项目里其它模块一致的解耦方式：
 *  1. 纯计算层（_computeReturnMetrics）：给定"信号当天收盘价"和"信号之后
 *     N个交易日的收盘价序列"，算出前瞻收益率/期间最大涨幅/最大回撤/是否
 *     跑赢SPY。不碰网络、不碰数据库，可以单独做单元测试。
 *  2. 编排层（reviewPendingSignals）：负责"哪些信号已经到复核时间了"、
 *     "去哪里拿这段时间的真实价格数据"、"算完之后存回数据库"，依赖
 *     DataSource(网络请求) 和 VADB(数据库)，只能在浏览器里跑。
 *
 * 复核时机判断：不是简单地用"日历天数 >= N"，而是取信号日之后的真实
 * 交易日收盘价数量 >= N 才计算，这样自然跳过周末/节假日，不会因为
 * 元旦/感恩节导致"5个交易日"提前或延后触发。
 * ============================================================================
 */
'use strict';
import { VADB } from './db.js';
import { DataSource } from '../data/dataSource.js';

export const DEFAULT_HORIZONS = [5, 10, 20, 60, 120];

function round2(v) { return v == null ? null : Math.round(v * 100) / 100; }

/**
 * 纯函数：给定信号当天的收盘价、信号之后的真实收盘价序列(升序，futureCloses[0]是信号后第1个交易日)，
 * 算出到某个 horizonDays 为止的前瞻收益/期间最大涨幅/最大回撤/相对SPY表现。
 * 数据不够(futureCloses还没积累到horizonDays天)时返回 null，代表"还没到复核时间"。
 */
export function computeReturnMetrics({ entryPrice, futureCloses, spyEntryPrice = null, spyFutureCloses = null, horizonDays }) {
  if (entryPrice == null || entryPrice <= 0 || !futureCloses || futureCloses.length < horizonDays) return null;
  const window = futureCloses.slice(0, horizonDays);
  const horizonClose = window[window.length - 1];
  const forwardReturnPct = round2(((horizonClose - entryPrice) / entryPrice) * 100);
  const maxClose = Math.max(...window);
  const minClose = Math.min(...window);
  const maxGainPct = round2(((maxClose - entryPrice) / entryPrice) * 100);
  const maxDrawdownPct = round2(((minClose - entryPrice) / entryPrice) * 100);

  let spyReturnPct = null, beatSpy = null;
  if (spyEntryPrice != null && spyEntryPrice > 0 && spyFutureCloses && spyFutureCloses.length >= horizonDays) {
    const spyWindow = spyFutureCloses.slice(0, horizonDays);
    const spyHorizonClose = spyWindow[spyWindow.length - 1];
    spyReturnPct = round2(((spyHorizonClose - spyEntryPrice) / spyEntryPrice) * 100);
    beatSpy = forwardReturnPct > spyReturnPct;
  }
  return { forwardReturnPct, maxGainPct, maxDrawdownPct, spyReturnPct, beatSpy };
}

export const SignalTracking = {

  /** 扫描/历史回溯完成后调用：把这批结果存进 signal_history，返回写入行数 */
  async recordScan(results, scanDate, isHistorical = false) {
    const valid = (results || []).filter(r => !r.isError && r.composite);
    if (!valid.length) return { recorded: 0 };
    await VADB.init();
    const ts = new Date().toISOString();
    VADB.transaction(() => {
      for (const r of valid) {
        VADB.run(
          `INSERT INTO signal_history (scan_date, symbol, price, composite_score, rs_percentile, resonance_pass_count, quality_score, canslim_score, sector_etf, is_historical, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          // 注意：全部用 ?? 显式兜底成 null，不能留 undefined——sql.js 的参数绑定不接受
          // undefined(会直接抛错中断整个事务)，而 r.composite?.score 这类可选链在中间某层
          // 是空对象{}但没有目标属性时，取出来的就是 undefined 而不是 null。
          [scanDate, r.sym, r.price ?? null, r.composite?.score ?? null,
            r.institutional?.rs?.percentile ?? null,
            r.resonance?.passCount ?? null,
            r.quality?.score ?? null,
            r.institutional?.canslim?.score ?? null,
            r.sectorEtf ?? null, isHistorical ? 1 : 0, ts]
        );
      }
    });
    return { recorded: valid.length };
  },

  /** 找出"信号日已经过去至少 minCalendarDays 天"、且某个 horizon 还没算出 return 的信号，作为待复核候选(用日历天数粗筛，真正是否够交易日在下面精算时判断) */
  async _findCandidates(horizonDays, minCalendarDaysBuffer = 1.6) {
    await VADB.init();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Math.ceil(horizonDays * minCalendarDaysBuffer));
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return VADB.query(
      `SELECT sh.* FROM signal_history sh
       WHERE sh.scan_date <= ?
         AND NOT EXISTS (SELECT 1 FROM signal_returns sr WHERE sr.signal_id = sh.id AND sr.horizon_days = ?)
       ORDER BY sh.scan_date ASC
       LIMIT 300`,
      [cutoffStr, horizonDays]
    );
  },

  /**
   * 对所有到期未复核的信号补算前瞻收益，写回 signal_returns。
   * @param {number[]} horizons 要复核的持有期(交易日)，默认 [5,10,20,60,120]
   * @param {function} onProgress (done, total) 进度回调，供UI展示
   */
  async reviewPendingSignals(horizons = DEFAULT_HORIZONS, onProgress = null) {
    await VADB.init();
    let totalComputed = 0, totalSkipped = 0;
    for (const horizonDays of horizons) {
      const candidates = await this._findCandidates(horizonDays);
      for (let i = 0; i < candidates.length; i++) {
        const sig = candidates[i];
        try {
          const daily = await DataSource.getDaily(sig.symbol, { yearsBack: 1 });
          const spy = await DataSource.getDaily('SPY', { yearsBack: 1 });
          const futureCloses = daily.bars.filter(b => b.t.slice(0, 10) > sig.scan_date).map(b => b.c);
          const spyBar = spy.bars.find(b => b.t.slice(0, 10) <= sig.scan_date);
          const spyFutureCloses = spy.bars.filter(b => b.t.slice(0, 10) > sig.scan_date).map(b => b.c);
          const metrics = computeReturnMetrics({
            entryPrice: sig.price, futureCloses,
            spyEntryPrice: spyBar ? spyBar.c : null, spyFutureCloses, horizonDays,
          });
          if (!metrics) { totalSkipped++; continue; } // 交易日还没攒够，下次再算
          VADB.run(
            `INSERT INTO signal_returns (signal_id, horizon_days, forward_return_pct, max_gain_pct, max_drawdown_pct, beat_spy, spy_return_pct, computed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(signal_id, horizon_days) DO UPDATE SET
               forward_return_pct=excluded.forward_return_pct, max_gain_pct=excluded.max_gain_pct,
               max_drawdown_pct=excluded.max_drawdown_pct, beat_spy=excluded.beat_spy,
               spy_return_pct=excluded.spy_return_pct, computed_at=excluded.computed_at`,
            [sig.id, horizonDays, metrics.forwardReturnPct, metrics.maxGainPct, metrics.maxDrawdownPct,
              metrics.beatSpy == null ? null : (metrics.beatSpy ? 1 : 0), metrics.spyReturnPct, new Date().toISOString()]
          );
          totalComputed++;
        } catch (e) {
          totalSkipped++;
          console.warn(`[SignalTracking] ${sig.symbol}@${sig.scan_date} horizon=${horizonDays} 复核失败: ${e.message}`);
        }
        if (onProgress) onProgress(i + 1, candidates.length, horizonDays);
      }
    }
    return { totalComputed, totalSkipped };
  },

  /** Signal Performance Dashboard 数据：按 horizon 汇总平均收益/胜率/样本数 */
  async getPerformanceSummary() {
    await VADB.init();
    const rows = VADB.query(
      `SELECT sr.horizon_days, sr.forward_return_pct, sr.max_gain_pct, sr.max_drawdown_pct, sr.beat_spy
       FROM signal_returns sr`
    );
    const byHorizon = {};
    for (const r of rows) {
      const h = r.horizon_days;
      if (!byHorizon[h]) byHorizon[h] = { horizonDays: h, samples: 0, returns: [], maxGains: [], maxDrawdowns: [], beatSpyCount: 0, beatSpyKnown: 0 };
      const bucket = byHorizon[h];
      bucket.samples++;
      if (r.forward_return_pct != null) bucket.returns.push(r.forward_return_pct);
      if (r.max_gain_pct != null) bucket.maxGains.push(r.max_gain_pct);
      if (r.max_drawdown_pct != null) bucket.maxDrawdowns.push(r.max_drawdown_pct);
      if (r.beat_spy != null) { bucket.beatSpyKnown++; if (r.beat_spy) bucket.beatSpyCount++; }
    }
    const avg = arr => arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : null;
    return Object.values(byHorizon).map(b => ({
      horizonDays: b.horizonDays, samples: b.samples,
      avgForwardReturnPct: avg(b.returns), avgMaxGainPct: avg(b.maxGains), avgMaxDrawdownPct: avg(b.maxDrawdowns),
      winRateVsSpyPct: b.beatSpyKnown ? Math.round((b.beatSpyCount / b.beatSpyKnown) * 1000) / 10 : null,
    })).sort((a, b) => a.horizonDays - b.horizonDays);
  },

  /** 待复核信号数量统计（供UI展示"还有多少信号在等待时间到期"） */
  async getPendingCount(horizons = DEFAULT_HORIZONS) {
    await VADB.init();
    const totalSignals = VADB.queryOne('SELECT COUNT(*) AS c FROM signal_history').c;
    const totalReturns = VADB.queryOne('SELECT COUNT(*) AS c FROM signal_returns').c;
    const maxPossible = totalSignals * horizons.length;
    return { totalSignals, totalReturns, pendingOrNotYetDue: Math.max(0, maxPossible - totalReturns) };
  },
};
