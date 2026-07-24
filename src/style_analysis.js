/**
 * 风格分析 (Style Analysis)
 * ---------------------------------------------------------------
 * 覆盖《基金量化模型与公式.md》§5 风格分析(Sharpe 约束回归):
 *   min_w Σ(R_p - Σ_k w_k·R_style,k)²   s.t.  w_k ≥ 0,  Σ_k w_k = 1
 * 输出各风格暴露权重 + 拟合优度 R²; 并检测「名义风格 vs 实际风格」漂移
 * (即"挂羊头卖狗肉"预警: 名义赛道基金实际重仓了别的风格)。
 *
 * 纯函数、无网络依赖。约束二次规划(QP)用 FISTA + 单纯形投影求解,
 *   对中小风格数(k ≤ 12)稳定收敛; 风格数过大时退化为投影梯度兜底。
 */

// 投影到单纯形 {w ≥ 0, Σw = 1} (Duchi et al., 2008)
function projectToSimplex(v) {
  const n = v.length;
  const u = [...v].sort((a, b) => b - a);
  let cssv = 0, rho = -1, theta = 0;
  for (let i = 0; i < n; i++) {
    cssv += u[i];
    const t = (cssv - 1) / (i + 1);
    if (u[i] - t > 0) { rho = i; theta = t; }
  }
  if (rho < 0) return new Array(n).fill(1 / n); // 退化兜底: 均匀
  return v.map(x => Math.max(0, x - theta));
}

// 单纯形约束最小二乘: 返回权重向量 w (维度 k)。Q=2XᵀX, 步长=1/L, L=2·λ_max(XᵀX)
function qpSimplex(Rp, X, k, { iterations = 3000 } = {}) {
  // XᵀX (k×k) 与 XᵀRp (k)
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    let s = 0; for (let ii = 0; ii < X.length; ii++) s += X[ii][i] * X[ii][j];
    XtX[i][j] = s;
  }
  const c = new Array(k).fill(0);
  for (let ii = 0; ii < X.length; ii++) for (let j = 0; j < k; j++) c[j] += X[ii][j] * Rp[ii];
  // λ_max(XᵀX) 幂迭代
  let v = new Array(k).fill(1 / Math.sqrt(k));
  let lam = 0;
  for (let it = 0; it < 300; it++) {
    const Mv = new Array(k).fill(0);
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) Mv[i] += XtX[i][j] * v[j];
    const norm = Math.sqrt(Mv.reduce((s, x) => s + x * x, 0)) || 1;
    v = Mv.map(x => x / norm);
    let num = 0; for (let i = 0; i < k; i++) num += v[i] * Mv[i];
    lam = num;
  }
  const L = Math.max(1e-9, 2 * lam); // ∇f 的 Lipschitz 常数
  const step = 1 / L;
  // FISTA
  let w = new Array(k).fill(1 / k);
  let z = w.slice();
  let t = 1;
  for (let it = 0; it < iterations; it++) {
    const XtXz = new Array(k).fill(0);
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) XtXz[i] += XtX[i][j] * z[j];
    const g = XtXz.map((val, i) => 2 * (val - c[i])); // ∇f = 2(XᵀXz - XᵀRp)
    const wNew = projectToSimplex(z.map((val, i) => val - step * g[i]));
    const tNew = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
    z = wNew.map((val, i) => val + ((t - 1) / tNew) * (wNew[i] - w[i]));
    w = wNew; t = tNew;
    if (it > 0 && it % 500 === 0) {
      // 早停: 权重变化极小
      let maxd = 0; for (let i = 0; i < k; i++) maxd = Math.max(maxd, Math.abs(wNew[i] - w[i]));
      if (maxd < 1e-7) break;
    }
  }
  return w;
}

/**
 * 风格约束回归: 用一组风格因子收益序列解释基金收益, 求非负且和为1的暴露权重
 *   Rp: 基金日收益序列; styleMatrix: 二维数组 [n][k], 每列为一个风格因子收益
 *   styleNames: 长度 k 的风格名; 返回 {weights, r2, residualStd, activeStyles, n}
 */
function styleRegression(Rp, styleMatrix, styleNames, { iterations = 3000 } = {}) {
  if (!Array.isArray(Rp) || !Array.isArray(styleMatrix) || styleMatrix.length !== Rp.length) return null;
  const k = styleMatrix[0].length;
  if (!k || (styleNames && styleNames.length !== k)) return null;
  if (Rp.length < k + 2) return null;
  let w;
  if (k === 1) w = [1];
  else w = qpSimplex(Rp, styleMatrix, k, { iterations });
  // 拟合优度 R² 与残差标准差
  let sse = 0, sst = 0;
  const meanRp = Rp.reduce((s, vv) => s + vv, 0) / Rp.length;
  for (let i = 0; i < Rp.length; i++) {
    let xw = 0; for (let j = 0; j < k; j++) xw += styleMatrix[i][j] * w[j];
    sse += (Rp[i] - xw) ** 2;
    sst += (Rp[i] - meanRp) ** 2;
  }
  const r2 = sst < 1e-15 ? 0 : Math.max(0, 1 - sse / sst);
  const residualStd = Math.sqrt(sse / Math.max(1, Rp.length - k));
  const weights = {};
  for (let j = 0; j < k; j++) weights[styleNames ? styleNames[j] : `style${j}`] = +w[j].toFixed(4);
  const activeStyles = Object.entries(weights).filter(([, val]) => val > 0.01).map(([key]) => key);
  return { weights, r2: +r2.toFixed(4), residualStd: +residualStd.toFixed(6), activeStyles, n: Rp.length };
}

/**
 * 风格漂移检测: 比较「实际估计出的主导风格」与「名义风格」
 *   若估计主导风格 ≠ 名义风格, 或主导暴露 < (1-tolerance), 判定漂移
 * 返回 {drift, estimatedTopStyle, topWeight, nominalStyle, warning}
 */
function detectStyleDrift(styleWeights, nominalStyle, tolerance = 0.2) {
  if (!styleWeights || !nominalStyle) return { drift: false, reason: '参数缺失' };
  let topStyle = null, topW = -1;
  for (const [s, w] of Object.entries(styleWeights)) { if (w > topW) { topW = w; topStyle = s; } }
  const drift = topStyle !== nominalStyle || topW < (1 - tolerance);
  return {
    drift,
    estimatedTopStyle: topStyle,
    topWeight: +topW.toFixed(4),
    nominalStyle,
    tolerance,
    warning: drift
      ? `实际风格暴露以「${topStyle}」为主(权重${topW.toFixed(2)}), 与名义「${nominalStyle}」不符, 疑似风格漂移/挂羊头卖狗肉`
      : '风格一致, 暂未见漂移',
  };
}

module.exports = {
  projectToSimplex, styleRegression, detectStyleDrift,
};
