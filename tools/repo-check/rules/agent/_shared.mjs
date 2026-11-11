// 北冥仓库 · 规范检查 · agent 域的共用部分（文件名以 _ 开头，规则加载器不把它当规则）。
// agent 域的规则核对「agent 一侧的机器约束都在、没被削弱」：指令文件白名单、护栏配置、仓库 skill、检索范围、
// git 钩子、vendor 顶部警示。规则拿到的是 tools/repo-check/core/context.mjs 的 ctx（只读、带缓存）。
// 快照里不得有作品目录与多余文件、根 CLAUDE.md 只是桥接，这两件由 core.vendor-immutable 与 core.claude-bridge 负责，这里不重复。
// 判定口径（哪些文件算指令文件、受保护区域）只从 .claude/hooks/lib/policy.mjs 取，与护栏钩子、提交前检查同一份。
// --staged（提交前检查）时，agent 域的规则一律读 git 索引里这次要提交的版本（readCommitted、existsCommitted），
// 不被工作区里没暂存的改动或未跟踪的草稿拦下；不带 --staged 时读工作区。
import { isInstructionFile, LOCAL_ONLY_INSTRUCTION_FILES } from '../../../../.claude/hooks/lib/policy.mjs';

export { isInstructionFile };
export const WHITELIST = 'tools/repo-check/rules/agent/instruction-files.json';
const FOREIGN = '.claude/worktrees/';                     // 本机临时工作树：另一份检出，不归本检出管
const LOCAL_ONLY = new Set(LOCAL_ONLY_INSTRUCTION_FILES);

export const isForeign = rel => (rel + '/').startsWith(FOREIGN);
export const isLocalOnly = rel => LOCAL_ONLY.has(String(rel).toLowerCase());

/** 白名单文本 → 路径集合。files 里每项可以是字符串或 { path, role }。 */
export function parseWhitelist(text) {
  const j = JSON.parse(text);
  if (!Array.isArray(j?.files)) throw new Error('缺 files 数组');
  return new Set(j.files.map(f => (typeof f === 'string' ? f : f?.path)).filter(p => typeof p === 'string' && p));
}

/**
 * 仓库里的文件：{ tracked（git 索引）, untracked（未跟踪且未被忽略）, git }，仓库相对正斜杠路径，已去掉 .claude/worktrees/。
 * 不是 git 检出时遍历目录（ctx.walk 的跳过规则），全部算 tracked。
 */
export function repoFiles(ctx) {
  return ctx.memo('agent:repo-files', () => {
    const keep = s => s && !isForeign(s);
    const t = ctx.git(['-c', 'core.quotepath=off', 'ls-files', '-z', '--cached']);
    if (!t.ok) return { tracked: ctx.walk('.').filter(keep), untracked: [], git: false };
    const u = ctx.git(['-c', 'core.quotepath=off', 'ls-files', '-z', '--others', '--exclude-standard']);
    return {
      tracked: [...new Set(t.stdout.split('\0').filter(keep))],
      untracked: (u.ok ? u.stdout : '').split('\0').filter(keep),
      git: true,
    };
  });
}

/** 读文本；文件不存在或读不了返回 null（ctx.read 读不了会抛错）。 */
export function readOrNull(ctx, rel) {
  if (!ctx.exists(rel)) return null;
  try { return ctx.read(rel); } catch { return null; }
}

// ── 判「这次要提交的内容」：--staged（提交前检查）时读 git 索引，不读工作区 ──
// 提交前检查只该判这次提交：工作区里没暂存的改动、未跟踪的草稿、在工作区删了但删除没暂存的文件都不算。
// 不带 --staged（全量检查、CI）时读工作区，与其他域一致。

/** 路径集合的全部上级目录（'a/b/c' → 'a/b'、'a'）。 */
function dirsOf(paths) {
  const dirs = new Set();
  for (const p of paths) {
    let i = p.lastIndexOf('/');
    while (i > 0) {
      const d = p.slice(0, i);
      if (dirs.has(d)) break;
      dirs.add(d);
      i = p.lastIndexOf('/', i - 1);
    }
  }
  return dirs;
}

/** 这次要提交的版本：--staged 时是索引里的文本（不在索引里返回 null），否则读工作区。 */
export function readCommitted(ctx, rel) {
  if (!ctx.staged) return readOrNull(ctx, rel);
  const r = ctx.git(['-c', 'core.quotepath=off', 'show', `:${rel}`]);
  return r.ok ? r.stdout : null;
}

/** 路径（文件或目录）在这次提交里存在吗：--staged 时看索引，否则看工作区。 */
export function existsCommitted(ctx, rel) {
  if (!ctx.staged) return ctx.exists(rel);
  const r = String(rel).replace(/\/+$/, '');
  const { files, dirs } = ctx.memo('agent:index-paths', () => {
    const tracked = repoFiles(ctx).tracked;
    return { files: new Set(tracked), dirs: dirsOf(tracked) };
  });
  return files.has(r) || dirs.has(r);
}

/** 目录下这次要提交的直接子目录名：--staged 时从索引推出，否则列工作区。 */
export function subdirsCommitted(ctx, dir) {
  const d = String(dir).replace(/\/+$/, '');
  if (!ctx.staged) return ctx.walk(d, { dirs: true, files: false }).filter(x => x.split('/').length === d.split('/').length + 1).map(x => x.split('/').pop()).sort();
  const names = new Set();
  for (const f of repoFiles(ctx).tracked) {
    if (!f.startsWith(`${d}/`)) continue;
    const rest = f.slice(d.length + 1).split('/');
    if (rest.length > 1) names.add(rest[0]);
  }
  return [...names].sort();
}

/** 统一的发现对象。 */
export const finding = (level, file, message, hint, extra = {}) => ({ level, ...(file ? { file } : {}), message, ...(hint ? { hint } : {}), ...extra });
