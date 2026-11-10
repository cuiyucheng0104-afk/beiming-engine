// 《北冥》原生例片 · 毛笔片名页面：A 路的写字代码（engine/overlay/brush.js）按笔顺把「北冥」一笔一笔写出来，收笔带飞白，
// 白字 + 暖色光晕 + 字下一层冷色暗晕（保证压在薰衣草色天空上的对比度）。画在透明画布上，原生端把逐帧 PNG 叠在三维之上。
//   window.DUR = 1.0          写字 0–0.86 秒（「北」0–0.36、「冥」0.40–0.86），之后停在写完的样子
//   window.render(t)          纯函数：同一个 t 永远画出同一张图（字形每个画面尺寸只预计算一次）
//   window.TEXTS(t)           [{ text, box:[x, y, w, h], alpha, font }]，给检查用
// 版式来自 ../layout.js 的 title（画面比例），与 film.tsx、tests/native 共用一份。
// 笔画骨架用 src/hud.js 导出的 __TITLE_SKEL（《北冥》正片片名的同一份手标骨架，只读引用）；
// 飞白强度 DRY 与 src/hud.js:308 同值（那里没有导出）——改那里时这里一起改。
import { buildBrushGlyph, paintBrushGlyph } from '../../../engine/overlay/brush.js';
import { shadowOnly } from '../../../engine/paint/canvas.js';
import { loadFonts } from '../../../engine/overlay/text.js';
import { __TITLE_SKEL as SKEL } from '../../../src/hud.js';
import { layout, titleBox } from '../layout.js';

const DRY = { '北': [0, 0, 0.7, 0.6, 0.45], '冥': [0, 0.4, 0, 0.25, 0, 0, 0, 0.5, 0.7, 0.35] };
const SPAN = { '北': [0, 0.36], '冥': [0.40, 0.86] };
const FAMILY = 'BeimingBrushTitle';
const cv = document.getElementById('title');
const W = innerWidth, H = innerHeight, S = H / 1040;
cv.width = W; cv.height = H;
const ctx = cv.getContext('2d');

window.DUR = 1.0;
window.FPS = 24;

let G = null, T = null;
async function init() {
  await loadFonts([[FAMILY, new URL('../../../fonts/MaShanZheng-400.woff2', import.meta.url).href, '400']]);
  const film = await (await fetch(new URL('../film.json', import.meta.url))).json();
  const L = layout({ W, H, FPS: film.fps, frames: Math.round(film.dur * film.fps) });
  T = titleBox({ W, H }, L.title);
  G = T.glyphs.map(([ch]) => buildBrushGlyph(ch, { font: `400 ${T.F.toFixed(2)}px "${FAMILY}"`, size: T.F, strokes: SKEL[ch], span: SPAN[ch], dry: DRY[ch] }));
  window.READY = true;
}

window.render = t => {
  ctx.clearRect(0, 0, W, H);
  if (!G) return;
  const far = 4 * W;
  T.glyphs.forEach(([, x, y], i) => {
    const g = G[i];
    if (!paintBrushGlyph(g, t, { edge: 0.035, rgb: [255, 252, 246] })) return;
    const gx = x - g.size / 2, gy = y - g.size / 2;
    shadowOnly(ctx, g.out, gx, gy + 5 * S, 'rgba(30,28,82,0.42)', 30 * S, far);     // 冷色暗晕：托住白字
    shadowOnly(ctx, g.out, gx, gy, 'rgba(255,190,140,0.50)', 36 * S, far);          // 暖色外晕
    shadowOnly(ctx, g.out, gx, gy, 'rgba(255,214,180,0.42)', 10 * S, far);          // 暖色内晕
    ctx.drawImage(g.out, gx, gy);
  });
};

window.TEXTS = t => (T && t >= SPAN['北'][0] ? [{ text: '北冥', box: [T.box[0], T.box[1], T.box[2] - T.box[0], T.box[3] - T.box[1]], alpha: Math.min(1, t / 0.2), font: FAMILY }] : []);

init().catch(e => { console.error(e); throw e; });
