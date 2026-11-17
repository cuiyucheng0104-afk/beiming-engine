// 空气透视雾 + 墨线雾淡出（engine/offscreen/tsl/fog.js、ink.js、look.js）对 GLSL 参考（engine/look/index.js）对拍：
// 覆盖指数雾、高度衰减、双色仰角渐变、天空清屏雾、截止距离 cutoff、正交相机，以及墨线在雾里的 fogFade 淡出。
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
${PAGE_B64}
const { W, H, ss, defaults, p, fogColor, ortho } = window.__ARGS;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1); renderer.setSize(W, H);
const look = createLook(renderer, W, H, { ss, msaa: 0, fps: 24, defaults, fogColor });
await look.ready;
const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: false });
const { scene, camera: persp } = inkScene(THREE, W, H);
let camera = persp;
if (ortho) {
  const h = 3.2, w = h * (W / H);
  camera = new THREE.OrthographicCamera(-w, w, h, -h, 0.1, 100);
  camera.position.copy(persp.position); camera.lookAt(0, 0, 0);
}
look.render(scene, camera, { ...p, target });
const raw = new Uint8Array(W * H * 4);
renderer.readRenderTargetPixels(target, 0, 0, W, H, raw);
const out = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) out.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
window.RESULT = { b64: b64(out) };
`;
const opaque = a => { const o = Uint8Array.from(a); for (let i = 3; i < o.length; i += 4) o[i] = 255; return o; };

test('空气透视雾与墨线 fogFade：透视 / 高度衰减 / 天空 / cutoff / 正交相机全过质量门，变异不过', { timeout: 600000 }, async t => {
  let ref, gpu, createHost;
  try {
    ({ loadGpu: gpu } = await import('../../engine/offscreen/load.mjs'));
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    gpu = await gpu();
    (await createHost({ gpu, width: 64, height: 64 })).dispose();
    ref = await startReference();
  } catch (e) { if (String(e.code).startsWith('env.')) return t.skip(`雾对拍不可用：${e.message}`); throw e; }

  const tsl = async o => {
    globalThis.__LOOK = o;
    const host = await createHost({ gpu, width: W, height: H });
    try { return await host.renderFrame(await host.load(FIXTURE), 0); } finally { host.dispose(); }
  };
  const cmp = async (glsl, tslOpts = glsl) => {
    const base = { W, H, ss: 2, defaults: DEFAULTS };
    const g = await ref.render(REF_PAGE, { ...base, ...glsl });
    const px = await tsl({ ...base, ...tslOpts });
    const d = diffRgba(opaque(px), opaque(g), { width: W, height: H });
    return { d, ok: meetsGate(d).ok, msg: `PSNR ${d.psnr} 最大差 ${d.maxDelta} 大差像素 ${d.bigPixels}` };
  };

  try {
    const cases = {
      '指数雾 + 高度衰减 + 仰角双色 + 天空': {
        fogColor: '#d8c8e0',
        p: {
          t: 0, kuwahara: false, bloom: false, grade: { exposure: 1.3 },
          outline: { width: 3.5, fogFade: 0.95 },
          fog: { color: '#e6b89c', colorHigh: '#9ab4dc', density: 0.06, start: 4, max: 0.92, baseHeight: -1.0, falloff: 3.0, sky: 0.65 },
        },
      },
      'cutoff 保留远处物体与墨线 + fallbackColor': {
        fogColor: '#ffe0c0',
        p: {
          t: 0, kuwahara: false, bloom: false, grade: { exposure: 1.2 },
          outline: { width: 3.5, fogFade: 1.0 },
          fog: { density: 0.08, start: 2, max: 0.9, cutoff: 25, sky: 0.2 },
        },
      },
      '正交相机雾 + 标量简写': {
        ortho: true, fogColor: '#c0d8e8',
        p: { t: 0, kuwahara: false, bloom: false, grade: { exposure: 1.2 }, outline: { width: 3, fogFade: 0.9 }, fog: 0.08 },
      },
    };
    for (const [name, o] of Object.entries(cases)) {
      const r = await cmp(o);
      console.log(name, r.msg);
      assert.ok(r.ok, `${name}：${r.msg}`);
      assert.ok(r.d.maxDelta <= 2, `${name}：最大差应在舍入范围内：${r.msg}`);
    }

    // 变异检查：关雾、不淡化墨线（fogFade = 0）、去掉 cutoff 都必须过不了质量门
    const base = cases['指数雾 + 高度衰减 + 仰角双色 + 天空'];
    const noFog = await cmp(base, { ...base, p: { ...base.p, fog: false } });
    assert.equal(noFog.ok, false, `关掉雾应该不过：${noFog.msg}`);

    const noInkFade = await cmp(base, { ...base, p: { ...base.p, outline: { ...base.p.outline, fogFade: 0 } } });
    assert.equal(noInkFade.ok, false, `墨线不做 fogFade 应该不过：${noInkFade.msg}`);

    const cutCase = cases['cutoff 保留远处物体与墨线 + fallbackColor'];
    const noCut = await cmp(cutCase, { ...cutCase, p: { ...cutCase.p, fog: { ...cutCase.p.fog, cutoff: 1e9 } } });
    assert.equal(noCut.ok, false, `去掉 cutoff 远处方块被雾盖住应该不过：${noCut.msg}`);
  } finally { await ref.close(); }
});
