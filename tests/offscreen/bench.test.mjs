// 离屏出片 · 同进程多部片并发基准（tools/offscreen/bench.mjs）：一个进程、一个 GPUDevice 同时出 N 部片，并发不得改变像素。
// 缺可选依赖或拿不到 GPU 时（命令退出 3）跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFilms } from '../../tools/offscreen/bench.mjs';
import { loadGpu } from '../../engine/offscreen/load.mjs';
import { createHost } from '../../engine/offscreen/host.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const run = args => spawnSync(process.execPath, [join(ROOT, 'tools/offscreen/bench.mjs'), ...args, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });

test('1、2、4 部片并发：每档有吞吐数字，同一部片的逐帧哈希与单部片基线相同', { timeout: 200000 }, t => {
  const r = run(['lab/offscreen/ink.mjs', '--films', '1,2,4', '--frames', '12', '--size', '320x180']);
  const e = JSON.parse(r.stdout);
  if (r.status === 3) return t.skip(`离屏基准不可用：${e.error.message}`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(e.data.runs.map(x => x.films), [1, 2, 4]);
  for (const x of e.data.runs) {
    assert.equal(x.totalFrames, x.films * 12);
    assert.ok(x.totalFps > 0 && x.perFilmFps > 0, JSON.stringify(x));
    assert.equal(x.deterministic, true, `${x.films} 部并发时像素与单部不同`);
  }
});

test('--encode：每部片各接一个编码器，帧数核对通过', { timeout: 200000 }, t => {
  const r = run(['lab/offscreen/ink.mjs', '--films', '2', '--frames', '12', '--size', '320x180', '--encode']);
  const e = JSON.parse(r.stdout);
  if (r.status === 3) return t.skip(`离屏基准不可用：${e.error.message}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(e.data.encode, true);
  assert.equal(e.data.runs[0].deterministic, true);
});

// 机器上有没有能用的 NVENC：试编一帧
const hasNvenc = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256', '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { stdio: 'ignore' }).status === 0;

test('--encode --encoder nvenc：每部片接 NVENC，信封记下用的编码器', { timeout: 200000, skip: !hasNvenc && '没有可用的 NVENC' }, t => {
  const r = run(['lab/offscreen/ink.mjs', '--films', '2', '--frames', '12', '--size', '320x180', '--encode', '--encoder', 'nvenc']);
  const e = JSON.parse(r.stdout);
  if (r.status === 3) return t.skip(`离屏基准不可用：${e.error.message}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(e.data.encode, true);
  assert.equal(e.data.encoder, 'nvenc');
  assert.equal(e.data.runs[0].deterministic, true);
});

test('计时渲染遍不做逐帧哈希；独立验证遍仍返回每一帧的哈希', async t => {
  let gpu;
  try { gpu = await loadGpu(); (await createHost({ gpu, width: 64, height: 64 })).dispose(); }
  catch (e) { if (e.code?.startsWith('env.')) return t.skip(e.message); throw e; }
  const opts = { gpu, n: 1, file: join(ROOT, 'lab/offscreen/ink.mjs'), width: 64, height: 64, fps: 24, frames: 4, inflight: 3, encode: false };
  const timed = await runFilms({ ...opts, verify: false });
  assert.deepEqual(timed.hashes, [[]], '计时遍不应产生哈希');
  const verified = await runFilms({ ...opts, verify: true });
  assert.equal(verified.hashes[0].length, 4);
});

test('用法错误：--films 含 0 或非数字、--frames 不是正整数 → 退出 2', () => {
  for (const args of [['lab/offscreen/ink.mjs', '--films', '1,0'], ['lab/offscreen/ink.mjs', '--films', 'a'], ['lab/offscreen/ink.mjs', '--frames', '0']]) {
    const r = run(args);
    assert.equal(r.status, 2, `${args.join(' ')}\n${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).error.code, 'usage.bad-value');
  }
});
