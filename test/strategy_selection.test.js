/**
 * 策略核心单测 — 选基 / 仓位 / 止盈止损 / 费率闸门 / 交易日闸门
 *
 * 覆盖 src/advisor_v5_ultimate.js 的纯函数决策点 + src/realtime_quotes.js 动量计算。
 * 这些是"决定真金白银"的地方: 之前只有能跑通的冒烟测试, 语义改坏了没人知道。
 *
 * 纯离线, 不依赖网络; 被 CI 调用 (node --trace-warnings test/strategy_selection.test.js)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const A = require('../src/advisor_v5_ultimate');
const RQ = require('../src/realtime_quotes');
const T1 = require('../src/t1_calendar');
const {
  STRATEGY, STRATEGY_CONFIG, RISK_CONFIG, FEE_CONFIG,
  MAX_DEPLOY_SECTORS, REALTIME_PICK_COUNT,
} = require('../src/config');

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

// 构造 N 天前的买入日期 (本地时区安全)
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// 日期字符串 -> Date
function D(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 10, 0, 0); }

const PF = STRATEGY_CONFIG.PROFIT_FIRST;
const CONS = STRATEGY_CONFIG.CONSERVATIVE;

console.log('== 策略核心单测 (选基/仓位/止盈止损/费率/交易日) ==\n');

// ---------------------------------------------------------------
console.log('【1. 交易日闸门: 节假日与调休补班】');
// 历史 bug: advisor_v5 / v6 各自有一份"只判断 day>=1&&day<=5"的实现,
//   国庆春节等工作日休市日会照常出交易指令。现已统一委托 t1_calendar。
eq('国庆 2026-10-01(周四) 休市', A.isTradingDay(D('2026-10-01')), false);
eq('春节 2026-02-17(周二) 休市', A.isTradingDay(D('2026-02-17')), false);
eq('调休补班 2026-10-10(周六) 开市', A.isTradingDay(D('2026-10-10')), true);
eq('调休补班 2026-09-27(周日) 开市', A.isTradingDay(D('2026-09-27')), true);
eq('普通周三 2026-10-14 开市', A.isTradingDay(D('2026-10-14')), true);
eq('普通周日 2026-10-18 休市', A.isTradingDay(D('2026-10-18')), false);
ok('advisor 与 t1_calendar 同源(不再各写一份)', A.isTradingDay === T1.isTradingDay);

// ---------------------------------------------------------------
console.log('\n【2. 赛道分类 classifySector】');
eq('芯片 → growth', A.classifySector('国泰芯片ETF联接C'), 'growth');
eq('恒生科技 → growth', A.classifySector('天弘恒生科技C'), 'growth');
eq('QDII 全球 → global', A.classifySector('广发全球精选股票(QDII)C'), 'global');
eq('纳指 → global', A.classifySector('广发纳斯达克100C'), 'global');
eq('沪深300 → value', A.classifySector('易方达沪深300ETF联接C'), 'value');
eq('红利 → value', A.classifySector('中证红利ETF联接C'), 'value');
eq('黄金 → defense', A.classifySector('博时黄金ETF联接C'), 'defense');
eq('短债 → defense', A.classifySector('XX短债债券C'), 'defense');
eq('未知名 → 默认 growth', A.classifySector('某某混合C'), 'growth');
eq('null 安全 → growth', A.classifySector(null), 'growth');
// 不变量: "是不是全球基" 只能有一个答案 (classifySector 与 isGlobalDiversification 不得漂移)
const { PREFERRED_SECTORS } = require('../src/config');
const inconsistent = PREFERRED_SECTORS.filter((s) =>
  A.isGlobalDiversification(s.name) && A.classifySector(s.name) !== 'global');
ok(`选基池 ${PREFERRED_SECTORS.length} 只: 全球判定口径一致`, inconsistent.length === 0
  || (console.log('   ⚠️ 不一致:', inconsistent.map((s) => s.name).join(', ')), false));
eq('纳斯达克100 → global(不再算A股成长)', A.classifySector('博时纳斯达克100ETF联接C'), 'global');

// ---------------------------------------------------------------
console.log('\n【3. 组合分析 analyzePortfolio】');
const p1 = A.analyzePortfolio([
  { type: 'fund', code: '008282', name: '国泰芯片ETF联接C', costBasis: 1000, currentValue: 1500, buyDate: daysAgo(60) },
  { type: 'fund', code: '014418', name: '博时黄金ETF联接C', costBasis: 800, currentValue: 800, buyDate: daysAgo(60) },
  { type: 'cash', name: '现金', currentValue: 700 },
]);
eq('总资产 = 1500+800+700', p1.totalAsset, 3000);
eq('现金识别', p1.cash, 700);
near('成长权重', p1.sectorWeights.growth, 0.5);
near('防御权重', p1.sectorWeights.defense, 800 / 3000);
near('现金权重', p1.sectorWeights.cash, 700 / 3000);
near('单票最大权重', p1.maxSingleWeight, 0.5);
near('科技集中度 = 成长权重', p1.techConcentration, p1.sectorWeights.growth);
near('浮盈比例 (1000→1500)', p1.funds[0].profitPct, 0.5);
near('权重之和 = 1', Object.values(p1.sectorWeights).reduce((s, v) => s + v, 0), 1);

const pEmpty = A.analyzePortfolio([]);
eq('空组合 总资产=0', pEmpty.totalAsset, 0);
eq('空组合 单票权重=0(非NaN)', pEmpty.maxSingleWeight, 0);
ok('空组合 权重无 NaN', Object.values(pEmpty.sectorWeights).every(Number.isFinite));

// 缺 currentValue 时回退 costBasis, 不产生 NaN
const pFallback = A.analyzePortfolio([
  { type: 'fund', code: 'X', name: '某某混合C', costBasis: 500 },
]);
eq('缺 currentValue 回退 costBasis', pFallback.totalAsset, 500);

// ---------------------------------------------------------------
console.log('\n【4. 市场体制 detectMarketRegime】');
const mkPortfolio = (funds) => ({
  funds: funds.map((f) => ({ ...f, locked: !!f.locked, sector: A.classifySector(f.name) })),
  sectorWeights: {}, totalAsset: 1, cash: 0,
});
eq('成长均亏 -15% → BEAR', A.detectMarketRegime(mkPortfolio([
  { name: '国泰芯片ETF联接C', profitPct: -0.15 }, { name: '易方达科创50联接C', profitPct: -0.15 },
])).regime, 'BEAR');
eq('成长均亏 -7% → WEAK_SIDEWAYS', A.detectMarketRegime(mkPortfolio([
  { name: '国泰芯片ETF联接C', profitPct: -0.07 },
])).regime, 'WEAK_SIDEWAYS');
eq('成长均盈 +10% → BULL', A.detectMarketRegime(mkPortfolio([
  { name: '国泰芯片ETF联接C', profitPct: 0.10 },
])).regime, 'BULL');
eq('持平 → SIDEWAYS', A.detectMarketRegime(mkPortfolio([
  { name: '国泰芯片ETF联接C', profitPct: 0 },
])).regime, 'SIDEWAYS');
// 锁定仓(框架冻结)不应主导体制判断
eq('锁定亏损仓不计入体制', A.detectMarketRegime(mkPortfolio([
  { name: '国泰芯片ETF联接C', profitPct: -0.30, locked: true },
  { name: '易方达科创50联接C', profitPct: 0.02 },
])).regime, 'SIDEWAYS');
eq('空组合 → SIDEWAYS(不NaN)', A.detectMarketRegime(mkPortfolio([])).regime, 'SIDEWAYS');

// ---------------------------------------------------------------
console.log('\n【5. 配置偏离 checkAllocationDrift】');
const pa = A.analyzePortfolio([{ type: 'cash', name: '现金', currentValue: 1000 }]);
const al = A.checkAllocationDrift(pa, 'SIDEWAYS', PF);
eq('常态目标 growth', al.target.growth, PF.strategicAllocation.growth);
eq('常态目标 cash', al.target.cash, PF.strategicAllocation.cash);
ok('drift = 实际 - 目标', Math.abs(al.drift.cash - (1 - PF.strategicAllocation.cash)) < 1e-9);

const alBear = A.checkAllocationDrift(pa, 'BEAR', PF);
ok('熊市: 成长降到 ≤30%', alBear.target.growth <= 0.30);
ok('熊市: 防御抬到 ≥18%', alBear.target.defense >= 0.18);
ok('熊市: 全球 ≤27%', alBear.target.global <= 0.27);
ok('熊市: 现金 ≥8%', alBear.target.cash >= 0.08);
// 目标权重不得超额配置(>100%)
const bearSum = Object.values(alBear.target).reduce((s, v) => s + v, 0);
ok('熊市目标之和 ≤1 (不超额配置)', bearSum <= 1 + 1e-9);
if (Math.abs(bearSum - 1) > 0.01) {
  console.log(`   ⚠️ 已知问题(待用户定夺): 熊市目标之和 = ${bearSum.toFixed(2)}, 缺口 ${(1 - bearSum).toFixed(2)};` +
    ` 未归一化 → sum(drift) 恒为 +${(1 - bearSum).toFixed(2)}, 熊市下 drift 被系统性抬高(更倾向"超配"判定)`);
}
const normSum = Object.values(al.target).reduce((s, v) => s + v, 0);
near('常态目标之和 = 1', normSum, 1, 1e-9);
const alWeak = A.checkAllocationDrift(pa, 'WEAK_SIDEWAYS', PF);
ok('弱震荡同样降成长', alWeak.target.growth <= 0.30);
// 显式传 strategy 时以传入为准
const alCustom = A.checkAllocationDrift(pa, 'SIDEWAYS', {
  strategicAllocation: { growth: 0.4, value: 0.2, defense: 0.2, global: 0.1, cash: 0.1 },
});
eq('自定义 strategy 生效', alCustom.target.growth, 0.4);

// ---------------------------------------------------------------
console.log('\n【6. 赎回费闸门 holdingDays / redemptionFeeRate】');
eq('无买入日 → 999(视为长期持有)', A.holdingDays(undefined), 999);
eq('买入日为空串 → 999', A.holdingDays(''), 999);
ok('3天前 → 持有天数≈3', Math.abs(A.holdingDays(daysAgo(3)) - 3) <= 1);
eq('<7天 → 1.5%', A.redemptionFeeRate({ buyDate: daysAgo(3) }), FEE_CONFIG.fund.redemptionRate.under7);
eq('<30天 → 0.5%', A.redemptionFeeRate({ buyDate: daysAgo(20) }), FEE_CONFIG.fund.redemptionRate.under30);
eq('≥30天 → 0', A.redemptionFeeRate({ buyDate: daysAgo(60) }), 0);
eq('无买入日 → 免赎回费', A.redemptionFeeRate({}), 0);

// ---------------------------------------------------------------
console.log('\n【7. 转换目标挑选 selectConversionTargets】');
const convFunds = [
  { code: 'A', name: '国泰芯片ETF联接C', sector: 'growth', value: 3000 },            // 成长, 占比最高
  { code: 'B', name: '易方达科创50联接C', sector: 'growth', value: 2000 },
  { code: 'C', name: '广发全球精选股票(QDII)C', sector: 'global', value: 2500 },      // QDII 不参与
  { code: 'D', name: '博时黄金ETF联接C', sector: 'defense', value: 1000 },            // 防御不参与
  { code: 'E', name: '某某混合C', sector: 'growth', value: 100, locked: true },       // 锁定
  { code: 'F', name: 'XX半导体C', sector: 'growth', value: 100 },                     // 占比<5%
];
const targets = A.selectConversionTargets(convFunds, 10000, new Set());
ok('只留非QDII的成长仓', targets.every((f) => f.sector === 'growth' && !A.isGlobalDiversification(f.name)));
ok('排除锁定仓', !targets.find((f) => f.code === 'E'));
ok('排除占比<5%的', !targets.find((f) => f.code === 'F'));
eq('按占比降序: 首位是 A', targets[0].code, 'A');
eq('按占比降序: 次位是 B', targets[1].code, 'B');
eq('数量 = 2', targets.length, 2);
// 已在途的跳过
const t2 = A.selectConversionTargets(convFunds, 10000, new Set(['A']));
ok('已在途的基金被跳过', !t2.find((f) => f.code === 'A'));
// notes 标记已申请全部转换的不重复动
const t3 = A.selectConversionTargets([
  { code: 'G', name: 'XX半导体C', sector: 'growth', value: 2000, notes: '已申请转换清零' },
], 10000, new Set());
eq('已申请清0的转换中基金跳过', t3.length, 0);

// ---------------------------------------------------------------
console.log('\n【8. 选基 pickPreferredSector】');
eq('ML 空仓门([]) → 不投赛道', A.pickPreferredSector([], 10000, [], null).length, 0);
ok('ML 选基: 未达上限的保留', A.pickPreferredSector([], 10000, [{ code: '008282', maxWeight: 0.25 }], null).length === 1);
eq('ML 选基: 已满仓的剔除', A.pickPreferredSector(
  [{ code: '008282', value: 3000 }], 10000, [{ code: '008282', maxWeight: 0.25 }], null).length, 0);

// 实时行情动态选基: 取 Top-N, 顺序保持
const scores = [
  { code: 'S1', name: '半导体C', sector: '半导体', score: 9, maxWeight: 0.25 },
  { code: 'S2', name: '科创C', sector: '科创', score: 8, maxWeight: 0.25 },
  { code: 'S3', name: '人工智能C', sector: '人工智能', score: 7, maxWeight: 0.25 },
];
// EFFECTIVE_PICK_COUNT 由自迭代元参数 topK 决定(缺省 REALTIME_PICK_COUNT), 这里同步推导期望值
let effectivePick = REALTIME_PICK_COUNT;
try {
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'meta_params.json'), 'utf8'));
  if (meta && meta.selfParams && meta.selfParams.topK) {
    effectivePick = Math.max(2, Math.min(MAX_DEPLOY_SECTORS, meta.selfParams.topK));
  }
} catch (e) { /* 无元参数文件 → 用默认 */ }
const rp = A.pickPreferredSector([], 10000, undefined, scores);
eq(`实时选基取 Top-${effectivePick}`, rp.length, Math.min(effectivePick, scores.length));
eq('实时选基按分数降序: 首位 S1', rp[0].code, 'S1');
ok('实时选基带 realtime 标记', rp.every((p) => p.realtime === true));
ok('实时选基权重落在 [0.4,1.2]', rp.every((p) => p.weight >= 0.4 && p.weight <= 1.2));
// 已满仓的直接跳过, 顺位递补
const rpSkip = A.pickPreferredSector([{ code: 'S1', value: 3000 }], 10000, undefined, scores);
ok('已满仓的赛道被跳过', !rpSkip.find((p) => p.code === 'S1'));
eq('递补后首位 S2', rpSkip[0].code, 'S2');
// 静态回退
const rpStatic = A.pickPreferredSector([], 10000, undefined, undefined);
eq(`静态回退取 ${MAX_DEPLOY_SECTORS} 只`, rpStatic.length, MAX_DEPLOY_SECTORS);
ok('静态回退等权 weight=1', rpStatic.every((p) => p.weight === 1));
eq('空实时数组 → 走静态回退', A.pickPreferredSector([], 10000, undefined, []).length, MAX_DEPLOY_SECTORS);

// ---------------------------------------------------------------
console.log('\n【9. 操作生成 generateUltimateAdvice — 集中度/单票】');
// 9.1 科技集中度超 75% → 分步转换
const adv1 = A.generateUltimateAdvice(
  A.analyzePortfolio([
    { type: 'fund', code: '008282', name: '国泰芯片ETF联接C', costBasis: 3500, currentValue: 3500, buyDate: daysAgo(60) },
    { type: 'cash', name: '现金', currentValue: 1000 },
  ]),
  { regime: 'SIDEWAYS', confidence: 50 },
  A.checkAllocationDrift(A.analyzePortfolio([
    { type: 'fund', code: '008282', name: '国泰芯片ETF联接C', costBasis: 3500, currentValue: 3500, buyDate: daysAgo(60) },
    { type: 'cash', name: '现金', currentValue: 1000 },
  ]), 'SIDEWAYS', PF),
  null, PF, undefined, undefined);
const c1 = adv1.operations.find((o) => o.code === '008282' && o.action === 'CONVERT');
ok('集中度 77.8% > 75% → 触发 CONVERT', !!c1);
ok('转换金额 ≤600 且 >0', c1 && c1.amount > 0 && c1.amount <= 600);
ok('转换目标为黄金防御', c1 && String(c1.target).includes('黄金'));

// 9.2 单票超 20% → 转换; QDII 放宽到 30%
const h2 = [
  { type: 'fund', code: '017470', name: '嘉实中证半导体C', costBasis: 3000, currentValue: 3000, buyDate: daysAgo(60) },
  { type: 'fund', code: '014418', name: '博时黄金ETF联接C', costBasis: 1000, currentValue: 1000, buyDate: daysAgo(60) },
  { type: 'cash', name: '现金', currentValue: 1000 },
];
const port2 = A.analyzePortfolio(h2);
const adv2 = A.generateUltimateAdvice(port2, { regime: 'SIDEWAYS', confidence: 50 },
  A.checkAllocationDrift(port2, 'SIDEWAYS', PF), null, PF, undefined, undefined);
const c2 = adv2.operations.find((o) => o.code === '017470' && o.action === 'CONVERT');
ok('单票 60% > 20% → 触发 CONVERT', !!c2);
eq('单票转换金额 = min(10%市值, 超出部分30%, 300)', c2 && c2.amount, 300);

// 9.3 QDII 放宽到 30%, 且单票调整一次最多一只
const h3 = [
  { type: 'fund', code: '021277', name: '广发全球精选股票(QDII)C', costBasis: 4000, currentValue: 4000, buyDate: daysAgo(60) },
  { type: 'fund', code: 'HS300', name: '易方达沪深300ETF联接C', costBasis: 2500, currentValue: 2500, buyDate: daysAgo(60) },
  { type: 'cash', name: '现金', currentValue: 3500 },
];
const port3 = A.analyzePortfolio(h3);
const adv3 = A.generateUltimateAdvice(port3, { regime: 'SIDEWAYS', confidence: 50 },
  A.checkAllocationDrift(port3, 'SIDEWAYS', PF), null, PF, undefined, undefined);
ok('QDII 40% > 30% → 触发 CONVERT', !!adv3.operations.find((o) => o.code === '021277' && o.action === 'CONVERT'));
ok('非QDII 25% > 20% 但本轮只处理一只', !adv3.operations.find((o) => o.code === 'HS300' && o.action === 'CONVERT'));

// ---------------------------------------------------------------
console.log('\n【10. 操作生成 — 硬止损与赎回费联动】');
const h4 = [
  { type: 'fund', code: 'NEW', name: '易方达沪深300ETF联接C', costBasis: 1000, currentValue: 900, buyDate: daysAgo(3) },
  { type: 'fund', code: 'OLD', name: '中证红利ETF联接C', costBasis: 1000, currentValue: 900, buyDate: daysAgo(60) },
  { type: 'cash', name: '现金', currentValue: 5000 },
];
const port4 = A.analyzePortfolio(h4);
const adv4 = A.generateUltimateAdvice(port4, { regime: 'SIDEWAYS', confidence: 50 },
  A.checkAllocationDrift(port4, 'SIDEWAYS', PF), null, PF, undefined, undefined);
const oNew = adv4.operations.find((o) => o.code === 'NEW');
const oOld = adv4.operations.find((o) => o.code === 'OLD');
eq('持有3天 + 亏10% → CONVERT(避开1.5%赎回费)', oNew && oNew.action, 'CONVERT');
eq('持有60天 + 亏10% → SELL', oOld && oOld.action, 'SELL');
eq('硬止损 SELL 为全额(900)', oOld && oOld.amount, 900);
ok('止损操作 urgency=HIGH', oNew.urgency === 'HIGH' && oOld.urgency === 'HIGH');

// ---------------------------------------------------------------
console.log('\n【11. 操作生成 — 止盈阶梯】');
const h5 = [
  { type: 'fund', code: 'P55', name: '易方达沪深300ETF联接C', costBasis: 1000, currentValue: 1550, buyDate: daysAgo(60) },
  { type: 'fund', code: 'P25', name: '中证红利ETF联接C', costBasis: 1000, currentValue: 1250, buyDate: daysAgo(60) },
  { type: 'fund', code: 'P18', name: 'XX银行ETF联接C', costBasis: 1000, currentValue: 1180, buyDate: daysAgo(60) },
  { type: 'fund', code: 'P05', name: 'XX传媒ETF联接C', costBasis: 1000, currentValue: 1050, buyDate: daysAgo(60) },
  { type: 'cash', name: '现金', currentValue: 20000 },
];
const port5 = A.analyzePortfolio(h5);
const adv5 = A.generateUltimateAdvice(port5, { regime: 'SIDEWAYS', confidence: 50 },
  A.checkAllocationDrift(port5, 'SIDEWAYS', PF), null, PF, undefined, undefined);
const g = (code) => adv5.operations.find((o) => o.code === code);
eq('+55% ≥ 天花板50% → 全部 SELL', g('P55').action, 'SELL');
eq('天花板止盈金额 = 全额 1550', g('P55').amount, 1550);
eq('+25% ≥ 20% → 分批 SELL', g('P25').action, 'SELL');
eq('分批止盈金额 = 30% = 375', g('P25').amount, Math.round(1250 * RISK_CONFIG.partialTakeProfitPct));
eq('+18% ≥ 15% → 激活移动止盈(HOLD)', g('P18').action, 'HOLD');
ok('移动止盈理由含"移动止盈"', g('P18').reason.includes('移动止盈'));
eq('+5% < 15% → 持有让利润奔跑', g('P05').action, 'HOLD');
ok('理由含"让利润奔跑"', g('P05').reason.includes('让利润奔跑'));

// ---------------------------------------------------------------
console.log('\n【12. 操作生成 — 锁定仓(框架冻结)语义】');
const h6 = [
  { type: 'fund', code: 'L1', name: '易方达沪深300ETF联接C', costBasis: 1000, currentValue: 800, locked: true, buyDate: daysAgo(60) },
  { type: 'fund', code: 'L2', name: '中证红利ETF联接C', costBasis: 1000, currentValue: 1300, locked: true, buyDate: daysAgo(60) },
  { type: 'cash', name: '现金', currentValue: 20000 },
];
const port6 = A.analyzePortfolio(h6);
const optOf = (adv, code) => adv.operations.find((o) => o.code === code);
// 赚钱优先: lockedTakeProfit = true → 锁定盈利仓也止盈
const advPF = A.generateUltimateAdvice(port6, { regime: 'SIDEWAYS', confidence: 50 },
  A.checkAllocationDrift(port6, 'SIDEWAYS', PF), null, PF, undefined, undefined);
eq('锁定亏损仓不触发止损 (PROFIT_FIRST)', optOf(advPF, 'L1').action, 'HOLD');
eq('锁定盈利仓参与止盈 (PROFIT_FIRST)', optOf(advPF, 'L2').action, 'SELL');
// 保守: lockedTakeProfit = false → 锁定仓完全不动
const advCons = A.generateUltimateAdvice(port6, { regime: 'SIDEWAYS', confidence: 50 },
  A.checkAllocationDrift(port6, 'SIDEWAYS', CONS), null, CONS, undefined, undefined);
eq('锁定亏损仓不触发止损 (CONSERVATIVE)', optOf(advCons, 'L1').action, 'HOLD');
eq('锁定盈利仓不参与止盈 (CONSERVATIVE)', optOf(advCons, 'L2').action, 'HOLD');

// ---------------------------------------------------------------
console.log('\n【13. 操作生成 — 输出健壮性】');
for (const [tag, adv] of [['集中度', adv1], ['单票', adv2], ['止损', adv4], ['止盈', adv5], ['锁定', advPF]]) {
  ok(`${tag}: 每只基金都有明确操作`, adv.operations.length > 0);
  // 只有涉及真金白银的动作(BUY/SELL/CONVERT/DCA/PLAN)必须带有效金额; HOLD 无金额是设计如此
  const moneyOps = adv.operations.filter((o) => o.action !== 'HOLD');
  ok(`${tag}: 动钱操作金额均为有限正数`, moneyOps.length > 0
    && moneyOps.every((o) => Number.isFinite(o.amount) && o.amount > 0));
  ok(`${tag}: action 合法`, adv.operations.every((o) =>
    ['BUY', 'SELL', 'CONVERT', 'DCA', 'HOLD', 'PLAN'].includes(o.action)));
  ok(`${tag}: 理由非空`, adv.operations.every((o) => typeof o.reason === 'string' && o.reason.length > 0));
}
ok('每只持仓基金都不遗漏', port5.funds.every((f) => adv5.operations.some((o) => o.code === f.code)));

// ---------------------------------------------------------------
console.log('\n【14. 动量计算 calcMomentum (实时选基的强弱信号)】');
ok('样本不足11点 → available=false', RQ.calcMomentum([{ nav: 1 }, { nav: 2 }]).available === false);
eq('样本不足 → mom5 归零', RQ.calcMomentum([{ nav: 1 }]).mom5, 0);
// nav<=0 的脏点被过滤
ok('脏点(nav<=0)被过滤后仍不足 → 不可用',
  RQ.calcMomentum(Array.from({ length: 15 }, (_, i) => ({ nav: i % 2 === 0 ? 0 : 1 }))).available === false);
// 线性上涨 1..11
const up = Array.from({ length: 11 }, (_, i) => ({ nav: i + 1 }));
const momUp = RQ.calcMomentum(up);
ok('上涨序列 available=true', momUp.available === true);
near('上涨 mom5 = (11/6-1)*100', momUp.mom5, 83.33, 0.01);
near('上涨 maTrend = (11/6.5-1)*100', momUp.maTrend, 69.23, 0.01);
// 下跌 11..1
const down = Array.from({ length: 11 }, (_, i) => ({ nav: 11 - i }));
const momDown = RQ.calcMomentum(down);
ok('下跌 mom5 < 0', momDown.mom5 < 0);
ok('下跌 maTrend < 0', momDown.maTrend < 0);
// 横盘
const flat = Array.from({ length: 11 }, () => ({ nav: 1 }));
const momFlat = RQ.calcMomentum(flat);
eq('横盘 mom5 = 0', momFlat.mom5, 0);
eq('横盘 maTrend = 0', momFlat.maTrend, 0);
// 只取最后10根算 MA10, 序列更长时应以末端为准
const long = Array.from({ length: 30 }, (_, i) => ({ nav: i < 20 ? 5 : 5 + (i - 19) }));
const momLong = RQ.calcMomentum(long);
ok('长序列末端上涨 → mom5 > 0', momLong.mom5 > 0);

// ---------------------------------------------------------------
console.log('\n【15. 现金预算: 不得推荐超出可用现金的买入】');
// 成长与防御同时短缺时, 两条补仓分支各自判定"现金够"就会重复花同一笔钱
const h7 = [
  { type: 'fund', code: 'C0', name: '易方达沪深300ETF联接C', costBasis: 5000, currentValue: 5000, buyDate: daysAgo(60) },
  { type: 'fund', code: 'C1', name: 'XX银行ETF联接C', costBasis: 4500, currentValue: 4500, buyDate: daysAgo(60) },
  { type: 'cash', name: '现金', currentValue: 500 },
];
const port7 = A.analyzePortfolio(h7);
const adv7 = A.generateUltimateAdvice(port7, { regime: 'SIDEWAYS', confidence: 50 },
  A.checkAllocationDrift(port7, 'SIDEWAYS', PF), null, PF, undefined, undefined);
const spend7 = adv7.operations.filter((o) => o.action === 'BUY' || o.action === 'DCA')
  .reduce((s, o) => s + (o.amount || 0), 0);
ok(`成长+防御同时补仓时 买入总额 ¥${spend7} ≤ 可用现金 ¥${port7.cash}`, spend7 <= port7.cash);
ok('确实发生了买入(不是被预算卡成零)', spend7 > 0);
// QDII 定投也不能把总额顶穿
const h8 = [
  { type: 'fund', code: '021277', name: '广发全球精选股票(QDII)C', costBasis: 1000, currentValue: 1000, buyDate: daysAgo(60) },
  { type: 'fund', code: 'C1', name: '易方达沪深300ETF联接C', costBasis: 5000, currentValue: 5000, buyDate: daysAgo(60) },
  { type: 'cash', name: '现金', currentValue: 300 },
];
const port8 = A.analyzePortfolio(h8);
const adv8 = A.generateUltimateAdvice(port8, { regime: 'SIDEWAYS', confidence: 50 },
  A.checkAllocationDrift(port8, 'SIDEWAYS', PF), null, PF, undefined, undefined);
const spend8 = adv8.operations.filter((o) => o.action === 'BUY' || o.action === 'DCA')
  .reduce((s, o) => s + (o.amount || 0), 0);
ok(`含QDII定投时 买入总额 ¥${spend8} ≤ 可用现金 ¥${port8.cash}`, spend8 <= port8.cash);

console.log(`\n✅ 策略核心单测全部通过 (${pass} 项)`);
