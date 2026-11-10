#!/usr/bin/env node
// 《北冥》原生例片的渲染：等同 node engine/render/native.mjs examples/raea [--check-only] [--at …] [--json]（选项与退出码完全相同）。
// 产物在 examples/raea/out/<run-id>/（master.mp4、web.mp4、run.json、check.json、qa/、contact.jpg…），examples/raea/out/latest 指向最近一次。
// 在同一进程里调用通用入口（不再起子进程）；命令约定（--help 无副作用、未知参数 exit 2、--json 信封）用 tools/lib/cli.mjs。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWith } from '../../../engine/native/cli.mjs';
import { command as native } from '../../../engine/render/native.mjs';
import { defineCommand, isMain, runCli } from '../../../tools/lib/cli.mjs';

const EXAMPLE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GLOBAL = new Set(['json', 'quiet', 'help', 'version']);

export const command = defineCommand({
  name: 'raea:render',
  summary: '《北冥》原生例片（examples/raea）的预检、草图帧与出片；等同 node engine/render/native.mjs examples/raea',
  usage: ['node examples/raea/tools/render.mjs [--check-only | --at 0,111,239] [选项]'],
  description: native.description,
  options: Object.fromEntries(Object.entries(native.options).filter(([k]) => !GLOBAL.has(k))),
  exitCodes: native.exitCodes,
  examples: ['node examples/raea/tools/render.mjs --check-only', 'node examples/raea/tools/render.mjs --at 0,111,239', 'node examples/raea/tools/render.mjs --json'],
  run: ctx => native.run({ ...ctx, args: { film: EXAMPLE } }),
});

if (isMain(import.meta.url)) await exitWith(runCli(command));
