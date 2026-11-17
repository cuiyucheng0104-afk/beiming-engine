// 北冥引擎 · 离屏出片 · Node 里的 Canvas 2D（可选依赖 @napi-rs/canvas，Skia）：给作品画程序化贴图与片名、副标题这一类显示层。
//   loadCanvas() → Promise<{ createCanvas(w, h), GlobalFonts, ... }>   @napi-rs/canvas 模块本身；缺依赖抛 CliError('env.offscreen-deps')（退出码 3）
//   loadFilmFonts(dir) → Promise<fonts>   读 <dir>/fonts.json（tools/fonts/subset.mjs 生成），把每个子集按字族名注册给 Skia；
//                                         返回值与浏览器版 engine/style/fonts.js 的 loadFilmFonts 相同（entry / assert / list），缺字同样抛 GlyphError
// 字形光栅化（Skia 对 Chrome）两边不保证逐像素相同，文字框（measureText）与读字、安全区检查不受影响；实测差距见 docs/offscreen/README.md。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from '../../tools/lib/cli.mjs';
import { parseFontsManifest, fontsOf, GlyphError } from '../style/fonts.js';

let mod = null;
export async function loadCanvas() {
  if (mod) return mod;
  try { mod = await import('@napi-rs/canvas'); }
  catch (e) {
    throw new CliError('env.offscreen-deps', `加载不了离屏出片的 Canvas 2D（${String(e?.message ?? e).split('\n')[0]}）`, {
      hint: '在仓库根运行 npm install --include=optional --ignore-scripts（需要可选依赖 @napi-rs/canvas）',
    });
  }
  return mod;
}

export async function loadFilmFonts(dir) {
  const { GlobalFonts } = await loadCanvas();
  let M;
  try { M = parseFontsManifest(JSON.parse(readFileSync(join(dir, 'fonts.json'), 'utf8'))); }
  catch (e) { throw e instanceof GlyphError ? e : new GlyphError(`找不到或读不了字体清单 ${join(dir, 'fonts.json')}（${e.message}）：先跑 node tools/fonts/subset.mjs <作品目录>`); }
  for (const f of M.fonts) {
    if (!GlobalFonts.registerFromPath(join(dir, f.file), f.family)) throw new GlyphError(`字体子集 ${f.file} 注册失败：文件坏了或被删了，重跑 tools/fonts/subset.mjs`);
  }
  return fontsOf(M);
}
