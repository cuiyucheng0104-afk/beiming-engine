// 测试夹具 · 预加载钩子：只把出片编排器启动机器 QA 门的那一次子进程换成测试替身 qa-stub.mjs，其余子进程原样启动。
//   node --import <本文件的 file:// 地址> tools/film/cli.mjs build …    （tests/film/helpers.mjs 的 runCli(…, { stubQa: true })）
// 编排器里不留「换一个 QA 实现」的环境变量或选项：那样的开关就是绕过硬门的后门，所以替身只能由测试从进程外面接上。
// 认的调用形状：spawn(node, ['<仓库>/tools/qa/cli.mjs', 'report', …])（tools/film/lib/qa.mjs 的 runQa → lib/proc.mjs 的 exec）。
// 只对加了 --import 的这一个进程生效，不传给子进程（没有用 NODE_OPTIONS）。
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL = path.join(here, '../../../tools/qa/cli.mjs');
const STUB = path.join(here, 'qa-stub.mjs');
const spawn = cp.spawn;
cp.spawn = (cmd, args, ...rest) => spawn(cmd, Array.isArray(args) && args[0] === REAL ? [STUB, ...args.slice(1)] : args, ...rest);
// 让 `import { spawn } from 'node:child_process'` 的具名导入也拿到替换后的函数
syncBuiltinESMExports();
