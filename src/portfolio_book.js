/**
 * 组合账本 — 现金 / 市值 / 仓位的唯一权威口径
 *
 * 背景(真缺陷):
 *   原 V4 用 `BUDGET - ΣcostBasis` 算可用现金, 把现金条目(余额宝)的
 *   costBasis 也当成"已投出去的基金成本"。实测 BUDGET=5500 而
 *   ΣcostBasis=6298.28(含 CASH_YEB 的 3269.26) → 现金算出 -798 → 归零,
 *   买入循环因 buyBudget<100 直接 break, 引擎永远产不出买入指令。
 *
 *   同时"仓位"该按市值算而不是成本: 浮亏 20% 的持仓, 成本占 20%
 *   但实际只压着 16% 的钱, 用成本会低估可投额度。
 *
 * 口径定义:
 *   市值 marketValue = currentValue ?? costBasis   (缺失时才退化到成本)
 *   已投市值 fundValue = 非现金持仓市值之和
 *   手头现金 cashValue = cash 类持仓市值之和
 *   可投额度 deployable = min(手头现金, BUDGET - 已投市值)
 *     —— 两个约束都要: 手里没钱不能买; 预算投满了也不能买
 */

const { BUDGET, WATCHLIST } = require('./config');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 单条持仓的市值: currentValue 优先, 缺失时退化到成本 */
function marketValueOf(h) {
  if (!h) return 0;
  const mv = num(h.currentValue);
  if (mv > 0) return mv;
  return Math.max(0, num(h.costBasis));
}

/**
 * 构建组合账本
 * @param {Array} holdings 全部持仓(含现金条目)
 * @param {number} budget 总预算, 缺省用 config.BUDGET
 * @returns {Object} 账本
 */
function buildBook(holdings, budget) {
  const all = Array.isArray(holdings) ? holdings : [];
  const cap = budget > 0 ? budget : BUDGET;

  // 现金条目(余额宝/现金)是可用的钱, 不是可交易的基金
  const fundHoldings = all.filter(h => h.type !== 'cash');
  const cashHoldings = all.filter(h => h.type === 'cash');

  const fundValue = fundHoldings.reduce((s, h) => s + marketValueOf(h), 0);
  const cashValue = cashHoldings.reduce((s, h) => s + marketValueOf(h), 0);
  const totalValue = fundValue + cashValue;

  // 预算里还没投出去的额度(可能是负数: 已投超预算, 如浮盈后再投入)
  const headroom = Math.max(0, cap - fundValue);

  // 真正能下单的钱 —— 分两种情况, 否则会算错:
  //   有现金条目: 用户显式记了余额宝/现金, 那它就是权威口径,
  //              以实际持有现金为准, 不推荐超出手里有的钱(宁可少投, 不下达无法执行的单)
  //   无现金条目: 现金未被跟踪, 只能假定"预算里没投出去的部分"还趴在账上
  //   (不区分这两种会互相打架: 实盘 5500 预算 / 持仓市值 2910.98 / 现金 2269.26,
  //    中间的 320.76 差额是亏损而不是可用现金, 若一律按预算剩余算就会超发)
  const deployable = cashHoldings.length > 0
    ? Math.min(cashValue, headroom)
    : headroom;

  return {
    budget: cap,
    fundHoldings,
    cashHoldings,
    fundValue,
    cashValue,
    totalValue,
    headroom,
    deployable,
    /** 现金是否被显式跟踪(决定 deployable 的口径) */
    cashTracked: cashHoldings.length > 0,
    /** 已投占预算比 */
    investedRatio: cap > 0 ? fundValue / cap : 0,
    /** 某只基金当前市值 */
    valueOf(code) {
      const h = fundHoldings.find(x => x.code === code);
      return h ? marketValueOf(h) : 0;
    },
  };
}

/**
 * 持仓盈亏率 — 带 fallback 链
 *
 * 背景(真缺陷): 原实现只有 `shares * 现价 / costBasis - 1` 一条路,
 *   shares 缺失(如 V5/V6 路径建仓时拿不到净值)时直接退化成 0,
 *   把真实浮亏抹平。实测 019018 浮亏 -13.97% 早已击穿 -8% 硬止损,
 *   却因为算成 0% 而一直挂在"持有"里, 止损形同虚设。
 *
 * 三级 fallback:
 *   1. shares × 现价            — 最准, 份额与净值都在时用
 *   2. currentValue / costBasis — 份额缺失但 APP 报过市值
 *   3. holdingReturnPct         — 人工录入的浮亏率
 *   4. 0                        — 确实无从判断, 记为 0(不臆造)
 *
 * @param {Object} holding
 * @param {number} currentPrice 当前单位净值
 * @param {string=} source 出参: 返回实际采用的口径, 便于审计与告警
 */
function profitRatio(holding, currentPrice) {
  if (!holding) return 0;
  const cost = num(holding.costBasis);
  if (cost <= 0) return 0;

  const sh = num(holding.shares);
  const px = num(currentPrice);
  if (sh > 0 && px > 0) return (sh * px - cost) / cost;

  const mv = num(holding.currentValue);
  if (mv > 0) return (mv - cost) / cost;

  const hr = num(holding.holdingReturnPct);
  if (hr !== 0) return hr;

  return 0;
}

/** 返回 {ratio, source} 版本, 供需要区分口径的场景(如告警)使用 */
function profitRatioDetailed(holding, currentPrice) {
  const cost = num(holding?.costBasis);
  if (!holding || cost <= 0) return { ratio: 0, source: 'none' };

  const sh = num(holding.shares);
  const px = num(currentPrice);
  if (sh > 0 && px > 0) return { ratio: (sh * px - cost) / cost, source: 'shares' };

  const mv = num(holding.currentValue);
  if (mv > 0) return { ratio: (mv - cost) / cost, source: 'marketValue' };

  const hr = num(holding.holdingReturnPct);
  if (hr !== 0) return { ratio: hr, source: 'recorded' };

  return { ratio: 0, source: 'unknown' };
}

/**
 * 年化波动率 (由日收益序列标准差推出)
 * @param {Array} history [{date, nav}] 升序
 * @returns {number} 年化波动率, 如 0.30 表示 30%
 */
function annualizedVol(history, periodsPerYear = 252) {
  const arr = Array.isArray(history) ? history : [];
  if (arr.length < 10) return 0;
  const rets = [];
  for (let i = 1; i < arr.length; i++) {
    const p0 = num(arr[i - 1]?.nav);
    const p1 = num(arr[i]?.nav);
    if (p0 > 0 && p1 > 0) rets.push(p1 / p0 - 1);
  }
  const n = rets.length;
  if (n < 5) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (n - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 波动率自适应止损
 *
 * 背景: 固定 -8% 对芯片基金和沪深300 用同一根线不合理 ——
 *   芯片年化波动 40%+, 日常震荡就能打到 -8% 被扫出局;
 *   沪深300 年化 18%, -8% 又太松, 真跌起来扛太久。
 *
 * 做法: 以 25% 年化波动为基准, 波动越高止损线越宽,
 *   缩放系数限制在 [0.6, 1.8], 最终止损线限制在 [-15%, -4%]。
 *
 * @param {Array} history 净值序列
 * @param {number} base 基准止损(负数), 如 -0.08
 * @returns {number} 自适应后的止损线(负数)
 */
function adaptiveStopLoss(history, base = -0.08) {
  const vol = annualizedVol(history);
  if (vol <= 0) return base;            // 算不出波动就用基准, 不乱动
  const BASE_VOL = 0.25;
  const scale = clamp(vol / BASE_VOL, 0.6, 1.8);
  return clamp(base * scale, -0.15, -0.04);
}

/**
 * 持仓期间的最高净值 —— 移动止盈的基准。
 *
 * 为什么必须专门算: 原实现 `holding.peakPrice || Math.max(现价, 买入价)`,
 * 而 peakPrice 这个字段全项目从没被写入过(持仓文件里根本没有), 于是:
 *   现价 ≥ 买入价 → peak = 现价 → 回撤恒为 0
 *   现价 < 买入价 → peakProfit ≈ 0 → 激活条件(涨15%)永不满足
 * 两条路都走不到卖出分支 → V4.1 的"移动止盈"自上线起就是死代码,
 * 涨上去的利润一次都没被移动止盈保住过。
 *
 * 取数优先级:
 *   1. 有买入日  → 该日之后(含)的历史最高净值
 *   2. 无买入日  → 最近 lookback 条的历史最高净值
 *   3. 都没有    → fallback(买入价/现价), 与旧行为一致, 不会突然开始乱卖
 *
 * @returns {number} >0 的峰值; 全失败返回 0 由调用方兜底
 */
function peakSince(history, sinceDate, fallback = 0, lookback = 60) {
  const arr = Array.isArray(history) ? history : [];
  let peak = 0;

  const since = sinceDate ? String(sinceDate).slice(0, 10) : '';
  if (since) {
    for (const r of arr) {
      const d = r && r.date ? String(r.date).slice(0, 10) : '';
      if (!d || d < since) continue;              // 买入日之前的涨幅不算自己的
      const v = num(r.nav != null ? r.nav : r.close);
      if (v > 0 && v > peak) peak = v;
    }
  }
  // 买入日缺失或该区间无数据: 退化为最近一段的最高价
  if (peak <= 0 && arr.length > 0) {
    const tail = arr.slice(-Math.max(1, lookback));
    for (const r of tail) {
      const v = num(r && (r.nav != null ? r.nav : r.close));
      if (v > 0 && v > peak) peak = v;
    }
  }
  if (peak <= 0) peak = num(fallback);
  return peak;
}

// 赛道反查表: code → 赛道名。WATCHLIST 是唯一的赛道权威来源。
const SECTOR_BY_CODE = (() => {
  const m = new Map();
  for (const [sector, list] of Object.entries(WATCHLIST || {})) {
    if (!Array.isArray(list)) continue;
    for (const f of list) if (f && f.code) m.set(String(f.code), sector);
  }
  return m;
})();

/** 基金所属赛道, 未收录返回 null */
function sectorOf(code) {
  if (!code) return null;
  return SECTOR_BY_CODE.get(String(code)) || null;
}

/**
 * 某赛道已投市值
 * @param {Array} fundHoldings 非现金持仓
 * @param {string} sector
 */
function sectorExposure(fundHoldings, sector) {
  if (!sector) return 0;
  return (fundHoldings || [])
    .filter(h => sectorOf(h.code) === sector)
    .reduce((s, h) => s + marketValueOf(h), 0);
}

/**
 * 波动率倒数仓位系数
 *
 * 同样的 STRONG_BUY 信号, 年化波动 60% 的芯片基金和 20% 的宽基
 * 不该给一样的仓位 —— 否则组合会系统性超配高波动品种, 回撤也跟着放大。
 * 以 30% 年化波动为中性, 波动越高仓位越小 (系数限幅 0.5~1.5)。
 */
function volPositionScale(history) {
  const vol = annualizedVol(history);
  if (vol <= 0) return 1.0;            // 算不出就不调整, 不乱动
  return clamp(0.30 / vol, 0.5, 1.5);
}

// ============================================================
// 止损卖出冷却期 — 防反复打脸(whipsaw)
// ============================================================
// 刚被 -8% 止损扫出, 隔天信号一翻又买回来, 来回收割是动量策略的经典死法。
// 持仓文件里不留卖出记录, 所以单独存一份。data/ 已被 .gitignore 忽略。
// 测试用 RECENT_SELLS_FILE 指向临时目录, 绝不碰用户真实数据。
const RECENT_SELLS_FILE = process.env.RECENT_SELLS_FILE
  || path.join(ROOT, 'data', 'recent_sells.json');

/** 读取 { code: 'YYYY-MM-DD' } 映射; 文件缺失/损坏时返回空表, 不抛错 */
function loadRecentSells() {
  try {
    const j = JSON.parse(fs.readFileSync(RECENT_SELLS_FILE, 'utf8'));
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch (e) {
    return {};
  }
}

/**
 * 记录一批止损卖出
 * @param {Array<string>} codes
 */
function recordStopLossSells(codes) {
  if (!Array.isArray(codes) || codes.length === 0) return;
  try {
    const map = loadRecentSells();
    const today = new Date().toISOString().slice(0, 10);
    for (const c of codes) if (c) map[String(c)] = today;
    const dir = path.dirname(RECENT_SELLS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RECENT_SELLS_FILE, JSON.stringify(map));
  } catch (e) { /* 记录失败不影响决策 */ }
}

/**
 * 某只基金是否处于卖出冷却期
 * @param {string} code
 * @param {number} days 冷却天数
 * @param {Object=} map 已加载的记录表(避免重复读文件)
 */
function inSellCooldown(code, days, map) {
  if (!code || !(days > 0)) return false;
  const m = map || loadRecentSells();
  const iso = m[String(code)];
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) / 86400000 < days;
}

module.exports = {
  buildBook,
  marketValueOf,
  profitRatio,
  profitRatioDetailed,
  annualizedVol,
  volPositionScale,
  adaptiveStopLoss,
  peakSince,
  sectorOf,
  sectorExposure,
  loadRecentSells,
  recordStopLossSells,
  inSellCooldown,
  clamp,
  num,
};
