// route-c.replicate：历史复刻说明 REPLICATE.md 在，写了 c-runtime setup、restore --download、c-runtime build，
// 警示不要运行 vendor 自带的 setup.sh，并链接 docs/ENVIRONMENT.md 的渲染器 × 环境变量表。
import { C, err, ok, readLF } from './_lib.mjs';

const MUST = [
  [/c-runtime\.mjs setup/, 'c-runtime setup 一步'],
  [/--download/, 'restore 要带 --download'],
  [/不要运行[^\n]*setup\.sh/, '不要运行 vendor 自带 setup.sh 的警示'],
  [/c-runtime\.mjs build/, 'c-runtime build 一步'],
  [/docs\/ENVIRONMENT\.md/, '链接 docs/ENVIRONMENT.md 的「渲染器 × 环境变量」表'],
];

export default {
  id: 'route-c.replicate',
  title: 'C 路线的历史复刻说明齐全',
  run(ctx) {
    const f = `${C}/REPLICATE.md`;
    if (!ctx.exists(f)) return [err('历史复刻说明缺失', f, '写清 c-runtime setup → restore --download → c-runtime build 的步骤')];
    const md = readLF(ctx, f), out = [];
    for (const [re, what] of MUST) if (!re.test(md)) out.push(err(`REPLICATE.md 缺：${what}`, f));
    if (!out.length) out.push(ok('历史复刻说明要点齐全'));
    return out;
  },
};
