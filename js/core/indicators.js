/**
 * ============================================================================
 * 指标计算模块 (Indicators Module)
 * ----------------------------------------------------------------------------
 * 设计原则：
 *  1. 本模块内所有函数均为「纯函数」——只依赖传入的价格/成交量数组，不访问网络、
 *     不依赖全局状态、不关心"这是哪只股票""现在是不是历史回溯"。
 *  2. 这样做的好处：指标计算和"取数据""判断信号""渲染UI"完全解耦，
 *     未来你想加一个新指标（比如 Stochastic RSI、SuperTrend、VWAP），
 *     只需要在这个文件里新增一个函数，不需要改动任何其他模块。
 *  3. 所有函数对"数据不足"的情况一律返回 null（数组中对应位置），
 *     不做任何编造或近似，调用方必须自己处理 null。
 *
 * 输入约定：
 *  - close/high/low/open/volume 均为按时间正序排列的 number[]（旧→新）。
 *  - 返回的序列数组与输入等长，前面数据不足的位置为 null。
 * ============================================================================
 */
'use strict';

export const Indicators = {

  // ---------------- 简单移动平均 SMA ----------------
  sma(series, period) {
    const out = new Array(series.length).fill(null);
    if (period <= 0 || series.length < period) return out;
    let sum = 0;
    for (let i = 0; i < series.length; i++) {
      sum += series[i];
      if (i >= period) sum -= series[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  },

  // ---------------- 指数移动平均 EMA ----------------
  ema(series, period) {
    const out = new Array(series.length).fill(null);
    if (period <= 0 || series.length === 0) return out;
    const k = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < series.length; i++) {
      if (series[i] == null) { out[i] = prev; continue; }
      if (prev == null) {
        // 用前 period 个数据的 SMA 作为 EMA 起点，比"直接用第一个值"更稳健
        if (i >= period - 1) {
          let sum = 0;
          for (let j = i - period + 1; j <= i; j++) sum += series[j];
          prev = sum / period;
          out[i] = prev;
        }
      } else {
        prev = series[i] * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  },

  // 通用均线入口：type = 'sma' | 'ema'
  ma(series, period, type = 'ema') {
    return type === 'sma' ? this.sma(series, period) : this.ema(series, period);
  },

  // ---------------- RSI (Wilder 平滑) ----------------
  rsi(close, period = 14) {
    const out = new Array(close.length).fill(null);
    if (close.length < period + 1) return out;
    let gainSum = 0, lossSum = 0;
    for (let i = 1; i <= period; i++) {
      const diff = close[i] - close[i - 1];
      if (diff >= 0) gainSum += diff; else lossSum -= diff;
    }
    let avgGain = gainSum / period, avgLoss = lossSum / period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < close.length; i++) {
      const diff = close[i] - close[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  },

  // ---------------- MACD ----------------
  // 返回 { macdLine, signalLine, hist }，三者均为与输入等长的数组
  macd(close, fast = 12, slow = 26, signal = 9) {
    const emaFast = this.ema(close, fast);
    const emaSlow = this.ema(close, slow);
    const macdLine = close.map((_, i) =>
      (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null);
    // 对 macdLine 做 EMA 得到信号线：需要先把前导 null 挤掉再算，再对齐回原长度
    const validStart = macdLine.findIndex(v => v != null);
    let signalLine = new Array(close.length).fill(null);
    if (validStart >= 0) {
      const sub = macdLine.slice(validStart);
      const emaOfSub = this.ema(sub, signal);
      for (let i = 0; i < emaOfSub.length; i++) signalLine[validStart + i] = emaOfSub[i];
    }
    const hist = close.map((_, i) =>
      (macdLine[i] != null && signalLine[i] != null) ? macdLine[i] - signalLine[i] : null);
    return { macdLine, signalLine, hist, ml: macdLine, sl: signalLine };
  },

  // ---------------- 真实波幅 ATR ----------------
  atr(high, low, close, period = 14) {
    const n = close.length;
    const tr = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (i === 0) { tr[i] = high[i] - low[i]; continue; }
      tr[i] = Math.max(
        high[i] - low[i],
        Math.abs(high[i] - close[i - 1]),
        Math.abs(low[i] - close[i - 1])
      );
    }
    // Wilder 平滑（等价于 RMA）
    const out = new Array(n).fill(null);
    if (n < period) return out;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += tr[i];
    out[period - 1] = sum / period;
    for (let i = period; i < n; i++) {
      out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
    }
    return out;
  },

  // ---------------- ADX / +DI / -DI ----------------
  adx(high, low, close, period = 14) {
    const n = close.length;
    const plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0), tr = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const upMove = high[i] - high[i - 1];
      const downMove = low[i - 1] - low[i];
      plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
      minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
      tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    }
    const smooth = (arr) => {
      const out = new Array(n).fill(null);
      if (n <= period) return out;
      let sum = 0;
      for (let i = 1; i <= period; i++) sum += arr[i];
      out[period] = sum;
      for (let i = period + 1; i < n; i++) out[i] = out[i - 1] - (out[i - 1] / period) + arr[i];
      return out;
    };
    const trS = smooth(tr), plusS = smooth(plusDM), minusS = smooth(minusDM);
    const plusDI = new Array(n).fill(null), minusDI = new Array(n).fill(null), dx = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (trS[i] != null && trS[i] !== 0) {
        plusDI[i] = 100 * plusS[i] / trS[i];
        minusDI[i] = 100 * minusS[i] / trS[i];
        const diSum = plusDI[i] + minusDI[i];
        dx[i] = diSum === 0 ? 0 : 100 * Math.abs(plusDI[i] - minusDI[i]) / diSum;
      }
    }
    // ADX = DX 的 Wilder 平滑
    const adxOut = new Array(n).fill(null);
    const dxValidStart = dx.findIndex(v => v != null);
    if (dxValidStart >= 0 && n - dxValidStart >= period) {
      let sum = 0;
      for (let i = dxValidStart; i < dxValidStart + period; i++) sum += dx[i];
      adxOut[dxValidStart + period - 1] = sum / period;
      for (let i = dxValidStart + period; i < n; i++) {
        adxOut[i] = (adxOut[i - 1] * (period - 1) + dx[i]) / period;
      }
    }
    return { adx: adxOut, plusDI, minusDI };
  },

  // ---------------- OBV 能量潮 ----------------
  obv(close, volume) {
    const out = new Array(close.length).fill(0);
    for (let i = 1; i < close.length; i++) {
      if (close[i] > close[i - 1]) out[i] = out[i - 1] + volume[i];
      else if (close[i] < close[i - 1]) out[i] = out[i - 1] - volume[i];
      else out[i] = out[i - 1];
    }
    return out;
  },

  // ---------------- CMF 佳庆资金流量 ----------------
  cmf(high, low, close, volume, period = 20) {
    const n = close.length;
    const mfv = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const range = high[i] - low[i];
      const mfm = range === 0 ? 0 : ((close[i] - low[i]) - (high[i] - close[i])) / range;
      mfv[i] = mfm * volume[i];
    }
    const out = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) {
      let sumMfv = 0, sumVol = 0;
      for (let j = i - period + 1; j <= i; j++) { sumMfv += mfv[j]; sumVol += volume[j]; }
      out[i] = sumVol === 0 ? null : sumMfv / sumVol;
    }
    return out;
  },

  // ---------------- 布林带 ----------------
  bollinger(close, period = 20, mult = 2) {
    const mid = this.sma(close, period);
    const upper = new Array(close.length).fill(null);
    const lower = new Array(close.length).fill(null);
    for (let i = period - 1; i < close.length; i++) {
      let sumSq = 0;
      for (let j = i - period + 1; j <= i; j++) sumSq += Math.pow(close[j] - mid[i], 2);
      const sd = Math.sqrt(sumSq / period);
      upper[i] = mid[i] + mult * sd;
      lower[i] = mid[i] - mult * sd;
    }
    return { mid, upper, lower };
  },

  // ---------------- N 日最高/最低（不含未来数据，适合回溯） ----------------
  highN(high, n, endIdx) {
    if (endIdx < 0) return null;
    const start = Math.max(0, endIdx - n + 1);
    let max = -Infinity;
    for (let i = start; i <= endIdx; i++) if (high[i] > max) max = high[i];
    return isFinite(max) ? max : null;
  },
  lowN(low, n, endIdx) {
    if (endIdx < 0) return null;
    const start = Math.max(0, endIdx - n + 1);
    let min = Infinity;
    for (let i = start; i <= endIdx; i++) if (low[i] < min) min = low[i];
    return isFinite(min) ? min : null;
  },

  // 在 endIdx 处取"过去 n 期"的简单均值（用于均量等场景），注意含 endIdx 当期
  sma_at(series, n, endIdx) {
    if (endIdx < n - 1) return null;
    let sum = 0;
    for (let i = endIdx - n + 1; i <= endIdx; i++) sum += series[i];
    return sum / n;
  },

  // ---------------- 横截面百分位排名 ----------------
  // value 在有序数组 sortedAsc 中的百分位 (0-100)
  percentileRank(value, sortedAsc) {
    if (!sortedAsc.length) return null;
    let idx = 0;
    for (; idx < sortedAsc.length; idx++) if (sortedAsc[idx] >= value) break;
    return sortedAsc.length > 1 ? Math.round((idx / (sortedAsc.length - 1)) * 100) : 50;
  },

  // ---------------- 日收益率序列 ----------------
  // close -> 简单日收益率数组(长度比close少1)，供 beta/correlation 使用
  dailyReturns(close) {
    const out = [];
    for (let i = 1; i < close.length; i++) {
      out.push(close[i - 1] === 0 ? 0 : (close[i] - close[i - 1]) / close[i - 1]);
    }
    return out;
  },

  // ---------------- Beta（相对基准指数，通常是SPY）—— V2 第一阶段(Universe Builder)新增 ----------------
  // beta = Cov(symbolReturns, benchmarkReturns) / Var(benchmarkReturns)
  // 两个close序列会先各自转成收益率，再按"两者共同覆盖的最近N个交易日"对齐计算，
  // 数据不足(少于30个交易日的重叠收益率)时返回 null，不勉强算一个不可靠的值。
  computeBeta(symbolClose, benchmarkClose) {
    if (!symbolClose || !benchmarkClose) return null;
    const symRet = this.dailyReturns(symbolClose);
    const benchRet = this.dailyReturns(benchmarkClose);
    const n = Math.min(symRet.length, benchRet.length);
    if (n < 30) return null;
    const s = symRet.slice(-n), b = benchRet.slice(-n);
    const meanS = s.reduce((a, v) => a + v, 0) / n;
    const meanB = b.reduce((a, v) => a + v, 0) / n;
    let cov = 0, varB = 0;
    for (let i = 0; i < n; i++) {
      cov += (s[i] - meanS) * (b[i] - meanB);
      varB += (b[i] - meanB) ** 2;
    }
    if (varB === 0) return null;
    return Math.round((cov / varB) * 100) / 100;
  },

  // ---------------- 皮尔逊相关系数 —— V2 第七阶段(Portfolio Risk Correlation)新增 ----------------
  // 两个价格序列各自转收益率后计算相关系数(-1~1)，数据不足返回 null。
  computeCorrelation(closeA, closeB) {
    if (!closeA || !closeB) return null;
    const retA = this.dailyReturns(closeA);
    const retB = this.dailyReturns(closeB);
    const n = Math.min(retA.length, retB.length);
    if (n < 30) return null;
    const a = retA.slice(-n), b = retB.slice(-n);
    const meanA = a.reduce((x, v) => x + v, 0) / n;
    const meanB = b.reduce((x, v) => x + v, 0) / n;
    let cov = 0, varA = 0, varB = 0;
    for (let i = 0; i < n; i++) {
      cov += (a[i] - meanA) * (b[i] - meanB);
      varA += (a[i] - meanA) ** 2;
      varB += (b[i] - meanB) ** 2;
    }
    if (varA === 0 || varB === 0) return null;
    return Math.round((cov / Math.sqrt(varA * varB)) * 1000) / 1000;
  },
};
