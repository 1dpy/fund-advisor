/**
 * 自我迭代验证 + 更长数据测试集 (P3) — CLI 入口
 * ---------------------------------------------------------------
 * 复用 src/quant_lab_core.js 计算, 仅负责"取数据→渲染 HTML 报告"。
 *
 * 用法: node backtest_self_iterate.js            (联网优先, 失败回退合成)
 *       node backtest_self_iterate.js --demo     (强制合成数据)
 */

const fs = require('fs');
const path = require('path');
const core = require('./src/quant_lab_core');
const { equityCurveSVG, drawdownSVG, efficientFrontierSVG, heatmapSVG, lineChartSVG } = require('./src/report_chart');

const args = process.argv.slice(2);
const FORCE_DEMO = args.includes('--demo');
const { START, REBAL, WINDOW, DAYS, HOLDOUT } = core.DEFAULTS;

(async () => {
  // 1. 数据准备 (联网优先, 合成兜底) — 经核心模块
  const prep = await core.prepData({ days: DAYS, holdout: HOLDOUT, forceDemo: FORCE_DEMO });
  const { dataMode, closesByCode, codes, commonDates, N } = prep;
  console.log(`数据模式=${dataMode} 区间 ${N} 日(更长/多regime), ${codes.length} 赛道, holdout=${HOLDOUT}, 计入成本\n`);

  // 2. 情绪因子 (可选; 仅 live 模式抓取, demo 用纯价格因子保证离线确定性)
  let sentiment = null, news = 0;
  if (!FORCE_DEMO) {
    try {
      const { analyzeMarketSentiment } = require('./src/sentiment_engine');
      const se = await Promise.race([analyzeMarketSentiment(), new Promise((r) => setTimeout(() => r(null), 6000))]);
      if (se && typeof se.score === 'number') sentiment = se.score;
    } catch (e) {}
    try {
      const { getNewsSentimentFactor } = require('./src/news_sentiment');
      const nf = await Promise.race([getNewsSentimentFactor(), new Promise((r) => setTimeout(() => r(null), 6000))]);
      if (nf && nf.available) news = nf.score;
    } catch (e) {}
    console.log(`  情绪因子: 市场恐慌贪婪=${sentiment != null ? sentiment : 'N/A'}  新闻舆情=${news.toFixed(2)}\n`);
  } else {
    console.log('  合成模式: 跳过实时情绪/新闻因子(纯价格因子, 离线确定性)\n');
  }

  // 3. 7 策略对比
  const { results } = core.runStrategies(closesByCode, codes, { start: START, rebal: REBAL, window: WINDOW, sentiment, news, commonDates });
  for (const key of Object.keys(results)) {
    const r = results[key];
    console.log(`${r.label.padEnd(20)} 收益${String(r.total + '%').padStart(7)} 夏普${String(r.sharpe).padStart(5)} 回撤${String(r.mdd + '%').padStart(8)} 调仓${String(r.trades).padStart(3)}`);
  }

  // 4. 自我迭代元优化
  console.log('\n⏳ 运行自我迭代元优化器 (每折拟参→OOS验证→在线调正则→滚动扩展) ...');
  const si = core.runSelfIterate(closesByCode, codes, { start: START, rebal: REBAL, foldStep: 20, embargo: 5, holdout: HOLDOUT, sentiment, news });
  if (!si) { console.log('  · 数据不足以自我迭代 (需更长历史)'); return; }
  console.log(`  · 折数=${si.folds.length}  最终λ=${si.metaFinal.lambda}  degEMA=${si.metaFinal.degEMA}`);
  console.log(`  · holdout: self-tuned 夏普${si.holdout.selfTuned.sharpe}/收益${si.holdout.selfTuned.total}%  vs 固定默认 夏普${si.holdout.static.sharpe}/收益${si.holdout.static.total}%`);
  console.log(`  · 改进: holdout夏普Δ=${si.improvement.holdoutSharpeDelta}  平均测试窗夏普 self=${si.improvement.avgTestSharpeSelf} vs static=${si.improvement.avgTestSharpeStatic}\n`);

  const selfCurve = si.holdoutCurves.self, statCurve = si.holdoutCurves.static;

  // 5. 可视化
  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const reportDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const eqSvgs = Object.keys(results).map((key) => {
    const r = results[key];
    return `<div style="margin:8px"><b>${r.label}</b>${equityCurveSVG(r.curve, { title: `${r.label} (收益${r.total}% 夏普${r.sharpe})` })}</div>`;
  }).join('');
  const tableRows = Object.keys(results).map((key) => {
    const r = results[key];
    return `<tr><td>${r.label}</td><td>${r.total}%</td><td>${r.sharpe}</td><td>${r.mdd}%</td><td>${r.trades}</td></tr>`;
  }).join('');
  const foldRows = si.folds.map((f) => `<tr><td>${f.i}</td><td>${f.testPeriod}</td><td>动${f.params.momentum}/估${f.params.valuation}/情${f.params.sentiment}/K${f.params.topK}</td><td>${f.trainSharpe}</td><td>${f.testSharpe}</td><td class="${f.degradation > 0.3 ? 'warn' : ''}">${f.degradation > 0 ? '+' + f.degradation : f.degradation}</td><td>${f.lambda}</td></tr>`).join('');

  const evoSvg = lineChartSVG([
    { label: '动量权重', color: '#2563eb', points: si.paramTrajectory.map((p) => p.momentum) },
    { label: '估值权重', color: '#16a34a', points: si.paramTrajectory.map((p) => p.valuation) },
    { label: '情绪权重', color: '#f59e0b', points: si.paramTrajectory.map((p) => p.sentiment) },
    { label: 'λ正则', color: '#dc2626', points: si.paramTrajectory.map((p) => p.lambda) },
  ], { title: '元参数随折叠演化 (自我迭代轨迹)' });
  const degSvg = lineChartSVG([
    { label: '过拟合降级Δ', color: '#dc2626', points: si.folds.map((f) => f.degradation) },
    { label: 'Δ滑动平均', color: '#7c3aed', points: si.folds.map((f) => f.degEMA) },
  ], { title: '过拟合降级 Δ = 训练窗夏普 − 样本外夏普', yMin: -2, yMax: 2 });

  const hoSvg = (() => {
    const norm = (c) => c.map((v) => v / c[0]);
    const selfN = norm(selfCurve), statN = norm(statCurve);
    return `<div style="display:flex;gap:12px;flex-wrap:wrap">` +
      `<div style="flex:1;min-width:320px"><b>self-tuned(末折演化参数)</b>${equityCurveSVG(selfN, { title: `holdout self-tuned (收益${si.holdout.selfTuned.total}%)` })}</div>` +
      `<div style="flex:1;min-width:320px"><b>固定默认(0.5/0.3/0.2,K4)</b>${equityCurveSVG(statN, { title: `holdout static (收益${si.holdout.static.total}%)` })}</div>` +
      `</div>`;
  })();

  const verdict = si.improvement.holdoutSharpeDelta > 0
    ? `<span class="best">自我迭代在最终测试集上优于固定默认(夏普Δ=${si.improvement.holdoutSharpeDelta}, 收益Δ=${si.improvement.holdoutRetDelta}%)，说明元控制器(在线正则化+滚动扩展)在未见数据上确实带来了泛化收益。</span>`
    : `<span class="warn">自我迭代在最终测试集上未优于固定默认(夏普Δ=${si.improvement.holdoutSharpeDelta})。这本身也是诚实结论: 在基金短期高噪净值上, 自适应调参的样本外增益有限; 等权分散仍是更稳的基线。元控制器的价值在于"限制过拟合"而非"显著增收益"。</span>`;

  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>自我迭代验证 ${reportDate}</title>
<style>body{font-family:system-ui,'Microsoft YaHei',sans-serif;max-width:960px;margin:24px auto;color:#1e293b}h1{font-size:22px}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #e2e8f0;padding:6px 8px;text-align:center;font-size:13px}th{background:#f1f5f9}.note{color:#64748b;font-size:12px;line-height:1.6}.best{background:#ecfdf5;color:#065f46;padding:2px 6px;border-radius:6px}.warn{color:#dc2626;background:#fef2f2;padding:2px 6px;border-radius:6px}.tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#ede9fe;color:#5b21b6}</style></head>
<body><h1>🧠 自我迭代验证报告 <span class="tag">${dataMode}</span></h1>
<p class="note">区间 ${commonDates[START]} ~ ${commonDates[N - 1]} ｜ 全样本 ${N} 日(更长/多regime) ｜ holdout 冻结 ${HOLDOUT} 日 ｜ ${codes.length} 赛道 ｜ 已计入成本 ｜ 自我迭代 = 在线元正则化 + 滚动扩展窗口(零泄题)</p>

<h2>① 更长数据 · 7 策略对比 (验证模型成败)</h2>
<table><tr><th>策略</th><th>总收益</th><th>夏普</th><th>最大回撤</th><th>调仓次数</th></tr>${tableRows}</table>
<p class="note">在更长/多regime数据上复跑, 检验此前"80日震荡市"结论是否稳健。若等权分散仍居前且回撤可控, 说明结论可泛化。</p>
${eqSvgs}

<h2>② 自我迭代折表 (训练拟参 → OOS验证 → 在线调λ)</h2>
<table><tr><th>折</th><th>测试区间</th><th>选中参数(动/估/情/K)</th><th>训练夏普</th><th>样本外夏普</th><th>降级Δ</th><th>λ</th></tr>${foldRows}</table>

<h2>③ 元参数演化轨迹 (模型如何"自我迭代")</h2>${evoSvg}
<h2>④ 过拟合降级 Δ 轨迹</h2>${degSvg}

<h2>⑤ 最终测试集(holdout) 自我迭代 vs 固定默认</h2>${hoSvg}
<p class="note">self-tuned 参数(末折演化): 动${si.holdout.selfParams.momentum}/估${si.holdout.selfParams.valuation}/情${si.holdout.selfParams.sentiment}/K${si.holdout.selfParams.topK}。holdout 夏普 self=${si.holdout.selfTuned.sharpe} vs static=${si.holdout.static.sharpe}; 平均测试窗夏普 self=${si.improvement.avgTestSharpeSelf} vs static=${si.improvement.avgTestSharpeStatic}。</p>

<h2>⑥ 结论</h2><p class="note">${verdict}</p>
<p class="note">方法论红线: 测试窗数据绝不回灌重拟合因子权重; λ 只由"训练−测试降级"在线调整(元学习), 不触碰测试集本身; holdout 全程冻结。本回测基于历史净值, 不构成投资建议。</p>
</body></html>`;
  const outFile = path.join(outDir, `self_iterate_${reportDate}.html`);
  fs.writeFileSync(outFile, html);
  console.log(`📁 HTML 报告已生成: ${outFile}  (数据模式: ${dataMode})`);
})();
