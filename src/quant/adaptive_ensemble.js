/**
 * Adaptive Random-Subspace Ensemble（自适应随机子空间集成）
 * ---------------------------------------------------------------
 * 对标准岭回归做两层随机化：
 *   1. 每次只随机取一部分特征（random subspace）；
 *   2. 每轮从样本中有放回抽样（bootstrap bagging）。
 * 最后取所有子模型预测的平均，降低单模型对某一特征/某一段样本的依赖。
 *
 * 防过拟合设计：
 *   - 每个候选配置都是确定性的随机种子，回测可复现；
 *   - 配置包含不同正则强度 λ，模型自带 L2 收缩；
 *   - 真正选择配置的“目标函数”在 ml_calibrate 的 walk-forward 外层完成：
 *     OOS IC − 惩罚系数 × (训练 IC − OOS IC)，惩罚越大越偏好稳健配置。
 *
 * 用法：
 *   const ae = require('./adaptive_ensemble');
 *   const model = ae.trainAdaptiveEnsemble(X, y, { frac: 0.7, lambda: 0.5, nModels: 8, seed: 7 });
 *   const score = ae.predictAdaptiveEnsemble(model, featureRow);
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let i = col + 1; i < n; i++) if (Math.abs(M[i][col]) > Math.abs(M[piv][col])) piv = i;
    if (Math.abs(M[piv][col]) < 1e-12) return new Array(n).fill(0);
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= d;
    for (let i = 0; i < n; i++) {
      if (i === col) continue;
      const f = M[i][col];
      if (Math.abs(f) < 1e-15) continue;
      for (let j = col; j <= n; j++) M[i][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row[n]);
}

function trainRidge(X, y, lambda = 1) {
  const d = (X[0] ? X[0].length : 0) + 1;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xr = [1, ...X[i]];
    for (let p = 0; p < d; p++) {
      b[p] += xr[p] * y[i];
      for (let q = 0; q < d; q++) A[p][q] += xr[p] * xr[q];
    }
  }
  for (let i = 1; i < d; i++) A[i][i] += lambda;
  return solveLinear(A, b);
}

function sampleUnique(rng, n, k) {
  const pool = Array.from({ length: n }, (_, i) => i);
  const out = [];
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (n - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    out.push(pool[i]);
  }
  return out.sort((a, b) => a - b);
}

function adaptiveEnsembleConfigs() {
  const out = [];
  for (const frac of [0.65, 0.85]) {
    for (const lambda of [0.05, 0.5, 5]) {
      out.push({ frac, lambda, nModels: 8, seed: 20260807 + out.length });
    }
  }
  return out;
}

function trainAdaptiveEnsemble(X, y, config = {}) {
  if (!X || !X.length) return null;
  const { frac = 0.7, lambda = 0.5, nModels = 8, seed = 7 } = config;
  const d = X[0].length;
  const n = X.length;
  const k = Math.max(3, Math.round(d * frac));
  const rng = mulberry32(seed);
  const models = [];
  for (let m = 0; m < nModels; m++) {
    const feats = sampleUnique(rng, d, k);
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(Math.floor(rng() * n));
    const subX = idx.map((i) => feats.map((f) => X[i][f]));
    const subY = idx.map((i) => y[i]);
    models.push({ feats, w: trainRidge(subX, subY, lambda) });
  }
  return { models, config };
}

function predictAdaptiveEnsemble(model, row) {
  if (!model || !model.models || !model.models.length || !row) return 0;
  let s = 0;
  for (const m of model.models) {
    let v = m.w[0] || 0;
    for (let i = 0; i < m.feats.length; i++) v += (m.w[i + 1] || 0) * row[m.feats[i]];
    s += v;
  }
  return s / model.models.length;
}

module.exports = { trainAdaptiveEnsemble, predictAdaptiveEnsemble, adaptiveEnsembleConfigs };
