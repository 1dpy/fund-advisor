/**
 * 技术分析模块
 * 对每只基金进行多维度打分, 生成交易信号
 */

const { TECH_CONFIG } = require('./config');

/**
 * 计算简单移动平均线
 */
function calcSMA(data, period) {
  if (!data || data.length < period) return [];
  const result = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += data[j];
    }
    result.push(sum / period);
  }
  return result;
}

/**
 * 计算指数移动平均线
 */
function calcEMA(data, period) {
  if (!data || data.length < period) return [];
  const result = [];
  const k = 2 / (period + 1);

  // 初始值用SMA
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(ema);

  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

/**
 * 计算RSI
 */
function calcRSI(closes, period = TECH_CONFIG.rsiPeriod) {
  if (!closes || closes.length < period + 1) return null;

  let gains = 0, losses = 0;

  // 初始平均值
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  const rsiValues = [];

  // 首次RSI
  if (avgLoss === 0) rsiValues.push(100);
  else {
    const rs = avgGain / avgLoss;
    rsiValues.push(100 - (100 / (1 + rs)));
  }

  // 后续RSI使用平滑算法
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) rsiValues.push(100);
    else {
      const rs = avgGain / avgLoss;
      rsiValues.push(100 - (100 / (1 + rs)));
    }
  }

  return rsiValues[rsiValues.length - 1];
}

/**
 * 计算MACD
 * 返回: { MACD, signal, histogram, goldenCross, deathCross }
 */
function calcMACD(closes) {
  if (!closes || closes.length < TECH_CONFIG.macdSlow + TECH_CONFIG.macdSignal) {
    return null;
  }

  const emaFast = calcEMA(closes, TECH_CONFIG.macdFast);
  const emaSlow = calcEMA(closes, TECH_CONFIG.macdSlow);

  // 对齐长度
  const offset = emaSlow.length - emaFast.length;
  const alignedEmaFast = emaFast.slice(offset);

  // DIF = EMA12 - EMA26
  const dif = alignedEmaFast.map((v, i) => v - emaSlow[i]);

  // DEA = EMA9 of DIF
  const dea = calcEMA(dif, TECH_CONFIG.macdSignal);

  // MACD柱 = 2 * (DIF - DEA)
  const difAligned = dif.slice(dif.length - dea.length);
  const histogram = difAligned.map((v, i) => 2 * (v - dea[i]));

  const lastHist = histogram[histogram.length - 1];
  const prevHist = histogram.length >= 2 ? histogram[histogram.length - 2] : 0;
  const lastDif = dif[dif.length - 1];
  const prevDif = dif.length >= 2 ? dif[dif.length - 2] : 0;

  // 金叉: DIF上穿DEA (柱由负转正)
  const goldenCross = prevHist <= 0 && lastHist > 0;
  // 死叉: DIF下穿DEA (柱由正转负)
  const deathCross = prevHist >= 0 && lastHist < 0;

  return {
    dif: lastDif,
    dea: dea[dea.length - 1],
    histogram: lastHist,
    goldenCross,
    deathCross,
    trend: lastHist > 0 ? 'bullish' : 'bearish',
  };
}

/**
 * 计算布林带
 */
function calcBollingerBands(closes, period = 20, multiplier = 2) {
  if (!closes || closes.length < period) return null;

  const sma = calcSMA(closes, period);
  const lastSMA = sma[sma.length - 1];

  // 计算标准差
  const recent = closes.slice(-period);
  const mean = recent.reduce((a, b) => a + b, 0) / period;
  const variance = recent.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: lastSMA + multiplier * stdDev,
    middle: lastSMA,
    lower: lastSMA - multiplier * stdDev,
    bandwidth: (2 * multiplier * stdDev) / lastSMA,
    position: (closes[closes.length - 1] - lastSMA) / (multiplier * stdDev),
  };
}

/**
 * 计算成交量趋势
 */
function calcVolumeTrend(volumes) {
  if (!volumes || volumes.length < TECH_CONFIG.volLongMA) return null;

  const shortMA = calcSMA(volumes, TECH_CONFIG.volShortMA);
  const longMA = calcSMA(volumes, TECH_CONFIG.volLongMA);

  const lastShort = shortMA[shortMA.length - 1];
  const lastLong = longMA[longMA.length - 1];

  return {
    ratio: lastLong > 0 ? lastShort / lastLong : 1,
    trend: lastShort > lastLong ? 'volume_up' : 'volume_down',
  };
}

/**
 * 计算价格动量 (过去N日涨跌幅)
 */
function calcMomentum(prices, period) {
  if (!prices || prices.length < period) return null;
  const current = prices[prices.length - 1];
  const past = prices[prices.length - period];
  if (past === 0) return 0;
  return (current - past) / past;
}

/**
 * 计算最大回撤
 */
function calcMaxDrawdown(prices) {
  if (!prices || prices.length < 2) return 0;
  let maxDrawdown = 0;
  let peak = prices[0];

  for (const price of prices) {
    if (price > peak) peak = price;
    const dd = (price - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  return maxDrawdown;
}

/**
 * 综合技术分析打分 (0-100)
 */
function analyzeFund(fund) {
  const { history } = fund;
  if (!history || history.length < TECH_CONFIG.longMA + TECH_CONFIG.macdSlow) {
    return {
      ...fund,
      score: null,
      signal: 'INSUFFICIENT_DATA',
      reason: '历史数据不足, 无法分析',
      details: {},
    };
  }

  // 提取价格序列
  const closes = history.map(h => h.close || h.nav).filter(v => v && !isNaN(v));
  const volumes = history.map(h => h.volume || 0);
  const price = fund.price || fund.nav || fund.valuation || closes[closes.length - 1];
  const changePct = fund.changePct || fund.gzPercent || 0;

  if (closes.length < TECH_CONFIG.longMA + TECH_CONFIG.macdSlow) {
    return {
      ...fund,
      score: null,
      signal: 'INSUFFICIENT_DATA',
      reason: '有效价格数据不足',
      details: {},
    };
  }

  // === 计算各项指标 ===
  const ma5 = calcSMA(closes, TECH_CONFIG.shortMA);
  const ma10 = calcSMA(closes, TECH_CONFIG.midMA);
  const ma20 = calcSMA(closes, TECH_CONFIG.longMA);
  const rsi = calcRSI(closes);
  const macd = calcMACD(closes);
  const bollinger = calcBollingerBands(closes);
  const momentum5 = calcMomentum(closes, 5);
  const momentum10 = calcMomentum(closes, 10);
  const momentum20 = calcMomentum(closes, 20);
  const volTrend = calcVolumeTrend(volumes);
  const maxDD = calcMaxDrawdown(closes);

  const lastMA5 = ma5[ma5.length - 1];
  const lastMA10 = ma10[ma10.length - 1];
  const lastMA20 = ma20[ma20.length - 1];
  const prevMA5 = ma5.length >= 2 ? ma5[ma5.length - 2] : lastMA5;
  const prevMA10 = ma10.length >= 2 ? ma10[ma10.length - 2] : lastMA10;

  // === 打分体系 (总分100) ===

  // 1. 均线趋势 (25分)
  let maScore = 0;
  const maArrangement = []; // 均线排列描述

  // 价格与均线关系
  if (price > lastMA5) { maScore += 5; maArrangement.push('价格>MA5'); }
  if (price > lastMA10) { maScore += 5; maArrangement.push('价格>MA10'); }
  if (price > lastMA20) { maScore += 5; maArrangement.push('价格>MA20'); }

  // 多头排列 (MA5 > MA10 > MA20)
  if (lastMA5 > lastMA10 && lastMA10 > lastMA20) {
    maScore += 5;
    maArrangement.push('多头排列↑');
  } else if (lastMA5 < lastMA10 && lastMA10 < lastMA20) {
    maScore += 1;
    maArrangement.push('空头排列↓');
  } else {
    maScore += 3;
    maArrangement.push('均线缠绕');
  }

  // 短均线斜率 (MA5上升)
  if (lastMA5 > prevMA5) { maScore += 3; maArrangement.push('MA5上升'); }
  if (lastMA10 > prevMA10) { maScore += 2; maArrangement.push('MA10上升'); }

  // 2. MACD信号 (20分)
  let macdScore = 0;
  const macdSignal = [];

  if (macd) {
    if (macd.histogram > 0) { macdScore += 8; macdSignal.push('MACD正值'); }
    else { macdScore += 2; macdSignal.push('MACD负值'); }

    // 柱状线变大(动能增强)
    if (Math.abs(macd.histogram) > Math.abs(history.length >= 2 ?
      (() => { const prevM = calcMACD(closes.slice(0, -1)); return prevM ? prevM.histogram : 0; })() : 0)) {
      macdScore += 4;
      macdSignal.push('动能增强');
    }

    if (macd.goldenCross) { macdScore += 8; macdSignal.push('★金叉'); }
    else if (macd.deathCross) { macdScore += 0; macdSignal.push('★死叉'); }
    else { macdScore += 4; }
  }

  // 3. RSI (15分)
  let rsiScore = 0;
  let rsiZone = '';
  if (rsi !== null) {
    if (rsi < TECH_CONFIG.rsiOversold) {
      rsiScore = 12;
      rsiZone = '超卖区(买入机会)';
    } else if (rsi < 40) {
      rsiScore = 9;
      rsiZone = '偏弱';
    } else if (rsi <= 60) {
      rsiScore = 7;
      rsiZone = '中性';
    } else if (rsi < TECH_CONFIG.rsiOverbought) {
      rsiScore = 4;
      rsiZone = '偏强';
    } else {
      rsiScore = 2;
      rsiZone = '超买区(注意风险)';
    }
  }

  // 4. 动量 (10分)
  let momentumScore = 0;
  if (momentum5 !== null) {
    if (momentum5 > 0.02) momentumScore += 3;       // 短期强势
    else if (momentum5 < -0.03) momentumScore += 0;  // 短期弱势
    else momentumScore += 2;
  }
  if (momentum10 !== null) {
    if (momentum10 > 0.03) momentumScore += 4;
    else if (momentum10 > 0) momentumScore += 2;
    else momentumScore += 1;
  }
  if (momentum20 !== null) {
    if (momentum20 > 0.05) momentumScore += 3;
    else if (momentum20 > 0) momentumScore += 2;
    else momentumScore += 1;
  }

  // 5. 布林带位置 (10分)
  let bollScore = 0;
  let bollPosition = '';
  if (bollinger) {
    if (bollinger.position < -0.8) { bollScore = 9; bollPosition = '下轨(超卖)'; }
    else if (bollinger.position < -0.3) { bollScore = 7; bollPosition = '中下轨'; }
    else if (bollinger.position <= 0.3) { bollScore = 5; bollPosition = '中轨附近'; }
    else if (bollinger.position <= 0.8) { bollScore = 3; bollPosition = '中上轨'; }
    else { bollScore = 1; bollPosition = '上轨(超买)'; }
  }

  // 6. 量能分析 (10分)
  let volumeScore = 0;
  let volumeSignal = '';
  if (volTrend) {
    if (volTrend.ratio > 1.5) { volumeScore = 8; volumeSignal = '放量'; }
    else if (volTrend.ratio > 1.0) { volumeScore = 6; volumeSignal = '温和放量'; }
    else if (volTrend.ratio > 0.7) { volumeScore = 5; volumeSignal = '正常'; }
    else { volumeScore = 3; volumeSignal = '缩量'; }
  }

  // 7. 回撤风险 (10分, 扣分项)
  let riskScore = 10;
  if (maxDD !== null) {
    if (maxDD < -0.05) riskScore -= 2;
    if (maxDD < -0.10) riskScore -= 3;
    if (maxDD < -0.15) riskScore -= 3;
  }

  const totalScore = maScore + macdScore + rsiScore + momentumScore + bollScore + volumeScore + riskScore;

  // === 生成交易信号 ===
  let signal;
  if (totalScore >= 70) signal = 'STRONG_BUY';
  else if (totalScore >= 55) signal = 'BUY';
  else if (totalScore >= 40) signal = 'HOLD';
  else if (totalScore >= 25) signal = 'WEAK';
  else signal = 'SELL';

  // 死叉且价格跌破MA20, 强制卖出信号
  if (macd?.deathCross && price < lastMA20) {
    signal = 'SELL';
  }
  // 金叉且价格站上MA10, 提高买入级别
  if (macd?.goldenCross && price > lastMA10 && rsi < 60) {
    signal = signal === 'STRONG_BUY' ? 'STRONG_BUY' : 'BUY';
  }

  return {
    ...fund,
    price,
    changePct,
    score: Math.round(totalScore * 10) / 10,
    signal,
    details: {
      ma: { ma5: lastMA5, ma10: lastMA10, ma20: lastMA20, arrangement: maArrangement.join(', '), score: maScore },
      macd: { ...macd, signals: macdSignal.join(', '), score: macdScore },
      rsi: { value: rsi !== null ? Math.round(rsi * 10) / 10 : null, zone: rsiZone, score: rsiScore },
      momentum: { m5: momentum5, m10: momentum10, m20: momentum20, score: momentumScore },
      bollinger: { ...bollinger, position: bollPosition, score: bollScore },
      volume: { ...volTrend, signal: volumeSignal, score: volumeScore },
      risk: { maxDrawdown: maxDD, score: riskScore },
    },
  };
}

/**
 * 市场整体环境评估
 */
function analyzeMarket(indexes, breadth) {
  if (!indexes || indexes.length === 0) {
    return { sentiment: 'UNKNOWN', score: 50, description: '无法获取市场数据' };
  }

  let score = 50;
  const signals = [];

  // 上证指数趋势
  const sh = indexes.find(i => i.name.includes('上证'));
  if (sh) {
    if (sh.changePct > 0.5) { score += 10; signals.push('上证强势↑'); }
    else if (sh.changePct > 0) { score += 5; signals.push('上证微涨'); }
    else if (sh.changePct > -0.5) { score -= 3; signals.push('上证微跌'); }
    else { score -= 10; signals.push('上证弱势↓'); }
  }

  // 创业板 (风险偏好指标)
  const cyb = indexes.find(i => i.name.includes('创业板'));
  if (cyb) {
    if (cyb.changePct > 1) { score += 8; signals.push('创业板强势(风险偏好高)'); }
    else if (cyb.changePct < -1) { score -= 8; signals.push('创业板弱势(避险)'); }
  }

  // 涨跌家数比
  if (breadth && breadth.upCount && breadth.downCount) {
    const ratio = breadth.upCount / (breadth.upCount + breadth.downCount);
    if (ratio > 0.6) { score += 8; signals.push('涨多跌少'); }
    else if (ratio < 0.4) { score -= 8; signals.push('跌多涨少'); }
    else { signals.push('涨跌均衡'); }
  }

  // 多指数共振
  const allUp = indexes.every(i => i.changePct > 0);
  const allDown = indexes.every(i => i.changePct < 0);
  if (allUp) { score += 5; signals.push('全线上涨(共振)'); }
  if (allDown) { score -= 5; signals.push('全线下跌(共振)'); }

  let sentiment;
  if (score >= 70) sentiment = 'BULLISH';
  else if (score >= 55) sentiment = 'SLIGHTLY_BULLISH';
  else if (score >= 45) sentiment = 'NEUTRAL';
  else if (score >= 30) sentiment = 'SLIGHTLY_BEARISH';
  else sentiment = 'BEARISH';

  return {
    sentiment,
    score: Math.round(score * 10) / 10,
    description: signals.join('; '),
    indexes: indexes.map(i => ({
      name: i.name,
      price: i.price,
      changePct: i.changePct,
    })),
  };
}

/**
 * 对关注池中的所有基金进行分析并排名
 */
function rankFunds(allData) {
  const marketEnv = analyzeMarket(allData.indexes, allData.breadth);

  // 逐只分析
  const analyzed = allData.funds
    .map(fund => analyzeFund(fund))
    .filter(f => f.score !== null);

  // 按score降序排列
  analyzed.sort((a, b) => b.score - a.score);

  return {
    marketEnv,
    rankedFunds: analyzed,
    fetchTime: allData.fetchTime,
    northFlow: allData.northFlow,
  };
}

module.exports = {
  analyzeFund,
  analyzeMarket,
  rankFunds,
  calcSMA,
  calcEMA,
  calcRSI,
  calcMACD,
  calcBollingerBands,
};
