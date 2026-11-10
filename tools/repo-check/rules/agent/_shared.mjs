// 北冥仓库 · 规范检查 · agent 域的共用部分（文件名以 _ 开头，规则加载器不把它当规则）。
// agent 域的规则核对「agent 一侧的机器约束都在、没被削弱」：指令文件白名单、护栏配置、仓库 skill、检索范围、
// git 钩子、vendor 顶部警示。规则拿到的是 tools/repo-check/core/context.mjs 的 ctx（只读、带缓存）。
// 快照里不得有作品目录与多余文件、根 CLAUDE.md 只是桥接，这两件由 core.vendor-immutable 与 core.claude-bridge 负责，这里不重复。
// 判定口径（哪些文件算指令文件、受保护区域）只从 .claude/hooks/lib/policy.mjs 取，与护栏钩子、提交前检查同一份。
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

/** 统一的发现对象。 */
export const finding = (level, file, message, hint, extra = {}) => ({ level, ...(file ? { file } : {}), message, ...(hint ? { hint } : {}), ...extra });
