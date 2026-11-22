// 结构化先验表（priors/0.1）：每条参考值必须带单位、适用条件、脱敏出处与「是否在我方读回」标记。
// 结果只回类型码与位置，不回显输入内容；检索结果一律返回深冻结只读视图。

import { types } from 'node:util';

export const PRIORS_FORMAT = 'priors/0.1';

export const PRIOR_DOMAINS = Object.freeze([
  'camera-lens-motion',
  'lighting-exposure',
  'material-shading',
  'color-grade-delivery',
  'time-rhythm-editing',
  'geometry-layout-scale',
  'render-sampling-denoise',
  'fx-particles-ui-2d',
  'audio-music-voice-subs',
]);

export const PRIOR_UNITS = Object.freeze([
  'ratio', 'count', 'm', 'mm', 'px', 'deg', 'rad', 'deg/s', 'rad/s', 'm/s', 'm/s^2',
  's', 'ms', 'frame', 'fps', 'Hz', 'LUFS', 'LU', 'dB', 'dBTP', 'stop', 'nit', 'K', 'spp',
  'rgb-linear', 'rgb-display',
]);

export const PRIOR_EVIDENCE_LEVELS = Object.freeze(['实测', '源码', '文档', '推断']);

const COLOR_SPACE_RULES = Object.freeze({
  __proto__: null,
  'rgb-linear': Object.freeze(['scene-linear-rec709']),
  'rgb-display': Object.freeze(['srgb-display']),
});

/** 颜色单位 → 允许的色彩空间（只读快照，校验内部读私有冻结表，不受外部篡改影响）。 */
const readonlyColorMap = new Map([
  ['rgb-linear', COLOR_SPACE_RULES['rgb-linear']],
  ['rgb-display', COLOR_SPACE_RULES['rgb-display']],
]);
const rejectMapMutation = () => {
  throw new TypeError('PRIOR_COLOR_SPACES 是只读映射');
};
readonlyColorMap.set = rejectMapMutation;
readonlyColorMap.delete = rejectMapMutation;
readonlyColorMap.clear = rejectMapMutation;
export const PRIOR_COLOR_SPACES = Object.freeze(readonlyColorMap);

const ID = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;
const ENV_KEY = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const EXT_KEY = /^[a-z][a-z0-9-]*\.[A-Za-z0-9_.-]+$/; // CONVENTIONS.md 第 5 节「未知字段」
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SCHEMA_KEYS = new Set([
  'format', 'entries', 'id', 'domain', 'topic', 'title', 'value', 'unit', 'colorSpace',
  'conditions', 'appliesWhen', 'notWhen', 'scale', 'fps', 'viewTransform',
  'provenance', 'caseId', 'evidenceLevel', 'docRef', 'note',
  'verifiedInOurStack', 'readbackEvidence', 'envKey', 'reportSha256',
  'conflicts', 'reason', 'summaryOf', 'ext',
]);

const CANONICAL_SHA = /sha256:[0-9a-f]{64}(?![0-9A-Fa-f])/g;
const INVISIBLE = /[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g;
const HTTP_URLS = /\bhttps?:\/\/[^\s"'<>)]+/gi;
const PRIVATE_SOURCE_RE = /原包源码|cards-overlay|exams-hidden|(?:复刻|调研资料|北冥引擎规划|实验室)(?:[\\/]|$)/i;
const LOCAL_PATH_RE = /file:\/\/\/|^\s*~\s*$|(?<=^|[\s"'=:(.])~(?=[\\/]|$|[\s"'),;}])|(?<![a-z0-9])[a-z]:[\\/]|(?:^|[\s"'=:(.])\/(?:Users|home|tmp|var|private|etc|opt|Volumes|mnt|root|usr|proc|dev)(?:[\\/]|$)/i;
const BARE_SHA_RE = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i;

// 只放行原文里的规范小写 sha256:；全角、零宽、大写变体归一后照拦。公开 http(s) 路由里的 /home/ 等不误判为本机路径。
function leakCodes(raw) {
  const text = raw.replace(CANONICAL_SHA, 'sha256:ok').normalize('NFKC').replace(INVISIBLE, '');
  const noHttp = text.replace(HTTP_URLS, ' ');
  const found = [];
  if (/lab:\/\//i.test(text)) found.push('lab-url');
  if (PRIVATE_SOURCE_RE.test(text)) found.push('private-source-path');
  if (LOCAL_PATH_RE.test(noHttp)) found.push('local-path');
  if (BARE_SHA_RE.test(text)) found.push('bare-sha256');
  return found;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const isStr = (v, re) => typeof v === 'string' && re.test(v);

function dedupeErrors(list) {
  const seen = new Set();
  return list.filter((item) => {
    const key = `${item.code}@${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(value[key]);
  }
  return value;
}

/** 一次遍历查纯 JSON、保留键、稀疏/附加数组键与泄露；访问器只看描述符不调用；Proxy（含已撤销）直接拒收不触发陷阱。 */
function inspect(root) {
  const errors = [];
  const leaks = [];
  const active = new WeakSet();
  const nonJson = (path) => errors.push({ code: 'prior.non-json', path: path || '/' });

  function text(value, path, field) {
    if (!value.isWellFormed()) nonJson(path);
    for (const code of leakCodes(value)) leaks.push({ code, path: path || '/', ...(field ? { field } : {}) });
  }

  function visit(value, path) {
    if (typeof value === 'string') return text(value, path);
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) nonJson(path);
      return;
    }
    if (typeof value !== 'object' || active.has(value) || types.isProxy(value)) return nonJson(path);
    const isArray = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    // 数组子类能改写 every、includes 骗过后面的校验，只收原生数组与普通对象。
    if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return nonJson(path);
    active.add(value);
    const keys = Reflect.ownKeys(value).filter((key) => !(isArray && key === 'length'));
    let validIndexCount = 0;
    for (const key of keys) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !desc.enumerable || !Object.hasOwn(desc, 'value')) {
        nonJson(path);
        continue;
      }
      if (isArray) {
        const canonical = ARRAY_INDEX.test(key) && Number(key) < value.length;
        if (canonical) {
          validIndexCount += 1;
          visit(desc.value, `${path}/${key}`);
        } else {
          nonJson(path);
          text(key, path, 'key');
          visit(desc.value, `${path}/[key]`);
        }
      } else {
        if (RESERVED_KEYS.has(key)) nonJson(`${path}/[key]`);
        text(key, path, 'key');
        visit(desc.value, `${path}/${SCHEMA_KEYS.has(key) ? key : '[key]'}`);
      }
    }
    if (isArray && validIndexCount !== value.length) nonJson(path);
    active.delete(value);
  }

  try {
    visit(root, '');
  } catch {
    nonJson(''); // 例如极端嵌套过深；不带出异常内容
  }
  return { errors: dedupeErrors(errors), leaks };
}

/** 对已确认语法合法的 JSON 原文检查同名重复键、保留键与字面超安全整数。 */
function checkJsonStructure(raw) {
  const errors = [];
  let i = 0;
  const ws = () => {
    while (i < raw.length && (raw[i] === ' ' || raw[i] === '\n' || raw[i] === '\r' || raw[i] === '\t')) i += 1;
  };
  function readString() {
    const start = i;
    i += 1;
    while (i < raw.length) {
      if (raw[i] === '\\') i += 2;
      else if (raw[i] === '"') {
        i += 1;
        return JSON.parse(raw.slice(start, i));
      } else i += 1;
    }
    return '';
  }
  function readValue(path) {
    ws();
    const ch = raw[i];
    if (ch === '{') {
      i += 1;
      ws();
      if (raw[i] === '}') { i += 1; return; }
      const seen = new Set();
      while (i < raw.length) {
        ws();
        const key = readString();
        if (seen.has(key)) errors.push({ code: 'prior.duplicate-key', path: path || '/' });
        seen.add(key);
        if (RESERVED_KEYS.has(key)) errors.push({ code: 'prior.non-json', path: `${path}/[key]` });
        const childPath = `${path}/${SCHEMA_KEYS.has(key) ? key : '[key]'}`;
        ws();
        i += 1; // ':'
        readValue(childPath);
        ws();
        if (raw[i] === ',') { i += 1; continue; }
        if (raw[i] === '}') { i += 1; break; }
      }
      return;
    }
    if (ch === '[') {
      i += 1;
      ws();
      if (raw[i] === ']') { i += 1; return; }
      let index = 0;
      while (i < raw.length) {
        readValue(`${path}/${index}`);
        index += 1;
        ws();
        if (raw[i] === ',') { i += 1; continue; }
        if (raw[i] === ']') { i += 1; break; }
      }
      return;
    }
    if (ch === '"') { readString(); return; }
    const start = i;
    while (i < raw.length && !' \t\r\n,]}'.includes(raw[i])) i += 1;
    const atom = raw.slice(start, i);
    if (/^-?[0-9]+$/.test(atom) && !Number.isSafeInteger(Number(atom))) {
      errors.push({ code: 'prior.non-json', path: path || '/' });
    }
  }
  readValue('');
  return errors;
}

/**
 * 泄露扫描。对象回 `{ code, path }`；文本按行回 `{ code, line }`
 *（CR、LF、CRLF 都算换行；按原文扫，重复键里被覆盖的内容也查得到）。
 */
export function scanPriorLeaks(input) {
  if (typeof input !== 'string') return inspect(input).leaks;
  return input.split(/\r\n|\r|\n/).flatMap((line, index) => {
    const decoded = line
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\([\\/])/g, '$1');
    return leakCodes(decoded).map((code) => ({ code, line: index + 1 }));
  });
}

function checker(errors) {
  const bad = (code, path) => errors.push({ code, path });
  const only = (obj, allowed, path) => {
    if (Object.keys(obj).some((key) => !allowed.includes(key))) bad('prior.unknown-key', path || '/');
  };
  const optText = (obj, key, path) => {
    if (Object.hasOwn(obj, key) && !isText(obj[key])) bad('prior.bad-value', `${path}/${key}`);
  };

  function value(v, path) {
    const nums = Array.isArray(v) ? v : isObj(v) ? Object.values(v) : [v];
    const ok = nums.length > 0 && nums.every((n) => typeof n === 'number')
      && !(Array.isArray(v) && v.length === 2 && v[0] > v[1]); // 两元数组是区间 [min, max]
    if (!ok) bad('prior.bad-value', path);
  }

  // 条目与冲突项共用：单位必填且在词表内，颜色单位必须带匹配的色彩空间。
  function unitOf(obj, path) {
    if (!Object.hasOwn(obj, 'unit') || obj.unit === '') bad('prior.missing-unit', `${path}/unit`);
    else if (typeof obj.unit !== 'string' || !PRIOR_UNITS.includes(obj.unit)) bad('prior.unknown-unit', `${path}/unit`);
    const spaces = typeof obj.unit === 'string' ? COLOR_SPACE_RULES[obj.unit] : undefined;
    if (spaces) {
      if (typeof obj.colorSpace !== 'string' || !spaces.includes(obj.colorSpace)) bad('prior.color-space', `${path}/colorSpace`);
      if (!Array.isArray(obj.value) || ![3, 4].includes(obj.value.length)) bad('prior.bad-value', `${path}/value`);
    } else if (Object.hasOwn(obj, 'colorSpace')) bad('prior.color-space', `${path}/colorSpace`);
  }

  function entry(e, path) {
    if (!isObj(e)) return bad('prior.bad-value', path || '/');
    only(e, ['id', 'domain', 'topic', 'title', 'value', 'unit', 'colorSpace', 'conditions', 'provenance',
      'verifiedInOurStack', 'readbackEvidence', 'conflicts', 'summaryOf', 'ext'], path);
    if (!isStr(e.id, ID)) bad('prior.bad-value', `${path}/id`);
    if (typeof e.domain !== 'string' || !PRIOR_DOMAINS.includes(e.domain)) bad('prior.bad-value', `${path}/domain`);
    if (!isStr(e.topic, ID)) bad('prior.bad-value', `${path}/topic`);
    if (!isText(e.title)) bad('prior.bad-value', `${path}/title`);
    value(e.value, `${path}/value`);
    unitOf(e, path);

    const c = e.conditions;
    if (!isObj(c)) bad('prior.missing-conditions', `${path}/conditions`);
    else {
      only(c, ['appliesWhen', 'notWhen', 'scale', 'fps', 'viewTransform'], `${path}/conditions`);
      if (!Array.isArray(c.appliesWhen) || !c.appliesWhen.length || !c.appliesWhen.every(isText)) {
        bad('prior.missing-conditions', `${path}/conditions/appliesWhen`);
      }
      if (Object.hasOwn(c, 'notWhen') && !(Array.isArray(c.notWhen) && c.notWhen.every(isText))) {
        bad('prior.bad-value', `${path}/conditions/notWhen`);
      }
      for (const key of ['scale', 'fps', 'viewTransform']) optText(c, key, `${path}/conditions`);
    }

    const p = e.provenance;
    if (!isObj(p)) bad('prior.bad-value', `${path}/provenance`);
    else {
      only(p, ['caseId', 'evidenceLevel', 'docRef', 'note'], `${path}/provenance`);
      if (!isText(p.caseId)) bad('prior.bad-value', `${path}/provenance/caseId`);
      if (typeof p.evidenceLevel !== 'string' || !PRIOR_EVIDENCE_LEVELS.includes(p.evidenceLevel)) bad('prior.bad-value', `${path}/provenance/evidenceLevel`);
      optText(p, 'docRef', `${path}/provenance`);
      optText(p, 'note', `${path}/provenance`);
    }

    const r = e.readbackEvidence;
    if (typeof e.verifiedInOurStack !== 'boolean') bad('prior.bad-value', `${path}/verifiedInOurStack`);
    else if (!e.verifiedInOurStack) {
      if (Object.hasOwn(e, 'readbackEvidence')) bad('prior.readback', `${path}/readbackEvidence`);
    } else if (!isObj(r)) bad('prior.readback', `${path}/readbackEvidence`);
    else {
      only(r, ['envKey', 'reportSha256'], `${path}/readbackEvidence`);
      if (!isStr(r.envKey, ENV_KEY)) bad('prior.readback', `${path}/readbackEvidence/envKey`);
      if (!isStr(r.reportSha256, SHA256)) bad('prior.readback', `${path}/readbackEvidence/reportSha256`);
    }

    if (Object.hasOwn(e, 'conflicts')) {
      if (!Array.isArray(e.conflicts)) bad('prior.bad-value', `${path}/conflicts`);
      else e.conflicts.forEach((item, index) => {
        const at = `${path}/conflicts/${index}`;
        if (!isObj(item)) return bad('prior.bad-value', at);
        only(item, ['caseId', 'value', 'unit', 'colorSpace', 'evidenceLevel', 'reason'], at);
        if (!isText(item.caseId)) bad('prior.bad-value', `${at}/caseId`);
        value(item.value, `${at}/value`);
        unitOf(item, at);
        if (typeof item.evidenceLevel !== 'string' || !PRIOR_EVIDENCE_LEVELS.includes(item.evidenceLevel)) bad('prior.bad-value', `${at}/evidenceLevel`);
        if (!isText(item.reason)) bad('prior.bad-value', `${at}/reason`);
      });
    }

    if (Object.hasOwn(e, 'summaryOf')) {
      const s = e.summaryOf;
      const ok = Array.isArray(s) && s.length > 0 && s.every((id) => isStr(id, ID)) && new Set(s).size === s.length;
      if (!ok) bad('prior.bad-value', `${path}/summaryOf`);
      else if (typeof e.id === 'string' && s.includes(e.id)) bad('prior.self-summary', `${path}/summaryOf`);
    }

    if (Object.hasOwn(e, 'ext') && !(isObj(e.ext) && Object.keys(e.ext).every((key) => EXT_KEY.test(key)))) {
      bad('prior.unknown-key', `${path}/ext`);
    }
  }

  return { bad, only, entry };
}

const done = (errors, leaks) => {
  const uniqueErrors = dedupeErrors(errors);
  return { ok: uniqueErrors.length === 0 && leaks.length === 0, errors: uniqueErrors, leaks };
};

/** 校验单条先验。回 `{ ok, errors: [{ code, path }], leaks: [{ code, path }] }`。 */
export function validatePriorEntry(input) {
  const { errors, leaks } = inspect(input);
  if (!errors.length) checker(errors).entry(input, '');
  return done(errors, leaks);
}

/** 校验整张表（对象或 JSON 文本）：逐条校验，再查 id 唯一、同子题同案例不重复、汇总行指向真实明细。 */
export function validatePriorsTable(input) {
  let table = input;
  let textLeaks = [];
  let structErrors = [];
  if (typeof input === 'string') {
    textLeaks = scanPriorLeaks(input);
    try {
      table = JSON.parse(input);
    } catch {
      return done([{ code: 'prior.bad-json', path: '/' }], textLeaks);
    }
    structErrors = checkJsonStructure(input);
  }
  const { errors, leaks } = inspect(table);
  errors.unshift(...structErrors);
  leaks.unshift(...textLeaks);
  if (errors.length) return done(errors, leaks);

  const { bad, only, entry } = checker(errors);
  if (!isObj(table)) return done([{ code: 'prior.bad-value', path: '/' }], leaks);
  only(table, ['format', 'entries'], '');
  if (table.format !== PRIORS_FORMAT) bad('prior.bad-value', '/format');
  if (!Array.isArray(table.entries)) {
    bad('prior.bad-value', '/entries');
    return done(errors, leaks);
  }

  const byId = new Map();
  const cases = new Set();
  table.entries.forEach((e, index) => {
    const path = `/entries/${index}`;
    entry(e, path);
    if (!isObj(e)) return;
    if (isStr(e.id, ID)) {
      if (byId.has(e.id)) bad('prior.duplicate-id', `${path}/id`);
      else byId.set(e.id, e);
    }
    // 同一子题每个案例一条、不取平均；适用条件不同才算另一条。汇总行不参与。
    if (!Object.hasOwn(e, 'summaryOf') && isStr(e.topic, ID) && isObj(e.provenance) && isText(e.provenance.caseId)
      && Array.isArray(e.conditions?.appliesWhen) && e.conditions.appliesWhen.length > 0 && e.conditions.appliesWhen.every(isText)) {
      const key = JSON.stringify([e.topic, e.provenance.caseId, [...e.conditions.appliesWhen].sort()]);
      if (cases.has(key)) bad('prior.duplicate-case', path);
      cases.add(key);
    }
  });
  table.entries.forEach((e, index) => {
    if (!isObj(e) || !Array.isArray(e.summaryOf) || !e.summaryOf.every((id) => isStr(id, ID))) return;
    e.summaryOf.forEach((id, at) => {
      const target = byId.get(id);
      if (!target) bad('prior.dangling-summary', `/entries/${index}/summaryOf/${at}`);
      else if (Object.hasOwn(target, 'summaryOf')) bad('prior.nested-summary', `/entries/${index}/summaryOf/${at}`);
    });
  });
  return done(errors, leaks);
}

/** 检索库。先过整表校验，不过抛 TypeError（只带类型码与位置）。返回视图全部深冻结只读。 */
export function createPriorsStore(tableOrEntries) {
  const isRawArray = !types.isProxy(tableOrEntries) && Array.isArray(tableOrEntries);
  const table = isRawArray ? { format: PRIORS_FORMAT, entries: tableOrEntries } : tableOrEntries;
  const checked = validatePriorsTable(table);
  if (!checked.ok) {
    const where = [...checked.errors, ...checked.leaks].slice(0, 8).map((x) => `${x.code}@${x.path ?? `L${x.line}`}`);
    throw new TypeError(`先验表未过校验：${where.join('，')}`);
  }
  const entries = structuredClone((typeof table === 'string' ? JSON.parse(table) : table).entries);
  const isSummary = (e) => Object.hasOwn(e, 'summaryOf');
  const view = (e) => deepFreeze({ ...structuredClone(e), readbackLabel: e.verifiedInOurStack ? '已在我方读回' : '未在我方读回' });

  return Object.freeze({
    get(id) {
      if (typeof id !== 'string') return undefined;
      const found = entries.find((e) => e.id === id);
      return found ? view(found) : undefined;
    },
    query({ domain, topic, unit, caseId, onlyVerified = false, includeSummaries = false, limit = Infinity, ...rest } = {}) {
      // 写错的条件名不能静默放大结果（例如把 onlyVerified 拼错后拿到未读回的值）。
      if (Object.keys(rest).length || typeof onlyVerified !== 'boolean' || typeof includeSummaries !== 'boolean'
        || (limit !== Infinity && !(Number.isSafeInteger(limit) && limit > 0))) {
        throw new TypeError('检索条件无效');
      }
      return Object.freeze(entries.filter((e) => (includeSummaries || !isSummary(e))
        && (!onlyVerified || e.verifiedInOurStack)
        && (domain === undefined || e.domain === domain)
        && (topic === undefined || e.topic === topic)
        && (unit === undefined || e.unit === unit)
        && (caseId === undefined || e.provenance.caseId === caseId)).slice(0, limit).map(view));
    },
    stats() {
      const details = entries.filter((e) => !isSummary(e));
      const verifiedCount = details.filter((e) => e.verifiedInOurStack).length;
      return Object.freeze({
        totalEntries: entries.length,
        detailCount: details.length,
        summaryCount: entries.length - details.length,
        verifiedCount,
        unverifiedCount: details.length - verifiedCount,
        conflictCount: details.reduce((sum, e) => sum + (e.conflicts?.length ?? 0), 0),
      });
    },
  });
}
