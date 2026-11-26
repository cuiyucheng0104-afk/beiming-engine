import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ffmpegBins } from '../../../tools/env/lib/ffmpeg.mjs';
import { colorCountEvent, detectColorCountEvents } from './color-count-event.mjs';

test('color.count-event applies strict thresholds and returns the first frame of each run', () => {
  const coverage = [0.02, 1, 0, 0.5, 0.1, 0.2, 1, 1, 0, 0, 1, 0, 0];
  assert.deepEqual(detectColorCountEvents(coverage), {
    metric: 'metric:color.count-event', value: [5, 8, 12], unit: 'frames',
    details: { coveragePercent: coverage, lastAboveThresholdFrame: 10 },
  });
  assert.deepEqual(detectColorCountEvents([0, 1, 1, 1]).value, []);
  assert.equal(detectColorCountEvents([0.02, 0.02]).details.lastAboveThresholdFrame, null);
  assert.deepEqual(detectColorCountEvents([80, 60, 60], { lagFrames: 1, dropRatio: 0.8 }).value, [1]);
});

test('color.count-event rejects invalid measurements and parameters', async () => {
  const bad = { code: 'usage.bad-argument' };
  for (const coverage of [[], [NaN], [Infinity], [-1], [101], ['0'], Array(1)]) {
    assert.throws(() => detectColorCountEvents(coverage), bad);
  }
  for (const opts of [null, { lagFrames: 0 }, { dropRatio: '0.5' }, { minCoveragePercent: -1 }, { foo: 1 }]) {
    assert.throws(() => detectColorCountEvents([0], opts), bad);
  }
  for (const opts of [null, {}, { color: [2, 5, 256] }, { color: '#0011aa', similarity: 0 },
    { color: '#0011aa', roi: { x: -1, y: 0, width: 2, height: 2 } }, { color: '#0011aa', exclude: [] },
    { color: '#0011aa', roi: { x: 0n, y: 0, width: 2, height: 2 } }]) {
    await assert.rejects(colorCountEvent('fixture.mkv', opts), bad);
  }
  await assert.rejects(colorCountEvent('', { color: '#0011aa' }), bad);
});

const ffmpeg = ffmpegBins().ffmpeg;
const hasFfmpeg = spawnSync(ffmpeg, ['-version']).status === 0;
const roi = { x: 1, y: 1, width: 3, height: 3 };
const exclude = { x: 2, y: 2, width: 1, height: 1 };
const color = '#f09800';

test('color.count-event reads original VFR frame indices, odd ROI, and a watermark exclusion', { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'color-count-event-'));
  try {
    const width = 7, height = 5, frames = 7;
    const raw = Buffer.alloc(width * height * frames * 4, 255);
    for (let frame = 0; frame < frames; frame++) {
      // A half-transparent target still matches by RGB.
      for (const [x, y] of [[0, 0], [2, 2], ...(frame < 2 ? [[1, 1]] : [])]) {
        raw.set([240, 152, 0, 128], (frame * width * height + y * width + x) * 4);
      }
    }
    const video = join(dir, 'vfr.mkv');
    const encoded = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgba',
      '-video_size', `${width}x${height}`, '-framerate', '24', '-i', '-',
      '-vf', "setpts='if(lt(N,3),N,N+12)'", '-fps_mode', 'passthrough', '-c:v', 'ffv1', '-pix_fmt', 'bgra', video], { input: raw });
    assert.equal(encoded.status, 0, encoded.stderr.toString());
    const noMask = await colorCountEvent(video, { color, roi });
    assert.deepEqual(noMask.value, []);
    assert.deepEqual(noMask.details.coveragePercent, [2, 2, 1, 1, 1, 1, 1].map(count => count / 9 * 100));
    const masked = await colorCountEvent(video, { color, roi, exclude });
    assert.deepEqual(masked.value, [2]);
    assert.deepEqual(masked.details.coveragePercent, [1, 1, 0, 0, 0, 0, 0].map(count => count / 9 * 100));
    assert.equal(masked.details.lastAboveThresholdFrame, 1);
    assert.deepEqual(masked.details.displaySize, [width, height]);
    await assert.rejects(colorCountEvent(video, { color, roi: { ...roi, x: 5 } }), { code: 'usage.bad-argument' });
    await assert.rejects(colorCountEvent(video, { color, roi, exclude: { ...exclude, x: 4 } }), { code: 'usage.bad-argument' });
    const corrupt = join(dir, 'corrupt.mkv');
    writeFileSync(corrupt, 'This is not a video.');
    await assert.rejects(colorCountEvent(corrupt, { color }), /ffmpeg/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('color.count-event applies coordinates in the autorotated display', { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'color-count-event-rotation-'));
  try {
    const original = join(dir, 'original.mp4'), rotated = join(dir, 'rotated.mp4');
    const raw = Buffer.from(Array.from({ length: 8 * 6 }, (_, i) => i % 8 < 4 ? 255 : 0));
    const encoded = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'rawvideo', '-pixel_format', 'gray',
      '-video_size', '8x6', '-i', '-', '-c:v', 'libx264', '-crf', '0', '-pix_fmt', 'yuv420p', original], { input: raw });
    assert.equal(encoded.status, 0, encoded.stderr.toString());
    const tagged = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-display_rotation', '90', '-i', original,
      '-c', 'copy', rotated]);
    assert.equal(tagged.status, 0, tagged.stderr.toString());
    const region = { x: 1, y: 5, width: 3, height: 3 };
    const bottom = await colorCountEvent(rotated, { color: '#ffffff', roi: region });
    assert.deepEqual(bottom.details.displaySize, [6, 8]);
    assert.deepEqual(bottom.details.coveragePercent, [100]);
    const top = await colorCountEvent(rotated, { color: '#ffffff', roi: { ...region, y: 0 } });
    assert.deepEqual(top.details.coveragePercent, [0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('color.count-event distinguishes a missing FFmpeg binary from zero events', async () => {
  const previous = process.env.FFMPEG;
  process.env.FFMPEG = join(tmpdir(), 'color-count-event-missing-ffmpeg');
  try {
    assert.deepEqual(await colorCountEvent('fixture.mkv', { color }), {
      metric: 'metric:color.count-event', value: null, unit: 'frames',
      details: { code: 'tool-missing', tool: 'ffmpeg' },
    });
  } finally {
    if (previous === undefined) delete process.env.FFMPEG;
    else process.env.FFMPEG = previous;
  }
});
