/**
 * 隐马尔可夫模型 市场体制检测
 * 3个隐藏状态: 趋势上涨 / 震荡 / 恐慌下跌
 *
 * 简化版Baum-Welch + Viterbi解码
 * 输入: 近60天的(收益率, 波动率, 涨跌比)三元组
 * 输出: 当前最可能的状态 + 转移概率
 */

function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function std(arr) { const m = mean(arr); return arr.length > 1 ? Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length) : 0; }

/**
 * 从历史价格中提取观测序列
 */
function extractObservations(histories, windowSize = 40) {
  if (!histories || histories.length === 0) return [];

  // 用主要指数(上证/科创)或第一只基金
  const hist = Array.isArray(histories) ? histories : (histories['011609'] || Object.values(histories)[0] || []);
  if (!hist || hist.length < windowSize) return [];

  const obs = [];
  const closes = hist.map(h => h.close || h.nav || 0).filter(v => v > 0);

  for (let i = 5; i < closes.length; i++) {
    // 三个观测维度: 5日收益率, 5日波动率, 上涨天数占比
    const slice = closes.slice(Math.max(0, i - 5), i + 1);
    if (slice.length < 3) continue;
    const ret = (slice[slice.length - 1] - slice[0]) / slice[0];
    const dailyChanges = [];
    for (let j = 1; j < slice.length; j++) dailyChanges.push((slice[j] - slice[j-1]) / slice[j-1]);
    const vol = std(dailyChanges) * Math.sqrt(5);
    const upRatio = dailyChanges.filter(c => c > 0).length / dailyChanges.length;
    obs.push([ret, vol, upRatio]);
  }
  return obs.slice(-windowSize);
}

/**
 * 用观测数据训练HMM (简化EM)
 * 3状态: BULL(0), SIDEWAYS(1), BEAR(2)
 */
function trainHMM(observations, nStates = 3, iterations = 20) {
  if (observations.length < 20) return null;

  const n = observations.length;
  const d = observations[0].length;
  const obs = observations;

  // 初始化: 用K-means-like聚类
  // 按收益率排序分组
  const sorted = obs.map((o, i) => ({ o, i })).sort((a, b) => a.o[0] - b.o[0]);
  const chunk = Math.floor(n / nStates);
  const stateAssignments = new Array(n).fill(0);

  // 初始状态分配: 低收益=BEAR(2), 中=SIDEWAYS(1), 高=BULL(0)
  for (let i = 0; i < n; i++) {
    if (i < chunk) stateAssignments[sorted[i].i] = 2;
    else if (i >= n - chunk) stateAssignments[sorted[i].i] = 0;
    else stateAssignments[sorted[i].i] = 1;
  }

  // 初始参数
  let means = [];  // 每个状态的观测均值
  let covs = [];   // 每个状态的观测协方差(对角)
  let transMat = [];  // 转移矩阵
  let startProb = [1/nStates, 1/nStates, 1/nStates];

  // EM迭代
  for (let iter = 0; iter < iterations; iter++) {
    // M-step: 从当前分配计算参数
    means = [];
    covs = [];
    for (let s = 0; s < nStates; s++) {
      const stateObs = obs.filter((_, i) => stateAssignments[i] === s);
      if (stateObs.length === 0) {
        means.push(new Array(d).fill(0));
        covs.push(new Array(d).fill(1));
      } else {
        const m = new Array(d).fill(0);
        for (const o of stateObs) for (let j = 0; j < d; j++) m[j] += o[j] / stateObs.length;
        means.push(m);
        const c = new Array(d).fill(0);
        for (const o of stateObs) for (let j = 0; j < d; j++) c[j] += (o[j] - m[j]) ** 2 / Math.max(1, stateObs.length - 1);
        covs.push(c.map(v => Math.max(v, 1e-6)));
      }
    }

    // 转移矩阵
    transMat = [];
    for (let s = 0; s < nStates; s++) {
      transMat.push(new Array(nStates).fill(0.01));
      let count = 0;
      for (let i = 1; i < n; i++) {
        if (stateAssignments[i-1] === s) {
          transMat[s][stateAssignments[i]] += 1;
          count++;
        }
      }
      if (count > 0) for (let j = 0; j < nStates; j++) transMat[s][j] /= (count + 0.03);
      else transMat[s][s] = 0.96;
    }

    // E-step: 重新分配 (简化Viterbi)
    for (let i = 0; i < n; i++) {
      let bestState = stateAssignments[i];
      let bestScore = -Infinity;
      for (let s = 0; s < nStates; s++) {
        // 观测似然 + 转移概率
        let logLik = 0;
        for (let j = 0; j < d; j++) {
          const diff = obs[i][j] - means[s][j];
          logLik += -0.5 * (Math.log(2 * Math.PI * covs[s][j]) + diff * diff / covs[s][j]);
        }
        // 前一个状态的转移
        if (i > 0) logLik += Math.log(Math.max(0.001, transMat[stateAssignments[i-1]][s]));
        if (logLik > bestScore) { bestScore = logLik; bestState = s; }
      }
      stateAssignments[i] = bestState;
    }
  }

  // 当前状态: 最后一天
  const currentState = stateAssignments[n - 1];
  const stateNames = ['BULL', 'SIDEWAYS', 'BEAR'];

  // 状态特征
  const stateProfiles = {};
  for (let s = 0; s < nStates; s++) {
    const sObs = obs.filter((_, i) => stateAssignments[i] === s);
    if (sObs.length > 0) {
      stateProfiles[stateNames[s]] = {
        count: sObs.length,
        pct: Math.round(sObs.length / n * 100),
        avgReturn: Math.round(mean(sObs.map(o => o[0])) * 10000) / 100,
        avgVol: Math.round(mean(sObs.map(o => o[1])) * 10000) / 100,
      };
    }
  }

  // 转移概率 (从当前状态出发)
  const transFromCurrent = transMat[currentState] || [0.33, 0.34, 0.33];

  // 状态切换预警
  const maxTrans = Math.max(...transFromCurrent);
  const maxTransState = transFromCurrent.indexOf(maxTrans);
  let warning = null;
  if (maxTransState !== currentState && maxTrans > 0.4) {
    warning = `模型预测: ${stateNames[currentState]}→${stateNames[maxTransState]} 概率${(maxTrans*100).toFixed(0)}%`;
  }

  return {
    currentState: stateNames[currentState],
    currentStateIdx: currentState,
    confidence: Math.round(transFromCurrent[currentState] * 100),
    warning,
    nextStateProb: {
      BULL: Math.round(transFromCurrent[0] * 100),
      SIDEWAYS: Math.round(transFromCurrent[1] * 100),
      BEAR: Math.round(transFromCurrent[2] * 100),
    },
    stateProfiles,
    // 仓位建议
    positionAdvice: currentState === 0 ? '高仓位进攻' : currentState === 1 ? '中等仓位灵活' : '减仓防守',
  };
}

module.exports = { extractObservations, trainHMM };
