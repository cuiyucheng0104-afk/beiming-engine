// qa delivery：现场生成的合成样本各自以指定检查项不通过（加固计划 P07 验收第 2 条），合格样本通过。
// 跑法：node --test "tests/qa/*.test.mjs"（Node ≥ 22 支持引号里的通配；Windows PowerShell 同样写法）
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { haveFfmpeg, tmp, cleanup, clip, ffmpeg, qa, check, writeJson, TEST_PROFILES } from './helpers.mjs';

const skip = haveFfmpeg ? false : '没有 FFmpeg ≥ 7（D09），跳过';
after(cleanup);

let dir, good, film;
const fails = env => (env?.result?.checks || []).filter(c => c.status === 'fail').map(c => c.id);

before(() => {
  if (skip) return;
  dir = tmp();
  good = clip(path.join(dir, 'good.mp4'));
  film = writeJson(path.join(dir, 'film.json'), {
    schemaVersion: 2, id: 'qa-delivery', title: '交付夹具', route: 'a',
    output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 96 },
    shots: [{ id: 'S1', in: 0, out: 96 }], aigc: { contains: false },
  });
});

test('合格样本：全部硬门通过，exit 0，信封字段齐全', { skip }, () => {
  const r = qa(['delivery', good, '--film', film]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(r.env).slice(0, 7), ['ok', 'exitCode', 'command', 'error', 'outputs', 'runJson', 'warnings']);
  assert.equal(r.env.ok, true);
  assert.equal(r.env.exitCode, 0);
  assert.deepEqual(fails(r.env), []);
  assert.equal(check(r.env, 'delivery.frame-count').value, 96);
  assert.equal(check(r.env, 'delivery.color').status, 'pass');
  const loud = check(r.env, 'delivery.loudness').evidence.integrated;
  assert.ok(Math.abs(loud + 14) <= 1, `合格样本应约 −14 LUFS，实测 ${loud}`);
  assert.match(r.stderr, /delivery/, '供人看的日志走 stderr');
});

test('25 fps 样本：frame-rate 不通过（帧数也对不上作品描述）', { skip }, () => {
  const f = clip(path.join(dir, 'fps25.mp4'), { rate: 25 });
  const r = qa(['delivery', f, '--film', film]);
  assert.equal(r.code, 4);
  assert.ok(fails(r.env).includes('delivery.frame-rate'), fails(r.env).join());
  assert.ok(fails(r.env).includes('delivery.frame-count'));
});

test('缺音轨：audio-stream 与响度不通过', { skip }, () => {
  const f = clip(path.join(dir, 'noaudio.mp4'), { audio: 'none' });
  const r = qa(['delivery', f, '--film', film]);
  assert.equal(r.code, 4);
  assert.ok(fails(r.env).includes('delivery.audio-stream'), fails(r.env).join());
  assert.ok(fails(r.env).includes('delivery.loudness'));
});

test('作品声明无声（audio.mode = none）时缺音轨不算错', { skip }, () => {
  const f = clip(path.join(dir, 'silent.mp4'), { audio: 'none' });
  const fm = writeJson(path.join(dir, 'film-silent.json'), { ...JSON.parse(fs.readFileSync(film, 'utf8')), audio: { mode: 'none' } });
  const r = qa(['delivery', f, '--film', fm]);
  assert.equal(r.code, 0, fails(r.env).join());
});

test('截短的文件：完整解码或帧数不通过，exit 4', { skip }, () => {
  const buf = fs.readFileSync(good);
  const f = path.join(dir, 'truncated.mp4');
  fs.writeFileSync(f, buf.subarray(0, Math.floor(buf.length * 0.6)));
  const r = qa(['delivery', f, '--film', film]);
  assert.equal(r.code, 4, r.stderr);
  const bad = fails(r.env);
  assert.ok(bad.includes('delivery.decode') || bad.includes('delivery.frame-count') || bad.includes('delivery.container'), bad.join());
});

test('全范围 yuvj420p + BT.601：像素格式与色彩标注不通过', { skip }, () => {
  const f = clip(path.join(dir, 'fullrange.mp4'), { pixFmt: 'yuvj420p', encColor: false });
  const r = qa(['delivery', f, '--film', film]);
  assert.equal(r.code, 4);
  assert.ok(fails(r.env).includes('delivery.pix-fmt'), fails(r.env).join());
  assert.ok(fails(r.env).includes('delivery.color'));
});

test('只改标签不改像素：全范围像素硬标成有限范围，range-pixels 报注意', { skip }, () => {
  // 全范围编码（黑 0、白 255）后用码流过滤器只改 VUI 标签成 tv / BT.709：标签合格，像素超出 16–235
  const full = clip(path.join(dir, 'full-src.mp4'), { src: 'smptehdbars=s={S}:r={R}:d={D}', pixFmt: 'yuvj420p', encColor: false });
  const f = path.join(dir, 'fake-tv.mp4');
  ffmpeg(['-i', full, '-c', 'copy', '-bsf:v', 'h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1', f]);
  const r = qa(['delivery', f, '--film', film]);
  assert.equal(check(r.env, 'delivery.color').status, 'pass', '标签本身是合格的');
  const c = check(r.env, 'delivery.range-pixels');
  assert.equal(c.status, 'warn', c.value);
  assert.equal(check(qa(['delivery', good, '--film', film]).env, 'delivery.range-pixels').status, 'pass');
});

test('响度过高：loudness 与 true-peak 不通过', { skip }, () => {
  const f = clip(path.join(dir, 'loud.mp4'), { gainDb: 22 });   // 原生 aac 编码器会把 1.0 以上的样本压住，+22 dB 才稳定越过 −1 dBTP
  const r = qa(['delivery', f, '--film', film]);
  assert.equal(r.code, 4);
  assert.ok(fails(r.env).includes('delivery.loudness'), fails(r.env).join());
  assert.ok(fails(r.env).includes('delivery.true-peak'));
});

test('作品含 AI 生成画面而 comment 没写标识：aigc-label 不通过；写了就通过', { skip }, () => {
  const fm = writeJson(path.join(dir, 'film-aigc.json'), { ...JSON.parse(fs.readFileSync(film, 'utf8')), aigc: { contains: true, note: '测试' } });
  const r1 = qa(['delivery', good, '--film', fm]);
  assert.equal(r1.code, 4);
  assert.ok(fails(r1.env).includes('delivery.aigc-label'));
  const tagged = clip(path.join(dir, 'aigc.mp4'), { extra: ['-metadata', 'comment=含 AI 生成画面（AIGC）'] });
  const r2 = qa(['delivery', tagged, '--film', fm]);
  assert.equal(check(r2.env, 'delivery.aigc-label').status, 'pass');
});

test('画幅与档位不符：size 不通过；--profile 换档后通过', { skip }, () => {
  // 放进单独的子目录：成片旁边（或上层）有 film.json 时 QA 会自动认作这部片的作品描述
  fs.mkdirSync(path.join(dir, 'small'));
  const f = clip(path.join(dir, 'small', 'small.mp4'), { size: '640x360' });
  const r = qa(['delivery', f]);
  assert.equal(r.code, 4);
  assert.ok(fails(r.env).includes('delivery.size'));
  const r2 = qa(['delivery', f, '--profile', 't-360p24', '--profiles-file', TEST_PROFILES]);
  assert.equal(check(r2.env, 'delivery.size').status, 'pass');
  assert.ok(r2.env.warnings.some(w => /内置值|QA 内置/.test(w)), '测试档位缺的字段用内置值兜底，要报 warn');
});
