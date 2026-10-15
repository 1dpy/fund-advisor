/**
 * 决策引擎属性测试 (property / fuzz) — 随机组合上跑不变量
 *
 * 单测只能覆盖想得到的用例; 这里用带种子的伪随机生成上千个持仓组合,
 * 在 V5 终极版与 V6 激进版两台引擎上检查"无论输入如何都必须成立"的性质:
 *   - 任何金额都是有限数、非负; 动钱操作金额为正
 *   - 不推荐超出可用现金的买入 (否则指令无法执行)
 *   - 每一只持仓基金都必须有明确操作 (不能漏)
 *   - CONVERT 必须给出转换目标
 *   - 组合分析的权重/集中度不能出现 NaN
 * 种子固定 → 结果可复现; 纯离线, 被 CI 调用
 */
const assert = require('assert');

const V5 = require('../src/advisor_v5_ultimate');
const V6 = require('../src/advisor_v6_aggressive');
const { STRATEGY_CONFIG } = require('../src/config');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

// 确定性伪随机 (LCG, 同种子同结果)
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

const NAMES = [
  '国泰芯片ETF联接C', '嘉实中证半导体C', '易方达科创50联接C', '天弘中证人工智能C',
  '广发全球精选股票(QDII)C', '博时纳斯达克100ETF联接C', '易方达沪深300ETF联接C',
  '中证红利ETF联接C', 'XX银行ETF联接C', '博时黄金ETF联接C', 'XX短债债券C',
  '华夏恒生科技ETF联接C', '南方军工改革C', '某某混合C', '易方达信息产业混合C',
];
const NOTES = ['', '', '', '已申请转换清零', '已申请转换', '定投中'];

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 随机生成一个持仓文件风格的数据结构
function randomHoldings(rng) {
  const n = Math.floor(rng() * 7); // 0..6 只基金
  const out = [];
  for (let i = 0; i < n; i++) {
    const cost = Math.round(rng() * 20000);
    // 盈亏 -40% ~ +80%, 覆盖止损/止盈/横盘各区间
    const profit = (rng() - 0.4) * 1.2;
    out.push({
      type: 'fund',
      code: 'C' + i,
      name: NAMES[Math.floor(rng() * NAMES.length)],
      costBasis: cost,
      currentValue: Math.max(1, Math.round(cost * (1 + profit))),
      buyDate: daysAgo(Math.floor(rng() * 400)),
      locked: rng() < 0.15,
      notes: NOTES[Math.floor(rng() * NOTES.length)],
    });
  }
  out.push({ type: 'cash', name: '现金', currentValue: Math.round(rng() * 30000) });
  return out;
}

function randomIndicators(rng, codes) {
  const m = new Map();
  for (const c of codes) {
    if (rng() < 0.25) continue; // 模拟部分基金抓不到数据
    const mom = (rng() - 0.5) * 0.6;
    m.set(c, {
      last: 1 + rng(), ma: 1 + rng(), momentum: mom, momentum5: mom / 2,
      trendUp: rng() < 0.5, atrPct: rng() * 0.12, week5Pct: (rng() - 0.5) * 0.4,
    });
  }
  return m;
}

const PF = STRATEGY_CONFIG.PROFIT_FIRST;
const CONS = STRATEGY_CONFIG.CONSERVATIVE;
const CASES = 600;

console.log(`== 决策引擎属性测试 (${CASES} 组随机组合 × V5/V6 × 2 套策略) ==\n`);

const violations = { nanAmount: 0, negativeAmount: 0, overCash: 0, missingFund: 0, noTarget: 0, nanWeight: 0 };
const rng = makeRng(20261016);

for (let i = 0; i < CASES; i++) {
  const holdings = randomHoldings(rng);
  const codes = holdings.filter(h => h.type !== 'cash').map(h => h.code);
  const ind = randomIndicators(rng, codes);

  // ---------- V5 ----------
  for (const [tag, strat] of [['PROFIT_FIRST', PF], ['CONSERVATIVE', CONS]]) {
    const port = V5.analyzePortfolio(holdings);
    for (const v of Object.values(port.sectorWeights)) if (!Number.isFinite(v)) violations.nanWeight++;
    if (!Number.isFinite(port.techConcentration)) violations.nanWeight++;
    if (!Number.isFinite(port.maxSingleWeight)) violations.nanWeight++;

    const regime = V5.detectMarketRegime(port);
    const alloc = V5.checkAllocationDrift(port, regime.regime, strat);
    const advice = V5.generateUltimateAdvice(port, regime, alloc, null, strat, undefined, undefined);
    const ops = advice.operations;

    for (const o of ops) {
      if (o.amount !== undefined && !Number.isFinite(o.amount)) violations.nanAmount++;
      if (o.amount !== undefined && o.amount < 0) violations.negativeAmount++;
      if (o.action === 'CONVERT' && !o.target) violations.noTarget++;
      if (typeof o.reason !== 'string' || !o.reason.length) violations.noTarget++;
    }
    // 买入+定投总额不得超过可用现金
    const spend = ops.filter(o => o.action === 'BUY' || o.action === 'DCA')
      .reduce((s, o) => s + (o.amount || 0), 0);
    if (spend > port.cash + 1) {
      violations.overCash++;
      if (violations.overCash <= 3) {
        console.log(`  ⚠️ V5/${tag} 超发现金: 建议买入 ¥${spend} > 可用 ¥${port.cash} (第${i}组)`);
      }
    }
    // 每只持仓基金都要有操作
    for (const f of port.funds) {
      if (!ops.some(o => o.code === f.code)) violations.missingFund++;
    }
  }

  // ---------- V6 ----------
  const port6 = V6.analyzePortfolio(holdings, ind);
  for (const v of Object.values(port6.sectorWeights)) if (!Number.isFinite(v)) violations.nanWeight++;
  if (!Number.isFinite(port6.techConcentration)) violations.nanWeight++;

  const trend = V6.detectTechTrend(ind);
  const ops6 = V6.generateAggressiveOps(port6, ind, trend).operations;
  for (const o of ops6) {
    if (o.amount !== undefined && !Number.isFinite(o.amount)) violations.nanAmount++;
    if (o.amount !== undefined && o.amount < 0) violations.negativeAmount++;
    if (o.action === 'CONVERT' && !o.target) violations.noTarget++;
    if (typeof o.reason !== 'string' || !o.reason.length) violations.noTarget++;
  }
  const spend6 = ops6.filter(o => o.action === 'BUY').reduce((s, o) => s + (o.amount || 0), 0);
  if (spend6 > port6.cash + 1) {
    violations.overCash++;
    if (violations.overCash <= 6) {
      console.log(`  ⚠️ V6 超发现金: 建议买入 ¥${spend6} > 可用 ¥${port6.cash} (第${i}组)`);
    }
  }
  for (const f of port6.funds) {
    if (!ops6.some(o => o.code === f.code)) violations.missingFund++;
  }
}

console.log('【不变量检查结果】');
check('金额无 NaN', violations.nanAmount === 0, `${violations.nanAmount} 处`);
check('金额无负数', violations.negativeAmount === 0, `${violations.negativeAmount} 处`);
check('买入总额不超过可用现金', violations.overCash === 0, `${violations.overCash} 组`);
check('每只持仓基金都有操作', violations.missingFund === 0, `${violations.missingFund} 只遗漏`);
check('CONVERT 均有转换目标 / 理由非空', violations.noTarget === 0, `${violations.noTarget} 处`);
check('组合权重无 NaN', violations.nanWeight === 0, `${violations.nanWeight} 处`);

if (fail > 0) {
  console.log(`\n❌ 属性测试失败: ${fail} 项不变量被违反 (通过 ${pass} 项)`);
  process.exit(1);
}
console.log(`\n✅ 属性测试全部通过 (${pass} 项不变量 × ${CASES} 组随机组合)`);
