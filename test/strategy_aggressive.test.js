/**
 * V6 激进引擎单元测试 — 动量/ATR/趋势判定/止损止盈/轮动/金字塔加仓/现金预算
 *
 * src/advisor_v6_aggressive.js 此前零测试, 而它是"激进科技增强版"实盘路径之一。
 * 本文件覆盖其纯函数决策点, 纯离线不联网; 被 CI 调用。
 */
const assert = require('assert');

const V6 = require('../src/advisor_v6_aggressive');
const { AGGRO_CONFIG } = V6;
const { FEE_CONFIG } = require('../src/config');

let pass = 0;
function ok(name, cond) { assert.ok(cond, '❌ ' + name); console.log('  ✅ ' + name); pass++; }
function eq(name, actual, expect) {
  assert.strictEqual(actual, expect, `❌ ${name}: 期望 ${expect}, 实际 ${actual}`);
  console.log('  ✅ ' + name); pass++;
}
function near(name, actual, expect, tol = 1e-6) {
  assert.ok(Math.abs(actual - expect) <= tol, `❌ ${name}: 期望 ≈${expect}, 实际 ${actual}`);
  console.log('  ✅ ' + name); pass++;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// 净值序列 -> computeIndicators 期望的 history
const mkHist = (navs) => navs.map((nav) => ({ date: '2026-01-01', nav }));
// 指标 Map
const mkInd = (entries) => new Map(Object.entries(entries));
const UP = { last: 30, ma: 20, momentum: 0.2, momentum5: 0.1, trendUp: true, atrPct: 0.03, week5Pct: 0.05 };
const DOWN = { last: 30, ma: 40, momentum: -0.2, momentum5: -0.1, trendUp: false, atrPct: 0.05, week5Pct: -0.1 };

console.log('== V6 激进引擎单元测试 ==\n');

// ---------------------------------------------------------------
console.log('【1. 指标计算 computeIndicators】');
eq('空输入 → null', V6.computeIndicators(null), null);
eq('样本<10 → null', V6.computeIndicators(mkHist([1, 2, 3])), null);
// 线性上涨 1..30
const navs30 = Array.from({ length: 30 }, (_, i) => i + 1);
const ind = V6.computeIndicators(mkHist(navs30));
near('上涨: momentum = (30-10)/10', ind.momentum, 2);
near('上涨: MA20 = 均值(11..30)', ind.ma, 20.5);
ok('上涨: trendUp = last > MA', ind.trendUp === true);
near('上涨: momentum5 = (30-25)/25', ind.momentum5, 0.2);
near('上涨: week5Pct 同 momentum5', ind.week5Pct, 0.2);
near('上涨: atrPct = 平均日波动/均价', ind.atrPct, (14 / 14) / (329 / 14), 1e-9);
// 线性下跌
const indDown = V6.computeIndicators(mkHist(navs30.slice().reverse()));
ok('下跌: momentum < 0', indDown.momentum < 0);
ok('下跌: trendUp = false', indDown.trendUp === false);
// 横盘 → ATR≈0
const indFlat = V6.computeIndicators(mkHist(Array.from({ length: 20 }, () => 5)));
near('横盘: atrPct = 0', indFlat.atrPct, 0);
near('横盘: momentum = 0', indFlat.momentum, 0);
// 样本刚好 10 点也能算
ok('10点样本可用', V6.computeIndicators(mkHist(navs30.slice(0, 10))) !== null);
// 脏点(nav<=0)不崩
ok('含 nav=0 不崩', Number.isFinite(V6.computeIndicators(mkHist([0, 0, 1, 2, 3, 4, 5, 6, 7, 8])).atrPct));

// ---------------------------------------------------------------
console.log('\n【2. 组合分析 analyzePortfolio】');
const pA = V6.analyzePortfolio([
  { type: 'fund', code: '008282', name: '国泰芯片ETF联接C', costBasis: 1000, currentValue: 1200, buyDate: daysAgo(60) },
  { type: 'fund', code: '021277', name: '广发全球精选QDII C', costBasis: 1000, currentValue: 1000, buyDate: daysAgo(60) },
  { type: 'fund', code: '014418', name: '博时黄金ETF联接C', costBasis: 500, currentValue: 500, buyDate: daysAgo(60) },
  { type: 'cash', name: '现金', currentValue: 300 },
], new Map());
eq('总资产 = 1200+1000+500+300', pA.totalAsset, 3000);
near('成长权重', pA.sectorWeights.growth, 1200 / 3000);
near('全球权重', pA.sectorWeights.global, 1000 / 3000);
// V6 与 V5 的关键差异: 科技集中度 = 成长 + 全球 (激进版把QDII也算作科技暴露)
near('科技集中度 = 成长 + 全球', pA.techConcentration, (1200 + 1000) / 3000);
near('浮盈比例', pA.funds[0].profitPct, 0.2);
const pE = V6.analyzePortfolio([], new Map());
eq('空组合 总资产=0', pE.totalAsset, 0);
eq('空组合 单票权重=0', pE.maxSingleWeight, 0);
ok('空组合 无 NaN', Number.isFinite(pE.techConcentration));

// ---------------------------------------------------------------
console.log('\n【3. 科技趋势判定 detectTechTrend】');
eq('全部在均线上方 → ratio=1 进攻', V6.detectTechTrend(mkInd({ a: UP, b: UP })).ratio, 1);
eq('全部在均线上方 → offense', V6.detectTechTrend(mkInd({ a: UP, b: UP })).offense, true);
eq('全部破位 → ratio=0', V6.detectTechTrend(mkInd({ a: DOWN, b: DOWN })).ratio, 0);
eq('全部破位 → 非进攻', V6.detectTechTrend(mkInd({ a: DOWN, b: DOWN })).offense, false);
eq('一半 → ratio=0.5 进攻', V6.detectTechTrend(mkInd({ a: UP, b: DOWN })).offense, true);
// 已知风险: 抓不到数据时(空 Map)默认 0.5 → 判定为进攻, 会照常金字塔加仓
const noData = V6.detectTechTrend(new Map());
eq('无数据 → ratio 兜底 0.5', noData.ratio, 0.5);
console.log('   ⚠️ 已知风险: 网络拉取失败时默认判定为"进攻", 会在无动量数据的情况下执行金字塔加仓');

// ---------------------------------------------------------------
console.log('\n【4. 赛道分类 classifySector (V6 口径)】');
eq('芯片 → growth', V6.classifySector('国泰芯片ETF联接C'), 'growth');
eq('军工 → growth', V6.classifySector('南方军工改革C'), 'growth');
eq('QDII → global', V6.classifySector('广发全球精选QDII C'), 'global');
eq('沪深300 → value', V6.classifySector('易方达沪深300ETF联接C'), 'value');
eq('黄金 → defense', V6.classifySector('博时黄金ETF联接C'), 'defense');
eq('未知名 → 默认 growth', V6.classifySector('某某混合C'), 'growth');

// ---------------------------------------------------------------
console.log('\n【5. 绝对底线: 科技全面破位】');
const hBreak = [
  { type: 'fund', code: '017470', name: '嘉实中证半导体C', costBasis: 10000, currentValue: 10000, buyDate: daysAgo(60) },
  { type: 'fund', code: '021277', name: '广发全球精选QDII C', costBasis: 20000, currentValue: 20000, buyDate: daysAgo(60) },
  { type: 'cash', name: '现金', currentValue: 5000 },
];
const pBreak = V6.analyzePortfolio(hBreak, new Map());
const opsBreak = V6.generateAggressiveOps(pBreak, new Map(), { ratio: 0, offense: false }).operations;
const conv = opsBreak.find((o) => o.action === 'CONVERT');
ok('全面破位 → 触发 CONVERT', !!conv);
eq('只动最重的科技仓(017470)', conv && conv.code, '017470');
eq('降仓金额封顶 800', conv && conv.amount, 800);
ok('转宽基防御', conv && String(conv.target).includes('沪深300'));
ok('QDII 不参与底线降仓(保留作分散)', !opsBreak.find((o) => o.code === '021277' && o.action === 'CONVERT'));
// 进攻模式下不触发
const opsNoBreak = V6.generateAggressiveOps(pBreak, new Map(), { ratio: 1, offense: true }).operations;
ok('进攻模式不触发底线', !opsNoBreak.find((o) => o.action === 'CONVERT'));

// ---------------------------------------------------------------
console.log('\n【6. 单周急跌 & ATR 动态止损】');
// 6.1 单周急跌(近5日 ≤ -18%) → 全额清仓; 持有<7天改为转换以避开1.5%赎回费
const hCrash = [
  { type: 'fund', code: 'NEW', name: '嘉实中证半导体C', costBasis: 1000, currentValue: 900, buyDate: daysAgo(3) },
  { type: 'fund', code: 'OLD', name: '西部利得芯片增强C', costBasis: 1000, currentValue: 900, buyDate: daysAgo(60) },
  { type: 'cash', name: '现金', currentValue: 50000 },
];
const indCrash = mkInd({
  NEW: { ...DOWN, week5Pct: -0.20, atrPct: 0.03 },
  OLD: { ...DOWN, week5Pct: -0.20, atrPct: 0.03 },
});
const opsCrash = V6.generateAggressiveOps(V6.analyzePortfolio(hCrash, indCrash), indCrash, { ratio: 1, offense: true }).operations;
eq('持有3天 + 单周急跌 → CONVERT(避1.5%赎回费)', opsCrash.find((o) => o.code === 'NEW').action, 'CONVERT');
eq('持有60天 + 单周急跌 → SELL', opsCrash.find((o) => o.code === 'OLD').action, 'SELL');
eq('急跌清仓为全额(900)', opsCrash.find((o) => o.code === 'OLD').amount, 900);

// 6.2 ATR 动态止损: 止损线 = min(-12%, -2*ATR%), 高波动容忍更大回撤
const mkStopCase = (profitPct, atrPct) => {
  const hh = [{ type: 'fund', code: 'X', name: '嘉实中证半导体C', costBasis: 1000, currentValue: 1000 * (1 + profitPct), buyDate: daysAgo(60) },
              { type: 'cash', name: '现金', currentValue: 50000 }];
  const im = mkInd({ X: { ...DOWN, atrPct, week5Pct: -0.01 } });
  return V6.generateAggressiveOps(V6.analyzePortfolio(hh, im), im, { ratio: 1, offense: true }).operations
    .find((o) => o.code === 'X');
};
eq('低波动(ATR3%) 亏13% → 触-12%止损 SELL', mkStopCase(-0.13, 0.03).action, 'SELL');
// 高波动: 止损线放宽到 -2*8% = -16%, 亏13% 不该被止损(不会被误杀在震荡里)
ok('高波动(ATR8%) 亏13% → 止损线放宽到-16%, 不误杀',
  !['SELL', 'CONVERT'].includes(mkStopCase(-0.13, 0.08).action));
eq('高波动(ATR8%) 亏17% → 触-16%止损 SELL', mkStopCase(-0.17, 0.08).action, 'SELL');
// 无指标数据时回退到固定 -12%
const imNone = new Map();
const hhNone = [{ type: 'fund', code: 'Y', name: '嘉实中证半导体C', costBasis: 1000, currentValue: 870, buyDate: daysAgo(60) },
                { type: 'cash', name: '现金', currentValue: 50000 }];
eq('无指标 → 回退固定-12%止损',
  V6.generateAggressiveOps(V6.analyzePortfolio(hhNone, imNone), imNone, { ratio: 1, offense: true })
    .operations.find((o) => o.code === 'Y').action, 'SELL');

// ---------------------------------------------------------------
console.log('\n【7. 止盈阶梯 (ATR 自适应移动止盈)】');
const mkProfitCase = (p, atrPct) => {
  const hh = [{ type: 'fund', code: 'P', name: '嘉实中证半导体C', costBasis: 1000, currentValue: 1000 * (1 + p), buyDate: daysAgo(60) },
              { type: 'cash', name: '现金', currentValue: 50000 }];
  const im = mkInd({ P: { ...UP, atrPct, week5Pct: 0.02 } });
  return V6.generateAggressiveOps(V6.analyzePortfolio(hh, im), im, { ratio: 1, offense: true }).operations
    .find((o) => o.code === 'P');
};
eq('+65% ≥ 天花板60% → 全部 SELL', mkProfitCase(0.65, 0.03).action, 'SELL');
eq('天花板止盈 = 全额 1650', mkProfitCase(0.65, 0.03).amount, 1650);
eq('+30% ≥ 25% → 部分 SELL', mkProfitCase(0.30, 0.03).action, 'SELL');
eq('部分止盈 = 30% = 390', mkProfitCase(0.30, 0.03).amount, Math.round(1300 * AGGRO_CONFIG.partialTakeProfitPct));
eq('+15% ≥ 12% → 移动止盈观察 HOLD', mkProfitCase(0.15, 0.03).action, 'HOLD');
ok('低波动: 回撤线取基准 8%', mkProfitCase(0.15, 0.02).reason.includes('8.0%'));
ok('高波动: 回撤线取 1.5*ATR = 15%', mkProfitCase(0.15, 0.10).reason.includes('15.0%'));

// ---------------------------------------------------------------
console.log('\n【8. 金字塔加仓: 档位选择】');
// 三个不同亏损深度的基金; 现金充足, 单票均未达上限
const mkPyramid = (profits, cash = 10000, fundValue = 30000) => {
  const hh = profits.map((p, i) => ({
    type: 'fund', code: 'F' + i, name: '嘉实中证半导体C',
    costBasis: Math.round(fundValue / (1 + p)), currentValue: fundValue, buyDate: daysAgo(60),
  })).concat([{ type: 'cash', name: '现金', currentValue: cash }]);
  const im = new Map();
  return V6.generateAggressiveOps(V6.analyzePortfolio(hh, im), im, { ratio: 0.5, offense: true });
};
const pyr = mkPyramid([-0.035, -0.065, -0.10]);
const buyOf = (code) => pyr.operations.find((o) => o.code === code && o.action === 'BUY');
// 修复前: 三档全部命中 -3% 档(pct=0.5), -6%/-9% 两档是死配置
eq('亏3.5% → 取 -3% 档 (50%预算)', buyOf('F0').amount, Math.round(10000 * 0.5 * 0.50));
eq('亏6.5% → 取 -6% 档 (30%预算)', buyOf('F1').amount, Math.round(10000 * 0.5 * 0.30));
eq('亏10% → 取 -9% 档 (20%预算)', buyOf('F2').amount, Math.round(10000 * 0.5 * 0.20));
// 越跌补得越少
ok('金额随亏损加深而递减', buyOf('F0').amount > buyOf('F1').amount && buyOf('F1').amount > buyOf('F2').amount);
// 浮亏未达 -3% 不加仓
ok('亏2% 未触档位 → 不加仓', !mkPyramid([-0.02]).operations.find((o) => o.code === 'F0' && o.action === 'BUY'));
// 防守模式不加仓
const pyrDef = V6.generateAggressiveOps(
  V6.analyzePortfolio([{ type: 'fund', code: 'F0', name: '嘉实中证半导体C', costBasis: 31000, currentValue: 30000, buyDate: daysAgo(60) },
                       { type: 'cash', name: '现金', currentValue: 10000 }], new Map()),
  new Map(), { ratio: 0.4, offense: false });
ok('防守模式不金字塔加仓', !pyrDef.operations.find((o) => o.action === 'BUY'));

// ---------------------------------------------------------------
console.log('\n【9. 现金预算: 不得推荐超出可用现金的买入】');
// 9.1 金字塔总额 ≤ 现金 50% (即使多个基金同时触档)
const pyrMany = mkPyramid([-0.035, -0.04, -0.045, -0.05], 10000, 13333);
const totalBuy = pyrMany.operations.filter((o) => o.action === 'BUY').reduce((s, o) => s + o.amount, 0);
ok(`金字塔加仓总额 ≤ 现金50% (实际 ¥${totalBuy} ≤ ¥5000)`, totalBuy <= 10000 * AGGRO_CONFIG.maxAddCashPct + 1);
ok(`买入总额 ≤ 可用现金 (实际 ¥${totalBuy} ≤ ¥10000)`, totalBuy <= 10000);

// 9.2 金字塔 + 杠铃同时触发时也不能超发现金
//     (修复前: 三只各 25% 现金 = 75%, 杠铃再花 cash-12%总资产, 合计可超 100% 现金)
const hhBoth = [
  { type: 'fund', code: 'A1', name: '嘉实中证半导体C', costBasis: 14000, currentValue: 13333, buyDate: daysAgo(60) },
  { type: 'fund', code: 'A2', name: '西部利得芯片增强C', costBasis: 14000, currentValue: 13333, buyDate: daysAgo(60) },
  { type: 'fund', code: 'A3', name: '国泰芯片ETF联接C', costBasis: 14000, currentValue: 13333, buyDate: daysAgo(60) },
  { type: 'cash', name: '现金', currentValue: 20000 },
];
const imBoth = mkInd({ '017470': { ...UP, momentum: 0.15 } }); // 杠铃目标: 半导体龙头
const opsBoth = V6.generateAggressiveOps(V6.analyzePortfolio(hhBoth, imBoth), imBoth, { ratio: 1, offense: true });
const buyBoth = opsBoth.operations.filter((o) => o.action === 'BUY').reduce((s, o) => s + o.amount, 0);
ok(`金字塔+杠铃合计 ¥${buyBoth} ≤ 可用现金 ¥20000`, buyBoth <= 20000);
ok('杠铃仍执行(未被预算误杀)', !!opsBoth.operations.find((o) => o.code === '017470' && o.action === 'BUY'));

// 9.3 杠铃买入不得把单票推过 35% 上限
const hhLimit = [
  { type: 'fund', code: '017470', name: '嘉实中证半导体C', costBasis: 28000, currentValue: 30000, buyDate: daysAgo(60) },
  { type: 'cash', name: '现金', currentValue: 60000 },
];
const imLimit = mkInd({ '017470': { ...UP, momentum: 0.15 } });
const portLimit = V6.analyzePortfolio(hhLimit, imLimit);
const opsLimit = V6.generateAggressiveOps(portLimit, imLimit, { ratio: 1, offense: true }).operations;
const barbell = opsLimit.find((o) => o.code === '017470' && o.action === 'BUY');
ok('杠铃触发买入', !!barbell);
near('买入后单票权重 ≤ 35%', (30000 + barbell.amount) / portLimit.totalAsset, AGGRO_CONFIG.maxSinglePosition, 1e-9);
near('且不超过更严格的 35% 绝对线', (30000 + barbell.amount) / portLimit.totalAsset, 0.35, 1e-9);

// ---------------------------------------------------------------
console.log('\n【10. 输出健壮性】');
const allCases = [['破位底线', opsBreak], ['急跌', opsCrash], ['金字塔', pyr.operations],
                  ['混合预算', opsBoth.operations], ['杠铃限额', opsLimit]];
for (const [tag, ops] of allCases) {
  ok(`${tag}: 操作非空`, ops.length > 0);
  ok(`${tag}: action 合法`, ops.every((o) => ['BUY', 'SELL', 'CONVERT', 'DCA', 'HOLD'].includes(o.action)));
  ok(`${tag}: 动钱操作金额为有限正数`,
    ops.filter((o) => o.action !== 'HOLD').every((o) => Number.isFinite(o.amount) && o.amount > 0));
  ok(`${tag}: 理由非空`, ops.every((o) => typeof o.reason === 'string' && o.reason.length > 0));
}
// 每只持仓基金都不遗漏
ok('金字塔用例: 每只基金都有操作', pyr.operations.filter((o) => o.code.startsWith('F')).length === 3);

console.log(`\n✅ V6 激进引擎单测全部通过 (${pass} 项)`);
