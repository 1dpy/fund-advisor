/**
 * verify_pool.js — 验证 PREFERRED_SECTORS 候选池代码是否都能被项目数据源抓到
 *   对每只基金: 抓盘中估值(fetchLiveEstimate) + 历史净值(fetchNavHistory)
 *   输出每只状态 + 汇总(估值可用数/净值可用数/废项数)
 *
 * 用法: node scripts/verify_pool.js
 */
const { PREFERRED_SECTORS } = require('../src/config');
const { fetchLiveEstimate } = require('../src/realtime_quotes');
const { fetchNavHistory } = require('../src/ml_sector_selector');

(async () => {
  console.log(`🔍 开始验证 ${PREFERRED_SECTORS.length} 只候选基金代码...\n`);
  let estOk = 0, navOk = 0, bothFail = 0;
  const fails = [];
  let i = 0;
  for (const s of PREFERRED_SECTORS) {
    i++;
    const est = await fetchLiveEstimate(s.code).catch(() => null);
    const navs = await fetchNavHistory(s.code, 12, true).catch(() => []);
    const e = !!(est && est.changePct != null);
    const n = !!(navs && navs.length);
    if (e) estOk++;
    if (n) navOk++;
    if (!e && !n) { bothFail++; fails.push(`${s.code} ${s.name} [${s.sector}]`); }
    console.log(`${String(i).padStart(2)}/${PREFERRED_SECTORS.length}  ${e ? '估✓' : '估✗'} ${n ? '净✓' : '净✗'}  ${s.code}  ${s.name} [${s.sector}]`);
  }
  console.log('\n========== 汇总 ==========');
  console.log(`候选池总数: ${PREFERRED_SECTORS.length}`);
  console.log(`估值可用(同花顺/东财): ${estOk}`);
  console.log(`净值可用(东财lsjz):     ${navOk}`);
  console.log(`两者皆无(废项):         ${bothFail}`);
  if (fails.length) {
    console.log('\n⚠️ 废项清单(抓不到数据, 会自动沉底, 建议替换):');
    console.log(fails.join('\n'));
  } else {
    console.log('\n✅ 全部代码可被数据源抓取, 无废项!');
  }
})();
