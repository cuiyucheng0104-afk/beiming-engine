#!/usr/bin/env node
// 《北冥》原生例片的准备：等同 node engine/native/prepare.mjs examples/raea（素材清单在 examples/raea/film.json；选项与退出码相同）。
// 产物写进 examples/raea/media/（不提交）：底板（云片带有机软边）、字体许可、鲲与渡船 GLB 及其报告、片名逐帧 PNG、mix.wav、prepared.json。
// Python 用仓库统一的解释器（npm run setup 建的 .venv，或 BEIMING_PYTHON / PYTHON 指定；需 numpy / scipy / soundfile / numba）。
// 其余环境变量同通用入口：FFMPEG、BEIMING_CHROME（资产桥与片名序列帧用的无头浏览器）。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWith } from '../../../engine/native/cli.mjs';
import { command as prepare } from '../../../engine/native/prepare.mjs';
import { defineCommand, isMain, runCli } from '../../../tools/lib/cli.mjs';

const EXAMPLE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GLOBAL = new Set(['json', 'quiet', 'help', 'version']);

export const command = defineCommand({
  name: 'raea:prepare',
  summary: '《北冥》原生例片（examples/raea）的素材准备；等同 node engine/native/prepare.mjs examples/raea',
  usage: ['node examples/raea/tools/prepare.mjs [--only images,models,sequences,audio] [--preview] [--json]'],
  description: prepare.description,
  options: Object.fromEntries(Object.entries(prepare.options).filter(([k]) => !GLOBAL.has(k))),
  exitCodes: prepare.exitCodes,
  examples: ['node examples/raea/tools/prepare.mjs', 'node examples/raea/tools/prepare.mjs --only models'],
  run: ctx => prepare.run({ ...ctx, args: { film: EXAMPLE } }),
});

if (isMain(import.meta.url)) await exitWith(runCli(command));
