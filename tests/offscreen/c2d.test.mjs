// M5 T3：C 路线（86 式 / Canvas 2D + WebGPU）离屏宿主适配（engine/offscreen/c2d.mjs）。
// 验证：C 路线分片毛笔字体注册、engine/paint/canvas.js 中间层复用、宣纸水墨与朱印绘制、GPU 纸纹/暗角/颗粒后期、TEXTS 导出与逐字节确定性。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createCanvasFilm, registerCanvasFonts } from '../../engine/offscreen/c2d.mjs';
import { canvasFor, clearLayer, blit } from '../../engine/paint/canvas.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function rangeCovers(unicodeRange, codepoint) {
  for (const part of String(unicodeRange).split(',')) {
    const m = /U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?/.exec(part.trim());
    if (!m) continue;
    const lo = parseInt(m[1], 16), hi = m[2] ? parseInt(m[2], 16) : lo;
    if (codepoint >= lo && codepoint <= hi) return true;
  }
  return false;
}

test('registerCanvasFonts：按需加载 C 路线分片毛笔字体（routes/c-style/fonts/fonts.json），坏路径显式抛错', async t => {
  try { await (await import('../../engine/offscreen/canvas.mjs')).loadCanvas(); }
  catch (e) { if (String(e.code).startsWith('env.')) return t.skip(`离屏 Canvas 不可用：${e.message}`); throw e; }

  const res = await registerCanvasFonts([
    { family: 'BM Brush Offscreen Test', manifest: 'routes/c-style/fonts/fonts.json' },
  ], { baseDir: ROOT, glyphs: '晨山北冥' });
  assert.ok(res.chunksLoaded >= 1 && res.chunksLoaded <= 4, `只应按需注册命中的分片，实际注册 ${res.chunksLoaded} 片`);
  assert.ok(rangeCovers('U+4E00-9FFF', '冥'.codePointAt(0)));

  await assert.rejects(
    () => registerCanvasFonts([{ family: 'BadFont', src: 'routes/c-style/fonts/not-exist.woff2' }], { baseDir: ROOT }),
    /字体/,
  );
});

test('createCanvasFilm：C 路线水墨层（canvasFor + multiply）+ 毛笔题字 + GPU 纸纹/暗角后期确定性出帧', async t => {
  let gpu, createHost;
  try {
    gpu = await (await import('../../engine/offscreen/load.mjs')).loadGpu();
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    (await createHost({ gpu, width: 64, height: 64 })).dispose();
    await (await import('../../engine/offscreen/canvas.mjs')).loadCanvas();
  } catch (e) { if (String(e.code).startsWith('env.')) return t.skip(`离屏环境不可用：${e.message}`); throw e; }

  const W = 320, H = 180;
  const buildWork = async withPost => {
    const host = await createHost({ gpu, width: W, height: H, fps: 24 });
    const cFilm = await createCanvasFilm({
      THREE: host.THREE, TSL: host.TSL, renderer: host.renderer, pipeline: host.pipeline,
      width: W, height: H, designHeight: 1080,
      baseDir: ROOT,
      fonts: [{ family: 'BM Brush C2D', manifest: 'routes/c-style/fonts/fonts.json' }],
      glyphs: '山高水长北冥',
    });
    const work = cFilm.work({
      dur: 2, fps: 24,
      draw(ctx, t) {
        // 宣纸底色
        ctx.fillStyle = '#efe8d8';
        ctx.fillRect(0, 0, W, H);
        // engine/paint/canvas.js 的离屏墨层复用 + multiply 叠墨
        const inkLayer = canvasFor('c2d-test-ink', W, H);
        const ig = inkLayer.getContext('2d');
        clearLayer(ig);
        ig.fillStyle = '#1b1916';
        ig.beginPath();
        ig.moveTo(20, H - 20);
        ig.quadraticCurveTo(110, 35 + t * 18, 210, H - 24);
        ig.lineTo(20, H - 20);
        ig.fill();
        blit(ctx, inkLayer, 'multiply');
        // 竖排毛笔题字与朱印
        ctx.fillStyle = '#1b1916';
        ctx.font = `${Math.round(96 * cFilm.K)}px "BM Brush C2D"`;
        ctx.fillText('北冥', W - 72, 54);
        ctx.fillStyle = 'rgb(176, 46, 34)';
        ctx.fillRect(W - 68, 72, 22, 22);
      },
      texts: () => [{ id: 'title', text: '北冥', box: [W - 72, 30, 40, 32], alpha: 1 }],
      post: withPost ? (t => ({ t, paper: { strength: 0.18 }, vignette: 0.25, grain: 0.12 })) : null,
    });
    return { host, work };
  };

  const rawRun = await buildWork(false);
  const postRun = await buildWork(true);
  try {
    const f0a = await rawRun.host.renderFrame(rawRun.work, 0);
    const f0b = await rawRun.host.renderFrame(rawRun.work, 0);
    const f12 = await rawRun.host.renderFrame(rawRun.work, 12);
    const f0Post = await postRun.host.renderFrame(postRun.work, 0);

    assert.deepEqual(Buffer.from(f0a), Buffer.from(f0b), '同帧重渲必须逐字节一致');
    assert.equal(Buffer.from(f0a).equals(Buffer.from(f12)), false, '帧时间推进后山峰形态应变化');
    assert.equal(Buffer.from(f0a).equals(Buffer.from(f0Post)), false, '开启 GPU 纸纹/暗角/颗粒后期后像素应有差异');

    const boxes = rawRun.work.texts(0);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].text, '北冥');
  } finally {
    rawRun.work.dispose(); rawRun.host.dispose();
    postRun.work.dispose(); postRun.host.dispose();
  }
});
