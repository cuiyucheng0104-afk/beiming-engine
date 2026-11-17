// 离屏影片外壳（engine/offscreen/film.mjs）：按 film.json v2 的镜头表切镜（局部帧号从 0 起）、显示层按 sRGB 数值盖在后期结果上、文字条目规范化。
// 缺可选依赖或拿不到 GPU 适配器时跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('./fixtures/film-work.mjs', import.meta.url));

test('切镜、局部帧号、显示层合成、TEXTS 规范化', { timeout: 120000 }, async t => {
  let gpu, createHost;
  try {
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    gpu = await (await import('../../engine/offscreen/load.mjs')).loadGpu();
    await (await import('../../engine/offscreen/canvas.mjs')).loadCanvas();
    (await createHost({ gpu, width: 64, height: 64 })).dispose();
  } catch (e) { if (String(e.code).startsWith('env.')) return t.skip(`离屏出片不可用：${e.message}`); throw e; }
  const W = 64, H = 36, host = await createHost({ gpu, width: W, height: H, fps: 24 });
  try {
    const work = await host.load(FIXTURE);
    const at = (px, x, y) => Array.from(px.slice((y * W + x) * 4, (y * W + x) * 4 + 3));
    const f5 = await host.renderFrame(work, 5), f6 = await host.renderFrame(work, 6), f11 = await host.renderFrame(work, 11);
    assert.deepEqual(at(f5, 48, 30), [255, 0, 0]);   // S1 背景
    assert.deepEqual(at(f6, 48, 30), [0, 0, 255]);   // 第 6 帧切到 S2
    // 左上角：白 0.5 按 sRGB 数值盖上去（红 255 → 255，绿蓝 0 → 128 左右）
    const ov = at(f5, 4, 4);
    assert.ok(ov[0] === 255 && Math.abs(ov[1] - 128) <= 1 && Math.abs(ov[2] - 128) <= 1, `显示层合成：${ov}`);
    assert.deepEqual(globalThis.__FILM_SEEN, [['S1', 5, 5], ['S2', 6, 0], ['S2', 11, 5]]);
    assert.deepEqual(work.texts(0)[0].x1, 10);   // normalizeTexts 补了 x0..y1、alpha
    assert.equal(work.texts(0)[0].alpha, 1);
    assert.deepEqual(at(f11, 48, 30), [0, 0, 255]);
  } finally { host.dispose(); }
});
