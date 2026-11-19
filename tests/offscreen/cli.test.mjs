// 离屏出片 · 命令 offscreen render（engine/offscreen/cli.mjs）：用法错误不需要 GPU；真出片要可选依赖与 GPU，缺了跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe, FFMPEG } from '../../engine/render/lib/ffmpeg.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(ROOT, 'engine/offscreen/cli.mjs');
const WORK = 'lab/offscreen/ink.mjs';
const run = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000, ...opts });
const envelope = r => JSON.parse(r.stdout);
const tmp = () => mkdtempSync(join(tmpdir(), 'beiming-offscreen-cli-'));

// 能不能真出片：装了可选依赖且拿得到 GPU 适配器
const probeGpu = spawnSync(process.execPath, ['--input-type=module', '-e',
  "try { const { loadGpu } = await import('./engine/offscreen/load.mjs'); const { createHost } = await import('./engine/offscreen/host.mjs'); (await createHost({ gpu: await loadGpu(), width: 64, height: 64 })).dispose(); } catch(e) { console.error(e.message); process.exitCode=e.code?.startsWith('env.')?3:1; }"],
{ cwd: ROOT, encoding: 'utf8', timeout: 60000 });
assert.ok(probeGpu.status === 0 || probeGpu.status === 3, `GPU 探测出现非环境错误：${probeGpu.stderr}`);
const noGpu = probeGpu.status === 3 && `离屏出片不可用：${probeGpu.stderr.trim()}`;
// 真出片还要 FFmpeg：CI 的 windows-paths 任务不装它，这些用例在那里跳过
const ffmpegOk = spawnSync(FFMPEG(), ['-version'], { stdio: 'ignore' }).status === 0;
const noEncode = noGpu || (!ffmpegOk && '没有 FFmpeg（npm run setup；CI 的 windows-paths 任务不装）');

test('--help：退出 0，打印用法，不建任何文件', () => {
  const dir = tmp();
  try {
    const r = run(['render', '--help'], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /offscreen render <作品\.mjs>/);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('作品放在仓库外：退出 2、usage.work-outside-repo，不执行它', () => {
  const dir = tmp();
  try {
    const marker = join(dir, 'ran');
    const outside = join(dir, 'evil.mjs');
    writeFileSync(outside, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, '1'); export function build() { return { render() {} }; }\n`);
    const r = run(['render', outside, '--out', join(dir, 'o.mp4'), '--frames', '0:2', '--json']);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(envelope(r).error.code, 'usage.work-outside-repo');
    assert.equal(existsSync(marker), false, '仓库外的作品被执行了');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('宽高为奇数、--frames 写反、作品不存在、缺 --out：都是用法错误（退出 2）', () => {
  const dir = tmp(), out = join(dir, 'o.mp4');
  try {
    for (const [args, code] of [
      [['render', WORK, '--out', out, '--frames', '0:2', '--size', '321x180'], 'usage.bad-value'],
      [['render', WORK, '--out', out, '--frames', '5:2'], 'usage.bad-value'],
      [['render', 'lab/offscreen/nope.mjs', '--out', out, '--frames', '0:2'], 'usage.work-not-found'],
      [['render', WORK, '--frames', '0:2'], 'usage.missing-out'],
    ]) {
      const r = run([...args, '--json']);
      assert.equal(r.status, 2, `${args.join(' ')}\n${r.stderr}`);
      assert.equal(envelope(r).error.code, code, args.join(' '));
    }
    assert.equal(existsSync(out), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('出片：6 帧 320×180 → 成片 6 帧，信封里有逐帧哈希；同参数再跑一次码流逐字节相同', { skip: noEncode, timeout: 180000 }, async () => {
  const dir = tmp();
  try {
    const go = name => run(['render', WORK, '--out', join(dir, name), '--frames', '0:6', '--size', '320x180', '--json']);
    const a = go('a.mp4'), b = go('b.mp4');
    assert.equal(a.status, 0, a.stderr);
    const e = envelope(a);
    assert.equal(e.ok, true);
    assert.equal(e.data.frames, 6);
    assert.equal(e.data.frameHashes.length, 6);
    assert.equal((await probe(join(dir, 'a.mp4'))).video.frames, 6);
    assert.deepEqual(envelope(b).data.frameHashes, e.data.frameHashes);
    const md5 = f => spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, f), '-map', '0:v', '-c', 'copy', '-f', 'md5', '-'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(md5('b.mp4'), md5('a.mp4'));
    assert.deepEqual(readdirSync(dir).filter(f => /partial/.test(f)), [], '留下了半成品');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('出片默认走 GPU 侧 yuv420p 打包（x264 也一样）：成片 yuv420p、BT.709 tv 标记完整；--pix-fmt rgba 仍可退回 CPU 换算', { skip: noEncode, timeout: 180000 }, async () => {
  const dir = tmp();
  try {
    const d = run(['render', WORK, '--out', join(dir, 'd.mp4'), '--frames', '0:4', '--size', '320x180', '--json']);
    assert.equal(d.status, 0, d.stderr);
    assert.equal(envelope(d).data.pixFmt, 'yuv420p', '不写 --pix-fmt 时应在 GPU 上打包');
    const p = await probe(join(dir, 'd.mp4'));
    assert.equal(p.video.pixFmt, 'yuv420p');
    assert.deepEqual(p.video.color, { range: 'tv', space: 'bt709', primaries: 'bt709', transfer: 'bt709' });
    const r = run(['render', WORK, '--out', join(dir, 'r.mp4'), '--frames', '0:4', '--size', '320x180', '--pix-fmt', 'rgba', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(envelope(r).data.pixFmt, 'rgba');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('出片中途 FFmpeg 退出：退出 1、failure.ffmpeg，不挂住，不留成片与半成品', { skip: noEncode || (process.platform === 'win32' && '需要 POSIX 可执行脚本'), timeout: 120000 }, () => {
  const dir = tmp();
  try {
    const fake = join(dir, 'ffmpeg-exit1');
    writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const r = run(['render', WORK, '--out', join(dir, 'o.mp4'), '--frames', '0:48', '--size', '320x180', '--json'], { env: { ...process.env, FFMPEG: fake } });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(envelope(r).error.code, 'failure.ffmpeg');
    assert.deepEqual(readdirSync(dir).filter(f => f !== 'ffmpeg-exit1'), [], '留下了成片或半成品');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('读回中途拒绝：CLI 返回 JSON 失败并清理半成品，不因未处理拒绝崩溃', { skip: noEncode, timeout: 120000 }, () => {
  mkdirSync(join(ROOT, 'out'), { recursive: true });
  const dir = tmp(), fixtureDir = mkdtempSync(join(ROOT, 'out/offscreen-readback-'));
  try {
    const work = join(fixtureDir, 'work.mjs');
    const inkUrl = new URL('../../lab/offscreen/ink.mjs', import.meta.url).href;
    writeFileSync(work, `import {build as ink} from ${JSON.stringify(inkUrl)}; export function build(ctx) { const {renderer}=ctx; let calls=0; const read=renderer.readRenderTargetPixelsAsync.bind(renderer); renderer.readRenderTargetPixelsAsync=(...a)=> ++calls===3?Promise.reject(new Error('injected readback rejection')):read(...a); return ink(ctx); }`);
    // 注入点是 RGBA 读回接口，所以固定 --pix-fmt rgba；流水线对两种格式的拒绝处理是同一段（frames.mjs renderFrameList）
    const r = run(['render', work, '--out', join(dir, 'o.mp4'), '--frames', '0:48', '--size', '320x180', '--pix-fmt', 'rgba', '--json']);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(envelope(r).ok, false);
    assert.deepEqual(readdirSync(dir), []);
    assert.doesNotMatch(r.stderr, /PromiseRejectionHandledWarning/);
  } finally { rmSync(fixtureDir, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});

// 防止「把作品拷进临时目录」的测试写法把仓库外路径当成仓库内：仓库内的符号链接指向仓库外也算仓库外
test('仓库内的符号链接指向仓库外的作品：同样拒绝', { skip: process.platform === 'win32' && '需要符号链接' }, () => {
  const dir = tmp(), link = join(ROOT, 'out', `offscreen-link-${process.pid}.mjs`);
  try {
    copyFileSync(join(ROOT, WORK), join(dir, 'ink.mjs'));
    spawnSync('mkdir', ['-p', join(ROOT, 'out')]);
    spawnSync('ln', ['-s', join(dir, 'ink.mjs'), link]);
    const r = run(['render', link, '--out', join(dir, 'o.mp4'), '--frames', '0:2', '--json']);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(envelope(r).error.code, 'usage.work-outside-repo');
  } finally { rmSync(link, { force: true }); rmSync(dir, { recursive: true, force: true }); }
});

test('stills 与 probe：输出无损 PNG 静帧、核对逐帧哈希、只读探测作品契约', { skip: noGpu, timeout: 120000 }, async () => {
  const { decodePng } = await import('../../tools/plates/png.mjs');
  const dir = tmp();
  try {
    // 1) probe 只读探测：不写任何文件，返回适配器信息与 hasTexts
    const p = run(['probe', WORK, '--size', '320x180', '--fps', '24', '--json'], { cwd: ROOT });
    assert.equal(p.status, 0, p.stderr);
    const pe = envelope(p);
    assert.equal(pe.ok, true);
    assert.equal(pe.data.width, 320);
    assert.equal(pe.data.height, 180);
    assert.equal(typeof pe.data.hasTexts, 'boolean');
    assert.deepEqual(readdirSync(dir), []);

    // 2) stills 按逗号列表与区间渲 PNG，不依赖 FFmpeg；重跑逐帧哈希一致
    const outA = join(dir, 'stills-a'), outB = join(dir, 'stills-b');
    const a = run(['stills', WORK, '--out', outA, '--frames', '0,14,30', '--size', '320x180', '--json']);
    const b = run(['stills', WORK, '--out', outB, '--frames', '0,14,30', '--size', '320x180', '--json']);
    assert.equal(a.status, 0, a.stderr);
    const ea = envelope(a), eb = envelope(b);
    assert.deepEqual(ea.data.frameNumbers, [0, 14, 30]);
    assert.equal(ea.data.frameHashes.length, 3);
    assert.deepEqual(eb.data.frameHashes, ea.data.frameHashes);
    for (const f of [0, 14, 30]) {
      const png = decodePng(await import('node:fs').then(fs => fs.readFileSync(join(outA, `f${String(f).padStart(6, '0')}.png`))));
      assert.equal(png.width, 320);
      assert.equal(png.height, 180);
    }
    assert.deepEqual(readdirSync(outA).filter(f => /partial/.test(f)), [], '留下了半成品');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('film check 与 film stills 闭环：纯 backend=webgpu 作品不经浏览器即可通过 check、出静帧与联系表、二次运行命中缓存', { skip: noEncode, timeout: 180000 }, t => {
  mkdirSync(join(ROOT, 'out'), { recursive: true });
  const filmDir = mkdtempSync(join(ROOT, 'out/offscreen-webgpu-film-'));
  const outRoot = tmp();
  const FILM_CLI = join(ROOT, 'tools/film/cli.mjs');
  const runFilm = args => spawnSync(process.execPath, [FILM_CLI, ...args], { cwd: ROOT, env: { ...process.env, BEIMING_GPU: 'software-ok' }, encoding: 'utf8', timeout: 120000 });
  try {
    const inkUrl = new URL('../../lab/offscreen/ink.mjs', import.meta.url).href;
    writeFileSync(join(filmDir, 'offscreen.mjs'), `import { build as ink } from ${JSON.stringify(inkUrl)};\nexport function build(ctx) { return { ...ink(ctx), texts: () => [] }; }\n`);
    writeFileSync(join(filmDir, 'film.json'), `${JSON.stringify({
      schemaVersion: 2,
      id: 'webgpu-smoke',
      title: '离屏纯作品自检',
      route: 'c',
      backend: 'webgpu',
      output: { profile: 'web-1080p24', fps: 24, frameCount: 48, width: 1920, height: 1080 },
      shots: [{ id: 'S1', in: 0, out: 48 }],
      events: [],
      credits: [{ what: '演示代码', owner: 'Beiming Engine', license: 'Proprietary', source: 'lab/offscreen/ink.mjs' }],
      aigc: { contains: false, note: '纯代码生成' },
    }, null, 2)}\n`);

    const chk = runFilm(['check', filmDir, '--json']);
    assert.equal(chk.status, 0, chk.stderr);
    const cj = JSON.parse(chk.stdout);
    assert.equal(cj.ok, true);
    assert.ok(cj.data.checks.some(c => c.id === 'offscreen' && c.status === 'pass' && c.hasTexts === true));

    const s1 = runFilm(['stills', filmDir, '--frames', '0,24', '--size', '320x180', '--out-root', outRoot, '--json']);
    if (s1.status === 3) return t.skip(`环境缺 Python 3.12 锁（film stills 联系表需要）：${s1.stderr.trim().split('\n')[0]}`);
    assert.equal(s1.status, 0, s1.stderr);
    const j1 = JSON.parse(s1.stdout);
    assert.equal(j1.data.rendered, 2);
    assert.equal(j1.data.reused, 0);
    assert.equal(existsSync(join(ROOT, j1.data.runDir, 'contact.jpg')), true);

    const s2 = runFilm(['stills', filmDir, '--frames', '0,24', '--size', '320x180', '--out-root', outRoot, '--json']);
    assert.equal(s2.status, 0, s2.stderr);
    const j2 = JSON.parse(s2.stdout);
    assert.equal(j2.data.rendered, 0, '二次运行应完全命中离屏静帧缓存');
    assert.equal(j2.data.reused, 2);
  } finally {
    rmSync(filmDir, { recursive: true, force: true });
    rmSync(outRoot, { recursive: true, force: true });
  }
});
