/**
 * LLM 自然语言解读 (AI 方向 · 环境门控)
 * ---------------------------------------------------------------
 * 把当日的操作单(结构化 JSON)转换成一段"人话"解读: 为什么买 / 风险点 /
 * 明天怎么看。这是 AI + 金融的交叉点 (参考 AI4Finance/FinRobot 的
 * "确定性计算 + LLM 叙述分离" 架构 —— 计算由代码保证可审计, 叙述由 LLM 生成)。
 *
 * 设计原则:
 *   - 严格使用 OpenAI 兼容接口, 支持 DeepSeek / 通义 / 硅基流动 等任意厂商
 *   - 密钥只从环境变量读取, 绝不硬编码 (已脱敏, 可安全开源)
 *   - 未配置 LLM_API_KEY 时 generateExplanation 返回 null, 调用方自动跳过 ——
 *     不影响主流程, 离线/无网也能跑
 *
 * 环境变量:
 *   LLM_API_KEY   (必填, 启用时才调用)
 *   LLM_BASE_URL  (默认 https://api.deepseek.com/v1)
 *   LLM_MODEL     (默认 deepseek-chat)
 */

const axios = require('axios');

function isEnabled() {
  return !!process.env.LLM_API_KEY;
}

function buildPrompt(advice) {
  const picks = (advice.realtimePicks || []).map(
    (p) => `${p.name}(${p.code}) 实时${p.changePct != null ? (p.changePct >= 0 ? '+' : '') + p.changePct + '%' : 'N/A'} 近5日${(p.mom5 || 0) >= 0 ? '+' : ''}${p.mom5 || 0}% 综合分${p.score}`
  ).join('; ');
  const ops = (advice.operations || []).map((o) => `[${o.action}] ${o.name}(${o.code}) ¥${o.amount || 0} —— ${o.reason}`).join('\n');
  return [
    '你是专业的基金投资助手。下面是一份基于量化模型生成的当日基金操作单(赚钱优先策略 PROFIT_FIRST)。',
    '请用 3-4 句中文, 面向普通投资者, 通俗解释: 今天为什么这样操作、当前市场风险点、需要注意什么。不要编造数据, 不要给出操作单以外的具体买卖指令。',
    '',
    `策略: ${advice.strategy || 'PROFIT_FIRST'}`,
    `市场状态: ${advice.regime || 'N/A'}`,
    `当日动态选基 Top${advice.realtimePicks ? advice.realtimePicks.length : 0}: ${picks || '无'}`,
    `操作指令:\n${ops || '无'}`,
  ].join('\n');
}

async function generateExplanation(advice, opts = {}) {
  const apiKey = opts.apiKey || process.env.LLM_API_KEY;
  if (!apiKey) return null;
  const baseURL = opts.baseURL || process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1';
  const model = opts.model || process.env.LLM_MODEL || 'deepseek-chat';
  try {
    const resp = await axios.post(
      `${baseURL.replace(/\/$/, '')}/chat/completions`,
      { model, messages: [{ role: 'user', content: buildPrompt(advice) }], temperature: 0.5, max_tokens: 300 },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    const text = resp.data?.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (e) {
    // 失败不影响主流程, 仅跳过 LLM 解读
    return null;
  }
}

module.exports = { isEnabled, generateExplanation, buildPrompt };
