// 结构化先验表（priors/0.1）：每条参考值必须带单位、适用条件、脱敏出处与「是否在我方读回」标记。
// 结果只回类型码与位置，不回显输入内容。

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

/** 颜色单位 → 允许的色彩空间。线性值与显示值不能混填。 */
export const PRIOR_COLOR_SPACES = new Map([
  ['rgb-linear', ['scene-linear-rec709']],
  ['rgb-display', ['srgb-display']],
]);

const ID = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;
const ENV_KEY = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const EXT_KEY = /^[a-z][a-z0-9-]*\.[A-Za-z0-9_.-]+$/; // CONVENTIONS.md 第 5 节「未知字段」
const PATH_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

const CANONICAL_SHA = /sha256:[0-9a-f]{64}(?![0-9A-Fa-f])/g;
const INVISIBLE = /[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g;
const LEAKS = [
  ['lab-url', /lab:\/\//i],
  ['private-source-path', /原包源码|cards-overlay|exams-hidden|复刻[\\/]/i],
  ['local-path', /\/(?:Users|home)\/|(?<![a-z0-9])[a-z]:[\\/]/i],
  ['bare-sha256', /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i],
];

// 只放行原文里的规范小写 sha256:；全角、零宽、大写变体归一后照拦。
function leakCodes(raw) {
  const text = raw.replace(CANONICAL_SHA, 'sha256:ok').normalize('NFKC').replace(INVISIBLE, '');
  return LEAKS.filter(([, pattern]) => pattern.test(text)).map(([code]) => code);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

/** 一次遍历查纯 JSON 与泄露；访问器属性只看描述符，不调用；Proxy 直接拒收，不触发陷阱。 */
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
    if (isArray && keys.length !== value.length) nonJson(path); // 空洞或额外属性
    for (const key of keys) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !desc.enumerable || !Object.hasOwn(desc, 'value')) {
        nonJson(path);
        continue;
      }
      if (!isArray) text(key, path, 'key');
      visit(desc.value, `${path}/${isArray || PATH_KEY.test(key) ? key : '[key]'}`);
    }
    active.delete(value);
  }

  try {
    visit(root, '');
  } catch {
    nonJson(''); // 例如嵌套过深；不带出异常内容
  }
  return { errors, leaks };
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
    else if (!PRIOR_UNITS.includes(obj.unit)) bad('prior.unknown-unit', `${path}/unit`);
    const spaces = PRIOR_COLOR_SPACES.get(obj.unit);
    if (spaces) {
      if (!spaces.includes(obj.colorSpace)) bad('prior.color-space', `${path}/colorSpace`);
      if (!Array.isArray(obj.value) || ![3, 4].includes(obj.value.length)) bad('prior.bad-value', `${path}/value`);
    } else if (Object.hasOwn(obj, 'colorSpace')) bad('prior.color-space', `${path}/colorSpace`);
  }

  function entry(e, path) {
    if (!isObj(e)) return bad('prior.bad-value', path || '/');
    only(e, ['id', 'domain', 'topic', 'title', 'value', 'unit', 'colorSpace', 'conditions', 'provenance',
      'verifiedInOurStack', 'readbackEvidence', 'conflicts', 'summaryOf', 'ext'], path);
    if (!ID.test(e.id)) bad('prior.bad-value', `${path}/id`);
    if (!PRIOR_DOMAINS.includes(e.domain)) bad('prior.bad-value', `${path}/domain`);
    if (!ID.test(e.topic)) bad('prior.bad-value', `${path}/topic`);
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
      if (!PRIOR_EVIDENCE_LEVELS.includes(p.evidenceLevel)) bad('prior.bad-value', `${path}/provenance/evidenceLevel`);
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
      if (!ENV_KEY.test(r.envKey)) bad('prior.readback', `${path}/readbackEvidence/envKey`);
      if (!SHA256.test(r.reportSha256)) bad('prior.readback', `${path}/readbackEvidence/reportSha256`);
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
        if (!PRIOR_EVIDENCE_LEVELS.includes(item.evidenceLevel)) bad('prior.bad-value', `${at}/evidenceLevel`);
        if (!isText(item.reason)) bad('prior.bad-value', `${at}/reason`);
      });
    }

    if (Object.hasOwn(e, 'summaryOf')) {
      const s = e.summaryOf;
      const ok = Array.isArray(s) && s.length > 0 && s.every((id) => ID.test(id)) && new Set(s).size === s.length;
      if (!ok) bad('prior.bad-value', `${path}/summaryOf`);
      else if (s.includes(e.id)) bad('prior.self-summary', `${path}/summaryOf`);
    }

    if (Object.hasOwn(e, 'ext') && !(isObj(e.ext) && Object.keys(e.ext).every((key) => EXT_KEY.test(key)))) {
      bad('prior.unknown-key', `${path}/ext`);
    }
  }

  return { bad, only, entry };
}

const done = (errors, leaks) => ({ ok: errors.length === 0 && leaks.length === 0, errors, leaks });

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
  if (typeof input === 'string') {
    textLeaks = scanPriorLeaks(input);
    try {
      table = JSON.parse(input);
    } catch {
      return done([{ code: 'prior.bad-json', path: '/' }], textLeaks);
    }
  }
  const { errors, leaks } = inspect(table);
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
    if (typeof e.id === 'string') {
      if (byId.has(e.id)) bad('prior.duplicate-id', `${path}/id`);
      else byId.set(e.id, e);
    }
    // 同一子题每个案例一条、不取平均；适用条件不同才算另一条。汇总行不参与。
    if (!Object.hasOwn(e, 'summaryOf') && isObj(e.provenance) && Array.isArray(e.conditions?.appliesWhen)) {
      const key = JSON.stringify([e.topic, e.provenance.caseId, [...e.conditions.appliesWhen].sort()]);
      if (cases.has(key)) bad('prior.duplicate-case', path);
      cases.add(key);
    }
  });
  table.entries.forEach((e, index) => {
    if (!isObj(e) || !Array.isArray(e.summaryOf)) return;
    e.summaryOf.forEach((id, at) => {
      const target = byId.get(id);
      if (!target) bad('prior.dangling-summary', `/entries/${index}/summaryOf/${at}`);
      else if (Object.hasOwn(target, 'summaryOf')) bad('prior.nested-summary', `/entries/${index}/summaryOf/${at}`);
    });
  });
  return done(errors, leaks);
}

/** 检索库。先过整表校验，不过抛 TypeError（只带类型码与位置）。返回值都是深拷贝。 */
export function createPriorsStore(tableOrEntries) {
  const table = Array.isArray(tableOrEntries) ? { format: PRIORS_FORMAT, entries: tableOrEntries } : tableOrEntries;
  const checked = validatePriorsTable(table);
  if (!checked.ok) {
    const where = [...checked.errors, ...checked.leaks].slice(0, 8).map((x) => `${x.code}@${x.path ?? `L${x.line}`}`);
    throw new TypeError(`先验表未过校验：${where.join('，')}`);
  }
  const entries = structuredClone((typeof table === 'string' ? JSON.parse(table) : table).entries);
  const isSummary = (e) => Object.hasOwn(e, 'summaryOf');
  const view = (e) => ({ ...structuredClone(e), readbackLabel: e.verifiedInOurStack ? '已在我方读回' : '未在我方读回' });

  return {
    get(id) {
      const found = entries.find((e) => e.id === id);
      return found ? view(found) : undefined;
    },
    query({ domain, topic, unit, caseId, onlyVerified = false, includeSummaries = false, limit = Infinity, ...rest } = {}) {
      // 写错的条件名不能静默放大结果（例如把 onlyVerified 拼错后拿到未读回的值）。
      if (Object.keys(rest).length || typeof onlyVerified !== 'boolean' || typeof includeSummaries !== 'boolean'
        || (limit !== Infinity && !(Number.isSafeInteger(limit) && limit > 0))) {
        throw new TypeError('检索条件无效');
      }
      return entries.filter((e) => (includeSummaries || !isSummary(e))
        && (!onlyVerified || e.verifiedInOurStack)
        && (domain === undefined || e.domain === domain)
        && (topic === undefined || e.topic === topic)
        && (unit === undefined || e.unit === unit)
        && (caseId === undefined || e.provenance.caseId === caseId)).slice(0, limit).map(view);
    },
    stats() {
      const details = entries.filter((e) => !isSummary(e));
      const verifiedCount = details.filter((e) => e.verifiedInOurStack).length;
      return {
        totalEntries: entries.length,
        detailCount: details.length,
        summaryCount: entries.length - details.length,
        verifiedCount,
        unverifiedCount: details.length - verifiedCount,
        conflictCount: details.reduce((sum, e) => sum + (e.conflicts?.length ?? 0), 0),
      };
    },
  };
}
