import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from './comp.mjs';

const layout = (size, params) => create({ size }, params).object;
const source = (width, height, ink) => ({ width, height, rgba: new Uint8Array(width * height * 4).fill(ink) });
const pixel = (out, w, x, y) => [...out.slice(4 * (y * w + x), 4 * (y * w + x + 1))];
const bad = { code: 'usage.bad-argument' };

test('29-1：两格、分隔线十二条边和颜色逐像素精确，填底不侵入面板', () => {
  const c = layout([1080, 1350], { margin: 44, gap: 46, dividerPx: 4 });
  assert.deepEqual(c.panels, [[0, 44, 1080, 608], [0, 698, 1080, 608]]);
  assert.deepEqual(c.dividers, [[0, 673, 1080, 4]]);
  assert.deepEqual(c.entities.map((e) => [e.name, e.bbox2d]), [
    ['panel_top', [0, 44, 1080, 652]], ['panel_bottom', [0, 698, 1080, 1306]], ['divider', [0, 673, 1080, 677]],
  ]);
  const rgba = c.compose([source(1080, 608, 123), source(1080, 608, 231)]);
  const bg = [9, 9, 6, 255], divider = [203, 251, 3, 255];
  for (let y = 0; y < 1350; y++) {
    const want = y >= 44 && y < 652 ? [123, 123, 123, 123] : y >= 673 && y < 677 ? divider : y >= 698 && y < 1306 ? [231, 231, 231, 231] : bg;
    const row = rgba.subarray(y * 1080 * 4, (y + 1) * 1080 * 4);
    assert.ok(row.every((v, i) => v === want[i % 4]), `第 ${y} 行偏色或边界不通栏`);
  }
});

test('网格从左上分余数；分隔线画在内部中缝，奇偶不匹配时向左上取整', () => {
  const c = layout([20, 16], { direction: 'grid', rows: 2, columns: 3, margin: 1, gap: 4, dividerPx: 1 });
  assert.deepEqual(c.panels, [[1, 1, 4, 5], [9, 1, 3, 5], [16, 1, 3, 5], [1, 10, 4, 5], [9, 10, 3, 5], [16, 10, 3, 5]]);
  assert.deepEqual(c.dividers, [[1, 7, 18, 1], [6, 1, 1, 14], [13, 1, 1, 14]]);
  const out = c.compose(c.panels.map(([, , w, h], i) => source(w, h, 120 + i)));
  assert.deepEqual(pixel(out, 20, 6, 7), [203, 251, 3, 255]); // 两条线相交
  assert.deepEqual(pixel(out, 20, 6, 15), [9, 9, 6, 255]); // 线止于边距之前
  assert.deepEqual(pixel(out, 20, 16, 10), [125, 125, 125, 125]); // 逐行排列的第六格
});

test('左右分屏不缩放：按字节偏移居中裁切，保留直通透明度，不改源帧，不共用输出', () => {
  const c = layout([7, 2], { direction: 'horizontal', margin: 1, gap: 1, dividerPx: 0 });
  assert.deepEqual(c.panels, [[1, 0, 2, 2], [4, 0, 2, 2]]);
  assert.deepEqual(c.dividers, []);
  const bytes = new Uint8ClampedArray(4 * 4 * 4 + 2).subarray(1, -1);
  bytes.set(Array.from(bytes, (_, i) => i));
  const first = { width: 4, height: 4, rgba: bytes }, second = source(2, 2, 203);
  const out = c.compose([first, { ...second, rgba: second.rgba.buffer }]);
  assert.deepEqual(pixel(out, 7, 1, 0), [20, 21, 22, 23]);
  assert.deepEqual(pixel(out, 7, 2, 1), [40, 41, 42, 43]);
  assert.deepEqual(pixel(out, 7, 4, 1), [203, 203, 203, 203]);
  assert.deepEqual(pixel(out, 7, 3, 1), [9, 9, 6, 255]);
  out.fill(0);
  assert.deepEqual(pixel(c.compose([first, second]), 7, 2, 1), [40, 41, 42, 43]);
  assert.equal(bytes[40], 40);
});

test('共享合成上下文可直接创建分屏，忽略的宿主字段不执行', () => {
  const ctx = Object.assign(Object.create(null), {
    size: [4, 4], fps: '30/1', shot: { id: 'split', in: 0, frames: 8 }, seed: 1, frames: 8,
    rng() { assert.fail('排版不应取随机数'); }, events: [], tokens: {}, params: {}, assets: {}, tracks: {}, cards: {},
  });
  const { object } = create(Object.freeze(ctx), {});
  assert.deepEqual(object.panels, [[0, 0, 4, 2], [0, 2, 4, 2]]);
  const frames = [source(4, 2, 50), source(4, 2, 100)];
  assert.deepEqual(object.compose(frames), layout(ctx.size, {}).compose(frames));
});

test('分屏配置和片源只接受可枚举字段与数组元素', () => {
  const hidden = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: false });
  assert.throws(() => create(hidden({}, 'size', [4, 4]), {}), bad);
  assert.throws(() => layout([4, 4], hidden({}, 'gap', 0)), bad);
  assert.throws(() => layout(hidden([4, 4], 0, 4), {}), bad);
  const c = layout([4, 4], {}), frame = source(4, 2, 10);
  assert.throws(() => c.compose([hidden({ ...frame }, 'rgba', frame.rgba), frame]), bad);
  assert.throws(() => c.compose(hidden([frame, frame], 1, frame)), bad);
});

test('网格的零边距在两个方向都输出正零坐标', () => {
  const c = layout([6, 6], { direction: 'grid', margin: -0, gap: 2, dividerPx: 2 });
  assert.deepEqual(c.dividers, [[0, 2, 6, 2], [2, 0, 2, 6]]);
});

test('拒绝无效尺寸、超宽线、空格子、错误的片源与颜色；不运行输入代码', () => {
  let hits = 0;
  const trap = () => { hits++; throw new Error('输入运行了代码'); };
  const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  const c = layout([2, 2], {}), frame = source(2, 1, 120);
  const sparse = (first) => { const a = [first]; a.length = 2; return a; };
  for (const call of [
    () => create(proxy, {}), () => create({ get size() { return trap(); } }, {}), () => layout(proxy, {}),
    () => create({ size: [2, 2], get rng() { return trap(); } }, {}), () => create({ size: [2, 2], assets: proxy }, {}),
    () => create(Object.create({ size: [2, 2] }), {}), () => create({}, {}),
    () => layout(sparse(2), {}), () => layout([2, NaN], {}), () => layout([32768, 32768], {}),
    () => layout([2, 2], proxy), () => layout([2, 2], { get gap() { return trap(); } }),
    () => layout([2, 2], { unknown: 1 }), () => layout([2, 2], { direction: proxy }),
    () => layout([2, 2], { dividerColor: proxy }), () => layout([2, 2], { gap: NaN }),
    () => layout([2, 2], { gap: 0, dividerPx: 1 }), () => layout([2, 2], { rows: 3 }),
    () => c.compose(proxy), () => c.compose(sparse(frame)), () => c.compose([frame, proxy]),
    () => c.compose([frame, { ...frame, get rgba() { return trap(); } }]),
    () => c.compose([frame, { ...frame, rgba: proxy }]), () => c.compose([frame, { ...frame, spare: 1 }]),
    () => c.compose([frame, source(1, 1, 0)]), () => c.compose([frame, { ...frame, rgba: new Uint8Array(1) }]),
    () => c.compose([frame, { ...frame, rgba: new Float32Array(2) }]),
  ]) assert.throws(call, bad);
  // 二进制载荷按内置槽读，不调用这张字节视图自己覆盖的属性或方法。
  const bytes = new Uint8Array(8).fill(53);
  for (const key of ['length', 'byteLength', 'byteOffset', 'buffer', 'subarray', 'constructor']) Object.defineProperty(bytes, key, { get: trap });
  assert.deepEqual(pixel(c.compose([{ ...frame, rgba: bytes }, frame]), 2, 0, 0), [53, 53, 53, 53]);
  assert.equal(hits, 0);
});
