#!/usr/bin/env node
// 北冥仓库 · 远程 agent：由控制机（tools/remote/cli.mjs）每次上传到工作站的 <root>/bin/ 后执行，只用 Node 内置模块与 git，
// 不依赖工作站上的 shell 语法、也不依赖被渲染的那个提交里有没有本文件。
//   node agent.mjs <操作> <base64url JSON 令牌>
//   操作：hello（机器信息）、prepare（缓存仓库里有没有这个提交）、run（检出 → 整机锁 → setup → 命令 → 收集产物与哈希）、cleanup、gc
// 输出：stdout 最后一行是一个 JSON 对象（C2 信封的字段 + 各操作的数据）；过程日志与被运行命令的全部输出都走 stderr（控制机实时转发）。
// 中断：run 时 stdin 被关闭（控制机退出或 ssh 断开）就结束子进程树、删除本次工作树、释放锁，退出 130。
//
// <root> 下的布局：repo.git（缓存的裸仓库，按提交保存 refs/beiming/<sha>）、runs/<run-id>/（每次一个独立工作树）、runs/<run-id>.json（运行记录）、
//                 locks/slot-<n>.json（整机槽位锁）、locks/deps.json（建共享依赖时的锁）、deps/venv-<锁文件哈希>/（按锁文件共享的 Python 环境）
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AGENT_VERSION = 1;
const [op, token] = process.argv.slice(2);
const log = s => process.stderr.write(`[工作站] ${s}\n`);
// 写完再退出（管道上 stdout 可能是异步的；run 时 stdin 的监听也会让进程不退出）
const done = (exitCode, data = {}, error = null) => {
  process.stdout.write(JSON.stringify({ ok: exitCode === 0, exitCode, command: `remote-agent ${op}`, error, outputs: [], runJson: null, warnings: [], agentVersion: AGENT_VERSION, ...data }) + '\n', () => process.exit(exitCode));
};
const die = (exitCode, code, message, hint = null, data = {}) => {
  try { fs.writeSync(1, JSON.stringify({ ok: false, exitCode, command: `remote-agent ${op}`, error: { code, message, hint }, outputs: [], runJson: null, warnings: [], agentVersion: AGENT_VERSION, ...data }) + '\n'); } catch { /* stdout 已关闭 */ }
  process.exit(exitCode);
};

let req;
try { req = JSON.parse(Buffer.from(token || '', 'base64url').toString('utf8')); } catch { die(2, 'usage', '参数令牌无法解析', '由 tools/remote/cli.mjs 调用，不要手动运行'); }
if (!req.root) die(2, 'usage', '缺 root');
const ROOT = path.resolve(req.root);
const D = { repo: path.join(ROOT, 'repo.git'), runs: path.join(ROOT, 'runs'), locks: path.join(ROOT, 'locks'), deps: path.join(ROOT, 'deps'), bin: path.join(ROOT, 'bin') };
const GIT = req.git || 'git';

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, ...opts });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}
const git = (args, opts) => sh(GIT, args, opts);
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
function fileSha256(p) {
  const h = createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
const venvPython = v => (process.platform === 'win32' ? path.join(v, 'Scripts', 'python.exe') : path.join(v, 'bin', 'python'));
const SHA = /^[0-9a-f]{40}$/;
const RUN = /^[0-9A-Za-z][0-9A-Za-z._-]{5,80}$/;

function machine() {
  const gpus = [];
  if (process.platform !== 'darwin') {
    const r = sh('nvidia-smi', ['--query-gpu=name,driver_version,memory.total,utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 8000 });
    if (r.code === 0) for (const l of r.stdout.trim().split('\n').filter(Boolean)) { const [name, driver, mem, util] = l.split(',').map(s => s.trim()); gpus.push({ name, driver, memoryMiB: +mem, util: +util }); }
  }
  return {
    hostname: os.hostname(), platform: process.platform, arch: os.arch(), release: os.release(), cpu: os.cpus()[0]?.model || null, cpus: os.cpus().length,
    memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version, git: (git(['--version']).stdout || '').trim() || null, gpus,
  };
}
function ensureDirs() { for (const d of Object.values(D)) fs.mkdirSync(d, { recursive: true }); }
function ensureRepo() {
  if (!fs.existsSync(path.join(D.repo, 'HEAD'))) {
    const r = git(['init', '--bare', '--quiet', D.repo]);
    if (r.code !== 0) die(3, 'git-missing', `建缓存仓库失败：${(r.stderr || r.error?.message || '').trim()}`, '在工作站上安装 git，或在机器档案里把 git 写成完整路径');
  }
}

// ── 整机锁：文件独占创建；持有者进程已不在时接管 ──
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const held = new Set();
function tryLock(p, info) {
  try { fs.writeFileSync(p, JSON.stringify(info), { flag: 'wx' }); held.add(p); return true; } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* 写到一半 */ }
    if (cur && cur.host === os.hostname() && !alive(cur.pid)) { fs.rmSync(p, { force: true }); return tryLock(p, info); }
    return false;
  }
}
function releaseAll() { for (const p of held) fs.rmSync(p, { force: true }); held.clear(); }
process.on('exit', releaseAll);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function acquire(names, waitSec, info) {
  const deadline = Date.now() + Math.max(0, waitSec) * 1000;
  for (;;) {
    for (const n of names) { const p = path.join(D.locks, n); if (tryLock(p, info)) return p; }
    if (Date.now() >= deadline) {
      const holders = names.map(n => { try { return JSON.parse(fs.readFileSync(path.join(D.locks, n), 'utf8')); } catch { return null; } }).filter(Boolean);
      return { busy: holders };
    }
    await sleep(2000);
  }
}

// ── 子进程：输出转到 stderr；记住 stdout 尾部以便读取 C2 信封 ──
let child = null;
function killTree(c) {
  if (!c || c.exitCode !== null) return;
  try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } }
}
function runChild(cmd, args, { cwd, env }) {
  return new Promise(resolve => {
    let tail = '';
    const bin = cmd === 'node' ? process.execPath : cmd;
    try { child = spawn(bin, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: null, error: e, tail }); }
    child.stdout.on('data', d => { process.stderr.write(d); tail = (tail + d.toString('utf8')).slice(-(1 << 20)); });
    child.stderr.on('data', d => process.stderr.write(d));
    child.on('error', e => resolve({ code: null, error: e, tail }));
    child.on('close', (code, signal) => { child = null; resolve({ code: code ?? (signal ? 128 + ({ SIGKILL: 9, SIGTERM: 15, SIGINT: 2 }[signal] || 1) : 1), tail }); });
  });
}
function lastEnvelope(text) {
  const lines = text.trim().split('\n').reverse();
  for (const l of lines) { const s = l.trim(); if (!s.startsWith('{')) continue; try { const j = JSON.parse(s); if ('exitCode' in j && 'ok' in j) return j; } catch { /* 不是 JSON */ } }
  return null;
}

// ── 产物收集：精确路径、目录（递归）、含 * 或 ** 的模式；只收工作树内的文件 ──
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules' && e.name !== '.venv') walk(p, out); } else if (e.isFile()) out.push(p);
  }
  return out;
}
const toRel = (base, p) => path.relative(base, p).split(path.sep).join('/');
function globRe(pat) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*' && pat[i + 1] === '*') { re += '.*'; i++; if (pat[i + 1] === '/') i++; } else if (c === '*') re += '[^/]*'; else if (c === '?') re += '[^/]'; else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
function collect(base, patterns) {
  const files = new Set();
  for (const raw of patterns) {
    const pat = String(raw).replace(/\\/g, '/').replace(/^\.\//, '');
    const abs = path.resolve(base, pat);
    if (!abs.startsWith(base + path.sep) && abs !== base) continue;
    if (!/[*?]/.test(pat)) {
      if (fs.existsSync(abs)) (fs.statSync(abs).isDirectory() ? walk(abs) : [abs]).forEach(f => files.add(f));
      continue;
    }
    const segs = pat.split('/');
    const fixed = segs.slice(0, segs.findIndex(x => /[*?]/.test(x))).join('/');
    const re = globRe(pat);
    for (const f of walk(path.join(base, fixed))) if (re.test(toRel(base, f))) files.add(f);
  }
  return [...files].sort().map(f => { const st = fs.statSync(f); return { path: toRel(base, f), size: st.size, sha256: fileSha256(f) }; });
}

function removeWorktree(runDir) {
  if (fs.existsSync(runDir)) {
    const r = git(['-C', D.repo, 'worktree', 'remove', '--force', runDir]);
    if (r.code !== 0) fs.rmSync(runDir, { recursive: true, force: true });
  }
  git(['-C', D.repo, 'worktree', 'prune']);
}

async function opRun() {
  const { sha, runId } = req;
  if (!SHA.test(sha || '') || !RUN.test(runId || '')) die(2, 'usage', 'sha 或 runId 不合法');
  if (!Array.isArray(req.cmd) || !req.cmd.length) die(2, 'usage', '缺少要运行的命令');
  ensureDirs(); ensureRepo();
  const runDir = path.join(D.runs, runId);
  const t0 = Date.now(), timing = {};
  let aborted = false;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    log('控制机已断开：结束子进程、删除本次工作树、释放锁');
    killTree(child);
    try { removeWorktree(runDir); } catch { /* 尽力 */ }
    releaseAll();
    process.exit(130);
  };
  if (req.watchStdin) { process.stdin.on('end', abort); process.stdin.on('close', abort); process.stdin.resume(); }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, abort);   // 本机传输时 Ctrl+C 也会直接送到 agent
  if (req.bundle) {
    const b = path.join(D.runs, `${runId}.bundle`);
    const r = git(['-C', D.repo, 'fetch', '--quiet', b, `refs/beiming/run:refs/beiming/${sha}`]);
    fs.rmSync(b, { force: true });
    if (r.code !== 0) die(1, 'bundle-failed', `导入代码包失败：${r.stderr.trim()}`, '重跑；仍失败时运行 remote cleanup 后再试');
  }
  if (git(['-C', D.repo, 'cat-file', '-e', `${sha}^{commit}`]).code !== 0) die(1, 'commit-missing', `缓存仓库里没有提交 ${sha}`, '重跑（控制机会重新发送代码包）');
  if (fs.existsSync(runDir)) die(2, 'usage', `运行目录已存在：${runDir}`, '换一个 runId，或先 remote cleanup');
  const wt = git(['-C', D.repo, 'worktree', 'add', '--detach', '--quiet', runDir, sha]);
  if (wt.code !== 0) die(1, 'worktree-failed', `检出 ${sha.slice(0, 12)} 失败：${wt.stderr.trim()}`, '检查工作站磁盘空间与 root 权限');
  timing.checkout = (Date.now() - t0) / 1000;
  const info = { pid: process.pid, host: os.hostname(), runId, sha, startedAt: new Date().toISOString() };
  const slot = await acquire(Array.from({ length: req.slots || 1 }, (_, i) => `slot-${i}.json`), req.wait || 0, info);
  if (slot.busy) { removeWorktree(runDir); die(5, 'busy', `工作站的 ${req.slots || 1} 个远程槽位都被占用：${slot.busy.map(h => `${h.runId}（${h.startedAt}）`).join('、')}`, '等它结束，或加 --wait <秒> 排队'); }
  const env = { ...process.env, ...(req.env || {}), PYTHONUTF8: '1' };
  let setupResult = null, venv = null;
  if (req.setup) {
    const setupJs = path.join(runDir, 'tools', 'env', 'setup.mjs');
    if (!fs.existsSync(setupJs)) { removeWorktree(runDir); die(3, 'setup-missing', `提交 ${sha.slice(0, 12)} 里没有 tools/env/setup.mjs（早于环境工具）`, '换新一点的提交，或加 --no-setup 并在机器档案的 env 里给出 BEIMING_PYTHON 等'); }
    const lockFile = path.join(runDir, 'requirements.lock');
    venv = path.join(D.deps, `venv-${fs.existsSync(lockFile) ? sha256(fs.readFileSync(lockFile)).slice(0, 12) : 'nolock'}`);
    const depsLock = await acquire(['deps.json'], 1800, info);
    if (depsLock.busy) { removeWorktree(runDir); die(5, 'busy', '共享依赖正被另一个任务建立，超过 30 分钟', '稍后重跑'); }
    log(`setup（共享 Python 环境 ${path.basename(venv)}）…`);
    const t1 = Date.now();
    const s = await runChild('node', [setupJs, '--json', '--venv', venv, '--no-hooks'], { cwd: runDir, env });
    fs.rmSync(depsLock, { force: true }); held.delete(depsLock);
    setupResult = lastEnvelope(s.tail);
    timing.setup = (Date.now() - t1) / 1000;
    if (s.code !== 0) {
      removeWorktree(runDir);
      return done(s.code || 1, { runId, sha, machine: machine(), timing, setup: setupResult }, { code: 'setup-failed', message: `工作站上 setup 失败（退出码 ${s.code}）：${setupResult?.error?.message || ''}`, hint: setupResult?.error?.hint || '看上面转发的日志' });
    }
    env.BEIMING_PYTHON = venvPython(venv);
  }
  log(`运行：${req.cmd.join(' ')}`);
  const t2 = Date.now();
  const r = await runChild(req.cmd[0], req.cmd.slice(1), { cwd: runDir, env });
  timing.command = (Date.now() - t2) / 1000;
  const envelope = lastEnvelope(r.tail);
  const patterns = [...(req.fetch || []), ...((envelope?.outputs || []).map(o => o.path).filter(Boolean))];
  const files = collect(runDir, patterns);
  timing.total = (Date.now() - t0) / 1000;
  const manifest = {
    schemaVersion: 1, runId, sha, command: req.cmd, exitCode: r.code, error: r.error ? String(r.error.message || r.error) : null,
    machine: machine(), env: Object.keys(req.env || {}), venv: venv ? path.basename(venv) : null, setup: setupResult ? { ok: setupResult.ok, steps: setupResult.steps } : null,
    envelope: envelope ? { ok: envelope.ok, exitCode: envelope.exitCode, command: envelope.command, error: envelope.error, outputs: envelope.outputs, runJson: envelope.runJson } : null,
    files, timing, finishedAt: new Date().toISOString(),
  };
  const manifestPath = path.join(D.runs, `${runId}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  releaseAll();
  if (req.watchStdin) { process.stdin.off('end', abort); process.stdin.off('close', abort); process.stdin.pause(); }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(sig, abort);
  const code = r.error ? 3 : r.code;
  done(code, { runId, sha, runDir, manifestPath, manifest },
    code === 0 ? null : { code: r.error ? 'command-missing' : 'command-failed', message: r.error ? `无法启动 ${req.cmd[0]}：${r.error.message}` : `命令退出码 ${r.code}${envelope?.error ? `：${envelope.error.message}` : ''}`, hint: envelope?.error?.hint || '看上面转发的日志' });
}

function opCleanup() {
  ensureDirs();
  const ids = req.runId ? [req.runId] : [];
  if (req.stale) {
    const maxAge = (req.days ?? 7) * 86400_000;
    for (const e of fs.readdirSync(D.runs, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const lockedBy = fs.readdirSync(D.locks).map(n => { try { return JSON.parse(fs.readFileSync(path.join(D.locks, n), 'utf8')); } catch { return null; } }).filter(h => h && alive(h.pid)).map(h => h.runId);
      if (lockedBy.includes(e.name)) continue;
      if (Date.now() - fs.statSync(path.join(D.runs, e.name)).mtimeMs > maxAge || req.all) ids.push(e.name);
    }
    for (const n of fs.readdirSync(D.locks)) {
      const p = path.join(D.locks, n);
      let h = null;
      try { h = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* 坏锁 */ }
      if (!h || (h.host === os.hostname() && !alive(h.pid))) fs.rmSync(p, { force: true });
    }
  }
  const removed = [];
  for (const id of ids) {
    if (!RUN.test(id)) continue;
    removeWorktree(path.join(D.runs, id));
    fs.rmSync(path.join(D.runs, `${id}.bundle`), { force: true });
    removed.push(id);
  }
  if (fs.existsSync(path.join(D.repo, 'HEAD'))) git(['-C', D.repo, 'worktree', 'prune']);
  done(0, { removed });
}

if (op === 'hello') { ensureDirs(); done(0, { machine: machine(), root: ROOT }); }
else if (op === 'prepare') {
  ensureDirs(); ensureRepo();
  const have = SHA.test(req.sha || '') && git(['-C', D.repo, 'cat-file', '-e', `${req.sha}^{commit}`]).code === 0;
  const tips = git(['-C', D.repo, 'for-each-ref', '--sort=-committerdate', '--count=50', '--format=%(objectname)', 'refs/beiming/']).stdout.split('\n').filter(s => SHA.test(s));
  done(0, { have, tips, machine: machine(), runId: `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${(req.sha || '').slice(0, 7)}-${randomBytes(2).toString('hex')}` });
}
else if (op === 'run') await opRun();
else if (op === 'cleanup') opCleanup();
else die(2, 'usage', `不认识的操作：${op}`, '可选：hello、prepare、run、cleanup');
