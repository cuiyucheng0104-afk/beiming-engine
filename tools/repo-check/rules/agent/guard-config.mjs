// agent.guard-config：.claude/settings.json 的护栏没被削弱（差距 ENTRY-02、COMP-10、GAP-07）。
//   - permissions.deny 里有硬拒绝：写 cases/vendor/**、cases/source/**；git add / git stage 的 -A、.；强推；全局第三方风格库 skill
//   - hooks.PreToolUse 让写文件、Shell、PowerShell、Skill、MCP 工具都经过 .claude/hooks/guard.mjs，脚本存在
//   - enabledPlugins 在项目级关掉会抢先触发的全局风格库插件（lemo-opuscar@lemolab）
//   - claudeMdExcludes 屏蔽 cases/vendor、cases/source 里上游 CLAUDE.md / AGENTS.md 的自动加载
import { existsCommitted, finding, readCommitted } from './_shared.mjs';

const FILE = '.claude/settings.json';
const GUARD = '.claude/hooks/guard.mjs';
const REQUIRED_DENY = [
  'Edit(/cases/vendor/**)', 'Edit(/cases/source/**)',
  'Bash(git add -A)', 'Bash(git add -A *)', 'Bash(git add --all)', 'Bash(git add .)', 'Bash(git add . *)',
  'Bash(git stage -A)', 'Bash(git stage -A *)', 'Bash(git stage --all)', 'Bash(git stage .)', 'Bash(git stage . *)',
  'Bash(git push --force*)', 'Bash(git push -f)', 'Bash(git push -f *)',
  'PowerShell(git add -A)', 'PowerShell(git add .)', 'PowerShell(git stage -A)', 'PowerShell(git stage .)', 'PowerShell(git push --force*)',
  'Skill(lemo-opuscar)', 'Skill(lemo-opuscar:*)', 'Skill(sy-style-100)', 'Skill(sy-style-100:*)',
];
const GUARDED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Skill', 'mcp__any__write_file'];
const DISABLED_PLUGINS = ['lemo-opuscar@lemolab'];
const EXCLUDED_DIRS = ['cases/vendor', 'cases/source'];

export default {
  id: 'agent.guard-config',
  title: '.claude/settings.json 的护栏完整（拒绝规则、钩子接线、插件开关、上游 CLAUDE.md 排除）',
  run(ctx) {
    const text = readCommitted(ctx, FILE);
    if (text === null) return [finding('error', FILE, `缺 ${FILE}：仓库级权限与 PreToolUse 钩子都靠它`, `从版本库恢复：git checkout -- ${FILE}`)];
    let j;
    try { j = JSON.parse(text); } catch (e) {
      return [finding('error', FILE, `${FILE} 不是合法 JSON（${e.message}）：Claude Code 会整份跳过它，护栏全部失效`, '修好 JSON；改完跑 node --test tests/agent-layer')];
    }
    const out = [];
    const deny = new Set(Array.isArray(j?.permissions?.deny) ? j.permissions.deny : []);
    const missing = REQUIRED_DENY.filter(r => !deny.has(r));
    if (missing.length) out.push(finding('error', FILE, `permissions.deny 缺少 ${missing.join('、')}`, '补回这些拒绝规则（理由见 .claude/hooks/README.md「三层，各管一段」）'));
    const pre = Array.isArray(j?.hooks?.PreToolUse) ? j.hooks.PreToolUse : [];
    const guarded = tool => pre.some(m => {
      let re;
      try { re = new RegExp(`^(?:${m?.matcher ?? ''})$`); } catch { return false; }
      return re.test(tool) && (m.hooks ?? []).some(h => !h.if && String(h.command ?? '').includes(GUARD));
    });
    const unguarded = GUARDED_TOOLS.filter(t => !guarded(t));
    if (unguarded.length) out.push(finding('error', FILE, `hooks.PreToolUse 没有让 ${unguarded.map(t => (t.startsWith('mcp__') ? 'MCP 工具' : t)).join('、')} 无条件经过 ${GUARD}`, '恢复 matcher "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|Skill|mcp__.*" 的那一条'));
    if (!existsCommitted(ctx, GUARD)) out.push(finding('error', GUARD, `钩子脚本 ${GUARD} 不存在：每次工具调用都会报钩子错误，护栏失效`, `从版本库恢复：git checkout -- .claude/hooks`));
    for (const p of DISABLED_PLUGINS) {
      if (j?.enabledPlugins?.[p] !== false) out.push(finding('error', FILE, `enabledPlugins 没有把 ${p} 设为 false`, '全局风格库插件会抢先触发，把作品带出仓库：在项目级关掉它'));
    }
    const ex = Array.isArray(j?.claudeMdExcludes) ? j.claudeMdExcludes : [];
    for (const dir of EXCLUDED_DIRS) {
      if (!ex.some(p => String(p).includes(dir))) out.push(finding('error', FILE, `claudeMdExcludes 没有覆盖 ${dir}`, `读 ${dir} 里的文件时，上游 CLAUDE.md / AGENTS.md 会被自动当成指令加载：加回 "**/${dir}/**"`));
    }
    return out;
  },
};
