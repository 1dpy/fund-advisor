/**
 * ML集成元模型 — 融合所有机器学习模型的预测
 *
 * 集成方法:
 *   1. LSTM-Lite: 时序趋势预测
 *   2. Random Forest: 信号分类
 *   3. Gradient Boosting: 收益率回归
 *   4. HMM Pro: 市场体制检测
 *   5. Ensemble (趋势+均值回复+动量): 交易信号
 *   6. 贝叶斯参数优化: 动态止损止盈
 *
 * 输出: 统一的 ML信号 + 置信度 + 仓位建议调整
 */

const { predictWithLSTM } = require('./lstm_lite');
const { trainAndPredict: trainRF, scoreToLabel } = require('./random_forest');
const { trainAndPredictGB } = require('./gradient_boost');
const { ensembleVote } = require('./ensemble');

// ============================================================
//  Stacking: 用逻辑回归做第二层学习器
// ============================================================

function sigmoid(x) { return 1 / (1 + Math.exp(-Math.max(-50, Math.min(50, x)))); }

/**
 * 第二层元学习器: 加权融合各模型输出
 * 权重通过简单网格搜索确定
 */
function metaLearn(predictions, actualLabels) {
  // 简化: 用各模型在训练集上的准确率作为权重
  const modelAccuracies = {};

  for (const model of Object.keys(predictions[0]?.models || {})) {
    let correct = 0, total = 0;
    for (let i = 0; i < predictions.length; i++) {
      const pred = predictions[i].models[model];
      const actual = actualLabels[i];
      if (pred && pred.direction) {
        const predDir = pred.direction === 'UP' ? 1 : pred.direction === 'DOWN' ? -1 : 0;
        const actualDir = actual > 0.005 ? 1 : actual < -0.005 ? -1 : 0;
        if (predDir === actualDir && predDir !== 0) correct++;
        total++;
      }
    }
    modelAccuracies[model] = total > 0 ? correct / total : 0.33;
  }

  // 归一化权重
  const totalAcc = Object.values(modelAccuracies).reduce((s, v) => s + v, 0);
  const weights = {};
  for (const [k, v] of Object.entries(modelAccuracies)) {
    weights[k] = totalAcc > 0 ? v / totalAcc : 1 / Object.keys(modelAccuracies).length;
  }

  return { weights, modelAccuracies };
}

// ============================================================
//  集成预测
// ============================================================

/**
 * 对所有基金运行ML集成预测
 * @param {Array} rankedFunds - 已评分的基金列表 (来自analyzer_v2)
 * @param {Object} hmmResult - HMM Pro结果
 * @returns {Object} - { fundPredictions, metaWeights, ensembleAccuracy }
 */
function runMLEnsemble(rankedFunds, hmmResult) {
  if (!rankedFunds || rankedFunds.length < 10) return null;

  const result = {
    fundPredictions: {},
    modelSummary: {},
    ensembleSignal: null,
  };

  // 1. Random Forest 分类
  let rfResult = null;
  try {
    rfResult = trainRF(rankedFunds);
    if (rfResult) result.modelSummary.randomForest = {
      accuracy: rfResult.accuracy,
      nTrees: rfResult.nTrees,
      nSamples: rfResult.nSamples,
    };
  } catch (e) { /* skip */ }

  // 2. Gradient Boosting 回归
  let gbResult = null;
  try {
    gbResult = trainAndPredictGB(rankedFunds);
    if (gbResult) result.modelSummary.gradientBoost = {
      rmse: gbResult.rmse,
      nTrees: gbResult.nTrees,
      nSamples: gbResult.nSamples,
    };
  } catch (e) { /* skip */ }

  // 3. LSTM 时序预测 (对前20只基金运行, 计算量大)
  const lstmPredictions = {};
  let lstmCount = 0;
  for (const fund of rankedFunds.slice(0, 25)) {
    try {
      const closes = (fund.history || []).map(h => h.close || h.nav || 0).filter(v => v > 0);
      if (closes.length < 40) continue;
      const lstmPred = predictWithLSTM(closes, 3);
      if (lstmPred) {
        lstmPredictions[fund.code] = lstmPred;
        lstmCount++;
      }
    } catch (e) { /* skip individual */ }
  }
  if (lstmCount > 0) {
    result.modelSummary.lstm = { predictions: lstmCount };
  }

  // 4. Ensemble信号 (已有, 对每只基金运行)
  const ensemblePredictions = {};
  for (const fund of rankedFunds.slice(0, 30)) {
    try {
      const closes = (fund.history || []).map(h => h.close || h.nav || 0).filter(v => v > 0);
      if (closes.length < 25) continue;
      const ens = ensembleVote(closes);
      if (ens) ensemblePredictions[fund.code] = ens;
    } catch (e) { /* skip */ }
  }

  // 5. 融合: 对每只基金生成统一ML信号
  for (const fund of rankedFunds) {
    const code = fund.code;
    const models = {};

    // RF
    if (rfResult?.predictions[code]) {
      const rf = rfResult.predictions[code];
      models.randomForest = {
        direction: rf.rfLabel === 'STRONG_BUY' || rf.rfLabel === 'BUY' ? 'UP' :
                    rf.rfLabel === 'SELL' || rf.rfLabel === 'WEAK' ? 'DOWN' : 'FLAT',
        confidence: rf.rfProbability,
        label: rf.rfLabel,
      };
    }

    // GBDT
    if (gbResult?.predictions[code]) {
      models.gradientBoost = {
        direction: gbResult.predictions[code].direction,
        confidence: gbResult.predictions[code].confidence,
        predictedReturn: gbResult.predictions[code].predictedReturn5d,
      };
    }

    // LSTM
    if (lstmPredictions[code]) {
      models.lstm = {
        direction: lstmPredictions[code].direction,
        confidence: lstmPredictions[code].confidence,
        predictedReturn: lstmPredictions[code].predictedReturn,
        accuracy: lstmPredictions[code].accuracy,
      };
    }

    // Ensemble
    if (ensemblePredictions[code]) {
      models.ensemble = {
        direction: ensemblePredictions[code].signal > 0.1 ? 'UP' :
                    ensemblePredictions[code].signal < -0.1 ? 'DOWN' : 'FLAT',
        confidence: Math.round(ensemblePredictions[code].confidence * 100),
        agreement: Math.round(ensemblePredictions[code].agreement * 100),
      };
    }

    if (Object.keys(models).length === 0) continue;

    // 加权融合
    const modelWeights = {
      randomForest: 0.25,
      gradientBoost: 0.30,
      lstm: 0.25,
      ensemble: 0.20,
    };

    let weightedSignal = 0;
    let totalWeight = 0;
    let totalConfidence = 0;
    let modelCount = 0;

    for (const [name, pred] of Object.entries(models)) {
      const w = modelWeights[name] || 0.1;
      const dirScore = pred.direction === 'UP' ? 1 : pred.direction === 'DOWN' ? -1 : 0;
      weightedSignal += dirScore * w * (pred.confidence / 100);
      totalWeight += w;
      totalConfidence += pred.confidence * w;
      modelCount++;
    }

    const finalSignal = totalWeight > 0 ? weightedSignal / totalWeight : 0;
    const avgConfidence = modelCount > 0 ? Math.round(totalConfidence / modelCount) : 0;

    // 共识度: 模型方向一致性
    const directions = Object.values(models).map(m => m.direction);
    const upVotes = directions.filter(d => d === 'UP').length;
    const downVotes = directions.filter(d => d === 'DOWN').length;
    const consensus = Math.max(upVotes, downVotes) / directions.length;

    // 生成统一ML信号
    let mlSignal;
    if (finalSignal > 0.3 && consensus > 0.6) mlSignal = 'ML_STRONG_BUY';
    else if (finalSignal > 0.1) mlSignal = 'ML_BUY';
    else if (finalSignal > -0.1) mlSignal = 'ML_HOLD';
    else if (finalSignal > -0.3) mlSignal = 'ML_SELL';
    else mlSignal = 'ML_STRONG_SELL';

    // 仓位调整建议
    let positionAdjust = 0;
    if (mlSignal === 'ML_STRONG_BUY') positionAdjust = 0.15;
    else if (mlSignal === 'ML_BUY') positionAdjust = 0.05;
    else if (mlSignal === 'ML_SELL') positionAdjust = -0.05;
    else if (mlSignal === 'ML_STRONG_SELL') positionAdjust = -0.15;

    // HMM体制调整
    if (hmmResult) {
      if (hmmResult.currentState === 'BULL' && mlSignal.includes('BUY')) positionAdjust += 0.05;
      if (hmmResult.currentState === 'BEAR' && mlSignal.includes('BUY')) positionAdjust -= 0.10;
      if (hmmResult.warning && positionAdjust > 0) positionAdjust *= 0.5;
    }

    result.fundPredictions[code] = {
      mlSignal,
      mlScore: Math.round(finalSignal * 1000) / 1000,
      mlConfidence: avgConfidence,
      consensus: Math.round(consensus * 100),
      positionAdjust: Math.round(positionAdjust * 100) / 100,
      models,
      modelCount,
    };
  }

  // 整体集成信号
  const allSignals = Object.values(result.fundPredictions).map(p => p.mlSignal);
  const buySignals = allSignals.filter(s => s.includes('BUY')).length;
  const sellSignals = allSignals.filter(s => s.includes('SELL')).length;
  const totalSignals = allSignals.length;

  result.ensembleSignal = {
    bullishRatio: totalSignals > 0 ? Math.round(buySignals / totalSignals * 100) : 0,
    bearishRatio: totalSignals > 0 ? Math.round(sellSignals / totalSignals * 100) : 0,
    overall: buySignals > sellSignals * 2 ? '偏多' : sellSignals > buySignals * 2 ? '偏空' : '中性',
    totalPredictions: totalSignals,
  };

  return result;
}

module.exports = { runMLEnsemble, metaLearn };
