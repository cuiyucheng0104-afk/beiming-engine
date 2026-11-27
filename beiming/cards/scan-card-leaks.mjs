import schema from '../kernel/contracts/card-file/schema/card.schema.json' with { type: 'json' };

const parityReport = new RegExp(schema.properties.status.items.properties.parityReport.pattern);
const leakPatterns = [
  ['lab-url', /lab:\/\//i],
  ['private-source-path', /原包源码|cards-overlay|exams-hidden|(?:复刻|调研资料|北冥引擎规划|实验室)[\\/]/i],
  ['local-path', /\/(?:Users|home)\/|\b[a-z]:[\\/]/i],
  ['bare-sha256', /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i],
];

/** 返回泄露类型和位置，避免把命中的内容回显到日志。 */
export function scanCardLeaks(cardObjOrText) {
  const leaks = [];
  const active = new WeakSet();

  function scanString(text, path, { raw = text, isKey = false, isReport = false } = {}) {
    const start = leaks.length;
    for (const [code, pattern] of leakPatterns) {
      if (code === 'bare-sha256' && isReport && parityReport.test(text)) continue;
      if (pattern.test(raw) || (text !== raw && pattern.test(text))) {
        leaks.push({ code, path: path || '/', ...(isKey ? { field: 'key' } : {}) });
      }
    }
    return leaks.length > start;
  }

  function childPath(path, key, raw = key) {
    const redact = scanString(key, path, { raw, isKey: true });
    return `${path}/${redact ? '[redacted]' : key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  }

  function visit(value, path, statusItem = false, isReport = false) {
    if (typeof value === 'string') scanString(value, path, { isReport });
    if (value === null || typeof value !== 'object' || active.has(value)) return;
    active.add(value);
    const statusArray = path === '/status' && Array.isArray(value);
    for (const [key, item] of Object.entries(value)) {
      visit(item, childPath(path, key), statusArray, statusItem && key === 'parityReport');
    }
    active.delete(value);
  }

  if (typeof cardObjOrText !== 'string') {
    visit(cardObjOrText, '');
    return leaks;
  }
  try {
    JSON.parse(cardObjOrText);
  } catch {
    scanString(cardObjOrText, '');
    return leaks;
  }

  // 语法已确认。逐个扫描原文词元，以保留数字精度和重复键中的内容。
  const tokens = cardObjOrText.match(/"(?:\\.|[^"\\])*"|[{}[\],:]|[^\s{}[\],:"]+/gu);
  let cursor = 0;
  function visitToken(path, statusItem = false, isReport = false) {
    const token = tokens[cursor++];
    if (token === '{') {
      while (tokens[cursor] !== '}') {
        const rawKey = tokens[cursor++];
        const key = JSON.parse(rawKey);
        cursor++; // 冒号
        visitToken(childPath(path, key), false, statusItem && key === 'parityReport');
        if (tokens[cursor] === ',') cursor++;
      }
      cursor++;
    } else if (token === '[') {
      let index = 0;
      while (tokens[cursor] !== ']') {
        visitToken(`${path}/${index++}`, path === '/status');
        if (tokens[cursor] === ',') cursor++;
      }
      cursor++;
    } else {
      const text = token.startsWith('"') ? JSON.parse(token) : token;
      scanString(text, path, { isReport });
    }
  }
  visitToken('');
  return leaks;
}
