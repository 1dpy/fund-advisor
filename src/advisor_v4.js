/**
 * V4 决策引擎 — 纯操作指令输出
 *
 * 核心升级:
 *   1. 融合7个模型信号 (LSTM-Att + RF + GBDT + Kalman + ARIMA + HMM + Tech)
 *   2. 信号融合引擎 (体制感知 + 相关性惩罚 + Sharpe加权)
 *   3. Walk-forward验证的参数自优化
 *   4. 多时间框架验证 (日/周/月)
 *   5. 输出格式: 纯操作指令 (只有买卖代码+金额+时间, 无分析)
 *
 * 策略:
 *   - 高确信度重仓 (ML_STRONG_BUY × Kelly × 1.4)
 *   - 动态止损止盈 (ATR + walk-forward优化)
 *   - 全交易类型: 买/卖/部分卖/转换/加仓/减仓/定投/持有
 *   - 支付宝C类T+1规则
 */

const { BUDGET, RISK_CONFIG } = require('./config');
const { fuseSignals } = require('./quant/signal_fusion');
const { predictWithLSTMAttention } = require('./quant/lstm_attention');
const { predictWithKalman } = require('./quant/kalman_filter');
const { predictARIMA } = require('./quant/arima_lite');
const { extractFeatures } = require('./feature_engine');
const { resample, hurstExponent, getCachedHistory } = require('./data_collector');
const { getSettlementTimeline } = require('./t1_calendar');
const {
  buildBook, profitRatio, profitRatioDetailed, annualizedVol, volPositionScale,
  adaptiveStopLoss, sectorOf, sectorExposure, clamp, num,
  loadRecentSells, inSellCooldown,
} = require('./portfolio_book');
const { assessFreshness } = require('./data_freshness');

/**
 * 硬性可执行性闸门: 净值已停止更新(停牌/清盘/数据源中断嫌疑)的基金,
 * 现价未知且未必能成交, 不参与买入 / 加仓 / 转换。
 * 抽成纯函数是为了让测试直接打真实代码, 而不是在测试里复制一遍过滤条件。
 * @param {Object} fund rankedFunds 中的条目(带 freshness 字段)
 * @returns {boolean}
 */
function isFreshEnoughToTrade(fund) {
  if (!fund || !fund.freshness) return true;  // 无新鲜度信息时保持原行为
  return fund.freshness.usable !== false;
}

/**
 * 成长/科技类赛道 — 计入 maxTechConcentration。
 * globalTech(QDII) 与 defense 不计入, 与 config 注释口径一致("QDII广发不算入")。
 */
const GROWTH_SECTORS = new Set(['aiChip', 'newEnergy', 'internetTech', 'techBase', 'satellite']);

/**
 * 候选排序分: 预期涨幅 × 置信度 × 波动惩罚 + 技术评分
 *
 * 波动惩罚的意义: 同样预期 +3%, 年化波动 60% 的基金和 20% 的基金不是一回事。
 *   以 30% 年化波动为中性, 波动越高打折越多(系数限幅 0.5~1.5)。
 */
function rankScore(fund) {
  const sig = fund?.fusedSignal;
  if (!sig) return -Infinity;
  const expectedPct = num(sig.prediction) * 100;          // 预期涨幅(百分点)
  const conf = clamp(num(sig.confidence) || 0.5, 0.15, 0.95);
  const vol = annualizedVol(fund.history || fund.deepHistory);
  const volPenalty = vol > 0 ? clamp(0.30 / vol, 0.5, 1.5) : 1.0;
  return expectedPct * conf * volPenalty * 100 + num(fund.score) * 0.3;
}

/**
 * V4 主决策函数
 * @param {Object} data - 全部市场数据 (funds, indexes, breadth, etc.)
 * @param {Object} holdings - 当前持仓
 * @param {Object} mlEnsemble - ML集成结果 (RF, GBDT, LSTM, HMM)
 * @param {Object} usImpact - 美股影响
 * @param {Object} marketRegime - 市场体制
 * @returns {Object} 纯操作指令
 */
async function generateAdviceV4(data, holdings, mlEnsemble, usImpact, marketRegime, marketSentiment) {
  const { funds, indexes, breadth, northFlow } = data;

  // ★ 组合账本: 现金 / 市值 / 仓位的唯一口径
  //   原实现 `BUDGET - ΣcostBasis` 把余额宝的 costBasis 也算成"已投基金成本",
  //   实测算出 -798 → 归零, 买入循环 buyBudget<100 直接 break, 引擎从不产出买入指令。
  //   现在: 可投 = min(手头现金, 预算剩余额度), 且按市值而非成本衡量已投。
  const book = buildBook(holdings, BUDGET);
  const fundHoldings = book.fundHoldings;   // 现金条目已剔除
  const cash = book.deployable;
  const t1Info = getSettlementTimeline('fund', new Date());

  // 现金预算账本: 加仓/买入统一从这里出账, 保证建议买入总额不超过可用现金。
  //   (历史 bug: 每只持仓各自用 cash 判断"够不够", 多只同时触发加仓时会重复花同一笔钱)
  let remainingCash = cash;
  function spend(want) {
    const amount = Math.min(Math.round(want), Math.round(remainingCash));
    if (amount < 10) return 0; // 太小不值得下单
    remainingCash -= amount;
    return amount;
  }

  // ============================================================
  // 1. 对每只基金运行信号融合
  // ============================================================
  const rankedFunds = [];
  const freshnessWarnings = [];
  const marketContext = {
    regime: marketRegime?.regime || 'SIDEWAYS',
    marketReturns: indexes?.length > 0
      ? indexes[0].changePct / 100 : 0,
  };

  // ★ 情绪因子 (市场恐慌贪婪指数)
  const sentimentBias = marketSentiment?.tradingBias || 'NEUTRAL';
  const isFear = sentimentBias === 'CONTRARIAN_BUY';   // 恐慌→逆向布局
  const isGreed = sentimentBias === 'TAKE_PROFIT';     // 贪婪→减仓
  const sentimentLabel = marketSentiment?.labelCN || '未知';

  // 按技术评分排序, 只对Top基金运行V4模型 (控制计算时间)
  const sortedFunds = [...funds].sort((a, b) => (b.score || 0) - (a.score || 0));
  const topFundCodes = new Set(sortedFunds.slice(0, 30).map(f => f.code));

  for (const fund of funds) {
    if (!fund.history || fund.history.length < 30) continue;

    // 获取深度历史 (仅对Top基金)
    let deepHistory = fund.history;
    if (topFundCodes.has(fund.code)) {
      try {
        const cached = await getCachedHistory(fund.code);
        if (cached && cached.history && cached.history.length > fund.history.length) {
          deepHistory = cached.history;
        }
      } catch (e) { /* 使用默认历史 */ }
    }

    // ML结果
    const mlResults = {
      lstmAtt: null,
      rf: mlEnsemble?.rfResult?.predictions?.find(p => p.code === fund.code),
      gbdt: mlEnsemble?.gbdtResult?.predictions?.find(p => p.code === fund.code),
      lstm: mlEnsemble?.lstmResult?.predictions?.find(p => p.code === fund.code),
      hmm: mlEnsemble?.hmmResult,
    };

    // 只对Top基金运行LSTM-Attention (计算量大)
    if (topFundCodes.has(fund.code)) {
      try {
        const lstmAttResult = predictWithLSTMAttention(deepHistory, 15, 5);
        if (lstmAttResult) mlResults.lstmAtt = lstmAttResult;
      } catch (e) { /* 忽略 */ }
    }

    // 信号融合 (Kalman + ARIMA 在fuseSignals内部运行, 速度很快)
    const fused = fuseSignals(fund, mlResults, marketContext);
    if (!fused) continue;

    // ★ 数据新鲜度: 净值停止更新(停牌/清盘/数据源中断)的基金,
    //   用它算出的动量与预测本身就是错的。仍进 rankedFunds(持仓要看),
    //   但会在买入/转换侧被排除, 并带着 warning 上报。
    const freshness = assessFreshness(deepHistory);
    if (freshness.warning) freshnessWarnings.push({ code: fund.code, name: fund.name, ...freshness });

    rankedFunds.push({
      ...fund,
      fusedSignal: fused,
      deepHistory,
      freshness,
    });
  }

  // 按风险调整后预期收益排序
  //   原公式 prediction*100 + confidence*50 + score*0.3: prediction 实际只有
  //   0.005~0.03(→0.5~3分), 而 confidence 0.15~0.95(→7.5~47分) 完全主导,
  //   等于在按"哪个模型最自信"排序, 而不是"哪个预期涨得多"。
  //   实测: 预期+0.5%但置信0.95 会排在 预期+3%但置信0.7 前面。
  //   现改为 预期涨幅 × 置信 × 波动惩罚, 并放大到能压过技术评分。
  rankedFunds.sort((a, b) => rankScore(b) - rankScore(a));

  // ============================================================
  // 2. 生成操作指令
  // ============================================================
  const operations = {
    sells: [],
    partialSells: [],
    buys: [],
    swaps: [],
    addPositions: [],
    reduces: [],
    holds: [],
    dca: [],
  };

  // --- 2a. 持仓分析: 卖出/减仓/持有 ---
  // ★ V4.1: 获取HMM体制 (从mlEnsemble或marketRegime)
  const regime = mlEnsemble?.hmmResult?.currentState ||
                 marketRegime?.regime || 'SIDEWAYS';
  const isBull = regime === 'BULL' || regime === 'STRONG_SIDEWAYS';
  const isBear = regime === 'BEAR' || regime === 'WEAK_SIDEWAYS';
  const maxHoldingDays = isBull ? RISK_CONFIG.maxHoldingDaysBull
                       : isBear ? RISK_CONFIG.maxHoldingDaysBear
                       : RISK_CONFIG.maxHoldingDaysSideways;
  const trailingStopPct = isBear ? RISK_CONFIG.trailingStopPctBear
                             : RISK_CONFIG.trailingStopPct;

  for (const holding of fundHoldings) {
    // 逐持仓结算时间线: QDII(纳指/标普等) 确认与到账都比普通基金晚一天,
    //   原先全局按 'fund' 算, 会给 QDII 标错到账日
    const t1ForHolding = getSettlementTimeline(holding.type === 'qdii' ? 'qdii' : 'fund', new Date());
    const fundData = rankedFunds.find(f => f.code === holding.code);
    const signal = fundData?.fusedSignal;
    const currentPrice = fundData?.price || fundData?.nav || holding.buyPrice || 0;

    // ★ 盈亏率: 带 fallback 链, 不再因为份额缺失把真实浮亏抹平成 0
    //   实测 019018 浮亏 -13.97%(currentValue 399.73 / costBasis 464.64),
    //   早击穿 -8% 硬止损, 却因 shares 口径失效一直挂在"持有"里, 止损形同虚设。
    const pnl = profitRatioDetailed(holding, currentPrice);
    const profitPct = pnl.ratio;
    // 兜底口径算出来的盈亏用于止损判断时, 要让用户知道这不是精算值
    const pnlImprecise = pnl.source === 'marketValue' || pnl.source === 'recorded';

    const holdingDays = holding.buyDate
      ? Math.floor((Date.now() - new Date(holding.buyDate).getTime()) / 86400000)
      : 30;

    // ★ 波动率自适应止损: 芯片基金日常震荡就能打穿固定 -8% 被扫出局,
    //   沪深300 用 -8% 又太松。按年化波动缩放, 限幅 [-15%, -4%]。
    const stopLossLine = adaptiveStopLoss(fundData?.deepHistory || fundData?.history, RISK_CONFIG.stopLossRatio);

    // ★ V4.1: 计算最高价 (从持仓记录或历史数据)
    const peakPrice = holding.peakPrice || Math.max(currentPrice, holding.buyPrice || currentPrice);
    const peakProfitPct = holding.costBasis > 0 && peakPrice > 0
      ? (holding.shares * peakPrice - holding.costBasis) / holding.costBasis
      : 0;
    const drawdownFromPeak = peakPrice > 0 && currentPrice > 0
      ? (currentPrice - peakPrice) / peakPrice
      : 0;

    // 止损: 波动率自适应线。兜底口径算出的盈亏会额外标注, 便于人工复核
    if (profitPct <= stopLossLine) {
      const sellPrice = currentPrice;
      const lineTag = `${(stopLossLine * 100).toFixed(1)}%${Math.abs(stopLossLine - RISK_CONFIG.stopLossRatio) > 0.001 ? '(波动率自适应)' : ''}`;
      operations.sells.push({
        action: 'SELL',
        code: holding.code,
        name: holding.name,
        shares: holding.shares,
        amount: holding.shares > 0 ? holding.shares * sellPrice : num(holding.currentValue),
        reason: `止损(${(profitPct * 100).toFixed(1)}% ≤ ${lineTag})${pnlImprecise ? '·盈亏按市值口径估算' : ''}`,
        t1: t1ForHolding,
        urgency: 'HIGH',
      });
      continue;
    }

    // ★ V4.1: 固定止盈天花板 (涨到天花板直接全卖, 锁定大利润)
    if (profitPct >= RISK_CONFIG.takeProfitCeiling) {
      const sellPrice = currentPrice;
      operations.sells.push({
        action: 'SELL',
        code: holding.code,
        name: holding.name,
        shares: holding.shares,
        amount: holding.shares * sellPrice,
        reason: `止盈天花板(${(profitPct * 100).toFixed(1)}%)`,
        t1: t1ForHolding,
        urgency: 'MEDIUM',
      });
      continue;
    }

    // ML强烈看空 → 卖出 (恐慌时降级为减仓, 不空仓)
    if (signal && signal.signal === 'SELL' && signal.confidence > 0.5) {
      const sellPrice = currentPrice;
      if (isFear) {
        // 市场恐慌: 不空仓, 只减30%逆向保留筹码
        const reduceShares = Math.floor(holding.shares * 0.3);
        operations.reduces.push({
          action: 'REDUCE',
          code: holding.code,
          name: holding.name,
          shares: reduceShares,
          reducePct: 30,
          amount: reduceShares * sellPrice,
          reason: `ML看空(置信${(signal.confidence * 100).toFixed(0)}%), 但市场${sentimentLabel}→逆向减仓不空仓`,
          t1: t1ForHolding,
          urgency: 'MEDIUM',
        });
      } else {
        operations.sells.push({
          action: 'SELL',
          code: holding.code,
          name: holding.name,
          shares: holding.shares,
          amount: holding.shares * sellPrice,
          reason: `ML看空(置信${(signal.confidence * 100).toFixed(0)}%)`,
          t1: t1ForHolding,
          urgency: 'HIGH',
        });
      }
      continue;
    }

    // ★ V4.1: 移动止盈 (替换固定止盈)
    // 涨过激活阈值后, 从最高点回撤超过trailingStopPct则卖出
    if (peakProfitPct >= RISK_CONFIG.trailingStopActivation && drawdownFromPeak <= -trailingStopPct) {
      const sellPrice = currentPrice;
      operations.sells.push({
        action: 'SELL',
        code: holding.code,
        name: holding.name,
        shares: holding.shares,
        amount: holding.shares * sellPrice,
        reason: `移动止盈(峰值${(peakProfitPct * 100).toFixed(1)}%→回撤${(drawdownFromPeak * 100).toFixed(1)}%)`,
        t1: t1ForHolding,
        urgency: 'MEDIUM',
      });
      continue;
    }

    // ★ V4.1: 部分止盈 — 仅在非牛市触发 (牛市让赢家跑)
    if (!isBull && profitPct >= RISK_CONFIG.partialTakeProfitThreshold) {
      const sellPrice = currentPrice;
      const sellShares = Math.floor(holding.shares * RISK_CONFIG.partialTakeProfitPct);
      operations.partialSells.push({
        action: 'PARTIAL_SELL',
        code: holding.code,
        name: holding.name,
        shares: sellShares,
        sellPct: RISK_CONFIG.partialTakeProfitPct * 100,
        amount: sellShares * sellPrice,
        reason: `部分止盈(${regime}体制,${(profitPct * 100).toFixed(1)}%)`,
        t1: t1ForHolding,
        urgency: 'MEDIUM',
      });
      continue;
    }

    // 信号偏弱 → 减仓 (恐慌时暂缓减仓, 避免低点割肉)
    if (signal && signal.signal === 'WEAK' && signal.confidence > 0.5) {
      if (isFear) {
        operations.holds.push({
          action: 'HOLD',
          code: holding.code,
          name: holding.name,
          reason: `信号减弱(置信${(signal.confidence * 100).toFixed(0)}%), 但市场${sentimentLabel}→暂缓减仓不割肉`,
        });
      } else {
        const sellPrice = currentPrice;
        const reduceShares = Math.floor(holding.shares * (isGreed ? 0.4 : 0.3));
        operations.reduces.push({
          action: 'REDUCE',
          code: holding.code,
          name: holding.name,
          shares: reduceShares,
          reducePct: isGreed ? 40 : 30,
          amount: reduceShares * sellPrice,
          reason: `信号减弱(置信${(signal.confidence * 100).toFixed(0)}%)${isGreed ? '·市场过热减仓40%' : ''}`,
          t1: t1ForHolding,
          urgency: 'LOW',
        });
      }
      continue;
    }

    // ★ V4.1: 体制感知超时退出 (牛市不限时)
    if (holdingDays >= maxHoldingDays && !isBull) {
      const sellPrice = currentPrice;
      operations.sells.push({
        action: 'SELL',
        code: holding.code,
        name: holding.name,
        shares: holding.shares,
        amount: holding.shares * sellPrice,
        reason: `${regime}体制超时(${holdingDays}天)`,
        t1: t1ForHolding,
        urgency: 'LOW',
      });
      continue;
    }

    // ★ 加仓: 顺势加仓(信号强且确实在赚), 不再是"越跌越买"
    //
    //   原逻辑 profitPct < -0.05 是无下界的逆向摊平: 在 -5%~-8% 区间反复补仓,
    //   补完 profitPct 回到浅亏反而绕过止损, 继续跌继续补, 直到跌破止损线
    //   一次性全割, 且新份额持有<7天要多付 1.5% 赎回费。
    //
    //   新逻辑的四道闸门:
    //   1. 盈亏下界: 深亏说明"信号看多"与"市场在跌"矛盾 = 判断错了, 让止损工作
    //   2. 止损缓冲: 距止损线不足 2% 不加, 否则加了很可能立刻被扫出
    //   3. 费率保护: 持有<7天不加, 新份额一旦被止损要付 C类 1.5% 赎回费
    //   4. 单只上限: 加完之后该基金总市值不得超过 maxSinglePosition
    const addFloor = isFear ? RISK_CONFIG.addPositionMinPctFear
                            : RISK_CONFIG.addPositionMinPct;
    const distanceToStop = profitPct - stopLossLine;
    const feeSafe = holdingDays >= RISK_CONFIG.addPositionFeeSafeDays;
    const currentPosValue = book.valueOf(holding.code);
    const positionRoom = Math.max(0, BUDGET * RISK_CONFIG.maxSinglePosition - currentPosValue);

    if (signal && (signal.signal === 'STRONG_BUY' || signal.signal === 'BUY')
        && profitPct >= addFloor
        && distanceToStop >= RISK_CONFIG.addPositionStopBuffer
        && feeSafe
        && positionRoom > 0
        && remainingCash > (isFear ? 300 : 500)
        // 净值停止更新的持仓不加仓: 现价未知, 加仓金额无从折算
        && isFreshEnoughToTrade(fundData)) {
      const addPrice = currentPrice || 1;
      // 三重取小: 现金比例上限 / 该基金剩余额度 / 单次绝对上限
      const addAmount = spend(Math.min(
        remainingCash * RISK_CONFIG.addPositionMaxPct,
        positionRoom,
        isFear ? 1500 : 2000,
      ));
      if (addAmount > 0) {
        operations.addPositions.push({
          action: 'ADD_POSITION',
          code: holding.code,
          name: holding.name,
          amount: addAmount,
          // price 必须带上: applyDecisions 回写持仓时要用 amount/price 算份额,
          //   缺了会算出 NaN 写进 holdings.json
          price: addPrice,
          shares: Math.floor(addAmount / addPrice),
          reason: `顺势加仓(${signal.signal}, 盈亏${(profitPct * 100).toFixed(1)}%)${isFear ? `·市场${sentimentLabel}逆向` : ''}`,
          t1: t1ForHolding,
          urgency: 'MEDIUM',
        });
        continue;
      }
    }

    // 持有
    operations.holds.push({
      action: 'HOLD',
      code: holding.code,
      name: holding.name,
      reason: signal ? `${signal.signal}·${regime}·持${holdingDays}天` : '持有观察',
    });
  }

  // --- 2b. 买入: 选最强信号 ---
  // 可用现金 = 账本余额。卖出/减仓/部分止盈的资金 T+2 才到账, 不能立即用于买入,
  //   因此这里只扣减加仓已占用的部分 (加仓在前面已通过 spend() 出账)。
  const availableCash = remainingCash;

  let buyBudget = availableCash * (1 - RISK_CONFIG.cashReserve);
  // 贪婪时收紧买入预算(留更多现金防回调); 恐慌时略放宽(逆向布局)
  if (isGreed) buyBudget *= 0.5;
  else if (isFear) buyBudget *= 1.25;
  // 放宽不得超过实际可用现金: 恐慌时 1.25 倍会把预算顶到 availableCash 之上,
  // 变成"建议买入 > 手里有钱", 指令根本执行不了
  buyBudget = Math.min(buyBudget, availableCash);
  const maxPositions = RISK_CONFIG.maxTotalPositions - fundHoldings.length + operations.sells.length;
  let buyCount = 0;

  // 止损卖出冷却表: 只读一次, 避免每个候选都去读文件
  const recentSells = loadRecentSells();

  // ★ 赛道额度台账: 本轮已决定投入各赛道的金额, 与既有持仓合并后校验上限。
  //   没有它的话, 同一个赛道的 3 只芯片基金会被逐个放行, 各自都没超单只上限,
  //   合起来却把 40%+ 的预算压在同一个赛道上。
  const sectorSpend = new Map();
  /** 某赛道本轮+既有的合计投入 */
  function sectorUsed(sector) {
    if (!sector) return 0;
    return sectorExposure(fundHoldings, sector) + num(sectorSpend.get(sector));
  }
  /** 成长类赛道本轮+既有的合计投入 */
  function growthUsed() {
    let sum = 0;
    for (const s of GROWTH_SECTORS) sum += sectorUsed(s);
    return sum;
  }

  for (const fund of rankedFunds) {
    if (buyBudget < 100 || buyCount >= maxPositions) break;

    // 跳过已持有的
    if (fundHoldings.find(h => h.code === fund.code)) continue;

    // ★ 冷却期: 刚被止损扫出的不马上买回来(防来回打脸)。只挡买入, 不挡其他操作。
    if (inSellCooldown(fund.code, RISK_CONFIG.sellCooldownDays, recentSells)) continue;

    // 跳过净值已停止更新的: 现价未知, 且可能已停牌/清盘, 买入指令无法成交
    if (!isFreshEnoughToTrade(fund)) continue;

    const signal = fund.fusedSignal;
    if (!signal) continue;

    // 买入信号门槛: 贪婪时仅 STRONG_BUY; 恐慌时允许 WEAK 以上(逆向分批布局)
    if (isGreed) {
      if (signal.signal !== 'STRONG_BUY') continue;
    } else if (isFear) {
      if (signal.signal !== 'STRONG_BUY' && signal.signal !== 'BUY' && signal.signal !== 'WEAK') continue;
    } else {
      if (signal.signal !== 'STRONG_BUY' && signal.signal !== 'BUY') continue;
    }

    // 仓位计算: Kelly + ML信号加成
    let kellyFraction = 0.20; // 基础20%
    if (signal.signal === 'STRONG_BUY') kellyFraction = 0.35;
    else if (signal.signal === 'BUY') kellyFraction = 0.25;

    // 置信度调整 (保底50%仓位)
    kellyFraction *= Math.max(0.5, signal.confidence);

    // ★ 波动率倒数加权: 同样的信号强度, 高波动品种给更小的仓位。
    //   否则组合会系统性超配芯片这类高波动基金, 收益没多拿回撤先翻倍。
    kellyFraction *= volPositionScale(fund.history || fund.deepHistory);

    // 单只上限
    kellyFraction = Math.min(kellyFraction, RISK_CONFIG.maxSinglePosition);

    const buyAmount = Math.min(buyBudget * kellyFraction, buyBudget, BUDGET * RISK_CONFIG.maxSinglePosition);

    // ★ 赛道额度闸门: 单只没超限不代表组合没超限
    //   单赛道 ≤ maxSingleSector (防止 aiChip 3 只堆到 60%)
    //   成长类合计 ≤ maxTechConcentration (用户既定的全赛道偏好上限)
    const sector = sectorOf(fund.code);
    let allowed = buyAmount;
    if (sector) {
      const sectorRoom = BUDGET * RISK_CONFIG.maxSingleSector - sectorUsed(sector);
      allowed = Math.min(allowed, sectorRoom);
    }
    if (sector && GROWTH_SECTORS.has(sector)) {
      const growthRoom = BUDGET * RISK_CONFIG.maxTechConcentration - growthUsed();
      allowed = Math.min(allowed, growthRoom);
    }
    if (allowed < 10) continue;   // 该赛道额度用尽, 换下一只

    const price = fund.price || fund.nav || 0;
    const shares = price > 0 ? Math.floor(allowed / price) : 0;

    if (sector) sectorSpend.set(sector, num(sectorSpend.get(sector)) + allowed);

    operations.buys.push({
      action: 'BUY',
      code: fund.code,
      name: fund.name,
      amount: allowed,
      shares,
      price,
      sector,
      score: fund.score || 0,
      mlSignal: signal.signal,
      confidence: signal.confidence,
      prediction: signal.prediction,
      reason: `${signal.signal} 置信${(signal.confidence * 100).toFixed(0)}% 预测${(signal.prediction * 100).toFixed(2)}%${sector ? `·${sector}` : ''}`,
      t1: t1Info,
      urgency: signal.signal === 'STRONG_BUY' ? 'HIGH' : 'MEDIUM',
    });

    buyBudget -= allowed;
    buyCount++;
  }

  // --- 2c. 转换: 弱基金 → 强基金 ---
  // 已在 2a 落地成 卖出/部分止盈/减仓/加仓 的持仓不能再被转换。
  //   (历史 bug: 信号 WEAK 且置信>0.5 的持仓, 2a 会给 REDUCE 30%, 2c 又给 SWAP 100%,
  //    同一只基金同时出现"减仓30%"和"全部转出"两条互相矛盾的指令)
  const assignedCodes = new Set([
    ...operations.sells.map(o => o.code),
    ...operations.partialSells.map(o => o.code),
    ...operations.reduces.map(o => o.code),
    ...operations.addPositions.map(o => o.code),
  ]);
  const weakHoldings = fundHoldings.filter(h => {
    if (assignedCodes.has(h.code)) return false;
    const fund = rankedFunds.find(f => f.code === h.code);
    if (!fund || !fund.fusedSignal || fund.fusedSignal.signal !== 'WEAK') return false;
    // 净值已停止更新的持仓不能作为转换卖出方: 报价不可信, 赎回也未必能成交
    return isFreshEnoughToTrade(fund);
  });
  const strongCandidates = rankedFunds.filter(f =>
    f.fusedSignal && f.fusedSignal.signal === 'STRONG_BUY' &&
    !fundHoldings.find(h => h.code === f.code) &&
    // 不买净值已停止更新的基金: 两周没净值, 现价未知, 且可能已清盘买不进
    isFreshEnoughToTrade(f)
  );

  for (let i = 0; i < Math.min(weakHoldings.length, strongCandidates.length); i++) {
    const weak = weakHoldings[i];
    const strong = strongCandidates[i];
    const weakFund = rankedFunds.find(f => f.code === weak.code);
    const sellPrice = weakFund?.price || weakFund?.nav || weak.buyPrice || 0;
    const sellValue = weak.shares * sellPrice;
    // 买入价也要带上: 回写持仓时要按目标基金净值折份额
    const buyPrice = strong.price || strong.nav || 0;

    operations.swaps.push({
      action: 'SWAP',
      sellCode: weak.code,
      sellName: weak.name,
      sellPrice,
      sellShares: weak.shares,
      buyCode: strong.code,
      buyName: strong.name,
      buyPrice,
      sellValue,
      buyAmount: sellValue,
      reason: `${weak.name}信号弱 → ${strong.name}信号强`,
      t1: t1Info,
      urgency: 'MEDIUM',
    });
  }

  return {
    date: new Date().toLocaleString('zh-CN'),
    t1Info,
    operations,
    marketRegime: marketRegime?.regime || 'SIDEWAYS',
    marketSentiment: marketSentiment || null,
    // 净值新鲜度告警(停牌/清盘/数据源中断嫌疑), 供展示层提示与运维排查
    freshnessWarnings,
    summary: {
      sell: operations.sells.length,
      partialSell: operations.partialSells.length,
      buy: operations.buys.length,
      swap: operations.swaps.length,
      addPosition: operations.addPositions.length,
      reduce: operations.reduces.length,
      hold: operations.holds.length,
    },
  };
}

module.exports = {
  generateAdviceV4,
  isFreshEnoughToTrade,
};
