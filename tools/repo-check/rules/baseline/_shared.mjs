// 画面基线规则（baseline 域）的共用小工具。以 _ 开头，规则加载器不把它当规则。
// 规则只读：不渲染、不开浏览器、不改文件。规则与工具共用 tools/baseline/lib/ 的校验函数，判据只有一份。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { validateSets } from '../../../baseline/lib/sets.mjs';

export const SETS = 'tools/baseline/sets.json';
// 清单里不该出现的本机绝对路径（macOS / Linux 家目录、Windows 用户目录、系统临时目录）
export const LOCAL_PATH = /(?:\/Users\/[^/"]+\/|\/home\/[^/"]+\/|[A-Za-z]:\\\\Users\\\\|\/private\/var\/|\/private\/tmp\/)/;
export const IMAGE_OR_VIDEO = /\.(png|jpe?g|webp|gif|avif|bmp|mp4|mov|webm|mkv|exr|tiff?)$/i;

/** tools/baseline/sets.json → { sets } 或 { error }（结构不合法时 sets 为 null）。 */
export function loadSets(ctx) {
  return ctx.memo('baseline:sets', () => {
    if (!ctx.exists(SETS)) return { sets: null, error: `没有 ${SETS}` };
    let j;
    try { j = JSON.parse(ctx.read(SETS)); } catch (e) { return { sets: null, error: `读不出来（${e.message}）` }; }
    const errs = validateSets(j);
    return errs.length ? { sets: null, error: errs.join('；') } : { sets: j, error: null };
  });
}

/** 仓库跟踪的文件（git ls-files）；不是 git 检出（例如解压的发行包）时退回目录遍历。 */
export function trackedFiles(ctx, dir) {
  const g = ctx.git(['ls-files', '-z', '--', dir]);
  if (g.ok) return g.stdout.split('\0').filter(Boolean);
  return ctx.walk(dir);
}

export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
export const sha256File = abs => sha256(fs.readFileSync(abs));
export const readJsonAbs = abs => JSON.parse(fs.readFileSync(abs, 'utf8'));
