#!/usr/bin/env node
// 帧源变更分类器（I6）：PR 的变更路径是否触及帧源与一致性边界；只有触及时 conformance-5090.yml 才排 5090 显卡队。
//   git diff --name-only --no-renames <base>...<head> | node tests/ci/conformance-filter.mjs >> "$GITHUB_OUTPUT"
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

export function classifyConformancePaths(paths) {
  const matched = paths
    .map(p => String(p).trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(p => FRAME_SOURCE_PREFIXES.some(pre => p.startsWith(pre)));
  return { frame_sources_changed: matched.length > 0, matched };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = classifyConformancePaths(readFileSync(0, 'utf8').split(/\r?\n/));
  for (const p of r.matched) process.stderr.write(`帧源变更：${p}\n`);
  process.stdout.write(`frame_sources_changed=${r.frame_sources_changed}\n`);
}
