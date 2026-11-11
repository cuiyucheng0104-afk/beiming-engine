// route-b.cli-contract：B 路线的每个命令行入口（带 #!/usr/bin/env node 的文件）都用仓库命令约定库 tools/lib/cli.mjs 的 runCli——
// --help 无副作用、未知参数 exit 2、--json 单信封、附录 C1 退出码（docs/CLI.md）。防止退回「自己解析 process.argv」的写法。
import { B_CODE, nodeSources } from './_shared.mjs';

export default {
  id: 'route-b.cli-contract',
  title: 'B 路线的命令行入口都用 tools/lib/cli.mjs（--help、--json、退出码同一套）',
  run(ctx) {
    const out = [];
    const entries = nodeSources(ctx, B_CODE).filter(f => ctx.read(f).startsWith('#!/usr/bin/env node'));
    for (const f of entries) {
      if (!ctx.inScope(f)) continue;
      const src = ctx.read(f);
      if (!/tools\/lib\/cli\.mjs['"]/.test(src) || !/\brunCli\(/.test(src)) {
        out.push({ level: 'error', file: f, message: '命令行入口没有用 tools/lib/cli.mjs 的 defineCommand + runCli', hint: '照 tools/lib/README.md「写一个 Node 命令」改；子进程与清理用 engine/native/cli.mjs' });
      }
    }
    if (!out.length) out.push({ level: 'info', message: `${entries.length} 个 B 路线入口都用命令约定库` });
    return out;
  },
};
