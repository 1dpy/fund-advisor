/**
 * 报告输出模块 V3 — 全交易类型 + ML信号
 */

const chalk = require('chalk');

function printReportV3(decisions) {
  printHeader(decisions);
  printMarketOverviewV3(decisions);
  printSellOrders(decisions.sellOrders);
  printPartialSells(decisions.partialSells);
  printBuyOrders(decisions.buyOrders);
  printSwapPlans(decisions.swapPlans);
  printPartialSwaps(decisions.partialSwaps);
  printAddPositions(decisions.addPositions);
  printReducePositions(decisions.reducePositions);
  printDCAPlans(decisions.dcaPlans);
  printHoldAdvices(decisions.holdAdvices);
  printMLSummary(decisions.mlEnsemble);
  printUSSummary(decisions.usImpact);
  printFundHoldingsSummary(decisions.fundHoldingsAnalysis);
  printT1Info(decisions.t1Timeline);
  printPortfolioSummary(decisions);
  printRiskWarnings(decisions.riskWarnings);
  printDisclaimer();
}

function printHeader(decisions) {
  console.log('');
  console.log(chalk.bold.cyan('╔══════════════════════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║     📈 A股基金智能投资决策系统 V3 (ML增强版)              ║'));
  console.log(chalk.bold.cyan('║     LSTM+RF+GBDT+HMM 全交易类型 · 全市场Top100           ║'));
  console.log(chalk.bold.cyan('╚══════════════════════════════════════════════════════════╝'));
  console.log(chalk.gray(`  数据时间: ${decisions.date}`));
  console.log(chalk.gray(`  总预算: ¥${decisions.budget.toLocaleString()} | 平台: 支付宝(场外C类0申购费)`));
  if (decisions.summary) console.log(chalk.gray(`  摘要: ${decisions.summary}`));
  console.log('');
}

function printMarketOverviewV3(decisions) {
  console.log(chalk.bold.yellow('━━━ 📊 市场全景 ━━━'));

  // 市场体制
  const regime = decisions.marketRegime;
  if (regime) {
    console.log(`  市场体制: ${chalk.bold(regime.regime)} (${regime.confidence}%置信) | 温度: ${decisions.marketTemp}°`);
    console.log(`  ${chalk.gray(regime.description || '')}`);
  }

  // 指数
  if (decisions.indexes && decisions.indexes.length > 0) {
    console.log('  主要指数:');
    for (const idx of decisions.indexes) {
      const pct = idx.changePct;
      const color = pct > 0 ? chalk.red : pct < 0 ? chalk.green : chalk.gray;
      const pctStr = (pct > 0 ? '+' : '') + pct.toFixed(2) + '%';
      console.log(`    ${idx.name.padEnd(10)} ${idx.price.toFixed(2).padStart(10)}  ${color(pctStr)}`);
    }
  }

  // HMM
  if (decisions.hmmResult) {
    const hmm = decisions.hmmResult;
    console.log(`  HMM体制: ${chalk.bold(hmm.currentState)} (${hmm.confidence}%) → ${hmm.positionAdvice}`);
    if (hmm.warning) console.log(`  ${chalk.yellow('⚠️ ' + hmm.warning)}`);
  }

  // 新闻
  if (decisions.newsSentiment?.available) {
    const ns = decisions.newsSentiment;
    console.log(`  新闻情绪: ${ns.sentiment}(${ns.sentimentScore}分) ${ns.positiveCount}好/${ns.negativeNews || ns.negativeCount}坏/${ns.policyCount}政策`);
    if (ns.topSectors?.length > 0) {
      console.log(`  热门行业: ${ns.topSectors.slice(0,3).map(s => `${s.name}(${s.count})`).join(' ')}`);
    }
  }

  // 板块轮动
  if (decisions.rotationSignals?.length > 0) {
    const rotations = decisions.rotationSignals.filter(s => s.type === 'rotation');
    if (rotations.length > 0) {
      const r = rotations[0];
      console.log(`  板块轮动: ${chalk.cyan((r.fromSector||'') + '→' + (r.toSector||''))} ${r.detail}`);
    }
  }

  // 异常
  if (decisions.anomalyAlerts?.length > 0) {
    for (const a of decisions.anomalyAlerts.slice(0, 2)) {
      console.log(`  ${chalk.red('⚠️ ' + a.metric + ': ' + a.detail)}`);
    }
  }
  console.log('');
}

function printSellOrders(orders) {
  if (orders.length === 0) return;
  console.log(chalk.bold.red('━━━ 📤 卖出建议(全部清仓) ━━━'));
  for (const o of orders) {
    const profitColor = o.profit >= 0 ? chalk.red : chalk.green;
    console.log(`\n  ${chalk.bold(o.name)} (${o.code})`);
    console.log(`  卖出 ${o.shares}份 × ¥${o.price.toFixed(3)} = ¥${o.value.toFixed(2)}`);
    if (o.fee > 0) console.log(`  赎回费: ¥${o.fee}(${o.feeLevel}) → 到账¥${o.netValue.toFixed(2)}`);
    console.log(`  盈亏: ${profitColor(o.profitPct + ' (¥' + o.profit.toFixed(2) + ')')} | 持有${o.holdingDays}天`);
    console.log(`  原因: ${chalk.yellow(o.reason)}`);
    if (o.t1Info) console.log(`  ${chalk.gray(o.t1Info.sellTimeline)}`);
  }
  console.log('');
}

function printPartialSells(orders) {
  if (orders.length === 0) return;
  console.log(chalk.bold.yellow('━━━ ✂️ 部分卖出(止盈减仓) ━━━'));
  for (const o of orders) {
    console.log(`\n  ${chalk.bold(o.name)} (${o.code})`);
    console.log(`  卖出${o.sellPct}%: ${o.shares}份 × ¥${o.price.toFixed(3)} = ¥${o.value.toFixed(2)}`);
    if (o.fee > 0) console.log(`  赎回费: ¥${o.fee}(${o.feeLevel}) → 到账¥${o.netValue.toFixed(2)}`);
    console.log(`  剩余: ${o.remainingShares}份 (约¥${o.remainingValue.toFixed(2)}) | 盈亏: ${o.profitPct}`);
    console.log(`  原因: ${chalk.yellow(o.reason)}`);
    if (o.t1Info) console.log(`  ${chalk.gray(o.t1Info.sellTimeline)}`);
  }
  console.log('');
}

function printBuyOrders(orders) {
  if (orders.length === 0) return;
  console.log(chalk.bold.green('━━━ 📥 买入建议(新建仓) ━━━'));
  for (const o of orders) {
    console.log(`\n  ${chalk.bold(o.name)} (${o.code})`);
    console.log(`  买入金额: ${chalk.bold.green('¥' + o.amount.toFixed(2))} (0申购费)`);
    console.log(`  技术评分: ${o.score}分 ${o.signal} ${o.mlSignal ? `[${o.mlSignal} ${o.mlConfidence}%]` : ''}`);
    console.log(`  理由: ${chalk.cyan(o.reason)}`);
    if (o.t1Info) console.log(`  ${chalk.gray(o.t1Info.buyTimeline)}`);
  }
  console.log('');
}

function printSwapPlans(plans) {
  if (plans.length === 0) return;
  console.log(chalk.bold.magenta('━━━ 🔄 转换建议(全部换仓) ━━━'));
  for (const p of plans) {
    console.log(`\n  ${chalk.bold(p.sellName)} → ${chalk.bold.green(p.buyName)}`);
    console.log(`  卖: ${p.sellName} ${p.sellShares}份 ¥${p.sellValue.toFixed(2)} (费¥${p.sellFee} ${p.feeLevel}) [${p.sellScore}分]`);
    console.log(`  买: ${p.buyName} ¥${p.buyAmount.toFixed(0)} [${p.buyScore}分] ${p.buyMlSignal ? `[${p.buyMlSignal}]` : ''}`);
    console.log(`  原因: ${chalk.yellow(p.sellReason)}`);
    if (p.t1Info) console.log(`  ${chalk.gray('T+1: ' + p.t1Info.description)}`);
  }
  console.log('');
}

function printPartialSwaps(swaps) {
  if (swaps.length === 0) return;
  console.log(chalk.bold.blue('━━━ 🔄 部分转换(优化组合) ━━━'));
  for (const s of swaps) {
    console.log(`\n  ${chalk.bold(s.sellName)} ${s.swapPct}%→ ${chalk.bold.green(s.buyName)}`);
    console.log(`  卖${s.swapPct}%: ${s.sellShares}份 ¥${s.sellValue.toFixed(2)} (费¥${s.sellFee})`);
    console.log(`  买: ${s.buyName} ¥${s.buyAmount.toFixed(0)} [${s.buyScore}分]`);
    console.log(`  剩余: ${s.remainingShares}份 ${s.sellName}`);
    console.log(`  原因: ${chalk.yellow(s.reason)}`);
  }
  console.log('');
}

function printAddPositions(positions) {
  if (positions.length === 0) return;
  console.log(chalk.bold.green('━━━ ⬆️ 加仓建议(逢低加仓) ━━━'));
  for (const p of positions) {
    console.log(`\n  ${chalk.bold(p.name)} (${p.code})`);
    console.log(`  加仓: ${chalk.bold.green('¥' + p.amount.toFixed(2))} | 当日${p.changePct.toFixed(1)}% | ${p.signal} ${p.mlSignal ? `[${p.mlSignal}]` : ''}`);
    console.log(`  原因: ${chalk.cyan(p.reason)}`);
  }
  console.log('');
}

function printReducePositions(positions) {
  if (positions.length === 0) return;
  console.log(chalk.bold.yellow('━━━ ⬇️ 减仓建议(控制风险) ━━━'));
  for (const p of positions) {
    console.log(`\n  ${chalk.bold(p.name)} (${p.code})`);
    console.log(`  减仓${p.reducePct}%: ${p.shares}份 × ¥${p.price.toFixed(3)} = ¥${p.value.toFixed(2)} (费¥${p.fee})`);
    if (p.currentWeight) console.log(`  当前仓位: ${p.currentWeight}%`);
    console.log(`  原因: ${chalk.yellow(p.reason)}`);
  }
  console.log('');
}

function printDCAPlans(plans) {
  if (plans.length === 0) return;
  console.log(chalk.bold.cyan('━━━ 📅 定投计划 ━━━'));
  for (const p of plans) {
    console.log(`  ${p.name} (${p.code}): 每周¥${p.weeklyAmount} × ${p.duration}`);
    console.log(`  ${chalk.gray(p.reason)}`);
  }
  console.log('');
}

function printHoldAdvices(advices) {
  if (advices.length === 0) return;
  console.log(chalk.bold.gray('━━━ ✋ 继续持有 ━━━'));
  for (const a of advices) {
    console.log(`  ${a.name} (${a.code}) ${a.signal} ${a.score}分 ${a.profitPct} ${a.holdingDays}天`);
    console.log(`    ${chalk.gray(a.reason)}`);
  }
  console.log('');
}

function printMLSummary(ml) {
  if (!ml) return;
  console.log(chalk.bold.blue('━━━ 🧠 ML集成预测 ━━━'));
  console.log(`  集成信号: ${ml.ensembleSignal?.overall} (看多${ml.ensembleSignal?.bullishRatio}%/看空${ml.ensembleSignal?.bearishRatio}%)`);
  if (ml.modelSummary?.randomForest) console.log(`  随机森林: ${ml.modelSummary.randomForest.accuracy}%准确率 (${ml.modelSummary.randomForest.nTrees}棵树)`);
  if (ml.modelSummary?.gradientBoost) console.log(`  GBDT: RMSE=${ml.modelSummary.gradientBoost.rmse} (${ml.modelSummary.gradientBoost.nTrees}棵树)`);
  if (ml.modelSummary?.lstm) console.log(`  LSTM: ${ml.modelSummary.lstm.predictions}只预测`);
  console.log('');
}

function printUSSummary(us) {
  if (!us?.available) return;
  console.log(chalk.bold.blue('━━━ 🇺🇸 美股前瞻 ━━━'));
  console.log(`  整体情绪: ${us.sentiment} (${us.impactScore}分)`);
  if (us.vix) console.log(`  VIX恐慌指数: ${us.vix.price} (${us.vix.level}) ${us.vix.advice}`);
  if (us.nextDayPrediction) {
    console.log(`  纳指→A股: ${us.nextDayPrediction.description}`);
    console.log(`  建议: ${chalk.yellow(us.nextDayPrediction.advice)}`);
  }
  if (us.sectorRanking?.length > 0) {
    console.log('  板块影响:');
    for (const s of us.sectorRanking.slice(0, 3)) {
      const color = s.impact > 0 ? chalk.red : chalk.green;
      console.log(`    ${s.sector}: ${color((s.impact > 0 ? '+' : '') + s.impact + '%')} (${s.sources.join('+')})`);
    }
  }
  if (us.signals?.length > 0) {
    console.log('  关键信号:');
    for (const s of us.signals.slice(0, 3)) {
      console.log(`    ${s.us} ${s.direction}${s.strength} ${s.sector} (${s.changePct > 0 ? '+' : ''}${s.changePct.toFixed(1)}%)`);
    }
  }
  console.log('');
}

function printFundHoldingsSummary(fha) {
  if (!fha) return;
  console.log(chalk.bold.blue('━━━ 🔬 基金重仓股分析 ━━━'));
  const analyzed = Object.keys(fha.fundHoldings).length;
  console.log(`  已分析: ${analyzed}只基金 | 重叠: ${fha.overlaps.length}对`);

  if (fha.overlaps.length > 0) {
    const highOverlap = fha.overlaps.filter(o => o.overlapCount >= 5);
    if (highOverlap.length > 0) {
      console.log(`  ${chalk.red('⚠️ 高度重叠:')}`);
      for (const o of highOverlap.slice(0, 2)) {
        console.log(`    ${o.fund1} ↔ ${o.fund2}: ${o.overlapCount}只重仓股重叠 (${o.warning})`);
      }
    }
  }

  // 展示前几只基金的重仓股
  const topAnalyzed = Object.entries(fha.fundHoldings).slice(0, 3);
  for (const [code, analysis] of topAnalyzed) {
    if (analysis.available && analysis.topHoldings?.length > 0) {
      console.log(`  ${code} 重仓: ${analysis.topHoldings.slice(0, 5).map(h => `${h.stockName}(${h.percent}%)`).join(' ')}`);
      if (analysis.usExposure?.length > 0) {
        console.log(`    美股关联: ${analysis.usExposure.map(u => `${u.stock}↔${u.usStock}(${u.direction})`).join(' ')}`);
      }
    }
  }
  console.log('');
}

function printT1Info(t1) {
  if (!t1) return;
  console.log(chalk.bold.gray('━━━ ⏰ T+1结算时间线 ━━━'));
  console.log(`  ${t1.description}`);
  console.log(`  ${chalk.gray(t1.buyTimeline)}`);
  console.log(`  ${chalk.gray(t1.sellTimeline)}`);
  console.log(`  ${chalk.gray('最佳窗口: ' + t1.bestWindow)}`);
  console.log('');
}

function printPortfolioSummary(decisions) {
  console.log(chalk.bold.magenta('━━━ 💼 资产配置概览 ━━━'));
  const sellTotal = decisions.sellOrders.reduce((s, o) => s + o.value, 0);
  const partialSellTotal = decisions.partialSells.reduce((s, o) => s + o.value, 0);
  const buyTotal = decisions.buyOrders.reduce((s, o) => s + o.amount, 0);
  const addTotal = decisions.addPositions.reduce((s, o) => s + o.amount, 0);
  const reduceTotal = decisions.reducePositions.reduce((s, o) => s + o.value, 0);
  const holdingsValue = decisions.holdings.reduce((s, h) => s + h.costBasis, 0) - sellTotal - partialSellTotal - reduceTotal;

  console.log(`  当前持仓市值: ¥${holdingsValue.toFixed(2)}`);
  console.log(`  买入+加仓: ¥${(buyTotal + addTotal).toFixed(2)}`);
  console.log(`  卖出+部分卖+减仓: ¥${(sellTotal + partialSellTotal + reduceTotal).toFixed(2)}`);
  console.log(`  预计总持仓: ¥${(holdingsValue + buyTotal + addTotal).toFixed(2)} / ¥${decisions.budget}`);
  console.log(`  仓位比例: ${((holdingsValue + buyTotal + addTotal) / decisions.budget * 100).toFixed(1)}%`);
  const remaining = decisions.budget - holdingsValue - buyTotal - addTotal + sellTotal + partialSellTotal + reduceTotal;
  console.log(`  预计剩余现金: ¥${remaining.toFixed(2)}`);
  console.log('');
}

function printRiskWarnings(warnings) {
  if (!warnings || warnings.length === 0) return;
  console.log(chalk.bold.red('━━━ ⚠️ 风险提示 ━━━'));
  for (const w of warnings) {
    console.log(`  ${chalk.yellow(w)}`);
  }
  console.log('');
}

function printDisclaimer() {
  console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.yellow('⚠️  免责声明: 本系统基于技术分析+机器学习生成建议, 仅供参考,'));
  console.log(chalk.yellow('    不构成投资建议。投资有风险, 交易需谨慎。'));
  console.log(chalk.gray('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');
}

module.exports = { printReportV3 };
