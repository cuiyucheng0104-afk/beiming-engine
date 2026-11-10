#!/usr/bin/env node
// 北冥仓库 · 提交前检查（由 .githooks/pre-commit 调用；不走 Claude Code 的工具和人工提交也过这道检查）
// 做什么：只看暂存区（这次要提交的内容），在提交前拦下会破坏仓库约定的改动。每项检查有一个 id：
//   vendor        改了 cases/vendor/ 里的第三方快照（lock.json 逐字节锁定；只有 cases/vendor/README.md 可以改）
//   source        修改或删除 cases/source/ 里已归档的文件（catalog.json 按哈希记录；新增归档放行）
//   films-out     提交 films/<名字>/out/ 下的渲染产物，或 films/ 下的音视频文件（渲染产物永不入库，决定 D10）
//   large         单个文件大于 5 MiB（D10）；LARGE-FILES.allow 里登记的除外，没有这份清单时沿用 HEAD 里已有的大文件
//   secrets       .env、*.pem、*.key、*.p12、*.pfx、私钥文本等密钥（.env.example 之类的样例放行）
//   instructions  新增或改动的 agent 指令文件（AGENTS.md、CLAUDE.md、SKILL.md、.claude/ 配置等）不在白名单
//                 tools/repo-check/rules/agent/instruction-files.json 里
//   bridge        根目录 CLAUDE.md 不是一行 @AGENTS.md，或被删除
//   crlf          shell 脚本（*.sh、*.bash、.githooks/ 下的钩子）含 CRLF 换行（sh 会报 set: -: invalid option）
//   conflict      文本文件里残留合并冲突标记（<<<<<<< / >>>>>>>）
//   repo-check    tools/repo-check.mjs 支持 --staged 时接着运行它（规则执行器由 P02 提供；不支持时跳过并提示）
// 用法：node .githooks/pre-commit.mjs [--all] [--json] [--only <id,…>] [--help]
//   --all   检查索引里的全部文件，而不只是这次的改动（首次启用或在 CI 里用）
// 退出码：0 通过；4 有检查不通过（git 中止提交）；2 用法错误；3 找不到 git 或不在 git 仓库里；1 检查自身出错。
// 临时放行：BEIMING_PRECOMMIT_ALLOW=<id,…>，只对这一次命令生效（例如升级 vendor 快照：BEIMING_PRECOMMIT_ALLOW=vendor git commit …）。
// 启用由用户决定，本仓库不替你全局启用：在仓库根目录执行 git config core.hooksPath .githooks。
// 只读：不改任何文件，不改 git 配置。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isInstructionFile } from '../.claude/hooks/lib/policy.mjs';

const COMMAND = 'node .githooks/pre-commit.mjs';
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOW_ENV = 'BEIMING_PRECOMMIT_ALLOW';
const WHITELIST = 'tools/repo-check/rules/agent/instruction-files.json';
const LARGE_ALLOW = 'LARGE-FILES.allow';
const CHECKS = ['vendor', 'source', 'films-out', 'large', 'secrets', 'instructions', 'bridge', 'crlf', 'conflict', 'repo-check'];
const MEDIA_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.y4m', '.yuv', '.wav', '.aif', '.aiff', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.exr']);
const TEXT_EXT = new Set(['.md', '.txt', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.html', '.htm', '.css', '.py', '.sh', '.bash',
  '.ps1', '.toml', '.yaml', '.yml', '.glsl', '.wgsl', '.wesl', '.svg', '.xml', '.csv', '']);
const SECRET_NAME = /^(\.env(\..+)?|.+\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|dsa|ecdsa|ed25519))$/i;
const SECRET_SAMPLE = /\.(example|sample|template|dist)$/i;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/;

const HELP = `北冥仓库 · 提交前检查（只读）

用法：${COMMAND} [选项]
  --all          检查索引里的全部文件（默认只看这次暂存的改动）
  --only <id,…>  只跑这些检查：${CHECKS.join('、')}
  --json         stdout 输出一个 JSON 对象（ok、exitCode、command、error、outputs、runJson、warnings、findings）
  --help         显示本说明

检查项：
  vendor        cases/vendor/ 快照不可改（README.md 除外）
  source        cases/source/ 已归档文件不可改、不可删（新增放行）
  films-out     films/<名字>/out/ 与 films/ 下的音视频不提交
  large         单个文件不超过 5 MiB（${LARGE_ALLOW} 登记的除外）
  secrets       不提交 .env、*.pem、*.key、*.p12、私钥
  instructions  agent 指令文件要在 ${WHITELIST} 里登记
  bridge        根目录 CLAUDE.md 只能是一行 @AGENTS.md
  crlf          shell 脚本不含 CRLF
  conflict      没有残留的合并冲突标记
  repo-check    tools/repo-check.mjs 支持 --staged 时接着运行它

退出码：0 通过；4 有检查不通过；2 用法错误；3 找不到 git 或不在仓库里；1 检查自身出错
临时放行：${ALLOW_ENV}=<id,…>（只对这一次命令生效，例如升级 vendor 快照时 ${ALLOW_ENV}=vendor）
启用（由你决定，本仓库不替你全局启用）：git config core.hooksPath .githooks
`;

function out(json, payload) {
  if (json) process.stdout.write(JSON.stringify(payload) + '\n');
}

function envelope({ code, findings = [], warnings = [], error = null }) {
  return { ok: code === 0, exitCode: code, command: COMMAND, error, outputs: [], runJson: null, warnings, findings };
}

function parseArgs(argv) {
  const o = { all: false, json: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--all') o.all = true;
    else if (a === '--json') o.json = true;
    else if (a === '--only') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return { ...o, error: '--only 后面要跟检查 id，逗号分隔' };
      o.only = v.split(',').map(s => s.trim()).filter(Boolean);
      const bad = o.only.filter(id => !CHECKS.includes(id));
      if (bad.length) return { ...o, error: `没有这些检查：${bad.join('、')}；可选：${CHECKS.join('、')}` };
    } else return { ...o, error: `不认识的参数 ${a}` };
  }
  return o;
}

function git(root, args, { input, encoding = 'utf8', allowFail = false } = {}) {
  const opts = { cwd: root, input, maxBuffer: 1024 * 1024 * 1024, windowsHide: true };
  if (encoding !== 'buffer') opts.encoding = 'utf8';      // 不写 encoding 时 stdout 是 Buffer（读 blob 原始字节用）
  const r = spawnSync('git', args, opts);
  if (r.error) throw Object.assign(new Error(`运行 git 失败：${r.error.message}`), { exit: 3 });
  if (r.status !== 0 && !allowFail) {
    const msg = Buffer.isBuffer(r.stderr) ? r.stderr.toString('utf8') : String(r.stderr ?? '');
    throw Object.assign(new Error(`git ${args.slice(0, 3).join(' ')} 失败：${msg.trim()}`), { exit: 1 });
  }
  return r;
}

/** 暂存区相对 HEAD 的改动：[{ status, path }]，status 为 A/C/D/M/T/U 之一（--no-renames 把改名拆成 D + A）。 */
function stagedChanges(root, all) {
  if (all) {
    const r = git(root, ['ls-files', '-z', '--cached']);
    return r.stdout.split('\0').filter(Boolean).map(p => ({ status: 'A', path: p }));
  }
  const hasHead = git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true }).status === 0;
  const base = hasHead ? 'HEAD' : git(root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' }).stdout.trim();
  const r = git(root, ['diff', '--cached', '--name-status', '-z', '--no-renames', '--no-ext-diff', base]);
  const parts = r.stdout.split('\0');
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!parts[i]) break;
    changes.push({ status: parts[i][0], path: parts[i + 1] });
  }
  return changes;
}

/** 索引里这些路径的 { mode, sha }。 */
function indexEntries(root, paths) {
  const map = new Map();
  if (!paths.length) return map;
  const r = git(root, ['ls-files', '-s', '-z', '--cached'], {});
  const want = new Set(paths);
  for (const rec of r.stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, sha, stage] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    if (want.has(p) && stage === '0') map.set(p, { mode, sha });
  }
  return map;
}

/** 一次性取一批 blob 的大小（git cat-file --batch-check）。 */
function blobSizes(root, shas) {
  const sizes = new Map();
  const uniq = [...new Set(shas)];
  if (!uniq.length) return sizes;
  const r = git(root, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: uniq.join('\n') + '\n' });
  for (const line of r.stdout.split('\n')) {
    const [sha, size] = line.trim().split(' ');
    if (sha && size && /^\d+$/.test(size)) sizes.set(sha, Number(size));
  }
  return sizes;
}

/** 一次性读一批 blob 的内容（git cat-file --batch），返回 sha → Buffer。 */
function blobContents(root, shas) {
  const contents = new Map();
  const uniq = [...new Set(shas)];
  if (!uniq.length) return contents;
  const r = git(root, ['cat-file', '--batch'], { input: uniq.join('\n') + '\n', encoding: 'buffer' });
  const buf = r.stdout;
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

function readAllowList(root, file) {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/)
      .map(s => s.replace(/#.*$/, '').trim()).filter(Boolean).map(s => s.replace(/\\/g, '/').replace(/^\.\//, ''));
  } catch { return null; }
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; continue; }
    if (c === '*') { re += '[^/]*'; continue; }
    if (c === '?') { re += '[^/]'; continue; }
    re += /[.+^${}()|[\]\\]/.test(c) ? '\\' + c : c;
  }
  return new RegExp(`^${re}$`);
}

/** 大文件放行表：有 LARGE-FILES.allow 就用它；没有时沿用 HEAD 里已经存在的大文件（决定 D10 的"现有的列入清单"）。 */
function largeAllowed(root) {
  const listed = readAllowList(root, LARGE_ALLOW);
  if (listed) {
    const res = listed.map(globToRegExp);
    return { source: LARGE_ALLOW, test: p => res.some(re => re.test(p)) };
  }
  const r = git(root, ['ls-tree', '-r', '-l', '-z', 'HEAD'], { allowFail: true });
  const grand = new Set();
  if (r.status === 0) {
    for (const rec of r.stdout.split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const size = Number(rec.slice(0, tab).trim().split(/\s+/)[3]);
      if (size > MAX_BYTES) grand.add(rec.slice(tab + 1));
    }
  }
  return { source: `HEAD 里已有的 ${grand.size} 个大文件（还没有 ${LARGE_ALLOW}）`, test: p => grand.has(p) };
}

function loadWhitelist(root) {
  let text = null;
  const r = git(root, ['show', `:${WHITELIST}`], { allowFail: true });
  if (r.status === 0) text = r.stdout;
  else { try { text = fs.readFileSync(path.join(root, WHITELIST), 'utf8'); } catch { text = null; } }
  if (text === null) return null;
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
  const ls = git(root, ['ls-files', '-s', '-z', '--', 'cases/vendor']);
  const seen = new Set();
  const extra = [];
  const changed = [];
  for (const rec of ls.stdout.split('\0')) {
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

const isText = p => TEXT_EXT.has(path.posix.extname(p).toLowerCase()) && !/\.(min\.js)$/.test(p);
const isShell = p => /\.(sh|bash)$/i.test(p) || (/^\.githooks\/[^/]+$/.test(p) && !/\.(md|mjs|js|json)$/i.test(p));

function runChecks(root, { all, only, allow }) {
  const findings = [];
  const notes = [];
  const want = id => (!only || only.includes(id)) && !allow.has(id);
  const add = (check, file, message) => findings.push({ rule: `precommit.${check}`, level: 'error', file, message });
  const changes = stagedChanges(root, all);
  const present = changes.filter(c => c.status !== 'D');
  const entries = indexEntries(root, present.map(c => c.path));
  const files = present.map(c => ({ ...c, ...(entries.get(c.path) ?? {}) })).filter(f => f.sha && f.mode !== '160000');
  const sizes = blobSizes(root, files.map(f => f.sha));
  for (const f of files) f.size = sizes.get(f.sha) ?? 0;

  if (all && want('vendor')) checkVendorAgainstLock(root, add, notes);
  if (all && want('source')) notes.push('--all 模式没有可比的基线，跳过 source（归档完整性用 python3 tools/casebook.py check 核对）');
  for (const c of changes) {
    const p = c.path;
    if (all) break;                               // --all：vendor 按 lock.json 核对（上面），source 跳过
    if (want('vendor') && p.startsWith('cases/vendor/') && p !== 'cases/vendor/README.md') {
      add('vendor', p, `${c.status === 'D' ? '删除' : '改动'}了第三方快照里的 ${p}：cases/vendor/ 由 cases/vendor/lock.json 逐字节锁定，只读。撤回暂存：git restore --staged -- "${p}"；作品放 films/<名字>/。确实在升级快照（重新固定版本并更新 lock.json）时，用 ${ALLOW_ENV}=vendor 只放行这一次`);
    }
    if (want('source') && p.startsWith('cases/source/') && c.status !== 'A') {
      add('source', p, `${c.status === 'D' ? '删除' : '修改'}了已归档的 ${p}：cases/catalog.json 按哈希记录归档文件，改了 casebook check 会失败。撤回暂存：git restore --staged -- "${p}"；要改历史作品先 python3 tools/casebook.py restore <id> --out out/casebook 还原到 out/ 再改`);
    }
    if (want('bridge') && p === 'CLAUDE.md' && c.status === 'D') {
      add('bridge', p, '删除了根目录 CLAUDE.md：只认 CLAUDE.md 的工具会拿不到本仓库规则。恢复：git restore --staged --worktree -- CLAUDE.md');
    }
  }

  const contentWanted = [];
  for (const f of files) {
    const p = f.path;
    const ext = path.posix.extname(p).toLowerCase();
    if (want('films-out') && /^films\/[^/]+\/out(\/|$)/.test(p)) {
      add('films-out', p, `${p} 在作品的 out/ 目录里：渲染产物永不入库（决定 D10）。撤回暂存：git restore --staged -- "${p}"；成片走 Release 或对象存储`);
    } else if (want('films-out') && p.startsWith('films/') && MEDIA_EXT.has(ext)) {
      add('films-out', p, `${p} 是音视频文件：作品目录只提交源码、作品描述和小体量的源素材，成片、混音、帧序列不入库（D10）。撤回暂存：git restore --staged -- "${p}"`);
    }
    if (want('large') && f.size > MAX_BYTES && f.mode !== '120000') {
      f.checkLarge = true;
    }
    const base = p.split('/').pop();
    if (want('secrets') && SECRET_NAME.test(base) && !SECRET_SAMPLE.test(base)) {
      add('secrets', p, `${p} 看起来是密钥或凭据文件（*.key 也可能是 Keynote 文稿，同样不入库）：不入库。撤回暂存：git restore --staged -- "${p}"，并确认它在 .gitignore 里；样例配置请命名为 *.example`);
    }
    if (want('instructions') && isInstructionFile(p)) f.checkInstruction = true;
    if (f.mode !== '120000' && f.size <= 2 * 1024 * 1024 && (isText(p) || isShell(p) || p === 'CLAUDE.md')
      && !p.startsWith('cases/vendor/') && !p.startsWith('cases/source/')) contentWanted.push(f);
  }

  if (files.some(f => f.checkLarge)) {
    const allowed = largeAllowed(root);
    for (const f of files.filter(x => x.checkLarge)) {
      if (!allowed.test(f.path)) {
        add('large', f.path, `${f.path} 有 ${(f.size / 1048576).toFixed(1)} MiB，超过 5 MiB（决定 D10）：大文件放 Release 或对象存储，仓库只存清单（地址、sha256、大小、许可、来源）。撤回暂存：git restore --staged -- "${f.path}"；确属必须入库的现有文件，请维护者登记到 ${LARGE_ALLOW}（当前放行依据：${allowed.source}）`);
      }
    }
  }

  if (files.some(f => f.checkInstruction)) {
    let wl = null;
    try { wl = loadWhitelist(root); } catch (e) { add('instructions', WHITELIST, `白名单 ${WHITELIST} 不是合法 JSON（${e.message}）：修好再提交`); }
    for (const f of files.filter(x => x.checkInstruction)) {
      if (wl && !wl.has(f.path)) {
        add('instructions', f.path, `${f.path} 是会被 agent 工具自动加载的指令或配置文件，但不在 ${WHITELIST} 白名单里：本仓库只有根目录 AGENTS.md 一份指令，子目录说明写成 README.md；确需新增（例如仓库 skill），先在白名单登记用途`);
      } else if (!wl) {
        notes.push(`没有找到 ${WHITELIST}，跳过指令文件白名单核对`);
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
    if (want('crlf') && isShell(f.path) && text.includes('\r\n')) {
      add('crlf', f.path, `${f.path} 含 CRLF 换行：sh 会报 "set: -: invalid option" 之类的错。改回 LF（.gitattributes 已规定 eol=lf），再 git add -- "${f.path}"`);
    }
    if (want('conflict') && /^(<{7} |>{7} )/m.test(text) && /^<{7} /m.test(text) && /^>{7} /m.test(text)) {
      add('conflict', f.path, `${f.path} 里残留合并冲突标记（<<<<<<< / >>>>>>>）：解决冲突后再提交`);
    }
    if (want('secrets') && PRIVATE_KEY.test(text)) {
      add('secrets', f.path, `${f.path} 里有私钥文本（-----BEGIN … PRIVATE KEY-----）：不入库。撤回暂存并把密钥移出仓库；已推送过的密钥要作废重发`);
    }
  }

  if (want('repo-check') && !all) {
    const script = path.join(root, 'tools', 'repo-check.mjs');
    let supports = false;
    try { supports = fs.readFileSync(script, 'utf8').includes('--staged'); } catch { supports = false; }
    if (supports) {
      const r = spawnSync(process.execPath, [script, '--staged'], { cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true });
      if (r.error || r.status !== 0) {
        const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n');
        add('repo-check', 'tools/repo-check.mjs', `node tools/repo-check.mjs --staged 未通过（退出码 ${r.status ?? (r.error ? r.error.message : r.signal)}）：\n${tail}\n按上面的报错修好再提交`);
      }
    } else {
      notes.push('tools/repo-check.mjs 还不支持 --staged，本次跳过规则执行器（其余检查照常）');
    }
  }
  return { findings, notes, checked: changes.length };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(HELP); return 0; }
  if (o.error) {
    process.stderr.write(`用法错误：${o.error}\n运行 ${COMMAND} --help 看用法\n`);
    out(o.json, envelope({ code: 2, error: { code: 'usage', message: o.error, hint: `运行 ${COMMAND} --help` } }));
    return 2;
  }
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  if (top.error || top.status !== 0) {
    const msg = top.error ? `找不到 git（${top.error.message}）` : '当前目录不在 git 仓库里';
    process.stderr.write(`北冥 pre-commit：${msg}。在仓库根目录里运行，或先装好 git\n`);
    out(o.json, envelope({ code: 3, error: { code: 'env', message: msg, hint: '在仓库根目录里运行' } }));
    return 3;
  }
  const root = top.stdout.trim();
  const allow = new Set(String(process.env[ALLOW_ENV] ?? '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean));
  const { findings, notes, checked } = runChecks(root, { all: o.all, only: o.only, allow });
  const log = s => process.stderr.write(s + '\n');
  const warnings = [...new Set(notes)];
  if (allow.size) warnings.push(`${ALLOW_ENV}=${[...allow].join(',')}：这些检查本次放行`);
  for (const w of warnings) log(`北冥 pre-commit 提示：${w}`);
  if (findings.length) {
    log(`北冥 pre-commit：${findings.length} 处不通过，提交已中止（检查了 ${checked} 个${o.all ? "文件" : "改动"}）。`);
    for (const f of findings) log(`  [${f.rule.replace('precommit.', '')}] ${f.message}`);
    log(`说明：${COMMAND} --help；这些规则与 agent 护栏（.claude/hooks/）一致。`);
    out(o.json, envelope({ code: 4, findings, warnings, error: { code: 'check-failed', message: `${findings.length} 处不通过`, hint: '按每条后面的说明修改后再提交' } }));
    return 4;
  }
  if (o.json) out(true, envelope({ code: 0, findings, warnings }));
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  const code = e?.exit ?? 1;
  process.stderr.write(`北冥 pre-commit 检查自身出错：${e?.message ?? e}\n${code === 1 ? '把完整报错交给维护者；确认要先提交，请由你本人执行 git commit --no-verify\n' : ''}`);
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(envelope({ code, error: { code: code === 3 ? 'env' : 'internal', message: String(e?.message ?? e), hint: '把完整报错交给维护者' } })) + '\n');
  process.exitCode = code;
}
