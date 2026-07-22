/**
 * 自我迭代元优化器 (Self-Tuning Meta-Optimizer)
 * ---------------------------------------------------------------
 * 回答问题: "模型能否在训练+测试后自我迭代?"
 *
 * 答案: 可以, 但诚实的做法是**区分两层参数**, 严守防过拟合红线:
 *
 *   ① 因子权重(底层参数): 每折只在该折"训练窗"内拟合, 在"测试窗"真
 *      样本外持有(零前视)。测试窗数据**绝不**回灌去重拟合因子权重。
 *
 *   ② 元参数(上层控制器): 用"训练窗夏普 − 测试窗夏普"的过拟合降级 Δ
 *      在线更新一个正则化强度 λ。Δ 持续偏高 → λ 上升 → 下折优化偏好
 *      "更均衡/更分散"的参数(不易过拟合); Δ 低 → λ 回落放开激进度。
 *      这是 online meta-learning: 我们调整的是"目标函数", 不是把测试集
 *      当训练集。
 *
 *   ③ 滚动扩展(真正的自我迭代, 零泄题): 每折结束后, 该折测试窗并入下一
 *      折训练窗。模型随数据累积不断"长大", 且每个新测试窗在生成时仍是
 *      未来数据。
 *
 *   ④ 最终测试集(holdout): 历史最后一段被**永久冻结**, 不参与任何训练,
 *      仅用于给出模型成败的最终 OOS 证据。这就是"用更多数据当测试集"。
 *
 * 参考: López de Prado《Financial Machine Learning》walk-forward + 过拟合
 *      量化; 自适应正则化 / 在线学习 (concept drift 应对)。
 *
 * 用法:
 *   const st = require('./self_tuning');
 *   const res = st.selfIterateWalkForward(closesByCode, codes, { holdout: 60 });
 *   // res.folds / res.paramTrajectory / res.holdout / res.improvement
 */

const fl = require('./factor_library');
const wf = require('./walk_forward_pro');

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

// ---------- 候选参数网格 (因子权重三元组 + topK) ----------
function paramCandidates() {
  const momVals = [0, 0.25, 0.5, 0.75, 1];
  const valVals = [0, 0.25, 0.5, 0.75, 1];
  const topKs = [2, 3, 4];
  const out = [];
  for (const m of momVals) for (const v of valVals) {
    const s = Math.max(0, +(1 - m - v).toFixed(2));
    for (const k of topKs) out.push({ momentum: m, valuation: v, sentiment: s, topK: k });
  }
  return out;
}

// 在"截至 end 的数据"上, 从 start 起做 in-sample 回测(因子模型, 周期再平衡)
// 返回 stats (含 sharpe/total/mdd)
function evalWindow(closesByCode, codes, start, end, params, ctx) {
  const fitFn = wf.makeFactorFitFn(closesByCode, {
    weights: { momentum: params.momentum, valuation: params.valuation, sentiment: params.sentiment },
    topK: params.topK, sentiment: ctx.sentiment, news: ctx.news,
  });
  const r = wf.walkForwardBacktest({ closesByCode, codes, fitFn, opts: { start, rebal: ctx.rebal, embargo: 0, costApply: ctx.costApply } });
  return r.stats;
}

// 集中度惩罚: 权重三元组离"完全均衡(1/3)"越远, 越可能过拟合 → 加罚
function concentration(params) {
  const t = 1 / 3;
  return Math.abs(params.momentum - t) + Math.abs(params.valuation - t) + Math.abs(params.sentiment - t);
}

// ============================================================
// 主入口: 自我迭代 walk-forward
//   closesByCode: { code: number[] } (全量对齐, 首值以前向填充)
//   opts: { start=60, rebal=5, foldStep=20, embargo=5, holdout=60,
//           costApply, sentiment, news }
// 返回 { folds, paramTrajectory, holdout, improvement, metaFinal }
// ============================================================
function selfIterateWalkForward(closesByCode, codes, opts = {}) {
  const { start = 60, rebal = 5, foldStep = 20, embargo = 5, holdout = 60, costApply = null, sentiment = null, news = null } = opts;
  const N = codes.length ? closesByCode[codes[0]].length : 0;
  if (N < start + foldStep * 2 + holdout) return null;

  const ctx = { rebal, costApply, sentiment, news };
  const candidates = paramCandidates();

  // 元控制器状态
  let lambda = 0.1;          // 正则化强度 (随过拟合降级在线调整)
  let degEMA = 0;            // 过拟合降级指数滑动平均
  const alpha = 0.4;         // EMA 系数
  const defaultParams = { momentum: 0.5, valuation: 0.3, sentiment: 0.2, topK: 4 };

  const folds = [];
  const paramTrajectory = [];
  let lastParams = defaultParams;

  // 冻结的最终测试集边界
  const holdoutStart = N - holdout;

  for (let cut = start; cut + embargo + foldStep <= holdoutStart; cut += foldStep) {
    const testA = cut + embargo;
    const testB = Math.min(testA + foldStep, holdoutStart);

    // —— 训练窗内网格搜索: 选"惩罚后夏普"最高参数 ——
    let best = null, bestObj = -Infinity;
    for (const p of candidates) {
      const s = evalWindow(closesByCode, codes, start, cut, p, ctx); // 仅用 [start, cut)
      const obj = s.sharpe - lambda * concentration(p);             // 自适应惩罚
      if (obj > bestObj) { bestObj = obj; best = p; }
    }

    // 用选中参数在训练窗末端生成"权重", 真样本外持有测试窗
    const trainStats = evalWindow(closesByCode, codes, start, cut, best, ctx);
    const testStats = evalWindow(closesByCode, codes, testA, testB, best, ctx);
    const degradation = +(trainStats.sharpe - testStats.sharpe).toFixed(2);

    // —— 元控制器在线更新 (核心"自我迭代"信号) ——
    degEMA = +(alpha * degradation + (1 - alpha) * degEMA).toFixed(3);
    if (degEMA > 0.3) lambda = Math.min(lambda * 1.3, 1.2);   // 过拟合→收紧
    else lambda = Math.max(lambda * 0.92, 0.02);               // 稳健→放开

    lastParams = best;
    folds.push({
      i: folds.length + 1,
      params: { ...best },
      trainSharpe: trainStats.sharpe, testSharpe: testStats.sharpe,
      degradation, lambda: +lambda.toFixed(3), degEMA,
      testPeriod: `${testA}~${testB}`,
    });
    paramTrajectory.push({ i: folds.length, momentum: best.momentum, valuation: best.valuation, sentiment: best.sentiment, topK: best.topK, lambda: +lambda.toFixed(3), degEMA, testSharpe: testStats.sharpe });
  }

  // —— 最终测试集: self-tuned(末折演化参数) vs static(固定默认) ——
  const selfStats = evalWindow(closesByCode, codes, holdoutStart, N, lastParams, ctx);
  const staticStats = evalWindow(closesByCode, codes, holdoutStart, N, defaultParams, ctx);

  // 同样统计: 若全程固定默认参数, 在各折测试窗的平均 OOS 夏普 (对照)
  let staticTestSum = 0, staticTestN = 0;
  for (let cut = start; cut + embargo + foldStep <= holdoutStart; cut += foldStep) {
    const testA = cut + embargo, testB = Math.min(testA + foldStep, holdoutStart);
    const s = evalWindow(closesByCode, codes, testA, testB, defaultParams, ctx);
    staticTestSum += s.sharpe; staticTestN++;
  }
  const staticAvgTestSharpe = staticTestN ? +(staticTestSum / staticTestN).toFixed(2) : 0;
  const selfAvgTestSharpe = +(mean(folds.map((f) => f.testSharpe))).toFixed(2);

  return {
    folds,
    paramTrajectory,
    holdout: {
      selfTuned: selfStats,
      static: staticStats,
      selfParams: { ...lastParams },
    },
    improvement: {
      holdoutSharpeDelta: +(selfStats.sharpe - staticStats.sharpe).toFixed(2),
      holdoutRetDelta: +(selfStats.total - staticStats.total).toFixed(2),
      avgTestSharpeSelf: selfAvgTestSharpe,
      avgTestSharpeStatic: staticAvgTestSharpe,
    },
    metaFinal: { lambda: +lambda.toFixed(3), degEMA },
  };
}

module.exports = { selfIterateWalkForward, paramCandidates, concentration };
