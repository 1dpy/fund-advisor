// test/dashboard_load.js
// 仪表盘模块加载 + 离线数据 API 冒烟测试
// 由 .github/workflows/ci.yml 第 5x 步调用
// 用法: node test/dashboard_load.js
const s = require('../dashboard_server');

(async () => {
  const [portfolio, factors, backtest, selfIter, sectors] = await Promise.all([
    s.portfolioData(),
    s.factorsData('demo'),
    s.backtestData('demo'),
    s.selfIterateData('demo'),
    s.sectorsData('demo'),
  ]);
  const msg = `OK dashboard_data: portfolio=${portfolio && portfolio.holdings ? portfolio.holdings.length : 0} factors=${factors.universe.length} strategies=${backtest.strategies.length} folds=${selfIter.folds ? selfIter.folds.length : '-'} sectorsTop=${sectors.top.length}/${sectors.total}`;
  console.log(msg);
})().catch((e) => {
  console.error('FAIL dashboard_load:', e && e.message ? e.message : e);
  process.exit(1);
});
