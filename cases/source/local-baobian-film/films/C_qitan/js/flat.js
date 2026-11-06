// flat.js — 纯 2D 镜头（正交相机，设计像素）：S4a 雨洗指尖、S4b 墨滴成斑、S5b 长卷化开横移、S5c 豹眼
// 所有量都是 f / t / tc 的纯函数；粒子、墨点按出生时刻直接算位置，不跨帧累积。
import * as THREE from 'three';
import { GLSL_COMMON, DEG, clamp, lerp, seg, ss, ss5, eo, eio, ei2, hashi, lin3, motifPh, motifK, tcOf, P_MOTIF, EYE_E, STAR_H } from './util.js';
import { makeSprite, setBends, setSpots, setEye, setExclude, placeFlat, texPx } from './sprite.js';
import { orthoCam } from './fx.js';

const QUAD = new THREE.PlaneGeometry(1, 1);
const FSV = /* glsl */`varying vec2 vUv; varying vec2 vP; void main(){ vUv = uv; vP = vec2(uv.x * 1920., (1. - uv.y) * 1040.); gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy * vec2(1920., 1040.) + vec2(960., 520.), 0., 1.); }`;
const fsMesh = (fs, uniforms, order = 0, o = {}) => { const m = new THREE.Mesh(QUAD, new THREE.ShaderMaterial({ vertexShader: FSV, fragmentShader: fs, uniforms, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, ...o })); m.renderOrder = order; m.frustumCulled = false; return m; };

// 湿毛毡毛面（S4a 下缘、S4b 全屏）：喷枪渐变 + 原生分辨率纤维噪声（按 K 缩放，4K 不变样）
const FUR = /* glsl */`
uniform float uK;
vec3 furCol(vec2 p, float zoom){
  // p：设计像素。返修 style-09：读成"湿毛毡"——毛团尺度（60–120K）的明暗、成缕的湿暗缝、喷枪大渐变；细纤维只留 α .05
  vec3 c0 = vec3(.332, .311, .275), c1 = vec3(.184, .171, .156), c2 = vec3(.107, .099, .089);   // #9C978E #77736E #5C5955（线性）
  float g = clamp((p.x * .35 + p.y) / 1300., 0., 1.) * .8;
  vec3 c = mix(c0, c1, sst(0., .6, g)); c = mix(c, c2, sst(.55, 1., g));
  float a = -20. * .0174533; mat2 R = mat2(cos(a), sin(a), -sin(a), cos(a));
  vec2 q = R * (p / zoom);
  float fib = 0., amp = .5;
  for (int i = 0; i < 3; i++) { fib += amp * vnoise(vec2(q.x / 9., q.y / 1.2) * pow(1.9, float(i)) + float(i) * 17., 71u + uint(i)); amp *= .5; }
  fib = fib / .875 - .5;
  float clump = fbm(vec2(q.x / 190., q.y / 95.), 74u);                       // 毛团（沿毛流拉长 2 倍）
  float lock = fbm(vec2(q.x / 320., q.y / 70.), 77u);
  float sl = abs(fract(q.y / 26. + 2.6 * lock + .8 * fbm(vec2(q.x / 140., q.y / 40.), 78u)) - .5);   // 湿后成缕：每缕宽约 25K
  float seam = (1. - sst(.03, .12, sl)) * sst(.42, .62, vnoise(vec2(q.x / 170., q.y / 45.), 79u));      // 缝断断续续，不成平行线
  c *= 1. + .10 * fib + .16 * clump - .10 * seam;
  c *= 1. + .05 * fbm(p / 420. / zoom, 72u);                                 // 喷枪大渐变的起伏
  return c;
}`;

export function buildFlat(ctx) {
  const { tex, man, world } = ctx;
  const scene = new THREE.Scene(), cam = orthoCam();
  const M = id => man.find(m => m.id === id);
  const mk = (t, o) => { const S = makeSprite(t, { mask: false, overlay: false, ...o }); scene.add(S.group); S.color.material.depthTest = false; return S; };

  // ═════════ S4a ═════════
  const s4aBgU = { uT: { value: 0 }, uR: { value: 0 }, uK: { value: 1 }, uBack: { value: 0 } };
  const s4aBg = fsMesh(/* glsl */`${GLSL_COMMON}${FUR}
    uniform float uT, uR, uBack; varying vec2 vUv; varying vec2 vP;
    void main(){
      vec2 p = vP;
      vec3 fogg = mix(vec3(.468, .451, .413), vec3(.604, .589, .539), sst(0., 1040., p.y));   // #B6B3AA → #CFCAC1
      // 下缘的豹背（返修 story-04 / main-03）：看得清的肩胛和脊背弧线（虚约 6K），带湿墨斑和圆头毛尖剪影，占画面下方约 30%
      float ye = 770. - 72. * exp(-pow((p.x - 520.) / 330., 2.)) - 46. * exp(-pow((p.x - 1560.) / 380., 2.)) + 14. * sin(p.x / 150. + 1.3);
      // 第 2 轮（v1-02）：毛尖和 S4b 身体边缘同一种画法——大小 8–20K、间距不匀（±40%）、尖头、3–4K 羽化；两层错开相位，部分重叠成缕
      float tipH = 0.;
      for (int L = 0; L < 2; L++) {
        float fl = float(L);
        float tu = (p.x + 14. * sin(p.x / 37. + fl * 2.) + 7. * sin(p.x / 91. + fl)) / (24. + 6. * fl) + 1.6 * fbm(vec2(p.x / 40. + fl * 9., 1.), 75u) + fl * .5;
        float tt = fract(tu), tid = floor(tu) + fl * 101.;
        float tipLen = (6. + 9. * h11(tid, 76u)) * (.75 + .5 * h11(tid + 31., 77u)) * (1. - .3 * fl);
        tipH = max(tipH, pow(max(sin(3.1416 * tt), 0.), 1.15) * tipLen);
      }
      float edge = p.y - (ye - tipH) - 3. * fbm(vec2(p.x / 9., 3.), 74u);
      // 右端探出一只耳朵（头在画框右外），左端一截尾巴带墨色笔锋往上卷——一眼认得出是那只小豹的背
      // 第 3 轮（v2-07）：耳朵不再是平涂的几何三角——圆钝的耳尖、两边略往里凹（宽度按 t^.75 往上收）、往右后倾；
      //   耳根在背线以下 20K，下半截藏在背的弧线后面（背的轮廓线从耳根前面过）；耳廓一圈和背上同一种尖头毛尖（小一号）；
      //   耳内浅一档的灰，耳廓往边上渐暗（喷枪体积）
      vec2 eq = p - vec2(1755., ye + 20.);
      float eh = -eq.y, eHe = 112., ert = 24.;
      float et = clamp(eh / (eHe - ert), 0., 1.);
      float elean = .2 * min(eh, eHe - ert);
      float ehw = mix(78., ert, pow(et, .8));
      float earD0 = abs(eq.x - elean) - ehw;
      if (eh > eHe - ert) earD0 = length(vec2(eq.x - .2 * (eHe - ert), eh - (eHe - ert))) - ert;
      earD0 = max(earD0, -eh - 30.);
      float eu = (eh + 7. * sin(eq.x / 23.)) / 17. + 1.1 * fbm(vec2(eq.x / 31., eh / 29.), 79u);
      float eTip = pow(max(sin(3.1416 * fract(eu)), 0.), 1.6) * (1.6 + 2. * h11(floor(eu), 80u)) * sst(14., 40., eh);
      float earD = earD0 - eTip;
      float ear = 1. - sst(-4.5, 4.5, earD);
      float earIn = (1. - sst(-8., 8., earD0 + 22.)) * sst(12., 46., eh);
      float earVol = sst(-26., 0., earD0);
      // 尾巴：从背线左端往上卷的一条二次曲线（折线近似求距离），根粗梢细，最后 35% 是墨色笔锋
      vec2 T0 = vec2(80., 805.), T1 = vec2(18., 610.), T2 = vec2(150., 548.);
      float tailBand = 1e5, tailS = 0.;
      vec2 prevP = T0;
      for (int k = 1; k <= 20; k++) {
        float u = float(k) / 20.; vec2 Pk = mix(mix(T0, T1, u), mix(T1, T2, u), u);
        vec2 ab = Pk - prevP; float h = clamp(dot(p - prevP, ab) / dot(ab, ab), 0., 1.);
        float uu = (float(k) - 1. + h) / 20.;
        float dd = length(p - prevP - ab * h) - mix(30., 15., uu);
        if (dd < tailBand) { tailBand = dd; tailS = uu; }
        prevP = Pk;
      }
      float tail = 1. - sst(-6., 6., tailBand);
      float tipInk = sst(.6, .72, tailS);
      float back = max(max(sst(-6., 6., edge), ear), tail);   // 豹背整体虚约 6K（毛尖、耳、尾的边都按 6K 羽化）
      vec3 fur = furCol(p * .8, 1.25) * mix(1.06, .66, sst(0., 300., edge));
      fur = mix(fur, fur * vec3(1.25, 1.18, 1.12), earIn * .8);
      fur = mix(fur, fur * vec3(1.12, 1.08, 1.05), ear * (1. - sst(-6., 6., edge)) * .7);   // 耳朵整体比背亮一点点（受光）
      fur *= 1. - .12 * earVol * ear * (1. - sst(-6., 6., edge));             // 耳廓往边上渐暗
      fur *= 1. - .22 * (1. - sst(0., 6., abs(edge + 2.))) * ear;             // 背的轮廓从耳根前面过（耳朵在背后面）
      fur = mix(fur, vec3(.0103, .0091, .0085), tail * tipInk * .85);
      for (int i = 0; i < 3; i++) {
        vec3 S = i == 0 ? vec3(430., 905., 62.) : i == 1 ? vec3(985., 965., 56.) : vec3(1455., 885., 66.);
        vec2 q = (p - S.xy) / S.z; q *= 1. + .22 * fbm(q * 1.2 + float(i) * 3., 74u);
        vec3 F = motifField(q, vec4(.9 + float(i), 1.7 * float(i) + .4, 3.3, 1.1 + float(i)), 4. + float(i), .55);
        float ring = 1. - sst(-.22, .18, F.x - .12), bleed = (1. - sst(-.05, .48, F.x - .05)) * .3;
        fur = mix(fur, vec3(.0130, .0116, .0110), max(ring * .8, bleed));
      }
      fur *= 1. - .18 * (1. - sst(0., 10., edge)) * back * max(sst(-12., -4., edge), tail * (1. - ear));   // 边缘一圈略暗（喷枪体积）；耳朵另算
      vec3 c = mix(fogg, fur, back * uBack);
      gl_FragColor = vec4(c, 1.);
    }`, s4aBgU, 0);
  scene.add(s4aBg);
  // 雾墙（与 S3d 眼孔外的雾同一个函数、同一组参数）：压在手上面，从画面中心散开
  const s4aFog = fsMesh(/* glsl */`${GLSL_COMMON}
    uniform float uT, uR; varying vec2 vUv; varying vec2 vP;
    void main(){
      vec2 p = vP;
      vec3 wall = vec3(.815, .761, .693) * (1. + .05 * fbm(p / 180. + vec2(uT * .06, 0.), 91u));   // #E9E2D8
      float d = length(p - vec2(960., 520.)) + 40. * fbm(p / 90., 92u) * 2.;
      float open = sst(uR - 20., uR + 20., d);
      gl_FragColor = vec4(wall, open);
    }`, s4aBgU, 40);
  scene.add(s4aFog);
  const A13 = M('A13')['锚点'], A14 = M('A14')['锚点'];
  const handOpen = mk(tex.handOpen, { order: 10 });
  const handFist = mk(tex.handFist, { order: 10 });
  // 墨层：指尖下的墨滴、细流、墨丝（画在手上面）
  const inkU = { uTip: { value: new THREE.Vector2() }, uDrop: { value: new THREE.Vector4() }, uStream: { value: new THREE.Vector4() }, uThread: { value: 0 }, uDir: { value: new THREE.Vector2(1, 0) }, uSplash: { value: new THREE.Vector4() } };
  const inkLayer = fsMesh(/* glsl */`${GLSL_COMMON}
    uniform vec2 uTip, uDir; uniform vec4 uDrop, uStream, uSplash; uniform float uThread; varying vec2 vUv; varying vec2 vP;
    void main(){
      vec2 p = vP; float a = 0.; vec3 col = vec3(.0232, .0203, .0185);
      // 墨滴：中心 (uDrop.xy)，半径 uDrop.z，纵向拉长 uDrop.w
      if (uDrop.z > 0.) {
        vec2 d = (p - uDrop.xy) / vec2(uDrop.z, uDrop.z * uDrop.w);
        float r = length(d);
        float drop = 1. - sst(.9, 1.05, r);
        a = max(a, drop);
        float hi = (1. - sst(.0, .35, length(d - vec2(-.35, -.4)))) * drop;
        col = mix(col, vec3(.88, .86, .82), hi * .8);
      }
      // 墨丝：从指尖到墨滴
      if (uThread > 0.) { vec2 ab = uDrop.xy - uTip; float h = clamp(dot(p - uTip, ab) / dot(ab, ab), 0., 1.); float dd = length(p - uTip - ab * h); a = max(a, (1. - sst(.6, 1.6, dd)) * uThread); }
      // 三条灰细流：沿手指方向，从指根流向指尖（头部以 60K/s 前进）
      if (uStream.w > 0.) {
        vec2 n = vec2(-uDir.y, uDir.x);
        for (int i = 0; i < 3; i++) {
          float off = (float(i) - 1.) * 9.;
          vec2 q = p - uTip;
          float along = -dot(q, uDir);   // 0 在指尖，往指根为正
          float lat = dot(q, n) - off - 3. * sin(along / 23. + float(i) * 2.);
          float head = uStream.x;        // 已流到的位置（离指尖的距离）
          float on = sst(head - 6., head + 6., along) * (1. - sst(150., 190., along));
          a = max(a, (1. - sst(.9, 2.2, abs(lat))) * on * .5 * uStream.w);
        }
      }
      // 雨点打在指尖：5 粒水花（亮）
      if (uSplash.w > 0.) {
        for (int j = 0; j < 5; j++) {
          float an = 3.6 + float(j) * .55; vec2 c = uTip + vec2(cos(an), sin(an)) * uSplash.x;
          float dd = length(p - c);
          float s = (1. - sst(1., 2.6, dd)) * uSplash.w;
          if (s > a) { a = s * .7; col = vec3(.86, .85, .83); }
        }
      }
      gl_FragColor = vec4(col, a);
    }`, inkU, 20);
  scene.add(inkLayer);

  // ═════════ S4b ═════════
  const R0 = 150;
  const s4bU = { uK: { value: 1 }, uT: { value: 0 }, uZoom: { value: 1 }, uC: { value: new THREE.Vector2(...P_MOTIF) },
    uDrop: { value: new THREE.Vector4() }, uSpl: { value: new THREE.Vector4() }, uRip: { value: new THREE.Vector4() },
    uInk: { value: new THREE.Vector4() },   // R（设计像素）, soft, gapK, 斑心退空量
    uInk2: { value: new THREE.Vector4() },  // 金色回流（斑心、2.2R0 内毛色翻金）, 指形边强度, 墨量, _
    uPh: { value: new THREE.Vector4(...motifPh(7)) }, uOld: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) } };
  const s4b = fsMesh(/* glsl */`${GLSL_COMMON}${FUR}
    uniform float uT, uZoom; uniform vec2 uC; uniform vec4 uDrop, uSpl, uRip, uInk, uInk2, uPh; uniform vec4 uOld[4];
    varying vec2 vUv; varying vec2 vP;
    // 收紧（返修 story-05）：同一个母题，但断口一段一段张开（每段错开约 2 帧），刚断开时断口里留一丝细墨
    vec4 motifSeq(vec2 q, vec4 ph, float k, float gp){
      float th = (ph.z - 3.1416) * .25, cs = cos(th), sn = sin(th);
      vec2 p = vec2(cs * q.x + sn * q.y, -sn * q.x + cs * q.y);
      p.x /= 1.2 + .3 * mfr(ph.w * .159);
      float r = length(p), a = atan(p.y, p.x), rho = mRho(a, ph);
      float sd = 1e9, thr = 0.;
      for (int i = 0; i < 6; i++) {
        float fi = float(i); if (fi >= k) break;
        float h1 = mh(fi, ph.x), h2 = mh(fi + 7., ph.y), h3 = mh(fi + 13., ph.z);
        float gk = clamp(gp * 1.7 - fi * .175, 0., 1.);
        float c = ph.w + (fi + .5 + .3 * (h1 - .5)) * 6.2832 / k;
        float hs = 3.1416 / k * (1. - mix(.10, .45, h2) * gk) + (1. - gk) * .18;
        float dl = a - c; dl -= 6.2832 * floor((dl + 3.1416) / 6.2832);
        float w = .34 * (1. + .5 * (2. * h3 - 1.)) * (1. + .2 * sin(3. * a + ph.w));
        float d, u;
        if (abs(dl) <= hs) { d = abs(r - rho); u = dl / hs; }
        else { float e = c + sign(dl) * hs; float re = mRho(e, ph); d = length(p - re * vec2(cos(e), sin(e))); u = sign(dl);
          thr = max(thr, (1. - sst(.012, .03, abs(r - rho))) * (1. - sst(.2, .55, gk)) * step(.02, gk) * (1. - sst(.0, .6, abs(abs(dl) - hs) * 3.))); }
        sd = min(sd, d - .5 * w * (1. - .4 * u * u));
      }
      return vec4(sd, rho, r, thr);
    }
    void main(){
      vec2 p = uC + (vP - uC) / uZoom;          // 2.5D：以母题点为中心放大
      vec3 c = furCol(p, 1.);
      // 身体边缘：从 (1380,1040) 弯到 (1920,700)，外面是雾。返修 tech-14 / style-09：成缕的圆头毛尖（每 15–25K 一个），外缘 4K 羽化，没有锯齿
      vec2 ed = (p - vec2(2050., 1260.)) / vec2(720., 560.);
      float edgeD = 1. - length(ed);
      float an = atan(p.y - 1260., p.x - 2050.);
      float tu = (an * 640. + 14. * sin(an * 37.) + 7. * sin(an * 91.)) / 20. + 1.6 * fbm(vec2(an * 9., 1.), 75u);
      float tt = fract(tu), tid = floor(tu);
      float tipLen = (.006 + .016 * h11(tid, 76u)) * (.7 + .6 * h11(tid + 31., 77u));
      float tip = pow(max(sin(3.1416 * tt), 0.), .75) * tipLen;
      float furEdge = edgeD - tip - .012 * fbm(vec2(an * 22., 2.), 74u);   // >0 在雾里；毛尖从身体伸进雾，成缕、大小不一
      c *= mix(1., .74, sst(-.30, 0., edgeD));
      vec3 fogc = vec3(.604, .589, .539);
      // 一角耳尖（返修 main-03 / story-04）：右下角从身体轮廓里探出一只圆头三角耳，读得出是豹的头背
      vec2 A = vec2(1690., 880.), B = vec2(1850., 760.), Cc = vec2(1905., 930.);
      vec2 e0 = B - A, e1 = Cc - B, e2 = A - Cc, v0 = p - A, v1 = p - B, v2 = p - Cc;
      vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0., 1.), pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0., 1.), pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0., 1.);
      float sgn = sign(e0.x * e2.y - e0.y * e2.x);
      vec2 dd = min(min(vec2(dot(pq0, pq0), sgn * (v0.x * e0.y - v0.y * e0.x)), vec2(dot(pq1, pq1), sgn * (v1.x * e1.y - v1.y * e1.x))), vec2(dot(pq2, pq2), sgn * (v2.x * e2.y - v2.y * e2.x)));
      float tri = -sqrt(dd.x) * sign(dd.y) - 14.;
      float ear = 0.;   // 耳尖在 2.5D 推近后会脱离身体轮廓，去掉
      float earIn = 0.;
      float body = max(1. - sst(-.003, .003, furEdge), ear);
      c = mix(fogc, c, body);
      c = mix(c, c * vec3(1.22, 1.08, 1.05), earIn * .75);
      c = mix(c, vec3(.0232, .0152, .0092), (1. - sst(.0, .0045, abs(furEdge))) * .55 * (1. - ear));   // 深褐描线，随毛尖起伏
      // 4 个旧湿墨斑（返修 story-04：α .3 → .5，画法同灰态湿墨斑：不规则断环 + 洇边）
      for (int i = 0; i < 4; i++) {
        vec2 q = (p - uOld[i].xy) / uOld[i].z;
        q *= 1. + .22 * fbm(q * 1.2 + float(i) * 5., 74u);
        vec3 F = motifField(q, vec4(1.1 + float(i), 2.3 * float(i), 4.4, .7 + float(i)), 4. + mod(float(i), 2.), .55);
        float ring = 1. - sst(-.22, .18, F.x - .12);
        float bleed = (1. - sst(-.05, .48, F.x - .05)) * .3;
        c = mix(c, vec3(.0130, .0116, .0110), max(ring * .5, bleed * .5) * body);
      }
      // 40 颗静止雨珠高光（带 1K 暗下沿）
      for (int i = 0; i < 40; i++) {
        vec2 bc = vec2(h21(ivec2(i, 1), 75u) * 1920., h21(ivec2(i, 2), 75u) * 1040.);
        float br = 2.4 + 2.4 * h21(ivec2(i, 3), 75u);
        float d = length((p - bc) / vec2(1., 1.2));
        c = mix(c, c * .55, (1. - sst(br - .3, br + .8, length(p - bc - vec2(0., 1.2)))) * .55 * body);
        c = mix(c, c * 1.35 + .03, (1. - sst(br * .6, br, d)) * .6 * body);
        c = mix(c, vec3(.88, .86, .83), (1. - sst(.0, br * .45, length(p - bc + vec2(.6, .8)))) * .8 * body);
      }
      // ── 墨 ──
      float R = uInk.x;
      if (R > 0.) {
        vec2 q = (p - uC) / R;
        float r = length(q), an = atan(q.y, q.x);
        // 指形墨边：沿毛流方向拉长 2.5 倍
        float fa = -20. * .0174533; vec2 qf = mat2(cos(fa), sin(fa), -sin(fa), cos(fa)) * q; qf.x /= 2.5;
        // 返修 story-05：角频率提高一档、低频振幅减半——晕开接近圆形，边上是毛刺状的指形
        float fingers = uInk2.y * (.09 * 2. * fbm(vec2(an * 6. / 6.2832 * 8., r * 3.) + 3., 76u) + .1 * 2. * fbm(qf * 3.5, 77u));
        vec4 FS = motifSeq(q * (1. + fingers), uPh, 5., uInk.z);
        // 第 2 轮（style-02）：收紧成斑以后，墨团边缘带沿毛流的细毛刺、墨色有浓淡（不再是光滑等宽的几何豆子）
        FS.x += uInk.z * (.13 * fbm(q * 3.4, 16u) + .06 * fbm(vec2(qf.x * 14., qf.y * 5.), 17u));
        float sfI = max(uInk.y, .015);
        vec2 m = vec2(1. - sst(-sfI, sfI, FS.x), 1. - sst(0., .78 * FS.y, FS.z));
        float soft = uInk.y;
        // 晕开的墨团用和母题同一个不规则轮廓（不再是正圆），这样"晕开 → 收紧 → 断开"是同一个形连续地变
        float outer = 1. - sst(-soft * .45, soft * .45, FS.z - FS.y - .17);
        float innerHole = 1. - sst(FS.y - .36, FS.y - .13, FS.z);
        float rr = FS.z / max(FS.y, .3);
        float blotA = outer * mix(.5, .82, sst(.35, .98, rr));                          // 心淡边浓：咖啡环
        blotA *= 1. - innerHole * uInk2.w * .92;                                          // 收紧：心先退空
        blotA = max(blotA, outer * (1. - sst(.0, .08, abs(FS.z - FS.y - .1))) * .85 * uInk2.w);   // 环边先变深
        float inkA = mix(blotA, m.x * .96, uInk2.w);   // f410–f416 交给母题环（此时还没断口），之后断口按段张开
        float fa2 = -20. * .0174533; vec2 qq = mat2(cos(fa2), sin(fa2), -sin(fa2), cos(fa2)) * (p / uZoom);
        float fibr = vnoise(vec2(qq.x / 9., qq.y / 1.4), 79u) * .6 + vnoise(vec2(qq.x / 4., qq.y / .8), 80u) * .4;
        inkA *= uInk2.z * mix(.82, 1.02, fibr) * mix(1., .8 + .2 * sst(-.25, .3, fbm(q * 2.6, 18u)), uInk.z);
        inkA = max(inkA, (1. - sst(.0, .17, FS.x)) * (1. - m.x) * .3 * uInk.z * uInk2.z);   // 环外一圈毛尖般的淡墨
        float wetRim = (1. - sst(.0, .05, abs(FS.z - FS.y - .17))) * outer * (1. - uInk.z) * .22;
        inkA = clamp(inkA + wetRim + FS.w * .75, 0., .96);
        // 金色从斑心回来；2.2R0 内的毛翻金
        vec3 ring = vec3(.0232, .0152, .0092), coreGrey = vec3(.107, .099, .089), coreGold = vec3(.254, .111, .023);
        float goldM = uInk2.x;
        vec3 inkC = mix(vec3(.0232, .0203, .0185), ring, uInk.z);
        float coreMask = m.y * (1. - m.x) * uInk.z;
        vec3 coreC = mix(coreGrey, coreGold, goldM);
        float goldFur = goldM * (1. - sst(1.2, 2.2, r));
        vec3 goldfur = mix(vec3(.47, .27, .08), vec3(.75, .48, .14), sst(-.5, .5, fbm(p / 60., 78u))) * (.75 + .5 * lum(c) / .3);
        c = mix(c, goldfur, goldFur * .75);
        c = mix(c, coreC, coreMask * uInk.w * .9);
        c = mix(c, inkC, clamp(inkA, 0., 1.) * (1. - coreMask * uInk.w * .9));
      }
      // 波纹
      if (uRip.w > 0.) { float d = abs(length(p - uC) - uRip.z); c = mix(c, c * 1.25 + .02, (1. - sst(1.5, 5., d)) * uRip.w); }
      // 墨滴下落 + 水花
      if (uDrop.z > 0.) { vec2 d = (p - uDrop.xy) / vec2(uDrop.z, uDrop.z * 1.3); float r = length(d); float drop = 1. - sst(.92, 1.05, r); vec3 dc = vec3(.0232, .0203, .0185); float hi = 1. - sst(0., .3, length(d - vec2(-.38, -.45))); dc = mix(dc, vec3(.884, .862, .81), hi * .9); c = mix(c, dc, drop); }
      if (uSpl.w > 0.) { for (int j = 0; j < 6; j++) { float an = float(j) * 1.047 + .4; vec2 sc = uC + vec2(cos(an), sin(an) * .55) * uSpl.x; float dd = length(p - sc); c = mix(c, vec3(.0232, .0203, .0185), (1. - sst(2., 4.5, dd)) * uSpl.w); } }
      // 左下：一撮虚掉的前景毛尖
      float tuft = (1. - sst(.0, 1., length((vP - vec2(140., 1080.)) / vec2(420., 240.)))) ;
      c = mix(c, vec3(.06, .057, .052), tuft * .75);
      gl_FragColor = vec4(c, 1.);
    }`, s4bU, 0, { transparent: false });
  scene.add(s4b);

  // ═════════ S5b / S5c ═════════
  // 返修 v1-01（第 2 轮）：湿边、金线断续、边下积色都挂在 A20 真实的对角边曲线上（manifest 里逐 16px 量好的 y，不再用直线 280 + 360x/2172）
  const DIAG = M('A20')['锚点']['对角边曲线_y（x=0,16,32,…，每 16px 一个，共 140 个）'];
  // 第 4 轮（qa2-01）：uComp = 化开期间长卷一侧的曝光 / 白平衡补偿，uWComp = 世界一侧的补偿（main.js 算好传进来；平时都是 1）
  const scrollU = { map: { value: tex.scroll }, uOff: { value: 0 }, uScale: { value: 1.436 }, uBlur: { value: 0 }, uDis: { value: new THREE.Vector4(860, 440, 0, 0) }, tWorld: { value: null }, uWorldOn: { value: 0 }, uFar: { value: 0 }, uNear: { value: 0 }, uT: { value: 0 }, uK: { value: 1 }, uDiag: { value: DIAG },
    uComp: { value: new THREE.Vector3(1, 1, 1) }, uWComp: { value: new THREE.Vector3(1, 1, 1) } };
  const scroll = fsMesh(/* glsl */`${GLSL_COMMON}
    uniform sampler2D map, tWorld; uniform float uOff, uScale, uBlur, uWorldOn, uFar, uNear, uT, uK; uniform vec4 uDis; uniform vec3 uComp, uWComp;
    uniform float uDiag[140];
    varying vec2 vUv; varying vec2 vP;
    // 返修 style-16：长卷下半的青绿对角原来是一条直边——沿对角边做一层湿边：两个尺度的 fbm 起伏（20K / 6K），边下积色 1.5K、深一档；
    //   金线跟着湿边走，并且断续（只留 60–70% 的长度）
    float diagY(float x){ float u = clamp(x / 16., 0., 138.999); int i = int(u); return mix(uDiag[i], uDiag[i + 1], u - float(i)); }
    vec3 scrollAt(vec2 p, float lod){
      vec2 tp = vec2((p.x + uOff) / uScale, p.y / uScale);
      float dy = tp.y - diagY(tp.x);
      float wv = (20. * fbm(vec2(tp.x / 260., 3.1), 85u) * 2. + 6. * fbm(vec2(tp.x / 70., 7.7), 86u) * 2.) / uScale;
      float band = 1. - sst(30., 60., abs(dy));
      vec2 tq = vec2(tp.x, tp.y - wv * band);
      vec2 uv = vec2(tq.x / 2172., 1. - tq.y / 724.); uv.x = clamp(uv.x, 0.001, .999);
      vec3 c = textureLod(map, uv, lod).rgb;
      float dq = tq.y - diagY(tq.x);
      // 金线断续：用下方的水色盖掉 30–40%
      float goldness = sst(.08, .2, c.r - c.b) * (1. - sst(2., 9., abs(dq)));
      float keep = sst(-.12, .12, fbm(vec2(tp.x / 110., 1.3), 87u) + .12);
      vec3 below = textureLod(map, vec2(uv.x, 1. - (tq.y + 12.) / 724.), lod).rgb;
      c = mix(c, below, goldness * (1. - keep));
      // 湿边积色：边下 1.5K 一道深一档的边
      c *= 1. - .16 * (1. - sst(0., 1.5 / uScale * 1.4, abs(dq - 3.))) * band;
      return c;
    }
    void main(){
      vec2 p = vP;
      float lod = uBlur > 0. ? log2(max(uBlur / 1.5, 1.)) : 0.;
      vec3 c = vec3(0.);
      if (uBlur > 0.) { for (int i = 0; i < 9; i++) { float an = float(i) * .698; vec2 o = i == 0 ? vec2(0.) : vec2(cos(an), sin(an)) * uBlur * .6; c += scrollAt(p + o, lod); } c /= 9.; }
      else c = scrollAt(p, 0.);
      // 远雾（×0.6 视差）、近雾丝（×1.6）
      float far = sst(.1, .6, fbm(vec2((p.x + uFar) / 420., p.y / 160.), 81u) + .3);
      c = mix(c, vec3(.86, .92, .91), far * .22 * (1. - sst(300., 900., p.y)));
      float nearm = sst(.15, .5, fbm(vec2((p.x + uNear) / 260., p.y / 70.), 82u));
      c = mix(c, vec3(.93, .95, .94), nearm * .28 * sst(500., 1040., p.y));
      c *= uComp;
      // 化开：水彩晕开遮罩，从小豹身边向外洇（遮罩内长卷、外面是 3D 世界）
      if (uWorldOn > .5) {
        vec3 w = texture2D(tWorld, vUv).rgb; w = mix(w / 12.92, pow((w + .055) / 1.055, vec3(2.4)), step(.04045, w)); w *= uWComp;
        float d = length((p - uDis.xy) / vec2(1920., 1040.)) * 1.4;
        float wob = .18 * fbm(p / 1920. * 6. * vec2(1.846, 1.), 83u) * 2. + .05 * fbm(p / 1920. * 22. * vec2(1.846, 1.), 84u) * 2.;
        float mk = sst(-.06, .06, uDis.z - d + wob);
        float edge = (1. - sst(.0, .06, abs(uDis.z - d + wob))) * (1. - mk);
        c = mix(w, c, mk);
        c = mix(c, c * .78, edge * .5 * uDis.w);
      }
      gl_FragColor = vec4(c, 1.);
    }`, scrollU, 0, { transparent: false });
  scene.add(scroll);
  // 前景浮岛卡（f597–f612），取 A20 最大浮岛那一块
  const islandU = { map: { value: tex.scroll }, rect: { value: new THREE.Vector4(413 / 2172, 1 - 415 / 724, (765 - 413) / 2172, (415 - 160) / 724) }, uA: { value: 0 }, uBlur: { value: 0 }, uComp: scrollU.uComp };
  const island = new THREE.Mesh(QUAD, new THREE.ShaderMaterial({ vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: /* glsl */`${GLSL_COMMON} uniform sampler2D map; uniform vec4 rect; uniform float uA, uBlur; uniform vec3 uComp; varying vec2 vUv;
      void main(){ vec3 c = vec3(0.); float lod = 2.5; for (int i = 0; i < 9; i++) { float an = float(i) * .9; vec2 o = i == 0 ? vec2(0.) : vec2(cos(an), sin(an)) * .006; o.x += (float(i) / 8. - .5) * uBlur; c += textureLod(map, rect.xy + (vUv + o) * rect.zw, lod).rgb; } c /= 9.;
        float lumv = lum(c); float m = (1. - sst(.55, .75, lumv)) * sst(0., .15, vUv.x) * sst(0., .15, 1. - vUv.x) * sst(0., .2, vUv.y) * sst(0., .1, 1. - vUv.y);
        gl_FragColor = vec4(c * .9 * uComp, m * uA); }`, uniforms: islandU, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  island.renderOrder = 30; island.frustumCulled = false; scene.add(island);
  const glide = mk(tex.leoGlide, { order: 15, glow: true });
  const headG = mk(tex.leoHead, { order: 15, glow: true });
  // 长卷上的墨点（每 2 帧从尾根吐一颗；存成长卷坐标）
  const DOTN = 40;
  const dotU = { uD: { value: Array.from({ length: DOTN }, () => new THREE.Vector4()) }, uE: { value: Array.from({ length: DOTN }, () => new THREE.Vector4()) }, uN: { value: 0 }, uComp: scrollU.uComp };
  const dotsLayer = fsMesh(/* glsl */`${GLSL_COMMON}
    uniform vec4 uD[${DOTN}]; uniform vec4 uE[${DOTN}]; uniform int uN; uniform vec3 uComp; varying vec2 vUv; varying vec2 vP;
    void main(){
      float a = 0.; vec3 col = vec3(0.);
      for (int i = 0; i < ${DOTN}; i++) {
        if (i >= uN) break;
        vec4 D = uD[i], E = uE[i];
        vec2 q = (vP - D.xy) / D.z;
        if (dot(q, q) > 6.5) continue;
        // 墨点（返修 style-13 / story-11 / tech-13）：深墨断环（断口透明）+ 不透明金赭斑心；越旧越淡、越偏青
        vec4 ph = vec4(E.x, E.y, E.z, E.x * 1.7 + 1.);
        vec2 qn = q / (1. + .3 * E.w);
        vec3 F = motifField(qn, ph, 4. + floor(mfr(E.x * .37) * 3.), 1.);
        // 第 2 轮（style-02）：墨点 = 墨画的小豹斑——断环边缘洇开带毛刺、墨色有浓淡，斑心只是一层半透明的赭色淡彩（不再是实心的饼）
        float sdn = F.x + .07 * fbm(qn * 4.2 + E.x, 16u) + .03 * fbm(qn * 12. + E.y, 17u);
        float sf = .05 + .08 * E.w;
        float ring = (1. - sst(-sf, sf, sdn)) * (.75 + .25 * sst(-.3, .3, fbm(qn * 2.5 + E.z, 18u)));
        float bleed = (1. - sst(-.05, .2 + .2 * E.w, sdn)) * (1. - ring) * .35;
        float core = 1. - sst(.45 * F.y, .85 * F.y, F.z);
        float aa = max(max(ring, core * .45), bleed) * D.w;
        vec3 ink = mix(vec3(.0103, .0091, .0085), vec3(.0474, .2016, .1946), E.w);
        vec3 coreC = mix(vec3(.254, .111, .023), vec3(.09, .24, .21), E.w);
        float side = sst(.62, .92, dot(normalize(q + 1e-4), normalize(vec2(.62, -.78))));
        float lit = side * ring * (1. - sst(-.02, .06, -sdn - .08));
        vec3 cc = mix(mix(coreC, ink, clamp(ring + bleed * 1.6, 0., 1.)), vec3(.823, .418, .068), lit * .6);
        if (aa > a) { a = aa; col = cc; }
      }
      gl_FragColor = vec4(col * uComp, a);
    }`, dotU, 12);
  scene.add(dotsLayer);

  const all = [s4aBg, s4aFog, inkLayer, s4b, scroll, island, dotsLayer];
  const sprites = [handOpen, handFist, glide, headG];
  const only = (...keep) => { for (const m of all) m.visible = keep.includes(m); for (const S of sprites) S.group.visible = keep.includes(S); };

  const shots = {};
  // ── S4a 雨洗指尖（f356–f378） ──
  shots.S4a = (f, t) => {
    const tc = tcOf(f);
    only(s4aBg, s4aFog, handOpen, inkLayer);
    s4aBgU.uT.value = t; s4aBgU.uK.value = 1;
    s4aBgU.uR.value = -90 + (.75 * 1040 * 1.6 + 90) * eo((f - 356) / 6);
    s4aBgU.uBack.value = 1;
    const H = handOpen;
    const tip = [1180, 420];
    const push = 1 + .01 * ss((f - 356) / 22);
    placeFlat(H, A13.index_tip[0], A13.index_tip[1], tip[0], tip[1], .78 * push, 25);
    const u = H.u; u.uDesat.value = .92; u.uLight.value.set(.94 * .96, .95 * .95, .96 * .93); u.uRimC.value.copy(lin3('#EEE7DF')); u.uRimAmt.value = .35; u.uRimDir.value.set(1, -.2).normalize(); u.uRimW.value = texPx(H, 6);
    u.uTc.value = tc; u.uFogAmt.value = 0; u.uSpotXf.value.set(25 * DEG, 0);   // 第 4 轮（zs-01）：墨环按屏幕方向画
    // 指尖墨渍（种子 7，34K）：f369 起不透明度 1.0 → 0.4
    const wash = 1 - .6 * ss((f - 369) / 9);
    setSpots(H, [{ x: A13.index_tip[0] - texPx(H, 30), y: A13.index_tip[1] - texPx(H, 12), r: texPx(H, 34), kind: 3, seed: 7, soft: .05, alpha: wash }]);
    // 墨层
    const dir = [Math.cos(25 * DEG), Math.sin(25 * DEG)];
    inkU.uTip.value.set(tip[0] + dir[0] * 4, tip[1] + dir[1] * 4 + 6); inkU.uDir.value.set(dir[0], dir[1]);
    inkU.uStream.value.set(f >= 369 ? 60 * (f - 369) / 24 * 4 : 0, 0, 0, f >= 369 ? ss((f - 369) / 3) : 0);
    // 墨滴：f369–f374 长大并拉长；f374 脱离留下 2 帧墨丝；f374–f378 加速下落、出画
    if (f >= 369 && f < 374) { const k = (f - 369) / 5; const r = lerp(8, 24, k); inkU.uDrop.value.set(tip[0] + 3, tip[1] + 14 + r * lerp(1, 1.3, k), r, lerp(1, 1.3, k)); inkU.uThread.value = 0; }
    else if (f >= 374) { const k = (f - 374) / 4; const y = tip[1] + 50 + 700 * k * k + 120 * k; inkU.uDrop.value.set(tip[0] + 3, y, 24, 1.3 * (1 + .4 * k)); inkU.uThread.value = f < 376 ? 1 : 0; }
    else { inkU.uDrop.value.set(0, 0, 0, 1); inkU.uThread.value = 0; }
    // f358 / f362 / f366 三颗雨点打在指尖，每颗溅 3 帧
    let spl = 0, sr = 0; for (const fh of [358, 362, 366]) if (f >= fh && f < fh + 3) { spl = 1 - (f - fh) / 3; sr = 6 + 10 * (f - fh); }
    inkU.uSplash.value.set(sr, 0, 0, spl);
    return { scene, camera: cam };
  };
  // ── S4b 墨滴·晕开·收紧·第一枚斑（f378–f438） ──
  const OLD = [[520, 260, 70], [300, 760, 60], [1620, 330, 66], [820, 900, 54]];
  OLD.forEach(([x, y, r], i) => s4bU.uOld.value[i].set(x, y, r, 0));
  shots.S4b = (f, t) => {
    const tc = tcOf(f);
    only(s4b);
    s4bU.uT.value = t;
    const z = f < 383 ? lerp(1, 1.10, (f - 378) / 5) : f < 431 ? lerp(1.10, 1.55, eio((f - 383) / 48)) : lerp(1.55, 1.62, eo((f - 431) / 7));   // 2.5D 推近
    s4bU.uZoom.value = z;
    // 墨滴下落
    if (f < 383) { const s = (f - 378) / 5; s4bU.uDrop.value.set(1180, -60 + 660 * s * s, 22, 1); } else s4bU.uDrop.value.set(0, 0, 0, 0);
    // 落背：水花 3 帧、波纹 2 帧
    s4bU.uSpl.value.set(f >= 383 && f < 386 ? 30 + 22 * (f - 383) : 0, 0, 0, f >= 383 && f < 386 ? 1 - (f - 383) / 3 : 0);
    s4bU.uRip.value.set(0, 0, f >= 383 && f < 385 ? lerp(30, 90, (f - 383) / 2) : 0, f >= 383 && f < 385 ? .3 * (1 - (f - 383) / 2) : 0);
    // 晕开 → 收紧 → 一弹成斑
    // 返修 story-05：晕开 f383–f410（27 帧，eo）；收紧拉长到 f410–f429（19 帧，ss）——咖啡环先变深、心先退空、断口一段段张开；f431 一弹仍踩 17.94
    let Rk = 0, soft = .5, gapK = 0, clear = 0, gold = 0, fing = 0, coffee = 0;
    if (f >= 383) {
      if (f < 410) { const k = eo((f - 383) / 27); Rk = .25 + 1.40 * k; soft = lerp(.5, .32, k); fing = 1; }
      else if (f < 429) { const k = ss((f - 410) / 19); Rk = lerp(1.65, .95, k); soft = lerp(.32, .08, k); gapK = ss((f - 414) / 15); clear = ss((f - 410) / 9); fing = 1 - k; coffee = ss((f - 410) / 6); }
      else if (f < 431) { Rk = .95; soft = .07; gapK = 1; clear = 1; fing = 0; coffee = 1; }
      else { const ff = Math.floor(f / 2) * 2; const b = ff < 433 ? 1.12 : ff < 435 ? .97 : 1.0; Rk = b; soft = .03; gapK = 1; clear = 1; fing = 0; coffee = 1; }
      gold = f >= 433 ? ss((f - 433) / 10) : 0;
    }
    s4bU.uInk.value.set(Rk * R0, soft, gapK, clear);
    s4bU.uInk2.value.set(gold, fing, f >= 383 ? 1 : 0, coffee);
    return { scene, camera: cam };
  };
  // ── S5b 长卷化开·横移（f567–f628） ──
  const A05 = M('A05')['锚点'];
  const GLIDE_S = .2;          // A05 在长卷上的大小：身长约 300K
  function scrollOff(f) {      // 长卷向左走：速度 520 → 300K/s（eo），叠 ±30K 起伏
    const T = (f - 567) / 24, dur = 61 / 24;
    // 速度 v(t) = 520 − 220·eo(t/dur)，数值积分（按帧求和，确定性）
    let x = 0; const n = Math.max(0, f - 567);
    for (let i = 0; i < n; i++) x += (520 - 220 * eo((i + .5) / 61)) / 24;
    return x + 30 * Math.sin(2 * Math.PI * T / 2.4);
  }
  // 返修 story-02 / story-11：接住 S5a 末帧的位置（约 (1300, 540)），慢慢漂回画中；上下起伏 ±60K、周期 2.4 秒，墨点因此连成波浪弧线
  function glidePos(f) { const k = ss(clamp((f - 567) / 61)); const t = (f - 567) / 24; return [lerp(1290, 1060, k), lerp(535, 470, k) + 60 * Math.sin(2 * Math.PI * t / 2.4) * ss(clamp((f - 567) / 14))]; }
  function tailRootScreen(f) {
    const tr = A05['脊柱锚点_px'].tail_root;
    const hk = ss(seg(f, 567, 585)); const [lx, ly] = glidePos(f);
    if (hk >= 1) return [lx + (tr[0] - 820) * GLIDE_S, ly + (tr[1] - 520) * GLIDE_S];
    const L0 = world.leoInfo(f), x = lerp(L0.x, lx, hk), y = lerp(L0.y, ly, hk), sc = lerp(L0.s, GLIDE_S, hk);
    return [x + (tr[0] - 820) * sc, y + (tr[1] - 520) * sc];
  }
  // 化开遮罩的中心跟着小豹走
  const px0 = f => { const hk = ss(seg(f, 567, 585)); const [lx, ly] = glidePos(f); return hk < 1 ? lerp(world.leoInfo(f).x, lx, hk) : lx; };
  const py0 = f => { const hk = ss(seg(f, 567, 585)); const [lx, ly] = glidePos(f); return hk < 1 ? lerp(world.leoInfo(f).y, ly, hk) : ly; };
  shots.S5b = (f, t, worldTex, o = {}) => {
    const tc = tcOf(f);
    only(scroll, glide, dotsLayer, island);
    const comp = o.comp || [1, 1, 1]; scrollU.uComp.value.set(...comp); scrollU.uWComp.value.set(...(o.wcomp || [1, 1, 1]));
    const off = scrollOff(f);
    scrollU.uOff.value = 30 + off; scrollU.uBlur.value = 0; scrollU.uFar.value = off * .6; scrollU.uNear.value = off * 1.6; scrollU.uT.value = t;
    // 化开（f567–f583）
    const [lx, ly] = glidePos(f);
    // 返修 story-15：化开用 20 帧、慢起慢收（前 6 帧只在豹身边 300K 以内洇开）
    if (f < 587 && worldTex) { scrollU.uWorldOn.value = 1; scrollU.tWorld.value = worldTex; scrollU.uDis.value.set(px0(f), py0(f), 1.4 * ss(seg(f, 567, 587)) + .25 * ss(seg(f, 567, 573)), 1); }
    else { scrollU.uWorldOn.value = 0; }
    // 小豹（A05）：一拍二；上下漂 ±8K；尾巴 S 形摆 ±4°
    const S = glide;
    // 化开期间从 S5a 末帧小豹的位置、大小、倾角接过来，18 帧内滑到长卷上的路径（一只豹，不出双影）
    const hk = ss(seg(f, 567, 585));
    const L0 = hk < 1 ? world.leoInfo(f) : null;
    const px = L0 ? lerp(L0.x, lx, hk) : lx, py = L0 ? lerp(L0.y, ly, hk) : ly;
    const psc = L0 ? lerp(L0.s, GLIDE_S, hk) : GLIDE_S, pang = L0 ? lerp(L0.ang, 2 * Math.sin(2 * Math.PI * tc / 1.2), hk) : 2 * Math.sin(2 * Math.PI * tc / 1.2);
    placeFlat(S, 820, 520, px, py, psc, pang);
    const sway = 4 * DEG * Math.sin(2 * Math.PI * tc / 1.6);
    setBends(S, [{ pivot: A05['脊柱锚点_px'].tail_root, center: [250, 350], angle: sway, rIn: 60, rOut: 330 }, { pivot: [320, 300], center: [140, 410], angle: -sway * 1.4, rIn: 40, rOut: 200 }]);
    world.styleLeo(S, { d: 0, light: new THREE.Vector3(1, .95, .85), rimC: '#EAAD49', rimAmt: .55, rimDir: [.7, -.7], glowC: '#F3E8C0', glowA: .16 });
    for (const k of ['uLight', 'uRimC', 'uGlowC']) S.u[k].value.multiply(scrollU.uComp.value);   // 第 4 轮（qa2-01）：化开期间的调色补偿
    S.u.uTc.value = tc; S.u.uSpotOn.value = 1; S.u.uGoldClear.value = 1;
    setSpots(S, [...world.spotsFor(world.spines.glide, world.plan, { allOn: true }), ...world.headSpotsFor('A05')]);
    const E = A05['眼椭圆']; S.u.uEye.value.set(E.cx, E.cy, E.rx, E.ry); S.u.uEyeB.value.set(0, 0, 0, 8);
    // 墨点（返修 tech-13）：每 3 帧一颗（相邻两颗至少隔开 1.6 倍半径），存成长卷坐标；寿命 72 帧
    const list = [];
    for (let k = 0; k < 24; k++) {
      const fb = 567 + 3 * k; if (fb > f) break; const age = f - fb; if (age > 72) continue;
      const [tx, ty] = tailRootScreen(fb);
      const sx = tx + scrollOff(fb) - off + (hashi(k * 5 + 900) - .5) * 10, sy = ty + (hashi(k * 5 + 901) - .5) * 10;
      const pop = (a => a < 2 ? 0 : a < 4 ? .6 : a < 6 ? 1.14 : a < 8 ? .96 : 1)(Math.floor((tc * 24 - fb) / 2) * 2);
      const r = (10 + 5 * hashi(k * 7 + 902)) * pop * (1 + .25 * ss((age - 24) / 48));
      const a = .9 * (1 - ss((age - 48) / 24));
      const ph = motifPh(100 + k);
      list.push([sx, sy, r, a, ph[0], ph[1], ph[2], ss((age - 20) / 52)]);
    }
    dotU.uN.value = list.length;
    list.forEach((d, i) => { dotU.uD.value[i].set(d[0], d[1], Math.max(d[2], .01), d[3]); dotU.uE.value[i].set(d[4], d[5], d[6], d[7]); });
    // 大浮岛掠过（返修 tech-09）：按长卷速度的 1.6 倍走（每帧约 25–35K），窗口 f586–f628，淡入淡出各 8 帧，沿 x 方向模糊约半帧位移
    if (f >= 586) {
      const dx = 1.6 * (scrollOff(f) - scrollOff(586)); island.visible = true;
      const vx = 1.6 * (scrollOff(f + 1) - scrollOff(f));
      island.position.set(2350 - dx, 1040 - 830, 0); island.scale.set(900, 650, 1);
      islandU.uA.value = ss((f - 586) / 8) * (1 - ss((f - 620) / 8));
      islandU.uBlur.value = vx * .5 / 900;
    } else island.visible = false;
    return { scene, camera: cam };
  };
  // ── S5c 豹眼（f628–f642） ──
  const A06 = M('A06')['锚点'];
  const E6 = A06['眼椭圆'];
  setExclude(headG, A06['眼排除椭圆'], A06['口鼻排除椭圆']);
  shots.S5c = (f, t) => {
    const tc = tcOf(f);
    only(scroll, glide, headG);
    const off = scrollOff(628);
    scrollU.uComp.value.set(1, 1, 1); scrollU.uWComp.value.set(1, 1, 1);
    scrollU.uOff.value = 30 + off; scrollU.uWorldOn.value = 0; scrollU.uBlur.value = 20 * ss((f - 628) / 4); scrollU.uFar.value = off * .6; scrollU.uNear.value = off * 1.6;
    // 快推：眼睛 rx 从 S5b 的大小指数放大到 236K（f634），f634 后每帧再推 0.5%
    const [lx, ly] = glidePos(628);
    const eye0 = [lx + (A05['眼椭圆'].cx - 820) * GLIDE_S, ly + (A05['眼椭圆'].cy - 520) * GLIDE_S];
    const rx0 = A05['眼椭圆'].rx * GLIDE_S, rxEnd = EYE_E.rx;
    const k = eio((f - 628) / 6);
    const rx = f < 634 ? rx0 * Math.pow(rxEnd / rx0, k) : rxEnd * Math.pow(1.005, f - 634);
    const c = [lerp(eye0[0], EYE_E.cx, ss(k * 1.1)), lerp(eye0[1], EYE_E.cy, ss(k * 1.1))];
    const swap = f >= 631;
    glide.group.visible = !swap; headG.group.visible = swap;
    if (!swap) {
      placeFlat(glide, A05['眼椭圆'].cx, A05['眼椭圆'].cy, c[0], c[1], rx / A05['眼椭圆'].rx);
      { const sw = 4 * DEG * Math.sin(2 * Math.PI * tc / 1.6); setBends(glide, [{ pivot: A05['脊柱锚点_px'].tail_root, center: [250, 350], angle: sw, rIn: 60, rOut: 330 }, { pivot: [320, 300], center: [140, 410], angle: -sw * 1.4, rIn: 40, rOut: 200 }]); }
      glide.u.uTc.value = tc; glide.u.uSpotOn.value = 1; const E5 = A05['眼椭圆']; glide.u.uEye.value.set(E5.cx, E5.cy, E5.rx, E5.ry); glide.u.uEyeB.value.set(0, 0, 0, 8);
      world.styleLeo(glide, { d: 0, light: new THREE.Vector3(1, .95, .85), rimC: '#EAAD49', rimAmt: .55, rimDir: [.7, -.7], glowC: '#F3E8C0', glowA: .16 });
      setSpots(glide, [...world.spotsFor(world.spines.glide, world.plan, { allOn: true }), ...world.headSpotsFor('A05')]); glide.u.uGoldClear.value = 1;
    } else {
      // 画好的眼（近圆，倾 −43°）要整个落在代码眼椭圆 (236, 200)·k 之内：头像按 0.95·200/118.9 缩放
      const sc = (rx / rxEnd) * .95 * EYE_E.ry / E6.rx;
      placeFlat(headG, E6.cx, E6.cy, c[0], c[1], sc, 0);
      world.styleLeo(headG, { d: 0, light: new THREE.Vector3(1, .95, .85), rimC: '#EAAD49', rimAmt: .5, rimDir: [.7, -.7], glowC: '#F3E8C0', glowA: .12 });
      headG.u.uTc.value = tc; headG.u.uSpotOn.value = 1; headG.u.uGoldClear.value = 1;
      setSpots(headG, world.headSpotsGold);
      // 代码眼：E = (1010, 500)，半轴 (236, 200)K，倾角 −12°；外圈描边 9K；虹膜 #E3CA58 → #A98E43；瞳孔 .42；高光核心在 H
      const s = sc;
      const hx = E6.cx + (STAR_H[0] - c[0]) / s, hy = E6.cy + (STAR_H[1] - c[1]) / s;
      // 返修 style-10：只改绘法，椭圆参数不动（T2 形、位对位不受影响）
      const kk = rx / rxEnd;
      setEye(headG, { cx: E6.cx, cy: E6.cy, rx: EYE_E.rx / s * kk, ry: EYE_E.ry / s * kk, tilt: EYE_E.tilt, mode: 1, ring: 9 / s * kk, iris0: '#E3CA58', iris1: '#A98E43', pupil: .42,
        hi: [hx, hy, 10 / s, 1], lid: 0, lidBase: .22, ringTop: 9 / s * kk, ringBot: 3 / s * kk, paint: 2 / s * kk, k2: kk / s, lidColor: '#C98C3E' });
      headG.u.uEdgeFall.value = .25; headG.u.uEdgeLod.value = Math.max(0, Math.log2(texPx(headG, 40)));
      headG.u.uSoftE.value.set(635, 622, 150, 118); headG.u.uSoftRef.value.set(455, 560, .45);   // 腮红羽化、淡到约 .25
    }
    // 高光长成四芒星：f636–f641，臂长 0 → 220K、核心 10 → 36K
    const g = clamp((f - 636) / 5);
    const blur = f < 634 ? [c[0], c[1], .5 * Math.sin(Math.PI * clamp((f - 628) / 6))] : null;
    return { scene, camera: cam, blur: blur ? { radial: blur } : null, star: f >= 636 ? { amt: .4 + .8 * g, arm: 220 * g, core: 10 + 26 * g, halo: 140 * g } : null };
  };
  return { scene, cam, shots, glidePos };
}
