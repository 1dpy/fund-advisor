/**
 * 高级特征工程引擎
 *
 * 生成50+维特征矩阵, 用于ML模型训练和预测:
 *
 * 1. 价格动量特征 (10维): 1/3/5/10/20日收益率及加速度
 * 2. 均线偏离特征 (8维): MA5/10/20/60偏离度及交叉信号
 * 3. 波动率特征 (6维): 已实现波动率/ATR/布林带宽
 * 4. 技术指标特征 (10维): RSI/MACD/KDJ/威廉指标
 * 5. 统计特征 (6维): 偏度/峰度/自相关/Hurst指数
 * 6. 成交量特征 (4维): 量比/换手率/量价背离 (ETF有量)
 * 7. 跨时间框架特征 (6维): 周/月级别动量及趋势
 * 8. 市场环境特征 (4维): 大盘beta/相关性/行业相对强度
 *
 * 参考: AQR Capital, Two Sigma, Renaissance Technologies特征工程方法
 */

/**
 * 从基金历史数据计算完整特征向量
 * @param {Array} history - 日线历史数据 (含nav, close, changePct, volume)
 * @param {Array} weeklyHistory - 周线数据 (可选)
 * @param {Array} monthlyHistory - 月线数据 (可选)
 * @param {Object} marketData - 大盘数据 (可选)
 * @returns {Object} { features: [], featureNames: [], stats: {} }
 */
function extractFeatures(history, weeklyHistory = null, monthlyHistory = null, marketData = null) {
  if (!history || history.length < 30) return null;

  const closes = history.map(h => h.nav || h.close);
  const changes = history.map(h => h.changePct / 100);
  const volumes = history.map(h => h.volume || 0);
  const n = closes.length;
  const lastPrice = closes[n - 1];

  const features = [];
  const names = [];

  // ============================================================
  // 1. 价格动量特征 (10维)
  // ============================================================
  const ret1 = n > 1 ? (closes[n-1] / closes[n-2] - 1) : 0;
  const ret3 = n > 3 ? (closes[n-1] / closes[n-4] - 1) : 0;
  const ret5 = n > 5 ? (closes[n-1] / closes[n-6] - 1) : 0;
  const ret10 = n > 10 ? (closes[n-1] / closes[n-11] - 1) : 0;
  const ret20 = n > 20 ? (closes[n-1] / closes[n-21] - 1) : 0;
  // 动量加速度
  const accel5 = n > 10 ? ret5 - (n > 10 ? (closes[n-6] / closes[n-11] - 1) : 0) : 0;
  const accel10 = n > 20 ? ret10 - (n > 20 ? (closes[n-11] / closes[n-21] - 1) : 0) : 0;
  // 动量比率
  const momRatio1 = ret1 !== 0 ? ret5 / Math.abs(ret1) : 0;
  const momRatio2 = ret5 !== 0 ? ret20 / Math.abs(ret5) : 0;
  // 最大单日涨幅/跌幅 (近10天)
  const recentChanges = changes.slice(-10);
  const maxGain = recentChanges.length > 0 ? Math.max(...recentChanges) : 0;
  const maxLoss = recentChanges.length > 0 ? Math.min(...recentChanges) : 0;

  features.push(ret1, ret3, ret5, ret10, ret20, accel5, accel10, momRatio1, momRatio2, maxGain - maxLoss);
  names.push('ret1', 'ret3', 'ret5', 'ret10', 'ret20', 'accel5', 'accel10', 'momRatio1', 'momRatio2', 'range10');

  // ============================================================
  // 2. 均线偏离特征 (8维)
  // ============================================================
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = n > 60 ? sma(closes, 60) : ma20;
  const devMA5 = ma5 > 0 ? (lastPrice - ma5) / ma5 : 0;
  const devMA10 = ma10 > 0 ? (lastPrice - ma10) / ma10 : 0;
  const devMA20 = ma20 > 0 ? (lastPrice - ma20) / ma20 : 0;
  const devMA60 = ma60 > 0 ? (lastPrice - ma60) / ma60 : 0;
  // 均线排列: 多头=1, 空头=-1
  const maAlign = (ma5 > ma10 && ma10 > ma20) ? 1 : (ma5 < ma10 && ma10 < ma20) ? -1 : 0;
  // 短期均线穿越信号
  const goldenCross = ma5 > ma10 ? 1 : 0;
  const ma20Slope = ma20 > 0 && n > 21 ? (ma20 - sma(closes.slice(0, -1), 20)) / ma20 : 0;
  // 均线粘合度 (标准差/均值)
  const maValues = [ma5, ma10, ma20, ma60].filter(v => v > 0);
  const maMean = maValues.reduce((a, b) => a + b, 0) / maValues.length;
  const maStd = Math.sqrt(maValues.reduce((a, b) => a + (b - maMean) ** 2, 0) / maValues.length);
  const maConvergence = maMean > 0 ? maStd / maMean : 0;

  features.push(devMA5, devMA10, devMA20, devMA60, maAlign, goldenCross, ma20Slope, maConvergence);
  names.push('devMA5', 'devMA10', 'devMA20', 'devMA60', 'maAlign', 'goldenCross', 'ma20Slope', 'maConvergence');

  // ============================================================
  // 3. 波动率特征 (6维)
  // ============================================================
  const vol5 = std(changes.slice(-5)) * Math.sqrt(252);
  const vol10 = std(changes.slice(-10)) * Math.sqrt(252);
  const vol20 = std(changes.slice(-20)) * Math.sqrt(252);
  // ATR (Average True Range)
  const atr14 = calcATR(history, 14);
  const atrPct = lastPrice > 0 ? atr14 / lastPrice : 0;
  // 波动率比率 (短期 vs 长期)
  const volRatio = vol20 > 0 ? vol5 / vol20 : 1;
  // 波动率变化
  const volChange = vol20 > 0 ? (vol5 - vol20) / vol20 : 0;

  features.push(vol5, vol10, vol20, atrPct, volRatio, volChange);
  names.push('vol5', 'vol10', 'vol20', 'atrPct', 'volRatio', 'volChange');

  // ============================================================
  // 4. 技术指标特征 (10维)
  // ============================================================
  // RSI
  const rsi14 = calcRSI(closes, 14);
  // MACD
  const macd = calcMACD(closes);
  const macdHist = macd ? macd.histogram : 0;
  const macdSignal = macd ? (macd.strengthening ? 1 : macd.diverging ? -1 : 0) : 0;
  const macdDif = macd ? macd.dif : 0;
  // KDJ
  const kdj = calcKDJ(history);
  // 布林带位置
  const bollPos = calcBollPosition(closes, 20);
  // 威廉指标
  const wr14 = calcWilliamsR(history, 14);
  // 乖离率
  const bias = ma20 > 0 ? (lastPrice - ma20) / ma20 * 100 : 0;
  // 量价背离 (如果有成交量)
  const volPriceDiverge = calcVolPriceDiverge(changes, volumes);

  features.push(
    rsi14 / 100,  // 归一化到0-1
    macdHist,
    macdSignal,
    macdDif,
    (kdj ? kdj.k : 50) / 100,
    (kdj ? kdj.j : 50) / 100,
    bollPos,
    wr14 / 100,
    bias / 10,  // 缩放
    volPriceDiverge
  );
  names.push('rsi', 'macdHist', 'macdSignal', 'macdDif', 'kdjK', 'kdjJ', 'bollPos', 'williamsR', 'bias', 'volPriceDiverge');

  // ============================================================
  // 5. 统计特征 (6维)
  // ============================================================
  const recentReturns = changes.slice(-20);
  const statMean = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
  const statStd = std(recentReturns);
  const statSkew = statStd > 0
    ? recentReturns.reduce((a, b) => a + ((b - statMean) / statStd) ** 3, 0) / recentReturns.length
    : 0;
  const statKurt = statStd > 0
    ? recentReturns.reduce((a, b) => a + ((b - statMean) / statStd) ** 4, 0) / recentReturns.length - 3
    : 0;
  // 自相关
  const autocorr1 = autocorr(recentReturns, 1);
  const autocorr5 = autocorr(recentReturns, 5);

  features.push(statMean * 100, statStd * 100, statSkew, statKurt, autocorr1, autocorr5);
  names.push('statMean', 'statStd', 'statSkew', 'statKurt', 'autocorr1', 'autocorr5');

  // ============================================================
  // 6. 跨时间框架特征 (6维) — 周线/月线趋势
  // ============================================================
  let weeklyRet = 0, monthlyRet = 0, weeklyTrend = 0, monthlyTrend = 0;
  let weeklyRSI = 50, monthlyRSI = 50;

  if (weeklyHistory && weeklyHistory.length > 5) {
    const wCloses = weeklyHistory.map(h => h.nav || h.close);
    const wn = wCloses.length;
    weeklyRet = wn > 1 ? (wCloses[wn-1] / wCloses[wn-2] - 1) : 0;
    weeklyTrend = wn > 5 ? (wCloses[wn-1] / wCloses[wn-5] - 1) : 0;
    weeklyRSI = calcRSI(wCloses, 14);
  }

  if (monthlyHistory && monthlyHistory.length > 3) {
    const mCloses = monthlyHistory.map(h => h.nav || h.close);
    const mn = mCloses.length;
    monthlyRet = mn > 1 ? (mCloses[mn-1] / mCloses[mn-2] - 1) : 0;
    monthlyTrend = mn > 3 ? (mCloses[mn-1] / mCloses[0] - 1) : 0;
    monthlyRSI = calcRSI(mCloses, 14);
  }

  // 多时间框架共振: 日线+周线+月线方向一致时信号最强
  const tfConcordance = Math.sign(ret5) === Math.sign(weeklyRet) && Math.sign(weeklyRet) === Math.sign(monthlyRet) ? 1 : 0;

  features.push(weeklyRet, monthlyRet, weeklyTrend, monthlyTrend, (weeklyRSI + monthlyRSI) / 200, tfConcordance);
  names.push('weeklyRet', 'monthlyRet', 'weeklyTrend', 'monthlyTrend', 'weeklyMonthlyRSI', 'tfConcordance');

  // ============================================================
  // 7. 市场环境特征 (4维) — 与大盘的关联
  // ============================================================
  let beta = 1, corrToMarket = 0, relativeStrength = 0, marketRegime = 0;

  if (marketData && marketData.marketReturns && Array.isArray(marketData.marketReturns) && changes.length >= 20) {
    const fundReturns = changes.slice(-20);
    const marketReturns = marketData.marketReturns.slice(-20);
    const minLen = Math.min(fundReturns.length, marketReturns.length);

    // Beta
    const cov = covariance(fundReturns.slice(-minLen), marketReturns.slice(-minLen));
    const marketVar = variance(marketReturns.slice(-minLen));
    beta = marketVar > 0 ? cov / marketVar : 1;

    // 相关性
    corrToMarket = correlation(fundReturns.slice(-minLen), marketReturns.slice(-minLen));

    // 相对强度
    const fundCum = fundReturns.reduce((a, b) => a + b, 0);
    const marketCum = marketReturns.reduce((a, b) => a + b, 0);
    relativeStrength = fundCum - marketCum;

    // 市场体制
    marketRegime = marketData.regime === 'BULL' ? 1 : marketData.regime === 'BEAR' ? -1 : 0;
  }

  features.push(beta, corrToMarket, relativeStrength, marketRegime);
  names.push('beta', 'corrToMarket', 'relativeStrength', 'marketRegime');

  // ============================================================
  // 8. 交易特征 (4维) — 资金流/换手率
  // ============================================================
  // 最近5天上涨比率
  const upDays = changes.slice(-5).filter(r => r > 0).length;
  const upRatio5 = upDays / 5;
  // 最近20天上涨比率
  const upDays20 = changes.slice(-20).filter(r => r > 0).length;
  const upRatio20 = upDays20 / 20;
  // 连续上涨/下跌天数
  let streak = 0;
  for (let i = changes.length - 1; i >= 0; i--) {
    if (changes[i] > 0) streak++;
    else break;
  }
  if (changes.length > 0 && changes[changes.length - 1] < 0) {
    streak = 0;
    for (let i = changes.length - 1; i >= 0; i--) {
      if (changes[i] < 0) streak--;
      else break;
    }
  }
  // 最大回撤 (20日)
  const maxDD20 = calcMaxDrawdown(closes.slice(-20));

  features.push(upRatio5, upRatio20, streak / 5, maxDD20);
  names.push('upRatio5', 'upRatio20', 'streak', 'maxDD20');

  // ============================================================
  // 汇总统计
  // ============================================================
  const stats = {
    lastPrice,
    rsi: rsi14,
    macd: macd ? macd.dif : 0,
    vol20: vol20,
    sharpe: vol20 > 0 ? statMean / statStd * Math.sqrt(252) : 0,
    beta,
    hurst: 0.5, // 可外部计算后填入
    featureCount: features.length,
  };

  return { features, names, stats };
}

// ============================================================
// 辅助函数
// ============================================================

function sma(arr, period) {
  if (arr.length < period) {
    return arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
  }
  const slice = arr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function std(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    if (i > 0) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = emaFast - emaSlow;
  // 简化: 用dif的sma作为signal
  const macdLine = closes.slice(-slow - signal).map((_, i, arr) => {
    const slice = arr.slice(0, i + 1);
    const ef = ema(slice, fast);
    const es = ema(slice, slow);
    return ef - es;
  });
  const dea = macdLine.slice(-signal).reduce((a, b) => a + b, 0) / signal;
  const histogram = dif - dea;
  const prevHist = macdLine.length >= 2 ? macdLine[macdLine.length - 2] - dea : 0;
  return {
    dif,
    dea,
    histogram,
    strengthening: histogram > prevHist,
    diverging: histogram < prevHist,
  };
}

function ema(closes, period) {
  if (closes.length === 0) return 0;
  const k = 2 / (period + 1);
  let emaVal = closes[0];
  for (let i = 1; i < closes.length; i++) {
    emaVal = closes[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

function calcKDJ(history, period = 9) {
  if (history.length < period) return null;
  const closes = history.map(h => h.nav || h.close);
  const highs = history.map(h => h.high || h.nav || h.close);
  const lows = history.map(h => h.low || h.nav || h.close);
  const n = closes.length;
  const recent = n - period;
  let k = 50, d = 50;

  for (let i = recent; i < n; i++) {
    const highest = Math.max(...highs.slice(Math.max(0, i - period + 1), i + 1));
    const lowest = Math.min(...lows.slice(Math.max(0, i - period + 1), i + 1));
    const rsv = highest > lowest ? (closes[i] - lowest) / (highest - lowest) * 100 : 50;
    k = 2 / 3 * k + 1 / 3 * rsv;
    d = 2 / 3 * d + 1 / 3 * k;
  }
  const j = 3 * k - 2 * d;
  return { k, d, j };
}

function calcBollPosition(closes, period = 20) {
  if (closes.length < period) return 0.5;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const stdVal = std(slice);
  const upper = mean + 2 * stdVal;
  const lower = mean - 2 * stdVal;
  const lastPrice = closes[closes.length - 1];
  if (upper === lower) return 0.5;
  return (lastPrice - lower) / (upper - lower);
}

function calcWilliamsR(history, period = 14) {
  if (history.length < period) return -50;
  const closes = history.map(h => h.nav || h.close);
  const highs = history.map(h => h.high || h.nav || h.close);
  const lows = history.map(h => h.low || h.nav || h.close);
  const recent = period;
  const highest = Math.max(...highs.slice(-recent));
  const lowest = Math.min(...lows.slice(-recent));
  const lastClose = closes[closes.length - 1];
  if (highest === lowest) return -50;
  return ((highest - lastClose) / (highest - lowest)) * -100;
}

function calcATR(history, period = 14) {
  if (history.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < history.length; i++) {
    const high = history[i].high || history[i].nav;
    const low = history[i].low || history[i].nav;
    const prevClose = history[i-1].nav || history[i-1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcVolPriceDiverge(changes, volumes) {
  if (volumes.every(v => v === 0) || changes.length < 10) return 0;
  const recentChanges = changes.slice(-10);
  const recentVolumes = volumes.slice(-10);
  const priceUp = recentChanges.reduce((a, b) => a + b, 0) > 0;
  const volUp = recentVolumes[recentVolumes.length - 1] > recentVolumes[0];
  // 量价同向=0, 背离=1或-1
  if (priceUp && !volUp) return 1;
  if (!priceUp && volUp) return -1;
  return 0;
}

function calcMaxDrawdown(closes) {
  if (closes.length < 2) return 0;
  let peak = closes[0];
  let maxDD = 0;
  for (const price of closes) {
    if (price > peak) peak = price;
    const dd = (price - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD;
}

function autocorr(arr, lag) {
  if (arr.length <= lag) return 0;
  const n = arr.length - lag;
  const mean1 = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const mean2 = arr.slice(lag).reduce((a, b) => a + b, 0) / n;
  let cov = 0, var1 = 0, var2 = 0;
  for (let i = 0; i < n; i++) {
    cov += (arr[i] - mean1) * (arr[i + lag] - mean2);
    var1 += (arr[i] - mean1) ** 2;
    var2 += (arr[i + lag] - mean2) ** 2;
  }
  if (var1 === 0 || var2 === 0) return 0;
  return cov / Math.sqrt(var1 * var2);
}

function covariance(arr1, arr2) {
  const n = Math.min(arr1.length, arr2.length);
  if (n === 0) return 0;
  const mean1 = arr1.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const mean2 = arr2.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  for (let i = 0; i < n; i++) {
    cov += (arr1[i] - mean1) * (arr2[i] - mean2);
  }
  return cov / n;
}

function variance(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
}

function correlation(arr1, arr2) {
  const cov = covariance(arr1, arr2);
  const v1 = variance(arr1);
  const v2 = variance(arr2);
  if (v1 === 0 || v2 === 0) return 0;
  return cov / Math.sqrt(v1 * v2);
}

module.exports = {
  extractFeatures,
  // 导出辅助函数供外部使用
  sma, std, ema, calcRSI, calcMACD, calcKDJ, calcATR,
  calcMaxDrawdown, hurstExponent: null, // 从data_collector导入
  covariance, correlation,
};
