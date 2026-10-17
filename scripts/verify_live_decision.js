/**
 * 只读实盘验证: 用真实 holdings.json + data_cache 里的净值跑一次 V4 决策,
 * 打印结果但不写任何文件。用来确认修复后的引擎在真实数据上的行为。
 *
 * 区别于 test/: 这里不做断言(真实数据会变), 只做人工核对。
 * 用法: node scripts/verify_live_decision.js
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const holdings = JSON.parse(fs.readFileSync(path.join(ROOT, 'holdings.json'), 'utf8'));
const { BUDGET } = require('../src/config');
const { buildBook, profitRatioDetailed, adaptiveStopLoss } = require('../src/portfolio_book');

// 从本地缓存读净值历史(不联网)
function loadHistory(code) {
  const f = path.join(ROOT, 'data_cache', `${code}.json`);
  if (!fs.existsSync(f)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(j) ? j : (j.history || []);
  } catch (e) { return null; }
}

console.log('== 实盘只读核对 ==\n');
const book = buildBook(holdings, BUDGET);
console.log(`预算 ¥${BUDGET}`);
console.log(`持仓市值 ¥${book.fundValue.toFixed(2)} | 现金 ¥${book.cashValue.toFixed(2)}`);
console.log(`可投 ¥${book.deployable.toFixed(2)} (现金条目${book.cashTracked ? '已登记' : '缺失,按预算剩余'})\n`);

console.log('持仓明细:');
for (const h of book.fundHoldings) {
  const hist = loadHistory(h.code) || [];
  const last = hist.length ? hist[hist.length - 1] : null;
  const px = last ? Number(last.nav != null ? last.nav : last.close) : 0;
  const p = profitRatioDetailed(h, px);
  const stop = adaptiveStopLoss(hist, -0.08);
  const flag = p.ratio <= stop ? '  ⚠️ 已击穿止损线' : '';
  console.log(`  ${h.code} ${h.name || ''}`);
  console.log(`     现价 ${px.toFixed(4)} | 盈亏 ${(p.ratio * 100).toFixed(2)}% (口径:${p.source})`);
  console.log(`     自适应止损 ${(stop * 100).toFixed(1)}%${flag}`);
}
console.log('\n(本脚本只读, 不写任何文件)');
