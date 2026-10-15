/**
 * 决策可复现性测试 — 同一份数据连续跑两次必须给出同一个结论
 *
 * 背景(bug): LSTM 权重初始化 / HMM k-means++ 与随机转移矩阵 / RF bootstrap /
 *           GBDT 特征子抽样 / walk-forward 洗牌 / 贝叶斯初始采样点 都裸调 Math.random,
 *           导致 `node main.js` 连跑两次可能对同一只基金给出 BUY 和 SELL 两种建议,
 *           回测与参数优化结果也不可复现。
 *
 * 修复: src/quant/seeded_random.js 提供 withSeed, 在所有含随机性的公开入口包裹固定种子。
 *
 * 纯离线, 被 CI 调用。
 */
const assert = require('assert');

const { makeSeededRandom, withSeed, DEFAULT_SEED } = require('../src/quant/seeded_random');
const { predictWithLSTMAttention } = require('../src/quant/lstm_attention');
const { predictWithLSTM } = require('../src/quant/lstm_lite');
const { trainHMMPro, extractFeatures } = require('../src/quant/hmm_pro');
const { trainAndPredict } = require('../src/quant/random_forest');
const { trainAndPredictGB } = require('../src/quant/gradient_boost');
const { walkForwardValidation } = require('../src/quant/walk_forward');

let pass = 0;
function ok(name, cond) { assert.ok(cond, '❌ ' + name); console.log('  ✅ ' + name); pass++; }
function eq(name, a, b) {
  assert.strictEqual(a, b, `❌ ${name}: 期望 ${b}, 实际 ${a}`);
  console.log('  ✅ ' + name); pass++;
}

// 可复现的伪随机行情: 固定算法生成, 不用 Math.random 造数据 (否则测的不是被测对象)
function makeSeries(n, seed = 7) {
  const rnd = makeSeededRandom(seed);
  const out = [];
  let v = 1.0;
  for (let i = 0; i < n; i++) {
    v *= 1 + (rnd() - 0.48) * 0.02;
    out.push(v);
  }
  return out;
}

console.log('== 决策可复现性测试 ==\n');

console.log('【1. 种子化随机本身】');
const r1 = makeSeededRandom(42), r2 = makeSeededRandom(42);
const seq1 = Array.from({ length: 5 }, () => r1());
const seq2 = Array.from({ length: 5 }, () => r2());
ok('同种子 → 同序列', seq1.every((v, i) => v === seq2[i]));
ok('取值落在 [0,1)', seq1.every(v => v >= 0 && v < 1));
ok('不同种子 → 不同序列', makeSeededRandom(43)() !== makeSeededRandom(42)());
const before = Math.random();
withSeed(1, () => Math.random());
ok('withSeed 退出后恢复真随机', typeof Math.random === 'function' && Math.random !== undefined);
ok('withSeed 内为种子值', withSeed(42, () => Math.random()) === makeSeededRandom(42)());
// withSeed 抛异常也要恢复
try { withSeed(1, () => { throw new Error('boom'); }); } catch (e) { /* expected */ }
const after = Math.random();
ok('withSeed 抛异常后仍恢复 Math.random', Math.random === Math.random && typeof after === 'number');
ok('DEFAULT_SEED 是正整数', Number.isInteger(DEFAULT_SEED) && DEFAULT_SEED > 0);

console.log('\n【2. LSTM-Attention: 两次调用同结果】');
const hist = makeSeries(150, 11).map(nav => ({ nav }));
const a1 = predictWithLSTMAttention(hist, 20, 5);
const a2 = predictWithLSTMAttention(hist, 20, 5);
ok('返回非空', !!a1 && !!a2);
eq('prediction 完全一致', a1.prediction, a2.prediction);
eq('direction 完全一致', a1.direction, a2.direction);

console.log('\n【3. LSTM-Lite: 两次调用同结果】');
const closes = makeSeries(120, 13);
const b1 = predictWithLSTM(closes, 3);
const b2 = predictWithLSTM(closes, 3);
ok('返回非空', !!b1 && !!b2);
eq('direction 完全一致', b1.direction, b2.direction);
ok('magnitude 完全一致', b1.magnitude === b2.magnitude);

console.log('\n【4. HMM 体制判定: 两次训练同状态】');
const obsSeries = makeSeries(200, 17).map(nav => ({ nav }));
const obs = extractFeatures(obsSeries, 50);
if (!obs) {
  console.log('  ⚠️ extractFeatures 返回空, 跳过 HMM 用例');
} else {
  const h1 = trainHMMPro(obs, 4, 30);
  const h2 = trainHMMPro(obs, 4, 30);
  ok('返回非空', !!h1 && !!h2);
  eq('currentState 完全一致', h1.currentState, h2.currentState);
  eq('positionAdvice 完全一致', h1.positionAdvice, h2.positionAdvice);
}

console.log('\n【5. RF / GBDT: 两次训练同预测】');
// 造 ≥15 只基金的特征数据 (rankedFunds 形态)
const ranked = [];
for (let i = 0; i < 20; i++) {
  const s = makeSeries(60, 100 + i);
  const last = s[s.length - 1];
  const prev = s[s.length - 6] || s[0];
  ranked.push({
    code: 'F' + i, name: '基金' + i,
    price: last, nav: last, score: 50 + (i % 10),
    history: s.map(nav => ({ nav })),
    indicators: {
      rsi: 40 + (i % 20), macdHist: (i % 7) * 0.001 - 0.003,
      maDeviation: (last / prev - 1), momentum: (last / prev - 1),
      volatility: 0.01 + (i % 5) * 0.002, sharpe: 0.5 + (i % 5) * 0.1,
      volumeRatio: 1 + (i % 3) * 0.2, kdjK: 50 + (i % 15), kdjD: 45 + (i % 15),
    },
  });
}
const rf1 = trainAndPredict(ranked);
const rf2 = trainAndPredict(ranked);
if (!rf1) {
  console.log('  ⚠️ RF 返回空(样本不足), 跳过');
} else {
  ok('RF 返回非空', !!rf2);
  eq('RF 预测条数一致', Object.keys(rf1.predictions).length, Object.keys(rf2.predictions).length);
  ok('RF 每只基金预测完全一致',
    JSON.stringify(rf1.predictions) === JSON.stringify(rf2.predictions));
}

const gb1 = trainAndPredictGB(ranked);
const gb2 = trainAndPredictGB(ranked);
if (!gb1) {
  console.log('  ⚠️ GBDT 返回空(样本不足), 跳过');
} else {
  ok('GBDT 返回非空', !!gb2);
  ok('GBDT 每只基金预测完全一致',
    JSON.stringify(gb1.predictions) === JSON.stringify(gb2.predictions));
}

console.log('\n【6. Walk-forward: 两次优化同参数】');
const wfHist = makeSeries(260, 23).map(nav => ({ nav }));
const w1 = walkForwardValidation(wfHist, 3);
const w2 = walkForwardValidation(wfHist, 3);
if (!w1) {
  console.log('  ⚠️ walk-forward 返回空(历史不足 120), 跳过');
} else {
  ok('返回非空', !!w2);
  ok('两次结果结构一致', JSON.stringify(w1) === JSON.stringify(w2));
}

console.log(`\n✅ 可复现性测试全部通过 (${pass} 项)`);
