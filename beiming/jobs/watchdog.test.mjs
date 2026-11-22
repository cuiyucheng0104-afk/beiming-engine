import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { chromeArgs, chromeExecutable } from '../../engine/render/lib/gpu.mjs';
import * as jobs from './index.mjs';
import { Scheduler } from './scheduler.mjs';
import {
  createJobWatchdog,
  createVramProbe,
  killProcessTree,
  measureWorkspaceQuotaBytes,
  parseFootprintGraphicsMB,
  parseNvidiaSmiApps,
  processIsAlive,
  runWithWatchdog,
} from './watchdog.mjs';

const MB = 2 ** 20;
const posix = process.platform !== 'win32';
const node = process.execPath;
const IDLE = 'setInterval(() => {}, 1000)';
// 先起一个孙进程，把两个进程号同步写到标准输出，然后空转。
const PARENT = `
const grandchild = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('node:fs').writeSync(1, process.pid + ' ' + grandchild.pid + '\\n');
setInterval(() => {}, 1000);`;
// 不理 SIGTERM 的同步死循环：装了处理函数但事件循环永远轮不到它。孙进程同样不理 SIGTERM。
const STUBBORN = `
process.on('SIGTERM', () => {});
const grandchild = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
require('node:fs').writeSync(1, process.pid + ' ' + grandchild.pid + '\\n');
while (true) {}`;

const refuses = (code, exitCode) => (error) => {
  assert.equal(error.code, code, `${error.code}: ${error.message}`);
  assert.equal(error.exitCode, exitCode);
  return true;
};
const badArgument = (error) => refuses('usage.bad-argument', 2)(error) && (error instanceof TypeError || error instanceof RangeError);
const rejected = (promise) => promise.then(() => assert.fail('应该被拒绝'), (error) => error);
const never = () => new Promise(() => {});
// 被零宽限强杀：POSIX 上死于 SIGKILL；Windows 上 taskkill /F，只看得到它退出了。
const killedHard = (child) => (posix ? child.signalCode === 'SIGKILL' : child.exitCode !== null);

function firstLine(stream) {
  return new Promise((resolve, reject) => {
    let text = '';
    stream.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) resolve(text.split('\n')[0]);
    });
    stream.on('end', () => reject(new Error('子进程没有报进程号')));
  });
}

async function withGrandchild(watchdog, script) {
  const child = watchdog.spawnManaged(node, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const [pid, grandchild] = (await firstLine(child.stdout)).split(' ').map(Number);
  assert.equal(pid, child.pid);
  return { child, grandchild };
}

function workspace(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-a14-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }));
  const dir = path.join(base, 'ws');
  for (const sub of ['intermediate', 'deliver', 'snapshots', 'jobs', 'cache']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return { base, dir };
}

function watch(t, options) {
  const watchdog = createJobWatchdog(options);
  // 收尾：断言中途失败时受管进程也要收掉（报一次 GPU 丢失就会零宽限杀掉名下全部进程）。
  t.after(() => {
    watchdog.reportGpuLost('test-teardown');
    watchdog.close();
  });
  return watchdog;
}

function trySymlink(target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}

// 碰一下就记数的 Proxy：处理器本身也是 Proxy，任何陷阱都接得住。
function trapped(target = {}) {
  let hits = 0;
  const handler = new Proxy({}, { get: () => () => { hits += 1; throw new Error('陷阱被触发'); } });
  return { proxy: new Proxy(target, handler), hits: () => hits };
}

test('A14-Red 看门狗模块存在，核心接口经 index.mjs 导出', () => {
  for (const name of ['createJobWatchdog', 'runWithWatchdog', 'measureWorkspaceQuotaBytes', 'killProcessTree', 'processIsAlive', 'createVramProbe']) {
    assert.equal(typeof jobs[name], 'function', name);
  }
});

test('A14-1 入参防御：Proxy、取值器、未知键、Symbol 键、类实例、越界数与越界进程号一律报 usage.bad-argument，一个陷阱也不触发', async (t) => {
  const { dir } = workspace(t);
  const trap = trapped();
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  let getterHits = 0;
  const withGetter = (key) => Object.defineProperty({}, key, { enumerable: true, get() { getterHits += 1; return 10; } });
  const scheduler = new Scheduler({ totalMB: 512, previewReserveMB: 64 });
  // 这一条里的看门狗只关不杀：下面要拿本进程、父进程、祖先的进程号去试，收尾时不能有任何强杀。
  const watchdog = createJobWatchdog({ quotas: { vramQuotaMB: 64 } });
  t.after(() => watchdog.close());
  // 把 process.kill 换成只记账的假货：哪条防线万一失效，测试也不会真的把信号发给本进程的父辈。
  const signals = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    if (signal === 0) return true; // 存活检查一律报「在」：防线万一失效，下一步的信号会被记进 signals
    signals.push([pid, signal]);
    throw Object.assign(new Error('测试里不真发信号'), { code: 'ESRCH' });
  });
  const task = () => assert.fail('入参不合格时不得跑任务');
  const ownGroup = posix ? Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' })) : null;

  const mutants = [
    ['options 是 Proxy', () => createJobWatchdog(trap.proxy)],
    ['quotas 是 Proxy', () => createJobWatchdog({ quotas: trap.proxy })],
    ['quotas 是已撤销的 Proxy', () => createJobWatchdog({ quotas: revoked.proxy })],
    ['quotas 带取值器', () => createJobWatchdog({ quotas: withGetter('frameTimeoutMs') })],
    ['options 带取值器', () => createJobWatchdog(withGetter('quotas'))],
    ['quotas 有未知键（大小写写错）', () => createJobWatchdog({ quotas: { frameTimeoutMS: 10 } })],
    ['quotas 有 Symbol 键', () => createJobWatchdog({ quotas: { [Symbol('frameTimeoutMs')]: 10 } })],
    ['quotas 是类实例', () => createJobWatchdog({ quotas: new (class { frameTimeoutMs = 10; })() })],
    ['quotas 的值从原型链继承', () => createJobWatchdog({ quotas: Object.create({ frameTimeoutMs: 10 }) })],
    ['quotas 是数组', () => createJobWatchdog({ quotas: [] })],
    ['quotas 是 null', () => createJobWatchdog({ quotas: null })],
    ['options 有未知键', () => createJobWatchdog({ quota: {} })],
    ['计时类配额超过定时器上限', () => createJobWatchdog({ quotas: { frameTimeoutMs: 2 ** 31 } })],
    ['killGraceMs 是负数', () => createJobWatchdog({ quotas: { killGraceMs: -1 } })],
    ['探针不是函数', () => createJobWatchdog({ quotas: { vramQuotaMB: 1 }, probeVramMB: 128 })],
    ['给了显存探针没给配额', () => createJobWatchdog({ quotas: {}, probeVramMB: () => 0 })],
    ['quotas 整个没给', () => createJobWatchdog({})],
    ['什么都没给', () => createJobWatchdog()],
    ['quotas 是 undefined（变量名写错）', () => createJobWatchdog({ quotas: undefined })],
    ['runWithWatchdog 没给 quotas', () => runWithWatchdog({ scheduler, scheduleSpec: { kind: 'draft' } }, task)],
    ['给了工作区没给磁盘配额', () => createJobWatchdog({ quotas: { frameTimeoutMs: 10 }, workspaceDir: dir })],
    ['给了磁盘配额没给工作区', () => createJobWatchdog({ quotas: { diskQuotaBytes: 1 } })],
    ['工作区是相对路径', () => createJobWatchdog({ quotas: { maxFiles: 1 }, workspaceDir: 'ws' })],
    ['工作区不存在', () => createJobWatchdog({ quotas: { maxFiles: 1 }, workspaceDir: path.join(dir, 'missing') })],
    ['统计选项有未知键', () => measureWorkspaceQuotaBytes(dir, { followSymlinks: true })],
    ['强杀选项有未知键', () => killProcessTree(999999, { force: true })],
    ['强杀信号不在白名单', () => killProcessTree(999999, { signal: 'SIGSTOP' })],
    ['登记的不是 ChildProcess', () => watchdog.registerProcess({ pid: 999999 })],
    ['登记的是 Proxy', () => watchdog.registerProcess(trap.proxy)],
    ['登记的对象原型链上有 Proxy', () => watchdog.registerProcess(Object.create(trap.proxy))],
    ['登记仿造的 ChildProcess，pid 是取值器', () => watchdog.registerProcess(Object.defineProperty(Object.create(ChildProcess.prototype), 'pid', { get() { getterHits += 1; return 999999; } }))],
    ['起进程的参数是已撤销的 Proxy', () => watchdog.spawnManaged(node, revoked.proxy)],
    ['起进程的参数里有取值器', () => watchdog.spawnManaged(node, Object.defineProperty(['-e'], 1, { enumerable: true, get() { getterHits += 1; return IDLE; } }))],
    ['起进程的 env 是 Proxy', () => watchdog.spawnManaged(node, ['-e', IDLE], { env: trap.proxy })],
    ['起进程的 env 有非字符串值', () => watchdog.spawnManaged(node, ['-e', IDLE], { env: { A: 1 } })],
    ['起进程的 stdio 不在白名单', () => watchdog.spawnManaged(node, ['-e', IDLE], { stdio: ['ignore', 'ipc'] })],
    ['起进程的 stdio 是 Proxy', () => watchdog.spawnManaged(node, ['-e', IDLE], { stdio: new Proxy([], {}) })],
    // 下面几条脚本是空的：防线万一失效，起出来的进程自己马上退出，不留空转的孤儿。
    ['起进程的 stdio 数组里有取值器', () => watchdog.spawnManaged(node, ['-e', ''], { stdio: Object.defineProperty(['ignore', 'ignore', 'ignore'], 1, { enumerable: true, get() { getterHits += 1; return 'ignore'; } }) })],
    ['起进程的 stdio 数组有空洞', () => watchdog.spawnManaged(node, ['-e', ''], { stdio: Object.assign(new Array(3), { 0: 'ignore', 2: 'ignore' }) })],
    ['起进程的 stdio 数组多带了键', () => watchdog.spawnManaged(node, ['-e', ''], { stdio: Object.assign(['ignore'], { shell: true }) })],
    ['起进程的 stdio 数组带 Symbol 键', () => watchdog.spawnManaged(node, ['-e', ''], { stdio: Object.assign(['ignore'], { [Symbol.iterator]: Array.prototype.values }) })],
    ['起进程的 stdio 是数组的子类', () => watchdog.spawnManaged(node, ['-e', ''], { stdio: new (class extends Array {})('ignore', 'ignore') })],
    ['起进程的参数数组有空洞', () => watchdog.spawnManaged(node, Object.assign(new Array(3), { 0: '-e', 2: '' }))],
    ['起进程的参数数组多带了键', () => watchdog.spawnManaged(node, Object.assign(['-e', ''], { shell: true }))],
    ['登记选项带取值器', () => watchdog.registerProcess(999999, withGetter('processGroup'))],
    ['起进程的参数不是字符串数组', () => watchdog.spawnManaged(node, ['-e', 1])],
    ['起进程的选项想自己定 detached', () => watchdog.spawnManaged(node, ['-e', IDLE], { detached: false })],
    ['起进程的选项想走 shell', () => watchdog.spawnManaged(node, ['-e', IDLE], { shell: true })],
    ['显存申报是负数', () => watchdog.recordVramBytes(-1)],
    ['显存申报是 NaN', () => watchdog.recordVramBytes(NaN)],
    ['显存申报是小数', () => watchdog.recordVramBytes(1.5)],
    ['显存改数是负数', () => watchdog.setVramMB(-1)],
    ['帧号是负数', () => watchdog.runFrame(-1, task)],
    ['帧函数不是函数', () => watchdog.runFrame(0, 'frame')],
    ['着色器标签不是字符串', () => watchdog.beginShaderPass(5)],
    ['GPU 丢失原因不是字符串', () => watchdog.reportGpuLost({})],
    ['任务不是函数', () => runWithWatchdog({ quotas: {} }, null)],
    ['runWithWatchdog 的选项是 Proxy', () => runWithWatchdog(trap.proxy, task)],
    ['scheduler 是 Proxy', () => runWithWatchdog({ quotas: {}, scheduler: new Proxy(scheduler, {}), scheduleSpec: { kind: 'draft' } }, task)],
    ['scheduler 是仿造的对象', () => runWithWatchdog({ quotas: {}, scheduler: { acquire: task, request: task }, scheduleSpec: { kind: 'draft' } }, task)],
    ['scheduler 只是原型对得上', () => runWithWatchdog({ quotas: {}, scheduler: Object.create(Scheduler.prototype), scheduleSpec: { kind: 'draft' } }, task)],
    ['scheduler 的原型链上有 Proxy', () => runWithWatchdog({ quotas: {}, scheduler: Object.create(trap.proxy), scheduleSpec: { kind: 'draft' } }, task)],
    ['scheduleSpec 带取值器', () => runWithWatchdog({ quotas: {}, scheduler, scheduleSpec: withGetter('vramMB') }, task)],
    ['scheduleSpec 有未知键', () => runWithWatchdog({ quotas: {}, scheduler, scheduleSpec: { kind: 'draft', gpu: 0 } }, task)],
    ['scheduleSpec 的类别无效', () => runWithWatchdog({ quotas: {}, scheduler, scheduleSpec: { kind: 'constructor' } }, task)],
    ['给了 scheduleSpec 没给 scheduler', () => runWithWatchdog({ quotas: {}, scheduleSpec: { kind: 'draft' } }, task)],
    ['显存配额高于调度器准入额度', () => runWithWatchdog({ scheduler, scheduleSpec: { kind: 'draft', vramMB: 128 }, quotas: { vramQuotaMB: 129 } }, task)],
    ['signal 不是 AbortSignal', () => runWithWatchdog({ quotas: {}, signal: { aborted: false } }, task)],
    ['signal 是仿造的（只有原型对得上）', () => runWithWatchdog({ quotas: {}, signal: Object.create(AbortSignal.prototype) }, task)],
    ['signal 是 Proxy', () => runWithWatchdog({ quotas: {}, signal: trap.proxy }, task)],
  ];
  for (const key of ['frameTimeoutMs', 'shaderHangMs', 'pollIntervalMs', 'vramQuotaMB', 'diskQuotaBytes', 'maxFiles', 'killGraceMs']) {
    for (const value of [key === 'killGraceMs' ? -1 : 0, 1.5, NaN, Infinity, '100', 2 ** 53, 10n, null, undefined, true]) {
      mutants.push([`quotas.${key} = ${String(value)}`, () => createJobWatchdog({ quotas: { [key]: value }, workspaceDir: dir })]);
    }
  }
  for (const pid of [0, 1, -1, process.pid, process.ppid, 1.5, NaN, '4242', 2 ** 53, null]) {
    // Windows 上强杀走 taskkill，换不成假货：本进程、父进程这两个真进程号只在 POSIX 上试。
    if (posix || (pid !== process.pid && pid !== process.ppid)) mutants.push([`killProcessTree(${String(pid)})`, () => killProcessTree(pid)]);
    mutants.push([`registerProcess(${String(pid)})`, () => watchdog.registerProcess(pid)]);
  }
  if (posix) {
    // 父进程的父进程：既不是本进程也不是父进程，但杀它等于杀掉自己这一支。
    const grandparent = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(process.ppid)], { encoding: 'utf8' }));
    if (grandparent > 1) {
      mutants.push(['登记仿造的 ChildProcess，pid 是本进程的祖先', () => watchdog.registerProcess(Object.assign(Object.create(ChildProcess.prototype), { pid: grandparent, exitCode: null, signalCode: null }))]);
      mutants.push(['强杀本进程的祖先', () => killProcessTree(grandparent)]);
      mutants.push(['登记本进程的祖先', () => watchdog.registerProcess(grandparent)]);
    }
  }
  if (posix && ownGroup !== process.pid && ownGroup !== process.ppid) {
    mutants.push(['对本进程所在的进程组发信号', () => killProcessTree(ownGroup, { processGroup: true })]);
    mutants.push(['登记本进程所在的进程组', () => watchdog.registerProcess(ownGroup, { processGroup: true })]);
  }
  for (const [name, mutate] of mutants) {
    await assert.rejects(async () => mutate(), badArgument, name);
  }
  assert.equal(trap.hits(), 0, 'Proxy 的陷阱不得被触发');
  assert.equal(getterHits, 0, '取值器不得被调用');
  assert.equal(watchdog.violation, null);
  assert.deepEqual(signals, [], '入参不合格时一个信号也不得发出');
  t.mock.restoreAll();
  assert.equal(processIsAlive(process.pid), true, '本进程还在');
  // 调度器没有被入参不合格的调用占住额度。
  (await scheduler.acquire({ kind: 'final' })).release();
  // 原型是 null 的普通对象照收。
  createJobWatchdog({ quotas: Object.assign(Object.create(null), { frameTimeoutMs: 5 }) }).close();
  // 一个看门狗同时只跑一帧：第二帧当场拒收，不会悄悄清掉第一帧的计时器。
  const single = watch(t, { quotas: { frameTimeoutMs: 5000 } });
  const first = single.runFrame(0, async () => { await delay(50); return 'first'; });
  await assert.rejects(single.runFrame(1, task), badArgument);
  assert.equal(await first, 'first');
  assert.equal(await single.runFrame(1, () => 'second'), 'second');
});

test('A14-2 单帧超时：不理 AbortSignal 也不理 SIGTERM 的同步死循环，宽限一过升级 SIGKILL 整组杀净，报 timeout.frame（124），不留孙进程', async (t) => {
  const watchdog = watch(t, { quotas: { frameTimeoutMs: 400, killGraceMs: 100 } });
  const { child, grandchild } = await withGrandchild(watchdog, STUBBORN);
  const started = Date.now();
  let aborted = false;
  const error = await rejected(watchdog.runFrame(7, ({ signal }) => {
    signal.addEventListener('abort', () => { aborted = true; });
    return never();
  }));
  const elapsed = Date.now() - started;
  refuses('timeout.frame', 124)(error);
  assert.deepEqual([error.frameIndex, error.frameTimeoutMs], [7, 400]);
  assert.ok(elapsed >= 400 && elapsed < 400 + 100 + 2500, `${elapsed} ms`);
  assert.ok(aborted && watchdog.signal.aborted && watchdog.signal.reason === error);
  assert.ok(killedHard(child), `signal=${child.signalCode} exit=${child.exitCode}`);
  assert.equal(processIsAlive(child.pid), false);
  if (posix) {
    assert.equal(processIsAlive(grandchild), false, '孙进程不得留下');
    assert.equal(processIsAlive(child.pid, { processGroup: true }), false, '进程组里一个不剩');
    assert.ok(error.killed.includes(child.pid) && error.killed.includes(grandchild));
  }
  assert.deepEqual(error.survivors, []);
  // 越线定案之后，后面的帧一律以同一个错拒绝，帧函数不再执行。
  assert.equal(await rejected(watchdog.runFrame(8, () => assert.fail('不该再跑'))), error);
});

test('A14-2b 单帧超时的宽限：听 SIGTERM 的进程在宽限内自己退出；按时完成的帧不受影响，计时器逐帧清掉', async (t) => {
  const watchdog = watch(t, { quotas: { frameTimeoutMs: 400, killGraceMs: 2000 } });
  for (let frame = 0; frame < 3; frame += 1) {
    assert.equal(await watchdog.runFrame(frame, async ({ frameIndex }) => { await delay(40); return frameIndex * 2; }), frame * 2);
  }
  const child = watchdog.spawnManaged(node, ['-e', IDLE], { stdio: 'ignore' });
  await delay(150);
  const started = Date.now();
  refuses('timeout.frame', 124)(await rejected(watchdog.runFrame(3, never)));
  assert.ok(Date.now() - started < 400 + 1500, '进程一退出就返回，不把宽限等满');
  if (posix) assert.equal(child.signalCode, 'SIGTERM');
  assert.equal(processIsAlive(child.pid), false);
});

test('A14-2c 单帧超时，登记时没说是进程组：根进程听 SIGTERM 先死，不理 SIGTERM 的孙进程改认 1 号进程之后照样被 SIGKILL', { skip: posix ? false : '靠 POSIX 信号' }, async (t) => {
  const watchdog = watch(t, { quotas: { frameTimeoutMs: 500, killGraceMs: 150 } });
  // 根进程不装 SIGTERM 处理函数；孙进程装了。不 detached：和测试进程同组，只能按进程表找后代。
  const script = `
const grandchild = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeSync(1, 'ready\\\\n'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'ignore'] });
require('node:fs').writeSync(1, grandchild.pid + '\\n');
setInterval(() => {}, 1000);`;
  const parent = spawn(node, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  await new Promise((resolve) => {
    parent.stdout.on('data', (chunk) => {
      output += chunk;
      if (/^\d+$/m.test(output) && output.includes('ready')) resolve(); // 孙进程的处理函数已经装好
    });
  });
  const grandchild = Number(output.match(/^\d+$/m)[0]);
  t.after(() => { if (processIsAlive(grandchild)) process.kill(grandchild, 'SIGKILL'); });
  watchdog.registerProcess(parent);
  const error = await rejected(watchdog.runFrame(0, never));
  refuses('timeout.frame', 124)(error);
  assert.equal(parent.signalCode, 'SIGTERM', '根进程在宽限内自己退出');
  assert.equal(processIsAlive(grandchild), false, '不理 SIGTERM 的孙进程不得留下');
  assert.ok(error.killed.includes(grandchild));
  assert.deepEqual(error.survivors, []);
});

test('A14-2d 受管名单不留死人：已经退出的进程除名，之后越线不再向它的进程号发信号', async (t) => {
  const watchdog = watch(t, { quotas: { pollIntervalMs: 20 } });
  const gone = watchdog.spawnManaged(node, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => { gone.once('exit', resolve); });
  const already = spawn(node, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => { already.once('exit', resolve); });
  watchdog.registerProcess(already); // 登记时就已经退出的
  const live = watchdog.spawnManaged(node, ['-e', IDLE], { stdio: 'ignore' });
  if (posix) for (let waited = 0; processIsAlive(gone.pid, { processGroup: true }) && waited < 2000; waited += 20) await delay(20);
  const error = await rejected(watchdog.guard(() => { watchdog.reportGpuLost('gpu-process-crashed'); return never(); }));
  assert.ok(error.killed.includes(live.pid));
  assert.ok(!error.killed.includes(gone.pid) && !error.killed.includes(already.pid), `不得再向已退出的进程号发信号：${error.killed}`);
  assert.ok(killedHard(live));
  // 越线之后登记一个已经退出的进程：照样抛越线的错，但不向它的旧进程号发信号。
  const sent = [];
  const realKill = process.kill;
  t.mock.method(process, 'kill', (pid, signal) => { if (signal !== 0) sent.push(pid); return realKill.call(process, pid, signal); });
  assert.throws(() => watchdog.registerProcess(already), (thrown) => thrown === error);
  t.mock.restoreAll();
  assert.deepEqual(sent, []);
});

test('A14-3c 探针不回话：过了 probeTimeoutMs 按失败处理；探针挂着的时候磁盘照查', async (t) => {
  const hung = watch(t, { quotas: { pollIntervalMs: 20, probeTimeoutMs: 100 }, probeGpuHealth: never });
  const started = Date.now();
  const lost = await rejected(hung.check());
  refuses('failure.gpu-lost', 1)(lost);
  assert.match(lost.cause.message, /没有回话/);
  assert.ok(Date.now() - started < 2000);

  const blind = watch(t, { quotas: { vramQuotaMB: 64, pollIntervalMs: 20, probeTimeoutMs: 100 }, probeVramMB: never });
  const exceeded = await rejected(blind.guard(never));
  refuses('failure.vram-exceeded', 1)(exceeded);
  assert.equal(exceeded.reason, 'probe-failed');

  // 探针时限很长、一直不回话：磁盘检查不排在它后面。
  const { dir } = workspace(t);
  const disk = watch(t, { workspaceDir: dir, quotas: { diskQuotaBytes: 100_000, pollIntervalMs: 20, probeTimeoutMs: 60_000 }, probeGpuHealth: never });
  await delay(80); // 探针已经挂住
  fs.writeFileSync(path.join(dir, 'intermediate', 'flood.bin'), Buffer.alloc(300_000, 1));
  const full = await Promise.race([rejected(disk.guard(never)), delay(2000).then(() => assert.fail('探针挂住之后磁盘检查失效了'))]);
  refuses('failure.disk-quota', 1)(full);

  // check() 正等着不回话的探针时别处越线或关闭：check() 当场结算，不会跟着探针永远挂住。
  const settles = (promise, what) => Promise.race([promise.then(() => 'resolved', (error) => error), delay(2000).then(() => assert.fail(`${what}：check() 没有结算`))]);
  const tripped = watch(t, { quotas: { probeTimeoutMs: 60_000 }, probeGpuHealth: never });
  const waiting = settles(tripped.check(), '探针挂着时越线');
  await delay(30);
  tripped.reportGpuLost('webglcontextlost');
  assert.equal((await waiting).reason, 'webglcontextlost');
  const shut = watch(t, { quotas: { vramQuotaMB: 64, probeTimeoutMs: 60_000 }, probeVramMB: never });
  const closing = settles(shut.check(), '探针挂着时关闭');
  await delay(30);
  shut.close();
  assert.equal(await closing, 'resolved');
  // 两种探针都配了：健康探针挂着时关闭，check() 当场结算，显存探针一次也不再起，也不算越线。
  let vramProbes = 0;
  const both = watch(t, { quotas: { vramQuotaMB: 64, probeTimeoutMs: 60_000 }, probeGpuHealth: never, probeVramMB: () => { vramProbes += 1; return never(); } });
  const closingBoth = settles(both.check(), '两种探针都挂着时关闭');
  await delay(30);
  const closedAt = Date.now();
  both.close();
  assert.equal(await closingBoth, 'resolved');
  assert.ok(Date.now() - closedAt < 200, `关闭之后 ${Date.now() - closedAt} ms 才结算`);
  await delay(30);
  assert.deepEqual([vramProbes, both.violation], [0, null]);
  // runWithWatchdog 开工自检卡在探针上时工作区被写满：以磁盘超限拒绝，不挂死。
  const second = workspace(t).dir;
  const run = settles(runWithWatchdog({ workspaceDir: second, quotas: { diskQuotaBytes: 100_000, pollIntervalMs: 20, probeTimeoutMs: 60_000 }, probeGpuHealth: never }, () => assert.fail('不该起任务')), 'runWithWatchdog 自检');
  await delay(60);
  fs.writeFileSync(path.join(second, 'deliver', 'flood.bin'), Buffer.alloc(300_000, 1));
  refuses('failure.disk-quota', 1)(await run);
});

test('A14-3d 关闭与探针的微任务竞态：close() 返回或越线之后，已经排进微任务队列的探针也不再首次调用', async (t) => {
  const settles = (promise, what) => Promise.race([promise.then(() => 'resolved', (error) => error), delay(2000).then(() => assert.fail(`${what}：check() 没有结算`))]);
  const pair = () => {
    const calls = { health: 0, vram: 0 };
    const watchdog = watch(t, {
      quotas: { vramQuotaMB: 64, probeTimeoutMs: 60_000 },
      probeGpuHealth: () => { calls.health += 1; return true; },
      probeVramMB: () => { calls.vram += 1; return 1; },
    });
    return { calls, watchdog };
  };
  // 同一个调用栈里 check() 之后立刻 close()：两个探针一次都不起，check() 安静结算，不算越线。
  const sync = pair();
  const closing = settles(sync.watchdog.check(), '同步关闭');
  sync.watchdog.close();
  assert.equal(await closing, 'resolved');
  await delay(20);
  assert.deepEqual([sync.calls, sync.watchdog.violation], [{ health: 0, vram: 0 }, null]);
  // 让出若干次微任务再关闭（第二个探针刚排进队列还没执行的那一拍也在里面）：关闭之后的首次调用增量恒为 0。
  for (let yields = 0; yields <= 12; yields += 1) {
    const { calls, watchdog } = pair();
    const checking = settles(watchdog.check(), `让出 ${yields} 次后关闭`);
    for (let i = 0; i < yields; i += 1) await Promise.resolve();
    const before = { ...calls };
    watchdog.close();
    assert.equal(await checking, 'resolved', `让出 ${yields} 次微任务后关闭`);
    await delay(20);
    assert.deepEqual([calls, watchdog.violation], [before, null], `让出 ${yields} 次微任务后关闭，关闭之后又起了探针`);
  }
  // 越线也一样：check() 排好探针的同一个调用栈里报 GPU 丢失，探针不再起，check() 以那次越线拒绝。
  const lost = pair();
  const tripping = settles(lost.watchdog.check(), '同步越线');
  lost.watchdog.reportGpuLost('webglcontextlost');
  assert.equal((await tripping).reason, 'webglcontextlost');
  assert.deepEqual(lost.calls, { health: 0, vram: 0 });
});

test('A14-3e 健康探针以 true 为原因拒绝不算报健康：check() 与 runWithWatchdog 返回前的核查都报 failure.gpu-lost（1）', async (t) => {
  for (const probeGpuHealth of [() => Promise.reject(true), () => { throw true; }]) {
    const lost = await rejected(watch(t, { quotas: { pollIntervalMs: 60_000 }, probeGpuHealth }).check());
    refuses('failure.gpu-lost', 1)(lost);
    assert.deepEqual([lost.reason, lost.cause], ['probe', true]);
  }
  // 入场那次采样健康、任务交回 42、返回前那次采样以 true 拒绝：42 不得当成功交回。
  const calls = { health: 0, task: 0 };
  const error = await rejected(runWithWatchdog({
    quotas: { pollIntervalMs: 60_000 },
    probeGpuHealth: () => { calls.health += 1; return calls.health === 1 ? true : Promise.reject(true); },
  }, () => { calls.task += 1; return 42; }));
  refuses('failure.gpu-lost', 1)(error);
  assert.deepEqual([error.reason, calls], ['probe', { health: 2, task: 1 }]);
});

test('A14-3 着色器挂起：有心跳不算挂，心跳一停到点零宽限 SIGKILL，报 timeout.shader-hang（124）', async (t) => {
  const watchdog = watch(t, { quotas: { shaderHangMs: 400, frameTimeoutMs: 20_000, killGraceMs: 5000 } });
  const child = watchdog.spawnManaged(node, ['-e', IDLE], { stdio: 'ignore' });
  let stalledAt;
  const error = await rejected(watchdog.runFrame(0, async () => {
    watchdog.beginShaderPass('warm-up');
    for (let beat = 0; beat < 6; beat += 1) {
      await delay(80);
      watchdog.heartbeat();
    }
    watchdog.endShaderPass();
    await delay(600); // 派发之外的时间不算着色器挂起
    watchdog.beginShaderPass('endless-loop');
    stalledAt = Date.now();
    return never();
  }));
  refuses('timeout.shader-hang', 124)(error);
  assert.deepEqual([error.label, error.shaderHangMs], ['endless-loop', 400]);
  const elapsed = Date.now() - stalledAt;
  assert.ok(elapsed >= 400 && elapsed < 400 + 2500, `${elapsed} ms：不等 killGraceMs 的 5 秒`);
  assert.ok(killedHard(child), `听 SIGTERM 的进程也直接 SIGKILL：signal=${child.signalCode}`);
});

test('A14-3b GPU 丢失：渲染端上报或健康探针没报健康，清掉残余进程，报 failure.gpu-lost（1）', async (t) => {
  const reported = watch(t, { quotas: { frameTimeoutMs: 20_000 } });
  const first = reported.spawnManaged(node, ['-e', IDLE], { stdio: 'ignore' });
  const error = await rejected(reported.runFrame(0, () => {
    reported.reportGpuLost('webglcontextlost');
    reported.reportGpuLost('gpu-process-crashed'); // 第一次越线定案，后面的不改结论
    return never();
  }));
  refuses('failure.gpu-lost', 1)(error);
  assert.equal(error.reason, 'webglcontextlost');
  assert.ok(killedHard(first));
  // 越线之后：不再起新进程；这时才登记上来的进程当场补杀。
  assert.throws(() => reported.spawnManaged(node, ['-e', IDLE]), (thrown) => thrown === error);
  for (const closeFirst of [false, true]) {
    // 任务还在起浏览器时就越线了：runWithWatchdog 已经关了看门狗，进程这时才起好来登记，也要补杀。
    if (closeFirst) reported.close();
    const late = spawn(node, ['-e', IDLE], { stdio: 'ignore' });
    const lateExit = new Promise((resolve) => { late.once('exit', resolve); });
    assert.throws(() => reported.registerProcess(late), (thrown) => thrown === error);
    await lateExit;
    assert.ok(killedHard(late));
  }

  // 没有独立进程组的受管进程：按进程表把孙进程找全，一起杀。
  if (posix) {
    const plain = watch(t, { quotas: {} });
    const parent = spawn(node, ['-e', PARENT], { stdio: ['ignore', 'pipe', 'inherit'] });
    const grandchild = Number((await firstLine(parent.stdout)).split(' ')[1]);
    plain.registerProcess(parent);
    const lost = await rejected(plain.guard(() => { plain.reportGpuLost('gpu-process-crashed'); return never(); }));
    assert.ok(lost.killed.includes(grandchild) && parent.signalCode === 'SIGKILL');
    assert.equal(processIsAlive(grandchild), false, '不在独立进程组里的孙进程也不得留下');
  }

  for (const receipt of [false, undefined, { ok: true }, new Error('device removed')]) {
    const probed = watch(t, {
      quotas: { pollIntervalMs: 20 },
      probeGpuHealth: () => { if (receipt instanceof Error) throw receipt; return receipt; },
    });
    const child = probed.spawnManaged(node, ['-e', IDLE], { stdio: 'ignore' });
    const lost = await rejected(probed.guard(never));
    refuses('failure.gpu-lost', 1)(lost);
    assert.equal(lost.reason, 'probe');
    if (receipt instanceof Error) assert.equal(lost.cause, receipt);
    assert.ok(killedHard(child));
  }
  const healthy = watch(t, { quotas: { pollIntervalMs: 20 }, probeGpuHealth: async () => true });
  assert.equal(await healthy.guard(async () => { await delay(120); return 'ok'; }), 'ok');
});

test('A14-4 显存配额联动调度器：账本越线当场 SIGKILL，进程死透之后归还租约，报 failure.vram-exceeded（1）', async () => {
  const scheduler = new Scheduler({ totalMB: 512, previewReserveMB: 64 });
  let child;
  let thrown;
  const error = await rejected(runWithWatchdog({ scheduler, scheduleSpec: { kind: 'draft', vramMB: 128 }, quotas: {} }, async ({ watchdog, lease }) => {
    assert.equal(lease.vramMB, 128);
    child = watchdog.spawnManaged(node, ['-e', IDLE], { stdio: 'ignore' });
    assert.equal(watchdog.recordVramBytes(64 * MB), 64);
    assert.equal(watchdog.recordVramBytes(64 * MB), 128); // 正好用满不算超
    assert.equal(watchdog.setVramMB(100), 100); // 释放之后往下改
    assert.equal(watchdog.recordVramBytes(28 * MB), 128);
    // 租约还在手里时，主预算放不下另一个 448 MB 的草稿。
    const blocked = new AbortController();
    const queued = scheduler.acquire({ kind: 'draft', vramMB: 448 }, { signal: blocked.signal }).then((lease448) => lease448.release(), () => 'blocked');
    await delay(30);
    blocked.abort();
    assert.equal(await queued, 'blocked');
    try {
      watchdog.recordVramBytes(1);
    } catch (violation) {
      thrown = violation;
    }
    return never(); // 任务自己不收手，也照样被拒绝
  }));
  refuses('failure.vram-exceeded', 1)(error);
  assert.equal(thrown, error, '申报的那一刻同步抛出同一个错');
  assert.equal(error.vramQuotaMB, 128, '没写 vramQuotaMB 时取租约的额度');
  assert.ok(error.usedMB > 128 && error.accountedMB === error.usedMB && error.probedMB === 0);
  assert.ok(killedHard(child));
  assert.equal(processIsAlive(child.pid), false);
  assert.deepEqual(error.survivors, []);
  // 租约已经归还：448 MB 的草稿立刻拿得到。
  const lease = await Promise.race([scheduler.acquire({ kind: 'draft', vramMB: 448 }), delay(1000).then(() => null)]);
  assert.ok(lease, '越线后租约没有归还');
  lease.release();
});

test('A14-4b 显存探针：量的是受管进程树（含孙进程），取账本与探针里大的；探针失败或回执不合格按超限处理', async (t) => {
  const seen = [];
  let reading = 100;
  const watchdog = watch(t, {
    quotas: { vramQuotaMB: 128, pollIntervalMs: 20 },
    probeVramMB: async ({ pids }) => { seen.push(pids); return reading; },
  });
  const { child, grandchild } = await withGrandchild(watchdog, PARENT);
  watchdog.recordVramBytes(120 * MB);
  await watchdog.check(); // 账本 120、探针 100，都没超
  assert.equal(watchdog.violation, null);
  reading = 200.5;
  const error = await rejected(watchdog.guard(never));
  refuses('failure.vram-exceeded', 1)(error);
  assert.deepEqual([error.usedMB, error.probedMB, error.accountedMB, error.vramQuotaMB], [200.5, 200.5, 120, 128]);
  assert.ok(seen.at(-1).includes(child.pid));
  if (posix) {
    assert.ok(seen.at(-1).includes(grandchild), '探针要拿到孙进程的进程号');
    assert.equal(processIsAlive(grandchild), false);
  }
  assert.ok(killedHard(child));

  for (const receipt of [NaN, -1, '64', null, { usedMB: 1 }, new Error('nvidia-smi 没了')]) {
    const blind = watch(t, {
      quotas: { vramQuotaMB: 128, pollIntervalMs: 20 },
      probeVramMB: () => { if (receipt instanceof Error) throw receipt; return receipt; },
    });
    const victim = blind.spawnManaged(node, ['-e', IDLE], { stdio: 'ignore' });
    const failed = await rejected(blind.check());
    refuses('failure.vram-exceeded', 1)(failed);
    assert.deepEqual([failed.reason, failed.usedMB], ['probe-failed', null]);
    assert.ok(failed.cause instanceof Error);
    assert.ok(killedHard(victim));
  }
});

test('A14-4c 探针输出解析：nvidia-smi 的进程表与 macOS footprint 的图形内存', async () => {
  const apps = parseNvidiaSmiApps('1234, 512\n5678, [N/A]\n1234, 100\n\n');
  assert.equal(apps.get(1234), 612);
  assert.ok(Number.isNaN(apps.get(5678)));
  assert.equal(apps.size, 2);
  assert.throws(() => parseNvidiaSmiApps('NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.'));
  const footprint = (rows) => `chrome-headless-shell [42]: 64-bit    Footprint: 256 MB (16384 bytes per page)\n  Dirty      Clean  Reclaimable    Regions    Category\n${rows}`;
  assert.equal(parseFootprintGraphicsMB(footprint('  69 MB        0 B          0 B         40    IOAccelerator (graphics)\n  64 KB        0 B          0 B          2    IOAccelerator\n')), 69);
  assert.equal(parseFootprintGraphicsMB(footprint('4816 KB        0 B         80 KB         39    IOAccelerator (graphics)\n')), 4816 / 1024);
  assert.equal(parseFootprintGraphicsMB(footprint(' 1.5 GB        0 B          0 B         39    IOAccelerator (graphics)\n')), 1536);
  assert.equal(parseFootprintGraphicsMB(footprint('3920 KB        0 B          0 B         11    Malloc Small\n')), 0);
  assert.throws(() => parseFootprintGraphicsMB('footprint: Unable to find any processes'));
  if (process.platform === 'darwin') {
    const usedMB = await createVramProbe()({ pids: [process.pid] });
    assert.ok(Number.isFinite(usedMB) && usedMB >= 0, `本机 footprint 实测：${usedMB}`);
    assert.equal(await createVramProbe()({ pids: [] }), 0);
  }
});

test('A14-5 磁盘统计：intermediate、deliver、snapshots、jobs、cache 全算，按 lstat 不跟符号链接', (t) => {
  const { base, dir } = workspace(t);
  const sizes = { 'film.json': 1000, 'intermediate/a.bin': 30_000, 'deliver/b.mp4': 40_000, 'snapshots/c.bin': 50_000, 'jobs/ledger.jsonl': 600, 'cache/d/e.bin': 70_000 };
  fs.mkdirSync(path.join(dir, 'cache', 'd'));
  for (const [file, size] of Object.entries(sizes)) fs.writeFileSync(path.join(dir, file), Buffer.alloc(size, 1));
  const logical = Object.values(sizes).reduce((sum, size) => sum + size, 0);
  const entries = 5 + 1 + 6; // 五个顶层目录、cache/d、六个文件
  const before = measureWorkspaceQuotaBytes(dir);
  assert.deepEqual([before.files, before.complete], [entries, true]);
  // 逐个文件取逻辑大小与已分配块里大的：不小于逻辑字节，多出来的只是块对齐。
  assert.ok(before.bytes >= logical && before.bytes <= logical + 6 * 65_536, `${before.bytes} / ${logical}`);

  // 工作区外的大文件、大目录软链进来：只算链接本身一个条目，不进去、不算目标的字节。
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'host.bin'), Buffer.alloc(4 * MB, 1));
  for (let index = 0; index < 20; index += 1) fs.writeFileSync(path.join(outside, `f${index}`), '');
  const linked = Number(trySymlink(path.join(outside, 'host.bin'), path.join(dir, 'intermediate', 'host.bin'), 'file'))
    + Number(trySymlink(outside, path.join(dir, 'deliver', 'host-dir'), 'dir'));
  const after = measureWorkspaceQuotaBytes(dir);
  assert.equal(after.files, entries + linked);
  assert.ok(after.bytes - before.bytes < 64 * 1024, '符号链接指向的 4 MB 不得算进来，也不得进目标目录');

  // 稀疏文件按逻辑大小算；越线提前交回。
  fs.writeFileSync(path.join(dir, 'cache', 'sparse.bin'), '');
  fs.truncateSync(path.join(dir, 'cache', 'sparse.bin'), 10 * MB);
  assert.ok(measureWorkspaceQuotaBytes(dir).bytes >= logical + 10 * MB);
  const early = measureWorkspaceQuotaBytes(dir, { maxFiles: 3 });
  assert.deepEqual([early.files, early.complete], [4, false]);
  assert.equal(measureWorkspaceQuotaBytes(dir, { maxBytes: 100 }).complete, false);
  // 文件名不是合法 UTF-8（ext4 等允许任意字节；APFS、NTFS 拒收这种名字，那里测不了）：照样数得到。
  const rawName = Buffer.concat([Buffer.from(path.join(dir, 'intermediate') + path.sep), Buffer.from([0x66, 0xff, 0xfe, 0x2e, 0x62, 0x69, 0x6e])]);
  let rawNameWritten = true;
  try {
    fs.writeFileSync(rawName, Buffer.alloc(200_000, 1));
  } catch {
    rawNameWritten = false;
    t.diagnostic('这个文件系统不收非 UTF-8 文件名，「按字节读文件名」这一段没有测');
  }
  if (rawNameWritten) {
    const withRaw = measureWorkspaceQuotaBytes(dir);
    assert.ok(withRaw.bytes >= logical + 10 * MB + 200_000, '非 UTF-8 文件名的文件被漏数了');
    fs.rmSync(rawName);
  }
  // 工作区自己是符号链接：拒收。
  if (trySymlink(dir, path.join(base, 'ws-link'), 'dir')) assert.throws(() => measureWorkspaceQuotaBytes(path.join(base, 'ws-link')), badArgument);
});

test('A14-5b 磁盘配额防绕过：子进程往 intermediate/、deliver/ 偷写照样被抓，零宽限强杀，报 failure.disk-quota（1）', async (t) => {
  for (const hidden of ['intermediate', 'deliver', 'cache', 'snapshots']) {
    const { dir } = workspace(t);
    fs.writeFileSync(path.join(dir, 'film.json'), Buffer.alloc(10_000, 1));
    const watchdog = watch(t, { workspaceDir: dir, quotas: { diskQuotaBytes: 200_000, pollIntervalMs: 20, frameTimeoutMs: 20_000 } });
    assert.equal(await watchdog.runFrame(0, () => 'under-quota'), 'under-quota');
    const leak = `require('node:fs').writeFileSync(require('node:path').join(process.argv[1], ${JSON.stringify(hidden)}, 'leak.bin'), Buffer.alloc(400000, 1)); ${IDLE}`;
    let child;
    const error = await rejected(watchdog.runFrame(1, () => {
      child = watchdog.spawnManaged(node, ['-e', leak, dir], { stdio: 'ignore' });
      return never();
    }));
    refuses('failure.disk-quota', 1)(error);
    assert.ok(error.usedBytes > 200_000 && error.diskQuotaBytes === 200_000, hidden);
    assert.ok(killedHard(child), hidden);
    assert.equal(processIsAlive(child.pid), false);
    // 已经超限的工作区：帧前检查就拦下，帧函数不执行；runWithWatchdog 也不起任务。
    const next = watch(t, { workspaceDir: dir, quotas: { diskQuotaBytes: 200_000 } });
    refuses('failure.disk-quota', 1)(await rejected(next.runFrame(0, () => assert.fail('超限的工作区不该再出帧'))));
    refuses('failure.disk-quota', 1)(await rejected(runWithWatchdog({ workspaceDir: dir, quotas: { diskQuotaBytes: 200_000 } }, () => assert.fail('不该起任务'))));
  }
});

test('A14-5d 排队期间工作区被写满：不再占着队列等额度，直接报 failure.disk-quota，调度器里不留排队项', async (t) => {
  const { dir } = workspace(t);
  const scheduler = new Scheduler({ totalMB: 512, previewReserveMB: 64 });
  const holder = await scheduler.acquire({ kind: 'draft', vramMB: 448 });
  const queued = rejected(runWithWatchdog({
    scheduler, scheduleSpec: { kind: 'draft', vramMB: 448 }, workspaceDir: dir, quotas: { diskQuotaBytes: 200_000, pollIntervalMs: 20 },
  }, () => assert.fail('没拿到额度不该起任务')));
  await delay(60);
  fs.writeFileSync(path.join(dir, 'deliver', 'flood.bin'), Buffer.alloc(400_000, 1));
  const error = await Promise.race([queued, delay(2000).then(() => assert.fail('越线之后还在排队'))]);
  refuses('failure.disk-quota', 1)(error);
  holder.release();
  // 排队项已经撤掉：额度归还之后立刻拿得到，不会先发给那个已经失败的任务。
  (await Promise.race([scheduler.acquire({ kind: 'draft', vramMB: 448 }), delay(1000).then(() => assert.fail('队列里还留着排队项'))])).release();
});

test('A14-5e 任务返回前的最后一查：帧外写超配额、显存涨过配额或 GPU 掉了之后正常返回，照样强杀受管进程、归还租约并报错，不当成功交回', async (t) => {
  const scheduler = new Scheduler({ totalMB: 512, previewReserveMB: 64 });
  const { dir } = workspace(t);
  let state = { usedMB: 0, healthy: true };
  const cases = [
    ['failure.disk-quota', { workspaceDir: dir, quotas: { diskQuotaBytes: 32_768 } }, () => fs.writeFileSync(path.join(dir, 'deliver', 'late.bin'), Buffer.alloc(65_536, 1))],
    ['failure.vram-exceeded', { quotas: {}, probeVramMB: () => state.usedMB }, () => { state.usedMB = 129; }],
    ['failure.gpu-lost', { quotas: {}, probeGpuHealth: () => state.healthy }, () => { state.healthy = false; }],
  ];
  for (const [code, options, overstep] of cases) {
    state = { usedMB: 0, healthy: true };
    let kept;
    // 轮询间隔拉到一分钟：任务期间的轮询赶不上，只有返回前的那一查抓得到。
    const error = await rejected(runWithWatchdog({
      ...options, scheduler, scheduleSpec: { kind: 'draft', vramMB: 128 }, quotas: { ...options.quotas, pollIntervalMs: 60_000 },
    }, async ({ watchdog }) => {
      kept = watchdog.spawnManaged(node, ['-e', IDLE], { stdio: 'ignore' });
      t.after(() => kept.kill('SIGKILL'));
      assert.equal(await watchdog.runFrame(0, () => 'frame-0'), 'frame-0');
      overstep(); // 帧外越线，然后若无其事地返回
      return 'complete';
    }));
    refuses(code, 1)(error);
    assert.ok(killedHard(kept), `${code}：残留的受管进程要强杀`);
    assert.deepEqual(error.survivors, [], code);
    (await Promise.race([scheduler.acquire({ kind: 'draft', vramMB: 448 }), delay(1000).then(() => assert.fail(`${code}：租约没有归还`))])).release();
  }
  // 任务自己把看门狗关了：最后一查做不了，按用法错误拒绝，不放行。
  await assert.rejects(runWithWatchdog({ quotas: {} }, ({ watchdog }) => { watchdog.close(); return 'complete'; }), badArgument);
});

test('A14-5c 文件数配额与量不出来的目录：空文件炸弹按条目数拦；目录改成不可读按超限处理', async (t) => {
  const { dir } = workspace(t);
  const watchdog = watch(t, { workspaceDir: dir, quotas: { maxFiles: 25 } });
  await watchdog.runFrame(0, () => {
    for (let index = 0; index < 20; index += 1) fs.writeFileSync(path.join(dir, 'cache', `ok-${index}`), '');
  });
  const error = await rejected(watchdog.runFrame(1, () => {
    fs.writeFileSync(path.join(dir, 'intermediate', 'one-too-many'), '');
  }));
  refuses('failure.disk-quota', 1)(error);
  assert.deepEqual([error.files, error.maxFiles], [26, 25]);

  const hidden = workspace(t).dir;
  const sealed = path.join(hidden, 'intermediate', 'sealed');
  fs.mkdirSync(sealed);
  fs.chmodSync(sealed, 0o000);
  try {
    let readable = true;
    try {
      fs.readdirSync(sealed);
    } catch {
      readable = false;
    }
    if (readable) {
      t.diagnostic('root 或 Windows 上 chmod 拦不住读，「目录不可读按超限处理」这一段没有测');
      return;
    }
    const blind = watch(t, { workspaceDir: hidden, quotas: { diskQuotaBytes: 10 * MB } });
    const unmeasurable = await rejected(blind.check());
    refuses('failure.disk-quota', 1)(unmeasurable);
    assert.equal(unmeasurable.reason, 'unmeasurable');
  } finally {
    fs.chmodSync(sealed, 0o700);
  }
});

test('A14-6 强杀原语与正常路径：killProcessTree 杀整组；任务正常结束时交回结果、归还租约、不动调用方的进程；抢占与取消经 signal 转达', async (t) => {
  if (posix) {
    const leader = spawn(node, ['-e', PARENT], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const grandchild = Number((await firstLine(leader.stdout)).split(' ')[1]);
    const exited = new Promise((resolve) => { leader.once('exit', resolve); });
    assert.equal(killProcessTree(leader.pid, { processGroup: true }), true);
    await exited;
    for (let waited = 0; processIsAlive(grandchild) && waited < 2000; waited += 20) await delay(20);
    assert.equal(processIsAlive(grandchild), false);
    assert.equal(killProcessTree(leader.pid, { processGroup: true }), false, '已经不在的进程：没有可杀的');
  }

  const scheduler = new Scheduler({ totalMB: 512, previewReserveMB: 64 });
  let kept;
  const result = await runWithWatchdog({ scheduler, scheduleSpec: { kind: 'draft', vramMB: 128 }, quotas: { frameTimeoutMs: 5000 } }, async ({ watchdog, signal }) => {
    kept = watchdog.spawnManaged(node, ['-e', IDLE], { stdio: 'ignore' });
    assert.equal(signal.aborted, false);
    return watchdog.runFrame(0, () => 'frame-0');
  });
  t.after(() => kept.kill('SIGKILL'));
  assert.equal(result, 'frame-0');
  assert.equal(processIsAlive(kept.pid), true, '没越线的任务，进程归调用方自己收');
  (await scheduler.acquire({ kind: 'draft', vramMB: 448 })).release();

  // 终渲抢占草稿：草稿任务从 signal 上得知，收手之后终渲才拿到租约。
  let finalLease;
  const draft = runWithWatchdog({ scheduler, scheduleSpec: { kind: 'draft', vramMB: 448 }, quotas: {} }, ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(signal.reason));
    finalLease = scheduler.acquire({ kind: 'final' });
  }));
  assert.equal(await draft, 'preempted');
  (await finalLease).release();

  // 调用方先取消：不排队、不起任务。
  const cancelled = new Error('作业已取消');
  assert.equal(await rejected(runWithWatchdog({ scheduler, scheduleSpec: { kind: 'draft' }, quotas: {}, signal: AbortSignal.abort(cancelled) }, () => assert.fail('已取消'))), cancelled);
  (await scheduler.acquire({ kind: 'final' })).release();
  // 任务自己的错原样抛出，租约照还。
  const own = new Error('任务自己失败');
  assert.equal(await rejected(runWithWatchdog({ scheduler, scheduleSpec: { kind: 'draft' }, quotas: {} }, () => { throw own; })), own);
  (await scheduler.acquire({ kind: 'final' })).release();
});

// ───────────── 真实无头浏览器：两个独立浏览器进程同卡并发 ─────────────

async function launch(t) {
  let server;
  try {
    server = await chromium.launchServer({ headless: true, executablePath: chromeExecutable(), args: [...chromeArgs(), '--mute-audio'] });
  } catch (error) {
    t.skip(`起不了浏览器：${String(error.message).split('\n')[0]}`);
    return null;
  }
  t.after(() => server.kill().catch(() => {}));
  const browser = await chromium.connect(server.wsEndpoint());
  const page = await browser.newPage();
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl ? String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null;
  });
  if (!renderer) {
    t.skip('这个浏览器没有 WebGL2');
    return null;
  }
  return { server, browser, page, pid: server.process().pid, renderer };
}

// 正常任务的一帧：64×64 画布，底色上画一个正中的色块，整幅读回，逐像素对。
const goodFrame = (page, index) => page.evaluate(({ fill, background }) => {
  if (!window.good) {
    const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
    const gl = canvas.getContext('webgl2', { antialias: false });
    window.good = { gl, lostEvents: 0 };
    canvas.addEventListener('webglcontextlost', () => { window.good.lostEvents += 1; });
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, '#version 300 es\nin vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; uniform vec3 c; out vec4 o; void main() { o = vec4(c, 1.0); }'));
    gl.linkProgram(program);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    window.good.color = gl.getUniformLocation(program, 'c');
  }
  const { gl } = window.good;
  gl.clearColor(background[0] / 255, background[1] / 255, background[2] / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform3f(window.good.color, fill[0] / 255, fill[1] / 255, fill[2] / 255);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const pixels = new Uint8Array(64 * 64 * 4);
  gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let mismatches = 0;
  let filled = 0;
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const inside = x >= 16 && x < 48 && y >= 16 && y < 48;
      const want = inside ? fill : background;
      const at = (y * 64 + x) * 4;
      filled += Number(inside);
      if (pixels[at] !== want[0] || pixels[at + 1] !== want[1] || pixels[at + 2] !== want[2] || pixels[at + 3] !== 255) mismatches += 1;
    }
  }
  return { mismatches, filled, lost: gl.isContextLost(), lostEvents: window.good.lostEvents, glError: gl.getError() };
}, {
  fill: [(index * 37 + 20) % 256, (index * 59 + 90) % 256, (index * 83 + 160) % 256],
  background: [(index * 71 + 200) % 256, (index * 13 + 5) % 256, (index * 101 + 60) % 256],
});

// 恶邻一：不停分配 2048×2048 的 RGBA32F 纹理并写满，每张 64 MiB。report 为真时每分配成功一张就按实际字节数回报。
const hogVram = ({ count, report, pauseMs }) => (async () => {
  const gl = document.createElement('canvas').getContext('webgl2');
  window.hog = [];
  for (let index = 0; index < count; index += 1) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 2048, 2048);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 2048, 2048, gl.RGBA, gl.FLOAT, new Float32Array(2048 * 2048 * 4).fill(0.5));
    gl.finish();
    if (gl.getError() !== gl.NO_ERROR) throw new Error('纹理没有分配成功');
    window.hog.push(texture);
    if (report) await window.reportVram(2048 * 2048 * 16);
    await new Promise((resolve) => { setTimeout(resolve, pauseMs); });
  }
  return count;
})();

// 恶邻二：每个像素循环 n 次的片元着色器，分两步。片元源码放在宿主这边，A14-8b 的负对照只改其中一个词。
const HANG_FRAGMENT = `#version 300 es
  precision highp float; uniform float seed; uniform int n; out vec4 o;
  void main() { float a = seed + gl_FragCoord.x * 0.001; for (int i = 0; i < n; i++) { a = fract(sin(a * 12.9898 + float(i)) * 43758.5453) + 0.1; } o = vec4(fract(a), 0.5, 0.0, 1.0); }`;

// 第一步（看门狗开始数心跳之前）：编译、链接，n = 1 画一次读回一次，交回回执；链接好的程序留在 window.__bmHang 给第二步用。
const primeHangShader = (fragment) => {
  const canvas = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
  const gl = canvas.getContext('webgl2');
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const shaders = [
    compile(gl.VERTEX_SHADER, `#version 300 es
    void main() { vec2 v = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0); }`),
    compile(gl.FRAGMENT_SHADER, fragment),
  ];
  const program = gl.createProgram();
  for (const shader of shaders) gl.attachShader(program, shader);
  gl.linkProgram(program);
  if (!shaders.every((shader) => gl.getShaderParameter(shader, gl.COMPILE_STATUS)) || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
    return { linked: false, infoLog: [...shaders.map((shader) => gl.getShaderInfoLog(shader)), gl.getProgramInfoLog(program)].join('') };
  }
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, 'n'), 1);
  gl.uniform1f(gl.getUniformLocation(program, 'seed'), 0);
  gl.viewport(0, 0, 128, 128);
  const pixel = new Uint8Array(4);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  window.__bmHang = { gl, program };
  return { linked: true, glError: gl.getError(), pixel: [...pixel] };
};

// 回执要过的关：链接成功、没有 GL 错误、读回是这段着色器的固定输出（红非零、绿 0.5、蓝 0、不透明）。
// 编译失败时读回的是全零，过不了这一关，也就进不了无心跳阶段。
const assertHangShaderPrimed = (receipt) => {
  assert.equal(receipt.linked, true, `着色器没有编译链接成功：${receipt.infoLog}`);
  assert.equal(receipt.glError, 0);
  const [red, green, blue, alpha] = receipt.pixel;
  assert.ok(red > 0 && green >= 127 && green <= 128 && blue === 0 && alpha === 255, `首次绘制读回 [${receipt.pixel}]`);
};

// 第二步：同一个上下文、同一个程序，每像素循环十五万次，128×128 一次只画一小幅、画完立刻读回，连画 3 秒。
// 渲染线程这 3 秒一直卡在着色器求值与读回上；显卡队列里任何时刻最多一次小绘制（本机约 28 ms），进程被杀后不拖住同卡的别人。
// 按墙钟收尾而不按次数：显卡再快也挂满 3 秒，远大于 A14-8 的 shaderHangMs。
const loopHangShader = () => {
  const { gl, program } = window.__bmHang;
  gl.uniform1i(gl.getUniformLocation(program, 'n'), 150_000);
  const pixel = new Uint8Array(4);
  const until = performance.now() + 3000;
  for (let draw = 0; performance.now() < until; draw += 1) {
    gl.uniform1f(gl.getUniformLocation(program, 'seed'), draw * 0.1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  }
  return [...pixel];
};

/**
 * 同一个调度器、同一块显卡上的两个任务：正常任务 B（预览）先出两帧，恶邻 A（草稿，128 MB）开始作恶，
 * B 在 A 作恶期间一直出帧，A 被强杀之后再出三帧。交回 A 的错、A 的进程号、B 的全部帧。
 */
async function neighbours(t, { quotas, probeVramMB, misbehave }) {
  const good = await launch(t);
  const evil = good && await launch(t);
  if (!evil) return null;
  const scheduler = new Scheduler({ totalMB: 512, previewReserveMB: 64 });
  let disconnected = false;
  good.browser.on('disconnected', () => { disconnected = true; });
  let evilSettled = false;
  let misbehaving = false;
  let startEvil;
  const evilMayStart = new Promise((resolve) => { startEvil = resolve; });

  const goodTask = runWithWatchdog({ scheduler, scheduleSpec: { kind: 'preview' }, quotas: { frameTimeoutMs: 30_000 } }, async ({ watchdog }) => {
    watchdog.registerProcess(good.server.process(), { processGroup: posix });
    const frames = [];
    const frame = async () => {
      const during = misbehaving && !evilSettled;
      const began = Date.now();
      const result = await watchdog.runFrame(frames.length, () => goodFrame(good.page, frames.length));
      frames.push({ ...result, ms: Date.now() - began, during: during && !evilSettled, after: evilSettled });
    };
    await frame();
    await frame();
    startEvil();
    do {
      await frame();
      await delay(10);
    } while (!evilSettled);
    for (let extra = 0; extra < 3; extra += 1) await frame();
    return frames;
  });

  const evilTask = evilMayStart.then(() => runWithWatchdog({
    scheduler, scheduleSpec: { kind: 'draft', vramMB: 128 }, quotas: { frameTimeoutMs: 60_000, pollIntervalMs: 100, ...quotas }, probeVramMB,
  }, async ({ watchdog, lease }) => {
    assert.equal(lease.vramMB, 128);
    watchdog.registerProcess(evil.server.process(), { processGroup: posix });
    evil.browser.on('disconnected', () => watchdog.reportGpuLost('browser-disconnected'));
    await evil.page.exposeFunction('reportVram', (bytes) => watchdog.recordVramBytes(bytes));
    return watchdog.runFrame(0, () => {
      misbehaving = true;
      return misbehave(evil.page, watchdog);
    });
  }));
  const started = Date.now();
  // 正常任务先倒了就直接判败，不干等恶邻。
  const error = await Promise.race([rejected(evilTask), goodTask.then(never)]).finally(() => { evilSettled = true; });
  const elapsedMs = Date.now() - started;
  // 夹具自己的断言（比如着色器回执没过）原样报出来，不让下面的「进程还在」盖住真正的原因。
  if (error instanceof assert.AssertionError) throw error;
  // 恶邻的浏览器进程树已经死透，租约当场归还：448 MB 的草稿立刻拿得到。
  assert.equal(processIsAlive(evil.pid), false, '恶邻的浏览器进程还在');
  if (posix) assert.equal(processIsAlive(evil.pid, { processGroup: true }), false, '恶邻的进程组里还有活口（GPU 进程、渲染进程）');
  assert.deepEqual(error.survivors, []);
  const lease = await Promise.race([scheduler.acquire({ kind: 'draft', vramMB: 448 }), delay(1000).then(() => null)]);
  assert.ok(lease, '恶邻被杀之后租约没有归还');
  lease.release();

  const frames = await goodTask;
  assert.ok(frames.length >= 6, `正常任务只出了 ${frames.length} 帧`);
  const during = frames.filter((frame) => frame.during).length;
  assert.ok(during >= 1 && frames.filter((frame) => frame.after).length >= 3, `恶邻作恶期间（${during} 帧）与被杀之后都要有帧`);
  for (const [index, frame] of frames.entries()) {
    assert.deepEqual(
      { mismatches: frame.mismatches, filled: frame.filled, lost: frame.lost, lostEvents: frame.lostEvents, glError: frame.glError },
      { mismatches: 0, filled: 1024, lost: false, lostEvents: 0, glError: 0 },
      `正常任务第 ${index} 帧`,
    );
  }
  assert.equal(disconnected, false, '正常任务的浏览器不得断连');
  assert.equal(processIsAlive(good.pid), true);
  t.diagnostic(`显卡：${good.renderer}；正常任务 ${frames.length}/${frames.length} 帧逐像素一致（恶邻作恶期间 ${during} 帧，其中单帧最长 ${Math.max(...frames.filter((frame) => frame.during).map((frame) => frame.ms))} ms）；恶邻 ${elapsedMs} ms 后被杀（${error.code}）`);
  return { error, elapsedMs, frames };
}

test('A14-7 真实 WebGL2「故意打满显存」的恶邻：不停分配 64 MiB 纹理，越过 128 MB 配额即被 SIGKILL（最多分到 192 MiB），租约归还，同卡正常任务帧帧逐像素一致', async (t) => {
  const outcome = await neighbours(t, {
    probeVramMB: process.platform === 'darwin' ? createVramProbe() : undefined,
    misbehave: (page) => page.evaluate(hogVram, { count: 16, report: true, pauseMs: 0 }),
  });
  if (!outcome) return;
  refuses('failure.vram-exceeded', 1)(outcome.error);
  assert.equal(outcome.error.vramQuotaMB, 128);
  assert.ok(outcome.error.usedMB > 128 && outcome.error.usedMB <= 192, `用到 ${outcome.error.usedMB} MB 时被拦下`);
});

test('A14-7b 真实 WebGL2「不自报也照杀」：恶邻不申报，靠本机显存探针量 GPU 进程的图形内存抓到', {
  skip: process.platform === 'darwin' ? false : '内置的实测探针目前只有 macOS 的 footprint；nvidia-smi 一路没有在 NVIDIA 机器上实测',
}, async (t) => {
  const outcome = await neighbours(t, {
    probeVramMB: createVramProbe(),
    misbehave: (page) => page.evaluate(hogVram, { count: 16, report: false, pauseMs: 150 }),
  });
  if (!outcome) return;
  refuses('failure.vram-exceeded', 1)(outcome.error);
  assert.equal(outcome.error.accountedMB, 0, '账本上没有申报');
  assert.ok(outcome.error.probedMB > 128 && outcome.error.probedMB < 16 * 64, `探针量到 ${outcome.error.probedMB} MB`);
});

test('A14-8 真实 WebGL2「死循环着色器」：渲染卡死无心跳，shaderHangMs 一到零宽限 SIGKILL，同卡正常任务帧帧逐像素一致', async (t) => {
  const outcome = await neighbours(t, {
    quotas: { shaderHangMs: 250 },
    misbehave: async (page, watchdog) => {
      // 先拿到这段着色器真的画出东西的回执，再开始数心跳：坏着色器在这里就失败，轮不到看门狗来「杀对」。
      assertHangShaderPrimed(await page.evaluate(primeHangShader, HANG_FRAGMENT));
      watchdog.beginShaderPass('bounded-shader-hang');
      const pixel = await page.evaluate(loopHangShader);
      watchdog.endShaderPass();
      return pixel;
    },
  });
  if (!outcome) return;
  refuses('timeout.shader-hang', 124)(outcome.error);
  assert.deepEqual([outcome.error.label, outcome.error.shaderHangMs], ['bounded-shader-hang', 250]);
  assert.ok(outcome.elapsedMs >= 250 && outcome.elapsedMs < 250 + 2500, `${outcome.elapsedMs} ms`);
});

test('A14-8b 负对照：片元着色器编译不过（或读回全零）时拿不到回执，A14-8 进不了无心跳阶段', async (t) => {
  const evil = await launch(t);
  if (!evil) return;
  const broken = HANG_FRAGMENT.replace('out vec4 o;', 'out nope4 o;');
  assert.notEqual(broken, HANG_FRAGMENT);
  const receipt = await evil.page.evaluate(primeHangShader, broken);
  assert.equal(receipt.linked, false);
  assert.ok(receipt.infoLog.length > 0, '编译日志是空的');
  assert.equal(await evil.page.evaluate(() => window.__bmHang), undefined, '没链接成功就不留程序给第二步');
  assert.throws(() => assertHangShaderPrimed(receipt), assert.AssertionError);
  // 没查链接状态、硬画了一次的样子（四审量到的负对照读数）同样过不了。
  assert.throws(() => assertHangShaderPrimed({ linked: true, glError: 1282, pixel: [0, 0, 0, 0] }), assert.AssertionError);
  assert.throws(() => assertHangShaderPrimed({ linked: true, glError: 0, pixel: [0, 0, 0, 0] }), assert.AssertionError);
  // 同一个页面上，原样的着色器拿得到回执。
  assertHangShaderPrimed(await evil.page.evaluate(primeHangShader, HANG_FRAGMENT));
});
