import { types } from 'node:util';
import card from './card.json' with { type: 'json' };

const fail = (what) => { throw Object.assign(new RangeError(`layout.panels：${what}`), { code: 'usage.bad-argument' }); };
const defaults = Object.fromEntries(Object.entries(card.params).map(([name, field]) => [name, field.default]));

// 先识别 Proxy，再查原型和自有描述符。不读继承值，不运行调用方的取值器或迭代器。
function record(value, keys, name) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${name} 要是普通对象`);
  const copy = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!keys.includes(key) || !Object.hasOwn(desc, 'value')) fail(`${name} 有未知字段或取值器`);
    copy[key] = desc.value;
  }
  return copy;
}
function list(value, count, name) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== count || Reflect.ownKeys(value).length !== count + 1) fail(`${name} 要是 ${count} 项的稠密数组`);
  return Array.from({ length: count }, (_, i) => {
    const desc = Object.getOwnPropertyDescriptor(value, i);
    if (!desc || !Object.hasOwn(desc, 'value')) fail(`${name} 有空位或取值器`);
    return desc.value;
  });
}
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name} 要是 [${min}, ${max}] 内的整数`);
}
function frameSize(width, height) {
  integer(width, 1, 32768, '宽');
  integer(height, 1, 32768, '高');
  if (width * height > 2 ** 25) fail('画面超过 33554432 像素');
}
// 以本机字节序打包；写回 Uint32Array 时，内存中字节顺序仍是 R、G、B、A。
function colorWord(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) fail('颜色要写作 #RRGGBB');
  return new Uint32Array(Uint8Array.of(...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)), 255).buffer)[0];
}

// 整数余量每格至多分一像素；所有区间都左闭右开，下一格的起点和上一格的终点正好相隔 gap。
function split(length, count, margin, gap) {
  const available = length - 2 * margin - (count - 1) * gap;
  if (available < count) fail('扣掉边距和中缝后每格至少需要 1 像素');
  const whole = Math.floor(available / count), remainder = available % count;
  return Array.from({ length: count }, (_, i) => [margin + i * (whole + gap) + Math.min(i, remainder), whole + Number(i < remainder)]);
}
const rect = (x, y, w, h) => Object.freeze([x, y, w, h]);

// rgba 是不透明的二进制载荷，不把它当配置对象：只取内置槽，绝不调输入上的 length、buffer、subarray 或 species。
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const slot = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).get;
const bufferOf = slot(typed, 'buffer'), offsetOf = slot(typed, 'byteOffset'), lengthOf = slot(typed, 'byteLength');
const bufferLength = slot(ArrayBuffer.prototype, 'byteLength');
function pixelBytes(rgba, expected) {
  if (types.isProxy(rgba)) fail('不收代理字节区');
  if (types.isArrayBuffer(rgba) && bufferLength.call(rgba) === expected) return new Uint8Array(rgba);
  if ((types.isUint8Array(rgba) || types.isUint8ClampedArray(rgba)) && lengthOf.call(rgba) === expected) {
    const buffer = bufferOf.call(rgba);
    if (!types.isSharedArrayBuffer(buffer)) return new Uint8Array(buffer, offsetOf.call(rgba), expected);
  }
  fail('rgba 要是独占、尺寸相符的 8 位 RGBA 字节区');
}

export function create(ctx, params = {}) {
  const [width, height] = list(record(ctx, ['size'], 'ctx').size, 2, 'size');
  frameSize(width, height);
  const p = { ...defaults, ...record(params, Object.keys(defaults), 'params') };
  for (const [name, field] of Object.entries(card.params)) if (field.range) integer(p[name], ...field.range, name);
  if (!['vertical', 'horizontal', 'grid'].includes(p.direction)) fail('direction 要是 vertical、horizontal 或 grid');
  if (p.dividerPx > p.gap) fail('分隔线不能宽过中缝');
  const background = colorWord(p.background), line = colorWord(p.dividerColor);
  const mx = p.direction === 'vertical' ? 0 : p.margin, my = p.direction === 'horizontal' ? 0 : p.margin;
  const xs = split(width, p.direction === 'vertical' ? 1 : p.columns, mx, p.gap);
  const ys = split(height, p.direction === 'horizontal' ? 1 : p.rows, my, p.gap);
  const panels = Object.freeze(ys.flatMap(([y, h]) => xs.map(([x, w]) => rect(x, y, w, h))));
  const inset = Math.floor((p.gap - p.dividerPx) / 2);
  const dividers = Object.freeze(p.dividerPx ? [
    ...ys.slice(0, -1).map(([y, h]) => rect(mx, y + h + inset, width - 2 * mx, p.dividerPx)),
    ...xs.slice(0, -1).map(([x, w]) => rect(x + w + inset, my, p.dividerPx, height - 2 * my)),
  ] : []);
  const names = p.direction === 'vertical' ? ['panel_top', 'panel_bottom'] : ['panel_left', 'panel_right'];
  const entity = (name, id, [x, y, w, h]) => Object.freeze({ name, id, bbox2d: Object.freeze([x, y, x + w, y + h]) });
  const entities = Object.freeze([
    ...panels.map((r, i) => entity(panels.length === 2 && p.direction !== 'grid' ? names[i] : `panel_${i + 1}`, i + 1, r)),
    ...dividers.map((r, i) => entity(dividers.length === 1 ? 'divider' : `divider_${i + 1}`, panels.length + i + 1, r)),
  ]);

  function compose(sources) {
    const frames = list(sources, panels.length, 'sources').map((src, i) => {
      const { width: w, height: h, rgba } = record(src, ['width', 'height', 'rgba'], '片源');
      frameSize(w, h);
      if (w < panels[i][2] || h < panels[i][3]) fail('片源比格子小，不能一比一裁切');
      return { w, h, bytes: pixelBytes(rgba, w * h * 4) };
    });
    const out = new Uint8Array(width * height * 4), words = new Uint32Array(out.buffer);
    words.fill(background);
    panels.forEach(([x, y, w, h], i) => {
      const src = frames[i], left = Math.floor((src.w - w) / 2), top = Math.floor((src.h - h) / 2);
      for (let row = 0; row < h; row++) {
        const start = 4 * ((top + row) * src.w + left);
        out.set(src.bytes.subarray(start, start + 4 * w), 4 * ((y + row) * width + x));
      }
    });
    for (const [x, y, w, h] of dividers) for (let row = y; row < y + h; row++) words.fill(line, row * width + x, row * width + x + w);
    return out;
  }
  return { object: { panels, dividers, entities, compose }, dispose() {} };
}
