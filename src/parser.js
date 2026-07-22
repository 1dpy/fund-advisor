/**
 * 自然语言持仓解析器
 * 支持用户用中文自由描述持仓, 自动提取结构化数据
 *
 * 支持格式示例:
 *   "510300 100股 成本5.02 6月28日买的"
 *   "沪深300ETF 持有200股 买入价4.95 6月25日"
 *   "买了1000块钱易方达蓝筹 净值1.512"
 *   "创业板ETF 200股 @4.36 6/28"
 */

const { WATCHLIST } = require('./config');

function buildLookupMap() {
  const codeToInfo = new Map();
  const nameToInfo = new Map();
  const allFunds = [...WATCHLIST.broadIndex, ...WATCHLIST.sectorETF, ...WATCHLIST.outsideFund];

  for (const f of allFunds) {
    const info = { code: f.code, name: f.name, type: f.type };
    codeToInfo.set(f.code, info);
    nameToInfo.set(f.name, info);
    // 简称变体
    const variants = [
      f.name,
      f.name.replace(/[ABCDE]类$/, ''),
      f.name.replace(/联接.*$/, ''),
      f.name.replace(/ETF$/, ''),
      f.name.replace(/增强[ABCDE]?$/, ''),
    ];
    for (const v of variants) {
      if (v.length >= 2 && !nameToInfo.has(v)) nameToInfo.set(v, info);
    }
  }

  // 别名表 (中文口语 → 代码)
  const aliases = {
    '沪深300': '510300', '中证500': '510500', '创业板': '159915',
    '科创50': '588000', '科创板': '588000',
    '证券': '512880', '券商': '512880',
    '白酒': '161725', '酒': '512690',
    '芯片': '516510', '半导体': '516510',
    '传媒': '512980',
    '蓝筹': '005827', '易方达蓝筹': '005827',
    '新能源': '003834', '能源': '003834',
    '上证50': '110003',
    '沪深300联接c': '005658', '沪深300c': '005658',
    '创业板增强c': '006928', '创业板c': '006928',
    '券商联接c': '007531', '证券c': '007531',
    '科创50联接c': '011609', '科创c': '011609',
    '酒c': '012414', '鹏华酒c': '012414',
  };
  for (const [alias, code] of Object.entries(aliases)) {
    if (!nameToInfo.has(alias)) {
      const info = codeToInfo.get(code) || { code, name: alias, type: code.startsWith('5') || code.startsWith('1') || code.startsWith('588') ? 'etf' : 'fund' };
      nameToInfo.set(alias, info);
    }
  }

  return { codeToInfo, nameToInfo };
}

function extractFundCode(text) {
  const match = text.match(/\b(\d{6})\b/);
  return match ? match[1] : null;
}

function extractShares(text) {
  const patterns = [
    /(\d+\.?\d*)\s*股/,
    /(\d+\.?\d*)\s*份/,
    /(\d+\.?\d*)\s*份额/,
    /持有\s*(\d+\.?\d*)/,
    /(\d+\.?\d*)\s*手/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      let shares = parseFloat(m[1]);
      if (m[0].includes('手')) shares *= 100;
      return shares;
    }
  }
  return null;
}

/**
 * 提取买入金额 — 只匹配明确有"元/块/块钱"模式的
 * 不匹配"成本XX"(容易跟价格混淆)
 */
function extractAmount(text) {
  const patterns = [
    /买了?\s*(\d+)\s*[元块]/,
    /买入\s*(\d+)\s*[元块]/,
    /投入\s*(\d+)\s*[元块]/,
    /花了?\s*(\d+)\s*[元块]/,
    /(\d+)\s*[元块]钱?\s*[买投]/,
    /金额\s*(\d+)/,
    /一共\s*(\d+)\s*[元块]/,
    /总共\s*(\d+)\s*[元块]/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

/**
 * 提取价格 (净值/股价)
 */
function extractPrice(text) {
  // 先去掉一些干扰项
  const cleaned = text
    .replace(/(\d+)元/g, '_AMT_')  // 保护金额表达式
    .replace(/(\d+)块/g, '_AMT_');

  const patterns = [
    /@\s*(\d+\.?\d*)/,                    // @4.36
    /[价成本净值]\s*(\d+\.?\d*)/g,         // 价5.02 成本5.02
    /买入[价均]?\s*(\d+\.?\d*)/,          // 买入价4.95
    /均价?\s*(\d+\.?\d*)/,                // 均价9.19
    /单价\s*(\d+\.?\d*)/,                 // 单价1.75
    /净值\s*(\d+\.?\d*)/,                 // 净值1.512
    /价格\s*(\d+\.?\d*)/,                 // 价格9.19
  ];

  let best = null;
  for (const p of patterns) {
    const regex = new RegExp(p.source, p.flags);
    let m;
    while ((m = regex.exec(cleaned)) !== null) {
      const val = parseFloat(m[1]);
      if (val >= 0.2 && val <= 30) best = val;
    }
  }
  return best;
}

/**
 * 提取日期 — 严格校验年月日范围
 */
function extractDate(text) {
  const today = new Date();
  const thisYear = today.getFullYear();

  // 完整的 YYYY-MM-DD / YYYY/MM/DD
  let m = text.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (m) {
    const [_, y, mo, d] = m;
    if (validDate(parseInt(y), parseInt(mo), parseInt(d))) {
      return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
    }
  }

  // X月X日 / X月X号
  m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (m) {
    const mo = parseInt(m[1]), d = parseInt(m[2]);
    if (validDate(thisYear, mo, d)) {
      return `${thisYear}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
  }

  // MM/DD (需要区分是日期还是价格: month 1-12, day 1-31, 且不在价格上下文中)
  m = text.match(/(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\s|$)/);
  if (m) {
    const mo = parseInt(m[1]), d = parseInt(m[2]);
    // 只有合理的月份+日期才认为是日期
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && validDate(thisYear, mo, d)) {
      return `${thisYear}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
  }

  return today.toISOString().split('T')[0];
}

function validDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const daysInMonth = new Date(y, m, 0).getDate();
  return d <= daysInMonth;
}

/**
 * 模糊匹配基金名称
 */
function findFundByName(nameText, nameToInfo) {
  if (nameToInfo.has(nameText)) return nameToInfo.get(nameText);
  for (const [key, info] of nameToInfo) {
    if (nameText.includes(key) || key.includes(nameText)) return info;
  }
  return null;
}

/**
 * 核心: 从自然语言文本提取持仓
 */
function parseHoldingsText(text) {
  const { codeToInfo, nameToInfo } = buildLookupMap();

  const lines = text
    .split(/[\n;；]/)
    .map(l => l.trim())
    .filter(l => l.length > 3);

  const holdings = [];

  for (const rawLine of lines) {
    if (/^(今天|明天|昨天|目前|现在|总共|合计)/.test(rawLine) && rawLine.length < 15) continue;

    const line = rawLine
      .replace(/[@＠]/g, '@')
      .replace(/[（(]/g, ' ')
      .replace(/[）)]/g, ' ')
      .replace(/，/g, ' ')
      .replace(/：/g, ' ')
      .replace(/大概|差不多|左右|约/g, ' ');

    // 1. 基金识别
    let code = extractFundCode(line);
    let info = code ? codeToInfo.get(code) : null;

    if (!info) {
      for (const [name, fundInfo] of nameToInfo) {
        if (line.toLowerCase().includes(name.toLowerCase())) {
          info = fundInfo;
          code = info.code;
          break;
        }
      }
      if (!info) {
        info = findFundByName(line, nameToInfo);
        if (info) code = info.code;
      }
    }
    if (!code) continue;

    // 2. 提取数据
    const shares = extractShares(line);
    const price = extractPrice(line);
    const amount = extractAmount(line);
    const buyDate = extractDate(line);

    // 3. 推算缺失值
    let finalShares = shares;
    let finalPrice = price || 0;
    let finalAmount = amount;

    if (finalShares && finalPrice && !finalAmount) {
      finalAmount = Math.round(finalShares * finalPrice * 100) / 100;
    } else if (finalAmount && finalPrice && !finalShares) {
      finalShares = finalAmount / finalPrice;
      // ETF取整到100股
      const isETF = info?.type === 'etf' || code.startsWith('5') || code.startsWith('1') || code.startsWith('588');
      if (isETF) finalShares = Math.floor(finalShares / 100) * 100;
    } else if (finalShares && finalAmount && !finalPrice) {
      finalPrice = Math.round(finalAmount / finalShares * 1000) / 1000;
    }

    if (!finalShares || finalShares <= 0) continue;
    // costBasis 始终用 shares * price 计算
    const costBasis = finalPrice > 0 ? Math.round(finalShares * finalPrice * 100) / 100 : (finalAmount || 0);

    const type = info?.type || (code.startsWith('5') || code.startsWith('1') || code.startsWith('588') ? 'etf' : 'fund');

    holdings.push({
      code: code,
      name: info?.name || code,
      type: type,
      buyPrice: Math.round(finalPrice * 1000) / 1000,
      shares: type === 'etf' ? Math.round(finalShares) : Math.round(finalShares * 100) / 100,
      costBasis: costBasis,
      buyDate: buyDate,
    });
  }

  return holdings;
}

/**
 * 交互式文字输入
 */
async function interactiveTextInput() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n📝 === 文字输入持仓 ===');
  console.log('  直接粘贴或输入你的持仓描述 (每行一只基金, 空行结束):');
  console.log('  "510300 100股 成本5.02 6月28日买"');
  console.log('  "沪深300ETF 持有200股 买入价4.95"');
  console.log('  "买了1000元易方达蓝筹 净值1.51"\n');

  const lines = [];
  while (true) {
    const line = await new Promise(resolve => rl.question('  > ', resolve));
    if (!line.trim()) break;
    lines.push(line.trim());
  }
  rl.close();

  if (lines.length === 0) {
    console.log('  ⚠️ 未输入任何内容\n');
    return [];
  }

  const holdings = parseHoldingsText(lines.join('\n'));

  if (holdings.length > 0) {
    console.log(`\n  ✅ 识别到 ${holdings.length} 只基金:`);
    for (const h of holdings) {
      console.log(`    ${h.code} ${h.name.padEnd(16)} | ${String(h.shares).padStart(8)}份 | 均价¥${h.buyPrice.toFixed(3)} | 成本¥${h.costBasis.toFixed(2)} | ${h.buyDate}`);
    }
  } else {
    console.log('\n  ⚠️ 未识别出基金持仓, 请检查格式 (需要包含代码或基金名+份额/金额)');
  }
  console.log('');

  return holdings;
}

module.exports = { parseHoldingsText, interactiveTextInput };
