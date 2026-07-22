/**
 * 新闻舆情因子 (News Sentiment Factor)
 * ---------------------------------------------------------------
 * 把"财经新闻舆情"转成一个可进入多因子模型的数值因子 (newsScore ∈ [-1, 1]),
 * 供 factor_library 的情绪类因子使用 (P2 可解释性 + 情绪因子增强)。
 *
 * 复用现有 src/news.js 的词典型舆情打分 (新浪滚动新闻, 已含政策/行业检测),
 * 本模块只做"适配 + 数值化 + 离线兜底":
 *   - getNewsSentimentFactor(): 调 news.analyzeNewsSentiment(), 把 0-100 情绪分
 *     映射为 (score-50)/50 ∈ [-1,1]; 网络失败返回 available:false, 调用方安全降级。
 *   - scoreTextSentiment(text): 独立词典型打分 (不依赖网络/axios), 供单测与
 *     本地文本快速评估。
 *
 * 设计原则与项目一致: 网络/第三方失败绝不崩溃, 因子缺失时因子库自动降级
 * 为仅用动量+估值。
 */

let _cached = null;
let _cacheTime = 0;
const TTL = 30 * 60 * 1000;

// 轻量词典 (与 news.js 互补, 独立可用)
const POS = ['利好', '大涨', '暴涨', '飙升', '突破', '新高', '反弹', '回暖', '复苏', '超预期', '净流入', '增持', '回购', '企稳', '反转', '宽松', '支持', '促进'];
const NEG = ['利空', '大跌', '暴跌', '重挫', '破位', '新低', '下探', '衰退', '危机', '风险', '处罚', '调查', '爆雷', '违约', '亏损', '下滑', '制裁', '关税', '摩擦', '冲突'];

function scoreTextSentiment(text = '') {
  const t = String(text).toLowerCase();
  let s = 0;
  for (const w of POS) if (t.includes(w)) s += 1;
  for (const w of NEG) if (t.includes(w)) s -= 1;
  return Math.max(-3, Math.min(3, s)) / 3; // 归一化到 [-1,1]
}

async function getNewsSentimentFactor(force = false) {
  const now = Date.now();
  if (!force && _cached && now - _cacheTime < TTL) return _cached;
  try {
    const { analyzeNewsSentiment } = require('./news');
    const r = await analyzeNewsSentiment();
    if (!r || !r.available) {
      const fallback = { available: false, score: 0, sentimentScore: 50, headlines: [], reason: 'news source unavailable' };
      _cached = fallback; _cacheTime = now;
      return fallback;
    }
    const score = Math.max(-1, Math.min(1, (r.sentimentScore - 50) / 50));
    const out = {
      available: true,
      score: +score.toFixed(3),
      sentimentScore: r.sentimentScore,
      positiveCount: r.positiveCount,
      negativeCount: r.negativeCount,
      topSectors: r.topSectors || [],
      headlines: (r.highlights || []).slice(0, 5),
    };
    _cached = out; _cacheTime = now;
    return out;
  } catch (e) {
    const fallback = { available: false, score: 0, sentimentScore: 50, headlines: [], reason: String(e.message || e) };
    _cached = fallback; _cacheTime = now;
    return fallback;
  }
}

module.exports = { getNewsSentimentFactor, scoreTextSentiment };
