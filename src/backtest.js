/**
 * 回测引擎
 * 用历史数据模拟策略收益
 */

const { fetchFundHistory } = require('./fetcher');
const { scoreFund } = require('./analyzer_v2');
const { BUDGET, RISK_CONFIG, FEE_CONFIG, WATCHLIST } = require('./config');

function getRedemptionRate(days) {
  if (days < 7) return 0.015;
  if (days < 30) return 0.005;
  return 0;
}

async function fetchHistoricalData(fundCodes, days = 90) {
  const data = {};
  for (const code of fundCodes) {
    const history = await fetchFundHistory(code, days);
    if (history && history.length >= 40) {
      data[code] = history;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return data;
}

async function runBacktest() {
  const allFunds = [
    ...(WATCHLIST.aiChip || []),
    ...(WATCHLIST.newEnergy || []),
    ...(WATCHLIST.internetTech || []),
    ...(WATCHLIST.techBase || []),
    ...(WATCHLIST.globalTech || []),
    ...(WATCHLIST.satellite || []),
    ...(WATCHLIST.userHolding || []),
  ];

  const uniqueCodes = [...new Set(allFunds.map(f => f.code))];
  console.log(`📡 获取 ${uniqueCodes.length} 只基金历史数据(90天)...`);

  const histData = await fetchHistoricalData(uniqueCodes, 90);
  const availableCodes = Object.keys(histData);
  console.log(`  成功: ${availableCodes.length}/${uniqueCodes.length}\n`);

  if (availableCodes.length < 3) {
    console.log('❌ 数据不足, 无法回测');
    return;
  }

  // 找最大公共日期范围
  let minLen = Infinity;
  for (const code of availableCodes) {
    minLen = Math.min(minLen, histData[code].length);
  }

  const warmupDays = 30; // 指标需要30天预热
  const tradingDays = minLen - warmupDays - 1;
  if (tradingDays < 10) {
    console.log('❌ 有效交易日不足10天');
    return;
  }

  console.log(`📊 回测: ${tradingDays}个交易日 | ${availableCodes.length}只基金 | 起始资金¥${BUDGET}`);

  // 初始状态
  let cash = BUDGET;
  const portfolio = []; // [{code, shares, buyPrice, buyDay}]
  const dailyValues = [];
  let totalTrades = 0;

  // 逐日模拟
  for (let day = warmupDays; day < minLen - 1; day++) {
    // 构建当日"实时数据"
    const dayFunds = [];
    const fundMap = allFunds.filter(f => availableCodes.includes(f.code));

    for (const fund of fundMap) {
      const fullHistory = histData[fund.code].slice(0, day + 1);
      const todayBar = fullHistory[fullHistory.length - 1];
      const prevBar = fullHistory.length >= 2 ? fullHistory[fullHistory.length - 2] : todayBar;
      const price = todayBar.close || todayBar.nav || 0;
      const prevPrice = prevBar.close || prevBar.nav || price;
      const changePct = prevPrice > 0 ? (price - prevPrice) / prevPrice * 100 : 0;

      dayFunds.push({
        ...fund,
        price,
        changePct,
        history: fullHistory,
        fundType: fund.type || 'fund',
      });
    }

    // 评分
    const scored = dayFunds.map(f => scoreFund(f)).filter(f => f.score !== null);
    scored.sort((a, b) => b.score - a.score);

    // === 卖出检查 ===
    for (let i = portfolio.length - 1; i >= 0; i--) {
      const holding = portfolio[i];
      const analysis = scored.find(f => f.code === holding.code);
      if (!analysis) continue;

      const currentPrice = analysis.price || holding.buyPrice;
      const profit = (currentPrice - holding.buyPrice) / holding.buyPrice;
      const holdingDays = day - holding.buyDay;

      let shouldSell = false;

      if (profit <= RISK_CONFIG.stopLossRatio) shouldSell = true;
      if (profit >= RISK_CONFIG.takeProfitRatio) shouldSell = true;
      if (analysis.signal === 'SELL') shouldSell = true;

      if (shouldSell && holdingDays >= RISK_CONFIG.minHoldingDays) {
        const sellValue = holding.shares * currentPrice;
        const fee = sellValue * getRedemptionRate(holdingDays);
        cash += sellValue - fee;
        portfolio.splice(i, 1);
        totalTrades++;
      }
    }

    // === 买入 ===
    if (cash > 100 && portfolio.length < RISK_CONFIG.maxTotalPositions) {
      const holdingCodes = new Set(portfolio.map(h => h.code));
      const candidates = scored.filter(f =>
        !holdingCodes.has(f.code) &&
        ['STRONG_BUY', 'BUY'].includes(f.signal) &&
        f.fundType === 'fund'
      ).slice(0, 2);

      for (const c of candidates) {
        if (cash < 100) break;
        if (portfolio.length >= RISK_CONFIG.maxTotalPositions) break;

        const maxInvest = BUDGET * RISK_CONFIG.maxSinglePosition;
        const alloc = Math.min(cash * 0.5, maxInvest);
        if (alloc < 50) continue;

        cash -= alloc;
        portfolio.push({
          code: c.code,
          name: c.name,
          shares: alloc / c.price,
          buyPrice: c.price,
          buyDay: day,
        });
        totalTrades++;
      }
    }

    // 计算当日总市值
    let holdingsValue = 0;
    for (const h of portfolio) {
      const f = scored.find(s => s.code === h.code);
      const price = f?.price || h.buyPrice;
      holdingsValue += h.shares * price;
    }
    dailyValues.push({
      day,
      date: histData[availableCodes[0]][day]?.date || '',
      cash: Math.round(cash * 100) / 100,
      holdings: Math.round(holdingsValue * 100) / 100,
      total: Math.round((cash + holdingsValue) * 100) / 100,
      positions: portfolio.length,
    });
  }

  // === 结果统计 ===
  const initialValue = dailyValues[0]?.total || BUDGET;
  const finalValue = dailyValues[dailyValues.length - 1]?.total || BUDGET;
  const totalReturn = (finalValue - BUDGET) / BUDGET * 100;
  const annualizedReturn = totalReturn / tradingDays * 252;

  // 最大回撤
  let peak = dailyValues[0]?.total || BUDGET;
  let maxDrawdown = 0;
  for (const dv of dailyValues) {
    if (dv.total > peak) peak = dv.total;
    const dd = (dv.total - peak) / peak * 100;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  // 胜率: 上涨天数占比
  let upDays = 0;
  for (let i = 1; i < dailyValues.length; i++) {
    if (dailyValues[i].total > dailyValues[i - 1].total) upDays++;
  }
  const winRate = dailyValues.length > 1 ? upDays / (dailyValues.length - 1) * 100 : 0;

  // 与买入持有基准对比 (用科创50或第一只基金首日vs末日价格)
  let benchReturn = 0;
  const benchCode = '011609';
  if (histData[benchCode]) {
    const benchData = histData[benchCode];
    const benchStart = benchData[warmupDays]?.close || benchData[warmupDays]?.nav || 0;
    const benchEnd = benchData[benchData.length - 1]?.close || benchData[benchData.length - 1]?.nav || 0;
    if (benchStart > 0) benchReturn = (benchEnd - benchStart) / benchStart * 100;
  }

  // 市场分段分析: 上涨期 vs 下跌期 vs 震荡期
  const segments = [];
  let segStart = 0, segDirection = dailyValues[1]?.total > dailyValues[0]?.total ? 'up' : 'down';
  for (let i = 1; i < dailyValues.length; i++) {
    const currentDir = dailyValues[i].total > dailyValues[i-1].total ? 'up' : 'down';
    if (currentDir !== segDirection && i - segStart > 5) {
      const segReturn = (dailyValues[i-1].total - dailyValues[segStart].total) / dailyValues[segStart].total * 100;
      segments.push({ type: segDirection === 'up' ? '上涨' : '下跌', days: i - segStart, return: Math.round(segReturn * 100) / 100 });
      segStart = i;
      segDirection = currentDir;
    }
  }
  // 最后一段
  if (dailyValues.length - segStart > 3) {
    const lastRet = (dailyValues[dailyValues.length-1].total - dailyValues[segStart].total) / dailyValues[segStart].total * 100;
    segments.push({ type: segDirection === 'up' ? '上涨' : '下跌', days: dailyValues.length - segStart, return: Math.round(lastRet * 100) / 100 });
  }

  const upSegs = segments.filter(s => s.type === '上涨');
  const downSegs = segments.filter(s => s.type === '下跌');
  const upAvgReturn = upSegs.length > 0 ? upSegs.reduce((s, x) => s + x.return, 0) / upSegs.length : 0;
  const downAvgReturn = downSegs.length > 0 ? downSegs.reduce((s, x) => s + x.return, 0) / downSegs.length : 0;

  return {
    budget: BUDGET, tradingDays, totalTrades,
    finalValue: Math.round(finalValue * 100) / 100,
    totalReturn: Math.round(totalReturn * 100) / 100,
    annualizedReturn: Math.round(annualizedReturn * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    winRate: Math.round(winRate * 10) / 10,
    benchReturn: Math.round(benchReturn * 100) / 100,
    segments: { upAvgReturn: Math.round(upAvgReturn * 100) / 100, downAvgReturn: Math.round(downAvgReturn * 100) / 100, count: segments.length },
    dailyValues: dailyValues.slice(-10),
  };
}

module.exports = { runBacktest };
