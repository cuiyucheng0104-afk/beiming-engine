// 灯塔守夜 · 舞台：纸边、镜头、印刷、题签
import * as WC from './engine/index.js';

export const W = 1920, H = 1080;
export const IMG = { x: 36, y: 36, w: 1848, h: 912 };       // 印出的画面区；下方 132 px 纸边放题签
export const PW = 1848, PH = 912;                            // 宽景世界坐标 = 版面大小
export const [M, m] = WC.canvas(W, H);                       // 刻版遮罩：白 = 刻掉
export const [C, c] = WC.canvas(W, H);                       // 套色版（alpha = 密度）
export const INK = '#111111', PAPER = '#EFE8D8', RED = '#C2361F', WOOD = '#D6BE96';
let P = null;
export const printer = () => P || (P = WC.makePrinter(W, H));

// 镜头：世界坐标中心 (x,y)、缩放 z、滚转 r → 屏幕仿射。世界 → 屏幕只走这一个函数。
export function camMatrix(cam) {
  const z = cam.z ?? 1, r = cam.r ?? 0, cs = Math.cos(r) * z, sn = Math.sin(r) * z;
  const ox = IMG.x + IMG.w / 2 + (cam.ox ?? 0), oy = IMG.y + IMG.h / 2 + (cam.oy ?? 0);
  return [cs, sn, -sn, cs, ox - (cs * cam.x - sn * cam.y), oy - (sn * cam.x + cs * cam.y)];
}
export const apply = (k, x, y) => [k[0] * x + k[2] * y + k[4], k[1] * x + k[3] * y + k[5]];

// 一帧印刷画面开始：纸（遮罩白）→ 裁到画面区 → 填黑木 → 套镜头
export function beginPrint(cam) {
  for (const g of [m, c]) { g.setTransform(1, 0, 0, 1, 0, 0); }
  m.fillStyle = '#fff'; m.fillRect(0, 0, W, H); c.clearRect(0, 0, W, H);
  const k = camMatrix(cam);
  for (const g of [m, c]) { g.save(); g.beginPath(); g.rect(IMG.x, IMG.y, IMG.w, IMG.h); g.clip(); g.setTransform(...k); }
  m.fillStyle = '#000'; m.fillRect(-6000, -6000, 16000, 16000);
  return k;
}
// 版面模式：整个遮罩先是黑木；版内容镜像（木版是印出画面的镜像）
export function beginBlock(cam) {
  for (const g of [m, c]) { g.setTransform(1, 0, 0, 1, 0, 0); }
  m.fillStyle = '#000'; m.fillRect(0, 0, W, H); c.clearRect(0, 0, W, H);
  const k = camMatrix(cam);
  for (const g of [m, c]) { g.save(); g.setTransform(...k); g.beginPath(); g.rect(0, 0, PW, PH); g.clip(); g.transform(-1, 0, 0, 1, PW, 0); }
  return k;
}
export function end() { m.restore(); c.restore(); m.setTransform(1, 0, 0, 1, 0, 0); c.setTransform(1, 0, 0, 1, 0, 0); }

// 纸边题签：铅字，画在遮罩上（墨），和画面一起过印刷着色
export function caption(text, a = 1) {
  if (!text || a <= 0) return;
  m.save(); m.setTransform(1, 0, 0, 1, 0, 0);
  m.font = '900 54px "Noto Serif SC"'; m.textAlign = 'center'; m.textBaseline = 'middle';
  m.fillStyle = `rgba(0,0,0,${a})`;
  const y = IMG.y + IMG.h + (H - IMG.y - IMG.h) / 2 + 4;
  // 字距：逐字排
  const chars = [...text], gap = 30, cw = 54, tot = chars.length * cw + (chars.length - 1) * gap;
  chars.forEach((ch, i) => m.fillText(ch, W / 2 - tot / 2 + cw / 2 + i * (cw + gap), y));
  m.restore();
}
export function captionBox(text) {
  const chars = [...text], gap = 30, cw = 54, tot = chars.length * cw + (chars.length - 1) * gap, y = IMG.y + IMG.h + (H - IMG.y - IMG.h) / 2 + 4;
  return [W / 2 - tot / 2, y - 32, W / 2 + tot / 2, y + 32];
}

export function printTo(g, o = {}) {
  const out = printer().render(M, C, { seed: 5, inkSeed: o.inkSeed ?? 5, plate: RED, ink: INK, paper: PAPER, reg: o.reg || [3, 2], plateAmt: o.plateAmt ?? 1, mode: o.mode, sheen: o.sheen, wetX: o.wetX, bk: o.bk, kt: o.kt, wood: WOOD, grainAng: o.grainAng ?? .015 });
  const j = o.jolt || [0, 0];
  if (j[0] || j[1]) { g.fillStyle = PAPER; g.fillRect(0, 0, W, H); }
  g.drawImage(out, j[0], j[1]);
  return out;
}
// 硬切 = 新一次压印：两帧错版
export const jolt = lt => lt < 1 / 24 - 1e-6 ? [5, -3] : lt < 2 / 24 - 1e-6 ? [-2, 1] : [0, 0];
export const regJolt = lt => lt < 1 / 24 - 1e-6 ? [10, -6] : lt < 2 / 24 - 1e-6 ? [6, 1] : [3, 2];
