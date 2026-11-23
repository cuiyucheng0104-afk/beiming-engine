// S8：three 离屏实验宿主注册（严禁进入主线验收与考题）、host:'any' 解析与页面/离屏双宿主像素对拍（PSNR ≥ 50 dB 且差 > 5 级像素 ≤ 0.1%）
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  compareHostFrames,
  linearRgbaToUint8,
  openOffscreenHost,
  probeOffscreenGpu,
} from '../../host/offscreen/host.mjs';
import { startSource } from '../../host/page/host.mjs';
import { loadContracts } from '../../kernel/contracts/validate.mjs';
import { shotInput } from '../../kernel/eval/input.mjs';
import { caps } from './caps.mjs';
import { listThreeHosts, resolveThreeHost, SourceError, THREE_HOSTS } from './hosts.mjs';
import { planOpen } from './plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const isCode = (code) => (err) => err instanceof SourceError && err.code === code;

test('S8-1 THREE_HOSTS 注册表结构与默认 caps() 契约隔离：offscreen 仅作为实验宿主条目，不进默认 hosts、主线验收与考题', async () => {
  const hostMod = await import(pathToFileURL(join(HERE, 'hosts.mjs')).href);
  assert.equal(hostMod.THREE_HOSTS, THREE_HOSTS);
  assert.ok(Object.isFrozen(THREE_HOSTS));
  assert.ok(Object.isFrozen(THREE_HOSTS.page));
  assert.ok(Object.isFrozen(THREE_HOSTS.offscreen));

  assert.deepEqual(THREE_HOSTS.page, {
    id: 'page',
    experimental: false,
    mainlineAcceptance: true,
    examEligible: true,
    backend: 'webgl2',
    note: '主线浏览器页面宿主（主线验收与基准考题唯一准入宿主）',
  });
  assert.deepEqual(THREE_HOSTS.offscreen, {
    id: 'offscreen',
    experimental: true,
    mainlineAcceptance: false,
    examEligible: false,
    backend: 'webgpu-dawn',
    note: 'Node + Dawn 实验宿主，不进主线验收与考题',
  });

  // 默认 caps() 只保留 ['page']，过 source/0.1 冻结契约与 F15 校验
  const defaultCaps = caps();
  assert.deepEqual(defaultCaps.hosts, ['page']);
  assert.equal(defaultCaps.ext, undefined);
  const { validate } = await loadContracts();
  const vDefault = validate(defaultCaps);
  assert.deepEqual([vDefault.schemaErrors, vDefault.violations], [[], {}]);

  // 显式开启实验宿主时暴露 ['page', 'offscreen'] 与 ext['three.hosts']，且通过 caps.schema.json 结构校验
  const expCaps = caps({}, { experimentalHosts: true });
  assert.deepEqual(expCaps.hosts, ['page', 'offscreen']);
  assert.deepEqual(expCaps.ext?.['three.hosts'], THREE_HOSTS);
  assert.deepEqual(validate(expCaps, 'source', 'caps.schema.json').schemaErrors, []);

  // 主线验收或基准考题上下文下，即便传 experimentalHosts: true 也严禁暴露 offscreen
  assert.deepEqual(caps({}, { experimentalHosts: true, mainline: true }).hosts, ['page']);
  assert.deepEqual(caps({}, { experimentalHosts: true, mainlineAcceptance: true }).hosts, ['page']);
  assert.deepEqual(caps({}, { experimentalHosts: true, exam: true }).hosts, ['page']);
  assert.deepEqual(listThreeHosts(), ['page']);
  assert.deepEqual(listThreeHosts({ allowExperimental: true }), ['page', 'offscreen']);
  assert.deepEqual(listThreeHosts({ allowExperimental: true, mainline: true }), ['page']);
  assert.deepEqual(listThreeHosts({ allowExperimental: true, exam: true }), ['page']);

  // caps() 的非法 opts 报 usage.bad-argument
  for (const badOpts of [null, 'yes', 123, [], { experimentalHosts: 'true' }, { unknownKey: true }]) {
    assert.throws(() => caps({}, badOpts), isCode('usage.bad-argument'));
  }
});

test('S8-2 resolveThreeHost 与 planOpen：主线/考题/默认只落 page 并拒收 offscreen，实验对拍将 host:any 展开为双宿主，拒收非法入参', () => {
  const anyShot = { id: 's01', in: 0, out: 12, source: 'three', host: 'any', mode: 'native-code', entry: 's8-parity.shot.js', colorRef: 'display', seed: 7 };
  const pageShot = { ...anyShot, host: 'page' };
  const offShot = { ...anyShot, host: 'offscreen' };
  const rendererAnyShot = {
    id: 's02',
    in: 0,
    out: 12,
    source: 'core',
    host: 'offscreen',
    mode: 'cards-data',
    colorRef: 'display',
    seed: 7,
    renderer: { source: 'three', host: 'any', mode: 'native-code', entry: 's8-parity.shot.js' },
  };
  const rendererOffShot = {
    ...rendererAnyShot,
    renderer: { source: 'three', host: 'offscreen', mode: 'native-code', entry: 's8-parity.shot.js' },
  };

  // 1. 默认、主线验收、基准考题上下文：host:'any' 只落 'page'，显式 host:'offscreen' 报 contract.unsupported-mode
  for (const ctx of [
    undefined,
    {},
    { allowExperimental: false },
    { allowExperimental: true, mainline: true },
    { allowExperimental: true, mainlineAcceptance: true },
    { allowExperimental: true, exam: true },
  ]) {
    assert.equal(resolveThreeHost(anyShot, ctx), 'page');
    assert.equal(resolveThreeHost(rendererAnyShot, ctx), 'page');
    assert.equal(resolveThreeHost(pageShot, ctx), 'page');
    assert.throws(() => resolveThreeHost(offShot, ctx), isCode('contract.unsupported-mode'));
    assert.throws(() => resolveThreeHost(rendererOffShot, ctx), isCode('contract.unsupported-mode'));
  }
  // 镜头或片子自身带 exam: true 标记时同样严禁进入 offscreen
  assert.equal(resolveThreeHost({ ...anyShot, exam: true }, { allowExperimental: true }), 'page');
  assert.throws(() => resolveThreeHost({ ...offShot, exam: true }, { allowExperimental: true }), isCode('contract.unsupported-mode'));

  // 2. 实验对拍模式（allowExperimental: true 且非主线/非考题）：host:'any' 展开为 ['page', 'offscreen']
  assert.deepEqual(resolveThreeHost(anyShot, { allowExperimental: true }), ['page', 'offscreen']);
  assert.deepEqual(resolveThreeHost(rendererAnyShot, { allowExperimental: true }), ['page', 'offscreen']);
  assert.equal(resolveThreeHost(pageShot, { allowExperimental: true }), 'page');
  assert.equal(resolveThreeHost(offShot, { allowExperimental: true }), 'offscreen');
  assert.equal(resolveThreeHost(rendererOffShot, { allowExperimental: true }), 'offscreen');

  // 3. planOpen 联动校验
  const wrapInput = (shot, more = {}) => ({ film: 'f_s8', output: { size: [320, 180], fps: '24/1' }, shot, ...more });
  const defaultCaps = caps();
  const expCaps = caps({}, { experimentalHosts: true });
  assert.deepEqual(planOpen(defaultCaps, wrapInput(anyShot), { lock: null, tier: 'final' }), { seed: 7 });
  assert.throws(() => planOpen(defaultCaps, wrapInput(offShot), { lock: null, tier: 'final' }), isCode('contract.unsupported-mode'));
  assert.deepEqual(planOpen(expCaps, wrapInput(anyShot), { lock: null, tier: 'final' }), { seed: 7 });
  assert.deepEqual(planOpen(expCaps, wrapInput(offShot), { lock: null, tier: 'final' }), { seed: 7 });
  assert.throws(() => planOpen(expCaps, wrapInput(offShot), { lock: null, tier: 'final', mainline: true }), isCode('contract.unsupported-mode'));
  assert.throws(() => planOpen(expCaps, wrapInput(offShot), { lock: null, tier: 'final', exam: true }), isCode('contract.unsupported-mode'));

  // 4. 正常非法入参报 usage.bad-argument
  for (const badShot of [
    null,
    undefined,
    'any',
    42,
    [],
    {},
    { source: 'three', host: '' },
    { source: 'three', host: '   ' },
    { source: 'three', host: 123 },
    { source: 'three', host: null },
    { source: 'three', host: 'cycles' },
    { source: 'three', host: 'headless-page' },
    { source: 'blender', host: 'any' },
    { source: 'three', host: 'any', renderer: null },
  ]) {
    assert.throws(() => resolveThreeHost(badShot, { allowExperimental: true }), isCode('usage.bad-argument'));
  }
  for (const badOpts of [
    null,
    'experimental',
    1,
    [],
    { allowExperimental: 'true' },
    { mainline: 1 },
    { exam: null },
    { strayOption: true },
  ]) {
    assert.throws(() => resolveThreeHost(anyShot, badOpts), isCode('usage.bad-argument'));
  }
});

test('S8-3 compareHostFrames 对拍比较器算式：精确 PSNR ≥ 50 dB 且差 > 5/255 像素 ≤ 0.1%，覆盖正例、双负对照与非法入参', () => {
  const width = 100;
  const height = 10;
  const totalPixels = width * height; // 1000 像素
  const base = new Uint8Array(totalPixels * 4);
  for (let i = 0; i < totalPixels; i++) {
    base[i * 4] = 80;
    base[i * 4 + 1] = 140;
    base[i * 4 + 2] = 200;
    base[i * 4 + 3] = 255;
  }

  // 1. 完全相同：PSNR = Infinity，diffOver5Count = 0
  const identical = compareHostFrames(base, new Uint8Array(base), { width, height });
  assert.equal(identical.ok, true);
  assert.equal(identical.psnrDb, Infinity);
  assert.equal(identical.diffOver5Count, 0);
  assert.equal(identical.diffOver5Ratio, 0);
  assert.equal(identical.maxChannelDiff, 0);

  // 2. 微小容差正例：1 个像素（占比 0.1% <= 0.1%）单通道偏移 6 级，另有 20 个像素偏移 1 级 -> PSNR ≈ 65.9 dB ≥ 50 dB 且 diffOver5Ratio = 0.001 <= 0.001
  const subtlePass = new Uint8Array(base);
  subtlePass[0] += 6; // 1 个像素 > 5 级（1 / 1000 = 0.001）
  for (let i = 1; i <= 20; i++) subtlePass[i * 4 + 1] += 1;
  const passRes = compareHostFrames(base, subtlePass, { width, height });
  assert.equal(passRes.ok, true);
  assert.ok(passRes.psnrDb >= 50, `预期 PSNR ≥ 50 dB，实际 ${passRes.psnrDb}`);
  assert.equal(passRes.diffOver5Count, 1);
  assert.equal(passRes.diffOver5Ratio, 0.001);
  assert.equal(passRes.maxChannelDiff, 6);

  // 3. 负对照 A：局部 2 个像素（占比 0.2% > 0.1%）单通道偏移 8 级 -> 虽然整体 PSNR ≈ 64.9 dB ≥ 50 dB，但 diffOver5Ratio = 0.002 > 0.001，必须判失败
  const failDiffRatio = new Uint8Array(base);
  failDiffRatio[0] += 8;
  failDiffRatio[4] += 8;
  const negA = compareHostFrames(base, failDiffRatio, { width, height });
  assert.equal(negA.ok, false);
  assert.ok(negA.psnrDb >= 50, '负对照 A 的整体 PSNR 仍高于 50 dB');
  assert.equal(negA.diffOver5Count, 2);
  assert.equal(negA.diffOver5Ratio, 0.002);
  assert.equal(negA.maxChannelDiff, 8);

  // 4. 负对照 B：全图均匀偏移 2 级 -> 虽然没有任何像素差值 > 5（diffOver5Count = 0，maxChannelDiff = 2），但 PSNR ≈ 42.11 dB < 50 dB，必须判失败
  const failLowPsnr = new Uint8Array(base);
  for (let i = 0; i < totalPixels; i++) {
    failLowPsnr[i * 4] += 2;
    failLowPsnr[i * 4 + 1] -= 2;
    failLowPsnr[i * 4 + 2] += 2;
  }
  const negB = compareHostFrames(base, failLowPsnr, { width, height });
  assert.equal(negB.ok, false);
  assert.equal(negB.diffOver5Count, 0);
  assert.equal(negB.maxChannelDiff, 2);
  assert.ok(Math.abs(negB.psnrDb - 10 * Math.log10((255 * 255) / 4)) < 1e-9);
  assert.ok(negB.psnrDb < 50);

  // 5. 支持线性 Float32Array 输入并拒绝非法参数
  const f32A = Float32Array.from(base, (v) => v / 255);
  const f32B = Float32Array.from(base, (v) => v / 255);
  assert.equal(compareHostFrames(f32A, f32B, { width, height }).psnrDb, Infinity);
  assert.equal(linearRgbaToUint8(new Uint8ClampedArray([10, 20, 30, 255]))[2], 30);

  assert.throws(() => compareHostFrames(base, base, null), isCode('usage.bad-argument'));
  assert.throws(() => compareHostFrames(base, base, { width: 0, height: 10 }), isCode('usage.bad-argument'));
  assert.throws(() => compareHostFrames(base, base, { width, height, minPsnr: -1 }), isCode('usage.bad-argument'));
  assert.throws(() => compareHostFrames(base, base, { width, height, maxDiff5Ratio: 1.5 }), isCode('usage.bad-argument'));
  assert.throws(() => compareHostFrames(base, base, { width, height, stray: 1 }), isCode('usage.bad-argument'));
  assert.throws(() => compareHostFrames(base.subarray(0, 16), base, { width, height }), isCode('usage.bad-argument'));
  assert.throws(() => compareHostFrames([1, 2, 3, 4], base, { width: 1, height: 1 }), isCode('usage.bad-argument'));
});

test('S8-4 host:any 镜头真实双宿主对拍（Chromium page WebGL2 vs Node+Dawn offscreen WebGPU）：多帧 PSNR ≥ 50 dB 且差 > 5 级像素 ≤ 0.1%', async (t) => {
  // 主线验收与考题下 openOffscreenHost 必须直接拒绝
  await assert.rejects(() => openOffscreenHost({ mainline: true }), isCode('contract.unsupported-mode'));
  await assert.rejects(() => openOffscreenHost({ exam: true }), isCode('contract.unsupported-mode'));

  const W = 320;
  const H = 180;
  const FILM = {
    format: 'film/3.0',
    id: 's8-dual-host-parity',
    output: { size: [W, H], fps: '24/1', frames: 12 },
    shots: [
      {
        id: 'parity',
        in: 0,
        out: 12,
        source: 'three',
        host: 'any',
        mode: 'native-code',
        entry: 's8-parity.shot.js',
        colorRef: 'display',
        seed: 19,
        shutter: { angleDeg: 180, samples: 4 },
      },
    ],
  };

  const input = shotInput(FILM, 'parity');
  assert.deepEqual(resolveThreeHost(input.shot, { allowExperimental: true }), ['page', 'offscreen']);
  assert.equal(resolveThreeHost(input.shot, { allowExperimental: true, mainline: true }), 'page');

  const gpuProbe = await probeOffscreenGpu();
  if (!gpuProbe.available) {
    t.skip(`跳过真实 GPU 双宿主对拍（Dawn WebGPU 不可用：${gpuProbe.reason}）`);
    return;
  }

  let pageSource;
  try {
    pageSource = await startSource();
  } catch (e) {
    t.skip(`跳过真实 GPU 双宿主对拍（Chromium 页面宿主不可用：${String(e?.message ?? e).split('\n')[0]}）`);
    return;
  }

  const offscreenSource = await openOffscreenHost();
  const workspace = await mkdtemp(join(tmpdir(), 'beiming-s8-'));
  try {
    // 离屏实验宿主在 open 阶段同样拒收 mainline / exam
    await assert.rejects(
      () => offscreenSource.open(input, { lock: null, tier: 'final', workspace, filmDir: HERE, mainline: true }),
      isCode('contract.unsupported-mode'),
    );
    await assert.rejects(
      () => offscreenSource.open(input, { lock: null, tier: 'final', workspace, filmDir: HERE, exam: true }),
      isCode('contract.unsupported-mode'),
    );

    const pageSession = await pageSource.open(input, { lock: null, tier: 'final', workspace, filmDir: HERE });
    const offscreenSession = await offscreenSource.open(input, { lock: null, tier: 'final', workspace, filmDir: HERE });
    try {
      assert.deepEqual(offscreenSession.manifest(), pageSession.manifest());

      for (const frame of [0, 4]) {
        const pageRes = await pageSession.render(frame, {}, ['color', 'meta']);
        const pageBytes = await readFile(join(workspace, pageRes.layers.color.file));
        const pageF32 = new Float32Array(pageBytes.buffer, pageBytes.byteOffset, pageBytes.byteLength / 4);
        const pageRgba = linearRgbaToUint8(pageF32);

        const offRes = await offscreenSession.render(frame, {}, ['color', 'meta']);
        assert.equal(offRes.meta.source.host, 'offscreen');
        assert.equal(offRes.meta.source.experimental, true);

        const parity = compareHostFrames(pageRgba, offRes.rgba, {
          width: W,
          height: H,
          minPsnr: 50,
          maxDiff5Ratio: 0.001,
        });
        assert.equal(
          parity.ok,
          true,
          `第 ${frame} 帧双宿主对拍未达标：PSNR=${parity.psnrDb} dB，diffOver5Ratio=${parity.diffOver5Ratio}（maxDiff=${parity.maxChannelDiff}）`,
        );
        assert.ok(parity.psnrDb >= 50, `第 ${frame} 帧 PSNR 必须 ≥ 50 dB，实际 ${parity.psnrDb}`);
        assert.ok(parity.diffOver5Ratio <= 0.001, `第 ${frame} 帧差 > 5 级像素比必须 ≤ 0.1%，实际 ${parity.diffOver5Ratio}`);

        // 在真实离屏帧上注入 > 0.1% 像素的 +12 级局部篡改作为负对照，断言比较器必然检出失败
        const tampered = new Uint8Array(offRes.rgba);
        const tamperPixels = Math.ceil(W * H * 0.002);
        for (let i = 0; i < tamperPixels; i++) {
          tampered[i * 4] = tampered[i * 4] <= 240 ? tampered[i * 4] + 12 : tampered[i * 4] - 12;
        }
        const negParity = compareHostFrames(pageRgba, tampered, { width: W, height: H });
        assert.equal(negParity.ok, false, '真实对拍帧注入 >0.1% 像素偏移后必须被检出失败');
      }
    } finally {
      await pageSession.close();
      await offscreenSession.close();
    }
  } finally {
    await offscreenSource.stop();
    await pageSource.stop();
    await rm(workspace, { recursive: true, force: true });
  }
});
