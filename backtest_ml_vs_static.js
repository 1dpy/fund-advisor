/**
 * 回测: ML 动态选赛道 vs 静态策略 — 验证 ML 选基是否真能多赚钱
 *
 * 对比三组 (用 bt_cache 真实净值, 严格无前视: t日收盘决策, 下一期生效):
 *   A. ML动态: 每 REBAL 个交易日用当时历史算 ML 分, 全仓切到最强赛道
 *   B. 静态单一: 死守 PREFERRED_SECTORS[0] (当前 pickPreferredSector 首选=半导体)
 *   C. 静态等权: 所有赛道等权, 每日再平衡 (分散基线)
 *
 * 指标: 总收益 / 年化夏普 / 最大回撤 / 调仓次数
 * 用法: node backtest_ml_vs_static.js
 */

const { fetchNavHistory, scoreFund } = require('./src/ml_sector_selector');
const { PREFERRED_SECTORS } = require('./src/config');

const START = 40;   // LSTM 预热期(需>=40条)
const REBAL = 5;    // 每5个交易日重算ML分调仓

function metrics(curve, switches) {
  const total = curve[curve.length - 1] - 1;
  const rets = [];
  for (let i = 1; i < curve.length; i++) rets.push(curve[i] / curve[i - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, v) => s + (v - m) ** 2, 0) / rets.length);
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(252) : 0;
  let peak = curve[0], mdd = 0;
  curve.forEach((v) => { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); });
  return { total: (total * 100).toFixed(2) + '%', sharpe: sharpe.toFixed(2), mdd: (mdd * 100).toFixed(2) + '%', switches };
}

(async () => {
  // 1. 加载各赛道净值 (缓存, 不重复抓)
  const series = {};
  for (const s of PREFERRED_SECTORS) {
    const navs = await fetchNavHistory(s.code, 120, true);
    if (navs.length >= 60) series[s.code] = { name: s.name, sector: s.sector, navs };
  }
  const codes = Object.keys(series);
  if (codes.length < 2) { console.log('数据不足'); return; }

  // 2. 共同交易日 + closes 对齐
  const dateSets = codes.map((c) => new Set(series[c].navs.map((n) => n.date)));
  const commonDates = [...dateSets[0]].filter((d) => dateSets.every((st) => st.has(d))).sort();
  const closesByCode = {};
  for (const c of codes) {
    const map = {}; series[c].navs.forEach((n) => (map[n.date] = n.nav));
    closesByCode[c] = commonDates.map((d) => map[d]);
  }
  const N = commonDates.length;
  console.log(`回测区间: ${commonDates[START]} ~ ${commonDates[N - 1]}  (${N - START}个交易日, ${codes.length}只赛道)`);
  console.log(`赛道池: ${codes.map((c) => series[c].sector).join('/')}\n`);

  // A. ML动态
  let navA = 1; const curveA = []; let curA = codes[0]; let swA = 0;
  for (let t = START; t < N; t++) {
    navA *= closesByCode[curA][t] / closesByCode[curA][t - 1];
    curveA.push(navA);
    if ((t - START) % REBAL === 0) {
      let best = null, bs = -1e9;
      for (const c of codes) {
        const closes = closesByCode[c].slice(0, t + 1);
        if (closes.length < 40) continue;
        const s = scoreFund(closes);
        if (s.mlScore > bs) { bs = s.mlScore; best = c; }
      }
      if (best && best !== curA) { curA = best; swA++; }
    }
  }

  // B. 静态单一 (死守首选半导体)
  const first = PREFERRED_SECTORS[0].code;
  let navB = 1; const curveB = [];
  for (let t = START; t < N; t++) { navB *= closesByCode[first][t] / closesByCode[first][t - 1]; curveB.push(navB); }

  // C. 静态等权 (每日再平衡)
  let navC = 1; const curveC = [];
  for (let t = START; t < N; t++) {
    let r = 0; codes.forEach((c) => (r += closesByCode[c][t] / closesByCode[c][t - 1] - 1));
    navC *= 1 + r / codes.length; curveC.push(navC);
  }

  // 3. 输出
  const mA = metrics(curveA, swA), mB = metrics(curveB, 0), mC = metrics(curveC, 0);
  console.log('策略对比 (越高越好):');
  console.log('  策略           总收益      夏普    最大回撤   调仓次数');
  console.log(`  A ML动态       ${mA.total.padStart(8)}   ${mA.sharpe.padStart(5)}   ${mA.mdd.padStart(8)}   ${mA.switches}`);
  console.log(`  B 静态单一     ${mB.total.padStart(8)}   ${mB.sharpe.padStart(5)}   ${mB.mdd.padStart(8)}   ${mB.switches}`);
  console.log(`  C 静态等权     ${mC.total.padStart(8)}   ${mC.sharpe.padStart(5)}   ${mC.mdd.padStart(8)}   ${mC.switches}`);

  const aRet = parseFloat(mA.total), bRet = parseFloat(mB.total), cRet = parseFloat(mC.total);
  const bestStatic = Math.max(bRet, cRet);
  console.log(`\nML动态 vs 最优静态基线: ${aRet >= bestStatic ? '✓ ML胜出 +' + (aRet - bestStatic).toFixed(2) + '%' : '✗ ML落后 ' + (aRet - bestStatic).toFixed(2) + '%'}`);
  console.log(aRet >= bestStatic ? '结论: ML选基可接入实盘建议(advisor pickPreferredSector 改用ML打分)' : '结论: ML暂不接入实盘, 继续用静态轮换, 需优化ML模型/特征');
})();
