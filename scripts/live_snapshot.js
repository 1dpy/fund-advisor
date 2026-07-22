/**
 * scripts/live_snapshot.js
 * --------------------------------------------------------------------------
 * 【本机桥接脚本】作用：让你的机器抓取同花顺/东财 基金盘中估值(实时)，
 * 写入 data/live_snapshot.json，供 agent(沙箱)读取分析。
 *
 * 为什么需要它：
 *   agent 的沙箱网络出口被限制，直连同花顺/东财估值接口会失败(空响应/302)；
 *   而你的本机有公网，能直连。所以"你本机抓 → 写文件 → agent 读"是
 *   让 agent 拿到同花顺实时数据的唯一稳定通道(westock 只能给 ETF/股票成交价,
 *   给不了场外 C 类基金盘中估值)。
 *
 * 用法(在你本机终端，项目根目录)：
 *   npm run live                 # 抓一次同花顺实时估值并写盘
 *   node scripts/live_snapshot.js
 * 然后告诉 agent："我跑完 live 了"，agent 会读 data/live_snapshot.json 分析。
 *
 * 输出：data/live_snapshot.json (已被 .gitignore 忽略, 不入库)
 *   { asOf, note, estimates:[{code,name,sector,thChangePct,gztime,source,score}], top:[前10] }
 * --------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const { fetchRealtimeSectorScores, fetchLiveEstimate } = require('../src/realtime_quotes');
const { PREFERRED_SECTORS } = require('../src/config');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'live_snapshot.json');

(async () => {
  // 1) 同花顺/东财 基金盘中估值 (用户要的"同花顺实时数据"), 逐只抓取
  const estimates = [];
  for (const s of PREFERRED_SECTORS) {
    const est = await fetchLiveEstimate(s.code).catch(() => null);
    estimates.push({
      code: s.code,
      name: s.name,
      sector: s.sector,
      thChangePct: est ? est.changePct : null,   // 同花顺盘中估值涨跌幅(%)
      gztime: est ? est.gztime : null,            // 估值计算时间戳
      source: est ? est.source : 'fail',          // '10jqka' | 'eastmoney' | 'fail'
    });
  }

  // 2) 综合赛道分(ETF实时优先) 仅作对照, 挂到每只上
  const scores = await fetchRealtimeSectorScores({ days: 12, delayMs: 60 }).catch(() => []);
  const scoreMap = {};
  scores.forEach((x) => { scoreMap[x.code] = x; });

  estimates.forEach((e) => { e.score = scoreMap[e.code] ? scoreMap[e.code].score : null; });
  estimates.sort((a, b) => (b.thChangePct != null ? b.thChangePct : -999) - (a.thChangePct != null ? a.thChangePct : -999));

  const payload = {
    asOf: new Date().toISOString(),
    note: '同花顺/东财 基金盘中估值快照(场外C类), 由用户本机抓取写盘, agent沙箱读取',
    total: estimates.length,
    estimates,
    top: estimates.slice(0, 10),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');

  const ok = estimates.filter((e) => e.thChangePct != null).length;
  console.log('✅ 已写入', OUT);
  console.log(`   同花顺估值成功 ${ok}/${estimates.length} 只`);
  console.log('   Top1:', estimates[0].name, estimates[0].thChangePct != null ? estimates[0].thChangePct + '%' : '(N/A)', '| 时间', estimates[0].gztime || '-');
})().catch((e) => { console.error('❌ 抓取失败:', e.message); process.exit(1); });
