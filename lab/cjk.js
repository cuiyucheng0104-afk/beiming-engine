// 中文排字自测页：?test=cjk
// 左：不处理（逐字等宽硬排，到宽度就断）；中：layoutText（禁则、挤压、中西文间距）；右上：balance 的两行片名；右下：center 对齐。
// 画出排版框边线（红）与行首行尾参考线，一眼看出行首行尾有没有标点、挤压前后的差别。&grid=1 再画每个字的前进宽度刻度。
// 字体：需要完整的 Noto Sans SC（fonts/ 下的是几十个字的子集，没有这些标点）。先 npm run fonts:fetch，再
//   mkdir -p out/fonts && cp ".cache/fonts/NotoSansSC[wght].ttf" out/fonts/NotoSansSC-full.ttf    （.cache 以点开头，渲染器的静态服务不给，所以拷到 out/）
// 出静帧：node engine/render/still.mjs . 0 --size 1280x720 --query test=cjk --out out/lab
import { layoutText, canvasMeasure } from '../engine/overlay/cjk.js';
import { loadFonts, fontSpec } from '../engine/overlay/text.js';

const Q = new URLSearchParams(location.search);
const W = innerWidth, H = innerHeight, S = W / 1280;
const cv = document.createElement('canvas'); cv.width = W; cv.height = H; document.body.style.margin = '0'; document.body.appendChild(cv);
const ctx = cv.getContext('2d');

const FAM = 'CJK Lab SC';
await loadFonts([[FAM, new URL('../out/fonts/NotoSansSC-full.ttf', import.meta.url).href, '100 900']])
  .catch(e => { throw new Error(`${e.message}\n先把完整 Noto Sans SC 拷到 out/fonts/NotoSansSC-full.ttf（见本文件头注释）`); });
const font = px => fontSpec(400, px, [FAM]);

const TEXT = '他说：“排版不是小事，”她回道——《北冥》里的字是 Canvas 2D 逐字画的，占 3.5% 的画面……「真的吗？」(2026)';
const TITLE = '北冥有鱼，其名为鲲，鲲之大不知其几千里也';

// 不处理：逐字，到宽度就断
function naive(text, size, maxWidth, measure) {
  const glyphs = []; let x = 0, line = 0;
  for (const ch of text) { const w = measure(ch); if (x + w > maxWidth && x > 0) { line++; x = 0; } glyphs.push({ ch, x, line, w }); x += w; }
  return { glyphs, lines: line + 1 };
}

function drawBox(x, y, w, h, label, S1 = S) {
  ctx.save();
  ctx.strokeStyle = 'rgba(214,40,57,.85)'; ctx.lineWidth = 1 * S1; ctx.strokeRect(x + .5, y + .5, w, h);
  ctx.fillStyle = '#8a8478'; ctx.font = `${12 * S1}px sans-serif`; ctx.fillText(label, x, y - 8 * S1);
  ctx.restore();
}
function drawGlyphs(gl, ox, oy, size, color = '#201c17') {
  ctx.font = font(size); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.fillStyle = color;
  for (const g of gl) ctx.fillText(g.ch, ox + g.x, oy + g.y);
}
function ticks(gl, ox, oy, size) {
  if (!Q.get('grid')) return;
  ctx.save(); ctx.strokeStyle = 'rgba(40,90,200,.35)'; ctx.lineWidth = 1;
  for (const g of gl) { ctx.beginPath(); ctx.moveTo(ox + g.x, oy + g.y + 3 * S); ctx.lineTo(ox + g.x + g.w, oy + g.y + 3 * S); ctx.stroke(); }
  ctx.restore();
}

window.DUR = 1;
window.render = () => {
  ctx.fillStyle = '#f3eee4'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#201c17'; ctx.font = font(22 * S); ctx.fillText('中文排字 · layoutText 对照', 40 * S, 44 * S);

  const size = 26 * S, bw = 360 * S, top = 100 * S;
  const m = canvasMeasure(font(size));

  // 左：不处理
  const n = naive(TEXT, size, bw, m), lh = 1.7 * size;
  const nGl = n.glyphs.map(g => ({ ...g, y: g.line * lh + (lh - size) / 2 + 0.88 * size }));
  drawBox(40 * S, top, bw, n.lines * lh, '不处理（逐字硬排）');
  drawGlyphs(nGl, 40 * S, top, size);

  // 中：layoutText
  const r = layoutText(TEXT, { size, maxWidth: bw, measure: m });
  drawBox(430 * S, top, bw, r.height, 'layoutText（禁则 + 挤压 + 中西文间距）');
  drawGlyphs(r.glyphs, 430 * S, top, size); ticks(r.glyphs, 430 * S, top, size);

  // 右上：balance 片名；右下：center 对齐
  const ts = 36 * S, tw = 400 * S, tm = canvasMeasure(font(ts));
  const plain = layoutText(TITLE, { size: ts, maxWidth: tw, measure: tm });
  const bal = layoutText(TITLE, { size: ts, maxWidth: tw, measure: tm, balance: true, align: 'center' });
  const rx = 840 * S;
  drawBox(rx, top, tw, plain.height, '片名 · 贪心断行');
  drawGlyphs(plain.glyphs, rx, top, ts);
  const by = top + plain.height + 52 * S;
  drawBox(rx, by, tw, bal.height, '片名 · balance + center');
  drawGlyphs(bal.glyphs, rx, by, ts);
  const cs = 24 * S, cm = canvasMeasure(font(cs));
  const ce = layoutText('「要挤进去，」“不空整字。”\nLine two 含 English 与 12.5%', { size: cs, maxWidth: tw, measure: cm, align: 'center' });
  const cy = by + bal.height + 52 * S;
  drawBox(rx, cy, tw, ce.height, 'center 对齐 + 硬换行');
  drawGlyphs(ce.glyphs, rx, cy, cs); ticks(ce.glyphs, rx, cy, cs);

  // 行首行尾参考线之外的说明
  ctx.fillStyle = '#8a8478'; ctx.font = `${13 * S}px sans-serif`;
  ctx.fillText('红框 = 排版框；对照：左侧行首出现 ，。」 等、行尾出现 “「 等，右侧不会；右侧行尾标点与相邻标点已挤压（&grid=1 看前进宽度）', 40 * S, 690 * S);
};
window.READY = true;
