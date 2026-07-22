/**
 * 多时间框架信号融合引擎
 *
 * 核心思路: 将多个模型的预测信号融合为一个统一的交易决策
 *
 * 模型权重分配策略 (参考Two Sigma, AQR):
 *   1. 基于Sharpe ratio的动态权重 (表现好的模型权重更高)
 *   2. 体制感知 (趋势市重LSTM+动量, 震荡市重均值回复+卡尔曼)
 *   3. 相关性惩罚 (模型间高相关则降权, 避免假性多样性)
 *   4. 置信度加权 (高置信度的预测权重更高)
 *
 * 信号类型:
 *   - LSTM-Attention: 序列预测 (5日收益率)
 *   - 随机森林: 分类信号 (STRONG_BUY → SELL)
 *   - GBDT: 回归信号 (预期收益率)
 *   - 卡尔曼滤波: 趋势+均值回复
 *   - ARIMA: 自回归预测
 *   - HMM: 市场体制 (BULL/BEAR/SIDEWAYS)
 *   - 集成投票: 多策略投票
 *   - 技术分析: 12+指标综合评分
 */

const { predictWithLSTMAttention } = require('./lstm_attention');
const { predictWithKalman } = require('./kalman_filter');
const { predictARIMA } = require('./arima_lite');
const { extractFeatures } = require('../feature_engine');
const { resample, hurstExponent } = require('../data_collector');

/**
 * 融合所有模型信号
 * @param {Object} fundData - 基金数据 (含history, indicators, score, signal)
 * @param {Object} mlResults - ML模型结果 (LSTM, RF, GBDT)
 * @param {Object} marketContext - 市场环境 (regime, indexReturns)
 * @returns {Object} 融合后的统一信号
 */
function fuseSignals(fundData, mlResults, marketContext) {
  const history = fundData.history;
  if (!history || history.length < 30) return null;

  const signals = [];

  // 1. LSTM-Attention 信号
  if (mlResults?.lstmAtt) {
    const lstm = mlResults.lstmAtt;
    signals.push({
      name: 'LSTM_ATT',
      prediction: lstm.predictedReturn,
      direction: lstm.direction,
      confidence: lstm.confidence,
      weight: 0.20,
    });
  } else if (mlResults?.lstm) {
    // 回退到旧版LSTM
    signals.push({
      name: 'LSTM',
      prediction: mlResults.lstm.predictedReturn || 0,
      direction: mlResults.lstm.direction || 'FLAT',
      confidence: mlResults.lstm.confidence || 0.5,
      weight: 0.15,
    });
  }

  // 2. 随机森林信号
  if (mlResults?.rf) {
    const rfMap = {
      'STRONG_BUY': { pred: 0.03, conf: 0.9 },
      'BUY': { pred: 0.015, conf: 0.7 },
      'HOLD': { pred: 0, conf: 0.5 },
      'WEAK': { pred: -0.015, conf: 0.7 },
      'SELL': { pred: -0.03, conf: 0.9 },
    };
    const rfInfo = rfMap[mlResults.rf.label] || rfMap['HOLD'];
    signals.push({
      name: 'RF',
      prediction: rfInfo.pred,
      direction: rfInfo.pred > 0 ? 'UP' : rfInfo.pred < 0 ? 'DOWN' : 'FLAT',
      confidence: rfInfo.conf * (mlResults.rf.accuracy || 0.9),
      weight: 0.18,
    });
  }

  // 3. GBDT信号
  if (mlResults?.gbdt) {
    signals.push({
      name: 'GBDT',
      prediction: mlResults.gbdt.predictedReturn || 0,
      direction: (mlResults.gbdt.predictedReturn || 0) > 0.005 ? 'UP' :
                 (mlResults.gbdt.predictedReturn || 0) < -0.005 ? 'DOWN' : 'FLAT',
      confidence: Math.min(1, Math.abs(mlResults.gbdt.predictedReturn || 0) * 15),
      weight: 0.20,
    });
  }

  // 4. 卡尔曼滤波信号 (使用最近60天数据加速)
  const recentHistory = history.slice(-60);
  const kalmanResult = predictWithKalman(recentHistory, 5);
  if (kalmanResult) {
    signals.push({
      name: 'KALMAN',
      prediction: kalmanResult.predictedReturn,
      direction: kalmanResult.direction,
      confidence: kalmanResult.confidence,
      weight: 0.12,
    });
  }

  // 5. ARIMA信号 (使用最近60天数据加速)
  const arimaResult = predictARIMA(recentHistory, 5, 1, 5);
  if (arimaResult) {
    signals.push({
      name: 'ARIMA',
      prediction: arimaResult.predictedReturn,
      direction: arimaResult.direction,
      confidence: arimaResult.confidence,
      weight: 0.10,
    });
  }

  // 6. HMM体制信号
  if (mlResults?.hmm) {
    const regimeMap = {
      'BULL': { pred: 0.01, conf: 0.7 },
      'BEAR': { pred: -0.01, conf: 0.7 },
      'SIDEWAYS': { pred: 0, conf: 0.5 },
      'VOLATILE': { pred: 0, conf: 0.3 },
    };
    const regimeInfo = regimeMap[mlResults.hmm.regime] || regimeMap['SIDEWAYS'];
    signals.push({
      name: 'HMM',
      prediction: regimeInfo.pred,
      direction: regimeInfo.pred > 0 ? 'UP' : regimeInfo.pred < 0 ? 'DOWN' : 'FLAT',
      confidence: regimeInfo.conf,
      weight: 0.08,
    });
  }

  // 7. 技术分析信号 (已评分)
  if (fundData.score && fundData.signal) {
    const techPred = (fundData.score - 50) / 1000; // 50分中性
    signals.push({
      name: 'TECH',
      prediction: techPred,
      direction: fundData.signal === 'BUY' || fundData.signal === 'STRONG_BUY' ? 'UP' :
                 fundData.signal === 'SELL' ? 'DOWN' : 'FLAT',
      confidence: Math.min(1, Math.abs(fundData.score - 50) / 30),
      weight: 0.12,
    });
  }

  if (signals.length === 0) return null;

  // ============================================================
  // 体制感知权重调整
  // ============================================================
  const regime = marketContext?.regime || 'SIDEWAYS';
  const adjustedSignals = adjustWeightsByRegime(signals, regime);

  // ============================================================
  // 相关性惩罚
  // ============================================================
  const decorrelatedSignals = applyCorrelationPenalty(adjustedSignals);

  // ============================================================
  // 加权融合
  // ============================================================
  let totalWeight = 0;
  let weightedPrediction = 0;
  let totalConfidence = 0;
  let upVotes = 0, downVotes = 0, flatVotes = 0;

  for (const sig of decorrelatedSignals) {
    const effectiveWeight = sig.weight * sig.confidence;
    weightedPrediction += sig.prediction * effectiveWeight;
    totalWeight += effectiveWeight;
    totalConfidence += sig.confidence * sig.weight;

    if (sig.direction === 'UP') upVotes++;
    else if (sig.direction === 'DOWN') downVotes++;
    else flatVotes++;
  }

  const fusedPrediction = totalWeight > 0 ? weightedPrediction / totalWeight : 0;
  // 置信度: 加权平均 (不是除以信号数量)
  const fusedConfidence = totalWeight > 0 ? totalConfidence / totalWeight : 0.5;
  const consensus = (upVotes + downVotes) > 0 ? upVotes / (upVotes + downVotes) : 0.5;

  // 最终信号 (限制预测在合理范围)
  const clampedPrediction = Math.max(-0.10, Math.min(0.10, fusedPrediction));
  let finalSignal;
  if (clampedPrediction > 0.015 && consensus > 0.6) finalSignal = 'STRONG_BUY';
  else if (clampedPrediction > 0.005) finalSignal = 'BUY';
  else if (clampedPrediction > -0.005) finalSignal = 'HOLD';
  else if (clampedPrediction > -0.015) finalSignal = 'WEAK';
  else finalSignal = 'SELL';

  // 仓位调整建议
  let positionAdjust = 0;
  if (finalSignal === 'STRONG_BUY') positionAdjust = 1.3;
  else if (finalSignal === 'BUY') positionAdjust = 1.1;
  else if (finalSignal === 'HOLD') positionAdjust = 1.0;
  else if (finalSignal === 'WEAK') positionAdjust = 0.8;
  else positionAdjust = 0.5;

  // 多时间框架验证
  const weeklyHistory = resample(history, 'week');
  const monthlyHistory = resample(history, 'month');
  const hurst = hurstExponent(history);

  // Hurst指数验证: >0.5趋势持续(信号可信), <0.5均值回复(反向操作)
  const hurstBoost = hurst > 0.55 ? 1.1 : hurst < 0.45 ? 0.85 : 1.0;

  return {
    signal: finalSignal,
    prediction: clampedPrediction,
    confidence: Math.min(0.95, Math.max(0.15, fusedConfidence * hurstBoost)),
    consensus,
    positionAdjust: positionAdjust * hurstBoost,
    upVotes, downVotes, flatVotes,
    modelCount: decorrelatedSignals.length,
    models: decorrelatedSignals.map(s => ({
      name: s.name,
      prediction: s.prediction,
      direction: s.direction,
      confidence: s.confidence,
      weight: s.weight,
    })),
    hurst: hurst,
    marketRegime: regime,
  };
}

/**
 * 根据市场体制调整模型权重
 */
function adjustWeightsByRegime(signals, regime) {
  const weightMultipliers = {
    BULL: {
      LSTM: 1.2, LSTM_ATT: 1.3, RF: 1.1, GBDT: 1.15, KALMAN: 1.0,
      ARIMA: 1.1, HMM: 1.0, TECH: 1.2,
    },
    BEAR: {
      LSTM: 1.1, LSTM_ATT: 1.2, RF: 1.2, GBDT: 1.15, KALMAN: 1.2,
      ARIMA: 1.0, HMM: 1.3, TECH: 1.1,
    },
    SIDEWAYS: {
      LSTM: 0.9, LSTM_ATT: 1.0, RF: 1.0, GBDT: 1.0, KALMAN: 1.3,
      ARIMA: 1.2, HMM: 1.0, TECH: 1.0,
    },
    VOLATILE: {
      LSTM: 0.8, LSTM_ATT: 0.9, RF: 1.0, GBDT: 0.9, KALMAN: 1.2,
      ARIMA: 0.8, HMM: 1.4, TECH: 0.9,
    },
  };

  const multipliers = weightMultipliers[regime] || weightMultipliers.SIDEWAYS;

  return signals.map(sig => ({
    ...sig,
    weight: sig.weight * (multipliers[sig.name] || 1.0),
  }));
}

/**
 * 相关性惩罚: 如果多个模型给出相似预测, 降低权重 (避免假性多样性)
 */
function applyCorrelationPenalty(signals) {
  if (signals.length <= 1) return signals;

  // 计算预测值之间的相似度
  const predictions = signals.map(s => s.prediction);
  const mean = predictions.reduce((a, b) => a + b, 0) / predictions.length;
  const std = Math.sqrt(predictions.reduce((a, b) => a + (b - mean) ** 2, 0) / predictions.length);

  // 如果所有预测高度一致 (std很小), 不需要惩罚
  // 如果某些预测偏离群体, 给它们更高权重 (它们提供了独特信息)
  if (std < 0.001) return signals;

  return signals.map(sig => {
    const deviation = Math.abs(sig.prediction - mean) / (std + 1e-8);
    // 偏离群体越大, 权重略增 (提供独特信息)
    const penalty = 1 + Math.min(0.2, deviation * 0.05);
    return { ...sig, weight: sig.weight * penalty };
  });
}

module.exports = {
  fuseSignals,
  adjustWeightsByRegime,
  applyCorrelationPenalty,
};
