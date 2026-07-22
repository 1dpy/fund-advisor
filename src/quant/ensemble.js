/**
 * 多模型集成信号 — 3个独立模型投票共识
 *
 * 模型:
 *   1. 趋势跟踪: MA5/MA20斜率, MACD方向
 *   2. 均值回复: RSI/Bollinger极端位置
 *   3. 动量: 价格速度+加速度
 *
 * 输出: 共识信号 + 置信度
 */

function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

/**
 * 模型1: 趋势跟踪信号
 * 输入: 价格序列
 * 输出: -1(空) ~ +1(多)
 */
function trendSignal(closes) {
  if (!closes || closes.length < 25) return 0;
  const ma5 = closes.slice(-5).reduce((s,c)=>s+c,0)/5;
  const ma10 = closes.slice(-10).reduce((s,c)=>s+c,0)/10;
  const ma20 = closes.slice(-20).reduce((s,c)=>s+c,0)/20;
  const price = closes[closes.length-1];

  let score = 0;
  if (price > ma5) score += 0.3;
  if (ma5 > ma10) score += 0.3;
  if (ma10 > ma20) score += 0.4;

  if (ma5 > ma10 && ma10 > ma20 && price > ma5) score = Math.min(score + 0.2, 1.0);
  if (ma5 < ma10 && ma10 < ma20 && price < ma5) score = Math.max(score - 0.3, -1.0);

  return Math.round(score*100)/100;
}

/**
 * 模型2: 均值回复信号
 * 价格远离均线→回归
 */
function meanReversionSignal(closes) {
  if (!closes || closes.length < 20) return 0;
  const price = closes[closes.length-1];
  const ma20 = closes.slice(-20).reduce((s,c)=>s+c,0)/20;
  const std = Math.sqrt(closes.slice(-20).reduce((s,c)=>s+(c-ma20)**2,0)/20);

  // Bollinger偏离度 (以σ为单位)
  const z = std > 0 ? (price - ma20) / std : 0;

  // 超卖反弹
  if (z < -2) return 0.8;
  if (z < -1.5) return 0.5;
  if (z < -1) return 0.3;
  // 超买回调
  if (z > 2) return -0.8;
  if (z > 1.5) return -0.5;
  if (z > 1) return -0.3;
  return 0;
}

/**
 * 模型3: 动量信号
 * 速度(短期) + 加速度(短期-中期)
 */
function momentumSignal(closes) {
  if (!closes || closes.length < 15) return 0;
  const price = closes[closes.length-1];

  const mom3 = (price / closes[closes.length-3] - 1) * 3;
  const mom5 = (price / closes[closes.length-5] - 1);
  const mom10 = price / closes[closes.length-10] - 1;

  const velocity = mom5;
  const acceleration = mom5 - mom10;

  let score = velocity * 5 + acceleration * 3;
  // 动量加速 = 趋势健康
  if (velocity > 0.02 && acceleration > 0.01) score += 0.3;
  // 动量减速 = 动能减弱
  if (velocity > 0 && acceleration < -0.02) score -= 0.4;
  // 负动量收窄 = 可能反转
  if (velocity < -0.02 && acceleration > 0.02) score += 0.5;

  return Math.round(Math.max(-1, Math.min(1, score))*100)/100;
}

/**
 * 集成投票
 * @returns { signal: -1|0|1, confidence: 0-1, details: {} }
 */
function ensembleVote(closes) {
  if (!closes || closes.length < 25) return { signal: 0, confidence: 0, details: {} };

  const trend = trendSignal(closes);
  const mr = meanReversionSignal(closes);
  const mom = momentumSignal(closes);

  // 加权平均
  const weights = { trend: 0.4, mr: 0.2, mom: 0.4 };
  let weighted = trend * weights.trend + mr * weights.mr + mom * weights.mom;

  // 共识度: 三个模型方向的一致性
  const directions = [Math.sign(trend), Math.sign(mr), Math.sign(mom)];
  const posVotes = directions.filter(d => d > 0).length;
  const negVotes = directions.filter(d => d < 0).length;
  const agreement = posVotes > negVotes ? posVotes/3 : negVotes/3;

  // 分歧时降低信号强度
  if (agreement < 0.67 && Math.abs(weighted) < 0.3) weighted *= 0.5;
  // 一致时放大
  if (agreement === 1) weighted *= 1.3;

  const signal = Math.round(Math.max(-1, Math.min(1, weighted))*100)/100;
  const confidence = Math.round(Math.abs(signal) * agreement * 100)/100;

  return {
    signal,
    confidence,
    agreement: Math.round(agreement*100)/100,
    details: { trend: Math.round(trend*100)/100, mr: Math.round(mr*100)/100, mom: Math.round(mom*100)/100 },
  };
}

module.exports = { ensembleVote, trendSignal, meanReversionSignal, momentumSignal };
