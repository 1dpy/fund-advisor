/**
 * PROFIT_FIRST 赚钱优先策略 · 真实净值回测
 * 数据源: cache/backtest_history.json (eastmoney 真实基金净值)
 *
 * 策略规则 (贴合 advisor_v5_ultimate PROFIT_FIRST):
 *   1. 广发全球精选C(021277) = 压舱石, 锁定持有不动
 *   2. 盈利仓(市值>成本)在再平衡时落袋(卖出超配部分)
 *   3. 亏损仓(市值<成本)再平衡时不减仓(不割肉)
 *   4. 闲置现金在"回调日"(沪深300当日下跌)部署到沪深300/黄金
 *   5. 每5个交易日再平衡到目标权重
 *
 * 对比基准: 等权买入持有 (5资产各20%, 持有不动)
 */
const fs = require('fs');
const path = require('path');

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache', 'backtest_history.json'), 'utf8'));
const F = DATA.funds;

const GROWTH = ['019018', '014419', '027495', '012718']; // 科技成长池(等权)
const VALUE = '007028';   // 沪深300 (价值代理)
const DEFENSE = '014418'; // 黄金 (防御代理)
const GLOBAL = '021277';  // 广发全球 (压舱石)

function navMap(code) { const m = {}; for (const r of F[code].history) m[r.date] = r.nav; return m; }
const NM = {};
for (const c of [...GROWTH, VALUE, DEFENSE, GLOBAL]) NM[c] = navMap(c);
const CHG = {};
for (const c of [...GROWTH, VALUE, DEFENSE, GLOBAL]) {
  const h = F[c].history; CHG[c] = {};
  for (let i = 1; i < h.length; i++) { const a = h[i - 1].nav, b = h[i].nav; CHG[c][h[i].date] = a ? (b - a) / a * 100 : 0; }
}

// 公共交易日 (所有资产都有数据)
const set = new Set();
for (const c of [...GROWTH, VALUE, DEFENSE, GLOBAL]) for (const r of F[c].history) set.add(r.date);
const DATES = [...set].sort().filter(d => [...GROWTH, VALUE, DEFENSE, GLOBAL].every(c => NM[c][d]));

const INIT = 4754; // 你实际初始总投入
const W = { growth: 0.25, value: 0.25, defense: 0.15, cash: 0.10 };
const WG = 0.25;   // 广发压舱石占比(不参与再平衡)

const pos = {}; let cash = 0, trades = 0;
const nav = (c, d) => NM[c][d];
function buy(c, amt, d) { const n = nav(c, d); if (!n) return; const sh = amt / n; if (pos[c]) { pos[c].shares += sh; pos[c].cost += amt; } else pos[c] = { shares: sh, cost: amt }; }
function codesOf(a) { return a === 'growth' ? GROWTH : a === 'value' ? [VALUE] : a === 'defense' ? [DEFENSE] : a === 'global' ? [GLOBAL] : [a]; }
function buyAsset(a, amt, d) { if (amt < 1) return; const cs = codesOf(a); for (const c of cs) buy(c, amt / cs.length, d); trades++; }
function sellAsset(a, amt, d) { if (amt < 1) return; const cs = codesOf(a); for (const c of cs) { const n = nav(c, d); if (!n || !pos[c]) continue; const sv = amt / cs.length; const ss = Math.min(pos[c].shares, sv / n); const ratio = pos[c].shares > 0 ? ss / pos[c].shares : 0; pos[c].cost *= (1 - ratio); pos[c].shares -= ss; cash += ss * n; } trades++; }
function assetVal(a, d) { return codesOf(a).reduce((s, c) => s + (pos[c] ? pos[c].shares * nav(c, d) : 0), 0); }
function assetCost(a) { return codesOf(a).reduce((s, c) => s + (pos[c] ? pos[c].cost : 0), 0); }

function rebalance(d, total, i) {
  const t = { growth: total * W.growth, value: total * W.value, defense: total * W.defense, cash: total * W.cash };
  for (const a of ['growth', 'value', 'defense']) {
    const cur = assetVal(a, d); const delta = t[a] - cur;
    if (delta < 0) { if (cur <= assetCost(a) * 1.005) continue; sellAsset(a, -delta, d); }
    else if (delta > 0) { const fc = Math.min(delta, cash); if (fc > 1) { buyAsset(a, fc, d); cash -= fc; } }
  }
  // 现金部署: 超目标且沪深300当日下跌(回调日) -> 部署一半value一半defense
  if (cash > t.cash * 1.25) { const vd = CHG[VALUE][d] || 0; if (vd < 0) { const dep = cash - t.cash; buyAsset('value', dep * 0.5, d); cash -= dep * 0.5; buyAsset('defense', dep * 0.5, d); cash -= dep * 0.5; } }
}

// 建仓 (PROFIT_FIRST 目标权重)
buy(GLOBAL, INIT * WG, DATES[0]);
for (const c of GROWTH) buy(c, INIT * W.growth / GROWTH.length, DATES[0]);
buy(VALUE, INIT * W.value, DATES[0]);
buy(DEFENSE, INIT * W.defense, DATES[0]);
cash = INIT * W.cash;

const daily = [];
for (let i = 0; i < DATES.length; i++) {
  const d = DATES[i];
  const total = assetVal('growth', d) + assetVal('value', d) + assetVal('defense', d) + assetVal('global', d) + cash;
  daily.push({ date: d, total, g: assetVal('growth', d), v: assetVal('value', d), de: assetVal('defense', d), gl: assetVal('global', d), cash });
  if (i > 0 && i % 5 === 0) rebalance(d, total, i);
}

// 基准: 等权买入持有 (5资产各20%, 持有不动)
const bh = {};
for (const c of GROWTH) bh[c] = (INIT * 0.2 / GROWTH.length) / nav(c, DATES[0]);
bh[GLOBAL] = (INIT * 0.2) / nav(GLOBAL, DATES[0]);
bh[VALUE] = (INIT * 0.2) / nav(VALUE, DATES[0]);
bh[DEFENSE] = (INIT * 0.2) / nav(DEFENSE, DATES[0]);
const bhDaily = DATES.map(d => { let t = 0; for (const c in bh) t += bh[c] * nav(c, d); return { date: d, total: t }; });

function stat(arr) {
  const init = arr[0].total, fin = arr[arr.length - 1].total;
  const ret = (fin - init) / init * 100;
  let peak = init, mdd = 0;
  for (const x of arr) { if (x.total > peak) peak = x.total; const dd = (x.total - peak) / peak * 100; if (dd < mdd) mdd = dd; }
  let up = 0; for (let i = 1; i < arr.length; i++) if (arr[i].total > arr[i - 1].total) up++;
  return { init, fin, ret, mdd, wr: arr.length > 1 ? up / (arr.length - 1) * 100 : 0 };
}

const pf = stat(daily), bhS = stat(bhDaily), alpha = pf.ret - bhS.ret;

console.log('═══════════════════════════════════════════════════');
console.log('  PROFIT_FIRST 赚钱优先 · 真实净值回测');
console.log('═══════════════════════════════════════════════════');
console.log(`  回测区间: ${DATES[0]} ~ ${DATES[DATES.length - 1]} (${DATES.length}个交易日)`);
console.log(`  初始资金: ¥${INIT}`);
console.log('');
console.log('  ┌─────────────────┬──────────────┬──────────┬──────────┬────────┐');
console.log('  │ 策略            │ 最终市值     │ 收益率   │ 最大回撤 │ 胜率   │');
console.log('  ├─────────────────┼──────────────┼──────────┼──────────┼────────┤');
console.log(`  │ PROFIT_FIRST     │ ¥${pf.fin.toFixed(0).padStart(10)} │ ${pf.ret.toFixed(1).padStart(6)}% │ ${pf.mdd.toFixed(1).padStart(6)}% │ ${pf.wr.toFixed(0).padStart(5)}% │`);
console.log(`  │ 买入持有(等权)   │ ¥${bhS.fin.toFixed(0).padStart(10)} │ ${bhS.ret.toFixed(1).padStart(6)}% │ ${bhS.mdd.toFixed(1).padStart(6)}% │ ${bhS.wr.toFixed(0).padStart(5)}% │`);
console.log('  └─────────────────┴──────────────┴──────────┴──────────┴────────┘');
console.log('');
console.log(`  ★ PROFIT_FIRST 超额收益(Alpha): ${alpha >= 0 ? '+' : ''}${alpha.toFixed(1)}% vs 买入持有`);
console.log(`  ★ 再平衡交易次数: ${trades} 次`);
console.log(`  ★ 你实际当前市值(人工减仓后): ¥4200 (初始¥${INIT}, 人工操作亏 ${((4200 - INIT) / INIT * 100).toFixed(1)}%)`);
console.log('');
console.log('  每日市值(PROFIT_FIRST):');
for (const d of daily) console.log(`    ${d.date}  总¥${d.total.toFixed(0).padStart(6)}  G¥${d.g.toFixed(0)} V¥${d.v.toFixed(0)} D¥${d.de.toFixed(0)} 广发¥${d.gl.toFixed(0)} 现¥${d.cash.toFixed(0)}`);
console.log('═══════════════════════════════════════════════════');
