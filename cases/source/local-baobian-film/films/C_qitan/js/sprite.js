// sprite.js — 2D 喷枪软体积精灵（人物、豹、手、鹿）
// 一张精灵 = 彩色层 + 只写深度的遮罩层（给景深读深度）+ 可选轮廓辉光层；三者共用同一组 uniform 和同一套网格形变。
// 着色顺序：贴图 →（材质内模糊）→ 豹斑（金态色）→ 眼睑 → 去饱和（局部金化、眼睛保暖）→ 湿墨斑 → 指尖墨渍 → 代码眼
//          → 段光色 → 暗部混色 → 边缘光 → 光斑（受光色块）→ 远处混雾 →（可选：调色仿真，用于屏幕层）
// 形变全部是 uniform（由 tc 算出），确定性。
import * as THREE from 'three';
import { GLSL_COMMON, lin3, motifPh, motifK } from './util.js';

const VS = /* glsl */`
${GLSL_COMMON}
uniform vec2 uTexSize;
uniform vec4 uBendA[4]; uniform vec4 uBendB[4]; uniform int uBendN;
uniform vec4 uBreath;
uniform vec4 uPad;
uniform vec4 uUvRect;
varying vec2 vUv, vPx, vQ;
vec2 rot2(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
void main(){
  vec2 uv0 = uv;
#ifdef GLOW
  uv0 = (uv - .5) * uPad.x + .5;
#endif
  vec2 p = vec2(uv0.x, 1. - uv0.y) * uTexSize;
  for (int i = 0; i < 4; i++) {
    if (i >= uBendN) break;
    vec2 pv = uBendA[i].xy, ce = uBendA[i].zw;
    float w = 1. - sst(uBendB[i].y, uBendB[i].z, length(p - ce));
    p = pv + rot2(p - pv, uBendB[i].x * w);
  }
  if (abs(uBreath.z) > 0.) { float w = 1. - sst(0., uBreath.w, length(p - uBreath.xy)); p = uBreath.xy + (p - uBreath.xy) * (1. + uBreath.z * w); }
  vQ = uv0; vUv = uUvRect.xy + uv0 * uUvRect.zw; vPx = vec2(uv0.x, 1. - uv0.y) * uTexSize;
  vec3 pos = vec3(p.x / uTexSize.x - .5, .5 - p.y / uTexSize.y, 0.);
  if (uPad.y > .5) pos.x = -pos.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.);
}`;

const FS = /* glsl */`
${GLSL_COMMON}
uniform sampler2D map;
uniform vec2 uTexSize;
uniform float uAlpha, uDesat, uBlur;
uniform vec3 uLight, uDarkC; uniform float uDarkAmt;
uniform vec3 uRimC; uniform float uRimAmt; uniform vec2 uRimDir; uniform float uRimW;
uniform vec3 uFogC; uniform float uFogAmt;
uniform vec4 uEye, uEyeB, uEyeC; uniform float uK2, uEdgeFall, uEdgeLod;
uniform vec3 uIris0, uIris1, uLidC; uniform vec4 uPupil, uHi, uHi2; uniform vec3 uHi2C;
uniform int uSpotN; uniform vec4 uSpotC[64]; uniform vec4 uSpotP[64]; uniform vec4 uSpotX[64];
uniform float uTc, uGoldClear, uSpotOn;
uniform vec4 uEx1, uEx2; uniform vec2 uExT;
uniform int uDapN; uniform vec4 uDap[16]; uniform vec4 uDapR[16]; uniform vec4 uDapP[16]; uniform float uDapM, uDapOn, uDapLeaf, uDap7;
uniform float uGradeOn; uniform vec3 uGWB, uGLift; uniform float uGSat, uGToe;
uniform vec3 uGlowC; uniform float uGlowA, uGlowLod;
uniform float uBodyDark; uniform vec4 uBodyDarkE;
uniform vec4 uUvRect;
uniform float uLineOn; uniform vec4 uLineA, uLineB;
uniform vec4 uSoftE; uniform vec3 uSoftRef;
uniform vec2 uSpotXf;   // 第 4 轮（zs-01）：墨渍（kind 3）按精灵在屏幕上的转角 / 镜像换回屏幕方向——S1a、S3c 指尖的墨环和 S4b、S6 的母题同一个朝向   // 返修 style-10（第 2 轮）：资产里画的腮红——椭圆内换成大半径模糊、再向旁边的毛色淡 45%（羽化约 30K、α 约 .25）
varying vec2 vUv, vPx, vQ;
// 豹斑版（返修 v2-02，第 3 轮）：和母题同一套随机量（转向、沿毛流拉长 1.2–1.5、半径起伏），但每个墨团的弧长封顶在墨团宽的 .45–.7 倍，
//   墨团宽 .30–.56（比母题胖），4–6 个墨团——单个墨团的长宽比 ≤ 2，大斑也读成"一圈墨团"，不会拉成虎纹那样的长墨条
vec3 rosetteField(vec2 q, vec4 ph, float k, float gapK){
  float th = (ph.z - 3.1416) * .25, cs = cos(th), sn = sin(th);
  vec2 p = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y);
  p.x /= 1.2 + .3 * mfr(ph.w * .159);
  float r = length(p), a = atan(p.y, p.x);
  float rho = mRho(a, ph);
  float sd = 1e9;
  float kk = k;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    if (fi >= kk) break;
    float h1 = mh(fi, ph.x), h2 = mh(fi + 7., ph.y), h3 = mh(fi + 13., ph.z);
    float c = ph.w + (fi + .5 + .3 * (h1 - .5)) * 6.2832 / kk;
    float w = (.44 + .26 * h3) * (1. + .12 * sin(3. * c + ph.w));
    float rc = max(mRho(c, ph), .5);
    // 两个上限取小：① 墨团之间至少留 15–35% 的断口（算上圆头）；② 墨团弧长 ≤ (.5–.7)·宽，长宽比 ≤ 2
    float hs = max(min(3.1416 / kk * (1. - mix(.15, .35, h2) * gapK) - .3 * w / rc, (.5 + .2 * h1) * w / rc), .05);
    float dl = a - c; dl -= 6.2832 * floor((dl + 3.1416) / 6.2832);
    float d, u;
    if (abs(dl) <= hs) { d = abs(r - rho); u = dl / hs; }
    else { float e = c + sign(dl) * hs; float re = mRho(e, ph); d = length(p - re * vec2(cos(e), sin(e))); u = sign(dl); }
    sd = min(sd, d - .5 * w * (1. - .35 * u * u));
  }
  return vec3(sd, rho, r);
}
vec4 tx(vec2 uv, float lod){ return textureLod(map, uv, lod); }
vec4 blurTex(vec2 uv, float r){
  if (r < .6) return texture2D(map, uv);
  float lod = max(log2(r / 2.2), 0.);
  vec2 s = r / uTexSize * uUvRect.zw;
  vec4 a = tx(uv, lod) * .2;
  for (int i = 0; i < 12; i++) {
    float an = float(i) * .5236 + (i > 5 ? .26 : 0.);
    float rr = i > 5 ? 1. : .5;
    a += tx(uv + vec2(cos(an), sin(an)) * s * rr, lod) * (i > 5 ? .0667 : .0667);
  }
  return a;
}
float popScale(float age){ return age < 2. ? 0. : age < 4. ? .6 : age < 6. ? 1.14 : age < 8. ? .96 : 1.; }
vec3 rgb2hsv(vec3 c){ vec4 K = vec4(0., -1. / 3., 2. / 3., -1.); vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g)); vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r)); float d = q.x - min(q.w, q.y); float e = 1.0e-10; return vec3(abs(q.z + (q.w - q.y) / (6. * d + e)), d / (q.x + e), q.x); }
vec3 oetf(vec3 c){ return mix(c * 12.92, 1.055 * pow(max(c, 0.), vec3(.41666)) - .055, step(.0031308, c)); }
void main(){
#ifdef MASK
  if (texture2D(map, vUv).a < .5) discard;
  gl_FragColor = vec4(0.);
  return;
#endif
#ifdef GLOW
  float ga = 0.;
  if (vQ.x > 0. && vQ.y > 0. && vQ.x < 1. && vQ.y < 1.) ga = textureLod(map, vUv, uGlowLod).a;
  ga *= sst(0., .03, vQ.x) * sst(0., .03, vQ.y) * sst(0., .03, 1. - vQ.x) * sst(0., .03, 1. - vQ.y);
  gl_FragColor = vec4(uGlowC, ga * uGlowA * uAlpha);
  return;
#endif
  vec4 t = blurTex(vUv, uBlur);
  if (t.a < .003) discard;
  vec3 c = t.rgb;
  if (uSoftE.z > 0.) {
    float se = length((vPx - uSoftE.xy) / uSoftE.zw);
    float k = 1. - sst(.55, 1.25, se);
    if (k > 0.) {
      vec2 refUv = uUvRect.xy + vec2(uSoftRef.x / uTexSize.x, 1. - uSoftRef.y / uTexSize.y) * uUvRect.zw;
      vec3 bl = textureLod(map, vUv, 5.5).rgb, fr = textureLod(map, refUv, 5.).rgb;
      c = mix(c, mix(bl, fr, uSoftRef.z), k);
    }
  }
  vec3 cs = l2s(c);
  // ── 豹斑（金态色），局部金化 ──
  float gold = 0., wetA = 0., inkA = 0., wetHi = 0.;
  vec3 RING = vec3(.0232, .0152, .0092), CORE = vec3(.254, .111, .023), INK = vec3(.0103, .0091, .0085), WET = vec3(.0130, .0116, .0110);
  if (uSpotN > 0) {
    vec3 hsv = rgb2hsv(cs);
    float fur = sst(.22, .32, hsv.z) * (1. - sst(.86, .93, hsv.z)) * sst(.035, .06, hsv.x) * (1. - sst(.15, .18, hsv.x)) * sst(.18, .3, hsv.y);
    fur *= sst(.95, 1.1, ellR(vPx, uEx1.xy, uEx1.zw, uExT.x)) * sst(.95, 1.1, ellR(vPx, uEx2.xy, uEx2.zw, uExT.y));
    float ringA = 0., coreA = 0., innerA = 0.;
    for (int i = 0; i < 64; i++) {
      if (i >= uSpotN) break;
      vec4 C = uSpotC[i], X = uSpotX[i];
      vec2 dq = (vPx - C.xy) / C.z;
      float dd = dot(dq, dq);
      if (X.y < 1.5) {
        // 豹斑（返修 style-02）：环 = 大小不一的墨团；斑心比底毛深一档的赭色；环内侧再压暗 10%
        float age = floor((uTc - C.w) * 24. + .5);
        if (age < 0.) continue;
        gold = max(gold, sst(0., 10., age) * (1. - sst(1.3, 2.2, sqrt(dd))));
        if (dd > 7. || uSpotOn < .5) continue;
        float sc = popScale(age);
        if (sc < .01) continue;
        vec2 qs = dq / sc;
        // 第 2 轮（style-02 / v1-03）：小斑（头、颈、尾、四肢）也用母题环画——不同种子、k 3–6、各自转向，不再是同一个三瓣点；
        //   墨团边缘带沿毛流的细毛刺（不再是光滑的几何豆子），墨色有浓淡，环外一圈毛尖般的淡墨
        float small = X.y > .5 ? 1. : 0.;
        float fi = float(i);
        // 第 3 轮（v2-02）：身上的斑（X.z > .5）用豹斑版 rosetteField；种子 7 那一枚和头上的斑仍用母题原式（同一个形）
        //   X.z = 1：身上的豹斑（4–6 → 5–6 个墨团）；X.z = .75：身上那枚种子 7（墨团数、位置、转向和母题一样，只是墨团收短加粗）
        // 第 4 轮（v3-06）：X.z ≈ .25 = 实心小点（真豹头上的斑：小、实、略扁的墨团，边上同一种毛刺），和身上的豹斑同一支笔
        bool dotS = X.z > .2 && X.z < .3;
        bool ros = X.z > .5 || dotS;
        float kk = X.z > .9 ? clamp(X.x + 1., 5., 6.) : clamp(X.x, 4., 6.);
        vec3 F = dotS ? vec3(length(qs * vec2(1., 1.18)) - (.56 + .12 * mh(fi, uSpotP[i].x)) + .1 * fbm(qs * 2.4 + fi * 3.1, 19u), 1., 9.)
               : (X.z > .5 ? rosetteField(qs, uSpotP[i], kk, mix(1., .75, small)) : motifField(qs, uSpotP[i], X.x, mix(1., .75, small)));
        // 毛刺只在墨团边缘 2–3K 以内（各向同性，不再沿一个方向拖长）
        float en = ros ? .045 * fbm(qs * 4.6 + fi * 3.7, 16u) + .02 * fbm(qs * 13. + fi, 17u)
                       : .075 * fbm(qs * 4.2 + fi * 3.7, 16u) + .035 * fbm(vec2(qs.x * 14., qs.y * 5.) + fi, 17u);
        float sd = F.x + en - small * (ros ? .02 : .06);
        float ring = 1. - sst(-.05, .07, sd);
        float hair = (1. - sst(.0, ros ? .08 : .17, sd)) * (1. - ring) * (ros ? .2 : .32);
        float dens = .78 + .22 * sst(-.25, .3, fbm(qs * 2.6 + fi * 1.9, 18u));
        float core = 1. - sst(0., .78 * F.y, F.z);
        ringA = max(ringA, max(ring * .94 * dens, hair));
        coreA = max(coreA, core * (1. - ring) * .85 * (1. - .35 * small));
        innerA = max(innerA, sst(.42 * F.y, .8 * F.y, F.z) * (1. - ring) * (1. - sst(.85 * F.y, 1.05 * F.y, F.z)));
      } else if (X.y < 2.5) {
        // 湿墨斑（灰态，返修 story-01 / main-02）：不规则断环（MOTIF + fbm 毛刺），深墨、湿、边缘洇开，每枚一颗湿高光
        if (dd > 9.) continue;
        float n1 = fbm(vPx / C.z * 1.2 + float(i) * 7.3, 11u), n2 = fbm(vPx / C.z * 3.4 + float(i) * 3.1, 12u);
        vec2 qq = dq * (1. + .22 * n1 + .05 * n2) / 1.1;
        vec3 F = motifField(qq, uSpotP[i], X.x, .55);
        float ring = 1. - sst(-.22, .18, F.x - .12);          // 墨团加厚、边软
        float core = (1. - sst(.1, .85 * F.y, F.z)) * .34;     // 斑心一层湿暗
        float bleed = (1. - sst(-.05, .48, F.x - .05)) * .32;   // 向外洇开的一圈
        wetA = max(wetA, max(max(ring * .94, core), bleed) * X.w);
        vec2 hp = dq - vec2(-.42, -.55) * F.y;
        wetHi = max(wetHi, (1. - sst(.05, .14, length(hp))) * ring * X.w);
      } else {
        // 指尖墨渍（第 2 轮 style-02）：墨渍版——墨团外一圈洇开的淡墨（fbm 毛边）、墨色有浓淡、边缘积墨（咖啡环）
        if (dd > 9.) continue;
        vec2 dq0 = vec2(uSpotXf.y > .5 ? -dq.x : dq.x, dq.y); float ca = cos(uSpotXf.x), sa = sin(uSpotXf.x);
        dq = vec2(ca * dq0.x - sa * dq0.y, sa * dq0.x + ca * dq0.y);
        vec2 qq = dq + .08 * vec2(fbm(dq * 5. + float(i), 14u), fbm(dq * 5. + float(i) + 7.7, 15u));
        vec3 F = motifField(qq, uSpotP[i], X.x, 1.);
        float sf = max(X.z, .12);
        float body = 1. - sst(-sf, sf, F.x);
        float edge = (1. - sst(.0, .07, abs(F.x + .045))) * body;
        float dens = .72 + .28 * sst(-.3, .35, fbm(dq * 3.3 + float(i) * 2.1, 19u));
        float bleed = (1. - sst(-.06, .06, F.x - .2 - .14 * fbm(dq * 7. + float(i), 20u))) * (1. - body) * .3;
        float core = 1. - sst(0., .78 * F.y, F.z);
        inkA = max(inkA, max(max(body * (.76 + .24 * edge) * dens + edge * .12, core * .3), bleed) * X.w);
      }
    }
    vec3 coreC = c * vec3(.60, .50, .42) * mix(1., .55, sst(.5, .2, lum(c)));
    c *= 1. - .10 * innerA * fur;
    c = mix(c, coreC, coreA * fur);
    c = mix(c, RING, ringA * fur);
    wetA *= fur; wetHi *= fur;
  }
  gold = max(gold, uGoldClear);
  // ── 眼睑（眨眼；在去饱和之前，用毛色） ──
  if (uEyeB.y > .001) {
    vec2 d = vPx - uEye.xy; float cs0 = cos(uEyeB.x), sn0 = sin(uEyeB.x);
    d = vec2(cs0 * d.x + sn0 * d.y, -sn0 * d.x + cs0 * d.y) / uEye.zw;
    float er = length(d);
    if (er < 1.12) {
      float yl = -1.1 + 2.2 * uEyeB.y;
      float inside = 1. - sst(1.02, 1.1, er);
      float cover = (1. - sst(yl - .03, yl + .03, d.y)) * inside;
      c = mix(c, uLidC, cover);
      float line = (1. - sst(.0, .09, abs(d.y - yl))) * inside * sst(0., .1, uEyeB.y);
      c = mix(c, RING, line * .9);
    }
  }
  // ── 去饱和：out = mix(col, lum·#8F8982/0.55, d)·mix(1, .85, d)，眼睛里只降到一半 ──
  float dsat = uDesat * (1. - gold);
  float dsFull = dsat;
  if (uEye.z > 0. && ellR(vPx, uEye.xy, uEye.zw, uEyeB.x) < 1.05) dsat *= .5;
  if (dsat > 0.) {
    vec3 s = l2s(c);
    vec3 g = vec3(lum(s)) * vec3(.561, .537, .510) / .55;
    s = mix(s, g, dsat) * mix(1., .85, dsat);
    c = s2l(s);
  }
  c = mix(c, WET, clamp(wetA, 0., 1.) * (1. - gold));
  c = mix(c, vec3(.80, .78, .74), clamp(wetHi, 0., 1.) * .8 * (1. - gold));
  c = mix(c, INK, clamp(inkA, 0., 1.));
  // ── 代码眼（返修 style-10）：平时眼睑就压住虹膜上缘（uEyeC.x）、下沿带 3K 投影；外圈上粗下细、两端收尖；
  //    虹膜有径向纤维和上暗下亮的喷枪渐变；瞳孔边羽化 2K；高光一大一小两颗软边点 ──
  if (uEyeB.z > .5) {
    float er = ellR(vPx, uEye.xy, uEye.zw, uEyeB.x);
    vec2 dl = vPx - uEye.xy; float csE = cos(uEyeB.x), snE = sin(uEyeB.x);
    dl = vec2(csE * dl.x + snE * dl.y, -snE * dl.x + csE * dl.y) / uEye.zw;
    float rmin = min(uEye.z, uEye.w);
    if (er < 1.06) {
      vec3 iris = mix(uIris0, uIris1, sst(.35, 1., er));
      float ang = atan(dl.y, dl.x);
      float fibE = vnoise(vec2(ang * 3.82 + 11., er * 3.), 91u) * .6 + vnoise(vec2(ang * 9.5, er * 7.), 92u) * .4;
      iris *= mix(1., .9 + .2 * fibE, uEyeC.w > 0. ? 1. : 0.);
      iris *= mix(1., mix(.65, 1., sst(-.95, -.4, dl.y)), uEyeC.w > 0. ? 1. : 0.);
      float pr = ellR(vPx, uEye.xy + uPupil.yz, uEye.zw * uPupil.x, uEyeB.x);
      float pf = max(uEyeC.w, .03 * rmin) / (rmin * uPupil.x);
      iris = mix(iris, vec3(.0103, .0080, .0062), 1. - sst(1. - pf, 1. + pf * .5, pr));
      float hd = length(vPx - uHi.xy) / max(uHi.z, 1e-3);
      iris = mix(iris, vec3(1., .92, .75), (1. - sst(.55, 1.15, hd)) * uHi.w);
      float hd3 = length(vPx - uHi.xy - vec2(uHi.z * 2.1, uHi.z * 1.6)) / max(uHi.z * .4, 1e-3);
      iris = mix(iris, vec3(1., .94, .8), (1. - sst(.5, 1.2, hd3)) * uHi.w * step(.5, uEyeC.w) * .9);
      float hd2 = length(vPx - uHi2.xy) / max(uHi2.z, 1e-3);
      iris = mix(iris, uHi2C, (1. - sst(.6, 1.1, hd2)) * uHi2.w);
      // 外圈：上粗下细、两端收尖
      float rwT = (uEyeC.y > 0. ? uEyeC.y : uEyeB.w) / rmin, rwB = (uEyeC.z > 0. ? uEyeC.z : uEyeB.w) / rmin;
      float rw = mix(rwB, rwT, sst(.55, -.55, dl.y)) * mix(.55, 1., sst(.0, .5, abs(dl.y) + .25 * (1. - abs(dl.x))));
      c = mix(c, iris, 1. - sst(1. - rw * .5, 1. - rw * .3, er));
      c = mix(c, vec3(.0262, .0232, .0118), (1. - sst(rw * .55, rw * .75, abs(er - (1. - rw * .45)))) * (1. - sst(1.0, 1.04, er)));
    }
    // 眼睑：眨眼量 uEyeB.y 与常驻压住的量 uEyeC.x 取大；下沿给虹膜一道 3K 的投影
    float lidAmt = max(uEyeB.y, uEyeC.x);
    if (lidAmt > .001) {
      float er2 = length(dl);
      if (er2 < 1.12) {
        float yl = -1.1 + 2.2 * lidAmt;
        float inside = 1. - sst(1.0, 1.08, er2);
        vec3 ls = l2s(uLidC); ls = mix(ls, vec3(lum(ls)) * vec3(.561, .537, .510) / .55, dsFull) * mix(1., .85, dsFull);
        float shadowB = (1. - sst(.0, 3. * uK2 / rmin, dl.y - yl)) * step(yl, dl.y) * inside;
        c *= 1. - .35 * shadowB * step(.5, uEyeC.w + .5 * step(.001, uEyeC.x));
        c = mix(c, s2l(ls), (1. - sst(yl - .03, yl + .03, dl.y)) * inside);
        c = mix(c, RING, (1. - sst(.0, .08, abs(dl.y - yl))) * inside * sst(0., .1, lidAmt) * .9);
      }
    }
  }
  // ── 段光色、暗部混色 ──
  c *= uLight;
  if (uLineOn > .5) {
    vec2 a = uLineA.xy, b = uLineA.zw, e = uLineB.xy;
    vec2 ab = b - a, be = e - b;
    float h1 = clamp(dot(vPx - a, ab) / dot(ab, ab), 0., 1.), h2 = clamp(dot(vPx - b, be) / dot(be, be), 0., 1.);
    float d1 = length(vPx - a - ab * h1), d2 = length(vPx - b - be * h2);
    float along = d1 < d2 ? h1 * .5 : .5 + h2 * .5;
    float d = min(d1, d2);
    float ln = 1. - sst(uLineB.z * .5, uLineB.z * .5 + 1.5, d);
    c = mix(c, vec3(.042, .027, .018), ln);
    float hi = (1. - sst(.0, .12, abs(along - uLineB.w))) * step(.001, uLineB.w) * step(uLineB.w, .999);
    c = mix(c, vec3(1., .78, .45), ln * hi);
  }
  c = mix(c, uDarkC, uDarkAmt * (1. - sst(.0, .35, lum(c))));
  if (uBodyDark > 0.) c *= mix(1. - uBodyDark, 1., sst(.7, 1.1, ellR(vPx, uBodyDarkE.xy, uBodyDarkE.zw, 0.)));
  // ── 边缘光：朝光一侧、向外 uRimW 处已经透明的像素 ──
  if (uRimAmt > 0.) {
    vec2 o = uRimDir * uRimW / uTexSize * uUvRect.zw * vec2(1., -1.);
    float a1 = texture2D(map, vUv + o * .45).a, a2 = texture2D(map, vUv + o).a;
    float rim = t.a * (1. - .5 * (a1 + a2));
    c = mix(c, uRimC, clamp(rim * 1.6, 0., 1.) * uRimAmt);
  }
  // ── 光斑（受光色块：斑外压暗、斑内受光） ──
  if (uDapOn > 0.) {
    // 光斑版（第 2 轮 style-02）：软边 .25、两个尺度的叶团把环打碎；受光处提亮并染琥珀 #F3C46B、斑外略压暗偏冷；
    //   这一层画在 bloom 之后（屏幕层），所以每枚光斑外自己带一圈暖晕代替 bloom
    float L = 0., Lk = 0., Lg = 0.;
    for (int j = 0; j < 16; j++) {
      if (j >= uDapN) break;
      float bw = uBlur / max(uDapR[j].y, 1.);   // tech-15：边宽随材质内模糊变化，虚处的光斑也虚
      float e = 1. - sst(.80 - bw, 1. + bw, ellR(vPx, uDap[j].xy, uDap[j].zw, uDapR[j].x));
      vec2 qd = (vPx - uDap[j].xy) / uDapR[j].y;
      // 第 4 轮（zs-01）：落定以后读成豹斑——环的边收清（.25 → .15）、斑心只亮一层（.45 → .2），像一圈光围着一块稍暗的心
      vec2 m = motif(qd, uDapP[j], uDapR[j].z, (uDapR[j].w > .5 ? .08 : .15) + bw, .85);
      float l = mix(e, m.x + .2 * m.y, uDapM);
      float g = (1. - sst(.5, 1.9, length(qd))) * mix(e + .4, 1., uDapM);
      if (uDapR[j].w > .5) Lk = max(Lk, l); else { L = max(L, l); Lg = max(Lg, g); }
    }
    float leaf = sst(-.08, .28, fbm(vPx / 230., 41u)) * .6 + sst(-.05, .3, fbm(vPx / 75. + 3.1, 42u)) * .45;
    L *= 1. - uDapLeaf * clamp(leaf, 0., .85);
    L = clamp(max(L, Lk), 0., 1.) * uDapOn;
    vec3 lit = c * vec3(1.42, 1.22, .86) + vec3(.896, .552, .147) * .10;
    vec3 shd = c * vec3(.70, .72, .78);
    c = mix(mix(c, shd, uDapOn), lit, L);
    c += vec3(.896, .552, .147) * .07 * clamp(Lg, 0., 1.) * (1. - L) * uDapOn;
    c = mix(c, c * 1.15 + vec3(1., .80, .43) * .30, clamp(Lk, 0., 1.) * uDap7 * uDapOn);
  }
  if (uEdgeFall > 0.) { float ea = textureLod(map, vUv, uEdgeLod).a; c *= mix(1. - uEdgeFall, 1., sst(.55, .97, ea)); }
  c = mix(c, uFogC, uFogAmt);
  float a = t.a * uAlpha;
  if (uGradeOn > .5) {
    c *= uGWB; float l = lum(c); c = max(mix(vec3(l), c, uGSat), 0.);
    vec3 g = pow(c, vec3(1. / 2.2)); g = g + uGLift * max(1. - g, 0.); g -= uGToe * g * (1. - smoothstep(0., .45, g)); c = pow(max(g, 0.), vec3(2.2));
    c = oetf(c);
  }
  gl_FragColor = vec4(c, a);
}`;

function baseUniforms(tex, rect) {
  const W = tex.image.width, H = tex.image.height;
  const R = rect || [0, 0, W, H];
  const w = R[2], h = R[3];
  const v4 = n => Array.from({ length: n }, () => new THREE.Vector4());
  return {
    map: { value: tex }, uTexSize: { value: new THREE.Vector2(w, h) }, uUvRect: { value: new THREE.Vector4(R[0] / W, 1 - (R[1] + R[3]) / H, R[2] / W, R[3] / H) },
    uBendA: { value: v4(4) }, uBendB: { value: v4(4) }, uBendN: { value: 0 },
    uBreath: { value: new THREE.Vector4() }, uPad: { value: new THREE.Vector4(1.25, 0, 0, 0) },
    uAlpha: { value: 1 }, uDesat: { value: 0 }, uBlur: { value: 0 },
    uLight: { value: new THREE.Vector3(1, 1, 1) }, uDarkC: { value: new THREE.Vector3() }, uDarkAmt: { value: 0 },
    uRimC: { value: new THREE.Vector3(1, 1, 1) }, uRimAmt: { value: 0 }, uRimDir: { value: new THREE.Vector2(1, 0) }, uRimW: { value: 6 },
    uFogC: { value: new THREE.Vector3(1, 1, 1) }, uFogAmt: { value: 0 },
    uEye: { value: new THREE.Vector4() }, uEyeB: { value: new THREE.Vector4() }, uEyeC: { value: new THREE.Vector4() }, uK2: { value: 1 }, uEdgeFall: { value: 0 }, uEdgeLod: { value: 4 },
    uIris0: { value: new THREE.Vector3() }, uIris1: { value: new THREE.Vector3() }, uLidC: { value: new THREE.Vector3() },
    uPupil: { value: new THREE.Vector4(.45, 0, 0, 0) }, uHi: { value: new THREE.Vector4() }, uHi2: { value: new THREE.Vector4() }, uHi2C: { value: new THREE.Vector3(1, .8, .4) },
    uSpotN: { value: 0 }, uSpotC: { value: v4(64) }, uSpotP: { value: v4(64) }, uSpotX: { value: v4(64) },
    uTc: { value: 0 }, uGoldClear: { value: 0 }, uSpotOn: { value: 1 },
    uEx1: { value: new THREE.Vector4(-9999, -9999, 1, 1) }, uEx2: { value: new THREE.Vector4(-9999, -9999, 1, 1) }, uExT: { value: new THREE.Vector2() },
    uDapN: { value: 0 }, uDap: { value: v4(16) }, uDapR: { value: v4(16) }, uDapP: { value: v4(16) }, uDapM: { value: 0 }, uDapOn: { value: 0 }, uDapLeaf: { value: 1 }, uDap7: { value: 0 },
    uGradeOn: { value: 0 }, uGWB: { value: new THREE.Vector3(1, 1, 1) }, uGLift: { value: new THREE.Vector3() }, uGSat: { value: 1 }, uGToe: { value: 0 },
    uGlowC: { value: new THREE.Vector3(1, 1, 1) }, uGlowA: { value: 0 }, uGlowLod: { value: 3 },
    uBodyDark: { value: 0 }, uBodyDarkE: { value: new THREE.Vector4(0, 0, 1, 1) },
    uLineOn: { value: 0 }, uLineA: { value: new THREE.Vector4() }, uLineB: { value: new THREE.Vector4() },
    uSoftE: { value: new THREE.Vector4(0, 0, 0, 0) }, uSoftRef: { value: new THREE.Vector3(0, 0, 0) },
    uSpotXf: { value: new THREE.Vector2(0, 0) },
  };
}

const GEO = new THREE.PlaneGeometry(1, 1, 24, 16);
// makeSprite(tex, { order, glow, mask }) → { group, color, mask, glow, u, tex, w, h, ... }
export function makeSprite(tex, o = {}) {
  const u = baseUniforms(tex, o.rect);
  const mk = (defines, extra) => new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: u, defines, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, ...extra });
  const order = o.order ?? 10;
  const group = new THREE.Group();
  const color = new THREE.Mesh(GEO, mk({}, {}));
  color.renderOrder = order; color.frustumCulled = false; color.userData.outline = false;
  group.add(color);
  let mask = null, glow = null;
  if (o.mask !== false) {
    mask = new THREE.Mesh(GEO, mk({ MASK: '' }, { transparent: false, depthWrite: true, colorWrite: false }));
    mask.renderOrder = order - .5; mask.frustumCulled = false; mask.userData.outline = false; mask.userData.outlineOccluder = false;
    group.add(mask);
  }
  if (o.glow) {
    glow = new THREE.Mesh(GEO, mk({ GLOW: '' }, {}));
    glow.renderOrder = order - .6; glow.frustumCulled = false; glow.userData.outline = false; glow.userData.outlineOccluder = false;
    glow.position.z = -1e-4;   // tech-04：顶点里已按 uPad 扩网格，这里不再二次放大
    group.add(glow);
  }
  group.userData.outline = false;
  const S = { group, color, mask, glow, u, tex, w: u.uTexSize.value.x, h: u.uTexSize.value.y };
  if (o.overlay) { color.material.depthTest = false; if (mask) mask.visible = false; }
  return S;
}

// 设置形变：bends = [{ pivot:[x,y], center:[x,y], angle(弧度，屏幕顺时针为正), rIn, rOut }]，breath = { pivot, amount, radius }
export function setBends(S, bends = [], breath = null) {
  const u = S.u; u.uBendN.value = Math.min(4, bends.length);
  bends.slice(0, 4).forEach((b, i) => { u.uBendA.value[i].set(b.pivot[0], b.pivot[1], b.center[0], b.center[1]); u.uBendB.value[i].set(b.angle, b.rIn, b.rOut, 0); });
  if (breath) u.uBreath.value.set(breath.pivot[0], breath.pivot[1], breath.amount, breath.radius); else u.uBreath.value.set(0, 0, 0, 1);
}

// 斑点：spots = [{ x, y (贴图像素), r (贴图像素), birth (tc 秒；-1e3 = 一直在), kind: 0 环斑 / 1 实心点 / 2 湿墨斑 / 3 墨渍, seed, soft, alpha }]
export function setSpots(S, spots) {
  const u = S.u; const n = Math.min(64, spots.length); u.uSpotN.value = n;
  for (let i = 0; i < n; i++) {
    const s = spots[i], ph = motifPh(s.seed ?? (40 + i));
    u.uSpotC.value[i].set(s.x, s.y, s.r, s.birth ?? -1000);
    u.uSpotP.value[i].set(ph[0], ph[1], ph[2], ph[3]);
    u.uSpotX.value[i].set(motifK(s.seed ?? (40 + i)), s.kind ?? 0, s.soft ?? (s.kind === 2 ? 1 : .05), s.alpha ?? 1);
  }
}

// 眼睛：eye = { cx, cy, rx, ry, tilt(度), mode: 0 只眨眼 / 1 代码画虹膜, ring(贴图像素) }
export function setEye(S, e) {
  const u = S.u;
  u.uEye.value.set(e.cx, e.cy, e.rx, e.ry);
  u.uEyeB.value.set((e.tilt || 0) * Math.PI / 180, e.lid ?? 0, e.mode ?? 0, e.ring ?? 8);
  if (e.iris0) u.uIris0.value.copy(lin3(e.iris0));
  if (e.iris1) u.uIris1.value.copy(lin3(e.iris1));
  if (e.lidColor) u.uLidC.value.copy(lin3(e.lidColor));
  if (e.pupil !== undefined) u.uPupil.value.set(e.pupil, e.px ?? 0, e.py ?? 0, 0);
  if (e.hi) u.uHi.value.set(...e.hi); else u.uHi.value.set(0, 0, 1, 0);
  if (e.hi2) u.uHi2.value.set(...e.hi2); else u.uHi2.value.set(0, 0, 1, 0);
  if (e.hi2c) u.uHi2C.value.copy(lin3(e.hi2c));
  u.uEyeC.value.set(e.lidBase ?? 0, e.ringTop ?? 0, e.ringBot ?? 0, e.paint ?? 0); u.uK2.value = e.k2 ?? 1;
}
export function setExclude(S, e1, e2) {
  const u = S.u, D = Math.PI / 180;
  if (e1) u.uEx1.value.set(e1.cx, e1.cy, e1.rx, e1.ry);
  if (e2) u.uEx2.value.set(e2.cx, e2.cy, e2.rx, e2.ry);
  u.uExT.value.set((e1?.tilt || 0) * D, (e2?.tilt || 0) * D);
}

// ── 摆放 ──
// 在相机 cam 前深度 D 处，让贴图像素 (ax, ay) 落在设计像素 (sx, sy)，scale = 设计像素 / 贴图像素，angle = 绕锚点的屏幕旋转（度，顺时针为正）
const _v = new THREE.Vector3();
export function placeOnCam(S, cam, ax, ay, sx, sy, scale, D, angle = 0, flip = false) {
  const hh = D * Math.tan(cam.fov * Math.PI / 360), hw = hh * cam.aspect;   // 半高 / 半宽（世界单位）
  const wpx = S.w * scale, hpx = S.h * scale;
  // 贴图中心相对锚点的偏移（设计像素，y 向下），镜像时 x 取反
  let dx = (S.w / 2 - ax) * scale * (flip ? -1 : 1), dy = (S.h / 2 - ay) * scale;
  const a = angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const rx = ca * dx - sa * dy, ry = sa * dx + ca * dy;
  const cx = sx + rx, cy = sy + ry;
  const x = (cx / 1920 - .5) * 2 * hw, y = (.5 - cy / 1040) * 2 * hh;
  S.group.position.set(x, y, -D).applyMatrix4(cam.matrixWorld);
  cam.getWorldQuaternion(S.group.quaternion);
  S.group.rotateZ(-a);
  S.group.scale.set(wpx / 1920 * 2 * hw, hpx / 1040 * 2 * hh, 1);
  S.u.uPad.value.y = flip ? 1 : 0;
  S.pxPerTex = scale;        // 设计像素 / 贴图像素
  return S;
}
// 世界坐标锚点：贴图像素 (ax, ay) 放到世界点 P，贴图高 hWorld（世界单位），朝向相机（只绕视线旋转 angle）
export function placeWorld(S, cam, ax, ay, P, hWorld, angle = 0, flip = false) {
  const s = hWorld / S.h;
  let dx = (S.w / 2 - ax) * s * (flip ? -1 : 1), dy = (ay - S.h / 2) * s;
  const a = angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const rx = ca * dx + sa * dy, ry = -sa * dx + ca * dy;
  cam.getWorldQuaternion(S.group.quaternion);
  _v.set(rx, ry, 0).applyQuaternion(S.group.quaternion);
  S.group.position.copy(P).add(_v);
  S.group.rotateZ(-a);
  S.group.scale.set(S.w * s, S.h * s, 1);
  S.u.uPad.value.y = flip ? 1 : 0;
  // 估算屏幕比例：设计像素 / 贴图像素
  const d = _v.copy(P).applyMatrix4(cam.matrixWorldInverse).z;
  S.pxPerTex = s * (1040 / 2) / (Math.abs(d) * Math.tan(cam.fov * Math.PI / 360));
  return S;
}
// 屏幕空间正交相机（设计像素）里的摆放：用于纯 2D 镜头与屏幕层
export function placeFlat(S, ax, ay, sx, sy, scale, angle = 0, flip = false, z = 0) {
  let dx = (S.w / 2 - ax) * scale * (flip ? -1 : 1), dy = (S.h / 2 - ay) * scale;
  const a = angle * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const rx = ca * dx - sa * dy, ry = sa * dx + ca * dy;
  S.group.position.set(sx + rx, 1040 - (sy + ry), z);
  S.group.rotation.set(0, 0, -a);
  S.group.scale.set(S.w * scale, S.h * scale, 1);
  S.u.uPad.value.y = flip ? 1 : 0;
  S.pxPerTex = scale;
  return S;
}
// 把"设计像素"量换成贴图像素（材质内模糊、边缘光宽度等）
export const texPx = (S, designPx) => designPx / Math.max(S.pxPerTex || 1, 1e-6);

// 调色仿真参数（屏幕层用）：与 post.js 调色同式
export function setGradeEmu(S, G) {
  const u = S.u; if (!G) { u.uGradeOn.value = 0; return; }
  u.uGradeOn.value = 1;
  const wm = G.warmth ?? 0; const wb = new THREE.Vector3(1 + .10 * wm, 1 + .012 * wm, 1 - .15 * wm);
  wb.divideScalar(wb.x * .2126 + wb.y * .7152 + wb.z * .0722);
  u.uGWB.value.copy(wb).multiplyScalar(G.exposure ?? 1); u.uGSat.value = G.saturation ?? 1;
  const L = G.lift ?? 0; Array.isArray(L) ? u.uGLift.value.set(...L) : u.uGLift.value.setScalar(L); u.uGToe.value = G.toe ?? 0;
}
