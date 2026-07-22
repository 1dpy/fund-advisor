/**
 * 实时行情驱动的动态选基模块
 *
 * 用户 2026-07-22 需求: 不要固定按优先级取赛道, 而是
 *   "先读当时的实时行情 -> 按真实强弱动态挑出最强的 N 只" 再推荐买入。
 *
 * 实现:
 *   1. 对 PREFERRED_SECTORS 每只候选基金抓取【盘中实时估值涨跌幅】(真·当时行情)
 *        - 主源: 同花顺 fundgz (盘中持续更新, gztime 带时间戳)
 *        - 备源: 东方财富 fundgz (自动跟随 302 重定向)
 *   2. 叠加【近期动量】(从 lsjz 历史净值算 近5日收益 + 相对MA10位置)
 *        - 该源沙箱/用户机都稳定可用, 作为估值抓不到时的兜底"强弱"信号
 *   3. 综合打分: score = 0.6*实时估值% + 0.25*近5日% + 0.15*均线偏离%
 *        - 估值缺失时自动归一化到动量(0.7*近5日 + 0.3*均线), 保证不空推
 *   4. 返回按 score 降序的数组, 供 advisor 取 Top-N 动态部署
 *
 * 健壮性: 单只失败不影响整体; 整批失败返回 null, advisor 自动回退到原固定策略。
 */

const https = require('https');
const { PREFERRED_SECTORS } = require('./config');
const { fetchNavHistory } = require('./ml_sector_selector');

// 赛道 → 对应 ETF (交易所真实成交价, 比基金盘中估值更实时更准)
//   代码经 westock MCP 实测可用; 用户本机可直连腾讯/东财行情接口拉取
const SECTOR_ETF_MAP = {
  '半导体':   ['sh512480'],
  '科创':     ['sh588000'],
  '人工智能': ['sh515980'],
  '5G通信':   ['sh515050'],
  '云计算':   ['sh516510'],
  '恒生科技': ['sh513180'],
  '数字经济': ['sh560800'],
  '新能源':   ['sh516160'],
  '光伏':     ['sh515790'],
  '智能汽车': ['sh515250'],
  '军工':     ['sh512660'],
  '游戏':     ['sh159869'],
  '有色':     ['sh512400'],
  '稀土':     ['sh516780'],
  '券商':     ['sh512000'],
};

// —— HTTP 工具: 带超时 + 跟随重定向 ——
function httpGet(url, opts = {}) {
  const { headers = { 'User-Agent': 'Mozilla/5.0' }, timeout = 9000, redirects = 3 } = opts;
  return new Promise((resolve) => {
    const req = https.get(url, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && redirects > 0 && res.headers.location) {
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        res.resume();
        return resolve(httpGet(next, { ...opts, redirects: redirects - 1 }));
      }
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body: d }));
    });
    req.on('error', () => resolve({ ok: false, body: '' }));
    req.setTimeout(timeout, () => { req.destroy(); resolve({ ok: false, body: '' }); });
  });
}

// —— 抓盘中实时估值涨跌幅(%) —— 返回 { changePct, gztime } 或 null
async function fetchLiveEstimate(code) {
  // 主源: 同花顺
  const tqUrl = `https://fundgz.10jqka.com.cn/js/${code}.js`;
  const tq = await httpGet(tqUrl);
  if (tq.ok && tq.body) {
    const m = tq.body.match(/jsonpgz\(([\s\S]*)\)/);
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        const pct = parseFloat(j.gszzl);
        if (!isNaN(pct)) return { changePct: pct, gztime: j.gztime || '', source: '10jqka' };
      } catch (e) { /* ignore */ }
    }
  }
  // 备源: 东方财富 (302 自动跟随)
  const emUrl = `https://fundgz.eastmoney.com/JS/C?_=${Date.now()}&CODE=${code}`;
  const em = await httpGet(emUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fundf10.eastmoney.com/' } });
  if (em.ok && em.body) {
    const m = em.body.match(/jsonp\(([\s\S]*)\)/) || em.body.match(/\(([\s\S]*)\)/);
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        const pct = parseFloat(j.gszzl != null ? j.gszzl : j.expectGrowth);
        if (!isNaN(pct)) return { changePct: pct, gztime: j.gztime || '', source: 'eastmoney' };
      } catch (e) { /* ignore */ }
    }
  }
  return null;
}

// —— 从历史净值算动量 —— 返回 { mom5, maTrend }
function calcMomentum(navs) {
  const closes = navs.filter(n => n.nav > 0).map(n => n.nav);
  if (closes.length < 11) return { mom5: 0, maTrend: 0, available: false };
  const last = closes[closes.length - 1];
  const ma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const mom5 = (last / closes[closes.length - 6] - 1) * 100; // 近5日收益%
  const maTrend = (last / ma10 - 1) * 100; // 偏离MA10%
  return { mom5: Math.round(mom5 * 100) / 100, maTrend: Math.round(maTrend * 100) / 100, available: true };
}

// —— 批量拉赛道 ETF 实时成交行情 (交易所真实成交价, 秒级刷新) ——
//   主源: 腾讯 qt.gtimg.cn (批量, 文本)  备源: 东方财富 push2 (JSON)
//   返回 { code: { price, prevClose, changePct, name } }
async function fetchEtfQuotes(codes) {
  const map = {};
  if (!codes.length) return map;
  // —— 主源: 腾讯行情 (一次批量) ——
  const txUrl = `https://qt.gtimg.cn/q=${codes.join(',')}`;
  const tx = await httpGet(txUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' }, timeout: 9000 });
  if (tx.ok && tx.body) {
    const re = /v_(\w+)="([^"]*)"/g; let m;
    while ((m = re.exec(tx.body))) {
      const f = m[2].split('~');
      const price = parseFloat(f[3]);
      const prev = parseFloat(f[4]);
      if (!isNaN(price) && !isNaN(prev) && prev > 0) {
        map[m[1]] = { price, prevClose: prev, changePct: Math.round((price / prev - 1) * 10000) / 100, name: f[1] || m[1] };
      }
    }
  }
  if (Object.keys(map).length === codes.length) return map; // 主源已全拿齐

  // —— 备源: 东方财富 push2 (补主源没拿到的) ——
  const mkt = { sh: 1, sz: 0, hk: 116 };
  const miss = codes.filter((c) => !map[c]);
  const secids = miss.map((c) => {
    const mm = c.match(/^([a-z]{2})(\d{6})$/);
    return mm ? (mkt[mm[1]] || 1) + '.' + mm[2] : c;
  }).join(',');
  if (secids) {
    const emUrl = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f2,f3,f12,f14&_=${Date.now()}`;
    const em = await httpGet(emUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' }, timeout: 9000 });
    if (em.ok && em.body) {
      try {
        const j = JSON.parse(em.body);
        const diff = (j.data && j.data.diff) || [];
        diff.forEach((d, i) => {
          const code = miss[i];
          const cp = parseFloat(d.f3); // 涨跌幅%
          const price = parseFloat(d.f2); // 现价(元, fltt=2)
          if (!isNaN(cp)) map[code] = { price: isNaN(price) ? 0 : price, prevClose: 0, changePct: Math.round(cp * 100) / 100, name: d.f14 || code };
        });
      } catch (e) { /* ignore */ }
    }
  }
  return map;
}

// ============================================================
// 主函数: 实时扫描全部候选赛道, 返回按综合分降序的数组
//   opts: { days=12, delayMs=120 }
//   数据源优先级: 赛道ETF实时成交价 > 基金盘中估值 > 历史动量 > -999(全失败)
// ============================================================
async function fetchRealtimeSectorScores(opts = {}) {
  const { days = 12, delayMs = 120 } = opts;
  // 1) 赛道 -> ETF 代码 (去重)
  const sectorEtfs = {};
  for (const s of PREFERRED_SECTORS) sectorEtfs[s.sector] = SECTOR_ETF_MAP[s.sector] || [];
  const allEtfs = [...new Set(Object.values(sectorEtfs).flat())];
  // 2) 批量拉 ETF 实时成交行情 (一次请求, 交易所真实成交价)
  let etfQuotes = {};
  try { etfQuotes = await fetchEtfQuotes(allEtfs); } catch (e) { etfQuotes = {}; }

  const out = [];
  for (const s of PREFERRED_SECTORS) {
    const etfs = sectorEtfs[s.sector] || [];
    const etfVals = etfs.map((c) => etfQuotes[c]).filter(Boolean);
    const etfChange = etfVals.length ? Math.round(etfVals.reduce((a, b) => a + b.changePct, 0) / etfVals.length * 100) / 100 : null;
    const etfName = etfVals.length ? etfVals[0].name : '';

    // 动量 (历史净值, 兜底强弱信号)
    let mom = { mom5: 0, maTrend: 0, available: false };
    const navs = await fetchNavHistory(s.code, days, true).catch(() => []);
    if (navs && navs.length) mom = calcMomentum(navs);

    // 基金盘中估值 (次兜底)
    const est = await fetchLiveEstimate(s.code).catch(() => null);

    let score, source;
    if (etfChange != null && mom.available) {
      score = 0.7 * etfChange + 0.2 * mom.mom5 + 0.1 * mom.maTrend; source = 'etf';
    } else if (etfChange != null) {
      score = etfChange; source = 'etf';
    } else if (est && mom.available) {
      score = 0.6 * est.changePct + 0.25 * mom.mom5 + 0.15 * mom.maTrend; source = 'estimate';
    } else if (est) {
      score = est.changePct; source = 'estimate';
    } else if (mom.available) {
      score = 0.7 * mom.mom5 + 0.3 * mom.maTrend; source = 'momentum';
    } else {
      score = -999; source = 'none';
    }

    out.push({
      code: s.code,
      name: s.name,
      sector: s.sector,
      maxWeight: s.maxWeight,
      changePct: etfChange != null ? etfChange : (est ? est.changePct : null),
      gztime: etfChange != null ? 'etf-realtime' : (est ? est.gztime : ''),
      etfName, mom5: mom.mom5, maTrend: mom.maTrend,
      score: Math.round(score * 100) / 100, dataSource: source,
    });

    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

module.exports = { fetchRealtimeSectorScores, fetchLiveEstimate, calcMomentum };
