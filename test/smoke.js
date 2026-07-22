// 离线冒烟测试：验证核心模块可加载，且决策引擎能在不联网情况下产出操作建议。
// 用途：CI 与本地快速校验，不依赖实时行情 / 历史净值网络请求。
const assert = require('assert');

const { generateUltimatePortfolioAdvice } = require('../src/advisor_v5_ultimate');
const rt = require('../src/realtime_quotes');
const fl = require('../src/factor_library');
const wf = require('../src/walk_forward_pro');
const sh = require('../src/sensitivity_heatmap');
const po = require('../src/portfolio_optimizer');
const ns = require('../src/news_sentiment');
const de = require('../src/decision_explain');
const llm = require('../src/llm_report');

// 1) 模块导出检查
assert.strictEqual(typeof rt.fetchRealtimeSectorScores, 'function',
  'realtime_quotes.fetchRealtimeSectorScores 应导出为函数');
assert.strictEqual(typeof generateUltimatePortfolioAdvice, 'function',
  'advisor.generateUltimatePortfolioAdvice 应导出为函数');

// 2) 用伪造的实时分跑决策引擎（不联网），验证动态选基逻辑
const fakeScores = [
  { code: '011609', name: '易方达科创50联接C',  sector: '科创',     maxWeight: 0.25, changePct: 2.3,  mom5: 4.1, score: 2.9 },
  { code: '013402', name: '华夏恒生科技ETF联接C', sector: '恒生科技', maxWeight: 0.25, changePct: 1.8,  mom5: 3.2, score: 2.1 },
  { code: '008282', name: '国泰芯片ETF联接C',    sector: '半导体',   maxWeight: 0.30, changePct: 0.9,  mom5: 2.0, score: 1.2 },
  { code: '018503', name: '东财光伏C',            sector: '光伏',     maxWeight: 0.25, changePct: -0.3, mom5: 1.1, score: 0.4 },
  { code: '011840', name: '天弘中证人工智能C',    sector: '人工智能', maxWeight: 0.25, changePct: 0.5,  mom5: 0.8, score: 0.6 },
  { code: '027495', name: '易方达电池ETF联接C',   sector: '新能源',   maxWeight: 0.25, changePct: 0.2,  mom5: 0.3, score: 0.3 },
];

const advice = generateUltimatePortfolioAdvice(null, null, fakeScores);

assert.ok(Array.isArray(advice.operations), 'operations 应为数组');
assert.ok(Array.isArray(advice.realtimePicks), 'realtimePicks 应为数组');
assert.strictEqual(advice.realtimePicks.length, 2,
  '应动态挑选当日最强 2 只 (自迭代 topK=2), 实际=' + advice.realtimePicks.length);

// 验证挑出的确实是综合分最高的前 2 只（数据驱动 topK，非写死固定基金）
const picked = advice.realtimePicks.map(p => p.code).sort();
const expect = ['011609', '013402'].sort();
assert.deepStrictEqual(picked, expect,
  '动态选基应取综合分 Top2 (科创/恒生科技)');

console.log('✅ smoke test 通过');
console.log('   operations =', advice.operations.length);
console.log('   realtimePicks(Top2) =', advice.realtimePicks.map(p => `${p.code}:${p.sector}`).join(', '));

// 3) 新量化模块可加载且纯函数可用 (不联网)
assert.strictEqual(typeof fl.compositeScore, 'function', 'factor_library.compositeScore 应导出');
assert.strictEqual(typeof wf.walkForwardFolds, 'function', 'walk_forward_pro.walkForwardFolds 应导出');
assert.strictEqual(typeof sh.paramGrid, 'function', 'sensitivity_heatmap.paramGrid 应导出');
assert.strictEqual(typeof po.riskParityEWMA, 'function', 'portfolio_optimizer.riskParityEWMA 应导出');
assert.strictEqual(typeof ns.scoreTextSentiment, 'function', 'news_sentiment.scoreTextSentiment 应导出');
assert.strictEqual(typeof de.explainOperations, 'function', 'decision_explain.explainOperations 应导出');
assert.strictEqual(typeof llm.multiAgentDebate, 'function', 'llm_report.multiAgentDebate 应导出');

// 因子合成快速校验 (确定性, 需 >=21 点)
function gen(c, n) { const out = [1]; let v = 1; for (let i = 1; i < n; i++) { v *= 1 + 0.004 * Math.sin(i / 3 + c) + 0.01 * (c % 2 ? 1 : -1); out.push(v); } return out; }
const codes = ['X1', 'X2', 'X3'];
const cb = { X1: gen(1, 30), X2: gen(2, 30), X3: gen(3, 30) };
const tbl = fl.computeAllFactors(codes, cb, { sentiment: 60, news: 0.1 });
const z = fl.zscoreUniverse(tbl);
const ranked = fl.compositeScore(z, { momentum: 0.5, valuation: 0.3, sentiment: 0.2 });
assert.ok(Array.isArray(ranked) && ranked.length === 3, '因子合成分应返回 3 只排序结果');
console.log('   factor composite top1 =', ranked[0].code, 'score=', ranked[0].score);
console.log('✅ 新量化模块 (因子库/WF/敏感性/EWMA/舆情/归因/多Agent) 加载校验通过');
