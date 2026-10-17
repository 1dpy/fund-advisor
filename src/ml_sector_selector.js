/**
 * 赛道 ML 选基模块 — 给用户偏好的高弹性赛道基金打分排名
 *
 * 思路 (用户 2026-07-21 需求: 各种高弹性行业/主题赛道 + ML + 回测迭代):
 *   1. 抓 PREFERRED_SECTORS 各赛道基金的真实历史净值 (eastmoney, 带本地缓存)
 *   2. 复用现有 quant 引擎: LSTM-Lite(时序预测) + ensemble(趋势/均值回复/动量投票)
 *   3. 融合成 mlScore 排名 -> 选出"当下最强"的赛道基金
 *   4. 供 advisor 的 pickPreferredSector 动态调用(先回测验证优于静态再接入实盘)
 *
 * 输出: [{ code, name, sector, mlScore, mlSignal, confidence, predictedReturn5d, ... }] 按 mlScore 降序
 */

const fs = require('fs');
const path = require('path');
const { fetchFundHistory } = require('./fetcher');
const { PREFERRED_SECTORS, ML_CONFIG } = require('./config');
const { predictWithLSTM } = require('./quant/lstm_lite');
const { predictWithLSTMAttention } = require('./quant/lstm_attention'); // ProMax: 双层LSTM+多头注意力+dropout+L2
const { ensembleVote } = require('./quant/ensemble');
const { withSeed, makeSeededRandom } = require('./quant/seeded_random');
const mcal = require('./ml_calibrate');

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'bt_cache');

// ============================================================
// 抓真实净值 (eastmoney), 带本地缓存
// ============================================================

/**
 * 抓某基金历史净值 (升序 [{date, nav}])
 * @param {string} code
 * @param {number} days - 抓最近多少条
 * @param {boolean} useCache - 是否用本地缓存(回测迭代省时)
 */
async function fetchNavHistory(code, days = 120, useCache = true) {
  const cacheFile = path.join(CACHE_DIR, `${code}.json`);
  if (useCache && fs.existsSync(cacheFile)) {
    try {
      // 缓存仅当日有效: 每天第一次跑抓最新净值, 当天后续复用
      const isToday = new Date(fs.statSync(cacheFile).mtime).toDateString() === new Date().toDateString();
      if (isToday) {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cached && cached.length >= 30) return cached;
      }
    } catch (e) { /* 缓存损坏则重抓 */ }
  }
  // 抓数收敛到 fetcher.fetchFundHistory (同一东财 lsjz 接口, 返回已按日期升序且带重试)
  const navs = (await fetchFundHistory(code, days))
    .map((r) => ({ date: r.date, nav: r.nav }))
    .filter((x) => x.nav > 0);
  if (navs.length > 0) {
    try {
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(navs));
    } catch (e) { /* 缓存失败不影响主流程 */ }
  }
  return navs;
}

// ============================================================
// 种子化随机 — 复用 src/quant/seeded_random (此前这里是唯一一份实现,
//   其余模型直接裸调 Math.random, 导致跑两次 main.js 结论不同; 现已统一)
// ============================================================

// ============================================================
// 单只基金 ML 打分 (LSTM-Lite / LSTM-Attention ProMax / 融合 + ensemble)
//   modelType: 'lite' | 'attention' | 'fused'(默认, attention为主)
//   navs 可为数值数组(closes)或 [{nav}] 对象数组
// ============================================================
function scoreFund(navs, modelType = 'fused') {
  const closes = navs.map((n) => (typeof n === 'number' ? n : n.nav));
  const history = navs.map((n) => ({ nav: (typeof n === 'number' ? n : n.nav) }));

  let lite = null, attn = null, ens = null;
  // ML_CONFIG 此前定义了 12 个 enable* 开关却从没被接上 —— 改配置完全无效,
  //   想关掉某个慢模型/不信任的模型做不到。现在真正生效, 默认全 true 与旧行为一致。
  const ML = ML_CONFIG || {};
  const want = (flag) => flag !== false;   // 缺失/非 false 都视为开启, 向后兼容
  if (want(ML.enableLSTM) && (modelType === 'lite' || modelType === 'fused')) {
    try { lite = withSeed(42, () => predictWithLSTM(closes, 3)); } catch (e) { /* skip */ }
  }
  if (want(ML.enableLSTMAttention) && (modelType === 'attention' || modelType === 'fused')) {
    try { attn = withSeed(43, () => predictWithLSTMAttention(history, 20, 5)); } catch (e) { /* skip */ }
  }
  if (want(ML.enableEnsemble)) {
    try { ens = ensembleVote(closes); } catch (e) { /* skip */ }
  }

  const dirVal = (d) => (d === 'UP' ? 1 : d === 'DOWN' ? -1 : 0);
  const liteScore = lite ? dirVal(lite.direction) * (lite.confidence / 100) : 0;
  const attnScore = attn ? dirVal(attn.direction) * attn.confidence : 0; // attn.confidence 0~1
  const ensScore = ens ? ens.signal : 0; // -1 ~ 1

  // 综合分: fused 时 attention为主(promax), lite/ensemble辅助
  //   ★ 按**实际跑起来的模型**重新归一化权重。关掉一个模型若只是让它贡献 0
  //   而权重还留在分母外, 综合分会被系统性压低 —— 关掉 LSTM 会让所有基金
  //   的 mlScore 变小, 信号莫名从 BUY 掉到 HOLD, 等于开关改变了策略语义。
  //   归一化后分数仍是加权平均, 量纲不变, 关模型只影响"参考了哪些信息"。
  const W = modelType === 'lite' ? { lite: 0.6, ens: 0.4 }
    : modelType === 'attention' ? { attn: 0.6, ens: 0.4 }
      : { attn: 0.4, lite: 0.2, ens: 0.4 };
  const scores = { lite: lite ? liteScore : null, attn: attn ? attnScore : null, ens: ens ? ensScore : null };
  let wSum = 0; let sSum = 0;
  for (const k of Object.keys(W)) {
    if (scores[k] == null) continue;
    wSum += W[k];
    sSum += scores[k] * W[k];
  }
  let mlScore = wSum > 0 ? sSum / wSum : 0;

  // 预测收益微调(±0.3): 优先 attention(小数*100转%), 否则 lite(已是%)
  let predPct = null;
  if (attn && typeof attn.predictedReturn === 'number') predPct = attn.predictedReturn * 100;
  else if (lite && typeof lite.predictedReturn === 'number') predPct = lite.predictedReturn;
  if (predPct != null) mlScore += Math.max(-0.3, Math.min(0.3, predPct / 100));

  // 置信度: 各模型平均
  const confs = [];
  if (attn) confs.push(attn.confidence * 100);
  if (lite) confs.push(lite.confidence);
  if (ens) confs.push(ens.confidence * 100);
  const confidence = confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : 0;

  let mlSignal;
  if (mlScore > 0.3) mlSignal = 'STRONG_BUY';
  else if (mlScore > 0.1) mlSignal = 'BUY';
  else if (mlScore < -0.3) mlSignal = 'STRONG_SELL';
  else if (mlScore < -0.1) mlSignal = 'SELL';
  else mlSignal = 'HOLD';

  return {
    mlScore: Math.round(mlScore * 1000) / 1000,
    mlSignal,
    confidence,
    predictedReturn5d: predPct != null ? Math.round(predPct * 100) / 100 : null,
    model: modelType,
    lstm: lite ? { direction: lite.direction, confidence: lite.confidence } : null,
    attention: attn ? { direction: attn.direction, confidence: Math.round(attn.confidence * 100) } : null,
    ensemble: ens ? { signal: ens.signal, confidence: ens.confidence } : null,
  };
}

// ============================================================
// 赛道排名主函数
// ============================================================
/**
 * @param {Object} opts - { days, useCache, delayMs }
 * @returns {Array} 按 mlScore 降序的赛道基金列表
 */
async function getSectorMLRanking(opts = {}) {
  const { days = 120, useCache = true, delayMs = 300, modelType = 'fused', calibrate = true, calibrateForce = false } = opts;
  const results = [];
  const navsByCode = {};
  for (const s of PREFERRED_SECTORS) {
    const navs = await fetchNavHistory(s.code, days, useCache);
    navsByCode[s.code] = navs;
    const closes = navs.map((n) => n.nav);
    if (closes.length < 40) {
      results.push({ code: s.code, name: s.name, sector: s.sector, maxWeight: s.maxWeight, dataPoints: closes.length, mlScore: -999, mlSignal: 'NO_DATA', confidence: 0, predictedReturn5d: null });
    } else {
      const scored = scoreFund(navs, modelType);
      results.push({ code: s.code, name: s.name, sector: s.sector, maxWeight: s.maxWeight, dataPoints: closes.length, ...scored });
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  // ML 校准层：用 walk-forward 样本外 IC/命中率对 LSTM/Attention/Ensemble 融合分做
  // 二次加权，而不是永远用人工固定权重。校准结果会被持续自我迭代流程刷新。
  let calib = null;
  if (calibrate) {
    const codes = Object.keys(navsByCode).filter((c) => (navsByCode[c] || []).length >= 80);
    if (codes.length >= 3) {
      const closesByCode = {};
      for (const c of codes) closesByCode[c] = navsByCode[c].map((n) => n.nav);
      const minN = Math.min(...codes.map((c) => closesByCode[c].length));
      const ho = Math.max(20, Math.min(60, Math.floor(minN / 6)));
      calib = calibrateForce
        ? mcal.calibrateWalkForward(closesByCode, codes, { holdout: ho })
        : (mcal.loadCalibration() || mcal.calibrateWalkForward(closesByCode, codes, { holdout: ho }));
    }
  }
  const calByCode = {};
  if (calib && Array.isArray(calib.current)) {
    for (const r of calib.current) calByCode[r.code] = r;
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // 自适应融合权重：样本外 IC 越高，ML 模型权重越大；ML 跑不过动量基线时
  // 自动退回到“动量/原有信号”，避免“装了 ML 但反而拖累决策”。
  const ridgeIC = calib && calib.algorithms ? calib.algorithms.ridge.avgTestIC : (calib && typeof calib.avgTestIC === 'number' ? calib.avgTestIC : 0);
  const pltrIC = calib && calib.algorithms ? calib.algorithms.pltr.avgTestIC : (calib && calib.baseline ? (calib.baseline.pltr && calib.baseline.pltr.avgTestIC) || -1 : -1);
  const aseIC = calib && calib.algorithms ? (calib.algorithms.adaptive_ensemble && calib.algorithms.adaptive_ensemble.avgTestIC) || -1 : -1;
  const usePltr = pltrIC > ridgeIC;
  const useASE = aseIC > Math.max(ridgeIC, pltrIC);
  const mlVsMom = calib && calib.baseline
    ? (useASE ? (calib.baseline.aseVsMomentumIC || 0) : usePltr ? (calib.baseline.pltrVsMomentumIC || 0) : (calib.baseline.mlVsMomentumIC || 0))
    : 0;
  let calWeight = 0.62, momWeight = 0.15;
  if (calib && typeof calib.avgTestIC === 'number') {
    if (mlVsMom < 0) {
      calWeight = clamp(0.5 + mlVsMom * 4, 0, 0.5);
      momWeight = clamp(0.5 - mlVsMom * 4, 0, 0.9);
    } else {
      calWeight = clamp(0.5 + calib.avgTestIC * 4 + ((calib.avgHitRate || 0.5) - 0.5), 0.35, 0.75);
      momWeight = 1 - calWeight;
    }
  }
  const modelWeightSum = calWeight + momWeight;
  const normCalW = modelWeightSum ? calWeight / modelWeightSum : 0.5;
  const normMomW = modelWeightSum ? momWeight / modelWeightSum : 0.5;
  for (const r of results) {
    const cal = calByCode[r.code];
    if (cal && r.mlScore > -900) {
      const oldScore = r.mlScore;
      const calScore = useASE && cal.aseScore != null ? clamp(cal.aseScore, -3, 3)
        : usePltr && cal.pltrScore != null ? clamp(cal.pltrScore, -3, 3)
        : clamp(cal.score, -3, 3);
      const momScore = clamp(cal.momentumScore != null ? cal.momentumScore : 0, -3, 3);
      const modelScore = normCalW * calScore + normMomW * momScore;
      r.mlScore = +(0.65 * modelScore + 0.35 * oldScore).toFixed(3);
      r.mlSignal = r.mlScore > 0.3 ? 'STRONG_BUY' : r.mlScore > 0.1 ? 'BUY' : r.mlScore < -0.3 ? 'STRONG_SELL' : r.mlScore < -0.1 ? 'SELL' : 'HOLD';
      r.confidence = cal.confidence != null ? Math.round((cal.confidence + (r.confidence || 0)) / 2) : r.confidence;
      if (cal.predictedReturn5d != null) r.predictedReturn5d = cal.predictedReturn5d;
      r.calibration = {
        score: cal.score, prob: cal.prob, rank: cal.rank,
        direction: cal.direction, predictedReturn5d: cal.predictedReturn5d,
      };
    }
  }
  results.sort((a, b) => b.mlScore - a.mlScore);
  results.calibration = calib
    ? {
        avgTestIC: calib.avgTestIC,
        avgHitRate: calib.avgHitRate,
        degradation: calib.degradation,
        confidence: calib.confidence,
        finalParams: calib.finalParams,
        holdout: calib.holdout,
        baseline: calib.baseline,
        algorithm: useASE ? 'adaptive_ensemble' : usePltr ? 'ranking_boost' : 'ridge',
        blendWeight: { ml: +normCalW.toFixed(2), momentum: +normMomW.toFixed(2), existing: 0.35 },
      }
    : null;
  return results;
}

// ============================================================
// CLI: node src/ml_sector_selector.js [--fresh]
// ============================================================
if (require.main === module) {
  (async () => {
    const fresh = process.argv.includes('--fresh');
    console.log('=== 赛道 ML 选基排名 (PREFERRED_SECTORS) ===\n');
    const ranking = await getSectorMLRanking({ useCache: !fresh });
    if (ranking.calibration) {
      console.log(`\nML 校准: IC=${ranking.calibration.avgTestIC} 命中率=${ranking.calibration.avgHitRate} 置信度=${ranking.calibration.confidence}`);
    }
    for (const r of ranking) {
      const ret = r.predictedReturn5d != null ? ` pred5d=${r.predictedReturn5d}%` : '';
      console.log(`${r.mlScore >= 0 ? ' ' : ''}${String(r.mlScore).padStart(6)}  [${r.mlSignal.padEnd(10)}] ${r.name}(${r.code}) ${r.sector}  conf=${r.confidence}${ret}  data=${r.dataPoints}`);
    }
    const best = ranking[0];
    if (best && best.mlScore > -900) {
      console.log(`\n>>> 最强赛道: ${best.name}(${best.code}) ${best.sector}  mlScore=${best.mlScore}  [${best.mlSignal}]`);
    }
  })();
}

// 从 ML 排名取 Top-K 正分赛道基金 (空仓门: 全部 mlScore<=0 则返回空数组, 表示整体偏空不投)
function getMLPicks(mlRanking, topK = 2) {
  if (!Array.isArray(mlRanking)) return [];
  const pos = mlRanking.filter((r) => r.mlScore > 0 && r.mlSignal !== 'NO_DATA');
  return pos.slice(0, topK).map((r) => ({ code: r.code, name: r.name, sector: r.sector, maxWeight: r.maxWeight, mlScore: r.mlScore, weight: 1 }));
}

module.exports = { getSectorMLRanking, fetchNavHistory, scoreFund, getMLPicks };
