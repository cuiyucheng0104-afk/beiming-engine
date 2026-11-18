// M5 T1：离屏纸纹进阶（scaleMode 'refHeight' 面积取样、paperAnchor 锚点跟移、canvasPaper 每帧贴图）与后期 debug 八种视图对 GLSL 参考对拍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diffRgba, meetsGate } from '../../engine/offscreen/diff.mjs';
import { startReference, PAGE_B64 } from './glsl-reference.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = `${ROOT}tests/offscreen/fixtures/look-work.mjs`;
const W = 320, H = 180;
const DEFAULTS = JSON.parse(readFileSync(`${ROOT}engine/style/beiming-original.v1.json`, 'utf8')).lookDefaults.params;

const REF_PAGE = `
import * as THREE from 'three';
import { createLook } from '/engine/look/index.js';
import { inkScene } from '/tests/offscreen/fixtures/ink-scene.mjs';
import { paperTile } from '/tests/offscreen/fixtures/look-paper.mjs';
${PAGE_B64}
const { W, H, ss, refHeight, defaults, p, imagePaper, perFrameTile } = window.__ARGS;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1); renderer.setSize(W, H);
const look = createLook(renderer, W, H, { ss, msaa: 0, refHeight: refHeight ?? 1080, fps: 24, defaults });
await look.ready;
const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: false });
const { scene, camera } = inkScene(THREE, W, H);
const pp = { ...p, target };
if (imagePaper || perFrameTile) {
  const { px, size, mid } = paperTile();
  const flipped = new Uint8Array(px.length);
  for (let y = 0; y < size; y++) flipped.set(px.subarray(y * size * 4, (y + 1) * size * 4), (size - 1 - y) * size * 4);
  const tex = new THREE.DataTexture(flipped, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
  pp.paper = { ...(p.paper || {}), tex, mid };
}
look.render(scene, camera, pp);
const raw = new Uint8Array(W * H * 4);
renderer.readRenderTargetPixels(target, 0, 0, W, H, raw);
const out = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) out.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
window.RESULT = { b64: b64(out) };
`;

const opaque = a => { const o = Uint8Array.from(a); for (let i = 3; i < o.length; i += 4) o[i] = 255; return o; };

test('纸纹进阶对拍：anchor 跟移、scaleMode refHeight 面积取样、二者叠加、per-frame 贴图；变异不过门', { timeout: 600000 }, async t => {
  let ref, gpu, createHost, paperAnchor, canvasPaper, loadCanvas;
  try {
    ({ loadGpu: gpu } = await import('../../engine/offscreen/load.mjs'));
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    ({ paperAnchor, canvasPaper } = await import('../../engine/offscreen/tsl/paper.js'));
    ({ loadCanvas } = await import('../../engine/offscreen/canvas.mjs'));
    gpu = await gpu();
    (await createHost({ gpu, width: 64, height: 64 })).dispose();
    ref = await startReference();
  } catch (e) { if (String(e.code).startsWith('env.')) return t.skip(`对拍环境不可用：${e.message}`); throw e; }

  try {
    // 1) paperAnchor 与 canvasPaper 契约与错误校验
    const anch = paperAnchor({ x: 184.5, y: 76.25, s: 1.35 }, { x: 160, y: 90, s: 1.0 });
    assert.deepEqual(anch, { pos: [184.5, 76.25], origin: [160, 90], zoom: 1.35 });
    assert.throws(() => paperAnchor({ x: 0, y: 0, s: 0 }, { x: 0, y: 0, s: 1 }), TypeError);

    const { createCanvas } = await loadCanvas();
    const cv = createCanvas(64, 64);
    const g2d = cv.getContext('2d');
    g2d.fillStyle = '#808080'; g2d.fillRect(0, 0, 64, 64);
    g2d.fillStyle = '#a0a0a0'; g2d.fillRect(0, 0, 32, 32);
    const cp = canvasPaper(gpu.THREE, cv, { strength: 0.16 });
    assert.equal(cp.strength, 0.16);
    assert.ok(cp.mid > 0.5 && cp.mid < 0.6, `canvasPaper 均值应在 0.5..0.6，收到 ${cp.mid}`);
    cp.tex.dispose();

    const runTsl = async o => {
      globalThis.__LOOK = o;
      const host = await createHost({ gpu, width: W, height: H });
      try { return await host.renderFrame(await host.load(FIXTURE), 0); } finally { host.dispose(); }
    };
    const cmp = async (glsl, tslOpts = glsl) => {
      const base = { W, H, ss: 2, refHeight: 90, defaults: DEFAULTS };
      const g = await ref.render(REF_PAGE, { ...base, ...glsl });
      const px = await runTsl({ ...base, ...tslOpts });
      const d = diffRgba(opaque(px), opaque(g), { width: W, height: H });
      return { d, ok: meetsGate(d).ok, msg: `PSNR ${d.psnr} 最大差 ${d.maxDelta} 大差像素 ${d.bigPixels}` };
    };

    const cases = {
      '纸纹 anchor 跟移': {
        refHeight: 180,
        imagePaper: true,
        p: { t: 0, grade: { exposure: 1.5 }, paper: { strength: 0.28, scale: 1.0, anchor: anch } },
      },
      '纸纹 scaleMode refHeight（非整数倍 k = 180/110）': {
        refHeight: 110,
        imagePaper: true,
        p: { t: 0, grade: { exposure: 1.5 }, paper: { strength: 0.28, scale: 1.25, scaleMode: 'refHeight' } },
      },
      '纸纹 anchor + scaleMode refHeight 叠加': {
        refHeight: 115,
        imagePaper: true,
        p: { t: 0, grade: { exposure: 1.5 }, paper: { strength: 0.28, scale: 1.1, scaleMode: 'refHeight', anchor: anch } },
      },
      '每帧 p.paper.tex 覆盖': {
        refHeight: 180,
        perFrameTile: true,
        p: { t: 0, grade: { exposure: 1.5 }, paper: { strength: 0.26, scale: 1.5 } },
      },
    };
    for (const [name, o] of Object.entries(cases)) {
      const r = await cmp(o);
      assert.ok(r.ok, `${name}：${r.msg}`);
      assert.ok(r.d.maxDelta <= 2, `${name} 最大差应在舍入范围内：${r.msg}`);
    }

    // 变异检查：去掉 anchor 或把 refHeight 退回 pixel 模式必须不过门
    const baseA = cases['纸纹 anchor 跟移'];
    const mutNoAnchor = await cmp(baseA, { ...baseA, p: { ...baseA.p, paper: { strength: 0.28, scale: 1.0 } } });
    assert.equal(mutNoAnchor.ok, false, `去掉 anchor 应不过门：${mutNoAnchor.msg}`);

    const baseR = cases['纸纹 scaleMode refHeight（非整数倍 k = 180/110）'];
    const mutPixel = await cmp(baseR, { ...baseR, p: { ...baseR.p, paper: { strength: 0.28, scale: 1.25, scaleMode: 'pixel' } } });
    assert.equal(mutPixel.ok, false, `refHeight 退回 pixel 应不过门：${mutPixel.msg}`);
  } finally {
    await ref.close();
  }
});

test('debug 八种视图对拍：id / depth / edge / line / bloom / paper / kuwahara / scene 与 GLSL 参考一致', { timeout: 600000 }, async t => {
  let ref, gpu, createHost, DEBUG_VIEWS;
  try {
    ({ loadGpu: gpu } = await import('../../engine/offscreen/load.mjs'));
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    ({ DEBUG_VIEWS } = await import('../../engine/offscreen/tsl/debug.js'));
    gpu = await gpu();
    (await createHost({ gpu, width: 64, height: 64 })).dispose();
    ref = await startReference();
  } catch (e) { if (String(e.code).startsWith('env.')) return t.skip(`对拍环境不可用：${e.message}`); throw e; }

  assert.deepEqual(DEBUG_VIEWS, ['id', 'depth', 'edge', 'line', 'bloom', 'paper', 'kuwahara', 'scene']);

  const runTsl = async o => {
    globalThis.__LOOK = o;
    const host = await createHost({ gpu, width: W, height: H });
    try { return await host.renderFrame(await host.load(FIXTURE), 0); } finally { host.dispose(); }
  };

  try {
    // ss = 1 时不存在 2× 超采样 NearestFilter 半格边界的插值舍入歧义，全部 8 种视图均逐像素严格过 M1 质量门（maxDelta <= 1）
    for (const mode of DEBUG_VIEWS) {
      const args = { W, H, ss: 1, refHeight: 1080, defaults: DEFAULTS, p: { t: 0, grade: { exposure: 1.6 }, bloom: { strength: 0.8, threshold: 0.4, radius: 0.6 }, debug: mode } };
      const g = await ref.render(REF_PAGE, args);
      const px = await runTsl(args);
      const d = diffRgba(opaque(px), opaque(g), { width: W, height: H });
      const gate = meetsGate(d);
      assert.ok(gate.ok && d.maxDelta <= 1, `debug=${mode}（ss=1）：PSNR ${d.psnr} 最大差 ${d.maxDelta} 大差像素 ${d.bigPixels}`);
    }
    // 变异：错拿 kuwahara 对 line 必须不过门
    const lineRef = await ref.render(REF_PAGE, { W, H, ss: 1, refHeight: 1080, defaults: DEFAULTS, p: { t: 0, debug: 'line' } });
    const kuwaTsl = await runTsl({ W, H, ss: 1, refHeight: 1080, defaults: DEFAULTS, p: { t: 0, debug: 'kuwahara' } });
    assert.equal(meetsGate(diffRgba(opaque(kuwaTsl), opaque(lineRef), { width: W, height: H })).ok, false, 'debug 视图错位应不过门');
  } finally {
    await ref.close();
  }
});
