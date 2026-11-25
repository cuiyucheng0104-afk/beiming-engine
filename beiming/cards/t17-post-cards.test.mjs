import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { launchBrowser } from '../../engine/render/lib/gpu.mjs';
import { startServer } from '../host/page/host.mjs';
import { join } from 'node:path';
import test from 'node:test';
import { createCardRegistry } from './registry.mjs';
import { validateCard, scanCardLeaks } from './validate-card.mjs';

const directories = ['mechanism/three-patch', 'post/ao', 'post/bloom', 'post/volumetric'];
const ids = ['three.patch', 'post.ao', 'post.bloom', 'post.volumetric'];

test('四张卡可按名取，只有三张后期卡能搜到；公开文件通过结构及泄露检查', async () => {
  const cards = [];
  for (const [i, directory] of directories.entries()) {
    const base = join(import.meta.dirname, directory);
    for (const file of ['card.json', i === 0 ? 'index.mjs' : 'three.js', 'selftest.test.mjs']) {
      const raw = await readFile(join(base, file), 'utf8');
      assert.deepEqual(scanCardLeaks(raw), [], `${directory}/${file}`);
      if (file !== 'card.json') continue;
      const card = JSON.parse(raw);
      assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] }, card.id);
      assert.deepEqual([card.id, card.livesIn], [ids[i], ['source:three']]);
      assert.ok(['reproduced', 'measured'].includes(card.status[0].level), card.id);
      cards.push(card);
    }
  }
  const aoOrder = cards[1].ports.order;
  assert.ok(aoOrder.after.includes('post.hdr-chain') && aoOrder.before.includes('post.bloom'));
  assert.ok(cards[3].ports.order.after.includes('post.bloom'));
  const registry = createCardRegistry(cards, { nowDate: '2026-11-25', allowReproducedUntilDate: '2026-11-30' });
  for (const [i, id] of ids.entries()) {
    assert.equal(registry.getCard(id).id, id);
    assert.equal(registry.searchCards({ q: id }).some(card => card.id === id), i !== 0);
  }
});

test('着色器机制在装载时锁版本，在编译时强制命中锚点并区分变体', async () => {
  const { attachMaterialPatch } = await import('./mechanism/three-patch/index.mjs');
  const options = { version: '0.187.0', patches: [{ stage: 'fragmentShader', mode: 'replace', anchor: '#include <opaque_fragment>', code: 'emitColor();' }] };
  assert.throws(() => attachMaterialPatch({}, { ...options, version: '0.186.0' }), /version/);
  const material = () => ({ onBeforeCompile() {}, customProgramCacheKey() { return 'base'; } });
  const a = material(), b = material();
  for (const m of [a, b]) attachMaterialPatch(m, options);
  assert.equal(a.customProgramCacheKey(), b.customProgramCacheKey());
  const program = { vertexShader: '', fragmentShader: '#include <opaque_fragment>' };
  a.onBeforeCompile(program);
  assert.equal(program.fragmentShader, 'emitColor();');
  assert.throws(() => b.onBeforeCompile(program), /anchor/);
});

// 场景：带直角深度断层的浮雕、亮窗和在半幅内投影的遮光板；所有平面均以左下为原点。
function fixture() {
  const width = 96, height = 64, color = [], depth = [];
  for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
    const ridge = (x >> 3) % 2 === (y >> 4) % 2;
    const light = x > 30 && x < 47 && y > 22 && y < 38 ? 6 : ridge ? 0.48 : 0.32;
    color.push(light, light * 0.75, light * 0.5, 1);
    depth.push(ridge ? 39.5 : 40);
  }
  const camera = { near: 0.3, far: 4000, fov: 24, aspect: width / height };
  const tangent = Math.tan(camera.fov * Math.PI / 360);
  const frame = { cameraWorld: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], inverseFocal: [camera.aspect * tangent, tangent],
    sunDirection: [0, 1, 0], shadow: { matrix: [0.02,0,0,0, 0,0.02,0,0, 0,0,0,0, 0.5,0.5,0.65,1], width: 2, height: 2, data: [0.25,1,0.25,1] }, lightColor: [1,0.8,0.4] };
  return { width, height, color, depth, camera, frame };
}

async function cpu(disabled) {
  const [{ applyAO }, { bloomReference }, { volumetricCPU }] = await Promise.all(directories.slice(1).map(dir => import(`./${dir}/three.js`)));
  const f = fixture(), input = { ...f, color: Float32Array.from(f.color), depth: Float32Array.from(f.depth) };
  const occluded = applyAO({ ...input, enabled: disabled !== 'ao' }).color;
  const glowing = bloomReference({ ...input, color: occluded }, { enabled: disabled !== 'bloom' }).color;
  return volumetricCPU({ ...input, ...f.frame, color: glowing }, { enabled: disabled !== 'volumetric' }).color;
}

function display(rgba) {
  assert.ok(rgba.length && rgba.length % 4 === 0);
  const rgb = new Uint8Array(rgba.length * 3 / 4);
  for (let i = 0, k = 0; i < rgba.length; i++) {
    if (i % 4 === 3) continue;
    assert.ok(Number.isFinite(rgba[i]), `nonfinite radiance at ${i}`);
    const v = Math.max(0, Math.min(1, rgba[i]));
    rgb[k++] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1/2.4) - 0.055));
  }
  return rgb;
}

function checkPixels(actual, expected, disabled) {
  assert.equal(actual.length, expected.length);
  let sum = 0, over = 0;
  for (let i = 0; i < actual.length; i += 3) {
    let max = 0;
    for (let c = 0; c < 3; c++) {
      const delta = Math.abs(actual[i+c] - expected[i+c]);
      sum += delta * delta;
      max = Math.max(max, delta);
    }
    if (max >= 5) over++;
  }
  const psnr = 10 * Math.log10(255 ** 2 * actual.length / sum), fraction = 3 * over / actual.length;
  const label = `${disabled ?? 'all'}: PSNR ${psnr.toFixed(3)} dB; ≥5 ${(100*fraction).toFixed(4)}%`;
  assert.ok(disabled ? psnr < 50 && fraction > 0.001 : psnr >= 50 && fraction <= 0.001, label);
  return label;
}

const variants = [null, 'ao', 'bloom', 'volumetric'];
test('无浏览器：逐像素锁定参考帧，关任一卡均击穿两条门限', async t => {
  const baseline = display(await cpu(null));
  // 固定的是 RGB8 整帧指纹，而非测试时重新生成的期望值。
  assert.equal(createHash('sha256').update(baseline).digest('base64'), '18KQaapxQC95Li0r3VlltACgrIbmyGMhknqzKKKt7Lo=');
  for (const disabled of variants.slice(1)) t.diagnostic(checkPixels(display(await cpu(disabled)), baseline, disabled));
});

test('真实 WebGL2：同一组输入跑三卡着色器，全开及三种消融均与像素基线对照', async t => {
  let browser;
  try { browser = await launchBrowser(); } catch (error) { return t.skip(error.message.split('\n')[0]); }
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const server = await startServer();
    t.after(() => server.close());
    await page.goto(server.origin);
    if (!await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      return Boolean(gl?.getExtension('EXT_color_buffer_float'));
    })) return t.skip('无可渲染浮点目标的 WebGL2 上下文');
    const baseline = display(await cpu(null));
    for (const disabled of variants) {
      const pixels = await page.evaluate(async ({ f, disabled }) => {
        const [T, ao, bloom, vol] = await Promise.all([import('three'), ...['ao', 'bloom', 'volumetric'].map(name => import(`/beiming/cards/post/${name}/three.js`))]);
        const renderer = new T.WebGLRenderer(), camera = new T.PerspectiveCamera(f.camera.fov, f.camera.aspect, f.camera.near, f.camera.far);
        const quadCamera = new T.Camera(), { width, height } = f;
        renderer.setSize(width, height, false);
        function texture(data, w, h, linear = false) {
          const tex = new T.DataTexture(Float32Array.from(data), w, h, T.RGBAFormat, T.FloatType);
          tex.magFilter = tex.minFilter = linear ? T.LinearFilter : T.NearestFilter;
          tex.needsUpdate = true;
          return tex;
        }
        const color = texture(f.color, width, height, true);
        const depth = texture(f.depth.flatMap(z => [z,0,0,1]), width, height);
        const shadow = texture(f.frame.shadow.data.flatMap(z => [z,0,0,1]), 2, 2);
        const targets = Array.from({ length: 3 }, () => new T.WebGLRenderTarget(width, height, { type: T.FloatType, minFilter: T.LinearFilter, magFilter: T.LinearFilter, depthBuffer: false }));
        const a = ao.create({ THREE: T, tracks: { camera } }, { enabled: disabled !== 'ao' });
        const b = bloom.create({ THREE: T }, { enabled: disabled !== 'bloom' });
        const v = vol.create({ THREE: T }, { enabled: disabled !== 'volumetric' });
        try {
          v.setFrame({ ...f.frame, shadow: { texture: shadow, matrix: f.frame.shadow.matrix } });
          for (const [i, pass] of [a.object, b.object, v.object].entries()) {
            pass.material.uniforms.tInput.value = i ? targets[i-1].texture : color;
            if (pass.material.uniforms.tDepth) pass.material.uniforms.tDepth.value = depth;
            renderer.setRenderTarget(targets[i]);
            renderer.render(pass, quadCamera);
          }
          const out = new Float32Array(width * height * 4);
          renderer.readRenderTargetPixels(targets[2], 0, 0, width, height, out);
          return Array.from(out);
        } finally {
          for (const resource of [a,b,v,color,depth,shadow,...targets]) resource.dispose();
          renderer.dispose(); renderer.forceContextLoss();
        }
      }, { f: fixture(), disabled });
      assert.deepEqual(errors, []);
      t.diagnostic(checkPixels(display(pixels), baseline, disabled));
      // 不只要求消融结果变红，还核查 GPU 正确关闭的是同一道通道。
      if (disabled) checkPixels(display(pixels), display(await cpu(disabled)), null);
    }
  } finally { await browser.close(); }
});
