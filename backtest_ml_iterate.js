/**
 * ML 策略迭代回测 — 找出"跑赢等权基准 + 回撤可控"的最优配置
 *
 * 优化: 预计算每个调仓日的 ML 分一次, 所有变体复用 (省时)
 * 变体维度:
 *   topK        持前几名 (1=集中 / 2=分散)
 *   thr         切换阈值 (新第一名须比当前高 thr 才换, 减少无效调仓)
 *   weighting   'equal'等权 / 'score'按mlScore加权
 *   negToCash   所有候选 mlScore<0 时持现金 (择时门)
 *   stopLoss    持仓自高点回撤>X% 强制换仓/持币
 * 用法: node backtest_ml_iterate.js
 */

const { fetchNavHistory, scoreFund } = require('./src/ml_sector_selector');
const { PREFERRED_SECTORS } = require('./src/config');

const START = 40, REBAL = 5;

function stats(curve, switches) {
  const total = curve[curve.length - 1] - 1;
  const rets = []; for (let i = 1; i < curve.length; i++) rets.push(curve[i] / curve[i - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, v) => s + (v - m) ** 2, 0) / rets.length);
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(252) : 0;
  let peak = curve[0], mdd = 0; curve.forEach((v) => { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); });
  return { total: +(total * 100).toFixed(2), sharpe: +sharpe.toFixed(2), mdd: +(mdd * 100).toFixed(2), switches };
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
  console.log(`区间 ${commonDates[START]}~${commonDates[N - 1]} (${N - START}日, ${codes.length}赛道) — 预计算ML分...`);

  // 预计算每个调仓日的 ML 分
  const rebalDates = []; for (let t = START; t < N; t += REBAL) rebalDates.push(t);
  const scoresAt = {};
  for (const t of rebalDates) {
    scoresAt[t] = {};
    for (const c of codes) {
      const closes = closesByCode[c].slice(0, t + 1);
      scoresAt[t][c] = closes.length < 40 ? -999 : scoreFund(closes).mlScore;
    }
  }
  console.log('预计算完成, 开始回测各变体\n');

  function runStrategy(cfg) {
    let nav = 1; const curve = []; let holdings = null; let switches = 0; const peakNav = {};
    for (let t = START; t < N; t++) {
      // 当日组合收益
      let r = 0;
      if (holdings) {
        if (holdings === 'CASH') r = 0;
        else for (const [c, w] of Object.entries(holdings)) r += w * (closesByCode[c][t] / closesByCode[c][t - 1] - 1);
      }
      nav *= 1 + r; curve.push(nav);

      // 移动止损: 任一持仓自其成本高点回撤>stopLoss -> 下期持币
      if (cfg.stopLoss && holdings && holdings !== 'CASH') {
        for (const c of Object.keys(holdings)) {
          peakNav[c] = Math.max(peakNav[c] || 0, closesByCode[c][t]);
          if (closesByCode[c][t] / peakNav[c] - 1 < -cfg.stopLoss) { holdings = 'CASH'; switches++; break; }
        }
      }

      // 调仓日: 用预计算分数定下一期持仓
      if ((t - START) % REBAL === 0) {
        const sc = scoresAt[t];
        const ranked = codes.slice().sort((a, b) => sc[b] - sc[a]).filter((c) => sc[c] > -900);
        const valid = cfg.negToCash ? ranked.filter((c) => sc[c] > 0) : ranked.slice(0, cfg.topK);
        let target = null;
        if (valid.length === 0) target = 'CASH';
        else {
          const top = valid.slice(0, cfg.topK);
          if (cfg.weighting === 'score') {
            const ws = top.map((c) => Math.max(0.01, sc[c])); const sum = ws.reduce((a, b) => a + b, 0);
            target = {}; top.forEach((c, i) => (target[c] = ws[i] / sum));
          } else { target = {}; top.forEach((c) => (target[c] = 1 / top.length)); }
        }
        // 切换阈值: 仅当新第一名比当前第一名 mlScore 高 thr 才换
        const curTop = holdings && holdings !== 'CASH' ? Object.keys(holdings)[0] : null;
        const newTop = target && target !== 'CASH' ? Object.keys(target)[0] : null;
        const curScore = curTop ? sc[curTop] : -999;
        const newScore = newTop ? sc[newTop] : -999;
        const shouldSwitch = !holdings || holdings === 'CASH' ? true : (newTop !== curTop && (newScore - curScore) >= (cfg.thr || 0));
        if (shouldSwitch) {
          const changed = JSON.stringify(target) !== JSON.stringify(holdings);
          if (changed) { holdings = target; switches++; }
        }
      }
    }
    return stats(curve, switches);
  }

  const variants = [
    { name: '静态等权(基准)', staticEq: true },
    { name: '静态半导体', staticSingle: true },
    { name: 'ML Top1 全仓', topK: 1, thr: 0, weighting: 'equal', negToCash: false },
    { name: 'ML Top1 阈值0.15', topK: 1, thr: 0.15, weighting: 'equal', negToCash: false },
    { name: 'ML Top1 阈值0.30', topK: 1, thr: 0.30, weighting: 'equal', negToCash: false },
    { name: 'ML Top2 等权 阈0.15', topK: 2, thr: 0.15, weighting: 'equal', negToCash: false },
    { name: 'ML Top2 等权+空仓门', topK: 2, thr: 0.15, weighting: 'equal', negToCash: true },
    { name: 'ML Top2 加权+空仓门', topK: 2, thr: 0.15, weighting: 'score', negToCash: true },
    { name: 'ML Top2 +止损8%', topK: 2, thr: 0.15, weighting: 'equal', negToCash: true, stopLoss: 0.08 },
  ];

  console.log('变体                    总收益     夏普    最大回撤   调仓');
  const rows = [];
  for (const v of variants) {
    let res;
    if (v.staticEq) {
      let nav = 1; const curve = [];
      for (let t = START; t < N; t++) { let r = 0; codes.forEach((c) => (r += closesByCode[c][t] / closesByCode[c][t - 1] - 1)); nav *= 1 + r / codes.length; curve.push(nav); }
      res = stats(curve, 0);
    } else if (v.staticSingle) {
      let nav = 1; const curve = []; const f = PREFERRED_SECTORS[0].code;
      for (let t = START; t < N; t++) { nav *= closesByCode[f][t] / closesByCode[f][t - 1]; curve.push(nav); }
      res = stats(curve, 0);
    } else {
      res = runStrategy(v);
    }
    rows.push({ name: v.name, ...res });
    console.log(`${v.name.padEnd(20)} ${String(res.total + '%').padStart(8)} ${String(res.sharpe).padStart(6)} ${String(res.mdd + '%').padStart(9)} ${String(res.switches).padStart(5)}`);
  }

  const eqRet = rows[0].total;
  const mlRows = rows.filter((r) => r.name.startsWith('ML'));
  const bestMl = mlRows.reduce((a, b) => (b.sharpe > a.sharpe ? b : a));
  console.log(`\n等权基准收益: ${eqRet}%`);
  console.log(`最优ML变体: ${bestMl.name}  收益${bestMl.total}% 夏普${bestMl.sharpe} 回撤${bestMl.mdd}%`);
  const beats = mlRows.filter((r) => r.total > eqRet);
  console.log(`跑赢等权的ML变体: ${beats.length}/${mlRows.length}${beats.length ? ' → ' + beats.map((b) => b.name).join(', ') : ''}`);
  console.log(bestMl.total > eqRet ? `\n✓ 建议接入实盘: "${bestMl.name}" 配置 (topK/阈值/加权/空仓门)` : `\n✗ ML暂未稳定跑赢等权, 先用静态等权/Top2, 继续迭代特征`);
})();
