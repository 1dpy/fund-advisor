/**
 * 钉钉推送 V4 — 纯操作指令格式
 *
 * 只输出具体操作: 代码+名称+金额+操作类型
 * 不输出分析、不输出选项, 看到就能直接在支付宝执行
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
// ⚠️ 安全: webhook 必须从环境变量读取, 切勿硬编码 token 提交到仓库
const WEBHOOK = process.env.DINGTALK_WEBHOOK || '';
const DING_ERR_LOG = path.join(__dirname, '..', 'data', 'ding_last_error.log');

function appendDingError(reason) {
  try {
    const line = `[${new Date().toISOString()}] 钉钉发送失败: ${reason}\n`;
    fs.appendFileSync(DING_ERR_LOG, line);
  } catch (_) { /* 忽略日志写入异常 */ }
}

async function sendMarkdown(title, text) {
  if (!WEBHOOK) {
    const msg = '未配置 DINGTALK_WEBHOOK 环境变量 (webhook 为空), 跳过推送';
    console.warn('⚠️ ' + msg);
    appendDingError(msg);
    return false;
  }
  try {
    await axios.post(WEBHOOK, { msgtype: 'markdown', markdown: { title, text } }, { timeout: 10000 });
    return true;
  } catch (e) {
    const httpInfo = e.response ? ` (HTTP ${e.response.status})` : '';
    const reason = `axios 请求失败: ${e.message}${httpInfo}`;
    console.warn('❌ ' + reason);
    appendDingError(reason);
    return false;
  }
}

function formatDingtalkV4(decisions) {
  const ops = decisions.operations;
  const lines = [];

  lines.push(`## 📋 操作指令 ${new Date().toLocaleDateString('zh-CN')}`);
  lines.push('');
  lines.push(`**T+1**: ${decisions.t1Info?.description || ''}`);
  lines.push('');

  let hasAction = false;

  // 卖出
  for (const o of ops.sells) {
    hasAction = true;
    lines.push(`### 🔴 卖出`);
    lines.push(`**${o.name}** (${o.code})`);
    lines.push(`> 全部${o.shares}份 约¥${o.amount.toFixed(0)}`);
    lines.push(`> ${o.reason}`);
    lines.push('');
  }

  // 部分卖出
  for (const o of ops.partialSells) {
    hasAction = true;
    lines.push(`### 🟡 部分卖出${o.sellPct}%`);
    lines.push(`**${o.name}** (${o.code})`);
    lines.push(`> ${o.shares}份 约¥${o.amount.toFixed(0)}`);
    lines.push(`> ${o.reason}`);
    lines.push('');
  }

  // 转换
  for (const o of ops.swaps) {
    hasAction = true;
    lines.push(`### 🔄 转换`);
    lines.push(`**${o.sellName}** → **${o.buyName}**`);
    lines.push(`> ${o.sellCode}→${o.buyCode} 约¥${o.sellValue.toFixed(0)}`);
    lines.push('');
  }

  // 买入
  for (const o of ops.buys) {
    hasAction = true;
    lines.push(`### 🟢 买入`);
    lines.push(`**${o.name}** (${o.code})`);
    lines.push(`> ¥${o.amount.toFixed(0)} ${o.shares}份`);
    lines.push(`> ${o.mlSignal} ${o.reason}`);
    lines.push('');
  }

  // 加仓
  for (const o of ops.addPositions) {
    hasAction = true;
    lines.push(`### ⬆️ 加仓`);
    lines.push(`**${o.name}** (${o.code})`);
    lines.push(`> ¥${o.amount.toFixed(0)} ${o.shares}份`);
    lines.push(`> ${o.reason}`);
    lines.push('');
  }

  // 减仓
  for (const o of ops.reduces) {
    hasAction = true;
    lines.push(`### ⬇️ 减仓${o.reducePct}%`);
    lines.push(`**${o.name}** (${o.code})`);
    lines.push(`> ${o.shares}份 约¥${o.amount.toFixed(0)}`);
    lines.push(`> ${o.reason}`);
    lines.push('');
  }

  // 持有
  if (ops.holds.length > 0 && !hasAction) {
    lines.push(`### ⚪ 全部持有`);
    for (const o of ops.holds) {
      lines.push(`- ${o.name} (${o.code}) ${o.reason}`);
    }
    lines.push('');
  }

  // 汇总
  const s = decisions.summary;
  lines.push('---');
  lines.push(`卖${s.sell} 部分卖${s.partialSell} 买${s.buy} 转换${s.swap} 加仓${s.addPosition} 减仓${s.reduce} 持有${s.hold}`);
  lines.push('');
  lines.push('*支付宝C类0申购费 15:00前按当日净值*');

  return lines.join('\n\n');
}

module.exports = { sendMarkdown, formatDingtalkV4 };
