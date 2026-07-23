/**
 * 投资配置 V3 — 全市场+全交易类型版
 *
 * 风格: 科技赛道集中型 · 高确信度重仓 · ML驱动
 * 平台: 支付宝 (场外C类基金, 0申购费)
 *
 * V3升级:
 *   - 预算提升至 ¥8,000 (支持更多基金分散)
 *   - 12个模块各Top100基金池
 *   - 全交易类型 (买/卖/部分卖/转换/部分转换/加仓/减仓/定投)
 *   - ML集成信号驱动
 *   - T+1结算日历
 *   - 美股前瞻+VIX+美债
 *   - 基金持仓重叠检测
 */

const BUDGET = 5500;

// 核心赛道基金池 — 全C类支付宝可买 (手动精选)
const WATCHLIST = {
  // 核心赛道: AI/芯片/半导体
  aiChip: [
    { code: '008282', name: '国泰芯片ETF联接C', type: 'fund', minBuy: 10, maxWeight: 0.35 },
    { code: '017470', name: '嘉实中证半导体C', type: 'fund', minBuy: 10, maxWeight: 0.35 },
    { code: '014419', name: '西部利得芯片增强C', type: 'fund', minBuy: 10, maxWeight: 0.25 },
  ],

  // 新能源/电池/储能
  newEnergy: [
    { code: '027495', name: '易方达电池ETF联接C', type: 'fund', minBuy: 10, maxWeight: 0.35 },
  ],

  // 互联网/科技/信息
  internetTech: [
    { code: '019018', name: '易方达信息产业混合C', type: 'fund', minBuy: 10, maxWeight: 0.30 },
  ],

  // 压舱石: 科创/创业板宽基
  techBase: [
    { code: '011609', name: '易方达科创50联接C', type: 'fund', minBuy: 10, maxWeight: 0.25 },
    { code: '006928', name: '长城创业板增强C', type: 'fund', minBuy: 10, maxWeight: 0.20 },
  ],

  // 全球科技对冲 (QDII)
  globalTech: [
    { code: '021277', name: '广发全球精选QDII C', type: 'fund', minBuy: 10, maxWeight: 0.20 },
  ],

  // 弹性品种: 券商/传媒
  satellite: [
    { code: '007531', name: '华宝券商联接C', type: 'fund', minBuy: 10, maxWeight: 0.20 },
  ],

  // 防御/价值: 宽基+红利+黄金+短债 (终极版压舱石)
  defense: [
    { code: '007028', name: '易方达沪深300ETF联接C', type: 'fund', minBuy: 10, maxWeight: 0.25 },
    { code: '004753', name: '广发传媒ETF联接C', type: 'fund', minBuy: 10, maxWeight: 0.15 },
    { code: '002907', name: '广发中证全指建筑材料指数C', type: 'fund', minBuy: 10, maxWeight: 0.15 },
  ],
};

// 支付宝费率
const FEE_CONFIG = {
  fund: {
    subscriptionRate: 0,  // C类0申购费
    redemptionRate: { under7: 0.015, under30: 0.005, over30: 0 },
  },
};

// 风控配置 — V5 终极版: 严格控制回撤 + 降低集中 + 强制止损止盈
const RISK_CONFIG = {
  maxSinglePosition: 0.20,      // 单只最大20% (小资金也要分散)
  maxTotalPositions: 7,         // 最多7只 (含防御)
  idealCoreCount: 4,            // 理想核心持仓4只
  stopLossRatio: -0.08,         // -8%硬止损 (终极版更严格)
  cashReserve: 0.15,            // 保留15%现金作为机动
  minHoldingDays: 3,            // 最短持有期(避开C类<7天1.5%赎回费)
  maxTechConcentration: 0.75,   // 科技(成长赛道)集中度上限; 用户偏好全赛道(赚钱优先), 放宽到75%; QDII广发不算入

  // 移动止盈
  takeProfitCeiling: 0.50,
  trailingStopActivation: 0.15,
  trailingStopPct: 0.10,        // 牛市回撤10%止盈
  trailingStopPctBear: 0.05,      // 熊市更紧, 回撤5%止盈

  partialTakeProfitThreshold: 0.20,
  partialTakeProfitPct: 0.30,

  // 体制感知持有天数
  maxHoldingDaysBull: 999,
  maxHoldingDaysSideways: 60,
  maxHoldingDaysBear: 15,       // 熊市缩短到15天

  // 加仓参数
  addPositionThreshold: -0.05,    // 跌5%触发加仓评估
  addPositionMaxPct: 0.20,        // 加仓最多20%可用现金

  // 终极版新增: 大类资产配置目标
  strategicAllocation: {
    growth: 0.35,     // 成长/科技 (信息产业/半导体/科技50)
    value: 0.25,      // 价值/宽基 (沪深300/红利)
    defense: 0.15,    // 防御 (黄金/短债/银行/高股息)
    global: 0.15,     // 全球分散 (QDII)
    cash: 0.10,       // 现金/货基
  },
};

// ============================================================
// 策略模式 — 由用户策略决定决策风格
//   CONSERVATIVE : 降风险/控仓位 (早期默认, 锁定核心仓不动, 贪婪日/熊市抑制买入)
//   PROFIT_FIRST : 赚钱优先/利润最大化 (用户 2026-07-21 设定)
//                   - 锁定的"盈利仓"也做止盈落袋, 锁定的"亏损仓"持有不动不强迫割肉
//                   - 闲置现金主动部署 (降低现金拖累), 强势/回调都照买
//                   - 保留底线: 不强迫亏损仓割肉, 不越跌越补, 硬止损只对非锁定仓生效
// ============================================================
const STRATEGY = 'PROFIT_FIRST';

const STRATEGY_CONFIG = {
  CONSERVATIVE: {
    strategicAllocation: {
      growth: 0.35, value: 0.25, defense: 0.15, global: 0.15, cash: 0.10,
    },
    lockedTakeProfit: false,  // 锁定的核心仓不参与止盈
    greedInhibitBuy: true,    // 贪婪日(市场过热)抑制追高买入
    bearInhibitBuy: true,     // 熊市体制抑制追高买入
    cashTarget: 0.10,         // 保留10%现金
  },
  PROFIT_FIRST: {
    strategicAllocation: {
      growth: 0.50, value: 0.05, defense: 0.15, global: 0.25, cash: 0.05,
    },
    lockedTakeProfit: true,   // ★ 锁定的盈利仓也做止盈, 把利润落袋
    greedInhibitBuy: false,   // ★ 赚钱优先: 不压抑买入, 强势照买
    bearInhibitBuy: false,    // ★ 赚钱优先: 回调即分批建仓, 闲置现金不浪费
    cashTarget: 0.08,         // ★ 更低现金目标, 减少闲置拖累
  },
};

// 用户偏好赛道基金池 — 2026-07-21 用户明确: 不爱宽基(沪深300等), 偏好高弹性特定领域赛道基金
//   (半导体/科创/恒生科技/新能源/券商等"各种赛道"都行), 认为盈利率更高。
//   现金部署/再平衡优先投向此处, 不再投宽基。新增赛道直接往这里加即可。
// 顺序即优先级: 等权分散时按此顺序取前 N 只 (核心科技主线优先, 制造/周期/金融靠后)
const PREFERRED_SECTORS = [
  // —— 核心科技主线 (最高优先级, 用户最偏好的高弹性方向) ——
  { code: '008282', name: '国泰芯片ETF联接C', sector: '半导体', maxWeight: 0.30 },
  { code: '017470', name: '嘉实中证半导体C', sector: '半导体', maxWeight: 0.30 },
  { code: '011609', name: '易方达科创50联接C', sector: '科创', maxWeight: 0.25 },
  { code: '011840', name: '天弘中证人工智能C', sector: '人工智能', maxWeight: 0.25 },
  { code: '008087', name: '华夏中证5G通信主题ETF联接C', sector: '5G通信', maxWeight: 0.25 },
  { code: '012322', name: '东财云计算增强C', sector: '云计算', maxWeight: 0.25 },
  { code: '013402', name: '华夏恒生科技ETF联接C', sector: '恒生科技', maxWeight: 0.25 },
  { code: '012083', name: '博时数字经济混合C', sector: '数字经济', maxWeight: 0.25 },
  // —— 高端制造 / 新能源 ——
  { code: '027495', name: '易方达电池ETF联接C', sector: '新能源', maxWeight: 0.25 },
  { code: '018503', name: '东财光伏C', sector: '光伏', maxWeight: 0.25 },
  { code: '011323', name: '国泰智能汽车股票C', sector: '智能汽车', maxWeight: 0.25 },
  // —— 政策主题 / 周期 / 金融 ——
  { code: '011113', name: '富国军工主题混合C', sector: '军工', maxWeight: 0.20 },
  { code: '012729', name: '国泰中证动漫游戏ETF联接C', sector: '游戏', maxWeight: 0.20 },
  { code: '011631', name: '东财有色增强C', sector: '有色', maxWeight: 0.20 },
  { code: '011036', name: '嘉实中证稀土产业ETF联接C', sector: '稀土', maxWeight: 0.20 },
  { code: '007531', name: '华宝券商联接C', sector: '券商', maxWeight: 0.20 },
];

// 等权分散时最多部署的赛道只数 (资金小, 避免摊得太薄; 回测验证 6-8 只最优)
const MAX_DEPLOY_SECTORS = 8;

// 实时行情驱动动态选基: 每天盘前读实时估值+动量, 挑"当下最强"的 N 只卖出/买入推荐
//   仅在提供 realtimeScores 时生效; 否则回退到上面固定优先级等权分散
//   默认值与持续自我迭代结论对齐: 样本外最优 topK=2 (holdout +13.36%)。
//   运行时若 data/meta_params.json 存在, 以其 selfParams.topK 为准 (由 continual_self_iterate 刷新)。
const REALTIME_PICK_COUNT = 2;

// 技术参数
const TECH_CONFIG = {
  shortMA: 5,
  midMA: 10,
  longMA: 20,
  rsiPeriod: 14,
  rsiOversold: 25,
  rsiOverbought: 75,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  volShortMA: 5,
  volLongMA: 20,
};

// ML配置 V4
const ML_CONFIG = {
  enableLSTM: true,           // LSTM时序预测
  enableLSTMAttention: true,  // ★ V4: LSTM-Attention增强版
  enableRandomForest: true,   // 随机森林分类
  enableGBDT: true,           // 梯度提升回归
  enableHMM: true,            // 隐马尔可夫体制检测
  enableEnsemble: true,       // 集成投票
  enableKalman: true,         // ★ V4: 卡尔曼滤波
  enableARIMA: true,          // ★ V4: ARIMA自回归
  enableSignalFusion: true,   // ★ V4: 多模型信号融合
  enableWalkForward: true,    // ★ V4: Walk-forward回测
  lstmTopN: 25,               // LSTM对前N只基金预测
  rfNTrees: 25,               // 随机森林树数
  gbNTrees: 40,               // GBDT树数
  lstmHiddenSize: 32,         // ★ V4: LSTM隐藏层大小
  lstmNumHeads: 4,            // ★ V4: 注意力头数
  lstmEpochs: 40,             // ★ V4: 训练轮数
  historyDays: 500,           // ★ V4: 历史数据天数(约2年)
};

// 基金筛选配置
const SCREENER_CONFIG = {
  topNPerModule: 100,         // 每模块Top100
  enableAllMarket: true,      // 启用全市场筛选
  maxFundsToAnalyze: 200,     // 最多分析的基金数 (控制时间)
  maxFundsToFetch: 150,       // 最多获取数据的基金数
};

// 推送配置
const PUSH_CONFIG = {
  scheduleTime: '14:30',      // 每日推送时间
  enableDingTalk: true,       // 钉钉推送
  enableConsole: true,        // 控制台输出
};

const DEFAULT_HOLDINGS = [];

module.exports = {
  BUDGET, WATCHLIST, FEE_CONFIG, DEFAULT_HOLDINGS, RISK_CONFIG, TECH_CONFIG,
  ML_CONFIG, SCREENER_CONFIG, PUSH_CONFIG, STRATEGY, STRATEGY_CONFIG, PREFERRED_SECTORS, MAX_DEPLOY_SECTORS, REALTIME_PICK_COUNT,
};
