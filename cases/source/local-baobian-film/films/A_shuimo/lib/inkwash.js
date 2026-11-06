// 《豹变》A 水墨 · 3D 水墨材质（DESIGN 3.1）与几样程序着色的面片：六重山脊、雾片云片、剪纸日、画布面片
// 墨浓 D = Dbase + 0.85·(1−hl) + 凹度 + 皴 + 顶轮廓积墨 + 交界扰动 → 5 阶加纸查表，交界软且带噪声；没有投影、没有边缘光、不描线。
import * as THREE from 'three';
import { U } from './core.js';
import { NOISE, PALETTE, FOG } from './glsl.js';

const common = () => ({ uPal: U.uPal, uFogA: U.uFogA, uFogB: U.uFogB, uK: U.uK, uT: U.uT });

// ───────── 3D 水墨材质 ─────────
const INK_VS = /* glsl */`
attribute float aCav;
attribute float aTop;
varying vec3 vN, vW, vO; varying float vCav, vTop;
void main(){
  vTop = aTop;
  mat4 m = modelMatrix;
  #ifdef USE_INSTANCING
    m = modelMatrix * instanceMatrix;
  #endif
  vec4 wp = m * vec4(position, 1.);
  vW = wp.xyz; vO = position; vN = normalize(mat3(m) * normal); vCav = aCav;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
// 笔触基元：沿笔方向拉长的格子，每格一笔——起笔浓、收笔枯，两侧毛边，笔与笔之间留纸缝
//   uv 表面二维坐标（米，y 为行笔方向），L 笔长、Wd 笔宽（米）；返回 vec2(墨量, 覆盖)
export const BRUSH = /* glsl */`
vec2 brushCells(vec2 uv, float L, float Wd, float tilt, uint s){
  float best = 0., cov = 0.;
  float cx0 = floor(uv.x / Wd);
  for (int dx = -1; dx <= 1; dx++) {
    float cx = cx0 + float(dx);
    float offc = h21(ivec2(int(cx), 17), s);
    float gy = uv.y / L + offc;
    float cy0 = floor(gy);
    for (int dy = -1; dy <= 1; dy++) {
      float cy = cy0 + float(dy);
      ivec2 id = ivec2(int(cx), int(cy));
      float j1 = h21(id, s + 1u), j2 = h21(id, s + 2u), j3 = h21(id, s + 3u), j4 = h21(id, s + 4u), j5 = h21(id, s + 5u);
      if (j5 < .42) continue;                                         // 近一半格子空着：笔与笔之间留纸
      vec2 c = vec2((cx + .5 + (j1 - .5) * .5) * Wd, (cy + .5 - offc + (j2 - .5) * .4) * L);
      vec2 p = uv - c;
      float a = tilt * (j3 - .5) * 2.;
      p = vec2(cos(a) * p.x - sin(a) * p.y, sin(a) * p.x + cos(a) * p.y);
      float lf = L * (.55 + .5 * j4), wf = Wd * (.45 + .45 * j3);
      float t = .5 - p.y / lf;                                        // 0 起笔（上）→ 1 收笔（下）
      if (t < -.08 || t > 1.05) continue;
      float hw = wf * .5 * (.75 + .35 * sin(3.1416 * clamp(t, 0., 1.))) * (1. - .45 * clamp(t, 0., 1.));
      float fz = vn2(vec2(p.y / (Wd * .35), float(id.x) * 3.1 + float(id.y)), s + 6u) - .5;
      float edge = 1. - smoothstep(hw * (.55 + .4 * fz), hw * (1.15 + .4 * fz), abs(p.x));
      float head = smoothstep(-.08, .02, t), tail = 1. - smoothstep(.85, 1.05, t);
      float streak = vn2(vec2(p.x / (wf * .16), float(id.y) * 7.3 + float(id.x)), s + 7u);
      float dry = 1. - smoothstep(.35, 1., t) * step(streak, .25 + .65 * t);   // 收笔处飞白：一道道透出纸
      float k = edge * head * tail;
      best = max(best, k * dry * mix(1., .50, clamp(t, 0., 1.)) * (.45 + .55 * h21(id, s + 8u)));
      cov = max(cov, k);
    }
  }
  return vec2(best, cov);
}
`;
const INK_FS = /* glsl */`
${NOISE}
${PALETTE}
${FOG}
${BRUSH}
uniform vec3 uL, uTintC;
uniform float uDbase, uCun, uRim, uCavK, uEn, uScale, uAT, uFogMul, uDmul, uDadd, uLit, uSoftQ, uWS;
uniform vec4 uFade;      // x,y：往上化进雾（y0→y1）；z,w：往下化进雾（y2→y3，z>w）
uniform vec4 uFadeX;     // x 方向化开（x0→x1），w 开关
uniform vec4 uMass;      // x 大墨团幅度、y 频率（1/米）、z 裂纹墨线幅度、w 枯笔飞白幅度
uniform vec4 uGrad;      // 墨浓的世界空间梯度：D += dot(xyz, 世界坐标) + w
uniform vec4 uBrush;     // 旧擦笔：x 幅度、y 沿笔方向频率、z 横笔方向频率、w 方向（0 横擦 / 1 竖皴）
uniform vec4 uStk;       // 笔触基元：x 墨量、y 笔长（米）、z 笔宽（米）、w 笔间纸缝
uniform vec4 uStk2;      // x 倾斜（弧度）、y 落笔门槛（受暗面 D）、z 顶面横擦墨量、w 笔路弯曲
uniform float uStkH;     // 1 = 所有面都横擦（石台正面）
uniform vec3 uMist;      // 背景化雾：x 强度、y/z 起止距离（米）——近景时让主体背后是亮处（R7）
uniform vec2 uEdgeA;     // 轮廓软边：x 软边宽（按 N·V）、y 噪声幅度（0 = 关）
uniform vec4 uTop;       // 山头实山脚虚：x 顶线墨浓、y 顶边积墨宽（米）、z 往下褪尽的深度（米）、w 与受光墨浓的混合
uniform vec4 uCave;      // 洞口（画进崖体材质）：世界中心 xyz、量
uniform vec3 uCaveR;     // 洞口椭球半径（米）
varying vec3 vN, vW, vO; varying float vCav, vTop;
void main(){
  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW);
  vec3 L = normalize(uL);
  float hl = .5 * dot(N, L) + .5;
  vec3 P = vO / uScale;
  float en = .10 * fbm3(P * .9, 11u) + .04 * fbm3(P * 3.5, 12u);
  float cun = 0.;
  if (abs(N.y) < .6) cun = smoothstep(.30, .62, fbm3(vec3(P.x * 3.2, P.y * .55, P.z * 3.2), 13u) * .5 + .5) * (1. - abs(N.y) / .6);
  float rimTop = smoothstep(.55, .9, 1. - abs(dot(N, V))) * smoothstep(-.1, .4, N.y) * (.7 + .3 * fbm3(P * 2., 14u));
  float D = uDbase + uLit * (1. - hl) + uCavK * vCav + uCun * cun + uRim * rimTop + uEn * en;
  if (uMass.x > 0.) D += uMass.x * fbm3(P * uMass.y + 3.1, 19u);
  if (uMass.z > 0.) D += uMass.z * smoothstep(.80, .95, ridged3(P * vec3(1.1, .7, 1.1) + 1.7, 20u));
  D += dot(uGrad.xyz, vW) + uGrad.w;
  if (uTop.w > 0.) {
    float sN = vTop / uTop.z;
    float bw = uTop.y * (.45 + 1.1 * vn3(P * 1.4 + 2.3, 25u));
    float Ds = uTop.x * (.55 + .45 * exp(-vTop / bw)) * (1. - smoothstep(.12, 1., sN + .28 * fbm3(P * 1.1, 23u)));
    Ds += uCavK * vCav * .6 + uMass.z * smoothstep(.80, .95, ridged3(P * vec3(1.1, .7, 1.1) + 1.7, 20u)) * (1. - smoothstep(.3, 1., sN));
    Ds += uMass.x * .6 * fbm3(P * uMass.y + 3.1, 19u) * (1. - smoothstep(.4, 1.2, sN));
    D = mix(D, Ds, uTop.w);
  }
  if (uBrush.x > 0.) {
    vec3 f = uBrush.w > .5 ? vec3(uBrush.z, uBrush.y, uBrush.z) : vec3(uBrush.y, uBrush.z, uBrush.y);
    vec3 Pw = P + .35 * vec3(fbm3(P * .8, 28u), 0., fbm3(P * .8 + 4., 29u)) * (uBrush.w > .5 ? vec3(1., 0., 1.) : vec3(0., 1., 0.));
    float st = vn3(Pw * f + 7.1, 26u) * .6 + vn3(Pw * f * 2.1 + 3.3, 27u) * .4;
    float mid = smoothstep(.12, .40, D) * (1. - smoothstep(.80, 1.02, D));
    float patchM = smoothstep(-.15, .35, fbm3(P * .55 + 9.1, 30u));
    D += uBrush.x * (smoothstep(.30, .78, st) - .45) * mid * patchM;
  }
  // 笔触基元：受暗面上一笔一笔的皴擦（竖面披麻 / 斧劈，顶面横擦）
  if (uStk.x > 0.) {
    float shadeW = smoothstep(uStk2.y - .08, uStk2.y + .08, D);
    vec2 uv; float Ls = uStk.y, Ws = uStk.z, amt = uStk.x;
    if (abs(N.y) < .62 && uStkH < .5) {
      vec2 w = vec2(fbm3(vW * .35, 31u), fbm3(vW * .35 + 3.7, 32u)) * uStk2.w;
      uv = vec2(vW.x + vW.z * .6 + w.x, vW.y + w.y);
    } else {
      vec2 w = vec2(fbm3(vW * .4, 33u), fbm3(vW * .4 + 1.9, 34u)) * uStk2.w * .5;
      uv = vec2(vW.z + w.y, vW.x + w.x) ; Ls *= 1.2; amt = uStk2.z;           // 顶面：横擦（行笔沿 x）
      shadeW = max(shadeW, .55 * smoothstep(.10, .30, D));
    }
    vec2 b = brushCells(uv, Ls, Ws, uStk2.x, 41u);
    vec2 b2 = brushCells(uv * vec2(1.3, .8) + 7.7, Ls * .7, Ws * .8, uStk2.x * 1.4, 43u);
    float stroke = max(b.x, b2.x * .7), cov = max(b.y, b2.y);
    float patchS = smoothstep(-.20, .30, fbm3(vW * .45 + 11.3, 35u));                // 皴擦成片落在几处，不满铺
    D += (amt * stroke - uStk.w * (1. - cov) * .6) * shadeW * patchS;
  }
  if (uMass.w > 0.) {
    float dry = fbm3(vec3(P.x * 3.5, P.y * 9., P.z * 3.5), 21u) * .6 + fbm3(P * 6., 22u) * .4;
    D -= uMass.w * smoothstep(.30, .70, dry) * smoothstep(.22, .55, D) * (1. - smoothstep(.75, .95, D));
  }
  // 洞口：崖体自己的焦墨（随几何走，不会跑出崖的轮廓）
  if (uCave.w > 0.) {
    vec3 dc = (vW - uCave.xyz) / uCaveR;
    float e = length(dc) + .16 * fbm3(vW * 1.3, 61u) + .06 * fbm3(vW * 4.5, 62u);
    float m = 1. - smoothstep(.78, 1.0, e);
    float Dc = 1.10 - .22 * smoothstep(.0, .85, e) + .12 * (1. - smoothstep(.0, .12, abs(e - .86)));
    D = mix(D, max(D, Dc), m * uCave.w);
  }
  D = D * uDmul + uDadd;
  float w = .045 + 1.2 * fwidth(D);
  // 水渍边：每道墨阶阈值的暗侧加一道 2–3K 的深边（R5）
  if (uWS > 0.) {
    float fw = 2.4 * fwidth(D) + .012, ws = 0.;
    for (int i = 0; i < 5; i++) { float t = i == 0 ? .18 : i == 1 ? .36 : i == 2 ? .54 : i == 3 ? .72 : .88; float dd = D - t; ws += step(0., dd) * (1. - smoothstep(0., fw, dd)); }
    D += uWS * ws;
  }
  vec3 col = mix(rampQ(D, w), rampS(D), uSoftQ);
  float M = smoothstep(.35, .6, dot(N, V)) * step(.1, fbm3(P * 1.3, 15u));
  col *= mix(vec3(1.), uTintC / max(uPal[0], vec3(.01)), uAT * M);
  float fade = 0.;
  if (uFade.y > uFade.x) fade = max(fade, smoothstep(uFade.x, uFade.y, vW.y + .35 * fbm3(P * .7, 16u)));
  if (uFade.z > uFade.w) fade = max(fade, smoothstep(uFade.z, uFade.w, vW.y + .5 * fbm3(P * .5, 17u)));
  if (uFadeX.w > .5) fade = max(fade, smoothstep(uFadeX.x, uFadeX.y, vW.x + .4 * fbm3(P * .6, 18u)));
  float dcam = length(vW - cameraPosition);
  col = mix(col, uPal[0], clamp(max(fogAmt(dcam, vW.y) * uFogMul, fade), 0., 1.));
  if (uMist.x > 0.) col = mix(col, mix(uPal[0], uPal[1], .35), uMist.x * smoothstep(uMist.y, uMist.z, dcam));
  float alpha = 1.;
  if (uEdgeA.x > 0.) alpha = smoothstep(0., uEdgeA.x, abs(dot(N, V)) + uEdgeA.y * fbm3(P * 2.4 + 5.3, 24u));
  gl_FragColor = vec4(col, alpha);
}`;
export function inkMat(o = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...common(),
      uL: { value: new THREE.Vector3(...(o.L || [-0.35, 0.85, 0.40])) },
      uTintC: { value: new THREE.Vector3(...(o.tint || [0.8, 0.67, 0.5])) },
      uDbase: { value: o.Dbase ?? 0.2 }, uCun: { value: o.cun ?? 0.22 }, uRim: { value: o.rim ?? 0.25 },
      uCavK: { value: o.cavK ?? 0.35 }, uEn: { value: o.en ?? 1 }, uScale: { value: o.scale ?? 1 },
      uAT: { value: o.aT ?? 0 }, uFogMul: { value: o.fogMul ?? 1 }, uDmul: { value: 1 }, uDadd: { value: 0 },
      uLit: { value: o.lit ?? 0.85 }, uSoftQ: { value: o.softQ ?? 0.35 }, uWS: { value: o.ws ?? 0 },
      uStk: { value: new THREE.Vector4(...(o.stk || [0, 0.4, 0.06, 0.1])) }, uStk2: { value: new THREE.Vector4(...(o.stk2 || [0.15, 0.45, 0.2, 0.4])) },
      uCave: { value: new THREE.Vector4(0, 0, 0, 0) }, uCaveR: { value: new THREE.Vector3(1, 1, 1) }, uStkH: { value: o.stkH ?? 0 },
      uFade: { value: new THREE.Vector4(...(o.fade || [0, 0, 0, 0])) },
      uFadeX: { value: new THREE.Vector4(...(o.fadeX || [0, 0, 0, 0])) },
      uMass: { value: new THREE.Vector4(...(o.mass || [0, 0.3, 0, 0])) },
      uGrad: { value: new THREE.Vector4(...(o.grad || [0, 0, 0, 0])) },
      uTop: { value: new THREE.Vector4(...(o.top || [0, 0.1, 1, 0])) },
      uEdgeA: { value: new THREE.Vector2(...(o.edgeA || [0, 0])) },
      uMist: { value: new THREE.Vector3(0, 1, 3) },
      uBrush: { value: new THREE.Vector4(...(o.brush || [0, 1, 1, 0])) },
    },
    vertexShader: INK_VS, fragmentShader: INK_FS, side: o.side ?? THREE.DoubleSide, transparent: !!o.edgeA,
  });
}

// ───────── 投影水墨（返修第 2 轮）：把 Magpie 画好的水墨原画按"投影机位"投到 3D 几何上（石台、崖顶石峰） ─────────
//   墨浓 D 由原画亮度按 Lp / Li 归一，按当段六色上色；A 通道是画里那一整块山石的遮罩（不在画里的几何就透明）
//   换了视角以后，几何上被投影拉长的地方（投影机位里几乎贴着视线的面）退回一层淡墨，免得出拉丝
const PROJ_VS = /* glsl */`varying vec3 vW, vN;
void main(){ vec4 wp = modelMatrix * vec4(position, 1.); vW = wp.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * wp; }`;
const PROJ_FS = /* glsl */`
${NOISE}
${PALETTE}
${FOG}
uniform sampler2D uPMap; uniform mat4 uPVP; uniform vec4 uPR; uniform vec2 uPL; uniform vec3 uPPos;
uniform float uDk, uFogMul, uOp, uNL; uniform vec3 uMist, uLd; uniform vec2 uFallD;
varying vec3 vW, vN;
void main(){
  vec4 pc = uPVP * vec4(vW, 1.);
  vec2 nd = pc.xy / pc.w;
  vec2 uv = (nd - uPR.xy) / (uPR.zw - uPR.xy);
  vec4 tp = texture(uPMap, uv);
  float D = clamp((uPL.x - lum(tp.rgb)) / max(uPL.x - uPL.y, .02), 0., 1.);
  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW), Pd = normalize(uPPos - vW);
  float ratio = abs(dot(N, V)) / max(abs(dot(N, Pd)), .02);
  float w = 1. - smoothstep(2.5, 6., ratio);
  float Dfb = uFallD.x + uFallD.y * fbm2(vW.xz * 1.3, 7u);
  if (uFallD.x >= 0.) D = mix(Dfb, D, w);                                     // 浮雕（uFallD.x < 0）不退淡墨：洞口里的陡壁照样是原画的焦墨
  D *= uDk;
  if (uNL > 0.) {                                                             // 真实 3D 明暗：按 N·L 分两阶——背光一面再压一档墨（受光面保持原画墨色），交界软
    float hl = .5 * dot(N, normalize(uLd)) + .5;
    D = min(1.05, D * (1. + uNL * (1. - smoothstep(.40, .58, hl + .05 * fbm2(vW.xy * 1.7, 9u)))));
  }
  vec3 col = rampS(D);
  float dcam = length(vW - cameraPosition);
  col = mix(col, uPal[0], clamp(fogAmt(dcam, vW.y) * uFogMul, 0., 1.));
  if (uMist.x > 0.) col = mix(col, mix(uPal[0], uPal[1], .30), uMist.x * smoothstep(uMist.y, uMist.z, dcam));
  float a = tp.a * uOp;
  if (a < .01) discard;
  gl_FragColor = vec4(col, a);
}`;
// cam：投影机位（固定）；rect：原画在投影机位 NDC 里的矩形 [x0, y底, x1, y顶]；Lp/Li：原画纸与焦墨的亮度
export function projMat(tex, cam, rect, { Lp = 0.96, Li = 0.08, fall = [0.12, 0.04], fogMul = 1, nl = 0, L = [-0.35, 0.85, 0.40], depthWrite = true } = {}) {
  const VP = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  return new THREE.ShaderMaterial({
    uniforms: { ...common(), uPMap: { value: tex }, uPVP: { value: VP }, uPR: { value: new THREE.Vector4(...rect) }, uPL: { value: new THREE.Vector2(Lp, Li) },
      uPPos: { value: cam.position.clone() }, uDk: { value: 1 }, uFogMul: { value: fogMul }, uOp: { value: 1 }, uMist: { value: new THREE.Vector3(0, 1, 3) },
      uFallD: { value: new THREE.Vector2(...fall) }, uNL: { value: nl }, uLd: { value: new THREE.Vector3(...L) } },
    vertexShader: PROJ_VS, fragmentShader: PROJ_FS, transparent: true, depthWrite, side: THREE.DoubleSide,
  });
}
// 返修第 3 轮（v2-02）：按原画自己的轮廓长出一块 3D 浮雕几何（投影机位下每个像素一条射线，深度 = 基准深度 − 圆鼓的隆起 + 洞口的凹陷），
//   再把同一张原画用 projMat 从投影机位投回去——投影机位下与原画逐像素一致；换机位（横移、推拉）时有真实的透视、遮挡与明暗
//   cam：投影机位；pxRect：原画在投影机位画面里的像素框 [x0, y0, x1, y1]（gw×gh）；o.Dbase 基准深度（米），o.bulge 中间往前鼓多少（米）
export function projRelief(tex, cam, pxRect, { Dbase, bulge = 1, blurPx = 18, cave = null, seg = [220, 170], gw = 1920, gh = 1080 }, matOpts = {}) {
  const img = tex.image, sw = 256, sh = Math.max(2, Math.round(256 * img.height / img.width));
  const c = document.createElement('canvas'); c.width = sw; c.height = sh;
  const g = c.getContext('2d', { willReadFrequently: true }); g.filter = `blur(${blurPx}px)`; g.drawImage(img, 0, 0, sw, sh);
  const A = g.getImageData(0, 0, sw, sh).data;
  const at = (x, y) => { x = Math.max(0, Math.min(sw - 1, x)); y = Math.max(0, Math.min(sh - 1, y)); return A[(y * sw + x) * 4 + 3] / 255; };
  const ins = (u, v) => { const x = u * (sw - 1), y = v * (sh - 1), i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy; };
  const sst = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const geo = new THREE.PlaneGeometry(1, 1, seg[0], seg[1]);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  cam.updateMatrixWorld(true);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), q = new THREE.Vector3();
  const [x0, y0, x1, y1] = pxRect;
  for (let i = 0; i < pos.count; i++) {
    const u = uv.getX(i), v = 1 - uv.getY(i);
    const px = x0 + u * (x1 - x0), py = y0 + v * (y1 - y0);
    q.set(px / gw * 2 - 1, 1 - py / gh * 2, 0.5).unproject(cam).sub(cam.position).normalize();
    let D = Dbase - bulge * sst(0.35, 0.97, ins(u, v));
    if (cave) { const r2 = ((px - cave.x) / cave.rx) ** 2 + ((py - cave.y) / cave.ry) ** 2; if (r2 < 1) D += cave.depth * Math.pow(1 - r2, 0.7); }
    const t = D / q.dot(fwd);
    pos.setXYZ(i, cam.position.x + q.x * t, cam.position.y + q.y * t, cam.position.z + q.z * t);
  }
  geo.computeVertexNormals(); geo.computeBoundingSphere();
  const m = new THREE.Mesh(geo, projMat(tex, cam, projRect(x0, y0, x1, y1, gw, gh), matOpts));
  m.frustumCulled = false;
  return m;
}
// 投影机位里一块像素矩形 → NDC 矩形（y 向下的像素，宽 gw 高 gh）
export const projRect = (x0, y0, x1, y1, gw = 1920, gh = 1080) => [x0 / gw * 2 - 1, 1 - y1 / gh * 2, x1 / gw * 2 - 1, 1 - y0 / gh * 2];

// ───────── 六重山脊 / 长卷山脊（DESIGN 3D-4）：竖直带，顶线 y_top(x) = H + amp·profile(x) ─────────
const RIDGE_VS = /* glsl */`
attribute float aTop;
uniform float uH, uAmp;
varying vec3 vW; varying float vTop; varying vec2 vUv;
void main(){
  vec3 p = position;
  float yTop = uH + uAmp * aTop;
  if (uv.y > .5) p.y = yTop;
  vec4 wp = modelMatrix * vec4(p, 1.);
  vW = wp.xyz; vUv = uv;
  vTop = (modelMatrix * vec4(p.x, yTop, p.z, 1.)).y;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const RIDGE_FS = /* glsl */`
${NOISE}
${PALETTE}
uniform float uDk, uHk, uHue, uTide, uTideW, uSoft, uDmul, uSeed, uHemp, uTopV, uOchre;
uniform vec3 uHueC, uOchreC;
uniform vec2 uBrk;       // 顶线断笔：开关、断开间距（世界米）
varying vec3 vW; varying float vTop; varying vec2 vUv;
void main(){
  float dy = vTop - vW.y;
  float s = dy / uHk;
  vec2 P = vec2(vW.x, vW.y) / uHk;
  float n = fbm2(P * vec2(.9, 1.4) + uSeed, 41u);
  float sl = sign(fbm2(vec2(P.x * .4, uSeed), 49u));                                        // 披麻顺着坡向斜下去，不是竖直的滴痕
  float hemp = smoothstep(.15, .7, fbm2(vec2((P.x + sl * P.y * .8) * 5., P.y * 1.6) + uSeed * 1.7, 42u)) * smoothstep(.05, .25, s);
  float band = smoothstep(.10, .60, fbm2(vec2(P.x * .30, P.y * 2.4) + uSeed * 3.1, 43u) * .5 + .5);
  float Dk = uDk * uDmul * (.86 + .28 * (vn2(vec2(vW.x / (uHk * 3.), uSeed * 2.), 45u) - .5));
  // 顶线积墨：沿山脊忽浓忽淡、忽宽忽窄（0.4–1.6 倍）
  float tv = mix(1., .4 + 1.2 * vn2(vec2(vW.x / (uHk * 1.6), uSeed * 5.), 46u), uTopV);
  float top = .60 + .40 * exp(-s / (.06 * tv));
  if (uBrk.x > .5) {                                                       // 每隔一段断一次，断处化进雾
    float bn = vn2(vec2(vW.x / uBrk.y, uSeed * 7.), 47u);
    float brk = smoothstep(.22, .05, bn);
    top = mix(top, .45, brk);
    Dk *= 1. - .55 * brk * smoothstep(.0, .4, s);
  }
  float body = 1. - smoothstep(.10, 1.0, s + .25 * n);
  float D = Dk * top * body * mix(1., .45, band * smoothstep(.08, .35, s)) + uHemp * Dk * hemp * clamp(1. - s, 0., 1.);
  D += uTide * .25 * exp(-pow(dy / max(uTideW, 1e-4) - .6, 2.) * 1.5);
  vec3 col = rampS(D);
  float l = lum(col);
  vec3 hue = uHueC / max(lum(uHueC), .01) * l;
  col = mix(col, hue, uHue * smoothstep(.02, .3, D));
  if (uOchre > 0.) {                                                         // 受光坡一层赭石淡彩（返修第 2 轮 v1-03：跟着墨一起显影、正片叠底叠在墨上、内缩、边比墨软）
    // 返修 w3（qa2-05）：原来沿整条脊线等宽铺开、带着披麻的细纹（读成砂粒）、偏饱和，像一条金色条带。
    //   改成打散的几块（块的尺度加大、门槛提高，沿脊线断开；离顶线的深浅也各块不同），饱和降 16%，色的明暗只跟大块墨走（不带披麻细纹）
    float blk = fbm2(vec2(P.x * .42, P.y * .9) + 9., 48u) * .5 + .5 + .22 * fbm2(vec2(P.x * .30, P.y * 1.3) + 3.7, 53u);
    float s0 = .07 + .10 * (fbm2(vec2(P.x * .25, 1.3), 54u) * .5 + .5);
    float m = smoothstep(s0, s0 + .14, s + .05 * fbm2(P * 2.2, 52u)) * (1. - smoothstep(.42, .85, s)) * smoothstep(.50, .66, blk);
    float inkHere = smoothstep(.03, .14, D) * smoothstep(.55, 1., uDmul);   // 这一层的墨显出来之后才上色（彩不会先于墨出现），只叠在有墨的地方
    float Dn = Dk * top * body * mix(1., .45, band * smoothstep(.08, .35, s));
    vec3 oC = mix(vec3(lum(uOchreC)), uOchreC, .84);
    vec3 oc = oC * (.76 * lum(rampS(Dn)) / max(lum(oC), .05));
    col = mix(col, oc, clamp(uOchre * m * inkHere, 0., .72));
  }
  float brk2 = vn2(vec2(vW.x / (uHk * .7), uSeed), 44u);
  float a = smoothstep(0., uSoft * (1. + 2.5 * brk2), dy);
  gl_FragColor = vec4(col, a);
}`;
// 生成一条山脊带：xs 世界 x 的范围，z 深度（相机前方 -z），H 基准顶高，bottom 底边
export function ridgeStrip({ x0, x1, z, H, bottom = -40, seg = 800, prof, Dk, Hk, hue = 0, hueC = [0.43, 0.51, 0.55], soft = 0.6, seed = 0, order = 1, hemp = 0.10, topV = 0, brk = [0, 1], ochre = 0, ochreC = [0.78, 0.67, 0.51] }) {
  const g = new THREE.PlaneGeometry(1, 1, seg, 1);
  const pos = g.attributes.position, uv = g.attributes.uv;
  const top = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const u = uv.getX(i), x = x0 + (x1 - x0) * u;
    pos.setXYZ(i, x, uv.getY(i) > 0.5 ? H : bottom, 0);
    top[i] = prof(x);
  }
  g.setAttribute('aTop', new THREE.BufferAttribute(top, 1));
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
    uniforms: { ...common(), uH: { value: H }, uAmp: { value: 1 }, uDk: { value: Dk }, uHk: { value: Hk }, uHue: { value: hue },
      uHueC: { value: new THREE.Vector3(...hueC) }, uTide: { value: 0 }, uTideW: { value: 1 }, uSoft: { value: soft }, uDmul: { value: 1 }, uSeed: { value: seed },
      uHemp: { value: hemp }, uTopV: { value: topV }, uBrk: { value: new THREE.Vector2(...brk) }, uOchre: { value: ochre }, uOchreC: { value: new THREE.Vector3(...ochreC) } },
    vertexShader: RIDGE_VS, fragmentShader: RIDGE_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }));
  m.position.z = z; m.renderOrder = order; m.frustumCulled = false;
  return m;
}

// ───────── 雾片 / 云片（DESIGN 3D-7）：颜色 = 纸，fbm 透空，竖向轮廓 ─────────
const FOGP_VS = /* glsl */`varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position, 1.); vW = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const FOGP_FS = /* glsl */`
${NOISE}
${PALETTE}
uniform float uA0, uDrift, uSeed, uLo, uHi, uEdge, uEdgeInk, uSide, uHole, uShade, uSlide, uMaskOut, uBright;
uniform vec2 uSc;
uniform vec4 uOpen;      // 雾散：从 x=uOpen.x 向两侧拉开，半宽 uOpen.y（uv），边软 uOpen.z
varying vec2 vUv; varying vec3 vW;
void main(){
  vec2 uv = vUv;
  if (uSlide != 0.) uv.x -= sign(vUv.x - uOpen.x) * uSlide;                 // 雾散：两半各自往外滑开
  vec2 q = uv * uSc + vec2(uDrift * uT + uSeed * 13.1, uSeed * 7.7);
  float n = fbm2(q, 51u) * .5 + .5;
  float n2 = fbm2(q * 3.1 + 4.2, 52u) * .5 + .5;
  float prof = smoothstep(0., uEdge, vUv.y) * smoothstep(1., 1. - uEdge, vUv.y);
  if (uSide > 0.) prof *= smoothstep(0., uSide, vUv.x) * smoothstep(1., 1. - uSide, vUv.x);
  float a = uA0 * smoothstep(uLo, uHi, n * prof + (n2 - .5) * .18);
  if (uHole > 0.) a *= 1. - uHole * smoothstep(.62, .78, n2);
  if (uOpen.y > 0.) a *= smoothstep(uOpen.y - uOpen.z, uOpen.y + uOpen.z, abs(vUv.x - uOpen.x) + (n2 - .5) * .12);
  if (uMaskOut > .5) { gl_FragColor = vec4(1., 1., 1., a); return; }           // 只输出遮挡（换场遮罩用）
  vec3 col = mix(uPal[0], vec3(1.), uBright * smoothstep(.3, .8, a));            // 近云的云身比天亮一点（烘云托月）
  float edge = smoothstep(.0, .25, a) * (1. - smoothstep(.25, .6, a));
  col = mix(col, mix(uPal[1], uPal[2], .45), edge * uEdgeInk);
  if (uShade > 0.) col = mix(col, uPal[1], uShade * smoothstep(.55, .0, vUv.y) * smoothstep(.2, .7, a));
  gl_FragColor = vec4(col, a);
}`;
export function fogPlane({ w, h, a0 = 0.7, drift = 0.02, seed = 0, lo = 0.35, hi = 0.75, sc = [3, 1.2], edge = 0.35, edgeInk = 0, side = 0, hole = 0, order = 5 }) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.ShaderMaterial({
    uniforms: { ...common(), uA0: { value: a0 }, uDrift: { value: drift }, uSeed: { value: seed }, uLo: { value: lo }, uHi: { value: hi },
      uSc: { value: new THREE.Vector2(...sc) }, uEdge: { value: edge }, uEdgeInk: { value: edgeInk }, uSide: { value: side }, uHole: { value: hole },
      uOpen: { value: new THREE.Vector4(0.5, 0, 0.1, 0) }, uShade: { value: 0 }, uSlide: { value: 0 }, uMaskOut: { value: 0 }, uBright: { value: 0 } },
    vertexShader: FOGP_VS, fragmentShader: FOGP_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }));
  m.renderOrder = order; m.frustumCulled = false;
  return m;
}

// ───────── 剪纸日：软边圆，边缘静态噪声 ±3% 半径，自带 6% 深边 ─────────
const SUN_FS = /* glsl */`
${NOISE}
${PALETTE}
uniform vec3 uC; uniform float uOp, uSeed, uHalo, uHaloA, uRim;
varying vec2 vUv; varying vec3 vW;
void main(){
  vec2 p = (vUv - .5) * 2.;                 // 面片内 [-1,1]，圆半径 = 1/(1+halo)
  float R = 1. / (1. + uHalo);
  float r = length(p);
  float nz = (vn2(p * 3. + uSeed, 61u) - .5) * .06 * R;
  float soft = .16 * R;
  float disc = 1. - smoothstep(R - soft, R + soft * .3, r + nz);
  float rim = smoothstep(R * .62, R * .97, r + nz) * disc;
  vec3 col = mix(uC, mix(uC, vec3(.70, .58, .40), .45), rim * uRim);            // 剪纸圆：边上一圈淡赭深边（干后颜料往边上走）
  float halo = uHaloA * exp(-pow(max(r - R, 0.) / (uHalo * R * .5 + 1e-3), 2.)) * (1. - disc);
  float a = (disc + halo) * uOp;
  gl_FragColor = vec4(col, clamp(a, 0., 1.));
}`;
export function sunPlane({ color, halo = 0, haloA = 0, rim = 1, seed = 0, order = 0.5 }) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: { ...common(), uC: { value: new THREE.Vector3(...color) }, uOp: { value: 0 }, uSeed: { value: seed }, uHalo: { value: halo }, uHaloA: { value: haloA }, uRim: { value: rim } },
    vertexShader: FOGP_VS, fragmentShader: SUN_FS, transparent: true, depthWrite: false, depthTest: false,
  }));
  m.renderOrder = order; m.frustumCulled = false;
  return m;
}

// ───────── 墨团面片（洞口这类）：不规则椭圆，心浓边淡，边洇开 ─────────
const BLOB_FS = /* glsl */`
${NOISE}
${PALETTE}
${FOG}
uniform float uD0, uD1, uSeed, uSoft, uOp, uFogMul;
varying vec2 vUv; varying vec3 vW;
void main(){
  vec2 p = (vUv - .5) * 2.;
  float ang = atan(p.y, p.x);
  vec2 cs = vec2(cos(ang), sin(ang));
  float edge = 1. + .13 * fbm2(cs * 1.5 + uSeed, 171u) + .05 * fbm2(cs * 5. + uSeed, 172u);
  float rr = length(p) / (.86 * edge);
  float a = 1. - smoothstep(1. - uSoft, 1. + uSoft * .35, rr + .05 * fbm2(p * 8. + uSeed, 173u));
  float D = mix(uD0, uD1, smoothstep(.15, 1., rr)) + .05 * fbm2(p * 3. + uSeed, 174u);
  vec3 col = rampS(D);
  col = mix(col, uPal[0], fogAmt(length(vW - cameraPosition), vW.y) * uFogMul);
  gl_FragColor = vec4(col, a * uOp);
}`;
export function blobPlane({ D0 = 1, D1 = 0.8, seed = 0, soft = 0.12, order = 8.4 }) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: { ...common(), uD0: { value: D0 }, uD1: { value: D1 }, uSeed: { value: seed }, uSoft: { value: soft }, uOp: { value: 1 }, uFogMul: { value: 1 } },
    vertexShader: FOGP_VS, fragmentShader: BLOB_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }));
  m.renderOrder = order; m.frustumCulled = false;
  return m;
}

// ───────── 画布面片：Canvas 2D 画好的墨（直通 alpha），可选雾、可选按 mip 虚化 ─────────
const CAN_FS = /* glsl */`
${NOISE}
${PALETTE}
${FOG}
uniform sampler2D map; uniform float uOp, uLod, uFogMul;
varying vec2 vUv; varying vec3 vW;
void main(){
  vec4 c = texture(map, vUv, uLod);
  vec3 col = mix(c.rgb, uPal[0], fogAmt(length(vW - cameraPosition), vW.y) * uFogMul);
  gl_FragColor = vec4(col, c.a * uOp);
}`;
export function canvasPlane(cw, ch, { order = 5, lod = 0, fogMul = 1, depthTest = true, mip = true } = {}) {
  const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace; tex.generateMipmaps = mip;
  tex.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter; tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: { ...common(), map: { value: tex }, uOp: { value: 1 }, uLod: { value: lod }, uFogMul: { value: fogMul } },
    vertexShader: FOGP_VS, fragmentShader: CAN_FS, transparent: true, depthWrite: false, depthTest, side: THREE.DoubleSide,
  }));
  mesh.renderOrder = order; mesh.frustumCulled = false; mesh.userData.aspect = cw / ch;
  return { mesh, canvas, ctx, tex };
}

// ───────── 松针扇（实例面片，正片叠底感的浓墨，alpha 测试 + 软边） ─────────
const NEEDLE_VS = /* glsl */`varying vec2 vUv; varying vec3 vW; varying float vI;
void main(){ vUv = uv; mat4 m = modelMatrix;
  #ifdef USE_INSTANCING
    m = modelMatrix * instanceMatrix;
  #endif
  vec4 wp = m * vec4(position, 1.); vW = wp.xyz; vI = float(gl_InstanceID); gl_Position = projectionMatrix * viewMatrix * wp; }`;
const NEEDLE_FS = /* glsl */`
${NOISE}
${PALETTE}
${FOG}
uniform sampler2D map; uniform float uD0, uD1, uLod, uFogMul, uOp, uMono;
varying vec2 vUv; varying vec3 vW; varying float vI;
void main(){
  vec4 tx = texture(map, vUv, uLod);
  float a = tx.a;
  float dens = uMono > .5 ? 1. : 1. - tx.r;                                     // R 通道记墨浓：淡墨湿团 ≈ .35，针 ≈ 1
  float D = mix(uD0, uD1, h21(ivec2(int(vI), 3), 9u)) * mix(.42, 1., smoothstep(.30, .85, dens));
  vec3 col = rampS(D);
  col = mix(col, uPal[0], fogAmt(length(vW - cameraPosition), vW.y) * uFogMul);
  float fw = max(fwidth(a), 1e-3);
  gl_FragColor = vec4(col, smoothstep(.22 - 1.5 * fw, .22 + 1.5 * fw, a) * uOp * (.55 + .45 * smoothstep(.0, .5, a)));
}`;
export function needleMat(tex, { D0 = 0.55, D1 = 0.78, lod = 0, fogMul = 1, mono = 0 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...common(), map: { value: tex }, uD0: { value: D0 }, uD1: { value: D1 }, uLod: { value: lod }, uFogMul: { value: fogMul }, uOp: { value: 1 }, uMono: { value: mono } },
    vertexShader: NEEDLE_VS, fragmentShader: NEEDLE_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}
// 松针团画布（1024×768）：先铺一块淡墨湿团（不规则椭圆、带水渍边），再写 9–15 笔半扇形浓墨针，只张开 120–160°，扇口朝 +x（枝梢方向）
export function needleTexture(seed = 1) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 768;
  const g = c.getContext('2d');
  let s = seed * 9973 + 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const cx = 300, cy = 384;
  // 淡墨湿团：不规则椭圆，边深心浅
  const blob = []; const ph = rnd() * 9;
  for (let k = 0; k < 64; k++) { const a = k / 64 * 6.283; const r = 1 + 0.22 * Math.sin(a * 3 + ph) + 0.12 * Math.sin(a * 5 + ph * 2) + (rnd() - 0.5) * 0.08; blob.push([cx + 200 + Math.cos(a) * 250 * r, cy + Math.sin(a) * 150 * r]); }
  const path = () => { g.beginPath(); blob.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); };
  g.filter = 'blur(12px)'; path(); g.fillStyle = 'rgba(175,175,175,0.26)'; g.fill();
  g.filter = 'blur(5px)'; path(); g.strokeStyle = 'rgba(150,150,150,0.18)'; g.lineWidth = 14; g.stroke(); g.filter = 'none';
  // 半扇形浓墨针
  const n = 9 + Math.floor(rnd() * 7), span = (120 + rnd() * 40) * Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const a = -span / 2 + span * (i + 0.5 * rnd()) / n + (rnd() - 0.5) * 0.08;
    const L = 360 + rnd() * 260, x0 = cx + (rnd() - 0.5) * 30, y0 = cy + (rnd() - 0.5) * 30;
    const x1 = x0 + Math.cos(a) * L, y1 = y0 + Math.sin(a) * L;
    const steps = 30;
    for (let k = 0; k < steps; k++) {
      const u = k / steps, u2 = (k + 1) / steps;
      const w = 16 * (1 - u) * (0.65 + 0.35 * Math.sin(u * 3.1)) + 1.2;
      if (u > 0.55 && rnd() < (u - 0.55) * 1.5) continue;           // 收笔飞白
      g.strokeStyle = `rgba(0,0,0,${0.94 - 0.25 * u})`; g.lineWidth = w; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u); g.lineTo(x0 + (x1 - x0) * u2, y0 + (y1 - y0) * u2); g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// 松干：两条不对称的笔线（受暗一侧浓而宽、受光一侧细而断），中间留纸或铺淡墨；Worley 鳞皴（7/米，深边 0.2）+ 枯笔飞白；收梢处一点焦墨
const BARK_VS = /* glsl */`varying vec3 vN, vW; varying vec2 vUv;
void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position, 1.); vW = wp.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * wp; }`;
const BARK_FS = /* glsl */`
${NOISE}
${PALETTE}
${FOG}
uniform vec3 uL; uniform float uLen, uCirc, uD0, uFogMul, uSeedB;
varying vec3 vN, vW; varying vec2 vUv;
vec2 worley(vec2 p){ vec2 i = floor(p), f = fract(p); float d1 = 9., d2 = 9.;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 o = vec2(float(x), float(y)); vec2 r = o + vec2(h21(ivec2(i + o), 71u), h21(ivec2(i + o), 72u)) - f; float d = dot(r, r); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
  return vec2(sqrt(d1), sqrt(d2)); }
void main(){
  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW);
  float rim = 1. - abs(dot(N, V));
  float lit = dot(N, normalize(uL));
  float along = vUv.x * uLen;
  float nb = vn2(vec2(along / .09, uSeedB), 73u);
  float dark = smoothstep(.50, .80, rim) * smoothstep(.15, -.35, lit);                  // 受暗一侧：浓而宽
  float light = smoothstep(.78, .93, rim) * smoothstep(-.1, .3, lit) * step(.42, nb);    // 受光一侧：细而断
  vec2 wv = worley(vec2(along, vUv.y * uCirc) * 7. + uSeedB);
  float scale = 1. - smoothstep(.0, .10, wv.y - wv.x);                                   // 鳞皴深边
  float dry = smoothstep(.55, .85, vn2(vec2(along / .30, vUv.y * uCirc / .012), 74u));     // 枯笔飞白（沿干的方向）
  float D = uD0 * (.55 + .45 * (1. - abs(dot(N, V)))) + .62 * dark + .45 * light + .20 * scale * (.4 + .6 * smoothstep(.4, -.2, lit));
  D -= .28 * dry * (1. - dark);
  D *= .92 + .12 * vn2(vec2(along / .05, vUv.y * 9.), 75u);
  vec3 col = rampS(clamp(D, 0., 1.05));
  col = mix(col, uPal[0], fogAmt(length(vW - cameraPosition), vW.y) * uFogMul);
  gl_FragColor = vec4(col, 1.);
}`;
export function barkMat({ L = [-0.35, 0.85, 0.40], len = 3, circ = 0.3, D0 = 0.30, fogMul = 1, seed = 0 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...common(), uL: { value: new THREE.Vector3(...L) }, uLen: { value: len }, uCirc: { value: circ }, uD0: { value: D0 }, uFogMul: { value: fogMul }, uSeedB: { value: seed } },
    vertexShader: BARK_VS, fragmentShader: BARK_FS, side: THREE.DoubleSide,
  });
}

// 顶点凹度（DESIGN 3.1 cav）：(邻点平均位置 − P)·N × k，夹 [0,1]，平滑 2 次
export function bakeCavity(geo, k = 3, smooth = 2) {
  const pos = geo.attributes.position, nor = geo.attributes.normal, idx = geo.index.array, n = pos.count;
  const sum = new Float32Array(n * 3), cnt = new Float32Array(n);
  const add = (a, b) => { sum[a * 3] += pos.getX(b); sum[a * 3 + 1] += pos.getY(b); sum[a * 3 + 2] += pos.getZ(b); cnt[a]++; };
  for (let i = 0; i < idx.length; i += 3) { const a = idx[i], b = idx[i + 1], c = idx[i + 2]; add(a, b); add(a, c); add(b, a); add(b, c); add(c, a); add(c, b); }
  let cav = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!cnt[i]) continue;
    const dx = sum[i * 3] / cnt[i] - pos.getX(i), dy = sum[i * 3 + 1] / cnt[i] - pos.getY(i), dz = sum[i * 3 + 2] / cnt[i] - pos.getZ(i);
    cav[i] = Math.max(0, Math.min(1, (dx * nor.getX(i) + dy * nor.getY(i) + dz * nor.getZ(i)) * k));
  }
  for (let s = 0; s < smooth; s++) {
    const nb = new Float32Array(n), nc = new Float32Array(n);
    for (let i = 0; i < idx.length; i += 3) for (const [a, b] of [[idx[i], idx[i + 1]], [idx[i + 1], idx[i + 2]], [idx[i + 2], idx[i]]]) { nb[a] += cav[b]; nc[a]++; nb[b] += cav[a]; nc[b]++; }
    const c2 = new Float32Array(n); for (let i = 0; i < n; i++) c2[i] = nc[i] ? (cav[i] + nb[i] / nc[i]) * 0.5 : cav[i];
    cav = c2;
  }
  geo.setAttribute('aCav', new THREE.BufferAttribute(cav, 1));
  if (!geo.attributes.aTop) geo.setAttribute('aTop', new THREE.BufferAttribute(new Float32Array(n), 1));
  return geo;
}
// 每个顶点到"参考机位下本列顶轮廓"的竖直距离（米）：顶点投到屏幕按 x 分箱，取最上沿；只让 use(i) 为真的顶点参与
export function bakeTopView(geo, offset, cam, fp, { binPx = 6, use = null, below = null } = {}) {
  const p = geo.attributes.position, n = p.count, v = new THREE.Vector3(), cv = new THREE.Vector3();
  const SX = new Float32Array(n), SY = new Float32Array(n), DZ = new Float32Array(n);
  let x0 = 1e9, x1 = -1e9;
  for (let i = 0; i < n; i++) {
    v.set(p.getX(i), p.getY(i), p.getZ(i)).add(offset);
    cv.copy(v).applyMatrix4(cam.matrixWorldInverse); DZ[i] = -cv.z;
    v.project(cam); SX[i] = (v.x * 0.5 + 0.5) * 1920; SY[i] = (0.5 - v.y * 0.5) * 1040;
    x0 = Math.min(x0, SX[i]); x1 = Math.max(x1, SX[i]);
  }
  const bins = Math.max(2, Math.ceil((x1 - x0) / binPx) + 1), top = new Float32Array(bins).fill(1e9);
  const bi = x => Math.max(0, Math.min(bins - 1, Math.floor((x - x0) / binPx)));
  for (let i = 0; i < n; i++) if (!use || use(i)) { const b = bi(SX[i]); top[b] = Math.min(top[b], SY[i]); }
  for (let b = 0; b < bins; b++) if (top[b] > 1e8) top[b] = b > 0 ? top[b - 1] : 1e8;
  for (let b = bins - 2; b >= 0; b--) if (top[b] > 1e8) top[b] = top[b + 1];
  const sm = top.map((t, b) => (top[Math.max(0, b - 1)] + 2 * t + top[Math.min(bins - 1, b + 1)]) / 4);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (use && !use(i)) { a[i] = below ?? 9; continue; }
    const u = (SX[i] - x0) / binPx - 0.5, b = Math.max(0, Math.min(bins - 2, Math.floor(u))), k = Math.max(0, Math.min(1, u - b));
    const t = sm[b] * (1 - k) + sm[b + 1] * k;
    a[i] = Math.max(0, SY[i] - t) / fp * DZ[i];
  }
  geo.setAttribute('aTop', new THREE.BufferAttribute(a, 1));
  return geo;
}
// 每个顶点到"本列顶线"的竖直距离（物体空间按 x 分箱，只看朝相机一面 z > zMin 的顶点）
export function bakeTop(geo, bins = 96, zMin = -1e9) {
  const p = geo.attributes.position, n = p.count;
  let x0 = 1e9, x1 = -1e9;
  for (let i = 0; i < n; i++) { x0 = Math.min(x0, p.getX(i)); x1 = Math.max(x1, p.getX(i)); }
  const top = new Float32Array(bins).fill(-1e9), bi = x => Math.max(0, Math.min(bins - 1, Math.floor((x - x0) / (x1 - x0 + 1e-9) * bins)));
  for (let i = 0; i < n; i++) if (p.getZ(i) > zMin) { const b = bi(p.getX(i)); top[b] = Math.max(top[b], p.getY(i)); }
  // 空箱用邻箱补，再平滑一次
  for (let b = 0; b < bins; b++) if (top[b] < -1e8) top[b] = top[Math.max(0, b - 1)] > -1e8 ? top[Math.max(0, b - 1)] : 0;
  const sm = top.map((v, b) => (top[Math.max(0, b - 1)] + 2 * v + top[Math.min(bins - 1, b + 1)]) / 4);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = p.getX(i), u = (x - x0) / (x1 - x0 + 1e-9) * bins - 0.5, b = Math.max(0, Math.min(bins - 2, Math.floor(u))), k = Math.max(0, Math.min(1, u - b));
    a[i] = Math.max(0, (sm[b] * (1 - k) + sm[b + 1] * k) - p.getY(i)); }
  geo.setAttribute('aTop', new THREE.BufferAttribute(a, 1));
  return geo;
}
export function zeroCavity(geo) { const n = geo.attributes.position.count; geo.setAttribute('aCav', new THREE.BufferAttribute(new Float32Array(n), 1)); geo.setAttribute('aTop', new THREE.BufferAttribute(new Float32Array(n), 1)); return geo; }
