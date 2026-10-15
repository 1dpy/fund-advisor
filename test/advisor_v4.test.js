/**
 * V4 默认决策引擎单元测试 — 止损/止盈/加仓/买入预算/转换 与现金约束
 *
 * V4 是 `node main.js` 不带 --ultimate/--aggressive 时的默认引擎, 此前零测试。
 * 纯离线: 通过预置 data_cache/ 让 getCachedHistory 直接命中缓存, 不联网。
 * 被 CI 调用。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { generateAdviceV4 } = require('../src/advisor_v4');
const { BUDGET, RISK_CONFIG } = require('../src/config');

let pass = 0;
function ok(name, cond) { assert.ok(cond, '❌ ' + name); console.log('  ✅ ' + name); pass++; }
function eq(name, actual, expect) {
  assert.strictEqual(actual, expect, `❌ ${name}: 期望 ${expect}, 实际 ${actual}`);
  console.log('  ✅ ' + name); pass++;
}

const CACHE_DIR = path.join(__dirname, '..', 'data_cache');
function today() { return new Date().toISOString().slice(0, 10); }

// 预置缓存: lastDate = 今天 → getCachedHistory 直接返回, 不触发网络
function seedCache(code, navs) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const n = navs.length;
  const history = navs.map((nav, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (n - 1 - i));
    return { date: d.toISOString().slice(0, 10), nav };
  });
  fs.writeFileSync(path.join(CACHE_DIR, `${code}.json`),
    JSON.stringify({ code, history, lastUpdate: new Date().toISOString() }));
}

const UP = Array.from({ length: 40 }, (_, i) => 1 + i * 0.01);       // → STRONG_BUY
const DOWN = Array.from({ length: 40 }, (_, i) => 1.4 - i * 0.01);   // → SELL
const FLAT = Array.from({ length: 40 }, () => 1.0);                  // → HOLD
// 微跌序列: 融合预测落在 (-1.5%, -0.5%) → 信号 WEAK (既不看空也不看多)
function weakSeries(n = 60, slope = -0.00006, seed = 5) {
  let v = 1, s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const out = [];
  for (let i = 0; i < n; i++) { v = v * (1 + slope) + (rnd() - 0.5) * 0.0006; out.push(v); }
  return out;
}
const WEAK = weakSeries();

// 构造一个 fund 条目
function mkFund(code, navs, price, score = 50) {
  seedCache(code, navs);
  return {
    code, name: code + '测试基金C',
    history: navs.map((nav, i) => ({ date: '2026-01-01', nav })),
    nav: price, price, score,
  };
}
// 构造一个持仓条目; costBasis/shares/price 共同决定 profitPct
function mkHolding(code, shares, price, costBasis, extra = {}) {
  return Object.assign({
    code, name: code + '测试基金C', shares, buyPrice: price, costBasis,
    // 持有 10 天: 避开"体制超时退出"(震荡体制上限 60 天)以免干扰其他分支
    buyDate: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
  }, extra);
}

console.log('== V4 默认决策引擎单元测试 ==\n');

// 统一跑一次 V4
async function run(funds, holdings, opts = {}) {
  const data = { funds, indexes: [{ changePct: opts.marketChange != null ? opts.marketChange : 0 }], breadth: {}, northFlow: 0 };
  return generateAdviceV4(data, holdings, opts.mlEnsemble || null, null,
    { regime: opts.regime || 'SIDEWAYS' }, opts.sentiment || null);
}
const allOps = (r) => Object.values(r.operations).flat();
const moneyOps = (r) => allOps(r).filter(o => o.action === 'ADD_POSITION' || o.action === 'BUY');
const spendOf = (r) => moneyOps(r).reduce((s, o) => s + (o.amount || 0), 0);

(async () => {
  // -------------------------------------------------------------
  console.log('【1. 止损 / 止盈】');
  // 1.1 硬止损 -8%
  let r = await run([mkFund('A1', FLAT, 1.0)], [mkHolding('A1', 1000, 1.0, 1000 * 1.0 / 0.90)]);
  // costBasis 使得 profitPct = (1000*1.0 - cost)/cost = -10%
  const stop = r.operations.sells.find(o => o.code === 'A1');
  ok('亏10% ≤ -8% → 触发止损 SELL', !!stop);
  ok('止损 urgency=HIGH', stop && stop.urgency === 'HIGH');

  // 1.2 止盈天花板 +50%
  r = await run([mkFund('A2', FLAT, 1.0)], [mkHolding('A2', 1000, 1.0, 1000 * 1.0 / 1.55)]);
  const ceil = r.operations.sells.find(o => o.code === 'A2' && /止盈天花板/.test(o.reason));
  ok('盈55% ≥ 天花板50% → 全部止盈', !!ceil);

  // 1.3 部分止盈 (非牛市, +20%)
  r = await run([mkFund('A3', FLAT, 1.0)], [mkHolding('A3', 1000, 1.0, 1000 * 1.0 / 1.25)],
    { regime: 'WEAK_SIDEWAYS' });
  const part = r.operations.partialSells.find(o => o.code === 'A3');
  ok('非牛市 盈25% ≥ 20% → 部分止盈', !!part);
  eq('部分止盈比例 = 30%', part && part.sellPct, RISK_CONFIG.partialTakeProfitPct * 100);

  // -------------------------------------------------------------
  console.log('\n【2. ML 看空 / 情绪降级】');
  // 下跌走势 → SELL 信号
  r = await run([mkFund('B1', DOWN, 1.0)], [mkHolding('B1', 1000, 1.0, 1000)]);
  ok('ML看空(置信>50%) → SELL', r.operations.sells.some(o => o.code === 'B1'));
  // 市场恐慌 → 降级为减仓, 不空仓
  r = await run([mkFund('B2', DOWN, 1.0)], [mkHolding('B2', 1000, 1.0, 1000)],
    { sentiment: { tradingBias: 'CONTRARIAN_BUY', labelCN: '恐慌' } });
  ok('恐慌时 ML看空 → 降级 REDUCE(不空仓)', r.operations.reduces.some(o => o.code === 'B2'));
  ok('恐慌时不再全额卖出', !r.operations.sells.some(o => o.code === 'B2'));

  // -------------------------------------------------------------
  console.log('\n【3. 现金预算: 不得推荐超出可用现金的买入】');
  // 3.1 多只同时触发加仓 —— 修复前每只各按原始 cash 判断, 会重复花同一笔钱。
  //     每只加仓额 = min(cash*20%, 2000); 6 只同时触发 → 需求 120% 现金, 必然超发。
  //     profitPct 取 -6%: 落在加仓区间(-5%以下)但不触硬止损(-8%)。
  const cost = Math.round((BUDGET - 1500) / 6);
  const shares = Math.round(cost * 0.94); // → profitPct ≈ -6%
  const funds3 = [], holds3 = [];
  for (let i = 1; i <= 6; i++) {
    funds3.push(mkFund('C' + i, UP, 1.0));
    holds3.push(mkHolding('C' + i, shares, 1.0, cost));
  }
  r = await run(funds3, holds3, { regime: 'SIDEWAYS' });
  const cash3 = BUDGET - holds3.reduce((s, h) => s + h.costBasis, 0);
  const addTotal = r.operations.addPositions.reduce((s, o) => s + o.amount, 0);
  const buyTotal = r.operations.buys.reduce((s, o) => s + o.amount, 0);
  ok(`加仓触发了 (¥${addTotal})`, addTotal > 0);
  ok(`加仓+买入总额 ¥${Math.round(addTotal + buyTotal)} ≤ 可用现金 ¥${Math.round(cash3)}`,
    addTotal + buyTotal <= cash3 + 1);
  ok(`其中加仓 ¥${Math.round(addTotal)} ≤ 可用现金`, addTotal <= cash3 + 1);

  // 3.2 市场恐慌时买入预算放宽 1.25 倍 —— 修复前会把预算顶到可用现金之上
  //     (0.85 × 1.25 = 1.0625 倍现金), 多只买入累计即超发
  const holdsFear = [mkHolding('D1', 1000, 1.0, 1100)]; // D1 横盘 → HOLD, 不触发加仓
  const fundsFear = [mkFund('D1', FLAT, 1.0)];
  for (let i = 2; i <= 8; i++) fundsFear.push(mkFund('D' + i, UP, 1.0));
  r = await run(fundsFear, holdsFear,
    { sentiment: { tradingBias: 'CONTRARIAN_BUY', labelCN: '恐慌' } });
  const cashFear = BUDGET - holdsFear.reduce((s, h) => s + h.costBasis, 0);
  const spendFear = spendOf(r);
  ok(`恐慌放宽后触发了买入 (¥${Math.round(spendFear)})`, spendFear > 0);
  ok(`恐慌放宽后 买入总额 ¥${Math.round(spendFear)} ≤ 可用现金 ¥${Math.round(cashFear)}`,
    spendFear <= cashFear + 1);

  // 3.3 贪婪时收紧预算, 且买入信号门槛提高到只认 STRONG_BUY
  r = await run([mkFund('E1', UP, 1.0), mkFund('E2', UP, 1.0)], [],
    { sentiment: { tradingBias: 'TAKE_PROFIT', labelCN: '贪婪' } });
  const spendGreed = spendOf(r);
  ok(`贪婪时买入总额 ¥${Math.round(spendGreed)} ≤ 可用现金 ¥${BUDGET}`, spendGreed <= BUDGET + 1);

  // -------------------------------------------------------------
  console.log('\n【4. 转换 SWAP: 弱信号持仓 → 强信号候选】');
  // 恐慌情绪下 WEAK 持仓走"暂缓减仓" → HOLD, 因此可以被转换;
  // 非恐慌时它会先被 REDUCE, 不能再同时给 SWAP (见 4.2)
  // 用 RF 结果把候选钉成 STRONG_BUY (只靠技术面时 UP 序列只能拿到 BUY)
  const rfStrong = (code) => ({ rfResult: { predictions: [{ code, label: 'STRONG_BUY', accuracy: 0.9 }] } });
  r = await run([mkFund('F1', WEAK, 1.0), mkFund('F2', UP, 1.0)],
    [mkHolding('F1', 1000, 1.0, 1000)],
    { sentiment: { tradingBias: 'CONTRARIAN_BUY', labelCN: '恐慌' }, mlEnsemble: rfStrong('F2') });
  ok('F2 被判为 STRONG_BUY (强候选存在)', r.operations.buys.some(o =>
    o.code === 'F2' && o.mlSignal === 'STRONG_BUY'));
  const swap = r.operations.swaps[0];
  ok('弱信号持仓 → 强信号候选 产生 SWAP', !!swap);
  if (swap) {
    eq('SWAP 卖出的是弱信号持仓', swap.sellCode, 'F1');
    eq('SWAP 买入的是强信号候选', swap.buyCode, 'F2');
    ok('SWAP 买卖金额一致', swap.sellValue === swap.buyAmount);
  }

  // 4.2 指令冲突回归: WEAK 持仓非恐慌时 2a 已给 REDUCE, 2c 不得再给 SWAP
  r = await run([mkFund('F3', WEAK, 1.0), mkFund('F4', UP, 1.0)],
    [mkHolding('F3', 1000, 1.0, 1000)], { mlEnsemble: rfStrong('F4') });
  ok('WEAK 持仓非恐慌时 → REDUCE', r.operations.reduces.some(o => o.code === 'F3'));
  ok('F4 同样被判为强候选 (排除"没有候选"的假通过)',
    r.operations.buys.some(o => o.code === 'F4' && o.mlSignal === 'STRONG_BUY'));
  eq('已减仓的持仓不再重复给出 SWAP', r.operations.swaps.length, 0);

  // -------------------------------------------------------------
  console.log('\n【5. 输出健壮性】');
  const cases = {
    '止损': await run([mkFund('G1', FLAT, 1.0)], [mkHolding('G1', 1000, 1.0, 1000)]),
    '加仓': await run([mkFund('G2', UP, 1.0)], [mkHolding('G2', 1000, 1.0, 900)]),
    '恐慌': await run([mkFund('G3', DOWN, 1.0)], [mkHolding('G3', 1000, 1.0, 1000)],
      { sentiment: { tradingBias: 'CONTRARIAN_BUY', labelCN: '恐慌' } }),
    '空持仓': await run([mkFund('G4', UP, 1.0)], []),
  };
  for (const [tag, rr] of Object.entries(cases)) {
    const ops = allOps(rr);
    ok(`${tag}: 金额均为有限非负数`,
      ops.every(o => o.amount === undefined || (Number.isFinite(o.amount) && o.amount >= 0)));
    ok(`${tag}: action 合法`, ops.every(o => ['SELL', 'PARTIAL_SELL', 'BUY', 'SWAP',
      'ADD_POSITION', 'REDUCE', 'HOLD'].includes(o.action)));
    ok(`${tag}: 理由非空`, ops.every(o => typeof o.reason === 'string' && o.reason.length > 0));
    ok(`${tag}: 同一只基金不会既被转换又被卖出/减仓/加仓`,
      !rr.operations.swaps.some(s => [
        ...rr.operations.sells, ...rr.operations.partialSells,
        ...rr.operations.reduces, ...rr.operations.addPositions,
      ].some(o => o.code === s.sellCode)));
    ok(`${tag}: summary 计数与 operations 一致`,
      rr.summary.buy === rr.operations.buys.length
      && rr.summary.sell === rr.operations.sells.length
      && rr.summary.hold === rr.operations.holds.length);
  }
  // 每只持仓都要落地到某个操作 (不能凭空消失)
  const rCov = await run([mkFund('H1', UP, 1.0), mkFund('H2', DOWN, 1.0), mkFund('H3', FLAT, 1.0)],
    [mkHolding('H1', 1000, 1.0, 1000), mkHolding('H2', 1000, 1.0, 1000), mkHolding('H3', 1000, 1.0, 1000)]);
  for (const code of ['H1', 'H2', 'H3']) {
    ok(`持仓 ${code} 有明确操作`, allOps(rCov).some(o => o.code === code));
  }

  console.log(`\n✅ V4 决策引擎单测全部通过 (${pass} 项)`);
})().catch(e => { console.error('\n❌ 测试异常:', e); process.exit(1); });
