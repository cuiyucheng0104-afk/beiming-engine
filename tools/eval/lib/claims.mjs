// 「已交付 / 用户已认可」声明扫描（D08：这类字样只能由 accepted 状态生成）。
//
// 文本里每处命中分三类：
//   claim   —— 作为事实陈述出现（违规，除非状态确实是 accepted）；
//   quoted  —— 在引号里（例如复述用户的要求「说明里写『已交付』」），不算陈述；
//   negated —— 前面紧挨着否定词（未、没有、不写、并非、not…），不算陈述。
// 这是启发式：报告给出上下文，供评审复核。JSON 文件只看 status / state 一类字段的取值。
// 接口：scanText(text) → hits；scanFile(file) → hits；scanFilmDir(dir, { skip }) → hits；CLAIM_PATTERNS

import fs from 'node:fs';
import path from 'node:path';
import { walk } from './files.mjs';

export const CLAIM_PATTERNS = [
  /用户已(经)?认可/g, /客户已(经)?认可/g, /已(经)?(获得?|得到)?(用户|客户)?认可/g, /已(经)?(正式)?交付/g, /交付完成/g,
  /\b(is|was|has been) (accepted|delivered)\b/gi, /\bdelivered to (the )?(user|client)\b/gi,
];

const OPEN_QUOTES = '「『“‘"《';
const CLOSE_QUOTES = '」』”’"》';
const NEGATION = /(未|没有|没|不是|不能|不会|不得|不写|不要|不应|尚未|并非|而非|并未|拒绝|无法|别|勿|\bnot\b|\bno\b|\bnever\b|n't|without)\s*[^\s，。；,.;]{0,4}$/i;
const SENTENCE_END = /[。！？!?；;\n]/;

function classify(text, index, length) {
  // 当前句子范围
  let start = index;
  while (start > 0 && !SENTENCE_END.test(text[start - 1])) start--;
  let end = index + length;
  while (end < text.length && !SENTENCE_END.test(text[end])) end++;
  const before = text.slice(start, index);
  const after = text.slice(index + length, end);
  // 引号：句内、命中之前有未闭合的开引号，且命中之后有闭引号
  let depth = 0;
  for (const ch of before) {
    if (OPEN_QUOTES.includes(ch) && !CLOSE_QUOTES.includes(ch)) depth++;
    else if (CLOSE_QUOTES.includes(ch) && !OPEN_QUOTES.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === '"') depth = depth ? depth - 1 : depth + 1;
  }
  if (depth > 0 && [...after].some(ch => CLOSE_QUOTES.includes(ch))) return 'quoted';
  if (NEGATION.test(before.slice(-12))) return 'negated';
  return 'claim';
}

/** 扫一段文本。返回 [{ phrase, index, line, context, kind }]。 */
export function scanText(text) {
  const hits = [];
  const ranges = [];
  for (const re of CLAIM_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const a = m.index;
      const b = m.index + m[0].length;
      if (ranges.some(([x, y]) => a < y && b > x)) continue;   // 与已有命中重叠（如「用户已认可」里的「已认可」）
      ranges.push([a, b]);
      const line = text.slice(0, m.index).split('\n').length;
      const context = text.slice(Math.max(0, m.index - 24), Math.min(text.length, m.index + m[0].length + 24)).replace(/\s+/g, ' ');
      hits.push({ phrase: m[0], index: m.index, line, context, kind: classify(text, m.index, m[0].length) });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

const STATUS_KEYS = /^(status|state|approval|delivery|deliveryStatus|creativeStatus)$/i;
const CLAIM_VALUES = /^(accepted|delivered|已交付|已认可|用户已认可)$/i;

function scanJsonValue(value, keyPath, hits) {
  if (Array.isArray(value)) { value.forEach((v, i) => scanJsonValue(v, `${keyPath}[${i}]`, hits)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = keyPath ? `${keyPath}.${k}` : k;
      if (typeof v === 'string' && STATUS_KEYS.test(k) && CLAIM_VALUES.test(v.trim())) hits.push({ phrase: v, index: 0, line: null, context: `${p} = ${v}`, kind: 'claim', jsonPath: p });
      else scanJsonValue(v, p, hits);
    }
  }
}

export function scanFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  if (file.endsWith('.json')) {
    const hits = [];
    try { scanJsonValue(JSON.parse(text), '', hits); } catch { /* 坏 JSON 不在这里报 */ }
    return hits.map(h => ({ ...h, file }));
  }
  return scanText(text).map(h => ({ ...h, file }));
}

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.html', '.htm']);

/** 扫作品目录下的说明与记录（默认跳过 out/ 里的生成物与 node_modules）。 */
export function scanFilmDir(dir, { skipDirs = new Set(['out', 'node_modules', '.git']) } = {}) {
  if (!fs.existsSync(dir)) return [];
  return walk(dir, { skipDirs }).filter(e => TEXT_EXT.has(path.extname(e.abs).toLowerCase()) && e.size < 2 * 1024 * 1024)
    .flatMap(e => scanFile(e.abs).map(h => ({ ...h, rel: e.rel })));
}
