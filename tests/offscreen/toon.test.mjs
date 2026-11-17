// TSL 卡通材质（engine/offscreen/tsl/toon.js）对 GLSL 版（engine/shade/toon.js，在无头 Chrome 的 WebGL 里跑）：同一个场景、同一份材质参数，
// 后期全关，只看卡通着色，过 M1 的质量门。缺可选依赖、拿不到 GPU 适配器或没有无头浏览器时跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { diffRgba, meetsGate } from '../../engine/offscreen/diff.mjs';
import { startReference, PAGE_B64 } from './glsl-reference.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = `${ROOT}tests/offscreen/fixtures/toon-work.mjs`;
const W = 480, H = 270;
const OFF = { outline: false, kuwahara: false, bloom: false, paper: false, vignette: 0, grain: 0, grade: { exposure: 1, warmth: 0, lift: 0, gamma: 1, gain: 1, saturation: 1, shoulder: 1 } };

const REF_PAGE = `
import * as THREE from 'three';
import { createLook } from '/engine/look/index.js';
import { toonKind, makeToonShared, setToonShared } from '/engine/shade/toon.js';
import { toonScene } from '/tests/offscreen/fixtures/toon-scene.mjs';
import { patchLayer } from '/engine/shade/surface.js';
${PAGE_B64}
const { W, H, p, shadow, inkTime, wide, noLights } = window.__ARGS;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = shadow; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const shared = makeToonShared(); setToonShared(shared, { inkTime });
const { scene, camera } = toonScene({ THREE, kind: toonKind, shared, W, H, shadow, wide, noLights, layers: [patchLayer()] });
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
    gpu = await gpu();
    (await createHost({ gpu, width: 64, height: 64 })).dispose();   // 适配器在这里才会拿，拿不到要在 try 里被跳过
    ref = await startReference();
  } catch (e) { if (String(e.code).startsWith('env.')) { t.skip(`卡通材质对拍不可用：${e.message}`); return null; } throw e; }
  const tsl = async o => {
    globalThis.__TOON = o;
    const host = await createHost({ gpu, width: W, height: H });
    try { return await host.renderFrame(await host.load(FIXTURE), 0); } finally { host.dispose(); }
  };
  const cmp = async (o, tslOpts = o) => {
    const base = { p: OFF, shadow: false, inkTime: 0 };
    const g = await ref.render(REF_PAGE, { W, H, ...base, ...o });
    const px = await tsl({ ...base, ...tslOpts });
    const d = diffRgba(opaque(px), opaque(g), { width: W, height: H });
    return { d, ok: meetsGate(d).ok, px, g, msg: `PSNR ${d.psnr.toFixed(2)} 最大差 ${d.maxDelta} 大差像素 ${d.bigPixels}` };
  };
  return { cmp, close: () => ref.close() };
}

// 投影：滤波照搬 r170 PCFSoft（useR170Shadow）。实测（1024² 阴影图，2026-11-18）与不带投影同一量级；换成 r187 默认滤波（Vogel 圆盘 + 逐像素旋转）
// 则 PSNR 53.8 dB、大差像素 95 个，过不了 M1 的门——所以滤波必须照搬。

test('卡通着色（不带投影、无灯两种）：TSL 对 GLSL 过质量门；改分档阈值、去掉边缘光亮芯、钩子换个墨线时钟则过不了（含斑块表面层与材质钩子）', { timeout: 300000 }, async t => {
  const s = await setup(t); if (!s) return;
  try {
    for (const o of [{}, { noLights: true }, { inkTime: 3 }]) {
      const r = await s.cmp(o);
      console.log(JSON.stringify(o), r.msg);
      assert.ok(r.ok, `${JSON.stringify(o)}：${r.msg}`);
    }
    for (const [name, o] of [['分档阈值', { mutate: { step1: 0.5 } }], ['亮芯', { mutate: { noCore: true } }], ['墨线时钟', { inkTime: 3 }], ['锈斑量', { mutate: { rustAmt: 0.2 } }]]) {
      const r = await s.cmp({}, o);
      assert.equal(r.ok, false, `${name}改了，质量门应该不过：${r.msg}`);
    }
  } finally { await s.close(); }
});

test('卡通着色（主光投影、r170 PCFSoft 同式滤波）：TSL 对 GLSL 过质量门；改量化窗口、关掉投影压档则过不了', { timeout: 300000 }, async t => {
  const s = await setup(t); if (!s) return;
  try {
    const r = await s.cmp({ shadow: true });
    console.log('投影', r.msg);
    assert.ok(r.ok, `投影：${r.msg}`);
    for (const [name, mut] of [['量化窗口', { shadowLo: 0.2, shadowHi: 0.4 }], ['投影压档', { castShade: 0, shadowDepth: 0 }]]) {
      const m = await s.cmp({ shadow: true }, { shadow: true, mutate: mut });
      assert.equal(m.ok, false, `${name}改了，质量门应该不过：${m.msg}`);
    }
  } finally { await s.close(); }
});

test('未支持的写法显式抛 unsupported.toon：只有 GLSL 钩子没给 TSL 版、InstancedMesh、半透明、贴图、GLSL 插桩', async t => {
  let THREE, TSL;
  try { ({ THREE, TSL } = await (await import('../../engine/offscreen/load.mjs')).loadGpu()); }
  catch (e) { if (String(e.code).startsWith('env.')) return t.skip(`离屏依赖不可用：${e.message}`); throw e; }
  const { toonKind } = await import('../../engine/offscreen/tsl/toon.js');
  const k = toonKind({ THREE, TSL }, { name: 't' });
  const bad = e => e.code === 'unsupported.toon' && /未支持/.test(e.message);
  assert.throws(() => k.make({ fragmentAlbedo: 'toonInk = 1.0;' }), bad);
  assert.throws(() => k.make({ translucent: true }), bad);
  assert.throws(() => k.make({ map: new THREE.Texture() }), bad);
  assert.throws(() => toonKind({ THREE, TSL }, { glsl: 'float f(){return 1.0;}' }), bad);
  assert.throws(() => toonKind({ THREE, TSL }, { shade: { final: 'col *= 0.5;' } }), bad);
  const m = k.make({});
  assert.throws(() => k.bind(new THREE.InstancedMesh(new THREE.BoxGeometry(), m, 2), m), bad);
  assert.doesNotThrow(() => k.make({ fragmentAlbedo: 'toonInk = 1.0;', tsl: { fragmentAlbedo: () => {} } }));
});
