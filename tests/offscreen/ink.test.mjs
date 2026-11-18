// TSL 墨线（engine/offscreen/tsl/{idpass,ink}.js）对 GLSL 参考（engine/look/{ids,ink}.js，在无头 Chrome 的 WebGL 里跑）：
// 同一个场景（fixtures/ink-scene.mjs）、同一帧、同一组参数，笔画覆盖率过 M1 的质量门。缺可选依赖、拿不到 GPU 适配器或没有无头浏览器时跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { boilSeed } from '../../engine/offscreen/tsl/ink.js';
import { diffRgba, meetsGate } from '../../engine/offscreen/diff.mjs';
import { startReference, PAGE_B64 } from './glsl-reference.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = `${ROOT}tests/offscreen/fixtures/ink-work.mjs`;
const W = 320, H = 180;
const P = { width: 2.5, wobble: 1, boilFps: 12, boilHold: 2, warp: 60, pressure: 0.3, breakup: 0, inner: 0.6, silhouette: 0.12, depthThreshold: 0.03, near: 4, far: 80, farScale: 0.6, opacity: 1 };

const REF_PAGE = `
import * as THREE from 'three';
import { createFullscreen, renderTarget } from '/engine/look/pass.js';
import { createIdPass } from '/engine/look/ids.js';
import { createInk } from '/engine/look/ink.js';
import { inkScene } from '/tests/offscreen/fixtures/ink-scene.mjs';
${PAGE_B64}
const { W, H, p, t, k, ss } = window.__ARGS;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1); renderer.setSize(W, H);
const NEAREST = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
const id = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, ...NEAREST, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) });
const edge = renderTarget(W, H, NEAREST), line = renderTarget(W, H, { type: THREE.UnsignedByteType });
const fx = createFullscreen(renderer), ids = createIdPass(renderer), ink = createInk(fx);
const { scene, camera } = inkScene(THREE, W, H);
const maxWidth = ids.render(scene, camera, id) || 1;
ink.render({ ids: id, edge, line, camera, p, fog: null, t, k, ss, maxWidth, fps: 24 });
const raw = new Uint8Array(W * H * 4);
renderer.readRenderTargetPixels(line, 0, 0, W, H, raw);
const out = new Uint8Array(W * H * 4);   // GL 读回自下而上，翻成自上而下；R = 覆盖率，复制到 RGB 与 TSL 夹具的灰度输出同形
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = ((H - 1 - y) * W + x) * 4, d = (y * W + x) * 4; out[d] = out[d + 1] = out[d + 2] = raw[s]; out[d + 3] = 255; }
window.RESULT = { b64: b64(out) };
`;
const opaque = a => { const o = Uint8Array.from(a); for (let i = 3; i < o.length; i += 4) o[i] = 255; return o; };
const ink = px => { let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i] > 8) n++; return n; };   // 有墨的像素数

test('boilSeed：与 engine/look/ink.js 同一个公式（按帧与按秒、非法 boilHold）', async () => {
  const { boilSeed: ref } = await import('../../engine/look/ink.js');
  for (const p of [{ boilFps: 12 }, { boilHold: 1 }, { boilHold: 2 }, { boilHold: 3, boilFps: 12 }])
    for (const fps of [24, 25, 30]) for (let f = 0; f < 200; f += 7) assert.equal(boilSeed(f / fps, p, fps), ref(f / fps, p, fps), `${JSON.stringify(p)} fps ${fps} 帧 ${f}`);
  assert.throws(() => boilSeed(0, { boilHold: 0 }), TypeError);
  assert.throws(() => boilSeed(0, { boilHold: 1.5 }), TypeError);
});

async function setup(t) {
  let ref, gpu, createHost;
  try {
    ({ loadGpu: gpu } = await import('../../engine/offscreen/load.mjs'));
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    gpu = await gpu();
    (await createHost({ gpu, width: 64, height: 64 })).dispose();   // 适配器在这里才会拿，拿不到要在 try 里被跳过
    ref = await startReference();
  } catch (e) { if (String(e.code).startsWith('env.')) { t.skip(`墨线对拍不可用：${e.message}`); return null; } throw e; }
  const tsl = async o => {
    globalThis.__INK = { fps: 24, ...o };
    const host = await createHost({ gpu, width: W, height: H });
    try { return await host.renderFrame(await host.load(FIXTURE), 0); } finally { host.dispose(); }
  };
  const cmp = async (glsl, tslOpts = glsl) => {
    const g = await ref.render(REF_PAGE, { W, H, ss: 1, ...glsl });
    const px = await tsl({ ss: 1, ...tslOpts });
    const d = diffRgba(opaque(px), opaque(g), { width: W, height: H });
    return { d, ok: meetsGate(d).ok, ink: ink(px), refInk: ink(g), msg: `PSNR ${d.psnr} 最大差 ${d.maxDelta} 大差像素 ${d.bigPixels}（TSL 有墨 ${ink(px)} / GLSL ${ink(g)}）` };
  };
  return { cmp, close: () => ref.close() };
}

test('TSL 墨线对 GLSL：默认参数；放大一倍、换沸腾拍、断线与笔压；低折痕阈值、不透明度与内线粗细；故意改种子或折痕阈值则过不了', { timeout: 300000 }, async t => {
  const s = await setup(t);
  if (!s) return;
  try {
    const cases = [
      { p: P, t: 0, k: 1 },
      { p: { ...P, breakup: 0.4, pressure: 0.5 }, t: 5 / 24, k: 2 },
      { p: { ...P, depthThreshold: 0.004, opacity: 0.8, inner: 0.4, farScale: 0.3 }, t: 7 / 24, k: 1.5 },   // 折痕分支（盒子的棱）、非整数 k
    ];
    for (const o of cases) {
      const r = await s.cmp(o);
      console.log(r.msg);
      assert.ok(r.refInk > 500, `参考帧里应该有足够的墨：${r.msg}`);
      assert.ok(r.ok, r.msg);
    }
    const seed = await s.cmp(cases[0], { ...cases[0], t: 2 / 24 });
    assert.equal(seed.ok, false, `沸腾拍不同则质量门应该不过：${seed.msg}`);
    const crease = await s.cmp(cases[0], { ...cases[0], p: { ...P, depthThreshold: 0.2 } });
    assert.equal(crease.ok, false, `折痕阈值不同则质量门应该不过：${crease.msg}`);
  } finally { await s.close(); }
});
