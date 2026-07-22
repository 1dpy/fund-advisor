/**
 * 量化实验室 · 计算核心 (Quant Lab Core)
 * ---------------------------------------------------------------
 * 把 backtest_self_iterate.js 中的"纯计算逻辑"抽取为可复用模块,
 * 供 CLI 报告 (backtest_self_iterate.js) 与 本地仪表盘 (dashboard_server.js)
 * 共用, 避免逻辑漂移。
 *
 * 提供:
 *   prepData({ days, holdout, forceDemo })       拉取/对齐净值 (联网优先, 合成兜底)
 *   runStrategies(closesByCode, codes, opts)     7 策略回测对比 (返回曲线)
 *   runSelfIterate(closesByCode, codes, opts)    自我迭代元优化 (含 holdout 曲线)
 *   fetchFactorData({ days, forceDemo })         因子库快照 (排名 + z-score 矩阵)
 *   stats(curve) / applyCost(...)                共用工具
 *
 * 设计: 全部为纯函数/可控异步; 不写文件、不打印; 由调用方决定展示与持久化。
 */

const { PREFERRED_SECTORS } = require('./config');
const { fetchNavHistory } = require('./ml_sector_selector');
const { tradeCost } = require('./cost_model');
const { markowitz, riskParity, riskParityEWMA } = require('./portfolio_optimizer');
const wf = require('./walk_forward_pro');
const fl = require('./factor_library');
const st = require('./self_tuning');

// ---------- 通用工具 ----------
function stats(curve) {
  if (curve.length < 2) return { total: 0, sharpe: 0, mdd: 0, oos: 0 };
  const rets = []; for (let i = 1; i < curve.length; i++) rets.push(curve[i] / curve[i - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, v) => s + (v - m) ** 2, 0) / rets.length);
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(252) : 0;
  let peak = curve[0], mdd = 0; curve.forEach((v) => { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); });
  const oosN = Math.min(20, curve.length - 1);
  const oos = curve.length > oosN ? curve[curve.length - 1] / curve[curve.length - 1 - oosN] - 1 : 0;
  return { total: +(curve[curve.length - 1] - 1) * 100, sharpe: +sharpe.toFixed(2), mdd: +(mdd * 100).toFixed(2), oos: +(oos * 100).toFixed(2) };
}
function applyCost(nav, wOld, wNew, holdDays) {
  const o = (wOld && typeof wOld === 'object') ? wOld : {};
  const n = (wNew && typeof wNew === 'object') ? wNew : {};
  let cost = 0;
  const all = new Set([...Object.keys(o), ...Object.keys(n)]);
  for (const c of all) {
    const d = (n[c] || 0) - (o[c] || 0);
    const amt = Math.abs(d) * nav;
    if (amt > 1e-9) cost += tradeCost({ buyAmount: d > 0 ? amt : 0, sellAmount: d < 0 ? amt : 0, holdDays }).total;
  }
  return cost;
}
function mulberry32(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (a >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function genSeries(seed, drift, vol, n) {
  const rng = mulberry32(seed); const out = [1];
  for (let i = 1; i < n; i++) { const z = Math.sqrt(-2 * Math.log(rng() + 1e-9)) * Math.cos(2 * Math.PI * rng()); out.push(out[out.length - 1] * (1 + drift / 252 + (vol / Math.sqrt(252)) * z)); }
  return out;
}

// 日期排序: 合成 "D<num>" 需按数字排序, 真实 ISO 字典序即可
function sortDates(dates) {
  return [...dates].sort((a, b) => {
    const ma = a.match(/^D(\d+)$/), mb = b.match(/^D(\d+)$/);
    if (ma && mb) return (+ma[1]) - (+mb[1]);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

// ============================================================
// 数据准备: 拉取净值 → 对齐 → closesByCode
// ============================================================
async function prepData(opts = {}) {
  const { days = 365, forceDemo = false, onStatus = () => {} } = opts;
  const HOLDOUT = opts.holdout || 60;
  let dataMode = 'LIVE';
  const series = {};

  if (!forceDemo) {
    onStatus('正在拉取实盘净值(东方财富)...');
    for (const s of PREFERRED_SECTORS) {
      const navs = await Promise.race([
        fetchNavHistory(s.code, days, true),
        new Promise((res) => setTimeout(() => res([]), 8000)),
      ]).catch(() => []);
      if (navs && navs.length >= 60) series[s.code] = { name: s.name, sector: s.sector, navs };
    }
    if (Object.keys(series).length < 3) { onStatus('实盘数据不足/超时, 降级为合成数据'); dataMode = 'SYNTHETIC'; }
  } else { dataMode = 'SYNTHETIC'; }

  if (dataMode === 'SYNTHETIC') {
    PREFERRED_SECTORS.forEach((s, i) => {
      const navs = genSeries(20260722 + i * 13, 0.10 + (i % 4) * 0.04, 0.22, days + HOLDOUT).map((nav, k) => ({ date: `D${k}`, nav: +nav.toFixed(4) }));
      series[s.code] = { name: s.name, sector: s.sector, navs };
    });
  }

  const codes = Object.keys(series);
  const masterSet = new Set();
  for (const c of codes) series[c].navs.forEach((n) => masterSet.add(n.date));
  const commonDates = sortDates(masterSet);
  const closesByCode = {};
  for (const c of codes) {
    const map = {}; series[c].navs.forEach((n) => (map[n.date] = n.nav));
    let last = null;
    closesByCode[c] = commonDates.map((d) => { if (map[d] != null) { last = map[d]; return map[d]; } return last; });
    let first = closesByCode[c].find((v) => v != null);
    closesByCode[c] = closesByCode[c].map((v) => (v == null ? first : v));
  }
  const N = commonDates.length;
  return { dataMode, closesByCode, codes, commonDates, series, N, HOLDOUT };
}

// ============================================================
// 7 策略回测对比
// ============================================================
function runStrategies(closesByCode, codes, opts = {}) {
  const { start = 60, rebal = 5, window = 60, sentiment = null, news = 0, commonDates = [] } = opts;
  const N = codes.length ? closesByCode[codes[0]].length : 0;
  const equalW = () => { const w = {}; codes.forEach((c) => (w[c] = 1 / codes.length)); return w; };
  const momentumW = (t, k = 2) => {
    const sc = {}; for (const c of codes) { const cl = closesByCode[c].slice(0, t + 1); sc[c] = cl.length >= 21 ? cl[cl.length - 1] / cl[cl.length - 21] - 1 : -999; }
    const ranked = codes.slice().sort((a, b) => sc[b] - sc[a]).filter((c) => sc[c] > 0);
    if (!ranked.length) return 'CASH'; const top = ranked.slice(0, k); const w = {}; top.forEach((c) => (w[c] = 1 / top.length)); return w;
  };
  const factorFit = wf.makeFactorFitFn(closesByCode, { weights: { momentum: 0.5, valuation: 0.3, sentiment: 0.2 }, topK: 4, sentiment, news });
  const mptW = (t, kind) => {
    const from = Math.max(0, t - window); const win = {}; for (const c of codes) win[c] = closesByCode[c].slice(from, t + 1);
    if (win[codes[0]].length < 30) return momentumW(t);
    try {
      if (kind === 'maxSharpe') { const r = markowitz(win, { samples: 2000, maxWeight: 0.25, seed: 7 }); return r.maxSharpe.w; }
      if (kind === 'rpEwma') { const r = riskParityEWMA(win, { maxWeight: 0.25, lambda: 0.94 }); return r.weights; }
      if (kind === 'rp') { const r = riskParity(win, { maxWeight: 0.25 }); return r.weights; }
    } catch (e) { return momentumW(t); }
    return momentumW(t);
  };
  function backtest(weightFn, threshold = null) {
    if (threshold != null) return wf.thresholdBacktest({ closesByCode, codes, fitFn: weightFn, opts: { start, rebal, threshold, costApply: applyCost } });
    let nav = 1, w = null; const curve = []; let trades = 0, costTotal = 0;
    for (let t = start; t < N; t++) {
      let r = 0; if (w && w !== 'CASH') for (const c of codes) r += (w[c] || 0) * (closesByCode[c][t] / closesByCode[c][t - 1] - 1);
      nav *= 1 + r; curve.push(nav);
      if ((t - start) % rebal === 0 && t + rebal < N) {
        const target = weightFn(t);
        if (target && target !== 'CASH') { const c = w && w !== 'CASH' ? applyCost(nav, w, target, rebal) : applyCost(nav, null, target, rebal); nav -= c; costTotal += c; w = target; trades++; }
        else if (w && w !== 'CASH') { const c = applyCost(nav, w, {}, rebal); nav -= c; costTotal += c; w = 'CASH'; trades++; }
      }
    }
    return { curve, stats: stats(curve), trades, costTotal: +costTotal.toFixed(4) };
  }
  const strategies = [
    { key: 'equal', label: '等权分散(固定再平衡)', fn: () => equalW() },
    { key: 'equalThr', label: '等权分散(阈值±5%)', fn: () => equalW(), threshold: 0.05 },
    { key: 'mom2', label: '动量Top2', fn: (t) => momentumW(t, 2) },
    { key: 'factorFixed', label: '因子模型(固定再平衡)', fn: factorFit },
    { key: 'factorThr', label: '因子模型(阈值±5%)', fn: factorFit, threshold: 0.05 },
    { key: 'mpt', label: '马克维茨最大夏普', fn: (t) => mptW(t, 'maxSharpe') },
    { key: 'rpEwma', label: '风险平价(EWMA)', fn: (t) => mptW(t, 'rpEwma') },
    { key: 'rp', label: '风险平价(标准)', fn: (t) => mptW(t, 'rp') },
  ];
  const results = {};
  for (const s of strategies) {
    const r = backtest(s.fn, s.threshold != null ? s.threshold : null);
    results[s.key] = { label: s.label, ...r.stats, trades: r.trades || 0, costTotal: r.costTotal || 0, curve: r.curve, start: commonDates[start] || '', end: commonDates[N - 1] || '' };
  }
  return { results, strategyMeta: strategies.map((s) => ({ key: s.key, label: s.label })), start, rebal, N };
}

// ============================================================
// 自我迭代元优化 (含 holdout 曲线)
// ============================================================
function runSelfIterate(closesByCode, codes, opts = {}) {
  const { start = 60, rebal = 5, foldStep = 20, embargo = 5, holdout = 60, sentiment = null, news = 0 } = opts;
  const si = st.selfIterateWalkForward(closesByCode, codes, { start, rebal, foldStep, embargo, holdout, costApply: applyCost, sentiment, news });
  if (!si) return null;
  const N = codes.length ? closesByCode[codes[0]].length : 0;
  const selfFit = wf.makeFactorFitFn(closesByCode, { weights: { momentum: si.holdout.selfParams.momentum, valuation: si.holdout.selfParams.valuation, sentiment: si.holdout.selfParams.sentiment }, topK: si.holdout.selfParams.topK, sentiment, news });
  const statFit = wf.makeFactorFitFn(closesByCode, { weights: { momentum: 0.5, valuation: 0.3, sentiment: 0.2 }, topK: 4, sentiment, news });
  const selfCurve = wf.walkForwardBacktest({ closesByCode, codes, fitFn: selfFit, opts: { start: N - holdout, rebal, embargo: 0, costApply: applyCost } }).curve;
  const statCurve = wf.walkForwardBacktest({ closesByCode, codes, fitFn: statFit, opts: { start: N - holdout, rebal, embargo: 0, costApply: applyCost } }).curve;
  return { ...si, holdoutCurves: { self: selfCurve, static: statCurve } };
}

// ============================================================
// 因子库快照 (排名 + 截面 z-score 矩阵)
// ============================================================
async function fetchFactorData(opts = {}) {
  const { days = 250, forceDemo = false, sentiment = null, news = 0, onStatus = () => {} } = opts;
  onStatus && onStatus('计算因子...');
  const prep = await prepData({ days, forceDemo, onStatus });
  const { closesByCode, codes, commonDates } = prep;
  const table = fl.computeAllFactors(codes, closesByCode, { sentiment, news });
  const z = fl.zscoreUniverse(table);
  const ranked = fl.compositeScore(z, { momentum: 0.5, valuation: 0.3, sentiment: 0.2 });

  // 展开所有子因子 (按固定顺序) 作为热力图列
  const GROUP_ORDER = ['momentum', 'valuation', 'sentiment'];
  const SUBKEYS = {
    momentum: ['mom1m', 'mom3m', 'mom6m', 'maSlope', 'stReversal'],
    valuation: ['navPercentile', 'discountToMA', 'pullbackMA20'],
    sentiment: ['marketFG', 'newsScore', 'volSpike', 'sentimentCapture'],
  };
  const cols = [];
  for (const g of GROUP_ORDER) for (const k of SUBKEYS[g]) cols.push({ group: g, key: k });

  const universe = ranked.map((r) => {
    const name = (prep.series[r.code] && prep.series[r.code].name) || r.code;
    const factors = {};
    for (const col of cols) factors[col.key] = +(z[r.code][col.group][col.key] || 0).toFixed(3);
    return { code: r.code, name, score: r.score, contrib: r.contrib, factors };
  });
  const matrix = universe.map((u) => cols.map((c) => u.factors[c.key]));
  const rows = universe.map((u) => u.name);

  return {
    mode: prep.dataMode,
    asOf: commonDates[commonDates.length - 1] || 'N/A',
    nDays: commonDates.length,
    universe,
    heatmap: { rows, cols: cols.map((c) => c.key), groups: cols.map((c) => c.group), matrix },
  };
}

module.exports = {
  stats, applyCost, mulberry32, genSeries, sortDates,
  prepData, runStrategies, runSelfIterate, fetchFactorData,
  DEFAULTS: { START: 60, REBAL: 5, WINDOW: 60, DAYS: 365, HOLDOUT: 60 },
};
