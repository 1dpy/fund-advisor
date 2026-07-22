/**
 * 市场情绪引擎 — 多源恐慌贪婪指数 (Fear & Greed Index)
 *
 * 综合维度 (各 0-100, 越高越乐观/贪婪):
 *   1. 市场宽度 breadth   — 涨跌家数比 (已有 fetcher.computeMarketBreadth)
 *   2. 趋势 trend         — 上证 + 创业板涨跌幅 (创业板权重更高, 代表风险偏好)
 *   3. 北向资金 northFlow  — 沪深港通净流入 (正=乐观)
 *   4. 量能 volume        — 两市成交额相对水平 (暂以宽度近似, 可后续接入真实成交额)
 *
 * 输出:
 *   score        0-100 综合恐慌贪婪指数
 *   label/labelCN 英文/中文标签
 *   level        'fear' | 'neutral' | 'greed'
 *   tradingBias  'CONTRARIAN_BUY'(恐慌→逆向买入) | 'NEUTRAL' | 'TAKE_PROFIT'(贪婪→减仓)
 *   advice       交易含义文案
 *   subIndicators 各子指标明细
 *
 * 容错: 任一数据源失败, 用其余可用数据计算; 全失败返回中性 50, 绝不崩溃。
 *
 * 用法:
 *   const { analyzeMarketSentiment } = require('./sentiment_engine');
 *   const s = await analyzeMarketSentiment(allData);   // V4: 传入 allData 复用
 *   const s2 = await analyzeMarketSentiment();          // V5/V6: 无 allData 时独立抓取
 */

const axios = require('axios');
const { fetchMarketIndexes, computeMarketBreadth, fetchNorthFlow } = require('./fetcher');

const client = axios.create({
  timeout: 12000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://quote.eastmoney.com/',
  },
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 涨跌幅(%) → 0-100 子分 (scale: 每 1% 对应多少分)
function pctToScore(pct, scale) {
  return Math.max(0, Math.min(100, 50 + (pct || 0) * scale));
}

// ============================================================
// 独立抓取情绪原始数据 (V5/V6 快速通道无 allData 时使用)
// ============================================================
async function fetchSentimentRawData() {
  let indexes = [];
  let breadth = { upCount: 0, downCount: 0, ratio: 0.5 };
  let northFlow = null;

  try { indexes = await fetchMarketIndexes(); } catch (e) { /* ignore */ }
  try { breadth = computeMarketBreadth(indexes); } catch (e) { /* ignore */ }
  try { northFlow = await fetchNorthFlow(); } catch (e) { /* ignore */ }

  // 尝试抓全市场涨跌停家数 (东方财富 datacenter 接口)
  // 该接口不稳定, 失败则留 null, 由 computeSentiment 用指数涨跌幅推断极端度
  try {
    const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
      + '?reportName=RPT_DAILYBILLBOARD_SUMMARY'
      + '&columns=ALL'
      + '&filter=(MARKET%20in%20(%221%22,%222%22))';
    const resp = await client.get(url, { responseType: 'json' });
    const rows = resp.data && resp.data.result && resp.data.result.data;
    if (Array.isArray(rows) && rows.length > 0) {
      const row = rows[0];
      // 字段可能随接口变化, 容错读取
      if (row.LIMIT_UP_COUNT != null || row.ZT != null) {
        indexes.__limitUp = row.LIMIT_UP_COUNT != null ? row.LIMIT_UP_COUNT : row.ZT;
        indexes.__limitDown = row.LIMIT_DOWN_COUNT != null ? row.LIMIT_DOWN_COUNT : row.DT;
      }
    }
  } catch (e) { /* 涨跌停接口不可用, 忽略 */ }

  return { indexes, breadth, northFlow };
}

// ============================================================
// 纯函数: 从原始数据计算综合情绪
// ============================================================
function computeSentiment(raw) {
  const indexes = (raw && raw.indexes) || [];
  const breadth = raw && raw.breadth;
  const northFlow = raw && raw.northFlow;
  const sub = {};

  // 1. 市场宽度 (涨跌家数)
  if (breadth && (breadth.upCount + breadth.downCount) > 0) {
    const r = breadth.upCount / (breadth.upCount + breadth.downCount);
    sub.breadth = Math.round(r * 100);
  } else {
    const up = indexes.filter(i => i.changePct > 0).length;
    const down = indexes.filter(i => i.changePct < 0).length;
    sub.breadth = (up + down) > 0 ? Math.round((up / (up + down)) * 100) : 50;
  }

  // 2. 趋势 (上证 + 创业板; 创业板权重 1.2 代表风险偏好)
  const sh = indexes.find(i => /上证/.test(i.name || ''));
  const cyb = indexes.find(i => /创业板/.test(i.name || ''));
  let trendPct = 0, n = 0;
  if (sh) { trendPct += sh.changePct || 0; n++; }
  if (cyb) { trendPct += (cyb.changePct || 0) * 1.2; n++; }
  trendPct = n > 0 ? trendPct / n : 0;
  sub.trend = Math.round(pctToScore(trendPct, 6)); // 上证1% ≈ 6分

  // 3. 北向资金 (净流入, 假设 ±100亿为满量程)
  if (northFlow && typeof northFlow.netFlow === 'number' && !isNaN(northFlow.netFlow)) {
    sub.northFlow = Math.round(Math.max(0, Math.min(100, 50 + northFlow.netFlow / 2)));
  } else {
    sub.northFlow = 50; // 未知→中性
  }

  // 4. 量能 (暂以宽度近似, 可后续接入真实两市成交额)
  sub.volume = sub.breadth;

  // 5. 涨跌停极端度 (若有数据则微调宽度权重)
  const lu = indexes.__limitUp, ld = indexes.__limitDown;
  if (typeof lu === 'number' && typeof ld === 'number' && (lu + ld) > 0) {
    const limitRatio = lu / (lu + ld); // >0.5 偏乐观
    sub.limitUpDown = Math.round(limitRatio * 100);
    // 极端分化时, 用涨跌停比替代宽度参与综合 (更敏感)
    sub.breadth = Math.round(sub.breadth * 0.5 + sub.limitUpDown * 0.5);
  }

  // 加权综合 (宽度30% 趋势40% 北向20% 量能10%)
  const weights = { breadth: 0.30, trend: 0.40, northFlow: 0.20, volume: 0.10 };
  let score = 0, wsum = 0;
  for (const k of Object.keys(weights)) {
    if (sub[k] != null && !isNaN(sub[k])) { score += sub[k] * weights[k]; wsum += weights[k]; }
  }
  score = wsum > 0 ? Math.round(score / wsum) : 50;

  // 标签
  let label, labelCN, level;
  if (score >= 80) { label = 'EXTREME_GREED'; labelCN = '极度贪婪'; level = 'greed'; }
  else if (score >= 65) { label = 'GREED'; labelCN = '贪婪'; level = 'greed'; }
  else if (score >= 55) { label = 'OPTIMISTIC'; labelCN = '乐观'; level = 'neutral'; }
  else if (score >= 45) { label = 'NEUTRAL'; labelCN = '中性'; level = 'neutral'; }
  else if (score >= 35) { label = 'CAUTIOUS'; labelCN = '谨慎'; level = 'fear'; }
  else if (score >= 20) { label = 'FEAR'; labelCN = '恐慌'; level = 'fear'; }
  else { label = 'EXTREME_FEAR'; labelCN = '极度恐慌'; level = 'fear'; }

  // 交易倾向
  let tradingBias, advice;
  if (level === 'fear') {
    tradingBias = 'CONTRARIAN_BUY';
    advice = '市场恐慌: 别人恐惧我贪婪 — 抑制恐慌性卖出, 倾向分批逆向买入/定投宽基';
  } else if (level === 'greed') {
    tradingBias = 'TAKE_PROFIT';
    advice = '市场过热: 逢高减仓/止盈, 抑制追高买入';
  } else {
    tradingBias = 'NEUTRAL';
    advice = '市场情绪中性: 按计划执行, 不追涨不杀跌';
  }

  return {
    score,
    label,
    labelCN,
    level,
    tradingBias,
    advice,
    subIndicators: sub,
    dataSource: (indexes.length > 0 || northFlow) ? 'live' : 'default',
    fetchTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
  };
}

// ============================================================
// 主入口
// ============================================================
async function analyzeMarketSentiment(allData) {
  let raw;
  if (allData && (allData.indexes || allData.breadth)) {
    raw = {
      indexes: allData.indexes || [],
      breadth: allData.breadth || computeMarketBreadth(allData.indexes || []),
      northFlow: allData.northFlow || null,
    };
  } else {
    raw = await fetchSentimentRawData();
  }
  return computeSentiment(raw);
}

module.exports = { analyzeMarketSentiment, computeSentiment, fetchSentimentRawData };
