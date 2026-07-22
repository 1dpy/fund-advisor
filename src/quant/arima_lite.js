/**
 * ARIMA-lite (自回归积分滑动平均) — 纯JS实现
 *
 * 模型: ARIMA(p, d, q)
 *   p = 自回归阶数 (用过去p期的值预测)
 *   d = 差分阶数 (使序列平稳)
 *   q = 滑动平均阶数 (用过去q期的误差预测)
 *
 * 参考: Box-Jenkins方法, "Time Series Analysis" (Hamilton)
 *       量化交易中用于短期价格方向预测
 *
 * 实现: 使用Yule-Walker方程估计AR参数, 简化MA估计
 */

/**
 * 差分
 */
function difference(series, order = 1) {
  let result = [...series];
  for (let i = 0; i < order; i++) {
    const diff = [];
    for (let j = 1; j < result.length; j++) {
      diff.push(result[j] - result[j - 1]);
    }
    result = diff;
  }
  return result;
}

/**
 * 逆差分 (还原)
 */
function inverseDifference(diffed, originalLast, order = 1) {
  let result = [...diffed];
  for (let i = 0; i < order; i++) {
    const restored = [originalLast[order - 1 - i]];
    for (let j = 0; j < result.length; j++) {
      restored.push(restored[j] + result[j]);
    }
    result = restored.slice(1);
  }
  return result;
}

/**
 * 自相关函数 (ACF)
 */
function autocorrelation(series, maxLag = 20) {
  const n = series.length;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  const variance = series.reduce((a, b) => a + (b - mean) ** 2, 0) / n;

  const acf = [];
  for (let lag = 0; lag <= maxLag && lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) {
      sum += (series[i] - mean) * (series[i + lag] - mean);
    }
    acf.push(variance > 0 ? sum / (n * variance) : 0);
  }
  return acf;
}

/**
 * 偏自相关函数 (PACF) — 使用Yule-Walker
 */
function partialAutocorrelation(series, maxLag = 10) {
  const acf = autocorrelation(series, maxLag);
  const pacf = [1];

  for (let k = 1; k <= maxLag; k++) {
    // 构建Toeplitz矩阵
    const matrix = [];
    for (let i = 0; i < k; i++) {
      const row = [];
      for (let j = 0; j < k; j++) {
        const lag = Math.abs(i - j);
        row.push(acf[lag]);
      }
      matrix.push(row);
    }

    // 解Yule-Walker方程 (简化: 矩阵求逆)
    const vector = acf.slice(1, k + 1);
    const coeffs = solveLinearSystem(matrix, vector);

    pacf.push(k <= coeffs.length ? coeffs[k - 1] : 0);
  }

  return pacf;
}

/**
 * 简化高斯消元法解线性方程组
 */
function solveLinearSystem(A, b) {
  const n = A.length;
  const aug = A.map((row, i) => [...row, b[i]]);

  // 前向消元
  for (let i = 0; i < n; i++) {
    // 选主元
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(aug[k][i]) > Math.abs(aug[maxRow][i])) maxRow = k;
    }
    [aug[i], aug[maxRow]] = [aug[maxRow], aug[i]];

    if (Math.abs(aug[i][i]) < 1e-10) continue;

    for (let k = i + 1; k < n; k++) {
      const factor = aug[k][i] / aug[i][i];
      for (let j = i; j <= n; j++) {
        aug[k][j] -= factor * aug[i][j];
      }
    }
  }

  // 回代
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = aug[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= aug[i][j] * x[j];
    }
    x[i] = Math.abs(aug[i][i]) > 1e-10 ? sum / aug[i][i] : 0;
  }

  return x;
}

/**
 * AR(p) 模型拟合 (最小二乘法)
 */
function fitAR(series, p = 5) {
  const n = series.length;
  if (n < p + 10) return null;

  // 构建回归矩阵
  const X = [];
  const y = [];
  for (let i = p; i < n; i++) {
    const row = [];
    for (let j = 1; j <= p; j++) {
      row.push(series[i - j]);
    }
    X.push(row);
    y.push(series[i]);
  }

  // 正规方程: (X^T X) beta = X^T y
  const XtX = [];
  for (let i = 0; i < p; i++) {
    const row = [];
    for (let j = 0; j < p; j++) {
      let sum = 0;
      for (let k = 0; k < X.length; k++) {
        sum += X[k][i] * X[k][j];
      }
      sum /= X.length;
      row.push(sum);
    }
    XtX.push(row);
  }

  const Xty = [];
  for (let i = 0; i < p; i++) {
    let sum = 0;
    for (let k = 0; k < X.length; k++) {
      sum += X[k][i] * y[k];
    }
    sum /= X.length;
    Xty.push(sum);
  }

  // 加正则化 (岭回归)
  const lambda = 0.01;
  for (let i = 0; i < p; i++) XtX[i][i] += lambda;

  const coeffs = solveLinearSystem(XtX, Xty);

  // 计算残差
  const residuals = [];
  for (let k = 0; k < X.length; k++) {
    let pred = 0;
    for (let j = 0; j < p; j++) {
      pred += coeffs[j] * X[k][j];
    }
    residuals.push(y[k] - pred);
  }

  // 残差标准差
  const resMean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  const resStd = Math.sqrt(residuals.reduce((a, b) => a + (b - resMean) ** 2, 0) / residuals.length);

  return { coeffs, residuals, resStd, p };
}

/**
 * ARIMA预测
 */
function predictARIMA(history, p = 5, d = 1, forecastSteps = 5) {
  if (!history || history.length < 30) return null;

  const closes = history.map(h => h.nav || h.close);
  const lastPrice = closes[closes.length - 1];

  // 差分使平稳
  const diffed = difference(closes, d);

  // 拟合AR模型
  const arModel = fitAR(diffed, p);
  if (!arModel) return null;

  // 预测
  const forecasts = [];
  let lastValues = diffed.slice(-p);

  for (let step = 0; step < forecastSteps; step++) {
    let pred = 0;
    for (let j = 0; j < p; j++) {
      pred += arModel.coeffs[j] * lastValues[p - 1 - j];
    }
    forecasts.push(pred);
    // 滑动窗口
    lastValues = [...lastValues.slice(1), pred];
  }

  // 逆差分还原
  let predictedPrice = lastPrice;
  for (const f of forecasts) {
    predictedPrice += f;
  }

  const predictedReturn = lastPrice > 0 ? (predictedPrice - lastPrice) / lastPrice : 0;
  const direction = predictedReturn > 0.003 ? 'UP' : predictedReturn < -0.003 ? 'DOWN' : 'FLAT';

  // 模型质量评估
  const ic = informationCriterion(arModel.residuals, p, arModel.resStd);

  return {
    predictedReturn,
    predictedPrice,
    direction,
    confidence: Math.min(1, Math.abs(predictedReturn) * 12),
    residuals: arModel.resStd,
    aic: ic.aic,
    bic: ic.bic,
    sampleCount: closes.length,
  };
}

/**
 * AIC/BIC 信息准则
 */
function informationCriterion(residuals, numParams, resStd) {
  const n = residuals.length;
  const logLik = -n / 2 * Math.log(2 * Math.PI) - n / 2 * Math.log(resStd ** 2) - n / 2;
  return {
    aic: 2 * numParams - 2 * logLik,
    bic: numParams * Math.log(n) - 2 * logLik,
  };
}

/**
 * 自动选择最佳AR阶数 (基于AIC)
 */
function autoSelectAR(series, maxP = 10) {
  let bestP = 1;
  let bestAIC = Infinity;

  for (let p = 1; p <= Math.min(maxP, series.length / 4); p++) {
    const model = fitAR(series, p);
    if (!model) continue;
    const ic = informationCriterion(model.residuals, p, model.resStd);
    if (ic.aic < bestAIC) {
      bestAIC = ic.aic;
      bestP = p;
    }
  }

  return bestP;
}

module.exports = {
  predictARIMA,
  autoSelectAR,
  difference,
  autocorrelation,
  partialAutocorrelation,
  fitAR,
};
