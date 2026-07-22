/**
 * 卡尔曼滤波器 (Kalman Filter) — 价格状态估计
 *
 * 原理: 使用状态空间模型, 通过观测值递归估计真实价格趋势
 * 应用: 去噪/趋势估计/动态alpha/beta
 *
 * 参考: "Kalman Filter for Time Series Forecasting" (Harrison & West)
 *       量化交易中用于动态beta估计和配对交易
 */

class KalmanFilter1D {
  constructor(config = {}) {
    // 状态: [价格水平, 趋势(斜率)]
    this.x = config.initialState || [0, 0];  // 状态向量
    this.P = config.initialCov || [[1, 0], [0, 1]]; // 状态协方差
    this.Q = config.processNoise || [[0.001, 0], [0, 0.0001]]; // 过程噪声
    this.R = config.measurementNoise || 0.01; // 测量噪声
    this.H = [1, 0]; // 观测矩阵 (只观测价格)

    // 状态转移矩阵 (匀速模型)
    this.dt = 1;
    this.F = [[1, this.dt], [0, 1]];

    this.history = [];
    this.predictions = [];
    this.filteredStates = [];
  }

  /**
   * 预测步骤
   */
  predict() {
    // x = F * x
    const newX = [
      this.F[0][0] * this.x[0] + this.F[0][1] * this.x[1],
      this.F[1][0] * this.x[0] + this.F[1][1] * this.x[1]
    ];

    // P = F * P * F^T + Q
    const FP = [
      [this.F[0][0] * this.P[0][0] + this.F[0][1] * this.P[1][0],
       this.F[0][0] * this.P[0][1] + this.F[0][1] * this.P[1][1]],
      [this.F[1][0] * this.P[0][0] + this.F[1][1] * this.P[1][0],
       this.F[1][0] * this.P[0][1] + this.F[1][1] * this.P[1][1]]
    ];

    const FPT = [
      [FP[0][0] * this.F[0][0] + FP[0][1] * this.F[1][0],
       FP[0][0] * this.F[0][1] + FP[0][1] * this.F[1][1]],
      [FP[1][0] * this.F[0][0] + FP[1][1] * this.F[1][0],
       FP[1][0] * this.F[0][1] + FP[1][1] * this.F[1][1]]
    ];

    this.P = [
      [FPT[0][0] + this.Q[0][0], FPT[0][1] + this.Q[0][1]],
      [FPT[1][0] + this.Q[1][0], FPT[1][1] + this.Q[1][1]]
    ];

    this.x = newX;
    return newX;
  }

  /**
   * 更新步骤
   */
  update(measurement) {
    // 残差
    const y = measurement - (this.H[0] * this.x[0] + this.H[1] * this.x[1]);

    // 残差协方差
    const S = this.H[0] * (this.H[0] * this.P[0][0] + this.H[1] * this.P[1][0]) +
              this.H[1] * (this.H[0] * this.P[0][1] + this.H[1] * this.P[1][1]) + this.R;

    // 卡尔曼增益
    const K = [
      (this.H[0] * this.P[0][0] + this.H[1] * this.P[1][0]) / S,
      (this.H[0] * this.P[0][1] + this.H[1] * this.P[1][1]) / S
    ];

    // 状态更新
    this.x = [this.x[0] + K[0] * y, this.x[1] + K[1] * y];

    // 协方差更新
    const PHt = [
      this.P[0][0] * this.H[0] + this.P[0][1] * this.H[1],
      this.P[1][0] * this.H[0] + this.P[1][1] * this.H[1]
    ];

    this.P = [
      [this.P[0][0] - K[0] * PHt[0], this.P[0][1] - K[0] * PHt[1]],
      [this.P[1][0] - K[1] * PHt[0], this.P[1][1] - K[1] * PHt[1]]
    ];

    return this.x;
  }

  /**
   * 处理整个序列
   */
  filter(measurements) {
    const results = [];
    for (const m of measurements) {
      this.predict();
      const state = this.update(m);
      results.push({
        price: state[0],
        trend: state[1],
        residual: m - state[0],
      });
    }
    return results;
  }

  /**
   * 预测未来N步
   */
  forecast(steps = 5) {
    const forecasts = [];
    let x = [...this.x];
    let P = [this.P[0].slice(), this.P[1].slice()];

    for (let i = 0; i < steps; i++) {
      // x = F * x
      x = [
        this.F[0][0] * x[0] + this.F[0][1] * x[1],
        this.F[1][0] * x[0] + this.F[1][1] * x[1]
      ];
      forecasts.push(x[0]);
    }
    return forecasts;
  }
}

/**
 * 使用卡尔曼滤波预测基金
 */
function predictWithKalman(history, forecastDays = 5) {
  if (!history || history.length < 20) return null;

  const closes = history.map(h => h.nav || h.close);
  const lastPrice = closes[closes.length - 1];

  // 初始化: 状态=[最后价格, 0趋势]
  const kf = new KalmanFilter1D({
    initialState: [lastPrice, 0],
    initialCov: [[1, 0], [0, 1]],
    processNoise: [[0.0005, 0], [0, 0.00005]],
    measurementNoise: 0.002,
  });

  // 过滤
  const filtered = kf.filter(closes);
  const lastFiltered = filtered[filtered.length - 1];

  // 预测
  const forecast = kf.forecast(forecastDays);

  // 预测收益率
  const predictedPrice = forecast[forecast.length - 1];
  const predictedReturn = lastPrice > 0 ? (predictedPrice - lastPrice) / lastPrice : 0;

  // 趋势强度
  const trendStrength = lastFiltered.trend;
  const direction = predictedReturn > 0.003 ? 'UP' : predictedReturn < -0.003 ? 'DOWN' : 'FLAT';

  // 残差均值回复信号
  const recentResiduals = filtered.slice(-10).map(f => f.residual / lastPrice);
  const meanResidual = recentResiduals.reduce((a, b) => a + b, 0) / recentResiduals.length;
  const meanReversionSignal = -meanResidual; // 负残差 → 看涨

  return {
    predictedReturn,
    predictedPrice,
    direction,
    confidence: Math.min(1, Math.abs(predictedReturn) * 15 + Math.abs(trendStrength) * 10),
    trendStrength,
    meanReversion: meanReversionSignal,
    filteredPrice: lastFiltered.price,
    sampleCount: closes.length,
  };
}

module.exports = {
  KalmanFilter1D,
  predictWithKalman,
};
