// 《豹变》D 雾山 · 面具集市（MARKET，梦境空间）：#05 墨甩入市、#06 递面具、#07 抬手又放下、#08 转身入雾、#09 穿过眼孔
// 相机在原点附近，巷子朝 −z。远 → 近：集市底板（30 m）→ 挂面具（5 条悬链线，5–25 m，真视差）→ 人群剪影（4 / 6 / 9 m）→ 金芒、金箔
import * as THREE from 'three';
import { setToonGlobals } from '../lib/toond.js';
import { makeSprite, faceCam, rimOffset } from '../lib/sprite.js';
import { fogSheet, glow, onScreen } from '../lib/env.js';
import { GLSL } from '../lib/glsl.js';
import { DEG, clamp, lerp, seg, ss, ss5, eo, ei, eio, aim, s2w, w2s, pxPerM, lin3, hashi, hash2, vn1, mixHex, track, monotone } from '../lib/util.js';

const VS_UV = /* glsl */`varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

// 底板（可模糊、压暗）
const PLATE_FS = /* glsl */`
${GLSL}
uniform sampler2D uMap; uniform float uBias, uDark, uA; uniform vec3 uMul;
varying vec2 vUv;
void main(){ vec3 c = srgb2lin(texture2D(uMap, vUv, uBias).rgb) * uMul * (1. - uDark); gl_FragColor = vec4(c, uA * smoothstep(0., .1, vUv.x) * smoothstep(1., .9, vUv.x)); }`;   // 左右两端化掉：甩镜时和背景筒之间没有竖直硬边

// 挂面具（实例）：贴图 + 金芒（每枚亮 2 帧，只在浮雕亮部）
const MASKI_VS = /* glsl */`
attribute vec4 aInfo;   // x 种子, y 摆相位, z 大小, w 层
uniform float uT, uF2;
varying vec2 vUv; varying vec4 vInfo; varying vec3 vW;
void main(){
  vUv = uv; vInfo = aInfo;
  float sw = sin(uT * 6.2832 * .6 + aInfo.y) * 4. * 3.14159 / 180.;
  vec3 p = position; float c = cos(sw), s = sin(sw);
  p.xy = vec2(c * p.x - s * (p.y - .5), s * p.x + c * (p.y - .5)) + vec2(0., .5);
  vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const MASKI_FS = /* glsl */`
${GLSL}
uniform sampler2D uMap; uniform float uT, uF2, uDark;
varying vec2 vUv; varying vec4 vInfo; varying vec3 vW;
void main(){
  vec4 c = texture2D(uMap, vUv);
  if (c.a < .5) discard;
  vec3 col = srgb2lin(c.rgb) * (1. - uDark);
  float l = lumS(c.rgb);
  // 金芒：按种子 + 两帧时隙哈希，只在亮部
  float slot = floor(uF2 / 2.);
  float h = hash12(vec2(vInfo.x * 17.3, slot));
  vec2 sp = vec2(hash12(vec2(vInfo.x, slot + 3.)), hash12(vec2(slot, vInfo.x + 7.)));
  float d = length(vUv - (sp * .7 + .15));
  float star = step(.72, h) * (1. - smoothstep(0., .05, d)) * smoothstep(.55, .75, l);
  col += vec3(1., .85, .45) * star * 3.;
  gl_FragColor = vec4(col, 1.);
}`;

// 人群剪影（返修 1）：戴宽沿斗笠、披蓑衣的背影——蓑衣下摆是一排毛边，肩背不对称，斗笠沿宽而平；朝光一侧 2·K 金边
const CROWD_FS = /* glsl */`
${GLSL}
uniform vec3 uCol, uRim; uniform float uHat, uSeed, uSoft, uA, uRimA, uWin;
varying vec2 vUv;
float sdBody(vec2 p){
  // p：x −0.5..0.5，y 0..1（脚在 0）
  float sk = (hash12(vec2(uSeed, 3.)) - .5) * .12;                       // 肩背不对称
  float yy = clamp(p.y / .74, 0., 1.);
  float halfW = mix(.36, .2, pow(yy, 1.3)) + (p.x > 0. ? sk : -sk) * yy;  // 蓑衣：上窄下宽
  float fringe = (vnoise2(vec2(p.x * 60. + uSeed * 7., p.y * 4.)) - .5) * .05;   // 毛边
  float cape = max(abs(p.x + sk * .3) - halfW - fringe, max(p.y - .76 - fringe * .4, .02 - p.y + fringe * (1. - yy)));
  float hd = length((p - vec2(sk * .2, .83)) * vec2(1., 1.15)) - .11;
  float hat = uHat > .5 ? max(abs(p.x - sk * .2) - (.34 - (p.y - .86) * 2.4), abs(p.y - .9) - .045) : 1.;    // 宽沿斗笠
  return min(min(cape, hd), hat);
}
void main(){
  vec2 p = vec2(vUv.x - .5, vUv.y);
  float d = sdBody(p);
  float aa = max(fwidth(d), 1e-3) + uSoft;
  float a = 1. - smoothstep(-aa, aa, d);
  float dUp = sdBody(p + vec2(-.018, .025));
  float rim = (1. - smoothstep(-aa, aa, d)) * smoothstep(-aa, aa, dUp) * smoothstep(.35, .9, p.y);
  vec3 c = mix(uCol, uRim, rim * uRimA);
  // 返修 3（v2-01）：特写背景里剪影很糊（uSoft 大），糊开的部分会被面片的边截出直边——四边各留一圈渐隐
  a *= mix(1., smoothstep(0., .16, vUv.x) * smoothstep(1., .84, vUv.x) * smoothstep(0., .14, vUv.y) * smoothstep(1., .9, vUv.y), uWin);
  gl_FragColor = vec4(c, a * uA);
}`;

// 湿石板地（#08）：不规则的暗色石板（Voronoi 抖动、大小 0.4–1.2 m、缺角、裂缝），缝是暗档里断续的干笔；
//   身后金光只落成 2–3 道顺着前进方向拉长的湿面反光（其余保持暗），远处化进雾色——没有硬地平线
const FLOOR_FS = /* glsl */`
${GLSL}
uniform float uGold, uT; uniform vec3 uA1, uA2, uFogC, uCylA, uCylB, uCylG, uCylB2; uniform vec2 uBack;
varying vec2 vUv; varying vec3 vW;
vec3 vor(vec2 q){
  vec2 gi = floor(q), gf = fract(q); float d1 = 8., d2 = 8.; vec2 id = vec2(0.);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j)); vec2 h = hash22(gi + o);
    vec2 r = o + .5 + (h - .5) * .9 - gf; float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = gi + o; } else if (d < d2) d2 = d;
  }
  return vec3(sqrt(d2) - sqrt(d1), id);
}
void main(){
  vec2 w = vW.xz + (vec2(vnoise2(vW.xz * 1.3), vnoise2(vW.xz * 1.3 + 7.)) - .5) * .2;
  float sz = .7 + .7 * vnoise2(vW.xz * .18);
  vec3 v = vor(w / sz);
  float h = hash12(v.yz);
  vec3 c = mix(uA1, uA2, step(.45, h));
  // 返修 3（v2-06）：石面上一层顺着石板走向的干笔纹（不再是平涂的色块）
  float dry = vnoise2(w * vec2(9., 2.2) + v.yz * 3.1) * .6 + vnoise2(w * vec2(26., 5.) + v.yz) * .4;
  c *= .86 + .26 * smoothstep(.25, .8, dry);
  float aa = fwidth(v.x) * 1.5 + .004;
  float seam = (1. - smoothstep(.015, .035 + aa, v.x)) * smoothstep(.35, .6, vnoise2(vW.xz * 5. + 3.));
  float crack = (1. - smoothstep(.0, .008 + aa, abs(vnoise2(w * 2.2 + v.yz) - .5))) * step(.8, hash12(v.yz + 9.)) * .7;
  c = mix(c, uA2 * .55, max(seam, crack));
  vec2 fw = uBack, sd = vec2(-uBack.y, uBack.x);
  vec2 rel = vW.xz - cameraPosition.xz;
  float ahead = dot(rel, fw), lat = dot(rel, sd);
  // 湿面反光：三道窄的、顺着前进方向拉长的金光（中间那道被他的影子切开），其余保持暗
  // 返修 3（v2-06）：身后的金光不再是三道"车道线"，合成一片柔和的余光，被湿石面打碎成不规则的亮块
  float refl = exp(-pow(lat / 1.5, 2.)) * .55;
  float brk = vnoise2(vec2(lat * 1.3, ahead * .55) + 3.) * .55 + vnoise2(w * 1.7 + 9.) * .45;
  refl *= smoothstep(-.5, 1.5, ahead) * exp(-max(ahead, 0.) / 4.5) * smoothstep(.46, .76, brk);
  c += vec3(.86, .56, .18) * refl * uGold * .7 * (1. - seam * .7);
  // 远处化进雾色：返修 2——化进的就是同一视线方向上背景筒的颜色（和背景筒同一个公式），地面远端和背景之间没有地平线
  vec3 dv = normalize(vW - cameraPosition); float yaw = atan(-dv.x, -dv.z) * 57.2958;
  vec3 cf = mix(uCylA + uCylG * (1. - smoothstep(0., 40., abs(yaw))) * .6, uCylB, smoothstep(25., 115., yaw)) * mix(.85, 1., smoothstep(-.3, .2, dv.y));
  c = mix(c, cf, smoothstep(5., 16., length(rel)));
  gl_FragColor = vec4(c, 1.);
}`;

// 他的影子（#08）：人形剪影（头、肩、两腿交替，一拍二）从画面下缘伸进雾里；硬边、暗、α 0.7
const SHADOW_FS = /* glsl */`
${GLSL}
uniform float uA, uStride; varying vec2 vUv;
// 返修 3（v2-06）：影子不再是方块 + 胶囊拼的几何小人——一笔画成的人形（溶在一起的软胶囊：腿收向脚、窄腰宽肩、手臂垂着、头略长），
//   边是手绘的毛边，一侧硬一侧虚，越往远（头）越淡越虚
float sdSeg(vec2 p, vec2 a, vec2 b, float r0, float r1){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.); return length(pa - ba * h) - mix(r0, r1, h); }
float smin(float a, float b, float k){ float h = clamp(.5 + .5 * (b - a) / k, 0., 1.); return mix(b, a, h) - k * h * (1. - h); }
void main(){
  vec2 p = vec2(vUv.x - .5, vUv.y);
  float s = uStride;
  float legL = sdSeg(p, vec2(-.045 + s * .045, .0), vec2(-.04, .42), .038, .058);
  float legR = sdSeg(p, vec2(.045 - s * .045, .0), vec2(.04, .42), .038, .058);
  float torso = sdSeg(p, vec2(0., .44), vec2(0., .73), .105, .145);
  float sh = sdSeg(p, vec2(-.135, .735), vec2(.14, .745), .042, .04);
  float armL = sdSeg(p, vec2(-.15, .73), vec2(-.165 - s * .02, .5), .036, .03);
  float armR = sdSeg(p, vec2(.155, .73), vec2(.17 + s * .02, .5), .036, .03);
  float head = length((p - vec2(.005, .855)) * vec2(1., .7)) - .066;
  float d = smin(smin(legL, legR, .03), torso, .06);
  d = smin(d, sh, .05); d = smin(d, armL, .025); d = smin(d, armR, .025); d = smin(d, head, .035);
  d += (vnoise2(p * vec2(46., 20.)) - .5) * .014 + (vnoise2(p * vec2(140., 50.)) - .5) * .005;
  float soft = mix(.004, .045, smoothstep(-.12, .2, p.x)) * (.55 + .9 * p.y);
  float a = (1. - smoothstep(-soft, soft, d)) * smoothstep(0., .03, vUv.y) * (1. - .5 * smoothstep(.45, 1., p.y));
  gl_FragColor = vec4(.0045, .0075, .0066, a * uA);
}`;

// 金箔：翻转时闪
const LEAF_FS = /* glsl */`
uniform float uFlash; varying vec2 vUv; varying vec3 vW;
void main(){ vec2 d = abs(vUv - .5) * 2.; float a = 1. - smoothstep(.75, 1., max(d.x, d.y * 1.4)); vec3 c = mix(vec3(.55, .32, .06), vec3(1., .86, .42), uFlash); gl_FragColor = vec4(c * (1. + uFlash * 1.5), a); }`;

export function buildMarket(ctx) {
  const { W, H, K, tex, M } = ctx;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(50, W / H, .01, 400);
  const key = new THREE.DirectionalLight('#ffffff', 1); scene.add(key, key.target);
  const tag = (m, order, occ = false) => { m.renderOrder = order; m.frustumCulled = false; m.userData.outline = false; m.userData.outlineOccluder = occ; return m; };

  // ── 集市底板（A13）──
  const plU = { uMap: { value: tex.market }, uBias: { value: 0 }, uDark: { value: 0 }, uA: { value: 1 }, uMul: { value: new THREE.Vector3(1, 1, 1) } };
  const plate = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: plU, vertexShader: VS_UV, fragmentShader: PLATE_FS, depthWrite: false, transparent: true })), 0);
  plate.userData.aspect = tex.market.image.width / tex.market.image.height;
  scene.add(plate);

  // ── 挂面具：5 条悬链线，每条 14–18 枚 ──
  const NM = 80;
  const mGeo = new THREE.PlaneGeometry(1, 1); mGeo.translate(0, -.5, 0);   // 挂点在上沿
  const info = new Float32Array(NM * 4);
  const mi = new THREE.InstancedMesh(mGeo, new THREE.ShaderMaterial({ uniforms: { uMap: { value: tex.mask }, uT: { value: 0 }, uF2: { value: 0 }, uDark: { value: 0 } }, vertexShader: MASKI_VS, fragmentShader: MASKI_FS }), NM);
  {
    const strings = [[5, 3.0, 14], [8.5, 3.5, 15], [12.5, 3.9, 16], [17.5, 4.3, 17], [24, 4.7, 18]];
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(); let k = 0;
    strings.forEach(([D, y, n], si) => {
      const span = 3.2 + si * .35;
      for (let j = 0; j < n && k < NM; j++, k++) {
        const u = (j + .5) / n, x = lerp(-span, span, u);
        const sag = .12 * span * (1 - Math.pow(2 * u - 1, 2));
        const sz = (.32 + .26 * hashi(k * 7 + 3)) * (1 + si * .12);
        e.set(0, (hashi(k * 13) - .5) * 50 * DEG, 0);
        q.setFromEuler(e);
        mtx.compose(new THREE.Vector3(x, y - sag, -D), q, new THREE.Vector3(sz, sz * 1115 / 1268, 1));
        mi.setMatrixAt(k, mtx);
        info.set([k * 1.37 + .3, hashi(k * 5) * 6.28, sz, si], k * 4);
      }
    });
    mGeo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 4));
    mi.instanceMatrix.needsUpdate = true;
  }
  tag(mi, 2, false); scene.add(mi);
  // 挂绳（细暗线）
  const ropeMat = new THREE.LineBasicMaterial({ color: 0x160b02 });
  const ropes = [];
  [[5, 3.0], [8.5, 3.5], [12.5, 3.9], [17.5, 4.3], [24, 4.7]].forEach(([D, y], si) => {
    const span = 3.2 + si * .35, pts = [];
    for (let i = 0; i <= 30; i++) { const u = i / 30, x = lerp(-span - .6, span + .6, u); pts.push(new THREE.Vector3(x, y - .12 * span * (1 - Math.pow(2 * u - 1, 2)) + .02, -D)); }
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ropeMat); l.renderOrder = 1.9; l.userData.outline = false; scene.add(l); ropes.push(l);
  });

  // ── 人群剪影：3 层深度 4 / 6 / 9 m，右 → 左横穿 ──
  const crowd = [];
  for (let i = 0; i < 14; i++) {
    const L = i % 3, D = [4, 6, 9][L];
    const u = { uCol: { value: lin3('#141C1A') }, uRim: { value: lin3('#C9A24A') }, uHat: { value: hashi(i * 3 + 1) > .3 ? 1 : 0 }, uSeed: { value: i }, uSoft: { value: [.05, .025, .01][L] }, uA: { value: 1 }, uRimA: { value: 1 }, uWin: { value: 0 } };
    const m = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS_UV, fragmentShader: CROWD_FS, transparent: true, depthWrite: false })), 6 - L * .5, 'soft');
    m.geometry.translate(0, .5, 0);
    m.userData = { ...m.userData, u, L, D, h: [1.7, 1.65, 1.6][L] * (.92 + .16 * hashi(i * 11)), ph: hashi(i * 17) * 40, spd: [3, 2, 1.2][L] };
    scene.add(m); crowd.push(m);
  }

  // ── 金箔 40 片 ──
  const leaves = [];
  for (let i = 0; i < 40; i++) {
    const u = { uFlash: { value: 0 } };
    const m = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS_UV, fragmentShader: LEAF_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide })), 7);
    m.userData = { ...m.userData, u, s0: hashi(i * 7 + 2), s1: hashi(i * 13 + 5), s2: hashi(i * 29 + 1) };
    scene.add(m); leaves.push(m);
  }
  // 金色散景（#06、#07 背景虚化）
  const bokeh = [...Array(30)].map((_, i) => { const g = glow('#F0C36A', { order: 1.2, a: .5, core: .9 }); g.userData.s = [hashi(i * 3), hashi(i * 5 + 1), hashi(i * 7 + 2)]; scene.add(g); return g; });

  // ── 面具特写（A10）+ 摊主的手（A09）+ 陆蔚的手（A08）──
  const mask = makeSprite(tex.mask, null, { mode: 0, order: 10 });
  mask.setRect([0, 0, tex.mask.image.width, tex.mask.image.height]);
  const vendor = makeSprite(tex.vendor, null, { mode: 2, order: 11 });
  vendor.setRect([0, 0, tex.vendor.image.width, tex.vendor.image.height]); vendor.u.uHT.value.set(.45, .3);
  const hand = makeSprite(tex.handsSide, null, { mode: 2, order: 12 });
  hand.u.uHT.value.set(.62, .5);
  scene.add(mask.group, vendor.group, hand.group);
  // 面具上的高光扫 + 金钉明灭：用一个加色面片叠在面具上（同一变换）
  const SWEEP_FS = /* glsl */`
  ${GLSL}
  uniform sampler2D uMap; uniform float uSweep, uF2, uOn;
  varying vec2 vUv;
  void main(){
    vec4 c = texture2D(uMap, vUv); float l = lumS(c.rgb);
    float hi = smoothstep(.55, .8, l) * c.a;
    float s = dot(vUv - .5, normalize(vec2(1., .4)));
    float band = exp(-pow((s - uSweep) / .06, 2.)) * hi * .5;
    // 8 个金芒在金钉上一拍二明灭
    float st = 0.;
    for (int i = 0; i < 8; i++) { float fi = float(i); vec2 p = vec2(hash12(vec2(fi, 3.)), hash12(vec2(7., fi))) * .7 + .15; float on = step(.5, hash12(vec2(fi, floor(uF2 / 2.)))); st += on * (1. - smoothstep(0., .03, length(vUv - p))) * hi; }
    gl_FragColor = vec4(vec3(1., .94, .75) * band * uOn + vec3(1., .85, .45) * st * 2. * uOn, 1.);
  }`;
  const sweep = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: { uMap: { value: tex.mask }, uSweep: { value: -1 }, uF2: { value: 0 }, uOn: { value: 0 } }, vertexShader: VS_UV, fragmentShader: SWEEP_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })), 10.5);
  scene.add(sweep);

  // ── #08：雾墙、湿石板地、影子 ──
  const fogWall = [8, 12, 18, 28].map((D, i) => { const f = fogSheet({ w: [14, 22, 34, 56][i], h: [8, 12, 18, 30][i], col: '#9FB0B6', colTop: '#BFCBCB', op: [.5, .7, .85, 1][i], seed: 60 + i, top: [.62, .7, .78, .9][i], ns: [2.2, 3.5, 5, 8][i], order: 4.8 - i * .3, tear: .3, dens: [.0, .05, .12, .25][i], bot: .25, tearA: .15 }); f.userData.D = D; scene.add(f); return f; });
  const floorU = { uGold: { value: 1 }, uT: { value: 0 }, uA1: { value: lin3('#182320') }, uA2: { value: lin3('#0F1614') }, uFogC: { value: lin3('#A3B3B8') }, uBack: { value: new THREE.Vector2(-Math.sin(130 * DEG), -Math.cos(130 * DEG)) },
    uCylA: { value: lin3('#182320') }, uCylB: { value: lin3('#A3B3B8') }, uCylG: { value: lin3('#5A4418') }, uCylB2: { value: lin3('#C3CFCF') } };
  const floor = tag(new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShaderMaterial({ uniforms: floorU, vertexShader: VS_UV, fragmentShader: FLOOR_FS })), .5, 'solid');
  floor.rotation.x = -Math.PI / 2; scene.add(floor);
  const shadowU = { uA: { value: 1 }, uStride: { value: 0 } };
  const shadow = tag(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: shadowU, vertexShader: VS_UV, fragmentShader: SHADOW_FS, transparent: true, depthWrite: false })), 1);
  shadow.rotation.x = -Math.PI / 2; scene.add(shadow);

  // 甩镜的背景筒（#08）：围着相机一圈，按方位角从集市的暗青金（0°）过渡到雾色（130°），甩到哪里都不露出场景外的黑
  const cylU = { uA: { value: lin3('#182320') }, uB: { value: lin3('#A3B3B8') }, uGoldC: { value: lin3('#5A4418') }, uMode: { value: 0 } };
  // 返修 2：背景筒写深度——look 的雾按真实距离（90 m）同样加在背景筒和地面远端上，两者交界不再有一道地平线
  const cyl = tag(new THREE.Mesh(new THREE.CylinderGeometry(90, 90, 120, 64, 1, true), new THREE.ShaderMaterial({ uniforms: cylU, side: THREE.BackSide, depthWrite: true,
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform vec3 uA, uB, uGoldC; uniform float uMode; varying vec3 vW; void main(){ vec3 d = normalize(vW - cameraPosition); float yaw = atan(-d.x, -d.z) * 57.2958;
      if (uMode > .5) {
        // 返修 3（v2-01）：#09 的兜底——集市的暗青（#0F1614 → #182320），灭点一带透一点金雾，往上略亮；不是纯黑
        float g = exp(-pow(yaw / 38., 2.)) * exp(-pow((d.y - .05) / .32, 2.));
        vec3 c9 = mix(vec3(.0052, .0080, .0070), uA, smoothstep(-.45, .25, d.y)) + uGoldC * g * .55;
        gl_FragColor = vec4(c9, 1.); return;
      }
      float k = smoothstep(25., 115., yaw); vec3 c = mix(uA + uGoldC * (1. - smoothstep(0., 40., abs(yaw))) * .6, uB, k); c *= mix(.85, 1., smoothstep(-.3, .2, d.y));
      c = mix(c, vec3(.55, .62, .62), smoothstep(.02, .45, d.y) * k * .5);   // 雾的尽头往上慢慢变亮（原来那张竖板的渐变）
      gl_FragColor = vec4(c, 1.); }` })), -2);
  scene.add(cyl);
  // #08 雾的尽头：一张竖直的渐变背景（冷灰雾色）
  const fogBackU = { uLow: { value: lin3('#A3B3B8') }, uHigh: { value: lin3('#C3CFCF') } };
  const fogBack = tag(new THREE.Mesh(new THREE.PlaneGeometry(260, 80), new THREE.ShaderMaterial({ uniforms: fogBackU, vertexShader: VS_UV,
    fragmentShader: 'uniform vec3 uLow, uHigh; varying vec2 vUv; void main(){ gl_FragColor = vec4(mix(uLow, uHigh, smoothstep(.3, .8, vUv.y)), 1.); }', depthWrite: false })), -1);
  scene.add(fogBack);
  // 眼孔（给总合成）：屏幕设计像素
  const hole = { cx: 960, cy: 520, a: 100, b: 45, tilt: 0, on: 0 };
  const L = M.mask.holes.left;
  // 面具在 #06 / #07 / #09 的摆放（屏幕设计像素中心、宽、深度、屏内旋转）
  const mask06 = track([[270, [1400, 760, .72, 0]], [272, [1180, 600, .88, -4]], [274, [1000, 490, 1.03, 2]], [276, [960, 470, 1.04, 1]], [278, [960, 470, 1, 0]]]);
  const pushDist = monotone([[334, 1.2], [338, 1.05], [341, .8], [343, .5], [344, .31], [345, .19], [346, .11], [347, .045]]);
  const hand07 = track([[290, [720, 1260]], [292, [770, 1080]], [294, [835, 905]], [296, [895, 770]], [298, [935, 700]], [305, [935, 700]], [306, [915, 770]], [308, [860, 900]], [309, [790, 1090]]]);

  function placeMask(c, cx, cy, wpx, D, rot) {
    faceCam(mask, c, cx, cy, wpx / mask.aspect, D, { rot });
    sweep.position.copy(mask.group.position); sweep.quaternion.copy(mask.group.quaternion); sweep.scale.copy(mask.group.scale); sweep.translateZ(.002);
    // 摊主的手：三根指尖托住面具下沿（画在面具前面）
    const hs = wpx / 1268 * 1.05;           // 手图像素 → 屏幕设计像素
    const rimY = cy + (M.mask.rim[1] - 557.5) * wpx / 1268 * .96;
    const sl = M.vendor.support_line[1];
    const vx = cx + 60 * hs - (sl[0] - 1469 / 2) * hs, vy = rimY - (sl[1] - 897 / 2) * hs - 6 * hs;
    faceCam(vendor, c, vx, vy, 897 * hs, D * .96, { rot });
  }
  // 眼孔屏幕参数：按面具的屏幕中心、宽、旋转
  function setHole(cx, cy, wpx, rot) {
    const s = wpx / 1268, cr = Math.cos(-rot * DEG), sr = Math.sin(-rot * DEG);
    const ox = (L.center.px[0] - 634) * s, oy = (L.center.px[1] - 557.5) * s;
    hole.cx = cx + cr * ox - sr * oy; hole.cy = cy + sr * ox + cr * oy;
    hole.a = L.w_px / 2 * s * .98; hole.b = L.h_px / 2 * s * .95; hole.tilt = (L.tilt_deg - rot) * DEG;
  }

  const st = { hole };
  function update(t, f, shot) {
    const fr = t * 24, f2 = f - (f % 2);
    const vis = (o, v) => { o.visible = v; };
    // 每帧先把跨镜头会被改的量复位（render(t) 只取决于 t，和前一帧渲的是哪一帧无关）
    mask.u.uBlur.value = .4; mask.u.uOpacity.value = 1;
    cyl.visible = shot === 8 || shot === 9; cyl.position.set(0, 0, 0); cyl.scale.set(1, shot === 9 ? 2.5 : 1, 1); cylU.uMode.value = shot === 9 ? 1 : 0;
    const closeup = shot >= 6;
    // 返修 2（v1-09）：特写（虚化背景）里不画挂绳，免得一根清晰细线压在虚化的背景上
    // 返修 3：下面这两句原来被写进了上一行的注释里、从没执行过（人群在 #08 走进雾后仍在、金箔在 #07 / #09 也在飘）
    vis(mi, shot === 5 || shot === 8); ropes.forEach(l => l.visible = shot === 5 || shot === 8);
    crowd.forEach(c => c.visible = !(shot === 8 && fr > 318)); leaves.forEach(l => l.visible = shot === 5 || shot === 6 || shot === 8);
    mask.visible(shot === 6 || shot === 7 || shot === 9); vendor.visible(shot === 6 || shot === 7 || shot === 9); hand.visible(shot === 7); sweep.visible = shot === 6;
    fogWall.forEach(fw => fw.visible = shot === 8); floor.visible = shot === 8 && fr >= 313.5;   // 甩镜前半是集市自己画的地面，不再叠一块 3D 地面出一道硬地平线
    // 返修 2（v1-12）：这两句原来写在上一行的注释里，从没执行过
    shadow.visible = shot === 8 && fr >= 316; fogBack.visible = false;
    // 返修 2（v1-07）：#09 不再放雾片（它们在虚化的集市背景上留下 4 条横贯全幅的硬接缝），集市变暗交给底板压暗和调色    // 雾的尽头交给背景筒（背景筒自己带往上变亮的渐变），不再另放一张竖板
    bokeh.forEach(b => b.visible = shot === 6 || shot === 7 || shot === 9 || (shot === 8 && fr < 326));
    let pos = [0, 1.6, 0], yaw = 0, pitch = 2, roll = 0, fov = 50;
    if (shot === 5) {
      const u = eo(seg(fr, 254, 270));
      pos = [0, 1.6, -6 * u]; fov = lerp(50, 46, u); roll = lerp(-3, 0, u);
      const sh = 3 / 1040 * 2 * Math.tan(fov * DEG / 2);   // ±3·K px 的手持抖（5 Hz 低频噪声）
      pos[0] += (vn1(t * 5, 1) - .5) * 2 * sh * 1.5; pos[1] += (vn1(t * 5, 2) - .5) * 2 * sh * 1.5;
    } else if (shot === 6 || shot === 7) {
      pos = [0, 1.6, -2]; fov = shot === 6 ? 34 : 30 * (1 - .04 * ss(seg(fr, 290, 298))); pitch = 0;
      pos[0] += (vn1(t * 4, 3) - .5) * .004; pos[1] += (vn1(t * 4, 4) - .5) * .004;
    } else if (shot === 8) {
      if (fr < 316) { yaw = 130 * eio(seg(fr, 310, 316)); pos = [0, 1.6, -2]; fov = 31; pitch = 0; }
      else { const d = 1.4 * (fr - 316) / 24; yaw = 130; const dir = [-Math.sin(130 * DEG), -Math.cos(130 * DEG)]; pos = [dir[0] * d, 1.6 + .045 * Math.abs(Math.sin(Math.PI * (fr - 316) / 8)), -2 + dir[1] * d]; roll = .6 * Math.sin(Math.PI * (fr - 316) / 8); fov = 31; pitch = lerp(-2, -21, ss(seg(fr, 314, 321))); }
    } else if (shot === 9) {
      // 客观镜头：面具仍被摊主举着；相机从 1.2 m 冲进眼孔（越来越快，最后三帧每帧近一半），vFOV 35 → 62；六次顿挫
      const u = seg(fr, 334, 347);
      let dist = pushDist(fr);
      const hits = [336, 338, 340, 342, 344, 346];
      for (const h of hits) if (fr >= h && fr < h + 1) dist *= h === 342 ? .9 : .95;
      fov = lerp(35, 62, ss(u));
      const fwd = new THREE.Vector3(0, Math.sin(2 * DEG), -Math.cos(2 * DEG));
      const p0 = new THREE.Vector3(0, 1.6, -1.4).addScaledVector(fwd, 1.2 - dist);
      pos = p0.toArray(); pitch = 2;
      let shx = 0, shy = 0; for (const h of hits) if (Math.abs(fr - h) < .6) { shx = (hashi(h) - .5) * 12; shy = (hashi(h + 9) - .5) * 12; }
      st.shake = [shx, shy];
      yaw += -shx / 520 * fov * .5; pitch += shy / 520 * fov * .5;
    }
    cam.fov = fov; cam.updateProjectionMatrix(); aim(cam, pos, yaw, pitch, roll);

    // 底板：巷尾金雾 (1020, 445) 对到灭点 (1000, 430)
    if (shot === 5 || (shot === 8 && fr < 318)) {
      const ref = new THREE.PerspectiveCamera(50, W / H, .01, 400); aim(ref, [0, 1.6, 0], 0, 2); ref.updateProjectionMatrix();
      const wp = 2150, hp = wp / plate.userData.aspect;
      onScreen(plate, ref, 1000 - (1020 / 1668 - .5) * wp, 430 - (445 / 943 - .5) * hp, wp, 30);
      plU.uBias.value = 0; plU.uDark.value = 0; plU.uMul.value.set(1, 1, 1); plate.visible = true;
    } else if (shot === 6 || shot === 7 || shot === 9) {
      // 背景虚化（两级下采样模糊 ≈ mip 偏移）+ 压暗
      const ref = new THREE.PerspectiveCamera(34, W / H, .01, 400); aim(ref, [0, 1.6, -2], 0, 0); ref.updateProjectionMatrix();
      // 返修 3（v2-01）：#09 相机冲向面具时 vFOV 35° → 62°，底板按末帧视锥放大到 5000 px 当量（居中），始终超出画框
      const wp = shot === 9 ? 5000 : 2400, hp = wp / plate.userData.aspect;
      if (shot === 9) onScreen(plate, ref, 960, 520 - (445 / 943 - .5) * hp * .4, wp, 30);
      else onScreen(plate, ref, 960 - (1020 / 1668 - .5) * wp * .6, 520 - (445 / 943 - .5) * hp * .4, wp, 30);
      plU.uBias.value = 4.2; plU.uDark.value = shot === 7 ? .5 : .4;
      if (shot === 9) plU.uDark.value = lerp(.4, .55, seg(fr, 334, 340));
      plate.visible = true;
    } else plate.visible = shot === 8;
    if (shot === 8 && fr >= 318) plate.visible = false;
    if (shot === 8 || shot === 9) {
      const dir = new THREE.Vector3(-Math.sin(130 * DEG), 0, -Math.cos(130 * DEG));
      fogWall.forEach((fw, i) => {
        const D = fw.userData.D, base = shot === 8 ? new THREE.Vector3(0, 0, -2) : new THREE.Vector3(0, 0, -2.6);
        const d = shot === 8 ? dir : new THREE.Vector3(0, 0, -1);
        fw.position.copy(base).addScaledVector(d, shot === 8 ? D + .5 : D * .3 + .4); fw.position.y = shot === 8 ? fw.geometry.parameters.height * .5 - 1.2 : 1.6 + i * .2;
        fw.rotation.set(0, Math.atan2(-d.x, -d.z), 0);
        fw.userData.u.uDrift.value.set(t * .4 * (i + 1), 0);
        fw.userData.u.uOp.value = shot === 8 ? [.45, .65, .85, 1][i] : [.25, .2, 0, 0][i] * seg(fr, 334, 340);
        // 返修 2：雾片贴地渐显的高度拉到 0–4.5 m 以上（原来 0–1.6 m，正好等于眼高 1.6 m，渐显的上沿全落在地平线上，成了一道横线）
        fw.userData.u.uFloor.value.set(shot === 8 ? -.5 : -1e4, shot === 8 ? [4.5, 5.5, 6.5, 8][i] : 0);
        fw.userData.u.uFall.value = shot === 8 ? [.5, .7, .8, .6][i] : 0;
      });
      if (shot === 8) {
        fogBack.position.copy(new THREE.Vector3(0, 0, -2).addScaledVector(dir, 40)); fogBack.position.y = 20; fogBack.rotation.set(0, Math.atan2(-dir.x, -dir.z), 0);
        const d = 1.4 * Math.max(0, fr - 316) / 24;
        const c = new THREE.Vector3(0, .01, -2).addScaledVector(dir, d + 6.2);
        shadow.position.copy(c); shadow.rotation.set(-Math.PI / 2, 0, Math.atan2(dir.x, dir.z) + Math.PI);
        shadow.scale.set(1.25, 9.5, 1);
        shadowU.uA.value = .7 * (1 + .06 * (hashi(f2) - .5) * 2);
        shadowU.uStride.value = Math.sin(Math.PI * (f2 - 316) / 8);           // 两腿交替（一拍二）
        floorU.uGold.value = 1.0 - seg(fr, 316, 333) * .55; floorU.uFogC.value.copy(lin3('#A3B3B8'));
      }
    }
    mi.material.uniforms.uT.value = t; mi.material.uniforms.uF2.value = f2; mi.material.uniforms.uDark.value = shot === 8 ? .3 : 0;

    // 人群剪影
    crowd.forEach(c => {
      const { u, L, D, h, ph, spd } = c.userData;
      const x = 6 - ((t * spd + ph) % 12);
      if (shot === 5 || shot === 8) {
        // 头顶压在 y≈640 / 680 / 700（#05 构图：人群剪影压在 y 620–1040）
        const topY = [650, 685, 705][L];
        const ref = new THREE.PerspectiveCamera(50, W / H, .01, 400); aim(ref, [0, 1.6, 0], 0, 2); ref.updateProjectionMatrix();
        const tp = s2w(ref, 960, topY, D);
        c.position.set(x, tp.y - h, -D); c.scale.set(h * .62, h, 1); c.rotation.set(0, 0, 0);
      }
      else { // 特写背景：在面具后面的远处走过
        c.position.set(x * 1.6, -.2, -2 - D * 1.6); c.scale.set(h * .62 * 1.4, h * 1.4, 1); c.rotation.set(0, 0, 0);
      }
      u.uSoft.value = (closeup ? .16 : [.05, .025, .01][L]); u.uA.value = closeup ? .55 : 1; u.uRimA.value = closeup ? .5 : 1; u.uWin.value = closeup ? 1 : 0;
    });
    // 金箔：1–4 m 深度，下落 120·K px/s，翻转时闪
    leaves.forEach((l, i) => {
      const { u, s0, s1, s2 } = l.userData;
      const D = 1 + 3 * s0, x = (s1 - .5) * 2 * D * .9, yy = 1.6 + 1.2 * D * .5 - (((t * .5 * D * .25 + s2 * 3) % 3)) * D * .35;
      const fz = Math.cos(t * (3 + 4 * s2) + s0 * 20);
      const w = (6 + 8 * s1) / pxPerM(cam, D);
      l.position.set(x + cam.position.x, yy, cam.position.z - D);
      l.rotation.set(t * (1 + s0), t * 2 * (s1 - .5), t * (.5 + s2));
      l.scale.set(w, w * .7, 1);
      u.uFlash.value = Math.pow(Math.abs(fz), 8);
      if (shot === 8) l.visible = l.visible && i % 3 === 0;
    });
    // 散景
    bokeh.forEach((b, i) => {
      const [a0, a1, a2] = b.userData.s;
      let x = a0 * 1920, y = 200 + a1 * 700;
      if (shot === 8) { if (i > 2) { b.visible = false; return; } x = [80, 1840, 1700][i]; y = [420, 380, 640][i]; }
      const ref = cam;
      if (shot !== 8 && i >= 12) { b.visible = false; return; }           // 返修 1：散景只留 12 个，做成不正的软笔点（不是相机镜头的圆）
      const sq = .55 + .5 * hashi(i * 29 + 3);
      onScreen(b, ref, x, y, (40 + 90 * a2), 20, (40 + 90 * a2) * sq); b.rotateZ((hashi(i * 31) - .5) * 1.4);
      b.userData.u.uSquash.value = 1; b.userData.u.uCore.value = .35;
      b.userData.u.uA.value = (shot === 8 ? (1 - seg(fr, 316, 326)) * .7 : .45) * (.6 + .4 * Math.sin(t * 2 + i));
    });

    // 面具特写
    if (shot === 6) {
      const m = mask06(Math.max(270, Math.min(278, f2)));
      let [cx, cy, sc, rot] = m;
      if (f2 >= 278) { cx += (hashi(f2) - .5) * 4; cy += (hashi(f2 + 5) - .5) * 4; }
      const wpx = 760 * sc;
      placeMask(cam, cx, cy, wpx, .6, rot);
      if (f2 === 272) { mask.group.scale.x *= 1.3; mask.u.uOpacity.value = .85; } else mask.u.uOpacity.value = 1;
      sweep.material.uniforms.uOn.value = fr >= 280 ? 1 : 0; sweep.material.uniforms.uSweep.value = -.6 + (fr - 280) * 140 / 760; sweep.material.uniforms.uF2.value = f2;
    }
    if (shot === 7) {
      // 面具在右（x 1150–1800、y 120–760），深 0.55 m，转 8°
      placeMask(cam, 1475, 440, 650, .55, -3);
      mask.u.uBlur.value = fr >= 298 && fr <= 305 ? 1.6 : .4;
      const hp = hand07(f2 >= 306 ? f2 : Math.min(f2, 305));
      const pose = f2 >= 306 ? 1 : 0;
      const P = M.handsSide[pose];
      hand.setRect(P.rect);
      const tip = P.keys.index_tip;
      const hpx = 520, s = hpx / P.rect[3];
      const rot = -35 + (f2 >= 298 && f2 <= 305 ? .8 * Math.sin(f2 * 2.1) : 0);
      const ox = (tip[0] - P.rect[0] - P.rect[2] / 2) * s, oy = (tip[1] - P.rect[1] - P.rect[3] / 2) * s;
      const cr = Math.cos(rot * DEG), sr = Math.sin(rot * DEG);
      faceCam(hand, cam, hp[0] - (cr * ox - sr * oy), hp[1] - (sr * ox + cr * oy), hpx, .35, { rot: -rot });
      hand.u.uLit.value.set(1.08, .98, .82); hand.u.uShade.value.set(.55, .62, .62);
      hand.u.uRimAmt.value = .9; hand.u.uRimCol.value.copy(lin3('#F0C36A')); rimOffset(hand, .9, .3, 3 * K, hpx * K); hand.u.uInkGrow.value = Math.min(6, 1.2 * P.rect[3] / Math.max(hpx, 1));
      // 食指尖的环斑墨渍（R 18·K，SEED_STAIN）
      hand.u.uStain.value.set(tip[0] - 14, tip[1] - 4, 26 / s, 1); hand.u.uStainSeed.value = 7; hand.u.uStainP.value.set(.6, .85, 3, .56); hand.u.uStainGloss.value = .9;
    }
    if (shot === 9) {
      // 面具停在画面中心偏上，左眼孔对 (960, 520)
      const ref = new THREE.PerspectiveCamera(35, W / H, .01, 400); aim(ref, [0, 1.6, -1.4], 0, 2); ref.updateProjectionMatrix();
      const wpx = 900;
      const s = wpx / 1268;
      const cx = 960 - (L.center.px[0] - 634) * s, cy = 520 - (L.center.px[1] - 557.5) * s;
      placeMask(ref, cx, cy, wpx, 1.2, 0);
      // 眼孔在当前相机下的屏幕位置
      const c = new THREE.Vector3(), e1 = new THREE.Vector3();
      const loc = (px, py) => { const v = new THREE.Vector3((px / 1268 - .5), (.5 - py / 1115), 0); return v.applyMatrix4(mask.group.matrixWorld); };
      mask.group.updateMatrixWorld(true);
      const pc = w2s(cam, loc(L.center.px[0], L.center.px[1]));
      const tl = L.tilt_deg * DEG, hw = L.w_px / 2, hh = L.h_px / 2;
      const pa = w2s(cam, loc(L.center.px[0] + Math.cos(tl) * hw, L.center.px[1] + Math.sin(tl) * hw));
      const pb = w2s(cam, loc(L.center.px[0] - Math.sin(tl) * hh, L.center.px[1] + Math.cos(tl) * hh));
      const sx = st.shake ? st.shake[0] : 0, sy = st.shake ? st.shake[1] : 0;
      hole.cx = pc.x; hole.cy = pc.y; void sx; void sy; hole.a = Math.hypot(pa.x - pc.x, pa.y - pc.y); hole.b = Math.hypot(pb.x - pc.x, pb.y - pc.y);
      hole.tilt = Math.atan2(pa.y - pc.y, pa.x - pc.x); hole.on = 1;
      void c; void e1;
    } else hole.on = 0;
    if (ctx.DBG.size) { if (ctx.DBG.has('hide:mfog')) fogWall.forEach(o => o.visible = false); if (ctx.DBG.has('hide:plate')) plate.visible = false; if (ctx.DBG.has('hide:crowd')) crowd.forEach(o => o.visible = false); if (ctx.DBG.has('hide:bokeh')) bokeh.forEach(o => o.visible = false); }
    setToonGlobals({ keyDir: [0, .3, -1], skyGain: 0, inkTime: Math.floor(f / 2) });
    st.fr = fr;
  }

  function look(t, f, shot) {
    const fr = t * 24;
    const OL = { width: 2.4, color: '#160B02', wobble: .8, warp: 60, boilFps: 12, pressure: .35, breakup: .12, inner: .5, farScale: .6, tint: .15, darken: .5, fogFade: .6, near: 1, far: 30 };
    const grade = { exposure: 1.02, warmth: .15, lift: [.015, .030, .030], gamma: .95, gain: 1.06, saturation: 1.12, shoulder: .9 };
    const bloom = { strength: .75, threshold: .70, radius: .70, tint: '#FFD27A' };
    const kuw = { radius: 2, farRadius: 4, farStart: 10, farEnd: 40, strength: .85, protect: [1.05, 1.6] };
    const fog = { color: '#16201E', colorHigh: '#2A2A1E', density: .035, start: 2, max: .55, cutoff: 60 };
    let vignette = .32;
    if (shot === 8) {
      const k = seg(fr, 316, 333);
      grade.warmth = lerp(.15, -.20, k); grade.saturation = lerp(1.12, .85, k); bloom.strength = lerp(.75, .35, k);
      fog.color = '#' + mixHex('#16201E', '#9FB0B6', ss(k)).getHexString(); fog.colorHigh = fog.color; vignette = .30;
      // 返修 2：雾的截止距离放开（原来 60 m 外不加雾：60 m 以内的地面有雾、60 m 外的地面和背景筒没雾，交界一道横线）
      { const kf = ss(seg(fr, 312, 316)); fog.density = lerp(.035, .06, kf); fog.start = lerp(2, 5, kf); fog.max = lerp(.55, .93, kf); if (fr >= 311) fog.cutoff = 1e4;
        if (kf > 0) { fog.color = '#' + mixHex(fog.color, '#A3B3B8', kf).getHexString(); fog.colorHigh = '#' + mixHex(fog.colorHigh, '#B9C6C8', kf).getHexString(); } }
    }
    if (shot === 9) grade.exposure = lerp(1.02, .85, seg(fr, 334, 347));
    if (shot >= 6 && shot <= 7) { kuw.radius = 1.8; kuw.farRadius = 4.5; kuw.farStart = 1.2; kuw.farEnd = 8; }   // 返修 2（style-21）：背景用大半径 Kuwahara 软化，像画不像镜头
    return { outline: OL, grade, bloom, kuwahara: kuw, fog, paper: { strength: .03 }, vignette };
  }
  function post(t, f, shot) {
    const fr = t * 24;
    const p = {};
    if (shot === 8 && fr < 316) { const k = Math.sin(Math.PI * seg(fr, 310, 316)); p.uMBlur = [140 * k, 0]; }
    return p;
  }
  return { scene, camera: cam, update, look, post, st };
}
