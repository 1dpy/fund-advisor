/**
 * T+1结算日历模块 — 完整的基金交易时间规则
 *
 * 支付宝场外基金规则:
 *   买入: T日15:00前 → 按T日净值 → T+1确认份额 → T+2可赎回
 *   卖出: T日15:00前 → 按T日净值 → T+1确认 → T+2资金到账
 *   QDII: T日15:00前 → 按T+1日净值 → T+2确认 → T+3~T+4到账
 *
 * 14:30决策窗口: 此时距15:00截止还有30分钟,
 *   场外基金实时估值已较准确, 是最佳操作时点
 */

const fs = require('fs');
const path = require('path');
const { FEE_CONFIG } = require('./config');

// ============================================================
//  节假日判断 — 数据驱动 (data/trading_calendar.json)
// ============================================================
// 以前只有 2026 一张硬编码表, 跨年后会静默把节假日当成交易日。
// 现在按年份存 JSON (随仓库发布), 并对"未录入/预填"的年份给出显式警告。
//
// 两个位置, 后者优先:
//   src/trading_calendar.json  — 随仓库发布 (data/ 被 .gitignore 排除, 不能放那边)
//   data/trading_calendar.json — 本地覆盖, 国务院发布新一年安排后可直接改这里, 不用动仓库
const BUILTIN_CALENDAR_FILE = path.join(__dirname, 'trading_calendar.json');
const USER_CALENDAR_FILE = path.join(__dirname, '..', 'data', 'trading_calendar.json');

// 兜底: JSON 缺失/损坏时仍能用 2026 数据 (与迁移前行为一致)
const FALLBACK = {
  years: {
    '2026': {
      holidays: [
        '2026-01-01', '2026-01-02',                     // 元旦
        '2026-02-16', '2026-02-17', '2026-02-18',       // 春节
        '2026-02-19', '2026-02-20', '2026-02-23',       // 春节调休
        '2026-04-06', '2026-04-07', '2026-04-08',       // 清明
        '2026-05-01', '2026-05-04', '2026-05-05',       // 劳动节
        '2026-06-19', '2026-06-22',                     // 端午
        '2026-09-25', '2026-09-28',                     // 中秋调休
        '2026-10-01', '2026-10-02', '2026-10-05',       // 国庆
        '2026-10-06', '2026-10-07', '2026-10-08',       // 国庆
      ],
      workdayWeekends: [
        '2026-02-14', '2026-02-28', '2026-04-26', '2026-09-27', '2026-10-10',
      ],
      provisional: false,
    },
  },
};

function loadCalendar() {
  // 先读内置 (保证 clone 下来就能用), 再读本地覆盖 (允许不动仓库打补丁)
  let merged = null;
  try {
    const raw = JSON.parse(fs.readFileSync(BUILTIN_CALENDAR_FILE, 'utf-8'));
    if (raw && raw.years && Object.keys(raw.years).length > 0) merged = raw;
  } catch (e) { /* 内置文件缺失 → 用兜底表 */ }

  try {
    const raw = JSON.parse(fs.readFileSync(USER_CALENDAR_FILE, 'utf-8'));
    if (raw && raw.years && Object.keys(raw.years).length > 0) {
      merged = merged
        ? { ...merged, years: { ...merged.years, ...raw.years } }
        : raw;
    }
  } catch (e) { /* 无本地覆盖, 正常 */ }

  return merged || FALLBACK;
}

const CALENDAR = loadCalendar();

/**
 * 某一年是否有假期数据
 * @param {number|string} year
 */
function isYearCovered(year) {
  return Object.prototype.hasOwnProperty.call(CALENDAR.years, String(year));
}

/** 已录入的年份列表 (升序) */
function coveredYears() {
  return Object.keys(CALENDAR.years).map(Number).sort((a, b) => a - b);
}

/**
 * 日历状态 — 让调用方能显式提示"这一年的假期表不可靠"
 * @returns {{covered: boolean, provisional: boolean, warning: string|null}}
 */
function calendarStatus(date) {
  const y = String((date || new Date()).getFullYear());
  const entry = CALENDAR.years[y];
  if (!entry) {
    return {
      covered: false,
      provisional: false,
      warning: `⚠️ ${y} 年交易日历未录入, 交易日按"周一至周五"粗略判定 (请补 src/trading_calendar.json 或 data/trading_calendar.json)`,
    };
  }
  if (entry.provisional) {
    return {
      covered: true,
      provisional: true,
      warning: `⚠️ ${y} 年假期表为预填${entry.source ? '(' + entry.source + ')' : ''}, 请核对后使用`,
    };
  }
  return { covered: true, provisional: false, warning: null };
}

// 2026 常量保留导出, 兼容旧引用
const HOLIDAYS_2026 = (CALENDAR.years['2026'] || FALLBACK.years['2026']).holidays;

function yearEntry(d) {
  return CALENDAR.years[String(d.getFullYear())] || null;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 判断是否为交易日
 */
function isTradingDay(date) {
  const d = date || new Date();
  const weekday = d.getDay();
  const dateStr = formatDate(d);
  const entry = yearEntry(d);

  // 周末补班日: 交易
  if (entry && (entry.workdayWeekends || []).includes(dateStr)) return true;
  // 节假日: 不交易
  if (entry && (entry.holidays || []).includes(dateStr)) return false;
  // 周末: 不交易
  if (weekday === 0 || weekday === 6) return false;
  return true;
}

/**
 * 获取下一个交易日
 */
function nextTradingDay(date) {
  const d = new Date(date || new Date());
  d.setDate(d.getDate() + 1);
  while (!isTradingDay(d)) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/**
 * 获取今日 (如果是交易日) 或下一个交易日
 */
function currentOrNextTradingDay(date) {
  const d = date || new Date();
  if (isTradingDay(d)) return d;
  return nextTradingDay(d);
}

// ============================================================
//  结算时间线
// ============================================================

/**
 * 计算基金操作的完整结算时间线
 * @param {string} fundType - 'fund' (普通) | 'qdii' (QDII海外)
 * @param {Date} opTime - 操作时间 (默认当前)
 * @returns {Object} 结算信息
 */
function getSettlementTimeline(fundType = 'fund', opTime = new Date()) {
  const now = opTime;
  const hour = now.getHours();
  const minute = now.getMinutes();
  const isToday = isTradingDay(now);
  const beforeCutoff = hour < 15 || (hour === 15 && minute === 0);

  // 确定T日 (净值日)
  let tDay;
  if (!isToday) {
    tDay = currentOrNextTradingDay(now);
  } else if (beforeCutoff) {
    tDay = new Date(now);
  } else {
    // 15:00后下单, T日 = 下一个交易日
    tDay = nextTradingDay(now);
  }

  const t1Day = nextTradingDay(tDay);  // T+1: 确认日
  const t2Day = nextTradingDay(t1Day); // T+2: 可操作日

  // QDII: 额外延迟1天
  const qdiiOffset = fundType === 'qdii' ? 1 : 0;
  const qdiiConfirm = qdiiOffset > 0 ? nextTradingDay(t1Day) : t1Day;
  const qdiiSettle = qdiiOffset > 0 ? nextTradingDay(t2Day) : t2Day;

  // 生成人类可读的结算说明
  const tDayStr = formatDate(tDay);
  const confirmStr = formatDate(qdiiConfirm);
  const settleStr = formatDate(qdiiSettle);

  let description;
  if (!isToday) {
    const nextDay = currentOrNextTradingDay(now);
    description = `非交易日, ${formatDate(nextDay)} 15:00前下单按当日净值`;
  } else if (!beforeCutoff) {
    description = `已过15:00, 今日下单按 ${tDayStr} 净值结算`;
  } else {
    const remaining = 15 * 60 - (hour * 60 + minute);
    if (remaining > 0 && remaining < 60) {
      description = `⚠️ 距15:00截止仅剩${remaining}分钟! 立即下单按今日(${tDayStr})净值`;
    } else if (remaining >= 60) {
      description = `今日(${tDayStr}) 15:00前下单按今日净值 (剩余${Math.floor(remaining/60)}小时${remaining%60}分)`;
    } else {
      description = `已过15:00, 按下一交易日净值`;
    }
  }

  return {
    operationTime: formatDate(now) + ' ' + String(hour).padStart(2,'0') + ':' + String(minute).padStart(2,'0'),
    isTradingDay: isToday,
    beforeCutoff,
    tDay: tDayStr,
    confirmDay: confirmStr,
    settleDay: settleStr,
    isQDII: fundType === 'qdii',
    description,
    // 买入: T日净值 → T+1确认 → T+2可赎回
    buyTimeline: fundType === 'qdii'
      ? `买入: ${tDayStr} 15:00前 → T+2(${confirmStr})确认 → T+3(${settleStr})可赎回`
      : `买入: ${tDayStr} 15:00前 → T+1(${confirmStr})确认 → T+2(${settleStr})可赎回`,
    // 卖出: T日净值 → T+1确认 → T+2到账
    sellTimeline: fundType === 'qdii'
      ? `赎回: ${tDayStr} 15:00前 → T+2(${confirmStr})确认 → T+3~4(${settleStr}+)资金到账`
      : `赎回: ${tDayStr} 15:00前 → T+1(${confirmStr})确认 → T+2(${settleStr})资金到账`,
    // 最佳操作窗口
    bestWindow: getBestOpWindow(now, isToday, beforeCutoff),
    // 日历可靠性: 未录入年份只按工作日判定, 必须显式提示, 不能假装准确
    calendarStatus: calendarStatus(now),
  };
}

// ============================================================
//  赎回费 (C类) — V3/V5/V6 共用同一套档位
// ============================================================

/**
 * 按持有天数取赎回费率
 * 档位来自 FEE_CONFIG: <7天 1.5%(惩罚性), <30天 0.5%, ≥30天 0
 * @param {number} days - 自然日持有天数
 * @returns {{rate: number, level: 'under7'|'under30'|'free'}}
 */
function getRedemptionFeeRate(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d < 0) return { rate: FEE_CONFIG.fund.redemptionRate.under7, level: 'under7' };
  if (d < 7) return { rate: FEE_CONFIG.fund.redemptionRate.under7, level: 'under7' };
  if (d < 30) return { rate: FEE_CONFIG.fund.redemptionRate.under30, level: 'under30' };
  return { rate: FEE_CONFIG.fund.redemptionRate.over30, level: 'free' };
}

/**
 * 是否值得再等几天把赎回费降到下一档
 * 判断口径: 只省小钱却要拖很久(>10天)不值得; 已经在亏得比手续费还多时不值得
 * @param {number} days - 持有天数
 * @param {number} currentProfit - 当前盈亏比例 (0.05 = +5%)
 */
function shouldWaitForFeeReduction(days, currentProfit = 0) {
  const { rate, level } = getRedemptionFeeRate(days);
  if (rate <= 0) return { shouldWait: false, daysToWait: 0, reason: '' };

  const daysToWait = level === 'under7' ? 7 - days : 30 - days;
  if (daysToWait > 10) {
    return { shouldWait: false, daysToWait, reason: '' };
  }
  // 亏损幅度已超过手续费的两倍 → 别为省手续费硬扛
  if (typeof currentProfit === 'number' && currentProfit < -rate * 2) {
    return { shouldWait: false, daysToWait, reason: '' };
  }
  return {
    shouldWait: true,
    daysToWait,
    reason: `持有${days}天, 赎回费${(rate * 100).toFixed(1)}%; 再等${daysToWait}天可降至下一档`,
  };
}

/**
 * 最佳操作窗口建议
 */
function getBestOpWindow(now, isTrading, beforeCutoff) {
  if (!isTrading) return '今日休市, 可提前挂单等开盘';
  if (!beforeCutoff) return '已过截止时间, 可挂单等明日净值';

  const hour = now.getHours();
  const minute = now.getMinutes();

  if (hour < 9) return '盘前: 可挂单, 按今日净值';
  if (hour < 14) return `盘中: 可操作, 按今日净值 (当前${hour}:${String(minute).padStart(2,'0')})`;
  if (hour === 14 && minute < 30) return `接近尾盘: 建议等待14:30估值更新后再决策`;
  if (hour === 14 && minute >= 30) return `⭐ 最佳决策窗口! 14:30估值已更新, 距截止${15*60-(hour*60+minute)}分钟`;
  if (hour === 15 && minute === 0) return `最后时刻! 立即下单`;
  return '已过截止';
}

module.exports = {
  isTradingDay,
  nextTradingDay,
  currentOrNextTradingDay,
  getSettlementTimeline,
  getRedemptionFeeRate,
  shouldWaitForFeeReduction,
  isYearCovered,
  coveredYears,
  calendarStatus,
  HOLIDAYS_2026,
};
