/**
 * 清理测试遗留在 data_cache/ 里的合成净值缓存。
 *
 * 为什么需要: V4/属性测试的 seedCache() 会把假基金写进真实的 data_cache/,
 * 靠测试末尾的 cleanupCache() 回收。但只要测试中途失败、被 Ctrl-C、
 * 或早期版本还没写清理逻辑, 就会留下几百个假文件。它们会被
 * getCachedHistory 当成真实净值读走 —— 等于脏数据混进决策。
 *
 * 安全边界: 只删**确定属于测试**的合成代码, 采用白名单而非"删所有非6位"。
 *   真实基金代码恒为 6 位纯数字, 但反过来不成立 —— 不能按"非6位数字"
 *   去删, 否则会误伤历史遗留的合法文件。这里只认已知的测试前缀。
 *
 * 用法: node scripts/clean_test_cache.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'data_cache');

// 测试里生成假代码的模式, 逐个对应到产生它的测试文件:
//   Z<组号>_<序号>            → test/decision_fuzz_v4.test.js (随机组合)
//   Z<序号>                   → test/decision_fuzz.test.js
//   000AAA / 000BBB / 000CCC  → test/apply_advice.test.js
//   P1 P2                     → test/advisor_v4.test.js (止损冷却期)
const TEST_CODE_PATTERNS = [
  /^Z\d+_\d+$/,
  /^Z\d+$/,
  /^000(?:A{3}|B{3}|C{3})$/,
  /^P\d+$/,
];

function isTestCode(base) {
  return TEST_CODE_PATTERNS.some(re => re.test(base));
}

function main() {
  const dry = process.argv.includes('--dry');
  if (!fs.existsSync(CACHE_DIR)) {
    console.log('data_cache/ 不存在, 无需清理');
    return 0;
  }

  const hits = [];
  let kept = 0;
  for (const f of fs.readdirSync(CACHE_DIR)) {
    if (!f.endsWith('.json')) { kept++; continue; }
    const base = f.slice(0, -'.json'.length);
    if (isTestCode(base)) hits.push(f);
    else kept++;
  }

  if (hits.length === 0) {
    console.log(`✅ data_cache/ 干净 (保留 ${kept} 个真实净值缓存)`);
    return 0;
  }

  console.log(`发现 ${hits.length} 个测试残留缓存:`);
  console.log('  ' + hits.slice(0, 10).join(', ') + (hits.length > 10 ? ` ... 等 ${hits.length} 个` : ''));

  if (dry) {
    console.log('\n(--dry 模式, 未删除)');
    return 0;
  }

  let removed = 0;
  for (const f of hits) {
    try {
      fs.unlinkSync(path.join(CACHE_DIR, f));
      removed++;
    } catch (e) {
      console.log(`  ⚠️ 删除失败 ${f}: ${e.message}`);
    }
  }
  console.log(`已删除 ${removed} 个, 保留 ${kept} 个真实净值缓存`);
  return 0;
}

process.exit(main());
