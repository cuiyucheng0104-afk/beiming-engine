// src/ferry.js — 黄浦江小渡船（镜头 A 大远景里的点景）
// 低多边形 + toon.js 卡通材质：红色船身、米白船舱、深色顶棚；舱内暖灯（HDR 自发光，吃 bloom）；
// 红绿航行灯 + 桅顶白灯（HDR 光点）；船尾白色尾迹线 + 船头小浪（水面上的画线，24 fps 平滑流动）；
// 航行灯与舱灯在水里的竖向倒影光斑（一拍二抖动，像水波）。
// 坐标：船长约 32 m，船头朝 +X，上为 +Y，原点在水线船中。
import * as THREE from 'three';
import { makeToonMaterial, bindToon, TOON_DEFAULTS, PALETTE } from './toon.js';
import { hashi } from './scene.js';
import { boatHull } from '../engine/form/props.js';

const hdr = (hex, k) => new THREE.Color(hex).multiplyScalar(k);

// 船身：engine/form/props.js 的 boatHull（俯视船头尖、船尾方，挤出，船底收窄，吃水 1 m）
const hullGeo = (L, B, Hh) => boatHull(L, B, Hh, 1.0);

export function createFerry() {
  const L = 32, B = 9;
  const g = new THREE.Group(); g.name = 'ferry';
  const toonOf = (color, shade1, shade2, extra = {}) => makeToonMaterial({ ...TOON_DEFAULTS, color, shade1, shade2, cityAmt: 0.5, cityFlat: 0.4,
    rimColor: PALETTE.kunRim, rimAmt: 0.9, rimInside: 0.36, rimPower: 0.35, rimDirK: 0.35, rustAmt: 0.25, rustThr: 0.25, patchScale: 0.35, ...extra });

  const hullMat = toonOf('#C8463C', '#7d2a3a', '#43243f');
  const hull = bindToon(new THREE.Mesh(hullGeo(L, B, 3.0), hullMat), hullMat, { castShadow: false, receiveShadow: false });
  g.add(hull);
  // 船舷一条白色腰线
  const stripeMat = toonOf('#EDE3D3', '#9A8FA8', '#5d5680', { rustAmt: 0 });
  const stripe = bindToon(new THREE.Mesh(hullGeo(L * 1.002, B * 1.01, 0.45), stripeMat), stripeMat, { castShadow: false, receiveShadow: false });
  stripe.position.y = 2.45; g.add(stripe);
  // 主舱（米白）+ 顶棚（深蓝）+ 驾驶室
  const cabMat = toonOf('#EDE3D3', '#9A8FA8', '#5d5680', { rustAmt: 0.15 });
  const roofMat = toonOf('#3E4878', '#2c3460', '#1f2547', { rustAmt: 0 });
  const box = (w, h, d, mat, x, y, z) => { const m = bindToon(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat), mat, { castShadow: false, receiveShadow: false }); m.position.set(x, y, z); g.add(m); return m; };
  box(L * 0.62, 3.0, B * 0.82, cabMat, -L * 0.06, 3.5, 0);
  box(L * 0.66, 0.5, B * 0.9, roofMat, -L * 0.06, 5.25, 0);
  box(L * 0.18, 2.4, B * 0.5, cabMat, L * 0.06, 6.7, 0);
  box(L * 0.2, 0.4, B * 0.56, roofMat, L * 0.06, 8.1, 0);
  // 桅杆
  const mast = box(0.35, 4.2, 0.35, roofMat, L * 0.1, 10.3, 0);
  mast.userData.outlineWidth = 0.6;

  // 舱内暖灯：一条一条窗（HDR 自发光；不描边，但实心挡线）
  const winMat = new THREE.MeshBasicMaterial({ color: hdr(PALETTE.window, 2.4), toneMapped: false, fog: true });
  const winMat2 = new THREE.MeshBasicMaterial({ color: hdr('#FFB26B', 1.7), toneMapped: false, fog: true });
  const windows = new THREE.Group();
  for (const side of [1, -1]) {
    for (let i = 0; i < 7; i++) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.1, 0.12), i % 3 === 1 ? winMat2 : winMat);
      w.position.set(-L * 0.33 + i * 2.75, 3.75, side * (B * 0.41 + 0.02));
      windows.add(w);
    }
    const w2 = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.9, 0.12), winMat);
    w2.position.set(L * 0.06, 6.9, side * (B * 0.25 + 0.02)); windows.add(w2);
  }
  const wf = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.9, B * 0.42), winMat); wf.position.set(L * 0.06 + L * 0.09 + 0.02, 6.9, 0); windows.add(wf);
  windows.traverse(o => { o.userData.outline = false; });
  g.add(windows);

  // 航行灯：左舷红、右舷绿（船头朝 +X 时，左舷在 +Z）+ 桅顶白灯
  const lamp = (hex, k, r, x, y, z) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), new THREE.MeshBasicMaterial({ color: hdr(hex, k), toneMapped: false, fog: false })); m.position.set(x, y, z); m.userData.outline = false; g.add(m); return m; };
  const red = lamp('#FF3B3B', 3.2, 0.55, L * 0.1, 8.6, B * 0.3);
  const green = lamp('#3BFF8A', 3.0, 0.55, L * 0.1, 8.6, -B * 0.3);
  const white = lamp('#FFF4E0', 3.0, 0.5, L * 0.1, 12.5, 0);
  const sternLamp = lamp('#FFE2B0', 2.4, 0.45, -L * 0.48, 4.6, 0);

  return { group: g, length: L, beam: B, lights: { red, green, white, sternLamp } };
}

// ───────────────────────── 尾迹：面朝镜头的画笔条（大远景里水面几乎是掠射角，真 3D 的水面画线会细到看不见） ─────────────────────────
// 面片局部 x：0 = 船尾，1 = 尾迹末端（拖向画右后方、越远越细越淡）；y：-0.5..0.5 横向（屏幕竖直方向）。
// 画：两道几乎合拢的 V 形白浪线 + 中间翻白的乱流 + 船头小月牙浪（在 x<0 的一小段）；24 fps 平滑向后流。
const WAKE_FS = /* glsl */`
uniform float uT, uOpacity; uniform vec3 uCol;
varying vec2 vUv;
float h1(float n){ return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
float vn(float x){ float i = floor(x), f = fract(x); f = f * f * (3. - 2. * f); return mix(h1(i), h1(i + 1.), f); }
void main(){
  float x = vUv.x * 1.25 - 0.25, y = (vUv.y - .5) * 2.;      // x: -0.25..1（负的是船身段），y: -1..1
  float a = 0.;
  if (x >= 0.) {
    float spread = 0.18 + 0.75 * x;                          // V 形张开（屏幕上很扁）
    float w = 0.10 + 0.05 * vn(x * 9. + 3.);
    float l1 = 1. - smoothstep(w * .5, w, abs(y - spread));
    float l2 = 1. - smoothstep(w * .5, w, abs(y + spread * .55));
    float brk = smoothstep(.3, .62, vn(x * 14. - uT * 2.2)) * .6 + .4;    // 断续的笔触，向后流
    float lines = max(l1, l2 * .8) * brk * (1. - smoothstep(.45, 1., x));
    float churn = (1. - smoothstep(.12, .3 + .2 * x, abs(y))) * (1. - smoothstep(0., .42, x));
    churn *= smoothstep(.35, .75, vn(x * 30. + y * 4. - uT * 4.) * .6 + vn(x * 55. - uT * 6.) * .5);
    a = max(lines, churn);
  } else {
    float bx = (x + .25) / .25;                             // 0 船头 .. 1 船尾
    float bow = (1. - smoothstep(.0, .35, abs(y + .15))) * (1. - smoothstep(.0, .5, bx)) * .9;
    float side = (1. - smoothstep(.0, .18, abs(y + .3))) * smoothstep(.1, .5, bx) * .45;
    a = max(bow, side);
  }
  if (a < .01) discard;
  gl_FragColor = vec4(uCol, a * uOpacity);
  #include <colorspace_fragment>
}`;
export function createWake() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 }, uOpacity: { value: 0.95 }, uCol: { value: new THREE.Color('#FFF4EA').multiplyScalar(1.75) } },   // HDR：吃一点 bloom，并被后期的高光保护挡住 Kuwahara 的抹糊
    vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: WAKE_FS, transparent: true, depthWrite: false, toneMapped: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.renderOrder = 4.8; m.frustumCulled = false; m.userData.outline = false; m.userData.outlineOccluder = false;
  return m;
}

// ───────────────────────── 灯在水里的倒影：竖向拉长的光斑（一拍二抖动） ─────────────────────────
const STREAK_FS = /* glsl */`
uniform vec3 uCol; uniform float uAmt, uSeed;
varying vec2 vUv;
float h1(float n){ return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
void main(){
  vec2 d = vUv - .5;
  float band = floor(vUv.y * 9.);                      // 横向碎成几段（水波）
  float off = (h1(band + uSeed * 7.) - .5) * .35;
  float w = .5 - abs(d.x + off * smoothstep(.2, .5, -d.y + .5));
  float a = smoothstep(0., .28, w) * smoothstep(0., .25, vUv.y) * (1. - smoothstep(.75, 1., vUv.y));
  a *= .55 + .45 * h1(band * 3.1 + uSeed);
  gl_FragColor = vec4(uCol * a * uAmt, 1.);
}`;
export function lightStreak(hex, k = 1) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uCol: { value: hdr(hex, k) }, uAmt: { value: 1 }, uSeed: { value: 0 } },
    vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: STREAK_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.renderOrder = 4.9; m.frustumCulled = false; m.userData.outline = false; m.userData.outlineOccluder = false;
  return m;
}
export const streakSeed = f => Math.floor(f / 2) + hashi(Math.floor(f / 2)) * 0.001;
