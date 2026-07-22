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

// ============================================================
//  节假日判断 (2026年中国法定节假日 + 调休)
// ============================================================

// 2026年休市日 (元旦/春节/清明/劳动/端午/中秋/国庆)
const HOLIDAYS_2026 = [
  '2026-01-01', '2026-01-02',                     // 元旦
  '2026-02-16', '2026-02-17', '2026-02-18',       // 春节
  '2026-02-19', '2026-02-20', '2026-02-23',       // 春节调休
  '2026-04-06', '2026-04-07', '2026-04-08',       // 清明
  '2026-05-01', '2026-05-04', '2026-05-05',       // 劳动节
  '2026-06-19', '2026-06-22',                     // 端午
  '2026-09-25', '2026-09-28',                     // 中秋调休
  '2026-10-01', '2026-10-02', '2026-10-05',       // 国庆
  '2026-10-06', '2026-10-07', '2026-10-08',       // 国庆
];

// 2026年周末补班日 (调休上班, 股市开盘)
const WORKDAY_WEEKENDS_2026 = [
  '2026-02-14',  // 春节前周六补班
  '2026-02-28',  // 春节后周六补班
  '2026-04-26',  // 劳动节前周日补班
  '2026-09-27',  // 国庆前周日补班
  '2026-10-10',  // 国庆后周六补班
];

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

  // 周末补班日: 交易
  if (WORKDAY_WEEKENDS_2026.includes(dateStr)) return true;
  // 节假日: 不交易
  if (HOLIDAYS_2026.includes(dateStr)) return false;
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
  HOLIDAYS_2026,
};
