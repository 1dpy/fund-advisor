/**
 * 钉钉推送 V3 — 全交易类型 + ML信号
 */

const axios = require('axios');
// ⚠️ 安全: webhook 必须从环境变量读取, 切勿硬编码 token 提交到仓库
const WEBHOOK = process.env.DINGTALK_WEBHOOK || '';

async function sendMarkdown(title, text) {
  if (!WEBHOOK) {
    console.warn('⚠️ 未配置 DINGTALK_WEBHOOK 环境变量, 跳过钉钉推送。');
    return false;
  }
  try {
    await axios.post(WEBHOOK, { msgtype: 'markdown', markdown: { title, text } }, { timeout: 10000 });
    return true;
  } catch (e) { return false; }
}

function formatDingtalkReportV3(decisions) {
  const lines = [];

  // 标题
  lines.push(`## 📈 基金日报V3 ${new Date().toLocaleDateString('zh-CN')}`);
  lines.push('');

  // 市场概览
  lines.push(`**市场**: ${decisions.marketRegime?.regime || '?'} | 温度:${decisions.marketTemp}°`);
  if (decisions.usImpact?.available) {
    lines.push(`**美股**: ${decisions.usImpact.sentiment}${decisions.usImpact.vix ? ` | VIX:${decisions.usImpact.vix.price}` : ''}`);
  }
  if (decisions.mlEnsemble?.ensembleSignal) {
    lines.push(`**ML**: ${decisions.mlEnsemble.ensembleSignal.overall} (多${decisions.mlEnsemble.ensembleSignal.bullishRatio}%/空${decisions.mlEnsemble.ensembleSignal.bearishRatio}%)`);
  }
  if (decisions.t1Timeline) {
    lines.push(`**T+1**: ${decisions.t1Timeline.description}`);
  }
  lines.push('');

  // 卖出
  for (const o of decisions.sellOrders) {
    lines.push(`🔴 **卖出** ${(o.name||'').substring(0,12)} ${o.code}`);
    lines.push(`  ${o.shares}份 ¥${o.value.toFixed(0)} 盈亏${o.profitPct} ${o.holdingDays}天`);
    lines.push(`  原因: ${o.reason}`);
  }

  // 部分卖出
  for (const o of decisions.partialSells) {
    lines.push(`🟡 **部分卖${o.sellPct}%** ${(o.name||'').substring(0,12)} ${o.code}`);
    lines.push(`  ${o.shares}份 ¥${o.value.toFixed(0)} →剩余${o.remainingShares}份`);
    lines.push(`  原因: ${o.reason}`);
  }

  // 转换
  for (const sp of decisions.swapPlans) {
    lines.push(`🔄 **转换** ${(sp.sellName||'').substring(0,10)}→${(sp.buyName||'').substring(0,12)}`);
    lines.push(`  卖¥${sp.sellValue.toFixed(0)}[${sp.sellScore}分] 买¥${sp.buyAmount.toFixed(0)}[${sp.buyScore}分]`);
  }

  // 部分转换
  for (const sp of decisions.partialSwaps) {
    lines.push(`🔄 **部分转换${sp.swapPct}%** ${(sp.sellName||'').substring(0,10)}→${(sp.buyName||'').substring(0,12)}`);
    lines.push(`  ¥${sp.sellValue.toFixed(0)}→${sp.buyName?.substring(0,10)} ¥${sp.buyAmount.toFixed(0)}`);
  }

  // 买入
  for (const o of decisions.buyOrders) {
    lines.push(`🟢 **买入** ${(o.name||'').substring(0,14)} ${o.code}`);
    lines.push(`  ¥${o.amount.toFixed(0)} ${o.score}分 ${o.mlSignal ? `[${o.mlSignal}]` : ''}`);
    lines.push(`  ${o.reason}`);
  }

  // 加仓
  for (const o of decisions.addPositions) {
    lines.push(`⬆️ **加仓** ${(o.name||'').substring(0,14)} ${o.code}`);
    lines.push(`  ¥${o.amount.toFixed(0)} 跌${o.changePct.toFixed(1)}% ${o.mlSignal ? `[${o.mlSignal}]` : ''}`);
  }

  // 减仓
  for (const o of decisions.reducePositions) {
    lines.push(`⬇️ **减仓${o.reducePct}%** ${(o.name||'').substring(0,12)} ${o.code}`);
    lines.push(`  ¥${o.value.toFixed(0)} ${o.reason}`);
  }

  // 定投
  for (const p of decisions.dcaPlans) {
    lines.push(`📅 **定投** ${(p.name||'').substring(0,14)} 每周¥${p.weeklyAmount}`);
  }

  // 持有
  if (decisions.holdAdvices.length > 0) {
    lines.push(`\n**持有**: ${decisions.holdAdvices.map(h => (h.name||'').substring(0,6)).join('、')}`);
  }

  // 风险提示
  if (decisions.riskWarnings.length > 0) {
    lines.push('\n**⚠️风险提示**:');
    for (const w of decisions.riskWarnings.slice(0, 3)) {
      lines.push(`- ${w}`);
    }
  }

  lines.push('\n---');
  lines.push('*支付宝C类0申购费 15:00前按今日净值*');
  lines.push('*ML+技术分析仅供参考 投资需谨慎*');

  return lines.join('\n\n');
}

module.exports = { sendMarkdown, formatDingtalkReportV3 };
