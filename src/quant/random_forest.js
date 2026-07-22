/**
 * Random Forest Lite — 随机森林信号分类器
 *
 * 纯JS实现的简化版随机森林:
 *   - 多棵决策树, 每棵用随机特征子集 + 随机采样
 *   - 分类: STRONG_BUY / BUY / HOLD / WEAK / SELL
 *   - 输出: 多数投票 + 概率分布
 *
 * 特征: 技术指标 (RSI, MACD柱状线, 均线偏离, 动量, 波动率, 夏普, 量价, KDJ)
 */

// ============================================================
//  决策树 (CART简化版)
// ============================================================

function giniImpurity(labels) {
  const counts = {};
  for (const l of labels) counts[l] = (counts[l] || 0) + 1;
  const n = labels.length;
  let impurity = 1;
  for (const k in counts) {
    const p = counts[k] / n;
    impurity -= p * p;
  }
  return impurity;
}

function bestSplit(data, labels, featureIndices) {
  let bestFeature = -1, bestThreshold = 0, bestGini = Infinity;
  let bestLeftIdx = [], bestRightIdx = [];

  for (const fi of featureIndices) {
    // 取该特征的所有唯一值作为候选阈值
    const values = [...new Set(data.map(d => d[fi]))].sort((a, b) => a - b);

    for (let v = 0; v < values.length - 1; v++) {
      const threshold = (values[v] + values[v + 1]) / 2;
      const leftIdx = [], rightIdx = [];

      for (let i = 0; i < data.length; i++) {
        if (data[i][fi] <= threshold) leftIdx.push(i);
        else rightIdx.push(i);
      }

      if (leftIdx.length === 0 || rightIdx.length === 0) continue;

      const leftLabels = leftIdx.map(i => labels[i]);
      const rightLabels = rightIdx.map(i => labels[i]);
      const gini = (leftIdx.length * giniImpurity(leftLabels) + rightIdx.length * giniImpurity(rightLabels)) / data.length;

      if (gini < bestGini) {
        bestGini = gini;
        bestFeature = fi;
        bestThreshold = threshold;
        bestLeftIdx = leftIdx;
        bestRightIdx = rightIdx;
      }
    }
  }

  return { feature: bestFeature, threshold: bestThreshold, gini: bestGini, leftIdx: bestLeftIdx, rightIdx: bestRightIdx };
}

function buildTree(data, labels, featureIndices, depth = 0, maxDepth = 8, minSamples = 4) {
  // 终止条件
  if (depth >= maxDepth || data.length < minSamples || giniImpurity(labels) === 0) {
    const counts = {};
    for (const l of labels) counts[l] = (counts[l] || 0) + 1;
    return { leaf: true, prediction: counts };
  }

  const split = bestSplit(data, labels, featureIndices);
  if (split.feature === -1) {
    const counts = {};
    for (const l of labels) counts[l] = (counts[l] || 0) + 1;
    return { leaf: true, prediction: counts };
  }

  const leftData = split.leftIdx.map(i => data[i]);
  const leftLabels = split.leftIdx.map(i => labels[i]);
  const rightData = split.rightIdx.map(i => data[i]);
  const rightLabels = split.rightIdx.map(i => labels[i]);

  return {
    leaf: false,
    feature: split.feature,
    threshold: split.threshold,
    left: buildTree(leftData, leftLabels, featureIndices, depth + 1, maxDepth, minSamples),
    right: buildTree(rightData, rightLabels, featureIndices, depth + 1, maxDepth, minSamples),
  };
}

function predictTree(tree, sample) {
  if (tree.leaf) {
    let total = 0;
    for (const k in tree.prediction) total += tree.prediction[k];
    const probs = {};
    for (const k in tree.prediction) probs[k] = tree.prediction[k] / total;
    return probs;
  }
  if (sample[tree.feature] <= tree.threshold) return predictTree(tree.left, sample);
  return predictTree(tree.right, sample);
}

// ============================================================
//  随机森林
// ============================================================

class RandomForestLite {
  constructor(nTrees = 20, maxDepth = 8, featureSubset = null) {
    this.nTrees = nTrees;
    this.maxDepth = maxDepth;
    this.featureSubset = featureSubset; // 每棵树用的特征数
    this.trees = [];
  }

  train(data, labels) {
    if (!data || data.length < 10) return false;
    const nFeatures = data[0].length;
    const subsetSize = this.featureSubset || Math.max(2, Math.floor(Math.sqrt(nFeatures)));

    for (let t = 0; t < this.nTrees; t++) {
      // 随机采样 (bootstrap)
      const sampleIdx = [];
      for (let i = 0; i < data.length; i++) {
        sampleIdx.push(Math.floor(Math.random() * data.length));
      }
      const sampleData = sampleIdx.map(i => data[i]);
      const sampleLabels = sampleIdx.map(i => labels[i]);

      // 随机特征子集
      const allFeatures = Array.from({ length: nFeatures }, (_, i) => i);
      const shuffled = allFeatures.sort(() => Math.random() - 0.5);
      const featureIndices = shuffled.slice(0, subsetSize);

      const tree = buildTree(sampleData, sampleLabels, featureIndices, 0, this.maxDepth);
      this.trees.push({ tree, features: featureIndices });
    }
    return true;
  }

  predict(sample) {
    if (this.trees.length === 0) return null;

    const allProbs = this.trees.map(({ tree }) => predictTree(tree, sample));

    // 平均概率
    const avgProbs = {};
    const labelSet = new Set();
    for (const p of allProbs) for (const k in p) labelSet.add(k);

    for (const label of labelSet) {
      avgProbs[label] = mean(allProbs.map(p => p[label] || 0));
    }

    // 找概率最高的
    let bestLabel = null, bestProb = -1;
    for (const k in avgProbs) {
      if (avgProbs[k] > bestProb) { bestProb = avgProbs[k]; bestLabel = k; }
    }

    return { label: bestLabel, probability: Math.round(bestProb * 100), distribution: avgProbs };
  }
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// ============================================================
//  特征提取: 从技术指标构建RF特征向量
// ============================================================

/**
 * 从analyzer_v2的评分结果提取RF特征
 */
function extractRFFeatures(scoredFund) {
  const ind = scoredFund.indicators || {};
  const sub = scoredFund.subScores || [];

  const features = [
    // 技术指标原始值
    ind.rsi || 50,
    ind.macd?.histogram || 0,
    ind.macd?.dif || 0,
    ind.macd?.dea || 0,
    ind.macd?.momentum || 0,
    ind.kdj?.k || 50,
    ind.kdj?.d || 50,
    ind.kdj?.j || 50,
    ind.atr?.atrPct || 0,
    ind.momentum5 || 0,
    ind.momentum10 || 0,
    ind.momentum20 || 0,
    ind.momentumQuality || 1,
    ind.sharpe || 0,
    ind.maxDD || 0,
    // 偏离度
    scoredFund.price && ind.ma5 ? (scoredFund.price - ind.ma5) / ind.ma5 : 0,
    scoredFund.price && ind.ma10 ? (scoredFund.price - ind.ma10) / ind.ma10 : 0,
    scoredFund.price && ind.ma20 ? (scoredFund.price - ind.ma20) / ind.ma20 : 0,
    // 子维度分数
    ...(sub.map(s => s.score / s.max) || []),
    // 当日涨跌
    scoredFund.changePct || 0,
  ];

  return features;
}

/**
 * 将分数映射到分类标签
 */
function scoreToLabel(score) {
  if (score >= 72) return 'STRONG_BUY';
  if (score >= 58) return 'BUY';
  if (score >= 42) return 'HOLD';
  if (score >= 28) return 'WEAK';
  return 'SELL';
}

/**
 * 训练随机森林并预测
 * @param {Array} rankedFunds - 已评分的基金列表
 * @returns {Object} - { predictions, model }
 */
function trainAndPredict(rankedFunds) {
  if (!rankedFunds || rankedFunds.length < 15) return null;

  // 构建训练数据
  const data = [];
  const labels = [];

  for (const fund of rankedFunds) {
    if (fund.score === null || fund.score === undefined) continue;
    const features = extractRFFeatures(fund);
    data.push(features);
    labels.push(scoreToLabel(fund.score));
  }

  if (data.length < 10) return null;

  // 训练
  const rf = new RandomForestLite(25, 8);
  const trained = rf.train(data, labels);
  if (!trained) return null;

  // 预测: 对每只基金生成概率分布
  const predictions = {};
  for (let i = 0; i < rankedFunds.length; i++) {
    if (rankedFunds[i].score === null) continue;
    const features = extractRFFeatures(rankedFunds[i]);
    const pred = rf.predict(features);
    if (pred) {
      predictions[rankedFunds[i].code] = {
        rfLabel: pred.label,
        rfProbability: pred.probability,
        rfDistribution: pred.distribution,
        // 如果RF给出更高确信度的信号, 调整原始信号
        rfConfidence: pred.probability > 70 ? 'high' : pred.probability > 55 ? 'medium' : 'low',
      };
    }
  }

  // 计算模型准确率 (留一交叉验证简化)
  let correct = 0, total = 0;
  for (let i = 0; i < data.length; i++) {
    const rf2 = new RandomForestLite(15, 6);
    const trainData = data.filter((_, j) => j !== i);
    const trainLabels = labels.filter((_, j) => j !== i);
    if (rf2.train(trainData, trainLabels)) {
      const pred = rf2.predict(data[i]);
      if (pred && pred.label === labels[i]) correct++;
      total++;
    }
  }
  const accuracy = total > 0 ? Math.round(correct / total * 100) : 0;

  return {
    predictions,
    model: 'RandomForest-Lite',
    accuracy,
    nTrees: 25,
    nFeatures: data[0]?.length || 0,
    nSamples: data.length,
  };
}

module.exports = { RandomForestLite, trainAndPredict, extractRFFeatures, scoreToLabel };
