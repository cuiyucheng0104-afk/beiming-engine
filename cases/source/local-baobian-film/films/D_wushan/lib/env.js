// 《豹变》D 雾山 · 环境件：雾面、云带、云层、远山底板、天穹、太阳圆盘、辉光
// 都是 3D 空间里的面片（镜头动时有真实视差），着色器里只用坐标的纯函数噪声。
import * as THREE from 'three';
import { GLSL, VS_MESH } from './glsl.js';
import { lin3 } from './util.js';

const VS_UV = /* glsl */`varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const tag = (m, order, occ = false) => { m.renderOrder = order; m.frustumCulled = false; m.userData.outline = false; m.userData.outlineOccluder = occ; return m; };

// ───── 雾面：竖直大面片，3 八度 fbm，上缘横拉 4:1 干笔撕边，下缘柔化（DESIGN 3.6）─────
const FOG_FS = /* glsl */`
${GLSL}
uniform vec3 uCol, uColTop; uniform float uOp, uSeed, uTop, uTear, uBot, uDens, uNs, uTearA, uFall;
uniform vec2 uSize, uDrift;
uniform vec4 uHole;   // 撕开：x 中心 u, y 半宽（0 不开）, z 边缘噪声, w 扩张
uniform vec2 uFloor;  // 地面高度、往上渐显的高度（雾片和地面相交处不出硬线）
varying vec2 vUv; varying vec3 vW;
void main(){
  vec2 m = vUv * uSize + uDrift;              // 米
  vec2 p = m / uNs + uSeed * 13.7;
  float n = fbm3o(p * vec2(.55, 1.2));
  float a = smoothstep(.35 - uDens, .75 - uDens, n);
  float v = vUv.y;
  float tear = (vnoise2(vec2(p.x * .9, uSeed + 3.)) - .5) * uTear + (vnoise2(vec2(p.x * 3.6, p.y * .9 + uSeed)) - .5) * uTear * .45;
  float top = uTop + tear;
  float edge = 1. - smoothstep(top - .035, top + .006, v);
  // 干笔：上缘内侧一条断续的亮边
  a *= edge;
  a *= smoothstep(0., uBot, v);
  a = mix(a, max(a, edge * smoothstep(0., uBot, v) * .55), uTearA);
  if (uHole.y > 0.) {
    float du = abs(vUv.x - uHole.x) - uHole.y * (1. + (vnoise2(vec2(vUv.y * 6., uSeed)) - .5) * uHole.z);
    a *= smoothstep(-.02, .06, du);
  }
  if (uFloor.y > 0.) a *= smoothstep(uFloor.x, uFloor.x + uFloor.y, vW.y);
  // 竖向雾瀑纹（ref_05）：雾片里一道道往下垂的纱
  if (uFall > 0.) a *= mix(1., .45 + .55 * smoothstep(.25, .75, vnoise2(vec2(p.x * 7., p.y * .35 + uSeed))), uFall);
  vec3 c = mix(uCol, uColTop, smoothstep(.2, .9, v));
  gl_FragColor = vec4(c, a * uOp);
}`;
export function fogSheet({ w = 200, h = 40, col = '#D5E2DA', colTop = null, op = .7, seed = 1, top = .8, tear = .18, bot = .15, dens = 0, ns = 18, order = 4, tearA = .3 } = {}) {
  const u = {
    uCol: { value: lin3(col) }, uColTop: { value: lin3(colTop || col) }, uOp: { value: op }, uSeed: { value: seed }, uTop: { value: top }, uTear: { value: tear }, uBot: { value: bot },
    uDens: { value: dens }, uNs: { value: ns }, uSize: { value: new THREE.Vector2(w, h) }, uDrift: { value: new THREE.Vector2() }, uHole: { value: new THREE.Vector4() }, uTearA: { value: tearA }, uFloor: { value: new THREE.Vector2(0, 0) }, uFall: { value: 0 },
  };
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS_UV, fragmentShader: FOG_FS, transparent: true, depthWrite: false }));
  m.userData.u = u;
  return tag(m, order, 'soft');
}

// ───── 云带：水平细长带（俯看是宽带，平看是细线），两端收尖，40% 成对 ─────
const RIB_FS = /* glsl */`
${GLSL}
uniform vec3 uCol, uCore; uniform float uOp, uSeed, uPair, uBreak, uMinA;
varying vec2 vUv; varying vec3 vW;
void main(){
  float u = vUv.x, v = vUv.y;
  // 沿长度：两端收尖，中段按噪声断续
  float taper = smoothstep(0., .18, u) * smoothstep(1., .82, u);
  float br = vnoise2(vec2(u * 7. + uSeed * 7., uSeed)) * .6 + vnoise2(vec2(u * 23. + uSeed, uSeed * 2.)) * .4;
  float tw = sqrt(taper) * (.65 + .35 * br);
  float y = (v - .5) * 2.;
  // 横向：软的纱 + 上沿一条细的亮线（云带上沿较利）
  float wob = (vnoise2(vec2(u * 11., uSeed + 5.)) - .5) * .35;
  float body = exp(-pow((y + wob) / max(tw * .62, .02), 2.));
  float line = (1. - smoothstep(0., .09, abs(y + wob - .42 * tw))) * step(.15, tw);
  float a = body * .8 + line * .55 * uPair;
  a *= mix(1., smoothstep(.22, .6, br), uBreak);
  vec3 c = mix(uCol, uCore, clamp(body * .6 + line, 0., 1.));
  gl_FragColor = vec4(c, clamp(a, 0., 1.) * uOp);
}`;
// 云带的顶点：沿长度方向细分 24 段，中心线按低频正弦起伏（uBend：面片坐标里的起伏量 = 起伏像素 / 粗细像素）
const RIB_VS = /* glsl */`uniform float uBend, uSeed; varying vec2 vUv; varying vec3 vW;
void main(){ vUv = uv; vec3 p = position; float u = uv.x;
  p.y += uBend * (.6 * sin(u * 8.17 + uSeed * 3.1) + .4 * sin(u * 16.9 + uSeed * 7.3)) * sin(3.14159 * u);
  vec4 w = modelMatrix * vec4(p, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
export function ribbon({ len = 1, wid = 1, col = '#E6EDE4', core = '#F3F6EE', op = .9, seed = 1, pair = false, brk = .5, order = 5, vertical = false } = {}) {
  // 几何是单位面片 × (len, wid)；摆放时通常直接改 scale
  const u = { uCol: { value: lin3(col) }, uCore: { value: lin3(core) }, uOp: { value: op }, uSeed: { value: seed }, uPair: { value: pair ? 1 : 0 }, uBreak: { value: brk }, uMinA: { value: 0 }, uBend: { value: 0 } };
  const m = new THREE.Mesh(new THREE.PlaneGeometry(len, wid, 24, 1), new THREE.ShaderMaterial({ uniforms: u, vertexShader: RIB_VS, fragmentShader: RIB_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  if (!vertical) m.rotation.x = -Math.PI / 2;
  m.userData.u = u;
  return tag(m, order, 'soft');
}

// ───── 云层 / 云海：水平大面片，fbm 两阶软边（受光顶 / 背光底），朝光一侧亮（密度的方向导数） ─────
const CLOUD_FS = /* glsl */`
${GLSL}
uniform vec3 uLit, uShade, uUnder, uUnder2, uRimC; uniform float uThr, uOp, uScale, uSeed, uFeather, uPaper, uHoleOn, uFadeR, uUnderMix, uTorn, uRimA;
uniform vec2 uSun, uOff; uniform vec4 uHole;   // 洞：中心 xz, 半尺寸 xz
varying vec2 vUv; varying vec3 vW;
void main(){
  vec2 p = (vW.xz + uOff) / uScale + uSeed * 11.3;
  float n = fbm2(p * vec2(1., .7));
  float n2 = fbm2(p * vec2(1., .7) + uSun * .12);
  // 撕边：横拉的干笔噪声扰动阈值（uTorn）
  float torn = uTorn > 0. ? (vnoise2(vec2(p.x * 9., p.y * 2.2) + uSeed) - .5) * uTorn + (vnoise2(p * 23. + uSeed * 3.) - .5) * uTorn * .45 : 0.;
  float a = smoothstep(uThr - uFeather, uThr + uFeather, n + torn);
  float lit = smoothstep(-.012, .012, n - n2);
  vec3 c = mix(uShade, uLit, lit);
  c = mix(c, uLit, smoothstep(uThr + .12, uThr + .3, n) * .5);
  // 受光顶面的边：一线金
  if (uRimA > 0.) c = mix(c, uRimC, (1. - smoothstep(uThr + .0, uThr + .05, n + torn)) * a * uRimA);
  if (cameraPosition.y < vW.y) {
    // 从下面看：底面暗青团块（两阶），不是一片平涂
    float un = fbm2(p * vec2(1.6, 1.1) + 5.);
    c = uUnderMix > 0. ? mix(uUnder, uUnder2, smoothstep(.48, .52, un) * uUnderMix) : uUnder;
    c = mix(c, uLit * .9, (1. - smoothstep(uThr, uThr + .06, n + torn)) * uUnderMix * .55);   // 薄的边透光
  }
  if (uPaper > 0.) {
    // 纸色 + 纸纤维（T1 的纸云层）
    float fib = vnoise2(vec2(vW.x * .9, vW.z * .07)) * .6 + vnoise2(vec2(vW.x * 3.1, vW.z * .25)) * .4;
    vec3 paper = vec3(.768, .667, .478) * (.92 + .16 * fib);
    c = mix(c, paper, uPaper);
  }
  if (uFadeR > 0.) a *= 1. - smoothstep(uFadeR * .55, uFadeR, length(vW.xz - cameraPosition.xz));
  if (uHoleOn > .5) {
    vec2 d = abs(vW.xz - uHole.xy) / uHole.zw;
    float e = max(d.x, d.y) + (vnoise2(vW.xz * .2) - .5) * .25;
    a *= smoothstep(.85, 1.15, e);
  }
  gl_FragColor = vec4(c, a * uOp);
}`;
export function cloudLayer({ size = 3000, lit = '#F6EBCB', shade = '#BFD0C8', under = '#BFD0C8', thr = .5, op = 1, scale = 60, seed = 1, feather = .08, order = 3 } = {}) {
  const u = { uLit: { value: lin3(lit) }, uShade: { value: lin3(shade) }, uUnder: { value: lin3(under) }, uUnder2: { value: lin3(under) }, uUnderMix: { value: 0 }, uRimC: { value: lin3('#FFE08A') }, uRimA: { value: 0 }, uTorn: { value: 0 },
    uThr: { value: thr }, uOp: { value: op }, uScale: { value: scale }, uSeed: { value: seed },
    uFeather: { value: feather }, uSun: { value: new THREE.Vector2(.7, .7) }, uOff: { value: new THREE.Vector2() }, uPaper: { value: 0 }, uHoleOn: { value: 0 }, uHole: { value: new THREE.Vector4(0, 0, 10, 30) }, uFadeR: { value: 0 } };
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size, 1, 1), new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS_UV, fragmentShader: CLOUD_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2;
  m.userData.u = u;
  return tag(m, order, 'soft');
}


// ───── 云团（竖直面片）：翻滚的一排排团块，每一团受光的顶面亮、带金边，下面落进暗档（#13 低机位看云海）─────
const BANK_FS = /* glsl */`
${GLSL}
uniform vec3 uLit, uShade, uRim, uDeep; uniform float uSeed, uOp, uRows, uCell; uniform vec2 uOff, uSizePx;
varying vec2 vUv;
// 一排积云的顶缘：一个个圆鼓鼓的团（半圆压扁），半径、高低随机——不是一条波浪线
float scallop(float X, float c, float s, out float idx){
  float gi = floor(X / c), best = -1e3; idx = 0.;
  for (int j = -1; j <= 1; j++) {
    float cc = gi + float(j);
    float h1 = hash12(vec2(cc, s)), h2 = hash12(vec2(cc, s + 3.7));
    float cx = (cc + .5 + (h1 - .5) * .5) * c, rr = c * (.55 + .5 * h2);
    float dx = X - cx;
    float v = rr * rr - dx * dx;
    if (v > 0.) { float hgt = sqrt(v) * .62 + (h1 - .5) * c * .25; if (hgt > best) { best = hgt; idx = cc; } }
  }
  return best;
}
void main(){
  vec2 P = vec2(vUv.x * uSizePx.x + uOff.x, vUv.y * uSizePx.y);
  vec3 col = uDeep; float a = 0.;
  for (int k = 0; k < 5; k++) {
    float fk = float(k);
    if (fk >= uRows) break;
    float base = uSizePx.y * (.72 - fk * (.62 / max(uRows - 1., 1.)));
    float c = uCell * (1. + fk * .3);
    float id;
    float top = base + scallop(P.x + fk * 137., c, uSeed + fk * 5.1, id);
    float dd = top - P.y;                      // 顶缘往下的距离（px）
    float aa = 1.2;
    float inside = smoothstep(-aa, aa, dd);
    if (inside <= 0.) continue;
    float n = vnoise2(vec2(P.x / c * 2., fk + uSeed));
    float lit = 1. - smoothstep(c * (.10 + .08 * n), c * (.16 + .08 * n), dd);
    vec3 cl = mix(uShade, uLit, lit);
    cl = mix(cl, uRim, (1. - smoothstep(0., 2.5, dd)) * .9);
    col = mix(col, cl, inside); a = max(a, inside);
  }
  gl_FragColor = vec4(col, a * uOp);
}`;
export function cloudBank({ lit = '#F6E0A0', shade = '#C79A55', rim = '#FFE08A', deep = '#8A5A2A', rows = 4, cell = 120, seed = 1, order = 2, op = 1 } = {}) {
  const u = { uLit: { value: lin3(lit) }, uShade: { value: lin3(shade) }, uRim: { value: lin3(rim) }, uDeep: { value: lin3(deep) }, uSeed: { value: seed }, uOp: { value: op }, uRows: { value: rows }, uCell: { value: cell },
    uOff: { value: new THREE.Vector2() }, uSizePx: { value: new THREE.Vector2(1000, 200) } };
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS_UV, fragmentShader: BANK_FS, transparent: true, depthWrite: false }));
  m.userData.u = u;
  return tag(m, order, 'soft');
}

// ───── 云团公告板（返修 2，#14 三层云 / 金色云海、#15 山间云）─────
//   一团积云 = 底排 3 个宽圆 + 顶上 2–4 个鼓包（底是平的），永远正对镜头，所以没有面片的直边、没有掠射角拉丝；
//   两阶硬边：按每个鼓包自己的外法线对屏幕上的太阳方向分亮 / 影（团块感），鼓包之间留一道叠压线，
//   朝光一侧顶缘一线亮边，上缘是横拉的干笔撕边；从下面看是暗青（背光一侧）/ 暖灰赭（朝光一侧）的云底
const PUFF_FS = /* glsl */`
${GLSL}
uniform vec3 uLit, uShade, uUnder, uUnder2, uRimC, uRimU, uHazeC;
uniform float uSeed, uOp, uBelow, uHaze, uNearA, uTorn, uCrease, uLitW, uRimA;
uniform vec2 uSun;
varying vec2 vUv;
void main(){
  vec2 p = (vUv - .5) * 2.;
  // 鼓包：0–2 是底排（在后），3–6 是顶上的（在前）；像素归"最前面那个盖住它的鼓包"
  float d = 1e3; vec2 oc = vec2(0., -.2); float orad = .4, own = -1.;
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float h1 = hash12(vec2(uSeed * 1.37, fi * 3.1 + 1.)), h2 = hash12(vec2(fi * 1.7 + 2., uSeed * .71)), h3 = hash12(vec2(fi + 9.3, uSeed * 2.3));
    vec2 c; float r;
    if (i < 3) { c = vec2(-.46 + fi * .46 + (h1 - .5) * .14, -.18 + (h2 - .5) * .1); r = .29 + .1 * h3; }
    else { c = vec2((h1 - .5) * .9, .06 + .28 * h2); r = .17 + .14 * h3; if (i > 4 && hash12(vec2(uSeed, fi + 5.)) < .45) continue; }
    float di = length(p - c) - r;
    d = min(d, di);
    if (di < 0.) { oc = c; orad = r; own = fi; }
  }
  // 平底（略带起伏）
  float fb = -.38 + (vnoise2(vec2(p.x * 3. + uSeed, 1.)) - .5) * .06 - p.y;
  d = max(d, fb);
  // 上缘：横拉的干笔撕边（只在朝上的边）
  float up = smoothstep(-.1, .4, p.y - oc.y);
  d += uTorn * up * ((vnoise2(p * vec2(7., 2.2) + uSeed * 3.1) - .5) * 1.1 + (vnoise2(p * vec2(23., 6.) + uSeed) - .5) * .45);
  float aa = max(fwidth(d), 1e-4) * 1.2 + .002;
  float a = 1. - smoothstep(-aa, aa, d);
  if (a < .003) discard;
  // 每个鼓包朝光一侧的月牙：往太阳方向挪 uLitW·r 以后出了这个鼓包 → 受光（两阶硬边，交界跟着鼓包的圆弧走）
  float wob = (vnoise2(p * 6. + uSeed * 1.3) - .5) * .05;
  float litTop = smoothstep(-.012, .012, length(p + uSun * orad * uLitW - oc) - orad + wob);
  float litBot = smoothstep(-.012, .012, length(p + uSun * orad * .32 - oc) - orad + wob);
  // 叠压线：前面的鼓包压在后面的上面，鼓包的弧边在形体里面留一道暗线
  float cr = (1. - smoothstep(0., .011 + aa, abs(length(p - oc) - orad))) * step(d, -.03) * step(0., own - 2.5) * uCrease;
  // 外轮廓朝光的一侧一线亮
  float rim = (1. - smoothstep(0., .024 + aa, -d)) * smoothstep(.15, .55, dot(normalize(p - oc + 1e-5), uSun));
  vec3 top = mix(uShade, uLit, litTop);
  top = mix(top, uShade * .86, cr);
  top = mix(top, uRimC, rim * uRimA);
  vec3 bot = mix(uUnder2, uUnder, litBot);
  bot = mix(bot, uUnder2 * .78, cr);
  bot = mix(bot, uRimU, rim * uRimA);
  vec3 c = mix(top, bot, uBelow);
  c = mix(c, uHazeC, uHaze);
  gl_FragColor = vec4(c, a * uOp * uNearA);
}`;
export function cloudPuff({ seed = 1, order = 12, sun = null, torn = .05 } = {}) {
  const u = { uLit: { value: lin3('#F6EBCB') }, uShade: { value: lin3('#BFD0C8') }, uUnder: { value: lin3('#7C6A50') }, uUnder2: { value: lin3('#24404A') },
    uRimC: { value: lin3('#FFE08A') }, uRimU: { value: lin3('#E6C68A') }, uHazeC: { value: lin3('#EEF3E8') },
    uSeed: { value: seed }, uOp: { value: 1 }, uBelow: { value: 0 }, uHaze: { value: 0 }, uNearA: { value: 1 }, uTorn: { value: torn }, uCrease: { value: 1 }, uLitW: { value: .8 }, uRimA: { value: .9 },
    uSun: sun || { value: new THREE.Vector2(-.7, .7) } };
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS_UV, fragmentShader: PUFF_FS, transparent: true, depthWrite: false }));
  m.userData.u = u;
  tag(m, order, 'soft');
  m.frustumCulled = true;
  return m;
}

// ───── 云块（返修 3，#13 金雾云海、#14 三层云、金色云海）─────
//   取代返修 2 的 cloudPuff（两色平涂椭圆 + 平移出来的同形月牙 = 剪贴画祥云）：
//   · 形：3–7 个软团的密度场叠加（不是一个个圆）+ 域扭曲，轮廓像湿笔晕开；下缘按高度化进雾（没有平底），上缘横拉干笔撕边
//   · 光：把密度当高度求形体法线，受光 / 背光柔和过渡；逆光时厚的云心暗、薄边透光；只在朝太阳的外轮廓留一线 2–3 px 的硬金边
//   · 笔触：横拉的干笔皴（宽 6–14 px），亮暗 ±9%，薄处露出底色；外沿有几缕横拉的云丝
//   永远正对镜头，面片四边兜底渐隐，所以没有任何直边
const MASS_FS = /* glsl */`
${GLSL}
uniform vec3 uLit, uShade, uDeep, uUnder, uUnder2, uRimC, uGlowC, uHazeC;
uniform float uSeed, uAsp, uOp, uNearA, uBelow, uHaze, uBack, uTex, uRimA, uGlowA, uThr, uTorn, uSoft, uLobes, uStreak, uWisp, uHump, uForm, uDbg, uPad, uK, uEdgeW;
uniform vec2 uSun;
varying vec2 vUv;
float field(vec2 q, out vec2 g){
  float D = 0.; g = vec2(0.);
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    if (fi >= uLobes) break;
    float h1 = hash12(vec2(uSeed * 1.37 + 3.1, fi * 3.1 + 1.)), h2 = hash12(vec2(fi * 1.7 + 2., uSeed * .71 + 5.)), h3 = hash12(vec2(fi + 9.3, uSeed * 2.3 + 1.));
    float xr = uLobes > 1.5 ? fi / (uLobes - 1.) * 2. - 1. : 0.;
    float hump = 1. - xr * xr;
    vec2 c = vec2(xr * max(uAsp - 1., .05) + (h1 - .5) * .35, -.18 + uHump * hump * (.45 + .55 * h2) + (h2 - .5) * .14);
    float r = (.28 + .22 * hump) * (.75 + .5 * h3);
    vec2 d = q - c; float e = exp(-dot(d, d) / (r * r));
    D += e; g += e * (-2. / (r * r)) * d;
  }
  return D;
}
void main(){
  vec2 p = (vUv - .5) * 2.;
  vec2 q = vec2(p.x * uAsp, p.y) * uPad;        // 面片比云大 uPad 倍（摆放时同样放大），云的软边和云丝再怎么扭也碰不到面片边（碰到就会被截出横直线）
  vec2 w = vec2(fbm2i(q * 1.4 + uSeed * 3.7), fbm2i(q * 1.4 + uSeed * 3.7 + 5.2)) - .5;
  vec2 g; float D = field(q + w * .3, g);
  D += (fbm2i(q * 3.1 + uSeed * 1.3) - .5) * .22;                                         // 小一级的鼓包（轮廓上的碎团）
  // 下缘化进雾：只淡 alpha（不乘进密度——乘进密度再取阈值会在下缘截出一条锐利的横直线，即"平底"）
  float bot = smoothstep(-1.05, -.2, q.y + (vnoise2i(vec2(q.x * 1.3 + uSeed, 2.)) - .5) * .45);
  float upk = smoothstep(-.1, .5, q.y);
  // 返修 3：撕边、云丝、薄处的笔触都沿轮廓走（切向拉长）——左右两侧的竖边不再出现一行行错开的"横向拉丝"
  float gl0 = max(length(g), 1e-4); vec2 nrm = -g / gl0, tng = vec2(-nrm.y, nrm.x);
  vec2 qc = vec2(dot(q, tng), dot(q, nrm));
  // 撕边：上缘横拉（干笔），侧边和下缘基本各向同性——不再有一行行错开的拉丝
  //   注意：不能用随高度变化的系数去缩放坐标（q * mix(..., upk)）——那样噪声坐标随 y 剪切，侧边会出现一行行错开的横纹；这里是把两种噪声的值按高度混合
  float tIso = (vnoise2i(q * 4. + uSeed * 3.1) - .5) + (vnoise2i(q * 10.4 + uSeed) - .5) * .5;
  float tAni = (vnoise2i(q * vec2(2.6, 8.) + uSeed * 1.7) - .5) + (vnoise2i(q * vec2(6.8, 21.) + uSeed * .3) - .5) * .5;
  float topE = smoothstep(.35, .85, nrm.y) * smoothstep(.3, 1.2, gl0);    // 只有朝上的边（轮廓法线向上）才横拉；竖边横拉就会一行行错开
  float tear = mix(tIso, tAni, topE) * uTorn * (.3 + .7 * upk);
  // 面片边内的密度衰减（超椭圆）：密度在碰到面片边之前就降到阈值以下，轮廓在那里自然收圆，不会被面片边截成直线
  float ef = 1. - smoothstep(.6, .96, pow(pow(abs(p.x), 3.) + pow(abs(p.y), 3.), 1. / 3.));
  float Db = D * ef, Dt = Db + tear * ef;
  if (uDbg > .5) { float aa0 = smoothstep(uThr - uSoft, uThr + uSoft, Dt) * bot * smoothstep(1., .82, abs(p.x)) * smoothstep(1., .8, abs(p.y)); gl_FragColor = uDbg < 1.5 ? vec4(1., 0., 0., aa0) : uDbg < 2.5 ? vec4(vec3(fract(D * 3.)), 1.) : uDbg < 3.5 ? vec4(vec3(fract(w.x * 8.)), 1.) : vec4(fract(q * .5), 0., 1.); return; }
  float fw = max(fwidth(Dt), 1e-5);
  float a0 = smoothstep(uThr - uSoft - fw, uThr + uSoft + fw, Dt), a = a0 * bot;
  float wisp = smoothstep(.6, .88, mix(vnoise2i(q * 4.5 + w * 1.5 + uSeed * 1.9), vnoise2i(q * vec2(2., 10.) + w * 1.5 + uSeed * 2.3), topE)) * smoothstep(uThr - .3, uThr - .06, Dt) * (1. - a0) * bot;
  a = max(a, wisp * uWisp);
  if (a < .003) discard;
  vec2 L2 = normalize(uSun + 1e-5);
  float gl = max(length(g), 1e-4);
  vec3 n = normalize(vec3(-g * .18, 1.));
  float face = smoothstep(-.15, .7, dot(-g / gl, L2));
  float thick = smoothstep(uThr + .1, uThr + 1.2, Db);
  float nz = (vnoise2i(q * 2.2 + uSeed) - .5) * .3;
  // 到轮廓的像素距离（密度差 / 屏幕导数）：团与团之间的鞍部密度也接近阈值，但梯度小、像素距离大，不会被当成"薄边"去提亮（否则云里会冒出一块块菱形亮斑）
  float px = (Dt - uThr) / fw;
  float lobeLit = smoothstep(-.4, .6, dot(n.xy, L2) * 1.1 + .2 * (1. - uBack) + nz);
  float edgeLit = smoothstep(.0, .8, face * (1. - smoothstep(0., uEdgeW * uK, px)) + nz * .6);   // 朝光的一圈（约 uEdgeW px 宽），宽度不随云大小变
  float lit = mix(edgeLit, lobeLit, uForm);
  vec3 c = mix(uShade, uLit, lit);
  c = mix(c, uDeep, thick * uBack * .75 * (1. - lit * .6));
  float thin = (1. - smoothstep(1., 24. * uK, px)) * smoothstep(.6, 1., bot);
  c += uGlowC * thin * face * uGlowA;
  float line = (1. - smoothstep(1.4, 3.2, px)) * step(-.5, px) * face * smoothstep(.8, 1., bot);   // 下缘化开的那条边不描金线
  float st = vnoise2i(q * vec2(uStreak * .45, uStreak) + uSeed * 2.) * .6 + vnoise2i(q * vec2(uStreak * .9, uStreak * 2.1) + uSeed) * .4;
  float stc = vnoise2i(q * vec2(uStreak * .5, uStreak * .9) + uSeed * 2.7);
  float edgeK = (1. - smoothstep(uThr + .02, uThr + .3, Db)) * smoothstep(.4, 1.4, gl0);   // 沿轮廓的笔触只用在外沿一圈（云心的梯度没有方向，不用）
  c *= 1. + (st - .5) * .2 * uTex;
  a *= mix(1., smoothstep(.15, .6, stc), thin * .35 * uTex * edgeK);
  vec3 cb = mix(uUnder2, uUnder, lit) * (1. + (st - .5) * .16 * uTex);
  cb += uGlowC * thin * face * uGlowA * .8;
  c = mix(c, cb, uBelow);
  c = mix(c, uRimC, line * uRimA);
  c = mix(c, uHazeC, uHaze);
  a *= smoothstep(1., .82, abs(p.x)) * smoothstep(1., .8, abs(p.y));
  gl_FragColor = vec4(c, a * uOp * uNearA);
}`;
export function cloudMass({ seed = 1, order = 12, sun = null, asp = 2.4, lobes = 5, torn = .12, soft = .05, streak = 9, tex = 1, wisp = .3, hump = .35, form = .6, pad = 1.45 } = {}) {
  const u = { uLit: { value: lin3('#F6E6C0') }, uShade: { value: lin3('#C9A66E') }, uDeep: { value: lin3('#7A5226') }, uUnder: { value: lin3('#8E7858') }, uUnder2: { value: lin3('#2C4444') },
    uRimC: { value: lin3('#FFE6A0') }, uGlowC: { value: lin3('#FFD27A') }, uHazeC: { value: lin3('#F0C46A') },
    uSeed: { value: seed }, uAsp: { value: asp }, uOp: { value: 1 }, uNearA: { value: 1 }, uBelow: { value: 0 }, uHaze: { value: 0 }, uBack: { value: .7 }, uTex: { value: tex },
    uRimA: { value: .8 }, uGlowA: { value: .35 }, uThr: { value: .55 }, uTorn: { value: torn }, uSoft: { value: soft }, uLobes: { value: lobes }, uStreak: { value: streak }, uWisp: { value: wisp }, uHump: { value: hump }, uForm: { value: form }, uDbg: { value: 0 }, uPad: { value: pad }, uK: { value: innerHeight / 1040 }, uEdgeW: { value: 70 },
    uSun: sun || { value: new THREE.Vector2(-.7, .7) } };
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS_UV, fragmentShader: MASS_FS, transparent: true, depthWrite: false }));
  m.userData.u = u; m.userData.asp = asp; m.userData.pad = pad;
  tag(m, order, 'soft');
  m.frustumCulled = true;
  return m;
}
// 颜色一次设好（hex → 线性）
export function massCol(m, o) { const u = m.userData.u; for (const k in o) { const c = lin3(o[k]); u[k].value.copy(c); } }

// ───── 远山底板：天空按色差抠掉（天平涂 #FEF8E6），可调色（金色调、提亮、偏青） ─────
const PANO_FS = /* glsl */`
${GLSL}
uniform sampler2D uMap; uniform vec3 uSky; uniform float uKey, uOp, uSat, uLift, uBias, uEdge, uUseA; uniform vec3 uMul, uHaze, uHiC; uniform float uHazeAmt, uHazeLow;
uniform vec4 uCrop;   // 贴图 uv 裁切 u0, v0, du, dv
varying vec2 vUv;
void main(){
  vec2 uv = uCrop.xy + vUv * uCrop.zw;
  vec4 c = texture2D(uMap, uv, uBias);
  float d = length(c.rgb - uSky) * 255.;
  float a = smoothstep(uKey, uKey + 22., d) * smoothstep(0., .1, vUv.y);   // 下沿 10% 渐隐，免得底板的下边露出一条硬线
  if (uUseA > .5) a = smoothstep(.03, .92, c.a) * smoothstep(0., .04, vUv.y);   // 返修 3：透明底的单峰山卡按贴图 alpha
  if (uEdge > 0.) a *= smoothstep(0., uEdge, vUv.x) * smoothstep(1., 1. - uEdge, vUv.x);   // 山卡：左右两端也化掉
  // 上沿再收一点，避免抠像毛边
  vec3 s = c.rgb;
  float l = lumS(s);
  s = mix(vec3(l), s, uSat);
  // 返修 2：亮部（底板里的白雾）压成淡青灰（uHiC = 1 时不变），中山、远山不再发白
  s = mix(s, s * uHiC, smoothstep(.55, .92, l));
  vec3 col = srgb2lin(s) * uMul + uLift;
  col = mix(col, uHaze, clamp(uHazeAmt + uHazeLow * (1. - vUv.y), 0., 1.));
  gl_FragColor = vec4(col, a * uOp);
}`;
export function panoPlate(tex, { order = 1, sky = '#FEF8E6', key = 14 } = {}) {
  const sc = new THREE.Color(sky);   // sRGB 值比较（贴图按原值采样）
  const u = { uMap: { value: tex }, uSky: { value: new THREE.Vector3(...new THREE.Color().setStyle(sky, THREE.LinearSRGBColorSpace).toArray()) }, uKey: { value: key }, uOp: { value: 1 }, uSat: { value: 1 }, uLift: { value: 0 },
    uMul: { value: new THREE.Vector3(1, 1, 1) }, uHaze: { value: lin3('#E6EEE6') }, uHazeAmt: { value: 0 }, uHazeLow: { value: 0 }, uCrop: { value: new THREE.Vector4(0, 0, 1, 1) }, uBias: { value: 0 }, uEdge: { value: 0 }, uHiC: { value: new THREE.Vector3(1, 1, 1) }, uUseA: { value: 0 } };
  void sc;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS_UV, fragmentShader: PANO_FS, transparent: true, depthWrite: false }));
  m.userData.u = u; m.userData.aspect = tex.image.width / tex.image.height;
  return tag(m, order, false);
}

// ───── 天穹：按视线仰角的平涂渐变（只在背景，不写深度） ─────
const SKY_FS = /* glsl */`
${GLSL}
uniform vec3 uLow, uHigh, uSunCol; uniform vec3 uSunDir; uniform float uSunAmt, uSunPow; uniform vec2 uRange;
uniform float uRad; uniform vec3 uR0, uR1, uR2, uR3; uniform vec3 uRA;   // 以太阳为心的四段渐变（角度，弧度）
varying vec2 vUv; varying vec3 vW;
void main(){
  vec3 d = normalize(vW - cameraPosition);
  vec3 c = mix(uLow, uHigh, smoothstep(uRange.x, uRange.y, d.y));
  float s = max(dot(d, normalize(uSunDir)), 0.);
  if (uRad > .5) {
    float ang = acos(clamp(dot(d, normalize(uSunDir)), -1., 1.));
    c = mix(uR0, uR1, smoothstep(0., uRA.x, ang));
    c = mix(c, uR2, smoothstep(uRA.x, uRA.y, ang));
    c = mix(c, uR3, smoothstep(uRA.y, uRA.z, ang));
  }
  c += uSunCol * pow(s, uSunPow) * uSunAmt;
  gl_FragColor = vec4(c, 1.);
}`;
export function skyDome({ low = '#E6EEE6', high = '#D5E2DA', R = 7500 } = {}) {
  const u = { uLow: { value: lin3(low) }, uHigh: { value: lin3(high) }, uSunCol: { value: lin3('#FFE2A0') }, uSunDir: { value: new THREE.Vector3(0, .2, -1) }, uSunAmt: { value: 0 }, uSunPow: { value: 8 }, uRange: { value: new THREE.Vector2(0, .55) },
    uRad: { value: 0 }, uR0: { value: lin3('#F6E0A0') }, uR1: { value: lin3('#E99F21') }, uR2: { value: lin3('#69310C') }, uR3: { value: lin3('#411903') }, uRA: { value: new THREE.Vector3(.12, .45, .9) } };
  const m = new THREE.Mesh(new THREE.SphereGeometry(R, 48, 24), new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS_UV, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false }));
  m.userData.u = u;
  return tag(m, -10, false);
}

// ───── 太阳：剪纸圆盘（平涂 + 芯提亮 + 纸纤维边）+ 小晕（加色） ─────
const SUN_FS = /* glsl */`
${GLSL}
uniform vec3 uDisc, uCore, uHalo; uniform float uA, uHaloA, uR, uStretch, uSeed, uHDR;
varying vec2 vUv;
void main(){
  vec2 p = (vUv - .5) * 2.;           // 面片 = 晕的范围；圆盘半径 uR（相对）
  p.x /= uStretch;
  float r = length(p);
  float ang = atan(p.y, p.x);
  float fib = (vnoise2(vec2(cos(ang), sin(ang)) * 6. + uSeed) - .5) * .05 + (vnoise2(p * 40. + uSeed) - .5) * .02;
  float disc = 1. - smoothstep(uR - .012, uR + .012, r + fib * uR);
  vec3 c = mix(uDisc, uCore, 1. - smoothstep(0., uR * .55, r));
  float halo = exp(-r * r * 3.2) * uHaloA;
  gl_FragColor = vec4((c * disc * uHDR + uHalo * halo) * uA, clamp(disc * uA, 0., 1.));
}`;
export function sunDisc({ order = 0.6 } = {}) {
  const u = { uDisc: { value: lin3('#F3E6BE') }, uCore: { value: lin3('#FFF3D2') }, uHalo: { value: lin3('#F2DDAA') }, uA: { value: 1 }, uHaloA: { value: .35 }, uR: { value: .37 }, uStretch: { value: 1 }, uSeed: { value: 1 }, uHDR: { value: 1 } };
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS_UV, fragmentShader: SUN_FS, transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor }));
  m.userData.u = u;
  return tag(m, order, false);
}

// ───── 加色辉光（金雾、光晕） ─────
const GLOW_FS = /* glsl */`
uniform vec3 uCol; uniform float uA, uCore, uSquash;
varying vec2 vUv;
void main(){ vec2 d = (vUv - .5) * 2.; d.y *= uSquash; float r = length(d);
  // 返修 3（v2-03）：高斯项减掉它在面片边（r = 1）上的值再归一，辉光在面片边上正好是 0——加色面片不再留一条竖直接缝
  float g = max(exp(-r * r * 3.2) - .0408, 0.) / .9592 * .65 + exp(-r * r * 22.) * uCore + pow(max(1. - r, 0.), 3.) * .25;
  g *= 1. - smoothstep(.72, 1., length(vec2(d.x, d.y / max(uSquash, 1e-3))));   // 面片内切圆以外为 0（压扁的辉光上下边也不留硬边）
  gl_FragColor = vec4(uCol * g * uA, 1.); }`;
export function glow(colHex, { order = 3, a = 1, core = .5, squash = 1 } = {}) {
  const u = { uCol: { value: lin3(colHex) }, uA: { value: a }, uCore: { value: core }, uSquash: { value: squash } };
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS_UV, fragmentShader: GLOW_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  m.userData.u = u;
  return tag(m, order, false);
}

// 面片正对相机，放到屏幕设计像素 (cx, cy)、宽 wpx、深度 D（高按 aspect 或 hpx）
export function onScreen(mesh, cam, cx, cy, wpx, D, hpx) {
  const hh = D * Math.tan(cam.fov * Math.PI / 360), hw = hh * cam.aspect, Wd = 1040 * cam.aspect;
  const x = (cx - 960) / (Wd / 2) * hw, y = (0.5 - cy / 1040) * 2 * hh;
  const w = wpx / Wd * 2 * hw, h = hpx !== undefined ? hpx / 1040 * 2 * hh : w / (mesh.userData.aspect || 1);
  mesh.position.set(x, y, -D).applyMatrix4(cam.matrixWorld);
  cam.getWorldQuaternion(mesh.quaternion);
  mesh.scale.set(w, h, 1);
  return mesh;
}
export { VS_MESH };
