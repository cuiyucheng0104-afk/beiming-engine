// 整条 A 风格后期链（engine/offscreen/tsl/look.js）对 GLSL 参考（engine/look/index.js 的 createLook，在无头 Chrome 的 WebGL 里跑）：
// 同一个场景（fixtures/ink-scene.mjs）、风格锁定 beiming-original.v1 的真实参数，bloom、调色、Kuwahara、墨线、纸纹、暗角、颗粒的合成结果过 M1 的质量门。
// 缺可选依赖、拿不到 GPU 适配器或没有无头浏览器时跳过。
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
const { W, H, ss, defaults, p, imagePaper } = window.__ARGS;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1); renderer.setSize(W, H);
const look = createLook(renderer, W, H, { ss, msaa: 0, fps: 24, defaults });
await look.ready;
const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: false });
const { scene, camera } = inkScene(THREE, W, H);
const pp = { ...p, target };
if (imagePaper) {
  const { px, size, mid } = paperTile();
  const flipped = new Uint8Array(px.length);   // GL 的 DataTexture 第 0 行在下：把图片行序（自上而下）翻成自下而上，等于图片经 flipY 上传
  for (let y = 0; y < size; y++) flipped.set(px.subarray(y * size * 4, (y + 1) * size * 4), (size - 1 - y) * size * 4);
  const tex = new THREE.DataTexture(flipped, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
  pp.paper = { ...(p.paper || {}), tex, mid };
}
look.render(scene, camera, pp);
const raw = new Uint8Array(W * H * 4);
renderer.readRenderTargetPixels(target, 0, 0, W, H, raw);
const out = new Uint8Array(W * H * 4);   // GL 读回自下而上，翻成自上而下
for (let y = 0; y < H; y++) out.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
window.RESULT = { b64: b64(out) };
`;
const opaque = a => { const o = Uint8Array.from(a); for (let i = 3; i < o.length; i += 4) o[i] = 255; return o; };

async function setup(t) {
  let ref, gpu, createHost;
  try {
    ({ loadGpu: gpu } = await import('../../engine/offscreen/load.mjs'));
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    gpu = await gpu();
    (await createHost({ gpu, width: 64, height: 64 })).dispose();   // 适配器在这里才会拿，拿不到要在 try 里被跳过
    ref = await startReference();
  } catch (e) { if (String(e.code).startsWith('env.')) { t.skip(`整链对拍不可用：${e.message}`); return null; } throw e; }
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
    return { d, ok: meetsGate(d).ok, msg: `PSNR ${d.psnr} 最大差 ${d.maxDelta} 大差像素 ${d.bigPixels}`, px, g };
  };
  return { cmp, close: () => ref.close() };
}

test('整链对拍：风格锁定的真实参数；全部旋钮；图片纸纹；改任一项则质量门过不了', { timeout: 600000 }, async t => {
  const s = await setup(t);
  if (!s) return;
  try {
    const knobs = {
      t: 5 / 24, grade: { exposure: 1.3, warmth: 0.3, saturation: 0.7, shoulder: 0.8, lift: [0.05, 0.02, 0.1], gamma: 1.2, gain: [1, 0.95, 0.9] },
      outline: { width: 3.2, color: '#203040', tint: 0.4, darken: 0.3, breakup: 0.3 }, kuwahara: { radius: 3, farRadius: 7, farStart: 12, farEnd: 40 },
      bloom: { strength: 0.8, threshold: 0.5, radius: 0.8 }, paper: { strength: 0.2, scale: 2 }, vignette: 0.4, grain: { amount: 0.4, size: 3, holdFrames: 2 },
    };
    const cases = {
      '风格锁定的真实参数': { p: { t: 0, grade: { exposure: 1.6 } } },
      '全部旋钮': { p: knobs },
      '图片纸纹': { p: { t: 3 / 24, grade: { exposure: 1.6 }, paper: { strength: 0.14, scale: 1.5 } }, imagePaper: true },
    };
    for (const [name, o] of Object.entries(cases)) {
      const r = await s.cmp(o);
      console.log(name, r.msg);
      assert.ok(r.ok, `${name}：${r.msg}`);
      assert.ok(r.d.maxDelta <= 2, `${name}：最大差应在舍入范围内：${r.msg}`);
    }
    const base = cases['风格锁定的真实参数'];
    const wrong = {
      'bloom 关掉': { bloom: false }, '调色改了': { grade: { exposure: 1.6, warmth: 0.5 } }, '纸纹强度改了': { paper: { strength: 0.2 } },
      '墨线关掉': { outline: false }, '暗角改了': { vignette: 0.5 },   // Kuwahara 在平涂色块上几乎不改画面，它的敏感性见 kuwahara.test.mjs
    };
    for (const [name, patch] of Object.entries(wrong)) {
      const r = await s.cmp(base, { ...base, p: { ...base.p, ...patch } });
      assert.equal(r.ok, false, `${name}：质量门应该不过：${r.msg}`);
    }
  } finally { await s.close(); }
});

test('未支持的语义显式抛错（雾、debug、纸纹 anchor / scaleMode、色调映射），不静默画错', { timeout: 120000 }, async t => {
  let gpu, createHost;
  try {
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    gpu = await (await import('../../engine/offscreen/load.mjs')).loadGpu();
    (await createHost({ gpu, width: 64, height: 64 })).dispose();
  } catch (e) { if (String(e.code).startsWith('env.')) return t.skip(`离屏出片不可用：${e.message}`); throw e; }
  const { createLook } = await import('../../engine/offscreen/tsl/look.js');
  const { inkScene } = await import('./fixtures/ink-scene.mjs');
  const host = await createHost({ gpu, width: 64, height: 36 }), { THREE, TSL, renderer } = host;
  const look = createLook({ THREE, TSL, renderer }, { width: 64, height: 36, ss: 1 });
  const { scene, camera } = inkScene(THREE, 64, 36);
  try {
    const bad = {
      fog: { fog: { density: 0.02 } }, debug: { debug: 'edge' },
      'paper.anchor': { paper: { strength: 0.1, anchor: { pos: [0, 0], origin: [0, 0], zoom: 1 } } },
      'paper.scaleMode': { paper: { strength: 0.1, scaleMode: 'refHeight' } },
    };
    for (const [name, p] of Object.entries(bad)) {
      const before = renderer.getRenderTarget();
      assert.throws(() => look.render(scene, camera, p), e => /^unsupported\./.test(e.code) && /未支持|不支持|没有/.test(e.message), name);
      assert.equal(renderer.getRenderTarget(), before, `${name}：渲染目标没有还原`);
    }
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    assert.throws(() => createLook({ THREE, TSL, renderer }, { width: 64, height: 36 }), e => e.code === 'unsupported.look');
  } finally { renderer.toneMapping = THREE.NoToneMapping; look.dispose(); host.dispose(); }
});

test('MSAA：msaa = 4 能出画面，与 msaa = 0 只在边缘上不同（深度与墨线照常工作）', { timeout: 120000 }, async t => {
  let gpu, createHost;
  try {
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    gpu = await (await import('../../engine/offscreen/load.mjs')).loadGpu();
    (await createHost({ gpu, width: 64, height: 64 })).dispose();
  } catch (e) { if (String(e.code).startsWith('env.')) return t.skip(`离屏出片不可用：${e.message}`); throw e; }
  const render = async msaa => {
    globalThis.__LOOK = { defaults: DEFAULTS, p: { t: 0, grade: { exposure: 1.6 } }, ss: 2, msaa };
    const host = await createHost({ gpu, width: W, height: H });
    try { return await host.renderFrame(await host.load(FIXTURE), 0); } finally { host.dispose(); }
  };
  const a = await render(0), b = await render(4);
  const d = diffRgba(opaque(b), opaque(a), { width: W, height: H });
  console.log(`msaa 4 对 0：PSNR ${d.psnr} 最大差 ${d.maxDelta} 大差像素 ${d.bigPixels}`);
  assert.ok(d.psnr > 30, `msaa 4 的画面应该与 msaa 0 相近：PSNR ${d.psnr}`);
  assert.ok(d.maxDelta > 0, 'msaa 4 应该真的改变了边缘（否则没生效）');
});
