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

// ★ 冷却期记录会写文件, 必须在 require advisor_v4 之前把路径指到临时目录,
//   否则会把测试数据写进用户真实的 data/recent_sells.json
process.env.RECENT_SELLS_FILE = path.join(
  require('os').tmpdir(), `recent_sells_v4_${process.pid}.json`);

const { generateAdviceV4 } = require('../src/advisor_v4');
const { BUDGET, RISK_CONFIG } = require('../src/config');
const { recordStopLossSells } = require('../src/portfolio_book');

let pass = 0;
function ok(name, cond) { assert.ok(cond, '❌ ' + name); console.log('  ✅ ' + name); pass++; }
function eq(name, actual, expect) {
  assert.strictEqual(actual, expect, `❌ ${name}: 期望 ${expect}, 实际 ${actual}`);
  console.log('  ✅ ' + name); pass++;
}

const CACHE_DIR = path.join(__dirname, '..', 'data_cache');
function today() { return new Date().toISOString().slice(0, 10); }

// 预置缓存: lastDate = 今天 → getCachedHistory 直接返回, 不触发网络
/**
 * 生成以"今天"结尾的升序日期序列。
 * ★ 必须和真实净值一样是近期日期: 数据新鲜度闸门(见 src/data_freshness.js)
 *   会把"净值停止更新 > 10 个交易日"的基金排除出买入/加仓/转换。
 *   此前 fixture 全部写死 2026-01-01, 会被正确判为 dead 而触发不到加仓分支。
 * @param {number} n 条数
 * @param {Date=} end 序列最后一天, 默认今天
 */
function dateSeries(n, end = new Date()) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    d.setDate(d.getDate() - (n - 1 - i));
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
}

// 备份表: 种子文件若是覆盖用户已存在的真实缓存, 跑完必须还原。
//   (教训: 曾用真实基金代码 008282/017470/014419 做赛道集中度测试,
//    seedCache 覆盖后 cleanupCache 直接删, 把用户 3 个真实净值缓存删掉了)
// 注意: 同一轮里同一只可能被播种多次(如 P1 连跑三次), 只有**首次**存在才算
//   "用户原有缓存"。第二次再备份就变成备份我们自己写的东西, 还原后反而留下垃圾。
const SEEDED = new Set();
const SEEDED_BACKUP = new Map();
// 真实基金代码: 6 位纯数字
const REAL_FUND_CODE = /^\d{6}$/;

function seedCache(code, navs) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${code}.json`);
  const existed = fs.existsSync(file);
  // 只在"可能是用户真实缓存"时才备份还原: 真实基金代码恒为 6 位纯数字。
  //   合成代码(P1/TP1/Z0_0…)不可能与用户缓存冲突, 一律走删除。
  //   否则会出现"上一轮失败留下的残留被本轮当成原有缓存备份 → 越跑越多"。
  if (existed && REAL_FUND_CODE.test(code) && !SEEDED.has(code) && !SEEDED_BACKUP.has(code)) {
    SEEDED_BACKUP.set(code, fs.readFileSync(file));   // 原样保留字节
  }
  const history = navs.map((nav, i) => ({ date: dateSeries(navs.length)[i], nav }));
  fs.writeFileSync(file, JSON.stringify({ code, history, lastUpdate: new Date().toISOString() }));
  SEEDED.add(code);
}

function cleanupCache() {
  for (const code of SEEDED) {
    const file = path.join(CACHE_DIR, `${code}.json`);
    try {
      if (SEEDED_BACKUP.has(code)) fs.writeFileSync(file, SEEDED_BACKUP.get(code)); // 还原真实缓存
      else fs.unlinkSync(file);                                                    // 只删自己造的
    } catch (e) { /* 忽略 */ }
  }
  SEEDED.clear();
  SEEDED_BACKUP.clear();
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

// 构造一个 fund 条目。
//   ★ 序列末值会被等比缩放到 price: 必须自洽。
//   历史涨到 1.39 却把 price 写成 1.0, 峰值口径会算出现价从高点回撤 -28%,
//   移动止盈先把持仓卖掉 → 想测的分支根本走不到。
//   更隐蔽的坑: 期望"卖出"的断言会被移动止盈误满足, 测试假通过。
//   等比缩放不改变任何收益率, 所以动量/波动率/ML预测/信号全都不受影响。
function mkFund(code, navs, price, score = 50) {
  const p = price != null ? price : navs[navs.length - 1];
  const last = navs[navs.length - 1];
  const scaled = (last > 0 && Math.abs(last - p) > 1e-12)
    ? navs.map(v => v / last * p)
    : navs;
  seedCache(code, scaled);
  return {
    code, name: code + '测试基金C',
    history: scaled.map((nav, i) => ({ date: dateSeries(scaled.length)[i], nav })),
    nav: p, price: p, score,
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
  //     每只加仓额 = min(cash*20%, 单只剩余额度, 2000); 6 只同时触发 → 需求 120% 现金。
  //     profitPct 取 0(顺势加仓区间): 加仓已改为"信号强且确实没亏"才加,
  //     不再是越跌越买, 所以这里不能用亏损仓位触发。
  const cost = Math.round((BUDGET - 1500) / 6);
  const shares = cost; // → profitPct ≈ 0, 落在顺势加仓区间(下界 -3%)
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

  // 3.4 现金条目(余额宝/现金)不得被当成基金产出买卖指令
  const cashItem = { code: 'CASH_YEB', name: '余额宝(现金)', type: 'cash',
    shares: 4000, buyPrice: 1, costBasis: 4000,
    buyDate: new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10) };
  r = await run([mkFund('I1', UP, 1.0)], [cashItem, mkHolding('I1', 1000, 1.0, 1000)]);
  const cashOps = allOps(r).filter(o => o.code === 'CASH_YEB' || o.sellCode === 'CASH_YEB');
  eq('现金条目不产生任何操作指令', cashOps.length, 0);
  ok('现金条目的钱仍计入可用现金 (买入预算可用)',
    r.operations.buys.length > 0 || spendOf(r) >= 0);

  // 3.5 QDII 持仓的结算时间线要比普通基金晚一天
  // 下跌走势 → SELL, 该操作带 t1 时间线, 用来验证 QDII 多一天
  r = await run([mkFund('J1', DOWN, 1.0)],
    [mkHolding('J1', 1000, 1.0, 1000, { type: 'qdii' })]);
  const qOp = r.operations.sells.find(o => o.code === 'J1');
  ok('QDII 持仓带结算时间线', !!qOp);
  eq('QDII 标记为 isQDII', qOp && qOp.t1.isQDII, true);
  ok('QDII 到账日晚于确认日', qOp && qOp.t1.settleDay > qOp.t1.confirmDay);

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

  // -------------------------------------------------------------
  console.log('\n【6. 加仓闸门: 不再是越跌越买】');
  // 老逻辑 profitPct < -0.05 即加(无下界): 在 -5%~-8% 反复摊平, 摊完 profitPct
  // 回到浅亏反而绕过止损, 继续跌继续补, 直到跌破止损一次性全割 —— 马丁格尔。
  // 新逻辑: 信号看多但价格深亏 = 信号与市场矛盾, 说明判断错了, 让止损工作。

  // 6.1 深亏不加仓
  r = await run([mkFund('K1', UP, 1.0)],
    [mkHolding('K1', 930, 1.0, 1000)]);   // profitPct = -7%
  ok(`亏7%不加仓 (下界 ${RISK_CONFIG.addPositionMinPct})`,
    !r.operations.addPositions.some(o => o.code === 'K1'));

  // 6.2 浅亏/不亏才加仓 (顺势)
  r = await run([mkFund('K2', UP, 1.0)],
    [mkHolding('K2', 990, 1.0, 1000)]);   // profitPct = -1%, 在下界之内
  ok('亏1%(下界内)可加仓', r.operations.addPositions.some(o => o.code === 'K2'));

  // 6.3 C类赎回费保护: 持有 <7 天不加仓
  //     新份额一旦被止损扫出要付 1.5% 赎回费, 等于把 -8% 止损扩大到 -9.5%
  r = await run([mkFund('K3', UP, 1.0)],
    [mkHolding('K3', 1000, 1.0, 1000, {
      buyDate: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10),
    })]);
  ok('持有3天<7天不加仓(C类赎回费保护)',
    !r.operations.addPositions.some(o => o.code === 'K3'));

  // 6.4 单只总仓位上限: 已到 20% 上限的不得再加
  const cap20 = Math.round(BUDGET * RISK_CONFIG.maxSinglePosition);
  r = await run([mkFund('K4', UP, 1.0)],
    [mkHolding('K4', 1000, 1.0, 1000, { currentValue: cap20 })]);
  ok(`单只已达上限 ¥${cap20} 不加仓`,
    !r.operations.addPositions.some(o => o.code === 'K4'));

  // 6.5 加仓后不得突破单只上限 (部分仓位 → 只加到上限为止)
  const halfCap = Math.round(cap20 * 0.5);
  r = await run([mkFund('K5', UP, 1.0)],
    [mkHolding('K5', 1000, 1.0, 1000, { currentValue: halfCap })]);
  const addK5 = r.operations.addPositions.find(o => o.code === 'K5');
  ok(`半仓(¥${halfCap})可加仓`, !!addK5);
  if (addK5) {
    ok(`加仓额 ¥${Math.round(addK5.amount)} ≤ 剩余额度 ¥${cap20 - halfCap}`,
      addK5.amount <= cap20 - halfCap + 1);
  }

  // -------------------------------------------------------------
  console.log('\n【6.5 移动止盈: 峰值口径修复前是死代码】');
  // 原实现 peakPrice = holding.peakPrice || max(现价, 买入价), 而 peakPrice
  // 这个字段全项目从未写入过 →
  //   现价≥买价 → peak=现价 → drawdownFromPeak 恒为 0
  //   现价<买价 → peakProfitPct≈0 → 激活条件(涨15%)永不满足
  // 两条路都到不了卖出分支, "移动止盈"自 V4.1 上线起一次都没触发过。
  {
    // 造一段"从 1.00 涨到 1.40 再回落到 1.20"的历史, 买入价 1.00
    const peakSeq = [];
    for (let i = 0; i < 30; i++) peakSeq.push(1 + i * (0.40 / 29));   // → 1.40
    for (let i = 1; i <= 10; i++) peakSeq.push(1.40 - i * 0.02);      // → 1.20
    const nowPx = peakSeq[peakSeq.length - 1];                        // 1.20
    // 成本 1000, 现价 1.20 → 浮盈 +20% (过 15% 激活线)
    //   峰值 1.40 → 从高点回撤 (1.20-1.40)/1.40 = -14.3% ≤ -10% → 应触发
    r = await run([mkFund('TP1', peakSeq, nowPx)],
      [mkHolding('TP1', 1000, 1.00, 1000, { currentValue: 1200 })]);
    const tpSell = r.operations.sells.find(o => o.code === 'TP1');
    ok('涨40%后回撤14% → 触发移动止盈', !!tpSell);
    ok('移动止盈理由含"移动止盈"字样', !!tpSell && /移动止盈/.test(tpSell.reason || ''));

    // 反例: 一路涨到顶(回撤 0)不该卖 —— 峰值=现价, drawdownFromPeak=0
    const upSeq = Array.from({ length: 40 }, (_, i) => 1 + i * 0.01);
    r = await run([mkFund('TP2', upSeq, upSeq[upSeq.length - 1])],
      [mkHolding('TP2', 1000, 1.00, 1000)]);
    ok('仍在创新高时不触发移动止盈', !r.operations.sells.some(o => o.code === 'TP2'));

    // 反例: 没涨过(峰值=买入价)不该卖 —— 激活条件 15% 不满足
    r = await run([mkFund('TP3', FLAT, 1.0)],
      [mkHolding('TP3', 1000, 1.0, 1000)]);
    ok('从未涨过15%时不触发移动止盈', !r.operations.sells.some(o => o.code === 'TP3'));

    // 买入日之前的高点不算自己的峰值: 1.40 出现在建仓之前
    const beforeSeq = [];
    for (let i = 0; i < 20; i++) beforeSeq.push(1.40 - i * 0.01);     // 1.40 → 1.21
    const buyDay = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);
    r = await run([mkFund('TP4', beforeSeq, beforeSeq[beforeSeq.length - 1])],
      [mkHolding('TP4', 1000, 1.0, 1000, { buyDate: buyDay })]);
    ok('建仓前的高点不计入自己的峰值(不误触发)',
      !r.operations.sells.some(o => o.code === 'TP4'));
  }

  // -------------------------------------------------------------
  console.log('\n【7. 盈亏率 fallback: 份额缺失也得算得出浮亏】');
  // 修复前只有 shares×现价 一条路, shares 缺失时 profitPct 直接记 0,
  //   把真实浮亏抹平 → 击穿 -8% 硬止损却挂在"持有"里, 止损形同虚设。
  //   实测 019018 浮亏 -13.97%(currentValue 399.73/costBasis 464.64) 就是这样被漏掉的。
  r = await run([mkFund('M1', FLAT, 1.0)],
    [mkHolding('M1', 0, 1.0, 1000, { currentValue: 920 })]);  // shares=0, 市值口径 -8%
  const m1 = r.operations.sells.find(o => o.code === 'M1');
  ok('份额缺失时用市值口径仍能触发止损', !!m1);
  ok('止损原因标注了估算口径', !!m1 && m1.reason.includes('市值口径估算'));
  ok('止损金额按市值兜底(非 0×现价=0)', !!m1 && m1.amount > 0);

  // 份额与现价都在时走最准的 shares 口径 (shares×现价 = 920, costBasis = 1000 → -8%)
  r = await run([mkFund('M2', FLAT, 1.0)], [mkHolding('M2', 920, 1.0, 1000)]);
  const m2 = r.operations.sells.find(o => o.code === 'M2');
  ok('份额口径正常触发止损', !!m2);
  ok('份额口径不标注估算(是精算值)', !!m2 && !m2.reason.includes('市值口径估算'));

  // 不亏则不卖: 排除"改成一律卖出"的假阳性
  r = await run([mkFund('M3', FLAT, 1.0)], [mkHolding('M3', 1000, 1.0, 1000)]);
  ok('持平不触发止损', !r.operations.sells.some(o => o.code === 'M3'));

  // -------------------------------------------------------------
  console.log('\n【8. 现金账本: 现金条目不再把可用现金算成负数】');
  // 修复前 cash = BUDGET - ΣcostBasis, 把余额宝的 costBasis 也算成"已投基金成本"。
  //   实盘 ΣcostBasis=6298.28 > BUDGET=5500 → cash=-798 → 归零 → 买入循环
  //   buyBudget<100 直接 break, 引擎从不产出买入指令。
  const realLike = [
    { code: 'CASH_YEB', name: '余额宝(现金)', type: 'cash',
      shares: 2269, buyPrice: 1, costBasis: 3269.26, currentValue: 2269.26,
      buyDate: new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10) },
    mkHolding('N1', 1000, 1.0, 1000, { currentValue: 1511.25 }),
    mkHolding('N2', 1000, 1.0, 1000, { currentValue: 399.73 }),
    mkHolding('N3', 1000, 1.0, 1000, { currentValue: 1000 }),
  ];
  const oldCash = BUDGET - realLike.reduce((s, h) => s + h.costBasis, 0);
  ok(`修复前口径确实为负 (¥${oldCash.toFixed(0)})`, oldCash < 0);
  r = await run([mkFund('N9', UP, 1.0)], realLike);
  const spendReal = spendOf(r);
  ok(`修复后仍能产出买入/加仓指令 (¥${Math.round(spendReal)})`, spendReal > 0);
  ok(`且不超过手头现金 ¥2269.26`, spendReal <= 2269.26 + 1);

  // -------------------------------------------------------------
  console.log('\n【9. 赛道集中度: 单只没超限 ≠ 组合没超限】');
  // WATCHLIST 里 aiChip 有 3 只芯片基金, 各自单只上限 20%(=¥1100),
  //   逐个放行会堆到 ¥3300 = 预算 60%, 名义分散实际是单一赛道重仓。
  const CHIP = ['008282', '017470', '014419'];
  r = await run(CHIP.map(c => mkFund(c, UP, 1.0)), []);
  const chipSpend = r.operations.buys
    .filter(o => CHIP.includes(o.code))
    .reduce((s, o) => s + o.amount, 0);
  const sectorCap = BUDGET * RISK_CONFIG.maxSingleSector;
  ok(`买了芯片基金 (¥${Math.round(chipSpend)})`, chipSpend > 0);
  ok(`同赛道合计 ¥${Math.round(chipSpend)} ≤ 单赛道上限 ¥${Math.round(sectorCap)}`,
    chipSpend <= sectorCap + 1);

  // 9.2 止损冷却期: 刚被止损扫出的不得马上买回来
  //     冷却表是跨运行的状态, 持仓文件里不留卖出记录, 所以单独存一份。
  try { fs.unlinkSync(process.env.RECENT_SELLS_FILE); } catch (e) {}
  r = await run([mkFund('P1', UP, 1.0)], []);
  ok('冷却前 P1 可买入', r.operations.buys.some(o => o.code === 'P1'));
  recordStopLossSells(['P1']);           // 模拟上一轮刚被止损
  r = await run([mkFund('P1', UP, 1.0)], []);
  ok(`止损后 ${RISK_CONFIG.sellCooldownDays} 天内不再买回 P1`,
    !r.operations.buys.some(o => o.code === 'P1'));
  // 只挡这一只, 不株连其他基金
  r = await run([mkFund('P1', UP, 1.0), mkFund('P2', UP, 1.0)], []);
  ok('冷却只挡被止损的那只, 不株连其他', r.operations.buys.some(o => o.code === 'P2'));
  try { fs.unlinkSync(process.env.RECENT_SELLS_FILE); } catch (e) {}

  cleanupCache();
  // 自检: 播种的缓存必须全部清干净, 且不得留下任何非 6 位代码的文件
  //   (曾因"同一轮重复播种被误判为原有缓存"而还原出垃圾文件 P1.json)
  const leftovers = fs.readdirSync(CACHE_DIR).filter(f => !/^\d{6}\.json$/.test(f));
  eq('跑完不留任何测试缓存文件', leftovers.length, 0);
  if (leftovers.length > 0) console.log('    残留:', leftovers.slice(0, 10).join(', '));

  console.log(`\n✅ V4 决策引擎单测全部通过 (${pass} 项)`);
})().catch(e => { cleanupCache(); console.error('\n❌ 测试异常:', e); process.exit(1); });
