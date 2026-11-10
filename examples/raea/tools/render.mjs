#!/usr/bin/env node
// 《北冥》原生例片的渲染：等同 node engine/render/native.mjs examples/raea [--check-only] [--at …] [--json]。
// 产物在 examples/raea/out/<run-id>/（master.mp4、web.mp4、run.json、check.json、contact.jpg…），examples/raea/out/latest 指向最近一次。
// 在同一进程里调用通用入口（不再起子进程），退出码、--json 信封、超时与信号处理都与通用入口一致。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWith } from '../../../engine/native/cli.mjs';
import { main } from '../../../engine/render/native.mjs';

await exitWith(main([resolve(dirname(fileURLToPath(import.meta.url)), '..'), ...process.argv.slice(2)]));
