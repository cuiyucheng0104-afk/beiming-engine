// 离屏出片 · 单卡异构多作业并发调度器（engine/offscreen/batch.mjs 与 offscreen batch 子命令）单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseBatchJobs, runBatch } from '../../engine/offscreen/batch.mjs';
import { loadGpu } from '../../engine/offscreen/load.mjs';
import { createHost } from '../../engine/offscreen/host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'engine/offscreen/cli.mjs');
const INK = path.join(ROOT, 'lab/offscreen/ink.mjs');
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

let gpu = null, skipGpu = null;
try {
  gpu = await loadGpu();
  const h = await createHost({ gpu, width: 32, height: 32, fps: 24 });
  h.dispose();
} catch (e) {
  skipGpu = e.message;
}

test('parseBatchJobs：空任务、重复输出路径、仓库外作品均报 usage.* 错误', () => {
  assert.throws(() => parseBatchJobs([]), e => e.code === 'usage.empty-batch');
  assert.throws(() => parseBatchJobs([
    { work: 'lab/offscreen/ink.mjs', out: '/tmp/same.mp4', frames: '0:4' },
    { work: 'lab/offscreen/ink.mjs', out: '/tmp/same.mp4', frames: '4:8' },
  ], { cwd: ROOT }), e => e.code === 'usage.duplicate-out');
  assert.throws(() => parseBatchJobs([
    { work: '/etc/hosts', out: '/tmp/x.mp4', frames: '0:4' },
  ], { cwd: ROOT }), e => e.code === 'usage.work-outside-repo' || e.code === 'usage.work-not-found');
});

test('runBatch：异构多作业（不同画幅、rgba/yuv420p、render/stills 混排）同卡并发，逐帧哈希与单跑逐位一致', { skip: !hasFfmpeg ? '没有 FFmpeg' : (skipGpu || false) }, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-batch-det-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const makeJobs = tag => parseBatchJobs([
    { id: 'v-yuv', mode: 'render', work: INK, out: path.join(tmp, `${tag}-a.mp4`), frames: '0:6', size: '64x36', pixFmt: 'yuv420p' },
    { id: 'v-rgba', mode: 'render', work: INK, out: path.join(tmp, `${tag}-b.mp4`), frames: '2:7', size: '96x64', pixFmt: 'rgba' },
    { id: 's-png', mode: 'stills', work: INK, out: path.join(tmp, `${tag}-stills`), frames: '0,3,5', size: '64x36' },
  ], { cwd: ROOT });

  const serial = await runBatch(makeJobs('ser'), { gpu, concurrency: 1, maxEncoders: 1 });
  const conc = await runBatch(makeJobs('con'), { gpu, concurrency: 3, maxEncoders: 2 });

  assert.equal(serial.ok, true);
  assert.equal(conc.ok, true);
  assert.equal(conc.results.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(conc.results[i].ok, true);
    assert.deepEqual(conc.results[i].frameHashes, serial.results[i].frameHashes, `作业 ${conc.results[i].id} 并发与串行逐帧哈希必须一致`);
  }
  assert.equal(fs.existsSync(path.join(tmp, 'con-stills/f000003.png')), true);
});

test('runBatch：单个坏作业故障隔离，不污染共用 GPUDevice、不留半成品，其余作业正常产出', { skip: !hasFfmpeg ? '没有 FFmpeg' : (skipGpu || false) }, async t => {
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const badDir = fs.mkdtempSync(path.join(ROOT, 'out/bm-batch-bad-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-batch-iso-'));
  t.after(() => {
    fs.rmSync(badDir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const badWork = path.join(badDir, 'broken.mjs');
  fs.writeFileSync(badWork, 'export function build() { return { render(f) { if (f >= 2) throw new Error("boom-at-2"); } }; }\n');

  const jobs = parseBatchJobs([
    { id: 'good-1', work: INK, out: path.join(tmp, 'good1.mp4'), frames: '0:4', size: '64x36', pixFmt: 'yuv420p' },
    { id: 'broken', work: badWork, out: path.join(tmp, 'broken.mp4'), frames: '0:5', size: '64x36' },
    { id: 'good-2', work: INK, out: path.join(tmp, 'good2.mp4'), frames: '0:4', size: '64x36', pixFmt: 'yuv420p' },
  ], { cwd: ROOT });

  const res = await runBatch(jobs, { gpu, concurrency: 2, failFast: false });
  assert.equal(res.ok, false);
  assert.equal(res.succeeded, 2);
  assert.equal(res.failed, 1);
  assert.equal(res.results[0].ok, true);
  assert.equal(res.results[1].ok, false);
  assert.match(res.results[1].error.message, /boom-at-2/);
  assert.equal(res.results[2].ok, true);
  assert.equal(fs.existsSync(path.join(tmp, 'good1.mp4')), true);
  assert.equal(fs.existsSync(path.join(tmp, 'good2.mp4')), true);
  assert.equal(fs.existsSync(path.join(tmp, 'broken.mp4')), false);
  const leftovers = fs.readdirSync(tmp).filter(n => n.includes('partial'));
  assert.deepEqual(leftovers, []);
});

test('CLI offscreen batch：支持 JSON 清单与多作品位置参数两种入口', { skip: !hasFfmpeg ? '没有 FFmpeg' : (skipGpu || false) }, t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-batch-cli-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const manifest = path.join(tmp, 'jobs.json');
  fs.writeFileSync(manifest, JSON.stringify({
    jobs: [
      { id: 'j1', work: 'lab/offscreen/ink.mjs', out: path.join(tmp, 'm1.mp4'), frames: '0:4', size: '64x36', pixFmt: 'yuv420p' },
      { id: 'j2', mode: 'stills', work: 'lab/offscreen/ink.mjs', out: path.join(tmp, 's2'), frames: '0,2', size: '64x36' },
    ],
  }));
  const r1 = spawnSync(process.execPath, [CLI, 'batch', manifest, '--concurrency', '2', '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r1.status, 0, r1.stderr);
  const j1 = JSON.parse(r1.stdout);
  assert.equal(j1.ok, true);
  assert.equal(j1.data.succeeded, 2);
  assert.equal(j1.outputs.length, 3);

  const outDir = path.join(tmp, 'quick');
  const r2 = spawnSync(process.execPath, [CLI, 'batch', 'lab/offscreen/ink.mjs', 'lab/offscreen/ink.mjs', '--out-dir', outDir, '--frames', '0:3', '--size', '64x36', '--pix-fmt', 'yuv420p', '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  const j2 = JSON.parse(r2.stdout);
  assert.equal(j2.data.succeeded, 2);
  assert.equal(fs.existsSync(path.join(outDir, 'ink-1.mp4')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'ink-2.mp4')), true);
});
