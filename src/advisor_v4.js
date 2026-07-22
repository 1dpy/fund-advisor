/**
 * V4 决策引擎 — 纯操作指令输出
 *
 * 核心升级:
 *   1. 融合7个模型信号 (LSTM-Att + RF + GBDT + Kalman + ARIMA + HMM + Tech)
 *   2. 信号融合引擎 (体制感知 + 相关性惩罚 + Sharpe加权)
 *   3. Walk-forward验证的参数自优化
 *   4. 多时间框架验证 (日/周/月)
 *   5. 输出格式: 纯操作指令 (只有买卖代码+金额+时间, 无分析)
 *
 * 策略:
 *   - 高确信度重仓 (ML_STRONG_BUY × Kelly × 1.4)
 *   - 动态止损止盈 (ATR + walk-forward优化)
 *   - 全交易类型: 买/卖/部分卖/转换/加仓/减仓/定投/持有
 *   - 支付宝C类T+1规则
 */

const { BUDGET, RISK_CONFIG } = require('./config');
const { fuseSignals } = require('./quant/signal_fusion');
const { predictWithLSTMAttention } = require('./quant/lstm_attention');
const { predictWithKalman } = require('./quant/kalman_filter');
const { predictARIMA } = require('./quant/arima_lite');
const { extractFeatures } = require('./feature_engine');
const { resample, hurstExponent, getCachedHistory } = require('./data_collector');
const { getSettlementTimeline } = require('./t1_calendar');

/**
 * V4 主决策函数
 * @param {Object} data - 全部市场数据 (funds, indexes, breadth, etc.)
 * @param {Object} holdings - 当前持仓
 * @param {Object} mlEnsemble - ML集成结果 (RF, GBDT, LSTM, HMM)
 * @param {Object} usImpact - 美股影响
 * @param {Object} marketRegime - 市场体制
 * @returns {Object} 纯操作指令
 */
async function generateAdviceV4(data, holdings, mlEnsemble, usImpact, marketRegime, marketSentiment) {
  const { funds, indexes, breadth, northFlow } = data;
  const cash = BUDGET - holdings.reduce((sum, h) => sum + (h.costBasis || 0), 0);
  const t1Info = getSettlementTimeline('fund', new Date());

  // ============================================================
  // 1. 对每只基金运行信号融合
  // ============================================================
  const rankedFunds = [];
  const marketContext = {
    regime: marketRegime?.regime || 'SIDEWAYS',
    marketReturns: indexes?.length > 0
      ? indexes[0].changePct / 100 : 0,
  };

  // ★ 情绪因子 (市场恐慌贪婪指数)
  const sentimentBias = marketSentiment?.tradingBias || 'NEUTRAL';
  const isFear = sentimentBias === 'CONTRARIAN_BUY';   // 恐慌→逆向布局
  const isGreed = sentimentBias === 'TAKE_PROFIT';     // 贪婪→减仓
  const sentimentLabel = marketSentiment?.labelCN || '未知';

  // 按技术评分排序, 只对Top基金运行V4模型 (控制计算时间)
  const sortedFunds = [...funds].sort((a, b) => (b.score || 0) - (a.score || 0));
  const topFundCodes = new Set(sortedFunds.slice(0, 30).map(f => f.code));

  for (const fund of funds) {
    if (!fund.history || fund.history.length < 30) continue;

    // 获取深度历史 (仅对Top基金)
    let deepHistory = fund.history;
    if (topFundCodes.has(fund.code)) {
      try {
        const cached = await getCachedHistory(fund.code);
        if (cached && cached.history && cached.history.length > fund.history.length) {
          deepHistory = cached.history;
        }
      } catch (e) { /* 使用默认历史 */ }
    }

    // ML结果
    const mlResults = {
      lstmAtt: null,
      rf: mlEnsemble?.rfResult?.predictions?.find(p => p.code === fund.code),
      gbdt: mlEnsemble?.gbdtResult?.predictions?.find(p => p.code === fund.code),
      lstm: mlEnsemble?.lstmResult?.predictions?.find(p => p.code === fund.code),
      hmm: mlEnsemble?.hmmResult,
    };

    // 只对Top基金运行LSTM-Attention (计算量大)
    if (topFundCodes.has(fund.code)) {
      try {
        const lstmAttResult = predictWithLSTMAttention(deepHistory, 15, 5);
        if (lstmAttResult) mlResults.lstmAtt = lstmAttResult;
      } catch (e) { /* 忽略 */ }
    }

    // 信号融合 (Kalman + ARIMA 在fuseSignals内部运行, 速度很快)
    const fused = fuseSignals(fund, mlResults, marketContext);
    if (!fused) continue;

    rankedFunds.push({
      ...fund,
      fusedSignal: fused,
      deepHistory,
    });
  }

  // 按融合信号排序
  rankedFunds.sort((a, b) => {
    const aScore = a.fusedSignal.prediction * 100 + a.fusedSignal.confidence * 50 + (a.score || 0) * 0.3;
    const bScore = b.fusedSignal.prediction * 100 + b.fusedSignal.confidence * 50 + (b.score || 0) * 0.3;
    return bScore - aScore;
  });

  // ============================================================
  // 2. 生成操作指令
  // ============================================================
  const operations = {
    sells: [],
    partialSells: [],
    buys: [],
    swaps: [],
    addPositions: [],
    reduces: [],
    holds: [],
    dca: [],
  };

  // --- 2a. 持仓分析: 卖出/减仓/持有 ---
  // ★ V4.1: 获取HMM体制 (从mlEnsemble或marketRegime)
  const regime = mlEnsemble?.hmmResult?.currentState ||
                 marketRegime?.regime || 'SIDEWAYS';
  const isBull = regime === 'BULL' || regime === 'STRONG_SIDEWAYS';
  const isBear = regime === 'BEAR' || regime === 'WEAK_SIDEWAYS';
  const maxHoldingDays = isBull ? RISK_CONFIG.maxHoldingDaysBull
                       : isBear ? RISK_CONFIG.maxHoldingDaysBear
                       : RISK_CONFIG.maxHoldingDaysSideways;
  const trailingStopPct = isBear ? RISK_CONFIG.trailingStopPctBear
                             : RISK_CONFIG.trailingStopPct;

  for (const holding of holdings) {
    const fundData = rankedFunds.find(f => f.code === holding.code);
    const signal = fundData?.fusedSignal;
    const currentPrice = fundData?.price || fundData?.nav || holding.buyPrice || 0;
    const profitPct = holding.costBasis > 0 && currentPrice > 0
      ? (holding.shares * currentPrice - holding.costBasis) / holding.costBasis
      : 0;
    const holdingDays = holding.buyDate
      ? Math.floor((Date.now() - new Date(holding.buyDate).getTime()) / 86400000)
      : 30;

    // ★ V4.1: 计算最高价 (从持仓记录或历史数据)
    const peakPrice = holding.peakPrice || Math.max(currentPrice, holding.buyPrice || currentPrice);
    const peakProfitPct = holding.costBasis > 0 && peakPrice > 0
      ? (holding.shares * peakPrice - holding.costBasis) / holding.costBasis
      : 0;
    const drawdownFromPeak = peakPrice > 0 && currentPrice > 0
      ? (currentPrice - peakPrice) / peakPrice
      : 0;

    // 止损 (不变)
    if (profitPct <= RISK_CONFIG.stopLossRatio) {
      const sellPrice = currentPrice;
      operations.sells.push({
        action: 'SELL',
        code: holding.code,
        name: holding.name,
        shares: holding.shares,
        amount: holding.shares * sellPrice,
        reason: `止损(${(profitPct * 100).toFixed(1)}%)`,
        t1: t1Info,
        urgency: 'HIGH',
      });
      continue;
    }

    // ★ V4.1: 固定止盈天花板 (涨到天花板直接全卖, 锁定大利润)
    if (profitPct >= RISK_CONFIG.takeProfitCeiling) {
      const sellPrice = currentPrice;
      operations.sells.push({
        action: 'SELL',
        code: holding.code,
        name: holding.name,
        shares: holding.shares,
        amount: holding.shares * sellPrice,
        reason: `止盈天花板(${(profitPct * 100).toFixed(1)}%)`,
        t1: t1Info,
        urgency: 'MEDIUM',
      });
      continue;
    }

    // ML强烈看空 → 卖出 (恐慌时降级为减仓, 不空仓)
    if (signal && signal.signal === 'SELL' && signal.confidence > 0.5) {
      const sellPrice = currentPrice;
      if (isFear) {
        // 市场恐慌: 不空仓, 只减30%逆向保留筹码
        const reduceShares = Math.floor(holding.shares * 0.3);
        operations.reduces.push({
          action: 'REDUCE',
          code: holding.code,
          name: holding.name,
          shares: reduceShares,
          reducePct: 30,
          amount: reduceShares * sellPrice,
          reason: `ML看空(置信${(signal.confidence * 100).toFixed(0)}%), 但市场${sentimentLabel}→逆向减仓不空仓`,
          t1: t1Info,
          urgency: 'MEDIUM',
        });
      } else {
        operations.sells.push({
          action: 'SELL',
          code: holding.code,
          name: holding.name,
          shares: holding.shares,
          amount: holding.shares * sellPrice,
          reason: `ML看空(置信${(signal.confidence * 100).toFixed(0)}%)`,
          t1: t1Info,
          urgency: 'HIGH',
        });
      }
      continue;
    }

    // ★ V4.1: 移动止盈 (替换固定止盈)
    // 涨过激活阈值后, 从最高点回撤超过trailingStopPct则卖出
    if (peakProfitPct >= RISK_CONFIG.trailingStopActivation && drawdownFromPeak <= -trailingStopPct) {
      const sellPrice = currentPrice;
      operations.sells.push({
        action: 'SELL',
        code: holding.code,
        name: holding.name,
        shares: holding.shares,
        amount: holding.shares * sellPrice,
        reason: `移动止盈(峰值${(peakProfitPct * 100).toFixed(1)}%→回撤${(drawdownFromPeak * 100).toFixed(1)}%)`,
        t1: t1Info,
        urgency: 'MEDIUM',
      });
      continue;
    }

    // ★ V4.1: 部分止盈 — 仅在非牛市触发 (牛市让赢家跑)
    if (!isBull && profitPct >= RISK_CONFIG.partialTakeProfitThreshold) {
      const sellPrice = currentPrice;
      const sellShares = Math.floor(holding.shares * RISK_CONFIG.partialTakeProfitPct);
      operations.partialSells.push({
        action: 'PARTIAL_SELL',
        code: holding.code,
        name: holding.name,
        shares: sellShares,
        sellPct: RISK_CONFIG.partialTakeProfitPct * 100,
        amount: sellShares * sellPrice,
        reason: `部分止盈(${regime}体制,${(profitPct * 100).toFixed(1)}%)`,
        t1: t1Info,
        urgency: 'MEDIUM',
      });
      continue;
    }

    // 信号偏弱 → 减仓 (恐慌时暂缓减仓, 避免低点割肉)
    if (signal && signal.signal === 'WEAK' && signal.confidence > 0.5) {
      if (isFear) {
        operations.holds.push({
          action: 'HOLD',
          code: holding.code,
          name: holding.name,
          reason: `信号减弱(置信${(signal.confidence * 100).toFixed(0)}%), 但市场${sentimentLabel}→暂缓减仓不割肉`,
        });
      } else {
        const sellPrice = currentPrice;
        const reduceShares = Math.floor(holding.shares * (isGreed ? 0.4 : 0.3));
        operations.reduces.push({
          action: 'REDUCE',
          code: holding.code,
          name: holding.name,
          shares: reduceShares,
          reducePct: isGreed ? 40 : 30,
          amount: reduceShares * sellPrice,
          reason: `信号减弱(置信${(signal.confidence * 100).toFixed(0)}%)${isGreed ? '·市场过热减仓40%' : ''}`,
          t1: t1Info,
          urgency: 'LOW',
        });
      }
      continue;
    }

    // ★ V4.1: 体制感知超时退出 (牛市不限时)
    if (holdingDays >= maxHoldingDays && !isBull) {
      const sellPrice = currentPrice;
      operations.sells.push({
        action: 'SELL',
        code: holding.code,
        name: holding.name,
        shares: holding.shares,
        amount: holding.shares * sellPrice,
        reason: `${regime}体制超时(${holdingDays}天)`,
        t1: t1Info,
        urgency: 'LOW',
      });
      continue;
    }

    // 加仓: 信号强且(恐慌时小亏即可 / 平时需达阈值)
    const addThreshold = isFear ? 0 : RISK_CONFIG.addPositionThreshold;
    if (signal && (signal.signal === 'STRONG_BUY' || signal.signal === 'BUY')
        && profitPct < addThreshold
        && cash > (isFear ? 300 : 500)) {
      const addPrice = currentPrice || 1;
      const addAmount = Math.min(cash * RISK_CONFIG.addPositionMaxPct, isFear ? 1500 : 2000);
      operations.addPositions.push({
        action: 'ADD_POSITION',
        code: holding.code,
        name: holding.name,
        amount: addAmount,
        shares: Math.floor(addAmount / addPrice),
        reason: `跌${(Math.abs(profitPct) * 100).toFixed(1)}%+ML看多${isFear ? `·市场${sentimentLabel}逆向小加仓` : ''}`,
        t1: t1Info,
        urgency: 'MEDIUM',
      });
      continue;
    }

    // 持有
    operations.holds.push({
      action: 'HOLD',
      code: holding.code,
      name: holding.name,
      reason: signal ? `${signal.signal}·${regime}·持${holdingDays}天` : '持有观察',
    });
  }

  // --- 2b. 买入: 选最强信号 ---
  const availableCash = cash
    - operations.sells.reduce((a, o) => a + 0, 0) // 卖出后资金T+2到账, 不能立即用
    - operations.partialSells.reduce((a, o) => a + 0, 0)
    - operations.addPositions.reduce((a, o) => a + o.amount, 0)
    + operations.reduces.reduce((a, o) => a + 0, 0); // 减仓也是T+2

  let buyBudget = availableCash * (1 - RISK_CONFIG.cashReserve);
  // 贪婪时收紧买入预算(留更多现金防回调); 恐慌时略放宽(逆向布局)
  if (isGreed) buyBudget *= 0.5;
  else if (isFear) buyBudget *= 1.25;
  const maxPositions = RISK_CONFIG.maxTotalPositions - holdings.length + operations.sells.length;
  let buyCount = 0;

  for (const fund of rankedFunds) {
    if (buyBudget < 100 || buyCount >= maxPositions) break;

    // 跳过已持有的
    if (holdings.find(h => h.code === fund.code)) continue;

    const signal = fund.fusedSignal;
    if (!signal) continue;

    // 买入信号门槛: 贪婪时仅 STRONG_BUY; 恐慌时允许 WEAK 以上(逆向分批布局)
    if (isGreed) {
      if (signal.signal !== 'STRONG_BUY') continue;
    } else if (isFear) {
      if (signal.signal !== 'STRONG_BUY' && signal.signal !== 'BUY' && signal.signal !== 'WEAK') continue;
    } else {
      if (signal.signal !== 'STRONG_BUY' && signal.signal !== 'BUY') continue;
    }

    // 仓位计算: Kelly + ML信号加成
    let kellyFraction = 0.20; // 基础20%
    if (signal.signal === 'STRONG_BUY') kellyFraction = 0.35;
    else if (signal.signal === 'BUY') kellyFraction = 0.25;

    // 置信度调整 (保底50%仓位)
    kellyFraction *= Math.max(0.5, signal.confidence);

    // 单只上限
    kellyFraction = Math.min(kellyFraction, RISK_CONFIG.maxSinglePosition);

    const buyAmount = Math.min(buyBudget * kellyFraction, buyBudget, BUDGET * RISK_CONFIG.maxSinglePosition);
    if (buyAmount < 10) continue;

    const price = fund.price || fund.nav || 0;
    const shares = price > 0 ? Math.floor(buyAmount / price) : 0;

    operations.buys.push({
      action: 'BUY',
      code: fund.code,
      name: fund.name,
      amount: buyAmount,
      shares,
      price,
      score: fund.score || 0,
      mlSignal: signal.signal,
      confidence: signal.confidence,
      prediction: signal.prediction,
      reason: `${signal.signal} 置信${(signal.confidence * 100).toFixed(0)}% 预测${(signal.prediction * 100).toFixed(2)}%`,
      t1: t1Info,
      urgency: signal.signal === 'STRONG_BUY' ? 'HIGH' : 'MEDIUM',
    });

    buyBudget -= buyAmount;
    buyCount++;
  }

  // --- 2c. 转换: 弱基金 → 强基金 ---
  const weakHoldings = holdings.filter(h => {
    const fund = rankedFunds.find(f => f.code === h.code);
    return fund && fund.fusedSignal && fund.fusedSignal.signal === 'WEAK';
  });
  const strongCandidates = rankedFunds.filter(f =>
    f.fusedSignal && f.fusedSignal.signal === 'STRONG_BUY' &&
    !holdings.find(h => h.code === f.code)
  );

  for (let i = 0; i < Math.min(weakHoldings.length, strongCandidates.length); i++) {
    const weak = weakHoldings[i];
    const strong = strongCandidates[i];
    const weakFund = rankedFunds.find(f => f.code === weak.code);
    const sellValue = weak.shares * (weakFund?.price || weakFund?.nav || 0);

    operations.swaps.push({
      action: 'SWAP',
      sellCode: weak.code,
      sellName: weak.name,
      buyCode: strong.code,
      buyName: strong.name,
      sellValue,
      buyAmount: sellValue,
      reason: `${weak.name}信号弱 → ${strong.name}信号强`,
      t1: t1Info,
      urgency: 'MEDIUM',
    });
  }

  return {
    date: new Date().toLocaleString('zh-CN'),
    t1Info,
    operations,
    marketRegime: marketRegime?.regime || 'SIDEWAYS',
    marketSentiment: marketSentiment || null,
    summary: {
      sell: operations.sells.length,
      partialSell: operations.partialSells.length,
      buy: operations.buys.length,
      swap: operations.swaps.length,
      addPosition: operations.addPositions.length,
      reduce: operations.reduces.length,
      hold: operations.holds.length,
    },
  };
}

module.exports = {
  generateAdviceV4,
};
