const axios = require('axios');
// ⚠️ 安全: webhook 必须从环境变量读取, 切勿硬编码 token 提交到仓库
const WEBHOOK = process.env.DINGTALK_WEBHOOK || '';

async function sendMarkdown(title, text) {
  if (!WEBHOOK) {
    console.warn('⚠️ 未配置 DINGTALK_WEBHOOK 环境变量, 跳过钉钉推送。');
    return false;
  }
  try { await axios.post(WEBHOOK, { msgtype: 'markdown', markdown: { title, text } }, { timeout: 10000 }); return true; }
  catch (e) { return false; }
}

function formatDingtalkReport(decisions) {
  const { sellOrders, buyOrders, swapPlans, rotationSignals } = decisions;
  const lines = [];

  for (const o of sellOrders) {
    lines.push(`卖 ${(o.name||o.code).substring(0,10)} ${o.code} ¥${(o.netValue||o.value).toFixed(0)}`);
  }

  for (const sp of swapPlans) {
    lines.push(`换 ${(sp.sellName||'').substring(0,8)}→${(sp.buyName||'').substring(0,12)} ${sp.buyCode} ¥${sp.buyAmount.toFixed(0)}`);
  }

  for (const o of buyOrders) {
    lines.push(`买 ${(o.name||'').substring(0,14)} ${o.code} ¥${o.amount.toFixed(0)}`);
  }

  const rots = (rotationSignals||[]).filter(s => s.type === 'rotation');
  for (const s of rots.slice(0, 1)) {
    lines.push(`轮动 ${(s.fromSector||s.fromFund?.name||'').substring(0,8)}→${(s.toSector||s.toFund?.name||'').substring(0,10)} ${s.toFund?.code||''}`);
  }

  return lines.length > 0 ? lines.join('\n') : '不动';
}

module.exports = { sendMarkdown, formatDingtalkReport };
