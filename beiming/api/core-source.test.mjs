// 核心帧源接进出片链：一个最小场景包经队列里的作业（renderPlan、sourcePool）出一帧，和直接调 core-render render-pack 出的层逐字节相同；
// 终渲档照帧源原来的规则被拒；没有编好的渲染程序时出片链报 env.missing-tool、不现编。
// 要渲染程序与显卡的那条：设了 BEIMING_CHASSIS_E2E=1、又有编好的程序（sources/core/source.mjs 的 findRenderer）才跑，否则跳过；不现编。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { loadQueue, openWorkspace, Scheduler } from '../jobs/index.mjs';
import { PRESETS } from '../sources/core/chassis/build.mjs';
import { platesPack, writePack } from '../sources/core/chassis/scenepack.mjs';
import { findRenderer } from '../sources/core/source.mjs';
import { renderPlan, sourcePool } from './pipeline.mjs';
import { createStore } from './store.mjs';
import { createWork } from './work.mjs';

const E2E = process.env.BEIMING_CHASSIS_E2E === '1';
const SIZE = [64, 36], SPP = 8, SEED = 7;
const LAYERS = ['color.f32', 'objectId.u32'];

function rendererOrSkip(t) {
  if (!E2E) { t.skip('没设 BEIMING_CHASSIS_E2E=1'); return null; }
  try { return findRenderer(); } catch (e) { t.skip(e.message); return null; }
}

/** 工作区：film.json、film.lock 之外，shots/pack/ 是两块板的场景包 */
function coreWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-core-pipeline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = openWorkspace(root);
  writePack(workspace.resolve('shots/pack'), platesPack());
  const film = {
    format: 'film/3.0', id: 'core-e2e', output: { size: SIZE, fps: '24/1', frames: 1 },
    shots: [{ id: 's01', in: 0, out: 1, source: 'core', host: 'offscreen', mode: 'build-script', entry: 'shots/pack', colorRef: 'display', tiers: { draft: { samples: SPP, scale: 1 } } }],
  };
  fs.writeFileSync(workspace.resolve('film.json'), JSON.stringify(film));
  workspace.commitRevision(0);
  const lock = { film: film.id, seeds: { s01: SEED }, shots: { s01: { shutterSamples: 1 } } };
  return { workspace, film, lock };
}

/** 一个作业：照 api/work.mjs 的 render 执行器，经 sourcePool 与 renderPlan 出 plan 里的帧 */
const renderHandler = ({ film, lock, tier }) => async ({ snapshot, intermediateDir, signal }) => {
  const pool = sourcePool({ library: {}, workspace: snapshot.dir });
  try {
    const out = await renderPlan({ film, lock, filmDir: snapshot.dir, tier, plan: [{ shot: film.shots[0], frames: [0] }], outDir: intermediateDir, pool, signal });
    return { renders: pool.renders, records: out.records.map((r) => ({ color: r.color, files: r.files, meta: r.meta })) };
  } finally {
    await pool.stop();
  }
};

test('最小场景包经出片链的作业出一帧，颜色层与编号层和直接调 core-render render-pack 出的逐字节相同', { timeout: 120_000 }, async (t) => {
  const bin = rendererOrSkip(t);
  if (!bin) return;
  const { workspace, film, lock } = coreWorkspace(t);
  const queue = loadQueue(workspace.root, { scheduler: new Scheduler(), handlers: { render: renderHandler({ film, lock, tier: 'draft' }) } });
  const job = await queue.runJob(queue.enqueue({ kind: 'draft', handler: 'render', rev: 0, keep: 'all' }).id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.events.at(-1)));
  const [rec] = job.result.records;
  assert.deepEqual(job.result.renders, { s01: 1 });
  assert.equal(rec.meta.source.renderer, 'core');
  assert.deepEqual(rec.meta.size, SIZE);

  // 直接调渲染程序：同一个场景包、同一帧、同样的采样数、画幅与种子
  const direct = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-core-direct-'));
  t.after(() => fs.rmSync(direct, { recursive: true, force: true }));
  const { THREERT_SEED: _s, THREERT_HWRT: _h, ...env } = process.env;
  const r = spawnSync(bin, ['render-pack', workspace.resolve('shots/pack'), '--frame', '0', '--spp', String(SPP), '--width', String(SIZE[0]), '--height', String(SIZE[1]),
    '--no-denoise', '-o', path.join(direct, 'preview.png'), '--passes', direct, '--presets', PRESETS], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, THREERT_SEED: String(SEED) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const ours = { 'color.f32': rec.color, 'objectId.u32': rec.files['objectId.u32'] };
  for (const name of LAYERS) assert.ok(fs.readFileSync(ours[name]).equals(fs.readFileSync(path.join(direct, name))), `${name} 和直接调渲染程序出的不是逐字节相同`);
});

test('终渲档经出片链照帧源原来的规则拒：contract.unsupported-mode，信息里有「还没过门」', { timeout: 60_000 }, async (t) => {
  const { workspace, film, lock } = coreWorkspace(t);
  // 帧源在 open 时就拒，不起渲染程序：给一个不存在的程序路径也一样
  const prev = process.env.BEIMING_CORE_RENDER;
  process.env.BEIMING_CORE_RENDER = path.join(workspace.root, 'no-such-renderer');
  t.after(() => { if (prev === undefined) delete process.env.BEIMING_CORE_RENDER; else process.env.BEIMING_CORE_RENDER = prev; });
  const pool = sourcePool({ library: {}, workspace: workspace.root });
  try {
    const e = await renderPlan({ film, lock, filmDir: workspace.root, tier: 'final', plan: [{ shot: film.shots[0], frames: [0] }], outDir: path.join(workspace.root, 'intermediate', 'final'), pool }).then(() => null, (x) => x);
    assert.equal(e?.code, 'contract.unsupported-mode');
    assert.match(e.message, /还没过门/);
  } finally {
    await pool.stop();
  }
});

test('没有编好的渲染程序：出片链起核心帧源报 env.missing-tool，不现编', async (t) => {
  const prev = process.env.BEIMING_CORE_RENDER;
  delete process.env.BEIMING_CORE_RENDER;
  t.after(() => { if (prev !== undefined) process.env.BEIMING_CORE_RENDER = prev; });
  let built = true;
  try { findRenderer(); } catch { built = false; }
  if (built) { t.skip('这台机器上有编好的程序，判不了缺的情形'); return; }
  const pool = sourcePool({ library: {}, workspace: os.tmpdir() });
  const e = await pool.get('core').then(() => null, (x) => x);
  assert.equal(e?.code, 'env.missing-tool');
  await pool.stop();
});

/** 服务端的数据目录里放一部片子：film.json 与场景包，提交成修订 0（不签锁：作业在执行器里因为没有 film.lock 失败，够看它走哪一道） */
function served(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-core-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir), id = 'f_001';
  const ws = store.workspace(id);
  writePack(ws.resolve('shots/pack'), platesPack());
  fs.writeFileSync(ws.resolve('film.json'), JSON.stringify({
    format: 'film/3.0', id, output: { size: SIZE, fps: '24/1', frames: 2 },
    shots: [
      { id: 's01', in: 0, out: 1, source: 'core', host: 'offscreen', mode: 'build-script', entry: 'shots/pack', colorRef: 'display' },
      { id: 's02', in: 1, out: 2, source: 'three', host: 'page', mode: 'cards-data', colorRef: 'display' },
    ],
  }));
  ws.commitRevision(0);
  return { store, id, work: createWork({ store, library: {}, reviewer: null, scheduler: new Scheduler() }) };
}

test('草稿档里有核心镜头的渲染作业走 core 道，没有的走 draft 道', { timeout: 30_000 }, async (t) => {
  const { store, id, work } = served(t);
  const kindOf = async (plan) => {
    const job = work.submit(id, 'render', { tier: 'draft', rev: 0, plan });
    await work.wait(id, job, 10);
    return loadQueue(store.filmDir(id)).getJob(job).request.kind;
  };
  assert.equal(await kindOf([{ shot: 's01', frames: [0] }]), 'core');
  assert.equal(await kindOf([{ shot: 's02', frames: [1] }]), 'draft');
});
