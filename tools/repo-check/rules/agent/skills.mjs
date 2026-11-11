// agent.skills：仓库自带的 skill（.claude/skills/<名>/SKILL.md）可用（差距 GAP-07）。
//   - 做片入口 beiming-film 在；每个 skill 有 YAML 头，name 与目录名相同，description 写清在本仓库里什么时候触发
//   - 正文里用反引号写的仓库路径都存在（改了仓库结构就同步改 skill；--staged 时按索引判断，工作区里没暂存的删除不算）
//   - 不引导去调用全局第三方风格库 skill
// 评测（evals/、tools/eval）按「.claude/skills/<目录>/SKILL.md 的 name」区分仓库 skill 与全局 skill。
import { existsCommitted, finding, readCommitted, subdirsCommitted } from './_shared.mjs';

const DIR = '.claude/skills';
const REQUIRED = ['beiming-film'];
const PATH_HEADS = ['routes/', 'docs/', 'tools/', 'engine/', 'cases/', 'src/', 'media/', 'tests/', '.claude/', 'lab/', 'examples/', 'fonts/', 'assets/', 'audio/', 'evals/'];
const ROOT_FILES = new Set(['AGENTS.md', 'README.md', 'ROUTES.md', 'THIRD-PARTY.md', 'LICENSE', 'CLAUDE.md', 'package.json']);

export default {
  id: 'agent.skills',
  title: '仓库 skill 的头信息有效、正文引用的路径都存在',
  run(ctx) {
    if (!existsCommitted(ctx, DIR)) return [finding('error', DIR, `缺 ${DIR}/：仓库自带的做片入口 skill 不在了`, `从版本库恢复：git checkout -- ${DIR}`)];
    const out = [];
    const names = subdirsCommitted(ctx, DIR);
    for (const n of REQUIRED) if (!names.includes(n)) out.push(finding('error', `${DIR}/${n}/SKILL.md`, `缺 ${DIR}/${n}/SKILL.md：在本仓库做片的入口 skill`, `从版本库恢复：git checkout -- ${DIR}/${n}`));
    for (const n of names) {
      const rel = `${DIR}/${n}/SKILL.md`;
      const text = readCommitted(ctx, rel);
      if (text === null) { out.push(finding('error', rel, `${rel} 不存在：skill 目录里必须有 SKILL.md`, '补上 SKILL.md，或删掉这个目录')); continue; }
      const fm = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fm) { out.push(finding('error', rel, `${rel} 缺 YAML 头（--- name / description ---）`, '照 beiming-film/SKILL.md 的开头写')); continue; }
      const name = fm[1].match(/^name:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '');
      const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1].trim() ?? '';
      if (name !== n) out.push(finding('error', rel, `${rel} 的 name 是「${name ?? '（缺）'}」，应与目录名 ${n} 相同`, '评测与 Claude Code 都按 name 认 skill：改成目录名'));
      if (desc.length < 20) out.push(finding('error', rel, `${rel} 的 description 太短`, '写清在本仓库里什么时候触发（中文触发词：做片、短片、动画、渲染、某某风格……）'));
      if (desc.length > 1024) out.push(finding('error', rel, `${rel} 的 description 超过 1024 字`, '压短：多余的说明放进正文'));
      const body = text.slice(fm[0].length);
      if (/Skill\(\s*(lemo-opuscar|sy-style-100)/i.test(body)) out.push(finding('error', rel, `${rel} 引导去调用全局第三方风格库 skill`, '在本仓库里不调用 lemo-opuscar、sy-style-100（设置里已拒绝）：风格在 routes/c-style/STYLES.md 里查'));
      const seen = new Set();
      for (const m of body.matchAll(/`([^`\n]+)`/g)) {
        let p = m[1].trim().replace(/[，。；：、）)]+$/, '').replace(/#.*$/, '');
        if (!PATH_HEADS.some(h => p.startsWith(h)) && !ROOT_FILES.has(p)) continue;
        if (/[<>*{}|$\s]/.test(p) || p.includes('…')) continue;
        p = p.replace(/\/+$/, '');
        if (seen.has(p)) continue;
        seen.add(p);
        if (!existsCommitted(ctx, p)) out.push(finding('error', rel, `${rel} 引用的 ${p} 不存在`, '改了仓库结构就同步改 skill', { excerpt: p }));
      }
    }
    return out;
  },
};
