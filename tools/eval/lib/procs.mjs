// 进程快照（跨平台），用来判定 H7「结束后没有渲染进程残留」。
//
// macOS 用 `ps -ww -ax -o pid=,ppid=,command=`（不能用 -e：macOS 的 -e 会把环境变量打出来）；
// Linux 用 `ps -ww -e -o pid=,ppid=,args=`；Windows 用 PowerShell 的 Get-CimInstance Win32_Process。
// 只保留与渲染相关的进程名，报告里不落其他进程的命令行。
// 接口：listProcesses() → [{ pid, ppid, command }]；matchRender(list, names) → 命中的进程

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { EvalError, EXIT } from './cli.mjs';

export const RENDER_PROCESS_NAMES = Object.freeze(['chrome-headless-shell', 'headless_shell', 'chrome_crashpad_handler', 'ffmpeg', 'ffprobe', 'raea']);

export function listProcesses() {
  let res;
  if (process.platform === 'win32') {
    res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,Name | ConvertTo-Json -Compress'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (res.error || res.status !== 0) throw new EvalError('ps-failed', '无法列出进程（PowerShell Get-CimInstance 失败）', { exitCode: EXIT.ENV, hint: '确认 powershell.exe 可用' });
    const data = JSON.parse(res.stdout || '[]');
    return [].concat(data).map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, command: p.CommandLine || p.Name || '' }));
  }
  const args = process.platform === 'darwin' ? ['-ww', '-ax', '-o', 'pid=,ppid=,command='] : ['-ww', '-e', '-o', 'pid=,ppid=,args='];
  res = spawnSync('ps', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error || res.status !== 0) throw new EvalError('ps-failed', `无法列出进程（ps 失败：${res.error?.code ?? res.status}）`, { exitCode: EXIT.ENV, hint: '确认 ps 可用' });
  const out = [];
  for (const line of res.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return out;
}

/** 粗分词：够用来取出各个参数的文件名（不处理复杂转义）。 */
function tokens(command) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const INTERPRETERS = new Set(['node', 'python', 'python3', 'sh', 'bash', 'pwsh', 'powershell']);
const baseName = t => path.basename(String(t).replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');

/**
 * 可执行文件名（去掉 .exe）等于 names 之一即命中；解释器（node、python、sh…）启动的脚本按脚本文件名判断。
 * 只看前两个参数，避免把「grep ffmpeg」这类命令误判成残留。
 */
export function matchRender(list, names = RENDER_PROCESS_NAMES) {
  const wanted = new Set(names.map(n => n.toLowerCase()));
  return list.filter(p => {
    if (p.pid === process.pid) return false;
    const [first, second] = tokens(p.command);
    if (first === undefined) return false;
    if (wanted.has(baseName(first))) return true;
    return INTERPRETERS.has(baseName(first)) && second !== undefined && wanted.has(baseName(second));
  });
}
