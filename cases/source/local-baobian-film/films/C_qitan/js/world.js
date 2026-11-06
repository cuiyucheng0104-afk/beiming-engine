// world.js — 场景 B：南山雾崖（T1 门内、S2a、S2b、S4c、S5a）
// 原点 = 小豹坐在洞口唇上的那一点；+x 朝谷（侧面舞台的画右），+y 向上，+z 朝侧面舞台的相机。
// 3D：崖台、后壁、洞口拱、松、石、草（卡通着色 + 墨线）；2D：天、南山底板、脊线、雾带、雾团、太阳、辉光点、精灵（豹、陆蔚、鹿）。
// 灰 → 彩：屏幕空间翻色前沿 SHARED.uWipeX（设计像素），所有材质共用。
import * as THREE from 'three';
import { GLSL_COMMON, DEG, clamp, lerp, seg, ss, ss5, eo, eio, ei2, hashi, keys, lin3, srgb, motifPh, motifK, tcOf } from './util.js';
import { makeToon, outlined, SHARED, GLSL_3D } from './toonmat.js';
import { makeSprite, setBends, setSpots, setEye, setExclude, placeWorld, placeOnCam, texPx } from './sprite.js';
import { createNoise3D } from '/engine/core/noise.js';
import { mulberry } from '/engine/core/math.js';
import { inkStroke } from '/engine/core/stroke.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const PV = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;
const WIPE = /* glsl */`uniform float uWipeX, uK, uMixB, uWipeOn;
float wipeM(){ vec2 dp = vec2(gl_FragCoord.x / uK, 1040. - gl_FragCoord.y / uK); return max(uMixB, uWipeOn * sst(-50., 50., wipeD(dp, uWipeX))); }`;   // 第 4 轮（qa2-07）：前沿形状见 util.js wipeD
const wipeU = (on = 1) => ({ uWipeX: SHARED.uWipeX, uK: SHARED.uK, uMixB: { value: 0 }, uWipeOn: { value: on } });
const sm = (vs, fs, uniforms, o = {}) => new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms, transparent: true, depthWrite: false, toneMapped: false, ...o });
const UNIT = new THREE.PlaneGeometry(1, 1);

// ── 天穹 ──
const SKY_VS = /* glsl */`varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;
const SKY_FS = /* glsl */`${GLSL_COMMON}${WIPE}
uniform vec3 uZ, uM, uH, uL, uZB, uMB, uHB, uLB, uSunDir, uSunC; uniform float uSunGlow;
varying vec3 vDir;
vec3 grad(vec3 z, vec3 m, vec3 h, vec3 l, float e){ return e > 0. ? mix(h, mix(m, z, sst(.16, .62, e)), sst(0., .16, e)) : mix(h, l, sst(0., -.08, e)); }
void main(){
  vec3 d = normalize(vDir); float wm = wipeM();
  vec3 c = mix(grad(uZ, uM, uH, uL, d.y), grad(uZB, uMB, uHB, uLB, d.y), wm);
  c += uSunC * pow(max(dot(d, normalize(uSunDir)), 0.), 6.) * uSunGlow;
  gl_FragColor = vec4(c, 1.);
}`;
// ── 南山底板：A18 → A19 按翻色前沿；四边淡进天色 ──
const PLATE_FS = /* glsl */`${GLSL_COMMON}${WIPE}
uniform sampler2D tA, tB; uniform vec3 uTintA, uTintB; uniform vec4 uEdge; uniform float uAlpha;
varying vec2 vUv;
void main(){
  float wm = wipeM();
  vec3 c = mix(texture2D(tA, vUv).rgb * uTintA, texture2D(tB, vUv).rgb * uTintB, wm);
  float a = sst(0., uEdge.x, vUv.x) * sst(0., uEdge.y, 1. - vUv.x) * sst(0., uEdge.z, vUv.y) * sst(0., uEdge.w, 1. - vUv.y);
  gl_FragColor = vec4(c, a * uAlpha);
}`;
// ── 脊线：上缘 3 阶 fbm，下面渐隐进雾，加竖向干笔噪声 ──
const RIDGE_FS = /* glsl */`${GLSL_COMMON}${WIPE}
uniform vec3 uC, uCB, uFog, uFogB; uniform float uSeed, uTop, uAmp, uFade, uAlpha, uSoftV, uOct, uDryK;
varying vec2 vUv;
void main(){
  float wm = wipeM();
  float top = uTop + uAmp * 2. * fbm3(vec2(vUv.x * 6.5 + uSeed * 3.1, uSeed), 33u) + uAmp * .5 * fbm3(vec2(vUv.x * 31. + uSeed, 2. * uSeed), 34u) + uOct * uAmp * .9 * fbm3(vec2(vUv.x * 16. + uSeed * 1.7, 3. * uSeed), 36u);
  float d = top - vUv.y;
  if (d < -uSoftV * 2.) discard;
  float a = sst(-uSoftV, uSoftV, d) * (1. - sst(0., uFade, d)) * sst(0., .15, vUv.x) * sst(0., .15, 1. - vUv.x);
  float dry = vnoise(vec2(vUv.x * 420., vUv.y * 5.) + uSeed * 17., 35u);
  float dry2 = vnoise(vec2(vUv.x * 90., vUv.y * 2.2) + uSeed * 5., 45u) * .6 + vnoise(vec2(vUv.x * 30., vUv.y * 9.) + uSeed, 46u) * .4;
  vec3 c = mix(mix(uC, uCB, wm), mix(uFog, uFogB, wm), sst(0., uFade, d) * .75) * (1. - .05 * dry) * (1. - uDryK * (dry2 - .5));
  gl_FragColor = vec4(c, a * uAlpha);
}`;
// ── 雾带：平涂横带，上缘一条 1.5K、50% 的灰细线，波浪起伏 ──
const BAND_FS = /* glsl */`${GLSL_COMMON}${WIPE}
uniform vec3 uC, uCB, uLineC, uLineCB; uniform float uSeed, uShift, uLineV, uAlpha, uTop, uLineA; uniform vec2 uWH;
varying vec2 vUv;
void main(){
  float wm = wipeM();
  // 上缘（返修 style-15）：两个尺度的起伏——周期 600K、振幅 18K，加周期 150K、振幅 5K；每条相位不同，沿 x 有 30% 的厚薄变化
  float X = vUv.x * uWH.x + uShift;
  float w1 = .65 * sin(X / 600. * 6.2832 + uSeed * 2.1) + 1.4 * fbm3(vec2(X / 600. + uSeed * 3.3, uSeed * 1.7), 37u);
  float w2 = .6 * sin(X / 150. * 6.2832 + uSeed * 5.3) + 1.2 * fbm3(vec2(X / 150. + uSeed * 1.9, uSeed * 2.9), 38u);
  float top = uTop + (18. * w1 + 5. * w2) / uWH.y;
  float thick = 1. + .3 * sin(X / 950. * 6.2832 + uSeed * 4.1);
  float d = top - vUv.y;
  if (d < -uLineV * 2.) discard;
  float ends = sst(0., .18, vUv.x) * sst(0., .18, 1. - vUv.x);
  float fill = sst(-uLineV * .4, uLineV * .4, d) * mix(.72, .10, sst(0., top * .8 * thick, d)) * ends;
  float line = (1. - sst(uLineV * .35, uLineV, abs(d))) * uLineA * ends;
  float a = line + fill * (1. - line);
  vec3 c = (mix(uLineC, uLineCB, wm) * line + mix(uC, uCB, wm) * fill * (1. - line)) / max(a, 1e-4);
  gl_FragColor = vec4(c, a * uAlpha);
}`;
// ── 加色辉光 ──
const GLOW_FS = /* glsl */`uniform vec3 uC; uniform float uA; varying vec2 vUv;
void main(){ vec2 d = (vUv - .5) * 2.; float r2 = dot(d, d); float g = exp(-r2 * 3.2) * .7 + exp(-r2 * 18.) * .3; g *= 1. - smoothstep(.8, 1., sqrt(r2)); gl_FragColor = vec4(uC * g * uA, 1.); }`;
// ── 太阳：剪纸圆（朱）或第七日的亮日 ──
const SUN_FS = /* glsl */`${GLSL_COMMON}
uniform vec3 uC, uHalo; uniform float uA, uSeed, uSoftV, uMode, uHaloA, uScale, uK, uOcc, uJag, uHot; uniform sampler2D tPlate; uniform vec4 uPlateR; varying vec2 vUv;
// 远山遮挡（返修 story-03）：按当前机位算出的底板屏幕矩形，取底板该处亮度和同一行天色比，暗于天色的地方就是山，太阳躲到山后
float occ(){
  if (uOcc < .5) return 0.;
  vec2 dp = vec2(gl_FragCoord.x / uK, 1040. - gl_FragCoord.y / uK);
  vec2 uv = vec2((dp.x - uPlateR.x) / uPlateR.z + .5, .5 - (dp.y - uPlateR.y) / uPlateR.w);
  if (uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.) return 0.;
  float l = lum(texture2D(tPlate, uv).rgb), ls = lum(texture2D(tPlate, vec2(.1, uv.y)).rgb);
  return sst(.02, .10, ls - l) * sst(.26, .31, uv.y);
}
void main(){
  vec2 d = (vUv - .5) * 2.;
  float r = length(d) * (uMode > .5 ? 9.3 : 3.) / max(uScale, 1e-3);
  float an = atan(d.y, d.x);
  // 剪纸边（返修 style-17）：半径抖动 .03 → .08，再加一层纸纤维的细碎毛边
  float rr = 1. + uJag * (vnoise(vec2(an * 1.9099 + 30., uSeed * 3.7), 39u) * 2. - 1.) + uJag * .4 * (vnoise(vec2(an * 7.6 + 9., uSeed), 40u) * 2. - 1.)
           + .012 * (vnoise(vec2(an * 40. + 3., uSeed * 1.3), 42u) * 2. - 1.);
  float disc = 1. - sst(rr - uSoftV, rr + uSoftV, r);
  float o = 1. - occ();
  if (uMode < .5) {
    // 剪纸叠层：右下 1.5K、α .2 的暗投影
    vec2 ds = d - vec2(.035, -.035);
    float rs = length(ds) * 3. / max(uScale, 1e-3);
    float shadow = (1. - sst(rr - uSoftV * 2., rr + uSoftV * 2., rs)) * (1. - disc) * .2;
    float fib = .92 + .08 * vnoise(d * 60. + uSeed, 43u);
    float glow = .12 * (1. - sst(1., 3., r));
    float a = max(disc, max(glow, shadow)) * uA * o;
    vec3 c = mix(uC * fib, vec3(.06, .03, .03), shadow / max(max(disc, max(glow, shadow)), 1e-3) * (1. - disc));
    gl_FragColor = vec4(c, a);
  } else {
    float halo = exp(-r * r / 9.) * uHaloA + exp(-r * r / 1.6) * .35;
    vec3 c = uC * disc * uHot + uHalo * halo;
    gl_FragColor = vec4(c * uA * o, 1.);
  }
}`;
// ── 丁达尔光束（加色） ──
const BEAM_FS = /* glsl */`${GLSL_COMMON}
uniform vec3 uC; uniform float uA, uSeed; varying vec2 vUv;
void main(){
  // 返修 style-07：vUv.y = 1 在太阳一端；离太阳越远越宽、越淡
  float x = abs(vUv.x - .5) * 2. / mix(1., .3, vUv.y);
  float w = (1. - sst(.2, 1., x)) * sst(0., .5, vUv.y) * (1. - sst(.93, 1., vUv.y));
  float n = .7 + .6 * vnoise(vec2(vUv.x * 9. + uSeed, vUv.y * 2.), 44u);
  gl_FragColor = vec4(uC * w * n * uA, 1.);
}`;
// ── 雾团（A21 一块 + 软边） ──
const MIST_FS = /* glsl */`${GLSL_COMMON}${WIPE}
uniform sampler2D map; uniform vec4 rect; uniform float uA, uSoft, uFlip; uniform vec3 uTint, uTintB;
varying vec2 vUv;
void main(){
  vec2 q = vec2(uFlip > .5 ? 1. - vUv.x : vUv.x, vUv.y);
  vec4 c = texture2D(map, rect.xy + q * rect.zw);
  vec2 d = (vUv - .5) * 2.;
  float m = 1. - sst(uSoft, 1., length(d * vec2(1., 1.1)));
  gl_FragColor = vec4(c.rgb * mix(uTint, uTintB, wipeM()), c.a * m * uA);
}`;
// ── 云海（S5a）：fbm 云顶 + 梯度造假法线 + 2 阶卡通明暗 + 远处混天色 ──
const CLOUD_VS = /* glsl */`varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const CLOUD_FS = /* glsl */`${GLSL_COMMON}
uniform vec3 uLit, uShd, uSky, uSunDir; uniform float uUnder, uA; varying vec3 vW;
float bil(vec2 p, uint s){ return 1. - abs(2. * fbm(p, s)); }
float hgt(vec2 p){ return .62 * bil(p * .03, 81u) + .38 * bil(p * .1 + 7., 82u); }
void main(){
  vec2 p = vW.xz;
  // 翻卷的云头：billow 噪声；朝太阳的一侧亮，背阳一侧压到影色，谷里再暗一点
  vec2 sd = normalize(uSunDir.xz + vec2(1e-4));
  float h = hgt(p), hs = hgt(p + sd * 2.2);
  float tone = sst(.42, .6, h + 2.4 * (hs - h) * -1. + .25);
  vec3 mid = mix(uShd, uLit, .55);
  vec3 c = mix(uShd, mid, sst(.25, .45, h));
  c = mix(c, uLit, tone * sst(.3, .5, h));
  c *= mix(.9, 1., sst(.15, .45, h));
  if (uUnder > .5) c = mix(uShd * .92, uLit * .9, sst(.2, .6, h));
  float dist = length(vW - cameraPosition);
  c = mix(c, uSky, sst(25., 520., dist));
  gl_FragColor = vec4(c, uA);
}`;
// ── 墨点（S5a 弧线；面向相机） ──
const DOT_FS = /* glsl */`${GLSL_COMMON}
uniform vec4 uPh; uniform float uA, uSpread, uCol, uK2; varying vec2 vUv;
void main(){
  // 墨点（返修 style-13 / story-11 / tech-13）：和 S4b 第一枚斑同一种画法——深墨断环（断口全透明）+ 不透明的金赭斑心
  vec2 q = (vUv - .5) * 2. * 2.1 / (1. + .3 * uSpread);
  vec3 F = motifField(q, uPh, 4. + floor(mfr(uPh.x * .37) * 3.), 1.);
  // 第 2 轮（style-02）：墨画的小豹斑——断环边缘洇开带毛刺、墨色有浓淡，斑心只是一层半透明的赭色淡彩
  float sdn = F.x + .07 * fbm(q * 4.2 + uPh.x, 16u) + .03 * fbm(q * 12. + uPh.y, 17u);
  float sf = .05 + .08 * uSpread;
  float ring = (1. - sst(-sf, sf, sdn)) * (.75 + .25 * sst(-.3, .3, fbm(q * 2.5 + uPh.z, 18u)));
  float bleed = (1. - sst(-.05, .2 + .2 * uSpread, sdn)) * (1. - ring) * .35;
  float core = 1. - sst(.45 * F.y, .85 * F.y, F.z);
  float a = max(max(ring, core * .45), bleed) * uA;
  vec3 ink = mix(vec3(.0103, .0091, .0085), vec3(.0474, .2016, .1946), uCol);
  vec3 coreC = mix(vec3(.254, .111, .023), vec3(.09, .24, .21), uCol);
  // 受光边：只在朝太阳的那一侧（约 30% 弧长）
  float side = sst(.62, .92, dot(normalize(q + 1e-4), normalize(vec2(.62, .78))));
  float lit = side * ring * (1. - sst(-.02, .06, -sdn - .08));
  vec3 c = mix(coreC, ink, clamp(ring + bleed * 1.6, 0., 1.));
  c = mix(c, vec3(.823, .418, .068), lit * .6);
  gl_FragColor = vec4(c, a);
}`;
// ── 松针簇贴图（返修 style-14）：扇形整团——外缘羽化、团外 6K 喷枪晕，团心深、外缘浅两档灰；每团 18 笔细针（宽约 1.5–2K） ──
//    R 通道 = 覆盖度（软边），G 通道 = 团心程度（深浅两档）。确定性：只用种子随机。
function needleTexture(seed) {
  const W = 512, H = 256, R = mulberry(seed);
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const cov = mk(), core = mk(), gc = cov.getContext('2d'), gk = core.getContext('2d');
  const x0 = 256, y0 = 236;
  const fan = (g, rad, a0, a1, blur, alpha) => { g.save(); g.filter = `blur(${blur}px)`; g.fillStyle = `rgba(255,255,255,${alpha})`; g.beginPath(); g.moveTo(x0, y0);
    for (let i = 0; i <= 24; i++) { const a = Math.PI * (a0 + (a1 - a0) * i / 24); const rr = rad * (.86 + .14 * Math.sin(i * 1.7 + seed)); g.lineTo(x0 - Math.cos(a) * rr, y0 - Math.sin(a) * rr * .8); } g.closePath(); g.fill(); g.restore(); };
  // 团外喷枪晕（约 6K）+ 团体（羽化 4K）
  fan(gc, 220, .06, .94, 14, .34);
  fan(gc, 175, .10, .90, 6, .8);
  // 18 笔细针：从团心放射，带出锋
  for (let i = 0; i < 18; i++) {
    const a = Math.PI * (0.12 + 0.76 * (i / 17)) + (R() - .5) * .1;
    const len = 120 + 70 * R();
    const pts = [];
    for (let k = 0; k <= 8; k++) { const t = k / 8; pts.push([x0 - Math.cos(a) * len * t, y0 - Math.sin(a) * len * t * .8 + 10 * t * t, .9 - .5 * t]); }
    const poly = inkStroke(pts, { size: 3.2 + 1.2 * R(), thinning: .7, streamline: .2, start: { taper: 8 }, end: { taper: 60 } });
    gc.fillStyle = 'rgba(255,255,255,.95)'; gc.beginPath(); poly.forEach((q, j) => j ? gc.lineTo(q[0], q[1]) : gc.moveTo(q[0], q[1])); gc.closePath(); gc.fill();
  }
  // 团心（深的那一档）：较小的扇形，软边
  fan(gk, 120, .2, .8, 18, 1);
  const a = gc.getImageData(0, 0, W, H), b = gk.getImageData(0, 0, W, H);
  for (let i = 0; i < a.data.length; i += 4) { a.data[i + 1] = b.data[i + 3] * (a.data[i + 3] / 255); a.data[i] = a.data[i + 3]; a.data[i + 2] = 0; a.data[i + 3] = 255; }
  gc.putImageData(a, 0, 0);
  const t = new THREE.CanvasTexture(cov); t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
const NEEDLE_FS = /* glsl */`${GLSL_COMMON}${WIPE}
uniform sampler2D map; uniform vec3 uC, uCB, uTop, uTopB, uFog, uC2; uniform float uA, uFogAmt; varying vec2 vUv;
void main(){
  vec4 tx = texture2D(map, vUv); float a = tx.r; if (a < .02) discard;
  float wm = wipeM();
  // 灰态两档：团心 #232120、外缘 #4A4845；彩态沿用原来的青绿渐变
  vec3 grey = mix(uC2, uC, sst(.15, .6, tx.g / max(a, .05)));
  vec3 colr = mix(uCB, uTopB, sst(.35, .95, vUv.y));
  vec3 c = mix(grey, colr, wm);
  c = mix(c, uFog, uFogAmt);
  gl_FragColor = vec4(c, a * uA);
}`;

// ── 崖体网格（返修 style-03）：圆角盒（外轮廓成大弧，不再是折角）+ 只留低频的向量噪声位移 + 很浅的层台；顶点焊接后算平滑法线 ──
function rockBox(w, h, d, segs, center, noise, o = {}) {
  let g = new THREE.BoxGeometry(w, h, d, segs[0], segs[1], segs[2]);
  g.deleteAttribute('normal'); g.deleteAttribute('uv'); g = mergeVertices(g);
  const P = g.attributes.position, v = new THREE.Vector3();
  const amp = o.amp ?? .9, topY = o.topY ?? 1e9, terrace = o.terrace ?? .35, R = o.round ?? .45;
  const hx = w / 2, hy = h / 2, hz = d / 2;
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i);
    // 圆角盒：把盒面投到半径 R 的圆角上
    const qx = clamp(v.x, -hx + R, hx - R), qy = clamp(v.y, -hy + R, hy - R), qz = clamp(v.z, -hz + R, hz - R);
    const ex = v.x - qx, ey = v.y - qy, ez = v.z - qz, el = Math.hypot(ex, ey, ez);
    if (el > 1e-6) v.set(qx + ex / el * R, qy + ey / el * R, qz + ez / el * R);
    const nx = el > 1e-6 ? ex / el : 0, nz = el > 1e-6 ? ez / el : 0;
    v.add(center);
    const p = v.clone();
    const f1 = (x, y, z, s) => noise(x * s, y * s, z * s);
    const dx = amp * (.62 * f1(p.x, p.y, p.z, .28) + .025 * f1(p.x + 7, p.y, p.z, 1.4));
    const dy = amp * (.36 * f1(p.x, p.y + 11, p.z, .28) + .02 * f1(p.x, p.y + 3, p.z, 1.4));
    const dz = amp * (.62 * f1(p.x, p.y, p.z + 13, .28) + .025 * f1(p.x, p.y, p.z + 5, 1.4));
    const tr = (Math.max(0, Math.min(1, (((p.y / .9) % 1 + 1) % 1 - .35) / .3)) - .5) * terrace;
    let ddy = dy;
    if (p.y > topY - .02) ddy = clamp(dy * .15, -.15, .15) + (o.topSlope ? o.topSlope(p.x) : 0);
    v.set(p.x + dx + nx * tr, p.y + ddy, p.z + dz + nz * tr);
    if (o.clampFront !== undefined && v.z > o.clampFront) v.z = o.clampFront + (v.z - o.clampFront) * .3;
    P.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// 变径管（松干、枝）——返修 v2-04（第 3 轮）：
//   ① 截面标架用平行传输（把上一节的法向投影到新切线的垂面上再归一），转折处不翻转、不自扭，不会再出现"劈开的几条平带"；
//   ② 截面 18 段（枝 12 段）、沿线加密；每圈只存一份顶点（首尾按取模相接，没有接缝），平滑法线；
//   ③ 两端各加 4 圈半球帽收成圆头（最后一圈留 2% 半径），不再是平切口；④ 三角形绕向统一朝外
function taperTube(curve, n, r0, r1, radial = 18, o = {}) {
  const P = [], T = [];
  for (let i = 0; i <= n; i++) { const s = i / n; P.push(curve.getPointAt(s)); T.push(curve.getTangentAt(s).normalize()); }
  const up = Math.abs(T[0].y) < .9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  let N = up.clone().sub(T[0].clone().multiplyScalar(up.dot(T[0]))).normalize();
  const Ns = [], Bs = [];
  for (let i = 0; i <= n; i++) {
    if (i > 0) { const M = N.clone().sub(T[i].clone().multiplyScalar(N.dot(T[i]))); if (M.lengthSq() > 1e-12) N = M.normalize(); }
    Ns.push(N.clone()); Bs.push(T[i].clone().cross(N).normalize());
  }
  const wob = o.wob ?? .05;
  const tipK = o.tip ?? 1;   // 梢头再收：最后 18% 从 1 收到 tipK（松干梢头不再是粗圆柱的断头）
  const rad = s => lerp(r0, r1, s) * (1 + wob * Math.sin(s * 23 + r0 * 40)) * (s > .82 ? lerp(1, tipK, (x => x * x * (3 - 2 * x))((s - .82) / .18)) : 1);
  const rings = [];
  const CAP = 4, rs = rad(0), re = rad(1);
  for (let k = CAP; k >= 1; k--) { const th = k / CAP * Math.PI / 2 * .985; rings.push([P[0].clone().addScaledVector(T[0], -Math.sin(th) * rs * .85), rs * Math.cos(th), Ns[0], Bs[0]]); }
  for (let i = 0; i <= n; i++) rings.push([P[i], rad(i / n), Ns[i], Bs[i]]);
  for (let k = 1; k <= CAP; k++) { const th = k / CAP * Math.PI / 2 * .985; rings.push([P[n].clone().addScaledVector(T[n], Math.sin(th) * re * .85), re * Math.cos(th), Ns[n], Bs[n]]); }
  const pos = [], idx = [];
  for (const [c, r, Nn, Bn] of rings) for (let j = 0; j < radial; j++) {
    const a = j / radial * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
    pos.push(c.x + r * (ca * Nn.x + sa * Bn.x), c.y + r * (ca * Nn.y + sa * Bn.y), c.z + r * (ca * Nn.z + sa * Bn.z));
  }
  for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < radial; j++) {
    const a = i * radial + j, b = i * radial + (j + 1) % radial, c = (i + 1) * radial + j, d = (i + 1) * radial + (j + 1) % radial;
    idx.push(a, b, c, b, d, c);   // (b − a) × (c − a) 朝外
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// ── 豹斑布局（脊柱空间 → 每张精灵的贴图像素） ──
function spineOf(m) {
  const A = m['锚点'], sp = A['脊柱锚点_px'], hw = A['站位半宽_px'];
  let pts = [sp.neck, sp.shoulder];
  const hws = [hw.neck, hw.shoulder];
  if (sp.hip) { pts.push(sp.hip); hws.push(hw.hip); }
  if (sp.tail_root) { pts.push(sp.tail_root); hws.push(hw.tail_root); }
  const tail = A['尾巴折线_px'];
  const stations = pts.length;
  if (tail) { for (let i = 1; i < tail.length; i++) { pts.push(tail[i]); hws.push(lerp(hw.tail_root, hw.tail_tip, i / (tail.length - 1))); } }
  const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, hws, L, total: L[L.length - 1], stations };
}
function spineAt(S, s) {
  const d = clamp(s) * S.total; let i = 1; while (i < S.L.length - 1 && S.L[i] < d) i++;
  const a = S.pts[i - 1], b = S.pts[i], t = (d - S.L[i - 1]) / Math.max(S.L[i] - S.L[i - 1], 1e-6);
  const x = lerp(a[0], b[0], t), y = lerp(a[1], b[1], t);
  let tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
  return { x, y, nx: -ty, ny: tx, hw: lerp(S.hws[i - 1], S.hws[i], t) };
}
// 归一化脊柱空间里的 44 枚斑（26 环 + 18 点），按到第一枚的距离排序
function makeSpotPlan(refSpine) {
  const R = mulberry(11), out = [];
  const phys = (s, v) => { const q = spineAt(refSpine, s); return [q.x + q.nx * v * q.hw, q.y + q.ny * v * q.hw, q.hw]; };
  out.push({ s: .45 * .534 / .534 * .62, v: .35, rho: .46, kind: 0, seed: 7 });
  let tries = 0;
  while (out.filter(o => o.kind === 0).length < 26 && tries < 6000) {
    tries++;
    const s = .06 + .86 * R(), v = (R() * 2 - 1) * .85;
    const rho = .30 + .12 * R();
    const [x, y, hw] = phys(s, v);
    const r = rho * hw;
    let ok = true;
    for (const o of out) { const [x2, y2, hw2] = phys(o.s, o.v); if (Math.hypot(x - x2, y - y2) < (r + o.rho * hw2) * 1.15) { ok = false; break; } }
    if (ok) out.push({ s, v, rho, kind: 0, seed: 40 + out.length });
  }
  tries = 0;
  while (out.length < 44 && tries < 8000) {
    tries++;
    const zone = R();
    let s, v;
    if (zone < .3) { s = .0 + .1 * R(); v = (R() * 2 - 1) * .9; }
    else if (zone < .55) { s = .9 + .08 * R(); v = (R() * 2 - 1) * .7; }
    else { s = .15 + .4 * R(); v = (R() > .5 ? 1 : -1) * (1.0 + .3 * R()); }
    const rho = .12 + .06 * R();
    const [x, y, hw] = phys(s, v);
    let ok = true;
    for (const o of out) { const [x2, y2, hw2] = phys(o.s, o.v); if (Math.hypot(x - x2, y - y2) < (rho * hw + o.rho * hw2) * 1.25) { ok = false; break; } }
    if (ok) out.push({ s, v, rho, kind: 1, seed: 40 + out.length });
  }
  const [fx, fy] = phys(out[0].s, out[0].v);
  const rest = out.slice(1).map(o => { const [x, y] = phys(o.s, o.v); return { ...o, d: Math.hypot(x - fx, y - fy) }; }).sort((a, b) => a.d - b.d);
  const plan = [out[0], ...rest];
  plan.forEach((o, k) => { o.birthF = 438 + 2 * Math.round(9 * Math.acos(1 - 2 * Math.min(k, 43) / 43) / Math.PI); });
  return plan;
}
// 第 3 轮（v2-02）：斑的大小不再按"当地半宽"缩放（臀腿、侧腹半宽大，原来的斑在那里被放大成一道道长弧，读成虎纹）。
//   斑心位置仍按脊柱坐标 (s, v) 定；半径按体长（A02 颈 → 尾根的脊柱弧长，换算到本姿态的贴图像素）：
//   环斑 .07–.11 体长、种子 7 那一枚 .09、小斑 .03–.045；再按当地半宽封顶（尾巴上的小斑不溢出尾巴）。
//   身上的斑交给豹斑版 rosetteField（soft = 1）；种子 7 那一枚墨团的数目、位置、转向都和母题一样，只是收短加粗（soft = .75）
function spotsFor(spine, plan, o = {}) {
  const BL = (spine.bodyRef ?? 514) / (spine.ps ?? 1);
  return plan.map(p => {
    const q = spineAt(spine, p.s);
    const fr = p.seed === 7 ? .09 : p.kind === 0 ? .07 + .04 * hashi(p.seed * 7 + 3) : .03 + .015 * hashi(p.seed * 7 + 3);
    const r = Math.min(fr * BL, (p.kind === 0 ? .7 : .55) * q.hw) * (o.scale ?? 1);
    return { x: q.x + q.nx * p.v * q.hw, y: q.y + q.ny * p.v * q.hw, r, kind: p.kind, seed: p.seed, soft: p.seed === 7 ? .75 : 1, birth: o.allOn ? -1000 : p.birthF / 24 };
  });
}

export function buildWorld(ctx) {
  const { tex, man } = ctx;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(27.4, 1920 / 1040, .05, 30000);
  const noise = createNoise3D(mulberry(7));
  const LIGHT = [.8, .45, -.3];   // 主光：右侧雾里来（略偏后，崖的正面落在暗部，压住画角）
  const L = {};

  // ── 天穹 ──
  const skyU = {
    ...wipeU(), uZ: { value: lin3('#C9C4BB') }, uM: { value: lin3('#D7D2C9') }, uH: { value: lin3('#EEE7DF') }, uL: { value: lin3('#E4DED5') },
    uZB: { value: lin3('#6A9C95') }, uMB: { value: lin3('#A3C2BA') }, uHB: { value: lin3('#E9F3F0') }, uLB: { value: lin3('#F4F5E7') },
    uSunDir: { value: V3(.5, .3, -.8) }, uSunC: { value: lin3('#F3C46B') }, uSunGlow: { value: 0 },
  };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(20000, 48, 24), sm(SKY_VS, SKY_FS, skyU, { side: THREE.BackSide, transparent: false, depthTest: false }));
  sky.renderOrder = -100; sky.frustumCulled = false; scene.add(sky);

  // ── S2a 起始机位 C0（按构图解出：豹脚落在 (640, 662)） ──
  const C0 = V3(1.16, .457, 7.65), PITCH0 = 1 * DEG;   // 返修 story-01：机位推近约 1.65 m，小豹（z = .2）在 S2a 里高约 185–215K
  const c0cam = new THREE.PerspectiveCamera(27.4, 1920 / 1040, .05, 30000);
  const aim = (c, p, yaw, pitch) => { c.position.copy(p); c.rotation.order = 'YXZ'; c.rotation.set(pitch, yaw, 0); c.updateMatrixWorld(true); };
  aim(c0cam, C0, 0, PITCH0);
  const screenToWorld = (c, x, y, D) => { const hh = D * Math.tan(c.fov * DEG / 2), hw = hh * c.aspect; return V3((x / 1920 - .5) * 2 * hw, (.5 - y / 1040) * 2 * hh, -D).applyMatrix4(c.matrixWorld); };
  const placeOn = (m, c, x, y, w, D, h) => { const hh = D * Math.tan(c.fov * DEG / 2), hw = hh * c.aspect; m.position.copy(screenToWorld(c, x, y, D)); c.getWorldQuaternion(m.quaternion); m.scale.set(w / 1920 * 2 * hw, (h ?? w) / 1040 * 2 * hh, 1); return m; };

  // ── 南山底板（S2 / S4c 用一张；S5a 另放一张） ──
  const plateU = { ...wipeU(), tA: { value: tex.nanshanGrey }, tB: { value: tex.nanshanColor }, uTintA: { value: V3(1, 1, 1) }, uTintB: { value: V3(1, 1, 1) }, uEdge: { value: new THREE.Vector4(.06, .03, .05, .12) }, uAlpha: { value: 1 } };
  const plate = new THREE.Mesh(UNIT, sm(PV, PLATE_FS, plateU)); plate.renderOrder = -90; plate.frustumCulled = false;
  placeOn(plate, c0cam, 825, 567, 2500, 2000, 833); scene.add(plate);   // A18/A19（fix1：3:1 新山形）
  const plate5U = { ...wipeU(0), tA: { value: tex.nanshanColor }, tB: { value: tex.nanshanColor }, uTintA: { value: V3(1, 1, 1) }, uTintB: { value: V3(1, 1, 1) }, uEdge: { value: new THREE.Vector4(.12, .12, .1, .2) }, uAlpha: { value: 1 } };
  const plate5 = new THREE.Mesh(UNIT, sm(PV, PLATE_FS, plate5U)); plate5.renderOrder = -90; plate5.frustumCulled = false; plate5.visible = false; scene.add(plate5);

  // ── 七个太阳（朱，剪纸圆） + 第七日亮日 ──
  const SUN_A = [.78, .62, .48, .36, .26, .17, .10];
  const suns = SUN_A.map((a, k) => {
    const u = { uC: { value: (() => { const c = lin3('#9F4346'); const l = .2126 * c.x + .7152 * c.y + .0722 * c.z; return c.lerp(V3(l, l, l), .1); })() }, uHalo: { value: lin3('#EAAD49') }, uA: { value: a }, uSeed: { value: k + 1 }, uSoftV: { value: .03 }, uMode: { value: 0 }, uHaloA: { value: 0 }, uScale: { value: 1 }, uK: SHARED.uK, uOcc: { value: 1 }, uJag: { value: .08 }, uHot: { value: 1.6 }, tPlate: { value: tex.nanshanGrey }, uPlateR: { value: new THREE.Vector4(825, 567, 2500, 833) } };
    const m = new THREE.Mesh(UNIT, sm(PV, SUN_FS, u)); m.renderOrder = -85; m.frustumCulled = false; m.visible = false; scene.add(m);
    return { m, u, a };
  });
  const bigSunU = { uC: { value: lin3('#FFF1D0') }, uHalo: { value: lin3('#EAAD49') }, uA: { value: 1 }, uSeed: { value: 9 }, uSoftV: { value: .05 }, uMode: { value: 1 }, uHaloA: { value: .3 }, uScale: { value: 1 }, uK: SHARED.uK, uOcc: { value: 0 }, uJag: { value: .03 }, uHot: { value: 1.6 }, tPlate: { value: tex.nanshanGrey }, uPlateR: { value: new THREE.Vector4(825, 567, 2500, 833) } };
  const bigSun = new THREE.Mesh(UNIT, sm(PV, SUN_FS, bigSunU, { blending: THREE.AdditiveBlending })); bigSun.renderOrder = -84; bigSun.frustumCulled = false; bigSun.visible = false; scene.add(bigSun);
  const beams = Array.from({ length: 7 }, (_, i) => {
    const u = { uC: { value: lin3('#F3C46B') }, uA: { value: 0 }, uSeed: { value: i * 3.3 } };
    const m = new THREE.Mesh(UNIT, sm(PV, BEAM_FS, u, { blending: THREE.AdditiveBlending })); m.renderOrder = 30; m.frustumCulled = false; m.visible = false; scene.add(m);
    return { m, u };
  });

  // ── 脊线 ×6（T1 对位后摆好；这里先建） ──
  const RIDGE_C = ['#AEA9A1', '#B3AEA6', '#BAB5AD', '#C0BBB3', '#C6C1B9', '#CBC6BE'];
  const RIDGE_CB = ['#7F978A', '#8CA294', '#99AE9F', '#A6B9AB', '#B2C4B7', '#BCCDC1'];
  const ridges = RIDGE_C.map((c, k) => {
    const u = { ...wipeU(), uC: { value: lin3(c) }, uCB: { value: lin3(RIDGE_CB[k]) }, uFog: { value: lin3('#E6E0D7') }, uFogB: { value: lin3('#E9F3F0') }, uSeed: { value: k * 1.7 + .3 }, uTop: { value: .62 }, uAmp: { value: .08 }, uFade: { value: .2 }, uAlpha: { value: .8 }, uSoftV: { value: .002 }, uOct: { value: 0 }, uDryK: { value: 0 } };
    const m = new THREE.Mesh(UNIT, sm(PV, RIDGE_FS, u)); m.renderOrder = -80 + k * .5; m.frustumCulled = false; scene.add(m);
    return { m, u };
  });

  // 返修 tech-08：S5a 的远脊卡身体不透明（不再半透明露出底板的下半截山体），上沿起伏加大、喷枪软边
  const ridges5 = [['#859B8A', '#859B8A', 1200, 868], ['#9DB4A4', '#9DB4A4', 2000, 852], ['#B3C7BC', '#B3C7BC', 3000, 838]].map(([c, cb, D, y], k) => {
    // 第 2 轮（v1-05）：远脊卡身体不再是平涂——往下渐隐进云色、带横扫的干笔起伏（明暗差约 12–18/255）
    const u = { ...wipeU(0), uC: { value: lin3(c) }, uCB: { value: lin3(cb) }, uFog: { value: lin3('#E9F3F0') }, uFogB: { value: lin3('#E9F3F0') }, uSeed: { value: k * 2.9 + 4.1 }, uTop: { value: .62 }, uAmp: { value: .21 }, uFade: { value: .55 }, uAlpha: { value: 1 }, uSoftV: { value: .01 }, uOct: { value: 1 }, uDryK: { value: .22 } };
    const m = new THREE.Mesh(UNIT, sm(PV, RIDGE_FS, u)); m.renderOrder = -80 + (2 - k) * .5; m.frustumCulled = false; m.visible = false; scene.add(m);
    return { m, u, D, y };
  });
  // S5a 云海上露出的浮岛：取 A20 长卷里画好的浮岛（与 S5b 同一张画，给化开做伏笔），亮底按亮度抠掉，底部没进云海
  const ISLE_FS = /* glsl */`${GLSL_COMMON}
  uniform sampler2D map; uniform vec4 rect; uniform vec3 uSky; uniform float uA, uHaze, uFlip; varying vec2 vUv;
  void main(){
    vec2 q = vec2(uFlip > .5 ? 1. - vUv.x : vUv.x, vUv.y);
    vec3 c = texture2D(map, rect.xy + q * rect.zw).rgb;
    float l = lum(c);
    float m = (1. - sst(.5, .74, l)) * sst(0., .12, q.x) * sst(0., .12, 1. - q.x) * sst(0., .05, 1. - q.y) * sst(.04, .42, q.y);
    c = mix(c, uSky, uHaze);
    gl_FragColor = vec4(c, m * uA);
  }`;
  const ISLE_R = [[413, 160, 352, 255], [1790, 300, 382, 270], [413, 160, 352, 255]];
  const peaks = [[700, 1560, 380, 0, 0, .14, 0], [1300, 250, 470, 0, 1, .32, 0], [2200, 900, 600, 0, 2, .5, 1]].map(([D, x, w, h, r, haze, flip], k) => {
    const R = ISLE_R[r];
    const u = { map: { value: tex.scroll }, rect: { value: new THREE.Vector4(R[0] / 2172, 1 - (R[1] + R[3]) / 724, R[2] / 2172, R[3] / 724) }, uSky: { value: lin3('#DCEBE7') }, uA: { value: 1 }, uHaze: { value: haze }, uFlip: { value: flip } };
    const m = new THREE.Mesh(UNIT, sm(PV, ISLE_FS, u, { depthTest: true })); m.renderOrder = -70 + (2 - k); m.frustumCulled = false; m.visible = false; scene.add(m);
    return { m, u, D, x, w, h: w * R[3] / R[2] };
  });
  // 地平线前的亮云脊（返修 style-13）：把云海和天的那条直线挡住
  const horizonBanks = Array.from({ length: 3 }, (_, k) => {
    const u = { ...wipeU(0), map: { value: tex.mist }, rect: { value: new THREE.Vector4(0, 0, 1, 1) }, uA: { value: .75 }, uSoft: { value: .4 }, uFlip: { value: k % 2 }, uTint: { value: lin3('#FAFBF6') }, uTintB: { value: lin3('#FAFBF6') } };
    const m = new THREE.Mesh(UNIT, sm(PV, MIST_FS, u)); m.renderOrder = -67 + k * .1; m.frustumCulled = false; m.visible = false; scene.add(m);
    return { m, u, k };
  });
  const highWisps = Array.from({ length: 4 }, (_, k) => {
    const u = { ...wipeU(0), map: { value: tex.mist }, rect: { value: new THREE.Vector4(0, 0, 1, 1) }, uA: { value: .55 }, uSoft: { value: .45 }, uFlip: { value: k % 2 }, uTint: { value: lin3('#F4F5E7') }, uTintB: { value: lin3('#F4F5E7') } };
    const m = new THREE.Mesh(UNIT, sm(PV, MIST_FS, u)); m.renderOrder = -75 + k * .1; m.frustumCulled = false; m.visible = false; scene.add(m);
    return { m, u, k };
  });
  // ── 雾带 ×4（250 / 120 / 60 / 30 m）、辉光点 ×3 ──
  const BAND = [[250, 640, 3400, 300, .5], [120, 700, 3000, 300, .45], [60, 790, 2800, 320, .42], [30, 900, 2700, 300, .4]];
  const BAND_A = [1, .9, .7, .55];
  const bands = BAND.map(([D, y, w, h, top], k) => {
    const u = { ...wipeU(), uC: { value: lin3('#EEE7DF') }, uCB: { value: lin3('#F4F5E7') }, uLineC: { value: lin3('#A39E96') }, uLineCB: { value: lin3('#9DB4A4') }, uSeed: { value: k * 2.3 + 1.1 }, uShift: { value: 0 }, uLineV: { value: .004 }, uAlpha: { value: 1 }, uTop: { value: top }, uLineA: { value: .5 }, uWH: { value: new THREE.Vector2(w, h) } };
    const m = new THREE.Mesh(UNIT, sm(PV, BAND_FS, u)); m.renderOrder = -60 + (3 - k) * 2; m.frustumCulled = false;
    placeOn(m, c0cam, 960, y, w, D, h); scene.add(m);
    return { m, u, D, y, w, h, base: m.position.clone(), drift: 6 + 8 * k / 3 };
  });
  const glows = [[1180, 640, 140, 250], [1700, 655, 110, 250], [950, 700, 90, 120]].map(([x, y, r, D], k) => {
    const u = { uC: { value: V3(1, 1, 1) }, uA: { value: .22 } };
    const m = new THREE.Mesh(UNIT, sm(PV, GLOW_FS, u, { blending: THREE.AdditiveBlending })); m.renderOrder = -59 + k * .1 - (k === 2 ? 2 : 0); m.frustumCulled = false;
    placeOn(m, c0cam, x, y, r * 2.4, D, r * 1.2); scene.add(m);
    return { m, u };
  });

  // ── 雾团（A21） ──
  const mists = [[45, 380, 640, 1500, .5, 0], [15, 1650, 880, 1300, .42, 1], [90, 1300, 600, 1600, .35, 0]].map(([D, x, y, w, a, flip], k) => {
    const u = { ...wipeU(), map: { value: tex.mist }, rect: { value: new THREE.Vector4(0, 0, 1, 1) }, uA: { value: a }, uSoft: { value: .55 }, uFlip: { value: flip }, uTint: { value: lin3('#E6E1DA') }, uTintB: { value: lin3('#F4F5E7') } };
    const m = new THREE.Mesh(UNIT, sm(PV, MIST_FS, u)); m.renderOrder = -58 + (2 - k) * .5 + (k === 1 ? 30 : 0); m.frustumCulled = false;
    placeOn(m, c0cam, x, y, w, D, w * 634 / 2150); scene.add(m);
    return { m, u, base: m.position.clone(), D, a };
  });

  // ── 3D：崖台、后壁、洞口拱、洞内、松、石、草 ──
  const rockMat = makeToon({ base: '#6C6965', s1: '#494845', s2: '#2B2928', baseB: '#859B8A', s1B: '#657870', s2B: '#2C3333', wipe: true,
    step1: .60, f1: .13, step2: .36, f2: .15, light: LIGHT, edgeN: .02, edgeNS: 1.0, dab: .05, dabS: 2.6, dabDark: 1, strata: .5, strataF: .85, strataLit: 1, dry: 1, grad: [-3.2, .4, .38],
    rim: '#D7D2C9', rimAmt: .5, rimIn: .55, rimPow: .3, rimLit: '#EAAD49', rimLitAmt: 0, fres: .30, ao: 0,
    top: '#B48339', top2: '#EAAD49', topAmt: 1, fog: '#CFCAC1', fogB: '#E9F3F0', fogD: .012, wet: '#D8D4CC', wetAmt: .1, paint: tex.rockPaint, paintAmt: .5, paintS: .42, paintR: [0, 0, 1, 1], paintMean: [.1601, .2409, .1669], warmLit: .85, topPatch: 1 });
  L.rockMat = rockMat;
  const wallMat = rockMat.clone(); wallMat.uniforms = { ...rockMat.uniforms, uTopAmt: { value: 0 }, uDry: { value: 1.6 }, uRimAmt: { value: .22 }, uRimIn: { value: .62 } }; wallMat.userData.u = wallMat.uniforms;
  const ledge = new THREE.Mesh(rockBox(9.5, 14, 5.1, [96, 128, 46], V3(-3.9, -7, 0.05), noise, { amp: .55, topY: 0, terrace: .08, round: .5, topSlope: x => x > .3 ? -(x - .3) * .02 : 0 }), rockMat);
  outlined(ledge, .8, .3); scene.add(ledge);
  const wall = new THREE.Mesh(rockBox(9.4, 4.2, 3.0, [84, 40, 28], V3(-4.25, -.6, -2.38), noise, { amp: .35, topY: 1.5, terrace: .05, round: .55, topSlope: x => (x < -1 ? .35 * clamp((-1 - x) / 3, 0, 1) : 0) - (x > -1.5 ? (x + 1.5) * .12 : 0) }), wallMat);
  outlined(wall, .8, .3); scene.add(wall);
  // 洞口拱：半个圆环立在崖面上
  const archG = new THREE.TorusGeometry(.72, .19, 18, 48, Math.PI);
  { const P = archG.attributes.position, v = new THREE.Vector3(); for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); const n = noise(v.x * 2.5, v.y * 2.5, v.z * 2.5); v.multiplyScalar(1 + .06 * n); P.setXYZ(i, v.x, v.y * 1.08, v.z); } archG.computeVertexNormals(); }
  // 洞口拱自己一份材质：比崖壁深一档，读得出是一圈石框（返修 style-08：靠拱自己的体积把人物和洞口分开）
  const archMat = rockMat.clone(); archMat.uniforms = { ...rockMat.uniforms, uBase: { value: lin3('#5E5B57') }, uS1: { value: lin3('#3F3E3B') }, uS2: { value: lin3('#252322') }, uBaseB: { value: lin3('#6E8576') }, uS1B: { value: lin3('#516357') }, uS2B: { value: lin3('#263030') }, uTopAmt: { value: 0 }, uRimAmt: { value: .3 }, uRimIn: { value: .58 } }; archMat.userData.u = archMat.uniforms;
  const arch = new THREE.Mesh(archG, archMat); arch.position.set(-.6, -.02, -.56); outlined(arch, .9, .45); scene.add(arch);
  const caveG = new THREE.CircleGeometry(.72, 48, 0, Math.PI); caveG.scale(1, 1.08, 1);
  // 第 3 轮（v2-06）：洞内暗盒也吃雾（T1 俯冲从高处看下来，它原来是雾里唯一一块没吃雾的暗半圆）
  const caveMat = sm(PV, /* glsl */`${GLSL_COMMON} varying vec2 vUv; uniform vec3 uC, uFogC; uniform float uFogA; void main(){ float b = sst(.0, .25, vUv.y); vec3 c = mix(uC * 2.2, uC, b); c = mix(c, uFogC, uFogA); gl_FragColor = vec4(c, 1.); }`, { uC: { value: lin3('#161414') }, uFogC: { value: lin3('#CFCAC1') }, uFogA: { value: 0 } }, { transparent: false, depthWrite: true });
  const cave = new THREE.Mesh(caveG, caveMat); cave.position.set(-.6, -.01, -.58); scene.add(cave);
  // 前景石（S2a 右下）与崖顶石（S5a）
  // 第 2 轮（v1-04）：石头按崖体的做法——圆润（只留低频位移、不再用脊状噪声出棱）、平滑法线，和改圆的崖体是一套
  const stoneGeo = (seed, sx, sy, sz) => { let g = new THREE.IcosahedronGeometry(1, 6); g.deleteAttribute('normal'); g.deleteAttribute('uv'); g = mergeVertices(g); const P = g.attributes.position, v = new THREE.Vector3(); for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); v.multiplyScalar(1 + .2 * noise(v.x * .9 + seed, v.y * .9, v.z * .9) + .05 * noise(v.x * 2.2 + seed, v.y * 2.2, v.z * 2.2)); if (v.y < -.35) v.y = -.35 + (v.y + .35) * .35; P.setXYZ(i, v.x * sx, v.y * sy, v.z * sz); } g.computeVertexNormals(); return g; };
  // 前景压角石（返修 tech-18）：单独一份材质，边缘光压低、顶面压暗，不再被涂成雾色而只剩下半
  const fgMat = rockMat.clone(); fgMat.uniforms = { ...rockMat.uniforms, uRimAmt: { value: .2 }, uRimIn: { value: .7 }, uSkyAmt: { value: .42 }, uSkyC: { value: V3(.62, .62, .64) } }; fgMat.userData.u = fgMat.uniforms;
  const fgStone = new THREE.Mesh(stoneGeo(3, .42, .26, .36), fgMat); outlined(fgStone, .9, .5);
  fgStone.position.copy(screenToWorld(c0cam, 1790, 1035, 4.2)); scene.add(fgStone);
  const topStones = [[-.55, -.02, 1.75, .22, .12, .19, 5], [.15, -.03, 1.25, .16, .09, .14, 8], [-1.5, .0, .9, .45, .24, .4, 11], [.66, -.03, .7, .14, .08, .12, 14]].map(([x, y, z, a, b, c, s]) => { const m = new THREE.Mesh(stoneGeo(s, a, b, c), rockMat); m.position.set(x, y, z); outlined(m, .9, .6); m.visible = false; scene.add(m); return m; });
  // 第 3 轮（v2-08）：S5a 起首脚下崖顶的两块深色压角石（画左下），把一大块赭黄压住、给前景一个形体；材质同崖石一套（笔触贴图、彩态冷暖），只是深一档、不铺金草
  const darkMat = rockMat.clone(); darkMat.uniforms = { ...rockMat.uniforms, uBaseB: { value: lin3('#3C4843') }, uS1B: { value: lin3('#28312E') }, uS2B: { value: lin3('#141A18') }, uTopAmt: { value: 0 }, uWarmLit: { value: .18 }, uRimLitAmt: { value: .14 } }; darkMat.userData.u = darkMat.uniforms;
  const cornerStones = [[-.05, -.03, 1.7, .3, .17, .26, 17], [.36, -.04, 2.45, .16, .1, .14, 19]].map(([x, y, z, a, b, c, s]) => { const m = new THREE.Mesh(stoneGeo(s, a, b, c), darkMat); m.position.set(x, y, z); outlined(m, .9, .6); m.visible = false; scene.add(m); return m; });
  // 松：主干 + 4 枝 + 针簇卡
  // 第 2 轮（v1-04）：松干喷枪明暗顺着体积走——交界放软、fresnel 暗边加深，鳞皮斑驳减弱
  // 第 3 轮（v2-04）：松干是一根圆柱——受光侧亮、背光侧暗（三阶软交界顺着圆柱走）、fresnel 暗边；
  //   自遮挡处不再描浅色发丝线：浅色边缘光关掉（暗边由 fresnel 给）
  const barkMat = makeToon({ base: '#55514D', s1: '#34312F', s2: '#1C1A19', baseB: '#5A4632', s1B: '#3A2C20', s2B: '#1F1812', wipe: true, step1: .62, f1: .2, step2: .38, f2: .22, light: LIGHT, edgeN: .025, edgeNS: 3, dab: .08, dabS: 5, fres: .42, fog: '#CFCAC1', fogB: '#E9F3F0', fogD: .012, rim: '#D7D2C9', rimAmt: 0, rimIn: .6 });
  const pine = new THREE.Group(); scene.add(pine);
  // 第 2 轮（v1-04）：主干 2–3 处转折（扭着长），不再是一根直板条；变径 1.0 → 0.55
  const tP = [[-2.9, -1.0, 2.2], [-2.3, .05, 2.42], [-1.75, .55, 2.18], [-1.15, 1.35, 2.36], [-.45, 1.68, 2.2], [.25, 2.32, 2.42], [.95, 2.56, 2.3]].map(([x, y, z]) => V3(x, y, z));
  const trunkCurve = new THREE.CatmullRomCurve3(tP);
  const trunk = new THREE.Mesh(taperTube(trunkCurve, 180, .24, .132, 18, { tip: .3 }), barkMat); outlined(trunk, 1.1, .8); pine.add(trunk);
  const needleTex = [needleTexture(21), needleTexture(22), needleTexture(23)];
  const needleU = (k) => ({ ...wipeU(), map: { value: needleTex[k % 3] }, uC: { value: lin3('#232120') }, uC2: { value: lin3('#4A4845') }, uCB: { value: lin3('#2E4333') }, uTop: { value: lin3('#232120') }, uTopB: { value: lin3('#546D52') }, uFog: { value: lin3('#CFCAC1') }, uA: { value: .95 }, uFogAmt: { value: .08 } });
  const needles = [], branches = [];
  // 第 3 轮（v2-04）：枝一出主干就和它拉开 25–35° 的角（原来几根枝的头一段几乎和主干平行、贴得很近，中间夹出一道天色细缝，
  //   读成"树干被劈开"）；出去以后再弯回平伸，冠的轮廓和原来一样在右上；起点略往镜头一侧挪，压在主干前面
  const branchDefs = [[.45, [[.5, .72], [1.3, 1.0], [2.2, .85]], .07], [.6, [[.25, .78], [.9, 1.25], [1.8, 1.25]], .06], [.72, [[.6, -.05], [1.15, .05], [1.6, -.08]], .05], [.85, [[.3, .52], [.8, .85], [1.45, .8]], .045]];
  branchDefs.forEach(([s, pts, r], bi) => {
    const p0 = trunkCurve.getPointAt(s);
    const cps = [p0.clone().add(V3(0, 0, .06)), ...pts.map(([dx, dy]) => V3(p0.x + dx, p0.y + dy, p0.z + .08 + .05 * bi))];
    const cur = new THREE.CatmullRomCurve3(cps);
    const br = new THREE.Mesh(taperTube(cur, 48, r, .022, 12), barkMat); outlined(br, 1.0, .8); pine.add(br); branches.push(br);
    const n = 7 + (bi % 3) * 2;
    for (let i = 0; i < n; i++) {
      const q = cur.getPointAt(.25 + .75 * i / (n - 1));
      const u = needleU(bi + i);
      const m = new THREE.Mesh(UNIT, new THREE.ShaderMaterial({ vertexShader: PV, fragmentShader: NEEDLE_FS, uniforms: u, side: THREE.DoubleSide, transparent: true, depthWrite: false, toneMapped: false }));
      const w = .7 + .4 * hashi(bi * 31 + i);
      m.position.copy(q).add(V3((hashi(bi * 13 + i) - .5) * .12, .06 + .05 * hashi(bi * 7 + i), .02 * i)); m.scale.set(w * 1.15, w * .38, 1); m.userData.base = m.position.clone(); m.userData.k = bi * 17 + i; m.userData.outline = false;
      pine.add(m); needles.push({ m, u });
    }
  });
  // 第 3 轮（v2-04）：主干梢头也长一团针（梢头收细后藏在针团里，不再露出一截圆头）
  for (let i = 0; i < 3; i++) {
    const q = trunkCurve.getPointAt(.9 + .05 * i);
    const u = needleU(5 + i);
    const m = new THREE.Mesh(UNIT, new THREE.ShaderMaterial({ vertexShader: PV, fragmentShader: NEEDLE_FS, uniforms: u, side: THREE.DoubleSide, transparent: true, depthWrite: false, toneMapped: false }));
    const w = .75 + .3 * hashi(91 + i);
    m.position.copy(q).add(V3(.12 * i - .05, .07 + .03 * i, .04 + .02 * i)); m.scale.set(w * 1.15, w * .38, 1); m.userData.base = m.position.clone(); m.userData.k = 80 + i; m.userData.outline = false;
    pine.add(m); needles.push({ m, u });
  }
  // 崖顶草（返修 style-04）：250 张成簇的笔触卡（每簇 3–5 根、每根宽约 6–10K），草尖亮金 #EAAD49；灰态 / 彩态按翻色前沿混合
  // 第 4 轮（v2-08）：草卡贴图三个通道各有用处——R = 覆盖度，G = 沿这一根叶从根到尖的相对高度（每根自己的 0→1，矮的那根也有亮尖），
  //   B = 叶脊右侧（受光的一侧）。着色器据此画根部暗、两档明暗、上 1/4 的亮金草尖
  const grassTex = (() => {
    const W = 1024, H = 256, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d'); const R = mulberry(31);
    g.fillStyle = 'rgb(0,0,0)'; g.fillRect(0, 0, W, H);
    for (let v = 0; v < 4; v++) {
      const n = 3 + (v % 3);
      for (let i = 0; i < n; i++) {
        const x0 = v * 256 + 128 + (i - (n - 1) / 2) * 22 + (R() - .5) * 10, lean = (R() - .5) * 70 + (i - (n - 1) / 2) * 18, hgt = 150 + 90 * R();
        const pts = []; for (let k = 0; k <= 8; k++) { const t = k / 8; pts.push([x0 + lean * t * t, 254 - hgt * t, 1 - .6 * t]); }
        const poly = inkStroke(pts, { size: 15 + 7 * R(), thinning: .75, streamline: .3, start: { taper: 4 }, end: { taper: 90 } });
        const path = () => { g.beginPath(); poly.forEach((q, j) => j ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])); g.closePath(); };
        const grad = side => { const gr = g.createLinearGradient(x0, 254, x0 + lean, 254 - hgt); gr.addColorStop(0, `rgb(255,0,${side})`); gr.addColorStop(1, `rgb(255,255,${side})`); return gr; };
        path(); g.fillStyle = grad(0); g.fill();
        // 叶脊右侧：先按整片叶裁切，再填"脊线以右"那半边
        g.save(); path(); g.clip();
        g.beginPath(); pts.forEach(([x, y], j) => j ? g.lineTo(x, y) : g.moveTo(x, y)); g.lineTo(x0 + lean + 60, 254 - hgt - 10); g.lineTo(x0 + 60, 256); g.closePath();
        g.fillStyle = grad(255); g.fill(); g.restore();
      }
    }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t;
  })();
  const grassU = { ...wipeU(), map: { value: grassTex }, uC: { value: lin3('#5C5955') }, uCB: { value: lin3('#A8803F') }, uTip: { value: lin3('#8A857F') }, uTipB: { value: lin3('#F2C462') },
    uFog: { value: lin3('#CFCAC1') }, uFogB: { value: lin3('#E9F3F0') }, uFogD: { value: .012 } };
  // 第 3 轮（v2-08）：草卡不再是单色硬边剪纸——根部暗一档、中段本色两档明暗（每根叶各自受光 / 背光），亮金草尖只占上 1/4；
  //   边缘软：alpha 从覆盖度 .12–.5 渐变，交给 MSAA 的 alphaToCoverage（不用排序，也不丢深度）
  const grassMat = new THREE.ShaderMaterial({ uniforms: grassU, side: THREE.DoubleSide, toneMapped: false, alphaToCoverage: true,
    vertexShader: /* glsl */`attribute float aVar; varying vec2 vUv; varying float vVZ;
      void main(){ vUv = vec2((uv.x + aVar) * .25, uv.y); vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.); vec4 mv = viewMatrix * w; vVZ = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`${GLSL_COMMON}${WIPE}
      uniform sampler2D map; uniform vec3 uC, uCB, uTip, uTipB, uFog, uFogB; uniform float uFogD; varying vec2 vUv; varying float vVZ;
      void main(){ vec4 tx = texture2D(map, vUv, .7); float a = tx.r; if (a < .06) discard; float wm = wipeM();
        float th = clamp(tx.g / max(a, 1e-3), 0., 1.), sd = clamp(tx.b / max(a, 1e-3), 0., 1.);
        vec3 base = mix(uC, uCB, wm), tip = mix(uTip, uTipB, wm);
        vec3 c = base * mix(.58, 1., sst(.0, .38, th));                 // 根部暗一档
        c *= mix(.78, 1.1, sst(.25, .75, sd));                           // 每根叶受光 / 背光两档
        c = mix(c, tip * mix(.9, 1.12, sd), sst(.68, .88, th));          // 上 1/4 是亮金草尖
        float fd = vVZ * uFogD; c = mix(c, mix(uFog, uFogB, wm), 1. - exp(-fd * fd));
        gl_FragColor = vec4(c, sst(.08, .7, a)); }` });
  const gGeo = new THREE.PlaneGeometry(1, 1); gGeo.translate(0, .5, 0);
  const NG = 260; const aVar = new Float32Array(NG);
  const grass = new THREE.InstancedMesh(gGeo, grassMat, NG); grass.userData.outline = false;
  { const M4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < NG; i++) {
      const x = -3.4 + 4.3 * Math.pow(hashi(i * 3 + 1), .7), z = -.6 + 2.2 * hashi(i * 3 + 2);
      const near = Math.hypot(x - .1, z - .2) < .38 || Math.hypot(x + .8, z - .2) < .6;
      const h = (.055 + .065 * hashi(i * 7 + 5)) * (near ? .42 : 1) * (x > .5 ? 1.15 : 1);   // 第 2 轮：成簇笔触卡放大（每簇 3–5 根、单根约 6–10K 宽）、总数 420 → 260
      p.set(x, -.012, z); e.set(0, (hashi(i * 11) - .5) * .9, (hashi(i * 13) - .5) * .25); q.setFromEuler(e); sc.set(h * 1.05, h, 1);
      M4.compose(p, q, sc); grass.setMatrixAt(i, M4); aVar[i] = Math.floor(hashi(i * 17) * 4);
    } }
  gGeo.setAttribute('aVar', new THREE.InstancedBufferAttribute(aVar, 1));
  scene.add(grass);

  // ── 精灵 ──
  const M = id => man.find(m => m.id === id);
  const mkSprite = (t, o) => { const S = makeSprite(t, o); scene.add(S.group); return S; };
  const leo = { sit: mkSprite(tex.leoSit, { order: 20, glow: true }), coil: mkSprite(tex.leoCoil, { order: 20, glow: true }), launch: mkSprite(tex.leoLaunch, { order: 20, glow: true }), glide: mkSprite(tex.leoGlide, { order: 20, glow: true }) };
  const head = mkSprite(tex.leoHead, { order: 22 });
  const lu = mkSprite(tex.luSit, { order: 21, glow: true });
  const luHand = mkSprite(tex.luSit, { order: 24, rect: [560, 330, 506, 240] });
  const deerR = [[0, 0, 505, 482], [505, 0, 505, 482], [1010, 0, 505, 482], [1515, 0, 505, 482]];
  const deer = Array.from({ length: 6 }, () => deerR.map(r => mkSprite(tex.deer, { order: 12, rect: r, mask: false })));
  // 斑点规划：以 A02 为参考
  const spines = { sit: spineOf(M('A02')), coil: spineOf(M('A03')), launch: spineOf(M('A04')), glide: spineOf(M('A05')) };
  // 第 3 轮（v2-02）：斑的半径按体长定——体长取 A02 颈 → 尾根的脊柱弧长；各姿态的贴图像素比例和 POSE 里"按眼椭圆对齐"的一致
  { const ref = spines.sit.L[spines.sit.stations - 1]; const PS = { sit: 1, coil: .926, launch: 1.096, glide: 1.09 }; for (const k in spines) { spines[k].bodyRef = ref; spines[k].ps = PS[k]; } }
  const plan = makeSpotPlan(spines.sit);
  L.plan = plan;
  const exOf = id => { const A = M(id)['锚点']; return [A['眼排除椭圆'], A['口鼻排除椭圆']]; };
  for (const [k, S] of Object.entries(leo)) { const id = { sit: 'A02', coil: 'A03', launch: 'A04', glide: 'A05' }[k]; const [e1, e2] = exOf(id); setExclude(S, e1, e2); }
  // 头像 A06 的斑：只取头颈肩（脊柱只有颈、肩），另加头上的实心点
  const headSpine = spineOf(M('A06'));
  { const [e1, e2] = exOf('A06'); setExclude(head, e1, e2); }
  const headSpots = (gold) => {
    const out = [];
    const R = mulberry(17);
    const A = M('A06')['锚点'];
    const ec = A['眼排除椭圆'], mc = A['口鼻排除椭圆'];
    let tries = 0;
    while (out.length < 22 && tries < 4000) {
      tries++;
      const x = 120 + 860 * R(), y = 120 + 1250 * R();
      const big = y > 820;
      const r = big ? 46 + 26 * R() : 20 + 14 * R();
      if (Math.hypot((x - ec.cx) / (ec.rx + 40), (y - ec.cy) / (ec.ry + 40)) < 1 || Math.hypot((x - mc.cx) / (mc.rx + 40), (y - mc.cy) / (mc.ry + 40)) < 1) continue;
      if (out.some(o => Math.hypot(o.x - x, o.y - y) < (o.r + r) * 1.35)) continue;
      out.push({ x, y, r, kind: big ? 0 : 1, seed: 120 + out.length, soft: big ? 1 : .05, birth: -1000 });   // 第 3 轮：S5c 肩上的大斑也用豹斑版
    }
    return out;
  };
  // 头上的斑（返修 v1-03 第 2 轮）：在 A02 的头上定 10 枚（额、头顶、后脑、颊后、颌后，避开眼、口鼻、腮红和胡须），
  //   用"眼心、口鼻心、耳心"三点仿射映到 A03–A06，所以每个姿态、S5c 特写里都是同一组斑（不同种子、k 3–6、大小 ±40%、各自转向）
  const HEAD_LM = { A02: [[494, 230], [592, 278], [205, 105]], A03: [[1733, 181], [1868, 212], [1420, 100]], A04: [[1100, 141], [1200, 188], [780, 205]],
    A05: [[1365, 240], [1470, 228], [1070, 115]], A06: [[775, 428], [955, 515], [260, 170]] };
  const HEAD_A02 = [[330, 105, 28], [400, 75, 20], [215, 250, 30], [150, 330, 32], [270, 300, 22], [205, 400, 28], [310, 380, 22], [360, 440, 18], [300, 180, 18], [250, 445, 20]];
  // S5c 大特写（A06）单独定位：额、头顶、太阳穴、后脑、颊后、颌后（同一组种子），避开耳内、眉、眼、腮红和胡须
  const HEAD_A06 = [[560, 150, 48], [680, 225, 36], [450, 262, 54], [455, 440, 44], [325, 405, 58], [255, 565, 52], [420, 605, 46], [330, 745, 40], [520, 770, 34], [760, 160, 30]];
  // 相似变换（旋转 + 等比缩放 + 平移）：由"耳心 → 眼心"这根向量定（三点仿射在这几张图上近乎共线，会发散）
  const affine3 = (S, D) => {
    const vs = [S[0][0] - S[2][0], S[0][1] - S[2][1]], vd = [D[0][0] - D[2][0], D[0][1] - D[2][1]];
    const sc = Math.hypot(...vd) / Math.hypot(...vs), rot = Math.atan2(vd[1], vd[0]) - Math.atan2(vs[1], vs[0]), c = Math.cos(rot) * sc, sn = Math.sin(rot) * sc;
    return { map: (x, y) => { const dx = x - S[0][0], dy = y - S[0][1]; return [D[0][0] + c * dx - sn * dy, D[0][1] + sn * dx + c * dy]; }, s: sc };
  };
  // 第 4 轮（v3-06）：头上的斑原来是母题原式的大空心细环（中景里每枚约头宽的 1/5，像盖了一圈云纹章），和身上的豹斑两套画法。
  //   现在和身上同一支笔：一半是豹斑版的小环斑（墨团宽、长宽比 ≤ 2）、一半是实心小点，整体缩到约 0.6 倍（头宽的 1/10–1/8），
  //   另加 6 颗更小的实心点；S5c 大特写（A06）保留较大的环，但同样改成豹斑版墨团，再撒几颗实心点
  const HEAD_DOTS_A02 = [[355, 138, 9], [246, 206, 8], [186, 292, 9], [236, 362, 8], [332, 330, 8], [282, 420, 7]];
  const HEAD_DOTS_A06 = [[612, 196, 16], [505, 330, 18], [380, 330, 15], [300, 500, 17], [380, 680, 16], [470, 470, 14]];
  const headKind = j => (j % 2 ? .25 : .75);
  function headSpotsFor(id, o = {}) {
    if (id === 'A06') return [...HEAD_A06.map(([x, y, r], j) => ({ x, y, r: r * (j % 2 ? .62 : .9), kind: 1, seed: 140 + j, soft: headKind(j), birth: -1000 })),
      ...HEAD_DOTS_A06.map(([x, y, r], j) => ({ x, y, r, kind: 1, seed: 160 + j, soft: .25, birth: -1000 }))];
    const T = affine3(HEAD_LM.A02, HEAD_LM[id]);
    const bornAt = j => (o.allOn === false ? (446 + 2 * Math.floor(j / 2)) / 24 : -1000);
    return [...HEAD_A02.map(([x, y, r], j) => { const [X, Y] = T.map(x, y); return { x: X, y: Y, r: r * .62 * (j % 2 ? .8 : 1) * T.s * (o.scale ?? 1), kind: 1, seed: 140 + j, soft: headKind(j), birth: bornAt(j) }; }),
      ...HEAD_DOTS_A02.map(([x, y, r], j) => { const [X, Y] = T.map(x, y); return { x: X, y: Y, r: r * T.s * (o.scale ?? 1), kind: 1, seed: 160 + j, soft: .25, birth: bornAt(j + 4) }; })];
  }
  L.headSpotsFor = headSpotsFor;
  // S5c 特写（A06）：肩上的大环斑沿用原来的布局（y > 820），头上换成上面这一组
  L.headSpotsGold = [...headSpots(true).filter(o => o.kind === 0), ...headSpotsFor('A06')];
  // 湿墨斑（灰态）：S2a 的豹身 8 枚、S2b 的颊颈 6 枚
  // 湿墨斑（返修 story-01 / main-02）：灰态 14 枚不规则断环——背 10 枚、头顶 2 枚、尾 2 枚；深墨 #1E1C1B、α .88、各带一颗湿高光
  const wetSit = [...plan.filter(p => p.kind === 0).slice(1, 11), ...plan.filter(p => p.kind === 1 && p.s > .9).slice(0, 2)].map((p, i) => {
    const q = spineAt(spines.sit, p.s); const r = (p.kind === 0 ? p.rho * 1.05 : p.rho * 2.4) * q.hw;
    return { x: q.x + q.nx * p.v * q.hw, y: q.y + q.ny * p.v * q.hw, r, kind: 2, seed: 20 + i, soft: 1, alpha: .88 };
  }).concat([[392, 108, 30], [318, 196, 27]].map(([x, y, r], i) => ({ x, y, r, kind: 2, seed: 34 + i, soft: 1, alpha: .85 })));
  const wetHead = [[430, 700, 70], [300, 860, 64], [560, 930, 58], [250, 1080, 72], [470, 1180, 66], [700, 1090, 50], [470, 210, 42], [360, 360, 48], [250, 560, 50]].map(([x, y, r], i) => ({ x, y, r, kind: 2, seed: 40 + i, soft: 1, alpha: .88 }));

  // ── 墨点弧线（S5a） ──
  const dots = Array.from({ length: 40 }, (_, k) => {
    const ph = motifPh(100 + k);
    const u = { uPh: { value: new THREE.Vector4(...ph) }, uA: { value: 0 }, uSpread: { value: 0 }, uCol: { value: 0 }, uK2: { value: 1 } };
    const m = new THREE.Mesh(UNIT, sm(PV, DOT_FS, u, { depthTest: true })); m.renderOrder = 19; m.frustumCulled = false; m.visible = false; m.userData.outline = false; scene.add(m);
    return { m, u };
  });

  // ── 云海（S5a） ──
  const cloudU = { uLit: { value: lin3('#E2E5D7') }, uShd: { value: lin3('#93A59B') }, uSky: { value: lin3('#CADCD6') }, uSunDir: { value: V3(.55, .5, -.65) }, uUnder: { value: 0 }, uA: { value: 1 } };
  const cloudTop = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), sm(CLOUD_VS, CLOUD_FS, cloudU, { transparent: false, depthWrite: true, side: THREE.FrontSide }));
  cloudTop.rotation.x = -Math.PI / 2; cloudTop.visible = false; scene.add(cloudTop);
  const cloudBotU = { ...cloudU, uUnder: { value: 1 } };
  const cloudBot = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), sm(CLOUD_VS, CLOUD_FS, cloudBotU, { transparent: false, depthWrite: true, side: THREE.DoubleSide }));
  cloudBot.rotation.x = Math.PI / 2; cloudBot.visible = false; scene.add(cloudBot);
  // 近处云海（返修 style-13 / story-02 / self-01）：240 m 见方的细网格，顶点按 billow 噪声位移成 0.3–0.6 m 起伏的卡通云顶，
  //   2 阶明暗、软交界 .10，暗部 #A9B8AE；60–110 m 之间淡进远处的平面。网格跟着相机走（按格距取整，不游动）
  // 第 4 轮（qa2-08）：画面下方那片云面原来几乎是平的浅色——云头放大一档（.05 → .038）、起伏加高（±1 → ±1.2 m）、暗部压深、远处混天色减弱，
  //   近处的云顶带着透视铺满下半画面
  const CN_H = /* glsl */`float bil(vec2 p, uint s){ return 1. - abs(2. * fbm(p, s)); }
    float hgt(vec2 p){ return .5 * bil(p * .038, 81u) + .32 * bil(p * .13 + 7., 82u) + .18 * bil(p * .4 + 3., 83u); }`;
  const cloudNearU = { uLit: { value: lin3('#E8EBDD') }, uShd: { value: lin3('#879A91') }, uSky: { value: lin3('#CFE0DA') }, uSunDir: { value: V3(.55, .5, -.65) } };   // 第 2 轮：近处云顶明暗差加大（≥ 25/255）
  const cloudNear = new THREE.Mesh(new THREE.PlaneGeometry(240, 240, 200, 200).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({ uniforms: cloudNearU, transparent: true, depthWrite: true, toneMapped: false,
    vertexShader: /* glsl */`${GLSL_COMMON}${CN_H} varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.); w.y += (hgt(w.xz) - .5) * 2.4; vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`${GLSL_COMMON}${CN_H} uniform vec3 uLit, uShd, uSky, uSunDir; varying vec3 vW;
      void main(){
        float e = .4; float h = hgt(vW.xz);
        vec3 N = normalize(vec3(-(hgt(vW.xz + vec2(e, 0.)) - hgt(vW.xz - vec2(e, 0.))) * 2.4 / (2. * e), 1., -(hgt(vW.xz + vec2(0., e)) - hgt(vW.xz - vec2(0., e))) * 2.4 / (2. * e)));
        float hl = .5 * dot(N, normalize(uSunDir)) + .5;
        vec3 c = mix(uShd, uLit, sst(.50, .82, hl + .25 * (h - .5)));   // 第 4 轮（qa2-08）：背阳的坡面多落一些影（宽而软的过渡），云头的形读得出来
        c *= mix(.78, 1., sst(.2, .6, h));
        float dist = length(vW - cameraPosition);
        c = mix(c, uSky, sst(45., 170., dist) * .38);
        gl_FragColor = vec4(c, 1. - sst(70., 115., dist));
      }` }));
  cloudNear.renderOrder = -66; cloudNear.frustumCulled = false; cloudNear.visible = false; scene.add(cloudNear);
  const nearClouds = Array.from({ length: 16 }, (_, k) => {
    const u = { ...wipeU(0), map: { value: tex.mist }, rect: { value: new THREE.Vector4(0, 0, 1, 1) }, uA: { value: .85 }, uSoft: { value: .5 }, uFlip: { value: k % 2 }, uTint: { value: lin3('#F4F5E7') }, uTintB: { value: lin3('#F4F5E7') } };
    const m = new THREE.Mesh(UNIT, sm(PV, MIST_FS, u)); m.renderOrder = 25; m.frustumCulled = false; m.visible = false; scene.add(m);
    return { m, u, k };
  });
  // 穿云时铺满画面的云（贴在相机前）
  const inCloudU = { uA: { value: 0 }, uT: { value: 0 }, uC1: { value: lin3('#F4F5E7') }, uC2: { value: lin3('#B9C6BD') } };
  const inCloud = new THREE.Mesh(UNIT, sm(/* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * 2., 0., 1.); }`, /* glsl */`${GLSL_COMMON}
    uniform float uA, uT; uniform vec3 uC1, uC2; varying vec2 vUv;
    void main(){ vec2 p = vUv * vec2(1.846, 1.) * 3.; float n = fbm(p + vec2(0., uT * 2.), 91u) + .5 * fbm(p * 2.7 - vec2(uT, 0.), 92u); vec3 c = mix(uC2, uC1, sst(-.35, .35, n)); gl_FragColor = vec4(c, uA * sst(-.6, .1, n + uA - .5)); }`, inCloudU, { depthTest: false }));
  inCloud.renderOrder = 40; inCloud.frustumCulled = false; inCloud.visible = false; scene.add(inCloud);

  const allSprites = [...Object.values(leo), head, lu, luHand, ...deer.flat()];
  const hideAll = () => { for (const S of allSprites) { S.group.visible = false; S.u.uAlpha.value = 1; } };   // 第 3 轮：透明度每个镜头开头复位（T1 俯冲会把它压到 0）

  // ── 灰态 / 彩态 公共设置 ──
  const segLightGrey = V3(.96, .95, .93), segLightColor = V3(1, .95, .85);
  function styleLeo(S, { d = .92, rimC = '#EEE7DF', rimAmt = .35, rimDir = [1, -.2], light = segLightGrey, fog = 0, glowC = '#FFFFFF', glowA = 0 } = {}) {   // 返修 style-08：灰段不加轮廓辉光
    const u = S.u; u.uDesat.value = d; u.uLight.value.copy(light);
    u.uRimC.value.copy(lin3(rimC)); u.uRimAmt.value = rimAmt; u.uRimDir.value.set(...rimDir).normalize(); u.uRimW.value = texPx(S, 6);
    u.uFogC.value.copy(lin3('#CFCAC1')); u.uFogAmt.value = fog;
    u.uGlowC.value.copy(lin3(glowC)); u.uGlowA.value = glowA; u.uGlowLod.value = Math.max(0, Math.log2(texPx(S, 14)));
  }

  // ── T1 世界相机 + S2a（返修 story-07 / story-03）：f86 起一条连续的路径——高处俯看 → 低空 → 慢慢滑近崖台 → S2a 继续推近、缓停 ──
  //    位置 = C0 + Δ0·g(f) + PAN·e(f)；g 是"指数逼近、终点速度为零"的衰减（f86→f211），e 是 S2a 本身的推近横移（f104→f211，ss5）。
  //    俯角：−28° → +1°（同一类衰减，慢一些）。速度处处连续，没有急停。
  const PAN = V3(-.5, 0, -.8);
  const gdec = (f, k) => { const u = clamp((f - 86) / 125); const h = x => Math.exp(-k * x) - Math.exp(-k) * (1 + k * (1 - x)); return h(u) / h(0); };
  function camS2(f) {
    const g = gdec(f, 17), gp = gdec(f, 13), e = ss5((f - 104) / 107);
    const p = C0.clone().add(V3(0, 180 * g, 520 * g)).add(PAN.clone().multiplyScalar(e));
    aim(cam, p, 0, lerp(1, -17, gp) * DEG); cam.fov = 27.4; cam.updateProjectionMatrix();
    return cam;
  }
  const camW = camS2;
  // 脊线对位：在 W(92) 下，把第 k 道脊线摆到第 k 条爻在 f92 的屏幕 y 上
  const RIDGE_D = [520, 700, 950, 1300, 1900, 2900];
  function alignRidges(ys) {
    const c = camW(92);
    ridges.forEach((r, k) => { placeOn(r.m, c, 960, ys[k] + 40, 4200, RIDGE_D[k], 380); r.base = r.m.position.clone(); });
  }

  // ── 鹿（返修 story-09 / style-15）：放到 35 m（约 83K 高，混雾 26%），2–3 只一组，组间距 160–260K、组内 30–60K，y 抖 ±6K、大小 ±10%，
  //    步态相位错开；6K/帧从画右往画中走；第一组的第二只 f176–f184 停下、抬头望崖；最后一只落单
  const DEER_D = 35;
  const DEER_X = [1520, 1566, 1790, 1838, 1876, 2170];
  const deerP0 = DEER_X.map((x, k) => screenToWorld(c0cam, x, 726 + 6 * (hashi(k * 5 + 3) * 2 - 1), DEER_D));
  const deerPx2m = DEER_D * 2 * Math.tan(27.4 * DEG / 2) / 1040;
  const DEER_PH = [0, 3, 1, 2, 0, 1];
  function placeDeer(f, cm, fogAt = null) {
    for (let k = 0; k < 6; k++) {
      const stop = k === 1 && f >= 176 && f < 184;
      const pose = stop ? 0 : ((Math.floor(f / 2) + DEER_PH[k]) % 4 + 4) % 4;
      deer[k].forEach((S, i) => { S.group.visible = i === pose; });
      const S = deer[k][pose];
      const fw = k === 1 ? (f < 176 ? f - 127 : f < 184 ? 49 : f - 135) : f - 127;
      const p = deerP0[k].clone(); p.x -= 6 * deerPx2m * fw;
      const sc = 1 + .1 * (hashi(k * 7 + 1) * 2 - 1);
      placeWorld(S, cm, 252, 468, p, 1.364 * sc);
      setBends(S, stop ? [{ pivot: [130, 210], center: [80, 110], angle: 14 * DEG * ss((f - 176) / 2), rIn: 50, rOut: 150 }] : [], null);
      const u = S.u; u.uDesat.value = .9; u.uFogC.value.copy(lin3('#DAD5CC')); u.uFogAmt.value = fogAt ? Math.max(.26, fogAt(p)) : .26; u.uLight.value.copy(segLightGrey); u.uGlowA.value = 0;
      if (fogAt && fogAt(p) > .7) S.group.visible = false;
    }
  }

  // ── 小豹（灰态，S2a / S4c）：A02 放在洞口唇前 (0, 0, .2) ──
  const LEO_H = .676;   // A02 整图高度对应的世界高度
  const LEO_P = V3(.1, 0, .2);
  function placeLeoSit(cm, f, o = {}) {
    const S = leo.sit; S.group.visible = true;
    placeWorld(S, cm, 305, 1118, LEO_P, LEO_H * (o.scaleY ?? 1));
    return S;
  }
  const LU_H = 1.10;
  function placeLu(cm, f, o = {}) {
    const S = lu; S.group.visible = true;
    placeWorld(S, cm, 310, 988, V3(-.72, 0, .15), LU_H);   // 第 2 轮（story-14）：挪近 8 cm，手掌够得到小豹头顶上方
    const tc = tcOf(f);
    const br = .006 * Math.sin(tc * Math.PI * 2 / 4);
    // 遮雨的手（返修 story-14）：前臂比原来再抬 8°，手指微微下扣成"伞"
    setBends(S, [{ pivot: [520, 380], center: [930, 450], angle: (o.arm ?? -14) * DEG, rIn: 170, rOut: 290 },
      { pivot: [952, 452], center: [1020, 466], angle: 18 * DEG, rIn: 30, rOut: 110 }], { pivot: [310, 980], amount: br, radius: 900 });   // 手指下扣成伞形
    return S;
  }

  // ── 雾带漂移 ──
  function driftBands(t, cm) {
    bands.forEach((b, k) => { b.u.uShift.value = t * b.drift; b.u.uLineV.value = 1.5 / Math.max(b.h, 1); });
    mists.forEach((m, k) => { m.m.position.copy(m.base).add(V3(t * (k === 1 ? .35 : .9), 0, 0)); });
  }

  // ── 太阳时钟（返修 story-03）：一次只出一个；第 k 天 f_k = 117 + 24(k−1) 起露 18 帧，从画右下雾带后升起、在天空空区划一道低弧、落回雾带；
  //    每天后面接 6 帧"夜"（整体曝光压 12%，由 main.js 取 nightK）；第七日在 S4c 破雾 ──
  const SUN_F = [117, 141, 165, 189, 213, 237], SUN_VIS = 18;
  const _pr = new THREE.Vector3();
  function plateRect(cm) {
    // 当前机位下 A18 底板的屏幕矩形（太阳躲到山后用）
    plate.updateMatrixWorld(true);
    const c = _pr.set(0, 0, 0).applyMatrix4(plate.matrixWorld).project(cm); const cx = (c.x * .5 + .5) * 1920, cy = (.5 - c.y * .5) * 1040;
    const r = _pr.set(.5, 0, 0).applyMatrix4(plate.matrixWorld).project(cm); const rx = (r.x * .5 + .5) * 1920;
    const t2 = _pr.set(0, .5, 0).applyMatrix4(plate.matrixWorld).project(cm); const ty = (.5 - t2.y * .5) * 1040;
    return [cx, cy, 2 * (rx - cx), 2 * (cy - ty)];
  }
  function sunsS2(f, cm, mode = 'a') {
    const R = plateRect(cm);
    suns.forEach((sn, k) => {
      const sx = k < 6 ? (f - SUN_F[k]) / SUN_VIS : -1;
      if (sx < 0 || sx > 1) { sn.m.visible = false; return; }
      sn.m.visible = true;
      const x = mode === 'a' ? 1790 - 840 * sx : 1840 - 640 * sx;
      const y = mode === 'a' ? 680 - 450 * Math.sin(Math.PI * sx) : 470 - 330 * Math.sin(Math.PI * sx);
      const r = mode === 'a' ? 46 : 40;
      placeOn(sn.m, cm, x, y, r * 2 * 3, 3000);
      sn.u.uA.value = mode === 'a' ? sn.a : [.45, .35, .25][k - 4] ?? .25; sn.u.uSoftV.value = (mode === 'a' ? 1.5 : 4) / r; sn.u.uMode.value = 0;
      sn.u.uPlateR.value.set(...R); sn.u.uOcc.value = 1;
    });
  }
  function nightK(f) {
    let n = 0;
    for (let k = 0; k < 6; k++) { const x = f - (SUN_F[k] + SUN_VIS); if (x > -2 && x < 8) n = Math.max(n, ss((x + 2) / 2.5) * (1 - ss((x - 3.5) / 2.5))); }
    return n;
  }
  // 豹"在熬"：每过两天头垂一档，共 3 档（第 2、4、6 天结束时）
  const droopLv = f => (f >= 165 ? 1 : 0) + (f >= 213 ? 1 : 0) + (f >= 261 ? 1 : 0);

  // ── 镜头 ──
  const shots = {};
  // S2 舞台（T1 门内 f86–f127 与 S2a f127–f211 共用同一条相机路径）
  function stageS2(f, t, c, dive) {
    SHARED.uWipeX.value = 1e5;
    hideAll(); commonVis('S2');
    const tc = tcOf(f);
    // 第 3 轮（v2-06）：精灵按和 3D 一样的 FogExp2（密度 .012）吃雾——T1 俯冲时镜头在几十米高处，豹、人、鹿、松针整只没进雾里，
    //   不再只剩一颗没吃雾的眼睛浮在雾上；雾化 > .7 整只隐去。高处时 3D 的雾色换成天穹下半的颜色，崖台不再是雾里一块方形色块
    const fogAt = p => { const d = c.position.distanceTo(p) * .012; return 1 - Math.exp(-d * d); };
    SHARED.uFogHi.value.set(.7913, .7529, .6939, dive ? ss((c.position.y - 2) / 14) : 0);   // #E6E0D7
    const S = placeLeoSit(c, f);
    const fLeo = Math.max(.06, fogAt(LEO_P));
    styleLeo(S, { fog: fLeo }); setSpots(S, wetSit); S.u.uSpotOn.value = 1; S.u.uGoldClear.value = 0; S.u.uTc.value = tc;
    S.u.uAlpha.value = 1 - ss((fLeo - .5) / .2); S.group.visible = fLeo < .7;
    // 呼吸、看鹿（低头 8°，f150–f200）、垂头档、尾尖卷、眨眼
    const A = M('A02')['锚点'], E = A['眼椭圆'];
    const ff = Math.floor(f / 2) * 2;
    const look = 8 * ss((ff - 150) / 8) * (1 - ss((ff - 196) / 8));
    const head = look + 3 * droopLv(f);
    const curl = 6 * ss((tc * 24 - 140) / 40);
    setBends(S, [{ pivot: [346, 520], center: [420, 250], angle: head * DEG, rIn: 180, rOut: 340 }, { pivot: [45, 900], center: [250, 1070], angle: curl * DEG, rIn: 80, rOut: 260 }], { pivot: [200, 1000], amount: .01 * Math.sin(tc * Math.PI * 2 / 4), radius: 1100 });
    const lid = { 200: .5, 202: 1, 204: .5 }[ff] ?? 0;
    setEye(S, { cx: E.cx, cy: E.cy, rx: E.rx * 1.08, ry: E.ry * 1.08, tilt: 0, lid, mode: 0, lidColor: '#C9944F' });
    const Lu = placeLu(c, f, { arm: -15 }); const fLu = Math.max(.06, fogAt(V3(-.72, .5, .15))); styleLeo(Lu, { d: .92, fog: fLu, rimAmt: .3 });
    Lu.u.uAlpha.value = 1 - ss((fLu - .5) / .2); Lu.group.visible = fLu < .7;
    driftBands(t, c); sunsS2(f, c, 'a'); placeDeer(f, c, fogAt);
    { const fp = Math.max(.08, fogAt(V3(-.6, 1.7, 2.3))), hi = SHARED.uFogHi.value; for (const n of needles) { n.u.uFogAmt.value = fp; n.u.uFog.value.copy(lin3('#CFCAC1')).lerp(V3(hi.x, hi.y, hi.z), hi.w); } }
    // 离相机近的雾、脊线淡掉；f100–f115 收拢到 S2a 的透明度（返修 tech-02）
    const k2 = ss(seg(f, 100, 115));
    ridges.forEach(r => { const d = r.m.position.distanceTo(c.position); r.u.uAlpha.value = lerp(.8 * clamp((d - 30) / 60), .8, k2); });
    bands.forEach((b, k) => { const d = b.m.position.distanceTo(c.position); b.u.uAlpha.value = lerp(clamp((d - 30) / 60), BAND_A[k], k2); });
    const lineA = dive ? clamp(1 - (c.position.y - 1) / 16) : 1;   // 第 3 轮（v2-06）：高处不描崖台轮廓（雾里不该有硬边）
    rockMat.userData.u.uFogD.value = .012;
    for (const o of [ledge, wall, arch]) o.userData.outlineAlpha = .3 * lineA;
    fgStone.userData.outlineAlpha = .5 * lineA; trunk.userData.outlineAlpha = .8 * lineA;
    for (const b of branches) b.userData.outlineAlpha = .8 * lineA;
    { const hi = SHARED.uFogHi.value; caveMat.uniforms.uFogA.value = fogAt(V3(-.6, .3, -.58)); caveMat.uniforms.uFogC.value.copy(lin3('#CFCAC1')).lerp(V3(hi.x, hi.y, hi.z), hi.w); }
    swayPine(f);
    return { scene, camera: c, dof: { zf: c.position.distanceTo(LEO_P), cocScale: 14, cocMax: 4 }, drops: dropsS2a(f, c), dry: dryZone(c), night: nightK(f) };
  }
  shots.T1W = (f, t) => stageS2(f, t, camS2(f), true);
  function commonVis(mode) {
    const s5 = mode === 'S5';
    plate.visible = !s5; plate5.visible = s5;
    for (const m of topStones) m.visible = s5;
    for (const m of cornerStones) m.visible = s5;
    fgStone.visible = mode === 'S2';
    cloudTop.visible = cloudBot.visible = s5; cloudNear.visible = s5;
    for (const n of nearClouds) n.m.visible = s5;
    inCloud.visible = s5;
    for (const d of dots) d.m.visible = false;
    for (const b of beams) b.m.visible = false;
    for (const sn of suns) sn.m.visible = false;
    bigSun.visible = false;
    for (const g of glows) g.m.visible = !s5;
    for (const b of bands) b.m.visible = !s5;
    for (const m of mists) m.m.visible = !s5;
    pine.visible = !s5;
    grass.visible = mode === 'S4' || mode === 'S5';
    wall.visible = arch.visible = cave.visible = true;
    cloudBot.visible = false;
    for (const r of ridges) r.m.visible = !s5;
    for (const r of ridges5) r.m.visible = s5;
    for (const p of peaks) p.m.visible = false;
    for (const w of highWisps) w.m.visible = false;
    for (const h of horizonBanks) h.m.visible = s5;
  }
  // S2a 侧面舞台（f127–f211）
  shots.S2a = (f, t) => stageS2(f, t, camS2(f), false);
  function swayPine(f) {
    const tc = tcOf(f);
    for (const n of needles) { const a = .8 * DEG * Math.sin(tc * 2.1 + n.m.userData.k); n.m.rotation.set(0, 0, a); n.m.position.copy(n.m.userData.base); }
  }
  // 陆蔚的手：手背上的雨点溅（每 7 帧）、指尖滴水（每 15 帧落到豹身旁）、手下面的干区（返修 story-14）
  const _p = new THREE.Vector3();
  function texToWorld(S, x, y) { _p.set(x / S.w - .5, .5 - y / S.h, 0); return _p.clone().applyMatrix4(S.color.matrixWorld); }
  const scr = (p, cm) => { const q = p.clone().project(cm); return [(q.x * .5 + .5) * 1920, (.5 - q.y * .5) * 1040]; };
  function dropsS2a(f, cm) {
    lu.group.updateMatrixWorld(true);
    const tip = texToWorld(lu, 1045, 476), back = texToWorld(lu, 930, 432);
    const out = [];
    for (let k = 0; k < 3; k++) {
      const f0 = 118 + 15 * Math.floor((f - 118) / 15) - 15 * k;
      const age = (f - f0) / 24; if (age < 0 || age > .5) continue;
      const p = tip.clone(); p.y -= 4.9 * age * age;
      const [x, y] = scr(p, cm);
      out.push([x, y, 7 + 40 * age, .55]);
    }
    const fs = 121 + 7 * Math.floor((f - 121) / 7), sa = f - fs;
    if (sa >= 0 && sa < 3) { const [x, y] = scr(back, cm); for (const [ox, oy, l] of [[-8, -4, 6], [2, -9, 7], [9, -3, 5]]) out.push([x + ox * (1 + sa * .6), y + oy * (1 + sa * .6), l, .6 * (1 - sa / 3)]); }
    return out;
  }
  function dryZone(cm) {
    lu.group.updateMatrixWorld(true);
    const [x, y] = scr(texToWorld(lu, 960, 470), cm), [x2] = scr(texToWorld(lu, 820, 470), cm);
    const w = Math.abs(x - x2);
    return [x, y + w * .9, w * 1.1, w * .9];
  }
  // S2b 小豹近景（f211–f287）
  shots.S2b = (f, t) => {
    const s = ss5((f - 211) / 76);
    aim(cam, V3(.52, .46, 2.25 - .045 * s), 0, 0); cam.fov = 13.09; cam.updateProjectionMatrix();
    SHARED.uWipeX.value = 1e5;
    hideAll(); commonVis('S2'); fgStone.visible = false;
    const tc = tcOf(f), ff = Math.floor(f / 2) * 2;
    const H = head; H.group.visible = true;
    const A = M('A06')['锚点'], E = A['眼椭圆'];
    const br = 2 * Math.sin(tc * Math.PI * 2 / 4);
    placeOnCam(H, cam, E.cx, E.cy, 1010, 520 + br, .596 * (1 + .02 * s), 2.2);
    styleLeo(H, { fog: 0, rimAmt: .3 }); H.u.uTc.value = tc;
    setSpots(H, wetHead); H.u.uSpotOn.value = 1; H.u.uGoldClear.value = 0;
    // 耳抖 f216–f220；吞咽（返修 story-09：f222/f224 两档）；垂头三档（第 2、4、6 天结束）
    const ear = { 216: 18, 218: -8 }[ff] ?? 0;
    const gulp = { 222: 1, 224: .5 }[ff] ?? 0;
    const droop = 3 * droopLv(f) + 1.5 * ss((ff - 262) / 6);
    setBends(H, [{ pivot: A['耳根'], center: [300, 150], angle: -ear * DEG, rIn: 60, rOut: 190 }, { pivot: [500, 905], center: [640, 450], angle: droop * DEG, rIn: 420, rOut: 640 },
      { pivot: [760, 760], center: [700, 830], angle: 5 * gulp * DEG, rIn: 50, rOut: 150 }]);
    // 眼：瞳孔先跟着山下的鹿往右下走（f211–f230，漂到 18K），再慢慢收回；太阳经过时虹膜里一颗高光；慢眨；第 6 天后半闭
    const blink = { 226: .5, 228: 1, 230: .5 }[ff] ?? (f >= 262 ? .42 * ss((ff - 260) / 4) : 0);
    const follow = ss((f - 211) / 19) * (1 - ss((f - 236) / 14));
    const drift = (6 + 12 * follow) / .596;
    let hi2 = [0, 0, 1, 0];
    for (let k = 4; k < 6; k++) { const sx = (f - SUN_F[k]) / SUN_VIS; if (sx >= 0 && sx <= 1) hi2 = [E.cx - E.rx * .55 + E.rx * 1.1 * sx, E.cy - E.ry * .35, 5 / .596, [.45, .35][k - 4] * 1.4]; }
    const gold = f >= 280 ? [E.cx + E.rx * .3, E.cy - E.ry * .4, 4 / .596, .8] : null;
    setEye(H, { cx: E.cx, cy: E.cy, rx: E.rx * 1.04, ry: E.ry * 1.04, tilt: E.tilt, mode: 1, ring: 6, iris0: '#B5A67A', iris1: '#8F825C', pupil: .45, px: drift, py: drift * .55,
      hi: [E.cx - E.rx * .42, E.cy - E.ry * .45, 13, .9], hi2: gold || hi2, hi2c: gold ? '#F3B136' : '#F2E3D0', lid: blink, lidColor: '#C9944F', lidBase: .16, ringTop: 9, ringBot: 3.5, paint: 3.4, k2: 1 / .596 });
    // 陆蔚遮雨的前臂（A08 裁切，左上；返修 story-14：虚化 12K → 7K，指尖挂着水滴）
    const LH = luHand; LH.group.visible = true;
    placeOnCam(LH, cam, 506, 120, 520, 120, 1.08, 1.4, 6);
    styleLeo(LH, { d: .92, rimAmt: .25 }); LH.u.uBlur.value = texPx(LH, 7); LH.u.uFogAmt.value = .05;
    driftBands(t, cam);
    // 太阳 5–6（返修 story-03）：α .45 / .35，画在景深之后的屏幕层，躲在远山后面
    for (const sn of suns) sn.m.visible = false;
    const ovs = sunOverlay(f, cam);
    // 远处金光（f280–f286）
    const gl = glows[0]; gl.m.visible = f >= 280;
    if (f >= 280) { const k = (f - 280) / 6; placeOn(gl.m, cam, 1560, 230, (6 + 18 * k) * 5, 500, (6 + 18 * k) * 5); gl.u.uC.value.copy(lin3('#F3B136')); gl.u.uA.value = (k < .5 ? k / .5 * .8 : .8 - (k - .5) * .8) * 3; }
    else { gl.u.uC.value.set(1, 1, 1); gl.u.uA.value = .22; }
    glows[1].m.visible = glows[2].m.visible = false;
    // 雾整体压暗（f262–f286）
    const dark = .1 * clamp((f - 262) / 24);
    skyU.uZ.value.copy(lin3('#C9C4BB')).multiplyScalar(1 - dark); skyU.uM.value.copy(lin3('#D7D2C9')).multiplyScalar(1 - dark);
    plateU.uTintA.value.setScalar(1 - dark);
    swayPine(f);
    return { scene, camera: cam, dof: { zf: 2.2, cocScale: 47, cocMax: 18, rfg: 14 }, drops: dropsS2b(f, cam), overlay: ovs, night: nightK(f) };
  };
  // S2b 屏幕层太阳（sRGB）
  const ovSun = { scene: new THREE.Scene(), camera: new THREE.OrthographicCamera(0, 1920, 1040, 0, -100, 100) };
  const ovSunU = { uC: { value: srgb('#9F4346') }, uHalo: { value: lin3('#EAAD49') }, uA: { value: 0 }, uSeed: { value: 5 }, uSoftV: { value: .1 }, uMode: { value: 0 }, uHaloA: { value: 0 }, uScale: { value: 1 }, uK: SHARED.uK, uOcc: { value: 1 }, uJag: { value: .08 }, uHot: { value: 1 }, tPlate: { value: tex.nanshanGrey }, uPlateR: { value: new THREE.Vector4() } };
  const ovSunM = new THREE.Mesh(UNIT, sm(PV, SUN_FS, ovSunU, { depthTest: false })); ovSunM.frustumCulled = false; ovSun.scene.add(ovSunM);
  function sunOverlay(f, cm) {
    for (let k = 4; k < 6; k++) {
      const sx = (f - SUN_F[k]) / SUN_VIS;
      if (sx < 0 || sx > 1) continue;
      const x = 1840 - 640 * sx, y = 470 - 330 * Math.sin(Math.PI * sx), r = 40;
      ovSunM.position.set(x, 1040 - y, 0); ovSunM.scale.set(r * 6, r * 6, 1);
      ovSunU.uA.value = [.45, .35][k - 4]; ovSunU.uSeed.value = k + 1; ovSunU.uSoftV.value = 5 / r;
      ovSunU.uPlateR.value.set(...plateRect(cm));
      return ovSun;
    }
    return null;
  }
  function dropsS2b(f, cm) {
    const out = [];
    // 指尖挂着的水滴（一直在，每 15 帧落下一颗）
    const hang = ((f - 214) % 15 + 15) % 15;
    out.push([552, 168 + hang * .8, 10 + hang * .6, .7]);
    for (let k = 0; k < 6; k++) {
      const f0 = 214 + 15 * Math.floor((f - 214) / 15) - 15 * k; const age = (f - f0) / 24; if (age < 0 || age > .7) continue;
      out.push([560 - 8, 150 + 1300 * age * age * 2.2, 9 + 60 * age, .55]);
    }
    if (f >= 216 && f < 228) for (let j = 0; j < 3; j++) { const age = (f - 216) / 24; out.push([700 + 120 * j * age * 3 + 40 * j, 330 - 200 * age + 1800 * age * age, 6, .6]); }
    return out;
  }
  // S4c 满身文采·第七日雾散（f438–f482）
  shots.S4c = (f, t) => {
    const s = ss5((f - 438) / 44);
    const C2 = V3(.412, .327, 5.5);
    aim(cam, C2.clone().add(V3(0, .25 * s, -5.5 * .03 * s)), 0, 1 * DEG); cam.fov = 22.07; cam.updateProjectionMatrix();
    hideAll(); commonVis('S4');
    const tc = tcOf(f);
    // 翻色前沿
    // 第 4 轮（qa2-07）：前沿带了斜度和更大的水彩起伏（util.js wipeD），起止各往外放 ±300K，保证 f458 还没进画、f476 扫完不留灰角
    const wipeX = 2350 - 3000 * ss((f - 458) / 18);
    SHARED.uWipeX.value = wipeX;
    const S = placeLeoSit(cam, f, { scaleY: 1 });
    // 抬头 f466/f468，坐直 f472/f474
    const lift = (Math.floor(f / 2) * 2 >= 466 ? -4 : 0) + (Math.floor(f / 2) * 2 >= 468 ? -4 : 0);
    const sit = (Math.floor(f / 2) * 2 >= 472 ? .015 : 0) + (Math.floor(f / 2) * 2 >= 474 ? .015 : 0);
    setBends(S, [{ pivot: [346, 520], center: [400, 250], angle: lift * DEG, rIn: 180, rOut: 340 }], { pivot: [250, 1110], amount: sit + .008 * Math.sin(tc * Math.PI / 2), radius: 1150 });
    // 豹斑级联
    const spots = [...spotsFor(spines.sit, plan), ...headSpotsFor('A02', { allOn: false })];
    S.u.uTc.value = tc; S.u.uSpotOn.value = 1;
    setSpots(S, spots);
    S.u.uGoldClear.value = ss((f - 456) / 10);
    styleLeo(S, { d: .92, light: f >= 458 ? segLightColor.clone().lerp(segLightGrey, 1 - ss((f - 458) / 18)) : segLightGrey,
      rimC: f >= 458 ? '#EAAD49' : '#EEE7DF', rimAmt: f >= 458 ? .6 * ss((f - 458) / 12) + .2 : .3, rimDir: [1, -.6], glowC: '#F3E8C0', glowA: .16 * ss((f - 458) / 12) });
    const A = M('A02')['锚点'], E = A['眼椭圆'];
    setEye(S, { cx: E.cx, cy: E.cy, rx: 1, ry: 1, mode: 0, lid: 0 }); S.u.uEye.value.set(E.cx, E.cy, E.rx, E.ry);
    const Lu = placeLu(cam, f, { arm: -15 });
    // 第 3 轮（v2-03）：陆蔚（画左 0–500）等翻色前沿扫到他身上才翻色、才有金色边缘光，不再和前沿脱节
    const kLu = f >= 458 ? ss((480 - wipeX) / 520) : 0;
    const ld = .92 - .77 * kLu;
    styleLeo(Lu, { d: ld, light: segLightColor.clone().lerp(segLightGrey, 1 - kLu), rimC: kLu > .02 ? '#EAAD49' : '#EEE7DF', rimAmt: .3 + .2 * kLu, rimDir: [1, -.6], glowC: '#F3E8C0', glowA: .16 * kLu });
    // 雾散：雾带从中线向两边滑开并变薄；第七日破雾；光束
    const open = ss((f - 458) / 18);
    bands.forEach((b, k) => { const dir = (k % 2 ? 1 : -1); b.m.position.copy(b.base).add(V3(dir * open * b.D * .9, 0, 0)); b.u.uAlpha.value = lerp(.85, .35, open) / .85; });
    driftBands(t, cam);
    mists.forEach((m, k) => { m.m.position.x += (k % 2 ? 1 : -1) * open * m.D * .8; m.u.uA.value = m.a * (1 - .6 * open); });
    suns.forEach(sn => { sn.m.visible = false; });
    if (f >= 458) {
      // 第七日（返修 style-07 / style-17）：挪到主峰右侧斜后方破雾；芯 HDR ×2.5、晕 380K α .45 染琥珀；7 道光束 α .45、长 1300K、越远越宽，
      //   画在雾带之上，被崖和松的深度挡出光柱里的阴影
      // 第 2 轮（style-07 换思路）：上一轮的芯 HDR 和 bloom 都被画角暗角压回了米灰（芯 214 < 周围天 230）。
      //   这次：① 终合成里高光不吃暗角（vigHi）；② 日芯更白更烫（#FFF6E0 ×5）、晕染琥珀（α .6）；
      //   ③ 光柱改成屏幕空间体积光：从日轮和日边的亮天放射模糊出来，崖、松、豹、人的深度当遮挡物切出光柱里的影子（post.js）
      bigSun.visible = true;
      const k = (f - 458) / 6; const sc = k < .5 ? 2.2 * k : k < 1 ? 1.1 - .2 * (k - .5) : 1.0;
      const SX = 1790, SY = 128;
      placeOn(bigSun, cam, SX, SY, 380 * 2.15 * 2, 3000); bigSunU.uScale.value = Math.max(sc, .001); bigSunU.uA.value = 1; bigSunU.uHot.value = 5.0; bigSunU.uHaloA.value = .42; bigSunU.uSoftV.value = .16;
      bigSunU.uC.value.copy(lin3('#FFF6E0'));
      beams.forEach((b, i) => { b.m.visible = true; const ang = (118 + i * 8.5 + (f - 458) / 24 * 1) * DEG; const len = 1300; const cx = SX + Math.cos(ang) * len * .5, cy = SY + Math.sin(ang) * len * .5; placeOn(b.m, cam, cx, cy, 150 + 110 * hashi(i), 300, len); b.m.rotateZ(-(ang - Math.PI / 2)); b.u.uA.value = .3 * open * (.6 + .4 * hashi(i * 3)); });
      skyU.uSunGlow.value = .3 * open; skyU.uSunDir.value.copy(screenToWorld(cam, SX, SY, 100).sub(cam.position).normalize());
    } else skyU.uSunGlow.value = 0;
    rockMat.userData.u.uWetAmt.value = f < 458 ? .1 : 0;
    // 彩态崖石逆光一侧的受光边（#EAAD49 .8）加宽到约 8K（阈值放低）
    rockMat.userData.u.uRimLitAmt.value = .8 * open; rockMat.userData.u.uRimLitIn.value = .42; rockMat.userData.u.uLightW.value.set(.6, .6, .3).normalize();
    rockMat.userData.u.uFogD.value = lerp(.012, .006, open);
    for (const o of [ledge, wall, arch]) o.userData.outlineAlpha = .5;
    trunk.userData.outlineAlpha = .8;
    glows.forEach(g => { g.u.uA.value = .22 * (1 - open); });
    ridges.forEach(r => { r.u.uAlpha.value = .8 * (1 - open); });
    swayPine(f);
    const rays = f >= 458 ? { x: 1790, y: 128, amt: .8 * open, thr: .93, r: .9, density: .98, decay: .991, beams: 1, seed: 5.2, tint: '#F3C46B', dir: [-.8, -.6], wipe: wipeX, core: 110 } : null;   // 第 3 轮（v2-03）：光只加在前沿扫过的一侧；第 4 轮（v3-05）：日芯 110K 以内不分束
    return { scene, camera: cam, dof: { zf: 5.5, cocScale: 10, cocMax: 6 }, outlineColor: f >= 470 ? '#1F2A28' : '#232120', rays, vigHi: f >= 458 ? open : 0, wipeE: f >= 458 ? { x: wipeX, a: 1 } : null };
  };
  // 恢复灰态的公共量（每个灰段镜头开头调用）
  function resetGrey() {
    skyU.uZ.value.copy(lin3('#C9C4BB')); skyU.uM.value.copy(lin3('#D7D2C9')); plateU.uTintA.value.set(1, 1, 1); skyU.uSunGlow.value = 0;
    rockMat.userData.u.uWetAmt.value = .1; rockMat.userData.u.uRimLitAmt.value = 0; rockMat.userData.u.uRimLitIn.value = .2; rockMat.userData.u.uLightW.value.set(...LIGHT).normalize(); rockMat.userData.u.uFogD.value = .012;
    rockMat.userData.u.uTopAmt.value = 1; rockMat.userData.u.uPaintAmt.value = .5;
    bands.forEach(b => b.m.position.copy(b.base)); mists.forEach(m => { m.m.position.copy(m.base); m.u.uA.value = m.a; });
    glows.forEach((g, k) => { g.u.uC.value.set(1, 1, 1); g.u.uA.value = .22; g.m.visible = true; });
    for (const n of needles) { n.u.uFogAmt.value = .08; n.u.uFog.value.copy(lin3('#CFCAC1')); }
    placeOn(glows[0].m, c0cam, 1180, 640, 140 * 2.4, 250, 140 * 1.2);
    bands.forEach((b, k) => { b.u.uAlpha.value = BAND_A[k]; });
    ridges.forEach(r => { r.u.uAlpha.value = .8; });
    for (const o of [ledge, wall, arch, fgStone, ...topStones]) o.userData.outlineAlpha = .5;
    trunk.userData.outlineAlpha = .8; for (const b of branches) b.userData.outlineAlpha = .8;
    caveMat.uniforms.uFogA.value = 0;
    for (const S of [...Object.values(leo), head, lu, luHand]) { setBends(S, [], null); S.u.uBlur.value = 0; S.u.uFogAmt.value = 0; S.u.uEyeB.value.set(0, 0, 0, 8); }
  }
  for (const k of ['T1W', 'S2a', 'S2b', 'S4c']) { const fn = shots[k]; shots[k] = (f, t) => { if (k !== 'S4c') resetGrey(); else { resetGrey(); } return fn(f, t); }; }

  // ── S5a 坐定·一跃·升降穿云（f482–f567） ──
  // 侧面看：小豹朝画右跃起、不落下；相机在它的 +z 一侧跟着升上去，冲出云顶落在 f516。
  const D0 = V3(.85, 0, .3);
  function leoP(f) {
    if (f < 495) return V3(0, 0, 0);
    if (f < 529) { const s = (f - 495) / 34, s2 = Math.pow(s, 1.45); return V3(5.7 * s, .2 + 15.3 * (1 - (1 - s2) * (1 - s2)), -2.0 * s); }
    const tau = (f - 529) / 24; return V3(5.7 + 2.8 * tau, 15.5 + .2 * Math.sin(2 * Math.PI * tau / 1.5), -2.0 - 1.0 * tau);
  }
  const CA = V3(-.25, .06, 2.75), TA = V3(.35, .78, -.5), OB = V3(-.75, -.55, 2.7), TB = V3(.18, .16, -.4);
  // 返修 story-02：冲出云顶以后不再锁死——f512 起水平方向只跟 80% 的路（跟随比用 ss 从 1 缓下来，速度连续），
  //   小豹在 51 帧里从画左 1/3 飞向画右 2/3；竖直方向照跟（不让它飞出画框上沿）；相机同时缓慢上仰 6°、横滚 3°
  const RHO = .38;   // 第 2 轮（story-02）：水平只跟 38% 的路，小豹在 51 帧里从画左 1/3 飞到画右 2/3
  function lagP(f) {
    const P = leoP(f); if (f <= 512) return P;
    const r = lerp(1, RHO, ss((f - 512) / 18)), P0 = leoP(512);
    return V3(P0.x + (P.x - P0.x) * r, P.y, P0.z + (P.z - P0.z) * r);
  }
  function camS5a(f) {
    const P = leoP(f), Pl = lagP(f);
    const w = ss5((f - 495) / 16);
    const pos = CA.clone().lerp(Pl.clone().add(OB), w).add(D0);
    const tsh = V3(.8 * ss((f - 503) / 13), 0, 0);
    const tgt = TA.clone().lerp(Pl.clone().add(TB).add(tsh), ss((f - 493) / 8)).add(D0);
    cam.position.copy(pos); cam.up.set(0, 1, 0); cam.lookAt(tgt);
    // 第 2 轮（story-02）：冲出云顶以后镜头慢慢向右摇 9°（背景整体左移约 220px，不再是一张静帧），同时上仰 6°、横滚 3°
    const k = ss((f - 516) / 51); cam.rotateY(-9 * DEG * k); cam.rotateX(4 * DEG * k); cam.rotateZ(-3 * DEG * k);
    cam.fov = f < 516 ? lerp(44.22, 50, ss((f - 495) / 21)) : lerp(50, 44.22, ss((f - 516) / 29)); cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    return { P: P.add(D0), cam };
  }
  function leoPoseS5a(f) { const ff = Math.floor(f / 2) * 2; return ff < 488 ? 'sit' : ff < 495 ? 'coil' : ff < 502 ? 'launch' : 'glide'; }
  const pxM = LEO_H / 1135;   // A02 每贴图像素的世界长度；其余姿态按眼椭圆 rx 对齐大小
  const POSE = {
    sit: { a: [305, 1118], h: LEO_H, id: 'A02' },
    coil: { a: [1160, 645], h: 662 * pxM * .926, id: 'A03' },
    launch: { a: [760, 600], h: 995 * pxM * 1.096, id: 'A04' },
    glide: { a: [820, 520], h: 723 * pxM * 1.09, id: 'A05' },
  };
  function placeLeoS5a(f) {
    const { P, cam: c } = camS5a(f);
    const pose = leoPoseS5a(f);
    for (const k of Object.keys(leo)) leo[k].group.visible = k === pose;
    const S = leo[pose], cfg = POSE[pose];
    let ang = 0;
    if (pose === 'launch') ang = -14;
    if (pose === 'glide') { const v = leoP(f + 1).sub(leoP(f - 1)); ang = clamp(-Math.atan2(v.y, Math.hypot(v.x, v.z)) / DEG * .5, -25, 25) + 4 * Math.sin(tcOf(f) * Math.PI * 2 / 1.2); }
    const lift = pose === 'coil' ? V3(0, -.02, 0) : pose === 'launch' ? V3(0, .25, 0) : pose === 'glide' ? V3(0, .25, 0) : V3(0, 0, 0);
    // 第 4 轮（qa2-08）：云海段小豹偏小（含尾约 245 px）——滑翔姿态在穿云那一段（f505–f525）慢慢放大 18%，冲出云顶以后约 290 px
    const gS = pose === 'glide' ? 1 + .18 * ss(seg(f, 505, 525)) : 1;
    placeWorld(S, c, cfg.a[0], cfg.a[1], P.clone().add(lift), cfg.h * gS, ang);
    return { S, pose, c, P };
  }
  function tailRootWorld(f) {
    const { S, pose } = placeLeoS5a(f);
    const A = M(POSE[pose].id)['锚点']['脊柱锚点_px'].tail_root;
    S.group.updateMatrixWorld(true);
    return texToWorld(S, A[0], A[1]);
  }
  // A05 滑翔的 3 个姿态（网格形变）：前爪（肩下）交替前后划 ±9°、腰部 S 形 ±3°、尾根 ±12°、尾尖反向
  function glideBends(ph) {
    const A5 = M('A05')['锚点']['脊柱锚点_px'];
    const k = [1, 0, -1][ph];
    return [{ pivot: A5.tail_root, center: [250, 350], angle: 12 * k * DEG, rIn: 60, rOut: 330 },
      { pivot: [320, 300], center: [140, 410], angle: -12 * k * 1.2 * DEG, rIn: 40, rOut: 200 },
      { pivot: [1180, 560], center: [1400, 610], angle: 9 * k * DEG, rIn: 60, rOut: 190 },
      { pivot: [590, 540], center: [760, 520], angle: 3 * k * DEG, rIn: 120, rOut: 330 }];
  }
  shots.S5a = (f, t, o = {}) => {
    SHARED.uWipeX.value = -1e5;
    hideAll(); commonVis('S5');
    wall.visible = arch.visible = cave.visible = false;
    const tc = tcOf(f);
    // 墨点（返修 story-11）：等小豹到了画面中上（约 f530）再开始吐，每 2 帧一颗，寿命 48 帧
    const births = [];
    for (let k = 0; k < 40; k++) { const fb = 530 + 2 * k; if (fb > f || f - fb > 48) continue; births.push([k, fb, tailRootWorld(fb)]); }
    const { S, pose, c, P } = placeLeoS5a(f);
    for (const k of Object.keys(leo)) setBends(leo[k], [], null);
    // 滑翔（返修 story-02）：3 个姿态一拍二循环——前爪交替划、身体 S 形起伏、尾巴摆 ±12°
    if (pose === 'glide') { const ph = Math.floor(f / 2) % 3; setBends(S, glideBends(ph)); }
    S.u.uTc.value = tc; S.u.uSpotOn.value = 1; S.u.uGoldClear.value = 1;
    setSpots(S, [...spotsFor(spines[pose], plan, { allOn: true }), ...headSpotsFor(POSE[pose].id)]);
    styleLeo(S, { d: 0, light: segLightColor, rimC: '#EAAD49', rimAmt: .55, rimDir: [.7, -.7], glowC: '#F3E8C0', glowA: .16 });
    const E = M(POSE[pose].id)['锚点']['眼椭圆'];
    S.u.uEye.value.set(E.cx, E.cy, E.rx, E.ry); S.u.uEyeB.value.set(0, 0, 0, 8);
    // f526–f540 睁一次眼（享受）：代码眼画在 A05 的眼椭圆里
    if (pose === 'glide' && f >= 526 && f < 540) { const op = Math.floor(f / 2) * 2; const lid = op < 528 ? .55 : op < 536 ? .22 : .55; setEye(S, { cx: E.cx, cy: E.cy + 4, rx: E.rx * .92, ry: E.ry * 1.15, tilt: E.tilt, mode: 1, ring: 7, iris0: '#E3CA58', iris1: '#A98E43', pupil: .44, px: 6, py: -2, hi: [E.cx - E.rx * .35, E.cy - E.ry * .2, 9, .95], lid, lidColor: '#D9A050' }); }
    births.forEach(([k, fb, w]) => {
      const d = dots[k]; d.m.visible = true;
      const age = f - fb;
      const jit = V3(hashi(k * 3) - .5, hashi(k * 3 + 1) - .5, (hashi(k * 3 + 2) - .5) * .3).multiplyScalar(.16);
      d.m.position.copy(w).add(jit);
      c.getWorldQuaternion(d.m.quaternion);
      const sz = (.075 + .04 * hashi(k * 7)) * popW(Math.floor((tc * 24 - fb) / 2) * 2);   // 屏上实际墨团半径约 .7·sz/1.45，上限约 .10 m
      d.m.scale.set(sz * 2.9 * .7, sz * 2.9 * .7, 1);
      const near = clamp((d.m.position.distanceTo(c.position) - .9) / .8);
      d.u.uA.value = .9 * (1 - ss((age - 32) / 16)) * near; d.u.uSpread.value = .2 * ss((age - 16) / 32); d.u.uCol.value = ss((age - 20) / 28);
    });
    plate5.visible = f < 513;
    // 峰和高云：按水平方向摆在相机前方（世界里不动，镜头升起时自然有视差）
    for (const p of peaks) { p.m.visible = true; }
    for (const w of highWisps) w.m.visible = true;
    // 第 3 轮（v2-05）：太阳是无穷远处一个固定的方向（取 f518 镜头里 (1660, 150) 的方向），每帧按当前镜头投到屏幕上——
    //   镜头往右摇、往上仰，太阳就往左下走（f518 → f566 约左移 180 px、下移 47 px），不再像贴在镜头上；角大小不随 FOV 变
    const sp = c.position.clone().add(SUN5_DIR.clone().multiplyScalar(3000)).project(c);
    const SX5 = (sp.x * .5 + .5) * 1920, SY5 = (.5 - sp.y * .5) * 1040;
    const sunPx = 1200 * Math.tan(44.22 * DEG / 2) / Math.tan(c.fov * DEG / 2);
    bigSun.visible = sp.z < 1; placeOn(bigSun, c, SX5, SY5, sunPx, 3000); bigSunU.uScale.value = 1; bigSunU.uA.value = .95; bigSunU.uHot.value = 4.5; bigSunU.uHaloA.value = .42; bigSunU.uSoftV.value = .16; bigSunU.uC.value.copy(lin3('#FFF6E0'));
    skyU.uSunGlow.value = .3; skyU.uSunDir.value.copy(SUN5_DIR);
    cloudTop.position.set(c.position.x, CLOUD_TOP - .25, c.position.z - 500);
    cloudNear.position.set(Math.round(c.position.x / 1.2) * 1.2, CLOUD_TOP, Math.round((c.position.z - 70) / 1.2) * 1.2);
    const cy = c.position.y;
    inCloudU.uA.value = cy > CLOUD_TOP - 1.9 && cy < CLOUD_TOP + .35 ? clamp(Math.min((cy - (CLOUD_TOP - 1.9)) / .6, (CLOUD_TOP + .35 - cy) / .35)) : 0; inCloudU.uT.value = t;
    nearClouds.forEach((n, k) => {
      const base = k < 6 ? (f < 516 ? V3(D0.x - 3 + 3.2 * k + 1.5 * hashi(k * 3), CLOUD_TOP - 1.2 + 1.6 * hashi(k * 5), D0.z - 9 + 7 * hashi(k * 7))
          : V3(D0.x + 4.5 + 2.6 * k + 1.2 * hashi(k * 3), CLOUD_TOP + .25 + .5 * hashi(k * 5), D0.z - 1.5 - 2.4 * k - 1.5 * hashi(k * 7)))
        : V3(D0.x + 4 + 9 * (k - 6) + 4 * hashi(k * 3), CLOUD_TOP - .15 + .5 * hashi(k * 5), D0.z - 22 - 40 * hashi(k * 7));
      n.m.position.copy(base); c.getWorldQuaternion(n.m.quaternion);
      const w = (k < 6 ? 7 + 5 * hashi(k * 9) : 14 + 14 * hashi(k * 9)); n.m.scale.set(w, w * .3, 1);
      const dist = base.distanceTo(c.position);
      n.u.uA.value = (k < 6 ? (f < 516 ? .8 : .55) : .32) * (f >= 511 && f <= 519 ? 1 : clamp((dist - (f < 516 ? 3 : 1.2)) / (f < 516 ? 6 : 2.5))); n.u.uTint.value.copy(lin3(k < 6 ? '#F8F9F2' : '#FFFFFF'));
    });
    rockMat.userData.u.uWetAmt.value = 0; rockMat.userData.u.uRimLitAmt.value = .2; rockMat.userData.u.uRimLitIn.value = .2; rockMat.userData.u.uLightW.value.set(.6, .6, .3).normalize(); rockMat.userData.u.uFogD.value = .002;
    // 第 3 轮（v2-08）：S5a 脚下的崖顶少铺一点金草（赭黄面积减小），笔触贴图加重——和 S4c 的崖壁同一套笔触
    rockMat.userData.u.uTopAmt.value = .62; rockMat.userData.u.uPaintAmt.value = .72;
    for (const o of [ledge, ...topStones]) o.userData.outlineAlpha = .45;
    const zf = c.position.distanceTo(P);
    if (o.hideLeo) S.group.visible = false;
    // 浮岛：相机快到云层时才淡入
    for (const p of peaks) p.u.uA.value = ss(seg(f, 507, 516));
    // 体积光（style-07 第 2 轮）：太阳在 (1660, 150)，云和浮岛的暗处切出光柱；穿云那几帧关掉
    const inC = inCloudU.uA.value;
    // 第 3 轮（v2-05）：光柱跟着太阳走；做宽、做软——束的频率减半、束间反差减半、强度降一档，空天上不再是两三道舞台追光
    const rays = { x: SX5, y: SY5, amt: .3 * (1 - inC), thr: .93, r: 1.0, density: .96, decay: .986, beams: .5, beamF: 2.5, seed: 9.1, tint: '#F3C46B', dir: [-.8, -.6], core: 80 * Math.tan(44.22 * DEG / 2) / Math.tan(c.fov * DEG / 2) };
    return { scene, camera: c, dof: { zf, cocScale: 4, cocMax: 4 }, rays, vigHi: 1 };
  };
  // 相机冲出云顶的那一帧：f516（云顶高度按相机 y 定）
  const CLOUD_TOP = (() => { const a = camS5a(516).cam.position.y, b = camS5a(517).cam.position.y; return (a + b) / 2; })();
  // S5a 的太阳方向（世界里固定，第 3 轮 v2-05）：f518 镜头里 (1660, 150) 那一点
  const SUN5_DIR = (() => { const { cam: c } = camS5a(518); return screenToWorld(c, 1660, 150, 100).sub(c.position).normalize(); })();
  // S5b 起首需要：S5a 末帧小豹屏幕位置（给化开对位）
  function leoScreen(f) { const { S, c, P } = placeLeoS5a(f); const p = P.clone().add(V3(0, .25, 0)).project(c); return [(p.x * .5 + .5) * 1920, (.5 - p.y * .5) * 1040]; }
  // S5b 起首要接住的东西：小豹（滑翔姿态）在 S5a 机位下的屏幕锚点、大小（设计像素 / 贴图像素）、倾角
  function leoInfo(f) {
    const { S, c, P } = placeLeoS5a(f);
    const p = P.clone().add(V3(0, .25, 0)).project(c);
    let ang = 0; { const v = leoP(f + 1).sub(leoP(f - 1)); ang = clamp(-Math.atan2(v.y, Math.hypot(v.x, v.z)) / DEG * .5, -25, 25) + 4 * Math.sin(tcOf(f) * Math.PI * 2 / 1.2); }
    return { x: (p.x * .5 + .5) * 1920, y: (.5 - p.y * .5) * 1040, s: S.pxPerTex, ang };
  }
  { const { cam: c } = camS5a(482); placeOn(plate5, c, 862, 850, 2700, 2400, 900); ridges5.forEach(r => placeOn(r.m, c, 960, r.y, 5200, r.D, 420)); }
  {
    const { cam: c } = camS5a(540);
    const fwd = new THREE.Vector3(); c.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    peaks.forEach(p => {
      const ctr = c.position.clone().add(fwd.clone().multiplyScalar(p.D)).add(right.clone().multiplyScalar((p.x - 960) / 1280 * p.D * .5));
      const wM = p.w / 1280 * p.D, hM = p.h / 1280 * p.D;
      p.m.position.set(ctr.x, CLOUD_TOP - hM * .2 + hM * .5, ctr.z); p.m.rotation.set(0, yaw, 0); p.m.scale.set(wM, hM, 1);   // 第 2 轮：浮岛多沉进云海一点，小豹滑翔时始终在岛顶之上（不像要落到岛上）
    });
    horizonBanks.forEach(h => {
      const k = h.k, D = 520 + 260 * k;
      const ctr = c.position.clone().add(fwd.clone().multiplyScalar(D)).add(right.clone().multiplyScalar((-.35 + .4 * k) * D));
      const wM = (1.6 + .4 * hashi(k * 5)) * D;
      h.m.position.set(ctr.x, CLOUD_TOP + wM * .028, ctr.z); h.m.rotation.set(0, yaw, 0); h.m.scale.set(wM, wM * .12, 1);
    });
    highWisps.forEach(w => {
      const k = w.k, D = 300 + 260 * k;
      const ctr = c.position.clone().add(fwd.clone().multiplyScalar(D)).add(right.clone().multiplyScalar((-.55 + .38 * k) * D));
      const wM = (.9 + .5 * hashi(k * 7)) * D * .5;
      w.m.position.set(ctr.x, CLOUD_TOP + D * (.1 + .05 * hashi(k * 3)), ctr.z); w.m.rotation.set(0, yaw, 0); w.m.scale.set(wM, wM * .22, 1);
    });
  }
  const popW = age => age < 2 ? 0 : age < 4 ? .6 : age < 6 ? 1.14 : age < 8 ? .96 : 1;

  return { scene, cam, shots, alignRidges, camW, leoScreen, leoInfo, plan, spines, spotsFor, headSpotsFor, headSpotsGold: L.headSpotsGold, rockMat, styleLeo, setSkyColor: null };
}
