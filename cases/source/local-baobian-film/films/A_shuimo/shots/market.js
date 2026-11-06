// 《豹变》A 水墨 · 面具集市：S3a 全景、S3b 递面具、S3c 手抬又放、S3d 眼孔推进（全片唯一的快切与手持）
//   3D：金面具与 24 张灰面具（圆柱面的一段 + SDF：先画墨骨笔线，泥金当淡彩铺在里面，两档加水渍边）
//   2D：人群底板 A08（压低一档对比、柔化；近景用预先模糊好的底板）、卖家大袖 A06-6、陆蔚右手 A06-S1c、陆蔚背影 A05（三张原画）；
//       灯笼（淡墨洗染、边深心浅）、竿、挂绳、前景人影（交叠的墨团）都用代码画
import * as THREE from 'three';
import { U, K, DW, DH, DEG, clamp, lerp, seg, ss, ss5, eo, ei, hashi, hash2, mulberry, PAL, COL, placeOnScreen, screenToWorld, project, aim, fpx, css, mix3, vnoise1 } from '../lib/core.js';
import { NOISE, PALETTE, ROSETTE } from '../lib/glsl.js';
import { canvasPlane, fogPlane } from '../lib/inkwash.js';
import { sprite, setHandle, clearHandles, setBreath, setSpots } from '../lib/sprite.js';
import { stroke, freshClear, wetBlob, blobPath } from '../lib/draw2d.js';
import { placeImg } from './cliff.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const FOV = 30, FP = fpx(FOV);
// 返修第 2 轮（style-07 / story-11 / self-01）：面具改成 Magpie 画的水墨淡彩原画（墨骨笔线 + 泥金平涂 + 朱砂假豹纹，刻意对称等距），
//   贴在圆柱面的一段上；轮廓与眼孔的透空用原画算出来的有符号距离场（推到任意倍数边都干净），眼孔里照旧是门户
// 返修第 3 轮（style-07 换思路 / v2-01）：面具原画重出成没骨水墨淡彩（泥金水色往外洇成墨、外缘破笔不闭合、假豹纹是湿墨点刻意对称）；
//   外轮廓直接用原画自己的 alpha（洇开的软边）；两只眼孔改成解析折线距离场（从原画眼孔边按亚像素描出 96 点、圆周平滑），
//   推到满屏也没有阶梯；门户遮罩输出 r = 眼孔、g = 离眼孔边的屏幕距离、b = 面具上有墨的地方（金化成墨交给合成里的 T1 墨晕着色器）
const MASK = { R: 0.9, H: 0.34, ang: 1.1991 * 0.34 / 0.9 };
export const EYE = { u: 0.3553, v: -0.016, a: 0.225, b: 0.161 };   // 画面右侧那只眼孔（面具 UV，[-1,1]）
const NE = 256;                                // 返修 w3（v3-09）：原画描出的 96 点闭合折线按向心 Catmull-Rom 加密到 256 点（推到 10 倍也读不出直段和尖角）

const MASK_VS = /* glsl */`varying vec2 vUv; varying vec3 vW; varying vec3 vN;
void main(){ vUv = vec2(uv.x * 2. - 1., uv.y * 2. - 1.); vec4 wp = modelMatrix * vec4(position, 1.); vW = wp.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * wp; }`;
const MASK_FS = /* glsl */`
${NOISE}
${PALETTE}
#define NE ${NE}
uniform sampler2D uMap;
uniform vec2 uEyeL[NE], uEyeR[NE];
uniform vec3 uLeaf, uLight;
uniform float uPortal, uF, uOp, uAspect, uLeafOn, uSoft, uSweep, uFadeP, uDesat, uSeed, uGold, uLp, uLi, uSatK, uRowLod, uFillHole, uHoleSoft, uRimK;
varying vec2 vUv; varying vec3 vW; varying vec3 vN;
// 闭合折线的有符号距离（里负外正；q 空间 = 以面具半高为单位、y 向上）
float sdEyeL(vec2 p){ float d = 1e9, s = 1.; vec2 vj = uEyeL[NE - 1];
  for (int i = 0; i < NE; i++) { vec2 vi = uEyeL[i]; vec2 e = vj - vi, w = p - vi; vec2 b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-12), 0., 1.); d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= vi.y, p.y < vj.y, e.x * w.y > e.y * w.x); if (all(c) || all(not(c))) s = -s; vj = vi; }
  return s * sqrt(d); }
float sdEyeR(vec2 p){ float d = 1e9, s = 1.; vec2 vj = uEyeR[NE - 1];
  for (int i = 0; i < NE; i++) { vec2 vi = uEyeR[i]; vec2 e = vj - vi, w = p - vi; vec2 b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-12), 0., 1.); d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= vi.y, p.y < vj.y, e.x * w.y > e.y * w.x); if (all(c) || all(not(c))) s = -s; vj = vi; }
  return s * sqrt(d); }
void main(){
  vec2 p = vUv;
  vec2 tuv = p * .5 + .5;
  vec2 q = vec2(p.x * uAspect, p.y);
  float se = min(sdEyeL(q), sdEyeR(q));
  float gq = max(length(vec2(dFdx(se), dFdy(se))), 1e-7);                        // 每个屏幕像素对应多少 q
  float hs = uHoleSoft * uK * gq;                                                 // 返修 w3（v3-09）：孔边 1–2K 的洗染过渡（不是一刀切的矢量边）
  float hole = 1. - smoothstep(-.9 * gq - uSoft * .02 - hs, .9 * gq + uSoft * .02 + hs, se);
  vec4 tx = texture(uMap, tuv, uSoft > 0. ? 2.0 : uRowLod);
  // 原画眼孔比折线大出来的那一点细缝：补成眼眶的浓墨（不露底）
  float rim = (1. - smoothstep(.35, .6, tx.a)) * (1. - smoothstep(.022, .042, se)) * step(0., se);
  float inMask = max(tx.a, rim);
  if (uFillHole > .5) inMask = max(inMask, 1. - smoothstep(.022, .042, se));
  if (uPortal > .5) {                                                             // 门户遮罩：r = 眼孔；g = 离眼孔边的屏幕距离（1 − 设计像素/400）；b = 面具上有墨
    float pxd = max(se, 0.) / gq / uK;
    float onM = max(inMask, 1. - smoothstep(.022, .042, se));                    // 孔沿那一窄条也算面具（墨晕从孔沿起，不留一线浅色）
    gl_FragColor = vec4(hole, 1. - clamp(pxd / 400., 0., 1.), onM * (1. - hole), 1.);
    return;
  }
  // 门户开着时（S3d）眼孔里也照样画面具（反正合成时按门户遮罩换成雾崖）：孔沿那一圈半透明像素里不会漏出面具背后的浅色背景（不出亮线）
  float holeW = uGold > .5 ? 0. : .42;                                            // 灰面具：眼孔里一层淡墨（不是两个白洞）
  float alpha = max(inMask * (1. - hole * (1. - uFillHole)), hole * holeW * step(uPortal, .5));
  if (alpha < .002) discard;
  vec3 paper = uPal[0];
  float D = clamp((uLp - lum(tx.rgb)) / max(uLp - uLi, .02), 0., 1.);
  float sat = max(tx.r, max(tx.g, tx.b)) - min(tx.r, min(tx.g, tx.b));
  float satM = smoothstep(.08, .22, sat);
  vec3 col;
  if (uGold > .5) {                                                               // 金面具：墨骨归到集市墨阶，泥金与朱砂留原画的色相
    vec3 hueC = tx.rgb * paper / max(uLp, .3);
    hueC = mix(vec3(lum(hueC)), hueC, uSatK);
    col = mix(rampS(D), hueC, satM);
  } else col = rampS(.22 + D * .56);                                              // 灰面具：同一张画，按墨阶上灰（底子是清墨灰，不是白脸）
  col *= 1. + .05 * (vn2(p * 30., 201u) - .5);
  // 金箔点每 2 帧有两三个闪成四芒小星；f292 一道留白斜光扫过金面
  if (uLeafOn > .5) {
    for (int i = 0; i < 18; i++) {
      float fi = float(i);
      vec2 lp = vec2(hS(fi, 301.) * 1.4 - .7, hS(fi, 302.) * 1.2 - .5);
      vec2 dq = (p - lp) * vec2(uAspect, 1.);
      float d = length(dq);
      float on = step(hS(floor(uF / 2.) * 61. + fi, 303.), .14);
      float st = exp(-pow(d / .012, 2.)) + .8 * exp(-pow(dq.x / .003, 2.)) * exp(-pow(dq.y / .045, 2.)) + .8 * exp(-pow(dq.y / .003, 2.)) * exp(-pow(dq.x / .045, 2.));
      col = mix(col, vec3(1., .97, .86), clamp(st * on, 0., 1.) * .9 * satM);
    }
    float sw = dot(p, normalize(vec2(1., -.8))) - uSweep;
    col = mix(col, mix(uLight, paper, .5) * 1.04, exp(-pow(sw / .07, 2.)) * step(-2., uSweep) * satM * .75);
  }
  if (uDesat > 0.) col = mix(col, vec3(lum(col)) * vec3(1.02, 1., .97), uDesat);
  col = mix(col, rampS(.82 + .06 * vn2(p * 40., 209u)), rim * (1. - smoothstep(.35, .6, tx.a)) * uRimK);
  float hpx = max(se, 0.) / gq / uK;                                              // 孔沿外侧 2K 内一层淡一档的洗染（孔边是画出来的湿边）
  col = mix(col, col * .82, (1. - smoothstep(0., 2.2, hpx)) * step(0., se) * .55);
  if (uGold < .5) col = mix(col, rampS(.42 + .08 * vn2(p * 9., 211u)), hole * (1. - inMask * (1. - hole)));
  col = mix(col, paper, uFadeP);
  gl_FragColor = vec4(col, alpha * uOp);
}`;
let MTEX = null;
function maskMat(gold, rowK = 1) {
  const u = {
    uPal: U.uPal, uK: U.uK, uT: U.uT,
    uMap: { value: MTEX.map },
    uEyeL: { value: MTEX.eyeL }, uEyeR: { value: MTEX.eyeR },
    uLeaf: { value: new THREE.Vector3(...COL.goldLeaf) }, uLight: { value: new THREE.Vector3(...COL.goldL) },
    uPortal: { value: 0 }, uF: { value: 0 }, uOp: { value: 1 }, uAspect: { value: (MASK.R * MASK.ang) / MASK.H }, uLeafOn: { value: gold ? 1 : 0 }, uSoft: { value: 0 },
    uSweep: { value: -9 }, uFadeP: { value: gold ? 0 : 1 - rowK }, uDesat: { value: 0 }, uSeed: { value: 0 }, uGold: { value: gold ? 1 : 0 },
    uLp: { value: MTEX.Lp }, uLi: { value: MTEX.Li }, uSatK: { value: 0.62 }, uRowLod: { value: 0 }, uFillHole: { value: 0 }, uHoleSoft: { value: 1.5 }, uRimK: { value: 1 },
  };
  return new THREE.ShaderMaterial({ uniforms: u, vertexShader: MASK_VS, fragmentShader: MASK_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    extensions: { derivatives: true } });
}
function maskGeo() {
  const g = new THREE.CylinderGeometry(MASK.R, MASK.R, MASK.H, 64, 24, true, Math.PI - MASK.ang / 2, MASK.ang);
  g.translate(0, 0, MASK.R); g.rotateY(Math.PI); g.translate(0, 0, 0);
  const p = g.attributes.position; let zmax = -1e9; for (let i = 0; i < p.count; i++) zmax = Math.max(zmax, p.getZ(i));
  g.translate(0, 0, -zmax);
  return g;
}

export function buildMarket(ctx) {
  const { tex, man } = ctx;
  const mM = man['R3-MASK'], ep = mM['锚点'].eye_poly_q;
  // 闭合折线 → 向心 Catmull-Rom 样条，按弧长等距重采样 NE 点
  const toV2 = arr => {
    const n = arr.length, P = i => arr[((i % n) + n) % n];
    const dense = [];
    for (let i = 0; i < n; i++) {
      const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      const tj = (ti, a, b) => ti + Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9, 0.5);
      const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
      for (let k = 0; k < 16; k++) {
        const t = t1 + (t2 - t1) * k / 16;
        const L = (a, b, ta, tb) => [((tb - t) * a[0] + (t - ta) * b[0]) / (tb - ta), ((tb - t) * a[1] + (t - ta) * b[1]) / (tb - ta)];
        const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
        const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
        dense.push(L(B1, B2, t1, t2));
      }
    }
    const cum = [0]; for (let i = 1; i <= dense.length; i++) { const a = dense[i - 1], b = dense[i % dense.length]; cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
    const tot = cum[cum.length - 1], out = [];
    for (let k = 0, j = 0; k < NE; k++) {
      const d = tot * k / NE; while (j < dense.length - 1 && cum[j + 1] < d) j++;
      const a = dense[j], b = dense[(j + 1) % dense.length], u = (d - cum[j]) / Math.max(cum[j + 1] - cum[j], 1e-12);
      out.push(new THREE.Vector2(lerp(a[0], b[0], u), lerp(a[1], b[1], u)));
    }
    return out;
  };
  MTEX = { map: tex.maskGold, Lp: mM.Lp, Li: mM.Li, eyeL: toV2(ep.left), eyeR: toV2(ep.right) };
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.004, 400);
  const M = PAL.market;
  const REF = new THREE.PerspectiveCamera(FOV, innerWidth / innerHeight, 0.01, 400);
  aim(REF, V3(0, 1.6, 0), 0, -6 * DEG);
  const MG = maskGeo();

  // ───────── 人群底板 A08：压低一档对比、σ 1.5K 柔化；近景另备一张预先模糊好的（σ≈10K，不用 mip 偏移，不出马赛克） ─────────
  const blurCopy = (img, px) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.filter = `blur(${px}px)`; g.drawImage(img, 0, 0); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 8; return t; };
  const crowdSoft = blurCopy(tex.crowd.image, 1.5), crowdBlur = blurCopy(tex.crowd.image, 7);
  const crowd = sprite(crowdSoft, man.A08, { order: 1, mode: 'A', deform: false, a0: -1, a1: 0.0001, dmax: 0.58 });   // 返修 w3（qa2-13）：墨浓上限 0.66 → 0.58（压中间调对比）
  crowd.material.uniforms.uLp.value = 0.97; crowd.material.uniforms.uLi.value = 0.24;
  // 返修第 3 轮（style-07 ⑥）：人群底板再"笔块化"一档——细线并成一团团湿墨块，插画的细线密度降下来（线没有了，人形还在）
  crowd.material.uniforms.uBlock.value.set(0.82, 2.6, 0.97, 0.05);   // 返修 w3（qa2-13）：笔块化再加一档（0.62 → 0.82、平滑尺度 2.2 → 2.6）：人物的体积明暗并成一团团湿墨，不再像柔化过的旧照片
  scene.add(crowd);
  const topFog = fogPlane({ w: 1, h: 1, a0: 0.85, drift: 0.02, seed: 31, lo: 0.25, hi: 0.62, sc: [5, 1.2], edge: 0.45, order: 2 });
  scene.add(topFog);
  const fogWall = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(...M[0]), transparent: true, opacity: 0, depthWrite: false }));
  fogWall.renderOrder = 3; scene.add(fogWall);

  // ───────── 灯笼 9 盏：淡墨洗染的椭圆，边深心浅，不画闭合描边；盖是一笔焦墨横点 ─────────
  const LAN = Array.from({ length: 9 }, (_, i) => ({ x: 120 + i * 230 + (hash2(i, 41) - 0.5) * 90, y: 130 + hash2(i, 42) * 120, h: 70 + hash2(i, 43) * 26, ph: hash2(i, 44) * 6.28 }));
  const lan = canvasPlane(2600, 700, { order: 4, fogMul: 0 });
  scene.add(lan.mesh);
  function drawLanterns(t2, op = 1, blur = 0) {
    const g = lan.ctx; freshClear(g, 2600, 700); g.setTransform(1, 0, 0, 1, 0, 0);
    g.filter = blur > 0 ? `blur(${blur}px)` : 'none';
    LAN.forEach((L, i) => {
      const sw = 4 * Math.sin(2 * Math.PI * 0.6 * t2 + L.ph) * DEG;
      g.save(); g.translate(L.x + 300, L.y - 60); g.rotate(sw);
      const hh = L.h * 1.3, ww = hh * 0.78, bb = blur > 0 ? blur : 0;
      // 返修第 3 轮（style-07 ④）：挂绳是一笔淡墨细线（起收笔、不是等宽线）
      g.save(); g.filter = `blur(${(0.6 + bb * 0.5).toFixed(1)}px)`;
      stroke(g, [[0.5, -120, 0.25], [0.8, -70, 0.8], [0, -4, 0.55]], 1.8, css(M[3], 0.62 * op), { t0: 26, t1: 8 }); g.restore();
      // 灯身：两层错开的淡墨洗染湿块（轮廓不规则、各自一道边深心浅），不画闭合描边；心里留纸，透一点藤黄
      g.save(); g.filter = `blur(${(1.8 + bb).toFixed(1)}px)`; blobPath(g, 0, hh / 2, ww / 2, hh / 2, 0.04, 300 + i, 0.11); g.fillStyle = css(M[1], 0.40 * op); g.fill(); g.restore();
      g.save(); g.filter = `blur(${(2.6 + bb).toFixed(1)}px)`; blobPath(g, ww * 0.05, hh / 2 + 2, ww / 2 * 0.90, hh / 2 * 0.94, -0.05, 320 + i, 0.14); g.fillStyle = css(M[1], 0.24 * op); g.fill(); g.restore();
      g.save(); g.filter = `blur(${(10 + bb).toFixed(1)}px)`; blobPath(g, ww * 0.03, hh * 0.52, ww / 2 * 0.48, hh / 2 * 0.56, 0, 340 + i, 0.14); g.fillStyle = css(mix3(M[0], COL.gambogeLight, 0.30), 0.60 * op); g.fill(); g.restore();
      // 水渍边：只在两侧各积一段（干时颜料往边上走），上下断开
      for (const [a0, a1, sd] of [[0.62, 1.40, 1], [-0.42, 0.36, 2]]) {
        const pts = [];
        for (let k = 0; k <= 14; k++) { const a = Math.PI * (a0 + (a1 - a0) * k / 14), rr = 0.93 + 0.05 * Math.sin(k * 1.7 + i + sd); pts.push([Math.cos(a) * ww / 2 * rr, hh / 2 + Math.sin(a) * hh / 2 * rr, 0.35 + 0.65 * Math.sin(Math.PI * k / 14)]); }
        g.save(); g.filter = `blur(${(1.6 + bb).toFixed(1)}px)`; stroke(g, pts, 5.5, css(M[2], 0.36 * op), { t0: 14, t1: 14, thinning: 0.6 }); g.restore();
      }
      for (const k of [-0.40, 0.38]) { g.save(); g.filter = `blur(${(1 + bb).toFixed(1)}px)`; stroke(g, [[ww / 2 * k, 12, 0.3], [ww / 2 * k * 1.12, hh / 2, 0.6], [ww / 2 * k, hh - 12, 0.25]], 1.3, css(M[2], 0.16 * op), { t0: 14, t1: 14 }); g.restore(); }
      // 盖：一笔焦墨横点（起笔重、收笔出锋），下面一笔短的
      g.save(); g.filter = `blur(${(0.7 + bb * 0.6).toFixed(1)}px)`;
      stroke(g, [[-ww * 0.21, 3, 0.9], [-ww * 0.05, -1, 1], [ww * 0.18, 2, 0.30]], 8, css(M[5], 0.84 * op), { t0: 3, t1: 12, thinning: 0.6 });
      stroke(g, [[-ww * 0.13, hh - 1, 0.85], [ww * 0.12, hh + 1, 0.30]], 6, css(M[5], 0.74 * op), { t0: 3, t1: 9, thinning: 0.6 });
      stroke(g, [[0, hh + 5, 0.7], [sw * 15, hh + 26, 0.5], [sw * 30, hh + 46, 0.15]], 2.2, css(M[4], 0.7 * op), { t0: 3, t1: 14 });
      g.restore();
      g.restore();
    });
    g.filter = 'none';
    lan.tex.needsUpdate = true;
  }

  // ───────── 灰面具架 3 排（D 4 / 6 / 8）：近浓远淡，远排化进雾；每张倾角、高低略有不同 ─────────
  // 返修 w3（v3-08）：三排拉开间距（原来每排 8 张挤成一串、互相压着），每排张数减到 6 / 6 / 7、排宽放到整幅，高低错落更大；
  //   外缘按排加 mip 虚（用原画自己洇开的 alpha），远两排眼孔边不再描一圈锐利的浓墨线、孔边也更软；灰面具的眼孔里一层淡墨（面具背后的暗，不是两个白洞）
  const ROWS = [
    { D: 4.0, x0: 20, x1: 900, y: 150, n: 5, h: 118, k: 1.0, lod: 0.8, rimK: 0.45, hs: 1.8 },
    { D: 6.0, x0: 980, x1: 1900, y: 196, n: 6, h: 92, k: 0.74, lod: 1.1, rimK: 0.15, hs: 2.5 },
    { D: 8.0, x0: 180, x1: 1760, y: 258, n: 7, h: 72, k: 0.46, lod: 1.4, rimK: 0, hs: 3.5 },
  ];
  const greyMasks = [], racks = [];
  ROWS.forEach((r, ri) => {
    const gmat = maskMat(false, r.k); gmat.uniforms.uSeed.value = ri * 1.7; gmat.uniforms.uRowLod.value = r.lod; gmat.uniforms.uRimK.value = r.rimK; gmat.uniforms.uHoleSoft.value = r.hs;
    const rk = canvasPlane(1200, 300, { order: 5 + ri * 0.1, fogMul: 0 });
    const g = rk.ctx; g.clearRect(0, 0, 1200, 300);
    const sc = 1200 / (r.x1 - r.x0 + 120);
    stroke(g, [[10, 40, 0.8], [600, 44, 1], [1190, 42, 0.6]], 6, css(M[4], 0.85 * r.k + 0.1), { t0: 10, t1: 30 });
    for (let i = 0; i < r.n; i++) {
      const x = (60 + (r.x1 - r.x0) * (i + 0.5) / r.n) * sc;
      g.strokeStyle = css(M[3], 0.7 * r.k); g.lineWidth = 1.6; g.beginPath(); g.moveTo(x, 42); g.lineTo(x - 6, 42 + 40 * sc); g.moveTo(x, 42); g.lineTo(x + 6, 42 + 40 * sc); g.stroke();
    }
    rk.tex.needsUpdate = true; scene.add(rk.mesh);
    racks.push({ r, rk, sc });
    for (let i = 0; i < r.n; i++) {
      const m = new THREE.Mesh(MG, gmat);
      m.renderOrder = 6 - ri * 0.1 + i * 0.001; m.userData = { r, i, ri, dy: (hash2(i, 71 + ri) - 0.5) * 0.42 * r.h, roll: (hash2(i, 81 + ri) - 0.5) * 16 };
      scene.add(m); greyMasks.push(m);
    }
  });

  // ───────── 金面具 ─────────
  const gold = new THREE.Mesh(MG, maskMat(true)); gold.renderOrder = 8; scene.add(gold);
  const goldP = new THREE.Mesh(MG, gold.material.clone()); goldP.material.uniforms.uPortal.value = 1; goldP.material.transparent = false;
  goldP.material.uniforms.uLeafOn.value = 0;
  const portalScene = new THREE.Scene(); portalScene.add(goldP);
  const pole = canvasPlane(64, 1024, { order: 7.9, fogMul: 0 }); scene.add(pole.mesh);
  { const g = pole.ctx; g.clearRect(0, 0, 64, 1024); stroke(g, [[32, 0, 0.8], [33, 500, 1], [31, 1024, 0.9]], 9, css(M[4], 0.95), { t0: 2, t1: 2 }); pole.tex.needsUpdate = true; }

  // ───────── 前景人影（D 3）：返修第 2 轮（style-07 ⑤ / story-11 ③）换成 Magpie 画的四个人的头肩背影（斗笠、发髻、包头、短发），湿墨团、边洇开，预先虚 3 px ─────────
  // 返修 w3（v3-08）：前景人头放在 D 3 的近景，原来是 mip 偏移 3 档 + 窄的 alpha 门槛（边缘锐利、带细锯齿的剪纸墨团）：
  //   改成预先做一张 σ≈8 px 的真模糊（贴图与屏幕约 1:1，即 8K），alpha 门槛放宽成软边，边缘再按噪声洇开
  const fgBlur = blurCopy(tex.marketFg.image, 8);
  const fg = { mesh: sprite(fgBlur, man['R2-FGCROWD'] || { Lp: 0.85, Li: 0.114 }, { order: 12, deform: false, a0: 0.06, a1: 0.80, fogMul: 0, fur: 1.9, furF: 9, lod: 0 }) };
  // 返修第 3 轮（style-07 ⑤）：前景人影压成三四团交叠的浓墨团——墨浓只留在"重—浓"之间（没有头发、帽檐的照片式明暗），大尺度平滑当虚焦，边缘按噪声洇开
  fg.mesh.material.uniforms.uDmin.value = 0.58; fg.mesh.material.uniforms.uDmax.value = 0.86;
  fg.mesh.userData.aspect = 2172 / 724;
  scene.add(fg.mesh);
  // ───────── 手：卖家大袖 A06-6；陆蔚右手 A06-S1c；陆蔚背影 A05 ─────────
  const seller = sprite(tex.hSeller, man.A06, { order: 14, depthTest: false, a0: 0.32, a1: 0.82, erode: 2.5, rimInk: [2.6, 4.2] });
  seller.material.uniforms.uLi.value = 0.40; seller.material.uniforms.uLp.value = 0.93; seller.material.uniforms.uLine.value.set(1, 1.6, 4, 0.82); scene.add(seller);
  const aS1c = man['A06-S1c']['锚点'];
  const hand = sprite(tex.hReach, man['A06-S1c'], { order: 15, depthTest: false, a0: 0.32, a1: 0.82, erode: 3, rimInk: [2.6, 4.2] });
  hand.material.uniforms.uLi.value = 0.46; hand.material.uniforms.uLine.value.set(1, 1.7, 4.2, 0.80); scene.add(hand);
  const walks = ['walk1', 'walk2', 'walk3'].map((k, i) => { const m = sprite(tex[k], man.A05, { order: 9, a0: 0.30, a1: 0.80, erode: 2, rimInk: [3.0, 4.6] }); m.material.uniforms.uLi.value = 0.22; m.visible = false; scene.add(m); return m; });
  const WALK = man.A05['锚点'], WZ = man.A05['零件'];

  // ───────── 相机与手持 ─────────
  const hand6 = t => ({ dx: 3 * Math.sin(2 * Math.PI * 1.7 * t + 0.3) + 1.2 * Math.sin(2 * Math.PI * 6.3 * t + 1.1), dy: 2 * Math.sin(2 * Math.PI * 1.3 * t + 2.0) + 1 * Math.sin(2 * Math.PI * 5.1 * t + 0.7), roll: 0.3 * Math.sin(2 * Math.PI * 0.9 * t) });
  function shakeScreen(c, t, w) {
    if (w <= 0) return;
    const h = hand6(t);
    c.rotateY(-h.dx * w / FP); c.rotateX(-h.dy * w / FP); c.rotateZ(h.roll * DEG * w);
    c.updateMatrixWorld(true);
  }
  function placeMask(m, c, sx, sy, hpx, rot = 0, roll = 0) {
    const D = MASK.H / hpx * FP;
    const p = screenToWorld(c, sx, sy, D);
    m.position.copy(p); m.quaternion.copy(c.quaternion);
    m.rotateY(rot * DEG); m.rotateZ(roll * DEG);
    m.updateMatrixWorld(true);
    return D;
  }
  const goldU = gold.material.uniforms;
  function goldState(f, o = {}) { goldU.uFillHole.value = o.fill ?? 0; goldU.uF.value = f; goldU.uOp.value = o.op ?? 1; goldU.uSoft.value = o.soft ?? 0; goldU.uSweep.value = o.sweep ?? -9; goldU.uDesat.value = o.desat ?? 0; }

  function S3a(st) {
    const { f, fr, t } = st, t2 = Math.floor(f / 2) * 2 / 24;
    goldState(f);
    const u = eo(seg(fr, 266, 292));
    aim(cam, V3(1.6 * u - 0.8, 1.6, 0), 0, -6 * DEG);
    shakeScreen(cam, t, 1);
    show({ crowd: true, lan: true, masks: true, gold: true, pole: true, fg: true });
    crowd.material.uniforms.map.value = crowdSoft;
    placeOnScreen(crowd, REF, 960, 600, 2600, 14, 1300);
    crowd.material.uniforms.uLod.value = 0;
    placeOnScreen(topFog, REF, 960, 70, 3400, 13, 260);
    placeOnScreen(lan.mesh, REF, 960, 240, 2600, 9, 700); drawLanterns(t2);
    racks.forEach(({ r, rk, sc }) => placeOnScreen(rk.mesh, REF, (r.x0 + r.x1) / 2, r.y + 300 / sc / 2 - 44 / sc, 1200 / sc, r.D, 300 / sc));
    greyMasks.forEach(m => {
      const { r, i, ri, dy, roll } = m.userData;
      const sx = r.x0 + (r.x1 - r.x0) * (i + 0.5 + (hash2(i, 91 + ri) - 0.5) * 0.30) / r.n, sy = r.y + r.h * 0.62 + dy;
      const sw = 2 * Math.sin(2 * Math.PI * 0.7 * t2 + i * 1.7 + ri);
      placeMask(m, REF, sx, sy, r.h * (0.84 + 0.30 * hash2(i, 95 + ri)), (hash2(i, 9 + ri) - 0.5) * 34, sw + roll);
    });
    const sw = 3 * Math.sin(2 * Math.PI * 0.8 * t2);
    placeMask(gold, REF, 1450 + sw * 2, 300, 120, -8, sw);
    placeOnScreen(pole.mesh, REF, 1452, 300 + 60 + 300, 18, 6, 640);
    placeOnScreen(fg.mesh, REF, 1010, 1040 + 383 - 430, 2300, 3, 2300 / 3.0);
    seller.visible = false; hand.visible = false; walks.forEach(w => w.visible = false); fogWall.material.opacity = 0;
    return { cam };
  }
  function show(o) {
    crowd.visible = !!o.crowd; lan.mesh.visible = !!o.lan; greyMasks.forEach(m => m.visible = !!o.masks); racks.forEach(r => r.rk.mesh.visible = !!o.masks);
    gold.visible = !!o.gold; pole.mesh.visible = !!o.pole; fg.mesh.visible = !!o.fg; topFog.visible = o.topFog !== false;
  }
  // S3b–S3d 的背景：预先模糊好的人群底板 + 灯笼画布直接画虚（真模糊，不用 mip 偏移）
  function bgClose(c, t2, op = 0.9) {
    crowd.material.uniforms.map.value = crowdBlur;
    placeOnScreen(crowd, c, 960, 560, 2900, 14, 1450);
    crowd.material.uniforms.uLod.value = 0;
    placeOnScreen(topFog, c, 960, 80, 3400, 13, 300);
    placeOnScreen(lan.mesh, c, 960, 300, 2600 * 1.2, 9, 700 * 1.2);
    drawLanterns(t2, op, 8);
  }

  function S3b(st) {
    const { f, fr, t } = st, t2 = Math.floor(f / 2) * 2 / 24, f2 = Math.floor(f / 2) * 2;
    aim(cam, V3(0, 1.6, -0.02 * seg(fr, 292, 308)), 0, 0);
    show({ crowd: true, lan: true, gold: true });
    bgClose(cam, t2);
    const k = clamp((f2 - 292) / 4), hpx = lerp(560, 700, k), rot = lerp(-10, -2, k);
    placeMask(gold, cam, 900, 470, hpx, rot, 0);
    goldState(f, { sweep: lerp(-1.3, 1.3, seg(fr, 292, 300)) });                 // f292 重击：一道留白斜光扫过金面（8 帧）
    seller.visible = true; clearHandles(seller);
    const palm = [1240 - 928, 650 - 517];
    placeImg(seller, cam, 502, 425, palm[0], palm[1], 900 - 40, 470 + hpx * 0.43, 1.25 * hpx / 560, 0.8);
    hand.visible = false; walks.forEach(w => w.visible = false); fogWall.material.opacity = 0;
    shakeScreen(cam, t, 1);
    return { cam };
  }
  function S3c(st) {
    const { f, fr, t } = st, t2 = Math.floor(f / 2) * 2 / 24, f2 = Math.floor(f / 2) * 2;
    aim(cam, V3(0, 1.6, 0), 0, 0);
    show({ crowd: true, lan: true, gold: true });
    bgClose(cam, t2);
    placeMask(gold, cam, 350, 300, 560, -14, 0);
    goldState(f, { op: 0.9, soft: 0.05 });
    seller.visible = false;
    hand.visible = true; clearHandles(hand);
    let ax, ay, bend = 0;
    if (f2 <= 314) { const u = eo(seg(f2, 308, 314)); ax = lerp(1280, 1180, u); ay = lerp(1150, 700, u); }
    else if (f2 <= 316) { ax = 1180; ay = 700; }
    else { const u = ei(seg(f2, 316, 324)); ax = lerp(1180, 1230, u); ay = lerp(700, 1250, u); bend = 8; }
    if (bend) setHandle(hand, 0, { c: [120, 150], r0: 120, r1: 260, pivot: aS1c.points.wrist, ang: bend * DEG });
    placeImg(hand, cam, 1273, 954, aS1c.points.lead_tip[0], aS1c.points.lead_tip[1], ax, ay, 0.95, 0.5);
    setSpots(hand, [{ x: aS1c.points.lead_tip[0] + 18, y: aS1c.points.lead_tip[1] + 12, R: 15, seed: 7, mode: 0, prog: 1, op: 0.95 }]);
    hand.material.uniforms.uSpInk.value.set(...M[5]);
    walks.forEach(w => w.visible = false); fogWall.material.opacity = 0;
    shakeScreen(cam, t, 1);
    return { cam };
  }
  // S3d：眼孔推进（DESIGN 5.2）；最后几帧按"眼孔每帧放大约 1.5 倍"反推距离，f346 时孔沿已甩出画面
  let EYEW = null;
  const D0 = MASK.H / 760 * FP;
  const dPlane = fr => {                                    // 相机到面具平面的距离（米），f324 为 D0
    if (fr <= 340) return D0 * (1 - ei(seg(fr, 324, 347)));
    const d340 = D0 * (1 - ei(seg(340, 324, 347)));
    return Math.max(0.03, d340 * Math.pow(0.047 / d340, (fr - 340) / 6));
  };
  function S3d(st) {
    const { f, fr, t } = st, t2 = Math.floor(f / 2) * 2 / 24, f2 = Math.floor(f / 2) * 2;
    aim(cam, V3(0, 1.6, 0), 0, 0);
    placeMask(gold, cam, 560, 480, 760, 0, 0);
    if (!EYEW) { const ue = EYE.u * MASK.R * MASK.ang / 2, ve = EYE.v * MASK.H / 2; EYEW = new THREE.Vector3(ue, ve, 0).applyMatrix4(gold.matrixWorld).sub(cam.position); }
    show({ crowd: true, lan: true, gold: true });
    bgClose(cam, t2, 0.8);
    fogWall.material.opacity = lerp(0.3, 0.95, ss(seg(fr, 324, 346)));
    placeOnScreen(fogWall, cam, 960, 520, 4000, 10, 2400);
    seller.visible = fr < 346; clearHandles(seller);
    placeImg(seller, cam, 502, 425, 1240 - 928, 650 - 517, 470, 480 + 760 * 0.45, 1.6, 0.80);
    walks.forEach(w => w.visible = false);
    // 陆蔚：从画右下近处转身入画（前景、高约 650K），再往雾里走远（缩到约 120K）
    if (fr < 344) {
      const wi = f < 328 ? 0 : (Math.floor((f - 328) / 6) % 2 ? 2 : 1);
      const w = walks[wi]; w.visible = true;
      const part = WZ[['d1_turned', 'd2_walk_left_fwd', 'd3_walk_right_fwd'][wi]];
      const gk = ['d1_ground', 'd2_ground', 'd3_ground'][wi];
      const gp = WALK.points[gk], ox = part.offset_in_sheet[0], oy = part.offset_in_sheet[1];
      const u = ss(seg(f2, 324, 342)), D = lerp(1.25, 7.5, Math.pow(u, 0.8));
      const hpx = 650 * 1.25 / D, s = hpx / 760, bob = (f2 % 4 === 0 ? 0 : -2);
      placeImg(w, cam, part.size[0], part.size[1], gp[0] - ox, gp[1] - oy, lerp(1560, 1345, u), lerp(1170, 640 + hpx * 0.5, u) + bob, s, D);
      w.material.uniforms.uOp.value = 1 - ss(seg(fr, 334, 343)) * 0.85;
    }
    hand.visible = false;
    const xh = EYEW.x, yh = EYEW.y;
    const u = seg(fr, 324, 347), kk = Math.min(1, ss(u * 1.15));
    const z = dPlane(fr) - D0;
    aim(cam, V3(xh * kk, 1.6 + yh * kk, z), 0, 0);
    goldState(f, { desat: 0.75 * ss(seg(fr, 329, 340)), fill: fr >= 326 ? 1 : 0 });   // 返修第 2 轮（self-02）：推近占满画面时金先褪掉七成彩；返修第 3 轮：再由合成里的 T1 墨晕从眼孔边往外化成墨
    goldP.position.copy(gold.position); goldP.quaternion.copy(gold.quaternion); goldP.scale.copy(gold.scale); goldP.updateMatrixWorld(true);
    shakeScreen(cam, t, 1 - ss(seg(fr, 324, 336)));
    return { cam, portalScene, ink: seg(fr, 340.5, 346.5) };
  }
  function eyeScreen() {
    const out = [];
    for (const sgn of [-1, 1]) {
      const c = V3(sgn * EYE.u * MASK.R * MASK.ang / 2, EYE.v * MASK.H / 2, 0).applyMatrix4(gold.matrixWorld);
      const e = V3(sgn * (EYE.u + EYE.a) * MASK.R * MASK.ang / 2, EYE.v * MASK.H / 2, 0).applyMatrix4(gold.matrixWorld);
      const pc = project(cam, c), pe = project(cam, e);
      out.push({ x: pc.x, y: pc.y, r: Math.hypot(pe.x - pc.x, pe.y - pc.y), z: pc.z });
    }
    return out;
  }
  return { scene, cam, portalScene, S3a, S3b, S3c, S3d, eyeScreen, gold, clear: () => U.uPal.value[0] };
}
