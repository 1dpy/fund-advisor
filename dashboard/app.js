/* 仪表盘前端逻辑 — 拉取 /api/* 并渲染 Chart.js 图表 + 因子热力网格 */
(function () {
  'use strict';
  var UP = '#dc2626', DOWN = '#16a34a', BRAND = '#2563eb';
  var PALETTE = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];
  var state = { mode: 'demo', tab: 'overview' };
  var charts = {};

  function $(id) { return document.getElementById(id); }
  function showStatus(msg, isErr) { var s = $('status'); s.textContent = msg || ''; s.className = 'status' + (isErr ? ' err' : ''); }
  function showLoading(msg) { showStatus(msg); }

  function fetchJSON(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }
  function makeChart(id, cfg) { destroyChart(id); var ctx = $(id); if (!ctx) return null; charts[id] = new Chart(ctx, cfg); return charts[id]; }

  // 红涨绿跌
  function pnlColor(v) { return v >= 0 ? UP : DOWN; }

  // z-score 颜色: 正→红(强), 负→绿(弱), 居中白
  function zColor(z) {
    var t = Math.max(-3, Math.min(3, z)) / 3; // -1..1
    if (t >= 0) { // 白→红
      var r = 255, g = Math.round(255 - 130 * t), b = Math.round(255 - 160 * t);
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    } else {
      var a = -t; var rr = Math.round(255 - 175 * a), gg = Math.round(255 - 40 * a), bb = 255;
      return 'rgb(' + rr + ',' + gg + ',' + bb + ')';
    }
  }

  // ---------- 概览 ----------
  function renderOverview(d) {
    var cards = $('ovCards');
    var sign = d.totalPnl >= 0 ? 'up' : 'down';
    cards.innerHTML =
      kpi('总资产', '¥' + fmt(d.totalValue), '') +
      kpi('总成本', '¥' + fmt(d.totalCost), '') +
      kpi('总盈亏', (d.totalPnl >= 0 ? '+' : '') + '¥' + fmt(d.totalPnl), sign) +
      kpi('收益率', (d.totalPnlPct >= 0 ? '+' : '') + d.totalPnlPct + '%', sign);

    // 配置饼图
    var labels = d.positions.map(function (p) { return p.name + (p.locked ? '🔒' : ''); });
    var vals = d.positions.map(function (p) { return p.value; });
    makeChart('allocChart', {
      type: 'doughnut',
      data: { labels: labels, datasets: [{ data: vals, backgroundColor: PALETTE, borderWidth: 1 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', font: { size: 11 } }, tooltip: { callbacks: { label: function (c) { return c.label + ': ¥' + fmt(c.raw); } } } } }
    });

    // 盈亏柱
    var plabels = d.positions.map(function (p) { return p.name; });
    var pvals = d.positions.map(function (p) { return p.pnl; });
    makeChart('pnlChart', {
      type: 'bar',
      data: { labels: plabels, datasets: [{ label: '盈亏(¥)', data: pvals, backgroundColor: pvals.map(pnlColor) }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: function (v) { return '¥' + fmt(v); } } } } }
    });

    // 明细表
    var rows = d.positions.map(function (p) {
      return '<tr><td>' + p.name + (p.locked ? '<span class="lock">' + (p.lockReason || '锁定') + '</span>' : '') + '</td>' +
        '<td>¥' + fmt(p.cost) + '</td><td>¥' + fmt(p.value) + '</td>' +
        '<td class="' + (p.pnl >= 0 ? 'tag-up' : 'tag-down') + '">' + (p.pnl >= 0 ? '+' : '') + fmt(p.pnl) + '</td>' +
        '<td class="' + (p.pnl >= 0 ? 'tag-up' : 'tag-down') + '">' + (p.pnlPct >= 0 ? '+' : '') + p.pnlPct + '%</td>' +
        '<td>' + p.weight + '%</td></tr>';
    }).join('');
    $('posTable').innerHTML = '<table><thead><tr><th>持仓</th><th>成本</th><th>现值</th><th>盈亏</th><th>收益率</th><th>权重</th></tr></thead><tbody>' + rows + '</tbody></table>';
    showStatus('数据来源: ' + d.source + ' ｜ 截至 ' + d.asOf);
  }

  // ---------- 因子 ----------
  function renderFactors(d) {
    $('facMeta').textContent = '模式=' + d.mode + ' 截至=' + d.asOf + ' 样本=' + d.nDays + '日';
    var ranked = d.universe.slice().sort(function (a, b) { return b.score - a.score; });
    var labels = ranked.map(function (u) { return u.name; });
    var scores = ranked.map(function (u) { return u.score; });
    makeChart('factorBar', {
      type: 'bar',
      data: { labels: labels, datasets: [{ label: '综合 alpha', data: scores, backgroundColor: scores.map(function (s) { return s >= 0 ? UP : DOWN; }) }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: 'z-score 合成分 (越大越优先入选)' } } } }
    });

    // 热力图
    var hm = $('heatmap');
    var cols = d.heatmap.cols, groups = d.heatmap.groups, matrix = d.heatmap.matrix, rows = d.heatmap.rows;
    var ncol = cols.length;
    hm.style.display = 'grid';
    hm.style.gridTemplateColumns = '150px repeat(' + ncol + ', minmax(48px, 1fr))';
    hm.style.gap = '2px';
    var html = '';
    // 表头
    html += '<div></div>';
    for (var j = 0; j < ncol; j++) html += '<div class="chead">' + cols[j] + '<br><span style="opacity:.6">' + groups[j].slice(0, 3) + '</span></div>';
    for (var i = 0; i < rows.length; i++) {
      html += '<div class="rlabel">' + rows[i] + '</div>';
      for (var k = 0; k < ncol; k++) {
        var z = matrix[i][k];
        html += '<div class="hcell" style="background:' + zColor(z) + '" title="' + rows[i] + ' · ' + cols[k] + ' = ' + z + '">' + (z > 0 ? '+' : '') + z + '</div>';
      }
    }
    hm.innerHTML = html;
    showStatus('因子库: 动量/估值/情绪 多子因子 → 截面 z-score 标准化 → 加权合成 alpha (红=正向强, 绿=反向强)');
  }

  // ---------- 回测 ----------
  function renderBacktest(d) {
    var labels = d.strategies[0] ? d.strategies[0].curve.map(function (_, i) { return i; }) : [];
    var datasets = d.strategies.map(function (s, i) {
      return { label: s.label, data: s.curve, borderColor: PALETTE[i % PALETTE.length], backgroundColor: 'transparent', borderWidth: 1.6, pointRadius: 0 };
    });
    makeChart('eqChart', {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom', font: { size: 10 } }, tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + (c.raw * 100).toFixed(1) + '%'; } } } }, scales: { y: { ticks: { callback: function (v) { return (v * 100).toFixed(0) + '%'; } } } } }
    });

    var slabels = d.strategies.map(function (s) { return s.label; });
    makeChart('btBar', {
      type: 'bar',
      data: { labels: slabels, datasets: [
        { label: '总收益%', data: d.strategies.map(function (s) { return s.total; }), backgroundColor: d.strategies.map(function (s) { return s.total >= 0 ? UP : DOWN; }) },
        { label: '夏普', data: d.strategies.map(function (s) { return s.sharpe; }), backgroundColor: '#94a3b8' },
        { label: '回撤%', data: d.strategies.map(function (s) { return s.mdd; }), backgroundColor: '#7c3aed' }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });

    var rows = d.strategies.map(function (s) {
      return '<tr><td>' + s.label + '</td>' +
        '<td class="' + (s.total >= 0 ? 'tag-up' : 'tag-down') + '">' + (s.total >= 0 ? '+' : '') + s.total + '%</td>' +
        '<td>' + s.sharpe + '</td><td>' + s.mdd + '%</td><td>' + s.trades + '</td><td>¥' + s.costTotal.toFixed(2) + '</td></tr>';
    }).join('');
    $('btTable').innerHTML = '<table><thead><tr><th>策略</th><th>总收益</th><th>夏普</th><th>最大回撤</th><th>调仓</th><th>成本</th></tr></thead><tbody>' + rows + '</tbody></table>';
    showStatus('模式=' + d.mode + ' ｜ 区间 ' + d.nDays + ' 日(多regime) ｜ holdout 冻结 ' + d.holdout + ' 日 ｜ 已计入 C 类基金成本');
  }

  // ---------- 自我迭代 ----------
  function renderSelfIterate(d) {
    if (d.error) { showStatus(d.error, true); return; }
    var folds = d.folds;
    var flabels = folds.map(function (f) { return 'F' + f.i; });
    makeChart('evoChart', {
      type: 'line',
      data: { labels: flabels, datasets: [
        { label: '动量权重', data: d.paramTrajectory.map(function (p) { return p.momentum; }), borderColor: BRAND, borderWidth: 2, pointRadius: 0, tension: .3 },
        { label: '估值权重', data: d.paramTrajectory.map(function (p) { return p.valuation; }), borderColor: DOWN, borderWidth: 2, pointRadius: 0, tension: .3 },
        { label: '情绪权重', data: d.paramTrajectory.map(function (p) { return p.sentiment; }), borderColor: '#f59e0b', borderWidth: 2, pointRadius: 0, tension: .3 },
        { label: 'λ正则', data: d.paramTrajectory.map(function (p) { return p.lambda; }), borderColor: UP, borderWidth: 2, pointRadius: 0, tension: .3, borderDash: [4, 3] }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', font: { size: 11 } } }, scales: { y: { min: 0, max: 1.2 } } }
    });

    makeChart('degChart', {
      type: 'line',
      data: { labels: flabels, datasets: [
        { label: '过拟合降级Δ', data: folds.map(function (f) { return f.degradation; }), borderColor: UP, borderWidth: 2, pointRadius: 2, tension: .25 },
        { label: 'Δ滑动平均', data: folds.map(function (f) { return f.degEMA; }), borderColor: '#7c3aed', borderWidth: 2, pointRadius: 0, tension: .25 }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { suggestedMin: -2, suggestedMax: 2 } } }
    });

    // holdout 曲线 (各自归一化首值=1)
    function norm(c) { var base = c[0] || 1; return c.map(function (v) { return v / base; }); }
    var selfN = norm(d.holdoutCurves.self), statN = norm(d.holdoutCurves.static);
    var hlabels = selfN.map(function (_, i) { return i; });
    makeChart('hoChart', {
      type: 'line',
      data: { labels: hlabels, datasets: [
        { label: 'self-tuned', data: selfN, borderColor: BRAND, borderWidth: 2, pointRadius: 0, tension: .2 },
        { label: '固定默认', data: statN, borderColor: '#94a3b8', borderWidth: 2, pointRadius: 0, tension: .2, borderDash: [4, 3] }
      ] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + (c.raw * 100).toFixed(1) + '%'; } } } }, scales: { y: { ticks: { callback: function (v) { return (v * 100).toFixed(0) + '%'; } } } } }
    });

    var frows = folds.map(function (f) {
      var degCls = f.degradation > 0.3 ? 'tag-down' : '';
      return '<tr><td>F' + f.i + '</td><td>' + f.testPeriod + '</td><td>动' + f.params.momentum + '/估' + f.params.valuation + '/情' + f.params.sentiment + '/K' + f.params.topK + '</td><td>' + f.trainSharpe + '</td><td>' + f.testSharpe + '</td><td class="' + degCls + '">' + (f.degradation > 0 ? '+' + f.degradation : f.degradation) + '</td><td>' + f.lambda + '</td></tr>';
    }).join('');
    $('foldTable').innerHTML = '<table><thead><tr><th>折</th><th>测试区间</th><th>选中参数</th><th>训练夏普</th><th>样本外</th><th>降级Δ</th><th>λ</th></tr></thead><tbody>' + frows + '</tbody></table>';

    var imp = d.improvement;
    var vc = $('verdict');
    if (imp.holdoutSharpeDelta > 0) {
      vc.className = 'verdict best';
      vc.innerHTML = '自我迭代在最终测试集(holdout)上优于固定默认: 夏普Δ=' + imp.holdoutSharpeDelta + ', 收益Δ=' + imp.holdoutRetDelta + '%。说明元控制器(在线正则化+滚动扩展窗口)在未见数据上带来了泛化收益。平均测试窗夏普 self=' + imp.avgTestSharpeSelf + ' vs static=' + imp.avgTestSharpeStatic + '。';
    } else {
      vc.className = 'verdict warn';
      vc.innerHTML = '自我迭代在 holdout 上未优于固定默认(夏普Δ=' + imp.holdoutSharpeDelta + ')。诚实结论: 在基金短期高噪净值上, 自适应调参的样本外增益有限; 等权分散仍是更稳基线。元控制器价值在于"限制过拟合"而非"显著增收益"。平均测试窗夏普 self=' + imp.avgTestSharpeSelf + ' vs static=' + imp.avgTestSharpeStatic + '。';
    }
    showStatus('模式=' + d.mode + ' ｜ 折数=' + folds.length + ' ｜ 最终λ=' + d.metaFinal.lambda + ' ｜ 降级Δ EMA=' + d.metaFinal.degEMA);
  }

  // ---------- 实时赛道榜 ----------
  function renderSectors(d) {
    var top = d.top || [];
    var lead = top[0];
    var srcLabel = '模拟';
    if (d.dataSource.indexOf('ETF实时') >= 0) srcLabel = 'ETF实时';
    else if (d.dataSource.indexOf('混合') >= 0) srcLabel = 'ETF+估值';
    else if (d.dataSource.indexOf('动量') >= 0) srcLabel = '仅动量';
    else if (d.dataSource.indexOf('live') === 0) srcLabel = '实时';
    $('secCards').innerHTML = lead ? (
      kpi('榜首赛道', lead.name, lead.score >= 0 ? 'up' : 'down') +
      kpi('榜首综合分', (lead.score >= 0 ? '+' : '') + lead.score, lead.score >= 0 ? 'up' : 'down') +
      kpi('候选池', d.total + ' 只', '') +
      kpi('数据来源', srcLabel, srcLabel === '模拟' ? '' : 'up')
    ) : '';

    var labels = top.map(function (t) { return t.name; });
    var scores = top.map(function (t) { return t.score; });
    makeChart('sectorBar', {
      type: 'bar',
      data: { labels: labels, datasets: [{ label: '综合分', data: scores, backgroundColor: scores.map(function (s) { return s >= 0 ? UP : DOWN; }) }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return '综合分 ' + c.raw; } } } }, scales: { x: { title: { display: true, text: '综合得分 (红涨绿跌)' } } } }
    });

    function srcTag(t) {
      if (t.dataSource === 'etf') return '<span class="tag-up">ETF实时</span>';
      if (t.dataSource === 'estimate') return '基金估值';
      if (t.dataSource === 'momentum') return '动量兜底';
      return '—';
    }
    var rows = top.map(function (t, i) {
      var cp = t.changePct == null ? '—' : (t.changePct >= 0 ? '+' : '') + t.changePct + '%';
      var etf = t.etfName ? t.etfName : '—';
      return '<tr><td>' + (i + 1) + '</td><td>' + t.name + '</td><td>' + (t.sector || '') + '</td>' +
        '<td class="' + (t.changePct >= 0 ? 'tag-up' : 'tag-down') + '">' + cp + '</td>' +
        '<td>' + etf + '</td>' +
        '<td>' + srcTag(t) + '</td>' +
        '<td class="' + (t.mom5 >= 0 ? 'tag-up' : 'tag-down') + '">' + (t.mom5 >= 0 ? '+' : '') + t.mom5 + '%</td>' +
        '<td class="' + (t.maTrend >= 0 ? 'tag-up' : 'tag-down') + '">' + (t.maTrend >= 0 ? '+' : '') + t.maTrend + '%</td>' +
        '<td class="score ' + (t.score >= 0 ? 'tag-up' : 'tag-down') + '">' + (t.score >= 0 ? '+' : '') + t.score + '</td></tr>';
    }).join('');
    $('secTable').innerHTML = '<table><thead><tr><th>排名</th><th>名称</th><th>赛道</th><th>实时涨跌%</th><th>对应ETF</th><th>实时源</th><th>近5日%</th><th>均线偏离%</th><th>综合分</th></tr></thead><tbody>' + rows + '</tbody></table>';
    $('secMeta').textContent = '数据=' + d.dataSource + ' ｜ 截至=' + d.asOf;
    showStatus('实时赛道综合得分 Top' + top.length + ' ｜ ETF实时成交价优先(0.7×涨跌+0.2×近5日+0.1×均线), 基金估值/动量兜底 ｜ 供 advisor 动态选基 Top-N');
  }

  // ---------- 工具 ----------
  function fmt(n) { if (n == null || isNaN(n)) return '0'; var a = Math.abs(n); if (a >= 1e8) return (n / 1e8).toFixed(2) + '亿'; if (a >= 1e4) return (n / 1e4).toFixed(2) + '万'; return Number(n.toFixed(2)).toLocaleString('zh-CN'); }
  function kpi(label, val, sign) { return '<div class="kpi"><div class="label">' + label + '</div><div class="val ' + (sign || '') + '">' + val + '</div></div>'; }

  // ---------- 加载调度 ----------
  function loadTab() {
    var tab = state.tab;
    showLoading('加载中...');
    var q = '?mode=' + state.mode;
    if (tab === 'overview') {
      fetchJSON('/api/portfolio').then(renderOverview).catch(function (e) { showStatus('持仓加载失败: ' + e.message, true); });
    } else if (tab === 'factors') {
      fetchJSON('/api/factors' + q).then(renderFactors).catch(function (e) { showStatus('因子加载失败: ' + e.message, true); });
    } else if (tab === 'backtest') {
      fetchJSON('/api/backtest' + q).then(renderBacktest).catch(function (e) { showStatus('回测加载失败: ' + e.message, true); });
    } else if (tab === 'selfiterate') {
      fetchJSON('/api/selfiterate' + q).then(renderSelfIterate).catch(function (e) { showStatus('自我迭代加载失败: ' + e.message, true); });
    } else if (tab === 'sectors') {
      fetchJSON('/api/sectors' + q).then(renderSectors).catch(function (e) { showStatus('实时赛道加载失败: ' + e.message, true); });
    }
  }

  // ---------- 事件 ----------
  document.getElementById('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    [].forEach.call(document.querySelectorAll('#tabs button'), function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    state.tab = b.dataset.tab;
    [].forEach.call(document.querySelectorAll('.tabpane'), function (s) { s.classList.remove('active'); });
    document.getElementById(state.tab).classList.add('active');
    loadTab();
  });
  document.getElementById('modeSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    [].forEach.call(document.querySelectorAll('#modeSeg button'), function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    state.mode = b.dataset.mode;
    loadTab();
  });
  document.getElementById('refreshBtn').addEventListener('click', loadTab);

  // 初始
  loadTab();
})();
