// 声明与原生宿主对象分开：只按自有数据属性描述符取纯数据，不触发访问器，读声明抛错统一包为 usage.bad-argument。
export const bad = (message) => Object.assign(new Error(`page.det2d: ${message}`), { code: 'usage.bad-argument' });
export const requireValue = (ok, message) => { if (!ok) throw bad(message); };
const fnToStr = Function.prototype.toString;
function rootProto(proto, kind = 'Object') {
  if (proto === null) return kind === 'Object';
  const C = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value;
  return typeof C === 'function' && fnToStr.call(C) === `function ${kind}() { [native code] }` && Object.getOwnPropertyDescriptor(C, 'prototype')?.value === proto;
}
function readDeclared(fn) {
  try { return fn(); } catch (err) {
    if (err && typeof err === 'object' && err.code === 'usage.bad-argument') throw err;
    let why = '声明不可读';
    try { if (err?.message) why = String(err.message); } catch { /* 留空 */ }
    throw bad(why);
  }
}
const direct = (v) => v !== null && typeof v === 'object';
function record(v) {
  requireValue(direct(v) && !Array.isArray(v) && rootProto(Object.getPrototypeOf(v), 'Object'), '必须是直接声明的普通对象');
}
export function fields(v, allowed) {
  return readDeclared(() => {
    record(v);
    const out = Object.create(null);
    for (const k of Reflect.ownKeys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, k);
      requireValue(typeof k === 'string' && allowed.includes(k) && d && d.enumerable && Object.hasOwn(d, 'value') && d.value !== undefined, '声明含未知键、访问器或非显式字段');
      out[k] = d.value;
    }
    return out;
  });
}
export function hostField(ctx, k) {
  return readDeclared(() => {
    record(ctx);
    const d = Object.getOwnPropertyDescriptor(ctx, k);
    requireValue(d && Object.hasOwn(d, 'value'), `需要宿主的数据属性 ${k}`);
    return d.value;
  });
}
function list(v, min, max, what) {
  return readDeclared(() => {
    requireValue(direct(v) && Array.isArray(v) && rootProto(Object.getPrototypeOf(v), 'Array'), `${what} 需要数组`);
    const n = Object.getOwnPropertyDescriptor(v, 'length').value;
    requireValue(n >= min && n <= max && Reflect.ownKeys(v).length === n + 1, `${what} 长度或自有键不合法`);
    return Array.from({ length: n }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(v, i);
      requireValue(d && d.enumerable && Object.hasOwn(d, 'value'), `${what} 不收空槽或访问器`);
      return d.value;
    });
  });
}

// 文件的 SRI 口径与 engine/assets/assets.lock.json 对应条目相同；Base64 表示便于 Web Crypto 复核。
// 字符表取该份 woff2 的 Unicode cmap；不把字体查不到的字交给系统兜底。
export const FONT = Object.freeze({ id: 'locked-sans', family: 'BM Det2D', path: '/fonts/NotoSansSC-var.woff2',
  glyphs: ' %0123456789:AIkm·…中乐书分别发口吴品回复奇导已念截提有未样概止洋淞片牌眼短聘能航识距还远送醒钟镜',
  integrity: 'sha256-kX4qG2IVzR80SEQGX/jLR+Ui5FGA+DzuhdGZlpMgtaA=' });

const HOST_KEYS = ['size', 'frames', 'fps', 'shot', 'events', 'seed', 'rng', 'tracks', 'cards', 'params', 'assets', 'anchor', 'tokens', 'THREE', 'renderer'];
export function pageConfig(ctx, params = {}) {
  const host = fields(ctx, HOST_KEYS), p = fields(params, ['font']);
  requireValue(!Object.hasOwn(p, 'font') || p.font === FONT.id, '只能用已校验的本地字体别名');
  const size = list(host.size, 2, 2, 'size');
  requireValue(size.every((x) => Number.isSafeInteger(x) && x > 0), '画幅须为正整数像素');
  return Object.freeze({ size: Object.freeze(size), font: FONT, paper: '#F4F0E9', colorProfile: 'srgb', pixelRatio: 1, antialias: false });
}

/** 矩形边界和字起点都是整数像素。时间窗 [from,until) 尾部可逐帧淡出；不收 CSS、URL 或逐帧回调。 */
export function stagePlan(ctx, panels) {
  const { size: [w, h] } = pageConfig(ctx), frames = hostField(ctx, 'frames');
  requireValue(Number.isSafeInteger(frames) && frames > 0, '帧数须为正整数');
  const names = new Set();
  return list(panels, 1, 256, 'panels').map((raw) => {
    const p = fields(raw, ['name', 'rect', 'fill', 'text', 'fontPx', 'from', 'until', 'fade']);
    const { name, fill, text = '', fontPx = 32, from = 0, until = frames, fade = 0 } = p;
    requireValue(typeof name === 'string' && /^[a-z][a-z0-9_]*$/.test(name) && !names.has(name) && !Object.hasOwn(Object.prototype, name), '面板名无效或重复');
    names.add(name);
    const rect = list(p.rect, 4, 4, 'rect'), [x0, y0, x1, y1] = rect;
    requireValue(rect.every(Number.isSafeInteger) && 0 <= x0 && x0 < x1 && x1 <= w && 0 <= y0 && y0 < y1 && y1 <= h, '面板必须在画幅内且对齐整数像素');
    requireValue(typeof fill === 'string' && /^#[0-9a-f]{6}$/i.test(fill), 'fill 必须是六位显示色');
    requireValue(typeof text === 'string' && [...text].every((c) => FONT.glyphs.includes(c)), '文字超出锁定字体的覆盖');
    requireValue(Number.isSafeInteger(fontPx) && fontPx > 0 && fontPx <= 4096, '字号须为正整数像素');
    requireValue([from, until, fade].every(Number.isSafeInteger) && from >= 0 && from < until && until <= frames && fade >= 0 && fade <= until - from, '帧窗或淡出长度不合法');
    return { name, rect, fill, text, fontPx, from, until, fade };
  });
}
