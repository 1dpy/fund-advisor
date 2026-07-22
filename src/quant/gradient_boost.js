/**
 * Gradient Boosting Lite — 梯度提升收益预测器
 *
 * 纯JS实现的简化版GBDT:
 *   - 串行训练多棵回归树, 每棵拟合前一棵的残差
 *   - 预测基金未来5日收益率
 *   - 学习率缩减 + 早停防过拟合
 *
 * 输出: 预期收益率 + 方向置信度
 */

// ============================================================
//  回归决策树 (CART回归)
// ============================================================

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function variance(arr) { const m = mean(arr); return arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length; }

function bestRegressionSplit(data, values, featureIndices) {
  let bestFeature = -1, bestThreshold = 0, bestMSE = Infinity;
  let bestLeftIdx = [], bestRightIdx = [];

  for (const fi of featureIndices) {
    const uniqueVals = [...new Set(data.map(d => d[fi]))].sort((a, b) => a - b);
    if (uniqueVals.length < 2) continue;

    for (let v = 0; v < Math.min(uniqueVals.length - 1, 30); v++) {
      const threshold = (uniqueVals[v] + uniqueVals[v + 1]) / 2;
      const leftIdx = [], rightIdx = [];

      for (let i = 0; i < data.length; i++) {
        if (data[i][fi] <= threshold) leftIdx.push(i);
        else rightIdx.push(i);
      }

      if (leftIdx.length < 2 || rightIdx.length < 2) continue;

      const leftVals = leftIdx.map(i => values[i]);
      const rightVals = rightIdx.map(i => values[i]);
      const mse = (leftIdx.length * variance(leftVals) + rightIdx.length * variance(rightVals)) / data.length;

      if (mse < bestMSE) {
        bestMSE = mse;
        bestFeature = fi;
        bestThreshold = threshold;
        bestLeftIdx = leftIdx;
        bestRightIdx = rightIdx;
      }
    }
  }

  return { feature: bestFeature, threshold: bestThreshold, mse: bestMSE, leftIdx: bestLeftIdx, rightIdx: bestRightIdx };
}

function buildRegressionTree(data, values, featureIndices, depth = 0, maxDepth = 6, minSamples = 5) {
  const nodeMean = mean(values);

  if (depth >= maxDepth || data.length < minSamples || variance(values) < 1e-8) {
    return { leaf: true, value: nodeMean };
  }

  const split = bestRegressionSplit(data, values, featureIndices);
  if (split.feature === -1) return { leaf: true, value: nodeMean };

  const leftData = split.leftIdx.map(i => data[i]);
  const leftVals = split.leftIdx.map(i => values[i]);
  const rightData = split.rightIdx.map(i => data[i]);
  const rightVals = split.rightIdx.map(i => values[i]);

  return {
    leaf: false,
    feature: split.feature,
    threshold: split.threshold,
    left: buildRegressionTree(leftData, leftVals, featureIndices, depth + 1, maxDepth, minSamples),
    right: buildRegressionTree(rightData, rightVals, featureIndices, depth + 1, maxDepth, minSamples),
  };
}

function predictRegTree(tree, sample) {
  if (tree.leaf) return tree.value;
  if (sample[tree.feature] <= tree.threshold) return predictRegTree(tree.left, sample);
  return predictRegTree(tree.right, sample);
}

// ============================================================
//  梯度提升
// ============================================================

class GradientBoostLite {
  constructor(nTrees = 50, learningRate = 0.1, maxDepth = 5) {
    this.nTrees = nTrees;
    this.lr = learningRate;
    this.maxDepth = maxDepth;
    this.trees = [];
    this.initValue = 0;
  }

  train(data, values) {
    if (!data || data.length < 10) return false;

    this.initValue = mean(values);
    let currentPreds = new Array(data.length).fill(this.initValue);
    const nFeatures = data[0].length;
    const subsetSize = Math.max(2, Math.floor(Math.sqrt(nFeatures)));

    for (let t = 0; t < this.nTrees; t++) {
      // 残差
      const residuals = values.map((v, i) => v - currentPreds[i]);

      // 随机特征子集
      const allFeatures = Array.from({ length: nFeatures }, (_, i) => i);
      const featureIndices = allFeatures.sort(() => Math.random() - 0.5).slice(0, subsetSize);

      // Bootstrap采样
      const sampleIdx = [];
      for (let i = 0; i < data.length; i++) {
        sampleIdx.push(Math.floor(Math.random() * data.length));
      }
      const sampleData = sampleIdx.map(i => data[i]);
      const sampleResiduals = sampleIdx.map(i => residuals[i]);

      const tree = buildRegressionTree(sampleData, sampleResiduals, featureIndices, 0, this.maxDepth);
      this.trees.push({ tree, features: featureIndices });

      // 更新预测
      for (let i = 0; i < data.length; i++) {
        currentPreds[i] += this.lr * predictRegTree(tree, data[i]);
      }

      // 早停: 如果残差改善很小
      const currentMSE = mean(values.map((v, i) => (v - currentPreds[i]) ** 2));
      if (t > 10 && currentMSE < 1e-6) break;
    }

    return true;
  }

  predict(sample) {
    let pred = this.initValue;
    for (const { tree } of this.trees) {
      pred += this.lr * predictRegTree(tree, sample);
    }
    return pred;
  }
}

// ============================================================
//  特征提取 + 训练预测
// ============================================================

/**
 * 从历史数据提取GBDT特征 + 标签
 * 标签: 未来5日收益率
 */
function buildGBDTDataset(rankedFunds) {
  const data = [];
  const labels = [];

  for (const fund of rankedFunds) {
    if (!fund.history || fund.history.length < 25) continue;
    const closes = fund.history.map(h => h.close || h.nav || 0).filter(v => v > 0);
    if (closes.length < 25) continue;

    const ind = fund.indicators || {};
    const sub = fund.subScores || [];

    // 特征
    const features = [
      ind.rsi || 50,
      ind.macd?.histogram || 0,
      ind.macd?.dif || 0,
      ind.macd?.momentum || 0,
      ind.atr?.atrPct || 0,
      ind.momentum5 || 0,
      ind.momentum10 || 0,
      ind.momentum20 || 0,
      ind.momentumQuality || 1,
      ind.sharpe || 0,
      ind.maxDD || 0,
      ind.kdj?.k || 50,
      ind.kdj?.j || 50,
      ind.volDivergence === 'healthy_uptrend' ? 1 : ind.volDivergence === 'bearish_divergence' ? -1 : 0,
      ind.hlTrend === 'uptrend' ? 1 : ind.hlTrend === 'downtrend' ? -1 : 0,
      ...(sub.map(s => s.score / s.max) || []),
      fund.changePct || 0,
      fund.score || 50,
    ];

    // 标签: 未来5日收益率 (如果数据足够)
    const offset = fund.history.length - closes.length;
    const lastIdx = closes.length - 1;
    const futureIdx = lastIdx + 5;

    if (futureIdx < closes.length) {
      const futureReturn = (closes[futureIdx] - closes[lastIdx]) / closes[lastIdx];
      data.push(features);
      labels.push(futureReturn);
    } else {
      // 用最近可计算的窗口作为代理
      const lookback = Math.min(5, closes.length - 1);
      const pastReturn = (closes[lastIdx] - closes[lastIdx - lookback]) / closes[lastIdx - lookback];
      // 标签 = 过去的收益 (简化: 假设短期持续性)
      data.push(features);
      labels.push(pastReturn * 0.7); // 衰减系数
    }
  }

  return { data, labels };
}

/**
 * 训练GBDT并预测每只基金的未来收益
 */
function trainAndPredictGB(rankedFunds) {
  if (!rankedFunds || rankedFunds.length < 15) return null;

  const { data, labels } = buildGBDTDataset(rankedFunds);
  if (data.length < 10) return null;

  // 训练
  const gb = new GradientBoostLite(40, 0.1, 5);
  const trained = gb.train(data, labels);
  if (!trained) return null;

  // 预测
  const predictions = {};
  for (const fund of rankedFunds) {
    if (!fund.history || fund.history.length < 25) continue;
    const ind = fund.indicators || {};
    const sub = fund.subScores || [];

    const features = [
      ind.rsi || 50,
      ind.macd?.histogram || 0,
      ind.macd?.dif || 0,
      ind.macd?.momentum || 0,
      ind.atr?.atrPct || 0,
      ind.momentum5 || 0,
      ind.momentum10 || 0,
      ind.momentum20 || 0,
      ind.momentumQuality || 1,
      ind.sharpe || 0,
      ind.maxDD || 0,
      ind.kdj?.k || 50,
      ind.kdj?.j || 50,
      ind.volDivergence === 'healthy_uptrend' ? 1 : ind.volDivergence === 'bearish_divergence' ? -1 : 0,
      ind.hlTrend === 'uptrend' ? 1 : ind.hlTrend === 'downtrend' ? -1 : 0,
      ...(sub.map(s => s.score / s.max) || []),
      fund.changePct || 0,
      fund.score || 50,
    ];

    const predReturn = gb.predict(features);
    const direction = predReturn > 0.01 ? 'UP' : predReturn < -0.01 ? 'DOWN' : 'FLAT';
    const confidence = Math.round(Math.min(95, Math.max(30, Math.abs(predReturn) * 500 + 40)));

    predictions[fund.code] = {
      predictedReturn5d: Math.round(predReturn * 10000) / 100, // 百分比
      direction,
      confidence,
      model: 'GBDT-Lite',
    };
  }

  // 模型评估: 训练集MSE
  const trainPreds = data.map(d => gb.predict(d));
  const mse = mean(labels.map((v, i) => (v - trainPreds[i]) ** 2));
  const rmse = Math.sqrt(mse);

  return {
    predictions,
    model: 'GradientBoost-Lite',
    rmse: Math.round(rmse * 10000) / 100,
    nTrees: gb.trees.length,
    nSamples: data.length,
  };
}

module.exports = { GradientBoostLite, trainAndPredictGB, buildGBDTDataset };
