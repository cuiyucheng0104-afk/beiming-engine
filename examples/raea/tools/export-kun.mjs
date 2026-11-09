#!/usr/bin/env node
// 只重导鲲与渡船 GLB：等同 node engine/native/bridge/export.mjs examples/raea [--preview]。
//   node examples/raea/tools/export-kun.mjs [--preview] [--lod=0.5]
// 鲲走配方 tools/export-kun-browser.mjs，渡船走通用「模块 + 导出名」路径；条目见 examples/raea/film.json 的 native.models。
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportModels } from '../../../engine/native/bridge/export.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const film = JSON.parse(await readFile(resolve(project, 'film.json'), 'utf8'));
const lod = process.argv.find(x => x.startsWith('--lod='));
const models = film.native.models.map(m => m.to === 'kun.glb' && lod ? { ...m, lod: Number(lod.slice(6)) } : m);
const kun = models.find(m => m.to === 'kun.glb');
if (!(kun.lod >= 0.4 && kun.lod <= 0.6)) throw new Error('LOD must be in [0.4, 0.6].');
await exportModels(models, { baseDir: project, outDir: resolve(project, 'media'), preview: process.argv.includes('--preview') });
