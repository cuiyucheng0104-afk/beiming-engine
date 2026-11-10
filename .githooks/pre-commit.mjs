#!/usr/bin/env node
// 北冥仓库 · 提交前检查（由 .githooks/pre-commit 调用；不走 Claude Code 的工具和人工提交也过这道检查）
// 在提交前拦下会破坏仓库约定的改动。各项读的是什么（这决定了它会不会被与本次提交无关的工作区状态拦下）：
//   - 本文件自己的六项、large、eol：读 git 索引，也就是这次要提交的内容（按路径提交 git commit -- <路径> 时是 git 的临时索引）；
//   - compliance：只扫这次暂存的文件，读暂存的版本；
//   - repo-check（P02 的规范检查）：规则读的是工作区。--staged 只把逐文件的规则缩到暂存的文件上，全仓规则照常看整个工作区，
//     所以未跟踪的草稿目录、没暂存的改动都会被判到。本文件按「发现落在哪个路径上」归属：
//       · 落在工作区里与这次提交不一致的路径上——未跟踪或被 .gitignore 忽略的文件与目录、有未暂存改动的文件
//         （按路径提交时没带上的暂存改动也算）、含有这类路径的目录——降为提示，不阻断；
//       · 落在这次提交改动的路径（或包含它的目录）上、落在工作区与提交一致的路径上、没写路径的发现照常阻断。
//     仍会误拦的情形：一个与提交一致的文件，因为另一个文件在工作区里的未提交状态被判错（例如它引用的文件在工作区删了、
//     删除没暂存）。这时报错末尾列出工作区里与提交不同的路径。根治要靠规范检查在 --staged 时读索引（已向 P02 提请求）。
// 检查项（每项一个 id）：
//   本文件自己判定（不依赖别的工具，毫秒级）：
//     vendor        改了 cases/vendor/ 里的第三方快照（lock.json 逐字节锁定；只有 cases/vendor/README.md 可以改）
//     source        修改或删除 cases/source/ 里已归档的文件（catalog.json 按哈希记录；新增归档放行）
//     films-out     提交 films/<名字>/out/ 下的渲染产物，或 films/ 下的音视频文件（渲染产物永不入库，决定 D10）
//     instructions  新增或改动的 agent 指令文件（AGENTS.md、CLAUDE.md、SKILL.md、.claude/ 配置等）不在白名单
//                   tools/repo-check/rules/agent/instruction-files.json 里
//     bridge        根目录 CLAUDE.md 不是一行 @AGENTS.md，或被删除
//     conflict      文本文件里残留合并冲突标记（<<<<<<< / >>>>>>>）
//   交给仓库里已有的检查工具（同一份实现，不另造；工具不存在时跳过并提示）：
//     large         大文件闸门（D10）            node tools/env/large-files.mjs（P10，读 git 索引）
//     compliance    合规扫描：密钥、本机路径等     node tools/compliance/scan.mjs --staged（P01；退出 4 阻断，3 只提示）
//     eol           索引里没有 CRLF              node tools/repo-check/rules/env/index.mjs --only env.eol（P10）
//     repo-check    仓库规范检查                  node tools/repo-check.mjs --staged（P02；合规与 env 域已在上面跑过，这里不重复）
//   四个工具并行运行；规范检查里「规则自身出错」只提示不阻断（结果不完整，属主修），其余错误按上面的归属阻断或提示。
// 合并提交（有 MERGE_HEAD）：只检查与两个父提交都不同的路径（冲突的解决结果）；合并进来的改动已在来源分支上检查过，
//   工具对这些路径之外的发现降为提示。
// 用法：node .githooks/pre-commit.mjs [--all] [--only <id,…>] [--json] [--help]
//   --all   检查索引里的全部文件，而不只是这次的改动（首次启用或在 CI 里用）
// 退出码（附录 C1）：0 通过；4 有检查不通过（git 中止提交）；2 用法错误；3 找不到 git 或不在 git 仓库里；1 检查自身出错；
//   124 git 子进程超时（默认 60 秒，BEIMING_PRECOMMIT_GIT_TIMEOUT_MS=<毫秒> 可调）。
// 临时放行：BEIMING_PRECOMMIT_ALLOW=<id,…>，只对这一次命令生效，只能由用户本人在 Claude Code 之外的终端里设置：
//   检测到 CLAUDECODE=1（Claude Code 的工具运行的命令都带它）时忽略放行并提示；agent 护栏也拒绝 agent 设置这个变量。
// 启用：npm run setup 会在本仓库设 git config core.hooksPath .githooks（只作用于本仓库，--no-hooks 跳过）；也可以自己执行这条命令。
// 不改全局或系统级 git 配置。只读：不改任何文件。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CliError, defineCommand, isMain, runCli } from '../tools/lib/cli.mjs';
import { isInstructionFile } from '../.claude/hooks/lib/policy.mjs';

const ALLOW_ENV = 'BEIMING_PRECOMMIT_ALLOW';
const GIT_TIMEOUT_ENV = 'BEIMING_PRECOMMIT_GIT_TIMEOUT_MS';
const WHITELIST = 'tools/repo-check/rules/agent/instruction-files.json';
const OWN = ['vendor', 'source', 'films-out', 'instructions', 'bridge', 'conflict'];
const DELEGATED = ['large', 'compliance', 'eol', 'repo-check'];
const CHECKS = [...OWN, ...DELEGATED];
const MEDIA_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.y4m', '.yuv', '.wav', '.aif', '.aiff', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.exr']);
const TEXT_EXT = new Set(['.md', '.txt', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.html', '.htm', '.css', '.py', '.sh', '.bash',
  '.ps1', '.toml', '.yaml', '.yml', '.glsl', '.wgsl', '.wesl', '.svg', '.xml', '.csv', '']);
const TOOL_TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 60_000;
const SHOW_WARN = 10;
const SHOW_DRIFT = 5;

/** 由 Claude Code 的工具运行（Bash / PowerShell 工具给子进程设 CLAUDECODE=1，git 再传给钩子）。 */
export const inAgentSession = env => /^(1|true|yes)$/i.test(String(env?.CLAUDECODE ?? '').trim());

// ───────────────────────── git ─────────────────────────

function gitTimeout(env = process.env) {
  const n = Number(env[GIT_TIMEOUT_ENV]);
  return Number.isInteger(n) && n > 0 ? n : GIT_TIMEOUT_MS;
}

/** 跑一条 git 命令（带超时）。超时抛 timeout.git（退出 124），git 起不来抛 env.git（退出 3），失败抛 failure.git（退出 1）。 */
function spawnGit(cwd, args, { input, encoding = 'utf8', allowFail = false, env = process.env } = {}) {
  const timeout = gitTimeout(env);
  const opts = { cwd, input, timeout, maxBuffer: 1024 * 1024 * 1024, windowsHide: true, env: { ...env, GIT_OPTIONAL_LOCKS: '0' } };
  if (encoding !== 'buffer') opts.encoding = 'utf8';      // 不写 encoding 时 stdout 是 Buffer（读 blob 原始字节用）
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], opts);
  if (r.error?.code === 'ETIMEDOUT') {
    throw new CliError('timeout.git', `git ${args.slice(0, 3).join(' ')} 超过 ${timeout / 1000} 秒没有结束，提交已中止`,
      `看看是不是有别的 git 进程占着仓库（例如残留的 .git/index.lock）；仓库很大或磁盘很慢时设 ${GIT_TIMEOUT_ENV}=<毫秒> 调大后重试`);
  }
  if (r.error) throw new CliError('env.git', `运行 git 失败：${r.error.message}`, '先装好 git，并确认它在 PATH 里');
  if (r.status !== 0 && !allowFail) {
    const msg = Buffer.isBuffer(r.stderr) ? r.stderr.toString('utf8') : String(r.stderr ?? '');
    throw new CliError('failure.git', `git ${args.slice(0, 3).join(' ')} 失败：${msg.trim()}`, '把这行报错交给维护者');
  }
  return r;
}

const git = (root, args, opts) => spawnGit(root, args, opts);
const verify = (root, ref) => git(root, ['rev-parse', '--verify', '-q', ref], { allowFail: true }).status === 0;
const splitZ = s => String(s ?? '').split('\0').filter(Boolean);

function nameStatus(root, base) {
  const r = git(root, ['diff', '--cached', '--name-status', '-z', '--no-renames', '--no-ext-diff', base]);
  const parts = r.stdout.split('\0');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!parts[i]) break;
    out.push({ status: parts[i][0], path: parts[i + 1] });
  }
  return out;
}

/** 这次提交引入的改动 [{ status, path }]（status：A/C/D/M/T/U；改名拆成 D + A）。合并提交只留与两个父提交都不同的路径。 */
function stagedChanges(root, all) {
  if (all) return { changes: splitZ(git(root, ['ls-files', '-z', '--cached']).stdout).map(p => ({ status: 'A', path: p })), merge: false };
  const base = verify(root, 'HEAD') ? 'HEAD' : git(root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' }).stdout.trim();
  const changes = nameStatus(root, base);
  if (base !== 'HEAD' || !verify(root, 'MERGE_HEAD')) return { changes, merge: false };
  const other = new Set(nameStatus(root, 'MERGE_HEAD').map(c => c.path));
  return { changes: changes.filter(c => other.has(c.path)), merge: true };
}

/** 路径集合的全部上级目录（'a/b/c' → 'a/b'、'a'）。 */
function dirsOf(paths) {
  const dirs = new Set();
  for (const p of paths) {
    let i = p.lastIndexOf('/');
    while (i > 0) {
      const d = p.slice(0, i);
      if (dirs.has(d)) break;              // 更上级的目录在加入 d 时已经加过
      dirs.add(d);
      i = p.lastIndexOf('/', i - 1);
    }
  }
  return dirs;
}

/**
 * 工作区与这次要提交的内容（git 索引；按路径提交时是 git 的临时索引）不一致的地方。
 * repo-check 的规则读工作区：落在这些路径上的发现说的是工作区，不是这次提交。
 */
function worktreeDrift(root) {
  const index = splitZ(git(root, ['ls-files', '-z', '--cached']).stdout);
  const modified = splitZ(git(root, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff']).stdout);   // 已跟踪：工作区 ≠ 索引（含未暂存的删除）
  const untracked = splitZ(git(root, ['ls-files', '-z', '--others', '--exclude-standard']).stdout);
  return {
    index: new Set(index), indexDirs: dirsOf(index),
    modified: new Set(modified), untracked: new Set(untracked), driftDirs: dirsOf([...modified, ...untracked]),
    sample: [...modified, ...untracked],
  };
}

/**
 * 一条规范检查发现归到哪里：commit（落在这次提交改动的路径或包含它的目录）、commit-state（与提交一致的路径，或没写路径）、
 * worktree（只在工作区、不在这次提交里：未跟踪、被忽略、有未暂存的改动，或含有这类路径的目录）。worktree 时附原因。
 */
function attribute(file, { root, commitPaths, commitDirs, drift }) {
  const f = String(file ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!f || f === '.') return { kind: 'commit-state' };
  if (commitPaths.has(f) || commitDirs.has(f)) return { kind: 'commit' };
  if (drift.untracked.has(f)) return { kind: 'worktree', why: '未跟踪的文件' };
  if (drift.modified.has(f)) return { kind: 'worktree', why: drift.index.has(f) && !fs.existsSync(path.join(root, ...f.split('/'))) ? '工作区里删了、删除没有暂存' : '有没暂存进这次提交的改动' };
  if (drift.driftDirs.has(f)) return { kind: 'worktree', why: '目录里有未跟踪或没暂存进这次提交的改动' };
  if (!drift.index.has(f) && !drift.indexDirs.has(f) && fs.existsSync(path.join(root, ...f.split('/')))) return { kind: 'worktree', why: '未跟踪或被 .gitignore 忽略' };
  return { kind: 'commit-state' };
}

/** 索引里这些路径的 { mode, sha }。 */
function indexEntries(root, paths) {
  const map = new Map();
  if (!paths.length) return map;
  const want = new Set(paths);
  for (const rec of git(root, ['ls-files', '-s', '-z', '--cached']).stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, sha, stage] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    if (want.has(p) && stage === '0') map.set(p, { mode, sha });
  }
  return map;
}

function blobSizes(root, shas) {
  const sizes = new Map();
  const uniq = [...new Set(shas)];
  if (!uniq.length) return sizes;
  const r = git(root, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: uniq.join('\n') + '\n' });
  for (const line of r.stdout.split('\n')) {
    const [sha, size] = line.trim().split(' ');
    if (sha && /^\d+$/.test(size ?? '')) sizes.set(sha, Number(size));
  }
  return sizes;
}

function blobContents(root, shas) {
  const contents = new Map();
  const uniq = [...new Set(shas)];
  if (!uniq.length) return contents;
  const buf = git(root, ['cat-file', '--batch'], { input: uniq.join('\n') + '\n', encoding: 'buffer' }).stdout;
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString('utf8').split(' ');
    pos = nl + 1;
    if (header[1] === 'missing') continue;
    const size = Number(header[2]);
    contents.set(header[0], buf.subarray(pos, pos + size));
    pos += size + 1;
  }
  return contents;
}

/** 白名单：优先读索引里（这次要提交的）版本，没有时读工作区。读不到返回 null。 */
function loadWhitelist(root) {
  const r = git(root, ['show', `:${WHITELIST}`], { allowFail: true });
  let text = r.status === 0 ? r.stdout : null;
  if (text === null) { try { text = fs.readFileSync(path.join(root, ...WHITELIST.split('/')), 'utf8'); } catch { return null; } }
  const j = JSON.parse(text);
  return new Set((j.files ?? []).map(f => (typeof f === 'string' ? f : f.path)));
}

/** --all：索引里 cases/vendor/ 的文件必须与 cases/vendor/lock.json 一致（路径集合、Git blob、文件模式）。 */
function checkVendorAgainstLock(root, add, notes) {
  const lockRel = 'cases/vendor/lock.json';
  const r = git(root, ['show', `:${lockRel}`], { allowFail: true });
  if (r.status !== 0) { notes.push(`索引里没有 ${lockRel}，跳过 vendor 核对`); return; }
  let lock;
  try { lock = JSON.parse(r.stdout); } catch (e) { add('vendor', lockRel, `${lockRel} 不是合法 JSON（${e.message}）：从版本库恢复它`); return; }
  const expected = new Map();
  for (const repo of lock.repositories ?? []) {
    const base = `cases/${String(repo.path ?? '').replace(/^\/+|\/+$/g, '')}/`;
    for (const f of repo.files ?? []) expected.set(base + f.path, { blob: f.gitBlob, mode: f.mode });
  }
  const seen = new Set();
  const extra = [];
  const changed = [];
  for (const rec of git(root, ['ls-files', '-s', '-z', '--', 'cases/vendor']).stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, sha] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    if (p === 'cases/vendor/README.md' || p === lockRel) continue;
    const e = expected.get(p);
    if (!e) { extra.push(p); continue; }
    seen.add(p);
    if (e.blob !== sha || (e.mode && e.mode !== mode)) changed.push(p);
  }
  const missing = [...expected.keys()].filter(p => !seen.has(p));
  const show = list => list.slice(0, 10).join('、') + (list.length > 10 ? ` 等 ${list.length} 个` : '');
  const hint = '恢复：git restore --staged --worktree -- cases/vendor（会丢弃 vendor 下未提交的改动）';
  if (extra.length) add('vendor', 'cases/vendor', `索引里有 ${extra.length} 个不在 ${lockRel} 里的快照文件：${show(extra)}。快照只读，作品放 films/<名字>/；${hint}`);
  if (changed.length) add('vendor', 'cases/vendor', `${changed.length} 个快照文件的内容或模式与 ${lockRel} 不一致：${show(changed)}。${hint}`);
  if (missing.length) add('vendor', 'cases/vendor', `${lockRel} 登记的 ${missing.length} 个快照文件不在索引里：${show(missing)}。${hint}`);
}

const isText = p => TEXT_EXT.has(path.posix.extname(p).toLowerCase()) && !/\.min\.js$/.test(p);

// ───────────────────────── 本文件自己的检查 ─────────────────────────

function ownChecks(root, { all, changes, want }) {
  const findings = [];
  const notes = [];
  const add = (check, file, message) => findings.push({ rule: `precommit.${check}`, level: 'error', file, message });
  const present = changes.filter(c => c.status !== 'D');
  const entries = indexEntries(root, present.map(c => c.path));
  const files = present.map(c => ({ ...c, ...(entries.get(c.path) ?? {}) })).filter(f => f.sha && f.mode !== '160000');
  const sizes = blobSizes(root, files.map(f => f.sha));

  if (all && want('vendor')) checkVendorAgainstLock(root, add, notes);
  if (all && want('source')) notes.push('--all 没有可比的基线，跳过 source（归档完整性用 python3 tools/casebook.py check 核对）');
  if (!all) {
    for (const c of changes) {
      const p = c.path;
      if (want('vendor') && p.startsWith('cases/vendor/') && p !== 'cases/vendor/README.md') {
        add('vendor', p, `${c.status === 'D' ? '删除' : '改动'}了第三方快照里的 ${p}：cases/vendor/ 由 cases/vendor/lock.json 逐字节锁定，只读。撤回暂存：git restore --staged -- "${p}"；作品放 films/<名字>/。维护者确实在升级快照（重新固定版本并更新 lock.json）时，由用户本人在 Claude Code 之外的终端里用 ${ALLOW_ENV}=vendor 只放行这一次（agent 会话里设置无效）`);
      }
      if (want('source') && p.startsWith('cases/source/') && c.status !== 'A') {
        add('source', p, `${c.status === 'D' ? '删除' : '修改'}了已归档的 ${p}：cases/catalog.json 按哈希记录归档文件，改了 casebook check 会失败。撤回暂存：git restore --staged -- "${p}"；要改历史作品先 python3 tools/casebook.py restore <id> --out out/casebook 还原到 out/ 再改`);
      }
      if (want('bridge') && p === 'CLAUDE.md' && c.status === 'D') {
        add('bridge', p, '删除了根目录 CLAUDE.md：只认 CLAUDE.md 的工具会拿不到本仓库规则。恢复：git restore --staged --worktree -- CLAUDE.md');
      }
    }
  }

  const contentWanted = [];
  const instruction = [];
  for (const f of files) {
    const p = f.path;
    const ext = path.posix.extname(p).toLowerCase();
    if (want('films-out') && /^films\/[^/]+\/out(\/|$)/.test(p)) {
      add('films-out', p, `${p} 在作品的 out/ 目录里：渲染产物永不入库（决定 D10）。撤回暂存：git restore --staged -- "${p}"；成片走 Release 或对象存储`);
    } else if (want('films-out') && p.startsWith('films/') && MEDIA_EXT.has(ext)) {
      add('films-out', p, `${p} 是音视频文件：作品目录只提交源码、作品描述和小体量的源素材，成片、混音、帧序列不入库（D10）。撤回暂存：git restore --staged -- "${p}"`);
    }
    if (want('instructions') && isInstructionFile(p)) instruction.push(p);
    const size = sizes.get(f.sha) ?? 0;
    if (f.mode !== '120000' && size <= 2 * 1024 * 1024 && (isText(p) || p === 'CLAUDE.md')
      && !p.startsWith('cases/vendor/') && !p.startsWith('cases/source/')) contentWanted.push(f);
  }

  if (instruction.length) {
    let wl = null;
    try { wl = loadWhitelist(root); } catch (e) { add('instructions', WHITELIST, `白名单 ${WHITELIST} 不是合法 JSON（${e.message}）：修好再提交`); }
    if (wl === null && !findings.some(f => f.file === WHITELIST)) notes.push(`没有找到 ${WHITELIST}，跳过指令文件白名单核对`);
    for (const p of instruction) {
      if (wl && !wl.has(p)) {
        add('instructions', p, `${p} 是会被 agent 工具自动加载的指令或配置文件，但不在 ${WHITELIST} 白名单里：本仓库只有根目录 AGENTS.md 一份指令，子目录说明写成 README.md；确需新增（例如仓库 skill），先在白名单登记用途`);
      }
    }
  }

  const contents = blobContents(root, contentWanted.map(f => f.sha));
  for (const f of contentWanted) {
    const buf = contents.get(f.sha);
    if (!buf) continue;
    const text = buf.toString('utf8');
    if (want('bridge') && f.path === 'CLAUDE.md') {
      const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (lines.length !== 1 || lines[0] !== '@AGENTS.md') add('bridge', f.path, 'CLAUDE.md 只能是一行 @AGENTS.md：规则只写在 AGENTS.md，不在 CLAUDE.md 另起一套');
    }
    if (want('conflict') && /^<{7} /m.test(text) && /^>{7} /m.test(text)) {
      add('conflict', f.path, `${f.path} 里残留合并冲突标记（<<<<<<< / >>>>>>>）：解决冲突后再提交`);
    }
  }
  return { findings, notes };
}

// ───────────────────────── 交给已有工具的检查 ─────────────────────────

/** 运行仓库里的一个 Node 工具（--json），返回 { code, signal, timedOut, stdout, stderr, json, error }。 */
function runTool(root, script, args, { register }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, ...script.split('/')), ...args], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    const unregister = register(() => { try { child.kill(); } catch { /* 已结束 */ } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* 已结束 */ } }, TOOL_TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); unregister(); resolve({ code: null, error: e, stdout, stderr, timedOut }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      unregister();
      let json = null;
      try { json = JSON.parse(stdout); } catch { json = null; }
      resolve({ code, signal, timedOut, stdout, stderr, json });
    });
  });
}

const lastLines = (s, n = 6) => String(s ?? '').trim().split('\n').slice(-n).join('\n');

/** 工具没能给出结论（崩溃、超时、输出不是 JSON、用法错误）时的说明。 */
function toolFailure(id, script, r) {
  const why = r.timedOut ? `超过 ${TOOL_TIMEOUT_MS / 1000} 秒没有结束` : r.error ? `没能启动（${r.error.message}）`
    : r.json === null ? `输出不是 JSON（退出码 ${r.code ?? r.signal}）` : `自身出错（退出码 ${r.code}${r.json?.error ? `：${r.json.error.message}` : ''}）`;
  return `node ${script} ${why}，这次没能完成 ${id} 检查。${r.stderr ? `\n${lastLines(r.stderr)}\n` : ''}把这段输出交给维护者；确认要先提交，请由你本人执行 git commit --no-verify`;
}

const TOOLS = {
  large: {
    script: 'tools/env/large-files.mjs', owner: 'P10',
    args: ({ root }) => ['--json', '--root', root],
    judge(r) {
      if (r.code === 0 && r.json) return { block: [] };
      if (r.code === 4 && r.json) return { block: (r.json.largeFiles?.violations ?? []).map(v => ({ file: v.path, message: `${v.path}：${v.reason}。修复：${v.fix}` })) };
      if (r.code === 3 && r.json) return { warn: [{ message: `大文件检查环境不全：${r.json.error?.message ?? ''}` }] };
      return null;
    },
  },
  compliance: {
    script: 'tools/compliance/scan.mjs', owner: 'P01',
    args: ({ root, all }) => [...(all ? [] : ['--staged']), '--json', '--root', root],
    judge(r) {
      const fs_ = r.json?.result?.findings ?? [];
      const fmt = f => ({ file: f.file, message: `${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.rule}：${f.message}${f.hint ? `。${f.hint}` : ''}`.trim() });
      const warn = fs_.filter(f => !f.blocking && f.zone !== 'archive').map(fmt);
      if (r.code === 0 && r.json) return { block: [], warn };
      if (r.code === 4 && r.json) return { block: fs_.filter(f => f.blocking).map(fmt), warn };
      if (r.code === 3 && r.json) return { warn: [{ message: `合规扫描环境不全（只提示）：${r.json.error?.message ?? ''}${r.json.error?.hint ? `；${r.json.error.hint}` : ''}` }] };
      return null;
    },
  },
  eol: {
    script: 'tools/repo-check/rules/env/index.mjs', owner: 'P10',
    args: ({ root }) => ['--only', 'env.eol', '--json', '--root', root],
    judge(r) {
      const fs_ = (r.json?.results ?? []).flatMap(x => x.findings ?? []);
      const fmt = f => ({ file: f.file, message: `${f.message}${f.fix ? `。修复：${f.fix}` : ''}` });
      if ((r.code === 0 || r.code === 4) && r.json) return { block: fs_.filter(f => f.level === 'error').map(fmt), warn: fs_.filter(f => f.level !== 'error').map(fmt) };
      return null;
    },
  },
  'repo-check': {
    script: 'tools/repo-check.mjs', owner: 'P02',
    judge(r) {
      const fs_ = r.json?.data?.findings ?? [];
      const internal = f => f.rule === 'core.loader' || /^规则自身出错/.test(f.message ?? '');
      const fmt = f => ({ file: f.file, message: `${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.rule}：${f.message}${f.hint ? `。提示：${f.hint}` : ''}`.trim() });
      if (![0, 1, 4].includes(r.code) || !r.json) return r.code === 3 && r.json ? { warn: [{ message: `规范检查需要 git（只提示）：${r.json.error?.message ?? ''}` }] } : null;
      const crash = fs_.filter(f => f.level === 'error' && internal(f));
      return {
        block: fs_.filter(f => f.level === 'error' && !internal(f)).map(fmt),
        warn: [...(crash.length ? [{ message: `规范检查有 ${crash.length} 条规则自身出错，结果不完整（只提示，不阻断）：${crash.slice(0, 3).map(f => `${f.file ?? f.rule} ${f.message}`).join('；')}。报告给对应规则文件的属主` }] : []),
          ...fs_.filter(f => f.level === 'warn' && !f.waived && f.rule !== 'core.waivers').map(fmt)],
      };
    },
  },
};

const exists = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')));
const isCliFile = (root, rel) => { try { return /\bisMain\(/.test(fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')); } catch { return false; } };

/**
 * 规范检查的发现按路径归属（见文件头）：只在工作区、不在这次提交里的降为提示；其余阻断。
 * 阻断的发现落在与提交一致的路径上、而工作区里另有与提交不同的路径时，附上这些路径（可能是它们引起的）。
 */
function scopeRepoCheck(v, { root, all, changes }) {
  const drift = worktreeDrift(root);
  const commitPaths = new Set(all ? [] : changes.map(c => c.path));
  const commitDirs = dirsOf([...commitPaths]);
  const block = [];
  const warn = [];
  const tail = drift.sample.length
    ? `（这条规则按工作区判定；工作区里另有 ${drift.sample.length} 处与这次提交不同：${drift.sample.slice(0, SHOW_DRIFT).join('、')}${drift.sample.length > SHOW_DRIFT ? ' 等' : ''}。如果是它们引起的，把相关改动一并暂存进这次提交，或由用户决定先收起它们（git stash push --keep-index --include-untracked，提交后 git stash pop）再提交）`
    : '';
  for (const f of v.block) {
    const a = attribute(f.file, { root, commitPaths, commitDirs, drift });
    if (a.kind === 'worktree') warn.push({ ...f, message: `（只在工作区、不在这次提交里：${a.why}，不阻断）${f.message}` });
    else block.push(a.kind === 'commit-state' && tail ? { ...f, message: `${f.message}${tail}` } : f);
  }
  return { block, warn: [...warn, ...(v.warn ?? [])] };
}

async function delegatedChecks(root, { all, want, register, introduced, changes }) {
  const results = [];
  const ran = new Set();
  const jobs = [];
  const evaluate = (id, script, r) => {
    let v = TOOLS[id].judge(r);
    if (v === null) return { id, status: 'fail', block: [{ message: toolFailure(id, script, r) }], warn: [] };
    if (id === 'repo-check' && !introduced) v = scopeRepoCheck(v, { root, all, changes });
    let block = v.block ?? [];
    let warn = v.warn ?? [];
    if (introduced) {                     // 合并提交：不是这次合并自己引入的路径，降为提示
      const mine = block.filter(f => f.file && introduced.has(f.file));
      warn = [...block.filter(f => !mine.includes(f)).map(f => ({ ...f, message: `（合并进来的改动，在来源分支上处理）${f.message}` })), ...warn];
      block = mine;
    }
    return { id, status: block.length ? 'fail' : warn.length ? 'warn' : 'pass', block, warn };
  };
  const skip = (id, note) => results.push({ id, status: 'skipped', note, block: [], warn: [] });

  for (const id of ['large', 'compliance', 'eol']) {
    if (!want(id)) continue;
    const t = TOOLS[id];
    if (!exists(root, t.script) || (id === 'eol' && !isCliFile(root, t.script))) { if (id !== 'eol') skip(id, `仓库里没有 ${t.script}，跳过`); continue; }
    ran.add(id);
    jobs.push(runTool(root, t.script, t.args({ root, all }), { register }).then(r => results.push(evaluate(id, t.script, r))));
  }
  if (want('repo-check')) {
    const t = TOOLS['repo-check'];
    if (!exists(root, t.script)) skip('repo-check', `仓库里没有 ${t.script}，跳过`);
    else {
      jobs.push((async () => {
        const list = await runTool(root, t.script, ['--list', '--json', '--root', root], { register });
        const rules = list.json?.data?.rules;
        if (list.code !== 0 || !Array.isArray(rules)) { results.push({ id: 'repo-check', status: 'fail', block: [{ message: toolFailure('repo-check', `${t.script} --list`, list) }], warn: [] }); return; }
        // 合规（compliance）与 env 两个域已由上面的工具直接跑过；env 的命令行入口不在时，用执行器里的 env.eol、env.large-files 代替
        const domains = [...new Set(rules.map(r => r.domain))].filter(d => !(d === 'comp' && ran.has('compliance')) && d !== 'env');
        const envIds = ran.has('eol') ? [] : rules.filter(r => ['env.eol', 'env.large-files'].includes(r.id)).map(r => r.id);
        if (!ran.has('eol') && want('eol')) results.push({ id: 'eol', status: envIds.includes('env.eol') ? 'pass' : 'skipped', note: envIds.includes('env.eol') ? '由规范检查里的 env.eol 规则一并检查' : '仓库里没有 env.eol 的检查入口，跳过', block: [], warn: [] });
        const only = [...domains, ...envIds];
        if (!only.length) { skip('repo-check', '规范检查没有可跑的规则'); return; }
        const r = await runTool(root, t.script, [...(all ? [] : ['--staged']), '--only', only.join(','), '--json', '--root', root], { register });
        results.push(evaluate('repo-check', t.script, r));
      })());
    }
  } else if (want('eol') && !ran.has('eol')) skip('eol', '仓库里没有 env.eol 的检查入口，跳过');
  await Promise.all(jobs);
  return results.sort((a, b) => DELEGATED.indexOf(a.id) - DELEGATED.indexOf(b.id));
}

// ───────────────────────── 命令 ─────────────────────────

async function run(ctx) {
  const only = ctx.opts.only;
  const bad = only.filter(id => !CHECKS.includes(id));
  if (bad.length) throw new CliError('usage.unknown-check', `没有这些检查：${bad.join('、')}`, `可选：${CHECKS.join('、')}`);
  const top = spawnGit(process.cwd(), ['rev-parse', '--show-toplevel'], { allowFail: true, env: ctx.env });
  if (top.status !== 0) throw new CliError('env.not-a-repo', '当前目录不在 git 仓库里', '在仓库根目录里运行');
  const root = top.stdout.trim();
  const allowRaw = String(ctx.env[ALLOW_ENV] ?? '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  let allow = new Set(allowRaw.filter(id => CHECKS.includes(id)));
  for (const id of allowRaw.filter(x => !CHECKS.includes(x))) ctx.warn('allow.unknown', `${ALLOW_ENV} 里的「${id}」不是检查 id，忽略`, `可选：${CHECKS.join('、')}`);
  if (allow.size && inAgentSession(ctx.env)) {
    ctx.warn('allow.ignored', `检测到 CLAUDECODE=1（这次提交由 Claude Code 的工具发起）：${ALLOW_ENV}=${[...allow].join(',')} 不生效，照常检查`,
      '放行只能由用户本人在 Claude Code 之外的终端里设置；agent 按报错修改，确认是误报时告诉用户');
    allow = new Set();
  }
  if (allow.size) ctx.warn('allow.used', `${ALLOW_ENV}=${[...allow].join(',')}：这些检查本次放行`);
  const want = id => (!only.length || only.includes(id)) && !allow.has(id);

  const { changes, merge } = stagedChanges(root, ctx.opts.all);
  const own = ownChecks(root, { all: ctx.opts.all, changes, want });
  const introduced = merge ? new Set(changes.map(c => c.path)) : null;
  const delegated = await delegatedChecks(root, { all: ctx.opts.all, want, register: ctx.onCleanup, introduced, changes });

  const findings = [...own.findings];
  for (const d of delegated) {
    for (const b of d.block) findings.push({ rule: `precommit.${d.id}`, level: 'error', ...(b.file ? { file: b.file } : {}), message: b.message });
    for (const w of d.warn) findings.push({ rule: `precommit.${d.id}`, level: 'warn', ...(w.file ? { file: w.file } : {}), message: w.message });
  }
  for (const n of own.notes) ctx.warn('note', n);
  for (const d of delegated) if (d.note && d.status === 'skipped') ctx.warn(`${d.id}.skipped`, `${d.id}：${d.note}`);
  if (merge) ctx.warn('merge', `合并提交：只检查与两个父提交都不同的 ${changes.length} 个路径（合并进来的改动已在来源分支上检查）`);

  const errors = findings.filter(f => f.level === 'error');
  const warns = findings.filter(f => f.level === 'warn');
  const lines = [];
  const label = f => `[${f.rule.replace('precommit.', '')}]`;
  if (errors.length) {
    lines.push(`北冥 pre-commit：${errors.length} 处不通过（检查了 ${changes.length} 个${ctx.opts.all ? '文件' : '改动'}）`);
    for (const f of errors) lines.push(`  ${label(f)} ${f.message}`);
  }
  if (warns.length) {
    lines.push(`北冥 pre-commit 提示（不阻断）：`);
    for (const f of warns.slice(0, SHOW_WARN)) lines.push(`  ${label(f)} ${f.message}`);
    if (warns.length > SHOW_WARN) lines.push(`  ……另有 ${warns.length - SHOW_WARN} 条提示（--json 看全部）`);
  }
  if (lines.length) ctx.out(lines.join('\n'));
  const checks = [
    ...OWN.map(id => ({ id, status: allow.has(id) ? 'allowed' : !want(id) ? 'skipped' : findings.some(f => f.rule === `precommit.${id}` && f.level === 'error') ? 'fail' : 'pass' })),
    ...DELEGATED.map(id => (allow.has(id) ? { id, status: 'allowed' } : !want(id) ? { id, status: 'skipped' }
      : (({ status, note }) => ({ id, status, ...(note ? { note } : {}) }))(delegated.find(d => d.id === id) ?? { status: 'skipped', note: '没有运行' }))),
  ];
  const data = { root: '.', all: ctx.opts.all, merge, checked: changes.length, checks, findings };
  if (errors.length) {
    return {
      data, exitCode: 4,
      error: { code: 'contract.precommit', message: `${errors.length} 处不通过，提交已中止`, hint: `按每条的说明修改后再提交；说明：node .githooks/pre-commit.mjs --help（与 agent 护栏 .claude/hooks/ 口径一致）` },
    };
  }
  return { data };
}

export const command = defineCommand({
  name: 'pre-commit',
  summary: '北冥仓库提交前检查（只读）：快照不可变、归档不改、产物与大文件不入库、指令文件白名单、合规与规范检查',
  usage: ['node .githooks/pre-commit.mjs [--all] [--only <id,…>] [--json]'],
  description: [
    '本文件自己判定：vendor、source、films-out、instructions、bridge、conflict（读 git 索引，也就是这次要提交的内容）；',
    '交给仓库已有的工具：large（tools/env/large-files.mjs，读索引）、compliance（tools/compliance/scan.mjs --staged，读暂存的版本）、',
    'eol（tools/repo-check/rules/env/index.mjs --only env.eol，读索引）、repo-check（tools/repo-check.mjs --staged）。工具不在时跳过并提示。',
    'repo-check 的规则读的是工作区：发现落在工作区里与这次提交不一致的路径上（未跟踪、被忽略、有没暂存进这次提交的改动，',
    '  或含有这类路径的目录）时降为提示；落在这次提交改动的路径、或工作区与提交一致的路径上的照常阻断。',
    `临时放行：${ALLOW_ENV}=<id,…>，只对这一次命令生效，只能由用户本人在 Claude Code 之外的终端里设置（CLAUDECODE=1 时不生效）。`,
    `git 子进程超时默认 ${GIT_TIMEOUT_MS / 1000} 秒（退出 124），${GIT_TIMEOUT_ENV}=<毫秒> 可调。`,
    '启用：npm run setup 会在本仓库执行 git config core.hooksPath .githooks（只作用于本仓库，setup --no-hooks 跳过）；停用：git config --unset core.hooksPath。',
    'git commit --no-verify 会跳过全部检查，只应由人本人在确认误报时使用。',
  ],
  options: {
    all: { type: 'boolean', describe: '检查索引里的全部文件（默认只看这次暂存的改动）' },
    only: { type: 'list', split: ',', arg: '<id,…>', describe: `只跑这些检查：${CHECKS.join('、')}`, example: 'vendor,films-out' },
  },
  examples: ['node .githooks/pre-commit.mjs', 'node .githooks/pre-commit.mjs --all --only vendor,large', `${ALLOW_ENV}=vendor git commit -m "升级 vendor 快照到 <提交>"   # 用户本人在自己的终端里`],
  exitCodes: { 0: '通过', 1: '检查自身出错', 2: '用法错误', 3: '找不到 git 或不在 git 仓库里', 4: '有检查不通过（git 中止提交）', 124: 'git 子进程超时' },
  run,
});

if (isMain(import.meta.url)) await runCli(command);
