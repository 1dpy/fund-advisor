/**
 * 参数敏感性分析 — 2D 网格回测 → 收益矩阵
 * ---------------------------------------------------------------
 * 量化研究中, 策略收益对参数高度敏感本身就是"过拟合风险"的信号。本模块
 * 在给定两套参数轴上做网格回测, 产出收益矩阵, 交给 report_chart.heatmapSVG
 * 渲染成热力图, 直观回答:
 *   "我的因子权重(动量 vs 估值)在多大范围内稳健? 还是只在某一点侥幸最优?"
 *
 * 设计: 与具体回测解耦。调用方传入 evalFn(rowVal, colVal) -> number,
 *       本模块只负责搭网格 + 收矩阵, 便于在 CI/离线用合成数据验证。
 *
 * 用法:
 *   const sh = require('./sensitivity_heatmap');
 *   const grid = sh.paramGrid({
 *     rows: [{label:'mom=0.0', value:0}, ...],
 *     cols: [{label:'val=0.0', value:0}, ...],
 *     evalFn: (momW, valW) => backtestReturnPct({ momentum:momW, valuation:valW, sentiment:1-momW-valW }),
 *   });
 *   // grid.matrix[i][j] 为收益值; grid.rowLabels/colLabels 用于绘图
 */

/**
 * 构造参数网格并求值
 * @param {Object} cfg
 *   rows: [{label, value}]   行参数 (y 轴)
 *   cols: [{label, value}]   列参数 (x 轴)
 *   evalFn: (rowValue, colValue) => number   返回标量(如收益%)
 * @returns { matrix: number[][], rowLabels: string[], colLabels: string[] }
 */
function paramGrid({ rows, cols, evalFn }) {
  const matrix = [];
  const rowLabels = rows.map((r) => r.label);
  const colLabels = cols.map((c) => c.label);
  for (const r of rows) {
    const row = [];
    for (const c of cols) {
      let v = 0;
      try { v = evalFn(r.value, c.value); } catch (e) { v = NaN; }
      row.push(typeof v === 'number' && isFinite(v) ? +v.toFixed(2) : NaN);
    }
    matrix.push(row);
  }
  return { matrix, rowLabels, colLabels };
}

// 从收益矩阵算颜色映射用的 min/max (忽略 NaN)
function matrixRange(matrix) {
  let lo = Infinity, hi = -Infinity;
  for (const row of matrix) for (const v of row) if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  if (lo === hi) hi = lo + 1e-6;
  return { lo, hi };
}

module.exports = { paramGrid, matrixRange };
