/**
 * 决策可解释性归因 (Decision Explainability / Attribution)
 * ---------------------------------------------------------------
 * 把"为什么买/卖这只"从黑盒变成可审计的文字。基于多因子库的贡献度
 * (factor_library.compositeScore 的 contrib), 对每一笔操作生成一句人话
 * 归因, 并汇总成可推送到钉钉 / 喂给 LLM 解读的结构化说明 (P2 · 可解释AI)。
 *
 * 与模型解耦: 调用方传入 operations 与一个 factorLookup(code) -> 
 *   { score, contrib:{momentum,valuation,sentiment} } 即可, 因子来源
 *   可以是实时回测因子表, 也可以是 advisor 决策时同步算的因子快照。
 *
 * 用法:
 *   const de = require('./decision_explain');
 *   const exp = de.explainOperations(advice.operations, (code)=>factorMap[code]);
 *   // exp: [{ code, name, action, topFactors:[...], reason }]
 *   const text = de.buildAttrText(exp);
 */

const ACTION_CN = { BUY: '买入', ADD: '加仓', SELL: '卖出', PARTIAL_SELL: '部分卖出', HOLD: '持有', CONVERT: '转换' };
const FACTOR_CN = { momentum: '动量', valuation: '估值便宜度', sentiment: '情绪' };

// 取贡献度最高的前 k 个因子 (按绝对值)
function topFactors(contrib, k = 2) {
  if (!contrib) return [];
  return Object.entries(contrib)
    .map(([g, v]) => ({ g, v }))
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
    .slice(0, k)
    .filter((x) => Math.abs(x.v) > 0.05);
}

function explainOperations(operations, factorLookup) {
  if (!Array.isArray(operations)) return [];
  return operations.map((op) => {
    const code = op.code;
    const fac = factorLookup && factorLookup(code);
    const action = op.action || 'BUY';
    let reason = '';
    const tops = fac ? topFactors(fac.contrib, 2) : [];

    if (action === 'SELL' || action === 'PARTIAL_SELL') {
      reason = op.reason && typeof op.reason === 'string'
        ? op.reason
        : '触发风控/止盈纪律, 落袋为安或控制回撤';
    } else {
      // 买入/加仓: 用因子贡献解释
      if (tops.length) {
        const parts = tops.map((t) => `${FACTOR_CN[t.g] || t.g}${t.v > 0 ? '+' : ''}${t.v.toFixed(2)}`);
        reason = `因子入选: ${parts.join(' / ')}` + (fac ? `, 综合因子分 ${fac.score.toFixed(2)}` : '');
      } else {
        reason = op.reason && typeof op.reason === 'string' ? op.reason : '综合策略信号触发';
      }
    }
    return {
      code,
      name: op.name || code,
      action,
      actionCN: ACTION_CN[action] || action,
      topFactors: tops.map((t) => ({ factor: FACTOR_CN[t.g] || t.g, value: +t.v.toFixed(2) })),
      score: fac ? fac.score : null,
      reason,
    };
  });
}

function buildAttrText(explanations) {
  if (!explanations.length) return '';
  return explanations.map((e) => {
    const factors = e.topFactors.length
      ? `（${e.topFactors.map((f) => `${f.factor}${f.value > 0 ? '+' : ''}${f.value}`).join('、')}）`
      : '';
    return `· ${e.actionCN} ${e.name}(${e.code}) ${factors} — ${e.reason}`;
  }).join('\n');
}

// 直接对"因子排名表"生成整体解读 (回测/日报用)
//   ranked: compositeScore 输出 [{code, score, contrib}]
//   nameMap: { code: name }
function explainRanking(ranked, nameMap = {}, topK = 3) {
  return ranked.slice(0, topK).map((r) => {
    const tops = topFactors(r.contrib, 2).map((t) => `${FACTOR_CN[t.g] || t.g}${t.v > 0 ? '+' : ''}${t.v.toFixed(2)}`).join(' / ');
    return { code: r.code, name: nameMap[r.code] || r.code, score: r.score, drivers: tops };
  });
}

module.exports = { explainOperations, buildAttrText, explainRanking, topFactors, ACTION_CN, FACTOR_CN };
