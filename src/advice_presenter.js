/**
 * 操作建议展示层 — 终端打印 + 钉钉 Markdown 格式化
 *
 * 从 main.js 抽出: 入口只负责编排, 展示细节收敛在此。
 * 纯输出逻辑, 不参与决策; 入参统一为 advisor 产出的 advice 对象。
 */
const { isTradingDay, nextTradingDay } = require('./t1_calendar');

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function formatTradingDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${WEEKDAY_CN[d.getDay()]}`;
}

// 交易日判定统一走 t1_calendar(含 2026 节假日表与周末补班表), 不再在各展示函数里手写推算
function buildOperationHint(now = new Date()) {
  if (!isTradingDay(now)) {
    return `今日非交易日, 最早可操作日期: ${formatTradingDay(nextTradingDay(now))} 15:00前`;
  }
  if (now.getHours() >= 15) {
    const hhmm = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
    return `今日已收盘(${hhmm}), 最早可操作日期: ${formatTradingDay(nextTradingDay(now))} 15:00前`;
  }
  const minsLeft = (15 - now.getHours()) * 60 - now.getMinutes();
  return `今日交易日进行中, 距15:00收盘还有 ${minsLeft} 分钟, 请尽快操作`;
}

function printUltimateAdvice(advice) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  基金助手·终极版 V5 每日操作指令');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  日期: ${advice.date}`);
  if (advice.message) {
    console.log(`  状态: ${advice.message}\n`);
    return;
  }
  console.log(`  市场体制: ${advice.regime} (置信${advice.regimeConfidence}%)`);
  if (advice.strategy) console.log(`  策略模式: ${advice.strategy === 'PROFIT_FIRST' ? '赚钱优先 (PROFIT_FIRST)' : advice.strategy}`);
  if (advice.marketSentiment) {
    const ms = advice.marketSentiment;
    console.log(`  市场情绪: ${ms.labelCN} (恐慌贪婪指数 ${ms.score}/100) [${ms.tradingBias}]`);
    console.log(`  情绪建议: ${ms.advice}`);
  }
  console.log(`  总资产: ¥${advice.totalAsset.toFixed(2)}`);
  console.log(`  可用现金: ¥${advice.cash.toFixed(2)}`);
  console.log(`  科技集中度: ${(advice.techConcentration * 100).toFixed(1)}% (上限50%)`);
  console.log(`  最大单只仓位: ${(advice.maxSingleWeight * 100).toFixed(1)}% (上限20%)`);
  const opHint = buildOperationHint(new Date());
  console.log(`\n  T+1 / 周末规则:`);
  console.log(`    - 场外基金交易日 15:00 前下单, 按当日净值 T+1 确认`);
  console.log(`    - 周六/周日/节假日不交易, 下个交易日才能操作`);
  console.log(`    - ${opHint}`);

  console.log('\n  当前配置 vs 目标:');
  for (const k of Object.keys(advice.sectorWeights)) {
    const cur = (advice.sectorWeights[k] * 100).toFixed(1);
    const tgt = ((advice.targetWeights[k] || 0) * 100).toFixed(0);
    console.log(`    ${k.padEnd(8)} 当前 ${cur.padStart(5)}%  目标 ${tgt.padStart(5)}%`);
  }
  console.log('\n  今日操作清单:');
  if (advice.operations.length === 0) {
    console.log('    无');
  } else {
    let idx = 1;
    for (const op of advice.operations) {
      const amount = op.amount ? ` ¥${op.amount.toFixed(2)}` : '';
      const target = op.target ? ` → ${op.target}` : '';
      const codeTag = (op.code && op.code !== 'CASH') ? `(${op.code})` : '';
      console.log(`    ${idx}. [${op.action}] ${op.name}${codeTag}${amount}${target}`);
      console.log(`       原因: ${op.reason}`);
      console.log(`       紧急度: ${op.urgency || 'LOW'}`);
      idx++;
    }
  }
  console.log('═══════════════════════════════════════════════════\n');
}

// V5 钉钉推送专用格式化 — 纯操作指令, 看到就能在支付宝执行
function formatDingtalkUltimate(advice) {
  if (advice.message) {
    return `## 📋 基金助手·终极版 V5\n\n> ${advice.date} ${advice.message}`;
  }
  const lines = [];
  lines.push(`## 📋 基金操作指令 V5 ${advice.date}`);
  lines.push('');
  lines.push(`**体制**: ${advice.regime} (置信${advice.regimeConfidence}%)`);
  lines.push(`**策略**: ${advice.strategy === 'PROFIT_FIRST' ? '赚钱优先' : (advice.strategy || 'CONSERVATIVE')}`);
  lines.push(`**总资产**: ¥${advice.totalAsset.toFixed(0)} | **现金**: ¥${advice.cash.toFixed(0)}`);
  lines.push(`**科技集中度**: ${(advice.techConcentration*100).toFixed(0)}% (上限50%) | **最大单票**: ${(advice.maxSingleWeight*100).toFixed(0)}%`);
  lines.push('');
  lines.push('**配置 vs 目标:**');
  for (const k of Object.keys(advice.sectorWeights)) {
    const cur = (advice.sectorWeights[k]*100).toFixed(0);
    const tgt = ((advice.targetWeights[k]||0)*100).toFixed(0);
    lines.push(`> ${k}: ${cur}% → ${tgt}%`);
  }
  lines.push('');
  lines.push('**今日操作:**');
  let i = 1;
  for (const op of advice.operations) {
    const amt = op.amount ? ` ¥${op.amount}` : '';
    const tgt = op.target ? ` → ${op.target}` : '';
    const icon = op.action === 'SELL' ? '🔴' : (op.action === 'CONVERT') ? '🔄' : (op.action === 'BUY' || op.action === 'DCA') ? '🟢' : (op.action === 'PLAN') ? '📌' : '⚪';
    const codeTag = (op.code && op.code !== 'CASH') ? `(${op.code})` : '';
    lines.push(`${i}. ${icon} **[${op.action}] ${op.name}${codeTag}**${amt}${tgt}`);
    lines.push(`> ${op.reason}`);
    i++;
  }
  // 动态选基说明: 让用户一眼看到"今天按实时行情挑了哪几只"
  if (advice.realtimePicks && advice.realtimePicks.length > 0) {
    lines.push('');
    lines.push('**📡 实时行情动态选基 (盘前读取, 挑当日最强):**');
    advice.realtimePicks.forEach((r, idx) => {
      const chg = r.changePct != null ? `实时${r.changePct >= 0 ? '+' : ''}${r.changePct}%` : '实时N/A';
      lines.push(`> ${idx + 1}. ${r.name}(${r.code}) ${r.sector} | ${chg} / 近5日${r.mom5 >= 0 ? '+' : ''}${r.mom5}% | 综合分${r.score}`);
    });
  }
  lines.push('');
  lines.push('⚠️ T+1: 15:00前下单按当日净值, 周末/节假日不交易');
  lines.push('📌 仅供参考, 投资有风险');
  return lines.join('\n');
}

function printAggressiveAdvice(advice) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  基金助手·激进科技增强版 V6 每日操作指令');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  日期: ${advice.date}`);
  if (advice.message) { console.log(`  状态: ${advice.message}\n`); return; }
  console.log(`  模式: ${advice.mode} | 科技趋势强度: ${(advice.techTrendRatio*100).toFixed(0)}%基金在20日均线上方`);
  if (advice.marketSentiment) {
    const ms = advice.marketSentiment;
    console.log(`  市场情绪: ${ms.labelCN} (恐慌贪婪指数 ${ms.score}/100) [${ms.tradingBias}]`);
    console.log(`  情绪建议: ${ms.advice}`);
  }
  console.log(`  总资产: ¥${advice.totalAsset.toFixed(2)} | 可用现金: ¥${advice.cash.toFixed(2)}`);
  console.log(`  科技集中度: ${(advice.techConcentration*100).toFixed(1)}% (激进上限75%) | 最大单票: ${(advice.maxSingleWeight*100).toFixed(1)}%`);
  console.log(`  数据源: ${advice.dataSource}`);
  const opHint = buildOperationHint(new Date());
  console.log(`\n  T+1 / 周末规则:`);
  console.log(`    - 场外基金交易日 15:00 前下单, T+1 确认; 周末/节假日不交易`);
  console.log(`    - ${opHint}`);
  console.log('\n  今日操作清单:');
  if (!advice.operations.length) console.log('    无');
  else { let i=1; for (const op of advice.operations) {
    const amt = op.amount ? ` ¥${op.amount}` : '';
    const tgt = op.target ? ` → ${op.target}` : '';
    console.log(`    ${i}. [${op.action}] ${op.name}${amt}${tgt}`);
    console.log(`       原因: ${op.reason}`);
    console.log(`       紧急度: ${op.urgency||'LOW'}`);
    i++;
  }}
  console.log('═══════════════════════════════════════════════════\n');
}

function formatDingtalkAggressive(advice) {
  if (advice.message) return `## 📋 基金助手·激进科技版 V6\n\n> ${advice.date} ${advice.message}`;
  const lines = [];
  lines.push(`## 📋 基金操作指令 V6激进版 ${advice.date}`);
  lines.push('');
  lines.push(`**模式**: ${advice.mode} | 科技趋势: ${(advice.techTrendRatio*100).toFixed(0)}%在均线上方`);
  lines.push(`**总资产**: ¥${advice.totalAsset.toFixed(0)} | **现金**: ¥${advice.cash.toFixed(0)}`);
  lines.push(`**科技集中度**: ${(advice.techConcentration*100).toFixed(0)}% | **最大单票**: ${(advice.maxSingleWeight*100).toFixed(0)}%`);
  lines.push(`**数据**: ${advice.dataSource}`);
  lines.push('');
  lines.push('**今日操作:**');
  let i=1;
  for (const op of advice.operations) {
    const amt = op.amount ? ` ¥${op.amount}` : '';
    const tgt = op.target ? ` → ${op.target}` : '';
    const icon = op.action==='SELL'?'🔴':op.action==='CONVERT'?'🔄':(op.action==='BUY'||op.action==='DCA')?'🟢':'⚪';
    lines.push(`${i}. ${icon} **[${op.action}] ${op.name}**${amt}${tgt}`);
    lines.push(`> ${op.reason}`);
    i++;
  }
  lines.push('');
  lines.push('⚠️ T+1: 15:00前下单, 周末不交易 | 激进策略风险大, 严守止损');
  return lines.join('\n');
}

module.exports = {
  buildOperationHint,
  printUltimateAdvice,
  formatDingtalkUltimate,
  printAggressiveAdvice,
  formatDingtalkAggressive,
};
