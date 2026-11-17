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
import { kuwaharaInput, kuwaharaDepth, KUWA_NEAR, KUWA_FAR } from '/tests/offscreen/fixtures/kuwahara-input.mjs';
${PAGE_B64}
const { W, H, radius, q, strength, far } = window.__ARGS;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1); renderer.setSize(W, H);
const tex = new THREE.DataTexture(kuwaharaInput(W, H), W, H, THREE.RGBAFormat);
tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
const depth = far ? new THREE.DataTexture(kuwaharaDepth(W, H), W, H, THREE.RedFormat, THREE.FloatType) : new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
depth.minFilter = depth.magFilter = THREE.NearestFilter; depth.needsUpdate = true;
const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
const fx = createFullscreen(renderer), kw = createKuwahara(fx);
kw.render({ src: tex, depth, camera: new THREE.PerspectiveCamera(35, W / H, KUWA_NEAR, KUWA_FAR), p: { radius, q, strength, farRadius: far?.radius, farStart: far?.start, farEnd: far?.end }, k: 1, w: W, h: H }, target);
const out = new Uint8Array(W * H * 4);
renderer.readRenderTargetPixels(target, 0, 0, W, H, out);
window.RESULT = { b64: b64(out) };
`;
const opaque = a => { const o = Uint8Array.from(a); for (let i = 3; i < o.length; i += 4) o[i] = 255; return o; };

test('KR 越界：抛 RangeError（不静默夹到范围内）', () => {
  for (const KR of [1, 11, 2.5, NaN]) assert.throws(() => kuwahara({}, { KR }), RangeError);
});

// 起 Dawn 与无头 Chrome，返回 { cmp, close }；环境不够返回 null 并跳过。cmp(glslOpts, tslOpts)：同一输入两边各渲一次，返回差异与质量门结果
async function setup(t) {
  let ref, gpu, createHost;
  try {
    ({ loadGpu: gpu } = await import('../../engine/offscreen/load.mjs'));
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    gpu = await gpu();
    (await createHost({ gpu, width: 64, height: 64 })).dispose(); // 适配器在这里才会拿，拿不到要在 try 里被跳过
    ref = await startReference();
  } catch (e) { if (String(e.code).startsWith('env.')) { t.skip(`Kuwahara 对拍不可用：${e.message}`); return null; } throw e; }
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
  return { cmp, close: () => ref.close() };
}

test('TSL 对 GLSL：半径 2、4、8（强度 0.7）都过质量门；故意把 q 调偏则过不了', { timeout: 240000 }, async t => {
  const s = await setup(t);
  if (!s) return;
  try {
    for (const o of [{ radius: 4, q: 8, strength: 1 }, { radius: 2, q: 8, strength: 1 }, { radius: 8, q: 8, strength: 0.7 }]) {
      const r = await s.cmp(o);
      assert.ok(r.ok, r.msg);
      assert.ok(r.d.maxDelta <= 2, `${r.msg}：最大差应在舍入范围内`);
    }
    const bad = await s.cmp({ radius: 4, q: 8, strength: 1 }, { radius: 4, q: 3, strength: 1 });
    assert.equal(bad.ok, false, `q 调偏后质量门应该不过：${bad.msg}`);
  } finally { await s.close(); }
});

test('深度换半径：TSL 对 GLSL 过质量门（近处 3 → 远处 8，过渡带 20..120，右上角天空）；关掉 far 或改过渡带则过不了', { timeout: 240000 }, async t => {
  const s = await setup(t);
  if (!s) return;
  try {
    const far = { radius: 8, start: 20, end: 120 };
    const o = { radius: 3, q: 8, strength: 1, far };
    const r = await s.cmp(o);
    assert.ok(r.ok, r.msg);
    assert.ok(r.d.maxDelta <= 2, `${r.msg}：最大差应在舍入范围内`);
    const noFar = await s.cmp(o, { radius: 3, q: 8, strength: 1 });
    assert.equal(noFar.ok, false, `TSL 不带 far 时质量门应该不过：${noFar.msg}`);
    const shifted = await s.cmp(o, { ...o, far: { ...far, start: 40, end: 140 } });
    assert.equal(shifted.ok, false, `过渡带挪位后质量门应该不过：${shifted.msg}`);
  } finally { await s.close(); }
});

test('深度约定：pass() 的 WebGPU 深度纹理经 perspectiveDepthToViewZ 换回的视距等于真实距离（10、60）', { timeout: 60000 }, async t => {
  let gpu, createHost;
  try {
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    gpu = await (await import('../../engine/offscreen/load.mjs')).loadGpu();
    (await createHost({ gpu, width: 64, height: 64 })).dispose();
  } catch (e) { if (String(e.code).startsWith('env.')) return t.skip(`深度约定检查不可用：${e.message}`); throw e; }
  const srgb = l => Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055));
  for (const z of [10, 60]) {
    globalThis.__DEPTH_Z = z;
    const host = await createHost({ gpu, width: 64, height: 64 });
    try {
      const px = await host.renderFrame(await host.load(`${ROOT}tests/offscreen/fixtures/depth-plane-work.mjs`), 0);
      for (const [x, y] of [[32, 32], [1, 1], [62, 62]]) {   // 中心与两个角：平面垂直于视线，视距处处相同
        const v = px[(y * 64 + x) * 4];
        assert.ok(Math.abs(v - srgb(z / 100)) <= 1, `视距 ${z}：(${x},${y}) 读回 ${v}，应约为 ${srgb(z / 100)}`);
      }
    } finally { host.dispose(); }
  }
});
