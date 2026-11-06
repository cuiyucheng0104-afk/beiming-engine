// 第三章美术：五张翻板面（空白绫绢 / 宣纸水墨 / 壁画土墙 / 红纸剪纸 / 毛毡）、拉片纸栏、纸框、小舞台、幕布。
// 全部在 build 时画一次（Canvas2D，带种子随机），每帧只改着色器的时间 uniform —— 画面是 t 的纯函数。
//
// 显影着色器（MeshStandard/Physical 的 onBeforeCompile）：每张面有三张数据图
//   den（RGB = 三层的浓度）、arr（RGB = 三层每个像素的"到达时刻"，0–1 映射到 [T0, T0 + SPAN] 秒）、col（颜料/光的颜色）
//   某层在 t 的显影 = clamp((t − 到达时刻) / soft)。墨的晕开、卷草纹沿路径生长、刻痕先于开孔、标题切口升起，都是同一个机制。
import * as THREE from 'three';
import { texOf } from '../stage.js';
import * as A from '../art.js';
import { font, finishCut, INK, VERM, GOLD } from '../shared/kit.js';

export const PNW = .43, PNH = .236, PPX = 5000;          // 翻板面（12 片竖条拼成）宽高（米）、画布像素/米
export const CW = Math.round(PNW * PPX), CHh = Math.round(PNH * PPX);
export const VIS = { x0: -.205, x1: .205, y0: .015, y1: .232 };   // 纸框窗口里看得见的部分（翻板面本地坐标，y 从翻板下沿算）
const TAU = Math.PI * 2;
const cv = A.cv, mul = A.mulberry;
// 翻板本地米 → 画布像素
const PX = x => (x + PNW / 2) * PPX, PY = y => (PNH - y) * PPX, PS = m => m * PPX;

// —————————————————— 噪声 ——————————————————
function noise2(seed) {
  const N = 256, R = mul(seed), g = new Float32Array(N * N); for (let i = 0; i < N * N; i++) g[i] = R();
  const at = (i, j) => g[((j & 255) << 8) | (i & 255)];
  return (x, y) => { const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v; };
}
function fbm(n) { return (x, y) => .5 * n(x, y) + .3 * n(x * 2.03 + 17.1, y * 2.03 + 5.3) + .2 * n(x * 4.1 + 3.7, y * 4.1 + 11.9); }

// —————————————————— 三层数据图 ——————————————————
// L[k] = { den: Float32Array, arr: Float32Array }（全分辨率），arr 是 0–1（到达时刻 / SPAN），没有颜料的地方 arr = 1
class Layers {
  constructor(span) { this.span = span; this.n = CW * CHh; this.den = [0, 1, 2].map(() => new Float32Array(this.n)); this.arr = [0, 1, 2].map(() => new Float32Array(this.n).fill(1)); }
  // 用 Canvas 画形状：draw(x) 里用 fillStyle/strokeStyle = this.g(秒) 画到达时刻；同一批形状再用白色画一遍得到浓度
  shapes(k, draw, { denAlpha = 1, mode = 'max' } = {}) {
    const cD = cv(CW, CHh), xD = cD.getContext('2d'), cA = cv(CW, CHh), xA = cA.getContext('2d');
    xA.fillStyle = '#fff'; xA.fillRect(0, 0, CW, CHh);
    draw(xD, s => `rgba(255,255,255,${denAlpha})`, 'den'); draw(xA, s => this.g(s), 'arr');
    const D = xD.getImageData(0, 0, CW, CHh).data, Ar = xA.getImageData(0, 0, CW, CHh).data, den = this.den[k], arr = this.arr[k];
    for (let i = 0; i < this.n; i++) { const d = D[i * 4 + 3] / 255; if (d <= 0) continue; const a = Ar[i * 4] / 255;
      if (mode === 'max') { if (d >= den[i]) { den[i] = d; } arr[i] = Math.min(arr[i], a); } else { den[i] = Math.min(1, den[i] + d); arr[i] = Math.min(arr[i], a); } }
  }
  g(s) { const v = Math.round(Math.max(0, Math.min(1, s / this.span)) * 255); return `rgb(${v},${v},${v})`; }
  // 低分辨率像素场（墨晕）：fn(xm, ym) → [den, arrSeconds]；上采样到全分辨率后与该层合并（浓度相加，到达取小）
  field(k, fn, scale = .5) {
    const w = Math.round(CW * scale), h = Math.round(CHh * scale), cD = cv(w, h), cA = cv(w, h), xD = cD.getContext('2d'), xA = cA.getContext('2d');
    const iD = xD.createImageData(w, h), iA = xA.createImageData(w, h);
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      const xm = (px + .5) / w * PNW - PNW / 2, ym = PNH - (py + .5) / h * PNH, [d, s] = fn(xm, ym), o = (py * w + px) * 4;
      const dv = Math.round(Math.max(0, Math.min(1, d)) * 255), av = Math.round(Math.max(0, Math.min(1, s / this.span)) * 255);
      iD.data[o] = iD.data[o + 1] = iD.data[o + 2] = dv; iD.data[o + 3] = 255; iA.data[o] = iA.data[o + 1] = iA.data[o + 2] = d > .002 ? av : 255; iA.data[o + 3] = 255;
    }
    xD.putImageData(iD, 0, 0); xA.putImageData(iA, 0, 0);
    const up = c => { const u = cv(CW, CHh), x = u.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, CW, CHh); return x.getImageData(0, 0, CW, CHh).data; };
    const D = up(cD), Ar = up(cA), den = this.den[k], arr = this.arr[k];
    for (let i = 0; i < this.n; i++) { const d = D[i * 4] / 255; if (d <= .002) continue; den[i] = Math.min(1, den[i] + d); arr[i] = Math.min(arr[i], Ar[i * 4] / 255); }
  }
  textures() {
    const pack = chs => { const c = cv(CW, CHh), x = c.getContext('2d'), im = x.createImageData(CW, CHh), d = im.data;
      for (let i = 0; i < this.n; i++) { d[i * 4] = chs[0][i] * 255; d[i * 4 + 1] = chs[1][i] * 255; d[i * 4 + 2] = chs[2][i] * 255; d[i * 4 + 3] = 255; }
      x.putImageData(im, 0, 0); return texOf(c, { linear: true }); };
    return { den: pack(this.den), arr: pack(this.arr) };
  }
}
// 文字（切口升起）：字形填进浓度，到达时刻从字底 (t − dur) 线性到字顶 t —— 落定那一帧整字出齐
function revealText(L, k, str, xm, ym, sizeM, tLand, { f = 'SC', weight, dur = .12, ls = .06, align = 'left', perChar = null } = {}) {
  const fs = PS(sizeM), rects = [];
  const tmp = cv(8, 8).getContext('2d'); tmp.font = font(f, fs, weight);
  const chars = [...str], ws = chars.map(c => tmp.measureText(c).width), W = ws.reduce((a, b) => a + b, 0) + ls * fs * (chars.length - 1);
  let x0 = PX(xm) - (align === 'center' ? W / 2 : align === 'right' ? W : 0);
  const yb = PY(ym);               // 基线（字身底）
  L.shapes(k, (x, col, kind) => {
    x.font = font(f, fs, weight); x.textBaseline = 'alphabetic';
    let xx = x0;
    chars.forEach((ch, i) => {
      const tl = perChar ? perChar[i] : tLand;
      if (kind === 'arr') { const gr = x.createLinearGradient(0, yb + fs * .12, 0, yb - fs * .92); gr.addColorStop(0, L.g(tl - dur)); gr.addColorStop(1, L.g(tl)); x.fillStyle = gr; }
      else x.fillStyle = col();
      x.fillText(ch, xx, yb); xx += ws[i] + ls * fs;
    });
  });
  // 屏幕框用：字身矩形（翻板本地米）
  return { x0: (x0 / PPX) - PNW / 2, x1: (x0 + W) / PPX - PNW / 2, y0: ym - sizeM * .14, y1: ym + sizeM * .9 };
}
function colCanvas(fill) { const c = cv(CW, CHh), x = c.getContext('2d'); x.fillStyle = fill; x.fillRect(0, 0, CW, CHh); return c; }

// —————————————————— 显影材质 ——————————————————
const HEAD = `
uniform sampler2D c3Col; uniform sampler2D c3Den; uniform sampler2D c3Arr; uniform sampler2D c3Fib;
uniform float c3T; uniform float c3T0; uniform float c3Span; uniform vec3 c3Soft; uniform float c3Glow;
float c3rv(float a, float soft, float j){ return clamp((c3T - (c3T0 + a * c3Span + j)) / soft, 0.0, 1.0); }
`;
const BODY = `
#include <map_fragment>
vec3 c3Emit = vec3(0.0);
{
  vec3 dn = texture2D(c3Den, vMapUv).rgb; vec3 ar = texture2D(c3Arr, vMapUv).rgb; vec3 pc = texture2D(c3Col, vMapUv).rgb;
  float fib = texture2D(c3Fib, vMapUv).r;
  float lum = dot(diffuseColor.rgb, vec3(.3, .59, .11));
#if C3MODE == 1
  float j = (fib - .5) * .7;
  float m = dn.r * c3rv(ar.r, c3Soft.x, j) + dn.g * c3rv(ar.g, c3Soft.y, j * .6);
  m = clamp(m * (.7 + .6 * fib), 0., 1.);
  diffuseColor.rgb *= mix(vec3(1.), pc, m);
  float ti = dn.b * c3rv(ar.b, c3Soft.z, 0.);
  diffuseColor.rgb = mix(diffuseColor.rgb, pc * (.86 + .28 * fib), ti);
#elif C3MODE == 2
  float m = clamp(dn.r * c3rv(ar.r, c3Soft.x, 0.) + dn.g * c3rv(ar.g, c3Soft.y, 0.) + dn.b * c3rv(ar.b, c3Soft.z, 0.), 0., 1.);
  diffuseColor.rgb = mix(diffuseColor.rgb, pc * (.55 + .9 * lum), m * .95);
#elif C3MODE == 3
  float h = clamp(dn.r * c3rv(ar.r, c3Soft.x, 0.) + dn.g * c3rv(ar.g, c3Soft.y, 0.), 0., 1.);
  float ln = dn.b * c3rv(ar.b, c3Soft.z, 0.) * (1. - h);
  diffuseColor.rgb = mix(diffuseColor.rgb * (1. - .75 * ln), vec3(.015), h);
  c3Emit = pc * h * c3Glow;
#else
  float m = clamp(dn.r * c3rv(ar.r, c3Soft.x, 0.) + dn.g * c3rv(ar.g, c3Soft.y, 0.) + dn.b * c3rv(ar.b, c3Soft.z, 0.), 0., 1.);
  diffuseColor.rgb = mix(diffuseColor.rgb, pc * (C3MODE == 4 ? (.75 + .5 * lum) : 1.), m);
#endif
}
`;
export function revealMat(Base, opts, { mode, col, den, arr, fib, T0, span, soft = [.05, .05, .02] }) {
  const m = new Base(opts);
  const U = { c3Col: { value: col }, c3Den: { value: den }, c3Arr: { value: arr }, c3Fib: { value: fib }, c3T: { value: 0 }, c3T0: { value: T0 }, c3Span: { value: span },
    c3Soft: { value: new THREE.Vector3(...soft) }, c3Glow: { value: 0 } };
  m.defines = { ...(m.defines || {}), C3MODE: mode };
  m.onBeforeCompile = s => {
    Object.assign(s.uniforms, U);
    s.fragmentShader = s.fragmentShader.replace('void main() {', HEAD + 'void main() {')
      .replace('#include <map_fragment>', BODY)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += c3Emit;');
  };
  m.customProgramCacheKey = () => 'c3mode' + mode + (Base === THREE.MeshPhysicalMaterial ? 'p' : 's');
  m.userData.U = U;
  return m;
}

// —————————————————— 素材预处理 ——————————————————
// 宣纸逆光照片 → 纤维高通图（灰度，0.5 = 平均）：做墨的纤维走向、纸的凹凸
export function fiberMap(img, w = CW, h = CHh) {
  const c = cv(w, h), x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h);
  const b = cv(w, h), y = b.getContext('2d'); y.filter = 'blur(14px)'; y.drawImage(c, 0, 0); y.filter = 'none';
  const D = x.getImageData(0, 0, w, h), B = y.getImageData(0, 0, w, h).data, d = D.data;
  for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3, lb = (B[i] + B[i + 1] + B[i + 2]) / 3, v = Math.max(0, Math.min(255, 128 + (l - lb) * 3.2)); d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  x.putImageData(D, 0, 0); return c;
}
export function grayOf(img, w, h, { gain = 1, blur = 0 } = {}) {
  const c = cv(w, h), x = c.getContext('2d'); if (blur) x.filter = `blur(${blur}px)`; x.drawImage(img, 0, 0, w, h); x.filter = 'none';
  const D = x.getImageData(0, 0, w, h), d = D.data; let s = 0; for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3; const mu = s / (d.length / 4);
  for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3, v = Math.max(0, Math.min(255, 128 + (l - mu) * gain)); d[i] = d[i + 1] = d[i + 2] = v; }
  x.putImageData(D, 0, 0); return c;
}

// —————————————————— 0 空白绫绢面：「美术语言」——————————————————
export function blankPanel(silk, text, times, sqT, T0) {
  const L = new Layers(4.5);
  const base = cv(CW, CHh), x = base.getContext('2d'); x.drawImage(silk, 0, 0, CW, CHh);
  x.fillStyle = 'rgba(250,240,220,.25)'; x.fillRect(0, 0, CW, CHh);
  const col = colCanvas(INK), xc = col.getContext('2d');
  // 句首朱红方块 + 标题（居中偏上）
  const size = .046, ym = .118, sq = size * .34;
  const tmp = cv(8, 8).getContext('2d'); tmp.font = font('SC', PS(size)); const tw = [...text].reduce((s, c) => s + tmp.measureText(c).width, 0) / PPX + size * .1 * 3;
  const xL = -(tw + sq + size * .5) / 2, sqx = xL, tx = xL + sq + size * .5;
  const rect = revealText(L, 0, text, tx - T0 + T0, ym, size, 0, { perChar: times.map(t => t - T0), ls: .1 });
  L.shapes(1, (y, col2, kind) => { y.fillStyle = kind === 'arr' ? L.g(sqT - T0 - .04) : col2(); y.fillRect(PX(sqx), PY(ym + size * .36 + sq / 2), PS(sq), PS(sq)); });
  xc.fillStyle = VERM; xc.fillRect(PX(sqx) - 4, PY(ym + size * .36 + sq / 2) - 4, PS(sq) + 8, PS(sq) + 8);
  // 下方一条细朱红线（版式的"注释感"）
  L.shapes(1, (y, col2, kind) => { y.fillStyle = kind === 'arr' ? L.g(sqT - T0) : col2(); y.fillRect(PX(xL), PY(ym - size * .42), PS(tw + sq + size * .5), PS(.0012)); });
  xc.fillStyle = VERM; xc.fillRect(PX(xL), PY(ym - size * .42) - 6, PS(tw + sq + size * .5), PS(.0012) + 12);
  return { base, col, L, rects: [{ id: 'ch3.title', text, ...rect, from: times[0] - .12 }] };
}

// —————————————————— 1 宣纸水墨 ——————————————————
export function inkPanel(xuan, fib, { title, titleT, sealT, farT, nearT }, T0) {
  const L = new Layers(8);
  const base = cv(CW, CHh), x = base.getContext('2d'); x.drawImage(xuan, 0, 0, CW, CHh);
  // 逆光纤维叠一点在纸面上（亮纤维 + 暗纤维），宣纸的"毛"
  x.save(); x.globalCompositeOperation = 'overlay'; x.globalAlpha = .55; x.drawImage(fib, 0, 0); x.restore();
  x.fillStyle = 'rgba(248,240,224,.18)'; x.fillRect(0, 0, CW, CHh);
  const col = colCanvas('#1d1814');                  // 墨色（暖黑）
  const n = fbm(noise2(31)), nm = fbm(noise2(47)), sk = fbm(noise2(53));
  // 山：ridge(x) = y0 + Σ 高斯峰；浓度向下化进雾里，峰线一圈积墨；到达时刻 = 落笔时刻 + 扩散（r^1.6）× 纤维噪声
  const range = (o) => {
    // 峰线：大形（高斯峰）+ 多尺度噪声（岩石的碎边）
    const ridge = xm => o.y0 + o.peaks.reduce((s, [c, a, w]) => s + a * Math.exp(-(((xm - c) / w) ** 2)), 0)
      + .007 * (n(xm * 34 + o.seed, 3.1) - .5) + .0035 * (n(xm * 110 + o.seed, 8.3) - .5) + .0012 * (n(xm * 380, 1.7) - .5);
    const seeds = o.peaks.map(([c], i) => [c, ridge(c), o.delay[i] ?? 0]);
    // 苔点：近山峰线上的浓墨点
    const R = mul(o.seed * 101), dots = [];
    if (o.dots) for (let i = 0; i < o.dots; i++) { const xx = o.xa + R() * (o.xb - o.xa); dots.push([xx, ridge(xx) - .002 - R() * .012, .0012 + R() * .0016]); }
    return (xm, ym) => {
      if (xm < o.xa - .03 || xm > o.xb + .03) return [0, 99];
      const yr = ridge(xm), taper = A_ss((xm - o.xa) / .05) * A_ss((o.xb - xm) / .05);
      const dep = yr - ym; let d;
      // 体：向下化进雾 × 云状斑驳 × 顺坡的干笔皴（纵向拉长）× 横向雾带；峰线：断续的积墨
      const streak = sk(xm * 260 + o.seed * 7, ym * 38), mott = nm(xm * 30, ym * 30), mist = A_ss((Math.abs(dep - o.fall * .55 - .012 * (n(xm * 20, 6.6) - .5)) ) / .012);
      const rimW = .0026 * (.5 + 1.1 * n(xm * 60 + 9, 1.7));
      if (dep >= 0) {
        d = o.den * Math.pow(1 - A_ss(dep / (o.fall * (.7 + .6 * n(xm * 18, 4.2)))), 1.15) * (.45 + .8 * mott) * (.4 + 1.1 * Math.pow(streak, 2.2)) * (.35 + .65 * mist)
          + o.rim * o.den * Math.exp(-((dep / rimW) ** 2)) * (.25 + 1.1 * Math.pow(n(xm * 140, ym * 140), 1.5));
      } else d = o.den * .55 * Math.exp(dep / .002) * (.5 + .7 * n(xm * 160, ym * 160));
      for (const [dx, dy, dr] of dots) { const q = Math.hypot(xm - dx, (ym - dy) * 1.3) / dr; if (q < 1.6) d += .95 * Math.exp(-q * q * 1.6) * (.7 + .6 * n(xm * 900, ym * 900)); }
      d *= taper;
      if (d < .003) return [0, 99];
      let best = 99; for (const [cx, cy, dl] of seeds) { const dd = Math.hypot((xm - cx) * .62, ym - cy) * (.7 + .6 * n(xm * 70, ym * 70)); best = Math.min(best, dl + o.spread * Math.pow(dd / o.dmax, 1.6)); }
      return [d, o.t + best];
    };
  };
  const far = [
    range({ xa: -.06, xb: .215, y0: .158, peaks: [[.03, .05, .035], [.1, .066, .03], [.165, .042, .03]], den: .5, fall: .085, rim: .55, t: farT - T0, spread: 4.4, dmax: .2, delay: [0, .35, .7], seed: 1 }),
    range({ xa: -.215, xb: .02, y0: .118, peaks: [[-.16, .036, .03], [-.08, .046, .028], [-.02, .022, .03]], den: .36, fall: .07, rim: .45, t: farT - T0 + .9, spread: 4.0, dmax: .2, delay: [.3, 0, .5], seed: 2 }),
  ];
  const near = [range({ xa: .02, xb: .215, y0: .098, peaks: [[.07, .036, .022], [.135, .05, .024], [.2, .02, .02]], den: .8, fall: .06, rim: .6, t: nearT - T0, spread: 2.4, dmax: .14, delay: [.25, 0, .4], seed: 3, dots: 26 })];
  L.field(0, (a, b) => { let d = 0, s = 99; for (const f of far) { const [dd, ss_] = f(a, b); if (dd > 0) { d += dd; s = Math.min(s, ss_); } } return [d, s]; });
  L.field(1, (a, b) => { let d = 0, s = 99; for (const f of near) { const [dd, ss_] = f(a, b); if (dd > 0) { d += dd; s = Math.min(s, ss_); } } return [d, s]; });
  // 标题「水墨」（左上）+ 朱文印「1960」
  const size = .036, tx = -.19, ty = .19;
  const r1 = revealText(L, 2, title, tx, ty, size, 0, { perChar: titleT.map(t => t - T0), ls: .08 });
  const sq = .026, sx = r1.x1 + .012, sy = ty - .002;
  L.shapes(2, (y, c2, kind) => {
    y.fillStyle = y.strokeStyle = kind === 'arr' ? L.g(sealT - T0 - .02) : c2();
    y.lineWidth = PS(.0016); y.beginPath(); y.roundRect(PX(sx), PY(sy + sq), PS(sq), PS(sq), PS(.002)); y.stroke();
    y.font = font('InterF', PS(.0108), 800); y.textAlign = 'center'; y.textBaseline = 'middle';
    y.fillText('19', PX(sx + sq / 2), PY(sy + sq * .72)); y.fillText('60', PX(sx + sq / 2), PY(sy + sq * .28));
    if (kind === 'den') { const R = mul(9); y.globalCompositeOperation = 'destination-out'; for (let i = 0; i < 160; i++) { y.beginPath(); y.arc(PX(sx + R() * sq), PY(sy + R() * sq), 1 + R() * 4, 0, TAU); y.fill(); } y.globalCompositeOperation = 'source-over'; }
  });
  const xc = col.getContext('2d'); xc.fillStyle = '#B8352A'; xc.fillRect(PX(sx) - 20, PY(sy + sq) - 20, PS(sq) + 40, PS(sq) + 40);
  const rs = { x0: sx, x1: sx + sq, y0: sy, y1: sy + sq };
  return { base, col, L, rects: [{ id: 'ch3.ink.name', text: title, ...r1, from: titleT[0] - .12 }, { id: 'ch3.ink.year', text: '1960', ...rs, from: sealT }] };
}
function A_ss(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }

// —————————————————— 2 壁画土墙 ——————————————————
// 卷草纹：沿内框（左下 → 左边上行 → 上边 → 右边下行）生长的波状主茎，每半个波长一支卷须 + 叶；云纹从中心晕开
export function muralPanel(wall, { title, sub, titleT, subT, vineT, vineDur, cloudT }, T0) {
  const L = new Layers(8);
  const base = cv(CW, CHh), x = base.getContext('2d'); x.filter = 'saturate(.55) brightness(1.06)'; x.drawImage(wall, 0, 0, CW, CHh); x.filter = 'none';
  // 墙面上的一层薄底色（土红 → 赭），墙面颗粒保留
  x.save(); x.globalCompositeOperation = 'multiply'; const gr = x.createLinearGradient(0, 0, 0, CHh); gr.addColorStop(0, '#F2DCC0'); gr.addColorStop(1, '#E6C7A2'); x.fillStyle = gr; x.fillRect(0, 0, CW, CHh); x.restore();
  const col = colCanvas('#3F7F66'), xc = col.getContext('2d');
  const C = { green: '#3E8467', green2: '#5FA07F', blue: '#2F5F98', red: '#B0402C', ochre: '#C8923A', white: '#EDE3CF', brown: '#6A3424' };
  // 路径：矩形内框，圆角
  const m = .016, xa = VIS.x0 + m, xb = VIS.x1 - m, ya = VIS.y0 + .018, yb = VIS.y1 - m, r = .016;
  const P = [];   // 折线采样（每 0.6 mm 一点）
  const seg = (x0, y0, x1, y1) => { const l = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(l / .0006); for (let i = 0; i < n; i++) P.push([x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]); };
  const arc = (cx, cy, a0, a1) => { const n = Math.ceil(Math.abs(a1 - a0) * r / .0006); for (let i = 0; i < n; i++) { const a = a0 + (a1 - a0) * i / n; P.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
  seg(xa, ya, xa, yb - r); arc(xa + r, yb - r, Math.PI, Math.PI / 2); seg(xa + r, yb, xb - r, yb); arc(xb - r, yb - r, Math.PI / 2, 0); seg(xb, yb - r, xb, ya);
  const S = [0]; for (let i = 1; i < P.length; i++) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const LEN = S[S.length - 1], lam = .044, amp = .0055;
  const tOf = s => vineT - T0 + vineDur * s / LEN;
  // 法线（指向框内）
  const nrm = i => { const a = P[Math.max(0, i - 2)], b = P[Math.min(P.length - 1, i + 2)], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1; return [ty / l, -tx / l]; };
  const stem = P.map((p, i) => { const [nx, ny] = nrm(i), w = amp * Math.sin(TAU * S[i] / lam); return [p[0] + nx * w, p[1] + ny * w]; });
  const items = [];   // 要画的笔画（同时写颜色、浓度、到达）
  // 两道边框线（赭石），和主茎一起生长
  for (const off of [-.0105, .0105]) items.push({ kind: 'line', pts: P.map((p, i) => { const [nx, ny] = nrm(i); return [p[0] + nx * off, p[1] + ny * off]; }), s: S, w: .0011, c: C.ochre });
  items.push({ kind: 'line', pts: stem, s: S, w: .0026, c: C.green });
  // 卷须 + 叶 + 花
  const R = mul(77);
  for (let k = 0; ; k++) {
    const s0 = (k + .25) * lam / 2; if (s0 > LEN - .004) break;
    const i0 = S.findIndex(v => v >= s0); const [nx, ny] = nrm(i0), side = k % 2 ? 1 : -1;
    const p0 = stem[i0], q = stem[Math.min(stem.length - 1, i0 + 3)], tx = q[0] - p0[0], ty = q[1] - p0[1], tl = Math.hypot(tx, ty) || 1;
    // 卷须：从主茎出发向一侧卷 1.3 圈的螺线
    let ang = Math.atan2(ty / tl + side * nx * 1.2, tx / tl + side * ny * 1.2), rad = .0062, px = p0[0], py = p0[1];
    const pts = [[px, py]], ss = [0];
    for (let j = 1; j < 70; j++) { const st = rad * .16; ang += side * .17; rad *= .975; px += Math.cos(ang) * st; py += Math.sin(ang) * st; pts.push([px, py]); ss.push(j / 69); }
    const t0 = tOf(s0);
    items.push({ kind: 'line', pts, s: ss.map(v => v), w: .0017, c: C.green, tfun: v => t0 + v * .3, taper: true });
    // 叶：沿卷须起点方向的半片忍冬叶（三瓣）
    const la = ang - side * 2.1, lc = k % 3 === 0 ? C.blue : C.green2;
    items.push({ kind: 'leaf', x: pts[8][0], y: pts[8][1], a: Math.atan2(pts[14][1] - pts[4][1], pts[14][0] - pts[4][0]) - side * .5, len: .014 + R() * .004, side, c: lc, t: t0 + .12 });
    if (k % 4 === 2) items.push({ kind: 'flower', x: pts[69][0], y: pts[69][1], r: .0042, t: t0 + .3 });
  }
  const draw = (y, col2, kind, colorPass) => {
    y.lineCap = 'round'; y.lineJoin = 'round';
    for (const it of items) {
      if (it.kind === 'line') {
        for (let i = 1; i < it.pts.length; i += 1) {
          const v = it.s[i], tt = it.tfun ? it.tfun(v) : tOf(v);
          y.strokeStyle = colorPass ? it.c : kind === 'arr' ? L.g(tt) : col2();
          y.lineWidth = PS(it.w) * (it.taper ? 1 - .6 * v : 1);
          y.beginPath(); y.moveTo(PX(it.pts[i - 1][0]), PY(it.pts[i - 1][1])); y.lineTo(PX(it.pts[i][0]), PY(it.pts[i][1])); y.stroke();
        }
      } else if (it.kind === 'leaf') {
        y.save(); y.translate(PX(it.x), PY(it.y)); y.rotate(-it.a); const l = PS(it.len), s = it.side;
        y.beginPath(); y.moveTo(0, 0); y.bezierCurveTo(l * .3, -s * l * .5, l * .75, -s * l * .45, l, -s * l * .08); y.bezierCurveTo(l * .7, -s * l * .12, l * .62, s * l * .02, l * .45, -s * l * .02);
        y.bezierCurveTo(l * .35, s * l * .1, l * .2, s * l * .12, 0, 0);
        if (colorPass) { y.fillStyle = it.c; y.fill(); y.strokeStyle = C.brown; y.lineWidth = 3; y.stroke(); y.strokeStyle = C.white; y.lineWidth = 2.5; y.beginPath(); y.moveTo(l * .1, -s * l * .05); y.quadraticCurveTo(l * .5, -s * l * .25, l * .85, -s * l * .1); y.stroke(); }
        else { y.fillStyle = kind === 'arr' ? L.g(it.t) : col2(); y.fill(); y.lineWidth = 3; y.strokeStyle = y.fillStyle; y.stroke(); }
        y.restore();
      } else if (it.kind === 'flower') {
        const cx = PX(it.x), cy = PY(it.y), rr = PS(it.r);
        for (let p = 0; p < 5; p++) { const a = p / 5 * TAU; y.beginPath(); y.ellipse(cx + Math.cos(a) * rr * .55, cy + Math.sin(a) * rr * .55, rr * .5, rr * .3, a, 0, TAU);
          y.fillStyle = colorPass ? C.red : kind === 'arr' ? L.g(it.t) : col2(); y.fill(); }
        y.beginPath(); y.arc(cx, cy, rr * .28, 0, TAU); y.fillStyle = colorPass ? C.ochre : kind === 'arr' ? L.g(it.t) : col2(); y.fill();
      }
    }
  };
  L.shapes(0, (y, c2, kind) => draw(y, c2, kind, false));
  draw(xc, null, 'col', true);
  // 云纹：三卷一尾，石青填色 + 白线 + 土红勾边；从中心向外显影（0.45 s）
  const clouds = [[-.035, .172, .016, 0], [.075, .182, .014, 1], [.155, .148, .012, 2], [-.125, .132, .011, 3]];
  const cloudPath = (y, cx, cy, s, flip) => {
    y.beginPath();
    for (const [dx, dy, rr] of [[-1.05, .05, .52], [-.25, .42, .62], [.6, .18, .5], [1.25, -.05, .32]]) { y.moveTo(PX(cx + dx * s * flip) + PS(rr * s), PY(cy + dy * s)); y.arc(PX(cx + dx * s * flip), PY(cy + dy * s), PS(rr * s), 0, TAU); }
    y.rect(PX(cx - 1.3 * s), PY(cy + .12 * s), PS(2.7 * s), PS(.4 * s));
  };
  clouds.forEach(([cx, cy, s, i]) => {
    const t0 = cloudT[i] - T0, flip = i % 2 ? -1 : 1;
    L.shapes(1, (y, c2, kind) => {
      if (kind === 'arr') { const g = y.createRadialGradient(PX(cx), PY(cy), 0, PX(cx), PY(cy), PS(s * 2)); g.addColorStop(0, L.g(t0 - .4)); g.addColorStop(1, L.g(t0)); y.fillStyle = g; } else y.fillStyle = c2();
      cloudPath(y, cx, cy, s, flip); y.fill();
      y.strokeStyle = y.fillStyle; y.lineWidth = PS(.0016); y.stroke();
    });
    xc.save(); cloudPath(xc, cx, cy, s, flip); xc.lineWidth = PS(.0016); xc.strokeStyle = C.brown; xc.stroke(); xc.fillStyle = i % 2 ? C.blue : C.green; xc.fill();
    xc.clip(); xc.strokeStyle = C.white; xc.lineWidth = PS(.0007);
    for (const [dx, dy, rr] of [[-1.05, .05, .52], [-.25, .42, .62], [.6, .18, .5]]) { xc.beginPath(); for (let k = 0; k < 50; k++) { const a = k / 50 * TAU * 1.2, q = rr * s * .7 * (1 - k / 62); const X = PX(cx + dx * s * flip) + Math.cos(a) * PS(q), Y = PY(cy + dy * s) + Math.sin(a) * PS(q); k ? xc.lineTo(X, Y) : xc.moveTo(X, Y); } xc.stroke(); }
    xc.restore();
  });
  // 标题「壁画」+ 小字「色彩与纹样」（土红褐，像墙上的榜题）
  const size = .032, tx = -.163, ty = .176;
  const r1 = revealText(L, 2, title, tx, ty, size, 0, { perChar: titleT.map(t => t - T0), ls: .08 });
  const r2 = revealText(L, 2, sub, tx + .001, ty - .021, .0118, 0, { f: 'SCM', perChar: subT.map(t => t - T0), dur: .03, ls: .12 });
  xc.fillStyle = '#5B2A1E'; xc.fillRect(PX(r1.x0) - 8, PY(r1.y1) - 8, PS(Math.max(r1.x1, r2.x1) - r1.x0) + 16, PY(r2.y0) - PY(r1.y1) + 16);
  return { base, col, L, rects: [{ id: 'ch3.mural.name', text: title, ...r1, from: titleT[0] - .12 }, { id: 'ch3.mural.sub', text: sub, ...r2, from: subT[0] }] };
}

// —————————————————— 3 红纸剪纸 ——————————————————
// 团花：纸是折成八折剪的 → 一刀同时开 8 个孔。每刀先出刻痕（0.1 s 沿轮廓走一圈），落刀那一帧孔透光
export function paperPanel(red, { title, titleT, cutT, cornerT }, T0) {
  const L = new Layers(8);
  const base = cv(CW, CHh), x = base.getContext('2d'); x.drawImage(red, 0, 0, CW, CHh);
  x.save(); x.globalCompositeOperation = 'multiply'; x.fillStyle = '#C9302A'; x.globalAlpha = .55; x.fillRect(0, 0, CW, CHh); x.restore();
  // 透光颜色：灯在纸后，中心更亮
  const col = cv(CW, CHh), xc = col.getContext('2d');
  const cx = -.085, cy = .128, Rf = .078;
  { const g = xc.createRadialGradient(PX(cx), PY(cy), 0, PX(cx), PY(cy), PS(.32)); g.addColorStop(0, '#FFF1CF'); g.addColorStop(.35, '#FFD796'); g.addColorStop(1, '#F2A75E'); xc.fillStyle = g; xc.fillRect(0, 0, CW, CHh); }
  const rot = (pts, a) => pts.map(([u, v]) => [u * Math.cos(a) - v * Math.sin(a), u * Math.sin(a) + v * Math.cos(a)]);
  const circ = (u, v, r, n = 28) => Array.from({ length: n }, (_, i) => [u + Math.cos(i / n * TAU) * r, v + Math.sin(i / n * TAU) * r]);
  const tear = (r0, r1, w) => { const out = []; for (let i = 0; i <= 24; i++) { const a = i / 24 * Math.PI; out.push([r0 + (r1 - r0) * (1 - Math.cos(a)) / 2, Math.sin(a) * w * Math.pow(Math.sin(a / 2 + .2), 1.5)]); } for (let i = 24; i >= 0; i--) { const [u, v] = out[i]; out.push([u, -v]); } return out; };
  const lens = (r, ang, len, w) => { const out = []; for (let i = 0; i <= 20; i++) { const s = i / 20, u = (s - .5) * len, v = Math.sin(s * Math.PI) * w; out.push([u, v]); } for (let i = 20; i >= 0; i--) { const s = i / 20; out.push([(s - .5) * len, -Math.sin(s * Math.PI) * w]); } return rot(out.map(([u, v]) => [u, v]), ang).map(([u, v]) => [u + Math.cos(ang) * r, v + Math.sin(ang) * r]); };
  const cres = (r, ang, rr) => { const out = []; for (let i = 0; i <= 24; i++) { const a = -2.2 + i / 24 * 4.4; out.push([Math.cos(a) * rr, Math.sin(a) * rr]); } for (let i = 24; i >= 0; i--) { const a = -1.75 + i / 24 * 3.5; out.push([Math.cos(a) * rr * .78 - rr * .38, Math.sin(a) * rr * .78]); } return rot(out, ang).map(([u, v]) => [u + Math.cos(ang) * r, v + Math.sin(ang) * r]); };
  const star = (n, ri, ro) => Array.from({ length: n * 2 }, (_, i) => { const a = i / (n * 2) * TAU, r = i % 2 ? ri : ro; return [Math.cos(a) * r, Math.sin(a) * r]; });
  const tri = (r0, r1, ang, w) => [[Math.cos(ang) * r0 - Math.sin(ang) * w, Math.sin(ang) * r0 + Math.cos(ang) * w], [Math.cos(ang) * r1, Math.sin(ang) * r1], [Math.cos(ang) * r0 + Math.sin(ang) * w, Math.sin(ang) * r0 - Math.cos(ang) * w]];
  const k8 = (f, off = 0, n = 8) => Array.from({ length: n }, (_, k) => f(off + k / n * TAU));
  const cuts = [
    [star(8, .0055, .0125)],
    k8(a => rot(tear(.017, .037, .0068), a)),
    k8(a => circ(Math.cos(a) * .031, Math.sin(a) * .031, .0034), TAU / 16),
    k8(a => cres(.047, a, .0085)),
    k8(a => tri(.0565, .0635, a, .0028), 0, 16),
    k8(a => lens(.0555, a, .0125, .0032), TAU / 16),
    k8(a => cres(.0705, a + Math.PI, .0062), 0),
    k8(a => circ(Math.cos(a) * .0745, Math.sin(a) * .0745, .0021), TAU / 32, 16),
  ];
  const holes = [];
  cuts.forEach((group, i) => group.forEach(poly => holes.push({ poly: poly.map(([u, v]) => [cx + u, cy + v]), t: cutT[i] - T0 })));
  // 四角角花（扇形三道弧槽 + 一颗圆孔）
  const cornersXY = [[VIS.x0 + .004, VIS.y1 - .004, 0], [VIS.x1 - .004, VIS.y1 - .004, 1], [VIS.x0 + .004, VIS.y0 + .004, 3], [VIS.x1 - .004, VIS.y0 + .004, 2]];
  cornersXY.forEach(([ux, uy, q], i) => {
    const a0 = -q * Math.PI / 2 - Math.PI / 2, t = cornerT[i] - T0;   // 扇形朝框内
    for (const [r0, r1] of [[.012, .016], [.021, .025], [.03, .034]]) { const pts = []; for (let k = 0; k <= 16; k++) { const a = a0 + .12 + k / 16 * (Math.PI / 2 - .24); pts.push([ux + Math.cos(a) * r1, uy + Math.sin(a) * r1]); } for (let k = 16; k >= 0; k--) { const a = a0 + .12 + k / 16 * (Math.PI / 2 - .24); pts.push([ux + Math.cos(a) * r0, uy + Math.sin(a) * r0]); } holes.push({ poly: pts, t }); }
    const am = a0 + Math.PI / 4; holes.push({ poly: circ(ux + Math.cos(am) * .042, uy + Math.sin(am) * .042, .0032), t });
  });
  const path = (y, poly) => { y.beginPath(); poly.forEach(([u, v], i) => i ? y.lineTo(PX(u), PY(v)) : y.moveTo(PX(u), PY(v))); y.closePath(); };
  L.shapes(0, (y, c2, kind) => { for (const h of holes) { y.fillStyle = kind === 'arr' ? L.g(h.t) : c2(); path(y, h.poly); y.fill(); } });
  // 刻痕：落刀前 0.1 s 沿轮廓走一圈
  L.shapes(2, (y, c2, kind) => {
    y.lineWidth = PS(.00055); y.lineCap = 'round';
    for (const h of holes) { const n = h.poly.length; for (let i = 0; i < n; i++) { const a = h.poly[i], b = h.poly[(i + 1) % n]; y.strokeStyle = kind === 'arr' ? L.g(h.t - .11 + .09 * i / n) : c2(); y.beginPath(); y.moveTo(PX(a[0]), PY(a[1])); y.lineTo(PX(b[0]), PY(b[1])); y.stroke(); } }
  });
  // 标题「剪纸」：剪出来的透光字（每字一刀）
  const size = .034, tx = .038, ty = .19;
  const r1 = revealText(L, 1, title, tx, ty, size, 0, { perChar: titleT.map(t => t - T0), dur: .02, ls: .1 });
  return { base, col, L, rects: [{ id: 'ch3.paper.name', text: title, ...r1, from: titleT[0] }], flower: { cx, cy, R: Rf } };
}

// —————————————————— 4 毛毡 ——————————————————
export function feltCanvas(w, h, hex, seed, { fibers = 1, light = 12, dark = 14 } = {}) {
  const c = cv(w, h), x = c.getContext('2d'); x.fillStyle = hex; x.fillRect(0, 0, w, h);
  const R = mul(seed), base = new THREE.Color(hex), hsl = {}; base.getHSL(hsl);
  // 绒面斑驳
  for (let i = 0; i < 260; i++) { const px = R() * w, py = R() * h, r = 20 + R() * 120, g = x.createRadialGradient(px, py, 0, px, py, r), dk = R() < .5;
    g.addColorStop(0, dk ? `rgba(0,0,0,${.06 * R()})` : `rgba(255,255,255,${.05 * R()})`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(px - r, py - r, 2 * r, 2 * r); }
  // 短纤维：几十万根，亮暗两种，随机方向、微弯
  const n = Math.round(w * h * .11 * fibers); x.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const px = R() * w, py = R() * h, a = R() * TAU, l = 2 + R() * 7, up = R() < .5;
    const L_ = Math.max(0, Math.min(100, hsl.l * 100 + (up ? light : -dark) * R()));
    x.strokeStyle = `hsla(${hsl.h * 360 + (R() - .5) * 8},${hsl.s * 100 * (.8 + .3 * R())}%,${L_}%,${.16 + .22 * R()})`; x.lineWidth = .5 + R() * .9;
    x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo(px + Math.cos(a + 1) * l * .5, py + Math.sin(a + 1) * l * .5, px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke();
  }
  // 绒面：整体轻微柔化（纤维糊在一起），再叠一层极细的亮绒
  const o = cv(w, h), y = o.getContext('2d'); y.filter = 'blur(.9px)'; y.drawImage(c, 0, 0); y.filter = 'none';
  for (let i = 0; i < n * .25; i++) { const px = R() * w, py = R() * h, a = R() * TAU, l = 1.5 + R() * 4; y.strokeStyle = `hsla(${hsl.h * 360},${hsl.s * 60}%,${Math.min(95, hsl.l * 100 + 22)}%,${.12 + .12 * R()})`; y.lineWidth = .5;
    y.beginPath(); y.moveTo(px, py); y.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); y.stroke(); }
  return o;
}
export function feltPanel(feltBase, { title, titleT }, T0) {
  const L = new Layers(8);
  const base = cv(CW, CHh), x = base.getContext('2d'); x.drawImage(feltBase, 0, 0, CW, CHh);
  // 上沿一排金线小星（刺绣），静态
  const R = mul(5); x.strokeStyle = 'rgba(217,164,65,.85)'; x.lineWidth = 3;
  for (let i = 0; i < 26; i++) { const sx = PX(VIS.x0 + .012 + i * (VIS.x1 - VIS.x0 - .024) / 25), sy = PY(VIS.y1 - .011 - (i % 2) * .005), r = 9 + R() * 3;
    for (let k = 0; k < 4; k++) { const a = k / 4 * Math.PI; x.beginPath(); x.moveTo(sx - Math.cos(a) * r, sy - Math.sin(a) * r); x.lineTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r); x.stroke(); } }
  // 标题「木偶」：金色毛毡贴布字 + 明线（颜色图里画好纤维与针脚）
  const col = feltCanvas(CW, CHh, '#D2A040', 12, { light: 14, dark: 18 }), xc = col.getContext('2d');
  const size = .04, tx = -.19, ty = .178;
  const r1 = revealText(L, 0, title, tx, ty, size, 0, { perChar: titleT.map(t => t - T0), ls: .1 });
  // 针脚：字形内收后的虚线（用描边近似）
  xc.save(); xc.font = font('SC', PS(size)); xc.setLineDash([10, 9]); xc.lineWidth = 3; xc.strokeStyle = 'rgba(255,240,205,.9)';
  let xx = PX(tx); const tmp = cv(8, 8).getContext('2d'); tmp.font = font('SC', PS(size));
  for (const ch of title) { xc.strokeText(ch, xx, PY(ty)); xx += tmp.measureText(ch).width + .1 * PS(size); }
  xc.restore();
  return { base, col, L, rects: [{ id: 'ch3.puppet.name', text: title, ...r1, from: titleT[0] - .12 }] };
}

// —————————————————— 纸件：纸框、拉片纸栏、拉头、小舞台 ——————————————————
const P5 = A.PX;
function inked(x, fill, lw, colr = INK) { if (fill) { x.fillStyle = fill; x.fill(); } if (lw) { x.lineWidth = lw; x.strokeStyle = colr; x.lineJoin = 'round'; x.stroke(); } }
// 纸框：外框 w×h，窗口 [wx0,wx1]×[wy0,wy1]（米，原点 = 底边中点）
export function frameArt(w, h, win) {
  const pad = 30, c = cv(w * P5 + 2 * pad, h * P5 + 2 * pad), x = c.getContext('2d');
  const X = m => pad + (m + w / 2) * P5, Y = m => pad + (h - m) * P5;
  x.beginPath(); x.roundRect(pad, pad, w * P5, h * P5, 22); inked(x, '#F1E2C4', 10);
  // 版框：外一圈细墨线 + 朱红线
  x.strokeStyle = 'rgba(58,42,32,.55)'; x.lineWidth = 3; x.strokeRect(pad + 26, pad + 26, w * P5 - 52, h * P5 - 52);
  x.strokeStyle = VERM; x.lineWidth = 7; x.strokeRect(X(win[0]) - 44, Y(win[3]) - 44, (win[1] - win[0]) * P5 + 88, (win[3] - win[2]) * P5 + 88);
  // 斜切口（卡纸窗口的白色斜面）
  x.fillStyle = '#FFF9EC'; x.fillRect(X(win[0]) - 18, Y(win[3]) - 18, (win[1] - win[0]) * P5 + 36, (win[3] - win[2]) * P5 + 36);
  x.strokeStyle = INK; x.lineWidth = 5; x.strokeRect(X(win[0]) - 18, Y(win[3]) - 18, (win[1] - win[0]) * P5 + 36, (win[3] - win[2]) * P5 + 36);
  // 四角朱红小方块（与纸条标签同一个记号）
  for (const [u, v] of [[win[0], win[3]], [win[1], win[3]], [win[0], win[2]], [win[1], win[2]]]) { x.fillStyle = VERM; x.fillRect(X(u) + (u < 0 ? -78 : 50), Y(v) + (v > h / 2 ? -78 : 50), 28, 28); }
  x.save(); x.globalCompositeOperation = 'destination-out'; x.fillRect(X(win[0]), Y(win[3]), (win[1] - win[0]) * P5, (win[3] - win[2]) * P5); x.restore();
  return finishCut(c, 18);
}
// 拉片纸栏：长 w、高 h；四档刻线 + 档名，active = 当前档（朱红）
export function railArt(w, h, notchX, names, active) {
  const pad = 30, c = cv(w * P5 + 2 * pad, h * P5 + 2 * pad), x = c.getContext('2d');
  const X = m => pad + (m + w / 2) * P5, Y = m => pad + (h - m) * P5;
  x.beginPath(); x.roundRect(pad, pad, w * P5, h * P5, 26); inked(x, '#F6EBD4', 9);
  // 槽
  x.beginPath(); x.roundRect(X(-w / 2 + .012), Y(.0262), (w - .024) * P5, .0036 * P5, 9); inked(x, '#5A4330', 0);
  x.fillStyle = 'rgba(0,0,0,.25)'; x.fillRect(X(-w / 2 + .012), Y(.0262), (w - .024) * P5, 4);
  // 刻度：小刻（每 1 cm）+ 档位大刻
  x.fillStyle = INK;
  for (let m = -w / 2 + .02; m <= w / 2 - .02 + 1e-9; m += .01) x.fillRect(X(m) - 2, Y(.0215), 4, .0022 * P5);
  notchX.forEach((m, i) => {
    x.fillStyle = i === active ? VERM : INK; x.fillRect(X(m) - 5, Y(.0225), 10, .0055 * P5);
    x.beginPath(); x.moveTo(X(m) - 18, Y(.0225)); x.lineTo(X(m) + 18, Y(.0225)); x.lineTo(X(m), Y(.0195)); x.closePath(); x.fill();
    x.font = font('SC', .0098 * P5); x.textAlign = 'center'; x.textBaseline = 'alphabetic'; x.fillText(names[i], X(m), Y(.0045));
  });
  // 左端：朱红小方块（与标签同一个记号）
  x.fillStyle = VERM; x.fillRect(X(-w / 2 + .008), Y(.016), .006 * P5, .006 * P5);
  return finishCut(c, 14);
}
export function knobArt(w, h) {
  const pad = 30, c = cv(w * P5 + 2 * pad, h * P5 + 2 * pad), x = c.getContext('2d');
  const W = w * P5, H = h * P5, tip = .006 * P5;
  x.beginPath(); x.moveTo(pad + W / 2, pad + H); x.lineTo(pad + W * .2, pad + H - tip); x.lineTo(pad, pad + H - tip); x.lineTo(pad, pad + 20); x.quadraticCurveTo(pad, pad, pad + 20, pad); x.lineTo(pad + W - 20, pad); x.quadraticCurveTo(pad + W, pad, pad + W, pad + 20); x.lineTo(pad + W, pad + H - tip); x.lineTo(pad + W * .8, pad + H - tip); x.closePath();
  inked(x, VERM, 9);
  x.beginPath(); x.arc(pad + W / 2, pad + .0075 * P5, .0028 * P5, 0, TAU); x.fillStyle = '#3a2418'; x.fill();
  x.strokeStyle = 'rgba(58,20,14,.55)'; x.lineWidth = 6; for (let i = 0; i < 4; i++) { const yy = pad + .015 * P5 + i * .0035 * P5; x.beginPath(); x.moveTo(pad + W * .25, yy); x.lineTo(pad + W * .75, yy); x.stroke(); }
  return finishCut(c, 12);
}
// 毛毡小舞台框：拱形台口
export function prosArt(w, h, ow, oh, felt) {
  const pad = 30, c = cv(w * P5 + 2 * pad, h * P5 + 2 * pad), x = c.getContext('2d');
  const W = w * P5, H = h * P5, X = m => pad + (m + w / 2) * P5, Y = m => pad + (h - m) * P5;
  const shape = () => { x.beginPath(); x.moveTo(pad, pad + H); x.lineTo(pad, pad + .03 * P5); x.quadraticCurveTo(pad + W / 2, pad - .012 * P5, pad + W, pad + .03 * P5); x.lineTo(pad + W, pad + H); x.closePath(); };
  shape(); x.save(); x.clip(); x.drawImage(felt, 0, 0, c.width, c.height); x.restore(); shape(); inked(x, null, 10, '#3A1E10');
  // 台口：圆拱
  const arch = (inset) => { x.beginPath(); x.moveTo(X(-ow / 2 - inset), Y(0)); x.lineTo(X(-ow / 2 - inset), Y(oh - ow * .22)); x.quadraticCurveTo(X(0), Y(oh + ow * .12 + inset), X(ow / 2 + inset), Y(oh - ow * .22)); x.lineTo(X(ow / 2 + inset), Y(0)); x.closePath(); };
  // 明线：台口外一圈虚线针脚 + 外框一圈
  x.setLineDash([16, 12]); x.lineWidth = 5; x.strokeStyle = 'rgba(255,236,190,.9)'; arch(.006); x.stroke();
  x.beginPath(); x.moveTo(pad + 30, pad + H - 30); x.lineTo(pad + 30, pad + .034 * P5); x.quadraticCurveTo(pad + W / 2, pad - .002 * P5, pad + W - 30, pad + .034 * P5); x.lineTo(pad + W - 30, pad + H - 30); x.stroke(); x.setLineDash([]);
  // 顶上一颗朱红毛毡圆章
  x.beginPath(); x.arc(X(0), Y(h - .016), .0075 * P5, 0, TAU); inked(x, VERM, 6, '#5a1e14');
  x.save(); x.globalCompositeOperation = 'destination-out'; arch(0); x.fill(); x.restore();
  return finishCut(c, 16);
}

// —————————————————— 地面页与背板 ——————————————————
export function floorArt(silk, PWm, PDm, slits) {
  const w = PWm * P5, h = PDm * P5, c = cv(w, h), x = c.getContext('2d');
  x.drawImage(silk, 0, 0, w, h);
  x.save(); x.globalCompositeOperation = 'multiply'; x.fillStyle = '#E6CFA6'; x.fillRect(0, 0, w, h); x.restore();
  const R = mul(23);
  for (let i = 0; i < 60; i++) { const px = R() * w, py = R() * h, r = (40 + R() * 220) * w / 2400, g = x.createRadialGradient(px, py, 0, px, py, r), dk = R() < .5;
    g.addColorStop(0, dk ? `rgba(120,90,60,${.05 * R()})` : `rgba(255,255,255,${.07 * R()})`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(px - r, py - r, 2 * r, 2 * r); }
  const gg = x.createLinearGradient(0, 0, 0, .05 * P5); gg.addColorStop(0, 'rgba(60,40,20,.3)'); gg.addColorStop(1, 'rgba(60,40,20,0)'); x.fillStyle = gg; x.fillRect(0, 0, w, .05 * P5);
  x.strokeStyle = VERM; x.lineWidth = 8; x.strokeRect(.012 * P5, .012 * P5, w - .024 * P5, h - .024 * P5); x.lineWidth = 3; x.strokeRect(.017 * P5, .017 * P5, w - .034 * P5, h - .034 * P5);
  // 切口：卡片从这里升起
  for (const [sx, sz, sw] of slits) { const px = (sx + PWm / 2) * P5, pz = (sz + PDm / 2) * P5; x.fillStyle = 'rgba(70,48,30,.75)'; x.fillRect(px - sw / 2 * P5, pz - 3, sw * P5, 6); x.fillStyle = 'rgba(255,250,236,.6)'; x.fillRect(px - sw / 2 * P5, pz + 3, sw * P5, 2); }
  x.save(); x.globalCompositeOperation = 'source-atop'; x.globalAlpha = .8; x.fillStyle = x.createPattern(A.GRAIN, 'repeat'); x.fillRect(0, 0, w, h); x.restore();
  return c;
}
export function backArt(PWm, PDm) {
  const w = PWm * P5, h = PDm * P5, c = cv(w, h), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#CDB48C'); g.addColorStop(1, '#BCA27A'); x.fillStyle = g; x.fillRect(0, 0, w, h);
  x.save(); x.globalCompositeOperation = 'source-atop'; x.globalAlpha = .8; x.fillStyle = x.createPattern(A.GRAIN, 'repeat'); x.fillRect(0, 0, w, h); x.restore();
  return c;
}
export { GOLD };
