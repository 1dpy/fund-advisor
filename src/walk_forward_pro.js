/**
 * 严格的 Walk-Forward 验证引擎 (防前视偏差 · 过拟合检测)
 * ---------------------------------------------------------------
 * 现有 backtest_model_compare.js 在每次再平衡点用"前 60 日窗口"拟合 MPT
 * 权重, 已是 walk-forward。本模块把该思想升级为**可审计、可量化过拟合**的
 * 严谨版本 (参考 López de Prado《Advances in Financial Machine Learning》
 * 的 walk-forward + Purged K-fold 思想):
 *
 *   1) 折叠式验证: 把历史切成 K 折。每折用"之前的训练窗"拟合权重,
 *      在"之后的测试窗"真样本外持有 (测试窗内**不重拟合**), 杜绝用未来
 *      数据指导过去。
 *   2) 过拟合退化度 (degradation): 记录每折 训练窗(in-sample) 与
 *      测试窗(out-of-sample) 的夏普/收益差。差为正=可能过拟合, 应警惕。
 *   3)  embargo(禁运): 测试窗前留少量空白, 防止训练窗尾部信息与测试窗
 *      头部重叠导致信息泄漏 (金融 ML 标准做法)。
 *
 * 同时提供 makeFactorFitFn: 把 factor_library 的多因子打分封装成"只用
 * 截至 t 的数据"的权重函数, 直接喂给回测器, 保证零前视。
 *
 * 用法:
 *   const wf = require('./walk_forward_pro');
 *   const fitFn = wf.makeFactorFitFn(closesByCode, { weights, topK });
 *   const folds = wf.walkForwardFolds({ closesByCode, codes, fitFn, ... });
 */

const fl = require('./factor_library');

// ---------- 本地小工具 (避免与回测脚本耦合) ----------
function stats(curve) {
  if (curve.length < 2) return { total: 0, sharpe: 0, mdd: 0, oos: 0 };
  const rets = []; for (let i = 1; i < curve.length; i++) rets.push(curve[i] / curve[i - 1] - 1);
  const m = mean(rets), sd = stdev(rets);
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(252) : 0;
  let peak = curve[0], mdd = 0;
  for (const v of curve) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
  const oosN = Math.min(20, curve.length - 1);
  const oos = curve.length > oosN ? curve[curve.length - 1] / curve[curve.length - 1 - oosN] - 1 : 0;
  return { total: +(curve[curve.length - 1] - 1) * 100, sharpe: +sharpe.toFixed(2), mdd: +(mdd * 100).toFixed(2), oos: +(oos * 100).toFixed(2) };
}
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function stdev(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); }

// 用权重 w 在 closesByCode 上从索引 a 到 b(不含) 推进组合净值
//   returns 每日净值序列 (首值=startNav)
function simulate(closesByCode, codes, w, a, b, startNav = 1) {
  let nav = startNav; const curve = [];
  if (!w || w === 'CASH') { for (let t = a; t < b; t++) curve.push(nav); return curve; }
  for (let t = a; t < b; t++) {
    let r = 0;
    for (const c of codes) r += (w[c] || 0) * (closesByCode[c][t] / closesByCode[c][t - 1] - 1);
    nav *= 1 + r; curve.push(nav);
  }
  return curve;
}

// ============================================================
// 把 factor_library 封装成"截至 t 才可见"的权重函数 (零前视)
//   closesByCode: 全量对齐净值; opts: { weights, topK, sentiment, news }
// 返回 fn(t) -> { code: w } | 'CASH'
// ============================================================
function makeFactorFitFn(closesByCode, opts = {}) {
  const { weights = { momentum: 0.5, valuation: 0.3, sentiment: 0.2 }, topK = 4, sentiment = null, news = null } = opts;
  return function fit(t) {
    const codes = Object.keys(closesByCode);
    const win = {};
    for (const c of codes) win[c] = closesByCode[c].slice(0, t + 1); // 仅用截至 t 的数据
    const table = fl.computeAllFactors(codes, win, { sentiment, news });
    const z = fl.zscoreUniverse(table);
    return fl.factorWeights(z, weights, topK);
  };
}

// ============================================================
// 折叠式 walk-forward 验证 (核心: 量化过拟合)
//   closesByCode: { code: number[] } 全量对齐
//   fitFn: (t) => weights | 'CASH'  (只应看 <= t 的数据)
//   opts: { start=60, trainMin=60, foldStep=20, embargo=5, costApply }
//     costApply(prevW, newW, nav, holdDays) -> 成本 (可选)
// 返回 { folds:[{i,trainPeriod,testPeriod,trainSharpe,testSharpe,
//                 trainRet,testRet,degradation}], avgTestSharpe, avgDegradation }
// ============================================================
function walkForwardFolds({ closesByCode, codes, fitFn, opts = {} }) {
  const { start = 60, trainMin = 60, foldStep = 20, embargo = 5, costApply = null } = opts;
  const N = codes.length ? closesByCode[codes[0]].length : 0;
  if (N < start + trainMin + foldStep) return null;

  const folds = [];
  // 折叠边界: 训练窗=[0, cut); 测试窗=[cut+embargo, cut+embargo+foldStep)
  for (let cut = start; cut + embargo + foldStep <= N; cut += foldStep) {
    const testA = cut + embargo;
    const testB = Math.min(testA + foldStep, N);
    // 训练窗 in-sample 曲线: 用 fitFn 在训练窗末尾拟合一次, 持有整个训练窗?
    // 简化且稳健: trainSharpe 用"训练窗内按 fitFn 滚动再平衡"的表现;
    // 但为聚焦 OOS, 这里 trainRet 取 fitFn(cut-1) 权重在训练窗末段的样本内表现。
    const wTrain = fitFn(cut - 1);
    const trainCurve = simulate(closesByCode, codes, wTrain, Math.max(start, cut - foldStep), cut, 1);
    const trainSt = stats(trainCurve);

    // 测试窗: 用训练窗拟合的权重**直接持有**(真 OOS, 不重拟合)
    const wTest = fitFn(cut - 1);
    let testCurve = simulate(closesByCode, codes, wTest, testA, testB, 1);
    let testSt = stats(testCurve);

    // 若提供成本模型, 在换仓点扣一次 (训练->测试 切换)
    if (costApply && wTest && wTest !== 'CASH') {
      const c = costApply(1, wTrain && wTrain !== 'CASH' ? wTrain : {}, wTest, foldStep);
      // 成本影响整个测试窗净值
      testCurve = testCurve.map((v) => v * (1 - c));
      testSt = stats(testCurve);
    }

    folds.push({
      i: folds.length + 1,
      trainPeriod: `${testA - foldStep}~${cut}`,
      testPeriod: `${testA}~${testB}`,
      trainSharpe: +trainSt.sharpe.toFixed(2),
      testSharpe: +testSt.sharpe.toFixed(2),
      trainRet: +(trainSt.total * 100).toFixed(2),
      testRet: +(testSt.total * 100).toFixed(2),
      degradation: +(trainSt.sharpe - testSt.sharpe).toFixed(2), // >0 可能过拟合
    });
  }

  if (!folds.length) return null;
  const avgTestSharpe = mean(folds.map((f) => f.testSharpe));
  const avgDegradation = mean(folds.map((f) => f.degradation));
  return {
    folds,
    avgTestSharpe: +avgTestSharpe.toFixed(2),
    avgDegradation: +avgDegradation.toFixed(2),
    // 过拟合判定: 平均退化度显著为正 → 警惕
    overfitWarning: avgDegradation > 0.3,
  };
}

// ============================================================
// 全周期 walk-forward 回测 (造权益曲线, 每次再平衡重拟合, 含 embargo)
//   用于生成因子模型的最终回测曲线 (供报告 SVG)
// ============================================================
function walkForwardBacktest({ closesByCode, codes, fitFn, opts = {} }) {
  const { start = 60, rebal = 5, embargo = 0, costApply = null } = opts;
  const N = codes.length ? closesByCode[codes[0]].length : 0;
  let nav = 1, w = null; const curve = [];
  for (let t = start; t < N; t++) {
    let r = 0;
    if (w && w !== 'CASH') for (const c of codes) r += (w[c] || 0) * (closesByCode[c][t] / closesByCode[c][t - 1] - 1);
    nav *= 1 + r; curve.push(nav);
    if ((t - start) % rebal === 0 && t + rebal < N) {
      const target = fitFn(t); // 只用 <= t 数据
      if (target && target !== 'CASH') {
        if (w && w !== 'CASH' && costApply) nav -= costApply(w, target, nav, rebal);
        else if (costApply) nav -= costApply({}, target, nav, rebal);
        w = target;
      } else if (w && w !== 'CASH') {
        if (costApply) nav -= costApply(w, {}, nav, rebal);
        w = 'CASH';
      }
    }
  }
  return { curve, stats: stats(curve) };
}

// ============================================================
// 阈值再平衡 (Threshold / Tolerance-band Rebalancing)
//   仅在"当前持仓权重相对目标偏离超过 ±threshold"时才调仓, 否则持有不动。
//   目的: 减少无效换手, 直接降低交易成本拖累 (参考 Vanguard/晨星再平衡研究)。
//   threshold: 单只权重最大允许偏离 (如 0.05 = 5%); 也支持组合总偏离(sum abs drift)
//   opts.driftMode: 'max'(任一只超阈) | 'sum'(总偏离超阈), 默认 'max'
//   返回 { curve, stats, trades, costTotal, rebalances } (rebalances=实际调仓次数)
// ============================================================
function thresholdBacktest({ closesByCode, codes, fitFn, opts = {} }) {
  const { start = 60, rebal = 5, threshold = 0.05, driftMode = 'max', costApply = null, checkEvery = 1 } = opts;
  const N = codes.length ? closesByCode[codes[0]].length : 0;
  let nav = 1, w = null, targetW = null;
  let trades = 0, costTotal = 0, rebalances = 0;
  const curve = [];

  // 计算当前实际权重 (考虑期间净值变动): 用组合中各资产累计收益反推比例
  function actualWeights(prevW, t) {
    if (!prevW || prevW === 'CASH') return null;
    const contrib = {};
    let tot = 0;
    for (const c of codes) {
      const r = closesByCode[c][t] / closesByCode[c][t - 1] - 1;
      const v = (prevW[c] || 0) * (1 + r);
      contrib[c] = v; tot += v;
    }
    if (tot <= 0) return null;
    const out = {}; for (const c of codes) out[c] = contrib[c] / tot;
    return out;
  }
  function driftFrom(aw, tw) {
    if (!aw || !tw) return Infinity;
    let mx = 0, sum = 0;
    for (const c of codes) { const d = Math.abs((aw[c] || 0) - (tw[c] || 0)); mx = Math.max(mx, d); sum += d; }
    return driftMode === 'sum' ? sum : mx;
  }

  for (let t = start; t < N; t++) {
    let r = 0;
    if (w && w !== 'CASH') for (const c of codes) r += (w[c] || 0) * (closesByCode[c][t] / closesByCode[c][t - 1] - 1);
    nav *= 1 + r; curve.push(nav);

    const isCheckpoint = (t - start) % rebal === 0 && t + rebal < N;
    const isPeriodic = isCheckpoint && (t - start) % (rebal * Math.max(1, Math.round(20 / rebal))) === 0;
    // 定期点刷新目标权重 (walk-forward 重拟合)
    if (isCheckpoint) targetW = fitFn(t);
    // 每个 checkEvery 评估: 实际权重偏离目标是否超阈
    if (targetW && targetW !== 'CASH' && (t - start) % checkEvery === 0) {
      const aw = actualWeights(w, t);
      const drift = driftFrom(aw, targetW);
      if (drift > threshold) {
        if (costApply) { const c = costApply(nav, w && w !== 'CASH' ? w : {}, targetW, rebal); nav -= c; costTotal += c; }
        w = targetW; trades++; rebalances++;
      }
    }
  }
  return { curve, stats: stats(curve), trades, costTotal: +costTotal.toFixed(4), rebalances };
}

module.exports = { makeFactorFitFn, walkForwardFolds, walkForwardBacktest, thresholdBacktest, stats, simulate };
