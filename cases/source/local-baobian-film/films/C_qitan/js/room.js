// room.js — 场景 A：修复室（S1a、S1b、T1 房间部分、S6）
// 原点在书脊处的纸面上：+x 读者右手，+y 向上，+z 朝读者（陆蔚坐在 +z 一侧）。单位米。
// 3D：书桌、线装书（两页曲面 + 页面着色器）、书块、道具、六爻条（T1 门扇）、光柱、浮尘；2D：A17 墙窗底板、手（A11 / A12）、A10 头肩卡。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLSL_COMMON, DEG, clamp, lerp, seg, ss, ss5, eo, eio, hashi, lin3, srgb, motifPh, motifK, tcOf, P_MOTIF, STAR_H } from './util.js';
import { makeToon, outlined, SHARED, GLSL_3D } from './toonmat.js';
import { makeSprite, setBends, setSpots, placeOnCam, placeWorld, texPx } from './sprite.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const PV = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;
const UNIT = new THREE.PlaneGeometry(1, 1);
export const LIGHT_A = [.80, .45, -.40];          // 主光方向（指向光源）：右侧窗
const HEX = [1, 0, 1, 1, 1, 0];                   // 革卦自下而上：阳 阴 阳 阳 阳 阴
const HEX_C = [-.075, -.020];                     // 左页卦心（x, z）
export const barZ = k => HEX_C[1] + (3.5 - k) * .0095;   // 第 k 爻（1..6）的 z
// 第 4 轮（zs-01）：S6 拉轨的进度（f646 起 34 帧，起步平滑、后段长收尾）——f667 光斑落定时已走完 93%，f672 字幕起时 98%，
//   种子 7 那圈光在"落定"那一下就落在 (1180, 600)（和 S1a 墨环、S4b 第一枚斑同一点）；镜头在字幕出来之前停稳
export const s6Ease = f => { const x = clamp((f - 646) / 34); return 1 - Math.pow(1 - x, 4) * (1 + 4 * x); };
// 纸面高度：从书脊（书沟）往外鼓起
// 第 4 轮（qa2-06 / main3-02）：线装书是一册薄书，摊开时纸软、伏得平——鼓起减半（书口处 1.2 → 0.6 cm），桌面相应抬到书沟下 3 mm，
//   书口那一侧整册约 9 mm 厚（原来 2.4 cm，像精装书的书块）。T1 的爻条、门洞、相机都按 pageY 算，跟着一起变，构图不动
export const DESK_Y = -.003, BLOCK_Y = DESK_Y + .0002;
export function pageY(x) { const u = Math.min(Math.abs(x) / .15, 1); return .008 * (1 - Math.exp(-u * 9)) * (1 - .25 * u); }

// ── 页面着色器 ──
const PAGE_VS = /* glsl */`varying vec3 vW, vN; void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const PAGE_FS = /* glsl */`
${GLSL_COMMON}
uniform sampler2D tWood, tGe;
uniform vec3 uLight; uniform float uSide;
uniform vec4 uDoor; uniform float uK;
uniform vec4 uLift;   // 下卦三爻 / 上卦三爻浮起后留痕的比例（x：1–3 爻，y：4–6 爻），z：印卦整体墨量，w：开门边缘浸湿
uniform vec4 uSpot;   // 纸面反射光点：x, z, 半径, 强度
uniform vec4 uDap; uniform vec4 uDapW[6]; uniform vec4 uDapWP[6]; uniform vec4 uPool;
uniform int uNS; uniform vec4 uNSp[18]; uniform vec4 uNSph[18]; uniform float uNSa;
uniform vec4 uWoodR;   // 木刻版框在右页上的矩形：x0, z0, x1, z1（世界）
uniform vec4 uGeR;     // 革字：cx, cz, 尺寸, 墨量
uniform vec4 uShadow;  // 爻条投影：下卦浮起、上卦浮起、开门后淡掉、_
uniform vec4 uBarLift[6]; // 每爻：浮起高度(米)、开门角(弧度)、_、_
varying vec3 vW, vN;
float doorM(vec2 xz){
  vec2 uv = vec2((xz.x + .15) / .15, (xz.y + .105) / .21);
  if (uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.) return 0.;
  float nv = .04 * fbm(vec2(uv.x * 18., 3.7), 62u);   // 返修 tech-12：门洞上下边也有毛边
  float vin = sst(uDoor.y - .02, uDoor.y, uv.y + nv) * (1. - sst(uDoor.z, uDoor.z + .02, uv.y - nv));
  return sst(-.015, .015, uDoor.x - abs(uv.x - .5) + .04 * fbm(uv * 18., 61u)) * vin;
}
float boxSDF(vec2 p, vec2 c, vec2 h){ vec2 d = abs(p - c) - h; return length(max(d, 0.)) + min(max(d.x, d.y), 0.); }
float dappleW(vec3 w){
  float L = 0.;
  for (int j = 0; j < 6; j++) {
    vec2 c = uDapW[j].xy; vec2 r = uDapW[j].zw;
    float e = 1. - sst(.86, 1., length((w.xz - c) / r));
    vec2 m = motif((w.xz - c) / (r.x * .8), uDapWP[j], 5., .15, .85);   // 第 4 轮（zs-01）：落定后读成豹斑——环边收清、斑心只亮一层
    L = max(L, mix(e, m.x + .2 * m.y, uDap.y));
  }
  float leaf = sst(-.08, .28, fbm(w.xz * 30., 43u)) * .6 + sst(-.05, .3, fbm(w.xz * 95. + 3.1, 44u)) * .45;
  return L * (1. - uDap.z * clamp(leaf, 0., .85));
}
void main(){
  vec2 P = vW.xz;
  float M = 0.;
  if (uSide < .5 && uDoor.w > .5) { M = doorM(P); if (M > .5) discard; }
  // 纸底：纤维、黄斑、边缘发暗
  vec3 paper = vec3(.672, .610, .431);   // #D6CDB0 线性
  float fib = vnoise(vec2(P.x * 2600., P.y * 380.), 3u) * .5 + vnoise(vec2(P.x * 900., P.y * 5200.), 4u) * .5;
  float stain = sst(.08, .32, fbm(P * 26. + uSide * 9., 5u));
  paper *= .94 + .1 * fib;
  paper = mix(paper, vec3(.578, .478, .262), stain * .35);
  float ex = uSide < .5 ? (P.x + .15) / .15 : 1. - P.x / .15;   // 0 = 外缘，1 = 书沟
  float ez = 1. - abs(P.y) / .105;
  paper *= mix(.78, 1., sst(0., .09, min(ex, ez)));
  paper *= mix(.82, 1., sst(0., .12, 1. - ex));                // 书沟里的阴影
  // 第 4 轮（qa2-06 / main3-02）：线装书的薄纸受潮后微微起伏（皱褶大致平行书脊，越近书口越明显）——只在明暗上做，不动几何
  float cock = sin(P.y * 82. + 3.2 * fbm(P * 14. + uSide * 5., 66u)) * mix(1., .3, ex);
  paper *= 1. + .026 * cock + .022 * fbm(P * 22. + uSide * 3., 67u);
  vec3 col = paper;
  vec3 INKC = vec3(.0103, .0091, .0085);
  float px = 1.2 / (2600. * uK);   // 约一个像素（米）
  if (uSide < .5) {
    // 乌丝栏：8 栏竖线 + 双线边框
    float x0 = -.138, x1 = -.012, z0 = -.094, z1 = .094;
    float inX = step(x0 - .002, P.x) * step(P.x, x1 + .002), inZ = step(z0 - .002, P.y) * step(P.y, z1 + .002);
    float cw = (x1 - x0) / 8.;
    float rule = 0.;
    for (int i = 1; i < 8; i++) rule = max(rule, 1. - sst(.00025, .00025 + px, abs(P.x - (x0 + cw * float(i)))));
    rule *= step(z0, P.y) * step(P.y, z1);
    float frame = max(1. - sst(.0004, .0004 + px, abs(boxSDF(P, vec2((x0 + x1) * .5, 0.), vec2((x1 - x0) * .5, (z1 - z0) * .5)))),
                      1. - sst(.00025, .00025 + px, abs(boxSDF(P, vec2((x0 + x1) * .5, 0.), vec2((x1 - x0) * .5 + .0028, (z1 - z0) * .5 + .0028)))));
    col = mix(col, vec3(.25, .19, .12), max(rule * .4, frame * .6));
    // 第 4 轮（qa2-06 / main3-02）：书口一侧的半个版心——版框上下边延到书口折痕，窄栏里上段一道黑象鼻、下接半枚鱼尾（古籍的标记，不写字）
    {
      float fx = -.1497, ix = x0 - .0028;                                   // 书口折痕、版框外边线
      float zt = z0 - .0028, zb = z1 + .0028;
      float inC = step(fx, P.x) * step(P.x, ix);
      float hl = max(1. - sst(.0004, .0004 + px, abs(P.y - zt)), 1. - sst(.0004, .0004 + px, abs(P.y - zb))) * inC;
      float xr = clamp((P.x - fx) / (ix - fx), 0., 1.);                     // 0 = 折痕，1 = 版框
      float nose = step(zt, P.y) * step(P.y, -.0818) * step(xr, .5);       // 黑口象鼻：整条居中在折痕上，这一页只见半条
      float tail = step(-.0818, P.y) * step(P.y, -.0742 - .0056 * (1. - xr)) * step(xr, .88);   // 鱼尾：下沿的 V 口开在折痕上，这一页是半枚
      float mk = max(nose, tail) * step(.0003, P.x - fx) * (.9 + .1 * vnoise(P * 4000., 68u));
      col = mix(col, vec3(.25, .19, .12), hl * .6);
      col = mix(col, INKC, mk * .95);
    }
    // 印好的卦画（SDF 矩形，带一点印刷毛边）
    float ink = 0.;
    for (int k = 1; k <= 6; k++) {
      float z = ${'-0.020'} + (3.5 - float(k)) * .0095;
      float yang = (k == 1 || k == 3 || k == 4 || k == 5) ? 1. : 0.;
      float d;
      if (yang > .5) d = boxSDF(P, vec2(-.075, z), vec2(.030, .00275));
      else d = min(boxSDF(P, vec2(-.0925, z), vec2(.0125, .00275)), boxSDF(P, vec2(-.0575, z), vec2(.0125, .00275)));
      d += .0003 * (vnoise(P * 3000., 7u) - .5);
      float a = 1. - sst(-px * .5, px * .5, d);
      float lifted = k <= 3 ? uLift.x : uLift.y;
      ink = max(ink, a * mix(1., 0., lifted));
      col = mix(col, vec3(.578, .506, .332), a * lifted * .55);   // 浮起后留下的淡痕 #C8BC9C
    }
    col = mix(col, INKC, ink * uLift.z * (.9 + .1 * vnoise(P * 4000., 8u)));
    // 浮起的爻条在纸上的投影：往光的反方向偏、越高越虚
    float sh = 0.;
    for (int k = 1; k <= 6; k++) {
      vec4 bl = uBarLift[k - 1];
      if (bl.x <= 0.) continue;
      float z = -0.020 + (3.5 - float(k)) * .0095;
      vec2 off = vec2(-.89, .45) * bl.x * .9;
      float blur = .0006 + bl.x * .08;
      float yang = (k == 1 || k == 3 || k == 4 || k == 5) ? 1. : 0.;
      float d = yang > .5 ? boxSDF(P - off, vec2(-.075, z), vec2(.0285 * 2. * .5 + .0015, .00275)) : min(boxSDF(P - off, vec2(-.0925, z), vec2(.0125, .00275)), boxSDF(P - off, vec2(-.0575, z), vec2(.0125, .00275)));
      sh = max(sh, (1. - sst(-blur, blur, d)) * (1. - sst(.2, .9, bl.y)));
    }
    col *= 1. - .38 * sh * uShadow.x;
    // 革字
    vec2 gq = (P - uGeR.xy) / uGeR.z + .5;
    if (gq.x > 0. && gq.x < 1. && gq.y > 0. && gq.y < 1.) { float g = texture2D(tGe, vec2(gq.x, 1. - gq.y)).a; col = mix(col, INKC, g * uGeR.w * (.88 + .12 * vnoise(P * 4000., 9u))); }
    // 补纸（左下，浅色，纤维毛边）
    // 补纸（返修 tech-16）：颜色贴近纸色、盖住栏线（栏线在补纸处断开）、纤维毛边加大、外加一圈 1K 的暗边
    float pd = boxSDF(P, vec2(-.112, .07), vec2(.022, .016)) + .006 * fbm(P * 420., 10u) + .0015 * fbm(P * 1800., 12u);
    vec3 patchC = paper * (1.035 + .05 * vnoise(vec2(P.x * 1900., P.y * 5200.), 13u));
    col = mix(col, patchC, 1. - sst(-.0004, .0004, pd));
    col *= 1. - .22 * (1. - sst(.0, .0005, abs(pd + .0002)));
    // 虫蛀
    for (int h = 0; h < 2; h++) { vec2 c = h == 0 ? vec2(-.131, -.071) : vec2(-.026, .083); float hd = length(P - c) - .0016 * (1. + .4 * vnoise(P * 2500. + float(h), 11u)); col = mix(col, vec3(.06, .035, .02), 1. - sst(-px, px, hd)); }
  } else {
    // 右页：木刻（墨量图 multiply）+ 书里的豹长出的新斑
    vec2 wq = vec2((P.x - uWoodR.x) / (uWoodR.z - uWoodR.x), (P.y - uWoodR.y) / (uWoodR.w - uWoodR.y));
    if (wq.x > 0. && wq.x < 1. && wq.y > 0. && wq.y < 1.) {
      float wv = texture2D(tWood, vec2(wq.x, 1. - wq.y)).r;
      col *= mix(vec3(.04, .035, .03), vec3(1.), wv);
      vec2 tp = wq * vec2(1086., 1448.);
      float sa = 0.;
      for (int i = 0; i < 18; i++) { if (i >= uNS) break; vec2 m = motif((tp - uNSp[i].xy) / uNSp[i].z, uNSph[i], uNSp[i].w, .05, 1.); sa = max(sa, m.x); }
      col = mix(col, vec3(.0232, .0152, .0092), sa * uNSa * .85);
    }
    // 第 4 轮（qa2-06 / main3-02）：右页书口一侧同样是半个版心：双线隔出窄栏，上段黑象鼻、下接半枚鱼尾（不写字）
    {
      float fx = .1497, ix = .1392, zt = -.0768, zb = .0768;
      float inC = step(ix, P.x) * step(P.x, fx);
      float vl = max(1. - sst(.00025, .00025 + px, abs(P.x - ix)), 1. - sst(.00025, .00025 + px, abs(P.x - (ix - .0019)))) * step(zt, P.y) * step(P.y, zb);
      float hl = max(1. - sst(.0004, .0004 + px, abs(P.y - zt)), 1. - sst(.0004, .0004 + px, abs(P.y - zb))) * step(uWoodR.z, P.x) * step(P.x, fx);
      float xr = clamp((fx - P.x) / (fx - ix), 0., 1.);
      float nose = step(zt, P.y) * step(P.y, -.0618) * step(xr, .5);
      float tail = step(-.0618, P.y) * step(P.y, -.0542 - .0056 * (1. - xr)) * step(xr, .88);
      col = mix(col, vec3(.25, .19, .12), max(vl, hl) * .6);
      col = mix(col, INKC, max(nose, tail) * step(.0003, fx - P.x) * .95 * (.9 + .1 * vnoise(P * 4000., 69u)));
    }
  }
  // 光照：纸面微曲 → 两阶
  vec3 N = normalize(vN); vec3 L = normalize(uLight);
  float hl = .5 * dot(N, L) + .5;
  col *= mix(vec3(1.), vec3(.86, .80, .70), clamp((.55 - hl) / .12 + .5, 0., 1.));
  // 开门边缘：像纸被水浸湿
  // 开门边缘（返修 tech-12）：窄的两阶水渍——外沿浅、贴着洞口深，外沿带 fbm 毛边
  if (uSide < .5 && uDoor.w > .5) { float wet = sst(.06 + .05 * fbm(P * 2400., 63u), .22, M); col = mix(col, col * vec3(.80, .74, .66), wet * .55); col = mix(col, vec3(.102, .058, .028), sst(.34, .5, M) * .45); }
  // 反射光点（琥珀软椭圆）
  if (uSpot.w > 0.) { float d = length((P - uSpot.xy) / vec2(uSpot.z, uSpot.z * .7)); col += vec3(1., .76, .43) * uSpot.w * exp(-d * d * 1.6) * .9; }
  if (uPool.w > 0.) { vec2 d = vW.xz - uPool.xy; vec2 ax = normalize(vec2(.8, -.4)); float dp = dot(d, ax), dq = dot(d, vec2(-ax.y, ax.x)); float pl = exp(-(dp * dp / (uPool.z * uPool.z * 2.6) + dq * dq / (uPool.z * uPool.z))); col *= mix(1. - uPool.w, 1. + .3 * uPool.w, pl); }
  if (uDap.x > 0.) { float Ld = dappleW(vW) * uDap.x; col = mix(col * vec3(.70, .72, .78), col * vec3(1.42, 1.22, .86) + vec3(.896, .552, .147) * .10, Ld); }
  gl_FragColor = vec4(col, 1.);
}`;

// 爻条门扇（返修 style-06）：读成"从纸上浮起的印刷爻"——一条纸，顶面印墨（墨 → 朱，墨量 .85–1.0 不匀、木刻式的毛边），
// 侧面和背面是纸色 #C8BC9C；受光面明度封顶 .75；漆面高光只留一条细线（pow 80）
const BAR_VS = /* glsl */`varying vec3 vO, vN, vW, vNo; void main(){ vO = position; vNo = normal; vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const BAR_FS = /* glsl */`${GLSL_COMMON}
uniform vec3 uInkA, uInkB, uPaper, uLight; uniform float uMix, uHX, uHZ, uSeed, uFlash, uK;
varying vec3 vO, vN, vW, vNo;
void main(){
  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
  vec3 L = normalize(uLight), V = normalize(cameraPosition - vW);
  float hl = .5 * dot(N, L) + .5;
  float top = sst(.6, .8, vNo.y);
  // 顶面的印墨：边缘是木刻印出来的毛边（fbm），墨量不匀
  float d = min(uHX - abs(vO.x), uHZ - abs(vO.z));
  float n = fbm(vO.xz * 2600. + uSeed * 13.7, 61u);
  float ink = top * sst(.00012, .00032, d - .00022 * (n + .5));
  float dens = .85 + .15 * vnoise(vO.xz * 1100. + uSeed * 7.1, 62u);
  vec3 inkC = mix(uInkA, uInkB, uMix);
  vec3 paper = uPaper * (.9 + .12 * vnoise(vec2(vO.x * 3200., vO.z * 420.) + uSeed, 63u));
  vec3 col = mix(paper, inkC * (1. + .25 * (1. - dens)), ink * mix(.82, 1., dens));
  // 纸纤维透过墨层
  col *= .95 + .1 * vnoise(vec2(vO.x * 5200., vO.z * 900.) + uSeed * 3., 64u);
  // 两阶明暗 + 软交界
  float m1 = clamp((.55 - hl) / .08 + .5, 0., 1.);
  col *= mix(1., .58, m1);
  // 漆面高光：一条细线
  vec3 H = normalize(L + V); float sp = pow(max(dot(N, H), 0.), 80.);
  col += vec3(.9, .7, .5) * sst(.62, .7, sp) * .18 * ink;
  // 受光面明度封顶 .75（sRGB）≈ 线性 .52
  float lc = lum(col); col *= min(1., mix(.52, .30, ink) / max(lc, 1e-4));   // 纸 .75、印墨处更低（朱不被窗光推进高光）
  col += inkC * uFlash * ink;
  gl_FragColor = vec4(col, 1.);
}`;
function barMaterial(halfL, seed) {
  return new THREE.ShaderMaterial({ vertexShader: BAR_VS, fragmentShader: BAR_FS, toneMapped: false, side: THREE.DoubleSide,
    uniforms: { uInkA: { value: lin3('#1F1B17') }, uInkB: { value: lin3('#8E3523') }, uPaper: { value: lin3('#BFB293') }, uLight: { value: V3(...LIGHT_A).normalize() },
      uMix: { value: 0 }, uHX: { value: halfL / 2 }, uHZ: { value: .00275 }, uSeed: { value: seed }, uFlash: { value: 0 }, uK: SHARED.uK } });
}

export function buildRoom(ctx) {
  const { tex, man } = ctx;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(22.07, 1920 / 1040, .004, 60);
  const M = id => man.find(m => m.id === id);

  // ── 背景：A17 墙窗（去掉画里的桌沿） ──
  const wallU = { map: { value: tex.room }, uTint: { value: V3(1, 1, 1) }, uA: { value: 1 } };
  const wallMat = new THREE.ShaderMaterial({ vertexShader: PV, fragmentShader: /* glsl */`uniform sampler2D map; uniform vec3 uTint; uniform float uA; varying vec2 vUv; void main(){ vec2 q = vec2(vUv.x, mix(.13, 1., vUv.y)); gl_FragColor = vec4(texture2D(map, q).rgb * uTint, uA); }`, uniforms: wallU, depthWrite: false, toneMapped: false });
  const wallPlate = new THREE.Mesh(UNIT, wallMat); wallPlate.renderOrder = -50; wallPlate.position.set(-.6, .55, -1.25); wallPlate.scale.set(3.6, 3.6 * (862 * .87) / 1825, 1); scene.add(wallPlate);
  const bg = new THREE.Mesh(new THREE.SphereGeometry(20, 16, 8), new THREE.MeshBasicMaterial({ color: lin3('#180C0A').multiplyScalar(1).getHex ? new THREE.Color().setRGB(...lin3('#180C0A').toArray()) : 0x110807, side: THREE.BackSide, depthWrite: false }));
  bg.renderOrder = -60; scene.add(bg);

  // ── 书桌 ──
  // 返修 style-11（第 2 轮）：桌面不再是平涂褐——贴一张画出来的胡桃木笔触贴图（Magpie，tex_desk_paint，按全图平均色归一，只借木纹、浓淡和旧墨点）
  const deskMat = makeToon({ base: '#5A462F', s1: '#3D2114', s2: '#22120B', step1: .56, f1: .08, step2: .30, f2: .10, light: LIGHT_A, wood: .12, rimLit: '#F3B136', rimLitAmt: 0, rimLitIn: .2, fres: .18, edgeN: .02, doorCut: 1,
    paint: tex.deskPaint, paintAmt: .7, paintS: 2.6, paintR: [0, 0, 1, 1], paintMean: [.0941, .0246, .0062], paintAlways: 1 });
  const dsh = new THREE.Shape(); { const w = .7, d = .36, r = .03; dsh.moveTo(-w + r, -d); dsh.lineTo(w - r, -d); dsh.quadraticCurveTo(w, -d, w, -d + r); dsh.lineTo(w, d - r); dsh.quadraticCurveTo(w, d, w - r, d); dsh.lineTo(-w + r, d); dsh.quadraticCurveTo(-w, d, -w, d - r); dsh.lineTo(-w, -d + r); dsh.quadraticCurveTo(-w, -d, -w + r, -d); }
  const deskG = new THREE.ExtrudeGeometry(dsh, { depth: .045, bevelEnabled: true, bevelThickness: .006, bevelSize: .006, bevelSegments: 2, curveSegments: 6 });
  deskG.rotateX(-Math.PI / 2); deskG.translate(0, -.063 + (DESK_Y + .012), -.10);   // 桌面顶在 y = DESK_Y（挤出 −0.006..0.051 再下移）
  const desk = new THREE.Mesh(deskG, deskMat); outlined(desk, 1.0, .7); scene.add(desk);

  // ── 线装书：两页曲面 + 书块 + 封面板 ──
  const geText = (() => { const cv = document.createElement('canvas'); cv.width = cv.height = 512; const g = cv.getContext('2d'); g.fillStyle = '#000'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '440px MSZ'; g.fillText('革', 256, 270); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.NoColorSpace; return t; })();
  const woodTex = tex.woodcut; woodTex.colorSpace = THREE.NoColorSpace;
  const pageU = side => ({ tWood: { value: woodTex }, tGe: { value: geText }, uLight: { value: V3(...LIGHT_A).normalize() }, uSide: { value: side }, uDoor: SHARED.uDoor, uK: SHARED.uK,
    uLift: { value: new THREE.Vector4(0, 0, 1, 0) }, uSpot: { value: new THREE.Vector4(0, 0, .011, 0) }, uDap: SHARED.uDap, uDapW: SHARED.uDapW, uDapWP: SHARED.uDapWP, uPool: SHARED.uPool,
    uNS: { value: 0 }, uNSp: { value: Array.from({ length: 18 }, () => new THREE.Vector4()) }, uNSph: { value: Array.from({ length: 18 }, () => new THREE.Vector4()) }, uNSa: { value: 0 },
    uWoodR: { value: new THREE.Vector4(.0195, -.074, .1305, .074) }, uGeR: { value: new THREE.Vector4(-.034, -.073, .0135, 1) },
    uShadow: { value: new THREE.Vector4() }, uBarLift: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) } });
  const pageGeo = side => {
    const g = new THREE.PlaneGeometry(.15, .21, 48, 16); g.rotateX(-Math.PI / 2);
    const P = g.attributes.position;
    for (let i = 0; i < P.count; i++) { const x = P.getX(i) + (side ? .075 : -.075); P.setXYZ(i, x, pageY(x) + .0004, P.getZ(i)); }
    g.computeVertexNormals(); return g;
  };
  const pages = [0, 1].map(side => { const u = pageU(side); const m = new THREE.Mesh(pageGeo(side), new THREE.ShaderMaterial({ vertexShader: PAGE_VS, fragmentShader: PAGE_FS, uniforms: u, toneMapped: false })); outlined(m, .7, .6); scene.add(m); return { m, u }; });
  // 书块（截面是纸面曲线下方的区域，沿 z 挤出），书口条纹
  // 第 4 轮（qa2-06 / main3-02）：线装书——书块底下 1.1 mm 是和书块一样大的软封面（磁青纸，不外伸），书沟两端包角 + 绕过书根的订线；
  //   纸口的层纹加密、带起伏（一叶一叶的纸，不是整块）
  const blockMat = makeToon({ base: '#C8BC9C', s1: '#A1825D', s2: '#74583C', step1: .55, f1: .1, step2: .3, f2: .12, light: LIGHT_A, strata: .6, strataF: 1100, fres: .1, edgeN: 0, doorCut: 1,
    bind: { mode: 2, h: [BLOCK_Y, 0, 0], cov: '#3C4A5A', silk: '#34405A', thr: '#B9AE96' } });
  const blocks = [0, 1].map(side => {
    const sh = new THREE.Shape(); const sx = side ? 1 : -1;
    sh.moveTo(0, BLOCK_Y); for (let i = 0; i <= 24; i++) { const x = sx * .15 * i / 24; sh.lineTo(x, pageY(x)); } sh.lineTo(sx * .15, BLOCK_Y); sh.lineTo(0, BLOCK_Y);
    const g = new THREE.ExtrudeGeometry(sh, { depth: .208, bevelEnabled: false }); g.translate(0, 0, -.104);
    const m = new THREE.Mesh(g, blockMat); outlined(m, .8, .6); scene.add(m); return m;
  });
  // 原来的外伸青色硬壳（精装书的书壳）去掉：软封面已经画在书块最底下那 1.1 mm 里，和书页同宽

  // ── 道具：砚、笔筒、书堆、青瓷水盂、补纸 ──
  const props = new THREE.Group(); scene.add(props);
  const pm = (b, s1, s2, o = {}) => makeToon({ base: b, s1, s2, step1: .56, f1: .08, step2: .30, f2: .10, light: LIGHT_A, edgeN: .03, edgeNS: 12, rimLit: '#F3B136', rimLitAmt: .15, rimLitIn: .35, fres: .25, ao: 1, floorY: DESK_Y, aoR: .025, ...o });
  const inkstone = new THREE.Mesh(new RoundedBoxGeometry(.16, .024, .11, 3, .008), pm('#2B2724', '#1E1B19', '#121010')); inkstone.position.set(-.33, DESK_Y + .012, -.22); inkstone.rotation.y = .25; outlined(inkstone); props.add(inkstone);
  const inkPool = new THREE.Mesh(new RoundedBoxGeometry(.1, .004, .065, 2, .003), pm('#121010', '#0C0A0A', '#080707', { spec: .5, specC: '#8A7A62', specPow: 60 })); inkPool.position.set(-.335, .0005, -.218); inkPool.rotation.y = .25; props.add(inkPool);
  const potG = new THREE.CylinderGeometry(.04, .042, .13, 24, 1, true); const pot = new THREE.Mesh(potG, pm('#8C7845', '#6A5A33', '#463B22', { side: THREE.DoubleSide })); pot.position.set(-.5, DESK_Y + .065, -.36); outlined(pot); props.add(pot);
  for (let i = 0; i < 2; i++) {
    // 笔：杆 + 笔头（笔头朝上晾着），整支一起倾斜
    const brush = new THREE.Group();
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(.0045, .0045, .2, 8), pm('#5A462F', '#3D2114', '#22120B')); stick.position.y = .1; outlined(stick); brush.add(stick);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(.0062, .032, 10), pm('#2A2520', '#1A1714', '#0E0C0A')); tip.position.y = .2 + .016; outlined(tip); brush.add(tip);
    brush.position.set(-.5 + (i - .5) * .02, DESK_Y + .005, -.36 + (i - .5) * .01); brush.rotation.z = (i - .5) * .22; brush.rotation.x = (i - .5) * -.08;
    props.add(brush);
  }
  // 第 4 轮（qa2-06 / main3-02）：背景书堆也是线装书——软封面和书页同大，书脊一侧四眼订线、两角包角，封面上一条题签（不写字）
  const bookStack = [];
  const volMat = pm('#C8BC9C', '#A1825D', '#74583C', { strata: .6, strataF: 1100, bind: { mode: 1, h: [.116, .0055, .081], cov: '#3C4A5A', silk: '#34405A', thr: '#CFC3A8' } });
  for (let i = 0; i < 3; i++) { const g = new THREE.Group(); const vol = new THREE.Mesh(new THREE.BoxGeometry(.232, .011, .162, 1, 1, 1), volMat); g.add(vol); g.position.set(-.40 + i * .006, DESK_Y + .0057 + i * .0113, -.32 - i * .004); g.rotation.y = .18 + i * .07; outlined(vol); props.add(g); bookStack.push(g); }
  const lp = [[0, 0], [.03, .002], [.045, .02], [.04, .05], [.025, .065], [.018, .072], [.022, .078], [.02, .08]].map(([x, y]) => new THREE.Vector2(x, y));
  const waterPot = new THREE.Mesh(new THREE.LatheGeometry(lp, 32), pm('#9DB4A4', '#738B75', '#4A5B58', { spec: .4, specC: '#E8F0E6', specPow: 40, side: THREE.DoubleSide })); waterPot.position.set(.34, DESK_Y, -.24); outlined(waterPot); props.add(waterPot);
  const patch = new THREE.Mesh(new RoundedBoxGeometry(.12, .006, .09, 2, .001), pm('#D1BFA4', '#A1825D', '#74583C')); patch.position.set(.40, DESK_Y + .003, -.16); patch.rotation.y = -.35; outlined(patch, .8, .6); props.add(patch);

  // ── 光柱 ×5（加色卡，从右窗扇形铺到桌面）、浮尘 ×90 ──
  const BEAM_FS = /* glsl */`${GLSL_COMMON} uniform float uA, uT, uSeed; uniform vec3 uC; varying vec2 vUv;
    void main(){ float x = abs(vUv.x - .5) * 2.; float w = (1. - sst(.35, 1., x)) * sst(0., .25, vUv.y) * (1. - sst(.7, 1., vUv.y)); float n = .75 + .5 * fbm(vec2(vUv.x * 3. + uSeed, vUv.y * 1.5 + uT * .02), 51u); gl_FragColor = vec4(uC * w * n * uA, 1.); }`;
  const beams = Array.from({ length: 5 }, (_, i) => {
    const u = { uA: { value: .07 + .03 * hashi(i) }, uT: { value: 0 }, uSeed: { value: i * 2.7 }, uC: { value: lin3('#F3B136') } };
    const m = new THREE.Mesh(UNIT, new THREE.ShaderMaterial({ vertexShader: PV, fragmentShader: BEAM_FS, uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }));
    const top = V3(.95, .75 + .45 * (i / 4), -.75 + .3 * (i / 4)), bot = V3(.05 + .12 * i - .25, -.01, -.15 + .07 * i);
    const mid = top.clone().add(bot).multiplyScalar(.5), len = top.distanceTo(bot);
    m.position.copy(mid); m.lookAt(mid.clone().add(V3(0, 0, 1))); m.scale.set(.09 + .05 * hashi(i * 3), len, 1);
    const dir = top.clone().sub(bot).normalize(); m.quaternion.setFromUnitVectors(V3(0, 1, 0), dir);
    m.rotateY(-.6 + .3 * hashi(i * 5));
    m.renderOrder = 40; m.userData.outline = false; scene.add(m);
    const m2 = m.clone(); m2.rotateY(Math.PI / 2); scene.add(m2);
    return { m, u, top, bot };
  });
  const NDUST = 90;
  const dustPos = new Float32Array(NDUST * 3), dustA = new Float32Array(NDUST);
  const dustG = new THREE.BufferGeometry(); dustG.setAttribute('position', new THREE.BufferAttribute(dustPos, 3)); dustG.setAttribute('aA', new THREE.BufferAttribute(dustA, 1));
  const dustU = { uK: SHARED.uK, uSize: { value: 2.4 }, uC: { value: lin3('#FFE2B0').multiplyScalar(1.8) } };
  const dust = new THREE.Points(dustG, new THREE.ShaderMaterial({ vertexShader: /* glsl */`attribute float aA; varying float vA; uniform float uK, uSize; void main(){ vA = aA; vec4 mv = modelViewMatrix * vec4(position, 1.); gl_PointSize = uSize * uK * (1. + aA); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`varying float vA; uniform vec3 uC; void main(){ vec2 d = gl_PointCoord - .5; float a = 1. - smoothstep(.2, .5, length(d)); gl_FragColor = vec4(uC * a * vA * 2.5, 1.); }`, uniforms: dustU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  dust.frustumCulled = false; dust.renderOrder = 41; scene.add(dust);
  function setDust(t) {
    for (let i = 0; i < NDUST; i++) {
      const b = beams[i % 5]; const s = hashi(i * 7 + 1);
      const p = b.bot.clone().lerp(b.top, .1 + .8 * s);
      p.x += (hashi(i * 7 + 2) - .5) * .12 + .01 * Math.sin(t * (.4 + hashi(i) * .5) + i) + .004 * t;
      p.y += (hashi(i * 7 + 3) - .5) * .08 + .01 * Math.sin(t * (.3 + hashi(i * 3) * .4) + i * 2) - .002 * t;
      p.z += (hashi(i * 7 + 4) - .5) * .12;
      dustPos[i * 3] = p.x; dustPos[i * 3 + 1] = p.y; dustPos[i * 3 + 2] = p.z;
      dustA[i] = .3 + .7 * hashi(i * 11);
    }
    dustG.attributes.position.needsUpdate = true; dustG.attributes.aA.needsUpdate = true;
  }

  // ── 六爻条：12 段门扇（阳爻两半之间留 3 mm 中缝；阴爻中间空 10 mm） ──
  const bars = [];
  for (let k = 1; k <= 6; k++) {
    const yang = HEX[k - 1] === 1, halfL = yang ? .0285 : .025;
    for (const side of [-1, 1]) {
      const mat = barMaterial(halfL, k * 2 + (side > 0 ? 1 : 0));
      const g = new RoundedBoxGeometry(halfL, .0025, .0055, 2, .0003);
      const hinge = new THREE.Group();
      const hx = HEX_C[0] + side * .03;
      hinge.position.set(hx, 0, barZ(k));
      const bar = new THREE.Mesh(g, mat); bar.position.set(-side * halfL / 2, .00125, 0);
      outlined(bar, .9, .9); hinge.add(bar); scene.add(hinge);
      bars.push({ k, side, hinge, bar, mat, yang });
    }
  }
  // 爻缝、中缝的光（加色细条）
  const seamU = { uA: { value: 0 }, uW: { value: .0003 }, uC: { value: lin3('#FFF3D6') } };
  const seam = new THREE.Mesh(UNIT, new THREE.ShaderMaterial({ vertexShader: PV, fragmentShader: /* glsl */`uniform float uA; uniform vec3 uC; varying vec2 vUv; void main(){ float x = abs(vUv.x - .5) * 2.; float a = exp(-x * x * 9.) * (1. - smoothstep(.85, 1., abs(vUv.y - .5) * 2.)); gl_FragColor = vec4(uC * a * uA * 3., 1.); }`, uniforms: seamU, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  seam.rotation.x = -Math.PI / 2; seam.position.set(HEX_C[0], pageY(HEX_C[0]) + .0012, HEX_C[1]); seam.renderOrder = 45; seam.userData.outline = false; scene.add(seam);
  const poolU = { uA: { value: 0 }, uC: { value: lin3('#F3B136') } };
  const pool = new THREE.Mesh(UNIT, new THREE.ShaderMaterial({ vertexShader: PV, fragmentShader: /* glsl */`uniform float uA; uniform vec3 uC; varying vec2 vUv; void main(){ vec2 d = (vUv - .5) * 2.; float a = exp(-dot(d, d) * 2.2); gl_FragColor = vec4(uC * a * uA, 1.); }`, uniforms: poolU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  pool.rotation.x = -Math.PI / 2; pool.position.set(HEX_C[0], pageY(HEX_C[0]) + .0015, HEX_C[1]); pool.scale.set(.1, .1, 1); pool.renderOrder = 44; pool.userData.outline = false; scene.add(pool);
  // 门洞衬板：门内世界（rtWorld，sRGB）贴在最底层
  const doorU = { tWorld: { value: null }, uOn: { value: 0 }, uDbg: { value: 0 } };
  const doorBg = new THREE.Mesh(UNIT, new THREE.ShaderMaterial({ vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * 2., .9999, 1.); }`,
    fragmentShader: /* glsl */`uniform sampler2D tWorld; uniform float uDbg; varying vec2 vUv; void main(){ vec3 c = texture2D(tWorld, vUv).rgb; c = mix(c / 12.92, pow((c + .055) / 1.055, vec3(2.4)), step(.04045, c)); if (uDbg > .5) c = vec3(1., 0., 1.); gl_FragColor = vec4(c, 1.); }`,
    uniforms: doorU, depthTest: true, depthWrite: false, toneMapped: false }));
  doorBg.renderOrder = 1000; doorBg.frustumCulled = false; doorBg.visible = false; doorBg.userData.outline = false; doorBg.userData.outlineOccluder = false; scene.add(doorBg);

  // ── 精灵 ──
  const mk = (t, o) => { const S = makeSprite(t, o); scene.add(S.group); return S; };
  const hand = mk(tex.handTweezers, { order: 30 });
  const glassHand = mk(tex.handGlasses, { order: 31, mask: false });
  // 第 3 轮（v2-01）：眼镜戴上以后松手——换成 Magpie 以 A12 为底出的空手 A12d（同一画布、手指微张、手里什么都不拿），
  //   不再用 A12 裁掉一半的贴图（那张手里还捏着铜钩和半片镜片）
  const glassHand2 = mk(tex.handRelease, { order: 31, mask: false, rect: [700, 0, 838, 959] });
  // 第 4 轮（v3-01 / qa2-02）：手到了耳侧，手腕下只有一截圆头袖口、后面没有前臂，像一只断手悬在桌面上。
  //   补一段代码画的袖管（衬衫同一块布）：从袖口里伸出来、顺着袖口的轴往下，压到肩背剪影后面（头肩卡 order 32 画在它上面，
  //   把它挡住——读成"手肘在他胸前，前臂从肩后抬上来"），下端出画框。和手同一个位置、大小、角度、同一份材质内虚焦；
  //   袖口（手的贴图）盖在袖管的上端上面，读成"卷起的袖口套在袖子上"。袖管在 A12 整图坐标系里画（A12 / A12d 同一画布）。
  const SLV = { x0: 300, y0: 500, w: 2300, h: 2500 };   // 袖管的虚拟画布：A12 整图坐标里往下、往两边扩出去的一块
  const sleeveU = { uA: { value: new THREE.Vector2(1240, 860) }, uDir: { value: new THREE.Vector2(.12, 1).normalize() }, uLen: { value: 2100 }, uRA: { value: 158 }, uRB: { value: 196 },
    uBlur: { value: 8 }, uAlpha: { value: 1 }, uLight: { value: V3(1, .93, .82) }, uC: { value: lin3('#D9C5B1') }, uLine: { value: lin3('#4F3A24') }, uRimC: { value: lin3('#F3B136') }, uRimAmt: { value: .45 },
    uCuff: { value: 92 }, uCanvas: { value: new THREE.Vector4(SLV.x0, SLV.y0, SLV.w, SLV.h) }, uPad: { value: new THREE.Vector4() } };
  const sleeve = (() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: sleeveU, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      vertexShader: /* glsl */`uniform vec4 uCanvas; varying vec2 vPx; void main(){ vPx = vec2(uCanvas.x + uv.x * uCanvas.z, uCanvas.y + (1. - uv.y) * uCanvas.w); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */`${GLSL_COMMON}
        uniform vec2 uA, uDir; uniform float uLen, uRA, uRB, uBlur, uAlpha, uRimAmt, uCuff; uniform vec3 uLight, uC, uLine, uRimC;
        varying vec2 vPx;
        void main(){
          vec2 ax = normalize(uDir), nx = vec2(ax.y, -ax.x);        // nx：沿袖管往下看时的画面右侧
          vec2 d = vPx - uA;
          float t = dot(d, ax), s = dot(d, nx);
          float tc = clamp(t / uLen, 0., 1.);
          // 变径（往肘部略粗）+ 布料轮廓的轻微起伏
          float r = mix(uRA, uRB, sst(0., 1., tc)) * (1. + .025 * sin(t / 160. + 1.1) + .05 * fbm(vec2(t / 240., s > 0. ? 3.1 : 7.7), 64u));
          float sd = (t < 0. ? length(d) : abs(s)) - r;
          float bl = uBlur * .85 + 1.2;
          float a = 1. - sst(-bl, bl, sd);
          if (a < .004) discard;
          float u = clamp(s / r, -1., 1.);
          vec3 c = uC * (.96 + .08 * vnoise(vPx / 38., 65u));
          // 软陶体积：受光在左上（和袖口一致），右侧暗下去；越往肘部越暗（离开窗光，落进身体前面的影子里）
          c *= mix(1.05, .72, sst(-.75, .95, u));
          c *= mix(vec3(1.), vec3(.44, .41, .37), sst(0., 460., t));   // 越往肘部越暗、越偏衬衫的暖灰（和头肩卡里背光的衬衫接上）
          // 袖口下缘投在袖管上的一道影
          float under = t - uCuff;
          c *= 1. - .30 * sst(-36., 0., under) * (1. - sst(0., 95., under));
          // 两道斜褶（软）
          float fold = 0.;
          for (int i = 0; i < 2; i++) { float fi = float(i); float y0 = 300. + 250. * fi; float dd = (t - y0 - .42 * s * (fi > .5 ? -1. : 1.)) / (24. + bl * .5); fold = max(fold, exp(-dd * dd) * (1. - sst(.5, .95, abs(u)))); }
          c *= 1. - .15 * fold;
          // 描线：和手的资产描线同色、同宽（约 6 贴图像素），随材质内虚焦一起虚；顶端藏在袖口里，不描
          float lw = 6.;
          float ln = (1. - sst(lw * .5, lw * .5 + bl, abs(sd + lw * .5))) * sst(-40., 0., t);
          c = mix(c, uLine, ln * .92);
          // 右侧窗光的琥珀边（越往下越弱）
          c = mix(c, uRimC, sst(.62, .95, u) * (1. - ln) * uRimAmt * .55 * (1. - sst(180., 900., t)));
          c *= uLight;
          gl_FragColor = vec4(c, a * uAlpha);
        }` }));
    m.renderOrder = 30.9; m.frustumCulled = false; m.userData.outline = false;
    const group = new THREE.Group(); group.add(m); group.userData.outline = false; scene.add(group);
    return { group, color: m, u: sleeveU, w: SLV.w, h: SLV.h };
  })();
  // S1b 的头肩卡用 A10：它的右手正握着笔（S1b 里这只手在拿眼镜），耳朵上已经戴着眼镜（f43 才戴上）。
  // 载入时用 Canvas 处理一份 S1b 专用贴图（确定性，不改资产文件）：
  //   ① 擦掉前臂、手和笔（沿上臂外缘切开，补一道深褐描线）；② f43 之前再把镜腿补成头发、擦掉耳后露出的镜片。
  const s1bTex = (() => {
    // 返修 self-08：f54 之前用 A10b（Magpie 去掉眼镜、配准回 A10 画布），不再用 Canvas 去补镜腿，耳后不会残留铜色弧线
    const W0 = tex.luDesk.image.width, H0 = tex.luDesk.image.height;
    const mkCv = () => { const cv = document.createElement('canvas'); cv.width = W0; cv.height = H0; return cv; };
    const armCut = [[805, 520], [957, 520], [957, 1000], [900, 990], [860, 900], [838, 800], [826, 740], [812, 700], [805, 620]];
    const cut = img => {
      const cv = mkCv(), g = cv.getContext('2d'); g.drawImage(img, 0, 0);
      g.save(); g.globalCompositeOperation = 'destination-out'; g.beginPath(); armCut.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill(); g.restore();
      // 切口补描线：只描在仍有衬衫的地方（source-atop）
      g.save(); g.globalCompositeOperation = 'source-atop'; g.strokeStyle = 'rgba(42,33,24,.95)'; g.lineWidth = 5; g.lineJoin = 'round';
      g.beginPath(); [[826, 740], [838, 800], [860, 900], [900, 990]].forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); g.restore();
      return cv;
    };
    const T = cv => { const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 8; return t; };
    return { withGlasses: T(cut(tex.luDesk.image)), noGlasses: T(cut(tex.luDeskNoGl.image)) };
  })();
  const headCard = mk(tex.luDesk, { order: 32, rect: [400, 0, 557, 1396] });
  // S1a「放下镊子」（返修 story-06）：A11b = 同一只手、没有镊子（Magpie 去掉镊子后配准回 A11 画布）；镊子单独一张（原图减去 A11b 得到）
  const twSplit = { hand: tex.handFree, tw: tex.tweezers };
  const tweezers = mk(twSplit.tw, { order: 29 });

  // 指尖墨渍：食指 22K（种子 7）、中指 14K、拇指侧 2 个 6K 小污点
  const A11 = M('A11')['锚点'];
  const tipI = A11['index_tip（食指侧面）'], tipM = A11['中指尖'], tipT = A11['拇指尖'];

  const sprites = [hand, glassHand, glassHand2, headCard, tweezers, sleeve];
  const hideAll = () => { for (const S of sprites) S.group.visible = false; };
  const aim = (p, t, up = V3(0, 1, 0)) => { cam.position.copy(p); cam.up.copy(up); cam.lookAt(t); cam.updateMatrixWorld(true); };
  const setFov = v => { cam.fov = v; cam.updateProjectionMatrix(); };
  const common = (t, beamK = 1, nBeams = 5) => {
    beams.forEach((b, i) => { b.u.uT.value = t; b.u.uA.value = (.15 + .05 * hashi(i)) * beamK * (i < nBeams ? 1 : 0); });   // 返修 style-11：光柱看得见
    setDust(t);
  };
  const setPool = (x, z, r, k) => SHARED.uPool.value.set(x, z, r, k);
  const resetT1 = () => { seamU.uA.value = 0; poolU.uA.value = 0; doorBg.visible = false; SHARED.uDoor.value.set(0, 0, 1, 0); pages[0].u.uShadow.value.set(0, 0, 0, 0); pages[1].u.uNSa.value = 0; pages[0].u.uSpot.value.set(0, 0, .011, 0); pages[1].u.uSpot.value.set(0, 0, .011, 0); };
  const resetBars = () => { for (const b of bars) { b.hinge.rotation.set(0, 0, 0); b.hinge.position.y = pageY(b.hinge.position.x); b.mat.uniforms.uMix.value = 0; b.mat.uniforms.uFlash.value = 0; b.hinge.visible = false; } };
  const setPrinted = (lowLift, upLift, inkAmt = 1) => { pages[0].u.uLift.value.set(lowLift, upLift, inkAmt, 0); };

  const shots = {};
  // S1a 书桌微缩（f0–f27）
  shots.S1a = (f, t) => {
    // 返修 story-06：S1a 拉长到 f0–f36。f0–2 悬停、f2–11 下降、f11 触桌压缩；f14–f22 镊子从指间滑落到页边（转 15°、落地弹 2 帧），
    //   f16–f20 手指张开、食指墨环转到正对镜头，f22–f34 停在清楚带里；f34 起手往右上收
    resetT1(); setPool(.10, -.04, .32, .42); wallU.uTint.value.set(.8, .75, .7);
    const tc = tcOf(f), k = tc * 24;
    const s = ss5(f / 36);
    const D = lerp(.86, .835, s);
    const pitch = 58 * DEG, yaw = -8 * DEG;
    const tgt = V3(.0 + .005 * s, .008, -.01);
    const dir = V3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    setFov(22.07); aim(tgt.clone().add(dir.multiplyScalar(D)), tgt);
    SHARED.uDoor.value.set(0, 0, 1, 0); doorBg.visible = false;
    resetBars(); setPrinted(0, 0, 1);
    hideAll(); common(t);
    pages[0].u.uSpot.value.set(0, 0, .011, 0); pages[1].u.uNSa.value = 0;
    const H = hand; H.group.visible = true;
    const down = ss(seg(k, 2, 11)), back = ss(seg(k, 34, 44)), open = ss(seg(k, 16, 20)), lift = ss(seg(k, 20, 25));
    const press = k >= 11 && k < 14 ? .02 : 0;
    const breath = Math.sin(tc * 3.1) * 1;
    // 第 2 轮（story-06 / style-02）：墨环挪到食指指肚正中（整枚落在手指上，不再被指缘截掉一半）；
    //   手的落点反算，让墨环在停住的 f22–f34 正好在 (1180, 600)；松开镊子后手指抬起 14K，看得见镊子躺在页边、和手分开了
    const INK_OFF = [72, -65];
    const sc = .64 * (1 - press) * (1 + .04 * (1 - down)), ang = -4 + 3 * back - 6 * open;
    const a0 = ang * DEG, ox = (INK_OFF[0] * Math.cos(a0) - INK_OFF[1] * Math.sin(a0)) * sc, oy = (INK_OFF[0] * Math.sin(a0) + INK_OFF[1] * Math.cos(a0)) * sc;
    const sx = 1180 - ox + 40 * back * .7 + 6 * (1 - down) + 6 * lift, sy = 600 - oy - 70 * (1 - down) - 40 * back + breath - 14 * lift;
    placeOnCam(H, cam, tipI[0], tipI[1], sx, sy, sc, .62, ang);
    H.u.map.value = k >= 14 ? twSplit.hand : tex.handTweezers;
    setBends(H, [{ pivot: [330, 420], center: tipI, angle: -10 * DEG * open, rIn: 60, rOut: 240 }]);
    const u = H.u; u.uLight.value.set(1, .93, .82); u.uRimC.value.copy(lin3('#F3B136')); u.uRimAmt.value = .55; u.uRimDir.value.set(1, -.3).normalize(); u.uRimW.value = texPx(H, 6);
    u.uDesat.value = 0; u.uFogAmt.value = 0; u.uTc.value = tc;
    u.uSpotXf.value.set(ang * DEG, 0);   // 第 4 轮（zs-01）：墨环按屏幕方向画，和 S4b 第一枚斑、S6 落在手上的那圈光同一个朝向
    setSpots(H, [{ x: tipI[0] + INK_OFF[0], y: tipI[1] + INK_OFF[1], r: texPx(H, 22), kind: 3, seed: 7, soft: .05 }, { x: tipM[0] - 18, y: tipM[1] - 10, r: texPx(H, 14), kind: 3, seed: 8, soft: .3, alpha: .55 }, { x: tipT[0] + 30, y: tipT[1] + 10, r: texPx(H, 6), kind: 3, seed: 9, soft: .4, alpha: .45 }, { x: tipT[0] + 60, y: tipT[1] - 14, r: texPx(H, 5), kind: 3, seed: 10, soft: .4, alpha: .4 }]);
    // 镊子：f14 起单独一张，绕镊子尖滑落、转 15°，f20–f22 落地弹一下
    const TW = tweezers; TW.group.visible = k >= 14;
    if (k >= 14) {
      const tip = A11['镊子尖'];
      const a0 = ang * DEG, rx = (tip[0] - tipI[0]) * sc, ry = (tip[1] - tipI[1]) * sc;
      const tx = sx + Math.cos(a0) * rx - Math.sin(a0) * ry, ty = sy + Math.sin(a0) * rx + Math.cos(a0) * ry;
      const fall = ss(seg(k, 14, 20)), bounce = k >= 20 && k < 22 ? -5 : 0;
      placeOnCam(TW, cam, tip[0], tip[1], tx - 26 * fall, ty + 46 * fall + bounce, sc, .62, ang + 15 * fall);
      const tu = TW.u; tu.uLight.value.set(1, .93, .82); tu.uRimAmt.value = 0; tu.uDesat.value = 0; tu.uFogAmt.value = 0; tu.uTc.value = tc;
    }
    return { scene, camera: cam, dof: { mode: 'tilt', tilt: [300, 10, 780, 7] } };
  };
  // S1b 过肩·戴眼镜（f27–f60）
  const A10 = M('A10')['锚点'], A12 = M('A12')['锚点'];
  shots.S1b = (f, t) => {
    // 返修 story-06：S1b 挪到 f36–f72（多 3 帧）。手不再在画里淡出——到了耳侧以后沿弧线从后脑后面退出画框左缘（被头挡住）；
    //   眼镜从镜头前过的那几帧虚化 30K → 14K，认得出镜圈和鼻托。返修 tech-03 / self-02：这只手离镜头太近，单独一拍一，每帧缩放变化 ≤15%
    resetT1(); setPool(.10, -.04, .32, .42); wallU.uTint.value.set(.8, .75, .7);
    const tc = tcOf(f);
    const s = ss5((f - 36) / 36);
    setFov(32.0);
    aim(V3(.115, .50, .60).lerp(V3(.040, .36, .40), s), V3(-.06, .02, 0).lerp(V3(-.075, 0, -.020), s));
    SHARED.uDoor.value.set(0, 0, 1, 0); doorBg.visible = false;
    resetBars(); setPrinted(0, 0, 1); hideAll(); common(t);
    const HC = headCard; HC.group.visible = true;
    HC.u.map.value = f < 54 ? s1bTex.noGlasses : s1bTex.withGlasses;
    placeOnCam(HC, cam, A10.ear_r[0] - 400, A10.ear_r[1], 400 - 140 * s, 360, 1.25, .21);
    const hu = HC.u; hu.uLight.value.set(.30, .25, .21);
    const tp = A10['镜腿路径（3点，耳后→铰链）'].map(([x, y]) => [x - 400, y]);
    hu.uLineOn.value = f >= 54 ? 1 : 0; hu.uLineA.value.set(tp[0][0], tp[0][1], tp[1][0], tp[1][1]); hu.uLineB.value.set(tp[2][0], tp[2][1], texPx(HC, 2.5), clamp((f - 62) / 4)); hu.uRimC.value.copy(lin3('#F3B136')); hu.uRimAmt.value = .5; hu.uRimDir.value.set(1, -.2).normalize(); hu.uRimW.value = texPx(HC, 6); hu.uDesat.value = 0;
    // 拿眼镜的手（A12）：低 → 镜头前（大、虚）→ 耳侧 → 从后脑后面退出画框左缘
    // 第 2 轮（story-06）：锚点改成捏着镜腿的食指尖——到耳侧时镜腿正搭在耳朵上（镜片在脸那一侧，被后脑挡住），手停 4 帧，
    //   然后往右下垂出画框（不再横穿后脑、不再在画里留一团"鬼手"）
    const GH = glassHand; GH.group.visible = f < 68;
    const tipG = A12.index_tip;
    // 第 3 轮（v2-01）：松手以后沿弧线往左下退到后脑和肩后面（被头肩卡挡住），从画框左缘出去；一直在虚焦里（离镜头近，材质内模糊 12K）
    const P0 = [1755, 1158, .32, .85], P1 = [1374, 327, .11, 2.4], P2 = [352, 322, .26, .62], P3 = [-560, 600, .26, .62];
    const u1 = ss(seg(f, 36, 45)), u2 = ss(seg(f, 45, 54)), u3 = ss(seg(f, 58, 67));
    const lg = (a, b, k) => Math.exp(lerp(Math.log(a), Math.log(b), k));
    const pp = [0, 1, 2].map(i => lerp(lerp(lerp(P0[i], P1[i], u1), P2[i], u2), P3[i], u3));
    pp[1] -= 70 * Math.sin(Math.PI * u3);   // 弧线：先略往上、再往左下沉到肩后
    const psc = lg(lg(P0[3], P1[3], u1), P2[3], u2);
    const rel = f >= 56;   // 第 3 轮（v2-01）：f54 镜腿挂上耳朵、手停 2 帧，f56 松手（空手），f58 起往左下退到头肩后面
    GH.group.visible = f < 56; glassHand2.group.visible = rel && f < 68;
    const GHx = rel ? glassHand2 : GH;
    // 第 4 轮（v3-01）：到耳侧时手再顺时针多转 7°（8° → 15°），袖口和袖管往左下压进肩背剪影后面，袖口和身体之间不再露出桌面
    const ang = -12 + 27 * u2 - 25 * u3;
    placeOnCam(GHx, cam, tipG[0] - (rel ? 700 : 0), tipG[1], pp[0], pp[1], psc, pp[2], ang);
    if (rel) { const g2 = glassHand2.u, g1 = GH.u; g2.uLight.value.set(1, .93, .82); g2.uRimC.value.copy(lin3('#F3B136')); g2.uRimAmt.value = .45; g2.uRimDir.value.set(1, -.4).normalize(); g2.uRimW.value = texPx(glassHand2, 6); g2.uDesat.value = 0; g2.uAlpha.value = 1; g2.uBlur.value = texPx(glassHand2, 5 + 7 * ss(seg(f, 56, 61))); }
    const gu = GH.u; gu.uLight.value.set(1, .93, .82); gu.uRimC.value.copy(lin3('#F3B136')); gu.uRimAmt.value = .45; gu.uRimDir.value.set(1, -.4).normalize(); gu.uRimW.value = texPx(GH, 6); gu.uDesat.value = 0;
    gu.uAlpha.value = 1;
    gu.uBlur.value = texPx(GH, 14 * (1 - Math.abs(u1 - u2)) * (u1 > 0 ? 1 : 0) + 5);
    // 袖管：和当前那只手同一个锚点、位置、大小、角度、深度；虚焦量取那只手的材质内模糊（都是 A12 贴图像素）
    sleeve.group.visible = f < 68;
    placeOnCam(sleeve, cam, tipG[0] - SLV.x0, tipG[1] - SLV.y0, pp[0], pp[1], psc, pp[2], ang);
    sleeveU.uBlur.value = (rel ? glassHand2.u.uBlur.value : gu.uBlur.value); sleeveU.uLight.value.set(1, .93, .82);
    // 纸面反射光点：f44 → f62 从 (0.10, 0.05) 滑到上六爻
    const sp = eo(seg(f, 44, 62)), br = f > 62 ? 1 + .08 * Math.sin((t - 62 / 24) * Math.PI) : 1;
    pages[0].u.uSpot.value.set(lerp(.10, -.075, sp), lerp(.05, barZ(6), sp), .011, f >= 44 ? lerp(.35, .55, sp) * br : 0);
    pages[1].u.uSpot.value.set(lerp(.10, -.075, sp), lerp(.05, barZ(6), sp), .011, f >= 44 ? lerp(.35, .55, sp) * br : 0);
    // 景深：先对耳朵（0.21 m），f54–f62 转到纸面（0.55 m）
    const zf = lerp(.21, .55, ss(seg(f, 54, 62)));
    return { scene, camera: cam, dof: { zf, cocScale: 8, cocMax: 34, rfg: 30 }, star: f >= 44 && f < 52 ? (f < 46 ? 1.7 : 1.7 * (1 - eo((f - 46) / 6))) : 0, templeLine: f >= 54 };
  };
  // T1 卦门（房间部分 f60–f104）：主观镜头垂直俯看左页
  function d1(f) { return f < 84 ? .32 * (1 - .01 * (f - 60) / 24) : .3168 - .2868 * eio((f - 84) / 20); }
  function camT1(f) { const d = d1(f); setFov(22.07); const c = V3(HEX_C[0], pageY(HEX_C[0]) + d, HEX_C[1]); aim(c, c.clone().add(V3(0, -1, 0)), V3(0, 0, -1)); return cam; }
  shots.T1 = (f, t) => {
    const tc = tcOf(f);
    resetT1(); pages[1].u.uNSa.value = 0; setPool(.10, -.04, .32, .25);
    camT1(f);
    hideAll(); common(t);
    pages[0].u.uSpot.value.set(-.075, barZ(6), .011, .5 * (1 - ss(seg(f, 72, 80))));
    // 爻条（返修 story-06：S1 拉长后压到 f72–f80）：自下而上第 k 条从 f72 + 1.6(k−1) 起浮起，每条 6 帧
    let lowLift = 0, upLift = 0;
    for (const b of bars) {
      b.hinge.visible = true;
      const start = 72 + 1.6 * (b.k - 1);
      const x = clamp((tc * 24 - start) / 6);
      const lift = .010 * eo(x) * (1 + .10 * Math.sin(Math.PI * x));
      b.hinge.position.y = pageY(b.hinge.position.x) + lift;
      // 墨变朱：自下而上，第 k 爻从 f76 + .8(k − 1) 起，4 帧
      b.mat.uniforms.uMix.value = ss((f - (76 + .8 * (b.k - 1))) / 4);
      b.mat.uniforms.uFlash.value = f >= 82 ? .6 * Math.max(0, 1 - (f - 82) / 3) : 0;
      // 开门：绕外端铰链向页内转 100°
      const th = 100 * DEG * eio((f - 86) / 14);
      b.hinge.rotation.set(0, 0, b.side < 0 ? -th * -1 * -1 : th);
      if (b.side < 0) b.hinge.rotation.z = -th; else b.hinge.rotation.z = th;
      if (b.k <= 3) lowLift = Math.max(lowLift, x); else upLift = Math.max(upLift, x);
      if (b.side < 0) pages[0].u.uBarLift.value[b.k - 1].set(lift, th, 0, 0);
    }
    pages[0].u.uShadow.value.set(1, 0, 0, 0);
    setPrinted(lowLift, upLift, 1);
    // 中缝光、爻缝光、光池
    const flash = f >= 82 ? Math.max(0, 1 - (f - 82) / 3) : 0;
    seamU.uA.value = f >= 82 ? (.8 + .6 * flash) * (1 - ss(seg(f, 86, 90))) : 0;   // 返修 story-07：门开以后不再有竖线
    seam.scale.set((3 + 5 * ss(seg(f, 82, 86))) / 8334 * 3, .06, 1);
    poolU.uA.value = f >= 82 ? .30 * (1 - ss(seg(f, 96, 104))) : 0;
    // 门洞
    const w = .62 * eio((f - 86) / 12);
    SHARED.uDoor.value.set(w, f < 96 ? .279 : lerp(.279, -.05, ss((f - 96) / 4)), f < 96 ? .531 : lerp(.531, 1.05, ss((f - 96) / 4)), f >= 86 ? 1 : 0);
    doorBg.visible = f >= 86;
    const defocus = 9 * (1 - ss(seg(f, 72, 80)));
    // 返修 tech-01：门洞衬板不写深度，景深会把门内世界整段虚掉；门打开时景深退掉
    return { scene, camera: cam, dof: { zf: d1(f), cocScale: 2, cocMax: 8 * (1 - ss(seg(f, 84, 92))), defocus }, bloomPulse: .35 * flash, world: f >= 86 };
  };
  // 第 k 爻在 f92 的屏幕 y（给门内脊线对位）
  function barScreenY(f = 92) {
    camT1(f);
    return [1, 2, 3, 4, 5, 6].map(k => { const p = V3(HEX_C[0], pageY(HEX_C[0]), barZ(k)).project(cam); return (.5 - p.y * .5) * 1040; });
  }

  // S6 回现实（f642–f720）：房间相机从他右眼的位置拉轨到右后上方
  shots.S6 = (f, t) => {
    resetT1(); setPool(.12, -.02, .36, .38); wallU.uTint.value.set(.74, .68, .61);
    const tc = tcOf(f);
    const s = s6Ease(f);
    setFov(22.07);
    // 终态：相机在他右后方、略高于桌面，看向书的左边——书在画右中、后墙在上、左边是暗墙
    const C1 = V3(.0, .42, 1.15), dir1 = V3(-.164, -.271, -.949);
    aim(V3(.05, .40, .36).lerp(C1, s), V3(.07, 0, -.02).lerp(C1.clone().add(dir1), s));
    SHARED.uDoor.value.set(0, 0, 1, 0); doorBg.visible = false;
    resetBars(); setPrinted(0, 0, 1); hideAll(); common(t, .38, 3);
    pages[0].u.uSpot.value.set(0, 0, .011, 0); pages[1].u.uSpot.value.set(0, 0, .011, 0);
    // 书里的木刻豹长出文采：f660–f684 按 18 个固定位置淡入
    const poly = M('A22')['锚点']['木刻豹身体多边形_px'];
    const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const head = M('A22')['锚点']['木刻豹头椭圆'];
    const ns = [];
    for (let j = 0; j < 18; j++) {
      const onHead = j >= 13;
      const x = onHead ? head.cx - head.rx * .7 + head.rx * .9 * hashi(j * 3) : bx0 + 12 + (bx1 - bx0 - 24) * hashi(j * 3 + 300);
      const y = onHead ? head.cy - head.ry * .6 + head.ry * .5 * hashi(j * 5) : by0 + 10 + (by1 - by0 - 20) * hashi(j * 5 + 300);
      ns.push([x, y, onHead ? 7 : 9 + 4 * hashi(j * 7), 300 + j]);
    }
    const pu = pages[1].u; pu.uNS.value = 18;
    ns.forEach(([x, y, r, seed], j) => { const ph = motifPh(seed); pu.uNSp.value[j].set(x, y, r, motifK(seed)); pu.uNSph.value[j].set(...ph); });
    pu.uNSa.value = ss(seg(f, 660, 684));
    const zf = f < 646 ? .30 : lerp(.30, 1.0, s);
    return { scene, camera: cam, dof: { zf, cocScale: 17.7, cocMax: 12 }, s };
  };

  return { scene, cam, shots, barScreenY, doorU, pages, sprites };
}
