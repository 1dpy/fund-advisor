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
// 账本路径支持 HOLDINGS_FILE 环境变量(测试/隔离用), 默认项目根 holdings.json
function getHoldingsPath() {
  return process.env.HOLDINGS_FILE ? path.resolve(process.env.HOLDINGS_FILE) : path.join(ROOT, 'holdings.json');
}
// 备份与回撤记录固定写入 data/ (已被 .gitignore 忽略, 不污染项目根)
const ARTIFACT_DIR = path.join(ROOT, 'data');
const LAST_APPLIED_PATH = path.join(ARTIFACT_DIR, 'last_applied.json');

function loadHoldings() {
  try { return JSON.parse(fs.readFileSync(getHoldingsPath(), 'utf8')); }
  catch (e) { console.error('读取 holdings.json 失败:', e.message); return []; }
}

// 写账前自动备份(保留最近5份), 供"回撤"还原
function backupHoldings() {
  try {
    const hp = getHoldingsPath();
    if (!fs.existsSync(hp)) return;
    if (!fs.existsSync(ARTIFACT_DIR)) fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const f = path.join(ARTIFACT_DIR, 'holdings.applybak.' + Date.now() + '.json');
    fs.copyFileSync(hp, f);
    const list = fs.readdirSync(ARTIFACT_DIR)
      .filter(x => x.startsWith('holdings.applybak.'))
      .sort();
    while (list.length > 5) fs.unlinkSync(path.join(ARTIFACT_DIR, list.shift()));
  } catch (e) { /* 备份失败不阻断主流程 */ }
}

function saveHoldings(holdings) {
  fs.writeFileSync(getHoldingsPath(), JSON.stringify(holdings, null, 2));
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
  const appliedOps = []; // 实际写入的增量(供回撤)

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
        appliedOps.push({ action: 'SELL', code: op.code, name: op.name || op.code, amount: amt });
      } else {
        const t = parseTarget(op.target);
        if (!t) { log.push(`CONVERT 跳过: 目标解析失败 (${op.target})`); continue; }
        const tgt = findOrCreate(holdings, t.code, t.name);
        tgt.currentValue = round2(tgt.currentValue + amt);
        log.push(`CONVERT ${op.name || op.code}(${op.code}) ¥${amt.toFixed(0)} → ${tgt.name}(${tgt.code})`);
        appliedOps.push({ action: 'CONVERT', code: t.code, name: tgt.name, amount: amt, srcCode: op.code });
      }
    } else if (op.action === 'BUY' || op.action === 'DCA') {
      const tgt = findOrCreate(holdings, op.code, op.name);
      const amt = cash ? Math.min(op.amount || 0, cash.currentValue) : (op.amount || 0);
      if (amt <= 0) { log.push(`跳过: ${op.name || op.code} 买入金额≤0`); continue; }
      tgt.currentValue = round2(tgt.currentValue + amt);
      if (cash) cash.currentValue = round2(cash.currentValue - amt);
      log.push(`${op.action} ${op.name || op.code}(${op.code}) ¥${amt.toFixed(0)} ← 现金`);
      appliedOps.push({ action: op.action, code: op.code, name: op.name || op.code, amount: amt });
    } else {
      log.push(`${op.action} ${op.name || op.code || ''} (无持仓变动)`);
    }
  }

  if (!dryRun) {
    backupHoldings();
    saveHoldings(holdings);
    // 记录当次 apply 增量, 供用户说"回撤"时一键撤销
    if (appliedOps.length) {
      try {
        fs.writeFileSync(LAST_APPLIED_PATH, JSON.stringify({
          ts: new Date().toISOString(),
          note: '由建议自动执行写入; 用户若实际未买, 说"回撤"即可撤销',
          ops: appliedOps,
        }, null, 2));
      } catch (e) { /* 记录失败不阻断 */ }
    }
  }
  return { applied: !dryRun, log, holdings, appliedOps };
}

/**
 * 回撤: 撤销上一次 apply 写入的增量(用户实际未买时调用)
 * 反方向改回持仓, 并删除 last_applied 记录。
 * @returns {object} { ok, log }
 */
function revertLast() {
  let lp;
  try { lp = JSON.parse(fs.readFileSync(LAST_APPLIED_PATH, 'utf8')); }
  catch (e) { return { ok: false, msg: '没有可回撤的 apply 记录(可能已回撤或未执行 apply)' }; }
  const holdings0 = loadHoldings();
  let holdings = holdings0;
  const byCode = {};
  holdings.forEach(h => { byCode[h.code] = h; });
  const cash = byCode['CASH_YEB'];
  const log = [];
  const toRemove = []; // 回撤后减到0的非锁定基金, 直接移除避免脏条目
  for (const op of lp.ops) {
    if (op.action === 'BUY' || op.action === 'DCA') {
      const f = byCode[op.code];
      if (f) f.currentValue = round2(Math.max(0, f.currentValue - (op.amount || 0)));
      if (cash) cash.currentValue = round2(cash.currentValue + (op.amount || 0));
      if (f && f.currentValue <= 0 && !f.locked) toRemove.push(op.code);
      log.push(`↩ 回撤 BUY ${op.name || op.code}(${op.code}) ¥${(op.amount || 0)}`);
    } else if (op.action === 'SELL') {
      const f = byCode[op.code];
      if (f) f.currentValue = round2(f.currentValue + (op.amount || 0));
      if (cash) cash.currentValue = round2(cash.currentValue - (op.amount || 0));
      log.push(`↩ 回撤 SELL ${op.name || op.code}(${op.code}) ¥${(op.amount || 0)}`);
    } else if (op.action === 'CONVERT') {
      const t = byCode[op.code];
      const s = byCode[op.srcCode];
      if (t) t.currentValue = round2(Math.max(0, t.currentValue - (op.amount || 0)));
      if (s) s.currentValue = round2(s.currentValue + (op.amount || 0));
      log.push(`↩ 回撤 CONVERT → ${op.name || op.code}(${op.code})`);
    }
  }
  if (toRemove.length) holdings = holdings.filter(h => !toRemove.includes(h.code));
  backupHoldings();
  saveHoldings(holdings);
  try { fs.unlinkSync(LAST_APPLIED_PATH); } catch (e) {}
  return { ok: true, log };
}

module.exports = { applyAdvice, revertLast, parseTarget, findOrCreate, loadHoldings };

// CLI: node apply_advice.js <advice.json> [--dry-run] | node apply_advice.js --revert
if (require.main === module) {
  if (process.argv.includes('--revert')) {
    const r = revertLast();
    console.log(r.log ? r.log.join('\n') : r.msg);
    console.log(r.ok ? '\n✅ 已回撤上一次 apply' : '\n⚠️ 无需回撤');
    process.exit(r.ok ? 0 : 1);
  }
  const dryRun = process.argv.includes('--dry-run');
  const input = process.argv.find(a => a.endsWith('.json') && !a.includes('apply_advice'));
  let advice;
  if (input) {
    advice = JSON.parse(fs.readFileSync(input, 'utf8'));
  } else {
    console.error('用法: node apply_advice.js <advice.json> [--dry-run] | node apply_advice.js --revert');
    process.exit(1);
  }
  const res = applyAdvice(advice, { dryRun });
  console.log(res.log.join('\n'));
  console.log(res.applied ? '\n✅ 已写回 holdings.json' : '\n( dry-run, 未写入 )');
}
