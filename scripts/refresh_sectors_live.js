/**
 * refresh_sectors_live.js — 抓 82 只真实 ETF 行情生成快照
 * ---------------------------------------------------------------
 * 设计: 只抓腾讯 qt.gtimg.cn (本机通, 批量秒级), 拿 ETF 实时成交价,
 *       按赛道组装 sectors。不抓同花顺/东财 (本机不通, 逐只超时太慢)。
 *       不动 realtime_quotes.js 算法, 本脚本自己抓 (数据准备脚本)。
 *
 * 用法(本机计划任务 FundSnapshotRefresh 每日14:30跑):
 *   node scripts/refresh_sectors_live.js
 * 产物: dashboard/api/sectors.json (真实ETF行情) + meta.json
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { PREFERRED_SECTORS } = require('../src/config');

// 赛道→场内ETF (复制自 realtime_quotes 的 SECTOR_ETF_MAP, 避免改算法文件)
const SECTOR_ETF_MAP = {
  '半导体': ['sh512480'], '科创': ['sh588000'], '人工智能': ['sh515980'], '5G通信': ['sh515050'],
  '云计算': ['sh516510'], '恒生科技': ['sh513180'], '数字经济': ['sh560800'], '新能源': ['sh516160'],
  '光伏': ['sh515790'], '智能汽车': ['sh515250'], '军工': ['sh512660'], '游戏': ['sh159869'],
  '有色': ['sh512400'], '稀土': ['sh516780'], '券商': ['sh512000'],
  '新能源电池': ['sh516160'], '恒生医疗': ['sz159303'], '医药': ['sh512010'], '医疗': ['sh512170'],
  '创新药': ['sh515120'], '煤炭': ['sh515220'], '食品饮料': ['sh515170'], '银行': ['sh512800'],
  '黄金': ['sh518880'], '纳指': ['sh513390'], '标普500': ['sh513500'], '沪深300': ['sh510300'],
  '创业板': ['sh159915'], '中证500': ['sh510500'], '中证1000': ['sh512100'], '上证50': ['sh510050'],
  '科创创业50': ['sh588360'], '红利低波': ['sz159525'], '央企红利': ['sz159332'],
  '自由现金流': ['sh563990'], '交通运输': ['sz159662'],
};

function httpGet(url) {
  return new Promise((resolve) => {
    const r = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    r.on('error', () => resolve(''));
    r.setTimeout(15000, () => { r.destroy(); resolve(''); });
  });
}

// 批量抓 ETF 行情 (腾讯 qt, 一次请求)
async function fetchEtfQuotes(codes) {
  const map = {};
  if (!codes.length) return map;
  const body = await httpGet(`https://qt.gtimg.cn/q=${codes.join(',')}`);
  const re = /v_(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(body))) {
    const f = m[2].split('~');
    const price = parseFloat(f[3]);
    const prev = parseFloat(f[4]);
    if (!isNaN(price) && !isNaN(prev) && prev > 0) {
      map[m[1]] = { price, prevClose: prev, changePct: Math.round((price / prev - 1) * 10000) / 100, name: f[1] || m[1] };
    }
  }
  return map;
}

(async () => {
  const allEtfs = [...new Set(Object.values(SECTOR_ETF_MAP).flat())];
  console.log(`🌐 抓取 ${allEtfs.length} 只场内 ETF 行情 (腾讯 qt 批量)...`);
  const t0 = Date.now();
  const quotes = await fetchEtfQuotes(allEtfs);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`   拿到 ${Object.keys(quotes).length}/${allEtfs.length} 只 ETF (耗时 ${dt}s)\n`);

  const scores = PREFERRED_SECTORS.map((s) => {
    const etfs = SECTOR_ETF_MAP[s.sector] || [];
    const vals = etfs.map((c) => quotes[c]).filter(Boolean);
    const etfChange = vals.length ? Math.round(vals.reduce((a, b) => a + b.changePct, 0) / vals.length * 100) / 100 : null;
    const etfName = vals.length ? vals[0].name : '';
    const score = etfChange != null ? etfChange : -999;
    return {
      code: s.code, name: s.name, sector: s.sector, maxWeight: s.maxWeight || 0,
      changePct: etfChange, gztime: etfChange != null ? 'etf-realtime' : '',
      etfName, mom5: 0, maTrend: 0,
      score: Math.round(score * 100) / 100,
      dataSource: etfChange != null ? 'etf' : 'none',
    };
  });
  scores.sort((a, b) => b.score - a.score);

  const hasReal = scores.some((a) => a.score > -999);
  const etfCnt = scores.filter((a) => a.dataSource === 'etf').length;
  const dataSource = !hasReal
    ? 'synthetic (腾讯qt也未返回, 检查网络)'
    : `live (ETF实时成交价, ${etfCnt}/${scores.length}只有数据, ${scores.length - etfCnt}只无ETF映射用-999)`;

  const out = {
    asOf: new Date().toISOString().slice(0, 10),
    mode: 'live', dataSource, total: scores.length,
    top: scores.slice(0, 10), all: scores,
  };

  const apiDir = path.join(__dirname, '..', 'dashboard', 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  fs.writeFileSync(path.join(apiDir, 'sectors.json'), JSON.stringify(out));

  // 更新 meta
  const metaPath = path.join(apiDir, 'meta.json');
  let m = {};
  try { m = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
  m.generatedAt = new Date().toISOString();
  m.mode = 'live(真实ETF行情快照)';
  m.note = `sectors=真实ETF实时成交价(腾讯qt, ${etfCnt}/${scores.length}只有数据); 其他标签=离线合成; 非持续刷新, 重跑本脚本更新`;
  fs.writeFileSync(metaPath, JSON.stringify(m, null, 2));

  console.log(`✅ 完成!`);
  console.log(`   dataSource=${dataSource}`);
  console.log(`   total=${scores.length} top=${out.top.length}`);
  if (out.top.length) {
    console.log('   前5: ' + out.top.slice(0, 5).map((t) => `${t.name}[${t.sector}] ${t.changePct == null ? 'null' : ((t.changePct >= 0 ? '+' : '') + t.changePct + '%')}`).join('  '));
  }
  console.log('\n👉 回 AI 对话, 让它部署到云端');
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
