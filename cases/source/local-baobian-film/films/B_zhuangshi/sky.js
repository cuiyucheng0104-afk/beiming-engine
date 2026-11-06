// sky.js — 场景 S：天空（S5a 崖顶坐定·金日徽记、S5b 卷云层层推进·破云、S5c 化开成青绿长卷、#8 全身推近）
//          + 场景 H：豹头（#9 头颈推近、T2 豹眼大特写·一闪）。
// 卷云（⑪，ref_03）：云头圆 smin 并起来、同色相三阶叠晕、下沿深带、大云头里的旋涡是亮带之间的深色缝；不描白边、不勾黑线。
import * as THREE from 'three';
import { makeToonMaterial, bindToon } from '/films/_lib/toon.js';
import {
  W, H, K, SHARED, lin, lin3, GLSL_COMMON, cardMat, card, putCard, putScreen, makeSprite, placeSprite, setRot, clearDeform,
  DEG, clamp, lerp, seg, ss, ss5, eio, eo, hashi, aimCamera, screenToWorld, project, mulberry, monotone, fseg, tcOf,
} from './lib.js';
import { SUN_FS, RIDGE_FS, MIST_FS } from './cliff.js';
import { makeLeo, setSpots, LEO_SPLIT } from './leo.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const fovOf = mm => 2 * Math.atan(9.75 / mm) / DEG;     // 36×19.5 画幅
const fpx = mm => 520 / Math.tan(fovOf(mm) / 2 * DEG);

// ───────────────────────── 着色器 ─────────────────────────
// 天：晴空 → 深靛 → 绢
const SKYS_FS = /* glsl */`
uniform vec3 uA0, uA1, uA2, uB0, uB1, uC0, uC1, uC2; uniform float uMixB, uMixC;
void main(){
  float y = gl_FragCoord.y / uRes.y;
  vec3 a = mix(uA2, uA1, smoothstep(0., .5, y)); a = mix(a, uA0, smoothstep(.5, 1., y));
  vec3 b = mix(uB1, uB0, smoothstep(.0, 1., y));
  vec3 c = mix(uC2, uC1, smoothstep(0., .55, y)); c = mix(c, uC0, smoothstep(.55, 1., y));
  vec2 p = gl_FragCoord.xy / uK;
  // 绢丝纹：经纬 0.8 px、明暗 ±6%（fix1：1:1 下看得出是绢，style-04）
  float silk = (sin(p.x * 3.9) * .5 + .5) * (sin(p.y * 4.1) * .5 + .5);
  float slub = smoothstep(.62, .80, bbVN(vec2(p.x * .9, p.y * .02)));     // 纬向的粗丝
  c *= 1. + .06 * (silk - .5) * 2. + .025 * (bbFbm(p / 180.) - .5) * 2. - .03 * slub;
  float fl = bbFbm(p / 30. + 3.1); float m = smoothstep(.745, .76, fl);
  c = mix(c, mix(c, vec3(.8069, .7230, .5647), .12), m);
  float spr = bbSpread(p, uMixC);
  float wet = 1. - abs(spr * 2. - 1.);                       // 洇边：化开的边缘深一点
  vec3 col = mix(mix(a, b, uMixB), c * (1. - .10 * wet), spr);
  col *= 1. + .015 * (bbFbm(p / 240.) - .5) * 2.;
  gl_FragColor = vec4(col, 1.);
}`;
// ⑪ 卷云卡片（fix1，style-05 / tech-09）：云头压扁成约 1.8:1 的扁椭圆；叠晕改成沿轮廓走的窄亮带
//   （外缘暗、一道亮带、中、大云头再一道亮带、核暗），大云头的旋涡是卷进去的亮带（带间暗缝）。
//   fix2（v1-01 / tech-13）：云墙不再垫矩形实底（它在半入画时成了一条笔直的横缝）；改为在排与排的交界处
//   垫一排"填缝云头"（画在两排下面，只从缝里露出来），盖满的几帧不漏底，外轮廓仍是扇贝云头
const CLOUD_FS = /* glsl */`
uniform vec4 uHd[96]; uniform float uN, uAsp, uBot, uDiss, uA, uBody, uSpr;
uniform vec3 uDk, uMd, uLt, uGap;
void main(){
  vec2 p = vec2(vUv.x * uAsp, vUv.y);
  vec3 col = vec3(0.); float cov = 0.;
  if (uBody > 0.) {
    float e = .015 * sin(p.x * 9.) + .01 * sin(p.x * 23. + 1.);
    float aa = fwidth(p.y) * 1.2;
    float c = 1. - smoothstep(uBody + e - aa, uBody + e + aa, p.y);
    if (c > 0.) {
      vec3 b = mix(uDk, uMd, smoothstep(.05, uBody, p.y) * .45);
      float g = abs(fract(p.y * 7. + .25 * sin(p.x * 2.3)) - .5) * 2.;
      b = mix(b, uGap, (1. - smoothstep(.10, .22, g)) * .45 * smoothstep(.0, .3, p.y));
      col = b; cov = c;
    }
  }
  for (int i = 0; i < 96; i++) {
    if (float(i) >= uN) break;
    vec4 h = uHd[i];
    vec2 q = (p - h.xy) * vec2(.55, 1.);
    if (abs(q.x) > h.z * 1.2 || abs(q.y) > h.z * 1.2) continue;
    float rr = length(q), th = atan(q.y, q.x), fi = float(i);
    float rad = h.z * (1. + .035 * sin(th * 5. + fi * 1.7) + .02 * sin(th * 9. + fi));
    float di = rr - rad;
    float aa = fwidth(di) * 1.2;
    float bot = smoothstep(uBot - .02, uBot + .02, p.y);
    float c = (1. - smoothstep(-aa, aa, di)) * bot;
    if (c <= 0.) continue;
    float sB = -di / rad;                                  // 0 = 轮廓，1 = 圆心
    float fa = fwidth(sB) * 1.2 + .004;
    float big = step(.5, h.w);
    vec3 cc = uDk;
    cc = mix(cc, uLt, smoothstep(.06 - fa, .06 + fa, sB));
    cc = mix(cc, uMd, smoothstep(.15 - fa, .15 + fa, sB));
    cc = mix(cc, uLt, smoothstep(.30 - fa, .30 + fa, sB) * big);
    cc = mix(cc, uDk, smoothstep(.38 - fa, .38 + fa, sB));
    // 大云头的旋涡：核里卷进去的亮带（阿基米德螺线，带宽约 0.16 r，带间暗缝）
    if (big > .5) {
      float r2 = rr / rad, a2 = atan(q.y, q.x);
      float sv = r2 * 3.1 - a2 / 6.2832;
      float g = abs(fract(sv) - .5) * 2.;
      float ga = fwidth(r2) * 3.1 * 1.5 + .02;
      float band = (1. - smoothstep(.50 - ga, .50 + ga, g)) * (1. - smoothstep(.58, .62, r2)) * smoothstep(.04, .09, r2);
      cc = mix(cc, uLt, band);
    }
    col = mix(col, cc, c); cov = max(cov, c);
  }
  float n = bbFbm(vUv * vec2(uAsp, 1.) * 1.7);
  cov *= 1. - smoothstep(uDiss - .12, uDiss, n);
  cov *= 1. - bbSpread(gl_FragCoord.xy / uK, uSpr);
  if (cov <= .001) discard;
  gl_FragColor = vec4(col, cov * uA);
}`;
// 墨点（墨渍态文斑 + 金心）、大墨印
const DOT_FS = /* glsl */`
uniform float uIdx, uA, uFlash, uGoldA;
void main(){
  vec2 q = bbRot((vUv - .5) * 2. * 1.25, -.31);
  float d = bbWbPetal(q, uIdx, vec4(.6981, .1047, .1047, .1047), .42);
  d += .05 * (bbFbm(q * 3.5 + uIdx) - .5) * 2. + .015 * (bbVN(q * 12. + uIdx * 3.) - .5) * 2.;
  float aa = fwidth(d) * 1.2 + .03;
  float cov = 1. - smoothstep(-aa, aa, d);
  float cen = bbWbCenter(q, uIdx);
  vec3 ink = vec3(.0242, .0194, .0159), gold = vec3(.7605, .4851, .0437);
  vec3 c = mix(ink, gold * (1. + 2.5 * uFlash), cen * uGoldA);
  float a = max(cov * .93, cen * .85 * uGoldA);
  if (a < .01) discard;
  gl_FragColor = vec4(c, a * uA);
}`;

export function buildSky({ tex }) {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(fovOf(35), W / H, 0.05, 3000);
  const add = o => { scene.add(o); return o; };

  // —— 天 ——
  const skyMat = cardMat(SKYS_FS, {
    uA0: { value: lin('#6FA6CD') }, uA1: { value: lin('#A9D3E1') }, uA2: { value: lin('#D5EFFA') },
    uB0: { value: lin('#1B2238') }, uB1: { value: lin('#2A3A66') },
    uC0: { value: lin('#D6C08E') }, uC1: { value: lin('#CDAE78') }, uC2: { value: lin('#C29C64') }, uMixB: { value: 0 }, uMixC: { value: 0 },   // fix1：绢天压暗一档（style-18：豹与天亮度差 ≥ 40）
  });
  const sky = add(card(skyMat, -10));

  // —— 真光轮（第七日，金日 + 头光三环到 1.35R，无火舌）——
  const sunMat = cardMat(SUN_FS, { uCol: { value: lin('#EABA29') }, uRing: { value: lin('#D49232') }, uA: { value: 1 }, uGold: { value: 1 }, uHalo: { value: 1 }, uSeed: { value: 0 } });
  const sun = add(card(sunMat, -5));

  // —— 卷云 ——
  const DK = lin('#1C3366'), MD = lin('#1A52A0'), LT = lin('#0B68C4'), GP = lin('#1B2238');
  const mkCloud = (heads, { asp, body = 0, order = 0, bot = 0, tint = 0, margin = true } = {}) => {
    // fix2（v1-02）：云头（含 ±5.5% 起伏）离卡片左右边至少 0.03 卡高；超出就把卡片两边各加宽、云头整体平移（卡片中心不变，云不挪位）
    let asp2 = asp, sh = 0;
    if (margin && body <= 0) {
      let lo = 1e9, hi = -1e9;
      for (const h of heads) { const hw = h[2] * 1.06 / 0.55; lo = Math.min(lo, h[0] - hw); hi = Math.max(hi, h[0] + hw); }
      const over = Math.max(0, 0.03 - lo, hi - (asp - 0.03));
      sh = over; asp2 = asp + 2 * over;
    }
    const hs = heads.slice().sort((a, b) => (a[4] ?? a[1]) - (b[4] ?? b[1])).map(h => new THREE.Vector4(h[0] + sh, h[1], h[2], h[3]));
    while (hs.length < 96) hs.push(new THREE.Vector4(0, -9, 0, 0));
    const sky0 = lin('#A9D3E1');
    const m = cardMat(CLOUD_FS, {
      uHd: { value: hs }, uN: { value: Math.min(heads.length, 96) }, uAsp: { value: asp2 }, uBot: { value: bot }, uDiss: { value: 1.3 }, uA: { value: 1 }, uBody: { value: body }, uSpr: { value: 0 },
      uDk: { value: DK.clone().lerp(sky0, tint) }, uMd: { value: MD.clone().lerp(sky0, tint) }, uLt: { value: LT.clone().lerp(sky0, tint) }, uGap: { value: GP.clone().lerp(sky0, tint) },
    }, { side: THREE.DoubleSide });
    const c = add(card(m, order)); c.userData.asp = asp2; c.userData.asp0 = asp;
    return c;
  };
  // 一组云头（中间大、两头小、上排高）
  const cloudHeads = (seed, n, asp, y0 = 0.25, big = true) => {
    const R = mulberry(seed), hs = [];
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n, mid = 1 - Math.abs(u - 0.5) * 2;
      const r = (0.14 + 0.16 * mid + 0.04 * R()) * 1.0;
      hs.push([u * asp * 0.92 + asp * 0.04, y0 + r * 0.55 + 0.12 * mid + 0.05 * R(), r, big && i === Math.floor(n / 2) ? 1 : (big && R() < 0.25 ? 1 : 0)]);
    }
    return hs;
  };
  // S5a 云海顶（三层，近暗远淡）
  const seaClouds = [0, 1, 2].map(i => mkCloud(cloudHeads(70 + i, 9, 4.0, 0.2, i === 0), { asp: 4.0, body: 0.35, order: 1 + i * 0.1, tint: 0.35 - i * 0.12 }));
  // S5b 后云团
  const backClouds = [];
  for (let i = 0; i < 6; i++) backClouds.push(mkCloud(cloudHeads(120 + i, 7, 2.6, 0.18, true), { asp: 2.6, body: 0.0, order: 0.5 + i * 0.01 }));
  // S5b 前景云带 L1 / L2（横贯 9 m、高 2.6 m）
  const BAND_W = 4400, BAND_H = 1300, BAND_ASP = BAND_W / BAND_H;
  const bandHeads = (seed, asp) => {
    const R = mulberry(seed), hs = [];
    const rows = [[0.83, 0.125], [0.62, 0.13], [0.41, 0.135], [0.20, 0.14]];
    rows.forEach(([y, r0], ri) => {
      const n = Math.ceil(asp / (r0 * 1.62 / 0.55 * 0.92));
      for (let i = 0; i <= n; i++) {
        const r = r0 * (0.92 + 0.26 * R());
        // 画的先后：上排先画、下排压在上面（order 键 = 排号）
        hs.push([(i + (ri % 2) * 0.5) * asp / n + (R() - 0.5) * 0.03, y + (R() - 0.5) * 0.024, r, R() < 0.30 ? 1 : 0, ri * 10 + i * 0.01]);
      }
      // 填缝云头（fix2，v1-01 / tech-13）：在这一排与下一排的交界、云头之间的位置，画在两排下面，只从缝里露出来
      if (ri < rows.length - 1) {
        const yb = (y + rows[ri + 1][0]) / 2, nf = Math.ceil(asp / 0.40);
        for (let i = 0; i <= nf; i++) hs.push([(i + 0.25 + 0.5 * (ri % 2)) * asp / nf, yb + (R() - 0.5) * 0.02, 0.115, 0, ri * 10 - 5 + i * 0.01]);
      }
    });
    // 最下面再垫一排小云头（全在卡片里，底边离卡片下沿 ≥ 0.01，不会被卡片截平）：云墙下沿往下多盖约 70 px，盖满的几帧画面下缘不再露天
    { const nb = Math.ceil(asp / 0.30); for (let i = 0; i <= nb; i++) hs.push([(i + 0.5) * asp / nb, 0.088, 0.075, 0, -6 + i * 0.01]); }
    return hs.slice(0, 96);
  };
  const L1 = mkCloud(bandHeads(301, BAND_ASP), { asp: BAND_ASP, body: 0, order: 20, margin: false });
  const L2 = mkCloud(bandHeads(302, BAND_ASP), { asp: BAND_ASP, body: 0, order: 20.1, margin: false });
  // 云墙上缘的屏幕 y（设计像素）：从上缘入 → 盖满 → 豹冲出 → 从下缘出
  const L1top = monotone([[531, -1300], [536, -230], [542, -50], [543, 300], [546, 780], [549, 1100]]);
  const L2top = monotone([[553, -1300], [558, -230], [562, -50], [564, 560], [567, 760], [572, 1100]]);
  // S5c 残云、前景云丝
  const remnant = [0, 1, 2].map(i => mkCloud(cloudHeads(400 + i, 6, 2.2, 0.2, i === 1), { asp: 2.2, order: 15 + i * 0.01 }));
  // 前景云丝（fix2，v1-09）：改成和云堤同一套做法——扁的扇贝边云带，白顶平涂 + 下沿一道硬边影带，两头收尖；快速掠过只靠位移，不加模糊
  const wisp = add(card(cardMat(/* glsl */`
    uniform vec2 uSize;
    void main(){
      vec2 px = vUv * uSize;
      float x = vUv.x;
      float th = uSize.y * pow(max(sin(3.14159 * x), 0.), .65);
      float per = 70., cell = floor(px.x / per), fx = fract(px.x / per);
      float bump = sqrt(max(1. - pow(fx * 2. - 1., 2.), 0.)) * (5. + 6. * bbH1(cell * 1.7 + 3.)) * smoothstep(.0, .25, sin(3.14159 * x));
      float top = th * .78 + bump, bot = uSize.y * .08 + th * .02;
      float aa = fwidth(px.y) * 1.2;
      float inside = (1. - smoothstep(top - aa, top + aa, px.y)) * smoothstep(bot - aa, bot + aa, px.y) * step(bot + 1., top);
      float sh = bot + (top - bot) * .30 + 2. * (bbFbm(vec2(px.x * .01, 3.)) - .5);
      vec3 c = mix(vec3(.3663, .4735, .3916), vec3(.8879, .8550, .7758), smoothstep(sh - aa, sh + aa, px.y));
      if (inside < .01) discard;
      gl_FragColor = vec4(c, inside);
    }`, { uSize: { value: new THREE.Vector2(1100, 70) } }), 25));

  // —— 长卷（fix1，style-04 按 DESIGN 风险 #16 降级）：ref_00 的灰紫三排高耸馒头峰（远 #AE959F、中 #8A7A86、近 #665F67），
  //    4 层硬边叠晕（层顶一线亮、逐层 ×0.88、核再压暗），不要三角峰；云堤平涂 #F2EEE4 + 下沿一道硬边影带 #A3B7A8 ——
  const RCARD_H = 1000;
  // w3（zs-01）：可选 o.bandK（叠晕每层变暗的倍数）、o.gap（卡片 x 区间：这一段里的峰压到 o.gapK 倍高，留出云口）
  const mkRidge = (seed, cols, npk, hRange, wRange, order, bw, o = {}) => {
    const R = mulberry(seed), pk = [];
    const nMain = Math.min(npk, 7);
    for (let k = 0; k < nMain; k++) {
      const x = 150 + (k + 0.15 + 0.7 * R()) / nMain * 2700;
      const w = lerp(wRange[0], wRange[1], R()), h = lerp(hRange[0], hRange[1], Math.pow(R(), 0.8));
      pk.push(new THREE.Vector4(x, w, h, 1.0 + 0.8 * R()));
    }
    for (let k = nMain; k < 10; k++) {      // 肩峰：贴在某座主峰一侧，矮一截
      const host = pk[Math.floor(R() * nMain)];
      const side = R() < 0.5 ? -1 : 1;
      pk.push(new THREE.Vector4(host.x + side * host.y * (0.55 + 0.25 * R()), host.y * (0.55 + 0.2 * R()), host.z * (0.45 + 0.2 * R()), 1.2 + 0.6 * R()));
    }
    if (o.gap) for (const P of pk) if (P.x > o.gap[0] && P.x < o.gap[1]) P.z *= o.gapK ?? 0;
    npk = 10;
    const m = cardMat(RIDGE_FS, {
      uPk: { value: pk }, uNpk: { value: npk }, uSize: { value: new THREE.Vector2(3000, RCARD_H) }, uBase: { value: RCARD_H / 2 }, uBW: { value: bw }, uSeedR: { value: seed * 0.1 },
      uC: { value: lin(cols[0]) }, uEdge: { value: lin(cols[0]) }, uCore: { value: lin(cols[0]).multiplyScalar(cols[1]) }, uMist: { value: lin('#C7D1C2') },
      uRimC: { value: lin('#ffffff') }, uRimA: { value: 0 }, uRimW: { value: 2.6 }, uFadeTop: { value: 0.98 }, uFadeBot: { value: 1.0 }, uClear: { value: 1 }, uOp: { value: 1 }, uSpr: { value: -1 }, uHard: { value: 1 }, uBandK: { value: o.bandK ?? 0.84 }, uPlat: { value: 0 },
    });
    return add(card(m, order));
  };
  // w3（zs-01）：原来三排同一个灰紫、近排核压到 ×0.30（近黑），下半幅被压住、偏闷偏平。改成：
  //   远排冷而淡（淡青紫 #B7AFC3，核 ×0.72、层间 ×0.92），中排灰紫（#9C8794，核 ×0.58），近排暖一点、浓一点（赭紫 #8A6A6E，核 ×0.55）；
  //   最暗处由约 L 48 抬到约 L 84（降一档明度对比），冷暖、浓淡按远近拉开；近排矮一截（180–310 px），
  //   卡片 x 1340–1890 一段（S5c 中段落在画面中下）压成矮丘，留出一道云口，下半幅透气
  const rowFar = mkRidge(11, ['#B7AFC3', 0.72], 7, [170, 330], [120, 230], 3.0, 22, { bandK: 0.92 });
  const rowMid = mkRidge(23, ['#9C8794', 0.52], 7, [200, 350], [130, 230], 3.2, 16, { bandK: 0.89 });
  const rowNear = mkRidge(37, ['#86666B', 0.42], 6, [180, 310], [150, 240], 3.4, 15, { bandK: 0.87, gap: [1340, 1890], gapK: 0.22 });
  const BANK_FS = /* glsl */`
uniform vec2 uSize; uniform float uA, uSeedB, uSpr, uShadow; uniform vec3 uTopC, uBotC;
void main(){
  vec2 px = vUv * uSize;
  float x = px.x, per = 150.;
  float cell = floor(x / per), fx = fract(x / per);
  float bump = sqrt(max(1. - pow(fx * 2. - 1., 2.), 0.)) * (9. + 9. * bbH1(cell * 1.7 + uSeedB));
  float top = uSize.y * .70 + bump + 7. * (bbFbm(vec2(x * .004, uSeedB)) - .5) * 2.;
  float d = px.y - top, aa = fwidth(px.y) * 1.2;
  float inside = 1. - smoothstep(-aa, aa, d);
  // 下沿一道硬边影带（step + fwidth，不用长渐变）；上面平涂
  float shTop = uShadow + 4. * (bbFbm(vec2(x * .01, uSeedB + 3.)) - .5) * 2.;
  vec3 c = mix(uBotC, uTopC, smoothstep(shTop - aa, shTop + aa, px.y));
  // 第二排扇贝（内缝）
  float top2 = top - uSize.y * .30 + bump * .5;
  float seam = (1. - smoothstep(0., 1.6 * aa + 1.5, abs(px.y - top2))) * .25;
  c = mix(c, uBotC, seam);
  float a = inside * uA * (uSpr < 0. ? 1. : bbSpread(gl_FragCoord.xy / uK, uSpr));
  if (a < .003) discard;
  gl_FragColor = vec4(c, a);
}`;
  const bank = (seed, order, h = 120, shadow = 12) => add(card(cardMat(BANK_FS, { uSize: { value: new THREE.Vector2(3600, h) }, uA: { value: 1 }, uSeedB: { value: seed }, uSpr: { value: -1 }, uShadow: { value: shadow }, uTopC: { value: lin('#F2EEE4') }, uBotC: { value: lin('#A3B7A8') } }), order));
  // w3（zs-01）：近排云堤加高（150 → 260 px），近排山的下半截沉进一片云海里，画面下缘中段留出一道白云口
  const bankFar = bank(1.1, 3.05, 90, 11), bankMid = bank(2.2, 3.25, 96, 12), bankNear = bank(3.3, 3.45, 260, 14);
  bankNear.material.uniforms.uSize.value.set(3900, 260);
  const scrollSun = add(card(cardMat(SUN_FS, { uCol: { value: lin('#EABA29') }, uRing: { value: lin('#D49232') }, uA: { value: 1 }, uGold: { value: 1 }, uHalo: { value: 0 }, uSeed: { value: 0 } }), -4));

  // —— 山顶石（fix1，style-07）：竖长的石块、竖棱；叠晕用离散色（核 → 外：#4F4850 #676068 #8E7E8A #BCA0A8），层间按 fwidth 硬边、
  //    层内不再有亮度坡；光照只留一档硬阶（背光侧 ×0.86）；只在豹脚下压平一小块坐台 ——
  let rg = new THREE.IcosahedronGeometry(1, 14);
  rg.deleteAttribute('normal'); rg.deleteAttribute('uv'); rg = mergeVertices(rg);
  const rockGeo = (sx, sy, sz, seed, seatX = null) => {
    const g = rg.clone(), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
      const n = Math.sin(v.x * 1.1 * 3.1 + 1.3 + seed) * 0.5 + Math.sin(v.y * 1.1 * 4.3 - 2 + seed) * 0.3 + Math.sin(v.z * 1.1 * 5.7 + 0.7) * 0.2
        + 0.30 * Math.sin(v.x * 7.3 + v.y * 5.1 + seed) * Math.sin(v.z * 6.1 - v.y * 3.3);
      v.multiplyScalar(1 + n * 0.12 + 0.06 * Math.sin(v.x * 9.0 + seed * 2.0) * (1 - Math.abs(v.y)));    // 竖棱
      v.set(v.x * sx, v.y * sy, v.z * sz);
      if (seatX !== null) {    // 坐台（顶 y = sy·0.86）是这块石头的最高处：其余部分按穹顶包络压低，只在豹脚下约 0.3 m 压平
        const top = sy * 0.86, env = top - 0.55 * Math.pow(v.x - seatX, 2) - 0.25 * Math.pow(v.z, 2);
        if (v.y > env) v.y = env + (v.y - env) * 0.18;
        const k = Math.exp(-Math.pow((v.x - seatX) / 0.17, 2));
        if (v.y > top - 0.06) v.y = lerp(v.y, top + (v.y - top) * 0.12, k * clamp((v.y - (top - 0.06)) / 0.08));
      }
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
  };
  const rockMat = makeToonMaterial({ color: '#FFFFFF', shade1: '#DBDBDB', shade2: '#DBDBDB', step1: 0.30, feather1: 0.008, step2: 0.0,
    edgeNoise: 0.02, edgeNoiseScale: 1.2, rimAmt: 0, rimLitAmt: 0, cityAmt: 0, skyAmt: 0, fog: false, inkColor: '#2E2A33',
    fragmentNormal: /* glsl */`
      { float fr = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
        float x = (1.0 - fr) * 6.0 + 0.35 * (toonFbm(vToonObj * 0.9) - 0.5);
        float k = clamp(floor(x), 0.0, 3.0), tt = fract(x);
        float aq = max(fwidth(x), 1e-4) * 1.2;
        vec3 C0 = vec3(.0784, .0648, .0802), C1 = vec3(.1356, .1170, .1384), C2 = vec3(.2705, .2086, .2541), C3 = vec3(.5029, .3515, .3915);
        vec3 ck = k < .5 ? C0 : (k < 1.5 ? C1 : (k < 2.5 ? C2 : C3));
        vec3 cp = k < .5 ? C0 : (k < 1.5 ? C0 : (k < 2.5 ? C1 : C2));
        vec3 c = mix(cp, ck, smoothstep(0.0, aq, tt));
        diffuseColor.rgb = c * mix(0.98, 1.02, tt); }` });
  const rock = new THREE.Group(); add(rock);
  // 坐豹的位置（先算出来给坐台用）：身体中线落在 x = 0，坐台在前爪与臀之间
  const SA0 = tex.manifest.A02.锚点, SPPM0 = SA0.size[1] / 0.85;
  const SIT_X0 = -((SA0.bbox_px[0] + SA0.bbox_px[2]) / 2 - SA0.foot_pivot_px[0]) / SPPM0;
  const SIT_SEAT = SIT_X0 + ((SA0.forepaw_px[0] + SA0.foot_pivot_px[0]) / 2 - SA0.foot_pivot_px[0]) / SPPM0;
  // 主石（豹坐在它顶上 y = 1.0）+ 左右两块矮一点的竖石
  for (const [x, top, sx, sy, sz, seed, seat] of [[0, 1.0, 0.95, 1.5, 1.0, 0.0, 'S'], [-1.05, 0.62, 0.70, 1.25, 0.75, 2.1, null], [1.00, 0.45, 0.66, 1.15, 0.70, 4.3, null]]) {
    const g = rockGeo(sx, sy, sz, seed, seat === 'S' ? SIT_SEAT : seat);
    const m = new THREE.Mesh(g, rockMat);
    bindToon(m, rockMat, { castShadow: false, receiveShadow: false, outline: true }); m.userData.outlineWidth = 0.7; m.userData.outlineAlpha = 0.5; m.userData.outlineGroup = 'peak';
    m.position.set(x, top - sy * 0.86, -0.3 - Math.abs(x) * 0.3); rock.add(m);
  }

  // S5a 山顶（fix1，style-07 ⑤ 降级）：3D 山顶石块面圆鼓、核心一大团暗，改成和长卷同一套的叠晕山卡片——
  // 主峰顶上压出一块坐台（豹坐在上面），两侧各一座矮一点、远一点、浅一点的峰；外亮内暗、层间硬边
  const mkPeak = (seed, pk, edge, core, bw, order) => {
    const pks = pk.map(p => new THREE.Vector4(...p));
    while (pks.length < 10) pks.push(new THREE.Vector4(0, 1, 0, 1));
    const m = cardMat(RIDGE_FS, {
      uPk: { value: pks }, uNpk: { value: pk.length }, uSize: { value: new THREE.Vector2(1600, 1500) }, uBase: { value: 500 }, uBW: { value: bw }, uSeedR: { value: seed },
      uC: { value: lin(edge) }, uEdge: { value: lin(edge) }, uCore: { value: lin(core) }, uMist: { value: lin('#C7D1C2') },
      uRimC: { value: lin('#ffffff') }, uRimA: { value: 0 }, uRimW: { value: 2.6 }, uFadeTop: { value: 0.98 }, uFadeBot: { value: 1.0 }, uClear: { value: 1 }, uOp: { value: 1 }, uSpr: { value: -1 }, uHard: { value: 1 }, uBandK: { value: 0.80 }, uPlat: { value: 0 },
    });
    return add(card(m, order));
  };
  const peakMain = mkPeak(3.7, [[800, 560, 640, 1.6], [470, 300, 400, 1.2], [1130, 280, 360, 1.3]], '#BCA0A8', '#4F4850', 22, 3.0);
  peakMain.material.uniforms.uPlat.value = 610;
  const peakL = mkPeak(5.1, [[800, 380, 430, 1.4], [560, 230, 260, 1.4], [1010, 200, 230, 1.6]], '#C9B3B9', '#6A6170', 20, 2.9);
  const peakR = mkPeak(6.3, [[800, 360, 400, 1.5], [1050, 220, 250, 1.5], [580, 190, 210, 1.7]], '#C9B3B9', '#6A6170', 20, 2.85);
  const peaks = [peakMain, peakL, peakR];

  // —— 豹：坐（A02）/ 起跳（A03）/ 伸展（A04）——
  const MAN = tex.manifest;
  const sitA = MAN.A02.锚点, toA = MAN.A03.锚点, lpA = MAN.A04.锚点;
  const sit = makeLeo(tex.leo_sit, sitA, { order: 10, spotScale: 1.15 });
  const toff = makeLeo(tex.leo_takeoff, toA, { order: 10, spotScale: 1.15 });
  const leap = makeLeo(tex.leo_leap, lpA, { order: 10, spotScale: 1.15 });
  const ghosts = [0, 1, 2].map(() => makeLeo(tex.leo_takeoff, toA, { order: 9.5, spotScale: 1.15 }));
  for (const L of [sit, toff, leap, ...ghosts]) { L.U.uErase.value.set(600, 400, 9000, 60); setSpots(L, new Array(18).fill(3)); add(L.group); }
  for (const gh of ghosts) { gh.U.uTint.value.set(0, 0, 0); gh.U.uAdd.value.copy(lin3('#2B2622')); gh.U.uOpacity.value = 0.3; gh.U.uSpOn.value = 0; gh.mask.visible = false; }
  // 世界比例：坐高 0.85 m；其余姿态按 manifest 的 px/m（同一只豹按头长换算）
  const PPM_SIT = sitA.size[1] / 0.85, PPM_TO = PPM_SIT * toA.scale.px_per_m / sitA.scale.px_per_m, PPM_LP = PPM_SIT * lpA.scale.px_per_m / sitA.scale.px_per_m;

  // —— 墨点弧 ——
  const dots = [];
  for (let i = 0; i < 34; i++) { const d = add(card(cardMat(DOT_FS, { uIdx: { value: 60 + i }, uA: { value: 1 }, uFlash: { value: 0 }, uGoldA: { value: 1 } }, { side: THREE.DoubleSide }), 9.2)); d.visible = false; dots.push(d); }   // fix2：画在豹后面（豹挡住墨点，v1-07）

  // —— 豹的路径（世界坐标，monotone，按 tc 一拍二求值）——
  const PK = [[520, 0.25, 1.35], [526, 0.9, 2.3], [543, 3.0, 4.2], [567, 6.5, 6.6], [585, 9.5, 7.6], [606, 13.0, 8.0], [624, 16.5, 7.7], [646, 20.3, 7.3]];
  const pX = monotone(PK.map(k => [k[0], k[1]])), pY = monotone(PK.map(k => [k[0], k[2]]));
  const pitchK = monotone([[520, -15], [526, -12], [543, -8], [567, -5], [585, -2], [606, 1], [624, 2]]);
  const P = f => new THREE.Vector3(pX(f), pY(f), 0);
  // 相机偏移：S5b (−1, −0.9, 6) → S5c (−0.6, 0.3, 6)
  const camOff = f => { const u = ss5(fseg(f, 567, 585)); return new THREE.Vector3(lerp(-1.0, -0.6, u), lerp(-0.9, 0.3, u), 6.0); };
  const tgtOff = f => { const u = ss5(fseg(f, 567, 585)); return new THREE.Vector3(lerp(0.9, 0.5, u), lerp(0.25, 0.1, u), 0); };
  const lens = f => f < 533 ? lerp(35, 28, ss5(fseg(f, 520, 533))) : (f < 585 ? 28 : lerp(28, 32, ss5(fseg(f, 585, 624))));
  function camFollow(f) {
    const c = P(f - 0.12 * 24).add(camOff(f)), tg = P(f).add(tgtOff(f));
    cam.fov = fovOf(lens(f)); cam.updateProjectionMatrix();
    cam.position.copy(c); cam.up.set(0, 1, 0); cam.lookAt(tg); cam.updateMatrixWorld(true);
  }
  // 参考机位：卷云 / 山排按"那一帧的屏幕位置 + 深度"摆
  const ref = new THREE.PerspectiveCamera(fovOf(28), W / H, 0.05, 3000);
  const refAt = f => { const c = P(f - 0.12 * 24).add(camOff(f)), tg = P(f).add(tgtOff(f)); ref.fov = fovOf(lens(f)); ref.updateProjectionMatrix(); ref.position.copy(c); ref.up.set(0, 1, 0); ref.lookAt(tg); ref.updateMatrixWorld(true); return ref; };
  const putW = (m, camR, x, y, wpx, hpx, D) => putCard(m, camR, x, y, wpx, hpx, D);
  // S5a 机位（fix1，style-13 ②）：推近到 z ≈ 3.5，坐豹高约 435 px ≈ 日径 0.73，头顶出日轮约 26 px，豹身居中对准日心
  const SIT_BB = sitA.bbox_px;
  const SIT_X = -((SIT_BB[0] + SIT_BB[2]) / 2 - sitA.foot_pivot_px[0]) / PPM_SIT;     // 让坐豹身体中线落在 x = 0
  const camApos = f => new THREE.Vector3(0, lerp(0.75, 0.76, fseg(f, 496, 520)), lerp(3.60, 3.45, fseg(f, 496, 520)));
  const camAtgtY = (f, pos) => pos.y + Math.tan(lerp(5.9, 8.5, ss(fseg(f, 512, 520))) * DEG) * pos.z;
  const camA = new THREE.PerspectiveCamera(fovOf(35), W / H, 0.05, 3000);
  { const p0 = camApos(496); camA.position.copy(p0); camA.up.set(0, 1, 0); camA.lookAt(0, camAtgtY(496, p0), 0); camA.updateMatrixWorld(true); }
  putW(sun, camA, 960, 480, 520 * 1.6, 520 * 1.6, 64.2);
  // 卡片 1500 px 高、山脚基线在卡片自下而上 500 px 处 → 卡片中心 = 基线 − 250
  putW(peakMain, camA, 960, 1190 - 250, 1600, 1500, 3.75);
  putW(peakL, camA, 430, 1120 - 250, 1600, 1500, 5.4);
  putW(peakR, camA, 1500, 1140 - 250, 1600, 1500, 5.6);
  seaClouds.forEach((c, i) => putW(c, camA, 960 + (i - 1) * 140, 990 - i * 40, 2600 - i * 300, 650 - i * 80, 4.2 + [3, 8, 12][i]));
  // 后云团（沿上升路径）
  const BC = [[531, 420, 300, 46], [539, 1500, 760, 28], [545, 300, 820, 16], [552, 1650, 260, 46], [560, 380, 240, 28], [566, 1550, 820, 16]];
  // fix2（v1-02 / v1-03 / story-07）：卡片按原高摆（加宽的两边只是给边上的云头留余量）；起跳后镜头随豹上升，
  //   后云团 f520 时还在画面上缘外 760 px，f520–f530 从上缘压下来到位（eo）——金日 f522 以后才被云盖住，不再一帧整片出现
  const BC_REF = BC.map(([f]) => refAt(f).clone());
  const placeBack = (fl = 999) => backClouds.forEach((c, i) => {
    const [, x, y, D] = BC[i], H0 = 1500 / c.userData.asp0;
    const rise = -760 * (1 - eo(clamp((fl - 520) / 10)));
    putW(c, BC_REF[i], x, y + rise, H0 * c.userData.asp, H0, D);
  });
  placeBack();

  remnant.forEach((c, i) => { const H0 = 760 / c.userData.asp0; putW(c, refAt(570), [260, 1700, 980][i], [170, 120, 60][i], H0 * c.userData.asp, H0, 14); });
  // 长卷（S5c 机位 f600；豹此刻约在屏幕 (837, 547)）：远排山的峰顶在豹身后（y 410–490），豹贴着远山上沿飞（story-14）
  const rf = refAt(600);
  putW(scrollSun, rf, 1560, 380, 300 * 1.6, 300 * 1.6, 406);
  // 卡片 1000 px 高，山脚基线在卡片正中 → 基线屏幕 y = 中心 y
  putW(rowFar, rf, 960, 740, 3000, RCARD_H, 186);
  putW(rowMid, rf, 960, 870, 3000, RCARD_H, 86);
  putW(rowNear, rf, 960, 1010, 3200, RCARD_H, 41);
  putW(bankFar, rf, 960, 755, 3600, 90, 150);
  putW(bankMid, rf, 960, 885, 3600, 96, 60);
  putW(bankNear, rf, 960, 1012, 3900, 260, 20);
  putW(wisp, refAt(601), 1100, 770, 1100, 70, 3.0);

  // ── 墨点：自 f526 起每 4 帧从尾根落一枚；f606 / f612 / f618 三枚大墨印（沿同一条弧落下，不再上下乱跳，story-14）──
  const tailRootAt = (f) => {
    // 按当时姿态与朝向算尾根世界位置（A04）
    const p = P(f);
    camFollow(f);
    const q = new THREE.Quaternion(); cam.getWorldQuaternion(q);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -pitchK(f) * DEG));
    // fix2（v1-07）：墨点不在尾根出生（会像一团墨贴在臀和尾上），改在尾尖后方 0.18 m（沿飞行方向的反方向）
    const an = lpA, w = an.size[0] / PPM_LP, h = an.size[1] / PPM_LP;
    const TIP = [25, 193];          // A04 尾尖（alpha 最左端）
    const loc = new THREE.Vector3((TIP[0] - an.cog_px[0]) / an.size[0] * w, -(TIP[1] - an.cog_px[1]) / an.size[1] * h, 0).applyQuaternion(q);
    const dir = P(f + 1).sub(P(f - 1)).normalize();
    return p.add(loc).addScaledVector(dir, -0.18);
  };
  const DOTS = [];
  { let i = 0; for (let f = 526; f <= 624; f += 4, i++) DOTS.push({ f, R: 0.10, big: false, seed: i }); for (const f of [606, 612, 618]) DOTS.push({ f, R: 0.16, big: true, seed: f }); }
  const dotPos = DOTS.map(d => { const p = tailRootAt(d.f); const R = mulberry(d.seed * 31 + 7); p.add(new THREE.Vector3((R() - 0.5) * 0.06, 0, 0)); return p; });

  // —— 场景 H：豹头（A05）——
  const sceneH = new THREE.Scene();
  const camH = new THREE.PerspectiveCamera(30, W / H, 0.05, 100);
  camH.position.set(0, 0, 5); camH.lookAt(0, 0, 0); camH.updateMatrixWorld(true);
  const skyH = card(cardMat(SKYS_FS, { uA0: { value: lin('#D6C08E') }, uA1: { value: lin('#CDAE78') }, uA2: { value: lin('#C29C64') }, uB0: { value: lin('#1B2238') }, uB1: { value: lin('#2A3A66') },
    uC0: { value: lin('#D6C08E') }, uC1: { value: lin('#CDAE78') }, uC2: { value: lin('#C29C64') }, uMixB: { value: 0 }, uMixC: { value: 1 } }), -10);
  sceneH.add(skyH); putScreen(skyH, camH, 50, 1.05);
  const sunH = card(cardMat(SUN_FS, { uCol: { value: lin('#EABA29') }, uRing: { value: lin('#D49232') }, uA: { value: 1 }, uGold: { value: 1 }, uHalo: { value: 0 }, uSeed: { value: 0 } }), -5);
  sceneH.add(sunH); putCard(sunH, camH, -40, 560, 900 * 1.6, 900 * 1.6, 40);
  // #9 头后的云堤（fix2，v1-09）：和 S5c 云堤同一套硬边做法（白顶平涂 + 下沿硬边影带），不再是高斯柔边白带
  const bankH = card(cardMat(BANK_FS, { uSize: { value: new THREE.Vector2(2400, 240) }, uA: { value: 1 }, uSeedB: { value: 7.7 }, uSpr: { value: -1 }, uShadow: { value: 18 }, uTopC: { value: lin('#F2EEE4') }, uBotC: { value: lin('#A3B7A8') } }), -3);
  sceneH.add(bankH); putCard(bankH, camH, 960, 850, 2400, 240, 30);
  const A05 = MAN.A05.锚点;
  // 豹头（fix1）：新 A05；线 / 身 / 特征色按混合线段分（同 leo.js），眼框内一律保留原色（干净的黑瞳、琥珀虹膜，tech-04 / style-19）；
  // T2 大特写时把线向内腐蚀约 1.6 个图像像素，线色收到 #7D5732、70%（细线，style-03）
  const EYE_FS = {
    pars: LEO_SPLIT + /* glsl */`
uniform vec4 uNeck[2]; uniform vec3 uNeckC[2]; uniform vec3 uBodyB; uniform float uEyeOn, uThin, uPxS; uniform vec4 uEyeBox; uniform vec2 uHl; uniform vec4 uFeat[5]; uniform vec3 uFeatC;`,
    body: /* glsl */`
{
  vec2 sp = leoSplit(cs);
  float tb = sp.x;
  // fix2（v1-06）：鼻、须点、泪线、额颊墨点是"特征区"（manifest 位置，1× 像素）：T2 里不腐蚀、不换线色，整块保留原棕色
  float fm = 0.;
  if (uThin > 0.) {
    for (int k = 0; k < 5; k++) { vec4 F = uFeat[k]; fm = max(fm, 1. - smoothstep(.80, 1., length((vPx / uPxS - F.xy) / F.zw))); }
    vec2 d = uThin / uImg;
    float te = tb;
    for (int k = 0; k < 4; k++) {
      vec2 o = k == 0 ? vec2(d.x, 0.) : (k == 1 ? vec2(-d.x, 0.) : (k == 2 ? vec2(0., d.y) : vec2(0., -d.y)));
      vec4 cn = texture2D(map, vUv + o);
      te = max(te, leoSplit(bbL2S(cn.rgb)).x * step(.5, cn.a));
    }
    tb = mix(te, tb, fm);
  }
  float wt = max(fwidth(tb), 1e-4);
  float bodyS = mix(smoothstep(.28, .72, tb), smoothstep(.5 - wt, .5 + wt, tb), up);
  vec3 bc = uBodyB * clamp(lum / bbLum(uWc), .92, 1.03);
  // 颈部 2 枚环斑
  vec4 acc = vec4(0.);
  for (int i = 0; i < 2; i++) {
    vec4 S = uNeck[i];
    vec2 q = bbRot((vPx - S.xy) / S.z, S.w);
    if (dot(q, q) > 4.) continue;
    float dW = bbWbPetal(q, float(i) + 20., vec4(.8029, .2443, .2443, .2443), .36);
    float aa = fwidth(dW) * 1.2 + .01;
    float cv = 1. - smoothstep(-aa - .02, aa + .02, dW);
    float th = atan(q.y, q.x); if (th < 0.) th += 6.2831853;
    float cen = 1. - smoothstep(.55 * bbWbRho(th, float(i) + 20.) - .03, .55 * bbWbRho(th, float(i) + 20.) + .03, length(q));
    acc = vec4(uNeckC[i] * cv + acc.rgb * (1. - cv), cv + acc.a * (1. - cv));
    acc = vec4(vec3(.9301, .8796, .7529) * cen * .78 + acc.rgb * (1. - cen * .78), cen * .78 + acc.a * (1. - cen * .78));
  }
  vec3 b2 = acc.rgb + bc * (1. - acc.a);
  vec3 lineCol = mix(uLineCol, mix(b2, vec3(.2051, .0953, .0324), .80), step(.5, uThin));
  lineCol = mix(lineCol, uFeatC, fm);
  vec3 lc = mix(lineCol, b2, bodyS);
  col = mix(lc, c.rgb, sp.y);
  // 眼框内：线与特征色保留原画（不换线色、不腐蚀，干净的黑瞳与琥珀虹膜），身色照常换
  vec2 eb = (vPx - uEyeBox.xy) / uEyeBox.zw;
  float inEye = 1. - smoothstep(.92, 1.08, length(eb));
  float bodyO = smoothstep(.40, .60, sp.x) * (1. - sp.y);
  col = mix(col, mix(c.rgb, b2, bodyO), inEye);
  // 眼高光：清楚的小圆（P_g）
  if (uEyeOn > 0.) {
    float spx = 1. / max(length(fwidth(vPx)), 1e-4);
    float hl = 1. - smoothstep(14. * uK / spx - 1.2, 14. * uK / spx + 1.2, length(vPx - uHl));
    col = mix(col, vec3(1., .9216, .7454), hl * uEyeOn);
  }
}`,
  };
  const EB = A05.eye.bbox_px;
  // 特征区（1× 像素椭圆：中心 x, y, 半径 rx, ry）：鼻头、须点、泪线、额点、颊点
  const FEAT = [[1110, 455, 66, 60], [1003, 517, 98, 72], [842, 505, 46, 126], [790, 205, 128, 78], [575, 500, 136, 86]].map(v => new THREE.Vector4(...v));
  const mkHead = (t, k) => {
    const sp = makeSprite(t, { order: 10, frag: EYE_FS, lineCol: '#6E5340', segX: 32, segY: 24,
      uniforms: { uNeck: { value: A05.neck_spots.map(s => new THREE.Vector4(s.px[0] * k, s.px[1] * k, s.r_px * 0.85 * k, -18 * DEG + s.idx)) }, uNeckC: { value: A05.neck_spots.map(s => lin3(s.color)) },
        uBodyB: { value: lin3('#EEDFB0') }, uEyeOn: { value: 0 }, uThin: { value: 0 }, uPxS: { value: k }, uFeat: { value: FEAT }, uFeatC: { value: lin3('#66391C') },
        uEyeBox: { value: new THREE.Vector4((EB[0] + EB[2]) / 2 * k, (EB[1] + EB[3]) / 2 * k, (EB[2] - EB[0]) * 0.62 * k, (EB[3] - EB[1]) * 0.78 * k) },
        uHl: { value: new THREE.Vector2(A05.eye.highlight_px[0] * k, A05.eye.highlight_px[1] * k) },
        uWc: { value: new THREE.Vector3(...A05.colors.body_srgb) }, uLc: { value: new THREE.Vector3(...A05.colors.line_srgb) } } });
    sceneH.add(sp.group);
    return sp;
  };
  const head = mkHead(tex.leo_head, 1);
  // T2（约 3.5 倍特写）用两倍 Lanczos 预放大、鼻头已压平的 A05（fix2，v1-06）：截边台阶减半
  const head2 = mkHead(tex.leo_head_2x, 2);
  // w3（qa2-05）：T2 豹头外轮廓的"双色线"——精灵的深度遮罩层（不透明队列，先画）把身后的绢天卡片（透明队列，后画）挡掉了，
  //   剪影边上半透明的那一圈于是和清屏的黑色混在一起，成了最外 1–2 px 的深棕。场景 H 里豹头身后只有绢天、日、云堤三张卡片，
  //   全靠渲染顺序叠，不需要遮罩：两张豹头图都关掉遮罩层，边缘直接和绢天混，整条线只剩一种线色
  head.mask.visible = false; head2.mask.visible = false;
  const QH = new THREE.Quaternion();

  // ── 每帧 ──
  const _q = new THREE.Quaternion();
  function faceCam(L, Pw, anchor, ppm, ang = 0) {
    cam.getWorldQuaternion(_q);
    const q = _q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), ang));
    placeSprite(L, Pw, q, anchor, ppm);
    L.group.visible = true;
  }
  function hideAll() {
    for (const L of [sit, toff, leap, ...ghosts]) { L.group.visible = false; clearDeform(L); }
    for (const d of dots) d.visible = false;
    for (const c of [...seaClouds, ...backClouds, L1, L2, ...remnant]) { c.visible = false; c.material.uniforms.uDiss.value = 1.3; c.material.uniforms.uA.value = 1; }
    for (const m of [rowFar, rowMid, rowNear, bankFar, bankMid, bankNear, scrollSun, wisp]) m.visible = false;
    sun.visible = false; rock.visible = false; for (const p of peaks) p.visible = false;
  }
  const scr = p => { const s = project(cam, W, H, p); return [s.x / K, s.y / K]; };
  // S5a 机位（f496–f520）与 S5a → S5b 的机位过渡（f520–f530，story-07：起跳不再被一刀吃掉）
  const _pA = new THREE.Vector3(), _tA = new THREE.Vector3(), _pF = new THREE.Vector3(), _tF = new THREE.Vector3();
  function camS5a(f) {
    const pos = camApos(Math.min(f, 520));
    _pA.copy(pos); _tA.set(0, camAtgtY(Math.min(f, 520), pos), 0);
    return [_pA, _tA, fovOf(35)];
  }
  function followPose(f) {
    _pF.copy(P(f - 0.12 * 24)).add(camOff(f)); _tF.copy(P(f)).add(tgtOff(f));
    return [_pF, _tF, fovOf(lens(f))];
  }
  function setCam(pos, tgt, fov) {
    cam.fov = fov; cam.updateProjectionMatrix();
    cam.position.copy(pos); cam.up.set(0, 1, 0); cam.lookAt(tgt); cam.updateMatrixWorld(true);
  }
  function camS5(f) {
    if (f < 520) { const [p, t, v] = camS5a(f); setCam(p, t, v); return; }
    const k = ss(fseg(f, 520, 531));
    if (k >= 1) { camFollow(f); return; }
    const [pa, ta, va] = camS5a(520); const pa2 = pa.clone(), ta2 = ta.clone();
    const [pf, tf, vf] = followPose(f);
    setCam(pa2.lerp(pf, k), ta2.lerp(tf, k), lerp(va, vf, k));
  }
  const api = {
    update(t) {
      hideAll();
      const f = t * 24, fi = Math.round(f), f2 = fi - (fi & 1), tc = f2 / 24;
      let toon = { keyDir: [0, 0.35, -0.94] };
      let fx = null;
      if (fi < 520) {
        // ── S5a 崖顶坐定（徽记）──
        camS5(f);
        putScreen(sky, cam, 2500, 1.05);
        skyMat.uniforms.uMixB.value = 0; skyMat.uniforms.uMixC.value = 0;
        sun.visible = true; sunMat.uniforms.uHalo.value = 1; sunMat.uniforms.uA.value = 1;
        putW(sun, camA, 960, 480, 520 * 1.6, 520 * 1.6, 64.2);
        for (const c of seaClouds) c.visible = true;
        for (const p of peaks) p.visible = true;
        // 坐豹：端坐呼吸；f498–f506 金光沿全身环斑扫过；f511–f519 四步蓄势（压到 0.88、前倾 −6°，f518 停一帧再起跳）
        const glow = new Array(18).fill(0);
        const order = sitA.spots.map((s, i) => [s.px[0], i]).sort((a, b) => a[0] - b[0]);
        order.forEach(([, i], k) => { const fs = 498 + k * 8 / 18; glow[i] = f >= fs && f < fs + 2 ? 0.8 : 0; });
        setSpots(sit, new Array(18).fill(3), glow);
        const br = sitA.regions['呼吸区'];
        sit.U.uBre.value.set(...br.rect_px); sit.U.uBreP.value.set(br.pivot_y_px, 0.008 * Math.sin(tc / 2.2 * Math.PI * 2), br.feather_px);
        const crouchN = f2 >= 512 ? Math.min(3, (f2 - 510) / 2) / 3 : 0;
        sit.U.uGlo.value.set(sitA.foot_pivot_px[0], sitA.foot_pivot_px[1], 1 + 0.04 * crouchN, 1 - 0.12 * crouchN);
        sit.U.uLean.value = -6 * DEG * crouchN;
        faceCam(sit, new THREE.Vector3(SIT_X, 1.0, 0), sitA.foot_pivot_px, PPM_SIT);
        toon = { keyDir: [0, 0.35, -0.94] };
      } else if (fi < 624) {
        // ── S5b 卷云层层推进 → S5c 化开成长卷 ──
        camS5(f);
        putScreen(sky, cam, 2500, 1.05);
        const dk = ss(fseg(f, 530, 543));
        const spr = fseg(f, 567, 595);
        skyMat.uniforms.uMixB.value = dk; skyMat.uniforms.uMixC.value = spr;
        for (const c of [...backClouds, ...remnant, L1, L2]) c.material.uniforms.uSpr.value = spr;
        // 起跳的头几帧：山顶石与云海顶还在画面下缘（豹从石面蹬起）
        if (fi < 531) { for (const p of peaks) p.visible = true; for (const c of seaClouds) c.visible = true; }
        // 金月：同一个日去头光，一直在豹身后
        {
          sun.visible = true; sunMat.uniforms.uHalo.value = 1 - fseg(f, 520, 530); sunMat.uniforms.uA.value = 1;
          const ps = scr(P(f));
          let sx = lerp(960, ps[0] + 160, ss(fseg(f, 520, 534))), sy = lerp(480, ps[1] - 60, ss(fseg(f, 520, 534))), d = lerp(520, 380, ss(fseg(f, 520, 534)));
          const m = ss(fseg(f, 567, 588));
          sx = lerp(sx, 1560 - 0.7 * (f - 588), m); sy = lerp(sy, 380, m); d = lerp(d, 300, m);
          putCard(sun, cam, sx, sy, d * 1.6, d * 1.6, 300);
        }
        placeBack(f);
        for (const c of backClouds) { c.visible = fi < 596; c.material.uniforms.uDiss.value = 1.3; c.material.uniforms.uA.value = 1; }
        L1.visible = fi >= 531 && fi < 550; L2.visible = fi >= 553 && fi < 573;
        if (L1.visible) putCard(L1, cam, 2060 - 50 * (f - 531), L1top(f) + BAND_H / 2, BAND_W, BAND_H, 3.4);
        if (L2.visible) putCard(L2, cam, 2060 - 50 * (f - 553), L2top(f) + BAND_H / 2, BAND_W, BAND_H, 3.2);
        if (fi >= 567) { for (const c of remnant) { c.visible = fi < 596; c.material.uniforms.uDiss.value = 1.3; } }
        if (fi >= 567) {
          for (const m of [rowFar, rowMid, rowNear, bankFar, bankMid, bankNear]) m.visible = true;
          for (const m of [rowFar, rowMid, rowNear]) { m.material.uniforms.uOp.value = 1; m.material.uniforms.uSpr.value = spr; }
          for (const m of [bankFar, bankMid, bankNear]) { m.material.uniforms.uA.value = 1; m.material.uniforms.uSpr.value = spr; }
          // w3（qa2-01）：云丝固定在世界里（D 3.0），每帧约移 91 px，要约 33 帧才走完一个画面；原来只开 [596, 606)，
          //   在画面中间一帧冒出、一帧消失。改成整个 S5c 都开着：f578 时整条还在右框外，f623 时整条已出左框，真正从画外掠过
          wisp.visible = fi >= 578;
        }
        // 豹（tech-02）：位移走一拍一（P(f) 连续），只有姿态换图与起伏走一拍二（tc）——跟拍时豹在画框里只做平滑移动
        const Pw = P(f).add(new THREE.Vector3(0, fi >= 526 ? 0.04 * Math.sin(tc * Math.PI * 2) : 0, 0));
        const ang = -pitchK(f) * DEG + (fi >= 526 ? 2 * DEG * Math.sin(tc * Math.PI * 2 + 1) : 0);
        if (fi < 526) {
          faceCam(toff, Pw, toA.cog_px, PPM_TO, ang);
          if (fi < 522) {
            toff.U.uGlo.value.set(toA.cog_px[0], toA.cog_px[1], 1.08, 0.97);
            const back = new THREE.Vector3(-0.30, -0.32, 0);
            ghosts.forEach((g, k) => { faceCam(g, Pw.clone().addScaledVector(back, (k + 1) * 0.30), toA.cog_px, PPM_TO, ang); });
          }
        } else {
          faceCam(leap, Pw, lpA.cog_px, PPM_LP, ang);
          const br = lpA.regions['呼吸区'];
          leap.U.uBre.value.set(...br.rect_px); leap.U.uBreP.value.set(lpA.cog_px[1], 0.02 * Math.sin(tc * Math.PI * 2), br.feather_px);
          setRot(leap, 0, lpA.regions['尾区'].pivot_px, 5 * DEG * Math.sin(tc * Math.PI * 2 + 2), lpA.regions['尾区'].rect_px, 40);
        }
        // 墨点（固定在世界坐标里，留在身后）
        DOTS.forEach((d, i) => {
          if (f < d.f || i >= dots.length) return;
          const m = dots[i]; m.visible = true;
          const k = lerp(1.3, 1.0, eo(fseg(f, d.f, d.f + 3)));
          m.position.copy(dotPos[i]); cam.getWorldQuaternion(m.quaternion);
          m.scale.set(d.R * 2 * k, d.R * 2 * k, 1);
          m.material.uniforms.uFlash.value = d.big ? (1 - fseg(f, d.f + 1, d.f + 5)) * (f >= d.f + 1 ? 1 : 0) : 0;
        });
        toon = { keyDir: [0.3, 0.5, 0.8] };
      } else {
        // ── #8 推近：全身（85 mm，跟拍 P(f) 继续向前飞，远山与云堤随之后退、墨点向左拉开成串；日在豹身后（画左），story-09 / story-13）──
        const Pc = P(f);
        const u = fseg(f, 624, 635);
        cam.fov = fovOf(85); cam.updateProjectionMatrix();
        cam.position.set(Pc.x - 0.4, Pc.y + 0.1, lerp(6.5, 6.3, u)); cam.up.set(0, 1, 0); cam.lookAt(Pc.x + 0.3, Pc.y, 0); cam.updateMatrixWorld(true);
        putScreen(sky, cam, 2500, 1.05);
        skyMat.uniforms.uMixB.value = 0; skyMat.uniforms.uMixC.value = 1;
        for (const m of [rowFar, bankFar, bankMid]) m.visible = true;     // 85 mm 下中、近排山会被放大成大块，只留远排山与两条云堤（压平的山排）
        for (const m of [rowFar, rowMid, rowNear]) { m.material.uniforms.uOp.value = 1; m.material.uniforms.uSpr.value = -1; }
        for (const m of [bankFar, bankMid, bankNear]) { m.material.uniforms.uA.value = 1; m.material.uniforms.uSpr.value = -1; }
        sun.visible = true; sunMat.uniforms.uHalo.value = 0; sunMat.uniforms.uA.value = 1;
        putCard(sun, cam, 300, 560, 250 * 1.6, 250 * 1.6, 300);
        faceCam(leap, Pc.clone().add(new THREE.Vector3(0, 0.03 * Math.sin(tc * Math.PI * 2), 0)), lpA.cog_px, PPM_LP, -pitchK(f) * DEG);
        const br = lpA.regions['呼吸区'];
        leap.U.uBre.value.set(...br.rect_px); leap.U.uBreP.value.set(lpA.cog_px[1], 0.02 * Math.sin(tc * Math.PI * 2), br.feather_px);
        DOTS.forEach((d, i) => { if (i < dots.length && f >= d.f) { const m = dots[i]; m.visible = true; m.position.copy(dotPos[i]); cam.getWorldQuaternion(m.quaternion); m.scale.set(d.R * 2, d.R * 2, 1); m.material.uniforms.uFlash.value = 0; } });
        const pre = f >= 633 ? 1.03 : 1;
        cam.fov = fovOf(85) / pre; cam.updateProjectionMatrix();
        toon = { keyDir: [0.3, 0.5, 0.8] };
      }
      return { scene, cam, toon, fx };
    },
    // #9（头颈推近）与 T2（豹眼大特写·一闪）
    updateT2(t, PG = [1040, 410]) {
      const f = t * 24, fi = Math.round(f), f2 = fi - (fi & 1), tc = f2 / 24;
      head.group.visible = fi < 646; head2.group.visible = fi >= 646;
      const FPXH = 520 / Math.tan(15 * DEG);
      let fx;
      if (fi < 646) {
        // #9：头高约 665 px（耳顶 → 下巴），眼在 (980, 430) 附近；缓推 3%；切前 2 帧 103%
        const u = fseg(f, 635, 646), s = 0.95 * lerp(1, 1.03, u) * (f >= 644 ? 1.03 : 1);
        const P0 = screenToWorld(camH, W, H, 980 * K, 430 * K, 5);
        placeSprite(head, P0, QH, [A05.eye.center_px[0], A05.eye.center_px[1]], FPXH / (5 * s));
        head.U.uEyeOn.value = 0; head.U.uThin.value = 0;
        bankH.visible = true; sunH.visible = true;
        fx = () => {};
      } else {
        // T2：眼宽约 460 px；高光正好在 P_g；f646–f652 静、头整体 +6 px 漂移（一拍二）；线向内收细
        const s = 460 / A05.eye.width_px;
        const drift = 6 * (fseg(f2, 646, 652) - 1);     // 头整体 +6 px 漂移，停在 P_g（闪光与 S6 镜片闪同点）
        const P0 = screenToWorld(camH, W, H, (PG[0] + drift) * K, PG[1] * K, 5);
        placeSprite(head2, P0, QH, [A05.eye.highlight_px[0] * 2, A05.eye.highlight_px[1] * 2], 2 * FPXH / (5 * s));
        head2.U.uEyeOn.value = 1; head2.U.uThin.value = 3.2;
        bankH.visible = false; sunH.visible = false;
        const L = 600 * Math.pow(fseg(f, 652, 658), 2.2);
        fx = (ov) => { if (f >= 652) { ov.glint(PG[0] + drift, PG[1], L, 1); ov.UA.uGlHalo.value = 1.2; } };
      }
      return { scene: sceneH, cam: camH, toon: { keyDir: [0.3, 0.5, 0.8] }, fx };
    },
  };
  return api;
}
