// 卡可以独立装载和内容寻址：直接求值也校验声明，不依赖另一张卡的文件。
import card from './card.json' with { type: 'json' };

export function bad(why) { throw Object.assign(new RangeError(`${card.id}：${why}`), { code: 'usage.bad-argument' }); }
// Node 查内部槽；页面宿主在任何镜头代码执行前登记本页面的 Proxy。
const node = globalThis.process;
const isProxy = node?.versions?.node
  ? (node.getBuiltinModule?.('node:util/types') ?? await import('node:util/types')).isProxy
  : globalThis[Symbol.for('beiming.three.isProxy')];

// 先排除代理，再看自有描述符。之后只用这份纯数据，不读调用方的属性。
function data(v, depth = 0) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || Number.isFinite(v)) return v;
  if (typeof v !== 'object' || depth > 24 || !isProxy || isProxy(v)) bad('参数必须是有限、无代理的普通数据');
  const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) bad('不是普通对象或数组');
  const keys = Reflect.ownKeys(v), out = array ? [] : Object.create(null);
  if (array && keys.length !== v.length + 1) bad('数组不能有空槽或额外属性');
  for (const k of keys) {
    if (array && k === 'length') continue;
    if (typeof k !== 'string' || (array && (!/^(0|[1-9]\d*)$/.test(k) || +k >= v.length))) bad('键必须是字段名或数组下标');
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!Object.hasOwn(d, 'value') || !d.enumerable) bad('属性必须是可枚举的数据属性');
    out[k] = data(d.value, depth + 1);
  }
  return out;
}

export function fields(obj, allowed) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).some((k) => !allowed.includes(k))) bad(`只认字段 ${allowed.join('、')}`);
}
export function vector(v) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) bad('坐标必须是三个有限数');
  return v;
}
export function argumentsOf(inputs, params, f, sub) {
  // f 允许相邻采样帧（例如 Blender 在片首读 −1），sub 是镜头契约中的 [0,1)。
  if (!Number.isSafeInteger(f) || !Number.isFinite(sub) || sub < 0 || sub >= 1) bad('帧号或子帧超界');
  fields(data(inputs), ['size', 'fps', 'seed', 'shot', 'events', 'bbox']);
  const p = data(params);
  fields(p, Object.keys(card.params));
  for (const [k, spec] of Object.entries(card.params)) {
    if (!Object.hasOwn(p, k)) p[k] = spec.default;
    const n = p[k];
    if (spec.range && (!Number.isFinite(n) || n < spec.range[0] || n > spec.range[1] || (spec.type === 'integer' && !Number.isSafeInteger(n)))) bad(`${k} 超出范围`);
  }
  return p;
}
