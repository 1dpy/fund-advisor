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

// ============================================================
// 主函数: 实时扫描全部候选赛道, 返回按综合分降序的数组
//   opts: { days=12, delayMs=120 }
// ============================================================
async function fetchRealtimeSectorScores(opts = {}) {
  const { days = 12, delayMs = 120 } = opts;
  const out = [];
  for (const s of PREFERRED_SECTORS) {
    let est = null, mom = { mom5: 0, maTrend: 0, available: false };
    // 并行抓估值 + 动量
    const [estRes, navs] = await Promise.all([
      fetchLiveEstimate(s.code).catch(() => null),
      fetchNavHistory(s.code, days, true).catch(() => []),
    ]);
    est = estRes;
    if (navs && navs.length) mom = calcMomentum(navs);

    let score;
    if (est && mom.available) {
      score = 0.6 * est.changePct + 0.25 * mom.mom5 + 0.15 * mom.maTrend;
    } else if (est) {
      score = est.changePct; // 只有盘中估值, 直接用
    } else if (mom.available) {
      score = 0.7 * mom.mom5 + 0.3 * mom.maTrend; // 估值缺失, 纯动量兜底
    } else {
      score = -999; // 全失败, 排末尾
    }

    out.push({
      code: s.code,
      name: s.name,
      sector: s.sector,
      maxWeight: s.maxWeight,
      changePct: est ? est.changePct : null,
      gztime: est ? est.gztime : '',
      mom5: mom.mom5,
      maTrend: mom.maTrend,
      score: Math.round(score * 100) / 100,
    });

    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

module.exports = { fetchRealtimeSectorScores, fetchLiveEstimate, calcMomentum };
