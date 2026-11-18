// 补丁格式契约的判定函数：每条不变量一个，照 CONTRACT.md 第 4 节「怎么查」一栏写。
// 收三种对象：补丁（patch/0.1）、补丁核对记录（patch-check/0.1）、不带 format 的修法；
// 每个函数只判归它管的那一种，别的返回空数组。修法不带 format，从第二个参数的 schema（登记的结构定义文件名）认。

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// 建键一律定义成自有属性：普通赋值遇到 __proto__ 这种键名会去改原型，键建不出来
const put = (o, k, v) => Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });

/** PA1 / PA5 共用：按 op 看 value、to 两个键在不在 */
function shapeProblems(op, where) {
  const want = { set: [true, false], add: [true, false], rename: [false, true], remove: [false, false] }[op.op];
  if (!want) return [`${where}的 op 是 ${JSON.stringify(op.op)}，不是四种操作之一`];
  const out = [];
  if (has(op, 'value') !== want[0]) out.push(`${where}是 ${op.op}，${want[0] ? '没带' : '不该带'} value`);
  if (has(op, 'to') !== want[1]) out.push(`${where}是 ${op.op}，${want[1] ? '没带' : '不该带'} to`);
  return out;
}

const opsShape = (patch, prefix) => (patch?.ops ?? []).flatMap((op, i) => shapeProblems(op, `${prefix}第 ${i + 1} 个操作`));

/** 5.1：这个数组按什么标识寻址；不是按标识寻址的返回 null。keys 是走到它的段，数组条目那段记成 * */
function idFieldOf(keys) {
  const k = keys.join('/');
  if (['shots', 'events', 'overlays', 'transitions', 'audio/narration'].includes(k)) return 'id';
  if (k === 'shots/*/cards') return 'as';
  return null;
}

/** 沿路径往下走，返回 { value, keys }；走不下去返回 null */
function walk(doc, segs) {
  let cur = doc;
  const keys = [];
  for (const s of segs) {
    if (isObj(cur)) {
      if (!has(cur, s)) return null;
      cur = cur[s];
      keys.push(s);
    } else if (Array.isArray(cur) && idFieldOf(keys)) {
      const f = idFieldOf(keys);
      const hit = cur.find((e) => isObj(e) && e[f] === s);
      if (!hit) return null;
      cur = hit;
      keys.push('*');
    } else return null;
  }
  return { value: cur, keys };
}

/** 5.2：把一个操作作用到 doc 上（就地改）；不可作用返回 false */
function applyOp(doc, op) {
  const segs = op.path.split('/');
  const last = segs[segs.length - 1];
  const parent = walk(doc, segs.slice(0, -1));
  const parentIdField = parent && Array.isArray(parent.value) ? idFieldOf(parent.keys) : null;
  switch (op.op) {
    case 'set':
      if (!parent) return false;
      if (isObj(parent.value)) {
        put(parent.value, last, structuredClone(op.value));
        return true;
      }
      if (parentIdField) {
        const i = parent.value.findIndex((e) => isObj(e) && e[parentIdField] === last);
        if (i < 0 || !isObj(op.value) || op.value[parentIdField] !== last) return false;
        parent.value[i] = structuredClone(op.value);
        return true;
      }
      return false;
    case 'remove':
      if (!parent) return false;
      if (isObj(parent.value)) {
        if (!has(parent.value, last)) return false;
        delete parent.value[last];
        return true;
      }
      if (parentIdField) {
        const i = parent.value.findIndex((e) => isObj(e) && e[parentIdField] === last);
        if (i < 0) return false;
        parent.value.splice(i, 1);
        return true;
      }
      return false;
    case 'rename': {
      if (!parent || !isObj(parent.value) || !has(parent.value, last) || has(parent.value, op.to)) return false;
      const v = parent.value[last];
      delete parent.value[last];
      put(parent.value, op.to, v);
      return true;
    }
    case 'add': {
      const target = walk(doc, segs);
      const f = target && Array.isArray(target.value) ? idFieldOf(target.keys) : null;
      if (!f || !isObj(op.value) || !has(op.value, f) || target.value.some((e) => isObj(e) && e[f] === op.value[f])) return false;
      target.value.push(structuredClone(op.value));
      return true;
    }
    default:
      return false;
  }
}

/**
 * 照 5.2 在 before 的副本上逐个作用；返回 { result, failedAt, complete }。
 * failedAt 是第一个不可作用的操作的序号（从 1 起），没有就是 0。
 * 作用到不满足 PA1 的操作就停：它只归 PA1，它和它后面的操作不判，这时 complete 是 false。
 */
function simulate(rec) {
  const doc = structuredClone(rec.before);
  const ops = rec.patch?.ops ?? [];
  for (let i = 0; i < ops.length; i++) {
    if (shapeProblems(ops[i], '').length) return { result: doc, failedAt: 0, complete: false };
    if (!applyOp(doc, ops[i])) return { result: doc, failedAt: i + 1, complete: false };
  }
  return { result: doc, failedAt: 0, complete: true };
}

/** 5.4：对象不看键的次序，数组看次序，数按数值比 */
function equal(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isObj(a) || isObj(b)) {
    if (!isObj(a) || !isObj(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => has(b, k) && equal(a[k], b[k]));
  }
  return a === b;
}

const isPatch = (o) => o?.format === 'patch/0.1';
const isRecord = (o) => o?.format === 'patch-check/0.1';
const isFix = (schema) => schema === 'fix.schema.json';

export const checks = {
  PA1: (o) => {
    if (isPatch(o)) return opsShape(o, '补丁');
    if (isRecord(o)) return opsShape(o.patch, '核对记录的补丁');
    return [];
  },

  PA2: (o) => (isRecord(o) && o.outcome === 'rejected' && !equal(o.after, o.before)
    ? ['补丁被拒，after 和 before 却不相等'] : []),

  PA3: (o) => {
    if (!isRecord(o) || o.outcome !== 'applied') return [];
    const { result, complete } = simulate(o);
    return complete && !equal(result, o.after) ? ['补丁全部可作用并且被接受，after 和逐个作用之后的结果不相等'] : [];
  },

  PA4: (o) => {
    if (!isRecord(o)) return [];
    const { failedAt } = simulate(o);
    return failedAt && o.outcome !== 'rejected' ? [`补丁第 ${failedAt} 个操作不可作用，outcome 却是 ${o.outcome}`] : [];
  },

  PA5: (o, { schema } = {}) => {
    if (!isFix(schema)) return [];
    const { applicability, ...op } = o;
    return shapeProblems(op, '修法');
  },
};
