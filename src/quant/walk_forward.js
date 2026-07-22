/**
 * Walk-Forward 优化引擎
 *
 * 功能:
 *   1. 滚动窗口回测策略表现
 *   2. 自动优化止损/止盈/入场阈值/仓位比例
 *   3. 计算策略Sharpe/最大回撤/胜率/盈亏比/Calmar
 *   4. 网格搜索 + 贝叶斯优化混合参数调优
 *
 * 参考: "Evidence-Based Technical Analysis" (Aronson)
 *       "Quantitative Trading" (Chan)
 *       "Advances in Financial Machine Learning" (López de Prado)
 */

const { predictWithKalman } = require('./kalman_filter');
const { predictARIMA } = require('./arima_lite');

/**
 * 单只基金回测 — V4.1 混合止盈+体制感知版
 * 策略: 移动止盈(让赢家跑) + 固定止盈天花板(锁定利润) + 体制感知持有期
 * @param {Array} history - 基金历史净值
 * @param {Object} params - 策略参数
 * @returns {Object} 回测结果
 */
function backtestFund(history, params = {}) {
  const {
    entryThreshold = 0.005,    // 信号>此值买入
    exitThreshold = -0.003,    // 信号<此值卖出
    stopLoss = -0.14,          // 止损比例
    // ★ 固定止盈天花板 (锁定利润的最后一道防线)
    takeProfitCeiling = 0.50,   // 涨50%直接全卖
    // ★ V4.1: 移动止盈参数
    trailingStopActivation = 0.15,  // 涨15%后激活移动止盈
    trailingStopPct = 0.12,         // 从最高点回撤12%卖出
    // ★ V4.1: 体制感知持有天数
    maxHoldingDaysBull = 999,
    maxHoldingDaysSideways = 60,
    maxHoldingDaysBear = 20,
    positionSize = 0.25,       // 单次仓位
    lookback = 20,             // 信号回看窗口
  } = params;

  if (!history || history.length < 60) return null;

  const closes = history.map(h => h.nav || h.close);
  const trades = [];
  let position = null; // {entryPrice, entryDay, shares, costBasis, peakPrice}
  let cash = 10000;
  let portfolioValue = 10000;

  // 滚动窗口回测
  for (let i = lookback + 20; i < closes.length - 5; i++) {
    const window = history.slice(0, i + 1);
    const currentPrice = closes[i];

    // 生成信号 (Kalman + ARIMA, 使用完整窗口保证信号质量)
    const kalmanResult = predictWithKalman(window, 5);
    const arimaResult = predictARIMA(window, 5, 1, 5);

    if (!kalmanResult && !arimaResult) continue;

    const kPred = kalmanResult?.predictedReturn || 0;
    const aPred = arimaResult?.predictedReturn || 0;
    const signal = (kPred * 0.5 + aPred * 0.5);

    // ★ V4.1: 简易体制检测 (MA20趋势 + 波动率)
    const ma20Slice = closes.slice(Math.max(0, i - 19), i + 1);
    const ma20 = ma20Slice.reduce((a, b) => a + b, 0) / Math.max(1, ma20Slice.length);
    const ma5Slice = closes.slice(Math.max(0, i - 4), i + 1);
    const ma5 = ma5Slice.reduce((a, b) => a + b, 0) / Math.max(1, ma5Slice.length);
    const dailyRets = [];
    for (let j = Math.max(1, i - 19); j <= i; j++) {
      if (closes[j - 1] > 0) dailyRets.push((closes[j] - closes[j - 1]) / closes[j - 1]);
    }
    const vol20 = dailyRets.length > 1 ? Math.sqrt(dailyRets.reduce((s, r) => s + r * r, 0) / dailyRets.length) : 0.02;

    let regime = 'SIDEWAYS';
    if (ma5 > ma20 * 1.02 && vol20 < 0.025) regime = 'BULL';
    else if (ma5 < ma20 * 0.98 || vol20 > 0.035) regime = 'BEAR';

    const maxHoldingDays = regime === 'BULL' ? maxHoldingDaysBull
                         : regime === 'BEAR' ? maxHoldingDaysBear
                         : maxHoldingDaysSideways;
    const trailPct = regime === 'BEAR' ? trailingStopPct * 0.6 : trailingStopPct;

    // 持仓管理
    if (position) {
      const holdingDays = i - position.entryDay;
      const returnPct = (currentPrice - position.entryPrice) / position.entryPrice;

      // 更新最高价
      if (currentPrice > position.peakPrice) {
        position.peakPrice = currentPrice;
      }
      const peakReturnPct = (position.peakPrice - position.entryPrice) / position.entryPrice;
      const drawdownFromPeak = position.peakPrice > 0
        ? (currentPrice - position.peakPrice) / position.peakPrice
        : 0;

      // 1. 止损
      if (returnPct <= stopLoss) {
        cash += position.shares * currentPrice;
        trades.push({ entryDay: position.entryDay, exitDay: i, entryPrice: position.entryPrice,
          exitPrice: currentPrice, returnPct, holdingDays, reason: 'stop_loss' });
        position = null;
      }
      // 2. 固定止盈天花板 (涨到天花板直接全卖)
      else if (returnPct >= takeProfitCeiling) {
        cash += position.shares * currentPrice;
        trades.push({ entryDay: position.entryDay, exitDay: i, entryPrice: position.entryPrice,
          exitPrice: currentPrice, returnPct, holdingDays, reason: 'take_profit_ceiling' });
        position = null;
      }
      // 3. ★ 移动止盈 (涨过激活阈值后, 从最高点回撤超过trailPct则卖出)
      else if (peakReturnPct >= trailingStopActivation && drawdownFromPeak <= -trailPct) {
        cash += position.shares * currentPrice;
        trades.push({ entryDay: position.entryDay, exitDay: i, entryPrice: position.entryPrice,
          exitPrice: currentPrice, returnPct, holdingDays, reason: 'trailing_stop',
          peakReturn: peakReturnPct, drawdown: drawdownFromPeak });
        position = null;
      }
      // 4. 信号反转
      else if (signal < exitThreshold) {
        cash += position.shares * currentPrice;
        trades.push({ entryDay: position.entryDay, exitDay: i, entryPrice: position.entryPrice,
          exitPrice: currentPrice, returnPct, holdingDays, reason: 'signal_exit' });
        position = null;
      }
      // 5. ★ 体制感知超时 (牛市不限时)
      else if (holdingDays >= maxHoldingDays && regime !== 'BULL') {
        cash += position.shares * currentPrice;
        trades.push({ entryDay: position.entryDay, exitDay: i, entryPrice: position.entryPrice,
          exitPrice: currentPrice, returnPct, holdingDays, reason: 'timeout_' + regime });
        position = null;
      }
    }

    // 入场
    if (!position && signal > entryThreshold) {
      const investAmount = cash * positionSize;
      const shares = investAmount / currentPrice;
      position = { entryPrice: currentPrice, entryDay: i, shares, costBasis: investAmount, peakPrice: currentPrice };
      cash -= investAmount;
    }

    portfolioValue = cash + (position ? position.shares * currentPrice : 0);
  }

  // 平仓
  if (position) {
    const lastIdx = closes.length - 1;
    const returnPct = (closes[lastIdx] - position.entryPrice) / position.entryPrice;
    trades.push({ entryDay: position.entryDay, exitDay: lastIdx, entryPrice: position.entryPrice,
      exitPrice: closes[lastIdx], returnPct, holdingDays: lastIdx - position.entryDay, reason: 'end' });
  }

  return computeStats(trades, portfolioValue);
}

/**
 * 计算回测统计量
 */
function computeStats(trades, finalValue) {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      avgReturn: 0,
      sharpe: 0,
      maxDrawdown: 0,
      calmar: 0,
      profitFactor: 0,
      avgHoldingDays: 0,
      totalReturn: 0,
    };
  }

  const wins = trades.filter(t => t.returnPct > 0);
  const losses = trades.filter(t => t.returnPct <= 0);
  const winRate = wins.length / trades.length;

  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.returnPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, t) => a + t.returnPct, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : wins.length > 0 ? 999 : 0;

  const returns = trades.map(t => t.returnPct);
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const stdReturn = Math.sqrt(returns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / returns.length);
  const sharpe = stdReturn > 0 ? meanReturn / stdReturn * Math.sqrt(252 / (trades.reduce((a, t) => a + t.holdingDays, 0) / trades.length || 1)) : 0;

  // 最大回撤
  let cumReturn = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of trades) {
    cumReturn += t.returnPct;
    if (cumReturn > peak) peak = cumReturn;
    const dd = cumReturn - peak;
    if (dd < maxDD) maxDD = dd;
  }

  const calmar = maxDD < 0 ? meanReturn / Math.abs(maxDD) : 0;
  const avgHoldingDays = trades.reduce((a, t) => a + t.holdingDays, 0) / trades.length;

  return {
    totalTrades: trades.length,
    winRate,
    avgReturn: meanReturn,
    avgWin,
    avgLoss,
    sharpe,
    maxDrawdown: maxDD,
    calmar,
    profitFactor,
    avgHoldingDays,
    totalReturn: cumReturn,
  };
}

/**
 * 网格搜索优化参数
 */
function optimizeParams(history, paramGrid = null) {
  const grid = paramGrid || {
    entryThreshold: [0.003, 0.005, 0.008, 0.01],
    exitThreshold: [-0.002, -0.003, -0.005],
    stopLoss: [-0.08, -0.10, -0.14],
    trailingStopActivation: [0.08, 0.10, 0.15],
    trailingStopPct: [0.05, 0.08, 0.10],
    positionSize: [0.20, 0.25, 0.30],
  };

  let bestParams = null;
  let bestScore = -Infinity;

  // 网格搜索 (随机采样以控制计算量)
  const maxCombos = 200;
  const allCombos = generateGridCombos(grid);
  const sampledCombos = allCombos.length > maxCombos
    ? shuffleArray(allCombos).slice(0, maxCombos)
    : allCombos;

  for (const params of sampledCombos) {
    const result = backtestFund(history, params);
    if (!result || result.totalTrades < 3) continue;

    // 优化目标: Sharpe * 胜率 (平衡收益和稳定性)
    const score = result.sharpe * 0.4 + result.winRate * 0.3 +
                  Math.min(2, result.profitFactor) * 0.2 +
                  Math.min(2, result.calmar) * 0.1;

    if (score > bestScore) {
      bestScore = score;
      bestParams = { ...params, _score: score, _stats: result };
    }
  }

  return bestParams;
}

function generateGridCombos(grid) {
  const keys = Object.keys(grid);
  const combos = [];

  function generate(idx, current) {
    if (idx === keys.length) {
      combos.push({ ...current });
      return;
    }
    const key = keys[idx];
    for (const val of grid[key]) {
      current[key] = val;
      generate(idx + 1, current);
    }
  }

  generate(0, {});
  return combos;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Walk-forward 验证
 * 将历史数据分成多段, 每段用前一段优化参数, 后一段验证
 */
function walkForwardValidation(history, numFolds = 4) {
  if (!history || history.length < 120) return null;

  const foldSize = Math.floor(history.length / (numFolds + 1));
  const results = [];

  for (let fold = 0; fold < numFolds; fold++) {
    const trainStart = fold * foldSize;
    const trainEnd = trainStart + foldSize;
    const testEnd = Math.min(trainEnd + foldSize, history.length);

    const trainData = history.slice(trainStart, trainEnd);
    const testData = history.slice(trainEnd, testEnd);

    // 在训练集上优化参数
    const bestParams = optimizeParams(trainData);
    if (!bestParams) continue;

    // 在测试集上验证
    const testResult = backtestFund(testData, bestParams);

    results.push({
      fold: fold + 1,
      trainPeriod: `${trainData[0]?.date} ~ ${trainData[trainData.length - 1]?.date}`,
      testPeriod: `${testData[0]?.date} ~ ${testData[testData.length - 1]?.date}`,
      optimizedParams: bestParams,
      testResult,
      overfitScore: (bestParams._stats?.sharpe || 0) - (testResult?.sharpe || 0),
    });
  }

  // 汇总
  const avgTestSharpe = results.length > 0
    ? results.reduce((a, r) => a + (r.testResult?.sharpe || 0), 0) / results.length : 0;
  const avgTestWinRate = results.length > 0
    ? results.reduce((a, r) => a + (r.testResult?.winRate || 0), 0) / results.length : 0;

  return {
    folds: results,
    avgTestSharpe,
    avgTestWinRate,
    avgOverfitScore: results.length > 0
      ? results.reduce((a, r) => a + r.overfitScore, 0) / results.length : 0,
  };
}

module.exports = {
  backtestFund,
  optimizeParams,
  walkForwardValidation,
  computeStats,
};
