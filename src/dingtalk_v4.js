/**
 * 钉钉推送 V4 — 纯操作指令格式
 *
 * 只输出具体操作: 代码+名称+金额+操作类型
 * 不输出分析、不输出选项, 看到就能直接在支付宝执行
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
// ⚠️ 安全: webhook 绝不可硬编码进代码/提交仓库。来源优先级:
//   1) 环境变量 DINGTALK_WEBHOOK (宿主注入时优先)
//   2) 本地 .env 文件 (gitignored, 行: DINGTALK_WEBHOOK=https://...)
//   3) 本地 data/dingtalk_webhook.txt (gitignored, 仅含一行 URL)
// 自动化宿主环境通常不注入 env, 故必须依赖本地 gitignored 文件兜底。
const PROJECT_ROOT = path.join(__dirname, '..');
const DING_ERR_LOG = path.join(PROJECT_ROOT, 'data', 'ding_last_error.log');

function resolveWebhook() {
  // 1) 环境变量
  if (process.env.DINGTALK_WEBHOOK && process.env.DINGTALK_WEBHOOK.trim()) {
    return process.env.DINGTALK_WEBHOOK.trim();
  }
  // 2) .env 文件
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const raw of content.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = line.match(/^DINGTALK_WEBHOOK\s*=\s*(.*)$/);
        if (m) return m[1].trim().replace(/^["']|["']$/g, '');
      }
    } catch (_) { /* 忽略解析异常, 继续下一来源 */ }
  }
  // 3) 专用明文文件 (仅一行 URL)
  const txtPath = path.join(PROJECT_ROOT, 'data', 'dingtalk_webhook.txt');
  if (fs.existsSync(txtPath)) {
    try {
      const v = fs.readFileSync(txtPath, 'utf8').trim().split('\n')[0].trim();
      if (v) return v;
    } catch (_) { /* 忽略 */ }
  }
  return '';
}

const WEBHOOK = resolveWebhook();

function appendDingError(reason) {
  try {
    const line = `[${new Date().toISOString()}] 钉钉发送失败: ${reason}\n`;
    fs.appendFileSync(DING_ERR_LOG, line);
  } catch (_) { /* 忽略日志写入异常 */ }
}

async function sendMarkdown(title, text) {
  if (!WEBHOOK) {
    const msg = '未配置 DINGTALK_WEBHOOK (环境变量为空 且 本地 .env / data/dingtalk_webhook.txt 均缺失), 跳过推送';
    console.warn('⚠️ ' + msg);
    appendDingError(msg);
    return false;
  }
  try {
    const resp = await axios.post(WEBHOOK, { msgtype: 'markdown', markdown: { title, text } }, { timeout: 10000 });
    // 钉钉成功标志: 响应体 errcode === 0。HTTP 4xx/5xx 不会让 axios 抛错, 必须显式检查响应体,
    // 否则 token 失效/被限流时仍会返回 true, 造成"发了但没收到"的假成功。
    const body = resp && resp.data ? resp.data : {};
    if (body.errcode !== undefined && body.errcode !== 0) {
      const reason = `钉钉接口拒绝: errcode=${body.errcode}, errmsg=${(body.errmsg || '').toString().slice(0, 80)}`;
      console.warn('❌ ' + reason);
      appendDingError(reason);
      return false;
    }
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
