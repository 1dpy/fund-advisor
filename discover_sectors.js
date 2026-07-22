/**
 * 赛道发现 — 用 eastmoney 搜索接口按关键词发现真实可买的 C类赛道基金
 * 并抓净值验证(保留数据充足的), 输出可直接加入 config.PREFERRED_SECTORS 的清单
 * 用法: node discover_sectors.js
 */
const https = require('https');
const { fetchNavHistory } = require('./src/ml_sector_selector');

const KEYWORDS = ['人工智能', '通信', '5G', '军工', '机器人', '光伏', '医疗', '消费电子', '游戏', '云计算', '半导体', '芯片', '有色', '证券', '数字经济', '智能汽车', '稀土', '低碳', '电力', '软件'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function searchFund(key, tries = 4) {
  return new Promise((resolve) => {
    const url = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=' + encodeURIComponent(key);
    const attempt = (n) => {
      const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fund.eastmoney.com/' } }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
          try {
            const j = JSON.parse(d);
            const list = (j.Datas || []).map((x) => ({
              code: x.CODE,
              name: (x.NAME || '').replace(/<[^>]+>/g, ''),
              isbuy: x.ISBUY || (x.FundBaseInfo && x.FundBaseInfo.ISBUY) || (x.fund && x.fund.ISBUY),
            }));
            // 筛 C类(名称以C结尾) + 可买, 每关键词取前2
            resolve(list.filter((x) => String(x.isbuy) === '1' && /C$/.test(x.name)).slice(0, 2));
          } catch (e) { if (n > 1) attempt(n - 1); else resolve([]); }
        });
      });
      req.on('error', () => { if (n > 1) attempt(n - 1); else resolve([]); });
      req.setTimeout(10000, () => { req.destroy(); if (n > 1) attempt(n - 1); else resolve([]); });
    };
    attempt(tries);
  });
}

(async () => {
  const seen = new Set();
  const found = [];
  for (const kw of KEYWORDS) {
    const cands = await searchFund(kw);
    for (const c of cands) { if (!seen.has(c.code)) { seen.add(c.code); found.push({ ...c, sector: kw }); } }
    await sleep(120);
  }
  console.log(`搜索到候选 ${found.length} 只, 开始抓净值验证...\n`);

  const valid = [];
  for (const f of found) {
    try {
      const navs = await fetchNavHistory(f.code, 60, true);
      if (navs.length >= 40) { valid.push({ ...f, dataPoints: navs.length }); }
    } catch (e) { /* skip */ }
    await sleep(100);
  }

  console.log(`=== 有效赛道基金 ${valid.length} 只 (数据充足>=40) ===\n`);
  for (const v of valid) {
    console.log(`  { code: '${v.code}', name: '${v.name}', sector: '${v.sector}', maxWeight: 0.20 }, // data=${v.dataPoints}`);
  }
})();
