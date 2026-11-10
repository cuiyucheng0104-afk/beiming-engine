#!/usr/bin/env node
// 《北冥》原生例片的准备：等同 node engine/native/prepare.mjs examples/raea（素材清单在 examples/raea/film.json）。
// 产物写进 examples/raea/media/（不提交）：底板（云片带有机软边）、字体许可、鲲与渡船 GLB 及其报告、片名逐帧 PNG、mix.wav、prepared.json。
// 环境变量：PYTHON（需 numpy / scipy / soundfile / numba）、FFMPEG、BEIMING_CHROME。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWith } from '../../../engine/native/cli.mjs';
import { main } from '../../../engine/native/prepare.mjs';

await exitWith(main([resolve(dirname(fileURLToPath(import.meta.url)), '..'), ...process.argv.slice(2)]));
