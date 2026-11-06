// util.js — C 奇谭共用：缓动、确定性哈希、母题函数（JS 与 GLSL 逐字同式）、全片常量
// 确定性：这里没有任何随机数与时间读取，全部是参数的纯函数。
import * as THREE from 'three';

export const DEG = Math.PI / 180;
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const seg = (t, a, b) => clamp((t - a) / (b - a));
export const ss = x => { x = clamp(x); return x * x * (3 - 2 * x); };
export const ss5 = x => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10); };
export const eio = x => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
export const eo = x => 1 - Math.pow(1 - clamp(x), 3);
export const ei = x => Math.pow(clamp(x), 3);
export const ei2 = x => { x = clamp(x); return x * x; };
// 整数哈希 → [0,1)
export const hashi = n => { let h = (n | 0) * 374761393 + 668265263; h = (h ^ (h >>> 13)) * 1274126177; h ^= h >>> 16; return (h >>> 0) / 4294967296; };
export const hash2 = (a, b) => hashi((a | 0) * 7919 + (b | 0) * 104729 + 17);
// 分段线性关键帧：keys = [[x, v], ...]
export function keys(k, x) {
  if (x <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) if (x <= k[i][0]) { const [x0, v0] = k[i - 1], [x1, v1] = k[i]; return v0 + (v1 - v0) * (x - x0) / (x1 - x0); }
  return k[k.length - 1][1];
}
export const col = h => new THREE.Color(h);              // 线性工作空间
export const srgb = h => { const c = new THREE.Color(h); const o = {}; c.getRGB(o, THREE.SRGBColorSpace); return new THREE.Vector3(o.r, o.g, o.b); };
export const lin3 = h => { const c = new THREE.Color(h); return new THREE.Vector3(c.r, c.g, c.b); };

// ── 全片常量（设计尺寸 1920×1040，用时乘 K） ──
export const P_MOTIF = [1180, 600];                       // 墨渍 → 豹斑 → 光斑 同一屏幕点
export const EYE_E = { cx: 1010, cy: 500, rx: 236, ry: 200, tilt: -12 };   // T2 豹眼 / 镜片 同一椭圆
export const STAR_H = [950, 455];                         // 四芒星中心（S1b、T2 共用）

// ── 母题 v2（返修 style-02）：环由 k 段（3–6）大小不一的墨团组成，断口宽 10–45%（按哈希），段端圆头（距离场取并）；
//    半径起伏 .30 + 6–8 倍频 .12；粗细起伏 ±70%；整体随机转；沿一个接近水平的方向拉长 1.2–1.5 倍（毛流）。
//    与 GLSL 逐字同式。所有随机量都从 ph（4 个相位）派生，种子 7 在哪里画都是同一个形。
// 种子 7（母题那一枚）的形取自候选里最像豹斑的一枚（基 14）；其余种子照常
export function motifPh(seed) { const b = seed === 7 ? 14 : seed; return [0, 1, 2, 3].map(i => hashi(b * 4 + i) * 6.2832); }
export const motifK = seed => (seed === 7 ? 5 : 3 + Math.floor(hashi(seed * 13 + 5) * 4));
const _fr = x => x - Math.floor(x);
const _mh = (i, s) => _fr(Math.sin(i * 12.9898 + s * 78.233) * 43758.5453);
export function motifField(qx, qy, ph, k, gapK) {
  const th = (ph[2] - 3.1416) * .25, cs = Math.cos(th), sn = Math.sin(th);
  let x = cs * qx + sn * qy, y = -sn * qx + cs * qy;
  x /= 1.2 + .3 * _fr(ph[3] * .159);
  const r = Math.hypot(x, y), a = Math.atan2(y, x);
  const rhoA = b => 1. + .30 * (.55 * Math.sin(2. * b + ph[0]) + .30 * Math.sin(3. * b + ph[1]) + .15 * Math.sin(5. * b + ph[2]))
    + .12 * (.5 * Math.sin(6. * b + ph[3]) + .3 * Math.sin(7. * b + ph[0] * 1.7) + .2 * Math.sin(8. * b + ph[1] * 2.3));
  const rho = rhoA(a);
  let sd = 1e9;
  for (let i = 0; i < 6; i++) {
    if (i >= k) break;
    const h1 = _mh(i, ph[0]), h2 = _mh(i + 7., ph[1]), h3 = _mh(i + 13., ph[2]);
    const c = ph[3] + (i + .5 + .3 * (h1 - .5)) * 6.2832 / k;
    const hs = 3.1416 / k * (1. - lerp(.10, .45, h2) * gapK) + (1. - gapK) * .18;
    let dl = a - c; dl -= 6.2832 * Math.floor((dl + 3.1416) / 6.2832);
    const w = .34 * (1. + .5 * (2. * h3 - 1.)) * (1. + .2 * Math.sin(3. * a + ph[3]));
    let d, u;
    if (Math.abs(dl) <= hs) { d = Math.abs(r - rho); u = dl / hs; }
    else { const e = c + Math.sign(dl) * hs, re = rhoA(e); d = Math.hypot(x - re * Math.cos(e), y - re * Math.sin(e)); u = Math.sign(dl); }
    sd = Math.min(sd, d - .5 * w * (1. - .4 * u * u));
  }
  return [sd, rho, r];
}
export function motif(qx, qy, ph, k, soft, gapK) {
  const [sd, rho, r] = motifField(qx, qy, ph, k, gapK);
  const sst = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
  const sf = Math.max(soft, .015);
  const ring = 1.0 - sst(-sf, sf, sd);
  const core = 1.0 - sst(0.0, 0.78 * rho, r);
  return [ring, core];
}

// ── GLSL 公共件 ──
export const GLSL_COMMON = /* glsl */`
uint pcgh(uint v){ uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float h21(ivec2 p, uint seed){ return float(pcgh(uint(p.x) + pcgh(uint(p.y) + seed))) * (1.0 / 4294967295.0); }
float h11(float x, uint seed){ return h21(ivec2(int(floor(x)), 0), seed); }
float vnoise(vec2 x, uint seed){
  vec2 i = floor(x), f = fract(x); ivec2 ii = ivec2(i);
  vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);
  float a = h21(ii, seed), b = h21(ii + ivec2(1, 0), seed), c = h21(ii + ivec2(0, 1), seed), d = h21(ii + ivec2(1, 1), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// fbm：约 [-.5, .5]
float fbm(vec2 p, uint s){ float a = 0., m = .5; for (int i = 0; i < 4; i++) { a += m * vnoise(p, s + uint(i) * 101u); p = p * 2.03 + vec2(17.1, 9.3); m *= .5; } return a / .9375 - .5; }
float fbm3(vec2 p, uint s){ float a = 0., m = .5; for (int i = 0; i < 3; i++) { a += m * vnoise(p, s + uint(i) * 101u); p = p * 2.03 + vec2(17.1, 9.3); m *= .5; } return a / .875 - .5; }
float sst(float a, float b, float x){ float t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
float lum(vec3 c){ return dot(c, vec3(.2126, .7152, .0722)); }
vec3 s2l(vec3 c){ return pow(max(c, 0.), vec3(2.2)); }
vec3 l2s(vec3 c){ return pow(max(c, 0.), vec3(1. / 2.2)); }
// 母题 v2（返修 style-02）：q 以斑心为原点、按斑半径归一。环 = k 段大小不一的墨团（圆头弧段的距离场取并）；
// 断口宽 10–45%（哈希）；半径起伏 .30 + 6–8 倍频 .12；粗细 ±70%；整体随机转；沿近水平方向拉长 1.2–1.5。
// motifField 返回 (sd：到墨团边的有符号距离（里负外正），rho：当地环半径，r：到斑心距离)
float mfr(float x){ return x - floor(x); }
float mh(float i, float s){ return mfr(sin(i * 12.9898 + s * 78.233) * 43758.5453); }
float mRho(float b, vec4 ph){ return 1. + .30 * (.55 * sin(2. * b + ph.x) + .30 * sin(3. * b + ph.y) + .15 * sin(5. * b + ph.z))
  + .12 * (.5 * sin(6. * b + ph.w) + .3 * sin(7. * b + ph.x * 1.7) + .2 * sin(8. * b + ph.y * 2.3)); }
vec3 motifField(vec2 q, vec4 ph, float k, float gapK){
  float th = (ph.z - 3.1416) * .25, cs = cos(th), sn = sin(th);
  vec2 p = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y);
  p.x /= 1.2 + .3 * mfr(ph.w * .159);
  float r = length(p), a = atan(p.y, p.x);
  float rho = mRho(a, ph);
  float sd = 1e9;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    if (fi >= k) break;
    float h1 = mh(fi, ph.x), h2 = mh(fi + 7., ph.y), h3 = mh(fi + 13., ph.z);
    float c = ph.w + (fi + .5 + .3 * (h1 - .5)) * 6.2832 / k;
    float hs = 3.1416 / k * (1. - mix(.10, .45, h2) * gapK) + (1. - gapK) * .18;
    float dl = a - c; dl -= 6.2832 * floor((dl + 3.1416) / 6.2832);
    float w = .34 * (1. + .5 * (2. * h3 - 1.)) * (1. + .2 * sin(3. * a + ph.w));
    float d, u;
    if (abs(dl) <= hs) { d = abs(r - rho); u = dl / hs; }
    else { float e = c + sign(dl) * hs; float re = mRho(e, ph); d = length(p - re * vec2(cos(e), sin(e))); u = sign(dl); }
    sd = min(sd, d - .5 * w * (1. - .4 * u * u));
  }
  return vec3(sd, rho, r);
}
vec2 motif(vec2 q, vec4 ph, float k, float soft, float gapK){
  vec3 F = motifField(q, ph, k, gapK);
  float sf = max(soft, .015);
  float ring = 1.0 - smoothstep(-sf, sf, F.x);
  float core = 1.0 - smoothstep(0.0, 0.78 * F.y, F.z);
  return vec2(ring, core);
}
// 第 4 轮（qa2-07）：翻色前沿（S4c）——原来是 sst(±80) + 160·fbm(/240)，在天上几乎是一条笔直的竖向软边（像数字擦除）。
//   现在：前沿带斜度（上端领先约 160K）、两个尺度的水彩起伏（±150K / 320K、±45K / 80K），过渡收窄到 ±50K，
//   前沿里侧一道 20K 的颜料积色由 post.js 按同一个距离画。返回"到前沿的有符号距离"（>0 在已翻色的一侧），各着色器共用
float wipeD(vec2 dp, float wx){ return dp.x - wx - .3 * (dp.y - 520.) + 300. * fbm(dp / 320., 5u) + 90. * fbm(dp / 80., 6u); }
// 椭圆：p 到椭圆 (c, r, tilt) 的归一化半径
float ellR(vec2 p, vec2 c, vec2 r, float tilt){ vec2 d = p - c; float cs = cos(tilt), sn = sin(tilt); d = vec2(cs * d.x + sn * d.y, -sn * d.x + cs * d.y); return length(d / r); }
`;

// ── 纹理加载 ──
export async function loadTextures(list) {
  const L = new THREE.TextureLoader(), T = {};
  await Promise.all(Object.entries(list).map(async ([k, url]) => {
    const t = await L.loadAsync(url);
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8;
    t.generateMipmaps = true;
    T[k] = t;
  }));
  return T;
}

// 一拍二：姿态时间
export const tcOf = f => 2 * Math.floor(f / 2) / 24;
