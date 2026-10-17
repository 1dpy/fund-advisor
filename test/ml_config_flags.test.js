/**
 * ML_CONFIG 的 enable* 开关此前定义了却从未被任何代码读取 —— 改配置完全无效。
 * 本测试锁住两件事:
 *   1. 开关真的能关掉对应模型
 *   2. 关掉模型后综合分**重新归一化权重**, 不被系统性压低
 *
 * 第 2 点最关键: 若只是让被关模型贡献 0 而权重留在分母外, 关掉一个模型
 * 会让所有基金的 mlScore 等比缩小 → 信号莫名从 BUY 掉到 HOLD。
 * 那等于"开关改变了策略语义", 比开关无效更危险。
 */
const assert = require('assert');
const { scoreFund } = require('../src/ml_sector_selector');
const { ML_CONFIG } = require('../src/config');
const { ensembleVote } = require('../src/quant/ensemble');

let pass = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { console.log(`  ❌ ${name}`); throw new Error(name); }
}
function near(name, actual, expected, eps = 1e-9) {
  ok(`${name} (实际 ${actual}, 期望 ≈${expected})`, Math.abs(actual - expected) <= eps);
}

// 配置是模块级共享对象, 改完必须还原, 否则污染后续测试
const BACKUP = { ...ML_CONFIG };
function setFlags(overrides) {
  for (const k of Object.keys(ML_CONFIG)) ML_CONFIG[k] = true;
  Object.assign(ML_CONFIG, overrides);
}
function restore() { Object.assign(ML_CONFIG, BACKUP); }

// 趋势明确 + 有波动, 让各模型都能跑出方向
const SEQ = Array.from({ length: 120 }, (_, i) => 1 + i * 0.003 + Math.sin(i / 6) * 0.01);

console.log('== ML_CONFIG 开关与权重归一化 ==\n');

console.log('【1. 默认全开: 三个模型都参与】');
{
  setFlags({});
  const r = scoreFund(SEQ, 'fused');
  ok('lstm 有输出', !!r.lstm);
  ok('attention 有输出', !!r.attention);
  ok('ensemble 有输出', !!r.ensemble);
  ok('综合分非 NaN', Number.isFinite(r.mlScore));
}

console.log('\n【2. 各开关能关掉对应模型】');
{
  setFlags({ enableLSTM: false });
  ok('关 enableLSTM → lstm 为 null', scoreFund(SEQ, 'fused').lstm === null);

  setFlags({ enableLSTMAttention: false });
  ok('关 enableLSTMAttention → attention 为 null', scoreFund(SEQ, 'fused').attention === null);

  setFlags({ enableEnsemble: false });
  ok('关 enableEnsemble → ensemble 为 null', scoreFund(SEQ, 'fused').ensemble === null);
}

console.log('\n【3. 权重归一化: 关模型不改变分数语义】');
{
  // 只留 ensemble → 综合分应精确等于 ensemble 的原始信号(权重 0.4 归一化为 1.0)
  //   未归一化时会变成 0.4×ensScore, 看多的序列可能被压到 HOLD 区间
  const ensRaw = ensembleVote(SEQ).signal;
  setFlags({ enableLSTM: false, enableLSTMAttention: false });
  const onlyEns = scoreFund(SEQ, 'fused');
  near('只留 ensemble → 分数 = ensemble 原始信号', onlyEns.mlScore, ensRaw, 1e-9);

  // 只留 lstm 时同样不该被 0.2 的权重压垮
  setFlags({ enableLSTMAttention: false, enableEnsemble: false });
  const onlyLstm = scoreFund(SEQ, 'fused');
  ok('只留 lstm → 分数仍在同一量级(|score| ≤ 1)',
    Math.abs(onlyLstm.mlScore) <= 1 + 1e-9);
  ok('只留 lstm → 分数未被压成接近 0', Math.abs(onlyLstm.mlScore) > 0.05);

  // 全关 → 0 且不崩, 不能因为没模型就抛异常或返回 NaN
  setFlags({ enableLSTM: false, enableLSTMAttention: false, enableEnsemble: false });
  const none = scoreFund(SEQ, 'fused');
  near('全关 → 分数 0', none.mlScore, 0, 1e-9);
  ok('全关 → 信号为 HOLD', none.mlSignal === 'HOLD');
  ok('全关 → 不返回 NaN', Number.isFinite(none.mlScore));
}

console.log('\n【4. 开关默认是开启的 (向后兼容)】');
{
  restore();
  ok('ML_CONFIG.enableLSTM 默认 true', ML_CONFIG.enableLSTM === true);
  ok('ML_CONFIG.enableLSTMAttention 默认 true', ML_CONFIG.enableLSTMAttention === true);
  ok('ML_CONFIG.enableEnsemble 默认 true', ML_CONFIG.enableEnsemble === true);
  ok('ML_CONFIG.enableHMM 默认 true', ML_CONFIG.enableHMM === true);
  // 缺失/非 false 都视为开启, 避免旧配置(没有这些键)把模型全关掉
  setFlags({ enableLSTM: undefined });
  ok('开关缺失时视为开启', !!scoreFund(SEQ, 'fused').lstm);
  restore();
}

console.log(`\n✅ ML 开关单测全部通过 (${pass} 项)`);
