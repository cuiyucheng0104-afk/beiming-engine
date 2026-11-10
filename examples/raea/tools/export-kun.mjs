#!/usr/bin/env node
// 只重导鲲与渡船 GLB：等同 node engine/native/bridge/export.mjs examples/raea [--preview]，另可临时改鲲的细节档 --lod 0.4–0.6。
//   node examples/raea/tools/export-kun.mjs [--preview] [--lod 0.5] [--json]
// 鲲走配方 tools/export-kun-browser.mjs，渡船走通用「模块 + 导出名」路径；条目见 examples/raea/film.json 的 native.models。
// 先写 .part、回读断言与结构检查都通过才换名；失败时正式路径上的旧 GLB 不动。退出码同资产桥（0 / 1 / 2 / 3 / 4 / 124）。
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT, exitWith, runCli } from '../../../engine/native/cli.mjs';
import { exportModels } from '../../../engine/native/bridge/export.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `node examples/raea/tools/export-kun.mjs [--preview] [--lod 0.4–0.6] [--json]
  只重导 examples/raea/media/kun.glb 与 ferry.glb（及报告）；--lod 临时改鲲的细节档（默认取 film.json）`;

await exitWith(runCli({
  command: 'export-kun', usage: USAGE, spec: { '--preview': 'bool', '--lod': 'string' },
  main: async a => {
    if (a._.length) throw new CliError(EXIT.USAGE, 'usage', `不需要位置参数：${a._.join(' ')}`);
    const film = JSON.parse(await readFile(resolve(project, 'film.json'), 'utf8'));
    const lod = a.lod !== undefined ? Number(a.lod) : undefined;
    const models = film.native.models.map(m => (m.to === 'kun.glb' && lod !== undefined ? { ...m, lod } : m));
    const kun = models.find(m => m.to === 'kun.glb');
    if (!(kun.lod >= 0.4 && kun.lod <= 0.6)) throw new CliError(EXIT.USAGE, 'lod', `--lod 要在 0.4–0.6 之间：${kun.lod}`);
    const reports = await exportModels(models, { baseDir: project, outDir: resolve(project, 'media'), preview: Boolean(a.preview), timeoutMs: 1000 * Number(process.env.BNE_BRIDGE_TIMEOUT || 900) });
    return { outputs: models.map(m => ({ path: `examples/raea/media/${m.to}`, sha256: reports[m.to].sha256, kind: 'glb' })) };
  },
}));
