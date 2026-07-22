/**
 * 市场环境深度分析模块
 * 判断市场状态、波动率体制、资金面 — 决定仓位和策略
 */

const { TECH_CONFIG } = require('./config');

/**
 * 市场体制分类: TRENDING_UP / TRENDING_DOWN / VOLATILE / SIDEWAYS / CRASH / MELTUP
 */
function detectMarketRegime(indexes, indexHistory) {
  if (!indexes || indexes.length === 0) return { regime: 'UNKNOWN', confidence: 0 };

  const sh = indexes.find(i => i.name.includes('上证'));
  if (!sh) return { regime: 'UNKNOWN', confidence: 0 };

  const changePct = sh.changePct || 0;
  const score = {};

  // 1. 当日涨跌幅度
  score.dayMagnitude = Math.abs(changePct);
  if (score.dayMagnitude > 3) score.dayBias = changePct > 0 ? 'SURGE' : 'PLUNGE';
  else if (score.dayMagnitude > 1.5) score.dayBias = changePct > 0 ? 'RALLY' : 'DECLINE';
  else score.dayBias = changePct > 0 ? 'SLIGHT_UP' : changePct < 0 ? 'SLIGHT_DOWN' : 'FLAT';

  // 2. 多指数共振强度
  const upCount = indexes.filter(i => i.changePct > 0).length;
  const downCount = indexes.filter(i => i.changePct < 0).length;
  const totalIdx = indexes.length;
  score.resonance = upCount === totalIdx ? 'FULL_UP' :
    downCount === totalIdx ? 'FULL_DOWN' :
    upCount > downCount ? 'MOSTLY_UP' : 'MOSTLY_DOWN';

  // 3. 波动率判断 (基于指数间涨幅差异)
  const changes = indexes.map(i => i.changePct);
  const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
  const variance = changes.reduce((s, c) => s + (c - avgChange) ** 2, 0) / changes.length;
  const dispersion = Math.sqrt(variance);
  score.dispersion = dispersion;

  if (dispersion > 3) score.volatilityRegime = 'HIGH';
  else if (dispersion > 1.5) score.volatilityRegime = 'ELEVATED';
  else score.volatilityRegime = 'NORMAL';

  // 4. 创业板vs上证 — 风险偏好指标
  const cyb = indexes.find(i => i.name.includes('创业板'));
  const kcb = indexes.find(i => i.name.includes('科创'));
  if (cyb && sh) {
    const riskSpread = cyb.changePct - sh.changePct;
    if (riskSpread > 2) score.riskAppetite = 'RISK_ON';
    else if (riskSpread > 0.5) score.riskAppetite = 'SLIGHT_RISK_ON';
    else if (riskSpread > -0.5) score.riskAppetite = 'NEUTRAL';
    else if (riskSpread > -2) score.riskAppetite = 'RISK_OFF';
    else score.riskAppetite = 'PANIC';
  }

  // 5. 综合判定体制
  let regime, confidence;
  if (upCount === totalIdx && avgChange > 1.5) {
    regime = score.volatilityRegime === 'HIGH' ? 'MELTUP' : 'TRENDING_UP';
    confidence = 80;
  } else if (downCount === totalIdx && avgChange < -1.5) {
    regime = score.volatilityRegime === 'HIGH' ? 'CRASH' : 'TRENDING_DOWN';
    confidence = 80;
  } else if (dispersion > 2.5) {
    regime = 'VOLATILE';
    confidence = 60;
  } else {
    regime = 'SIDEWAYS';
    confidence = 50;
  }

  return {
    regime,
    confidence,
    details: score,
    description: describeRegime(regime, score),
  };
}

function describeRegime(regime, score) {
  const descriptions = {
    'TRENDING_UP': '上升趋势 — 适合趋势跟踪策略, 高仓位',
    'TRENDING_DOWN': '下降趋势 — 防御为主, 降低仓位, 等待企稳',
    'MELTUP': '快速拉升 — 注意追高风险, 但趋势强劲可跟随',
    'CRASH': '快速下跌 — 恐慌中寻找超跌机会, 分批抄底',
    'VOLATILE': '高波动 — 短线为主, 注意板块轮动',
    'SIDEWAYS': '横盘震荡 — 精选个股, 低吸高抛',
    'UNKNOWN': '无法判断',
  };
  return descriptions[regime] || '未知';
}

/**
 * 根据市场体制给出仓位建议
 */
function getRegimePosition(regimeInfo, baseMultiplier) {
  const { regime } = regimeInfo;
  const adjustments = {
    'TRENDING_UP': 1.0,      // 100% of base
    'MELTUP': 0.85,          // 稍微收敛
    'SIDEWAYS': 0.75,
    'VOLATILE': 0.65,
    'TRENDING_DOWN': 0.45,
    'CRASH': 0.35,           // 留子弹抄底
    'UNKNOWN': 0.50,
  };
  return baseMultiplier * (adjustments[regime] || 0.5);
}

/**
 * 计算市场温度 (0-100)
 * 结合指数涨跌、共振、波动率、风险偏好
 */
function computeMarketTemperature(indexes, marketEnv) {
  if (!indexes || indexes.length === 0) return 50;

  let temp = 50;
  const sh = indexes.find(i => i.name.includes('上证'));
  const cyb = indexes.find(i => i.name.includes('创业板'));
  const kcb = indexes.find(i => i.name.includes('科创'));

  // 上证贡献 ±15
  if (sh) temp += sh.changePct * 5;

  // 创业板和科创贡献 ±10 (风险偏好放大器)
  if (cyb) temp += cyb.changePct * 2;
  if (kcb) temp += kcb.changePct * 1.5;

  // 共振加分
  const allUp = indexes.every(i => i.changePct > 0);
  const allDown = indexes.every(i => i.changePct < 0);
  if (allUp) temp += 8;
  if (allDown) temp -= 8;

  // 波动惩罚
  const changes = indexes.map(i => i.changePct);
  const dispersion = Math.sqrt(changes.reduce((s, c) => s + (c - changes.reduce((a,b)=>a+b,0)/changes.length) ** 2, 0) / changes.length);
  if (dispersion > 3) temp -= 5;

  return Math.max(0, Math.min(100, Math.round(temp)));
}

module.exports = {
  detectMarketRegime,
  getRegimePosition,
  computeMarketTemperature,
  describeRegime,
};
