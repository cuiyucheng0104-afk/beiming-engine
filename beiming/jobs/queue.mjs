import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { atomicWrite, checkJobId, checkKeep, openWorkspace, readText, safePath } from './workspace.mjs';
import { defaultScheduler } from './scheduler.mjs';

const terminal = new Set(['succeeded', 'failed', 'canceled', 'stopped']);
const transitions = {
  queued: new Set(['running', 'canceled']),
  running: terminal,
};
const active = new Map();

function jsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('作业数据必须是纯 JSON 值。');
  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (!array && prototype !== Object.prototype && prototype !== null) throw new TypeError('作业数据必须是纯 JSON 值。');
  ancestors.add(value);
  const copy = array ? Array.from(value, item => jsonValue(item, ancestors)) :
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, ancestors)]));
  ancestors.delete(value);
  return copy;
}

function addEvent(job, type, details) {
  const seq = job.events.length + 1;
  job.events.push({ seq, attempt: job.attempt, type, ...details });
  return seq;
}

function transition(job, status, details) {
  if (!transitions[job.status]?.has(status)) throw new Error(`作业状态不能从 ${job.status} 转到 ${status}。`);
  job.status = status;
  addEvent(job, status, details);
}

function nextAttempt(job) {
  if (!terminal.has(job.status)) throw new Error('只有终态作业可以新建运行轮次。');
  job.attempt += 1;
  job.status = 'queued';
  delete job.result;
  delete job.error;
  addEvent(job, 'queued');
}

function message(error) {
  return error instanceof Error ? error.message || error.name : String(error);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('作业执行进程记录损坏。');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

// dir 是工作区根目录，队列描述存放在 jobs/<id>/job.json。
// 一个执行进程管理设备租约，交接时由新进程读盘或显式重放。
export function loadQueue(dir, { handlers = {}, scheduler = defaultScheduler, clock = () => performance.now() } = {}) {
  const workspace = openWorkspace(dir);
  const jobFile = id => workspace.resolve(`jobs/${checkJobId(id)}/job.json`);
  const ownerFile = (id, attempt, generation) => workspace.resolve(`jobs/${checkJobId(id)}/attempt-${attempt}.owner-${generation}`);

  function readJob(id) {
    const job = JSON.parse(readText(jobFile(id)));
    if (job?.format !== 'job/0.1' || job.id !== id ||
        !(job.status === 'queued' || job.status === 'running' || terminal.has(job.status)) ||
        !Number.isSafeInteger(job.attempt) || job.attempt < 1 || !Array.isArray(job.events) || !Array.isArray(job.steps)) {
      throw new Error('作业运行记录损坏。');
    }
    return job;
  }

  function save(job, create = false) {
    atomicWrite(jobFile(job.id), `${JSON.stringify(job, null, 2)}\n`, { create });
  }

  // 领取文件按轮次和代号追加。崩溃后只能通过下一代恢复，避免两个进程移除对方的领取文件。
  function claim(job, attempt = job.attempt) {
    let file;
    for (let generation = 1; ; generation += 1) {
      file = ownerFile(job.id, attempt, generation);
      try {
        atomicWrite(file, `${process.pid}\n`, { create: true });
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (processIsAlive(Number(readText(file).trim())) || attempt === job.attempt) {
          throw new Error('该作业轮次已经由执行器领取。', { cause: error });
        }
      }
    }
    try {
      if (readJob(job.id).events.length !== job.events.length) throw new Error('作业状态已在磁盘上更新。');
    } catch (error) {
      fs.rmSync(file, { force: true });
      throw error;
    }
  }

  function owner(job) {
    let pid;
    for (let generation = 1; ; generation += 1) {
      const file = ownerFile(job.id, job.attempt, generation);
      if (!fs.lstatSync(file, { throwIfNoEntry: false })) return pid;
      pid = Number(readText(file).trim());
    }
  }

  function enqueue({ id, kind, vramMB, priority, handler = kind, payload = null, rev, uncommitted = false, keep = 'none' } = {}) {
    const request = scheduler.request({ kind, vramMB, priority });
    checkKeep(keep);
    if (kind === 'final' && uncommitted === true) throw new Error('终渲需要已提交的修订。');
    if (typeof handler !== 'string' || !/^[a-z][a-z0-9-]*$/.test(handler) || /[^a-z0-9-]/.test(handler)) {
      throw new TypeError('作业执行器名称无效。');
    }
    if (id !== undefined) checkJobId(id);
    const input = jsonValue(payload);
    const snapshot = workspace.snapshot({ rev, uncommitted });
    for (let number = 1; ; number += 1) {
      const jobId = id ?? `job-${number}`;
      const file = jobFile(jobId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const job = { format: 'job/0.1', id: jobId, request, handler, payload: input, snapshot, keep,
        status: 'queued', attempt: 1, events: [], steps: [] };
      addEvent(job, 'queued');
      try {
        save(job, true);
        return job;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (id !== undefined) throw new Error('该作业标识已经存在。', { cause: error });
      }
    }
  }

  function listJobs() {
    const entries = fs.readdirSync(workspace.resolve('jobs'), { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const ids = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) workspace.resolve(`jobs/${entry.name}`);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) continue;
      if (fs.lstatSync(jobFile(entry.name), { throwIfNoEntry: false })) ids.push(entry.name);
    }
    return ids.map(readJob);
  }

  function finish(job, status, details) {
    workspace.cleanupIntermediate(job.id, { keep: job.keep, status, attempt: job.attempt });
    transition(job, status, details);
    save(job);
  }

  async function execute(job, handler, signal) {
    for (;;) {
      let lease;
      try {
        try {
          lease = await scheduler.acquire(job.request, { signal });
        } catch (error) {
          if (!signal.aborted) throw error;
        }
        if (signal.aborted) {
          finish(job, 'canceled', { reason: 'canceled' });
          return job;
        }
        transition(job, 'running');
        save(job);
        const outcome = await executeAttempt(job, handler, lease.signal);
        if (signal.aborted) {
          finish(job, 'canceled', { reason: 'canceled' });
          return job;
        }
        if (lease.signal.reason !== 'preempted') {
          if (outcome.error !== undefined) job.error = outcome.error;
          if (outcome.result !== undefined) job.result = outcome.result;
          finish(job, outcome.status);
          return job;
        }
        finish(job, 'stopped', { reason: 'preempted' });
        claim(job, job.attempt + 1);
        nextAttempt(job);
        save(job);
      } finally {
        lease?.release();
      }
    }
  }

  async function executeAttempt(job, handler, signal) {
    const pending = new Set();
    let acceptingSteps = true;
    async function measure(name, run) {
      if (!acceptingSteps) throw new Error('作业执行器已经返回。');
      signal.throwIfAborted();
      if (typeof name !== 'string' || !name || typeof run !== 'function') throw new TypeError('步骤需要名称和执行函数。');
      const entry = { name, attempt: job.attempt, startEvent: addEvent(job, 'step-start', { name }) };
      job.steps.push(entry);
      save(job);
      let status = 'failed';
      let durationMs;
      try {
        const started = clock();
        if (!Number.isFinite(started)) throw new Error('步骤计时需要有限的毫秒读数。');
        let result;
        try {
          result = await run();
          signal.throwIfAborted();
        } catch (error) {
          try {
            const ended = clock();
            if (Number.isFinite(ended) && ended >= started && Number.isFinite(ended - started)) {
              durationMs = ended - started;
            }
          } catch {}
          throw error;
        }
        const ended = clock();
        if (!Number.isFinite(ended) || ended < started || !Number.isFinite(ended - started)) {
          throw new Error('步骤计时需要有限且单调的毫秒读数。');
        }
        durationMs = ended - started;
        status = 'succeeded';
        return result;
      } finally {
        entry.status = signal.aborted ? 'stopped' : status;
        if (durationMs !== undefined) entry.durationMs = durationMs;
        entry.endEvent = addEvent(job, 'step-end', { name, status: entry.status });
        save(job);
      }
    }
    function step(name, run) {
      const measured = measure(name, run);
      pending.add(measured);
      const remove = () => pending.delete(measured);
      measured.then(remove, remove);
      return measured;
    }
    try {
      signal.throwIfAborted();
      const snapshot = workspace.openSnapshot(job.snapshot);
      const intermediateDir = workspace.intermediateDir(job.id, job.attempt);
      fs.mkdirSync(intermediateDir, { recursive: true });
      const result = await handler({ job: structuredClone(job), signal, step, snapshot,
        inputPath: relative => {
          safePath(snapshot.dir, relative);
          return workspace.resolve(`${path.relative(workspace.root, snapshot.dir).split(path.sep).join('/')}/${relative}`);
        },
        intermediateDir });
      return { status: 'succeeded', ...(result !== undefined && { result: jsonValue(result) }) };
    } catch (error) {
      return { status: 'failed', error: message(error) };
    } finally {
      acceptingSteps = false;
      await Promise.allSettled(pending);
    }
  }

  function launch(job, handler) {
    const controller = new AbortController();
    const file = jobFile(job.id);
    const promise = Promise.resolve().then(() => execute(job, handler, controller.signal)).finally(() => active.delete(file));
    active.set(file, { controller, promise });
    return promise.then(result => structuredClone(result));
  }

  function getHandler(job) {
    const handler = Object.hasOwn(handlers, job.handler) && handlers[job.handler];
    if (typeof handler !== 'function') throw new TypeError(`缺少作业执行器 ${job.handler}。`);
    return handler;
  }

  function runJob(id) {
    const job = readJob(id);
    if (job.status !== 'queued') throw new Error('只能启动排队中的作业。');
    const handler = getHandler(job);
    scheduler.request(job.request);
    claim(job);
    return launch(job, handler);
  }

  function replay(id) {
    const job = readJob(id);
    if (active.has(jobFile(id))) throw new Error('作业仍由本进程执行。');
    const handler = getHandler(job);
    scheduler.request(job.request);
    const pid = owner(job);
    if (job.status === 'queued' && pid === undefined) {
      claim(job);
      return launch(job, handler);
    }
    if (!terminal.has(job.status) && (pid === undefined || processIsAlive(pid))) throw new Error('作业仍由执行进程领取。');
    claim(job, job.attempt + 1);
    if (job.status === 'running') {
      for (const step of job.steps.filter(step => step.attempt === job.attempt && !step.endEvent)) {
        step.status = 'stopped';
        step.endEvent = addEvent(job, 'step-end', { name: step.name, status: 'stopped' });
      }
      finish(job, 'stopped', { reason: 'interrupted' });
    } else if (job.status === 'queued') {
      finish(job, 'canceled', { reason: 'interrupted' });
    }
    nextAttempt(job);
    save(job);
    return launch(job, handler);
  }

  function cancelJob(id) {
    const entry = active.get(jobFile(id));
    if (entry) {
      entry.controller.abort('canceled');
      return entry.promise.then(job => structuredClone(job));
    }
    const job = readJob(id);
    if (job.status === 'canceled') return Promise.resolve(job);
    if (job.status !== 'queued') throw new Error('当前作业状态不能取消。');
    claim(job);
    finish(job, 'canceled', { reason: 'canceled' });
    return Promise.resolve(job);
  }

  function waitForJob(id, { timeoutMs = 30000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) {
      throw new RangeError('长轮询超时必须是有效的整数毫秒。');
    }
    const view = job => ({ id, status: job.status, events: job.events.slice(-5) });
    const initial = readJob(id);
    if (terminal.has(initial.status) || timeoutMs === 0) return Promise.resolve(view(initial));
    return new Promise((resolve, reject) => {
      function check(timedOut) {
        try {
          const job = readJob(id);
          if (!timedOut && !terminal.has(job.status)) return;
          resolve(view(job));
        } catch (error) {
          reject(error);
        }
        clearTimeout(deadline);
        clearInterval(poll);
      }
      const deadline = setTimeout(check, timeoutMs, true);
      const poll = setInterval(check, 25, false); // 毫秒
    });
  }

  return Object.freeze({ enqueue, runJob, getJob: readJob, listJobs, jobFile, waitForJob, cancelJob, replay });
}

export function replayJob(jobFile, handlers, options) {
  const file = path.resolve(jobFile);
  const jobDir = path.dirname(file);
  const queueDir = path.dirname(jobDir);
  if (path.basename(file) !== 'job.json' || path.basename(queueDir) !== 'jobs') {
    throw new TypeError('作业文件需要位于工作区的 jobs/<id>/job.json。');
  }
  const id = checkJobId(path.basename(jobDir));
  return loadQueue(path.dirname(queueDir), { ...options, handlers }).replay(id);
}
