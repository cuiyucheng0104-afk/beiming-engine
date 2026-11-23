import { Buffer } from 'node:buffer';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from './contracts/film/schema/film.schema.json' with { type: 'json' };
import sourceRegistry from './contracts/source/source.json' with { type: 'json' };
import { checks as filmChecks } from './contracts/film/check.mjs';

const validateFilmSchema = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
const revStore = new WeakMap();
const limit = 16 * 1024 * 1024;
const get = (o, k) => o != null && Object.hasOwn(o, k) ? o[k] : undefined;
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const put = (o, k, value) => Object.defineProperty(o, k, { value, configurable: true, writable: true, enumerable: true });
const fail = (step, code, message, opIndex) => ({ ok: false, step, code, message, ...(opIndex === undefined ? {} : { opIndex }) });
const argument = 'usage.bad-argument';
const unknown = 'contract.unknown-key';
const badPath = 'contract.bad-path';
const pathOK = path => typeof path === 'string' && /^[^/#\s]+(?:\/[^/#\s]+)*$/u.test(path);
// 输出通道契约 3.1：七个固定通道，加分灯组的写法。调用方给的资料不能再登记别的名字。
const FIXED_PASSES = new Set(['color', 'depth', 'objectId', 'normal', 'motion', 'denoiseAlbedo', 'denoiseNormal']);
const passName = name => FIXED_PASSES.has(name) || /^lightgroup:[a-z0-9][a-z0-9-]*$/.test(name);

// 修订号是存储元数据，不是片子描述的键。载体是本模块私有的表，读它用这个函数。
// 片子描述没有自己的 rev 键时，另在结果上挂一个不可枚举的同名属性，写成 JSON 时不出现。
// 存着的片子带着名叫 rev 的没定义的键时，那个键照旧是数据，film.rev 读到的是它；修订号只从这个函数和响应的 rev 读。
export function getFilmRev(film) {
  if (film == null || typeof film !== 'object') return undefined;
  if (revStore.has(film)) return revStore.get(film);
  if (Object.hasOwn(film, 'rev')) {
    const desc = Object.getOwnPropertyDescriptor(film, 'rev');
    if (desc && !desc.enumerable) return desc.value;
  }
  return undefined;
}

// 每层有自己的键集合。字符串按 RFC 8259 与 Unicode 合法性解码，数先按 IEEE 754 双精度读数。
function scan(text) {
  let pos = 0;
  const token = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const space = /[ \r\n\t]*/y;
  function skip() { space.lastIndex = pos; space.exec(text); pos = space.lastIndex; }
  function take(c) { skip(); if (text[pos] !== c) return false; pos++; return true; }
  function invalid() { throw new SyntaxError(`JSON 第 ${pos + 1} 个码元不合法`); }
  function atom() {
    skip();
    if (text[pos] === '"') {
      const start = pos++;
      while (pos < text.length) {
        const c = text[pos++];
        if (c === '"') {
          const decoded = JSON.parse(text.slice(start, pos));
          if (!decoded.isWellFormed()) throw new SyntaxError('JSON 字符串含不成对代理码元');
          return decoded;
        }
        if (c === '\\') pos++;
      }
      invalid();
    }
    token.lastIndex = pos;
    const match = token.exec(text);
    if (!match) invalid();
    pos = token.lastIndex;
    return JSON.parse(match[0]);
  }
  function read(depth) {
    skip();
    const array = text[pos] === '[';
    if (!array && text[pos] !== '{') return atom();
    if (depth > 128) throw new RangeError('补丁嵌套超过 128 层');
    pos++;
    const result = array ? [] : {}, end = array ? ']' : '}';
    if (take(end)) return result;
    do {
      if (array) result.push(read(depth + 1));
      else {
        const key = atom();
        if (typeof key !== 'string' || !take(':')) invalid();
        if (Object.hasOwn(result, key)) throw new SyntaxError(`对象键重复 ${key}`);
        put(result, key, read(depth + 1));
      }
    } while (take(','));
    if (!take(end)) invalid();
    return result;
  }
  const body = read(1);
  skip(); if (pos !== text.length) invalid();
  return body;
}

export function parseRequestText(rawText, options = {}) {
  try {
    const max = Math.min(get(options, 'maxBytes') ?? limit, limit);
    const bytes = rawText instanceof Uint8Array;
    if (!bytes && (typeof rawText !== 'string' || !rawText.isWellFormed())) throw new TypeError('需要合法 UTF-8 文本');
    if ((bytes ? rawText.byteLength : Buffer.byteLength(rawText)) > max) throw new RangeError('补丁超过字节上限');
    const body = scan(bytes ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawText) : rawText);
    if (!obj(body)) throw new TypeError('补丁顶层必须是对象');
    return { ok: true, body };
  } catch (error) { return fail(1, argument, error.message); }
}

const def = s => get(s, '$ref') ? get(schema.$defs, s.$ref.split('/').at(-1)) : s;
const any = true;
function child(s, key) {
  if (s === any) return any;
  if (s?.type !== 'object') return undefined;
  return def(get(s.properties, key) ?? (s.additionalProperties === false ? undefined : s.additionalProperties ?? any));
}
const arrays = new Map(['shots', 'events', 'transitions', 'overlays'].map(k => [schema.properties[k], 'id']));
arrays.set(schema.properties.audio.properties.narration, 'id');
arrays.set(schema.$defs.shot.properties.cards, 'as');

function pathError(parts, op) {
  let s = schema;
  for (const [i, key] of parts.entries()) {
    if (s === any) break;
    if (arrays.has(s)) {
      if (arrays.get(s) === 'id' && /^[0-9]+$/.test(key)) return { code: badPath };
      s = def(s.items);
    } else {
      if (s.type !== 'object') return { code: badPath };
      const next = child(s, key);
      if (!next) {
        if (i === parts.length - 1 && ['remove', 'rename'].includes(op)) return;
        const at = parts.slice(0, i + 1).join('/');
        return { code: unknown, at, diagnostics: [{ code: unknown, at, message: `${at} 不是契约定义的键`, hint: hint(key, Object.keys(s.properties)) }] };
      }
      s = next;
    }
  }
}

function readonly(op, server) {
  const path = get(op, 'path');
  if (!pathOK(path)) return;
  const dest = get(op, 'op') === 'rename' && typeof get(op, 'to') === 'string' && !op.to.includes('/')
    ? path.slice(0, path.lastIndexOf('/') + 1) + op.to : '';
  if ([path, dest].some(p => p === 'id' || p === 'exam')) return 'contract.immutable-key';
  if (!server && [path, dest].some(p => p === 'predicates' || p === 'predicates/base')) return 'auth.base-readonly';
}

function hint(key, names) {
  let best, score = Infinity;
  for (const name of names) {
    if (Math.abs(key.length - name.length) > 2) continue;
    let row = Array.from({ length: name.length + 1 }, (_, i) => i);
    for (const ch of key) {
      const next = [row[0] + 1];
      for (let i = 0; i < name.length; i++) next.push(Math.min(next[i] + 1, row[i + 1] + 1, row[i] + Number(name[i] !== ch)));
      row = next;
    }
    if (row.at(-1) < score) { best = name; score = row.at(-1); }
  }
  return `未知键 ${key}` + (score <= 2 && score < Math.min(key.length, best.length) ? `，是否指 ${best}` : '');
}

function shapeError(body) {
  const ops = get(body, 'ops');
  const found = [];
  const look = (v, names, where, index) => {
    for (const key of Object.keys(v)) if (!names.includes(key)) found.push({ index, hint: `${where}：${hint(key, names)}` });
  };
  look(body, ['format', 'rev', 'ops'], '补丁顶层');
  if (Array.isArray(ops)) for (const [i, op] of ops.entries()) if (obj(op)) look(op, ['op', 'path', 'value', 'to'], `ops ${nth(i)}`, i);
  // 补丁里的键不在片子描述里，诊断不带 at
  if (found.length) {
    return { ...fail(3, unknown, found[0].hint, found[0].index),
      diagnostics: found.map(f => ({ code: unknown, message: '补丁里有 PA 契约第 3 节在这一层没列的键', hint: f.hint })) };
  }
  if (get(body, 'format') !== 'patch/0.1' || !Array.isArray(ops) || !ops.length) return fail(3, argument, '补丁格式或 ops 不合法');
  for (const [i, op] of ops.entries()) {
    const kind = get(op, 'op');
    if (!obj(op) || !['set', 'remove', 'rename', 'add'].includes(kind) || typeof get(op, 'path') !== 'string' ||
        Object.hasOwn(op, 'value') !== ['set', 'add'].includes(kind) || Object.hasOwn(op, 'to') !== (kind === 'rename') ||
        (kind === 'rename' && !(pathOK(op.to) && !op.to.includes('/'))) || !finite(op)) return fail(3, argument, '操作不合补丁契约', i);
  }
}
function finite(v) {
  return typeof v === 'number' ? Number.isFinite(v) : v === null || typeof v !== 'object' || Object.values(v).every(finite);
}

// 工作副本按路径复制祖先。旧片子中的深层扩展不经过序列化，也不被写入。
function apply(doc, parts, op) {
  function visit(v, s, i) {
    const key = parts[i], field = arrays.get(s), isArray = Array.isArray(v);
    if (i === parts.length) {
      if (!isArray || !field || !obj(op.value) || !Object.hasOwn(op.value, field)) return;
      const id = op.value[field];
      if (typeof id === 'string' && v.some(e => get(e, field) === id)) return;
      return [...v, op.value];
    }
    let slot = key, nextSchema;
    if (isArray) {
      if (!field) return;
      slot = v.findIndex(e => get(e, field) === key);
      if (slot < 0 || slot !== v.findLastIndex(e => get(e, field) === key)) return;
      nextSchema = def(s.items);
    } else {
      if (!obj(v)) return;
      nextSchema = child(s, key);
    }
    const copy = isArray ? v.slice() : { ...v };
    if (i + 1 < parts.length || op.op === 'add') {
      const updated = visit(get(v, slot), nextSchema, i + 1);
      if (updated === undefined) return;
      put(copy, slot, updated);
    } else if (op.op === 'set') {
      if (isArray && get(op.value, field) !== key) return;
      put(copy, slot, op.value);
    } else {
      if (!Object.hasOwn(v, slot)) return;
      if (op.op === 'rename') {
        if (isArray || Object.hasOwn(v, op.to)) return;
        put(copy, op.to, v[slot]);
      }
      if (isArray) copy.splice(slot, 1); else delete copy[slot];
    }
    return copy;
  }
  return visit(doc, schema, 0);
}

function equal(a, b) {
  const stack = [[a, b]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x === y) continue;
    if (!x || !y || typeof x !== 'object' || typeof y !== 'object' || Array.isArray(x) !== Array.isArray(y)) return false;
    if (Array.isArray(x)) {
      if (x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) stack.push([x[i], y[i]]);
    } else {
      const keys = Object.keys(x);
      if (keys.length !== Object.keys(y).length) return false;
      for (const k of keys) {
        if (!Object.hasOwn(y, k)) return false;
        stack.push([x[k], y[k]]);
      }
    }
  }
  return true;
}

function validItemId(s, entry) {
  const field = arrays.get(s);
  if (!field || !obj(entry)) return false;
  const id = get(entry, field);
  if (typeof id !== 'string') return false;
  if (field === 'as') return /^[A-Za-z0-9_]+$/.test(id) && !['tracks', 'host'].includes(id);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return false;
  if (s === schema.properties.shots && id === 'film') return false;
  if (s === schema.properties.overlays && (id.includes('-') || ['tracks', 'host'].includes(id))) return false;
  return true;
}

const segment = key => pathOK(key) && !key.includes('/');
const nth = i => `第 ${i + 1} 项（下标 ${i}）`;

// 在校验视图里略去没定义的键。获准保留的键连同它的值不判，别的各记一条诊断。
// 候选的旧条目跟着结构和标识走，不跨类型、不跨重复的条目拼。
function inspect(doc, stored) {
  const unknownKeys = [];
  let tooDeep = false;
  function walk(v, s, old, path, depth, fixedAt, fixedNote) {
    if (v === null || typeof v !== 'object') return v;
    if (depth > 128) { tooDeep = true; return null; }
    if (Array.isArray(v)) {
      const field = arrays.get(s), item = def(s?.items);
      const candidates = old.filter(Array.isArray);
      const keyed = new Map();
      if (field) for (const arr of candidates) for (const entry of arr) {
        const id = get(entry, field);
        if (!keyed.has(id)) keyed.set(id, []);
        keyed.get(id).push(entry);
      }
      const same = field ? [] : candidates.filter(arr => equal(arr, v));
      return v.map((entry, i) => {
        const okId = validItemId(s, entry);
        const id = okId ? get(entry, field) : undefined;
        return walk(entry, item, okId ? keyed.get(id) ?? [] : same.map(arr => arr[i]),
          okId ? [...path, id] : path, depth + 1, fixedAt ?? (okId ? undefined : path.join('/')),
          fixedNote ?? (okId ? undefined : nth(i)));
      });
    }
    const entries = [];
    for (const [key, value] of Object.entries(v)) {
      const prior = old.filter(o => obj(o) && Object.hasOwn(o, key)).map(o => o[key]);
      const sub = child(s, key);
      if (s?.type === 'object' && s.additionalProperties === false && !sub) {
        if (prior.some(p => equal(p, value))) continue;
        const at = fixedAt ?? (segment(key) ? [...path, key] : path).join('/');
        const note = fixedNote ?? (segment(key) ? '' : `键名 ${JSON.stringify(key)} 写不成路径`);
        const text = hint(key, Object.keys(s.properties));
        unknownKeys.push({ id: `U|${at}|${note}|${key}`, ...(at ? { at } : {}), hint: note ? `${note}：${text}` : text });
      } else {
        const ok = segment(key);
        entries.push([key, walk(value, sub, prior, ok ? [...path, key] : path, depth + 1,
          fixedAt ?? (ok ? undefined : path.join('/')), fixedNote ?? (ok ? undefined : `键 ${JSON.stringify(key)} 下面`))]);
      }
    }
    return Object.fromEntries(entries);
  }
  const view = walk(doc, schema, [stored], [], 1);
  return { view, unknownKeys, tooDeep };
}

// 逐层复制输出。存量豁免值可以很深，不能依赖调用栈深拷贝。
function copyFilm(film) {
  const result = {}, pending = [[film, result]];
  while (pending.length) {
    const [source, target] = pending.pop();
    for (const [key, value] of Object.entries(source)) {
      if (value !== null && typeof value === 'object') {
        const copy = Array.isArray(value) ? [] : {};
        put(target, key, copy);
        pending.push([value, copy]);
      } else put(target, key, value);
    }
  }
  return result;
}

function reduced(fps) {
  let [a, b] = fps.split('/').map(BigInt);
  while (b) [a, b] = [b, a % b];
  return a === 1n;
}

// 结构定义报的位置换成 D 契约 5.4 的路径：按标识寻址的数组写标识。
// 项没有合法标识，或者在不能寻址到项的数组里，at 停在那个数组上，note 说是第几项。
function locate(view, instancePath, missing) {
  const tokens = instancePath ? instancePath.slice(1).split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~')) : [];
  let cur = view, s = schema, stopped = false, note = '';
  const parts = [];
  for (const seg of tokens) {
    if (Array.isArray(cur)) {
      const index = Number(seg), entry = cur[index];
      if (!stopped) {
        if (validItemId(s, entry)) parts.push(get(entry, arrays.get(s)));
        else { stopped = true; note = nth(index); }
      }
      cur = entry;
      s = def(s?.items);
    } else {
      if (!stopped) {
        if (segment(seg)) parts.push(seg);
        else { stopped = true; note = `键 ${JSON.stringify(seg)} 下面`; }
      }
      cur = get(cur, seg);
      s = child(s, seg);
    }
  }
  if (!stopped && missing !== undefined && segment(missing)) parts.push(missing);
  return { at: parts.join('/'), note };
}

function expected(e) {
  const p = e.params ?? {}, show = v => JSON.stringify(v);
  switch (e.keyword) {
    case 'required': return `缺必填键 ${p.missingProperty}`;
    case 'type': return `类型应是 ${[p.type].flat().join(' 或 ')}`;
    case 'minimum': case 'maximum': case 'exclusiveMinimum': case 'exclusiveMaximum': return `数值应 ${p.comparison} ${p.limit}`;
    case 'enum': return `应是 ${p.allowedValues.map(show).join('、')} 之一`;
    case 'const': return `应是 ${show(p.allowedValue)}`;
    case 'pattern': return `写法应合正则 ${p.pattern}`;
    case 'minItems': return `至少 ${p.limit} 项`;
    case 'maxItems': return `至多 ${p.limit} 项`;
    case 'minLength': return `至少 ${p.limit} 个字符`;
    case 'uniqueItems': return `${nth(p.j)}和${nth(p.i)}重复`;
    case 'propertyNames': return `键名 ${show(p.propertyName)} 的写法不合：自由键不空，不含 /、#、空白；别名、镜头标识照 D 契约 5.1`;
    case 'anyOf': return e.schemaPath.includes('/moment/')
      ? '应是不小于 0 的整数帧号，或时刻算式，例如 cut(180) + 12、event(title) - 2'
      : '不合任何一种允许的写法';
    case 'not': return '这个写法或这个键在这里不得出现';
    default: return `不合结构定义：${e.message}`;
  }
}

const patchSourceRegistry = structuredClone(sourceRegistry);
patchSourceRegistry.sources.three.hosts = [...patchSourceRegistry.sources.three.hosts, 'any'];
const filmContext = { registries: { source: patchSourceRegistry }, schema: null };

// 第 6 步在一份片子描述上查出的全部违反：没定义的键一列，其余值域违反一列。每处带一个跨状态可比的 id。
function violations(doc, base) {
  const { view, unknownKeys, tooDeep } = inspect(doc, base);
  const badValues = [];
  if (!validateFilmSchema(view)) for (const e of validateFilmSchema.errors) {
    // 分支里的细项、键名细项各有一条汇总的错，只留汇总的
    if (e.keyword === 'if' || e.propertyName !== undefined || /\/anyOf\/[0-9]+\//.test(e.schemaPath)) continue;
    const { at, note } = locate(view, e.instancePath, e.keyword === 'required' ? e.params.missingProperty : undefined);
    const text = expected(e), where = [at, note].filter(Boolean).join(' ') || '片子描述';
    badValues.push({ id: `S|${at}|${note}|${e.schemaPath}|${JSON.stringify(e.params)}`, ...(at ? { at } : {}),
      message: `${where}：${text}`, hint: note ? `${note}：${text}` : text });
  }
  if (tooDeep) badValues.push({ id: 'N', message: '片子描述的对象和数组嵌套超过 128 层', hint: '最外层算第 1 层，两处 params 里的嵌套照算' });
  // 判定函数只对结构合法的对象负责。结构没过时照样跑一遍，只为认出这处违反是哪个操作写出来的；出错的那条不算数。
  const checkView = get(view, 'format') === 'film/3.0' ? view : { ...view, format: 'film/3.0' };
  for (const [name, check] of Object.entries(filmChecks)) {
    if (name === 'D20') continue;
    let problems = [];
    try { problems = check(checkView, filmContext); } catch { /* 结构已经坏了，这一条判不了 */ }
    for (const message of problems) badValues.push({ id: `C|${name}|${message}`, message: `${name}：${message}` });
  }
  const extra = get(get(view, 'predicates'), 'extra');
  if (Array.isArray(extra)) for (const [i, item] of extra.entries()) {
    if (typeof item === 'string' && item.replace(/"[^"]*"/g, '').includes(';')) {
      badValues.push({
        id: `D20|${i}|${item}`,
        at: 'predicates/extra',
        message: `D20：predicates/extra ${nth(i)}：${JSON.stringify(item)} 在双引号外带了 ";"，一项只能写一条断言`,
        hint: `${nth(i)}：一项只写一条断言，去掉双引号外的 ";" 或拆成多项`,
      });
    }
  }
  const fps = get(get(view, 'output'), 'fps');
  if (typeof fps === 'string' && /^[1-9][0-9]*\/[1-9][0-9]*$/.test(fps) && !reduced(fps)) {
    badValues.push({ id: 'F', at: 'output/fps', message: `output/fps：${fps} 没有约到最简`, hint: '分子分母约到互质，例如 60/2 写成 30/1' });
  }
  const layers = get(get(view, 'delivery'), 'layers');
  if (Array.isArray(layers)) for (const [i, name] of layers.entries()) if (typeof name === 'string' && !passName(name)) {
    badValues.push({ id: `L|${name}`, at: 'delivery/layers', message: `delivery/layers ${nth(i)}：${JSON.stringify(name)} 不是登记过的通道名`,
      hint: `${nth(i)}：通道名只有 ${[...FIXED_PASSES].join('、')}，和 lightgroup:<名>（名是小写字母、数字、连字符，以字母或数字开头）` });
  }
  return { unknownKeys, badValues };
}

// 同一步里几处违反，按写出它的操作在 ops 里的先后排。一处违反算在这样一个操作头上：
// 从它作用完起到全部作用完，这处违反一直都在。作用之前就有、一直没消过的不算哪个操作的，排在最后。
function byWritingOrder(items, states, list) {
  if (items.length < 2 || states.length < 3) return items;
  const last = states.length - 1;
  const since = new Map(items.map(e => [e.id, last]));
  const open = new Set(since.keys());
  for (let k = last - 1; k >= 0 && open.size; k--) {
    const here = new Set(list(states[k]).map(e => e.id));
    for (const id of open) if (here.has(id)) since.set(id, k); else open.delete(id);
  }
  const rank = e => since.get(e.id) || states.length;
  return items.map((e, i) => [e, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([e]) => e);
}

// options.rev 是存储一侧当前的修订号；不给时读 getFilmRev(storedFilm)。options.by 是 'server' 时可以写最低谓词。
// 成功时交回 { ok, film, rev }：film 是新的片子描述，rev 是新的修订号。
export function applyFilmWrite(storedFilm, rawBodyOrObj, options = {}) {
  let raw = rawBodyOrObj;
  if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) {
    try {
      raw = JSON.stringify(raw, (_, v) => {
        if (typeof v === 'number' && !Number.isFinite(v)) return JSON.rawJSON('1e400');
        if (v === undefined || ['function', 'symbol'].includes(typeof v)) throw new TypeError('补丁含非 JSON 值');
        return v;
      });
    } catch (error) { return fail(1, argument, error.message); }
  }
  const parsed = parseRequestText(raw, options);
  if (!parsed.ok) return parsed;
  const body = parsed.body, rev = get(body, 'rev');
  if (!Number.isSafeInteger(rev) || rev < 0) return fail(1, argument, '补丁没带 rev，或者它不是 0 到 9007199254740991 的整数');
  const latestRev = get(options, 'rev') ?? getFilmRev(storedFilm);
  if (!Number.isSafeInteger(latestRev) || latestRev < 0) return fail(1, argument, '缺少合法的存储修订号');
  if (rev !== latestRev) return { ...fail(1, 'busy.rev-conflict', '修订号已过期'), latestRev };
  if (Array.isArray(get(body, 'ops'))) for (const [i, op] of body.ops.entries()) {
    const code = readonly(op, get(options, 'by') === 'server');
    if (code) return fail(2, code, '操作触及只读键', i);
  }
  const shape = shapeError(body);
  if (shape) return shape;
  const paths = [];
  for (const [i, op] of body.ops.entries()) {
    const parts = op.path.split('/');
    const error = pathOK(op.path) ? pathError(parts, op.op) : { code: badPath };
    if (error) return { ...fail(4, error.code, `路径不合法 ${op.path}`, i), ...error };
    paths.push(parts);
  }
  // 只取可枚举的自有键：挂在上一次结果上的修订号不是片子描述的键，不进副本。
  const base = { ...storedFilm };
  const states = [base];
  let film = base;
  for (const [i, op] of body.ops.entries()) {
    film = apply(film, paths[i], op);
    if (!film) return fail(5, 'contract.patch-not-applicable', `操作无法作用于 ${op.path}`, i);
    states.push(film);
  }
  const found = violations(film, base);
  if (found.unknownKeys.length) {
    const ordered = byWritingOrder(found.unknownKeys, states, doc => inspect(doc, base).unknownKeys);
    const diagnostics = ordered.map(({ at, hint: text }) => ({ code: unknown, ...(at ? { at } : {}), message: `${at || '片子描述'} 里有没定义的键`, hint: text }));
    return { ...fail(6, unknown, `${diagnostics[0].message}。${diagnostics[0].hint}`), ...(ordered[0].at ? { at: ordered[0].at } : {}), diagnostics };
  }
  if (found.badValues.length) {
    const [{ at, message, hint: text }] = byWritingOrder(found.badValues, states, doc => violations(doc, base).badValues);
    const where = at ? { at } : {};
    return { ...fail(6, 'contract.bad-value', message), ...where,
      diagnostics: [{ code: 'contract.bad-value', ...where, message, ...(text ? { hint: text } : {}) }] };
  }
  if (!Number.isSafeInteger(rev + 1)) {
    const message = '修订号已到 9007199254740991，没有下一个修订号';
    return { ...fail(6, 'contract.bad-value', message), diagnostics: [{ code: 'contract.bad-value', message }] };
  }
  film = copyFilm(film);
  revStore.set(film, rev + 1);
  if (!Object.hasOwn(film, 'rev')) Object.defineProperty(film, 'rev', { value: rev + 1, configurable: true });
  return { ok: true, film, rev: rev + 1 };
}
