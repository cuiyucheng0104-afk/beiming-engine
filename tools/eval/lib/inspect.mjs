// 会话记录里的每次工具调用 → 结构化动作（写、读、命令、skill），供 H3 / H4 / 过程指标共用。
//
// 文件工具（Write、Edit、MultiEdit、NotebookEdit、Read、Glob、Grep）取输入里的路径；
// Bash 用 shell.mjs 静态分析（按代理分别跟踪 cd）；Skill 记下 skill 名。
// 路径一律换算成绝对路径，再算相对被测检出的路径（不在检出内为 null）。
// 接口：inspectActions(transcript, { worktree, home }) → actions[]；repoSkills(worktree)；
//       pathFlags(text, home) → { homeLemo, outsideSkills }；WRITE_TOOLS、READ_TOOLS

import fs from 'node:fs';
import path from 'node:path';
import { analyzeShell } from './shell.mjs';
import { expandHome, homeDir, relInside, toPosix } from './paths.mjs';

export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);

/** 仓库自带的 skill 名（.claude/skills/<目录>/SKILL.md；frontmatter 的 name 优先）。 */
export function repoSkills(worktree) {
  const dir = path.join(worktree, '.claude', 'skills');
  const names = new Set();
  if (!fs.existsSync(dir)) return names;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    names.add(e.name);
    const skill = path.join(dir, e.name, 'SKILL.md');
    if (fs.existsSync(skill)) {
      const m = /^---[\s\S]*?\nname:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?---/m.exec(fs.readFileSync(skill, 'utf8'));
      if (m) names.add(m[1].trim());
    }
  }
  return names;
}

const HOME_LEMO_GENERIC = [
  /(^|[\s'"=:(])~[\\/]lemo-[^\s'"]*/,
  /\$\{?HOME\}?[\\/]lemo-[^\s'"]*/,
  /%USERPROFILE%[\\/]lemo-[^\s'"]*/i,
  /\/(Users|home)\/[^/\s'"]+\/lemo-[^\s'"]*/,
  /[A-Za-z]:\\Users\\[^\\\s'"]+\\lemo-[^\s'"]*/,
];
const SKILL_DIR_GENERIC = [
  /(^|[\s'"=:(])~[\\/]\.(claude[\\/](skills|plugins)|agents[\\/]skills|codex[\\/]skills)\b/,
  /\$\{?HOME\}?[\\/]\.(claude[\\/](skills|plugins)|agents[\\/]skills|codex[\\/]skills)\b/,
  /\/(Users|home)\/[^/\s'"]+\/\.(claude\/(skills|plugins)|agents\/skills|codex\/skills)\b/,
  /[A-Za-z]:\\Users\\[^\\\s'"]+\\\.(claude\\(skills|plugins)|agents\\skills|codex\\skills)\b/,
];

/** 文本里是否出现家目录下的 lemo-* 或仓库外的 skill 目录。 */
export function pathFlags(text, home = homeDir()) {
  const s = String(text ?? '');
  const h = toPosix(home).replace(/\/+$/, '');
  const posix = toPosix(s);
  const homeLemo = HOME_LEMO_GENERIC.some(re => re.test(s)) || (h && posix.includes(`${h}/lemo-`));
  const outsideSkills = SKILL_DIR_GENERIC.some(re => re.test(s))
    || (h && ['/.claude/skills', '/.claude/plugins', '/.agents/skills', '/.codex/skills'].some(d => posix.includes(`${h}${d}`)));
  return { homeLemo, outsideSkills };
}

function filePathsOf(use) {
  const i = use.input ?? {};
  const out = [];
  for (const key of ['file_path', 'notebook_path', 'path']) if (typeof i[key] === 'string' && i[key]) out.push(i[key]);
  if (use.tool === 'Glob' && typeof i.pattern === 'string' && /^([A-Za-z]:)?[\\/~]/.test(i.pattern)) out.push(i.pattern);
  return out;
}

/**
 * @returns {Array<{ seq, turn, actor, tool, id, denied, kind: 'write'|'read'|'bash'|'skill'|'other',
 *   paths: Array<{ abs, rel }>, bash?: object, skill?: string, raw: string, isError: boolean }>}
 */
export function inspectActions(t, { worktree, home = homeDir() }) {
  const cwdByActor = new Map();
  const toEntry = abs => ({ abs, rel: relInside(worktree, abs) });
  const actions = [];
  for (const use of t.toolUses) {
    const base = { seq: use.seq, turn: use.turn, actor: use.actor, tool: use.tool, id: use.id, denied: Boolean(use.denied), isError: Boolean(use.result?.isError), source: use.source };
    if (WRITE_TOOLS.has(use.tool) || READ_TOOLS.has(use.tool)) {
      const paths = filePathsOf(use).map(p => {
        const e = expandHome(p, home);
        return toEntry(path.isAbsolute(e) || /^[A-Za-z]:[\\/]/.test(e) ? e : path.resolve(cwdByActor.get(use.actor) ?? worktree, e));
      });
      const raw = JSON.stringify(use.input ?? {});
      actions.push({ ...base, kind: WRITE_TOOLS.has(use.tool) ? 'write' : 'read', paths, raw, readLines: use.tool === 'Read' ? readLineCount(use) : null });
      continue;
    }
    if (use.tool === 'Bash' || use.tool === 'PowerShell') {
      const command = String(use.input?.command ?? '');
      const cwd = cwdByActor.get(use.actor) ?? worktree;
      const bash = analyzeShell(command, { cwd, home });
      cwdByActor.set(use.actor, bash.cwd);
      actions.push({
        ...base, kind: 'bash', raw: command, bash, background: Boolean(use.input?.run_in_background),
        paths: bash.writes.map(w => ({ ...toEntry(w.path), via: w.via, write: true })).concat(bash.reads.map(r => ({ ...toEntry(r.path), via: r.via, write: false, lines: r.lines }))),
      });
      continue;
    }
    if (use.tool === 'Skill' || use.tool === 'SlashCommand') {
      const name = String(use.input?.skill ?? use.input?.command ?? use.input?.name ?? '').replace(/^\//, '').split(/\s+/)[0];
      actions.push({ ...base, kind: 'skill', skill: name, paths: [], raw: JSON.stringify(use.input ?? {}) });
      continue;
    }
    actions.push({ ...base, kind: 'other', paths: [], raw: JSON.stringify(use.input ?? {}) });
  }
  return actions;
}

/** Read 结果里实际返回了多少行（Claude Code 的 Read 结果按行编号）；读不到结果时用 limit。 */
function readLineCount(use) {
  const text = use.result?.text;
  if (typeof text === 'string' && text.length) {
    const numbered = text.split('\n').filter(l => /^\s*\d+[\t→|]/.test(l)).length;
    if (numbered) return numbered;
    return text.split('\n').length;
  }
  return Number.isInteger(use.input?.limit) ? use.input.limit : null;
}
