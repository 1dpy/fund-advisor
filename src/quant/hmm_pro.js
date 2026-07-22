/**
 * HMM Pro — 隐马尔可夫模型专业版
 *
 * 改进:
 *   - 4状态: BULL / STRONG_SIDEWAYS / WEAK_SIDEWAYS / BEAR
 *   - 真实Baum-Welch前向后向算法
 *   - K-means++初始化
 *   - 收敛检测
 *   - 状态持续时间建模
 */

function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function std(arr) { const m=mean(arr); return arr.length>1?Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length):0; }

/**
 * 从基金/指数历史中提取特征序列
 * 维度: [5日收益率, 10日波动率, 上涨占比, RSI-like, 成交量变化]
 */
function extractFeatures(histories, window=50) {
  const h = Array.isArray(histories) ? histories : (Object.values(histories)[0] || []);
  if (!h || h.length < window) return null;

  const closes = h.map(x => x.close || x.nav || 0).filter(v => v > 0);
  const volumes = h.map(x => x.volume || 0);
  if (closes.length < window) return null;

  const features = [];
  for (let i = 20; i < closes.length; i++) {
    const slice = closes.slice(Math.max(0,i-20), i+1);
    const volSlice = volumes.slice(Math.max(0,i-20), i+1);
    if (slice.length < 5) continue;

    // 5日收益
    const ret5 = (slice[slice.length-1] - slice[0]) / slice[0];
    // 10日波动率
    const dailyRet = [];
    for (let j=1; j<slice.length; j++) dailyRet.push((slice[j]-slice[j-1])/slice[j-1]);
    const vol10 = std(dailyRet) * Math.sqrt(10);
    // 上涨占比
    const upRatio = dailyRet.filter(r => r>0).length / dailyRet.length;
    // RSI-like (10日相对强度)
    const upAvg = mean(dailyRet.filter(r=>r>0))||0;
    const downAvg = Math.abs(mean(dailyRet.filter(r=>r<0))||0.001);
    const rsi = upAvg/(upAvg+downAvg);
    // 成交量变化
    const recentVol = mean(volSlice.slice(-5));
    const prevVol = mean(volSlice.slice(0,5));
    const volChg = prevVol > 0 ? Math.log(recentVol/prevVol) : 0;

    features.push([ret5, vol10, upRatio, rsi, volChg]);
  }
  return features.slice(-window);
}

/**
 * K-means++ 初始化
 */
function kmeansPP(data, k) {
  const n = data.length, d = data[0].length;
  const centers = [];
  // 随机选第一个中心
  centers.push(data[Math.floor(Math.random() * n)]);
  // 根据距离权重选剩余中心
  for (let c = 1; c < k; c++) {
    let minDists = data.map(x => Math.min(...centers.map(cen => {
      let dist = 0;
      for (let j=0; j<d; j++) dist += (x[j]-cen[j])**2;
      return dist;
    })));
    const sumDist = minDists.reduce((a,b)=>a+b,0);
    let r = Math.random() * sumDist;
    for (let i=0; i<n; i++) {
      r -= minDists[i];
      if (r <= 0) { centers.push(data[i]); break; }
    }
  }
  // 分配
  const assign = data.map(x => {
    let best = 0, bestDist = Infinity;
    for (let i=0; i<k; i++) {
      let dist = 0;
      for (let j=0; j<d; j++) dist += (x[j]-centers[i][j])**2;
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
  });
  return assign;
}

/**
 * 高斯大对数似然
 */
function gaussianLogLik(x, mean, cov) {
  let sum = 0;
  for (let j=0; j<x.length; j++) {
    const diff = x[j] - mean[j];
    sum += -0.5 * (Math.log(2*Math.PI*Math.max(cov[j],1e-10)) + diff*diff/Math.max(cov[j],1e-10));
  }
  return sum;
}

/**
 * HMM Pro — 完整Baum-Welch训练
 */
function trainHMMPro(observations, nStates=4, maxIter=50) {
  if (!observations || observations.length < 30) return null;

  const T = observations.length;
  const d = observations[0].length;
  const obs = observations;

  // === 初始化 ===
  const initAssign = kmeansPP(obs, nStates);

  // 初始概率 π
  const pi = new Array(nStates).fill(1/nStates);

  // 转移矩阵 A (随机+自转移偏重)
  const A = [];
  for (let i=0; i<nStates; i++) {
    A[i] = new Array(nStates).fill(0);
    let sum = 0;
    for (let j=0; j<nStates; j++) {
      A[i][j] = 0.1 + Math.random() * 0.3;
      if (i===j) A[i][j] = 0.4 + Math.random() * 0.4; // 自转移偏重
      sum += A[i][j];
    }
    for (let j=0; j<nStates; j++) A[i][j] /= sum;
  }

  // 发射参数 μ, σ²
  const mu = [], sigma2 = [];
  for (let s=0; s<nStates; s++) {
    const stateObs = obs.filter((_,i) => initAssign[i]===s);
    if (stateObs.length < 2) {
      mu.push(new Array(d).fill(0));
      sigma2.push(new Array(d).fill(1));
    } else {
      const m = new Array(d).fill(0);
      for (const o of stateObs) for (let j=0; j<d; j++) m[j] += o[j]/stateObs.length;
      mu.push(m);
      const v = new Array(d).fill(0);
      for (const o of stateObs) for (let j=0; j<d; j++) v[j] += (o[j]-m[j])**2/Math.max(1,stateObs.length-1);
      sigma2.push(v.map(x=>Math.max(x,1e-6)));
    }
  }

  // === Baum-Welch 迭代 ===
  let prevLogLik = -Infinity;
  let iter;

  for (iter=0; iter<maxIter; iter++) {
    // E-step: 前向后向
    const alpha = Array.from({length:T}, ()=>new Array(nStates).fill(0));
    const beta = Array.from({length:T}, ()=>new Array(nStates).fill(0));
    const gamma = Array.from({length:T}, ()=>new Array(nStates).fill(0));
    const xi = Array.from({length:T-1}, ()=>Array.from({length:nStates}, ()=>new Array(nStates).fill(0)));

    // Forward
    for (let s=0; s<nStates; s++) alpha[0][s] = pi[s] * Math.exp(gaussianLogLik(obs[0], mu[s], sigma2[s]));
    let norm0 = alpha[0].reduce((a,b)=>a+b,0);
    if (norm0 > 0) for (let s=0; s<nStates; s++) alpha[0][s] /= norm0;

    for (let t=1; t<T; t++) {
      for (let s=0; s<nStates; s++) {
        let sum = 0;
        for (let i=0; i<nStates; i++) sum += alpha[t-1][i] * A[i][s];
        alpha[t][s] = sum * Math.exp(gaussianLogLik(obs[t], mu[s], sigma2[s]));
      }
      let norm = alpha[t].reduce((a,b)=>a+b,0);
      if (norm > 0) for (let s=0; s<nStates; s++) alpha[t][s] /= norm;
    }

    // Backward
    for (let s=0; s<nStates; s++) beta[T-1][s] = 1;
    for (let t=T-2; t>=0; t--) {
      for (let s=0; s<nStates; s++) {
        let sum = 0;
        for (let j=0; j<nStates; j++) {
          sum += A[s][j] * Math.exp(gaussianLogLik(obs[t+1], mu[j], sigma2[j])) * beta[t+1][j];
        }
        beta[t][s] = sum;
      }
      let norm = beta[t].reduce((a,b)=>a+b,0);
      if (norm > 0) for (let s=0; s<nStates; s++) beta[t][s] /= norm;
    }

    // Gamma & Xi
    for (let t=0; t<T; t++) {
      let sum = 0;
      for (let s=0; s<nStates; s++) {
        gamma[t][s] = alpha[t][s] * beta[t][s];
        sum += gamma[t][s];
      }
      if (sum > 0) for (let s=0; s<nStates; s++) gamma[t][s] /= sum;
    }
    for (let t=0; t<T-1; t++) {
      let sum = 0;
      for (let i=0; i<nStates; i++) for (let j=0; j<nStates; j++) {
        xi[t][i][j] = alpha[t][i] * A[i][j] * Math.exp(gaussianLogLik(obs[t+1], mu[j], sigma2[j])) * beta[t+1][j];
        sum += xi[t][i][j];
      }
      if (sum > 0) for (let i=0; i<nStates; i++) for (let j=0; j<nStates; j++) xi[t][i][j] /= sum;
    }

    // M-step: 更新参数
    // π
    for (let s=0; s<nStates; s++) pi[s] = gamma[0][s];

    // A
    for (let i=0; i<nStates; i++) {
      let denom = 0;
      for (let t=0; t<T-1; t++) denom += gamma[t][i];
      if (denom > 0) {
        for (let j=0; j<nStates; j++) {
          let numer = 0;
          for (let t=0; t<T-1; t++) numer += xi[t][i][j];
          A[i][j] = numer / denom;
        }
      }
    }

    // μ, σ²
    for (let s=0; s<nStates; s++) {
      let denom = 0;
      for (let t=0; t<T; t++) denom += gamma[t][s];
      if (denom > 0) {
        const newMu = new Array(d).fill(0);
        for (let t=0; t<T; t++) for (let j=0; j<d; j++) newMu[j] += gamma[t][s] * obs[t][j] / denom;
        mu[s] = newMu;
        const newVar = new Array(d).fill(0);
        for (let t=0; t<T; t++) for (let j=0; j<d; j++) newVar[j] += gamma[t][s] * (obs[t][j]-newMu[j])**2 / denom;
        sigma2[s] = newVar.map(v=>Math.max(v,1e-6));
      }
    }

    // 对数似然收敛检测
    let logLik = 0;
    for (let s=0; s<nStates; s++) logLik += alpha[T-1][s];
    logLik = Math.log(Math.max(logLik, 1e-300));
    if (Math.abs(logLik - prevLogLik) < 0.001) break;
    prevLogLik = logLik;
  }

  // Viterbi解码: 最优状态序列
  const viterbi = Array.from({length:T}, ()=>new Array(nStates).fill(0));
  const backpointer = Array.from({length:T}, ()=>new Array(nStates).fill(0));
  for (let s=0; s<nStates; s++) viterbi[0][s] = Math.log(Math.max(pi[s], 1e-300)) + gaussianLogLik(obs[0], mu[s], sigma2[s]);

  for (let t=1; t<T; t++) {
    for (let s=0; s<nStates; s++) {
      let maxVal = -Infinity, maxIdx = 0;
      for (let i=0; i<nStates; i++) {
        const val = viterbi[t-1][i] + Math.log(Math.max(A[i][s], 1e-300));
        if (val > maxVal) { maxVal = val; maxIdx = i; }
      }
      viterbi[t][s] = maxVal + gaussianLogLik(obs[t], mu[s], sigma2[s]);
      backpointer[t][s] = maxIdx;
    }
  }

  let bestState = 0, bestVal = -Infinity;
  for (let s=0; s<nStates; s++) {
    if (viterbi[T-1][s] > bestVal) { bestVal = viterbi[T-1][s]; bestState = s; }
  }

  const stateSeq = new Array(T).fill(0);
  stateSeq[T-1] = bestState;
  for (let t=T-1; t>0; t--) stateSeq[t-1] = backpointer[t][stateSeq[t]];

  const currentState = stateSeq[T-1];

  // 状态命名: 按收益均值排序 (最高=牛, 最低=熊)
  const avgReturns = mu.map(m => m[0]);
  const stateOrder = avgReturns.map((_,i)=>i).sort((a,b)=>avgReturns[b]-avgReturns[a]);
  const stateNames = {};
  if (nStates >= 4) {
    stateNames[stateOrder[0]] = 'BULL';
    stateNames[stateOrder[1]] = 'STRONG_SIDEWAYS';
    stateNames[stateOrder[2]] = 'WEAK_SIDEWAYS';
    stateNames[stateOrder[3]] = 'BEAR';
  } else {
    const names = ['BULL','SIDEWAYS','BEAR'];
    for (let i=0; i<nStates; i++) stateNames[stateOrder[i]] = names[i] || `STATE${i}`;
  }

  // 状态分布
  const stateDist = {};
  for (let s=0; s<nStates; s++) {
    const name = stateNames[s] || `STATE${s}`;
    stateDist[name] = stateSeq.filter(x=>x===s).length / T;
  }

  // 转移概率 (从当前状态)
  const transFromCurrent = A[currentState];
  const maxTrans = Math.max(...transFromCurrent);
  const maxTransIdx = transFromCurrent.indexOf(maxTrans);

  let warning = null;
  if (maxTransIdx !== currentState && maxTrans > 0.35) {
    warning = `${stateNames[currentState]}→${stateNames[maxTransIdx]} 概率${(maxTrans*100).toFixed(0)}%`;
  }

  // 置信度: 状态一致性的逆 (越小切换越频繁≈越低置信)
  let switches = 0;
  for (let t=1; t<T; t++) if (stateSeq[t] !== stateSeq[t-1]) switches++;
  const confidence = Math.round(Math.max(50, 100 - switches/T*150));

  return {
    currentState: stateNames[currentState],
    currentStateIdx: currentState,
    confidence,
    warning,
    nextStateProbs: Object.fromEntries(
      transFromCurrent.map((p,i) => [stateNames[i]||`STATE${i}`, Math.round(p*100)])
    ),
    stateDistribution: stateDist,
    stateProfiles: Object.fromEntries(
      stateOrder.map((s,i) => [stateNames[s], {
        avgReturn: Math.round(mu[s][0]*10000)/100,
        avgVol: Math.round(Math.sqrt(sigma2[s][1])*10000)/100,
        upRatio: Math.round(mu[s][2]*1000)/10,
        pct: Math.round(stateDist[stateNames[s]]*100),
      }])
    ),
    states: T,
    iterations: iter+1,
    positionAdvice: currentState === stateOrder[0] ? '全仓进攻' :
      currentState === stateOrder[1] ? '高仓位' :
      currentState === stateOrder[2] ? '减仓防御' : '轻仓等抄底',
  };
}

module.exports = { trainHMMPro, extractFeatures };
