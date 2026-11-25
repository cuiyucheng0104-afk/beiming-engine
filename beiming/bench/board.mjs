#!/usr/bin/env node
// 看板（B9）：把跑题器的结果、作业账本、技术卡和先验表汇成一份快照（bench-board/0.1），再出一张离线静态页和每日历史。
//   node beiming/bench/board.mjs build --out-dir <目录> [--as-of <YYYY-MM-DD>] [--questions-dir …] [--results-dir …] [--ledger …] [--cards-dir …] [--priors …] [--core-vs-cycles …] [--extra …]
// buildBoard、renderBoardHtml、appendBoardHistory 是纯函数：不读墙钟、不读文件，日期由调用方给；只有命令行外壳在没写 --as-of 时取 UTC 当天。
// 入参先抄成纯数据（不调取值器、不触发 Proxy 陷阱）再扫泄露，后面只读这份副本。口径见 DETAILS.md「看板」。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { contractError, runCli, usageError } from '../../tools/eval/lib/cli.mjs';
import { isCalendarDate } from '../cards/status.mjs';
import { normalizeLedgerEntry, summarizeJobLedger, withFileLock } from '../jobs/ledger.mjs';
import { scanQuestionLeaks, validateQuestion } from './validate-question.mjs';

export const BOARD_FORMAT = 'bench-board/0.1';
export const UNSUPPORTED_REASON = '这个帧源没有这项能力';
/** 05 §11：参数汇编的总条数，「参数的验证比例」的分母。 */
export const TOTAL_PRIORS_BASELINE = 4452;
/** 04 §11 / O12：核心出帧占比的固定四类片型。 */
export const FILM_TYPES = Object.freeze([
  Object.freeze({ id: 'motion-explainer', label: '动态图形与讲解' }),
  Object.freeze({ id: 'hard-surface', label: '硬表面与写实' }),
  Object.freeze({ id: 'toon', label: '三渲二' }),
  Object.freeze({ id: 'realtime-3d', label: '游戏感实时三维' }),
]);
/** 定稿简报 v2 §4 / meta/0.1：每帧元数据 source.renderer 允许的渲染器集合。 */
export const ALLOWED_RENDERERS = Object.freeze(['blender', 'three', 'core', 'legacy-page']);
const FILM_TYPE_IDS = Object.freeze(FILM_TYPES.map((t) => t.id));
const FILM_TYPE_LABEL = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(FILM_TYPES.map((t) => [t.id, t.label]))));
const CORE_VS_CYCLES_MAX_LEVEL = 8;
const CORE_VS_CYCLES_GATE_STATUSES = Object.freeze(['pass', 'fail', 'unset']);
const BLOCKED_REASON_LABEL = Object.freeze(Object.assign(Object.create(null), { fail: '判红退级', unset: '未定线退级', missing: '缺级阻塞' }));
const STALE_DAYS = 14, TOTAL_PACKS = 5, TOTAL_SWITCHES = 56, MAX_DEPTH = 64;
const RESULT_FORMAT = 'bench-result/0.1', QUESTION_FORMAT = 'question/0.1';
const UNSUPPORTED = 'unsupported-capability', NO_NAME = 'unspecified';
// 判过分或做题出了错的状态，都进均分的分母
const SCORED = ['pass', 'fail', 'error', 'timeout', 'failed', 'expected-fail'];
// 卡文件的等级（card-file 契约）和看板的叫法；右边按从低到高排在 STATUS_ORDER 里
const CARD_STATUS = { read: 'read-only', 'read-only': 'read-only', candidate: 'candidate', reproduced: 'reproduced', measured: 'verified', verified: 'verified', 'film-verified': 'production-proven', 'production-proven': 'production-proven' };
const STATUS_ORDER = ['read-only', 'candidate', 'reproduced', 'verified', 'production-proven'];
const RULERS = ['noise.residual', 'clip.highlight-ratio', 'alias.edge'];
const INPUT_KEYS = ['asOf', 'questions', 'results', 'cards', 'sourceCapabilities', 'ledger', 'jobs', 'parity', 'energy', 'blindPicks', 'pureFunctionGate', 'locality', 'rebuild', 'priors', 'packParity', 'harvest', 'history', 'scoreboardMetric', 'frameMeta', 'coreVsCycles'];

/* ---------------- 入参门禁 ---------------- */

const emptyObj = () => Object.create(null);

function bad(message, Type = TypeError, extra) {
  // 位置里的键名会进报错：整句命中泄露规则就不回显
  const err = new Type(safeMsg(message));
  for (const [k, v] of Object.entries({ code: 'usage.bad-argument', exitCode: 2, ...extra })) {
    Object.defineProperty(err, k, { __proto__: null, value: v, enumerable: true, writable: true, configurable: true });
  }
  throw err;
}

// 题面和先验表里常用斜杠表示除法或分隔选项；正文中的 POSIX 路径按系统根目录识别。
function hasLocalPath(value) {
  const plain = value.normalize('NFKC').replace(/\p{Cf}/gu, '');
  return /file:\/|~[\\/]|(?<![a-z0-9])[a-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+/i.test(plain)
    || /(?<![\p{L}\p{N}_.])(?<!https?:\/)\/(?:Users|home|tmp|var|private|etc|opt|Volumes|mnt|root|usr|proc|dev|bin|sbin|lib|Library|System|Applications)(?:[\\/]|$)/iu.test(plain);
}

const hasPrivateText = (s) => hasLocalPath(s) || scanQuestionLeaks(s).length > 0;
const safeMsg = (message) => hasPrivateText(message) ? '输入或路径含有私有内容，不回显' : message;

function checkLocalPath(value) {
  if (hasLocalPath(value)) bad('输入含有本机路径', TypeError, { leaks: [{ code: 'local-path' }] });
}

/** 抄成一份纯 JSON 数据（对象用 null 原型，隔断 Object.prototype 上的继承取值器/设值器）。只看自有属性描述符，零陷阱调用。 */
function toPlain(value, at = '', active = new Set()) {
  const where = at || '/';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    checkLocalPath(value);
    return value.isWellFormed() ? value : bad(`${where} 含有不成对的代理码元`);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : bad(`${where} 不是有限数`, RangeError);
  if (typeof value !== 'object') return bad(`${where} 不是 JSON 数据（${typeof value}）`);
  if (types.isProxy(value)) return bad(`${where} 是 Proxy，只收普通数据`);
  if (active.has(value)) return bad(`${where} 有环`);
  if (active.size >= MAX_DEPTH) return bad(`${where} 嵌套超过 ${MAX_DEPTH} 层`, RangeError);
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return bad(`${where} 不是普通${array ? '数组' : '对象'}`);
  if (Object.getOwnPropertySymbols(value).length) return bad(`${where} 带了 Symbol 键`);
  const slots = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(slots);
  const read = (key) => {
    const slot = Object.hasOwn(slots, key) ? slots[key] : null;
    if (!slot || !Object.hasOwn(slot, 'value') || !slot.enumerable) return bad(`${at}/${key} 不是可枚举的数据属性`);
    return toPlain(slot.value, `${at}/${key}`, active);
  };
  active.add(value);
  let copy;
  if (array) {
    // 自有键只能是 length 加 0 到 length-1：少了是空洞，多了是挂在数组上的附加属性
    if (keys.length !== value.length + 1) return bad(`${where} 是有空洞或带附加属性的数组`);
    copy = Array.from({ length: value.length }, (_, i) => read(String(i)));
  } else {
    if (keys.includes('__proto__')) return bad(`${where} 带了 __proto__ 键`);
    if (!keys.every((key) => key.isWellFormed())) return bad(`${where} 的键含有不成对的代理码元`);
    copy = emptyObj();
    for (const key of keys) {
      checkLocalPath(key);
      copy[key] = read(key);
    }
  }
  active.delete(value);
  return copy;
}

/** 纯数据副本，外加泄露门禁：看板不读的字段也扫，命中就不往下做。报错只带类型和位置。 */
function intake(value, what) {
  const data = toPlain(value);
  const leaks = scanQuestionLeaks(data);
  if (leaks.length) bad(`${what}里有私有内容，不生成看板：${leaks.slice(0, 8).map((leak) => `${leak.code}@${leak.path}`).join('，')}`, TypeError, { leaks });
  return data;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const obj = (v, at) => (isObj(v) ? v : bad(`${at} 必须是对象`));
const list = (v, at) => (v === undefined ? [] : Array.isArray(v) ? v : bad(`${at} 必须是数组`));
const text = (v, at) => (typeof v === 'string' && v !== '' ? v : bad(`${at} 必须是非空字符串`));
const flag = (v, at) => (v === undefined ? false : typeof v === 'boolean' ? v : bad(`${at} 必须是布尔值`));
const count = (v, at) => (Number.isSafeInteger(v) && v >= 0 ? v : bad(`${at} 必须是非负整数`, RangeError));
const level = (v, at) => (Number.isSafeInteger(v) && v >= 1 ? v : bad(`${at} 必须是不小于 1 的整数`, RangeError));
const number = (v, at) => (typeof v === 'number' ? v : bad(`${at} 必须是数`));
const amount = (v, at) => (typeof v === 'number' && v >= 0 ? v : bad(`${at} 必须是非负数`, RangeError));
const day = (v, at) => (isCalendarDate(v) ? v : bad(`${at} 必须是 YYYY-MM-DD 写法的日历日期`, RangeError));
const oneOf = (v, choices, at) => (choices.includes(v) ? v : bad(`${at} 只能是 ${choices.join(' / ')}`, RangeError));
const texts = (v, at) => [...new Set(list(v, at).map((item, i) => text(item, `${at}/${i}`)))];
function only(o, keys, at) {
  if (!Object.keys(o).every((key) => keys.includes(key))) bad(`${at} 只认这些键：${keys.join('、')}`);
  return o;
}
function unique(items, key, at) {
  if (new Set(items.map((item) => item[key])).size !== items.length) bad(`${at} 里有重复的 ${key}`);
  return items;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const tupleKey = (...parts) => parts.map((p) => `${String(p).length}:${String(p)}`).join('|');
const div = (a, b) => (b ? a / b : null);
function mean(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return Number.isFinite(sum) ? sum / values.length : values.reduce((acc, v) => acc + v / values.length, 0);
}
const tallyOf = (passed, total) => ({ passed, total, rate: div(passed, total) });
// 日历日期换成连续的天数（公历的整除算法，不经 Date，也就碰不到墙钟和时区）
function dayNumber(date) {
  const [year, month, d] = date.split('-').map(Number);
  const y = month <= 2 ? year - 1 : year;
  const yearOfEra = y - Math.floor(y / 400) * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return Math.floor(y / 400) * 146097 + yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
}
function freezeOut(v) {
  if (typeof v === 'number' && !Number.isFinite(v)) bad('计算结果超出有限数范围', RangeError);
  if (v === null || typeof v !== 'object') return v;
  const out = Array.isArray(v)
    ? v.map(freezeOut)
    : Object.fromEntries(Object.entries(v).map(([k, item]) => [k, freezeOut(item)]));
  return Object.freeze(out);
}

/* ---------------- 读入 ---------------- */

function readQuestions(input) {
  return unique(list(input, '/questions').map((raw, i) => {
    const at = `/questions/${i}`;
    const q = obj(raw, at);
    const flags = q.flags === undefined ? emptyObj() : obj(q.flags, `${at}/flags`);
    const hidden = [flag(flags.hidden, `${at}/flags/hidden`), flag(q.hidden, `${at}/hidden`), q.visibility === 'hidden'].includes(true);
    const cal = q.calibration === undefined || q.calibration === null ? null : obj(q.calibration, `${at}/calibration`);
    return {
      id: text(q.id, `${at}/id`), level: level(q.level, `${at}/level`), hidden, given: true,
      expectedFail: [flag(flags.expectedFail, `${at}/flags/expectedFail`), flag(q.expectedFail, `${at}/expectedFail`)].includes(true),
      title: q.title === undefined ? null : text(q.title, `${at}/title`),
      needs: texts(q.needs, `${at}/needs`),
      calibration: cal && { version: count(cal.version, `${at}/calibration/version`), status: text(cal.status, `${at}/calibration/status`), updatedAt: cal.updatedAt === undefined ? null : day(cal.updatedAt, `${at}/calibration/updatedAt`) },
    };
  }), 'id', '/questions');
}

// 用显式时区折到同一秒，小数部分保留原精度。没有日期的旧结果排在有日期的结果前面。
function resultTime(value, at) {
  if (value === undefined) return { second: -Infinity, fraction: '' };
  const match = /^(\d{4}-\d\d-\d\d)T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?(?:Z|([+-])([01]\d|2[0-3]):([0-5]\d))$/i.exec(text(value, at));
  if (!match || !isCalendarDate(match[1])) bad(`${at} 必须是带时区的 ISO 时间戳`, RangeError);
  const [, date, hour, minute, second, fraction = '', sign, offsetHour = 0, offsetMinute = 0] = match;
  const offset = (sign === '-' ? -1 : 1) * (offsetHour * 60 + Number(offsetMinute));
  return { second: dayNumber(date) * 86400 + hour * 3600 + (minute - offset) * 60 + Number(second), fraction: fraction.replace(/0+$/, '') };
}

function readResults(input) {
  return list(input, '/results').map((raw, i) => {
    const at = `/results/${i}`;
    const r = obj(raw, at);
    if (r.format !== undefined && r.format !== RESULT_FORMAT) bad(`${at}/format 不是 ${RESULT_FORMAT}`);
    const unsupported = flag(r.unsupported, `${at}/unsupported`) || r.status === UNSUPPORTED;
    const status = unsupported ? UNSUPPORTED : oneOf(r.status, SCORED, `${at}/status`);
    const judged = status === 'pass' || status === 'fail';
    const score = judged ? number(r.score, `${at}/score`) : 0;
    if (score < 0 || score > 1) bad(`${at}/score 要在 0 到 1 之间`, RangeError);
    if (!unsupported && r.pass !== undefined && r.pass !== (status === 'pass')) bad(`${at}/pass 和 status 对不上`);
    if (r.visibility !== undefined) oneOf(r.visibility, ['public', 'hidden'], `${at}/visibility`);
    const name = (v, key) => (v === undefined || v === null ? NO_NAME : text(v, `${at}/${key}`));
    return {
      questionId: text(r.questionId ?? r.id, `${at}/questionId`),
      level: r.level === undefined || r.level === null ? null : level(r.level, `${at}/level`),
      source: name(r.source, 'source'), model: name(r.model, 'model'), status, score,
      hidden: [r.visibility === 'hidden', flag(r.hidden, `${at}/hidden`)].includes(true),
      unsupported, expectedFail: flag(r.expectedFail, `${at}/expectedFail`),
      unmeasured: r.unmeasured === undefined ? 0 : count(r.unmeasured, `${at}/unmeasured`),
      createdAt: resultTime(r.createdAt, `${at}/createdAt`),
    };
  });
}

const cardStatus = (v, at) => (typeof v === 'string' && Object.hasOwn(CARD_STATUS, v) ? CARD_STATUS[v] : bad(`${at} 只能是 ${Object.keys(CARD_STATUS).join(' / ')}`, RangeError));

function readCards(input) {
  return unique(list(input, '/cards').map((raw, i) => {
    const at = `/cards/${i}`;
    const c = obj(raw, at);
    const livesIn = texts(c.livesIn, `${at}/livesIn`);
    if (!livesIn.length) bad(`${at}/livesIn 至少写一个落点`);
    let status, since;
    if (Array.isArray(c.status)) {
      // 卡文件的写法：逐环境一条。卡的状态取最高的那一级，起算日取到这一级最早的那天
      const entries = c.status.map((entry, n) => ({ status: cardStatus(obj(entry, `${at}/status/${n}`).level, `${at}/status/${n}/level`), date: day(entry.date, `${at}/status/${n}/date`) }));
      if (!entries.length) bad(`${at}/status 至少写一条`);
      status = STATUS_ORDER[Math.max(...entries.map((entry) => STATUS_ORDER.indexOf(entry.status)))];
      since = entries.filter((entry) => entry.status === status).map((entry) => entry.date).sort()[0];
    } else {
      status = cardStatus(c.status, `${at}/status`);
      const stamp = c.reproducedAt ?? c.statusUpdatedAt;
      since = stamp === undefined || stamp === null ? null : day(stamp, `${at}/reproducedAt`);
    }
    const ext = c.ext === undefined || c.ext === null ? emptyObj() : obj(c.ext, `${at}/ext`);
    // 候选卡（收获起草的）和注册表一个认法：ext 的 registry.candidate，或顶层 candidate
    if (flag(c.candidate, `${at}/candidate`) || (Object.hasOwn(ext, 'registry.candidate') && ext['registry.candidate'] === true)) status = 'candidate';
    return { id: text(c.id, `${at}/id`), category: text(c.category ?? c.kind, `${at}/kind`), livesIn, status, since, exams: texts(c.exams, `${at}/exams`) };
  }), 'id', '/cards');
}

function readCapabilities(input) {
  const caps = new Map();
  if (input === undefined) return caps;
  for (const [source, raw] of Object.entries(obj(input, '/sourceCapabilities'))) {
    const at = '/sourceCapabilities 的一项';
    const cap = only(obj(raw, at), ['unsupportedQuestions', 'unsupportedCards'], at);
    caps.set(source, { questions: new Set(texts(cap.unsupportedQuestions, `${at}/unsupportedQuestions`)), cards: new Set(texts(cap.unsupportedCards, `${at}/unsupportedCards`)) });
  }
  return caps;
}

function readJobs(input) {
  return unique(list(input, '/jobs').map((raw, i) => {
    const at = `/jobs/${i}`;
    const j = obj(raw, at);
    if (typeof j.basePass !== 'boolean') bad(`${at}/basePass 必须是布尔值`);
    return {
      jobId: text(j.jobId, `${at}/jobId`), basePass: j.basePass, interventions: count(j.interventions, `${at}/interventions`),
      // V8：亲手模式自选模板的片单列
      selfSelected: j.templateOrigin === 'self-selected' || (j.mode === 'hand' && j.selfSelectedTemplate === true),
      filmDurationSec: j.filmDurationSec === undefined ? null : amount(j.filmDurationSec, `${at}/filmDurationSec`),
    };
  }), 'jobId', '/jobs');
}

function readHistory(input, at) {
  return unique(list(input, at).map((raw, i) => {
    const where = `${at}/${i}`;
    const row = obj(raw, where);
    day(row.asOf, `${where}/asOf`);
    const counts = ['scoredCells', 'unsupportedCells', 'cardsReproducedOrAbove', 'cardsVerifiedOrAbove', 'readOnlyPlaceholders', 'verifiedPacks', 'ablatedSwitches', 'expectedFailQuestions', 'staleReproducedCards'];
    const rates = ['overallMean', 'unattendedRate', 'wallSecPerFilmSec', 'priorsVerifiedRatio'];
    only(row, ['asOf', ...counts, ...rates, 'passRateByLevel', 'calibration', 'calibrationChanged'], where);
    for (const key of counts) if (Object.hasOwn(row, key)) count(row[key], `${where}/${key}`);
    for (const key of rates) if (Object.hasOwn(row, key) && row[key] !== null) amount(row[key], `${where}/${key}`);
    if (row.passRateByLevel !== undefined) {
      for (const [key, rate] of Object.entries(obj(row.passRateByLevel, where))) {
        if (!/^[1-9]\d*$/.test(key)) bad('历史通过率含有无效等级');
        if (rate !== null) amount(rate, where);
      }
    }
    if (row.calibrationChanged !== undefined) texts(row.calibrationChanged, where);
    for (const cal of list(row.calibration, where)) {
      only(obj(cal, where), ['questionId', 'status', 'version', 'updatedAt'], where);
      text(cal.questionId, where);
      text(cal.status, where);
      count(cal.version, where);
      if (cal.updatedAt !== undefined) day(cal.updatedAt, where);
    }
    return row;
  }), 'asOf', at);
}

/* ---------------- 矩阵 ---------------- */

function buildMatrix({ asOf, questions, results, cards, caps, previous }) {
  const byId = new Map(questions.map((q) => [q.id, { ...q, hasUnmeasured: false }]));
  for (const r of results) {
    const row = byId.get(r.questionId);
    if (row) {
      row.hidden ||= r.hidden;
      if (!row.given) row.expectedFail ||= r.expectedFail;
    } else if (r.level === null) bad('/results 里有一道题既没有题面、结果里也没有 level');
    else byId.set(r.questionId, { id: r.questionId, level: r.level, hidden: r.hidden, given: false, hasUnmeasured: false, expectedFail: r.expectedFail, title: null, needs: [], calibration: null });
  }
  const columns = [...new Map(results.map((r) => [tupleKey(r.source, r.model), { source: r.source, model: r.model }])).values()]
    .sort((a, b) => cmp(a.source, b.source) || cmp(a.model, b.model));
  // 同一格跑了几次：取 createdAt 最新的那次，时间一样取排在后面的
  const latest = new Map();
  for (const r of results) {
    const at = tupleKey(r.questionId, r.source, r.model);
    const seen = latest.get(at);
    const prior = seen?.pick.createdAt;
    const order = prior ? cmp(prior.second, r.createdAt.second) || cmp(prior.fraction, r.createdAt.fraction) : 0;
    latest.set(at, { runs: (seen?.runs ?? 0) + 1, pick: order > 0 ? seen.pick : r });
  }
  const cardById = new Map(cards.map((c) => [c.id, c]));
  // 帧源缺这道题要的能力：能力表点了名；或 needs 里有一张卡只落在别的帧源上（data、comp、bake 是跨帧源的落点）
  const lacks = (row, source) => {
    const cap = caps.get(source);
    return Boolean(cap?.questions.has(row.id)) || row.needs.some((need) => Boolean(cap?.cards.has(need))
      || (source !== NO_NAME && cardById.has(need) && cardById.get(need).livesIn.every((landing) => landing.startsWith('source:') && landing !== `source:${source}`)));
  };
  const stat = (cells) => {
    const scores = cells.filter((cell) => cell.kind === 'scored').map((cell) => cell.score);
    return { mean: mean(scores), scoredCells: scores.length };
  };
  const before = new Map((Array.isArray(previous?.calibration) ? previous.calibration : []).filter(isObj).map((c) => [c.questionId, c]));
  const calibrationChanges = [];

  const sorted = [...byId.values()].sort((a, b) => a.level - b.level || cmp(a.id, b.id));
  const rows = sorted.map((row) => {
    const cells = columns.map(({ source, model }) => {
      const hit = latest.get(tupleKey(row.id, source, model));
      const runCount = row.hidden ? {} : { runs: hit?.runs ?? 0 };
      if (hit?.pick.unsupported || lacks(row, source)) return { kind: UNSUPPORTED, status: UNSUPPORTED, pass: null, score: null, display: UNSUPPORTED_REASON, unsupportedReason: UNSUPPORTED_REASON, ...runCount };
      if (!hit) return { kind: 'unrun', status: 'unrun', pass: null, score: null, display: '未跑', ...runCount };
      const { status, score, unmeasured } = hit.pick;
      // 在公开投影前登记覆盖缺口，只认参与计分的最新结果。row 是内部的题目副本。
      if (unmeasured > 0) row.hasUnmeasured = true;
      return { kind: 'scored', status, pass: status === 'pass', score, display: String(Math.round(score * 1000) / 1000), ...(row.hidden ? {} : { unmeasured }), ...runCount };
    });
    const calibration = row.calibration && { version: row.calibration.version, status: row.calibration.status };
    const old = before.get(row.id);
    const calibrationChanged = Boolean(calibration) && (row.calibration.updatedAt === asOf || (Boolean(old) && (old.version !== calibration.version || old.status !== calibration.status)));
    if (calibrationChanged) calibrationChanges.push({ questionId: row.id, ...calibration, previous: old ? { version: old.version ?? null, status: old.status ?? null } : null });
    const { mean: rowMean, scoredCells } = stat(cells);
    return {
      // 隐藏题只落总分和状态：题面、标题、needs、阻塞原因、逐项都不出
      questionId: row.id, level: row.level, hidden: row.hidden, title: row.hidden ? `隐藏题 ${row.id}` : row.title,
      expectedFail: row.expectedFail || (!row.given && cells.some((cell) => cell.status === 'expected-fail')),
      calibration, calibrationChanged, cells, rowMean, scoredCells,
    };
  });

  const all = rows.flatMap((row) => row.cells);
  const group = (name) => [...new Set(columns.map((column) => column[name]))].sort(cmp)
    .map((value) => ({ [name]: value, ...stat(rows.flatMap((row) => row.cells.filter((_, i) => columns[i][name] === value))) }));
  const { mean: overallMean, scoredCells } = stat(all);
  return {
    sorted, calibrationChanges,
    matrix: {
      unsupportedReason: UNSUPPORTED_REASON,
      columns: columns.map((column, i) => ({ ...column, ...stat(rows.map((row) => row.cells[i])) })),
      rows, sourceMeans: group('source'), modelMeans: group('model'), overallMean, scoredCells,
      unsupportedCells: all.filter((cell) => cell.kind === UNSUPPORTED).length,
      unrunCells: all.filter((cell) => cell.kind === 'unrun').length,
    },
  };
}

/* ---------------- 四个指标 ---------------- */

function passRateByLevel(rows) {
  const counts = new Map([1, 2, 3, 4, 5].map((n) => [n, [0, 0]]));
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.kind !== 'scored') continue;   // 空格和没跑的不进分母；预期失败进分母、不进分子
      const pair = counts.get(row.level) ?? [0, 0];
      counts.set(row.level, [pair[0] + (cell.pass ? 1 : 0), pair[1] + 1]);
    }
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => a - b).map(([n, [passed, total]]) => [n, tallyOf(passed, total)]));
}

function parityHeadroom(input) {
  if (input === undefined) return null;
  const items = list(input, '/parity').map((raw, i) => {
    const at = `/parity/${i}`;
    const p = obj(raw, at);
    // 余量是实测值离门限多远，正的在门限以内
    const margin = p.margin !== undefined ? number(p.margin, `${at}/margin`)
      : (oneOf(p.direction, ['at-least', 'at-most'], `${at}/direction`) === 'at-least' ? 1 : -1) * (number(p.value, `${at}/value`) - number(p.threshold, `${at}/threshold`));
    return { id: text(p.id, `${at}/id`), margin };
  }).sort((a, b) => a.margin - b.margin || cmp(a.id, b.id));
  return { count: items.length, minMargin: items.length ? items[0].margin : null, belowThreshold: items.filter((item) => item.margin < 0).length, items };
}

function energyRulers(input) {
  if (input === undefined) return null;
  const samples = new Map(RULERS.map((ruler) => [ruler, []]));
  list(input, '/energy').forEach((raw, i) => {
    const e = obj(raw, `/energy/${i}`);
    const ruler = oneOf(typeof e.metric === 'string' ? e.metric.replace(/^metric:/, '') : e.metric, RULERS, `/energy/${i}/metric`);
    samples.get(ruler).push(amount(e.value, `/energy/${i}/value`));
  });
  // 三把尺子都是越小越好，最差的是最大的那个读数
  return Object.fromEntries([...samples].map(([ruler, values]) => [ruler, values.length ? { samples: values.length, mean: mean(values), worst: values.reduce((a, b) => Math.max(a, b)) } : null]));
}

function blindPick(input) {
  if (input === undefined) return null;
  const n = { win: 0, tie: 0, loss: 0 };
  list(input, '/blindPicks').forEach((raw, i) => { n[oneOf(obj(raw, `/blindPicks/${i}`).outcome, ['win', 'tie', 'loss'], `/blindPicks/${i}/outcome`)] += 1; });
  const total = n.win + n.tie + n.loss;
  return { wins: n.win, ties: n.tie, losses: n.loss, winsOrTies: n.win + n.tie, total, rate: div(n.win + n.tie, total) };
}

function unattended(jobs) {
  const of = (some) => {
    const succeeded = some.filter((job) => job.basePass && job.interventions === 0).length;
    return { succeeded, total: some.length, rate: div(succeeded, some.length) };
  };
  return { ...of(jobs.filter((job) => !job.selfSelected)), selfSelected: of(jobs.filter((job) => job.selfSelected)) };
}

function speedAndCost(input, jobs) {
  const rows = list(input, '/ledger');
  let totals;
  // 六维成本的校验和合计用 A15 自己的口径
  try { totals = summarizeJobLedger(rows); } catch (error) { bad(`/ledger ${typeof error?.message === 'string' ? error.message : '有无效的账本记录'}`, RangeError); }
  // 账本行没有成片时长：从作业记录的 filmDurationSec 取，行里自己带了也认（作业记录优先）
  const film = new Map(jobs.filter((job) => job.filmDurationSec !== null).map((job) => [job.jobId, job.filmDurationSec]));
  const fromJobs = new Set(film.keys());
  const byJob = new Map();
  rows.forEach((row, i) => {
    const jobId = text(row.jobId, `/ledger/${i}/jobId`);
    const seconds = row.filmDurationSec === undefined ? null : amount(row.filmDurationSec, `/ledger/${i}/filmDurationSec`);
    if (seconds !== null && !fromJobs.has(jobId)) film.set(jobId, seconds);
    const job = byJob.get(jobId) ?? { rows: [], succeeded: false };
    job.rows.push(row);
    job.succeeded ||= row.status === 'succeeded';
    byJob.set(jobId, job);
  });
  // 出了成片的作业：有成功的一轮、成片时长大于 0。它的每一轮（失败的也算）都摊在这部片头上
  const filmJobs = [...byJob].filter(([jobId, job]) => job.succeeded && film.get(jobId) > 0);
  const filmRows = filmJobs.flatMap(([, job]) => job.rows);
  const filmSeconds = filmJobs.reduce((sum, [jobId]) => sum + film.get(jobId), 0);
  const per = (pick) => div(filmRows.reduce((sum, row) => sum + pick(row), 0), filmSeconds);
  return {
    filmJobs: filmJobs.length, filmSeconds,
    wallSecPerFilmSec: per((row) => row.wallMs / 1000),
    gpuSecPerFilmSec: per((row) => row.gpuSeconds),
    tokensPerFilmSec: per((row) => row.totalTokens),
    tokensByTierPerFilmSec: filmSeconds ? Object.fromEntries(Object.keys(totals.tokensByTier).map((tier) => [tier, per((row) => row.tokensByTier[tier])])) : null,
    renderedPerDelivered: div(totals.renderedFrames, totals.deliveredFrames),
    meanRounds: div(rows.length, byJob.size),   // 账本一轮一行
    gpuIsLowerBound: totals.gpuUnknownRows > 0,
    totals,
  };
}

/** 一栏通过数：给逐条的 [{ pass }]，或已经数好的 { passed, total }；没给是 not-run。 */
function tally(input, at) {
  if (input === undefined) return { ...tallyOf(0, 0), status: 'not-run' };
  if (Array.isArray(input)) return tallyOf(input.filter((raw, i) => { const { pass } = obj(raw, `${at}/${i}`); return typeof pass === 'boolean' ? pass : bad(`${at}/${i}/pass 必须是布尔值`); }).length, input.length);
  const t = only(obj(input, at), ['passed', 'total'], at);
  if (count(t.passed, `${at}/passed`) > count(t.total, `${at}/total`)) bad(`${at} 的 passed 不能超过 total`, RangeError);
  return tallyOf(t.passed, t.total);
}

/* ---------------- 整合进度与反向指标 ---------------- */

const atLeast = (status, floor) => STATUS_ORDER.indexOf(status) >= STATUS_ORDER.indexOf(floor);

function cardProgress(cards) {
  const byStatus = Object.fromEntries(STATUS_ORDER.map((status) => [status, cards.filter((card) => card.status === status).length]));
  const cells = new Map();
  // 一张卡有几个落点就在几格里各数一次
  for (const card of cards) {
    for (const landing of card.livesIn) {
      const k = tupleKey(card.category, landing, card.status);
      cells.set(k, { category: card.category, livesIn: landing, status: card.status, count: (cells.get(k)?.count ?? 0) + 1 });
    }
  }
  const from = (floor) => cards.filter((card) => atLeast(card.status, floor)).length;
  return {
    total: cards.length,
    // 「只读过」的占位卡和候选卡单独数，不进下面三个数
    readOnlyPlaceholders: byStatus['read-only'], candidates: byStatus.candidate,
    reproducedOrAbove: from('reproduced'), verifiedOrAbove: from('verified'), productionProven: byStatus['production-proven'],
    byStatus,
    distribution: [...cells.values()]
      .sort((a, b) => cmp(a.category, b.category) || cmp(a.livesIn, b.livesIn) || cmp(a.status, b.status)),
  };
}

function examCoverage(sorted, rows, cards) {
  const verified = new Set(cards.filter((card) => atLeast(card.status, 'verified')).map((card) => card.id));
  const formal = cards.filter((card) => atLeast(card.status, 'reproduced'));
  const without = formal.filter((card) => !card.exams.length).map((card) => card.id).sort(cmp);
  const byLevel = new Map();
  const notScorable = [];
  sorted.forEach((q, i) => {
    if (!q.given) return;
    // 可判分：没登记成预期失败，判过分的格里也没有缺量测器的项
    const reason = rows[i].expectedFail ? 'expected-fail' : q.hasUnmeasured ? 'unmeasured' : null;
    const at = byLevel.get(q.level) ?? { total: 0, scorable: 0 };
    byLevel.set(q.level, { total: at.total + 1, scorable: at.scorable + (reason ? 0 : 1) });
    if (reason && !q.hidden) notScorable.push({ questionId: q.id, reason });
  });
  const levels = [...byLevel.values()];
  return {
    perQuestion: sorted.filter((q) => q.given && !q.hidden).map((q) => {
      const notVerified = q.needs.filter((need) => !verified.has(need)).sort(cmp);
      const ok = q.needs.length - notVerified.length;
      return { questionId: q.id, level: q.level, needs: q.needs.length, verified: ok, ratio: div(ok, q.needs.length), ...(q.needs.length ? {} : { noCardNeeds: true }), notVerified };
    }),
    cardsWithExam: { withExam: formal.length - without.length, total: formal.length, ratio: div(formal.length - without.length, formal.length), without },
    scorableQuestions: {
      total: levels.reduce((sum, at) => sum + at.total, 0), scorable: levels.reduce((sum, at) => sum + at.scorable, 0),
      byLevel: Object.fromEntries([...byLevel].sort(([a], [b]) => a - b)), notScorable,
    },
  };
}

function priorsVerified(input) {
  const details = new Map();
  list(input, '/priors').forEach((raw, i) => {
    const item = obj(raw, `/priors/${i}`);
    // 每项是一张先验表（priors/0.1，带 entries）或一条先验
    (Object.hasOwn(item, 'entries') ? list(item.entries, `/priors/${i}/entries`) : [item]).forEach((entry, n) => {
      const at = `/priors/${i} 的第 ${n + 1} 条`;
      if (typeof obj(entry, at).verifiedInOurStack !== 'boolean') bad(`${at} 的 verifiedInOurStack 必须是布尔值`);
      // 和 C9 的 stats() 一个口径：汇总行（带 summaryOf）不数；同一个 id 只数一次
      if (!Object.hasOwn(entry, 'summaryOf')) details.set(text(entry.id, `${at} 的 id`), entry.verifiedInOurStack);
    });
  });
  const verifiedCount = [...details.values()].filter(Boolean).length;
  return { verifiedCount, detailCount: details.size, baselineTotal: TOTAL_PRIORS_BASELINE, ratio: verifiedCount / TOTAL_PRIORS_BASELINE };
}

function packParity(input) {
  const p = input === undefined ? emptyObj() : only(obj(input, '/packParity'), ['verifiedPacks', 'totalPacks', 'ablatedSwitches', 'totalSwitches'], '/packParity');
  const pair = (doneKey, totalKey, fixed) => {
    if (p[totalKey] !== undefined && count(p[totalKey], `/packParity/${totalKey}`) !== fixed) bad(`/packParity/${totalKey} 固定为 ${fixed}`, RangeError);
    const done = p[doneKey] === undefined ? 0 : count(p[doneKey], `/packParity/${doneKey}`);
    return done > fixed ? bad(`/packParity/${doneKey} 不能超过 ${fixed}`, RangeError) : done;
  };
  const verifiedPacks = pair('verifiedPacks', 'totalPacks', TOTAL_PACKS);
  const ablatedSwitches = pair('ablatedSwitches', 'totalSwitches', TOTAL_SWITCHES);
  return { verifiedPacks, totalPacks: TOTAL_PACKS, packRatio: verifiedPacks / TOTAL_PACKS, ablatedSwitches, totalSwitches: TOTAL_SWITCHES, switchRatio: ablatedSwitches / TOTAL_SWITCHES };
}

function harvest(input) {
  const keys = ['drafted', 'promoted', 'archived', 'reproducedPromotions'];
  const h = input === undefined ? emptyObj() : only(obj(input, '/harvest'), keys, '/harvest');
  return Object.fromEntries(keys.map((key) => [key, h[key] === undefined ? 0 : count(h[key], `/harvest/${key}`)]));
}

function staleReproducedCards(cards, asOf) {
  // 只数停在「复现过」的：只读过的占位卡和候选卡不是欠账；没写日期的算不了，单独列出来
  const stuck = cards.filter((card) => card.status === 'reproduced');
  const ids = stuck.filter((card) => card.since !== null && dayNumber(asOf) - dayNumber(card.since) > STALE_DAYS).map((card) => card.id).sort(cmp);
  return { count: ids.length, thresholdDays: STALE_DAYS, ids, undated: stuck.filter((card) => card.since === null).map((card) => card.id).sort(cmp) };
}

/** B11 第 5 步原话账本自然周重复打回率指标（computeWeeklyRejectionStats 产出的 scoreboardMetric）。 */
function readScoreboardMetric(input, at = '/scoreboardMetric') {
  if (input === undefined) return null;
  const m = only(obj(input, at), ['firstTimeCount', 'repeatCount', 'total', 'repeatRate', 'weekStart', 'weekEnd'], at);
  const total = count(m.total, `${at}/total`);
  const repeatCount = count(m.repeatCount, `${at}/repeatCount`);
  const firstTimeCount = count(m.firstTimeCount, `${at}/firstTimeCount`);
  if (repeatCount > total) bad(`${at} 的 repeatCount 不能超过 total`, RangeError);
  if (firstTimeCount + repeatCount !== total) bad(`${at} 的 firstTimeCount + repeatCount 必须等于 total`, RangeError);
  let repeatRate;
  if (total === 0) {
    if (m.repeatRate !== undefined && m.repeatRate !== null) bad(`${at}/repeatRate 在 total 为 0 时必须是 null`, RangeError);
    repeatRate = null;
  } else {
    const expected = repeatCount / total;
    if (m.repeatRate !== undefined) {
      if (m.repeatRate === null) bad(`${at}/repeatRate 在 total 大于 0 时不能为 null`, RangeError);
      const given = amount(m.repeatRate, `${at}/repeatRate`);
      if (given > 1) bad(`${at}/repeatRate 不能超过 1`, RangeError);
      if (Math.abs(given - expected) > 1e-9) bad(`${at}/repeatRate 与 repeatCount / total 不一致`, RangeError);
    }
    repeatRate = expected;
  }
  const weekStart = m.weekStart === undefined ? undefined : day(m.weekStart, `${at}/weekStart`);
  const weekEnd = m.weekEnd === undefined ? undefined : day(m.weekEnd, `${at}/weekEnd`);
  if (weekStart !== undefined && weekEnd !== undefined && weekStart > weekEnd) {
    bad(`${at}/weekStart 不能晚于 weekEnd`, RangeError);
  }
  return {
    firstTimeCount,
    repeatCount,
    total,
    repeatRate,
    ...(weekStart !== undefined ? { weekStart } : {}),
    ...(weekEnd !== undefined ? { weekEnd } : {}),
  };
}

/** O12：按四类片型统计核心出帧占比；唯一真相源是逐帧宿主元数据 frame.source.renderer === 'core'，不采信作业自报。 */
function readFrameMeta(input) {
  const counts = new Map(FILM_TYPES.map(({ id }) => [id, { coreFrames: 0, totalFrames: 0 }]));
  const countFrame = (frameRaw, fAt, bucket) => {
    const frame = obj(frameRaw, fAt);
    const source = obj(frame.source, `${fAt}/source`);
    const renderer = oneOf(source.renderer, ALLOWED_RENDERERS, `${fAt}/source/renderer`);
    bucket.totalFrames += 1;
    if (renderer === 'core') bucket.coreFrames += 1;
  };
  list(input, '/frameMeta').forEach((raw, i) => {
    const at = `/frameMeta/${i}`;
    const item = obj(raw, at);
    const filmType = oneOf(item.filmType, FILM_TYPE_IDS, `${at}/filmType`);
    if (item.filmId !== undefined) text(item.filmId, `${at}/filmId`);
    const bucket = counts.get(filmType);
    if (Object.hasOwn(item, 'frames')) {
      if (!Array.isArray(item.frames)) bad(`${at}/frames 必须是数组`);
      item.frames.forEach((frameRaw, j) => countFrame(frameRaw, `${at}/frames/${j}`, bucket));
    } else if (Object.hasOwn(item, 'source')) {
      countFrame(item, at, bucket);
    } else {
      bad(`${at}/frames 必须是数组`);
    }
  });
  let totalCore = 0;
  let totalAll = 0;
  const byFilmType = Object.fromEntries(FILM_TYPES.map(({ id, label: typeLabel }) => {
    const { coreFrames, totalFrames } = counts.get(id);
    totalCore += coreFrames;
    totalAll += totalFrames;
    return [id, { label: typeLabel, coreFrames, totalFrames, rate: totalFrames ? coreFrames / totalFrames : 0 }];
  }));
  return {
    overall: { coreFrames: totalCore, totalFrames: totalAll, rate: totalAll ? totalCore / totalAll : 0 },
    byFilmType,
  };
}

/** 校验看板快照上的 coreFrameShare 结构与计数一致性（供 checkBoard / renderBoardHtml 复核）。 */
function readCoreFrameShare(input, at = '看板的 coreFrameShare') {
  const c = only(obj(input, at), ['overall', 'byFilmType'], at);
  const checkEntry = (raw, where, expectedLabel) => {
    const allowed = expectedLabel === undefined ? ['coreFrames', 'totalFrames', 'rate'] : ['label', 'coreFrames', 'totalFrames', 'rate'];
    const e = only(obj(raw, where), allowed, where);
    if (expectedLabel !== undefined && text(e.label, `${where}/label`) !== expectedLabel) {
      bad(`${where}/label 必须是 ${expectedLabel}`);
    }
    const coreFrames = count(e.coreFrames, `${where}/coreFrames`);
    const totalFrames = count(e.totalFrames, `${where}/totalFrames`);
    if (coreFrames > totalFrames) bad(`${where} 的 coreFrames 不能超过 totalFrames`, RangeError);
    const expectedRate = totalFrames ? coreFrames / totalFrames : 0;
    const givenRate = amount(e.rate, `${where}/rate`);
    if (givenRate > 1) bad(`${where}/rate 不能超过 1`, RangeError);
    if (Math.abs(givenRate - expectedRate) > 1e-9) bad(`${where}/rate 与 coreFrames / totalFrames 不一致`, RangeError);
    return expectedLabel === undefined
      ? { coreFrames, totalFrames, rate: expectedRate }
      : { label: expectedLabel, coreFrames, totalFrames, rate: expectedRate };
  };
  const byRaw = only(obj(c.byFilmType, `${at}/byFilmType`), FILM_TYPE_IDS, `${at}/byFilmType`);
  let sumCore = 0;
  let sumTotal = 0;
  const byFilmType = Object.fromEntries(FILM_TYPES.map(({ id, label: typeLabel }) => {
    const entry = checkEntry(byRaw[id], `${at}/byFilmType/${id}`, typeLabel);
    sumCore += entry.coreFrames;
    sumTotal += entry.totalFrames;
    return [id, entry];
  }));
  const overall = checkEntry(c.overall, `${at}/overall`);
  if (overall.coreFrames !== sumCore || overall.totalFrames !== sumTotal) {
    bad(`${at}/overall 与 byFilmType 合计不一致`, RangeError);
  }
  return { overall, byFilmType };
}

const nonBlank = (v, at) => (typeof v === 'string' && v.trim() !== '' ? v : bad(`${at} 必须是非空字符串`));
const posNumber = (v, at) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : bad(`${at} 必须是正数`, RangeError));
const posInt = (v, at) => (Number.isSafeInteger(v) && v >= 1 ? v : bad(`${at} 必须是正整数`, RangeError));
const ladderLevel = (v, at) => (Number.isSafeInteger(v) && v >= 1 && v <= CORE_VS_CYCLES_MAX_LEVEL
  ? v
  : bad(`${at} 必须是 1 到 ${CORE_VS_CYCLES_MAX_LEVEL} 的整数`, RangeError));

function parseCoreVsCyclesSpeed(raw, at, allowComputed = false) {
  const keys = allowComputed
    ? ['coreMs', 'cyclesMs', 'speedRatio', 'coreOverCyclesRatio', 'gpu', 'samples', 'resolution']
    : ['coreMs', 'cyclesMs', 'gpu', 'samples', 'resolution'];
  const s = only(obj(raw, at), keys, at);
  const coreMs = posNumber(s.coreMs, `${at}/coreMs`);
  const cyclesMs = posNumber(s.cyclesMs, `${at}/cyclesMs`);
  const gpu = nonBlank(s.gpu, `${at}/gpu`);
  const samples = posInt(s.samples, `${at}/samples`);
  if (!Array.isArray(s.resolution) || s.resolution.length !== 2) {
    bad(`${at}/resolution 必须是 [正整数宽, 正整数高]`, RangeError);
  }
  const width = posInt(s.resolution[0], `${at}/resolution/0`);
  const height = posInt(s.resolution[1], `${at}/resolution/1`);
  const speedRatio = cyclesMs / coreMs;
  const coreOverCyclesRatio = coreMs / cyclesMs;
  if (!Number.isFinite(speedRatio) || speedRatio <= 0 || !Number.isFinite(coreOverCyclesRatio) || coreOverCyclesRatio <= 0) {
    bad(`${at} 的速度比超出有效正数范围`, RangeError);
  }
  if (allowComputed) {
    const givenSpeed = posNumber(s.speedRatio, `${at}/speedRatio`);
    const givenCoreOver = posNumber(s.coreOverCyclesRatio, `${at}/coreOverCyclesRatio`);
    if (Math.abs(givenSpeed - speedRatio) > 1e-9 * Math.max(1, speedRatio)) {
      bad(`${at}/speedRatio 与 cyclesMs / coreMs 不一致`, RangeError);
    }
    if (Math.abs(givenCoreOver - coreOverCyclesRatio) > 1e-9 * Math.max(1, coreOverCyclesRatio)) {
      bad(`${at}/coreOverCyclesRatio 与 coreMs / cyclesMs 不一致`, RangeError);
    }
  }
  return { coreMs, cyclesMs, speedRatio, coreOverCyclesRatio, gpu, samples, resolution: [width, height] };
}

function sameSpeed(a, b) {
  return a.coreMs === b.coreMs
    && a.cyclesMs === b.cyclesMs
    && a.gpu === b.gpu
    && a.samples === b.samples
    && a.resolution[0] === b.resolution[0]
    && a.resolution[1] === b.resolution[1];
}

function parseCoreVsCyclesGate(raw, at, strictKeys = false) {
  const g = strictKeys ? only(obj(raw, at), ['level', 'status', 'gateId', 'metric', 'value', 'threshold'], at) : obj(raw, at);
  const lv = ladderLevel(g.level, `${at}/level`);
  const status = oneOf(g.status, CORE_VS_CYCLES_GATE_STATUSES, `${at}/status`);
  const out = { level: lv, status };
  if (g.gateId !== undefined) out.gateId = nonBlank(g.gateId, `${at}/gateId`);
  if (g.metric !== undefined) out.metric = nonBlank(g.metric, `${at}/metric`);
  if (g.value !== undefined) out.value = number(g.value, `${at}/value`);
  if (g.threshold !== undefined) out.threshold = number(g.threshold, `${at}/threshold`);
  return out;
}

function sortCoreVsCyclesGates(gates) {
  return [...gates].sort((a, b) => a.level - b.level
    || cmp(Object.hasOwn(a, 'gateId') ? a.gateId : '', Object.hasOwn(b, 'gateId') ? b.gateId : '')
    || cmp(Object.hasOwn(a, 'metric') ? a.metric : '', Object.hasOwn(b, 'metric') ? b.metric : '')
    || cmp(a.status, b.status));
}

function evaluateCoreVsCyclesLadder(gates) {
  const byLevel = new Map();
  let maxRegistered = 0;
  for (const gate of gates) {
    if (gate.level > maxRegistered) maxRegistered = gate.level;
    const bucket = byLevel.get(gate.level);
    if (bucket) bucket.push(gate);
    else byLevel.set(gate.level, [gate]);
  }
  if (maxRegistered === 0) return { passedLevel: 0, blockedAtLevel: 1, blockedReason: 'missing' };
  for (let k = 1; k <= CORE_VS_CYCLES_MAX_LEVEL; k += 1) {
    const levelGates = byLevel.get(k);
    if (!levelGates || levelGates.length === 0) {
      if (k < maxRegistered) return { passedLevel: k - 1, blockedAtLevel: k, blockedReason: 'missing' };
      return { passedLevel: k - 1, blockedAtLevel: null, blockedReason: null };
    }
    if (levelGates.some((gate) => gate.status === 'fail')) {
      return { passedLevel: k - 1, blockedAtLevel: k, blockedReason: 'fail' };
    }
    if (levelGates.some((gate) => gate.status === 'unset')) {
      return { passedLevel: k - 1, blockedAtLevel: k, blockedReason: 'unset' };
    }
  }
  return { passedLevel: CORE_VS_CYCLES_MAX_LEVEL, blockedAtLevel: null, blockedReason: null };
}

function aggregateCoreVsCyclesScenes(scenes) {
  const stats = new Map(FILM_TYPES.map(({ id }) => [id, { maxPassedLevel: 0, sceneCount: 0, blockedCount: 0 }]));
  let overallMax = 0;
  let overallBlocked = 0;
  let speedCount = 0;
  for (const scene of scenes) {
    const bucket = stats.get(scene.filmType);
    bucket.sceneCount += 1;
    if (scene.passedLevel > bucket.maxPassedLevel) bucket.maxPassedLevel = scene.passedLevel;
    if (scene.passedLevel > overallMax) overallMax = scene.passedLevel;
    if (scene.blockedAtLevel !== null) {
      bucket.blockedCount += 1;
      overallBlocked += 1;
    }
    if (scene.speed !== null) speedCount += 1;
  }
  const byFilmType = Object.fromEntries(FILM_TYPES.map(({ id, label: typeLabel }) => {
    const bucket = stats.get(id);
    return [id, { label: typeLabel, maxPassedLevel: bucket.maxPassedLevel, sceneCount: bucket.sceneCount, blockedCount: bucket.blockedCount }];
  }));
  return {
    maxLevel: CORE_VS_CYCLES_MAX_LEVEL,
    overall: { maxPassedLevel: overallMax, sceneCount: scenes.length, blockedCount: overallBlocked, speedCount },
    byFilmType,
    scenes,
  };
}

/** O13：聚合 G 组与 V19 的核心对 Cycles 阶梯过级与同场景速度比；严禁采信自报 passedLevel，任一级 fail/unset/缺级即截断并退回上一级。 */
function readCoreVsCycles(input) {
  if (input === undefined) return aggregateCoreVsCyclesScenes([]);
  let rawEntries;
  if (Array.isArray(input)) {
    rawEntries = input;
  } else if (isObj(input)) {
    only(input, ['entries'], '/coreVsCycles');
    if (!Array.isArray(input.entries)) bad('/coreVsCycles/entries 必须是数组');
    rawEntries = input.entries;
  } else {
    bad('/coreVsCycles 必须是数组或含 entries 的对象');
  }
  const grouped = new Map();
  rawEntries.forEach((raw, i) => {
    const at = `/coreVsCycles/${i}`;
    const item = obj(raw, at);
    const filmType = oneOf(item.filmType, FILM_TYPE_IDS, `${at}/filmType`);
    const scene = nonBlank(item.scene, `${at}/scene`);
    if (!Array.isArray(item.gates)) bad(`${at}/gates 必须是数组`);
    const parsedGates = item.gates.map((rawGate, j) => parseCoreVsCyclesGate(rawGate, `${at}/gates/${j}`, false));
    const speed = item.speed === undefined ? null : parseCoreVsCyclesSpeed(item.speed, `${at}/speed`, false);
    const key = tupleKey(filmType, scene);
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = { filmType, scene, gates: [], gateIds: new Set(), speed: null };
      grouped.set(key, bucket);
    }
    for (const gate of parsedGates) {
      if (Object.hasOwn(gate, 'gateId')) {
        const gk = tupleKey(gate.level, gate.gateId);
        if (bucket.gateIds.has(gk)) bad(`${at}/gates 里同一级别有重复的 gateId`);
        bucket.gateIds.add(gk);
      }
      bucket.gates.push(gate);
    }
    if (speed !== null) {
      if (bucket.speed !== null && !sameSpeed(bucket.speed, speed)) {
        bad(`${at}/speed 与同场景已有 speed 不一致`, RangeError);
      }
      bucket.speed = speed;
    }
  });
  const sorted = [...grouped.values()].sort((a, b) => cmp(a.filmType, b.filmType) || cmp(a.scene, b.scene));
  const scenes = sorted.map((bucket) => {
    const gates = sortCoreVsCyclesGates(bucket.gates);
    const ladder = evaluateCoreVsCyclesLadder(gates);
    return {
      filmType: bucket.filmType,
      filmTypeLabel: FILM_TYPE_LABEL[bucket.filmType],
      scene: bucket.scene,
      passedLevel: ladder.passedLevel,
      blockedAtLevel: ladder.blockedAtLevel,
      blockedReason: ladder.blockedReason,
      gates,
      speed: bucket.speed,
    };
  });
  return aggregateCoreVsCyclesScenes(scenes);
}

/** 校验看板快照上的 coreVsCycles 结构、阶梯计算与速度比一致性（供 checkBoard / renderBoardHtml 复核）。 */
function readCoreVsCyclesSnapshot(input, at = '看板的 coreVsCycles') {
  const c = only(obj(input, at), ['maxLevel', 'overall', 'byFilmType', 'scenes'], at);
  if (c.maxLevel !== CORE_VS_CYCLES_MAX_LEVEL) bad(`${at}/maxLevel 必须是 ${CORE_VS_CYCLES_MAX_LEVEL}`, RangeError);
  if (!Array.isArray(c.scenes)) bad(`${at}/scenes 必须是数组`);
  const seen = new Set();
  let prev = null;
  const scenes = c.scenes.map((raw, i) => {
    const sAt = `${at}/scenes/${i}`;
    const s = only(obj(raw, sAt), ['filmType', 'filmTypeLabel', 'scene', 'passedLevel', 'blockedAtLevel', 'blockedReason', 'gates', 'speed'], sAt);
    const filmType = oneOf(s.filmType, FILM_TYPE_IDS, `${sAt}/filmType`);
    const expectedLabel = FILM_TYPE_LABEL[filmType];
    if (nonBlank(s.filmTypeLabel, `${sAt}/filmTypeLabel`) !== expectedLabel) {
      bad(`${sAt}/filmTypeLabel 必须是 ${expectedLabel}`);
    }
    const scene = nonBlank(s.scene, `${sAt}/scene`);
    const key = tupleKey(filmType, scene);
    if (seen.has(key)) bad(`${at}/scenes 里有重复的片型与场景`);
    seen.add(key);
    if (prev && (cmp(prev.filmType, filmType) || cmp(prev.scene, scene)) > 0) {
      bad(`${at}/scenes 未按 filmType/scene 排序`, RangeError);
    }
    prev = { filmType, scene };
    if (!Array.isArray(s.gates)) bad(`${sAt}/gates 必须是数组`);
    const gateIds = new Set();
    const gates = s.gates.map((rawGate, j) => {
      const gate = parseCoreVsCyclesGate(rawGate, `${sAt}/gates/${j}`, true);
      if (Object.hasOwn(gate, 'gateId')) {
        const gk = tupleKey(gate.level, gate.gateId);
        if (gateIds.has(gk)) bad(`${sAt}/gates 里同一级别有重复的 gateId`);
        gateIds.add(gk);
      }
      return gate;
    });
    const expected = evaluateCoreVsCyclesLadder(gates);
    const passedLevel = count(s.passedLevel, `${sAt}/passedLevel`);
    if (passedLevel !== expected.passedLevel) {
      bad(`${sAt}/passedLevel 与 gates 阶梯计算结果不一致`, RangeError);
    }
    if (s.blockedAtLevel !== expected.blockedAtLevel) {
      bad(`${sAt}/blockedAtLevel 与 gates 阶梯计算结果不一致`, RangeError);
    }
    if (s.blockedReason !== expected.blockedReason) {
      bad(`${sAt}/blockedReason 与 gates 阶梯计算结果不一致`, RangeError);
    }
    const speed = s.speed === null ? null : parseCoreVsCyclesSpeed(s.speed, `${sAt}/speed`, true);
    return {
      filmType,
      filmTypeLabel: expectedLabel,
      scene,
      passedLevel: expected.passedLevel,
      blockedAtLevel: expected.blockedAtLevel,
      blockedReason: expected.blockedReason,
      gates,
      speed,
    };
  });
  const rebuilt = aggregateCoreVsCyclesScenes(scenes);
  const byRaw = only(obj(c.byFilmType, `${at}/byFilmType`), FILM_TYPE_IDS, `${at}/byFilmType`);
  for (const { id, label: typeLabel } of FILM_TYPES) {
    const fAt = `${at}/byFilmType/${id}`;
    const given = only(obj(byRaw[id], fAt), ['label', 'maxPassedLevel', 'sceneCount', 'blockedCount'], fAt);
    const exp = rebuilt.byFilmType[id];
    if (nonBlank(given.label, `${fAt}/label`) !== typeLabel) bad(`${fAt}/label 必须是 ${typeLabel}`);
    if (count(given.maxPassedLevel, `${fAt}/maxPassedLevel`) !== exp.maxPassedLevel
      || count(given.sceneCount, `${fAt}/sceneCount`) !== exp.sceneCount
      || count(given.blockedCount, `${fAt}/blockedCount`) !== exp.blockedCount) {
      bad(`${fAt} 与 scenes 汇总不一致`, RangeError);
    }
  }
  const ov = only(obj(c.overall, `${at}/overall`), ['maxPassedLevel', 'sceneCount', 'blockedCount', 'speedCount'], `${at}/overall`);
  if (count(ov.maxPassedLevel, `${at}/overall/maxPassedLevel`) !== rebuilt.overall.maxPassedLevel
    || count(ov.sceneCount, `${at}/overall/sceneCount`) !== rebuilt.overall.sceneCount
    || count(ov.blockedCount, `${at}/overall/blockedCount`) !== rebuilt.overall.blockedCount
    || count(ov.speedCount, `${at}/overall/speedCount`) !== rebuilt.overall.speedCount) {
    bad(`${at}/overall 与 scenes 汇总不一致`, RangeError);
  }
  return rebuilt;
}

/* ---------------- 历史 ---------------- */

function historyRow(board, datedIds = new Set()) {
  const { matrix, fourIndicators: four, integrationProgress: progress, reverseIndicators: reverse } = board;
  return {
    asOf: board.asOf,
    scoredCells: matrix.scoredCells, unsupportedCells: matrix.unsupportedCells, overallMean: matrix.overallMean,
    passRateByLevel: Object.fromEntries(Object.entries(four.ceiling.passRateByLevel).map(([n, { rate }]) => [n, rate])),
    unattendedRate: four.unattended.rate,
    wallSecPerFilmSec: four.speedAndCost.wallSecPerFilmSec,
    cardsReproducedOrAbove: progress.cards.reproducedOrAbove, cardsVerifiedOrAbove: progress.cards.verifiedOrAbove, readOnlyPlaceholders: progress.cards.readOnlyPlaceholders,
    priorsVerifiedRatio: progress.priorsVerified.ratio,
    verifiedPacks: progress.packParity.verifiedPacks, ablatedSwitches: progress.packParity.ablatedSwitches,
    expectedFailQuestions: reverse.expectedFailQuestions.count, staleReproducedCards: reverse.staleReproducedCards.count,
    // 第二天拿这份和题目的校准比，版本或状态变了、或当天显式记了 updatedAt 就打标
    calibration: matrix.rows.filter((row) => row.calibration)
      .map((row) => ({ questionId: text(row.questionId, '校准题号'), version: count(row.calibration.version, '校准版本'), status: text(row.calibration.status, '校准状态'), ...(datedIds.has(row.questionId) ? { updatedAt: board.asOf } : {}) })),
    calibrationChanged: board.calibrationChanges.map((change) => change.questionId),
  };
}

function diffCalibration(prevCal, curCal, curAsOf) {
  const before = new Map(prevCal.filter(isObj).map((c) => [c.questionId, c]));
  return curCal.filter(isObj).filter((c) => {
    if (c.updatedAt === curAsOf) return true;
    const old = before.get(c.questionId);
    return Boolean(old) && (old.version !== c.version || old.status !== c.status);
  }).map((c) => c.questionId);
}

function upsert(rows, row) {
  const sorted = [...rows.filter((old) => old.asOf !== row.asOf), row].sort((a, b) => cmp(a.asOf, b.asOf));
  return sorted.map((cur, i) => {
    if (!Array.isArray(cur.calibration)) return cur;
    if (i === 0) return { ...cur, calibrationChanged: diffCalibration([], cur.calibration, cur.asOf) };
    const prev = sorted[i - 1];
    if (!Array.isArray(prev.calibration)) return cur;
    return { ...cur, calibrationChanged: diffCalibration(prev.calibration, cur.calibration, cur.asOf) };
  });
}

function datedCalibrationIds(board) {
  const ids = new Set();
  if (Array.isArray(board.history)) {
    const self = board.history.find((r) => isObj(r) && r.asOf === board.asOf);
    if (Array.isArray(self?.calibration)) {
      for (const c of self.calibration) if (isObj(c) && c.updatedAt === board.asOf && typeof c.questionId === 'string') ids.add(c.questionId);
    }
  }
  if (Array.isArray(board.calibrationChanges)) {
    for (const c of board.calibrationChanges) {
      if (!isObj(c) || typeof c.questionId !== 'string') continue;
      if (c.previous === null || (isObj(c.previous) && c.previous.version === c.version && c.previous.status === c.status)) ids.add(c.questionId);
    }
  }
  return ids;
}

// 传进来的看板已经是纯数据副本，读它时再出错只可能是结构不对
function shaped(read) {
  try { return read(); } catch (error) {
    if (error !== null && typeof error === 'object' && Object.hasOwn(error, 'code') && error.code === 'usage.bad-argument') throw error;
    return bad(`看板的结构不是 ${BOARD_FORMAT}`);
  }
}

function checkBoard(board) {
  const b = obj(intake(board, '看板'), '看板');
  if (b.format !== BOARD_FORMAT) bad(`看板的 format 不是 ${BOARD_FORMAT}`);
  day(b.asOf, '看板的 asOf');
  if (b.coreFrameShare !== undefined) readCoreFrameShare(b.coreFrameShare, '看板的 coreFrameShare');
  if (b.coreVsCycles !== undefined) readCoreVsCyclesSnapshot(b.coreVsCycles, '看板的 coreVsCycles');
  return b;
}

/* ---------------- 公开接口 ---------------- */

/**
 * 纯函数：由落盘数据算出看板快照（深冻结）。inputs 只有 asOf（YYYY-MM-DD）必填，其余没给就是没有数据：
 * questions（题目文件）、results（bench-result/0.1）、cards（卡文件）、sourceCapabilities、ledger（job-ledger/0.1 行）、jobs（作业记录）、
 * parity、energy、blindPicks、pureFunctionGate、locality、rebuild、priors、packParity、harvest、history（之前的每日行）、scoreboardMetric、frameMeta（按片型分组的每帧元数据）、coreVsCycles（G 组与 V19 核心对 Cycles 阶梯门控与速度比）。
 * 入参不是纯数据、字段不对、带私有内容，都抛 code 为 usage.bad-argument 的 TypeError / RangeError。
 */
export function buildBoard(inputs) {
  const input = only(obj(intake(inputs, '入参'), '入参'), INPUT_KEYS, '入参');
  const asOf = day(input.asOf, 'asOf');
  const cards = readCards(input.cards);
  const jobs = readJobs(input.jobs);
  const earlier = readHistory(input.history, '/history');
  // 和前一天（不是当天上一次）比校准：同一天重跑结果不变
  const previous = earlier.filter((row) => row.asOf < asOf).sort((a, b) => cmp(a.asOf, b.asOf)).at(-1);
  const { matrix, sorted, calibrationChanges } = buildMatrix({ asOf, questions: readQuestions(input.questions), results: readResults(input.results), cards, caps: readCapabilities(input.sourceCapabilities), previous });
  const rebuild = input.rebuild === undefined ? emptyObj() : only(obj(input.rebuild, '/rebuild'), ['exact', 'tolerance', 'nightlyLegacy'], '/rebuild');
  const scoreboardMetric = readScoreboardMetric(input.scoreboardMetric);
  const coreFrameShare = readFrameMeta(input.frameMeta);
  const coreVsCycles = input.coreVsCycles === undefined ? null : readCoreVsCycles(input.coreVsCycles);
  const board = {
    format: BOARD_FORMAT,
    asOf,
    fourIndicators: {
      ceiling: { passRateByLevel: passRateByLevel(matrix.rows), parityHeadroom: parityHeadroom(input.parity), energyRulers: energyRulers(input.energy), blindPick: blindPick(input.blindPicks) },
      unattended: unattended(jobs),
      speedAndCost: speedAndCost(input.ledger, jobs),
      controllability: {
        pureFunctionGate: tally(input.pureFunctionGate, '/pureFunctionGate'),
        locality: tally(input.locality, '/locality'),
        rebuild: { exact: tally(rebuild.exact, '/rebuild/exact'), tolerance: tally(rebuild.tolerance, '/rebuild/tolerance'), nightlyLegacy: tally(rebuild.nightlyLegacy, '/rebuild/nightlyLegacy') },
      },
    },
    coreFrameShare,
    matrix,
    integrationProgress: { cards: cardProgress(cards), examCoverage: examCoverage(sorted, matrix.rows, cards), priorsVerified: priorsVerified(input.priors), packParity: packParity(input.packParity), harvest: harvest(input.harvest) },
    reverseIndicators: {
      expectedFailQuestions: { count: matrix.rows.filter((row) => row.expectedFail).length, ids: matrix.rows.filter((row) => row.expectedFail).map((row) => row.questionId) },
      staleReproducedCards: staleReproducedCards(cards, asOf),
    },
    calibrationChanges,
    ...(scoreboardMetric ? { scoreboardMetric } : {}),
    ...(coreVsCycles ? { coreVsCycles } : {}),
  };
  const datedIds = new Set(sorted.filter((q) => q.calibration?.updatedAt === asOf).map((q) => q.id));
  return freezeOut({ ...board, history: upsert(earlier, historyRow(board, datedIds)) });
}

/** 把看板当天的摘要行并进历史：同一天覆盖，不同天追加，按日期升序。回新数组（深冻结），不改传入的。 */
export function appendBoardHistory(history, board) {
  const rows = readHistory(intake(history, '历史'), '历史');
  const checked = checkBoard(board);
  const datedIds = datedCalibrationIds(checked);
  const today = shaped(() => historyRow(checked, datedIds));
  readHistory(toPlain([today]), '当日摘要');
  return freezeOut(upsert(rows, today));
}

/* ---------------- 静态页 ---------------- */

const ESCAPE_MAP = Object.assign(emptyObj(), { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });
/** HTML 实体转义：& < > " ' 五个字符；只收原始标量值（零陷阱调用）。 */
export function escapeHtml(value) {
  if (value !== null && value !== undefined && typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) {
    bad('escapeHtml 只收字符串、有限数、布尔值或空值');
  }
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

// 模板里插进去的值一律转义，只有 h 自己拼出来的片段原样放；null、undefined 写成破折号
class Markup { constructor(html) { this.html = html; } }
const embed = (value) => (Array.isArray(value) ? value.map(embed).join('') : value instanceof Markup ? value.html : escapeHtml(value ?? '—'));
const h = (strings, ...values) => new Markup(strings.reduce((out, part, i) => out + part + (i < values.length ? embed(values[i]) : ''), ''));

const fmt = (value, digits = 3) => {
  if (typeof value !== 'number') return '—';
  const scaled = Math.round(value * 10 ** digits) / 10 ** digits;
  return String(Number.isFinite(scaled) ? scaled : value);
};
const pct = (value) => (typeof value === 'number' ? `${Number.isFinite(value * 100) ? fmt(value * 100, 1) : String(value)}%` : '—');
// 用整数精确半进位保留一位小数，消除 3/2000 (0.15%) 等十进制半点的 IEEE-754 浮点误差
const sharePct = (coreFrames, totalFrames) => {
  if (!Number.isSafeInteger(coreFrames) || !Number.isSafeInteger(totalFrames) || coreFrames < 0 || totalFrames < 0) return '—';
  if (totalFrames === 0) return '0.0%';
  const c = BigInt(coreFrames);
  const t = BigInt(totalFrames);
  const tenths = (c * 2000n + t) / (2n * t);
  return `${tenths / 10n}.${tenths % 10n}%`;
};
const frac = (t) => (t?.status === 'not-run' ? '未跑' : `${fmt(t?.passed, 0)} / ${fmt(t?.total, 0)}（${pct(t?.rate)}）`);
const label = (table, value) => (typeof value === 'string' && Object.hasOwn(table, value) ? table[value] : value);
const STATUS_LABEL = { pass: '通过', fail: '没过', error: '出错', timeout: '超时', failed: '判分失败', 'expected-fail': '预期失败' };
const CARD_LABEL = { 'read-only': '只读过', candidate: '候选', reproduced: '复现过', verified: '量测通过', 'production-proven': '成片验证过' };
const NAME_LABEL = { [NO_NAME]: '未注明' };
const facts = (pairs) => h`<dl>${pairs.map(([term, value]) => h`<dt>${term}</dt><dd>${value}</dd>`)}</dl>`;

const STYLE = `
:root{color-scheme:light dark;--line:#8886;--soft:#8882}
body{font:15px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0 auto;padding:24px;max-width:1280px}
h1{margin:0}h2{margin:32px 0 12px;border-bottom:1px solid var(--line);padding-bottom:4px}h3{margin:0 0 8px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
article{border:1px solid var(--line);border-radius:8px;padding:12px 16px}
dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:0}dt{opacity:.75}dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
caption{text-align:left;opacity:.75;padding:4px 0}th,td{border:1px solid var(--line);padding:4px 8px;text-align:center;vertical-align:top}
th[scope=row]{text-align:left}thead th,tfoot th,tfoot td{background:var(--soft)}
.pass{font-weight:600}.fail,.error,.timeout,.failed{text-decoration:underline dotted}.na,.unrun{opacity:.7;font-size:13px}
.badge{display:inline-block;border:1px solid var(--line);border-radius:10px;padding:0 8px;font-size:12px;margin-left:4px;white-space:nowrap}
.note{opacity:.75;font-size:13px}`;

function cellHtml(cell) {
  if (cell.kind === UNSUPPORTED) return h`<td class="na">${UNSUPPORTED_REASON}</td>`;
  if (cell.kind !== 'scored') return h`<td class="unrun">未跑</td>`;
  return h`<td class="${cell.status}">${fmt(cell.score)}<br><small>${label(STATUS_LABEL, cell.status)}</small></td>`;
}

function page(board) {
  const { fourIndicators: four, matrix, integrationProgress: progress, reverseIndicators: reverse } = board;
  const { ceiling, unattended: un, speedAndCost: cost, controllability: control } = four;
  const who = (column) => h`${label(NAME_LABEL, column.source)}<br><small>${label(NAME_LABEL, column.model)}</small>`;
  const rulers = ceiling.energyRulers && Object.entries(ceiling.energyRulers).map(([name, r]) => [`能量尺子 ${name}`, r ? `均值 ${fmt(r.mean, 4)}，最差 ${fmt(r.worst, 4)}（${fmt(r.samples, 0)} 个读数）` : '没有读数']);
  const indicators = h`<div class="cards">
<article><h3>画面上限</h3>${facts([
    ...Object.entries(ceiling.passRateByLevel).map(([n, t]) => [`${n} 级通过率`, frac(t)]),
    ['对拍余量', ceiling.parityHeadroom ? `最小 ${fmt(ceiling.parityHeadroom.minMargin, 4)}（${fmt(ceiling.parityHeadroom.count, 0)} 项，${fmt(ceiling.parityHeadroom.belowThreshold, 0)} 项在门限外）` : '没有数据'],
    ...(rulers ?? [['三把能量尺子', '没有数据']]),
    ['盲选', ceiling.blindPick ? `赢或平 ${fmt(ceiling.blindPick.winsOrTies, 0)} / ${fmt(ceiling.blindPick.total, 0)}（${pct(ceiling.blindPick.rate)}）` : '没有数据'],
  ])}</article>
<article><h3>无人值守成功率</h3>${facts([
    ['委托与考题作业', `${fmt(un.succeeded, 0)} / ${fmt(un.total, 0)}（${pct(un.rate)}）`],
    ['亲手模式自选模板（单列，不计入上面）', `${fmt(un.selfSelected.succeeded, 0)} / ${fmt(un.selfSelected.total, 0)}（${pct(un.selfSelected.rate)}）`],
  ])}<p class="note">基础谓词全过且人工介入 0 次才算成功。</p></article>
<article><h3>速度与成本</h3>${facts([
    ['每秒成片的墙钟秒', fmt(cost.wallSecPerFilmSec, 2)],
    ['每秒成片的显卡秒', `${fmt(cost.gpuSecPerFilmSec, 2)}${cost.gpuIsLowerBound ? '（有的行没有实测，只是下限）' : ''}`],
    ['每秒成片的 token', fmt(cost.tokensPerFilmSec, 0)],
    ...Object.entries(cost.tokensByTierPerFilmSec ?? {}).map(([tier, value]) => [`其中 ${tier} 档`, fmt(value, 0)]),
    ['渲帧数 ÷ 交付帧数', fmt(cost.renderedPerDelivered, 2)],
    ['平均迭代轮数', fmt(cost.meanRounds, 2)],
    ['出了成片的作业', `${fmt(cost.filmJobs, 0)} 个，共 ${fmt(cost.filmSeconds, 1)} 秒；账本 ${fmt(cost.totals.count, 0)} 行`],
  ])}</article>
<article><h3>可控与可复现</h3>${facts([
    ['纯函数门通过率', frac(control.pureFunctionGate)],
    ['局部性', frac(control.locality)],
    ['重建：同机比哈希', frac(control.rebuild.exact)],
    ['重建：跨机容差', frac(control.rebuild.tolerance)],
    ['旧作品夜间重建', frac(control.rebuild.nightlyLegacy)],
  ])}</article>
</div>`;

  const coreShare = board.coreFrameShare === undefined ? readFrameMeta(undefined) : readCoreFrameShare(board.coreFrameShare, '看板的 coreFrameShare');
  const coreShareHtml = h`<div class="cards">
${FILM_TYPES.map(({ id, label: typeLabel }) => {
    const item = coreShare.byFilmType[id];
    return h`<article data-film-type="${id}"><h3>${typeLabel}</h3>${facts([
      ['核心出帧占比', sharePct(item.coreFrames, item.totalFrames)],
      ['帧数', `${fmt(item.coreFrames, 0)} / ${fmt(item.totalFrames, 0)} 帧`],
    ])}</article>`;
  })}
</div>
${facts([
    ['总计', `${sharePct(coreShare.overall.coreFrames, coreShare.overall.totalFrames)}（${fmt(coreShare.overall.coreFrames, 0)} / ${fmt(coreShare.overall.totalFrames, 0)} 帧）`],
  ])}
<p class="note">口径仅认宿主每帧元数据 source.renderer === "core"，不采信作业自报；接管过门前每格为 0 亦照样显示。</p>`;

  const coreVsCycles = board.coreVsCycles === undefined ? readCoreVsCycles(undefined) : readCoreVsCyclesSnapshot(board.coreVsCycles, '看板的 coreVsCycles');
  const cvcSummaryRows = FILM_TYPES.map(({ id, label: typeLabel }) => {
    const item = coreVsCycles.byFilmType[id];
    return h`<tr><th scope="row">${typeLabel}</th><td>L${fmt(item.maxPassedLevel, 0)} / L${fmt(coreVsCycles.maxLevel, 0)}</td><td>${fmt(item.sceneCount, 0)}</td><td>${fmt(item.blockedCount, 0)}</td></tr>`;
  });
  const cvcSceneRows = coreVsCycles.scenes.length
    ? coreVsCycles.scenes.map((scene) => {
      const levelClass = scene.blockedAtLevel !== null ? 'fail' : scene.passedLevel > 0 ? 'pass' : 'unrun';
      const badge = scene.blockedAtLevel !== null
        ? h`<span class="badge fail">L${fmt(scene.blockedAtLevel, 0)} ${label(BLOCKED_REASON_LABEL, scene.blockedReason)}（退回 L${fmt(scene.passedLevel, 0)}）</span>`
        : h`<span class="badge pass">连续通过至 L${fmt(scene.passedLevel, 0)}</span>`;
      const ratioText = (v) => `${fmt(v, v < 0.01 ? 4 : 2)}x`;
      const speedRatioCell = scene.speed ? `${ratioText(scene.speed.speedRatio)}（核心/Cycles ${ratioText(scene.speed.coreOverCyclesRatio)}）` : '—';
      const timingCell = scene.speed ? `${fmt(scene.speed.coreMs, 2)} ms / ${fmt(scene.speed.cyclesMs, 2)} ms` : '—';
      const gpuCell = scene.speed ? scene.speed.gpu : '—';
      const samplesCell = scene.speed ? `${fmt(scene.speed.samples, 0)} spp` : '—';
      const resolutionCell = scene.speed ? `${fmt(scene.speed.resolution[0], 0)}×${fmt(scene.speed.resolution[1], 0)}` : '—';
      return h`<tr><td>${scene.filmTypeLabel}</td><th scope="row">${scene.scene}</th><td class="${levelClass}">L${fmt(scene.passedLevel, 0)} / L${fmt(coreVsCycles.maxLevel, 0)}</td><td>${badge}</td><td>${speedRatioCell}</td><td>${timingCell}</td><td>${gpuCell}</td><td>${samplesCell}</td><td>${resolutionCell}</td></tr>`;
    })
    : [h`<tr><td colspan="9" class="unrun">暂无核心对 Cycles 门控读数（接管过门前显示零态）</td></tr>`];
  const coreVsCyclesHtml = h`<div class="scroll"><table data-core-vs-cycles-summary>
<caption>按四类片型汇总：最高连续过级（0–8 级）、已测场景数与阻塞/退级场景数。</caption>
<thead><tr><th scope="col">片型</th><th scope="col">最高连续过级</th><th scope="col">已测场景数</th><th scope="col">阻塞/退级场景数</th></tr></thead>
<tbody>${cvcSummaryRows}</tbody>
<tfoot><tr><th scope="row">总计</th><td>L${fmt(coreVsCycles.overall.maxPassedLevel, 0)} / L${fmt(coreVsCycles.maxLevel, 0)}</td><td>${fmt(coreVsCycles.overall.sceneCount, 0)}</td><td>${fmt(coreVsCycles.overall.blockedCount, 0)}</td></tr></tfoot>
</table></div>
<div class="scroll"><table data-core-vs-cycles-scenes>
<caption>逐场景阶梯过级与同场景同采样速度比（速度比旁并排展示显卡、采样数与分辨率）。</caption>
<thead><tr><th scope="col">片型</th><th scope="col">场景</th><th scope="col">当前阶梯级数</th><th scope="col">门控/退级标记</th><th scope="col">速度比（Cycles / 核心）</th><th scope="col">核心耗时 / Cycles 耗时</th><th scope="col">显卡</th><th scope="col">采样数</th><th scope="col">分辨率</th></tr></thead>
<tbody>${cvcSceneRows}</tbody>
</table></div>
<p class="note">阶梯过级仅按 1–8 级逐级门控计算，不采信自报级别；任一级判红（fail）、未定线（unset）或缺级时即在该级截断并退回上一级；速度比必须并排注明显卡、采样数与分辨率。</p>`;

  const grid = h`<div class="scroll"><table>
<caption>每格是这道题在这个帧源、这个做题模型上最新一次的得分（0 到 1）。写着「${UNSUPPORTED_REASON}」的格和没跑的格不进任何均分；做题出错、超时、预期失败记 0 分，照算。</caption>
<thead><tr><th scope="col">考题</th>${matrix.columns.map((column) => h`<th scope="col">${who(column)}</th>`)}<th scope="col">行均分</th></tr></thead>
<tbody>${matrix.rows.map((row) => h`<tr><th scope="row">${row.hidden ? `隐藏题 ${row.questionId}` : row.questionId} <small>${fmt(row.level, 0)} 级</small>${row.hidden ? '' : h` ${row.title ?? ''}`}${row.expectedFail ? h`<span class="badge">预期失败</span>` : ''}${row.calibrationChanged ? h`<span class="badge">今日校准变更</span>` : ''}</th>${row.cells.map(cellHtml)}<td>${fmt(row.rowMean)}</td></tr>`)}</tbody>
<tfoot><tr><th scope="row">列均分</th>${matrix.columns.map((column) => h`<td>${fmt(column.mean)}</td>`)}<td>${fmt(matrix.overallMean)}</td></tr></tfoot>
</table></div>
${facts([
    ['总均分', `${fmt(matrix.overallMean)}（${fmt(matrix.scoredCells, 0)} 格计分，${fmt(matrix.unsupportedCells, 0)} 格帧源没有这项能力，${fmt(matrix.unrunCells, 0)} 格没跑）`],
    ...matrix.sourceMeans.map((s) => [h`帧源 ${label(NAME_LABEL, s.source)} 均分`, `${fmt(s.mean)}（${fmt(s.scoredCells, 0)} 格）`]),
    ...matrix.modelMeans.map((m) => [h`模型 ${label(NAME_LABEL, m.model)} 均分`, `${fmt(m.mean)}（${fmt(m.scoredCells, 0)} 格）`]),
  ])}`;

  const { cards, examCoverage: exam, priorsVerified: priors, packParity: pack, harvest: got } = progress;
  const integration = h`<div class="cards">
<article><h3>卡的数量与状态分布</h3>${facts([
    ['复现过及以上', fmt(cards.reproducedOrAbove, 0)], ['其中量测通过及以上', fmt(cards.verifiedOrAbove, 0)], ['其中成片验证过', fmt(cards.productionProven, 0)],
    ['只读过的占位卡（单独数）', fmt(cards.readOnlyPlaceholders, 0)], ['候选卡（单独数）', fmt(cards.candidates, 0)],
  ])}</article>
<article><h3>考题覆盖</h3>${facts([
    ['可判分的题', `${fmt(exam.scorableQuestions.scorable, 0)} / ${fmt(exam.scorableQuestions.total, 0)}`],
    ['挂了题的卡', `${fmt(exam.cardsWithExam.withExam, 0)} / ${fmt(exam.cardsWithExam.total, 0)}（${pct(exam.cardsWithExam.ratio)}）`],
    ...exam.perQuestion.map((q) => [h`${q.questionId} 要的卡到量测通过`, q.noCardNeeds ? '不要卡' : `${fmt(q.verified, 0)} / ${fmt(q.needs, 0)}（${pct(q.ratio)}）`]),
  ])}</article>
<article><h3>参数的验证比例</h3>${facts([['在我方栈里读回过', `${fmt(priors.verifiedCount, 0)} / ${fmt(priors.baselineTotal, 0)}（${pct(priors.ratio)}）`], ['已迁入的明细条数', fmt(priors.detailCount, 0)]])}</article>
<article><h3>原包立靶覆盖</h3>${facts([['过了确定性验收的包', `${fmt(pack.verifiedPacks, 0)} / ${fmt(pack.totalPacks, 0)}`], ['跑过消融的开关', `${fmt(pack.ablatedSwitches, 0)} / ${fmt(pack.totalSwitches, 0)}`]])}</article>
<article><h3>收获率</h3>${facts([['起草的候选', fmt(got.drafted, 0)], ['晋升', fmt(got.promoted, 0)], ['归档', fmt(got.archived, 0)], ['走到复现过的候选', fmt(got.reproducedPromotions, 0)]])}</article>
</div>
<div class="scroll"><table><caption>卡按类别 × 落点 × 状态（一张卡有几个落点就数几次）</caption>
<thead><tr><th scope="col">类别</th><th scope="col">落点</th><th scope="col">状态</th><th scope="col">张数</th></tr></thead>
<tbody>${cards.distribution.map((d) => h`<tr><td>${d.category}</td><td>${d.livesIn}</td><td>${label(CARD_LABEL, d.status)}</td><td>${fmt(d.count, 0)}</td></tr>`)}</tbody></table></div>`;

  const { expectedFailQuestions: expected, staleReproducedCards: stale } = reverse;
  const repeatMetric = board.scoreboardMetric === undefined ? null : readScoreboardMetric(board.scoreboardMetric, '看板的 scoreboardMetric');
  const repeatRows = repeatMetric
    ? [
      ...(repeatMetric.weekStart && repeatMetric.weekEnd ? [['统计自然周', `${repeatMetric.weekStart} 至 ${repeatMetric.weekEnd}`]] : []),
      ['重复打回率（应当下降）', pct(repeatMetric.repeatRate)],
      ['重复打回 / 总打回', `${fmt(repeatMetric.repeatCount, 0)} / ${fmt(repeatMetric.total, 0)}`],
      ['首次打回', fmt(repeatMetric.firstTimeCount, 0)],
    ]
    : [];
  const repeatHtml = repeatMetric ? h`<article><h3>周重复打回率</h3>${facts(repeatRows)}</article>` : h``;
  const reverseHtml = h`<div class="cards">
<article><h3>预期失败的题</h3>${facts([['数量（应当先涨后跌）', fmt(expected.count, 0)], ['题号', expected.ids.join('、') || '没有']])}</article>
<article><h3>停在复现过超过 ${fmt(stale.thresholdDays, 0)} 天的卡</h3>${facts([['数量（应当接近 0）', fmt(stale.count, 0)], ['卡', stale.ids.join('、') || '没有'], ['没写日期、算不了的', stale.undated.join('、') || '没有']])}<p class="note">只读过的占位卡和候选卡不算欠账。</p></article>
${repeatHtml}
</div>`;

  const trend = h`<div class="scroll"><table><caption>每天一行；同一天重跑覆盖当天那行。</caption>
<thead><tr><th scope="col">日期</th><th scope="col">计分格</th><th scope="col">总均分</th>${[1, 2, 3, 4, 5].map((n) => h`<th scope="col">${n} 级</th>`)}<th scope="col">无人值守</th><th scope="col">每秒成片墙钟秒</th><th scope="col">复现过及以上</th><th scope="col">量测通过及以上</th><th scope="col">参数验证</th><th scope="col">预期失败题</th><th scope="col">滞留卡</th><th scope="col">校准变更</th></tr></thead>
<tbody>${board.history.map((row) => h`<tr><th scope="row">${row.asOf}</th><td>${fmt(row.scoredCells, 0)}</td><td>${fmt(row.overallMean)}</td>${[1, 2, 3, 4, 5].map((n) => h`<td>${pct(row.passRateByLevel?.[n])}</td>`)}<td>${pct(row.unattendedRate)}</td><td>${fmt(row.wallSecPerFilmSec, 2)}</td><td>${fmt(row.cardsReproducedOrAbove, 0)}</td><td>${fmt(row.cardsVerifiedOrAbove, 0)}</td><td>${pct(row.priorsVerifiedRatio)}</td><td>${fmt(row.expectedFailQuestions, 0)}</td><td>${fmt(row.staleReproducedCards, 0)}</td><td>${Array.isArray(row.calibrationChanged) && row.calibrationChanged.length ? row.calibrationChanged.join('、') : ''}</td></tr>`)}</tbody></table></div>`;

  return h`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>北冥看板 ${board.asOf}</title>
<style>${new Markup(STYLE)}</style>
</head>
<body>
<header><h1>北冥看板</h1><p class="note">截至 <time>${board.asOf}</time>，由结果文件生成（${board.format}）。</p></header>
<main>
<section><h2>四个指标</h2>${indicators}</section>
<section><h2>核心出帧占比</h2>${coreShareHtml}</section>
<section data-section="core-vs-cycles"><h2>核心对 Cycles</h2>${coreVsCyclesHtml}</section>
<section><h2>考题 × 帧源 × 做题模型</h2>${grid}</section>
<section><h2>整合进度</h2>${integration}</section>
<section><h2>反向指标</h2>${reverseHtml}</section>
<section><h2>每日趋势</h2>${trend}</section>
</main>
</body>
</html>
`.html;
}

/** 离线静态页：一份自包含的 HTML（内联样式，没有脚本、外链和网络资源），动态文字全部转义。入参同样过纯数据与泄露门禁。 */
export function renderBoardHtml(board) {
  const checked = checkBoard(board);
  return shaped(() => page(checked));
}

/* ---------------- 命令行 ---------------- */

// 做题目录等是做题方能写的地方，里面的 JSON 不当成绩读
const RUN_PRIVATE_DIRS = new Set(['worktree', 'session', 'tmp', 'transcript', '.git', 'node_modules']);
const CARD_SKIP_DIRS = new Set(['.git', 'node_modules', 'priors-data']);
const EXTRA_KEYS = ['sourceCapabilities', 'jobs', 'parity', 'energy', 'blindPicks', 'pureFunctionGate', 'locality', 'rebuild', 'packParity', 'harvest', 'scoreboardMetric', 'frameMeta', 'coreVsCycles'];
const hasPrivateMarker = (s) => scanQuestionLeaks(String(s)).some((l) => l.code !== 'local-path');
function shownPath(s) {
  return /^(?:[\\/]|file:|~[\\/]|[a-z]:[\\/])/i.test(s) || hasPrivateText(s) ? '<路径已隐去>' : s;
}
const wrong = (message) => usageError(safeMsg(message), '加 --help 查看用法', 'usage.bad-argument');
function cliPath(p, what) {
  if (hasPrivateMarker(p)) throw wrong(`${what}路径含有私有目录或标记，不读写`);
  return p;
}
const DEFAULT_SKIP_DIRS = new Set(['.git', 'node_modules']);
const errCode = (e, fallback) => (e !== null && typeof e === 'object' && Object.hasOwn(e, 'code') && typeof e.code === 'string' ? e.code : fallback);
function statSafe(target, what) {
  try { return fs.statSync(target, { throwIfNoEntry: false }) ?? null; } catch (e) {
    throw wrong(`读不到${what} ${shownPath(target)}（${errCode(e, '读取失败')}）`);
  }
}

function hasDuplicateJsonKeys(raw) {
  const open = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charCodeAt(i);
    if (ch === 123 || ch === 91) open.push(ch === 123 ? new Set() : null);
    else if (ch === 125 || ch === 93) open.pop();
    else if (ch === 34) {
      const start = i;
      for (i += 1; i < raw.length && raw.charCodeAt(i) !== 34; i += 1) {
        if (raw.charCodeAt(i) === 92) i += 1;
      }
      let next = i + 1;
      while (next < raw.length && raw.charCodeAt(next) <= 32) next += 1;
      if (raw.charCodeAt(next) === 58) {
        const key = JSON.parse(raw.slice(start, i + 1));
        if (open.at(-1).has(key)) return true;
        open.at(-1).add(key);
        i = next;
      }
    }
  }
  return false;
}

function rejectRawLeaks(raw, what) {
  let leaks;
  try { leaks = scanQuestionLeaks(raw); } catch {
    throw wrong(`${what}含有超长词元，无法完成泄露扫描`);
  }
  if (leaks.length) throw wrong(`${what}里有私有内容，不生成看板：${leaks.slice(0, 8).map((l) => `${l.code}@L${l.line}`).join('，')}`);
}

function readJsonFile(file, what, { scanRaw = true, rejectDuplicates = true } = {}) {
  let raw, data;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { throw wrong(`读不到${what} ${shownPath(file)}（${errCode(e, '读取失败')}）`); }
  // 不回显解析器的报错：它会带出错处的原文
  try { data = JSON.parse(raw); } catch { throw wrong(`${what} ${shownPath(file)} 不是合法的 JSON`); }
  if (scanRaw) rejectRawLeaks(raw, what);
  if (rejectDuplicates && hasDuplicateJsonKeys(raw)) throw wrong(`${what} ${shownPath(file)} 含有重复的 JSON 键`);
  return { raw, data };
}

function jsonFilesIn(dir, what, skipDirs = DEFAULT_SKIP_DIRS, readOpts = { scanRaw: false, rejectDuplicates: false }) {
  if (!statSafe(dir, what)?.isDirectory()) throw wrong(`${what} ${shownPath(dir)} 不是目录`);
  const found = [];
  (function visit(cur) {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) {
      throw wrong(`读不到${what} ${shownPath(cur)}（${errCode(e, '读取失败')}）`);
    }
    for (const entry of entries) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) visit(cliPath(abs, what));
      } else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.schema.json')) {
        found.push({ abs: cliPath(abs, what), rel: path.relative(dir, abs).split(path.sep).join('/') });
      }
    }
  })(dir);
  return found.sort((a, b) => cmp(a.rel, b.rel)).map((entry) => ({ ...entry, ...readJsonFile(entry.abs, what, readOpts) }));
}

// 在同一把锁下读历史、合并当天并发布三份文件。历史最后替换，重试仍能从上次完整的历史恢复。
function publishBoard(outDir, inputs) {
  const fresh = buildBoard(inputs);
  fs.mkdirSync(outDir, { recursive: true });
  return withFileLock(path.join(outDir, 'history.json'), (locked) => {
    const history = locked();
    const dir = path.dirname(history);
    const names = ['board.json', 'index.html', 'history.json'];
    const existing = names.filter((name) => {
      const st = fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false });
      if (st && !st.isFile()) throw wrong('看板输出目标必须是普通文件');
      return Boolean(st);
    });
    const board = existing.includes('history.json') ? buildBoard({ ...inputs, history: readJsonFile(history, '已有的历史').data }) : fresh;
    const content = [JSON.stringify(board, null, 2) + '\n', renderBoardHtml(board), JSON.stringify(board.history, null, 2) + '\n'];
    const staging = fs.mkdtempSync(path.join(dir, '.board-'));
    const replaced = [];
    try {
      for (const name of existing) fs.copyFileSync(path.join(dir, name), path.join(staging, `${name}.old`));
      names.forEach((name, i) => fs.writeFileSync(path.join(staging, name), content[i]));
      for (const name of names) {
        fs.renameSync(path.join(staging, name), path.join(dir, name));
        replaced.push(name);
      }
    } catch (error) {
      for (const name of replaced.reverse()) {
        if (existing.includes(name)) fs.renameSync(path.join(staging, `${name}.old`), path.join(dir, name));
        else fs.unlinkSync(path.join(dir, name));
      }
      throw error;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return board;
  });
}

function extractCoreVsCyclesFileEntries(data) {
  if (Array.isArray(data)) return data;
  if (isObj(data) && Object.hasOwn(data, 'entries') && !Object.hasOwn(data, 'filmType')) {
    if (!Array.isArray(data.entries)) throw wrong('核心对 Cycles 结果文件的 entries 必须是数组');
    return data.entries;
  }
  if (isObj(data) && Object.hasOwn(data, 'filmType') && Object.hasOwn(data, 'scene')) return [data];
  throw wrong('核心对 Cycles 结果文件必须是条目数组、单条场景对象或含 entries 数组的对象');
}

const BUILD = {
  spec: {
    summary: '生成看板：board.json（bench-board/0.1）、history.json（每天一行）、index.html（离线静态页）',
    usage: 'node beiming/bench/board.mjs build --out-dir <目录> [--as-of <YYYY-MM-DD>] [参数]',
    options: {
      'as-of': { type: 'string', placeholder: '日期', desc: '看板是哪一天的（YYYY-MM-DD）；不写取 UTC 当天' },
      'out-dir': { type: 'string', placeholder: '目录', desc: '写到哪里；里面已有的 history.json 会接着往下记' },
      'questions-dir': { type: 'string', placeholder: '目录', desc: '题目文件（question/0.1），递归找 .json' },
      'results-dir': { type: 'string', placeholder: '目录', desc: '跑题器的运行根，递归找 bench-result/0.1（做题目录里的不读）' },
      ledger: { type: 'string', placeholder: '文件', desc: '作业账本 ledger.jsonl（job-ledger/0.1）' },
      'cards-dir': { type: 'string', placeholder: '目录', desc: '技术卡目录，递归找 card.json' },
      priors: { type: 'list', placeholder: '文件,…', desc: '先验表（priors/0.1），可以写几份' },
      'core-vs-cycles': { type: 'string', placeholder: '文件或目录', desc: '核心对 Cycles（G 组与 V19）结果 JSON 文件或目录' },
      extra: { type: 'string', placeholder: '文件', desc: `别处来的数，一个 JSON 对象，键只能是 ${EXTRA_KEYS.join('、')}` },
    },
    notes: ['输入里有 lab://、原包或案例库路径、exams-hidden、本机路径、裸哈希，或题目没过校验时不写任何文件（exit 2 / 4）。', '标准输出是一行 JSON 摘要。'],
  },
  handler: ({ opts }) => {
    if (!opts['out-dir']) throw usageError('缺少 --out-dir', '写 --out-dir <目录>', 'usage.missing-argument');
    const outDir = path.resolve(cliPath(opts['out-dir'], '输出目录'));
    // 纯函数不读墙钟：没写日期时在这里取一次 UTC 当天
    const inputs = { asOf: opts['as-of'] ?? new Date().toISOString().slice(0, 10) };
    if (opts['questions-dir']) {
      inputs.questions = jsonFilesIn(cliPath(opts['questions-dir'], '题目目录'), '题目目录').filter(({ data }) => data?.format === QUESTION_FORMAT).map(({ raw, data, rel }) => {
        // 用原文校验：重复的键里夹带的泄露只有原文查得出。不回显逐条问题（隐藏题的内容可能在里面）
        if (!validateQuestion(raw).ok) throw contractError('contract.question-invalid', `题目文件 ${shownPath(rel)} 没过 ${QUESTION_FORMAT} 校验`, '用 beiming/bench 的 validateQuestion 看逐条问题，改完重跑');
        return data;
      });
    }
    if (opts['results-dir']) {
      inputs.results = jsonFilesIn(cliPath(opts['results-dir'], '结果目录'), '结果目录', RUN_PRIVATE_DIRS).filter(({ data }) => data?.format === RESULT_FORMAT)
        .map(({ raw, data, rel }) => {
          rejectRawLeaks(raw, '结果文件');
          if (hasDuplicateJsonKeys(raw)) throw wrong(`结果文件 ${shownPath(rel)} 含有重复的 JSON 键`);
          return data;
        });
    }
    if (opts.ledger) {
      const ledgerFile = cliPath(opts.ledger, '账本');
      if (!statSafe(ledgerFile, '账本')?.isFile()) throw wrong(`读不到账本 ${shownPath(ledgerFile)}`);
      let rawLedger;
      try { rawLedger = fs.readFileSync(ledgerFile, 'utf8'); } catch (e) { throw wrong(`读不到账本 ${shownPath(ledgerFile)}（${errCode(e, '读取失败')}）`); }
      inputs.ledger = [];
      for (const [index, line] of rawLedger.split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (hasDuplicateJsonKeys(line)) throw wrong('重复的 JSON 键');
          inputs.ledger.push(normalizeLedgerEntry(entry));
        } catch {
          throw wrong(`账本第 ${index + 1} 行无效`);
        }
      }
    }
    if (opts['cards-dir']) {
      inputs.cards = jsonFilesIn(cliPath(opts['cards-dir'], '卡目录'), '卡目录', CARD_SKIP_DIRS).filter(({ rel, data }) => path.posix.basename(rel) === 'card.json' || data?.format === 'card/0.1')
        .map(({ raw, data, rel }) => {
          rejectRawLeaks(raw, '卡文件');
          if (hasDuplicateJsonKeys(raw)) throw wrong(`卡文件 ${shownPath(rel)} 含有重复的 JSON 键`);
          return data;
        });
    }
    if (opts.priors.length) inputs.priors = opts.priors.map((file) => readJsonFile(cliPath(file, '先验表'), '先验表').data);
    if (opts.extra) {
      const { data } = readJsonFile(cliPath(opts.extra, '补充数据'), '补充数据');
      if (!isObj(data) || !Object.keys(data).every((key) => EXTRA_KEYS.includes(key))) throw wrong(`--extra 要是一个对象，键只能是 ${EXTRA_KEYS.join('、')}`);
      Object.assign(inputs, data);
    }
    if (opts['core-vs-cycles']) {
      if (inputs.coreVsCycles !== undefined) throw wrong('--core-vs-cycles 与 --extra.coreVsCycles 不能同时提供');
      const target = cliPath(opts['core-vs-cycles'], '核心对 Cycles 结果');
      const st = statSafe(target, '核心对 Cycles 结果');
      if (!st || (!st.isFile() && !st.isDirectory())) throw wrong(`读不到核心对 Cycles 结果 ${shownPath(target)}`);
      inputs.coreVsCycles = st.isFile()
        ? extractCoreVsCyclesFileEntries(readJsonFile(target, '核心对 Cycles 结果').data)
        : jsonFilesIn(target, '核心对 Cycles 结果', DEFAULT_SKIP_DIRS, { scanRaw: true, rejectDuplicates: true })
          .flatMap(({ data }) => extractCoreVsCyclesFileEntries(data));
    }
    let board;
    try {
      board = publishBoard(outDir, inputs);
    } catch (e) {
      if (errCode(e) === 'usage.bad-argument') throw wrong(e.message);
      throw wrong(`无法发布看板（${errCode(e, '读写失败')}）`);
    }
    const summary = {
      format: board.format, asOf: board.asOf,
      questions: inputs.questions?.length ?? 0, results: inputs.results?.length ?? 0, cards: inputs.cards?.length ?? 0, ledgerRows: inputs.ledger?.length ?? 0,
      priors: board.integrationProgress.priorsVerified.detailCount, historyRows: board.history.length,
      overallMean: board.matrix.overallMean, scoredCells: board.matrix.scoredCells, unsupportedCells: board.matrix.unsupportedCells,
      coreVsCyclesScenes: board.coreVsCycles?.overall.sceneCount ?? 0,
    };
    return { data: summary, outputs: ['board.json', 'history.json', 'index.html'], text: JSON.stringify(summary) };
  },
};

function sanitizeArgv(rawArgv) {
  const valueOpts = new Set(Object.keys(BUILD.spec.options));
  const redactArg = (arg) => {
    const value = arg.startsWith('--') ? arg.slice(2) : arg;
    const eq = value.indexOf('=');
    if (shownPath(value) !== value || (eq >= 0 && shownPath(value.slice(eq + 1)) !== value.slice(eq + 1))) {
      return arg.startsWith('--') ? '--<已隐去>' : '<已隐去>';
    }
    return arg;
  };
  const out = [];
  let rest = false;
  for (let i = 0; i < rawArgv.length; i += 1) {
    const arg = rawArgv[i];
    if (rest) { out.push(redactArg(arg)); continue; }
    if (arg === '--') { out.push(arg); rest = true; continue; }
    if (i === 0 && arg === 'build') { out.push(arg); continue; }
    if (arg === '-h' || arg === '--help' || arg === '--json') { out.push(arg); continue; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      if (valueOpts.has(name)) {
        out.push(arg);
        if (eq < 0 && rawArgv[i + 1] !== undefined && !(rawArgv[i + 1].startsWith('--') && rawArgv[i + 1].length > 2)) {
          out.push(rawArgv[++i]);
        }
        continue;
      }
      if (eq > 0 && (name === 'help' || name === 'json')) { out.push(`--${name}=x`); continue; }
    }
    out.push(redactArg(arg));
  }
  return out;
}

// 是不是被直接执行：两边都解析掉软链再比
const isMain = () => { try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) await runCli({ command: 'beiming/bench/board.mjs', subcommands: { build: BUILD }, summary: '北冥看板', argv: sanitizeArgv(process.argv.slice(2)) });
