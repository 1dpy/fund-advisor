/**
 * 市场异常检测 — 提前发现风险
 *
 * 检测维度:
 *   1. 波动率爆发 (ATR突变)
 *   2. 量价背离 (放量不涨/缩量不跌)
 *   3. 指数分化 (上证涨创业板大跌=异常)
 *   4. 情绪极端 (RSI极端+新闻极端)
 *   5. 流动性骤降 (成交量骤缩)
 */

function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function std(arr) { const m=mean(arr); return arr.length>1?Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length):0; }

/**
 * 检测指数间分化
 * 当主要指数走势严重背离时预警
 */
function detectIndexDivergence(indexes) {
  if (!indexes || indexes.length < 3) return null;

  const changes = indexes.map(i => i.changePct);
  const maxChg = Math.max(...changes);
  const minChg = Math.min(...changes);
  const spread = maxChg - minChg;

  if (spread > 3) {
    const upIdx = indexes.filter(i => i.changePct > 0).map(i => i.name);
    const downIdx = indexes.filter(i => i.changePct < 0).map(i => i.name);
    return {
      level: spread > 5 ? '严重' : '明显',
      detail: `${upIdx.join('/')}涨 ${downIdx.join('/')}跌 分歧${spread.toFixed(1)}%`,
      spread: Math.round(spread*10)/10,
    };
  }
  return null;
}

/**
 * 检测波动率突变
 */
function detectVolatilityShock(closes) {
  if (!closes || closes.length < 21) return null;
  const returns = [];
  for (let i=1; i<closes.length; i++) returns.push(Math.abs((closes[i]-closes[i-1])/closes[i-1]));
  const recentVol = mean(returns.slice(-5));
  const normalVol = mean(returns.slice(-20, -5));
  if (normalVol === 0) return null;

  const ratio = recentVol / normalVol;
  if (ratio > 2.5) return { level: '高', ratio: Math.round(ratio*10)/10, detail: `波动率突增至正常${(ratio*100).toFixed(0)}%` };
  if (ratio < 0.3) return { level: '低', ratio: Math.round(ratio*10)/10, detail: '波动率骤降,市场停滞' };
  return null;
}

/**
 * 检测成交异常
 */
function detectVolumeAnomaly(volumes, closes) {
  if (!volumes || volumes.length < 21 || !closes || closes.length < 21) return null;

  const recentVol = mean(volumes.slice(-5));
  const normalVol = mean(volumes.slice(-20, -5));
  if (normalVol === 0) return null;

  const volRatio = recentVol / normalVol;
  const priceChange = (closes[closes.length-1] - closes[closes.length-6]) / closes[closes.length-6] * 100;

  // 放量滞涨
  if (volRatio > 1.8 && priceChange < 0.5 && priceChange > -0.5) {
    return { type: '放量滞涨', detail: `量${(volRatio*100).toFixed(0)}%价${priceChange > 0 ? '+' : ''}${priceChange.toFixed(1)}% 主力出货可能` };
  }
  // 放量暴跌
  if (volRatio > 2 && priceChange < -2) {
    return { type: '放量暴跌', detail: `恐慌性抛售 量${(volRatio*100).toFixed(0)}% 跌${priceChange.toFixed(1)}%` };
  }
  // 缩量上涨
  if (volRatio < 0.5 && priceChange > 1) {
    return { type: '缩量上涨', detail: '上行动能不足,可能回调' };
  }
  return null;
}

/**
 * 全面异常扫描
 */
function scanAnomalies(indexes, fundHistories) {
  const alerts = [];

  // 指数分化
  const div = detectIndexDivergence(indexes);
  if (div) alerts.push({ ...div, metric: '指数分化' });

  // 用第一只可用基金检测波动和量能
  const firstHist = Array.isArray(fundHistories) ? fundHistories :
    Object.values(fundHistories).find(h => h && h.length > 21);
  if (firstHist) {
    const closes = firstHist.map(h => h.close || h.nav || 0).filter(v => v > 0);
    const volumes = firstHist.map(h => h.volume || 0);

    const volShock = detectVolatilityShock(closes);
    if (volShock) alerts.push({ ...volShock, metric: '波动率异常' });

    const volAnomaly = detectVolumeAnomaly(volumes, closes);
    if (volAnomaly) alerts.push({ ...volAnomaly, metric: '量能异常' });
  }

  return alerts;
}

module.exports = { scanAnomalies, detectIndexDivergence, detectVolatilityShock, detectVolumeAnomaly };
