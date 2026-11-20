import Ajv2020 from 'ajv/dist/2020.js';
import fs from 'node:fs';
import { join } from 'node:path';
import { checks } from '../kernel/contracts/card-file/check.mjs';
import schema from '../kernel/contracts/card-file/schema/card.schema.json' with { type: 'json' };
import predicates from '../kernel/contracts/predicates/predicates.json' with { type: 'json' };
import source from '../kernel/contracts/source/source.json' with { type: 'json' };

const defaultRegistries = { predicates, source };
const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });
const validateStructure = ajv.compile(schema);
const cardId = new RegExp(schema.properties.id.pattern);
const parityReport = new RegExp(schema.properties.status.items.properties.parityReport.pattern);
const leakPatterns = [
  ['lab-url', /lab:\/\//i],
  ['private-source-path', /原包源码|cards-overlay/i],
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

/** 公开卡先过泄露门禁，再查结构和 CF 不变量。 */
export function validateCard(cardObj, { registries = defaultRegistries } = {}) {
  const leaks = scanCardLeaks(cardObj);
  const result = { ok: false, schemaErrors: [], violations: {}, leaks };
  if (leaks.length) return result;
  if (!validateStructure(cardObj)) {
    result.schemaErrors = validateStructure.errors.map(({ instancePath, message }) => `${instancePath || '/'} ${message}`);
    return result;
  }

  for (const [id, check] of Object.entries(checks)) {
    const problems = check(cardObj, { registries, schema: null });
    if (problems.length) result.violations[id] = problems;
  }
  result.ok = Object.keys(result.violations).length === 0;
  return result;
}

function copyOverlayFields(base, overlay, keys) {
  if (!overlay || typeof overlay !== 'object') return base;
  const fields = keys.filter((key) => Object.hasOwn(overlay, key));
  if (!fields.length) return base;
  return { ...base, ...Object.fromEntries(fields.map((key) => [key, overlay[key]])) };
}

/** 从目录读取按卡名存放的 JSON，只合并 CF 3.7 的私有字段。 */
export function mergeOverlay(cardObj, overlayDir) {
  const withoutTruth = { card: cardObj, hasTruth: false, skipParity: true };
  if (!overlayDir) return withoutTruth;
  if (!cardId.test(cardObj?.id)) throw new TypeError('覆盖层需要合法的卡名');

  let text;
  try {
    text = fs.readFileSync(join(overlayDir, `${cardObj.id}.json`), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return withoutTruth;
    throw error;
  }

  let overlay;
  try {
    overlay = JSON.parse(text);
  } catch {
    throw new SyntaxError('私有覆盖层必须是有效的 JSON');
  }
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) {
    throw new TypeError('私有覆盖层必须是 JSON 对象');
  }

  const parity = copyOverlayFields(cardObj.verify?.parity, overlay.verify?.parity, ['truth']);
  const card = {
    ...cardObj,
    provenance: copyOverlayFields(cardObj.provenance, overlay.provenance, ['studied', 'lab']),
  };
  if (parity !== cardObj.verify?.parity) card.verify = { ...cardObj.verify, parity };
  if (Array.isArray(overlay.ablation) && cardObj.ablation) {
    card.ablation = cardObj.ablation.map((item, index) => copyOverlayFields(item, overlay.ablation[index], ['lab']));
  }
  if (Array.isArray(overlay.priors) && cardObj.priors) {
    card.priors = cardObj.priors.map((item, index) => copyOverlayFields(item, overlay.priors[index], ['source']));
  }
  const hasTruth = typeof parity?.truth === 'string' && parity.truth.trim().length > 0;
  return { card, hasTruth, skipParity: !hasTruth };
}
