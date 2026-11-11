#!/usr/bin/env node
// 只重导鲲与渡船 GLB：等同 node engine/native/bridge/export.mjs examples/raea [--preview]，另可临时改鲲的细节档 --lod 0.4–0.6。
//   node examples/raea/tools/export-kun.mjs [--preview] [--lod 0.5] [--timeout 秒] [--json]
// 鲲走配方 tools/export-kun-browser.mjs，渡船走通用「模块 + 导出名」路径；条目见 examples/raea/film.json 的 native.models。
// 先写 .part、回读断言与结构检查都通过才换名；失败时正式路径上的旧 GLB 不动。退出码同资产桥（0 / 1 / 2 / 3 / 4 / 124）。
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, bind, exitWith, fail } from '../../../engine/native/cli.mjs';
import { exportModels } from '../../../engine/native/bridge/export.mjs';
import { defineCommand, isMain, runCli } from '../../../tools/lib/cli.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const command = defineCommand({
  name: 'raea:export-kun',
  summary: '只重导 examples/raea/media/kun.glb 与 ferry.glb（及报告）',
  usage: ['node examples/raea/tools/export-kun.mjs [--preview] [--lod 0.4–0.6] [--timeout <秒>] [--json]'],
  options: {
    preview: { type: 'boolean', describe: '另存鲲的回读预览图（kun-preview.png）' },
    lod: { type: 'number', arg: '<0.4–0.6>', min: 0.4, max: 0.6, describe: '临时改鲲的细节档（默认取 film.json）' },
    timeout: { type: 'number', arg: '<秒>', min: 1, describe: '整批导出的超时（默认 900）' },
  },
  exitCodes: { 0: '成功', 1: '导出 / 回读失败', 2: '用法错误', 3: '缺浏览器或依赖', 4: '结构检查不通过', 124: '超时' },
  async run(ctx) {
    bind(ctx);
    const film = JSON.parse(await readFile(resolve(project, 'film.json'), 'utf8'));
    const models = film.native.models.map(m => (m.to === 'kun.glb' && ctx.opts.lod !== null ? { ...m, lod: ctx.opts.lod } : m));
    const kun = models.find(m => m.to === 'kun.glb');
    if (!(kun.lod >= 0.4 && kun.lod <= 0.6)) throw fail(EXIT.CONTRACT, 'lod', `examples/raea/film.json 里鲲的 lod 要在 0.4–0.6 之间：${kun.lod}`);
    const reports = await exportModels(models, { baseDir: project, outDir: resolve(project, 'media'), preview: ctx.opts.preview, timeoutMs: 1000 * (ctx.opts.timeout ?? 900) });
    return { outputs: models.map(m => ({ path: `examples/raea/media/${m.to}`, sha256: reports[m.to].sha256, kind: 'glb' })) };
  },
});

if (isMain(import.meta.url)) await exitWith(runCli(command));
