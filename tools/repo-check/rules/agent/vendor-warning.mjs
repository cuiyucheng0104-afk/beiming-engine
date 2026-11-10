// agent.vendor-warning：cases/vendor/README.md 前 20 行有「给 agent 的优先级警示」（差距 ENTRY-02、COMP-10）。
// 快照里的 AGENTS.md / CLAUDE.md / SKILL.md / DIRECTOR.md 是上游资料，不是本仓库的指令；警示说明作品放 films/<名字>/、
// 不在快照里建作品或运行上游命令、不调用全局风格库 skill、不读写 ~/lemo-my-styles。README 不在 lock.json 的快照范围里，可以改。
import { existsCommitted, finding, readCommitted } from './_shared.mjs';

const FILE = 'cases/vendor/README.md';
const MUST = ['给 agent 的优先级警示', '不是本仓库的指令', 'films/<名字>/'];

export default {
  id: 'agent.vendor-warning',
  title: 'cases/vendor/README.md 顶部有给 agent 的优先级警示',
  run(ctx) {
    const text = readCommitted(ctx, FILE);
    if (text === null) {
      return existsCommitted(ctx, 'cases/vendor') ? [finding('error', FILE, `缺 ${FILE}：快照目录顶部要有给 agent 的优先级警示`, `从版本库恢复：git checkout -- ${FILE}`)] : [];
    }
    const head = text.split(/\r?\n/).slice(0, 20).join('\n');
    const lack = MUST.filter(w => !head.includes(w));
    if (lack.length) {
      return [finding('error', FILE, `${FILE} 前 20 行缺「${lack.join('」「')}」`, '在文件顶部恢复「给 agent 的优先级警示」引用块：上游 AGENTS.md / CLAUDE.md / SKILL.md 只是资料，作品放 films/<名字>/')];
    }
    return [];
  },
};
