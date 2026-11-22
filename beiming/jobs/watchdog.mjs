// 作业看门狗（A14）：单帧超时、着色器挂起与 GPU 丢失、显存配额、工作区磁盘配额。越线就强杀受管进程树，再报带错误码的错。
// 看门狗和出帧的重活必须在不同进程里：同一线程里的同步死循环，定时器轮不到，谁也杀不了。
/* global AbortController, AbortSignal */
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ChildProcess, execFile, spawn, spawnSync } from 'node:child_process';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';
import { types } from 'node:util';
import { Scheduler } from './scheduler.mjs';

const MB = 2 ** 20;
const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout 超过这个数会当成 1 ms
const KILL_WAIT_MS = 2000;
const posix = process.platform !== 'win32';
const exitCodes = { usage: 2, env: 3, timeout: 124, failure: 1 };
// 各配额的取值区间。给了就必须落在区间里；没给的那一维不查。
const quotaRanges = {
  frameTimeoutMs: [1, MAX_TIMER_MS],
  shaderHangMs: [1, MAX_TIMER_MS],
  pollIntervalMs: [1, MAX_TIMER_MS],
  probeTimeoutMs: [1, MAX_TIMER_MS],
  killGraceMs: [0, MAX_TIMER_MS],
  vramQuotaMB: [1, Number.MAX_SAFE_INTEGER],
  diskQuotaBytes: [1, Number.MAX_SAFE_INTEGER],
  maxFiles: [1, Number.MAX_SAFE_INTEGER],
};

function coded(code, message, details, Base = Error) {
  return Object.assign(new Base(message), { code, exitCode: exitCodes[code.split('.')[0]] }, details);
}

const bad = (message, Base = TypeError) => coded('usage.bad-argument', message, undefined, Base);

// 只认普通对象的自有数据属性。先认 Proxy 再碰它，一个陷阱也不触发；取值器、Symbol 键、没列出的键都拒收。
function snapshot(value, where, allowed) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw bad(`${where} 必须是普通对象（不收 Proxy、数组与类实例）。`);
  }
  const out = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (allowed && !allowed.includes(key))) throw bad(`${where} 有不认识的键：${String(key)}。`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) throw bad(`${where}.${key} 不得是取值器。`);
    out[key] = descriptor.value;
  }
  return out;
}

// 纯数据数组：非 Proxy、原型正好是 Array.prototype，自有键只有 0..length-1 和 length（没有空洞、多余的键、Symbol 键）。
// 元素只从描述符里读，取值器一次也不调。
function isCleanArray(value, itemOk) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) return false; // 先比键数：长度虚高的空洞数组不进下面的循环
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !itemOk(descriptor.value)) return false;
  }
  return true;
}

// 原型正好是这个类的非 Proxy 对象。不用 instanceof：它会顺着原型链走，链上有 Proxy 就触发陷阱。
const isExactly = (value, Class) => value !== null && typeof value === 'object' && !types.isProxy(value) && Object.getPrototypeOf(value) === Class.prototype;

function int(value, name, min, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw bad(`${name} 必须是 ${min} 到 ${max} 之间的安全整数。`, RangeError);
  }
  return value;
}

function checkQuotas(input) {
  const quotas = snapshot(input, 'quotas', Object.keys(quotaRanges));
  for (const [key, value] of Object.entries(quotas)) int(value, `quotas.${key}`, ...quotaRanges[key]);
  return quotas;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// 发一次信号。目标不在了（ESRCH）或只剩僵尸（macOS 对僵尸进程组报 EPERM）都算没发到。
function send(target, signal) {
  try {
    return process.kill(target, signal);
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'EPERM') return false;
    throw error;
  }
}

/** 进程（processGroup 时是整个进程组）还在不在。还没被回收的僵尸也算在。 */
export function processIsAlive(pid, options = {}) {
  const { processGroup = false } = snapshot(options, 'processIsAlive 的选项', ['processGroup']);
  int(pid, 'pid', 1);
  try {
    return process.kill(processGroup && posix ? -pid : pid, 0);
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

// 全机进程表 [pid, ppid, pgid]；查不到交回 null。
// shortcut: Windows 上不列进程表（强杀靠 taskkill /T，不受影响），显存探针只看得到登记的那个进程号；要在 Windows 上按进程树探显存时补上。
function listProcesses() {
  if (!posix) return [];
  const { status, stdout } = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 5000 });
  if (status !== 0) return null;
  return stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
}

// 受管根进程连同它们的后代、同组成员。
function treePids(roots, table) {
  const pids = new Set(roots.filter((root) => !root.groupOnly).map((root) => root.pid));
  const groups = new Set(roots.filter((root) => root.processGroup).map((root) => root.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid, pgid] of table) {
      if (!pids.has(pid) && (pids.has(ppid) || groups.has(pgid))) {
        pids.add(pid);
        grew = true;
      }
    }
  }
  return [...pids];
}

// 裸进程号（raw）没法确认是自己起的：对着进程表再查它不是本进程的祖先，按组杀时不是本进程所在的组。
function checkKillTarget(pid, processGroup, raw) {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) {
    throw bad('受管进程号必须是大于 1 的安全整数，且不得是本进程或父进程。', RangeError);
  }
  if (!raw || !posix) return pid;
  const table = listProcesses();
  if (!table) {
    if (processGroup) throw coded('env.missing-tool', '查不到进程表（需要 ps），不对别的进程组发信号。');
    return pid;
  }
  const row = new Map(table.map((entry) => [entry[0], entry]));
  if (processGroup && row.get(process.pid)?.[2] === pid) throw bad('不得对本进程所在的进程组发信号。', RangeError);
  for (let ancestor = process.ppid, depth = 0; ancestor > 1 && depth < 64; ancestor = row.get(ancestor)?.[1], depth += 1) {
    if (ancestor === pid) throw bad('受管进程不得是本进程的祖先。', RangeError);
  }
  return pid;
}

// 向一批根进程连同后代发信号，交回信号发出时点到的进程号。
function signalTrees(roots, signal, known = []) {
  if (!posix) {
    // taskkill /T 连子进程一起结束；Windows 没有可拦的 SIGTERM，两种信号都是强制结束。
    for (const { pid } of roots) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return roots.map((root) => root.pid);
  }
  // 先拍下进程树再发信号：根一死，孙进程改认 1 号进程，再按父进程号就找不回来了。
  const pids = [...new Set([...known, ...treePids(roots, listProcesses() ?? [])])].filter((pid) => pid > 1 && pid !== process.pid && pid !== process.ppid);
  for (const { pid, processGroup } of roots) if (processGroup) send(-pid, signal); // 整组一次发到，中途新起的成员也跑不掉
  for (const pid of pids) send(pid, signal);
  return pids;
}

/**
 * 强杀一个进程连同它的后代。processGroup 为 true 时把 pid 当进程组号，整组一起杀（要求它是 detached 起的组长）。
 * 不收 1 号进程、本进程、父进程和本进程所在的进程组。交回有没有发出信号。
 */
export function killProcessTree(pid, options = {}) {
  const { signal = 'SIGKILL', processGroup = false } = snapshot(options, 'killProcessTree 的选项', ['signal', 'processGroup']);
  if (!['SIGKILL', 'SIGTERM'].includes(signal) || typeof processGroup !== 'boolean') {
    throw bad('signal 只认 SIGKILL 或 SIGTERM，processGroup 只认布尔值。');
  }
  checkKillTarget(pid, processGroup, true);
  // 已经不在的不发信号：进程号可能已经被别的进程用上。
  if (!processIsAlive(pid) && !processIsAlive(pid, { processGroup })) return false;
  signalTrees([{ pid, processGroup }], signal);
  return true;
}

/**
 * 按 lstat 统计整个工作区：intermediate、deliver、snapshots、jobs、cache 全算，不跟符号链接（链接本身算一个条目）。
 * bytes 逐个文件取「逻辑大小」与「已分配块」里大的那个（预分配不写内容也躲不掉）；files 是全部条目数，目录也算。
 * 给了 maxBytes / maxFiles，一越线就提前交回（complete 为 false），文件炸弹拖不住看门狗。
 */
export function measureWorkspaceQuotaBytes(workspaceDir, limits = {}) {
  const { maxBytes = Infinity, maxFiles = Infinity } = snapshot(limits, 'measureWorkspaceQuotaBytes 的选项', ['maxBytes', 'maxFiles']);
  if (maxBytes !== Infinity) int(maxBytes, 'maxBytes', 0);
  if (maxFiles !== Infinity) int(maxFiles, 'maxFiles', 0);
  if (typeof workspaceDir !== 'string' || !path.isAbsolute(workspaceDir)) throw bad('workspaceDir 必须是绝对路径。');
  if (!fs.lstatSync(workspaceDir, { throwIfNoEntry: false })?.isDirectory()) throw bad('workspaceDir 必须是已存在的真实目录（不能是符号链接）。');
  let bytes = 0;
  let files = 0;
  // 文件名按字节读：解码成字符串会把不是 UTF-8 的名字改坏，再 lstat 就成了「不存在」，整个文件被漏数。
  const separator = Buffer.from(path.sep);
  const pending = [Buffer.from(workspaceDir)];
  while (pending.length) {
    const dir = pending.pop();
    let names;
    try {
      names = fs.readdirSync(dir, { encoding: 'buffer' });
    } catch (error) {
      if (error.code === 'ENOENT') continue; // 统计途中被删掉的目录
      throw error;
    }
    for (const name of names) {
      const file = Buffer.concat([dir, separator, name]);
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat) continue;
      files += 1;
      if (stat.isDirectory()) pending.push(file);
      else bytes += Math.max(stat.size, (stat.blocks ?? 0) * 512);
      if (bytes > maxBytes || files > maxFiles) return { bytes, files, complete: false };
    }
  }
  return { bytes, files, complete: true };
}

/** 解析 nvidia-smi --query-compute-apps=pid,used_gpu_memory --format=csv,noheader,nounits：进程号 → MB（读不出的是 NaN）。 */
export function parseNvidiaSmiApps(text) {
  const apps = new Map();
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const [pid, used] = line.split(',').map((cell) => cell.trim());
    if (!/^\d+$/.test(pid)) throw new Error(`认不出 nvidia-smi 的这一行：${line.trim()}`);
    apps.set(Number(pid), (apps.get(Number(pid)) ?? 0) + (/^\d+$/.test(used ?? '') ? Number(used) : NaN));
  }
  return apps;
}

/** 解析 macOS footprint 的输出：「IOAccelerator (graphics)」一行的 Dirty 列，换成 MB。给了多个进程号时取最后的汇总行。 */
export function parseFootprintGraphicsMB(text) {
  if (!/Footprint:/.test(text)) throw new Error('认不出 footprint 的输出。');
  const row = [...String(text).matchAll(/^\s*([\d.]+) (B|KB|MB|GB)\b.*\bIOAccelerator \(graphics\)\s*$/gm)].at(-1);
  return row ? (Number(row[1]) * { B: 1, KB: 2 ** 10, MB, GB: 2 ** 30 }[row[2]]) / MB : 0;
}

const run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 5000, windowsHide: true, maxBuffer: 8 * MB }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

/**
 * 本机的显存探针，交给 createJobWatchdog 的 probeVramMB。
 * macOS：footprint 读受管进程树的图形内存（本机实测）。别的平台：nvidia-smi 的计算进程表（只列计算上下文，没在 NVIDIA 机器上实测）。
 */
export function createVramProbe(options = {}) {
  const { platform = process.platform } = snapshot(options, 'createVramProbe 的选项', ['platform']);
  if (platform === 'darwin') {
    return async ({ pids }) => {
      const live = pids.filter((pid) => processIsAlive(pid));
      if (!live.length) return 0;
      try {
        return parseFootprintGraphicsMB(await run('/usr/bin/footprint', live.map(String)));
      } catch (error) {
        if (live.some((pid) => processIsAlive(pid))) throw error;
        return 0; // 量的途中整棵树退出了
      }
    };
  }
  return async ({ pids }) => {
    const apps = parseNvidiaSmiApps(await run('nvidia-smi', ['--query-compute-apps=pid,used_gpu_memory', '--format=csv,noheader,nounits']));
    const usedMB = pids.reduce((sum, pid) => sum + (apps.get(pid) ?? 0), 0);
    if (Number.isNaN(usedMB)) throw new Error('nvidia-smi 读不出受管进程的显存用量。');
    return usedMB;
  };
}

/**
 * 建一个看门狗。quotas 里给了哪一维就查哪一维：
 * frameTimeoutMs（单帧超时）、shaderHangMs（着色器挂起）、vramQuotaMB（显存）、diskQuotaBytes / maxFiles（工作区磁盘），
 * 另有 pollIntervalMs（轮询间隔，默认 250）、probeTimeoutMs（探针不回话的时限，默认 5000）与 killGraceMs（单帧超时从 SIGTERM 升级到 SIGKILL 的宽限，默认 150）。
 * quotas 必须显式给（一维都不设写 {}）；一个看门狗同时只跑一帧。
 * 第一次越线就定案：中止 signal，强杀全部受管进程树，杀完再让 runFrame / guard / check 以这次的错拒绝。
 */
export function createJobWatchdog(input) {
  const options = snapshot(input, 'options', ['quotas', 'workspaceDir', 'probeVramMB', 'probeGpuHealth']);
  const quotas = { pollIntervalMs: 250, killGraceMs: 150, probeTimeoutMs: 5000, ...checkQuotas(options.quotas) };
  const { frameTimeoutMs, shaderHangMs, vramQuotaMB, diskQuotaBytes, maxFiles, pollIntervalMs, killGraceMs, probeTimeoutMs } = quotas;
  const { workspaceDir, probeVramMB, probeGpuHealth } = options;
  const diskLimited = diskQuotaBytes !== undefined || maxFiles !== undefined;
  for (const [name, probe] of [['probeVramMB', probeVramMB], ['probeGpuHealth', probeGpuHealth]]) {
    if (probe !== undefined && typeof probe !== 'function') throw bad(`${name} 必须是函数。`);
  }
  if (probeVramMB && vramQuotaMB === undefined) throw bad('给了显存探针就要给 quotas.vramQuotaMB。');
  if (diskLimited !== (workspaceDir !== undefined)) throw bad('workspaceDir 与磁盘配额（diskQuotaBytes / maxFiles）要一起给。');
  if (diskLimited) measureWorkspaceQuotaBytes(workspaceDir, { maxFiles: 0 }); // 只借它的路径检查

  const managed = new Map();
  const controller = new AbortController();
  let violation = null;
  let closed = false;
  let accountedBytes = 0;
  let probedMB = 0;
  let hang = null;
  let polling = false;
  let frameActive = false;
  const probeWaits = new Map(); // 还在等回话的探针：时限计时器 → 让这次等待当场失败的函数
  let frameTimer;
  let rejectViolated;
  const violated = new Promise((_, reject) => { rejectViolated = reject; });
  violated.catch(() => {}); // 没人在等的时候也不算未处理的拒绝

  const entryAlive = (entry) => (entry.child ? entry.child.exitCode === null && entry.child.signalCode === null : processIsAlive(entry.pid))
    || (entry.processGroup && processIsAlive(entry.pid, { processGroup: true }));

  // 现在还值得发信号的根。已经退出、组里也没人的当场除名：它的进程号以后可能被别的进程用上。
  // 组长退了组里还有人的，只按进程组发信号（groupOnly），不再碰那个进程号。
  function liveRoots() {
    const roots = [];
    for (const entry of managed.values()) {
      const exited = entry.child ? entry.child.exitCode !== null || entry.child.signalCode !== null : !processIsAlive(entry.pid);
      if (!exited) roots.push(entry);
      else if (entry.processGroup && processIsAlive(entry.pid, { processGroup: true })) roots.push({ ...entry, groupOnly: true });
      else managed.delete(entry.pid);
    }
    return roots;
  }

  async function killManaged(graceMs) {
    const roots = liveRoots();
    if (!roots.length) return { killed: [], survivors: [] };
    const until = async (deadline, done) => {
      while (!done() && Date.now() < deadline) await sleep(5);
    };
    let killed = [];
    const alive = () => [...new Set([...killed.filter((pid) => processIsAlive(pid)), ...roots.filter(entryAlive).map((root) => root.pid)])];
    if (graceMs > 0) {
      killed = signalTrees(roots, 'SIGTERM');
      await until(Date.now() + graceMs, () => !alive().length);
    }
    // 过了宽限不管根进程死没死都补一刀，连第一轮点到的进程号一起：根死后不理 SIGTERM 的孙进程已经改认 1 号进程。
    killed = signalTrees(roots, 'SIGKILL', killed);
    await until(Date.now() + KILL_WAIT_MS, () => !alive().length);
    return { killed, survivors: alive() };
  }

  // 越线或关闭之后不再有任何计时器拦着事件循环。还在等回话的探针当场按失败结束：
  // 只清时限不结束等待的话，等着它的 check() 永远不结算。
  function stopTimers() {
    clearInterval(pollTimer);
    clearTimeout(hang?.timer);
    clearTimeout(frameTimer);
    for (const [timer, reject] of probeWaits) {
      clearTimeout(timer);
      reject(new Error('看门狗已经越线或关闭，不再等探针。'));
    }
    probeWaits.clear();
  }

  function trip(error, graceMs = 0) {
    if (violation || closed) return;
    violation = error;
    stopTimers();
    controller.abort(error);
    killManaged(graceMs).then(
      (outcome) => rejectViolated(Object.assign(error, outcome)),
      (cause) => rejectViolated(Object.assign(error, { killError: cause })),
    );
  }

  function checkDisk() {
    if (!diskLimited || violation) return;
    let used;
    try {
      used = measureWorkspaceQuotaBytes(workspaceDir, { maxBytes: diskQuotaBytes, maxFiles });
    } catch (cause) {
      // 量不出来（目录被改成不可读之类）按超限处理，不能让任务靠藏文件躲过去。
      trip(coded('failure.disk-quota', '量不出工作区的磁盘用量，按超限处理。', { reason: 'unmeasurable', cause }));
      return;
    }
    if (!used.complete) {
      trip(coded('failure.disk-quota', `工作区磁盘超出配额：已用至少 ${used.bytes} 字节、${used.files} 个条目。`, {
        usedBytes: used.bytes, diskQuotaBytes, files: used.files, maxFiles,
      }));
    }
  }

  function checkVram() {
    if (vramQuotaMB === undefined || violation) return;
    const accountedMB = accountedBytes / MB;
    const usedMB = Math.max(accountedMB, probedMB);
    if (usedMB > vramQuotaMB) {
      trip(coded('failure.vram-exceeded', `显存用量 ${Math.ceil(usedMB)} MB 超出配额 ${vramQuotaMB} MB。`, { usedMB, vramQuotaMB, accountedMB, probedMB }));
    }
  }

  // 探针的输入：受管进程树的全部进程号。POSIX 上进程表查不到就报错，不能只量根进程当全量。
  function probePids() {
    const table = listProcesses();
    if (!table) throw coded('env.missing-tool', '查不到进程表（需要 ps），量不了受管进程树。');
    return treePids(liveRoots(), table);
  }

  // 调一次探针。探针不回话（GPU 挂死时很常见）不能把后面的检查一起拖住：过了 probeTimeoutMs 按失败算。
  function callProbe(probe, pids) {
    const stopped = () => closed || violation;
    if (stopped()) return Promise.reject(new Error('看门狗已经越线或关闭，不再起探针。'));
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`探针超过 ${probeTimeoutMs} ms 没有回话。`)), probeTimeoutMs);
      probeWaits.set(timer, reject);
    });
    // 探针在微任务里才真正被调：排队之后、执行之前越线或关闭的，到这里再拦一次。
    const called = Promise.resolve().then(() => {
      if (stopped()) throw new Error('看门狗已经越线或关闭，不再起探针。');
      return probe({ pids });
    });
    return Promise.race([called, expired]).finally(() => {
      clearTimeout(timer);
      probeWaits.delete(timer);
    });
  }

  // 每起一个探针之前都看一眼：等上一个探针回话的工夫里越线或关闭了，后面的探针不再起。
  // 关闭打断在途的探针不算越线：trip 自己不理关闭之后的调用。
  async function runProbes() {
    const stopped = () => closed || violation;
    let pids;
    if (probeGpuHealth && !stopped()) {
      let healthy;
      try {
        pids = probePids();
        healthy = await callProbe(probeGpuHealth, pids);
      } catch (cause) {
        healthy = cause;
      }
      // 探针只有明确交回 true 才算健康；别的回执、抛错、超时都按 GPU 丢失处理。
      if (healthy !== true) trip(coded('failure.gpu-lost', 'GPU 健康探针没有报健康。', { reason: 'probe', ...(healthy instanceof Error && { cause: healthy }) }));
    }
    if (probeVramMB && !stopped()) {
      try {
        const reading = await callProbe(probeVramMB, pids ?? probePids());
        if (typeof reading !== 'number' || !Number.isFinite(reading) || reading < 0) throw new TypeError('显存探针要交回非负有限数（MB）。');
        probedMB = reading;
      } catch (cause) {
        // 量不出来按超限处理：看不见用量的任务不能留在卡上。
        trip(coded('failure.vram-exceeded', '显存探针失败，量不出用量，按超限处理。', { usedMB: null, vramQuotaMB, reason: 'probe-failed', cause }));
      }
      checkVram();
    }
  }

  const pollTimer = setInterval(() => {
    checkDisk(); // 磁盘每个间隔都查，不排在还没回话的探针后面
    liveRoots(); // 名单每个间隔都清：已经退出的进程不留到越线那一刻
    if (polling) return;
    polling = true;
    runProbes().finally(() => { polling = false; });
  }, pollIntervalMs);
  pollTimer.unref(); // 轮询不拖住进程退出；帧和着色器的计时器只在各自进行中才存在，照常拦住事件循环

  // 把一段异步工作挂到看门狗上。越线后进程被杀，工作自己多半先以「连接断了」之类的错结束，这里一律换成越线的那个错。
  async function guard(work) {
    if (typeof work !== 'function') throw bad('guard 要给一个函数。');
    if (closed) throw bad('看门狗已经关闭。');
    if (violation) await violated;
    try {
      const result = await Promise.race([Promise.resolve().then(work), violated]);
      if (violation) await violated;
      return result;
    } catch (error) {
      if (violation) await violated;
      throw error;
    }
  }

  function endShaderPass() {
    clearTimeout(hang?.timer);
    hang = null;
  }

  function armHang() {
    clearTimeout(hang.timer);
    if (shaderHangMs === undefined || violation || closed) return;
    const { label } = hang;
    hang.timer = setTimeout(() => {
      trip(coded('timeout.shader-hang', `着色器「${label}」超过 ${shaderHangMs} ms 没有完成也没有心跳。`, { label, shaderHangMs }));
    }, shaderHangMs);
  }

  function register(target, processGroup, raw) {
    // 越线之后（哪怕已经关闭）才登记上来的进程照样收下补杀；没越线就关闭的看门狗不再收。
    if (closed && !violation) throw bad('看门狗已经关闭。');
    const child = typeof target === 'number' ? null : target;
    if (child && !isExactly(child, ChildProcess)) throw bad('受管进程要给 ChildProcess 或进程号。');
    // 进程号只读自有数据属性，仿造对象上的取值器不调。
    const pid = checkKillTarget(child ? Object.getOwnPropertyDescriptor(child, 'pid')?.value : target, processGroup, raw);
    managed.set(pid, { pid, processGroup, child });
    if (violation) {
      signalTrees(liveRoots().filter((root) => root.pid === pid), 'SIGKILL'); // 已经退出的不发信号
      managed.delete(pid);
      throw violation;
    }
    return pid;
  }

  return Object.freeze({
    signal: controller.signal,
    get violation() { return violation; },
    guard,

    /** 登记一个受管进程（ChildProcess 或进程号）。processGroup：它是 detached 起的进程组长，强杀时整组一起杀。 */
    registerProcess(target, processOptions = {}) {
      const { processGroup = false } = snapshot(processOptions, 'registerProcess 的选项', ['processGroup']);
      if (typeof processGroup !== 'boolean') throw bad('processGroup 只认布尔值。');
      return register(target, processGroup, true);
    },

    /** 起一个受管子进程：POSIX 上独立进程组，强杀时连孙进程一起。spawnOptions 只收 cwd、env、stdio。 */
    spawnManaged(file, args = [], spawnOptions = {}) {
      const safe = snapshot(spawnOptions, 'spawnManaged 的选项', ['cwd', 'env', 'stdio']);
      if (typeof file !== 'string' || !file || !isCleanArray(args, (arg) => typeof arg === 'string')) {
        throw bad('spawnManaged 要给可执行文件路径和字符串参数数组。');
      }
      const { cwd, stdio } = safe;
      const stdioWord = (word) => ['ignore', 'pipe', 'inherit'].includes(word);
      if ((cwd !== undefined && typeof cwd !== 'string')
        || (stdio !== undefined && !stdioWord(stdio) && !isCleanArray(stdio, stdioWord))) {
        throw bad('cwd 要是字符串，stdio 只认 ignore、pipe、inherit 或它们的数组。');
      }
      const env = safe.env === undefined ? undefined : snapshot(safe.env, 'spawnManaged 的 env', null);
      if (env && !Object.values(env).every((value) => typeof value === 'string')) throw bad('env 的值要都是字符串。');
      if (violation) throw violation; // 已经越线：不再起新进程
      if (closed) throw bad('看门狗已经关闭。');
      const child = spawn(file, args, { cwd, env, stdio, detached: posix, windowsHide: true });
      if (child.pid === undefined) {
        child.once('error', () => {});
        throw coded('env.missing-tool', `起不了进程：${file}`);
      }
      register(child, posix, false); // 自己 detached 起的，一定是组长，不用再对进程表
      return child;
    },

    /** 跑一帧。fn 收到 { frameIndex, signal }。帧前帧后各查一次磁盘；超过 frameTimeoutMs 先 SIGTERM，过了宽限 SIGKILL。 */
    async runFrame(frameIndex, fn) {
      int(frameIndex, 'frameIndex', 0);
      if (typeof fn !== 'function') throw bad('runFrame 要给一个函数。');
      // 帧计时与着色器计时各只有一份：两帧并发会互相清掉对方的计时器。
      if (frameActive) throw bad('上一帧还没结束：一个看门狗同时只跑一帧。');
      frameActive = true;
      checkDisk();
      frameTimer = frameTimeoutMs === undefined ? undefined : setTimeout(() => {
        trip(coded('timeout.frame', `第 ${frameIndex} 帧超过 ${frameTimeoutMs} ms。`, { frameIndex, frameTimeoutMs }), killGraceMs);
      }, frameTimeoutMs);
      try {
        const result = await guard(() => fn({ frameIndex, signal: controller.signal }));
        checkDisk();
        if (violation) await violated;
        return result;
      } finally {
        frameActive = false;
        clearTimeout(frameTimer);
        endShaderPass();
      }
    },

    /** 着色器派发开始：之后超过 shaderHangMs 既没 endShaderPass 也没 heartbeat，就零宽限强杀。 */
    beginShaderPass(label = '') {
      if (typeof label !== 'string' || label.length > 200) throw bad('着色器标签要是 200 字以内的字符串。');
      clearTimeout(hang?.timer);
      hang = { label };
      armHang();
    },
    heartbeat() {
      if (hang) armHang();
    },
    endShaderPass,

    /** 渲染端报上下文丢失或 GPU 进程崩溃（webglcontextlost、GPUDevice.lost、浏览器断连）：清掉残余进程，报 failure.gpu-lost。 */
    reportGpuLost(reason = 'context-lost') {
      if (typeof reason !== 'string' || reason.length > 200) throw bad('reason 要是 200 字以内的字符串。');
      trip(coded('failure.gpu-lost', `GPU 上下文丢失：${reason}。`, { reason }));
    },

    /** 任务内显存账本：又分配了多少字节。越线当场抛错并强杀。交回账上的 MB 数。 */
    recordVramBytes(bytes) {
      int(bytes, 'bytes', 0);
      accountedBytes = Math.min(accountedBytes + bytes, Number.MAX_SAFE_INTEGER);
      checkVram();
      if (violation) throw violation;
      return accountedBytes / MB;
    },
    /** 任务内显存账本：把账上的数改成 mb（释放之后往下改）。 */
    setVramMB(mb) {
      accountedBytes = Math.min(int(mb, 'mb', 0) * MB, Number.MAX_SAFE_INTEGER);
      checkVram();
      if (violation) throw violation;
      return mb;
    },

    /** 现在就把磁盘、GPU 健康、显存各查一遍；已经越线就以那次的错拒绝。 */
    async check() {
      if (closed) throw bad('看门狗已经关闭。');
      checkDisk();
      await runProbes();
      if (violation) await violated;
    },

    /** 停掉全部计时器。不杀进程：没越线的任务，进程归调用方自己收。 */
    close() {
      closed = true;
      stopTimers();
      hang = null;
    },
  });
}

/**
 * 带着看门狗跑一个任务：task 收到 { watchdog, lease, signal }。
 * 给了 scheduler 就先按 scheduleSpec 拿租约，显存配额默认取租约的 vramMB、不得比它大；任务正常返回之前再 check() 一遍，越线照样拒绝；不论成败，强杀结束之后归还租约
 * （等满 2 秒还杀不死的进程列在错误的 survivors 里，租约照还）。
 * signal 在越线、租约被抢占或调用方的 signal 中止时中止。
 */
export async function runWithWatchdog(input, task) {
  const { scheduler, scheduleSpec, signal, ...rest } = snapshot(input, 'options', ['scheduler', 'scheduleSpec', 'signal', 'quotas', 'workspaceDir', 'probeVramMB', 'probeGpuHealth']);
  if (typeof task !== 'function') throw bad('runWithWatchdog 要给任务函数。');
  if (signal !== undefined) {
    try {
      if (!isExactly(signal, AbortSignal)) throw new TypeError();
      AbortSignal.any([signal]); // 仿造的对象过不了内部槽检查
    } catch {
      throw bad('signal 必须是 AbortSignal。');
    }
  }
  const quotas = checkQuotas(rest.quotas);
  let spec;
  if (scheduler === undefined) {
    if (scheduleSpec !== undefined) throw bad('给了 scheduleSpec 就要给 scheduler。');
  } else {
    if (!isExactly(scheduler, Scheduler)) throw bad('scheduler 必须是 Scheduler 实例。');
    spec = snapshot(scheduleSpec, 'scheduleSpec', ['kind', 'vramMB', 'priority']);
    let granted;
    try {
      granted = scheduler.request(spec).vramMB;
    } catch (error) {
      throw bad(`scheduleSpec 不合调度器的要求：${error.message}`, error instanceof RangeError ? RangeError : TypeError);
    }
    if (quotas.vramQuotaMB > granted) throw bad(`quotas.vramQuotaMB 不得高于调度器准入的 ${granted} MB。`, RangeError);
    quotas.vramQuotaMB ??= granted;
  }
  const watchdog = createJobWatchdog({ ...rest, quotas });
  let lease;
  try {
    if (signal?.aborted) throw signal.reason;
    await watchdog.check(); // 已经超限的工作区不去排队
    // 排队期间越线（工作区被写满）也不再占着队列等额度。
    if (scheduler) lease = await scheduler.acquire(spec, { signal: AbortSignal.any([watchdog.signal, signal].filter(Boolean)) });
    const signals = [watchdog.signal, lease?.signal, signal].filter(Boolean);
    const result = await watchdog.guard(() => task({ watchdog, lease, signal: AbortSignal.any(signals) }));
    await watchdog.check(); // 返回前再查一遍：帧外写超的磁盘、轮询还没赶上的显存与 GPU 丢失，不当成功交回
    return result;
  } finally {
    watchdog.close();
    lease?.release();
  }
}
