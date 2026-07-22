/**
 * 综合回测引擎 v2 — 多策略对比 + 交易成本 + walk-forward + HTML 报告
 * ---------------------------------------------------------------
 * 在 v1 (LSTM vs 等权) 基础上, 按量化金融研究规范升级 (参考 statarb /
 * jaychouchannel / VanAurum):
 *
 *   1) 交易成本建模: 每次调仓计入 C 类基金赎回费 + 销售服务费 (cost_model)
 *   2) 新增策略:
 *        - 马克维茨最大夏普 (Markowitz mean-variance, Monte Carlo 前沿)
 *        - 风险平价 (Equal Risk Contribution)
 *      与 等权分散 / 动量Top2 / ML静态排名Top2 同台对比
 *   3) walk-forward 防前视: Markowitz/RiskParity 的权重用"截至当日的前
 *      60日窗口"拟合, 再用于未来, 杜绝用未来数据预测过去
 *   4) 输出 HTML 报告 (reports/backtest_YYYYMMDD.html): 含权益曲线/回撤/
 *      有效前沿 SVG 图, 可直接在 GitHub/浏览器查看
 *
 * 用法: node backtest_model_compare.js
 */

const fs = require('fs');
const path = require('path');
const { fetchNavHistory, getSectorMLRanking } = require('./src/ml_sector_selector');
const { PREFERRED_SECTORS } = require('./src/config');
const { tradeCost } = require('./src/cost_model');
const { markowitz, riskParity } = require('./src/portfolio_optimizer');
const { equityCurveSVG, drawdownSVG, efficientFrontierSVG } = require('./src/report_chart');

const START = 40, REBAL = 5, OOS_DAYS = 20, WINDOW = 60;

function stats(curve) {
  const total = curve[curve.length - 1] - 1;
  const rets = []; for (let i = 1; i < curve.length; i++) rets.push(curve[i] / curve[i - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, v) => s + (v - m) ** 2, 0) / rets.length);
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(252) : 0;
  let peak = curve[0], mdd = 0; curve.forEach((v) => { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); });
  const oos = curve.length > OOS_DAYS ? curve[curve.length - 1] / curve[curve.length - 1 - OOS_DAYS] - 1 : total;
  return { total: +(total * 100).toFixed(2), sharpe: +sharpe.toFixed(2), mdd: +(mdd * 100).toFixed(2), oos: +(oos * 100).toFixed(2) };
}

// 调仓摩擦成本: 比较新旧权重, 对每只基金的买卖额计成本
//   wOld/wNew 为权重对象 {code:w} 或 {} (空仓) 或 'CASH'
function applyCost(nav, wOld, wNew, holdDays) {
  const o = (wOld && typeof wOld === 'object') ? wOld : {};
  const n = (wNew && typeof wNew === 'object') ? wNew : {};
  let cost = 0;
  const allCodes = new Set([...Object.keys(o), ...Object.keys(n)]);
  for (const c of allCodes) {
    const d = (n[c] || 0) - (o[c] || 0);
    const amt = Math.abs(d) * nav;
    if (amt > 1e-9) cost += tradeCost({ buyAmount: d > 0 ? amt : 0, sellAmount: d < 0 ? amt : 0, holdDays }).total;
  }
  return cost;
}

(async () => {
  // 单只基金抓取预算: 超时就跳过, 避免网络挂起拖垮整个回测 (CI/弱网友好)
  function fetchWithBudget(code, budgetMs) {
    return Promise.race([
      fetchNavHistory(code, 120, true),
      new Promise((res) => setTimeout(() => res([]), budgetMs)),
    ]);
  }
  const series = {};
  for (const s of PREFERRED_SECTORS) {
    const navs = await fetchWithBudget(s.code, 8000);
    if (navs.length >= 60) series[s.code] = { name: s.name, sector: s.sector, navs };
    else console.log(`  · 跳过 ${s.name}(${s.code}): 数据不足/超时`);
  }
  if (Object.keys(series).length < 3) { console.log('✗ 有效基金不足3只, 回测终止'); return; }
  const codes = Object.keys(series);
  // 前向填充对齐: 取所有日期的并集, 缺失净值用最近已知值填充 (解决 QDII 净值滞后导致交集过短)
  const masterSet = new Set();
  for (const c of codes) series[c].navs.forEach((n) => masterSet.add(n.date));
  const commonDates = [...masterSet].sort();
  const closesByCode = {};
  for (const c of codes) {
    const map = {}; series[c].navs.forEach((n) => (map[n.date] = n.nav));
    let last = null;
    closesByCode[c] = commonDates.map((d) => {
      if (map[d] != null) { last = map[d]; return map[d]; }
      return last; // 前向填充 (前导缺失则用首个已知值兜底)
    });
    // 前导缺失兜底
    let first = closesByCode[c].find((v) => v != null);
    closesByCode[c] = closesByCode[c].map((v) => (v == null ? first : v));
  }
  const N = commonDates.length;
  console.log(`区间 ${commonDates[START]}~${commonDates[N - 1]} (${N - START}日, ${codes.length}赛道), 样本外=后${OOS_DAYS}日, 计入交易成本\n`);

  // ---- 权重函数 (t = 当前索引, 仅用 t 及之前数据, 无前视) ----
  const equalW = () => { const w = {}; codes.forEach((c) => (w[c] = 1 / codes.length)); return w; };
  const momentumW = (t, k = 2) => {
    const sc = {}; for (const c of codes) { const cl = closesByCode[c].slice(0, t + 1); sc[c] = cl.length >= 21 ? cl[cl.length - 1] / cl[cl.length - 21] - 1 : -999; }
    const ranked = codes.slice().sort((a, b) => sc[b] - sc[a]).filter((c) => sc[c] > 0);
    if (!ranked.length) return 'CASH';
    const top = ranked.slice(0, k); const w = {}; top.forEach((c) => (w[c] = 1 / top.length)); return w;
  };
  // ML 静态排名: 每只基金仅训练一次(避免回测中逐点重训导致过慢/不稳定), 回测中只查静态分做轮动
  let mlRankMap = null;
  try {
    const ranking = await getSectorMLRanking({ useCache: true, delayMs: 50 });
    mlRankMap = new Map(ranking.map((r) => [r.code, r.mlScore]));
    console.log(`  · ML 静态排名已训练(${mlRankMap.size}只), 用于 ML 策略对比\n`);
  } catch (e) { mlRankMap = null; console.log('  · ML 排名训练跳过:', e.message, '\n'); }
  const mlW = (t, k = 2) => {
    if (!mlRankMap) return 'CASH';
    const sc = {};
    for (const c of codes) {
      const cl = closesByCode[c].slice(0, t + 1);
      const mom = cl.length >= 21 ? cl[cl.length - 1] / cl[cl.length - 21] - 1 : -999; // 仅动量向上才考虑
      const ml = mlRankMap.get(c) != null ? mlRankMap.get(c) : -999;
      sc[c] = mom > 0 ? ml : -999;
    }
    const ranked = codes.slice().sort((a, b) => sc[b] - sc[a]).filter((c) => sc[c] > -900);
    if (!ranked.length) return 'CASH';
    const top = ranked.slice(0, k); const w = {}; top.forEach((c) => (w[c] = 1 / top.length)); return w;
  };
  // walk-forward: 用截至 t 的前 WINDOW 日拟合 MPT
  const mptW = (t, kind) => {
    const from = Math.max(0, t - WINDOW);
    const win = {}; for (const c of codes) win[c] = closesByCode[c].slice(from, t + 1);
    if (win[codes[0]].length < 30) return momentumW(t);
    try {
      if (kind === 'maxSharpe') { const r = markowitz(win, { samples: 3000, maxWeight: 0.25, seed: 7 }); return r.maxSharpe.w; }
      if (kind === 'riskParity') { const r = riskParity(win, { maxWeight: 0.25 }); return r.weights; }
    } catch (e) { return momentumW(t); }
    return momentumW(t);
  };

  // ---- 通用回测器 (含成本) ----
  function backtest(weightFn) {
    let nav = 1, w = null, trades = 0, costTotal = 0; const curve = [];
    for (let t = START; t < N; t++) {
      let r = 0;
      if (w && w !== 'CASH') for (const c of codes) r += (w[c] || 0) * (closesByCode[c][t] / closesByCode[c][t - 1] - 1);
      nav *= 1 + r; curve.push(nav);
      if ((t - START) % REBAL === 0 && t + REBAL < N) {
        const target = weightFn(t);
        if (target && target !== 'CASH') {
          const c = w && w !== 'CASH' ? applyCost(nav, w, target, REBAL) : applyCost(nav, null, target, REBAL);
          nav -= c; costTotal += c;
          w = target; trades++;
        } else if (w && w !== 'CASH') {
          const c = applyCost(nav, w, {}, REBAL);
          nav -= c; costTotal += c; w = 'CASH'; trades++;
        }
      }
    }
    return { curve, trades, costTotal: +costTotal.toFixed(4) };
  }

  const strategies = [
    { key: 'equal', label: '等权分散(基准)', fn: () => equalW() },
    { key: 'mom2', label: '动量Top2', fn: (t) => momentumW(t, 2) },
    { key: 'lstm', label: 'ML静态排名Top2', fn: (t) => mlW(t, 2) },
    { key: 'mpt', label: '马克维茨最大夏普', fn: (t) => mptW(t, 'maxSharpe') },
    { key: 'rp', label: '风险平价', fn: (t) => mptW(t, 'riskParity') },
  ];

  const results = {};
  for (const s of strategies) {
    const { curve, trades, costTotal } = backtest(s.fn, s.label);
    const st = stats(curve);
    results[s.key] = { label: s.label, ...st, trades, costTotal, curve };
    console.log(`${s.label.padEnd(18)} 收益${String(st.total + '%').padStart(7)} 夏普${String(st.sharpe).padStart(5)} 回撤${String(st.mdd + '%').padStart(8)} 样本外${String(st.oos + '%').padStart(8)} 调仓${String(trades).padStart(3)} 成本${(costTotal * 100).toFixed(2).padStart(6)}%`);
  }
  console.log('\n✓=收益最高; 成本已计入; MPT/风险平价采用 walk-forward 防前视偏差');

  // ---- 有效前沿 (全样本, 仅作可视化) ----
  const fullNavs = {}; for (const c of codes) fullNavs[c] = closesByCode[c];
  let frontier = null, maxS = null, minV = null;
  try { const mr = markowitz(fullNavs, { samples: 8000, maxWeight: 0.25, seed: 42 }); frontier = mr.frontier; maxS = mr.maxSharpe; minV = mr.minVariance; } catch (e) {}

  // ---- HTML 报告 ----
  const reportDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const showKeys = ['equal', 'mom2', 'lstm', 'mpt', 'rp'];
  const eqSvgs = showKeys.map((k) => `<div style="margin:8px"><b>${results[k].label}</b>${equityCurveSVG(results[k].curve, { title: `${results[k].label} (收益${results[k].total}% 夏普${results[k].sharpe})` })}</div>`).join('');
  const bestKey = showKeys.slice().sort((a, b) => results[b].total - results[a].total)[0];
  const tableRows = strategies.map((s) => { const r = results[s.key]; return `<tr><td>${r.label}</td><td>${r.total}%</td><td>${r.sharpe}</td><td>${r.mdd}%</td><td>${r.oos}%</td><td>${r.trades}</td><td>${(r.costTotal * 100).toFixed(2)}%</td></tr>`; }).join('');
  const frontierSvg = frontier ? efficientFrontierSVG(frontier, { maxSharpe: maxS, minVariance: minV }) : '';
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>基金策略回测报告 ${reportDate}</title>
<style>body{font-family:system-ui,'Microsoft YaHei',sans-serif;max-width:900px;margin:24px auto;color:#1e293b}h1{font-size:22px}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:center;font-size:13px}th{background:#f1f5f9}.note{color:#64748b;font-size:12px;line-height1.6}.best{background:#ecfdf5}</style></head>
<body><h1>📊 A股基金多策略回测报告</h1>
<p class="note">区间 ${commonDates[START]} ~ ${commonDates[N - 1]} ｜ ${N - START} 个交易日 ｜ ${codes.length} 只赛道基金 ｜ 已计入 C 类交易成本 ｜ MPT / 风险平价采用 walk-forward (前60日窗口) 防前视偏差</p>
<h2>策略对比</h2>
<table><tr><th>策略</th><th>总收益</th><th>夏普</th><th>最大回撤</th><th>样本外(20日)</th><th>调仓次数</th><th>摩擦成本</th></tr>${tableRows}</table>
<h2>权益曲线</h2>${eqSvgs}
<h2>回撤 — ${results[bestKey].label}</h2>${drawdownSVG(results[bestKey].curve)}
<h2>马克维茨有效前沿 (全样本 Monte Carlo)</h2>${frontierSvg}
<p class="note">说明: 本回测基于历史净值, 不构成投资建议。C类基金成本含赎回费(随持有天数阶梯)+销售服务费(0.4%/年)。样本区间有限, 存在过拟合可能。</p>
</body></html>`;
  const outFile = path.join(outDir, `backtest_${reportDate}.html`);
  fs.writeFileSync(outFile, html);
  console.log(`\n📁 HTML 报告已生成: ${outFile}`);
})();
