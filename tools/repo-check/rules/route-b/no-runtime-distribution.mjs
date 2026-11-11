// route-b.no-runtime-distribution：仓库不分发上游原生运行时，也不放它的源码形态的文件（决定 D03；docs/rights/fsl-boundary.md「agent 规则」1、2）：
//   · git 不跟踪运行时二进制（raea、raea.exe、raea-perceive、libraea*）；
//   · B 路线的目录（engine/native、routes/b-native、examples/raea）里没有 Rust / WESL / WGSL 源文件——着色器以字符串写在我方的 .ts 里，
//     不复制上游 SDK 或运行时源码。上游许可原文、版权行的逐段比对由合规规则 comp.fsl-boundary 负责，这里不重复。
const BINARY = /(^|\/)(raea|raea-perceive)(\.exe)?$|(^|\/)libraea[^/]*$/i;
const SOURCE_DIRS = ['engine/native', 'routes/b-native', 'examples/raea'];

export default {
  id: 'route-b.no-runtime-distribution',
  title: '不分发上游原生运行时，B 路线目录里没有上游源码形态的文件',
  run(ctx) {
    const out = [];
    const g = ctx.git(['ls-files', '-z']);
    const tracked = g.ok ? g.stdout.split('\0').filter(Boolean) : ['engine', 'routes', 'examples', 'tools'].flatMap(d => ctx.walk(d));
    for (const f of tracked) if (BINARY.test(f)) out.push({ level: 'error', file: f, message: '上游原生运行时的二进制不能进仓库（决定 D03：不分发运行时）', hint: '从 git 里删掉（git rm --cached），运行时由 node engine/native/runtime.mjs fetch --accept-license 装到仓库外' });
    for (const d of SOURCE_DIRS) {
      for (const f of ctx.walk(d)) {
        if (/\/(media|delivery)\//.test(`/${f}`)) continue;
        if (/\.(rs|wesl|wgsl)$/i.test(f)) out.push({ level: 'error', file: f, message: 'B 路线目录里出现 Rust / WESL / WGSL 源文件：像是复制了上游源码', hint: '只写调用公开接口的自有代码；着色器写成 .ts 里的字符串（见 engine/native/surface.ts），不复制上游 SDK（docs/rights/fsl-boundary.md）' });
      }
    }
    if (!out.length) out.push({ level: 'info', message: `${g.ok ? 'git 跟踪的' : '目录里的'}文件里没有运行时二进制，B 路线目录里没有上游源码形态的文件` });
    return out;
  },
};
