// 委托作业的作业记录：落成 jobs 的 job/0.1 记录，重开服务后照样可读、可等、可取消；全程不要显存租约。
// 只经 createStore / createWork / loadQueue 的公开接口，不起 HTTP、不要 FFmpeg 和浏览器。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadQueue } from '../jobs/index.mjs';
import { createStore } from './store.mjs';
import { createWork } from './work.mjs';

const rejections = [];
process.on('unhandledRejection', (e) => rejections.push(e));

// 委托作业不该碰显存调度器：谁来要预算或租约都算错
const noGpu = {
  request() { throw new Error('委托作业申请了显存预算'); },
  acquire() { throw new Error('委托作业申请了显存租约'); },
};

/** 一个临时数据目录；boot() 每次交回全新的 store 和 work，等于重开一次服务 */
function open(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bm-e1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const boot = () => {
    const store = createStore(dir);
    return { store, work: createWork({ store, library: null, reviewer: null, scheduler: noGpu }) };
  };
  return { boot, film: 'f_001' };
}

const types = (job) => job.events.map((e) => e.type).filter((type) => !type.startsWith('step-'));

test('E1-1 委托作业落成 job/0.1 记录：运行中可读，重开服务后终态、事件、结论和账本都在', async (t) => {
  const { boot, film } = open(t);
  const a = boot();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const job = a.work.submitDelegate(film, async () => {
    await gate;
    return { status: 'stopped', stoppedReason: 'tokens', stoppedAt: 'director:step-2', bestRev: 0, cost: { tokens: 7 }, outputs: [] };
  });
  // 换一个队列实例读盘：记录要过 jobs 自己的格式校验
  const onDisk = () => loadQueue(a.store.filmDir(film)).getJob(job);

  const live = onDisk();
  assert.equal(live.format, 'job/0.1');
  assert.equal(live.status, 'running');
  assert.equal(live.handler, 'delegate');
  assert.deepEqual(types(live), ['queued', 'running']);
  const running = a.work.view(film, job);
  assert.equal(running.terminal, false);
  assert.equal(running.outcome, null);
  assert.equal(running.base.stage, 'orchestrate');

  release();
  await a.work.wait(film, job, 5);
  assert.deepEqual(types(onDisk()), ['queued', 'running', 'stopped']);
  assert.deepEqual(onDisk().events.map((e) => e.seq), onDisk().events.map((_, i) => i + 1));

  const b = boot();
  const { terminal, base, outcome } = b.work.view(film, job);
  assert.equal(terminal, true);
  assert.equal(base.status, 'stopped');
  assert.equal(base.verb, 'delegate');
  assert.equal(base.stage, null);
  assert.deepEqual(base.events.at(-1), { seq: base.events.at(-1).seq, type: 'stopped', reason: 'tokens' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.data.stoppedAt, 'director:step-2');
  assert.equal(outcome.cost.tokens, 7);
  assert.equal(base.cost.gpuSeconds, 0);
  const row = b.store.readLedger(film).find((r) => r.step === 'job.delegate');
  assert.equal(row.job, job);
  assert.equal(row.status, 'stopped');
  assert.equal(row.gpuSeconds, 0);
  // 终态的作业：等立刻回来，取消原样交回
  await b.work.wait(film, job, 30);
  assert.equal(await b.work.cancel(film, job), 'stopped');
});

test('E1-2 succeeded 和 failed 按实落盘：编排报失败、抛异常、交回的不是结论，都收在 failed', async (t) => {
  const { boot, film } = open(t);
  const cases = [
    [async () => ({ status: 'succeeded', bestRev: 0, cost: { tokens: 1 }, outputs: [] }), 'succeeded', true],
    [async () => ({ status: 'failed', failedAt: 'finalizer', cost: {}, outputs: [] }), 'failed', false],
    [async () => { throw new Error('模型端点 https://model.example.invalid/v1 连不上'); }, 'failed', false],
    [async () => undefined, 'failed', false],
    [async () => ({ status: 'weird' }), 'failed', false],
  ];
  for (const [run, status, ok] of cases) {
    const a = boot();
    const job = a.work.submitDelegate(film, run);
    await a.work.wait(film, job, 2);
    const { terminal, base, outcome } = boot().work.view(film, job);
    assert.equal(base.status, status);
    assert.equal(terminal, true);
    assert.equal(outcome.ok, ok);
    assert.doesNotMatch(JSON.stringify(outcome), /model\.example\.invalid/);
  }
  assert.deepEqual(boot().store.readLedger(film).map((r) => r.status), cases.map(([, status]) => status));
});

test('E1-3 取消和关服务都把在跑的委托作业收在 canceled，重开后可读', async (t) => {
  const { boot, film } = open(t);
  const a = boot();
  const hang = ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ status: 'canceled', cost: {}, outputs: [] }));
  });
  const one = a.work.submitDelegate(film, hang);
  assert.equal(await a.work.cancel(film, one), 'canceled');
  const two = a.work.submitDelegate(film, hang);
  await a.work.cancelAll();

  const b = boot();
  for (const job of [one, two]) {
    const { terminal, base } = b.work.view(film, job);
    assert.equal(base.status, 'canceled');
    assert.equal(terminal, true);
  }
  assert.deepEqual(b.store.readLedger(film).map((r) => r.status), ['canceled', 'canceled']);
  await b.work.cancelAll();
});

test('E1-4 结论落不了盘也收在 failed，不留未捕获的 rejection', async (t) => {
  const { boot, film } = open(t);
  const a = boot();
  a.store.workspace(film);
  // 占住结论目录的位置，让写 outcome.json 失败
  writeFileSync(join(a.store.filmDir(film), 'deliver', 'j-1'), '占位');
  const job = a.work.submitDelegate(film, async () => ({ status: 'succeeded', cost: {}, outputs: [] }));
  assert.equal(job, 'j-1');
  await a.work.wait(film, job, 2);
  await new Promise((resolve) => setImmediate(resolve));
  const { terminal, base, outcome } = boot().work.view(film, job);
  assert.equal(base.status, 'failed');
  assert.equal(terminal, true);
  assert.equal(outcome, null);
  assert.deepEqual(rejections, []);
});
