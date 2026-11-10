// 北冥仓库 · 规范检查 · film 域（出片编排）的共享口径（以 _ 开头，不当规则加载）。
// 规则只读：不渲染、不改文件、不起浏览器；路径一律仓库相对、正斜杠。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** films/ 下的作品目录（相对仓库根，例如 films/chendu）；跳过点开头的目录。链接到别处的作品目录也算（测试作品就是这样放的）。 */
export function filmDirs(ctx) {
  if (!ctx.isDir('films')) return [];
  let names = [];
  try { names = fs.readdirSync(ctx.abs('films'), { withFileTypes: true }).filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.')).map(e => e.name); } catch { return []; }
  return names.filter(n => ctx.isDir(`films/${n}`)).sort().map(n => `films/${n}`);
}

/** 被检查仓库里的模块（--root 指向别的检出时，用那个检出自己的实现）；那边没有时用本检查器所在仓库的实现（夹具仓库）。 */
export async function importFrom(ctx, rel) {
  const there = path.join(ctx.root, ...rel.split('/'));
  return import(pathToFileURL(fs.existsSync(there) ? there : path.join(OWN_ROOT, ...rel.split('/'))).href);
}

export const TEMPLATES = Object.freeze({ a: 'routes/a-webgl/template', b: 'routes/b-native/template', c: 'routes/c-style/template' });
