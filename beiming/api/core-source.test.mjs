// 核心帧源接进出片链：一个最小场景包经队列里的作业（renderPlan、sourcePool）出一帧，和直接调 core-render render-pack 出的层逐字节相同；
// 终渲档照帧源原来的规则被拒；没有编好的渲染程序时出片链报 env.missing-tool、不现编；
// 核心作业的准入（预算缺了、采样超档位上限或超声明、场景包三角形数超声明，都在入队之前拒）。准入用一个假的渲染程序
// （按场景包目录里的 fake.json 答 pack-info），不要显卡；拿真程序的 pack-info 对一遍的那条，有编好的程序才跑。
// 作业的墙钟预算用完时看门狗杀 core-render 的进程树（假程序与真程序各一条），同一块卡上排队的、并发的作业照常完成。
// 要渲染程序与显卡的两条：设了 BEIMING_CHASSIS_E2E=1、又有编好的程序（sources/core/source.mjs 的 findRenderer）才跑，否则跳过；不现编。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { test } from 'node:test';
import { loadQueue, openWorkspace, processIsAlive, Scheduler } from '../jobs/index.mjs';
import { PRESETS } from '../sources/core/chassis/build.mjs';
import { platesPack, writePack } from '../sources/core/chassis/scenepack.mjs';
import { ADMIT_MS, WALL_MAX, findRenderer, startSource } from '../sources/core/source.mjs';
import { renderPlan, sourcePool } from './pipeline.mjs';
import { createStore } from './store.mjs';
import { createWork } from './work.mjs';

const E2E = process.env.BEIMING_CHASSIS_E2E === '1';
const SIZE = [64, 36], SPP = 8, SEED = 7;
const LAYERS = ['color.f32', 'objectId.u32'];

/**
 * 假的 core-render，行为照场景包目录里的 fake.json：pack-info 答一行统计（triangles 没写就 4；写了 infoHang 时一直挂着不答）；
 * render-pack 在 --passes 目录写全 0 的颜色层、答一行统计；fake.json 写了 hang（一个目录）时不出帧：把自己和它起的孙进程的
 * 进程号写进 hang/pids.json，收到 SIGTERM 只在 hang/ 下记一笔 term、不退出，一直挂着等 SIGKILL。别的子命令退出 9
 */
function fakeRenderer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-core-fake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'core-render');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const [cmd, dir] = process.argv.slice(2);
const cfg = fs.existsSync(path.join(dir, 'fake.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'fake.json'), 'utf8')) : {};
if (cmd === 'pack-info' && cfg.infoHang) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
if (cmd === 'pack-info') { console.log(JSON.stringify({ format: 'core-pack-info/0.1', id: 'pack:fake@1', frames: 1, triangles: cfg.triangles ?? 4 })); process.exit(0); }
if (cmd !== 'render-pack') process.exit(9);
const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
if (cfg.hang) {
  process.on('SIGTERM', () => fs.writeFileSync(path.join(cfg.hang, 'term'), ''));
  const kid = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(cfg.hang, 'pids.json'), JSON.stringify([process.pid, kid.pid]));
  setInterval(() => {}, 1000);
} else {
  fs.writeFileSync(path.join(flag('--passes'), 'color.f32'), Buffer.alloc(Number(flag('--width')) * Number(flag('--height')) * 16));
  console.log(JSON.stringify({ triangles: 4, adapter: 'fake', backend: 'fake', timings_ms: {} }));
}
`, { mode: 0o755 });
  return bin;
}

/** 这条测试里 BEIMING_CORE_RENDER 指向 bin，测完复原 */
function useRenderer(t, bin) {
  const prev = process.env.BEIMING_CORE_RENDER;
  process.env.BEIMING_CORE_RENDER = bin;
  t.after(() => { if (prev === undefined) delete process.env.BEIMING_CORE_RENDER; else process.env.BEIMING_CORE_RENDER = prev; });
}

/** 挂住的假程序用的目录：测完（也包括测失败、超时）按 pids.json 把假程序与它的孙进程补一次 SIGKILL，再删目录，不留孤儿进程 */
function hangDir(t) {
  const hang = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-core-hang-'));
  t.after(() => {
    const file = path.join(hang, 'pids.json');
    for (const pid of fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []) if (processIsAlive(pid)) process.kill(pid, 'SIGKILL');
    fs.rmSync(hang, { recursive: true, force: true });
  });
  return hang;
}

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

/** 服务端的数据目录里放一部片子：film.json 与场景包，提交成修订 0。不给 lock 时不签锁：作业在执行器里因为没有 film.lock 失败，够看它走哪一道；
 *  给了就照写成 film.lock 一起提交（服务端签锁的 lockContext 里还没有 core 帧源，签不出带核心镜头的锁，这里手写执行器认的那几项） */
function served(t, { lock, fake } = {}) {
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
  // 执行器读的是修订快照：假渲染程序的 fake.json 要在提交之前写进场景包
  if (fake) fs.writeFileSync(ws.resolve('shots/pack/fake.json'), JSON.stringify(fake));
  if (lock) {
    fs.writeFileSync(ws.resolve('film.lock'), JSON.stringify(lock));
    store.writeMeta(id, { id });
  }
  ws.commitRevision(0);
  return { store, id, work: createWork({ store, library: {}, reviewer: null, scheduler: new Scheduler() }) };
}

const BUDGET = { maxTriangles: 100, spp: 24, maxWallMs: 60_000 };

test('草稿档里有核心镜头的渲染作业走 core 道，没有的走 draft 道；片子里有核心镜头的核验作业走 core 道', { timeout: 30_000 }, async (t) => {
  useRenderer(t, fakeRenderer(t));
  const { store, id, work } = served(t);
  const kindOf = async (plan) => {
    const job = work.submit(id, 'render', { tier: 'draft', rev: 0, plan, budget: BUDGET });
    await work.wait(id, job, 10);
    return loadQueue(store.filmDir(id)).getJob(job).request.kind;
  };
  assert.equal(await kindOf([{ shot: 's01', frames: [0] }]), 'core');
  assert.equal(await kindOf([{ shot: 's02', frames: [1] }]), 'draft');
  // 片子里有核心镜头的核验作业也走 core 道，不要求声明预算，墙钟取草稿档的上限
  const verify = work.submit(id, 'verify', { tier: 'draft', rev: 0, shots: ['s02'] });
  await work.wait(id, verify, 10);
  const job = loadQueue(store.filmDir(id)).getJob(verify);
  assert.equal(job.request.kind, 'core');
  assert.deepEqual(job.payload.budget, { maxWallMs: WALL_MAX.draft });
});

test('核心作业的准入：预算缺了、采样超档位上限或超声明、三角形数超声明都在入队之前拒，报登记过的码本身', { timeout: 30_000 }, async (t) => {
  useRenderer(t, fakeRenderer(t));
  const { store, id, work } = served(t);
  const plan = [{ shot: 's01', frames: [0] }];
  const reject = (budget) => {
    try { work.submit(id, 'render', { tier: 'draft', rev: 0, plan, ...(budget === undefined ? {} : { budget }) }); } catch (e) {
      return { code: e.code, diag: e.diagnostics?.[0]?.code, evidence: e.diagnostics?.[0]?.evidence, message: e.message };
    }
    return null;
  };
  // 码登记过了：信封和诊断报的都是它本身，不借近义码，诊断里也没有「原码」
  const missing = { code: 'usage.budget-required', diag: 'usage.budget-required', evidence: undefined };
  const over = { code: 'contract.over-budget', diag: 'contract.over-budget', evidence: undefined };
  const pick = (r) => r && { code: r.code, diag: r.diag, evidence: r.evidence };
  assert.deepEqual(pick(reject(undefined)), missing, '没声明预算');
  assert.deepEqual(pick(reject({ maxTriangles: 100, spp: 24 })), missing, '少一项');
  assert.deepEqual(pick(reject({ ...BUDGET, spp: 0 })), missing, '不是正整数');
  assert.deepEqual(pick(reject({ ...BUDGET, extra: 1 })), missing, '多一项');
  assert.deepEqual(pick(reject({ ...BUDGET, spp: 65 })), over, '超过草稿档的上限 64');
  assert.deepEqual(pick(reject({ ...BUDGET, maxWallMs: WALL_MAX.draft + 1 })), over, '墙钟超过草稿档的上限');
  assert.match(reject({ ...BUDGET, spp: 16 }).message, /每像素采样数是 24，超过声明的 16/);
  fs.writeFileSync(store.workspace(id).resolve('shots/pack/fake.json'), JSON.stringify({ triangles: 101 }));
  const tris = reject(BUDGET);
  assert.deepEqual(pick(tris), over, '三角形数超声明');
  assert.match(tris.message, /101 个三角形，超过声明的 100/);
  assert.deepEqual(loadQueue(store.filmDir(id)).listJobs(), [], '被拒的作业都没进队列');
  // 三角形数等于声明的照收
  fs.writeFileSync(store.workspace(id).resolve('shots/pack/fake.json'), JSON.stringify({ triangles: 100 }));
  const job = work.submit(id, 'render', { tier: 'draft', rev: 0, plan, budget: { ...BUDGET, spp: 64, maxWallMs: WALL_MAX.draft } });
  await work.wait(id, job, 10);
  assert.equal(loadQueue(store.filmDir(id)).getJob(job).request.kind, 'core');
});

test('准入的 pack-info 挂住时，一次提交最多把服务端挡住 ADMIT_MS：到点拒、不进队列', { timeout: 30_000 }, async (t) => {
  useRenderer(t, fakeRenderer(t));
  const { store, id, work } = served(t, { fake: { infoHang: true } });
  const t0 = performance.now();
  const e = (() => { try { work.submit(id, 'render', { tier: 'draft', rev: 0, plan: [{ shot: 's01', frames: [0] }], budget: BUDGET }); } catch (x) { return x; } return null; })();
  const took = performance.now() - t0;
  t.diagnostic(`pack-info 挂住：提交 ${Math.round(took)} ms 后被拒，${e?.code}`);
  assert.equal(e?.code, 'contract.over-budget', e?.message);
  assert.equal(e.diagnostics?.[0]?.code, 'contract.over-budget');
  assert.match(e.message, new RegExp(`准入的 ${ADMIT_MS} ms 里数不完`));
  assert.ok(took >= ADMIT_MS && took < ADMIT_MS + 2000, `到时限才拒：${Math.round(took)} ms`);
  assert.deepEqual(loadQueue(store.filmDir(id)).listJobs(), []);
});

test('准入拿真渲染程序的 pack-info 数三角形：两块板各两个三角形，声明 3 个被拒、4 个照收', { timeout: 30_000 }, async (t) => {
  let bin;
  try { bin = findRenderer(); } catch (e) { t.skip(e.message); return; }
  useRenderer(t, bin);
  const { id, work } = served(t);
  const submit = (maxTriangles) => work.submit(id, 'render', { tier: 'draft', rev: 0, plan: [{ shot: 's01', frames: [0] }], budget: { ...BUDGET, maxTriangles } });
  assert.throws(() => submit(3), /画出来 4 个三角形，超过声明的 3/);
  await work.wait(id, submit(4), 10);
});

test('核心作业到声明的墙钟预算被杀：先 SIGTERM 再 SIGKILL 整棵进程树；同卡排队的核心作业与并发的草稿照常完成', { timeout: 60_000 }, async (t) => {
  useRenderer(t, fakeRenderer(t));
  // 「声明 10 秒、到 10 秒被杀」按 1/10 缩放：声明 1 秒
  const WALL = 1000;
  const hang = hangDir(t);
  const { workspace, film, lock } = coreWorkspace(t);
  fs.writeFileSync(workspace.resolve('shots/pack/fake.json'), JSON.stringify({ hang }));
  workspace.commitRevision(1);
  const at = {}, seen = {};
  const core = async ({ job, snapshot, intermediateDir }) => {
    at[`${job.id}:start`] = performance.now();
    const pool = sourcePool({ library: {}, workspace: snapshot.dir, budget: job.payload.budget });
    try {
      const s = await (await pool.get('core')).open({ film: film.id, output: film.output, shot: film.shots[0] }, { lock, tier: 'draft', workspace: intermediateDir, filmDir: snapshot.dir });
      return (await s.render(0, {}, ['meta', 'color'])).meta.hash.color;
    } catch (e) {
      seen[job.id] = { code: e.code, message: e.message };
      throw e;
    } finally {
      at[`${job.id}:end`] = performance.now();
      await pool.stop();
    }
  };
  // 同卡上的草稿：自己起一个 1.5 秒的子进程，看它是不是被连带杀掉
  const draft = ({ signal }) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore', signal });
    child.on('error', () => {});
    child.on('exit', (code, sig) => resolve({ code, signal: sig }));
  });
  const queue = loadQueue(workspace.root, { scheduler: new Scheduler(), handlers: { core, draft } });
  const budget = { maxTriangles: 100, spp: SPP, maxWallMs: WALL };
  const a = queue.runJob(queue.enqueue({ id: 'hang', kind: 'core', rev: 1, payload: { budget } }).id);
  const c = queue.runJob(queue.enqueue({ id: 'draft', kind: 'draft', rev: 1 }).id);
  const b = queue.runJob(queue.enqueue({ id: 'next', kind: 'core', rev: 0, payload: { budget } }).id);
  while (!fs.existsSync(path.join(hang, 'pids.json'))) await new Promise((r) => setTimeout(r, 20));
  assert.equal(queue.getJob('next').status, 'queued', '第二个核心作业排队');
  assert.equal(queue.getJob('draft').status, 'running', '草稿和核心作业同时在跑');
  const [ja, jb, jc] = await Promise.all([a, b, c]);

  assert.equal(ja.status, 'failed');
  assert.equal(seen.hang?.code, 'timeout.budget', JSON.stringify(seen.hang));
  const took = at['hang:end'] - at['hang:start'];
  t.diagnostic(`声明 ${WALL} ms 的作业从开跑到被杀用了 ${Math.round(took)} ms；排队的核心作业在它之后 ${Math.round(at['next:start'] - at['hang:end'])} ms 开跑`);
  assert.ok(took >= WALL && took < WALL + 2500, `到预算才杀：用了 ${Math.round(took)} ms`);
  assert.ok(fs.existsSync(path.join(hang, 'term')), '先发了 SIGTERM');
  const pids = JSON.parse(fs.readFileSync(path.join(hang, 'pids.json'), 'utf8'));
  assert.deepEqual(pids.map((pid) => processIsAlive(pid)), [false, false], '渲染进程与它的孙进程都死了（SIGTERM 不理，SIGKILL 收掉）');

  assert.equal(jb.status, 'succeeded');
  assert.match(jb.result, /^sha256:/);
  assert.ok(at['next:start'] >= at['hang:end'], '第二个核心作业等第一个被杀、还了租约才开跑');
  assert.equal(jc.status, 'succeeded');
  assert.deepEqual(jc.result, { code: 0, signal: null }, '同卡的草稿作业的进程没被连带杀掉');
});

test('经服务端提交的核心作业到声明的墙钟预算被杀：作业 failed，结论里是 timeout.budget', { timeout: 60_000 }, async (t) => {
  useRenderer(t, fakeRenderer(t));
  // 没有 Blender 时执行器用解析式的查找表，不去烘焙；这部片子是显示参考，用不上正式表
  const prev = process.env.BEIMING_BLENDER;
  process.env.BEIMING_BLENDER = path.join(os.tmpdir(), 'no-such-blender');
  t.after(() => { if (prev === undefined) delete process.env.BEIMING_BLENDER; else process.env.BEIMING_BLENDER = prev; });
  const hang = hangDir(t);
  const { id, work } = served(t, { lock: { format: 'lock/1.0', issuer: 'server', rev: 0, film: 'f_001', seeds: { s01: SEED, s02: SEED }, shots: { s01: { shutterSamples: 1 }, s02: { shutterSamples: 1 } } }, fake: { hang } });
  const WALL = 1000;
  const t0 = performance.now();
  const job = work.submit(id, 'render', { tier: 'draft', rev: 0, plan: [{ shot: 's01', frames: [0] }], budget: { ...BUDGET, maxWallMs: WALL } });
  await work.wait(id, job, 30);
  const took = performance.now() - t0;
  const { base, outcome } = work.view(id, job);
  t.diagnostic(`声明 ${WALL} ms：${Math.round(took)} ms 时作业 ${base.status}，结论码 ${outcome?.code}`);
  assert.equal(base.status, 'failed', JSON.stringify(outcome));
  assert.equal(outcome.code, 'timeout.budget');
  assert.equal(outcome.diagnostics?.[0]?.code, 'timeout.budget');
  assert.match(outcome.message, /timeout\.budget/);
  assert.deepEqual(outcome.next.map((n) => n.verb), [`POST /v1/films/${id}/render`], '超时的提示是重新提交渲染，不叫人改片子');
  assert.ok(took >= WALL && took < WALL + 5000, `到预算才杀：用了 ${Math.round(took)} ms`);
  const pids = JSON.parse(fs.readFileSync(path.join(hang, 'pids.json'), 'utf8'));
  assert.deepEqual(pids.map((pid) => processIsAlive(pid)), [false, false], '渲染进程与它的孙进程都不在了');
});

test('帧源 stop 收掉还在跑的 core-render 进程树：作业取消、测试收尾时不留孤儿进程', { timeout: 30_000 }, async (t) => {
  const bin = fakeRenderer(t), hang = hangDir(t);
  const { workspace, film, lock } = coreWorkspace(t);
  fs.writeFileSync(workspace.resolve('shots/pack/fake.json'), JSON.stringify({ hang }));
  const src = await startSource({ bin });
  const s = await src.open({ film: film.id, output: film.output, shot: film.shots[0] }, { lock, tier: 'draft', workspace: workspace.resolve('intermediate/stop'), filmDir: workspace.root });
  const rendering = s.render(0, {}, ['color']).then(() => null, (e) => e);
  while (!fs.existsSync(path.join(hang, 'pids.json'))) await new Promise((r) => setTimeout(r, 20));
  const pids = JSON.parse(fs.readFileSync(path.join(hang, 'pids.json'), 'utf8'));
  await src.stop();
  assert.ok(await rendering, '渲到一半被 stop 的 render 报错，不当成出了帧');
  for (let i = 0; i < 50 && pids.some((pid) => processIsAlive(pid)); i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(pids.map((pid) => processIsAlive(pid)), [false, false], '渲染进程与它的孙进程都不在了');
});

test('真渲染程序：墙钟预算用完时正在渲的 core-render 被杀，同一块卡上另一个会话照常出帧', { timeout: 120_000 }, async (t) => {
  const bin = rendererOrSkip(t);
  if (!bin) return;
  const WALL = 2000;
  const { workspace, film } = coreWorkspace(t);
  const input = (size) => ({ film: film.id, output: { size, fps: '24/1' }, shot: { ...film.shots[0], tiers: undefined, seed: SEED } });
  const env = (name) => ({ lock: null, tier: 'draft', workspace: workspace.resolve(`intermediate/${name}`), filmDir: workspace.root });
  const victim = await startSource({ bin, maxWallMs: WALL }), other = await startSource({ bin });
  // 测失败（没杀掉、超时）时也收掉两个帧源在跑的 core-render，不让它留在显卡上一直渲
  t.after(() => Promise.all([victim.stop(), other.stop()]));
  const t0 = performance.now();
  // 一帧 1920×1080、每像素二十万个样本：远远渲不完，到点被杀
  const a = (await victim.open(input([1920, 1080]), env('a'))).render(0, { samples: 200_000, scale: 1 }, ['color']).then(() => null, (e) => e);
  const b = (await other.open(input([480, 270]), env('b'))).render(0, { samples: 256, scale: 1 }, ['color']);
  const [killed, done] = await Promise.all([a, b]);
  const took = performance.now() - t0;
  t.diagnostic(`声明 ${WALL} ms：${Math.round(took)} ms 时被杀的会话报 ${killed?.code}，另一个会话在 ${done.meta.source.gpu}（${done.meta.source.backend}）上出了帧`);
  assert.equal(killed?.code, 'timeout.budget', killed?.message);
  assert.ok(took < WALL + 5000, `到点就杀：${Math.round(took)} ms`);
  assert.ok(killed.killed.length > 0 && killed.killed.every((pid) => !processIsAlive(pid)), `被杀的进程都不在了：${killed.killed}`);
  assert.deepEqual(killed.survivors, []);
  assert.match(done.meta.hash.color, /^sha256:/);
});
