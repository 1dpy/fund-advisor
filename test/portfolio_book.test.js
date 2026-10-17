/**
 * 组合账本单元测试 — 现金/市值/盈亏/波动/赛道 的口径验证
 *
 * 这些口径错了会直接导致: 推荐买入超出手里的钱 / 该止损的不止损 /
 * 单赛道堆到 60% 还以为分散了。所以每一项都按"事实"而不是"实现"来断言。
 */

// ★ 冷却期记录会写文件, 必须在 require 之前把路径指到临时目录, 绝不碰用户 data/
process.env.RECENT_SELLS_FILE = require('path').join(
  require('os').tmpdir(), `recent_sells_${process.pid}.json`);

const assert = require('assert');
const {
  buildBook, marketValueOf, profitRatio, profitRatioDetailed,
  annualizedVol, volPositionScale, adaptiveStopLoss, peakSince,
  sectorOf, sectorExposure, clamp, num,
  loadRecentSells, recordStopLossSells, inSellCooldown,
} = require('../src/portfolio_book');
const { BUDGET, RISK_CONFIG, WATCHLIST } = require('../src/config');

let pass = 0;
function ok(name, cond) { assert.ok(cond, `❌ ${name}`); console.log(`  ✅ ${name}`); pass++; }
function eq(name, a, b) { assert.strictEqual(a, b, `❌ ${name} (实际 ${a}, 期望 ${b})`); console.log(`  ✅ ${name}`); pass++; }
function near(name, a, b, tol = 1e-6) {
  assert.ok(Math.abs(a - b) <= tol, `❌ ${name} (实际 ${a}, 期望 ≈${b})`);
  console.log(`  ✅ ${name}`); pass++;
}

console.log('== 组合账本单元测试 ==\n');

// -------------------------------------------------------------
console.log('【1. 现金账本: 两种口径分支】');

// 1.1 有现金条目 → 以实际持有现金为准, 不超发
const withCash = [
  { code: 'F1', type: 'fund', costBasis: 2910.98, currentValue: 2910.98 },
  { code: 'CASH', type: 'cash', costBasis: 3269.26, currentValue: 2269.26 },
];
const b1 = buildBook(withCash, 5500);
near('已投市值按 currentValue 计', b1.fundValue, 2910.98);
near('手头现金按 currentValue 计', b1.cashValue, 2269.26);
eq('现金被显式跟踪', b1.cashTracked, true);
near('可投 = min(手头现金, 预算剩余)', b1.deployable, 2269.26);
ok('可投不超过手头现金', b1.deployable <= b1.cashValue + 1e-9);
ok('可投不超过预算剩余', b1.deployable <= b1.headroom + 1e-9);

// 1.2 关键回归: ΣcostBasis > BUDGET 时老口径算出负数, 新口径不得为负
const oldStyle = 5500 - withCash.reduce((s, h) => s + h.costBasis, 0);
ok(`老口径确实为负 (¥${oldStyle.toFixed(2)})`, oldStyle < 0);
ok('新口径不为负', b1.deployable >= 0);

// 1.3 无现金条目 → 预算剩余视为可用现金
const noCash = [{ code: 'F1', type: 'fund', costBasis: 4000, currentValue: 4000 }];
const b2 = buildBook(noCash, 5500);
eq('无现金条目时 cashTracked=false', b2.cashTracked, false);
near('无现金条目时 可投 = 预算剩余', b2.deployable, 1500);

// 1.4 已投超预算 → 可投为 0, 不为负
const over = [{ code: 'F1', type: 'fund', costBasis: 6000, currentValue: 6000 }];
const b3 = buildBook(over, 5500);
eq('已投超预算时可投为 0', b3.deployable, 0);
eq('headroom 不为负', b3.headroom, 0);

// 1.5 现金条目不得被当成可交易基金
eq('现金条目被剔除出 fundHoldings', b1.fundHoldings.length, 1);
eq('现金条目归入 cashHoldings', b1.cashHoldings.length, 1);

// 1.6 currentValue 缺失时退化到 costBasis
eq('市值缺失时退化到成本', marketValueOf({ costBasis: 500 }), 500);
eq('市值优先于成本', marketValueOf({ costBasis: 500, currentValue: 400 }), 400);
eq('空对象 → 0', marketValueOf(null), 0);
eq('负数成本 → 0 (不产生负市值)', marketValueOf({ costBasis: -100 }), 0);

// -------------------------------------------------------------
console.log('\n【2. 盈亏率 fallback 链】');

// 2.1 一级: shares × 现价
near('份额口径', profitRatio({ costBasis: 1000, shares: 920 }, 1.0), -0.08);
eq('份额口径的 source', profitRatioDetailed({ costBasis: 1000, shares: 920 }, 1.0).source, 'shares');

// 2.2 二级: 市值 / 成本 (份额缺失)
//   实测 019018: currentValue 399.73 / costBasis 464.64 = -13.97%
near('市值口径', profitRatio({ costBasis: 464.64, shares: 0, currentValue: 399.73 }, 0), -0.1397, 1e-3);
eq('市值口径的 source', profitRatioDetailed({ costBasis: 464.64, shares: 0, currentValue: 399.73 }, 0).source, 'marketValue');

// 2.3 三级: 人工录入的 holdingReturnPct
near('录入口径', profitRatio({ costBasis: 1000, shares: 0, holdingReturnPct: -0.12 }, 0), -0.12);
eq('录入口径的 source', profitRatioDetailed({ costBasis: 1000, shares: 0, holdingReturnPct: -0.12 }, 0).source, 'recorded');

// 2.4 优先级: 份额口径优先于市值口径 (即使两者不一致)
const both = { costBasis: 1000, shares: 950, currentValue: 999 };
near('份额口径优先', profitRatio(both, 1.0), -0.05);
eq('优先级正确', profitRatioDetailed(both, 1.0).source, 'shares');

// 2.5 边界: 无从判断时记 0, 不臆造
eq('全缺失 → 0', profitRatio({ costBasis: 1000 }, 0), 0);
eq('全缺失 source=unknown', profitRatioDetailed({ costBasis: 1000 }, 0).source, 'unknown');
eq('成本为 0 → 0 (避免除零)', profitRatio({ costBasis: 0, shares: 100 }, 1.0), 0);
eq('空持仓 → 0', profitRatio(null, 1.0), 0);

// 2.6 关键回归: 份额缺失不得把浮亏抹平成 0
//   修复前 shares<=0 → profitPct=0 → 击穿 -8% 也不止损
const deepLoss = { costBasis: 1000, shares: 0, currentValue: 900 };
ok('份额缺失时仍能算出 -10% 浮亏', profitRatio(deepLoss, 0) <= -0.08);

// -------------------------------------------------------------
console.log('\n【3. 波动率与自适应止损】');

function mkHist(n, vol, seed = 7) {
  let s = seed, v = 1;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const out = [];
  for (let i = 0; i < n; i++) {
    v = v * (1 + (rnd() - 0.5) * vol);
    out.push({ date: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`, nav: v });
  }
  return out;
}

// 注意: rnd 是均匀分布, 日 std = range/√12, 年化还要 ×√252。
//   range=0.12 → 日 std 0.0346 → 年化约 55%, 芯片基金的量级。
const lowVol = mkHist(120, 0.004);     // 年化约 1.8%
const highVol = mkHist(120, 0.12);     // 年化约 55%
const vLow = annualizedVol(lowVol);
const vHigh = annualizedVol(highVol);
ok(`低波动序列波动率 ${(vLow * 100).toFixed(1)}% < 高波动 ${(vHigh * 100).toFixed(1)}%`, vLow < vHigh);
ok('高波动序列年化波动 > 40%', vHigh > 0.40);

const sLow = adaptiveStopLoss(lowVol, -0.08);
const sHigh = adaptiveStopLoss(highVol, -0.08);
ok(`高波动止损线更宽 (${(sHigh * 100).toFixed(1)}% vs ${(sLow * 100).toFixed(1)}%)`, sHigh < sLow);
// 止损线是负数, 用绝对值判断限幅: 至少 4%(防过紧被日常震荡扫出), 至多 15%(防放任亏损)
ok(`止损幅度在 [4%, 15%] 内 (低波 ${(Math.abs(sLow) * 100).toFixed(1)}%, 高波 ${(Math.abs(sHigh) * 100).toFixed(1)}%)`,
  Math.abs(sLow) >= 0.04 - 1e-9 && Math.abs(sLow) <= 0.15 + 1e-9
  && Math.abs(sHigh) >= 0.04 - 1e-9 && Math.abs(sHigh) <= 0.15 + 1e-9);
ok('自适应线恒为负', sLow < 0 && sHigh < 0);

// 算不出波动时用基准, 不乱动
eq('序列过短 → 用基准', adaptiveStopLoss([{ nav: 1 }], -0.08), -0.08);
eq('完全无波动 → 用基准', adaptiveStopLoss(Array.from({ length: 50 }, () => ({ nav: 1 })), -0.08), -0.08);
eq('序列过短时波动率为 0', annualizedVol([{ nav: 1 }, { nav: 2 }]), 0);

// 限幅边界
const extreme = mkHist(200, 0.5);
const extremeLine = adaptiveStopLoss(extreme, -0.08);
ok(`极端波动下限幅生效 (${(Math.abs(extremeLine) * 100).toFixed(1)}% ≤ 15%)`,
  Math.abs(extremeLine) <= 0.15 + 1e-9);

// -------------------------------------------------------------
console.log('\n【4. 赛道归属与敞口】');

// 4.1 WATCHLIST 里的基金能反查到赛道
eq('008282 → aiChip', sectorOf('008282'), 'aiChip');
eq('021277 → globalTech', sectorOf('021277'), 'globalTech');
eq('007028 → defense', sectorOf('007028'), 'defense');
eq('未收录代码 → null', sectorOf('999999'), null);
eq('空值 → null', sectorOf(null), null);

// 4.2 WATCHLIST 每个赛道至少有一只被正确反查
for (const [sector, list] of Object.entries(WATCHLIST)) {
  if (!Array.isArray(list) || list.length === 0) continue;
  eq(`${sector} 反查一致`, sectorOf(list[0].code), sector);
}

// 4.3 敞口合计
const holds = [
  { code: '008282', type: 'fund', currentValue: 500 },
  { code: '017470', type: 'fund', currentValue: 300 },
  { code: '007028', type: 'fund', currentValue: 200 },
];
near('aiChip 敞口 = 500+300', sectorExposure(holds, 'aiChip'), 800);
near('defense 敞口 = 200', sectorExposure(holds, 'defense'), 200);
near('未持有赛道敞口 = 0', sectorExposure(holds, 'newEnergy'), 0);
eq('空赛道名 → 0', sectorExposure(holds, null), 0);

// -------------------------------------------------------------
console.log('\n【5. 波动率倒数仓位系数】');
// 同样的信号强度, 高波动品种应拿到更小的仓位 —— 否则组合系统性超配高波动基金,
// 收益没多拿, 回撤先翻倍。
const scaleLow = volPositionScale(lowVol);
const scaleHigh = volPositionScale(highVol);
ok(`高波动仓位系数更小 (${scaleHigh.toFixed(2)} < ${scaleLow.toFixed(2)})`, scaleHigh < scaleLow);
ok('低波动系数 ≤ 1.5 (上限)', scaleLow <= 1.5 + 1e-9);
ok('高波动系数 ≥ 0.5 (下限, 不至于小到没意义)', scaleHigh >= 0.5 - 1e-9);
eq('算不出波动时不调整', volPositionScale([{ nav: 1 }]), 1.0);
eq('无波动序列不调整', volPositionScale(Array.from({ length: 50 }, () => ({ nav: 1 }))), 1.0);
ok('极端波动下限幅', volPositionScale(extreme) >= 0.5 - 1e-9);

// -------------------------------------------------------------
console.log('\n【6. 止损冷却期 (防反复打脸)】');
const tmpSells = process.env.RECENT_SELLS_FILE;
try { require('fs').unlinkSync(tmpSells); } catch (e) {}

eq('无记录时不在冷却期', inSellCooldown('008282', 5), false);

recordStopLossSells(['008282', '017470']);
const sold = loadRecentSells();
ok('止损卖出已记录', !!sold['008282'] && !!sold['017470']);
ok('记录的是今天', sold['008282'] === new Date().toISOString().slice(0, 10));
ok('止损后进入冷却期', inSellCooldown('008282', 5));
ok('未卖出的不在冷却期', !inSellCooldown('014419', 5));

// 冷却天数边界: 0 天 = 不启用
eq('冷却天数 0 时不生效', inSellCooldown('008282', 0), false);
eq('空 code → false', inSellCooldown(null, 5), false);

// 过期后解除: 手动把日期改到 10 天前
const stale = { '008282': new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10) };
ok('超过冷却天数后解除', !inSellCooldown('008282', 5, stale));
ok('仍在冷却期内则拦截', inSellCooldown('008282', 5, { '008282': new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10) }));
ok('坏日期不误判', !inSellCooldown('008282', 5, { '008282': 'not-a-date' }));

// 空/损坏文件不得抛错, 也不得拦住一切
recordStopLossSells([]);
recordStopLossSells(null);
ok('空输入不写坏数据', typeof loadRecentSells() === 'object');

try { require('fs').unlinkSync(tmpSells); } catch (e) {}

// -------------------------------------------------------------
console.log('\n【6.5 持仓期峰值 peakSince (移动止盈的基准)】');
// 原实现 holding.peakPrice || max(现价, 买入价), 而 peakPrice 从未被写入过,
// 于是 drawdownFromPeak 恒为 0 → 移动止盈自 V4.1 起就是死代码。
{
  const seq = [
    { date: '2026-08-01', nav: 1.00 },
    { date: '2026-08-15', nav: 1.40 },   // ← 峰值
    { date: '2026-09-01', nav: 1.30 },
    { date: '2026-09-20', nav: 1.20 },
  ];
  near('买入日之后取真实峰值', peakSince(seq, '2026-08-10', 1.0), 1.40, 1e-9);
  near('建仓前的高点不计入', peakSince(seq, '2026-08-20', 1.0), 1.30, 1e-9);
  near('无买入日 → 最近一段最高', peakSince(seq, null, 1.0), 1.40, 1e-9);
  near('空历史 → 退化为 fallback', peakSince([], '2026-08-10', 1.0), 1.0, 1e-9);
  // 买入日在未来(脏数据/时区问题) → 筛不到区间, 退化为最近一段最高价,
  //   比直接退回买入价更贴近现实, 也不会因为一条脏日期就完全失去峰值保护
  near('买入日之后无数据 → 退化为最近一段最高', peakSince(seq, '2027-01-01', 1.05), 1.40, 1e-9);
  near('nav 字段缺失时读 close',
    peakSince([{ date: '2026-08-01', close: 2.5 }], '2026-07-01', 1), 2.5, 1e-9);
  ok('脏点(nav<=0/NaN)被忽略',
    peakSince([{ date: '2026-08-01', nav: -1 }, { date: '2026-08-02', nav: 0 },
      { date: '2026-08-03', nav: Number.NaN }, { date: '2026-08-04', nav: 1.8 }],
      '2026-07-01', 1.0) === 1.8);
  near('等比缩放后峰值同比缩放',
    peakSince(seq.map(r => ({ ...r, nav: r.nav * 2 })), '2026-08-10', 1.0), 2.80, 1e-9);
}

// ---------------------------------------------------------------
console.log('\n【7. 数值工具】');
eq('num 正常', num('3.5'), 3.5);
eq('num(NaN) → 0', num('abc'), 0);
eq('num(undefined) → 0', num(undefined), 0);
eq('num(Infinity) → 0', num(Infinity), 0);
eq('clamp 上限', clamp(10, 0, 5), 5);
eq('clamp 下限', clamp(-10, 0, 5), 0);
eq('clamp 区间内', clamp(3, 0, 5), 3);

// -------------------------------------------------------------
console.log('\n【8. 与 config 的一致性】');
ok('maxSingleSector 已定义且合理', RISK_CONFIG.maxSingleSector > 0 && RISK_CONFIG.maxSingleSector <= 1);
ok('单赛道上限 ≥ 单只上限 (否则单只永远买不满)',
  RISK_CONFIG.maxSingleSector >= RISK_CONFIG.maxSinglePosition);
ok('加仓下界为负 (允许浅亏加仓)', RISK_CONFIG.addPositionMinPct < 0);
ok('加仓下界在止损线之内 (深亏不加)',
  RISK_CONFIG.addPositionMinPct > RISK_CONFIG.stopLossRatio);
ok('恐慌时下界更宽松', RISK_CONFIG.addPositionMinPctFear < RISK_CONFIG.addPositionMinPct);
ok('费率保护天数 = 7 (C类赎回费门槛)', RISK_CONFIG.addPositionFeeSafeDays === 7);
ok('止损冷却天数已定义且合理', RISK_CONFIG.sellCooldownDays > 0 && RISK_CONFIG.sellCooldownDays <= 30);

console.log(`\n✅ 组合账本单测全部通过 (${pass} 项)`);
