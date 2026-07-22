/**
 * 板块轮动检测 — 全赛道版
 * 覆盖10+赛道, 检测资金流向, 抓轮动利润
 */

function calcMomentum(history, period) {
  if (!history || history.length < period) return 0;
  const closes = history.slice(-period).map(h => h.close || h.nav || 0).filter(v => v > 0);
  if (closes.length < 2) return 0;
  return (closes[closes.length - 1] - closes[0]) / closes[0];
}

function calcMomentumAccel(history, shortPeriod = 5, longPeriod = 15) {
  return calcMomentum(history, shortPeriod) - calcMomentum(history, longPeriod);
}

function calcRelativeStrength(fundHistory, benchHistory, period = 10) {
  return calcMomentum(fundHistory, period) - calcMomentum(benchHistory, period);
}

function calcVolumeChange(history, period = 5) {
  if (!history || history.length < period + 5) return 0;
  const recent = history.slice(-period).reduce((s, h) => s + (h.volume || 0), 0);
  const prev = history.slice(-period * 2, -period).reduce((s, h) => s + (h.volume || 0), 0);
  if (prev === 0) return 0;
  return recent / prev - 1;
}

// 全赛道关键词 → 赛道名
const SECTOR_MAP = {
  // 科技子赛道
  '芯片': 'AI芯片', '半导体': 'AI芯片', '集成电路': 'AI芯片', '算力': 'AI芯片',
  '电池': '电池新能源', '新能源': '电池新能源', '锂电': '电池新能源', '储能': '电池新能源', '光伏': '电池新能源', '风电': '电池新能源',
  '信息': '互联网科技', '互联网': '互联网科技', 'TMT': '互联网科技', '软件': '互联网科技',
  '科创': '科创宽基', '创业板': '科创宽基',
  '传媒': '传媒游戏', '游戏': '传媒游戏', '动漫': '传媒游戏',
  // 非科技赛道 — 轮动用
  '白酒': '消费白酒', '消费': '消费白酒', '食品': '消费白酒', '饮料': '消费白酒', '家电': '消费白酒',
  '医药': '医药医疗', '医疗': '医药医疗', '创新药': '医药医疗', '生物': '医药医疗', '中药': '医药医疗',
  '军工': '军工国防', '国防': '军工国防', '航天': '军工国防', '航空': '军工国防',
  '金融': '金融地产', '银行': '金融地产', '保险': '金融地产', '证券': '金融地产', '券商': '金融地产', '地产': '金融地产', '房地产': '金融地产',
  '红利': '红利高息', '高股息': '红利高息', '股息': '红利高息', '分红': '红利高息',
  '汽车': '汽车智驾', '新能源车': '汽车智驾', '智能驾驶': '汽车智驾', '自动驾驶': '汽车智驾',
  '有色': '资源周期', '黄金': '资源周期', '煤炭': '资源周期', '石油': '资源周期', '钢铁': '资源周期', '稀土': '资源周期',
  '全球': 'QDII海外', 'QDII': 'QDII海外', '纳斯达克': 'QDII海外', '港股': 'QDII海外', '恒生': 'QDII海外',
};

function getSector(fund) {
  const name = fund.name || '';
  for (const [kw, sector] of Object.entries(SECTOR_MAP)) {
    if (name.includes(kw)) return sector;
  }
  return null;
}

/**
 * 检测全赛道轮动信号
 */
function detectRotation(rankedFunds) {
  const sectors = {};
  const allSectorFunds = [];

  for (const fund of rankedFunds) {
    if (!fund.score || fund.score < 40) continue;
    const sector = getSector(fund);
    if (!sector) continue;
    if (!sectors[sector]) sectors[sector] = [];
    sectors[sector].push(fund);
    allSectorFunds.push({ ...fund, _sector: sector });
  }

  const sectorList = Object.entries(sectors);
  if (sectorList.length < 3) return [];

  // 每赛道取最强代表
  const sectorReps = {};
  for (const [name, funds] of sectorList) {
    sectorReps[name] = funds.sort((a, b) => b.score - a.score)[0];
  }

  // 用沪深300相关基金做基准, 没有就用第一个
  const bench = sectorReps['科创宽基'] || sectorReps['消费白酒'] || Object.values(sectorReps)[0];
  if (!bench) return [];

  // 计算每个赛道的综合动量得分
  const sectorScores = {};
  for (const [name, fund] of Object.entries(sectorReps)) {
    const history = fund.history || [];
    const accel = calcMomentumAccel(history, 5, 15);
    const relStr = calcRelativeStrength(history, bench.history || history, 10);
    const mom5 = calcMomentum(history, 5);
    const mom10 = calcMomentum(history, 10);
    const volChg = calcVolumeChange(history, 5);

    sectorScores[name] = {
      fund,
      momentum5: mom5,
      momentum10: mom10,
      accel,
      relStrength: relStr,
      volumeChange: volChg,
      fundScore: fund.score || 0,
      // 综合轮动分: 加速度权重最高
      rotationScore: accel * 100 + relStr * 50 + mom5 * 30 + volChg * 20 + fund.score * 0.3,
    };
  }

  // 排序: 轮动分从高到低
  const ranked = Object.entries(sectorScores)
    .sort((a, b) => b[1].rotationScore - a[1].rotationScore);

  const signals = [];

  // 信号1: 最强vs最弱轮动对 (差距>15)
  const strongest = ranked[0];
  const weakest = ranked[ranked.length - 1];
  const gap = strongest[1].rotationScore - weakest[1].rotationScore;

  if (gap > 15) {
    const sM = strongest[1];
    const wM = weakest[1];
    let detail;
    if (sM.accel > 0.02 && wM.accel < 0) detail = `${wM.momentum5>=0?'涨速放缓':'走弱'}→${sM.momentum5>=0.03?'加速上攻':'企稳转强'}`;
    else if (sM.momentum5 > 0.05 && wM.momentum5 < 0) detail = '强动量碾压弱赛道';
    else detail = '资金持续流入强赛道';

    signals.push({
      type: 'rotation',
      fromSector: weakest[0], fromFund: weakest[1].fund,
      toSector: strongest[0], toFund: strongest[1].fund,
      strength: gap > 30 ? 'strong' : 'moderate',
      detail,
    });
  }

  // 信号2: 动量突破 (加速度>3%且5日>10日)
  for (const [name, metrics] of Object.entries(sectorScores)) {
    if (name === strongest[0]) continue;
    if (metrics.accel > 0.03 && metrics.momentum5 > metrics.momentum10) {
      signals.push({
        type: 'momentum_breakout',
        sector: name, fund: metrics.fund,
        detail: `5日+${(metrics.momentum5*100).toFixed(1)}% 超越10日+${(metrics.momentum10*100).toFixed(1)}%`,
      });
    }
  }

  // 信号3: 下跌中企稳转涨 (5日>0但10日<0, 可能是反转)
  for (const [name, metrics] of Object.entries(sectorScores)) {
    if (metrics.momentum5 > 0.01 && metrics.momentum10 < -0.02 && metrics.accel > 0.04) {
      signals.push({
        type: 'reversal',
        sector: name, fund: metrics.fund,
        detail: `跌后企稳反弹 10日${(metrics.momentum10*100).toFixed(1)}%→5日+${(metrics.momentum5*100).toFixed(1)}%`,
      });
    }
  }

  // 信号4: 量能异动 (成交量剧增>50%但动量未跟上, 可能埋伏)
  for (const [name, metrics] of Object.entries(sectorScores)) {
    if (metrics.volumeChange > 0.5 && metrics.momentum5 < 0.03 && metrics.momentum5 > -0.02) {
      signals.push({
        type: 'volume_alert',
        sector: name, fund: metrics.fund,
        detail: `成交量暴增${(metrics.volumeChange*100).toFixed(0)}% 可能即将突破`,
      });
    }
  }

  return signals.slice(0, 6);
}

module.exports = { detectRotation, getSector };
