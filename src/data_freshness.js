/**
 * 数据新鲜度检测
 *
 * 背景(真缺陷): 此前全项目只写 `lastUpdate` 从不读取, 没有任何新鲜度判断。
 * 基金一旦清盘 / 长期停牌 / 数据源中断, 净值停止更新, 系统会拿几个月前的
 * 序列去算动量、跑 LSTM/ARIMA、出买卖指令 —— 模型输入本身就是错的,
 * 而且清盘基金实际根本买不进。
 *
 * 设计要点:
 *   1. 用**交易日**而非自然日计龄。周五出净值、周日看盘, 自然日 2 天但交易日 0 天,
 *      按自然日会把正常基金误判为滞后(QDII 净值普遍 T+1/T+2 公布, 更明显)。
 *   2. 分三档: fresh(可决策) / stale(告警但可用) / dead(不参与决策)。
 *      阈值宽松, 只拦"两周都没净值"这种明确异常。
 *   3. 读不到日期 / 年份无日历数据时退化为 unknown, **保持原有行为**, 不引入新的跳过。
 */

const { isTradingDay } = require('./t1_calendar');

const FRESHNESS_CONFIG = {
  // 相邻净值间隔 ≤ 该交易日数视为新鲜
  freshTradingDays: 5,
  // 超过该交易日数视为"停止更新", 不参与买入/加仓决策
  deadTradingDays: 10,
  // 计龄时最多回溯的自然日数(防止日历缺年份导致死循环)
  maxLookbackDays: 400,
};

/** 把 'YYYY-MM-DD' 解析为本地时间 Date; 非法返回 null */
function parseDateStr(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 只取日期部分, 去掉时刻, 避免"今天下午的净值"被算成未来 */
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * 计算 [from, to] 之间(不含 from, 含 to)的交易日天数。
 * from > to 时返回 0(未来数据不算陈旧)。
 */
function tradingDaysBetween(from, to) {
  const a = startOfDay(from);
  const b = startOfDay(to);
  if (a.getTime() > b.getTime()) return 0;
  let count = 0;
  const cursor = new Date(a);
  for (let i = 0; i < FRESHNESS_CONFIG.maxLookbackDays; i++) {
    cursor.setDate(cursor.getDate() + 1);
    if (cursor.getTime() > b.getTime()) break;
    if (isTradingDay(cursor)) count++;
  }
  return count;
}

/**
 * 评估一条净值序列的新鲜度
 * @param {Array<{date:string}>} history 按日期升序的净值序列
 * @param {Date=} now 参照时刻, 默认当前
 * @returns {{lastDate:string|null, ageCalendarDays:number, ageTradingDays:number,
 *            level:'fresh'|'stale'|'dead'|'unknown', usable:boolean, warning:string|null}}
 */
function assessFreshness(history, now) {
  const ref = now ? startOfDay(now) : startOfDay(new Date());

  if (!Array.isArray(history) || history.length === 0) {
    return {
      lastDate: null,
      ageCalendarDays: Infinity,
      ageTradingDays: Infinity,
      level: 'unknown',
      usable: false,
      warning: '无净值序列',
    };
  }

  // 末尾可能混入占位/脏数据, 从后往前找第一条能解析出日期的
  let last = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const d = parseDateStr(history[i] && history[i].date);
    if (d) { last = d; break; }
  }

  if (!last) {
    return {
      lastDate: null,
      ageCalendarDays: Infinity,
      ageTradingDays: Infinity,
      level: 'unknown',
      usable: true,   // 退化: 保持原行为, 不因为缺日期而误杀
      warning: '净值序列缺少可解析的 date 字段',
    };
  }

  const ageCalendarDays = Math.max(0, Math.round((ref.getTime() - last.getTime()) / 86400000));
  const ageTradingDays = tradingDaysBetween(last, ref);

  let level = 'fresh';
  if (ageTradingDays > FRESHNESS_CONFIG.deadTradingDays) level = 'dead';
  else if (ageTradingDays > FRESHNESS_CONFIG.freshTradingDays) level = 'stale';

  let warning = null;
  if (level === 'stale') {
    warning = `净值滞后 ${ageTradingDays} 个交易日(最后 ${formatDate(last)}), 指标可能失真`;
  } else if (level === 'dead') {
    warning = `净值已 ${ageTradingDays} 个交易日未更新(最后 ${formatDate(last)}), `
      + `可能停牌/清盘/数据源中断, 已排除出买入决策`;
  }

  return {
    lastDate: formatDate(last),
    ageCalendarDays,
    ageTradingDays,
    level,
    usable: level !== 'dead',
    warning,
  };
}

/** 便捷判断: 该序列能否参与买入/加仓决策 */
function isUsableForDecision(history, now) {
  return assessFreshness(history, now).usable;
}

module.exports = {
  FRESHNESS_CONFIG,
  parseDateStr,
  formatDate,
  tradingDaysBetween,
  assessFreshness,
  isUsableForDecision,
};
