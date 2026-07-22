/**
 * LSTM-Lite — 轻量级时序预测引擎
 *
 * 在纯JS中实现简化版LSTM（长短期记忆网络）:
 *   - 滑动窗口提取序列特征
 *   - 遗忘门/输入门/输出门简化为sigmoid门控
 *   - 前向传播 + BPTT反向传播训练
 *   - 预测未来N日涨跌方向和幅度
 *
 * 用途: 对基金净值序列做短中期趋势预测
 */

// ============================================================
//  数学工具
// ============================================================

function sigmoid(x) { return 1 / (1 + Math.exp(-Math.max(-50, Math.min(50, x)))); }
function tanh(x) { return Math.tanh(Math.max(-50, Math.min(50, x))); }
function dsigmoid(x) { const s = sigmoid(x); return s * (1 - s); }
function dtanh(x) { return 1 - tanh(x) * tanh(x); }

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr) { const m = mean(arr); return arr.length > 1 ? Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length) : 0; }

// 标准化: z-score
function normalize(data) {
  const m = mean(data);
  const s = std(data);
  const safeS = s > 1e-8 ? s : 1;
  return { data: data.map(v => (v - m) / safeS), mean: m, std: safeS };
}

// ============================================================
//  LSTM Cell (简化版)
// ============================================================

class LSTMLite {
  /**
   * @param {number} inputSize - 输入特征维度
   * @param {number} hiddenSize - 隐藏层维度
   * @param {number} outputSize - 输出维度
   * @param {number} lr - 学习率
   */
  constructor(inputSize, hiddenSize, outputSize, lr = 0.01) {
    this.inputSize = inputSize;
    this.hiddenSize = hiddenSize;
    this.outputSize = outputSize;
    this.lr = lr;

    // Xavier初始化
    const xavier = (fanIn, fanOut) => (Math.random() * 2 - 1) * Math.sqrt(6 / (fanIn + fanOut));

    // 遗忘门: Wf, Uf, bf
    this.Wf = this._initMatrix(hiddenSize, inputSize, xavier);
    this.Uf = this._initMatrix(hiddenSize, hiddenSize, xavier);
    this.bf = new Array(hiddenSize).fill(0);

    // 输入门: Wi, Ui, bi
    this.Wi = this._initMatrix(hiddenSize, inputSize, xavier);
    this.Ui = this._initMatrix(hiddenSize, hiddenSize, xavier);
    this.bi = new Array(hiddenSize).fill(0);

    // 候选状态: Wc, Uc, bc
    this.Wc = this._initMatrix(hiddenSize, inputSize, xavier);
    this.Uc = this._initMatrix(hiddenSize, hiddenSize, xavier);
    this.bc = new Array(hiddenSize).fill(0);

    // 输出门: Wo, Uo, bo
    this.Wo = this._initMatrix(hiddenSize, inputSize, xavier);
    this.Uo = this._initMatrix(hiddenSize, hiddenSize, xavier);
    this.bo = new Array(hiddenSize).fill(0);

    // 输出层: Wy, by
    this.Wy = this._initMatrix(outputSize, hiddenSize, xavier);
    this.by = new Array(outputSize).fill(0);
  }

  _initMatrix(rows, cols, initFn) {
    const m = [];
    for (let i = 0; i < rows; i++) {
      m.push(new Array(cols).fill(0).map(() => initFn(rows, cols)));
    }
    return m;
  }

  _matVec(W, x) {
    return W.map(row => row.reduce((s, w, j) => s + w * x[j], 0));
  }

  _addVec(a, b) { return a.map((v, i) => v + b[i]); }

  /**
   * 前向传播一个序列
   * @param {Array} sequence - [timesteps][inputSize]
   * @returns {Object} - { outputs, states } 用于反向传播
   */
  forward(sequence) {
    const T = sequence.length;
    const h = new Array(this.hiddenSize).fill(0);
    const c = new Array(this.hiddenSize).fill(0);
    const cache = [];

    for (let t = 0; t < T; t++) {
      const x = sequence[t];

      const fg = this._matVec(this.Wf, x);
      const fgPrev = this._matVec(this.Uf, h);
      const fGate = this._addVec(fg, fgPrev).map((v, i) => sigmoid(v + this.bf[i]));

      const ig = this._matVec(this.Wi, x);
      const igPrev = this._matVec(this.Ui, h);
      const iGate = this._addVec(ig, igPrev).map((v, i) => sigmoid(v + this.bi[i]));

      const cg = this._matVec(this.Wc, x);
      const cgPrev = this._matVec(this.Uc, h);
      const cTilde = this._addVec(cg, cgPrev).map((v, i) => tanh(v + this.bc[i]));

      const newC = c.map((cv, i) => fGate[i] * cv + iGate[i] * cTilde[i]);

      const og = this._matVec(this.Wo, x);
      const ogPrev = this._matVec(this.Uo, h);
      const oGate = this._addVec(og, ogPrev).map((v, i) => sigmoid(v + this.bo[i]));

      const newH = newC.map((cv, i) => oGate[i] * tanh(cv));

      cache.push({ x: [...x], h: [...h], c: [...c], fGate, iGate, cTilde, oGate, newC, newH });

      h.splice(0, h.length, ...newH);
      c.splice(0, c.length, ...newC);
    }

    // 最终输出
    const output = this._matVec(this.Wy, h).map((v, i) => v + this.by[i]);

    return { output, finalH: h, finalC: c, cache };
  }

  /**
   * 简化BPTT: 只更新输出层和最后几步的梯度
   * (完整BPTT计算量过大, 这里用截断BPTT近似)
   */
  backward(sequence, target, forwardCache) {
    const { output, cache, finalH } = forwardCache;
    const T = cache.length;

    // 输出层梯度
    const dOutput = output.map((v, i) => 2 * (v - target[i])); // MSE梯度

    // dWy, dby
    const dWy = this.Wy.map(row => row.map((_, j) => dOutput.reduce((s, d, i) => s + d * finalH[j], 0)));
    const dby = [...dOutput];

    // 截断BPTT: 只回传最后5步
    const truncSteps = Math.min(5, T);
    const dh = new Array(this.hiddenSize).fill(0);
    for (let i = 0; i < this.hiddenSize; i++) {
      for (let j = 0; j < this.outputSize; j++) {
        dh[i] += dOutput[j] * this.Wy[j][i];
      }
    }

    const dGrads = this._zeroGrads();

    for (let t = T - 1; t >= T - truncSteps; t--) {
      const step = cache[t];
      const dc = dh.map((dhv, i) => dhv * step.oGate[i] * dtanh(step.newC[i]));

      // 输出门梯度
      const doGate = dh.map((dhv, i) => dhv * tanh(step.newC[i]));
      const doPre = doGate.map((v, i) => v * dsigmoid(step.oGate[i]));
      for (let i = 0; i < this.hiddenSize; i++) {
        for (let j = 0; j < this.inputSize; j++) dGrads.Wo[i][j] += doPre[i] * step.x[j];
        for (let j = 0; j < this.hiddenSize; j++) dGrads.Uo[i][j] += doPre[i] * step.h[j];
        dGrads.bo[i] += doPre[i];
      }

      // 候选状态梯度
      const dcTilde = dc.map((v, i) => v * step.iGate[i]);
      const dcPre = dcTilde.map((v, i) => v * dtanh(step.cTilde[i]));
      for (let i = 0; i < this.hiddenSize; i++) {
        for (let j = 0; j < this.inputSize; j++) dGrads.Wc[i][j] += dcPre[i] * step.x[j];
        for (let j = 0; j < this.hiddenSize; j++) dGrads.Uc[i][j] += dcPre[i] * step.h[j];
        dGrads.bc[i] += dcPre[i];
      }

      // 输入门梯度
      const diGate = dc.map((v, i) => v * step.cTilde[i]);
      const diPre = diGate.map((v, i) => v * dsigmoid(step.iGate[i]));
      for (let i = 0; i < this.hiddenSize; i++) {
        for (let j = 0; j < this.inputSize; j++) dGrads.Wi[i][j] += diPre[i] * step.x[j];
        for (let j = 0; j < this.hiddenSize; j++) dGrads.Ui[i][j] += diPre[i] * step.h[j];
        dGrads.bi[i] += diPre[i];
      }

      // 遗忘门梯度
      const dfGate = dc.map((v, i) => v * step.c[i]);
      const dfPre = dfGate.map((v, i) => v * dsigmoid(step.fGate[i]));
      for (let i = 0; i < this.hiddenSize; i++) {
        for (let j = 0; j < this.inputSize; j++) dGrads.Wf[i][j] += dfPre[i] * step.x[j];
        for (let j = 0; j < this.hiddenSize; j++) dGrads.Uf[i][j] += dfPre[i] * step.h[j];
        dGrads.bf[i] += dfPre[i];
      }

      // 传递dh到前一步
      for (let i = 0; i < this.hiddenSize; i++) {
        let newDh = 0;
        for (let j = 0; j < this.hiddenSize; j++) {
          newDh += dfPre[j] * this.Uf[j][i] + diPre[j] * this.Ui[j][i] +
                   dcPre[j] * this.Uc[j][i] + doPre[j] * this.Uo[j][i];
        }
        dh[i] = newDh;
      }
    }

    // 参数更新 (梯度裁剪)
    const clipVal = 5;
    this._updateParams(dGrads, dWy, dby, clipVal);
  }

  _zeroGrads() {
    return {
      Wf: this._initMatrix(this.hiddenSize, this.inputSize, () => 0),
      Uf: this._initMatrix(this.hiddenSize, this.hiddenSize, () => 0),
      bf: new Array(this.hiddenSize).fill(0),
      Wi: this._initMatrix(this.hiddenSize, this.inputSize, () => 0),
      Ui: this._initMatrix(this.hiddenSize, this.hiddenSize, () => 0),
      bi: new Array(this.hiddenSize).fill(0),
      Wc: this._initMatrix(this.hiddenSize, this.inputSize, () => 0),
      Uc: this._initMatrix(this.hiddenSize, this.hiddenSize, () => 0),
      bc: new Array(this.hiddenSize).fill(0),
      Wo: this._initMatrix(this.hiddenSize, this.inputSize, () => 0),
      Uo: this._initMatrix(this.hiddenSize, this.hiddenSize, () => 0),
      bo: new Array(this.hiddenSize).fill(0),
    };
  }

  _updateParams(dGrads, dWy, dby, clipVal) {
    const clip = (v) => Math.max(-clipVal, Math.min(clipVal, v));
    const update = (W, dW) => {
      for (let i = 0; i < W.length; i++)
        for (let j = 0; j < W[i].length; j++)
          W[i][j] -= this.lr * clip(dW[i][j]);
    };
    update(this.Wf, dGrads.Wf); update(this.Uf, dGrads.Uf);
    for (let i = 0; i < this.bf.length; i++) this.bf[i] -= this.lr * clip(dGrads.bf[i]);
    update(this.Wi, dGrads.Wi); update(this.Ui, dGrads.Ui);
    for (let i = 0; i < this.bi.length; i++) this.bi[i] -= this.lr * clip(dGrads.bi[i]);
    update(this.Wc, dGrads.Wc); update(this.Uc, dGrads.Uc);
    for (let i = 0; i < this.bc.length; i++) this.bc[i] -= this.lr * clip(dGrads.bc[i]);
    update(this.Wo, dGrads.Wo); update(this.Uo, dGrads.Uo);
    for (let i = 0; i < this.bo.length; i++) this.bo[i] -= this.lr * clip(dGrads.bo[i]);
    update(this.Wy, dWy);
    for (let i = 0; i < this.by.length; i++) this.by[i] -= this.lr * clip(dby[i]);
  }
}

// ============================================================
//  特征工程: 从价格序列构建LSTM输入特征
// ============================================================

function buildFeatures(closes) {
  if (!closes || closes.length < 25) return null;

  const features = [];
  for (let i = 20; i < closes.length; i++) {
    const slice = closes.slice(i - 20, i + 1);

    // 特征1: 5日收益率
    const ret5 = (slice[slice.length - 1] - slice[slice.length - 5]) / slice[slice.length - 5];
    // 特征2: 10日收益率
    const ret10 = (slice[slice.length - 1] - slice[slice.length - 10]) / slice[slice.length - 10];
    // 特征3: 20日收益率
    const ret20 = (slice[slice.length - 1] - slice[0]) / slice[0];
    // 特征4: 5日波动率
    const dailyRets = [];
    for (let j = 1; j < slice.length; j++) dailyRets.push((slice[j] - slice[j-1]) / slice[j-1]);
    const vol5 = std(dailyRets.slice(-5));
    // 特征5: 上涨天数占比
    const upRatio = dailyRets.filter(r => r > 0).length / dailyRets.length;
    // 特征6: RSI近似
    const upAvg = mean(dailyRets.filter(r => r > 0)) || 0;
    const downAvg = Math.abs(mean(dailyRets.filter(r => r < 0)) || 0.001);
    const rsi = upAvg / (upAvg + downAvg);
    // 特征7: 价格偏离MA20
    const ma20 = mean(slice);
    const devMA20 = (slice[slice.length - 1] - ma20) / ma20;
    // 特征8: 动量加速度
    const mom5 = (slice[slice.length-1] / slice[slice.length-6] - 1);
    const mom10 = (slice[slice.length-1] / slice[slice.length-11] - 1);
    const accel = mom5 - mom10;

    features.push([ret5, ret10, ret20, vol5, upRatio, rsi, devMA20, accel]);
  }
  return features;
}

// ============================================================
//  训练和预测
// ============================================================

/**
 * 训练LSTM并预测
 * @param {Array} closes - 收盘价序列 (至少40个)
 * @param {number} predDays - 预测天数 (1-5)
 * @returns {Object} - { direction, magnitude, confidence, predictedReturns }
 */
function predictWithLSTM(closes, predDays = 3) {
  if (!closes || closes.length < 40) return null;

  const features = buildFeatures(closes);
  if (!features || features.length < 15) return null;

  // 标准化特征
  const nFeatures = features[0].length;
  const normFeatures = [];
  for (let j = 0; j < nFeatures; j++) {
    const col = features.map(f => f[j]);
    const norm = normalize(col);
    for (let i = 0; i < features.length; i++) {
      if (!normFeatures[i]) normFeatures[i] = [];
      normFeatures[i][j] = norm.data[i];
    }
  }

  // 构建训练样本: 窗口=10, 用窗口末尾的特征预测未来predDays天的收益率
  const windowSize = 10;
  const samples = [];
  const labels = [];

  for (let i = 0; i + windowSize + predDays <= normFeatures.length; i++) {
    const seq = normFeatures.slice(i, i + windowSize);
    // 标签: 未来predDays天的累计收益率
    const startIdx = i + windowSize;
    const endIdx = Math.min(startIdx + predDays, closes.length - 1);
    if (endIdx <= startIdx) continue;
    // 用实际价格计算标签
    const featStart = 20 + startIdx - 1; // 偏移因为features从index 20开始
    const featEnd = 20 + endIdx - 1;
    if (featEnd >= closes.length) continue;
    const futureReturn = (closes[featEnd] - closes[featStart]) / closes[featStart];
    // 标准化标签到 [-1, 1]
    const label = Math.max(-1, Math.min(1, futureReturn * 10));
    samples.push(seq);
    labels.push([label]);
  }

  if (samples.length < 8) return null;

  // 创建LSTM: inputSize=8, hiddenSize=16, outputSize=1
  const lstm = new LSTMLite(nFeatures, 16, 1, 0.005);

  // 训练
  const epochs = 30;
  const trainSize = Math.max(5, Math.floor(samples.length * 0.8));
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = 0; i < trainSize; i++) {
      const fwd = lstm.forward(samples[i]);
      lstm.backward(samples[i], labels[i], fwd);
    }
  }

  // 预测: 用最后windowSize个特征做预测
  const lastSeq = normFeatures.slice(-windowSize);
  const pred = lstm.forward(lastSeq);
  const rawPred = pred.output[0];

  // 反标准化: rawPred * 0.1 = 预测收益率
  const predictedReturn = rawPred / 10;

  // 方向和幅度
  const direction = predictedReturn > 0.005 ? 'UP' : predictedReturn < -0.005 ? 'DOWN' : 'FLAT';
  const magnitude = Math.abs(predictedReturn);

  // 置信度: 用训练集上的准确率估计
  let correct = 0;
  for (let i = 0; i < trainSize; i++) {
    const f = lstm.forward(samples[i]);
    const predDir = f.output[0] > 0 ? 1 : -1;
    const actualDir = labels[i][0] > 0 ? 1 : -1;
    if (predDir === actualDir) correct++;
  }
  const accuracy = correct / trainSize;
  const confidence = Math.round(Math.max(30, Math.min(95, accuracy * 100 + magnitude * 200)));

  // 预测未来每天的收益率 (简化: 均匀分配)
  const dailyReturns = [];
  for (let d = 0; d < predDays; d++) {
    dailyReturns.push(predictedReturn / predDays);
  }

  return {
    direction,
    predictedReturn: Math.round(predictedReturn * 10000) / 100, // 百分比
    magnitude: Math.round(magnitude * 10000) / 100,
    confidence,
    accuracy: Math.round(accuracy * 100),
    dailyReturns,
    model: 'LSTM-Lite',
  };
}

module.exports = { predictWithLSTM, buildFeatures, LSTMLite };
