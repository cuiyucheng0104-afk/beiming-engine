// agent.instruction-files：会被 agent 工具自动加载的指令与配置文件（AGENTS.md、CLAUDE.md、GEMINI.md、SKILL.md、DIRECTOR.md、
// .claude/ 配置、.claude-plugin/*.json、.mcp.json、.cursorrules 等）与白名单 instruction-files.json 完全一致（差距 ENTRY-02、GAP-08）。
// 本仓库只有根目录 AGENTS.md 一份指令；子目录里多出一份就会被工具沿目录自动当成指令加载，盖过仓库规则。
// 看 git 索引与未跟踪、未被忽略的文件；--staged（提交前检查）时只看索引，不因工作区里没打算提交的文件挡住提交。
import { WHITELIST, finding, isInstructionFile, isLocalOnly, parseWhitelist, readCommitted, repoFiles } from './_shared.mjs';

export default {
  id: 'agent.instruction-files',
  title: '会被 agent 工具自动加载的指令与配置文件与白名单一致',
  run(ctx) {
    const text = readCommitted(ctx, WHITELIST);
    if (text === null) return [finding('error', WHITELIST, `白名单 ${WHITELIST} 不存在`, '从版本库恢复：git checkout -- tools/repo-check/rules/agent/instruction-files.json')];
    let wl;
    try { wl = parseWhitelist(text); } catch (e) { return [finding('error', WHITELIST, `白名单不是合法的 JSON 或格式不对（${e.message}）`, '恢复成 { "schemaVersion": 1, "files": [{ "path", "role" }] }')]; }
    const { tracked, untracked } = repoFiles(ctx);
    const pool = ctx.staged ? tracked : [...tracked, ...untracked.filter(f => !isLocalOnly(f))];
    const found = new Set(pool.filter(isInstructionFile));
    const out = [];
    for (const f of [...found].sort()) {
      if (wl.has(f)) continue;
      out.push(finding('error', f, `${f} 是会被 agent 工具自动加载的指令或配置文件，但不在白名单里`,
        `本仓库只有根目录 AGENTS.md 一份指令（CLAUDE.md 只是桥接）：子目录的说明写成 README.md；确需新增（例如仓库 skill），在 ${WHITELIST} 登记路径与用途`, { excerpt: f }));
    }
    for (const f of [...wl].sort()) {
      if (found.has(f)) continue;
      out.push(finding('error', WHITELIST, `白名单登记了 ${f}，仓库里却没有`, `文件被删或改名了：同步更新 ${WHITELIST}`, { excerpt: f }));
    }
    if (!out.length) out.push(finding('info', null, `指令与配置文件 ${found.size} 个，与白名单一致`));
    return out;
  },
};
