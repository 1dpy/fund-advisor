/**
 * 自我迭代验证 + 更长数据测试集 (P3)
 * ---------------------------------------------------------------
 * 1) 拉取约 365 日多 regime 净值(失败回退合成), 在更长数据上跑 7 策略对比,
 *    用"更多数据"验证模型成败(而非仅 80 日震荡市)。
 * 2) 运行 self_tuning 自我迭代元优化器: 每折训练窗拟参→测试窗真OOS验证→
 *    元控制器按过拟合降级Δ在线调正则化→滚动扩展窗口(测试窗并入下一训练窗
 *    = 真正的自我迭代零泄题)→ 最后冻结 holdout 作为从未训练的最终测试集。
 * 3) 输出 HTML 报告: 策略对比 / 自我迭代折表 / 元参数演化曲线 / 降级Δ轨迹 /
 *    holdout 权益对比(self-tuned vs 固定默认)。
 *
 * 用法: node backtest_self_iterate.js            (联网优先, 失败回退合成)
 *       node backtest_self_iterate.js --demo     (强制合成数据)
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
const st = require('./src/self_tuning');
const { equityCurveSVG, drawdownSVG, efficientFrontierSVG, heatmapSVG, lineChartSVG } = require('./src/report_chart');

const args = process.argv.slice(2);
const FORCE_DEMO = args.includes('--demo');
const START = 60, REBAL = 5, WINDOW = 60, DAYS = 365, HOLDOUT = 60;

// ---------- 工具 (与 backtest_quant_lab 一致) ----------
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
  // ---------- 1. 取更长数据 (联网优先, 合成兜底) ----------
  let dataMode = 'LIVE';
  const series = {};
  if (!FORCE_DEMO) {
    for (const s of PREFERRED_SECTORS) {
      const navs = await Promise.race([
        fetchNavHistory(s.code, DAYS, true),
        new Promise((res) => setTimeout(() => res([]), 8000)),
      ]).catch(() => []);
      if (navs.length >= 60) series[s.code] = { name: s.name, sector: s.sector, navs };
    }
    if (Object.keys(series).length < 3) { console.log('  · 实盘数据不足/超时, 降级为合成数据'); dataMode = 'SYNTHETIC'; }
  } else { dataMode = 'SYNTHETIC'; }

  if (dataMode === 'SYNTHETIC') {
    // 合成数据: 每只基金固定漂移+适中波动(与 quant_lab 同风格, 基金量级),
    // 模拟不同赛道长期分化; 仅用于离线/CI 演示, 报告标注 SYNTHETIC。
    PREFERRED_SECTORS.forEach((s, i) => {
      const navs = genSeries(20260722 + i * 13, 0.10 + (i % 4) * 0.04, 0.22, DAYS + HOLDOUT).map((nav, k) => ({ date: `D${k}`, nav: +nav.toFixed(4) }));
      series[s.code] = { name: s.name, sector: s.sector, navs };
    });
  }

  const codes = Object.keys(series);
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
  console.log(`数据模式=${dataMode} 区间 ${N} 日(更长/多regime), ${codes.length} 赛道, holdout=${HOLDOUT}, 计入成本\n`);

  // ---------- 2. 情绪因子 (可选) ----------
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

  // ---------- 3. 7 策略对比 (更长数据验证) ----------
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
  function backtest(weightFn, threshold = null) {
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
    { key: 'equal', label: '等权分散(固定再平衡)', fn: () => equalW() },
    { key: 'equalThr', label: '等权分散(阈值±5%)', fn: () => equalW(), threshold: 0.05 },
    { key: 'mom2', label: '动量Top2', fn: (t) => momentumW(t, 2) },
    { key: 'factorFixed', label: '因子模型(固定再平衡)', fn: factorFit },
    { key: 'factorThr', label: '因子模型(阈值±5%)', fn: factorFit, threshold: 0.05 },
    { key: 'mpt', label: '马克维茨最大夏普', fn: (t) => mptW(t, 'maxSharpe') },
    { key: 'rpEwma', label: '风险平价(EWMA)', fn: (t) => mptW(t, 'rpEwma') },
  ];
  const results = {};
  for (const s of strategies) {
    const r = backtest(s.fn, s.threshold != null ? s.threshold : null);
    results[s.key] = { label: s.label, ...r.stats, trades: r.trades || 0, costTotal: r.costTotal || 0, curve: r.curve };
    console.log(`${s.label.padEnd(20)} 收益${String(results[s.key].total + '%').padStart(7)} 夏普${String(results[s.key].sharpe).padStart(5)} 回撤${String(results[s.key].mdd + '%').padStart(8)} 调仓${String(results[s.key].trades).padStart(3)}`);
  }

  // ---------- 4. 自我迭代元优化 (含最终 holdout 测试集) ----------
  console.log('\n⏳ 运行自我迭代元优化器 (每折拟参→OOS验证→在线调正则→滚动扩展) ...');
  const si = st.selfIterateWalkForward(closesByCode, codes, { start: START, rebal: REBAL, foldStep: 20, embargo: 5, holdout: HOLDOUT, costApply: applyCost, sentiment, news });
  if (!si) { console.log('  · 数据不足以自我迭代 (需更长历史)'); return; }
  console.log(`  · 折数=${si.folds.length}  最终λ=${si.metaFinal.lambda}  degEMA=${si.metaFinal.degEMA}`);
  console.log(`  · holdout: self-tuned 夏普${si.holdout.selfTuned.sharpe}/收益${si.holdout.selfTuned.total}%  vs 固定默认 夏普${si.holdout.static.sharpe}/收益${si.holdout.static.total}%`);
  console.log(`  · 改进: holdout夏普Δ=${si.improvement.holdoutSharpeDelta}  平均测试窗夏普 self=${si.improvement.avgTestSharpeSelf} vs static=${si.improvement.avgTestSharpeStatic}\n`);

  // holdout 权益曲线: self-tuned vs static
  const selfFit = wf.makeFactorFitFn(closesByCode, { weights: { momentum: si.holdout.selfParams.momentum, valuation: si.holdout.selfParams.valuation, sentiment: si.holdout.selfParams.sentiment }, topK: si.holdout.selfParams.topK, sentiment, news });
  const statFit = wf.makeFactorFitFn(closesByCode, { weights: { momentum: 0.5, valuation: 0.3, sentiment: 0.2 }, topK: 4, sentiment, news });
  const selfCurve = wf.walkForwardBacktest({ closesByCode, codes, fitFn: selfFit, opts: { start: N - HOLDOUT, rebal: REBAL, embargo: 0, costApply: applyCost } }).curve;
  const statCurve = wf.walkForwardBacktest({ closesByCode, codes, fitFn: statFit, opts: { start: N - HOLDOUT, rebal: REBAL, embargo: 0, costApply: applyCost } }).curve;

  // ---------- 5. 可视化 ----------
  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const reportDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const eqSvgs = strategies.map((s) => `<div style="margin:8px"><b>${results[s.key].label}</b>${equityCurveSVG(results[s.key].curve, { title: `${results[s.key].label} (收益${results[s.key].total}% 夏普${results[s.key].sharpe})` })}</div>`).join('');
  const tableRows = strategies.map((s) => { const r = results[s.key]; return `<tr><td>${r.label}</td><td>${r.total}%</td><td>${r.sharpe}</td><td>${r.mdd}%</td><td>${r.trades}</td></tr>`; }).join('');
  const foldRows = si.folds.map((f) => `<tr><td>${f.i}</td><td>${f.testPeriod}</td><td>动${f.params.momentum}/估${f.params.valuation}/情${f.params.sentiment}/K${f.params.topK}</td><td>${f.trainSharpe}</td><td>${f.testSharpe}</td><td class="${f.degradation > 0.3 ? 'warn' : ''}">${f.degradation > 0 ? '+' + f.degradation : f.degradation}</td><td>${f.lambda}</td></tr>`).join('');

  const evoSvg = lineChartSVG([
    { label: '动量权重', color: '#2563eb', points: si.paramTrajectory.map((p) => p.momentum) },
    { label: '估值权重', color: '#16a34a', points: si.paramTrajectory.map((p) => p.valuation) },
    { label: '情绪权重', color: '#f59e0b', points: si.paramTrajectory.map((p) => p.sentiment) },
    { label: 'λ正则', color: '#dc2626', points: si.paramTrajectory.map((p) => p.lambda) },
  ], { title: '元参数随折叠演化 (自我迭代轨迹)' });
  const degSvg = lineChartSVG([
    { label: '过拟合降级Δ', color: '#dc2626', points: si.folds.map((f) => f.degradation) },
    { label: 'Δ滑动平均', color: '#7c3aed', points: si.folds.map((f) => f.degEMA) },
  ], { title: '过拟合降级 Δ = 训练窗夏普 − 样本外夏普', yMin: -2, yMax: 2 });

  const hoSvg = (() => {
    // 两条曲线各自归一化为首值=1 后, 各自独立 SVG 并排展示
    const norm = (c) => c.map((v) => v / c[0]);
    const selfN = norm(selfCurve), statN = norm(statCurve);
    return `<div style="display:flex;gap:12px;flex-wrap:wrap">` +
      `<div style="flex:1;min-width:320px"><b>self-tuned(末折演化参数)</b>${equityCurveSVG(selfN, { title: `holdout self-tuned (收益${si.holdout.selfTuned.total}%)` })}</div>` +
      `<div style="flex:1;min-width:320px"><b>固定默认(0.5/0.3/0.2,K4)</b>${equityCurveSVG(statN, { title: `holdout static (收益${si.holdout.static.total}%)` })}</div>` +
      `</div>`;
  })();

  const verdict = si.improvement.holdoutSharpeDelta > 0
    ? `<span class="best">自我迭代在最终测试集上优于固定默认(夏普Δ=${si.improvement.holdoutSharpeDelta}, 收益Δ=${si.improvement.holdoutRetDelta}%)，说明元控制器(在线正则化+滚动扩展)在未见数据上确实带来了泛化收益。</span>`
    : `<span class="warn">自我迭代在最终测试集上未优于固定默认(夏普Δ=${si.improvement.holdoutSharpeDelta})。这本身也是诚实结论: 在基金短期高噪净值上, 自适应调参的样本外增益有限; 等权分散仍是更稳的基线。元控制器的价值在于"限制过拟合"而非"显著增收益"。</span>`;

  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>自我迭代验证 ${reportDate}</title>
<style>body{font-family:system-ui,'Microsoft YaHei',sans-serif;max-width:960px;margin:24px auto;color:#1e293b}h1{font-size:22px}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:center;font-size:13px}th{background:#f1f5f9}.note{color:#64748b;font-size:12px;line-height:1.6}.best{background:#ecfdf5;color:#065f46;padding:2px 6px;border-radius:6px}.warn{color:#dc2626;background:#fef2f2;padding:2px 6px;border-radius:6px}.tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#ede9fe;color:#5b21b6}</style></head>
<body><h1>🧠 自我迭代验证报告 <span class="tag">${dataMode}</span></h1>
<p class="note">区间 ${commonDates[START]} ~ ${commonDates[N - 1]} ｜ 全样本 ${N} 日(更长/多regime) ｜ holdout 冻结 ${HOLDOUT} 日 ｜ ${codes.length} 赛道 ｜ 已计入成本 ｜ 自我迭代 = 在线元正则化 + 滚动扩展窗口(零泄题)</p>

<h2>① 更长数据 · 7 策略对比 (验证模型成败)</h2>
<table><tr><th>策略</th><th>总收益</th><th>夏普</th><th>最大回撤</th><th>调仓次数</th></tr>${tableRows}</table>
<p class="note">在更长/多regime数据上复跑, 检验此前"80日震荡市"结论是否稳健。若等权分散仍居前且回撤可控, 说明结论可泛化。</p>
${eqSvgs}

<h2>② 自我迭代折表 (训练拟参 → OOS验证 → 在线调λ)</h2>
<table><tr><th>折</th><th>测试区间</th><th>选中参数(动/估/情/K)</th><th>训练夏普</th><th>样本外夏普</th><th>降级Δ</th><th>λ</th></tr>${foldRows}</table>

<h2>③ 元参数演化轨迹 (模型如何"自我迭代")</h2>${evoSvg}
<h2>④ 过拟合降级 Δ 轨迹</h2>${degSvg}

<h2>⑤ 最终测试集(holdout) 自我迭代 vs 固定默认</h2>${hoSvg}
<p class="note">self-tuned 参数(末折演化): 动${si.holdout.selfParams.momentum}/估${si.holdout.selfParams.valuation}/情${si.holdout.selfParams.sentiment}/K${si.holdout.selfParams.topK}。holdout 夏普 self=${si.holdout.selfTuned.sharpe} vs static=${si.holdout.static.sharpe}; 平均测试窗夏普 self=${si.improvement.avgTestSharpeSelf} vs static=${si.improvement.avgTestSharpeStatic}。</p>

<h2>⑥ 结论</h2><p class="note">${verdict}</p>
<p class="note">方法论红线: 测试窗数据绝不回灌重拟合因子权重; λ 只由"训练−测试降级"在线调整(元学习), 不触碰测试集本身; holdout 全程冻结。本回测基于历史净值, 不构成投资建议。</p>
</body></html>`;
  const outFile = path.join(outDir, `self_iterate_${reportDate}.html`);
  fs.writeFileSync(outFile, html);
  console.log(`📁 HTML 报告已生成: ${outFile}  (数据模式: ${dataMode})`);
})();
