// 北冥仓库 · agent 执行层测试的目录入口
// 做什么：让验收命令 `node --test tests/agent-layer` 原样可用——Node 22 / 24 的 --test 不接受目录参数，
//         会把目录当模块解析到这个 index.js；这里依次导入本目录下全部 *.test.mjs，在同一个进程里跑完。
// 单独跑某一组：node --test tests/agent-layer/guard-decide.test.mjs；按通配符跑：node --test "tests/agent-layer/*.test.mjs"。
// 本文件不匹配 node --test 的默认文件名规则，按通配符跑时不会重复执行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const name of fs.readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort()) {
  await import(pathToFileURL(path.join(here, name)).href);
}
