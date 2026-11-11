// 北冥仓库 · 控制机到工作站的传输层：ssh + scp（远端），或本机目录（local，用于测试与单机）。
// 远端只执行 node 与 git；所有文件操作都交给远端 agent（Node），不依赖远端 shell 的语法。
//
// 接口：makeTransport(machine) → {
//   exec(argv, {input, keepStdin, onStderr, timeout}) → Promise<{code, stdout, stderr, error, timedOut}>
//       argv[0] 是远端程序（通常是 machine.node）；stderr 实时交给 onStderr（默认转到本进程 stderr）
//       keepStdin=true：保持 stdin 打开直到命令结束——远端 agent 以 stdin 关闭作为「控制机已断开，停止并清理」的信号
//   put(localPath, remotePath) / get(remotePath, localPath) → Promise<void>（失败时抛错）
//   remotePath(...segments) → 远端路径（按远端 shell 用 / 或 \ 拼接）
//   describe() → 给人看的一行描述
// }
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { remoteCommand } from './shell.mjs';

const live = new Set();
// 中断时先关 stdin：远端 agent 把它当成「控制机已断开」，自己结束子进程、删工作树、释放锁；8 秒内没退出再强制结束
export async function killTransports(graceMs = 8000) {
  const waits = [...live].map(c => new Promise(resolve => {
    if (c.exitCode !== null) return resolve();
    const timer = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } resolve(); }, graceMs);
    c.once('close', () => { clearTimeout(timer); resolve(); });
    try { c.stdin.end(); } catch { /* 已关闭 */ }
  }));
  await Promise.all(waits);
  live.clear();
}

function spawnCollect(cmd, args, { input, keepStdin = false, onStderr = s => process.stderr.write(s), timeout = 0, cwd } = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false, done = false;
    let child;
    try { child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: null, stdout, stderr, error: e }); }
    live.add(child);
    const timer = timeout > 0 ? setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, timeout) : null;
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { const s = d.toString('utf8'); stderr += s; if (stderr.length > 1 << 20) stderr = stderr.slice(-(1 << 19)); onStderr?.(s); });
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.write(input);
    if (!keepStdin) child.stdin.end();
    const fin = (code, error = null) => { if (done) return; done = true; clearTimeout(timer); live.delete(child); try { child.stdin.end(); } catch { /* 已关闭 */ } resolve({ code, stdout, stderr, error, timedOut }); };
    child.on('error', e => fin(null, e));
    child.on('close', code => fin(code));
  });
}

export function makeTransport(m) {
  const winRemote = m.shell === 'powershell';
  const join = (...seg) => (winRemote ? seg.join('\\').replace(/\//g, '\\').replace(/\\+/g, '\\') : seg.join('/').replace(/\/+/g, '/'));
  if (m.transport === 'local') {
    return {
      kind: 'local',
      remotePath: (...seg) => path.join(...seg),
      describe: () => `本机目录 ${m.root}`,
      exec: (argv, opts = {}) => spawnCollect(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), opts),
      put: async (l, r) => { fs.mkdirSync(path.dirname(r), { recursive: true }); fs.copyFileSync(l, r); },
      get: async (r, l) => { fs.mkdirSync(path.dirname(l), { recursive: true }); fs.copyFileSync(r, l); },
    };
  }
  const base = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', ...m.sshOptions];
  const scpTarget = r => `${m.ssh}:${r.replace(/\\/g, '/')}`;
  const scp = async (from, to) => {
    const r = await spawnCollect('scp', ['-q', ...base, from, to], { onStderr: null });
    if (r.error) throw Object.assign(new Error(`无法运行 scp（${r.error.code || r.error.message}）`), { hint: '安装 OpenSSH 客户端（macOS 与 Windows 10+ 自带）' });
    if (r.code !== 0) throw Object.assign(new Error(`scp 失败（退出码 ${r.code}）：${r.stderr.trim().split('\n').pop() || ''}`), { hint: '检查远端路径与磁盘空间；Windows 远端的 root 用 <盘符>:/<目录> 这种正斜杠写法' });
  };
  return {
    kind: 'ssh',
    remotePath: join,
    describe: () => `${m.ssh}（${m.shell}，${m.root}）`,
    exec: (argv, opts = {}) => spawnCollect('ssh', [...base, m.ssh, remoteCommand(m.shell, argv)], opts),
    put: (l, r) => scp(l, scpTarget(r)),
    get: (r, l) => { fs.mkdirSync(path.dirname(l), { recursive: true }); return scp(scpTarget(r), l); },
  };
}
