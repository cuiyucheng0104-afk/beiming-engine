import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { videoAliasEdge, videoNoiseResidual } from './index.mjs';
import { videoAliasEdge as rootVideoAliasEdge, videoNoiseResidual as rootVideoNoiseResidual } from '../index.mjs';

const hasMediaTools = !['ffmpeg', 'ffprobe'].some((tool) => spawnSync(tool, ['-version']).error?.code === 'ENOENT');

function encodeRawGray(filePath, width, height, frames, { fps = 24, crf = 16 } = {}) {
  const buf = Buffer.alloc(frames.length * width * height);
  for (let t = 0; t < frames.length; t++) buf.set(frames[t], t * width * height);
  const res = spawnSync('ffmpeg', [
    '-nostdin', '-hide_banner', '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0',
    '-c:v', 'libx264', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709', '-color_range', 'tv',
    filePath,
  ], { input: buf });
  assert.equal(res.status, 0, res.stderr.toString());
}

function makeObliqueEdgeFrame(width, height, samples, { slope = 0.23, offsetX = 0 } = {}) {
  const out = new Uint8Array(width * height);
  const cx = width * 0.5 + offsetX;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          const edge = cx + (py - height * 0.5) * slope;
          acc += px >= edge ? 1 : 0;
        }
      }
      const coverage = acc / (samples * samples);
      out[y * width + x] = Math.round(28 + coverage * 204);
    }
  }
  return out;
}

function deterministicNoiseFrame(width, height, frameIdx, amplitude, base = 128) {
  const out = new Uint8Array(width * height);
  let state = (frameIdx + 1) * 0x9e3779b1 >>> 0;
  for (let i = 0; i < out.length; i++) {
    state = (Math.imul(state ^ (i * 2654435761), 1664525) + 1013904223) >>> 0;
    const u1 = ((state >>> 8) & 0xffff) / 65536 - 0.5;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const u2 = ((state >>> 8) & 0xffff) / 65536 - 0.5;
    const delta = Math.round((u1 + u2) * amplitude * Math.sqrt(6));
    out[i] = Math.max(0, Math.min(255, base + delta));
  }
  return out;
}

test('observe 导出：videoNoiseResidual 与 videoAliasEdge 从 metrics 与顶层统一出口一致导出', () => {
  assert.equal(typeof videoNoiseResidual, 'function');
  assert.equal(typeof videoAliasEdge, 'function');
  assert.equal(videoNoiseResidual, rootVideoNoiseResidual);
  assert.equal(videoAliasEdge, rootVideoAliasEdge);
});

test('参数校验：非法文件路径、未知选项与越界 maxFrames 抛 usage.bad-argument', async () => {
  const badArg = (err) => err instanceof RangeError && err.code === 'usage.bad-argument';
  for (const fn of [videoNoiseResidual, videoAliasEdge]) {
    assert.throws(() => fn(''), badArg);
    assert.throws(() => fn(123), badArg);
    assert.throws(() => fn('a.mp4', null), badArg);
    assert.throws(() => fn('a.mp4', []), badArg);
    assert.throws(() => fn('a.mp4', { nope: 1 }), badArg);
    assert.throws(() => fn('a.mp4', { maxFrames: 8 }), badArg);
    assert.throws(() => fn('a.mp4', { maxFrames: 12.5 }), badArg);
    assert.throws(() => fn('a.mp4', { maxFrames: NaN }), badArg);
  }
});

test('工具缺失：缺少 ffprobe/ffmpeg 时按 video-audio.mjs 同口径返回 tool-missing', async () => {
  const original = process.env.PATH;
  try {
    process.env.PATH = '';
    const noise = await videoNoiseResidual('missing.mp4');
    assert.equal(noise.metric, 'metric:noise.residual');
    assert.equal(noise.unit, 'code8');
    assert.equal(noise.value, null);
    assert.deepEqual(noise.details, { code: 'tool-missing', tool: 'ffprobe' });

    const alias = await videoAliasEdge('missing.mp4');
    assert.equal(alias.metric, 'metric:alias.edge');
    assert.equal(alias.unit, 'px');
    assert.equal(alias.value, null);
    assert.deepEqual(alias.details, { code: 'tool-missing', tool: 'ffprobe' });
  } finally {
    process.env.PATH = original;
  }
});

test('合成 MP4：静止干净片、加噪片（alls=8/16）、抗锯齿斜边与 1x 点采样锯齿斜边、纯色片与单帧片', { skip: !hasMediaTools && '环境缺少音视频工具' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-energy-'));
  try {
    const cleanFile = join(dir, 'clean.mp4');
    const noisy8File = join(dir, 'noisy8.mp4');
    const noisy16File = join(dir, 'noisy16.mp4');
    const smoothEdgeFile = join(dir, 'smooth-edge.mp4');
    const aliasedEdgeFile = join(dir, 'aliased-edge.mp4');
    const flickerEdgeFile = join(dir, 'flicker-edge.mp4');
    const flatFile = join(dir, 'flat.mp4');
    const singleFile = join(dir, 'single.mp4');
    const cutFlashFile = join(dir, 'flash.mp4');

    const W = 128, H = 96;
    const flatGray = new Uint8Array(W * H).fill(128);
    encodeRawGray(cleanFile, W, H, Array.from({ length: 8 }, () => flatGray));

    const runLavfi = (out, filter) => {
      const r = spawnSync('ffmpeg', [
        '-nostdin', '-hide_banner', '-v', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=gray:s=${W}x${H}:r=24:d=0.5`,
        '-vf', filter,
        '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p',
        '-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709', '-color_range', 'tv',
        out,
      ]);
      assert.equal(r.status, 0, r.stderr.toString());
    };
    runLavfi(noisy8File, 'noise=alls=8:allf=t');
    runLavfi(noisy16File, 'noise=alls=16:allf=t');

    const cleanNoise = await videoNoiseResidual(cleanFile);
    const noisy8 = await videoNoiseResidual(noisy8File);
    const noisy16 = await videoNoiseResidual(noisy16File);

    assert.equal(cleanNoise.metric, 'metric:noise.residual');
    assert.equal(cleanNoise.unit, 'code8');
    assert.equal(cleanNoise.details.status, 'ok');
    assert.equal(cleanNoise.details.sampledFrames, 8);
    assert.equal(cleanNoise.details.totalFrames, 8);
    assert.ok(cleanNoise.value < 0.5, `clean noise=${cleanNoise.value}`);
    assert.ok(cleanNoise.details.staticRatio > 0.9);

    assert.equal(noisy8.details.status, 'ok');
    assert.ok(noisy8.value > 3.5, `noisy8=${noisy8.value}`);
    assert.ok(noisy16.value > noisy8.value, `noisy16=${noisy16.value} should exceed noisy8=${noisy8.value}`);

    // 同一文件重复调用结果逐位一致
    assert.deepStrictEqual(await videoNoiseResidual(noisy8File), noisy8);

    // 抗锯齿斜边 vs 1x 点采样斜边
    const smoothFrame = makeObliqueEdgeFrame(W, H, 8);
    const aliasedFrame = makeObliqueEdgeFrame(W, H, 1);
    encodeRawGray(smoothEdgeFile, W, H, Array.from({ length: 6 }, () => smoothFrame));
    encodeRawGray(aliasedEdgeFile, W, H, Array.from({ length: 6 }, () => aliasedFrame));
    encodeRawGray(flickerEdgeFile, W, H, [0, 0.5, 0, 0.5, 0, 0.5].map((dx) => makeObliqueEdgeFrame(W, H, 1, { offsetX: dx })));

    const smoothAlias = await videoAliasEdge(smoothEdgeFile);
    const hardAlias = await videoAliasEdge(aliasedEdgeFile);
    const flickAlias = await videoAliasEdge(flickerEdgeFile);

    assert.equal(smoothAlias.metric, 'metric:alias.edge');
    assert.equal(smoothAlias.unit, 'px');
    assert.equal(smoothAlias.details.status, 'ok');
    assert.equal(smoothAlias.details.flickerUnit, 'code8');
    assert.equal(smoothAlias.details.flicker, 0);
    assert.ok(smoothAlias.value < 0.12, `smoothAlias=${smoothAlias.value}`);

    assert.equal(hardAlias.details.status, 'ok');
    assert.ok(hardAlias.value > 0.3, `hardAlias=${hardAlias.value}`);
    assert.ok(hardAlias.value > 3 * smoothAlias.value, `hard=${hardAlias.value} vs smooth=${smoothAlias.value}`);
    assert.ok(hardAlias.details.edgePixels > 0);

    assert.ok(flickAlias.details.flicker > 1, `flicker=${flickAlias.details.flicker}`);
    assert.deepStrictEqual(await videoAliasEdge(hardAlias ? aliasedEdgeFile : smoothEdgeFile), hardAlias);

    // 纯色无边缘片
    encodeRawGray(flatFile, W, H, Array.from({ length: 4 }, () => flatGray));
    const flatAlias = await videoAliasEdge(flatFile);
    assert.equal(flatAlias.value, 0);
    assert.equal(flatAlias.details.status, 'no-edges');
    assert.equal(flatAlias.details.edgePixels, 0);

    // 单帧视频不炸
    encodeRawGray(singleFile, W, H, [aliasedFrame]);
    const singleNoise = await videoNoiseResidual(singleFile);
    assert.equal(singleNoise.value, null);
    assert.equal(singleNoise.details.status, 'insufficient-frames');
    assert.equal(singleNoise.details.totalFrames, 1);

    const singleAlias = await videoAliasEdge(singleFile);
    assert.equal(singleAlias.details.status, 'ok');
    assert.equal(singleAlias.details.flicker, null);
    assert.equal(singleAlias.details.sampledFrames, 1);

    // 全幅逐帧剧烈跳变：无静止区
    encodeRawGray(cutFlashFile, W, H, [40, 210, 40, 210].map((v) => new Uint8Array(W * H).fill(v)));
    const flashNoise = await videoNoiseResidual(cutFlashFile);
    assert.equal(flashNoise.value, null);
    assert.equal(flashNoise.details.status, 'no-static-region');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(existsSync(dir), false);
});

test('长片三段窗口采样：超过 maxFrames 时首/中/尾各取连续段并取最差值与最大闪烁', { skip: !hasMediaTools && '环境缺少音视频工具' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-energy-win-'));
  try {
    const W = 96, H = 64;
    const total = 30;
    const maxFrames = 9; // 三段各 3 帧：[0,3), [13,16), [27,30)

    // 中段 [13,16) 注入噪点，其余段静止平场
    const midNoisyFrames = Array.from({ length: total }, (_, t) => (
      t >= 13 && t < 16 ? deterministicNoiseFrame(W, H, t, 14) : new Uint8Array(W * H).fill(128)
    ));
    const midNoisyFile = join(dir, 'mid-noisy.mp4');
    encodeRawGray(midNoisyFile, W, H, midNoisyFrames);

    const noise = await videoNoiseResidual(midNoisyFile, { maxFrames });
    assert.equal(noise.details.totalFrames, total);
    assert.equal(noise.details.sampledFrames, 9);
    assert.equal(noise.details.segments.length, 3);
    assert.deepEqual(
      noise.details.segments.map((s) => [s.start, s.end]),
      [[0, 3], [13, 16], [27, 30]],
    );
    assert.ok(noise.details.segments[0].value < 0.5);
    assert.ok(noise.details.segments[1].value > 4);
    assert.ok(noise.details.segments[2].value < 0.5);
    assert.equal(noise.value, noise.details.segments[1].value);

    // 尾段 [27,30) 注入 1x 锯齿 + 闪烁，其余段平滑抗锯齿
    const smooth = makeObliqueEdgeFrame(W, H, 8);
    const tailAliasFrames = Array.from({ length: total }, (_, t) => (
      t >= 27 ? makeObliqueEdgeFrame(W, H, 1, { offsetX: (t % 2) * 0.5 }) : smooth
    ));
    const tailAliasFile = join(dir, 'tail-alias.mp4');
    encodeRawGray(tailAliasFile, W, H, tailAliasFrames);

    const alias = await videoAliasEdge(tailAliasFile, { maxFrames });
    assert.equal(alias.details.totalFrames, total);
    assert.equal(alias.details.sampledFrames, 9);
    assert.equal(alias.details.segments.length, 3);
    assert.deepEqual(
      alias.details.segments.map((s) => [s.start, s.end]),
      [[0, 3], [13, 16], [27, 30]],
    );
    assert.ok(alias.details.segments[0].value < 0.12);
    assert.ok(alias.details.segments[2].value > 0.3);
    assert.equal(alias.value, alias.details.segments[2].value);
    assert.ok(alias.details.flicker > 1);
    assert.equal(alias.details.flicker, alias.details.segments[2].flicker);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('工具缺失（仅缺 ffmpeg）与 roi 透传校验', { skip: !hasMediaTools && '环境缺少音视频工具' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-energy-edge-'));
  const originalPath = process.env.PATH;
  try {
    const W = 64, H = 48;
    const clip = join(dir, 'clip.mp4');
    const edgeFrame = makeObliqueEdgeFrame(W, H, 1);
    encodeRawGray(clip, W, H, [edgeFrame, edgeFrame, edgeFrame]);

    // 合法 roi 透传：避开斜边的平坦左半区应判 no-edges
    const leftOnly = await videoAliasEdge(clip, { roi: { x: 0, y: 0, width: 20, height: H } });
    assert.equal(leftOnly.details.status, 'no-edges');
    assert.equal(leftOnly.value, 0);

    // 越界 roi 透传能量尺子的 usage.bad-argument 错误
    await assert.rejects(
      () => videoNoiseResidual(clip, { roi: { x: 0, y: 0, width: W + 1, height: H } }),
      (err) => err instanceof RangeError && err.code === 'usage.bad-argument',
    );

    // 仅保留 ffprobe、缺少 ffmpeg 时返回 tool: 'ffmpeg'
    const ffprobePath = spawnSync('which', ['ffprobe'], { encoding: 'utf8' }).stdout.trim();
    if (ffprobePath && existsSync(ffprobePath)) {
      const binDir = join(dir, 'bin');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(binDir, { recursive: true });
      symlinkSync(ffprobePath, join(binDir, 'ffprobe'));
      process.env.PATH = binDir;
      const noise = await videoNoiseResidual(clip);
      assert.equal(noise.value, null);
      assert.deepEqual(noise.details, { code: 'tool-missing', tool: 'ffmpeg' });
      const alias = await videoAliasEdge(clip);
      assert.equal(alias.value, null);
      assert.deepEqual(alias.details, { code: 'tool-missing', tool: 'ffmpeg' });
    }
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R1 回归：VFR 保留原始帧数与尾部斜边、90° 旋转元数据对齐烘焙旋转、ROI edgeRatio 按 ROI 面积计、6x64 小画幅默认 block 自适应', { skip: !hasMediaTools && '环境缺少音视频工具' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-energy-r1-'));
  const ff = (args, input) => {
    const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], { input });
    assert.equal(r.status, 0, String(r.stderr));
  };
  try {
    const w = 128, h = 64;
    const plane = Buffer.alloc(w * h);
    const flat = Buffer.alloc(w * h, 24);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) plane[y * w + x] = x >= 45 + y * 0.32 ? 224 : 24;
    }
    const source = join(dir, 'edge.mp4');
    const rot = join(dir, 'rot.mp4');
    const baked = join(dir, 'baked.mkv');
    const vfr = join(dir, 'vfr.mp4');
    const tail = join(dir, 'tail.mp4');
    const small = join(dir, 'small.mp4');
    const tiny = join(dir, 'tiny.mp4');

    ff(['-f', 'rawvideo', '-pixel_format', 'gray', '-video_size', `${w}x${h}`, '-framerate', '24', '-i', 'pipe:0', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', source], Buffer.concat(Array(12).fill(plane)));
    ff(['-display_rotation', '90', '-i', source, '-c', 'copy', rot]);
    ff(['-i', rot, '-map', '0:v:0', '-c:v', 'ffv1', baked]);
    ff(['-i', source, '-vf', "setpts='if(lt(N,6),N,N+12)/(24*TB)'", '-fps_mode', 'vfr', '-c:v', 'libx264', vfr]);
    ff(['-f', 'rawvideo', '-pixel_format', 'gray', '-video_size', `${w}x${h}`, '-framerate', '24', '-i', 'pipe:0', '-vf', "setpts='if(lt(N,6),N,N+12)/(24*TB)'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', tail], Buffer.concat([...Array(6).fill(flat), ...Array(6).fill(plane)]));
    ff(['-f', 'lavfi', '-i', 'color=gray:s=6x64:r=24', '-frames:v', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', small]);
    ff(['-f', 'lavfi', '-i', 'color=gray:s=2x64:r=24', '-frames:v', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', tiny]);

    // 1. ROI edgeRatio 按 ROI 面积而非整帧面积计算
    const roi = { x: 24, y: 0, width: 64, height: 64 };
    const roiRes = await videoAliasEdge(source, { roi });
    assert.ok(roiRes.details.edgePixels > 0);
    assert.equal(roiRes.details.edgeRatio, roiRes.details.edgePixels / (roi.width * roi.height * roiRes.details.sampledFrames));

    // 2. 90° 旋转元数据：解码显示尺寸为 64x128，与无损烘焙旋转读数逐位相等
    const tagged = await videoAliasEdge(rot);
    const bakedRes = await videoAliasEdge(baked);
    assert.equal(tagged.details.width, 64);
    assert.equal(tagged.details.height, 128);
    assert.equal(tagged.value, bakedRes.value);
    assert.ok(tagged.value > 0.6);

    // 3. VFR 12 帧短片不重复帧且尾部 6 帧斜边不丢失
    const vfrRes = await videoAliasEdge(vfr);
    assert.equal(vfrRes.details.totalFrames, 12);
    const tailRes = await videoAliasEdge(tail);
    assert.equal(tailRes.details.totalFrames, 12);
    assert.equal(tailRes.details.status, 'ok');

    // 4. 6x64 小画幅默认 block 自适应为 6 正常得 ok；短边 <4 的 2x64 返回结构化 insufficient-resolution
    const smallRes = await videoNoiseResidual(small);
    assert.equal(smallRes.details.status, 'ok');
    assert.equal(smallRes.details.block, 6);
    const tinyRes = await videoNoiseResidual(tiny);
    assert.equal(tinyRes.value, null);
    assert.equal(tinyRes.details.status, 'insufficient-resolution');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


