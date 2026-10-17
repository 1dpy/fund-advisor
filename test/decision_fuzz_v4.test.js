/**
 * V4 默认决策引擎 属性测试 (property / fuzz)
 *
 * V4 是 `node main.js` 不带参数时的默认引擎, 但此前只有固定用例的单测。
 * 这里用带种子的伪随机生成上百个持仓+行情组合, 检查"无论输入如何都必须成立"的性质:
 *   - 金额无 NaN / 无负数
 *   - 买入+加仓总额 ≤ 可用现金 (否则指令根本执行不了)
 *   - 每一只持仓基金都必须有明确操作
 *   - 同一只基金不得既被转换又被卖出/减仓/加仓 (指令冲突)
 *   - 理由非空, summary 计数与 operations 一致
 *
 * 纯离线: 预置 data_cache/<code>.json (lastDate >= 今天) 让 getCachedHistory 直接命中。
 * 种子固定 → 结果可复现。被 CI 调用。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { generateAdviceV4 } = require('../src/advisor_v4');
const { BUDGET } = require('../src/config');

// ★ 测试缓存隔离: 一律写到系统临时目录, 绝不碰用户真实的 data_cache/
//   (属性测试一轮要造 400+ 个假基金文件, 靠末尾清理兜不住 —— 中途失败、
//   Ctrl-C、或删除被环境策略拦截都会留下几百个假净值, 会被 getCachedHistory
//   当成真实数据读走)
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'navcache-'));
process.env.NAV_CACHE_DIR = CACHE_DIR;
// 60 组 ≈ 80s: 每组最多 8 只基金, 每只都要训一次 LSTM-Attention,
// 加到 120 组要跑近 3 分钟, CI 里不划算。想加量就改这里。
const CASES = 60;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// 生成一条净值序列: slope 决定趋势, seed 决定噪声 (确定性)
function navSeries(rng, n = 60) {
  const slope = (rng() - 0.5) * 0.006;
  let v = 1;
  const navs = [];
  for (let i = 0; i < n; i++) {
    v = v * (1 + slope) + (rng() - 0.5) * 0.004;
    navs.push(Math.max(0.05, v));
  }
  return navs;
}

// 预置缓存: 让 getCachedHistory 直接返回, 不联网
// ★ 会在真实的 data_cache/ 里写文件, 所以必须登记并在跑完后删掉,
//   否则测试会给用户的净值缓存留下几百个假基金
const SEEDED = new Set();
function seedCache(code, navs) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const n = navs.length;
  const history = navs.map((nav, i) => ({ date: daysAgo(n - 1 - i), nav }));
  fs.writeFileSync(path.join(CACHE_DIR, `${code}.json`),
    JSON.stringify({ code, history, lastUpdate: new Date().toISOString() }));
  SEEDED.add(code);
}
function cleanupCache() {
  for (const code of SEEDED) {
    try { fs.unlinkSync(path.join(CACHE_DIR, `${code}.json`)); } catch (e) { /* 已删 */ }
  }
}

console.log(`== V4 默认引擎属性测试 (${CASES} 组随机组合) ==\n`);

const rng = makeRng(20261017);
const v = { nanAmount: 0, negativeAmount: 0, overCash: 0, missingFund: 0,
  conflict: 0, noReason: 0, badSummary: 0, crash: 0 };

(async () => {
  for (let i = 0; i < CASES; i++) {
    const nHold = Math.floor(rng() * 5);            // 0..4 只持仓
    const nCand = 1 + Math.floor(rng() * 3);        // 1..3 只候选
    const codes = [];
    for (let k = 0; k < nHold + nCand; k++) codes.push(`Z${i}_${k}`);

    // 持仓成本控制在预算内, 保证"可用现金 > 0"的场景占多数
    const holdings = [];
    for (let k = 0; k < nHold; k++) {
      const cost = 100 + Math.round(rng() * (BUDGET / Math.max(2, nHold)) * 0.35);
      const navs = navSeries(rng);
      const price = navs[navs.length - 1];
      const profit = (rng() - 0.45) * 1.0;          // -45% ~ +55%
      holdings.push({
        code: codes[k], name: '基金' + codes[k], type: 'fund',
        shares: Math.round((cost * (1 + profit)) / price),
        buyPrice: price, costBasis: cost,
        buyDate: daysAgo(Math.floor(rng() * 400)),
      });
      seedCache(codes[k], navs);
    }
    // 现金条目: 不应产生任何操作
    holdings.push({ code: `CASH${i}`, name: '余额宝', type: 'cash',
      shares: 1000, buyPrice: 1, costBasis: 1000, buyDate: daysAgo(100) });

    const funds = [];
    for (let k = 0; k < nHold + nCand; k++) {
      const navs = navSeries(rng);
      seedCache(codes[k], navs);
      funds.push({
        code: codes[k], name: '基金' + codes[k],
        history: navs.map((nav, j) => ({ date: daysAgo(navs.length - 1 - j), nav })),
        nav: navs[navs.length - 1], price: navs[navs.length - 1], score: 30 + Math.round(rng() * 40),
      });
    }

    const data = { funds, indexes: [{ changePct: (rng() - 0.5) * 4 }], breadth: {}, northFlow: 0 };
    const regime = ['SIDEWAYS', 'BULL', 'BEAR', 'WEAK_SIDEWAYS', 'STRONG_SIDEWAYS'][Math.floor(rng() * 5)];
    const sentimentRoll = rng();
    const sentiment = sentimentRoll < 0.2 ? { tradingBias: 'CONTRARIAN_BUY', labelCN: '恐慌' }
      : sentimentRoll < 0.35 ? { tradingBias: 'TAKE_PROFIT', labelCN: '贪婪' } : null;

    let r;
    try {
      r = await generateAdviceV4(data, holdings, null, null, { regime }, sentiment);
    } catch (e) {
      v.crash++;
      if (v.crash <= 3) console.log(`  ⚠️ 第${i}组抛异常: ${e.message}`);
      continue;
    }

    const ops = Object.values(r.operations).flat();
    for (const o of ops) {
      if (o.amount !== undefined && !Number.isFinite(o.amount)) v.nanAmount++;
      if (o.amount !== undefined && o.amount < 0) v.negativeAmount++;
      if (typeof o.reason !== 'string' || o.reason.length === 0) v.noReason++;
    }

    // 现金约束
    const cash = BUDGET - holdings.reduce((s, h) => s + (h.costBasis || 0), 0);
    const spend = ops.filter(o => o.action === 'BUY' || o.action === 'ADD_POSITION')
      .reduce((s, o) => s + (o.amount || 0), 0);
    if (spend > Math.max(0, cash) + 1) {
      v.overCash++;
      if (v.overCash <= 3) console.log(`  ⚠️ 超发现金: 建议 ¥${Math.round(spend)} > 可用 ¥${Math.round(cash)} (第${i}组)`);
    }

    // 每只持仓基金都必须有操作
    for (const h of holdings.filter(x => x.type !== 'cash')) {
      if (!ops.some(o => o.code === h.code || o.sellCode === h.code)) v.missingFund++;
    }
    // 现金条目不得有任何操作
    for (const o of ops) {
      if (o.code === `CASH${i}` || o.sellCode === `CASH${i}`) v.conflict++;
    }
    // 指令冲突: 同一只基金不能既被转换又被卖/减/加
    const actionable = [
      ...r.operations.sells, ...r.operations.partialSells,
      ...r.operations.reduces, ...r.operations.addPositions,
    ].map(o => o.code);
    for (const s of r.operations.swaps) if (actionable.includes(s.sellCode)) v.conflict++;

    // summary 自洽
    if (r.summary.buy !== r.operations.buys.length
      || r.summary.sell !== r.operations.sells.length
      || r.summary.hold !== r.operations.holds.length) v.badSummary++;
  }

  console.log('【不变量检查结果】');
  check('不抛异常', v.crash === 0, `${v.crash} 组`);
  check('金额无 NaN', v.nanAmount === 0, `${v.nanAmount} 处`);
  check('金额无负数', v.negativeAmount === 0, `${v.negativeAmount} 处`);
  check('买入+加仓总额 ≤ 可用现金', v.overCash === 0, `${v.overCash} 组`);
  check('每只持仓基金都有操作', v.missingFund === 0, `${v.missingFund} 只遗漏`);
  check('无指令冲突 / 现金条目不产生操作', v.conflict === 0, `${v.conflict} 处`);
  check('理由非空', v.noReason === 0, `${v.noReason} 处`);
  check('summary 计数自洽', v.badSummary === 0, `${v.badSummary} 组`);

  if (fail > 0) {
    cleanupCache();
    console.log(`\n❌ V4 属性测试失败: ${fail} 项不变量被违反 (通过 ${pass} 项)`);
    process.exit(1);
  }
  cleanupCache();
  console.log(`\n✅ V4 属性测试全部通过 (${pass} 项不变量 × ${CASES} 组随机组合)`);
})().catch(e => { cleanupCache(); console.error(e); process.exit(1); });
