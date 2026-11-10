// 让 `node --test tests/cli` 在 Node 22+ 照样跑完整个目录：Node 22 起 --test 的参数按文件或 glob 解析，
// 给目录时会把它当模块加载（解析到本文件），这里按字典序载入同目录的全部 *.test.mjs。
// 用 glob 跑（node --test "tests/**/*.test.mjs"，tools/run-tests.mjs 也是这样）不会匹配本文件，不会重复执行。
import { readdirSync } from 'node:fs';

const here = new URL('./', import.meta.url);
for (const f of readdirSync(here).filter(n => n.endsWith('.test.mjs')).sort()) await import(new URL(f, here));
