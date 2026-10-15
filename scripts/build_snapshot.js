/**
 * build_snapshot.js — 生成本地仪表盘的静态快照
 * ---------------------------------------------------------------
 * 思路: 在本地拉起 dashboard_server.js (Node 后端), 通过 HTTP 取各 /api/* 数据,
 *       存成 dashboard/api/*.json, 供 CloudStudio 静态部署 (无后端也能看)。
 *
 * 用法: node scripts/build_snapshot.js
 * 产物: dashboard/api/{portfolio,factors,backtest,selfiterate,sectors,mlcalibration,meta}.json
 *
 * 说明:
 *  - 持仓 portfolio 读 holdings.json (你的真实账本)
 *  - 因子/回测/自我迭代/赛道榜 用 demo(离线合成) 模式, 不依赖外网, 稳定可复现
 *  - 这是"快照", 非实时; 想更新数据就重跑本脚本 + 重新部署
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8799;
const API_DIR = path.join(ROOT, 'dashboard', 'api');
fs.mkdirSync(API_DIR, { recursive: true });

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + label)), ms)),
  ]);
}

const srv = spawn(process.execPath, ['dashboard_server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

async function get(name, mode) {
  const url = `http://localhost:${PORT}/api/${name}?mode=${mode || 'demo'}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}

function save(name, data) {
  fs.writeFileSync(path.join(API_DIR, name + '.json'), JSON.stringify(data));
  console.log('  ✅', name, JSON.stringify(data).length, 'bytes');
}

async function waitServer() {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://localhost:${PORT}/api/portfolio`);
      return true;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('dashboard_server 启动失败');
}

async function main() {
  console.log('🚀 启动本地后端生成快照...');
  await waitServer();
  console.log('✅ 后端就绪, 抓取各接口:');
  const tasks = [
    ['portfolio', 'demo'],
    ['factors', 'demo'],
    ['backtest', 'demo'],
    ['selfiterate', 'demo'],
    ['sectors', 'demo'],
    ['mlcalibration', 'demo'],
  ];
  for (const [n, m] of tasks) {
    try {
      const data = await withTimeout(get(n, m), 90000, n);
      save(n, data);
    } catch (e) {
      console.error('  ❌', n, '->', e.message);
      save(n, { error: e.message });
    }
  }
  const meta = {
    generatedAt: new Date().toISOString(),
    mode: 'demo(离线合成快照)',
    note: '静态部署用; 持仓=holdings.json 真实账本; 因子/回测/赛道为离线合成, 非实时',
  };
  fs.writeFileSync(path.join(API_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log('📦 快照已生成于:', API_DIR);
}

main()
  .catch((e) => {
    console.error('快照生成失败:', e);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      srv.kill();
    } catch (_) {}
  });
