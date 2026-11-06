// 《豹变》D 雾山 · 豹变（MACRO）：#09 眼孔里的雾崖、#10 雨洗指尖·墨滴、#11 晕开 → 收紧 → 点金
// 同一个小世界：湿岩台 + 灰豹（远处是精灵，近了换成 3D 豹背曲面）+ 陆蔚伸过来的右手（A08 姿态 3）+ 雨雾里的山谷
// 母题第二次：指尖墨渍（SEED_STAIN = 7）被雨洗开 → 聚成墨滴 → 落在豹背上晕开、收紧成第一枚环斑（同一个种子）
import * as THREE from 'three';
import { toon, bind, setToonGlobals } from '../lib/toond.js';
import { makeSprite, standAt, faceCam, rimOffset, contactShadow } from '../lib/sprite.js';
import { fogSheet, panoPlate, skyDome, onScreen } from '../lib/env.js';
import { platform, backPatch } from './geo.js';
import { GLSL } from '../lib/glsl.js';
import { DEG, clamp, lerp, seg, ss, ss5, eo, eo4, ei, eob, track, aim, s2w, w2s, pxPerM, lin3, hashi, fovOf, mixHex, monotone } from '../lib/util.js';

const SEED_STAIN = 7;

// 豹背毛面（#10 背景、#11）：毛向场、两阶毛笔触、雨珠、湿墨斑 → 环斑、墨晕（DESIGN 3.3e）
const FUR_VS = /* glsl */`
varying vec3 vL, vW, vNW;
void main(){ vL = position; vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vNW = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const FUR_FS = /* glsl */`
${GLSL}
float seg01(float x, float a, float b){ return clamp((x - a) / (b - a), 0., 1.); }
uniform float uFr, uT, uBlur, uRain, uBreath, uGoldRim, uSplit, uCue;
uniform vec2 uC; uniform float uRmax, uWave, uWaveW, uSeedStain, uInkOn;
uniform vec4 uDrop[3];      // xy 落点（米）, z 起始帧, w 尺度
uniform vec3 uKey;
uniform vec3 uFurL, uFurD, uFurS, uWetC, uInkA, uInkB, uRingC, uHeartC, uGoldC, uBead;
varying vec3 vL, vW, vNW;
vec2 curl(vec2 p){ float e = .01; float n1 = fbm3o(p + vec2(0., e)), n2 = fbm3o(p - vec2(0., e)), n3 = fbm3o(p + vec2(e, 0.)), n4 = fbm3o(p - vec2(e, 0.)); return vec2(n1 - n2, -(n3 - n4)) / (2. * e); }
// 毛向场：从脊线往两肋、往后流；过脊线是平滑转向（tanh），不再在 x = 0 处翻转出一条直的切边
vec2 furT(vec2 p){ return normalize(vec2(tanh(p.x / .008), .55) + .14 * curl(p * 7.)); }
// 一层毛笔触（长 L、宽 W，米）：尖头、往尾巴变细；返回有正负的笔触量（暗笔 / 亮笔）
float strokes(vec2 sp, float L, float W, float seed){
  vec2 sq = vec2(sp.x / L, sp.y / W);
  float row = floor(sq.y);
  sq.x += hash12(vec2(row, seed)) * 4.;
  vec2 sqi = floor(sq), sqf = fract(sq);
  float h = hash12(sqi + seed);
  float len = .55 + .4 * h;
  float taper = smoothstep(0., .1, sqf.x) * (1. - smoothstep(len * .35, len, sqf.x));
  float wid = .42 - .28 * clamp(sqf.x / len, 0., 1.);
  float yy = abs(sqf.y - .5 - (h - .5) * .3);
  float on = step(.42, hash12(sqi + seed + 7.7));
  float dash = taper * (1. - smoothstep(wid * .5, wid, yy)) * on;
  return dash * (hash12(sqi + seed + 3.3) < .58 ? -1. : 1.);
}
// 墨晕（一枚）：返回墨量；ringOut = 环心，edgeOut = 环的外缘细线（点金用）
float bloom(vec2 p, vec2 c, float u, float Rm, float seed, float fr0, out float ringOut, out float edgeOut){
  vec2 T = furT(c), Nn = vec2(-T.y, T.x);          // 整团只用落点处的一个毛向
  vec2 d = p - c;
  vec2 da = vec2(dot(d, T) / 1.4, dot(d, Nn));
  float ang = atan(da.y, da.x);
  float R1 = Rm * (1. - exp(-u / 2.2));            // f401–f406 晕开（先快后慢）
  float px = max(length(fwidth(p)), 1e-5);
  // 树枝状边：3–4 个指状突起 + 沿毛丝的碎边
  float fingers = pow(max(0., cos(3.5 * ang + seed * 2.1 + .7 * sin(ang * 2. + seed))), 6.) * .34 * smoothstep(0., 4., u);
  float edge = fingers + .12 * (fbm2(p * 260. + seed) - .5) * 2. + .09 * (fbm2(vec2(dot(p, T) * 60., dot(p, Nn) * 520.) + seed) - .5) * 2.;
  float rr = length(da), Re = R1 * (1. + edge);
  float blot = 1. - smoothstep(Re - 1.5 * px, Re + 1.5 * px, rr);
  float kR = smoothstep(fr0 + 5., fr0 + 15., uFr);  // f406–f416 慢慢成咖啡环（边浓心淡）
  float q = rr / max(Re, 1e-4);
  float ringish = mix(blot, blot * (.22 + .78 * smoothstep(.4, .9, q)), kR);
  float tideL = blot * smoothstep(.8, .95, q) * kR;  // 潮线
  float t2 = smoothstep(fr0 + 17., fr0 + 21., uFr); // f418–f422 收紧成环斑
  float Rs = max(R1 * mix(1., .88, t2), 1e-4);
  vec2 ros = rosette(da / Rs, seed, t2, 1., 4., .42, .25, px / Rs);
  vec2 ros2 = rosette(da / (Rs * .92), seed, t2, 1., 4., .42, .25, px / Rs);
  ringOut = ros.y * t2;
  edgeOut = clamp(ros.x - ros2.x, 0., 1.) * t2;
  return clamp(mix(ringish + tideL * .35, ros.x * (1. + .2 * tideL), t2), 0., 1.) * step(0., u);
}
void main(){
  vec2 p = vL.xz;                                  // 米：x 横过背、z 沿脊线
  float px = max(length(fwidth(p)), 1e-5);         // 每像素多少米
  vec2 T = furT(p), N2 = vec2(-T.y, T.x);
  vec2 sp = vec2(dot(p, T), dot(p, N2));
  // 毛笔触：屏幕上约 14–22 px 长；三级（3.5 / 7 / 14 mm）按画面尺度交叉淡入，拉镜时不会"游动"
  float target = 18. * px, st = 0.;
  for (int k = 0; k < 3; k++) {
    float L = .0035 * pow(2., float(k));
    float w = 1. - smoothstep(0., 1., abs(log2(L / target)));
    if (w > 0.) st += w * strokes(sp, L, L * .17, 1.3 + float(k) * 5.);
  }
  st *= 1. - uBlur;
  // 两阶大明暗：脊线一侧亮，另一侧胁腹落进硬边的影档（交界带一点毛边）
  float edgeN = (vnoise2(p * 70.) - .5) * .01 + st * .0025 + .012 * sin(p.y * 11. + 1.);
  float lit = 1. - smoothstep(-.0012, .0012, p.x - uSplit + edgeN);
  vec3 c = mix(uFurD, uFurL, lit);
  c *= 1. + st * mix(.20, .12, lit);
  // 背光侧的一线金边（太阳快出来了）
  c = mix(c, c * vec3(1.12, 1.04, .88), uGoldRim * lit * .6);        // 太阳快出来了：受光的一侧慢慢转暖
  // 豹的线索：脊线和肩胛的墨线（干笔、断续），让人一眼看出这是豹背
  if (uCue > 0.) {
    float lw = 1.6 * px;
    float spine = 1. - smoothstep(lw, lw * 2., abs(p.x + .003 * sin(p.y * 35.)));
    float sc = abs(length(p - vec2(-.07, uC.y - .05)) - .055);
    float scap = (1. - smoothstep(lw, lw * 2., sc)) * step(p.x, -.035) * step(p.y, uC.y - .01);
    float brk = smoothstep(.35, .55, vnoise2(vec2(p.y * 90., 3.)));
    c = mix(c, uFurS * .7, max(spine * step(p.y, uC.y - .025), scap) * brk * uCue * .75);
  }
  // 湿墨斑 → 环斑（同一组格点，格距 4.5 cm）；波前扫过的逐个收紧（每枚约 6 帧，回弹到 1.1 倍）
  float cell = .045;
  vec2 g = p / cell, gi = floor(g);
  float wet = 0., ring = 0., heart = 0., gold = 0.;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 cc = gi + vec2(float(i), float(j));
    vec2 h = hash22(cc + 13.1);
    vec2 cp = (cc + .5 + (h - .5) * .9) * cell;
    float dC = length(cp - uC);
    // 返修 3（v2-07）：落点周围约四分之一画面不放背景斑（给主环留出一圈空）；其余的斑沿脊线方向成簇、大小 0.4–1.4 倍随机，离落点越远越小
    if (dC < .07) continue;
    float hs = hash12(cc + 71.7);
    float clus = vnoise2(cp * vec2(11., 3.2) + 5.3) * .7 + vnoise2(cp * 26. + 1.7) * .3;   // 顺着脊线（z）拉长的簇
    if (hash12(cc + 19.9) < .22 || clus < .42) continue;
    float R = cell * (.24 + .14 * .8) * (.4 + 1.0 * hs) * mix(1., .62, smoothstep(.12, .3, dC)) * smoothstep(.07, .1, dC);
    // 返修 2：湿墨斑顺着毛向拉长 1.45 倍（墨沿毛丝渗），轮廓加沿毛向的细碎毛边——是洇在湿毛里的墨，不是一个个圆盘
    vec2 Tc = furT(cp), Nc = vec2(-Tc.y, Tc.x);
    vec2 dl = p - cp; vec2 qa = vec2(dot(dl, Tc) / 1.45, dot(dl, Nc)) / R;
    float fz = (fbm2(vec2(dot(p, Tc) * 70., dot(p, Nc) * 620.) + hash12(cc) * 9.) - .5) * .5 + (vnoise2(p * 300. + cc) - .5) * .18;
    vec2 q = spotWarp(qa * (1. + fz * .6), hash12(cc + 2.1) * 10.);
    if (dot(q, q) > 2.2) continue;
    float dist = length(cp - uC);
    float k = clamp((uWave - dist) / uWaveW, 0., 1.);
    float seed = floor(hash12(cc + 3.3) * 97.);
    float petals = 3. + floor(hash12(cc + 5.9) * 2.99);
    float sc2 = mix(1., 1. + .1 * sin(k * 3.14159), k);
    vec2 r = rosette(q / sc2, seed, k, k, petals * step(.5, k), .5, mix(.36, .22, k), px / R);
    wet = max(wet, r.x * (1. - k));
    ring = max(ring, r.x * k);
    heart = max(heart, r.y * k * (1. - r.x));
    // 环上的金光：收紧到一半时沿外缘亮一下（细线，不填瓣）
    // 环上的金光：收紧到一半时只在朝光（左上）的外缘闪一下，细、淡，不是一圈橙色描边
    if (k > .05 && k < .98) { vec2 r2 = rosette(q / (sc2 * .9), seed, k, k, petals * step(.5, k), .5, .22, px / R); gold = max(gold, clamp(r.x - r2.x, 0., 1.) * 4. * k * (1. - k) * smoothstep(-.1, .5, dot(normalize(dl + 1e-6), normalize(vec2(-.6, -.8))))); }
  }
  // 主环收紧的那几帧（f418–f428）把落点四周压暗一点，主环从一圈空里跳出来
  float hush = smoothstep(.04, .16, length(p - uC)) * smoothstep(416., 421., uFr) * (1. - smoothstep(428., 436., uFr)) * uInkOn;
  c *= 1. - .16 * hush;
  c = mix(c, mix(uWetC, uInkB, .7), clamp(wet * 1.55, 0., .92));
  c = mix(c, uHeartC, heart * .5);
  c = mix(c, uRingC, clamp(ring, 0., 1.));
  c = mix(c, uGoldC, clamp(gold, 0., 1.) * .32);
  // 墨晕：主落点 + 三滴次级
  if (uInkOn > 0.) {
    float rh, eg;
    float ink = bloom(p, uC, uFr - 401., uRmax, uSeedStain, 401., rh, eg);
    // 点金：一道细亮线沿新成的环外缘跑过半圈（角度在单位圆上取，两侧软边）；环心落成暗赭
    vec2 T0 = furT(uC); vec2 d0 = p - uC; vec2 da0 = vec2(dot(d0, T0) / 1.4, dot(d0, vec2(-T0.y, T0.x)));
    float headA = mix(-3.14, .2, seg01(uFr, 422., 429.));
    float angd = acos(clamp(dot(normalize(da0 + 1e-7), vec2(cos(headA), sin(headA))), -1., 1.));
    float run = (1. - smoothstep(.5, .7, angd)) * step(421.5, uFr) * (1. - smoothstep(429., 433., uFr));
    vec3 ic = mix(uInkA, uInkB, smoothstep(.3, .9, ink));
    c = mix(c, uHeartC, rh * .5 * smoothstep(421., 424., uFr));
    c = mix(c, ic, clamp(ink, 0., 1.));
    c = mix(c, uGoldC, clamp(eg * run, 0., 1.) * .5);
    for (int k = 0; k < 3; k++) {
      vec4 D = uDrop[k];
      float rr2, eg2; float ik = bloom(p, D.xy, uFr - D.z, uRmax * D.w, float(k) * 13. + 3., D.z, rr2, eg2);
      float kw = clamp((uWave - length(D.xy - uC)) / uWaveW, 0., 1.);
      c = mix(c, mix(mix(uInkA, uInkB, smoothstep(.3, .9, ik)), uRingC, kw), clamp(ik, 0., 1.));
    }
    // 落背的一圈涟漪
    float u0 = uFr - 401.;
    if (u0 > 0. && u0 < 10.) { float rr = length(d0); float rad = .004 + u0 * .0045; c = mix(c, uBead, (1. - smoothstep(0., .0006, abs(rr - rad))) * (1. - u0 / 10.) * .22); }
  }
  // 雨珠：三种大小，沿毛向成串（密度 ×0.3）；只画高光，不画暗沿；少数拉成短水痕
  if (uRain > 0.) {
    for (int k = 0; k < 3; k++) {
      float cs = .005 * (1. + float(k) * .9);
      vec2 qv = vec2(sp.x / (cs * 2.4), sp.y / cs);
      vec2 qi = floor(qv), bh = hash22(qi + 91. + float(k) * 13.);
      if (bh.x < .14 * uRain) {
        vec2 bc = qi + .5 + (bh - .5) * vec2(.3, .5);
        vec2 dd = (qv - bc) * vec2(cs * 2.4, cs);
        float br = (.00045 + .0004 * bh.y) * (1. + float(k) * .7);
        float streak = bh.y > .82 ? 3.5 : 1.;
        float core = 1. - smoothstep(br * .25, br * .7, length(dd / vec2(streak, 1.) - vec2(-br * .2, br * .2)));
        c = mix(c, uBead, core * .85);
      }
    }
  }
  gl_FragColor = vec4(c, 1.);
}`;

export function buildMacro(ctx) {
  const { W, H, K, tex, M, OV } = ctx;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(40, W / H, .005, 9000);
  const key = new THREE.DirectionalLight('#ffffff', 1); scene.add(key, key.target);
  const sky = skyDome({ low: '#C9D2CF', high: '#B7C2C1' }); scene.add(sky);
  // 湿岩台
  const mRock = toon('rock_mist', { color: '#4E6A68', shade1: '#223438', moss: .25, streak: .2 });
  const plat = bind(new THREE.Mesh(platform(), mRock), mRock); plat.position.set(3.2, 0, -.3); scene.add(plat);
  // 远景：雨雾里的山谷
  const pano = panoPlate(tex.pano, { order: 1 }); scene.add(pano);
  const fogs = [0, 1, 2].map(i => { const f = fogSheet({ w: [60, 220, 1400][i], h: [4, 14, 80][i], col: '#BFCBCB', op: [.5, .8, .85][i], seed: 70 + i, top: .8, ns: [2, 8, 40][i], order: 3 + i * .1, tear: .2 }); scene.add(f); return f; });
  // 灰豹（远处精灵，姿态 A）
  const leo = makeSprite(tex.leoSit, tex.leoSitIn, { mode: 1, order: 12, poses: M.leoSitPoses });
  leo.setPose('A'); scene.add(leo.group);
  const shLeo = contactShadow(11); scene.add(shLeo);
  // 豹背曲面
  const furU = {
    uFr: { value: 0 }, uT: { value: 0 }, uBlur: { value: 0 }, uRain: { value: 1 }, uBreath: { value: 0 }, uGoldRim: { value: 0 }, uSplit: { value: .05 }, uCue: { value: 1 }, uWaveW: { value: .17 },
    uC: { value: new THREE.Vector2(.018, .02) }, uRmax: { value: .016 }, uWave: { value: -1 }, uSeedStain: { value: SEED_STAIN }, uInkOn: { value: 0 },
    uDrop: { value: [new THREE.Vector4(.018 + .045, .02 - .02, 405, .55), new THREE.Vector4(.018 - .038, .02 + .03, 410, .5), new THREE.Vector4(.018 + .015, .02 + .055, 416, .45)] },
    uKey: { value: new THREE.Vector3(-.3, .9, -.3).normalize() },
    uFurL: { value: lin3('#8E9591') }, uFurD: { value: lin3('#5D6663') }, uFurS: { value: lin3('#3E4646') }, uWetC: { value: lin3('#2B3434') },
    uInkA: { value: lin3('#3B4A52') }, uInkB: { value: lin3('#1A2126') }, uRingC: { value: lin3('#161C1F') }, uHeartC: { value: lin3('#6E6A58') }, uGoldC: { value: lin3('#F2CD6A') }, uBead: { value: lin3('#EEF3EE') },
  };
  // 返修 2：豹背曲面加大（0.30×0.55 → 0.50×0.90 m，高不变），镜头升到 0.45 m 时球面的边也不进画
  const back = new THREE.Mesh(backPatch({ sx: .50, sy: .14, sz: .90 }), new THREE.ShaderMaterial({ uniforms: furU, vertexShader: FUR_VS, fragmentShader: FUR_FS }));
  back.renderOrder = 2; back.frustumCulled = false; back.userData.outline = true; back.userData.outlineWidth = 1;
  const BACK0 = new THREE.Vector3(0, .38, 0);
  back.position.copy(BACK0); scene.add(back);
  // 陆蔚的右手（A08 姿态 3：掌心朝下、食指朝下）+ 袖子延长（3D）
  const hand = makeSprite(tex.handsSide, null, { mode: 2, order: 14 });
  const P3 = M.handsSide[2]; hand.setRect(P3.rect); hand.u.uHT.value.set(.62, .5);
  scene.add(hand.group);
  const mSleeve = toon('rock_mist', { color: '#8D9BA3', shade1: '#4A5560', rimColor: '#AFC3B6', rimAmt: .6, streak: 0, moss: 0, outline: 1 });
  const sleeve = bind(new THREE.Mesh(new THREE.CylinderGeometry(.045, .055, 1.0, 16), mSleeve), mSleeve); scene.add(sleeve);
  // 指尖（世界）：在灰豹肩背上方 3 cm、略靠镜头一侧（#10 整段用精灵当背景里的豹背，近了就糊成景深）
  const TIP = new THREE.Vector3(.07, .625, .14);

  // ── #10 相机：从眼孔里一路飞来，减速停在离灰豹约 1.6 m 的地方（返修 1：精灵放大不超过约 1.3 倍，不再贴到豹背上）──
  //   手在前景（0.72 m），食指尖停在豹肩上方；豹在后面做假景深（先映射再在 uv 里圆盘平均，没有暗晕和色阶）
  const camTrack = track([
    [348, [-1.05, 1.18, 2.35, 49.8]],
    [358, [-.52, .95, 1.85, 34]],
    [366, [-.36, .86, 1.66, 30]],
    [385, [-.36, .858, 1.66, 30]],
  ]);
  // 眼孔里的镜头（#09）：沿"豹心 → #10 起始机位"的方向，距离单调减小
  const LEO_C = new THREE.Vector3(0, .37, .05), T10 = new THREE.Vector3(.02, .73, .05);
  const P348 = (() => { const v = camTrack(348); return new THREE.Vector3(v[0], v[1], v[2]); })();
  const DIR0 = P348.clone().sub(LEO_C).normalize();
  const innerDist = monotone([[334, 30], [340, 12], [344, 5], [347, 3.2], [348, P348.distanceTo(LEO_C)]]);
  const st = { tipS: { x: 0, y: 0 } };

  function update(t, f, shot) {
    const fr = t * 24, f2 = f - (f % 2);
    // 雨中的雾谷
    const refBG = new THREE.PerspectiveCamera(40, W / H, .05, 9000); aim(refBG, [0, 1, 1.2], 0, -4); refBG.updateProjectionMatrix();
    onScreen(pano, refBG, 1500, 420, 7000, 2800); pano.userData.u.uHazeAmt.value = .55; pano.userData.u.uSat.value = .7;   // 加宽：#10 新机位往左后退了，底板的边不能进画
    fogs.forEach((fg, i) => { const D = [6, 30, 300][i]; fg.position.copy(s2w(refBG, 960, [620, 560, 470][i], D)); fg.rotation.set(0, 0, 0); fg.userData.u.uDrift.value.set(-t * [.6, 1.5, 4][i], 0); });
    if (shot === 11) {
      // ── 俯拍微距：斜上方 70° 往下看豹背，35 mm；f399 离落点 0.11 m，f401–f431 ss5 升到 0.45 m，yaw 0 → 6° ──
      const u = ss5(seg(fr, 401, 431));
      const dist = lerp(.11, .45, u), yaw = lerp(0, 6, u) - 35;
      const tgt = BACK0.clone().add(new THREE.Vector3(furU.uC.value.x, .14 + .012, furU.uC.value.y));
      const pitch = -70;
      const dir = new THREE.Vector3(-Math.sin(yaw * DEG) * Math.cos(pitch * DEG), Math.sin(pitch * DEG), -Math.cos(yaw * DEG) * Math.cos(pitch * DEG));
      const p = tgt.clone().addScaledVector(dir, -dist);
      cam.fov = fovOf(35); cam.near = .005; cam.updateProjectionMatrix();
      aim(cam, p.toArray(), yaw, pitch);
      leo.visible(false); hand.visible(false); sleeve.visible = false; shLeo.visible = false;
      back.visible = true; plat.visible = false; pano.visible = false; fogs.forEach(fg => fg.visible = false);
      sky.userData.u.uLow.value.copy(lin3('#5E6764')); sky.userData.u.uHigh.value.copy(lin3('#4F5855'));
      furU.uBlur.value = 0;
      furU.uInkOn.value = 1;
      // 传开：f424–f440（跨进 #12 的头 8 帧由精灵接着收），波前用缓动扫 16 帧，每枚约 6 帧收紧
      furU.uWave.value = fr >= 424 ? .45 * ss(seg(fr, 424, 440)) : -1; furU.uWaveW.value = .17;
      furU.uRain.value = lerp(1, .6, seg(fr, 420, 431));
      furU.uGoldRim.value = ss(seg(fr, 422, 431));
      furU.uCue.value = 0; furU.uSplit.value = .05;
    } else {
      plat.visible = true; pano.visible = true; fogs.forEach(fg => fg.visible = true);
      sky.userData.u.uLow.value.copy(lin3('#C9D2CF')); sky.userData.u.uHigh.value.copy(lin3('#B7C2C1'));
      // #09（眼孔里：坐在雨里的灰豹）与 #10（一路飞到指尖侧面）
      if (shot === 9) {
        // 眼孔里：坐在雨里的灰豹居中；镜头随眼孔一起冲进去（30 m → 2 m），f348 正好接上 #10 的起始机位
        const d = innerDist(fr);
        const pos = LEO_C.clone().addScaledVector(DIR0, d);
        cam.fov = lerp(35, 49.8, ss(seg(fr, 334, 348))); cam.near = .01; cam.updateProjectionMatrix();
        cam.position.copy(pos); cam.up.set(0, 1, 0); cam.lookAt(LEO_C.clone().lerp(T10, ss(seg(fr, 344, 352)))); cam.updateMatrixWorld(true);
      } else {
        const v = camTrack(clamp(fr, 348, 385));
        let target = LEO_C.clone().lerp(T10, ss(seg(fr, 344, 352)));
        if (fr > 385) { const k = ss(seg(fr, 385, 398)); target.y -= .05 * k; }
        const pos = new THREE.Vector3(v[0], v[1], v[2]);
        if (fr > 366) pos.x += .002 * Math.sin(t * 1.3);
        cam.fov = v[3]; cam.near = .01; cam.updateProjectionMatrix();
        cam.position.copy(pos); cam.up.set(0, 1, 0); cam.lookAt(target); cam.updateMatrixWorld(true);
      }
      // 豹：整段是精灵；镜头停下以后做假景深（uDof，单位是贴图像素）
      leo.visible(true); leo.u.uOpacity.value = 1; leo.u.uBlur.value = 0; leo.u.uDof.value = shot === 10 ? 7 * ss(seg(fr, 352, 366)) : 0;
      leo.clearBones(); const pz = M.leoSitPoses.A;
      leo.bone(0, pz.belly, pz.belly, 0, pz.rect[3] * .55, 0, .012 * Math.sin(2 * Math.PI * (f2 / 24) / 2));
      standAt(leo, cam, new THREE.Vector3(0, 0, .05), .74, { flip: false });
      leo.u.uGold.value = 0; leo.u.uSpot.value = 1; leo.u.uDry.value = 0; leo.u.uCell.value = pz.cell; leo.u.uWaveW.value = 0;
      leo.u.uWetA.value = .62;
      leo.u.uTint.value.set(.8, .86, .9); leo.u.uRimAmt.value = .5; leo.u.uRimCol.value.copy(lin3('#AFC3B6'));
      shLeo.position.set(0, .02, .05); shLeo.scale.set(.8, .26, 1); shLeo.visible = true;
      back.visible = false; furU.uInkOn.value = 0; furU.uWave.value = -1;
      // 手：拇指侧、从左上伸进来（f355–f364 滑进画面），食指尖停在豹肩上方；小臂从画面上沿出画（不再接 3D 袖子）
      hand.visible(shot === 10 && fr >= 355); sleeve.visible = false;
      const tipPx = P3.keys.index_tip, wr = P3.keys.wrist;
      const D = .72;
      const hpx = .20 * pxPerM(cam, D);
      const s = hpx / P3.rect[3];
      const rot = 22 + 1.5 * Math.sin(f2 * .9);
      const ts = { x: 985, y: 440, z: D };
      const ox = (tipPx[0] - P3.rect[0] - P3.rect[2] / 2) * s, oy = (tipPx[1] - P3.rect[1] - P3.rect[3] / 2) * s;
      const cr = Math.cos(rot * DEG), sr = Math.sin(rot * DEG);
      const slide = 1 - eo(seg(fr, 355, 364));
      ts.x -= 900 * slide; ts.y -= 700 * slide;
      const cx = ts.x - (cr * ox - sr * oy), cy = ts.y - (sr * ox + cr * oy);
      faceCam(hand, cam, cx, cy, hpx, D, { rot: -rot });
      hand.u.uLit.value.set(.92, .98, 1.0); hand.u.uShade.value.set(.74, .84, .90);
      hand.u.uRimAmt.value = .6; hand.u.uRimCol.value.copy(lin3('#AFC3B6')); rimOffset(hand, -.3, .95, 3.5 * K, hpx * K);
      // 指尖墨渍：先完整可见（R ≈ 20·K），f357–f378 被雨洗开（crisp 0.6 → 0，外扩 15%），之后剩一点淡墨
      const wash = ss(seg(fr, 357, 378));
      hand.u.uStain.value.set(tipPx[0] - 16, tipPx[1] - 26, 20 / s * (1 + .15 * wash), lerp(1, .4, wash));
      hand.u.uStainP.value.set(lerp(.6, 0, wash), lerp(.85, .3, wash), 3, .42); hand.u.uStainSeed.value = SEED_STAIN; hand.u.uStainGloss.value = .8 * (1 - wash);
      // 手腕在屏幕上的位置（给叠加层画墨丝：贴着指腹往下流）
      { const wx = (wr[0] - P3.rect[0] - P3.rect[2] / 2) * s, wy = (wr[1] - P3.rect[1] - P3.rect[3] / 2) * s; st.wristS = { x: cx + cr * wx - sr * wy, y: cy + sr * wx + cr * wy }; }
      st.tipS = ts; st.hpx = hpx;
    }
    key.position.set(-.3, .9, -.3); key.updateMatrixWorld();
    setToonGlobals({ keyDir: [-.3, .9, -.3], skyGain: 1, inkTime: Math.floor(f / 2) });
    furU.uFr.value = fr; furU.uT.value = t;
    st.fr = fr;
  }
  // 叠加层：墨丝、墨滴（#10）；落背的冠状飞溅（#11）
  function overlay(t, f, shot) {
    const fr = t * 24, f2 = f - (f % 2);
    const g = OV.use(), X = OV.X, Y = OV.Y;
    if (shot === 10) {
      const tp = st.tipS, wr = st.wristS || { x: tp.x - 200, y: tp.y - 300 };
      const hs = st.hpx / 300;
      // 墨顺指肚流到指尖（f362–f380）：贴着指腹的轮廓往下流，宽度从 4·K 渐细到 1.5·K（画在 look 之后，不会多出描边）
      if (fr >= 362 && fr < 391) {
        const k = ss(seg(fr, 362, 380));
        const dx = tp.x - wr.x, dy = tp.y - wr.y, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
        const a0 = .34, a1 = lerp(a0, 1, k);
        g.fillStyle = 'rgba(35,39,43,.9)';
        const N = 14;
        g.beginPath();
        for (let i = 0; i <= N; i++) { const u = lerp(a0, a1, i / N), w = lerp(4, 1.5, i / N) * K * hs * .5; const x = wr.x + dx * u + nx * (6 * hs), y = wr.y + dy * u + ny * (6 * hs); if (i) g.lineTo(X(x) + nx * w, Y(y) + ny * w); else g.moveTo(X(x) + nx * w, Y(y) + ny * w); }
        for (let i = N; i >= 0; i--) { const u = lerp(a0, a1, i / N), w = lerp(4, 1.5, i / N) * K * hs * .5; const x = wr.x + dx * u + nx * (6 * hs), y = wr.y + dy * u + ny * (6 * hs); g.lineTo(X(x) - nx * w, Y(y) - ny * w); }
        g.closePath(); g.fill();
      }
      // 墨滴：f370–f389 胀大、下垂；f390 断开（2 帧颈缩，带一颗卫星小滴）；f390–f398 慢镜下落到豹背上
      if (fr >= 370) {
        let r = 11 * ss(seg(fr, 370, 389)), y0 = tp.y + 4, sag = 1 + .5 * ss(seg(fr, 378, 389));
        let drop = 0;
        if (fr >= 390) { drop = (fr - 390) * 26 + 4 * ss(seg(fr, 390, 392)); r = 11; sag = 1.25 + .1 * Math.sin(fr * 2); }
        const cx = X(tp.x), cy = Y(y0 + r * sag * .9 * hs + drop);
        const R = r * K * hs;
        if (R > .5) {
          g.save(); g.translate(cx, cy);
          g.beginPath();
          g.moveTo(0, -R * sag * 1.5);
          g.bezierCurveTo(R * .9, -R * .4, R, R * .6, 0, R);
          g.bezierCurveTo(-R, R * .6, -R * .9, -R * .4, 0, -R * sag * 1.5);
          const gr = g.createRadialGradient(-R * .3, -R * .2, R * .1, 0, 0, R * 1.2);
          gr.addColorStop(0, 'rgba(58,66,72,1)'); gr.addColorStop(.6, 'rgba(26,33,38,1)'); gr.addColorStop(1, 'rgba(14,18,20,1)');
          g.fillStyle = gr; g.fill();
          g.fillStyle = 'rgba(238,243,238,.9)'; g.beginPath(); g.ellipse(-R * .35, -R * .1, R * .18, R * .28, -.4, 0, 6.283); g.fill();
          g.restore();
          if (fr >= 390 && fr < 392) { g.fillStyle = 'rgba(26,33,38,.9)'; g.beginPath(); g.arc(X(tp.x + 2), Y(y0 + 2), 2.2 * K * hs, 0, 6.283); g.fill(); }
          if (fr >= 390) { g.fillStyle = 'rgba(26,33,38,.85)'; g.beginPath(); g.arc(cx + 3 * K, cy - R * 2.6, R * .22, 0, 6.283); g.fill(); }
        }
      }
      // 雨珠打在指尖上（f357，小水冠）
      if (f2 === 356 || f2 === 358) {
        g.save(); g.strokeStyle = 'rgba(230,240,236,.8)'; g.lineWidth = 1.5 * K; g.lineCap = 'round';
        for (let i = 0; i < 6; i++) { const a = -Math.PI * (.15 + .7 * i / 5); g.beginPath(); g.moveTo(X(tp.x + Math.cos(a) * 6 * hs), Y(tp.y + Math.sin(a) * 6 * hs)); g.lineTo(X(tp.x + Math.cos(a) * 16 * hs), Y(tp.y + Math.sin(a) * 16 * hs)); g.stroke(); }
        g.restore();
      }
    }
    if (shot === 11) {
      const c = w2s(cam, back.localToWorld(new THREE.Vector3(furU.uC.value.x, .152, furU.uC.value.y)));
      // f399–f400 墨滴从画面上沿进来（沿运动方向拉长）
      if (fr < 401) {
        const k = seg(fr, 398.5, 401);
        const y = lerp(-80, c.y, k);
        g.fillStyle = 'rgba(20,26,30,1)'; g.beginPath(); g.ellipse(X(c.x), Y(y), 18 * K, 46 * K, 0, 0, 6.283); g.fill();
      }
      // f401 落背：冠状飞溅 6–10 颗小墨滴（抛物线）
      if (fr >= 401 && fr < 412) {
        const u = (fr - 401) / 24;
        for (let i = 0; i < 9; i++) {
          const a = i / 9 * 6.283 + hashi(i) * .5, v = 260 + 200 * hashi(i + 9);
          const x = c.x + Math.cos(a) * v * u, y = c.y + Math.sin(a) * v * u * .6 - 300 * u + 900 * u * u;
          const r = (4 + 6 * hashi(i + 3)) * (1 - u * 1.5);
          if (r <= 0) continue;
          g.fillStyle = 'rgba(22,28,32,.95)'; g.beginPath(); g.arc(X(x), Y(y), r * K, 0, 6.283); g.fill();
        }
      }
    }
  }
  function look(t, f, shot) {
    const fr = t * 24;
    const OL = { width: 2.4, color: '#1C2622', wobble: .7, warp: 70, boilFps: 12, pressure: .35, breakup: .12, inner: .5, farScale: .5, tint: .2, darken: .5, fogFade: .9, near: .3, far: 10 };
    const grade = { exposure: 1, warmth: -.10, lift: [.020, .030, .035], gamma: 1, gain: 1, saturation: .90, shoulder: .9 };
    const bloom = { strength: .30, threshold: .82, radius: .60, tint: '#F4F1E0' };
    const kuw = { radius: 1.5, farRadius: 3, farStart: .3, farEnd: 1.2, strength: .7, protect: null };
    if (shot === 11) {
      const k = seg(fr, 420, 431);
      grade.warmth = lerp(-.10, 0, k); grade.saturation = lerp(.90, .98, k); bloom.strength = fr >= 422 ? .45 : .30;
      kuw.radius = 1.2; kuw.farRadius = 1.5;
    }
    if (shot === 9) { kuw.radius = 1.5; }
    return { outline: shot === 9 ? false : OL, grade, bloom, kuwahara: kuw, fog: { color: '#BFCBCB', colorHigh: '#CCD6D3', density: .02, start: 1.5, max: .8, cutoff: 2000 }, paper: { strength: .03 }, vignette: .22 };
  }
  function post(t, f, shot) {
    const fr = t * 24;
    const p = { uRain: 1, uRainT: t, uRainD: [.5, 2, 6], uSplash: .03, uSplashT: t };
    if (shot === 10 && fr >= 390) {
      // 慢镜：雨速 ×0.15、雨丝缩成珠（雨的时钟按积分算，避免跳变）
      const k = ss(seg(fr, 389, 392));
      const tt = 389 / 24 + (fr - 389) / 24 * lerp(1, .15, k);
      p.uRainT = tt; p.uRainLen = lerp(1, .3, k);
    }
    if (shot === 11) { p.uRain = lerp(1.5, .6, seg(fr, 420, 431)) * .6; p.uRainLen = .5; p.uRainD = [.05, .1, .2]; }
    return p;
  }
  return { scene, camera: cam, update, look, post, overlay, st };
}
