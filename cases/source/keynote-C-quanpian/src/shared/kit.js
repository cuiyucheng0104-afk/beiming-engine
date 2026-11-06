// 共用工厂：卡片（白边、受光）、纸条标签、文字、纸件、材质与 IP 图加载。分章导演只用这里的东西造纸世界，保证全片一套手感。
// 约定（与开头 stage.js 一致）：单位米，y 向上；"纸件" = Group，原点在底边中点，rotation.x = 0 站立、= π/2 向前扣倒（背面朝上）；
// 纸件正面受光、投下剪影形状的影子（alphaTest），背面是纸色。
import * as THREE from 'three';
import { cutPiece, vFold, texOf, popAt, BS, BX } from '../stage.js';
import * as A from '../art.js';
import { IP, MAT } from './assets.js';

export { cutPiece, vFold, texOf, popAt, BS, BX };
export const { INK, VERM, GOLD, CREAM, PX, LPX } = A;
export const cv = A.cv, mulberry = A.mulberry, finishCut = A.finishCut;

const M = '/@film/material/';
const imgCache = new Map(), texCache = new Map();
function loadImg(file) {
  if (!imgCache.has(file)) imgCache.set(file, new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image ' + file)); i.src = M + encodeURI(file); }));
  return imgCache.get(file);
}
// IP 图：ip('p06_nezha') → HTMLImageElement（原像素，别在 canvas 上改它，只整张印到卡片上）
export async function ip(key) { const a = IP[key]; if (!a) throw new Error(`assets.js 里没有 IP 图 "${key}"`); return loadImg(a.file); }
// 材质贴图：tex('xuan', { repeat: [2, 1] }) → THREE.Texture（sRGB，可平铺）
export async function tex(key, o = {}) {
  const f = MAT[key]; if (!f) throw new Error(`assets.js 里没有材质 "${key}"`);
  const k = key + JSON.stringify(o);
  if (!texCache.has(k)) texCache.set(k, loadImg(f).then(img => {
    const t = new THREE.Texture(img); t.needsUpdate = true; t.colorSpace = o.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (o.repeat) t.repeat.set(...o.repeat); return t;
  }));
  return texCache.get(k);
}
export const img = loadImg;

// —— IP 卡片：原图整张 + 白边 + 灰纸板切口（开头 cardArt），高 h 米 ——
// 返回 Group（cutPiece）；g.userData.art.imgRect 是图在卡面上的像素框（几何检查用）
export function card(image, { h = .108, border = .045 } = {}) {
  const a = A.cardArt(image, border), w = h * a.aspect;
  const g = cutPiece(a.c, w, h); g.userData.art = a; g.userData.kind = 'card'; return g;
}

// —— 纸件：任意 Canvas2D 画（透明底）→ 白边 + 切口 → 站立纸片 ——
// art 画布按 PX（5000 像素/米）画；w/h 是纸片在世界里的宽高（米）
export function piece(art, w, h, { border = 22, ax = .5 } = {}) { return cutPiece(finishCut(art, border), w, h, { ax }); }
export function vfold(art, w, h, { border = 22 } = {}) { return vFold(finishCut(art, border), w, h); }   // V 形折页：g.userData.setV(弧度)

// —— 文字画布（受光的"印刷字"）——
// 字体：'SC' = Noto Sans SC 700（标题）、'SCM' = Noto Sans SC 500（小字）、'InterF' = Inter（数字/拉丁，500/700/800）
// 中文与数字混排时用 SC 即可（SC 子集里含全片用到的数字与标点）
export function font(f = 'SC', size = 100, weight) { const w = weight ?? (f === 'SCM' ? 500 : f === 'InterF' ? 800 : 700); return `${w} ${size}px ${f}`; }
// 画一段字到新画布（透明底）。ppm = 像素/米；sizeM = 字号（米）。返回 { c, w, h }（w/h 为米）
export function textArt(str, { sizeM = .016, ppm = 9000, f = 'SC', weight, color = INK, n = Infinity, ls = 0 } = {}) {
  const fs = sizeM * ppm, pad = Math.ceil(fs * .3), x0 = cv(4, 4).getContext('2d');
  x0.font = font(f, fs, weight); const chars = [...str], ws = chars.map(ch => x0.measureText(ch).width);
  const W = ws.reduce((a, b) => a + b, 0) + ls * fs * (chars.length - 1) + 2 * pad, H = fs * 1.4 + 2 * pad;
  const c = cv(W, H), x = c.getContext('2d'); x.font = font(f, fs, weight); x.fillStyle = color; x.textBaseline = 'middle';
  let xx = pad; chars.forEach((ch, i) => { if (i < n) x.fillText(ch, xx, H / 2 + fs * .04); xx += ws[i] + ls * fs; });
  return { c, w: W / ppm, h: H / ppm, fs, pad };
}
// 文字面片：平放在 XY 平面、正面朝 +z、受光；align 'center' | 'left'；setChars(n) = 打字机（只显示前 n 个字，n 变了才重画）
export function text(str, o = {}) {
  const a = textArt(str, o), t = texOf(a.c);
  const m = new THREE.MeshStandardMaterial({ map: t, transparent: true, alphaTest: .02, roughness: .9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const geo = new THREE.PlaneGeometry(a.w, a.h); if (o.align === 'left') geo.translate(a.w / 2, 0, 0);
  const mesh = new THREE.Mesh(geo, m); mesh.receiveShadow = true; mesh.userData = { text: str, kind: 'text' };
  let shown = Infinity;
  mesh.userData.setChars = n => { if (n === shown) return; shown = n; const b = textArt(str, { ...o, n }); a.c.getContext('2d').clearRect(0, 0, a.c.width, a.c.height); a.c.getContext('2d').drawImage(b.c, 0, 0); t.needsUpdate = true; };
  return mesh;
}

// —— 纸条标签（开头「角色，是进入内容的入口」那一种：米白纸条、深棕字、句首朱红小方块）——
// 返回 { g, set(n), text }：g 是站立纸片（原点底边中点），set(n) 打出前 n 个字（带朱红光标）
export function label(str, { w = .228, h = .031, f = 'SC', ppm = LPX } = {}) {
  const c = cv(w * ppm + 80, h * ppm + 80), t = texOf(c);
  const g = cutPiece(c, w + 80 / ppm, h + 80 / ppm, { tex: t }); g.userData.kind = 'label'; g.userData.text = str;
  let shown = -1;
  const set = n => { if (n === shown) return; shown = n; labelArt(c, str, n, f); t.needsUpdate = true; };
  set(0);
  return { g, set, text: str };
}
function labelArt(c, str, n, f) {
  const pad = 40, w = c.width, h = c.height, x = c.getContext('2d'); x.clearRect(0, 0, w, h);
  const art = cv(w, h), y = art.getContext('2d');
  y.beginPath(); y.roundRect(pad, pad, w - 2 * pad, h - 2 * pad, 10); y.fillStyle = '#FBF4E4'; y.fill(); y.lineWidth = 9; y.strokeStyle = INK; y.stroke();
  y.strokeStyle = 'rgba(58,42,32,.5)'; y.lineWidth = 3; y.strokeRect(pad + 22, pad + 22, w - 2 * pad - 44, h - 2 * pad - 44);
  const sq = (h - 2 * pad) * .34; y.fillStyle = VERM; y.fillRect(pad + 60, h / 2 - sq / 2, sq, sq);
  const fs = (h - 2 * pad) * .5; y.font = font(f, fs); y.fillStyle = INK; y.textBaseline = 'middle';
  const chars = [...str], x0 = pad + 60 + sq + fs * .5, totalW = chars.reduce((s, ch) => s + y.measureText(ch).width, 0);
  const span = w - pad - 70 - x0, ls = chars.length > 1 ? Math.min(fs * .5, (span - totalW) / (chars.length - 1)) : 0;
  let xx = x0; chars.forEach((ch, i) => { if (i < n) y.fillText(ch, xx, h / 2 + fs * .04); xx += y.measureText(ch).width + ls; });
  if (n < chars.length && n > 0) { let cx = x0; for (let i = 0; i < n; i++) cx += y.measureText(chars[i]).width + ls; y.fillStyle = VERM; y.fillRect(cx, h / 2 - fs * .45, fs * .08, fs * .9); }
  x.drawImage(finishCut(art, 18), 0, 0);
}

// —— 纸板（平涂底色 + 纸纹 + 白边切口），给布景、底座、屋顶等用 ——
export function paperArt(wm, hm, { fill = '#F3E6CC', line = INK, lw = 9, radius = 18, pad = 30 } = {}) {
  const c = cv(wm * PX + 2 * pad, hm * PX + 2 * pad), x = c.getContext('2d');
  x.beginPath(); x.roundRect(pad, pad, c.width - 2 * pad, c.height - 2 * pad, radius); x.fillStyle = fill; x.fill(); if (lw) { x.lineWidth = lw; x.strokeStyle = line; x.stroke(); }
  return c;
}

// —— 占位卡（骨架阶段用；成片前全部删掉）——
export function placeholderCard(str, { h = .09, w = .16 } = {}) {
  const pad = 40, c = cv(w * PX + 2 * pad, h * PX + 2 * pad), x = c.getContext('2d');
  x.beginPath(); x.roundRect(pad, pad, c.width - 2 * pad, c.height - 2 * pad, 20); x.fillStyle = '#FBF4E4'; x.fill(); x.lineWidth = 10; x.strokeStyle = INK; x.stroke();
  x.setLineDash([30, 22]); x.lineWidth = 6; x.strokeStyle = VERM; x.strokeRect(pad + 40, pad + 40, c.width - 2 * pad - 80, c.height - 2 * pad - 80); x.setLineDash([]);
  const fs = h * PX * .22; x.font = font('SC', fs); x.fillStyle = INK; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(str, c.width / 2, c.height / 2);
  const g = piece(c, w + 2 * pad / PX, h + 2 * pad / PX, { border: 20 }); g.userData.kind = 'placeholder'; g.userData.text = str; return g;
}

// 便捷：站立动画（落在拍上的 back() 回弹；与开头卡片/折页同一条曲线）。g 向前扣倒 → 立起
export function standAt(g, t, tb, d = .62, lean = .06) { const p = popAt(t, tb, d); g.rotation.x = Math.PI / 2 * (1 - p) - lean * Math.min(1, Math.max(0, p)); return p; }
