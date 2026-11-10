// 北冥仓库 · 规范检查 · agent 执行层规则（tools/repo-check/rules/agent/）
// 做什么：检查 agent 一侧的机器约束都在、没被削弱：嵌套指令文件与白名单一致、快照里没有作品目录、
//         快照目录里没有 lock.json 之外的文件（含被忽略的，casebook check 看不到这些）、
//         根 CLAUDE.md 只是桥接、.claude/settings.json 的护栏完整、仓库 skill 的引用都有效、检索范围、
//         git 钩子可执行、vendor README 顶部的优先级警示还在。只读，不改任何文件。
// 接口（供 tools/repo-check.mjs 的规则执行器加载，也可单独运行 run.mjs）：
//   export const domain = 'agent'
//   export const rules = [{ id, title, severity: 'error', run(ctx) → Finding[] }]（同时提供 check 别名）
//   export function runAgentRules(ctx, { only }) → Finding[]
//   ctx：仓库根的字符串，或 { root, files?, tracked? }；files 是仓库相对路径（正斜杠），缺省时用 git 列出
//        已跟踪与未忽略的未跟踪文件。Finding = { rule, level: 'error'|'warn', message, file? }。
//   listInstructionFiles(files)、loadWhitelist(root)、isInstructionFile(rel) 给 .githooks/pre-commit.mjs 复用。
// 扫描一律跳过 .claude/worktrees/（本机临时工作树，是另一份检出）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { INSTRUCTION_FILE_NAMES } from '../../../../.claude/hooks/lib/policy.mjs';

export const domain = 'agent';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '..', '..', '..', '..');
export const WHITELIST = 'tools/repo-check/rules/agent/instruction-files.json';
const FOREIGN = '.claude/worktrees/';
const NAMES = new Set(INSTRUCTION_FILE_NAMES.map(n => n.toLowerCase()));
const LOCAL_ONLY = new Set(['.claude/settings.local.json', 'claude.local.md']);   // 个人本地配置：未跟踪时不算

const posix = p => p.split(path.sep).join('/');

/** 会被 agent 工具当成指令或配置自动加载的文件。 */
export function isInstructionFile(rel) {
  const r = rel.replace(/\\/g, '/');
  const base = r.split('/').pop().toLowerCase();
  if (NAMES.has(base)) return true;
  if (/(^|\/)\.claude-plugin\/[^/]+\.json$/i.test(r)) return true;
  if (/(^|\/)\.claude\/(settings(\.local)?\.json|agents\/.+\.md|commands\/.+\.md|rules\/.+|output-styles\/.+\.md)$/i.test(r)) return true;
  if (/(^|\/)\.mcp\.json$/i.test(r)) return true;
  if (/(^|\/)\.cursor\/rules\//i.test(r) || /(^|\/)\.codex\//i.test(r)) return true;
  return false;
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout.toString('utf8');
}

function walk(root, dir = '', out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (['.git', 'node_modules', 'out', '__pycache__', '.venv'].includes(e.name) || (rel + '/').startsWith(FOREIGN)) continue;
    if (e.isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
  return out;
}

/** 列文件：{ tracked, untracked }，都是仓库相对正斜杠路径，已去掉 .claude/worktrees/。 */
export function listRepoFiles(root) {
  const t = git(root, ['ls-files', '-z', '--cached']);
  if (t === null) return { tracked: walk(root), untracked: [], git: false };
  const u = git(root, ['ls-files', '-z', '--others', '--exclude-standard']) ?? '';
  const keep = s => s && !(s + '/').startsWith(FOREIGN) && !s.startsWith(FOREIGN);
  return { tracked: [...new Set(t.split('\0').filter(keep))], untracked: u.split('\0').filter(keep), git: true };
}

export function loadWhitelist(root, text) {
  const raw = text ?? fs.readFileSync(path.join(root, WHITELIST), 'utf8');
  const j = JSON.parse(raw);
  return new Set((j.files ?? []).map(f => (typeof f === 'string' ? f : f.path)));
}

export function listInstructionFiles(files) {
  return files.filter(isInstructionFile);
}

function normCtx(ctx) {
  if (typeof ctx === 'string') return { root: ctx };
  return { ...(ctx ?? {}), root: ctx?.root ?? ctx?.ROOT ?? DEFAULT_ROOT };
}

function filesOf(c) {
  if (Array.isArray(c.files)) return { tracked: c.files, untracked: [] };
  c._files ??= listRepoFiles(c.root);
  return c._files;
}

const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const err = (rule, message, file) => ({ rule, level: 'error', message, ...(file ? { file } : {}) });

// ── 规则 ──

function ruleInstructionFiles(ctx) {
  const c = normCtx(ctx);
  const id = 'agent.instruction-files';
  let wl;
  try { wl = loadWhitelist(c.root); } catch (e) { return [err(id, `白名单 ${WHITELIST} 读不了或不是合法 JSON（${e.message}）：恢复该文件后再跑`, WHITELIST)]; }
  const { tracked, untracked } = filesOf(c);
  const found = new Set([
    ...listInstructionFiles(tracked),
    ...listInstructionFiles(untracked).filter(f => !LOCAL_ONLY.has(f.toLowerCase())),
  ]);
  const out = [];
  for (const f of [...found].sort()) {
    if (!wl.has(f)) out.push(err(id, `${f} 是 agent 指令或配置文件，但不在白名单里：本仓库只有根目录 AGENTS.md 一份指令（CLAUDE.md 只是桥接），子目录说明请写成 README.md；确需新增（例如仓库 skill），在 ${WHITELIST} 登记并写明用途`, f));
  }
  for (const f of [...wl].sort()) {
    if (!found.has(f)) out.push(err(id, `白名单登记了 ${f}，仓库里却没有：文件被删或改名了，同步更新 ${WHITELIST}`, f));
  }
  return out;
}

function ruleVendorFilms(ctx) {
  const c = normCtx(ctx);
  const id = 'agent.vendor-films';
  const out = [];
  const base = path.join(c.root, 'cases', 'vendor');
  if (!fs.existsSync(base)) return out;
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    for (const sub of ['films', 'out']) {
      const rel = `cases/vendor/${e.name}/${sub}`;
      if (fs.existsSync(path.join(base, e.name, sub))) {
        out.push(err(id, `${rel}/ 不该存在：上游指令让 agent 把作品或产物放在库里，但这里是只读快照。它被快照自己的 .gitignore 忽略，git status 看不出，casebook check 也不报（它跳过被忽略的文件）。把里面的东西移到 films/<名字>/（产物在 films/<名字>/out/）后删掉这个目录`, rel));
      }
    }
  }
  return out;
}

const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * 磁盘上快照目录里不在 lock.json 的东西（含被快照自己的 .gitignore 忽略的）。casebook check 会跳过被忽略的文件
 * （tools/casebook.py 的 check_vendor），所以按上游说法建在快照里的 films/、out/、.venv/、node_modules/ 只有这里能发现。
 * 不在 lock 目录树里的目录整体报一次，不往里走（避免扫描巨大的 node_modules）。
 */
function ruleVendorInventory(ctx) {
  const c = normCtx(ctx);
  const id = 'agent.vendor-inventory';
  const lockRel = 'cases/vendor/lock.json';
  const text = read(c.root, lockRel);
  if (text === null) return [];
  let lock;
  try { lock = JSON.parse(text); } catch (e) { return [err(id, `${lockRel} 不是合法 JSON（${e.message}）：从版本库恢复它`, lockRel)]; }
  const out = [];
  for (const repo of lock.repositories ?? []) {
    const base = `cases/${String(repo.path ?? '').replace(/^\/+|\/+$/g, '')}`;
    const abs = path.join(c.root, ...base.split('/'));
    if (!fs.existsSync(abs)) continue;
    const files = new Set((repo.files ?? []).map(f => f.path));
    const dirs = new Set();
    for (const f of files) { const parts = f.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
    const extra = [];
    const walkSnap = (relDir) => {
      let entries;
      try { entries = fs.readdirSync(relDir ? path.join(abs, ...relDir.split('/')) : abs, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const r = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (dirs.has(r)) walkSnap(r);
          else extra.push(`${r}/`);
        } else if (!files.has(r) && !JUNK.has(e.name) && !e.name.startsWith('._')) {
          extra.push(r);
        }
      }
    };
    walkSnap('');
    if (extra.length) {
      const shown = extra.slice(0, 10).map(x => `${base}/${x}`).join('、') + (extra.length > 10 ? ` 等 ${extra.length} 项` : '');
      out.push(err(id, `快照 ${base}/ 里有 ${extra.length} 项不在 ${lockRel} 里：${shown}。快照只读：作品与产物放 films/<名字>/（产物在 films/<名字>/out/），历史作品还原到 out/casebook；把这些东西移出快照后删掉（被快照自己的 .gitignore 忽略的不会出现在 git status 里，casebook check 也不报）`, base));
    }
  }
  return out;
}

function ruleClaudeBridge(ctx) {
  const c = normCtx(ctx);
  const id = 'agent.claude-bridge';
  const text = read(c.root, 'CLAUDE.md');
  if (text === null) return [err(id, '根目录缺 CLAUDE.md：只认 CLAUDE.md 的工具会拿不到本仓库规则。新建 CLAUDE.md，内容只有一行 @AGENTS.md', 'CLAUDE.md')];
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length !== 1 || lines[0] !== '@AGENTS.md') {
    return [err(id, 'CLAUDE.md 只能是一行 @AGENTS.md（与 vendor 相同的桥接写法）：规则只写在 AGENTS.md，不要在 CLAUDE.md 另起一套', 'CLAUDE.md')];
  }
  return [];
}

const REQUIRED_DENY = ['Edit(/cases/vendor/**)', 'Edit(/cases/source/**)', 'Bash(git add -A)', 'Bash(git add .)', 'Bash(git push --force*)', 'Skill(lemo-opuscar:*)'];
const GUARD_SCRIPT = '.claude/hooks/guard.mjs';

function ruleGuardConfig(ctx) {
  const c = normCtx(ctx);
  const id = 'agent.guard-config';
  const file = '.claude/settings.json';
  const text = read(c.root, file);
  if (text === null) return [err(id, `缺 ${file}：仓库级权限与 PreToolUse 钩子都靠它。从版本库恢复该文件`, file)];
  let j;
  try { j = JSON.parse(text); } catch (e) { return [err(id, `${file} 不是合法 JSON（${e.message}）：Claude Code 会整份跳过它，护栏全部失效`, file)]; }
  const out = [];
  const deny = new Set(j?.permissions?.deny ?? []);
  for (const r of REQUIRED_DENY) if (!deny.has(r)) out.push(err(id, `${file} 的 permissions.deny 缺少 ${r}`, file));
  const pre = j?.hooks?.PreToolUse ?? [];
  const guarded = tool => pre.some(m => {
    let re;
    try { re = new RegExp(`^(?:${m.matcher ?? ''})$`); } catch { return false; }
    return re.test(tool) && (m.hooks ?? []).some(h => String(h.command ?? '').includes(GUARD_SCRIPT) || (h.args ?? []).some(a => String(a).includes(GUARD_SCRIPT)));
  });
  for (const tool of ['Write', 'Edit', 'Bash', 'PowerShell', 'Skill']) {
    if (!guarded(tool)) out.push(err(id, `${file} 的 hooks.PreToolUse 没有让 ${tool} 经过 ${GUARD_SCRIPT}`, file));
  }
  if (!exists(c.root, GUARD_SCRIPT)) out.push(err(id, `钩子脚本 ${GUARD_SCRIPT} 不存在：每次工具调用都会报钩子错误且护栏失效`, GUARD_SCRIPT));
  if (j?.enabledPlugins?.['lemo-opuscar@lemolab'] !== false) out.push(err(id, `${file} 应在 enabledPlugins 里把 lemo-opuscar@lemolab 设为 false（全局风格库插件会抢先触发，把作品带出仓库）`, file));
  const ex = j?.claudeMdExcludes ?? [];
  for (const dir of ['cases/vendor', 'cases/source']) {
    if (!ex.some(p => String(p).includes(dir))) out.push(err(id, `${file} 的 claudeMdExcludes 没有覆盖 ${dir}：读那里的文件时，上游 CLAUDE.md / AGENTS.md 会被自动当成指令加载`, file));
  }
  return out;
}

const PATH_HEADS = ['routes/', 'docs/', 'tools/', 'engine/', 'cases/', 'src/', 'media/', 'tests/', '.claude/', 'lab/', 'examples/', 'fonts/', 'assets/', 'audio/'];
const ROOT_FILES = new Set(['AGENTS.md', 'README.md', 'ROUTES.md', 'THIRD-PARTY.md', 'LICENSE', 'CLAUDE.md', 'package.json']);

function ruleSkills(ctx) {
  const c = normCtx(ctx);
  const id = 'agent.skills';
  const out = [];
  const dir = path.join(c.root, '.claude', 'skills');
  if (!fs.existsSync(dir)) return [err(id, '缺 .claude/skills/：仓库自带的做片入口 skill（beiming-film）不在了', '.claude/skills')];
  const names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  if (!names.includes('beiming-film')) out.push(err(id, '缺 .claude/skills/beiming-film/SKILL.md：在本仓库做片的入口 skill', '.claude/skills/beiming-film'));
  for (const n of names) {
    const rel = `.claude/skills/${n}/SKILL.md`;
    const text = read(c.root, rel);
    if (text === null) { out.push(err(id, `${rel} 不存在：skill 目录里必须有 SKILL.md`, rel)); continue; }
    const fm = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) { out.push(err(id, `${rel} 缺 YAML 头（--- name / description ---）`, rel)); continue; }
    const name = fm[1].match(/^name:\s*(.+)$/m)?.[1].trim();
    const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1].trim() ?? '';
    if (name !== n) out.push(err(id, `${rel} 的 name 是「${name ?? '（缺）'}」，应与目录名 ${n} 相同`, rel));
    if (desc.length < 20) out.push(err(id, `${rel} 的 description 太短：要写清在本仓库里什么时候触发`, rel));
    const body = text.slice(fm[0].length);
    const seen = new Set();
    for (const m of body.matchAll(/`([^`\n]+)`/g)) {
      let p = m[1].trim().replace(/[，。；：、）)]+$/, '').replace(/#.*$/, '');
      if (!PATH_HEADS.some(h => p.startsWith(h)) && !ROOT_FILES.has(p)) continue;
      if (/[<>*{}|$\s]/.test(p) || p.includes('…')) continue;
      p = p.replace(/\/+$/, '');
      if (seen.has(p)) continue;
      seen.add(p);
      if (!exists(c.root, p)) out.push(err(id, `${rel} 引用的 ${p} 不存在：改了仓库结构就同步改 skill`, rel));
    }
  }
  return out;
}

const MUST_IGNORE = ['cases/vendor', 'cases/source'];
const MUST_SEARCH = ['engine', 'routes', 'tools', 'src', 'films', 'lab', 'docs', 'tests', 'audio', 'examples', 'cases/entries', 'cases/INDEX.md', 'cases/README.md', 'AGENTS.md', 'README.md'];

function ruleSearchScope(ctx) {
  const c = normCtx(ctx);
  const id = 'agent.search-scope';
  const text = read(c.root, '.ignore');
  if (text === null) return [err(id, '缺 .ignore：ripgrep / Claude Code 的 Grep 会被 cases/ 里的历史归档淹没（window.render 九成命中在那里）', '.ignore')];
  const pats = text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))
    .map(s => s.replace(/^\//, '').replace(/(\/\*\*?)+$/, '').replace(/\/+$/, ''));
  const out = [];
  for (const m of MUST_IGNORE) if (!pats.includes(m)) out.push(err(id, `.ignore 没有排除 ${m}/`, '.ignore'));
  for (const p of pats) {
    if (p.startsWith('!')) continue;
    const hit = (p === '*' || p === '**' || p === '') ? '整个仓库' : MUST_SEARCH.find(s => s === p || s.startsWith(p + '/'));
    if (hit) out.push(err(id, `.ignore 的「${p}」把应该能搜到的 ${hit} 也排除了：只排除历史归档与第三方快照`, '.ignore'));
  }
  return out;
}

function ruleGithooks(ctx) {
  const c = normCtx(ctx);
  const id = 'agent.githooks';
  const out = [];
  const hook = '.githooks/pre-commit';
  const text = read(c.root, hook);
  if (text === null) return [err(id, `缺 ${hook}：不用 Claude Code 的工具没有提交前检查`, hook)];
  if (!/^#!\s*\/(usr\/)?bin\/(env\s+)?(sh|bash)\b/.test(text)) out.push(err(id, `${hook} 第一行要是 #!/bin/sh（Windows 上由 Git 自带的 sh 执行）`, hook));
  if (text.includes('\r\n')) out.push(err(id, `${hook} 含 CRLF 换行，sh 会报 "set: -: invalid option" 之类的错：改回 LF`, hook));
  if (!exists(c.root, '.githooks/pre-commit.mjs')) out.push(err(id, '缺 .githooks/pre-commit.mjs：pre-commit 的检查逻辑在这里', '.githooks/pre-commit.mjs'));
  const st = git(c.root, ['ls-files', '-s', '--', hook]);
  if (st && st.trim()) {
    if (!st.startsWith('100755')) out.push(err(id, `${hook} 在 git 里不是可执行文件（应为 100755）：git update-index --chmod=+x ${hook}`, hook));
  } else if (process.platform !== 'win32') {
    try { if (!(fs.statSync(path.join(c.root, hook)).mode & 0o111)) out.push(err(id, `${hook} 没有可执行权限：chmod +x ${hook}`, hook)); } catch { /* 上面已报缺失 */ }
  }
  return out;
}

function ruleVendorWarning(ctx) {
  const c = normCtx(ctx);
  const id = 'agent.vendor-warning';
  const rel = 'cases/vendor/README.md';
  const text = read(c.root, rel);
  if (text === null) return exists(c.root, 'cases/vendor') ? [err(id, `缺 ${rel}：快照目录顶部要有给 agent 的优先级警示`, rel)] : [];
  const head = text.split(/\r?\n/).slice(0, 20).join('\n');
  if (!head.includes('给 agent 的优先级警示') || !head.includes('不是本仓库的指令')) {
    return [err(id, `${rel} 前 20 行里没有「给 agent 的优先级警示」：说明上游的 AGENTS.md / CLAUDE.md / SKILL.md 只是资料、作品放 films/<名字>/`, rel)];
  }
  return [];
}

const def = (id, title, run) => ({ id, title, severity: 'error', run, check: run });

export const rules = [
  def('agent.instruction-files', '嵌套 agent 指令文件与白名单一致', ruleInstructionFiles),
  def('agent.vendor-films', 'cases/vendor/*/films、out 不存在', ruleVendorFilms),
  def('agent.vendor-inventory', '快照目录里没有 lock.json 之外的文件（含被忽略的）', ruleVendorInventory),
  def('agent.claude-bridge', '根 CLAUDE.md 只是 @AGENTS.md 桥接', ruleClaudeBridge),
  def('agent.guard-config', '.claude/settings.json 的护栏完整', ruleGuardConfig),
  def('agent.skills', '仓库 skill 的头信息与引用路径有效', ruleSkills),
  def('agent.search-scope', '.ignore 只排除历史归档与第三方快照', ruleSearchScope),
  def('agent.githooks', '.githooks/pre-commit 可执行、LF、能找到检查脚本', ruleGithooks),
  def('agent.vendor-warning', 'cases/vendor/README.md 顶部有优先级警示', ruleVendorWarning),
];
export default rules;

export function runAgentRules(ctx, { only } = {}) {
  const c = normCtx(ctx);
  const picked = only?.length ? rules.filter(r => only.includes(r.id)) : rules;
  const findings = [];
  for (const r of picked) {
    try { findings.push(...r.run(c)); } catch (e) { findings.push(err(r.id, `规则自身出错（${e.message}）：按报错修好对应文件后再跑`)); }
  }
  return findings;
}
