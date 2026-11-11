// agent.search-scope：检索默认不被历史归档淹没（差距 GAP-08）。根目录 .ignore（ripgrep、fd、Claude Code 的 Grep 遵守）
// 必须排除 cases/vendor/、cases/source/，而且只排除归档与快照：引擎、路线、作品、文档、案例卡都得搜得到。
// 实测命中数（window.render 在 cases/ 下默认 0 命中、--no-ignore 时 ≥200）由 tests/agent-layer/search-scope.test.mjs 用 rg 验证。
import { finding, readCommitted } from './_shared.mjs';

const FILE = '.ignore';
const MUST_IGNORE = ['cases/vendor', 'cases/source'];
const MUST_SEARCH = ['engine', 'routes', 'tools', 'src', 'films', 'lab', 'docs', 'tests', 'audio', 'examples', 'evals',
  'cases/entries', 'cases/INDEX.md', 'cases/README.md', 'AGENTS.md', 'README.md'];

export default {
  id: 'agent.search-scope',
  title: '.ignore 默认跳过历史归档与第三方快照，其余目录都能搜到',
  run(ctx) {
    const text = readCommitted(ctx, FILE);
    if (text === null) return [finding('error', FILE, '缺 .ignore：ripgrep 与 Claude Code 的 Grep 会被 cases/ 里的历史归档淹没（window.render 九成命中在那里）', '从版本库恢复：git checkout -- .ignore')];
    const pats = text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))
      .map(s => s.replace(/^\//, '').replace(/(\/\*\*?)+$/, '').replace(/\/+$/, ''));
    const out = [];
    for (const m of MUST_IGNORE) if (!pats.includes(m)) out.push(finding('error', FILE, `.ignore 没有排除 ${m}/`, `加一行 ${m}/`));
    for (const p of pats) {
      if (p.startsWith('!')) continue;
      const hit = ['*', '**', ''].includes(p) ? '整个仓库' : MUST_SEARCH.find(s => s === p || s.startsWith(`${p}/`));
      if (hit) out.push(finding('error', FILE, `.ignore 的「${p}」把应该能搜到的 ${hit} 也排除了`, '只排除历史归档与第三方快照（cases/vendor/、cases/source/ 等）', { excerpt: p }));
    }
    return out;
  },
};
