// market.js — 场景 C：面具集市（S3a 人墙、S3b 递面具、S3c 指尖与假斑、S3d 面具眼孔）
// 夜青底上只有琥珀金一种亮色；满街一模一样的金豹面具（假斑全是同一枚对称四瓣梅花印）。
import * as THREE from 'three';
import { GLSL_COMMON, DEG, clamp, lerp, seg, ss, ss5, eo, eio, ei2, hashi, lin3, srgb, motifPh, tcOf } from './util.js';
import { makeToon, outlined, SHARED, GLSL_3D } from './toonmat.js';
import { makeSprite, setSpots, placeOnCam, placeWorld, placeFlat, texPx } from './sprite.js';
import { orthoCam } from './fx.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const UNIT = new THREE.PlaneGeometry(1, 1);
const PV = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;

// ── 金面具：球面取前方 140°×100°；UV 图案在片元里画 ──
const MASK_VS = /* glsl */`
varying vec2 vUv; varying vec3 vW, vN, vV;
void main(){
  vUv = uv;
  vec4 p = vec4(position, 1.); vec3 n = normal;
#ifdef USE_INSTANCING
  p = instanceMatrix * p; n = mat3(instanceMatrix) * n;
#endif
  vec4 w = modelMatrix * p; vW = w.xyz; vN = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const MASK_FS = /* glsl */`
${GLSL_COMMON}
uniform vec3 uLight, uUp; uniform float uTc, uGlit, uK, uBack, uEyes;
varying vec2 vUv; varying vec3 vW, vN, vV;
float almond(vec2 p, vec2 c, vec2 h){ vec2 d = (p - c) / h; return length(vec2(d.x, d.y * (1. + .35 * abs(d.x)))) ; }
float plum(vec2 q){   // 对称四瓣梅花：q 以印心为原点，单位 = 印半径
  float r = length(q), a = atan(q.y, q.x);
  float petal = .62 + .38 * abs(cos(2. * a));
  return r / petal;
}
void main(){
  vec2 uv = vUv;
  // 眼孔（几何洞）
  float eL = almond(uv, vec2(.33, .58), vec2(.085, .045)), eR = almond(uv, vec2(.67, .58), vec2(.085, .045));
  if (min(eL, eR) < 1.) {
    if (uEyes < .5) discard;
    // 戴面具的人：眼孔里只有两点琥珀亮瞳
    vec2 cE = eL < eR ? vec2(.33, .58) : vec2(.67, .58);
    float pd = length((uv - cE) / vec2(.03, .022));
    vec3 ec = mix(vec3(.004, .003, .002), vec3(.85, .78, .1) * 3.2, 1. - sst(.7, 1.1, pd));
    gl_FragColor = vec4(ec, 1.); return;
  }
  vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vW);
  if (!gl_FrontFacing) { N = -N; }
  vec3 L = normalize(uLight);
  float hl = .5 * dot(N, L) + .5;
  // 返修 style-05：旧金——底 #C8922A、阴 #8A5A20、深 #5A3A16；交界放软到 .10 / .12（和崖石同一口径）
  vec3 base = vec3(.578, .287, .023), s1 = vec3(.254, .102, .014), s2 = vec3(.102, .042, .008);
  float m1 = clamp((.58 - hl) / .10 + .5, 0., 1.), m2 = clamp((.30 - hl) / .12 + .5, 0., 1.);
  vec3 col = mix(base, mix(s1, s2, m2), m1);
  // 金箔碎纹（cell noise，亮暗 ±12%）+ 竖向刷漆笔触：让金色显得旧
  vec2 cq = uv * vec2(78., 60.); vec2 ci = floor(cq), cf = fract(cq); float dmin = 9., dsec = 9.; float cid = 0.;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 o = vec2(float(i), float(j)); vec2 h = vec2(h21(ivec2(ci + o), 51u), h21(ivec2(ci + o), 52u)); float d = length(o + h - cf); if (d < dmin) { dsec = dmin; dmin = d; cid = h.x; } else if (d < dsec) dsec = d; }
  float leaf = (cid - .5) * .15 - .05 * (1. - sst(.0, .06, dsec - dmin));
  float brush = vnoise(vec2(uv.x * 140., uv.y * 9.), 53u) * .6 + vnoise(vec2(uv.x * 320., uv.y * 22.), 54u) * .4;
  col *= 1. + leaf + .10 * (brush - .5);
  // 朱妆：从眼眶向外散开的喷枪红晕（ref_07a 的画法），往颊部拖一点
  float ring = min(eL, eR);
  float tearL = length((uv - vec2(.30, .46)) / vec2(.06, .11)), tearR = length((uv - vec2(.70, .46)) / vec2(.06, .11));
  float rouge = max(1. - sst(1.0, 2.15, ring), (1. - sst(.3, 1.15, min(tearL, tearR))) * .8);
  rouge = pow(rouge, 1.3);
  // 白线：两头尖的勾脸细笔，顺鼻梁往下
  float tw = clamp((uv.y - .40) / .34, 0., 1.);
  float wW = .0075 * pow(sin(3.1416 * tw), .7) + .0004;
  float white = (1. - sst(wW * .55, wW, abs(uv.x - .5 + .004 * sin(uv.y * 30.)))) * step(.40, uv.y) * step(uv.y, .74);
  // 笑线：上挑的细长笑（两端往上翘、两端收尖）
  float su = (uv.x - .5) / .17;
  float smileY = .30 + .055 * su * su + .01 * su * su * su * su;
  float sW = .0055 * (1. - .85 * pow(abs(su), 3.)) + .0006;
  float smile = (1. - sst(sW * .5, sW, abs(uv.y - smileY))) * (1. - sst(.96, 1.04, abs(su)));
  // 假斑：同一个母题种子复印、同样大小、等距排开（"假斑都一样"），去掉亮黄外圈
  vec2 g = uv * vec2(1.4, 1.) / .16; g.x += .5 * mod(floor(g.y), 2.);
  vec2 cell = fract(g) - .5;
  float avoid = (1. - sst(.08, .3, rouge)) * (1. - white) * (1. - sst(.0, .04, .1 - abs(uv.y - .3))) * sst(.06, .1, uv.y) * sst(.04, .08, min(uv.x, 1. - uv.x)) * sst(1.6, 1.9, ring);
  vec2 fm = motif(cell / .27, vec4(1.3, 4.1, 2.2, 5.0), 4., .06, .42);
  float print = fm.x * avoid, printCore = fm.y * (1. - fm.x) * avoid;
  col = mix(col, col * .62, printCore * .8);
  col = mix(col, vec3(.064, .035, .012) * mix(1., .6, m1), print * .92);
  col = mix(col, vec3(.235, .018, .024) * mix(1., .55, m1), rouge * .92);
  col = mix(col, vec3(.815, .761, .693) * mix(1., .55, m1), white);
  col = mix(col, vec3(.16, .012, .016), smile);
  // 高光：一条细的漆面高光（不再是一大块）
  vec3 R = reflect(-L, N); float sp = pow(max(dot(R, V), 0.), 90.);
  col = mix(col, vec3(.80, .52, .16), sst(.6, .72, sp) * (1. - print) * .45);
  // fresnel 暗边 .35；接触 AO（面具边缘、眼孔一圈）；边缘光；灯笼从下面照
  col *= mix(1., .65, pow(1. - abs(dot(N, V)), 2.));
  float edgeAO = sst(.0, .12, min(min(uv.x, 1. - uv.x), min(uv.y, 1. - uv.y))) * mix(.78, 1., sst(1., 1.35, ring));
  col *= mix(.8, 1., edgeAO);
  float rim = sst(.55, .62, pow(1. - clamp(dot(N, V), 0., 1.), 1.5)); col = mix(col, vec3(.70, .34, .03), rim * .45);
  col = mix(col, col * vec3(1.35, 1.05, .7) + vec3(.03, .015, 0.), sst(.1, .5, dot(N, normalize(uUp))) * .3);
  // 闪粉（返修 tech-10 / style-05）：每格一个软圆点（1–2K），不再是硬边方块
  if (uGlit > 0.) {
    vec3 gq = vW * 500.; ivec3 gi = ivec3(floor(gq));
    vec3 jit = vec3(h21(gi.xy + gi.z * 31, 61u), h21(gi.yz + gi.x * 17, 62u), h21(gi.zx + gi.y * 13, 63u)) - .5;
    float dd = length(fract(gq) - .5 - jit * .4);
    float h = h21(gi.xy + gi.z * 31, uint(uTc * 12. + .5) * 13u + 5u); float th = .993 - .02 * pow(max(dot(R, V), 0.), 4.);
    col += vec3(.9, .62, .18) * step(th, h) * (1. - sst(.12, .3, dd)) * uGlit * 1.6;
  }
  if (!gl_FrontFacing) col = vec3(.08, .05, .03) * uBack;
  gl_FragColor = vec4(col, 1.);
}`;
function maskGeo() {
  const g = new THREE.SphereGeometry(.11, 72, 48, Math.PI / 2 - 70 * DEG, 140 * DEG, 40 * DEG, 100 * DEG);
  const P = g.attributes.position, uv = g.attributes.uv, v = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i); const u = uv.getX(i), w = uv.getY(i);
    v.z -= .07;                                           // 背面压平：整体往后放，前凸 4 cm
    const ear = Math.exp(-(((u - .12) / .08) ** 2 + ((w - .92) / .07) ** 2)) + Math.exp(-(((u - .88) / .08) ** 2 + ((w - .92) / .07) ** 2));
    v.y += .018 * ear; v.z += .01 * ear;                   // 顶角两只小圆耳
    const nose = Math.exp(-(((u - .5) / .06) ** 2 + ((w - .42) / .1) ** 2)); v.z += .008 * nose;
    P.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// ── 灯笼（自发光、竹骨细线）──
const LANT_FS = /* glsl */`${GLSL_COMMON} uniform vec3 uBody, uCore; uniform float uRed; varying vec2 vUv;
void main(){
  float ribs = 1. - sst(.0, .02, abs(fract(vUv.x * 8.) - .5) - .46);
  float band = sst(.06, .1, vUv.y) * (1. - sst(.9, .94, vUv.y));
  float core = exp(-pow((vUv.y - .5) / .28, 2.)) ;
  vec3 c = mix(uBody, uCore, core * .6);
  c *= mix(.25, 1., band); c = mix(c, vec3(.03, .015, .008), ribs * .55);
  gl_FragColor = vec4(c, 1.);
}`;

// ── 人群剪影（Canvas 画 6 种圆润剪影：发髻、幞头、斗笠、披巾、圆帽、垂耳兜帽） ──
function crowdTexture(kind) {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 768; const g = cv.getContext('2d');
  g.fillStyle = '#fff';
  const body = () => { g.beginPath(); g.moveTo(90, 768); g.bezierCurveTo(80, 520, 150, 430, 256, 425); g.bezierCurveTo(362, 430, 432, 520, 422, 768); g.closePath(); g.fill(); };
  const head = () => { g.beginPath(); g.ellipse(256, 330, 92, 108, 0, 0, Math.PI * 2); g.fill(); };
  body(); head();
  g.beginPath();
  if (kind === 0) { g.ellipse(256, 200, 48, 44, 0, 0, Math.PI * 2); }
  else if (kind === 1) { g.rect(176, 200, 160, 70); g.moveTo(150, 240); g.ellipse(150, 236, 70, 12, 0, 0, Math.PI * 2); g.ellipse(362, 236, 70, 12, 0, 0, Math.PI * 2); }
  else if (kind === 2) { g.moveTo(60, 285); g.quadraticCurveTo(256, 120, 452, 285); g.quadraticCurveTo(256, 255, 60, 285); }
  else if (kind === 3) { g.moveTo(140, 300); g.quadraticCurveTo(256, 150, 372, 300); g.lineTo(430, 600); g.lineTo(82, 600); }
  else if (kind === 4) { g.ellipse(256, 250, 110, 60, 0, Math.PI, 0); }
  else { g.ellipse(256, 280, 118, 120, 0, Math.PI, 0); g.ellipse(150, 360, 40, 90, .2, 0, Math.PI * 2); g.ellipse(362, 360, 40, 90, -.2, 0, Math.PI * 2); }
  g.fill();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
// 幡：暗红底，印同一枚金梅花；铜钱串
function bannerTexture() {
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 512; const g = cv.getContext('2d');
  g.fillStyle = '#681C05'; g.beginPath(); g.moveTo(8, 0); g.lineTo(120, 0); g.lineTo(120, 470); g.lineTo(64, 500); g.lineTo(8, 470); g.closePath(); g.fill();
  g.fillStyle = '#A77420';
  for (let i = 0; i < 3; i++) { const cy = 110 + i * 130, cx = 64; for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; g.beginPath(); g.ellipse(cx + Math.cos(a) * 16, cy + Math.sin(a) * 16, 15, 15, 0, 0, Math.PI * 2); g.fill(); } }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function coinTexture() {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 512; const g = cv.getContext('2d');
  g.strokeStyle = '#3a2a1c'; g.lineWidth = 3; g.beginPath(); g.moveTo(32, 0); g.lineTo(32, 512); g.stroke();
  for (let i = 0; i < 7; i++) { const y = 60 + i * 64; g.fillStyle = '#A77420'; g.beginPath(); g.arc(32, y, 24, 0, Math.PI * 2); g.fill(); g.fillStyle = '#6F5222'; g.beginPath(); g.arc(32, y, 24, 0, Math.PI * 2); g.lineWidth = 3; g.strokeStyle = '#6F5222'; g.stroke(); g.clearRect(25, y - 7, 14, 14); }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function buildMarket(ctx) {
  const { tex, man } = ctx;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(27.4, 1920 / 1040, .02, 300);
  const M = id => man.find(m => m.id === id);
  const LIGHT = [-.3, .2, .9];

  // ── 夜底（渐变）与夜雾 ──
  const skyU = { uA: { value: lin3('#0C1E27') }, uB: { value: lin3('#26463F') }, uC: { value: lin3('#38636E') } };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(250, 32, 16), new THREE.ShaderMaterial({ vertexShader: /* glsl */`varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: /* glsl */`${GLSL_COMMON} uniform vec3 uA, uB, uC; varying vec3 vD; void main(){ vec3 d = normalize(vD); vec3 c = mix(uB, uA, sst(-.05, .5, d.y)); c = mix(c, uC, (1. - sst(0., .12, abs(d.y))) * .35); c *= .9 + .2 * fbm(d.xz * 6. + d.y * 3., 99u); gl_FragColor = vec4(c, 1.); }`,
    uniforms: skyU, side: THREE.BackSide, depthWrite: false, depthTest: false, toneMapped: false }));
  sky.renderOrder = -100; scene.add(sky);
  const fogMat = (a, seed) => new THREE.ShaderMaterial({ vertexShader: PV, fragmentShader: /* glsl */`${GLSL_COMMON} uniform float uT, uA, uS; varying vec2 vUv; void main(){ float n = fbm(vec2(vUv.x * 3. + uT * .05 + uS, vUv.y * 1.6), 98u); float a = sst(-.1, .35, n) * sst(0., .3, vUv.y) * (1. - sst(.6, 1., vUv.y)) * sst(0., .15, vUv.x) * sst(0., .15, 1. - vUv.x); gl_FragColor = vec4(.109, .181, .178, a * uA); }`,
    uniforms: { uT: { value: 0 }, uA: { value: a }, uS: { value: seed } }, transparent: true, depthWrite: false, toneMapped: false });
  const fogs = [[16, 3.2, 30, 7, .4], [8, 2.4, 18, 4, .35], [30, 5, 60, 12, .45]].map(([z, y, w, h, a], k) => { const m = new THREE.Mesh(UNIT, fogMat(a, k * 3.7)); m.position.set(0, y, -z); m.scale.set(w, h, 1); m.renderOrder = -40 + k; scene.add(m); return m; });

  // ── 街与摊位剪影 ──
  // 第 3 轮（v2-08）：摊位不再是平涂的方柱和三角顶——顶棚是方锥面略往里凹（布棚垂下来的弧）、四角檐口微翘；
  //   灯笼从下面照上来，棚底和柱子朝街的一侧受一层琥珀色的光（三阶软交界），檐口一道受光边
  const stallMat = makeToon({ base: '#3A2A1E', s1: '#1E1612', s2: '#0E0A08', light: [.1, -.75, .65], step1: .62, f1: .14, step2: .36, f2: .16, rim: '#F3B136', rimAmt: .5, rimIn: .55, fres: .22, edgeN: .03, edgeNS: 3, dab: .08, dabS: 3 });
  const roofGeo = (() => {
    let g = new THREE.CylinderGeometry(.02, 1.7, .55, 32, 8, false);
    g.deleteAttribute('normal'); g.deleteAttribute('uv'); g = mergeVertices(g);
    const P = g.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i);
      const t = clamp((v.y + .275) / .55), th = Math.atan2(v.z, v.x), a = th + Math.PI / 4;   // float32 下顶点会略超 1，夹住免得 pow 出 NaN
      const sq = 1 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      const corner = Math.pow(Math.abs(Math.sin(2 * a)), 3);
      const rr = Math.hypot(v.x, v.z) * sq * .71 * (1 - .14 * Math.sin(Math.PI * t));
      P.setXYZ(i, Math.cos(th) * rr, v.y + .1 * corner * Math.pow(1 - t, 2.5) - .04 * Math.sin(Math.PI * t), Math.sin(th) * rr);
    }
    g.computeVertexNormals();
    return g;
  })();
  const postGeo = new THREE.LatheGeometry([[0, 0], [.072, 0], [.074, .06], [.066, .12], [.064, 1.2], [.056, 2.02], [.06, 2.08], [0, 2.08]].map(([x, y]) => new THREE.Vector2(x, y)), 12);
  const capGeo = new RoundedBoxGeometry(.2, .09, .2, 2, .02);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 80), makeToon({ base: '#161A1A', s1: '#101313', s2: '#0A0C0C', light: [0, 1, .2], edgeN: 0, fres: 0, dab: .1, dabS: .8 })); ground.rotation.x = -Math.PI / 2; ground.position.set(0, 0, -30); scene.add(ground);
  const stalls = [];
  for (let i = 0; i < 10; i++) {
    const side = i % 2 ? 1 : -1, z = -4 - i * 3.2;
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.0, 1.2), stallMat); box.position.y = .5; g.add(box);
    const roof = new THREE.Mesh(roofGeo, stallMat); roof.rotation.y = Math.PI / 4; roof.position.y = 2.35; roof.scale.set(1, 1, .7); g.add(roof);
    // 第 4 轮（v2-08）：柱子不再是细圆柱——粗一些、往上略收（卷杀），柱头一块斗形的托木，和布棚、灯笼光一套
    for (const px of [-.95, .95]) { const p = new THREE.Mesh(postGeo, stallMat); p.position.set(px, 0, .5); g.add(p); const cap = new THREE.Mesh(capGeo, stallMat); cap.position.set(px, 2.12, .5); g.add(cap); }
    g.position.set(side * (2.6 + .4 * hashi(i)), 0, z); g.rotation.y = -side * .25;
    g.traverse(o => { if (o.isMesh) outlined(o, 1, .9); });
    scene.add(g); stalls.push(g);
  }

  // ── 灯笼：3D 自发光 ──
  const lantGeo = new THREE.SphereGeometry(.16, 24, 16); lantGeo.scale(1, 1.2, 1);
  const lantMat = (red) => new THREE.ShaderMaterial({ vertexShader: PV, fragmentShader: LANT_FS, uniforms: { uBody: { value: red ? lin3('#7A2A1E') : lin3('#E79D16').multiplyScalar(2.2) }, uCore: { value: red ? lin3('#7A2A1E').multiplyScalar(1.2) : lin3('#F3B136').multiplyScalar(3.0) }, uRed: { value: red ? 1 : 0 } }, toneMapped: false });
  const lanterns = [];
  const LP = [];
  for (let i = 0; i < 34; i++) { const z = -1.2 - Math.pow(hashi(i * 3), 1.3) * 30, side = hashi(i * 5) > .5 ? 1 : -1; LP.push([side * (1.2 + 2.6 * hashi(i * 7)), 2.1 + .9 * hashi(i * 11), z, hashi(i * 13) < .18]); }
  LP.forEach(([x, y, z, red], i) => { const m = new THREE.Mesh(lantGeo, lantMat(red)); m.position.set(x, y, z); m.userData.outline = false; scene.add(m); lanterns.push(m); });

  // ── 人墙：剪影卡 + 实例化金面具 ──
  const maskU = { uLight: { value: V3(...LIGHT).normalize() }, uUp: { value: V3(0, -1, .3) }, uTc: SHARED.uTc, uGlit: { value: 0 }, uK: SHARED.uK, uBack: { value: 1 }, uEyes: { value: 1 } };
  const heroU = { ...maskU, uLight: { value: V3(...LIGHT).normalize() }, uEyes: { value: 0 }, uGlit: { value: 0 } };
  const maskMat = new THREE.ShaderMaterial({ vertexShader: MASK_VS, fragmentShader: MASK_FS, uniforms: maskU, side: THREE.DoubleSide, toneMapped: false });
  const mg = maskGeo();
  const crowd = new THREE.InstancedMesh(mg, maskMat, 24); crowd.userData.outline = true; crowd.userData.outlineWidth = 1; crowd.userData.outlineAlpha = .9; crowd.userData.outlinePerInstance = true; scene.add(crowd);
  const silTex = Array.from({ length: 6 }, (_, k) => crowdTexture(k));
  const people = [];
  const PEOPLE = [[-1.6, 3.2, 0], [-.6, 4.4, 1], [.55, 3.6, 2], [1.7, 4.8, 3], [-2.6, 6.5, 4], [2.8, 6.2, 5], [-.2, 7.8, 0], [1.2, 9.5, 2], [-1.5, 11, 3], [.6, 12, 4], [2.2, 10.5, 1], [-3.2, 9, 5]];
  PEOPLE.forEach(([x, z, k], i) => {
    const S = makeSprite(silTex[k], { order: 10 + i * .01 });
    scene.add(S.group); people.push({ S, x, z: -z, k, i });
  });
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
  function layoutCrowd(f, c) {
    let n = 0;
    const tc = tcOf(f);
    for (const P of people) {
      const sway = .02 * Math.sin(tc * 3 + P.i);
      const base = V3(P.x + sway, 0, P.z);
      const h = 1.75 + .1 * hashi(P.i * 3);
      P.S.group.visible = true;
      placeWorld(P.S, c, 256, 768, base, h);
      const u = P.S.u; u.uLight.value.set(.010, .0075, .0062); u.uRimC.value.copy(lin3('#F3B136')); u.uRimAmt.value = .9; u.uRimDir.value.set(P.x > 0 ? -1 : 1, -.3).normalize(); u.uRimW.value = texPx(P.S, 2.2);
      // 面具贴在脸上（头心 ≈ 贴图 (256, 330)）
      const headY = h * (1 - 330 / 768);
      _p.set(P.x + sway, headY - .02, P.z + .2);
      _e.set(-.05, Math.atan2(c.position.x - _p.x, c.position.z - _p.z) * .85, (hashi(P.i * 9) - .5) * .12); _q.setFromEuler(_e);
      const sc = 1.75; _s.set(sc, sc, sc);
      _m4.compose(_p, _q, _s); crowd.setMatrixAt(n++, _m4);
    }
    for (; n < 24; n++) { _m4.makeScale(0, 0, 0); crowd.setMatrixAt(n, _m4); }
    crowd.instanceMatrix.needsUpdate = true;
  }

  // ── 幡、铜钱串 ──
  const banTex = bannerTexture(), coinTex = coinTexture();
  const cardMat = (t, light = 1) => new THREE.ShaderMaterial({ vertexShader: PV, fragmentShader: /* glsl */`uniform sampler2D map; uniform float uL; varying vec2 vUv; void main(){ vec4 c = texture2D(map, vUv); if (c.a < .4) discard; gl_FragColor = vec4(c.rgb * uL, 1.); }`, uniforms: { map: { value: t }, uL: { value: light } }, side: THREE.DoubleSide, toneMapped: false });
  const banners = [[-2.2, 2.4, -6, .5], [2.4, 2.6, -9, .55], [-2.8, 2.8, -14, .6]].map(([x, y, z, s]) => { const m = new THREE.Mesh(UNIT, cardMat(banTex, .55)); m.position.set(x, y, z); m.scale.set(s * .25, s, 1); outlined(m, .8, .8); scene.add(m); return m; });
  const coins = [[-1.0, 2.5, -2.2, .7], [1.3, 2.4, -3.0, .65], [-.2, 2.6, -5.5, .6], [2.0, 2.5, -1.6, .7]].map(([x, y, z, s], i) => { const m = new THREE.Mesh(UNIT, cardMat(coinTex, .9)); m.position.set(x, y, z); m.scale.set(s / 8, s, 1); m.userData.base = m.position.clone(); m.userData.i = i; scene.add(m); return m; });

  // ── S3b：递来的面具（单张），摊主的手（A15），陆蔚肩头（A08 上半身裁切），摊主剪影 ──
  const heroMat = new THREE.ShaderMaterial({ vertexShader: MASK_VS, fragmentShader: MASK_FS, uniforms: heroU, side: THREE.DoubleSide, toneMapped: false });
  const hero = new THREE.Mesh(mg, heroMat); hero.userData.outline = true; hero.userData.outlineWidth = 1.0; hero.userData.outlineAlpha = .95; scene.add(hero);
  const vendor = makeSprite(tex.vendor, { order: 30 }); scene.add(vendor.group);
  const shoulder = makeSprite(tex.luSit, { order: 31, rect: [170, 0, 390, 620] }); scene.add(shoulder.group);
  const vendorSil = makeSprite(silTex[1], { order: 9 }); scene.add(vendorSil.group);
  const vendorMask = new THREE.Mesh(mg, maskMat); vendorMask.userData.outline = false; scene.add(vendorMask);
  // 发光眼（5 对，黑处，按哈希一拍二眨）
  const eyeU = { uE: { value: Array.from({ length: 10 }, () => new THREE.Vector4()) }, uN: { value: 0 }, uK: SHARED.uK };
  // S3c：陆蔚的手（A13 / A14 水平镜像），摊主手指（A15 局部，虚）
  const handO = makeSprite(tex.handOpen, { order: 40 }); scene.add(handO.group);
  const handF = makeSprite(tex.handFist, { order: 40 }); scene.add(handF.group);
  // 第 4 轮（v3-02）：原来只裁到贴图 y = 720，下缘那条切边落在画框里、把 20K 的虚影截成一条直线；裁切框一直延到贴图底（袖子从画框外进来），切边出画
  const vendorFing = makeSprite(tex.vendor, { order: 39, rect: [160, 300, 480, 1205] }); scene.add(vendorFing.group);
  // S3d：陆蔚的剪影（A09，三个姿态）
  const walkR = [[30, 20, 240, 684], [330, 20, 214, 684], [621, 20, 214, 684]];
  const walkers = walkR.map(r => { const S = makeSprite(tex.luWalk, { order: 20, rect: r }); scene.add(S.group); return S; });
  // 雾墙（与 S4a 起首的雾同一个函数、同一组参数）
  const wallU = { uT: { value: 0 }, uK: SHARED.uK, uBand: { value: 0 } };
  const fogWall = new THREE.Mesh(UNIT, new THREE.ShaderMaterial({ vertexShader: /* glsl */`varying vec2 vP; varying vec2 vUv2; void main(){ vUv2 = uv; vec4 c = projectionMatrix * modelViewMatrix * vec4(position, 1.); vP = vec2(0.); gl_Position = c; }`,
    fragmentShader: /* glsl */`${GLSL_COMMON} uniform float uT, uK, uBand; varying vec2 vUv2; void main(){ vec2 p = vec2(gl_FragCoord.x / uK, 1040. - gl_FragCoord.y / uK); vec3 wall = vec3(.815, .761, .693) * (1. + .05 * fbm(p / 180. + vec2(uT * .06, 0.), 91u)); float a = mix(1., 1. - sst(.55, 1., vUv2.y + .08 * fbm(vec2(vUv2.x * 9., uT * .1), 93u)), uBand); gl_FragColor = vec4(wall, a); }`,
    uniforms: wallU, toneMapped: false, transparent: true, depthWrite: false }));
  fogWall.position.set(0, 2, -26); fogWall.scale.set(60, 12, 1); fogWall.userData.outline = false; scene.add(fogWall);
  const fogWallFull = () => { fogWall.position.set(0, 2, -26); fogWall.scale.set(60, 12, 1); };
  const fogQU = { uT: { value: 0 }, uA: { value: 0 } };
  const fogQ = new THREE.Mesh(UNIT, new THREE.ShaderMaterial({ vertexShader: /* glsl */`varying vec2 vP; void main(){ vP = vec2(uv.x * 1920., (1. - uv.y) * 1040.); gl_Position = vec4(position.xy * 2., 0., 1.); }`,
    fragmentShader: /* glsl */`${GLSL_COMMON} uniform float uT, uA; varying vec2 vP; void main(){ vec2 p = vP; vec3 wall = vec3(.815, .761, .693) * (1. + .05 * fbm(p / 180. + vec2(uT * .06, 0.), 91u)); gl_FragColor = vec4(wall, uA); }`,
    uniforms: fogQU, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  fogQ.renderOrder = 900; fogQ.frustumCulled = false; fogQ.userData.outline = false; fogQ.userData.outlineOccluder = 'soft'; fogQ.visible = false; scene.add(fogQ);

  // ── 屏幕层（S3d 面具内壁、S3b 扫光带与闪粉、发光眼） ──
  const ov = { scene: new THREE.Scene(), camera: orthoCam() };
  const QUAD = new THREE.PlaneGeometry(1, 1);
  const FSV = /* glsl */`varying vec2 vP; void main(){ vP = position.xy * vec2(1920., 1040.) + vec2(960., 520.); gl_Position = projectionMatrix * modelViewMatrix * vec4(vP, 0., 1.); }`;
  const interiorU = { uS: { value: 1 }, uC: { value: new THREE.Vector2(760, 500) }, uPc: { value: new THREE.Vector2(760, 500) }, uOn: { value: 0 } };
  const interior = new THREE.Mesh(QUAD, new THREE.ShaderMaterial({ vertexShader: FSV, fragmentShader: /* glsl */`${GLSL_COMMON}
    uniform float uS, uOn; uniform vec2 uC; varying vec2 vP;
    float almond(vec2 p, vec2 c, vec2 h){ vec2 d = (p - c) / h; return length(vec2(d.x, d.y * (1. + .35 * abs(d.x)))); }
    // 极坐标噪声（第 3 轮）：沿半径 rad、沿角度 angK 格/弧度；两张噪声按方向加权，既没有 atan 的 ±π 接缝，也没有"切向和径向落到同一根轴上"的退化方向
    float pnoise(vec2 dir, float rad, float angK, uint s){ float n1 = vnoise(vec2(rad, 0.) + dir * angK, s), n2 = vnoise(vec2(0., rad) + dir * angK + 17., s + 7u); return mix(n2, n1, dir.x * dir.x); }
    uniform vec2 uPc;
    void main(){
      vec2 p = vec2(vP.x, 1040. - vP.y);
      vec2 q = uC + (p - uPc) / uS;             // 绕左孔中心放大，同时把左孔移到画面中心
      // 第 2 轮（style-12）：孔沿是手工切出来的纸胎边——almond 距离上叠两个尺度的 fbm，不再是矢量描边的正杏仁
      float wob = .025 * fbm(q / 38., 99u) + .012 * fbm(q / 11., 100u);
      float eL = almond(q, vec2(760., 500.), vec2(210., 120.)) + wob, eR = almond(q, vec2(1300., 500.), vec2(210., 120.)) + wob;
      float e = min(eL, eR);
      float soft = 14. / 160. / uS;
      float hole = 1. - sst(1. - soft * .3, 1. + soft * .2, e);
      // 纸胎：暗褐，纤维看得见（虚化只到 14K），带一点纸浆的团块
      vec3 c = mix(vec3(.229, .156, .099), vec3(.354, .262, .181), sst(1.0, 2.6, e));
      float fib = vnoise(q * vec2(.11, .55), 96u) - .5, fib2 = vnoise(q * vec2(.5, .09) + 7., 97u) - .5;
      c *= .9 + .2 * fbm(q / 90., 95u) + .14 * fib + .08 * fib2 + .06 * (vnoise(q / 5., 101u) - .5);
      // 凹壳的体积：越靠画框边越暗（壳往外卷），孔周围被孔里透进来的灯笼光照暖
      float rim = length((q - vec2(1030., 520.)) / vec2(1150., 760.));
      c *= mix(1.08, .42, sst(.35, 1.05, rim));
      float spill = exp(-pow(max(e - 1., 0.) / .55, 2.));
      c = mix(c, c * vec3(1.55, 1.22, .82) + vec3(.05, .025, .0), spill * .55);
      // 眉弓：两孔上方一道横的暗带（壳在这里往里折），下缘受光
      float brow = exp(-pow((q.y - 330.) / 55., 2.)) * (1. - sst(380., 820., abs(q.x - 1030.)));
      c *= 1. - .28 * brow;
      c = mix(c, c * 1.25, exp(-pow((q.y - 392.) / 18., 2.)) * (1. - sst(300., 700., abs(q.x - 1030.))) * .5);
      // 鼻梁：两孔之间一条竖的凸起——一侧受孔里的光、一侧压 AO
      float nx = q.x - 1030.; float nv = sst(330., 430., q.y) * (1. - sst(600., 760., q.y));
      c *= 1. + .55 * exp(-pow((nx + 18.) / 26., 2.)) * nv;
      c *= 1. - .35 * exp(-pow((nx - 34.) / 30., 2.)) * nv;
      c *= 1. - .22 * (sst(50., 95., abs(nx)) * (1. - sst(95., 170., abs(nx)))) * nv;
      // 颊：孔下方两团微微鼓起的受光
      c *= 1. + .16 * exp(-pow(length((q - vec2(770., 720.)) / vec2(230., 110.)), 2.)) + .16 * exp(-pow(length((q - vec2(1290., 720.)) / vec2(230., 110.)), 2.));
      // 手刷金漆：顺着壳的弧度刷的几笔（不再是竖直的亮条），只在孔周围
      // 第 3 轮：角度用方向向量代入噪声（atan 在画左那条水平线上有 ±π 的跳变，会留下一道接缝）
      vec2 dirC = normalize(q - vec2(1030., 520.) + vec2(1e-3, 0.));
      float brush = sst(.66, .9, pnoise(dirC, length(q - vec2(1030., 520.)) / 24., 9., 98u));
      c = mix(c, vec3(.62, .40, .10), brush * spill * .18);
      // 第 3 轮（v2-08）：外圈不再是一整片均匀的暗褐——顺着壳的弧度刷的几道宽漆痕（明暗约 ±12%）、大尺度的纸浆团块、
      //   下缘一层从灯笼反上来的暖光
      // 第 4 轮（v3-03）：原来那几道宽漆痕是以画面中心为圆心的同心椭圆带（拉高对比像靶环、年轮）。改成 16 段短弧：每段 30–80°，
      //   起止、宽窄、圆心各自随机（圆心在 ±130 / ±90K 里错开），两端收笔，有亮有暗，再用低频 fbm 打断；明暗仍在 ±9% 以内
      float strokes = 0.;
      for (int i = 0; i < 16; i++) {
        float fi = float(i);
        vec2 cc = vec2(1030., 520.) + (vec2(h11(fi, 111u), h11(fi, 112u)) - .5) * vec2(260., 180.);
        float R = 330. + 430. * h11(fi, 113u), a0 = h11(fi, 114u) * 6.2832, span = (30. + 50. * h11(fi, 115u)) * .017453, w = 14. + 26. * h11(fi, 116u);
        vec2 d = (q - cc) * vec2(1., 1.25);
        float da = atan(d.y, d.x) - a0; da -= 6.2832 * floor(da / 6.2832);
        if (da > span) continue;
        float u = da / span, taper = sin(3.1416 * u);
        float dr = (length(d) - R - 18. * sin(u * 3.1 + fi)) / (w * (.3 + .7 * taper));
        strokes += exp(-dr * dr * 2.) * taper * (h11(fi, 117u) > .45 ? 1. : -.8);
      }
      strokes *= .55 + .9 * (fbm(q / 150., 118u) + .5);
      c *= 1. + .09 * clamp(strokes, -1., 1.) * sst(.3, .7, rim);
      c *= .92 + .16 * (fbm(q / 260., 105u) + .5);
      c = mix(c, c * vec3(1.25, 1.1, .9), sst(620., 1000., q.y) * .35);
      c = l2s(c * .55);
      // 孔沿：6–8K 的切面——下半圈受孔里的灯笼光（金），上半圈压暗；最里面一道暗边
      float rimD = (e - 1.) * 160. * uS;
      float bevel = sst(-.5, 1.5, rimD) * (1. - sst(6., 9., rimD + 2. * fbm(q / 7., 102u)));
      float lit = sst(-.3, .7, dot(normalize(q - vec2(q.x < 1030. ? 760. : 1300., 500.)), vec2(0., 1.)) + .2);
      c = mix(c, mix(vec3(.30, .19, .06), vec3(.90, .64, .20), lit), bevel * .85);
      c = mix(c, vec3(.05, .035, .02), (1. - sst(0., 2.5, abs(rimD - .2))) * .8);
      gl_FragColor = vec4(c, (1. - hole) * uOn);
    }`, uniforms: interiorU, transparent: true, depthTest: false, depthWrite: false }));
  interior.frustumCulled = false; interior.renderOrder = 10; ov.scene.add(interior);
  const sweepU = { uK: { value: 0 }, uA: { value: 0 } };
  const sweep = new THREE.Mesh(QUAD, new THREE.ShaderMaterial({ vertexShader: FSV, fragmentShader: /* glsl */`uniform float uK, uA; varying vec2 vP; void main(){ vec2 p = vec2(vP.x, 1040. - vP.y); float d = (p.x + p.y) * .7071 - mix(-200., 2300., uK); float a = exp(-d * d / (2. * 90. * 90.)) * uA; gl_FragColor = vec4(1., .945, .69, a * .4); }`,
    uniforms: sweepU, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }));
  sweep.frustumCulled = false; sweep.renderOrder = 5; ov.scene.add(sweep);
  const glitU = { uT: { value: 0 }, uA: { value: 0 }, uC: { value: new THREE.Vector4(1120, 470, 260, 0) }, uK: SHARED.uK };
  const glit = new THREE.Mesh(QUAD, new THREE.ShaderMaterial({ vertexShader: FSV, fragmentShader: /* glsl */`${GLSL_COMMON} uniform float uT, uA, uK; uniform vec4 uC; varying vec2 vP;
    void main(){ vec2 p = vec2(vP.x, 1040. - vP.y); float a = 0.; for (int i = 0; i < 120; i++) { vec2 c = uC.xy + (vec2(h21(ivec2(i, 1), 31u), h21(ivec2(i, 2), 31u)) - .5) * 2. * uC.z * vec2(1.4, 1.); float on = step(.5, h21(ivec2(i, int(uT)), 32u)); float d = length(p - c); float rr = 1. + h21(ivec2(i, 5), 33u); a = max(a, on * (1. - sst(rr * .6, rr, d)) * .9); } gl_FragColor = vec4(.96, .78, .36, clamp(a, 0., 1.) * uA); }`,
    uniforms: glitU, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }));
  glit.frustumCulled = false; glit.renderOrder = 6; ov.scene.add(glit);
  const eyes = new THREE.Mesh(QUAD, new THREE.ShaderMaterial({ vertexShader: FSV, fragmentShader: /* glsl */`${GLSL_COMMON} uniform vec4 uE[10]; uniform int uN; varying vec2 vP;
    void main(){ vec2 p = vec2(vP.x, 1040. - vP.y); float a = 0.; for (int i = 0; i < 10; i++) { if (i >= uN) break; vec4 e = uE[i]; vec2 d = (p - e.xy) / vec2(e.z, e.z * .55 * e.w); float r = length(d); a = max(a, (1. - sst(.2, 1.15, r)) * .55 + .2 * exp(-r * r * .25)); } gl_FragColor = vec4(.93, .89, .36, clamp(a, 0., 1.)); }`,
    uniforms: eyeU, transparent: true, depthTest: false, depthWrite: false }));
  eyes.frustumCulled = false; eyes.renderOrder = 1; ov.scene.add(eyes);

  const allS = [vendor, shoulder, vendorSil, handO, handF, vendorFing, ...walkers];
  const hideS = () => { fogQ.visible = false; for (const S of allS) S.group.visible = false; for (const P of people) P.S.group.visible = false; hero.visible = vendorMask.visible = false; crowd.visible = false; interiorU.uOn.value = 0; sweepU.uA.value = 0; glitU.uA.value = 0; eyeU.uN.value = 0; fogWall.visible = false; };
  const aim = (p, yaw, pitch) => { cam.position.copy(p); cam.rotation.order = 'YXZ'; cam.rotation.set(pitch, yaw, 0); cam.updateMatrixWorld(true); };
  const common = (t, tc) => { for (const m of fogs) m.material.uniforms.uT.value = t; coins.forEach(m => { m.rotation.z = 6 * DEG * Math.sin(2 * Math.PI * t / 1.3 + m.userData.i); }); maskU.uGlit.value = 0; heroU.uGlit.value = 0; heroU.uLight.value.set(...LIGHT).normalize(); };
  const shots = {};
  // S3a 集市爆入（f287–f294）：甩镜 −14° → 0°
  shots.S3a = (f, t) => {
    const tc = tcOf(f);
    hideS(); common(t, tc);
    const yaw = f < 290 ? lerp(-14, 0, eo((f - 287) / 3)) : 0, push = f >= 290 ? .015 * ss((f - 290) / 4) : 0;
    cam.fov = 27.4; cam.updateProjectionMatrix();
    aim(V3(0, 1.55, 1.2 - push * 4), yaw * DEG, 2 * DEG);
    crowd.visible = true; layoutCrowd(f, cam);
    const vel = f < 290 ? 14 * 3 * (1 - (f - 287) / 3) : 0;
    const blurPx = Math.min(60, vel * 2133 / 57.3 / 24 * .5);
    return { scene, camera: cam, dof: { zf: 4.0, cocScale: 69, cocMax: 44, rfg: 40 }, blur: blurPx > .5 ? { dir: [blurPx, 0] } : null };
  };
  // S3b 递面具（f294–f315）
  const A15 = M('A15')['锚点'];
  shots.S3b = (f, t) => {
    const tc = tcOf(f);
    hideS(); common(t, tc);
    const push = .05 * eo((f - 294) / 6) + .04 * ss((f - 302) / 9);
    cam.fov = 22.07; cam.updateProjectionMatrix();
    aim(V3(.2, 1.5, 1.4 - push), -4 * DEG, 0);
    // 面具冲进来：f294–296 拖影；f298 到位；f300 冲过头 4%；f302 回正
    const ff = Math.floor(f / 2) * 2;
    const over = ff < 296 ? -.25 : ff < 298 ? -.08 : ff < 300 ? 0 : ff < 302 ? .04 : 0;
    const dist = lerp(.9, .55, ss((f - 294) / 21));
    const dd = dist * (1 - over);
    const mp = new THREE.Vector3((1120 - 960) / 2667 * dd, -(470 - 520) / 2667 * dd, -dd).applyMatrix4(cam.matrixWorld);
    hero.visible = true; hero.position.copy(mp); hero.quaternion.copy(cam.quaternion); hero.rotateY(Math.PI); hero.rotateY(Math.PI); hero.rotateZ(8 * DEG);
    hero.scale.setScalar(1);
    // 签头接在面具下沿；手从右下进来
    hero.updateMatrixWorld(true);
    const stickTop = V3(0, -.085, -.03).applyMatrix4(hero.matrixWorld);
    vendor.group.visible = true;
    const sp = stickTop.clone().project(cam);
    const sx = (sp.x * .5 + .5) * 1920, sy = (.5 - sp.y * .5) * 1040;
    const D = stickTop.clone().applyMatrix4(cam.matrixWorldInverse).z * -1;
    placeOnCam(vendor, cam, A15.stick_top[0], A15.stick_top[1], sx, sy, .62 * .9 / dist, D, 6);
    const vu = vendor.u; vu.uLight.value.set(1, .86, .66); vu.uDarkC.value.copy(lin3('#26463F')); vu.uDarkAmt.value = .2; vu.uRimC.value.copy(lin3('#F3B136')); vu.uRimAmt.value = .8; vu.uRimDir.value.set(-1, -.4).normalize(); vu.uRimW.value = texPx(vendor, 6);
    // 陆蔚的后脑和肩：左边，暗，虚约 16K，带琥珀轮廓光
    shoulder.group.visible = true;
    placeOnCam(shoulder, cam, 225, 175, 250, 420, 1.6, .45, -4);
    const su = shoulder.u; su.uLight.value.set(.25, .22, .2); su.uBlur.value = texPx(shoulder, 16); su.uRimC.value.copy(lin3('#F3B136')); su.uRimAmt.value = .8; su.uRimDir.value.set(1, -.3).normalize(); su.uRimW.value = texPx(shoulder, 8); su.uDesat.value = .3;
    // 摊主本人的剪影（极虚），脸上也戴着同一张面具
    vendorSil.group.visible = true;
    placeWorld(vendorSil, cam, 256, 768, V3(.55, -.1, -2.6).applyMatrix4(cam.matrixWorld).setY(0), 1.8);
    vendorSil.u.uLight.value.set(.04, .035, .03); vendorSil.u.uRimC.value.copy(lin3('#F3B136')); vendorSil.u.uRimAmt.value = .7; vendorSil.u.uRimDir.value.set(-1, -.2); vendorSil.u.uRimW.value = texPx(vendorSil, 3);
    vendorMask.visible = true; vendorMask.position.copy(vendorSil.group.position).add(V3(0, .45, .1)); vendorMask.quaternion.copy(cam.quaternion); vendorMask.rotateY(0);
    // 背景：人群更远一些
    crowd.visible = true; layoutCrowd(f, cam);
    // 扫光带：第 4 轮（qa2-04）整体推后 2 帧——亮带在 f311（全曲最强的起音 12.94 秒）正好扫过面具中心（原来 f309 最亮，早约 65 ms）；闪粉 f309–f315
    sweepU.uK.value = clamp((f - 309) / 4); sweepU.uA.value = f >= 309 && f <= 314 ? 1 : 0;
    glitU.uT.value = Math.floor(f / 2); glitU.uA.value = f >= 309 ? 1 : 0; glitU.uC.value.set(sx, sy - 120, 240, 0);
    heroU.uGlit.value = f >= 309 ? 1 : 0; heroU.uLight.value.set(.92, .08, .1).normalize();   // 侧光：明暗交界从面具中间穿过，看得出体积
    // 发光眼：5 对，按哈希一拍二眨
    // 返修 tech-07：去掉落在陆蔚后颈上的那一对；其余几对按所在深度虚成 8–14K 的软亮点、调暗
    const EP = [[1700, 260, 11], [1500, 720, 9], [380, 180, 13], [1820, 560, 10]];
    eyeU.uN.value = 8;
    EP.forEach(([x, y, b], i) => { const blink = hashi(Math.floor(f / 2) * 7 + i) < .12 ? .15 : 1; eyeU.uE.value[i * 2].set(x - 13, y, b, blink); eyeU.uE.value[i * 2 + 1].set(x + 13, y, b, blink); });
    const zf = dist;
    return { scene, camera: cam, dof: { zf, cocScale: 18, cocMax: 24, rfg: 20 }, overlay: ov };
  };
  // S3c 指尖与假斑（f315–f332）：侧面大特写
  const A13 = M('A13')['锚点'], A14 = M('A14')['锚点'];
  shots.S3c = (f, t) => {
    const tc = tcOf(f);
    hideS(); common(t, tc);
    cam.fov = 11.14; cam.updateProjectionMatrix();
    aim(V3(.01 * ss((f - 315) / 17), 1.5, 1.0), 0, 0);
    // 面具边缘（左），三枚一模一样的梅花印
    hero.visible = true;
    hero.position.copy(V3(-.095, 1.505, 1.0 - .38)); hero.quaternion.identity(); hero.rotateY(-50 * DEG); hero.rotateZ(4 * DEG); hero.scale.setScalar(1.0);
    crowd.visible = false;
    // 陆蔚的右手（A13 水平镜像，朝左伸）
    const k = tc * 24;
    const slide = 60 * (1 - eo(seg(k, 315, 319)));
    const tremble = k >= 319 && k < 325 ? (Math.floor(f / 2) % 2 ? 1 : -1) : 0;
    const fist = k >= 325;
    const ret = ss(seg(k, 325, 332));
    const tipX = 930 + slide + 600 * ret * .8, tipY = 560 + tremble + 600 * ret * .6;
    const S = fist ? handF : handO; S.group.visible = true;
    const A = fist ? A14 : A13;
    const tipA = fist ? A14['index_tip（卷起的食指前端）'] : A13.index_tip;
    placeOnCam(S, cam, tipA[0], tipA[1], tipX, tipY, 1.15, .35, -10 * ret, true);
    const u = S.u; u.uLight.value.set(1, .86, .66); u.uDarkC.value.copy(lin3('#26463F')); u.uDarkAmt.value = .35; u.uRimC.value.copy(lin3('#F3B136')); u.uRimAmt.value = .9; u.uRimDir.value.set(1, -.2).normalize(); u.uRimW.value = texPx(S, 7); u.uTc.value = tc;
    u.uSpotXf.value.set(-10 * ret * DEG, 1);   // 第 4 轮（zs-01）：精灵是水平镜像的——墨环换回屏幕方向，和母题同一个朝向
    setSpots(S, [{ x: tipA[0] - texPx(S, 58), y: tipA[1] + texPx(S, 14), r: texPx(S, 30), kind: 3, seed: 7, soft: .05, alpha: fist ? .3 : 1 }]);
    heroU.uLight.value.set(-.75, .35, -.25).normalize();   // 返修 style-05：侧逆光，近处的金面落在半影里（S3c 鲜亮色 ≤ 25%）
    // 左下：摊主握签的手指（虚约 20K）
    vendorFing.group.visible = true;
    placeOnCam(vendorFing, cam, 300, 360, 260, 960, 1.1, .3, -20);
    const vu = vendorFing.u; vu.uLight.value.set(1, .86, .66); vu.uBlur.value = texPx(vendorFing, 20); vu.uDarkC.value.copy(lin3('#26463F')); vu.uDarkAmt.value = .3;
    return { scene, camera: cam, dof: { zf: .36, cocScale: 6, cocMax: 24 } };
  };
  // S3d 面具眼孔·他走回雾里（f332–f356）
  shots.S3d = (f, t) => {
    const tc = tcOf(f);
    hideS(); common(t, tc);
    const s = f < 342 ? 0 : Math.pow((f - 342) / 14, 2);
    cam.fov = 27.4; cam.updateProjectionMatrix();
    aim(V3(-.3 * s, 1.6, 1.0 - 3.5 * s), 6 * DEG * s, 0);
    // 返修 story-12 / style-12：f332–f346 眼孔里还是夜——上面是夜空，雾墙只是街尽头一条亮带，他从暗处走进亮带；f346 起雾墙才铺满
    fogWall.visible = true; wallU.uT.value = t;
    const bandK = 1 - ss(seg(f, 344, 352));
    // 第 2 轮（style-12）：f344 以前雾墙只是街尽头地平线上一条矮带（0–1.6 m），眼孔上半是夜色梯度
    fogWall.position.set(0, lerp(.75, 2, 1 - bandK), -26); fogWall.scale.set(60, lerp(1.7, 12, 1 - bandK), 1); wallU.uBand.value = bandK;
    // 陆蔚剪影：1,2,3,2,3,2（每档 4 帧），从 6 m 走到 9 m
    const ph = Math.floor((f - 332) / 4); const pose = [0, 1, 2, 1, 2, 1][clamp(ph, 0, 5)];
    walkers.forEach((S, i) => { S.group.visible = i === pose; });
    const S = walkers[pose];
    const zz = lerp(6, 9, (f - 332) / 24);
    placeWorld(S, cam, S.w / 2, 681, V3(-.25, 0, 1.0 - zz), 1.75 * 684 / 660);
    const u = S.u; u.uLight.value.set(.6, .55, .5); u.uFogC.value.copy(lin3('#E9E2D8')); u.uFogAmt.value = .8 * ss((f - 332) / 20); u.uRimC.value.copy(lin3('#F3B136')); u.uRimAmt.value = .4; u.uRimDir.value.set(1, -.4).normalize(); u.uRimW.value = texPx(S, 3);
    // 面具内壁（屏幕层）：f332–f342 只有 ±0.5% 呼吸；f342–f356 绕左孔中心放大 1.0 → 3.2
    interiorU.uOn.value = 1;
    interiorU.uS.value = (f < 342 ? 1 + .005 * Math.sin(t * 2.5) : 1 + 8 * s);
    interiorU.uPc.value.set(lerp(760, 960, ss(seg(f, 342, 354))), lerp(500, 520, ss(seg(f, 342, 354))));
    fogQ.visible = true; fogQU.uT.value = t; fogQU.uA.value = ss(seg(f, 346, 355));
    return { scene, camera: cam, dof: { zf: 8, cocScale: 22, cocMax: 14 }, overlay: ov };   // 近处灯笼虚成散景，远处剪影清楚
  };
  return { scene, cam, shots };
}
