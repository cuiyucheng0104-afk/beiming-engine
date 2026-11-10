// 鲲鹏将化（片尾化鹏前一刻的形态）——三渲二配方第 1、2、4 层。
// 设定图「鲲_v2-3_鲲鹏将化」（美术设定稿，不在本仓库里）。鱼身修长；胸鳍正在由鳞化羽，长成层层叠叠的鹤羽翅膀（鳍根是鳞，鳍尖是羽）；
// 尾鳍裂成长长的凤尾翎（带眼斑、梢部回卷）；背上、腹下的鳍是朱砂火焰舌；口有长须，眼是丹凤眼，腮上一朵祥云纹；
// 敦煌矿物色（石青、石绿、朱砂、赭石、土黄、月白），壁画式斑驳风化 + 细墨线。
//
// 坐标与 src/kun.js 一致：鲲局部空间，头朝 +X，上为 +Y，原点在身体中心；吻端 x≈+318，尾柄末端 x≈-196，凤尾翎拖到 x≈-420；
//   名义体长 length = 600（与旧版相同，正片里按它取景的镜头不用改）。
// 接口与 createKun 一致：{ group, setPose(ts, o), eyeWorld(target, ref), fitShadow(light, o), outlineMeshes, length, eyeRadius, wisps, uniforms, fins, eyes }，另有 wings、flapPose。
//   fins 为空：胸鳍已经化成翅膀，不是 kun.js 那种 { side, pivot } 刚体胸鳍（镜头 C 的「收远侧胸鳍」对它不做）；翅膀在 wings 里。
//   换进正片镜头 C：buildShotC({ makeKun: createKun })（或改 shotC.js 的 import）。
//   setPose(ts, { wingT, blink, look })
//     ts     身体时钟，调用方按一拍三量化（ts = heldTime(frameOf(t), 3)，engine/core/clock.js）
//     wingT  翅膀时钟，按一拍二量化（heldTime(frameOf(t), 2)）；不给就用 ts（翅膀也一拍三）
//     blink  0 睁 → 1 闭（不给就按周期自动眨）；look：世界坐标 Vector3，眼珠转向它（限幅）
// 形变全部在 CPU 上做（脊柱波动、翅膀骨骼、凤尾翎和长须的波动）：
//   · 阴影、toon 测试页的屏幕描边、look.js 的 ID 图描边都直接拿到形变后的几何，不需要任何顶点着色器钩子（不用 outlineVertex）
//   · 纹样（鳞、风化斑）用静止形体坐标 aRest 算，不随摆动滑动
// 确定性：随机只来自 mulberry(固定种子)；没有 Date.now / Math.random；同一 (ts, wingT) 任意顺序渲染结果一致。
import * as THREE from 'three';
import { mulberry, monotone, clamp, lerp, ss, seg, TAU, DEG } from '../engine/core/math.js';
import { profileBody, sideAngle, axisStations, ringsAt, loftRings, loftWing } from '../engine/form/loft.js';
import { card } from '../engine/form/props.js';
import { autoBlink, pickEye } from '../engine/form/eye.js';
import { makePengMaterial, bindPeng, PENG } from './toon_peng.js';
import { fitShadowTo } from './shadow.js';

const sstep = (a, b, x) => ss(seg(x, a, b));
const UP = new THREE.Vector3(0, 1, 0), AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const col3 = h => new THREE.Color(h);

// ───────────────────────── 身体轮廓（x：-196 尾柄末端 … +318 吻端） ─────────────────────────
const PX = [-196, -185, -165, -130, -85, -30, 25, 75, 120, 160, 192, 222, 248, 270, 288, 302, 312, 318];
const PT = [12.5, 11, 14, 24, 35, 46, 55, 60, 61, 60, 57, 52, 45, 37, 28, 19, 11, 3];               // 顶线 y
const PB = [-12.5, -11, -14, -23, -34, -46, -57, -64, -67, -66, -63, -58, -51, -43, -35, -27, -17, -7]; // 底线 y
const PW = [6, 7.5, 10.5, 16, 23, 31, 38, 44, 47, 48, 47, 45, 42, 38, 32, 24, 15, 5];           // 半宽 z
const X_TAIL = -196, X_SNOUT = 318, L_BODY = X_SNOUT - X_TAIL;

// 嘴线（侧面水平线算起的角度，向上为正）：从吻端斜向后下，口角下撇
const mouthPh = x => lerp(-0.1, -0.5, sstep(316, 266, x)) - 0.16 * sstep(270, 254, x);

// 放样体（静止形体）：超椭圆截面 + 嘴（上唇微鼓、下颌略收，嘴线处形成台阶，描边能抓到）。phi：0 = +Z 侧水平，π/2 = 背中线
const body = profileBody({
  xs: PX, top: PT, bottom: PB, width: PW, exp: [2.1, 2.4],
  deform(p) {
    const x = p.x;
    if (x > 248) {
      const ph = sideAngle(p.c, p.s), pm = mouthPh(x);
      const zone = sstep(250, 262, x) * sstep(319, 314, x);
      const lip = sstep(pm - 0.012, pm + 0.03, ph) * (1 - sstep(pm + 0.07, pm + 0.17, ph));
      const jaw = (1 - sstep(pm - 0.02, pm + 0.02, ph)) * sstep(pm - 0.5, pm - 0.12, ph);
      const k = 1 + zone * (0.032 * lip - 0.026 * jaw);
      p.z *= k; p.y = p.yc + (p.y - p.yc) * k;
    }
  },
});
const { top: fT, bottom: fB, width: fW, mid: yMid, point: bodyPoint, normal: bodyNormal } = body;
// 鳞的纵向坐标 ξ(x)：∫ dx / 鳞长，鳞长随体围变小（尾柄的鳞小）
const scaleLen = x => 3.8 + 0.088 * (fW(x) + (fT(x) - fB(x)) / 2);
const XI = (() => {
  const xs = [], vs = []; let acc = 0;
  for (let x = X_SNOUT; x >= X_TAIL - 2; x -= 1) { xs.push(x); vs.push(acc); acc += 1 / scaleLen(x - 0.5); }
  xs.reverse(); vs.reverse();
  return monotone(xs.map((x, i) => [x, vs[i]]));
})();

function buildBody(NU, NV) {
  const xs = axisStations(X_TAIL, X_SNOUT - 0.35, NU, 0.55), rings = ringsAt(bodyPoint, xs, NV);
  // 每圈的弧长坐标 v（从同侧水平线量起，向上为正，左右对称）
  const body = [], eta = [];
  const q = NV / 4;
  for (let j = 0; j < NU; j++) {
    const r = rings[j], x = xs[j], v = new Float32Array(NV);
    for (let k = 1; k <= q; k++) v[k] = v[k - 1] + r[k].distanceTo(r[k - 1]);
    v[NV - 1] = -r[NV - 1].distanceTo(r[0]);
    for (let k = NV - 2; k >= 3 * q; k--) v[k] = v[k + 1] - r[k].distanceTo(r[k + 1]);
    for (let k = q + 1; k < 3 * q; k++) v[k] = v[(NV / 2 - k + NV) % NV];
    const xi = XI(x), rh = 0.88 * scaleLen(x);
    for (let k = 0; k < NV; k++) {
      const phi = k / NV * TAU, ph = sideAngle(Math.cos(phi), Math.sin(phi));
      body.push(x, ph, v[k], xi); eta.push(v[k] / rh);
    }
  }
  const yc = yMid;
  const g = loftRings(rings, {
    startCap: { p: new THREE.Vector3(X_TAIL - 0.6, yc(X_TAIL), 0), attr: { aBody: [X_TAIL, 0, 0, XI(X_TAIL)], aEta: [0] } },
    endCap: { p: new THREE.Vector3(X_SNOUT + 0.3, yc(X_SNOUT) - 1, 0), attr: { aBody: [X_SNOUT, 0, 0, 0], aEta: [0] } },
    attrs: { aBody: { data: body, size: 4 }, aEta: { data: eta, size: 1 } },
  });
  g.setAttribute('aRest', new THREE.BufferAttribute(g.attributes.position.array.slice(), 3));
  g.userData = { xs, NU, NV };
  return g;
}

// 翼型放样（翅膀的肉鳍基部）。展向沿 ±Z，弦向沿 X（前缘在 +X），厚度沿 Y；带 aW =（展向 t, 弦向 cp, 部位）
// 展向 s 从 s0 到 span（side 侧），plan(s) 给平面形
const buildLobe = ({ nS, nC, span, side, plan, part, s0 = 0 }) => loftWing({
  nS, nC, span0: side * s0, span1: side * span, plan: (t, z) => plan(side * z),
  attrs: { aW: { size: 3, at: (t, cp, z) => [Math.max(0, side * z / span), cp, part], start: [0, 0.5, part], end: [1, 0.5, part] } },
});
const lobeTop = (P, cp) => P.th * 0.5 * 2.6 * Math.sqrt(cp) * (1 - cp) + P.camber * Math.sin(Math.PI * cp);
const lobeBot = (P, cp) => -P.th * 0.5 * 2.6 * Math.sqrt(cp) * (1 - cp) + P.camber * Math.sin(Math.PI * cp);

// ───────────────────────── 卡片几何：羽片 / 火焰舌（engine/form/props.js 的 card：沿长 +X 0..1，横向 ±Z，法线 +Y） ─────────────────────────

// ───────────────────────── 脊柱波动（CPU；身体、翅根、鳍、尾翎、须、眼都用同一个截面变换） ─────────────────────────
// BEND 是“当前这只鲲”的参数：setPose 开头按实例的 uniforms 写进来（单线程同步调用，多只鲲互不干扰）
const BEND = { amp: 12, wave: 0.8, period: 5, lat: 5, heave: 3.2, heaveP: 10 / 3, heavePh: 0.1 };
function bendY(x, T) {
  const s = (X_SNOUT - x) / L_BODY, e = sstep(0.12, 1.0, Math.min(s, 1.5));
  const a = TAU * (s * BEND.wave - T / BEND.period);
  // 身体随扇翅起伏：下扑时（相位 0.1–0.45）往上一送
  const hv = BEND.heave * Math.sin(TAU * (T / BEND.heaveP + BEND.heavePh) - 0.6);
  return [BEND.amp * e * e * Math.sin(a) + hv, BEND.lat * e * e * Math.sin(a + 1.2)];
}
const _sq1 = new THREE.Quaternion(), _sq2 = new THREE.Quaternion(), _sT = new THREE.Matrix4(), _sv = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1);
// 截面 x 的刚体变换：M = T(x, dy, dz) · Rz(俯仰) · Ry(偏航) · T(-x, 0, 0)
function sectionMatrix(x, T, out, qOut) {
  const a = bendY(x + 1, T), b = bendY(x - 1, T), c = bendY(x, T);
  const th = Math.atan((a[0] - b[0]) / 2), ps = -Math.atan((a[1] - b[1]) / 2);
  _sq1.setFromAxisAngle(AZ, th); _sq2.setFromAxisAngle(AY, ps); _sq1.multiply(_sq2);
  if (qOut) qOut.copy(_sq1);
  out.compose(_sv.set(x, c[0], c[1]), _sq1, ONE);
  return out.multiply(_sT.makeTranslation(-x, 0, 0));
}

// ───────────────────────── 翅膀骨骼：臂（肩→腕）+ 掌（腕→尖） ─────────────────────────
const LA = 122, LH = 66;                // 臂长、掌长（展向）
function armPlan(s) { const t = clamp(s / LA, 0, 1.2); return { le: 22 - 0.1 * s - 8 * t * t, c: lerp(92, 60, Math.pow(t, 0.9)), th: lerp(15, 6, t), camber: 2.6 * (1 - t) }; }
function handPlan(s) { const t = s / LH; return { le: 12 - 0.3 * s - 6 * t * t, c: lerp(58, 26, t), th: lerp(6, 2.5, t), camber: 1.2 }; }
// 扇动关键姿态（相位 0 = 上举到顶；0→0.45 下扑；0.45→1 收翅上抬）。角度：度
//   th 臂的上反角（上举为正）；fx 掌相对臂的上反角（下扑时掌滞后上翘为正）；fd 掌后折；sw 整翼后掠；tw 扭转（前缘抬起为正）
const FLAP_KEYS = [
  [0.0, { th: 50, fx: -10, fd: 30, sw: 16, tw: 6 }],
  [0.14, { th: 40, fx: 12, fd: 10, sw: 9, tw: -5 }],
  [0.3, { th: 10, fx: 18, fd: 3, sw: 5, tw: -10 }],
  [0.47, { th: -26, fx: 6, fd: 6, sw: 8, tw: -4 }],
  [0.62, { th: -16, fx: -14, fd: 22, sw: 18, tw: 8 }],
  [0.8, { th: 18, fx: -24, fd: 34, sw: 24, tw: 10 }],
  [1.0, { th: 50, fx: -10, fd: 30, sw: 16, tw: 6 }],
];
// 周期插值：Catmull-Rom（首尾相接）
function flapPose(ph) {
  ph = ((ph % 1) + 1) % 1;
  const K = FLAP_KEYS, n = K.length - 1;
  let i = 0; while (i < n - 1 && ph >= K[i + 1][0]) i++;
  const t0 = K[i][0], t1 = K[i + 1][0], u = (ph - t0) / (t1 - t0);
  const g = k => K[((k % n) + n) % n][1];
  const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2);
  const out = {};
  for (const k in p1) {
    const a = p0[k], b = p1[k], c = p2[k], d = p3[k];
    out[k] = 0.5 * ((2 * b) + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
  }
  return out;
}

// ───────────────────────── 凤尾翎定义 ─────────────────────────
// a 扇角（度，从正后方往上为正）b 侧偏（度）L 长 W 宽 cu 梢卷（弧度，正 = 往上卷）cw 配色 oc 眼斑 tw 扭转
const PLUMES = [
  { a: 42, b: -10, L: 150, W: 15, cu: 2.7, cw: 2, oc: 1, tw: 0.3 },
  { a: 27, b: 9, L: 196, W: 17, cu: 2.2, cw: 1, oc: 1, tw: -0.25 },
  { a: 14, b: -5, L: 232, W: 19, cu: 1.6, cw: 0, oc: 1, tw: 0.2 },
  { a: 2, b: 7, L: 252, W: 20, cu: -1.8, cw: 2, oc: 1, tw: -0.3 },
  { a: -11, b: -8, L: 240, W: 20, cu: -2.3, cw: 3, oc: 1, tw: 0.25 },
  { a: -24, b: 6, L: 220, W: 18, cu: -2.6, cw: 2, oc: 1, tw: -0.2 },
  { a: -38, b: -4, L: 190, W: 17, cu: -2.8, cw: 1, oc: 1, tw: 0.3 },
  { a: -52, b: 10, L: 150, W: 14, cu: -2.4, cw: 2, oc: 0, tw: -0.2 },
  { a: 54, b: 4, L: 104, W: 10, cu: 2.0, cw: 0, oc: 0, tw: 0.4 },
  { a: 20, b: 14, L: 150, W: 9, cu: 1.2, cw: 0, oc: 0, tw: 0.5 },
  { a: -4, b: -15, L: 176, W: 9, cu: -1.0, cw: 2, oc: 0, tw: -0.4 },
  { a: -30, b: 15, L: 150, W: 9, cu: -1.6, cw: 0, oc: 0, tw: 0.4 },
  { a: -64, b: -6, L: 104, W: 10, cu: -1.8, cw: 0, oc: 0, tw: -0.3 },
  { a: 33, b: -15, L: 172, W: 14, cu: 2.5, cw: 3, oc: 1, tw: 0.2 },
  { a: -17, b: 15, L: 206, W: 15, cu: -2.1, cw: 0, oc: 1, tw: -0.25 },
  { a: 8, b: 1, L: 214, W: 12, cu: 1.3, cw: 1, oc: 0, tw: 0.35 },
];
// 配色：[翎根, 翎身, 翎梢]
const PLUME_CW = [
  [PENG.qinglv, PENG.shilv, '#9FCFB4'],          // 0 石绿
  [PENG.qinglv, PENG.yuebai, PENG.tuhuang],      // 1 月白
  [PENG.qinglv, PENG.zhusha, PENG.zhushaL],      // 2 朱砂
  [PENG.qinglv, PENG.tuhuang, PENG.zhusha],      // 3 土黄
];

/**
 * createKun(opts) → { group, setPose(ts, o), eyeWorld(target, ref), fitShadow(light, o), outlineMeshes, length, eyeRadius, wisps, uniforms, fins（空）, wings, eyes, flapPose }
 * opts.lod   0.1–1：网格密度倍率（大远景 0.35–0.5）
 * opts.seed  散布种子（默认 20261103）
 * opts.flapPeriod  扇翅周期（秒，默认 10/3 ≈ 3.33，与身体随扇翅的上下起伏同周期；脊柱波动是 5 秒）；opts.flapPhase 相位偏移（0..1）
 * opts.blinkPeriod / blinkOffset：自动眨眼的周期 / 首次时刻（秒，默认 4 / 1.5）
 */
export function createKun(opts = {}) {
  const o = { lod: 1, seed: 20261103, flapPeriod: 10 / 3, flapPhase: 0.1, blinkPeriod: 4, blinkOffset: 1.5, ...opts };
  const lod = clamp(o.lod, 0.1, 1);
  const R = mulberry(o.seed);
  // 与旧版同名的运行时参数（形变在 CPU 上做，setPose 时读取）：脊柱波幅（米）/ 波数 / 角频率；uWingPeriod 扇翅周期（秒）
  const U = { uKunT: { value: 0 }, uWingT: { value: 0 }, uKunAmp: { value: 12 }, uKunWave: { value: 0.8 }, uKunOmega: { value: TAU / 5 }, uKunHalfL: { value: 300 },
    uWingPeriod: { value: o.flapPeriod } };
  const group = new THREE.Group(); group.name = 'kun-peng';
  const outlineMeshes = [];
  const add = (parent, mesh) => { parent.add(mesh); if (mesh.userData.outline) outlineMeshes.push(mesh); return mesh; };
  const C = k => col3(PENG[k]);

  // —— 眼睛参数 ——
  const EYE_X = 240, EYE_PH = 0.36, RE = 10;
  let eyeV = 0; { let prev = bodyPoint(EYE_X, 0, new THREE.Vector3()); const p = new THREE.Vector3(); for (let i = 1; i <= 60; i++) { bodyPoint(EYE_X, EYE_PH * i / 60, p); eyeV += p.distanceTo(prev); prev.copy(p); } }

  // ════════════════ 身体 ════════════════
  const NU = Math.round(lerp(110, 250, lod)), NV = Math.round(lerp(64, 136, lod) / 4) * 4;
  const bodyGeo = buildBody(NU, NV);
  const bodyMat = makePengMaterial({
    rest: true, muralAmt: 1, muralScale: 0.07, fleckThr: 0.38, fadeAmt: 0.32, stainAmt: 0.4, dotAmt: 0.55,
    skyStep: 0.1, skyAmt: 0.85, skyTint: [0.86, 0.96, 1.2], rimAmt: 0.75,
    uniforms: {
      uEye: { value: new THREE.Vector4(EYE_X, eyeV, RE, 0) },
      uQing: { value: C('shiqing') }, uQingL: { value: C('shiqingL') }, uQingD: { value: C('shiqingD') },
      uLv: { value: C('shilv') }, uLvL: { value: C('shilvL') }, uQingLv: { value: C('qinglv') },
      uBelly: { value: C('yuebai') }, uBellyW: { value: C('cream') }, uGold: { value: C('gold') },
      uZhu: { value: C('zhusha') }, uZhuL: { value: C('zhushaL') }, uTu: { value: C('tuhuang') }, uLip: { value: col3('#E8B49B') },
    },
    vertexPars: 'attribute vec4 aBody;\nattribute float aEta;\nvarying vec4 vB;\nvarying float vEta;\n',
    vertexBegin: 'vB = aBody; vEta = aEta;',
    fragmentPars: /* glsl */`
      varying vec4 vB; varying float vEta;
      uniform vec4 uEye;
      uniform vec3 uQing, uQingL, uQingD, uLv, uLvL, uQingLv, uBelly, uBellyW, uGold, uZhu, uZhuL, uTu, uLip;
      float pengMouth( float x ) { return mix( -0.1, -0.5, smoothstep( 316.0, 266.0, x ) ) - 0.16 * smoothstep( 270.0, 254.0, x ); }
      // 折线（最多 8 点）距离 + 沿程参数
      vec2 pengPoly( vec2 p, vec2 a[8], int n ) {
        float best = 1e9, tb = 0.0, acc = 0.0, tot = 0.0;
        for ( int i = 0; i < 7; i ++ ) { if ( i >= n - 1 ) break; tot += length( a[ i + 1 ] - a[ i ] ); }
        for ( int i = 0; i < 7; i ++ ) {
          if ( i >= n - 1 ) break;
          vec2 e = a[ i + 1 ] - a[ i ]; float l = length( e );
          float h = clamp( dot( p - a[ i ], e ) / ( l * l ), 0.0, 1.0 );
          float d = length( p - a[ i ] - e * h );
          if ( d < best ) { best = d; tb = ( acc + h * l ) / tot; }
          acc += l;
        }
        return vec2( best, tb );
      }
      // 祥云卷：圆盘 + 盘内螺旋线。返回 (到圆盘的有向距离, 螺旋线距离)
      vec2 pengCurl( vec2 p, vec2 c, float r, float turns, float dir ) {
        vec2 d = p - c; float rho = length( d );
        float a = atan( d.y, d.x * dir ) / 6.2831853;
        float k = rho / r * turns - a;
        float ds = abs( fract( k + 0.5 ) - 0.5 ) * r / turns;
        ds = rho > r * 0.9 || rho < r * 0.12 ? 1e3 : ds;
        return vec2( rho - r, ds );
      }`,
    fragmentAlbedo: /* glsl */`
    {
      float x = vB.x, ph = vB.y, v = vB.z, xi = vB.w;
      // 手绘抖动：画线坐标按墨线时钟（一拍二）轻微扰动，线会“呼吸”
      vec3 jq = vec3( x * 0.05, v * 0.05, uInkTime * 0.731 );
      float jx = toonNoise( jq ) * 0.5, jv = toonNoise( jq + 19.1 ) * 0.5;
      float n1 = toonNoise( vec3( x * 0.018, v * 0.03, 4.0 ) ), n2 = toonNoise( vec3( x * 0.05, v * 0.07, 9.0 ) );
      // —— 底色：头部石青 → 身体石绿 → 尾柄青绿；背上偏青、腹侧偏黄绿 ——
      float tHead = smoothstep( 160.0, 214.0, x + n1 * 22.0 );
      float tTail = smoothstep( -40.0, -170.0, x + n1 * 24.0 );
      float up = smoothstep( -0.3, 1.0, ph + n2 * 0.18 );
      vec3 bodyC = mix( uLv, uQingLv, tTail );
      bodyC = mix( bodyC, uLvL, smoothstep( 0.15, -0.45, ph + n2 * 0.1 ) * 0.55 );
      bodyC = mix( bodyC, uQing, up * 0.62 * ( 1.0 - 0.4 * tTail ) );
      vec3 headC = mix( uQingL, uQing, up );
      headC = mix( headC, uQingD, smoothstep( 0.85, 1.45, ph ) * 0.75 );
      vec3 c = mix( bodyC, headC, tHead );
      float pmB = -0.52 - 0.52 * smoothstep( 60.0, -195.0, x ) - 0.1 * smoothstep( 180.0, 252.0, x );
      c = mix( c, mix( c, uTu, 0.55 ), ( 1.0 - smoothstep( 0.06, 0.32, ph - pmB + n2 * 0.06 ) ) * ( 1.0 - tHead ) * 0.8 );
      // —— 腹：月白 + 纵褶；腹线处一道土黄描金 ——
      float pm = pengMouth( x );
      float bph = -0.52 - 0.52 * smoothstep( 60.0, -195.0, x ) - 0.1 * smoothstep( 180.0, 252.0, x );
      bph = mix( bph, pm, smoothstep( 250.0, 262.0, x ) ) + jv * 0.006 + n2 * 0.025;
      float fb = max( fwidth( ph ), 1e-5 );
      float belly = 1.0 - smoothstep( bph - fb, bph + fb, ph );
      vec3 bc = mix( uBelly, uBellyW, smoothstep( -0.9, -1.5, ph ) * 0.5 + 0.25 * n1 );
      float q = vEta * 2.3 + toonNoise( vec3( x * 0.03, vEta, 2.0 ) ) * 0.12;
      float pleat = toonLine( fract( q + 0.5 ) - 0.5, 0.06 ) * toonFar( vec2( q ), 0.25, 0.6 ) * smoothstep( -150.0, -90.0, x ) * toonSS( 314.0, 296.0, x );
      bc *= 1.0 - 0.06 * step( 0.5, fract( q * 0.5 ) );
      c = mix( c, bc, belly );
      float bandG = ( 1.0 - smoothstep( 0.0, 0.07, abs( ph - bph - 0.035 ) ) ) * step( x, 252.0 );
      c = mix( c, uTu, bandG * 0.6 );
      toonInk = max( toonInk, pleat * belly * 0.4 );
      toonInk = max( toonInk, toonLine( ph - bph, 0.006 ) * 0.55 * step( x, 254.0 ) );
      // —— 鳃盖后缘（中间向后凸）：墨线 + 一道朱砂 ——
      float gx = 170.0 + 10.0 * ph * ph - 4.0 * ph + jx * 0.6;
      float gill = toonLine( x - gx, 0.55 ) * smoothstep( 1.32, 1.12, ph ) * smoothstep( bph - 0.05, bph + 0.08, ph );
      float gillR = ( 1.0 - smoothstep( 0.8, 1.6, abs( x - gx + 2.4 ) ) ) * smoothstep( 1.3, 1.0, ph ) * smoothstep( bph, bph + 0.15, ph );
      c = mix( c, uZhu, gillR * 0.8 );
      toonInk = max( toonInk, gill * 0.85 );
      // —— 鳞：覆瓦状（前面的鳞压住后面的），看得见的是每片鳞朝尾的圆弧边 ——
      float zone = ( 1.0 - smoothstep( gx - 7.0, gx - 1.5, x ) ) * smoothstep( bph + 0.02, bph + 0.1, ph );
      vec2 sq = vec2( xi, vEta );
      float far = toonFar( sq, 0.14, 0.4 );
      if ( zone > 0.001 ) {
        float i0 = floor( sq.x );
        float off0 = 0.5 * mod( i0, 2.0 );
        float j0 = floor( sq.y - off0 + 0.5 ) + off0;
        vec2 l0 = vec2( sq.x - i0, ( sq.y - j0 ) * 1.0 );
        float R0 = 0.74;
        vec2 ij; vec2 lq;
        if ( length( l0 ) < R0 ) { ij = vec2( i0, j0 ); lq = l0; }
        else {
          float i1 = i0 + 1.0, off1 = 0.5 * mod( i1, 2.0 );
          float j1 = floor( sq.y - off1 + 0.5 ) + off1;
          ij = vec2( i1, j1 ); lq = vec2( sq.x - i1, sq.y - j1 );
        }
        float hs = toonHash13( vec3( ij, 5.3 ) ), hs2 = toonHash13( vec3( ij, 9.1 ) );
        lq += ( vec2( hs, hs2 ) - 0.5 ) * 0.07;
        float dr = length( lq ) / R0;
        // 每片鳞自己的矿物色偏移：石青 / 石绿 / 青绿
        vec3 sc = c * mix( 0.95, 1.05, hs );
        sc = mix( sc, mix( uQing, uLv, hs2 ), 0.1 * ( 1.0 - belly ) );
        sc *= mix( 0.86, 1.07, smoothstep( -0.6, 0.55, lq.x ) );          // 前半被压着暗，近自由边亮
        sc = mix( sc, mix( sc, uTu, 0.35 ), smoothstep( 0.62, 0.9, dr ) * step( 0.0, lq.x ) );   // 自由边一圈泛土黄
        float fe = max( fwidth( dr ), 1e-4 );
        float edge = ( 1.0 - smoothstep( 0.075 - fe, 0.075 + fe, 1.0 - dr ) ) * smoothstep( -0.35, 0.1, lq.x );   // 描金边（只在朝尾的弧上）
        c = mix( c, sc, zone * mix( 0.45, 1.0, far ) );
        c = mix( c, uGold, edge * zone * far * 0.85 );
        toonInk = max( toonInk, ( 1.0 - smoothstep( 0.022 - fe, 0.022 + fe, 1.0 - dr ) ) * smoothstep( -0.2, 0.1, lq.x ) * zone * far * 0.45 );
      }
      // —— 侧线：鳃后到尾柄一串描金短划（鱼的标志） ——
      float llPh = 0.12 + 0.05 * sin( x * 0.017 ) + jv * 0.004;
      float lld = toonLine( ph - llPh, 0.012 ) * step( 0.42, fract( xi + 0.3 ) ) * smoothstep( -178.0, -160.0, x ) * ( 1.0 - smoothstep( gx - 16.0, gx - 8.0, x ) ) * far;
      c = mix( c, uGold, lld * 0.85 );
      toonInk = max( toonInk, lld * 0.25 );
      // —— 头部：嘴、唇、鼻孔 ——
      float inMouth = smoothstep( 252.0, 256.0, x ) * toonSS( 319.0, 316.5, x );
      float lipBand = smoothstep( pm - 0.004, pm + 0.006, ph ) * ( 1.0 - smoothstep( pm + 0.085, pm + 0.1, ph + n2 * 0.01 ) ) * inMouth;
      c = mix( c, uLip, lipBand * 0.9 );
      toonInk = max( toonInk, toonLine( ph + jv * 0.004 - pm, 0.017 ) * inMouth );
      c = mix( c, uZhu, toonLine( ph - pm - 0.095, 0.012 ) * inMouth * 0.9 );
      toonMuralK *= 1.0 - 0.8 * lipBand;
      vec2 nose = vec2( ( x - 302.0 ) / 2.6, ( ph - 0.42 ) * 46.0 / 1.6 );
      toonInk = max( toonInk, ( 1.0 - smoothstep( 0.85, 1.15, length( nose ) ) ) * 0.85 );
      // —— 眼尾飞纹、眉纹、腮上祥云（朱砂填色 + 描金 + 墨线），在体表展开坐标 (x, v) 里画，以眼半径为单位 ——
      vec2 pe = vec2( x + jx * 0.4 - uEye.x, v + jv * 0.4 - uEye.y ) / uEye.z;
      if ( pe.x < 2.0 && pe.x > -8.5 && abs( pe.y + 0.6 ) < 4.2 ) {
        vec2 A[8];
        A[0] = vec2( -0.95, 0.1 ); A[1] = vec2( -1.9, 0.5 ); A[2] = vec2( -2.9, 0.72 ); A[3] = vec2( -3.8, 0.52 );
        A[4] = vec2( -4.35, 0.02 ); A[5] = vec2( -4.25, -0.48 ); A[6] = vec2( -3.85, -0.6 ); A[7] = vec2( -3.6, -0.45 );
        vec2 f1 = pengPoly( pe, A, 8 );
        float w1 = 0.3 * pow( 1.0 - f1.y, 0.7 ) + 0.04;
        vec2 B[8];
        B[0] = vec2( 0.7, 1.18 ); B[1] = vec2( -0.4, 1.5 ); B[2] = vec2( -1.6, 1.62 ); B[3] = vec2( -2.8, 1.42 );
        B[4] = vec2( -3.5, 1.05 ); B[5] = B[4]; B[6] = B[4]; B[7] = B[4];
        vec2 f2 = pengPoly( pe, B, 5 );
        float w2 = 0.13 * sin( 3.14159 * clamp( f2.y, 0.0, 1.0 ) ) + 0.025;
        vec2 T[8];
        T[0] = vec2( -2.6, -1.25 ); T[1] = vec2( -3.6, -1.05 ); T[2] = vec2( -4.8, -1.2 ); T[3] = vec2( -6.0, -1.75 );
        T[4] = vec2( -7.0, -1.65 ); T[5] = vec2( -7.6, -1.2 ); T[6] = T[5]; T[7] = T[5];
        vec2 f3 = pengPoly( pe, T, 6 );
        float w3 = 0.34 * pow( 1.0 - f3.y, 0.8 ) + 0.03;
        vec2 k1 = pengCurl( pe, vec2( -2.15, -1.85 ), 1.05, 1.7, 1.0 );
        vec2 k2 = pengCurl( pe, vec2( -1.05, -2.55 ), 0.62, 1.4, -1.0 );
        vec2 k3 = pengCurl( pe, vec2( -3.3, -2.5 ), 0.5, 1.3, -1.0 );
        // 有向距离（并集）：<0 在纹样里
        float sd = min( min( f1.x - w1, f2.x - w2 ), f3.x - w3 );
        sd = min( sd, min( k1.x, min( k2.x, k3.x ) ) );
        float fs = max( fwidth( sd ), 1e-4 );
        float fill = 1.0 - smoothstep( -fs, fs, sd );
        float goldB = ( 1.0 - smoothstep( 0.06 - fs, 0.06 + fs, abs( sd + 0.075 ) ) ) * fill;
        float spiral = min( k1.y, min( k2.y, k3.y ) );
        float spl = toonLine( spiral, 0.055 ) * fill;
        vec3 red = mix( uZhu, uZhuL, smoothstep( -0.5, 0.0, sd ) * 0.5 + 0.3 * n2 );
        c = mix( c, red, fill );
        c = mix( c, uGold, max( goldB, spl ) * 0.95 );
        toonInk = max( toonInk, toonLine( sd, 0.022 ) * 0.9 );
        toonInk = max( toonInk, spl * 0.35 );
        toonMuralK *= 1.0 - 0.6 * fill;
      }
      // 头部斑驳更重（设定图头顶石青上满是飞白点）
      toonMuralK *= 1.0 + 0.35 * tHead * ( 1.0 - belly );
      diffuseColor.rgb = c;
    }`,
  });
  const body = add(group, bindPeng(new THREE.Mesh(bodyGeo, bodyMat), bodyMat));
  body.name = 'kun-body'; body.frustumCulled = false; body.userData.outlineGroup = 'kun-body';
  const bRest = bodyGeo.attributes.aRest.array, bN0 = bodyGeo.attributes.normal.array.slice();
  const bPos = bodyGeo.attributes.position, bNrm = bodyGeo.attributes.normal;
  const ringX = bodyGeo.userData.xs;

  // ════════════════ 眼睛（丹凤眼）：头上一个低矮的眼丘（压扁的椭球），眼裂、虹膜、睑线全在着色器里画 ════════════════
  // 眼丘的风化噪声取它在鲲静止空间里的坐标（和身体的 aRest 同一空间、同一参数）→ 斑驳跨过眼眶连续
  // 眨眼 = 上睑缘下落（uOpen）；看向 = 虹膜在眼裂里平移（uLook），不转任何几何体
  const eyes = [];
  const EYE_SC = new THREE.Vector3(1.45 * RE, 1.05 * RE, 0.55 * RE);
  const eyeGeo = new THREE.SphereGeometry(1, 72, 44);
  const eyeMat = side => makePengMaterial({
    muralAmt: 1, muralScale: 0.07, fleckThr: 0.38, fadeAmt: 0.32, stainAmt: 0.4, dotAmt: 0.55, objectId: bodyMat.userData.toon.uObjectId.value,
    skyStep: 0.1, skyAmt: 0.85, skyTint: [0.86, 0.96, 1.2], rimAmt: 0.75,
    uniforms: {
      uSide: { value: side }, uOpen: { value: 1 }, uLook: { value: new THREE.Vector2() }, uRestM: { value: new THREE.Matrix4() },
      uSec: { value: new THREE.Vector3((fT(EYE_X) + fB(EYE_X)) / 2, (fT(EYE_X) - fB(EYE_X)) / 2, fW(EYE_X)) }, uEyeXV: { value: new THREE.Vector3(EYE_X, eyeV, RE) },
      uQing: { value: C('shiqing') }, uQingL: { value: C('shiqingL') }, uQingD: { value: C('shiqingD') },
      uSkin: { value: new THREE.Color().copy(C('shiqingL')).lerp(C('shiqing'), 0.55) },
      uSclera: { value: col3('#EFE6D2') }, uIrisIn: { value: col3('#F2C766') }, uIrisOut: { value: col3('#C47A2C') }, uRing: { value: col3('#6B3A1E') },
      uPupilCol: { value: col3('#1C1520') }, uCatchCol: { value: col3('#FFFAF0') }, uLid: { value: col3('#E9C9A8') },
      uZhu: { value: C('zhusha') }, uZhuL: { value: C('zhushaL') }, uGold: { value: C('gold') },
    },
    vertexPars: 'uniform mat4 uRestM;\nvarying vec3 vEyeRest;\n',
    // 着色法线向眼丘外法线（局部 +Z，近似头部体表法线）收拢：眼丘只鼓轮廓、不在眼下压出一道暗月牙。
    // 这一行只在卡通材质里编（TOON 是 three 卡通材质顶点着色器自带的宏）：镜头 C 的 wireOutlines 会把 vertexBegin 原样抄进
    // 后期 ID 图的着色器，那里没有 vNormal，不加这层会编译失败、眼丘从墨线 ID 图里消失
    vertexBegin: 'vEyeRest = ( uRestM * vec4( position, 1.0 ) ).xyz;\n#ifdef TOON\nvNormal = normalize( mix( vNormal, normalize( normalMatrix * vec3( 0.0, 0.0, 1.0 ) ), 0.8 ) );\n#endif',
    fragmentPars: /* glsl */`
      uniform float uSide, uOpen; uniform vec2 uLook;
      uniform vec3 uSkin, uSclera, uIrisIn, uIrisOut, uRing, uPupilCol, uCatchCol, uLid, uZhu, uZhuL, uGold, uSec, uQing, uQingL, uQingD;
      varying vec3 vEyeRest; uniform vec3 uEyeXV;
      float eyeSeg( vec2 p, vec2 a, vec2 b ) { vec2 e = b - a; float h = clamp( dot( p - a, e ) / dot( e, e ), 0.0, 1.0 ); return length( p - a - e * h ); }
      // 静止坐标 → 身体着色器用的弧长坐标 v（上半截面：超椭圆，指数 2/2.1；数值积分）
      float eyeSecV( float y, float z ) {
        float e = 2.0 / 2.1;
        float sy = clamp( ( y - uSec.x ) / uSec.y, 0.0, 1.0 ), sz = clamp( abs( z ) / uSec.z, 0.0, 1.0 );
        float phi = atan( pow( sy, 1.0 / e ), pow( sz, 1.0 / e ) );
        float v = 0.0; vec2 prev = vec2( uSec.z, 0.0 );
        for ( int i = 1; i <= 12; i ++ ) {
          float t = phi * float( i ) / 12.0;
          vec2 q = vec2( uSec.z * pow( cos( t ), e ), uSec.y * pow( sin( t ), e ) );
          v += length( q - prev ); prev = q;
        }
        return v;
      }
      vec2 eyePoly( vec2 p, vec2 a[8], int n ) {
        float best = 1e9, tb = 0.0, acc = 0.0, tot = 0.0;
        for ( int i = 0; i < 7; i ++ ) { if ( i >= n - 1 ) break; tot += length( a[ i + 1 ] - a[ i ] ); }
        for ( int i = 0; i < 7; i ++ ) {
          if ( i >= n - 1 ) break;
          vec2 e = a[ i + 1 ] - a[ i ]; float l = length( e );
          float h = clamp( dot( p - a[ i ], e ) / ( l * l ), 0.0, 1.0 );
          float d = length( p - a[ i ] - e * h );
          if ( d < best ) { best = d; tb = ( acc + h * l ) / tot; }
          acc += l;
        }
        return vec2( best, tb );
      }`,
    fragmentAlbedo: /* glsl */`
    {
      vec3 p = vToonObj;
      vec2 P = vec2( p.x * 1.45 * uSide, p.y * 1.05 );          // 以眼半径为单位；+x 朝吻端，+y 朝上
      vec2 jit = vec2( toonNoise( vec3( P * 2.0, uInkTime * 0.731 ) ), toonNoise( vec3( P * 2.0 + 7.0, uInkTime * 0.731 ) ) ) * 0.012;
      P += jit;
      float xs = P.x, ys = P.y + 0.24 * xs;                        // 剪切：外眼角（xs<0）上挑
      float aw = 1.04, t = clamp( xs / aw, -1.0, 1.0 ), kk = max( 1.0 - t * t, 0.0 );
      float yU = mix( -0.05, 0.37 * pow( kk, 0.58 ) * ( 1.0 + 0.22 * t ), uOpen );    // 上睑缘（半垂：压住虹膜上沿，神情沉静）
      float yL = -0.25 * pow( kk, 0.85 ) * ( 1.0 - 0.15 * t );                        // 下睑缘
      float fy = max( fwidth( ys ), 1e-4 ), fx = max( fwidth( xs ), 1e-4 );
      float inX = 1.0 - smoothstep( aw - fx, aw + fx, abs( xs ) );
      float open = inX * smoothstep( yL - fy, yL + fy, ys ) * ( 1.0 - smoothstep( yU - fy, yU + fy, ys ) ) * step( 0.02, uOpen );
      // 眼球：巩膜 + 虹膜（放射纹、外圈深环）+ 圆瞳
      vec2 ic = vec2( 0.06, 0.0 ) + uLook;
      vec2 dI = vec2( xs, P.y ) - ic;
      float r = length( dI ), fr = max( fwidth( r ), 1e-4 );
      float ri = 0.6, rp = 0.25;
      float iris = 1.0 - smoothstep( ri - fr, ri + fr, r );
      float pupil = 1.0 - smoothstep( rp - fr, rp + fr, r );
      float az = atan( dI.y, dI.x );
      float stri = 0.5 + 0.5 * sin( az * 28.0 + toonNoise( vec3( dI * 6.0, 1.0 ) ) * 3.0 );
      vec3 ic3 = mix( uIrisIn, uIrisOut, smoothstep( rp, ri * 0.92, r ) );
      ic3 = mix( ic3, ic3 * 0.8, step( 0.6, stri ) * smoothstep( rp, ri, r ) );
      ic3 = mix( ic3, uRing, smoothstep( ri * 0.86 - fr, ri * 0.86 + fr, r ) );
      vec3 eyeC = mix( uSclera, ic3, iris );
      eyeC = mix( eyeC, uPupilCol, pupil );
      // 上睑在眼球上投的阴影带
      float lash = 1.0 - smoothstep( yU - 0.14 - fy, yU - 0.14 + fy, ys );
      eyeC = mix( eyeC * vec3( 0.62, 0.58, 0.7 ), eyeC, lash );
      // 皮肤：按眼丘在静止身体上的位置重算头部底色（与身体着色器同一公式），眼眶处不接缝
      vec3 Rr = vEyeRest;
      float phs = atan( ( Rr.y - uSec.x ) / uSec.y, abs( Rr.z ) / uSec.z );
      float n2s = toonNoise( vec3( Rr.x * 0.05, phs * 50.0 * 0.07, 9.0 ) );
      vec3 skin = mix( uQingL, uQing, smoothstep( -0.3, 1.0, phs + n2s * 0.18 ) );
      skin = mix( skin, uQingD, smoothstep( 0.85, 1.45, phs ) * 0.75 );
      vec3 c = mix( skin, eyeC, open );
      // 睑缘：上睑一道米色肉边（像设定图里眼睛上方那道浅色眼睑）
      float lidB = inX * smoothstep( yU - fy, yU + fy, ys ) * ( 1.0 - smoothstep( yU + 0.16 - fy, yU + 0.16 + fy, ys ) ) * smoothstep( -1.0, -0.7, -abs( t ) );
      c = mix( c, uLid, lidB * 0.8 * step( 0.02, uOpen ) );
      // 眼尾飞纹：用和身体着色器完全相同的展开坐标 (x, v) 与折线、宽度、抖动来画 → 跨过眼眶严丝合缝
      float vB = eyeSecV( vEyeRest.y, vEyeRest.z );
      vec3 jqB = vec3( vEyeRest.x * 0.05, vB * 0.05, uInkTime * 0.731 );
      vec2 pe = vec2( vEyeRest.x + toonNoise( jqB ) * 0.5 * 0.4 - uEyeXV.x, vB + toonNoise( jqB + 19.1 ) * 0.5 * 0.4 - uEyeXV.y ) / uEyeXV.z;
      vec2 A[8];
      A[0] = vec2( -0.95, 0.1 ); A[1] = vec2( -1.9, 0.5 ); A[2] = vec2( -2.9, 0.72 ); A[3] = vec2( -3.8, 0.52 );
      A[4] = vec2( -4.35, 0.02 ); A[5] = vec2( -4.25, -0.48 ); A[6] = vec2( -3.85, -0.6 ); A[7] = vec2( -3.6, -0.45 );
      vec2 f1 = eyePoly( pe, A, 8 );
      float w1 = 0.3 * pow( 1.0 - f1.y, 0.7 ) + 0.04;
      float sd = f1.x - w1, ffs = max( fwidth( sd ), 1e-4 );
      float fill = ( 1.0 - smoothstep( -ffs, ffs, sd ) ) * ( 1.0 - open );
      c = mix( c, mix( uZhu, uZhuL, smoothstep( -0.5, 0.0, sd ) * 0.5 ), fill );
      c = mix( c, uGold, ( 1.0 - smoothstep( 0.06 - ffs, 0.06 + ffs, abs( sd + 0.075 ) ) ) * fill * 0.95 );
      toonInk = max( toonInk, toonLine( sd, 0.022 ) * 0.9 * ( 1.0 - open ) );
      // 线：上睑缘粗墨线（中间粗、内眼角细，外眼角拖出尖尾）、下睑缘细线、双眼皮折线
      float wU = mix( 0.035, 0.085, smoothstep( 0.9, -0.3, t ) );
      float lineU = ( 1.0 - smoothstep( wU - fy, wU + fy, abs( ys - yU ) ) ) * inX;
      vec2 tail0 = vec2( -aw, 0.0 ), tail1 = vec2( -aw - 0.5, 0.2 );
      float dt = eyeSeg( vec2( xs, ys ), tail0, tail1 ), ht = clamp( dot( vec2( xs, ys ) - tail0, tail1 - tail0 ) / dot( tail1 - tail0, tail1 - tail0 ), 0.0, 1.0 );
      float tailL = 1.0 - smoothstep( mix( 0.07, 0.01, ht ) - fy, mix( 0.07, 0.01, ht ) + fy, dt );
      float lineL = ( 1.0 - smoothstep( 0.022 - fy, 0.022 + fy, abs( ys - yL ) ) ) * ( 1.0 - smoothstep( 0.8, 0.98, abs( t ) ) ) * step( 0.02, uOpen );
      float crease = ( 1.0 - smoothstep( 0.02 - fy, 0.02 + fy, abs( ys - yU - 0.2 - 0.04 * t ) ) ) * ( 1.0 - smoothstep( 0.55, 0.85, abs( t + 0.1 ) ) ) * step( 0.3, uOpen );
      toonInk = max( toonInk, max( lineU, tailL ) * 0.95 );
      toonInk = max( toonInk, max( lineL * 0.6, crease * 0.55 ) );
      // 高光（固定在眼窝左上方），只在眼裂里
      float c1 = 1.0 - smoothstep( 0.12 - fr, 0.12 + fr, length( vec2( xs, P.y ) - ic - vec2( -0.2, 0.16 ) ) );
      float c2 = 1.0 - smoothstep( 0.055 - fr, 0.055 + fr, length( vec2( xs, P.y ) - ic - vec2( 0.2, -0.12 ) ) );
      toonOverlay = vec4( uCatchCol, max( c1, c2 ) * open * lash );
      // 虹膜别被阴影色调压得太闷：叠一点原色
      toonOverlay = mix( vec4( ic3, 0.3 * iris * ( 1.0 - pupil ) * open * lash ), toonOverlay, toonOverlay.a );
      diffuseColor.rgb = c;
      toonMuralP = vEyeRest;
      toonMuralK = ( 1.0 - open ) * ( 1.0 - fill * 0.6 ) * 1.35;
    }`,
  });
  for (const side of [1, -1]) {
    const ph0 = side > 0 ? EYE_PH : Math.PI - EYE_PH;
    const sp = bodyPoint(EYE_X, ph0), n = bodyNormal(EYE_X, ph0);
    const zA = n.clone().add(new THREE.Vector3(0.12, -0.06, 0)).normalize();
    const yA = UP.clone().addScaledVector(zA, -zA.y).normalize(), xA = new THREE.Vector3().crossVectors(yA, zA);
    const rest = new THREE.Group(); rest.name = 'kun-eye-' + (side > 0 ? 'R' : 'L');
    rest.position.copy(sp).addScaledVector(n, -0.25 * RE);
    rest.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xA, yA, zA));
    rest.updateMatrix();
    const restM = rest.matrix.clone();
    rest.matrixAutoUpdate = false;
    const mat = eyeMat(side);
    const mound = new THREE.Mesh(eyeGeo, mat); mound.scale.copy(EYE_SC); mound.name = 'kun-eye-mound';
    add(rest, bindPeng(mound, mat, { castShadow: false }));
    mound.userData.outlineGroup = 'kun-body';
    mound.updateMatrix();
    mat.userData.toon.uRestM.value.multiplyMatrices(restM, mound.matrix);
    group.add(rest);
    eyes.push({ side, group: rest, restM, mound, mat });
  }

  // ════════════════ 长须（CPU 管子，一拍三摆） ════════════════
  const BARB_N = 72, BARB_R = 8;
  const barbMat = makePengMaterial({
    rest: true, side: THREE.FrontSide, muralAmt: 0.6, muralScale: 0.25, outlineW: 0.8,
    shade1Tint: [0.62, 0.6, 0.74], rimAmt: 0.7, fillAmt: 0.6,
    uniforms: { uA: { value: col3('#8A3326') }, uB: { value: C('zhusha') }, uC: { value: C('tuhuang') } },
    vertexPars: 'attribute vec2 aBar;\nvarying vec2 vBar;\n', vertexBegin: 'vBar = aBar;',
    fragmentPars: 'varying vec2 vBar;\nuniform vec3 uA, uB, uC;\n',
    fragmentAlbedo: /* glsl */`
    {
      float s = vBar.x;
      vec3 c = mix( uA, uB, smoothstep( 0.0, 0.45, s ) );
      c = mix( c, uC, smoothstep( 0.55, 1.0, s ) * 0.75 );
      float ring = toonLine( fract( s * 34.0 + 0.5 ) - 0.5, 0.07 ) * toonFar( vec2( s * 34.0 ), 0.25, 0.6 );
      c *= 1.0 - 0.18 * ring;
      diffuseColor.rgb = c;
    }`,
  });
  const barbels = [];
  {
    const pos = new Float32Array(2 * BARB_N * BARB_R * 3), rest = new Float32Array(pos.length), bar = new Float32Array(2 * BARB_N * BARB_R * 2), idx = [];
    for (let b = 0; b < 2; b++) {
      const base = b * BARB_N * BARB_R;
      for (let i = 0; i < BARB_N; i++) for (let k = 0; k < BARB_R; k++) {
        const vi = base + i * BARB_R + k;
        bar[vi * 2] = i / (BARB_N - 1); bar[vi * 2 + 1] = k / BARB_R;
        rest[vi * 3] = i * 3.1; rest[vi * 3 + 1] = Math.cos(k / BARB_R * TAU) * 2; rest[vi * 3 + 2] = Math.sin(k / BARB_R * TAU) * 2 + b * 40;
        if (i < BARB_N - 1) { const a = vi, c = base + i * BARB_R + (k + 1) % BARB_R, d = a + BARB_R, e = c + BARB_R; idx.push(a, c, d, c, e, d); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.length), 3));
    g.setAttribute('aRest', new THREE.BufferAttribute(rest, 3)); g.setAttribute('aBar', new THREE.BufferAttribute(bar, 2)); g.setIndex(idx);
    const m = add(group, bindPeng(new THREE.Mesh(g, barbMat), barbMat)); m.name = 'kun-barbels'; m.frustumCulled = false;
    for (const side of [1, -1]) {
      const X0 = 306, ph0 = side > 0 ? -0.2 : Math.PI + 0.2;
      const root = bodyPoint(X0, ph0), n = bodyNormal(X0, ph0);
      // 静止形：先往外、往前一点，再垂下、向后飘，末端回勾
      const pts = [[0, 0, 0], [5, -10, side * 9], [2, -38, side * 20], [-18, -78, side * 27], [-46, -112, side * 26], [-80, -132, side * 20], [-112, -136, side * 16], [-134, -126, side * 15]]
        .map(([x, y, z]) => new THREE.Vector3(x, y, z).add(root).addScaledVector(n, -0.8));
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      barbels.push({ side, rest: curve.getSpacedPoints(BARB_N - 1), x0: X0 });
    }
    barbels.mesh = m;
  }

  // ════════════════ 火焰舌（背鳍冠、背鳍、腹鳍、臀鳍、尾柄）：实例卡片，CPU 跟随脊柱 ════════════════
  const flameGeo = card('flame', 22, 5);
  const flameMat = makePengMaterial({
    side: THREE.DoubleSide, muralAmt: 0.7, muralScale: 0.12, outlineW: 0.9, rimAmt: 0.75, fillAmt: 0.7,
    shade1Tint: [0.66, 0.58, 0.72], shade2Tint: [0.42, 0.34, 0.52],
    uniforms: { uA: { value: col3('#9E2E26') }, uB: { value: C('zhusha') }, uC: { value: C('zhushaL') }, uHi: { value: col3('#F2D7AE') }, uY: { value: C('tuhuang') } },
    vertexPars: 'attribute vec2 aCard;\nvarying vec2 vCard;\n', vertexBegin: 'vCard = aCard;',
    fragmentPars: 'varying vec2 vCard;\nuniform vec3 uA, uB, uC, uHi, uY;\n',
    fragmentAlbedo: /* glsl */`
    {
      float u = vCard.x, vn = vCard.y;
      float nz = toonNoise( vec3( u * 3.0, vn * 0.8, vToonInst * 0.71 ) );
      vec3 c = mix( uA, uB, smoothstep( 0.0, 0.45, u + nz * 0.1 ) );
      c = mix( c, uC, smoothstep( 0.5, 0.95, u + nz * 0.1 ) * 0.8 );
      float hi = smoothstep( 0.35, 0.7, -vn + nz * 0.2 ) * smoothstep( 0.08, 0.3, u ) * ( 1.0 - smoothstep( 0.7, 0.9, u ) );
      c = mix( c, uHi, hi * 0.6 );
      c = mix( c, uY, smoothstep( 0.25, 0.0, abs( vn + 0.1 ) ) * smoothstep( 0.2, 0.5, u ) * ( 1.0 - smoothstep( 0.75, 0.95, u ) ) * 0.35 );
      float qv = vn * 1.6 + nz * 0.15;
      float vein = toonLine( fract( qv + 0.5 ) - 0.5, 0.07 ) * smoothstep( 0.1, 0.3, u ) * ( 1.0 - smoothstep( 0.8, 0.95, u ) ) * toonFar( vec2( u * 8.0, qv ), 0.25, 0.7 );
      toonInk = max( toonInk, vein * 0.4 );
      diffuseColor.rgb = c;
    }`,
  });
  // 定义：[x, phi(侧角, 上 = π/2), 长, 宽倍率, 外伸方向混入后方的量, 侧倾]
  const flameDefs = [];
  const addRow = (x0, x1, n, ph, L0, L1, back, lean, both) => {
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0.5, x = lerp(x0, x1, t) + (R() - 0.5) * 3;
      const L = lerp(L0, L1, t) * (0.85 + R() * 0.3);
      if (both) for (const s of [1, -1]) flameDefs.push({ x, ph: s > 0 ? ph : Math.PI - ph, L, w: 0.9 + R() * 0.3, back, lean: lean * s });
      else flameDefs.push({ x, ph, L, w: 0.9 + R() * 0.3, back, lean: (R() - 0.5) * 0.3 });
    }
  };
  addRow(212, 150, 7, Math.PI / 2, 58, 86, 0.3, 0, false);            // 头后火焰冠
  addRow(36, -118, 12, Math.PI / 2, 84, 36, 0.42, 0, false);          // 背鳍
  addRow(72, 18, 5, -1.2, 62, 38, 0.5, 0.5, true);                   // 腹鳍（成对，略往外撇）
  addRow(-100, -160, 6, -Math.PI / 2, 60, 28, 0.52, 0, false);        // 臀鳍
  addRow(-166, -192, 4, Math.PI / 2, 34, 44, 0.66, 0, false);         // 尾柄上
  addRow(-168, -192, 4, -Math.PI / 2, 32, 42, 0.66, 0, false);        // 尾柄下
  addRow(190, 168, 3, -0.95, 44, 32, 0.55, 0.5, true);                // 鳃下小鳍
  const flames = new THREE.InstancedMesh(flameGeo, flameMat, flameDefs.length);
  flames.name = 'kun-flames'; flames.frustumCulled = false;
  add(group, bindPeng(flames, flameMat));
  const flameRest = flameDefs.map(d => {
    const p = bodyPoint(d.x, d.ph), n = bodyNormal(d.x, d.ph);
    // 卡片：+X 外伸（法线混入后方），+Z 向后（卡片平面内的弯曲朝后），+Y = 卡片法线
    const out = n.clone().multiplyScalar(1 - d.back).add(new THREE.Vector3(-d.back, 0, 0)).normalize();
    const zb = new THREE.Vector3(-1, 0, 0).addScaledVector(out, out.x).normalize();   // 与外伸方向正交的“后方”
    const yA = new THREE.Vector3().crossVectors(zb, out).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(out, yA, zb));
    q.multiply(new THREE.Quaternion().setFromAxisAngle(AX, d.lean));
    return { x: d.x, m: new THREE.Matrix4().compose(p.addScaledVector(n, -2.2), q, new THREE.Vector3(d.L, d.L * 0.5, d.L * d.w)) };
  });

  // ════════════════ 翅膀（臂 + 掌两段刚体；羽片是实例卡片） ════════════════
  const roundGeo = card('round', 10, 5), longGeo = card('long', 16, 5);
  const featherHooks = {
    vertexPars: 'attribute vec2 aCard;\nattribute vec4 aFA;\nattribute vec4 aFB;\nattribute vec4 aFC;\nvarying vec2 vCard;\nvarying vec4 vFA;\nvarying vec4 vFB;\nvarying vec4 vFC;\n',
    vertexBegin: 'vCard = aCard; vFA = aFA; vFB = aFB; vFC = aFC;',
    fragmentPars: 'varying vec2 vCard;\nvarying vec4 vFA;\nvarying vec4 vFB;\nvarying vec4 vFC;\n',
    fragmentAlbedo: /* glsl */`
    {
      float u = vCard.x, vn = vCard.y, av = abs( vn );
      float f = vFA.w;                                  // 0 = 鳞形，1 = 羽形
      float hs = toonHash13( vec3( vToonInst * 1.13, vFC.w * 7.0, 3.7 ) );
      float nz = toonNoise( vec3( u * 4.0, vn * 1.2, vToonInst * 0.37 + vFC.w * 11.0 ) );
      float tt = smoothstep( vFB.w - 0.16, vFB.w + 0.16, u + nz * 0.08 - 0.05 * av );
      vec3 c = mix( vFA.rgb, vFB.rgb, tt );
      c *= 0.94 + 0.09 * step( 0.0, vn ) * f;           // 两片羽翈一明一暗
      // 外缘描边带（鳞形描金，羽形赭石）
      float ed = min( 1.0 - av, ( 1.0 - u ) * 2.4 );
      float fe = max( fwidth( ed ), 1e-4 );
      float band = 1.0 - smoothstep( 0.12 - fe, 0.12 + fe, ed + nz * 0.03 );
      c = mix( c, vFC.rgb, band * mix( 0.9, 0.6, f ) );
      // 鳞形：前半被上一片压着发暗，近自由边亮
      float sk = 1.0 - smoothstep( 0.25, 0.6, f );
      c *= mix( 1.0, mix( 0.8, 1.1, smoothstep( 0.1, 0.75, u ) ), sk );
      // 羽轴、羽枝（羽形才有）
      float far = toonFar( vec2( u * vFC.w, vn * 3.0 ), 0.3, 0.8 );
      float fk = smoothstep( 0.35, 0.65, f );
      float rach = toonLine( vn + 0.04, mix( 0.07, 0.025, u ) ) * fk * ( 1.0 - smoothstep( 0.86, 0.97, u ) ) * smoothstep( 0.02, 0.08, u );
      float bq = ( u - av * 0.22 ) * vFC.w + nz * 0.25;
      float barb = toonLine( fract( bq + 0.5 ) - 0.5, 0.07 ) * step( 0.1, av ) * far * fk;
      float split = toonLine( bq - floor( hs * vFC.w * 0.6 + vFC.w * 0.25 ) - 0.5, 0.09 ) * step( 0.35, av ) * fk * step( 0.5, hs );
      toonInk = max( toonInk, rach * 0.7 );
      toonInk = max( toonInk, barb * 0.2 );
      toonInk = max( toonInk, split * 0.55 );
      diffuseColor.rgb = c;
      toonMuralP = vec3( u * 3.0, vn * 0.8, vToonInst * 1.7 + vFC.w ) * 8.0;
    }`,
  };
  const featherMat = (extra = {}) => makePengMaterial({
    side: THREE.DoubleSide, muralAmt: 0.75, muralScale: 0.11, fleckThr: 0.42, outlineW: 0.75, castShade: 0.7,
    rimAmt: 0.7, rimInside: 0.32, fillAmt: 0.75, fillFlat: 0.45, shade1Tint: [0.66, 0.66, 0.8], ...featherHooks, ...extra,
  });
  const lobeMat = (part) => makePengMaterial({
    muralAmt: 0.8, muralScale: 0.08, outlineW: 1,
    uniforms: { uQing: { value: C('shiqing') }, uLv: { value: C('shilv') }, uCream: { value: C('cream') }, uGold: { value: C('gold') } },
    vertexPars: 'attribute vec3 aW;\nvarying vec3 vW;\n', vertexBegin: 'vW = aW;',
    fragmentPars: 'varying vec3 vW;\nuniform vec3 uQing, uLv, uCream, uGold;\n',
    fragmentAlbedo: /* glsl */`
    {
      float t = vW.x, cp = vW.y;
      float nz = toonNoise( vToonObj * 0.05 );
      float f = clamp( ( vW.z > 0.5 ? 0.55 + 0.45 * t : t * 0.8 ) + cp * 0.25 + nz * 0.1, 0.0, 1.0 );
      vec3 sc = mix( uQing, uLv, smoothstep( 0.0, 0.5, t + cp * 0.4 + nz * 0.2 ) );
      vec3 c = mix( sc, uCream, smoothstep( 0.45, 0.85, f ) );
      vec2 q = vec2( t * ( vW.z > 0.5 ? 6.0 : 13.0 ), cp * 8.0 );
      vec2 cq = vec2( floor( q.x ), floor( q.y - 0.5 * mod( floor( q.x ), 2.0 ) ) + 0.5 * mod( floor( q.x ), 2.0 ) );
      vec2 lq = q - cq - vec2( 0.0, 0.5 );
      float dr = length( lq * vec2( 1.0, 1.1 ) );
      float fs = max( fwidth( dr ), 1e-4 );
      float rim = 1.0 - smoothstep( 0.05 - fs, 0.05 + fs, abs( dr - 0.62 ) );
      c = mix( c, uGold, rim * ( 1.0 - smoothstep( 0.5, 0.8, f ) ) * toonFar( q, 0.2, 0.5 ) * 0.7 );
      diffuseColor.rgb = c;
    }`,
  });

  // 羽片配色
  const cScaleA = [PENG.shiqing, PENG.qinglv, PENG.shilv, '#4C86A8'].map(col3);
  const cFeat = { cream: C('cream'), yuebai: C('yuebai'), creamD: C('creamD'), zhusha: C('zhusha'), zhushaL: C('zhushaL'), zhushaD: C('zhushaD'), zheshi: C('zheshi'), tuhuang: C('tuhuang'), gold: C('gold'), shilv: C('shilv'), shilvL: C('shilvL') };
  // 一组羽片 → InstancedMesh（矩阵在“部位局部”空间：臂 / 掌）
  function featherMesh(geo, items, name, mat) {
    const m = new THREE.InstancedMesh(geo, mat, items.length);
    const A = new Float32Array(items.length * 4), B = new Float32Array(items.length * 4), Cc = new Float32Array(items.length * 4);
    items.forEach((it, i) => {
      m.setMatrixAt(i, it.m);
      A.set([it.a.r, it.a.g, it.a.b, it.f], i * 4); B.set([it.b.r, it.b.g, it.b.b, it.t0], i * 4); Cc.set([it.e.r, it.e.g, it.e.b, it.bd], i * 4);
    });
    m.instanceMatrix.needsUpdate = true;
    // 实例属性挂在几何上：每个 InstancedMesh 用自己的几何副本
    const g = geo.clone();
    g.setAttribute('aFA', new THREE.InstancedBufferAttribute(A, 4)); g.setAttribute('aFB', new THREE.InstancedBufferAttribute(B, 4)); g.setAttribute('aFC', new THREE.InstancedBufferAttribute(Cc, 4));
    m.geometry = g;
    m.name = name; m.frustumCulled = false;
    return bindPeng(m, mat);
  }
  // 卡片矩阵：along 方向、法线方向（会正交化）、长 L、宽 W、根部位置
  const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3(), _bm = new THREE.Matrix4();
  function cardM(pos, along, nrm, L, W) {
    _bx.copy(along).normalize();
    _by.copy(nrm).addScaledVector(_bx, -nrm.dot(_bx)).normalize();
    _bz.crossVectors(_bx, _by);
    _bm.makeBasis(_bx.clone().multiplyScalar(L), _by.clone().multiplyScalar(W), _bz.clone().multiplyScalar(W));
    _bm.setPosition(pos);
    return _bm.clone();
  }

  const wings = [];
  for (const side of [1, -1]) {
    const pivot = new THREE.Group(); pivot.name = 'kun-wing-' + (side > 0 ? 'R' : 'L');
    const arm = new THREE.Group(), hand = new THREE.Group();
    pivot.add(arm); arm.add(hand);
    group.add(pivot);
    // —— 肉鳍基部（臂、掌），加一个肩部椭球把翼根和身体接上 ——
    const armGeo = buildLobe({ nS: Math.round(lerp(18, 36, lod)), nC: 28, span: LA + 6, side, plan: armPlan, part: 0 });
    const am = lobeMat(0); add(arm, bindPeng(new THREE.Mesh(armGeo, am), am)).frustumCulled = false;
    const wristX = armPlan(LA).le - 12;
    hand.position.set(wristX, 0, side * LA);
    const handGeo = buildLobe({ nS: Math.round(lerp(12, 24, lod)), nC: 24, span: LH, side, plan: handPlan, part: 1, s0: -14 });
    const hm = lobeMat(1); add(hand, bindPeng(new THREE.Mesh(handGeo, hm), hm)).frustumCulled = false;

    // —— 臂上的覆羽：从前缘到后缘五排；展向从鳍根到腕部，鳞形渐变成羽形 ——
    const armCov = [], armFly = [], handCov = [], handFly = [];
    const ROWS = [
      { cf: 0.04, lf: 0.2, n: 17 }, { cf: 0.15, lf: 0.26, n: 15 }, { cf: 0.28, lf: 0.32, n: 13 },
      { cf: 0.43, lf: 0.4, n: 12 }, { cf: 0.6, lf: 0.52, n: 11 },
    ];
    ROWS.forEach((row, r) => {
      for (let i = 0; i < row.n; i++) {
        const s = ((i + 0.5 + (r % 2) * 0.5) / (row.n + 0.5)) * LA * 0.98 + (R() - 0.5) * 2;
        const t = s / LA, P = armPlan(s);
        const f = clamp(t * 1.25 + r * 0.12 - 0.22 + (R() - 0.5) * 0.12);
        const L = row.lf * P.c * lerp(1.0, 1.35, f) * (0.88 + R() * 0.24);
        const W = L * lerp(0.95, 0.5, f) * (0.9 + R() * 0.2);
        const rake = 0.12 + 0.42 * t + (R() - 0.5) * 0.14;
        for (const up of [1, -1]) {
          if (up < 0 && r < 1) continue;
          const y = up > 0 ? lobeTop(P, row.cf) + 0.7 + r * 0.32 : lobeBot(P, row.cf) - 0.7 - r * 0.2;
          const pos = new THREE.Vector3(P.le - row.cf * P.c, y, side * s);
          const along = new THREE.Vector3(-1, -up * 0.05, side * rake);
          const nrm = new THREE.Vector3((R() - 0.5) * 0.1, up, side * (R() - 0.5) * 0.3);
          // 配色：鳞形 = 石青石绿（描金边）；羽形 = 米白（赭石边），后排带朱砂梢
          const sc = cScaleA[Math.floor(R() * cScaleA.length)];
          const a = new THREE.Color().copy(sc).lerp(up > 0 ? cFeat.cream : cFeat.yuebai, sstep(0.25, 0.85, f));
          let b = new THREE.Color().copy(a).lerp(cFeat.yuebai, 0.25 * f);
          let t0 = 0.75;
          if (r >= 3 && f > 0.55 && up > 0) { b = new THREE.Color().copy(cFeat.zhusha).lerp(cFeat.zhushaL, R() * 0.5); t0 = r === 4 ? 0.62 : 0.78; }
          else if (f > 0.6 && R() < 0.35 && up > 0) { b = cFeat.tuhuang.clone(); t0 = 0.8; }
          const e = new THREE.Color().copy(cFeat.gold).lerp(cFeat.zheshi, sstep(0.3, 0.9, f));
          armCov.push({ m: cardM(pos, along, nrm, L, W), a, b, t0, e, f, bd: lerp(4, 10, f) });
        }
      }
    });
    // 次级飞羽：臂后缘，米白 → 朱砂梢
    const NS2 = 12;
    for (let i = 0; i < NS2; i++) {
      const s = (i + 0.6) / NS2 * LA, t = s / LA, P = armPlan(s);
      const L = lerp(78, 104, t) * (0.95 + R() * 0.1), W = 24;
      const pos = new THREE.Vector3(P.le - 0.7 * P.c, lobeTop(P, 0.7) * 0.4 + 0.3 + i * 0.12, side * s);
      const along = new THREE.Vector3(-1, -0.02, side * (0.05 + 0.24 * t));
      const a = new THREE.Color().copy(cFeat.cream).lerp(cFeat.shilvL, (1 - t) * 0.35);
      const b = new THREE.Color().copy(cFeat.zhusha).lerp(cFeat.zhushaD, R() * 0.4);
      armFly.push({ m: cardM(pos, along, UP, L, W), a, b, t0: lerp(0.62, 0.5, t), e: cFeat.zheshi, f: 1, bd: 20 });
    }
    // 掌：初级覆羽两排 + 初级飞羽十根（扇形展开，外侧最长、几乎全朱砂）
    [{ cf: 0.08, lf: 0.42, n: 7 }, { cf: 0.32, lf: 0.6, n: 6 }].forEach((row, r) => {
      for (let i = 0; i < row.n; i++) {
        const s = (i + 0.5 + r * 0.4) / (row.n + 0.4) * LH, P = handPlan(s);
        const L = row.lf * P.c * 1.15 + 6, W = L * 0.48;
        for (const up of [1, -1]) {
          const pos = new THREE.Vector3(P.le - row.cf * P.c, up > 0 ? lobeTop(P, row.cf) + 0.6 + r * 0.3 : lobeBot(P, row.cf) - 0.6 - r * 0.2, side * s);
          const along = new THREE.Vector3(-1, 0, side * (0.4 + 0.5 * s / LH));
          const a = (up > 0 ? cFeat.cream : cFeat.yuebai).clone();
          const b = up > 0 && r === 1 ? cFeat.zhushaL.clone() : cFeat.cream.clone().lerp(cFeat.tuhuang, 0.3);
          handCov.push({ m: cardM(pos, along, new THREE.Vector3(0, up, 0), L, W), a, b, t0: 0.72, e: cFeat.zheshi, f: 1, bd: 9 });
        }
      }
    });
    const NP = 10, PL = [112, 118, 124, 132, 140, 146, 150, 148, 140, 124];
    for (let i = 0; i < NP; i++) {
      const k = i / (NP - 1), s = lerp(4, LH * 0.97, k), P = handPlan(s);
      const ang = lerp(8, 66, Math.pow(k, 1.1)) * DEG;
      const along = new THREE.Vector3(-Math.cos(ang), -0.03, side * Math.sin(ang));
      const pos = new THREE.Vector3(P.le - 0.62 * P.c, 0.4 + i * 0.28, side * s);
      const L = PL[i] * (0.97 + R() * 0.06), W = lerp(25, 19, k);
      const a = new THREE.Color().copy(cFeat.cream).lerp(cFeat.yuebai, 0.3);
      const b = new THREE.Color().copy(cFeat.zhusha).lerp(i % 3 === 1 ? cFeat.zhushaL : cFeat.zhushaD, 0.3 + R() * 0.3);
      handFly.push({ m: cardM(pos, along, UP, L, W), a, b, t0: lerp(0.55, 0.28, k), e: cFeat.zhushaD, f: 1, bd: 26 });
    }
    add(arm, featherMesh(roundGeo, armCov, 'kun-wing-coverts', featherMat()));
    add(arm, featherMesh(longGeo, armFly, 'kun-wing-secondaries', featherMat({ outlineW: 0.85 })));
    add(hand, featherMesh(roundGeo, handCov, 'kun-wing-handcoverts', featherMat()));
    add(hand, featherMesh(longGeo, handFly, 'kun-wing-primaries', featherMat({ outlineW: 0.9 })));

    // 翅根静止位置：x=156，体侧中线略上（phi≈0.2，鳃后胸鳍的位置），嵌进身体 7 米
    const x0 = 150, phR = 0.2, ph0 = side > 0 ? phR : Math.PI - phR;
    const root = bodyPoint(x0, ph0), nrm = bodyNormal(x0, ph0);
    root.addScaledVector(nrm, -12);
    wings.push({ side, pivot, arm, hand, root, x0 });
  }

  // ════════════════ 凤尾翎（CPU 丝带：每帧沿中心线重建） ════════════════
  const PL_NA = Math.round(lerp(70, 130, lod)), PL_NC = 5;
  const plumeMat = makePengMaterial({
    rest: true, side: THREE.DoubleSide, muralAmt: 0.7, muralScale: 0.1, outlineW: 0.9, castShade: 0.8,
    rimAmt: 0.75, fillAmt: 0.7, shade1Tint: [0.66, 0.64, 0.8],
    uniforms: { uGold: { value: C('gold') }, uTu: { value: C('tuhuang') }, uCream: { value: C('yuebai') }, uTeal: { value: C('shilvD') }, uZhuD: { value: C('zhushaD') }, uPupil: { value: col3('#1F2A3E') } },
    vertexPars: 'attribute vec4 aPl;\nattribute vec3 aCA;\nattribute vec3 aCB;\nattribute vec3 aCC;\nvarying vec4 vPl;\nvarying vec3 vCA;\nvarying vec3 vCB;\nvarying vec3 vCC;\n',
    vertexBegin: 'vPl = aPl; vCA = aCA; vCB = aCB; vCC = aCC;',
    fragmentPars: 'varying vec4 vPl;\nvarying vec3 vCA;\nvarying vec3 vCB;\nvarying vec3 vCC;\nuniform vec3 uGold, uTu, uCream, uTeal, uZhuD, uPupil;\n',
    fragmentAlbedo: /* glsl */`
    {
      float u = vPl.x, vn = vPl.y, av = abs( vn );
      float nz = toonNoise( vec3( u * 7.0, vn * 1.3, vPl.z * 3.1 ) );
      vec3 c = mix( vCA, vCB, smoothstep( 0.04, 0.38, u + nz * 0.05 ) );
      c = mix( c, vCC, smoothstep( 0.5, 0.86, u + nz * 0.06 + 0.06 * av ) );
      c *= 0.95 + 0.08 * step( 0.0, vn );
      // 眼斑：杏核形，外圈土黄、内圈月白、中心石绿和深色瞳
      if ( vPl.w > 0.5 ) {
        vec2 e = vec2( ( u - 0.83 ) / 0.075, vn / 0.62 );
        float lens = length( vec2( e.x, e.y / max( 1.0 - 0.6 * e.x * e.x, 0.05 ) ) );
        float fl = max( fwidth( lens ), 1e-4 );
        float r1 = 1.0 - smoothstep( 1.55 - fl, 1.55 + fl, lens );
        float r2 = 1.0 - smoothstep( 1.0 - fl, 1.0 + fl, lens );
        float r3 = 1.0 - smoothstep( 0.52 - fl, 0.52 + fl, lens );
        float r4 = 1.0 - smoothstep( 0.24 - fl, 0.24 + fl, lens );
        c = mix( c, uTu, r1 * 0.9 );
        c = mix( c, uCream, r2 );
        c = mix( c, uTeal, r3 );
        c = mix( c, uPupil, r4 );
        toonInk = max( toonInk, toonLine( lens - 1.0, 0.045 ) * 0.7 );
        toonInk = max( toonInk, toonLine( lens - 1.55, 0.04 ) * 0.35 );
        toonMuralK = 1.0 - r2 * 0.7;
      }
      // 羽轴、羽枝、羽片开裂
      float far = toonFar( vec2( u * 30.0, vn * 3.0 ), 0.3, 0.8 );
      float rach = toonLine( vn, mix( 0.08, 0.02, u ) ) * ( 1.0 - smoothstep( 0.72, 0.8, u ) * vPl.w ) * ( 1.0 - smoothstep( 0.93, 0.99, u ) );
      float bq = ( u - av * 0.05 ) * 46.0 + nz * 0.3;
      float barb = toonLine( fract( bq + 0.5 ) - 0.5, 0.08 ) * step( 0.12, av ) * far;
      float split = toonLine( fract( u * 7.0 + vPl.z * 0.37 + 0.5 ) - 0.5, 0.012 ) * smoothstep( 0.55, 0.85, av ) * step( u, 0.75 );
      float ed = 1.0 - av, fe = max( fwidth( ed ), 1e-4 );
      c = mix( c, mix( c, uZhuD, 0.5 ), ( 1.0 - smoothstep( 0.08 - fe, 0.08 + fe, ed ) ) * 0.7 );
      toonInk = max( toonInk, rach * 0.65 );
      toonInk = max( toonInk, barb * 0.18 );
      toonInk = max( toonInk, split * 0.5 );
      diffuseColor.rgb = c;
    }`,
  });
  const plumeData = [];
  {
    const nP = PLUMES.length, nv = nP * (PL_NA + 1) * PL_NC;
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), rest = new Float32Array(nv * 3), pl = new Float32Array(nv * 4);
    const ca = new Float32Array(nv * 3), cb = new Float32Array(nv * 3), cc = new Float32Array(nv * 3), idx = [];
    PLUMES.forEach((p, k) => {
      const base = k * (PL_NA + 1) * PL_NC, cw = PLUME_CW[p.cw].map(col3);
      // 根部位置：尾柄末端的一个小椭圆上（按扇角分布）
      const ra = p.a * DEG;
      const root = new THREE.Vector3(X_TAIL + 6 - Math.abs(Math.sin(ra)) * 5, Math.sin(ra) * 11, Math.sin(p.b * DEG) * 5);
      // 宽度轮廓：根细、中段宽、眼斑处略鼓、梢收圆；边缘带锯齿（羽枝开裂）
      const hw = [];
      for (let i = 0; i <= PL_NA; i++) {
        const u = i / PL_NA;
        let w = 1.08 * p.W * (0.16 + 0.84 * sstep(0, 0.4, u)) * (1 - 0.88 * Math.pow(sstep(0.84, 1.0, u), 1.2));
        if (p.oc) w *= 1 + 0.22 * Math.exp(-Math.pow((u - 0.83) / 0.07, 2));
        hw.push(w * 0.5);
      }
      plumeData.push({ p, k, root, hw, base, phase: k * 0.83 });
      for (let i = 0; i <= PL_NA; i++) for (let j = 0; j < PL_NC; j++) {
        const vi = base + i * PL_NC + j, u = i / PL_NA, vn = -1 + 2 * j / (PL_NC - 1);
        pl.set([u, vn, k, p.oc], vi * 4);
        rest.set([u * p.L, vn * hw[i], k * 37.0], vi * 3);
        ca.set([cw[0].r, cw[0].g, cw[0].b], vi * 3); cb.set([cw[1].r, cw[1].g, cw[1].b], vi * 3); cc.set([cw[2].r, cw[2].g, cw[2].b], vi * 3);
        if (i < PL_NA && j < PL_NC - 1) { const a = vi, b = vi + PL_NC; idx.push(a, a + 1, b, b, a + 1, b + 1); }
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aRest', new THREE.BufferAttribute(rest, 3)); g.setAttribute('aPl', new THREE.BufferAttribute(pl, 4));
    g.setAttribute('aCA', new THREE.BufferAttribute(ca, 3)); g.setAttribute('aCB', new THREE.BufferAttribute(cb, 3)); g.setAttribute('aCC', new THREE.BufferAttribute(cc, 3));
    g.setIndex(idx);
    const m = add(group, bindPeng(new THREE.Mesh(g, plumeMat), plumeMat, { perInstance: false }));
    m.name = 'kun-plumes'; m.frustumCulled = false;
    plumeData.mesh = m;
  }
  // 每根翎一个描边 ID：把翎号写进 toon 描边通道（vToonInst 只对实例有效，这里改用法线长度不变、ID 按翎号偏移）
  plumeMat.onBeforeCompile = (prev => sh => {
    prev(sh);
    sh.fragmentShader = sh.fragmentShader.replace('float toonId = fract( uObjectId * 0.7548776662 + vToonInst * uInstIdOn * 0.5698402910 + 0.137 );',
      'float toonId = fract( uObjectId * 0.7548776662 + vPl.z * 0.5698402910 + 0.137 );');
  })(plumeMat.onBeforeCompile);

  // ════════════════ 姿态 ════════════════
  const M = new THREE.Matrix4(), Mq = new THREE.Quaternion(), _v = new THREE.Vector3(), _n = new THREE.Vector3(), _e = new THREE.Euler();
  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m3 = new THREE.Matrix3();
  function poseBody(T) {
    const P = bPos.array, Nn = bNrm.array, NV_ = NV;
    const doRange = (i0, i1, x) => {
      sectionMatrix(x, T, M); _m3.setFromMatrix4(M);
      const e = M.elements, n3 = _m3.elements;
      for (let i = i0; i < i1; i++) {
        const k = i * 3, x0 = bRest[k], y0 = bRest[k + 1], z0 = bRest[k + 2];
        P[k] = e[0] * x0 + e[4] * y0 + e[8] * z0 + e[12];
        P[k + 1] = e[1] * x0 + e[5] * y0 + e[9] * z0 + e[13];
        P[k + 2] = e[2] * x0 + e[6] * y0 + e[10] * z0 + e[14];
        const a = bN0[k], b = bN0[k + 1], c = bN0[k + 2];
        Nn[k] = n3[0] * a + n3[3] * b + n3[6] * c; Nn[k + 1] = n3[1] * a + n3[4] * b + n3[7] * c; Nn[k + 2] = n3[2] * a + n3[5] * b + n3[8] * c;
      }
    };
    for (let j = 0; j < NU; j++) doRange(j * NV_, (j + 1) * NV_, ringX[j]);
    doRange(NU * NV_, NU * NV_ + 1, X_TAIL);         // 尾端封口
    doRange(NU * NV_ + 1, NU * NV_ + 2, X_SNOUT);    // 吻端封口
    bPos.needsUpdate = true; bNrm.needsUpdate = true;
  }
  // 截面变换作用在一个“静止局部矩阵”上
  const posed = (x, T, restM, out) => { sectionMatrix(x, T, M); return out.multiplyMatrices(M, restM); };

  function poseBarbels(T) {
    const g = barbels.mesh.geometry, P = g.attributes.position.array, Nn = g.attributes.normal.array;
    const pts = [], tg = new THREE.Vector3(), nx = new THREE.Vector3(), bx = new THREE.Vector3(), ref = new THREE.Vector3();
    barbels.forEach((b, bi) => {
      sectionMatrix(b.x0, T, M);
      pts.length = 0;
      for (let i = 0; i < BARB_N; i++) {
        const s = i / (BARB_N - 1), a = TAU * (T / 3.2) - s * 5.2 + bi * 0.9;
        const amp = Math.pow(s, 1.3);
        const p = b.rest[i].clone();
        p.x += amp * (9 * Math.sin(a) + 4 * Math.sin(2.1 * a + 1.0));
        p.z += b.side * amp * 7 * Math.sin(a + 1.4);
        p.y += amp * 4 * Math.cos(a);
        pts.push(p.applyMatrix4(M));
      }
      const base = bi * BARB_N * BARB_R;
      ref.set(0, 0, 1);
      for (let i = 0; i < BARB_N; i++) {
        const s = i / (BARB_N - 1), r = lerp(3.7, 0.8, Math.pow(s, 0.85));
        tg.subVectors(pts[Math.min(i + 1, BARB_N - 1)], pts[Math.max(i - 1, 0)]).normalize();
        nx.crossVectors(tg, ref).normalize(); if (nx.lengthSq() < 1e-6) nx.set(0, 1, 0);
        bx.crossVectors(tg, nx).normalize();
        for (let k = 0; k < BARB_R; k++) {
          const an = k / BARB_R * TAU, cs = Math.cos(an), sn = Math.sin(an);
          const vi = (base + i * BARB_R + k) * 3;
          const dx = nx.x * cs + bx.x * sn, dy = nx.y * cs + bx.y * sn, dz = nx.z * cs + bx.z * sn;
          P[vi] = pts[i].x + dx * r; P[vi + 1] = pts[i].y + dy * r; P[vi + 2] = pts[i].z + dz * r;
          Nn[vi] = dx; Nn[vi + 1] = dy; Nn[vi + 2] = dz;
        }
      }
    });
    g.attributes.position.needsUpdate = true; g.attributes.normal.needsUpdate = true;
  }

  const _fm = new THREE.Matrix4();
  function poseFlames(T) {
    for (let i = 0; i < flameRest.length; i++) {
      const f = flameRest[i];
      // 一点点自身摆动（一拍三）：绕卡片法线小角度
      posed(f.x, T, f.m, _fm);
      flames.setMatrixAt(i, _fm);
    }
    flames.instanceMatrix.needsUpdate = true;
  }

  function posePlumes(T) {
    const g = plumeData.mesh.geometry, P = g.attributes.position.array, Nn = g.attributes.normal.array;
    sectionMatrix(X_TAIL, T, M); _m3.setFromMatrix4(M);
    const cpos = [], tan = [];
    const w = new THREE.Vector3(), t = new THREE.Vector3(), nrm = new THREE.Vector3(), pn = new THREE.Vector3(), c = new THREE.Vector3();
    for (const d of plumeData) {
      const p = d.p, ds = p.L * 1.14 / PL_NA, qb = new THREE.Quaternion().setFromAxisAngle(AY, p.b * 2.2 * DEG);
      let x = 0, y = 0;
      cpos.length = 0; tan.length = 0;
      for (let i = 0; i <= PL_NA; i++) {
        const u = i / PL_NA;
        const wave = 0.32 * Math.pow(u, 1.2) * Math.sin(TAU * (T / BEND.period) * 1.0 - u * 4.2 + d.phase)
          + 0.08 * Math.pow(u, 2) * Math.sin(TAU * (T / 2.5) - u * 7.0 + d.phase * 1.7);
        const h = p.a * DEG * (1 - 0.4 * u) + 0.22 * Math.sin(Math.PI * 1.4 * u + d.phase) * u + 1.25 * p.cu * Math.pow(sstep(0.48, 1.0, u), 1.5) + wave;
        cpos.push(new THREE.Vector3(-x, y, 0).applyQuaternion(qb).add(d.root));
        tan.push(new THREE.Vector3(-Math.cos(h), Math.sin(h), 0).applyQuaternion(qb));
        x += Math.cos(h) * ds; y += Math.sin(h) * ds;
      }
      // 平面法线（翎面朝向）
      pn.set(0, 0, 1).applyQuaternion(qb);
      for (let i = 0; i <= PL_NA; i++) {
        const u = i / PL_NA;
        t.copy(tan[i]);
        // 翎面内的横向 = 平面法线 × 切线；沿长扭转
        w.crossVectors(pn, t).normalize();
        const tw = (p.oc && d.k % 2 ? Math.sign(p.tw) * Math.PI * sstep(0.08, 0.62, u) : p.tw * u) + 0.25 * Math.sin(TAU * T / BEND.period + u * 3 + d.phase) * u;
        _q.setFromAxisAngle(t, tw); w.applyQuaternion(_q);
        nrm.crossVectors(w, t).normalize();          // 与三角形绕序一致（正面法线 = 横向 × 切向）
        c.copy(cpos[i]).applyMatrix4(M);
        const wx = w.clone().applyMatrix3(_m3), nx = nrm.clone().applyMatrix3(_m3);
        for (let j = 0; j < PL_NC; j++) {
          const vn = -1 + 2 * j / (PL_NC - 1);
          // 锯齿边：边缘点按羽枝开裂收进去
          let hw = d.hw[i];
          if (Math.abs(vn) > 0.99) { const sw = (u * 26 + (vn > 0 ? 0.5 : 0) + d.phase) % 1; hw *= 1 - 0.16 * Math.pow(sw, 2.2) * sstep(0.1, 0.3, u); }
          const camber = 0.12 * hw * (1 - vn * vn);
          const vi = (d.base + i * PL_NC + j) * 3;
          P[vi] = c.x + wx.x * vn * hw + nx.x * camber; P[vi + 1] = c.y + wx.y * vn * hw + nx.y * camber; P[vi + 2] = c.z + wx.z * vn * hw + nx.z * camber;
          Nn[vi] = nx.x; Nn[vi + 1] = nx.y; Nn[vi + 2] = nx.z;
        }
      }
    }
    g.attributes.position.needsUpdate = true; g.attributes.normal.needsUpdate = true;
  }

  function poseWings(T, TW) {
    const ph = TW / U.uWingPeriod.value + o.flapPhase;
    const k = flapPose(ph);
    for (const w of wings) {
      const s = w.side;
      sectionMatrix(w.x0, T, M, Mq);
      w.pivot.position.copy(w.root).applyMatrix4(M);
      // 肩：截面旋转 · 上反角（绕 X）· 后掠（绕 Y）· 扭转（绕展向 Z）
      _q.copy(Mq);
      _q.multiply(_q2.setFromAxisAngle(AX, -s * k.th * DEG));
      _q.multiply(_q2.setFromAxisAngle(AY, -s * k.sw * DEG));
      _q.multiply(_q2.setFromAxisAngle(AZ, s * k.tw * DEG));
      w.pivot.quaternion.copy(_q);
      // 腕：掌相对臂再抬 / 压（绕 X），再后折（绕 Y）
      w.hand.quaternion.setFromAxisAngle(AX, -s * k.fx * DEG).multiply(_q2.setFromAxisAngle(AY, -s * k.fd * DEG));
    }
    return k;
  }

  const _inv = new THREE.Matrix4(), _tw = new THREE.Vector3(), _em = new THREE.Matrix4();
  function setPose(ts, po = {}) {
    const tw = po.wingT ?? ts;
    Object.assign(BEND, { amp: U.uKunAmp.value, wave: U.uKunWave.value, period: TAU / Math.max(U.uKunOmega.value, 1e-4), heaveP: U.uWingPeriod.value, heavePh: o.flapPhase });
    U.uKunT.value = ts; U.uWingT.value = tw;
    poseBody(ts);
    for (const e of eyes) { posed(EYE_X, ts, e.restM, _em); e.group.matrix.copy(_em); e.group.matrixWorldNeedsUpdate = true; }
    poseBarbels(ts);
    poseFlames(ts);
    posePlumes(ts);
    poseWings(ts, tw);
    const b = po.blink ?? autoBlink(ts, o.blinkPeriod, o.blinkOffset);
    for (const e of eyes) {
      const tu = e.mat.userData.toon;
      tu.uOpen.value = 1 - b;
      tu.uLook.value.set(0, 0);
      if (po.look) {
        group.updateWorldMatrix(true, false); e.group.updateWorldMatrix(false, false);
        _tw.copy(po.look).applyMatrix4(_inv.copy(e.group.matrixWorld).invert()).normalize();
        tu.uLook.value.set(clamp(_tw.x * e.side * 0.55, -0.24, 0.24), clamp(_tw.y * 0.4, -0.08, 0.1));
      }
    }
  }
  const eyeWorld = (target, ref) => pickEye(eyes, target, ref);
  // 主光阴影相机罩住鲲（含翅膀和尾翎）；光的方向不变。鲲移动后每帧调一次
  // 法线偏移 1.2（其它鲲是 1.5）：v1.0 起就是这个值，翅膀和尾翎薄，没再核对过改成 1.5 的效果；要统一先渲 ?test=kun_peng 对比
  const fitShadow = (light, { size = 4096, radius = 470 } = {}) => fitShadowTo(light, group, { center: [-45, 20, 0], radius, size, normalBias: 1.2 });
  setPose(0);
  return { group, setPose, eyeWorld, fitShadow, outlineMeshes, length: 600, eyeRadius: RE, wisps: [], uniforms: U, fins: [], wings, eyes, flapPose };
}
