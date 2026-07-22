/**
 * 报告输出模块
 * 生成格式化的投资建议报告
 */

const chalk = require('chalk');

/**
 * 打印完整投资建议报告
 */
function printReport(decisions) {
  printHeader(decisions);
  printMarketOverview(decisions.marketEnv, decisions.northFlow);
  printSellOrders(decisions.sellOrders);
  printBuyOrders(decisions.buyOrders);
  printPortfolioSummary(decisions);
  printDisclaimer();
}

function printHeader(decisions) {
  console.log('');
  console.log(chalk.bold.cyan('╔══════════════════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║         📈 A股基金智能投资决策系统                    ║'));
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════╝'));
  console.log(chalk.gray(`  数据时间: ${decisions.date}`));
  console.log(chalk.gray(`  可用资金: ¥${decisions.budget.toLocaleString()}`));
  console.log('');
}

function printMarketOverview(market, northFlow) {
  console.log(chalk.bold.yellow('━━━ 📊 市场全景 ━━━'));

  // 市场情绪
  const sentimentColors = {
    'BULLISH': chalk.green,
    'SLIGHTLY_BULLISH': chalk.green,
    'NEUTRAL': chalk.yellow,
    'SLIGHTLY_BEARISH': chalk.red,
    'BEARISH': chalk.red,
  };
  const sentimentLabels = {
    'BULLISH': '🟢 乐观',
    'SLIGHTLY_BULLISH': '🟡 偏乐观',
    'NEUTRAL': '⚪ 中性',
    'SLIGHTLY_BEARISH': '🟠 偏悲观',
    'BEARISH': '🔴 悲观',
  };

  const colorFn = sentimentColors[market.sentiment] || chalk.white;
  console.log(`  市场情绪: ${colorFn(sentimentLabels[market.sentiment] || market.sentiment)} (${market.score}分)`);
  console.log(`  判断依据: ${market.description}`);

  // 指数行情
  if (market.indexes && market.indexes.length > 0) {
    console.log('');
    console.log('  主要指数:');
    for (const idx of market.indexes) {
      const pct = idx.changePct;
      const arrow = pct > 0 ? '↑' : pct < 0 ? '↓' : '→';
      const color = pct > 0 ? chalk.red : pct < 0 ? chalk.green : chalk.gray;
      const pctStr = (pct > 0 ? '+' : '') + pct.toFixed(2) + '%';
      console.log(`    ${idx.name.padEnd(10)} ${idx.price.toFixed(2).padStart(10)}  ${color(arrow + ' ' + pctStr)}`);
    }
  }

  // 北向资金
  if (northFlow) {
    const flowColor = northFlow.netFlow > 0 ? chalk.red : chalk.green;
    const arrow = northFlow.netFlow > 0 ? '→流入' : '→流出';
    console.log(`  北向资金: ${flowColor(arrow + ' ' + Math.abs(northFlow.netFlow).toFixed(2) + '亿')}`);
  }
  console.log('');
}

function printSellOrders(sellOrders) {
  console.log(chalk.bold.red('━━━ 📤 卖出建议 ━━━'));

  if (sellOrders.length === 0) {
    console.log(chalk.gray('  ✅ 当前持仓无需卖出'));
    console.log('');
    return;
  }

  let totalValue = 0;
  let totalProfit = 0;

  for (const order of sellOrders) {
    const profitColor = order.profit >= 0 ? chalk.red : chalk.green;
    totalValue += order.value;
    totalProfit += order.profit;

    console.log('');
    console.log(chalk.bold(`  ${order.name} (${order.code})`));
    console.log(`  操作: 卖出 ${order.shares} 份 × ¥${order.price.toFixed(3)} = ¥${order.value.toFixed(2)}`);
    if (order.fee > 0) {
      console.log(`  费用: ¥${order.fee.toFixed(2)} | 到账: ¥${order.netValue.toFixed(2)}`);
    }
    console.log(`  成本: ¥${order.costBasis.toFixed(2)} | 盈亏: ${profitColor(order.profitPct + ' (¥' + order.profit.toFixed(2) + ')')}`);
    console.log(`  持有: ${order.holdingDays}天 | 原因: ${chalk.yellow(order.reason)}`);
  }

  console.log('');
  console.log(chalk.bold(`  卖出总计: ¥${totalValue.toFixed(2)} | 盈亏合计: ${totalProfit >= 0 ? chalk.red('+' + totalProfit.toFixed(2)) : chalk.green(totalProfit.toFixed(2))}`));
  console.log('');
}

function printBuyOrders(buyOrders) {
  console.log(chalk.bold.green('━━━ 📥 买入建议 ━━━'));

  if (buyOrders.length === 0) {
    console.log(chalk.gray('  ⏸️  当前暂无合适买入机会, 建议观望'));
    console.log('');
    return;
  }

  let totalAmount = 0;
  let totalFee = 0;

  for (const order of buyOrders) {
    totalAmount += order.amount;
    totalFee += (order.fee || 0);

    console.log('');
    console.log(chalk.bold(`  ${order.name} (${order.code})`));
    const typeLabel = order.type === 'etf' ? 'ETF(场内)' : order.type === 'fund' ? '场外C类(0申购费)' : '场外基金';
    console.log(`  类型: ${typeLabel}`);
    console.log(`  价格: ¥${order.price.toFixed(3)} | 今日涨跌: ${order.changePct > 0 ? chalk.red('+' + order.changePct.toFixed(2) + '%') : chalk.green(order.changePct.toFixed(2) + '%')}`);
    console.log(`  技术评分: ${scoreBar(order.score)} ${order.score}分`);
    console.log(`  信号: ${signalLabel(order.signal)}`);

    if (order.shares) {
      console.log(`  买入: ${order.shares}股 × ¥${order.price.toFixed(3)} = ${chalk.bold.green('¥' + order.amount.toFixed(2))}`);
    } else {
      console.log(`  买入金额: ${chalk.bold.green('¥' + order.amount.toFixed(2))}`);
    }

    // 费用信息
    if (order.fee > 0) {
      const feeRate = (order.fee / order.amount * 100).toFixed(2);
      console.log(`  预估费用: ${chalk.yellow('¥' + order.fee.toFixed(2) + ' (' + feeRate + '%)')}`);
      // 支付宝替代建议
      if (order._altCode) {
        console.log(`  ${chalk.bold.green('📱 支付宝买: ' + order._altName + ' (' + order._altCode + ')')}`);
        console.log(`  ${chalk.bold.green('   同样金额 ¥' + order.amount.toFixed(2) + ' → 0申购费 ✅')}`);
      }
    } else if (order.type === 'fund') {
      console.log(`  费用: ${chalk.green('0申购费 ✅ 可直接在支付宝买')}`);
    }

    console.log(`  理由: ${chalk.cyan(order.reason)}`);
  }

  console.log('');
  const feeStr = totalFee > 0 ? chalk.yellow(` (含费用¥${totalFee.toFixed(2)})`) : chalk.green(' (场外C类0申购费)');
  console.log(chalk.bold.green(`  买入总计: ¥${totalAmount.toFixed(2)}${feeStr} — ${buyOrders.length}只基金`));
  console.log('');
}

function printPortfolioSummary(decisions) {
  console.log(chalk.bold.magenta('━━━ 💼 资产配置概览 ━━━'));

  const sellTotal = decisions.sellOrders.reduce((s, o) => s + o.value, 0);
  const buyTotal = decisions.buyOrders.reduce((s, o) => s + o.amount, 0);
  const holdingsValue = decisions.holdings.reduce((s, h) => s + h.costBasis, 0) - sellTotal;

  console.log(`  当前持仓市值: ¥${holdingsValue.toFixed(2)}`);
  console.log(`  本次买入: ¥${buyTotal.toFixed(2)}`);
  console.log(`  本次卖出: ¥${sellTotal.toFixed(2)}`);
  console.log(`  预计总持仓: ¥${(holdingsValue + buyTotal).toFixed(2)} / ¥${decisions.budget}`);
  console.log(`  仓位比例: ${((holdingsValue + buyTotal) / decisions.budget * 100).toFixed(1)}%`);
  console.log(`  预计剩余现金: ¥${(decisions.budget - holdingsValue - buyTotal + sellTotal).toFixed(2)}`);
}

function printDisclaimer() {
  console.log('');
  console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.yellow('⚠️  免责声明: 本系统基于技术分析生成建议, 仅供参考,'));
  console.log(chalk.yellow('    不构成投资建议。投资有风险, 交易需谨慎。'));
  console.log(chalk.yellow('    过往表现不代表未来收益, 请根据自身风险承受能力决策。'));
  console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');
}

function scoreBar(score) {
  if (score >= 70) return chalk.green('████████');
  if (score >= 55) return chalk.green('██████');
  if (score >= 40) return chalk.yellow('████');
  if (score >= 25) return chalk.red('██');
  return chalk.red('█');
}

function signalLabel(signal) {
  const labels = {
    'STRONG_BUY': chalk.bold.green('★ 强烈买入'),
    'BUY': chalk.green('● 买入'),
    'HOLD': chalk.yellow('— 持有'),
    'WEAK': chalk.red('▼ 弱势'),
    'SELL': chalk.bold.red('✕ 卖出'),
  };
  return labels[signal] || signal;
}

module.exports = { printReport };
