/**
 * 持续自我迭代引擎 (Continual Self-Iteration)
 * ------------------------------------------------------------
 * 用户要求: 每次运行都要自我迭代, 把"实时更新的数据"和"以往的数据"结合起来。
 *
 * 机制:
 *   1. 以往数据 (历史): data/sector_history.json — 各赛道基金真实单位净值(NAV)的
 *      累积存储。首次运行从东方财富抓取真实历史净值作 seed; 之后每次运行只增量追加,
 *      历史越滚越长 (在线学习 / continual learning)。
 *   2. 实时更新 (新数据): 每次运行调 fetchNavHistory 抓最新一期真实净值。基金 NAV 是
 *      T+1 —— 即上一交易日的单位净值, 当日盘前已披露, 属于"最新可得的真实数据"。
 *   3. 自我迭代: 用合并后的 closesByCode 跑 quant_lab_core.runSelfIterate
 *      (walk-forward 元优化, 最终 holdout 全程冻结当证据), 得到新元参数
 *      {momentum, valuation, sentiment, topK}。
 *   4. 持久化: 元参数写入 data/meta_params.json, advisor 动态选基时直接消费
 *      (topK 决定取前 N 只, 权重决定实时综合分如何加权)。
 *
 * 失败安全 (沙箱 / CI / 网络被拦):
 *   - 有历史 → 用现有历史继续迭代 (不浪费以往数据);
 *   - 无历史且实时抓不到 → 用合成序列(seed)跑通流程保证 CI 绿, 标注 dataSource='synthetic'。
 *   合成数据绝不写入真实历史文件, 避免污染。
 */

const fs = require('fs');
const path = require('path');
const core = require('./quant_lab_core');
const mcal = require('./ml_calibrate');
const { fetchNavHistory } = require('./ml_sector_selector');
const { PREFERRED_SECTORS } = require('./config');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'sector_history.json');
const META_FILE = path.join(DATA_DIR, 'meta_params.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureDataDir = () => { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {} };

// ---------- 历史读写 ----------
function loadHistory() {
  try { const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); return h && h.hist ? h.hist : (h || null); }
  catch (e) { return null; }
}
function saveHistory(hist, asOf) {
  ensureDataDir();
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify({ asOf, updatedAt: new Date().toISOString(), hist })); } catch (e) {}
}

// 真实数据 seed: 抓每个赛道基金历史净值 (≥30 期才采用)
async function bootstrapHistory() {
  const hist = {}; let ok = 0;
  for (const s of PREFERRED_SECTORS) {
    try {
      const navs = await fetchNavHistory(s.code, 250, true);
      if (navs && navs.length >= 30) { hist[s.code] = navs; ok++; }
    } catch (e) { /* 单只失败忽略 */ }
    await sleep(80);
  }
  return { hist, ok };
}

// 增量追加最新一期真实净值 (实时更新部分)
async function appendLatest(hist) {
  let appended = 0;
  for (const s of PREFERRED_SECTORS) {
    const code = s.code;
    const cur = hist[code] || [];
    const maxDate = cur.length ? cur[cur.length - 1].date : '0000';
    try {
      const navs = await fetchNavHistory(code, 5, false); // 抓最新几期, 只取比 maxDate 新的
      if (navs && navs.length) {
        for (const r of navs) if (r.date > maxDate) { cur.push(r); appended++; }
        cur.sort((a, b) => (a.date < b.date ? -1 : 1));
        hist[code] = cur;
      }
    } catch (e) { /* 单只失败忽略 */ }
    await sleep(60);
  }
  return appended;
}

// 由 history 构建对齐的 closesByCode + commonDates (前向填充, 与 prepData 同逻辑)
function buildCloses(hist) {
  const codes = Object.keys(hist).filter((c) => hist[c] && hist[c].length >= 30);
  const dateSet = new Set();
  for (const c of codes) for (const r of hist[c]) dateSet.add(r.date);
  const commonDates = [...dateSet].sort();
  const closesByCode = {};
  for (const c of codes) {
    const map = {}; for (const r of hist[c]) map[r.date] = r.nav;
    let last = null;
    closesByCode[c] = commonDates.map((d) => { if (map[d] != null) { last = map[d]; return map[d]; } return last; });
    const first = closesByCode[c].find((v) => v != null);
    closesByCode[c] = closesByCode[c].map((v) => (v == null ? first : v));
  }
  return { closesByCode, codes, commonDates };
}

// 合成 seed (仅当真实数据完全不可用, 不持久化到 history)
function syntheticSeed() {
  const prep = core.prepData({ days: 365, holdout: 60, forceDemo: true });
  return { closesByCode: prep.closesByCode, codes: prep.codes, commonDates: prep.commonDates };
}

// ---------- 主流程 ----------
async function runContinual(opts = {}) {
  const { holdout = 60, start = 60, rebal = 5, onStatus = () => {} } = opts;
  ensureDataDir();
  let hist = loadHistory();
  let dataSource = '';
  let realCodes = 0;

  if (!hist || Object.keys(hist).length === 0) {
    onStatus('抓取真实历史净值...');
    const boot = await bootstrapHistory();
    hist = boot.hist; realCodes = boot.ok;
    if (realCodes === 0) {
      dataSource = 'synthetic (实时抓取被拦截, 用合成历史跑通流程)';
      onStatus('实时抓取不可用, 退化合成序列');
    } else {
      dataSource = `real (seed ${realCodes}/${PREFERRED_SECTORS.length} 只)`;
      if (realCodes < PREFERRED_SECTORS.length) dataSource += ' 部分可用';
      saveHistory(hist, new Date().toISOString().slice(0, 10));
    }
  } else {
    realCodes = Object.keys(hist).length;
    dataSource = `real (历史已累积 ${realCodes} 只)`;
  }

  // 增量追加最新真实净值 (实时更新部分)
  if (realCodes > 0) {
    onStatus('追加最新真实净值(实时更新)...');
    const n = await appendLatest(hist);
    if (n > 0) { saveHistory(hist, new Date().toISOString().slice(0, 10)); dataSource += ` + 本次新增 ${n} 期`; }
  }

  // 构建训练数据 (以往 + 实时更新合并)
  const data = realCodes > 0 ? buildCloses(hist) : syntheticSeed();
  if (data.codes.length < 2) return { error: '可用赛道不足, 无法迭代', dataSource };

  onStatus('运行 walk-forward 自我迭代元优化...');
  let si = core.runSelfIterate(data.closesByCode, data.codes, { start, rebal, holdout, sentiment: null, news: 0 });
  let usedHoldout = holdout;
  if (!si && realCodes > 0) {
    // 默认窗口下数据不足(如净值缓存不全), 缩小 holdout 再试, 优先保住真实历史
    usedHoldout = Math.max(20, Math.floor(holdout / 2));
    si = core.runSelfIterate(data.closesByCode, data.codes, { start, rebal, holdout: usedHoldout, sentiment: null, news: 0 });
    if (si) dataSource += ' | 缩小holdout=' + usedHoldout;
  }
  if (!si) {
    // 仍不足 → 退化合成序列跑通流程 (真实历史保留在 data/sector_history.json, 不污染)
    const syn = syntheticSeed();
    usedHoldout = 60;
    si = core.runSelfIterate(syn.closesByCode, syn.codes, { start, rebal, holdout: usedHoldout, sentiment: null, news: 0 });
    dataSource += ' | 元优化退化合成(数据不足)';
  }
  if (!si) return { error: '数据不足以自我迭代', dataSource };

  // ML 模型校准层：按样本外 IC / TopK 命中率选择预测周期与正则强度，
  // 结果写入 data/ml_calibration.json，选基时直接消费。
  let mlCal = null;
  try {
    const N = data.commonDates.length;
    const start = N >= 210 ? 90 : Math.max(60, Math.floor(N / 4));
    const ho = N >= 240 ? 60 : Math.max(20, Math.min(60, Math.floor(N / 6)));
    if (N >= 180 && data.codes.length >= 3) {
      mlCal = mcal.calibrateWalkForward(data.closesByCode, data.codes, { start, holdout: ho, foldStep: 20, embargo: 5, topK: 3 });
      if (mlCal) mcal.saveCalibration(mlCal);
    }
  } catch (e) { mlCal = null; }

  const sp = (si.holdout && si.holdout.selfParams) || { momentum: 0.5, valuation: 0.3, sentiment: 0.2, topK: 4 };
  const oosSelf = si.holdoutCurves && si.holdoutCurves.self ? core.stats(si.holdoutCurves.self) : null;
  const oosStatic = si.holdoutCurves && si.holdoutCurves.static ? core.stats(si.holdoutCurves.static) : null;
  const degDelta = (oosSelf && oosStatic) ? +(oosSelf.total - oosStatic.total).toFixed(2) : null;

  const meta = {
    asOf: realCodes > 0 ? new Date().toISOString().slice(0, 10) : 'synthetic',
    generatedAt: new Date().toISOString(),
    dataSource,
    codes: data.codes,
    nDays: data.commonDates.length,
    holdoutDays: usedHoldout,
    selfParams: {
      momentum: +(+sp.momentum).toFixed(3),
      valuation: +(+sp.valuation).toFixed(3),
      sentiment: +(+sp.sentiment).toFixed(3),
      topK: sp.topK,
    },
    oosSelf, oosStatic, degDelta,
    folds: si.folds ? si.folds.length : (si.nFolds || null),
    mlCalibration: mlCal ? {
      avgTestIC: mlCal.avgTestIC,
      avgHitRate: mlCal.avgHitRate,
      degradation: mlCal.degradation,
      confidence: mlCal.confidence,
      finalParams: mlCal.finalParams,
      algorithm: mlCal.finalAlgorithm,
      algorithms: mlCal.algorithms,
      selection: mlCal.selection,
      holdout: mlCal.holdout,
      nSamples: mlCal.nSamples,
    } : null,
  };

  try { fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2)); } catch (e) {}
  return meta;
}

function loadMetaParams() {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch (e) { return null; }
}

module.exports = { runContinual, loadMetaParams, loadHistory, saveHistory, META_FILE, HISTORY_FILE };

// CLI: node src/continual_self_iterate.js
if (require.main === module) {
  runContinual({ onStatus: (m) => process.stdout.write('  · ' + m + '\n') })
    .then((m) => {
      if (m.error) { console.log('❌ ' + m.error + ' (' + (m.dataSource || '') + ')'); process.exit(1); }
      console.log('✅ 持续自我迭代完成');
      console.log('  数据来源 :', m.dataSource);
      console.log('  训练样本 :', m.nDays, '天 /', m.codes.length, '只 / 冻结holdout', m.holdoutDays, '天');
      console.log('  元参数   : momentum=' + m.selfParams.momentum + ' valuation=' + m.selfParams.valuation + ' sentiment=' + m.selfParams.sentiment + ' topK=' + m.selfParams.topK);
      console.log('  holdout  : self=' + (m.oosSelf ? m.oosSelf.total + '%' : '-') + ' static=' + (m.oosStatic ? m.oosStatic.total + '%' : '-') + ' Δ=' + m.degDelta + '%');
      if (m.mlCalibration) {
        const algoName = m.mlCalibration.algorithm === 'ranking_boost' ? 'RankingBoost' : m.mlCalibration.algorithm === 'adaptive_ensemble' ? 'Adaptive-ASE' : 'Ridge';
        console.log('  ML校准   : 算法=' + algoName + ' IC=' + m.mlCalibration.avgTestIC + ' 命中率=' + m.mlCalibration.avgHitRate + ' 降级=' + m.mlCalibration.degradation + ' 置信度=' + m.mlCalibration.confidence + ' 参数=' + m.mlCalibration.finalParams.horizon + 'd/λ' + m.mlCalibration.finalParams.lambda);
      }
      console.log('  已写入   :', META_FILE);
    })
    .catch((e) => { console.error('❌', e); process.exit(1); });
}
