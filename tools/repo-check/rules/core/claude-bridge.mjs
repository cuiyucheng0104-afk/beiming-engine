// core.claude-bridge：仓库根有 CLAUDE.md，内容只有一行 @AGENTS.md（Claude Code 从它跳到 AGENTS.md，指令只维护一份）。
export default {
  id: 'core.claude-bridge',
  title: '根目录 CLAUDE.md 只桥接到 AGENTS.md',
  run(ctx) {
    if (!ctx.exists('CLAUDE.md')) return [{ level: 'error', file: 'CLAUDE.md', message: '仓库根没有 CLAUDE.md：Claude Code 不会自动读 AGENTS.md', hint: '新建 CLAUDE.md，内容只写一行 @AGENTS.md' }];
    const lines = ctx.read('CLAUDE.md').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length !== 1 || lines[0] !== '@AGENTS.md') return [{ level: 'error', file: 'CLAUDE.md', message: 'CLAUDE.md 应只有一行 @AGENTS.md（规则只在 AGENTS.md 维护一份）', hint: '把 CLAUDE.md 里的规则挪进 AGENTS.md' }];
    return [];
  },
};
