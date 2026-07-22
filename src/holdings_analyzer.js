/**
 * 基金持仓分析模块 — 深入分析基金底层资产
 *
 * 功能:
 *   1. 获取基金前十大重仓股 (东方财富API)
 *   2. 分析行业集中度
 *   3. 检测持仓重叠 (多只基金持同一股票)
 *   4. 关联美股映射 (重仓股是否有美股对标)
 *   5. 评估风格暴露 (成长/价值/周期/防御)
 */

const axios = require('axios');
const { getSector } = require('./rotation');

// ============================================================
//  获取基金持仓数据
// ============================================================

const client = axios.create({
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://fund.eastmoney.com/',
  },
});

/**
 * 获取基金前十大重仓股
 * 数据源: 东方财富 fundf10 API
 */
async function fetchFundHoldings(fundCode) {
  try {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=1&pageSize=1`;
    // 先获取最新净值日期, 然后获取持仓
    const holdingsUrl = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${fundCode}&topline=10&year=${new Date().getFullYear()}&month=`;
    const resp = await client.get(holdingsUrl, { responseType: 'text' });
    const text = resp.data;

    // 解析: var apidata={ content:"<html>...",arryear:...};
    const jsonMatch = text.match(/var apidata=\s*({[\s\S]*});?/);
    if (!jsonMatch) return null;

    // 提取content中的HTML表格
    const contentMatch = text.match(/content:"([\s\S]*?)",arryear/);
    if (!contentMatch) return null;

    const html = contentMatch[1].replace(/\\'/g, "'").replace(/\\"/g, '"');

    // 解析HTML表格提取重仓股
    const holdings = [];
    const rowRegex = /<tr[\s\S]*?<\/tr>/g;
    const rows = html.match(rowRegex) || [];

    for (const row of rows) {
      // 提取股票代码和名称
      const codeMatch = row.match(/<a[^>]*href="[^"]*\/(\d{6})\.shtml"[^>]*>([^<]+)<\/a>/);
      const nameMatch = row.match(/<a[^>]*>([^<]{2,10})<\/a>/g);
      const percentMatch = row.match(/(\d+\.?\d*)%/);

      if (codeMatch) {
        const stockCode = codeMatch[1];
        const stockName = codeMatch[2].trim();
        const percent = percentMatch ? parseFloat(percentMatch[1]) : 0;

        holdings.push({
          stockCode,
          stockName,
          percent,
        });
      }
    }

    return holdings.length > 0 ? holdings : null;
  } catch (e) {
    return null;
  }
}

/**
 * 备用数据源: 用基金名称推断持仓特征
 */
function inferHoldingsFromName(fundName) {
  const inferences = {};

  // 行业基金
  const sectorMap = {
    '芯片': ['中芯国际', '北方华创', '韦尔股份', '长电科技', '中微公司'],
    '半导体': ['中芯国际', '北方华创', '韦尔股份', '长电科技', '中微公司'],
    '电池': ['宁德时代', '比亚迪', '亿纬锂能', '赣锋锂业', '恩捷股份'],
    '新能源': ['宁德时代', '比亚迪', '隆基绿能', '阳光电源', '通威股份'],
    '光伏': ['隆基绿能', '通威股份', '晶澳科技', '阳光电源', 'TCL中环'],
    '医药': ['药明康德', '恒瑞医药', '迈瑞医疗', '爱尔眼科', '片仔癀'],
    '医疗': ['迈瑞医疗', '爱尔眼科', '药明康德', '泰格医药', '联影医疗'],
    '创新药': ['药明康德', '恒瑞医药', '百济神州', '信达生物', '君实生物'],
    '白酒': ['贵州茅台', '五粮液', '泸州老窖', '洋河股份', '山西汾酒'],
    '消费': ['贵州茅台', '五粮液', '美的集团', '格力电器', '海尔智家'],
    '券商': ['中信证券', '东方财富', '华泰证券', '国泰君安', '招商证券'],
    '银行': ['招商银行', '工商银行', '建设银行', '宁波银行', '兴业银行'],
    '军工': ['中航沈飞', '航发动力', '中航光电', '中国重工', '中航西飞'],
    '汽车': ['比亚迪', '长城汽车', '赛力斯', '长安汽车', '江淮汽车'],
    '传媒': ['三七互娱', '完美世界', '芒果超媒', '分众传媒', '光线传媒'],
    '黄金': ['紫金矿业', '山东黄金', '中金黄金', '银泰黄金', '赤峰黄金'],
    '信息': ['海康威视', '科大讯飞', '中科曙光', '紫光股份', '浪潮信息'],
    '科创': ['中芯国际', '金山办公', '中微公司', '传音控股', '澜起科技'],
    '创业板': ['宁德时代', '迈瑞医疗', '阳光电源', '汇川技术', '温氏股份'],
    '全球': ['苹果', '微软', '英伟达', '亚马逊', '谷歌'],  // QDII
    'QDII': ['苹果', '微软', '英伟达', '亚马逊', '谷歌'],
  };

  for (const [keyword, stocks] of Object.entries(sectorMap)) {
    if (fundName && fundName.includes(keyword)) {
      inferences.inferredStocks = stocks;
      inferences.inferredSector = keyword;
      break;
    }
  }

  return Object.keys(inferences).length > 0 ? inferences : null;
}

// ============================================================
//  持仓分析
// ============================================================

// 美股→A股对标映射 (用于关联分析)
const US_A_STOCK_MAP = {
  '英伟达': ['中芯国际', '北方华创', '韦尔股份', '海光信息'],
  'AMD': ['中芯国际', '海光信息', '寒武纪'],
  '台积电': ['中芯国际', '长电科技', '通富微电'],
  '苹果': ['立讯精密', '蓝思科技', '歌尔股份', '工业富联'],
  '微软': ['科大讯飞', '中科曙光', '金山办公'],
  '特斯拉': ['宁德时代', '比亚迪', '亿纬锂能', '拓普集团'],
  '谷歌': ['百度', '科大讯飞'],
  '亚马逊': ['阿里巴巴', '京东'],
  'Meta': ['腾讯', '快手'],
};

/**
 * 分析基金持仓
 */
function analyzeHoldings(holdings, fundName, usImpact) {
  if (!holdings || holdings.length === 0) {
    // 如果没有持仓数据, 用名称推断
    const inferred = inferHoldingsFromName(fundName);
    if (inferred) {
      return {
        available: true,
        source: 'inferred',
        topHoldings: inferred.inferredStocks?.map(s => ({ stockName: s, percent: 0 })) || [],
        sector: inferred.inferredSector,
        concentration: null,
        usExposure: [],
        style: null,
      };
    }
    return { available: false };
  }

  // 1. 集中度分析
  const totalPercent = holdings.reduce((s, h) => s + (h.percent || 0), 0);
  const top1 = holdings[0]?.percent || 0;
  const top3 = holdings.slice(0, 3).reduce((s, h) => s + (h.percent || 0), 0);
  const top5 = holdings.slice(0, 5).reduce((s, h) => s + (h.percent || 0), 0);

  let concentrationLevel;
  if (top5 > 50) concentrationLevel = '高度集中';
  else if (top5 > 35) concentrationLevel = '中等集中';
  else concentrationLevel = '分散持仓';

  // 2. 行业分布
  const sectorCounts = {};
  for (const h of holdings) {
    // 用rotation模块的getSector推断行业
    const mockFund = { name: h.stockName };
    const sector = getSector(mockFund) || inferStockSector(h.stockName);
    if (sector) sectorCounts[sector] = (sectorCounts[sector] || 0) + (h.percent || 1);
  }

  const topSector = Object.entries(sectorCounts).sort((a, b) => b[1] - a[1])[0];

  // 3. 美股关联
  const usExposure = [];
  if (usImpact?.available) {
    for (const h of holdings) {
      for (const [usStock, aStocks] of Object.entries(US_A_STOCK_MAP)) {
        if (aStocks.includes(h.stockName)) {
          const usData = usImpact.signals?.find(s => s.us === usStock);
          usExposure.push({
            stock: h.stockName,
            percent: h.percent,
            usStock,
            usChange: usData?.changePct || 0,
            direction: usData?.direction || '无信号',
          });
        }
      }
    }
  }

  // 4. 风格判断
  const growthStocks = ['宁德时代', '比亚迪', '中芯国际', '阳光电源', '亿纬锂能', '隆基绿能'];
  const valueStocks = ['招商银行', '工商银行', '贵州茅台', '五粮液', '中国平安'];
  const cyclicalStocks = ['紫金矿业', '中国铝业', '宝钢股份', '海螺水泥'];
  const defensiveStocks = ['长江电力', '片仔癀', '云南白药', '伊利股份'];

  let growthScore = 0, valueScore = 0, cyclicalScore = 0, defensiveScore = 0;
  for (const h of holdings) {
    if (growthStocks.includes(h.stockName)) growthScore += h.percent;
    if (valueStocks.includes(h.stockName)) valueScore += h.percent;
    if (cyclicalStocks.includes(h.stockName)) cyclicalScore += h.percent;
    if (defensiveStocks.includes(h.stockName)) defensiveScore += h.percent;
  }

  const styleScores = { growth: growthScore, value: valueScore, cyclical: cyclicalScore, defensive: defensiveScore };
  const dominantStyle = Object.entries(styleScores).sort((a, b) => b[1] - a[1])[0];
  const style = dominantStyle[1] > 15 ? dominantStyle[0] : 'balanced';

  return {
    available: true,
    source: 'actual',
    topHoldings: holdings.slice(0, 10),
    sector: topSector?.[0] || null,
    sectorConcentration: topSector ? Math.round(topSector[1]) : 0,
    concentration: {
      top1: Math.round(top1 * 10) / 10,
      top3: Math.round(top3 * 10) / 10,
      top5: Math.round(top5 * 10) / 10,
      total: Math.round(totalPercent * 10) / 10,
      level: concentrationLevel,
    },
    usExposure,
    style,
    styleScores,
  };
}

function inferStockSector(name) {
  const map = {
    '芯片': 'AI芯片', '半导体': 'AI芯片', '中芯': 'AI芯片', '华创': 'AI芯片', '韦尔': 'AI芯片',
    '宁德': '电池新能源', '比亚迪': '电池新能源', '亿纬': '电池新能源', '隆基': '电池新能源', '阳光电源': '电池新能源',
    '茅台': '消费白酒', '五粮液': '消费白酒', '泸州': '消费白酒',
    '药明': '医药医疗', '恒瑞': '医药医疗', '迈瑞': '医药医疗',
    '中信证券': '金融地产', '招商银行': '金融地产', '东方财富': '金融地产',
    '中航': '军工国防', '航发': '军工国防',
  };
  for (const [kw, sector] of Object.entries(map)) {
    if (name && name.includes(kw)) return sector;
  }
  return null;
}

/**
 * 检测多只基金之间的持仓重叠
 */
function detectOverlap(fundHoldingsMap) {
  const overlaps = [];
  const codes = Object.keys(fundHoldingsMap);

  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) {
      const h1 = fundHoldingsMap[codes[i]];
      const h2 = fundHoldingsMap[codes[j]];
      if (!h1?.topHoldings || !h2?.topHoldings) continue;

      const stocks1 = new Set(h1.topHoldings.map(h => h.stockName));
      const stocks2 = new Set(h2.topHoldings.map(h => h.stockName));
      const intersection = [...stocks1].filter(s => stocks2.has(s));

      if (intersection.length >= 3) {
        overlaps.push({
          fund1: codes[i],
          fund2: codes[j],
          overlapStocks: intersection,
          overlapCount: intersection.length,
          warning: intersection.length >= 5 ? '高度重叠, 分散化不足' : '部分重叠',
        });
      }
    }
  }

  return overlaps;
}

/**
 * 批量获取和分析基金持仓
 */
async function analyzeFundHoldings(funds, usImpact) {
  const results = {};
  const batchSize = 5;

  for (let i = 0; i < funds.length; i += batchSize) {
    const batch = funds.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (fund) => {
        const holdings = await fetchFundHoldings(fund.code);
        const analysis = analyzeHoldings(holdings, fund.name, usImpact);
        return { code: fund.code, analysis };
      })
    );

    for (const r of batchResults) {
      if (r.analysis.available) results[r.code] = r.analysis;
    }

    // 防止限流
    if (i + batchSize < funds.length) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  // 检测重叠
  const overlaps = detectOverlap(results);

  return { fundHoldings: results, overlaps };
}

module.exports = {
  fetchFundHoldings,
  analyzeHoldings,
  analyzeFundHoldings,
  detectOverlap,
  inferHoldingsFromName,
};
