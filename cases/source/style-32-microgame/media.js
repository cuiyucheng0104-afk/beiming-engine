// 共享的画布工具：离屏画布、纸纹、确定性随机
import { mulberry, clamp } from '/core/lib.js';
export const W = 1920, H = 1080;
export function canvas(w = W, h = H) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
export const cx2 = cv => cv.getContext('2d', { willReadFrequently: false });

// 纸齿：高对比 alpha 斑点（蜡只沾在凸起处），带一点斜向纤维
let _tooth = null;
export function tooth() {
  if (_tooth) return _tooth;
  const cv = canvas(), g = cv.getContext('2d'), id = g.createImageData(W, H), d = id.data, R = mulberry(42);
  const sw = 480, sh = 270, small = new Float32Array(sw * sh); for (let i = 0; i < small.length; i++) small[i] = R();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = small[((y >> 2) % sh) * sw + ((x >> 2) % sw)], fine = R(), streak = Math.sin((x * .9 + y * .35) * .21) * .5 + .5;
    const v = s * .45 + fine * .4 + streak * .15;
    const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = v > .27 ? 255 : v > .19 ? 150 : 45;
  }
  g.putImageData(id, 0, 0); _tooth = cv; return cv;
}
// 纸底（蜡笔：奶油色画纸）
let _paperC = null;
export function paperCrayon() {
  if (_paperC) return _paperC;
  const cv = canvas(), g = cv.getContext('2d'), R = mulberry(7);
  g.fillStyle = '#f7f0dc'; g.fillRect(0, 0, W, H);
  g.globalAlpha = .05; for (let i = 0; i < 2600; i++) { g.fillStyle = R() > .5 ? '#c8b48a' : '#fff'; g.fillRect(R() * W, R() * H, 2 + R() * 3, 1 + R() * 2); }
  _paperC = cv; return cv;
}
// 宣纸：暖白底 + 长纤维 + 淡斑
let _paperX = null;
export function paperRice() {
  if (_paperX) return _paperX;
  const cv = canvas(), g = cv.getContext('2d'), R = mulberry(99);
  g.fillStyle = '#efe7d4'; g.fillRect(0, 0, W, H);
  g.globalAlpha = .06; g.fillStyle = '#b9a67e';
  for (let i = 0; i < 90; i++) { g.beginPath(); g.arc(R() * W, R() * H, 30 + R() * 160, 0, 7); g.fill(); }
  g.globalAlpha = .18; g.strokeStyle = '#cbbb98'; g.lineWidth = 1;
  for (let i = 0; i < 1400; i++) { const x = R() * W, y = R() * H, a = R() * 6.28, l = 10 + R() * 50; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a + .5) * l * .5, y + Math.sin(a + .5) * l * .5, x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke(); }
  _paperX = cv; return cv;
}
// 孔版纸
let _paperR = null;
export function paperRiso() {
  if (_paperR) return _paperR;
  const cv = canvas(), g = cv.getContext('2d'), R = mulberry(5);
  g.fillStyle = '#f6efe1'; g.fillRect(0, 0, W, H);
  g.globalAlpha = .06; for (let i = 0; i < 3000; i++) { g.fillStyle = '#a89a80'; g.fillRect(R() * W, R() * H, 1.5, 1.5); }
  _paperR = cv; return cv;
}
// 孔版颗粒（缺墨白点）：用 destination-out 叠在版上
let _grain = null;
export function risoGrain() {
  if (_grain) return _grain;
  const cv = canvas(), g = cv.getContext('2d'), R = mulberry(77);
  g.fillStyle = '#000';
  for (let i = 0; i < 60000; i++) { g.globalAlpha = .25 + R() * .6; g.fillRect(R() * W, R() * H, 1 + R() * 2.2, 1 + R() * 2.2); }
  _grain = cv; return cv;
}
// 角色按 k 帧一格跳（k=3 → 8fps，2 → 12fps，1 → 逐帧），锚在每拍开头（关键拍那一帧一定更新）。lf = 段内帧号
export const stepF = (lf, fpb, k) => { const b = Math.floor(lf / fpb); return b * fpb + Math.floor((lf - b * fpb) / k) * k; };
export { clamp };
