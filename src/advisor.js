/**
 * 投资决策引擎
 * 根据技术分析结果, 结合仓位管理和风险控制, 生成具体买卖建议
 */

const { BUDGET, RISK_CONFIG, FEE_CONFIG, DEFAULT_HOLDINGS } = require('./config');

/**
 * 计算ETF交易费用
 * @returns {{ fee: number, rate: number, isHigh: boolean, warning: string|null }}
 */
function calcETFfee(amount) {
  const { commissionRate, minCommission } = FEE_CONFIG.etf;
  const fee = Math.max(amount * commissionRate, minCommission);
  const rate = amount > 0 ? fee / amount : 0;
  const isHigh = rate > 0.005; // 费率超过0.5%算高
  const warning = isHigh
    ? `⚠️ ETF佣金¥${fee.toFixed(0)}占交易额${(rate*100).toFixed(1)}% — 建议买场外C类(0申购费)替代`
    : null;
  return { fee: Math.round(fee * 100) / 100, rate, isHigh, warning };
}

/**
 * 计算场外基金赎回费 (买入时申购费已在FEE_CONFIG中)
 */
function calcFundRedemptionFee(amount, holdingDays) {
  const { redemptionRate } = FEE_CONFIG.fund;
  let rate;
  if (holdingDays < 7) rate = redemptionRate.under7;
  else if (holdingDays < 30) rate = redemptionRate.under30;
  else rate = redemptionRate.over30;
  return { fee: Math.round(amount * rate * 100) / 100, rate };
}

/**
 * 计算场外基金申购费 (A类)
 */
function calcFundSubscriptionFee(amount, fundType) {
  if (fundType === 'fund') {
    // C类: 0申购费
    return 0;
  }
  const rate = FEE_CONFIG.fundA.subscriptionRate;
  return Math.round(amount * rate * 100) / 100;
}

/**
 * 计算买入费用 (统一入口)
 */
function calcBuyFee(amount, type) {
  if (type === 'etf') {
    return calcETFfee(amount).fee;
  }
  // 场外C类: 0申购费; A类才有
  if (type === 'fundA') {
    return calcFundSubscriptionFee(amount, 'fundA');
  }
  return 0; // fund (C类) = 0申购费
}

/**
 * 检查ETF交易是否需要建议场外替代
 */
function checkETFfeeWarning(amount) {
  const { fee, isHigh, warning } = calcETFfee(amount);
  return { fee, isHigh, warning };
}

/**
 * 加载持仓数据
 */
function loadHoldings() {
  const fs = require('fs');
  const path = require('path');
  const filePath = path.join(__dirname, '..', 'holdings.json');

  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.log('⚠️  持仓文件读取失败, 使用空持仓');
  }
  return DEFAULT_HOLDINGS;
}

/**
 * 保存持仓数据
 */
function saveHoldings(holdings) {
  const fs = require('fs');
  const path = require('path');
  const filePath = path.join(__dirname, '..', 'holdings.json');
  fs.writeFileSync(filePath, JSON.stringify(holdings, null, 2), 'utf-8');
}

/**
 * 生成投资建议
 *
 * @param {Object} analysisResult - 来自 rankFunds() 的分析结果
 * @returns {Object} 包含具体买卖操作的建议
 */
function generateAdvice(analysisResult) {
  const { marketEnv, rankedFunds, fetchTime, northFlow } = analysisResult;
  const holdings = loadHoldings();

  const decisions = {
    date: fetchTime,
    marketEnv,
    northFlow,
    budget: BUDGET,
    holdings: holdings,
    sellOrders: [],
    buyOrders: [],
    summary: '',
    riskWarnings: [],
    _rankedFunds: rankedFunds,  // 供支付宝替代查找用
  };

  // === 第一步: 检查持仓, 确定卖出 ===
  const holdingCodes = new Set(holdings.map(h => h.code));
  const sellAmount = processSells(decisions, holdings, rankedFunds, marketEnv);

  // === 第二步: 根据市场环境调整仓位 ===
  const marketMultiplier = getMarketMultiplier(marketEnv);
  const availableCash = BUDGET - holdings.reduce((sum, h) => sum + h.costBasis, 0) + sellAmount;
  // 可用资金 = 总投资 - 已持仓成本 + 卖出回笼资金
  const investableCash = Math.min(availableCash, BUDGET * marketMultiplier);
  const cashToInvest = investableCash * (1 - RISK_CONFIG.cashReserve);

  // === 第三步: 筛选买入候选 ===
  const buyCandidates = screenBuyCandidates(rankedFunds, holdingCodes, marketEnv);

  // === 第四步: 资金分配 ===
  if (cashToInvest > 100 && buyCandidates.length > 0) {
    allocateBuyOrders(decisions, buyCandidates, cashToInvest, holdings.length, marketEnv);
  } else if (cashToInvest <= 100 && buyCandidates.length > 0) {
    decisions.summary += '可用资金不足100元, 暂不买入。';
  }

  // === 第五步: 调仓换仓方案 (满仓时用强换弱) ===
  const invested = holdings.reduce((sum, h) => sum + h.costBasis, 0);
  const isFullPosition = invested >= BUDGET * 0.9 && availableCash < 200;
  if (isFullPosition && sellAmount < 100) {
    generateSwapPlans(decisions, holdings, rankedFunds, marketEnv);
  }

  // === 第六步: 生成总结 ===
  generateSummary(decisions, sellAmount);

  return decisions;
}

/**
 * 调仓方案: 满仓时, 如果热门基金评分远超持仓中的弱势基金, 建议换仓
 */
function generateSwapPlans(decisions, holdings, rankedFunds, marketEnv) {
  const holdingCodes = new Set(holdings.map(h => h.code));

  for (const holding of holdings) {
    const holdingAnalysis = rankedFunds.find(f => f.code === holding.code);
    if (!holdingAnalysis) continue;

    const holdingDays = getHoldingDays(holding.buyDate);
    // 持有<7天不换(赎回费1.5%太高)
    if (holdingDays < 7) continue;

    const holdingScore = holdingAnalysis.score || 0;
    // 只在持仓评分<60时考虑换仓
    if (holdingScore >= 60) continue;

    // 找评分高15分以上的替代品(场外C类优先)
    const alternatives = rankedFunds
      .filter(f => {
        if (holdingCodes.has(f.code)) return false;
        if (f.fundType === 'etf' && f.noFeeAlt) return false; // ETF不考虑,用场外替代
        if (f.signal === 'SELL' || f.signal === 'WEAK') return false;
        return f.score >= holdingScore + 12;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    if (alternatives.length === 0) continue;

    const sellValue = holding.shares * (holdingAnalysis.price || holding.buyPrice);
    const redemptionFee = calcFundRedemptionFee(sellValue, holdingDays).fee;

    for (const alt of alternatives) {
      const netCash = sellValue - redemptionFee;
      if (netCash < 100) continue;

      decisions.swapPlans = decisions.swapPlans || [];
      decisions.swapPlans.push({
        sellCode: holding.code,
        sellName: holding.name,
        sellShares: holding.shares,
        sellValue: Math.round(sellValue * 100) / 100,
        sellFee: redemptionFee,
        sellScore: holdingScore,
        sellReason: `评分偏低(${holdingScore}分), 调仓换更强基金`,

        buyCode: alt.code,
        buyName: alt.name,
        buyScore: alt.score,
        buyAmount: Math.round(netCash),
        buyPrice: alt.price || 0,
        netCash: Math.round(netCash * 100) / 100,
      });
      break; // 每只持仓只推荐一个最佳替代
    }
  }
  }  // end for holdings

/**
 * 处理卖出逻辑
 */
function processSells(decisions, holdings, rankedFunds, marketEnv) {
  let totalSellAmount = 0;

  for (const holding of holdings) {
    const analysis = rankedFunds.find(f => f.code === holding.code);
    if (!analysis) continue;

    let shouldSell = false;
    let sellReason = '';

    const currentProfit = analysis.changePct
      ? (analysis.price - holding.buyPrice) / holding.buyPrice
      : 0;

    // 止损: 亏损超过止损线
    if (currentProfit <= RISK_CONFIG.stopLossRatio) {
      shouldSell = true;
      sellReason = `触发止损线 (亏损${(currentProfit * 100).toFixed(1)}%)`;
    }

    // 止盈: 盈利超过止盈线
    if (currentProfit >= RISK_CONFIG.takeProfitRatio) {
      shouldSell = true;
      sellReason = `触发止盈线 (盈利${(currentProfit * 100).toFixed(1)}%)`;
    }

    // 信号卖出
    if (analysis.signal === 'SELL') {
      shouldSell = true;
      sellReason = `技术信号卖出 (得分${analysis.score})`;
    }

    // 市场极度悲观 + 持有弱势基金
    if (marketEnv.sentiment === 'BEARISH' && analysis.signal === 'WEAK') {
      shouldSell = true;
      sellReason = `市场悲观+基金弱势`;
    }

    // 持有天数不足, 不卖
    const holdingDays = getHoldingDays(holding.buyDate);
    if (holdingDays < RISK_CONFIG.minHoldingDays && !shouldSell) {
      continue;
    }
    // 即便是最短持有期内, 止损也必须执行
    if (holdingDays < RISK_CONFIG.minHoldingDays && shouldSell && currentProfit > RISK_CONFIG.stopLossRatio) {
      continue; // 非止损情况, 跳过
    }

    if (shouldSell) {
      const sellValue = holding.shares * analysis.price;
      // 计算卖出费用
      let sellFee = 0;
      const holdingType = holding.type || 'fund';
      if (holdingType === 'etf') {
        sellFee = calcETFfee(sellValue).fee;
      } else {
        sellFee = calcFundRedemptionFee(sellValue, holdingDays).fee;
      }
      const netValue = sellValue - sellFee;

      decisions.sellOrders.push({
        code: holding.code,
        name: holding.name,
        type: holdingType,
        shares: holding.shares,
        price: analysis.price,
        value: Math.round(sellValue * 100) / 100,
        fee: Math.round(sellFee * 100) / 100,
        netValue: Math.round(netValue * 100) / 100,
        costBasis: holding.costBasis,
        profit: Math.round((netValue - holding.costBasis) * 100) / 100,
        profitPct: (currentProfit * 100).toFixed(1) + '%',
        holdingDays,
        reason: sellReason,
      });
      totalSellAmount += netValue;
    }
  }

  return totalSellAmount;
}

/**
 * 市场环境对应的仓位系数
 */
function getMarketMultiplier(marketEnv) {
  // 激进型: 始终保持高仓位, 熊市也敢于抄底
  switch (marketEnv.sentiment) {
    case 'BULLISH': return 1.0;           // 牛市: 100%全仓
    case 'SLIGHTLY_BULLISH': return 0.95; // 偏乐观: 95%
    case 'NEUTRAL': return 0.80;          // 中性: 80%
    case 'SLIGHTLY_BEARISH': return 0.60; // 偏悲观: 60% (别人恐惧我贪婪)
    case 'BEARISH': return 0.40;          // 熊市: 40% (保留抄底仓位)
    default: return 0.70;
  }
}

/**
 * 筛选买入候选基金
 */
function screenBuyCandidates(rankedFunds, holdingCodes, marketEnv) {
  // 激进型: 允许更高追涨, 牛市敢追涨停
  let maxChangePct;
  switch (marketEnv.sentiment) {
    case 'BULLISH': maxChangePct = 8; break;           // 牛市敢追高
    case 'SLIGHTLY_BULLISH': maxChangePct = 6; break;
    case 'NEUTRAL': maxChangePct = 5; break;
    case 'SLIGHTLY_BEARISH': maxChangePct = 3; break;   // 回调抄底
    case 'BEARISH': maxChangePct = 2; break;
    default: maxChangePct = 5;
  }

  return rankedFunds
    .filter(f => {
      if (holdingCodes.has(f.code)) return false;
      // 激进: HOLD及以上都可考虑 (HOLD可能是不错的位置)
      if (!['STRONG_BUY', 'BUY', 'HOLD'].includes(f.signal)) return false;
      // 熊市只买BUY以上
      if ((marketEnv.sentiment === 'BEARISH') && f.signal === 'HOLD') return false;
      // 追高限制
      const pct = Math.abs(f.changePct || 0);
      if (pct > maxChangePct) return false;
      // 跌超5%允许抄底 (激进特征!)
      if (f.changePct < -5) return false;
      return true;
    })
    .slice(0, 8); // 激进: 更多候选
}

/**
 * 分配买入资金
 */
function allocateBuyOrders(decisions, candidates, totalCash, currentPositionCount, marketEnv) {
  // 根据得分分配权重
  const totalScore = candidates.reduce((sum, c) => sum + c.score, 0);
  const maxPositions = RISK_CONFIG.maxTotalPositions - currentPositionCount;

  let remainingCash = totalCash;
  const toAllocate = candidates.slice(0, Math.min(candidates.length, maxPositions));

  for (const candidate of toAllocate) {
    // 权重 = 该基金得分 / 总得分, 但不超过maxWeight
    const weight = Math.min(
      candidate.score / totalScore,
      candidate.maxWeight || RISK_CONFIG.maxSinglePosition
    );

    let allocAmount = Math.round(totalCash * weight);
    let shares = null;

    // 检查最小交易单位
    if (candidate.type === 'etf' || candidate.fundType === 'etf') {
      const price = candidate.price;
      // ETF最少买100股(1手)
      shares = Math.max(Math.round(allocAmount / price / 100) * 100, 100);
      allocAmount = Math.round(shares * price * 100) / 100;
    } else {
      // 场外基金按最小购买额取整
      const minBuy = candidate.minBuy || 100;
      if (allocAmount < minBuy) allocAmount = minBuy;
      allocAmount = Math.round(allocAmount);
    }

    // 跳过金额太小的(场外<50元, ETF<1手)
    const minAmount = (candidate.type === 'etf' || candidate.fundType === 'etf') ? (candidate.price * 100) : 50;
    if (allocAmount < minAmount) continue;

    if (allocAmount <= 0) continue;
    if (allocAmount > remainingCash) {
      // 如果资金不够, 对ETF减少股数, 对场外基金减少金额
      if (shares && candidate.price > 0) {
        shares = Math.floor(remainingCash / candidate.price / 100) * 100;
        if (shares <= 0) continue; // 连1手都买不起, 跳过
        allocAmount = Math.round(shares * candidate.price * 100) / 100;
      } else {
        allocAmount = remainingCash;
      }
    }

    if (allocAmount <= 0) continue;

    remainingCash -= allocAmount;

    decisions.buyOrders.push({
      code: candidate.code,
      name: candidate.name,
      type: candidate.type || candidate.fundType,
      noFeeAlt: candidate.noFeeAlt || null,  // 传递场外替代代码
      price: candidate.price,
      changePct: candidate.changePct,
      score: candidate.score,
      signal: candidate.signal,
      amount: allocAmount,
      shares: shares,
      fee: calcBuyFee(allocAmount, candidate.type || candidate.fundType),
      reason: generateBuyReason(candidate),
    });
  }

  // 支付宝优化: ETF → 场外C类自动替换
  // 从完整排名(非仅候选)中查找替代品
  const allRanked = decisions._rankedFunds || [];
  for (const order of decisions.buyOrders) {
    if (order.type === 'etf' && order.noFeeAlt && order.fee > 0) {
      const altFund = allRanked.find(c => c.code === order.noFeeAlt);
      if (altFund && altFund.score >= order.score - 15) {
        order._altCode = order.noFeeAlt;
        order._altName = altFund.name || order.noFeeAlt;
        order._altType = 'fund';
        order._altFee = 0;
      }
    }
  }

  if (remainingCash > 100) {
    decisions.summary += `剩余 ${Math.round(remainingCash)} 元现金保留备用。`;
  }
}

/**
 * 生成买入理由
 */
function generateBuyReason(candidate) {
  const { details } = candidate;
  const reasons = [];

  if (details.ma && details.ma.arrangement.includes('多头排列')) {
    reasons.push('均线多头排列');
  }
  if (details.macd && details.macd.goldenCross) {
    reasons.push('MACD金叉');
  }
  if (details.rsi && details.rsi.zone.includes('超卖')) {
    reasons.push('RSI超卖反弹');
  }
  if (details.bollinger && details.bollinger.position.includes('下轨')) {
    reasons.push('布林下轨支撑');
  }
  if (details.volume && details.volume.signal === '放量') {
    reasons.push('放量上涨');
  }
  if (candidate.changePct && candidate.changePct < -0.5) {
    reasons.push('今日回调(低吸机会)');
  }

  if (reasons.length === 0) {
    reasons.push('综合技术面偏多');
  }

  return reasons.join('; ');
}

/**
 * 计算持仓天数
 */
function getHoldingDays(buyDate) {
  const buy = new Date(buyDate);
  const now = new Date();
  return Math.floor((now - buy) / (1000 * 60 * 60 * 24));
}

/**
 * 生成最终总结
 */
function generateSummary(decisions, sellAmount) {
  const parts = [];

  // 市场环境
  parts.push(`市场环境: ${decisions.marketEnv.description}`);

  // 卖出总结
  if (decisions.sellOrders.length > 0) {
    const totalSell = decisions.sellOrders.reduce((s, o) => s + o.value, 0);
    parts.push(`建议卖出 ${decisions.sellOrders.length} 只, 回笼资金 ¥${Math.round(totalSell)}`);
  } else {
    parts.push('当前持仓无需卖出');
  }

  // 买入总结
  if (decisions.buyOrders.length > 0) {
    const totalBuy = decisions.buyOrders.reduce((s, o) => s + o.amount, 0);
    const totalFee = decisions.buyOrders.reduce((s, o) => s + (o.fee || 0), 0);
    const feeStr = totalFee > 0 ? ` (预估费用¥${totalFee.toFixed(1)})` : ' (场外C类0申购费✅)';
    parts.push(`建议买入 ${decisions.buyOrders.length} 只, 投入 ¥${Math.round(totalBuy)}${feeStr}`);
  } else {
    parts.push('暂无合适买入机会');
  }

  // 费用提示
  const etfOrders = decisions.buyOrders.filter(o => o.type === 'etf');
  const totalEtfFee = etfOrders.reduce((s, o) => s + (o.fee || 0), 0);
  if (totalEtfFee > 0) {
    decisions.riskWarnings.push(`💡 ETF佣金合计¥${totalEtfFee.toFixed(0)}, 若换为场外C类联接基金可节省此费用 — 在支付宝/天天基金申购C类费率为0`);
    decisions.riskWarnings.push('💡 在上述平台搜索对应ETF的"C类联接"即可, 例如 "沪深300ETF联接C"');
  }

  // 风险提示
  if (decisions.marketEnv.sentiment === 'BEARISH' || decisions.marketEnv.sentiment === 'SLIGHTLY_BEARISH') {
    decisions.riskWarnings.push('⚠️ 市场偏弱, 建议控制仓位, 保留更多现金');
  }
  if (decisions.buyOrders.length >= RISK_CONFIG.maxTotalPositions - 1) {
    decisions.riskWarnings.push('⚠️ 持仓数量接近上限, 注意分散风险');
  }
  decisions.riskWarnings.push('📌 以上为技术分析建议, 仅供参考, 投资有风险, 交易需谨慎');
  decisions.riskWarnings.push('📌 建议交易时间: 交易日 9:30-15:00 (ETF) 或 15:00前 (场外基金按当日净值)');

  decisions.summary = parts.join('。\n') + '。\n\n' + decisions.riskWarnings.join('\n');
}

/**
 * 应用决策 (更新持仓文件)
 * 这是一个可选操作, 默认只显示建议不执行
 */
function applyDecisions(decisions) {
  const holdings = loadHoldings();

  // 移除卖出的
  const sellCodes = new Set(decisions.sellOrders.map(o => o.code));
  const newHoldings = holdings.filter(h => !sellCodes.has(h.code));

  // 添加买入的
  for (const order of decisions.buyOrders) {
    newHoldings.push({
      code: order.code,
      name: order.name,
      type: order.type,
      buyPrice: order.price,
      shares: order.shares || (order.amount / order.price),
      costBasis: order.amount,
      buyDate: new Date().toISOString().split('T')[0],
    });
  }

  saveHoldings(newHoldings);
  console.log('✅ 持仓已更新, 当前持有', newHoldings.length, '只基金');
  return newHoldings;
}

module.exports = {
  generateAdvice,
  applyDecisions,
  loadHoldings,
  saveHoldings,
};
