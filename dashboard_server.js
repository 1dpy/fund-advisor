/**
 * 本地仪表盘服务 (Dashboard Server) — 零依赖 (Node 内置 http)
 * ---------------------------------------------------------------
 * 把量化实验室 / 因子库 / 持仓账本 暴露成 Web 界面, 供本地查看与复试演示。
 *
 * 启动: node dashboard_server.js            (默认 http://localhost:8787)
 *       PORT=9000 node dashboard_server.js  (自定义端口)
 *
 * 接口:
 *   GET /                     仪表盘首页 (dashboard/index.html)
 *   GET /api/portfolio        持仓账本 (读 holdings.json, 计算盈亏/权重)
 *   GET /api/factors?mode=     因子排名 + 截面 z-score 热力矩阵 (demo|live)
 *   GET /api/backtest?mode=    7 策略回测对比 (权益曲线/夏普/回撤/调仓)
 *   GET /api/selfiterate?mode= 自我迭代元优化 (折表/元参数演化/holdout 曲线)
 *   GET /api/sectors?mode=     当日实时赛道综合得分 Top10 (实时抓取|确定性合成回退)
 *   POST /api/holding-image    {image:dataURL} → 存盘 + OCR(tesseract.js, 可选) → 候选
 *   POST /api/holding-confirm  {holdings:[...]} → 核对后写入 holdings.json (保留锁定约定)
 * 所有计算经 src/quant_lab_core.js, 失败安全降级为合成数据; 结果内存缓存复用。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const core = require('./src/quant_lab_core');

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const DASHBOARD_DIR = path.join(ROOT, 'dashboard');
const UPLOAD_DIR = path.join(ROOT, 'data', 'uploads');
const HOLDINGS_FILE = path.join(ROOT, 'holdings.json');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}
const { START, REBAL, WINDOW, DAYS, HOLDOUT } = core.DEFAULTS;

// 已知基金名 → 代码 / 锁定约定 (用户框架: 广发压舱石 / 易方达减仓后持有)
const NAME_CODE_MAP = [
  { re: /广发全球|全球精选/, code: '021277', locked: true, lockReason: '压舱石' },
  { re: /易方达信息产业/, code: '019018', locked: true, lockReason: '已减仓, 持有不动(仅科创50破5日线放量才减)' },
  { re: /余额宝|零钱通|活期|货币/, code: 'CASH_YEB', locked: false, lockReason: '' },
];
function deriveCode(name, idx) {
  for (const m of NAME_CODE_MAP) if (m.re.test(name || '')) return m;
  return { code: 'IMG_' + (idx + 1), locked: false, lockReason: '' };
}

// ---------- 内存缓存 (带 in-flight 去重, 避免并发重复计算) ----------
const cache = {};
function getCached(key, ttlMs, compute) {
  const c = cache[key];
  if (c && c.data && Date.now() - c.ts < ttlMs) return Promise.resolve(c.data);
  if (c && c.promise) return c.promise;
  const p = Promise.resolve().then(compute).then((data) => {
    cache[key] = { ts: Date.now(), data, promise: null };
    return data;
  }).catch((e) => {
    cache[key] = { ts: 0, data: null, promise: null };
    throw e;
  });
  cache[key] = { ts: 0, data: null, promise: p };
  return p;
}

// ---------- 情绪/新闻因子 (可选, 超时安全) ----------
async function getSentimentNews() {
  let sentiment = null, news = 0;
  try {
    const { analyzeMarketSentiment } = require('./src/sentiment_engine');
    const se = await Promise.race([analyzeMarketSentiment(), new Promise((r) => setTimeout(() => r(null), 6000))]);
    if (se && typeof se.score === 'number') sentiment = se.score;
  } catch (e) {}
  try {
    const { getNewsSentimentFactor } = require('./src/news_sentiment');
    const nf = await Promise.race([getNewsSentimentFactor(), new Promise((r) => setTimeout(() => r(null), 6000))]);
    if (nf && nf.available) news = nf.score;
  } catch (e) {}
  return { sentiment, news };
}

// ---------- 各 API 计算 ----------
async function portfolioData() {
  const file = path.join(ROOT, 'holdings.json');
  let holdings = [];
  let source = 'holdings.json (本地账本, 需收盘后手动回报)';
  try { holdings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { holdings = []; }
  // 新 clone 且本地无 holdings.json 时回退到公开示例, 让 portfolio 标签页也有展示
  if (!holdings || holdings.length === 0) {
    try {
      const ex = JSON.parse(fs.readFileSync(path.join(ROOT, 'holdings.example.json'), 'utf8'));
      if (Array.isArray(ex) && ex.length) { holdings = ex; source = 'holdings.example.json (公开示例, 复制为 holdings.json 后可改用真实账本)'; }
    } catch (e) { /* 忽略 */ }
  }
  const positions = holdings.map((h) => {
    const cost = h.costBasis != null ? h.costBasis : (h.buyPrice || 0) * (h.shares || 1);
    const val = h.currentValue != null ? h.currentValue : cost;
    const pnl = val - cost;
    return {
      code: h.code, name: h.name, type: h.type || 'fund', cost: +cost.toFixed(2), value: +val.toFixed(2),
      pnl: +pnl.toFixed(2), pnlPct: cost ? +((pnl / cost) * 100).toFixed(2) : 0,
      locked: !!h.locked, lockReason: h.lockReason || '', buyDate: h.buyDate || '',
    };
  });
  const totalValue = positions.reduce((s, p) => s + p.value, 0);
  const totalCost = positions.reduce((s, p) => s + p.cost, 0);
  const totalPnl = totalValue - totalCost;
  positions.forEach((p) => (p.weight = totalValue ? +((p.value / totalValue) * 100).toFixed(2) : 0));
  const cash = positions.filter((p) => p.type === 'cash').reduce((s, p) => s + p.value, 0);
  return {
    asOf: new Date().toISOString().slice(0, 10),
    totalValue: +totalValue.toFixed(2), totalCost: +totalCost.toFixed(2),
    totalPnl: +totalPnl.toFixed(2), totalPnlPct: totalCost ? +((totalPnl / totalCost) * 100).toFixed(2) : 0,
    cash: +cash.toFixed(2), positions, source,
  };
}

async function factorsData(mode) {
  const forceDemo = mode !== 'live';
  const { sentiment, news } = forceDemo ? { sentiment: null, news: 0 } : await getSentimentNews();
  return await core.fetchFactorData({ days: 250, forceDemo, sentiment, news });
}

async function backtestData(mode) {
  const forceDemo = mode !== 'live';
  const { sentiment, news } = forceDemo ? { sentiment: null, news: 0 } : await getSentimentNews();
  const prep = await core.prepData({ days: DAYS, holdout: HOLDOUT, forceDemo });
  const { results } = core.runStrategies(prep.closesByCode, prep.codes, { start: START, rebal: REBAL, window: WINDOW, sentiment, news, commonDates: prep.commonDates });
  const strategies = Object.keys(results).map((k) => ({
    key: k, label: results[k].label, total: results[k].total, sharpe: results[k].sharpe,
    mdd: results[k].mdd, trades: results[k].trades, costTotal: results[k].costTotal, curve: results[k].curve,
  }));
  return { mode: prep.dataMode, nDays: prep.N, holdout: HOLDOUT, strategies, dates: prep.commonDates };
}

async function selfIterateData(mode) {
  const forceDemo = mode !== 'live';
  const { sentiment, news } = forceDemo ? { sentiment: null, news: 0 } : await getSentimentNews();
  const prep = await core.prepData({ days: DAYS, holdout: HOLDOUT, forceDemo });
  const si = core.runSelfIterate(prep.closesByCode, prep.codes, { start: START, rebal: REBAL, foldStep: 20, embargo: 5, holdout: HOLDOUT, sentiment, news });
  if (!si) return { error: '数据不足以自我迭代(需更长历史)' };
  return { mode: prep.dataMode, nDays: prep.N, holdout: HOLDOUT, ...si };
}

// ---------- 持仓截图上传 / 确认 ----------
// 读取 POST body (JSON, 限制 12MB)
function readBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('上传过大')); req.destroy(); return; }
      buf += c;
    });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(new Error('JSON 解析失败')); } });
    req.on('error', reject);
  });
}

// 1) 接收 base64 图片 → 存盘 → OCR → 返回候选 (供前端核对)
async function holdingImageData(imageDataUrl, fileName) {
  // 解析 dataURL: data:image/png;base64,xxxx
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(imageDataUrl || '');
  if (!m) throw new Error('图片格式应为 dataURL (base64)');
  const ext = m[1].split('/')[1] || 'png';
  const base64 = m[2];
  const stamp = Date.now().toString(36);
  const safe = (fileName || 'shot').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5.-]/g, '_').slice(0, 40);
  const imgPath = path.join(UPLOAD_DIR, `${stamp}_${safe}.${ext}`);
  fs.writeFileSync(imgPath, Buffer.from(base64, 'base64'));

  let result;
  try {
    const parser = require('./src/holding_image_parser');
    result = await parser.parseHoldingImage(imgPath);
  } catch (e) {
    if (e.code === 'NO_OCR') {
      return { ok: false, needOcr: true, hint: e.message, imageSaved: imgPath, rawText: '' };
    }
    throw e;
  }
  return { ok: true, needOcr: false, imageSaved: imgPath, engine: result.engine, rawText: result.rawText, candidates: result.candidates };
}

// 2) 用户核对后确认 → 写 holdings.json (保留锁定约定, 反推成本)
function confirmHoldingData(payload) {
  const list = Array.isArray(payload) ? payload : (payload && payload.holdings) || [];
  if (!Array.isArray(list) || !list.length) throw new Error('候选为空');

  // 保留上一版(用于沿用 costBasis / buyDate / 备注, 仅当同一 code)
  let prev = [];
  try { prev = JSON.parse(fs.readFileSync(HOLDINGS_FILE, 'utf8')); } catch (e) {}
  const prevByCode = {};
  prev.forEach((h) => (prevByCode[h.code] = h));

  const out = list.map((it, i) => {
    const name = String(it.name || '').trim();
    const type = it.type === 'cash' ? 'cash' : 'fund';
    const currentValue = Math.max(0, Number(it.currentValue) || 0);
    const holdingReturn = Number(it.holdingReturn) || 0;
    const info = deriveCode(name, i);
    const prevH = prevByCode[info.code];
    const costBasis = prevH && prevH.costBasis != null ? prevH.costBasis : Math.round((currentValue - holdingReturn) * 100) / 100;
    return {
      code: info.code,
      name: name || (type === 'cash' ? '余额宝(现金)' : info.code),
      type,
      buyDate: prevH && prevH.buyDate ? prevH.buyDate : new Date().toISOString().slice(0, 10),
      buyPrice: costBasis,
      shares: 1,
      costBasis,
      currentValue: Math.round(currentValue * 100) / 100,
      holdingReturn: Math.round(holdingReturn * 100) / 100,
      holdingReturnPct: costBasis ? Math.round((holdingReturn / costBasis) * 10000) / 100 : 0,
      locked: !!info.locked || !!prevH,
      lockReason: info.lockReason || (prevH && prevH.lockReason) || '',
      notes: (prevH && prevH.notes ? prevH.notes + ' | ' : '') + '截图回报 ' + new Date().toISOString().slice(0, 10),
    };
  });

  // 备份再写
  try { fs.copyFileSync(HOLDINGS_FILE, HOLDINGS_FILE + '.bak.' + Date.now()); } catch (e) {}
  fs.writeFileSync(HOLDINGS_FILE, JSON.stringify(out, null, 2));
  // 清缓存
  cache.portfolio = { ts: 0, data: null, promise: null };
  return { ok: true, count: out.length, holdings: out };
}

// ---------- 实时赛道综合得分 (Top10) ----------
// 字符串→32位种子 (FNV-1a)
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// 确定性合成: 用修正后的 mulberry32, 按 code+day 播种 → demo/离线可复现, 与实盘同公式
function syntheticSectorScores() {
  let sectors = [];
  try { sectors = (require('./src/config').PREFERRED_SECTORS || []).slice(); } catch (e) { sectors = []; }
  if (!sectors.length) {
    sectors = [
      { code: '008282', name: '国泰芯片ETF联接C', sector: '半导体' },
      { code: '017470', name: '嘉实中证半导体C', sector: '半导体' },
      { code: '011609', name: '易方达科创50联接C', sector: '科创' },
      { code: '011840', name: '天弘中证人工智能C', sector: '人工智能' },
      { code: '008087', name: '华夏5G通信联接C', sector: '5G通信' },
      { code: '012322', name: '东财云计算增强C', sector: '云计算' },
      { code: '013402', name: '华夏恒生科技联接C', sector: '恒生科技' },
      { code: '012083', name: '博时数字经济混合C', sector: '数字经济' },
      { code: '027495', name: '易方达电池ETF联接C', sector: '新能源' },
      { code: '007531', name: '华宝券商联接C', sector: '券商' },
    ];
  }
  const day = new Date().toISOString().slice(0, 10);
  const arr = sectors.map((s) => {
    const r1 = core.mulberry32(hashStr(s.code + 'c' + day))();
    const r2 = core.mulberry32(hashStr(s.code + 'm' + day))();
    const r3 = core.mulberry32(hashStr(s.code + 'a' + day))();
    const changePct = +(r1 * 4 - 1.6).toFixed(2);   // -1.6 .. 2.4
    const mom5 = +(r2 * 7 - 2.5).toFixed(2);          // -2.5 .. 4.5
    const maTrend = +(r3 * 4 - 1.5).toFixed(2);       // -1.5 .. 2.5
    const score = +(0.6 * changePct + 0.25 * mom5 + 0.15 * maTrend).toFixed(2);
    return { code: s.code, name: s.name, sector: s.sector || '', maxWeight: s.maxWeight || 0, changePct, gztime: '', mom5, maTrend, score };
  });
  arr.sort((a, b) => b.score - a.score);
  return arr;
}

async function sectorsData(mode) {
  const forceDemo = mode !== 'live';
  const asOf = new Date().toISOString().slice(0, 10);
  let scores = null, dataSource = 'synthetic';
  if (!forceDemo) {
    try {
      const rt = require('./src/realtime_quotes');
      const res = await Promise.race([
        rt.fetchRealtimeSectorScores({ days: 12, delayMs: 60 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
      ]);
      // 整批失败(沙箱DNS被拦等) → 分数全 -999, 回退合成
      if (res && res.length && res.some((a) => a.score > -999)) {
        scores = res;
        const etfCnt = res.filter((a) => a.dataSource === 'etf').length;
        const liveCnt = res.filter((a) => a.dataSource === 'etf' || a.dataSource === 'estimate').length;
        dataSource = etfCnt === res.length
          ? 'live (ETF实时成交价)'
          : (liveCnt > 0 ? 'live (ETF+估值混合)' : 'live (仅动量兜底)');
      } else dataSource = 'synthetic (实盘抓取失败, 已回退)';
    } catch (e) { dataSource = 'synthetic (实盘抓取失败, 已回退)'; }
  }
  if (!scores) scores = syntheticSectorScores();
  const top = scores.slice(0, 10);
  return { asOf, mode: forceDemo ? 'demo' : 'live', dataSource, total: scores.length, top, all: scores };
}

// ---------- 静态文件托管 (防目录穿越) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(rel, res) {
  const fp = path.normalize(path.join(DASHBOARD_DIR, rel));
  if (!fp.startsWith(DASHBOARD_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(buf);
  });
}
function sendJSON(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // ---- POST: 持仓截图上传 / 确认 ----
    if (req.method === 'POST') {
      if (p === '/api/holding-image') {
        const body = await readBody(req);
        const r = await holdingImageData(body.image, body.fileName);
        return sendJSON(res, r);
      }
      if (p === '/api/holding-confirm') {
        const body = await readBody(req);
        const r = confirmHoldingData(body);
        return sendJSON(res, r);
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '未知 POST 接口' }));
    }

    if (p === '/api/portfolio') return sendJSON(res, await getCached('portfolio', 30000, portfolioData));
    if (p === '/api/factors') {
      const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';
      const refresh = url.searchParams.get('refresh') === '1';
      return sendJSON(res, refresh ? await factorsData(mode) : await getCached('factors_' + mode, mode === 'live' ? 60000 : 300000, () => factorsData(mode)));
    }
    if (p === '/api/backtest') {
      const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';
      const refresh = url.searchParams.get('refresh') === '1';
      return sendJSON(res, refresh ? await backtestData(mode) : await getCached('backtest_' + mode, mode === 'live' ? 60000 : 300000, () => backtestData(mode)));
    }
    if (p === '/api/selfiterate') {
      const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';
      const refresh = url.searchParams.get('refresh') === '1';
      return sendJSON(res, refresh ? await selfIterateData(mode) : await getCached('selfiterate_' + mode, mode === 'live' ? 60000 : 300000, () => selfIterateData(mode)));
    }
    if (p === '/api/sectors') {
      const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'demo';
      const refresh = url.searchParams.get('refresh') === '1';
      return sendJSON(res, refresh ? await sectorsData(mode) : await getCached('sectors_' + mode, mode === 'live' ? 60000 : 300000, () => sectorsData(mode)));
    }
    if (p === '/' || p === '/index.html') return serveStatic('index.html', res);
    return serveStatic(p.replace(/^\//, ''), res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(e && e.stack || e) }));
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n📊 基金量化仪表盘已启动:  http://localhost:${PORT}`);
    console.log(`   持仓账本 / 因子热力图 / 回测对比 / 自我迭代 — 浏览器打开即可\n`);
  });
}

module.exports = { server, portfolioData, factorsData, backtestData, selfIterateData, sectorsData, holdingImageData, confirmHoldingData };
