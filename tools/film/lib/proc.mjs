// 北冥仓库 · 出片编排 · 子进程：超时、无输出看门狗、整棵进程树清理、信号转发、临时目录隔离。
// 现有渲染器（engine/render/{still,video}.mjs、mux.sh、native.mjs）在页面报错、缺 ffmpeg、收到 SIGTERM 时会挂住或留下
// 无头 Chrome / ffmpeg（加固计划 TOOLS-01、CODE-02）；这里在编排层兜住：任何失败路径都先收集整棵子进程树再逐个结束。
//
//   exec(cmd, args, { cwd, env, label, timeoutSec, stallSec, logFile, quiet, input, okCodes, sweep }) → Promise<{ code, stdout, stderr, seconds }>
//     退出码非 0 → FilmError(1)；命令不存在 → FilmError(3)；超时 / 看门狗 → 结束进程树后 FilmError(124)
//     子进程的 stdout / stderr 都转给本进程的 stderr（stdout 只留给 --json 信封），同时写进 logFile；quiet 时只收集不转发
//     sweep（默认 true）：子进程正常退出后再扫一次它的进程组，结束遗留的孙进程（ffprobe 这类一次性查询传 false）
//   killAll(signal)   结束所有在跑的子进程树（信号处理与异常退出时调用）
//   which(cmd)        在 PATH 里找可执行文件（Windows 认 PATHEXT），找不到返回 null
//   isolatedEnv(base, tmpDir)  把 TMPDIR / TMP / TEMP 指到运行目录内，结束后整体删掉，$TMPDIR 不留文件
//
// 进程树：POSIX 上子进程以 detached 启动（自成进程组）；Playwright 也把浏览器放进独立进程组，所以只杀进程组不够——
// 先用 ps 列出整棵子孙树（在父进程死掉、子孙被系统收养之前），再对每个进程和它的进程组发 SIGTERM，宽限后 SIGKILL。
// Windows 上用 taskkill /T /F 结束整棵树。不会碰到本进程自己的进程组。
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError } from './exit.mjs';

const WIN = process.platform === 'win32';
const active = new Set();   // { child, label }

export function which(cmd) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) return fs.existsSync(cmd) ? cmd : null;
  const exts = WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map(e => e.toLowerCase()) : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, WIN && !path.extname(cmd) ? cmd + ext : cmd);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* 下一个 */ }
    }
  }
  return null;
}

function psTable() {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 5000 });
    return out.split('\n').map(l => l.trim().split(/\s+/).map(Number)).filter(r => r.length === 3 && r.every(Number.isFinite))
      .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
  } catch { return []; }
}

// 以 root 为根的整棵树（按父子关系），再并上这些进程所在进程组的全部成员（父进程已死、成员被收养的情况）
function treeOf(rootPid, ownGroup) {
  const rows = psTable();
  const kids = new Map();
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r); }
  const tree = new Map([[rootPid, { pid: rootPid, pgid: rootPid }]]);
  const queue = [rootPid];
  while (queue.length) for (const k of kids.get(queue.shift()) || []) if (!tree.has(k.pid)) { tree.set(k.pid, k); queue.push(k.pid); }
  const groups = new Set([...tree.values()].map(p => p.pgid).filter(g => g > 1 && g !== ownGroup));
  for (const r of rows) if (groups.has(r.pgid) && !tree.has(r.pid)) tree.set(r.pid, r);
  tree.delete(process.pid);
  return { procs: [...tree.values()], groups: [...groups] };
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
let ownGroup = null;
function myGroup() {
  if (ownGroup !== null || WIN) return ownGroup;
  try { ownGroup = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 5000 }).trim()); } catch { ownGroup = -1; }
  return ownGroup;
}

// 结束 pid 为根的整棵进程树（含被 Playwright 放进独立进程组的浏览器）；返回被处理的进程数
export async function killTree(pid, { graceMs = 2500 } = {}) {
  if (!pid) return 0;
  if (WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 });
    return 1;
  }
  const mine = myGroup();
  const { procs, groups } = treeOf(pid, mine);
  const send = sig => {
    for (const g of groups) { try { process.kill(-g, sig); } catch { /* 组已不在 */ } }
    for (const p of procs) { try { process.kill(p.pid, sig); } catch { /* 已退出 */ } }
  };
  if (!procs.some(p => alive(p.pid))) return 0;
  send('SIGTERM');
  const until = Date.now() + graceMs;
  while (Date.now() < until && procs.some(p => alive(p.pid))) await new Promise(r => setTimeout(r, 100));
  if (procs.some(p => alive(p.pid))) send('SIGKILL');
  return procs.length;
}

export async function killAll() {
  const list = [...active];
  active.clear();
  await Promise.all(list.map(a => killTree(a.child.pid)));
  return list.length;
}
export const activeCount = () => active.size;

export function isolatedEnv(base, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  return { ...base, TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir, PYTHONDONTWRITEBYTECODE: '1' };
}

export function exec(cmd, args, o = {}) {
  const { cwd, env = process.env, label = path.basename(cmd), timeoutSec = 0, stallSec = 0, logFile = null, quiet = false, input = null, okCodes = [0], sweep = true } = o;
  const resolved = which(cmd);
  if (!resolved) {
    return Promise.reject(new FilmError(EXIT.ENV, 'missing-tool', `找不到可执行文件「${cmd}」（${label}）`,
      cmd === 'sh' ? '这一步要 POSIX sh：macOS / Linux 自带；Windows 请装 Git Bash 并把 sh 放进 PATH（P04·R3 的 mux.mjs 合入后去掉此依赖）'
        : cmd === 'ffmpeg' || cmd === 'ffprobe' ? '安装 FFmpeg ≥ 7（带 libx264、aac、loudnorm、ebur128）并放进 PATH'
          : /python/i.test(cmd) ? '设 PYTHON=<装了 requirements.txt 依赖的 python>，或把 python3 放进 PATH'
            : `安装 ${cmd} 或检查 PATH`));
  }
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let log = null;
    if (logFile) { fs.mkdirSync(path.dirname(logFile), { recursive: true }); log = fs.createWriteStream(logFile, { flags: 'a' }); log.write(`$ ${[cmd, ...args].join(' ')}\n`); }
    // Windows 上 .cmd/.bat 需要 shell；其余一律不经 shell（参数里的空格与中文原样传）
    const useShell = WIN && /\.(cmd|bat)$/i.test(resolved);
    const child = spawn(resolved, args, { cwd, env, detached: !WIN, shell: useShell, windowsHide: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const entry = { child, label };
    active.add(entry);
    let stdout = '', stderr = '', last = Date.now(), done = false, why = null;
    const tail = s => s.length > 400000 ? s.slice(-400000) : s;
    const onData = (buf, isErr) => {
      last = Date.now();
      const s = buf.toString();
      if (isErr) stderr = tail(stderr + s); else stdout = tail(stdout + s);
      if (log) log.write(s);
      if (!quiet) process.stderr.write(s);
    };
    child.stdout.on('data', b => onData(b, false));
    child.stderr.on('data', b => onData(b, true));
    if (input !== null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    const timers = [];
    const stop = reason => {
      if (done || why) return;
      why = reason;
      killTree(child.pid).catch(() => {});
    };
    if (timeoutSec > 0) timers.push(setTimeout(() => stop('timeout'), timeoutSec * 1000));
    if (stallSec > 0) timers.push(setInterval(() => { if (Date.now() - last > stallSec * 1000) stop('stall'); }, 1000));
    const finish = (err, code, signal) => {
      if (done) return;
      done = true;
      timers.forEach(t => { clearTimeout(t); clearInterval(t); });
      active.delete(entry);
      const seconds = (Date.now() - t0) / 1000;
      const end = () => {
        if (err) return reject(new FilmError(EXIT.ENV, 'spawn-failed', `无法启动 ${label}：${err.message}`, '检查命令是否已安装、PATH 与权限'));
        if (why === 'timeout') return reject(new FilmError(EXIT.TIMEOUT, 'timeout', `${label} 超过 ${timeoutSec} 秒未完成，已结束它的整棵进程树`, '加大 --timeout，或先用 --size 小画幅 / --frames 少量帧确认页面能正常出帧', { stdout, stderr, seconds }));
        if (why === 'stall') return reject(new FilmError(EXIT.TIMEOUT, 'stalled', `${label} 连续 ${stallSec} 秒没有任何输出，判为挂住，已结束它的整棵进程树`, '多半是页面 render(t) 抛错或 READY 一直不置；先 node tools/film/cli.mjs check <作品目录> 看页面契约', { stdout, stderr, seconds }));
        if (!okCodes.includes(code)) {
          const lastLine = (stderr.trim() || stdout.trim()).split('\n').filter(Boolean).slice(-1)[0] || '';
          return reject(new FilmError(EXIT.RUN, 'step-failed', `${label} 失败（退出码 ${code ?? signal}）${lastLine ? `：${lastLine.slice(0, 300)}` : ''}`, logFile ? `完整输出见 ${logFile}` : null, { code, signal, stdout, stderr, seconds }));
        }
        resolve({ code, stdout, stderr, seconds });
      };
      // 正常退出也要确认没有遗留子孙（例如页面 process.exit 后浏览器还在）：只在 POSIX 上查一次
      const swept = sweep && !WIN && child.pid ? killTree(child.pid, { graceMs: 1500 }).catch(() => {}) : Promise.resolve();
      swept.then(() => { if (log) log.end(end); else end(); });
    };
    child.on('error', e => finish(e));
    child.on('close', (code, signal) => finish(null, code, signal));
  });
}
