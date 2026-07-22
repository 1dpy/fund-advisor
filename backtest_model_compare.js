/**
 * 模型对比 + 样本外验证 — LSTM-Lite vs LSTM-Attention(ProMax) vs 融合
 *
 * 固定最优配置 (ML Top2 等权 + 空仓门), 只换模型, 公平对比:
 *   - 全期收益/夏普/回撤
 *   - 样本外(后 OOS_DAYS 天)收益 — walk-forward 天然样本外, 检验是否过拟合
 * 用法: node backtest_model_compare.js
 */

const { fetchNavHistory, scoreFund } = require('./src/ml_sector_selector');
const { PREFERRED_SECTORS } = require('./src/config');

const START = 40, REBAL = 5, OOS_DAYS = 20;

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

(async () => {
  const series = {};
  for (const s of PREFERRED_SECTORS) {
    const navs = await fetchNavHistory(s.code, 120, true);
    if (navs.length >= 60) series[s.code] = { name: s.name, sector: s.sector, navs };
  }
  const codes = Object.keys(series);
  const dateSets = codes.map((c) => new Set(series[c].navs.map((n) => n.date)));
  const commonDates = [...dateSets[0]].filter((d) => dateSets.every((st) => st.has(d))).sort();
  const closesByCode = {};
  for (const c of codes) { const map = {}; series[c].navs.forEach((n) => (map[n.date] = n.nav)); closesByCode[c] = commonDates.map((d) => map[d]); }
  const N = commonDates.length;
  const rebalDates = []; for (let t = START; t < N; t += REBAL) rebalDates.push(t);
  console.log(`区间 ${commonDates[START]}~${commonDates[N - 1]} (${N - START}日, ${codes.length}赛道), 样本外=后${OOS_DAYS}日\n`);

  // 等权基准
  function eqCurve() { let nav = 1; const c = []; for (let t = START; t < N; t++) { let r = 0; codes.forEach((x) => (r += closesByCode[x][t] / closesByCode[x][t - 1] - 1)); nav *= 1 + r / codes.length; c.push(nav); } return c; }
  const eqStats = stats(eqCurve());

  // 对每种模型跑 Top2等权+空仓门
  function backtest(modelType) {
    const scoresAt = {};
    for (const t of rebalDates) { scoresAt[t] = {}; for (const c of codes) { const cl = closesByCode[c].slice(0, t + 1); if (modelType === 'momentum') { scoresAt[t][c] = cl.length >= 21 ? (cl[cl.length - 1] / cl[cl.length - 21] - 1) : -999; } else if (modelType === 'momtrend') { if (cl.length < 21) scoresAt[t][c] = -999; else { const ma20 = cl.slice(-20).reduce((a, b) => a + b, 0) / 20; const mom = cl[cl.length - 1] / cl[cl.length - 21] - 1; scoresAt[t][c] = cl[cl.length - 1] > ma20 ? mom : -999; } } else { scoresAt[t][c] = cl.length < 40 ? -999 : scoreFund(cl, modelType).mlScore; } } }
    let nav = 1; const curve = []; let holdings = null; let sw = 0;
    for (let t = START; t < N; t++) {
      let r = 0;
      if (holdings && holdings !== 'CASH') for (const [c, w] of Object.entries(holdings)) r += w * (closesByCode[c][t] / closesByCode[c][t - 1] - 1);
      nav *= 1 + r; curve.push(nav);
      if ((t - START) % REBAL === 0) {
        const sc = scoresAt[t];
        const ranked = codes.slice().sort((a, b) => sc[b] - sc[a]).filter((c) => sc[c] > 0 && sc[c] > -900);
        const target = ranked.length === 0 ? 'CASH' : (() => { const top = ranked.slice(0, 2); const o = {}; top.forEach((c) => (o[c] = 1 / top.length)); return o; })();
        const curTop = holdings && holdings !== 'CASH' ? Object.keys(holdings)[0] : null;
        const newTop = target && target !== 'CASH' ? Object.keys(target)[0] : null;
        const should = !holdings || holdings === 'CASH' ? true : (newTop !== curTop && (sc[newTop] - (sc[curTop] || -999)) >= 0.15);
        if (should && JSON.stringify(target) !== JSON.stringify(holdings)) { holdings = target; sw++; }
      }
    }
    return { curve, sw };
  }

  console.log('模型                全期收益   夏普    回撤      样本外(20日)  调仓');
  console.log(`静态等权(基准)      ${String(eqStats.total + '%').padStart(7)} ${String(eqStats.sharpe).padStart(5)} ${String(eqStats.mdd + '%').padStart(8)} ${String(eqStats.oos + '%').padStart(10)}   0`);
  for (const mt of ['lite', 'attention', 'fused', 'momentum', 'momtrend']) {
    const { curve, sw } = backtest(mt);
    const s = stats(curve);
    const beat = s.total > eqStats.total ? '✓' : '✗';
    const label = { lite: 'LSTM-Lite', attention: 'LSTM-Attention', fused: '融合(ProMax)', momentum: '纯动量Top2', momtrend: '动量+趋势过滤' }[mt];
    console.log(`${label.padEnd(18)} ${String(s.total + '%').padStart(7)} ${String(s.sharpe).padStart(5)} ${String(s.mdd + '%').padStart(8)} ${String(s.oos + '%').padStart(10)}   ${sw}  ${beat}`);
  }
  console.log('\n✓=全期跑赢等权基准; 样本外(20日)>0 且接近等权说明模型稳健不过拟合');
})();
