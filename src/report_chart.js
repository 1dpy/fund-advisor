/**
 * 回测可视化 — 零依赖 SVG 图表生成器
 * ---------------------------------------------------------------
 * 把回测结果渲染成可直接嵌入 HTML 报告的 SVG (无需 Chart.js / node-canvas),
 * 导师在 GitHub / 浏览器中直接看到图表, 比纯数字直观 10 倍
 * (参考 jaychouchannel/python-stock 的权益曲线可视化思路)。
 *
 * 提供:
 *   equityCurveSVG(curve, opts)        权益曲线 (含1.0基准线/统计标签)
 *   drawdownSVG(curve, opts)           回撤面积图
 *   efficientFrontierSVG(frontier, opts) 马克维茨有效前沿散点 + 最大夏普/最小方差点
 */

const COL = { line: '#2563eb', base: '#94a3b8', dd: '#dc2626', up: '#16a34a', down: '#dc2626', text: '#1e293b', grid: '#e2e8f0', maxS: '#16a34a', minV: '#2563eb' };

function svgHeader(w, h, bg = '#ffffff') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" font-family="Menlo,Consolas,monospace" font-size="11">` +
    `<rect width="${w}" height="${h}" fill="${bg}"/>`;
}

// 权益曲线: curve 为累计净值序列 (首值=1)
function equityCurveSVG(curve, opts = {}) {
  const { w = 720, h = 300, pad = { l: 48, r: 16, t: 24, b: 28 }, title = '权益曲线' } = opts;
  if (!curve || curve.length < 2) return '';
  const x0 = pad.l, x1 = w - pad.r, y0 = pad.t, y1 = h - pad.b;
  const lo = Math.min(...curve, 1), hi = Math.max(...curve, 1);
  const span = (hi - lo) || 1e-6;
  const X = (i) => x0 + (i / (curve.length - 1)) * (x1 - x0);
  const Y = (v) => y1 - ((v - lo) / span) * (y1 - y0);
  let s = svgHeader(w, h) + `<text x="${pad.l}" y="15" fill="${COL.text}" font-weight="bold">${title}</text>`;
  // 网格 + Y 轴标签
  for (let k = 0; k <= 4; k++) {
    const v = lo + (span * k) / 4, y = Y(v);
    s += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" stroke="${COL.grid}"/>`;
    s += `<text x="${x0 - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="${COL.text}">${(v * 100).toFixed(0)}%</text>`;
  }
  // 1.0 基准线
  if (lo < 1 && hi > 1) s += `<line x1="${x0}" y1="${Y(1).toFixed(1)}" x2="${x1}" y2="${Y(1).toFixed(1)}" stroke="${COL.base}" stroke-dasharray="4 3"/>`;
  // 曲线
  let d = '';
  curve.forEach((v, i) => { d += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1) + ' '; });
  const end = curve[curve.length - 1];
  const stroke = end >= 1 ? COL.up : COL.down;
  s += `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.8"/>`;
  // 统计标签
  const total = ((end - 1) * 100).toFixed(1);
  s += `<text x="${x1 - 4}" y="${y0 + 4}" text-anchor="end" fill="${stroke}" font-weight="bold">总收益 ${total}%</text>`;
  s += `</svg>`;
  return s;
}

// 回撤面积图
function drawdownSVG(curve, opts = {}) {
  const { w = 720, h = 200, pad = { l: 48, r: 16, t: 20, b: 24 }, title = '回撤' } = opts;
  if (!curve || curve.length < 2) return '';
  let peak = curve[0]; const dd = curve.map((v) => { peak = Math.max(peak, v); return v / peak - 1; });
  const x0 = pad.l, x1 = w - pad.r, y0 = pad.t, y1 = h - pad.b;
  const lo = Math.min(...dd, -1e-6), hi = 0;
  const span = (hi - lo) || 1e-6;
  const X = (i) => x0 + (i / (dd.length - 1)) * (x1 - x0);
  const Y = (v) => y1 - ((v - lo) / span) * (y1 - y0);
  let s = svgHeader(w, h) + `<text x="${pad.l}" y="13" fill="${COL.text}" font-weight="bold">${title}</text>`;
  for (let k = 0; k <= 2; k++) {
    const v = lo + (span * k) / 2, y = Y(v);
    s += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" stroke="${COL.grid}"/>`;
    s += `<text x="${x0 - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="${COL.text}">${(v * 100).toFixed(0)}%</text>`;
  }
  let d = `M${X(0).toFixed(1)} ${Y(0).toFixed(1)} `;
  dd.forEach((v, i) => { d += 'L' + X(i).toFixed(1) + ' ' + Y(v).toFixed(1) + ' '; });
  d += `L${X(dd.length - 1).toFixed(1)} ${Y(0).toFixed(1)} Z`;
  const mdd = (Math.min(...dd) * 100).toFixed(1);
  s += `<path d="${d}" fill="${COL.dd}" fill-opacity="0.18" stroke="${COL.dd}" stroke-width="1"/>`;
  s += `<text x="${x1 - 4}" y="${y0 + 2}" text-anchor="end" fill="${COL.down}" font-weight="bold">最大回撤 ${mdd}%</text>`;
  s += `</svg>`;
  return s;
}

// 有效前沿散点 (vol, ret) + 最大夏普(绿) + 最小方差(蓝)
function efficientFrontierSVG(frontier, opts = {}) {
  const { w = 720, h = 380, pad = { l: 52, r: 16, t: 24, b: 40 }, title = '马克维茨有效前沿 (Monte Carlo)' } = opts;
  if (!frontier || !frontier.length) return '';
  const xs = frontier.map((p) => p.vol), ys = frontier.map((p) => p.ret);
  const xlo = 0, xhi = Math.max(...xs) * 1.05 || 1e-6;
  const ylo = Math.min(...ys, 0), yhi = Math.max(...ys) * 1.05;
  const spanX = (xhi - xlo) || 1e-6, spanY = (yhi - ylo) || 1e-6;
  const x0 = pad.l, x1 = w - pad.r, y0 = pad.t, y1 = h - pad.b;
  const X = (v) => x0 + ((v - xlo) / spanX) * (x1 - x0);
  const Y = (v) => y1 - ((v - ylo) / spanY) * (y1 - y0);
  let s = svgHeader(w, h) + `<text x="${pad.l}" y="15" fill="${COL.text}" font-weight="bold">${title}</text>`;
  // 轴
  s += `<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="${COL.text}"/>`;
  s += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}" stroke="${COL.text}"/>`;
  s += `<text x="${(x0 + x1) / 2}" y="${h - 6}" text-anchor="middle" fill="${COL.text}">年化波动率 σ</text>`;
  s += `<text x="12" y="${(y0 + y1) / 2}" text-anchor="middle" fill="${COL.text}" transform="rotate(-90 12 ${(y0 + y1) / 2})">年化收益 μ</text>`;
  // 散点
  for (const p of frontier) {
    s += `<circle cx="${X(p.vol).toFixed(1)}" cy="${Y(p.ret).toFixed(1)}" r="1.6" fill="${COL.line}" fill-opacity="0.35"/>`;
  }
  if (opts.maxSharpe) {
    const m = opts.maxSharpe;
    s += `<circle cx="${X(m.vol).toFixed(1)}" cy="${Y(m.ret).toFixed(1)}" r="6" fill="none" stroke="${COL.maxS}" stroke-width="2"/>`;
    s += `<text x="${X(m.vol).toFixed(1) + 8}" y="${Y(m.ret).toFixed(1)}" fill="${COL.maxS}" font-weight="bold">最大夏普</text>`;
  }
  if (opts.minVariance) {
    const m = opts.minVariance;
    s += `<circle cx="${X(m.vol).toFixed(1)}" cy="${Y(m.ret).toFixed(1)}" r="6" fill="none" stroke="${COL.minV}" stroke-width="2"/>`;
    s += `<text x="${X(m.vol).toFixed(1) + 8}" y="${Y(m.ret).toFixed(1) + 14}" fill="${COL.minV}" font-weight="bold">最小方差</text>`;
  }
  s += `</svg>`;
  return s;
}

// ============================================================
// 参数敏感性热力图 (color-mapped grid)
//   matrix: number[][], rowLabels/colLabels: string[]
//   opts: { title, lo, hi, fmt }  fmt(v)->字符串 用于单元格标注
//   颜色: 红(低/亏) → 黄 → 绿(高/赚) 的连续映射
// ============================================================
function heatmapSVG(matrix, opts = {}) {
  const { title = '参数敏感性热力图', fmt = (v) => (isFinite(v) ? v.toFixed(1) + '%' : 'N/A') } = opts;
  if (!matrix || !matrix.length || !matrix[0].length) return '';
  const rows = matrix.length, cols = matrix[0].length;
  const cell = 92, padL = 120, padT = 34, padB = 54, padR = 16;
  const w = padL + cols * cell + padR, h = padT + rows * cell + padB;
  const lo = opts.lo != null ? opts.lo : Math.min(...matrix.flat().filter(isFinite));
  const hi = opts.hi != null ? opts.hi : Math.max(...matrix.flat().filter(isFinite));
  const span = (hi - lo) || 1e-6;
  // 红(#dc2626)→黄(#facc15)→绿(#16a34a) 三段插值
  function color(v) {
    if (!isFinite(v)) return '#e2e8f0';
    let t = (v - lo) / span; t = Math.max(0, Math.min(1, t));
    const r = t < 0.5
      ? Math.round(220 + (250 - 220) * (t / 0.5))
      : Math.round(250 + (22 - 250) * ((t - 0.5) / 0.5));
    const g = t < 0.5
      ? Math.round(38 + (204 - 38) * (t / 0.5))
      : Math.round(204 + (163 - 204) * ((t - 0.5) / 0.5));
    const b = t < 0.5
      ? Math.round(38 + (21 - 38) * (t / 0.5))
      : Math.round(21 + (74 - 21) * ((t - 0.5) / 0.5));
    return `rgb(${r},${g},${b})`;
  }
  let s = svgHeader(w, h) + `<text x="${padL}" y="18" fill="${COL.text}" font-weight="bold">${title}</text>`;
  // 列标签
  for (let j = 0; j < cols; j++) {
    s += `<text x="${padL + j * cell + cell / 2}" y="${padT - 8}" text-anchor="middle" fill="${COL.text}" font-size="10">${matrix[0] && opts.colLabels ? opts.colLabels[j] : ''}</text>`;
  }
  for (let i = 0; i < rows; i++) {
    // 行标签
    s += `<text x="${padL - 8}" y="${padT + i * cell + cell / 2 + 3}" text-anchor="end" fill="${COL.text}" font-size="10">${opts.rowLabels ? opts.rowLabels[i] : ''}</text>`;
    for (let j = 0; j < cols; j++) {
      const v = matrix[i][j];
      const x = padL + j * cell, y = padT + i * cell;
      s += `<rect x="${x + 2}" y="${y + 2}" width="${cell - 4}" height="${cell - 4}" fill="${color(v)}" rx="4"/>`;
      s += `<text x="${x + cell / 2}" y="${y + cell / 2 + 4}" text-anchor="middle" fill="#0f172a" font-size="11" font-weight="bold">${fmt(v)}</text>`;
    }
  }
  // 图例
  const lgX = padL, lgY = padT + rows * cell + 22, lgW = Math.min(220, cols * cell);
  const grad = `lg_${title.length}`;
  s += `<defs><linearGradient id="${grad}" x1="0" x2="1"><stop offset="0" stop-color="#dc2626"/><stop offset="0.5" stop-color="#facc15"/><stop offset="1" stop-color="#16a34a"/></linearGradient></defs>`;
  s += `<rect x="${lgX}" y="${lgY}" width="${lgW}" height="10" fill="url(#${grad})" rx="2"/>`;
  s += `<text x="${lgX}" y="${lgY + 24}" text-anchor="start" fill="${COL.text}" font-size="9">${lo.toFixed(1)}%</text>`;
  s += `<text x="${lgX + lgW}" y="${lgY + 24}" text-anchor="end" fill="${COL.text}" font-size="9">${hi.toFixed(1)}%</text>`;
  s += `</svg>`;
  return s;
}

module.exports = { equityCurveSVG, drawdownSVG, efficientFrontierSVG, heatmapSVG };
