#!/usr/bin/env node
// 北冥仓库 · repo-check 规则（env 域，P10）：换行与二进制约定、大文件闸门、Python 锁文件一致、版本文件、环境变量登记、文档双写法、无本机路径。
//
// 插件接口（给 tools/repo-check 的执行器加载）：
//   export const domain = 'env'
//   export const rules = [{ id, title, severity: 'error'|'warn', run(ctx) → Promise<Finding[]> }]
//     Finding = { level: 'error'|'warn', message, file?, line?, fix? }；level 缺省取规则的 severity
//   export function createContext(root, {staged}) → ctx：{ root, staged, read(rel), exists(rel), git(args), tracked() }
// 单独运行（执行器合入之前，或只想看 env 域）：
//   node tools/repo-check/rules/env/index.mjs [--only <规则id>] [--root <目录>] [--json]
//   退出码：0 无 error；1 有 error；2 用法错误。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkLargeFiles } from '../../../env/lib/largefiles.mjs';
import { parseLock, sha256, normalizeName } from '../../../env/lib/lockfile.mjs';

export const domain = 'env';
const HERE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export function createContext(root = HERE_ROOT, { staged = false } = {}) {
  const git = (args, opts = {}) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20, windowsHide: true, ...opts });
    if (r.error || r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${(r.stderr || r.error?.message || '').trim()}`);
    return r.stdout;
  };
  let trackedCache = null;
  return {
    root, staged, git,
    read: rel => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } },
    exists: rel => fs.existsSync(path.join(root, rel)),
    tracked: () => (trackedCache ??= git(['-c', 'core.quotepath=off', 'ls-files', '-z']).split('\0').filter(Boolean)),
  };
}

const spec = ctx => JSON.parse(ctx.read('tools/env/spec.json'));
const ARCHIVE = /^cases\/(source|vendor|licenses)\//;

// ── 1 .gitattributes：用 git check-attr 验证语义，而不是比对文本 ──
async function ruleGitattributes(ctx) {
  if (!ctx.exists('.gitattributes')) return [{ message: '缺少 .gitattributes：Windows 默认 core.autocrlf=true 会把 sh 脚本转成 CRLF（sh 报 set: -: invalid option）、案例库哈希校验失败', fix: '从 P10 的提交恢复 .gitattributes' }];
  const probes = [
    ['x.sh', { text: 'set', eol: 'lf' }], ['x.py', { text: 'set', eol: 'lf' }], ['x.mjs', { text: 'set', eol: 'lf' }], ['x.json', { text: 'set', eol: 'lf' }], ['x.md', { text: 'set', eol: 'lf' }],
    ['x.unknownext', { text: 'auto', eol: 'lf' }], ['x.ps1', { text: 'set', eol: 'crlf' }], ['x.cmd', { text: 'set', eol: 'crlf' }],
    ['x.png', { binary: 'set' }], ['x.mp4', { binary: 'set' }], ['x.wav', { binary: 'set' }], ['x.woff2', { binary: 'set' }], ['x.npz', { binary: 'set' }], ['x.glb', { binary: 'set' }],
    ['cases/source/a/build.sh', { text: 'unset' }], ['cases/vendor/a/x.json', { text: 'unset' }], ['cases/licenses/x.txt', { text: 'unset' }],
  ];
  const out = ctx.git(['check-attr', 'text', 'eol', 'binary', '--', ...probes.map(p => p[0])]);
  const got = {};
  for (const line of out.split('\n')) { const m = /^(.*): (text|eol|binary): (.*)$/.exec(line); if (m) (got[m[1]] ??= {})[m[2]] = m[3]; }
  const f = [];
  for (const [p, want] of probes) for (const [k, v] of Object.entries(want)) {
    if (got[p]?.[k] !== v) f.push({ message: `.gitattributes 对 ${p} 的 ${k} 是 ${got[p]?.[k] ?? '未设'}，应为 ${v}`, file: '.gitattributes', fix: '按文件里的分节恢复规则；归档的 -text 规则要放在最后' });
  }
  return f;
}

// ── 2 索引里不得有 CRLF（归档除外）；工作区 CRLF 只提示 ──
async function ruleEol(ctx) {
  const out = ctx.git(['-c', 'core.quotepath=off', 'ls-files', '--eol', '-z']);
  const f = [];
  for (const rec of out.split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [i, w, attr] = rec.slice(0, tab).trim().split(/\s+/);
    const p = rec.slice(tab + 1);
    if (ARCHIVE.test(p) || /eol=crlf/.test(attr || '')) continue;
    if (i === 'i/crlf' || i === 'i/mixed') f.push({ level: 'error', file: p, message: `${p} 以 ${i.slice(2).toUpperCase()} 换行入库`, fix: `git add --renormalize "${p}"` });
    else if (w === 'w/crlf') f.push({ level: 'warn', file: p, message: `${p} 在本机工作区是 CRLF（入库内容没问题）`, fix: 'git config core.autocrlf false 后重新检出：git rm -r -q --cached . && git reset --hard（先提交或 stash 本地改动）' });
  }
  return f.slice(0, 50);
}

// ── 3 大文件闸门（D10）──
async function ruleLargeFiles(ctx) {
  const s = spec(ctx);
  const r = await checkLargeFiles({ root: ctx.root, threshold: s.storage.largeFileBytes, allowFile: s.storage.allowFile });
  return [
    ...r.violations.map(v => ({ level: 'error', file: v.path, message: `${v.path}：${v.reason}`, fix: v.fix })),
    ...r.stale.map(p => ({ level: 'warn', file: s.storage.allowFile, message: `${s.storage.allowFile} 里的 ${p} 已不在索引中或不再超过阈值`, fix: '删掉这一行' })),
  ];
}

// ── 4 Python 锁文件与输入、版本文件一致（离线可查）──
async function rulePythonLock(ctx) {
  const s = spec(ctx);
  const f = [];
  const input = ctx.read(s.python.input), lockText = ctx.read(s.python.lock);
  if (!input) return [{ message: `缺少 ${s.python.input}` }];
  if (!lockText) return [{ message: `缺少 ${s.python.lock}`, fix: 'node tools/env/lock.mjs' }];
  const lock = parseLock(lockText);
  const want = sha256(fs.readFileSync(path.join(ctx.root, s.python.input)));
  if (lock.header.inputSha256 !== want) f.push({ file: s.python.lock, message: `${s.python.lock} 记录的输入哈希与 ${s.python.input} 不一致：改了依赖却没重新生成锁文件`, fix: 'node tools/env/lock.mjs' });
  if (lock.header.python !== s.python.version) f.push({ file: s.python.lock, message: `锁文件的 Python 是 ${lock.header.python}，应为 ${s.python.version}`, fix: 'node tools/env/lock.mjs' });
  const pins = new Map(lock.pins.map(p => [p.name, p]));
  for (const p of lock.pins) {
    if (p.invalid || !p.version) f.push({ file: s.python.lock, message: `无法识别的锁定行：${p.name}` });
    else if (!p.hashes.length) f.push({ file: s.python.lock, message: `${p.name}==${p.version} 没有哈希`, fix: 'node tools/env/lock.mjs' });
  }
  for (const l of input.split(/\r?\n/).map(x => x.replace(/#.*$/, '').trim()).filter(Boolean)) {
    const n = normalizeName(/^[A-Za-z0-9._-]+/.exec(l)?.[0] || l);
    if (!pins.has(n)) f.push({ file: s.python.lock, message: `顶层依赖 ${n} 不在锁文件里`, fix: 'node tools/env/lock.mjs' });
  }
  const pv = (ctx.read('.python-version') || '').trim();
  if (pv !== s.python.version) f.push({ file: '.python-version', message: `.python-version 是「${pv}」，应为 ${s.python.version}（D09）` });
  const txt = ctx.read('requirements.txt');
  if (txt !== null && !/^-r\s+requirements\.in\s*$/m.test(txt)) f.push({ level: 'warn', file: 'requirements.txt', message: 'requirements.txt 没有引用 requirements.in：两份依赖清单可能各写各的', fix: '只保留一行 -r requirements.in（加说明注释）' });
  return f;
}

// ── 5 版本文件与 spec、package.json 一致 ──
async function ruleVersions(ctx) {
  const s = spec(ctx);
  const f = [];
  const nvmrc = (ctx.read('.nvmrc') || '').trim().replace(/^v/, '');
  if (nvmrc.split('.')[0] !== String(s.node.recommended)) f.push({ file: '.nvmrc', message: `.nvmrc 是「${nvmrc}」，应为 ${s.node.recommended}（D09）` });
  const minMajor = +s.node.min.split('.')[0];
  if (+nvmrc.split('.')[0] < minMajor) f.push({ file: '.nvmrc', message: `.nvmrc（${nvmrc}）低于最低版本 ${s.node.min}` });
  let pkg = {};
  try { pkg = JSON.parse(ctx.read('package.json')); } catch { return [...f, { message: 'package.json 读不出来' }]; }
  const pw = pkg.dependencies?.[s.playwright.package];
  if (pw !== s.playwright.version) f.push({ file: 'package.json', message: `package.json 的 ${s.playwright.package} 是 ${pw ?? '未声明'}，tools/env/spec.json 要求 ${s.playwright.version}（两处一起改，并核对 browsers.json 的 revision）` });
  const eng = pkg.engines?.node;
  if (!eng) f.push({ level: 'warn', file: 'package.json', message: `package.json 没有 engines.node（D09 要求 ">=${minMajor}"）`, fix: `集成者在 package.json 加 "engines": { "node": ">=${minMajor}" }` });
  else if (!new RegExp(`^>=\\s*${minMajor}(\\.0(\\.0)?)?$`).test(eng.trim())) f.push({ level: 'warn', file: 'package.json', message: `engines.node 是「${eng}」，D09 写的是 ">=${minMajor}"` });
  return f;
}

// ── 6 环境变量：代码里读到的 ⊆ spec 登记 = docs/ENVIRONMENT.md 的表 ──
const READ_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g, /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g, /\benv\.([A-Z][A-Z0-9_]{2,})\b/g, /\benv\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g,
  /os\.environ(?:\.get)?\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g, /os\.environ\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g, /os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g, /\$\{([A-Z_][A-Z0-9_]*):-/g,
];
const SCAN = /^(engine|tools|routes|examples|audio|src|lab)\/|^[^/]+\.sh$/;
const CODE_EXT = /\.(mjs|cjs|js|ts|tsx|py|sh)$/;
export function scanEnvReads(ctx) {
  const reads = new Map();
  for (const p of ctx.tracked()) {
    if (!SCAN.test(p) || !CODE_EXT.test(p) || p.startsWith('tools/repo-check/rules/env/')) continue;
    const t = ctx.read(p);
    if (!t) continue;
    for (const re of READ_PATTERNS) for (const m of t.matchAll(re)) { if (!reads.has(m[1])) reads.set(m[1], new Set()); reads.get(m[1]).add(p); }
  }
  return reads;
}
export function docEnvTable(text) {
  const sec = /^## 环境变量\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text || '');
  if (!sec) return null;
  const names = new Map();
  sec[1].split('\n').forEach((l, i) => { const m = /^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|/.exec(l); if (m) names.set(m[1], i); });
  return names;
}
async function ruleEnvVars(ctx) {
  const s = spec(ctx);
  const f = [];
  const registered = new Map(s.envVars.map(v => [v.name, v]));
  const ignore = new Set(s.systemVars);
  const reads = scanEnvReads(ctx);
  for (const [name, files] of reads) {
    if (ignore.has(name) || registered.has(name)) continue;
    f.push({ file: [...files][0], message: `代码读取环境变量 ${name}（${[...files].slice(0, 3).join('、')}），但 tools/env/spec.json 与 docs/ENVIRONMENT.md 没有登记`, fix: '在 spec.json 的 envVars 与 docs/ENVIRONMENT.md「环境变量」表各加一行（作用、默认值、谁读）' });
  }
  const doc = docEnvTable(ctx.read('docs/ENVIRONMENT.md'));
  if (!doc) return [...f, { file: 'docs/ENVIRONMENT.md', message: 'docs/ENVIRONMENT.md 缺少「## 环境变量」表' }];
  for (const name of registered.keys()) if (!doc.has(name)) f.push({ file: 'docs/ENVIRONMENT.md', message: `环境变量 ${name} 在 spec.json 登记了，但 docs/ENVIRONMENT.md 的表里没有` });
  for (const name of doc.keys()) if (!registered.has(name)) f.push({ file: 'docs/ENVIRONMENT.md', message: `docs/ENVIRONMENT.md 的表里有 ${name}，spec.json 没有登记（过期的行？）` });
  for (const v of s.envVars) for (const rb of v.readBy || []) {
    const t = ctx.read(rb);
    if (t === null) f.push({ level: 'warn', file: 'tools/env/spec.json', message: `${v.name} 的 readBy 写了 ${rb}，这个文件不存在` });
    else if (!t.includes(v.name)) f.push({ level: 'warn', file: 'tools/env/spec.json', message: `${v.name} 的 readBy 写了 ${rb}，但文件里没出现这个变量名` });
  }
  return f;
}

// ── 7 env 域文档：设置环境变量的 bash 代码块后面紧跟 PowerShell 写法（两种 shell 写法不同的地方）──
// 「VAR=值 命令」与「export VAR=值」在 PowerShell 与 cmd 里都无效，是 Windows 上照抄失败的头号原因。
const DUAL_DOCS = ['docs/ENVIRONMENT.md', 'docs/RTX工作站.md'];
const SETS_ENV = /^\s*(export\s+[A-Z_][A-Z0-9_]*=|[A-Z_][A-Z0-9_]*=\S*\s+\S)/m;
async function ruleDualShell(ctx) {
  const f = [];
  for (const doc of DUAL_DOCS) {
    const t = ctx.read(doc);
    if (t === null) continue;
    const blocks = [...t.matchAll(/^```(\w*)[^\n]*\n([\s\S]*?)^```\s*$/gm)].map(m => ({ lang: m[1].toLowerCase(), body: m[2], at: t.slice(0, m.index).split('\n').length }));
    blocks.forEach((b, i) => {
      if (!['bash', 'sh', 'shell', 'zsh', ''].includes(b.lang) || !SETS_ENV.test(b.body)) return;
      const next = blocks[i + 1];
      if (!next || !['powershell', 'pwsh', 'ps1'].includes(next.lang)) f.push({ file: doc, line: b.at, message: `${doc}:${b.at} 的代码块用 bash 写法设置环境变量，后面没有对应的 powershell 代码块`, fix: '紧接着补一段 ```powershell 写法（$env:NAME = \'值\'）' });
    });
  }
  return f;
}

// ── 8 env 域文件里不写死本机路径、用户名与内网地址 ──
const HOSTY = [
  [/\/Users\/(?!<|\$|\{)[A-Za-z0-9._-]+\//, '本机用户目录（/Users/<名>/）'], [/[A-Za-z]:\\Users\\(?!<|%)[A-Za-z0-9._-]+\\/i, 'Windows 用户目录'], [/\/home\/(?!<|\$)[a-z0-9._-]+\//, 'Linux 用户目录'],
  [/\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/, '内网地址'],
];
async function ruleNoHostPaths(ctx) {
  const f = [];
  const files = ctx.tracked().filter(p => /^tools\/(env|remote)\//.test(p) || /^tests\/env\//.test(p) || DUAL_DOCS.includes(p));
  for (const extra of ['tools/env/spec.json', ...DUAL_DOCS]) if (!files.includes(extra) && ctx.exists(extra)) files.push(extra);
  for (const p of files) {
    if (p.startsWith('tools/repo-check/rules/env/')) continue;
    const t = ctx.read(p);
    if (!t) continue;
    t.split('\n').forEach((l, i) => { for (const [re, what] of HOSTY) if (re.test(l)) f.push({ file: p, line: i + 1, message: `${p}:${i + 1} 写死了${what}：${l.trim().slice(0, 120)}`, fix: '改成环境变量、参数或 <占位符>' }); });
  }
  return f;
}

// ── 9 npm 脚本：不直接调用 python3 / python / sh（Windows 上不可用），经 tools/env/py.mjs 与 Node 入口 ──
async function ruleNpmScripts(ctx) {
  let pkg = {};
  try { pkg = JSON.parse(ctx.read('package.json')); } catch { return []; }
  const f = [];
  for (const [k, v] of Object.entries(pkg.scripts || {})) {
    if (/(^|&&|\|\||;)\s*python3?\s/.test(v)) f.push({ file: 'package.json', message: `npm 脚本 ${k} 直接调用 python：「${v}」（Windows 上 python3 常是空壳，macOS 上没有 python）`, fix: `改成 node tools/env/py.mjs ${v.replace(/^\s*python3?\s+/, '')}` });
    if (/(^|&&|\|\||;)\s*sh\s/.test(v)) f.push({ file: 'package.json', message: `npm 脚本 ${k} 依赖 sh：「${v}」（Windows PowerShell 下没有 sh）`, fix: '换成 Node 入口（见 P06 tools/film 与 P04 的 Node 版封装）' });
  }
  return f;
}

export const rules = [
  { id: 'env.gitattributes', title: '.gitattributes 换行与二进制规则', severity: 'error', run: ruleGitattributes },
  { id: 'env.eol', title: '索引里没有 CRLF（归档除外）', severity: 'error', run: ruleEol },
  { id: 'env.large-files', title: '大文件闸门（D10）', severity: 'error', run: ruleLargeFiles },
  { id: 'env.python-lock', title: 'Python 锁文件与输入一致', severity: 'error', run: rulePythonLock },
  { id: 'env.versions', title: '版本文件与 spec 一致（D09）', severity: 'error', run: ruleVersions },
  { id: 'env.vars', title: '环境变量都登记且写进 docs/ENVIRONMENT.md', severity: 'error', run: ruleEnvVars },
  { id: 'env.dual-shell', title: '环境文档里设置环境变量的命令同时给 PowerShell 写法', severity: 'error', run: ruleDualShell },
  { id: 'env.no-host-paths', title: '环境与远程工具不写死本机路径和内网地址', severity: 'error', run: ruleNoHostPaths },
  { id: 'env.npm-scripts', title: 'npm 脚本不直接依赖 python / sh', severity: 'warn', run: ruleNpmScripts },
];

export async function runRules(ctx, { only = null } = {}) {
  const results = [];
  for (const r of rules) {
    if (only && !only.includes(r.id)) continue;
    let findings;
    try { findings = await r.run(ctx); } catch (e) { findings = [{ level: 'error', message: `规则自身出错：${e.message}` }]; }
    results.push({ id: r.id, title: r.title, findings: findings.map(x => ({ level: x.level || r.severity, ...x })) });
  }
  return results;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('北冥仓库 · repo-check env 域规则\n用法：node tools/repo-check/rules/env/index.mjs [--only <规则id,…>] [--root <目录>] [--json]\n规则：\n' + rules.map(r => `  ${r.id.padEnd(20)} ${r.severity.padEnd(5)} ${r.title}`).join('\n') + '\n退出码：0 无 error；1 有 error；2 用法错误。\n');
    process.exit(0);
  }
  const known = new Set(['--json', '--only', '--root']);
  const bad = argv.filter((a, i) => a.startsWith('--') && !known.has(a) && !['--only', '--root'].includes(argv[i - 1]));
  if (bad.length) { process.stderr.write(`不认识的参数：${bad.join(' ')}\n`); process.exit(2); }
  const val = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const only = val('--only')?.split(',');
  const ctx = createContext(path.resolve(val('--root') || HERE_ROOT));
  const results = await runRules(ctx, { only });
  const errors = results.flatMap(r => r.findings.filter(f => f.level === 'error'));
  const warns = results.flatMap(r => r.findings.filter(f => f.level === 'warn'));
  if (json) {
    process.stdout.write(JSON.stringify({ ok: errors.length === 0, exitCode: errors.length ? 1 : 0, command: 'check:repo --only env', error: errors.length ? { code: 'rule-failed', message: `${errors.length} 个 error`, hint: errors[0].fix || null } : null, outputs: [], runJson: null, warnings: warns.map(w => w.message), results }) + '\n');
  } else {
    for (const r of results) {
      const e = r.findings.filter(f => f.level === 'error').length, w = r.findings.length - e;
      process.stdout.write(`${e ? 'FAIL' : w ? 'WARN' : 'OK  '}  ${r.id.padEnd(20)} ${r.title}${r.findings.length ? `（${e} error，${w} warn）` : ''}\n`);
      for (const x of r.findings.slice(0, 12)) process.stdout.write(`        ${x.level === 'error' ? '错误' : '提示'}：${x.message}${x.fix ? `\n              修复：${x.fix}` : ''}\n`);
      if (r.findings.length > 12) process.stdout.write(`        ……另有 ${r.findings.length - 12} 条\n`);
    }
  }
  process.exitCode = errors.length ? 1 : 0;
}
