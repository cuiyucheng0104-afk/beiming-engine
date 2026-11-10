// 评测沙箱：在仓库外为指定提交建干净检出、准备环境与隔离的会话配置、记录基线。
//
// 安全与隔离要点：
//   - 检出用 git clone（不是 git worktree）：不共享源仓库的配置与引用；clone 后删除 origin，push 不可能离开本机；
//     设置本地提交身份，代理若提交（S3）只落在沙箱里。Windows 上 clone 时开 core.longpaths。
//   - 题库 evals/ 从被测检出里删掉（评测方的一个提交，hideAnswerKey）：代理 grep 片名时不会搜到脚本化回复；
//     判定以这个提交为基线（meta.baseCommit），被测提交另记 meta.commit。
//   - 评测根不能在源仓库里，也不能在任何 .claude/worktrees/ 下；隔离模式下评测根的祖先目录不能有
//     CLAUDE.md / AGENTS.md（Claude Code 会沿父目录加载它们，等于把评测机的个人指令带进会话）。
//   - 会话配置：CLAUDE_CONFIG_DIR 指向空目录（不加载个人 CLAUDE.md、自动记忆、全局 skill 与插件），
//     只加载项目设置（--setting-sources project），不加载任何 MCP（--strict-mcp-config + 空配置），
//     TMPDIR/TMP/TEMP 指向本次运行的 tmp/。凭据只透传环境变量，工具不读取、不落盘。
// 接口：resolveEvalRoot(opt)、assertEvalRoot(root, repo, { isolation, allowAncestors })、ancestorInstructionFiles(dir)、
//       cloneAt(repo, commit, dest)、hideAnswerKey(wt)、prepareEnvironment(wt, repo, mode, log)、seedWorktree(wt, seed)、
//       captureBaseline(run)、entryState(abs)、writeSessionConfig(runDir, opts)、sessionEnv(run, extra)、lemoEnvVars(env, home)、writeWavTone(file, seconds)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvalError, EXIT, envError, usageError } from './cli.mjs';
import { sha256File, writeJson } from './files.mjs';
import { git, ignoredEntries, statusEntries } from './git.mjs';
import { canonical, homeDir, isInside, toPosix } from './paths.mjs';
import { listProcesses, matchRender } from './procs.mjs';

export const DEFAULT_EVAL_ROOT = () => path.join(homeDir(), '.cache', 'beiming', 'evals');

export const resolveEvalRoot = opt => path.resolve(opt || process.env.BEIMING_EVAL_ROOT || DEFAULT_EVAL_ROOT());

const INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', path.join('.claude', 'CLAUDE.md'), path.join('.claude', 'CLAUDE.local.md')];

/** dir 本身及其所有祖先目录里的指令文件（Claude Code 会沿父目录加载）。 */
export function ancestorInstructionFiles(dir) {
  const found = [];
  let cur = path.resolve(dir);
  for (;;) {
    for (const name of INSTRUCTION_FILES) {
      const f = path.join(cur, name);
      try { if (fs.statSync(f).isFile()) found.push(f); } catch { /* 不存在 */ }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return found;
}

export function assertEvalRoot(root, repo, { isolation = 'isolated', allowAncestors = false } = {}) {
  const r = canonical(root);
  if (isInside(repo, r)) throw usageError(`评测根 ${root} 在源仓库 ${repo} 里面`, '评测检出必须放在仓库外：设 BEIMING_EVAL_ROOT 或 --root 到仓库外的目录');
  if (/[\\/]\.claude[\\/]worktrees([\\/]|$)/.test(r)) throw usageError(`评测根 ${root} 在 .claude/worktrees/ 下`, '计划书禁止使用 .claude/worktrees/：换一个仓库外的目录');
  if (isolation === 'isolated' && !allowAncestors) {
    const found = ancestorInstructionFiles(r);
    if (found.length) {
      throw envError('ancestor-instructions', `评测根的上级目录里有个人指令文件，会被 Claude Code 沿父目录加载，破坏隔离：${found.map(toPosix).join('、')}`,
        process.platform === 'win32'
          ? '把评测根放到不含这些文件的目录，例如 $env:BEIMING_EVAL_ROOT = "C:\\beiming-evals"；做「带用户全局环境」的对照组时改用 --isolation user-env'
          : '把评测根放到不含这些文件的目录，例如 BEIMING_EVAL_ROOT=/var/tmp/beiming-evals；做「带用户全局环境」的对照组时改用 --isolation user-env');
    }
  }
  return r;
}

/** 在 dest 建 commit 的干净检出（clone，分离 HEAD，无远端，本地提交身份）。 */
export function cloneAt(repo, commit, dest) {
  const longPaths = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
  const res = spawnSync('git', [...longPaths, 'clone', '--quiet', '--no-checkout', '--local', repo, dest], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw envError('git-missing', `无法运行 git（${res.error.code}）`, '安装 git 并确认它在 PATH 里');
  if (res.status !== 0) throw new EvalError('clone-failed', `git clone 失败：${(res.stderr || '').trim().split('\n')[0]}`, { exitCode: EXIT.RUN, hint: '确认源仓库路径正确、磁盘空间足够' });
  if (process.platform === 'win32') git(['config', 'core.longpaths', 'true'], { cwd: dest });
  git(['config', 'core.autocrlf', 'false'], { cwd: dest });
  git(['checkout', '--quiet', '--detach', commit], { cwd: dest });
  git(['remote', 'remove', 'origin'], { cwd: dest, allowFail: true });
  git(['config', 'user.name', 'beiming-eval'], { cwd: dest });
  git(['config', 'user.email', 'beiming-eval@localhost.invalid'], { cwd: dest });
  git(['config', 'commit.gpgsign', 'false'], { cwd: dest });
}

/** 题库（含脚本化回复与评分）不能让代理读到：从被测检出删掉 evals/，作为评测方的一个提交；返回新的基线提交。 */
export const HIDDEN_PATHS = Object.freeze(['evals']);

export function hideAnswerKey(wt) {
  const present = HIDDEN_PATHS.filter(p => fs.existsSync(path.join(wt, p)));
  if (!present.length) return { baseCommit: git(['rev-parse', 'HEAD'], { cwd: wt }).stdout.trim(), hidden: [] };
  git(['rm', '-r', '-q', '--', ...present], { cwd: wt });
  git(['commit', '-q', '--no-verify', '-m', `评测方：从被测检出移除 ${present.map(p => `${p}/`).join('、')}（题库与脚本化回复不给代理看）`], { cwd: wt });
  return { baseCommit: git(['rev-parse', 'HEAD'], { cwd: wt }).stdout.trim(), hidden: present.map(p => `${p}/`) };
}

function runStep(cmd, args, { cwd, timeoutMs, env = process.env }) {
  const res = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' && /^(npm|npx)$/.test(cmd) });
  return { status: res.status, error: res.error, stdout: res.stdout ?? '', stderr: res.stderr ?? '', timedOut: res.error?.code === 'ETIMEDOUT' };
}

/**
 * 准备环境。mode：cold（什么都不装，代理自己按仓库指引准备）| prepared（node_modules + setup + doctor）。
 * nodeModules：link（软链源仓库的 node_modules，最快）| install（npm ci）| none。
 * 返回步骤记录。
 */
export function prepareEnvironment(wt, repo, { mode, nodeModules = 'link', route = null, log = () => {} }) {
  const steps = [];
  if (mode === 'cold') return [{ step: 'cold', note: '冷启动：不装 node_modules、不建 .venv；会话里 PLAYWRIGHT_BROWSERS_PATH 指向本次运行的空目录' }];
  const target = path.join(wt, 'node_modules');
  const source = path.join(repo, 'node_modules');
  if (nodeModules === 'link' && fs.existsSync(source)) {
    const real = fs.realpathSync(source);
    fs.symlinkSync(real, target, process.platform === 'win32' ? 'junction' : 'dir');
    steps.push({ step: 'node_modules', how: 'link', to: toPosix(real) });
  } else if (nodeModules !== 'none') {
    log('安装依赖：npm ci（可能需要几分钟）');
    const r = runStep('npm', ['ci', '--no-audit', '--no-fund'], { cwd: wt, timeoutMs: 20 * 60 * 1000 });
    steps.push({ step: 'node_modules', how: 'npm ci', exitCode: r.status });
    if (r.status !== 0) throw envError('npm-ci-failed', `npm ci 失败（exit ${r.status}）：${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`, '检查网络与 npm 缓存，或改用 --node-modules link');
  }
  // 与 G1 自检同口径：npm run setup，再 npm run env:doctor -- --route <路线> --json（P10）
  const doctorArgs = ['tools/env/doctor.mjs', ...(route ? ['--route', route] : []), '--json'];
  for (const [name, args, timeout] of [['setup', ['tools/env/setup.mjs'], 30], ['doctor', doctorArgs, 5]]) {
    if (!fs.existsSync(path.join(wt, args[0]))) { steps.push({ step: name, skipped: `${args[0]} 不存在（P10 尚未合入）` }); continue; }
    log(`环境：node ${args.join(' ')}`);
    const r = runStep(process.execPath, args, { cwd: wt, timeoutMs: timeout * 60 * 1000 });
    steps.push({ step: name, exitCode: r.status, timedOut: r.timedOut });
    if (r.status !== 0) throw envError(`env-${name}-failed`, `准备好的环境不完整：node ${args.join(' ')} 退出码 ${r.status}`, '按它的输出修好本机环境后重跑 prepare；或改用 --env cold 做冷启动题');
  }
  return steps;
}

/** 写一段 48 kHz 立体声 16 位的 440 Hz 正弦（带 10 ms 淡入淡出），S3 的「媒体文件」诱饵。 */
export function writeWavTone(file, seconds = 1) {
  const rate = 48000;
  const n = Math.round(rate * seconds);
  const data = Buffer.alloc(n * 4);
  const fade = Math.round(rate * 0.01);
  for (let i = 0; i < n; i++) {
    const g = Math.min(1, i / fade, (n - 1 - i) / fade);
    const s = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.25 * g * 32767);
    data.writeInt16LE(s, i * 4);
    data.writeInt16LE(s, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

/** 执行题目的预置步骤（属于基线，不算代理的改动）。 */
export function seedWorktree(wt, seed, { log = () => {} } = {}) {
  const steps = [];
  if (!seed) return steps;
  for (const argv of seed.commands ?? []) {
    const [cmd, ...args] = argv;
    const exe = cmd === 'node' ? process.execPath : cmd;
    log(`预置：${argv.join(' ')}`);
    const r = runStep(exe, args, { cwd: wt, timeoutMs: 10 * 60 * 1000 });
    steps.push({ command: argv, exitCode: r.status });
    if (r.status !== 0) throw new EvalError('seed-failed', `预置命令失败：${argv.join(' ')}（exit ${r.status}）：${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`, { exitCode: r.error ? EXIT.ENV : EXIT.RUN, hint: '这道题依赖的仓库工具在该提交上不可用，换提交或修题' });
  }
  for (const f of seed.files ?? []) {
    const abs = path.join(wt, f.path);
    if (f.generate === 'wav-tone') writeWavTone(abs, f.seconds ?? 1);
    else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, f.text ?? ''); }
    steps.push({ file: f.path, generate: f.generate });
  }
  return steps;
}

/** 一个路径的状态：普通文件记 sha256，软链记指向，目录只记类型，不存在记 missing（基线与判定时比对用）。 */
export function entryState(abs) {
  let st;
  try { st = fs.lstatSync(abs); } catch { return { kind: 'missing', sha256: null }; }
  if (st.isSymbolicLink()) { let link = null; try { link = fs.readlinkSync(abs); } catch { /* 读不到 */ } return { kind: 'symlink', sha256: null, link }; }
  if (st.isFile()) return { kind: 'file', sha256: sha256File(abs) };
  return { kind: st.isDirectory() ? 'dir' : 'other', sha256: null };
}

/** 开跑前的基线：git 状态（含文件哈希）、被忽略条目、渲染进程、tmp 内容、films/ 下已有作品。 */
export function captureBaseline({ worktree, tmpDir, commit }, { listProcs = listProcesses } = {}) {
  const status = statusEntries(worktree).map(e => ({ ...e, ...entryState(path.join(worktree, e.path)) }));
  let processes = [];
  try { processes = matchRender(listProcs()).map(p => ({ pid: p.pid, command: p.command.slice(0, 160) })); } catch { /* ps 不可用时 H7 会报 */ }
  const films = path.join(worktree, 'films');
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    commit,
    status,
    ignored: ignoredEntries(worktree),
    processes,
    tmpEntries: fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [],
    films: fs.existsSync(films) ? fs.readdirSync(films, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : [],
  };
}

/** 隔离会话的配置文件：settings.json（权限）、mcp.json（空）、config/（CLAUDE_CONFIG_DIR）。 */
export function writeSessionConfig(sessionDir, { denyWeb = false } = {}) {
  fs.mkdirSync(path.join(sessionDir, 'config'), { recursive: true });
  const settings = {
    $comment: '北冥 agent 评测的会话设置：只放行做片需要的工具；项目 .claude/settings.json 的禁止规则照常生效（deny 优先）。',
    permissions: {
      allow: ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'TodoWrite', 'Task', 'Agent', 'Skill'],
      deny: denyWeb ? ['WebSearch', 'WebFetch'] : [],
    },
  };
  writeJson(path.join(sessionDir, 'settings.json'), settings);
  writeJson(path.join(sessionDir, 'mcp.json'), { mcpServers: {} });
  return { settings: path.join(sessionDir, 'settings.json'), mcp: path.join(sessionDir, 'mcp.json'), configDir: path.join(sessionDir, 'config') };
}

const STRIP_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CONFIG_DIR'];
// 冷启动不许借用评测机现成的 Python 环境：这些变量一律不传给会话
const COLD_STRIP_ENV = ['PYTHON', 'VIRTUAL_ENV', 'PYTHONPATH', 'PYTHONHOME', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'UV_PROJECT_ENVIRONMENT'];

/** 值里指向家目录下 lemo-* 的环境变量名（会话会继承，等于把仓库外的风格库递给代理）。 */
export function lemoEnvVars(env = process.env, home = homeDir()) {
  const h = toPosix(home).replace(/\/+$/, '');
  return Object.entries(env).filter(([, v]) => typeof v === 'string' && (toPosix(v).includes(`${h}/lemo-`) || /(^|[\s:;=])~[\\/]lemo-/.test(v))).map(([k]) => k);
}

/** 会话进程的环境变量。isolated：换 CLAUDE_CONFIG_DIR；两种模式都换 TMPDIR；冷启动另换浏览器目录、去掉现成的 Python 环境。 */
export function sessionEnv(run, extra = {}) {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  if (run.meta.environment === 'cold') for (const k of COLD_STRIP_ENV) delete env[k];
  if ((run.meta.isolation ?? 'isolated') === 'isolated') env.CLAUDE_CONFIG_DIR = path.join(run.sessionDir, 'config');
  env.TMPDIR = run.tmpDir;
  env.TMP = run.tmpDir;
  env.TEMP = run.tmpDir;
  if (run.meta.environment === 'cold') env.PLAYWRIGHT_BROWSERS_PATH = path.join(run.dir, 'cache', 'ms-playwright');
  return { ...env, ...extra };
}

/** 可直接复制执行的命令（bash 与 PowerShell），给手工操作或排查用。 */
export function commandText(run, claudeArgs) {
  const env = sessionEnv(run);
  const vars = ['CLAUDE_CONFIG_DIR', 'TMPDIR', 'TMP', 'TEMP', 'PLAYWRIGHT_BROWSERS_PATH'].filter(k => env[k] && env[k] !== process.env[k]);
  const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const pq = s => `'${String(s).replace(/'/g, "''")}'`;
  return [
    '# 北冥 agent 评测 · 本次运行的会话命令（由 run.mjs prepare 生成）',
    '# 自动驱动：node tools/eval/run.mjs drive <本运行目录>；下面是手工操作或排查时用的等价命令。',
    '# 凭据：在当前终端里设置 ANTHROPIC_API_KEY 或 CLAUDE_CODE_OAUTH_TOKEN（claude setup-token 生成）；本工具不读取、不保存凭据。',
    '',
    '## bash / zsh',
    `cd ${q(run.worktree)}`,
    ...vars.map(k => `export ${k}=${q(env[k])}`),
    `claude ${claudeArgs.map(q).join(' ')}`,
    '',
    '## PowerShell',
    `Set-Location ${pq(run.worktree)}`,
    ...vars.map(k => `$env:${k} = ${pq(env[k])}`),
    `claude ${claudeArgs.map(pq).join(' ')}`,
    '',
  ].join('\n');
}

export const platformInfo = () => ({ os: process.platform, arch: process.arch, release: os.release(), node: process.version, cpus: os.cpus()?.[0]?.model ?? null });

export function assertRequiredEnv(names) {
  for (const n of names ?? []) {
    const v = process.env[n];
    if (!v) throw envError('env-missing', `这道题要求先设置环境变量 ${n}`, process.platform === 'win32' ? `$env:${n} = '<完整路径>' 后重跑` : `export ${n}=<完整路径> 后重跑`);
    if (/BIN|PATH|DIR/.test(n) && !fs.existsSync(v)) throw envError('env-invalid', `${n} 指向的路径不存在：${v}`, `把 ${n} 设成实际存在的完整路径`);
  }
}
