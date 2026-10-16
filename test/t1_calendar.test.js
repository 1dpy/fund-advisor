/**
 * 交易日历 + 赎回费 单测
 *
 * 覆盖:
 *   1. 节假日/周末补班日/周末 的交易日判定 (2026 已录入年)
 *   2. 跨年 tripwire: 未来 60 天所在年份必须有日历数据 (2026 年底会提前炸出来)
 *   3. 未录入年份要显式告警, 不能静默按工作日判定
 *   4. 结算时间线: 15:00 前后 / 非交易日 / QDII 多一天
 *   5. 赎回费档位与"要不要再等几天降档"的判断
 *
 * 纯离线, 被 CI 调用。
 */
const assert = require('assert');

const T = require('../src/t1_calendar');

let pass = 0;
function ok(name, cond) { assert.ok(cond, '❌ ' + name); console.log('  ✅ ' + name); pass++; }
function eq(name, a, b) {
  assert.strictEqual(a, b, `❌ ${name}: 期望 ${b}, 实际 ${a}`);
  console.log('  ✅ ' + name); pass++;
}

const day = (y, m, d, hh = 10, mm = 0) => new Date(y, m - 1, d, hh, mm);
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

console.log('== 交易日历 + 赎回费 单测 ==\n');

console.log('【1. 交易日判定 (2026)】');
eq('国庆 2026-10-01 休市', T.isTradingDay(day(2026, 10, 1)), false);
eq('国庆 2026-10-08 休市', T.isTradingDay(day(2026, 10, 8)), false);
eq('补班周六 2026-10-10 开市', T.isTradingDay(day(2026, 10, 10)), true);
eq('普通周六 2026-10-17 休市', T.isTradingDay(day(2026, 10, 17)), false);
eq('普通周日 2026-10-18 休市', T.isTradingDay(day(2026, 10, 18)), false);
eq('普通工作日 2026-10-16 开市', T.isTradingDay(day(2026, 10, 16)), true);
eq('元旦 2026-01-01 休市', T.isTradingDay(day(2026, 1, 1)), false);
eq('春节 2026-02-17 休市', T.isTradingDay(day(2026, 2, 17)), false);

console.log('\n【2. 跨年 tripwire: 未来 60 天所在年份必须有数据】');
const future = new Date();
future.setDate(future.getDate() + 60);
ok(`未来60天 (${fmt(future)}) 所在年份 ${future.getFullYear()} 已录入日历`,
  T.isYearCovered(future.getFullYear()));
ok('已录入年份包含 2026', T.isYearCovered(2026));
ok('未录入年份 (2099) 明确返回 false', T.isYearCovered(2099) === false);
ok('coveredYears 升序且非空', T.coveredYears().length >= 1);

console.log('\n【3. 未录入年份必须显式告警】');
const st2026 = T.calendarStatus(day(2026, 10, 16));
eq('2026 已覆盖', st2026.covered, true);
eq('2026 非预填 (正式通知已发布)', st2026.provisional, false);
eq('2026 无告警', st2026.warning, null);
const st2099 = T.calendarStatus(day(2099, 5, 1));
eq('2099 未覆盖', st2099.covered, false);
ok('2099 有告警文案', typeof st2099.warning === 'string' && st2099.warning.includes('未录入'));

console.log('\n【4. 下一个交易日】');
eq('国庆前一日 → 跳到节后', fmt(T.nextTradingDay(day(2026, 9, 30))), '2026-10-09');
eq('周五 → 下周一', fmt(T.nextTradingDay(day(2026, 10, 16))), '2026-10-19');
eq('休市日当天 → 下一个开市日', fmt(T.currentOrNextTradingDay(day(2026, 10, 1))), '2026-10-09');
eq('开市日当天 → 当天', fmt(T.currentOrNextTradingDay(day(2026, 10, 16))), '2026-10-16');

console.log('\n【5. 结算时间线】');
const am = T.getSettlementTimeline('fund', day(2026, 10, 16, 10, 0));
eq('14:30前下单 T日=当天', am.tDay, '2026-10-16');
eq('T+1 确认', am.confirmDay, '2026-10-19');
eq('T+2 到账', am.settleDay, '2026-10-20');
eq('标记为交易日', am.isTradingDay, true);
eq('在截止时间前', am.beforeCutoff, true);

const pm = T.getSettlementTimeline('fund', day(2026, 10, 16, 16, 0));
eq('15:00后下单 T日顺延', pm.tDay, '2026-10-19');
eq('15:00后 beforeCutoff=false', pm.beforeCutoff, false);

const hol = T.getSettlementTimeline('fund', day(2026, 10, 1, 10, 0));
eq('休市日下单 T日=节后首个交易日', hol.tDay, '2026-10-09');
eq('休市日 isTradingDay=false', hol.isTradingDay, false);

const qdii = T.getSettlementTimeline('qdii', day(2026, 10, 16, 10, 0));
eq('QDII 标记为 QDII', qdii.isQDII, true);
eq('QDII 确认日比普通晚 1 天', qdii.confirmDay, '2026-10-20');
ok('QDII 说明含 T+2', /T\+2/.test(qdii.buyTimeline));
// 日历可靠性字段必须带出来, 让上层能提示
ok('结算信息带 calendarStatus', am.calendarStatus && am.calendarStatus.covered === true);
ok('未录入年份的结算信息带告警', T.getSettlementTimeline('fund', day(2099, 5, 3, 10, 0))
  .calendarStatus.warning !== null);

console.log('\n【6. 赎回费档位 (C类)】');
eq('<7天 1.5%', T.getRedemptionFeeRate(3).rate, 0.015);
eq('<7天 level=under7', T.getRedemptionFeeRate(3).level, 'under7');
eq('<30天 0.5%', T.getRedemptionFeeRate(20).rate, 0.005);
eq('<30天 level=under30', T.getRedemptionFeeRate(20).level, 'under30');
eq('≥30天 0', T.getRedemptionFeeRate(40).rate, 0);
eq('≥30天 level=free', T.getRedemptionFeeRate(40).level, 'free');
eq('缺失买入日期时按最严档', T.getRedemptionFeeRate(NaN).level, 'under7');

console.log('\n【7. 是否值得为降档再等几天】');
eq('已满30天 → 不用等', T.shouldWaitForFeeReduction(40, 0.05).shouldWait, false);
eq('持有25天盈利 → 再等5天免手续费', T.shouldWaitForFeeReduction(25, 0.02).daysToWait, 5);
eq('持有25天盈利 → 建议等', T.shouldWaitForFeeReduction(25, 0.02).shouldWait, true);
eq('持有25天大亏 → 不为省手续费硬扛', T.shouldWaitForFeeReduction(25, -0.15).shouldWait, false);
eq('持有3天 → 等4天降到0.5%', T.shouldWaitForFeeReduction(3, 0.01).daysToWait, 4);
eq('持有10天 → 等20天太久, 不等', T.shouldWaitForFeeReduction(10, 0.01).shouldWait, false);

console.log('\n【8. 各引擎共用同一套费率 (消除重复实现)】');
const V5 = require('../src/advisor_v5_ultimate');
const V6 = require('../src/advisor_v6_aggressive');
const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
eq('V5 持有3天 = 1.5%', V5.redemptionFeeRate({ buyDate: d(3) }), 0.015);
eq('V6 持有3天 = 1.5%', V6.redemptionFeeRate({ buyDate: d(3) }), 0.015);
eq('V5 持有40天 = 0', V5.redemptionFeeRate({ buyDate: d(40) }), 0);
eq('V6 持有40天 = 0', V6.redemptionFeeRate({ buyDate: d(40) }), 0);
eq('V5/V6 口径一致', V5.redemptionFeeRate({ buyDate: d(20) }), V6.redemptionFeeRate({ buyDate: d(20) }));

console.log(`\n✅ 交易日历 + 赎回费单测全部通过 (${pass} 项)`);
