/**
 * apply_advice.js 单测 (V5/V6 路径的持仓回写)
 *
 * 重点验证跨引擎字段一致性: 本文件(V5/V6)与 advisor_v3.applyDecisions(V4 默认引擎)
 * 写同一个 holdings.json, 必须同时维护 currentValue 与 shares/costBasis,
 * 否则跑完 --ultimate --apply 后 V4 会按旧成本算盈亏、误触发止损/止盈。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'applyadvice-'));
const HOLDINGS = path.join(TMP, 'holdings.json');

// ★ 双重隔离, 绝不碰用户真实数据:
//   HOLDINGS_FILE      → 账本走临时目录
//   APPLY_ARTIFACT_DIR → 备份/回撤记录也走临时目录。
//     不隔离的话 backupHoldings 只保留最近 5 份, 一轮测试就会把用户真实的
//     holdings.applybak.* 全顶掉, 而且顶上去的还是测试数据。
process.env.HOLDINGS_FILE = HOLDINGS;
process.env.APPLY_ARTIFACT_DIR = TMP;

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); console.log('  ✅ ' + msg); passed++; }
function eq(a, b, msg) { assert.strictEqual(a, b, `${msg} (实际 ${JSON.stringify(a)}, 期望 ${JSON.stringify(b)})`); console.log('  ✅ ' + msg); passed++; }
function near(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, `${msg} (实际 ${a}, 期望 ${b}±${tol})`); console.log('  ✅ ' + msg); passed++; }
function section(t) { console.log(`\n【${t}】`); }

const NAV_A = 1.5;
function writeHoldings(list) { fs.writeFileSync(HOLDINGS, JSON.stringify(list, null, 2)); }
function readHoldings() { return JSON.parse(fs.readFileSync(HOLDINGS, 'utf8')); }
function get(code) { return readHoldings().find(h => h.code === code); }

/** 预置本地净值缓存, 供 lookupNav 取份额折算用的净值 */
function seedNavCache(code, nav) {
  const dir = path.join(ROOT, 'data_cache');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${code}.json`);
  const existed = fs.existsSync(f);
  if (!existed) fs.writeFileSync(f, JSON.stringify({
    code, history: [{ date: '2026-10-16', nav }, { date: '2026-10-15', nav: nav - 0.01 }],
  }));
  SEEDED_CACHE.add(f);
}
const SEEDED_CACHE = new Set();

const { applyAdvice, revertLast } = require('../src/apply_advice');

(async () => {
  section('1 买入: 市值 / 成本 / 份额 三者必须一起动');
  seedNavCache('000AAA', NAV_A);
  writeHoldings([
    { code: 'CASH_YEB', name: '现金', type: 'cash', buyPrice: 1, shares: 1, costBasis: 10000, currentValue: 10000, buyDate: '2026-01-01' },
    { code: '000AAA', name: 'A基金', type: 'fund', buyPrice: 1.4, shares: 1000, costBasis: 1400, currentValue: 1500, buyDate: '2026-02-01' },
  ]);
  let r = applyAdvice({ operations: [{ action: 'BUY', code: '000AAA', name: 'A基金', amount: 300 }] });
  const a1 = get('000AAA');
  near(a1.currentValue, 1800, 0.01, '买入后市值 = 1500 + 300');
  near(a1.costBasis, 1700, 0.01, '买入后成本 = 1400 + 300 (与净值无关, 必须同步)');
  near(a1.shares, 1000 + 300 / NAV_A, 0.001, `买入后份额 = 1000 + 300/${NAV_A} = 1200`);
  near(get('CASH_YEB').currentValue, 9700, 0.01, '现金等额减少');
  ok(r.log.length > 0, '有执行日志');

  section('2 卖出: 成本与份额按卖出占比同比例结转(不能只减市值)');
  // 卖出一半市值: 1500 → 750 (50%)
  writeHoldings([
    { code: 'CASH_YEB', name: '现金', type: 'cash', buyPrice: 1, shares: 1, costBasis: 10000, currentValue: 10000 },
    { code: '000AAA', name: 'A基金', type: 'fund', buyPrice: 1.4, shares: 1000, costBasis: 1400, currentValue: 1500 },
  ]);
  applyAdvice({ operations: [{ action: 'SELL', code: '000AAA', name: 'A基金', amount: 750 }] });
  const a2 = get('000AAA');
  near(a2.currentValue, 750, 0.01, '市值 1500 → 750');
  near(a2.costBasis, 700, 0.01, '成本按 50% 结转 1400 → 700 (原来根本不动, V4 会读到 1400)');
  near(a2.shares, 500, 0.001, '份额按 50% 结转 1000 → 500');
  near(get('CASH_YEB').currentValue, 10750, 0.01, '现金等额增加');

  section('3 转换: 源按占比减, 目标按净值加');
  seedNavCache('000BBB', 2.0);
  writeHoldings([
    { code: 'CASH_YEB', name: '现金', type: 'cash', buyPrice: 1, shares: 1, costBasis: 10000, currentValue: 10000 },
    { code: '000AAA', name: 'A基金', type: 'fund', buyPrice: 1.4, shares: 1000, costBasis: 1400, currentValue: 1500 },
  ]);
  applyAdvice({ operations: [{ action: 'CONVERT', code: '000AAA', name: 'A基金', amount: 600, target: '000BBB B基金' }] });
  const src = get('000AAA'), tgt = get('000BBB');
  near(src.currentValue, 900, 0.01, '源市值 1500 → 900');
  near(src.costBasis, 840, 0.01, '源成本按 60% 结转');
  near(src.shares, 600, 0.001, '源份额按 60% 结转');
  ok(!!tgt, '目标基金被创建');
  near(tgt.currentValue, 600, 0.01, '目标市值 = 600');
  near(tgt.costBasis, 600, 0.01, '目标成本 = 600');
  near(tgt.shares, 300, 0.001, `目标份额 = 600/2.0 = 300`);
  near(get('CASH_YEB').currentValue, 10000, 0.01, '转换不动现金');

  section('4 无可用净值时: 不瞎填份额, 明确告警');
  writeHoldings([
    { code: 'CASH_YEB', name: '现金', type: 'cash', buyPrice: 1, shares: 1, costBasis: 10000, currentValue: 10000 },
  ]);
  const r4 = applyAdvice({ operations: [{ action: 'BUY', code: 'ZZZZZZ', name: '无净值基金', amount: 500 }] });
  const z = get('ZZZZZZ');
  near(z.costBasis, 500, 0.01, '成本仍然正确(与净值无关)');
  near(z.currentValue, 500, 0.01, '市值仍然正确');
  eq(z.shares, 0, '份额保持 0, 不臆造');
  eq(z.needsNavSync, true, '打上 needsNavSync 标记');
  ok(r4.log.some(l => l.includes('无可用净值')), '日志里有明确告警');

  section('5 回撤: 反向操作也要同步成本与份额');
  seedNavCache('000CCC', 1.0);
  writeHoldings([
    { code: 'CASH_YEB', name: '现金', type: 'cash', buyPrice: 1, shares: 1, costBasis: 10000, currentValue: 10000 },
    { code: '000CCC', name: 'C基金', type: 'fund', buyPrice: 1.0, shares: 1000, costBasis: 1000, currentValue: 1000 },
  ]);
  applyAdvice({ operations: [{ action: 'BUY', code: '000CCC', name: 'C基金', amount: 400 }] });
  const cAfter = get('000CCC');
  near(cAfter.currentValue, 1400, 0.01, '买入后市值 1400');
  near(cAfter.costBasis, 1400, 0.01, '买入后成本 1400');
  near(cAfter.shares, 1400, 0.001, '买入后份额 1400');
  const rr = revertLast();
  ok(rr.ok === true || rr.log, '回撤执行了');
  const cRev = get('000CCC');
  near(cRev.currentValue, 1000, 1, '回撤后市值回到 1000');
  near(cRev.costBasis, 1000, 1, '回撤后成本回到 1000(原来只回滚市值, 成本会虚高)');
  near(cRev.shares, 1000, 1, '回撤后份额回到 1000');

  section('6 现金守恒: 买入总额不得超过现金');
  writeHoldings([
    { code: 'CASH_YEB', name: '现金', type: 'cash', buyPrice: 1, shares: 1, costBasis: 1000, currentValue: 1000 },
    { code: '000AAA', name: 'A基金', type: 'fund', buyPrice: 1.4, shares: 100, costBasis: 140, currentValue: 150 },
  ]);
  applyAdvice({ operations: [
    { action: 'BUY', code: '000AAA', name: 'A基金', amount: 900 },
    { action: 'BUY', code: '000AAA', name: 'A基金', amount: 900 },
  ] });
  ok(get('CASH_YEB').currentValue >= -0.01, `现金不为负 (实际 ${get('CASH_YEB').currentValue})`);
  const totalA = get('000AAA').currentValue + get('CASH_YEB').currentValue;
  near(totalA, 1150, 0.01, '总资产守恒: 150 + 1000 = 1150');

  console.log(`\n✅ apply_advice: ${passed} 项断言全部通过`);
})().catch((e) => {
  console.error('\n❌ 测试失败:', e.message);
  process.exit(1);
}).finally(() => {
  // 清理: 删临时目录(账本 + 备份 + last_applied) 与本次造的净值缓存
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  for (const f of SEEDED_CACHE) { try { fs.unlinkSync(f); } catch (e) {} }
});
