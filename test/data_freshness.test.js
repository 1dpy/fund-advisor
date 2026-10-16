/**
 * 数据新鲜度检测单测
 *
 * 覆盖: 日期解析 / 交易日计龄 / 三档判定 / 退化行为 / V4 决策侧排除
 */
const assert = require('assert');
const path = require('path');
const {
  FRESHNESS_CONFIG,
  parseDateStr,
  tradingDaysBetween,
  assessFreshness,
  isUsableForDecision,
} = require('../src/data_freshness');
const { isTradingDay, nextTradingDay } = require('../src/t1_calendar');

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}
function eq(a, b, msg) {
  assert.strictEqual(a, b, `${msg} (实际 ${JSON.stringify(a)}, 期望 ${JSON.stringify(b)})`);
  passed++;
}
function section(t) { console.log(`\n【${t}】`); }

/**
 * 构造"交易日龄恰好为 n 天"的日期: 独立前向扫描实现, 不复用被测模块的循环,
 * 避免"用被测函数造输入"导致的循环论证。
 */
function countTradingDaysAfter(startDate, endDate) {
  let c = 0;
  const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  let guard = 0;
  while (guard++ < 1500) {
    d.setDate(d.getDate() + 1);
    if (d.getTime() > end.getTime()) break;
    if (isTradingDay(d)) c++;
  }
  return c;
}
function backTradingDays(n, now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let guard = 0;
  while (guard++ < 1500) {
    d.setDate(d.getDate() - 1);
    if (countTradingDaysAfter(d, now) === n) return d;
    if (countTradingDaysAfter(d, now) > n) break; // 越过目标, 防止无解时死循环
  }
  throw new Error(`未找到交易日龄恰为 ${n} 的日期`);
}
function fmt(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function mkHistory(lastDateStr, n = 60) {
  // 造 n 条以 lastDateStr 结尾的序列(前面日期不重要, 只取最后一条)
  const out = [];
  const end = parseDateStr(lastDateStr);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
    out.push({ date: fmt(d), nav: 1 + i * 0.001 });
  }
  return out;
}

(async () => {
  const now = new Date();

  section('1 日期解析');
  ok(parseDateStr('2026-10-16') instanceof Date, '合法日期应解析为 Date');
  eq(parseDateStr('2026-10-16').getDate(), 16, '日期应落在 16 号(本地时区, 不受 UTC 偏移影响)');
  eq(parseDateStr('2026-10-16 15:00:00').getDate(), 16, '带时刻的字符串也能解析');
  eq(parseDateStr(''), null, '空串应返回 null');
  eq(parseDateStr('not-a-date'), null, '非法字符串应返回 null');
  eq(parseDateStr(null), null, 'null 应返回 null');
  eq(parseDateStr(undefined), null, 'undefined 应返回 null');

  section('2 交易日计龄(不是自然日)');
  eq(tradingDaysBetween(now, now), 0, '同一天应为 0');
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  eq(tradingDaysBetween(now, tomorrow), isTradingDay(tomorrow) ? 1 : 0, '相邻一天最多计 1 个交易日');
  const past = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 10);
  const td = tradingDaysBetween(past, now);
  const cd = 10;
  ok(td <= cd, `交易日数(${td}) 必须 <= 自然日数(${cd}): 周末/节假日不该计入`);
  // 未来日期不算陈旧
  const future = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30);
  eq(tradingDaysBetween(future, now), 0, '起点在未来时计龄应为 0(不倒扣)');

  section('3 三档判定');
  // 今天(或最近交易日)出净值 → fresh
  const todayStr = fmt(now);
  const f0 = assessFreshness(mkHistory(todayStr), now);
  eq(f0.lastDate, todayStr, '应取到序列最后一条的日期');
  eq(f0.ageCalendarDays, 0, '自然日龄应为 0');
  eq(f0.level, 'fresh', '当天净值应为 fresh');
  ok(f0.usable, 'fresh 应可用');
  eq(f0.warning, null, 'fresh 不该有告警');

  // 回退 freshTradingDays 个交易日 → 仍 fresh(边界值)
  const dFresh = backTradingDays(FRESHNESS_CONFIG.freshTradingDays, now);
  const fFr = assessFreshness(mkHistory(fmt(dFresh)), now);
  eq(fFr.ageTradingDays, FRESHNESS_CONFIG.freshTradingDays, '交易日龄应精确等于构造值');
  eq(fFr.level, 'fresh', `回退 ${FRESHNESS_CONFIG.freshTradingDays} 个交易日仍应 fresh`);

  // 回退 fresh+1 → stale(告警但可用)
  const dStale = backTradingDays(FRESHNESS_CONFIG.freshTradingDays + 1, now);
  const fSt = assessFreshness(mkHistory(fmt(dStale)), now);
  eq(fSt.ageTradingDays, FRESHNESS_CONFIG.freshTradingDays + 1, 'stale 交易日龄应为 fresh+1');
  eq(fSt.level, 'stale', '超过 fresh 阈值应判 stale');
  ok(fSt.usable, 'stale 仍应可用(只是告警)');
  ok(typeof fSt.warning === 'string' && fSt.warning.includes('滞后'), 'stale 应有滞后告警');

  // 回退 dead 边界 → 仍 stale(dead 是"严格大于")
  const dDeadEdge = backTradingDays(FRESHNESS_CONFIG.deadTradingDays, now);
  eq(assessFreshness(mkHistory(fmt(dDeadEdge)), now).level, 'stale', 'dead 边界值仍应判 stale(严格大于才算 dead)');

  // 回退 dead+3 → dead(不可用)
  const dDead = backTradingDays(FRESHNESS_CONFIG.deadTradingDays + 3, now);
  const fDd = assessFreshness(mkHistory(fmt(dDead)), now);
  eq(fDd.level, 'dead', '超过 dead 阈值应判 dead');
  ok(!fDd.usable, 'dead 不应参与决策');
  ok(typeof fDd.warning === 'string' && fDd.warning.includes('未更新'), 'dead 应有停止更新告警');
  ok(fDd.ageCalendarDays > fDd.ageTradingDays, '自然日龄应大于交易日龄(说明确实按交易日计龄)');
  ok(fDd.ageTradingDays > fSt.ageTradingDays && fSt.ageTradingDays > fFr.ageTradingDays,
    '三档的交易日龄应严格递增');

  section('4 QDII 场景: 净值 T+2 公布不该被误杀');
  const dQdii = backTradingDays(2, now);
  const fQ = assessFreshness(mkHistory(fmt(dQdii)), now);
  eq(fQ.level, 'fresh', 'QDII 净值滞后 2 个交易日仍应判 fresh(阈值够宽松)');
  ok(fQ.usable, 'QDII 应可用');

  section('5 退化行为(不能因为缺数据就误杀)');
  eq(assessFreshness([], now).level, 'unknown', '空序列应为 unknown');
  ok(!assessFreshness([], now).usable, '空序列不可用');
  eq(assessFreshness(null, now).level, 'unknown', 'null 序列应为 unknown');
  const noDate = [{ nav: 1.1 }, { nav: 1.2 }];
  eq(assessFreshness(noDate, now).level, 'unknown', '无 date 字段应为 unknown');
  ok(assessFreshness(noDate, now).usable, '无 date 字段时应保持可用(不引入新的跳过)');
  // 末尾混入脏数据时, 应从后往前找到最近一条可解析的
  const withTrailing = mkHistory(fmt(dDead)).concat([{ date: null, nav: 0 }, { nav: undefined }]);
  eq(assessFreshness(withTrailing, now).level, 'dead', '末尾脏数据应被跳过, 取最近可解析日期');

  section('6 isUsableForDecision 便捷封装');
  ok(isUsableForDecision(mkHistory(todayStr), now), '当天数据应可用');
  ok(!isUsableForDecision(mkHistory(fmt(dDead)), now), '停止更新的数据应不可用');

  section('7 V4 决策侧: dead 基金不得出现在买入/转换指令里');
  const { generateAdviceV4 } = require('../src/advisor_v4');
  const { withSeed } = require('../src/quant/seeded_random');

  // 造两只基金: 一只 fresh 强信号, 一只 dead 强信号
  const buildFund = (code, lastDateStr, signal) => {
    const hist = mkHistory(lastDateStr, 60);
    return {
      code, name: `基金${code}`, score: 90,
      nav: hist[hist.length - 1].nav, price: hist[hist.length - 1].nav,
      history: hist,
      _fakeSignal: signal,
    };
  };

  // 直接打 advisor_v4 的真实导出闸门(而不是在测试里复制一遍过滤条件)
  const { isFreshEnoughToTrade } = require('../src/advisor_v4');

  const live = { code: '000001', freshness: { usable: true, level: 'fresh' } };
  const stale = { code: '000002', freshness: { usable: true, level: 'stale' } };
  const dead = { code: '000003', freshness: { usable: false, level: 'dead' } };
  ok(isFreshEnoughToTrade(live), 'fresh 应可交易');
  ok(isFreshEnoughToTrade(stale), 'stale 应可交易(仅告警)');
  ok(!isFreshEnoughToTrade(dead), 'dead 不应可交易');
  ok(isFreshEnoughToTrade({ code: '000004' }), '缺 freshness 字段时保持原行为(不误杀)');
  ok(isFreshEnoughToTrade(null), 'null 不应抛错');

  // 用闸门跑一遍真实过滤条件形状
  const funds = [
    { code: '000001', fusedSignal: { signal: 'STRONG_BUY' }, freshness: { usable: true } },
    { code: '000002', fusedSignal: { signal: 'STRONG_BUY' }, freshness: { usable: false } },
  ];
  const holdings = [];
  const strongCandidates = funds.filter(f =>
    f.fusedSignal && f.fusedSignal.signal === 'STRONG_BUY' &&
    !holdings.find(h => h.code === f.code) &&
    isFreshEnoughToTrade(f)
  );
  eq(strongCandidates.length, 1, 'dead 基金应被排除出强买候选');
  eq(strongCandidates[0].code, '000001', '留下的应是 fresh 那只');

  console.log(`\n✅ data_freshness: ${passed} 项断言全部通过`);
})().catch((e) => {
  console.error('\n❌ 测试失败:', e.message);
  process.exit(1);
});
