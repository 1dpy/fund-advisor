/**
 * 财经新闻情绪分析模块
 * 数据源: 新浪财经滚动新闻
 * 分析: 关键词情绪打分 + 政策事件检测 + 行业提及统计
 */

const axios = require('axios');

// 情绪词典
const POSITIVE_WORDS = [
  '利好', '大涨', '暴涨', '飙升', '突破', '新高', '放量', '反弹',
  '降准', '降息', '宽松', '减税', '补贴', '支持', '鼓励', '促进',
  '回暖', '复苏', '景气', '超预期', '业绩增长', '净流入', '增持',
  '回购', '分红', '涨停', '创新高', '企稳', '见底', '反转',
];

const NEGATIVE_WORDS = [
  '利空', '大跌', '暴跌', '重挫', '破位', '新低', '缩量', '下探',
  '加息', '收紧', '通胀', '滞胀', '衰退', '危机', '风险',
  '监管', '处罚', '调查', '立案', '警示', '问询', '退市',
  '减持', '套现', '爆雷', '违约', '亏损', '下滑', '下降',
  '贸易战', '制裁', '关税', '摩擦', '冲突', '战争',
];

const POLICY_KEYWORDS = [
  '央行', '证监会', '国务院', '政治局', '发改委', '财政部',
  '银保监', '金融委', '国常会', '中央经济', '政府工作',
  '降准', '降息', 'LPR', 'MLF', '逆回购', '存款准备金',
  '印花税', '注册制', '退市制度', '减持新规',
];

const SECTOR_KEYWORDS = {
  '新能源': ['新能源', '光伏', '风电', '储能', '电池', '锂电', '宁德', '比亚迪'],
  '芯片半导体': ['芯片', '半导体', '集成电路', '光刻', '华为', '中芯'],
  '消费白酒': ['消费', '白酒', '茅台', '食品', '餐饮', '旅游'],
  '医药医疗': ['医药', '医疗', '创新药', '疫苗', '生物'],
  '地产基建': ['地产', '房地产', '基建', '水泥', '建材'],
  '金融证券': ['券商', '证券', '银行', '保险', '金融'],
  'AI科技': ['AI', '人工智能', '大模型', '算力', '机器人', '自动驾驶'],
  'QDII海外': ['美股', '港股', '美联储', '纳斯达克', '恒生', '全球'],
};

// 缓存避免频繁请求
let newsCache = null;
let cacheTime = 0;
const CACHE_TTL = 1800000; // 30分钟

async function fetchNewsHeadlines() {
  const now = Date.now();
  if (newsCache && (now - cacheTime) < CACHE_TTL) return newsCache;

  const allNews = [];

  // 新浪财经多个频道
  const channels = [
    { lid: 2509, name: '宏观' },
    { lid: 2510, name: 'A股' },
    { lid: 2512, name: '行业' },
  ];

  for (const ch of channels) {
    try {
      const r = await axios.get(
        `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=${ch.lid}&k=&num=20`,
        { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' } }
      );
      const items = (r.data?.result?.data || []).map(item => ({
        title: item.title || '',
        summary: item.summary || '',
        keywords: item.keywords || '',
        time: item.intime ? new Date(parseInt(item.intime) * 1000).toLocaleString('zh-CN') : '',
        channel: ch.name,
      }));
      allNews.push(...items);
    } catch (e) { /* skip failed channel */ }
  }

  if (allNews.length > 0) {
    newsCache = allNews;
    cacheTime = now;
  }

  return allNews;
}

/**
 * 对单条新闻打分 (-3 到 +3)
 */
function scoreSingleNews(news) {
  const text = (news.title + ' ' + news.summary + ' ' + news.keywords).toLowerCase();
  let score = 0;

  for (const word of POSITIVE_WORDS) {
    if (text.includes(word)) score += 1;
  }
  for (const word of NEGATIVE_WORDS) {
    if (text.includes(word)) score -= 1;
  }

  // 标题中的词权重更高
  const titleLow = news.title.toLowerCase();
  for (const word of POSITIVE_WORDS) {
    if (titleLow.includes(word)) score += 0.5;
  }
  for (const word of NEGATIVE_WORDS) {
    if (titleLow.includes(word)) score -= 0.5;
  }

  return Math.max(-3, Math.min(3, Math.round(score * 10) / 10));
}

/**
 * 检测是否有政策相关新闻
 */
function detectPolicyNews(news) {
  const text = (news.title + news.summary + news.keywords).toLowerCase();
  for (const kw of POLICY_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) return true;
  }
  return false;
}

/**
 * 检测新闻涉及的行业
 */
function detectSectors(news) {
  const text = (news.title + news.summary).toLowerCase();
  const sectors = [];
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) {
        sectors.push(sector);
        break;
      }
    }
  }
  return sectors;
}

/**
 * 综合分析: 返回新闻情绪摘要
 */
async function analyzeNewsSentiment() {
  const headlines = await fetchNewsHeadlines();

  if (headlines.length === 0) {
    return { available: false, message: '新闻源暂时不可用' };
  }

  // 逐条打分
  const scored = headlines.map(n => ({
    ...n,
    score: scoreSingleNews(n),
    isPolicy: detectPolicyNews(n),
    sectors: detectSectors(n),
  }));

  // 统计
  const positiveNews = scored.filter(n => n.score > 0);
  const negativeNews = scored.filter(n => n.score < 0);
  const policyNews = scored.filter(n => n.isPolicy);
  const totalScore = scored.reduce((s, n) => s + n.score, 0);

  // 情绪分映射到0-100
  const maxPossible = headlines.length * 3;
  const normalizedScore = maxPossible > 0
    ? Math.round(50 + (totalScore / maxPossible) * 50)
    : 50;

  // 行业提及统计
  const sectorMentions = {};
  for (const n of scored) {
    for (const s of n.sectors) {
      sectorMentions[s] = (sectorMentions[s] || 0) + 1;
    }
  }
  const topSectors = Object.entries(sectorMentions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // 情绪标签
  let sentiment;
  if (normalizedScore >= 65) sentiment = '积极乐观';
  else if (normalizedScore >= 55) sentiment = '偏积极';
  else if (normalizedScore >= 45) sentiment = '中性';
  else if (normalizedScore >= 35) sentiment = '偏谨慎';
  else sentiment = '悲观';

  // 取最重要的几条标题
  const topPositive = positiveNews.sort((a, b) => b.score - a.score).slice(0, 3);
  const topNegative = negativeNews.sort((a, b) => a.score - b.score).slice(0, 3);
  const topPolicy = policyNews.slice(0, 3);

  const highlights = [];
  for (const n of topPolicy) {
    highlights.push(`📋 ${n.title.substring(0, 50)}`);
  }
  for (const n of topPositive.slice(0, 2)) {
    if (!n.isPolicy) highlights.push(`🟢 ${n.title.substring(0, 50)}`);
  }
  for (const n of topNegative.slice(0, 2)) {
    highlights.push(`🔴 ${n.title.substring(0, 50)}`);
  }

  return {
    available: true,
    totalNews: headlines.length,
    positiveCount: positiveNews.length,
    negativeCount: negativeNews.length,
    policyCount: policyNews.length,
    sentiment,
    sentimentScore: normalizedScore,
    topSectors,
    highlights: highlights.slice(0, 8),
    // 情绪调整系数: 0.85-1.15, 用于调整市场温度
    adjustmentFactor: Math.round((normalizedScore / 50) * 100) / 100,
  };
}

module.exports = { analyzeNewsSentiment };
