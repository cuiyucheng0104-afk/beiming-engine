import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { atomicWrite, checkJobId, checkKeep, locateOwned, openWorkspace, processIsAlive, readText, safePath } from './workspace.mjs';
import { appendSettlement, isPlainObject, prepareSettlement, quoteFromDraft, readJobLedger, summarizeJobLedger, withFileLock } from './ledger.mjs';
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
  const array = Array.isArray(value);
  if (!array && !isPlainObject(value)) throw new TypeError('作业数据必须是纯 JSON 值。');
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

// dir 是工作区根目录，队列描述存放在 jobs/<id>/job.json。
// 一个执行进程管理设备租约，交接时由新进程读盘或显式重放。
export function loadQueue(dir, { handlers = {}, scheduler = defaultScheduler, clock = () => performance.now() } = {}) {
  const workspace = openWorkspace(dir);
  const jobFile = id => workspace.resolve(`jobs/${checkJobId(id)}/job.json`);
  const ledgerFile = () => workspace.resolve('jobs/ledger.jsonl');
  const ownerFileIn = (jobDir, attempt, generation) => path.join(jobDir, `attempt-${attempt}.owner-${generation}`);
  const parseOwnerPid = text => Number(text.trim().split(/\s+/)[0]);

  function readJob(id, file = jobFile(id)) {
    const job = JSON.parse(readText(file));
    if (job?.format !== 'job/0.1' || job.id !== id ||
        !(job.status === 'queued' || job.status === 'running' || terminal.has(job.status)) ||
        !Number.isSafeInteger(job.attempt) || job.attempt < 1 || !Array.isArray(job.events) || !Array.isArray(job.steps)) {
      throw new Error('作业运行记录损坏。');
    }
    return job;
  }

  function readLockedJob(id, locked) {
    for (;;) {
      const file = locked();
      let snap;
      try {
        snap = readJob(id, file);
      } catch (error) {
        if (error?.code === 'ENOENT' && locked() !== file) continue;
        throw error;
      }
      if (locked() === file) return snap;
    }
  }

  function save(job, create = false, file = jobFile(job.id)) {
    atomicWrite(file, `${JSON.stringify(job, null, 2)}\n`, { create });
  }

  function saveUnderLock(job, locked) {
    const text = `${JSON.stringify(job, null, 2)}\n`;
    for (;;) {
      const baseFile = locked();
      let published = false;
      try {
        atomicWrite(baseFile, text, {
          stagingParent: path.dirname(baseFile),
          aroundPublish: publish => {
            if (locked() !== baseFile) return;
            publish();
            published = true;
          },
        });
      } catch (error) {
        if (['ENOENT', 'EXDEV'].includes(error?.code) && locked() !== baseFile) continue;
        throw error;
      }
      if (published) return;
    }
  }

  function withGenLock(gen, fn) {
    for (;;) {
      const target = gen.resolveFile();
      let matched = false;
      const out = withFileLock(target, locked => {
        if (locked() !== gen.resolveFile()) return undefined;
        matched = true;
        return fn(locked);
      });
      if (matched) return out;
    }
  }

  function saveGen(job, gen) {
    withGenLock(gen, locked => saveUnderLock(job, locked));
  }

  function findActiveForDir(jobDir) {
    for (const entry of active.values()) {
      try {
        if (entry.gen.currentDir() === jobDir) return entry;
      } catch {}
    }
    return undefined;
  }

  // 在已持有的文件锁下领取轮次：发布点核对 locked() 未换代，确保领取文件与当前锁严格共处同一代目录。
  function claimUnderLock(job, attempt, locked) {
    checkJobId(job.id);
    for (;;) {
      const baseFile = locked();
      let lastDir = path.dirname(baseFile);
      const token = `${process.pid} ${randomUUID()}\n`;
      let claimedFile;
      let abortedRotate = false;
      for (let generation = 1; ; generation += 1) {
        if (locked() !== baseFile) {
          abortedRotate = true;
          break;
        }
        claimedFile = ownerFileIn(lastDir, attempt, generation);
        let published = false;
        try {
          atomicWrite(claimedFile, token, {
            stagingParent: lastDir,
            create: true,
            aroundPublish: publish => {
              if (locked() !== baseFile) return;
              publish();
              published = true;
            },
          });
          if (!published) abortedRotate = true;
          break;
        } catch (error) {
          if (['ENOENT', 'EXDEV'].includes(error?.code) && locked() !== baseFile) {
            abortedRotate = true;
            break;
          }
          if (error.code !== 'EEXIST') throw error;
          if (locked() !== baseFile) {
            abortedRotate = true;
            break;
          }
          if (processIsAlive(parseOwnerPid(readText(claimedFile))) || attempt === job.attempt) {
            throw new Error('该作业轮次已经由执行器领取。', { cause: error });
          }
        }
      }
      if (abortedRotate) continue;
      const ownerName = path.basename(claimedFile);
      const resolveFile = () => {
        const found = locateOwned(path.join(lastDir, ownerName), candidate => readText(candidate) === token, true);
        if (!found) throw new Error('作业所属目录在执行期间丢失。');
        lastDir = path.dirname(found);
        return path.join(lastDir, 'job.json');
      };
      try {
        const currentFile = resolveFile();
        if (currentFile !== locked()) {
          const mine = locateOwned(path.join(lastDir, ownerName), candidate => readText(candidate) === token);
          if (mine) fs.rmSync(mine, { force: true });
          continue;
        }
        const disk = readLockedJob(job.id, locked);
        if (resolveFile() !== locked() || disk.events.length !== job.events.length) {
          throw new Error('作业状态已在磁盘上更新。');
        }
      } catch (error) {
        const mine = locateOwned(path.join(lastDir, ownerName), candidate => readText(candidate) === token);
        if (mine) fs.rmSync(mine, { force: true });
        throw error;
      }
      return { token, resolveFile, currentDir: () => path.dirname(resolveFile()) };
    }
  }

  function ownerLocked(job, locked) {
    checkJobId(job.id);
    for (;;) {
      const baseFile = locked();
      const jobDir = path.dirname(baseFile);
      let pid;
      let rotated = false;
      for (let generation = 1; ; generation += 1) {
        if (locked() !== baseFile) {
          rotated = true;
          break;
        }
        const candidate = ownerFileIn(jobDir, job.attempt, generation);
        if (!fs.lstatSync(candidate, { throwIfNoEntry: false })) break;
        try {
          pid = parseOwnerPid(readText(candidate));
        } catch (error) {
          if (error?.code === 'ENOENT' && locked() !== baseFile) {
            rotated = true;
            break;
          }
          throw error;
        }
      }
      if (!rotated && locked() === baseFile) return pid;
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
    return ids.map(id => readJob(id));
  }

  function settlementDetails(job, status, { cost = {}, startedAt, ledgerError } = {}) {
    if (ledgerError !== undefined) return { ledgerError };
    try {
      if (!isPlainObject(cost)) throw new TypeError('执行器回报的 cost 必须是普通对象。');
      const steps = job.steps.filter(step => step.attempt === job.attempt);
      const settlement = prepareSettlement({
        // 中断恢复时只有已落盘的步骤耗时可用。
        wallMs: startedAt === undefined ? steps.reduce((ms, step) => ms + (step.durationMs ?? 0), 0) : performance.now() - startedAt,
        renderedFrames: 0,
        deliveredFrames: 0,
        workspaceDir: workspace.root,
        ...cost,
        jobId: job.id, attempt: job.attempt, kind: job.request.kind, handler: job.handler, rev: job.snapshot.rev, status,
      });
      return { settlement };
    } catch (error) {
      return { ledgerError: message(error) };
    }
  }

  function finishLocked(job, status, details, usage, locked) {
    const ledger = settlementDetails(job, status, usage);
    workspace.cleanupIntermediate(job.id, { keep: job.keep, status, attempt: job.attempt });
    transition(job, status, { ...details, ...ledger });
    // 终态首次可见后仍可能回写追加失败的诊断。重放领取前须等这一轮写完。
    // 持锁期间作业目录被轮换的话，两次回写都落在锁所在的那一代目录里。
    const write = () => saveUnderLock(job, locked);
    write();
    if (!ledger.settlement) return;
    try {
      appendSettlement(ledgerFile(), ledger.settlement);
    } catch (error) {
      job.events.at(-1).ledgerError = message(error);
      write();
    }
  }

  function finish(job, status, details, usage, gen) {
    if (gen) {
      withGenLock(gen, locked => finishLocked(job, status, details, usage, locked));
      return;
    }
    withFileLock(jobFile(job.id), locked => finishLocked(job, status, details, usage, locked));
  }

  async function execute(job, handler, signal, gen) {
    let currentGen = gen;
    for (;;) {
      let lease;
      try {
        try {
          lease = await scheduler.acquire(job.request, { signal });
        } catch (error) {
          if (!signal.aborted) throw error;
        }
        if (signal.aborted) {
          finish(job, 'canceled', { reason: 'canceled' }, undefined, currentGen);
          return job;
        }
        transition(job, 'running');
        saveGen(job, currentGen);
        const startedAt = performance.now();
        const outcome = await executeAttempt(job, handler, lease.signal, currentGen);
        const usage = { cost: outcome.cost, ledgerError: outcome.ledgerError, startedAt };
        if (signal.aborted) {
          finish(job, 'canceled', { reason: 'canceled' }, usage, currentGen);
          return job;
        }
        if (lease.signal.reason !== 'preempted') {
          if (outcome.error !== undefined) job.error = outcome.error;
          if (outcome.result !== undefined) job.result = outcome.result;
          finish(job, outcome.status, undefined, usage, currentGen);
          return job;
        }
        finish(job, 'stopped', { reason: 'preempted' }, usage, currentGen);
        const nextGen = withGenLock(currentGen, locked => {
          const claimedNext = claimUnderLock(job, job.attempt + 1, locked);
          nextAttempt(job);
          saveUnderLock(job, locked);
          return claimedNext;
        });
        const activeEntry = active.get(currentGen.token);
        if (activeEntry) {
          active.delete(currentGen.token);
          activeEntry.gen = nextGen;
          active.set(nextGen.token, activeEntry);
        }
        currentGen = nextGen;
      } finally {
        lease?.release();
      }
    }
  }

  async function executeAttempt(job, handler, signal, gen) {
    const pending = new Set();
    let acceptingSteps = true;
    async function measure(name, run) {
      if (!acceptingSteps) throw new Error('作业执行器已经返回。');
      signal.throwIfAborted();
      if (typeof name !== 'string' || !name || typeof run !== 'function') throw new TypeError('步骤需要名称和执行函数。');
      const entry = { name, attempt: job.attempt, startEvent: addEvent(job, 'step-start', { name }) };
      job.steps.push(entry);
      saveGen(job, gen);
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
        saveGen(job, gen);
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
      if (isPlainObject(result) && Object.hasOwn(result, 'cost')) {
        const { cost, ...rest } = result;
        const saved = jsonValue(rest);
        try {
          if (cost !== undefined) saved.cost = jsonValue(cost);
        } catch (error) {
          return { status: 'succeeded', result: saved, ledgerError: `执行器回报的 cost 无效：${message(error)}` };
        }
        return { status: 'succeeded', result: saved, cost: saved.cost };
      }
      return { status: 'succeeded', ...(result !== undefined && { result: jsonValue(result) }) };
    } catch (error) {
      return { status: 'failed', error: message(error), cost: error?.cost };
    } finally {
      acceptingSteps = false;
      await Promise.allSettled(pending);
    }
  }

  function launch(job, handler, gen) {
    const controller = new AbortController();
    const record = { id: job.id, gen, controller, promise: null };
    const promise = Promise.resolve().then(() => execute(job, handler, controller.signal, record.gen)).finally(() => active.delete(record.gen.token));
    record.promise = promise;
    active.set(gen.token, record);
    return promise.then(result => structuredClone(result));
  }

  function getHandler(job) {
    const handler = Object.hasOwn(handlers, job.handler) && handlers[job.handler];
    if (typeof handler !== 'function') throw new TypeError(`缺少作业执行器 ${job.handler}。`);
    return handler;
  }

  function runJob(id) {
    const claimed = withFileLock(jobFile(id), locked => {
      const job = readLockedJob(id, locked);
      if (job.status !== 'queued') throw new Error('只能启动排队中的作业。');
      const handler = getHandler(job);
      scheduler.request(job.request);
      const gen = claimUnderLock(job, job.attempt, locked);
      return { job, handler, gen };
    });
    return launch(claimed.job, claimed.handler, claimed.gen);
  }

  function replay(id) {
    try {
      reconcileLedger();
    } catch {
      // 补旧账失败不挡执行；读账仍严格报错，新轮追加失败也会在终态记录原因。
    }
    const claimed = withFileLock(jobFile(id), locked => {
      const job = readLockedJob(id, locked);
      if (findActiveForDir(path.dirname(locked()))) throw new Error('作业仍由本进程执行。');
      const handler = getHandler(job);
      scheduler.request(job.request);
      const pid = ownerLocked(job, locked);
      if (job.status === 'queued' && pid === undefined) {
        const gen = claimUnderLock(job, job.attempt, locked);
        return { job, handler, gen };
      }
      if (!terminal.has(job.status) && (pid === undefined || processIsAlive(pid))) throw new Error('作业仍由执行进程领取。');
      const gen = claimUnderLock(job, job.attempt + 1, locked);
      if (job.status === 'running') {
        for (const step of job.steps.filter(step => step.attempt === job.attempt && !step.endEvent)) {
          step.status = 'stopped';
          step.endEvent = addEvent(job, 'step-end', { name: step.name, status: 'stopped' });
        }
        finishLocked(job, 'stopped', { reason: 'interrupted' }, undefined, locked);
      } else if (job.status === 'queued') {
        finishLocked(job, 'canceled', { reason: 'interrupted' }, undefined, locked);
      }
      nextAttempt(job);
      saveUnderLock(job, locked);
      return { job, handler, gen };
    });
    return launch(claimed.job, claimed.handler, claimed.gen);
  }

  function cancelJob(id) {
    const direct = findActiveForDir(path.dirname(jobFile(id)));
    if (direct) {
      direct.controller.abort('canceled');
      return direct.promise.then(job => structuredClone(job));
    }
    const canceled = withFileLock(jobFile(id), locked => {
      const job = readLockedJob(id, locked);
      const runningEntry = findActiveForDir(path.dirname(locked()));
      if (runningEntry) return { runningEntry };
      if (job.status === 'canceled') return { job };
      if (job.status !== 'queued') throw new Error('当前作业状态不能取消。');
      claimUnderLock(job, job.attempt, locked);
      finishLocked(job, 'canceled', { reason: 'canceled' }, undefined, locked);
      return { job };
    });
    if (canceled.runningEntry) {
      canceled.runningEntry.controller.abort('canceled');
      return canceled.runningEntry.promise.then(job => structuredClone(job));
    }
    return Promise.resolve(canceled.job);
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

  function reconcileLedger(options) {
    const file = ledgerFile();
    const jobs = listJobs();
    const rows = readJobLedger(file, options);
    const keys = new Set(rows.filter(row => !row.legacyApiRow).map(row => `${row.jobId}/${row.attempt}`));
    let repaired = false;
    for (const job of jobs) {
      for (const event of job.events) {
        if (!terminal.has(event.type) || !event.settlement) continue;
        const key = `${job.id}/${event.attempt}`;
        if (keys.has(key)) continue;
        const { settlement } = event;
        if (settlement.jobId !== job.id || settlement.attempt !== event.attempt || settlement.status !== event.type) {
          throw new Error(`作业 ${key} 的结算载荷与终态事件不一致。`);
        }
        appendSettlement(file, settlement);
        keys.add(key);
        repaired = true;
      }
    }
    return repaired ? readJobLedger(file, options) : rows;
  }

  // 终渲前报价：给 draftJobId 就从账本取那个草稿作业最近一次成功轮次的实测（渲帧数、显卡秒、墙钟），其余参数同 quoteFromDraft。
  function quoteJobFromDraft({ draftJobId, ...draft } = {}) {
    if (draftJobId === undefined) return quoteFromDraft(draft);
    let row;
    for (const candidate of reconcileLedger()) {
      if (candidate.jobId === draftJobId && candidate.status === 'succeeded' && candidate.gpuKnown && candidate.attempt > (row?.attempt ?? 0)) row = candidate;
    }
    if (!row) throw new Error(`账本里没有草稿作业 ${draftJobId} 的实测成本：它要成功跑完并回报显卡秒。`);
    return quoteFromDraft({ ...draft, draftFrames: row.renderedFrames, draftGpuSeconds: row.gpuSeconds, draftWallMs: row.wallMs });
  }

  return Object.freeze({ enqueue, runJob, getJob: id => readJob(id), listJobs, jobFile, waitForJob, cancelJob, replay,
    ledgerFile, reconcileLedger, readLedger: reconcileLedger, summarizeLedger: options => summarizeJobLedger(reconcileLedger(options)), quoteJobFromDraft });
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
