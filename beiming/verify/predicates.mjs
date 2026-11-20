// 谓词：解析断言、对登记表核名字和参数、求 floor 1 版六条、防削弱守卫。
// 登记表只有 kernel/contracts/predicates/predicates.json 一张；floor 的六条 expr 也从那里读，不在这里另抄一份。
// 帧号一律是全片帧号（整数帧）；像素原点在左上角；响度单位 LUFS，真峰值单位 dBTP。
import { readFileSync } from 'node:fs';

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const objectsIn = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
/** 片子描述里的镜头：不是对象的项不算 */
const shotsOf = (film) => objectsIn(film?.shots);

function freezeRegistry(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeRegistry(child);
    Object.freeze(value);
  }
  return value;
}
export const REGISTRY = freezeRegistry(JSON.parse(readFileSync(new URL('../kernel/contracts/predicates/predicates.json', import.meta.url), 'utf8')));

const byName = Object.fromEntries(REGISTRY.predicates.map((p) => [p.name, p]));
/** 登记过的谓词，没登记是 null */
export const registered = (name) => (Object.hasOwn(byName, name) ? byName[name] : null);
/** 登记过的模板（名字 + 主版本），没登记是 null */
export function registeredTemplate(name, major) {
  return REGISTRY.templates.find((t) => t.name === name && Number(t.version.split('.')[0]) === major) ?? null;
}
export const FLOOR = registeredTemplate('floor', 1);

// 主角屏占峰值的下限（比例，无单位）。契约第 6 节把它列为待定、没有登记专门的谓词，这里挂在 visible(hero) 的求值里
export const HERO_PEAK_AREA_MIN = 0.05;
// delivery 的色彩标签：成片是显示空间 sRGB 编码、Rec.709 原色（片子描述契约 5.9），编码标签取 bt709
export const DELIVERY_COLOR_TAG = 'bt709';

/* ---------------- 编辑距离与改名建议 ---------------- */

export function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/** 拼写相近的唯一候选：距离不超过 2、且小于键长的一半，最近的只有一个时才给，否则 null */
export function suggestKey(key, candidates) {
  const limit = Math.min(2, Math.ceil(key.length / 2) - 1);
  let best = null, bestD = Infinity, tie = false;
  for (const c of candidates) {
    const d = editDistance(key, c);
    if (d < bestD) { best = c; bestD = d; tie = false; } else if (d === bestD) tie = true;
  }
  return best !== null && bestD >= 1 && bestD <= limit && !tie ? best : null;
}

/* ---------------- 解析 ---------------- */

const NAME_RE = /^[a-z][A-Za-z0-9_]*(?:\.[a-z][A-Za-z0-9_]*)*/;
const NUM_RE = /^(-?\d+(?:\.\d+)?)(f|s|mm|deg)?$/;
const REF_WORDS = ['film', 'output', 'camera', 'audio', 'script', 'copy'];
const ENTITY_RE = /^[A-Za-z0-9_*]+(?:\.[A-Za-z0-9_*]+)*$/;

/** 去掉双引号括起来的文字（没闭合的引号留着当普通字符），D20 的判法 */
export const stripQuoted = (s) => s.replace(/"[^"]*"/g, '');

/** 按顶层的分隔符切开：引号和括号里面的不算 */
function splitTop(s, sep) {
  const out = [];
  let depth = 0, quote = false, at = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quote = !quote;
    else if (!quote && (c === '(' || c === '[')) depth++;
    else if (!quote && (c === ')' || c === ']')) depth--;
    else if (!quote && depth === 0 && s.startsWith(sep, i)) { out.push(s.slice(at, i)); at = i + sep.length; i += sep.length - 1; }
  }
  out.push(s.slice(at));
  return out;
}

/** 模板条目按 ` ; ` 切成几条断言 */
export const splitItem = (expr) => splitTop(expr, ' ; ').map((s) => s.trim());

function parseValue(raw) {
  const v = raw.trim();
  if (/^"[^"]*"$/.test(v)) return { kind: 'text', text: v.slice(1, -1) };
  const n = v.match(NUM_RE);
  if (n) return { kind: 'number', value: Number(n[1]), unit: n[2] ?? null };
  const call = v.match(/^(shot|event|text)\(([^()\s]+)\)$/);
  if (call) return { kind: 'ref', ref: call[1], id: call[2] };
  if (ENTITY_RE.test(v)) return { kind: 'ident', name: v };
  return null;
}

function parseScope(raw) {
  const s = raw.trim();
  if (s === 'all') return { kind: 'all' };
  let m = s.match(/^\[(0|[1-9]\d*),(0|[1-9]\d*)\)$/);
  if (m) return Number(m[1]) < Number(m[2]) ? { kind: 'range', from: Number(m[1]), to: Number(m[2]) } : null;
  m = s.match(/^shot\(([a-z][a-z0-9-]*)\)$/);
  if (m) return { kind: 'shot', id: m[1] };
  m = s.match(/^(cut\((?:0|[1-9]\d*)\)|event\([a-z][a-z0-9-]*\))(?: ([+-]) ([1-9]\d*))?$/);
  if (m) return { kind: 'time', expr: s };
  return null;
}

/**
 * 解析一条断言 `谓词名(实参, …) 比较 @ 范围`。只解析，不查登记表。
 * 返回 { ok: true, assertion: { text, name, args: [{ name|null, value }], cmp|null, scope } } 或 { ok: false, error }。
 */
export function parseAssertion(text) {
  if (typeof text !== 'string') return { ok: false, error: '断言必须是字符串' };
  const src = text.trim();
  const fail = (error) => ({ ok: false, error });
  const nm = src.match(NAME_RE);
  if (!nm) return fail(`断言 ${src} 不以谓词名开头`);
  const name = nm[0];
  let rest = src.slice(name.length);
  const args = [];
  if (rest.startsWith('(')) {
    let depth = 0, quote = false, end = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '"') quote = !quote;
      else if (!quote && rest[i] === '(') depth++;
      else if (!quote && rest[i] === ')' && --depth === 0) { end = i; break; }
    }
    if (end < 0) return fail(`断言 ${src} 的括号没闭合`);
    const inner = rest.slice(1, end).trim();
    rest = rest.slice(end + 1);
    for (const part of inner ? splitTop(inner, ',') : []) {
      const p = part.trim();
      const named = p.startsWith('"') ? null : p.match(/^([a-z][A-Za-z0-9]*)\s*=\s*(.+)$/);
      const value = parseValue(named ? named[2] : p);
      if (!value) return fail(`断言 ${src} 的实参 ${p} 写法不认`);
      args.push({ name: named ? named[1] : null, value });
    }
  }
  rest = rest.trim();
  let cmp = null;
  let m = rest.match(/^(>=|<=)\s*(-?\d+(?:\.\d+)?)/);
  if (m) { cmp = { op: m[1], value: Number(m[2]) }; rest = rest.slice(m[0].length).trim(); }
  m = !cmp && rest.match(/^in\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/);
  if (m) {
    if (Number(m[1]) > Number(m[2])) return fail(`断言 ${src} 的区间下限大于上限`);
    cmp = { op: 'in', lo: Number(m[1]), hi: Number(m[2]) }; rest = rest.slice(m[0].length).trim();
  }
  let scope = { kind: 'all' };
  if (rest.startsWith('@')) {
    scope = parseScope(rest.slice(1));
    if (!scope) return fail(`断言 ${src} 的范围写法不认`);
    rest = '';
  }
  if (rest) return fail(`断言 ${src} 末尾多出 ${rest}`);
  return { ok: true, assertion: { text: src, name, args, cmp, scope } };
}

/* ---------------- 对登记表核 ---------------- */

const typeList = (t) => (Array.isArray(t) ? t : [t]);
function typeOk(type, v) {
  return typeList(type).some((t) => {
    if (t === 'number') return v.kind === 'number';
    if (t === 'frame') return (v.kind === 'number' && Number.isInteger(v.value) && v.value >= 0 && v.unit === null) || (v.kind === 'ident' && v.name === 'shots');
    if (t === 'text') return v.kind === 'text';
    if (t === 'ref') return (v.kind === 'ident' && REF_WORDS.includes(v.name)) || (v.kind === 'ref' && (v.ref !== 'text' || v.id === '*'));
    if (t === 'entity') return v.kind === 'ident';
    return false;
  });
}

const predErr = (evidence, message, extra = {}) => ({ code: 'contract.bad-value', evidence, message, ...extra });

/**
 * 解析并对登记表核一条断言：谓词名必须登记，实参照 params 对上。
 * 返回 { ok, assertion, bound: { 参数名: 值 }, errors: [{ code, evidence, message, hint?, rename? }] }；
 * code 为已登记码 contract.bad-value，细分类别在 evidence；rename 是拼写相近的命名实参的唯一改名建议 { from, to }。
 */
export function checkAssertion(text) {
  const parsed = parseAssertion(text);
  if (!parsed.ok) return { ok: false, assertion: null, bound: {}, errors: [predErr('predicate.syntax', parsed.error)] };
  const a = parsed.assertion;
  const pred = registered(a.name);
  if (!pred) {
    const to = suggestKey(a.name, Object.keys(byName));
    return { ok: false, assertion: a, bound: {}, errors: [predErr('predicate.unregistered', `谓词 ${a.name} 没有登记`, to ? { hint: `最接近的谓词名是 ${to}` } : {})] };
  }
  const errors = [], bound = {};
  // 登记成 planned 的谓词以后的版本才有，本版判不了：写了就报，不让它静默失效
  if (pred.since === 'planned') {
    errors.push(predErr('predicate.planned', `谓词 ${a.name} 登记为以后的版本才有，本版判不了`, { hint: `去掉这条断言，或者换成本版已有的谓词：${REGISTRY.predicates.filter((p) => p.since !== 'planned').map((p) => p.name).join('、')}` }));
  }
  const names = pred.params.map((p) => p.name);
  a.args.forEach((arg, i) => {
    let param;
    if (arg.name === null) {
      param = pred.params[i];
      if (!param) { errors.push(predErr('predicate.extra-arg', `谓词 ${a.name} 只收 ${pred.params.length} 个实参，第 ${i + 1} 个多了`)); return; }
    } else {
      param = pred.params.find((p) => p.name === arg.name);
      if (!param) {
        const to = suggestKey(arg.name, names);
        errors.push(predErr('predicate.unknown-arg', `谓词 ${a.name} 没有参数 ${arg.name}`, to ? { hint: `最接近的参数名是 ${to}`, rename: { from: arg.name, to } } : {}));
        return;
      }
    }
    if (Object.hasOwn(bound, param.name)) { errors.push(predErr('predicate.duplicate-arg', `谓词 ${a.name} 的参数 ${param.name} 给了两次`)); return; }
    if (!typeOk(param.type, arg.value)) errors.push(predErr('predicate.arg-type', `谓词 ${a.name} 的参数 ${param.name} 要 ${typeList(param.type).join('/')}`));
    bound[param.name] = arg.value;
  });
  // floor 第 1 条的 delivery(output)：四个参数都不写、只写 output，取片子描述的 output（PR 契约 5.6）
  const deliveryOutput = a.name === 'delivery' && a.args.length === 1 && a.args[0].name === null && a.args[0].value.kind === 'ident' && a.args[0].value.name === 'output';
  if (deliveryOutput) { errors.length = 0; Object.keys(bound).forEach((k) => delete bound[k]); bound.output = a.args[0].value; }
  for (const p of pred.params) {
    if (p.required && !Object.hasOwn(bound, p.name)) errors.push(predErr('predicate.missing-arg', `谓词 ${a.name} 缺必填参数 ${p.name}`));
  }
  return { ok: errors.length === 0, assertion: a, bound, errors };
}

/** predicates.extra 的一项：D20（引号外不得有 ;）加 checkAssertion */
export function checkExtra(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, assertion: null, bound: {}, errors: [predErr('predicate.syntax', `predicates.extra 的一项必须是不空的字符串，现在是 ${JSON.stringify(text) ?? String(text)}`)] };
  }
  if (stripQuoted(text).includes(';')) {
    return { ok: false, assertion: null, bound: {}, errors: [predErr('predicate.semicolon', `predicates.extra 的一项 ${text} 在引号外有 ;，一项只写一条断言`)] };
  }
  return checkAssertion(text);
}

/* ---------------- 片子描述上的辅助 ---------------- */

export function parseFps(fps) {
  const m = typeof fps === 'string' && fps.match(/^([1-9]\d*)\/([1-9]\d*)$/);
  if (!m) return null;
  const num = BigInt(m[1]), den = BigInt(m[2]);
  let a = num, b = den;
  while (b) [a, b] = [b, a % b];
  return a === 1n ? { num, den } : null;
}

/** 时刻算式展开成全片帧号（片子描述契约 5.3）；整数原样；展开不了是 null */
export function expandTime(v, film, seen = []) {
  if (Number.isInteger(v)) return v;
  const m = typeof v === 'string' && v.match(/^(cut\((0|[1-9]\d*)\)|event\(([a-z][a-z0-9-]*)\))(?: ([+-]) ([1-9]\d*))?$/);
  if (!m) return null;
  let base;
  if (m[2] !== undefined) base = Number(m[2]);
  else {
    if (seen.includes(m[3])) return null;
    const ev = objectsIn(film?.events).find((e) => e.id === m[3]);
    base = ev ? expandTime(ev.frame, film, [...seen, m[3]]) : null;
  }
  if (base === null) return null;
  return m[4] === '+' ? base + Number(m[5]) : m[4] === '-' ? base - Number(m[5]) : base;
}

/** 范围解析成全片帧号的半开区间 [from, to)；解不出是 null */
export function scopeRange(scope, film) {
  const total = Number.isInteger(film?.output?.frames) ? film.output.frames : 0;
  if (scope.kind === 'all') return [0, total];
  if (scope.kind === 'range') return [scope.from, scope.to];
  if (scope.kind === 'shot') {
    const s = shotsOf(film).find((x) => x.id === scope.id);
    return s && Number.isInteger(s.in) && Number.isInteger(s.out) ? [s.in, s.out] : null;
  }
  const t = expandTime(scope.expr, film);
  return t === null ? null : [t, t + 1];
}

/** 出帧的帧源名：写了 renderer 就是它的 */
const sourceOf = (shot) => shot?.renderer?.source ?? shot?.source;
/** 镜头的合规档：帧源是 legacy-page 或 ext.<名字> 的是 limited；measured.conformance 显式给了的以它为准 */
export function shotConformance(shot, measured = {}) {
  const given = measured.conformance;
  if (isObj(given) && Object.hasOwn(given, shot?.id)) return given[shot.id];
  const src = sourceOf(shot);
  return src === 'legacy-page' || (typeof src === 'string' && src.startsWith('ext.')) ? 'limited' : 'full';
}

const inRange = (f, r) => f >= r[0] && f < r[1];
const sampledIn = (measured, r) => objectsIn(measured.frames).filter((x) => Number.isInteger(x.frame) && inRange(x.frame, r)).sort((a, b) => a.frame - b.frame);
const metaEntity = (meta, name) => objectsIn(meta?.entities).find((e) => e.name === name) ?? null;
const isBox = (b) => Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === 'number' && Number.isFinite(x));
const isSize = (s) => Array.isArray(s) && s.length === 2 && s.every((x) => typeof x === 'number' && x > 0);

/** 片子描述里的文案：范围里的叠加层文字，帧号展开成整数 */
export function copyOf(film, range) {
  return objectsIn(film?.overlays).map((o) => ({ id: o.id, text: o.text, in: expandTime(o.in, film), out: expandTime(o.out, film) }))
    .filter((o) => o.in !== null && o.out !== null && o.in < range[1] && o.out > range[0]);
}

/* ---------------- 求值 ---------------- */

const pass = (predicate, measured) => ({ ok: true, status: 'pass', predicate, measured });
const fail = (predicate, measured, counterexampleFrame, expected, fixes = []) => ({ ok: false, status: 'fail', predicate, measured, counterexampleFrame, expected, fixes });
const skipped = (predicate, reason) => ({ ok: null, status: 'skipped', predicate, reason });

function cmpOk(value, cmp) {
  if (!cmp) return true;
  if (cmp.op === '>=') return value >= cmp.value;
  if (cmp.op === '<=') return value <= cmp.value;
  return value >= cmp.lo && value <= cmp.hi;
}
const cmpText = (cmp) => (!cmp ? '' : cmp.op === 'in' ? `in [${cmp.lo},${cmp.hi}]` : `${cmp.op} ${cmp.value}`);

/** 半开区间 [from, to) 减去一批半开区间之后剩下的连续段 */
function subtract(from, to, cuts) {
  let left = [[from, to]];
  for (const [a, b] of cuts) left = left.flatMap(([x, y]) => [[x, Math.min(y, a)], [Math.max(x, b), y]]).filter(([x, y]) => x < y);
  return left;
}

const EVALUATORS = {
  delivery(a, bound, film, measured) {
    const out = measured.output;
    if (!isObj(out)) return skipped(a.text, '没有成片的量测（measured.output）');
    const filmFps = parseFps(film.output?.fps);
    if (!isSize(film.output?.size) || !filmFps || !Number.isInteger(film.output?.frames)) return fail(a.text, null, null, '片子描述的 output 带合法的 size、fps、frames');
    const fps = parseFps(out.fps);
    const want = Object.hasOwn(bound, 'output') || Object.keys(bound).length === 0
      ? { width: film.output.size[0], height: film.output.size[1], fps: filmFps, frames: film.output.frames }
      : { width: bound.width?.value, height: bound.height?.value, fps: bound.fps?.value, frames: bound.frames?.value };
    const got = { width: out.size?.[0], height: out.size?.[1], fps: out.fps, frames: out.frames, colorTag: out.colorTag };
    const bad = [];
    if (want.width !== undefined && got.width !== want.width) bad.push('width');
    if (want.height !== undefined && got.height !== want.height) bad.push('height');
    if (want.fps !== undefined) {
      const matches = fps && (typeof want.fps === 'number' ? Number(fps.num) / Number(fps.den) === want.fps : out.fps === film.output.fps);
      if (!matches) bad.push('fps');
    }
    if (want.frames !== undefined && got.frames !== want.frames) bad.push('frames');
    if (got.colorTag !== DELIVERY_COLOR_TAG) bad.push('colorTag');
    const expected = `成片 ${want.width}x${want.height} 像素、${typeof want.fps === 'number' ? want.fps : film.output.fps} 帧每秒、${want.frames} 帧、色彩标签 ${DELIVERY_COLOR_TAG}`;
    // 帧数对不上时的反例帧：成片短了，是缺的第一帧；成片长了，全片帧号里没有对应的帧，不给
    const shortAt = bad.includes('frames') && Number.isInteger(got.frames) && got.frames >= 0 && got.frames < want.frames ? got.frames : null;
    if (bad.length) return fail(a.text, { ...got, mismatched: bad }, shortAt, expected);
    // 黑帧、冻结的检测结果必须给：没给不能当成「没有」
    const frameList = (v) => Array.isArray(v) && v.every((f) => Number.isInteger(f));
    const spanList = (v) => Array.isArray(v) && v.every((z) => isObj(z) && Number.isInteger(z.in) && Number.isInteger(z.out) && z.in < z.out);
    if (!frameList(measured.blackFrames) || !spanList(measured.freezes)) {
      return fail(a.text, got, null, '给出成片黑帧和冻结的检测结果（measured.blackFrames 是帧号数组，measured.freezes 是 [{ in, out }]，帧，半开）');
    }
    // 先除去镜头 deliberate 声明的区间，剩下的再判（PR 契约 5.6 第 1 条）。声明成黑场的区间画面也不动，冻结一并除去
    const declared = shotsOf(film).flatMap((s) => objectsIn(s.deliberate)).filter((d) => Number.isInteger(d.in) && Number.isInteger(d.out));
    const spans = declared.map((d) => [d.in, d.out]);
    const black = measured.blackFrames.find((f) => !spans.some(([x, y]) => x <= f && f < y));
    if (black !== undefined) return fail(a.text, { ...got, blackFrame: black }, black, '除去 deliberate 区间没有黑帧');
    const minFreeze = (filmFps.num + filmFps.den) / (2n * filmFps.den); // 半秒按 T 5.1 就近取整
    for (const z of measured.freezes) {
      const rest = subtract(z.in, z.out, spans).find(([x, y]) => y - x >= minFreeze);
      if (rest) return fail(a.text, { ...got, freeze: { in: z.in, out: z.out }, undeclared: { in: rest[0], out: rest[1] } }, rest[0], `除去 deliberate 区间没有 ${minFreeze} 帧（半秒）以上的冻结`);
    }
    return pass(a.text, got);
  },

  loudness(a, bound, film, measured) {
    const v = measured.audio?.loudnessLufs;
    if (typeof v !== 'number') return skipped(a.text, '没有成片响度的量测（measured.audio.loudnessLufs）');
    return cmpOk(v, a.cmp) ? pass(a.text, v) : fail(a.text, v, null, `整片响度 ${cmpText(a.cmp)} LUFS`);
  },

  true_peak(a, bound, film, measured) {
    const v = measured.audio?.truePeakDbtp;
    if (typeof v !== 'number') return skipped(a.text, '没有成片真峰值的量测（measured.audio.truePeakDbtp）');
    return cmpOk(v, a.cmp) ? pass(a.text, v) : fail(a.text, v, null, `整片真峰值 ${cmpText(a.cmp)} dBTP`);
  },

  cut_at(a, bound, film, measured, range) {
    if (!Array.isArray(measured.cuts)) return skipped(a.text, '没有成片切点的检测结果（measured.cuts）');
    const at = bound.at;
    const want = at.kind === 'ident' ? shotsOf(film).slice(1).map((s) => s.in) : [at.value];
    const missing = want.filter((f) => inRange(f, range) && !measured.cuts.includes(f));
    return missing.length ? fail(a.text, { cuts: measured.cuts, missing }, missing[0], `在 ${want.join(', ')} 检出切点`) : pass(a.text, { cuts: measured.cuts });
  },

  no_cut(a, bound, film, measured, range) {
    if (!Array.isArray(measured.cuts)) return skipped(a.text, '没有成片切点的检测结果（measured.cuts）');
    const cutsOfFilm = shotsOf(film).slice(1).map((s) => s.in);
    const extra = measured.cuts.filter((f) => inRange(f, range) && !cutsOfFilm.includes(f));
    return extra.length ? fail(a.text, { cuts: measured.cuts, extra }, extra[0], '镜头表的切点以外没有切') : pass(a.text, { cuts: measured.cuts });
  },

  // 这里的镜头都是 full 合规档（limited 的在 evaluateAssertion 里已经分出去）：没有抽样帧、主角在抽到的帧里一直缺席，都判不过，不判 skipped
  inside_frame(a, bound, film, measured, range, shots) {
    const margin = bound.margin?.value ?? 0;
    let worst = Infinity, frames = 0;
    for (const shot of shots) {
      const name = entityName(bound.entity, shot);
      if (!name) return fail(a.text, null, shot.in, `镜头 ${shot.id} 有 ${bound.entity.name}`);
      const from = Math.max(shot.in, range[0]);
      const sampled = sampledIn(measured, [from, Math.min(shot.out, range[1])]);
      if (!sampled.length) return fail(a.text, { entity: name, shot: shot.id, sampledFrames: 0 }, from, `镜头 ${shot.id} 在范围里有抽样帧的元数据`);
      let inShot = 0, gapFrame = null;
      for (const { frame, meta } of sampled) {
        const e = metaEntity(meta, name);
        if (!Array.isArray(meta?.entities)) return fail(a.text, null, frame, 'full 镜头的抽样帧带 entities');
        if (!e || e.pxArea === 0) {
          if (inShot && gapFrame === null) gapFrame = frame;
          continue;
        }
        if (gapFrame !== null) return fail(a.text, { entity: name }, gapFrame, `${name} 从入场到出场都在画内`);
        if (!isSize(meta.size) || !isBox(e.bbox2d)) return fail(a.text, { entity: name, shot: shot.id }, frame, '元数据带 size [宽, 高] 和实体的 bbox2d [x0, y0, x1, y1]（像素）');
        const [w, h] = meta.size;
        const m = Math.min(e.bbox2d[0] / w, e.bbox2d[1] / h, (w - e.bbox2d[2]) / w, (h - e.bbox2d[3]) / h);
        inShot++;
        if (m < worst) worst = m;
        if (m < margin) return fail(a.text, { entity: name, margin: m }, frame, `${name} 四边留 ${margin}（画幅的比例）`);
      }
      if (!inShot) return fail(a.text, { entity: name, shot: shot.id, sampledFrames: sampled.length, framesInFrame: 0 }, sampled[0].frame, `镜头 ${shot.id} 抽到的帧里 ${name} 入画`);
      frames += inShot;
    }
    return pass(a.text, { minMargin: worst, frames });
  },

  visible(a, bound, film, measured, range, shots) {
    const results = [];
    for (const shot of shots) {
      const name = entityName(bound.entity, shot);
      if (!name) return fail(a.text, null, shot.in, `镜头 ${shot.id} 有 ${bound.entity.name}`);
      const from = Math.max(shot.in, range[0]);
      const seen = [];
      for (const { frame, meta } of sampledIn(measured, [from, Math.min(shot.out, range[1])])) {
        if (!Array.isArray(meta?.entities)) return fail(a.text, null, frame, 'full 镜头的抽样帧带 entities');
        const e = metaEntity(meta, name);
        if (!e) continue;
        if (!(Number.isFinite(e.pxArea) && e.pxArea >= 0 && e.pxArea <= 1)) return fail(a.text, null, frame, '每个抽样帧的屏占都能参与峰值比较');
        seen.push({ frame, e });
      }
      if (!seen.length) return fail(a.text, { entity: name, peakArea: 0 }, from, `镜头 ${shot.id} 的 ${name} 屏占峰值 >= ${HERO_PEAK_AREA_MIN}`);
      const peak = seen.reduce((p, x) => (x.e.pxArea > p.e.pxArea ? x : p));
      const isHero = bound.entity.name === 'hero';
      if (isHero && peak.e.pxArea < HERO_PEAK_AREA_MIN) {
        return fail(a.text, { entity: name, peakArea: peak.e.pxArea }, peak.frame, `镜头 ${shot.id} 的 ${name} 屏占峰值 >= ${HERO_PEAK_AREA_MIN}`);
      }
      // 就在屏占最大的那一帧上判（PR 契约 5.6 第 5 条）；那一帧没量可见比例就是判不过，不换别的帧
      if (!(Number.isFinite(peak.e.visible) && peak.e.visible >= 0 && peak.e.visible <= 1)) {
        return fail(a.text, { entity: name, peakArea: peak.e.pxArea }, peak.frame, `镜头 ${shot.id} 屏占最大的第 ${peak.frame} 帧量出 ${name} 的可见比例`);
      }
      if (!cmpOk(peak.e.visible, a.cmp)) return fail(a.text, { entity: name, visible: peak.e.visible, peakArea: peak.e.pxArea }, peak.frame, `${name} 可见比例 ${cmpText(a.cmp)}`);
      results.push({ shot: shot.id, frame: peak.frame, visible: peak.e.visible, peakArea: peak.e.pxArea });
    }
    return pass(a.text, results);
  },

  text_matches(a, bound, film, measured, range) {
    const t = bound.text;
    const copy = t.kind === 'text' ? [{ text: t.text, in: range[0], out: range[1] }] : copyOf(film, range);
    if (!copy.length) return skipped(a.text, '文案是空的（has-text 不成立）');
    const frames = sampledIn(measured, range);
    let checked = 0;
    for (const { frame, meta, ocr } of frames) {
      const want = copy.filter((c) => frame >= c.in && frame < c.out).map((c) => c.text).sort();
      if (!want.length || !Array.isArray(meta?.texts)) continue;
      const inMeta = objectsIn(meta.texts).map((x) => x.text).sort();
      const inOcr = objectsIn(ocr).map((x) => x.text).sort();
      checked++;
      const lost = want.find((w) => !inMeta.includes(w) || !inOcr.includes(w));
      if (lost !== undefined) return fail(a.text, { frame, copy: want, meta: inMeta, ocr: inOcr }, frame, `文案「${lost}」在文字框和文字识别里逐字出现`);
      if (inMeta.join('\n') !== inOcr.join('\n')) return fail(a.text, { frame, copy: want, meta: inMeta, ocr: inOcr }, frame, '文字框和文字识别逐字一致');
    }
    return checked ? pass(a.text, { frames: checked }) : skipped(a.text, '抽到的帧里没有落在文案区间、又带文字框的');
  },
};

/** 实参里的实体落到这个镜头上：角色名查镜头的 roles，别的原样；hero 没绑是 null */
function entityName(v, shot) {
  if (v.name === 'hero') return typeof shot.roles?.hero === 'string' && shot.roles.hero ? shot.roles.hero : null;
  return v.name;
}

/**
 * 求一条断言。measured 是成片和抽帧的量测：
 *   output { size:[宽,高] 像素, fps:'分子/分母', frames 帧, colorTag }、blackFrames [帧]、freezes [{ in, out }]（帧，半开）、
 *   audio { loudnessLufs, truePeakDbtp }、cuts [帧]、frames [{ frame 全片帧号, meta 每帧元数据, ocr [{ text, bbox2d }] }]、
 *   conformance { 镜头 id: 'full' | 'limited' }（可选）。
 * 返回 pass：{ ok:true, status, predicate, measured }；fail：{ ok:false, status, predicate, measured, counterexampleFrame, expected, fixes }；
 * skipped：{ ok:null, status, predicate, reason }。counterexampleFrame 是全片帧号，整片一个数、没有具体帧的是 null。
 * 片子描述或量测不成形、谓词没登记或登记成 planned，都是 fail，不抛异常。
 */
export function evaluateAssertion(text, film, measured = {}, options = {}) {
  const { limitedItem = true } = options ?? {};
  if (!isObj(film)) return fail(String(text), null, null, '片子描述是对象', []);
  if (!isObj(measured)) return fail(String(text), null, null, '量测 measured 是对象', []);
  const c = checkAssertion(text);
  if (!c.ok) return fail(String(text), { errors: c.errors }, null, '本版已有的谓词、合法的实参', []);
  const a = c.assertion;
  const ev = Object.hasOwn(EVALUATORS, a.name) ? EVALUATORS[a.name] : null;
  if (!ev) return fail(a.text, null, null, `本版有谓词 ${a.name} 的求值`, []);
  const range = scopeRange(a.scope, film);
  if (!range) return fail(a.text, null, null, '范围解得出', []);
  const pred = registered(a.name);
  const needsEntities = pred.reads.some((r) => r.startsWith('meta.entities'));
  const inScope = shotsOf(film).filter((s) => Number.isInteger(s.in) && Number.isInteger(s.out) && s.in < range[1] && s.out > range[0]);
  const judgeable = inScope.filter((s) => !(needsEntities || !limitedItem) || shotConformance(s, measured) !== 'limited');
  if (needsEntities && !inScope.length) return fail(a.text, null, null, '范围里有镜头', []);
  if (needsEntities && !judgeable.length) return skipped(a.text, '范围里的镜头都是 limited 合规档，交不出 entities');
  return ev(a, c.bound, film, measured, range, judgeable);
}

const hasAudio = (film) => isObj(film?.audio) && film.audio.mode !== 'none';
const hasText = (film) => copyOf(film, [0, Number.isInteger(film?.output?.frames) ? film.output.frames : 0]).length > 0;

/**
 * 求一个模板条目（几条断言用 ` ; ` 连起来的）。when 不成立的整条判 skipped；
 * limited 是 false 的条目在 limited 合规档的镜头上不判。
 * 返回 { expr, status, results }：有一条 fail 就是 fail，全部 skipped 是 skipped，否则 pass。
 */
export function evaluateItem(item, film, measured = {}) {
  if (!isObj(item) || typeof item.expr !== 'string') return { expr: '', status: 'fail', results: [fail('', null, null, '模板条目带字符串 expr')] };
  if (item.when === 'has-audio' && !hasAudio(film)) return { expr: item.expr, status: 'skipped', reason: '片子不出声音（has-audio 不成立）', results: [] };
  if (item.when === 'has-text' && !hasText(film)) return { expr: item.expr, status: 'skipped', reason: '文案是空的（has-text 不成立）', results: [] };
  const results = splitItem(item.expr).map((t) => evaluateAssertion(t, film, measured, { limitedItem: item.limited }));
  const status = results.some((r) => r.status === 'fail') ? 'fail' : results.every((r) => r.status === 'skipped') ? 'skipped' : 'pass';
  return { expr: item.expr, status, results };
}

/** floor 1 版六条逐条求值 */
export const evaluateFloor = (film, measured = {}) => FLOOR.items.map((it) => evaluateItem(it, film, measured));

/** 一条求值结果转成判定条目（PR 契约 3.5）：没有的字段不出现，不写 null */
export function toVerdict(result, { base = true } = {}) {
  const name = String(result.predicate).match(NAME_RE)?.[0] ?? 'unknown';
  const v = { id: `pred.${name}`, layer: 'L3', status: result.status, base };
  if (Number.isInteger(result.counterexampleFrame)) v.atFrames = [result.counterexampleFrame];
  if (result.measured !== undefined && result.measured !== null) v.value = result.measured;
  if (result.expected) v.expected = result.expected;
  if (result.status === 'skipped') v.reason = result.reason;
  const fix = (result.fixes ?? []).find((f) => f.applicability === 'machine');
  if (fix) v.fix = fix;
  return v;
}

/* ---------------- 防削弱守卫 ---------------- */

const SPATIAL = ['inside_frame', 'visible'];
const ENTITY_NAME_RE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
const SHOT_ID_RE = /^[a-z][a-z0-9-]*$/;

/** 两条同名断言比松紧：b 比 a 松就返回原因，否则 null。只比阈值（比较）和数值型的命名参数 margin */
function loosened(a, b) {
  const target = (x) => JSON.stringify(x.args.filter((g) => g.value.kind !== 'number').map((g) => g.value));
  if (a.name !== b.name || target(a) !== target(b)) return null;
  if (a.cmp && !b.cmp) return `去掉了比较 ${cmpText(a.cmp)}`;
  if (a.cmp && b.cmp) {
    if (a.cmp.op !== b.cmp.op) return `比较从 ${cmpText(a.cmp)} 改成了 ${cmpText(b.cmp)}`;
    if (a.cmp.op === '>=' && b.cmp.value < a.cmp.value) return `下限从 ${a.cmp.value} 降到 ${b.cmp.value}`;
    if (a.cmp.op === '<=' && b.cmp.value > a.cmp.value) return `上限从 ${a.cmp.value} 升到 ${b.cmp.value}`;
    if (a.cmp.op === 'in' && (b.cmp.lo < a.cmp.lo || b.cmp.hi > a.cmp.hi)) return `区间从 [${a.cmp.lo},${a.cmp.hi}] 放宽到 [${b.cmp.lo},${b.cmp.hi}]`;
  }
  const marginOf = (x) => x.args.find((g) => g.name === 'margin' || (g.name === null && x.name === 'inside_frame' && g.value.kind === 'number'))?.value.value;
  const ma = marginOf(a), mb = marginOf(b);
  if (ma !== undefined && (mb === undefined || mb < ma)) return `margin 从 ${ma} 降到 ${mb ?? 0}`;
  return null;
}

const refOf = (tpl) => (tpl.name === 'floor' ? `floor@${tpl.version.split('.')[0]}` : `template:${tpl.name}@${tpl.version.split('.')[0]}`);
const BASE_HINT = 'predicates.base 只有服务器能写：由服务器在接受写入时把引用注入，这里不给修法';

/**
 * 防削弱守卫。templateOrQuestion 是片子选的模板（{ name, version, roles, items }，照 PR 契约 3.4）或题目
 * （{ base: [断言…], roles?: [...] }），可以是 null。
 * 模板只认登记表（predicates.json）里的那一份：要哪些角色（roles）、每条的 expr、limited、when、uses 都以登记表为准，
 * 调用方给的副本只拿来比，哪一处和登记表不一样就报。
 * options.entities 是 { 镜头 id: [构建交出的实体名] }，用来核 hero 绑的实体存在：full 合规档的镜头没给实体表的，
 * 核不了，记进 unverified，整体 ok 是 false（limited 合规档的镜头交不出实体，不核）。
 * 返回 { ok, violations: [{ code, path?, message, hint?, fixes }], unverified: [{ path, message }],
 *        film（注入了 floor@1 和模板引用的副本）, items（生效的全部 base 条目，取自登记表） }。
 * ok 只在没有违规、也没有核不了的项时是 true。
 * 五种削弱企图：base-removed（删或改写 base 条目）、threshold-loosened（放宽阈值）、hero-unbound（hero 绑到空或不存在的实体）、
 * role-missing（镜头缺 hero 或模板必填角色留空）、spatial-bypass（换用没有空间断言的模板绕过第 4、5 条）。
 * 修法：predicates/base 只给 hint（只有服务器能写）；predicates/extra 给一条 set，把去掉放宽项的整个数组写回去（maybe 档）。
 */
export function enforcePredicateFloor(film, templateOrQuestion = null, options = {}) {
  const violations = [], unverified = [];
  const add = (code, path, message, more = {}) => violations.push({ code, ...(path ? { path } : {}), message, ...more, fixes: more.fixes ?? [] });
  if (!isObj(film)) {
    add('bad-input', null, '片子描述必须是对象');
    return { ok: false, violations, unverified, film: null, items: FLOOR.items.map((it) => ({ ...it, source: 'floor@1' })) };
  }
  const out = structuredClone(film);
  if (!isObj(out.predicates)) out.predicates = { base: [] };
  const base = Array.isArray(out.predicates.base) ? out.predicates.base.filter((r) => typeof r === 'string') : [];
  const tq = isObj(templateOrQuestion) ? templateOrQuestion : {};
  const entities = isObj(options?.entities) ? options.entities : {};
  const isTemplate = typeof tq.name === 'string' && typeof tq.version === 'string';
  const required = ['floor@1'];
  let tplItems = [], tplRoles = [];
  if (isTemplate) {
    const canonical = registeredTemplate(tq.name, Number(tq.version.split('.')[0]));
    if (!canonical) {
      if (tq.name === 'floor') add('spatial-bypass', 'predicates/base', `floor 只认 ${FLOOR.version.split('.')[0]} 版，给的是 ${tq.version}`, { hint: BASE_HINT });
      else add('base-removed', 'predicates/base', `模板 ${tq.name}@${tq.version} 没有登记`, { hint: BASE_HINT });
    } else {
      const label = canonical.name === 'floor' ? 'floor' : `模板 ${canonical.name}`;
      if (canonical !== FLOOR) { required.push(refOf(canonical)); tplItems = canonical.items; tplRoles = canonical.roles ?? []; }
      // 调用方给的副本逐条和登记表比：expr、limited、when、uses 有一处不同就报
      const mine = Array.isArray(tq.items) ? tq.items : [];
      canonical.items.forEach((it, i) => {
        const m = mine[i];
        if (!isObj(m)) { add('base-removed', 'predicates/base', `${label} 第 ${i + 1} 条 ${it.expr} 被删`, { hint: BASE_HINT }); return; }
        if (m.expr !== it.expr) {
          const theirs = typeof m.expr === 'string' ? splitItem(m.expr) : [];
          const why = splitItem(it.expr).map((t, k) => {
            const pa = parseAssertion(t), pb = parseAssertion(theirs[k] ?? '');
            return pa.ok && pb.ok ? loosened(pa.assertion, pb.assertion) : `${t} 被改写`;
          }).find(Boolean);
          add(why && !why.endsWith('被改写') ? 'threshold-loosened' : 'base-removed', 'predicates/base', `${label} 第 ${i + 1} 条被改成 ${JSON.stringify(m.expr)}${why ? `：${why}` : ''}`, { hint: BASE_HINT });
        }
        if (m.limited !== it.limited) add('base-removed', 'predicates/base', `${label} 第 ${i + 1} 条 ${it.expr} 的 limited 被改成 ${JSON.stringify(m.limited)}，登记的是 ${it.limited}`, { hint: BASE_HINT });
        if (m.when !== it.when) add('base-removed', 'predicates/base', `${label} 第 ${i + 1} 条 ${it.expr} 的 when 被改成 ${JSON.stringify(m.when) ?? '不出现'}，登记的是 ${it.when ?? '不出现'}`, { hint: BASE_HINT });
        if (JSON.stringify(m.uses) !== JSON.stringify(it.uses)) add('base-removed', 'predicates/base', `${label} 第 ${i + 1} 条 ${it.expr} 的 uses 被改成 ${JSON.stringify(m.uses)}`, { hint: BASE_HINT });
      });
      const given = Array.isArray(tq.roles) ? tq.roles : [];
      for (const role of canonical.roles ?? []) {
        if (!given.includes(role)) add('role-missing', 'predicates/base', `${label} 的副本把必填角色 ${role} 从 roles 里去掉了，仍按登记表要求`, { hint: BASE_HINT });
      }
    }
  }
  // 题目自带的 base 断言
  const questionBase = !isTemplate && Array.isArray(tq.base) ? tq.base.filter((x) => typeof x === 'string') : [];
  // 换用没有空间断言的模板：floor@1 不在 base 里，又没有别的条目判第 4、5 条
  const floorRefs = base.filter((r) => /^floor@/.test(r));
  const usesSpatial = (exprs) => exprs.some((e) => splitItem(e).some((t) => SPATIAL.includes(parseAssertion(t).assertion?.name)));
  if (!base.includes('floor@1')) {
    add('base-removed', 'predicates/base', '最低谓词 floor@1 不在 predicates.base 里', { hint: BASE_HINT });
    const others = [...tplItems.map((x) => x.expr), ...questionBase];
    if (!usesSpatial(others) || floorRefs.length) add('spatial-bypass', 'predicates/base', `去掉 floor@1${floorRefs.length ? `、换成 ${floorRefs.join(', ')}` : ''} 之后没有条目判主角在画内和可见（floor 第 4、5 条）`, { hint: BASE_HINT });
  }
  for (const r of required.slice(1)) if (!base.includes(r)) add('base-removed', 'predicates/base', `模板引用 ${r} 不在 predicates.base 里`, { hint: BASE_HINT });
  // 注入
  out.predicates.base = [...new Set([...required, ...base.filter((r) => !floorRefs.includes(r) || r === 'floor@1')])];
  const items = [
    ...FLOOR.items.map((it) => ({ ...it, source: 'floor@1' })),
    ...tplItems.map((it) => ({ ...it, source: required[1] })),
    ...questionBase.map((expr) => ({ expr, uses: [], limited: false, source: 'question' })),
  ];
  // 放宽阈值：extra 里和 base 同一谓词、同一对象的断言更松
  const baseAssertions = items.flatMap((it) => splitItem(it.expr)).map((t) => parseAssertion(t)).filter((p) => p.ok).map((p) => p.assertion);
  const extra = Array.isArray(out.predicates.extra) ? out.predicates.extra : [];
  const loose = [];
  for (const x of extra) {
    const p = typeof x === 'string' ? parseAssertion(x) : { ok: false };
    if (!p.ok) continue;
    for (const b of baseAssertions) {
      const why = loosened(b, p.assertion);
      if (why) loose.push({ x, message: `追加的 ${x} 比 base 的 ${b.text} 松：${why}` });
    }
  }
  // predicates.extra 不能寻址到项，修法是用 set 把去掉全部放宽项的整个数组写回去
  const kept = extra.filter((x) => !loose.some((l) => l.x === x));
  for (const l of loose) {
    add('threshold-loosened', 'predicates/extra', l.message, { hint: '去掉这一条，或者把阈值改得不比 base 松', fixes: [{ op: 'set', path: 'predicates/extra', value: kept, applicability: 'maybe' }] });
  }
  // 角色：每个镜头要有 hero（floor），登记的模板要的角色、题目要的角色也要有
  const roles = [...new Set([...FLOOR.roles, ...tplRoles, ...(!isTemplate && Array.isArray(tq.roles) ? tq.roles.filter((r) => typeof r === 'string') : [])])];
  const rawShots = Array.isArray(out.shots) ? out.shots : [];
  rawShots.forEach((shot, i) => {
    if (!isObj(shot) || typeof shot.id !== 'string' || !SHOT_ID_RE.test(shot.id)) { add('role-missing', 'shots', `shots 第 ${i + 1} 项不是带合法 id 的镜头，角色核不了`); return; }
    const r = isObj(shot.roles) ? shot.roles : {};
    for (const role of roles) {
      const v = r[role];
      if (!Object.hasOwn(r, role)) { add('role-missing', `shots/${shot.id}/roles`, `镜头 ${shot.id} 缺角色 ${role}`); continue; }
      const empty = role === 'hero' ? typeof v !== 'string' || !v.trim() : !Array.isArray(v) || v.length === 0;
      if (empty && role === 'hero') add('hero-unbound', `shots/${shot.id}/roles/hero`, `镜头 ${shot.id} 的 hero 绑到了空值`);
      else if (empty) add('role-missing', `shots/${shot.id}/roles/${role}`, `镜头 ${shot.id} 的 ${role} 留空`);
    }
    if (typeof r.hero !== 'string' || !r.hero.trim()) return;
    const at = `shots/${shot.id}/roles/hero`;
    if (!ENTITY_NAME_RE.test(r.hero)) { add('hero-unbound', at, `镜头 ${shot.id} 的 hero「${r.hero}」不是合法的实体名`); return; }
    if (shotConformance(shot) === 'limited') return;
    const known = Object.hasOwn(entities, shot.id) && Array.isArray(entities[shot.id]) ? entities[shot.id] : null;
    if (!known) unverified.push({ path: at, message: `镜头 ${shot.id} 没给构建交出的实体表（options.entities），hero「${r.hero}」存不存在核不了` });
    else if (!known.includes(r.hero)) add('hero-unbound', at, `镜头 ${shot.id} 的 hero「${r.hero}」不在构建交出的实体里`);
  });
  if (!rawShots.length) add('role-missing', 'shots', '片子没有镜头，角色核不了');
  return { ok: violations.length === 0 && unverified.length === 0, violations, unverified, film: out, items };
}

export { enforcePredicateFloor as guardPredicates };
