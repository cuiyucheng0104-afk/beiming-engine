// leo.js — 豹精灵（A01–A05）共用：白身换色、文斑（湿墨斑 / 晕开 → 收紧 → 点亮 / 环斑）、径向擦除、眨眼。
// 斑的状态由每帧的 phase 给出：<0 湿墨斑；0..1 晕开；1..2 收紧；2..3 点亮；≥3 环斑。
// fix1：
//  · 线与身按"图里的线色—身白"混合线段重新分开：落在线段上的像素按覆盖率混成 线色 ↔ 身色，
//    离线段远的才算特征色（耳内赭黄、琥珀眼、黑瞳）保留原色——去掉线内侧那道浅粉白边（style-08 / tech-03）。
//  · 湿墨斑：整枚填墨（瓣深、心略淡、外缘一圈干墨边、向毛里洇一圈淡影），去掉白高光点和三角流痕（style-02 / main-02）。
//  · 晕开：毛细须边（18 / 44 频、短而密，不再长 5–7 根硬尖刺），浓度提高、外缘干墨边更深（style-01）。
//  · 环心：硬边平涂的蛤白圆（不再是柔边灯泡光晕，style-01）。
import * as THREE from 'three';
import { makeSprite, lin3, DEG } from './lib.js';

export const RING_COLORS = ['#4995C6', '#E47049', '#75AE9F', '#EDB730', '#CEA5DD', '#E7969F', '#9BCCF4'];

// 线 / 身 / 特征色分离（sRGB）：返回 x = 身覆盖率（0 线 → 1 身），y = 特征色权重（1 = 保留原色）
export const LEO_SPLIT = /* glsl */`
uniform vec3 uWc, uLc;
vec2 leoSplit(vec3 cs){
  vec3 d = uWc - uLc;
  float t = clamp(dot(cs - uLc, d) / dot(d, d), 0., 1.);
  float dist = length(cs - (uLc + t * d));
  return vec2(t, smoothstep(.09, .15, dist));
}`;

export const LEO_FS = {
  pars: LEO_SPLIT + /* glsl */`
uniform vec3 uBodyA, uBodyB;
uniform vec4 uErase;
uniform vec4 uSp[18];
uniform vec4 uSpS[18];
uniform vec3 uRC[7];
uniform vec4 uEye; uniform float uBlink;
uniform float uSpOn, uLeoT, uLineK;
uniform vec4 uSplash;      // 环 0 落墨时的静态溅点：x 开关, y 衰减
vec4 bbOver(vec4 dst, vec3 c, float a){ return vec4(c * a + dst.rgb * (1. - a), a + dst.a * (1. - a)); }
float leoCenHard(vec2 q, float idx, float aa){
  float th = atan(q.y, q.x); if (th < 0.) th += 6.2831853;
  return 1. - smoothstep(.55 * bbWbRho(th, idx) - .02 - aa, .55 * bbWbRho(th, idx) + .02 + aa, length(q));
}
// 湿墨斑：一整团没干的墨（fix3：抽成函数，晕开开头两帧要和它交叉淡变；dBlob 带出给晕开当起始轮廓）
vec4 leoWet(vec2 q, float r, float th0, float idx, float aaR, out float dBlob){
  vec3 WETD = vec3(.0207, .0222, .0289);                 // 湿墨（深靛墨）
  vec3 WET = vec3(.0423, .0467, .0595);                  // #3A3D45
  vec4 WG = vec4(.1745, .0524, .0524, .0524);           // 湿墨斑缺口 [10,3,3,3]：读成一团墨，不读成环
  float wob = .07 * (bbFbm(q * 3.4 + idx * 1.7) - .5) * 2. + .03 * (bbVN(q * 13. + idx * 3.1) - .5) * 2.;
  dBlob = r - .97 * bbWbRho(th0, idx) - wob;
  float fe = .07 + aaR;
  float blob = 1. - smoothstep(-fe, fe, dBlob);
  float pet = 1. - smoothstep(-fe, fe, bbWbPetal(q, idx, WG, .50) + wob);
  float rim = (1. - smoothstep(0., .15, abs(dBlob + .09))) * blob;          // 干墨边
  float bleed = (1. - smoothstep(0., .32, dBlob)) * step(0., dBlob) * .16;   // 向毛里洇的一圈淡影
  vec4 o = vec4(0.);
  o = bbOver(o, WET, bleed);
  o = bbOver(o, WETD, blob * .60);
  o = bbOver(o, WETD, max(pet * .26, rim * .55));                             // fix2：四瓣再弱一档，读成一团湿墨、不读成花
  return o;
}
vec4 leoSpot(vec2 px, vec4 S, vec4 st, float idx){
  float R = S.z;
  vec2 p = (px - S.xy) / R;
  if (dot(p, p) > 4.6) return vec4(0.);
  vec2 q = bbRot(p, S.w);
  float ph = st.x;
  if (ph < -1.5) return vec4(0.);                         // 未出现（环 0 在墨滴落下之前不存在）
  vec3 INK = vec3(.0242, .0194, .0159);                  // #2B2622
  vec3 WET = vec3(.0423, .0467, .0595);                  // #3A3D45
  vec4 o = vec4(0.);
  vec4 RG = vec4(.8029, .2443, .2443, .2443);           // 环斑缺口 [46,14,14,14]
  float aaR = max(fwidth(q.x) * 1.2, .006);
  float r = length(q), th = atan(q.y, q.x);
  float th0 = th < 0. ? th + 6.2831853 : th;
  if (ph < 0.) {
    float dBl;
    return leoWet(q, r, th0, idx, aaR, dBl);
  }
  // 洇墨边（fix2，main-02 / v1-05）：基础半径叠 3 个低频瓣（合计约 ±0.12–0.18R，相位随 0.3t 缓变），把正圆打破；
  // 高频毛细须边幅度 ≤ 0.05R，只在约 30% 的角度上出现（低频角向门），须尖按 0.04R 羽化——读成毛细洇开，不再是一圈刺（海胆）；
  // 外缘一道 3–5 px 深一档的干墨边，外面再一圈 α0.2 的淡水痕；墨往外推时中心略淡
  vec2 cd = vec2(cos(th), sin(th));
  float p1 = 6.2832 * bbH1(idx * 7.7 + 3.), p2 = 6.2832 * bbH1(idx * 5.1 + 4.), p3 = 6.2832 * bbH1(idx * 2.9 + 5.);
  float lobe = .085 * sin(3. * th + p1 + .30 * uLeoT) + .055 * sin(5. * th + p2 - .21 * uLeoT) + .045 * sin(2. * th + p3 + .17 * uLeoT);
  float gate = smoothstep(.56, .70, bbVN(cd * 3.2 + vec2(idx * 4.1, uLeoT * .08)));
  float tend = .05 * pow(max(bbVN(cd * 40. + vec2(idx * 3.1 + 11., uLeoT * .45)) - .35, 0.) / .65, 1.3) * gate;
  float wob = .03 * (bbFbm(q * 2.6 + idx + uLeoT * .05) - .5) * 2.;
  float gran = .94 + .12 * bbFbm(q * 3.2 + idx * 5. + uLeoT * .12);          // 墨在毛上的浓淡
  vec3 C1 = mix(INK, WET, .40);
  float dW = bbWbPetal(q, idx, RG, .36);
  if (ph < 1.) {
    float u = ph, e = u * u * (3. - 2. * u);      // 晕开：中段最快（环 0 对 f383–f390 的最大涌起）
    float Rmax = st.y > .5 ? st.y : 1.35;
    // fix3（v2-01）：环 0 在墨滴落下前不存在，晕开从落点 0.2R 起；其余 17 枚原本就有一团约 1.0R 的湿墨斑，
    // 晕开从湿墨斑本身的轮廓起（不先清空成小黑点再长大），前两帧由湿墨斑交叉淡到墨
    float wetP = step(.5, idx);
    float Rb = mix(mix(.2, .97, wetP), Rmax, e);
    float dB = r - Rb * (1. + (lobe + wob) * smoothstep(.10, .90, u) + tend * smoothstep(.20, 1., u));
    vec4 oW = vec4(0.);
    if (wetP > .5) {
      float dBl;
      oW = leoWet(q, r, th0, idx, aaR, dBl);
      float dBs = r - (r - dBl) * (Rb / .97);          // 湿墨斑轮廓按 Rb 等比放大
      dB = mix(dBs, dB, smoothstep(0., .9, u));         // 轮廓由湿墨斑渐变到晕开的洇墨边（u = 1 时与收紧段首帧一致）
    }
    float cov = 1. - smoothstep(-.04 - aaR, .02 + aaR, dB);
    float wash = smoothstep(.2, 1., u) * (1. - smoothstep(0., .65, r / max(Rb, .2)));
    o = bbOver(o, mix(INK, WET, u * .40), clamp(cov * mix(1.0, .84, u) * gran * (1. - .18 * wash), 0., 1.));
    float rim = (1. - smoothstep(0., .022 + aaR, abs(dB + .03))) * .70 * smoothstep(.05, .4, u);   // 干墨边
    o = bbOver(o, INK, rim * cov);
    float halo = (1. - smoothstep(0., .16, dB)) * step(0., dB) * .20 * smoothstep(.1, .5, u);       // 淡水痕
    o = bbOver(o, WET, halo);
    if (wetP > .5) o = mix(oW, o, smoothstep(0., .75, u));   // 预乘色交叉淡变：u = 0 与湿墨斑逐像素相同
    return o;
  }
  if (ph < 2.) {
    float u = ph - 1., su = u * u * (3. - 2. * u);
    float Rb = mix(st.y > .5 ? st.y : 1.35, 1.0, su);
    float dB = r - Rb * (1. + (lobe + wob + tend) * (1. - su));
    float d = mix(dB, dW, su);
    float fe = mix(.03, .025, su) + aaR;
    float cov = 1. - smoothstep(-fe - .01 * (1. - su), fe, d);
    float wash = 1. - smoothstep(0., .65, r / max(Rb, .2));
    o = bbOver(o, mix(C1, INK, su), cov * mix(.84 * gran * (1. - .18 * wash), .93, su));
    float rim = (1. - smoothstep(0., .022 + aaR, abs(dB + .03))) * .70 * (1. - su);
    o = bbOver(o, INK, rim * cov);
    float halo = (1. - smoothstep(0., .16, dB)) * step(0., dB) * .20 * (1. - su);
    o = bbOver(o, WET, halo);
    return o;
  }
  // 点亮 / 环斑
  float u = clamp(ph - 2., 0., 1.);
  float sc = ph < 3. ? mix(1.0, 1.06, smoothstep(.0, .5, u)) * mix(1., 1. / 1.06, smoothstep(.5, 1., u)) : 1.;
  vec2 qs = q / sc;
  float d = bbWbPetal(qs, idx, RG, .36);
  float cov = 1. - smoothstep(-.025 - aaR, .025 + aaR, d);
  vec3 rc = uRC[int(st.z + .5)];
  float a01 = mod(atan(qs.y, qs.x) + 1.5708, 6.2832) / 6.2832;      // 从 12 点钟顺时针（图像 y 向下）
  float sweep = ph < 3. ? clamp(u / .7, 0., 1.) : 1.;
  float on = sweep >= 1. ? 1. : 1. - smoothstep(sweep - .015, sweep + .015, a01);
  vec3 c = mix(INK, rc, on);
  float front = (1. - smoothstep(0., .05, abs(a01 - sweep))) * step(sweep, .999);
  c = mix(c, vec3(1.), front * .6);
  o = bbOver(o, c, cov);
  float cen = leoCenHard(qs, idx, aaR);
  float ca = ph < 3. ? smoothstep(.5, 1., u) : 1.;
  o = bbOver(o, vec3(.9301, .8796, .7529), cen * .78 * ca);        // 环心：硬边平涂的蛤白圆 #F7F1E1
  o = bbOver(o, vec3(1., .85, .45), cen * st.w);                   // 环心金光（S5a 扫斑）
  return o;
}
`,
  body: /* glsl */`
{
  vec2 sp = leoSplit(cs);
  float wt = max(fwidth(sp.x), 1e-4);
  float bodyS = mix(smoothstep(.28, .72, sp.x), smoothstep(.5 - wt, .5 + wt, sp.x), up);
  // 身色擦除（fix2，v1-10）：uErase.w = 身长（图像像素）。边宽收到约 0.008 身长（不再是一圈柔边追光），
  // 洇边 fbm 两个尺度、幅度约 0.02 身长；外缘（灰的一侧）一道约 2.5 像素深一档的湿边——像颜料吃进纸里
  float er = 0., wetE = 0.;
  if (uErase.z > 0.) {
    float Lb = uErase.w;
    float dd = length(vPx - uErase.xy) - uErase.z;
    dd += Lb * .020 * (bbFbm(vPx * .009 + 1.3) - .5) * 2.4 + Lb * .006 * (bbVN(vPx * .045) - .5) * 2.;
    float hw = max(Lb * .004, 1.2) + fwidth(dd);
    er = 1. - smoothstep(-hw, hw, dd);
    wetE = (1. - smoothstep(hw, hw + max(Lb * .0018, 1.5), dd)) * step(-hw, dd) * (1. - er);
  }
  float wl = bbLum(uWc);
  vec3 bodyCol = mix(uBodyA, uBodyB, er) * clamp(lum / wl, .92, 1.03) * (1. - .16 * wetE);
  vec3 bodyC2 = bodyCol;
  if (uSpOn > 0.) {
    vec4 acc = vec4(0.);
    for (int i = 0; i < 18; i++) {
      vec4 S = uSp[i]; if (S.z <= 0.) continue;
      vec4 o = leoSpot(vPx, S, uSpS[i], float(i));
      acc = vec4(o.rgb + acc.rgb * (1. - o.a), o.a + acc.a * (1. - o.a));
    }
    // 落墨时的静态溅点（环 0 附近）
    if (uSplash.x > 0.) {
      vec4 S = uSp[0];
      for (int k = 0; k < 7; k++) {
        float fk = float(k);
        float ang = 6.2832 * bbH1(fk * 5.3 + 2.), dist = 1.55 + .75 * bbH1(fk * 3.7 + 9.);
        vec2 c0 = S.xy + vec2(cos(ang), sin(ang)) * dist * S.z * 1.25;
        float rr = (.04 + .04 * bbH1(fk * 1.9)) * S.z;
        float cv = (1. - smoothstep(rr * .7, rr * 1.15, length(vPx - c0))) * uSplash.y;
        acc = vec4(vec3(.0242, .0194, .0159) * cv + acc.rgb * (1. - cv), cv + acc.a * (1. - cv));
      }
    }
    acc *= uSpOn;
    bodyC2 = acc.rgb + bodyCol * (1. - acc.a);
  }
  vec3 lc = mix(uLineCol, bodyC2, bodyS);
  col = mix(lc, c.rgb * uLineK + uLineCol * (1. - uLineK), sp.y);
  // 眨眼：身色眼睑盖住眼睛 + 一笔豹线
  if (uBlink > 0.) {
    vec2 e = (vPx - uEye.xy) / uEye.zw;
    float inE = 1. - smoothstep(.9, 1.1, length(e));
    float lidY = -1. + 2. * uBlink;
    float lid = step(e.y, lidY);
    col = mix(col, bodyCol, inE * lid);
    float ln = (1. - smoothstep(.10, .22, abs(e.y - lidY))) * step(abs(e.x), 1.05) * step(.3, uBlink);
    col = mix(col, uLineCol, ln * .9);
  }
}
`,
};

// 由 manifest 锚点建豹精灵
export function makeLeo(tex, anchors, o = {}) {
  const cl = anchors.colors || { body_srgb: [0.98, 0.96, 0.955], line_srgb: [0.39, 0.24, 0.14] };
  const U = {
    uBodyA: { value: lin3('#A9ADAD') }, uBodyB: { value: lin3('#EEDFB0') },
    uErase: { value: new THREE.Vector4(0, 0, 0, 60) },
    uSp: { value: [...Array(18)].map(() => new THREE.Vector4()) },
    uSpS: { value: [...Array(18)].map(() => new THREE.Vector4(-1, 1.35, 0, 0)) },
    uRC: { value: RING_COLORS.map(lin3) },
    uEye: { value: new THREE.Vector4(0, 0, 40, 12) }, uBlink: { value: 0 },
    uSpOn: { value: 1 }, uLeoT: { value: 0 }, uSplash: { value: new THREE.Vector4() },
    uWc: { value: new THREE.Vector3(...cl.body_srgb) }, uLc: { value: new THREE.Vector3(...cl.line_srgb) },
    uLineK: { value: 1 },
  };
  const sp = makeSprite(tex, { order: o.order ?? 12, frag: LEO_FS, uniforms: U, lineCol: o.lineCol || '#6E5340', segX: 64, segY: 32 });
  const spots = anchors.spots || [];
  spots.forEach((s, i) => {
    U.uSp.value[i].set(s.px[0], s.px[1], s.r_px * (o.spotScale ?? 1), s.rot_deg * DEG);
    U.uSpS.value[i].z = RING_COLORS.indexOf(s.color) >= 0 ? RING_COLORS.indexOf(s.color) : i % 7;
  });
  if (anchors.eye) {
    const e = anchors.eye;
    const c = e.center || e.center_px, w = e.width || e.width_px, h = e.height || e.height_px;
    U.uEye.value.set(c[0], c[1], w * 0.62, h * 0.85);
  }
  sp.leo = { spots, anchors };
  return sp;
}
// 斑点状态：phase 数组（长 18）、颜色序号不变
export function setSpots(sp, phases, glow = null) {
  const S = sp.U.uSpS.value;
  for (let i = 0; i < 18; i++) { S[i].x = phases[i]; S[i].w = glow ? glow[i] : 0; }
}
