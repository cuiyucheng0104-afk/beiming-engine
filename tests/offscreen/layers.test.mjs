// M7 T4 测试：分层风格化 engine/offscreen/tsl/layers.js 对 GLSL 参考实现 engine/look/layers.js 的跨后端对拍与变异拦截，
// 以及 8/16 位分层目录 loadLayers 读取校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadLayers, createLayerLook } from '../../engine/offscreen/tsl/layers.js';
import { encodePng } from '../../tools/plates/png.mjs';
import { diffRgba, meetsGate } from '../../engine/offscreen/diff.mjs';
import { startReference, PAGE_B64 } from './glsl-reference.mjs';
import { makeSyntheticLayers } from './fixtures/layers-scene.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = `${ROOT}tests/offscreen/fixtures/layers-work.mjs`;
const W = 320, H = 180;

function encode16BitGrayPng(width, height, u16) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const crcTab = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc32 = b => {
    let c = -1;
    for (let i = 0; i < b.length; i++) c = crcTab[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const mkChunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 16; ihdr[9] = 0;
  const stride = width * 2;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = u16[y * width + x];
      const o = y * (stride + 1) + 1 + x * 2;
      raw[o] = (v >>> 8) & 255; raw[o + 1] = v & 255;
    }
  }
  return Buffer.concat([sig, mkChunk('IHDR', ihdr), mkChunk('IDAT', zlib.deflateSync(raw)), mkChunk('IEND', Buffer.alloc(0))]);
}

const REF_PAGE = `
import * as THREE from 'three';
import { createLayerLook } from '/engine/look/layers.js';
import { makeSyntheticLayers } from '/tests/offscreen/fixtures/layers-scene.mjs';
${PAGE_B64}
const { W, H, opts } = window.__ARGS;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1); renderer.setSize(W, H);
const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
const look = createLayerLook(renderer, W, H);
look.render(makeSyntheticLayers(W, H), { ...opts, target });
const raw = new Uint8Array(W * H * 4);
renderer.readRenderTargetPixels(target, 0, 0, W, H, raw);
const out = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const s = ((H - 1 - y) * W + x) * 4, d = (y * W + x) * 4;
    out[d] = raw[s]; out[d + 1] = raw[s + 1]; out[d + 2] = raw[s + 2]; out[d + 3] = 255;
  }
}
window.RESULT = { b64: b64(out) };
`;

const opaque = a => { const o = Uint8Array.from(a); for (let i = 3; i < o.length; i += 4) o[i] = 255; return o; };

test('loadLayers：从本地目录解码 8 位颜色/法线与 16 位深度/编号 + meta.json；缺 depth_unit_m 抛错', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-layers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const syn = makeSyntheticLayers(8, 6);
  fs.writeFileSync(path.join(dir, '000002.png'), encodePng({ width: 8, height: 6, channels: 3, data: syn.color.data }));
  fs.writeFileSync(path.join(dir, '000002.view_normal.png'), encodePng({ width: 8, height: 6, channels: 3, data: syn.normal.data }));
  fs.writeFileSync(path.join(dir, '000002.depth.png'), encode16BitGrayPng(8, 6, syn.depth.data));
  fs.writeFileSync(path.join(dir, '000002.object_index.png'), encode16BitGrayPng(8, 6, syn.ids.data));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ frames: [{ index: 2, depth_unit_m: 0.001 }] }));

  const loaded = await loadLayers(dir, 2);
  assert.equal(loaded.width, 8);
  assert.equal(loaded.height, 6);
  assert.equal(loaded.depthUnit, 0.001);
  assert.equal(loaded.depth.depth, 16);
  assert.deepEqual(loaded.depth.data, syn.depth.data);
  assert.deepEqual(loaded.ids.data, syn.ids.data);

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ frames: [{ index: 2 }] }));
  await assert.rejects(() => loadLayers(dir, 2), /depth_unit_m/);
});

test('分层风格化 TSL 版对 GLSL 版：final / color / ids / edge / toon 五视图与 split 对拍全部过门，变异全拦下', { timeout: 180000 }, async t => {
  let ref, gpu, createHost;
  try {
    ({ loadGpu: gpu } = await import('../../engine/offscreen/load.mjs'));
    ({ createHost } = await import('../../engine/offscreen/host.mjs'));
    gpu = await gpu();
    const probe = await createHost({ gpu, width: 32, height: 32 });
    // 验证尺寸不符显式报错
    const lk = createLayerLook({ THREE: gpu.THREE, TSL: gpu.TSL, renderer: probe.renderer }, 32, 32);
    assert.throws(() => lk.render(makeSyntheticLayers(16, 16)), /不符/);
    lk.dispose();
    probe.dispose();
    ref = await startReference();
  } catch (e) {
    if (String(e?.code || '').startsWith('env.')) return t.skip(`layers 对拍不可用：${e.message}`);
    throw e;
  }

  try {
    const renderTsl = async opts => {
      globalThis.__LAYERS_OPTS = opts;
      const host = await createHost({ gpu, width: W, height: H });
      try {
        return opaque(await host.renderFrame(await host.load(FIXTURE), 0));
      } finally {
        host.dispose();
        globalThis.__LAYERS_OPTS = null;
      }
    };
    const renderGlsl = async opts => opaque(await ref.render(REF_PAGE, { W, H, opts }));

    const baseKuwa = { radius: 12, strength: 1, q: 8 }; // H=180 时实际半径 2px，让笔触与关笔触变异在缩略画幅下都清晰可辨
    for (const opts of [
      { t: 0.5, view: 'color', kuwahara: baseKuwa },
      { t: 0.5, view: 'ids', kuwahara: baseKuwa },
      { t: 0.5, view: 'edge', kuwahara: baseKuwa },
      { t: 0.5, view: 'toon', kuwahara: baseKuwa },
      { t: 0.5, view: 'final', kuwahara: baseKuwa },
      { t: 0.5, view: 'final', split: 0.5, kuwahara: baseKuwa },
    ]) {
      const [tslPx, glslPx] = await Promise.all([renderTsl(opts), renderGlsl(opts)]);
      const d = diffRgba(tslPx, glslPx, { width: W, height: H });
      console.log(`layers ${opts.view}${opts.split ? ' split' : ''}: PSNR=${d.psnr.toFixed(2)} maxDelta=${d.maxDelta} big=${d.bigPixels}`);
      const g = meetsGate(d);
      assert.equal(g.ok, true, `${JSON.stringify(opts)} 未过门：PSNR=${d.psnr} maxDelta=${d.maxDelta} bigPixels=${d.bigPixels}`);
    }

    // 变异拦截：关描边、关色阶、关笔触必须与成片明显不同，不能过门
    const finalRef = await renderGlsl({ t: 0.5, view: 'final', kuwahara: baseKuwa });
    for (const mut of [
      { t: 0.5, view: 'final', kuwahara: baseKuwa, outline: false },
      { t: 0.5, view: 'final', kuwahara: baseKuwa, toon: false },
      { t: 0.5, view: 'final', kuwahara: false },
    ]) {
      const mutPx = await renderTsl(mut);
      const d = diffRgba(mutPx, finalRef, { width: W, height: H });
      assert.equal(meetsGate(d).ok, false, `变异 ${JSON.stringify(mut)} 不应通过成片门：${JSON.stringify(d)}`);
    }
  } finally {
    await ref.close();
  }
});
