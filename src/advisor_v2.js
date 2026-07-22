/**
 * 投资决策引擎 V2
 * - 市场体制自适应仓位
 * - 相关性分散化
 * - Kelly启发式仓位分配
 * - 动态止盈止损
 * - 调仓优化(考虑赎回费阶梯)
 */

const { BUDGET, RISK_CONFIG, FEE_CONFIG, DEFAULT_HOLDINGS, WATCHLIST } = require('./config');

// ============================================================
//  持仓和费用
// ============================================================

function loadHoldings() {
  const fs = require('fs');
  const path = require('path');
  const filePath = path.join(__dirname, '..', 'holdings.json');
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) { /* ignore */ }
  return DEFAULT_HOLDINGS;
}

function saveHoldings(holdings) {
  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, '..', 'holdings.json'), JSON.stringify(holdings, null, 2), 'utf-8');
}

function getHoldingDays(buyDate) {
  return Math.floor((new Date() - new Date(buyDate)) / 86400000);
}

function calcETFfee(amount) {
  const { commissionRate, minCommission } = FEE_CONFIG.etf;
  const fee = Math.max(amount * commissionRate, minCommission);
  return { fee: Math.round(fee * 100) / 100, isHigh: fee / amount > 0.005 };
}

function calcFundRedemptionFee(amount, holdingDays) {
  const { redemptionRate } = FEE_CONFIG.fund;
  let rate;
  if (holdingDays < 7) rate = redemptionRate.under7;
  else if (holdingDays < 30) rate = redemptionRate.under30;
  else rate = redemptionRate.over30;
  return { fee: Math.round(amount * rate * 100) / 100, rate };
}

function calcBuyFee(amount, type) {
  if (type === 'etf') return calcETFfee(amount).fee;
  return 0; // C类0申购费
}

// ============================================================
//  仓位管理
// ============================================================

function getMarketMultiplier(marketRegime, newsSentiment) {
  const { regime } = marketRegime;
  const multipliers = {
    'TRENDING_UP': 1.0, 'MELTUP': 0.85, 'SIDEWAYS': 0.75,
    'VOLATILE': 0.65, 'TRENDING_DOWN': 0.45, 'CRASH': 0.35, 'UNKNOWN': 0.55,
  };
  let base = multipliers[regime] || 0.55;

  // 新闻情绪微调 ±10%
  if (newsSentiment?.available) {
    const adj = newsSentiment.adjustmentFactor;
    base = Math.max(0.25, Math.min(1.0, base * adj));
  }
  return base;
}

// ============================================================
//  买入候选筛选
// ============================================================

function screenBuyCandidates(rankedFunds, holdingCodes, marketRegime, navPredictions, usImpact) {
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
    if (candidates.length >= 10) break;
    if (holdingCodes.has(f.code)) continue;
    if (!['STRONG_BUY', 'BUY', 'HOLD'].includes(f.signal)) continue;
    if (regime === 'CRASH' && f.signal === 'HOLD') continue;

    // 净值预测调整
    const pred = preds[f.code];
    let effectiveMaxPct = maxChangePct;
    if (pred && pred.confidence === 'high') {
      if (pred.changePct < -1) effectiveMaxPct += 2;
      else if (pred.changePct > 3) effectiveMaxPct -= 1;
    }

    // 美股影响: 如果该基金被美股拖累严重, 暂不买入等企稳
    if (usImpact?.fundAdjustments) {
      const usAdj = usImpact.fundAdjustments[f.code];
      if (usAdj && usAdj < -5) {
        // 美股利空传导>5%: 跳过
        continue;
      }
      // 美股暴跌后A股跟跌, 如果已跌超2%且美股利空, 继续等
      if (usAdj && usAdj < -3 && (f.changePct || 0) < -1) {
        continue;
      }
    }

    if (Math.abs(f.changePct || 0) > effectiveMaxPct) continue;
    if ((f.changePct || 0) < -5) continue;

    // 支付宝规则: ETF自动换成场外C类替代
    if (f.fundType === 'etf') {
      if (f.noFeeAlt) {
        const alt = rankedFunds.find(r => r.code === f.noFeeAlt && r.signal !== 'SELL');
        if (alt && !holdingCodes.has(alt.code) && !candidates.find(c => c.code === alt.code)) {
          candidates.push(alt);
        }
      }
      // ETF没有替代品就不推荐, 因为支付宝买不了ETF
      continue;
    }

    candidates.push(f);
  }

  return candidates;
}

// ============================================================
//  主决策函数
// ============================================================

function generateAdviceV2(analysisResult) {
  const { marketRegime, marketTemp, rankedFunds, fetchTime, indexes, newsSentiment, rotationSignals, hmmResult, ensembleResult, anomalyAlerts, factorResult, bayesianResult, navPredictions, settlementInfo, usImpact } = analysisResult;
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
    budget: BUDGET,
    holdings,
    sellOrders: [],
    buyOrders: [],
    swapPlans: [],
    summary: '',
    riskWarnings: [],
    _rankedFunds: rankedFunds,
  };

  // Step 1: 卖出检查
  const holdingCodes = new Set(holdings.map(h => h.code));
  const sellAmount = processSells(decisions, holdings, rankedFunds, marketRegime);

  // Step 2: 仓位计算 (含新闻情绪调整)
  const marketMultiplier = getMarketMultiplier(marketRegime, decisions.newsSentiment);
  const invested = holdings.reduce((s, h) => s + h.costBasis, 0);
  const availableCash = BUDGET - invested + sellAmount;
  const investableCash = Math.min(availableCash, BUDGET * marketMultiplier);
  const cashToInvest = investableCash * (1 - RISK_CONFIG.cashReserve);

  // Step 3: 买入
  const buyCandidates = screenBuyCandidates(rankedFunds, holdingCodes, marketRegime, decisions.navPredictions, decisions.usImpact);
  if (cashToInvest > 50 && buyCandidates.length > 0) {
    allocateBuyOrdersV2(decisions, buyCandidates, cashToInvest, holdings.length, rankedFunds, marketRegime);
  }

  // Step 4: 调仓换仓
  const isFull = invested >= BUDGET * 0.85 && availableCash < 300;
  if (isFull && sellAmount < 100) {
    generateSwapPlansV2(decisions, holdings, rankedFunds, marketRegime);
  }

  // Step 5: 持有基金加仓信号 (大跌具有投资价值时)
  checkAddPosition(decisions, holdings, rankedFunds, cashToInvest);

  // Step 6: 科技集中度检查
  checkTechConcentration(decisions, holdings, rankedFunds);

  // Step 7: 风险提示
  generateWarnings(decisions);

  return decisions;
}

// ============================================================
//  卖出逻辑 (带动态止损)
// ============================================================

function processSells(decisions, holdings, rankedFunds, marketRegime) {
  let totalSell = 0;

  for (const holding of holdings) {
    const analysis = rankedFunds.find(f => f.code === holding.code);
    if (!analysis) continue;

    const price = analysis.price || holding.buyPrice;
    const currentProfit = (price - holding.buyPrice) / holding.buyPrice;
    const holdingDays = getHoldingDays(holding.buyDate);

    let shouldSell = false, reason = '';

    // 动态止损: 根据ATR调整
    const atrPct = analysis.indicators?.atr?.atrPct || 2;
    const dynamicStop = Math.max(RISK_CONFIG.stopLossRatio, -atrPct * 3 / 100);
    if (currentProfit <= dynamicStop) {
      shouldSell = true;
      reason = `触发动态止损(ATR${atrPct.toFixed(1)}% → 止损线${(dynamicStop*100).toFixed(1)}%)`;
    }

    // 移动止盈: 涨超15%激活, 从最高点回撤5%卖出
    if (currentProfit >= 0.15) {
      // 用近期最高价作为跟踪基准
      const history = analysis.history || [];
      let peakPrice = price;
      if (history.length > 0) {
        const recentCloses = history.slice(-10).map(h => h.close || h.nav || 0).filter(v => v > 0);
        if (recentCloses.length > 0) peakPrice = Math.max(...recentCloses);
      }
      const drawdownFromPeak = (price - peakPrice) / peakPrice;
      if (drawdownFromPeak <= -0.05) {
        shouldSell = true;
        reason = `移动止盈: 从高点¥${peakPrice.toFixed(3)}回撤${(drawdownFromPeak*100).toFixed(1)}%`;
      }
    }
    // 固定止盈(更远, 作为兜底)
    if (currentProfit >= RISK_CONFIG.takeProfitRatio) {
      shouldSell = true;
      reason = `触发固定止盈线(+${(currentProfit*100).toFixed(1)}%)`;
    }

    // 信号卖出 + 趋势恶化
    if (analysis.signal === 'SELL') {
      shouldSell = true;
      reason = '技术信号全面转空';
    }
    if (analysis.signal === 'WEAK' && marketRegime.regime === 'TRENDING_DOWN') {
      shouldSell = true;
      reason = '弱势基金+市场下行';
    }

    // 赎回费保护
    if (holdingDays < RISK_CONFIG.minHoldingDays && shouldSell && currentProfit > RISK_CONFIG.stopLossRatio) {
      continue;
    }

    if (shouldSell) {
      const sellValue = holding.shares * price;
      const { fee: sellFee } = holding.type === 'etf'
        ? calcETFfee(sellValue)
        : calcFundRedemptionFee(sellValue, holdingDays);
      const netValue = sellValue - sellFee;

      decisions.sellOrders.push({
        code: holding.code, name: holding.name, type: holding.type,
        shares: holding.shares, price, value: Math.round(sellValue * 100) / 100,
        fee: Math.round(sellFee * 100) / 100,
        netValue: Math.round(netValue * 100) / 100,
        costBasis: holding.costBasis,
        profit: Math.round((netValue - holding.costBasis) * 100) / 100,
        profitPct: (currentProfit * 100).toFixed(1) + '%',
        holdingDays, reason,
      });
      totalSell += netValue;
    }
  }
  return totalSell;
}

// ============================================================
//  资金分配 (Kelly启发式)
// ============================================================

function allocateBuyOrdersV2(decisions, candidates, totalCash, currentPositions, rankedFunds, marketRegime) {
  const maxNew = RISK_CONFIG.maxTotalPositions - currentPositions - decisions.sellOrders.length;
  if (maxNew <= 0) return;

  // Kelly启发: 高分基金分配更多, 低波动基金分配更多
  const scored = candidates.slice(0, Math.min(candidates.length, maxNew + 2))
    .map(c => {
      const kellyFraction = Math.max(0.05, (c.score - 40) / 100); // 分数越高分配越多
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
    // 支付宝: 全部场外基金, 最低10元起买
    let amount = Math.round(Math.max(rawAlloc, 10));

    if (amount < 10) continue;
    if (amount > remaining) amount = Math.round(remaining);
    if (amount < 10) continue;

    remaining -= amount;

    decisions.buyOrders.push({
      code: candidate.code, name: candidate.name,
      type: 'fund', // 支付宝全是场外基金
      price: candidate.price, changePct: candidate.changePct,
      score: candidate.score, signal: candidate.signal,
      amount, fee: 0, // 支付宝C类0申购费
      reason: generateBuyReasonV2(candidate),
    });
  }

  if (remaining > 100) {
    decisions._remainingCash = Math.round(remaining);
  }
}

// ============================================================
//  调仓换仓 (考虑赎回费阶梯)
// ============================================================

function generateSwapPlansV2(decisions, holdings, rankedFunds, marketRegime) {
  const holdingCodes = new Set(holdings.map(h => h.code));
  const techKeywords = ['电池', '芯片', '半导体', '信息', '科创', '科技', 'AI', '互联网', '创业板', '电子'];

  for (const holding of holdings) {
    const analysis = rankedFunds.find(f => f.code === holding.code);
    if (!analysis) continue;

    const holdingDays = getHoldingDays(holding.buyDate);
    const holdingScore = analysis.score || 0;
    const isTech = techKeywords.some(kw => (holding.name || '').includes(kw));

    // 持有<7天基本不换
    if (holdingDays < 7) continue;
    // 科技赛道: 更积极地换仓 (分数差距≥10就考虑)
    const scoreGapNeeded = isTech ? 10 : 15;
    if (holdingScore >= 58 && analysis.signal !== 'WEAK') continue;

    // 找替代品 (科技赛道优先找同赛道更强的)
    const minTargetScore = holdingScore + scoreGapNeeded;
    const alternatives = rankedFunds
      .filter(f => {
        if (holdingCodes.has(f.code)) return false;
        if (f.signal === 'SELL' || f.signal === 'WEAK') return false;
        return f.score >= minTargetScore;
      })
      .sort((a, b) => {
        // 优先同属科技赛道的替代品
        const aTech = techKeywords.some(kw => (a.name || '').includes(kw));
        const bTech = techKeywords.some(kw => (b.name || '').includes(kw));
        if (isTech) {
          if (aTech && !bTech) return -1;
          if (!aTech && bTech) return 1;
        }
        return b.score - a.score;
      })
      .slice(0, 2);

    if (alternatives.length === 0) continue;

    const price = analysis.price || holding.buyPrice;
    const sellValue = holding.shares * price;
    const { fee: redemptionFee } = calcFundRedemptionFee(sellValue, holdingDays);

    for (const alt of alternatives) {
      const netCash = sellValue - redemptionFee;
      if (netCash < 200) continue;

      decisions.swapPlans.push({
        sellCode: holding.code, sellName: holding.name,
        sellShares: holding.shares, sellValue: Math.round(sellValue * 100) / 100,
        sellFee: Math.round(redemptionFee * 100) / 100,
        sellScore: holdingScore, sellDays: holdingDays,
        sellReason: holdingScore < 45 ? '评分偏低' : '存在更优替代',

        buyCode: alt.code, buyName: alt.name,
        buyScore: alt.score, buyAmount: Math.round(netCash),
        buyPrice: alt.price || 0,
        netCash: Math.round(netCash * 100) / 100,
      });
      break;
    }
  }
}

// ============================================================
//  辅助函数
// ============================================================

function generateBuyReasonV2(candidate) {
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

  if (reasons.length === 0) reasons.push('综合评分领先');
  return reasons.slice(0, 3).join('; ');
}

/**
 * 科技赛道集中度检查
 * 电池+芯片+AI+互联网+科创50 都属于"科技大板块", 合计不超过70%
 */
/**
 * 持有基金加仓检测: 持仓大跌但仍有投资价值时建议加仓摊平
 * 条件: 持有基金今日预估跌幅>3%, 评分仍≥60且BUY以上, 有可用现金
 * 使用指数跌幅作为场外基金的替代估计
 */
function checkAddPosition(decisions, holdings, rankedFunds, availableCash) {
  if (availableCash < 100) return;
  const navPreds = decisions.navPredictions || {};
  const indexes = decisions.indexes || [];
  const existingCodes = new Set(decisions.buyOrders.map(o => o.code));
  if (existingCodes.size >= 2) return;

  // 创业板和科创50作为科技基金的地板参考
  const cyb = indexes.find(i => i.name.includes('创业板'));
  const kcb = indexes.find(i => i.name.includes('科创'));
  const maxTechIndexDrop = Math.min(
    cyb?.changePct || 0,
    kcb?.changePct || 0
  );

  for (const h of holdings) {
    if (existingCodes.has(h.code)) continue;
    const analysis = rankedFunds.find(f => f.code === h.code);
    if (!analysis) continue;
    if (!['STRONG_BUY', 'BUY'].includes(analysis.signal)) continue;
    if (analysis.score < 58) continue;

    // 估算今日跌幅: 有预测用预测, 无预测用指数跌幅
    const actualChg = analysis.changePct || 0;
    const predChg = navPreds[h.code]?.changePct || 0;
    const effectiveChg = predChg !== 0 ? predChg :
      actualChg !== 0 ? actualChg :
      maxTechIndexDrop;

    if (effectiveChg <= -3) {
      const addPct = Math.min(0.3, Math.abs(effectiveChg) / 15);
      const addAmount = Math.round(Math.max(availableCash * addPct, 100));
      if (addAmount >= 100) {
        decisions.buyOrders.push({
          code: h.code, name: h.name || analysis.name,
          type: 'fund', price: analysis.price || h.buyPrice,
          changePct: effectiveChg, score: analysis.score,
          signal: 'BUY', amount: addAmount, fee: 0,
          reason: `加仓摊平 当日跌${effectiveChg.toFixed(1)}%`,
        });
        existingCodes.add(h.code);
        break;
      }
    }
  }
}

function checkTechConcentration(decisions, holdings, rankedFunds) {
  const techKeywords = ['电池', '芯片', '半导体', '信息', '科创', '科技', 'AI', '互联网', '创业板', '电子'];
  const nonTechKeywords = ['全球', 'QDII', '海外', '纳斯达克', '港股'];
  let techTotal = 0;
  const techHoldings = [];

  for (const h of holdings) {
    const fund = rankedFunds.find(f => f.code === h.code);
    const price = fund?.price || h.buyPrice;
    const value = h.shares * price;
    const name = h.name || '';

    const isNonTech = nonTechKeywords.some(kw => name.includes(kw));
    if (!isNonTech && techKeywords.some(kw => name.includes(kw))) {
      techTotal += value;
      techHoldings.push({ name, value });
    }
  }

  // 也检查待买入的
  for (const o of decisions.buyOrders) {
    if (techKeywords.some(kw => (o.name || '').includes(kw))) {
      techTotal += o.amount;
    }
  }

  const techPct = techTotal / BUDGET;
  if (techPct > RISK_CONFIG.maxTechConcentration) {
    decisions._techWarning = `科技赛道集中度${(techPct*100).toFixed(0)}% > 上限${(RISK_CONFIG.maxTechConcentration*100).toFixed(0)}%, 建议增加QDII或宽基`;
  }
}

function generateWarnings(decisions) {
  const w = [];
  const regime = decisions.marketRegime?.regime;
  if (regime === 'CRASH' || regime === 'TRENDING_DOWN') {
    w.push('市场偏弱, 控制仓位, 保留子弹');
  }
  if (regime === 'MELTUP') {
    w.push('市场快速拉升, 注意追高风险, 设置移动止盈');
  }
  if (decisions.buyOrders.length >= RISK_CONFIG.maxTotalPositions - 2) {
    w.push('持仓数量接近上限, 优先调仓而非加仓');
  }
  if (decisions._techWarning) w.push(decisions._techWarning);
  w.push('支付宝C类基金0申购费, 15:00前下单按今日净值');
  w.push('技术分析仅供参考, 投资需谨慎');
  decisions.riskWarnings = w;
}

module.exports = { generateAdvice: generateAdviceV2, applyDecisions, loadHoldings, saveHoldings };

// 从旧版保留
function applyDecisions(decisions) {
  const holdings = loadHoldings();
  const sellCodes = new Set(decisions.sellOrders.map(o => o.code));
  const newHoldings = holdings.filter(h => !sellCodes.has(h.code));
  for (const order of decisions.buyOrders) {
    newHoldings.push({
      code: order.code, name: order.name, type: order.type,
      buyPrice: order.price,
      shares: order.shares || (order.amount / order.price),
      costBasis: order.amount,
      buyDate: new Date().toISOString().split('T')[0],
    });
  }
  saveHoldings(newHoldings);
  return newHoldings;
}
