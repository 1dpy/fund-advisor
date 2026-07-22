/**
 * V4 纯操作指令报告器
 *
 * 输出格式: 只有具体操作, 无分析
 * 格式: 操作类型 | 基金代码 | 基金名称 | 金额/份额 | 时间 | 紧急度
 */

const chalk = require('chalk');

// 市场情绪面板数据 (恐慌贪婪指数) — 纯文本行, 供 formatOperations / printOperations 复用
function sentimentLines(s) {
  if (!s || typeof s.score !== 'number') return [];
  const sub = s.subIndicators || {};
  const score = s.score;
  const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const arr = [];
  arr.push(`  恐慌贪婪指数: ${score}/100  [${s.labelCN || '未知'}]  ${bar}`);
  arr.push(`  子指标  宽度:${sub.breadth ?? '-'}  趋势:${sub.trend ?? '-'}  北向:${sub.northFlow ?? '-'}  量能:${sub.volume ?? '-'}`);
  if (s.advice) arr.push(`  交易倾向  ${s.advice}`);
  return arr;
}

function formatOperations(decisions) {
  const ops = decisions.operations;
  const lines = [];

  // 市场情绪面板
  lines.push('════ 市场情绪 · 恐慌贪婪指数 ════');
  lines.push(...sentimentLines(decisions.marketSentiment));
  lines.push('');

  lines.push('================================');
  lines.push(`  ${decisions.date}`);
  lines.push(`  T+1: ${decisions.t1Info?.description || ''}`);
  lines.push('================================');
  lines.push('');

  let hasAction = false;

  // 卖出
  if (ops.sells.length > 0) {
    hasAction = true;
    for (const o of ops.sells) {
      lines.push(`🔴 卖出  ${o.code}  ${o.name}`);
      lines.push(`   全部 ${o.shares} 份  约 ¥${o.amount.toFixed(0)}`);
      lines.push(`   ${o.reason}  [${o.urgency}]`);
      lines.push('');
    }
  }

  // 部分卖出
  if (ops.partialSells.length > 0) {
    hasAction = true;
    for (const o of ops.partialSells) {
      lines.push(`🟡 部分卖  ${o.code}  ${o.name}`);
      lines.push(`   卖 ${o.sellPct}%  ${o.shares} 份  约 ¥${o.amount.toFixed(0)}`);
      lines.push(`   ${o.reason}  [${o.urgency}]`);
      lines.push('');
    }
  }

  // 转换
  if (ops.swaps.length > 0) {
    hasAction = true;
    for (const o of ops.swaps) {
      lines.push(`🔄 转换  ${o.sellCode}→${o.buyCode}`);
      lines.push(`   ${o.sellName} → ${o.buyName}`);
      lines.push(`   约 ¥${o.sellValue.toFixed(0)}  [${o.urgency}]`);
      lines.push('');
    }
  }

  // 买入
  if (ops.buys.length > 0) {
    hasAction = true;
    for (const o of ops.buys) {
      lines.push(`🟢 买入  ${o.code}  ${o.name}`);
      lines.push(`   ¥${o.amount.toFixed(0)}  ${o.shares}份  ${o.mlSignal}`);
      lines.push(`   ${o.reason}  [${o.urgency}]`);
      lines.push('');
    }
  }

  // 加仓
  if (ops.addPositions.length > 0) {
    hasAction = true;
    for (const o of ops.addPositions) {
      lines.push(`⬆️ 加仓  ${o.code}  ${o.name}`);
      lines.push(`   ¥${o.amount.toFixed(0)}  ${o.shares}份`);
      lines.push(`   ${o.reason}  [${o.urgency}]`);
      lines.push('');
    }
  }

  // 减仓
  if (ops.reduces.length > 0) {
    hasAction = true;
    for (const o of ops.reduces) {
      lines.push(`⬇️ 减仓  ${o.code}  ${o.name}`);
      lines.push(`   减${o.reducePct}%  ${o.shares}份  约 ¥${o.amount.toFixed(0)}`);
      lines.push(`   ${o.reason}  [${o.urgency}]`);
      lines.push('');
    }
  }

  // 持有
  if (ops.holds.length > 0) {
    if (hasAction) lines.push('---');
    for (const o of ops.holds) {
      lines.push(`⚪ 持有  ${o.code}  ${o.name}  ${o.reason}`);
    }
  }

  if (!hasAction && ops.holds.length === 0) {
    lines.push('⚪ 今日无操作');
  }

  lines.push('');
  lines.push('================================');
  lines.push(`  操作: 卖${ops.sells.length} 部分卖${ops.partialSells.length} 买${ops.buys.length} 转换${ops.swaps.length} 加仓${ops.addPositions.length} 减仓${ops.reduces.length} 持有${ops.holds.length}`);
  lines.push(`  支付宝C类0申购费  15:00前下单按当日净值`);
  lines.push('================================');

  return lines.join('\n');
}

/**
 * 控制台彩色输出
 */
function printOperations(decisions) {
  const ops = decisions.operations;
  const s = decisions.summary;

  console.log('\n' + chalk.bold.cyan('════════════════════════════════════════'));
  console.log(chalk.bold.cyan(`  ${decisions.date}`));
  console.log(chalk.bold.cyan(`  T+1: ${decisions.t1Info?.description || ''}`));
  console.log(chalk.bold.cyan('════════════════════════════════════════\n'));

  // 市场情绪面板 (彩色)
  const ms = decisions.marketSentiment;
  if (ms && typeof ms.score === 'number') {
    const lvl = ms.level || (ms.score >= 55 ? 'greed' : ms.score < 45 ? 'fear' : 'neutral');
    const c = lvl === 'fear' ? chalk.red : lvl === 'greed' ? chalk.yellow : chalk.gray;
    console.log(chalk.bold.cyan('════ 市场情绪 · 恐慌贪婪指数 ════'));
    for (const line of sentimentLines(ms)) console.log(c(line));
    console.log('');
  }

  let hasAction = false;

  for (const o of ops.sells) {
    hasAction = true;
    console.log(chalk.bold.red(`🔴 卖出  ${o.code}  ${o.name}`));
    console.log(chalk.red(`   全部 ${o.shares} 份  约 ¥${o.amount.toFixed(0)}  ${o.reason}`));
    console.log('');
  }

  for (const o of ops.partialSells) {
    hasAction = true;
    console.log(chalk.bold.yellow(`🟡 部分卖  ${o.code}  ${o.name}`));
    console.log(chalk.yellow(`   卖${o.sellPct}%  ${o.shares}份  约 ¥${o.amount.toFixed(0)}  ${o.reason}`));
    console.log('');
  }

  for (const o of ops.swaps) {
    hasAction = true;
    console.log(chalk.bold.magenta(`🔄 转换  ${o.sellCode}→${o.buyCode}`));
    console.log(chalk.magenta(`   ${o.sellName} → ${o.buyName}  约¥${o.sellValue.toFixed(0)}`));
    console.log('');
  }

  for (const o of ops.buys) {
    hasAction = true;
    console.log(chalk.bold.green(`🟢 买入  ${o.code}  ${o.name}`));
    console.log(chalk.green(`   ¥${o.amount.toFixed(0)}  ${o.shares}份  ${o.mlSignal}`));
    console.log(chalk.green(`   ${o.reason}`));
    console.log('');
  }

  for (const o of ops.addPositions) {
    hasAction = true;
    console.log(chalk.bold.blue(`⬆️ 加仓  ${o.code}  ${o.name}`));
    console.log(chalk.blue(`   ¥${o.amount.toFixed(0)}  ${o.shares}份  ${o.reason}`));
    console.log('');
  }

  for (const o of ops.reduces) {
    hasAction = true;
    console.log(chalk.bold.gray(`⬇️ 减仓  ${o.code}  ${o.name}`));
    console.log(chalk.gray(`   减${o.reducePct}%  ${o.shares}份  ${o.reason}`));
    console.log('');
  }

  for (const o of ops.holds) {
    console.log(chalk.gray(`⚪ 持有  ${o.code}  ${o.name}  ${o.reason}`));
  }

  if (!hasAction && ops.holds.length === 0) {
    console.log(chalk.gray('  今日无操作'));
  }

  console.log('\n' + chalk.bold.cyan('════════════════════════════════════════'));
  console.log(chalk.cyan(`  操作: 卖${s.sell} 部分卖${s.partialSell} 买${s.buy} 转换${s.swap} 加仓${s.addPosition} 减仓${s.reduce} 持有${s.hold}`));
  console.log(chalk.cyan('  支付宝C类0申购费  15:00前下单按当日净值'));
  console.log(chalk.bold.cyan('════════════════════════════════════════\n'));
}

module.exports = { formatOperations, printOperations };
