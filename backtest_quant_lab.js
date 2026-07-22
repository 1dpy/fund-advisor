/**
 * 量化实验室回测 — P0/P1 增强版综合报告
 * ---------------------------------------------------------------
 * 串联本次升级的全部量化能力, 输出单张 HTML 报告:
 *
 *   P0 因子库     : 多因子(动量/估值/情绪)合成打分 → 因子模型策略
 *   P0 严格 WF    : 折叠式 walk-forward 验证, 量化过拟合退化度(degradation)
 *   P0 敏感性热力图: 因子权重(动量×估值)网格回测 → 收益热力图
 *   P1 阈值再平衡  : 偏离 ±X% 才调仓, 与固定周期再平衡对比成本拖累
 *   P1 EWMA       : 风险平价改用指数加权协方差(对波动率聚集更敏感)
 *
 * 数据源: 东方财富历史净值(同 backtest_model_compare); 若网络/数据不足,
 *         自动降级为确定性合成数据(标注 SYNTHETIC), 保证 CI/离线也能出报告。
 *
 * 用法: node backtest_quant_lab.js            (联网优先, 失败回退合成)
 *       node backtest_quant_lab.js --demo     (强制合成数据, 离线演示)
 */

const fs = require('fs');
const path = require('path');
const { PREFERRED_SECTORS } = require('./src/config');
const { fetchNavHistory } = require('./src/ml_sector_selector');
const { tradeCost } = require('./src/cost_model');
const { markowitz, riskParity, riskParityEWMA } = require('./src/portfolio_optimizer');
const wf = require('./src/walk_forward_pro');
const fl = require('./src/factor_library');
const sh = require('./src/sensitivity_heatmap');
const { equityCurveSVG, drawdownSVG, efficientFrontierSVG, heatmapSVG } = require('./src/report_chart');

const args = process.argv.slice(2);
const FORCE_DEMO = args.includes('--demo');
const START = 60, REBAL = 5, WINDOW = 60;

// ---------- 工具 ----------
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
function mulberry32(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function genSeries(seed, drift, vol, n) {
  const rng = mulberry32(seed); const out = [1];
  for (let i = 1; i < n; i++) { const z = Math.sqrt(-2 * Math.log(rng() + 1e-9)) * Math.cos(2 * Math.PI * rng()); out.push(out[out.length - 1] * (1 + drift / 252 + (vol / Math.sqrt(252)) * z)); }
  return out;
}

(async () => {
  // ---------- 1. 取数据 (联网优先, 合成兜底) ----------
  let dataMode = 'LIVE';
  const series = {};
  if (!FORCE_DEMO) {
    for (const s of PREFERRED_SECTORS) {
      const navs = await Promise.race([
        fetchNavHistory(s.code, 160, true),
        new Promise((res) => setTimeout(() => res([]), 8000)),
      ]).catch(() => []);
      if (navs.length >= 60) series[s.code] = { name: s.name, sector: s.sector, navs };
    }
    if (Object.keys(series).length < 3) { console.log('  · 实盘数据不足/超时, 降级为合成数据'); dataMode = 'SYNTHETIC'; }
  } else { dataMode = 'SYNTHETIC'; }

  if (dataMode === 'SYNTHETIC') {
    PREFERRED_SECTORS.forEach((s, i) => {
      series[s.code] = { name: s.name, sector: s.sector, navs: genSeries(20260722 + i * 13, 0.10 + (i % 4) * 0.04, 0.26, 200).map((nav, k) => ({ date: `D${k}`, nav: +nav.toFixed(4) })) };
    });
  }

  const codes = Object.keys(series);
  // 前向填充对齐
  const masterSet = new Set();
  for (const c of codes) series[c].navs.forEach((n) => masterSet.add(n.date));
  // 日期排序: 合成数据用 "D<num>" 需按数字排序(否则字典序 D10<D2 会打乱时序);
  // 真实数据用 ISO "YYYY-MM-DD" 字典序即可。
  const commonDates = [...masterSet].sort((a, b) => {
    const ma = a.match(/^D(\d+)$/), mb = b.match(/^D(\d+)$/);
    if (ma && mb) return (+ma[1]) - (+mb[1]);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const closesByCode = {};
  for (const c of codes) {
    const map = {}; series[c].navs.forEach((n) => (map[n.date] = n.nav));
    let last = null;
    closesByCode[c] = commonDates.map((d) => { if (map[d] != null) { last = map[d]; return map[d]; } return last; });
    let first = closesByCode[c].find((v) => v != null);
    closesByCode[c] = closesByCode[c].map((v) => (v == null ? first : v));
  }
  const N = commonDates.length;
  console.log(`数据模式=${dataMode} 区间 ${N} 日, ${codes.length} 赛道, 计入成本\n`);

  // ---------- 2. 情绪因子 (可选, 失败降级) ----------
  let sentiment = null, news = 0;
  try {
    const { analyzeMarketSentiment } = require('./src/sentiment_engine');
    const se = await Promise.race([analyzeMarketSentiment(), new Promise((r) => setTimeout(() => r(null), 6000))]);
    if (se && typeof se.score === 'number') sentiment = se.score;
  } catch (e) {}
  try {
    const { getNewsSentimentFactor } = require('./src/news_sentiment');
    const nf = await Promise.race([getNewsSentimentFactor(), new Promise((r) => setTimeout(() => r(null), 6000))]);
    if (nf && nf.available) news = nf.score;
  } catch (e) {}
  console.log(`  情绪因子: 市场恐慌贪婪=${sentiment != null ? sentiment : 'N/A'}  新闻舆情=${news.toFixed(2)}\n`);

  // ---------- 3. 权重函数 ----------
  const equalW = () => { const w = {}; codes.forEach((c) => (w[c] = 1 / codes.length)); return w; };
  const momentumW = (t, k = 2) => {
    const sc = {}; for (const c of codes) { const cl = closesByCode[c].slice(0, t + 1); sc[c] = cl.length >= 21 ? cl[cl.length - 1] / cl[cl.length - 21] - 1 : -999; }
    const ranked = codes.slice().sort((a, b) => sc[b] - sc[a]).filter((c) => sc[c] > 0);
    if (!ranked.length) return 'CASH'; const top = ranked.slice(0, k); const w = {}; top.forEach((c) => (w[c] = 1 / top.length)); return w;
  };
  const factorFit = wf.makeFactorFitFn(closesByCode, { weights: { momentum: 0.5, valuation: 0.3, sentiment: 0.2 }, topK: 4, sentiment, news });
  const mptW = (t, kind) => {
    const from = Math.max(0, t - WINDOW); const win = {}; for (const c of codes) win[c] = closesByCode[c].slice(from, t + 1);
    if (win[codes[0]].length < 30) return momentumW(t);
    try {
      if (kind === 'maxSharpe') { const r = markowitz(win, { samples: 2000, maxWeight: 0.25, seed: 7 }); return r.maxSharpe.w; }
      if (kind === 'rpEwma') { const r = riskParityEWMA(win, { maxWeight: 0.25, lambda: 0.94 }); return r.weights; }
      if (kind === 'rp') { const r = riskParity(win, { maxWeight: 0.25 }); return r.weights; }
    } catch (e) { return momentumW(t); }
    return momentumW(t);
  };

  // ---------- 4. 通用回测器 ----------
  function backtest(weightFn, { threshold = null } = {}) {
    if (threshold != null) return wf.thresholdBacktest({ closesByCode, codes, fitFn: weightFn, opts: { start: START, rebal: REBAL, threshold, costApply: applyCost } });
    let nav = 1, w = null; const curve = []; let trades = 0, costTotal = 0;
    for (let t = START; t < N; t++) {
      let r = 0; if (w && w !== 'CASH') for (const c of codes) r += (w[c] || 0) * (closesByCode[c][t] / closesByCode[c][t - 1] - 1);
      nav *= 1 + r; curve.push(nav);
      if ((t - START) % REBAL === 0 && t + REBAL < N) {
        const target = weightFn(t);
        if (target && target !== 'CASH') { const c = w && w !== 'CASH' ? applyCost(nav, w, target, REBAL) : applyCost(nav, null, target, REBAL); nav -= c; costTotal += c; w = target; trades++; }
        else if (w && w !== 'CASH') { const c = applyCost(nav, w, {}, REBAL); nav -= c; costTotal += c; w = 'CASH'; trades++; }
      }
    }
    return { curve, stats: stats(curve), trades, costTotal: +costTotal.toFixed(4) };
  }

  const strategies = [
    { key: 'equal', label: '等权分散(每5日固定再平衡)', fn: () => equalW() },
    { key: 'equalThr', label: '等权分散(阈值±5%再平衡)', fn: () => equalW(), threshold: 0.05 },
    { key: 'mom2', label: '动量Top2', fn: (t) => momentumW(t, 2) },
    { key: 'factorFixed', label: '因子模型(固定再平衡)', fn: factorFit },
    { key: 'factorThr', label: '因子模型(阈值±5%再平衡)', fn: factorFit, threshold: 0.05 },
    { key: 'mpt', label: '马克维茨最大夏普', fn: (t) => mptW(t, 'maxSharpe') },
    { key: 'rpEwma', label: '风险平价(EWMA协方差)', fn: (t) => mptW(t, 'rpEwma') },
  ];

  const results = {};
  for (const s of strategies) {
    const r = backtest(s.fn, s.threshold != null ? { threshold: s.threshold } : {});
    results[s.key] = { label: s.label, ...r.stats, trades: r.trades || 0, costTotal: r.costTotal || 0, curve: r.curve, rebalances: r.rebalances };
    console.log(`${s.label.padEnd(22)} 收益${String(results[s.key].total + '%').padStart(7)} 夏普${String(results[s.key].sharpe).padStart(5)} 回撤${String(results[s.key].mdd + '%').padStart(8)} 调仓${String(results[s.key].trades).padStart(3)} 成本${(results[s.key].costTotal * 100).toFixed(2).padStart(6)}%`);
  }

  // ---------- 5. 严格 walk-forward 折叠验证 (因子模型) ----------
  const folds = wf.walkForwardFolds({ closesByCode, codes, fitFn: factorFit, opts: { start: START, trainMin: 60, foldStep: 20, embargo: 5, costApply: applyCost } });

  // ---------- 6. 参数敏感性热力图 (动量×估值) ----------
  const rows = [0, 0.25, 0.5, 0.75, 1].map((v) => ({ label: `动量${v}`, value: v }));
  const cols = [0, 0.25, 0.5, 0.75, 1].map((v) => ({ label: `估值${v}`, value: v }));
  const grid = sh.paramGrid({
    rows, cols,
    evalFn: (momW, valW) => {
      const sw = Math.max(0, 1 - momW - valW);
      const f = wf.makeFactorFitFn(closesByCode, { weights: { momentum: momW, valuation: valW, sentiment: sw }, topK: 4, sentiment, news });
      const r = wf.walkForwardBacktest({ closesByCode, codes, fitFn: f, opts: { start: START, rebal: REBAL } });
      return r.stats.total;
    },
  });
  const range = sh.matrixRange(grid.matrix);

  // ---------- 7. 可视化 ----------
  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const reportDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const best = strategies.slice().sort((a, b) => results[b.key].total - results[a.key].total)[0];
  const eqSvgs = strategies.map((s) => `<div style="margin:8px"><b>${results[s.key].label}</b>${equityCurveSVG(results[s.key].curve, { title: `${results[s.key].label} (收益${results[s.key].total}% 夏普${results[s.key].sharpe})` })}</div>`).join('');
  const tableRows = strategies.map((s) => { const r = results[s.key]; return `<tr><td>${r.label}</td><td>${r.total}%</td><td>${r.sharpe}</td><td>${r.mdd}%</td><td>${r.oos}%</td><td>${r.trades}</td><td>${(r.costTotal * 100).toFixed(2)}%</td></tr>`; }).join('');
  const foldRows = folds ? folds.folds.map((f) => `<tr><td>${f.i}</td><td>${f.testPeriod}</td><td>${f.trainSharpe}</td><td>${f.testSharpe}</td><td>${f.degradation > 0 ? '<span style="color:#dc2626">+' + f.degradation + '</span>' : f.degradation}</td><td>${f.testRet}%</td></tr>`).join('') : '<tr><td colspan="6">N/A</td></tr>';
  const heatSvg = heatmapSVG(grid.matrix, { rowLabels: grid.rowLabels, colLabels: grid.colLabels, lo: range.lo, hi: range.hi, title: '因子权重敏感性 (总收益%)' });
  const ddSvg = drawdownSVG(results[best.key].curve);
  let frontier = null, maxS = null, minV = null;
  try { const mr = markowitz(closesByCode, { samples: 6000, maxWeight: 0.25, seed: 42 }); frontier = mr.frontier; maxS = mr.maxSharpe; minV = mr.minVariance; } catch (e) {}
  const frontierSvg = frontier ? efficientFrontierSVG(frontier, { maxSharpe: maxS, minVariance: minV }) : '';

  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>量化实验室回测 ${reportDate}</title>
<style>body{font-family:system-ui,'Microsoft YaHei',sans-serif;max-width:960px;margin:24px auto;color:#1e293b}h1{font-size:22px}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:center;font-size:13px}th{background:#f1f5f9}.note{color:#64748b;font-size:12px;line-height:1.6}.best{background:#ecfdf5}.warn{color:#dc2626}.tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#ede9fe;color:#5b21b6}</style></head>
<body><h1>📊 量化实验室回测报告 <span class="tag">${dataMode}</span></h1>
<p class="note">区间 ${commonDates[START]} ~ ${commonDates[N - 1]} ｜ ${N - START} 交易日 ｜ ${codes.length} 只赛道 ｜ 已计入 C 类交易成本 ｜ walk-forward 防前视 ｜ 多因子(动量/估值/情绪)</p>

<h2>① 策略对比</h2>
<table><tr><th>策略</th><th>总收益</th><th>夏普</th><th>最大回撤</th><th>样本外(20日)</th><th>调仓次数</th><th>摩擦成本</th></tr>${tableRows}</table>
<p class="note">阈值再平衡对照: 比较"等权分散(每5日固定)"与"等权分散(阈值±5%)"——目标(等权)稳定时, 阈值再平衡显著减少调仓次数与摩擦成本。因子模型因信号频繁更替(换手高), 阈值收益有限, 这正是成本拖累的真实来源。</p>

<h2>② 权益曲线</h2>${eqSvgs}
<h2>③ 回撤 — ${results[best.key].label}</h2>${ddSvg}

<h2>④ 严格 Walk-Forward 过拟合检测 (因子模型)</h2>
<table><tr><th>折</th><th>测试区间</th><th>训练窗夏普</th><th>样本外夏普</th><th>退化度Δ</th><th>样本外收益</th></tr>${foldRows}</table>
<p class="note">退化度Δ = 训练窗夏普 − 样本外夏普。${folds && folds.avgDegradation > 0.3 ? '<span class="warn">平均退化度为正, 提示存在过拟合风险, 需谨慎看待样本内表现。</span>' : '平均退化度可控, 样本外表现较稳健。'} 平均OOS夏普=${folds ? folds.avgTestSharpe : 'N/A'}。</p>

<h2>⑤ 参数敏感性热力图 (动量权重 × 估值权重)</h2>${heatSvg}
<p class="note">颜色越绿收益越高。若高收益只集中在极小区域, 说明策略对参数敏感、鲁棒性差; 大范围绿色则更稳健。新闻舆情权重 = 1 − 动量 − 估值。</p>

<h2>⑥ 马克维茨有效前沿 (全样本 Monte Carlo)</h2>${frontierSvg}
<p class="note">本回测基于历史净值, 不构成投资建议。成本含 C 类赎回费(阶梯)+销售服务费(0.4%/年)。</p>
</body></html>`;
  const outFile = path.join(outDir, `quant_lab_${reportDate}.html`);
  fs.writeFileSync(outFile, html);
  console.log(`\n📁 HTML 报告已生成: ${outFile}  (数据模式: ${dataMode})`);
})();
