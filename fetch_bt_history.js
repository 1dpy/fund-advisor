/**
 * 抓取真实基金历史净值 (eastmoney API) 供 PROFIT_FIRST 回测使用
 * 运行: node fetch_bt_history.js
 */
const fs = require('fs');
const path = require('path');

const FUND_LIST = [
  { code: '019018', name: '易方达信息产业混合C', role: 'growth' },
  { code: '021277', name: '广发全球精选股票(QDII)C', role: 'global' },
  { code: '014419', name: '西部利得CES半导体芯片行业指数增强C', role: 'growth' },
  { code: '027495', name: '易方达中证电池主题ETF联接C', role: 'growth' },
  { code: '012718', name: '易方达中证科技50ETF联接C', role: 'growth' },
  { code: '007028', name: '易方达沪深300ETF联接C', role: 'value' },
  { code: '014418', name: '博时黄金ETF联接C', role: 'defense' },
];

const CACHE_DIR = path.join(__dirname, 'cache');
const OUT = path.join(CACHE_DIR, 'backtest_history.json');

function fetchFundHistory(code, days = 120) {
  return new Promise((resolve) => {
    const pageSize = Math.min(days, 120);
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=${pageSize}`;
    const https = require('https');
    const req = https.get(url, {
      headers: { 'Referer': 'https://fundf10.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
      timeout: 12000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          const list = json?.Data?.LSJZList || [];
          const rows = list.map(r => ({
            date: r.FSRQ,
            nav: parseFloat(r.DWJZ),
            changePct: r.JZZZL === '' ? 0 : parseFloat(r.JZZZL),
          })).filter(r => !isNaN(r.nav) && r.date);
          // 按日期升序
          rows.sort((a, b) => a.date.localeCompare(b.date));
          resolve(rows);
        } catch (e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(12000, () => { req.destroy(); resolve([]); });
  });
}

async function main() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const result = { fetchedAt: new Date().toISOString(), funds: {} };
  for (const f of FUND_LIST) {
    process.stdout.write(`抓取 ${f.code} ${f.name} ... `);
    const hist = await fetchFundHistory(f.code, 120);
    if (hist.length > 0) {
      result.funds[f.code] = { name: f.name, role: f.role, history: hist };
      console.log(`✅ ${hist.length}条 (${hist[0].date} ~ ${hist[hist.length-1].date})`);
    } else {
      console.log(`❌ 失败`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`\n💾 已保存到 ${OUT}`);
  console.log(`可用基金: ${Object.keys(result.funds).length}/${FUND_LIST.length}`);
}

main();
