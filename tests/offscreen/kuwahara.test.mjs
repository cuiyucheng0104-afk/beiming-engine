// TSL Kuwahara（engine/offscreen/tsl/kuwahara.js）对 GLSL 参考（engine/look/kuwahara.js，在无头 Chrome 的 WebGL 里跑）：
// 同一张合成输入、同一组参数，过 M1 的质量门（PSNR ≥ 50 dB、差 5 级以上的像素 ≤ 0.1%）。缺可选依赖、拿不到 GPU 适配器或没有无头浏览器时跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { kuwahara } from '../../engine/offscreen/tsl/kuwahara.js';
import { diffRgba, meetsGate } from '../../engine/offscreen/diff.mjs';
import { startReference, PAGE_B64 } from './glsl-reference.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = `${ROOT}tests/offscreen/fixtures/kuwahara-work.mjs`;
const W = 320, H = 180;

const REF_PAGE = `
import * as THREE from 'three';
import { createFullscreen } from '/engine/look/pass.js';
import { createKuwahara } from '/engine/look/kuwahara.js';
import { kuwaharaInput } from '/tests/offscreen/fixtures/kuwahara-input.mjs';
${PAGE_B64}
const { W, H, radius, q, strength } = window.__ARGS;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1); renderer.setSize(W, H);
const tex = new THREE.DataTexture(kuwaharaInput(W, H), W, H, THREE.RGBAFormat);
tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
const depth = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat); depth.needsUpdate = true;
const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
const fx = createFullscreen(renderer), kw = createKuwahara(fx);
kw.render({ src: tex, depth, camera: new THREE.PerspectiveCamera(35, W / H, .1, 100), p: { radius, q, strength }, k: 1, w: W, h: H }, target);
const out = new Uint8Array(W * H * 4);
renderer.readRenderTargetPixels(target, 0, 0, W, H, out);
window.RESULT = { b64: b64(out) };
`;
const opaque = a => { const o = Uint8Array.from(a); for (let i = 3; i < o.length; i += 4) o[i] = 255; return o; };

test('KR 越界：抛 RangeError（不静默夹到范围内）', () => {
  for (const KR of [1, 11, 2.5, NaN]) assert.throws(() => kuwahara({}, { KR }), RangeError);
});

test('TSL 对 GLSL：半径 2、4、8（强度 0.7）都过质量门；故意把 q 调偏则过不了', { timeout: 240000 }, async t => {
  let ref, gpu, createHost;
  try {
    ({ loadGpu: gpu } = await import('../../engine/offscreen/load.mjs'));
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    gpu = await gpu();
    ref = await startReference();
  } catch (e) { if (String(e.code).startsWith('env.')) return t.skip(`Kuwahara 对拍不可用：${e.message}`); throw e; }
  try {
    const tsl = async o => {
      globalThis.__KUWA = o;
      const host = await createHost({ gpu, width: W, height: H });
      try { return await host.renderFrame(await host.load(FIXTURE), 0); } finally { host.dispose(); }
    };
    const cmp = async (glslOpts, tslOpts = glslOpts) => {
      const g = await ref.render(REF_PAGE, { W, H, ...glslOpts });
      const d = diffRgba(opaque(await tsl(tslOpts)), opaque(g), { width: W, height: H });
      return { d, ok: meetsGate(d).ok, msg: `${JSON.stringify(tslOpts)} PSNR ${d.psnr} 最大差 ${d.maxDelta} 大差像素 ${d.bigPixels}` };
    };
    for (const o of [{ radius: 4, q: 8, strength: 1 }, { radius: 2, q: 8, strength: 1 }, { radius: 8, q: 8, strength: 0.7 }]) {
      const r = await cmp(o);
      assert.ok(r.ok, r.msg);
      assert.ok(r.d.maxDelta <= 2, `${r.msg}：最大差应在舍入范围内`);
    }
    const bad = await cmp({ radius: 4, q: 8, strength: 1 }, { radius: 4, q: 3, strength: 1 });
    assert.equal(bad.ok, false, `q 调偏后质量门应该不过：${bad.msg}`);
  } finally { await ref.close(); }
});
