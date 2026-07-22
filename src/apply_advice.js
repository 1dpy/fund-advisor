/**
 * apply_advice.js — 建议即执行器
 *
 * 把模型生成的 advice.operations 直接应用到 holdings.json:
 *   SELL      : 减少源基金 currentValue, 增加现金
 *   CONVERT   : 减少源基金 currentValue, 增加目标基金 currentValue
 *   BUY/DCA   : 增加目标基金 currentValue, 减少现金
 *   HOLD/PLAN : 无持仓变动
 *
 * 用户授权: "每次给明确建议修改持仓时默认按说的买, 然后更新到持仓"
 * 因此默认 dryRun=false 直接写回 holdings.json (automation / --auto-apply 调用)。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOLDINGS_PATH = path.join(ROOT, 'holdings.json');

function loadHoldings() {
  try { return JSON.parse(fs.readFileSync(HOLDINGS_PATH, 'utf8')); }
  catch (e) { console.error('读取 holdings.json 失败:', e.message); return []; }
}

function saveHoldings(holdings) {
  fs.writeFileSync(HOLDINGS_PATH, JSON.stringify(holdings, null, 2));
}

function findOrCreate(holdings, code, name) {
  let f = holdings.find(x => x.code === code);
  if (!f) {
    f = {
      code,
      name: name || code,
      type: 'fund',
      buyPrice: 0,
      shares: 1,
      costBasis: 0,
      buyDate: new Date().toISOString().split('T')[0],
      currentValue: 0,
      holdingReturn: 0,
      notes: '由建议自动创建',
    };
    holdings.push(f);
  }
  return f;
}

function parseTarget(targetStr) {
  if (!targetStr) return null;
  const parts = targetStr.trim().split(/\s+/);
  const code = parts[0];
  const name = parts.slice(1).join(' ').trim();
  return { code, name };
}

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * 应用建议到持仓
 * @param {object} advice 模型输出 (含 operations)
 * @param {object} opts { dryRun: boolean }
 * @returns {object} { applied, log, holdings }
 */
function applyAdvice(advice, opts = {}) {
  const dryRun = opts.dryRun || false;
  const holdings = loadHoldings();
  const byCode = {};
  holdings.forEach(h => { byCode[h.code] = h; });
  const cash = byCode['CASH_YEB'];
  const log = [];

  if (!cash) {
    log.push('⚠️ 未找到现金账户 CASH_YEB, 无法处理买卖现金流');
  }

  for (const op of (advice.operations || [])) {
    if (op.action === 'SELL' || op.action === 'CONVERT') {
      const src = byCode[op.code];
      if (!src) { log.push(`跳过: 源基金 ${op.code} 未找到`); continue; }
      const amt = Math.min(op.amount || 0, src.currentValue);
      if (amt <= 0) { log.push(`跳过: ${op.name || op.code} 可卖金额≤0`); continue; }
      src.currentValue = round2(Math.max(0, src.currentValue - amt));
      if (src.currentValue === 0) {
        src.notes = (src.notes || '') + '; 已清仓(建议执行)';
      }
      if (op.action === 'SELL') {
        if (cash) cash.currentValue = round2(cash.currentValue + amt);
        log.push(`SELL ${op.name || op.code}(${op.code}) ¥${amt.toFixed(0)} → 现金`);
      } else {
        const t = parseTarget(op.target);
        if (!t) { log.push(`CONVERT 跳过: 目标解析失败 (${op.target})`); continue; }
        const tgt = findOrCreate(holdings, t.code, t.name);
        tgt.currentValue = round2(tgt.currentValue + amt);
        log.push(`CONVERT ${op.name || op.code}(${op.code}) ¥${amt.toFixed(0)} → ${tgt.name}(${tgt.code})`);
      }
    } else if (op.action === 'BUY' || op.action === 'DCA') {
      const tgt = findOrCreate(holdings, op.code, op.name);
      const amt = cash ? Math.min(op.amount || 0, cash.currentValue) : (op.amount || 0);
      if (amt <= 0) { log.push(`跳过: ${op.name || op.code} 买入金额≤0`); continue; }
      tgt.currentValue = round2(tgt.currentValue + amt);
      if (cash) cash.currentValue = round2(cash.currentValue - amt);
      log.push(`${op.action} ${op.name || op.code}(${op.code}) ¥${amt.toFixed(0)} ← 现金`);
    } else {
      log.push(`${op.action} ${op.name || op.code || ''} (无持仓变动)`);
    }
  }

  if (!dryRun) saveHoldings(holdings);
  return { applied: !dryRun, log, holdings };
}

module.exports = { applyAdvice, parseTarget, findOrCreate, loadHoldings };

// CLI: node apply_advice.js [--dry-run]
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const input = process.argv.find(a => a.endsWith('.json') && !a.includes('apply_advice'));
  let advice;
  if (input) {
    advice = JSON.parse(fs.readFileSync(input, 'utf8'));
  } else {
    console.error('用法: node apply_advice.js <advice.json> [--dry-run]');
    process.exit(1);
  }
  const res = applyAdvice(advice, { dryRun });
  console.log(res.log.join('\n'));
  console.log(res.applied ? '\n✅ 已写回 holdings.json' : '\n( dry-run, 未写入 )');
}
