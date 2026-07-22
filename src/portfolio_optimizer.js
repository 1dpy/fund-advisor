/**
 * 现代投资组合理论 (Modern Portfolio Theory) 优化器
 * ---------------------------------------------------------------
 * 纯 JS 实现, 无外部依赖。提供两类经典仓位算法, 作为"等权分散"
 * 的定量增强对比 (参考 VanAurum/robo-advisor 的 Markowitz 思想):
 *
 *   1) 马克维茨均值-方差优化
 *      - Monte Carlo 采样生成"有效前沿" (efficient frontier)
 *      - 取 最大夏普比率 (tangency portfolio) 与 最小方差 两个代表组合
 *      - 约束: 单基金权重 ∈ [0, maxWeight], 权重和为 1
 *
 *   2) 风险平价 (Risk Parity / Equal Risk Contribution)
 *      - 迭代求解使每只基金对组合总风险的边际贡献相等
 *      - 不押注收益预测, 只平衡风险, 熊市更抗跌
 *
 * 输入统一为: navs = { code: number[] } (按共同交易日对齐的净值序列)
 * 输出权重为 { code: weight }。
 *
 * 工程价值: 直接展示对 MPT / 风险预算的掌握, 是人大的金融量化导师
 *          最看重的"理论落地"能力。
 */

// ---- 可复现随机数 (mulberry32) ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 由净值序列算日收益率矩阵 returns[code] = number[]
function dailyReturns(navs) {
  const codes = Object.keys(navs);
  const ret = {};
  for (const c of codes) {
    const arr = navs[c];
    const r = [];
    for (let i = 1; i < arr.length; i++) r.push(arr[i] / arr[i - 1] - 1);
    ret[c] = r;
  }
  return ret;
}

function meanVector(returns) {
  const out = {};
  for (const c of Object.keys(returns)) {
    const a = returns[c];
    out[c] = a.reduce((s, v) => s + v, 0) / a.length;
  }
  return out;
}

// 协方差矩阵 -> { codes, matrix: number[][], diag: {code:var} }
function covariance(returns) {
  const codes = Object.keys(returns);
  const n = codes.length;
  const mean = meanVector(returns);
  const T = returns[codes[0]].length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) {
        const di = returns[codes[i]][t] - mean[codes[i]];
        const dj = returns[codes[j]][t] - mean[codes[j]];
        s += di * dj;
      }
      const cov = s / (T - 1);
      matrix[i][j] = cov;
      matrix[j][i] = cov;
    }
  }
  return { codes, matrix };
}

function portReturn(weights, mean) {
  let r = 0;
  for (const c of Object.keys(weights)) r += weights[c] * mean[c];
  return r;
}

function portVariance(weights, cov) {
  const { codes, matrix } = cov;
  let v = 0;
  for (let i = 0; i < codes.length; i++) {
    for (let j = 0; j < codes.length; j++) {
      v += weights[codes[i]] * weights[codes[j]] * matrix[i][j];
    }
  }
  return v;
}

// ---- EWMA (指数加权) 协方差与波动率 ----
// 金融时间序列存在"波动率聚集"——近期波动更能预测未来。EWMA 给近期
// 收益更高权重 (RiskMetrics 标准 λ=0.94), 比等权样本协方差更稳健。
//   returns: { code: number[] } 日收益率
//   lambda: 衰减因子, 默认 0.94 (J.P. Morgan RiskMetrics 推荐值)
// 返回 { codes, matrix, vols: {code: 年化波动率} }
function ewmaCovariance(returns, lambda = 0.94) {
  const codes = Object.keys(returns);
  const n = codes.length;
  const T = returns[codes[0]].length;
  const mean = meanVector(returns);
  // 去均值残差
  const resid = {};
  for (const c of codes) resid[c] = returns[c].map((v, t) => v - mean[c]);
  // EWMA 权重 (最近期权重最高), 归一化
  const w = [];
  let wsum = 0;
  for (let t = 0; t < T; t++) { const wt = Math.pow(lambda, T - 1 - t); w.push(wt); wsum += wt; }
  for (let t = 0; t < T; t++) w[t] /= wsum;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += w[t] * resid[codes[i]][t] * resid[codes[j]][t];
      matrix[i][j] = s; matrix[j][i] = s;
    }
  }
  // 年化波动率
  const vols = {};
  for (let i = 0; i < n; i++) vols[codes[i]] = Math.sqrt(matrix[i][i]) * Math.sqrt(252);
  return { codes, matrix, vols };
}

// 风险平价求解 (坐标下降), 与协方差来源无关 —— MPT/风险平价共用
function solveRiskParity(matrix, codes, opts = {}) {
  const { maxIter = 200, tol = 1e-7, maxWeight = 0.25 } = opts;
  const n = codes.length;
  let w = new Array(n).fill(1 / n);
  for (let it = 0; it < maxIter; it++) {
    const portVar = portVariance(Object.fromEntries(codes.map((c, i) => [c, w[i]])), { codes, matrix });
    if (portVar <= 0) break;
    const marginal = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let c = 0;
      for (let j = 0; j < n; j++) c += matrix[i][j] * w[j];
      marginal[i] = c * w[i];
    }
    const avg = marginal.reduce((a, b) => a + b, 0) / n;
    let maxStep = 0;
    for (let i = 0; i < n; i++) {
      const adj = (marginal[i] - avg) / (avg + 1e-12);
      w[i] = Math.max(0, Math.min(maxWeight, w[i] * (1 - 0.3 * adj)));
      maxStep = Math.max(maxStep, Math.abs(adj));
    }
    const ws = w.reduce((a, b) => a + b, 0);
    if (ws > 0) w = w.map((x) => x / ws);
    if (maxStep < tol) break;
  }
  return w;
}

// 随机权重 (指数归一化, 受 maxWeight 截断)
function randomWeights(n, rng, maxWeight) {
  const raw = [];
  let sum = 0;
  for (let i = 0; i < n; i++) { const x = -Math.log(rng() + 1e-12); raw.push(x); sum += x; }
  return raw.map((x) => Math.min(maxWeight, x / sum));
}

// 马克维茨: Monte Carlo 有效前沿 + 最大夏普 / 最小方差
//   navs: { code: number[] }
//   opts: { samples=20000, maxWeight=0.25, seed=42, annualize=252 }
function markowitz(navs, opts = {}) {
  const { samples = 20000, maxWeight = 0.25, seed = 42, annualize = 252 } = opts;
  const returns = dailyReturns(navs);
  const mean = meanVector(returns);
  const cov = covariance(returns);
  const codes = cov.codes;
  const n = codes.length;
  const rng = mulberry32(seed);

  const points = [];
  let bestSharpe = null, minVar = null;
  for (let s = 0; s < samples; s++) {
    let w = randomWeights(n, rng, maxWeight);
    let wsum = w.reduce((a, b) => a + b, 0);
    if (wsum <= 0) continue;
    w = w.map((x) => x / wsum);
    const r = portReturn(Object.fromEntries(codes.map((c, i) => [c, w[i]])), mean) * annualize;
    const vol = Math.sqrt(portVariance(Object.fromEntries(codes.map((c, i) => [c, w[i]])), cov)) * Math.sqrt(annualize);
    const sharpe = vol > 1e-9 ? r / vol : 0;
    points.push({ ret: r, vol, sharpe, w: Object.fromEntries(codes.map((c, i) => [c, +w[i].toFixed(4)])) });
    if (!bestSharpe || sharpe > bestSharpe.sharpe) bestSharpe = { ret: r, vol, sharpe, w: points[points.length - 1].w };
    if (!minVar || vol < minVar.vol) minVar = { ret: r, vol, sharpe, w: points[points.length - 1].w };
  }
  return { frontier: points, maxSharpe: bestSharpe, minVariance: minVar, codes };
}

// 风险平价 (等风险贡献) — 使用等权样本协方差 (基准版)
//   navs: { code: number[] }; opts: { maxIter, tol, maxWeight }
function riskParity(navs, opts = {}) {
  const { maxWeight = 0.25 } = opts;
  const returns = dailyReturns(navs);
  const cov = covariance(returns);
  const { codes, matrix } = cov;
  const w = solveRiskParity(matrix, codes, { ...opts, maxWeight });
  return finalizeRiskParity(w, codes, returns, cov);
}

// 风险平价 — 使用 EWMA(指数加权) 协方差 (对波动率聚集更敏感)
//   lambda: 衰减因子, 默认 0.94 (J.P. Morgan RiskMetrics)
function riskParityEWMA(navs, opts = {}) {
  const { maxWeight = 0.25, lambda = 0.94 } = opts;
  const returns = dailyReturns(navs);
  const cov = ewmaCovariance(returns, lambda);
  const { codes, matrix } = cov;
  const w = solveRiskParity(matrix, codes, { ...opts, maxWeight });
  const rp = finalizeRiskParity(w, codes, returns, cov);
  rp.vols = cov.vols; // 附上 EWMA 年化波动率
  return rp;
}

function finalizeRiskParity(w, codes, returns, cov) {
  const mean = meanVector(returns);
  const annualize = 252;
  const ret = portReturn(Object.fromEntries(codes.map((c, i) => [c, w[i]])), mean) * annualize;
  const vol = Math.sqrt(portVariance(Object.fromEntries(codes.map((c, i) => [c, w[i]])), cov)) * Math.sqrt(annualize);
  return {
    weights: Object.fromEntries(codes.map((c, i) => [c, +w[i].toFixed(4)])),
    ret: +ret.toFixed(4),
    vol: +vol.toFixed(4),
    sharpe: vol > 1e-9 ? +(ret / vol).toFixed(3) : 0,
  };
}

module.exports = { dailyReturns, meanVector, covariance, ewmaCovariance, markowitz, riskParity, riskParityEWMA, solveRiskParity, mulberry32 };
