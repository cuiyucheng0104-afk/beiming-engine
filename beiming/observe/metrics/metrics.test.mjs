import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layoutEdges, pixelBbox, colorPalette, motionZoomPan, loopClosurePsnr,
  deliverSpec, audioLoudness, blackFreezeDup, cutYdif, cutScene } from './index.mjs';

function frame(width, height, pixel) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([...pixel(x, y), 255], (y * width + x) * 4);
  return { width, height, rgba };
}
const red = [255, 0, 0], white = [255, 255, 255], black = [0, 0, 0];

test('矩形与分隔线按像素报色差和偏移', () => {
  const sample = frame(8, 4, x => x === 3 ? white : x < 3 ? red : black);
  const region = { x: 0, y: 0, width: 3, height: 4, color: red };
  const line = { axis: 'x', position: 3, color: white };
  const exact = layoutEdges(sample, { regions: [region], lines: [line] });
  assert.equal(exact.value, 0);
  assert.equal(exact.details.lines[0].offset, 0);
  assert.equal(exact.details.regions[0].maxError, 0);
  const wrong = layoutEdges(sample, { regions: [{ ...region, width: 4 }], lines: [{ ...line, position: 2 }] });
  assert.equal(wrong.value, 8);
  assert.equal(wrong.details.lines[0].offset, 1);
  assert.equal(wrong.details.regions[0].maxError, 255);
});

test('包围盒、占比与色板取显示空间合成图的已知值', () => {
  const sample = frame(8, 4, (x, y) => x >= 1 && x < 5 && y >= 2 ? red : black);
  const box = pixelBbox(sample, black, 2);
  assert.deepEqual(box.value, [1, 2, 4, 2]);
  assert.deepEqual(box.details.normalized, [1 / 8, 1 / 2, 1 / 2, 1 / 2]);
  assert.equal(box.details.areaFraction, 0.25);
  assert.equal(box.details.pixelFraction, 0.25);
  assert.deepEqual(pixelBbox(sample, black, 255).value, [0, 0, 0, 0]);
  const palette = colorPalette(sample, 2);
  assert.equal(palette.value, 0);
  assert.deepEqual(palette.details.palette, [{ rgb: black, share: 0.75 }, { rgb: red, share: 0.25 }]);
  assert.ok(Math.abs(colorPalette(sample, 1).value - 50.4114 / 4) < 0.001);
});

test('联合估计居中缩放、整像素平移及静止漂移', () => {
  const w = 32, h = 28, cx = (w - 1) / 2, cy = (h - 1) / 2;
  const a = Uint8Array.from({ length: w * h }, (_, i) => (i * 137 + (i % w) ** 2 * 13) % 251);
  const b = Uint8Array.from(a, (_, i) => {
    const x = Math.round((i % w - cx - 2) / 1.1 + cx);
    const y = Math.round((Math.floor(i / w) - cy + 1) / 1.1 + cy);
    return x < 0 || x >= w || y < 0 || y >= h ? 0 : a[y * w + x];
  });
  assert.deepEqual(motionZoomPan(a, b, w, h).value, { scale: 1.1, dx: 2, dy: -1 });
  const still = motionZoomPan(a, a, w, h);
  assert.deepEqual(still.value, { scale: 1, dx: 0, dy: 0 });
  assert.equal(still.details.driftPx, 0);
});

test('闭合与相邻帧 PSNR 以 RGB 三个显示分量计算', () => {
  const first = frame(4, 2, () => black), second = frame(4, 2, () => white);
  const result = loopClosurePsnr(first, first, second);
  assert.equal(result.value, Infinity);
  assert.equal(result.details.adjacentPsnr, 0);
  assert.ok(Math.abs(loopClosurePsnr(first, frame(4, 2, () => [1, 1, 1]), second).value - 48.1308) < 0.0001);
});

test('两秒合成 MP4 的规格、响度、冻结和切点', async t => {
  if (['ffmpeg', 'ffprobe'].some(tool => spawnSync(tool, ['-version']).error?.code === 'ENOENT')) return t.skip('环境缺少音视频工具');
  const dir = mkdtempSync(join(tmpdir(), 'observe-'));
  try {
    const file = join(dir, 'sample.mp4');
    const build = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x48:r=10:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=2', '-vf',
      "drawbox=y=24:w=iw:h=24:color=white:t=fill:enable='between(n,5,14)',drawbox=y=24:w=iw:h=24:color=gray:t=fill:enable='gte(n,15)',setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
      '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_trc', 'bt709',
      '-color_primaries', 'bt709', '-color_range', 'tv', '-c:a', 'alac', file]);
    assert.equal(build.status, 0, build.stderr.toString());
    const spec = await deliverSpec(file);
    assert.deepEqual(spec.value, { width: 64, height: 48, fps: 10, frames: 20, color_space: 'bt709',
      color_transfer: 'bt709', color_primaries: 'bt709', color_range: 'tv' });
    const audio = await audioLoudness(file);
    assert.ok(Math.abs(audio.value - (-21.1)) <= 0.2, `${audio.value} LUFS`);
    assert.ok(Math.abs(audio.details.truePeakDbtp - (-18.1)) <= 0.1, `${audio.details.truePeakDbtp} dBTP`);
    const stats = await blackFreezeDup(file, { blackLevel: 32, blackPercent: 98, freezeFrames: 5, duplicateDiff: 0 });
    assert.deepEqual(stats.value, { blackFrames: 5, freezeSegments: 3, duplicateFrames: 17 });
    assert.deepEqual(stats.details.black, [0, 1, 2, 3, 4]);
    assert.deepEqual(stats.details.freezes, [[0, 4], [5, 14], [15, 19]]);
    assert.deepEqual(stats.details.duplicates, Array.from({ length: 20 }, (_, i) => i).filter(n => ![0, 5, 15].includes(n)));
    const ydif = await cutYdif(file, 40), scene = await cutScene(file, 0.15);
    assert.deepEqual(ydif.value, [5, 15]); assert.deepEqual(scene.value, [5, 15]);
    assert.deepEqual((await cutYdif(file, 40, { x: 0, y: 0, width: 64, height: 24 })).value, []);
    t.diagnostic(JSON.stringify({ spec: spec.value, lufs: audio.value, dbtp: audio.details.truePeakDbtp,
      ...stats.value, freezes: stats.details.freezes, ydif: ydif.value, scene: scene.value }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(existsSync(dir), false);
});

test('工具缺失返回统一量测结构', async () => {
  const original = process.env.PATH;
  try {
    process.env.PATH = '';
    for (const [fn, tool] of [[deliverSpec, 'ffprobe'], [audioLoudness, 'ffmpeg'], [cutScene, 'ffmpeg']]) {
      const result = await fn('missing.mp4');
      assert.equal(result.metric, `metric:${fn.name}`);
      assert.deepEqual(result.details, { code: 'tool-missing', tool });
      assert.equal(result.value, null);
    }
  } finally { process.env.PATH = original; }
});
