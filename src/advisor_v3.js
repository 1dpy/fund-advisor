/**
 * 投资决策引擎 V3 — 全交易类型 + ML驱动
 *
 * 交易类型:
 *   1. BUY          买入（新建仓）
 *   2. SELL         全部卖出（清仓）
 *   3. PARTIAL_SELL 部分卖出（减仓/止盈一半）
 *   4. SWAP         转换（卖A买B，支付宝支持基金转换）
 *   5. PARTIAL_SWAP 部分转换（转换一半到更优基金）
 *   6. ADD_POSITION  加仓（持仓基金逢低加仓）
 *   7. REDUCE        减仓（持仓基金降低仓位）
 *   8. DCA_PLAN      定投计划（建议定期定额）
 *   9. HOLD          继续持有
 *
 * 增强能力:
 *   - ML集成信号驱动 (LSTM+RF+GBDT+Ensemble)
 *   - 基金持仓分析 (重仓股集中度+美股关联)
 *   - T+1结算时间线
 *   - 赎回费优化 (等免赎回费再操作)
 *   - 相关性分散化 (持仓重叠检测)
 *   - Kelly+ML 仓位分配
 *   - 移动止盈 + ATR动态止损
 *   - 板块轮动换仓
 */

const { BUDGET, RISK_CONFIG, FEE_CONFIG, WATCHLIST } = require('./config');
const { getSettlementTimeline, getRedemptionFeeRate, shouldWaitForFeeReduction } = require('./t1_calendar');

// ============================================================
//  持仓管理
// ============================================================

function loadHoldings() {
  const fs = require('fs');
  const path = require('path');
  const filePath = path.join(__dirname, '..', 'holdings.json');
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) { /* ignore */ }
  return [];
}

function saveHoldings(holdings) {
  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, '..', 'holdings.json'), JSON.stringify(holdings, null, 2), 'utf-8');
}

function getHoldingDays(buyDate) {
  return Math.floor((new Date() - new Date(buyDate)) / 86400000);
}

function calcFundRedemptionFee(amount, holdingDays) {
  const { rate, level } = getRedemptionFeeRate(holdingDays);
  return { fee: Math.round(amount * rate * 100) / 100, rate, level };
}

// ============================================================
//  市场仓位
// ============================================================

function getMarketMultiplier(marketRegime, newsSentiment, mlEnsemble, usImpact) {
  const { regime } = marketRegime;
  const multipliers = {
    'TRENDING_UP': 1.0, 'MELTUP': 0.85, 'SIDEWAYS': 0.75,
    'VOLATILE': 0.65, 'TRENDING_DOWN': 0.45, 'CRASH': 0.35, 'UNKNOWN': 0.55,
  };
  let base = multipliers[regime] || 0.55;

  // 新闻情绪微调
  if (newsSentiment?.available) {
    base = Math.max(0.25, Math.min(1.0, base * newsSentiment.adjustmentFactor));
  }

  // ML集成信号微调
  if (mlEnsemble?.ensembleSignal) {
    const es = mlEnsemble.ensembleSignal;
    if (es.overall === '偏多') base = Math.min(1.0, base + 0.05);
    else if (es.overall === '偏空') base = Math.max(0.25, base - 0.08);
  }

  // 美股影响微调
  if (usImpact?.available) {
    if (usImpact.sentiment === '积极') base = Math.min(1.0, base + 0.03);
    else if (usImpact.sentiment === '消极') base = Math.max(0.25, base - 0.05);
    // VIX恐慌
    if (usImpact.vix?.price > 25) base = Math.max(0.25, base - 0.10);
  }

  return Math.round(base * 100) / 100;
}

// ============================================================
//  主决策函数
// ============================================================

function generateAdviceV3(analysisResult) {
  const {
    marketRegime, marketTemp, rankedFunds, fetchTime, indexes,
    newsSentiment, rotationSignals, hmmResult, ensembleResult,
    anomalyAlerts, factorResult, bayesianResult,
    navPredictions, settlementInfo, usImpact,
    mlEnsemble, fundHoldingsAnalysis, t1Timeline,
  } = analysisResult;

  const holdings = loadHoldings();

  const decisions = {
    date: fetchTime,
    marketRegime,
    marketTemp,
    indexes,
    newsSentiment: newsSentiment || null,
    rotationSignals: rotationSignals || [],
    hmmResult: hmmResult || null,
    ensembleResult: ensembleResult || null,
    anomalyAlerts: anomalyAlerts || [],
    factorResult: factorResult || null,
    bayesianResult: bayesianResult || null,
    navPredictions: navPredictions || {},
    settlementInfo: settlementInfo || null,
    usImpact: usImpact || null,
    mlEnsemble: mlEnsemble || null,
    fundHoldingsAnalysis: fundHoldingsAnalysis || null,
    t1Timeline: t1Timeline || null,
    budget: BUDGET,
    holdings,
    // 全交易类型
    buyOrders: [],
    sellOrders: [],
    partialSells: [],
    swapPlans: [],
    partialSwaps: [],
    addPositions: [],
    reducePositions: [],
    dcaPlans: [],
    holdAdvices: [],
    summary: '',
    riskWarnings: [],
    _rankedFunds: rankedFunds,
  };

  const holdingCodes = new Set(holdings.map(h => h.code));

  // Step 1: 卖出检查（含部分卖出）
  const sellAmount = processSellsV3(decisions, holdings, rankedFunds, marketRegime, mlEnsemble, usImpact);

  // Step 2: 仓位计算
  const marketMultiplier = getMarketMultiplier(marketRegime, decisions.newsSentiment, mlEnsemble, usImpact);
  const invested = holdings.reduce((s, h) => s + h.costBasis, 0);
  const availableCash = BUDGET - invested + sellAmount;
  const investableCash = Math.min(availableCash, BUDGET * marketMultiplier);
  const cashToInvest = investableCash * (1 - RISK_CONFIG.cashReserve);

  // Step 3: 买入
  const buyCandidates = screenBuyCandidatesV3(rankedFunds, holdingCodes, marketRegime, decisions.navPredictions, usImpact, mlEnsemble, fundHoldingsAnalysis);
  if (cashToInvest > 50 && buyCandidates.length > 0) {
    allocateBuyOrdersV3(decisions, buyCandidates, cashToInvest, holdings.length, rankedFunds, marketRegime, mlEnsemble);
  }

  // Step 4: 调仓换仓（含部分转换）
  const isFull = invested >= BUDGET * 0.80 && availableCash < 300;
  if (isFull && sellAmount < 100) {
    generateSwapPlansV3(decisions, holdings, rankedFunds, marketRegime, mlEnsemble, fundHoldingsAnalysis);
  }

  // Step 5: 加仓（持仓基金逢低加仓）
  checkAddPositionV3(decisions, holdings, rankedFunds, cashToInvest, mlEnsemble);

  // Step 6: 减仓（持仓过重或信号转弱）
  checkReducePosition(decisions, holdings, rankedFunds, marketRegime, mlEnsemble);

  // Step 7: 定投计划建议
  generateDCAPlans(decisions, holdings, rankedFunds, marketRegime);

  // Step 8: 持有建议
  generateHoldAdvices(decisions, holdings, rankedFunds);

  // Step 9: 科技集中度检查
  checkTechConcentration(decisions, holdings, rankedFunds);

  // Step 10: 风险提示
  generateWarningsV3(decisions);

  // 生成摘要
  decisions.summary = generateSummary(decisions);

  return decisions;
}

// ============================================================
//  卖出逻辑 V3（含部分卖出）
// ============================================================

function processSellsV3(decisions, holdings, rankedFunds, marketRegime, mlEnsemble, usImpact) {
  let totalSell = 0;

  for (const holding of holdings) {
    const analysis = rankedFunds.find(f => f.code === holding.code);
    if (!analysis) continue;

    const price = analysis.price || holding.buyPrice;
    const currentProfit = (price - holding.buyPrice) / holding.buyPrice;
    const holdingDays = getHoldingDays(holding.buyDate);
    const mlPred = mlEnsemble?.fundPredictions?.[holding.code];
    const sellValue = holding.shares * price;

    let shouldSell = false, shouldPartialSell = false, reason = '', sellPct = 1.0;

    // 1. 动态止损 (ATR自适应)
    const atrPct = analysis.indicators?.atr?.atrPct || 2;
    const dynamicStop = Math.max(RISK_CONFIG.stopLossRatio, -atrPct * 3 / 100);
    if (currentProfit <= dynamicStop) {
      shouldSell = true;
      reason = `动态止损(ATR${atrPct.toFixed(1)}% → 止损线${(dynamicStop*100).toFixed(1)}%)`;
    }

    // 2. ML信号强烈看空
    if (mlPred?.mlSignal === 'ML_STRONG_SELL') {
      shouldSell = true;
      reason = `ML模型强烈看空(共识${mlPred.consensus}%)`;
    }

    // 3. 移动止盈: 涨超15%激活, 从高点回撤5%
    if (currentProfit >= 0.15) {
      const history = analysis.history || [];
      let peakPrice = price;
      if (history.length > 0) {
        const recentCloses = history.slice(-10).map(h => h.close || h.nav || 0).filter(v => v > 0);
        if (recentCloses.length > 0) peakPrice = Math.max(...recentCloses);
      }
      const drawdownFromPeak = (price - peakPrice) / peakPrice;
      if (drawdownFromPeak <= -0.05) {
        // 部分卖出: 落袋一半
        shouldPartialSell = true;
        sellPct = 0.5;
        reason = `移动止盈: 从高点¥${peakPrice.toFixed(3)}回撤${(drawdownFromPeak*100).toFixed(1)}%, 落袋50%`;
      }
    }

    // 4. 固定止盈
    if (currentProfit >= RISK_CONFIG.takeProfitRatio) {
      shouldPartialSell = true;
      sellPct = 0.6;
      reason = `触发止盈线(+${(currentProfit*100).toFixed(1)}%), 卖出60%锁定利润`;
    }

    // 5. 信号卖出
    if (analysis.signal === 'SELL') {
      shouldSell = true;
      reason = '技术信号全面转空';
    }

    // 6. 信号弱势 + 市场下行
    if (analysis.signal === 'WEAK' && marketRegime.regime === 'TRENDING_DOWN') {
      shouldPartialSell = true;
      sellPct = 0.5;
      reason = '弱势基金+市场下行, 减半仓位';
    }

    // 7. 美股利空传导
    if (usImpact?.fundAdjustments?.[holding.code] < -5) {
      shouldPartialSell = true;
      sellPct = 0.3;
      reason = `美股利空传导(${usImpact.fundAdjustments[holding.code].toFixed(1)}%), 减仓30%`;
    }

    // 8. 赎回费保护
    const feeCheck = shouldWaitForFeeReduction(holdingDays, currentProfit);
    if (feeCheck.shouldWait && !shouldSell) {
      decisions.holdAdvices.push({
        code: holding.code, name: holding.name,
        action: 'HOLD',
        reason: feeCheck.reason,
        daysToWait: feeCheck.daysToWait,
      });
      continue;
    }
    if (holdingDays < RISK_CONFIG.minHoldingDays && (shouldSell || shouldPartialSell) && currentProfit > RISK_CONFIG.stopLossRatio) {
      continue;
    }

    // 执行卖出
    if (shouldSell) {
      const { fee, rate, level } = calcFundRedemptionFee(sellValue, holdingDays);
      const netValue = sellValue - fee;
      decisions.sellOrders.push({
        code: holding.code, name: holding.name, type: holding.type,
        shares: holding.shares, price,
        value: Math.round(sellValue * 100) / 100,
        fee, feeRate: rate, feeLevel: level,
        netValue: Math.round(netValue * 100) / 100,
        costBasis: holding.costBasis,
        profit: Math.round((netValue - holding.costBasis) * 100) / 100,
        profitPct: (currentProfit * 100).toFixed(1) + '%',
        holdingDays, reason,
        t1Info: getSettlementTimeline(holding.type === 'qdii' ? 'qdii' : 'fund'),
      });
      totalSell += netValue;
    } else if (shouldPartialSell) {
      const partialShares = Math.round(holding.shares * sellPct);
      const partialValue = partialShares * price;
      const { fee, rate, level } = calcFundRedemptionFee(partialValue, holdingDays);
      const netValue = partialValue - fee;
      decisions.partialSells.push({
        code: holding.code, name: holding.name, type: holding.type,
        shares: partialShares, totalShares: holding.shares,
        sellPct: Math.round(sellPct * 100),
        price,
        value: Math.round(partialValue * 100) / 100,
        fee, feeRate: rate, feeLevel: level,
        netValue: Math.round(netValue * 100) / 100,
        remainingShares: holding.shares - partialShares,
        remainingValue: Math.round((holding.shares - partialShares) * price * 100) / 100,
        holdingDays,
        profitPct: (currentProfit * 100).toFixed(1) + '%',
        reason,
        t1Info: getSettlementTimeline(holding.type === 'qdii' ? 'qdii' : 'fund'),
      });
      totalSell += netValue;
    }
  }

  return totalSell;
}

// ============================================================
//  买入候选筛选 V3
// ============================================================

function screenBuyCandidatesV3(rankedFunds, holdingCodes, marketRegime, navPredictions, usImpact, mlEnsemble, fundHoldings) {
  const { regime } = marketRegime;
  const preds = navPredictions || {};

  let maxChangePct;
  switch (regime) {
    case 'MELTUP': case 'TRENDING_UP': maxChangePct = 7; break;
    case 'SIDEWAYS': maxChangePct = 4; break;
    case 'VOLATILE': maxChangePct = 3; break;
    case 'TRENDING_DOWN': maxChangePct = 2; break;
    case 'CRASH': maxChangePct = 1.5; break;
    default: maxChangePct = 4;
  }

  const candidates = [];

  for (const f of rankedFunds) {
    if (candidates.length >= 15) break;
    if (holdingCodes.has(f.code)) continue;
    if (!['STRONG_BUY', 'BUY', 'HOLD'].includes(f.signal)) continue;
    if (regime === 'CRASH' && f.signal === 'HOLD') continue;

    // ML信号过滤: ML强烈看空的不买
    const mlPred = mlEnsemble?.fundPredictions?.[f.code];
    if (mlPred?.mlSignal === 'ML_STRONG_SELL') continue;
    if (mlPred?.mlSignal === 'ML_SELL' && regime === 'TRENDING_DOWN') continue;

    // 净值预测调整
    const pred = preds[f.code];
    let effectiveMaxPct = maxChangePct;
    if (pred && pred.confidence === 'high') {
      if (pred.changePct < -1) effectiveMaxPct += 2;
      else if (pred.changePct > 3) effectiveMaxPct -= 1;
    }

    // 美股影响
    if (usImpact?.fundAdjustments) {
      const usAdj = usImpact.fundAdjustments[f.code];
      if (usAdj && usAdj < -5) continue;
      if (usAdj && usAdj < -3 && (f.changePct || 0) < -1) continue;
    }

    if (Math.abs(f.changePct || 0) > effectiveMaxPct) continue;
    if ((f.changePct || 0) < -5) continue;

    // 场内ETF: 支付宝买不了, 跳过
    if (f.fundType === 'etf') continue;

    // 持仓重叠检查: 如果该基金与现有持仓高度重叠, 降低优先级
    if (fundHoldings?.overlaps) {
      const hasOverlap = fundHoldings.overlaps.some(o =>
        (o.fund1 === f.code || o.fund2 === f.code) && o.overlapCount >= 5
      );
      if (hasOverlap) continue;
    }

    // ML加分: 如果ML模型看好, 提升优先级
    if (mlPred?.mlSignal === 'ML_STRONG_BUY' || mlPred?.mlSignal === 'ML_BUY') {
      f._mlBoost = mlPred.mlConfidence;
    }

    candidates.push(f);
  }

  return candidates;
}

// ============================================================
//  买入资金分配 V3 (Kelly + ML)
// ============================================================

function allocateBuyOrdersV3(decisions, candidates, totalCash, currentPositions, rankedFunds, marketRegime, mlEnsemble) {
  const maxNew = RISK_CONFIG.maxTotalPositions - currentPositions - decisions.sellOrders.length;
  if (maxNew <= 0) return;

  const scored = candidates.slice(0, Math.min(candidates.length, maxNew + 3))
    .map(c => {
      // Kelly启发: 分数越高分配越多
      let kellyFraction = Math.max(0.05, (c.score - 40) / 100);

      // ML信号加权
      const mlPred = mlEnsemble?.fundPredictions?.[c.code];
      if (mlPred) {
        if (mlPred.mlSignal === 'ML_STRONG_BUY') kellyFraction *= 1.4;
        else if (mlPred.mlSignal === 'ML_BUY') kellyFraction *= 1.15;
        else if (mlPred.mlSignal === 'ML_HOLD') kellyFraction *= 0.8;
      }

      // 波动率惩罚
      const volPenalty = c.indicators?.atr?.atrPct
        ? Math.min(1, 1.5 / c.indicators.atr.atrPct)
        : 1;

      return { ...c, _weight: kellyFraction * volPenalty };
    })
    .sort((a, b) => b._weight - a._weight);

  const totalWeight = scored.reduce((s, c) => s + c._weight, 0);
  if (totalWeight === 0) return;

  let remaining = totalCash;

  for (const candidate of scored.slice(0, maxNew)) {
    const rawAlloc = totalCash * (candidate._weight / totalWeight);
    let amount = Math.round(Math.max(rawAlloc, 10));

    if (amount < 10) continue;
    if (amount > remaining) amount = Math.round(remaining);
    if (amount < 10) continue;

    remaining -= amount;

    // 生成买入理由
    const mlPred = mlEnsemble?.fundPredictions?.[candidate.code];
    const mlReason = mlPred ? `ML:${mlPred.mlSignal}(${mlPred.mlConfidence}%)` : '';

    decisions.buyOrders.push({
      code: candidate.code, name: candidate.name,
      type: 'fund',
      price: candidate.price, changePct: candidate.changePct,
      score: candidate.score, signal: candidate.signal,
      amount, fee: 0,
      mlSignal: mlPred?.mlSignal,
      mlConfidence: mlPred?.mlConfidence,
      reason: generateBuyReasonV3(candidate, mlPred),
      t1Info: getSettlementTimeline('fund'),
    });
  }

  if (remaining > 100) {
    decisions._remainingCash = Math.round(remaining);
  }
}

function generateBuyReasonV3(candidate, mlPred) {
  const reasons = [];
  const ind = candidate.indicators || {};
  const sub = candidate.subScores || [];

  const topSubs = sub.filter(s => s.score / s.max > 0.7).map(s => s.name);
  if (topSubs.length > 0) reasons.push(topSubs.slice(0, 3).join('+'));
  if (ind.macd?.goldenCross) reasons.push('MACD金叉');
  if (ind.kdj?.zone === '超卖') reasons.push('KDJ超卖');
  if (ind.volDivergence === 'bullish_divergence') reasons.push('底背离');
  if (ind.hlTrend === 'uptrend') reasons.push('上升结构');
  if (ind.momentumQuality > 1.5) reasons.push('高质量动量');
  if (ind.sharpe > 1.5) reasons.push('高夏普');
  if (mlPred?.mlSignal === 'ML_STRONG_BUY') reasons.push(`ML强烈看多(${mlPred.consensus}%共识)`);
  else if (mlPred?.mlSignal === 'ML_BUY') reasons.push(`ML看多`);

  if (reasons.length === 0) reasons.push('综合评分领先');
  return reasons.slice(0, 4).join('; ');
}

// ============================================================
//  调仓换仓 V3（含部分转换）
// ============================================================

function generateSwapPlansV3(decisions, holdings, rankedFunds, marketRegime, mlEnsemble, fundHoldings) {
  const holdingCodes = new Set(holdings.map(h => h.code));
  const techKeywords = ['电池', '芯片', '半导体', '信息', '科创', '科技', 'AI', '互联网', '创业板', '电子'];

  for (const holding of holdings) {
    const analysis = rankedFunds.find(f => f.code === holding.code);
    if (!analysis) continue;

    const holdingDays = getHoldingDays(holding.buyDate);
    const holdingScore = analysis.score || 0;
    const isTech = techKeywords.some(kw => (holding.name || '').includes(kw));
    const mlPred = mlEnsemble?.fundPredictions?.[holding.code];

    if (holdingDays < 7) continue;
    if (holdingScore >= 58 && analysis.signal !== 'WEAK' && mlPred?.mlSignal !== 'ML_SELL') continue;

    const scoreGapNeeded = isTech ? 10 : 15;
    const minTargetScore = holdingScore + scoreGapNeeded;

    // 找替代品
    const alternatives = rankedFunds
      .filter(f => {
        if (holdingCodes.has(f.code)) return false;
        if (f.signal === 'SELL' || f.signal === 'WEAK') return false;
        if (f.score < minTargetScore) return false;
        // ML信号过滤
        const altMl = mlEnsemble?.fundPredictions?.[f.code];
        if (altMl?.mlSignal === 'ML_STRONG_SELL' || altMl?.mlSignal === 'ML_SELL') return false;
        return true;
      })
      .sort((a, b) => {
        const aMl = mlEnsemble?.fundPredictions?.[a.code];
        const bMl = mlEnsemble?.fundPredictions?.[b.code];
        const aBoost = aMl?.mlSignal?.includes('BUY') ? 5 : 0;
        const bBoost = bMl?.mlSignal?.includes('BUY') ? 5 : 0;
        return (b.score + bBoost) - (a.score + aBoost);
      })
      .slice(0, 2);

    if (alternatives.length === 0) continue;

    const price = analysis.price || holding.buyPrice;
    const sellValue = holding.shares * price;
    const { fee: redemptionFee, rate, level } = calcFundRedemptionFee(sellValue, holdingDays);

    // 决定: 全部转换还是部分转换
    // 如果评分差距很大(>20) 或 ML强烈看空 → 全部转换
    // 如果差距中等(10-20) → 部分转换50%
    const gap = alternatives[0].score - holdingScore;
    const isFullSwap = gap > 20 || mlPred?.mlSignal === 'ML_STRONG_SELL';
    const swapPct = isFullSwap ? 1.0 : 0.5;
    const swapShares = Math.round(holding.shares * swapPct);
    const swapValue = swapShares * price;
    const swapFee = Math.round(redemptionFee * swapPct * 100) / 100;
    const netCash = swapValue - swapFee;

    if (netCash < 200) continue;

    const alt = alternatives[0];
    const altMl = mlEnsemble?.fundPredictions?.[alt.code];

    if (isFullSwap) {
      decisions.swapPlans.push({
        type: 'FULL_SWAP',
        sellCode: holding.code, sellName: holding.name,
        sellShares: holding.shares, sellValue: Math.round(sellValue * 100) / 100,
        sellFee: redemptionFee, feeLevel: level,
        sellScore: holdingScore, sellDays: holdingDays,
        sellReason: holdingScore < 45 ? '评分偏低' : '存在更优替代',

        buyCode: alt.code, buyName: alt.name,
        buyScore: alt.score, buyAmount: Math.round(netCash),
        buyPrice: alt.price || 0,
        buyMlSignal: altMl?.mlSignal,
        netCash: Math.round(netCash * 100) / 100,
        t1Info: getSettlementTimeline('fund'),
      });
    } else {
      decisions.partialSwaps.push({
        type: 'PARTIAL_SWAP',
        sellCode: holding.code, sellName: holding.name,
        sellShares: swapShares, totalShares: holding.shares,
        swapPct: Math.round(swapPct * 100),
        sellValue: Math.round(swapValue * 100) / 100,
        sellFee: swapFee,
        sellScore: holdingScore, sellDays: holdingDays,
        remainingShares: holding.shares - swapShares,

        buyCode: alt.code, buyName: alt.name,
        buyScore: alt.score, buyAmount: Math.round(netCash),
        buyPrice: alt.price || 0,
        buyMlSignal: altMl?.mlSignal,
        netCash: Math.round(netCash * 100) / 100,
        reason: `评分差距${gap}分, 部分转换优化组合`,
        t1Info: getSettlementTimeline('fund'),
      });
    }
  }
}

// ============================================================
//  加仓 V3
// ============================================================

function checkAddPositionV3(decisions, holdings, rankedFunds, availableCash, mlEnsemble) {
  if (availableCash < 100) return;
  const navPreds = decisions.navPredictions || {};
  const indexes = decisions.indexes || [];
  const existingCodes = new Set(decisions.buyOrders.map(o => o.code));
  if (existingCodes.size >= 2) return;

  const cyb = indexes.find(i => i.name.includes('创业板'));
  const kcb = indexes.find(i => i.name.includes('科创'));
  const maxTechIndexDrop = Math.min(cyb?.changePct || 0, kcb?.changePct || 0);

  for (const h of holdings) {
    if (existingCodes.has(h.code)) continue;
    const analysis = rankedFunds.find(f => f.code === h.code);
    if (!analysis) continue;
    if (!['STRONG_BUY', 'BUY'].includes(analysis.signal)) continue;
    if (analysis.score < 55) continue;

    const mlPred = mlEnsemble?.fundPredictions?.[h.code];
    // ML看空不加仓
    if (mlPred?.mlSignal === 'ML_SELL' || mlPred?.mlSignal === 'ML_STRONG_SELL') continue;

    const actualChg = analysis.changePct || 0;
    const predChg = navPreds[h.code]?.changePct || 0;
    const effectiveChg = predChg !== 0 ? predChg : actualChg !== 0 ? actualChg : maxTechIndexDrop;

    // ML看多 + 下跌 = 更好的加仓机会
    const mlBoost = mlPred?.mlSignal === 'ML_STRONG_BUY' ? 1.5 : mlPred?.mlSignal === 'ML_BUY' ? 1.2 : 1.0;
    const threshold = -3 / mlBoost;

    if (effectiveChg <= threshold) {
      const addPct = Math.min(0.3, Math.abs(effectiveChg) / 15 * mlBoost);
      const addAmount = Math.round(Math.max(availableCash * addPct, 100));
      if (addAmount >= 100) {
        decisions.addPositions.push({
          code: h.code, name: h.name || analysis.name,
          type: 'fund', price: analysis.price || h.buyPrice,
          changePct: effectiveChg, score: analysis.score,
          signal: analysis.signal,
          mlSignal: mlPred?.mlSignal,
          amount: addAmount, fee: 0,
          reason: `加仓摊平 当日跌${effectiveChg.toFixed(1)}%${mlPred ? ` ML:${mlPred.mlSignal}` : ''}`,
          t1Info: getSettlementTimeline('fund'),
        });
        existingCodes.add(h.code);
        break;
      }
    }
  }
}

// ============================================================
//  减仓
// ============================================================

function checkReducePosition(decisions, holdings, rankedFunds, marketRegime, mlEnsemble) {
  for (const h of holdings) {
    const analysis = rankedFunds.find(f => f.code === h.code);
    if (!analysis) continue;

    const price = analysis.price || h.buyPrice;
    const sellValue = h.shares * price;
    const holdingDays = getHoldingDays(h.buyDate);
    const mlPred = mlEnsemble?.fundPredictions?.[h.code];

    // 单只仓位过重 (>35%)
    const weight = sellValue / BUDGET;
    if (weight > 0.35 && holdingDays >= 7) {
      const reduceShares = Math.round(h.shares * 0.2); // 减20%
      const reduceValue = reduceShares * price;
      const { fee, rate } = calcFundRedemptionFee(reduceValue, holdingDays);
      decisions.reducePositions.push({
        code: h.code, name: h.name,
        shares: reduceShares, totalShares: h.shares,
        reducePct: 20,
        price, value: Math.round(reduceValue * 100) / 100,
        fee: Math.round(fee * 100) / 100,
        currentWeight: Math.round(weight * 100),
        reason: `仓位过重(${Math.round(weight*100)}%), 减仓20%控制风险`,
        t1Info: getSettlementTimeline('fund'),
      });
    }

    // ML信号转弱 + 有盈利
    const currentProfit = (price - h.buyPrice) / h.buyPrice;
    if (mlPred?.mlSignal === 'ML_SELL' && currentProfit > 0.05 && holdingDays >= 7) {
      const reduceShares = Math.round(h.shares * 0.3);
      const reduceValue = reduceShares * price;
      const { fee } = calcFundRedemptionFee(reduceValue, holdingDays);
      decisions.reducePositions.push({
        code: h.code, name: h.name,
        shares: reduceShares, totalShares: h.shares,
        reducePct: 30,
        price, value: Math.round(reduceValue * 100) / 100,
        fee: Math.round(fee * 100) / 100,
        reason: `ML信号转弱(ML_SELL), 减仓30%锁定部分利润`,
        t1Info: getSettlementTimeline('fund'),
      });
    }
  }
}

// ============================================================
//  定投计划
// ============================================================

function generateDCAPlans(decisions, holdings, rankedFunds, marketRegime) {
  if (marketRegime.regime === 'CRASH') {
    // 暴跌时建议定投抄底
    const top3 = rankedFunds.filter(f => f.signal === 'BUY' || f.signal === 'STRONG_BUY').slice(0, 3);
    for (const f of top3) {
      decisions.dcaPlans.push({
        code: f.code, name: f.name,
        weeklyAmount: 200,
        reason: '市场暴跌, 建议开启每周200定投, 分批抄底',
        duration: '4周',
      });
    }
  } else if (marketRegime.regime === 'SIDEWAYS') {
    // 横盘时建议定投积累
    const top2 = rankedFunds.filter(f => f.signal === 'BUY' || f.signal === 'STRONG_BUY').slice(0, 2);
    for (const f of top2) {
      if (holdings.find(h => h.code === f.code)) {
        decisions.dcaPlans.push({
          code: f.code, name: f.name,
          weeklyAmount: 100,
          reason: '横盘震荡, 定投积累筹码降低成本',
          duration: '持续',
        });
      }
    }
  }
}

// ============================================================
//  持有建议
// ============================================================

function generateHoldAdvices(decisions, holdings, rankedFunds) {
  for (const h of holdings) {
    const analysis = rankedFunds.find(f => f.code === h.code);
    if (!analysis) continue;

    // 已有卖出/减仓建议的跳过
    if (decisions.sellOrders.find(o => o.code === h.code)) continue;
    if (decisions.partialSells.find(o => o.code === h.code)) continue;
    if (decisions.reducePositions.find(o => o.code === h.code)) continue;
    if (decisions.swapPlans.find(o => o.sellCode === h.code)) continue;
    if (decisions.partialSwaps.find(o => o.sellCode === h.code)) continue;

    const price = analysis.price || h.buyPrice;
    const currentProfit = (price - h.buyPrice) / h.buyPrice;
    const holdingDays = getHoldingDays(h.buyDate);

    let reason;
    if (analysis.signal === 'STRONG_BUY' || analysis.signal === 'BUY') {
      reason = `信号良好(${analysis.signal}), 继续持有`;
    } else if (analysis.signal === 'HOLD') {
      reason = '信号中性, 持有观望';
    } else if (currentProfit > 0.1) {
      reason = `有浮盈${(currentProfit*100).toFixed(1)}%, 持有待信号改善`;
    } else {
      reason = `持有${holdingDays}天, 等待反转信号`;
    }

    decisions.holdAdvices.push({
      code: h.code, name: h.name,
      action: 'HOLD',
      signal: analysis.signal,
      score: analysis.score,
      profitPct: (currentProfit * 100).toFixed(1) + '%',
      holdingDays,
      reason,
    });
  }
}

// ============================================================
//  辅助
// ============================================================

function checkTechConcentration(decisions, holdings, rankedFunds) {
  const techKeywords = ['电池', '芯片', '半导体', '信息', '科创', '科技', 'AI', '互联网', '创业板', '电子'];
  const nonTechKeywords = ['全球', 'QDII', '海外', '纳斯达克', '港股'];
  let techTotal = 0;

  for (const h of holdings) {
    const fund = rankedFunds.find(f => f.code === h.code);
    const price = fund?.price || h.buyPrice;
    const value = h.shares * price;
    const name = h.name || '';
    const isNonTech = nonTechKeywords.some(kw => name.includes(kw));
    if (!isNonTech && techKeywords.some(kw => name.includes(kw))) techTotal += value;
  }
  for (const o of decisions.buyOrders) {
    if (techKeywords.some(kw => (o.name || '').includes(kw))) techTotal += o.amount;
  }
  for (const o of decisions.addPositions) {
    if (techKeywords.some(kw => (o.name || '').includes(kw))) techTotal += o.amount;
  }

  const techPct = techTotal / BUDGET;
  if (techPct > RISK_CONFIG.maxTechConcentration) {
    decisions._techWarning = `科技赛道集中度${(techPct*100).toFixed(0)}% > 上限${(RISK_CONFIG.maxTechConcentration*100).toFixed(0)}%, 建议增加QDII或宽基分散`;
  }
}

function generateWarningsV3(decisions) {
  const w = [];
  const regime = decisions.marketRegime?.regime;
  if (regime === 'CRASH' || regime === 'TRENDING_DOWN') {
    w.push('市场偏弱, 控制仓位, 保留子弹');
  }
  if (regime === 'MELTUP') {
    w.push('市场快速拉升, 注意追高风险, 设置移动止盈');
  }

  // VIX恐慌
  if (decisions.usImpact?.vix?.price > 25) {
    w.push(`⚠️ VIX恐慌指数${decisions.usImpact.vix.price}偏高, 市场情绪不稳`);
  }

  // 美股前瞻
  if (decisions.usImpact?.nextDayPrediction?.upProb < 30) {
    w.push(`⚠️ 隔夜美股大跌, 明日A股大概率高开下行, 谨慎操作`);
  }

  // ML整体偏空
  if (decisions.mlEnsemble?.ensembleSignal?.overall === '偏空') {
    w.push(`⚠️ ML模型整体偏空(看空比例${decisions.mlEnsemble.ensembleSignal.bearishRatio}%)`);
  }

  // 持仓重叠
  if (decisions.fundHoldingsAnalysis?.overlaps?.length > 0) {
    const highOverlap = decisions.fundHoldingsAnalysis.overlaps.filter(o => o.overlapCount >= 5);
    if (highOverlap.length > 0) {
      w.push(`⚠️ 持仓基金重仓股高度重叠(${highOverlap.length}对), 分散化不足`);
    }
  }

  if (decisions.buyOrders.length + decisions.addPositions.length >= RISK_CONFIG.maxTotalPositions - 2) {
    w.push('持仓数量接近上限, 优先调仓而非加仓');
  }
  if (decisions._techWarning) w.push(decisions._techWarning);

  // T+1提醒
  if (decisions.t1Timeline?.beforeCutoff) {
    w.push(`⏰ ${decisions.t1Timeline.description}`);
  }

  w.push('支付宝C类基金0申购费, 15:00前下单按今日净值');
  w.push('技术分析+机器学习仅供参考, 投资需谨慎');
  decisions.riskWarnings = w;
}

function generateSummary(decisions) {
  const parts = [];
  parts.push(`市场:${decisions.marketRegime?.regime || '?'} 温度:${decisions.marketTemp || '?'}°`);

  if (decisions.usImpact?.available) {
    parts.push(`美股:${decisions.usImpact.sentiment}`);
  }
  if (decisions.mlEnsemble?.ensembleSignal) {
    parts.push(`ML:${decisions.mlEnsemble.ensembleSignal.overall}`);
  }
  if (decisions.hmmResult?.currentState) {
    parts.push(`HMM:${decisions.hmmResult.currentState}`);
  }

  const actions = [];
  if (decisions.sellOrders.length > 0) actions.push(`卖出${decisions.sellOrders.length}`);
  if (decisions.partialSells.length > 0) actions.push(`部分卖${decisions.partialSells.length}`);
  if (decisions.buyOrders.length > 0) actions.push(`买入${decisions.buyOrders.length}`);
  if (decisions.addPositions.length > 0) actions.push(`加仓${decisions.addPositions.length}`);
  if (decisions.swapPlans.length > 0) actions.push(`转换${decisions.swapPlans.length}`);
  if (decisions.partialSwaps.length > 0) actions.push(`部分转换${decisions.partialSwaps.length}`);
  if (decisions.reducePositions.length > 0) actions.push(`减仓${decisions.reducePositions.length}`);
  if (decisions.dcaPlans.length > 0) actions.push(`定投${decisions.dcaPlans.length}`);
  if (decisions.holdAdvices.length > 0) actions.push(`持有${decisions.holdAdvices.length}`);

  if (actions.length > 0) parts.push(actions.join(' '));
  else parts.push('建议观望');

  return parts.join(' | ');
}

// ============================================================
//  应用决策
// ============================================================

function applyDecisions(decisions) {
  const holdings = loadHoldings();

  // 处理全部卖出
  const sellCodes = new Set(decisions.sellOrders.map(o => o.code));
  let newHoldings = holdings.filter(h => !sellCodes.has(h.code));

  // 处理部分卖出
  for (const ps of decisions.partialSells) {
    const idx = newHoldings.findIndex(h => h.code === ps.code);
    if (idx >= 0) {
      newHoldings[idx].shares = ps.remainingShares;
      newHoldings[idx].costBasis = Math.round(ps.remainingValue * 100) / 100;
    }
  }

  // 处理减仓
  for (const rp of decisions.reducePositions) {
    const idx = newHoldings.findIndex(h => h.code === rp.code);
    if (idx >= 0) {
      newHoldings[idx].shares = rp.totalShares - rp.shares;
      newHoldings[idx].costBasis = Math.round(newHoldings[idx].shares * newHoldings[idx].buyPrice * 100) / 100;
    }
  }

  // 处理全部转换
  for (const sp of decisions.swapPlans) {
    newHoldings = newHoldings.filter(h => h.code !== sp.sellCode);
    newHoldings.push({
      code: sp.buyCode, name: sp.buyName, type: 'fund',
      buyPrice: sp.buyPrice,
      shares: sp.buyAmount / sp.buyPrice,
      costBasis: sp.buyAmount,
      buyDate: new Date().toISOString().split('T')[0],
    });
  }

  // 处理部分转换
  for (const ps of decisions.partialSwaps) {
    const idx = newHoldings.findIndex(h => h.code === ps.sellCode);
    if (idx >= 0) {
      newHoldings[idx].shares = ps.remainingShares;
      newHoldings[idx].costBasis = Math.round(ps.remainingShares * newHoldings[idx].buyPrice * 100) / 100;
    }
    newHoldings.push({
      code: ps.buyCode, name: ps.buyName, type: 'fund',
      buyPrice: ps.buyPrice,
      shares: ps.buyAmount / ps.buyPrice,
      costBasis: ps.buyAmount,
      buyDate: new Date().toISOString().split('T')[0],
    });
  }

  // 处理买入
  for (const order of [...decisions.buyOrders, ...decisions.addPositions]) {
    newHoldings.push({
      code: order.code, name: order.name, type: order.type,
      buyPrice: order.price,
      shares: order.amount / order.price,
      costBasis: order.amount,
      buyDate: new Date().toISOString().split('T')[0],
    });
  }

  saveHoldings(newHoldings);
  return newHoldings;
}

module.exports = {
  generateAdvice: generateAdviceV3,
  applyDecisions,
  loadHoldings,
  saveHoldings,
};
