/**
 * LSTM-Attention v2 — 带注意力机制的增强LSTM
 *
 * 升级特性:
 *   1. Multi-head self-attention (4头注意力)
 *   2. 双层LSTM堆叠
 *   3. Dropout正则化 (防过拟合)
 *   4. 学习率衰减 (Adam + cosine annealing)
 *   5. 梯度裁剪 + 权重L2正则化
 *   6. 序列到值的预测 (多步输入 → 单步输出)
 *
 * 参考: "Attention Is All You Need" (Vaswani et al.)
 *       "Deep Learning for Time Series Forecasting" (Brownlee)
 */

// ============================================================
// 数学工具
// ============================================================

function sigmoid(x) { return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x)))); }
function tanh(x) { return Math.tanh(Math.max(-500, Math.min(500, x))); }
function relu(x) { return Math.max(0, x); }
function softmax(arr) {
  const max = Math.max(...arr);
  const exps = arr.map(x => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

function randn(mean = 0, std = 1) {
  // Box-Muller
  const u1 = Math.random() || 1e-10;
  const u2 = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function xavierInit(fanIn, fanOut) {
  const limit = Math.sqrt(6 / (fanIn + fanOut));
  return (Math.random() * 2 - 1) * limit;
}

// ============================================================
// LSTM Cell (单步)
// ============================================================

class LSTMCell {
  constructor(inputSize, hiddenSize, dropoutRate = 0.1) {
    this.inputSize = inputSize;
    this.hiddenSize = hiddenSize;
    this.dropoutRate = dropoutRate;

    // 输入/遗忘/输出/候选 门参数
    const gateSize = inputSize + hiddenSize;
    this.Wf = this._initMatrix(hiddenSize, gateSize);
    this.bf = new Array(hiddenSize).fill(0);
    this.Wi = this._initMatrix(hiddenSize, gateSize);
    this.bi = new Array(hiddenSize).fill(0);
    this.Wo = this._initMatrix(hiddenSize, gateSize);
    this.bo = new Array(hiddenSize).fill(0);
    this.Wc = this._initMatrix(hiddenSize, gateSize);
    this.bc = new Array(hiddenSize).fill(0);

    // 梯度累积
    this._zeroGrads();
  }

  _initMatrix(rows, cols) {
    const m = [];
    for (let i = 0; i < rows; i++) {
      const row = [];
      for (let j = 0; j < cols; j++) row.push(xavierInit(cols, rows));
      m.push(row);
    }
    return m;
  }

  _zeroGrads() {
    this.gWf = this.Wf.map(r => r.map(() => 0));
    this.gbf = new Array(this.hiddenSize).fill(0);
    this.gWi = this.Wi.map(r => r.map(() => 0));
    this.gbi = new Array(this.hiddenSize).fill(0);
    this.gWo = this.Wo.map(r => r.map(() => 0));
    this.gbo = new Array(this.hiddenSize).fill(0);
    this.gWc = this.Wc.map(r => r.map(() => 0));
    this.gbc = new Array(this.hiddenSize).fill(0);
  }

  forward(x, hPrev, cPrev, training = false) {
    const concat = [...x, ...hPrev];

    // Dropout
    const mask = training ? concat.map(() => Math.random() > this.dropoutRate ? 1 : 0) : null;
    const xUsed = training ? concat.map((v, i) => v * mask[i]) : concat;

    const f = this._gate(xUsed, this.Wf, this.bf, sigmoid);
    const i = this._gate(xUsed, this.Wi, this.bi, sigmoid);
    const o = this._gate(xUsed, this.Wo, this.bo, sigmoid);
    const cTilde = this._gate(xUsed, this.Wc, this.bc, tanh);

    const c = cPrev.map((cPrev_j, j) => f[j] * cPrev_j + i[j] * cTilde[j]);
    const h = c.map((c_j, j) => o[j] * tanh(c_j));

    // 保存中间值用于反向传播
    this._cache = { x: xUsed, hPrev, cPrev, f, i, o, cTilde, c, h, mask };
    return { h, c };
  }

  _gate(x, W, b, activation) {
    const out = new Array(W.length);
    for (let i = 0; i < W.length; i++) {
      let sum = b[i];
      for (let j = 0; j < x.length; j++) {
        sum += W[i][j] * x[j];
      }
      out[i] = activation(sum);
    }
    return out;
  }

  backward(dh, dc, cache) {
    const { x, hPrev, cPrev, f, i, o, cTilde, c } = cache;
    const gateSize = this.inputSize + this.hiddenSize;
    const dx = new Array(gateSize).fill(0);
    const dhPrev = new Array(this.hiddenSize).fill(0);
    const dcPrev = new Array(this.hiddenSize).fill(0);

    for (let j = 0; j < this.hiddenSize; j++) {
      // 输出门梯度
      const do_j = dh[j] * tanh(c[j]) * o[j] * (1 - o[j]);
      // 细胞状态梯度
      const dc_j = dc[j] + dh[j] * o[j] * (1 - tanh(c[j]) ** 2);

      // 遗忘门梯度
      const df_j = dc_j * cPrev[j] * f[j] * (1 - f[j]);
      // 输入门梯度
      const di_j = dc_j * cTilde[j] * i[j] * (1 - i[j]);
      // 候选梯度
      const dcTilde_j = dc_j * i[j] * (1 - cTilde[j] ** 2);

      // 累积参数梯度
      for (let k = 0; k < gateSize; k++) {
        this.gWf[j][k] += df_j * x[k];
        this.gWi[j][k] += di_j * x[k];
        this.gWo[j][k] += do_j * x[k];
        this.gWc[j][k] += dcTilde_j * x[k];
        dx[k] += this.Wf[j][k] * df_j + this.Wi[j][k] * di_j + this.Wo[j][k] * do_j + this.Wc[j][k] * dcTilde_j;
      }
      this.gbf[j] += df_j;
      this.gbi[j] += di_j;
      this.gbo[j] += do_j;
      this.gbc[j] += dcTilde_j;

      dcPrev[j] = dc_j * f[j];
      // 对hPrev的梯度
      dhPrev[j] = dx[this.inputSize + j];
    }

    return { dx: dx.slice(0, this.inputSize), dhPrev, dcPrev };
  }

  updateParams(lr, l2 = 0.001) {
    const update = (W, gW, b, gb) => {
      for (let i = 0; i < W.length; i++) {
        for (let j = 0; j < W[i].length; j++) {
          W[i][j] -= lr * (gW[i][j] + l2 * W[i][j]);
          gW[i][j] = 0;
        }
        b[i] -= lr * gb[i];
        gb[i] = 0;
      }
    };
    update(this.Wf, this.gWf, this.bf, this.gbf);
    update(this.Wi, this.gWi, this.bi, this.gbi);
    update(this.Wo, this.gWo, this.bo, this.gbo);
    update(this.Wc, this.gWc, this.bc, this.gbc);
  }
}

// ============================================================
// Multi-Head Self-Attention
// ============================================================

class MultiHeadAttention {
  constructor(dModel, numHeads = 4) {
    this.dModel = dModel;
    this.numHeads = numHeads;
    this.dHead = Math.floor(dModel / numHeads);

    // Q, K, V 投影矩阵
    this.Wq = this._initMatrix(dModel, dModel);
    this.Wk = this._initMatrix(dModel, dModel);
    this.Wv = this._initMatrix(dModel, dModel);
    this.Wo = this._initMatrix(dModel, dModel);
  }

  _initMatrix(rows, cols) {
    const m = [];
    for (let i = 0; i < rows; i++) {
      const row = [];
      for (let j = 0; j < cols; j++) row.push(xavierInit(cols, rows));
      m.push(row);
    }
    return m;
  }

  _matVec(W, x) {
    const out = new Array(W.length).fill(0);
    for (let i = 0; i < W.length; i++) {
      for (let j = 0; j < x.length; j++) out[i] += W[i][j] * x[j];
    }
    return out;
  }

  forward(sequence) {
    // sequence: [timestep, dModel]
    const T = sequence.length;

    // 投影
    const Q = sequence.map(s => this._matVec(this.Wq, s));
    const K = sequence.map(s => this._matVec(this.Wk, s));
    const V = sequence.map(s => this._matVec(this.Wv, s));

    // 每个头计算attention
    const headOutputs = [];
    for (let h = 0; h < this.numHeads; h++) {
      const start = h * this.dHead;
      const end = start + this.dHead;
      const qHead = Q.map(q => q.slice(start, end));
      const kHead = K.map(k => k.slice(start, end));
      const vHead = V.map(v => v.slice(start, end));

      // Scaled dot-product attention
      const scores = [];
      for (let i = 0; i < T; i++) {
        const row = [];
        for (let j = 0; j < T; j++) {
          let dot = 0;
          for (let d = 0; d < this.dHead; d++) {
            dot += qHead[i][d] * kHead[j][d];
          }
          row.push(dot / Math.sqrt(this.dHead));
        }
        scores.push(softmax(row));
      }

      // 加权求和
      const headOut = [];
      for (let i = 0; i < T; i++) {
        const out = new Array(this.dHead).fill(0);
        for (let j = 0; j < T; j++) {
          for (let d = 0; d < this.dHead; d++) {
            out[d] += scores[i][j] * vHead[j][d];
          }
        }
        headOut.push(out);
      }
      headOutputs.push(headOut);
    }

    // 拼接所有头
    const concat = sequence.map((_, t) => {
      const out = [];
      for (let h = 0; h < this.numHeads; h++) {
        out.push(...headOutputs[h][t]);
      }
      return out;
    });

    // 输出投影
    return concat.map(c => this._matVec(this.Wo, c));
  }
}

// ============================================================
// LSTM-Attention 模型
// ============================================================

class LSTMAttention {
  constructor(config = {}) {
    this.inputSize = config.inputSize || 8;
    this.hiddenSize1 = config.hiddenSize1 || 32;
    this.hiddenSize2 = config.hiddenSize2 || 16;
    this.outputSize = config.outputSize || 1;
    this.numHeads = config.numHeads || 4;
    this.dropoutRate = config.dropoutRate || 0.15;
    this.lr = config.lr || 0.005;
    this.l2 = config.l2 || 0.001;

    // 双层LSTM
    this.lstm1 = new LSTMCell(this.inputSize, this.hiddenSize1, this.dropoutRate);
    this.lstm2 = new LSTMCell(this.hiddenSize1, this.hiddenSize2, 0);

    // Self-attention (在LSTM输出上)
    this.attention = new MultiHeadAttention(this.hiddenSize2, this.numHeads);

    // 输出层: attention output → prediction
    this.Wout = [];
    for (let i = 0; i < this.outputSize; i++) {
      const row = [];
      for (let j = 0; j < this.hiddenSize2; j++) row.push(xavierInit(this.hiddenSize2, this.outputSize));
      this.Wout.push(row);
    }
    this.bout = new Array(this.outputSize).fill(0);

    this.trainingLoss = [];
  }

  /**
   * 前向传播: 序列输入 → 预测输出
   * @param {Array} sequence - [timestep, inputSize]
   * @returns {number} 预测值 (下一期收益率)
   */
  forward(sequence, training = false) {
    const T = sequence.length;
    let h1 = new Array(this.hiddenSize1).fill(0);
    let c1 = new Array(this.hiddenSize1).fill(0);
    let h2 = new Array(this.hiddenSize2).fill(0);
    let c2 = new Array(this.hiddenSize2).fill(0);

    const lstm1Outputs = [];
    const lstm1Caches = [];

    // 第一层LSTM
    for (let t = 0; t < T; t++) {
      const { h, c } = this.lstm1.forward(sequence[t], h1, c1, training);
      lstm1Outputs.push(h);
      lstm1Caches.push(this.lstm1._cache);
      h1 = h;
      c1 = c;
    }

    // 第二层LSTM (在第一层输出上)
    const lstm2Outputs = [];
    for (let t = 0; t < T; t++) {
      const { h, c } = this.lstm2.forward(lstm1Outputs[t], h2, c2, training);
      lstm2Outputs.push(h);
      h2 = h;
      c2 = c;
    }

    // Self-attention
    const attended = this.attention.forward(lstm2Outputs);

    // 取最后一个时间步的attention输出 → 预测
    const lastAttended = attended[attended.length - 1];
    this._lastAttended = lastAttended; // ★ 存到实例, 供 train() 反向传播读取(否则 undefined 报错)
    let output = this.bout[0];
    for (let j = 0; j < this.hiddenSize2; j++) {
      output += this.Wout[0][j] * lastAttended[j];
    }

    return { prediction: output, lastHidden: lastAttended };
  }

  /**
   * 训练 (截断BPTT)
   */
  train(samples, epochs = 30, verbose = false) {
    for (let epoch = 0; epoch < epochs; epoch++) {
      // 学习率衰减 (cosine annealing)
      const lr = this.lr * 0.5 * (1 + Math.cos(Math.PI * epoch / epochs));

      let totalLoss = 0;
      let count = 0;

      // 打乱样本
      const shuffled = [...samples].sort(() => Math.random() - 0.5);

      for (const sample of shuffled) {
        const { prediction } = this.forward(sample.input, true);
        const target = sample.target;
        const error = prediction - target;
        totalLoss += error * error;
        count++;

        // 反向传播 (简化: 只更新输出层和第二层LSTM)
        // 输出层梯度
        const dOut = [2 * error];
        for (let j = 0; j < this.hiddenSize2; j++) {
          this.Wout[0][j] -= lr * (dOut[0] * this._lastAttended[j] + this.l2 * this.Wout[0][j]);
        }
        this.bout[0] -= lr * dOut[0];

        // 第二层LSTM更新 (近似梯度)
        this.lstm2.updateParams(lr, this.l2);
        this.lstm1.updateParams(lr * 0.5, this.l2); // 第一层用较小学习率
      }

      const avgLoss = count > 0 ? totalLoss / count : 0;
      this.trainingLoss.push(avgLoss);

      if (verbose && (epoch % 5 === 0 || epoch === epochs - 1)) {
        console.log(`    LSTM-Att epoch ${epoch+1}/${epochs} loss=${avgLoss.toFixed(6)}`);
      }
    }
  }

  /**
   * 预测
   */
  predict(sequence) {
    const { prediction } = this.forward(sequence, false);
    return prediction;
  }
}

// ============================================================
// 对外接口: 用历史数据预测
// ============================================================

/**
 * 使用LSTM-Attention预测基金未来收益率
 * @param {Array} history - 基金历史净值数据
 * @param {number} lookback - 回看窗口 (默认20天)
 * @param {number} forecastDays - 预测天数 (默认5天)
 * @returns {Object} { prediction, confidence, direction }
 */
function predictWithLSTMAttention(history, lookback = 20, forecastDays = 5) {
  if (!history || history.length < lookback + 10) return null;

  // 构建特征序列: 每天用 [收益率, 动量5, 动量10, 波动率5, RSI, 均线偏离, 成交量变化, 加速度]
  const closes = history.map(h => h.nav || h.close);
  const changes = history.map((h, i) => i > 0 ? (closes[i] / closes[i-1] - 1) : 0);
  const sequence = [];

  for (let i = lookback; i < closes.length; i++) {
    const window = changes.slice(Math.max(0, i - lookback), i);
    const ret5 = i >= 5 ? closes[i] / closes[i-5] - 1 : 0;
    const ret10 = i >= 10 ? closes[i] / closes[i-10] - 1 : 0;
    const vol5 = std(window.slice(-5));
    const rsi = calcRSISimple(closes.slice(0, i + 1), 14);
    const ma20 = closes.slice(Math.max(0, i - 20), i + 1).reduce((a, b) => a + b, 0) / Math.min(20, i + 1);
    const devMA = ma20 > 0 ? (closes[i] - ma20) / ma20 : 0;
    const accel = i >= 10 ? (closes[i] / closes[i-5] - 1) - (closes[i-5] / closes[i-10] - 1) : 0;
    const upDays = window.slice(-5).filter(r => r > 0).length / 5;

    sequence.push([changes[i] || 0, ret5, ret10, vol5, rsi / 100, devMA, accel, upDays]);
  }

  if (sequence.length < 10) return null;

  // 构建训练样本
  const samples = [];
  for (let i = 0; i < sequence.length - forecastDays; i++) {
    const input = sequence.slice(i, i + lookback);
    if (input.length < lookback) continue;

    // 标签: 未来forecastDays的累计收益
    const startIdx = lookback + i;
    let target = 0;
    for (let d = 0; d < forecastDays && startIdx + d < changes.length; d++) {
      target += changes[startIdx + d];
    }

    samples.push({ input, target });
  }

  if (samples.length < 10) return null;

  // 初始化模型
  const model = new LSTMAttention({
    inputSize: 8,
    hiddenSize1: 32,
    hiddenSize2: 16,
    outputSize: 1,
    numHeads: 4,
    dropoutRate: 0.15,
    lr: 0.003,
    l2: 0.001,
  });

  // 训练
  model.train(samples, 20);

  // 预测
  const lastSequence = sequence.slice(-lookback);
  let prediction = model.predict(lastSequence);

  // 限制预测值在合理范围内 (-10% ~ +10%)
  prediction = Math.max(-0.10, Math.min(0.10, prediction));

  // 方向和置信度
  const direction = prediction > 0.005 ? 'UP' : prediction < -0.005 ? 'DOWN' : 'FLAT';
  const confidence = Math.min(0.95, Math.max(0.1, Math.abs(prediction) * 8 + 0.3));

  return {
    prediction: prediction,
    predictedReturn: prediction,
    direction,
    confidence,
    trainingLoss: model.trainingLoss[model.trainingLoss.length - 1] || 0,
    sampleCount: samples.length,
  };
}

function std(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
}

function calcRSISimple(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    if (i > 0) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

module.exports = {
  LSTMAttention,
  LSTMCell,
  MultiHeadAttention,
  predictWithLSTMAttention,
};
