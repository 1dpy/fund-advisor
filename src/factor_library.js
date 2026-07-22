/**
 * 多因子库 (Multifactor Library) — 动量 / 估值 / 情绪
 * ---------------------------------------------------------------
 * 为基金组合提供可解释、可回测的多因子打分 (参考 Fama-French 多因子、
 * 量化选股中的 alpha 因子框架, 以及 AI4Finance 的可解释因子工程)。
 *
 * 三大类因子 (每类多子因子, 跨标的 z-score 标准化后加权合成):
 *
 *   A) 动量类 MOMENTUM
 *        - mom1m    : 近 21 交易日收益 (短期动量)
 *        - mom3m    : 近 63 交易日收益 (中期动量)
 *        - mom6m    : 近 126 交易日收益 (长期动量, 反转前哨)
 *        - maSlope  : MA5 相对 MA60 的斜率 (趋势强度)
 *        - stReversal: 近 5 日收益取负 (短期反转因子, 逆向)
 *
 *   B) 估值类 VALUATION (基金无 PE/PB, 用"净值历史分位"代理便宜度)
 *        - navPercentile : 当前净值在最近 win 日的分位 (低=相对便宜)
 *        - discountToMA  : 相对长期均线 MA60 的折价% (负=折价=便宜)
 *        - pullbackMA20  : 从 MA20 回撤% (越大=回调越深=越便宜)
 *
 *   C) 情绪类 SENTIMENT
 *        - marketFG   : 全市场恐慌贪婪指数 (0-100, 来自 sentiment_engine, 越高越乐观)
 *        - newsScore  : 新闻舆情因子 (-1~1, 来自 news_sentiment, 越高越正面)
 *        - volSpike   : 个股近期波动放大比 (近期实现波动/长期实现波动, 越高=情绪越极端)
 *
 * 设计要点:
 *   - 全部为纯函数, 不依赖网络, 可在 CI/离线单测中验证
 *   - z-score 跨标的(截面)标准化, 避免量纲差异; 缺失值安全处理
 *   - compositeScore 接受可调权重, 直接对接"参数敏感性热力图"
 *
 * 用法:
 *   const fl = require('./factor_library');
 *   const table = fl.computeAllFactors(codes, closesByCode, { sentiment: 62, news: 0.3 });
 *   const z = fl.zscoreUniverse(table);                  // 截面标准化
 *   const score = fl.compositeScore(z, { momentum:0.5, valuation:0.3, sentiment:0.2 });
 */

// ---------- 基础工具 ----------
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
function pctRank(value, arr) {
  if (!arr.length) return 0.5;
  const below = arr.filter((v) => v < value).length;
  const equal = arr.filter((v) => v === value).length;
  return (below + 0.5 * equal) / arr.length; // 0~1
}
function safeDiv(a, b) { return b === 0 ? 0 : a / b; }

// 日收益率
function dailyReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(closes[i] / closes[i - 1] - 1);
  return r;
}

// ---------- A) 动量因子 ----------
function factorMomentum(closes) {
  const n = closes.length;
  const mom = (win) => (n >= win + 1 ? closes[n - 1] / closes[n - 1 - win] - 1 : 0);
  // MA 斜率: (MA5 - MA60) / MA60, 需 >=60 点
  let maSlope = 0;
  if (n >= 60) {
    const ma5 = mean(closes.slice(-5));
    const ma60 = mean(closes.slice(-60));
    maSlope = safeDiv(ma5 - ma60, ma60);
  }
  const stRet5 = n >= 6 ? closes[n - 1] / closes[n - 6] - 1 : 0;
  return {
    mom1m: mom(21),
    mom3m: mom(63),
    mom6m: mom(126),
    maSlope,
    stReversal: -stRet5, // 短期反转: 近5日涨得多→因子分负
  };
}

// ---------- B) 估值因子 (净值历史分位代理) ----------
function factorValuation(closes, win = 126) {
  const n = closes.length;
  const cur = closes[n - 1];
  const lookback = closes.slice(Math.max(0, n - win));
  const navPercentile = pctRank(cur, lookback); // 0~1, 低=相对便宜
  const ma60 = n >= 60 ? mean(closes.slice(-60)) : cur;
  const discountToMA = safeDiv(cur - ma60, ma60); // 负=折价
  const ma20 = n >= 20 ? mean(closes.slice(-20)) : cur;
  const pullbackMA20 = safeDiv(cur - ma20, ma20); // 负=在MA20下方(回调)
  return { navPercentile, discountToMA, pullbackMA20 };
}

// ---------- C) 情绪因子 ----------
// marketFG: 0-100 恐慌贪婪; newsScore: -1~1; 两者为全市场共享因子
// volSpike: 个股近期波动放大 (截面内相对值更具区分度, 故此处先给原始比, z-score 时再用)
function factorSentiment(closes, marketFG, newsScore) {
  const ret = dailyReturns(closes);
  const recentVol = stdev(ret.slice(-10)) * Math.sqrt(252);
  const longVol = stdev(ret.slice(-60)) * Math.sqrt(252);
  const volSpike = safeDiv(recentVol, longVol); // >1 情绪升温/恐慌放大
  // 个股对"市场情绪"的暴露: 用近期收益方向承接乐观情绪
  const recentRet = ret.slice(-10).reduce((s, v) => s + v, 0);
  const sentimentCapture = (marketFG != null ? (marketFG - 50) / 50 : 0) * Math.sign(recentRet || 1)
    + (newsScore != null ? newsScore : 0);
  return { marketFG: marketFG != null ? marketFG : 50, newsScore: newsScore != null ? newsScore : 0, volSpike, sentimentCapture };
}

// ============================================================
// 汇总: 对全标的计算所有因子 (截面快照, 截至当日)
//   codes: string[]; closesByCode: { code: number[] }
//   opts: { sentiment: marketFG(0-100), news: newsScore(-1~1), valWin }
// 返回 { code: { momentum:{...}, valuation:{...}, sentiment:{...}, raw:{...} } }
// ============================================================
function computeAllFactors(codes, closesByCode, opts = {}) {
  const { sentiment = null, news = null, valWin = 126 } = opts;
  const table = {};
  for (const c of codes) {
    const closes = closesByCode[c] || [];
    if (closes.length < 21) { table[c] = null; continue; }
    const momentum = factorMomentum(closes);
    const valuation = factorValuation(closes, valWin);
    const sent = factorSentiment(closes, sentiment, news);
    table[c] = { momentum, valuation, sentiment: sent, raw: { ...momentum, ...valuation } };
  }
  return table;
}

// ============================================================
// 截面 z-score 标准化: 对每个子因子在 codes 间标准化 (均值0 方差1)
//   因子方向统一为"越大越好":
//     - stReversal 已取负; navPercentile/discountToMA/pullbackMA20/volSpike 在
//       compositeScore 中经 FACTOR_DIR 反向, 使"越便宜/波动不过热=分越高"
// ============================================================
const FACTOR_DIR = {
  mom1m: +1, mom3m: +1, mom6m: +1, maSlope: +1, stReversal: +1,
  navPercentile: -1, discountToMA: -1, pullbackMA20: -1,
  marketFG: +1, newsScore: +1, volSpike: -1, sentimentCapture: +1,
};

function zscoreUniverse(table) {
  const codes = Object.keys(table).filter((c) => table[c]);
  const groups = ['momentum', 'valuation', 'sentiment'];
  const z = {};
  codes.forEach((c) => (z[c] = { momentum: {}, valuation: {}, sentiment: {} }));
  for (const g of groups) {
    const keys = codes.length ? Object.keys(table[codes[0]][g]) : [];
    for (const k of keys) {
      const vals = codes.map((c) => table[c][g][k]);
      const m = mean(vals), s = stdev(vals) || 1e-9;
      for (const c of codes) {
        z[c][g][k] = (table[c][g][k] - m) / s; // 原始 z (方向在合成时处理)
      }
    }
  }
  return z;
}

// ============================================================
// 加权合成综合 alpha 分
//   z: zscoreUniverse 输出
//   weights: { momentum, valuation, sentiment } 三类权重(自动归一化)
//   类内子因子等权平均后再按类权重加权; 已含 FACTOR_DIR 方向
// 返回 [{code, score, contrib:{momentum,valuation,sentiment}}] 降序
// ============================================================
function compositeScore(z, weights = { momentum: 0.5, valuation: 0.3, sentiment: 0.2 }) {
  const codes = Object.keys(z);
  if (!codes.length) return [];
  const wsum = (weights.momentum || 0) + (weights.valuation || 0) + (weights.sentiment || 0) || 1;
  const wm = (weights.momentum || 0) / wsum;
  const wv = (weights.valuation || 0) / wsum;
  const ws = (weights.sentiment || 0) / wsum;

  const out = codes.map((c) => {
    const contrib = {};
    for (const g of ['momentum', 'valuation', 'sentiment']) {
      const keys = Object.keys(z[c][g]);
      let s = 0;
      for (const k of keys) s += (z[c][g][k] || 0) * (FACTOR_DIR[k] != null ? FACTOR_DIR[k] : 1);
      contrib[g] = keys.length ? s / keys.length : 0;
    }
    const score = contrib.momentum * wm + contrib.valuation * wv + contrib.sentiment * ws;
    return { code: c, score: +score.toFixed(4), contrib: { momentum: +contrib.momentum.toFixed(4), valuation: +contrib.valuation.toFixed(4), sentiment: +contrib.sentiment.toFixed(4) } };
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

// 取 Top-K 正分标的等权权重, 用于回测因子模型; 全负则空仓
function factorWeights(z, weights, topK) {
  const ranked = compositeScore(z, weights);
  const pos = ranked.filter((r) => r.score > 0).slice(0, topK);
  if (!pos.length) return 'CASH';
  const w = {};
  pos.forEach((r) => (w[r.code] = 1 / pos.length));
  return w;
}

module.exports = {
  mean, stdev, pctRank, dailyReturns,
  factorMomentum, factorValuation, factorSentiment,
  computeAllFactors, zscoreUniverse, compositeScore, factorWeights, FACTOR_DIR,
};
