/**
 * 策略诊断报告 (Strategy Diagnostics)
 * ---------------------------------------------------------------
 * 由 `node main.js --strategy` 调用: 拉取真实持仓的历史净值, 跑《基金量化模型与公式.md》
 * 中的择时(TM/HM)、趋势(均线)、周期(美林时钟)诊断, 输出可读报告。
 *
 * 设计原则:
 *   - 只读不写: 绝不修改 holdings.json (避免像 --apply 那样污染账本)
 *   - best-effort: 网络/缓存缺失时跳过相应模块并说明, 不中断
 *   - 风格回归 / 网格 / 定投 为独立工具函数(见 src/style_analysis.js, strategy_execution.js),
 *     需外部风格因子或计划参数, 不在自动诊断里跑, 但提供调用示例提示。
 */
const { loadHoldings } = require('./advisor_v3');
const { getCachedHistory } = require('./data_collector');
const TM = require('./timing_models');
const SA = require('./style_analysis');
const EX = require('./strategy_execution');
const RM = require('./risk_metrics');

const MARKET_PROXY_CANDIDATES = ['005658', '000300', '110011']; // 宽基代理(沪深300/中证100等)

function navSeriesOf(history) {
  if (!history || !history.length) return [];
  return history.map(h => (h.nav != null ? h.nav : (h.close != null ? h.close : null))).filter(v => v != null && v > 0);
}

async function fetchMarketReturns() {
  for (const code of MARKET_PROXY_CANDIDATES) {
    try {
      const data = await getCachedHistory(code);
      const navs = navSeriesOf(data && data.history);
      if (navs.length > 30) return { code, returns: RM.dailyReturns(navs) };
    } catch (e) { /* try next */ }
  }
  return null;
}

async function runStrategyDiagnose({ marketProxyCode } = {}) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  基金策略诊断 (TM/HM 择时 · 均线趋势 · 美林时钟)');
  console.log('═══════════════════════════════════════════════════');

  const holdings = loadHoldings();
  if (!holdings.length) {
    console.log('  ⚠️ 当前无持仓记录 (holdings.json 为空), 无法诊断。');
    console.log('  可用 `node main.js --input` 录入持仓后再跑。\n');
    return;
  }
  console.log(`  持仓 ${holdings.length} 只: ${holdings.map(h => h.name || h.code).join('、')}\n`);

  // 1) 市场代理收益 (用于 TM/HM 基准)
  let market = null;
  if (marketProxyCode) {
    try {
      const d = await getCachedHistory(marketProxyCode);
      const navs = navSeriesOf(d && d.history);
      if (navs.length > 30) market = { code: marketProxyCode, returns: RM.dailyReturns(navs) };
    } catch (e) {}
  }
  if (!market) market = await fetchMarketReturns();
  if (!market) {
    console.log('  ⚠️ 无法获取市场基准净值(网络/缓存), TM/HM 择时部分跳过。\n');
  } else {
    console.log(`  📊 市场基准: ${market.code} (${market.returns.length} 日收益序列)\n`);
  }

  // 2) 逐基金: TM/HM 择时 + 均线趋势
  console.log('  ── 择时能力与趋势 ──');
  for (const h of holdings) {
    const code = h.code;
    let navs = [];
    try {
      const d = await getCachedHistory(code);
      navs = navSeriesOf(d && d.history);
    } catch (e) {}
    if (navs.length < 30) {
      console.log(`  • ${h.name || code}: 净值数据不足(${navs.length}日), 跳过`);
      continue;
    }
    const rp = RM.dailyReturns(navs);
    let timingLine = 'N/A';
    if (market && market.returns.length === rp.length) {
      const tm = TM.treynorMazuy(rp, market.returns);
      const hm = TM.henikrssonMerton(rp, market.returns);
      const tmT = tm ? tm.timing : 'N/A', hmT = hm ? hm.timing : 'N/A';
      const tmG = tm ? tm.gamma.toFixed(4) : '?', hmG = hm ? hm.gamma.toFixed(4) : '?';
      const tmA = tm ? tm.alpha.toFixed(4) : '?', tmB = tm ? tm.beta.toFixed(3) : '?';
      timingLine = `TM(α=${tmA},β=${tmB},γ=${tmG},择时=${tmT}) HM(γ=${hmG},择时=${hmT})`;
    }
    const ma = TM.maTrend(navs, Math.min(60, navs.length));
    const maLine = ma ? `均线${ma.window}日: ${ma.position === 'above' ? '价格>均线(偏强)' : '价格<均线(偏弱)'} [${ma.signal}]` : '均线N/A';
    console.log(`  • ${h.name || code}(${code})`);
    console.log(`      ${timingLine}`);
    console.log(`      ${maLine}`);
  }

  // 3) 美林时钟: 由市场近期趋势粗估"增长"维度, 通胀维度需手动提供
  console.log('\n  ── 美林时钟(周期定位) ──');
  let growthSign = null;
  if (market) {
    const recent = market.returns.slice(-20);
    const up = recent.filter(r => r > 0).length;
    growthSign = up >= recent.length * 0.55 ? 'up' : 'down';
  }
  // 通胀维度默认未知(需用户/宏观源提供), 此处仅以增长维度演示框架
  const mc = TM.merrillClock({ growth: growthSign || 'down', inflation: null });
  console.log(`  增长维度(近20日市场强弱粗估): ${growthSign === 'up' ? '向上' : '向下'}`);
  console.log(`  通胀维度: 未提供(需宏观数据 CPI/PPI), 暂按"非高通胀"处理`);
  console.log(`  → 当前阶段: ${mc.name} (${mc.regime})`);
  console.log(`  配置指引: ${mc.allocation.join(' / ')}`);
  console.log(`  逻辑: ${mc.rationale}`);

  // 4) 其它策略工具提示
  console.log('\n  ── 其它策略模块(独立工具, 需参数/因子) ──');
  console.log('  • 风格约束回归 styleRegression(): 用风格因子收益解释基金, 检测"挂羊头卖狗肉"');
  console.log('  • 定投摊薄 dcaCost(): 定期定额成本与盈亏');
  console.log('  • 网格交易 gridTrading(): 震荡市低买高卖');
  console.log('  • 再平衡 rebalanceTarget() / 回撤熔断 drawdownCircuitBreaker(): 仓位纪律');
  console.log('  以上均为纯函数, 见 src/style_analysis.js 与 src/strategy_execution.js, 可直接 import 复用。\n');
  console.log('═══════════════════════════════════════════════════\n');
}

module.exports = { runStrategyDiagnose, navSeriesOf };
