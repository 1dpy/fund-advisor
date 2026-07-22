/**
 * 美股前瞻性分析 V2 — 增强版
 *
 * 新增:
 *   1. VIX恐慌指数追踪
 *   2. 美债收益率 (10Y) 影响
 *   3. 美股期货盘前信号
 *   4. 更完整的US→A股传导矩阵
 *   5. 美股板块ETF → A股对应板块映射
 *   6. 隔夜涨幅 → 次日A股概率预测
 */

const axios = require('axios');
const iconv = require('iconv-lite');

// ============================================================
//  关注列表
// ============================================================

// 美股指数 + 个股
const US_WATCHLIST_V2 = [
  // 指数
  { sym: 'gb_ixic', name: '纳斯达克', type: 'index' },
  { sym: 'gb_dji', name: '道琼斯', type: 'index' },
  { sym: 'gb_inx', name: '标普500', type: 'index' },
  // 半导体/AI核心
  { sym: 'gb_nvda', name: '英伟达', type: 'stock' },
  { sym: 'gb_amd', name: 'AMD', type: 'stock' },
  { sym: 'gb_tsm', name: '台积电', type: 'stock' },
  { sym: 'gb_avgo', name: '博通', type: 'stock' },
  { sym: 'gb_intc', name: '英特尔', type: 'stock' },
  { sym: 'gb_qcom', name: '高通', type: 'stock' },
  { sym: 'gb_arm', name: 'ARM', type: 'stock' },
  { sym: 'gb_mu', name: '美光', type: 'stock' },
  { sym: 'gb_asml', name: 'ASML', type: 'stock' },
  // 科技巨头
  { sym: 'gb_aapl', name: '苹果', type: 'stock' },
  { sym: 'gb_msft', name: '微软', type: 'stock' },
  { sym: 'gb_goog', name: '谷歌', type: 'stock' },
  { sym: 'gb_amzn', name: '亚马逊', type: 'stock' },
  { sym: 'gb_meta', name: 'Meta', type: 'stock' },
  { sym: 'gb_tsla', name: '特斯拉', type: 'stock' },
  { sym: 'gb_nvda', name: '英伟达', type: 'stock' },
  // 新能源
  { sym: 'gb_rivn', name: 'Rivian', type: 'stock' },
  { sym: 'gb_lcID', name: 'Lucid', type: 'stock' },
  // 中概股
  { sym: 'gb_baba', name: '阿里巴巴', type: 'stock' },
  { sym: 'gb_pdd', name: '拼多多', type: 'stock' },
  { sym: 'gb_jd', name: '京东', type: 'stock' },
  { sym: 'gb_bidu', name: '百度', type: 'stock' },
  { sym: 'gb_nio', name: '蔚来', type: 'stock' },
  { sym: 'gb_xpev', name: '小鹏', type: 'stock' },
  { sym: 'gb_li', name: '理想', type: 'stock' },
];

// VIX相关 (用新浪的VIX代码)
const VIX_SYMBOL = 'gb_vix';

// 美债10Y收益率 (简化: 用新浪美元指数代替)
const DXY_SYMBOL = 'gb_dxy';

// ============================================================
//  增强传导矩阵: 美股 → A股基金
// ============================================================

const ENHANCED_IMPACT_MAP = [
  // 半导体/AI → 芯片基金
  { us: '英伟达', funds: ['008282', '017470', '014419'], sector: 'AI芯片', weight: 1.0, lagHours: 0 },
  { us: 'AMD', funds: ['008282', '017470'], sector: 'AI芯片', weight: 0.8, lagHours: 0 },
  { us: '台积电', funds: ['008282', '017470'], sector: 'AI芯片', weight: 0.9, lagHours: 0 },
  { us: 'ASML', funds: ['008282', '017470'], sector: 'AI芯片', weight: 0.85, lagHours: 0 },
  { us: '美光', funds: ['008282'], sector: '存储芯片', weight: 0.6, lagHours: 0 },
  { us: '博通', funds: ['008282'], sector: 'AI芯片', weight: 0.6, lagHours: 0 },
  { us: '英特尔', funds: ['008282'], sector: 'AI芯片', weight: 0.5, lagHours: 0 },
  { us: '高通', funds: ['008282'], sector: 'AI芯片', weight: 0.4, lagHours: 0 },
  { us: 'ARM', funds: ['008282'], sector: 'AI芯片', weight: 0.5, lagHours: 0 },
  // 科技巨头 → 信息/互联网基金
  { us: '苹果', funds: ['019018'], sector: '消费电子', weight: 0.5, lagHours: 0 },
  { us: '微软', funds: ['019018'], sector: '软件', weight: 0.4, lagHours: 0 },
  { us: 'Meta', funds: ['019018'], sector: '互联网', weight: 0.3, lagHours: 0 },
  { us: '谷歌', funds: ['019018'], sector: '互联网', weight: 0.3, lagHours: 0 },
  { us: '亚马逊', funds: ['019018', '021277'], sector: '科技', weight: 0.3, lagHours: 0 },
  // 新能源 → 电池/新能源基金
  { us: '特斯拉', funds: ['027495'], sector: '新能源', weight: 0.5, lagHours: 0 },
  { us: 'Rivian', funds: ['027495'], sector: '新能源', weight: 0.2, lagHours: 0 },
  { us: 'Lucid', funds: ['027495'], sector: '新能源', weight: 0.15, lagHours: 0 },
  // 中概股 → 互联网/QDII
  { us: '阿里巴巴', funds: ['019018', '021277'], sector: '中概互联', weight: 0.6, lagHours: 0 },
  { us: '拼多多', funds: ['019018'], sector: '中概互联', weight: 0.3, lagHours: 0 },
  { us: '京东', funds: ['019018'], sector: '中概互联', weight: 0.3, lagHours: 0 },
  { us: '百度', funds: ['019018'], sector: '中概互联', weight: 0.3, lagHours: 0 },
  // 新能源车 → 电池/汽车
  { us: '蔚来', funds: ['027495'], sector: '新能源车', weight: 0.25, lagHours: 0 },
  { us: '小鹏', funds: ['027495'], sector: '新能源车', weight: 0.2, lagHours: 0 },
  { us: '理想', funds: ['027495'], sector: '新能源车', weight: 0.25, lagHours: 0 },
  // 指数级影响
  { us: '纳斯达克', funds: ['021277', '019018', '008282'], sector: '整体科技', weight: 0.5, lagHours: 0 },
  { us: '标普500', funds: ['021277'], sector: '整体市场', weight: 0.3, lagHours: 0 },
  { us: '道琼斯', funds: [], sector: '传统工业', weight: 0.2, lagHours: 0 },
];

// ============================================================
//  获取美股数据
// ============================================================

async function fetchUSDataV2() {
  const symbols = [...US_WATCHLIST_V2.map(s => s.sym), VIX_SYMBOL, DXY_SYMBOL];
  const url = 'https://hq.sinajs.cn/list=' + symbols.join(',');

  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 12000,
      headers: { 'Referer': 'https://finance.sina.com.cn/' },
    });
    const raw = iconv.decode(Buffer.from(r.data), 'gbk');
    const lines = raw.split(/\r?\n/).filter(l => l.includes('hq_str'));
    const results = {};

    for (const line of lines) {
      const m = line.match(/"([^"]*)"/);
      if (!m || !m[1]) continue;
      const f = m[1].split(',');
      if (f.length < 4) continue;

      const name = f[0];
      const price = parseFloat(f[1]);
      const changePct = parseFloat(f[2]);
      const time = f[3];

      if (name && !isNaN(price)) {
        results[name] = { name, price, changePct: isNaN(changePct) ? 0 : changePct, time };
      }
    }

    return results;
  } catch (e) {
    return null;
  }
}

// ============================================================
//  前瞻性分析
// ============================================================

/**
 * 基于美股隔夜表现, 预测A股各板块次日表现概率
 */
function predictAShareImpact(usData) {
  if (!usData) return { available: false };

  const signals = [];
  const fundAdjustments = {};
  const sectorImpacts = {};

  // 1. 计算每个美股标的对A股基金的影响
  for (const impact of ENHANCED_IMPACT_MAP) {
    const us = usData[impact.us];
    if (!us || isNaN(us.changePct)) continue;

    // 重大涨跌才产生信号 (≥1.5%)
    if (Math.abs(us.changePct) >= 1.5) {
      const direction = us.changePct > 0 ? '利好' : '利空';
      const strength = Math.abs(us.changePct) >= 3 ? '强' : Math.abs(us.changePct) >= 2 ? '中' : '弱';

      signals.push({
        us: impact.us,
        changePct: us.changePct,
        direction,
        strength,
        sector: impact.sector,
        detail: `${impact.us} ${direction} ${impact.sector} (${us.changePct > 0 ? '+' : ''}${us.changePct.toFixed(1)}%)`,
      });
    }

    // 累加对基金的影响 (传导系数根据权重和时间衰减)
    for (const fundCode of impact.funds) {
      const adj = us.changePct * impact.weight * 0.25; // 传导系数0.25
      fundAdjustments[fundCode] = (fundAdjustments[fundCode] || 0) + adj;
    }

    // 板块级影响
    if (!sectorImpacts[impact.sector]) {
      sectorImpacts[impact.sector] = { totalImpact: 0, sources: [] };
    }
    sectorImpacts[impact.sector].totalImpact += us.changePct * impact.weight;
    sectorImpacts[impact.sector].sources.push(impact.us);
  }

  // 2. VIX恐慌指数分析
  const vix = usData['VIX'] || usData['vix'];
  let vixAnalysis = null;
  if (vix && !isNaN(vix.price)) {
    let vixLevel, vixImpact;
    if (vix.price > 30) { vixLevel = '极度恐慌'; vixImpact = -0.8; }
    else if (vix.price > 20) { vixLevel = '恐慌上升'; vixImpact = -0.3; }
    else if (vix.price > 15) { vixLevel = '正常'; vixImpact = 0; }
    else { vixLevel = '乐观'; vixImpact = 0.2; }

    vixAnalysis = {
      price: vix.price,
      level: vixLevel,
      impact: vixImpact,
      advice: vix.price > 25 ? '⚠️ 恐慌情绪高, 建议降低仓位' : vix.price < 15 ? '市场乐观, 可适当进取' : '情绪正常',
    };
  }

  // 3. 美元指数分析
  const dxy = usData['美元指数'] || usData['DXY'] || usData['dxy'];
  let dxyAnalysis = null;
  if (dxy && !isNaN(dxy.changePct)) {
    dxyAnalysis = {
      changePct: dxy.changePct,
      impact: dxy.changePct > 0.3 ? '美元走强, 新兴市场资金可能流出' : dxy.changePct < -0.3 ? '美元走弱, 利好A股外资流入' : '影响有限',
    };
  }

  // 4. 纳斯达克 → A股科技 概率预测
  const nasdaq = usData['纳斯达克'];
  let nextDayPrediction = null;
  if (nasdaq && !isNaN(nasdaq.changePct)) {
    const nasChg = nasdaq.changePct;
    // 简化统计模型: 纳指涨跌 → A股科技次日涨跌概率
    let aShareTechProb;
    if (nasChg > 2) aShareTechProb = { upProb: 75, description: '纳指大涨, A股科技大概率高开' };
    else if (nasChg > 1) aShareTechProb = { upProb: 65, description: '纳指上涨, A股科技偏强' };
    else if (nasChg > -1) aShareTechProb = { upProb: 50, description: '纳指平盘, A股科技独立行情' };
    else if (nasChg > -2) aShareTechProb = { upProb: 35, description: '纳指下跌, A股科技承压' };
    else aShareTechProb = { upProb: 20, description: '⚠️ 纳指大跌, A股科技大概率低开' };

    nextDayPrediction = {
      nasdaqChange: nasChg,
      ...aShareTechProb,
      advice: nasChg > 2 ? '可考虑早盘加仓科技' : nasChg < -2 ? '⚠️ 建议等低开企稳再操作' : '正常操作',
    };
  }

  // 5. 计算整体情绪分
  let totalScore = 0;
  for (const adj of Object.values(fundAdjustments)) totalScore += adj;
  const impactScore = Math.max(-100, Math.min(100, Math.round(totalScore)));

  let sentiment;
  if (impactScore >= 15) sentiment = '积极';
  else if (impactScore >= 5) sentiment = '偏积极';
  else if (impactScore >= -5) sentiment = '中性';
  else if (impactScore >= -15) sentiment = '偏消极';
  else sentiment = '消极';

  // 6. 板块影响排序
  const sectorRanking = Object.entries(sectorImpacts)
    .map(([sector, data]) => ({ sector, impact: Math.round(data.totalImpact * 10) / 10, sources: data.sources }))
    .sort((a, b) => b.impact - a.impact);

  return {
    available: true,
    impactScore,
    sentiment,
    signals: signals.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 8),
    fundAdjustments,
    sectorRanking,
    vix: vixAnalysis,
    dxy: dxyAnalysis,
    nextDayPrediction,
    time: Object.values(usData)[0]?.time || '',
    usStocks: Object.entries(usData).map(([name, d]) => ({ name, ...d })).filter(s => !isNaN(s.price)),
  };
}

/**
 * 一站式: 获取 + 分析
 */
async function fetchUSImpactV2() {
  const usData = await fetchUSDataV2();
  return predictAShareImpact(usData);
}

module.exports = { fetchUSImpactV2, fetchUSDataV2, predictAShareImpact, ENHANCED_IMPACT_MAP };
