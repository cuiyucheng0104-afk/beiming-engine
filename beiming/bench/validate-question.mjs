// 题目文件（question/0.1）的校验：泄露门禁 → 结构 → QF1、QF2 → B1 增补规则。
// 另有指标引用的解析与格式化、起草形态归一、隐藏题的公开投影。谓词只认 kernel/contracts/predicates/predicates.json 一张登记表。
import Ajv2020 from 'ajv/dist/2020.js';
import { checks } from '../kernel/contracts/question-file/check.mjs';
import schema from '../kernel/contracts/question-file/schema/question.schema.json' with { type: 'json' };
import { REGISTRY, checkAssertion, parseFps, stripQuoted } from '../verify/predicates.mjs';

const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });
const validateStructure = ajv.compile(schema);
const metricName = new RegExp(schema.properties.scoring.items.properties.metric.pattern);
const METRIC_PREFIX = 'metric:';
// 契约 5.5：隐藏题只回给做题方这几项
const PUBLIC_FIELDS = ['id', 'level', 'title', 'brief', 'deliverable', 'assets'];
const leakPatterns = [
  ['lab-url', /lab:\/\//i],
  ['private-source-path', /原包源码|cards-overlay/i],
  ['case-library-path', /复刻[\\/]/],
  ['hidden-exam-path', /exams-hidden/i],
  ['local-path', /\/(?:Users|home)\/|\b[a-z]:[\\/]/i],
  ['bare-sha256', /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i],
];
// 先做 NFKC、去掉零宽字符：全角的冒号、斜杠、字母数字（中文输入法下容易打出来）和夹了零宽字符的写法照样认
// 规范写法的哈希（约定第 5 节：sha256: 加 64 位小写十六进制）不算裸哈希：在原文上先摘掉摘要再归一，全角、夹零宽字符、大写的写法摘不掉，照拦
function leakCodes(text) {
  const plain = text.replace(/sha256:[0-9a-f]{64}(?![0-9a-f])/g, 'sha256:').normalize('NFKC').replace(/\p{Cf}/gu, '');
  return leakPatterns.filter(([, pattern]) => pattern.test(plain)).map(([code]) => code);
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : typeof v);

/* ---------------- 指标引用 ---------------- */

/** `metric:loop.closure-psnr` → `loop.closure-psnr`；没带前缀、名字空、不是点分小写（含带版本）都抛 TypeError。 */
export function parseMetricRef(ref) {
  const name = typeof ref === 'string' && ref.startsWith(METRIC_PREFIX) ? ref.slice(METRIC_PREFIX.length) : null;
  if (name === null || !metricName.test(name)) throw new TypeError(`指标引用要写成 ${METRIC_PREFIX} 加点分小写的指标名，现在是 ${show(ref)}`);
  return name;
}

/** `loop.closure-psnr` → `metric:loop.closure-psnr`；已经带前缀或不是点分小写抛 TypeError。 */
export function formatMetricRef(name) {
  if (typeof name !== 'string' || !metricName.test(name)) throw new TypeError(`指标名要点分小写、不带前缀，现在是 ${show(name)}`);
  return METRIC_PREFIX + name;
}

/* ---------------- 泄露扫描 ---------------- */

function scanObject(root) {
  const leaks = [];
  const active = new WeakSet();
  (function visit(value, path) {
    if (typeof value === 'string') leaks.push(...leakCodes(value).map((code) => ({ code, path: path || '/' })));
    if (value === null || typeof value !== 'object' || active.has(value)) return;
    active.add(value);
    // 和 toJsonData 一个读法：只看自有属性的描述符，取值器不调（它的值扫不到，记一条）；Symbol 键不是 JSON 数据，也记
    if (Object.getOwnPropertySymbols(value).length) leaks.push({ code: 'symbol-key', path: path || '/' });
    for (const [key, slot] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      const bad = leakCodes(key);
      leaks.push(...bad.map((code) => ({ code, path: path || '/', field: 'key' })));
      const at = `${path}/${bad.length ? '[redacted]' : key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if ('value' in slot) visit(slot.value, at);
      else leaks.push({ code: 'accessor-property', path: at });
    }
    active.delete(value);
  })(root, '');
  return leaks;
}

/** 扫题目文件的原文，回 { leaks, duplicates }：duplicates 是同一个对象里写了不止一次的键（各家解析器取哪个不一样，不收）。 */
function scanText(text) {
  try {
    JSON.parse(text);
  } catch {
    // 不是 JSON：逐行当字符串扫
    return { leaks: text.split('\n').flatMap((line, i) => leakCodes(line).map((code) => ({ code, line: i + 1 }))), duplicates: [] };
  }
  // 逐个词元扫原文：被后面的重复键盖掉的值、写成转义的字符都在这里现形
  const tokens = [...text.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]:]|[^\s{}[\],:"]+/gu)];
  const leaks = [], duplicates = [], open = [];
  let line = 1, at = 0;
  const lineOf = (index) => {
    while (at < index) if (text.charCodeAt(at++) === 10) line++;
    return line;
  };
  tokens.forEach(({ 0: raw, index }, i) => {
    if (raw === '{' || raw === '[') open.push(raw === '{' ? new Set() : null);
    else if (raw === '}' || raw === ']') open.pop();
    else if (raw !== ':') {
      const value = raw.startsWith('"') ? JSON.parse(raw) : raw;
      leaks.push(...leakCodes(value).map((code) => ({ code, line: lineOf(index) })));
      if (tokens[i + 1]?.[0] !== ':') return;
      if (open.at(-1).has(value)) duplicates.push(`/ 第 ${lineOf(index)} 行的键 ${raw} 写了不止一次`);
      open.at(-1).add(value);
    }
  });
  return { leaks, duplicates };
}

/**
 * 只回泄露的类型和位置，不回显命中的内容。
 * 给对象回 { code, path, field? }（键命中时 field 是 'key'，路径里那一段写成 [redacted]）；给原文回 { code, line }（行号从 1 起）。
 * 对象里扫不到的地方也记：取值器（不调它）是 accessor-property，Symbol 键是 symbol-key。
 */
export const scanQuestionLeaks = (input) => (typeof input === 'string' ? scanText(input).leaks : scanObject(input));

/* ---------------- 校验 ---------------- */

/** 把输入抄成一份纯 JSON 数据：类实例、取值器、非有限数、环在这里拒掉，后面只读这份副本（不受原对象后续变化影响）。 */
function toJsonData(value, path = '', active = new Set()) {
  // 键名会进报错：命中泄露规则的位置不回显
  const bad = (why) => {
    const message = `${path || '/'} ${why}`;
    throw new TypeError(leakCodes(message).length ? '[redacted] 不是 JSON 数据' : message);
  };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : bad('不是有限数');
  if (typeof value !== 'object') return bad(`不是 JSON 数据（${typeof value}）`);
  if (active.has(value)) return bad('有环');
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  // 根原型（别的上下文造的普通对象也算）或没有原型；多一层原型的是类实例
  if (!array && proto !== null && Object.getPrototypeOf(proto) !== null) return bad('不是普通对象');
  active.add(value);
  // 只看描述符，不调取值器；不可枚举的属性 JSON 里写不出来，一并不收
  const slots = Object.getOwnPropertyDescriptors(value);
  const read = (key) => {
    const slot = slots[key];
    if (!slot || !('value' in slot) || !slot.enumerable) return bad(`的 ${key} 不是数据属性`);
    return toJsonData(slot.value, `${path}/${key}`, active);
  };
  if (Object.getOwnPropertySymbols(value).length) return bad('带了 Symbol 键');
  const copy = array
    ? Array.from({ length: value.length }, (_, i) => read(String(i)))
    : Object.fromEntries(Object.keys(slots).map((key) => [key, read(key)]));
  // 下标 0 到 length-1 都读到了，再多出来的自有键（length 以外）就是挂在数组上的附加属性
  if (array && Object.keys(slots).length !== value.length + 1) return bad('带了下标以外的属性');
  active.delete(value);
  return copy;
}

// shortcut: 比较后面的单位后缀（冻结样题的 `in [359, 361] deg`）verify 的解析器不认，这里摘掉再交给它；谓词文法定稿（PR 契约第 6 节）后删
function dropComparisonUnit(text) {
  const masked = text.replace(/"[^"]*"/g, (quoted) => `"${'_'.repeat(quoted.length - 2)}"`);
  const hit = /((?:>=|<=)\s*-?\d+(?:\.\d+)?|\bin\s*\[[^\][]*\])\s*(?:deg|mm|f|s)(?=\s*(?:@|$))/.exec(masked);
  return hit ? text.slice(0, hit.index + hit[1].length) + text.slice(hit.index + hit[0].length) : text;
}

// 写给人看的文字字段：指标名单独出现在这里要带 metric: 前缀（契约 5.3）
const textFields = (q) => [
  ['title', q.title],
  ['brief', q.brief],
  ...q.scoring.flatMap((item, i) => [[`scoring/${i}/pass`, item.pass], ...(item.source ? [[`scoring/${i}/source`, item.source]] : [])]),
  ...Object.entries(q.controls).map(([key, text]) => [`controls/${key}`, text]),
  ['calibration/source', q.calibration.source],
  ...q.flags.blockedBy.map((text, i) => [`flags/blockedBy/${i}`, text]),
];
// 前面是独立的 metric: 才算带了前缀；夹在更长的名字或路径里的不算提到
const bareMention = (metric) => new RegExp(`(?<!(?<![A-Za-z0-9_.-])${METRIC_PREFIX})(?<![A-Za-z0-9_./-])${metric.replaceAll('.', '\\.')}(?![A-Za-z0-9_/-]|\\.[A-Za-z0-9])`);

const rules = {
  ...checks,
  // 语法和实参对登记表核。planned 的谓词题目可以先写（预期失败题）；带 `;` 的项和没登记的名字 QF2 已报
  B1_PREDICATE_SYNTAX: (q) => q.basePredicates.flatMap((text, i) => (stripQuoted(text).includes(';') ? []
    : checkAssertion(dropComparisonUnit(text)).errors
      .filter(({ evidence }) => evidence !== 'predicate.planned' && evidence !== 'predicate.unregistered')
      .map(({ message }) => `basePredicates 第 ${i + 1} 条：${message}`))),
  // 没有指标登记表（契约第 6 节），「已知的指标名」取这道题 scoring 里用到的
  B1_METRIC_NAMESPACE: (q) => {
    const metrics = [...new Set(q.scoring.map((item) => item.metric))];
    return [
      ...q.needs.filter((card) => metrics.includes(card)).map((card) => `needs 里的 ${card} 是这道题的指标名，needs 只写卡名`),
      ...textFields(q).flatMap(([path, text]) => metrics.filter((metric) => bareMention(metric).test(text))
        .map((metric) => `${path} 里单独提到指标 ${metric}，要写成 ${METRIC_PREFIX}${metric}`)),
    ];
  },
  // 约定第 5 节的路径口径里结构定义的 pattern 没管到的几条。不回显内容：隐藏题的 refs 是私有的
  B1_REF_PATH: (q) => (q.refs ?? []).flatMap((ref, i) => (ref.includes(':') || /\p{Cc}/u.test(ref) || ref.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
    ? [`refs 第 ${i + 1} 项不是合规的相对路径：不含冒号和控制字符，不以 / 开头或结尾，没有空段和 . 段`] : [])),
  // 时间键契约 3.2：分子分母互质，结构定义的 pattern 查不了这一条
  B1_FPS: ({ deliverable }) => (parseFps(deliverable.fps) ? [] : [`deliverable.fps 是 ${deliverable.fps}，分子分母必须互质`]),
  // 05 第 6.4 节：预期失败题靠 blockedBy 的变化决定重不重跑
  B1_BLOCKED_BY: ({ flags }) => (flags.expectedFail === flags.blockedBy.length > 0 ? []
    : [flags.expectedFail ? 'flags.expectedFail 是 true，blockedBy 至少写一项挡住它的东西' : 'flags.expectedFail 是 false，blockedBy 必须是空数组']),
};

function inspect(input) {
  try {
    return check(input);
  } catch (error) {
    // toJsonData 的拒收是 TypeError；别的（超长词元让正则爆栈之类）也按拒收回，不抛给调用方
    return { result: { ok: false, schemaErrors: [error instanceof TypeError ? error.message : `/ 校验不了：${error.name}`], violations: {}, leaks: [] } };
  }
}

function check(input) {
  const result = { ok: false, schemaErrors: [], violations: {}, leaks: [] };
  const stop = (fields) => ({ result: Object.assign(result, fields) });
  let data = input;
  if (typeof input === 'string') {
    const { leaks, duplicates } = scanText(input);
    if (leaks.length) return stop({ leaks });
    try {
      data = JSON.parse(input);
    } catch (error) {
      // V8 的消息会回显出错处的原文（隐藏题的判分细则可能就在那儿），只取位置
      const at = /position (\d+)/.exec(error.message);
      return stop({ parseError: `无效的 JSON 语法${at ? `（位置 ${at[1]}）` : ''}`, schemaErrors: ['/ 不是有效的 JSON'] });
    }
    if (duplicates.length) return stop({ schemaErrors: duplicates });
  }
  const question = toJsonData(data);
  if (typeof input !== 'string') result.leaks = scanObject(question);
  if (result.leaks.length) return { result };
  if (!validateStructure(question)) {
    return stop({ schemaErrors: validateStructure.errors.map(({ instancePath, message, params }) =>
      `${instancePath || '/'} ${message}${params.additionalProperty === undefined ? '' : `：${JSON.stringify(params.additionalProperty)}`}`) });
  }
  for (const [id, rule] of Object.entries(rules)) {
    const problems = rule(question, { registries: { predicates: REGISTRY } });
    if (problems.length) result.violations[id] = problems;
  }
  result.ok = Object.keys(result.violations).length === 0;
  return { result, question };
}

/**
 * 校验一道题。input 是题目对象，或题目文件的 JSON 原文（原文能查出重复键里夹带的泄露）。
 * 返回 { ok, schemaErrors, violations: { 规则编号: [问题] }, leaks, parseError? }；有泄露就不往下查。
 */
export const validateQuestion = (input) => inspect(input).result;

/* ---------------- 起草形态归一 ---------------- */

const camel = (key) => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
/** 只换往下 levels 层的键：再深的是数据（args 里的实体名之类），不动 */
function camelKeys(value, levels, keep = []) {
  if (Array.isArray(value)) return value.map((item) => camelKeys(item, levels));
  if (!isObj(value) || levels === 0) return value;
  const entries = Object.entries(value).map(([key, item]) => [camel(key), keep.includes(key) ? item : camelKeys(item, levels - 1)]);
  const twice = entries.find(([key], i) => entries.findIndex(([other]) => other === key) !== i);
  if (twice) throw new TypeError(`草稿里 ${twice[0]} 写了两种拼法`);
  return Object.fromEntries(entries);
}
/** 旧键换成新键；新旧都写了就原样留着，让结构校验报多余的键 */
function rename(obj, from, to, convert = (v) => v) {
  if (!Object.hasOwn(obj, from) || Object.hasOwn(obj, to)) return;
  obj[to] = convert(obj[from]);
  delete obj[from];
}

/**
 * 把 05 第 6.1 节的起草形态换成 question/0.1（契约第 6 节列的那几处差异），不改传入的对象，也不校验，结果交给 validateQuestion。
 * 草稿不是纯 JSON 数据的对象、或同一个键两种拼法都写了，抛 TypeError。
 * 下划线键 → 小驼峰（到 scoring[].args 的第一层为止；assets、ext 里的键不动）；deliverable 的 width、height → size，整数 fps → "n/1"；
 * budget 的 wall_s（秒）→ wallMs，gpu_s → gpuSeconds；calibration.status 的「初值未校准」→ uncalibrated；scoring[].metric 的 metric: 前缀去掉。
 */
export function normalizeQuestionDraft(draft) {
  // 三层：顶层、各节（含 scoring 的每一项）、args 的第一层
  const q = camelKeys(toJsonData(draft), 3, ['assets', 'ext']);
  if (!isObj(q)) throw new TypeError('题目草稿必须是对象');
  const { deliverable, budget, calibration, scoring } = q;
  if (isObj(deliverable)) {
    if (!Object.hasOwn(deliverable, 'size') && (Object.hasOwn(deliverable, 'width') || Object.hasOwn(deliverable, 'height'))) {
      deliverable.size = [deliverable.width, deliverable.height];
      delete deliverable.width;
      delete deliverable.height;
    }
    if (Number.isInteger(deliverable.fps)) deliverable.fps = `${deliverable.fps}/1`;
  }
  if (isObj(budget)) {
    rename(budget, 'wallS', 'wallMs', (seconds) => (typeof seconds === 'number' ? Math.round(seconds * 1000) : seconds));
    rename(budget, 'gpuS', 'gpuSeconds');
  }
  if (isObj(calibration) && calibration.status === '初值未校准') calibration.status = 'uncalibrated';
  for (const item of Array.isArray(scoring) ? scoring : []) {
    if (isObj(item) && typeof item.metric === 'string' && item.metric.startsWith(METRIC_PREFIX)) item.metric = item.metric.slice(METRIC_PREFIX.length);
  }
  return { format: schema.properties.format.const, ...q };
}

/* ---------------- 公开投影 ---------------- */

/**
 * 回给做题方的副本：先校验，没过就抛 TypeError。隐藏题（flags.hidden 是 true）只留 id、level、title、brief、deliverable、assets；
 * 公开题留全部字段，只去掉私有的 ext。返回的是新对象。
 */
export function projectPublicQuestion(input) {
  const { result, question } = inspect(input);
  if (!result.ok) {
    throw new TypeError(`题目没过校验，不做投影：${[...result.leaks.map((leak) => leak.code), ...result.schemaErrors, ...Object.keys(result.violations)].join('；')}`);
  }
  if (question.flags.hidden) return Object.fromEntries(PUBLIC_FIELDS.map((key) => [key, question[key]]));
  delete question.ext;
  return question;
}
