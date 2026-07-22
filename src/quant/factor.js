/**
 * 多因子收益归因
 * 拆解收益来源: 市场β + 行业因子 + 选基α + 风格因子
 *
 * 归因模型:
 *   R_portfolio = α + β_market * R_market + β_sector * R_sector + ε
 *
 * 解释:
 *   α (选基超额): 同赛道里你挑的基金比别人好多少
 *   β_market: 大盘涨1%你涨多少
 *   β_sector: 你的赛道相对大盘的超额
 *   风格暴露: 动量/成长/波动 各自贡献
 */

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr) { const m = mean(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); }
function cov(x, y) {
  const mx = mean(x), my = mean(y);
  return x.reduce((s, xi, i) => s + (xi - mx) * (y[i] - my), 0) / x.length;
}

/**
 * 计算日收益率序列
 */
function calcReturns(history) {
  if (!history || history.length < 2) return [];
  const returns = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].close || history[i - 1].nav || 0;
    const curr = history[i].close || history[i].nav || 0;
    if (prev > 0) returns.push((curr - prev) / prev);
  }
  return returns;
}

/**
 * 线性回归: y = α + β * x
 * 返回 { alpha, beta, r2 }
 */
function linearRegression(y, x) {
  if (y.length !== x.length || y.length < 10) return { alpha: 0, beta: 1, r2: 0 };
  const n = y.length;
  const mx = mean(x), my = mean(y);
  const covXY = cov(x, y);
  const varX = cov(x, x);
  const beta = varX !== 0 ? covXY / varX : 1;
  const alpha = my - beta * mx;
  // R²
  const ssRes = y.reduce((s, yi, i) => s + (yi - (alpha + beta * x[i])) ** 2, 0);
  const ssTot = y.reduce((s, yi) => s + (yi - my) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { alpha, beta, r2 };
}

/**
 * 核心: 多因子归因
 * @param {Array} holdings - 当前持仓 [{code, name, shares, buyPrice, costBasis}]
 * @param {Object} fundHistories - { code: history[] }
 * @param {Object} benchmarks - { market: history[], sector: history[] }
 */
function runFactorAttribution(holdings, fundHistories, benchmarks) {
  if (!holdings.length || !benchmarks.market || benchmarks.market.length < 20) {
    return { available: false, message: '数据不足' };
  }

  const marketReturns = calcReturns(benchmarks.market);
  if (marketReturns.length < 20) return { available: false, message: '基准数据不足' };

  const results = [];
  let totalAlpha = 0, totalBeta = 0, totalWeight = 0;

  for (const holding of holdings) {
    const hist = fundHistories[holding.code];
    if (!hist || hist.length < 20) continue;

    const fundReturns = calcReturns(hist);
    if (fundReturns.length < 20) continue;

    // 对齐长度
    const minLen = Math.min(fundReturns.length, marketReturns.length);
    const fRet = fundReturns.slice(-minLen);
    const mRet = marketReturns.slice(-minLen);

    // 1. 市场β归因
    const marketReg = linearRegression(fRet, mRet);

    // 2. 行业归因 (如果有行业基准)
    let sectorBeta = 0, sectorR2 = 0;
    if (benchmarks.sector && benchmarks.sector.length >= minLen) {
      const sHist = benchmarks.sector.slice(-minLen);
      const sRet = [];
      for (let i = 1; i < sHist.length; i++) {
        const p = sHist[i-1].close || sHist[i-1].nav || 0;
        const c = sHist[i].close || sHist[i].nav || 0;
        if (p > 0) sRet.push((c - p) / p);
      }
      if (sRet.length >= minLen - 1) {
        const sAligned = sRet.slice(-(minLen - 1));
        const fAligned = fRet.slice(-sAligned.length);
        const secReg = linearRegression(fAligned, sAligned);
        sectorBeta = secReg.beta;
        sectorR2 = secReg.r2;
      }
    }

    // 3. 选基α (超额收益)
    const fundTotalReturn = fRet.reduce((s, r) => s + r, 0);
    const marketTotalReturn = mRet.reduce((s, r) => s + r, 0);
    const marketExplained = marketReg.beta * marketTotalReturn;
    const alpha = fundTotalReturn - marketExplained;
    const annualAlpha = alpha / fRet.length * 252;

    // 4. 风格暴露: 动量因子
    const momentumScore = fRet.slice(-20).filter(r => r > 0).length / 20; // 上涨天数占比
    const volatility = std(fRet) * Math.sqrt(252); // 年化波动
    const upsideCapture = fRet.filter(r => r > 0).reduce((s, r) => s + r, 0) /
      Math.max(0.001, mRet.filter(r => r > 0).reduce((s, r) => s + r, 0)); // 上行捕获率
    const downsideCapture = fRet.filter(r => r < 0).reduce((s, r) => s + r, 0) /
      Math.min(-0.001, mRet.filter(r => r < 0).reduce((s, r) => s + r, 0)); // 下行捕获率

    const weight = holding.costBasis;
    totalWeight += weight;
    totalAlpha += annualAlpha * weight;
    totalBeta += marketReg.beta * weight;

    results.push({
      code: holding.code,
      name: holding.name,
      weight,
      marketBeta: Math.round(marketReg.beta * 100) / 100,
      marketR2: Math.round(marketReg.r2 * 100) / 100,
      sectorBeta: Math.round(sectorBeta * 100) / 100,
      annualAlpha: Math.round(annualAlpha * 10000) / 100,
      volatility: Math.round(volatility * 10000) / 100,
      upsideCapture: Math.round(upsideCapture * 100) / 100,
      downsideCapture: Math.round(downsideCapture * 100) / 100,
      momentumScore: Math.round(momentumScore * 100) / 100,
    });
  }

  // 组合级别归因
  const portfolioAlpha = totalWeight > 0 ? totalAlpha / totalWeight : 0;
  const portfolioBeta = totalWeight > 0 ? totalBeta / totalWeight : 0;

  // 判断赚钱来源
  let attribution;
  if (portfolioAlpha > 0.1) attribution = '选基能力强, 持续跑赢市场';
  else if (portfolioAlpha > 0.03) attribution = '有一定选基能力';
  else if (portfolioBeta > 1.1) attribution = '收益主要来自高β(杠杆性涨跌)';
  else if (portfolioBeta > 0.9) attribution = '收益与市场同步, 靠大盘上涨';
  else attribution = '防御型, 波动低于市场';

  return {
    available: true,
    portfolioAlpha: Math.round(portfolioAlpha * 10000) / 100,
    portfolioBeta: Math.round(portfolioBeta * 100) / 100,
    attribution,
    holdings: results,
    // 风格归因摘要
    styleSummary: {
      avgMomentum: Math.round(mean(results.map(r => r.momentumScore)) * 100) / 100,
      avgVolatility: Math.round(mean(results.map(r => r.volatility)) * 100) / 100,
      avgUpside: Math.round(mean(results.map(r => r.upsideCapture)) * 100) / 100,
      avgDownside: Math.round(mean(results.map(r => r.downsideCapture)) * 100) / 100,
    },
  };
}

module.exports = { runFactorAttribution, calcReturns, linearRegression };
