// 图纸本身：图框、分区标记、标题、技术要求、明细表、标题栏、签名、红章
import { g, f, cam, LW, line, knock, text, rect, circ, camMatrix, FONT, TAU } from './engine.js';
export const SW = 3400, SH = 2000;
export const TB = { x0: 2560, y0: 1600, x1: 3340, y1: 1940 };   // 标题栏
export function border() {
  line(rect(40, 40, SW - 40, SH - 40), { w: LW.out, closed: true });
  line(rect(64, 64, SW - 64, SH - 64), { w: LW.hair, closed: true, v: .8 });
  for (let i = 1; i < 8; i++) { const x = 40 + i * (SW - 80) / 8; line([[x, 40], [x, 64]], { w: LW.thin }); line([[x, SH - 64], [x, SH - 40]], { w: LW.thin }); }
  for (let i = 1; i < 5; i++) { const y = 40 + i * (SH - 80) / 5; line([[40, y], [64, y]], { w: LW.thin }); line([[SW - 64, y], [SW - 40, y]], { w: LW.thin }); }
  for (let i = 0; i < 8; i++) { const x = 40 + (i + .5) * (SW - 80) / 8; text(String(i + 1), x, 60, { size: 18, align: 'center', font: FONT.tech, v: .8 }); text(String(i + 1), x, SH - 45, { size: 18, align: 'center', font: FONT.tech, v: .8 }); }
  for (let i = 0; i < 5; i++) { const y = 40 + (i + .5) * (SH - 80) / 5 + 7; text('ABCDE'[i], 52, y, { size: 18, align: 'center', font: FONT.tech, v: .8 }); text('ABCDE'[i], SW - 52, y, { size: 18, align: 'center', font: FONT.tech, v: .8 }); }
}
export function header(u = 1) {
  text('擒纵机构', 190, 268, { size: 150, font: FONT.cjk, ls: 18, u, id: 'title' });
  line([[190, 292], [190 + 760 * Math.min(1, u * 1.2), 292]], { w: LW.det });
  line([[190, 302], [190 + 760 * Math.min(1, u * 1.2), 302]], { w: LW.hair });
  text('锚式擒纵器 · 总装图', 196, 352, { size: 44, font: FONT.cjk, ls: 6, u, id: 'subtitle' });
}
export const NOTES = ['1. 擒纵轮 30 齿；摆每过中点一次，轮进半齿。', '2. 摆长 442，半周期 2/3 秒，每分钟 90 拍。', '3. 叉瓦跨 7.5 齿，叉轴距轮心 1.414R。', '4. 未注倒角 C0.5，锐边去毛刺。'];
export function notes() {
  text('技术要求', 2600, 240, { size: 54, font: FONT.cjk, ls: 8 });
  line([[2600, 258], [2840, 258]], { w: LW.thin });
  NOTES.forEach((s, i) => text(s, 2600, 330 + i * 64, { size: 34, font: FONT.hand }));
}
const PARTS = [['1', '擒纵轮', '1', '黄铜', '30 齿'], ['2', '擒纵叉', '1', '钢', ''], ['3', '摆锤', '1', '铅', 'Ø84'], ['4', '三轮', '1', '黄铜', '40 齿'], ['5', '摆杆', '1', '钢', 'L442'], ['6', '夹板', '2', '黄铜', '']];
const COLS = [2560, 2650, 2860, 2950, 3130, 3340];
export function partsList() {
  const y1 = TB.y0, rh = 56, n = PARTS.length;
  const y0 = y1 - rh * (n + 1);
  line(rect(COLS[0], y0, COLS[5], y1), { w: LW.det, closed: true });
  for (let i = 1; i <= n; i++) line([[COLS[0], y0 + i * rh], [COLS[5], y0 + i * rh]], { w: LW.hair });
  for (let c = 1; c < 5; c++) line([[COLS[c], y0], [COLS[c], y1]], { w: LW.hair });
  const hdr = ['序号', '名称', '数量', '材料', '备注'];
  hdr.forEach((h, c) => text(h, (COLS[c] + COLS[c + 1]) / 2, y1 - 18, { size: 28, align: 'center', font: FONT.sc }));
  PARTS.forEach((r, i) => { const y = y1 - rh * (i + 1) - 17; r.forEach((s, c) => s && text(s, (COLS[c] + COLS[c + 1]) / 2, y, { size: 30, align: 'center', font: c === 0 ? FONT.tech : FONT.hand })); });
}
export function titleBlock() {
  const { x0, y0, x1, y1 } = TB;
  line(rect(x0, y0, x1, y1), { w: LW.out, closed: true });
  const ys = [y0 + 110, y0 + 180, y0 + 260];
  for (const y of ys) line([[x0, y], [x1, y]], { w: LW.thin });
  line([[3020, y0], [3020, y1]], { w: LW.thin });
  line([[2680, ys[0]], [2680, y1]], { w: LW.hair }); line([[3120, ys[0]], [3120, y1]], { w: LW.hair });
  text('擒纵机构', 2590, y0 + 80, { size: 64, font: FONT.sc, ls: 10 });
  text('图号', 3040, y0 + 40, { size: 24, font: FONT.sc, v: .85 }); text('QZ-019', 3040, y0 + 88, { size: 40, font: FONT.tech });
  text('比例', 2590, ys[0] + 46, { size: 26, font: FONT.sc }); text('1 : 1', 2700, ys[0] + 48, { size: 32, font: FONT.tech });
  text('张数', 3040, ys[0] + 46, { size: 26, font: FONT.sc }); text('1 / 1', 3140, ys[0] + 48, { size: 32, font: FONT.tech });
  text('设计', 2590, ys[1] + 52, { size: 26, font: FONT.sc }); text('日期', 3040, ys[1] + 52, { size: 26, font: FONT.sc }); text('2026.10', 3140, ys[1] + 54, { size: 30, font: FONT.tech });
  text('审核', 2590, ys[2] + 50, { size: 26, font: FONT.sc }); text('状态', 3040, ys[2] + 50, { size: 26, font: FONT.sc });
}
// 签名（草书，虚构）：u = 书写进度
export function signature(u) { if (u > 0) text('林墨', 2720, TB.y0 + 248, { size: 74, font: FONT.sign, u }); }
// 红章（全片唯一的非蓝颜色）：a = 墨量，s = 落章缩放。
// 盖在标题栏左侧的空白处（不压任何字），直径约 290 图纸单位 ≈ 全景下 150 px
export const STAMP = { x: 2405, y: 1768, k: 2.35 };
export function stamp(a, s = 1) {
  if (a <= 0) return;
  f.globalCompositeOperation = 'lighter';
  camMatrix(f, STAMP.x, STAMP.y, -.16); f.scale(s * STAMP.k, s * STAMP.k);
  f.strokeStyle = `rgba(0,0,255,${a})`; f.lineWidth = 7; f.beginPath(); f.arc(0, 0, 62, 0, TAU); f.stroke();
  f.lineWidth = 2.5; f.beginPath(); f.arc(0, 0, 53, 0, TAU); f.stroke();
  f.fillStyle = `rgba(0,0,255,${a})`; f.font = `700 44px NotoSC`; f.textAlign = 'center'; f.textBaseline = 'middle';
  f.fillText('核准', 0, 3);
  f.setTransform(1, 0, 0, 1, 0, 0);
}
