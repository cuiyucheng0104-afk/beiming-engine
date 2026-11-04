// 鲲（三渲二配方第 1、2、4 层）：座头鲸比例，用简单几何体拼——身体沿脊柱放样（超椭圆截面），
// 胸鳍、尾鳍是翼型放样，眼睛是球 + 两片半球眼睑；背上用 MeshSurfaceSampler + InstancedMesh 散布
// 海藻团（相当于苔藓团）、飘带海草、珊瑚簇、扇贝、藤壶、海葵。
// 坐标：鲲局部空间，长约 600（米），头朝 +X，上为 +Y，原点在身体中心。
// 动画：setPose(ts) 的 ts 由调用方量化（一拍三：f = Math.round(t*24); ts = Math.floor(f/3)*3/24，用帧号算，避免 t*8 的浮点误差）。
//       脊柱波动在 GPU 顶点着色器里做，
//       身体、尾鳍逐顶点弯；实例化装饰按实例原点整体跟着弯（改写 instanceMatrix），阴影深度材质同步形变。
// 确定性：所有随机来自 mulberry(固定种子)，噪声来自固定种子的单纯形噪声（engine/core/noise.js）；没有 Date.now / Math.random。
import * as THREE from 'three';
import { createNoise3D } from '../engine/core/noise.js';
import { mulberry, clamp, lerp, ss, seg, TAU } from '../engine/core/math.js';
import { profileBody, sideAngle, axisStations, ringsAt, loftRings, loftWing } from '../engine/form/loft.js';
import { pitchWave } from '../engine/form/bend.js';
import { clump, barnacle, scallop, flowerHead, branchCoral, dome } from '../engine/form/props.js';
import { blade } from '../engine/form/plants.js';
import { samplersOn, placeOnSurface as place, pickFrom as pick, instanced } from '../engine/form/scatter.js';
import { autoBlink, poseEyes, pickEye, mountEyes, lidShells, eyeFrame } from '../engine/form/eye.js';
import { taperTube } from '../engine/form/curves.js';
import { makeToonMaterial, bindToon, PALETTE, TOON_PRESETS, TOON_SHARED, tintFrom } from './toon.js';

const sstep = (a, b, x) => ss(seg(x, a, b));

// ───────────────────────── 身体轮廓（x：-262 尾柄末端 … +300 吻端） ─────────────────────────
const PX = [-262, -240, -200, -150, -90, -30, 40, 110, 170, 215, 250, 275, 292, 300];
const PT = [6.5, 10, 17, 29, 43, 51, 54, 51, 44, 36, 27, 18, 10, 3];              // 顶线 y
const PB = [-6, -9.5, -16, -27, -40, -51, -59, -63, -61, -54, -43, -32, -20, -9];  // 底线 y
const PW = [5.5, 8, 14, 25, 39, 49, 55, 57, 55, 50, 44, 36, 25, 9];               // 半宽 z
export const X_TAIL = -262, X_SNOUT = 300;

// 背鳍（前缓后陡）+ 背鳍后面一串小骨节
function ridge(x) {
  let r = 0;
  if (x > -88 && x < -18) r += 12 * Math.pow(1 - (x + 88) / 70, 1.6);
  else if (x <= -88 && x > -106) r += 12 * Math.pow(1 - (-88 - x) / 18, 0.8);
  for (let k = 0; k < 6; k++) { const xk = -120 - k * 17; r += (2.8 - k * 0.32) * Math.exp(-Math.pow((x - xk) / 4.5, 2)); }
  return r;
}
// 嘴线（从侧面水平线量起的角度，向上为正；两侧对称）
const mouthPhi = x => lerp(-0.66, -0.30, sstep(299, 240, x)) + 0.12 * sstep(240, 226, x);

// 放样体（未弯曲）：超椭圆截面 + 背鳍骨节 + 嘴线台阶。phi：0 = +Z 侧水平，π/2 = 背中线
export const body = profileBody({
  xs: PX, top: PT, bottom: PB, width: PW, exp: [2.25, 2.75],
  deform(p) {
    if (p.s > 0) p.y += ridge(p.x) * Math.pow(p.s, 18);
    // 下颌比上颌略宽一点：嘴线以下往外推，嘴线处形成台阶（描边能抓到）
    if (p.x > 200) {
      const ph = sideAngle(p.c, p.s), pm = mouthPhi(p.x);
      const step = (1 - sstep(pm - 0.05, pm + 0.05, ph)) * sstep(200, 228, p.x) * sstep(301, 290, p.x) * sstep(-1.45, -1.0, ph);
      const k = 1 + 0.035 * step;
      p.z *= k; p.y = p.yc + (p.y - p.yc) * k;
    }
  },
});
const { top: fT, bottom: fB, width: fW, point: bodyPoint, normal: bodyNormal } = body;

function buildBody(NU, NV) {
  const xs = axisStations(X_TAIL, X_SNOUT - 0.4, NU), loft = [];   // 两端加密
  for (const x of xs) for (let k = 0; k < NV; k++) { const phi = k / NV * TAU; loft.push(x, Math.cos(phi), Math.sin(phi)); }
  return loftRings(ringsAt(bodyPoint, xs, NV), {
    startCap: { p: new THREE.Vector3(X_TAIL - 0.8, body.mid(X_TAIL), 0), attr: { aLoft: [X_TAIL, 0, 0] } },
    endCap: { p: new THREE.Vector3(X_SNOUT + 0.2, body.mid(X_SNOUT), 0), attr: { aLoft: [X_SNOUT, 0, 0] } },
    attrs: { aLoft: { data: loft, size: 3 } },
  });
}

// 翼型放样（胸鳍、尾鳍）：aChord = 弦向位置
const buildWing = o => loftWing({ ...o, attrs: { aChord: { size: 1, at: (t, cp) => [cp], start: [0.5], end: [0.5] } } });

// 胸鳍平面形（座头鲸：细长、前缘一串疙瘩、向后弯）
export const FIN_SPAN = 172;
function finPlan(t) {
  const s = t * FIN_SPAN;
  let c = 44 * (1 - 0.66 * sstep(0.1, 0.92, t));
  if (t > 0.84) c *= Math.sqrt(Math.max(0.0004, 1 - Math.pow((t - 0.84) / 0.16, 2)));
  const bumps = 2.4 * Math.pow(Math.abs(Math.sin(Math.PI * t * 10.5)), 0.55) * sstep(0.08, 0.2, t) * (1 - sstep(0.9, 1, t));
  const le = 14 - 0.1 * s - 22 * t * t + bumps;
  return { c, le, th: Math.max(0.6, 0.19 * c), y: -9 * t * t, camber: 2.2 * (1 - t * 0.7) };   // 弦向弯度：卡通分档会在鳍面切出亮 / 暗两块
}
// 尾鳍平面形（前缘后掠、后缘中间有缺口、后缘锯齿、尖端尖）
export const FLUKE_S = 104;
function flukePlan(t) {
  const a = Math.abs(t);
  const le = -244 - 36 * a * a;
  let c = 46 * (1 - Math.pow(a, 1.7)) + 2;
  c -= 9 * Math.exp(-Math.pow(a / 0.07, 2));                                  // 中缝缺口
  c += 1.4 * Math.pow(Math.abs(Math.sin(Math.PI * a * 8)), 0.6) * sstep(0.12, 0.3, a) * (1 - sstep(0.85, 1, a));   // 后缘锯齿
  return { c, le, th: Math.max(0.5, 0.15 * c), y: 0.6 + 5 * a * a, camber: 0 };
}

// 胸鳍根部与基向量（kun_refine.js 共用）：根在 x=150、侧腹偏下，嵌进身体 8 米；
// 鳍的局部基：X 前缘方向，Z 展向（向外、向后、向下），Y = Z × X
export function finMount(side) {
  const phR = -0.5, x0 = 150, ph0 = side > 0 ? phR : Math.PI - phR;
  const root = bodyPoint(x0, ph0), nrm = bodyNormal(x0, ph0);
  root.addScaledVector(nrm, -8);
  const out = new THREE.Vector3(0, nrm.y * 0.3, nrm.z).normalize();
  const spanDir = out.clone().multiplyScalar(Math.cos(0.5)).add(new THREE.Vector3(-Math.sin(0.5), 0, 0)).add(new THREE.Vector3(0, -0.24, 0)).normalize();
  const zAxis = spanDir.clone().multiplyScalar(side);   // 几何展向是 side·Z
  let xAxis = new THREE.Vector3(1, 0.08, 0);
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
  const baseQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
  return { root, baseQ, x0 };
}
// 眼睑材质参数：睑缘一道墨线 + 两道褶（kun_refine.js 共用）
export const LID = { patchScale: 0.08, spotScale: 5, rustAmt: 0.6, algaeAmt: 0.3, cityAmt: 0.55, side: THREE.DoubleSide,
  fragmentAlbedo: /* glsl */`
    {
      vec3 d = normalize( vToonObj );
      float e = asin( clamp( abs( d.y ), 0.0, 1.0 ) ), fe = max( fwidth( e ), 1e-5 );
      float front = smoothstep( 0.15, 0.55, d.z );
      float rim = 1.0 - smoothstep( 0.07 - fe, 0.07 + fe, e );
      float fold = ( 1.0 - smoothstep( 0.8 * fe, 1.9 * fe, abs( e - 0.36 ) ) ) * smoothstep( 0.35, 0.7, d.z );
      float fold2 = ( 1.0 - smoothstep( 0.8 * fe, 1.9 * fe, abs( e - 0.66 ) ) ) * smoothstep( 0.5, 0.8, d.z ) * step( 0.0, d.y );
      toonInk = max( toonInk, max( rim * front * 0.85, max( fold * 0.75, fold2 * 0.55 ) ) );
    }` };

// ───────────────────────── 装饰几何（单位尺寸，实例矩阵再缩放） ─────────────────────────
// 海葵：短柱 + 十二根触手的盘（俯看像一朵小白花）
const geoAnemone = () => flowerHead({
  disc: { rings: 5, segs: 72, lobes: 6, base: 0.42, amp: 0.58, sharp: 1.4, height: r => 0.42 + 0.3 * r * r - 0.12 * Math.pow(r, 4) },
  stalk: { r0: 0.26, r1: 0.34, h: 0.45, y: 0.22 }, bud: { r: 0.17, y: 0.5 },
});

// ───────────────────────── 弯曲（GLSL 与 JS 一致）：竖向行波，身体、尾鳍逐顶点弯，实例按原点整体弯 ─────────────────────────
const WAVE = pitchWave('kun', { e0: 0.22, sMax: 1.15 });
const bendHooks = WAVE.hooks;
const CATCH = [[-0.27, 0.24, 0.93, 0.9835], [0.26, -0.2, 0.94, 0.9966]];   // 眼珠高光（眼窝坐标，左上一大、右下一小）

// ───────────────────────── 主体 ─────────────────────────
/**
 * createKun(opts) → { group, setPose(ts, o), eyeWorld(target, ref), fitShadow(light, o), outlineMeshes, length, eyeRadius, wisps, uniforms, fins, eyes }
 * opts.lod   0.1–1：实例数和网格密度的倍率（大远景 0.35–0.5；低 LOD 时单个装饰自动放大，覆盖面积不变）
 * opts.seed  散布种子（默认 20261103）
 * opts.wisps 鳍尖云丝（默认 true）
 * opts.blinkPeriod / blinkOffset：自动眨眼的周期 / 首次时刻（秒，默认 4 / 1.5）
 * setPose(ts, { blink, look })：blink 0 睁 → 1 闭（不给就按周期自动眨）；look 为世界坐标 Vector3，眼珠转向它（限幅 ±20°/±16°）
 * eyeWorld(target, ref)：ref = 相机位置（取近的那只眼）/ 1（+Z 侧）/ -1（-Z 侧，默认）
 * fitShadow(light, { size })：把主光阴影相机罩到鲲身上（方向不变），鲲移动后每帧调一次
 * uniforms.uKunAmp / uKunWave / uKunOmega：脊柱波幅（米）/ 波数 / 角频率，可运行时改
 */
export function createKun(opts = {}) {
  const o = { lod: 1, seed: 20261103, wisps: true, blinkPeriod: 4, blinkOffset: 1.5, ...opts };
  const lod = clamp(o.lod, 0.1, 1);
  const N = n => Math.max(4, Math.round(n * lod));
  const LS = 1 / Math.sqrt(Math.max(lod, 0.2));     // 低 LOD：数量少、单个大，覆盖面积不变
  const R = mulberry(o.seed);
  const noise = createNoise3D(mulberry(o.seed + 11));
  const noise2 = createNoise3D(mulberry(o.seed + 23));

  const U = {
    uKunT: { value: 0 }, uKunAmp: { value: 15 }, uKunWave: { value: 0.8 }, uKunOmega: { value: TAU / 5 }, uKunHalfL: { value: 300 },
  };
  const group = new THREE.Group(); group.name = 'kun';
  const outlineMeshes = [];
  const add = (parent, mesh) => { parent.add(mesh); if (mesh.userData.outline) outlineMeshes.push(mesh); return mesh; };
  const toon = (preset, extra = {}) => makeToonMaterial({ ...TOON_PRESETS[preset], ...extra, uniforms: { ...U, ...(extra.uniforms || {}) } });

  // —— 眼睛参数（两侧对称）——
  const EYE_X = 214, EYE_PH = 0.05, RE = 12;
  const eyeSecR = ((fT(EYE_X) - fB(EYE_X)) / 2 + fW(EYE_X)) / 2;

  // —— 身体 ——
  const NU = Math.round(lerp(90, 230, lod)), NV = Math.round(lerp(56, 128, lod)) & ~1;
  const bodyGeo = buildBody(NU, NV);
  const BELLY = '#9a9cc8';
  const bodyMat = toon('kun', {
    patchScale: 0.019, spotScale: 12, spotAmt: 0.55, spotThr: 0.56,
    uniforms: {
      uKunEye: { value: new THREE.Vector4(EYE_X, EYE_PH, RE, eyeSecR) },
      uPleatN: { value: 26 },
      uKunBellyTint: { value: tintFrom(PALETTE.kunBase, BELLY) },
    },
    ...bendHooks({ extraPars: 'attribute vec3 aLoft;\nvarying vec3 vLoft;\n', extraBegin: 'vLoft = aLoft;' }),
    fragmentPars: 'varying vec3 vLoft;\nuniform vec4 uKunEye;\nuniform float uPleatN;\nuniform vec3 uKunBellyTint;\n',
    fragmentAlbedo: /* glsl */`
    {
      float x = vLoft.x;
      float phi = atan( vLoft.z, vLoft.y );
      float ph = vLoft.y >= 0.0 ? phi : ( phi >= 0.0 ? 3.14159265 - phi : -3.14159265 - phi );
      // 手绘抖动：画线用的坐标按墨线时钟（一拍二）轻微扰动，线会“呼吸”
      vec3 jq = vec3( x * 0.06, ph * 4.0, uInkTime * 0.731 );
      float jx = toonNoise( jq ) * 0.6, jp = toonNoise( jq + 19.1 ) * 0.0035;
      // 白腹（座头鲸）：腹侧往浅薰衣草色走
      float belly = toonSS( -0.2, -0.7, ph ) * smoothstep( -60.0, 40.0, x );
      diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uKunBellyTint, belly * 0.9 );
      float fwp = max( fwidth( ph ), 1e-5 );
      // 嘴线
      float pm = mix( -0.66, -0.30, smoothstep( 299.0, 240.0, x ) ) + 0.12 * smoothstep( 240.0, 226.0, x );
      float mouth = ( 1.0 - smoothstep( 0.9 * fwp, 2.1 * fwp, abs( ph + jp * 1.5 - pm ) ) ) * toonSS( 300.5, 297.0, x ) * smoothstep( 224.0, 229.0, x );
      toonInk = max( toonInk, mouth );
      // 腹部褶沟：从下巴到肚脐，越往后越收拢
      float beta = ph + 1.5707963;
      float psi = min( mix( 0.4, 1.02, smoothstep( -30.0, 160.0, x ) ), pm + 1.5707963 - 0.05 );
      float q = beta / psi * ( uPleatN * 0.5 ) + toonNoise( jq * vec3( 0.6, 1.0, 1.0 ) + 7.7 ) * 0.07;
      float fq = max( fwidth( q ), 1e-5 );
      float dq = abs( fract( q + 0.5 ) - 0.5 );
      float inSec = ( 1.0 - smoothstep( 0.9, 1.0, beta / psi ) ) * smoothstep( -32.0, 8.0, x ) * toonSS( 297.0, 272.0, x );
      float pleat = ( 1.0 - smoothstep( 0.7 * fq, 1.7 * fq, dq ) ) * inSec;
      diffuseColor.rgb *= 1.0 - 0.07 * step( 0.5, fract( q * 0.5 ) ) * inSec;
      toonInk = max( toonInk, pleat * 0.6 );
      // 眼周皱纹
      vec2 de = vec2( x + jx - uKunEye.x, ( ph + jp - uKunEye.y ) * uKunEye.w );
      float rr = length( de ) / uKunEye.z + 0.07 * toonNoise( vec3( de * 0.22, 3.0 ) );
      float fr = max( fwidth( rr ), 1e-5 );
      float up = de.y / max( length( de ), 1e-3 );
      float side = de.x / max( length( de ), 1e-3 );
      float arc1 = ( 1.0 - smoothstep( 0.9 * fr, 2.0 * fr, abs( rr - 1.32 ) ) ) * smoothstep( 0.05, 0.45, up ) * toonSS( 0.85, 0.55, abs( side ) );
      float arc2 = ( 1.0 - smoothstep( 0.9 * fr, 2.0 * fr, abs( rr - 1.62 ) ) ) * smoothstep( 0.35, 0.8, up ) * toonSS( 0.6, 0.3, abs( side + 0.15 ) );
      float arc3 = ( 1.0 - smoothstep( 0.9 * fr, 2.0 * fr, abs( rr - 1.25 ) ) ) * toonSS( -0.35, -0.8, up ) * toonSS( 0.7, 0.4, abs( side ) );
      toonInk = max( toonInk, max( arc1, max( arc2 * 0.8, arc3 * 0.7 ) ) );
    }`,
  });
  const body = add(group, bindToon(new THREE.Mesh(bodyGeo, bodyMat), bodyMat));
  body.name = 'kun-body'; body.frustumCulled = false;

  // —— 尾鳍（逐顶点弯曲）——
  const finHook = { vertexPars: 'attribute float aChord;\nvarying float vNy;\nvarying float vChord;\n', vertexBegin: 'vNy = normal.y; vChord = aChord;',
    fragmentPars: 'uniform vec3 uFinPale;\nvarying float vNy;\nvarying float vChord;\n',
    fragmentAlbedo: /* glsl */`
      {
        float fc = max( fwidth( vChord ), 1e-4 );
        float lead = 1.0 - smoothstep( 0.2 - fc, 0.2 + fc, vChord + toonNoise( vToonObj * 0.12 ) * 0.06 );   // 前缘一条浅色带
        float pale = max( ( 1.0 - smoothstep( -0.35, 0.1, vNy ) ) * 0.6, lead * 0.75 );
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uFinPale, pale );
      }` };
  const flukeGeo = buildWing({ nS: N(70) + 24, nC: 28, span0: -FLUKE_S, span1: FLUKE_S, plan: t => flukePlan(2 * t - 1) });
  const flukeMat = toon('kun', { side: THREE.DoubleSide, patchScale: 0.05, spotScale: 6, rustAmt: 0.7, uniforms: { uFinPale: { value: tintFrom(PALETTE.kunBase, BELLY) } },
    ...bendHooks({ extraPars: finHook.vertexPars, extraBegin: finHook.vertexBegin }), fragmentPars: finHook.fragmentPars, fragmentAlbedo: finHook.fragmentAlbedo });
  const flukes = add(group, bindToon(new THREE.Mesh(flukeGeo, flukeMat), flukeMat));
  flukes.name = 'kun-flukes'; flukes.frustumCulled = false;
  // buildWing 的 t 是 0..1 展向参数；尾鳍是对称的，用 t' = 2t-1
  function flukeAt(t) { return flukePlan(t); }

  // —— 胸鳍（刚体，CPU 摆位）——
  const fins = [];
  const finMatBase = { side: THREE.DoubleSide, patchScale: 0.05, spotScale: 10, spotAmt: 0.5, rustAmt: 0.7, cityAmt: 0.6, uniforms: { uFinPale: { value: tintFrom(PALETTE.kunBase, BELLY) } } };
  for (const side of [1, -1]) {
    const geo = buildWing({ nS: N(64) + 20, nC: 26, span0: 0, span1: side * FIN_SPAN, plan: t => finPlan(t) });
    const mat = toon('kun', { ...finMatBase, vertexPars: finHook.vertexPars, vertexBegin: finHook.vertexBegin, fragmentPars: finHook.fragmentPars, fragmentAlbedo: finHook.fragmentAlbedo });
    const pivot = new THREE.Group(); pivot.name = 'kun-fin-' + (side > 0 ? 'R' : 'L');
    const mesh = add(pivot, bindToon(new THREE.Mesh(geo, mat), mat)); mesh.frustumCulled = false;
    const { root, baseQ, x0 } = finMount(side);
    fins.push({ side, pivot, mesh, root, baseQ, x0 });
    group.add(pivot);
  }

  // —— 眼睛 ——
  const makeSclera = () => makeToonMaterial({ ...TOON_PRESETS.anemone, color: '#e6dccd', shade1: '#a49ab4', shade2: '#6a6488', rimAmt: 0.6, cityAmt: 0.8, cityFlat: 0.35,
    uniforms: {
      uIrisA: { value: 0.6 }, uPupilA: { value: 0.25 },
      uIrisCol: { value: new THREE.Color('#252a5e') }, uIrisCol2: { value: new THREE.Color('#4f7fa8') }, uRingCol: { value: new THREE.Color(PALETTE.apricot) }, uPupilCol: { value: new THREE.Color('#121428') },
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
      // 瞳孔：横向椭圆（动物感）
      float pa = length( vec2( atan( d.x, d.z ) * 0.86, atan( d.y, d.z ) * 1.1 ) );
      float fp = max( fwidth( pa ), 1e-5 );
      float pupil = 1.0 - smoothstep( uPupilA - fp, uPupilA + fp, pa );
      float collar = smoothstep( uIrisA - 0.085 - fa, uIrisA - 0.085 + fa, ang ) * iris;           // 虹膜外缘一圈杏色
      float az = atan( d.y, d.x );
      float stri = 0.5 + 0.5 * sin( az * 26.0 + toonNoise( d * 7.0 ) * 3.0 );
      float rad = smoothstep( uPupilA, uIrisA, ang );
      vec3 ic = mix( uIrisCol2, uIrisCol, smoothstep( 0.35, 0.75, rad ) );               // 里浅外深
      ic = mix( ic, ic * 0.72, step( 0.6, stri ) * rad );                                 // 放射纹
      ic = mix( ic, uRingCol, collar );
      diffuseColor.rgb = mix( diffuseColor.rgb, ic, iris );
      diffuseColor.rgb = mix( diffuseColor.rgb, uPupilCol, pupil );
      toonInk = max( toonInk, ( 1.0 - smoothstep( 0.7 * fa, 2.2 * fa, abs( ang - uIrisA ) ) ) * 0.95 );
      toonInk = max( toonInk, ( 1.0 - smoothstep( 0.7 * fp, 1.8 * fp, abs( pa - uPupilA ) ) ) * 0.4 );
      float c1 = dot( d, uCatch1.xyz ), c2 = dot( d, uCatch2.xyz );
      float fc = max( fwidth( c1 ), 1e-5 );
      float k = max( smoothstep( uCatch1.w - fc, uCatch1.w + fc, c1 ), smoothstep( uCatch2.w - fc, uCatch2.w + fc, c2 ) );
      // 上眼睑下沿的睫毛阴影带（中间粗、两头细），下眼睑上沿一道细线
      float du = dot( d, uLidU ), dl = dot( d, uLidL ), fd = max( fwidth( du ), 1e-5 );
      float front = smoothstep( 0.1, 0.6, d.z );
      float lash = ( 1.0 - smoothstep( 0.1 * front + 0.02 - fd, 0.1 * front + 0.02 + fd, - du ) ) * front;
      float low = ( 1.0 - smoothstep( 0.03 - fd, 0.03 + fd, - dl ) ) * front;
      toonInk = max( toonInk, max( lash * 0.92, low * 0.6 ) );
      // 天空倒影：眼珠上半一道淡薰衣草色弧（固定在眼窝坐标，用上眼睑法线近似“上方”）
      float refl = smoothstep( -0.5, -0.4, du ) * ( 1.0 - smoothstep( -0.3, -0.22, du ) ) * smoothstep( 0.35, 0.75, d.z ) * iris * ( 1.0 - pupil );
      toonOverlay = vec4( uReflCol, refl * 0.3 );
      toonOverlay = mix( toonOverlay, vec4( uCatchCol, 1.0 ), k * ( 1.0 - lash ) );
    }`,
  });
  const lidMat = toon('kun', { objectId: bodyMat.userData.toon.uObjectId.value, ...LID });
  const eyes = mountEyes({ point: bodyPoint, normal: bodyNormal, x: EYE_X, ph: EYE_PH, inset: 0.6 * RE, gaze: [0.22, -0.12], parent: group, build: (side, eg) => {
    eg.name = 'kun-eye-' + (side > 0 ? 'R' : 'L');
    const scleraMat = makeSclera();
    const ball = add(eg, bindToon(new THREE.Mesh(new THREE.SphereGeometry(RE, 48, 32), scleraMat), scleraMat, { castShadow: false }));
    const lidU = new THREE.Group(), lidL = new THREE.Group(), [shellU, shellL] = lidShells(RE * 1.07, 40, 12);
    add(lidU, bindToon(new THREE.Mesh(shellU, lidMat), lidMat));
    add(lidL, bindToon(new THREE.Mesh(shellL, lidMat), lidMat));
    eg.add(lidU, lidL);
    return { ball, lidU, lidL, mat: scleraMat, frame: eyeFrame(scleraMat.userData.toon) };
  } });

  // —— 散布：在未弯曲的身体上建权重，MeshSurfaceSampler 采样 ——
  const pAttr = bodyGeo.attributes.position, nAttr = bodyGeo.attributes.normal, lAttr = bodyGeo.attributes.aLoft;
  const nv = pAttr.count;
  const W = { wWeed: new Float32Array(nv), wKelp: new Float32Array(nv), wCoral: new Float32Array(nv), wShell: new Float32Array(nv), wBarn: new Float32Array(nv), wFlower: new Float32Array(nv) };
  const eyeC = eyes.map(e => e.group.position);
  const P = new THREE.Vector3(), Nn = new THREE.Vector3();
  for (let i = 0; i < nv; i++) {
    P.fromBufferAttribute(pAttr, i); Nn.fromBufferAttribute(nAttr, i);
    const x = P.x, ph = sideAngle(lAttr.getY(i), lAttr.getZ(i));
    const patch = noise(P.x * 0.014, P.y * 0.014, P.z * 0.014) + 0.45 * noise(P.x * 0.04 + 7, P.y * 0.04, P.z * 0.04);
    const xr = sstep(232, 190, x) * sstep(-238, -178, x);
    const nearEye = Math.min(...eyeC.map(c => c.distanceTo(P))) / RE;
    const eyeKeep = sstep(2.6, 3.4, nearEye);
    // 海藻：背上成片，并沿两肋往下爬（仰拍时侧缘能看见一圈绿边）
    const weedUp = sstep(-0.3, 0.3, Nn.y);
    W.wWeed[i] = weedUp * xr * sstep(-0.12, 0.25, patch + 0.25 * Nn.y) * eyeKeep;
    W.wKelp[i] = sstep(-0.12, 0.42, Nn.y) * xr * sstep(-0.05, 0.3, patch + 0.2 * Nn.y) * eyeKeep;
    W.wFlower[i] = weedUp * xr * sstep(0.0, 0.28, patch) * (0.4 + 0.6 * sstep(-0.2, 0.4, noise2(P.x * 0.06, P.y * 0.06, P.z * 0.06)));
    const cn = noise2(P.x * 0.012 + 40, P.y * 0.012, P.z * 0.012);
    W.wCoral[i] = sstep(-0.35, 0.3, Nn.y) * sstep(222, 170, x) * sstep(-205, -150, x) * sstep(0.18, 0.45, cn) * eyeKeep;
    W.wShell[i] = sstep(-0.55, 0.2, Nn.y) * sstep(252, 205, x) * sstep(-232, -165, x) * (0.25 + sstep(0.0, 0.4, patch)) * eyeKeep;
    // 藤壶：座头鲸式成簇——下巴尖、下颌、喉部前段、吻侧；身上零星
    const bc = noise2(P.x * 0.035 + 90, P.y * 0.035, P.z * 0.035) + 0.5 * noise(P.x * 0.1, P.y * 0.1 + 50, P.z * 0.1);
    const pm = mouthPhi(x);
    const chinTip = sstep(258, 292, x) * sstep(-0.05, -0.75, ph);
    const jaw = sstep(205, 245, x) * sstep(0.32, 0.08, Math.abs(ph - (pm - 0.22)));
    const throat = sstep(140, 220, x) * sstep(-0.55, -1.25, ph) * 0.7;
    const rostrum = sstep(248, 292, x) * sstep(0.15, 0.5, ph) * sstep(1.25, 1.0, ph) * 0.6;
    const mouthKeep = sstep(0.04, 0.1, Math.abs(ph - pm));
    W.wBarn[i] = (chinTip * 3 + jaw * 1.6 + throat + rostrum + 0.06) * sstep(0.12, 0.42, bc) * sstep(2.2, 2.7, nearEye) * mouthKeep * sstep(-255, -230, x);
  }
  const sampler = samplersOn(bodyGeo, W);
  const inst = (geo, mat, items, name, attrs) => instanced(geo, mat, items, name, { attrs, bind: bindToon });
  const _q = new THREE.Quaternion();
  const tp = new THREE.Vector3(), tn = new THREE.Vector3();

  // 海藻团：一团团重叠的小球，亮黄绿 + 深绿
  const WEED = ['#8db36a', '#9cc06e', '#7fa65c', '#a8c77a', '#86ae6a', '#93b565', '#b3cf7e'];
  const clumps = [], sW = sampler('wWeed', o.seed + 101);
  for (let i = 0; i < N(2100); i++) {
    sW.sample(tp, tn);
    const r = (3.4 + Math.pow(R(), 1.5) * 7.5) * LS;
    clumps.push({ m: place(tp, tn, { yaw: R() * TAU, scale: new THREE.Vector3(r * (0.9 + R() * 0.3), r * (0.7 + R() * 0.4), r * (0.9 + R() * 0.3)), sink: r * 0.38 }), c: pick(R(), WEED) });
  }
  add(group, inst(clump(), toon('seaweed', { outlineW: 0.45, instanceId: false, ...bendHooks() }), clumps, 'kun-weed-clumps'));

  // 飘带海草（一拍三摆动）：aSway.xyz = 局部空间里的“向后”方向 ×（带长/带宽），w = 相位
  const KELP = ['#7fa65c', '#8db36a', '#6e9a5c', '#9ab86a', '#76a060', '#a3bf72'];
  const kelps = [], swayArr = [], sK = sampler('wKelp', o.seed + 202);
  const back = new THREE.Vector3(-1, 0, 0);
  for (let i = 0; i < N(1050); i++) {
    sK.sample(tp, tn);
    const h = 11 + Math.pow(R(), 1.2) * 22, w = (3.2 + R() * 3.6) * Math.sqrt(LS);
    const lean = back.clone().multiplyScalar(0.3 + R() * 0.3);
    const m = place(tp, tn, { yaw: R() * TAU, scale: new THREE.Vector3(w, h, w), sink: 1.5, lean });
    kelps.push({ m, c: pick(R(), KELP) });
    _q.setFromRotationMatrix(new THREE.Matrix4().extractRotation(m)).invert();
    const lb = back.clone().applyQuaternion(_q); lb.y = 0; if (lb.lengthSq() < 1e-6) lb.set(1, 0, 0); lb.normalize().multiplyScalar(h / w);
    swayArr.push(lb.x, lb.y, lb.z, R() * TAU);
  }
  const kelpMat = toon('seaweed', {
    side: THREE.DoubleSide, edgeNoise: 0.02, dabAmt: 0.1, outlineW: 0.8,
    ...bendHooks({
      extraPars: 'attribute vec4 aSway;\n',
      extraBegin: /* glsl */`
      {
        float hg = clamp( position.y, 0.0, 1.0 );
        float h2 = hg * hg;
        float sl = length( aSway.xyz );
        vec3 sd = normalize( cross( aSway.xyz, vec3( 0.0, 1.0, 0.0 ) ) + vec3( 1e-4 ) ) * sl;
        transformed += aSway.xyz * ( 0.3 + 0.14 * sin( uKunT * 1.9 + aSway.w ) ) * h2 * 0.9;
        transformed += sd * sin( uKunT * 2.6 + aSway.w * 1.3 - hg * 2.4 ) * 0.2 * h2;
        transformed.y -= 0.12 * h2;
      }`,
    }),
  });
  add(group, inst(blade(), kelpMat, kelps, 'kun-kelp', { aSway: new THREE.InstancedBufferAttribute(new Float32Array(swayArr), 4) }));

  // 海葵（= 小白花）：一部分顶在海藻团上
  const FLW = [PALETTE.anemone, '#fbe6ec', '#ffeedd', '#f4f0ff', '#ffe2d0'];
  const flowers = [], sF = sampler('wFlower', o.seed + 303);
  for (let i = 0; i < N(1300); i++) {
    sF.sample(tp, tn);
    const s = (1.5 + R() * 1.8) * Math.sqrt(LS);
    const lift = R() < 0.65 ? (3 + R() * 6) * LS : 0;
    flowers.push({ m: place(tp.clone().addScaledVector(tn, lift), tn, { yaw: R() * TAU, scale: new THREE.Vector3(s, s * (0.8 + R() * 0.5), s), sink: 0.2 }), c: pick(R(), FLW) });
  }
  add(group, inst(geoAnemone(), toon('anemone', { outlineW: 0.6, ...bendHooks() }), flowers, 'kun-anemones'));

  // 珊瑚簇：鹿角珊瑚 + 扇形珊瑚
  const COR = [PALETTE.coral, '#f59a84', '#e86a80', '#f4a6a0', '#f7b07a'];
  const FAN = ['#e86a80', PALETTE.coral, '#d9607e', '#f28c6e'];
  const corals = [], fans = [], sC = sampler('wCoral', o.seed + 404);
  for (let i = 0; i < N(130); i++) {
    sC.sample(tp, tn);
    const s = 11 + R() * 15;
    if (R() < 0.6) corals.push({ m: place(tp, tn, { yaw: R() * TAU, scale: new THREE.Vector3(s, s * (0.8 + R() * 0.5), s), sink: 1 }), c: pick(R(), COR) });
    else fans.push({ m: place(tp, tn, { yaw: R() * TAU, scale: new THREE.Vector3(s * 1.2, s * (0.9 + R() * 0.4), s * 1.2), sink: 1, lean: back.clone().multiplyScalar(0.15) }), c: pick(R(), FAN) });
  }
  add(group, inst(branchCoral(o.seed + 1), toon('coral', { outlineW: 0.85, ...bendHooks() }), corals, 'kun-corals'));
  add(group, inst(branchCoral(o.seed + 2, { fan: true }), toon('coral', { outlineW: 0.85, ...bendHooks() }), fans, 'kun-fan-corals'));

  // 扇贝
  const SHL = ['#f2dccb', PALETTE.barnacle, '#f3c3b5', '#d8c7de', '#f6d3a8'];
  const shells = [], sS = sampler('wShell', o.seed + 505);
  for (let i = 0; i < N(320); i++) {
    sS.sample(tp, tn);
    const s = 2.6 + R() * 4.2;
    shells.push({ m: place(tp, tn, { yaw: R() * TAU, scale: new THREE.Vector3(s, s, s), sink: 0.3 }), c: pick(R(), SHL) });
  }
  add(group, inst(scallop(), toon('shell', { side: THREE.DoubleSide, outlineW: 0.7, ...bendHooks() }), shells, 'kun-shells'));

  // 藤壶：身体成簇 + 眼圈 + 尾鳍边缘。口内（局部半径 < 0.45、高度 < 0.66）压暗
  const BAR = [PALETTE.barnacle, '#dccfc0', '#efe6d6', '#e2d6cf', '#f1e4cf'];
  const barnHooks = {
    fragmentPars: 'varying vec3 vLocal;\n',
    fragmentAlbedo: /* glsl */`
      {
        float rr = length( vLocal.xz ), ang = atan( vLocal.z, vLocal.x );
        float crater = ( 1.0 - smoothstep( 0.37, 0.45, rr ) ) * step( vLocal.y, 0.665 );
        float plate = abs( fract( ang * 0.9549297 + 0.2 * sin( ang * 2.0 ) ) - 0.5 );     // 6 块壳板
        float fp = max( fwidth( plate ), 1e-4 );
        float seam = ( 1.0 - smoothstep( 0.04 - fp, 0.04 + fp, plate ) ) * ( 1.0 - crater ) * smoothstep( 0.05, 0.25, vLocal.y );
        diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.36, 0.33, 0.46 ), crater );
        diffuseColor.rgb *= 1.0 - 0.28 * seam;
      }`,
  };
  const barnMat = (bend) => toon('barnacle', { outlineW: 0.55, ...bendHooks({ bend, extraPars: 'varying vec3 vLocal;\n', extraBegin: 'vLocal = position;' }), ...barnHooks });
  const barns = [], sB = sampler('wBarn', o.seed + 606);
  for (let i = 0; i < N(1700); i++) {
    sB.sample(tp, tn);
    const s = 0.8 + Math.pow(R(), 2.2) * 2.0;
    barns.push({ m: place(tp, tn, { yaw: R() * TAU, scale: new THREE.Vector3(s * (0.85 + R() * 0.3), s * (0.7 + R() * 0.6), s * (0.85 + R() * 0.3)), sink: 0.15 * s }), c: pick(R(), BAR) });
  }
  for (const e of eyes) {                       // 眼圈：不规则的一圈，下方、后方更密，内小外大
    const ph0 = e.side > 0 ? EYE_PH : Math.PI - EYE_PH;
    for (let i = 0; i < 150; i++) {
      const inner = i < 70, a = inner ? (i + R() * 0.8) / 70 * TAU : R() * TAU;
      const dens = inner ? 0.62 + 0.38 * Math.sin(a * 2 + 0.6) * Math.sin(a * 5 + 2.1) + 0.2 : 0.3 + 0.45 * (0.5 - 0.5 * Math.sin(a)) + 0.25 * (0.5 - 0.5 * Math.cos(a)) + 0.35 * Math.sin(a * 3 + 1.7);
      if (R() > dens) continue;
      const u = inner ? R() : 0.3 + Math.pow(R(), 1.4) * 0.7;
      const rr = (inner ? 1.0 + u * 0.3 + 0.06 * Math.sin(a * 3) : 1.3 + u * 0.9) * RE, s0 = inner ? 0.5 : 0.8 + u * 0.8, s1 = inner ? 1.25 : 1.4 + u * 1.2;
      const dph = Math.sin(a) * rr / eyeSecR * (e.side > 0 ? 1 : -1);
      const x = EYE_X + Math.cos(a) * rr * 1.12;
      const p = bodyPoint(x, ph0 + dph), n = bodyNormal(x, ph0 + dph);
      const s = lerp(s0, s1, R());
      barns.push({ m: place(p, n, { yaw: R() * TAU, scale: new THREE.Vector3(s, s * (0.8 + R() * 0.5), s), sink: 0.2 * s }), c: pick(R(), BAR) });
    }
  }
  for (let i = 0; i < N(150); i++) {            // 尾鳍前后缘
    const t = R() * 2 - 1, P2 = flukeAt(t), lead = R() < 0.4;
    const z = t * FLUKE_S, x = lead ? P2.le - 1.5 : P2.le - P2.c + 2.5;
    const up = R() < 0.5 ? 1 : -1;
    const p = new THREE.Vector3(x, P2.y + up * P2.th * 0.12, z), n = new THREE.Vector3(lead ? 0.5 : -0.4, up, 0).normalize();
    const s = 0.9 + R() * 1.4;
    if (Math.abs(t) < 0.95) barns.push({ m: place(p, n, { yaw: R() * TAU, scale: new THREE.Vector3(s, s, s), sink: 0.2 }), c: pick(R(), BAR) });
  }
  add(group, inst(barnacle(), barnMat(true), barns, 'kun-barnacles'));

  // 头顶疙瘩（座头鲸的结节）：吻部背面三行 + 下颌边一行
  const knobs = [];
  for (const side of [1, -1]) for (let row = 0; row < 3; row++) for (let x = 296; x > 232; x -= 6.5 + R() * 2) {
    const ph = 1.5708 - (0.12 + row * 0.2) + (R() - 0.5) * 0.05, phi = side > 0 ? ph : Math.PI - ph;
    const p = bodyPoint(x, phi), n = bodyNormal(x, phi), s = 1.6 + R() * 1.1;
    knobs.push({ m: place(p, n, { yaw: R() * TAU, scale: new THREE.Vector3(s, s, s), sink: 0.25 }) });
  }
  for (const side of [1, -1]) for (let x = 296; x > 236; x -= 5 + R() * 2) {
    const ph = mouthPhi(x) - 0.1 - R() * 0.04, phi = side > 0 ? ph : Math.PI - ph;
    const p = bodyPoint(x, phi), n = bodyNormal(x, phi), s = 1.4 + R() * 0.9;
    knobs.push({ m: place(p, n, { yaw: R() * TAU, scale: new THREE.Vector3(s, s, s), sink: 0.2 }) });
  }
  add(group, inst(dome(10, 5, [1, 0.55, 1]), toon('kun', { rustAmt: 0.5, patchScale: 0.06, outlineW: 0.5, ...bendHooks() }), knobs, 'kun-knobs'));

  // 胸鳍前缘藤壶 + 鳍尖云丝（挂在鳍的枢轴下，跟鳍一起动；不弯曲）
  const wisps = [];
  for (const f of fins) {
    const fb = [];
    for (let i = 0; i < N(90); i++) {
      const t = 0.06 + R() * 0.9, P2 = finPlan(t), z = f.side * t * FIN_SPAN;
      const lead = R() < 0.75, up = R() < 0.55 ? 1 : -1;
      const x = lead ? P2.le - 0.8 - R() * 2.5 : P2.le - P2.c * (0.55 + R() * 0.4);
      const p = new THREE.Vector3(x, P2.y + up * P2.th * (lead ? 0.28 : 0.2), z);
      const n = new THREE.Vector3(lead ? 0.65 : 0, up, 0).normalize();
      const s = 1 + R() * (lead ? 2.2 : 1.3);
      fb.push({ m: place(p, n, { yaw: R() * TAU, scale: new THREE.Vector3(s, s * (0.8 + R() * 0.5), s), sink: 0.25 * s }), c: pick(R(), BAR) });
    }
    add(f.pivot, inst(barnacle(), barnMat(false), fb, 'kun-fin-barnacles'));
    if (o.wisps) { const w = makeWisp(f.side, U); f.pivot.add(w); wisps.push(w); }
  }

  // —— 姿态 ——
  const _bq = new THREE.Quaternion(), _sq = new THREE.Quaternion(), _e = new THREE.Euler();
  const { bend: jsBend } = WAVE.js(U);
  function setPose(ts, po = {}) {
    U.uKunT.value = ts;
    // 胸鳍：根部跟随脊柱弯曲，绕弦向轴上下划，绕厚度轴前后摆
    for (const f of fins) {
      const [dy, th] = jsBend(f.x0, ts);
      const r = f.root;
      f.pivot.position.set(r.x - r.y * Math.sin(th), dy + r.y * Math.cos(th), r.z);
      const ph = TAU * ts / 6 + (f.side > 0 ? 0 : 0.35);
      _sq.setFromEuler(_e.set(f.side * 0.11 * Math.sin(ph), 0.05 * Math.sin(ph + 1.1), 0));
      _bq.setFromAxisAngle(new THREE.Vector3(0, 0, 1), th);
      f.pivot.quaternion.copy(_bq).multiply(f.baseQ).multiply(_sq);
    }
    // 眨眼（闭合度 0 睁 → 1 闭）、眼珠看向目标（世界坐标，限幅）；高光固定在眼窝坐标（左上方）
    poseEyes(eyes, po.blink ?? autoBlink(ts, o.blinkPeriod, o.blinkOffset), po.look, group, { lidU: [-0.6, 0.03], lidL: [0.48, -0.03], catches: CATCH });
    if (po.look) _e.order = 'YXZ';   // 眼睛看过目标之后，胸鳍摆动的欧拉角改按 YXZ 顺序合成（正片镜头 C 的画面依赖这个顺序）
  }
  // 眼睛世界坐标：ref 为相机位置（Vector3）时取离它近的那只；ref 为 1 / -1 时取 +Z / -Z 侧；默认 -Z 侧
  const eyeWorld = (target, ref) => pickEye(eyes, target, ref);
  // 让主光（DirectionalLight）的阴影相机刚好罩住鲲；光的方向保持不变。鲲移动后每帧调用一次即可
  function fitShadow(light, { size = 4096, radius = 380 } = {}) {
    group.updateMatrixWorld(true);
    const c = new THREE.Vector3(-10, -5, 0).applyMatrix4(group.matrixWorld);
    const sc = group.matrixWorld.getMaxScaleOnAxis(), R = radius * sc;
    const dir = light.position.clone().sub(light.target.position);
    if (dir.lengthSq() < 1e-9) dir.set(0.75, 0.1, 0.65); dir.normalize();
    light.target.position.copy(c); light.target.updateMatrixWorld();
    light.position.copy(c).addScaledVector(dir, R * 3);
    const cam = light.shadow.camera;
    Object.assign(cam, { left: -R, right: R, top: R, bottom: -R, near: R * 0.5, far: R * 5.5 });
    cam.updateProjectionMatrix();
    if (light.shadow.mapSize.x !== size) { light.shadow.mapSize.set(size, size); light.shadow.map?.dispose(); light.shadow.map = null; }
    light.shadow.normalBias = 1.5 * sc; light.shadow.bias = -0.0005; light.shadow.radius = 2;
    light.castShadow = true;
  }
  setPose(0);
  return { group, setPose, eyeWorld, fitShadow, outlineMeshes, length: 600, eyeRadius: RE, wisps, uniforms: U, fins, eyes };
}

// 鳍尖云丝：沿鳍尖向后拖的软管，透明度分两档（像画的云带），不描边；描边通道里直接丢弃
function makeWisp(side, U) {
  const tip = finPlan(0.985), base = new THREE.Vector3(tip.le - tip.c * 0.5, tip.y, side * FIN_SPAN * 0.985);
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const a = i / 24;
    pts.push(new THREE.Vector3(base.x - a * 150, base.y - a * 10 + Math.sin(a * 5.5) * 5 * a, base.z + side * (a * 18 + Math.sin(a * 4) * 6 * a)));
  }
  const { g, along } = taperTube(new THREE.CatmullRomCurve3(pts), 64, 10, a => lerp(7.5, 0.6, Math.pow(a, 0.7)));   // 沿程收细
  g.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uKunT: U.uKunT, uToonPass: TOON_SHARED.uToonPass, uA: { value: new THREE.Color(PALETTE.cloudLit) }, uB: { value: new THREE.Color('#fff4ea') } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      uniform float uKunT; attribute float aAlong; varying float vA; varying vec3 vN; varying vec3 vV;
      void main() {
        vec3 p = position;
        p.y += sin( uKunT * 2.1 + aAlong * 7.0 ) * 3.0 * aAlong;
        vec4 mv = modelViewMatrix * vec4( p, 1.0 );
        vN = normalize( normalMatrix * normal ); vV = normalize( - mv.xyz ); vA = aAlong;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uA, uB; uniform float uToonPass; varying float vA; varying vec3 vN; varying vec3 vV;
      void main() {
        if ( uToonPass > 0.5 ) discard;
        float f = abs( dot( normalize( vN ), normalize( vV ) ) );
        float a = pow( f, 1.6 ) * ( 1.0 - smoothstep( 0.35, 1.0, vA ) ) * smoothstep( 0.0, 0.06, vA );
        float q = smoothstep( 0.18, 0.22, a ) * 0.3 + smoothstep( 0.5, 0.54, a ) * 0.28;
        gl_FragColor = vec4( mix( uA, uB, smoothstep( 0.45, 0.6, f ) ), q );
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'kun-wisp'; mesh.frustumCulled = false; mesh.renderOrder = 2;
  mesh.userData.outline = false; mesh.userData.wisp = true;
  return mesh;
}
