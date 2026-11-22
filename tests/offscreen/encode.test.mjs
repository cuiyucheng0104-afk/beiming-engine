// 离屏出片 · FFmpeg 编码器（engine/offscreen/encode.mjs）：RGBA 裸帧经管道 → 有限范围 BT.709 yuv420p 的 H.264。只要 FFmpeg，不要 GPU。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MODE, H264_PROFILE, MASTER_CQ, NVENC_BUFSIZE, NVENC_MAXRATE, PRO_PIX_FMT,
  encoderArgs, nvencArgs, probeNvencAsync, resolveEncode, resolveEncodeAsync, resolveEncoder, startEncoder,
} from '../../engine/offscreen/encode.mjs';
import { COLOR, TAGS, probe } from '../../engine/render/lib/ffmpeg.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const posix = process.platform !== 'win32';
const tmp = () => mkdtempSync(join(tmpdir(), 'beiming-offscreen-'));
const solid = (w, h, [r, g, b]) => { const buf = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) buf.set([r, g, b, 255], i * 4); return buf; };

test('encoderArgs：gop/timescale 缺省不加任何参数（与合入前逐字节同）；显式给才加 -g 与 -video_track_timescale，非法值拒绝', () => {
  const plain = encoderArgs({ width: 64, height: 32, fps: 24, out: '/x/o.mp4' });
  assert.ok(!plain.includes('-g'), '缺省不应有 -g');
  assert.ok(!plain.includes('-video_track_timescale'), '缺省不应有 -video_track_timescale');
  for (const encoder of ['x264', 'nvenc']) {
    const a = encoderArgs({ width: 64, height: 32, fps: 24, out: '/x/o.mp4', encoder, gop: 240, timescale: 12288 });
    assert.equal(a[a.indexOf('-g') + 1], '240', encoder);
    assert.equal(a[a.indexOf('-video_track_timescale') + 1], '12288', encoder);
    assert.equal(a.at(-1), '/x/o.mp4', 'timescale 是混流参数，必须在输出文件之前');
    assert.ok(a.indexOf('-video_track_timescale') < a.length - 1);
  }
  assert.throws(() => encoderArgs({ width: 64, height: 32, fps: 24, out: '/x/o.mp4', gop: 0 }), e => e?.code === 'usage.bad-value');
  assert.throws(() => encoderArgs({ width: 64, height: 32, fps: 24, out: '/x/o.mp4', timescale: 1.5 }), e => e?.code === 'usage.bad-value');
});

test('encoderArgs：RGBA 裸帧输入、页面渲染器同款色彩换算、四项色彩标记、High profile、输出在最后', () => {
  const a = encoderArgs({ width: 64, height: 32, fps: 24, out: '/x/o.mp4' });
  const s = a.join(' ');
  assert.match(s, /-f rawvideo -pix_fmt rgba -s 64x32 -framerate 24 -i -/);
  assert.equal(a[a.indexOf('-vf') + 1], COLOR.png);
  assert.ok(s.includes(TAGS.join(' ')));
  assert.match(s, /-c:v libx264 -preset medium -crf 14/);
  assert.match(s, /-profile:v high/);
  assert.equal(a.at(-1), '/x/o.mp4');
});

test('encoderArgs：--encoder nvenc 换成 h264_nvenc + High + 合规 bufsize；默认仍是 libx264 High', () => {
  const n = encoderArgs({ width: 64, height: 32, fps: 24, out: '/x/o.mp4', encoder: 'nvenc', cq: 20 });
  const s = n.join(' ');
  assert.match(s, /-c:v h264_nvenc -preset p5 -rc vbr -cq 20 -b:v 0 -profile:v high -maxrate 240M -bufsize 240M/);
  assert.ok(!s.includes('libx264'));
  assert.ok(!s.includes('480M'), '旧的 480M bufsize 超了 H.264 High@5.1 MaxCPB');
  assert.equal(n[n.indexOf('-vf') + 1], COLOR.png);
  assert.ok(s.includes(TAGS.join(' ')));
  assert.equal(n.at(-1), '/x/o.mp4');
  assert.match(encoderArgs({ width: 64, height: 32, fps: 24, out: 'o.mp4' }).join(' '), /-c:v libx264/);
});

test('nvencArgs：Fast 档带 -profile:v high 与合规 bufsize；cq 默认 7（远离会出坏流的 6）', () => {
  const a = nvencArgs();
  const s = a.join(' ');
  assert.equal(MASTER_CQ, 7);
  assert.ok(MASTER_CQ > 6, '生产 cq 必须高于作者见过坏流的 cq 6');
  assert.equal(H264_PROFILE, 'high');
  assert.equal(NVENC_MAXRATE, '240M');
  assert.equal(NVENC_BUFSIZE, '240M');
  assert.match(s, /-profile:v high/);
  assert.match(s, /-maxrate 240M/);
  assert.match(s, /-bufsize 240M/);
  assert.ok(!s.includes('480M'));
  assert.match(s, /-cq 7 /);
  const bits = Number.parseFloat(NVENC_BUFSIZE) * 1e6;
  assert.ok(bits <= 300e6, `bufsize ${NVENC_BUFSIZE} 超过 High@5.1 MaxCPB（300000 kbit）`);
  assert.ok(bits <= 240e6, `bufsize ${NVENC_BUFSIZE} 超过表值 MaxCPB 240000 kbit`);
});

test('probeNvencAsync：并发与后续调用复用同一次真实子进程探测，resolveEncodeAsync 保留 Fast 语义', { skip: !posix && '需要 POSIX 可执行脚本' }, async () => {
  const dir = tmp();
  try {
    const count = join(dir, 'count');
    const fake = join(dir, 'ffmpeg-probe');
    writeFileSync(fake, '#!/bin/sh\nprintf x >> "$PROBE_COUNT"\nsleep 0.1\nexit 0\n', { mode: 0o755 });
    process.env.PROBE_COUNT = count;
    const a = probeNvencAsync(fake), b = probeNvencAsync(fake);
    assert.strictEqual(a, b, '并发调用必须复用同一个 in-flight Promise');
    assert.deepEqual(await Promise.all([a, b]), [true, true]);
    assert.equal(readFileSync(count, 'utf8'), 'x', '并发调用起了一个以上子进程');
    assert.equal(await probeNvencAsync(fake), true);
    assert.equal(readFileSync(count, 'utf8'), 'x', '已完成的探测没有命中缓存');
    const picked = await resolveEncodeAsync({ mode: 'fast', width: 1920, height: 1080, probe: () => a });
    assert.deepEqual(picked, { mode: 'fast', encoder: 'nvenc', pixFmt: 'yuv420p', profile: 'high', reason: null });
  } finally {
    delete process.env.PROBE_COUNT;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveEncode：默认 Pro → x264 High + rgba；Fast 无 NVENC 退回 Pro；Fast 参数含 High 与合规 bufsize', () => {
  const yes = () => true, no = () => false, boom = () => { throw new Error('不该探测'); };
  assert.equal(DEFAULT_MODE, 'pro');
  assert.equal(PRO_PIX_FMT, 'rgba');

  const d = resolveEncode({ width: 1920, height: 1080, probe: boom });
  assert.deepEqual(d, { mode: 'pro', encoder: 'x264', pixFmt: 'rgba', profile: 'high', reason: null });

  const autoPro = resolveEncode({ mode: 'pro', encoder: 'auto', width: 1920, height: 1080, probe: yes });
  assert.equal(autoPro.encoder, 'x264');
  assert.equal(autoPro.pixFmt, 'rgba');

  const fastYes = resolveEncode({ mode: 'fast', width: 1920, height: 1080, probe: yes });
  assert.deepEqual(fastYes, { mode: 'fast', encoder: 'nvenc', pixFmt: 'yuv420p', profile: 'high', reason: null });
  const fastArgs = encoderArgs({ width: 1920, height: 1080, fps: 24, out: 'o.mp4', encoder: fastYes.encoder, pixFmt: fastYes.pixFmt });
  assert.match(fastArgs.join(' '), /-profile:v high/);
  assert.match(fastArgs.join(' '), /-bufsize 240M/);
  assert.match(fastArgs.join(' '), /-pix_fmt yuv420p/);

  const noGpu = resolveEncode({ mode: 'fast', width: 1920, height: 1080, probe: no });
  assert.equal(noGpu.mode, 'pro');
  assert.equal(noGpu.encoder, 'x264');
  assert.equal(noGpu.pixFmt, 'rgba', 'Fast 退回 Pro 时未指定的 pixFmt 也回到 rgba');
  assert.match(noGpu.reason, /NVENC/);

  const small = resolveEncode({ mode: 'fast', width: 144, height: 1080, probe: yes });
  assert.equal(small.encoder, 'x264');
  assert.match(small.reason, /145×49/);

  const keepPix = resolveEncode({ mode: 'fast', pixFmt: 'yuv420p', width: 1920, height: 1080, probe: no });
  assert.equal(keepPix.encoder, 'x264');
  assert.equal(keepPix.pixFmt, 'yuv420p', '用户显式指定的 pixFmt 退回时仍保留');

  assert.deepEqual(resolveEncode({ encoder: 'x264', width: 1920, height: 1080, probe: boom }).encoder, 'x264');
  assert.deepEqual(resolveEncode({ encoder: 'nvenc', width: 1920, height: 1080, probe: boom }), {
    mode: 'pro', encoder: 'nvenc', pixFmt: 'yuv420p', profile: 'high', reason: null,
  });
  assert.throws(() => resolveEncode({ encoder: 'av1', probe: boom }), e => e.code === 'usage.bad-value');
  assert.throws(() => resolveEncode({ mode: 'turbo', probe: boom }), e => e.code === 'usage.bad-value');

  const wrapped = resolveEncoder(undefined, { width: 1920, height: 1080, probe: yes });
  assert.equal(wrapped.encoder, 'x264', 'resolveEncoder 默认 mode=pro，auto 不再选 nvenc');
});

test('Fast 对照交付档位：High 档次匹配；Level 5.1 在 web-1080p24 只软告警，master-1080p24 不告警', () => {
  const table = JSON.parse(readFileSync(new URL('../../engine/production/profiles.json', import.meta.url), 'utf8'));
  const web = table.profiles['web-1080p24'].video;
  const master = table.profiles['master-1080p24'].video;
  assert.ok(web.profiles.includes('High'));
  assert.ok(master.profiles.includes('High'));
  assert.equal(web.maxLevel, 4.1);
  assert.equal(master.maxLevel, 5.1);
  const fastLevel = 5.1;
  assert.ok(fastLevel > web.maxLevel, 'Fast NVENC（maxrate 240M）走 High@5.1，对照 web-1080p24 会触发 delivery.codec level 软告警（warn，不阻断）');
  assert.ok(fastLevel <= master.maxLevel, '对照 master-1080p24 不告警');
  assert.ok(web.profiles.some(p => p.toLowerCase() === H264_PROFILE));
});

test('encoderArgs：不认识的编码器直接报用法错误，不悄悄退回 x264', () => {
  assert.throws(() => encoderArgs({ width: 64, height: 32, fps: 24, out: 'o.mp4', encoder: 'av1' }), e => e.code === 'usage.bad-value' && /x264.*nvenc/.test(e.message));
});

// 机器上有没有能用的 NVENC：试编一帧（没有 NVIDIA 驱动时 ffmpeg 里有编码器名也会失败）
const hasNvenc = hasFfmpeg && spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256', '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { stdio: 'ignore' }).status === 0;

test('startEncoder：nvenc 编 8 帧纯色 → 8 帧 yuv420p、BT.709 有限范围标记齐全、High profile、Y 与参考换算相差 ≤ 2', { skip: !hasNvenc && '没有可用的 NVENC（需要 NVIDIA 驱动）' }, async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'n.mp4'), W = 256, H = 256, rgb = [232, 223, 204];
    const enc = startEncoder({ width: W, height: H, fps: 24, out, encoder: 'nvenc' });
    for (let i = 0; i < 8; i++) await enc.write(solid(W, H, rgb));
    await enc.finish();
    const p = await probe(out);
    const tag = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream_tags=encoder', '-of', 'default=nw=1:nk=1', out], { encoding: 'utf8' });
    assert.match(tag, /h264_nvenc/, '成片不是 NVENC 编的');
    assert.equal(p.video.frames, 8);
    assert.equal(p.video.pixFmt, 'yuv420p');
    assert.match(String(p.video.profile), /High/i);
    assert.deepEqual(p.video.color, { range: 'tv', space: 'bt709', primaries: 'bt709', transfer: 'bt709' });
    const y = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'])[0];
    const ref = Math.round(16 + 219 * (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255);
    assert.ok(Math.abs(y - ref) <= 2, `Y=${y}，参考 ${ref}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 平滑渐变 + 少量噪声的 yuv420p 帧（JS 生成，确定）：码率高到会撞上 NVENC 按自动 Level 设的码率上限，又不是纯随机噪声
// （纯噪声在 cq 6 这种极端画质下 NVENC 会出解码报错的码流，真实画面不会这样；生产 Fast 用 cq 7）
function gradientYuv(w, h, n) {
  const frame = f => {
    const b = Buffer.alloc(w * h * 1.5);
    let s = (f + 1) * 2654435761 >>> 0;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 24) / 255 - 0.5; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = Math.max(16, Math.min(235, 16 + ((x + y + f * 3) % 220) + 40 * rnd()));
    for (let i = 0; i < (w * h) / 2; i++) b[w * h + i] = Math.max(16, Math.min(240, 128 + 60 * Math.sin(i / 37 + f) + 20 * rnd()));
    return b;
  };
  return Array.from({ length: n }, (_, f) => frame(f));
}

test('startEncoder：nvenc 的 --cq 真的控制画质——cq 6 的码流明显大于 cq 14（不被自动 Level 的码率上限截住），两者都能无错解码', { skip: !hasNvenc && '没有可用的 NVENC（需要 NVIDIA 驱动）', timeout: 60000 }, async () => {
  const dir = tmp();
  try {
    const W = 320, H = 180, frames = gradientYuv(W, H, 24), size = {};
    for (const cq of [6, 14]) {
      const out = join(dir, `cq${cq}.mp4`);
      const enc = startEncoder({ width: W, height: H, fps: 24, out, encoder: 'nvenc', cq, pixFmt: 'yuv420p' });
      for (const f of frames) await enc.write(f);
      await enc.finish();
      const dec = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', out, '-f', 'null', '-'], { encoding: 'utf8' });
      assert.equal(dec.stderr.trim(), '', `cq ${cq} 的码流解码报错`);
      size[cq] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=size', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim() * 1;
    }
    // 截顶时两档输出字节数完全相同（320×180 自动选 Level 1.2）；不截顶时 cq 6 实测约大 16%
    assert.ok(size[6] > size[14] * 1.05, `cq 6 ${size[6]} 字节，cq 14 ${size[14]} 字节：低 cq 没有换来更高码率，说明被码率上限截住了`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('startEncoder：8 帧纯色 → 8 帧 yuv420p、BT.709 有限范围标记齐全、High profile、Y 与参考换算相差 ≤ 1', { skip: !hasFfmpeg && '没有 FFmpeg' }, async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'o.mp4'), W = 64, H = 64, rgb = [232, 223, 204];
    const enc = startEncoder({ width: W, height: H, fps: 24, out });
    for (let i = 0; i < 8; i++) await enc.write(solid(W, H, rgb));
    await enc.finish();
    const p = await probe(out);
    assert.equal(p.video.frames, 8);
    assert.equal(p.video.pixFmt, 'yuv420p');
    assert.match(String(p.video.profile), /High/i);
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
