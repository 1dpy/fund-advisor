/**
 * 交易成本模型 (C类基金)
 * ---------------------------------------------------------------
 * 场外 C 类基金的费用结构与 A 类不同: 免申购费, 但按年收"销售服务费",
 * 赎回费随持有天数阶梯递减。回测若不计成本, 收益会被系统性高估 ——
 * 这是量化金融研究最基本的严谨性要求 (参考 statarb / jaychouchannel)。
 *
 * 费率约定 (行业常见值, 可由 config 覆盖):
 *   - 申购费 (C类): 0
 *   - 销售服务费: 0.40% / 年, 按实际持有天数计提 (amount * 0.004 * days/365)
 *   - 赎回费阶梯:
 *       持有 < 7 天      : 1.50%   (惩罚性, 监管防短线)
 *       7 天 ≤ 持有 < 30 : 0.50%
 *       30 天 ≤ 持有 <180: 0.10%
 *       持有 ≥ 180 天    : 0
 *   - 基金转换 (C→C): 多数免申购, 仅按"转出方赎回费"计, 此处取转出赎回费
 *
 * 用法:
 *   const { tradeCost } = require('./src/cost_model');
 *   const c = tradeCost({ buyAmount: 1000, sellAmount: 1000, holdDays: 12 });
 *   // c.total 即该笔买卖的真实摩擦成本(元)
 */

// 费率表 (可在 main 启动时用 setRate 覆盖, 便于不同基金差异化)
const RATES = {
  purchaseRate: 0,        // C类申购费
  salesServiceRate: 0.004, // 销售服务费(年化)
  redemptionTiers: [
    { maxDays: 7, rate: 0.015 },
    { maxDays: 30, rate: 0.005 },
    { maxDays: 180, rate: 0.001 },
    { maxDays: Infinity, rate: 0 },
  ],
};

function setRates(overrides = {}) {
  if (overrides.salesServiceRate != null) RATES.salesServiceRate = overrides.salesServiceRate;
  if (overrides.redemptionTiers) RATES.redemptionTiers = overrides.redemptionTiers;
  if (overrides.purchaseRate != null) RATES.purchaseRate = overrides.purchaseRate;
}

// 赎回费率 (按持有天数查阶梯)
function redemptionRate(holdDays) {
  const d = Math.max(0, Math.floor(holdDays || 0));
  for (const t of RATES.redemptionTiers) if (d < t.maxDays) return t.rate;
  return 0;
}

// 单笔申购成本
function buyCost(amount) {
  return (amount || 0) * RATES.purchaseRate;
}

// 单笔赎回成本 (含销售服务费, 销售服务费按持有天数计提)
function sellCost(amount, holdDays) {
  const a = amount || 0;
  const redemption = a * redemptionRate(holdDays);
  const service = a * RATES.salesServiceRate * (Math.max(0, holdDays || 0) / 365);
  return { redemption, service, total: redemption + service };
}

// 一次完整买卖(或转换)的摩擦成本
//   buyAmount : 本次建仓金额(申购)
//   sellAmount: 本次平仓金额(赎回, 对应上一次建仓的持有天数 = holdDays)
//   holdDays  : 该仓位实际持有天数
//   isConversion: 是否为基金转换(转换免申购, 只计赎回侧)
function tradeCost({ buyAmount = 0, sellAmount = 0, holdDays = 0, isConversion = false } = {}) {
  const buy = isConversion ? 0 : buyCost(buyAmount);
  const sell = sellCost(sellAmount, holdDays);
  const total = buy + sell.total;
  return {
    buy,
    redemption: sell.redemption,
    service: sell.service,
    total: +total.toFixed(4),
    rate: (buyAmount + sellAmount) > 0 ? +(total / (buyAmount + sellAmount)).toFixed(6) : 0,
  };
}

// 年化成本 (用于展示): 给定年换手次数估算
function annualizedCost(turnoverTimes, avgAmount) {
  let sum = 0;
  for (let i = 0; i < turnoverTimes; i++) {
    // 简化: 每次持有 ~ REBAL/252 年, 但实际用平均持有30天估算赎回+服务费
    sum += sellCost(avgAmount, 30).total;
  }
  return +sum.toFixed(4);
}

module.exports = { RATES, setRates, redemptionRate, buyCost, sellCost, tradeCost, annualizedCost };
