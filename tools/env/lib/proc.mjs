// 北冥仓库 · 子进程工具：带超时的运行、按 PATH 找可执行文件、整组结束、跨平台调用 npm。
//
// 接口：
//   run(cmd, args, {cwd, env, timeout, input, tee, group, shell})
//       → Promise<{code, signal, stdout, stderr, timedOut, error, ms, tail}>；永不抛错，失败看 code / error
//       tee: true 时子进程输出实时转到本进程 stderr（--json 时 stdout 保持干净），同时保留最后 40 行在 tail
//       group: true 时在 POSIX 上建独立进程组，超时或收到信号时连同孙进程一起结束
//   which(name, {env, platform})     在 PATH 里找可执行文件（Windows 按 PATHEXT 补扩展名），找不到返回 null
//   npmInvocation()                  {cmd, args}：优先 npm_execpath 指向的 npm-cli.js，避开 Windows 上 .cmd 不能直接 spawn 的问题
//   killAll()                        结束所有仍在运行的子进程（cli.mjs 的清理阶段调用）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { onCleanup } from './cli.mjs';

const live = new Set();
onCleanup(() => killAll());

export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else if (child.__group) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
}
export function killAll() { for (const c of live) killTree(c); live.clear(); }

export function run(cmd, args = [], { cwd, env = process.env, timeout = 60_000, input, tee = false, group = false, shell = false } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let stdout = '', stderr = '', tailBuf = '', timedOut = false, settled = false;
    let child;
    const done = (code, signal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.delete(child);
      const tail = tailBuf.split(/\r?\n/).filter(Boolean).slice(-40);
      resolve({ code, signal, stdout, stderr, timedOut, error, ms: Date.now() - t0, tail });
    };
    try {
      child = spawn(cmd, args, { cwd, env, shell, windowsHide: true, detached: group && process.platform !== 'win32', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: e, ms: 0, tail: [] });
    }
    child.__group = group && process.platform !== 'win32';
    live.add(child);
    const timer = timeout > 0 ? setTimeout(() => { timedOut = true; killTree(child); }, timeout) : null;
    const grab = (which) => (buf) => {
      const s = buf.toString('utf8');
      if (which === 'out') stdout += s; else stderr += s;
      if (stdout.length + stderr.length > 64 << 20) { stdout = stdout.slice(-(32 << 20)); stderr = stderr.slice(-(32 << 20)); }
      tailBuf = (tailBuf + s).slice(-16384);
      if (tee) process.stderr.write(s);
    };
    child.stdout.on('data', grab('out'));
    child.stderr.on('data', grab('err'));
    child.on('error', e => done(null, null, e));
    child.on('close', (code, signal) => done(code, signal));
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

export function which(name, { env = process.env, platform = process.platform } = {}) {
  if (!name) return null;
  const isWin = platform === 'win32';
  const exts = isWin ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())] : [''];
  const hasDir = name.includes('/') || (isWin && name.includes('\\'));
  const candidates = hasDir ? [name] : (env.PATH || env.Path || '').split(isWin ? ';' : ':').filter(Boolean).map(d => path.join(d, name));
  for (const base of candidates) {
    for (const ext of (isWin && !path.extname(base) ? exts : [''])) {
      const p = base + ext;
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        if (!isWin) fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch { /* 下一个 */ }
    }
  }
  return null;
}

export function npmInvocation(env = process.env) {
  const candidates = [
    env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(p => p && /npm-cli\.js$/.test(p));
  for (const p of candidates) if (fs.existsSync(p)) return { cmd: process.execPath, args: [p] };
  const npm = which('npm', { env });
  // 找不到 npm-cli.js 时才退回 npm.cmd：Windows 上 .cmd 只能经 shell 启动（参数都是本工具写死的常量，没有注入面）
  return npm ? { cmd: npm, args: [], shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(npm) } : null;
}
