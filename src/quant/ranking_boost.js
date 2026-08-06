/**
 * RankingBoost — 成对排序学习（Pairwise Learning-to-Rank）
 * ---------------------------------------------------------------
 * 选基本质是排序问题：不直接预测“涨多少”，而是学习“同一时点里，
 * 基金 A 未来跑赢基金 B 的概率”。这里用成对逻辑回归（Bradley-Terry
 * 风格）在 walk-forward 样本上训练：
 *
 *   P(A 跑赢 B) = sigmoid(w·(x_A - x_B))
 *
 * 损失为成对二元交叉熵 + L2 正则，用确定性小批量 SGD 优化。
 * 相比普通回归，它对基金收益“截面排名”更敏感，也更贴合 Top-K 选基。
 *
 * 用法：
 *   const { trainRankingBoost, predictRanking } = require('./ranking_boost');
 *   const w = trainRankingBoost(features, labels, times, { epochs: 20 });
 *   const score = predictRanking(w, featureRow);
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sigmoid(x) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x)))); }

/**
 * 训练成对排序模型
 * @param {number[][]} X 已标准化的特征矩阵
 * @param {number[]} y 未来收益 z-score（越大越好）
 * @param {number[]} times 每个样本所属时点（只在同一时点内组队）
 * @param {Object} opts { epochs, lr, lambda, margin, maxPairsPerT, seed }
 * @returns {number[]} 权重（含截距）
 */
function trainRankingBoost(X, y, times, opts = {}) {
  const { epochs = 20, lr = 0.05, lambda = 0.01, margin = 0.05, maxPairsPerT = 40, seed = 20260806 } = opts;
  if (!X || !X.length) return null;
  const d = X[0].length;
  let w = new Array(d + 1).fill(0);
  const rng = mulberry32(seed);

  // 按 t 分组，保证 pair 只发生在同一截面
  const groups = new Map();
  for (let i = 0; i < X.length; i++) {
    const t = times[i];
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(i);
  }

  const buildPairs = () => {
    const pairs = [];
    for (const idxs of groups.values()) {
      if (idxs.length < 3) continue;
      const sorted = [...idxs].sort((a, b) => y[b] - y[a]);
      const winners = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.4)));
      const losers = sorted.slice(Math.max(1, Math.floor(sorted.length * 0.6)));
      const max = Math.min(maxPairsPerT, winners.length * losers.length);
      for (let k = 0; k < max; k++) {
        const wi = winners[Math.floor(rng() * winners.length)];
        const li = losers[Math.floor(rng() * losers.length)];
        if (y[wi] > y[li] + margin) pairs.push([wi, li]);
      }
    }
    return pairs;
  };

  const pairs = buildPairs();
  if (pairs.length < 10) return null;

  for (let ep = 0; ep < epochs; ep++) {
    // 每轮重新采样，增加多样性且保持确定性
    const batch = buildPairs();
    for (const [i, j] of batch) {
      const diff = X[i].map((v, k) => v - X[j][k]);
      const z = w[0] + diff.reduce((s, v, k) => s + w[k + 1] * v, 0);
      const p = sigmoid(z);
      const g = p - 1; // 目标为 1：i 跑赢 j
      const nw = new Array(w.length);
      nw[0] = w[0] - lr * (g + lambda * w[0]);
      for (let k = 1; k < nw.length; k++) nw[k] = w[k] - lr * (g * diff[k - 1] + lambda * w[k]);
      w = nw;
    }
  }
  return w;
}

function predictRanking(w, row) {
  if (!w || !row) return 0;
  let s = w[0] || 0;
  for (let i = 0; i < row.length; i++) s += (w[i + 1] || 0) * row[i];
  return s;
}

module.exports = { trainRankingBoost, predictRanking };
