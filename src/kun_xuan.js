// 玄鲲（变体「玄鲲云纹」，设定图 鲲_v2-2_玄鲲云纹）
// 东方神话的“鱼”，不是鲸：鲤 / 鲶式大头圆吻、侧扁的鱼身、竖直尾鳍；墨玉（玄青）鱼身 + 漆器描金的祥云纹和海浪纹，
// 月白腹带淡金鳞，长鲤须，眼后一抹朱砂；胸鳍、尾鳍化作很长的月白丝绸飘带（敦煌飞天披帛），逆光下透亮。
// 三渲二配方：
//   · 形体用简单几何拼：身体沿脊柱放样（超椭圆截面），眼是球 + 两片半球眼睑，须是圆管，飘带 / 背鳍是带状网格
//   · 着色 toon_xuan.js：三色分档 + 投影量化 + Ap 背光边缘光 + 城市暖光；新增金箔、墨玉光泽、丝绸透光
//   · 花纹全在片元着色器里程序化生成（祥云：带螺线的圆 + 云尾；海浪：浪头卷 + 水波线；鳞：错列圆弧，前片压后片）
//   · 表面斑驳：墨玉云絮斑 + 描金磨损；实例化散布：洒金金箔片
//   · 停帧：身体一拍三（调用方给量化后的 ts）；飘带、须、背鳍一拍二（setPose 第二个参数给原始时间 t，内部量化）
// 坐标：鲲局部空间，长约 600，头朝 +X，上为 +Y，原点在身体中心（吻端 +297，尾柄 -234，飘带再往后约 300）。
// 确定性：所有随机来自 mulberry(固定种子)；噪声是坐标的纯函数；没有 Date.now / Math.random。
import * as THREE from 'three';
import { createNoise3D } from '../engine/core/noise.js';
import { mulberry, clamp, lerp, ss, seg, TAU } from '../engine/core/math.js';
import { profileBody, sideAngle, axisStations, ringsAt, loftRings } from '../engine/form/loft.js';
import { pitchYawLinearWave } from '../engine/form/bend.js';
import { flake } from '../engine/form/props.js';
import { weightedSampler, withWeights, placeOnSurface as place, pickFrom as pick, instanced } from '../engine/form/scatter.js';
import { autoBlink, poseEyes, pickEye, mountEyes, lidShells, eyeFrame } from '../engine/form/eye.js';
import { makeXuanMaterial, bindXuan, XUAN, XUAN_PRESETS, tintFrom } from './toon_xuan.js';

const sstep = (a, b, x) => ss(seg(x, a, b));
const UP = new THREE.Vector3(0, 1, 0);

// ───────────────────────── 身体轮廓（x：-234 尾柄末端 … +297 吻端） ─────────────────────────
// 鲤式：头大而圆、吻钝，最高点在前三分之一（x≈120），尾柄细；截面前段近圆（宽≈高），往后越来越侧扁
const PX = [-222, -206, -185, -150, -105, -50, 10, 70, 125, 172, 212, 243, 264, 278, 287, 292];
const PT = [10, 10.5, 14, 23, 37, 52, 64, 72, 75, 73, 67, 58, 47, 35, 22, 8];          // 顶线 y
const PB = [-9.5, -10, -13, -22, -36, -52, -66, -75, -77, -74, -66, -55, -42, -29, -16, -5]; // 底线 y
const PW = [4.5, 5, 7.5, 13.5, 23, 35, 45, 52, 55, 55, 52, 46, 38, 28, 17, 6];           // 半宽 z
const X_TAIL = -222, X_SNOUT = 292;

// 嘴线（侧面角：0 = 侧中线，+π/2 = 背中线）：吻前略低于中线，嘴角往下撇
const mouthPh = x => lerp(-0.52, -0.3, sstep(262, 291, x));
// 鳃盖后缘（向尾部凸的弧）
const gillX = ph => 186 + 16 * ph * ph;

// 放样体（未弯曲）：超椭圆截面 + 嘴缝浅沟 + 鳃盖台阶
const body = profileBody({
  xs: PX, top: PT, bottom: PB, width: PW, exp: [2.15, 2.5],
  deform(p) {
    const x = p.x, ph = sideAngle(p.c, p.s);
    let k = 1;
    // 嘴缝：沿嘴线往里收一道浅沟（描边能抓到唇的厚度）
    if (x > 256) { const d = Math.abs(ph - mouthPh(x)); k -= 0.03 * (1 - sstep(0.02, 0.07, d)) * sstep(256, 266, x); }
    // 鳃盖：后缘以后低 1.5%，形成一道台阶
    if (x < 210 && x > 156 && ph > -1.0 && ph < 0.7) k -= 0.012 * (1 - sstep(gillX(ph) - 2.5, gillX(ph) + 2.5, x)) * sstep(156, 170, x) * sstep(0.7, 0.45, ph) * sstep(-1.0, -0.75, ph);
    p.z *= k; p.y = p.yc + (p.y - p.yc) * k;
  },
});
const { top: fT, bottom: fB, width: fW, point: bodyPoint, normal: bodyNormal } = body;
// 点是否在（未弯曲的）身体里：超椭圆隐式值 < 1 为内（穿插自检用）
function insideBody(x, y, z, margin = 0) {
  if (x < X_TAIL || x > X_SNOUT) return false;
  const yT = fT(x), yB = fB(x), W = fW(x) + margin, yc = (yT + yB) / 2, a = (yT - yB) / 2 + margin;
  const yy = (y - yc) / a, n = yy >= 0 ? 2.15 : 2.5;
  return Math.pow(Math.abs(z / W), n) + Math.pow(Math.abs(yy), n) < 1;
}

// 黑白交界（归一化：0 背中线 … 1 腹中线）。GLSL 里有同一份（xuanVb）
const vbJS = x => {
  let v = 0.585 + 0.018 * Math.sin(x * 0.045 + 0.6);
  v = lerp(v, 0.74, sstep(-90, -205, x));
  v = lerp(v, 0.6, sstep(210, 256, x));
  return v;
};
// 鳞的大小随粗细变：行高 sy(x)，列宽 1.4·sy
const scaleSy = hp => 3.0 + 0.026 * hp;

// 身体：aLoft = (x, cosφ, sinφ)；aArc = (从背中线量起的弧长 s（两侧对称、无符号）, 半周长 hp, 鳞网格列坐标 F(x), 鳞行高 sy)
function buildBody(NU, NV) {
  const loft = [], arc = [], ringInfo = [];
  const xs = axisStations(X_TAIL, X_SNOUT - 0.4, NU), rings = ringsAt(bodyPoint, xs, NV);
  let F = 0;
  const kd = NV / 4;
  for (let j = 0; j < NU; j++) {
    const x = xs[j], ring = rings[j];
    // 从背中线（k = NV/4）往 +Z 侧（k 递减）量弧长；两侧对称
    const sA = new Float32Array(NV);
    let acc = 0;
    for (let i = 1; i <= NV / 2; i++) { const k0 = (kd - i + 1 + NV) % NV, k1 = (kd - i + NV) % NV; acc += ring[k0].distanceTo(ring[k1]); sA[k1] = acc; }
    const hp = acc;
    for (let i = 1; i < NV / 2; i++) sA[(kd + i) % NV] = -sA[(kd - i + NV) % NV];
    sA[kd] = 0;
    const sy = scaleSy(hp);
    if (j > 0) F += (x - xs[j - 1]) / (1.4 * sy);
    // 存无符号弧长：带符号的话腹中线两侧从 +hp 跳到 -hp，三角形内插值会穿过 0（被当成背中线，画出一道黑线）
    for (let k = 0; k < NV; k++) { const phi = k / NV * TAU; loft.push(x, Math.cos(phi), Math.sin(phi)); arc.push(Math.abs(sA[k]), hp, F, sy); }
    ringInfo.push({ x, hp, F, sy });
  }
  const yc = body.mid;
  const r0 = ringInfo[0], r1 = ringInfo[NU - 1];
  const g = loftRings(rings, {
    startCap: { p: new THREE.Vector3(X_TAIL - 0.8, yc(X_TAIL), 0), attr: { aLoft: [X_TAIL, 0, 0], aArc: [r0.hp * 0.5, r0.hp, r0.F, r0.sy] } },
    endCap: { p: new THREE.Vector3(X_SNOUT + 0.2, yc(X_SNOUT), 0), attr: { aLoft: [X_SNOUT, 0, 0], aArc: [r1.hp * 0.6, r1.hp, r1.F, r1.sy] } },
    attrs: { aLoft: { data: loft, size: 3 }, aArc: { data: arc, size: 4 } },
  });
  g.userData.rings = ringInfo;
  return g;
}

// ───────────────────────── 祥云布局（世界单位：u = x 沿身体，s = 从背中线量下来的弧长；两侧镜像） ─────────────────────────
// 模板坐标 (a, b)：a 朝头（+u），b 朝背（-s）；单位 = 云的半径 R。卷：[a, b, 半径倍数, 旋向, 圈数]；按数组顺序叠，后画的在上
const CLOUD_T = {
  ruyi: { curls: [[1.02, -0.32, 0.66, -1, 1.35], [-1.02, -0.32, 0.66, 1, 1.35], [0.02, -0.92, 0.44, -1, 1.15], [0, 0.12, 1.0, 1, 1.75]],
    tails: [[-0.7, -0.75, 6.0, 0.30, 0.55, 1.2, 0.3, 0.6], [-0.2, -1.05, 4.2, 0.2, -0.5, 1.5, 1.4, -0.4]] },   // [起点 a, b, 长(倍 R), 起始半宽(倍 R), 摆幅(倍 R), 半波数, 相位, 末端上扬(倍 R)]
  chain: { curls: [[-2.15, 0.42, 0.5, 1, 1.15], [-1.22, 0.3, 0.72, -1, 1.35], [0, 0, 1.0, 1, 1.7]],
    tails: [[-2.4, 0.15, 4.6, 0.24, 0.45, 1.3, 0.8, 0.3]] },
  curl: { curls: [[0, 0, 1.0, -1, 1.6]], tails: [[-0.6, -0.6, 4.5, 0.32, 0.4, 1.2, 0.2, 0.5]] },
};
const CLOUDS = [
  // 侧面一排（侧看最显眼）
  { t: 'ruyi', u: 136, s: 60, R: 19 },
  { t: 'chain', u: 40, s: 62, R: 17 },
  { t: 'ruyi', u: -62, s: 50, R: 13.5 },
  { t: 'curl', u: -140, s: 38, R: 8.5 },
  // 背脊一排（俯看、3/4 看时背上不空；两侧镜像后在背中线两边各一朵）
  { t: 'curl', u: 196, s: 26, R: 8.5 },
  { t: 'chain', u: 92, s: 21, R: 10.5 },
  { t: 'ruyi', u: -14, s: 22, R: 9.5 },
  { t: 'curl', u: -100, s: 17, R: 7 },
];
const NCURL = 32, NTAIL = 16;
function layoutClouds() {
  const curls = [], curls2 = [], tails = [], tails2 = [];
  for (const c of CLOUDS) {
    const T = CLOUD_T[c.t];
    for (const [a, b, r, spin, turns] of T.curls) curls.push({ u: c.u + a * c.R, s: c.s - b * c.R, R: r * c.R, w: spin * turns, rot: (a * 1.7 + b) * 2.0 });
    for (const [a, b, len, hw, amp, waves, phase, lift] of T.tails) tails.push({ u: c.u + a * c.R, s: c.s - b * c.R, len: len * c.R, hw: hw * c.R, amp: amp * c.R, waves, phase, lift: lift * c.R });
  }
  if (curls.length > NCURL || tails.length > NTAIL) throw new Error('kun_xuan：祥云数量超过着色器上限');
  const v4 = (...a) => new THREE.Vector4(...a);
  const C1 = [], C2 = [], T1 = [], T2 = [];
  for (let i = 0; i < NCURL; i++) { const c = curls[i]; C1.push(c ? v4(c.u, c.s, c.R, c.w) : v4(0, 0, -1, 0)); C2.push(c ? v4(c.rot, 0, 0, 0) : v4()); }
  for (let i = 0; i < NTAIL; i++) { const t = tails[i]; T1.push(t ? v4(t.u, t.s, t.len, t.hw) : v4(0, 0, -1, 0)); T2.push(t ? v4(t.amp, t.waves, t.phase, t.lift) : v4()); }
  return { curls, tails, C1, C2, T1, T2 };
}

// ───────────────────────── 弯曲（GLSL 与 JS 一致）：竖直波（侧面看得见）+ 侧向波（鱼的本行），幅度从头到尾增大 ─────────────────────────
const WAVE = pitchYawLinearWave('kun', { e0: 0.18, sMax: 1.25 });
const bendHooks = WAVE.hooks;
const CATCH = [[-0.27, 0.24, 0.93, 0.9835], [0.26, -0.2, 0.94, 0.9966]];

// ───────────────────────── 身体花纹（片元） ─────────────────────────
const BODY_PARS = /* glsl */`
#define NCURL ${NCURL}
#define NTAIL ${NTAIL}
varying vec3 vLoft; varying vec4 vArc;
uniform vec4 uCurl[ NCURL ], uCurl2[ NCURL ], uTail[ NTAIL ], uTail2[ NTAIL ];
uniform vec4 uKunEye; uniform vec4 uEyeArc; uniform vec4 uEyeC;
uniform vec3 uJade, uSmoke, uBelly, uScaleGold, uGold, uGoldDeep, uCinnabar, uLip, uVein;
uniform float uWaveH, uWaveP;
// 世界单位 SDF 的抗锯齿：f = 像素足迹（世界单位），在分支外一次算好，连续、不受 floor/fract 跳变影响
float xLine( float d, float w, float f ) { return 1.0 - smoothstep( w - f, w + f, abs( d ) ); }
float xFill( float d, float f ) { return 1.0 - smoothstep( - f, f, d ); }
float xuanVb( float x ) {
  float v = 0.585 + 0.018 * sin( x * 0.045 + 0.6 );
  v = mix( v, 0.74, toonSS( -90.0, -205.0, x ) );
  v = mix( v, 0.6, toonSS( 210.0, 256.0, x ) );
  return v;
}
// 鳞：错列圆，前片（朝头）压后片；返回 (到本片外缘的距离[格单位], 本片中心朝头的相对位置)
vec2 xuanScale( vec2 q ) {
  float row = floor( q.y );
  float bestX = -1e9; vec2 bd = vec2( 9.0 );
  const float R = 0.74;
  for ( int j = -1; j <= 1; j ++ ) {
    float r = row + float( j );
    float off = mod( r, 2.0 ) * 0.5;
    float c0 = floor( q.x - off );
    for ( int i = -1; i <= 2; i ++ ) {
      vec2 c = vec2( c0 + float( i ) + off, r + 0.5 );
      vec2 d = ( q - c ) * vec2( 1.0, 0.72 );
      float l = length( d );
      if ( l < R && c.x > bestX ) { bestX = c.x; bd = vec2( R - l, d.x ); }
    }
  }
  return bd;
}
`;
const BODY_ALBEDO = /* glsl */`
{
  float x = vLoft.x;
  float phi = atan( vLoft.z, vLoft.y );
  float ph = vLoft.y >= 0.0 ? phi : ( phi >= 0.0 ? 3.14159265 - phi : -3.14159265 - phi );
  float sa = abs( vArc.x ), hp = max( vArc.y, 1e-3 );
  vec2 pc = vec2( x, sa );
  float fpx = max( length( fwidth( pc ) ) * 0.75, 1e-4 );
  vec3 jq = vec3( x * 0.06, ph * 4.0, uInkTime * 0.731 );          // 手绘抖动（材质里的线随墨线时钟一拍二呼吸）
  float jx = toonNoise( jq ) * 0.5, js = toonNoise( jq + 19.1 ) * 0.5;
  // —— 区域：墨玉（背）/ 烟色过渡带 / 月白（腹） ——
  float sb = xuanVb( x ) * hp;
  float dB = sb - sa;                                               // > 0：交界线上方（背侧），世界单位
  float nB = toonNoise( vec3( x * 0.045, sa * 0.05, 5.0 ) ) * 5.0 + toonNoise( vec3( x * 0.17, sa * 0.2, 9.0 ) ) * 1.6;
  float dark = xFill( - ( dB + nB ), fpx );
  float core = xFill( - ( dB + nB - 6.5 ), fpx );
  vec3 c = mix( uBelly, mix( uSmoke, uJade, core ), dark );
  // 墨玉云絮斑（斑驳）：两档
  vec3 P = vToonObj * 0.021;
  float mo = toonFbm( P + vec3( 0.0, 3.1, 0.0 ) );
  float fmo = max( fwidth( mo ), 1e-4 );
  float mot = smoothstep( 0.16 - fmo, 0.16 + fmo, mo ), mot2 = smoothstep( 0.33 - fmo, 0.33 + fmo, mo );
  c = mix( c, mix( uJade * 1.32, uVein, mot2 ), mot * core * 0.9 );
  // 细一档的云絮（近景才看得见）
  float mf = toonFbm( vToonObj * 0.075 + vec3( 5.0, 0.0, 2.0 ) );
  float fmf = max( fwidth( mf ), 1e-4 );
  c = mix( c, c * vec3( 1.14, 1.13, 1.2 ), smoothstep( 0.2 - fmf, 0.2 + fmf, mf ) * core * 0.7 );
  // 墨点
  float spn = toonNoise( vToonObj * 0.32 + 70.0 ) + 0.35 * toonNoise( vToonObj * 0.9 + 13.0 );
  float fsp = max( fwidth( spn ), 1e-4 );
  c *= 1.0 - 0.3 * smoothstep( 0.62 - fsp, 0.62 + fsp, spn ) * core;
  // 腹侧淡斑
  float bn = toonNoise( vToonObj * 0.09 + 40.0 );
  float fbn = max( fwidth( bn ), 1e-4 );
  c *= 1.0 - 0.09 * smoothstep( 0.4 - fbn, 0.4 + fbn, bn ) * ( 1.0 - dark );
  // —— 鳞：腹部淡金线（墨玉区不画线，只留极淡的鳞光） ——
  vec2 q = vec2( vArc.z, sa / max( vArc.w, 0.5 ) );
  vec2 sc = xuanScale( q );
  float fq = max( fwidth( sc.x ), 1e-4 );
  float sline = 1.0 - smoothstep( 0.045 - fq, 0.045 + fq, sc.x );
  float crest = ( 1.0 - smoothstep( 0.2 - fq, 0.2 + fq, sc.x ) ) * toonSS( 0.0, -0.3, sc.y );
  float gxh = ( ph > -1.0 && ph < 0.7 ) ? gillX( ph ) : 196.0;
  float headless = toonSS( gxh - 1.0, gxh - 6.0, x ) * toonSS( -216.0, -204.0, x );
  c = mix( c, c * 1.07 + vec3( 0.012 ), crest * headless * ( 1.0 - core * 0.75 ) );
  c = mix( c, uScaleGold, sline * headless * 0.85 * ( 1.0 - dark ) );
  // —— 描金：祥云（带螺线的圆，后画的压前画的）+ 云尾 ——
  float lw = 0.6;                                                   // 金里勾线半宽（世界单位）
  int top = -1; float nearOut = 1e9; float uni = 1e9;
  for ( int i = 0; i < NCURL; i ++ ) {
    vec4 k = uCurl[ i ];
    if ( k.z <= 0.0 ) continue;
    vec2 d = pc - k.xy;
    if ( abs( d.x ) > k.z + 3.0 || abs( d.y ) > k.z + 3.0 ) continue;
    float di = length( d ) - k.z;
    uni = min( uni, di );
    if ( di < 0.0 ) { top = i; nearOut = 1e9; } else nearOut = min( nearOut, di );
  }
  float gold = 0.0, gl = 0.0;
  if ( top >= 0 ) {
    vec4 k = uCurl[ top ];
    vec2 d = pc - k.xy;
    float r = length( d ), turns = abs( k.w ), spin = sign( k.w );
    float a = atan( d.y, d.x ) * spin + uCurl2[ top ].x;
    float t = r / k.z * turns - a / 6.2831853;
    float dArm = ( 0.5 - abs( fract( t ) - 0.5 ) ) * k.z / turns;
    float spiral = xLine( dArm, lw, fpx ) * smoothstep( 0.1 * k.z, 0.22 * k.z, r );
    float edge = xLine( k.z - r - lw * 1.7, lw, fpx );
    gl = max( spiral, edge );
    gl = max( gl, xLine( nearOut - 0.2, lw, fpx ) );
    gold = 1.0;
  }
  for ( int i = 0; i < NTAIL; i ++ ) {
    vec4 t = uTail[ i ];
    if ( t.z <= 0.0 ) continue;
    float tau = ( t.x - pc.x ) / t.z;
    if ( tau < -0.05 || tau > 1.05 ) continue;
    vec4 t2 = uTail2[ i ];
    float tc = clamp( tau, 0.0, 1.0 );
    float yc = t.y + t2.x * sin( 3.14159265 * tc * t2.y + t2.z ) * tc - t2.w * tc * tc;
    float hw = t.w * pow( 1.0 - tc, 0.7 ) * smoothstep( -0.05, 0.08, tau );
    float dy = abs( pc.y - yc );
    float inT = xFill( dy - hw, fpx ) * step( 0.0, tau ) * step( tau, 1.0 );
    gold = max( gold, inT );
    gl = max( gl, xLine( pc.y - yc, max( hw * 0.14, 0.12 ), fpx ) * inT * step( 1.6, hw ) );
  }
  // —— 描金：海浪纹（交界线上方：三道平行波线从浪背缓降、在浪头卷成螺旋，浪头前上方三粒浪花）——
  float H = uWaveH, Pw = uWaveP;
  float wb = toonSS( 168.0, 138.0, x ) * toonSS( -196.0, -170.0, x );
  if ( wb > 0.0 && dB > -4.0 && dB < H * 1.6 ) {
    float wy = dB / H;                                              // 0 = 交界线，1 = 带顶
    float xi = x / Pw - 0.3;
    float tau = fract( xi );                                         // 0 = 浪头，往头方向增大（浪背）
    float ci = floor( xi );
    float yTop = 0.22 + 0.55 * pow( 1.0 - tau, 1.7 );
    float fwy = fpx / H;
    for ( int k = 0; k < 3; k ++ ) {
      float fk = float( k );
      float yk = yTop - 0.17 * fk;
      float wl = 1.0 - smoothstep( ( 0.05 - 0.01 * fk ) - fwy, ( 0.05 - 0.01 * fk ) + fwy, abs( wy - yk ) );
      gold = max( gold, wl * wb * step( 0.04, yk ) );
    }
    // 浪头卷：两个相邻周期都查（卷伸进前一段）
    for ( int j = 0; j <= 1; j ++ ) {
      float cj = ci + float( j );
      vec2 cen = vec2( ( cj + 0.3 ) * Pw - 0.02 * Pw, H * 0.56 );
      float rc = H * 0.3;
      vec2 d = vec2( x, dB ) - cen;
      float r = length( d );
      float inC = xFill( r - rc, fpx );
      float a = atan( d.y, - d.x );
      float t = r / rc * 1.6 - a / 6.2831853;
      float dArm = ( 0.5 - abs( fract( t ) - 0.5 ) ) * rc / 1.6;
      gold = max( gold, inC * wb );
      gl = max( gl, xLine( dArm, lw * 0.8, fpx ) * smoothstep( 0.12 * rc, 0.25 * rc, r ) * inC * wb );
      for ( int m = 0; m < 3; m ++ ) {
        float fm = float( m );
        vec2 sp = cen + vec2( - Pw * ( 0.13 + 0.12 * fm ), H * ( 0.52 + 0.2 * fm ) );
        gold = max( gold, xFill( length( vec2( x, dB ) - sp ) - H * ( 0.07 - 0.014 * fm ), fpx ) * wb );
      }
    }
  }
  // 描金磨损（斑驳）：金面上撒一点小缺口，露出底下的墨玉
  float wn = toonNoise( vToonObj * 0.55 + 7.0 ) + 0.5 * toonNoise( vToonObj * 1.3 + 3.0 );
  float fw = max( fwidth( wn ), 1e-4 );
  float wear = smoothstep( 0.66 - fw, 0.66 + fw, wn );
  gold *= 1.0 - wear * 0.85;
  gold *= dark * 0.9 + 0.1;
  // 洒金小点（云附近）
  vec2 gq = pc / 2.4;
  vec2 gi = floor( gq ), gf = fract( gq ) - 0.5;
  vec3 gh = toonHash33( vec3( gi, 11.0 ) ) * 0.5 + 0.5;
  float near = toonSS( 24.0, 4.0, uni );
  float dot0 = xFill( length( gf - ( gh.xy - 0.5 ) * 0.5 ) * 2.4 - mix( 0.2, 0.4, gh.z ), fpx ) * step( gh.z, 0.3 * near ) * core;
  gold = max( gold, dot0 );
  vec3 gc = mix( uGold, uGold * vec3( 1.08, 1.0, 0.86 ), toonNoise( vToonObj * 0.08 ) * 0.5 + 0.5 );
  c = mix( c, gc, gold );
  c = mix( c, uGoldDeep, gl * gold );
  toonMetal = max( toonMetal, gold * ( 1.0 - gl * 0.4 ) );
  vec2 tq = pc / 1.8;
  vec2 ti = floor( tq ), tf = fract( tq ) - 0.5;
  vec3 th = toonHash33( vec3( ti, floor( uInkTime * 0.5 ) + 3.0 ) ) * 0.5 + 0.5;
  float twk = xFill( length( tf - ( th.xy - 0.5 ) * 0.4 ) * 1.8 - 0.24, fpx ) * step( 0.955, th.z ) * gold * ( 1.0 - gl );
  // —— 头：嘴线、唇、鼻孔、鳃盖金线、眼眉弧、朱砂 ——
  float fwp = max( fwidth( ph ), 1e-5 );
  float pm = mouthPh( x );
  float inMouth = toonSS( 293.5, 290.5, x ) * smoothstep( 259.0, 264.0, x );
  float lip = ( 1.0 - smoothstep( 0.09, 0.15, abs( ph - pm + 0.02 ) ) ) * smoothstep( 254.0, 266.0, x );
  c = mix( c, uLip, lip );
  float mouth = ( 1.0 - smoothstep( 0.9 * fwp, 2.2 * fwp, abs( ph + js * 0.006 - pm ) ) ) * inMouth;
  toonInk = max( toonInk, mouth );
  float corner = ( 1.0 - smoothstep( 0.9 * fwp, 2.0 * fwp, abs( ph - ( pm - ( 261.0 - x ) * 0.012 ) ) ) ) * toonSS( 262.0, 260.0, x ) * smoothstep( 246.0, 252.0, x );
  toonInk = max( toonInk, corner * 0.8 );
  vec2 nd = vec2( x - 281.0, ( ph - 0.26 ) * 26.0 );
  toonInk = max( toonInk, xFill( length( nd ) - 1.7, fpx ) * 0.9 );
  // 鳃盖：只画中下段，一道金线 + 后面一道墨线，两头淡出
  float gx = gillX( ph ) + jx;
  float gillOn = toonSS( 0.62, 0.3, ph ) * toonSS( -0.98, -0.7, ph );
  float fgx = max( fwidth( x ), 1e-4 );
  float gillGold = ( 1.0 - smoothstep( 0.5 - fgx, 0.5 + fgx, abs( x - gx - 1.4 ) ) ) * gillOn;
  float gillInk = ( 1.0 - smoothstep( 0.45 - fgx, 0.45 + fgx, abs( x - gx + 0.7 ) ) ) * gillOn;
  c = mix( c, uGold, gillGold * 0.95 ); toonMetal = max( toonMetal, gillGold );
  toonInk = max( toonInk, gillInk * 0.7 );
  // 眼：眉弧（眼上方一道墨弧）
  vec2 de = vec2( x + jx - uKunEye.x, ( ph + js * 0.004 - uKunEye.y ) * uKunEye.w );
  float rr = length( de ) / uKunEye.z;
  float upv = de.y / max( length( de ), 1e-3 );
  float frr = max( fwidth( rr ), 1e-5 );
  float brow = ( 1.0 - smoothstep( 0.9 * frr, 2.1 * frr, abs( rr - 1.5 ) ) ) * smoothstep( 0.25, 0.6, upv ) * toonSS( 0.9, 0.55, abs( de.x / max( length( de ), 1e-3 ) + 0.1 ) );
  toonInk = max( toonInk, brow * 0.85 );
  float e3 = length( vec3( vToonObj.xy, abs( vToonObj.z ) ) - uEyeC.xyz ) / uEyeC.w;
  float fe3 = max( fwidth( e3 ), 1e-5 );
  float ering = 1.0 - smoothstep( 0.035 - fe3, 0.035 + fe3, abs( e3 - 1.27 ) );
  c = mix( c, uGold, ering * 0.92 ); toonMetal = max( toonMetal, ering );
  toonInk = max( toonInk, ( 1.0 - smoothstep( 0.03 - fe3, 0.03 + fe3, abs( e3 - 1.36 ) ) ) * 0.45 );
  // 朱砂：一笔“挑”——从眼后角起笔，中段饱满，往后上方挑出尖尾；上面再一笔细的
  vec2 ea = uEyeArc.xy; float RE = uEyeArc.z;
  float cin = 0.0;
  for ( int m = 0; m < 2; m ++ ) {
    float fm = float( m );
    float len = RE * mix( 2.6, 1.5, fm );
    float x0 = ea.x - RE * mix( 1.05, 1.32, fm );
    float tau = ( x0 - x ) / len;
    float tcl = clamp( tau, 0.0, 1.0 );
    float yc = ea.y + RE * mix( 0.05, -0.4, fm ) - RE * mix( 1.05, 0.62, fm ) * pow( tcl, 1.5 );
    float hw = RE * mix( 0.3, 0.13, fm ) * pow( tcl, 0.45 ) * pow( 1.0 - tcl, 1.5 ) * 2.5;
    float across = ( sa - yc ) / max( hw, 1e-3 );
    float dry = smoothstep( 0.52, 0.66, toonNoise( vec3( across * 2.6, tau * 1.6 + fm * 7.0, 31.0 ) ) * 0.5 + 0.5 ) * smoothstep( 0.3, 0.8, tau );
    cin = max( cin, xFill( abs( sa - yc ) - hw, fpx ) * step( 0.0, tau ) * step( tau, 1.0 ) * ( 1.0 - dry ) );
  }
  c = mix( c, uCinnabar, cin );
  toonOverlay = mix( toonOverlay, vec4( uCinnabar, 0.78 ), cin );
  toonOverlay = mix( toonOverlay, vec4( 1.0, 0.96, 0.84, 1.0 ), twk );
  // 墨玉光泽：背侧亮带（金和白腹不要）
  toonGloss = dark * ( 1.0 - gold ) * 0.95;
  diffuseColor.rgb = c;
}
`;

// ───────────────────────── 飘带（CPU 每拍重算的带状网格） ─────────────────────────
// 中线按“方向角”沿弧长积分：长度恒定（丝绸不伸长）。角度 = 基础走向 + 跟随身体（时间延迟的跟随者）+ 自身飘动
// 宽向 = 把“上”投影到垂直于中线的平面，再绕中线扭转（twist）→ 宽面大多朝侧面，扭过来时变窄露出另一面
const RIBBONS = [
  // 尾鳍四条：根埋在尾柄里，扇形张开后拖在后面；同一股气流里，四条的波相位只差一点（整体同步，不会互相穿）
  { id: 'tA', kind: 'tail', dy: 5.0, dz: 4.2, L: 236, wr: 26, wm: 30, p0: 0.66, p1: 0.04, y0: 0.0, y1: 0.03, ap: 0.5, ay: 0.05, k: 0.9, om: 2.4, fph: 0.0, ta: 0.95, tk: 1.3, tom: 2.1, tph: 0.4, cu: 0.5, a0: 0.86, a1: 0.42, rays: 1 },
  { id: 'tB', kind: 'tail', dy: 2.2, dz: 2.0, L: 180, wr: 22, wm: 23, p0: 0.25, p1: -0.06, y0: -0.02, y1: -0.04, ap: 0.48, ay: 0.05, k: 0.92, om: 2.4, fph: 0.15, ta: 0.85, tk: 1.4, tom: 2.1, tph: 1.6, cu: -0.3, a0: 0.86, a1: 0.42, rays: 1 },
  { id: 'tC', kind: 'tail', dy: -2.2, dz: -2.0, L: 194, wr: 22, wm: 23, p0: -0.24, p1: 0.04, y0: 0.02, y1: 0.05, ap: 0.48, ay: 0.05, k: 0.94, om: 2.4, fph: 0.3, ta: 0.85, tk: 1.3, tom: 2.1, tph: 2.9, cu: 0.3, a0: 0.86, a1: 0.42, rays: 1 },
  { id: 'tD', kind: 'tail', dy: -5.0, dz: -4.2, L: 250, wr: 26, wm: 31, p0: -0.7, p1: -0.05, y0: 0.0, y1: -0.03, ap: 0.5, ay: 0.05, k: 0.88, om: 2.4, fph: 0.45, ta: 0.95, tk: 1.2, tom: 2.1, tph: 4.1, cu: -0.5, a0: 0.86, a1: 0.42, rays: 1 },
  // 胸鳍：每侧两条，从侧腹斜向后下飘，再往后拖（side 镜像）
  { id: 'pA', kind: 'pec', x: 166, rph: -0.62, sink: 5, L: 300, wr: 36, wm: 22, tw0: -0.6, p0: -0.52, p1: 0.08, y0: 0.32, y1: 0.05, ap: 0.5, ay: 0.08, k: 0.9, om: 2.2, fph: 0.5, ta: 1.1, tk: 1.2, tom: 1.9, tph: 0.2, cu: 0.6, a0: 0.84, a1: 0.4, rays: 1 },
  { id: 'pB', kind: 'pec', x: 158, rph: -0.82, sink: 5, L: 226, wr: 24, wm: 15, tw0: -0.7, p0: -0.9, p1: -0.06, y0: 0.12, y1: 0.0, ap: 0.44, ay: 0.06, k: 0.95, om: 2.2, fph: 1.1, ta: 1.0, tk: 1.3, tom: 1.9, tph: 1.9, cu: -0.4, a0: 0.82, a1: 0.4, rays: 0 },
];
const RIB_C = 150;   // 跟随身体的波沿飘带的传播速度（单位 / 秒）

// ───────────────────────── 主体 ─────────────────────────
/**
 * createKun(opts) → { group, setPose(ts, o), eyeWorld(target, ref), fitShadow(light, o), outlineMeshes, length, eyeRadius, uniforms, ribbons, eyes, checkClearance }
 * 与 src/kun.js 的 createKun 同接口、同坐标约定（长约 600、头朝 +X、上为 +Y、原点在身体中心），换进正片只改 import。
 * opts.lod   0.1–1：网格密度与金箔片数量倍率（大远景 0.35–0.5）
 * opts.seed  散布种子（默认 20261103）
 * opts.ribbonInk  飘带进不进描边（默认 true：飘带外轮廓有细墨线；false：只靠自身金边）
 * opts.blinkPeriod / blinkOffset：自动眨眼周期 / 首次时刻（秒，默认 5 / 1.5）
 * setPose(ts, { blink, look, t })：ts 为身体时间（调用方按一拍三量化）；t 为原始时间（秒），飘带、须、背鳍按一拍二自己量化；
 *   不给 t 时跟身体同拍。blink 0 睁 → 1 闭；look 为世界坐标 Vector3，眼珠转向它（限幅）
 * eyeWorld(target, ref)：ref = 相机位置（取近的那只眼）/ 1（+Z 侧）/ -1（-Z 侧，默认）
 * fitShadow(light, { size })：把主光阴影相机罩到鲲身上（方向不变）
 * uniforms.uKunAmp / uKunAmpZ / uKunWave / uKunOmega：竖直波幅 / 侧向波幅 / 波数 / 角频率
 */
export function createKun(opts = {}) {
  const o = { lod: 1, seed: 20261103, ribbonInk: true, blinkPeriod: 5, blinkOffset: 1.5, ...opts };
  const lod = clamp(o.lod, 0.1, 1);
  const N = n => Math.max(4, Math.round(n * lod));
  const R = mulberry(o.seed);
  const noise = createNoise3D(mulberry(o.seed + 11));

  const U = {
    uKunT: { value: 0 }, uKunAmp: { value: 20 }, uKunAmpZ: { value: 12 }, uKunWave: { value: 0.85 }, uKunOmega: { value: TAU / 5 }, uKunHalfL: { value: 300 }, uKunPhZ: { value: -1.2 },
  };
  const group = new THREE.Group(); group.name = 'kun-xuan';
  const outlineMeshes = [];
  const add = (parent, mesh) => { parent.add(mesh); if (mesh.userData.outline) outlineMeshes.push(mesh); return mesh; };
  const mat = (preset, extra = {}) => makeXuanMaterial({ ...XUAN_PRESETS[preset], ...extra, uniforms: { ...U, ...(extra.uniforms || {}) } });

  // —— 眼睛参数 ——
  const EYE_X = 242, EYE_PH = 0.22, RE = 11;
  const eyeSecR = ((fT(EYE_X) - fB(EYE_X)) / 2 + fW(EYE_X)) / 2;

  // —— 身体 ——
  const NU = Math.round(lerp(90, 240, lod)), NV = Math.round(lerp(56, 128, lod)) & ~3;
  const bodyGeo = buildBody(NU, NV);
  // 眼睛在弧长坐标里的位置（朱砂用）
  const eyeRing = bodyGeo.userData.rings.reduce((b, r) => Math.abs(r.x - EYE_X) < Math.abs(b.x - EYE_X) ? r : b);
  let eyeArcS = 0; { let acc = 0, prev = bodyPoint(EYE_X, Math.PI / 2); for (let i = 1; i <= 200; i++) { const ph = Math.PI / 2 - (Math.PI / 2 - EYE_PH) * i / 200, p = bodyPoint(EYE_X, ph); acc += p.distanceTo(prev); prev = p; } eyeArcS = acc; }
  const CL = layoutClouds();
  // 眼球中心（+Z 侧；着色器里对 z 取绝对值，两侧通用），w = 眼半径
  const eyeCenterUniform = (() => { const sp = bodyPoint(EYE_X, EYE_PH), n = bodyNormal(EYE_X, EYE_PH); sp.addScaledVector(n, -0.55 * RE); return new THREE.Vector4(sp.x, sp.y, sp.z, RE); })();
  const bodyMat = mat('body', {
    uniforms: {
      uCurl: { value: CL.C1 }, uCurl2: { value: CL.C2 }, uTail: { value: CL.T1 }, uTail2: { value: CL.T2 },
      uKunEye: { value: new THREE.Vector4(EYE_X, EYE_PH, RE, eyeSecR) }, uEyeArc: { value: new THREE.Vector4(EYE_X, eyeArcS, RE, eyeRing.hp) }, uEyeC: { value: eyeCenterUniform },
      uJade: { value: new THREE.Color(XUAN.jade) }, uSmoke: { value: new THREE.Color(XUAN.smoke) }, uBelly: { value: new THREE.Color(XUAN.belly) },
      uScaleGold: { value: new THREE.Color(XUAN.scaleGold) }, uGold: { value: new THREE.Color(XUAN.gold) }, uGoldDeep: { value: new THREE.Color(XUAN.goldDeep) },
      uCinnabar: { value: new THREE.Color(XUAN.cinnabar) }, uLip: { value: new THREE.Color('#dccbaa') }, uVein: { value: new THREE.Color('#545474') },
      uWaveH: { value: 21 }, uWaveP: { value: 38 },
    },
    ...bendHooks({ extraPars: 'attribute vec3 aLoft;\nattribute vec4 aArc;\nvarying vec3 vLoft;\nvarying vec4 vArc;\n', extraBegin: 'vLoft = aLoft; vArc = aArc;' }),
    fragmentPars: BODY_PARS + `float mouthPh( float x ) { return mix( -0.52, -0.3, smoothstep( 262.0, 291.0, x ) ); }\nfloat gillX( float ph ) { return 186.0 + 16.0 * ph * ph; }\n`,
    fragmentAlbedo: BODY_ALBEDO,
  });
  const body = add(group, bindXuan(new THREE.Mesh(bodyGeo, bodyMat), bodyMat));
  body.name = 'kun-body'; body.frustumCulled = false;

  // —— 眼睛（琥珀金虹膜、圆瞳；眼睑压一点，像半垂的丹凤眼）——
  const makeEyeMat = () => makeXuanMaterial({ ...XUAN_PRESETS.body, color: '#4a3326', shade1: '#2e2020', shade2: '#1d1518', rimAmt: 0.5, cityAmt: 0.0, cityFlat: 0.35, sheenAmt: 0, glossAmt: 0,
    uniforms: {
      uIrisA: { value: 0.98 }, uPupilA: { value: 0.32 },
      uIrisCol: { value: new THREE.Color('#b55a17') }, uIrisCol2: { value: new THREE.Color('#f5c95c') }, uRingCol: { value: new THREE.Color('#3b1a0c') }, uPupilCol: { value: new THREE.Color('#0f0b16') },
      uReflCol: { value: new THREE.Color('#c9b8ef') },
      uCatch1: { value: new THREE.Vector4(0, 0, 1, 0.985) }, uCatch2: { value: new THREE.Vector4(0, 0, 1, 0.997) }, uCatchCol: { value: new THREE.Color('#fffaf2') },
      uLidU: { value: new THREE.Vector3(0, 1, 0) }, uLidL: { value: new THREE.Vector3(0, -1, 0) },
    },
    fragmentPars: 'uniform float uIrisA, uPupilA;\nuniform vec3 uIrisCol, uIrisCol2, uRingCol, uPupilCol, uCatchCol, uLidU, uLidL, uReflCol;\nuniform vec4 uCatch1, uCatch2;\n',
    fragmentAlbedo: /* glsl */`
    {
      vec3 d = normalize( vToonObj );
      float ang = acos( clamp( d.z, -1.0, 1.0 ) ) + toonNoise( vec3( d.xy * 6.0, uInkTime * 0.731 ) ) * 0.006;
      float fa = max( fwidth( ang ), 1e-5 );
      float iris = 1.0 - smoothstep( uIrisA - fa, uIrisA + fa, ang );
      float pa = length( vec2( atan( d.x, d.z ), atan( d.y, d.z ) ) );
      float fp = max( fwidth( pa ), 1e-5 );
      float pupil = 1.0 - smoothstep( uPupilA - fp, uPupilA + fp, pa );
      float collar = smoothstep( uIrisA - 0.12 - fa, uIrisA - 0.12 + fa, ang ) * iris;
      float az = atan( d.y, d.x );
      float stri = 0.5 + 0.5 * sin( az * 30.0 + toonNoise( d * 7.0 ) * 3.0 );
      float rad = smoothstep( uPupilA, uIrisA, ang );
      vec3 ic = mix( uIrisCol2, uIrisCol, smoothstep( 0.25, 0.85, rad ) );
      ic = mix( ic, ic * 0.74, step( 0.62, stri ) * rad );
      ic = mix( ic, uRingCol, collar );
      // 瞳孔外一圈金
      float pr = smoothstep( uPupilA + 0.03 - fp, uPupilA + 0.03 + fp, pa ) * ( 1.0 - smoothstep( uPupilA + 0.09 - fp, uPupilA + 0.09 + fp, pa ) );
      ic = mix( ic, vec3( 1.0, 0.86, 0.45 ), pr * 0.8 );
      diffuseColor.rgb = mix( diffuseColor.rgb, ic, iris );
      diffuseColor.rgb = mix( diffuseColor.rgb, uPupilCol, pupil );
      toonInk = max( toonInk, ( 1.0 - smoothstep( 0.7 * fa, 2.2 * fa, abs( ang - uIrisA ) ) ) * 0.95 );
      toonInk = max( toonInk, ( 1.0 - smoothstep( 0.7 * fp, 1.8 * fp, abs( pa - uPupilA ) ) ) * 0.5 );
      float c1 = dot( d, uCatch1.xyz ), c2 = dot( d, uCatch2.xyz );
      float fc = max( fwidth( c1 ), 1e-5 );
      float k = max( smoothstep( uCatch1.w - fc, uCatch1.w + fc, c1 ), smoothstep( uCatch2.w - fc, uCatch2.w + fc, c2 ) );
      float du = dot( d, uLidU ), dl = dot( d, uLidL ), fd = max( fwidth( du ), 1e-5 );
      float front = smoothstep( 0.1, 0.6, d.z );
      float lash = ( 1.0 - smoothstep( 0.12 * front + 0.02 - fd, 0.12 * front + 0.02 + fd, - du ) ) * front;
      float low = ( 1.0 - smoothstep( 0.035 - fd, 0.035 + fd, - dl ) ) * front;
      toonInk = max( toonInk, max( lash * 0.95, low * 0.6 ) );
      float refl = smoothstep( -0.5, -0.4, du ) * ( 1.0 - smoothstep( -0.3, -0.22, du ) ) * smoothstep( 0.35, 0.75, d.z ) * iris * ( 1.0 - pupil );
      toonOverlay = vec4( uReflCol, refl * 0.28 );
      toonOverlay = mix( toonOverlay, vec4( uCatchCol, 1.0 ), k * ( 1.0 - lash ) );
    }`,
  });
  const lidMat = makeXuanMaterial({ ...XUAN_PRESETS.body, color: XUAN.jade, shade1: XUAN.jadeShade1, shade2: XUAN.jadeShade2, objectId: bodyMat.userData.toon.uObjectId.value, side: THREE.DoubleSide, sheenAmt: 0.5,
    uniforms: { uGold: { value: new THREE.Color(XUAN.gold) } },
    fragmentPars: 'uniform vec3 uGold;\n',
    fragmentAlbedo: /* glsl */`
    {
      vec3 d = normalize( vToonObj );
      float e = asin( clamp( abs( d.y ), 0.0, 1.0 ) ), fe = max( fwidth( e ), 1e-5 );
      float front = smoothstep( 0.15, 0.55, d.z );
      float rim = 1.0 - smoothstep( 0.08 - fe, 0.08 + fe, e );
      float gline = ( 1.0 - smoothstep( 0.8 * fe, 1.9 * fe, abs( e - 0.2 ) ) ) * smoothstep( 0.3, 0.7, d.z ) * step( 0.0, d.y );
      diffuseColor.rgb = mix( diffuseColor.rgb, uGold, gline );
      toonMetal = gline;
      toonInk = max( toonInk, rim * front * 0.95 );
      toonGloss = 1.0 - gline;
      if ( ! gl_FrontFacing ) toonOverlay = vec4( 0.045, 0.035, 0.06, 1.0 );   // 眼睑内侧：眼窝的暗（不吃城市暖光）
    }` });
  const eyes = mountEyes({ point: bodyPoint, normal: bodyNormal, x: EYE_X, ph: EYE_PH, inset: 0.55 * RE, gaze: [0.3, -0.06], parent: group, build: (side, eg) => {
    eg.name = 'kun-eye-' + (side > 0 ? 'R' : 'L');
    const em = makeEyeMat();
    const ball = add(eg, bindXuan(new THREE.Mesh(new THREE.SphereGeometry(RE, 48, 32), em), em, { castShadow: false }));
    const lidU = new THREE.Group(), lidL = new THREE.Group(), [shellU, shellL] = lidShells(RE * 1.08, 40, 12);
    add(lidU, bindXuan(new THREE.Mesh(shellU, lidMat), lidMat));
    add(lidL, bindXuan(new THREE.Mesh(shellL, lidMat), lidMat));
    eg.add(lidU, lidL);
    return { ball, lidU, lidL, mat: em, frame: eyeFrame(em.userData.toon) };
  } });

  // —— 洒金：金箔片按权重撒在墨玉区（云附近、背脊更密），跟着身体弯 ——
  const pAttr = bodyGeo.attributes.position, nAttr = bodyGeo.attributes.normal, aAttr = bodyGeo.attributes.aArc, lAttr = bodyGeo.attributes.aLoft;
  const nv = pAttr.count, wFlake = new Float32Array(nv);
  const eyeC = eyes.map(e => e.group.position);
  const Pv = new THREE.Vector3();
  for (let i = 0; i < nv; i++) {
    Pv.fromBufferAttribute(pAttr, i);
    const x = Pv.x, sa = Math.abs(aAttr.getX(i)), hp = aAttr.getY(i);
    const dB = vbJS(x) * hp - sa;
    const dark = sstep(2, 10, dB);
    let near = 0;
    for (const c of CL.curls) { const d = Math.hypot(x - c.u, sa - c.s) - c.R; near = Math.max(near, sstep(26, 4, d)); }
    const ridge = sstep(0.12, 0.0, sa / Math.max(hp, 1));
    const n0 = noise(Pv.x * 0.02, Pv.y * 0.02, Pv.z * 0.02);
    const nearEye = Math.min(...eyeC.map(c => c.distanceTo(Pv))) / RE;
    wFlake[i] = dark * (0.05 + near * 1.5 + ridge * 0.25) * (0.4 + 0.6 * sstep(-0.3, 0.4, n0)) * sstep(2.0, 3.0, nearEye) * sstep(270, 245, x) * sstep(-215, -190, x);
  }
  const sampler = weightedSampler(withWeights(bodyGeo, { wFlake }), 'wFlake', o.seed + 101);
  const GOLDS = ['#e9c46a', '#d9a441', '#f3d98b', '#c99a3a', '#efc978'];
  const tp = new THREE.Vector3(), tn = new THREE.Vector3();
  const flakeMat = mat('gold', { outlineW: 1, instanceId: false, objectId: bodyMat.userData.toon.uObjectId.value, fragmentAlbedo: 'toonMetal = 1.0;', ...bendHooks() });
  const nFl = N(420);
  const flakes = [];
  for (let i = 0; i < nFl; i++) {
    sampler.sample(tp, tn);
    const s = (0.38 + Math.pow(R(), 1.8) * 0.75) / Math.sqrt(Math.max(lod, 0.25));
    const tilt = new THREE.Vector3((R() - 0.5) * 0.7, 0, (R() - 0.5) * 0.7);
    flakes.push({ m: place(tp, tn, { yaw: R() * TAU, scale: new THREE.Vector3(s, s, s), sink: -0.05, lean: tilt }), c: pick(R(), GOLDS) });
  }
  add(group, instanced(flake(77), flakeMat, flakes, 'kun-gold-flakes', { bind: (m, mt) => bindXuan(m, mt, { castShadow: false }) }));   // 金箔片：不规则六边薄片

  // —— 弯曲（JS 版，与 GLSL 一致）——
  const J = WAVE.js(U), jsBend = J.bend;
  const bendPoint = (p, T, out = new THREE.Vector3()) => J.point(p, T, out);
  const bendDir = (n, x, T, out = new THREE.Vector3()) => J.dir(n, x, T, out);

  // —— 飘带材质：月白绸，金边，根部有鳍条，逆光透亮；彩色通道半透明 ——
  const silkPars = 'varying vec3 vRib;\nuniform vec3 uSilk, uHem, uRay;\nuniform float uRays, uA0, uA1;\n';
  const silkAlbedo = /* glsl */`
  {
    float s = vRib.x, w = vRib.y;
    float aw = abs( w );
    float fw0 = max( fwidth( aw ), 1e-4 );
    float hem = smoothstep( 0.8 - fw0, 0.8 + fw0, aw );
    // 两道淡淡的折痕（顺着长度）
    float fold = ( 1.0 - smoothstep( 0.02 - fw0, 0.02 + fw0, abs( aw - 0.42 + 0.04 * sin( s * 23.0 ) ) ) ) * smoothstep( 0.05, 0.2, s );
    // 鳍条：根部一束金线，往后散开、淡出
    float rays = 0.0;
    if ( uRays > 0.0 ) {
      float rq = w * 3.5;
      float dr = abs( fract( rq + 0.5 ) - 0.5 );
      float fr = max( fwidth( rq ), 1e-4 );
      rays = ( 1.0 - smoothstep( 0.06 - fr, 0.06 + fr, dr ) ) * ( 1.0 - smoothstep( 0.12, 0.42, s ) ) * uRays * ( 1.0 - hem );
    }
    vec3 c = mix( uSilk, uSilk * vec3( 1.0, 0.93, 0.86 ), smoothstep( 0.3, 1.0, s ) );
    c = mix( c, c * vec3( 0.9, 0.88, 0.96 ), fold * 0.6 );
    c = mix( c, uRay, rays * 0.85 );
    c = mix( c, uHem, hem );
    diffuseColor.rgb = c;
    toonMetal = max( hem, rays * 0.6 );
    toonTrans = 1.0 - hem * 0.6;
    diffuseColor.a = mix( uA0, uA1, smoothstep( 0.1, 1.0, s ) ) * ( 1.0 - 0.45 * smoothstep( 0.9, 1.0, s ) );
    diffuseColor.a = mix( diffuseColor.a, 1.0, max( hem, rays ) * 0.8 );
  }`;
  const makeSilk = (spec) => mat('silk', {
    color: XUAN.silk, side: THREE.DoubleSide, translucent: true, outlineW: 0.55, instanceId: false,
    uniforms: { uSilk: { value: new THREE.Color(XUAN.silk) }, uHem: { value: new THREE.Color(XUAN.silkHem) }, uRay: { value: new THREE.Color('#e2b35a') }, uRays: { value: spec.rays || 0 }, uA0: { value: spec.a0 ?? 0.9 }, uA1: { value: spec.a1 ?? 0.55 } },
    vertexPars: 'attribute vec3 aRib;\nvarying vec3 vRib;\n', vertexBegin: 'vRib = aRib;',
    fragmentPars: silkPars, fragmentAlbedo: silkAlbedo,
  });

  // 飘带实例：每条一个网格；spec.side 区分胸鳍左右
  const ribbons = [];
  function makeRibbon(spec, side) {
    const nS = Math.max(24, Math.round(spec.L / 3.2 * lerp(0.6, 1, lod))), nW = 5;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(nS * nW * 3), rib = new Float32Array(nS * nW * 3), idx = [];
    for (let i = 0; i < nS; i++) for (let j = 0; j < nW; j++) { const k = i * nW + j; rib[k * 3] = i / (nS - 1); rib[k * 3 + 1] = j / (nW - 1) * 2 - 1; rib[k * 3 + 2] = spec.L; }
    for (let i = 0; i < nS - 1; i++) for (let j = 0; j < nW - 1; j++) { const a = i * nW + j, b = a + nW; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aRib', new THREE.BufferAttribute(rib, 3));
    g.setIndex(idx);
    const m = makeSilk(spec);
    const mesh = new THREE.Mesh(g, m);
    bindXuan(mesh, m, { castShadow: false, receiveShadow: true, outline: o.ribbonInk });
    if (!o.ribbonInk) { m.userData.toon.uOutlineW.value = 0; }
    mesh.frustumCulled = false; mesh.name = 'kun-ribbon-' + spec.id + (spec.kind === 'pec' ? (side > 0 ? 'R' : 'L') : '');
    const r = { spec, side, mesh, nS, nW, center: new THREE.Vector3(), pts: [], frames: [] };
    // 透明排序：网格原点放在飘带中段（几何坐标减掉它）
    if (spec.kind === 'tail') r.center.set(X_TAIL + 22 - spec.L * 0.45, spec.dy * 4, spec.dz * 4);
    else r.center.set(spec.x - spec.L * 0.5, -120, side * 70);
    mesh.position.copy(r.center);
    add(group, mesh);
    ribbons.push(r);
    return r;
  }
  for (const spec of RIBBONS) {
    if (spec.kind === 'tail') makeRibbon(spec, 0);
    else for (const side of [-1, 1]) makeRibbon(spec, side);
  }
  // 胸鳍根部（未弯曲坐标；头部基本不弯，直接用）
  for (const r of ribbons) if (r.spec.kind === 'pec') {
    const s = r.spec, phi = r.side > 0 ? s.rph : Math.PI - s.rph;
    r.rootRest = bodyPoint(s.x, phi).addScaledVector(bodyNormal(s.x, phi), -s.sink);
  }

  const _d = new THREE.Vector3(), _B = new THREE.Vector3(), _Nn = new THREE.Vector3(), _cp = new THREE.Vector3(), _tmp = new THREE.Vector3(), _root = new THREE.Vector3();
  function ribbonWidth(spec, u) {
    let w = lerp(spec.wr, spec.wm, sstep(0.0, 0.22, u));
    w *= 0.86 + 0.14 * Math.sin(TAU * 1.3 * u + spec.tph);                     // 沿长宽窄起伏
    w *= Math.sqrt(Math.max(0, 1 - Math.pow(sstep(0.74, 1.0, u), 1.4)));       // 末端收尖
    return Math.max(w, 0.3);
  }
  function updateRibbon(r, ts, tr) {
    const s = r.spec, side = r.side || 1, L = s.L, nS = r.nS, nW = r.nW, ds = L / (nS - 1);
    // 根部位置与身体切向（身体时间 ts：根永远贴在身上）
    let tyRoot = 0, tzRoot = 0;
    if (s.kind === 'tail') {
      const xr = X_TAIL + 22;
      bendPoint(_tmp.set(xr, (fT(xr) + fB(xr)) / 2 + s.dy, s.dz), ts, _root);
    } else {
      bendPoint(r.rootRest, ts, _root);
    }
    const p = _cp.copy(_root);
    const pos = r.mesh.geometry.attributes.position.array;
    let yawPrev = 0;
    for (let i = 0; i < nS; i++) {
      const sl = i * ds, u = sl / L;
      const env = sstep(0.0, 0.3, u) * (0.4 + 0.6 * u);
      // 跟随身体：尾鳍飘带用尾柄切角的“延迟”值（波沿飘带往后传），胸鳍弱一些
      let fp = 0, fy = 0;
      const xr = s.kind === 'tail' ? X_TAIL + 22 : -60;
      const tb = lerp(ts, tr - sl / RIB_C, sstep(0, 0.15, u));
      const bb = jsBend(xr, tb);
      if (s.kind === 'tail') { fp = -bb[1]; fy = -bb[3]; } else { fp = -bb[1] * 0.35; fy = -bb[3] * 0.35; }
      const pitch = lerp(s.p0, s.p1, sstep(0, 0.85, u)) + fp + s.ap * env * Math.sin(TAU * s.k * u - s.om * tr + s.fph) + (s.cu || 0) * sstep(0.7, 1.0, u);
      let yaw = lerp(s.y0, s.y1, u) * (s.kind === 'pec' ? side : 1) + fy + s.ay * env * Math.sin(TAU * s.k * 0.8 * u - s.om * 0.9 * tr + s.fph + 1.3) * (s.kind === 'pec' ? side : 1);
      _d.set(-Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw));
      // 宽向：“上”投影到垂直于中线的平面，再绕中线扭
      _B.copy(UP).addScaledVector(_d, -UP.dot(_d)).normalize();
      const tw = (s.tw0 || 0) * side * sstep(0.0, 0.25, u) + s.ta * sstep(0.08, 0.4, u) * Math.sin(TAU * s.tk * u - s.tom * tr + s.tph);
      _Nn.crossVectors(_d, _B);
      _tmp.copy(_B).multiplyScalar(Math.cos(tw)).addScaledVector(_Nn, Math.sin(tw));
      const B = _tmp;
      const hw = ribbonWidth(s, u) * 0.5;
      const N2 = _Nn.crossVectors(_d, B);
      const cup = 0.12 * Math.sin(TAU * 0.7 * u - 1.3 * tr + (s.tph || 0));
      for (let j = 0; j < nW; j++) {
        const w = j / (nW - 1) * 2 - 1, k = (i * nW + j) * 3;
        pos[k] = p.x + B.x * w * hw + N2.x * cup * hw * (w * w - 0.33) - r.center.x;
        pos[k + 1] = p.y + B.y * w * hw + N2.y * cup * hw * (w * w - 0.33) - r.center.y;
        pos[k + 2] = p.z + B.z * w * hw + N2.z * cup * hw * (w * w - 0.33) - r.center.z;
      }
      p.addScaledVector(_d, ds);
      yawPrev = yaw;
    }
    const g = r.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.computeVertexNormals();
  }

  // —— 鲤须：两对圆管（吻前长须、嘴角短须），CPU 每拍重算；描金 ——
  const barbMat = mat('gold', { color: '#efcb7c', noId: true, fragmentAlbedo: 'toonMetal = 0.85;',
    fragmentNormal: 'toonInk = max( toonInk, ( 1.0 - smoothstep( 0.2, 0.36, abs( dot( normal, normalize( - vViewPosition ) ) ) ) ) * 0.9 );' });
  const BARB = [
    { id: 'long', x: 286, ph: -0.2, L: 172, r0: 3.4, r1: 0.7, p0: -1.0, p1: -0.55, h0: 1.2, h1: 2.75, ap: 0.4, k: 1.1, om: 2.3, ph1: 0.3 },
    { id: 'short', x: 262, ph: -0.52, L: 76, r0: 2.6, r1: 0.6, p0: -0.95, p1: -0.7, h0: 1.4, h1: 2.5, ap: 0.3, k: 0.9, om: 2.0, ph1: 1.5 },
  ];
  const barbels = [];
  const nRad = 7;
  for (const spec of BARB) for (const side of [-1, 1]) {
    const nS = Math.max(16, Math.round(spec.L / 3 * lerp(0.6, 1, lod)));
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array((nS * nRad + 1) * 3), idx = [];
    for (let i = 0; i < nS - 1; i++) for (let j = 0; j < nRad; j++) { const a = i * nRad + j, b = i * nRad + (j + 1) % nRad, c = a + nRad, d = b + nRad; idx.push(a, b, c, b, d, c); }
    const tipI = nS * nRad;
    for (let j = 0; j < nRad; j++) idx.push((nS - 1) * nRad + j, (nS - 1) * nRad + (j + 1) % nRad, tipI);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx);
    const mesh = new THREE.Mesh(g, barbMat); bindXuan(mesh, barbMat, { castShadow: false, outline: false });
    mesh.frustumCulled = false; mesh.name = 'kun-barbel-' + spec.id + (side > 0 ? 'R' : 'L');
    const phi = side > 0 ? spec.ph : Math.PI - spec.ph;
    const root = bodyPoint(spec.x, phi).addScaledVector(bodyNormal(spec.x, phi), -spec.r0 * 0.8);
    add(group, mesh);
    barbels.push({ spec, side, mesh, nS, root, pts: [] });
  }
  const _t2 = new THREE.Vector3(), _a = new THREE.Vector3(), _b2 = new THREE.Vector3();
  function updateBarbel(bb, tr) {
    const s = bb.spec, nS = bb.nS, ds = s.L / (nS - 1), side = bb.side;
    const pos = bb.mesh.geometry.attributes.position.array;
    const p = _cp.copy(bb.root);
    bb.pts.length = 0;
    let prevA = null;
    for (let i = 0; i < nS; i++) {
      const u = i / (nS - 1);
      // 须：先往外、往下，再往后；摆动一拍二
      // 方向：pitch 往下为负；航向 h 从“前偏外”（h≈0.75）扫到“后偏外”（h≈2.35），side 决定 ±Z
      const pitch = lerp(s.p0, s.p1, sstep(0, 0.75, u)) + s.ap * sstep(0.05, 0.5, u) * Math.sin(TAU * s.k * u - s.om * tr + s.ph1 + (side > 0 ? 0.6 : 0));
      const h = lerp(s.h0, s.h1, sstep(0, 0.9, u)) + 0.18 * sstep(0.1, 0.6, u) * Math.sin(TAU * 0.7 * u - 1.7 * tr + s.ph1);
      const cp = Math.cos(pitch);
      _d.set(cp * Math.cos(h), Math.sin(pitch), side * cp * Math.sin(h)).normalize();
      // 截面：两根与 _d 正交的单位向量
      _a.set(0, 0, 1).addScaledVector(_d, -_d.z); if (_a.lengthSq() < 1e-6) _a.set(1, 0, 0); _a.normalize();
      _b2.crossVectors(_d, _a);
      const rr = lerp(s.r0, s.r1, Math.pow(u, 0.8));
      for (let j = 0; j < nRad; j++) {
        const an = j / nRad * TAU, ca = Math.cos(an) * rr, sa = Math.sin(an) * rr, k = (i * nRad + j) * 3;
        pos[k] = p.x + _a.x * ca + _b2.x * sa; pos[k + 1] = p.y + _a.y * ca + _b2.y * sa; pos[k + 2] = p.z + _a.z * ca + _b2.z * sa;
      }
      bb.pts.push(p.x, p.y, p.z, rr);
      if (i < nS - 1) p.addScaledVector(_d, ds);
    }
    const k = nS * nRad * 3; pos[k] = p.x + _d.x * 0.6; pos[k + 1] = p.y + _d.y * 0.6; pos[k + 2] = p.z + _d.z * 0.6;
    bb.mesh.geometry.attributes.position.needsUpdate = true;
    bb.mesh.geometry.computeVertexNormals();
  }

  // —— 背鳍：沿背脊的一片月白绸膜，金色鳍条，后缘拖成短飘带；CPU 每拍重算（根随身体弯）——
  const DF = { x0: 92, x1: -52, nI: Math.round(lerp(28, 48, lod)), nJ: 9 };
  const dfGeo = new THREE.BufferGeometry();
  const dfPos = new Float32Array(DF.nI * DF.nJ * 3), dfAttr = new Float32Array(DF.nI * DF.nJ * 3), dfIdx = [];
  for (let i = 0; i < DF.nI; i++) for (let j = 0; j < DF.nJ; j++) { const k = i * DF.nJ + j; dfAttr[k * 3] = i / (DF.nI - 1); dfAttr[k * 3 + 1] = j / (DF.nJ - 1); dfAttr[k * 3 + 2] = 0; }
  for (let i = 0; i < DF.nI - 1; i++) for (let j = 0; j < DF.nJ - 1; j++) { const a = i * DF.nJ + j, b = a + DF.nJ; dfIdx.push(a, b, a + 1, b, b + 1, a + 1); }
  dfGeo.setAttribute('position', new THREE.BufferAttribute(dfPos, 3)); dfGeo.setAttribute('aFin', new THREE.BufferAttribute(dfAttr, 3)); dfGeo.setIndex(dfIdx);
  const dfMat = mat('silk', {
    color: XUAN.silk, side: THREE.DoubleSide, translucent: true, outlineW: 0.55, instanceId: false,
    uniforms: { uSilk: { value: new THREE.Color(XUAN.silk) }, uHem: { value: new THREE.Color(XUAN.silkHem) }, uNR: { value: 13 } },
    vertexPars: 'attribute vec3 aFin;\nvarying vec3 vFin;\n', vertexBegin: 'vFin = aFin;',
    fragmentPars: 'varying vec3 vFin;\nuniform vec3 uSilk, uHem;\nuniform float uNR;\n',
    fragmentAlbedo: /* glsl */`
    {
      float i = vFin.x, j = vFin.y;
      float rq = i * uNR;
      float dr = abs( fract( rq + 0.5 ) - 0.5 );
      float fr = max( fwidth( rq ), 1e-4 );
      float ray = ( 1.0 - smoothstep( 0.07 - fr, 0.07 + fr, dr ) ) * smoothstep( 0.0, 0.08, j ) * ( 1.0 - smoothstep( 0.75, 0.97, j ) );
      float fj = max( fwidth( j ), 1e-4 );
      float hem = smoothstep( 0.93 - fj * 1.5, 0.93 + fj * 1.5, j ) + ( 1.0 - smoothstep( 0.03 - fr * 0.2, 0.03 + fr * 0.2, i ) );
      hem = clamp( hem, 0.0, 1.0 );
      vec3 c = mix( uSilk, uHem, max( ray * 0.85, hem ) );
      diffuseColor.rgb = c;
      toonMetal = max( ray * 0.7, hem );
      toonTrans = 1.0 - max( ray, hem ) * 0.6;
      diffuseColor.a = mix( 0.85, 0.6, j ) ;
      diffuseColor.a = mix( diffuseColor.a, 1.0, max( ray, hem ) * 0.8 );
    }`,
  });
  const dorsal = new THREE.Mesh(dfGeo, dfMat);
  bindXuan(dorsal, dfMat, { castShadow: false, outline: o.ribbonInk });
  dorsal.frustumCulled = false; dorsal.name = 'kun-dorsal';
  dorsal.position.set(20, 90, 0);
  add(group, dorsal);
  const dfCols = [];
  for (let i = 0; i < DF.nI; i++) {
    const u = i / (DF.nI - 1), x = lerp(DF.x0, DF.x1, u);
    const base = bodyPoint(x, Math.PI / 2).add(new THREE.Vector3(0, -1.5, 0));
    // 鳍高：前缘高、往后先降再在末端拖出一条飘带
    const h = lerp(54, 20, sstep(0.0, 0.75, u)) + 70 * sstep(0.82, 1.0, u);
    const sweep = lerp(0.35, 1.05, sstep(0, 0.8, u)) + 0.3 * sstep(0.8, 1.0, u);   // 往后倒的角度
    dfCols.push({ x, u, base, h, sweep });
  }
  function updateDorsal(ts, tr) {
    const nJ = DF.nJ;
    for (let i = 0; i < DF.nI; i++) {
      const c = dfCols[i];
      bendPoint(c.base, ts, _root);
      const [, ty, , tz] = jsBend(c.x, ts);
      for (let j = 0; j < nJ; j++) {
        const v = j / (nJ - 1);
        // 鳍条：从根往上、往后倒；越往上越弯；侧向飘动一拍二
        const ang = c.sweep * (0.6 + 0.4 * v) + 0.12 * Math.sin(TAU * 0.9 * c.u - 2.2 * tr + v * 1.5) * v;
        const len = c.h * v;
        const dx = -Math.sin(ang) * len, dy = Math.cos(ang) * len * (1 - 0.15 * v * v);
        const flz = (5 + 9 * c.u) * Math.pow(v, 1.6) * Math.sin(TAU * 1.1 * c.u - 2.4 * tr + 0.8) + 3.2 * v * v * Math.sin(TAU * 3.2 * c.u - 3.1 * tr);
        // 在根处的身体切向坐标系里摆（随身体竖直、侧向弯曲转动）
        const cy = Math.cos(ty), sy = Math.sin(ty), cz = Math.cos(tz), sz = Math.sin(tz);
        const lx = dx * cy - dy * sy, ly = dx * sy + dy * cy;
        const X = _root.x + lx * cz - flz * sz, Y = _root.y + ly, Z = _root.z + lx * sz + flz * cz;
        const k = (i * nJ + j) * 3;
        dfPos[k] = X - dorsal.position.x; dfPos[k + 1] = Y - dorsal.position.y; dfPos[k + 2] = Z - dorsal.position.z;
      }
    }
    dfGeo.attributes.position.needsUpdate = true;
    dfGeo.computeVertexNormals();
  }

  // —— 姿态 ——
  const qTwo = t => Math.floor(Math.round(t * 24) / 2) * 2 / 24;   // 一拍二
  function setPose(ts, po = {}) {
    U.uKunT.value = ts;
    const tr = po.t !== undefined ? qTwo(po.t) : ts;
    for (const r of ribbons) updateRibbon(r, ts, tr);
    for (const b of barbels) updateBarbel(b, tr);
    updateDorsal(ts, tr);
    poseEyes(eyes, po.blink ?? autoBlink(ts, o.blinkPeriod, o.blinkOffset), po.look, group, { lidU: [-0.5, 0.03], lidL: [0.3, -0.03], catches: CATCH });
  }
  const eyeWorld = (target, ref) => pickEye(eyes, target, ref);
  function fitShadow(light, { size = 4096, radius = 420 } = {}) {
    group.updateMatrixWorld(true);
    const c = new THREE.Vector3(-60, -20, 0).applyMatrix4(group.matrixWorld);
    const sc = group.matrixWorld.getMaxScaleOnAxis(), Rr = radius * sc;
    const dir = light.position.clone().sub(light.target.position);
    if (dir.lengthSq() < 1e-9) dir.set(0.75, 0.1, 0.65); dir.normalize();
    light.target.position.copy(c); light.target.updateMatrixWorld();
    light.position.copy(c).addScaledVector(dir, Rr * 3);
    const cam = light.shadow.camera;
    Object.assign(cam, { left: -Rr, right: Rr, top: Rr, bottom: -Rr, near: Rr * 0.5, far: Rr * 5.5 });
    cam.updateProjectionMatrix();
    if (light.shadow.mapSize.x !== size) { light.shadow.mapSize.set(size, size); light.shadow.map?.dispose(); light.shadow.map = null; }
    light.shadow.normalBias = 1.5 * sc; light.shadow.bias = -0.0005; light.shadow.radius = 2;
    light.castShadow = true;
  }

  // —— 穿插自检：飘带 / 须 / 背鳍两两最小距离，以及有没有扎进身体（自测页 &check=1 调用）——
  function checkClearance(times) {
    const res = { minPair: Infinity, pair: '', bodyHits: 0, worst: '' };
    const cell = 6, key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (const t of times) {
      const ts = Math.floor(Math.round(t * 24) / 3) * 3 / 24;
      setPose(ts, { t });
      const sets = [];
      // 飘带：沿长、沿宽加密采样（宽向插到 9 点）
      for (const r of ribbons) {
        const P = r.mesh.geometry.attributes.position.array, c = r.center, pts = [];
        for (let i = 0; i < r.nS; i++) {
          const u = i / (r.nS - 1);
          for (let j = 0; j < r.nW - 1; j++) for (let h = 0; h < 2; h++) {
            const a = (i * r.nW + j) * 3, b = a + 3, f = h / 2;
            pts.push([P[a] + (P[b] - P[a]) * f + c.x, P[a + 1] + (P[b + 1] - P[a + 1]) * f + c.y, P[a + 2] + (P[b + 2] - P[a + 2]) * f + c.z, u]);
          }
        }
        sets.push({ name: r.mesh.name, pts, rad: 0 });
      }
      for (const b of barbels) { const pts = []; for (let i = 0; i < b.pts.length; i += 4) pts.push([b.pts[i], b.pts[i + 1], b.pts[i + 2], i / b.pts.length]); sets.push({ name: b.mesh.name, pts, rad: b.spec.r0 }); }
      { const pts = []; for (let k = 0; k < dfPos.length; k += 3) pts.push([dfPos[k] + dorsal.position.x, dfPos[k + 1] + dorsal.position.y, dfPos[k + 2] + dorsal.position.z, (k / 3 % DF.nJ) / (DF.nJ - 1)]); sets.push({ name: 'kun-dorsal', pts, rad: 0 }); }
      const grid = new Map();
      sets.forEach((s, si) => s.pts.forEach(p => { const k = key(p[0], p[1], p[2]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push([si, p]); }));
      sets.forEach((s, si) => s.pts.forEach(p => {
        const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c2 = -1; c2 <= 1; c2++) {
          const L2 = grid.get(`${cx + a},${cy + b},${cz + c2}`); if (!L2) continue;
          for (const [sj, q] of L2) {
            if (sj <= si) continue;
            const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) - s.rad - sets[sj].rad;
            if (d < res.minPair) { res.minPair = d; res.pair = `${s.name} × ${sets[sj].name} @t=${t}`; }
          }
        }
        // 扎进身体：根部 12% 以外的点（反弯曲近似：减去该 x 处的脊柱位移）
        if (p[3] > (s.name.includes('ribbon-t') ? 0.2 : 0.12)) {
          const [by, , bz] = jsBend(p[0], ts);
          if (insideBody(p[0], p[1] - by, p[2] - bz, -1.0)) { res.bodyHits++; res.worst = `${s.name} @t=${t}`; }
        }
      }));
    }
    return res;
  }

  setPose(0);
  return { group, setPose, eyeWorld, fitShadow, outlineMeshes, length: 600, eyeRadius: RE, uniforms: U, ribbons, barbels, eyes, checkClearance, bendPoint };
}
