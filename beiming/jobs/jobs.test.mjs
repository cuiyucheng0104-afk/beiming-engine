import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadQueue, openWorkspace, replayJob, Scheduler } from './index.mjs';

const api = new URL('./index.mjs', import.meta.url).href;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = openWorkspace(root);
  const film = { format: 'film/3.0', id: 'demo', output: { size: [16, 16], fps: '24', frames: 1 },
    shots: [{ id: 's01', in: 0, out: 1, source: 'three', host: 'page', mode: 'build-script',
      entry: 'shots/s01.mjs', colorRef: 'scene' }],
    style: { view: { scene: 'linear', display: 'srgb' } }, predicates: { base: [] }, delivery: { master: 'test' } };
  fs.writeFileSync(workspace.resolve('film.json'), JSON.stringify(film));
  fs.writeFileSync(workspace.resolve('shots/s01.mjs'), 'initial');
  fs.writeFileSync(workspace.resolve('assets/source.bin'), Buffer.from([0, 1, 255]));
  return workspace;
}

function queueFixture(t, { handlers = { draft: () => 'ok' }, ...options } = {}) {
  const workspace = fixture(t);
  workspace.commitRevision(0);
  const queue = loadQueue(workspace.root, { handlers, ...options });
  const enqueue = spec => queue.enqueue({ kind: 'draft', rev: 0, ...spec });
  return { workspace, queue, enqueue };
}

function device() {
  return new Scheduler({ totalMB: 1000, previewReserveMB: 200,
    budgetsMB: { final: 800, draft: 600, preview: 200, verify: 100 } });
}

function writePartial(intermediateDir) {
  const file = path.join(intermediateDir, 'partial.bin');
  fs.writeFileSync(file, 'partial');
  return file;
}

function aborting(signal, settled = Promise.resolve()) {
  if (signal.aborted) return settled.then(() => signal.throwIfAborted());
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => settled.then(resolve, reject), { once: true });
  }).then(() => signal.throwIfAborted());
}

async function stillPending(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
}

function readInput({ inputPath }) {
  return fs.readFileSync(inputPath('shots/s01.mjs'), 'utf8');
}

test('工作区布置输入、快照、中间产物、交付和队列目录', t => {
  const workspace = fixture(t);
  for (const dir of ['shots', 'assets', 'snapshots', 'intermediate', 'deliver', 'jobs']) {
    assert.ok(fs.statSync(workspace.resolve(dir)).isDirectory());
  }
  assert.equal(workspace.readRevision(), undefined);
  workspace.commitRevision(0);
  assert.equal(workspace.readRevision(), 0);
  assert.equal(JSON.parse(fs.readFileSync(workspace.resolve('film.json'))).rev, undefined);
});

test('修订快照冻结后续改写与删除，清单依路径顺序记录 SHA-256', t => {
  const workspace = fixture(t);
  const ref = workspace.commitRevision(0);
  fs.writeFileSync(workspace.resolve('shots/s01.mjs'), 'changed');
  fs.rmSync(workspace.resolve('assets/source.bin'));
  const { dir, manifest } = workspace.openSnapshot(workspace.snapshot({ rev: 0 }));
  assert.deepEqual(workspace.snapshot({ rev: 0 }), ref);
  assert.deepEqual(manifest.files.map(file => file.path), ['assets/source.bin', 'film.json', 'shots/s01.mjs']);
  assert.equal(manifest.files[0].sha256, '26a66b061e8f48f39927c312f25293959729eee95978e2892d49d3512a5cc092');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'assets/source.bin')), Buffer.from([0, 1, 255]));
  assert.equal(fs.readFileSync(path.join(dir, 'shots/s01.mjs'), 'utf8'), 'initial');
});

test('同一修订可幂等发布，拒绝不同字节覆盖', t => {
  const workspace = fixture(t);
  assert.deepEqual(workspace.commitRevision(1), workspace.commitRevision(1));
  fs.writeFileSync(workspace.resolve('shots/s01.mjs'), 'changed');
  assert.throws(() => workspace.commitRevision(1), { code: 'contract.bad-value' });
  assert.equal(workspace.readRevision(), 1);
});

test('发布新修订后保留旧快照，拒绝回退当前修订', t => {
  const workspace = fixture(t);
  const first = workspace.commitRevision(0);
  const second = workspace.commitRevision(2);
  assert.notEqual(first.sha256, second.sha256);
  assert.deepEqual(workspace.snapshot({ rev: 0 }), first);
  assert.throws(() => workspace.commitRevision(1), { code: 'busy.rev-conflict', latestRev: 2 });
});

test('终渲与已提交快照不能从未知修订隐式读取工作区', t => {
  const workspace = fixture(t);
  const queue = loadQueue(workspace.root);
  assert.throws(() => queue.enqueue({ kind: 'final', rev: 3 }), { code: 'ENOENT' });
  assert.throws(() => queue.enqueue({ kind: 'final', uncommitted: true }), /已提交/);
  assert.throws(() => workspace.commitRevision(0.5), /整数/);
  assert.deepEqual(queue.listJobs(), []);
});

test('正式锁按原字节冻结并与修订和片子匹配', t => {
  const workspace = fixture(t);
  const lock = JSON.stringify({ format: 'lock/1.0', film: 'demo', issuer: 'server', rev: 0 });
  fs.writeFileSync(workspace.resolve('film.lock'), lock);
  const ref = workspace.commitRevision(0);
  assert.equal(fs.readFileSync(path.join(workspace.openSnapshot(ref).dir, 'film.lock'), 'utf8'), lock);
  assert.throws(() => workspace.commitRevision(1), { code: 'contract.bad-value' });
  assert.equal(workspace.readRevision(), 0);
});

test('未提交快照拥有独立摘要并冻结当前字节', async t => {
  const { workspace, queue, enqueue } = queueFixture(t, { handlers: { draft: readInput } });
  fs.writeFileSync(workspace.resolve('shots/s01.mjs'), 'dirty');
  const job = enqueue({ rev: undefined, uncommitted: true });
  assert.equal(job.snapshot.uncommitted, true);
  assert.equal(job.snapshot.rev, undefined);
  assert.notEqual(job.snapshot.sha256, workspace.snapshot({ rev: 0 }).sha256);
  fs.writeFileSync(workspace.resolve('shots/s01.mjs'), 'later');
  assert.equal((await queue.runJob(job.id)).result, 'dirty');
  assert.notEqual(workspace.snapshot({ uncommitted: true }).sha256, job.snapshot.sha256);
});

test('快照排除工作区自身的元数据和作业产物', t => {
  const workspace = fixture(t);
  const first = workspace.snapshot({ uncommitted: true });
  workspace.commitRevision(0);
  for (const dir of ['intermediate', 'deliver', 'jobs']) fs.writeFileSync(workspace.resolve(`${dir}/output.bin`), dir);
  assert.deepEqual(workspace.snapshot({ uncommitted: true }), first);
});

test('被改写的快照无法执行', async t => {
  let called = false;
  const { workspace, queue, enqueue } = queueFixture(t, { handlers: { draft: () => { called = true; } } });
  const job = enqueue();
  const { dir } = workspace.openSnapshot(job.snapshot);
  fs.writeFileSync(path.join(dir, 'shots/s01.mjs'), 'tampered');
  const result = await queue.runJob(job.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /不一致/);
  assert.equal(called, false);
});

test('拒绝相对跳转、绝对路径、盘符与反斜杠', t => {
  const workspace = fixture(t);
  const drivePath = ['c', '/film.json'].join(':');
  for (const name of ['../outside', 'shots/../film.json', '/film.json', drivePath, 'shots\\escape', 'shots//a', '']) {
    assert.throws(() => workspace.resolve(name), { code: 'contract.bad-path' });
  }
  assert.throws(() => workspace.cleanupIntermediate('../outside', { keep: 'none', status: 'failed' }), { code: 'contract.bad-path' });
});

test('冻结时拒绝镜头与替代渲染器入口的路径穿越', t => {
  const workspace = fixture(t);
  const file = workspace.resolve('film.json');
  const film = JSON.parse(fs.readFileSync(file));
  const shot = film.shots[0];
  shot.entry = '../outside.mjs';
  fs.writeFileSync(file, JSON.stringify(film));
  assert.throws(() => workspace.commitRevision(0), { code: 'contract.bad-path' });
  shot.entry = 'shots/s01.mjs';
  shot.renderer = { source: 'three', host: 'page', mode: 'build-script', entry: '../outside.mjs' };
  fs.writeFileSync(file, JSON.stringify(film));
  assert.throws(() => workspace.snapshot({ uncommitted: true }), { code: 'contract.bad-path' });
  assert.deepEqual(fs.readdirSync(workspace.resolve('snapshots')), []);
});

test('拒绝快照输入中的外部符号链接', t => {
  const workspace = fixture(t);
  fs.symlinkSync(workspace.resolve('film.json'), workspace.resolve('shots/link'));
  assert.throws(() => workspace.snapshot({ uncommitted: true }), { code: 'contract.bad-path' });
  assert.deepEqual(fs.readdirSync(workspace.resolve('snapshots')), []);
});

test('清理拒绝符号链接根，只移除中间产物下的符号链接本身', t => {
  const workspace = fixture(t);
  fs.symlinkSync(workspace.resolve('assets'), workspace.resolve('intermediate/link'));
  assert.throws(() => workspace.cleanupIntermediate('link', { keep: 'none', status: 'failed' }), { code: 'contract.bad-path' });
  fs.mkdirSync(workspace.intermediateDir('job'));
  fs.symlinkSync(workspace.resolve('assets'), workspace.resolve('intermediate/job/link'));
  workspace.cleanupIntermediate('job', { keep: 'none', status: 'failed' });
  assert.ok(fs.existsSync(workspace.resolve('assets/source.bin')));
  assert.equal(fs.existsSync(workspace.intermediateDir('job')), false);
});

test('队列以 JSON 存储快照、执行器名称和输入，新实例可直接加载', t => {
  const { workspace, queue, enqueue } = queueFixture(t);
  const payload = { frames: [0], enabled: true };
  const job = enqueue({ payload });
  payload.frames.push(1);
  const stored = JSON.parse(fs.readFileSync(queue.jobFile(job.id)));
  assert.deepEqual(stored.payload, { frames: [0], enabled: true });
  assert.equal(stored.handler, 'draft');
  assert.deepEqual(stored.snapshot, workspace.snapshot({ rev: 0 }));
  assert.deepEqual(loadQueue(workspace.root).listJobs(), [stored]);
});

test('队列拒绝不可重放的数据及重复标识', t => {
  const { queue, enqueue } = queueFixture(t);
  const cycle = {};
  cycle.self = cycle;
  for (const value of [cycle, new Map(), { value: Number.NaN }, { fn() {} }, [undefined]]) {
    assert.throws(() => enqueue({ payload: value }), /纯 JSON/);
  }
  enqueue({ id: 'same' });
  assert.throws(() => enqueue({ id: 'same' }), /已/);
  assert.equal(queue.listJobs().length, 1);
});

test('新进程读取并重放旧 job.json，使用相同输入快照', async t => {
  const { workspace, queue, enqueue } = queueFixture(t, { handlers: { draft: readInput } });
  const job = enqueue();
  assert.equal((await queue.runJob(job.id)).result, 'initial');
  fs.writeFileSync(workspace.resolve('shots/s01.mjs'), 'changed');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { loadQueue, replayJob } from ${JSON.stringify(api)};
    import fs from 'node:fs';
    const [root, file, id] = process.argv.slice(1);
    const original = loadQueue(root).getJob(id);
    const replay = await replayJob(file, { draft: ({ inputPath }) => fs.readFileSync(inputPath('shots/s01.mjs'), 'utf8') });
    console.log(JSON.stringify([original.status, replay.result, replay.attempt, replay.snapshot]));
  `, workspace.root, queue.jobFile(job.id), job.id], { encoding: 'utf8', timeout: 25_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ['succeeded', 'initial', 2, job.snapshot]);
  assert.equal(queue.getJob(job.id).attempt, 2);
});

test('新进程重放已退出执行器的运行轮次并保留中断记录', { timeout: 30_000 }, async t => {
  const { queue, enqueue, workspace } = queueFixture(t);
  const job = enqueue();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { loadQueue } from ${JSON.stringify(api)};
    const [root, id] = process.argv.slice(1);
    const queue = loadQueue(root, { handlers: { draft: ({ step }) => step('render:s01', () => process.exit(0)) } });
    await queue.runJob(id);
  `, workspace.root, job.id], { encoding: 'utf8', timeout: 25_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(queue.getJob(job.id).status, 'running');
  const replayed = await replayJob(queue.jobFile(job.id), { draft: readInput });
  assert.equal(replayed.status, 'succeeded');
  assert.equal(replayed.attempt, 2);
  assert.equal(replayed.events.find(event => event.type === 'stopped').reason, 'interrupted');
  assert.equal(replayed.steps[0].status, 'stopped');
  assert.equal(replayed.steps[0].durationMs, undefined);
});

test('仍在执行的作业不能跨进程重复启动或重放', { timeout: 30_000 }, async t => {
  const { queue, enqueue, workspace } = queueFixture(t);
  const job = enqueue();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { loadQueue } from ${JSON.stringify(api)};
    const [root, id] = process.argv.slice(1);
    const queue = loadQueue(root, { handlers: { draft: async () => {
      process.stdin.resume();
      process.stdout.write('running');
      await new Promise(resolve => process.stdin.once('end', resolve));
      return 'child';
    } } });
    await queue.runJob(id);
  `, workspace.root, job.id], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const exited = once(child, 'exit');
  await Promise.race([once(child.stdout, 'data'), exited.then(([code]) => assert.fail(`执行器提前退出 ${code}`))]);
  try {
    assert.equal(queue.getJob(job.id).status, 'running');
    assert.throws(() => replayJob(queue.jobFile(job.id), { draft: readInput }), /仍由执行进程/);
    assert.throws(() => queue.runJob(job.id), /排队/);
  } finally {
    child.stdin.end();
  }
  assert.deepEqual(await exited, [0, null]);
  assert.equal(queue.getJob(job.id).result, 'child');
});

test('分步计时记录全部步骤顺序、索引和毫秒耗时', async t => {
  const names = ['lock', 'eval', 'render:s01', 'render:s02', 'comp', 'verify'];
  const durations = [1, 2.5, 42, 21, 0, 8];
  let ms = 100;
  const { queue, enqueue } = queueFixture(t, { clock: () => ms, handlers: { draft: async ({ step }) => {
    for (const [index, name] of names.entries()) await step(name, () => { ms += durations[index]; });
  } } });
  const job = await queue.runJob(enqueue().id);
  assert.deepEqual(job.steps.map(step => step.name), names);
  assert.deepEqual(job.steps.map(step => step.durationMs), durations);
  for (const step of job.steps) {
    assert.equal(job.events[step.startEvent - 1].type, 'step-start');
    assert.equal(job.events[step.endEvent - 1].type, 'step-end');
    assert.deepEqual(Object.keys(step).sort(), ['attempt', 'durationMs', 'endEvent', 'name', 'startEvent', 'status']);
  }
  assert.equal(job.status, 'succeeded');
});

test('失败步骤仍记录起止和耗时，保留失败原因', async t => {
  let ms = 0;
  const { queue, enqueue } = queueFixture(t, { clock: () => ms, handlers: { draft: ({ step }) => step('render', () => {
    ms += 7;
    throw new Error('fixture failed');
  }) } });
  const job = await queue.runJob(enqueue().id);
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'fixture failed');
  assert.deepEqual(job.steps[0], { name: 'render', attempt: 1, startEvent: 3, status: 'failed', durationMs: 7, endEvent: 4 });
});

test('拒绝倒退的虚拟时钟并结束步骤记录', async t => {
  let ms = 10;
  const { queue, enqueue } = queueFixture(t, { clock: () => ms--, handlers: { draft: ({ step }) => step('eval', () => 1) } });
  const job = await queue.runJob(enqueue().id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /单调/);
  assert.equal(job.steps[0].endEvent, 4);
  assert.equal(job.steps[0].durationMs, undefined);
});

test('两次终渲提交严格串行，第二项在等待时状态为 queued', { timeout: 30_000 }, async t => {
  const gate = Promise.withResolvers();
  const starts = [];
  const { queue, enqueue } = queueFixture(t, { scheduler: device(), handlers: { final: async ({ job }) => {
    starts.push(job.id);
    if (job.id === 'first') await gate.promise;
  } } });
  const first = queue.runJob(enqueue({ id: 'first', kind: 'final', vramMB: 200 }).id);
  const second = queue.runJob(enqueue({ id: 'second', kind: 'final', vramMB: 200 }).id);
  await stillPending(second);
  assert.deepEqual(starts, ['first']);
  assert.equal(queue.getJob('second').status, 'queued');
  gate.resolve();
  assert.deepEqual((await Promise.all([first, second])).map(job => job.status), ['succeeded', 'succeeded']);
  assert.deepEqual(starts, ['first', 'second']);
});

test('终渲占满主预算时预览并发运行', { timeout: 30_000 }, async t => {
  const gate = Promise.withResolvers();
  const { queue, enqueue } = queueFixture(t, { scheduler: device(), handlers: {
    final: () => gate.promise,
    preview: () => queue.getJob('final').status,
  } });
  const final = queue.runJob(enqueue({ id: 'final', kind: 'final' }).id);
  try {
    const preview = await queue.runJob(enqueue({ kind: 'preview' }).id);
    assert.equal(preview.result, 'running');
  } finally {
    gate.resolve();
    await final;
  }
});

test('同一设备调度器在不同工作区之间也互斥终渲', { timeout: 30_000 }, async t => {
  const scheduler = device();
  const gate = Promise.withResolvers();
  const first = queueFixture(t, { scheduler, handlers: { final: () => gate.promise } });
  const second = queueFixture(t, { scheduler, handlers: { final: () => 'second' } });
  const firstRun = first.queue.runJob(first.enqueue({ kind: 'final' }).id);
  const secondRun = second.queue.runJob(second.enqueue({ kind: 'final' }).id);
  try {
    await stillPending(secondRun);
    assert.equal(second.queue.listJobs()[0].status, 'queued');
  } finally {
    gate.resolve();
  }
  await firstRun;
  assert.equal((await secondRun).result, 'second');
});

test('终渲中止草稿并等它释放，草稿重排后保留同一快照', { timeout: 30_000 }, async t => {
  const entered = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  const released = Promise.withResolvers();
  const { workspace, queue, enqueue } = queueFixture(t, { scheduler: device(), handlers: {
    draft: ({ job, signal, step, intermediateDir, inputPath }) => step('render:s01', async () => {
      if (job.attempt > 1) return readInput({ inputPath });
      writePartial(intermediateDir);
      signal.addEventListener('abort', () => stopped.resolve(signal.reason), { once: true });
      entered.resolve();
      return aborting(signal, released.promise);
    }),
    final: () => assert.equal(fs.existsSync(workspace.intermediateDir('draft', 1)), false),
  } });
  const draftJob = enqueue({ id: 'draft' });
  const draft = queue.runJob(draftJob.id);
  await entered.promise;
  const finalJob = enqueue({ kind: 'final' });
  const final = queue.runJob(finalJob.id);
  try {
    assert.equal(await stopped.promise, 'preempted');
    assert.equal(queue.getJob(finalJob.id).status, 'queued');
    assert.equal(queue.getJob(draftJob.id).status, 'running');
    fs.writeFileSync(workspace.resolve('shots/s01.mjs'), 'changed');
  } finally {
    released.resolve();
  }
  const [rerun, rendered] = await Promise.all([draft, final]);
  assert.equal(rendered.status, 'succeeded');
  assert.equal(rerun.attempt, 2);
  assert.deepEqual(rerun.snapshot, draftJob.snapshot);
  assert.equal(rerun.result, 'initial');
  assert.equal(rerun.events.find(event => event.type === 'stopped').reason, 'preempted');
  assert.deepEqual(rerun.steps.map(step => step.status), ['stopped', 'succeeded']);
});

test('高优预览在预算不足时抢占草稿，停止前保留显存', { timeout: 30_000 }, async () => {
  const scheduler = device();
  const draft = await scheduler.acquire({ kind: 'draft' });
  const pending = scheduler.acquire({ kind: 'preview', vramMB: 500, priority: 'high' });
  assert.equal(draft.signal.reason, 'preempted');
  await stillPending(pending);
  draft.release();
  (await pending).release();
});

test('普通预览和轻量核验等待预算，核验可以用预留显存', { timeout: 30_000 }, async () => {
  const scheduler = device();
  const draft = await scheduler.acquire({ kind: 'draft', vramMB: 800 });
  const verify = await scheduler.acquire({ kind: 'verify' });
  const pending = scheduler.acquire({ kind: 'preview', vramMB: 300, priority: 'normal' });
  assert.equal(draft.signal.aborted, false);
  await stillPending(pending);
  draft.release();
  (await pending).release();
  verify.release();
});

test('预算校验拒绝无法调度的请求与保留区配置', () => {
  assert.throws(() => new Scheduler({ totalMB: 10, previewReserveMB: 10 }), /预算/);
  const scheduler = device();
  assert.throws(() => scheduler.acquire({ kind: 'final', vramMB: 801 }), /预算/);
  assert.throws(() => scheduler.acquire({ kind: 'preview', vramMB: 1001 }), /预算/);
  assert.throws(() => scheduler.acquire({ kind: 'unknown' }), /类别/);
});

test('排队终渲取消后允许后继终渲取得租约', { timeout: 30_000 }, async () => {
  const scheduler = device();
  const running = await scheduler.acquire({ kind: 'final' });
  const controller = new AbortController();
  const canceled = scheduler.acquire({ kind: 'final' }, { signal: controller.signal });
  const later = scheduler.acquire({ kind: 'final' });
  controller.abort('canceled');
  await assert.rejects(canceled, error => error === 'canceled');
  running.release();
  running.release();
  (await later).release();
});

test('取消运行中的作业触发中止并删除半截产物', { timeout: 30_000 }, async t => {
  const entered = Promise.withResolvers();
  const { workspace, queue, enqueue } = queueFixture(t, { handlers: { draft: ({ signal, intermediateDir }) => {
    writePartial(intermediateDir);
    entered.resolve(signal);
    return aborting(signal);
  } } });
  const job = enqueue({ keep: 'failed-only' });
  const running = queue.runJob(job.id);
  const signal = await entered.promise;
  const result = await queue.cancelJob(job.id);
  assert.equal(signal.reason, 'canceled');
  assert.equal(result.status, 'canceled');
  assert.equal((await running).status, 'canceled');
  assert.equal(fs.existsSync(workspace.intermediateDir(job.id)), false);
});

test('取消尚未启动和等待租约的作业，执行器均未调用', { timeout: 30_000 }, async t => {
  const scheduler = device();
  const blocking = await scheduler.acquire({ kind: 'final' });
  t.after(blocking.release);
  let calls = 0;
  const { queue, enqueue } = queueFixture(t, { scheduler, handlers: { final: () => { calls += 1; } } });
  const idle = enqueue({ kind: 'final' });
  assert.equal((await queue.cancelJob(idle.id)).status, 'canceled');
  const waiting = enqueue({ kind: 'final' });
  const running = queue.runJob(waiting.id);
  await stillPending(running);
  assert.equal((await queue.cancelJob(waiting.id)).status, 'canceled');
  await running;
  assert.equal(calls, 0);
});

test('中间产物 none 策略删除失败产物', async t => {
  const { workspace, queue, enqueue } = queueFixture(t, { handlers: { draft: ({ intermediateDir }) => {
    writePartial(intermediateDir);
    throw new Error('failed');
  } } });
  const job = await queue.runJob(enqueue({ keep: 'none' }).id);
  assert.equal(job.status, 'failed');
  assert.equal(fs.existsSync(workspace.intermediateDir(job.id)), false);
});

test('中间产物 failed-only 策略留下失败产物并清掉成功产物', async t => {
  const { workspace, queue, enqueue } = queueFixture(t, { handlers: { draft: ({ job, intermediateDir }) => {
    writePartial(intermediateDir);
    if (job.payload) throw new Error('failed');
  } } });
  const failed = await queue.runJob(enqueue({ keep: 'failed-only', payload: true }).id);
  const passed = await queue.runJob(enqueue({ keep: 'failed-only' }).id);
  assert.equal(failed.status, 'failed');
  assert.equal(passed.status, 'succeeded');
  assert.ok(fs.existsSync(path.join(workspace.intermediateDir(failed.id, 1), 'partial.bin')));
  assert.equal(fs.existsSync(workspace.intermediateDir(passed.id)), false);
});

test('中间产物 all 策略保留各次重放的产物', async t => {
  const handlers = { draft: ({ intermediateDir }) => { writePartial(intermediateDir); } };
  const { workspace, queue, enqueue } = queueFixture(t, { handlers });
  const job = await queue.runJob(enqueue({ keep: 'all' }).id);
  const replay = await replayJob(queue.jobFile(job.id), handlers);
  assert.equal(replay.attempt, 2);
  for (const attempt of [1, 2]) assert.ok(fs.existsSync(path.join(workspace.intermediateDir(job.id, attempt), 'partial.bin')));
});

test('长轮询在终态返回状态与最近 5 条事件', { timeout: 30_000 }, async t => {
  const { workspace, queue, enqueue } = queueFixture(t, { handlers: { draft: async ({ step }) => {
    for (const name of ['lock', 'eval', 'verify']) await step(name, () => {});
  } } });
  const job = enqueue();
  const waited = loadQueue(workspace.root).waitForJob(job.id, { timeoutMs: 1000 });
  const result = await queue.runJob(job.id);
  const view = await waited;
  assert.equal(view.status, 'succeeded');
  assert.deepEqual(view.events, result.events.slice(-5));
  assert.equal(view.events.length, 5);
});

test('长轮询超时时返回当前状态，零毫秒立即读取', { timeout: 30_000 }, async t => {
  const { queue, enqueue } = queueFixture(t);
  const job = enqueue();
  const immediate = await queue.waitForJob(job.id, { timeoutMs: 0 });
  assert.equal(immediate.status, 'queued');
  await stillPending(queue.waitForJob(job.id, { timeoutMs: 100 }));
  assert.deepEqual(await queue.waitForJob(job.id, { timeoutMs: 10 }), immediate);
});

test('非法跃迁、重复领取和缺失执行器均拒绝', { timeout: 30_000 }, async t => {
  const gate = Promise.withResolvers();
  const { workspace, queue, enqueue } = queueFixture(t, { handlers: { draft: () => gate.promise } });
  const job = enqueue();
  assert.throws(() => loadQueue(workspace.root).runJob(job.id), /缺少/);
  const running = queue.runJob(job.id);
  assert.throws(() => queue.runJob(job.id), /领取/);
  gate.resolve();
  assert.equal((await running).status, 'succeeded');
  assert.throws(() => queue.runJob(job.id), /排队/);
  assert.throws(() => queue.cancelJob(job.id), /不能取消/);
});

test('执行器输入路径不能跳出快照，队列文件也拒绝作业目录符号链接', async t => {
  const { workspace, queue, enqueue } = queueFixture(t, { handlers: { draft: ({ inputPath }) => inputPath('../manifest.json') } });
  const result = await queue.runJob(enqueue().id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /非法段/);
  fs.symlinkSync(workspace.resolve('assets'), workspace.resolve('jobs/link'));
  assert.throws(() => queue.getJob('link'), { code: 'contract.bad-path' });
  assert.throws(() => queue.listJobs(), { code: 'contract.bad-path' });
});

test('S3(A/B)：终渲抢占或排队等待期间，新到与排队草稿不得抢跑', { timeout: 30_000 }, async () => {
  // (A) 默认调度器下 d1 被 f1 抢占尚未释放，新到 d2 必须等待 f1 完成
  const def = new Scheduler();
  const d1 = await def.acquire({ kind: 'draft' });
  const f1p = def.acquire({ kind: 'final' });
  assert.equal(d1.signal.reason, 'preempted');
  const d2p = def.acquire({ kind: 'draft' });
  await stillPending(f1p);
  await stillPending(d2p);
  d1.release();
  const f1 = await f1p;
  await stillPending(d2p);
  f1.release();
  (await d2p).release();

  // (B) 队列已有等待草稿 a3，f2 抢占 a1 后 a3 不得抢跑
  const s1 = device();
  const a1 = await s1.acquire({ kind: 'draft', vramMB: 600 });
  const a3p = s1.acquire({ kind: 'draft', vramMB: 400 });
  const a2p = s1.acquire({ kind: 'final', vramMB: 800 });
  assert.equal(a1.signal.reason, 'preempted');
  await stillPending(a3p);
  a1.release();
  const a2 = await a2p;
  await stillPending(a3p);
  a2.release();
  (await a3p).release();

  // 补测：f1(200MB) 运行中 f2(800MB) 排队时，新到 draft(400MB) 不得抢跑
  const s2 = device();
  const runF1 = await s2.acquire({ kind: 'final', vramMB: 200 });
  const waitF2 = s2.acquire({ kind: 'final', vramMB: 800 });
  const waitDraft = s2.acquire({ kind: 'draft', vramMB: 400 });
  await stillPending(waitF2);
  await stillPending(waitDraft);
  runF1.release();
  const f2 = await waitF2;
  await stillPending(waitDraft);
  f2.release();
  (await waitDraft).release();
});

test('S3(C)：待运行终渲期间轻量保底严格隔离在预留池内，不饿死终渲', { timeout: 30_000 }, async () => {
  const s = device();
  const dr = await s.acquire({ kind: 'draft', vramMB: 400 });
  const finp = s.acquire({ kind: 'final', vramMB: 800 });
  assert.equal(dr.signal.reason, 'preempted');

  // 超预留区 preview(300MB) 严禁抢跑
  const bigPrev = s.acquire({ kind: 'preview', vramMB: 300, priority: 'normal' });
  await stillPending(bigPrev);

  // 预留池内 preview(200MB) 允许并发，第二路超预留池必须等待
  const smallPrev1 = await s.acquire({ kind: 'preview', vramMB: 200, priority: 'normal' });
  const smallPrev2 = s.acquire({ kind: 'preview', vramMB: 200, priority: 'normal' });
  await stillPending(smallPrev2);

  // dr 释放后，即使 smallPrev1 占满预留池 200MB，fin(800MB) 立即获得主预算
  dr.release();
  const fin = await finp;
  await stillPending(bigPrev);
  await stillPending(smallPrev2);
  fin.release();
  smallPrev1.release();
  (await bigPrev).release();
  (await smallPrev2).release();

  // 若已有超预留大 preview(300MB) 在跑，fin 等待期间新小 preview(100MB) 不得插队续命
  const existingBig = await s.acquire({ kind: 'preview', vramMB: 300, priority: 'normal' });
  const fin2p = s.acquire({ kind: 'final', vramMB: 800 });
  const sneakPrev = s.acquire({ kind: 'preview', vramMB: 100, priority: 'normal' });
  await stillPending(fin2p);
  await stillPending(sneakPrev);
  existingBig.release();
  const fin2 = await fin2p;
  const smallAfter = await sneakPrev;
  fin2.release();
  smallAfter.release();

  // 高优预览等待抢占释放时，低优草稿与普通预览不得抢跑
  const d = await s.acquire({ kind: 'draft', vramMB: 600 });
  const highP = s.acquire({ kind: 'preview', vramMB: 500, priority: 'high' });
  assert.equal(d.signal.reason, 'preempted');
  const lowDraft = s.acquire({ kind: 'draft', vramMB: 200 });
  const normPrev = s.acquire({ kind: 'preview', vramMB: 200, priority: 'normal' });
  await stillPending(highP);
  await stillPending(lowDraft);
  await stillPending(normPrev);
  d.release();
  const highLease = await highP;
  const normLease = await normPrev;
  highLease.release();
  normLease.release();
  (await lowDraft).release();
});

test('S3(D)：队列与调度器端到端联动，终渲等待期间后到草稿不进入执行器', { timeout: 30_000 }, async t => {
  const scheduler = new Scheduler();
  const d1Entered = Promise.withResolvers();
  const d1Release = Promise.withResolvers();
  const eventsOrder = [];
  const { queue, enqueue } = queueFixture(t, { scheduler, handlers: {
    draft: async ({ job, signal }) => {
      eventsOrder.push(`start:${job.id}:a${job.attempt}`);
      if (job.id === 'd1' && job.attempt === 1) {
        d1Entered.resolve();
        return aborting(signal, d1Release.promise);
      }
      return 'ok';
    },
    final: ({ job }) => {
      eventsOrder.push(`start:${job.id}`);
      return 'done';
    },
  } });

  const d1Run = queue.runJob(enqueue({ id: 'd1', kind: 'draft' }).id);
  await d1Entered.promise;
  const f1Run = queue.runJob(enqueue({ id: 'f1', kind: 'final' }).id);
  const d2Run = queue.runJob(enqueue({ id: 'd2', kind: 'draft' }).id);
  await stillPending(f1Run);
  await stillPending(d2Run);
  assert.deepEqual(eventsOrder, ['start:d1:a1']);
  d1Release.resolve();
  const [d1Res, f1Res, d2Res] = await Promise.all([d1Run, f1Run, d2Run]);
  assert.equal(f1Res.status, 'succeeded');
  assert.equal(d1Res.status, 'succeeded');
  assert.equal(d2Res.status, 'succeeded');
  assert.equal(eventsOrder.indexOf('start:f1'), 1);
  assert.ok(eventsOrder.indexOf('start:d2:a1') > eventsOrder.indexOf('start:f1'));
});

test('W4：film.json 校验 film.id 格式与 shots 非空对象数组并统一抛 contract.bad-value', t => {
  const workspace = fixture(t);
  const baseFilm = JSON.parse(fs.readFileSync(workspace.resolve('film.json'), 'utf8'));
  const invalidFilms = [
    { ...baseFilm, id: '' },
    { ...baseFilm, id: '123' },
    { ...baseFilm, id: 'Demo' },
    (() => { const copy = { ...baseFilm }; delete copy.shots; return copy; })(),
    { ...baseFilm, shots: {} },
    { ...baseFilm, shots: [] },
    { ...baseFilm, shots: [null] },
    { ...baseFilm, shots: [123] },
    { ...baseFilm, shots: [[]] },
  ];
  for (const bad of invalidFilms) {
    fs.writeFileSync(workspace.resolve('film.json'), JSON.stringify(bad));
    assert.throws(() => workspace.snapshot({ uncommitted: true }), { code: 'contract.bad-value' });
  }
});

test('S4：调度器拒绝 vramMB: null 与各类非法预算/优先级参数', () => {
  const s = device();
  assert.throws(() => s.request({ kind: 'final', vramMB: null }), RangeError);
  assert.throws(() => s.acquire({ kind: 'preview', vramMB: null }), RangeError);
  for (const badMB of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 801]) {
    assert.throws(() => s.request({ kind: 'final', vramMB: badMB }), RangeError);
  }
  assert.throws(() => s.request({ kind: 'preview', priority: null }), TypeError);
  assert.throws(() => s.request({ kind: 'preview', priority: 'urgent' }), TypeError);
  assert.throws(() => s.request({ kind: 'draft', priority: 'high' }), TypeError);
});

test('Q1：listJobs 忽略 jobs/ 下普通文件如 .DS_Store，inputPath 提前校验字符串类型', async t => {
  const { workspace, queue, enqueue } = queueFixture(t, { handlers: {
    draft: ({ inputPath, job }) => inputPath(job.payload),
  } });
  const job = enqueue({ id: 'job-a', payload: null });
  fs.writeFileSync(path.join(workspace.resolve('jobs'), '.DS_Store'), 'junk');
  assert.deepEqual(queue.listJobs().map(item => item.id), ['job-a']);

  const resNull = await queue.runJob(job.id);
  assert.equal(resNull.status, 'failed');
  assert.match(resNull.error, /相对路径/);

  const jobUndef = enqueue({ id: 'job-b' });
  const q2 = loadQueue(workspace.root, { handlers: {
    draft: ({ inputPath }) => {
      assert.throws(() => inputPath(undefined), { code: 'contract.bad-path' });
      assert.throws(() => inputPath(123), { code: 'contract.bad-path' });
      return 'checked';
    },
  } });
  assert.equal((await q2.runJob(jobUndef.id)).result, 'checked');
});

test('Q5：步骤回调抛异常叠加倒退或 NaN 时钟时不掩盖原始业务异常', async t => {
  for (const ticks of [[10, 5], [10, Number.NaN]]) {
    let idx = 0;
    const { queue, enqueue } = queueFixture(t, {
      clock: () => ticks[idx++],
      handlers: {
        draft: ({ step }) => step('render:s01', () => {
          throw new Error('ORIGINAL_RENDER_FAILURE');
        }),
      },
    });
    const job = await queue.runJob(enqueue().id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'ORIGINAL_RENDER_FAILURE');
    assert.equal(job.steps[0].status, 'failed');
    assert.equal(job.steps[0].durationMs, undefined);
  }
});

test('二审回归 1：终渲运行中且超预留额大预览排队时，预留池内的小预览与核验仍获准运行', async () => {
  const s = new Scheduler({ totalMB: 1000, previewReserveMB: 200 });
  const finalLease = await s.acquire({ kind: 'final', vramMB: 800 });
  const bigPreview = s.acquire({ kind: 'preview', vramMB: 300 });
  const smallPreview = s.acquire({ kind: 'preview', vramMB: 120 });
  const verifyReq = s.acquire({ kind: 'verify', vramMB: 80 });

  await stillPending(bigPreview);
  const [pLease, vLease] = await Promise.all([smallPreview, verifyReq]);
  pLease.release();
  vLease.release();
  await stillPending(bigPreview);
  finalLease.release();
  (await bigPreview).release();
});

test('二审回归 2：预留池内先到的高优预览等待时，后到的同级高优预览不得插队', async () => {
  const s = new Scheduler({ totalMB: 1000, previewReserveMB: 200 });
  const runningFinal = await s.acquire({ kind: 'final', vramMB: 200 });
  const queuedFinal = s.acquire({ kind: 'final', vramMB: 800 });
  const activePreview = await s.acquire({ kind: 'preview', vramMB: 100, priority: 'high' });
  const firstWaiting = s.acquire({ kind: 'preview', vramMB: 200, priority: 'high' });
  const laterSmall = s.acquire({ kind: 'preview', vramMB: 100, priority: 'high' });

  await stillPending(firstWaiting);
  await stillPending(laterSmall);

  activePreview.release();
  const firstLease = await firstWaiting;
  await stillPending(laterSmall);
  firstLease.release();
  (await laterSmall).release();
  runningFinal.release();
  (await queuedFinal).release();
});

test('二审回归 3 & 4：listJobs 忽略普通杂目录如 .cache 且拒符号链接，结束时钟抛错不掩盖业务异常', async t => {
  let call = 0;
  const { workspace, queue, enqueue } = queueFixture(t, {
    clock: () => {
      call += 1;
      if (call === 1) return 10;
      throw new Error('CLOCK_FAILURE');
    },
    handlers: {
      draft: ({ step }) => step('render:s01', () => {
        throw new Error('ORIGINAL_RENDER_FAILURE');
      }),
    },
  });
  const queued = enqueue({ id: 'valid' });
  fs.mkdirSync(path.join(workspace.resolve('jobs'), '.cache'));
  assert.deepEqual(queue.listJobs().map(item => item.id), ['valid']);

  const failed = await queue.runJob(queued.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'ORIGINAL_RENDER_FAILURE');
  assert.equal(failed.steps[0].status, 'failed');
  assert.equal(failed.steps[0].durationMs, undefined);

  fs.symlinkSync(workspace.resolve('assets'), path.join(workspace.resolve('jobs'), 'bad-link'));
  assert.throws(() => queue.listJobs(), { code: 'contract.bad-path' });
});

test('A16 终态回写期间作业目录被轮换：补记诊断的回写落在作业锁所在的那一代目录，不写进原路径上的新目录', async t => {
  const { queue, enqueue } = queueFixture(t);
  const job = enqueue({ id: 'rotating' });
  const dir = path.dirname(queue.jobFile(job.id));
  const retired = path.join(path.dirname(dir), '.rotating-old');
  const realAppend = fs.appendFileSync;
  t.mock.method(fs, 'appendFileSync', (target, ...rest) => {
    if (target !== queue.ledgerFile()) return realAppend(target, ...rest);
    fs.renameSync(dir, retired);
    fs.mkdirSync(dir);
    throw Object.assign(new Error('磁盘满'), { code: 'ENOSPC' });
  });
  await queue.runJob(job.id);
  const saved = JSON.parse(fs.readFileSync(path.join(retired, 'job.json'), 'utf8'));
  assert.equal(saved.status, 'succeeded');
  assert.match(saved.events.at(-1).ledgerError, /磁盘满/);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(fs.existsSync(path.join(retired, 'job.json.lock')), false);
});
