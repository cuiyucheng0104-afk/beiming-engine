// B 路线交付（engine/native/delivery.mjs）：档位推断、响度增益规划与复测判定、母版 / 网页版的 FFmpeg 参数、成片规格判定。
// 纯函数部分不需要 FFmpeg；最后一个用例在本机有 FFmpeg 时实际编一段 1 秒的片子，核对 BT.709 tv 标注、yuv420p、AAC 48k 与响度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as D from '../../engine/native/delivery.mjs';

const spec = (width, height, fps, extra = {}) => ({ width, height, fps, frames: fps * 3, dur: 3, profile: null, ...extra });

test('档位：按尺寸帧率推断；film.json 指定优先；对不上时给自定义档并提示', () => {
  assert.equal(D.resolveProfile(spec(1920, 1080, 24)).name, 'web-1080p24');
  assert.equal(D.resolveProfile(spec(1920, 1040, 24)).name, 'beiming-1040p24');
  assert.equal(D.resolveProfile(spec(1080, 1920, 30)).name, 'vertical-1080x1920-30');
  const custom = D.resolveProfile(spec(1280, 720, 24));
  assert.match(custom.name, /^custom-1280x720p24$/);
  assert.ok(custom.note);
  assert.equal(D.resolveProfile(spec(1920, 1080, 24, { profile: 'broadcast-1080p25' })).name, 'broadcast-1080p25');
  assert.ok(D.resolveProfile(spec(1920, 1080, 24), 'no-such').error);
});

test('档位与作品不符要报出来（入口按 exit 4 处理）', () => {
  const p = D.profileByName('web-1080p24');
  assert.deepEqual(D.checkProfileFit(spec(1920, 1080, 24), p), []);
  assert.equal(D.checkProfileFit(spec(1920, 1040, 25), p).length, 2);
});

test('D07：web-1080p24 = H.264 High、yuv420p、BT.709 tv、AAC 48 kHz 立体声、−14 LUFS、真峰值 ≤ −1 dBTP', () => {
  const p = D.profileByName('web-1080p24');
  assert.deepEqual(p.color, { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' });
  assert.equal(p.video.pixFmt, 'yuv420p');
  assert.equal(p.video.profile, 'high');
  assert.equal(p.audio.rate, 48000);
  assert.equal(p.audio.channels, 2);
  assert.equal(p.audio.lufs, -14);
  assert.equal(p.audio.tpMax, -1);
  assert.equal(D.profileByName('broadcast-1080p25').audio.lufs, -23);
});

test('作品自己的声音目标覆盖档位默认', () => {
  const a = D.audioTarget(D.profileByName('web-1080p24'), { targetLUFS: -16, truePeakDbTP: -2 });
  assert.equal(a.lufs, -16);
  assert.equal(a.tpMax, -2);
});

test('增益规划：线性对准响度；峰值不够时按峰值限住并判不合格', () => {
  const a = D.profileByName('web-1080p24').audio;
  const ok = D.planGain({ I: -16, TP: -6 }, a);
  assert.equal(ok.gainDb, 2);
  assert.equal(ok.ok, true);
  assert.equal(ok.limitedByPeak, false);
  const peaky = D.planGain({ I: -20, TP: -3 }, a);
  assert.equal(peaky.limitedByPeak, true);
  assert.equal(peaky.ok, false);
  assert.ok(peaky.expectedTP <= a.tpMax - 0.5 + 1e-9);
  assert.equal(D.planGain({ I: -Infinity, TP: -Infinity }, a).ok, false);
});

test('响度复测判定', () => {
  const a = D.profileByName('web-1080p24').audio;
  assert.equal(D.judgeLoudness({ I: -14.2, TP: -1.4 }, a).ok, true);
  assert.equal(D.judgeLoudness({ I: -15.3, TP: -1.4 }, a).ok, false);
  assert.equal(D.judgeLoudness({ I: -14.0, TP: -0.8 }, a).ok, false);
});

test('ebur128 输出解析：取 Summary 段', () => {
  const text = `[Parsed_ebur128_0 @ 0x1] t: 0.1  TARGET:-23 LUFS    M: -30.2 S: -40.0     I: -30.2 LUFS       LRA:   0.0 LU  FTPK: -9.0 dBFS  TPK: -9.0 dBFS
[Parsed_ebur128_0 @ 0x1] t: 0.2  TARGET:-23 LUFS    M: -12.5 S: -13.1     I: -14.1 LUFS       LRA:   0.0 LU
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -14.1 LUFS
    Threshold: -24.2 LUFS

  Loudness range:
    LRA:         3.2 LU

  True peak:
    Peak:       -1.6 dBFS`;
  const m = D.parseEbur128(text);
  assert.equal(m.I, -14.1);
  assert.equal(m.LRA, 3.2);
  assert.equal(m.TP, -1.6);
  assert.equal(m.maxM, -12.5);
  assert.throws(() => D.parseEbur128('no summary here'));
});

test('母版：视频轨逐位复制（-c:v copy），声音编 AAC 48 kHz；没有声音时不加音轨', () => {
  const a = D.profileByName('web-1080p24').audio;
  const m = D.masterArgs({ video: 'n.mp4', pcm: 'mix.wav', gainDb: 1.5, out: 'm.mp4', audio: a, durSeconds: 3 });
  assert.ok(m.join(' ').includes('-c:v copy'));
  assert.ok(m.join(' ').includes('volume=1.50dB'));
  assert.ok(m.includes('aac'));
  const silent = D.masterArgs({ video: 'n.mp4', pcm: null, gainDb: 0, out: 'm.mp4', audio: a, durSeconds: 3 });
  assert.ok(!silent.includes('aac'));
});

test('网页版：BT.709 tv 四个色彩标签写全、yuv420p、AAC 48k；母版已是 709 tv 时不做色彩转换，全范围 / 601 时一次转换', () => {
  const p = D.profileByName('web-1080p24');
  const tv = D.webArgs({ master: 'm.mp4', pcm: 'mix.wav', gainDb: 0, out: 'w.mp4', p, audio: p.audio, sourceColor: { color_space: 'bt709', color_range: 'tv', color_primaries: 'bt709' }, durSeconds: 3 });
  const s = tv.args.join(' ');
  for (const k of ['-color_primaries bt709', '-color_trc bt709', '-colorspace bt709', '-color_range tv', '-pix_fmt yuv420p', '-ar 48000', '-c:a aac', '-profile:v high']) assert.ok(s.includes(k), k);
  assert.ok(!s.includes('colorspace='), '已是 709 tv 时不应转换');
  const full = D.webArgs({ master: 'm.mp4', pcm: null, gainDb: 0, out: 'w.mp4', p, audio: p.audio, sourceColor: { color_space: 'bt470bg', color_range: 'pc' }, durSeconds: 3 });
  assert.match(full.args.join(' '), /colorspace=space=bt709:ispace=bt470bg:range=tv:irange=pc/);
  assert.match(full.args.join(' '), /anullsrc=r=48000:cl=stereo/, '无声作品补一条静音立体声');
});

test('成片判定：帧数、尺寸、帧率、时长、音轨、色彩', () => {
  const p = D.profileByName('web-1080p24');
  const good = { width: 1920, height: 1080, fps: 24, frames: 72, duration: 3.0, pixFmt: 'yuv420p', color: { ...p.color }, audio: { codec: 'aac', rate: 48000, channels: 2 } };
  const want = { width: 1920, height: 1080, fps: 24, frames: 72, dur: 3 };
  assert.deepEqual(D.judgeVideo(good, want, { web: true, audio: true, p }), []);
  const bad = { ...good, frames: 71, pixFmt: 'yuvj420p', color: { ...p.color, range: 'pc' }, audio: null };
  const problems = D.judgeVideo(bad, want, { web: true, audio: true, p });
  assert.ok(problems.some(x => /71/.test(x)) && problems.some(x => /yuvj420p/.test(x)) && problems.some(x => /range/.test(x)) && problems.some(x => /AAC/.test(x)));
});

const hasFFmpeg = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-version'], { timeout: 10000 }).status === 0;

test('实编一秒：网页版参数出来的文件是 yuv420p / BT.709 tv / AAC 48k 立体声，复测响度在目标内', { skip: !hasFFmpeg && '本机没有 FFmpeg' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bne-web-'));
  try {
    const ff = process.env.FFMPEG || 'ffmpeg', fp = process.env.FFPROBE || 'ffprobe';
    const master = join(dir, 'm.mp4'), wav = join(dir, 'a.wav'), web = join(dir, 'w.mp4');
    // 一个全范围 BT.601 的母版（模拟页面截图链路的产物）+ 一段 −20 LUFS 左右的粉红噪声
    assert.equal(spawnSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=1', '-pix_fmt', 'yuvj420p', '-c:v', 'libx264', '-crf', '12', master], { timeout: 60000 }).status, 0);
    assert.equal(spawnSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=c=pink:r=48000:a=0.05:d=1', '-ac', '2', wav], { timeout: 60000 }).status, 0);
    const p = { ...D.profileByName('web-1080p24'), width: 320, height: 180 };
    const probe = f => JSON.parse(spawnSync(fp, D.probeArgs(f), { encoding: 'utf8', timeout: 60000 }).stdout);
    const src = D.describeVideo(probe(master));
    const pcmLoud = D.parseEbur128(spawnSync(ff, D.loudnessArgs(wav), { encoding: 'utf8', timeout: 60000 }).stderr);
    const plan = D.planGain(pcmLoud, p.audio);
    const { args } = D.webArgs({ master, pcm: wav, gainDb: plan.gainDb, out: web, p, audio: p.audio, sourceColor: { color_space: src.color.matrix, color_range: src.color.range, color_primaries: src.color.primaries }, durSeconds: 1 });
    const r = spawnSync(ff, args, { encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    const d = D.describeVideo(probe(web));
    assert.deepEqual(D.judgeVideo(d, { width: 320, height: 180, fps: 24, frames: 24, dur: 1 }, { web: true, audio: true, p }), []);
    const m = D.parseEbur128(spawnSync(ff, D.loudnessArgs(web), { encoding: 'utf8', timeout: 60000 }).stderr);
    assert.ok(Math.abs(m.I - p.audio.lufs) <= 1.5, `响度 ${m.I}`);   // 1 秒的短样本门限更宽一点
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
