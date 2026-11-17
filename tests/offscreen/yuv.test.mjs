// GPU 侧 RGBA8 → 有限范围 BT.709 yuv420p 打包器与编码链路的单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rgbaToYuv420pCpu } from '../../engine/offscreen/yuv.mjs';
import { loadGpu } from '../../engine/offscreen/load.mjs';
import { createHost } from '../../engine/offscreen/host.mjs';
import { renderFrames } from '../../engine/offscreen/frames.mjs';
import { encoderArgs, startEncoder } from '../../engine/offscreen/encode.mjs';
import { COLOR, FFMPEG, probe } from '../../engine/render/lib/ffmpeg.mjs';

let gpu = null, skipReason = null;
try {
  gpu = await loadGpu();
  const h = await createHost({ gpu, width: 32, height: 32, fps: 24 });
  h.dispose();
} catch (e) {
  skipReason = e.message;
}

function ffmpegSwscaleYuv(rgba, w, h) {
  const r = spawnSync(FFMPEG(), [
    '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', '-',
    '-vf', COLOR.png, '-f', 'rawvideo', '-',
  ], { input: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength) });
  if (r.error || r.status !== 0) return null;
  return new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength);
}

function maxDiffAndPsnr(a, b) {
  assert.equal(a.length, b.length);
  let maxD = 0, sse = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxD) maxD = d;
    sse += d * d;
  }
  const psnr = sse === 0 ? Infinity : 10 * Math.log10((255 * 255 * a.length) / sse);
  return { maxD, psnr };
}

test('rgbaToYuv420pCpu：黑、白、中性灰、红绿蓝主色精确落在 BT.709 有限范围，与 FFmpeg swscale 最大差 ≤ 1', t => {
  const W = 16, H = 16, rgba = new Uint8Array(W * H * 4);
  const palette = [
    [0, 0, 0], [255, 255, 255], [128, 128, 128], [255, 0, 0],
    [0, 255, 0], [0, 0, 255], [217, 209, 190], [42, 88, 156],
  ];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = palette[((y >> 1) * 8 + (x >> 1)) % palette.length];
      const i = (y * W + x) * 4;
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
  }
  const yuv = rgbaToYuv420pCpu(rgba, W, H);
  assert.equal(yuv.length, W * H * 1.5);
  // 黑(0,0)->Y=16,U=128,V=128；白(2,0)->Y=235,U=128,V=128；中性灰(4,0)->Y=126,U=128,V=128
  assert.equal(yuv[0], 16);
  assert.equal(yuv[2], 235);
  assert.equal(yuv[4], 126);
  const uOff = W * H, vOff = uOff + (W / 2) * (H / 2);
  assert.equal(yuv[uOff], 128);
  assert.equal(yuv[vOff], 128);

  const ref = ffmpegSwscaleYuv(rgba, W, H);
  if (!ref) return t.skip('没有可用的 FFmpeg');
  const { maxD, psnr } = maxDiffAndPsnr(yuv, ref);
  assert.ok(maxD <= 1, `与 FFmpeg COLOR.png 最大差 ${maxD} 应 ≤ 1（PSNR=${psnr}）`);
});

test('GPU createYuvPacker：常规画幅（64×36）与非 16 整除画幅（18×18）均与 CPU 参考逐字节一致，对 FFmpeg 亮度最大差 ≤ 1、整体 PSNR ≥ 54 dB', { skip: skipReason || false }, async () => {
  const workPath = path.resolve('lab/offscreen/ink.mjs');
  for (const [W, H] of [[64, 36], [18, 18]]) {
    const host = await createHost({ gpu, width: W, height: H, fps: 24 });
    try {
      const work = await host.load(workPath);
      const rgba = await host.renderFrame(work, 7);
      const yuvGpu = await host.renderFrameYuv(work, 7);
      const yuvCpu = rgbaToYuv420pCpu(rgba, W, H);
      assert.equal(yuvGpu.length, (W * H * 3) / 2);
      assert.deepEqual(yuvGpu, yuvCpu, `${W}×${H} GPU YUV 应与 CPU 公式逐字节相同`);
      const ref = ffmpegSwscaleYuv(rgba, W, H);
      if (ref) {
        const yStat = maxDiffAndPsnr(yuvGpu.subarray(0, W * H), ref.subarray(0, W * H));
        const allStat = maxDiffAndPsnr(yuvGpu, ref);
        // 亮度 Y 为逐像素定点换算，与 swscale 最大差 ≤ 1；色度 U/V 为 2×2 盒式均值（swscale 默认多抽头双三次），锐利墨线边缘差 ≤ 6、PSNR ≥ 50 dB（常规画幅 ≥ 54 dB）
        assert.ok(yStat.maxD <= 1, `${W}×${H} 亮度 Y maxD=${yStat.maxD} 应 ≤ 1`);
        const minPsnr = W >= 64 ? 54 : 50;
        assert.ok(allStat.maxD <= 6 && allStat.psnr >= minPsnr, `${W}×${H} 对 FFmpeg swscale maxD=${allStat.maxD} psnr=${allStat.psnr.toFixed(2)}`);
      }
    } finally {
      host.dispose();
    }
  }
});

test('renderFrames format=yuv420p：inflight=1 与 inflight=4 流水线读回逐字节一致', { skip: skipReason || false }, async () => {
  const workPath = path.resolve('lab/offscreen/ink.mjs');
  const run = async inflight => {
    const host = await createHost({ gpu, width: 64, height: 36, fps: 24 });
    try {
      const work = await host.load(workPath);
      const out = [];
      await renderFrames({ host, work, from: 0, to: 8, inflight, format: 'yuv420p', onFrame: (f, px) => { out[f] = px; } });
      return out;
    } finally {
      host.dispose();
    }
  };
  const a = await run(1);
  const b = await run(4);
  assert.equal(a.length, 8);
  for (let f = 0; f < 8; f++) assert.deepEqual(b[f], a[f], `第 ${f} 帧 inflight=4 与 inflight=1 不同`);
});

test('encode.mjs pixFmt=yuv420p：参数免除 swscale 缩放、写出完整 BT.709 tv 标记，成片与 rgba 路径高度一致', { skip: skipReason || false }, async t => {
  const args = encoderArgs({ width: 64, height: 36, fps: 24, out: 'x.mp4', pixFmt: 'yuv420p' });
  assert.ok(args.includes('yuv420p'));
  const vfIdx = args.indexOf('-vf');
  assert.ok(vfIdx >= 0 && !args[vfIdx + 1].includes('scale='), 'yuv420p 直通不应再跑 CPU swscale');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-yuv-enc-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const mp4Rgba = path.join(tmp, 'rgba.mp4');
  const mp4Yuv = path.join(tmp, 'yuv.mp4');
  const host = await createHost({ gpu, width: 96, height: 64, fps: 24 });
  try {
    const work = await host.load(path.resolve('lab/offscreen/ink.mjs'));
    const encR = startEncoder({ width: 96, height: 64, fps: 24, out: mp4Rgba, pixFmt: 'rgba', crf: 10 });
    const encY = startEncoder({ width: 96, height: 64, fps: 24, out: mp4Yuv, pixFmt: 'yuv420p', crf: 10 });
    await renderFrames({ host, work, from: 0, to: 12, inflight: 3, format: 'rgba', onFrame: (_f, px) => encR.write(px) });
    await encR.finish();
    await renderFrames({ host, work, from: 0, to: 12, inflight: 3, format: 'yuv420p', onFrame: (_f, px) => encY.write(px) });
    await encY.finish();
  } finally {
    host.dispose();
  }
  const p = await probe(mp4Yuv);
  assert.equal(p.video.frames, 12);
  assert.equal(p.video.pixFmt, 'yuv420p');
  assert.deepEqual(p.video.color, { range: 'tv', space: 'bt709', primaries: 'bt709', transfer: 'bt709' });
});
