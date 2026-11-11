// baseline.sets：金标准集合定义 tools/baseline/sets.json 结构合法（QUAL-01）。集合定义坏了，金标准工具与其余基线规则都没法判。
import { SETS, loadSets } from './_shared.mjs';

export default {
  id: 'baseline.sets',
  title: '金标准集合定义 tools/baseline/sets.json 合法',
  run(ctx) {
    const { error } = loadSets(ctx);
    return error ? [{ level: 'error', file: SETS, message: error, hint: '照文件里现有集合的写法改；时刻的四种写法见 tools/baseline/lib/sets.mjs 开头' }] : [];
  },
};
