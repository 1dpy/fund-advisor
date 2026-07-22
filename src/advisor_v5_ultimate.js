/**
 * V5 终极版决策引擎 — 基金助手·终极版 (Fund Master Ultimate)
 *
 * 核心改进:
 *   1. 大类资产配置目标 (成长/价值/防御/全球/现金) + 偏离再平衡
 *   2. 单票 ≤20%、科技集中度 ≤50%、现金 ≥10% 的硬性约束
 *   3. 严格止损 (-8%硬止损) + 移动止盈 (15%激活)
 *   4. 凯利改良 + 风险平价仓位计算
 *   5. 支付宝 T+1、C类<7天1.5%赎回费、QDII每日限购处理
 *   6. 周末/节假日不交易
 *
 * 输出: 纯操作指令 (BUY/SELL/SWAP/CONVERT/DCA/HOLD)
 */

const fs = require('fs');
const path = require('path');
const { BUDGET, WATCHLIST, FEE_CONFIG, RISK_CONFIG, STRATEGY, STRATEGY_CONFIG, PREFERRED_SECTORS, MAX_DEPLOY_SECTORS, REALTIME_PICK_COUNT } = require('./config');

const ROOT = path.join(__dirname, '..');
const HOLDINGS_PATH = path.join(ROOT, 'holdings.json');
const META_PATH = path.join(ROOT, 'data', 'meta_params.json');

// 持续自我迭代产出的元参数: 每次运行刷新, 决定动态选基的取前 N 只(topK)与因子权重
function loadMetaParams() {
  try { return JSON.parse(fs.readFileSync(META_PATH, 'utf8')); } catch (e) { return null; }
}
const META = loadMetaParams();
const EFFECTIVE_PICK_COUNT = (META && META.selfParams && META.selfParams.topK)
  ? Math.max(2, Math.min(MAX_DEPLOY_SECTORS, META.selfParams.topK))
  : REALTIME_PICK_COUNT;

// ============================================================
// 1. 工具函数
// ============================================================
function loadHoldings() {
  try {
    const raw = fs.readFileSync(HOLDINGS_PATH, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    return [];
  }
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function isTradingDay(date = new Date()) {
  const day = date.getDay();
  return day >= 1 && day <= 5; // 周一到周五
}

function holdingDays(buyDate) {
  if (!buyDate) return 999;
  return Math.floor((Date.now() - new Date(buyDate).getTime()) / 86400000);
}

function classifySector(fundName) {
  const n = (fundName || '').toLowerCase();
  if (n.includes('全球') || n.includes('qdii')) return 'global';
  if (n.includes('信息') || n.includes('科技') || n.includes('半导体') || n.includes('芯片') || n.includes('电池') || n.includes('创业板') || n.includes('科创') || n.includes('恒生科技') || n.includes('中概') || n.includes('互联网')) return 'growth';
  if (n.includes('沪深300') || n.includes('红利') || n.includes('银行') || n.includes('建筑') || n.includes('传媒') || n.includes('医疗')) return 'value';
  if (n.includes('黄金') || n.includes('债券') || n.includes('短债') || n.includes('货币') || n.includes('余额宝')) return 'defense';
  return 'growth'; // 默认成长
}

function isPendingConversion(holding) {
  const notes = (holding.notes || '').toLowerCase();
  // 仅当该基已基本全部转出或已申请完全转换时才阻止
  return notes.includes('已申请转换') && (notes.includes('清0') || notes.includes('清零') || notes.includes('全部'));
}

function isGlobalDiversification(fundName) {
  const n = (fundName || '').toLowerCase();
  return n.includes('全球') || n.includes('qdii') || n.includes('纳斯达克') || n.includes('标普');
}

// 根据当前组合给出最优先需要转换的基金, 避免一次动太多
function selectConversionTargets(funds, totalAsset, alreadyConverted) {
  // 优先: 仓位最重且非QDII的成长基金; 避开已转换/在途的
  return funds
    .filter(f => f.sector === 'growth' && !isGlobalDiversification(f.name) && !alreadyConverted.has(f.code))
    .filter(f => !isPendingConversion(f))
    .filter(f => !f.locked) // 框架锁定基金不参与转换
    .filter(f => f.value / totalAsset > 0.05) // 至少占比5%才转换
    .sort((a, b) => (b.value / totalAsset) - (a.value / totalAsset));
}

function redemptionFeeRate(holding) {
  const d = holdingDays(holding.buyDate);
  if (d < 7) return FEE_CONFIG.fund.redemptionRate.under7;
  if (d < 30) return FEE_CONFIG.fund.redemptionRate.under30;
  return 0;
}

// ============================================================
// 2. 当前组合分析
// ============================================================
function analyzePortfolio(holdings) {
  const cashItem = holdings.find(h => h.type === 'cash');
  const cash = cashItem ? (cashItem.currentValue != null ? cashItem.currentValue : (cashItem.costBasis || 0)) : 0;

  const funds = holdings.filter(h => h.type !== 'cash').map(h => ({
    ...h,
    locked: h.locked || false,
    value: h.currentValue != null ? h.currentValue : (h.costBasis || 0),
    sector: classifySector(h.name),
    profitPct: h.costBasis > 0 && h.currentValue > 0
      ? (h.currentValue - h.costBasis) / h.costBasis
      : 0,
  }));

  const totalAsset = funds.reduce((s, f) => s + f.value, 0) + cash;

  const sectorValues = { growth: 0, value: 0, defense: 0, global: 0, cash: 0 };
  funds.forEach(f => { sectorValues[f.sector] += f.value; });
  sectorValues.cash = cash;

  const sectorWeights = {};
  for (const k of Object.keys(sectorValues)) {
    sectorWeights[k] = totalAsset > 0 ? sectorValues[k] / totalAsset : 0;
  }

  const maxSingleWeight = funds.length > 0 ? Math.max(...funds.map(f => f.value / totalAsset)) : 0;

  return {
    funds,
    cash,
    totalAsset,
    sectorValues,
    sectorWeights,
    maxSingleWeight,
    techConcentration: sectorWeights.growth, // 仅A股成长赛道算集中度; QDII(广发全球)是分散配置, 不算集中风险
  };
}

// ============================================================
// 3. 市场体制判断 (简化版, 可后续接入实时数据)
// ============================================================
function detectMarketRegime(portfolio) {
  // 简化: 根据科技/成长持仓亏损程度判断体制
  // 后续应接入沪深300/中证500/创业板趋势
  // 注: 排除锁定仓(框架冻结, 不应主导市场体制判断)
  const growthFunds = portfolio.funds.filter(f => f.sector === 'growth' && !f.locked);
  const avgGrowthLoss = growthFunds.length > 0
    ? growthFunds.reduce((s, f) => s + f.profitPct, 0) / growthFunds.length
    : 0;

  if (avgGrowthLoss < -0.10) return { regime: 'BEAR', confidence: 70 };
  if (avgGrowthLoss < -0.05) return { regime: 'WEAK_SIDEWAYS', confidence: 60 };
  if (avgGrowthLoss > 0.05) return { regime: 'BULL', confidence: 60 };
  return { regime: 'SIDEWAYS', confidence: 50 };
}

// ============================================================
// 4. 配置偏离检查
// ============================================================
function checkAllocationDrift(portfolio, regime, strategy) {
  const cfg = strategy || STRATEGY_CONFIG[STRATEGY] || STRATEGY_CONFIG.CONSERVATIVE;
  const target = { ...(cfg.strategicAllocation || RISK_CONFIG.strategicAllocation) };

  // 根据体制调整目标: 熊市/弱震荡降低成长, 增加防御和现金
  // 赚钱优先模式下: 熊市回调恰恰是分批建仓机会, 故只微调、不大幅砍成长
  if (regime === 'BEAR' || regime === 'WEAK_SIDEWAYS') {
    if (STRATEGY === 'PROFIT_FIRST') {
      // 赚钱优先: 回调即分批建仓, 且用户偏好高弹性赛道(不爱宽基), 故不抬升 value(宽基)
      target.growth = Math.min(target.growth, 0.30);
      target.value = Math.max(target.value, 0.05);   // 不补宽基, 保持低
      target.defense = Math.max(target.defense, 0.18);
      target.global = Math.min(target.global, 0.27);
      target.cash = cfg.cashTarget != null ? cfg.cashTarget : 0.08;
    } else {
      target.growth = 0.20;
      target.value = 0.30;
      target.defense = 0.25;
      target.global = 0.15;
      target.cash = 0.10;
    }
  }

  const drift = {};
  for (const k of Object.keys(target)) {
    drift[k] = portfolio.sectorWeights[k] - target[k];
  }

  return { target, drift };
}

// 从用户偏好赛道池挑选应部署的赛道基金
//   用户偏好: 不爱宽基, 爱高弹性特定领域赛道(半导体/科创/恒生科技/新能源/券商等)
// 选基优先级 (由 caller 决定):
//   1) mlPicks 非空数组 -> 用 ML 选基; mlPicks=[] -> 空仓门(整体偏空, 不投赛道)
//   2) realtimeScores 非空 -> ★ 实时行情驱动动态选基: 按"盘中估值+动量"综合分降序取 Top-N
//        (用户 2026-07-22: 先读当时实时行情, 挑当下最强的 N 只, 不要固定哪几只)
//   3) 以上皆无 -> 静态回退: 按固定优先级取等权分散前 N 只
// 注: 任何模式都跳过权重已达 maxWeight 的基金
function pickPreferredSector(funds, totalAsset, mlPicks, realtimeScores) {
  // 1) ML 选基
  if (Array.isArray(mlPicks)) {
    return mlPicks.filter(p => {
      const held = funds.find(f => f.code === p.code);
      const w = held ? (held.value || 0) / (totalAsset || 1) : 0;
      return w < (p.maxWeight || 0.3);
    });
  }
  // 2) 实时行情动态选基 (默认实盘路径)
  if (Array.isArray(realtimeScores) && realtimeScores.length > 0) {
    const picks = [];
    for (const r of realtimeScores) {
      const held = funds.find(f => f.code === r.code);
      const w = held ? (held.value || 0) / (totalAsset || 1) : 0;
      if (w >= (r.maxWeight || 0.3)) continue; // 已满, 跳过
      picks.push({
        code: r.code, name: r.name, sector: r.sector, maxWeight: r.maxWeight,
        weight: 1, realtime: true, changePct: r.changePct, score: r.score, mom5: r.mom5,
      });
      if (picks.length >= EFFECTIVE_PICK_COUNT) break; // 动态挑最强的 N 只 (由自我迭代元参数 topK 决定)
    }
    return picks;
  }
  // 3) 静态回退: 固定优先级等权分散 (realtime 抓不到时的兜底)
  const picks = [];
  for (const s of PREFERRED_SECTORS) {
    const held = funds.find(f => f.code === s.code);
    const w = held ? (held.value || 0) / (totalAsset || 1) : 0;
    if (w >= s.maxWeight) continue;
    picks.push({ ...s, weight: 1 });
    if (picks.length >= MAX_DEPLOY_SECTORS) break;
  }
  return picks;
}

// ============================================================
// 5. 生成操作指令
// ============================================================
// 把实时强弱信息拼进操作理由 (盘前读到的当时行情)
function realtimeReason(p, base) {
  if (!p.realtime) return base; // 非实时路径(ML/静态), 原样返回
  const parts = [];
  if (p.changePct != null) parts.push(`实时估值${p.changePct >= 0 ? '+' : ''}${p.changePct}%`);
  if (p.mom5 != null) parts.push(`近5日${p.mom5 >= 0 ? '+' : ''}${p.mom5}%`);
  const tag = parts.length ? ` [${parts.join(' / ')} 综合分${p.score}]` : '';
  return `动态选基 ${p.sector}赛道${tag} | ${base}`;
}

function generateUltimateAdvice(portfolio, regime, allocation, marketSentiment, strategy, mlPicks, realtimeScores) {
  const cfg = strategy || STRATEGY_CONFIG[STRATEGY] || STRATEGY_CONFIG.CONSERVATIVE;
  const PROFIT_FIRST = STRATEGY === 'PROFIT_FIRST';
  // ★ 情绪因子 (市场恐慌贪婪指数)
  const sentimentBias = marketSentiment?.tradingBias || 'NEUTRAL';
  const isFear = sentimentBias === 'CONTRARIAN_BUY';
  const isGreed = sentimentBias === 'TAKE_PROFIT';
  const sentimentLabel = marketSentiment?.labelCN || '未知';
  // 买入闸门: 赚钱优先模式下, 贪婪日/熊市不再压抑建仓
  const blockBuyOnGreed = cfg.greedInhibitBuy && isGreed;
  const blockBuyOnBear = cfg.bearInhibitBuy && (regime.regime === 'BEAR' || regime.regime === 'WEAK_SIDEWAYS');
  const canBuy = !blockBuyOnGreed && !blockBuyOnBear;
  const lockedTakeProfit = cfg.lockedTakeProfit; // 锁定的盈利仓也止盈
  const operations = [];
  const alreadyConverted = new Set();
  const { funds, cash, totalAsset } = portfolio;
  const { target, drift } = allocation;
  const t1Info = { description: '场外基金 T+1 确认, 15:00前下单按当日净值, 15:00后顺延' };

  // 1. 科技集中度检查: 如果 >50%, 只动仓位最重且非在途的成长基金, 分步转换
  if (portfolio.techConcentration > RISK_CONFIG.maxTechConcentration) {
    const targets = selectConversionTargets(funds, totalAsset, alreadyConverted);
    let remainingBudget = totalAsset * (portfolio.techConcentration - RISK_CONFIG.maxTechConcentration) * 0.4;
    // 最多转换2只基金, 避免一次动太多
    let convertedCount = 0;
    for (const fund of targets) {
      if (remainingBudget <= 10 || convertedCount >= 2) break;
      if (fund.value < 50) continue;
      const amount = Math.min(fund.value * 0.15, remainingBudget, 600); // 单次转换不超过600或15%市值
      operations.push({
        action: 'CONVERT',
        code: fund.code,
        name: fund.name,
        amount: Math.round(amount),
        target: '014418 博时黄金ETF联接C',
        reason: `科技集中度${(portfolio.techConcentration*100).toFixed(0)}%超上限50%, 分步降低风险; 本次转换约¥${Math.round(amount)}`,
        t1: t1Info,
        urgency: 'HIGH',
      });
      alreadyConverted.add(fund.code);
      remainingBudget -= amount;
      convertedCount++;
    }
  }

  // 2. 单票上限检查: 单只 >20% 且未处理过; QDII/全球分散基金放宽到30%, 只转换超出部分的30%, 最多一只
  let singleLimitCount = 0;
  for (const fund of funds) {
    if (fund.locked) continue; // 框架锁定基金不参与单票超限调整
    const weight = fund.value / totalAsset;
    const limit = isGlobalDiversification(fund.name) ? 0.30 : RISK_CONFIG.maxSinglePosition;
    if (weight > limit && !alreadyConverted.has(fund.code) && singleLimitCount < 1) {
      if (isPendingConversion(fund)) continue;
      const excessAmount = totalAsset * (weight - limit) * 0.3;
      if (fund.value < 50) continue;
      const amount = Math.min(fund.value * 0.10, excessAmount, 300);
      operations.push({
        action: 'CONVERT',
        code: fund.code,
        name: fund.name,
        amount: Math.round(amount),
        target: '014418 博时黄金ETF联接C',
        reason: `单只仓位${(weight*100).toFixed(0)}%超过${(limit*100).toFixed(0)}%上限, 分步降低`,
        t1: t1Info,
        urgency: 'HIGH',
      });
      alreadyConverted.add(fund.code);
      singleLimitCount++;
    }
  }

  // 3. 硬止损: 亏损 > -8% (优先转换到宽基, 避免<7天1.5%高赎回费)
  for (const fund of funds) {
    if (fund.locked) continue; // 框架锁定基金不触发硬止损
    if (fund.profitPct <= RISK_CONFIG.stopLossRatio && !alreadyConverted.has(fund.code)) {
      if (isPendingConversion(fund)) continue;
      const feeRate = redemptionFeeRate(fund);
      if (feeRate >= FEE_CONFIG.fund.redemptionRate.under7) {
        operations.push({
          action: 'CONVERT',
          code: fund.code,
          name: fund.name,
          amount: Math.round(fund.value * 0.3),
          target: '014418 博时黄金ETF联接C',
          reason: `浮亏${(fund.profitPct*100).toFixed(1)}%触发-8%硬止损, 持有<7天赎回费1.5%, 改为转换部分到防御(黄金)`,
          t1: t1Info,
          urgency: 'HIGH',
        });
      } else {
        operations.push({
          action: 'SELL',
          code: fund.code,
          name: fund.name,
          amount: Math.round(fund.value),
          reason: `浮亏${(fund.profitPct*100).toFixed(1)}%触发硬止损${(RISK_CONFIG.stopLossRatio*100).toFixed(0)}%`,
          t1: t1Info,
          urgency: 'HIGH',
        });
      }
      alreadyConverted.add(fund.code);
    }
  }

  // 3.5 浮盈动态止盈: 盈利也要动态调整, 不让利润回吐 (止盈优先级低于止损)
  for (const fund of funds) {
    if (fund.locked && !lockedTakeProfit) continue; // 赚钱优先模式下, 锁定的盈利仓也参与止盈落袋
    if (fund.profitPct <= 0) continue; // 亏损仓(含锁定亏损仓)不触发止盈, 持有不动
    if (alreadyConverted.has(fund.code)) continue;
    const p = fund.profitPct;

    // (a) 天花板止盈: 盈利≥50% 全部止盈锁定
    if (p >= RISK_CONFIG.takeProfitCeiling) {
      operations.push({
        action: 'SELL',
        code: fund.code,
        name: fund.name,
        amount: Math.round(fund.value),
        reason: `浮盈${(p*100).toFixed(1)}%达天花板${(RISK_CONFIG.takeProfitCeiling*100).toFixed(0)}%, 全部止盈锁定利润`,
        t1: t1Info,
        urgency: 'MEDIUM',
      });
      alreadyConverted.add(fund.code);
      continue;
    }

    // (b) 分批止盈: 盈利≥20% 卖出30%, 余仓继续跟踪
    if (p >= RISK_CONFIG.partialTakeProfitThreshold) {
      const sellAmount = Math.round(fund.value * RISK_CONFIG.partialTakeProfitPct);
      operations.push({
        action: 'SELL',
        code: fund.code,
        name: fund.name,
        amount: sellAmount,
        reason: `浮盈${(p*100).toFixed(1)}%≥${(RISK_CONFIG.partialTakeProfitThreshold*100).toFixed(0)}%, 部分止盈${(RISK_CONFIG.partialTakeProfitPct*100).toFixed(0)}%(约¥${sellAmount}), 余仓跟踪移动止盈`,
        t1: t1Info,
        urgency: 'MEDIUM',
      });
      alreadyConverted.add(fund.code);
      continue;
    }

    // (c) 移动止盈激活: 盈利≥15% 启动跟踪, 熊市回撤5%/其他回撤10%卖出
    if (p >= RISK_CONFIG.trailingStopActivation) {
      const trailingPct = (regime.regime === 'BEAR' || regime.regime === 'WEAK_SIDEWAYS')
        ? RISK_CONFIG.trailingStopPctBear : RISK_CONFIG.trailingStopPct;
      const retreatLine = Math.round(fund.value * (1 - trailingPct));
      operations.push({
        action: 'HOLD',
        code: fund.code,
        name: fund.name,
        reason: `浮盈${(p*100).toFixed(1)}%≥${(RISK_CONFIG.trailingStopActivation*100).toFixed(0)}%, 已激活移动止盈: 从当前高点回撤${(trailingPct*100).toFixed(0)}%(约低于¥${retreatLine})即卖出`,
        t1: t1Info,
        urgency: 'LOW',
      });
      alreadyConverted.add(fund.code);
      continue;
    }

    // (d) 小盈<15%: 继续持有让利润奔跑
    operations.push({
      action: 'HOLD',
      code: fund.code,
      name: fund.name,
      reason: `浮盈${(p*100).toFixed(1)}%<移动止盈激活线${(RISK_CONFIG.trailingStopActivation*100).toFixed(0)}%, 继续持有让利润奔跑`,
      urgency: 'LOW',
    });
    alreadyConverted.add(fund.code);
  }

  // 4. 大类资产配置再平衡
  // 现金低于目标: 暂停买入, 先卖出/转换 over 的基金
  // 成长低于目标且体制允许: 小额定投或加仓
  if (drift.cash < 0) {
    operations.push({
      action: 'HOLD',
      code: 'CASH',
      name: '现金',
      reason: `现金占比${(portfolio.sectorWeights.cash*100).toFixed(1)}%低于目标${(target.cash*100).toFixed(0)}%, 暂停新增买入, 优先卖出/转换超配基金`,
      urgency: 'MEDIUM',
    });
  }

  // 成长/赛道严重不足: 用户偏好高弹性赛道(半导体/科创/恒生科技/新能源/券商等), 现金部署优先投此处
  // (赚钱优先: 不再压抑建仓; 不投宽基沪深300)
  // 现金过多时由第7条统一部署超额现金(本身即补growth), 此处跳过避免对同批赛道重复买入
  const cashExcess = drift.cash > 0.05 && cash > totalAsset * 0.05;
  if (drift.growth < -0.05 && canBuy && !cashExcess) {
    const picks = pickPreferredSector(funds, totalAsset, mlPicks, realtimeScores);
    const needed = totalAsset * Math.min(0.05, -drift.growth); // 每次最多补5%
    if (picks.length === 0) {
      // 空仓门/赛道池满: 不投赛道, 兜底补黄金防御
      if (cash >= needed) {
        operations.push({
          action: 'BUY', code: '014418', name: '博时黄金ETF联接C',
          amount: Math.round(needed * 0.6),
          reason: mlPicks ? `ML整体偏空(空仓门), 转黄金防御` : `赛道池已满, 兜底增加防御`, t1: t1Info, urgency: 'LOW',
        });
      }
    } else if (cash >= needed) {
      const wsum = picks.reduce((s, p) => s + (p.weight || 1), 0);
      for (const p of picks) {
        operations.push({
          action: 'BUY', code: p.code, name: p.name,
          amount: Math.round(needed * (p.weight || 1) / wsum),
          reason: realtimeReason(p, `成长补仓(目标${(target.growth*100).toFixed(0)}%当前${(portfolio.sectorWeights.growth*100).toFixed(1)}%)`),
          t1: t1Info, urgency: 'MEDIUM',
        });
      }
    } else {
      const p0 = picks[0];
      operations.push({
        action: 'PLAN', code: p0.code, name: p0.name,
        amount: Math.round(needed),
        reason: `赛道配置不足, 但现金不足, 待转换或卖出后执行`,
        t1: t1Info, urgency: 'MEDIUM',
      });
    }
  }

  if (drift.defense < -0.05 && canBuy) {
    const needed = totalAsset * Math.min(0.05, -drift.defense);
    if (cash >= needed) {
      operations.push({
        action: 'BUY',
        code: '014418',
        name: '博时黄金ETF联接C',
        amount: Math.round(needed * 0.6),
        reason: `防御配置不足, 增加黄金/债券暴露`,
        t1: t1Info,
        urgency: 'MEDIUM',
      });
    }
  }

  // 5. 浮亏分级预警 (非牛市体制): 禁止补仓 + 接近止损线预警 + 硬止损已在第3条
  if (regime.regime !== 'BULL') {
    for (const fund of funds) {
      if (fund.locked) continue;                    // 框架锁定基金不触发预警强制动作
      if (fund.profitPct >= 0) continue;            // 浮盈由第3.5条处理
      if (alreadyConverted.has(fund.code)) continue;
      if (fund.profitPct > RISK_CONFIG.stopLossRatio) {
        const gap = (fund.profitPct - RISK_CONFIG.stopLossRatio) * 100; // 距-8%止损线还差多少个百分点
        const nearStop = fund.profitPct <= RISK_CONFIG.addPositionThreshold; // ≤-5% 视为接近止损线
        operations.push({
          action: 'HOLD',
          code: fund.code,
          name: fund.name,
          reason: `${regime.regime}体制, 浮亏${(fund.profitPct*100).toFixed(1)}%, 禁止补仓(避免越跌越买); ${nearStop ? '⚠️接近止损线' : '观察中'}, 若跌破${(RISK_CONFIG.stopLossRatio*100).toFixed(0)}%将转换/止损(还差${gap.toFixed(1)}%)`,
          urgency: nearStop ? 'MEDIUM' : 'LOW',
        });
        alreadyConverted.add(fund.code);
      }
    }
  }

  // 6. QDII 定投: 广发全球精选限购200元/天, 在熊市/弱震荡中作为分散配置
  const globalFund = funds.find(f => f.code === '021277');
  if (globalFund && !globalFund.locked && canBuy) { // 赚钱优先: 不压抑定投/建仓
    const globalWeight = globalFund.value / totalAsset;
    if (globalWeight < target.global && cash >= 200) {
      operations.push({
        action: 'DCA',
        code: '021277',
        name: '广发全球精选股票(QDII)C',
        amount: 200,
        reason: `全球分散配置不足, 每日定投200元(机构限购上限)`,
        t1: t1Info,
        urgency: 'LOW',
      });
    } else if (globalWeight < target.global) {
      operations.push({
        action: 'DCA',
        code: '021277',
        name: '广发全球精选股票(QDII)C',
        amount: Math.min(200, Math.round(cash * 0.5)),
        reason: `全球分散配置不足, 但现金有限, 小额定投`,
        t1: t1Info,
        urgency: 'LOW',
      });
    }
  }

  // 7. 现金过多: 主动部署到用户偏好赛道 (赚钱优先: 闲置现金不浪费; 不投宽基)
  if (drift.cash > 0.05 && cash > totalAsset * 0.05 && canBuy) {
    const deployAmount = cash - totalAsset * target.cash;
    const picks = pickPreferredSector(funds, totalAsset, mlPicks, realtimeScores);
    if (picks.length > 0) {
      const wsum = picks.reduce((s, p) => s + (p.weight || 1), 0);
      for (const p of picks) {
        operations.push({
          action: 'BUY', code: p.code, name: p.name,
          amount: Math.round(Math.min(deployAmount, cash) * (p.weight || 1) / wsum),
          reason: realtimeReason(p, `现金超配, 动态选基(当日最强${picks.length}只)`),
          t1: t1Info, urgency: 'MEDIUM',
        });
      }
    } else {
      // 空仓门/赛道池满: 兜底补黄金防御
      operations.push({
        action: 'BUY', code: '014418', name: '博时黄金ETF联接C',
        amount: Math.round(Math.min(deployAmount, cash) * 0.6),
        reason: mlPicks ? `现金超配, ML整体偏空(空仓门), 转黄金防御` : `现金超配, 赛道池已满, 兜底增加防御`,
        t1: t1Info, urgency: 'LOW',
      });
    }
  }

  // 8. 持有 & 未触发的基金
  for (const fund of funds) {
    if (!operations.find(o => o.code === fund.code)) {
      operations.push({
        action: 'HOLD',
        code: fund.code,
        name: fund.name,
        reason: `未触发止损/止盈/再平衡条件`,
        urgency: 'LOW',
      });
    }
  }

  return {
    date: todayStr(),
    regime: regime.regime,
    regimeConfidence: regime.confidence,
    totalAsset,
    cash,
    sectorWeights: portfolio.sectorWeights,
    targetWeights: target,
    techConcentration: portfolio.techConcentration,
    maxSingleWeight: portfolio.maxSingleWeight,
    operations,
  };
}

// ============================================================
// 6. 主函数
// ============================================================
function generateUltimatePortfolioAdvice(marketSentiment, mlPicks, realtimeScores) {
  const strategy = STRATEGY_CONFIG[STRATEGY] || STRATEGY_CONFIG.CONSERVATIVE;
  if (!isTradingDay()) {
    return {
      date: todayStr(),
      regime: 'WEEKEND',
      strategy: STRATEGY,
      totalAsset: 0,
      cash: 0,
      message: '今日为周末/节假日, 不进行交易。请等待下一个交易日。',
      operations: [],
      marketSentiment: marketSentiment || null,
    };
  }

  const holdings = loadHoldings();
  const portfolio = analyzePortfolio(holdings);
  const regime = detectMarketRegime(portfolio);
  const allocation = checkAllocationDrift(portfolio, regime.regime, strategy);
  const advice = generateUltimateAdvice(portfolio, regime, allocation, marketSentiment, strategy, mlPicks, realtimeScores);
  advice.strategy = STRATEGY;
  advice.marketSentiment = marketSentiment || null;
  advice.mlPicks = mlPicks || null;
  advice.metaParams = META; // 持续自我迭代最新元参数 (topK / 因子权重 / holdout 表现)
  advice.realtimePicks = (Array.isArray(realtimeScores) && realtimeScores.length > 0)
    ? realtimeScores.slice(0, EFFECTIVE_PICK_COUNT).map(r => ({
        code: r.code, name: r.name, sector: r.sector,
        changePct: r.changePct, mom5: r.mom5, score: r.score,
      }))
    : null;
  return advice;
}

module.exports = {
  generateUltimatePortfolioAdvice,
  analyzePortfolio,
  detectMarketRegime,
  checkAllocationDrift,
};
