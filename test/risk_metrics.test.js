/**
 * 风险指标库单测 — 验证《基金量化模型与公式.md》缺失公式的正确性与缺值安全
 * 纯离线, 不依赖网络; 被 CI 调用 (node --trace-warnings test/risk_metrics.test.js)
 */
const assert = require('assert');
const RM = require('../src/risk_metrics');

let pass = 0;
function ok(name, cond) { assert.ok(cond, '❌ ' + name); console.log('  ✅ ' + name); pass++; }

console.log('== 风险指标库 risk_metrics 单元测试 ==');

// 1) 凯利精确公式 f* = (b·p - q)/b
ok('kelly(0.6, 1.5)=0.333', Math.abs(RM.kellyCriterion(0.6, 1.5) - 1 / 3) < 1e-9);
ok('kelly(0.5, 1)=0 (公平赌局)', Math.abs(RM.kellyCriterion(0.5, 1)) < 1e-9);
ok('kelly(0.4, 1)<0 (负期望不投)', RM.kellyCriterion(0.4, 1) < 0);
ok('半凯利=0.5*kelly', Math.abs(RM.kellyFractional(0.6, 1.5, 0.5) - RM.kellyCriterion(0.6, 1.5) * 0.5) < 1e-9);

// 2) 最大回撤: 100->120->90->130 => 谷90相对峰值120回撤 -25%
const navs = [100, 110, 120, 100, 90, 95, 130];
ok('maxDrawdown=-0.25', Math.abs(RM.maxDrawdown(navs) - (-0.25)) < 1e-9);
const rets = RM.dailyReturns(navs);
ok('maxDrawdownFromReturns 一致', Math.abs(RM.maxDrawdownFromReturns(rets) - (-0.25)) < 1e-9);

// 3) 下行标准差 (MAR=0): 只有负收益计入
const r3 = [0.02, -0.01, 0.03, -0.04, 0.01];
const dd = RM.downsideDeviation(r3, 0);
// 期望 sqrt(((−0.01)^2+(−0.04)^2)/5)
const expDD = Math.sqrt((0.0001 + 0.0016) / 5);
ok('downsideDeviation 公式正确', Math.abs(dd - expDD) < 1e-9);
ok('semiVariance 非负', RM.semiVariance(r3) >= 0);

// 4) 索提诺 vs 夏普: 下行波动低的序列索提诺应更高
const upTrend = [0.01, 0.01, 0.01, 0.01, -0.02]; // mostly up, one small down
const sortino = RM.sortinoRatio(upTrend, 0.02, 0, 252);
const sharpe = RM.sharpeRatio(upTrend, 0.02, 252);
ok('sortino 与 sharpe 均为有限数', Number.isFinite(sortino) && Number.isFinite(sharpe));
ok('sortino >= sharpe (仅看下行风险, 上行波动不罚)', sortino >= sharpe - 1e-9);

// 5) 卡玛: 上涨序列 + 浅回撤 => 正
ok('calmar 为正(上涨+浅回撤)', RM.calmarRatio(upTrend, 0, 252) > 0);

// 6) VaR / CVaR: 历史法 CVaR 应 <= VaR (更悲观的平均尾部)
const heavyTail = [-0.10, -0.08, -0.02, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07];
const vH = RM.varHistorical(heavyTail, 0.9);
const cH = RM.cvar(heavyTail, 0.9);
ok('CVaR(历史) <= VaR(历史)', cH <= vH + 1e-9);
ok('VaR历史 落在分布内', vH <= 0 && vH >= Math.min(...heavyTail));
ok('参数法 VaR 有限', Number.isFinite(RM.varParametric(heavyTail, 0.95)));

// 7) 信息比率: 组合稳定跑赢基准 => IR>0; 跑输 => IR<0
const bench = [0.01, -0.01, 0.02, -0.02, 0.015, -0.005, 0.02];
const beat = bench.map(r => r * 1.5 + 0.001);  // 高β且每期稳定多赚 -> 正超额且有方差
const lag = bench.map(r => r * 0.5 - 0.001);   // 低β且每期稳定少赚 -> 负超额
ok('IR>0 (稳定跑赢基准)', RM.informationRatio(beat, bench, 252) > 0);
ok('IR<0 (稳定跑输基准)', RM.informationRatio(lag, bench, 252) < 0);
ok('跟踪误差 与基准相同 => 0', Math.abs(RM.trackingError(bench, bench, 252)) < 1e-9);

// 8) Beta / Jensen's Alpha: 组合=2×基准 => beta≈2, alpha≈0
const mkt = [0.02, -0.03, 0.01, 0.04, -0.01, 0.02, -0.02, 0.03];
const doubled = mkt.map(r => 2 * r);
ok('beta≈2 (组合=2x基准)', Math.abs(RM.beta(doubled, mkt) - 2) < 1e-9);
// 纯β暴露(组合=2x基准)且无选股能力 => Jensen's α 应精确为0 (算术年化 CAPM 线性)
ok('jensenAlpha≈0 (纯β暴露, 无选股α)', Math.abs(RM.jensensAlpha(doubled, mkt, 0, 252)) < 1e-9);

// 9) 相关性: 完全正相关=1, 完全负相关=-1
const a = [1, 2, 3, 4, 5], b = [5, 4, 3, 2, 1];
ok('correlation 正相关≈1', Math.abs(RM.correlation(a, a) - 1) < 1e-9);
ok('correlation 负相关≈-1', Math.abs(RM.correlation(a, b) + 1) < 1e-9);

// 10) 欧米伽: 几乎全正、仅一丁点下行 => 极大有限值 (下行为0时 safeDiv 返回0防 Infinity 污染)
const allUp = [0.01, 0.02, 0.03, -0.0001];
ok('omega 几乎全正收益为大值(>1)', RM.omegaRatio(allUp, 0) > 1);

// 11) 偏度/峰度/Hurst 缺值安全
ok('skewness 短序列=0', RM.skewness([0.01]) === 0);
ok('kurtosis 短序列=0', RM.kurtosis([0.01]) === 0);
ok('hurst 短序列=0.5(中性)', Math.abs(RM.hurstIndex([0.01, 0.02]) - 0.5) < 1e-9);

// 12) 一键画像 computeRiskProfile 缺值安全 + 字段齐全
ok('空序列返回 null', RM.computeRiskProfile([]) === null);
ok('短序列(<5)返回 null', RM.computeRiskProfile([1, 2, 3]) === null);
const prof = RM.computeRiskProfile(navs, { rf: 0.02 });
ok('computeRiskProfile 含核心字段', prof && ['sortino', 'mdd', 'calmar', 'kelly', 'winRate', 'sharpe'].every(k => k in prof));
ok('computeRiskProfile.winRate ∈ [0,1]', prof.winRate >= 0 && prof.winRate <= 1);

console.log(`\n🎉 risk_metrics 测试全部通过 (${pass} 项)`);
