/**
 * 基金净值实时预测 + T+1滞后处理
 *
 * 原理:
 *   ETF联接基金 → 跟踪底层ETF实时价格
 *   主动基金 → 跟踪前10重仓股加权涨跌
 *   QDII → 跟踪参考指数(有时差, 用前一日净值)
 *
 * 支付宝T+1规则:
 *   买入: T日15:00前 → T日净值 → T+1确认 → T+2可操作
 *   卖出: T日15:00前 → T日净值 → T+1确认 → T+2到账
 *   因此预测T日净值对当日决策至关重要
 */

const axios = require('axios');
const iconv = require('iconv-lite');

// 基金→底层ETF/指数映射 (用于联接基金净值预测)
const FUND_TRACKER_MAP = {
  '027495': { type: 'etf', code: '159175', market: 'sz', name: '电池ETF' },     // 电池联接→电池ETF
  '008282': { type: 'etf', code: '159995', market: 'sz', name: '芯片ETF' },     // 芯片联接→芯片ETF
  '011609': { type: 'etf', code: '588000', market: 'sh', name: '科创50ETF' },   // 科创联接→科创50ETF
  '006928': { type: 'etf', code: '159915', market: 'sz', name: '创业板ETF' },   // 创业板增强→创业板ETF
  '007531': { type: 'etf', code: '512880', market: 'sh', name: '证券ETF' },     // 券商联接→证券ETF
  '005658': { type: 'etf', code: '510300', market: 'sh', name: '沪深300ETF' },  // 沪深300联接→300ETF
  '004348': { type: 'etf', code: '510500', market: 'sh', name: '中证500ETF' },  // 500联接→500ETF
  '017470': { type: 'index', code: 'sh000688', market: 'sh', name: '科创50指数' },
};

// 主动基金→近似跟踪指数 (用于粗略预测)
const ACTIVE_FUND_INDEX_MAP = {
  '019018': { type: 'index', code: 'sz399006', market: 'sz', name: '创业板指' }, // 信息产业→创业板指
  '021277': { type: 'index', code: 'intl_nasdaq', market: '', name: '纳斯达克' }, // QDII→纳指
};

/**
 * 获取底层ETF/指数实时涨跌幅
 */
async function fetchTrackerChange(market, code) {
  if (!market) return null; // QDII海外无法实时

  try {
    const r = await axios.get(`https://hq.sinajs.cn/list=${market}${code}`, {
      responseType: 'arraybuffer',
      timeout: 8000,
      headers: { 'Referer': 'https://finance.sina.com.cn/' },
    });
    const raw = iconv.decode(Buffer.from(r.data), 'gbk');
    const match = raw.match(/"([^"]*)"/);
    if (!match) return null;

    const fields = match[1].split(',');
    if (fields.length < 4) return null;

    // 指数格式: name, price, changeAmt, changePct, ...
    // ETF格式: name, open, prevClose, price, ...
    if (raw.includes('s_sh') || raw.includes('s_sz')) {
      // 指数
      const price = parseFloat(fields[1]);
      const changePct = parseFloat(fields[3]);
      return { price, changePct };
    } else {
      // ETF/股票: fields[1]=今开, fields[2]=昨收, fields[3]=现价
      const price = parseFloat(fields[3]);
      const prevClose = parseFloat(fields[2]);
      const changePct = prevClose > 0 ? (price - prevClose) / prevClose * 100 : 0;
      return { price: isNaN(price) ? 0 : price, changePct: isNaN(changePct) ? 0 : Math.round(changePct * 100) / 100 };
    }
  } catch (e) {
    return null;
  }
}

/**
 * 预测基金当日净值涨跌幅
 * @returns {{ estimatedChangePct: number, confidence: string, source: string }}
 */
async function predictNavChange(fundCode, fundType) {
  // 1. 先查ETF联接映射
  const tracker = FUND_TRACKER_MAP[fundCode];
  if (tracker) {
    const result = await fetchTrackerChange(tracker.market, tracker.code);
    if (result && result.changePct !== null) {
      // ETF联接基金通常跟踪误差<1%, 直接用ETF涨跌幅
      return {
        estimatedChangePct: Math.round(result.changePct * 100) / 100,
        confidence: 'high',
        source: `${tracker.name} ${result.changePct >= 0 ? '+' : ''}${result.changePct.toFixed(2)}%`,
      };
    }
  }

  // 2. 主动基金用近似指数
  const indexTracker = ACTIVE_FUND_INDEX_MAP[fundCode];
  if (indexTracker) {
    const result = await fetchTrackerChange(indexTracker.market, indexTracker.code);
    if (result && result.changePct !== null) {
      // 主动基金跟指数有偏差, 标记为中等置信度
      return {
        estimatedChangePct: Math.round(result.changePct * 80) / 100, // 打8折(主动基金弹性)
        confidence: 'medium',
        source: `${indexTracker.name} ${result.changePct >= 0 ? '+' : ''}${result.changePct.toFixed(2)}%`,
      };
    }
  }

  return null;
}

/**
 * 批量预测: 输入基金列表, 输出预测的涨跌幅
 */
async function predictAllNavChanges(funds) {
  const predictions = {};
  for (const fund of funds) {
    if (!fund.code) continue;
    const pred = await predictNavChange(fund.code, fund.fundType || fund.type);
    if (pred) predictions[fund.code] = pred;
    await new Promise(r => setTimeout(r, 100)); // 防止限流
  }
  return predictions;
}

/**
 * T+1滞后处理: 计算"今天操作最晚何时生效"
 */
function getSettlementInfo() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const weekday = now.getDay(); // 0=Sun

  // 判断是否在交易时间
  const isTradingHours = weekday >= 1 && weekday <= 5 && (hour > 9 || (hour === 9 && minute >= 30)) && hour < 15;
  const beforeCutoff = hour < 15 || (hour === 15 && minute === 0);

  let settlement;
  if (weekday === 0 || weekday === 6) {
    settlement = '周末休市, 下周一15:00前下单按周一净值';
  } else if (hour >= 15) {
    settlement = '已过15:00, 今日下单按下个交易日净值';
  } else if (isTradingHours) {
    settlement = '15:00前下单按今日净值, T+1确认份额, T+2可赎回';
  } else {
    settlement = '开盘前, 今日15:00前下单按今日净值';
  }

  return {
    isTradingHours,
    beforeCutoff,
    settlement,
    // T+1意味着今天买的明天才确认
    nextConfirmDate: beforeCutoff ? 'T+1(明天)' : 'T+2(后天)',
  };
}

module.exports = { predictNavChange, predictAllNavChanges, getSettlementInfo, FUND_TRACKER_MAP };
