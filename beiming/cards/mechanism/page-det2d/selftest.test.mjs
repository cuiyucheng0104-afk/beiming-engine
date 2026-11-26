// 不依赖 Chromium 的单元测试。真实浏览器门由 t8-cards.test.mjs 调 evidence.mjs，单次运行覆盖两个作者模式。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromeArgs } from '../../../host/page/gpu.mjs';
import { FONT, pageConfig, stagePlan } from './config.mjs';
import { create } from './three.mjs';

const ctx = { size: [160, 90], frames: 30 }, panel = { name: 'tile', rect: [2, 2, 60, 40], fill: '#304050' };
const reject = (f) => assert.throws(f, { code: 'usage.bad-argument' });

test('公开资产锁、实际子集字节、页面策略 SRI 一致；宿主的真实启动参数锁 sRGB 与字体 hinting', async () => {
  const root = new URL('../../../../', import.meta.url), path = FONT.path.slice(1);
  const bytes = await readFile(new URL(path, root)), digest = createHash('sha256').update(bytes).digest();
  const lock = JSON.parse(await readFile(new URL('engine/assets/assets.lock.json', root), 'utf8'));
  assert.equal(lock.assets['font:noto-sans-sc@v1'].files[path], digest.toString('hex'));
  assert.equal(FONT.integrity, `sha256-${digest.toString('base64')}`);
  assert.deepEqual(chromeArgs().filter((f) => f.startsWith('--force-color-profile=') || f.startsWith('--font-render-hinting=')).sort(), ['--font-render-hinting=none', '--force-color-profile=srgb']);
  assert.equal(pageConfig(ctx).paper, '#F4F0E9');
  assert.deepEqual(pageConfig(ctx, { font: 'locked-sans' }), pageConfig(ctx));
  for (const font of [null, 'sans-serif', 'https://example.invalid/foreign.woff2', 'local(Serif)', FONT.path]) reject(() => pageConfig(ctx, { font }));
});

test('声明按值快照，只收整数矩形、登记字形、有限帧窗；拒绝外部字源、样式、动画及自定义绘制', () => {
  const original = { ...panel, rect: [...panel.rect], text: 'AI 01', from: 3, until: 29, fade: 4 };
  const [copy] = stagePlan(ctx, [original]); original.rect[0] = 4;
  assert.equal(copy.rect[0], 2); assert.equal(copy.fontPx, 32);
  for (const extra of [{ rect: [1.2, 2, 60, 40] }, { rect: [2, 2, Infinity, 40] }, { rect: [-1, 2, 60, 40] }, { until: Infinity }, { fade: 31 },
    { fill: 'red' }, { text: 'Missing glyph' }, { text: null }, { fontPx: NaN }, { from: undefined }, { until: 0 }, { css: '@keyframes x{}' },
    { draw() {} }, { name: 'constructor' }, { [Symbol()]: 1 }]) reject(() => stagePlan(ctx, [{ ...panel, ...extra }]));
  reject(() => stagePlan(ctx, [panel, panel]));
  reject(() => stagePlan({ ...ctx, frames: NaN }, [panel]));
  for (const size of [[0, 90], [Infinity, 90], [160, NaN], [1.5, 90], [160], new Uint32Array([160, 90])]) reject(() => pageConfig({ size }));
  reject(() => create(ctx, {})); // 没有对应 page 宿主与就绪字体时不返回伪 Handle
});

test('非普通对象、已撤销或抛错的 Proxy、访问器、稀疏数组和未知键逐层拒收；不执行访问器也不格式化对象', () => {
  let hits = 0;
  const trap = () => { hits++; throw Error('不应触发'); };
  const handler = Object.fromEntries(['get', 'set', 'ownKeys', 'getPrototypeOf', 'getOwnPropertyDescriptor', 'has', 'apply'].map((k) => [k, trap]));
  const pair = Proxy.revocable({}, handler); pair.revoke();
  const poison = new Proxy({}, { getPrototypeOf() { throw new Error('陷阱异常'); } });
  const unformatted = { toString: trap, valueOf: trap };
  for (const value of [new Date(), Object.create({}), pair.proxy, poison, Object.defineProperty({}, 'font', { get: trap }), { bad: 1 }]) reject(() => create(ctx, value));
  for (const host of [new Map(), pair.proxy, { size: new Uint32Array(ctx.size) }, { size: Array(2) }, { ...ctx, extra: true },
    { ...ctx, get rng() { return trap(); } }, { get size() { return trap(); } }, { ...ctx, THREE: {}, renderer: {} }]) reject(() => create(host, {}));
  for (const panels of [new Set([panel]), [], Array(1), [Object.create(panel)], [pair.proxy], [poison], [{ ...panel, rect: new Int32Array(panel.rect) }],
    [Object.defineProperty({ ...panel }, 'text', { get: trap })], [Object.defineProperty({ ...panel }, 'unknown', { get: trap })],
    [{ ...panel, rect: Object.defineProperty([...panel.rect], 1, { get: trap }) }], [{ ...panel, rect: Array(4) }],
    [{ ...panel, rect: Object.assign([...panel.rect], { invalid: true }) }], [Object.defineProperty({ ...panel }, 'draw', { value: trap })],
    [{ ...panel, text: unformatted }]]) reject(() => stagePlan(ctx, panels));
  assert.equal(hits, 0);
});
