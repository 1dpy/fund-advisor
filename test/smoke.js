// 离线冒烟测试：验证核心模块可加载，且决策引擎能在不联网情况下产出操作建议。
// 用途：CI 与本地快速校验，不依赖实时行情 / 历史净值网络请求。
const assert = require('assert');

const { generateUltimatePortfolioAdvice } = require('../src/advisor_v5_ultimate');
const rt = require('../src/realtime_quotes');

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
assert.strictEqual(advice.realtimePicks.length, 4,
  '应动态挑选当日最强 4 只, 实际=' + advice.realtimePicks.length);

// 验证挑出的确实是综合分最高的前 4 只（而非写死固定基金）
const picked = advice.realtimePicks.map(p => p.code).sort();
const expect = ['008282', '011609', '013402', '018503'].sort();
assert.deepStrictEqual(picked, expect,
  '动态选基应取综合分 Top4 (半导体/科创/恒生科技/光伏)');

console.log('✅ smoke test 通过');
console.log('   operations =', advice.operations.length);
console.log('   realtimePicks(Top4) =', advice.realtimePicks.map(p => `${p.code}:${p.sector}`).join(', '));
