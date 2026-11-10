#!/usr/bin/env node
// 北冥仓库 · 仓库规范检查（只读，给 agent、CI 与提交钩子用）：
//   npm run check:repo                       全部规则
//   node tools/repo-check.mjs --only core    只跑一个域（core、comp、agent …）或一条规则（core.links）
//   node tools/repo-check.mjs --json         stdout 只输出一个 JSON 对象（docs/CLI.md 的信封，data 里是逐条结果）
//   node tools/repo-check.mjs --list         列出全部规则
// 退出码：0 没有错误；4 有规范错误；2 用法错误；1 规则自身出错。
// 框架在 tools/repo-check/core/（加载器、上下文、报告、限期豁免），规则在 tools/repo-check/rules/<域>/；
// 写规则见 tools/repo-check/core/README.md。
import { isMain, runCli } from './lib/cli.mjs';
import { command } from './repo-check/core/index.mjs';

export { command };
if (isMain(import.meta.url)) await runCli(command);
