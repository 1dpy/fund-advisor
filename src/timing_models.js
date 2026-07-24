/**
 * 择时与周期模型 (Timing & Regime Models)
 * ---------------------------------------------------------------
 * 覆盖《基金量化模型与公式.md》:
 *   §4 业绩归因: Treynor–Mazuy(TM) / Henriksson–Merton(HM) 择时能力回归
 *   §7 择时模型: 估值分位择时 / 均线趋势 / 美林时钟(库存周期)
 *
 * 纯函数、无网络依赖，可在 CI / 离线单测 / 实时模块 / 诊断报告中复用。
 * 约定: Rp/Rm 为日频收益序列; rf 取年化小数(默认 0.02); 年化 T=252。
 *       缺值/序列过短一律安全返回 null, 不抛异常。
 */

// ---------- 线性代数基础 ----------
function matTranspose(M) {
  const rows = M.length, cols = M[0].length;
  const T = Array.from({ length: cols }, () => new Array(rows).fill(0));
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) T[j][i] = M[i][j];
  return T;
}
function matVec(M, v) {
  return M.map(row => row.reduce((s, x, j) => s + x * v[j], 0));
}
function matMat(A, B) {
  const n = A.length, m = B[0].length, k = B.length;
  const C = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    let s = 0; for (let p = 0; p < k; p++) s += A[i][p] * B[p][j];
    C[i][j] = s;
  }
  return C;
}
// 高斯消元 + 部分主元解 A x = b (A 为 n×n); 奇异返回 null
function solveLinear(A, b) {
  const n = A.length;
  const M = A.map(r => r.slice());
  const v = b.slice();
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-15) return null;
    if (piv !== col) { [M[piv], M[col]] = [M[col], M[piv]]; [v[piv], v[col]] = [v[col], v[piv]]; }
    const d = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) M[r][c] -= f * M[col][c];
      v[r] -= f * v[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = v[i];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}
// 普通最小二乘: 返回系数向量; X 为设计矩阵(每行一个样本)
function olsFit(X, y) {
  const Xt = matTranspose(X);
  const XtX = matMat(Xt, X);
  const Xty = matVec(Xt, y);
  return solveLinear(XtX, Xty);
}
function rsquared(X, y, coef) {
  const n = y.length;
  if (n === 0 || !coef) return 0;
  const yhat = matVec(X, coef);
  const ymean = y.reduce((s, vv) => s + vv, 0) / n;
  let sse = 0, sst = 0;
  for (let i = 0; i < n; i++) { sse += (y[i] - yhat[i]) ** 2; sst += (y[i] - ymean) ** 2; }
  if (sst < 1e-15) return 0;
  return Math.max(0, 1 - sse / sst);
}
function perPeriodRf(rf, periodsPerYear) { return rf / periodsPerYear; }

// ---------- §4 业绩归因: 择时能力回归 ----------
/**
 * Treynor–Mazuy (TM) 二次项择时模型:
 *   Rp - Rf = α + β(Rm-Rf) + γ(Rm-Rf)² + ε
 *   γ>0 表示基金经理有择时能力(牛市加仓、熊市减仓, 收益对市场的暴露呈凸性)。
 */
function treynorMazuy(Rp, Rm, rf = 0.02, periodsPerYear = 252) {
  const n = Rp.length;
  if (n < 10 || n !== Rm.length) return null;
  const rfP = perPeriodRf(rf, periodsPerYear);
  const exP = Rp.map(r => r - rfP);
  const exM = Rm.map(r => r - rfP);
  const X = exM.map(x => [1, x, x * x]);
  const coef = olsFit(X, exP);
  if (!coef) return null;
  return {
    alpha: +coef[0].toFixed(5), beta: +coef[1].toFixed(5), gamma: +coef[2].toFixed(5),
    r2: +rsquared(X, exP, coef).toFixed(4), n,
    timing: coef[2] > 0 ? 'positive' : (coef[2] < 0 ? 'negative' : 'none'),
  };
}

/**
 * Henriksson–Merton (HM) 虚拟变量择时模型:
 *   Rp - Rf = α + β(Rm-Rf) + γ·D·(Rm-Rf) + ε,  D=1 当 Rm>Rf 否则 0
 *   γ>0 表示择时能力(仅在市场上涨时放大暴露)。
 */
function henikrssonMerton(Rp, Rm, rf = 0.02, periodsPerYear = 252) {
  const n = Rp.length;
  if (n < 10 || n !== Rm.length) return null;
  const rfP = perPeriodRf(rf, periodsPerYear);
  const exP = Rp.map(r => r - rfP);
  const exM = Rm.map(r => r - rfP);
  const X = exM.map(x => [1, x, x > 0 ? x : 0]);
  const coef = olsFit(X, exP);
  if (!coef) return null;
  return {
    alpha: +coef[0].toFixed(5), beta: +coef[1].toFixed(5), gamma: +coef[2].toFixed(5),
    r2: +rsquared(X, exP, coef).toFixed(4), n,
    timing: coef[2] > 0 ? 'positive' : (coef[2] < 0 ? 'negative' : 'none'),
  };
}

// ---------- §7 择时模型 ----------
/**
 * 估值分位择时: 当前估值在历史中的分位
 *   pct = #{PE_hist < PE_cur} / N × 100
 *   返回 {pct, label}: <30 低估 / 30–70 合理 / 70–80 偏高 / >80 高估
 */
function valuationPercentile(peHist, peCur) {
  if (!Array.isArray(peHist) || peHist.length === 0) return { pct: 0, label: 'N/A' };
  const hist = peHist.filter(v => Number.isFinite(v));
  if (!hist.length) return { pct: 0, label: 'N/A' };
  const below = hist.filter(v => v < peCur).length;
  const pct = (below / hist.length) * 100;
  let label;
  if (pct < 30) label = '低估';
  else if (pct <= 70) label = '合理';
  else if (pct <= 80) label = '偏高';
  else label = '高估';
  return { pct: +pct.toFixed(1), label };
}

/**
 * 均线/趋势信号: 当前价格相对 window 日均线的位置与穿越
 *   上穿(金叉)→ bullish, 下穿(死叉)→ bearish, 否则看价格在均线上/下
 */
function maTrend(navs, window = 252) {
  if (!Array.isArray(navs) || navs.length < 2) return null;
  const w = Math.min(window, navs.length);
  const price = navs[navs.length - 1];
  const ma = navs.slice(navs.length - w).reduce((s, v) => s + v, 0) / w;
  const prevPrice = navs[navs.length - 2];
  const prevNavs = navs.slice(0, navs.length - 1);
  const pw = Math.min(window, prevNavs.length);
  const prevMa = prevNavs.slice(prevNavs.length - pw).reduce((s, v) => s + v, 0) / pw;
  const position = price >= ma ? 'above' : 'below';
  let cross = 'none';
  if (prevPrice <= prevMa && price > ma) cross = 'up';
  else if (prevPrice >= prevMa && price < ma) cross = 'down';
  const signal = cross === 'up' ? 'bullish' : cross === 'down' ? 'bearish' : (position === 'above' ? 'hold' : 'weak');
  return { price: +price.toFixed(4), ma: +ma.toFixed(4), prevMa: +prevMa.toFixed(4), window: w, position, cross, signal };
}

function normalizeRegimeInput(v) {
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['up', 'high', '上升', '高', '扩张', '过热', '增长', '上行'].includes(s)) return 'up';
    if (['down', 'low', '下降', '低', '收缩', '衰退', '放缓', '下行'].includes(s)) return 'down';
    return null;
  }
  return null;
}

/**
 * 美林时钟 / 库存周期: 由「经济增长」与「通胀」两个维度判定阶段并给出资产配置指引
 *   growth/inflation 可为: 数值(默认阈值 growth>0 / inflation>通胀阈值) 或 字符串 up/down/high/low
 *   四阶段: 复苏(股) / 过热(商品) / 滞胀(现金防御) / 衰退(债)
 *   返回 {regime, name, growthUp, inflationUp, allocation, rationale}
 */
function merrillClock({ growth, inflation, inflationThreshold = 3.0, growthThreshold = 0.0 } = {}) {
  let gUp, iUp;
  if (typeof growth === 'number' && Number.isFinite(growth)) gUp = growth > growthThreshold;
  else gUp = normalizeRegimeInput(growth) === 'up';
  if (typeof inflation === 'number' && Number.isFinite(inflation)) iUp = inflation > inflationThreshold;
  else iUp = normalizeRegimeInput(inflation) === 'up';
  let regime, name, allocation, rationale;
  if (gUp && !iUp) {
    regime = 'RECOVERY'; name = '复苏';
    allocation = ['成长股/科技', '周期股', '股票型', '可转债'];
    rationale = '经济向上 + 通胀温和 → 风险资产占优, 成长与周期弹性最大';
  } else if (gUp && iUp) {
    regime = 'OVERHEAT'; name = '过热';
    allocation = ['大宗商品', '资源/有色', '消费', '通胀保护'];
    rationale = '经济过热 + 通胀抬头 → 商品与资源最受益, 股优于债';
  } else if (!gUp && iUp) {
    regime = 'STAGFLATION'; name = '滞胀';
    allocation = ['现金/货币基金', '短债', '黄金', '防御'];
    rationale = '经济下行 + 通胀高 → 现金为王, 防御与黄金对冲';
  } else {
    regime = 'RECESSION'; name = '衰退';
    allocation = ['利率债/长债', '高等级信用债', '防御宽基', '现金'];
    rationale = '经济下行 + 通胀回落 → 债券与防御占优, 现金也可';
  }
  return { regime, name, growthUp: gUp, inflationUp: iUp, allocation, rationale };
}

module.exports = {
  matTranspose, matVec, matMat, solveLinear, olsFit, rsquared,
  treynorMazuy, henikrssonMerton,
  valuationPercentile, maTrend, merrillClock, normalizeRegimeInput,
};
