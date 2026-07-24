/**
 * 定投 / 网格 / 再平衡 / 回撤熔断 (Execution Strategies)
 * ---------------------------------------------------------------
 * 覆盖《基金量化模型与公式.md》§8 定投/仓位执行。
 * 纯函数、无网络依赖，被 CI / 单测 / 操作单生成复用。
 *
 * 约定: navs 为净值序列(时间由低到高); 金额单位元; 缺值安全返回。
 */

const { safeDiv } = require('./risk_metrics'); // 复用安全除法, 避免除零污染

// ---------- §8 定投成本摊薄 ----------
/**
 * 定期定额: 每期投入 amountPerPeriod, 在 navs 每个时点点买入
 *   份额_i = A_i / NAV_i; 总份额 = Σ; 平均成本 = ΣA_i / Σ份额_i
 *   盈亏 = (当前净值 - 平均成本) / 平均成本
 * 返回 {periods, totalShares, totalInvested, avgCost(=breakevenNav), currentNav, currentValue, totalReturn}
 */
function dcaCost(navs, amountPerPeriod) {
  const empty = { periods: 0, totalShares: 0, totalInvested: 0, avgCost: 0, currentNav: 0, currentValue: 0, totalReturn: 0, breakevenNav: 0 };
  if (!Array.isArray(navs) || navs.length === 0 || !(amountPerPeriod > 0)) return empty;
  let totalShares = 0, totalInvested = 0;
  for (const nav of navs) {
    if (nav > 0) { totalShares += amountPerPeriod / nav; totalInvested += amountPerPeriod; }
  }
  const avgCost = safeDiv(totalInvested, totalShares);
  const currentNav = navs[navs.length - 1];
  const currentValue = totalShares * currentNav;
  const totalReturn = safeDiv(currentValue - totalInvested, totalInvested);
  return {
    periods: navs.length,
    totalShares: +totalShares.toFixed(4),
    totalInvested: +totalInvested.toFixed(2),
    avgCost: +avgCost.toFixed(4),
    currentNav: +currentNav.toFixed(4),
    currentValue: +currentValue.toFixed(2),
    totalReturn: +totalReturn.toFixed(4),
    breakevenNav: +avgCost.toFixed(4),
  };
}

// ---------- §8 网格交易 ----------
/**
 * 等距网格: 在 [lower, upper] 间划 grids 格, 价格每下行穿过一条网格线买入 sharesPerGrid,
 *   每上行穿过一条网格线卖出 sharesPerGrid(无货可卖则跳过)。适合震荡市。
 * 返回 {levels(网格价), trades, position, realizedPnl(净落袋现金), unrealizedPnl, totalPnl, initialBudgetNeeded}
 */
function gridTrading(navs, { lower, upper, grids = 10, sharesPerGrid = 100 } = {}) {
  const invalid = { levels: [], trades: [], position: 0, realizedPnl: 0, unrealizedPnl: 0, totalPnl: 0, error: '参数无效' };
  if (!Array.isArray(navs) || navs.length < 2 || !(upper > lower) || grids <= 0 || !(sharesPerGrid > 0)) return invalid;
  const stepSize = (upper - lower) / grids;
  const levels = [];
  for (let i = 0; i <= grids; i++) levels.push(+(lower + i * stepSize).toFixed(4));
  const idxOf = (price) => {
    if (price <= levels[0]) return 0;
    if (price >= levels[grids]) return grids;
    for (let i = 0; i < grids; i++) if (price >= levels[i] && price < levels[i + 1]) return i;
    return grids;
  };
  let curIdx = idxOf(navs[0]);
  let position = 0, cash = 0; // cash: 卖出+ / 买入-
  const trades = [];
  for (let t = 0; t < navs.length; t++) {
    const price = navs[t];
    const idx = idxOf(price);
    if (idx < curIdx) {
      const buy = curIdx - idx; // 下行穿过 buy 条线
      for (let k = 0; k < buy; k++) {
        position += sharesPerGrid;
        cash -= sharesPerGrid * price;
        trades.push({ step: t, price: +price.toFixed(4), action: 'BUY', shares: sharesPerGrid, position, cash: +cash.toFixed(2) });
      }
    } else if (idx > curIdx) {
      const sell = idx - curIdx; // 上行穿过 sell 条线
      for (let k = 0; k < sell; k++) {
        if (position < sharesPerGrid) break; // 没货可卖
        position -= sharesPerGrid;
        cash += sharesPerGrid * price;
        trades.push({ step: t, price: +price.toFixed(4), action: 'SELL', shares: sharesPerGrid, position, cash: +cash.toFixed(2) });
      }
    }
    curIdx = idx;
  }
  const lastNav = navs[navs.length - 1];
  const realizedPnl = cash;                 // 已落袋净现金(相对投入本金)
  const unrealizedPnl = position * lastNav; // 持仓市值
  const totalPnl = realizedPnl + unrealizedPnl;
  return {
    levels, trades, position: +position.toFixed(2),
    realizedPnl: +realizedPnl.toFixed(2),
    unrealizedPnl: +unrealizedPnl.toFixed(2),
    totalPnl: +totalPnl.toFixed(2),
    initialBudgetNeeded: +(grids * sharesPerGrid * lower).toFixed(2),
  };
}

// ---------- §8 再平衡 ----------
/**
 * 目标权重再平衡: 计算把 currentWeights 调回 targetWeights 所需买卖金额
 *   weights 为 {code: 权重} 对象; totalValue 为组合总市值; threshold 为忽略阈值
 * 返回 [{code, currentWeight, targetWeight, deltaValue, action: BUY/SELL/HOLD}]
 */
function rebalanceTarget(currentWeights, targetWeights, totalValue, threshold = 0.01) {
  if (!currentWeights || !targetWeights || !(totalValue > 0)) return [];
  const codes = new Set([...Object.keys(currentWeights), ...Object.keys(targetWeights)]);
  const trades = [];
  for (const code of codes) {
    const cur = currentWeights[code] || 0;
    const tgt = targetWeights[code] || 0;
    const deltaW = tgt - cur;
    const rec = { code, currentWeight: +cur.toFixed(4), targetWeight: +tgt.toFixed(4), deltaValue: 0, action: 'HOLD' };
    if (Math.abs(deltaW) >= threshold) {
      rec.deltaValue = +(deltaW * totalValue).toFixed(2);
      rec.action = deltaW > 0 ? 'BUY' : 'SELL';
    }
    trades.push(rec);
  }
  return trades;
}

// ---------- §8 回撤熔断 ----------
/**
 * 组合回撤熔断: 监控净值曲线, 回撤超过 threshold 触发强制减仓信号
 *   返回 {triggered, maxDrawdown(最负), triggerIndex(首次触发), peakIndex}
 */
function drawdownCircuitBreaker(equityCurve, threshold = 0.15) {
  if (!Array.isArray(equityCurve) || equityCurve.length < 2) {
    return { triggered: false, maxDrawdown: 0, triggerIndex: -1, peakIndex: -1 };
  }
  let peak = equityCurve[0], peakIdx = 0, maxDD = 0, trigIdx = -1;
  for (let i = 0; i < equityCurve.length; i++) {
    if (equityCurve[i] > peak) { peak = equityCurve[i]; peakIdx = i; }
    const dd = peak > 0 ? equityCurve[i] / peak - 1 : 0;
    if (dd < maxDD) maxDD = dd;
    if (trigIdx === -1 && dd <= -threshold) trigIdx = i;
  }
  return { triggered: trigIdx !== -1, maxDrawdown: +maxDD.toFixed(4), triggerIndex: trigIdx, peakIndex: peakIdx };
}

module.exports = {
  dcaCost, gridTrading, rebalanceTarget, drawdownCircuitBreaker,
};
