/**
 * 持仓回写 (applyDecisions) 单测
 *
 * applyDecisions 是唯一会把建议写进 holdings.json 的代码, 写错就是真金白银的错记账。
 * 之前它零测试, 并且存在三个致命问题:
 *   1. 只认 V3 字段名 (sellOrders/buyOrders/...), 而 main.js 喂进来的是 V4
 *      结构 (operations.sells/buys/...) → `node main.js --apply` 必崩
 *   2. V4 的 ADD_POSITION 不带 price → amount/undefined = NaN 被写进持仓
 *   3. 加仓的基金本来就持有, 却 push 一条新记录 → 两条同 code, 加仓的钱消失
 *
 * 纯离线 (只操作临时 holdings.json 副本), 被 CI 调用。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { applyDecisions, loadHoldings, saveHoldings } = require('../src/advisor_v3');

const HOLDINGS_FILE = path.join(__dirname, '..', 'holdings.json');
const BACKUP = HOLDINGS_FILE + '.apptest.bak';

let pass = 0;
function ok(name, cond) { assert.ok(cond, '❌ ' + name); console.log('  ✅ ' + name); pass++; }
function eq(name, a, b) {
  assert.strictEqual(a, b, `❌ ${name}: 期望 ${b}, 实际 ${a}`);
  console.log('  ✅ ' + name); pass++;
}
function near(name, a, b, tol = 1e-6) {
  assert.ok(Math.abs(a - b) <= tol, `❌ ${name}: 期望 ≈${b}, 实际 ${a}`);
  console.log('  ✅ ' + name); pass++;
}

// 用给定持仓跑一次 applyDecisions, 返回写回后的结果
function applyWith(holdings, decisions) {
  saveHoldings(holdings);
  return applyDecisions(decisions);
}
// V4 结构包装
const v4 = (ops) => ({ operations: Object.assign({
  sells: [], partialSells: [], buys: [], swaps: [],
  addPositions: [], reduces: [], holds: [], dca: [],
}, ops) });

console.log('== 持仓回写单测 ==\n');

const hadFile = fs.existsSync(HOLDINGS_FILE);
if (hadFile) fs.copyFileSync(HOLDINGS_FILE, BACKUP);

try {
  const base = [
    { code: 'A1', name: '基金A', type: 'fund', buyPrice: 1.0, shares: 1000, costBasis: 1000, buyDate: '2026-09-01' },
    { code: 'A2', name: '基金B', type: 'fund', buyPrice: 2.0, shares: 500, costBasis: 800, buyDate: '2026-08-01' },
    { code: 'CASH_YEB', name: '余额宝', type: 'cash', buyPrice: 1, shares: 3000, costBasis: 3000, buyDate: '2026-01-01' },
  ];

  console.log('【1. V4 结构不再崩溃 (历史 bug: --apply 必崩)】');
  let r = applyWith(base, v4({ sells: [{ code: 'A1', shares: 1000, amount: 1000 }] }));
  ok('V4 decisions 能被 applyDecisions 接受', Array.isArray(r));
  eq('卖出的基金已移除', r.filter(h => h.code === 'A1').length, 0);
  eq('其余持仓保留', r.length, 2);

  console.log('\n【2. 加仓必须合并进原持仓, 不能新增重复条目】');
  r = applyWith(base, v4({ addPositions: [{ code: 'A1', name: '基金A', amount: 500, price: 1.0, shares: 500 }] }));
  const a1 = r.filter(h => h.code === 'A1');
  eq('A1 只有一条记录', a1.length, 1);
  near('份额 1000+500', a1[0].shares, 1500);
  near('成本 1000+500', a1[0].costBasis, 1500);
  near('摊薄后买入均价 = 1500/1500', a1[0].buyPrice, 1.0);

  // 加仓价 ≠ 原价 时要正确摊薄
  r = applyWith(base, v4({ addPositions: [{ code: 'A1', name: '基金A', amount: 500, price: 0.5, shares: 1000 }] }));
  const a1b = r.find(h => h.code === 'A1');
  near('低价加仓后份额 1000+1000', a1b.shares, 2000);
  near('成本 1000+500', a1b.costBasis, 1500);
  near('摊薄均价 = 1500/2000', a1b.buyPrice, 0.75);

  console.log('\n【3. 新买入 → 新增条目, 且 type 不能是 undefined】');
  r = applyWith(base, v4({ buys: [{ code: 'B9', name: '基金C', amount: 800, price: 1.6, shares: 500 }] }));
  const b9 = r.find(h => h.code === 'B9');
  ok('新增了 B9', !!b9);
  eq('type 兜底为 fund', b9.type, 'fund');
  near('份额 = 800/1.6', b9.shares, 500);
  near('成本 = 800', b9.costBasis, 800);

  console.log('\n【4. 净值缺失时宁可不写, 也不能写 NaN】');
  r = applyWith(base, v4({ addPositions: [{ code: 'A1', name: '基金A', amount: 500 }] })); // 无 price
  const a1c = r.find(h => h.code === 'A1');
  ok('份额不是 NaN', Number.isFinite(a1c.shares));
  near('价格缺失 → 不改动份额 (仍是 1000)', a1c.shares, 1000);
  ok('写回文件里没有 NaN', !fs.readFileSync(HOLDINGS_FILE, 'utf8').includes('null'));

  console.log('\n【5. 部分卖出: 成本按比例结转, 不能重置为市值】');
  // A2: 500份 成本800 (成本价1.6), 现价假设 2.0。卖 200 份 → 剩 300份, 成本应为 800*300/500=480
  r = applyWith(base, v4({ partialSells: [{ code: 'A2', shares: 200, amount: 400, sellPct: 40 }] }));
  const a2 = r.find(h => h.code === 'A2');
  near('剩余份额 300', a2.shares, 300);
  near('成本按份额比例结转 = 480', a2.costBasis, 480); // 若按市值 600 则是错账

  console.log('\n【6. 减仓: 同上, 成本按比例结转】');
  r = applyWith(base, v4({ reduces: [{ code: 'A2', shares: 100, amount: 200, reducePct: 30 }] }));
  const a2r = r.find(h => h.code === 'A2');
  near('剩余份额 400', a2r.shares, 400);
  near('成本 = 800*400/500 = 640', a2r.costBasis, 640);

  console.log('\n【7. 转换: 卖旧的、买新的, 且新条目份额按目标净值折算】');
  r = applyWith(base, v4({ swaps: [{ sellCode: 'A1', sellName: '基金A', buyCode: 'C7', buyName: '基金C7',
    buyPrice: 2.5, sellValue: 1000, buyAmount: 1000 }] }));
  eq('旧基金已移除', r.filter(h => h.code === 'A1').length, 0);
  const c7 = r.find(h => h.code === 'C7');
  ok('新基金已建立', !!c7);
  near('份额 = 1000/2.5', c7.shares, 400);
  near('成本 = 1000', c7.costBasis, 1000);
  eq('新条目 type=fund', c7.type, 'fund');

  console.log('\n【8. 现金条目不受影响】');
  r = applyWith(base, v4({ buys: [{ code: 'B9', name: '基金C', amount: 800, price: 1.6, shares: 500 }] }));
  const cash = r.find(h => h.code === 'CASH_YEB');
  ok('现金条目仍在', !!cash);
  eq('现金份额未被改动', cash.shares, 3000);

  console.log('\n【9. V3 旧结构仍然兼容 (不能只顾新的)】');
  r = applyWith(base, {
    sellOrders: [{ code: 'A2' }],
    buyOrders: [{ code: 'D1', name: '基金D', amount: 1000, price: 2.0 }],
    partialSells: [], reducePositions: [], swapPlans: [], partialSwaps: [], addPositions: [],
  });
  eq('V3 卖出生效', r.filter(h => h.code === 'A2').length, 0);
  const d1 = r.find(h => h.code === 'D1');
  ok('V3 买入生效', !!d1);
  near('V3 份额 = 1000/2', d1.shares, 500);

  console.log('\n【10. 空决策 / 空持仓不炸】');
  r = applyWith(base, v4({}));
  eq('空决策 → 持仓不变', r.length, 3);
  r = applyWith([], v4({ buys: [{ code: 'E1', name: '基金E', amount: 100, price: 1, shares: 100 }] }));
  eq('空持仓买入 → 建仓', r.length, 1);
  r = applyWith([], {});
  eq('全空 → 空数组', r.length, 0);
} finally {
  if (hadFile) fs.copyFileSync(BACKUP, HOLDINGS_FILE), fs.unlinkSync(BACKUP);
  else if (fs.existsSync(HOLDINGS_FILE)) fs.unlinkSync(HOLDINGS_FILE);
}

console.log(`\n✅ 持仓回写单测全部通过 (${pass} 项)`);
