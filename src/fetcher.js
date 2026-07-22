/**
 * 市场数据获取模块
 * 数据源: 新浪财经、腾讯财经、天天基金、东方财富基金
 *
 * 可用API:
 *   新浪 hq.sinajs.cn — ETF/股票实时行情 + 指数 (GBK编码)
 *   腾讯 web.ifzq.gtimg.cn — ETF历史K线
 *   天天基金 fundgz.1234567.com.cn — 基金实时估值
 *   东方财富 api.fund.eastmoney.com — 基金历史净值
 */

const axios = require('axios');
const iconv = require('iconv-lite');
const { TECH_CONFIG } = require('./config');

const client = axios.create({
  timeout: 15000,
  // 对新浪API使用 arraybuffer 以处理GBK编码
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
});

async function fetchWithRetry(url, opts = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await client.get(url, opts);
      return resp.data;
    } catch (err) {
      if (i === retries - 1) throw err;
      await sleep(1000 * (i + 1));
    }
  }
}

/**
 * 以GBK编码获取新浪数据, 自动转UTF-8
 */
async function fetchSina(url) {
  const resp = await client.get(url, {
    responseType: 'arraybuffer',
    headers: {
      'Referer': 'https://finance.sina.com.cn/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });
  // 新浪返回GBK编码, 需要转换
  const buf = Buffer.from(resp.data);
  return iconv.decode(buf, 'gbk');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
//  新浪行情解析
// ============================================================

/**
 * 解析新浪股票/ETF行情
 * 格式: var hq_str_sh510300="名称,今开,昨收,现价,最高,最低,..."
 */
function parseSinaStock(raw, expectCode) {
  const match = raw.match(/"([^"]*)"/);
  if (!match) return null;
  const fields = match[1].split(',');
  if (fields.length < 6) return null;

  const open = parseFloat(fields[1]);
  const prevClose = parseFloat(fields[2]);
  const price = parseFloat(fields[3]);

  return {
    code: expectCode,
    name: fields[0],
    open: isNaN(open) ? 0 : open,
    prevClose: isNaN(prevClose) ? 0 : prevClose,
    price: isNaN(price) ? 0 : price,
    high: parseFloat(fields[4]) || 0,
    low: parseFloat(fields[5]) || 0,
    volume: parseFloat(fields[8]) || 0,
    amount: parseFloat(fields[9]) || 0,
    changePct: (prevClose > 0 && !isNaN(price))
      ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2))
      : 0,
    type: 'etf',
  };
}

/**
 * 解析新浪指数行情
 * 格式: var hq_str_s_sh000001="上证指数,现价,涨跌额,涨跌幅%,成交量,成交额"
 * 注意: 指数字段与股票ETF完全不同! 指数只有6个字段
 *   [0]=名称, [1]=现价, [2]=涨跌额, [3]=涨跌幅%, [4]=成交量(手), [5]=成交额(万?)
 */
function parseSinaIndex(raw, expectName) {
  const match = raw.match(/"([^"]*)"/);
  if (!match) return null;
  const fields = match[1].split(',');
  if (fields.length < 4) return null;

  const price = parseFloat(fields[1]) || 0;
  const changeAmt = parseFloat(fields[2]) || 0;
  const changePct = parseFloat(fields[3]) || 0;
  const volume = parseFloat(fields[4]) || 0;
  const amount = parseFloat(fields[5]) || 0;
  const prevClose = price - changeAmt;

  return {
    name: fields[0] || expectName,
    code: '',
    price,
    open: prevClose,   // 指数简化格式无今开,用昨收代替
    prevClose,
    high: Math.max(price, prevClose),
    low: Math.min(price, prevClose),
    changePct,
    changeAmt,
    volume,
    amount,
  };
}

// ============================================================
//  ETF实时行情
// ============================================================

async function fetchETFRealtime(code) {
  const prefix = code.startsWith('6') || code.startsWith('5') || code.startsWith('588')
    ? 'sh' : 'sz';
  const symbol = prefix + code;
  const url = `https://hq.sinajs.cn/list=${symbol}`;

  try {
    const raw = await fetchSina(url);
    return parseSinaStock(raw, code);
  } catch (e) {
    return null;
  }
}

// ============================================================
//  指数数据
// ============================================================

/**
 * 获取主要市场指数 (新浪)
 */
async function fetchMarketIndexes() {
  const symbols = [
    { sid: 's_sh000001', name: '上证指数' },
    { sid: 's_sz399001', name: '深证成指' },
    { sid: 's_sz399006', name: '创业板指' },
    { sid: 's_sh000688', name: '科创50' },
  ];

  const url = `https://hq.sinajs.cn/list=${symbols.map(s => s.sid).join(',')}`;

  try {
    const raw = await fetchSina(url);
    if (!raw || typeof raw !== 'string') return [];

    const results = [];
    // 按 var hq_str_ 分割
    const blocks = raw.split(/var hq_str_/).filter(Boolean);

    for (const sym of symbols) {
      // 找到对应symbol的数据块
      const block = blocks.find(b => b.startsWith(sym.sid + '='));
      if (block) {
        const parsed = parseSinaIndex('var hq_str_' + block, sym.name);
        if (parsed) {
          parsed.code = sym.sid.replace('s_sh', '').replace('s_sz', '');
          results.push(parsed);
        }
      }
    }
    return results;
  } catch (e) {
    return [];
  }
}

// ============================================================
//  基金实时估值 — 天天基金
// ============================================================

async function fetchFundRealtime(code) {
  const url = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  try {
    const text = await fetchWithRetry(url, {
      headers: { 'Referer': 'https://fund.eastmoney.com/' },
    });
    const jsonStr = text.replace(/^jsonpgz\(/, '').replace(/\);?\s*$/, '');
    const data = JSON.parse(jsonStr);
    return {
      code: data.fundcode,
      name: data.name,
      navDate: data.jzrq,
      nav: parseFloat(data.dwjz),
      valuation: parseFloat(data.gsz),
      valuationDate: data.gztime,
      gzPercent: parseFloat(data.gszzl),
      type: 'fund',
    };
  } catch (err) {
    return null;
  }
}

// ============================================================
//  基金历史净值 — 东方财富
// ============================================================

/**
 * 获取场外基金历史净值 (分页获取, 每页最多20条)
 */
async function fetchFundHistory(code, days = 60) {
  const allRecords = [];
  const pages = Math.ceil(days / 20);

  try {
    for (let page = 1; page <= pages; page++) {
      const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${page}&pageSize=20`;
      const data = await fetchWithRetry(url, {
        headers: { 'Referer': 'https://fund.eastmoney.com/' },
      });
      if (data && data.Data && data.Data.LSJZList && data.Data.LSJZList.length > 0) {
        allRecords.push(...data.Data.LSJZList);
      } else {
        break;
      }
      if (page < pages) await sleep(300);
    }

    if (allRecords.length > 0) {
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
        .slice(-days);
    }
  } catch (e) { /* fall through */ }
  return [];
}

// ============================================================
//  ETF历史K线 — 腾讯财经
// ============================================================

async function fetchETFHistory(code, days = 60) {
  const prefix = code.startsWith('6') || code.startsWith('5') || code.startsWith('588')
    ? 'sh' : 'sz';
  const symbol = prefix + code;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${days},qfq`;

  try {
    const data = await fetchWithRetry(url, {
      headers: { 'Referer': 'https://finance.qq.com/' },
    });
    if (data && data.data && data.data[symbol]) {
      const klines = data.data[symbol].qfqday || data.data[symbol].day || [];
      return klines.map(line => ({
        date: line[0],
        open: parseFloat(line[1]),
        close: parseFloat(line[2]),
        high: parseFloat(line[3]),
        low: parseFloat(line[4]),
        volume: parseFloat(line[5]),
        changePct: 0,
      }));
    }
  } catch (e) { /* fall through */ }
  return [];
}

// ============================================================
//  北向资金
// ============================================================

async function fetchNorthFlow() {
  try {
    const url = 'https://push2.eastmoney.com/api/qt/kamt.kline/get?fields1=f1,f3,f5&fields2=f51,f52&klt=101&lmt=1';
    const data = await fetchWithRetry(url, {
      headers: { 'Referer': 'https://data.eastmoney.com/' },
    });
    if (data && data.data && data.data.klines?.length > 0) {
      const last = data.data.klines[0].split(',');
      return { date: last[0], netFlow: parseFloat(last[1]) };
    }
  } catch (e) { /* fall through */ }
  return null;
}

/**
 * 根据指数数据计算市场广度
 */
function computeMarketBreadth(indexes) {
  if (!indexes || indexes.length === 0) return { upCount: 0, downCount: 0, ratio: 0.5 };
  const up = indexes.filter(i => i.changePct > 0).length;
  const down = indexes.filter(i => i.changePct < 0).length;
  return { upCount: up, downCount: down, ratio: indexes.length > 0 ? up / indexes.length : 0.5 };
}

// ============================================================
//  热门基金 — 天天基金排行榜
// ============================================================

/**
 * 解析天天基金排行榜数据 (手动分割, 避免JSON中%号解析问题)
 * 每个条目格式: "code,name,..."
 */
function parseRankData(raw) {
  try {
    const entries = raw.split('","');
    const results = [];

    for (const entry of entries) {
      const clean = entry.replace(/^.*?"/, '').replace(/".*$/, '');
      const fields = clean.split(',');
      if (fields.length < 8 || !/^\d{6}$/.test(fields[0])) continue;

      // Find the date field (YYYY-MM-DD)
      const dateIdx = fields.findIndex(f => /^\d{4}-\d{2}-\d{2}$/.test(f));
      if (dateIdx < 0 || dateIdx + 5 >= fields.length) continue;

      results.push({
        code: fields[0],
        name: fields[1],
        date: fields[dateIdx],
        nav: parseFloat(fields[dateIdx + 1]) || 0,
        dayPct: parseFloat(fields[dateIdx + 3]) || 0,
        weekPct: parseFloat(fields[dateIdx + 4]) || 0,
        monthPct: parseFloat(fields[dateIdx + 5]) || 0,
        type: 'fund',
      });
    }
    return results;
  } catch (e) {
    return [];
  }
}

/**
 * 获取热门基金 (近1月涨幅榜 + 近1周涨幅榜)
 * 优先C类(0申购费), 排除ETF/债券/货币
 */
async function fetchHotFunds() {
  const hotFunds = new Map();

  // 排行榜: 综合热度+盈利能力, 覆盖多个时间维度
  const queries = [
    { sc: 'zzf', desc: '近1月', st: 'desc', limit: 50 },
    { sc: '1w', desc: '近1周', st: 'desc', limit: 50 },
    { sc: '3m', desc: '近3月', st: 'desc', limit: 50 },
    { sc: '6m', desc: '近6月', st: 'desc', limit: 50 },
    { sc: '1y', desc: '近1年', st: 'desc', limit: 50 },
    { sc: 'yn', desc: '今年来', st: 'desc', limit: 50 },
  ];

  for (const q of queries) {
    try {
      const url = `https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=all&sc=${q.sc}&st=${q.st}&pi=1&pn=${q.limit}&dx=1`;
      const raw = await fetchWithRetry(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fund.eastmoney.com/' },
      });
      const funds = parseRankData(raw);

      for (const f of funds) {
        if (f.code && !hotFunds.has(f.code)) {
          // 支付宝规则: 只留场外C类基金
          // 排除场内ETF (5开头6位/1开头6位/588开头, 支付宝买不了)
          if (/^(5\d{5}|1[56]\d{4}|588\d{3})$/.test(f.code)) continue;
          // 排除债券/货币/理财
          if (/债|利率|货币|理财|纯债/.test(f.name)) continue;
          if (/^9[56]/.test(f.code)) continue;
          // 优先C类, A类也保留
          const isC = f.name.endsWith('C');
          const priority = isC ? 2 : 1;

          hotFunds.set(f.code, {
            code: f.code,
            name: f.name,
            type: 'fund',
            minBuy: 10,
            maxWeight: 0.10,
            hotSource: q.desc,
            monthPct: f.monthPct,
            weekPct: f.weekPct,
            dayPct: f.dayPct,
            priority: priority,
          });
        }
      }
      await sleep(300);
    } catch (e) {
      // 某个榜单失败不影响整体
    }
  }

  return Array.from(hotFunds.values());
}

// ============================================================
//  一站式数据获取
// ============================================================

async function fetchAllData() {
  const { WATCHLIST, SCREENER_CONFIG } = require('./config');
  const baseFunds = [
    ...(WATCHLIST.aiChip || []),
    ...(WATCHLIST.newEnergy || []),
    ...(WATCHLIST.internetTech || []),
    ...(WATCHLIST.techBase || []),
    ...(WATCHLIST.globalTech || []),
    ...(WATCHLIST.satellite || []),
    ...(WATCHLIST.rotationWatch || []),
  ];

  // 全市场Top100筛选
  let allFunds = [...baseFunds];
  let moduleSummary = null;

  if (SCREENER_CONFIG?.enableAllMarket) {
    try {
      const { screenTopFunds } = require('./fund_screener');
      console.log('🔍 正在筛选全市场Top100基金...');
      const screenResult = await screenTopFunds(SCREENER_CONFIG.topNPerModule || 100);
      moduleSummary = screenResult.modules;

      // 去重: 全市场基金排除已有的
      const existingCodes = new Set(baseFunds.map(f => f.code));
      const newFunds = screenResult.allFunds
        .filter(f => !existingCodes.has(f.code))
        .slice(0, (SCREENER_CONFIG.maxFundsToFetch || 150) - baseFunds.length);

      allFunds = [...baseFunds, ...newFunds];
      console.log(`  全市场: ${screenResult.allFunds.length}只 → 选取${newFunds.length}只 + 核心${baseFunds.length}只 = ${allFunds.length}只`);

      // 打印各模块数量
      for (const [key, mod] of Object.entries(moduleSummary)) {
        if (mod.count > 0) {
          console.log(`    ${mod.name}: ${mod.count}只`);
        }
      }
    } catch (e) {
      console.log('  全市场筛选失败, 回退到热门基金模式');
      const hotFunds = await fetchHotFunds();
      const existingCodes = new Set(baseFunds.map(f => f.code));
      const newHotFunds = hotFunds
        .filter(f => !existingCodes.has(f.code))
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))
        .slice(0, 65);
      allFunds = [...baseFunds, ...newHotFunds];
    }
  } else {
    const hotFunds = await fetchHotFunds();
    const existingCodes = new Set(baseFunds.map(f => f.code));
    const newHotFunds = hotFunds
      .filter(f => !existingCodes.has(f.code))
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
      .slice(0, 65);
    allFunds = [...baseFunds, ...newHotFunds];
  }

  console.log(`📡 正在获取 ${allFunds.length} 只基金的实时数据...`);

  const results = [];
  const BATCH_SIZE = 8;

  for (let i = 0; i < allFunds.length; i += BATCH_SIZE) {
    const batch = allFunds.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (fund) => {
        let realtime;
        if (fund.type === 'etf') {
          realtime = await fetchETFRealtime(fund.code);
        } else {
          realtime = await fetchFundRealtime(fund.code);
        }
        if (realtime) {
          realtime.history = await fetchFundHistory(fund.code, TECH_CONFIG.longMA + TECH_CONFIG.macdSlow + 10);
          realtime.fundType = fund.type || 'fund';
          realtime.maxWeight = fund.maxWeight;
          realtime.minBuy = fund.minBuy || 10;
          process.stdout.write('.');
        } else {
          process.stdout.write('x');
        }
        return realtime;
      })
    );
    results.push(...batchResults.filter(Boolean));
    if (i + BATCH_SIZE < allFunds.length) {
      await sleep(500);
    }
  }
  console.log(`\n  成功: ${results.length}/${allFunds.length}`);

  console.log('📊 正在获取大盘指数...');
  const indexes = await fetchMarketIndexes();
  const breadth = computeMarketBreadth(indexes);
  console.log(`  获取到 ${indexes.length} 个指数`);

  let northFlow = null;
  try { northFlow = await fetchNorthFlow(); } catch (e) { /* ignore */ }

  return {
    funds: results,
    indexes,
    breadth,
    northFlow,
    fetchTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
  };
}

module.exports = {
  fetchAllData,
  fetchFundRealtime,
  fetchETFRealtime,
  fetchFundHistory,
  fetchETFHistory,
  fetchMarketIndexes,
  computeMarketBreadth,
  fetchNorthFlow,
};
