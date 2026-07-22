/**
 * 美股实时分析 + 对A股基金影响映射
 * 每天14:25自动拉, 决策时考虑隔夜美股动态
 */

const axios = require('axios');
const iconv = require('iconv-lite');

// 关注的美国科技股
const US_WATCHLIST = [
  { sym: 'gb_ixic', name: '纳斯达克' },
  { sym: 'gb_dji', name: '道琼斯' },
  { sym: 'gb_inx', name: '标普500' },
  { sym: 'gb_nvda', name: '英伟达' },
  { sym: 'gb_amd', name: 'AMD' },
  { sym: 'gb_tsm', name: '台积电' },
  { sym: 'gb_avgo', name: '博通' },
  { sym: 'gb_intc', name: '英特尔' },
  { sym: 'gb_aapl', name: '苹果' },
  { sym: 'gb_msft', name: '微软' },
  { sym: 'gb_goog', name: '谷歌' },
  { sym: 'gb_amzn', name: '亚马逊' },
  { sym: 'gb_meta', name: 'Meta' },
  { sym: 'gb_tsla', name: '特斯拉' },
  { sym: 'gb_qcom', name: '高通' },
  { sym: 'gb_arm', name: 'ARM' },
];

// 美股→A股基金影响映射
// change: < -3% = 利空, >3% = 利好
const IMPACT_MAP = [
  { us: '英伟达', funds: ['008282', '017470'], sector: 'AI芯片', weight: 1.0 },
  { us: 'AMD', funds: ['008282', '017470'], sector: 'AI芯片', weight: 0.8 },
  { us: '台积电', funds: ['008282', '017470'], sector: 'AI芯片', weight: 0.9 },
  { us: '博通', funds: ['008282'], sector: 'AI芯片', weight: 0.6 },
  { us: '英特尔', funds: ['008282'], sector: 'AI芯片', weight: 0.5 },
  { us: '高通', funds: ['008282'], sector: 'AI芯片', weight: 0.4 },
  { us: 'ARM', funds: ['008282'], sector: 'AI芯片', weight: 0.5 },
  { us: '苹果', funds: ['019018'], sector: '消费电子', weight: 0.5 },
  { us: '微软', funds: ['019018'], sector: '软件', weight: 0.4 },
  { us: 'Meta', funds: ['019018'], sector: '互联网', weight: 0.3 },
  { us: '谷歌', funds: ['019018'], sector: '互联网', weight: 0.3 },
  { us: '特斯拉', funds: ['027495'], sector: '新能源', weight: 0.4 },
  { us: '亚马逊', funds: ['019018', '021277'], sector: '科技', weight: 0.3 },
];

/**
 * 获取美股实时行情
 */
async function fetchUSTechStocks() {
  const url = 'https://hq.sinajs.cn/list=' + US_WATCHLIST.map(s => s.sym).join(',');
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 10000,
      headers: { 'Referer': 'https://finance.sina.com.cn/' }
    });
    const raw = iconv.decode(Buffer.from(r.data), 'gbk');
    const lines = raw.split(/\r?\n/).filter(l => l.includes('hq_str'));
    const results = {};

    for (const line of lines) {
      const m = line.match(/"([^"]*)"/);
      if (!m) continue;
      const f = m[1].split(',');
      const name = f[0];
      const price = parseFloat(f[1]);
      const changePct = parseFloat(f[2]);
      const time = f[3];
      results[name] = { name, price, changePct, time };
    }
    return results;
  } catch (e) {
    return null;
  }
}

/**
 * 分析美股对A股基金的影响
 * 返回 { impactScore, signals, fundAdjustments }
 */
function analyzeUSImpact(usData) {
  if (!usData) return { available: false };

  const signals = [];
  const fundAdjustments = {}; // { fundCode: adjustmentPct }

  // 计算每个US股票的影响
  for (const impact of IMPACT_MAP) {
    const us = usData[impact.us];
    if (!us || isNaN(us.changePct)) continue;

    // 重大涨跌才产生信号
    if (Math.abs(us.changePct) >= 2) {
      const direction = us.changePct > 0 ? '利好' : '利空';
      signals.push({
        us: impact.us,
        changePct: us.changePct,
        direction,
        sector: impact.sector,
        detail: `${impact.us} ${direction} ${impact.sector} (${us.changePct > 0 ? '+' : ''}${us.changePct.toFixed(1)}%)`,
      });
    }

    // 累加对每个基金的影响
    for (const fundCode of impact.funds) {
      const adj = us.changePct * impact.weight * 0.3; // 美股→A股传导系数约0.3
      fundAdjustments[fundCode] = (fundAdjustments[fundCode] || 0) + adj;
    }
  }

  // 计算整体情绪分 (-100 到 +100)
  let totalScore = 0;
  for (const [code, adj] of Object.entries(fundAdjustments)) {
    totalScore += adj;
  }
  const impactScore = Math.max(-100, Math.min(100, Math.round(totalScore)));

  // 判断市场情绪
  let sentiment;
  if (impactScore >= 20) sentiment = '积极';
  else if (impactScore >= 5) sentiment = '偏积极';
  else if (impactScore >= -5) sentiment = '中性';
  else if (impactScore >= -20) sentiment = '偏消极';
  else sentiment = '消极';

  return {
    available: true,
    impactScore,
    sentiment,
    signals: signals.slice(0, 5),
    fundAdjustments,
    time: Object.values(usData)[0]?.time || '',
  };
}

/**
 * 一站式: 获取美股 + 分析影响
 */
async function fetchUSImpact() {
  const usData = await fetchUSTechStocks();
  const analysis = analyzeUSImpact(usData);
  return analysis;
}

module.exports = { fetchUSTechStocks, analyzeUSImpact, fetchUSImpact };
