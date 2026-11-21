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

test('空显示层跳过全幅读取与上传，唯一 1 像素绘制帧不漏画，连续空帧不再清画布', { timeout: 120000 }, async t => {
  let gpu, createHost;
  try {
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    gpu = await (await import('../../engine/offscreen/load.mjs')).loadGpu();
    await (await import('../../engine/offscreen/canvas.mjs')).loadCanvas();
    (await createHost({ gpu, width: 64, height: 64 })).dispose();
  } catch (e) { if (String(e.code).startsWith('env.')) return t.skip(`离屏出片不可用：${e.message}`); throw e; }
  const W = 64, H = 36, host = await createHost({ gpu, width: W, height: H, fps: 24 });
  try {
    const fixture = fileURLToPath(new URL('./fixtures/film-overlay-empty.mjs', import.meta.url));
    const work = await host.load(fixture);
    const at0 = async f => Array.from((await host.renderFrame(work, f)).slice(0, 4));
    assert.deepEqual(await at0(0), [255, 0, 0, 255]);
    assert.deepEqual(await at0(1), [255, 255, 255, 255], '1 像素 fillRect 必须被探针计为绘制并上传');
    assert.deepEqual(await at0(2), [255, 0, 0, 255], '非空帧之后要清空并上传一次空白');
    assert.deepEqual(await at0(3), [255, 0, 0, 255]);
    assert.deepEqual(globalThis.__OVERLAY_STATS, { reads: 2, clears: 1, pipelines: 1 }, '只允许初始空白与唯一绘制帧读全幅；空帧复用同一条合成管线，不重复建后期资源');
  } finally {
    delete globalThis.__OVERLAY_STATS;
    host.dispose();
  }
});

test('draw 画了内容又返回 false：本帧不叠图，下一帧先清画布，不残留', { timeout: 120000 }, async t => {
  let gpu, createHost;
  try {
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    gpu = await (await import('../../engine/offscreen/load.mjs')).loadGpu();
    await (await import('../../engine/offscreen/canvas.mjs')).loadCanvas();
    (await createHost({ gpu, width: 64, height: 64 })).dispose();
  } catch (e) { if (String(e.code).startsWith('env.')) return t.skip(`离屏出片不可用：${e.message}`); throw e; }
  const W = 64, H = 36, host = await createHost({ gpu, width: W, height: H, fps: 24 });
  try {
    const work = await host.load(fileURLToPath(new URL('./fixtures/film-overlay-false.mjs', import.meta.url)));
    const px = async f => { const p = await host.renderFrame(work, f); return x => Array.from(p.slice(x * 4, x * 4 + 3)); };
    assert.deepEqual((await px(0))(0), [255, 0, 0]);
    assert.deepEqual((await px(1))(0), [255, 0, 0], '返回 false 的帧不叠图');
    const f2 = await px(2);
    assert.deepEqual(f2(0), [255, 0, 0], '上一帧画了又返回 false，画布必须先清掉，不能残留白点');
    assert.deepEqual(f2(5), [0, 255, 0]);
  } finally { host.dispose(); }
});
