/**
 * 钉钉机器人推送模块
 * 只发操作指令，不废话
 */

const axios = require('axios');

// 安全: webhook 必须从环境变量读取, 切勿硬编码 token 提交到仓库
const WEBHOOK_URL = process.env.DINGTALK_WEBHOOK || '';

async function sendMarkdown(title, text) {
  if (!WEBHOOK_URL) {
    console.warn('⚠️ 未配置 DINGTALK_WEBHOOK 环境变量, 跳过钉钉推送。');
    return false;
  }
  try {
    await axios.post(WEBHOOK_URL, { msgtype: 'markdown', markdown: { title, text } }, { timeout: 10000 });
    return true;
  } catch (e) {
    console.error('钉钉发送失败:', e.message);
    return false;
  }
}

function formatDingtalkReport(decisions, analysisResult) {
  const { marketEnv, holdings, sellOrders, buyOrders } = decisions;
  const lines = [];
  const date = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).split(' ')[0];

  // 标题行: 日期 + 市场一句话
  const labels = { BULLISH: '🟢乐观', SLIGHTLY_BULLISH: '🟡偏乐观', NEUTRAL: '⚪中性', SLIGHTLY_BEARISH: '🟠偏悲观', BEARISH: '🔴悲观' };
  const idxStr = marketEnv.indexes?.map(i => {
    const s = i.changePct > 0 ? '+' : '';
    return `${i.name.replace(/指数|指/g,'')}${s}${i.changePct.toFixed(1)}%`;
  }).join(' ') || '';
  lines.push(`## 📈 基金 ${date}`);
  lines.push(`${labels[marketEnv.sentiment] || marketEnv.sentiment} | ${idxStr}`);
  lines.push('');

  // 持仓 + 指令
  let hasAction = false;

  // 卖出
  if (sellOrders.length > 0) {
    hasAction = true;
    lines.push('### 🔴 卖出');
    for (const o of sellOrders) {
      const name = (o.name || o.code).substring(0, 10);
      lines.push(`- ${name}(${o.code}) 全部卖出 ¥${(o.netValue || o.value).toFixed(0)}`);
      lines.push(`  ${o.reason} | 盈亏${o.profitPct}`);
    }
    lines.push('');
  }

  // 买入
  if (buyOrders.length > 0) {
    hasAction = true;
    lines.push('### 🟢 买入');
    for (const o of buyOrders) {
      const code = o._altCode || o.code;
      const name = (o._altName || o.name).substring(0, 12);
      lines.push(`- ${name} **${code}** 买¥${o.amount.toFixed(0)}`);
    }
    lines.push('');
    lines.push('> 支付宝搜代码，15:00前下单');
    lines.push('');
  }

  // 调仓方案 (满仓换仓)
  const swapPlans = decisions.swapPlans || [];
  if (swapPlans.length > 0) {
    hasAction = true;
    lines.push('### 🔄 调仓换仓');
    for (const sp of swapPlans) {
      lines.push(`**卖出** ${sp.sellName.substring(0,10)}(${sp.sellCode}) ¥${sp.sellValue.toFixed(0)}`);
      if (sp.sellFee > 0) lines.push(`  > 赎回费¥${sp.sellFee.toFixed(1)} | 评分${sp.sellScore}分→${sp.buyScore}分`);
      lines.push(`**买入** ${sp.buyName.substring(0,12)} **${sp.buyCode}** ¥${sp.buyAmount.toFixed(0)}`);
      lines.push(`  > 支付宝搜${sp.buyCode} 15:00前操作 0申购费`);
    }
    lines.push('');
  }

  // 无操作
  if (!hasAction) {
    const invested = holdings.reduce((s, h) => s + (h.costBasis || 0), 0);
    if (invested >= 3950) {
      lines.push('### ✅ 持仓评分健康，继续持有');
    } else {
      lines.push('### ⏸️ 观望，暂无合适机会');
    }
    lines.push('');

    // 持仓速览
    if (holdings.length > 0) {
      lines.push('**你的持仓**:');
      for (const h of holdings) {
        const fund = analysisResult?.rankedFunds?.find(f => f.code === h.code);
        const price = fund?.price || h.buyPrice;
        const pnl = price > 0 && h.buyPrice > 0 ? ((price - h.buyPrice) / h.buyPrice * 100) : 0;
        const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(1) + '%';
        const name = (h.name || h.code).substring(0, 10);
        const score = fund?.score || '?';
        lines.push(`- ${name}(${h.code}) ${score}分 ${pnlStr}`);
      }
      lines.push('');
    }
  }

  // 热门基金 spotlight (Top 5, 排除已持仓)
  const ranked = analysisResult?.rankedFunds || [];
  const hotFunds = ranked.filter(f => f.fundType === 'fund' && f.score >= 55 && f.changePct !== undefined);
  if (hotFunds.length >= 3) {
    const top5 = hotFunds
      .filter(f => !holdings.some(h => h.code === f.code))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    if (top5.length > 0) {
      lines.push('---');
      lines.push('**🔥 热门基金 Top5**');
      for (const f of top5) {
        const name = (f.name || f.code).substring(0, 12);
        const sign = (f.changePct || 0) >= 0 ? '+' : '';
        lines.push(`- ${name}(${f.code}) ${f.score}分 ${sign}${(f.changePct||0).toFixed(1)}%`);
      }
      lines.push('');
    }
  }

  lines.push('> ⚠️ 技术分析仅供参考，投资需谨慎');

  return lines.join('\n');
}

module.exports = { sendMarkdown, formatDingtalkReport };
