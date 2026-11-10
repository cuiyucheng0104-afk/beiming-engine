// route-c.manual：C 手册按 D01 写定义；分「新片 / 挑风格 / 历史复刻」；分三种情况说历史页面能不能交给 engine/render；
// 警示不要运行 vendor 的 setup.sh；不拿 --source-only 的还原判断能不能渲；链接上游 DIRECTOR / TECHNIQUE（MIT）；
// 不搬第三方代码一条链接派生代码的来源头规则与自查命令；Python 走 tools/env/py.mjs；手册里提到的风格 id 都在 styles.json 里。
import { C, err, lineOf, ok, readLF } from './_lib.mjs';

const MUST = [
  [/不是第三个 GPU 后端/, '按 D01 写明定义：C 与 A 共用 engine/render，不是第三个 GPU 后端'],
  [/### 新片/, '要有「新片」一节'],
  [/### 历史复刻/, '要有「历史复刻」一节'],
  [/不要运行 vendor 自带的 `?setup\.sh`?/, '警示：不要运行 vendor 自带的 setup.sh（会把 ~/lemo-opuscar 拉到上游 main 并 reset --hard）'],
  [/自包含[\s\S]*\/core\/[\s\S]*__seek/, '分三种情况写历史页面能不能交给 engine/render：自包含的 Lemo、依赖 /core/ 的 Lemo、SY 的 __seek'],
  [/--source-only[^\n]*不能拿它判断/, '写明不要拿 --source-only 的还原结果判断能不能渲'],
  [/DIRECTOR\.md/, '链接上游的 DIRECTOR.md（注明 MIT 与作者）'],
  [/TECHNIQUE\.md/, '链接上游的 TECHNIQUE.md'],
  [/docs\/rights\/licensing\.md/, '「不搬第三方代码」一条链接 docs/rights/licensing.md（派生代码的来源头）'],
  [/tools\/compliance\/scan\.mjs --only provenance/, '写上派生代码的自查命令 node tools/compliance/scan.mjs --only provenance'],
  [/tools\/env\/py\.mjs/, 'Python 用 tools/env/py.mjs 选（自动用仓库 .venv），不写死 python3 或某个解释器路径'],
  [/docs\/ENVIRONMENT\.md/, '历史复刻链接 docs/ENVIRONMENT.md 的「渲染器 × 环境变量」表'],
  [/routes\/c-style\/fonts|fonts\/README\.md/, '写明模版片名字体（routes/c-style/fonts/）的覆盖范围与缺字时怎么办'],
];

export default {
  id: 'route-c.manual',
  title: 'C 手册按 D01 与实测写清三种用法、边界与来源许可',
  run(ctx) {
    const f = `${C}/README.md`;
    if (!ctx.exists(f)) return [err('C 路线手册缺失', f)];
    const md = readLF(ctx, f), out = [];
    for (const [re, what] of MUST) if (!re.test(md)) out.push(err(`手册缺一条：${what}`, f));
    const lumped = /还原(出来)?的源码不能直接用北冥的\s*`?engine\/render/;
    if (lumped.test(md)) out.push({ ...err('手册还在一概而论地说"还原的源码不能用 engine/render 渲"（与实测矛盾：自包含的页面可以）', f), line: lineOf(md, lumped) });
    if (ctx.exists(`${C}/styles.json`)) {
      const ids = new Set(JSON.parse(readLF(ctx, `${C}/styles.json`)).styles.map(s => s.id));
      for (const m of md.matchAll(/`((?:lemo|sy)\/[a-z0-9-]+)`/g)) {
        if (!ids.has(m[1])) out.push({ ...err(`手册提到的风格 ${m[1]} 不在 styles.json 里`, f, '改成 STYLES.md 里的编号'), line: md.slice(0, m.index).split('\n').length });
      }
    }
    if (!out.length) out.push(ok('C 手册要点齐全'));
    return out;
  },
};
