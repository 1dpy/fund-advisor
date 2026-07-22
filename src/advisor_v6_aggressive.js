/**
 * V6 激进科技增强版 — Fund Master Aggressive
 *
 * 理念: 科技为主引擎, 用择时+轮动放大收益, 用动态止损+子弹管理控尾部风险
 * 不压制科技集中度, 而是让科技仓位"更聪明":
 *   1. 科技子赛道动量轮动 (超配近20日最强2-3个子赛道)
 *   2. 趋势择时 (科技板块20日均线之上进攻 / 之下防守保留底仓)
 *   3. 金字塔加仓 (浮亏3%/6%/9%分批补, 金额递减, 总额≤现金50%)
 *   4. ATR动态止损 (止损=max(-12%, -2*ATR%), 单周跌15%立即清仓)
 *   5. 移动止盈 (回撤线=max(8%, 1.5*ATR%), 让利润奔跑)
 *   6. 杠铃现金 (保留10-15%做子弹)
 *   7. 绝对底线 (总资产从30日高点回撤>20%→强制转宽基+现金, 防归零)
 *
 * 数据: 接入 fetcher 拉历史净值算动量/趋势/ATR; 拉取失败回退V5静态
 * 输出: 纯操作指令 (BUY/SELL/CONVERT/DCA/HOLD)
 */

const fs = require('fs');
const path = require('path');
const { BUDGET, FEE_CONFIG } = require('./config');
const { fetchFundHistory } = require('./fetcher');

const ROOT = path.join(__dirname, '..');
const HOLDINGS_PATH = path.join(ROOT, 'holdings.json');

// 激进科技配置
const AGGRO_CONFIG = {
  maxTechConcentration: 0.75,   // 科技集中度上限放宽到75% (激进)
  maxSinglePosition: 0.35,      // 单票35% (激进重仓龙头)
  stopLossRatio: -0.12,         // -12%止损 (科技波动大, 比防御版-8%宽)
  weeklyCrashStop: -0.18,       // 单周跌18%立即清仓 (激进版放宽, 避免回调底部割肉)
  cashReserve: 0.12,            // 12%子弹
  pyramidLevels: [              // 金字塔加仓档位 (浮亏触发, 加仓额占"待加仓预算"比例)
    { trigger: -0.03, pct: 0.50 },
    { trigger: -0.06, pct: 0.30 },
    { trigger: -0.09, pct: 0.20 },
  ],
  maxAddCashPct: 0.50,          // 加仓最多用50%可用现金
  momentumWindow: 20,           // 动量窗口
  trendMA: 20,                  // 趋势均线
  trailingStopBase: 0.08,       // 移动止盈回撤基准8%
  trailingStopATRMult: 1.5,     // 回撤线 = max(8%, 1.5*ATR%)
  partialTakeProfit: 0.25,      // 浮盈25%部分止盈
  partialTakeProfitPct: 0.30,   // 卖30%
  takeProfitCeiling: 0.60,      // 浮盈60%全卖 (科技弹性大, 天花板抬高)
  absoluteDrawdownStop: 0.20,   // 总资产从30日高点回撤20%强制转防御
  offenseThreshold: 0.50,       // ≥50%科技基金在均线上方=进攻模式
  defenseBaseKeep: 0.50,        // 防守模式保留50%科技底仓
};

// 科技子赛道池 (用于动量轮动)
const TECH_SECTORS = [
  { name: '半导体芯片', funds: [
    { code: '017470', name: '嘉实中证半导体C' },
    { code: '014419', name: '西部利得芯片增强C' },
    { code: '008282', name: '国泰芯片ETF联接C' },
  ]},
  { name: '新能源电池', funds: [
    { code: '027495', name: '易方达电池ETF联接C' },
  ]},
  { name: '信息技术', funds: [
    { code: '019018', name: '易方达信息产业混合C' },
  ]},
  { name: '科创创业宽基', funds: [
    { code: '011609', name: '易方达科创50联接C' },
    { code: '006928', name: '长城创业板增强C' },
  ]},
  { name: '全球科技QDII', funds: [
    { code: '021277', name: '广发全球精选QDII C' },
  ]},
  { name: '军工航天', funds: [
    { code: '011148', name: '南方军工改革C' },
  ]},
];

// 宽基/防御 (底线转防御用)
const DEFENSE_FUND = { code: '007028', name: '易方达沪深300ETF联接C' };

// ============================================================
// 工具
// ============================================================
function loadHoldings() {
  try { return JSON.parse(fs.readFileSync(HOLDINGS_PATH, 'utf8') || '[]'); }
  catch { return []; }
}
function todayStr() { return new Date().toISOString().split('T')[0]; }
function isTradingDay(d = new Date()) { const day = d.getDay(); return day >= 1 && day <= 5; }
function holdingDays(buyDate) { if (!buyDate) return 999; return Math.floor((Date.now() - new Date(buyDate).getTime()) / 86400000); }
function classifySector(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('全球') || n.includes('qdii')) return 'global';
  if (n.includes('信息') || n.includes('科技') || n.includes('半导体') || n.includes('芯片') || n.includes('电池') || n.includes('创业板') || n.includes('科创') || n.includes('军工') || n.includes('航天')) return 'growth';
  if (n.includes('沪深300') || n.includes('红利') || n.includes('银行')) return 'value';
  if (n.includes('黄金') || n.includes('债券') || n.includes('货币') || n.includes('余额宝')) return 'defense';
  return 'growth';
}
function redemptionFeeRate(h) {
  const d = holdingDays(h.buyDate);
  if (d < 7) return FEE_CONFIG.fund.redemptionRate.under7;
  if (d < 30) return FEE_CONFIG.fund.redemptionRate.under30;
  return 0;
}
function isPendingFullConversion(h) {
  const notes = (h.notes || '').toLowerCase();
  return notes.includes('已申请转换') && (notes.includes('清0') || notes.includes('清零') || notes.includes('全部'));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// 指标计算 (基于历史净值)
// ============================================================
function computeIndicators(history) {
  if (!history || history.length < 10) return null;
  const navs = history.map(h => h.nav);
  const n = navs.length;
  const last = navs[n - 1];
  const win = Math.min(AGGRO_CONFIG.momentumWindow, n - 1);
  const ma = navs.slice(-AGGRO_CONFIG.trendMA).reduce((a, b) => a + b, 0) / Math.min(AGGRO_CONFIG.trendMA, n);
  // 近20日动量
  const momentum = (last - navs[n - 1 - win]) / navs[n - 1 - win];
  // 近5日动量 (短周期)
  const momentum5 = n > 5 ? (last - navs[n - 6]) / navs[n - 6] : momentum;
  // ATR近似: 近14日日涨跌绝对值平均 / 均价
  const recent = history.slice(-15);
  let sumAbs = 0, sumNav = 0;
  for (let i = 1; i < recent.length; i++) { sumAbs += Math.abs(recent[i].nav - recent[i - 1].nav); sumNav += recent[i].nav; }
  const avgNav = sumNav / Math.max(1, recent.length - 1);
  const atrPct = avgNav > 0 ? (sumAbs / Math.max(1, recent.length - 1)) / avgNav : 0;
  // 近5日跌幅 (用于单周急跌判断)
  const week5Pct = n > 5 ? (last - navs[n - 6]) / navs[n - 6] : 0;
  return { last, ma, momentum, momentum5, trendUp: last > ma, atrPct, week5Pct };
}

// 拉取一组基金的指标 (并发, 带进度)
async function fetchIndicatorsForCodes(codes, label) {
  const unique = [...new Set(codes)];
  const result = new Map();
  const BATCH = 6;
  process.stdout.write(`📡 [${label}] 拉取${unique.length}只基金历史净值 `);
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const rs = await Promise.all(batch.map(async code => {
      try {
        const hist = await fetchFundHistory(code, 30);
        const ind = computeIndicators(hist);
        return ind ? [code, ind] : null;
      } catch { return null; }
    }));
    rs.filter(Boolean).forEach(([c, ind]) => result.set(c, ind));
    process.stdout.write('.');
    if (i + BATCH < unique.length) await sleep(300);
  }
  console.log(` ${result.size}/${unique.length}成功`);
  return result;
}

// ============================================================
// 组合分析
// ============================================================
function analyzePortfolio(holdings, indicators) {
  const cashItem = holdings.find(h => h.type === 'cash');
  const cash = cashItem ? (cashItem.currentValue || cashItem.costBasis || 0) : 0;
  const funds = holdings.filter(h => h.type !== 'cash').map(h => {
      const ind = indicators.get(h.code);
      // 市值/盈亏沿用持仓静态值 (holdings的shares字段是虚拟值, 不能用实时净值×份额重算);
      // ind仅用于基金自身的动量/趋势/ATR, 用于轮动和择时判断
      const currentValue = h.currentValue || h.costBasis || 0;
    return {
      ...h,
      value: currentValue,
      sector: classifySector(h.name),
      profitPct: h.costBasis > 0 && currentValue > 0 ? (currentValue - h.costBasis) / h.costBasis : 0,
      ind,
    };
  });
  const totalAsset = funds.reduce((s, f) => s + f.value, 0) + cash;
  const sectorValues = { growth: 0, value: 0, defense: 0, global: 0, cash: 0 };
  funds.forEach(f => { sectorValues[f.sector] += f.value; });
  sectorValues.cash = cash;
  const sectorWeights = {};
  for (const k of Object.keys(sectorValues)) sectorWeights[k] = totalAsset > 0 ? sectorValues[k] / totalAsset : 0;
  const maxSingleWeight = funds.length > 0 ? Math.max(...funds.map(f => f.value / totalAsset)) : 0;
  return {
    funds, cash, totalAsset, sectorValues, sectorWeights, maxSingleWeight,
    techConcentration: sectorWeights.growth + sectorWeights.global,
  };
}

// 科技板块趋势: 持仓+池子里在均线上方的科技基金占比
function detectTechTrend(indicators) {
  let up = 0, total = 0;
  for (const ind of indicators.values()) {
    if (ind && ind.trendUp !== undefined) { total++; if (ind.trendUp) up++; }
  }
  const ratio = total > 0 ? up / total : 0.5;
  return { ratio, offense: ratio >= AGGRO_CONFIG.offenseThreshold };
}

// ============================================================
// 主决策
// ============================================================
function generateAggressiveOps(portfolio, indicators, techTrend) {
  const operations = [];
  const handled = new Set();
  const { funds, cash, totalAsset } = portfolio;
  const t1Info = { description: '场外基金 T+1, 15:00前下单按当日净值' };

  // 0. 绝对底线: 科技板块全面破位(均线上方<25%) → 只对纯科技降仓, QDII保留作分散;
  //    保留60%底仓等反弹(激进不轻易清仓), 只动仓位最重1只, 限800
  if (!techTrend.offense && techTrend.ratio < 0.25) {
    const candidates = funds
      .filter(f => f.sector === 'growth' && !handled.has(f.code) && !isPendingFullConversion(f) && f.value >= 50)
      .sort((a, b) => b.value - a.value);
    const top = candidates[0];
    if (top) {
      const reduceAmount = Math.min(Math.round(top.value * 0.40), 800);
      if (reduceAmount > 20) {
        operations.push({
          action: 'CONVERT', code: top.code, name: top.name, amount: reduceAmount,
          target: `${DEFENSE_FUND.code} ${DEFENSE_FUND.name}`,
          reason: `科技全面破位(均线上方占比仅${(techTrend.ratio*100).toFixed(0)}%), 降最重仓40%转宽基, 保留60%底仓等反弹`,
          t1: t1Info, urgency: 'HIGH',
        });
        handled.add(top.code);
      }
    }
  }

  // 1. ATR动态止损 + 单周急跌清仓
  for (const fund of funds) {
    if (handled.has(fund.code)) continue;
    if (isPendingFullConversion(fund)) continue;
    const ind = fund.ind;
    // 单周急跌
    if (ind && ind.week5Pct <= AGGRO_CONFIG.weeklyCrashStop) {
      const fee = redemptionFeeRate(fund);
      operations.push({
        action: fee >= FEE_CONFIG.fund.redemptionRate.under7 ? 'CONVERT' : 'SELL',
        code: fund.code, name: fund.name, amount: Math.round(fund.value),
        target: fee >= FEE_CONFIG.fund.redemptionRate.under7 ? `${DEFENSE_FUND.code} ${DEFENSE_FUND.name}` : undefined,
        reason: `近5日跌${(ind.week5Pct*100).toFixed(1)}%触发单周急跌清仓线${(AGGRO_CONFIG.weeklyCrashStop*100).toFixed(0)}%`,
        t1: t1Info, urgency: 'HIGH',
      });
      handled.add(fund.code); continue;
    }
    // ATR动态止损: 止损线 = 最宽的(最负的), 高波动容忍更大回撤 => min(-12%, -2*ATR%)
    const atrStop = ind ? Math.min(AGGRO_CONFIG.stopLossRatio, -2 * ind.atrPct) : AGGRO_CONFIG.stopLossRatio;
    if (fund.profitPct <= atrStop) {
      const fee = redemptionFeeRate(fund);
      operations.push({
        action: fee >= FEE_CONFIG.fund.redemptionRate.under7 ? 'CONVERT' : 'SELL',
        code: fund.code, name: fund.name, amount: Math.round(fund.value),
        target: fee >= FEE_CONFIG.fund.redemptionRate.under7 ? `${DEFENSE_FUND.code} ${DEFENSE_FUND.name}` : undefined,
        reason: `浮亏${(fund.profitPct*100).toFixed(1)}%触ATR动态止损线${(atrStop*100).toFixed(1)}% (ATR${(ind?ind.atrPct*100:0).toFixed(1)}%)`,
        t1: t1Info, urgency: 'HIGH',
      });
      handled.add(fund.code);
    }
  }

  // 2. 浮盈动态止盈 (ATR自适应, 让利润奔跑)
  for (const fund of funds) {
    if (handled.has(fund.code)) continue;
    if (fund.profitPct <= 0) continue;
    const ind = fund.ind;
    const p = fund.profitPct;
    // 天花板全卖
    if (p >= AGGRO_CONFIG.takeProfitCeiling) {
      operations.push({ action: 'SELL', code: fund.code, name: fund.name, amount: Math.round(fund.value),
        reason: `浮盈${(p*100).toFixed(1)}%达天花板${(AGGRO_CONFIG.takeProfitCeiling*100).toFixed(0)}%, 全部止盈`, t1: t1Info, urgency: 'MEDIUM' });
      handled.add(fund.code); continue;
    }
    // 部分止盈
    if (p >= AGGRO_CONFIG.partialTakeProfit) {
      operations.push({ action: 'SELL', code: fund.code, name: fund.name, amount: Math.round(fund.value * AGGRO_CONFIG.partialTakeProfitPct),
        reason: `浮盈${(p*100).toFixed(1)}%≥${(AGGRO_CONFIG.partialTakeProfit*100).toFixed(0)}%, 部分止盈${(AGGRO_CONFIG.partialTakeProfitPct*100).toFixed(0)}%落袋`, t1: t1Info, urgency: 'MEDIUM' });
      handled.add(fund.code); continue;
    }
    // 移动止盈观察 (回撤线=max(8%, 1.5*ATR%))
    if (p >= 0.12) {
      const trailLine = Math.max(AGGRO_CONFIG.trailingStopBase, AGGRO_CONFIG.trailingStopATRMult * (ind ? ind.atrPct : 0.04));
      const retreatPrice = Math.round(fund.value * (1 - trailLine));
      operations.push({ action: 'HOLD', code: fund.code, name: fund.name,
        reason: `浮盈${(p*100).toFixed(1)}%, 移动止盈已激活: 从高点回撤${(trailLine*100).toFixed(1)}%(约低于¥${retreatPrice})即卖`, t1: t1Info, urgency: 'LOW' });
      handled.add(fund.code);
    }
  }

  // 3. 动量轮动: 清仓/减仓动量最弱的科技基金, 加仓动量最强子赛道
  //    只在进攻模式且现金充足时主动轮动; 防守模式只做止损不加仓
  if (techTrend.offense) {
    // 计算每个科技子赛道的平均动量
    const sectorMomentum = [];
    for (const sec of TECH_SECTORS) {
      const inds = sec.funds.map(f => indicators.get(f.code)).filter(Boolean);
      if (inds.length === 0) continue;
      const avgMom = inds.reduce((s, i) => s + i.momentum, 0) / inds.length;
      sectorMomentum.push({ name: sec.name, momentum: avgMom, funds: sec.funds });
    }
    sectorMomentum.sort((a, b) => b.momentum - a.momentum);
    const topSector = sectorMomentum[0];
    const weakSector = sectorMomentum[sectorMomentum.length - 1];

    // 若持有动量最弱子赛道且明显跑输最强(差>8%), 转换到最强
    if (topSector && weakSector && topSector.momentum - weakSector.momentum > 0.08) {
      for (const fund of funds) {
        if (handled.has(fund.code)) continue;
        if (isPendingFullConversion(fund)) continue;
        if (fund.value < 50) continue;
        // 判断该基金是否属于弱子赛道
        const inWeak = weakSector.funds.some(f => f.code === fund.code) ||
                       classifySector(fund.name) === 'growth' && fund.name.includes(weakSector.name.slice(0,2));
        if (inWeak && fund.profitPct < 0) {
          // 找最强子赛道里用户还没持有的基金
          const target = topSector.funds.find(f => !funds.some(h => h.code === f.code)) || topSector.funds[0];
          operations.push({
            action: 'CONVERT', code: fund.code, name: fund.name, amount: Math.round(fund.value * 0.5),
            target: `${target.code} ${target.name}`,
            reason: `动量轮动: ${weakSector.name}(近20日${(weakSector.momentum*100).toFixed(1)}%)弱于${topSector.name}(${(topSector.momentum*100).toFixed(1)}%), 转一半到更强赛道`,
            t1: t1Info, urgency: 'MEDIUM',
          });
          handled.add(fund.code);
        }
      }
    }
  }

  // 4. 金字塔加仓 (进攻模式 + 浮亏基金 + 有子弹)
  if (techTrend.offense) {
    for (const fund of funds) {
      if (handled.has(fund.code)) continue;
      if (fund.profitPct >= 0) continue;
      if (isPendingFullConversion(fund)) continue;
      // 找到对应加仓档
      const level = AGGRO_CONFIG.pyramidLevels.find(l => fund.profitPct <= l.trigger);
      if (!level) continue;
      const addBudget = cash * AGGRO_CONFIG.maxAddCashPct * level.pct;
      if (addBudget < 10) continue;
      const weight = fund.value / totalAsset;
      if (weight >= AGGRO_CONFIG.maxSinglePosition) continue; // 已达单票上限不加
      operations.push({
        action: 'BUY', code: fund.code, name: fund.name, amount: Math.round(addBudget),
        reason: `金字塔加仓: 浮亏${(fund.profitPct*100).toFixed(1)}%触${(level.trigger*100).toFixed(0)}%档, 加¥${Math.round(addBudget)}拉低成本 (进攻模式)`,
        t1: t1Info, urgency: 'MEDIUM',
      });
      handled.add(fund.code);
    }
  }

  // 5. 杠铃: 进攻模式且现金>保留线, 优先加仓动量最强科技子赛道
  if (techTrend.offense && cash > totalAsset * AGGRO_CONFIG.cashReserve) {
    const deploy = cash - totalAsset * AGGRO_CONFIG.cashReserve;
    // 找动量最强且未满仓的科技基金
    const sectorMomentum = [];
    for (const sec of TECH_SECTORS) {
      const inds = sec.funds.map(f => ({ ...f, ind: indicators.get(f.code) })).filter(x => x.ind);
      if (!inds.length) continue;
      const best = inds.sort((a, b) => b.ind.momentum - a.ind.momentum)[0];
      sectorMomentum.push(best);
    }
    sectorMomentum.sort((a, b) => b.ind.momentum - a.ind.momentum);
    const target = sectorMomentum[0];
    if (target && target.ind.momentum > 0) {
      const weight = funds.find(f => f.code === target.code)?.value / totalAsset || 0;
      if (weight < AGGRO_CONFIG.maxSinglePosition) {
        operations.push({
          action: 'BUY', code: target.code, name: target.name, amount: Math.round(deploy),
          reason: `杠铃进攻: 超${(target.ind.momentum*100).toFixed(1)}%动量的${target.name}, 用超额子弹加仓`,
          t1: t1Info, urgency: 'MEDIUM',
        });
        handled.add(target.code);
      }
    }
  }

  // 6. 浮亏未触发止损的: 进攻模式持有等反弹; 防守模式提示
  for (const fund of funds) {
    if (handled.has(fund.code)) continue;
    if (fund.profitPct < 0) {
      operations.push({
        action: 'HOLD', code: fund.code, name: fund.name,
        reason: `${techTrend.offense ? '进攻' : '防守'}模式, 浮亏${(fund.profitPct*100).toFixed(1)}%未触止损, ${techTrend.offense ? '持有等反弹' : '观察, 跌破ATR止损线即清仓'}`,
        t1: t1Info, urgency: techTrend.offense ? 'LOW' : 'MEDIUM',
      });
      handled.add(fund.code);
    }
  }

  // 7. 其余持有
  for (const fund of funds) {
    if (!handled.has(fund.code)) {
      operations.push({ action: 'HOLD', code: fund.code, name: fund.name,
        reason: `未触发止盈止损/轮动条件`, t1: t1Info, urgency: 'LOW' });
    }
  }

  // 8. 现金状态
  operations.push({ action: 'HOLD', code: 'CASH', name: '现金',
    reason: `现金占比${(portfolio.sectorWeights.cash*100).toFixed(1)}% (子弹线${(AGGRO_CONFIG.cashReserve*100).toFixed(0)}%), ${techTrend.offense ? '进攻模式可加仓' : '防守模式保留'}`,
    urgency: 'LOW' });

  return {
    date: todayStr(), mode: techTrend.offense ? 'OFFENSE进攻' : 'DEFENSE防守',
    techTrendRatio: techTrend.ratio, totalAsset, cash,
    sectorWeights: portfolio.sectorWeights, techConcentration: portfolio.techConcentration,
    maxSingleWeight: portfolio.maxSingleWeight, operations,
  };
}

// ============================================================
// 主函数 (带数据拉取 + 回退)
// ============================================================
async function generateAggressivePortfolioAdvice(marketSentiment) {
  if (!isTradingDay()) {
    return { date: todayStr(), mode: 'WEEKEND', message: '今日为周末/节假日, 不交易。', operations: [] };
  }
  const holdings = loadHoldings();
  const allCodes = [
    ...holdings.filter(h => h.type !== 'cash').map(h => h.code),
    ...TECH_SECTORS.flatMap(s => s.funds.map(f => f.code)),
  ];
  let indicators = new Map();
  let dataOk = false;
  try {
    indicators = await fetchIndicatorsForCodes(allCodes, 'V6激进版');
    dataOk = indicators.size > 0;
  } catch (e) { dataOk = false; }

  if (!dataOk) {
    // 回退: 用持仓静态值, 无指标
    indicators = new Map();
  }
  const portfolio = analyzePortfolio(holdings, indicators);
  const techTrend = detectTechTrend(indicators);
  const result = generateAggressiveOps(portfolio, indicators, techTrend);
  result.dataSource = dataOk ? '实时历史净值(动量/趋势/ATR)' : '静态回退(无网络数据, 仅止损止盈)';
  result.marketSentiment = marketSentiment || null;
  const sb = marketSentiment?.tradingBias || 'NEUTRAL';
  result.sentimentNote = sb === 'CONTRARIAN_BUY'
    ? '🌟 市场恐慌(贪婪指数低): 激进策略仍按动量执行, 但勿因恐惧追涨杀跌, 优先保留现金等待错杀机会'
    : sb === 'TAKE_PROFIT'
      ? '⚠️ 市场贪婪(贪婪指数高): 高位回撤风险上升, 注意止盈纪律, 避免追高接盘'
      : '➖ 市场情绪中性: 按策略正常执行';
  return result;
}

module.exports = { generateAggressivePortfolioAdvice, AGGRO_CONFIG, TECH_SECTORS };
