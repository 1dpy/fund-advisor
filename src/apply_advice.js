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
// 产物目录(备份/回撤记录)支持 APPLY_ARTIFACT_DIR 环境变量隔离。
// ★ 测试必须设它: backupHoldings 只保留最近 5 份, 测试跑一轮会把用户真实的
//   holdings.applybak.* 全顶掉, 而且备份内容还是测试数据。
function getArtifactDir() {
  return process.env.APPLY_ARTIFACT_DIR ? path.resolve(process.env.APPLY_ARTIFACT_DIR) : path.join(ROOT, 'data');
}
const LAST_APPLIED_PATH = path.join(getArtifactDir(), 'last_applied.json');

function loadHoldings() {
  try { return JSON.parse(fs.readFileSync(getHoldingsPath(), 'utf8')); }
  catch (e) { console.error('读取 holdings.json 失败:', e.message); return []; }
}

// 写账前自动备份(保留最近5份), 供"回撤"还原
function backupHoldings() {
  try {
    const hp = getHoldingsPath();
    if (!fs.existsSync(hp)) return;
    const dir = getArtifactDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'holdings.applybak.' + Date.now() + '.json');
    fs.copyFileSync(hp, f);
    const list = fs.readdirSync(dir)
      .filter(x => x.startsWith('holdings.applybak.'))
      .sort();
    while (list.length > 5) fs.unlinkSync(path.join(dir, list.shift()));
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
      shares: 0,   // 必须是 0: credit() 会按净值折算追加, 初始给 1 会多算一份
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
function round4(n) { return Math.round(n * 10000) / 10000; }
function num(x) { const v = Number(x); return Number.isFinite(v) ? v : 0; }

// ============================================================
// 账本口径同步: currentValue 与 shares/costBasis 必须一起动
//
// 背景(真缺陷): 本文件(V5/V6 路径)只维护 currentValue; 而 V4 默认引擎走的
// advisor_v3.applyDecisions 只维护 shares/costBasis。两者写同一个 holdings.json
// 却各写一半字段 —— 跑过一次 --ultimate --apply 后, V4 读到的成本与份额全是旧的,
// 止损/止盈会按错误的盈亏率触发。
//
// costBasis 与净值无关, 永远能同步; shares 需要单位净值, 拿不到时明确告警而不是静默。
// ============================================================

/** 推算单位净值: 优先 currentValue/shares, 其次 buyPrice, 最后查本地净值缓存 */
function unitValue(h) {
  const cv = num(h.currentValue), sh = num(h.shares);
  if (cv > 0 && sh > 0) return cv / sh;
  const bp = num(h.buyPrice);
  return bp > 0 ? bp : 0;
}

// 净值缓存目录。NAV_CACHE_DIR 供测试隔离(见 data_collector 同款处理):
//   测试播种的假净值不该写进用户真实的 data_cache/
function navCacheDir() {
  return process.env.NAV_CACHE_DIR
    ? path.resolve(process.env.NAV_CACHE_DIR)
    : path.join(ROOT, 'data_cache');
}

/**
 * 从本地净值缓存取最新净值(同步, 离线)。
 * 本流程本就会给候选基金抓历史净值, 所以缓存基本都有。
 */
function lookupNav(code) {
  try {
    const f = path.join(navCacheDir(), `${code}.json`);
    if (!fs.existsSync(f)) return 0;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const arr = Array.isArray(j) ? j : (j.history || []);
    // 取日期最大的一条, 不假设数组是升序还是降序
    let best = 0, bestDate = '';
    for (const rec of arr) {
      if (!rec) continue;
      const v = Number(rec.nav != null ? rec.nav : rec.close);
      if (!Number.isFinite(v) || v <= 0) continue;
      const d = String(rec.date || '');
      if (!bestDate || d >= bestDate) { bestDate = d; best = v; }
    }
    return best;
  } catch (e) { /* 缓存缺失/损坏: 返回 0, 由调用方告警 */ }
  return 0;
}

/** 买入/转入: 市值 +amt, 成本 +amt, 份额按单位净值折算 */
function credit(h, amt, price, log) {
  if (amt <= 0) return;
  // ★ 单位净值必须在改市值**之前**算: unitValue 用 currentValue/shares,
  //   先加了 amt 会拿"新市值/旧份额"去折份额, 份额直接算少
  const up = num(price) || unitValue(h) || lookupNav(h.code);
  h.currentValue = round2(num(h.currentValue) + amt);
  h.costBasis = round2(num(h.costBasis) + amt);
  if (up > 0) {
    h.shares = round4(num(h.shares) + amt / up);
    if (!num(h.buyPrice)) h.buyPrice = round4(up);
  } else {
    // 拿不到净值时不能瞎填份额: V4 的 profitPct = shares*现价/costBasis - 1,
    // 份额填错会直接把盈亏率算飞, 进而误触发止损/止盈。宁可标记出来让人补。
    h.needsNavSync = true;
    log.push(`⚠️ ${h.code} ${h.name || ''} 无可用净值(指令未带 price 且本地缓存无此基金): `
      + `市值与成本已更新, 份额未同步 —— 请手动补 shares 后再跑 V4 决策`);
  }
  if (!h.buyDate) h.buyDate = new Date().toISOString().split('T')[0];
  if (num(h.currentValue) > 0 && num(h.costBasis) > 0) {
    h.holdingReturn = round2((h.currentValue - h.costBasis) / h.costBasis * 100);
  }
}

/** 卖出/转出: 按卖出占比同比例结转成本与份额(不能只减市值) */
function debit(h, amt, log) {
  const cv = num(h.currentValue);
  const amt2 = Math.min(amt, cv);
  if (amt2 <= 0) return 0;
  const ratio = cv > 0 ? amt2 / cv : 0;
  h.currentValue = round2(Math.max(0, cv - amt2));
  h.costBasis = round2(Math.max(0, num(h.costBasis) * (1 - ratio)));
  h.shares = round4(Math.max(0, num(h.shares) * (1 - ratio)));
  if (num(h.costBasis) > 0) {
    h.holdingReturn = round2((h.currentValue - h.costBasis) / h.costBasis * 100);
  }
  if (h.currentValue === 0) h.notes = (h.notes || '') + '; 已清仓(建议执行)';
  return amt2;
}

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
      const amt = debit(src, op.amount || 0, log);
      if (amt <= 0) { log.push(`跳过: ${op.name || op.code} 可卖金额≤0`); continue; }
      if (op.action === 'SELL') {
        if (cash) cash.currentValue = round2(cash.currentValue + amt);
        log.push(`SELL ${op.name || op.code}(${op.code}) ¥${amt.toFixed(0)} → 现金`);
        appliedOps.push({ action: 'SELL', code: op.code, name: op.name || op.code, amount: amt });
      } else {
        const t = parseTarget(op.target);
        if (!t) { log.push(`CONVERT 跳过: 目标解析失败 (${op.target})`); continue; }
        const tgt = findOrCreate(holdings, t.code, t.name);
        byCode[t.code] = tgt;
        credit(tgt, amt, op.price || op.nav, log);
        log.push(`CONVERT ${op.name || op.code}(${op.code}) ¥${amt.toFixed(0)} → ${tgt.name}(${tgt.code})`);
        appliedOps.push({ action: 'CONVERT', code: t.code, name: tgt.name, amount: amt, srcCode: op.code });
      }
    } else if (op.action === 'BUY' || op.action === 'DCA') {
      const tgt = findOrCreate(holdings, op.code, op.name);
      byCode[op.code] = tgt;
      const amt = cash ? Math.min(op.amount || 0, cash.currentValue) : (op.amount || 0);
      if (amt <= 0) { log.push(`跳过: ${op.name || op.code} 买入金额≤0`); continue; }
      credit(tgt, amt, op.price || op.nav, log);
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
      if (f) debit(f, op.amount || 0, log);
      if (cash) cash.currentValue = round2(cash.currentValue + (op.amount || 0));
      if (f && num(f.currentValue) <= 0 && !f.locked) toRemove.push(op.code);
      log.push(`↩ 回撤 BUY ${op.name || op.code}(${op.code}) ¥${(op.amount || 0)}`);
    } else if (op.action === 'SELL') {
      const f = byCode[op.code];
      if (f) credit(f, op.amount || 0, op.price || op.nav, log);
      if (cash) cash.currentValue = round2(cash.currentValue - (op.amount || 0));
      log.push(`↩ 回撤 SELL ${op.name || op.code}(${op.code}) ¥${(op.amount || 0)}`);
    } else if (op.action === 'CONVERT') {
      const t = byCode[op.code];
      const s = byCode[op.srcCode];
      if (t) debit(t, op.amount || 0, log);
      if (s) credit(s, op.amount || 0, op.price || op.nav, log);
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
