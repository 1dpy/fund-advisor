/**
 * ML 校准引擎（Walk-forward 真实验证 + 自适应权重）
 * ---------------------------------------------------------------
 * 原系统已有 LSTM / Attention / RF / GBDT / Ensemble 等模型，但集成权重
 * 是人工写死的，且没有把“样本外命中率 / 秩相关 IC”作为自我迭代信号。
 * 本模块解决两个核心问题：
 *
 * 1. 任何模型/信号都必须先在 walk-forward 的样本外窗口上验证，再进入实盘；
 * 2. 模型超参（预测周期、正则强度）按滚动扩展窗口的样本外 IC 在线挑选，
 *    并用冻结 holdout 报告最终证据，避免“拿未来数据调参数”。
 *
 * 特征：动量 / 波动 / 回撤 / 均线 / RSI / 自相关 / 偏度 / 现有 Ensemble
 * 信号等，全部按每个时点做截面 z-score 标准化，目标为未来 N 日相对全赛道
 * 的超额收益 z-score。基学习器为带 L2 正则的线性回归（纯 JS 实现，稳定快）。
 *
 * 用法：
 *   const mc = require('./ml_calibrate');
 *   const res = mc.calibrateWalkForward(closesByCode, codes, { holdout: 60 });
 *   mc.saveCalibration(res);   // data/ml_calibration.json
 */

const fs = require('fs');
const path = require('path');
const { ensembleVote } = require('./quant/ensemble');
const { trainRankingBoost, predictRanking } = require('./quant/ranking_boost');
const { trainAdaptiveEnsemble, predictAdaptiveEnsemble, adaptiveEnsembleConfigs } = require('./quant/adaptive_ensemble');

const ASE_REG_PENALTY = 0.2; // 过拟合惩罚：OOS IC - 惩罚 × (训练IC - OOS IC)

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CALIB_FILE = path.join(DATA_DIR, 'ml_calibration.json');

// ---------- 基础统计 ----------
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sigmoid(x) { return 1 / (1 + Math.exp(-clamp(x, -30, 30))); }
function medianValue(a) {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  const mid = Math.floor(b.length / 2);
  return b.length % 2 ? b[mid] : (b[mid - 1] + b[mid]) / 2;
}
function pctRank(value, arr) {
  if (!arr.length) return 0.5;
  const below = arr.filter((v) => v < value).length;
  const equal = arr.filter((v) => v === value).length;
  return (below + 0.5 * equal) / arr.length;
}
function sma(a, p) {
  if (!a.length) return 0;
  const s = a.slice(-p);
  return mean(s);
}
function rankArray(a) {
  const n = a.length;
  const idx = a.map((v, i) => ({ v, i })).sort((x, y) => (x.v - y.v) || (x.i - y.i));
  const r = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && idx[j].v === idx[i].v) j++;
    const avg = (i + j - 1) / 2;
    for (let k = i; k < j; k++) r[idx[k].i] = avg;
    i = j;
  }
  return r;
}
function spearman(a, b) {
  if (a.length < 2) return 0;
  const ra = rankArray(a), rb = rankArray(b);
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}
function autocorr(a, lag = 1) {
  const n = a.length - lag;
  if (n < 2) return 0;
  const x = a.slice(0, n), y = a.slice(lag);
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}
function skewness(a) {
  if (a.length < 3) return 0;
  const m = mean(a), s = std(a);
  if (!s) return 0;
  return mean(a.map((v) => ((v - m) / s) ** 3));
}

// ---------- 因子定义 ----------
const FEATURES = [
  'ret5', 'ret10', 'ret20', 'ret60',
  'vol5', 'vol20', 'volRatio',
  'dd20', 'dd60',
  'maDev5', 'maDev20', 'maAlign',
  'rsi', 'autocorr1', 'skew10',
  'navPct', 'downVol', 'upRatio20', 'ensemble',
];

function featuresAt(closes, t) {
  const slice = closes.slice(0, t + 1);
  const n = slice.length;
  if (n < 25) return null;
  const ret = (w) => (n > w ? slice[n - 1] / slice[n - 1 - w] - 1 : 0);
  const daily = [];
  for (let i = 1; i < n; i++) daily.push(slice[i] / slice[i - 1] - 1);
  const vol = (w) => std(daily.slice(-w));
  const vol5 = vol(5), vol20 = vol(20);
  const dd = (w) => {
    let peak = -Infinity, mdd = 0;
    for (const p of slice.slice(-w)) {
      peak = Math.max(peak, p);
      mdd = Math.min(mdd, p / peak - 1);
    }
    return mdd;
  };
  const maDev = (w) => (sma(slice, w) > 0 ? slice[n - 1] / sma(slice, w) - 1 : 0);
  const ma5 = sma(slice, 5), ma10 = sma(slice, 10), ma20 = sma(slice, 20);
  const maAlign = ma5 > ma10 && ma10 > ma20 ? 1 : ma5 < ma10 && ma10 < ma20 ? -1 : 0;
  const navPct = pctRank(slice[n - 1], slice.slice(-126));
  const downVol = std(daily.slice(-20).filter((r) => r < 0));
  const upRatio20 = daily.slice(-20).filter((r) => r > 0).length / Math.max(1, daily.slice(-20).length);
  let gains = 0, losses = 0;
  for (const r of daily.slice(-14)) { if (r > 0) gains += r; else losses -= r; }
  const rsi = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
  let ens = 0;
  try { ens = ensembleVote(slice).signal || 0; } catch (e) { ens = 0; }
  return {
    ret5: ret(5), ret10: ret(10), ret20: ret(20), ret60: ret(60),
    vol5, vol20, volRatio: vol20 > 0 ? vol5 / vol20 : 1,
    dd20: dd(20), dd60: dd(60),
    maDev5: maDev(5), maDev20: maDev(20), maAlign,
    rsi: rsi / 100, autocorr1: autocorr(daily.slice(-20), 1), skew10: skewness(daily.slice(-20)),
    navPct, downVol, upRatio20, ensemble: ens,
  };
}

// ---------- 面板构建：每时点截面 z-score 特征与目标 ----------
function buildPanel(closesByCode, codes, opts = {}) {
  const { horizon = 5, minTrain = 60 } = opts;
  const N = Math.min(...codes.map((c) => (closesByCode[c] || []).length));
  if (N < minTrain + horizon + 2) return null;
  const raw = [];
  for (let t = minTrain; t < N; t++) {
    const row = [];
    for (const code of codes) {
      const feat = featuresAt(closesByCode[code], t);
      if (!feat) continue;
      row.push({ code, feat, fwd: closesByCode[code][t + horizon] / closesByCode[code][t] - 1 });
    }
    if (row.length >= 2) raw.push({ t, row });
  }
  const records = [];
  const fwdVals = [];
  for (const { t, row } of raw) {
    const z = {};
    for (const f of FEATURES) {
      const vals = row.map((r) => r.feat[f]);
      const m = mean(vals), s = std(vals) || 1e-9;
      z[f] = { m, s };
    }
    const fwds = row.map((r) => r.fwd);
    const fm = mean(fwds), fs = std(fwds) || 1e-9;
    for (const r of row) {
      const features = FEATURES.map((f) => (r.feat[f] - z[f].m) / z[f].s);
      records.push({ t, code: r.code, features, label: (r.fwd - fm) / fs, fwd: r.fwd });
      fwdVals.push(r.fwd);
    }
  }
  return { records, featureNames: FEATURES, horizon, N, forwardStd: std(fwdVals) || 1e-9 };
}

// ---------- 线性模型：闭式岭回归 + 高斯消元 ----------
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

function predictRidge(w, row) {
  let s = w[0];
  for (let i = 0; i < row.length; i++) s += w[i + 1] * row[i];
  return s;
}

// ---------- 样本外评估：秩相关 IC / TopK 命中率 / TopK 相对收益 ----------
function evaluate(preds, topK = 3) {
  if (!preds || !preds.length) return null;
  const byT = {};
  for (const p of preds) (byT[p.t] || (byT[p.t] = [])).push(p);
  let icSum = 0, nT = 0, hit = 0, hitN = 0, topRetSum = 0, allRetSum = 0;
  for (const t of Object.keys(byT)) {
    const arr = byT[t];
    if (arr.length < 2) continue;
    const median = medianValue(arr.map((p) => p.label));
    const top = [...arr].sort((a, b) => b.pred - a.pred).slice(0, Math.min(topK, arr.length));
    icSum += spearman(arr.map((p) => p.pred), arr.map((p) => p.label));
    nT++;
    hitN += top.length;
    hit += top.filter((p) => p.label > median).length;
    topRetSum += mean(top.map((p) => p.label));
    allRetSum += mean(arr.map((p) => p.label));
  }
  if (!nT) return null;
  return {
    ic: icSum / nT,
    hitRate: hitN ? hit / hitN : 0,
    topKReturn: topRetSum / nT,
    allReturn: allRetSum / nT,
    nT,
    nSamples: preds.length,
  };
}

// ---------- 主入口：walk-forward 校准 + 自我迭代 ----------
function calibrateWalkForward(closesByCode, codes, opts = {}) {
  const {
    start = 90, foldStep = 20, embargo = 5, holdout = 60, topK = 3,
    horizons = [3, 5, 10], lambdas = [0.1, 1, 10], minSamples = 80,
  } = opts;
  if (!closesByCode || !codes || codes.length < 2) return null;
  const panels = {};
  for (const h of horizons) {
    const p = buildPanel(closesByCode, codes, { horizon: h, minTrain: start });
    if (p) panels[h] = p;
  }
  if (!Object.keys(panels).length) return null;
  const N = Math.min(...codes.map((c) => (closesByCode[c] || []).length));
  if (N < start + holdout + 30) return null;

  const candidates = [];
  for (const h of horizons) for (const l of lambdas) {
    if (panels[h]) candidates.push({ horizon: h, lambda: l });
  }
  const candKey = (c) => `${c.horizon}|${c.lambda}`;
  const candHist = new Map();

  const folds = [];
  let baselineMomIC = 0, baselineMomHit = 0, baselineEnsIC = 0, baselineEnsHit = 0, baselinePltrIC = 0, baselinePltrHit = 0, baselinePltrDeg = 0, baselineAseIC = 0, baselineAseHit = 0, baselineAseDeg = 0, baselineN = 0;
  const aseConfigScores = new Map();
  for (let cut = start; cut + embargo + foldStep <= N - holdout; cut += foldStep) {
    const testA = cut + embargo;
    const testB = Math.min(cut + embargo + foldStep, N - holdout);
    // 元选择：用历史折的样本外 IC 选本轮参数，本折数据不参与选择
    let best = candidates[0], bestObj = -Infinity;
    for (const c of candidates) {
      const h = candHist.get(candKey(c));
      const obj = h && h.count ? h.icSum / h.count : 0;
      if (obj > bestObj) { bestObj = obj; best = c; }
    }
    const panel = panels[best.horizon];
    const train = panel.records.filter((r) => r.t + panel.horizon <= cut - embargo);
    const test = panel.records.filter((r) => r.t >= testA && r.t < testB && r.t + panel.horizon < N);
    if (train.length < minSamples || test.length < 2) continue;
    const model = trainRidge(train.map((r) => r.features), train.map((r) => r.label), best.lambda);
    const preds = test.map((r) => ({ t: r.t, code: r.code, pred: predictRidge(model, r.features), label: r.label }));
    const ev = evaluate(preds, topK);
    if (!ev) continue;
    const momIdx = FEATURES.indexOf('ret20');
    const ensIdx = FEATURES.indexOf('ensemble');
    const momEv = evaluate(test.map((r) => ({ t: r.t, code: r.code, pred: r.features[momIdx], label: r.label })), topK);
    const ensEv = evaluate(test.map((r) => ({ t: r.t, code: r.code, pred: r.features[ensIdx], label: r.label })), topK);
    const pltrW = trainRankingBoost(train.map((r) => r.features), train.map((r) => r.label), train.map((r) => r.t), { epochs: 15, lr: 0.05, lambda: 0.01, margin: 0.05, maxPairsPerT: 30 });
    const pltrEv = pltrW ? evaluate(test.map((r) => ({ t: r.t, code: r.code, pred: predictRanking(pltrW, r.features), label: r.label })), topK) : null;
    const pltrTrainEv = pltrW ? evaluate(train.map((r) => ({ t: r.t, code: r.code, pred: predictRanking(pltrW, r.features), label: r.label })), topK) : null;
    const pltrDeg = pltrEv && pltrTrainEv ? pltrTrainEv.ic - pltrEv.ic : null;
    if (momEv) { baselineMomIC += momEv.ic; baselineMomHit += momEv.hitRate; baselineN++; }
    if (ensEv) { baselineEnsIC += ensEv.ic; baselineEnsHit += ensEv.hitRate; }
    if (pltrEv) { baselinePltrIC += pltrEv.ic; baselinePltrHit += pltrEv.hitRate; }
    if (pltrDeg != null) baselinePltrDeg += pltrDeg;
    const aseConfigs = adaptiveEnsembleConfigs();
    let aseBest = null, aseBestObj = -Infinity;
    for (const cfg of aseConfigs) {
      const aseModel = trainAdaptiveEnsemble(train.map((r) => r.features), train.map((r) => r.label), cfg);
      const aseTest = aseModel ? evaluate(test.map((r) => ({ t: r.t, code: r.code, pred: predictAdaptiveEnsemble(aseModel, r.features), label: r.label })), topK) : null;
      const aseTrain = aseModel ? evaluate(train.map((r) => ({ t: r.t, code: r.code, pred: predictAdaptiveEnsemble(aseModel, r.features), label: r.label })), topK) : null;
      if (!aseTest) continue;
      const aseObj = aseTest.ic - ASE_REG_PENALTY * Math.max(0, (aseTrain ? aseTrain.ic : 0) - aseTest.ic);
      const key = JSON.stringify(cfg);
      const sc = aseConfigScores.get(key) || { sum: 0, count: 0 };
      sc.sum += aseObj; sc.count++;
      aseConfigScores.set(key, sc);
      if (aseObj > aseBestObj) { aseBestObj = aseObj; aseBest = { cfg, test: aseTest, train: aseTrain }; }
    }
    if (aseBest) {
      baselineAseIC += aseBest.test.ic;
      baselineAseHit += aseBest.test.hitRate;
      baselineAseDeg += (aseBest.train ? aseBest.train.ic : 0) - aseBest.test.ic;
    }
    const trainPreds = train.map((r) => ({ t: r.t, code: r.code, pred: predictRidge(model, r.features), label: r.label }));
    const trainEv = evaluate(trainPreds, topK) || { ic: 0 };
    const degradation = trainEv.ic - ev.ic;
    folds.push({
      i: folds.length + 1,
      params: { ...best },
      trainIC: +trainEv.ic.toFixed(4),
      testIC: +ev.ic.toFixed(4),
      hitRate: +ev.hitRate.toFixed(4),
      pltrTestIC: +(pltrEv ? pltrEv.ic : -1).toFixed(4),
      pltrHitRate: +(pltrEv ? pltrEv.hitRate : 0).toFixed(4),
      pltrDegradation: +(pltrDeg != null ? pltrDeg : -1).toFixed(4),
      aseTestIC: +(aseBest ? aseBest.test.ic : -1).toFixed(4),
      aseHitRate: +(aseBest ? aseBest.test.hitRate : 0).toFixed(4),
      aseDegradation: +(aseBest ? (aseBest.train ? aseBest.train.ic : 0) - aseBest.test.ic : -1).toFixed(4),
      topKReturn: +ev.topKReturn.toFixed(4),
      degradation: +degradation.toFixed(4),
      nSamples: ev.nSamples,
    });
    const key = candKey(best);
    const h = candHist.get(key) || { icSum: 0, count: 0 };
    h.icSum += ev.ic; h.count++;
    candHist.set(key, h);
  }
  if (!folds.length) return null;

  // 最终参数：全折平均 OOS IC 最高的候选
  let finalCand = candidates[0], bestAvg = -Infinity;
  for (const c of candidates) {
    const h = candHist.get(candKey(c));
    if (h && h.count && h.icSum / h.count > bestAvg) {
      bestAvg = h.icSum / h.count;
      finalCand = c;
    }
  }
  const avgIC = mean(folds.map((f) => f.testIC));
  const avgHit = mean(folds.map((f) => f.hitRate));
  const momAvgIC = baselineN ? baselineMomIC / baselineN : 0;
  const momAvgHit = baselineN ? baselineMomHit / baselineN : 0;
  const ensAvgIC = baselineN ? baselineEnsIC / baselineN : 0;
  const ensAvgHit = baselineN ? baselineEnsHit / baselineN : 0;
  const pltrAvgIC = baselineN ? baselinePltrIC / baselineN : -1;
  const pltrAvgHit = baselineN ? baselinePltrHit / baselineN : 0;
  const pltrAvgDeg = baselineN ? baselinePltrDeg / baselineN : 0;
  const aseAvgIC = baselineN ? baselineAseIC / baselineN : -1;
  const aseAvgHit = baselineN ? baselineAseHit / baselineN : 0;
  const aseAvgDeg = baselineN ? baselineAseDeg / baselineN : 0;
  const ridgeAvgDeg = mean(folds.map((f) => f.trainIC)) - avgIC;
  const ridgeObj = avgIC - ASE_REG_PENALTY * Math.max(0, ridgeAvgDeg);
  const pltrObj = pltrAvgIC - ASE_REG_PENALTY * Math.max(0, pltrAvgDeg);
  const aseObj = aseAvgIC - ASE_REG_PENALTY * Math.max(0, aseAvgDeg);
  let finalAlgorithm = 'ridge', finalIC = avgIC, finalHit = avgHit, finalDeg = ridgeAvgDeg;
  if (pltrObj > ridgeObj && pltrObj >= aseObj) { finalAlgorithm = 'ranking_boost'; finalIC = pltrAvgIC; finalHit = pltrAvgHit; finalDeg = pltrAvgDeg; }
  if (aseObj > ridgeObj && aseObj > pltrObj) { finalAlgorithm = 'adaptive_ensemble'; finalIC = aseAvgIC; finalHit = aseAvgHit; finalDeg = aseAvgDeg; }

  // 冻结 holdout：最终证据
  const hp = panels[finalCand.horizon];
  const hTrain = hp.records.filter((r) => r.t + hp.horizon <= N - holdout - embargo);
  const hTest = hp.records.filter((r) => r.t >= N - holdout && r.t + hp.horizon < N);
  const hModel = hTrain.length >= minSamples ? trainRidge(hTrain.map((r) => r.features), hTrain.map((r) => r.label), finalCand.lambda) : null;
  const holdoutEval = hModel && hTest.length >= 2
    ? evaluate(hTest.map((r) => ({ t: r.t, code: r.code, pred: predictRidge(hModel, r.features), label: r.label })), topK)
    : null;

  // 当前实盘预测：全量训练 + 最新截面（必须与训练一致做截面标准化）
  const all = hp.records.filter((r) => r.t + hp.horizon < N);
  const finalModel = trainRidge(all.map((r) => r.features), all.map((r) => r.label), finalCand.lambda);
  const finalPltrW = trainRankingBoost(all.map((r) => r.features), all.map((r) => r.label), all.map((r) => r.t), { epochs: 15, lr: 0.05, lambda: 0.01, margin: 0.05, maxPairsPerT: 30 });
  let finalAseConfig = null, bestAseScore = -Infinity;
  for (const [key, sc] of aseConfigScores) {
    if (sc.count && sc.sum / sc.count > bestAseScore) { bestAseScore = sc.sum / sc.count; finalAseConfig = JSON.parse(key); }
  }
  const finalAseModel = finalAseConfig ? trainAdaptiveEnsemble(all.map((r) => r.features), all.map((r) => r.label), finalAseConfig) : null;
  const lastT = N - 1;
  const currentRows = [];
  const currentRaw = [];
  for (const code of codes) {
    const feat = featuresAt(closesByCode[code], lastT);
    if (!feat) continue;
    currentRaw.push({ code, feat });
  }
  if (currentRaw.length >= 2) {
    const z = {};
    for (const f of FEATURES) {
      const vals = currentRaw.map((r) => r.feat[f]);
      const m = mean(vals), s = std(vals) || 1e-9;
      z[f] = { m, s };
    }
    for (const { code, feat } of currentRaw) {
      const standardized = FEATURES.map((f) => (feat[f] - z[f].m) / z[f].s);
      const ridgeScore = predictRidge(finalModel, standardized);
      const pltrScore = finalPltrW ? predictRanking(finalPltrW, standardized) : ridgeScore;
      const aseScore = finalAseModel ? predictAdaptiveEnsemble(finalAseModel, standardized) : ridgeScore;
      const useScoreRaw = finalAlgorithm === 'ranking_boost' ? pltrScore : finalAlgorithm === 'adaptive_ensemble' ? aseScore : ridgeScore;
      const useScore = clamp(useScoreRaw, -3, 3);
      const momIdx = FEATURES.indexOf('ret20');
      const ensIdx = FEATURES.indexOf('ensemble');
      currentRows.push({
        code,
        score: +useScoreRaw.toFixed(4),
        ridgeScore: +ridgeScore.toFixed(4),
        pltrScore: +pltrScore.toFixed(4),
        aseScore: +aseScore.toFixed(4),
        prob: +sigmoid(useScore).toFixed(4),
        direction: useScore > 0.1 ? 'UP' : useScore < -0.1 ? 'DOWN' : 'FLAT',
        predictedReturn5d: +(useScore * hp.forwardStd * 100).toFixed(2),
        momentumScore: +(standardized[momIdx] || 0).toFixed(4),
        ensembleScore: +(standardized[ensIdx] || 0).toFixed(4),
        factors: standardized.map((v) => +v.toFixed(3)),
      });
    }
  }
  currentRows.sort((a, b) => b.score - a.score);
  currentRows.forEach((r, i) => (r.rank = i + 1));
  const confidence = Math.round(clamp(50 + 45 * finalIC + 10 * (finalHit - 0.5) * 2, 1, 99));
  currentRows.forEach((r) => (r.confidence = confidence));

  return {
    generatedAt: new Date().toISOString(),
    nDays: N,
    nCodes: codes.length,
    nSamples: all.length,
    topK,
    finalParams: { ...finalCand, algorithm: finalAlgorithm },
    avgTestIC: +finalIC.toFixed(4),
    avgHitRate: +finalHit.toFixed(4),
    degradation: +finalDeg.toFixed(4),
    selection: {
      ridge: +ridgeObj.toFixed(4),
      ranking_boost: +pltrObj.toFixed(4),
      adaptive_ensemble: +aseObj.toFixed(4),
      regPenalty: ASE_REG_PENALTY,
    },
    algorithms: {
      ridge: { avgTestIC: +avgIC.toFixed(4), avgHitRate: +avgHit.toFixed(4) },
      pltr: { avgTestIC: +pltrAvgIC.toFixed(4), avgHitRate: +pltrAvgHit.toFixed(4) },
      adaptive_ensemble: { avgTestIC: +aseAvgIC.toFixed(4), avgHitRate: +aseAvgHit.toFixed(4) },
    },
    baseline: {
      momentum: { avgTestIC: +momAvgIC.toFixed(4), avgHitRate: +momAvgHit.toFixed(4) },
      ensemble: { avgTestIC: +ensAvgIC.toFixed(4), avgHitRate: +ensAvgHit.toFixed(4) },
      pltr: { avgTestIC: +pltrAvgIC.toFixed(4), avgHitRate: +pltrAvgHit.toFixed(4) },
      adaptive_ensemble: { avgTestIC: +aseAvgIC.toFixed(4), avgHitRate: +aseAvgHit.toFixed(4) },
      mlVsMomentumIC: +(avgIC - momAvgIC).toFixed(4),
      pltrVsMomentumIC: +(pltrAvgIC - momAvgIC).toFixed(4),
      aseVsMomentumIC: +(aseAvgIC - momAvgIC).toFixed(4),
    },
    finalAlgorithm,
    confidence,
    folds,
    trajectory: folds.map((f) => ({ i: f.i, params: f.params, testIC: f.testIC, hitRate: f.hitRate })),
    holdout: holdoutEval
      ? {
          params: { ...finalCand },
          ic: +holdoutEval.ic.toFixed(4),
          hitRate: +holdoutEval.hitRate.toFixed(4),
          topKReturn: +holdoutEval.topKReturn.toFixed(4),
          nSamples: holdoutEval.nSamples,
        }
      : null,
    current: currentRows,
    featureNames: FEATURES,
  };
}

// ---------- 持久化 ----------
function ensureDataDir() { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {} }
function saveCalibration(data) {
  ensureDataDir();
  try { fs.writeFileSync(CALIB_FILE, JSON.stringify(data, null, 2)); return true; } catch (e) { return false; }
}
function loadCalibration() {
  try { return JSON.parse(fs.readFileSync(CALIB_FILE, 'utf8')); } catch (e) { return null; }
}

// ---------- CLI：离线/联网校准 ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function genSeries(seed, drift, vol, n) {
  const rng = mulberry32(seed); const out = [1];
  for (let i = 1; i < n; i++) {
    const z = Math.sqrt(-2 * Math.log(rng() + 1e-9)) * Math.cos(2 * Math.PI * rng());
    out.push(out[out.length - 1] * (1 + drift / 252 + (vol / Math.sqrt(252)) * z));
  }
  return out;
}
function syntheticData(n = 400) {
  const codes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  const closesByCode = {};
  codes.forEach((c, i) => { closesByCode[c] = genSeries(1000 + i * 17, 0.08 + (i % 4) * 0.06, 0.22 + (i % 3) * 0.04, n); });
  return { closesByCode, codes };
}

if (require.main === module) {
  (async () => {
    const demo = process.argv.includes('--demo');
    let data;
    if (demo) {
      data = syntheticData();
      console.log('· 离线模式：合成 10 赛道 / 400 天\n');
    } else {
      const fsx = fs.existsSync(path.join(DATA_DIR, 'sector_history.json'));
      if (fsx) {
        try {
          const hist = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sector_history.json'), 'utf8')).hist || {};
          const codes = Object.keys(hist).filter((c) => hist[c] && hist[c].length >= 120);
          const dateSet = new Set();
          for (const c of codes) for (const r of hist[c]) dateSet.add(r.date);
          const commonDates = [...dateSet].sort();
          const closesByCode = {};
          for (const c of codes) {
            const map = {}; for (const r of hist[c]) map[r.date] = r.nav;
            let last = null;
            closesByCode[c] = commonDates.map((d) => { if (map[d] != null) { last = map[d]; return map[d]; } return last; });
            const first = closesByCode[c].find((v) => v != null);
            closesByCode[c] = closesByCode[c].map((v) => (v == null ? first : v));
          }
          data = { closesByCode, codes };
          console.log(`· 实盘模式：${codes.length} 只 / ${commonDates.length} 天\n`);
        } catch (e) {
          console.log('· 历史文件读取失败，退回合成数据\n');
          data = syntheticData();
        }
      } else {
        console.log('· 未发现 data/sector_history.json，请先运行 npm run self:iterate；本次用合成演示\n');
        data = syntheticData();
      }
    }
    const res = calibrateWalkForward(data.closesByCode, data.codes, { holdout: 60 });
    if (!res) { console.log('❌ 数据不足，无法校准'); process.exit(1); }
    saveCalibration(res);
    console.log('✅ ML 校准完成，已写入 data/ml_calibration.json');
    console.log(`   样本: ${res.nDays} 天 / ${res.nCodes} 只 / ${res.nSamples} 条`);
    console.log(`   最终参数: horizon=${res.finalParams.horizon} lambda=${res.finalParams.lambda} topK=${res.topK}`);
    console.log(`   最终算法: ${res.finalAlgorithm === 'ranking_boost' ? 'RankingBoost(成对排序学习)' : res.finalAlgorithm === 'adaptive_ensemble' ? 'Adaptive Random-Subspace Ensemble' : 'Ridge(岭回归)'}`);
    console.log(`   样本外 IC=${res.avgTestIC} 命中率=${res.avgHitRate} 降级=${res.degradation} 置信度=${res.confidence}`);
    if (res.baseline) console.log(`   基线对比: 动量IC=${res.baseline.momentum.avgTestIC}/命中${res.baseline.momentum.avgHitRate} 集成IC=${res.baseline.ensemble.avgTestIC} RankingBoostIC=${res.baseline.pltr.avgTestIC} ASE集成IC=${res.baseline.adaptive_ensemble.avgTestIC} 排序学习-动量Δ=${res.baseline.pltrVsMomentumIC} ASE-动量Δ=${res.baseline.aseVsMomentumIC}`);
    if (res.holdout) console.log(`   冻结holdout: IC=${res.holdout.ic} 命中率=${res.holdout.hitRate} TopK相对收益=${res.holdout.topKReturn}`);
    if (res.selection) console.log(`   稳健目标(IC-${res.selection.regPenalty}×退化): ridge=${res.selection.ridge} ranking=${res.selection.ranking_boost} ase=${res.selection.adaptive_ensemble}`);
    console.log(`   Top5: ${res.current.slice(0, 5).map((r) => `${r.code}(${r.score})`).join(', ')}`);
  })();
}

module.exports = {
  buildPanel, trainRidge, predictRidge, evaluate, calibrateWalkForward,
  saveCalibration, loadCalibration, CALIB_FILE, FEATURES,
  mean, std, spearman, rankArray,
};
