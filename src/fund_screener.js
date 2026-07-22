/**
 * 全市场Top100基金筛选器 — 按模块精选前100只C类基金
 *
 * 模块分类:
 *   1. 科技/AI/芯片    2. 新能源/电池/光伏
 *   3. 消费/白酒       4. 医药/医疗/创新药
 *   5. 金融/银行/券商  6. 军工/国防
 *   7. 红利/高股息     8. QDII/全球
 *   9. 宽基/指数      10. 传媒/游戏
 *  11. 汽车/智驾      12. 资源/周期
 *
 * 每个模块获取近1月/3月/6月/1年涨幅Top50, 去重后保留前100
 * 全部筛选C类(支付宝0申购费), 排除债券/货币/理财
 */

const axios = require('axios');

const client = axios.create({
  timeout: 12000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://fund.eastmoney.com/',
  },
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
//  模块定义
// ============================================================

const MODULES = {
  techAI: {
    name: '科技/AI/芯片',
    keywords: ['芯片', '半导体', '集成电路', '人工智能', 'AI', '信息', '科技', '电子', '软件', '算力', '通信', '5G'],
    excludeKeywords: ['债', '银行', '地产'],
  },
  newEnergy: {
    name: '新能源/电池/光伏',
    keywords: ['新能源', '电池', '光伏', '锂电', '储能', '风电', '碳中和', '清洁', '环保', '稀土', '有色'],
    excludeKeywords: ['债', '银行'],
  },
  consume: {
    name: '消费/白酒',
    keywords: ['消费', '白酒', '食品', '饮料', '家电', '品牌', '零售', '商贸', '免税', '旅游'],
    excludeKeywords: ['债', '医药'],
  },
  pharma: {
    name: '医药/医疗/创新药',
    keywords: ['医药', '医疗', '创新药', '生物', '健康', '中药', '疫苗'],
    excludeKeywords: ['债', '消费'],
  },
  finance: {
    name: '金融/银行/券商',
    keywords: ['金融', '银行', '券商', '证券', '保险', '地产', '房地产'],
    excludeKeywords: ['债', '医药'],
  },
  military: {
    name: '军工/国防',
    keywords: ['军工', '国防', '航天', '航空', '兵器', '装备'],
    excludeKeywords: ['债'],
  },
  dividend: {
    name: '红利/高股息',
    keywords: ['红利', '股息', '价值', '蓝筹', '高息'],
    excludeKeywords: ['债', '成长'],
  },
  qdii: {
    name: 'QDII/全球',
    keywords: ['全球', 'QDII', '纳斯达克', '标普', '美国', '海外', '恒生', '港股', '日本', '德国', '亚太'],
    excludeKeywords: ['债', 'A股'],
  },
  broadIndex: {
    name: '宽基/指数',
    keywords: ['沪深300', '中证500', '中证1000', '创业板', '科创', '上证50', '深证', 'MSCI', '国证'],
    excludeKeywords: ['债', '行业'],
  },
  media: {
    name: '传媒/游戏',
    keywords: ['传媒', '游戏', '动漫', '影视', '文化', '数字', '娱乐'],
    excludeKeywords: ['债'],
  },
  auto: {
    name: '汽车/智驾',
    keywords: ['汽车', '智驾', '新能源车', '智能驾驶', '自动驾驶', '车联网'],
    excludeKeywords: ['债'],
  },
  resource: {
    name: '资源/周期',
    keywords: ['黄金', '煤炭', '石油', '钢铁', '有色', '大宗', '资源', '材料', '化工'],
    excludeKeywords: ['债'],
  },
};

// ============================================================
//  解析排行榜数据
// ============================================================

function parseRankData(raw) {
  try {
    const entries = raw.split('","');
    const results = [];

    for (const entry of entries) {
      const clean = entry.replace(/^.*?"/, '').replace(/".*$/, '');
      const fields = clean.split(',');
      if (fields.length < 8 || !/^\d{6}$/.test(fields[0])) continue;

      const dateIdx = fields.findIndex(f => /^\d{4}-\d{2}-\d{2}$/.test(f));
      if (dateIdx < 0 || dateIdx + 5 >= fields.length) continue;

      results.push({
        code: fields[0],
        name: fields[1],
        date: fields[dateIdx],
        nav: parseFloat(fields[dateIdx + 1]) || 0,
        dayPct: parseFloat(fields[dateIdx + 3]) || 0,
        weekPct: parseFloat(fields[dateIdx + 4]) || 0,
        monthPct: parseFloat(fields[dateIdx + 5]) || 0,
        type: 'fund',
      });
    }
    return results;
  } catch (e) {
    return [];
  }
}

// ============================================================
//  分类逻辑
// ============================================================

function classifyFund(fund) {
  const name = fund.name || '';
  const modules = [];

  for (const [moduleKey, mod] of Object.entries(MODULES)) {
    // 先检查排除词
    if (mod.excludeKeywords.some(kw => name.includes(kw))) continue;
    // 再检查匹配词
    if (mod.keywords.some(kw => name.includes(kw))) {
      modules.push(moduleKey);
    }
  }

  // 排除非C类 (保留C类优先, A类作为备选)
  const isC = name.endsWith('C');
  const isA = name.endsWith('A');

  return { modules, isC, isA };
}

// ============================================================
//  全市场筛选
// ============================================================

/**
 * 获取全市场基金排行榜 (多时间维度)
 */
async function fetchAllRankings() {
  const allFunds = new Map();

  const queries = [
    { sc: 'zzf', desc: '近1月', st: 'desc', pn: 200 },
    { sc: '3m', desc: '近3月', st: 'desc', pn: 200 },
    { sc: '6m', desc: '近6月', st: 'desc', pn: 200 },
    { sc: '1y', desc: '近1年', st: 'desc', pn: 200 },
    { sc: 'yn', desc: '今年来', st: 'desc', pn: 200 },
  ];

  for (const q of queries) {
    try {
      const url = `https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=all&sc=${q.sc}&st=${q.st}&pi=1&pn=${q.pn}&dx=1`;
      const raw = await client.get(url, { responseType: 'text' });
      const funds = parseRankData(typeof raw.data === 'string' ? raw.data : String(raw.data));

      for (const f of funds) {
        if (!f.code) continue;
        // 排除场内ETF (支付宝买不了)
        if (/^(5\d{5}|1[56]\d{4}|588\d{3})$/.test(f.code)) continue;
        // 排除债券/货币/理财
        if (/债|利率|货币|理财|纯债|短债|信用|同业存单/.test(f.name)) continue;
        if (/^9[56]/.test(f.code)) continue;

        if (!allFunds.has(f.code)) {
          allFunds.set(f.code, {
            ...f,
            type: 'fund',
            minBuy: 10,
            maxWeight: 0.15,
            sources: [q.desc],
            bestRankPct: f.monthPct,
          });
        } else {
          const existing = allFunds.get(f.code);
          existing.sources.push(q.desc);
          // 取最大涨幅作为排序依据
          if (f.monthPct > existing.bestRankPct) {
            existing.bestRankPct = f.monthPct;
          }
        }
      }
      await sleep(300);
    } catch (e) {
      // 某个榜单失败不影响整体
    }
  }

  return Array.from(allFunds.values());
}

/**
 * 按模块分类并选取Top100
 */
function selectTopPerModule(allFunds, topN = 100) {
  const moduleFunds = {};

  for (const [moduleKey, mod] of Object.entries(MODULES)) {
    moduleFunds[moduleKey] = {
      name: mod.name,
      funds: [],
    };
  }

  // 分类
  const classified = [];
  for (const fund of allFunds) {
    const { modules, isC, isA } = classifyFund(fund);
    if (modules.length === 0) continue; // 不属于任何模块
    classified.push({ ...fund, modules, isC, isA });
  }

  // 按模块分组
  for (const fund of classified) {
    for (const mod of fund.modules) {
      if (!moduleFunds[mod]) continue;
      moduleFunds[mod].funds.push(fund);
    }
  }

  // 每个模块排序: C类优先, 然后按bestRankPct降序
  const result = {};
  for (const [modKey, modData] of Object.entries(moduleFunds)) {
    const sorted = modData.funds
      .sort((a, b) => {
        // C类优先
        if (a.isC && !b.isC) return -1;
        if (!a.isC && b.isC) return 1;
        // 按涨幅
        return (b.bestRankPct || 0) - (a.bestRankPct || 0);
      })
      .slice(0, topN);

    result[modKey] = {
      name: modData.name,
      count: sorted.length,
      funds: sorted.map(f => ({
        code: f.code,
        name: f.name,
        type: 'fund',
        minBuy: 10,
        maxWeight: 0.15,
        module: modKey,
        moduleName: modData.name,
        monthPct: f.monthPct,
        weekPct: f.weekPct,
        dayPct: f.dayPct,
        isC: f.isC,
        sources: f.sources,
      })),
    };
  }

  return result;
}

/**
 * 全量获取: 拉取全市场 → 分类 → 每模块Top100
 */
async function screenTopFunds(topN = 100) {
  console.log('🔍 正在拉取全市场基金排行榜...');
  const allFunds = await fetchAllRankings();
  console.log(`  全市场获取: ${allFunds.length} 只基金`);

  const moduleResult = selectTopPerModule(allFunds, topN);

  // 统计
  let totalUnique = new Set();
  for (const mod of Object.values(moduleResult)) {
    for (const f of mod.funds) totalUnique.add(f.code);
  }

  console.log(`  分${Object.keys(moduleResult).length}个模块, 共${totalUnique.size}只去重基金`);

  // 合并去重后的完整基金列表 (用于数据获取)
  const allUniqueFunds = [];
  const seen = new Set();
  for (const mod of Object.values(moduleResult)) {
    for (const f of mod.funds) {
      if (!seen.has(f.code)) {
        seen.add(f.code);
        allUniqueFunds.push(f);
      }
    }
  }

  return { modules: moduleResult, allFunds: allUniqueFunds };
}

module.exports = { screenTopFunds, MODULES, classifyFund, selectTopPerModule };
