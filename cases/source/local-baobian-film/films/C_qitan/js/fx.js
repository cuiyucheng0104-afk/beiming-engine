// fx.js — 屏幕层：雨（三层，写覆盖度，终合成时按底色自适应）、水滴、四芒星闪光、镜片圈、字幕
// 全部以设计像素（1920×1040）建正交相机，渲到实际分辨率时自动 ×K；位置是 t 的纯函数。
import * as THREE from 'three';
import { GLSL_COMMON, lin3, srgb, clamp, ss, EYE_E, STAR_H } from './util.js';

export const orthoCam = () => new THREE.OrthographicCamera(0, 1920, 1040, 0, -100, 100);
const QUAD = new THREE.PlaneGeometry(1, 1);

// ── 雨 ──
const RAIN_VS = /* glsl */`
${GLSL_COMMON}
attribute float aI;
uniform float uT, uLen, uW, uV, uA, uDens, uSeed;
varying float vA; varying vec2 vQ;
void main(){
  uint s = uint(uSeed);
  float h1 = h21(ivec2(int(aI), 1), s), h2 = h21(ivec2(int(aI), 2), s), h3 = h21(ivec2(int(aI), 3), s), h4 = h21(ivec2(int(aI), 4), s);
  vec2 dir = vec2(.13917, .99027);                // 倾 8°，上端偏左
  float span = 1040. + 2. * uLen + 300.;
  float tr = mod(h2 * span + uV * (1. + .25 * (h4 - .5)) * uT, span) - uLen - 150.;
  vec2 c = vec2(h1 * 2400. - 240., 0.) + dir * tr;
  float wv = max(uW, 1.) * 2.2;
  vec2 p = c + dir * position.y * uLen + vec2(dir.y, -dir.x) * position.x * wv;
  vA = uA * step(h3, uDens) * (.65 + .35 * h4) * (uW / wv) * 1.6;
  vQ = position.xy;
  gl_Position = projectionMatrix * vec4(p.x, 1040. - p.y, 0., 1.);
}`;
const RAIN_FS = /* glsl */`
${GLSL_COMMON}
uniform vec4 uDry; uniform float uKr;
varying float vA; varying vec2 vQ;
void main(){
  float across = 1. - sst(.12, .5, abs(vQ.x));
  float along = sst(-.5, -.2, vQ.y) * (1. - sst(.25, .5, vQ.y));
  // 干区（返修 story-14）：陆蔚的手下面没有雨
  float dry = 0.;
  if (uDry.z > 0.) { vec2 p = vec2(gl_FragCoord.x / uKr, 1040. - gl_FragCoord.y / uKr); vec2 q = (p - uDry.xy) / uDry.zw; dry = (1. - sst(.75, 1.1, length(q))) * step(uDry.y - uDry.w * .9, p.y); }
  gl_FragColor = vec4(vA * across * along * (1. - dry), 0., 0., 1.);
}`;
export function makeRain() {
  const scene = new THREE.Scene(), camera = orthoCam();
  const L = [{ n: 120, len: 60, w: 1.6, v: 2600, a: .30 }, { n: 260, len: 34, w: 1.2, v: 1500, a: .22 }, { n: 420, len: 18, w: 1.0, v: 800, a: .15 }];
  // 每层一个普通 BufferGeometry：n 个四边形，每个顶点带实例号 aI（不用实例化绘制，最稳）
  const quads = n => {
    const pos = new Float32Array(n * 12), ai = new Float32Array(n * 4), idx = [];
    for (let i = 0; i < n; i++) {
      pos.set([-.5, -.5, 0, .5, -.5, 0, .5, .5, 0, -.5, .5, 0], i * 12); ai.fill(i, i * 4, i * 4 + 4);
      const b = i * 4; idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aI', new THREE.BufferAttribute(ai, 1)); g.setIndex(idx);
    return g;
  };
  const DRY = { value: new THREE.Vector4(0, 0, 0, 0) }, KR = { value: innerHeight / 1040 };
  const layers = L.map((l, k) => {
    const n = Math.ceil(l.n * 1.4);
    const g = quads(n);
    const u = { uT: { value: 0 }, uLen: { value: l.len }, uW: { value: l.w }, uV: { value: l.v }, uA: { value: l.a }, uDens: { value: 1 / 1.4 }, uSeed: { value: 101 + k * 17 }, uDry: DRY, uKr: KR };
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: RAIN_VS, fragmentShader: RAIN_FS, uniforms: u, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.frustumCulled = false; scene.add(m);
    return { m, u, base: l };
  });
  // 水滴（世界里算好屏幕位置传进来）：x, y, len, alpha
  const dropU = { uD: { value: Array.from({ length: 12 }, () => new THREE.Vector4()) }, uN: { value: 0 } };
  const dg = quads(12);
  const drop = new THREE.Mesh(dg, new THREE.ShaderMaterial({
    vertexShader: /* glsl */`attribute float aI; uniform vec4 uD[12]; uniform int uN; varying vec2 vQ; varying float vA;
      void main(){ int i = int(aI); vec4 d = uD[i]; float on = i < uN ? 1. : 0.; vec2 p = d.xy + vec2(position.x * 4., position.y * d.z); vQ = position.xy; vA = d.w * on; gl_Position = projectionMatrix * vec4(p.x, 1040. - p.y, 0., 1.); }`,
    fragmentShader: /* glsl */`varying vec2 vQ; varying float vA; void main(){ float a = (1. - smoothstep(.15, .5, abs(vQ.x))) * smoothstep(-.5, -.1, vQ.y) * (1. - smoothstep(.3, .5, vQ.y)); gl_FragColor = vec4(vA * a, 0., 0., 1.); }`,
    uniforms: dropU, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  drop.frustumCulled = false; scene.add(drop);
  return {
    scene, camera,
    set(t, { dens = 1, near = 1, mid = 1, far = 1, drops = [], dry = null } = {}) {
      if (dry) DRY.value.set(...dry); else DRY.value.set(0, 0, 0, 0);
      layers[0].u.uT.value = t; layers[1].u.uT.value = t; layers[2].u.uT.value = t;
      layers[0].u.uDens.value = clamp(dens * near / 1.4); layers[1].u.uDens.value = clamp(dens * mid / 1.4); layers[2].u.uDens.value = clamp(dens * far / 1.4);
      const n = Math.min(12, drops.length); dropU.uN.value = n;
      for (let i = 0; i < n; i++) dropU.uD.value[i].set(...drops[i]);
    },
  };
}

// ── 四芒星（S1b 镜片、T2 豹眼 / 镜片共用）：全屏四边形，加色、进 bloom ──
const STAR_FS = /* glsl */`
${GLSL_COMMON}
uniform vec2 uC; uniform float uArm, uCore, uHalo, uAmt, uK, uDW; uniform vec3 uCol;
varying vec2 vUv;
float arm(vec2 d, float L, float w){ L = max(L, 1e-2); float x = abs(d.x) / L; if (x > 1.) return 0.; float wid = w * (1. - x) + .6; return exp(-abs(d.y) / wid) * pow(1. - x, 2.2); }
void main(){
  vec2 p = vec2(vUv.x * uDW, (1. - vUv.y) * 1040.);
  vec2 d = p - uC; float r = length(d);
  float I = arm(d, uArm, 2.2) + arm(d.yx, uArm, 2.2);
  vec2 e = vec2(d.x + d.y, d.x - d.y) * .7071;
  I += .3 * (arm(e, uArm * .6, 1.8) + arm(e.yx, uArm * .6, 1.8));
  I += exp(-r * r / max(uCore * uCore, 1e-2)) * 1.6 + exp(-r * r / max(uHalo * uHalo, 1e-2)) * .28;
  gl_FragColor = vec4(uCol * I * uAmt, 1.);
}`;
export function makeStar() {
  const u = { uC: { value: new THREE.Vector2(...STAR_H) }, uArm: { value: 220 }, uCore: { value: 36 }, uHalo: { value: 140 }, uAmt: { value: 0 }, uK: { value: 1 }, uDW: { value: 1920 }, uCol: { value: lin3('#FFF6E0') } };
  const m = new THREE.Mesh(QUAD, new THREE.ShaderMaterial({
    vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * 2., 0., 1.); }`,
    fragmentShader: STAR_FS, uniforms: u, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  m.frustumCulled = false; m.renderOrder = 1000; m.userData.outline = false; m.userData.outlineOccluder = false;
  return { m, u, set(amt, arm = 220, core = 36, halo = 140, c = STAR_H) { u.uAmt.value = amt; u.uArm.value = arm; u.uCore.value = core; u.uHalo.value = halo; u.uC.value.set(c[0], c[1]); m.visible = amt > 1e-4; } };
}

// ── 镜片圈（S6 屏幕层；sRGB） ──
export function makeLensRing() {
  const u = { uE: { value: new THREE.Vector4(EYE_E.cx, EYE_E.cy, EYE_E.rx, EYE_E.ry) }, uTilt: { value: EYE_E.tilt * Math.PI / 180 }, uW: { value: 9 }, uA: { value: 0 }, uC: { value: srgb('#3A2E25') }, uHiC: { value: srgb('#4A3A22') } };
  const m = new THREE.Mesh(QUAD, new THREE.ShaderMaterial({
    vertexShader: /* glsl */`varying vec2 vP; void main(){ vP = position.xy * vec2(1920., 1040.) + vec2(960., 520.); gl_Position = projectionMatrix * modelViewMatrix * vec4(vP, 0., 1.); }`,
    fragmentShader: /* glsl */`${GLSL_COMMON} uniform vec4 uE; uniform float uTilt, uW, uA; uniform vec3 uC, uHiC; varying vec2 vP;
      void main(){ vec2 p = vec2(vP.x, 1040. - vP.y); float e = ellR(p, uE.xy, uE.zw, uTilt); float dist = abs(e - 1.) * min(uE.z, uE.w); float a = 1. - sst(uW * .5 - 1., uW * .5 + 1., dist);
        // 返修 story-10：镜片圈左缘补一段同色镜框和鼻梁，接到他的眼镜上
        vec2 b0 = uE.xy + vec2(-uE.z * .99, -uE.w * .12), b1 = uE.xy + vec2(-uE.z * 1.5, -uE.w * .02); vec2 ab = b1 - b0; float hb = clamp(dot(p - b0, ab) / dot(ab, ab), 0., 1.); float db = length(p - b0 - ab * hb) - (2.5 * uW / 9.) * (1. - .3 * hb);
        a = max(a, 1. - sst(-1., 1., db));
        vec2 d = normalize(p - uE.xy); float lit = sst(.3, .9, dot(d, normalize(vec2(.8, -.5)))); gl_FragColor = vec4(mix(uC, uHiC, lit), a * uA); }`,
    uniforms: u, transparent: true, depthTest: false, depthWrite: false }));
  m.frustumCulled = false; m.renderOrder = 5;
  return { m, u };
}

// ── 种子 7 那一枚光斑（返修 story-13 / self-07 第 2 轮）：屏幕层的"受光"叠加——不管下面是手还是书页都被照亮，
//    混合 = 底色 ×（1 + 光），所以是光而不是贴上去的色块。形状就是母题种子 7（与 S1a 墨环同形、同位）。
//    半径 40K、环宽约 8K，受光色 #FFE7B0；外圈一层淡淡的暖晕 ──
export function makeLightRing() {
  const u = { uC: { value: new THREE.Vector2(1180, 600) }, uR: { value: 40 }, uAmt: { value: 0 }, uPh: { value: new THREE.Vector4() }, uKk: { value: 5 }, uCol: { value: new THREE.Vector3(1, .906, .69) } };
  const FS = /* glsl */`${GLSL_COMMON} uniform vec2 uC; uniform float uR, uAmt, uKk, uMul; uniform vec4 uPh; uniform vec3 uCol; varying vec2 vP;
      void main(){
        vec2 p = vec2(vP.x, 1040. - vP.y);
        vec2 q = (p - uC) / uR;
        if (dot(q, q) > 9.) { gl_FragColor = vec4(0.); return; }
        vec2 mm = motif(q, uPh, uKk, .07, 1.);
        float l = mm.x + .35 * mm.y;
        float halo = (1. - sst(.6, 2.2, length(q))) * .18;
        gl_FragColor = vec4(uCol * (l * .9 + halo) * uAmt * uMul, 1.);
      }`;
  const VS = /* glsl */`varying vec2 vP; void main(){ vP = position.xy * vec2(1920., 1040.) + vec2(960., 520.); gl_Position = projectionMatrix * modelViewMatrix * vec4(vP, 0., 1.); }`;
  // ① 乘亮：底色 ×（1 + 光）；② 加色（弱）：暗处（桌面）也看得见光
  const mk = (mul, blend) => new THREE.Mesh(QUAD, new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: { ...u, uMul: { value: mul } }, transparent: true, depthTest: false, depthWrite: false, ...blend }));
  const m1 = mk(1, { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.OneFactor });
  const m2 = mk(.5, { blending: THREE.AdditiveBlending });   // 第 3 轮（self-07）：加色一层 .22 → .5，落在暗桌面上的那半圈也读得出是光
  m1.renderOrder = 20; m2.renderOrder = 21; m1.frustumCulled = m2.frustumCulled = false;
  const g = new THREE.Group(); g.add(m1, m2);
  return { m: g, u };
}

// ── 字幕：竖排书法「君子豹变 其文蔚也」（马善政楷书），竖向擦除洇出（fbm 毛边、软边） ──
export function makeSubtitle(W, H, K) {
  // 返修 story-08 / tech-11：字号 78K → 92K、字距 92K → 104K；「君子豹变」改用马善政楷书（"豹""变"不会被读成"约""支"）
  // 第 4 轮（main3-01 / qa2-10，主会话决定）：「其文蔚也」也改成马善政楷书——两列同一种字、同一字号墨色、同样的洇出节奏，不再像两个人合写
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const cols = [{ text: '君子豹变', x: 330, y: 214, font: 'MSZ' }, { text: '其文蔚也', x: 222, y: 266, font: 'MSZ' }];
  g.clearRect(0, 0, W, H);
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (const c of cols) {
    g.font = `${92 * K}px ${c.font}`;
    [...c.text].forEach((ch, i) => {
      g.shadowColor = 'rgba(242,238,227,.25)'; g.shadowBlur = 1.5 * K * 4;
      g.fillStyle = 'rgba(242,238,227,1)';
      g.fillText(ch, c.x * K, (c.y + i * 104) * K);
    });
  }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.NoColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  const u = { map: { value: tex }, uRev: { value: new THREE.Vector2() }, uA: { value: 0 }, uCol: { value: new THREE.Vector4(330, 214, 222, 266) } };
  const m = new THREE.Mesh(QUAD, new THREE.ShaderMaterial({
    vertexShader: /* glsl */`varying vec2 vUv, vP; void main(){ vUv = uv; vP = position.xy * vec2(1920., 1040.) + vec2(960., 520.); gl_Position = projectionMatrix * modelViewMatrix * vec4(vP, 0., 1.); }`,
    fragmentShader: /* glsl */`${GLSL_COMMON} uniform sampler2D map; uniform vec2 uRev; uniform float uA; uniform vec4 uCol; varying vec2 vUv, vP;
      void main(){
        vec2 p = vec2(vP.x, 1040. - vP.y);
        vec4 t = texture2D(map, vUv);
        float c1 = 1. - sst(30., 80., abs(p.x - uCol.x)), c2 = 1. - sst(30., 80., abs(p.x - uCol.z));
        float n = 10. * fbm(p / 26., 77u) * 2.;
        float y1 = uCol.y - 20. + uRev.x * 470., y2 = uCol.w - 20. + uRev.y * 470.;
        float m1 = 1. - sst(-6., 6., p.y - y1 + n), m2 = 1. - sst(-6., 6., p.y - y2 + n);
        float m = max(c1 * m1 * sst(0., .35, uRev.x), c2 * m2 * sst(0., .35, uRev.y));
        gl_FragColor = vec4(t.rgb, t.a * m * uA * .9);
      }`,
    uniforms: u, transparent: true, depthTest: false, depthWrite: false }));
  m.frustumCulled = false; m.renderOrder = 50;
  return { m, u };
}
