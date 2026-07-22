/**
 * 贝叶斯参数优化
 * 用回测数据自动调优 止损/止盈/仓位 参数
 *
 * 方法: 高斯过程代理模型 + 期望改进(EI)采集函数
 * 搜索空间: stopLoss(-5%~-15%), takeProfit(15%~35%), cashReserve(0%~15%)
 * 目标: 最大化 (收益 - 2*最大回撤) — 风险调整收益
 */

function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

/**
 * 高斯核
 */
function rbfKernel(x1, x2, lengthScale = 1.0) {
  let dist = 0;
  for (let i = 0; i < x1.length; i++) dist += (x1[i] - x2[i]) ** 2;
  return Math.exp(-0.5 * dist / (lengthScale * lengthScale));
}

/**
 * 高斯过程回归预测
 */
function gpPredict(Xtrain, ytrain, Xtest, lengthScale = 1.0, noise = 0.01) {
  const n = Xtrain.length;
  // 构建核矩阵 K
  const K = [];
  for (let i = 0; i < n; i++) {
    K[i] = [];
    for (let j = 0; j < n; j++) {
      K[i][j] = rbfKernel(Xtrain[i], Xtrain[j], lengthScale) + (i === j ? noise : 0);
    }
  }
  // K逆 (简化: 对角近似)
  const KInvDiag = K.map((row, i) => 1 / Math.max(row[i], 1e-6));
  // 预测
  const preds = Xtest.map(xt => {
    const ks = Xtrain.map((xi, i) => rbfKernel(xt, xi, lengthScale));
    let mu = 0;
    for (let i = 0; i < n; i++) mu += ks[i] * KInvDiag[i] * ytrain[i];
    let varPred = rbfKernel(xt, xt, lengthScale) + noise;
    for (let i = 0; i < n; i++) varPred -= ks[i] * ks[i] * KInvDiag[i];
    return { mu, sigma: Math.sqrt(Math.max(varPred, 1e-6)) };
  });
  return preds;
}

/**
 * 期望改进 (Expected Improvement)
 */
function expectedImprovement(mu, sigma, bestY) {
  if (sigma < 1e-6) return 0;
  const z = (mu - bestY) / sigma;
  // 标准正态CDF和PDF近似
  const cdf = 1 / (1 + Math.exp(-1.702 * z)); // logistic近似
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  return (mu - bestY) * cdf + sigma * pdf;
}

/**
 * 模拟回测结果 (简化版: 用历史数据估算给定参数的表现)
 * @param {Array} historyReturns - 基金历史日收益序列
 * @param {Object} params - { stopLoss, takeProfit, cashReserve }
 */
function simulatePerformance(historyReturns, params) {
  if (!historyReturns || historyReturns.length < 20) return 0;

  const { stopLoss, takeProfit, cashReserve } = params;
  let portfolioValue = 1.0;
  let peak = 1.0;
  let maxDD = 0;
  let inPosition = true;

  for (let i = 0; i < historyReturns.length; i++) {
    const ret = historyReturns[i];
    if (inPosition) {
      portfolioValue *= (1 + ret * (1 - cashReserve));
      if (portfolioValue > peak) peak = portfolioValue;
      const dd = (portfolioValue - peak) / peak;
      if (dd < maxDD) maxDD = dd;
      // 止损
      if (dd <= stopLoss) inPosition = false;
      // 止盈(从近期低点算)
      const recentLow = Math.min(...historyReturns.slice(Math.max(0, i - 10), i + 1).map(() => portfolioValue).concat(portfolioValue));
      if ((portfolioValue - recentLow) / recentLow >= takeProfit) {
        portfolioValue *= 0.99; // 止盈出场
        inPosition = false;
      }
    } else {
      // 空仓等信号: 如果连跌3天, 重新入场
      if (i >= 3) {
        const recent = historyReturns.slice(i - 3, i + 1);
        if (recent.filter(r => r < 0).length >= 2) inPosition = true;
      }
    }
  }

  const totalReturn = portfolioValue - 1.0;
  const score = totalReturn - 2 * Math.abs(maxDD); // 风险调整收益
  return score;
}

/**
 * 贝叶斯优化主函数
 */
function optimizeParameters(fundHistories, nIterations = 30) {
  if (!fundHistories || Object.keys(fundHistories).length === 0) return null;

  // 收集所有基金的日收益
  const allReturns = [];
  for (const hist of Object.values(fundHistories)) {
    if (!hist || hist.length < 20) continue;
    const closes = hist.map(h => h.close || h.nav || 0).filter(v => v > 0);
    for (let i = 1; i < closes.length; i++) {
      if (closes[i-1] > 0) allReturns.push((closes[i] - closes[i-1]) / closes[i-1]);
    }
  }
  if (allReturns.length < 20) return null;

  // 搜索空间
  const bounds = {
    stopLoss: [-0.15, -0.05],     // -15% to -5%
    takeProfit: [0.15, 0.35],     // 15% to 35%
    cashReserve: [0.0, 0.15],     // 0% to 15%
  };

  // 初始采样 (Latin Hypercube简化: 随机)
  const Xtrain = [];
  const ytrain = [];
  for (let i = 0; i < 10; i++) {
    const x = [
      bounds.stopLoss[0] + Math.random() * (bounds.stopLoss[1] - bounds.stopLoss[0]),
      bounds.takeProfit[0] + Math.random() * (bounds.takeProfit[1] - bounds.takeProfit[0]),
      bounds.cashReserve[0] + Math.random() * (bounds.cashReserve[1] - bounds.cashReserve[0]),
    ];
    const params = { stopLoss: x[0], takeProfit: x[1], cashReserve: x[2] };
    const score = simulatePerformance(allReturns, params);
    Xtrain.push(x);
    ytrain.push(score);
  }

  let bestIdx = ytrain.indexOf(Math.max(...ytrain));
  let bestX = Xtrain[bestIdx];
  let bestY = ytrain[bestIdx];

  // 贝叶斯优化迭代
  for (let iter = 0; iter < nIterations - 10; iter++) {
    // GP预测
    const preds = gpPredict(Xtrain, ytrain, Xtrain);
    const bestSoFar = Math.max(...ytrain);

    // 找EI最大的点
    let bestEI = -Infinity;
    let candidateX = null;
    // 随机搜索100个候选点
    for (let j = 0; j < 100; j++) {
      const x = [
        bounds.stopLoss[0] + Math.random() * (bounds.stopLoss[1] - bounds.stopLoss[0]),
        bounds.takeProfit[0] + Math.random() * (bounds.takeProfit[1] - bounds.takeProfit[0]),
        bounds.cashReserve[0] + Math.random() * (bounds.cashReserve[1] - bounds.cashReserve[0]),
      ];
      const pred = gpPredict(Xtrain, ytrain, [x], 1.0, 0.01)[0];
      const ei = expectedImprovement(pred.mu, pred.sigma, bestSoFar);
      if (ei > bestEI) { bestEI = ei; candidateX = x; }
    }

    if (candidateX) {
      const params = { stopLoss: candidateX[0], takeProfit: candidateX[1], cashReserve: candidateX[2] };
      const score = simulatePerformance(allReturns, params);
      Xtrain.push(candidateX);
      ytrain.push(score);
      if (score > bestY) { bestY = score; bestX = candidateX; }
    }
  }

  return {
    optimized: {
      stopLoss: Math.round(bestX[0] * 100) / 100,
      takeProfit: Math.round(bestX[1] * 100) / 100,
      cashReserve: Math.round(bestX[2] * 100) / 100,
    },
    score: Math.round(bestY * 10000) / 100,
    samples: Xtrain.length,
  };
}

module.exports = { optimizeParameters, simulatePerformance };
