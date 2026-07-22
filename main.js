/**
 * A股基金智能投资决策系统 V4
 *
 * V4升级:
 *   - 7模型融合: LSTM-Attention + RF + GBDT + Kalman + ARIMA + HMM + Tech
 *   - 50+维特征工程 (动量/均线/波动率/统计/跨时间框架/市场环境)
 *   - 深度历史数据训练 (500天, 本地缓存)
 *   - Walk-forward回测验证
 *   - 体制感知动态权重 + 相关性惩罚
 *   - 纯操作指令输出 (只有买卖代码+金额, 无分析)
 *
 * 用法:
 *   node main.js                        # 完整分析+操作指令
 *   node main.js --json                 # JSON格式输出
 *   node main.js --ding                 # 钉钉推送纯操作
 *   node main.js --input                # 交互式输入持仓
 *   node main.js --apply                # 生成建议后更新持仓
 *   node main.js --train                # 预训练模型 (离线)
 */

const readline = require('readline');
const { fetchAllData } = require('./src/fetcher');
const { rankFundsV2 } = require('./src/analyzer_v2');
const { applyDecisions, loadHoldings, saveHoldings } = require('./src/advisor_v3');
const { generateAdviceV4 } = require('./src/advisor_v4');
const { formatOperations, printOperations } = require('./src/reporter_v4');
const { parseHoldingsText, interactiveTextInput } = require('./src/parser');
const { sendMarkdown, formatDingtalkV4 } = require('./src/dingtalk_v4');
const { analyzeNewsSentiment } = require('./src/news');
const { analyzeMarketSentiment } = require('./src/sentiment_engine');
const { detectRotation } = require('./src/rotation');
const { runFactorAttribution } = require('./src/quant/factor');
const { trainHMMPro, extractFeatures } = require('./src/quant/hmm_pro');
const { ensembleVote } = require('./src/quant/ensemble');
const { scanAnomalies } = require('./src/quant/anomaly');
const { optimizeParameters } = require('./src/quant/bayesian');
const { predictAllNavChanges, getSettlementInfo } = require('./src/nav_predictor');
const { fetchUSImpactV2 } = require('./src/us_market_v2');
const { runMLEnsemble } = require('./src/quant/ml_ensemble');
const { analyzeFundHoldings } = require('./src/holdings_analyzer');
const { getSettlementTimeline } = require('./src/t1_calendar');
const { generateUltimatePortfolioAdvice } = require('./src/advisor_v5_ultimate');
const { fetchRealtimeSectorScores, loadMetaWeights } = require('./src/realtime_quotes');
const { generateAggressivePortfolioAdvice } = require('./src/advisor_v6_aggressive');
const { applyAdvice } = require('./src/apply_advice');
const { recordDecision } = require('./src/evolution');
const { batchFetchHistory, getCachedHistory } = require('./src/data_collector');
const { walkForwardValidation } = require('./src/quant/walk_forward');

async function interactiveInputHoldings() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (q) => new Promise(resolve => rl.question(q, resolve));
  console.log('\n📝 === 手动输入今日持仓 ===\n');
  const holdings = [];
  while (true) {
    const code = await question('  基金代码 (或 done 完成): ');
    if (!code.trim() || code.trim().toLowerCase() === 'done') break;
    const name = await question('  基金名称: ');
    const typeQ = await question('  类型 (etf=场内 / fund=场外, 默认fund): ');
    const type = typeQ.trim() === 'etf' ? 'etf' : 'fund';
    const buyPriceStr = await question('  买入均价 (元): ');
    const buyPrice = parseFloat(buyPriceStr);
    if (isNaN(buyPrice) || buyPrice <= 0) { console.log('  ⚠️ 价格无效\n'); continue; }
    const sharesStr = await question('  持有份额 (股/份): ');
    const shares = parseFloat(sharesStr);
    if (isNaN(shares) || shares <= 0) { console.log('  ⚠️ 份额无效\n'); continue; }
    const costBasis = Math.round(shares * buyPrice * 100) / 100;
    const buyDate = await question('  买入日期 (YYYY-MM-DD): ') || new Date().toISOString().split('T')[0];
    holdings.push({ code: code.trim(), name: name.trim() || code.trim(), type, buyPrice, shares, costBasis, buyDate });
    console.log(`  ✅ 已添加: ${name || code} ${shares}份 @¥${buyPrice} 成本¥${costBasis}\n`);
  }
  rl.close();
  return holdings;
}

async function pretrainModels(funds) {
  console.log('🏋️ 预训练模型中...');
  const { predictWithLSTMAttention } = require('./src/quant/lstm_attention');
  const { predictARIMA } = require('./src/quant/arima_lite');
  const { predictWithKalman } = require('./src/quant/kalman_filter');

  let trained = 0;
  const top20 = funds.slice(0, 20);

  for (const fund of top20) {
    try {
      const cached = await getCachedHistory(fund.code, true);
      if (cached && cached.history && cached.history.length > 50) {
        // 预热LSTM
        predictWithLSTMAttention(cached.history, 20, 5);
        // 预热ARIMA
        predictARIMA(cached.history, 5, 1, 5);
        // 预热Kalman
        predictWithKalman(cached.history, 5);
        trained++;
        process.stdout.write('.');
      }
    } catch (e) { /* skip */ }
  }
  console.log(`\n  预训练完成: ${trained}/${top20.length} 只基金`);
  return trained;
}

async function main() {
  const args = process.argv.slice(2);
  const showJson = args.includes('--json');
  const applyMode = args.includes('--apply');
  const inputMode = args.includes('--input');
  const textMode = args.includes('--text');
  const dingMode = args.includes('--ding');
  const trainMode = args.includes('--train');
  const ultimateMode = args.includes('--ultimate');
  const aggressiveMode = args.includes('--aggressive');

  if (dingMode || args.includes('--fresh')) {
    delete require.cache[require.resolve('./src/news')];
    delete require.cache[require.resolve('./src/fetcher')];
    delete require.cache[require.resolve('./src/nav_predictor')];
    delete require.cache[require.resolve('./src/us_market_v2')];
  }

  const quiet = dingMode;

  try {
    // 0. 持仓输入
    if (textMode) {
      const textIdx = args.indexOf('--text');
      const textArg = args[textIdx + 1] && !args[textIdx + 1].startsWith('--') ? args[textIdx + 1] : null;
      let holdings;
      if (textArg) {
        holdings = parseHoldingsText(textArg);
      } else {
        holdings = await interactiveTextInput();
      }
      if (holdings.length > 0) {
        saveHoldings(holdings);
        console.log(`✅ 持仓已更新: ${holdings.length} 只基金\n`);
      }
    } else if (inputMode) {
      const holdings = await interactiveInputHoldings();
      if (holdings.length > 0) {
        saveHoldings(holdings);
        console.log(`\n✅ 已更新持仓: ${holdings.length} 只基金\n`);
      }
    }

    // V5 终极版快速通道: 不依赖全市场数据拉取, 直接基于持仓生成配置再平衡建议
    if (ultimateMode) {
      if (!quiet) console.log('🧠 基金助手·终极版 V5 启动中...');
      let v5Sentiment = null;
      try { v5Sentiment = await analyzeMarketSentiment(); } catch (e) {}
      // ★ 实盘默认: 实时行情驱动动态选基(用户2026-07-22: 先读当时行情, 挑当下最强4只, 不固定)
      //   盘中估值(同花顺/东财) + 近期动量(lsjz) 综合打分, 取 Top-4 部署; 抓不到自动回退动量/静态
      //   LSTM选基(--ml) 仅研究模式, 数据证明样本外跑输动态/等权, 不用于实盘
      let mlPicks = null;
      let realtimeScores = null;
      if (args.includes('--ml')) {
        try {
          const { getSectorMLRanking, getMLPicks } = require('./src/ml_sector_selector');
          const mlRanking = await getSectorMLRanking({ useCache: true });
          mlPicks = getMLPicks(mlRanking, 2);
          if (!quiet) console.log('  🤖 ML选基(研究模式): ' + (mlPicks.length ? mlPicks.map(p => `${p.sector}(mlScore=${p.mlScore})`).join(' + ') : '空仓门触发'));
        } catch (e) { if (!quiet) console.log('  ML选基失败: ' + e.message); mlPicks = null; }
      } else {
        try {
          if (!quiet) process.stdout.write('  📡 读取实时行情(ETF实时成交价+动量), 动态选基中... ');
          // 把持续自我迭代产出的元参数(动量/估值权重)喂给实时综合分, 实现"实时+历史"结合
          const metaWeights = loadMetaWeights();
          realtimeScores = await fetchRealtimeSectorScores({ days: 12, delayMs: 120, metaWeights: metaWeights || undefined });
          const top = realtimeScores.slice(0, 4);
          if (!quiet) console.log('完成');
          if (!quiet) {
            console.log('  🔥 当日最强赛道 Top4:');
            top.forEach((r, i) => {
              const chg = r.changePct != null ? `实时${r.changePct >= 0 ? '+' : ''}${r.changePct}%` : '实时-N/A';
              console.log(`     ${i + 1}. ${r.name}(${r.code}) ${r.sector} | ${chg} / 近5日${r.mom5 >= 0 ? '+' : ''}${r.mom5}% | 综合分${r.score}`);
            });
          }
        } catch (e) {
          if (!quiet) console.log('  ⚠️ 实时行情获取失败, 回退静态等权分散: ' + e.message);
          realtimeScores = null;
        }
      }
      const advice = generateUltimatePortfolioAdvice(v5Sentiment, mlPicks, realtimeScores);
      // 进化层: 记录本次决策(日期/体制/情绪/操作), 供未来命中率统计与参数自调
      try { recordDecision(advice, v5Sentiment); } catch (e) {}
      // 建议即执行: 用户授权"默认按说的买", --apply 触发写回持仓
      if (applyMode) {
        try {
          const res = applyAdvice(advice);
          if (!quiet) {
            console.log('\n💾 已按建议更新持仓 (holdings.json):');
            res.log.forEach(l => console.log('   ' + l));
          }
        } catch (e) { console.error('应用建议失败:', e.message); }
      }
      if (showJson) {
        console.log(JSON.stringify(advice, null, 2));
      } else {
        printUltimateAdvice(advice);
      }
      if (dingMode) {
        process.stdout.write('📱 正在推送到钉钉... ');
        const dingContent = formatDingtalkUltimate(advice);
        // AI 自然语言解读 (环境门控: 仅配置 LLM_API_KEY 时生成, 未配置优雅跳过)
        let dingContentFinal = dingContent;
        if (process.env.LLM_API_KEY) {
          try {
            const { generateExplanation } = require('./src/llm_report');
            const explanation = await generateExplanation(advice);
            if (explanation) dingContentFinal = dingContent + `\n\n---\n💡 **AI 解读**\n> ${explanation.replace(/\n/g, '\n> ')}`;
          } catch (e) { if (!quiet) console.log('  (LLM解读跳过: ' + e.message + ')'); }
        }
        const ok = await sendMarkdown('基金操作指令V5', dingContentFinal);
        console.log(ok ? '✅ 已发送!' : '❌ 发送失败');
      }
      return;
    }

    // V6 激进科技增强版: 动量轮动+趋势择时+金字塔加仓+ATR动态止损
    if (aggressiveMode) {
      if (!quiet) console.log('🚀 基金助手·激进科技增强版 V6 启动中...');
      let v6Sentiment = null;
      try { v6Sentiment = await analyzeMarketSentiment(); } catch (e) {}
      const advice = await generateAggressivePortfolioAdvice(v6Sentiment);
      if (showJson) {
        console.log(JSON.stringify(advice, null, 2));
      } else {
        printAggressiveAdvice(advice);
      }
      if (dingMode) {
        process.stdout.write('📱 正在推送到钉钉... ');
        const dingContent = formatDingtalkAggressive(advice);
        const ok = await sendMarkdown('基金操作指令V6激进版', dingContent);
        console.log(ok ? '✅ 已发送!' : '❌ 发送失败');
      }
      return;
    }

    if (!quiet) console.log('🚀 A股基金智能投资决策系统 V4 启动中...\n');    // 1. 获取市场数据 (含全市场Top100筛选)
    const allData = await fetchAllData();
    if (allData.funds.length === 0) {
      console.error('❌ 未获取到任何基金数据, 请检查网络');
      process.exit(1);
    }

    // 3.5 市场情绪引擎 (恐慌贪婪指数)
    let marketSentiment = null;
    try {
      if (!quiet) process.stdout.write('😰 正在分析市场情绪(恐慌贪婪指数)... ');
      marketSentiment = await analyzeMarketSentiment(allData);
      if (!quiet) console.log(`${marketSentiment.labelCN}(${marketSentiment.score}分) ${marketSentiment.advice}`);
    } catch (e) { if (!quiet) console.log('情绪分析失败'); }

    // 2. 预训练模式: 获取深度历史 + 训练模型
    if (trainMode) {
      console.log('\n📦 预训练模式: 获取深度历史数据...');
      const topCodes = allData.funds.slice(0, 30).map(f => f.code);
      await batchFetchHistory(topCodes, 6);
      await pretrainModels(allData.funds);

      // Walk-forward验证
      console.log('\n📊 Walk-forward回测验证...');
      let wfCount = 0;
      for (const fund of allData.funds.slice(0, 10)) {
        try {
          const cached = await getCachedHistory(fund.code);
          if (cached && cached.history && cached.history.length > 120) {
            const wf = walkForwardValidation(cached.history, 3);
            if (wf && wf.folds.length > 0) {
              wfCount++;
              if (!quiet) {
                console.log(`  ${fund.name}: Sharpe=${wf.avgTestSharpe.toFixed(2)} 胜率=${(wf.avgTestWinRate*100).toFixed(0)}%`);
              }
            }
          }
        } catch (e) { /* skip */ }
      }
      console.log(`\n✅ 预训练完成! ${wfCount} 只基金验证通过`);
      if (!dingMode) process.exit(0);
    }

    // 3. 新闻情绪
    let newsSentiment = null;
    try {
      if (!quiet) process.stdout.write('📰 正在分析财经新闻情绪... ');
      newsSentiment = await analyzeNewsSentiment();
      if (!quiet) console.log(newsSentiment.available
        ? `${newsSentiment.sentiment}(${newsSentiment.sentimentScore}分) ${newsSentiment.totalNews}条`
        : '不可用');
    } catch (e) { if (!quiet) console.log('新闻获取失败'); }

    // 4. 净值预测 + T+1结算
    let navPredictions = {};
    let settlementInfo = getSettlementInfo();
    let t1Timeline = getSettlementTimeline('fund');
    try {
      navPredictions = await predictAllNavChanges(allData.funds);
      if (!quiet && Object.keys(navPredictions).length > 0) {
        console.log('📈 净值预测:', Object.keys(navPredictions).length, '只');
        console.log('  T+1:', t1Timeline.description);
      }
    } catch (e) { /* skip */ }

    // 5. 增强美股前瞻分析
    let usImpact = null;
    try {
      if (!quiet) process.stdout.write('🇺🇸 正在分析美股前瞻(VIX+纳指+传导)... ');
      usImpact = await fetchUSImpactV2();
      if (!quiet) console.log(usImpact?.available
        ? `${usImpact.sentiment} | 信号${usImpact.signals.length}条${usImpact.vix ? ` | VIX:${usImpact.vix.price}` : ''}`
        : '无数据');
    } catch (e) { if (!quiet) console.log('失败'); }

    // 6. 技术分析 + 排名
    if (!quiet) console.log('🔍 正在进行技术分析(12+指标)...');
    const analysisResult = rankFundsV2(allData);
    analysisResult.navPredictions = navPredictions;
    analysisResult.settlementInfo = settlementInfo;
    analysisResult.usImpact = usImpact;
    analysisResult.t1Timeline = t1Timeline;

    // 新闻情绪修正
    if (newsSentiment?.available) {
      const origTemp = analysisResult.marketTemp;
      analysisResult.marketTemp = Math.round(Math.max(0, Math.min(100, origTemp * newsSentiment.adjustmentFactor)));
      analysisResult.newsSentiment = newsSentiment;
    }
    analysisResult.marketSentiment = marketSentiment;

    // 板块轮动
    let rotationSignals = [];
    try {
      rotationSignals = detectRotation(analysisResult.rankedFunds, {});
      if (rotationSignals.length > 0 && !quiet) console.log('🔄 板块轮动:', rotationSignals.length, '条');
    } catch (e) { /* skip */ }
    analysisResult.rotationSignals = rotationSignals;

    // 7. HMM Pro体制检测
    let hmmResult = null;
    let ensembleResult = null;
    let anomalyAlerts = [];
    try {
      const features = extractFeatures(allData.indexes, 45);
      if (features && features.length >= 30) {
        hmmResult = trainHMMPro(features, 4, 30);
        if (!quiet && hmmResult) console.log('🔮 HMM Pro:', hmmResult.currentState, `(${hmmResult.confidence}%)`, hmmResult.warning || '');
      }
      const idxHist = allData.funds.find(f => f.code === '005658')?.history || allData.funds[0]?.history;
      if (idxHist) {
        const closes = idxHist.map(h => h.close || h.nav || 0).filter(v => v > 0);
        if (closes.length >= 25) {
          ensembleResult = ensembleVote(closes);
          if (!quiet) console.log('🧠 集成信号:', ensembleResult.signal, `(共识${ensembleResult.agreement})`);
        }
      }
      anomalyAlerts = scanAnomalies(allData.indexes, allData.funds);
      if (!quiet && anomalyAlerts.length > 0) console.log('⚠️ 异常信号:', anomalyAlerts.length, '条');
    } catch (e) { /* skip */ }
    analysisResult.hmmResult = hmmResult;
    analysisResult.ensembleResult = ensembleResult;
    analysisResult.anomalyAlerts = anomalyAlerts;

    // 8. 因子归因 + 贝叶斯优化
    let factorResult = null;
    try {
      const currentHoldings = loadHoldings();
      if (currentHoldings.length > 0) {
        const fundHists = {};
        for (const fund of allData.funds) {
          if (fund.history && fund.history.length > 20) fundHists[fund.code] = fund.history;
        }
        const benchmarks = {
          market: allData.funds.find(f => f.code === '005658')?.history || allData.funds[0]?.history,
          sector: allData.funds.find(f => f.code === '011609')?.history,
        };
        factorResult = runFactorAttribution(currentHoldings, fundHists, benchmarks);
        if (!quiet && factorResult?.available) console.log('📐 因子归因:', factorResult.attribution);
      }
    } catch (e) { /* skip */ }
    analysisResult.factorResult = factorResult;

    let bayesianResult = null;
    try {
      const fundHists = {};
      for (const fund of allData.funds) {
        if (fund.history && fund.history.length > 20) fundHists[fund.code] = fund.history;
      }
      bayesianResult = optimizeParameters(fundHists, 20);
      if (!quiet && bayesianResult) console.log('🎯 贝叶斯优化:', JSON.stringify(bayesianResult.optimized));
    } catch (e) { /* skip */ }
    analysisResult.bayesianResult = bayesianResult;

    // 9. ML集成预测 (LSTM + RF + GBDT)
    let mlEnsemble = null;
    try {
      if (!quiet) console.log('🧠 正在运行ML集成预测(LSTM+RF+GBDT)...');
      mlEnsemble = runMLEnsemble(analysisResult.rankedFunds, hmmResult);
      if (!quiet && mlEnsemble) {
        console.log(`  LSTM: ${mlEnsemble.modelSummary?.lstm?.predictions || 0}只预测`);
        console.log(`  随机森林: ${mlEnsemble.modelSummary?.randomForest?.accuracy || 0}%准确率`);
        console.log(`  GBDT: RMSE=${mlEnsemble.modelSummary?.gradientBoost?.rmse || '?'}`);
        console.log(`  集成信号: ${mlEnsemble.ensembleSignal?.overall} (多${mlEnsemble.ensembleSignal?.bullishRatio}%/空${mlEnsemble.ensembleSignal?.bearishRatio}%)`);
      }
    } catch (e) { if (!quiet) console.log('  ML预测失败:', e.message); }
    analysisResult.mlEnsemble = mlEnsemble;

    // 10. 基金持仓分析
    let fundHoldingsAnalysis = null;
    try {
      if (!quiet) process.stdout.write('🔬 正在分析基金重仓股... ');
      const topFunds = analysisResult.rankedFunds.slice(0, 30);
      fundHoldingsAnalysis = await analyzeFundHoldings(topFunds, usImpact);
      if (!quiet) {
        const analyzed = Object.keys(fundHoldingsAnalysis.fundHoldings).length;
        const overlaps = fundHoldingsAnalysis.overlaps.length;
        console.log(`${analyzed}只分析, ${overlaps}对重叠`);
      }
    } catch (e) { if (!quiet) console.log('失败'); }
    analysisResult.fundHoldingsAnalysis = fundHoldingsAnalysis;

    // 11. ★ V4 信号融合 + 操作指令生成
    if (!quiet) console.log('\n🧠 V4 7模型信号融合中 (LSTM-Att+RF+GBDT+Kalman+ARIMA+HMM+Tech)...');
    const currentHoldings = loadHoldings();
    const marketRegime = {
      regime: analysisResult.marketRegime?.regime || 'SIDEWAYS',
      confidence: analysisResult.marketRegime?.confidence || 50,
    };
    const decisions = await generateAdviceV4(allData, currentHoldings, mlEnsemble, usImpact, marketRegime, marketSentiment);

    // 12. 输出操作指令
    if (showJson) {
      console.log(JSON.stringify(decisions, null, 2));
    } else if (!quiet) {
      printOperations(decisions);
    }

    // 13. 应用决策
    if (applyMode) {
      console.log('\n⚠️  确认应用以上决策? (将更新持仓记录) [y/N]');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise(resolve => {
        rl.question('', ans => { rl.close(); resolve(ans.trim().toLowerCase()); });
      });
      if (answer === 'y' || answer === 'yes') {
        applyDecisions(decisions);
        console.log('✅ 持仓已更新');
      } else {
        console.log('已取消');
      }
    }

    // 14. 钉钉推送 (纯操作指令)
    if (dingMode) {
      process.stdout.write('📱 正在推送到钉钉... ');
      const dingContent = formatDingtalkV4(decisions);
      const ok = await sendMarkdown('基金操作指令V4', dingContent);
      console.log(ok ? '✅ 已发送!' : '❌ 发送失败');
    }

    if (!quiet) console.log('\n✅ V4分析完成!');

  } catch (err) {
    console.error('❌ 系统错误:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

function printUltimateAdvice(advice) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  基金助手·终极版 V5 每日操作指令');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  日期: ${advice.date}`);
  if (advice.message) {
    console.log(`  状态: ${advice.message}\n`);
    return;
  }
  console.log(`  市场体制: ${advice.regime} (置信${advice.regimeConfidence}%)`);
  if (advice.strategy) console.log(`  策略模式: ${advice.strategy === 'PROFIT_FIRST' ? '赚钱优先 (PROFIT_FIRST)' : advice.strategy}`);
  if (advice.marketSentiment) {
    const ms = advice.marketSentiment;
    console.log(`  市场情绪: ${ms.labelCN} (恐慌贪婪指数 ${ms.score}/100) [${ms.tradingBias}]`);
    console.log(`  情绪建议: ${ms.advice}`);
  }
  console.log(`  总资产: ¥${advice.totalAsset.toFixed(2)}`);
  console.log(`  可用现金: ¥${advice.cash.toFixed(2)}`);
  console.log(`  科技集中度: ${(advice.techConcentration * 100).toFixed(1)}% (上限50%)`);
  console.log(`  最大单只仓位: ${(advice.maxSingleWeight * 100).toFixed(1)}% (上限20%)`);
  const now = new Date();
  const dayNum = now.getDay();
  const isTodayTrading = dayNum >= 1 && dayNum <= 5;
  const passedDeadline = now.getHours() >= 15;
  const wkNames = ['周日','周一','周二','周三','周四','周五','周六'];
  const nextTradingDayStr = (d) => {
    const nd = new Date(d);
    do { nd.setDate(nd.getDate() + 1); } while (nd.getDay() < 1 || nd.getDay() > 5);
    return `${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,'0')}-${String(nd.getDate()).padStart(2,'0')} ${wkNames[nd.getDay()]}`;
  };
  let opHint;
  if (!isTodayTrading) {
    opHint = `今日非交易日, 最早可操作日期: ${nextTradingDayStr(now)} 15:00前`;
  } else if (passedDeadline) {
    opHint = `今日已收盘(${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}), 最早可操作日期: ${nextTradingDayStr(now)} 15:00前`;
  } else {
    const minsLeft = (15 - now.getHours()) * 60 - now.getMinutes();
    opHint = `今日交易日进行中, 距15:00收盘还有 ${minsLeft} 分钟, 请尽快操作`;
  }
  console.log(`\n  T+1 / 周末规则:`);
  console.log(`    - 场外基金交易日 15:00 前下单, 按当日净值 T+1 确认`);
  console.log(`    - 周六/周日/节假日不交易, 下个交易日才能操作`);
  console.log(`    - ${opHint}`);

  console.log('\n  当前配置 vs 目标:');
  for (const k of Object.keys(advice.sectorWeights)) {
    const cur = (advice.sectorWeights[k] * 100).toFixed(1);
    const tgt = ((advice.targetWeights[k] || 0) * 100).toFixed(0);
    console.log(`    ${k.padEnd(8)} 当前 ${cur.padStart(5)}%  目标 ${tgt.padStart(5)}%`);
  }
  console.log('\n  今日操作清单:');
  if (advice.operations.length === 0) {
    console.log('    无');
  } else {
    let idx = 1;
    for (const op of advice.operations) {
      const amount = op.amount ? ` ¥${op.amount.toFixed(2)}` : '';
      const target = op.target ? ` → ${op.target}` : '';
      console.log(`    ${idx}. [${op.action}] ${op.name}${amount}${target}`);
      console.log(`       原因: ${op.reason}`);
      console.log(`       紧急度: ${op.urgency || 'LOW'}`);
      idx++;
    }
  }
  console.log('═══════════════════════════════════════════════════\n');
}

// V5 钉钉推送专用格式化 — 纯操作指令, 看到就能在支付宝执行
function formatDingtalkUltimate(advice) {
  if (advice.message) {
    return `## 📋 基金助手·终极版 V5\n\n> ${advice.date} ${advice.message}`;
  }
  const lines = [];
  lines.push(`## 📋 基金操作指令 V5 ${advice.date}`);
  lines.push('');
  lines.push(`**体制**: ${advice.regime} (置信${advice.regimeConfidence}%)`);
  lines.push(`**策略**: ${advice.strategy === 'PROFIT_FIRST' ? '赚钱优先' : (advice.strategy || 'CONSERVATIVE')}`);
  lines.push(`**总资产**: ¥${advice.totalAsset.toFixed(0)} | **现金**: ¥${advice.cash.toFixed(0)}`);
  lines.push(`**科技集中度**: ${(advice.techConcentration*100).toFixed(0)}% (上限50%) | **最大单票**: ${(advice.maxSingleWeight*100).toFixed(0)}%`);
  lines.push('');
  lines.push('**配置 vs 目标:**');
  for (const k of Object.keys(advice.sectorWeights)) {
    const cur = (advice.sectorWeights[k]*100).toFixed(0);
    const tgt = ((advice.targetWeights[k]||0)*100).toFixed(0);
    lines.push(`> ${k}: ${cur}% → ${tgt}%`);
  }
  lines.push('');
  lines.push('**今日操作:**');
  let i = 1;
  for (const op of advice.operations) {
    const amt = op.amount ? ` ¥${op.amount}` : '';
    const tgt = op.target ? ` → ${op.target}` : '';
    const icon = op.action === 'SELL' ? '🔴' : (op.action === 'CONVERT') ? '🔄' : (op.action === 'BUY' || op.action === 'DCA') ? '🟢' : (op.action === 'PLAN') ? '📌' : '⚪';
    lines.push(`${i}. ${icon} **[${op.action}] ${op.name}**${amt}${tgt}`);
    lines.push(`> ${op.reason}`);
    i++;
  }
  // 动态选基说明: 让用户一眼看到"今天按实时行情挑了哪几只"
  if (advice.realtimePicks && advice.realtimePicks.length > 0) {
    lines.push('');
    lines.push('**📡 实时行情动态选基 (盘前读取, 挑当日最强):**');
    advice.realtimePicks.forEach((r, idx) => {
      const chg = r.changePct != null ? `实时${r.changePct >= 0 ? '+' : ''}${r.changePct}%` : '实时N/A';
      lines.push(`> ${idx + 1}. ${r.name}(${r.code}) ${r.sector} | ${chg} / 近5日${r.mom5 >= 0 ? '+' : ''}${r.mom5}% | 综合分${r.score}`);
    });
  }
  lines.push('');
  lines.push('⚠️ T+1: 15:00前下单按当日净值, 周末/节假日不交易');
  lines.push('📌 仅供参考, 投资有风险');
  return lines.join('\n');
}

function printAggressiveAdvice(advice) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  基金助手·激进科技增强版 V6 每日操作指令');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  日期: ${advice.date}`);
  if (advice.message) { console.log(`  状态: ${advice.message}\n`); return; }
  console.log(`  模式: ${advice.mode} | 科技趋势强度: ${(advice.techTrendRatio*100).toFixed(0)}%基金在20日均线上方`);
  if (advice.marketSentiment) {
    const ms = advice.marketSentiment;
    console.log(`  市场情绪: ${ms.labelCN} (恐慌贪婪指数 ${ms.score}/100) [${ms.tradingBias}]`);
    console.log(`  情绪建议: ${ms.advice}`);
  }
  console.log(`  总资产: ¥${advice.totalAsset.toFixed(2)} | 可用现金: ¥${advice.cash.toFixed(2)}`);
  console.log(`  科技集中度: ${(advice.techConcentration*100).toFixed(1)}% (激进上限75%) | 最大单票: ${(advice.maxSingleWeight*100).toFixed(1)}%`);
  console.log(`  数据源: ${advice.dataSource}`);
  const now = new Date();
  const dayNum = now.getDay();
  const isTodayTrading = dayNum >= 1 && dayNum <= 5;
  const passedDeadline = now.getHours() >= 15;
  const wkNames = ['周日','周一','周二','周三','周四','周五','周六'];
  const nextTradingDayStr = (d) => { const nd = new Date(d); do { nd.setDate(nd.getDate()+1); } while (nd.getDay()<1||nd.getDay()>5); return `${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,'0')}-${String(nd.getDate()).padStart(2,'0')} ${wkNames[nd.getDay()]}`; };
  let opHint;
  if (!isTodayTrading) opHint = `今日非交易日, 最早可操作日期: ${nextTradingDayStr(now)} 15:00前`;
  else if (passedDeadline) opHint = `今日已收盘(${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}), 最早可操作日期: ${nextTradingDayStr(now)} 15:00前`;
  else { const minsLeft=(15-now.getHours())*60-now.getMinutes(); opHint = `今日交易日进行中, 距15:00还有 ${minsLeft} 分钟, 尽快操作`; }
  console.log(`\n  T+1 / 周末规则:`);
  console.log(`    - 场外基金交易日 15:00 前下单, T+1 确认; 周末/节假日不交易`);
  console.log(`    - ${opHint}`);
  console.log('\n  今日操作清单:');
  if (!advice.operations.length) console.log('    无');
  else { let i=1; for (const op of advice.operations) {
    const amt = op.amount ? ` ¥${op.amount}` : '';
    const tgt = op.target ? ` → ${op.target}` : '';
    console.log(`    ${i}. [${op.action}] ${op.name}${amt}${tgt}`);
    console.log(`       原因: ${op.reason}`);
    console.log(`       紧急度: ${op.urgency||'LOW'}`);
    i++;
  }}
  console.log('═══════════════════════════════════════════════════\n');
}

function formatDingtalkAggressive(advice) {
  if (advice.message) return `## 📋 基金助手·激进科技版 V6\n\n> ${advice.date} ${advice.message}`;
  const lines = [];
  lines.push(`## 📋 基金操作指令 V6激进版 ${advice.date}`);
  lines.push('');
  lines.push(`**模式**: ${advice.mode} | 科技趋势: ${(advice.techTrendRatio*100).toFixed(0)}%在均线上方`);
  lines.push(`**总资产**: ¥${advice.totalAsset.toFixed(0)} | **现金**: ¥${advice.cash.toFixed(0)}`);
  lines.push(`**科技集中度**: ${(advice.techConcentration*100).toFixed(0)}% | **最大单票**: ${(advice.maxSingleWeight*100).toFixed(0)}%`);
  lines.push(`**数据**: ${advice.dataSource}`);
  lines.push('');
  lines.push('**今日操作:**');
  let i=1;
  for (const op of advice.operations) {
    const amt = op.amount ? ` ¥${op.amount}` : '';
    const tgt = op.target ? ` → ${op.target}` : '';
    const icon = op.action==='SELL'?'🔴':op.action==='CONVERT'?'🔄':(op.action==='BUY'||op.action==='DCA')?'🟢':'⚪';
    lines.push(`${i}. ${icon} **[${op.action}] ${op.name}**${amt}${tgt}`);
    lines.push(`> ${op.reason}`);
    i++;
  }
  lines.push('');
  lines.push('⚠️ T+1: 15:00前下单, 周末不交易 | 激进策略风险大, 严守止损');
  return lines.join('\n');
}

function initHoldings() {
  const holdings = loadHoldings();
  if (holdings.length === 0) {
    saveHoldings([]);
  }
}

initHoldings();
main();
