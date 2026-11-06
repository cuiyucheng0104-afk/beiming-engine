// 《豹变》A 水墨 · 后期链（DESIGN 3.3，从 _lib/look.js 的思路改写；关掉 Kuwahara、描边、bloom、paper.png）
//   合成（两个世界 / 门户 / 遮罩换场 / 屏幕空间机关 / 2D 画布层）→ 柔焦 → 洇（连续衰减 + 1K 小模糊）→ 水渍边 → 调色 → 墨粒 → 字幕 → 宣纸纹 → 纸边吃墨 → 颗粒 → 屏幕
// 所有屏幕量按 K = H/1040 缩放（look.js 原来的 H/1080 全部改成 1040 口径）；噪声按 q = gl_FragCoord.xy / K 取。
import * as THREE from 'three';
import { U, K, DW, DH } from './core.js';
import { NOISE, PALETTE, ROSETTE, CAULI, VS_FS } from './glsl.js';

export const NCAP = 8, NDOT = 8, NLEAF = 128, NSL = 32;

// ───────── 合成 ─────────
const COMP_FS = /* glsl */`
${NOISE}
${PALETTE}
${CAULI}
${ROSETTE}
uniform sampler2D tA, tB, tM, tOver;
uniform float uMixB, uPortal, uOverOn, uFadeP, uLineM, uExpo;
uniform vec4 uMixM;                  // 遮罩换场：开关、进度（遮罩 = tM.a，近云的遮挡）
uniform vec4 uT1;                    // 开关、墨晕半径 R、显山横缝半高 Q、崖区晚退系数
uniform vec4 uCap[${NCAP}];          // 爻条胶囊（设计像素，y 向下）：x0 y0 x1 y1（f94 定格：决定墨洇到哪儿）
uniform vec4 uCap2[${NCAP}];         // 当前六道线的胶囊：决定墨在哪儿最浓（墨跟着线走，不出双轮廓）
uniform vec4 uCapR;                  // 胶囊半粗、纸路门槛、墨浓上限、浓淡衰减长度 λ
uniform vec4 uT1X;                   // 前沿水渍边量、显山退墨边量、—、—
uniform float uT1Out;                // 1 = 距离取 tM.g（眼孔 SDF），墨只往孔外洇
uniform vec4 uRev;                   // 退墨：开关、τ
uniform vec4 uLeaf;                  // S6 叶影：开关、强度、域扭曲相位、摇曳
uniform vec4 uLeafB[${NLEAF}];       // 叶：x y 半长 转角
uniform vec4 uLeafC[${NLEAF}];       // 叶：墨量、半宽比、—、—
uniform int uNLeaf;
uniform vec4 uSpotL[${NSL}];         // 光斑（叶影里的空洞）：x y R 竖向压扁
uniform vec4 uSpotF[${NSL}];         // 类型（1 = 边上几段墨弧）、相位、段数、—
uniform int uNSpotL;
uniform vec4 uLight2;                // 指尖那一圈光（种子 7）：x y R prog
uniform vec4 uDot[${NDOT}];          // S5 尾迹墨点：x y R prog
uniform int uNDot;
uniform vec4 uEye;                   // T2 代码豹眼：开关、虹膜半径、瞳孔比、提亮
uniform vec4 uEyeP;                  // 近眼心 x y、杏仁半长、杏仁半高
uniform vec4 uEye2;                  // 远眼：x y — 开关
uniform vec4 uEye2B;                 // 远眼长轴方向（屏幕单位向量）、长轴 / 短轴换算到近眼坐标的倍数
uniform vec4 uEye2C;                 // 远眼瞳孔偏移（近眼坐标）
uniform vec3 uIris;
uniform vec4 uBand;                  // 光带：开关、位置 s、宽、亮度
uniform vec4 uBandR;                 // 光带作用区：0 眼 / 1 镜片；镜片圆心 x y、半径
uniform vec4 uFlare;                 // 光芯：x y 强度 外晕强度
uniform vec4 uLens;                  // S6 镜片：弧心 x y、半径、镜面反光量
uniform vec4 uWin;                   // 窗光：开关、强度、叶影强度、相位
uniform vec4 uArcs;                  // 镜框虚弧：不透明度
uniform vec4 uRim;                   // S3d→S4 四周残墨：量
uniform vec4 uGlint;                 // 镜片一闪（四芒留白星光）：x y R 强度
uniform vec4 uGlintL;                // 镜片暗反光托底：x y R 量
varying vec2 vUv;
float capD(vec2 p, vec4 c){ vec2 a = c.xy, b = c.zw, pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0., 1.); return length(pa - ba * h); }
vec3 screenB(vec3 a, vec3 b){ return 1. - (1. - a) * (1. - b); }
float star4(vec2 d, float R, float ang){
  float ca = cos(ang), sa = sin(ang);
  vec2 r = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y);
  float core = exp(-pow(length(d) / (R * .22), 2.));
  float a1 = exp(-pow(r.y / (R * .045 + 1.), 2.)) * exp(-pow(r.x / R, 2.));
  float a2 = exp(-pow(r.x / (R * .045 + 1.), 2.)) * exp(-pow(r.y / R, 2.));
  return core + .85 * (a1 + a2);
}
void main(){
  vec2 q = gl_FragCoord.xy / uK;
  vec2 pd = vec2(q.x, ${DH}. - q.y);
  vec3 c = texture(tA, vUv).rgb;
  if (uMixB > 0.) c = mix(c, texture(tB, vUv).rgb, uMixB);
  if (uMixM.x > .5) {                                                       // 云后换场：近云遮得越厚，越先换成后一个世界
    float cov = texture(tM, vUv).a;
    float k = smoothstep(0., 1., (cov - 1. + 2.2 * uMixM.y) / .45);
    c = mix(c, texture(tB, vUv).rgb, clamp(k, 0., 1.));
  }
  if (uPortal > 0.) c = mix(c, texture(tB, vUv).rgb, texture(tM, vUv).r * uPortal);

  // T1：墨从六爻洇开（心浓边淡、前沿水渍边、花椰菜边、留纸路）→ 横缝显山（同一套花椰菜边）
  if (uT1.x > .5) {
    float d;
    if (uT1Out > .5) d = (1. - texture(tM, vUv).g) * 400.;
    else { d = 1e5; for (int i = 0; i < ${NCAP}; i++) d = min(d, capD(pd, uCap[i]) - uCapR.x); }
    float R = uT1.y;
    float n = cauliN(q, 62. * (.35 + .65 * min(1., R / 220.)), 3.5, 91u);
    float fr = R - d + n;
    float B = (uT1Out > .5 ? smoothstep(-3.5, 3.0, fr) : smoothstep(-2.5, 2.5, fr)) * step(.5, R);
    float dD = d;
    if (uT1X.z > .5) { dD = 1e5; for (int i = 0; i < ${NCAP}; i++) dD = min(dD, capD(pd, uCap2[i]) - uCapR.x); }
    float Db = uT1X.w > 0. ? uT1X.w : .30;                                             // 眼孔墨晕（返修第 3 轮）外圈也到重墨
    float Dk = Db + (uCapR.z - Db) * exp(-max(dD, 0.) / max(uCapR.w, 1.));       // 心浓（焦）边淡（淡）
    Dk += .06 * (vn2(q / 40., 95u) - .5);
    Dk *= .86 + .28 * vn2(q / 130., 99u);
    // 前沿深一阶：T1 照旧；眼孔墨晕（返修 w3 v3-09）改成 3–5K 宽、往里渐淡的水渍边（原来是一道细而锐利的深线，读成烧穿的纸洞）
    float D = Dk + uT1X.x * (uT1Out > .5 ? smoothstep(0., 2.5, fr) * exp(-max(fr - 2.5, 0.) / 5.) : exp(-pow((fr - 5.) / 4., 2.)));
    if (uCapR.y < 1.) {                                                     // 纸路：短而碎的留白，边上一道深边
      vec2 rw = vec2(fbm2(q / 160., 93u), fbm2(q / 160. + 3.3, 94u)) * 12.;
      float ra = 1.4 * fbm2(q / 380., 88u);                                   // 返修第 2 轮（v1-02）：纸丝少而不规则、方向各不相同（不再是一排排平行短划）
      vec2 qr = mat2(cos(ra), sin(ra), -sin(ra), cos(ra)) * (q + rw);
      float rn = fbm2(qr / vec2(170., 15.), 96u) + .40 * (smoothstep(-.1, .4, fbm2(q / 300., 89u)) - .5) - .25 * smoothstep(.55, .85, Dk) - .30;

      float on = smoothstep(80., 260., R);
      float road = smoothstep(uCapR.y - .025, uCapR.y + .025, rn) * on;
      float roadEdge = smoothstep(uCapR.y - .10, uCapR.y - .015, rn) * (1. - road) * on;
      D = mix(D + .05 * roadEdge, 0., road);
    }
    D += .07 * (vn2(q / 1.6, 97u) - .5) * step(.05, D);
    float Rv = 0.;
    if (uT1.z > 0.) {
      float fv = uT1.z - abs(pd.y - 425.) + cauliN(q + 37.1, 58., 3.5, 141u);
      Rv = smoothstep(-2.5, 2.5, fv);
      D += uT1X.y * exp(-pow((fv + 6.) / 5., 2.)) * (1. - Rv);
    }
    float cliffM = (1. - smoothstep(880., 1160., pd.x + 70. * fbm2(q / 90., 98u))) * smoothstep(300., 560., pd.y);
    Rv = mix(Rv, Rv * uT1.w, cliffM);
    float outside = uT1Out > .5 ? (1. - texture(tM, vUv).r) * texture(tM, vUv).b : 1.;   // 眼孔墨晕：不进眼孔、只洇在面具上
    float k = B * (1. - Rv) * outside;
    c = mix(c, rampS(clamp(D, 0., 1.)), k);
  }

  // S6 叶荫 + 光斑（母型第三次：光）
  // 返修 w3（v3-02 ③ / qa2-04）：原来叶荫是几十个大圆点的并集，衬衫上整片一个灰度、强度只有三成，读不出叶形，光斑像贴在衬衫上的发光圆片。
  //   改成一片片尖椭圆的叶形淡墨相互叠墨（每片各自一道软边和很淡的水渍边，叠得多的地方深一档）：一眼看得出是叶子的影子；
  //   光斑是叶荫里漏下来的暖光——光心往藤黄走（不是白）、外面一圈软晕、大小和形状各不相同；边上断开的淡墨环（母型 R 光斑模式）改成淡墨，不再发褐
  if (uLeaf.x > .5) {
    vec2 wv = vec2(fbm2(q / 300. + vec2(uLeaf.z, 0.), 103u), fbm2(q / 300. + vec2(0., uLeaf.z) + 5.3, 104u)) * 5.;
    vec2 pw = pd + wv;
    float T = 1., rimS = 0.;
    for (int i = 0; i < ${NLEAF}; i++) {
      if (i >= uNLeaf) break;
      vec4 Lb = uLeafB[i], Lc = uLeafC[i];
      float fi = float(i);
      vec2 d = pw - Lb.xy - vec2(uLeaf.w * (4. + 5. * hS(fi, 5.)), uLeaf.w * 1.5 * (hS(fi, 6.) - .5));
      if (dot(d, d) > 1.3 * Lb.z * Lb.z) continue;
      float ca = cos(Lb.w), sa = sin(Lb.w);
      vec2 e = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y) / Lb.z;           // 叶长轴 = e.x（两头尖），e.y 是叶宽方向
      float hw = Lc.y * pow(max(1. - e.x * e.x, 0.), .72) * (1. + .12 * e.x);     // 叶宽：中间宽、两头收尖，叶柄一头略宽
      float v = hw - abs(e.y + .05 * e.x * e.x * (hS(fi, 8.) - .5) * 4.) + .045 * (vn2(e * 3.2 + fi * 1.7, 105u) - .5) + .02 * (vn2(e * 9. + fi, 106u) - .5);
      float dpx = v * Lb.z;                                                       // 到叶边的设计像素（近似）
      float m = smoothstep(-4.5, 4.5, dpx);                                       // 叶荫的边放虚约 9K（是影子，不是印在衣服上的花）
      float rim = m * exp(-max(dpx, 0.) / 4.);
      T *= 1. - Lc.x * (m * .90 + .16 * rim);
      rimS = max(rimS, rim * Lc.x);
    }
    float shade = 1. - T;
    float hole = 0., arcs = 0., glow = 0., halo = 0.;
    for (int i = 0; i < ${NSL}; i++) {
      if (i >= uNSpotL) break;
      vec4 S = uSpotL[i], F = uSpotF[i];
      vec2 d = pw - S.xy;
      float fi = float(i);
      float an0 = 6.2831853 * hS(fi, 11.);                                       // 每个光斑各自一个长轴方向、长短比
      float el = 1. + .35 * hS(fi, 12.);
      d = vec2(cos(an0) * d.x + sin(an0) * d.y, -sin(an0) * d.x + cos(an0) * d.y);
      d.x /= el; d.y /= S.w;
      float R = S.z * (1. + .06 * sin(6.2831853 * .7 * uT + hS(fi, 9.) * 6.28));
      if (dot(d, d) > 4.2 * R * R) continue;
      float an = atan(d.y, d.x);
      float rr = length(d) / R * (1. + .14 * sin(an * 2. + fi * 1.3) + .07 * sin(an * 3. + fi)) + .10 * (vn2(d / (.35 * R) + fi * 1.7, 107u) - .5);
      float st = F.w > 0. ? F.w : 1.;
      hole = max(hole, (1. - smoothstep(.55, 1.05, rr)) * st);
      glow = max(glow, (1. - smoothstep(.05, .85, rr)) * st);
      halo = max(halo, (1. - smoothstep(.9, 1.9, rr)) * st);
      vec4 rg = rosette(d * 1.12, R, F.y, 3., 1.);
      arcs = max(arcs, rg.x * st);
    }
    float ring7 = 0., l2 = 0., h2 = 0.;
    if (uLight2.w > 0.) {                                                    // 指尖那一圈（种子 7）：唯一完整的环斑；晕开 6 帧、收紧 6 帧；断环淡墨、外加一圈暖晕
      vec2 p = pd - uLight2.xy;
      float pr = uLight2.w;
      float Rr = uLight2.z * (pr < .5 ? mix(.30, 1.35, pr / .5) : mix(1.35, 1., clamp((pr - .5) / .5, 0., 1.)));
      vec4 r = rosette(p * uLight2.z / max(Rr, 1.), uLight2.z, 7., 3., 1.);
      l2 = 1. - smoothstep(.45 * Rr, .95 * Rr, length(p));
      h2 = 1. - smoothstep(.9 * Rr, 1.9 * Rr, length(p));
      hole = max(hole, l2);
      ring7 = r.x * smoothstep(.35, .85, pr);
    }
    vec3 tint = uPal[2] / max(uPal[0], vec3(.01));
    float k = uLeaf.y * shade * (1. - hole) + .08 * rimS * (1. - hole);
    c *= mix(vec3(1.), tint, clamp(k, 0., .92));
    vec3 warm = vec3(.914, .839, .635);                                        // 藤黄光 #E9D6A2
    c = mix(c, mix(c * 1.05, warm * 1.02, .55), clamp(glow * .90 * (1. - arcs * .8), 0., 1.));
    c = mix(c, mix(c, warm, .35), clamp(halo * .30 * (1. - hole), 0., 1.));     // 光心外一圈软晕：叶荫里亮开一点、往暖走
    c = mix(c, mix(c * 1.06, warm * 1.04, .60), l2 * .95);
    c = mix(c, mix(c, warm, .30), h2 * .35 * (1. - l2));
    c *= mix(vec3(1.), uPal[2] / max(uPal[0], vec3(.01)), clamp(.58 * arcs * max(shade * 1.4, .60), 0., .7));   // 断开的环：淡墨（光做成的豹斑，远看也读得出一圈）
    c *= mix(vec3(1.), uPal[2] / max(uPal[0], vec3(.01)), clamp(ring7 * .62, 0., .7));
  }

  // S5 尾迹墨点：同一套减色叠墨（纸上就是淡墨晕 + 浓墨块），只在落下那几帧晕开
  for (int i = 0; i < ${NDOT}; i++) {
    if (i >= uNDot) break;
    vec4 Dt = uDot[i];
    if (Dt.w <= 0.) continue;
    vec2 p = pd - Dt.xy;
    if (dot(p, p) > 6.5 * Dt.z * Dt.z) continue;
    vec4 r = rosette(p, Dt.z, 300. + float(i) * 17., 2.3, Dt.w);          // 返修第 2 轮：落点溅墨、湿墨浓（不再是素灰圆片）
    float Db = inkD(c);
    float ink = clamp(r.x + r.z, 0., 1.);
    float D = 1. - (1. - Db) * (1. - .9 * ink);
    D = 1. - (1. - D) * (1. - r.w * .8);
    c = mix(c, rampS(D), clamp(ink + r.w * 2., 0., 1.));
  }

  // T2 代码豹眼：眼眶按焦墨笔线（上睑厚、下睑断开一段）；远眼同一画法
  // 返修 w3（v3-01 / qa2-11）：原来虹膜是一块边缘锋利、平涂饱和的橙色圆盘，瞳孔上叠着光带的平滑渐变（像玻璃珠），高光是一颗锐利白点——
  //   读成卡通眼。改成参考里鹬眼那种画法：虹膜是一团淡彩洇块（心浅边深、外沿 2–3K 不规则洇边、带墨粒、饱和降一档，仍是全片最亮的彩点），
  //   瞳孔平涂焦墨（软边、没有渐变），高光是一小块不规则的留纸；光带只在虹膜上留一道纸色细条（不压到瞳孔上）；远眼边更软
  if (uEye.x > .5) {
    for (int e = 0; e < 2; e++) {
      if (e == 1 && uEye2.w < .5) break;
      vec2 ctr = e == 0 ? uEyeP.xy : uEye2.xy;
      float sft = e == 0 ? 1. : 1.7;
      vec2 p = (pd - ctr) / vec2(1., 1.08);
      vec2 pr = vec2(p.x * .985 + p.y * .17, -p.x * .17 + p.y * .985);
      vec2 pupO = vec2(0.);
      if (e == 1) {                                                            // 返修 w3（v3-01）：远眼按原画那只侧过去的窄眼摆——长轴近竖直、横向压窄，瞳孔偏向内侧
        vec2 d = pd - ctr, u = uEye2B.xy, w = vec2(u.y, -u.x);
        p = vec2(dot(d, u) * uEye2B.z, dot(d, w) * uEye2B.w); pr = p;
        pupO = uEye2C.xy;
      }
      float ax = uEyeP.z, ay = uEyeP.w;
      float Rl = (ax * ax + ay * ay) / (2. * ay);
      float d1 = length(pr - vec2(0., Rl - ay)) - Rl, d2 = length(pr + vec2(0., Rl - ay)) - Rl;
      float alm = max(d1, d2) + 1.2 * (vn2(pd / 3.5, 141u) - .5);
      float inside = 1. - smoothstep(-2. * sft, 1.2 * sft, alm);
      float R = uEye.y;
      // 虹膜洇块：外沿按两级噪声起伏 2–3K（不是圆规画的圆），过渡约 4K 宽
      float ir = length(p) + 4.0 * (vn2(p / 9. + float(e) * 9., 143u) - .5) + 1.6 * (vn2(p / 2.6 + float(e) * 3., 147u) - .5);
      float iris = 1. - smoothstep(R - 6.0 * sft, R + 2.5 * sft, ir);
      vec3 amb = mix(vec3(lum(uIris)), uIris, .80) * (1. + .10 * uEye.w);           // 饱和降一档；f639–f642 只提亮一成
      float rr = clamp(length(p) / R, 0., 1.);
      vec3 ic = mix(mix(amb, uPal[0], .26), amb * .84, smoothstep(.30, .92, rr));     // 心浅（掺一点纸色）、边深
      ic *= mix(.86, 1.05, smoothstep(-.9 * R, .7 * R, p.y));                          // 上睑压着的那一半深一点，下半透光
      ic *= .92 + .16 * vn2(p / 13. + float(e) * 2.1, 153u);                            // 淡彩不匀：一块块的浓淡（不是一层平涂）
      ic *= 1. - .26 * exp(-pow((ir - (R - 4.)) / 3.0, 2.));                           // 外沿一道更深的水渍边（颜料往边上走）
      ic *= .94 + .11 * vn2(pd / 1.3 + float(e) * 7., 148u) + .07 * (vn2(pd / 4.5 + 3., 149u) - .5);   // 墨粒：颜料沉在纸纹里的颗粒
      c = mix(c, mix(uPal[4], uIris * .55, .35), inside * (1. - iris));
      c = mix(c, ic, iris * inside);
      // 瞳孔：平涂焦墨，边上 1–1.5K 洇开，不做任何渐变
      float pupR = R * uEye.z;
      float pp = length(p - pupO) + 1.4 * (vn2(p / 3.2 + float(e) * 5., 151u) - .5);
      float pup = 1. - smoothstep(pupR - 1.6 * sft, pupR + 1.0 * sft, pp);
      c = mix(c, uPal[5], pup * inside);
      // 高光：虹膜左上一小块不规则的留纸（形状按噪声撕开，不是圆点；一闪时略微张大）
      vec2 hp = p - vec2(-R * .36, -R * .40);
      float hn = length(hp * vec2(1., 1.35)) + 4.2 * (vn2(hp / 3.6 + float(e) * 4., 144u) - .5) + 1.8 * (vn2(hp / 1.4 + float(e), 152u) - .5);
      float hr = (e == 0 ? 7.5 : 5.5) * (1. + .30 * uEye.w);
      c = mix(c, uPal[0] * 1.02, (1. - smoothstep(hr - 1.4, hr + 1.2, hn)) * inside * .93);
      float ang = atan(pr.y, pr.x);
      float wv = 1. + .6 * (vn2(vec2(ang * 3., float(e) * 5.), 145u) - .5);
      bool upper = pr.y < 0.;
      float w = (upper ? 4.0 : 1.9) * wv;
      float brk = upper ? 1. : step(.36, vn2(vec2(ang * 2.6, 7. + float(e)), 146u));
      c = mix(c, uPal[5], (1. - smoothstep(w * .5, w * .5 + 1.2, abs(alm + w * .35))) * brk * .95);
    }
  }
  if (uLens.w > 0.) {                                                        // S6 镜片：弧内一层镜面反光，映一点桌面暖色
    float r = length(pd - uLens.xy);
    float inL = 1. - smoothstep(uLens.z - 3., uLens.z + 1., r);
    c = mix(c, c * .93 + vec3(.06, .045, .02), inL * uLens.w);
  }
  if (uBand.x > .5) {
    vec2 n = vec2(.81915, .57358);
    float s = dot(pd, n) - uBand.y + 3.0 * (vn2(pd / 3.4, 161u) - .5) + 1.6 * (vn2(pd / 1.2, 162u) - .5);   // 返修 w3（qa2-11）：光带边按纸纹扰动
    float b = exp(-pow(s / uBand.z, 2.)) * uBand.w;
    float region;
    if (uBandR.x < .5) {                                                       // 返修 w3（v3-01）：豹眼里只落在虹膜上，不压瞳孔（瞳孔保持平涂焦墨）
      float dE = length(pd - uEyeP.xy);
      region = (1. - smoothstep(uEye.y * .90, uEye.y * 1.02, dE)) * smoothstep(uEye.y * uEye.z + 1., uEye.y * uEye.z + 4., dE);
    }
    else region = 1. - smoothstep(uBandR.w - 4., uBandR.w + 2., length(pd - uBandR.yz));
    c = mix(c, mix(c, uPal[0] * 1.06, .85), clamp(b * region, 0., 1.));      // 留白：光带就是没上色的纸
  }
  if (uFlare.z > 0. || uFlare.w > 0.) {
    vec2 d = pd - uFlare.xy;
    float r = length(d);
    c = screenB(c, vec3(.98, .96, .9) * (uFlare.z * star4(d, 26., .35) * .7 + uFlare.w * exp(-pow(r / 70., 2.))));
  }
  if (uGlintL.w > 0.) {
    float r = length(pd - uGlintL.xy);
    c *= 1. - uGlintL.w * (1. - smoothstep(uGlintL.z * .80, uGlintL.z, r));
  }
  if (uGlint.w > 0.) c = screenB(c, vec3(.98, .96, .92) * uGlint.w * star4(pd - uGlint.xy, uGlint.z, .38));

  // S1 窗光与极淡叶影（右上）
  if (uWin.x > .5) {
    float wl = smoothstep(.0, 1., 1. - length((pd - vec2(1980., -80.)) / vec2(1500., 1100.)));
    c = mix(c, c * 1.04 + uPal[0] * .02, wl * uWin.y);
    float lf = smoothstep(.1, .5, fbm2(q / 140. + vec2(uWin.w, uWin.w * .4), 121u));
    c *= 1. - uWin.z * lf * wl;
  }
  if (uArcs.x > 0.) {
    float a1 = abs(length(pd - vec2(-1150., 520.)) - 1300.), a2 = abs(length(pd - vec2(3070., 520.)) - 1300.);
    float arc = exp(-pow(min(a1, a2) / 78., 2.)) * (.85 + .15 * vn2(pd / 30., 122u));
    c = mix(c, uPal[2], arc * uArcs.x);
  }
  if (uRim.x > 0.) {                                                         // 残墨：四周 4 团带水渍边的大墨团，被雨丝冲淡
    float m = 0., ed = 0.;
    for (int i = 0; i < 4; i++) {
      vec2 ctr = i == 0 ? vec2(-60., -40.) : i == 1 ? vec2(1990., -30.) : i == 2 ? vec2(-50., 1090.) : vec2(1985., 1080.);
      vec2 rad = i == 0 ? vec2(560., 360.) : i == 1 ? vec2(520., 330.) : i == 2 ? vec2(540., 350.) : vec2(560., 370.);
      float rr = length((pd - ctr) / rad) + cauliN(q + float(i) * 31., 40., 3., 131u) / 300.;
      float mm = 1. - smoothstep(.86, 1.0, rr);
      m = max(m, mm); ed = max(ed, smoothstep(.70, .97, rr) * mm);
    }
    float wash = smoothstep(.55, .9, vn2(vec2((pd.x + pd.y * .32) / 7., pd.y / 90.), 133u));
    float D = (.62 + .26 * uRim.x + .18 * ed) * (1. - .45 * wash * (1. - uRim.x));
    c = mix(c, rampS(D), m * uRim.x);
  }

  c *= uExpo;
  if (uOverOn > .5) {
    vec4 o = texture(tOver, vUv);
    if (uLineM > 0.) o.a *= 1. - uLineM * texture(tM, vUv).a;
    c = mix(c, o.rgb, o.a);
  }
  // 退墨回纸（放在最后：光斑、墨点、叠加层上的眼镜一起退；返修 w3 qa2-07：原来叠加层在退墨之后才叠，镜框细弧单独悬在纸上）
  if (uRev.x > .5) {
    float D = inkD(c);
    float keep = smoothstep(uRev.y - .08, uRev.y + .08, D + .06 * fbm2(q / 20., 98u));
    c = mix(uPal[0], c, keep);
  }
  if (uFadeP > 0.) c = mix(c, uPal[0], uFadeP);
  gl_FragColor = vec4(c, 1.);
}`;

// ───────── 模糊 ─────────
const DOWN_FS = /* glsl */`uniform sampler2D tIn; uniform vec2 uTex; varying vec2 vUv;
void main(){ vec3 c = texture(tIn, vUv + vec2(-.5, -.5) * uTex).rgb + texture(tIn, vUv + vec2(.5, -.5) * uTex).rgb + texture(tIn, vUv + vec2(-.5, .5) * uTex).rgb + texture(tIn, vUv + vec2(.5, .5) * uTex).rgb; gl_FragColor = vec4(c * .25, 1.); }`;
const BLUR_FS = /* glsl */`uniform sampler2D tIn; uniform vec2 uDir; uniform float uSig; varying vec2 vUv;
void main(){
  float s = max(uSig, .35); int n = int(ceil(s * 2.6));
  vec4 acc = texture(tIn, vUv); float ws = 1.;
  for (int i = 1; i <= 48; i++) { if (i > n) break; float fi = float(i); float w = exp(-.5 * fi * fi / (s * s));
    acc += w * (texture(tIn, vUv + uDir * fi) + texture(tIn, vUv - uDir * fi)); ws += 2. * w; }
  gl_FragColor = acc / ws;
}`;
const COPY_FS = /* glsl */`uniform sampler2D tIn; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture(tIn, vUv).rgb, 1.); }`;

// ───────── 柔焦 + 洇：每个采样按距离连续衰减（不出等宽灰平台），暗化比例写进 alpha，最后一步再做 1K 小模糊 ─────────
const BLEED_FS = /* glsl */`
${NOISE}
uniform sampler2D tC, tBA;
uniform vec2 uRes;
uniform float uK, uSoft, uBR, uBA;
varying vec2 vUv;
void main(){
  vec3 c0 = texture(tC, vUv).rgb;
  vec3 c = mix(c0, texture(tBA, vUv).rgb, uSoft);
  float L = lum(c);
  float R = uBR * uK;
  vec2 q = gl_FragCoord.xy / uK;
  float ang = vn2(q / 18., 3u) * 12.566 + h21(ivec2(gl_FragCoord.xy), 5u) * 2.2;
  float dmin = L;
  for (int i = 0; i < 24; i++) {
    float fi = float(i);
    float a = ang + fi * 2.39996, rr = sqrt((fi + .5) / 24.);
    vec2 o = vec2(cos(a), sin(a)) * rr * R;
    float Ls = lum(texture(tC, vUv + o / uRes).rgb);
    float w = 1. - smoothstep(0., 1., rr);
    dmin = min(dmin, mix(L, Ls, w));
  }
  float k = uBA * smoothstep(.02, .22, L - dmin);
  float ratio = mix(1., dmin / max(L, 1e-3), k);
  gl_FragColor = vec4(c, ratio);
}`;

// ───────── 水渍边 → 调色 → 墨粒 → 字幕 → 宣纸纹 → 纸边吃墨 → 颗粒 ─────────
const FINAL_FS = /* glsl */`
${NOISE}
${PALETTE}
uniform sampler2D tD, tBB, tSub;
uniform vec2 uRes;
uniform float uWS, uG, uPaperS, uVig, uGrain, uSat, uSeed, uPaperSc, uClampHi, uSubOn;
uniform vec3 uWB;
uniform vec2 uPaperOff;
varying vec2 vUv;
float fiber(vec2 p){
  float f = 0.;
  for (int j = 0; j < 3; j++) {
    float a = 1.1 + float(j) * 2.13;
    vec2 r = vec2(cos(a) * p.x + sin(a) * p.y, -sin(a) * p.x + cos(a) * p.y);
    float n = vn2(vec2(r.x / (140. + 50. * float(j)), r.y / .85), 140u + uint(j));
    float m = vn2(vec2(r.x / 400., r.y / 60.), 150u + uint(j));
    f += (smoothstep(.86, .97, n) - smoothstep(.03, .10, n) * .6) * smoothstep(.35, .65, m);
  }
  return f;
}
void main(){
  vec4 c4 = texture(tD, vUv);
  vec2 px = uK * 1.0 / uRes;
  float rt = c4.a * .36 + (texture(tD, vUv + vec2(px.x, 0.)).a + texture(tD, vUv - vec2(px.x, 0.)).a + texture(tD, vUv + vec2(0., px.y)).a + texture(tD, vUv - vec2(0., px.y)).a) * .16;
  vec3 c = c4.rgb * rt;
  float L = lum(c);
  float Lb = lum(texture(tBB, vUv).rgb);
  float D = inkD(c);
  float E = L - Lb;
  c *= 1. + uWS * min(E, 0.) / max(L, .05) * smoothstep(.10, .16, D) * (1. - smoothstep(.80, .88, D));
  c *= uWB;
  float l = lum(c); c = mix(vec3(l), c, uSat);
  vec2 q = gl_FragCoord.xy / uK;
  float n1 = vn2(q / 1.4, 71u) * 2. - 1., n2 = vn2(q / 5., 72u) * 2. - 1.;
  D = inkD(c);
  c *= 1. + uG * 4. * D * (1. - D) * (.6 * n1 + .4 * n2);
  // 字幕：洇之后才叠（不出灰描边），自己带墨色不匀、局部飞白、1K 纤维毛边和一圈极淡的晕
  if (uSubOn > .5) {
    vec2 fo = (vec2(vn2(q / 2.2, 171u), vn2(q / 2.2 + 4.1, 172u)) - .5) * 0.8 * uK / uRes;
    vec4 sb = texture(tSub, vUv + fo);
    float a = sb.a;
    float inkv = .80 + .20 * vn2(q / 9., 173u);
    float dryM = smoothstep(.66, .86, vn2(vec2(q.x / 3.2 + q.y / 7., q.y / 18.), 174u)) * smoothstep(.55, .80, vn2(q / 30., 175u));
    a *= 1. - .40 * dryM;
    vec2 h = 2.2 * uK / uRes;
    float halo = (texture(tSub, vUv + vec2(h.x, 0.)).a + texture(tSub, vUv - vec2(h.x, 0.)).a + texture(tSub, vUv + vec2(0., h.y)).a + texture(tSub, vUv - vec2(0., h.y)).a) * .25;
    c *= 1. - .07 * max(halo - sb.a, 0.);
    c = mix(c, sb.rgb, clamp(a * inkv, 0., 1.));
  }
  vec2 pq = (q - uPaperOff) / uPaperSc;
  float pv = .014 * fiber(pq) + .04 * fbm2(pq / 220., 81u) + .015 * (vn2(pq / 1.1, 82u) * 2. - 1.);
  c *= 1. + pv * (uPaperS / .07) * (.55 + .45 * (1. - D));
  vec2 asp = vec2(uRes.x / uRes.y, 1.);
  vec2 dv = (vUv - .5) * asp;
  float r = length(dv) / length(asp * .5);
  float ang = atan(dv.y, dv.x);
  c *= 1. - uVig * smoothstep(.42, 1.12, r) * (1. + .25 * fbm2(vec2(ang * 3., 1.7), 161u));
  ivec2 cell = ivec2(floor(q)) + ivec2(5000);
  uint sd = uint(uSeed) * 2654435761u + 7u;
  float gn = h21(cell, sd) + h21(cell, sd + 77u) - 1.;
  l = lum(c);
  c += gn * uGrain * 4. * l * (1. - l);
  gl_FragColor = vec4(clamp(c, 0., 1.), 1.);
}`;

export function createInkLook(renderer, w, h) {
  const fsGeo = new THREE.BufferGeometry();
  fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  fsGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fsMesh = new THREE.Mesh(fsGeo); fsMesh.frustumCulled = false;
  const draw = (mat, target) => { fsMesh.material = mat; renderer.setRenderTarget(target); renderer.render(fsMesh, fsCam); };
  const mat = (fs, uniforms) => new THREE.ShaderMaterial({ vertexShader: VS_FS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
  const HF = THREE.HalfFloatType;
  const rt = (W, H) => new THREE.WebGLRenderTarget(W, H, { type: HF, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
  const T = {
    A: new THREE.WebGLRenderTarget(w, h, { type: HF, samples: 4, depthBuffer: true }),
    B: new THREE.WebGLRenderTarget(w, h, { type: HF, samples: 4, depthBuffer: true }),
    M: new THREE.WebGLRenderTarget(w, h, { type: HF, samples: 4, depthBuffer: true }),
    C: rt(w, h), D: rt(w, h), E: rt(w, h),
    h0: rt(hw, hh), h1: rt(hw, hh), hA: rt(hw, hh), hB: rt(hw, hh), hC: rt(hw, hh),
  };
  const mkCanvas = () => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    const tx = new THREE.CanvasTexture(cv); tx.colorSpace = THREE.NoColorSpace; tx.generateMipmaps = false; tx.minFilter = THREE.LinearFilter;
    return { cv, g, tx };
  };
  const OV = mkCanvas(), SB = mkCanvas();
  const over = OV.g, overTex = OV.tx, sub = SB.g, subTex = SB.tx;

  const v4 = () => ({ value: new THREE.Vector4() }), v3 = () => ({ value: new THREE.Vector3() });
  const arr = n => ({ value: Array.from({ length: n }, () => new THREE.Vector4()) });
  const CU = {
    uPal: U.uPal, uK: U.uK, uT: U.uT,
    tA: { value: null }, tB: { value: null }, tM: { value: null }, tOver: { value: overTex },
    uMixB: { value: 0 }, uMixM: v4(), uPortal: { value: 0 }, uOverOn: { value: 0 }, uFadeP: { value: 0 }, uLineM: { value: 0 }, uExpo: { value: 1 },
    uT1: v4(), uCap: { value: Array.from({ length: NCAP }, () => new THREE.Vector4(-9999, -9999, -9999, -9999)) }, uCap2: { value: Array.from({ length: NCAP }, () => new THREE.Vector4(-9999, -9999, -9999, -9999)) }, uCapR: v4(), uT1X: v4(), uT1Out: { value: 0 },
    uRev: v4(), uLeaf: v4(), uLeafB: arr(NLEAF), uLeafC: arr(NLEAF), uNLeaf: { value: 0 }, uSpotL: arr(NSL), uSpotF: arr(NSL), uNSpotL: { value: 0 }, uLight2: v4(),
    uDot: arr(NDOT), uNDot: { value: 0 },
    uEye: v4(), uEyeP: v4(), uEye2: v4(), uEye2B: v4(), uEye2C: v4(), uIris: v3(), uBand: v4(), uBandR: v4(), uFlare: v4(), uLens: v4(), uWin: v4(), uArcs: v4(), uRim: v4(), uGlint: v4(), uGlintL: v4(),
  };
  const M = {
    comp: mat(COMP_FS, CU),
    down: mat(DOWN_FS, { tIn: { value: null }, uTex: { value: new THREE.Vector2(1 / w, 1 / h) } }),
    blur: mat(BLUR_FS, { tIn: { value: null }, uDir: { value: new THREE.Vector2() }, uSig: { value: 1 } }),
    copy: mat(COPY_FS, { tIn: { value: null } }),
    bleed: mat(BLEED_FS, { tC: { value: null }, tBA: { value: null }, uRes: { value: new THREE.Vector2(w, h) }, uK: U.uK, uSoft: { value: 0 }, uBR: { value: 3 }, uBA: { value: 0.5 } }),
    final: mat(FINAL_FS, { uPal: U.uPal, uK: U.uK, uT: U.uT, tD: { value: null }, tBB: { value: null }, tSub: { value: subTex }, uSubOn: { value: 0 }, uRes: { value: new THREE.Vector2(w, h) },
      uWS: { value: 0.4 }, uG: { value: 0.06 }, uPaperS: { value: 0.07 }, uVig: { value: 0.1 }, uGrain: { value: 0.02 }, uSat: { value: 0.85 }, uSeed: { value: 0 },
      uPaperSc: { value: 1 }, uClampHi: { value: 1 }, uWB: { value: new THREE.Vector3(1, 1, 1) }, uPaperOff: { value: new THREE.Vector2() } }),
  };
  M.copy.transparent = false;
  const blurTo = (src, sigFull, dst) => {
    const s = sigFull * K / 2;
    M.blur.uniforms.tIn.value = src; M.blur.uniforms.uDir.value.set(1 / hw, 0); M.blur.uniforms.uSig.value = s; draw(M.blur, T.h1);
    M.blur.uniforms.tIn.value = T.h1.texture; M.blur.uniforms.uDir.value.set(0, 1 / hh); draw(M.blur, dst);
  };

  // 渲一个世界到 A / B / M（clearA：清屏 alpha；遮罩通道用 0）
  function world(slot, scene, camera, clear, clearA = 1) {
    renderer.setRenderTarget(T[slot]);
    renderer.setClearColor(new THREE.Color(clear[0], clear[1], clear[2]), clearA);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
  }
  // 近景真虚焦：先渲后景层（相机层 0），整幅做高斯（σ 设计像素），再把前景层（层 1）清楚地渲上去
  function worldSplit(slot, scene, camera, clear, sigma) {
    camera.layers.set(0);
    world(slot, scene, camera, clear);
    const ac = renderer.autoClear;
    if (sigma > 0.3) {
      M.down.uniforms.tIn.value = T[slot].texture; draw(M.down, T.h0);
      blurTo(T.h0.texture, sigma, T.hC);
      renderer.autoClear = false;
      renderer.setRenderTarget(T[slot]);
      M.copy.uniforms.tIn.value = T.hC.texture; fsMesh.material = M.copy; renderer.render(fsMesh, fsCam);
    }
    renderer.autoClear = false;
    camera.layers.set(1);
    renderer.setRenderTarget(T[slot]);
    renderer.render(scene, camera);
    renderer.autoClear = ac;
    camera.layers.enableAll();
  }
  // p：合成与后期参数（见 main.js 的 look 表）
  function finish(p) {
    const u = CU;
    u.tA.value = T.A.texture; u.tB.value = T.B.texture; u.tM.value = T.M.texture;
    u.uOverOn.value = p.over ? 1 : 0;
    if (p.over) overTex.needsUpdate = true;
    draw(M.comp, T.C);
    M.down.uniforms.tIn.value = T.C.texture; draw(M.down, T.h0);
    blurTo(T.h0.texture, p.softSig ?? 2.5, T.hA);
    blurTo(T.h0.texture, p.wsSig ?? 5, T.hB);
    const b = M.bleed.uniforms;
    b.tC.value = T.C.texture; b.tBA.value = T.hA.texture; b.uSoft.value = p.soft ?? 0.12; b.uBR.value = p.bleedR ?? 3.5; b.uBA.value = p.bleedA ?? 0.6;
    draw(M.bleed, T.D);
    const f = M.final.uniforms;
    f.tD.value = T.D.texture; f.tBB.value = T.hB.texture;
    f.uSubOn.value = p.sub ? 1 : 0; if (p.sub) subTex.needsUpdate = true;
    f.uWS.value = p.wsS ?? 0.45; f.uG.value = p.inkG ?? 0.07; f.uPaperS.value = p.paper ?? 0.07; f.uVig.value = p.vig ?? 0.1; f.uGrain.value = p.grain ?? 0.02;
    f.uSat.value = p.sat ?? 0.85; f.uSeed.value = p.seed ?? 0;
    const wm = p.warm ?? 0, wb = f.uWB.value.set(1 + 0.10 * wm, 1 + 0.012 * wm, 1 - 0.15 * wm);
    wb.divideScalar(wb.x * 0.2126 + wb.y * 0.7152 + wb.z * 0.0722);
    f.uPaperOff.value.set(...(p.paperOff || [0, 0])); f.uPaperSc.value = p.paperSc ?? 1;
    draw(M.final, null);
  }
  function resetComp() {
    const u = CU;
    u.uMixB.value = 0; u.uPortal.value = 0; u.uFadeP.value = 0; u.uLineM.value = 0; u.uExpo.value = 1;
    for (const k of ['uMixM', 'uT1', 'uT1X', 'uRev', 'uLeaf', 'uLight2', 'uEye', 'uEye2', 'uBand', 'uFlare', 'uLens', 'uWin', 'uArcs', 'uRim', 'uGlint', 'uGlintL']) u[k].value.set(0, 0, 0, 0);
    u.uNDot.value = 0; u.uT1Out.value = 0; u.uNLeaf.value = 0; u.uNSpotL.value = 0;
    for (const c of u.uCap.value) c.set(-9999, -9999, -9999, -9999);
    for (const c of u.uCap2.value) c.set(-9999, -9999, -9999, -9999);
  }
  return { world, worldSplit, finish, CU, over, overCanvas: OV.cv, sub, subCanvas: SB.cv, T, resetComp };
}
