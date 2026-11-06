// 第 2 关 · 8-bit 像素：160×90 索引缓冲 ×12，精灵层自动 1px 描边，拜耳抖动
import { canvas, stepF } from './media.js';
import { clamp, lerp, eo, ei, eio, hash } from '/core/lib.js';

export const PW = 160, PH = 90;
const PALX = ['#000000', '#1b1c33', '#3d4f8f', '#6a83c2', '#9aa0b8', '#5e6380', '#eef0f5', '#e0383a', '#9e1f2a', '#f2c19a', '#2fb3a0', '#1d7f74', '#3e3e52', '#5c5c74', '#b9604a', '#ffd25a', '#bcd4ff', '#7fa8e8', '#2a2a3c'];
const RGB = PALX.map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
const SMALL = canvas(PW, PH), sg = SMALL.getContext('2d'), IMG = sg.createImageData(PW, PH);
const BG = new Uint8Array(PW * PH), SP = new Uint8Array(PW * PH);
const BAY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const put = (L, x, y, k) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < PW && y < PH) L[y * PW + x] = k; };
const rect = (L, x, y, w, h, k) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(L, x + i, y + j, k); };
const disc = (L, cx, cy, r, k) => { for (let j = -Math.ceil(r); j <= r; j++) for (let i = -Math.ceil(r); i <= r; i++) if (i * i + j * j <= r * r + r * .6) put(L, cx + i, cy + j, k); };

// 像素小豆子：x,y = 脚底（缓冲坐标）；st: {run, wet 0..1, look, dash}
export function heroPixel(L, x, y, st = {}) {
  x = Math.round(x); y = Math.round(y);
  const wet = st.wet || 0, ph = st.run ? Math.floor(st.run * 4) % 2 : 0;
  // 腿与鞋
  if (st.dash) { rect(L, x - 6, y - 4, 3, 3, 12); rect(L, x + 3, y - 6, 3, 3, 12); rect(L, x - 8, y - 2, 4, 2, 8); rect(L, x + 4, y - 4, 4, 2, 8); }
  else { rect(L, x - 4 + ph, y - 6, 3, 5, 12); rect(L, x + 1 - ph, y - 6, 3, 5, 12); rect(L, x - 5 + ph, y - 2, 4, 2, 8); rect(L, x + 1 - ph, y - 2, 4, 2, 8); }
  // 身体
  rect(L, x - 6, y - 17, 12, 12, 10); rect(L, x + 3, y - 17, 3, 12, 11);
  // 手臂
  if (st.dash) { rect(L, x - 11, y - 15, 5, 2, 10); rect(L, x + 6, y - 13, 5, 2, 10); put(L, x - 12, y - 15, 9); put(L, x + 11, y - 13, 9); }
  else if (wet > .5) { rect(L, x - 8, y - 15, 2, 7, 10); rect(L, x + 6, y - 15, 2, 7, 10); put(L, x - 8, y - 8, 9); put(L, x + 6, y - 8, 9); }
  else { rect(L, x - 8, y - 16, 2, 6, 10); rect(L, x + 6, y - 16, 2, 6, 10); put(L, x - 8, y - 10, 9); put(L, x + 7, y - 10, 9); }
  // 头
  const hx = x + (st.dash ? 2 : 0), hy = y - 24;
  disc(L, hx, hy, 7, 9);
  // 红帽 + 绒球：湿了就塌下来、歪向一边
  if (wet < .5) { for (let j = -8; j <= -2; j++) for (let i = -8; i <= 8; i++) if (i * i + (j + 1) * (j + 1) * 1.6 <= 70) put(L, hx + i, hy + j, 7);
    rect(L, hx - 8, hy - 3, 17, 2, 6); disc(L, hx, hy - 10, 2, 7); rect(L, hx + 3, hy - 7, 2, 2, 8); }
  else { rect(L, hx - 8, hy - 7, 17, 4, 7); rect(L, hx - 9, hy - 3, 13, 2, 6); rect(L, hx + 6, hy - 4, 5, 3, 7); disc(L, hx + 10, hy, 1.6, 7); rect(L, hx - 6, hy - 7, 6, 1, 8); }
  // 脸
  if (wet > .5) { rect(L, hx - 4, hy, 2, 1, 1); rect(L, hx + 3, hy, 2, 1, 1); put(L, hx - 5, hy - 1, 1); put(L, hx + 5, hy - 1, 1); rect(L, hx - 1, hy + 4, 3, 1, 1); put(L, hx - 2, hy + 5, 1); put(L, hx + 2, hy + 5, 1); }
  else { const ly = st.look || 0; put(L, hx - 3 + ly, hy, 1); put(L, hx + 3 + ly, hy, 1); put(L, hx - 3 + ly, hy + 1, 1); put(L, hx + 3 + ly, hy + 1, 1);
    if (st.scared) { rect(L, hx - 1, hy + 3, 3, 3, 1); } else { put(L, hx - 2, hy + 4, 1); rect(L, hx - 1, hy + 5, 3, 1, 1); put(L, hx + 2, hy + 4, 1); } }
}
// 坏脾气雨云
export function cloudPixel(L, x, y, st = {}) {
  x = Math.round(x); y = Math.round(y);
  for (const [ox, oy, r] of [[0, 0, 8], [-10, 3, 6], [10, 3, 7], [-4, -5, 6], [6, -4, 6]]) disc(L, x + ox, y + oy, r, 4);
  for (let i = -15; i <= 16; i++) { put(L, x + i, y + 8, 5); put(L, x + i, y + 9, 5); }
  rect(L, x - 13, y + 6, 27, 2, 5);
  // 眼睛（斜眉）
  const g = st.grin ? 1 : 0;
  rect(L, x - 5, y + 1, 2, 2, 1); rect(L, x + 4, y + 1, 2, 2, 1); put(L, x - 6, y - 1, 1); put(L, x - 5, y, 1); put(L, x + 6, y - 1, 1); put(L, x + 5, y, 1);
  if (g) { rect(L, x - 3, y + 4, 7, 1, 1); put(L, x - 4, y + 3, 1); put(L, x + 4, y + 3, 1); }
}
function outline(L) {
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) { const i = y * PW + x; if (L[i]) continue;
    const q = j => L[j] > 1 && L[j] !== 255;
    if ((x > 0 && q(i - 1)) || (x < PW - 1 && q(i + 1)) || (y > 0 && q(i - PW)) || (y < PH - 1 && q(i + PW))) L[i] = 255; }
  for (let i = 0; i < L.length; i++) if (L[i] === 255) L[i] = 1;
}
function background(camX, t) {
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) { // 天空：两色拜耳过渡
    const v = y / 70, th = BAY[(y & 3) * 4 + (x & 3)] / 16; BG[y * PW + x] = v > th ? 2 : 3; }
  // 远景房子（视差 0.5）
  for (let k = 0; k < 8; k++) { const hx = Math.round(k * 46 - camX * .5) % 400, hw = 26 + (k % 3) * 6, hh = 22 + (k * 7) % 14;
    rect(BG, hx, 72 - hh, hw, hh, k % 2 ? 14 : 18); rect(BG, hx - 2, 72 - hh - 3, hw + 4, 3, 1);
    for (let wy = 0; wy < 2; wy++) for (let wx = 0; wx < 2; wx++) rect(BG, hx + 5 + wx * 11, 72 - hh + 5 + wy * 8, 4, 4, 15); }
  rect(BG, 0, 72, PW, 18, 12); rect(BG, 0, 72, PW, 2, 13);
  for (let k = 0; k < 12; k++) rect(BG, Math.round(k * 24 - camX) % 288, 82, 10, 1, 13);
}
function blit(out, ox, oy, a = 1) {
  const d = IMG.data;
  for (let i = 0; i < PW * PH; i++) { const k = SP[i] || BG[i], c = RGB[k]; d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; }
  sg.putImageData(IMG, 0, 0);
  out.save(); if (a >= 1) { out.fillStyle = PALX[2]; out.fillRect(0, 0, 1920, 1080); }
  out.imageSmoothingEnabled = false; out.globalAlpha = a; out.drawImage(SMALL, ox, oy, 1920, 1080); out.restore();
}

// 雨滴（确定性）：在 [x0,x1] 宽的柱子里下落
function rain(L, x0, x1, ytop, ybot, t, dens, k = 16) {
  const n = Math.round((x1 - x0) * dens);
  for (let i = 0; i < n; i++) { const rx = x0 + hash(i * 3.1) * (x1 - x0), sp = 70 + hash(i * 7.7) * 30, ph = hash(i * 1.3);
    const yy = ytop + ((t * sp + ph * 200) % (ybot - ytop)); put(L, rx, yy, k); put(L, rx, yy + 1, k); if (dens > .6) put(L, rx, yy + 2, k); }
}

// 第 2 关时间线
export function game2(out, lf, fpb) {
  const sf = stepF(lf, fpb, 3), b = sf / fpb, tb = lf / fpb, t12 = Math.floor(lf / 2) / 12;
  // 镜头：b2→b2.6 快速横摇
  const pan = eio(clamp((tb - 1) / .6)), camX = Math.round(pan * 56);
  const shake = tb >= 3 && tb < 3.6 ? Math.round(Math.sin(lf * 2.7) * 1.5) : 0;
  background(camX, t12);
  SP.fill(0);
  // 小豆子（世界坐标）
  const dashU = clamp((b - 1) / .5), heroWX = lerp(62, 128, eo(dashU)), dash = b >= 1 && b < 1.6;
  const wet = b >= 3 ? 1 : 0;
  heroPixel(SP, heroWX - camX, 72, { run: dash ? sf / 3 : 0, dash, wet, look: b < 1 ? -1 : (b >= 2 && b < 3 ? -1 : 0), scared: b >= 2 && b < 3 });
  // 雨云：b0 随指令飘进；b2 追过来（嗖）
  let cwx;
  if (tb < .3) cwx = -40; else if (tb < .9) cwx = lerp(-30, 60, eo((tb - .3) / .6)); else if (tb < 2) cwx = 60; else cwx = lerp(60, 128, eo(clamp((tb - 2) / .35)));
  const cy = 20 + Math.round(Math.sin(t12 * 6) * 1);
  const cxS = cwx - camX;
  // 追的时候拖影
  if (tb >= 2 && tb < 2.4) for (let k = 1; k <= 3; k++) rect(SP, cxS - 18 - k * 7, cy - 2 + k * 2, 6, 1, 6);
  const pour = tb >= 3;
  cloudPixel(SP, cxS, cy, { grin: pour });
  outline(SP);
  // 雨
  if (tb >= .6) rain(BG, cxS - 13, cxS + 14, cy + 10, 72, t12, pour ? 1.4 : .35, pour ? 6 : 16);
  if (pour) { // 倾盆：水柱 + 溅水 + 水洼
    const hxs = heroWX - camX, gro = clamp((tb - 3) / 1.2);
    for (let i = -12 - Math.round(gro * 6); i <= 12 + gro * 6; i++) if ((i + Math.floor(lf / 2)) % 2) { rect(BG, hxs + i, 72, 1, 1, 17); }
    rect(BG, Math.round(hxs - 10 - gro * 6), 72, Math.round(20 + gro * 12), 2, 17);
    for (let k = 0; k < 8; k++) { const a = hash(k + Math.floor(lf / 2) * 9), sx = hxs - 12 + a * 24, up = 2 + hash(k * 5 + lf) * 5;
      put(SP, sx, 71 - up, 16); put(SP, sx + 1, 70 - up, 16); }
    // 滴答
    for (let k = 0; k < 3; k++) { const dy = ((lf * 1.4 + k * 9) % 14); put(SP, hxs - 7 + k * 7, 52 + dy, 16); }
  }
  blit(out, shake * 12, 0);
  if (tb >= 1 && tb < 1.6) { // 横摇拖影（逐帧）
    blit(out, -24, 0, .25);
  }
}

// 只把精灵层（透明底）叠到别的画面上：BOSS 里的像素雨云客串
export function pixelOverlay(out, fn, ox = 0, oy = 0) {
  SP.fill(0); fn(SP); outline(SP);
  const d = IMG.data;
  for (let i = 0; i < PW * PH; i++) { const k = SP[i]; if (!k) { d[i * 4 + 3] = 0; continue; } const c = RGB[k]; d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; }
  sg.putImageData(IMG, 0, 0);
  out.save(); out.imageSmoothingEnabled = false; out.drawImage(SMALL, ox, oy, 1920, 1080); out.restore();
}
export { rain as pixelRain };
