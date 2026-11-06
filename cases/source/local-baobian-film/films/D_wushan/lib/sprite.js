// 《豹变》D 雾山 · 2D 精灵（三渲二的角色层）
//   · 32×32 细分面片，顶点着色器按"骨"（以像素为单位的旋转 / 缩放区域）做网格形变；贴图坐标不动，所以图跟着形变走
//   · 片元：豹 = 梯度映射（灰 → 金只插值一个参数）；人 = 二档重量化（保色相）；2D 边缘光（alpha 差分）；
//          母题环斑（湿团 → 环，像素空间网格，跟着形变走）；指尖墨渍；光斑（S6）
//   · 彩色层透明混合、不写深度；另有一层只写深度的遮罩（alpha > 0.5），让 look 的雾和 Kuwahara 按真实深度处理
// 所有量都是 uniform，随时间的变化由调用方按 t / f 算好传进来。
import * as THREE from 'three';
import { GLSL } from './glsl.js';
import { lin3 } from './util.js';

const NB = 6;
const VS = /* glsl */`
uniform vec4 uRect;      // 本姿态在原图里的像素框 x0, y0, w, h（y 向下）
uniform vec2 uImg;       // 原图像素尺寸
uniform float uFlip;
uniform vec4 uBA[${NB}];   // 骨：pivot.xy, 区域中心.xy（原图像素）
uniform vec4 uBB[${NB}];   // 骨：r0, r1（像素）, 角度（弧度，屏幕上顺时针为正）, 缩放
uniform vec4 uSq;        // 整体：锚点.xy（像素）, sx, sy
uniform vec4 uBT[2];     // 平移骨：区域中心.xy, 位移.xy（像素）；半径在 uBTR
uniform vec4 uBTR;
uniform vec2 uShear;     // 剪切：x 方向按 (y - 腰线) 偏移；x = 系数, y = 腰线像素
varying vec2 vUv; varying vec2 vPx;
void main(){
  vec2 l = position.xy;
  vec2 px = uRect.xy + vec2(l.x + .5, .5 - l.y) * uRect.zw;
  vPx = px; vUv = vec2(px.x / uImg.x, 1. - px.y / uImg.y);
  vec2 q = px;
  for (int i = 0; i < ${NB}; i++) {
    vec4 A = uBA[i], B = uBB[i];
    if (B.y <= 0.) continue;
    float w = 1. - smoothstep(B.x, B.y, distance(px, A.zw));
    float a = B.z * w, s = 1. + B.w * w;
    vec2 d = (q - A.xy) * s;
    float c = cos(a), sn = sin(a);
    q = A.xy + vec2(c * d.x - sn * d.y, sn * d.x + c * d.y);
  }
  for (int i = 0; i < 2; i++) { vec4 T = uBT[i]; float r1 = i == 0 ? uBTR.y : uBTR.w; if (r1 <= 0.) continue; float w = 1. - smoothstep(i == 0 ? uBTR.x : uBTR.z, r1, distance(px, T.xy)); q += T.zw * w; }
  if (uShear.x != 0.) q.x += uShear.x * max(px.y - uShear.y, 0.);
  q = uSq.xy + (q - uSq.xy) * uSq.zw;
  vec2 l2 = vec2((q.x - uRect.x) / uRect.z - .5, .5 - (q.y - uRect.y) / uRect.w);
  if (uFlip > .5) l2.x = -l2.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(l2, 0., 1.);
}`;

const FS = /* glsl */`
${GLSL}
uniform sampler2D uMap, uIn;
uniform vec2 uImg; uniform vec4 uRect;
uniform float uMode, uOpacity, uErode, uFlip;
uniform vec3 uThr; uniform vec3 uG0[4]; uniform vec3 uG1[4]; uniform float uGold;
uniform vec4 uEye; uniform float uEyeTilt;
uniform vec3 uLit, uShade; uniform vec2 uHT;
uniform vec2 uRimOff; uniform vec3 uRimCol; uniform float uRimAmt;
uniform vec3 uTint; uniform vec3 uFogCol; uniform float uFogAmt;
uniform float uSpot, uCell, uDry, uWetA, uFlow, uFlowT, uHeartA, uSpotScale, uSolid;
uniform vec3 uHead;               // 头部（px）：中心 xy、半径（返修 4 起不用：头颈按胶囊以外算）
uniform vec4 uTorso; uniform float uTorsoR;   // 躯干胶囊（px）：颈根 xy、尾根 xy、半径
uniform vec3 uWave;               // 收紧的波前（px）：中心 xy、半径；uWaveW 过渡宽（0 = 不用，整身一起按 uDry）
uniform float uWaveW;
uniform vec2 uFlowDir;
uniform vec3 uRingCol, uHeartCol, uWetCol, uFlowCol;
uniform vec4 uEx0, uEx1;          // 排除椭圆（px）cx, cy, rx, ry
uniform vec4 uStain; uniform vec4 uStainP; uniform float uStainSeed, uStainWob; uniform vec3 uStainCol; uniform float uStainGloss;
uniform float uDap, uDapCell, uDapT, uDapR, uDapTipA; uniform vec3 uDapCol; uniform vec2 uDapTip; uniform float uDapTipSeed;
uniform vec4 uBeam;               // 光束遮罩（设计像素）：角度、原点 xy、开（S6 光斑只出现在窗光照到的地方）
uniform vec2 uRes; uniform float uK;
uniform float uBlur, uDof; uniform vec3 uSilCol; uniform float uInkGrow;
varying vec2 vUv, vPx;

bool excl(vec2 p, vec4 e){ if (e.z <= 0.) return false; vec2 d = (p - e.xy) / e.zw; return dot(d, d) < 1.; }
vec4 tex(vec2 uv){ return uBlur > 0. ? texture2D(uMap, uv, uBlur) : texture2D(uMap, uv); }
float beamMask(vec2 p){ return beamMaskAt(p, uBeam.x, uBeam.yz); }

// 豹斑：像素空间网格，返回 (墨量, 环心, 是否成环, 干的程度)
// 返修 4（main3-01，PLAN 3.1 锁死的玄豹斑）：分部位——
//   · 躯干（颈根→尾根的胶囊 uTorso / uTorsoR 以内）是环斑：格距 = 清单 spot_unit_px（体长 × 7%），环径约 = 体长 × 5%；
//   · 头、颈、腿、尾（胶囊以外）只有实心小点：另一套半格距的网格，点径约 = 体长 × 1.2%；
//   · 眼周、口鼻（排除椭圆）、腹档（最亮一档）不放斑；环心是"比底色略深"，不再填土黄
bool inTorso(vec2 p){ if (uTorsoR <= 0.) return false; vec2 a = uTorso.xy, b = uTorso.zw, ab = b - a; float h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1.), 0., 1.); return distance(p, a + ab * h) < uTorsoR; }
bool spotOK(vec2 cp, out vec2 cuv){
  cuv = vec2(cp.x / uImg.x, 1. - cp.y / uImg.y);
  vec4 tc = texture2D(uMap, cuv);
  if (tc.a < .9) return false;
  if (cp.x < uRect.x || cp.y < uRect.y || cp.x > uRect.x + uRect.z || cp.y > uRect.y + uRect.w) return false;
  float Yc = lumS(tc.rgb);
  if (Yc < uThr.x || Yc > uThr.z) return false;
  if (excl(cp, uEx0) || excl(cp, uEx1)) return false;
  if (uEye.z > 0. && excl(cp, vec4(uEye.xy, uEye.zw * 1.6))) return false;
  return true;
}
vec4 leoSpots(vec2 px){
  float cell = uCell;
  float aaPx = max(length(fwidth(px)), 1e-3);
  float ink = 0., heart = 0., best = 0., dryB = uDry;
  // 躯干环斑
  if (uTorsoR > 0.) {
    vec2 gi = floor(px / cell);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 c = gi + vec2(float(i), float(j));
      vec2 h = hash22(c + 13.1);
      vec2 cp = (c + .5 + (h - .5) * .8) * cell;
      vec2 cuv;
      if (!inTorso(cp) || !spotOK(cp, cuv)) continue;
      if (hash12(c + 19.9) < .12) continue;
      float R = cell * (.30 + .1 * hash12(c + 71.7)) * uSpotScale;
      { vec2 o = vec2(R * .45) / uImg; float y1 = lumS(texture2D(uMap, cuv + vec2(o.x, 0.)).rgb), y2 = lumS(texture2D(uMap, cuv - vec2(o.x, 0.)).rgb),
          y3 = lumS(texture2D(uMap, cuv + vec2(0., o.y)).rgb), y4 = lumS(texture2D(uMap, cuv - vec2(0., o.y)).rgb);
        if (min(min(y1, y2), min(y3, y4)) < uThr.x) continue; }
      vec2 p = spotWarp((px - cp) / R, hash12(c + 2.1) * 10.);
      if (dot(p, p) > 1.8) continue;
      float seed = floor(hash12(c + 3.3) * 97.);
      float petals = 3. + floor(hash12(c + 5.9) * 3.99);
      float aa = aaPx / R;
      float dry = uDry * (uWaveW > 0. ? clamp((uWave.z - distance(cp, uWave.xy)) / uWaveW, 0., 1.) : 1.);
      float sc = dry > 0. && dry < 1. ? 1. + .1 * sin(dry * 3.14159) : 1.;
      vec2 r = rosette(p / sc, seed, dry, dry, min(petals, 5.) * step(.5, dry), .42, .24, aa);
      if (r.x > ink) { ink = r.x; best = 1.; dryB = dry; }
      heart = max(heart, r.y * (1. - r.x) * dry);
    }
  }
  // 头、颈、腿、尾：实心小点（半格距）
  {
    float c2 = cell * .5;
    vec2 gi = floor(px / c2);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 c = gi + vec2(float(i), float(j));
      vec2 h = hash22(c + 31.7);
      vec2 cp = (c + .5 + (h - .5) * .8) * c2;
      vec2 cuv;
      if (inTorso(cp) || !spotOK(cp, cuv)) continue;
      if (hash12(c + 29.9) < .3) continue;
      float R = c2 * (.13 + .1 * hash12(c + 61.7)) * uSpotScale;
      vec2 p = spotWarp((px - cp) / R, hash12(c + 4.1) * 10.);
      if (dot(p, p) > 1.8) continue;
      vec2 r = rosette(p, floor(hash12(c + 3.9) * 97.), 1., 0., 0., .5, .2, aaPx / R);
      float d = smoothstep(.35, .6, r.x) * max(uDry, .6);
      if (d > ink) { ink = d; best = 0.; dryB = max(uDry, .6); }
    }
  }
  return vec4(ink, heart, best, dryB);
}

// 光斑（S6）：树叶筛下来的阳光——柔边椭圆光团，一簇簇重叠，只在光束里、只在受光面；返回光量
float dapples(vec2 px, vec2 sp){
  float cell = uDapCell;
  vec2 g = px / cell, gi = floor(g);
  float L = 0.;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = gi + vec2(float(i), float(j));
    vec2 h = hash22(c + 41.3);
    float ph = hash12(c + 9.1) * 6.2832;
    // 风吹树叶：和窗上叶团同一相位（整体漂移 + 每簇一点自己的摆）
    vec2 wind = (vec2(6. * sin(.9 * uDapT), 3. * sin(1.3 * uDapT + 1.)) + vec2(2. * sin(1.7 * uDapT + ph), 1.5 * sin(2.1 * uDapT + ph))) * (cell / 46.);
    vec2 cp = (c + .5 + (h - .5) * .9) * cell + wind;
    // 叶缝：只有落在亮块里的格子才有光团（大部分是叶影）
    float gap = vnoise2(cp / (cell * 2.2) + 4.1) * .6 + vnoise2(cp / (cell * .9) + 9.3) * .4;
    if (gap < .45) continue;
    float R = uDapR * (.7 + .6 * hash12(c + 5.5));
    vec2 p = (px - cp) / R; p.x /= 1.25;
    if (dot(p, p) > 1.6) continue;
    float soft = .55 + .25 * hash12(c + 2.2);
    float br = .6 + .4 * hash12(c + 8.8);
    // 返修 3（story-04）：光团不是一块平的圆片——芯亮、往外软下去（像透过叶缝的一束光落在布上）
    float prof = .5 + .5 * (1. - smoothstep(0., 1.05, length(p)));
    L = max(L, lightBlob(p, hash12(c + 3.1) * 97., soft) * br * prof * smoothstep(.45, .58, gap));
  }
  return L;
}

void main(){
  vec4 c = tex(vUv);
  float a = c.a;
  if (uErode > 0.) {
    vec2 e = uErode / uImg;
    a = min(a, min(min(texture2D(uMap, vUv + vec2(e.x, 0.)).a, texture2D(uMap, vUv - vec2(e.x, 0.)).a),
                   min(texture2D(uMap, vUv + vec2(0., e.y)).a, texture2D(uMap, vUv - vec2(0., e.y)).a)));
  }
  vec3 s = c.rgb;                // 原图 sRGB 值
  float Y = lumS(s);
  vec3 col;
  float litM = 1., inkLine = 0.;
  if (uMode > .5 && uMode < 1.5) {
    // 豹：梯度映射
    float w = .02;
    float k0 = smoothstep(uThr.x - w, uThr.x + w, Y), k1 = smoothstep(uThr.y - w, uThr.y + w, Y), k2 = smoothstep(uThr.z - w, uThr.z + w, Y);
    vec3 g0 = mix(mix(mix(uG0[0], uG0[1], k0), uG0[2], k1), uG0[3], k2);
    vec3 g1 = mix(mix(mix(uG1[0], uG1[1], k0), uG1[2], k1), uG1[3], k2);
    col = mix(g0, g1, uGold);
    if (uDof > 0.) {
      // 假景深：先映射、再在 uv 里做圆盘平均（颜色按 alpha 预乘），不会出暗晕，也不会把墨线糊成几档色阶
      vec3 acc = col * a; float aw = a;
      for (int i = 0; i < 12; i++) {
        float an = float(i) * 2.39996, rr = sqrt((float(i) + .5) / 12.);
        vec2 o = vec2(cos(an), sin(an)) * rr * uDof / uImg;
        vec4 t = texture2D(uMap, vUv + o, 1.);
        float Yt = lumS(t.rgb);
        float t0 = smoothstep(uThr.x - w, uThr.x + w, Yt), t1 = smoothstep(uThr.y - w, uThr.y + w, Yt), t2 = smoothstep(uThr.z - w, uThr.z + w, Yt);
        vec3 h0 = mix(mix(mix(uG0[0], uG0[1], t0), uG0[2], t1), uG0[3], t2), h1 = mix(mix(mix(uG1[0], uG1[1], t0), uG1[2], t1), uG1[3], t2);
        acc += mix(h0, h1, uGold) * t.a; aw += t.a;
      }
      col = acc / max(aw, 1e-4); a = aw / 13.;
      k0 = 1.;
    }
    litM = k1;
    inkLine = 1. - k0;
    // 眼睛不参与映射
    if (uEye.z > 0.) {
      vec2 d = vPx - uEye.xy; float ct = cos(uEyeTilt), st = sin(uEyeTilt);
      d = vec2(ct * d.x + st * d.y, -st * d.x + ct * d.y) / uEye.zw;
      float em = 1. - smoothstep(.85, 1., length(d));
      // 豹眼几乎被琥珀色虹膜占满：原图里白的眼白也染成琥珀（越靠外越暗），看不到眼白
      vec3 eyeC = srgb2lin(s);
      float scl = smoothstep(.55, .8, Y) * (1. - smoothstep(.08, .25, max(s.r, max(s.g, s.b)) - min(s.r, min(s.g, s.b)))) * (1. - smoothstep(.86, .93, Y));   // 返修 3：最亮的角膜高光不染
      eyeC = mix(eyeC, mix(srgb2lin(vec3(.91, .66, .2)), srgb2lin(vec3(.62, .36, .08)), smoothstep(.3, 1., length(d))), scl);
      col = mix(col, eyeC, em);
    }
    if (uSpot > .5) {
      vec4 sp = leoSpots(vPx);
      float fur = k0 * (1. - smoothstep(uThr.z - .01, uThr.z + .015, Y));     // 墨线、腹档上不画斑
      float wetInk = sp.x * (1. - sp.w) * uWetA;
      float dryInk = sp.x * sp.w;
      vec3 ringC = uRingCol;
      if (uFlow > 0.) {
        // 金光流动：只是一道细亮线沿环的外缘跑过，不把墨瓣填满
        vec2 pn = (vPx - uRect.xy) / uRect.w;
        float b = exp(-pow((dot(pn, uFlowDir) - uFlowT * .6) / .03, 2.));
        float edgeL = smoothstep(.35, .6, dryInk) * (1. - smoothstep(.75, .98, dryInk));
        ringC = mix(ringC, uFlowCol, clamp(b * .5 * uFlow * (.35 + .65 * edgeL), 0., 1.));
      }
      col = mix(col, uWetCol, clamp(wetInk, 0., 1.) * fur);
      col = mix(col, col * .87, clamp(sp.y * sp.z * fur * uHeartA / .55, 0., 1.));   // 返修 4：环心比周围底色深约 13%（不填土黄）
      col = mix(col, ringC, clamp(dryInk, 0., 1.) * fur);
    }
  } else if (uMode > 2.5) {
    // 剪影（雾中鹿群）：alpha 二值化后平涂
    a = smoothstep(.5, .6, c.a);
    col = uSilCol;
  } else if (uMode > 1.5) {
    // 人：二档重量化（皮肤 / 衣物分阈值），墨线不动
    bool skin = (s.r - s.b) > .10 && Y > .30;
    float th = skin ? uHT.x : uHT.y;
    float tw = skin ? .02 : .0075;               // 衣物交界收紧：平涂 + 一层影
    float m = 1. - smoothstep(th - tw, th + tw, Y);
    litM = 1. - m;
    inkLine = 1. - smoothstep(.13, .17, Y);
    col = srgb2lin(s);
    if (Y > .15) col *= mix(uLit, uShade, m);
    // 返修 2（style-12）：墨线加粗——取周围 8 个点里最暗的，暗于墨线阈值就算线（只在形体里面长，不改外轮廓）
    // 返修 4（PLAN WP-02 第 4 条）：新 A04–A08 本身就是粗浓墨线（≥ 3.5·K），再膨胀会糊成一团——墨线加粗整体关掉（阈值抬到 99）
    if (uInkGrow > 99.) {
      vec2 e = vec2(uInkGrow) / uImg; float ym = Y;
      for (int i = 0; i < 8; i++) { float an = float(i) * .7854; vec4 tt = texture2D(uMap, vUv + vec2(cos(an), sin(an)) * e); if (tt.a > .5) ym = min(ym, lumS(tt.rgb)); }
      float g = (1. - smoothstep(.13, .19, ym)) * (1. - inkLine);
      col = mix(col, srgb2lin(vec3(.13, .11, .10)) * uShade, g * .92); inkLine = max(inkLine, g);
    }
  } else {
    col = srgb2lin(s);
  }
  a *= uOpacity;
  if (a < .003) discard;
  // 指尖墨渍（母题第一次）：冷蓝黑墨，覆盖（不是乘法），外圈一道淡灰洇边，墨上一个湿亮点
  if (uStain.w > 0.) {
    vec2 p = (vPx - uStain.xy) / uStain.z;
    if (dot(p, p) < 3.2) {
      float aa = max(length(fwidth(vPx)), 1e-3) / uStain.z;
      vec2 r = rosette(p, uStainSeed, uStainP.x, uStainP.y, uStainP.z, uStainP.w, uStainWob, aa + .03);
      // 返修 3（style-14 / story-12）：墨更实（覆盖 0.95）、更冷更黑（压掉现实段暖调色的偏红），环心只淡一点（不再是一块红褐的圆疤）
      float ink = clamp(r.x * 1.2, 0., 1.) * .95 * uStain.w;
      float halo = (1. - smoothstep(1.0, 1.45, length(p))) * smoothstep(.7, 1.05, length(p)) * .26 * uStain.w;
      col = mix(col, vec3(lumS(col)) * .7, halo);
      col = mix(col, uStainCol * vec3(.78, .84, .92), ink);
      col = mix(col, mix(col, uStainCol * 1.25, .6), r.y * .5 * uStain.w * uStainP.y * (1. - r.x));
      float gl = (1. - smoothstep(.0, .16, length(p - vec2(-.32, .3)))) * uStainGloss * uStain.w;
      col = mix(col, vec3(.85, .88, .86), gl * .8);
    }
  }
  col *= uTint;
  // 边缘光：alpha 差分，指向光源；只落在墨线内侧，放在压暗之后（不被逆光压暗）
  if (uRimAmt > 0.) {
    float ao = texture2D(uMap, vUv + uRimOff).a;
    float rim = clamp(c.a - ao, 0., 1.) * (1. - inkLine);
    col = mix(col, uRimCol, smoothstep(.2, .7, rim) * uRimAmt);
  }
  if (uDap > 0.) {
    vec2 sp = vec2((gl_FragCoord.x - uRes.x * .5) / uK + 960., (uRes.y - gl_FragCoord.y) / uK);
    float bm = uBeam.w > 0. ? beamMask(sp) : 1.;
    float lm = mix(.08, 1., litM) * smoothstep(.12, .35, Y);     // 暗的头发、墨线上几乎不出光团
    // 衣褶：光斑沿亮度梯度错开一点（跟着褶子弯）
    vec2 e = vec2(3.) / uImg;
    vec2 gY = vec2(lumS(texture2D(uMap, vUv + vec2(e.x, 0.)).rgb) - lumS(texture2D(uMap, vUv - vec2(e.x, 0.)).rgb), lumS(texture2D(uMap, vUv + vec2(0., e.y)).rgb) - lumS(texture2D(uMap, vUv - vec2(0., e.y)).rgb));
    float d = dapples(vPx + vec2(gY.x, -gY.y) * uDapCell * 1.6, sp);
    // 右手食指尖：用 SEED_STAIN 的那一枚（和 S1 的墨渍同形同位）
    if (uDapTip.x > 0.) {
      vec2 p = (vPx - uDapTip) / (uDapR * .9); p.x /= 1.1;
      vec2 r = rosette(p, uDapTipSeed, .7, 1., 4., .45, .25, max(length(fwidth(vPx)), 1e-3) / uDapR);
      d = max(d, (r.x * .75 + r.y * .2) * uDapTipA);
    }
    float inBeam = bm * uDap;
    col = col * mix(1., .8, inBeam * (1. - d));                       // 光束里：叶影
    // 返修 3（story-04）：光团是"照亮"——按衣服本来的颜色提亮成暖色（布上的光），再加一点暖金的加色起晕；不再是一块不透明的奶白色
    col += col * uDapCol * d * inBeam * lm * 1.35 + uDapCol * d * d * inBeam * lm * .16;
  }
  col = mix(col, uFogCol, uFogAmt);
  gl_FragColor = vec4(col, a);
}`;

const FS_MASK = /* glsl */`
uniform sampler2D uMap; uniform float uOpacity;
varying vec2 vUv, vPx;
void main(){ if (texture2D(uMap, vUv).a * uOpacity < .5) discard; gl_FragColor = vec4(0.); }`;

const GEO = new THREE.PlaneGeometry(1, 1, 32, 32);

// 灰豹 / 金豹 四档色（DESIGN 3.3c）
export const LEO_G0 = ['#1F2424', '#555F5E', '#8C9390', '#B9BDB5'];
export const LEO_G1 = ['#1E2222', '#4B5458', '#C39A4E', '#E6D2A6'];

export function makeSprite(tex, inTex, { mode = 0, order = 10, poses = null, img = null } = {}) {
  const W = tex.image.width, H = tex.image.height;
  const v3 = (h) => lin3(h);
  const u = {
    uMap: { value: tex }, uIn: { value: inTex || tex },
    uImg: { value: new THREE.Vector2(W, H) }, uRect: { value: new THREE.Vector4(0, 0, W, H) },
    uFlip: { value: 0 }, uBA: { value: [...Array(NB)].map(() => new THREE.Vector4()) }, uBB: { value: [...Array(NB)].map(() => new THREE.Vector4()) },
    uSq: { value: new THREE.Vector4(0, 0, 1, 1) }, uBT: { value: [new THREE.Vector4(), new THREE.Vector4()] }, uBTR: { value: new THREE.Vector4() }, uShear: { value: new THREE.Vector2(0, 0) },
    uMode: { value: mode }, uOpacity: { value: 1 }, uErode: { value: 0 }, uBlur: { value: 0 },
    uThr: { value: new THREE.Vector3(.166, .332, .497) },
    uG0: { value: LEO_G0.map(v3) }, uG1: { value: LEO_G1.map(v3) }, uGold: { value: 0 },
    uEye: { value: new THREE.Vector4(0, 0, 0, 0) }, uEyeTilt: { value: 0 },
    uLit: { value: new THREE.Vector3(1, 1, 1) }, uShade: { value: new THREE.Vector3(1, 1, 1) }, uHT: { value: new THREE.Vector2(.65, .50) },
    uRimOff: { value: new THREE.Vector2(0, .004) }, uRimCol: { value: v3('#F3D27A') }, uRimAmt: { value: 0 },
    uTint: { value: new THREE.Vector3(1, 1, 1) }, uFogCol: { value: v3('#D5E2DA') }, uFogAmt: { value: 0 },
    uSpot: { value: 0 }, uCell: { value: 50 }, uDry: { value: 0 }, uWetA: { value: .42 }, uFlow: { value: 0 }, uFlowT: { value: 0 }, uHeartA: { value: .55 }, uSpotScale: { value: 1 }, uSolid: { value: 0 }, uHead: { value: new THREE.Vector3(0, 0, 0) }, uTorso: { value: new THREE.Vector4() }, uTorsoR: { value: 0 }, uDof: { value: 0 }, uWave: { value: new THREE.Vector3(0, 0, 0) }, uWaveW: { value: 0 },
    uFlowDir: { value: new THREE.Vector2(-.8, .6).normalize() },
    uRingCol: { value: v3('#1E2222') }, uHeartCol: { value: v3('#9C7438') }, uWetCol: { value: v3('#2B3434') }, uFlowCol: { value: v3('#F2CD6A') },
    uEx0: { value: new THREE.Vector4() }, uEx1: { value: new THREE.Vector4() },
    uStain: { value: new THREE.Vector4(0, 0, 10, 0) }, uStainP: { value: new THREE.Vector4(.6, .85, 3, .42) }, uStainSeed: { value: 7 }, uStainWob: { value: .25 }, uStainCol: { value: v3('#23272B') }, uStainGloss: { value: 0 },
    uSilCol: { value: v3('#45545C') }, uDap: { value: 0 }, uDapCell: { value: 46 }, uDapT: { value: 0 }, uDapR: { value: 12 }, uDapCol: { value: v3('#FBDC92') }, uDapTip: { value: new THREE.Vector2(0, 0) }, uDapTipSeed: { value: 7 }, uDapTipA: { value: .7 },
    uBeam: { value: new THREE.Vector4(0, 0, 0, 0) }, uInkGrow: { value: 0 }, uRes: { value: new THREE.Vector2(innerWidth, innerHeight) }, uK: { value: innerHeight / 1040 },
  };
  const mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const mmat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS, fragmentShader: FS_MASK, colorWrite: false, depthWrite: true, side: THREE.DoubleSide });
  const color = new THREE.Mesh(GEO, mat), mask = new THREE.Mesh(GEO, mmat);
  color.renderOrder = order; mask.renderOrder = order - 0.5;
  color.frustumCulled = mask.frustumCulled = false;
  color.userData.outline = false; color.userData.outlineOccluder = 'soft';
  mask.userData.outline = false; mask.userData.outlineOccluder = false;
  const g = new THREE.Group(); g.add(mask, color);
  g.userData.outline = false;
  const S = { group: g, color, mask, u, W, H, poses: poses || {}, pose: null, aspect: W / H, order };
  // 换姿态：rect = [x0, y0, w, h]（像素）
  S.setRect = r => { u.uRect.value.set(r[0], r[1], r[2], r[3]); S.aspect = r[2] / r[3]; };
  S.setPose = name => { if (S.pose === name) return; const p = S.poses[name]; S.pose = name; S.setRect(p.rect); if (p.thr) u.uThr.value.set(...p.thr); if (p.cell) u.uCell.value = p.cell;
    if (p.eye) { u.uEye.value.set(...p.eye); u.uEyeTilt.value = p.eyeTilt || 0; } else u.uEye.value.set(0, 0, 0, 0);
    if (p.ex0) u.uEx0.value.set(...p.ex0); else u.uEx0.value.set(0, 0, 0, 0);
    if (p.ex1) u.uEx1.value.set(...p.ex1); else u.uEx1.value.set(0, 0, 0, 0);
    // 头部（颈根以上）一律实心小点：半径取头心到颈根的距离
    if (p.head_center && p.neck_root) u.uHead.value.set(p.head_center[0], p.head_center[1], Math.hypot(p.head_center[0] - p.neck_root[0], p.head_center[1] - p.neck_root[1]) * 1.05); else u.uHead.value.set(0, 0, 0);
    // 躯干胶囊：颈根往尾根方向收进 12%、尾根往颈根收进 6%，半径 = 脊线到腹线的平均距离 × 0.62（四肢、头颈在外面）
    if (p.torso) { u.uTorso.value.set(...p.torso.a, ...p.torso.b); u.uTorsoR.value = p.torso.r; } else { u.uTorso.value.set(0, 0, 0, 0); u.uTorsoR.value = 0; } };
  S.clearBones = () => { for (let i = 0; i < NB; i++) { u.uBA.value[i].set(0, 0, 0, 0); u.uBB.value[i].set(0, 0, 0, 0); } u.uSq.value.set(0, 0, 1, 1); u.uShear.value.set(0, 0); u.uBTR.value.set(0, 0, 0, 0); };
  // 平移骨：i = 0 / 1，区域中心、半径 r0..r1（像素）、位移 (dx, dy)（像素）
  S.boneT = (i, center, r0, r1, dx, dy) => { u.uBT.value[i].set(center[0], center[1], dx, dy); if (i === 0) { u.uBTR.value.x = r0; u.uBTR.value.y = r1; } else { u.uBTR.value.z = r0; u.uBTR.value.w = r1; } };
  // 骨：i 号，pivot、区域中心（像素）、半径 r0..r1（像素）、角度（度，屏幕上顺时针为正）、缩放增量
  S.bone = (i, pivot, center, r0, r1, angDeg = 0, scale = 0) => { u.uBA.value[i].set(pivot[0], pivot[1], center[0], center[1]); u.uBB.value[i].set(r0, r1, angDeg * Math.PI / 180, scale); };
  S.squash = (anchor, sx, sy) => u.uSq.value.set(anchor[0], anchor[1], sx, sy);
  S.visible = v => { g.visible = v; };
  return S;
}

// 立在地面上的精灵：脚底中心 foot（世界坐标），世界高 h，朝向相机（只转偏航）
const _q = new THREE.Vector3();
export function standAt(S, cam, foot, h, { flip = false, lean = 0 } = {}) {
  const w = h * S.aspect;
  S.group.position.set(foot.x, foot.y + h / 2, foot.z);
  const yaw = Math.atan2(cam.position.x - foot.x, cam.position.z - foot.z);
  S.group.rotation.set(lean, yaw, 0, 'YXZ');
  S.group.scale.set(w, h, 1);
  S.u.uFlip.value = flip ? 1 : 0;
}
// 正对相机的精灵：屏幕设计像素 (cx, cy) 为中心，屏幕高 hpx，深度 D；rot：屏幕内旋转（度，逆时针为正）
export function faceCam(S, cam, cx, cy, hpx, D, { flip = false, rot = 0 } = {}) {
  const hh = D * Math.tan(cam.fov * Math.PI / 360), hw = hh * cam.aspect, Wd = 1040 * cam.aspect;
  const x = (cx - 960) / (Wd / 2) * hw, y = (0.5 - cy / 1040) * 2 * hh;
  const h = hpx / 1040 * 2 * hh, w = h * S.aspect;
  S.group.position.set(x, y, -D).applyMatrix4(cam.matrixWorld);
  cam.getWorldQuaternion(S.group.quaternion);
  if (rot) S.group.rotateZ(rot * Math.PI / 180);
  S.group.scale.set(w, h, 1);
  S.u.uFlip.value = flip ? 1 : 0;
}
// 边缘光的 uv 偏移：屏幕上指向光源的单位方向 (lx, ly)（y 向上），宽 wpx（实际像素），精灵屏幕高 hpx（实际像素）
export function rimOffset(S, lx, ly, wpx, hpx) {
  const r = S.u.uRect.value, img = S.u.uImg.value, tpx = r.w / Math.max(hpx, 1);
  const fl = S.u.uFlip.value > .5 ? -1 : 1;
  S.u.uRimOff.value.set(fl * lx * wpx * tpx / img.x, ly * wpx * tpx / img.y);
}

// 接触阴影：地面上的乘法椭圆
export function contactShadow(order = 9) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: { uCol: { value: lin3('#1D2B2E') }, uA: { value: .45 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: 'uniform vec3 uCol; uniform float uA; varying vec2 vUv; void main(){ float r = length((vUv - .5) * 2.); float a = (1. - smoothstep(.6, 1., r)) * uA; gl_FragColor = vec4(uCol, a); }',
    transparent: true, depthWrite: false,
  }));
  m.rotation.x = -Math.PI / 2; m.renderOrder = order; m.frustumCulled = false;
  m.userData.outline = false; m.userData.outlineOccluder = false;
  return m;
}

// 体内度贴图：把 alpha 模糊（半径 r 像素），给豹斑决定大斑 / 小斑
export function interiorTex(img, r) {
  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const g = cv.getContext('2d'); g.filter = `blur(${r}px)`; g.drawImage(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  return t;
}
