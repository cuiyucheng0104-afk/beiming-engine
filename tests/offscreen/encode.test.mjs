// 离屏出片 · FFmpeg 编码器（engine/offscreen/encode.mjs）：RGBA 裸帧经管道 → 有限范围 BT.709 yuv420p 的 H.264。只要 FFmpeg，不要 GPU。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encoderArgs, startEncoder } from '../../engine/offscreen/encode.mjs';
import { COLOR, TAGS, probe } from '../../engine/render/lib/ffmpeg.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const posix = process.platform !== 'win32';
const tmp = () => mkdtempSync(join(tmpdir(), 'beiming-offscreen-'));
const solid = (w, h, [r, g, b]) => { const buf = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) buf.set([r, g, b, 255], i * 4); return buf; };

test('encoderArgs：RGBA 裸帧输入、页面渲染器同款色彩换算、四项色彩标记、输出在最后', () => {
  const a = encoderArgs({ width: 64, height: 32, fps: 24, out: '/x/o.mp4' });
  const s = a.join(' ');
  assert.match(s, /-f rawvideo -pix_fmt rgba -s 64x32 -framerate 24 -i -/);
  assert.equal(a[a.indexOf('-vf') + 1], COLOR.png);
  assert.ok(s.includes(TAGS.join(' ')));
  assert.match(s, /-c:v libx264 -preset medium -crf 14/);
  assert.equal(a.at(-1), '/x/o.mp4');
});

test('startEncoder：8 帧纯色 → 8 帧 yuv420p、BT.709 有限范围标记齐全、Y 与参考换算相差 ≤ 1', { skip: !hasFfmpeg && '没有 FFmpeg' }, async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'o.mp4'), W = 64, H = 64, rgb = [232, 223, 204];
    const enc = startEncoder({ width: W, height: H, fps: 24, out });
    for (let i = 0; i < 8; i++) await enc.write(solid(W, H, rgb));
    await enc.finish();
    const p = await probe(out);
    assert.equal(p.video.frames, 8);
    assert.equal(p.video.pixFmt, 'yuv420p');
    assert.deepEqual(p.video.color, { range: 'tv', space: 'bt709', primaries: 'bt709', transfer: 'bt709' });
    const y = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'])[0];
    const ref = Math.round(16 + 219 * (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255);
    assert.ok(Math.abs(y - ref) <= 1, `Y=${y}，参考 ${ref}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('startEncoder：FFmpeg 一启动就退出 1 → write / finish 抛错，不挂住，不留输出', { skip: (!posix && '需要 POSIX 可执行脚本'), timeout: 45000 }, async () => {
  const dir = tmp(), prev = process.env.FFMPEG;
  try {
    const fake = join(dir, 'ffmpeg-exit1');
    writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.env.FFMPEG = fake;
    const out = join(dir, 'o.mp4');
    const enc = startEncoder({ width: 64, height: 64, fps: 24, out });
    await assert.rejects((async () => { for (let i = 0; i < 400; i++) await enc.write(solid(64, 64, [0, 0, 0])); await enc.finish(); })(), /FFmpeg/);
    assert.equal(existsSync(out), false);
  } finally {
    if (prev === undefined) delete process.env.FFMPEG; else process.env.FFMPEG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
