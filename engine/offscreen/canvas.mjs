// 北冥引擎 · 离屏出片 · Node 里的 Canvas 2D（可选依赖 @napi-rs/canvas，Skia）：给作品画程序化贴图与片名、副标题这一类显示层。
//   loadCanvas() → Promise<{ createCanvas(w, h), GlobalFonts, ... }>
//     首次调用时安装最小 globalThis.document（只允许 createElement('canvas')，让 engine/overlay 与 engine/paint 直接可用），
//     并挂上零开销的 QA 画字探针钩子；缺依赖抛 CliError('env.offscreen-deps')（退出码 3）。
//   loadFilmFonts(dir) → Promise<fonts>   读 <dir>/fonts.json（tools/fonts/subset.mjs 生成），把每个子集按字族名注册给 Skia；
//                                         返回值与浏览器版 engine/style/fonts.js 的 loadFilmFonts 相同（entry / assert / list），缺字同样抛 GlyphError
//   recordRegisteredFont(meta) / listRegisteredFonts()   登记与枚举离屏已注册的字体文件（供机器 QA 的 texts.glyphs 核对 cmap）
// 字形光栅化（Skia 对 Chrome）两边不保证逐像素相同，文字框（measureText）与读字、安全区检查不受影响；实测差距见 docs/offscreen/README.md。
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CliError } from '../../tools/lib/cli.mjs';
import { parseFontsManifest, fontsOf, GlyphError } from '../style/fonts.js';

let mod = null;
let ctxHooked = false;
const registeredFonts = new Map();

function alphaOfStyle(s) {
  if (typeof s !== 'string') return 1;
  let m = /^#([0-9a-f]{8})$/i.exec(s);
  if (m) return parseInt(m[1].slice(6), 16) / 255;
  m = /rgba?\(([^)]*)\)/i.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    if (p.length >= 4) return p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
  }
  return 1;
}

function installQaContextHook(createCanvas) {
  if (ctxHooked) return;
  ctxHooked = true;
  const proto = Object.getPrototypeOf(createCanvas(1, 1).getContext('2d'));
  if (!proto) return;
  let nextCanvasId = 1;
  const canvasIds = new WeakMap();
  const idOf = cv => {
    if (!cv) return 0;
    let id = canvasIds.get(cv);
    if (!id) { id = nextCanvasId++; canvasIds.set(cv, id); }
    return id;
  };
  for (const name of ['fillText', 'strokeText']) {
    const orig = proto[name];
    if (typeof orig !== 'function') continue;
    proto[name] = function (text, x, y, ...rest) {
      const qa = globalThis.__BMQA_OFFSCREEN;
      if (!qa) return orig.call(this, text, x, y, ...rest);
      if (qa.rec) {
        const str = String(text);
        try {
          const t = this.getTransform();
          const m = this.measureText(str);
          const L = x - (m.actualBoundingBoxLeft ?? 0);
          const R = x + (m.actualBoundingBoxRight ?? m.width ?? 0);
          const T = y - (m.actualBoundingBoxAscent ?? 0);
          const B = y + (m.actualBoundingBoxDescent ?? 0);
          const pts = [[L, T], [R, T], [L, B], [R, B]].map(([px, py]) => [t.a * px + t.c * py + t.e, t.b * px + t.d * py + t.f]);
          const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
          const cv = this.canvas;
          qa.runs.push({
            op: name,
            text: str,
            font: this.font,
            filter: this.filter && this.filter !== 'none' ? this.filter : null,
            alpha: (this.globalAlpha ?? 1) * alphaOfStyle(name === 'fillText' ? this.fillStyle : this.strokeStyle),
            canvas: idOf(cv),
            attached: !!(cv && cv.__bmOverlay),
            box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
            loaded: true,
          });
        } catch (e) {
          qa.runs.push({ op: name, text: str, font: this.font, error: String(e) });
        }
      }
      if (qa.hide === 'text' || qa.hide === 'layer') return undefined;
      return orig.call(this, text, x, y, ...rest);
    };
  }
}

export function installCanvasDocument(createCanvas) {
  globalThis.document ??= {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error(`离屏没有 DOM：只能建画布，收到 <${tag}>`);
      return createCanvas(1, 1);
    },
  };
}

export function recordRegisteredFont({ file, family, weight = '400', style = 'normal', unicodeRange = '' }) {
  const abs = resolve(file);
  const key = `${abs}|${family}|${weight}|${style}|${unicodeRange}`;
  registeredFonts.set(key, { file: abs, family: String(family), weight: String(weight), style: String(style), unicodeRange: String(unicodeRange) });
}

export function listRegisteredFonts() {
  return [...registeredFonts.values()];
}

export function clearRegisteredFonts() {
  registeredFonts.clear();
}

export async function loadCanvas() {
  if (mod) {
    installCanvasDocument(mod.createCanvas);
    return mod;
  }
  try { mod = await import('@napi-rs/canvas'); }
  catch (e) {
    throw new CliError('env.offscreen-deps', `加载不了离屏出片的 Canvas 2D（${String(e?.message ?? e).split('\n')[0]}）`, {
      hint: '在仓库根运行 npm install --include=optional --ignore-scripts（需要可选依赖 @napi-rs/canvas）',
    });
  }
  installCanvasDocument(mod.createCanvas);
  installQaContextHook(mod.createCanvas);
  return mod;
}

export async function loadFilmFonts(dir) {
  const { GlobalFonts } = await loadCanvas();
  let M;
  try { M = parseFontsManifest(JSON.parse(readFileSync(join(dir, 'fonts.json'), 'utf8'))); }
  catch (e) { throw e instanceof GlyphError ? e : new GlyphError(`找不到或读不了字体清单 ${join(dir, 'fonts.json')}（${e.message}）：先跑 node tools/fonts/subset.mjs <作品目录>`); }
  for (const f of M.fonts) {
    const abs = join(dir, f.file);
    if (!GlobalFonts.registerFromPath(abs, f.family)) throw new GlyphError(`字体子集 ${f.file} 注册失败：文件坏了或被删了，重跑 tools/fonts/subset.mjs`);
    recordRegisteredFont({ file: abs, family: f.family, weight: f.weight ?? '400', style: f.style ?? 'normal', unicodeRange: f.unicodeRange ?? '' });
  }
  return fontsOf(M);
}
