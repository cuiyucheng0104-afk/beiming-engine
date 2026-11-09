#!/usr/bin/env node
// 《北冥》原生例片的渲染：等同 node engine/render/native.mjs examples/raea [--check-only] [--at …]。
// 输出 examples/raea/delivery/beiming-raea-10s.mp4 与 delivery/technical.json；原生中间视频与日志在 examples/raea/out/。
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const p = spawnSync(process.execPath, [resolve(here, '../../../engine/render/native.mjs'), resolve(here, '..'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(p.status ?? 1);
