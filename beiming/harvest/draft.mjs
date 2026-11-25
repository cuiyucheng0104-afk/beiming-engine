import { createHash } from 'node:crypto';
import { scanPriorLeaks } from '../cards/priors.mjs';
import { checkAssertion, checkExtra } from '../verify/predicates.mjs';

export const HARVEST_FORMAT = 'harvest-candidate/0.1';

const text = (value) => typeof value === 'string' && value.trim().length > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value) => Array.isArray(value) ? value : [];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const identifier = /^[A-Za-z_$][\w$]*$/;

// 只看词元，不加载片子的代码。保留字符串（包括里面的空白和注释标记）；Python 的 // 是整除。
function lex(source, python) {
  const strings = /"""(?:\\[\s\S]|(?!""")[\s\S])*"""|'''(?:\\[\s\S]|(?!''')[\s\S])*'''|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/;
  const comments = python ? /#[^\r\n]*/ : /\/\/[^\r\n]*|\/\*[\s\S]*?\*\//;
  const tokens = new RegExp(`${strings.source}|(${comments.source})|[A-Za-z_$][\\w$]*|(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?|\\S`, 'g');
  return Array.from(source.matchAll(tokens)).filter((match) => !match[1]).map(([token]) => token);
}

function signatureTokens(tokens, python) {
  const offset = tokens.findIndex((t, i) => t === (python ? 'def' : 'function') && identifier.test(tokens[i + 1] ?? '') && tokens[i + 2] === '(');
  if (offset < 0) return null;
  const groups = [];
  let start = offset + 3, depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (!depth && (t === ',' || t === ')')) {
      if (i !== start) groups.push(tokens.slice(start, i));
      if (t === ')') return { name: tokens[offset + 1], groups };
      start = i + 1;
    } else if (['(', '[', '{'].includes(t)) depth++;
    else if ([')', ']', '}'].includes(t)) depth--;
  }
  return null;
}

function literal(tokens) {
  const value = tokens.join('');
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value))) return Number(value);
  if (['true', 'True', 'false', 'False'].includes(value)) return value.toLowerCase() === 'true';
  if (/^'[^'\\]*'$/.test(value)) return value.slice(1, -1);
  try { return JSON.parse(value); } catch { return undefined; }
}

function extractParams(groups) {
  const found = new Map();
  for (const group of groups) {
    if (group[0] === '{') {
      // 把对象属性当作一组参数，复用平衡括号切分以保留属性默认值中的逗号。
      let end = 1, depth = 1;
      for (; end < group.length && depth; end++) {
        if (group[end] === '{') depth++;
        else if (group[end] === '}') depth--;
      }
      const properties = signatureTokens(['function', 'props', '(', ...group.slice(1, end - 1), ')'], false);
      if (properties) for (const [name, value] of extractParams(properties.groups)) found.set(name, value);
    } else {
      const start = group.findIndex((token) => token !== '*' && token !== '.');
      const name = group[start];
      if (!name || !identifier.test(name)) continue;
      const equal = group.indexOf('=');
      found.set(name, equal < 0 ? undefined : literal(group.slice(equal + 1)));
    }
  }
  return found;
}

const sourceOf = (mod) => mod.sourceCode ?? mod.code ?? mod.sourceText ?? (typeof mod.source === 'string' && /\s/.test(mod.source) ? mod.source : '');
function moduleInfo(mod) {
  const source = sourceOf(mod);
  const python = /^(?:py|python)$/i.test(mod.language) || /^\s*(?:async\s+)?def\s+\w+\s*\(/m.test(source);
  const tokens = typeof source === 'string' ? lex(source, python) : [];
  const signature = signatureTokens(tokens, python);
  const entrySignature = mod.entrySignature ?? mod.ext?.['harvest.entrySignature'] ?? signature?.name ?? mod.name;
  const extracted = extractParams(signature?.groups ?? []);
  const described = Array.isArray(mod.params)
    ? Object.fromEntries(mod.params.map((p) => [typeof p === 'string' ? p : p.name, typeof p === 'string' ? {} : p]))
    : mod.params ?? {};
  const names = [...new Set([...extracted.keys(), ...Object.keys(described), ...list(mod.paramNames)])].sort();
  const hash = tokens.length ? digest(tokens.join('')) : mod.contentHash;
  const hex = typeof hash === 'string' ? hash.replace(/^sha256:/, '').toLowerCase() : '';
  return { entrySignature, contentHash: /^[a-f0-9]{64}$/.test(hex) ? `sha256:${hex}` : null, names, python, extracted, described };
}

function checkShape(expr) {
  const { ok, assertion, bound } = checkAssertion(expr);
  if (!ok) throw new TypeError('候选检查的断言无效');
  const args = Object.keys(bound).sort().map((name) => {
    const value = bound[name];
    return [name, value.kind === 'number' ? { kind: 'number', unit: value.unit } : value];
  });
  return [assertion.name, args, assertion.cmp?.op ?? null];
}

/** 精确键用于存储。模块的近似匹配和规则的两个别名由 isSameThing 处理。 */
export function computeCandidateKey(candidate) {
  let parts;
  switch (candidate.kind) {
    case 'module': {
      const { contentHash, entrySignature, names } = moduleInfo(candidate);
      if (!contentHash && !text(entrySignature)) throw new TypeError('候选模块缺签名或内容哈希');
      parts = contentHash ? [contentHash] : [entrySignature, names];
      break;
    }
    case 'check': parts = checkShape(candidate.assertion); break;
    case 'prior':
      if (!text(candidate.cardId) || !text(candidate.paramName)) throw new TypeError('候选先验缺卡名或参数名');
      parts = [candidate.cardId, candidate.paramName];
      break;
    case 'pitfall':
      if (!text(candidate.errorCode) && !text(candidate.ruleId)) throw new TypeError('候选规则缺错误码或规则名');
      parts = [candidate.errorCode || candidate.ruleId];
      break;
    default: throw new TypeError('未知收获候选类别');
  }
  return JSON.stringify([candidate.kind, ...parts]);
}

function sameModule(left, right) {
  if (left.contentHash && left.contentHash === right.contentHash) return true;
  if (!text(left.entrySignature) || left.entrySignature !== right.entrySignature) return false;
  const other = new Set(right.names);
  return left.names.filter((name) => other.has(name)).length >= 0.8 * Math.max(left.names.length, right.names.length);
}

export function isSameThing(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'module') return sameModule(moduleInfo(a), moduleInfo(b));
  if (a.kind === 'pitfall') return (text(a.errorCode) && a.errorCode === b.errorCode) || (text(a.ruleId) && a.ruleId === b.ruleId);
  return computeCandidateKey(a) === computeCandidateKey(b);
}

function parameters(mod, info) {
  return Object.fromEntries(info.names.map((name) => {
    const spec = Object.hasOwn(info.described, name) ? info.described[name] : {};
    const fields = object(spec) ? spec : { default: spec };
    const value = mod.paramValues?.[name] ?? fields.default ?? info.extracted.get(name);
    const unit = fields.unit ?? mod.units?.[name];
    const confirmed = text(unit) && unit.trim() !== '待确认' && fields.unitUnconfirmed !== true;
    const inferred = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
    const param = { type: fields.type ?? inferred, unit: confirmed ? unit.trim() : '待确认', coupling: fields.coupling ?? 'none', unitUnconfirmed: !confirmed };
    if (value !== undefined) param.default = value;
    if (fields.range || Number.isFinite(value)) param.range = fields.range ?? [value, value];
    if (fields.space) param.space = fields.space;
    if (fields.schema) param.schema = fields.schema;
    return [name, param];
  }));
}

function cardFor(mod, info, params, input) {
  const kind = mod.cardKind ?? 'motion';
  const slug = info.entrySignature.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // 同名但参数集合不同的入口未必是同物；不能把两份不同草稿都注册成同一个卡名。
  const shapeId = digest(JSON.stringify([info.entrySignature, info.names])).slice(0, 10);
  const id = mod.cardId ?? `harvest.${/^[a-z]/.test(slug) ? slug : `module-${slug || 'entry'}`}-${shapeId}`;
  const landing = mod.livesIn ?? (info.python ? 'source:blender' : 'source:three');
  const root = `cards/${kind}/${id.split('.').at(-1)}`;
  const selftest = mod.selftest ?? `${root}/selftest.test.mjs`;
  const ext = { 'registry.candidate': true, 'harvest.entrySignature': info.entrySignature };
  const cardParams = Object.fromEntries(Object.entries(params).map(([name, param]) => {
    const spec = { ...param };
    delete spec.unitUnconfirmed;
    return [name, spec];
  }));
  return {
    format: 'card/0.1', id, version: '1.0.0', kind, title: mod.title ?? info.entrySignature,
    intent: mod.intent ?? `复用团队成片中的 ${info.entrySignature} 模块`, livesIn: [landing],
    impl: [{ livesIn: landing, entry: mod.entry ?? `${root}/${info.python ? 'module.py' : 'module.mjs'}`, shape: landing === 'data' ? 'evaluate' : 'create', hosts: [], selftest }],
    params: cardParams, ports: { in: [], out: [], order: { before: [], after: [] }, requires: [] },
    conditions: { appliesWhen: [], notWhen: [] }, calibration: mod.calibration ?? `cal:${id}`,
    verify: { selftest, predicates: [] }, exams: mod.exams ?? [`cal:${id}`],
    provenance: { cases: input.filmId ? [input.filmId] : [], note: '从团队片通过谓词的镜头起草' }, status: [], ext,
  };
}

async function draftModule(mod, input, options, out) {
  if (!object(mod) || mod.belongsToCard || (mod.shotPredicatesPassed ?? input.shotPredicatesPassed) !== true) return;
  const info = moduleInfo(mod);
  if (!text(info.entrySignature)) return out.reject('module', 'harvest.missing-signature');
  const params = parameters(mod, info);
  const candidate = { kind: 'module', entrySignature: info.entrySignature, contentHash: info.contentHash, params };
  const existing = list(options.existingCards ?? input.existingCards).find((card) => card && sameModule(info, moduleInfo(card)));
  if (existing) {
    candidate.mergeIntoCard = existing.id ?? existing.cardDraft?.id ?? existing.cardId;
    if (!text(candidate.mergeIntoCard)) return out.reject('module', 'harvest.missing-card-id');
  } else {
    candidate.cardDraft = cardFor(mod, info, params, input);
    if (scanPriorLeaks(candidate).length) return out.reject('module', 'harvest.private-content');
    if (options.runCalibration) {
      try {
        candidate.calibrationCheck = await options.runCalibration(globalThis.structuredClone(candidate), candidate.cardDraft.calibration, globalThis.structuredClone(mod));
        if (candidate.calibrationCheck === undefined) candidate.calibrationCheck = { ok: false, code: 'harvest.no-calibration-result' };
      } catch { candidate.calibrationCheck = { ok: false, code: 'harvest.calibration-failed' }; }
    } else candidate.calibrationCheck = { status: 'not-run' };
  }
  out.add(candidate);
}

function draftChecks(input, out) {
  for (const source of ['passedExtraPredicates', 'reviewSuggestedPredicates']) {
    for (const item of list(input[source])) {
      const assertion = typeof item === 'string' ? item : item?.assertion ?? item?.expr ?? item?.predicate;
      if (item?.passed === false || item?.accepted === false || (item?.status && item.status !== 'pass')) continue;
      const checked = checkExtra(assertion);
      if (!checked.ok) { out.reject('check', checked.errors[0].evidence); continue; }
      if (!text(input.filmType)) { out.reject('check', 'harvest.missing-film-type'); continue; }
      const targetTemplate = /^template:[a-z][a-z0-9-]*@[1-9]\d*$/.test(input.filmType) ? input.filmType : `template:${input.filmType}@1`;
      if (!/^template:[a-z][a-z0-9-]*@[1-9]\d*$/.test(targetTemplate)) { out.reject('check', 'harvest.invalid-film-type'); continue; }
      out.add({ kind: 'check', assertion: checked.assertion.text, targetTemplate, source });
    }
  }
}

// 接受标量、成组数值，或带单位的 { value, unit } 读数。设置值本身不能证明读回。
function hasMeasurement(readback) {
  if (Number.isFinite(readback)) return true;
  const values = Array.isArray(readback) ? readback : object(readback) ? Object.values(readback) : [];
  if (values.length && values.every(Number.isFinite)) return true;
  if (!object(readback) || !Object.hasOwn(readback, 'value')) return false;
  return Number.isFinite(readback.value) || (Array.isArray(readback.value) && readback.value.length > 0 && readback.value.every(Number.isFinite));
}

function draftPriors(input, out) {
  for (const row of list(input.cardParamReadbacks)) {
    const readback = row?.readback ?? row?.measurement ?? row?.measured;
    if (!object(row) || !text(row.cardId) || !text(row.paramName) || row.value === undefined || row.value === null
      || (typeof row.value === 'number' && !Number.isFinite(row.value)) || !hasMeasurement(readback)
      || row.verifiedInOurStack === false || row.readbackVerified === false) {
      out.reject('prior', 'harvest.missing-readback'); continue;
    }
    if (scanPriorLeaks(row).length) { out.reject('prior', 'harvest.private-content'); continue; }
    if (!text(row.unit) || row.unit.trim() === '待确认') { out.reject('prior', 'harvest.missing-unit'); continue; }
    const context = Object.fromEntries(['sceneScale', 'fps', 'viewTransform'].map((k) => [k, row[k] ?? row.context?.[k] ?? input[k] ?? input.context?.[k]]));
    if (!(text(context.sceneScale) || Number.isFinite(context.sceneScale) && context.sceneScale > 0)
        || !(Number.isFinite(context.fps) && context.fps > 0 || typeof context.fps === 'string' && /^(?:[1-9]\d*(?:\/[1-9]\d*|\.\d+)?|0\.\d*[1-9]\d*)$/.test(context.fps)) || !text(context.viewTransform)) {
      out.reject('prior', 'harvest.missing-context'); continue;
    }
    const { cardId, paramName, value, unit } = row;
    out.add({ kind: 'prior', cardId, paramName, value, unit, readback, ...context, verifiedInOurStack: true });
  }
}

const pitfalls = new Map([
  ['color-tag-mismatch', { category: /色彩标签|颜色标签|colou?r[- ]tag/i, checkTarget: 'output.colorTag', fixHint: '核对交付色彩标签与成片读回标签。' }],
  ['aac-true-peak-bounce', { category: /aac.*(?:峰值|peak)/i, checkTarget: 'audio.truePeakDbtp', fixHint: '预留 AAC 编码余量，重新编码后读回真峰值。' }],
]);
function draftPitfalls(input, minOccurrences, out) {
  if (!Number.isSafeInteger(minOccurrences) || minOccurrences < 1) throw new RangeError('minOccurrences 须为正整数');
  const groups = new Map();
  for (const item of list(input.reworkRecords)) {
    const raw = item?.code ?? item?.category ?? item?.issue;
    if (!text(raw)) { out.reject('pitfall', 'harvest.missing-error-code'); continue; }
    const normalized = raw.normalize('NFKC').trim().toLowerCase().replace(/[\s_]+/g, '-');
    const code = text(item.code) ? normalized : [...pitfalls].find(([, spec]) => spec.category.test(normalized))?.[0] ?? normalized;
    const group = groups.get(code) ?? { kind: 'pitfall', level: 'L1', errorCode: code, ruleId: item.ruleId ?? `l1.${code}`,
      checkTarget: item.checkTarget ?? pitfalls.get(code)?.checkTarget ?? code, occurrences: 0,
      fixHint: item.fixHint ?? pitfalls.get(code)?.fixHint ?? '核对该类返修记录并重跑对应检查。', sampleFilms: [] };
    group.occurrences++;
    const film = item.filmId ?? input.filmId;
    if (text(film) && !group.sampleFilms.includes(film)) group.sampleFilms.push(film);
    groups.set(code, group);
  }
  for (const group of groups.values()) if (group.occurrences >= minOccurrences) out.add(group);
}

/** deliver 的收获入口。回调可为异步渲染器，只有通过准入和查重的新模块会试跑。 */
export async function draftHarvestCandidates(input, options = {}) {
  const result = { format: HARVEST_FORMAT, candidates: [], rejected: [], skippedReason: null };
  if (input?.scope !== 'team') result.skippedReason = 'harvest.team-only';
  else if (input.rendered !== true) result.skippedReason = 'harvest.not-rendered';
  else if (input.readbackVerified !== true) result.skippedReason = 'harvest.unverified-readback';
  else if (input.basePredicatesPassed !== true) result.skippedReason = 'harvest.base-predicates-failed';
  if (result.skippedReason) return result;
  const out = {
    reject(kind, code) { result.rejected.push({ kind, code }); },
    add(fields) {
      const candidate = { format: HARVEST_FORMAT, authorSessionId: input.authorSessionId ?? null, ...fields };
      if (scanPriorLeaks(candidate).length) this.reject(fields.kind, 'harvest.private-content');
      else result.candidates.push(globalThis.structuredClone(candidate));
    },
  };
  if (input.mode !== 'cards-data') {
    const modules = input.nativeModules ?? (input.mode === 'native-code' ? (input.modules ?? (sourceOf(input) ? [input] : [])) : []);
    for (const mod of list(modules)) await draftModule(mod, input, options, out);
  }
  draftChecks(input, out);
  draftPriors(input, out);
  draftPitfalls(input, options.minOccurrences ?? input.minOccurrences ?? 2, out);
  return result;
}
