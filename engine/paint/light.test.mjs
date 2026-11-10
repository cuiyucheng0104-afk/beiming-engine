// engine/paint 在浏览器里的回归测试：fadeAlong 在带缩放的画布上的位置（R45）、clearLayer / fadeAlong 收两种矩阵（R50）、
// glassSheen 与墨线不改调用方状态（R51）、rimPass 的 spread 侧光带（R59 注释写的行为）。
// 用法：node --test engine/paint/light.test.mjs（需要 playwright-core 的无头 Chrome；起不来就跳过。BEIMING_CHROME 可指定浏览器）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.woff2': 'font/woff2', '.html': 'text/html' };

let browser = null, page = null, skip = false;
test.before(async () => {
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: process.env.BEIMING_CHROME || undefined, args: ['--force-color-profile=srgb'] });
  } catch (e) { skip = `启动不了无头 Chrome：${String(e.message).split('\n')[0]}`; return; }
  page = await browser.newPage();
  await page.route('http://bm.test/**', route => {
    const p = decodeURIComponent(new URL(route.request().url()).pathname);
    if (p === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body></body>' });
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
  });
  await page.goto('http://bm.test/');
});
test.after(async () => { if (browser) await browser.close(); });
const run = (t, fn, arg) => (skip ? t.skip(skip) : page.evaluate(fn, arg));

test('fadeAlong：原生 4K（画布变换 scale(2)）时渐隐遮罩的位置与 1080p 等比一致（R45）', async t => {
  const r = await run(t, async () => {
    const { rimPass, fadeAlong } = await import('/engine/paint/light.js');
    const band = K => {
      const c = document.createElement('canvas'); c.width = 200 * K; c.height = 200 * K;
      const g = c.getContext('2d'); g.setTransform(K, 0, 0, K, 0, 0);
      const shape = new Path2D(); shape.rect(20, 20, 100, 100);
      // 光从右边来：右沿一条 10 宽的光带；遮罩在用户坐标 y = 50（全留）→ 70（全隐）
      rimPass(g, shape, [1, 0], 10, '#ff0000', { mask: fadeAlong([1, 0, 0, 1, 0, 0], [0, 50], [0, 70]) });
      const d = g.getImageData(0, 0, c.width, c.height).data;
      return y => d[((y * K + (K >> 1)) * c.width + 115 * K) * 4 + 3];   // 用户坐标 (115, y) 处的 alpha
    };
    const a1 = band(1), a2 = band(2), ys = [25, 30, 40, 48, 55, 60, 65, 72, 90, 110];
    return ys.map(y => [y, a1(y), a2(y)]);
  });
  if (!r) return;
  for (const [y, k1, k2] of r) assert.ok(Math.abs(k1 - k2) <= 12, `用户 y=${y}：K=1 alpha ${k1}，K=2 alpha ${k2}`);
  assert.equal(r.find(v => v[0] === 40)[2], 255, 'K=2 时 y=40（遮罩之上）应全留');
  assert.equal(r.find(v => v[0] === 90)[2], 0, 'K=2 时 y=90（遮罩之下）应全隐');
});

test('clearLayer 收 affine.js 数组与类型化数组；fadeAlong 收 DOMMatrix（R50）', async t => {
  const r = await run(t, async () => {
    const { clearLayer } = await import('/engine/paint/canvas.js');
    const { fadeAlong } = await import('/engine/paint/light.js');
    const { zoomAt } = await import('/engine/paint/affine.js');
    const g = document.createElement('canvas').getContext('2d');
    const m = t => { const x = t.getTransform(); return [x.a, x.b, x.c, x.d, x.e, x.f]; };
    clearLayer(g, zoomAt(32, 32, 2)); const arr = m(g);
    clearLayer(g, new Float64Array([3, 0, 0, 3, 5, 5])); const typed = m(g);
    clearLayer(g, new DOMMatrix([1, 0, 0, 1, 7, 9])); const dom = m(g);
    clearLayer(g); const none = m(g);
    // fadeAlong(DOMMatrix) 与 fadeAlong(数组) 画出一样的遮罩
    const paint = mm => { const c = document.createElement('canvas'); c.width = c.height = 64; const a = c.getContext('2d');
      a.fillStyle = '#fff'; a.fillRect(0, 0, 64, 64); a.globalCompositeOperation = 'destination-in'; fadeAlong(mm, [0, 10], [0, 50])(a);
      return Array.from(a.getImageData(0, 0, 64, 64).data.filter((_, i) => i % 4 === 3)); };
    let err = null, same = false;
    try { same = JSON.stringify(paint(new DOMMatrix([1, 0, 0, 1, 0, 4]))) === JSON.stringify(paint([1, 0, 0, 1, 0, 4])); } catch (e) { err = e.message; }
    return { arr, typed, dom, none, err, same };
  });
  if (!r) return;
  assert.deepEqual(r.arr, [2, 0, 0, 2, -32, -32]);
  assert.deepEqual(r.typed, [3, 0, 0, 3, 5, 5]);
  assert.deepEqual(r.dom, [1, 0, 0, 1, 7, 9]);
  assert.deepEqual(r.none, [1, 0, 0, 1, 0, 0]);
  assert.equal(r.err, null);
  assert.ok(r.same);
});

test('glassSheen 调用前后 g 的状态不变（R51）', async t => {
  const r = await run(t, async () => {
    const { glassSheen } = await import('/engine/paint/light.js');
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    g.filter = 'contrast(1.2)'; g.globalAlpha = 0.8; g.lineWidth = 1; g.fillStyle = '#123456'; g.strokeStyle = '#654321';
    const st = () => [g.filter, g.globalAlpha, g.lineWidth, String(g.fillStyle), String(g.strokeStyle)];
    const before = st();
    const glass = new Path2D(); glass.ellipse(32, 32, 20, 14, 0, 0, Math.PI * 2);
    glassSheen(g, glass, [10, 10], [50, 50], { edge: 0.3, edgeColor: '#ffe9f0', width: 3, blur: 1.5, streak: 0.25, tint: [255, 246, 250] });
    return { before, after: st() };
  });
  if (!r) return;
  assert.deepEqual(r.after, r.before);
});

test('墨线：透明度乘在调用方的 globalAlpha 上，画完还原 globalAlpha 与 fillStyle（R51）', async t => {
  const r = await run(t, async () => {
    const { createInk } = await import('/engine/paint/ink.js');
    const { createNoise2D } = await import('/engine/core/noise.js');
    const { mulberry } = await import('/engine/core/math.js');
    const brush = createInk(createNoise2D(mulberry(7)));
    const poly = Array.from({ length: 40 }, (_, i) => [10 + i * 2, 32]);
    const draw = (alpha0, o) => {
      const c = document.createElement('canvas'); c.width = c.height = 100; const g = c.getContext('2d');
      g.globalAlpha = alpha0; g.fillStyle = '#00ff00';
      brush.line(g, poly, { px: v => v * 2, size: 3, jit: 0, color: '#000', seed: 1, ...o });
      const a = Math.max(...g.getImageData(0, 0, 100, 100).data.filter((_, i) => i % 4 === 3));
      return { a, alpha: g.globalAlpha, fill: String(g.fillStyle) };
    };
    return { one: draw(1, {}), half: draw(0.5, {}), halfA: draw(0.5, { alpha: 0.8 }) };
  });
  if (!r) return;
  assert.equal(r.one.a, 255);
  assert.ok(Math.abs(r.half.a - 128) <= 2, `调用方 0.5、墨线不设 alpha：线心 alpha ${r.half.a}，应约 128`);
  assert.ok(Math.abs(r.halfA.a - 102) <= 2, `调用方 0.5 × 墨线 0.8：线心 alpha ${r.halfA.a}，应约 102`);
  for (const k of ['one', 'half', 'halfA']) assert.equal(r[k].fill, '#00ff00', `${k}：fillStyle 没还原`);
  assert.equal(r.half.alpha, 0.5); assert.equal(r.halfA.alpha, 0.5); assert.equal(r.one.alpha, 1);
});

test('rimPass 的 spread：两道侧光带强度与主光带相同、宽 0.75·d（R59 注释描述的行为）', async t => {
  const r = await run(t, async () => {
    const { rimPass } = await import('/engine/paint/light.js');
    const c = document.createElement('canvas'); c.width = 200; c.height = 100; const g = c.getContext('2d');
    const shape = new Path2D(); shape.rect(40, 20, 100, 60);
    rimPass(g, shape, [1, 0], 20, '#ff0000', { spread: 30 });
    const d = g.getImageData(0, 0, 200, 100).data, A = (x, y) => d[(y * 200 + x) * 4 + 3];
    let top = 0; for (let y = 20; y < 50; y++) if (A(90, y) > 127) top++;      // 矩形中部（主光带之外）只剩侧光带
    return { topRows: top, topCore: A(90, 21), main: A(135, 50) };
  });
  if (!r) return;
  assert.equal(r.main, 255);
  assert.equal(r.topCore, 255, '侧光带强度应与主光带相同（不是 0.75）');
  assert.ok(Math.abs(r.topRows - 0.75 * 20 * Math.sin(Math.PI / 6)) <= 1.5, `侧光带厚 ${r.topRows} px，应约 7.5（0.75·d·sin30°）`);
});
