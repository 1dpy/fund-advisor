// 离线量化校验：用确定性合成数据验证 P0 多因子 / walk-forward / 敏感性热力图
// 不依赖任何网络请求，可在 CI 中稳定运行（npm run quant:offline）。
const assert = require('assert');
const fl = require('../src/factor_library');
const wf = require('../src/walk_forward_pro');
const sh = require('../src/sensitivity_heatmap');
const { heatmapSVG } = require('../src/report_chart');

// 1) 确定性合成净值：带漂移的几何随机游走（种子化）
function mulberry32(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function genSeries(seed, drift, vol, n = 220) {
  const rng = mulberry32(seed); const out = [1];
  for (let i = 1; i < n; i++) { const z = Math.sqrt(-2 * Math.log(rng() + 1e-9)) * Math.cos(2 * Math.PI * rng()); out.push(out[out.length - 1] * (1 + drift / 252 + (vol / Math.sqrt(252)) * z)); }
  return out;
}
const codes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const closesByCode = {};
codes.forEach((c, i) => { closesByCode[c] = genSeries(1000 + i * 7, 0.12 + (i % 3) * 0.05, 0.25, 220); });

// 2) 因子库
const table = fl.computeAllFactors(codes, closesByCode, { sentiment: 62, news: 0.2 });
for (const c of codes) assert.ok(table[c], `因子表应包含 ${c}`);
const z = fl.zscoreUniverse(table);
const ranked = fl.compositeScore(z, { momentum: 0.5, valuation: 0.3, sentiment: 0.2 });
assert.strictEqual(ranked.length, codes.length, '合成分数量应等于标的数');
assert.ok(ranked.every((r) => typeof r.score === 'number' && isFinite(r.score)), '合成分应为有限数');
assert.ok(ranked.every((r) => r.contrib && typeof r.contrib.momentum === 'number'), '应含三类贡献度');

// 3) 严格 walk-forward 全周期回测（因子模型）
const fitFn = wf.makeFactorFitFn(closesByCode, { weights: { momentum: 0.5, valuation: 0.3, sentiment: 0.2 }, topK: 3 });
const wb = wf.walkForwardBacktest({ closesByCode, codes, fitFn, opts: { start: 60, rebal: 5 } });
assert.ok(wb.curve.length > 100, '因子模型应产出权益曲线');
assert.ok(isFinite(wb.stats.sharpe), '夏普应为有限数');

// 4) 折叠式 WF（过拟合检测）
const folds = wf.walkForwardFolds({ closesByCode, codes, fitFn, opts: { start: 60, trainMin: 60, foldStep: 20, embargo: 5 } });
assert.ok(folds && folds.folds.length >= 3, '应至少 3 折');
assert.ok(isFinite(folds.avgTestSharpe), '平均OOS夏普应为有限数');
console.log('  WF折数=', folds.folds.length, ' avgTestSharpe=', folds.avgTestSharpe, ' avgDegradation=', folds.avgDegradation);

// 5) 参数敏感性热力图
const rows = [0, 0.25, 0.5, 0.75, 1].map((v) => ({ label: `mom=${v}`, value: v }));
const cols = [0, 0.25, 0.5, 0.75, 1].map((v) => ({ label: `val=${v}`, value: v }));
const grid = sh.paramGrid({
  rows, cols,
  evalFn: (momW, valW) => {
    const sw = Math.max(0, 1 - momW - valW);
    const f = wf.makeFactorFitFn(closesByCode, { weights: { momentum: momW, valuation: valW, sentiment: sw }, topK: 3 });
    const r = wf.walkForwardBacktest({ closesByCode, codes, fitFn: f, opts: { start: 60, rebal: 5 } });
    return r.stats.total * 100;
  },
});
assert.strictEqual(grid.matrix.length, 5);
assert.strictEqual(grid.matrix[0].length, 5);
const range = sh.matrixRange(grid.matrix);
assert.ok(isFinite(range.lo) && isFinite(range.hi), '热力图范围应有限');

// 6) 渲染 SVG（确认不报错、含 rect）
const svg = heatmapSVG(grid.matrix, { rowLabels: grid.rowLabels, colLabels: grid.colLabels, lo: range.lo, hi: range.hi });
assert.ok(svg.includes('<rect'), '热力图SVG应含单元格');
assert.ok(svg.includes('svg'), '应为合法SVG');

console.log('✅ offline_quant 通过 (因子/WF/敏感性/热力图)');
console.log('   因子Top3:', ranked.slice(0, 3).map((r) => `${r.code}:${r.score}`).join(', '));
console.log('   热力图收益区间:', range.lo.toFixed(1) + '% ~ ' + range.hi.toFixed(1) + '%');

// 7) EWMA 协方差 / 风险平价 (P1)
const po = require('../src/portfolio_optimizer');
const ew = po.ewmaCovariance(po.dailyReturns(closesByCode), 0.94);
assert.strictEqual(ew.matrix.length, codes.length, 'EWMA 协方差矩阵维度应等于标的数');
assert.ok(ew.vols && typeof ew.vols[codes[0]] === 'number', '应返回年化波动率');
const rpE = po.riskParityEWMA(closesByCode, { maxWeight: 0.4, lambda: 0.94 });
assert.ok(rpE.weights && Object.keys(rpE.weights).length === codes.length, 'EWMA风险平价应返回权重');
console.log('   EWMA风险平价夏普=', rpE.sharpe, ' vol(A)=', (ew.vols.A * 100).toFixed(1) + '%');

// 8) P2 模块可加载且离线可用
const ns = require('../src/news_sentiment');
const de = require('../src/decision_explain');
const llm = require('../src/llm_report');
assert.strictEqual(typeof ns.scoreTextSentiment('利好大涨'), 'number', 'news_sentiment.scoreTextSentiment 应返回数值');
const exp = de.explainOperations([{ code: 'A', name: '基金A', action: 'BUY' }], (c) => ({ score: 0.6, contrib: { momentum: 0.4, valuation: 0.2, sentiment: 0.1 } }));
assert.ok(exp[0].reason && exp[0].reason.length > 0, '决策归因应生成说明');
assert.strictEqual(typeof llm.multiAgentDebate, 'function', 'llm.multiAgentDebate 应导出');
console.log('✅ P1(EWMA) / P2(新闻舆情·决策归因·多Agent) 模块校验通过');
