// 仓库规范检查 · spec 域（工作包 P05：作品描述、时间轴、创作闸门、交付档位、共享资产）的共用件。以 _ 开头，不当规则加载。
//   engineLibs(ctx)        → Promise<{ film, state, review, assets }>：被检查仓库里的 engine/production 与 engine/assets 库
//                            （--root 指向别的检出时用那份代码；那里没有作品描述库时用本工具所在检出的）
//   filmDirs(ctx)          → ['films/<名>', …]：films/ 下一层的作品目录（不含点开头的暂存目录）
//   finding(level, code, file, message, hint, extra) → repo-check 的 Finding：{ level: error|warn|info, file, line?, message, hint, excerpt? }
//                            诊断码写在 message 开头的方括号里（[shots-not-contiguous] …），方便搜索与测试
//   diagToFinding(d, file) → 把 engine/production 的诊断 { level, code, path, message, hint } 换成 Finding（path 写进 message）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export function engineLibs(ctx) {
  return ctx.memo('spec:engine-libs', async () => {
    const base = fs.existsSync(path.join(ctx.root, 'engine', 'production', 'film.js')) ? ctx.root : OWN_ROOT;
    const imp = rel => import(pathToFileURL(path.join(base, ...rel.split('/'))).href);
    const [film, state, review, assets] = await Promise.all([
      imp('engine/production/film.js'), imp('engine/production/state.js'), imp('engine/production/review.js'), imp('engine/assets/manifest.js'),
    ]);
    return { film, state, review, assets, base };
  });
}

export function filmDirs(ctx) {
  if (!ctx.isDir('films')) return [];
  return ctx.walk('films', { dirs: true, files: false }).filter(d => /^films\/[^/]+$/.test(d) && !d.split('/')[1].startsWith('.'));
}

export function finding(level, code, file, message, hint = null, extra = {}) {
  const lv = level === 'warning' ? 'warn' : level;
  return { level: lv, file, message: `[${code}] ${message}`, hint: hint || null, ...extra };
}

export function diagToFinding(d, file, { level } = {}) {
  const where = d.path && d.path !== '$' ? `${d.path}：` : '';
  return finding(level ?? d.level, d.code, file, `${where}${d.message}`, d.hint);
}

/** 本作品的文件有没有落在这次检查的范围里（--staged 时只看暂存区涉及的作品）。 */
export function filmInScope(ctx, dir) {
  if (ctx.inScope(`${dir}/film.json`)) return true;
  return ctx.walk(dir).some(f => ctx.inScope(f));
}
