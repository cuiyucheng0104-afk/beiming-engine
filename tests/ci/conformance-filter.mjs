#!/usr/bin/env node
// 帧源变更分类器（I6）：PR 的变更路径是否触及帧源与一致性边界；只有触及时 conformance-5090.yml 才排 5090 显卡队。
//   git diff -z --name-only --no-renames <base>...<head> | node tests/ci/conformance-filter.mjs --null >> "$GITHUB_OUTPUT"
// 工作流一律用 -z / --null：不带 -z 时 git 会把中文、制表符等路径加引号转义（"beiming/sources/\346..."），前缀就对不上了。
// 路径原样比较、不 trim：顶层目录可以合法地以空格开头（" beiming/sources/x" 不是帧源目录）。
// stdout 只有一行 frame_sources_changed=true|false；命中的路径打到 stderr 供日志查看。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 目录前缀一律以 / 结尾：beiming/sources-notes/ 之类的相近目录不会误命中
export const FRAME_SOURCE_PREFIXES = [
  'beiming/sources/',
  'beiming/host/',
  'beiming/kernel/conformance/',
  'beiming/kernel/contracts/source/',
  'beiming/kernel/contracts/meta/',
  'beiming/calib/',
];

// gitNull：输入来自 git diff -z。git 在所有平台都输出 /，这时 \ 是文件名里的普通字符（POSIX 上 beiming\sources\x 是根目录的一个文件），不能当分隔符
export function classifyConformancePaths(paths, { gitNull = false } = {}) {
  const matched = paths
    .map(p => (gitNull ? String(p) : String(p).replace(/\\/g, '/')).replace(/^\.\//, ''))
    .filter(p => FRAME_SOURCE_PREFIXES.some(pre => p.startsWith(pre)));
  return { frame_sources_changed: matched.length > 0, matched };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const gitNull = process.argv.includes('--null');
  const r = classifyConformancePaths(readFileSync(0, 'utf8').split(gitNull ? '\0' : /\r?\n/), { gitNull });
  for (const p of r.matched) process.stderr.write(`帧源变更：${p}\n`);
  process.stdout.write(`frame_sources_changed=${r.frame_sources_changed}\n`);
}
