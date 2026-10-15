/**
 * 种子化随机 — 让所有含随机初始化的模型可复现
 *
 * 为什么需要:
 *   LSTM 权重初始化 / HMM 的 k-means++ 初始中心与随机转移矩阵 / 随机森林 bootstrap 抽样 /
 *   GBDT 特征子抽样 / walk-forward 洗牌, 此前都直接调用 Math.random()。
 *   后果: 同一份行情数据连续跑两次 `node main.js` 可能给出不同的 BUY/SELL 建议,
 *         回测也无法复现 (参数优化结果每次都不一样)。
 *
 * 做法: 在每个"含随机性的公开入口"外层用 withSeed 临时替换 Math.random,
 *       退出时恢复, 不影响模块外任何代码。默认种子固定 → 结果可复现。
 *
 * 约定: 需要真随机(例如蒙特卡洛多次独立试验)时, 显式传入不同 seed,
 *       不要直接改回 Math.random()。
 */
const DEFAULT_SEED = 20240101;

/**
 * 线性同余伪随机 (Lehmer / MINSTD), 返回 [0,1)
 * @param {number} seed
 * @returns {() => number}
 */
function makeSeededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * 在 fn 执行期间把 Math.random 替换为种子化版本
 * @param {number} seed
 * @param {Function} fn - 同步函数 (随机发生在调用栈内即可)
 * @returns {*} fn 的返回值
 */
function withSeed(seed, fn) {
  const orig = Math.random;
  Math.random = makeSeededRandom(seed);
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

/**
 * 便捷封装: 用默认种子包裹一个函数 (同步)
 * @param {Function} fn
 * @param {number} [seed]
 */
function seeded(fn, seed = DEFAULT_SEED) {
  return withSeed(seed, fn);
}

module.exports = { makeSeededRandom, withSeed, seeded, DEFAULT_SEED };
