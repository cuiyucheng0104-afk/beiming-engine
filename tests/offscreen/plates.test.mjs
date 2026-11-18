// 离屏底板（engine/offscreen/tsl/plates.js）对 A 路线（engine/stage/plates.js，在无头 Chrome 的 WebGL 里跑）：同一个场景、同两张登记过的底板图、
// 同一段画布贴图，后期全关，过 M1 的质量门。缺可选依赖、拿不到 GPU 适配器或没有无头浏览器时跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { diffRgba, meetsGate } from '../../engine/offscreen/diff.mjs';
import { startReference, PAGE_B64 } from './glsl-reference.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = `${ROOT}tests/offscreen/fixtures/plates-work.mjs`;
const W = 480, H = 270;
const OFF = { outline: false, kuwahara: false, bloom: false, paper: false, vignette: 0, grain: 0, grade: { exposure: 1, warmth: 0, lift: 0, gamma: 1, gain: 1, saturation: 1, shoulder: 1 } };

const REF_PAGE = `
import * as THREE from 'three';
import { createLook } from '/engine/look/index.js';
import * as P from '/engine/stage/plates.js';
import { platesScene } from '/tests/offscreen/fixtures/plates-scene.mjs';
${PAGE_B64}
const { W, H, p } = window.__ARGS;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
const { tex } = await P.loadPlates(['sky_dawn', 'clouds_front_a'], { dir: '/assets/plates' });
const { scene, camera } = platesScene({ THREE, P, W, H, sky: tex.sky_dawn, cloud: tex.clouds_front_a });
const look = createLook(renderer, W, H, { ss: 1, msaa: 0, fps: 24 });
const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: false });
look.render(scene, camera, { t: 0, ...p, target });
const raw = new Uint8Array(W * H * 4), out = new Uint8Array(W * H * 4);
renderer.readRenderTargetPixels(target, 0, 0, W, H, raw);
for (let y = 0; y < H; y++) out.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
window.RESULT = { b64: b64(out) };
`;
const opaque = a => { const o = Uint8Array.from(a); for (let i = 3; i < o.length; i += 4) o[i] = 255; return o; };

export async function setup(t) {
  let ref, gpu, createHost;
  try {
    ({ loadGpu: gpu } = await import('../../engine/offscreen/load.mjs'));
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    await (await import('../../engine/offscreen/canvas.mjs')).loadCanvas();
    gpu = await gpu();
    (await createHost({ gpu, width: 64, height: 64 })).dispose();   // 适配器在这里才会拿，拿不到要在 try 里被跳过
    ref = await startReference();
  } catch (e) { if (String(e.code).startsWith('env.')) { t.skip(`底板对拍不可用：${e.message}`); return null; } throw e; }
  const tsl = async p => {
    globalThis.__PLATES_P = p;
    const host = await createHost({ gpu, width: W, height: H });
    try { return await host.renderFrame(await host.load(FIXTURE), 0); } finally { host.dispose(); }
  };
  const cmp = async (p = OFF) => {
    const g = await ref.render(REF_PAGE, { W, H, p }, { timeout: 120000 });
    const px = await tsl(p);
    const d = diffRgba(opaque(px), opaque(g), { width: W, height: H });
    return { d, ok: meetsGate(d).ok, px, g, msg: `PSNR ${d.psnr.toFixed(2)} 最大差 ${d.maxDelta} 大差像素 ${d.bigPixels}` };
  };
  return { cmp, close: () => ref.close() };
}

test('底板、裁片、抠像、辉光、画布贴图：离屏对 A 路线过质量门', { timeout: 300000 }, async t => {
  const s = await setup(t); if (!s) return;
  try {
    const r = await s.cmp();
    console.log('底板', r.msg);
    assert.ok(r.ok, r.msg);
  } finally { await s.close(); }
});
