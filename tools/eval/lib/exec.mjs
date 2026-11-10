// 调用其他包的命令行工具（qa、film.js、casebook…），按附录 C2 解析 --json 信封。
//
// 一律参数数组、不经 shell；有超时（到点先 SIGTERM，5 秒后 SIGKILL；Windows 用 taskkill /T /F 结束进程树）。
// 子进程放在独立进程组里（POSIX），收到中断时由 killAll() 连同孙进程一起结束，不留残留。
// 接口：runTool(cmd, args, { cwd, timeoutMs, env }) → { exitCode, stdout, stderr, timedOut, error }
//       runNode(script, args, opts)；parseEnvelope(stdout) → { envelope, problems }；killAll()

import { spawn, spawnSync } from 'node:child_process';

const active = new Set();

function killTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-child.pid, signal); } catch { /* 已退出 */ } }
}

/** 结束所有仍在运行的子进程树（供 SIGINT / SIGTERM 清理用）。 */
export function killAll() {
  for (const child of active) { killTree(child, 'SIGTERM'); killTree(child, 'SIGKILL'); }
  active.clear();
}

export function runTool(cmd, args, { cwd, timeoutMs = 10 * 60 * 1000, env = process.env, input = null } = {}) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (error) {
      resolve({ exitCode: null, stdout, stderr, timedOut, error });
      return;
    }
    active.add(child);
    const kill = () => {
      killTree(child, 'SIGTERM');
      if (process.platform !== 'win32') setTimeout(() => killTree(child, 'SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { if (stdout.length < 64 * 1024 * 1024) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length < 8 * 1024 * 1024) stderr += d; });
    if (input !== null) { child.stdin.end(input); }
    child.on('error', error => { if (settled) return; settled = true; active.delete(child); clearTimeout(timer); resolve({ exitCode: null, stdout, stderr, timedOut, error }); });
    child.on('close', code => { if (settled) return; settled = true; active.delete(child); clearTimeout(timer); resolve({ exitCode: code, stdout, stderr, timedOut, error: null }); });
  });
}

export const runNode = (script, args, opts = {}) => runTool(process.execPath, [script, ...args], opts);

/**
 * 解析 --json 信封：stdout 应恰好是一个 JSON 对象（C2）。
 * 容错：stdout 多行时取最后一个能解析的对象，并在 problems 里记一条「工具违反 C2」。
 */
export function parseEnvelope(stdout) {
  const problems = [];
  const text = String(stdout ?? '').trim();
  if (!text) return { envelope: null, problems: ['stdout 为空，没有 JSON 信封'] };
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { envelope: v, problems };
    problems.push('stdout 不是 JSON 对象');
  } catch {
    const lines = text.split(/\r?\n/).reverse();
    for (const line of lines) {
      try {
        const v = JSON.parse(line);
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          problems.push('stdout 不止一个 JSON 对象（违反附录 C2：--json 时 stdout 只能有一个对象）');
          return { envelope: v, problems };
        }
      } catch { /* 下一行 */ }
    }
    problems.push('stdout 不是合法 JSON');
  }
  return { envelope: null, problems };
}
