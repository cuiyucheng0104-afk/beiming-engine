#!/usr/bin/env node
// 北冥仓库 · 测试总入口（npm test）：发现并运行仓库自己的测试，汇总成一份结果。只读源码，不改仓库里的任何文件。
//   node tools/run-tests.mjs                       跑全部
//   node tools/run-tests.mjs --only ci,production  只跑这几个域        --skip render   不跑某个域
//   node tools/run-tests.mjs --list                只列出会跑什么，不执行
//   node tools/run-tests.mjs --json                stdout 只输出一个 JSON 对象（附录 C2 信封 + summary、suites）
//   node tools/run-tests.mjs --help                完整参数
//
// 发现规则（显式枚举，不用 node --test 的默认匹配：默认匹配会跑进 cases/ 下历史作品自带的 test.js）：
//   文件：*.test.{mjs,js,cjs} 是 Node 测试，test_*.py 是 Python unittest。
//   范围：git 跟踪的文件加上未跟踪、未被忽略的文件（不是 git 检出时遍历目录）。
//   不发现：cases/、films/ 整个目录；任何一级名为 fixtures、__fixtures__、node_modules、out、__pycache__ 或以点开头的目录。
//   域：tests/<域>/… → <域>；engine/audio/… → audio（与 audio/、tests/audio/ 同属声音链路）；其余按第一级目录
//       （engine、lab、audio、tools…），根目录下的文件 → root。同名的 tests/<域>/ 与同名目录里的测试合成一个域。
// 每个域的 Node 测试由一个 `node --test` 进程运行，Python 测试由一个解释器进程运行；域之间顺序执行。
// 与旧的 npm 脚本对应：test:routes → --only ci,production,tools；test:engine → --only engine,lab；test:audio → --only audio；
//   test:cases → --only tools。旧 `npm test` 里的 routes:check、cases:check 是检查不是测试，在 tools/check-all.mjs 里。
//
// 域的运行要求（可选文件 tests/<域>/suite.json）：
//   { "requires": ["browser", "ffmpeg", "python", "python:numpy", "sh", "gpu", "network"],
//     "timeoutSec": 600, "testTimeoutSec": 120, "concurrency": 1, "description": "这一域测什么" }
//   缺少某项能力时整域跳过并写明原因；--require <能力,…> 把能力变成前置条件（缺了 exit 3），CI 的渲染 job 用它。
//   gpu、network 不自动探测：设 BEIMING_TEST_GPU=1、BEIMING_TEST_NETWORK=1 才算具备。
//
// Python 解释器：有 tools/env/py.mjs（P10）时一律经它启动；否则依次用 --python、BEIMING_PY、BEIMING_PYTHON、PYTHON、
//   仓库 .venv、python3、python、py -3。子进程统一设 PYTHONUTF8=1、PYTHONIOENCODING=utf-8。
//
// 退出码（附录 C1）：0 全部通过（跳过不算失败）；1 有测试失败；2 用法错误；3 环境缺失（Node < 22、要跑 Python 却找不到解释器、
//   --require 的能力缺失、测试因缺第三方依赖而导入失败——npm 包没装或 Python 解释器缺 requirements 里的模块）；
//   4 一个测试也没发现；124 某一域超时（已结束整棵进程树）；130 / 143 收到 SIGINT / SIGTERM（已清理）。
//   同时有几类问题时取最重的：3 > 124 > 1（与 tools/check-all.mjs 一致：环境不全时其余结果不可信）。
// 在 GitHub Actions 里（GITHUB_ACTIONS=true）另写失败注解和 $GITHUB_STEP_SUMMARY 汇总表。
//
// 本文件同时导出一组命令约定的小工具（参数解析、退出码、--json 信封、带超时与进程树清理的子进程），供 tools/check-all.mjs
// 与 tests/ci/ 下的脚本复用。P02 的 tools/lib/cli.mjs 合入后，这些工具改为从那里导入，行为保持附录 C1/C2 不变。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ───────────────────────── 命令约定（附录 C1 / C2） ─────────────────────────

export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2, ENV: 3, CONTRACT: 4, BUSY: 5, TIMEOUT: 124, SIGINT: 130, SIGTERM: 143 });

export class CliError extends Error {
  constructor(exitCode, code, message, hint = '') {
    super(message);
    this.exitCode = exitCode; this.code = code; this.hint = hint;
  }
}

// 严格解析参数。spec = { 名字: { type: 'bool' | 'string' | 'list' | 'int', short?: 'h' } }；list 可重复、可逗号分隔。
// 未知参数、缺值、类型不对一律抛 CliError(2)。positional 为允许的位置参数个数上限（默认 0）。
export function parseArgs(argv, spec, { positional = 0 } = {}) {
  const out = { _: [] };
  for (const [k, s] of Object.entries(spec)) out[k] = s.type === 'list' ? [] : s.type === 'bool' ? false : null;
  const shorts = Object.fromEntries(Object.entries(spec).filter(([, s]) => s.short).map(([k, s]) => [s.short, k]));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    let name, val;
    if (a.startsWith('--')) { const eq = a.indexOf('='); name = eq > 0 ? a.slice(2, eq) : a.slice(2); val = eq > 0 ? a.slice(eq + 1) : undefined; }
    else if (/^-[a-zA-Z]$/.test(a)) { name = shorts[a[1]]; if (!name) throw usage(`不认识的参数 ${a}`); }
    else { out._.push(a); continue; }
    const s = spec[name];
    if (!s) throw usage(`不认识的参数 --${name}`);
    if (s.type === 'bool') {
      if (val !== undefined) throw usage(`--${name} 是开关，不带值`);
      out[name] = true; continue;
    }
    if (val === undefined) { val = argv[++i]; if (val === undefined || (val.startsWith('--') && val.length > 2)) throw usage(`--${name} 后面要跟一个值`); }
    if (s.type === 'int') {
      if (!/^\d+$/.test(val) || +val <= 0) throw usage(`--${name} 要写正整数，现在是「${val}」`);
      out[name] = +val;
    } else if (s.type === 'list') {
      const items = val.split(',').map(x => x.trim()).filter(Boolean);
      if (!items.length) throw usage(`--${name} 的值不能为空`);
      out[name].push(...items);
    } else out[name] = val;
  }
  if (out._.length > positional) throw usage(`多余的参数：${out._.slice(positional).join(' ')}`);
  return out;
}
const usage = (message, hint = '加 --help 查看用法') => new CliError(EXIT.USAGE, 'USAGE', message, hint);

// 附录 C2 信封：{ok, exitCode, command, error, outputs, runJson, warnings} + 各命令自己的字段（放在后面）
export function envelope({ exitCode, command, error = null, outputs = [], runJson = null, warnings = [], ...extra }) {
  return {
    ok: exitCode === 0, exitCode, command,
    error: error ? { code: error.code || 'ERROR', message: error.message, hint: error.hint || '' } : null,
    outputs, runJson, warnings, ...extra,
  };
}

// 写 --report 文件（目录不存在就建）；失败只告警，不改变退出码
export function writeReport(file, obj) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(path.resolve(file), JSON.stringify(obj, null, 2) + '\n');
  } catch (e) { process.stderr.write(`[提示] 写报告 ${file} 失败：${e.message}\n`); }
}

// 判断本文件是不是被直接运行的入口：比较真实路径，经符号链接 / Windows 目录联接调用时也成立
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  const real = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const a = real(process.argv[1]), b = real(fileURLToPath(metaUrl));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// 终端显示宽度（中日韩全角字符按 2 格），用于对齐汇总表
export function dw(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    n += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ? 2 : 1;
  }
  return n;
}
export const pad = (s, w) => String(s) + ' '.repeat(Math.max(0, w - dw(s)));
export const fmtSec = ms => `${(ms / 1000).toFixed(1)}s`;

// ───────────────────────── GitHub Actions 注解与汇总 ─────────────────────────

export const inActions = () => process.env.GITHUB_ACTIONS === 'true';
const escData = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = s => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
export function annotate(level, message, { title, file, line, col } = {}) {
  if (!inActions()) return;
  const props = [file && `file=${escProp(file)}`, line && `line=${line}`, col && `col=${col}`, title && `title=${escProp(title)}`].filter(Boolean).join(',');
  process.stdout.write(`::${level}${props ? ' ' + props : ''}::${escData(message)}\n`);
}
export function stepSummary(markdown) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!inActions() || !f) return;
  try { fs.appendFileSync(f, markdown.endsWith('\n') ? markdown : markdown + '\n'); } catch { /* 汇总写不进去不影响结果 */ }
}
export const mdCell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

// ───────────────────────── 子进程：超时、进程树清理、信号 ─────────────────────────

const live = new Set();
// 结束整棵进程树：POSIX 下子进程是进程组长（detached），向整组发信号；Windows 用 taskkill /T
export function killTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* 已退出 */ } }
}

// 启动子进程并等它结束。opts：cwd、env、timeoutMs、stdout / stderr（'pipe' 捕获并转发到本进程 stderr，'capture' 只捕获，
// 'inherit' 直通，'ignore'）、input。返回 { code, signal, timedOut, stdout, stderr, durationMs, error }
export function run(cmd, args, opts = {}) {
  const { cwd = ROOT, env = process.env, timeoutMs = 0, stdout = 'capture', stderr = 'pipe', input = null } = opts;
  const t0 = Date.now();
  return new Promise(resolve => {
    let child;
    const mode = m => (m === 'inherit' ? 'inherit' : m === 'ignore' ? 'ignore' : 'pipe');
    try {
      child = spawn(cmd, args, {
        cwd, env, windowsHide: true, detached: process.platform !== 'win32',
        stdio: [input == null ? 'ignore' : 'pipe', mode(stdout), mode(stderr)],
      });
    } catch (error) { resolve({ code: null, signal: null, timedOut: false, leaked: false, stdout: '', stderr: '', durationMs: 0, error }); return; }
    live.add(child);
    const out = [], err = [];
    if (child.stdout) child.stdout.on('data', d => { out.push(d); if (stdout === 'pipe') process.stderr.write(d); });
    if (child.stderr) child.stderr.on('data', d => { err.push(d); if (stderr === 'pipe') process.stderr.write(d); });
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    let timedOut = false, timer = null, hard = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true; killTree(child, 'SIGTERM');
        hard = setTimeout(() => killTree(child, 'SIGKILL'), 3000);
      }, timeoutMs);
    }
    let spawnError = null;
    child.on('error', e => { spawnError = e; });
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(hard); live.delete(child);
      // 进程组里还有孙进程（例如测试启动后没关的浏览器、服务器）：记为残留并清掉
      let leaked = false;
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 0); leaked = true; process.kill(-child.pid, 'SIGKILL'); } catch { /* 组已空 */ }
      }
      resolve({
        code, signal, timedOut, leaked, error: spawnError, durationMs: Date.now() - t0,
        stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

// 等 stdout 里已经写出的内容交给系统（管道在 macOS / Windows 上是异步写），再退出不会截断 JSON
export const flushStdout = () => new Promise(r => process.stdout.write('', () => r()));

// 收到 SIGINT / SIGTERM：先结束全部子进程树，再调用 onSignal(退出码) 让调用方输出结果后退出
export function onSignals(onSignal) {
  let fired = false;
  const handler = sig => {
    if (fired) return;
    fired = true;
    for (const c of live) killTree(c, 'SIGKILL');
    const code = sig === 'SIGINT' ? EXIT.SIGINT : EXIT.SIGTERM;
    Promise.resolve().then(() => onSignal(code, sig)).catch(() => {}).then(flushStdout).finally(() => process.exit(code));
  };
  process.on('SIGINT', handler); process.on('SIGTERM', handler);
}

// ───────────────────────── Python 解释器 ─────────────────────────

const PY_ENV = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
export const pythonEnv = (extra = {}) => ({ ...process.env, ...PY_ENV, ...extra });

// 返回 { cmd, pre: [...前置参数], label } 或 null。有 tools/env/py.mjs 时经它启动（P10 的唯一解析入口）。
export function resolvePython(root = ROOT, override = null) {
  const probe = (cmd, pre) => {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print(sys.version.split()[0])'], { encoding: 'utf8', env: pythonEnv(), timeout: 20000, windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const candidates = [];
  if (override) candidates.push([override, [], '--python']);
  else {
    const pyMjs = path.join(root, 'tools/env/py.mjs');
    if (fs.existsSync(pyMjs)) candidates.push([process.execPath, [pyMjs], 'tools/env/py.mjs']);
    for (const k of ['BEIMING_PY', 'BEIMING_PYTHON', 'PYTHON']) if (process.env[k]) candidates.push([process.env[k], [], k]);
    const venv = process.platform === 'win32' ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
    if (fs.existsSync(venv)) candidates.push([venv, [], '.venv']);
    candidates.push(['python3', [], 'python3'], ['python', [], 'python']);
    if (process.platform === 'win32') candidates.push(['py', ['-3'], 'py -3']);
  }
  resolvePython.tried = [];
  for (const [cmd, pre, label] of candidates) {
    resolvePython.tried.push(label);
    const v = probe(cmd, pre);
    if (v) return { cmd, pre, label, version: v.split(/\r?\n/).pop() };
    if (override || label === 'tools/env/py.mjs') break;   // 指定了就不再往下猜，免得用错解释器
  }
  return null;
}

// ───────────────────────── 能力探测（suite.json 的 requires、--require） ─────────────────────────

export const CAPABILITIES = ['python', 'browser', 'ffmpeg', 'sh', 'gpu', 'network'];   // 另有 python:<模块>

function browserPresent(root) {
  if (process.env.BEIMING_CHROME) return fs.existsSync(process.env.BEIMING_CHROME) ? `BEIMING_CHROME=${process.env.BEIMING_CHROME}` : null;
  let rev;
  try {
    const bj = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/playwright-core/browsers.json'), 'utf8'));
    rev = bj.browsers.find(b => b.name === 'chromium-headless-shell')?.revision;
  } catch { return null; }
  if (!rev) return null;
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const base = env === '0' ? path.join(root, 'node_modules/playwright-core/.local-browsers')
    : env ? env
      : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/ms-playwright')
        : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'ms-playwright')
          : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
  const dir = path.join(base, `chromium_headless_shell-${rev}`);
  return fs.existsSync(dir) ? `chromium-headless-shell r${rev}` : null;
}
const cmdOk = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 15000, windowsHide: true }).status === 0;

// 探测一项能力 → { ok, detail }；未知名字 → { ok:false, unknown:true }
export function probeCapability(name, ctx) {
  const memo = ctx.memo || (ctx.memo = new Map());
  if (memo.has(name)) return memo.get(name);
  let r;
  if (name === 'python') { const py = ctx.python(); r = py ? { ok: true, detail: `${py.label}（Python ${py.version}）` } : { ok: false, detail: '找不到 Python 解释器' }; }
  else if (name.startsWith('python:')) {
    const mods = name.slice(7).split('+').filter(Boolean);
    const py = ctx.python();
    if (!py || !mods.length) r = { ok: false, detail: py ? '没写模块名' : '找不到 Python 解释器' };
    else {
      const p = spawnSync(py.cmd, [...py.pre, '-c', `import ${mods.join(', ')}`], { env: pythonEnv(), stdio: 'ignore', timeout: 60000, windowsHide: true });
      r = p.status === 0 ? { ok: true, detail: `可导入 ${mods.join('、')}` } : { ok: false, detail: `${py.label} 导入 ${mods.join('、')} 失败` };
    }
  } else if (name === 'browser') { const d = browserPresent(ctx.root); r = d ? { ok: true, detail: d } : { ok: false, detail: '没装 playwright-core 的 chromium-headless-shell（npx playwright-core install chromium-headless-shell）' }; }
  else if (name === 'ffmpeg') {
    const ff = process.env.FFMPEG || 'ffmpeg';
    r = cmdOk(ff, ['-version']) && cmdOk('ffprobe', ['-version']) ? { ok: true, detail: 'ffmpeg、ffprobe 可用' } : { ok: false, detail: 'PATH 里没有可用的 ffmpeg / ffprobe' };
  } else if (name === 'sh') r = cmdOk('sh', ['-c', 'exit 0']) ? { ok: true, detail: 'POSIX sh 可用' } : { ok: false, detail: '没有 POSIX sh（Windows 上不依赖 Git Bash 的检查会跳过）' };
  else if (name === 'gpu') r = process.env.BEIMING_TEST_GPU === '1' ? { ok: true, detail: 'BEIMING_TEST_GPU=1' } : { ok: false, detail: '需要 GPU 的测试默认不跑：在有独显的机器上设 BEIMING_TEST_GPU=1' };
  else if (name === 'network') r = process.env.BEIMING_TEST_NETWORK === '1' ? { ok: true, detail: 'BEIMING_TEST_NETWORK=1' } : { ok: false, detail: '需要外网的测试默认不跑：设 BEIMING_TEST_NETWORK=1' };
  else r = { ok: false, unknown: true, detail: `未知能力「${name}」（可用：${CAPABILITIES.join('、')}、python:<模块>）` };
  memo.set(name, r);
  return r;
}

// ───────────────────────── 发现 ─────────────────────────

const SKIP_DIRS = new Set(['fixtures', '__fixtures__', 'node_modules', 'out', '__pycache__']);
const SKIP_TOP = new Set(['cases', 'films']);   // 历史归档与第三方快照、用户作品：不是仓库自己的测试
const NODE_TEST = /\.test\.(mjs|js|cjs)$/, PY_TEST = /^test_.*\.py$/;
const isTestName = name => NODE_TEST.test(name) || PY_TEST.test(name);
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// 相对路径（/ 分隔）是否在发现范围内
export function inScope(rel) {
  const parts = rel.split('/');
  if (SKIP_TOP.has(parts[0])) return false;
  return parts.slice(0, -1).every(p => !p.startsWith('.') && !SKIP_DIRS.has(p)) && isTestName(parts[parts.length - 1]);
}

// 测试文件 → 域名
export function domainOf(rel) {
  const parts = rel.split('/');
  if (parts.length === 1) return 'root';
  if (parts[0] === 'tests') return parts.length > 2 ? parts[1] : 'root';
  if (parts[0] === 'engine' && parts[1] === 'audio') return 'audio';
  return parts[0];
}

// 候选文件：git 跟踪的 + 未跟踪未忽略的（按 .gitignore）；不是 git 检出（或 git 不可用）时遍历目录
function candidates(root) {
  const g = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: 60000 });
  if (g.status === 0 && !g.error) {
    // 已从工作区删掉但还在索引里的文件不算
    return [...new Set(g.stdout.split('\0').filter(Boolean))].filter(f => inScope(f) && fs.existsSync(path.join(root, ...f.split('/'))));
  }
  const out = [];
  const walk = rel => {
    let entries;
    try { entries = fs.readdirSync(path.join(root, ...rel.split('/').filter(Boolean)), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => byName(a.name, b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || (!rel && SKIP_TOP.has(e.name))) continue;
        walk(r);
      } else if (e.isFile() && inScope(r)) out.push(r);
    }
  };
  walk('');
  return out;
}

// → [{ id, domain, kind: 'node'|'python', files: [相对路径], config, configError }]，按域名、类型排序
export function discover(root = ROOT) {
  const groups = new Map();
  for (const rel of candidates(root).sort(byName)) {
    const domain = domainOf(rel), kind = NODE_TEST.test(rel) ? 'node' : 'python';
    const id = `${domain}:${kind}`;
    if (!groups.has(id)) groups.set(id, { id, domain, kind, files: [] });
    groups.get(id).files.push(rel);
  }
  const testsDir = path.join(root, 'tests');
  const suites = [...groups.values()].sort((a, b) => (a.domain === b.domain ? byName(a.kind, b.kind) : byName(a.domain, b.domain)));
  for (const s of suites) {
    s.config = {}; s.configError = null;
    const cf = path.join(testsDir, s.domain, 'suite.json');
    if (fs.existsSync(cf)) {
      try {
        const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
        if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('顶层必须是对象');
        if (c.requires !== undefined && !(Array.isArray(c.requires) && c.requires.every(x => typeof x === 'string'))) throw new Error('requires 必须是字符串数组');
        for (const k of ['timeoutSec', 'testTimeoutSec', 'concurrency']) if (c[k] !== undefined && !(Number.isInteger(c[k]) && c[k] > 0)) throw new Error(`${k} 必须是正整数`);
        s.config = c;
      } catch (e) { s.configError = `tests/${s.domain}/suite.json 不合法：${e.message}`; }
    }
  }
  return suites;
}

// ───────────────────────── 运行一组 ─────────────────────────

// 解析 node --test 的 TAP 输出：汇总计数 + 失败的测试（名字、位置、失败类型）
export function parseTap(text) {
  const counts = {};
  const failures = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)$/.exec(lines[i]);
    if (m) { counts[m[1]] = +m[2]; continue; }
    const f = /^(\s*)not ok \d+ - (.*?)(\s+# (TODO|SKIP)\b.*)?$/.exec(lines[i]);
    if (!f || f[4] === 'TODO') continue;
    const ind = f[1];
    const info = { name: f[2], location: null, failureType: null, message: null };
    for (let j = i + 1; j < lines.length && lines[j] !== `${ind}  ...`; j++) {
      const l = lines[j].slice(ind.length);
      let k;
      if ((k = /^ {2}location: '(.*)'$/.exec(l))) info.location = k[1];
      else if ((k = /^ {2}failureType: '(.*)'$/.exec(l))) info.failureType = k[1];
      else if ((k = /^ {2}error: (.*)$/.exec(l))) {
        let msg = k[1];
        if (/^[|>]-?$/.test(msg)) msg = (lines[j + 1] || '').trim();
        info.message = msg.replace(/^'(.*)'$/, '$1');
      }
    }
    if (info.failureType !== 'subtestsFailed') failures.push(info);
  }
  return { counts, failures };
}

// Python 侧的驱动：逐个加载测试文件，跑完在 stdout 写一行标记 + JSON。模块名的取法与仓库里各测试写明的用法一致：
//   所在目录是包（有 __init__.py）：按相对仓库根的点分名导入（engine/audio/test_audio.py → engine.audio.test_audio，
//     等同 `python -m unittest discover -s engine/audio -t .`，包内的绝对导入照常工作）；路径里有不能作模块名的目录时，
//     改为从第一个不是包的上级目录起算。
//   不是包：把文件所在目录放进 sys.path，用文件名导入（tools/test_casebook.py → test_casebook，等同 discover -s tools）。
//   重名（两个目录里都有 test_x.py）时第二个改用带路径哈希的名字按文件加载。
const PY_DRIVER = String.raw`
import hashlib, importlib, importlib.util, json, os, sys, traceback, unittest
files = json.loads(os.environ['BEIMING_TEST_FILES'])
root = os.path.abspath(os.environ['BEIMING_TEST_ROOT'])
grep = os.environ.get('BEIMING_TEST_GREP', '')
loader = unittest.TestLoader()
if grep:
    loader.testNamePatterns = ['*%s*' % grep]
suite = unittest.TestSuite()
broken = []
used = set()
if root not in sys.path and '' not in sys.path:
    sys.path.insert(0, root)
def missing_module(exc):
    while exc is not None:
        if isinstance(exc, ModuleNotFoundError) and exc.name:
            return exc.name
        exc = exc.__cause__ or exc.__context__
    return None
def module_name(f):
    d, stem = os.path.dirname(os.path.abspath(f)), os.path.splitext(os.path.basename(f))[0]
    if not os.path.isfile(os.path.join(d, '__init__.py')):
        return stem, d
    parts = os.path.relpath(os.path.abspath(f), root)[:-3].replace(os.sep, '/').split('/')
    if not parts[0].startswith('..') and all(p.isidentifier() for p in parts):
        return '.'.join(parts), root
    dotted = [stem]
    while os.path.isfile(os.path.join(d, '__init__.py')) and os.path.dirname(d) != d:
        dotted.insert(0, os.path.basename(d))
        d = os.path.dirname(d)
    return '.'.join(dotted), d
for f in files:
    name, base = module_name(f)
    if base not in sys.path and not (base == root and '' in sys.path):
        sys.path.insert(0, base)
    stem = name.rsplit('.', 1)[-1]
    try:
        if name in used or (name in sys.modules and '.' not in name):
            name = 'bmtest_' + hashlib.sha1(f.encode('utf-8')).hexdigest()[:10] + '_' + stem
            spec = importlib.util.spec_from_file_location(name, f)
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod
            spec.loader.exec_module(mod)
        else:
            mod = importlib.import_module(name)
        used.add(name)
        suite.addTests(loader.loadTestsFromModule(mod))
    except Exception as e:
        tb = traceback.format_exc()
        broken.append({'name': f, 'location': f, 'message': tb.strip().splitlines()[-1], 'missingModule': missing_module(e)})
        sys.stderr.write('无法加载 %s：\n%s\n' % (f, tb))
r = unittest.TextTestRunner(stream=sys.stderr, verbosity=2).run(suite)
def entry(pair):
    test, tb = pair
    lines = [x for x in tb.strip().splitlines() if x.strip()]
    last = lines[-1] if lines else ''
    miss = None
    if last.startswith('ModuleNotFoundError:') and "'" in last:
        miss = last.split("'")[1]
    return {'name': test.id(), 'location': None, 'message': last, 'missingModule': miss}
failed = [entry(p) for p in r.failures] + [entry(p) for p in r.errors] + \
    [{'name': t.id(), 'location': None, 'message': 'unexpected success', 'missingModule': None} for t in r.unexpectedSuccesses]
res = {'tests': r.testsRun, 'failed': len(failed), 'skipped': len(r.skipped), 'broken': len(broken),
       'failures': failed + broken}
sys.stdout.write('\n@@BEIMING-UNITTEST@@' + json.dumps(res, ensure_ascii=False) + '\n')
sys.stdout.flush()
ok = r.wasSuccessful() and not broken
sys.exit(0 if ok and r.testsRun else (5 if ok else 1))
`;

async function runNodeSuite(s, ctx) {
  const c = s.config;
  const args = ['--test', '--test-reporter=spec', '--test-reporter-destination=stderr', '--test-reporter=tap', '--test-reporter-destination=stdout'];
  if (ctx.grep) args.push(`--test-name-pattern=${ctx.grep}`);
  if (c.concurrency) args.push(`--test-concurrency=${c.concurrency}`);
  if (c.testTimeoutSec) args.push(`--test-timeout=${c.testTimeoutSec * 1000}`);
  args.push(...s.files.map(f => f.split('/').join(path.sep)));
  // 本入口自己也可能是在某个 node --test 里被调起的（tests/ci 就是）：去掉测试运行器给子进程设的 NODE_TEST_CONTEXT，
  // 否则这里的 node --test 会当自己是子进程，改用内部协议输出，TAP 解析不到任何结果
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = await run(process.execPath, args, { cwd: ctx.root, env, timeoutMs: ctx.timeoutMs(s), stdout: 'capture', stderr: 'inherit' });
  const { counts, failures } = parseTap(r.stdout);
  return {
    code: r.code, timedOut: r.timedOut, leaked: r.leaked, durationMs: r.durationMs, failures, spawnError: r.error,
    counts: { tests: counts.tests ?? 0, pass: counts.pass ?? 0, fail: (counts.fail ?? 0) + (counts.cancelled ?? 0), skipped: counts.skipped ?? 0, todo: counts.todo ?? 0 },
  };
}

async function runPythonSuite(s, ctx) {
  const py = ctx.python();
  const env = pythonEnv({ BEIMING_TEST_FILES: JSON.stringify(s.files.map(f => path.join(ctx.root, f))), BEIMING_TEST_ROOT: ctx.root, BEIMING_TEST_GREP: ctx.grep || '' });
  const r = await run(py.cmd, [...py.pre, '-c', PY_DRIVER], { cwd: ctx.root, env, timeoutMs: ctx.timeoutMs(s), stdout: 'capture', stderr: 'inherit' });
  const MARK = '@@BEIMING-UNITTEST@@';
  const mark = r.stdout.lastIndexOf(MARK);
  let res = null;
  if (mark >= 0) { try { res = JSON.parse(r.stdout.slice(mark + MARK.length).split('\n')[0]); } catch { /* 输出被截断 */ } }
  const pre = mark >= 0 ? r.stdout.slice(0, mark) : r.stdout;
  if (pre.trim()) process.stderr.write(pre);   // 测试自己打到 stdout 的内容，转给人看
  const tests = res?.tests ?? 0, failed = res?.failed ?? 0, skipped = res?.skipped ?? 0, broken = res?.broken ?? 0;
  return {
    code: r.code, timedOut: r.timedOut, leaked: r.leaked, durationMs: r.durationMs, failures: res?.failures || [], spawnError: r.error,
    noTests: r.code === 5,
    counts: { tests, pass: Math.max(0, tests - failed - skipped), fail: failed + broken, skipped, todo: 0 },
  };
}

// ───────────────────────── 缺依赖：区分「环境没装好」与「代码坏了」 ─────────────────────────

// 仓库声明的第三方依赖：npm 包名（package.json）与 Python 导入名（requirements*.txt / .in / .lock）
const PY_IMPORT_ALIAS = { pillow: 'PIL', 'opencv-python': 'cv2', 'opencv-python-headless': 'cv2', 'scikit-image': 'skimage', 'scikit-learn': 'sklearn', pyyaml: 'yaml', 'python-dateutil': 'dateutil' };
export function declaredDeps(root) {
  const npm = new Set(), py = new Set();
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const k of ['dependencies', 'devDependencies', 'optionalDependencies']) for (const n of Object.keys(pj[k] || {})) npm.add(n);
  } catch { /* 没有 package.json */ }
  for (const f of ['requirements.txt', 'requirements.in', 'requirements.lock']) {
    let txt;
    try { txt = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
      if (!m || line.trim().startsWith('-')) continue;
      const n = m[1].toLowerCase().replace(/_/g, '-');
      py.add(PY_IMPORT_ALIAS[n] || n.replace(/[-.]/g, '_'));
    }
  }
  return { npm, py };
}
const npmRoot = spec => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
// 一条失败是不是「仓库声明了、但当前环境没装」的依赖导致的 → 依赖名或 null
export function missingDependency(failure, kind, deps) {
  if (kind === 'python') {
    const top = failure.missingModule ? failure.missingModule.split('.')[0] : null;
    return top && deps.py.has(top) ? top : null;
  }
  const m = /Cannot find (?:package|module) '([^']+)'/.exec(failure.message || '');
  if (!m || /^(\.|\/|[A-Za-z]:[\\/]|file:|node:)/.test(m[1])) return null;
  const pkg = npmRoot(m[1]);
  return deps.npm.has(pkg) ? pkg : null;
}

// ───────────────────────── 主流程 ─────────────────────────

const SPEC = {
  only: { type: 'list' }, skip: { type: 'list' }, require: { type: 'list' }, 'if-present': { type: 'bool' },
  list: { type: 'bool' }, json: { type: 'bool' }, report: { type: 'string' }, timeout: { type: 'int' }, bail: { type: 'bool' },
  grep: { type: 'string' }, python: { type: 'string' }, root: { type: 'string' }, help: { type: 'bool', short: 'h' },
};

export const HELP = `北冥仓库 · 测试总入口（npm test）

用法：node tools/run-tests.mjs [参数]
      npm test -- [参数]

  --only <域,…>        只跑这些域（可重复）。域 = tests/ 下的一级目录名，另有 tools（tools/ 下的测试）
  --skip <域,…>        不跑这些域
  --if-present         --only / --skip 里不存在的域只提示、不报错（CI 里给尚未合入的域用）
  --require <能力,…>   这些能力必须具备，缺了直接 exit 3：python、python:<模块>、browser、ffmpeg、sh、gpu、network
  --list               只列出发现的测试组和是否会跑，不执行
  --grep <文字>        只跑名字含这段文字的测试（node --test-name-pattern / unittest -k）
  --timeout <秒>       每一组的总时限（默认 600；tests/<域>/suite.json 的 timeoutSec 优先于默认值，本参数优先于两者）
  --bail               有一组失败就停，剩下的标为未运行
  --python <解释器>    指定 Python（默认经 tools/env/py.mjs，或依次找 BEIMING_PY、PYTHON、.venv、python3、python、py -3）
  --root <目录>        在另一个检出里发现并运行（给 tests/ci 的夹具用）
  --json               stdout 只输出一个 JSON 对象（附录 C2 信封 + summary、suites）；进度在 stderr
  --report <文件>      另把同一个 JSON 写进文件（CI 上传为工件）
  -h, --help           显示本说明（不做任何其他事）

发现：tests/<域>/**/*.test.{mjs,js,cjs}、tests/<域>/**/test_*.py、tools/**/*.test.{mjs,js,cjs}、tools/**/test_*.py；
      跳过 fixtures/、__fixtures__/、node_modules/、out/、__pycache__/ 与点开头的目录；不进 cases/、films/。
域的要求：tests/<域>/suite.json → {"requires": [...], "timeoutSec": 600, "testTimeoutSec": 120, "concurrency": 1}

退出码：0 通过；1 有失败；2 用法错误；3 环境缺失；4 没发现测试；124 超时；130/143 被中断（已清理子进程）`;

export async function main(argv = process.argv.slice(2)) {
  let opts;
  const started = Date.now();
  const warnings = [];
  const finish = (exitCode, extra = {}, error = null) => {
    const env = envelope({ exitCode, command: 'test', error, warnings, ...extra });
    if (opts?.json) process.stdout.write(JSON.stringify(env, null, 2) + '\n');
    writeReport(opts?.report, env);
    return exitCode;
  };
  try { opts = parseArgs(argv, SPEC); } catch (e) {
    opts = { json: argv.includes('--json') };
    process.stderr.write(`${e.message}\n${e.hint}\n`);
    return finish(e.exitCode, {}, e);
  }
  if (opts.help) { process.stdout.write(HELP + '\n'); return EXIT.OK; }

  const major = +process.versions.node.split('.')[0];
  if (major < 22) {
    const e = new CliError(EXIT.ENV, 'NODE_TOO_OLD', `需要 Node ≥ 22（D09），当前是 v${process.versions.node}`, '装 Node 24（仓库 .nvmrc）后重跑，例如 nvm install 24 && nvm use 24');
    process.stderr.write(`${e.message}\n${e.hint}\n`);
    return finish(e.exitCode, {}, e);
  }

  if (opts.root && !fs.existsSync(path.resolve(opts.root))) { const e = usage(`--root 指向的目录不存在：${opts.root}`); process.stderr.write(e.message + '\n'); return finish(e.exitCode, {}, e); }
  const root = opts.root ? fs.realpathSync(path.resolve(opts.root)) : ROOT;
  let pyMemo;
  const ctx = {
    root, grep: opts.grep,
    python: () => (pyMemo === undefined ? (pyMemo = resolvePython(root, opts.python)) : pyMemo),
    timeoutMs: s => 1000 * (opts.timeout || s.config.timeoutSec || 600),
    deps: declaredDeps(root),
  };

  // 发现与筛选
  let suites = discover(root);
  const domains = [...new Set(suites.map(s => s.domain))];
  for (const [flag, names] of [['only', opts.only], ['skip', opts.skip]]) {
    const unknown = names.filter(n => !domains.includes(n));
    if (!unknown.length) continue;
    const msg = `--${flag} 里的域不存在：${unknown.join('、')}（现有：${domains.join('、') || '无'}）`;
    if (opts['if-present']) warnings.push(msg);
    else { const e = usage(msg, '检查拼写；CI 里给尚未合入的域加 --if-present'); process.stderr.write(e.message + '\n'); return finish(e.exitCode, { domains }, e); }
  }
  if (opts.only.length) suites = suites.filter(s => opts.only.includes(s.domain));
  if (opts.skip.length) suites = suites.filter(s => !opts.skip.includes(s.domain));

  // --require：前置能力检查
  for (const cap of opts.require) {
    const r = probeCapability(cap, ctx);
    if (r.unknown) { const e = usage(r.detail); process.stderr.write(e.message + '\n'); return finish(e.exitCode, {}, e); }
    if (!r.ok) {
      const e = new CliError(EXIT.ENV, 'ENV_MISSING', `要求的能力「${cap}」不具备：${r.detail}`, '按提示装好后重跑；本地只想跑单元测试时去掉 --require');
      process.stderr.write(e.message + '\n');
      return finish(e.exitCode, {}, e);
    }
  }

  // 每组的要求：缺了就整组跳过
  for (const s of suites) {
    s.status = 'pending'; s.skipReason = null;
    if (s.configError) { s.status = 'fail'; s.skipReason = s.configError; continue; }
    const needs = [...(s.config.requires || [])];
    if (s.kind === 'python' && !needs.includes('python')) needs.unshift('python');
    const missing = [];
    for (const cap of needs) {
      const r = probeCapability(cap, ctx);
      if (r.unknown) warnings.push(`tests/${s.domain}/suite.json：${r.detail}`);
      if (!r.ok) missing.push(`${cap}（${r.detail}）`);
    }
    if (missing.length) { s.status = 'skip'; s.skipReason = `缺少 ${missing.join('；')}`; }
  }
  // 选中的 Python 组因为没有解释器而跳过：这是环境缺失，不是可以忽略的跳过
  const pyMissing = suites.filter(s => s.kind === 'python' && s.status === 'skip' && !ctx.python());
  const view = s => ({
    id: s.id, domain: s.domain, kind: s.kind, files: s.files, requires: s.config.requires || [], status: s.status,
    skipReason: s.skipReason, exitCode: s.exitCode ?? null, durationMs: s.durationMs ?? 0, counts: s.counts || null, failures: s.failures || [],
    missingDeps: s.missingDeps || [],
  });

  if (opts.list) {
    const rows = suites.map(s => [s.domain, s.kind === 'node' ? 'Node' : 'Python', String(s.files.length), s.status === 'skip' ? `跳过：${s.skipReason}` : s.status === 'fail' ? `错误：${s.skipReason}` : '会运行']);
    const o = opts.json ? process.stderr : process.stdout;
    o.write(table(['域', '类型', '文件', '状态'], rows) + '\n');
    for (const s of suites) for (const f of s.files) o.write(`  ${s.id}  ${f}\n`);
    o.write(`共 ${suites.length} 组测试（只列出，未运行）\n`);
    return finish(EXIT.OK, { suites: suites.map(view) });
  }

  if (!suites.length) {
    if ((opts.only.length || opts.skip.length) && opts['if-present']) {
      warnings.push('没有匹配的测试组，什么也没跑');
      process.stderr.write('没有匹配的测试组（--if-present），什么也没跑\n');
      return finish(EXIT.OK, { summary: summarize([], started), suites: [] });
    }
    const e = new CliError(EXIT.CONTRACT, 'NO_TESTS', `在 ${path.relative(process.cwd(), root) || '.'} 下没有发现任何测试`, '测试放 tests/<域>/*.test.mjs 或 tests/<域>/test_*.py；fixtures/ 目录不会被发现');
    process.stderr.write(e.message + '\n');
    return finish(e.exitCode, { suites: [] }, e);
  }
  if (pyMissing.length) {
    const e = new CliError(EXIT.ENV, 'PYTHON_MISSING', `有 ${pyMissing.length} 组 Python 测试，但找不到可用的 Python 解释器（试过：${(resolvePython.tried || []).join('、')}）`,
      '装 Python 3.12，或用 --python / BEIMING_PY 指向解释器；只跑 Node 测试时加 --skip 对应的域');
    process.stderr.write(e.message + '\n' + e.hint + '\n');
    return finish(e.exitCode, { suites: suites.map(view) }, e);
  }

  // 运行
  let interrupted = false;
  onSignals(code => {
    interrupted = true;
    for (const s of suites) if (s.status === 'pending' || s.status === 'running') s.status = 'not-run';
    const e = new CliError(code, 'INTERRUPTED', `收到 ${code === EXIT.SIGINT ? 'SIGINT' : 'SIGTERM'}，已结束全部测试进程`, '');
    process.stderr.write(`\n${e.message}\n`);
    finish(code, { summary: summarize(suites, started), suites: suites.map(view) }, e);
  });
  let stop = false;
  for (const s of suites) {
    if (s.status !== 'pending') continue;
    if (stop) { s.status = 'not-run'; continue; }
    s.status = 'running';
    process.stderr.write(`\n▶ ${s.domain}（${s.kind === 'node' ? 'Node' : 'Python'}，${s.files.length} 个文件）\n`);
    const r = s.kind === 'node' ? await runNodeSuite(s, ctx) : await runPythonSuite(s, ctx);
    if (interrupted) return EXIT.SIGINT;
    Object.assign(s, { exitCode: r.code, durationMs: r.durationMs, counts: r.counts, failures: r.failures });
    if (r.timedOut) { s.status = 'timeout'; s.skipReason = `超过 ${ctx.timeoutMs(s) / 1000} 秒没有结束，已结束整棵进程树（可能有没关闭的服务器、子进程或定时器）`; }
    else if (r.spawnError) { s.status = 'fail'; s.skipReason = `启动失败：${r.spawnError.message}`; }
    else if (r.noTests && ctx.grep) s.status = 'pass';   // --grep 在这一组里没匹配到，不算失败
    else if (r.noTests) { s.status = 'fail'; s.skipReason = '有测试文件，但一个测试也没加载到（类要继承 unittest.TestCase，方法名以 test 开头）'; }
    else s.status = r.code === 0 ? 'pass' : 'fail';
    // 失败全是「声明了却没装」的依赖导致的：这是环境问题（exit 3），不是代码坏了
    s.missingDeps = s.status === 'fail' ? [...new Set(s.failures.map(f => missingDependency(f, s.kind, ctx.deps)).filter(Boolean))] : [];
    if (s.missingDeps.length && s.failures.every(f => missingDependency(f, s.kind, ctx.deps))) {
      s.status = 'env';
      s.skipReason = s.kind === 'node'
        ? `缺 npm 依赖 ${s.missingDeps.join('、')}：在仓库根目录运行 npm ci（按 package-lock.json 安装）`
        : `Python 解释器 ${ctx.python()?.label}（${ctx.python()?.version}）缺 ${s.missingDeps.join('、')}：运行 npm run setup，或 <python> -m pip install -r requirements.txt；也可以用 BEIMING_PY / PYTHON 指向已经装好 requirements 的解释器`;
    }
    if (r.leaked) warnings.push(`${s.id} 结束后进程组里还有残留进程（已强制结束）：检查测试里启动的浏览器、服务器、子进程有没有关闭`);
    if (s.status !== 'pass' && opts.bail) stop = true;
  }

  // 汇总与退出码
  const summary = summarize(suites, started);
  const timedOut = suites.filter(s => s.status === 'timeout'), failed = suites.filter(s => s.status === 'fail');
  const envBad = suites.filter(s => s.status === 'env');
  const skipped = suites.filter(s => s.status === 'skip');
  for (const s of skipped) warnings.push(`${s.id} 已跳过：${s.skipReason}`);
  const exitCode = envBad.length ? EXIT.ENV : timedOut.length ? EXIT.TIMEOUT : failed.length ? EXIT.FAIL : EXIT.OK;
  const bad = [...envBad, ...timedOut, ...failed];
  const error = exitCode === EXIT.OK ? null
    : new CliError(exitCode, envBad.length ? 'DEPS_MISSING' : timedOut.length ? 'TIMEOUT' : 'TESTS_FAILED',
      `${bad.map(s => s.id).join('、')} 未通过（失败 ${summary.fail} 项${envBad.length ? `；其中 ${envBad.map(s => `${s.id} 缺 ${s.missingDeps.join('、')}`).join('，')}` : ''}）`,
      envBad.length ? envBad[0].skipReason
        : '看上面 stderr 里 ✖ 开头的测试；单独重跑：node tools/run-tests.mjs --only <域> --grep <测试名>');

  printHuman(suites, summary, opts);
  reportActions(suites, summary, root);
  return finish(exitCode, { summary, suites: suites.map(view) }, error);
}

function summarize(suites, started) {
  const sum = { suites: suites.length, ran: 0, skippedSuites: 0, tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0, durationMs: Date.now() - started };
  for (const s of suites) {
    if (s.status === 'skip') sum.skippedSuites++;
    if (s.counts) { sum.ran++; for (const k of ['tests', 'pass', 'fail', 'skipped', 'todo']) sum[k] += s.counts[k] || 0; }
  }
  return sum;
}

export function table(head, rows) {
  const w = head.map((h, i) => Math.max(dw(h), ...rows.map(r => dw(r[i] ?? ''))));
  return [head, ...rows].map(r => '  ' + r.map((c, i) => (i === r.length - 1 ? c : pad(c ?? '', w[i]))).join('  ')).join('\n');
}

const STATUS = { pass: '通过', fail: '失败', env: '缺依赖', skip: '跳过', timeout: '超时', 'not-run': '未运行', pending: '未运行' };
function printHuman(suites, sum, opts) {
  const rows = suites.map(s => [s.domain, s.kind === 'node' ? 'Node' : 'Python', STATUS[s.status] || s.status,
    String(s.counts?.tests ?? '-'), String(s.counts?.pass ?? '-'), String(s.counts?.fail ?? '-'), String(s.counts?.skipped ?? '-'),
    s.durationMs ? fmtSec(s.durationMs) : '-']);
  const out = [`\n测试汇总（tools/run-tests.mjs）`, table(['域', '类型', '结果', '测试', '通过', '失败', '跳过', '用时'], rows)];
  for (const s of suites) {
    if (s.skipReason && s.status !== 'pass') out.push(`  · ${s.id}：${s.skipReason}`);
    for (const f of (s.failures || []).slice(0, 10)) out.push(`  ✗ ${s.id}  ${f.name}${f.location ? `  (${f.location})` : ''}${f.message ? `\n      ${f.message}` : ''}`);
  }
  const bad = suites.filter(s => ['fail', 'timeout', 'env'].includes(s.status)).length;
  out.push(bad ? `✗ ${bad} 组未通过（${sum.tests} 项测试，失败 ${sum.fail}），用时 ${fmtSec(sum.durationMs)}`
    : `✓ ${sum.ran} 组全部通过（${sum.tests} 项测试${sum.skipped ? `，其中 ${sum.skipped} 项跳过` : ''}${sum.skippedSuites ? `；${sum.skippedSuites} 组因环境跳过` : ''}），用时 ${fmtSec(sum.durationMs)}`);
  (opts.json ? process.stderr : process.stdout).write(out.join('\n') + '\n');
}

function reportActions(suites, sum, root) {
  if (!inActions()) return;
  for (const s of suites) {
    if (s.status === 'timeout') annotate('error', s.skipReason, { title: `测试超时：${s.id}` });
    if (s.status === 'skip') annotate('notice', s.skipReason, { title: `测试组跳过：${s.id}` });
    if (s.status === 'env') { annotate('error', s.skipReason, { title: `环境缺依赖：${s.id}` }); continue; }
    for (const f of s.failures || []) {
      const m = f.location && /^(.*):(\d+):(\d+)$/.exec(f.location);
      const file = m ? path.relative(root, m[1]).split(path.sep).join('/') : undefined;
      annotate('error', f.message || f.name, { title: `测试失败：${f.name}`, file, line: m?.[2], col: m?.[3] });
    }
  }
  const rows = suites.map(s => `| ${mdCell(s.domain)} | ${s.kind} | ${STATUS[s.status] || s.status} | ${s.counts?.tests ?? '-'} | ${s.counts?.fail ?? '-'} | ${s.counts?.skipped ?? '-'} | ${s.durationMs ? fmtSec(s.durationMs) : '-'} | ${mdCell(s.skipReason || '')} |`);
  stepSummary([`### 测试（run-tests）：${sum.fail || suites.some(s => ['timeout', 'env', 'fail'].includes(s.status)) ? '未通过' : '通过'}`, '',
    '| 域 | 类型 | 结果 | 测试 | 失败 | 跳过 | 用时 | 说明 |', '|---|---|---|---|---|---|---|---|', ...rows, ''].join('\n'));
}

if (isMain(import.meta.url)) process.exitCode = await main();
