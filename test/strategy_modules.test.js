/**
 * 策略模块单元测试 — 验证《基金量化模型与公式.md》§4/§5/§7/§8 策略公式的正确性与缺值安全
 * 纯离线, 不依赖网络; 被 CI 调用 (node --trace-warnings test/strategy_modules.test.js)
 */
const assert = require('assert');
const TM = require('../src/timing_models');
const EX = require('../src/strategy_execution');
const SA = require('../src/style_analysis');

let pass = 0;
function ok(name, cond) { assert.ok(cond, '❌ ' + name); console.log('  ✅ ' + name); pass++; }
// 确定性伪随机 (便于构造可复现数据)
function makeRng(seed) { let s = seed >>> 0; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

console.log('== 策略模块单元测试 ==\n');

// ---------- §4 TM/HM 择时回归 ----------
console.log('【§4 择时能力回归 TM/HM】');
// 1) 纯市场暴露(无择时无α): Rp = Rm  => α≈0, β≈1, γ≈0
const rng = makeRng(20260724);
const Rm = Array.from({ length: 200 }, () => (rng() - 0.5) * 0.04);
const RpPure = Rm.slice(); // Rp = Rm
const tm1 = TM.treynorMazuy(RpPure, Rm, 0.02, 252);
const hm1 = TM.henikrssonMerton(RpPure, Rm, 0.02, 252);
ok('TM 纯市场: α≈0', Math.abs(tm1.alpha) < 1e-6);
ok('TM 纯市场: β≈1', Math.abs(tm1.beta - 1) < 1e-6);
ok('TM 纯市场: γ≈0(无择时)', Math.abs(tm1.gamma) < 1e-6);
ok('HM 纯市场: γ≈0(无择时)', Math.abs(hm1.gamma) < 1e-6);
ok('TM/HM 返回 r2 有限', Number.isFinite(tm1.r2) && Number.isFinite(hm1.r2));

// 2) 有择时(牛市加杠杆): 上行时 β=2, 下行时 β=0.5 => γ>0
const RpTiming = Rm.map(x => (x > 0 ? 2 * x : 0.5 * x));
const tm2 = TM.treynorMazuy(RpTiming, Rm, 0, 252);
const hm2 = TM.henikrssonMerton(RpTiming, Rm, 0, 252);
ok('TM 择时: γ>0 (凸性)', tm2.gamma > 0);
ok('HM 择时: γ>0 (上行暴露放大)', hm2.gamma > 0);

// 3) 缺值安全: 序列过短返回 null
ok('TM 短序列=null', TM.treynorMazuy([0.01, 0.02], [0.01, 0.02]) === null);
ok('HM 长度不匹配=null', TM.henikrssonMerton([0.01, 0.02, 0.03], [0.01, 0.02]) === null);

// 4) OLS 基础: y = 2x + 1 精确恢复
const xs = [1, 2, 3, 4, 5], ys = xs.map(x => 2 * x + 1);
const coef = TM.olsFit(xs.map(x => [1, x]), ys);
ok('OLS 截距≈1', Math.abs(coef[0] - 1) < 1e-9);
ok('OLS 斜率≈2', Math.abs(coef[1] - 2) < 1e-9);

// ---------- §7 估值分位 / 均线 / 美林时钟 ----------
console.log('\n【§7 估值分位 / 均线 / 美林时钟】');
// 5) 估值分位
const peHist = [10, 20, 30, 40, 50];
ok('估值分位 25→合理(40%)', TM.valuationPercentile(peHist, 25).pct === 40 && TM.valuationPercentile(peHist, 25).label === '合理');
ok('估值分位 8→低估(0%)', TM.valuationPercentile(peHist, 8).label === '低估');
ok('估值分位 55→高估(100%)', TM.valuationPercentile(peHist, 55).label === '高估');
ok('估值分位 空序列安全', TM.valuationPercentile([], 10).label === 'N/A');

// 6) 均线趋势: 上行穿越(金叉) 检测
const navUpCross = [5, 4, 3, 4]; // window=3: 末端均线上穿
const ma = TM.maTrend(navUpCross, 3);
ok('均线 上穿→bullish', ma.cross === 'up' && ma.signal === 'bullish');
const navDown = [1, 2, 3, 2]; // 末端跌破均线
const ma2 = TM.maTrend(navDown, 3);
ok('均线 跌破→weak/bearish', ma2.position === 'below');
ok('均线 短序列安全', TM.maTrend([1]) === null);

// 7) 美林时钟四象限
const mc1 = TM.merrillClock({ growth: 'up', inflation: 'down' });
ok('美林 复苏(增长↑通胀↓)', mc1.regime === 'RECOVERY' && mc1.name === '复苏');
const mc2 = TM.merrillClock({ growth: 'up', inflation: 'up' });
ok('美林 过热(增长↑通胀↑)', mc2.regime === 'OVERHEAT');
const mc3 = TM.merrillClock({ growth: 'down', inflation: 'up' });
ok('美林 滞胀(增长↓通胀↑)', mc3.regime === 'STAGFLATION');
const mc4 = TM.merrillClock({ growth: 'down', inflation: 'down' });
ok('美林 衰退(增长↓通胀↓)', mc4.regime === 'RECESSION');
ok('美林 数值输入: 增长3%>0→up', TM.merrillClock({ growth: 3.0, inflation: 1.5 }).growthUp === true);

// ---------- §8 定投 / 网格 / 再平衡 / 熔断 ----------
console.log('\n【§8 定投 / 网格 / 再平衡 / 熔断】');
// 8) 定投摊薄: navs=[1,2,1], 每期100 => 份额 100+50+100=250, 投入300, 均价1.2, 当前净值1 => 浮亏
const dca = EX.dcaCost([1, 2, 1], 100);
ok('定投 总份额=250', Math.abs(dca.totalShares - 250) < 1e-6);
ok('定投 投入=300', dca.totalInvested === 300);
ok('定投 均价=1.2', Math.abs(dca.avgCost - 1.2) < 1e-6);
ok('定投 当前净值1→浮亏(-1/6≈-16.7%)', Math.abs(dca.totalReturn - (-1 / 6)) < 1e-3);
ok('定投 breakeven=均价', Math.abs(dca.breakevenNav - 1.2) < 1e-6);
ok('定投 空序列安全', EX.dcaCost([], 100).periods === 0);

// 9) 网格交易: 区间内震荡, 仓位不为负, 有成交, PnL 有限
const navGrid = [1.5, 1.2, 1.8, 1.0, 2.0, 1.3, 1.9]; // 均在 [1,2] 内
const grid = EX.gridTrading(navGrid, { lower: 1, upper: 2, grids: 4, sharesPerGrid: 100 });
ok('网格 价位数=grids+1=5', grid.levels.length === 5);
ok('网格 有成交记录', grid.trades.length > 0);
ok('网格 持仓≥0(不卖空)', grid.position >= 0);
ok('网格 totalPnl 有限', Number.isFinite(grid.totalPnl));
ok('网格 参数无效→安全', EX.gridTrading([1, 2], { lower: 2, upper: 1 }).error === '参数无效');

// 10) 再平衡: 当前{A:0.5,B:0.5} → 目标{A:0.6,B:0.4}, 总值1000
const rb = EX.rebalanceTarget({ A: 0.5, B: 0.5 }, { A: 0.6, B: 0.4 }, 1000);
const aBuy = rb.find(r => r.code === 'A'), bSell = rb.find(r => r.code === 'B');
ok('再平衡 A 买入 +100', aBuy.action === 'BUY' && aBuy.deltaValue === 100);
ok('再平衡 B 卖出 -100', bSell.action === 'SELL' && bSell.deltaValue === -100);
// 微小偏差忽略
ok('再平衡 阈值内→HOLD', EX.rebalanceTarget({ A: 0.501 }, { A: 0.5 }, 1000)[0].action === 'HOLD');

// 11) 回撤熔断: 权益[100,110,90,95], 阈值15% => 在90处回撤-18.2%触发
const dd = EX.drawdownCircuitBreaker([100, 110, 90, 95], 0.15);
ok('熔断 触发', dd.triggered === true);
ok('熔断 最大回撤≈-0.1818', Math.abs(dd.maxDrawdown - (-0.1818)) < 1e-3);
ok('熔断 触发下标=2', dd.triggerIndex === 2);
ok('熔断 未超阈值→不触发', EX.drawdownCircuitBreaker([100, 101, 102], 0.15).triggered === false);

// ---------- §5 风格约束回归 ----------
console.log('\n【§5 风格约束回归】');
// 12) 精确恢复: Rp = 0.6·成长 + 0.4·价值 (纯线性, 解在单纯形内部)
const sr = makeRng(99);
const g = [], v = [];
for (let i = 0; i < 300; i++) { g.push((sr() - 0.5) * 0.04); v.push((sr() - 0.5) * 0.04); }
const RpMix = g.map((x, i) => 0.6 * x + 0.4 * v[i]);
const styleMat = g.map((x, i) => [x, v[i]]);
const srRes = SA.styleRegression(RpMix, styleMat, ['成长', '价值']);
ok('风格 精确恢复 成长≈0.6', srRes && Math.abs(srRes.weights['成长'] - 0.6) < 1e-3);
ok('风格 精确恢复 价值≈0.4', srRes && Math.abs(srRes.weights['价值'] - 0.4) < 1e-3);
ok('风格 R²≈1(完美拟合)', srRes && srRes.r2 > 0.999);

// 13) 约束起作用: Rp = 成长 - 0.5·价值 (无约束解价值为负) → 投影后价值权重=0, 成长=1
const RpBind = g.map((x, i) => x - 0.5 * v[i]);
const srRes2 = SA.styleRegression(RpBind, styleMat, ['成长', '价值']);
ok('风格 约束绑定: 成长≈1', srRes2 && Math.abs(srRes2.weights['成长'] - 1) < 1e-3);
ok('风格 约束绑定: 价值≈0', srRes2 && Math.abs(srRes2.weights['价值']) < 1e-3);

// 14) 投影到单纯形
const p1 = SA.projectToSimplex([0.5, 0.5, 0.5]);
ok('单纯形 [0.5,0.5,0.5]→[1/3,1/3,1/3]', Math.abs(p1[0] - 1 / 3) < 1e-9 && Math.abs(p1.reduce((s, x) => s + x, 0) - 1) < 1e-9);
const p2 = SA.projectToSimplex([2, 0, 0]);
ok('单纯形 [2,0,0]→[1,0,0]', Math.abs(p2[0] - 1) < 1e-9 && p2[1] === 0);
const p3 = SA.projectToSimplex([-1, 2, 2]);
ok('单纯形 [-1,2,2]→[0,0.5,0.5]', Math.abs(p3[1] - 0.5) < 1e-9 && Math.abs(p3.reduce((s, x) => s + x, 0) - 1) < 1e-9);

// 15) 风格漂移检测
const driftTrue = SA.detectStyleDrift({ 成长: 0.2, 价值: 0.8 }, '成长');
ok('漂移 实际价值主导≠名义成长→drift', driftTrue.drift === true && driftTrue.estimatedTopStyle === '价值');
const driftFalse = SA.detectStyleDrift({ 成长: 0.9, 价值: 0.1 }, '成长');
ok('一致 实际成长主导=名义→不漂移', driftFalse.drift === false);

console.log(`\n🎉 策略模块测试全部通过 (${pass} 项)`);
