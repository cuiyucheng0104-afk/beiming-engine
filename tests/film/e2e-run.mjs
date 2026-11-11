#!/usr/bin/env node
// 跨平台地打开端到端测试（PowerShell 写不了 FILM_E2E=1 这种前缀）：node tests/film/e2e-run.mjs [--keep]
//   等价于 FILM_E2E=1 node --test tests/film/e2e.test.mjs；--keep 保留测试作品与产物（FILM_TEST_KEEP=1）。
//   退出码与 node --test 相同（0 全过、1 有失败）；--help 只打印用法。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const a = process.argv.slice(2);
if (a.includes('--help') || a.includes('-h')) {
  console.log('用法：node tests/film/e2e-run.mjs [--keep]\n  真渲染的出片端到端测试（A / C；设了 RAEA_BIN 再加 B）。需要 ffmpeg、装了 requirements.txt 的 PYTHON、Playwright headless shell。');
  process.exit(0);
}
const bad = a.filter(x => x !== '--keep');
if (bad.length) { console.error(`不认识的参数：${bad.join(' ')}（可用：--keep --help）`); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, FILM_E2E: '1', ...(a.includes('--keep') ? { FILM_TEST_KEEP: '1' } : {}) };
const r = spawnSync(process.execPath, ['--test', path.join(here, 'e2e.test.mjs')], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
