/**
 * evolution.js — 进化记录层
 *
 * 每次模型给出建议后记录决策(日期/体制/情绪/操作), 供未来回填实际盈亏,
 * 并基于历史命中率微调参数(贪婪抑制强度 / 再平衡阈值)。
 *
 * 设计原则: 不破坏现有默认行为。当前阶段核心纪律已由 holdings.locked
 * + advisor_v5 的贪婪/熊市抑制硬编码保障; 本层先做"记录 + 可扩展自调"。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EVOLUTION_PATH = path.join(ROOT, 'evolution.json');

const DEFAULT = {
  version: 1,
  params: {
    maxTechConcentration: 0.50,
    stopLossRatio: -0.08,
    greedInhibitBuy: true,   // 贪婪日抑制追高买入
    bearInhibitBuy: true,    // 熊市体制抑制追高买入
  },
  history: [],
  stats: { decisions: 0, hold: 0, sell: 0, buy: 0 },
};

function loadEvolution() {
  try {
    const e = JSON.parse(fs.readFileSync(EVOLUTION_PATH, 'utf8'));
    return Object.assign({}, DEFAULT, e, { params: Object.assign({}, DEFAULT.params, e.params || {}) });
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT));
  }
}

function saveEvolution(e) {
  fs.writeFileSync(EVOLUTION_PATH, JSON.stringify(e, null, 2));
}

function recordDecision(advice, marketSentiment) {
  const e = loadEvolution();
  const ops = advice.operations || [];
  const summary = ops.map(o => `${o.action}:${o.code}:${o.amount || 0}`).join('|');
  const entry = {
    date: advice.date || new Date().toISOString().split('T')[0],
    regime: advice.regime,
    sentimentScore: marketSentiment?.score ?? null,
    sentimentBias: marketSentiment?.tradingBias ?? null,
    operations: summary,
    outcome: null,   // 未来由外部回填次日/后续盈亏, 用于命中率统计
  };
  e.history.push(entry);
  e.stats.decisions = (e.stats.decisions || 0) + 1;
  for (const o of ops) {
    if (o.action === 'HOLD') e.stats.hold = (e.stats.hold || 0) + 1;
    else if (o.action === 'SELL' || o.action === 'CONVERT') e.stats.sell = (e.stats.sell || 0) + 1;
    else if (o.action === 'BUY' || o.action === 'DCA') e.stats.buy = (e.stats.buy || 0) + 1;
  }
  if (e.history.length > 200) e.history = e.history.slice(-200);
  saveEvolution(e);
  return entry;
}

/**
 * 参数自调 (占位/保守实现)
 * 规则: 若近 N 次"贪婪日买入"后 outcome 多为负 → 强化 greedInhibitBuy。
 * 当前无 outcome 数据时不调整, 返回默认 params, 保证不破坏行为。
 */
function evolveParams() {
  const e = loadEvolution();
  const recent = e.history.slice(-20);
  const greedBuys = recent.filter(h => h.sentimentBias === 'TAKE_PROFIT' && h.operations.includes('BUY'));
  const badGreedBuys = greedBuys.filter(h => typeof h.outcome === 'number' && h.outcome < 0);
  if (greedBuys.length >= 3 && badGreedBuys.length / greedBuys.length >= 0.6) {
    e.params.greedInhibitBuy = true; // 已默认true, 强化确认
  }
  return e.params;
}

module.exports = { loadEvolution, saveEvolution, recordDecision, evolveParams };

// CLI: node evolution.js --record  (从 stdin 读 advice.json + 可选 sentiment)
if (require.main === module && process.argv.includes('--record')) {
  let raw = '';
  process.stdin.on('data', d => raw += d);
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(raw);
      const entry = recordDecision(payload.advice, payload.marketSentiment);
      console.log('已记录决策:', JSON.stringify(entry).slice(0, 200));
    } catch (e) {
      console.error('解析失败:', e.message);
    }
  });
}
