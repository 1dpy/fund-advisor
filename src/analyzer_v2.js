/**
 * 技术分析引擎 V2 — 12+指标，动态权重，风险调整评分
 *
 * 新增指标: KDJ, ATR(波动率), 量价背离, 夏普比率, 动量质量,
 *          高低点趋势, 板块相对强度, 机构资金倾向
 */

const { TECH_CONFIG } = require('./config');

// ============================================================
//  基础计算函数
// ============================================================

function sum(arr) { return arr.reduce((a, b) => a + b, 0); }
function mean(arr) { return arr.length > 0 ? sum(arr) / arr.length : 0; }
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function calcSMA(data, period) {
  if (!data || data.length < period) return [];
  const result = [];
  for (let i = period - 1; i < data.length; i++) {
    result.push(mean(data.slice(i - period + 1, i + 1)));
  }
  return result;
}

function calcEMA(data, period) {
  if (!data || data.length < period) return [];
  const k = 2 / (period + 1);
  const result = [mean(data.slice(0, period))];
  for (let i = period; i < data.length; i++) {
    result.push(data[i] * k + result[result.length - 1] * (1 - k));
  }
  return result;
}

function calcMax(data, period) {
  if (!data || data.length < period) return null;
  return Math.max(...data.slice(-period));
}

function calcMin(data, period) {
  if (!data || data.length < period) return null;
  return Math.min(...data.slice(-period));
}

// ============================================================
//  指标计算
// ============================================================

function calcRSI(closes, period = TECH_CONFIG.rsiPeriod) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  const rsiValues = [avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)];

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    rsiValues.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsiValues[rsiValues.length - 1];
}

function calcMACD(closes) {
  const { macdFast, macdSlow, macdSignal } = TECH_CONFIG;
  if (!closes || closes.length < macdSlow + macdSignal) return null;

  const emaFast = calcEMA(closes, macdFast);
  const emaSlow = calcEMA(closes, macdSlow);
  const offset = emaSlow.length - emaFast.length;
  const dif = emaFast.slice(offset).map((v, i) => v - emaSlow[i]);
  const dea = calcEMA(dif, macdSignal);
  const histogram = dif.slice(dif.length - dea.length).map((v, i) => 2 * (v - dea[i]));

  const lastHist = histogram[histogram.length - 1];
  const prevHist = histogram.length >= 2 ? histogram[histogram.length - 2] : 0;
  const prevPrevHist = histogram.length >= 3 ? histogram[histogram.length - 3] : 0;

  return {
    dif: dif[dif.length - 1],
    dea: dea[dea.length - 1],
    histogram: lastHist,
    prevHistogram: prevHist,
    goldenCross: prevHist <= 0 && lastHist > 0,
    deathCross: prevHist >= 0 && lastHist < 0,
    strengthening: Math.abs(lastHist) > Math.abs(prevHist), // 动能增强
    diverging: lastHist > 0 && Math.abs(lastHist) < Math.abs(prevHist), // 顶背离风险
    momentum: lastHist - prevHist, // 柱状线变化量
  };
}

function calcKDJ(highs, lows, closes, period = 9) {
  if (!closes || closes.length < period) return null;
  const recentCloses = closes.slice(-period);
  const recentHighs = highs ? highs.slice(-period) : recentCloses;
  const recentLows = lows ? lows.slice(-period) : recentCloses;

  const highestHigh = Math.max(...recentHighs);
  const lowestLow = Math.min(...recentLows);
  const rsv = highestHigh === lowestLow ? 50 :
    ((recentCloses[recentCloses.length - 1] - lowestLow) / (highestHigh - lowestLow)) * 100;

  // 简化: 单期近似 (完整KDJ需要多期平滑)
  const k = rsv * 2 / 3 + 50 / 3;
  const d = k * 2 / 3 + 50 / 3;

  return {
    k: Math.round(k * 10) / 10,
    d: Math.round(d * 10) / 10,
    j: Math.round((3 * k - 2 * d) * 10) / 10,
    zone: k > 80 ? '超买' : k < 20 ? '超卖' : '正常',
    goldenCross: k > d && (k - d) < 5, // K上穿D
  };
}

function calcATR(highs, lows, closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  const trValues = [];
  for (let i = 1; i < closes.length; i++) {
    const h = highs ? highs[i] : closes[i];
    const l = lows ? lows[i] : closes[i];
    const prevC = closes[i - 1];
    trValues.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
  }
  const atr = mean(trValues.slice(-period));
  const price = closes[closes.length - 1];
  return { atr, atrPct: price > 0 ? atr / price * 100 : 0 };
}

/**
 * 量价背离检测
 */
function detectVolumePriceDivergence(closes, volumes) {
  if (!closes || !volumes || closes.length < 10) return null;

  const recentPrices = closes.slice(-5);
  const recentVolumes = volumes.slice(-5);
  const prevPrices = closes.slice(-10, -5);
  const prevVolumes = volumes.slice(-10, -5);

  const priceTrend = mean(recentPrices) - mean(prevPrices);
  const volumeTrend = mean(recentVolumes) - mean(prevVolumes);

  // 价涨量缩 = 顶背离(弱势)
  if (priceTrend > 0 && volumeTrend < 0) return 'bearish_divergence';
  // 价跌量增 = 底背离(可能反转)
  if (priceTrend < 0 && volumeTrend > 0) return 'bullish_divergence';
  // 价涨量增 = 健康
  if (priceTrend > 0 && volumeTrend > 0) return 'healthy_uptrend';
  // 价跌量缩 = 弱势
  if (priceTrend < 0 && volumeTrend < 0) return 'weak_downtrend';
  return 'neutral';
}

/**
 * 动量质量: 上涨日涨幅均值 / 下跌日跌幅均值(绝对值)
 * > 1.5 = 高质量上涨, < 0.8 = 低质量
 */
function calcMomentumQuality(closes) {
  if (!closes || closes.length < 20) return null;
  const dailyChanges = [];
  for (let i = 1; i < closes.length; i++) {
    dailyChanges.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const upDays = dailyChanges.filter(c => c > 0);
  const downDays = dailyChanges.filter(c => c < 0);
  const avgUp = upDays.length > 0 ? mean(upDays) : 0;
  const avgDown = downDays.length > 0 ? Math.abs(mean(downDays)) : 0;
  if (avgDown === 0) return 3;
  return Math.round(avgUp / avgDown * 100) / 100;
}

/**
 * 近似夏普比率 (日收益均值/标准差 * sqrt(252))
 */
function calcSharpeRatio(closes) {
  if (!closes || closes.length < 20) return null;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const avgReturn = mean(returns);
  const sd = stdDev(returns);
  if (sd === 0) return 0;
  return Math.round(avgReturn / sd * Math.sqrt(252) * 100) / 100;
}

/**
 * 高低点趋势 — 检测更高高点和更高低点
 */
function detectHighLowTrend(highs, lows, lookback = 20) {
  if (!highs || !lows || highs.length < lookback) return 'insufficient_data';
  const recentHighs = highs.slice(-lookback);
  const recentLows = lows.slice(-lookback);
  const mid = Math.floor(lookback / 2);

  const firstHalfHigh = Math.max(...recentHighs.slice(0, mid));
  const secondHalfHigh = Math.max(...recentHighs.slice(mid));
  const firstHalfLow = Math.min(...recentLows.slice(0, mid));
  const secondHalfLow = Math.min(...recentLows.slice(mid));

  const higherHigh = secondHalfHigh > firstHalfHigh * 1.005;
  const higherLow = secondHalfLow > firstHalfLow * 1.005;
  const lowerHigh = secondHalfHigh < firstHalfHigh * 0.995;
  const lowerLow = secondHalfLow < firstHalfLow * 0.995;

  if (higherHigh && higherLow) return 'uptrend';
  if (lowerHigh && lowerLow) return 'downtrend';
  if (higherHigh && !higherLow) return 'weakening_uptrend';
  if (lowerLow && !lowerHigh) return 'potential_reversal';
  return 'consolidation';
}

/**
 * 从历史数据提取价格序列
 */
function extractSeries(history) {
  if (!history || history.length === 0) return { closes: [], highs: [], lows: [], volumes: [] };
  return {
    closes: history.map(h => h.close || h.nav || 0).filter(v => v > 0),
    highs: history.map(h => h.high || 0),
    lows: history.map(h => h.low || 0),
    volumes: history.map(h => h.volume || 0),
  };
}

// ============================================================
//  综合评分引擎
// ============================================================

/**
 * 对基金进行全面技术评分 (0-100)
 */
function scoreFund(fund) {
  const { history } = fund;
  const minBars = TECH_CONFIG.longMA + TECH_CONFIG.macdSlow + 10;

  if (!history || history.length < minBars) {
    return { ...fund, score: null, signal: 'INSUFFICIENT_DATA', reason: '历史数据不足', subScores: {} };
  }

  const { closes, highs, lows, volumes } = extractSeries(history);
  if (closes.length < minBars) {
    return { ...fund, score: null, signal: 'INSUFFICIENT_DATA', reason: '有效数据不足', subScores: {} };
  }

  const price = fund.price || closes[closes.length - 1];
  const changePct = fund.changePct || 0;

  // === 计算所有指标 ===
  const ma5 = calcSMA(closes, 5);
  const ma10 = calcSMA(closes, 10);
  const ma20 = calcSMA(closes, 20);
  const ma60 = closes.length >= 60 ? calcSMA(closes, 60) : null;

  const rsi = calcRSI(closes);
  const macd = calcMACD(closes);
  const kdj = highs.some(h => h > 0) ? calcKDJ(highs, lows, closes) : calcKDJ(null, null, closes);
  const atr = calcATR(highs, lows, closes);
  const volDivergence = detectVolumePriceDivergence(closes, volumes);
  const momentumQuality = calcMomentumQuality(closes);
  const sharpe = calcSharpeRatio(closes);
  const hlTrend = detectHighLowTrend(highs.some(h => h > 0) ? highs : closes,
    lows.some(l => l > 0) ? lows : closes);

  // 动量
  const momentum5 = closes.length >= 5 ? (closes[closes.length - 1] / closes[closes.length - 5] - 1) : 0;
  const momentum10 = closes.length >= 10 ? (closes[closes.length - 1] / closes[closes.length - 10] - 1) : 0;
  const momentum20 = closes.length >= 20 ? (closes[closes.length - 1] / closes[closes.length - 20] - 1) : 0;

  // 最大回撤
  let peak = closes[0], maxDD = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    maxDD = Math.min(maxDD, (c - peak) / peak);
  }

  // === 动态权重评分 ===
  const scores = {};

  // 1. 均线趋势 (20分)
  const lastMA5 = ma5[ma5.length - 1], lastMA10 = ma10[ma10.length - 1], lastMA20 = ma20[ma20.length - 1];
  scores.ma = 0;
  if (price > lastMA5) scores.ma += 6;
  if (price > lastMA10) scores.ma += 5;
  if (price > lastMA20) scores.ma += 5;
  if (lastMA5 > lastMA10 && lastMA10 > lastMA20) scores.ma += 4;
  else if (lastMA5 < lastMA10 && lastMA10 < lastMA20) scores.ma += 0;
  else scores.ma += 2;

  // 2. MACD (15分)
  scores.macd = 5; // 基础分
  if (macd) {
    if (macd.histogram > 0) scores.macd += 4;
    if (macd.strengthening) scores.macd += 3;
    if (macd.goldenCross) scores.macd += 3;
    else if (macd.deathCross) scores.macd -= 3;
    if (macd.diverging) scores.macd -= 2; // 顶背离惩罚
  }

  // 3. RSI (12分)
  scores.rsi = 0;
  if (rsi !== null) {
    if (rsi < 25) scores.rsi = 11;      // 极度超卖, 反转机会大
    else if (rsi < 35) scores.rsi = 9;
    else if (rsi <= 60) scores.rsi = 7;
    else if (rsi < 75) scores.rsi = 5;
    else scores.rsi = 2;                 // 超买风险
  }

  // 4. KDJ (8分)
  scores.kdj = 4;
  if (kdj) {
    if (kdj.zone === '超卖') scores.kdj += 4;
    else if (kdj.zone === '超买') scores.kdj -= 2;
    if (kdj.goldenCross) scores.kdj += 2;
  }

  // 5. 量价关系 (10分)
  scores.volumePrice = 5;
  if (volDivergence === 'healthy_uptrend') scores.volumePrice += 5;
  else if (volDivergence === 'bullish_divergence') scores.volumePrice += 4;
  else if (volDivergence === 'bearish_divergence') scores.volumePrice -= 3;
  else if (volDivergence === 'weak_downtrend') scores.volumePrice -= 1;

  // 6. 动量和动量质量 (12分)
  scores.momentum = 4;
  if (momentum5 > 0.02) scores.momentum += 2;
  if (momentum10 > 0.03) scores.momentum += 2;
  if (momentum20 > 0.05) scores.momentum += 2;
  if (momentumQuality && momentumQuality > 1.5) scores.momentum += 4;
  else if (momentumQuality && momentumQuality > 1.0) scores.momentum += 2;
  else if (momentumQuality && momentumQuality < 0.7) scores.momentum -= 2;

  // 7. 趋势结构 (8分)
  scores.trend = 4;
  if (hlTrend === 'uptrend') scores.trend += 4;
  else if (hlTrend === 'weakening_uptrend') scores.trend += 1;
  else if (hlTrend === 'downtrend') scores.trend -= 3;
  else if (hlTrend === 'potential_reversal') scores.trend += 3;

  // 8. 风险调整 (10分) — 夏普 + 回撤
  scores.risk = 5;
  if (sharpe !== null && sharpe > 1.5) scores.risk += 3;
  else if (sharpe !== null && sharpe > 0.5) scores.risk += 1;
  else if (sharpe !== null && sharpe < 0) scores.risk -= 3;
  if (maxDD > -0.05) scores.risk += 2;
  else if (maxDD < -0.15) scores.risk -= 3;
  else if (maxDD < -0.10) scores.risk -= 1;

  // 9. 波动率适应性 (5分)
  scores.volatility = 3;
  if (atr && atr.atrPct < 1.5) scores.volatility += 2; // 低波动适合持有
  else if (atr && atr.atrPct > 3) scores.volatility -= 1; // 高波动风险

  // 总分
  const componentScores = [
    { name: '均线趋势', score: scores.ma, max: 20, weight: 1.0 },
    { name: 'MACD', score: scores.macd, max: 15, weight: 1.0 },
    { name: 'RSI', score: scores.rsi, max: 12, weight: 1.0 },
    { name: 'KDJ', score: scores.kdj, max: 8, weight: 0.8 },
    { name: '量价关系', score: scores.volumePrice, max: 10, weight: 1.0 },
    { name: '动量质量', score: scores.momentum, max: 12, weight: 1.0 },
    { name: '趋势结构', score: scores.trend, max: 8, weight: 1.0 },
    { name: '风险调整', score: scores.risk, max: 10, weight: 1.2 },
    { name: '波动适应', score: scores.volatility, max: 5, weight: 0.8 },
  ];

  let totalScore = 0, totalWeight = 0;
  for (const cs of componentScores) {
    totalScore += cs.score * cs.weight;
    totalWeight += cs.max * cs.weight;
  }
  const normalizedScore = Math.round(totalScore / totalWeight * 100 * 10) / 10;

  // 信号判定
  let signal;
  if (normalizedScore >= 72) signal = 'STRONG_BUY';
  else if (normalizedScore >= 58) signal = 'BUY';
  else if (normalizedScore >= 42) signal = 'HOLD';
  else if (normalizedScore >= 28) signal = 'WEAK';
  else signal = 'SELL';

  // 特殊信号调整
  if (macd?.goldenCross && rsi !== null && rsi < 55 && signal === 'BUY') signal = 'STRONG_BUY';
  if (macd?.deathCross && price < lastMA20) signal = 'SELL';
  if (volDivergence === 'bearish_divergence' && signal === 'STRONG_BUY') signal = 'BUY';

  return {
    ...fund,
    price,
    changePct,
    score: normalizedScore,
    signal,
    subScores: componentScores,
    indicators: {
      rsi, macd, kdj, atr, momentumQuality, sharpe, hlTrend,
      volDivergence, maxDD, momentum5, momentum10, momentum20,
      ma5: lastMA5, ma10: lastMA10, ma20: lastMA20,
      ma60: ma60 ? ma60[ma60.length - 1] : null,
    },
  };
}

/**
 * 对所有基金评分并排名
 */
function rankFundsV2(allData) {
  const { detectMarketRegime, computeMarketTemperature } = require('./market');

  const marketRegime = detectMarketRegime(allData.indexes);
  const marketTemp = computeMarketTemperature(allData.indexes);

  const analyzed = allData.funds
    .map(f => scoreFund(f))
    .filter(f => f.score !== null);

  analyzed.sort((a, b) => b.score - a.score);

  return {
    marketRegime,
    marketTemp,
    rankedFunds: analyzed,
    fetchTime: allData.fetchTime,
    northFlow: allData.northFlow,
    indexes: allData.indexes,
  };
}

module.exports = { scoreFund, rankFundsV2, calcRSI, calcMACD, calcKDJ, calcATR, calcSharpeRatio };
