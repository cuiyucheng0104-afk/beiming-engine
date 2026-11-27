import Ajv2020 from 'ajv/dist/2020.js';
import fs from 'node:fs';
import { parseDocument } from 'yaml';
import { join } from 'node:path';
import { checks } from '../kernel/contracts/card-file/check.mjs';
import schema from '../kernel/contracts/card-file/schema/card.schema.json' with { type: 'json' };
import predicates from '../kernel/contracts/predicates/predicates.json' with { type: 'json' };
import source from '../kernel/contracts/source/source.json' with { type: 'json' };

import { scanCardLeaks } from './scan-card-leaks.mjs';

export { scanCardLeaks };

const defaultRegistries = { predicates, source };
const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });
const validateStructure = ajv.compile(schema);
const cardId = new RegExp(schema.properties.id.pattern);
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

// 私有文档的解析错误只报告格式，避免日志带出路径、行号或片段。
function parseOverlay(text, format) {
  let overlay;
  try {
    if (format === 'json') overlay = JSON.parse(text);
    else {
      const doc = parseDocument(text, { schema: 'failsafe', stringKeys: true, prettyErrors: false });
      if (doc.errors.length || doc.warnings.length) throw new SyntaxError();
      overlay = doc.toJS({ maxAliasCount: 0 });
    }
  } catch {
    throw new SyntaxError(`私有覆盖层必须是有效的 ${format.toUpperCase()}`);
  }
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) {
    throw new TypeError(`私有覆盖层必须是 ${format.toUpperCase()} 对象`);
  }
  return overlay;
}

/** 首选按卡名存放的 YAML，缺失时兼容旧 JSON。 */
export function mergeOverlay(cardObj, overlayDir) {
  const withoutTruth = { card: cardObj, hasTruth: false, skipParity: true };
  if (!overlayDir) return withoutTruth;
  if (!cardId.test(cardObj?.id)) throw new TypeError('覆盖层需要合法的卡名');

  let overlay;
  for (const format of ['yaml', 'json']) {
    let text;
    try {
      text = fs.readFileSync(join(overlayDir, `${cardObj.id}.${format}`), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      // eslint-disable-next-line preserve-caught-error -- 原始文件错误含私有绝对路径。
      throw new Error('私有覆盖层读取失败');
    }
    overlay = parseOverlay(text, format);
    break;
  }
  if (!overlay) return withoutTruth;

  const parity = copyOverlayFields(cardObj.verify?.parity, overlay.verify?.parity, ['truth']);
  const card = {
    ...cardObj,
    provenance: copyOverlayFields(cardObj.provenance, overlay.provenance, ['studied', 'lab']),
  };
  if (parity !== cardObj.verify?.parity) card.verify = { ...cardObj.verify, parity };
  if (overlay.ablation && cardObj.ablation) {
    card.ablation = cardObj.ablation.map((item, index) => copyOverlayFields(item,
      Array.isArray(overlay.ablation) ? overlay.ablation[index] : overlay.ablation, ['lab']));
  }
  if (Array.isArray(overlay.priors) && cardObj.priors) {
    card.priors = cardObj.priors.map((item, index) => copyOverlayFields(item, overlay.priors[index], ['source']));
  }
  const hasTruth = typeof parity?.truth === 'string' && parity.truth.trim().length > 0;
  return { card, hasTruth, skipParity: !hasTruth };
}

/** 为 node:test 对拍用例读取私有字段；真值的读取与比对由该卡的用例负责。 */
export async function runCardParity(t, cardObj, overlayDir, compare) {
  const { card, skipParity } = mergeOverlay(cardObj, overlayDir);
  if (skipParity) return t.skip('缺少该卡的实验室真值');
  await compare(card);
}
