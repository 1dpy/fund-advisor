/**
 * 持仓截图 OCR 解析器 — holding_image_parser.js
 * ---------------------------------------------------------------
 * 从持仓截图(支付宝/天天基金等)中尽力提取 基金名 / 持有金额 / 持有收益。
 * 设计原则: **识别仅供参考, 必须回显给用户核对后再写账** (防 OCR 错位产生假持仓)。
 *
 * 依赖 (可选, 用户本机按需安装, 不进 CI / 不污染零依赖):
 *   npm install tesseract.js
 * 未安装时 parseHoldingImage 会抛出明确提示, 由前端引导用户改为"把图发 AI 助手"。
 *
 * 用法:
 *   const { parseHoldingImage } = require('./src/holding_image_parser');
 *   const r = await parseHoldingImage('/abs/path/to/shot.png');
 *   // r = { engine, rawText, candidates: [{name, type, currentValue, holdingReturn, raw}] }
 */

const fs = require('fs');

// 基金名特征关键字 (宽松匹配, OCR 中文易错故放宽)
const FUND_KEYWORDS = ['混合', '股票', 'ETF', '联接', 'QDII', '货币', '债券', '指数', '增强', 'C', 'LOF', 'FOF'];
// 现金/货基类判定
const CASH_NAMES = ['余额宝', '零钱通', '活期', '货币', '现金', '余额', '理财'];

function isFundNameLine(line) {
  const t = line.trim();
  if (!t || t.length < 3) return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return false; // 纯数字不是名字
  if (/^[¥￥$]/.test(t) && /^-?\d+(\.\d+)?$/.test(t.slice(1).trim())) return false;
  return FUND_KEYWORDS.some((k) => t.includes(k));
}

// 从一行(及后续若干行)提取金额
function numbersIn(text) {
  const m = text.match(/-?\d+(?:\.\d+)?/g) || [];
  return m.map((x) => parseFloat(x));
}

/**
 * 启发式配对: 把"基金名行"和"其后的金额"配对。
 * 支付宝卡片大致结构: [基金名] [持有金额label] [金额] [收益label] [收益] ...
 * OCR 行序可能错乱, 这里取: 第一个较大正数=持有金额, 第一个负数=持有收益。
 */
function extractCandidates(rawText) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const candidates = [];
  const allNums = numbersIn(rawText);

  // 1) 现金账户优先: 余额宝/零钱通单独成现金项
  for (const ln of lines) {
    if (CASH_NAMES.some((k) => ln.includes(k)) && !candidates.some((c) => c.isCash)) {
      const nums = numbersIn(ln);
      const val = nums.length ? Math.max(...nums.filter((n) => n > 0)) : (allNums.length ? Math.max(...allNums.filter((n) => n > 0)) : 0);
      candidates.push({ name: ln, type: 'cash', currentValue: val || 0, holdingReturn: 0, isCash: true, raw: ln });
    }
  }

  // 2) 其余基金名行
  const fundLines = lines.filter(isFundNameLine);
  for (const ln of fundLines) {
    // 跳过已被现金匹配的
    if (candidates.some((c) => c.raw === ln)) continue;
    const nums = numbersIn(ln);
    // 该基金卡片后续金额: 全局里取第一个 >0 的大数作持有金额
    const positives = allNums.filter((n) => n > 0);
    const negatives = allNums.filter((n) => n < 0);
    const currentValue = positives.length ? positives[0] : (nums.length ? Math.max(...nums.map((n) => Math.abs(n))) : 0);
    const holdingReturn = negatives.length ? negatives[0] : 0;
    candidates.push({
      name: ln,
      type: 'fund',
      currentValue: Math.round(currentValue * 100) / 100,
      holdingReturn: Math.round(holdingReturn * 100) / 100,
      isCash: false,
      raw: ln,
    });
  }

  // 兜底: 若一行都没识别到, 至少把 OCR 原文返回, 让用户在界面手填
  if (!candidates.length) {
    return { candidates: [], allNums };
  }
  return { candidates, allNums };
}

/**
 * 解析持仓截图。
 * @param {string} imagePath 绝对路径 (PNG/JPG)
 * @returns {Promise<{engine:string, rawText:string, candidates:Array}>}
 */
async function parseHoldingImage(imagePath) {
  if (!fs.existsSync(imagePath)) throw new Error('图片不存在: ' + imagePath);
  let Tesseract;
  try {
    Tesseract = require('tesseract.js');
  } catch (e) {
    const err = new Error(
      '未安装 OCR 引擎 tesseract.js。\n' +
      '本机请执行:  npm install tesseract.js\n' +
      '装好重启仪表盘即可自动识别; 或把截图直接发给 AI 助手(它读图更准)。'
    );
    err.code = 'NO_OCR';
    throw err;
  }

  const createWorker = Tesseract.createWorker || (Tesseract.default && Tesseract.default.createWorker);
  if (typeof createWorker !== 'function') {
    throw new Error('tesseract.js 版本不兼容, 请安装 v4/v5: npm install tesseract.js');
  }

  const worker = await createWorker('chi_sim+eng');
  let text = '';
  try {
    const ret = await worker.recognize(imagePath);
    text = (ret && ret.data && ret.data.text) || '';
  } finally {
    try { await worker.terminate(); } catch (e) {}
  }

  const { candidates } = extractCandidates(text);
  return { engine: 'tesseract.js (chi_sim+eng)', rawText: text, candidates };
}

module.exports = { parseHoldingImage, extractCandidates };
