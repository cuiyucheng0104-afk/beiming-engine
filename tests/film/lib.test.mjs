// tools/film 的库单元测试（不渲染、不启动浏览器，秒级）：node --test tests/film/lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, parseFrames, parseSize, parseTimes } from '../../tools/film/lib/args.mjs';
import { EXIT, FilmError } from '../../tools/film/lib/exit.mjs';
import { contactPlan } from '../../tools/film/lib/deliver.mjs';
import { RUN_ID_RE, createRunDir, acquireLock, setLatest, readLatest, listRuns } from '../../tools/film/lib/rundir.mjs';
import { Legacy } from '../../tools/film/lib/legacy.mjs';
import * as cache from '../../tools/film/lib/cache.mjs';
import { resolveProfile, framesAt, BUILTIN } from '../../tools/film/lib/profiles.mjs';
import { parseFilm, shotsAt, cutsOf, normalizeRoute } from '../../tools/film/lib/spec.mjs';
import { gateStatus, assertFinalAllowed, passes, reviewProblems, writeReview, writeWaivers } from '../../tools/film/lib/gates.mjs';
import { imageSize, encoderInfo, clickTrack, timecode } from '../../tools/film/lib/media.mjs';
import { rerunCommand } from '../../tools/film/lib/session.mjs';
import { ROOT } from './helpers.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'film-lib-'));
const throwsCode = (fn, exitCode, code) => assert.throws(fn, e => e instanceof FilmError && e.exitCode === exitCode && (!code || e.code === code));

test('参数：未知选项、开关带值、整数范围、枚举、列表都按用法错误（退出码 2）', () => {
  const spec = { positionals: [{ name: '作品目录', required: true }], options: {
    '--json': { type: 'bool' }, '--workers': { type: 'int', min: 1, max: 8 }, '--gpu': { type: 'enum', values: ['required', 'any'] },
    '--waive': { type: 'list', values: ['look', 'animatic'] }, '--no-cache': { type: 'bool' } } };
  const r = parseArgs(['films/x', '--workers=3', '--waive', 'look', '--waive', 'look,animatic', '--no-cache'], spec);
  assert.deepEqual(r.positionals, ['films/x']);
  assert.equal(r.opts.workers, 3);
  assert.deepEqual(r.opts.waive, ['look', 'animatic']);
  assert.equal(r.opts.noCache, true);
  throwsCode(() => parseArgs(['films/x', '--bogus'], spec), EXIT.USAGE);
  throwsCode(() => parseArgs(['films/x', '--json=1'], spec), EXIT.USAGE);
  throwsCode(() => parseArgs(['films/x', '--workers', '0'], spec), EXIT.USAGE);
  throwsCode(() => parseArgs(['films/x', '--workers', '2.5'], spec), EXIT.USAGE);
  throwsCode(() => parseArgs(['films/x', '--gpu', 'maybe'], spec), EXIT.USAGE);
  throwsCode(() => parseArgs(['films/x', '--waive', 'final'], spec), EXIT.USAGE);
  throwsCode(() => parseArgs(['films/x', '--workers'], spec), EXIT.USAGE);
  throwsCode(() => parseArgs([], spec), EXIT.USAGE);
  throwsCode(() => parseArgs(['a', 'b'], spec), EXIT.USAGE);
  throwsCode(() => parseArgs(['films/x', '-x'], spec), EXIT.USAGE);
});

test('帧段：半开区间、步长、组合、越界与步长 0', () => {
  assert.deepEqual(parseFrames('72:76', 240), [72, 73, 74, 75]);
  assert.deepEqual(parseFrames('0:240:60', 240), [0, 60, 120, 180]);
  assert.deepEqual(parseFrames('0:2,5,1', 240), [0, 1, 5]);
  throwsCode(() => parseFrames('240', 240), EXIT.USAGE);
  throwsCode(() => parseFrames('10:5', 240), EXIT.USAGE);
  throwsCode(() => parseFrames('0:10:0', 240), EXIT.USAGE);
  throwsCode(() => parseFrames('a:b', 240), EXIT.USAGE);
  assert.deepEqual(parseTimes('0,1.5,9.99', 24, 240), [0, 36, 239]);
  assert.deepEqual(parseSize('1920x1080'), [1920, 1080]);
  throwsCode(() => parseSize('1921x1080'), EXIT.USAGE);
});

test('联系表取帧：24 fps × 240 帧每 12 帧一格（0.5 秒）含片尾；切点前 3 后 3', () => {
  const p = contactPlan({ frames: 240, fps: 24, cuts: [72, 120] });
  assert.equal(p.overview.length, 21);
  assert.deepEqual(p.overview.slice(0, 3), [0, 12, 24]);
  assert.equal(p.overview.at(-1), 239);
  assert.deepEqual(p.strips.map(s => s.frames), [[69, 70, 71, 72, 73, 74], [117, 118, 119, 120, 121, 122]]);
  const short = contactPlan({ frames: 72, fps: 24, cuts: [] });
  assert.ok(short.overview.length >= 12 && short.overview.length <= 24, `72 帧取 ${short.overview.length} 格`);
  const v = contactPlan({ frames: 360, fps: 30, cuts: [0, 359] });
  assert.equal(v.overview[1] - v.overview[0], 30);
  assert.deepEqual(v.strips[0].frames, [0, 1, 2]);
});

test('运行目录：run-id 格式、同秒不重名、latest 指针、作品锁（同机活进程退出码 5，死进程接管）', () => {
  const root = tmp();
  try {
    const d = new Date('2026-11-10T01:02:03Z');
    const a = createRunDir(root, d), b = createRunDir(root, d);
    assert.match(a.id, RUN_ID_RE);
    assert.notEqual(a.id, b.id);
    assert.ok(fs.existsSync(a.work) && fs.existsSync(a.logs));
    fs.writeFileSync(path.join(a.dir, 'run.json'), '{"kind":"build"}');
    setLatest(root, 'build', a.id);
    assert.equal(readLatest(root, 'build'), a.id);
    assert.equal(fs.readFileSync(path.join(root, 'latest'), 'utf8').trim(), a.id);
    assert.equal(listRuns(root).length, 2);
    const lock = acquireLock(root, { command: 'test' });
    throwsCode(() => acquireLock(root, { command: 'test2' }), EXIT.BUSY, 'film-busy');
    lock.release();
    fs.writeFileSync(path.join(root, '.lock'), JSON.stringify({ pid: 2 ** 30, host: os.hostname(), startedAt: 'x' }));
    const warnings = [];
    acquireLock(root, { command: 'test3' }, warnings).release();
    assert.equal(warnings[0].code, 'stale-lock');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('旧位置工作区：登记前不存在的删掉、原有的按备份还原（内容一致时不动）', () => {
  const root = tmp();
  try {
    const keep = path.join(root, 'film', 'events.json'), fresh = path.join(root, 'film', 'out', 'mix.wav');
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.writeFileSync(keep, 'original');
    const L = new Legacy(path.join(root, 'backup'));
    const src = path.join(root, 'src.json');
    fs.writeFileSync(src, 'temporary');
    L.place(keep, src);
    L.protect(fresh);
    fs.mkdirSync(path.dirname(fresh), { recursive: true });
    fs.writeFileSync(fresh, 'wav');
    assert.equal(fs.readFileSync(keep, 'utf8'), 'temporary');
    const done = L.restore();
    assert.equal(fs.readFileSync(keep, 'utf8'), 'original');
    assert.ok(!fs.existsSync(fresh));
    assert.ok(!fs.existsSync(path.dirname(fresh)), '登记时不存在的 out/ 也一并删掉');
    assert.deepEqual(done.map(x => x.action).sort(), ['removed', 'restored']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('步骤缓存：存入、命中、文件缺失或大小不对就不命中、每步只留 2 份', () => {
  const root = tmp();
  try {
    const run = path.join(root, 'run1');
    fs.mkdirSync(path.join(run, 'work'), { recursive: true });
    fs.writeFileSync(path.join(run, 'work', 'video.mp4'), 'v1');
    cache.store(root, 'video', 'k1', run, ['work/video.mp4'], { gpu: 'x' }, 'run1');
    const hit = cache.lookup(root, 'video', 'k1');
    assert.equal(hit.runId, 'run1');
    const run2 = path.join(root, 'run2');
    assert.deepEqual(cache.restore(hit, run2), { gpu: 'x' });
    assert.equal(fs.readFileSync(path.join(run2, 'work', 'video.mp4'), 'utf8'), 'v1');
    assert.equal(cache.lookup(root, 'video', 'nope'), null);
    fs.writeFileSync(path.join(root, 'cache', 'video', 'k1', 'work', 'video.mp4'), 'changed size');
    assert.equal(cache.lookup(root, 'video', 'k1'), null);
    for (const k of ['k2', 'k3', 'k4']) cache.store(root, 'video', k, run, ['work/video.mp4'], {}, 'run1');
    assert.equal(fs.readdirSync(path.join(root, 'cache', 'video')).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('交付档位：D07 内置值、--profile 覆盖、v1 作品按画幅对号、不认识的档位是用法错误、帧率换算', () => {
  const film = { width: 1920, height: 1080, fps: 24, frameCount: 72, profileId: null };
  const w = [];
  assert.equal(resolveProfile(film, {}, w).id, 'web-1080p24');
  assert.equal(BUILTIN['broadcast-1080p25'].lufs, -23);
  assert.equal(BUILTIN['vertical-1080x1920-30'].height, 1920);
  const odd = resolveProfile({ ...film, height: 1040 }, {}, []);
  assert.equal(odd.custom, true);
  assert.equal(resolveProfile({ ...film, height: 1040 }, { override: 'beiming-1040p24' }, []).height, 1040);
  throwsCode(() => resolveProfile(film, { override: 'web-999p' }, []), EXIT.USAGE, 'profile-unknown');
  const sized = resolveProfile(film, { size: [640, 360] }, []);
  assert.equal(sized.width, 640);
  assert.equal(framesAt({ fps: 24, frameCount: 72 }, 30, []), 90);
});

test('作品描述：v1 自动换算帧数、v2 读 output、坏镜头表只告警、占位符与坏路线报错', () => {
  const dir = path.join(ROOT, 'routes/c-style/template');
  const v1 = parseFilm({ route: 'c', title: '墨', dur: 3, fps: 24, size: [1920, 1080] }, { dir });
  assert.equal(v1.frameCount, 72);
  assert.equal(v1.audio.mode, 'script');
  const v2 = parseFilm({ schemaVersion: 2, route: 'c', title: '墨', output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 96 },
    shots: [{ id: 'S1', in: 0, out: 48 }, { id: 'S2', in: 48, out: 96 }], events: [{ id: 'hit', frame: 50 }], audio: { mode: 'none' } }, { dir });
  assert.deepEqual(cutsOf(v2.shots), [48]);
  assert.deepEqual(shotsAt(v2, 30).map(s => [s.in, s.out]), [[0, 60], [60, 120]]);
  const gap = parseFilm({ route: 'c', title: '墨', dur: 3, fps: 24, size: [1920, 1080], shots: [{ id: 'S1', in: 0, out: 30 }, { id: 'S2', in: 40, out: 72 }] }, { dir });
  assert.ok(gap.warnings.some(x => x.code === 'shots-unusable'));
  throwsCode(() => parseFilm({ route: 'c', title: '{{TITLE}}', dur: 3, fps: 24, size: [1920, 1080] }, { dir }), EXIT.CONTRACT, 'film-json-invalid');
  throwsCode(() => parseFilm({ route: 'x', title: 't', dur: 3, fps: 24, size: [1920, 1080] }, { dir }), EXIT.CONTRACT);
  throwsCode(() => parseFilm({ route: 'c', title: 't', dur: 3, fps: 24, size: [1921, 1080] }, { dir }), EXIT.CONTRACT);
  assert.deepEqual(normalizeRoute('beiming'), { id: 'a', legacy: true });
  assert.deepEqual(normalizeRoute('c-style'), { id: 'c', legacy: false });
});

test('闸门：没有记录拒绝终渲（4）；agent 记录与内部豁免不放行；用户豁免与用户认可放行', async () => {
  const dir = tmp();
  try {
    const film = { dir, relDir: 'films/t', gates: { look: 'required', animatic: 'required', final: 'required' } };
    throwsCode(() => assertFinalAllowed(film, gateStatus(film)), EXIT.CONTRACT, 'gate-blocked');
    await writeReview(film, { gate: 'look', decision: 'approved', reviewerKind: 'ai', reviewer: 'agent', quote: '我觉得可以', source: '自评', recordedAt: '2026-11-10T00:00:00Z' });
    assert.equal(gateStatus(film).look.state, 'pending', 'agent 自己写的 approved 不算');
    await writeWaivers(film, [{ gate: 'look', reason: '赶时间', recordedAt: '2026-11-10T00:00:01Z' }, { gate: 'animatic', reason: '赶时间', recordedAt: '2026-11-10T00:00:01Z' }]);
    const st = gateStatus(film);
    assert.equal(st.look.state, 'waived');
    assert.equal(st.look.waiverKind, 'internal');
    assert.equal(passes(st.look), true);
    assert.equal(passes(st.look, { final: true }), false, '内部豁免不放行终渲');
    throwsCode(() => assertFinalAllowed(film, st), EXIT.CONTRACT);
    await writeReview(film, { gate: 'look', decision: 'approved', reviewerKind: 'human', reviewer: '用户', quote: '这版可以', source: '会话第 3 条', recordedAt: '2026-11-10T00:00:02Z' });
    await writeWaivers(film, [{ gate: 'animatic', reason: '用户说不看预演', quote: '动态预览不用给我看了', source: '会话第 5 条', recordedAt: '2026-11-10T00:00:03Z' }]);
    const ok = assertFinalAllowed(film, gateStatus(film));
    assert.deepEqual(ok.map(x => x.state), ['approved', 'waived']);
    await writeReview(film, { gate: 'look', decision: 'changes-requested', reviewerKind: 'human', reviewer: '用户', quote: '雾再淡一点', source: '会话第 7 条', recordedAt: '2026-11-10T00:00:04Z' });
    throwsCode(() => assertFinalAllowed(film, gateStatus(film)), EXIT.CONTRACT, 'gate-blocked');
    assert.deepEqual(reviewProblems({ decision: 'approved', reviewerKind: 'human', reviewer: 'u', quote: 'x', source: 's' }), ['缺用户原话']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('媒体小工具：PNG / JPEG 尺寸、时间码、提示音 WAV、复现命令的引号', () => {
  const dir = tmp();
  try {
    const wav = path.join(dir, 'c.wav');
    clickTrack({ file: wav, frames: 48, fps: 24, marks: [{ frame: 12, kind: 'event' }, { frame: 24, kind: 'cut' }] });
    const b = fs.readFileSync(wav);
    assert.equal(b.toString('ascii', 0, 4), 'RIFF');
    assert.equal(b.length, 44 + 2 * 48000 * 2 * 2);
    assert.equal(timecode(25, 24), '00:00:01:01');
    const ff = process.env.FFMPEG || 'ffmpeg';
    if (spawnSync(ff, ['-version']).status === 0) {
      const png = path.join(dir, 'a.png'), jpg = path.join(dir, 'a.jpg'), mp4 = path.join(dir, 'a.mp4');
      spawnSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180', '-frames:v', '1', png]);
      spawnSync(ff, ['-v', 'error', '-i', png, jpg]);
      assert.deepEqual(imageSize(png), { width: 320, height: 180 });
      assert.deepEqual(imageSize(jpg), { width: 320, height: 180 });
      spawnSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=24', '-frames:v', '24', '-c:v', 'libx264', '-crf', '20', mp4]);
      assert.match(encoderInfo(mp4) || '', /^libx264 core \d+ · crf 20/);
    }
    assert.equal(rerunCommand(['build', 'films/x', '--reason', "用户说'不看'"]), `node tools/film/cli.mjs build films/x --reason '用户说'\\''不看'\\'''`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('取帧按色彩标记精确换算：BT.709 有限范围的中性灰 128 读回 128（默认换算会读成 126）', async () => {
  const ff = process.env.FFMPEG || 'ffmpeg';
  if (spawnSync(ff, ['-version']).status !== 0) return;
  const { extractFrames, rgbDecode } = await import('../../tools/film/lib/media.mjs');
  const { exec } = await import('../../tools/film/lib/proc.mjs');
  const dir = tmp();
  try {
    const png = path.join(dir, 'g.png'), mp4 = path.join(dir, 'g.mp4');
    spawnSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x808080:s=64x64,format=rgb24', '-frames:v', '1', png]);
    spawnSync(ff, ['-v', 'error', '-i', png, '-vf', 'scale=in_range=full:in_color_matrix=bt601:out_range=limited:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuv420p',
      '-c:v', 'libx264', '-qp', '0', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', mp4]);
    assert.match(rgbDecode({ range: 'tv', space: 'bt709' }), /in_range=tv:in_color_matrix=bt709/);
    const got = await extractFrames(exec, mp4, [0], path.join(dir, 'f'));
    const raw = spawnSync(ff, ['-v', 'error', '-i', got.get(0), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).stdout;
    assert.deepEqual([...raw.subarray(0, 3)], [128, 128, 128]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
