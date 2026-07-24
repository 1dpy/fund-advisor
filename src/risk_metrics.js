/**
 * 风险与风险调整收益指标库 (Risk & Risk-Adjusted Metrics)
 * ---------------------------------------------------------------
 * 集中实现《基金量化模型与公式.md》中尚缺的量化公式，纯函数、无网络依赖，
 * 可在 CI / 离线单测 / dashboard / 实时选基中复用。
 *
 * 覆盖 (文档章节):
 *   §1 收益:   dailyReturns / annualizedReturn / annualizedVol
 *   §2 风险:   下行标准差 σ_d / 半方差 / 最大回撤 MDD / VaR(参数+历史) / CVaR(ES)
 *   §3 风险调整: 夏普 / 索提诺 Sortino / 特雷诺 Treynor / 信息比率 IR / 卡玛 Calmar / 欧米伽 Omega
 *   §4 归因:   Beta / Jensen's Alpha (TM/HM 见 quant/factor.js 可扩展)
 *   §5:       跟踪误差 TE / 相关性 ρ
 *   §6:       凯利精确公式 f* = (bp-q)/b 及连续近似
 *   §9:       偏度 / 峰度 / Hurst 指数
 *
 * 约定: 输入 returns 为日频收益率数组; navs 为净值序列(由低到高时间序)。
 *       年化统一 T=252; 无风险利率 rf 取年化小数(默认 0.02 ≈ 货币/逆回购)。
 *       缺值/序列过短一律安全返回 0 或 null, 不抛异常。
 */

// ---------- 基础工具 ----------
function dailyReturns(navs) {
  if (!Array.isArray(navs) || navs.length < 2) return [];
  const r = [];
  for (let i = 1; i < navs.length; i++) {
    const prev = navs[i - 1], cur = navs[i];
    if (prev > 0) r.push(cur / prev - 1);
  }
  return r;
}
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
function safeDiv(a, b) { return b === 0 ? 0 : a / b; }
function percentile(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const idx = (sortedAsc.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

// ---------- §1 收益 ----------
function annualizedReturn(returns, periodsPerYear = 252) {
  if (!returns.length) return 0;
  const growth = returns.reduce((acc, r) => acc * (1 + r), 1);
  return Math.pow(growth, periodsPerYear / returns.length) - 1;
}
function annualizedVol(returns, periodsPerYear = 252) {
  return stdev(returns) * Math.sqrt(periodsPerYear);
}

// ---------- §2 风险 ----------
// 最大回撤: 返回负数分数 (e.g. -0.2 = 峰值到谷最大跌20%)
function maxDrawdown(navs) {
  if (!Array.isArray(navs) || navs.length < 2) return 0;
  let peak = navs[0], mdd = 0;
  for (const v of navs) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.min(mdd, v / peak - 1);
  }
  return mdd; // <=0
}
// 下行标准差 σ_d (MAR 最低可接受收益, 默认0): σ_d = sqrt(1/n Σ min(0, R_i-MAR)^2)
function downsideDeviation(returns, mar = 0) {
  if (!returns.length) return 0;
  const sq = returns.reduce((s, r) => { const d = Math.min(0, r - mar); return s + d * d; }, 0);
  return Math.sqrt(sq / returns.length);
}
// 半方差 SV = 1/n Σ min(0, R_i - μ)^2
function semiVariance(returns) {
  if (!returns.length) return 0;
  const m = mean(returns);
  const sq = returns.reduce((s, r) => { const d = Math.min(0, r - m); return s + d * d; }, 0);
  return sq / returns.length;
}
// VaR (参数法/方差-协方差), 单期: VaR_α = μ - z_α·σ ; 返回该期损失(负数)
function varParametric(returns, alpha = 0.95) {
  if (!returns.length) return 0;
  const z = { 0.90: 1.2816, 0.95: 1.6449, 0.975: 1.9600, 0.99: 2.3263 }[alpha] || 1.6449;
  return mean(returns) - z * stdev(returns);
}
// VaR (历史法): 经验分布 (1-α) 分位损失
function varHistorical(returns, alpha = 0.95) {
  if (!returns.length) return 0;
  const s = [...returns].sort((a, b) => a - b);
  return percentile(s, 1 - alpha);
}
// CVaR / 预期短缺 ES: 低于 VaR 部分的条件期望
function cvar(returns, alpha = 0.95) {
  if (!returns.length) return 0;
  const v = varHistorical(returns, alpha);
  const tail = returns.filter(r => r <= v);
  return tail.length ? mean(tail) : v;
}

// ---------- §3 风险调整收益 ----------
// 夏普: (年化收益 - rf) / 年化波动
function sharpeRatio(returns, rf = 0.02, periodsPerYear = 252) {
  const vol = annualizedVol(returns, periodsPerYear);
  if (vol < 1e-9) return 0;
  return (annualizedReturn(returns, periodsPerYear) - rf) / vol;
}
// 索提诺: (年化收益 - rf) / 年化下行标准差  (只看下行风险)
function sortinoRatio(returns, rf = 0.02, mar = 0, periodsPerYear = 252) {
  const dd = downsideDeviation(returns, mar) * Math.sqrt(periodsPerYear);
  if (dd < 1e-9) return 0;
  return (annualizedReturn(returns, periodsPerYear) - rf) / dd;
}
// 卡玛: 年化收益 / |最大回撤|  (returns 为日频收益序列, 内部由其重建净值算回撤)
function calmarRatio(returns, rf = 0, periodsPerYear = 252) {
  const mddFrac = maxDrawdownFromReturns(returns);
  if (mddFrac > -1e-9) return 0;
  return (annualizedReturn(returns, periodsPerYear) - rf) / Math.abs(mddFrac);
}
// 由收益序列直接算回撤(避免依赖外部净值)
function maxDrawdownFromReturns(returns) {
  let nav = 1, peak = 1, mdd = 0;
  for (const r of returns) { nav *= (1 + r); if (nav > peak) peak = nav; mdd = Math.min(mdd, nav / peak - 1); }
  return mdd;
}
// 特雷诺: (年化收益 - rf) / β  (用算术年化, 与 CAPM 线性定义一致)
function treynorRatio(returns, marketReturns, rf = 0.02, periodsPerYear = 252) {
  const b = beta(returns, marketReturns);
  if (Math.abs(b) < 1e-9) return 0;
  return (mean(returns) * periodsPerYear - rf) / b;
}
// 信息比率: 年化主动收益 / 年化跟踪误差
function informationRatio(returns, benchReturns, periodsPerYear = 252) {
  if (returns.length !== benchReturns.length || returns.length < 2) return 0;
  const active = returns.map((r, i) => r - benchReturns[i]);
  const te = stdev(active) * Math.sqrt(periodsPerYear);
  if (te < 1e-9) return 0;
  return (mean(active) * periodsPerYear) / te;
}
// 欧米伽: 阈值 L 以上收益和 / 以下损失和
function omegaRatio(returns, threshold = 0) {
  let up = 0, down = 0;
  for (const r of returns) {
    if (r > threshold) up += (r - threshold);
    else down += (threshold - r);
  }
  return safeDiv(up, down);
}

// ---------- §4 / §5 归因与基准 ----------
// Beta: Cov(R_p, R_m) / Var(R_m)
function beta(returns, marketReturns) {
  if (returns.length !== marketReturns.length || returns.length < 2) return 1;
  const mr = mean(returns), mm = mean(marketReturns);
  let cov = 0, varM = 0;
  for (let i = 0; i < returns.length; i++) {
    cov += (returns[i] - mr) * (marketReturns[i] - mm);
    varM += (marketReturns[i] - mm) ** 2;
  }
  return safeDiv(cov, varM) || 1;
}
// Jensen's Alpha: α = 年化R_p - [rf + β(年化R_m - rf)]
//   用算术年化 (mean×T), 与 CAPM 线性定义一致; 纯β暴露(alpha=0)时精确为0
function jensensAlpha(returns, marketReturns, rf = 0.02, periodsPerYear = 252) {
  const b = beta(returns, marketReturns);
  const rp = mean(returns) * periodsPerYear;
  const rm = mean(marketReturns) * periodsPerYear;
  return rp - (rf + b * (rm - rf));
}
// 跟踪误差 TE = std(R_p - R_b)
function trackingError(returns, benchReturns, periodsPerYear = 252) {
  if (returns.length !== benchReturns.length || returns.length < 2) return 0;
  const active = returns.map((r, i) => r - benchReturns[i]);
  return stdev(active) * Math.sqrt(periodsPerYear);
}
// 相关性 ρ
function correlation(x, y) {
  if (x.length !== y.length || x.length < 2) return 0;
  const mx = mean(x), my = mean(y);
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < x.length; i++) { cov += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; }
  const d = Math.sqrt(vx * vy);
  return d < 1e-12 ? 0 : cov / d;
}

// ---------- §6 凯利 ----------
// 离散精确版: f* = (b·p - q) / b ; b=赔率(赢时收益/输时损失比), p=胜率, q=1-p
function kellyCriterion(winProb, payoffRatio) {
  if (winProb <= 0 || winProb >= 1) return 0;
  if (payoffRatio <= 0) return 0;
  const p = winProb, q = 1 - p, b = payoffRatio;
  return safeDiv(b * p - q, b);
}
// 分数凯利 (控制回撤, 默认半凯利)
function kellyFractional(winProb, payoffRatio, fraction = 0.5) {
  return fraction * kellyCriterion(winProb, payoffRatio);
}
// 连续近似(对数效用): f* ≈ (μ - rf) / σ²
function kellyContinuous(meanRet, rf = 0.02, variance) {
  if (variance <= 0) return 0;
  return safeDiv(meanRet - rf, variance);
}

// ---------- §9 分布 / 长记忆 ----------
function skewness(returns) {
  const n = returns.length;
  if (n < 3) return 0;
  const m = mean(returns), s = stdev(returns);
  if (s < 1e-12) return 0;
  const sum = returns.reduce((acc, r) => acc + ((r - m) / s) ** 3, 0);
  return (n / ((n - 1) * (n - 2))) * sum;
}
function kurtosis(returns) { // 超额峰度
  const n = returns.length;
  if (n < 4) return 0;
  const m = mean(returns), s = stdev(returns);
  if (s < 1e-12) return 0;
  const sum = returns.reduce((acc, r) => acc + ((r - m) / s) ** 4, 0);
  return (n * (n + 1) / ((n - 1) * (n - 2) * (n - 3))) * sum - (3 * (n - 1) ** 2 / ((n - 2) * (n - 3)));
}
// Hurst 指数 (重标极差 R/S 简化版): <0.5 均值回复(适合网格), >0.5 趋势延续(适合右侧)
function hurstIndex(returns, maxLag = 20) {
  const n = returns.length;
  if (n < 2 * maxLag) maxLag = Math.floor(n / 2);
  if (maxLag < 2) return 0.5;
  const rs = [];
  for (let lag = 2; lag <= maxLag; lag++) {
    const chunks = Math.floor(n / lag);
    if (chunks < 1) continue;
    let total = 0;
    for (let c = 0; c < chunks; c++) {
      const seg = returns.slice(c * lag, (c + 1) * lag);
      const m = mean(seg);
      const dev = seg.map(r => r - m);
      let cum = 0; const cumArr = dev.map(d => (cum += d));
      const rRange = Math.max(...cumArr) - Math.min(...cumArr);
      const sStd = stdev(seg);
      if (sStd > 1e-12) total += rRange / sStd;
    }
    if (chunks > 0) rs.push([Math.log(lag), Math.log(total / chunks)]);
  }
  if (rs.length < 2) return 0.5;
  // 线性回归斜率 = Hurst
  const xs = rs.map(p => p[0]), ys = rs.map(p => p[1]);
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den < 1e-12 ? 0.5 : num / den;
}

// ---------- 一站式: 由净值序列算出全部风险/风险调整指标 ----------
function computeRiskProfile(navs, opts = {}) {
  const { rf = 0.02, benchReturns = null, marketReturns = null, periodsPerYear = 252 } = opts;
  const returns = dailyReturns(navs);
  if (returns.length < 5) return null;
  const out = {
    annReturn: +annualizedReturn(returns, periodsPerYear).toFixed(4),
    annVol: +annualizedVol(returns, periodsPerYear).toFixed(4),
    mdd: +maxDrawdown(navs).toFixed(4),
    downsideDev: +downsideDeviation(returns).toFixed(4),
    semiVar: +semiVariance(returns).toFixed(4),
    sharpe: +sharpeRatio(returns, rf, periodsPerYear).toFixed(3),
    sortino: +sortinoRatio(returns, rf, 0, periodsPerYear).toFixed(3),
    calmar: +calmarRatio(returns, rf, periodsPerYear).toFixed(3),
    var95Hist: +varHistorical(returns, 0.95).toFixed(4),
    var95Param: +varParametric(returns, 0.95).toFixed(4),
    cvar95: +cvar(returns, 0.95).toFixed(4),
    omega: +omegaRatio(returns, 0).toFixed(3),
    skew: +skewness(returns).toFixed(3),
    kurt: +kurtosis(returns).toFixed(3),
    hurst: +hurstIndex(returns).toFixed(3),
    winRate: +(returns.filter(r => r > 0).length / returns.length).toFixed(3),
  };
  const wins = returns.filter(r => r > 0), losses = returns.filter(r => r < 0);
  const avgWin = wins.length ? mean(wins) : 0;
  const avgLoss = losses.length ? Math.abs(mean(losses)) : 0;
  out.payoffRatio = +safeDiv(avgWin, avgLoss).toFixed(3);
  out.kelly = +kellyCriterion(out.winRate, out.payoffRatio).toFixed(4);
  if (benchReturns && benchReturns.length === returns.length) {
    out.ir = +informationRatio(returns, benchReturns, periodsPerYear).toFixed(3);
    out.te = +trackingError(returns, benchReturns, periodsPerYear).toFixed(4);
  }
  if (marketReturns && marketReturns.length === returns.length) {
    out.beta = +beta(returns, marketReturns).toFixed(3);
    out.jensenAlpha = +jensensAlpha(returns, marketReturns, rf, periodsPerYear).toFixed(4);
    out.treynor = +treynorRatio(returns, marketReturns, rf, periodsPerYear).toFixed(3);
  }
  return out;
}

module.exports = {
  dailyReturns, mean, stdev, safeDiv, percentile,
  annualizedReturn, annualizedVol,
  maxDrawdown, maxDrawdownFromReturns, downsideDeviation, semiVariance,
  varParametric, varHistorical, cvar,
  sharpeRatio, sortinoRatio, calmarRatio, treynorRatio, informationRatio, omegaRatio,
  beta, jensensAlpha, trackingError, correlation,
  kellyCriterion, kellyFractional, kellyContinuous,
  skewness, kurtosis, hurstIndex,
  computeRiskProfile,
};
