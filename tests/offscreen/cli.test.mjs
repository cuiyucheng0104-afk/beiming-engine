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
    const r = run(['render', work, '--out', join(dir, 'o.mp4'), '--frames', '0:48', '--size', '320x180', '--json']);
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
