/**
 * 深度历史数据采集与缓存引擎
 *
 * 功能:
 *   1. 采集基金1-3年历史净值数据 (用于ML训练)
 *   2. 本地文件缓存 (避免重复请求)
 *   3. 增量更新 (只拉最新数据)
 *   4. 多周期重采样 (日→周→月)
 *   5. 计算日收益率序列、对数收益率、滚动统计量
 *
 * 数据源: 东方财富基金历史净值API (每页20条, 可分页获取)
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_DIR = path.join(__dirname, '..', 'data_cache');
const HISTORY_DAYS = 500; // 约2年交易日

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const client = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://fund.eastmoney.com/',
  },
});

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 获取基金历史净值 (深度版, 支持长历史)
 * 东方财富API: 每页最多20条, 需要分页
 */
async function fetchDeepHistory(code, totalDays = HISTORY_DAYS) {
  const allRecords = [];
  const pages = Math.ceil(totalDays / 20);

  for (let page = 1; page <= pages; page++) {
    try {
      const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${page}&pageSize=20`;
      const resp = await client.get(url);
      const data = resp.data;

      if (data && data.Data && data.Data.LSJZList && data.Data.LSJZList.length > 0) {
        allRecords.push(...data.Data.LSJZList);
      } else {
        break;
      }
      if (page < pages) await sleep(200);
    } catch (e) {
      break;
    }
  }

  if (allRecords.length === 0) return [];

  // 转换并按日期升序排列
  return allRecords
    .map(item => ({
      date: item.FSRQ,
      nav: parseFloat(item.DWJZ),
      close: parseFloat(item.DWJZ),
      accNav: parseFloat(item.LJJZ),
      changePct: parseFloat(item.JZZZL || 0),
      volume: 0,
    }))
    .reverse()
    .slice(-totalDays);
}

/**
 * 获取缓存的基金历史数据 (带增量更新)
 */
async function getCachedHistory(code, forceUpdate = false) {
  const cacheFile = path.join(CACHE_DIR, `${code}.json`);

  // 检查缓存
  if (!forceUpdate && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 检查是否需要更新 (最后一条是否是今天或最近交易日)
      const lastDate = cached.history[cached.history.length - 1]?.date;
      const today = new Date().toISOString().slice(0, 10);
      if (lastDate && lastDate >= today) {
        return cached;
      }
      // 增量更新: 只拉最近的几页
      const newRecords = await fetchDeepHistory(code, 40);
      if (newRecords.length > 0) {
        const existingDates = new Set(cached.history.map(h => h.date));
        const fresh = newRecords.filter(r => !existingDates.has(r.date));
        if (fresh.length > 0) {
          cached.history = [...cached.history, ...fresh].slice(-HISTORY_DAYS);
          cached.lastUpdate = new Date().toISOString();
          fs.writeFileSync(cacheFile, JSON.stringify(cached));
        }
        return cached;
      }
      return cached;
    } catch (e) {
      // 缓存损坏, 重新获取
    }
  }

  // 全量获取
  const history = await fetchDeepHistory(code, HISTORY_DAYS);
  const data = {
    code,
    history,
    lastUpdate: new Date().toISOString(),
  };
  fs.writeFileSync(cacheFile, JSON.stringify(data));
  return data;
}

/**
 * 批量获取多只基金历史数据
 */
async function batchFetchHistory(codes, concurrency = 8) {
  const results = new Map();

  for (let i = 0; i < codes.length; i += concurrency) {
    const batch = codes.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (code) => {
        const data = await getCachedHistory(code);
        return [code, data];
      })
    );
    for (const [code, data] of batchResults) {
      results.set(code, data);
    }
    if (i + concurrency < codes.length) {
      await sleep(300);
    }
  }

  return results;
}

/**
 * 重采样: 日线 → 周线/月线
 */
function resample(history, period = 'week') {
  if (!history || history.length === 0) return [];

  const groups = new Map();

  for (const item of history) {
    const d = new Date(item.date);
    let key;

    if (period === 'week') {
      // ISO周: 年-周数
      const year = d.getFullYear();
      const week = getISOWeek(d);
      key = `${year}-W${week}`;
    } else if (period === 'month') {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    } else {
      key = item.date;
    }

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }

  // 每组取最后一条作为收盘
  const result = [];
  for (const [key, items] of groups) {
    const sorted = items.sort((a, b) => a.date.localeCompare(b.date));
    const last = sorted[sorted.length - 1];
    result.push({
      date: last.date,
      nav: last.nav,
      close: last.close,
      accNav: last.accNav,
      changePct: sorted.reduce((sum, x) => sum + x.changePct, 0),
      volume: 0,
    });
  }

  return result;
}

function getISOWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

/**
 * 计算日收益率序列
 */
function dailyReturns(history) {
  const returns = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].nav;
    const curr = history[i].nav;
    if (prev > 0 && curr > 0) {
      returns.push((curr - prev) / prev);
    }
  }
  return returns;
}

/**
 * 计算对数收益率
 */
function logReturns(history) {
  const returns = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].nav;
    const curr = history[i].nav;
    if (prev > 0 && curr > 0) {
      returns.push(Math.log(curr / prev));
    }
  }
  return returns;
}

/**
 * 滚动统计量
 */
function rollingStats(returns, window = 20) {
  const stats = [];
  for (let i = 0; i < returns.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = returns.slice(start, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
    const std = Math.sqrt(variance);
    const sharpe = std > 0 ? mean / std : 0;

    // 偏度
    const skew = std > 0
      ? slice.reduce((a, b) => a + ((b - mean) / std) ** 3, 0) / slice.length
      : 0;

    // 峰度
    const kurt = std > 0
      ? slice.reduce((a, b) => a + ((b - mean) / std) ** 4, 0) / slice.length - 3
      : 0;

    stats.push({ mean, std, sharpe, skew, kurt });
  }
  return stats;
}

/**
 * Hurst指数 (R/S分析) — 判断趋势持续性
 * H > 0.5: 趋势性 (持续)
 * H < 0.5: 均值回复
 * H ≈ 0.5: 随机游走
 */
function hurstExponent(history, maxLag = 50) {
  const returns = logReturns(history);
  if (returns.length < maxLag * 2) return 0.5;

  const rsValues = [];
  const lags = [];

  for (let lag = 10; lag <= Math.min(maxLag, Math.floor(returns.length / 2)); lag += 5) {
    const segments = Math.floor(returns.length / lag);
    let totalRS = 0;

    for (let s = 0; s < segments; s++) {
      const segment = returns.slice(s * lag, (s + 1) * lag);
      const mean = segment.reduce((a, b) => a + b, 0) / segment.length;
      const deviations = segment.map(r => r - mean);
      const cumDev = [0];
      for (let i = 0; i < deviations.length; i++) {
        cumDev.push(cumDev[i] + deviations[i]);
      }
      const R = Math.max(...cumDev) - Math.min(...cumDev);
      const S = Math.sqrt(deviations.reduce((a, b) => a + b * b, 0) / deviations.length);
      if (S > 0) totalRS += R / S;
    }

    rsValues.push(Math.log(totalRS / segments));
    lags.push(Math.log(lag));
  }

  // 线性回归求斜率 = Hurst指数
  if (rsValues.length < 3) return 0.5;
  const n = rsValues.length;
  const sumX = lags.reduce((a, b) => a + b, 0);
  const sumY = rsValues.reduce((a, b) => a + b, 0);
  const sumXY = lags.reduce((a, b, i) => a + b * rsValues[i], 0);
  const sumXX = lags.reduce((a, b) => a + b * b, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);

  return Math.max(0, Math.min(1, slope));
}

/**
 * 准备ML训练数据: 特征矩阵 + 标签
 */
function prepareTrainingData(history, lookback = 20, forecast = 5) {
  if (!history || history.length < lookback + forecast + 10) return null;

  const returns = dailyReturns(history);
  const logR = logReturns(history);
  const samples = [];

  for (let i = lookback; i < returns.length - forecast; i++) {
    // 特征: 过去lookback天的收益率 + 统计量
    const window = returns.slice(i - lookback, i);
    const logWindow = logR.slice(i - lookback, i);
    const navWindow = history.slice(i - lookback + 1, i + 1).map(h => h.nav);

    // 基础统计特征
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance);
    const sharpe = std > 0 ? mean / std * Math.sqrt(252) : 0;

    // 动量特征
    const mom5 = returns.slice(Math.max(0, i - 5), i).reduce((a, b) => a + b, 0);
    const mom10 = returns.slice(Math.max(0, i - 10), i).reduce((a, b) => a + b, 0);
    const mom20 = window.reduce((a, b) => a + b, 0);

    // 均线偏离
    const lastNav = navWindow[navWindow.length - 1];
    const ma5 = navWindow.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, navWindow.length);
    const ma10 = navWindow.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, navWindow.length);
    const ma20 = navWindow.reduce((a, b) => a + b, 0) / navWindow.length;
    const devMA5 = ma5 > 0 ? (lastNav - ma5) / ma5 : 0;
    const devMA10 = ma10 > 0 ? (lastNav - ma10) / ma10 : 0;
    const devMA20 = ma20 > 0 ? (lastNav - ma20) / ma20 : 0;

    // 波动率
    const vol5 = stdWindow(returns.slice(Math.max(0, i - 5), i));
    const vol10 = stdWindow(returns.slice(Math.max(0, i - 10), i));
    const vol20 = std;

    // RSI
    const rsi = calcRSI(navWindow, 14);

    // 偏度/峰度
    const skew = std > 0
      ? window.reduce((a, b) => a + ((b - mean) / std) ** 3, 0) / window.length
      : 0;
    const kurt = std > 0
      ? window.reduce((a, b) => a + ((b - mean) / std) ** 4, 0) / window.length - 3
      : 0;

    // 自相关 (lag 1, 5)
    const autocorr1 = autocorrelation(window, 1);
    const autocorr5 = autocorrelation(window, 5);

    // 标签: 未来forecast天的累计收益率
    const futureReturns = returns.slice(i, i + forecast);
    const futureCumReturn = futureReturns.reduce((a, b) => a + b, 0);

    // 分类标签
    let label;
    if (futureCumReturn > 0.03) label = 'STRONG_BUY';
    else if (futureCumReturn > 0.01) label = 'BUY';
    else if (futureCumReturn > -0.01) label = 'HOLD';
    else if (futureCumReturn > -0.03) label = 'WEAK';
    else label = 'SELL';

    samples.push({
      features: [
        mean, std, sharpe, skew, kurt,
        mom5, mom10, mom20,
        devMA5, devMA10, devMA20,
        vol5, vol10, vol20,
        rsi,
        autocorr1, autocorr5,
        ...window.slice(-10), // 最近10天收益率
      ],
      label,
      futureReturn: futureCumReturn,
      index: i,
    });
  }

  return samples;
}

function stdWindow(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function calcRSI(navArr, period = 14) {
  if (navArr.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = navArr.length - period; i < navArr.length; i++) {
    const change = navArr[i] - navArr[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function autocorrelation(arr, lag) {
  if (arr.length <= lag) return 0;
  const n = arr.length - lag;
  const mean1 = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const mean2 = arr.slice(lag).reduce((a, b) => a + b, 0) / n;
  let cov = 0, var1 = 0, var2 = 0;
  for (let i = 0; i < n; i++) {
    cov += (arr[i] - mean1) * (arr[i + lag] - mean2);
    var1 += (arr[i] - mean1) ** 2;
    var2 += (arr[i + lag] - mean2) ** 2;
  }
  if (var1 === 0 || var2 === 0) return 0;
  return cov / Math.sqrt(var1 * var2);
}

module.exports = {
  fetchDeepHistory,
  getCachedHistory,
  batchFetchHistory,
  resample,
  dailyReturns,
  logReturns,
  rollingStats,
  hurstExponent,
  prepareTrainingData,
  HISTORY_DAYS,
};
