// 程序化纹理（Canvas2D）：壁纸、地毯、吊顶、灯格栅、告示、开关、门牌；全部确定性（mulberry 种子）
import * as THREE from 'three';
import { mulberry } from '/core/lib.js';

const cv = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
function tex(c, { srgb = true, repeat = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
// Paper/cloth texture base noise: lots of small translucent dots
function grain(x, w, h, n, a, R, cols) {
  for (let i = 0; i < n; i++) {
    x.fillStyle = cols[Math.floor(R() * cols.length)]; x.globalAlpha = a * (0.3 + R() * 0.7);
    const s = 1 + R() * 2; x.fillRect(R() * w, R() * h, s, s);
  }
  x.globalAlpha = 1;
}

// Wallpaper: one texture = 0.53 m wide (one wallpaper roll) × 0.53 m high, repeating vertically
// Old-style office wallpaper: warm yellow ground + thin vertical stripes + a column of small diamonds/herringbone between pairs of stripes, faded, print slightly misregistered
export function wallpaper() {
  const S = 512, c = cv(S, S), x = c.getContext('2d'), R = mulberry(11);
  x.fillStyle = '#d5bd66'; x.fillRect(0, 0, S, S);
  // Slight vertical colour banding (uneven printing)
  for (let i = 0; i < S; i += 2) { x.fillStyle = `rgba(120,100,40,${0.03 + 0.03 * Math.sin(i * 0.05) ** 2})`; x.fillRect(i, 0, 2, S); }
  const cols = 8, cw = S / cols;
  for (let k = 0; k < cols; k++) {
    const x0 = k * cw;
    if (k % 2) { x.fillStyle = 'rgba(150,120,40,.10)'; x.fillRect(x0, 0, cw, S); }   // alternating wide and narrow ground stripes (the vertical stripes still read at a distance)
    // Double thin vertical lines
    x.fillStyle = 'rgba(140,112,40,.7)'; x.fillRect(x0 + 2, 0, 3, S); x.fillRect(x0 + 8, 0, 2, S);
    // Diamond column (one every 32px), alternating filled/hollow
    for (let j = 0; j < S / 32; j++) {
      const cx = x0 + cw * 0.6 + 0.8, cy = j * 32 + 16 + (k % 2) * 16;
      x.beginPath(); x.moveTo(cx, cy - 7); x.lineTo(cx + 5, cy); x.lineTo(cx, cy + 7); x.lineTo(cx - 5, cy); x.closePath();
      if ((j + k) % 2) { x.fillStyle = 'rgba(150,122,48,.55)'; x.fill(); }
      else { x.strokeStyle = 'rgba(150,122,48,.6)'; x.lineWidth = 1.8; x.stroke(); }
    }
  }
  grain(x, S, S, 26000, 0.08, R, ['#8a7433', '#f3e6ad', '#6b5a26']);
  // Seam between widths (left edge): one light line + one dark line
  x.fillStyle = 'rgba(255,245,200,.35)'; x.fillRect(0, 0, 2, S);
  x.fillStyle = 'rgba(90,70,20,.35)'; x.fillRect(2, 0, 1, S);
  return tex(c);
}

// Carpet: low-pile industrial carpet, mustard brown + mottled; R/G/B texture + a separate greyscale "pile relief" map as the source for roughness/normals
export function carpet() {
  const S = 512, c = cv(S, S), x = c.getContext('2d'), R = mulberry(23);
  x.fillStyle = '#8c763c'; x.fillRect(0, 0, S, S);
  grain(x, S, S, 90000, 0.22, R, ['#6d5b2e', '#a88f55', '#7d6a38', '#b59c60', '#5d4d26']);
  // Fine tufted rows (very faint)
  for (let j = 0; j < S; j += 3) { x.fillStyle = `rgba(60,48,20,${0.05 + R() * 0.05})`; x.fillRect(0, j, S, 1); }
  return tex(c);
}

// Mineral-fibre ceiling tiles: 0.6 × 1.2 m each, the texture covers 1.2 × 1.2 (two tiles); the T-bar grid is drawn on the edges
export function ceiling() {
  const S = 512, c = cv(S, S), x = c.getContext('2d'), R = mulberry(31);
  x.fillStyle = '#d9d3b8'; x.fillRect(0, 0, S, S);
  // Wormhole-like small pits in the mineral-fibre tile
  for (let i = 0; i < 5200; i++) {
    x.fillStyle = `rgba(110,100,70,${0.18 + R() * 0.3})`;
    const w = 1 + R() * 2.5, h = 1 + R() * 1.2; x.fillRect(R() * S, R() * S, w, h);
  }
  grain(x, S, S, 20000, 0.1, R, ['#a79f82', '#eee8d0']);
  // T-bar grid: ~2.4cm wide (=10px), between two tiles
  x.fillStyle = '#e6e1cf';
  x.fillRect(0, 0, S, 5); x.fillRect(0, S - 5, S, 5); x.fillRect(0, 0, 5, S); x.fillRect(S - 5, 0, 5, S); x.fillRect(S / 2 - 5, 0, 10, S);
  x.fillStyle = 'rgba(70,60,40,.6)';
  x.fillRect(0, 5, S, 1); x.fillRect(0, S - 6, S, 1); x.fillRect(5, 0, 1, S); x.fillRect(S - 6, 0, 1, S); x.fillRect(S / 2 - 6, 0, 1, S); x.fillRect(S / 2 + 5, 0, 1, S);
  return tex(c);
}

// Fluorescent light grille (prismatic diffuser): 0.6 × 1.2 m; alpha channel = emissive area
export function troffer() {
  const W = 128, H = 256, c = cv(W, H), x = c.getContext('2d'), R = mulberry(41);
  x.fillStyle = '#9a9786'; x.fillRect(0, 0, W, H);        // metal frame
  x.fillStyle = '#fbfaf0'; x.fillRect(7, 7, W - 14, H - 14);
  // Prism pattern: fine grid
  for (let i = 7; i < W - 7; i += 4) { x.fillStyle = 'rgba(180,180,160,.25)'; x.fillRect(i, 7, 1, H - 14); }
  for (let j = 7; j < H - 7; j += 4) { x.fillStyle = 'rgba(180,180,160,.25)'; x.fillRect(7, j, W - 14, 1); }
  // The two tubes behind the diffuser are brighter
  const g1 = x.createLinearGradient(7, 0, W - 7, 0);
  g1.addColorStop(0, 'rgba(255,255,255,0)'); g1.addColorStop(.3, 'rgba(255,255,255,.5)'); g1.addColorStop(.36, 'rgba(255,255,255,0)');
  g1.addColorStop(.64, 'rgba(255,255,255,0)'); g1.addColorStop(.7, 'rgba(255,255,255,.5)'); g1.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g1; x.fillRect(7, 7, W - 14, H - 14);
  // Shadows of dead insects inside the diffuser (an old-office-building detail)
  for (let i = 0; i < 3; i++) { x.fillStyle = 'rgba(60,55,40,.35)'; x.beginPath(); x.ellipse(15 + R() * (W - 30), 20 + R() * (H - 40), 2 + R() * 3, 1 + R() * 2, R() * 3, 0, 7); x.fill(); }
  return tex(c, { repeat: false });
}

// 告示：竖版 0.36 × 0.48 m，1080×1440 px。中文激光打印，发黄复印纸
export function notice({ age = 0.8, seed = 36 } = {}) {
  const W = 1080, H = 1440, c = cv(W, H), x = c.getContext('2d'), R = mulberry(seed);
  x.fillStyle = '#ece3c4'; x.fillRect(0, 0, W, H);
  const eg = x.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.75);
  eg.addColorStop(0, 'rgba(0,0,0,0)'); eg.addColorStop(1, `rgba(150,120,50,${0.18 + age * 0.2})`);
  x.fillStyle = eg; x.fillRect(0, 0, W, H);
  grain(x, W, H, 32000, 0.06, R, ['#8c7c55', '#fff9e6']);
  const ink = '#1c1a16', M = 84;
  x.fillStyle = ink; x.textBaseline = 'alphabetic';
  // 页眉：楼层须知 / 表单号
  x.font = "900 64px 'Noto Sans SC'"; x.fillText('楼层须知', M, 150);
  x.font = "500 34px 'Noto Sans SC'"; const fm = '表 B-117 · 第3版'; x.fillText(fm, W - M - x.measureText(fm).width, 146);
  x.fillRect(M, 180, W - 2 * M, 7);
  // 正文：一条规则，大字
  x.font = "900 236px 'Noto Sans SC'";
  x.fillText('不要', M - 6, 560); x.fillText('数门', M - 6, 840);
  x.font = "900 236px 'Noto Sans SC'"; x.fillText('。', M + 470, 840);
  x.fillRect(M, H - 250, W - 2 * M, 3);
  // 落款
  x.font = "500 62px 'Noto Sans SC'"; x.fillStyle = '#2e2a22';
  const sg = '——管理处'; x.fillText(sg, W - M - x.measureText(sg).width, H - 150);
  // 复印机灰点、一道折痕
  for (let i = 0; i < 110; i++) { x.fillStyle = `rgba(30,30,30,${R() * 0.25})`; x.fillRect(R() * W, R() * H, 1 + R() * 3, 1 + R() * 2); }
  x.fillStyle = 'rgba(0,0,0,.05)'; x.fillRect(0, H * 0.5, W, 3); x.fillStyle = 'rgba(255,255,255,.25)'; x.fillRect(0, H * 0.5 + 3, W, 2);
  return tex(c, { repeat: false, aniso: 16 });
}

// 开关面板（米白塑料，单联翘板）
export function switchPlate() {
  const W = 86, H = 124, c = cv(W * 2, H * 2), x = c.getContext('2d'); x.scale(2, 2);
  x.fillStyle = '#e6dfc8'; x.fillRect(0, 0, W, H);
  x.strokeStyle = 'rgba(0,0,0,.22)'; x.lineWidth = 2; x.strokeRect(1, 1, W - 2, H - 2);
  x.fillStyle = '#d8d0b6'; x.fillRect(W / 2 - 13, H / 2 - 26, 26, 52);
  x.fillStyle = 'rgba(0,0,0,.25)'; x.fillRect(W / 2 - 13, H / 2, 26, 2);
  x.fillStyle = '#8b856f'; for (const cy of [12, H - 12]) { x.beginPath(); x.arc(W / 2, cy, 3, 0, 7); x.fill(); }
  return tex(c, { repeat: false });
}
// 遮蔽胶带（米黄，边缘撕口）
export function tapeStrip() {
  const W = 100, H = 340, c = cv(W, H), x = c.getContext('2d'), R = mulberry(77);
  x.fillStyle = '#d9c88e'; x.fillRect(0, 6, W, H - 12);
  for (let i = 0; i < W; i += 4) { x.fillStyle = '#d9c88e'; x.fillRect(i, 0, 4, 6 + R() * 6); x.fillRect(i, H - 6 - R() * 6, 4, 12); }
  grain(x, W, H, 2500, .12, R, ['#a8965c', '#f0e2b0']);
  return tex(c, { repeat: false });
}
// 门牌：灰色亚克力，黑字；ch 为空时是空白门牌
export function doorPlate(ch) {
  const S = 512, c = cv(S, S), x = c.getContext('2d');
  x.fillStyle = '#bdb8aa'; x.fillRect(0, 0, S, S);
  const g = x.createLinearGradient(0, 0, S, S); g.addColorStop(0, 'rgba(255,255,255,.18)'); g.addColorStop(1, 'rgba(0,0,0,.12)');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  x.strokeStyle = 'rgba(40,36,30,.5)'; x.lineWidth = 10; x.strokeRect(22, 22, S - 44, S - 44);
  x.fillStyle = 'rgba(40,36,30,.6)'; for (const [px, py] of [[52, 52], [S - 52, 52], [52, S - 52], [S - 52, S - 52]]) { x.beginPath(); x.arc(px, py, 9, 0, 7); x.fill(); }
  if (ch) { x.fillStyle = '#141210'; x.font = "900 330px 'Noto Sans SC'"; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(ch, S / 2, S / 2 + 14); }
  return tex(c, { repeat: false, aniso: 16 });
}

// Power socket plate
export function outlet() {
  const W = 64, H = 112, c = cv(W, H), x = c.getContext('2d');
  x.fillStyle = '#e8e2cc'; x.fillRect(0, 0, W, H);
  x.strokeStyle = 'rgba(0,0,0,.25)'; x.lineWidth = 2; x.strokeRect(1, 1, W - 2, H - 2);
  for (const cy of [32, 80]) {
    x.fillStyle = '#d7d0b8'; x.beginPath(); x.ellipse(W / 2, cy, 17, 20, 0, 0, 7); x.fill();
    x.fillStyle = '#2a2620'; x.fillRect(W / 2 - 9, cy - 9, 3, 10); x.fillRect(W / 2 + 6, cy - 9, 3, 10);
    x.beginPath(); x.arc(W / 2, cy + 9, 3, 0, 7); x.fill();
  }
  x.fillStyle = '#8b856f'; x.beginPath(); x.arc(W / 2, H / 2, 3, 0, 7); x.fill();
  return tex(c, { repeat: false });
}
