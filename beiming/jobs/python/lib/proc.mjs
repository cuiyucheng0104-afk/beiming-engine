// Python 解释器探测所需的超时与 PATH 查找。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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
export function run(cmd, args = [], { cwd, env = process.env, timeout = 60_000, input, tee = false, group = false, shell = false } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let stdout = '', stderr = '', tailBuf = '', timedOut = false, settled = false;
    let child;
    const done = (code, signal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const tail = tailBuf.split(/\r?\n/).filter(Boolean).slice(-40);
      resolve({ code, signal, stdout, stderr, timedOut, error, ms: Date.now() - t0, tail });
    };
    try {
      child = spawn(cmd, args, { cwd, env, shell, windowsHide: true, detached: group && process.platform !== 'win32', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: e, ms: 0, tail: [] });
    }
    child.__group = group && process.platform !== 'win32';
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
