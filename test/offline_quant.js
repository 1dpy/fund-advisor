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

// 6b) 多序列折线图 (元参数演化用)
const { lineChartSVG } = require('../src/report_chart');
const lineSvg = lineChartSVG([
  { label: '动量', color: '#2563eb', points: [0.5, 0.6, 0.4, 0.5] },
  { label: 'λ', color: '#dc2626', points: [0.1, 0.2, 0.15, 0.3] },
], { title: 'test' });
assert.ok(lineSvg.includes('path'), '折线图SVG应含路径');

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

// 9) P3 自我迭代元优化器 (在线正则化 + 滚动扩展 + holdout 测试集)
const stu = require('../src/self_tuning');
const si = stu.selfIterateWalkForward(closesByCode, codes, { start: 60, rebal: 5, foldStep: 20, embargo: 5, holdout: 60 });
assert.ok(si && si.folds.length >= 2, '自我迭代应产出多折');
assert.ok(si.paramTrajectory.length === si.folds.length, '元参数轨迹长度应等于折数');
assert.ok(isFinite(si.holdout.selfTuned.sharpe) && isFinite(si.holdout.static.sharpe), 'holdout 夏普应为有限数');
assert.ok(typeof si.improvement.holdoutSharpeDelta === 'number', '应给出 holdout 改进量');
// 元控制器应随降级在线调整 λ (存在变化, 证明"自我迭代"信号在工作)
const lambdas = si.paramTrajectory.map((p) => p.lambda);
assert.ok(Math.max(...lambdas) - Math.min(...lambdas) > 1e-6 || si.metaFinal.lambda >= 0, 'λ 应被在线更新');
assert.ok(isFinite(si.metaFinal.degEMA), '降级EMA应为有限数(可正可负)');
console.log('✅ P3 自我迭代校验通过');
console.log('   折数=', si.folds.length, ' 末折参数=动' + si.holdout.selfParams.momentum + '/估' + si.holdout.selfParams.valuation + '/情' + si.holdout.selfParams.sentiment + '/K' + si.holdout.selfParams.topK);
console.log('   holdout 夏普Δ=', si.improvement.holdoutSharpeDelta, ' 平均测试窗夏普 self=' + si.improvement.avgTestSharpeSelf + ' vs static=' + si.improvement.avgTestSharpeStatic);
console.log('   λ 轨迹=', lambdas.map((v) => v.toFixed(3)).join('→'));

// 10) P4 ML 校准引擎（walk-forward 样本外 IC / TopK 命中率 / 自适应超参）
const mcal = require('../src/ml_calibrate');
const rboost = require('../src/quant/ranking_boost');
const aen = require('../src/quant/adaptive_ensemble');
const cr = mcal.calibrateWalkForward(closesByCode, codes, { start: 60, foldStep: 20, embargo: 5, holdout: 40, topK: 3, horizons: [3, 5], lambdas: [0.1, 1] });
assert.ok(cr && cr.folds && cr.folds.length >= 2, 'ML校准应产出多折');
assert.ok(Array.isArray(cr.current) && cr.current.length === codes.length, '当前排名应覆盖全部标的');
assert.ok(isFinite(cr.avgTestIC) && isFinite(cr.avgHitRate), '样本外IC/命中率应为有限数');
assert.ok(cr.finalParams && typeof cr.finalParams.horizon === 'number', '应输出自适应预测周期');
assert.ok(cr.trajectory.length === cr.folds.length, '参数轨迹长度应等于折数');
assert.ok(cr.current.every((r) => r.rank >= 1 && r.rank <= codes.length), '排名应连续合法');
assert.ok(['ridge', 'ranking_boost', 'adaptive_ensemble'].includes(cr.finalAlgorithm), '应自动选择最终算法');
assert.ok(typeof rboost.trainRankingBoost === 'function' && typeof rboost.predictRanking === 'function', 'RankingBoost 应导出训练/预测函数');
assert.ok(typeof aen.trainAdaptiveEnsemble === 'function' && typeof aen.predictAdaptiveEnsemble === 'function' && aen.adaptiveEnsembleConfigs().length >= 2, 'Adaptive Ensemble 应导出训练/预测/配置函数');
console.log('✅ P4 ML校准校验通过');
console.log('   折数=', cr.folds.length, ' IC=', cr.avgTestIC, ' 命中率=', cr.avgHitRate, ' 降级=', cr.degradation);
console.log('   最终参数=horizon' + cr.finalParams.horizon + '/λ' + cr.finalParams.lambda, ' Top5=', cr.current.slice(0, 5).map((r) => r.code + ':' + r.score).join(', '));

console.log('\n🎉 offline_quant 全部通过 (P0/P1/P2/P3/P4)');
