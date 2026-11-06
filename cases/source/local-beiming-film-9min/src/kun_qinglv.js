// 鲲 · 青绿仙山版（三渲二配方第 1、2、4 层）。设定图：鲲设定/鲲_v2-1_青绿仙山.png
//   形体：鲸与鲤之间的修长鱼身——宽阔高贵的大头、钝圆吻、金眼、两对长龙须；鳃盖后满身金线鱼鳞；
//         胸鳍是三片半透明长鳍叠成的“折扇”（能开合），腹鳍、臀鳍细长下垂，尾鳍是深叉的两片大扇。
//   着色：身体石青（背、头）→ 石绿（体侧）→ 牙白（下颌、前腹）渐变；鳞片金线、侧身祥云纹、头顶卷云、眉线全在
//         片元着色器里按（体长 x，背中线弧长 s）程序化生成，换机位不走样。
//   背上：青绿山水小仙岛——三层台地（崖壁石青石绿、台面嫩绿）、十座笋状尖峰（上青下绿、有台阶和皴线）、
//         实例化松树（大松手摆、小松撒点）、苔点和小白花、红柱六角亭 + 石阶、
//         从台地边缘泻下、贴着体侧流的白色瀑布（一拍二流动），落进云雾团。
// 坐标：鲲局部空间，长约 600（x：-300 尾鳍尖 … +300 吻端），头朝 +X，上为 +Y，原点在身体中心。
// 接口与 src/kun.js 一致：createKun(opts) → { group, setPose(ts, o), eyeWorld(target, ref), fitShadow(light, o), outlineMeshes, length, ... }
// 动画：setPose(ts) 的 ts 由调用方量化（一拍三）。身体是鱼的游法——以横摆为主（尾巴左右扫）、带一点上下起伏；
//       头部不动，越往尾巴摆幅越大。胸鳍折扇：开合 + 划水 + 前后摆（CPU 摆位）；鳍膜、龙须在顶点着色器里随波飘。
//       瀑布和墨线一样用 uInkTime（= floor(帧/2)，一拍二）流动——合成里已经在设 setToonGlobals({ inkTime })，不用另接线。
// 确定性：所有随机来自 mulberry(固定种子)，噪声来自固定种子的单纯形噪声（engine/core/noise.js）；没有 Date.now / Math.random。
// 描边：每个形变网格都在 userData.outlineVertex 里带了同款顶点形变 GLSL（look.js 的 ID 图会用它，弯曲后的线不会错位）。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createNoise3D } from '../engine/core/noise.js';
import { mulberry, monotone, clamp, lerp, ss, seg, TAU } from '../engine/core/math.js';
import { profileBody, sideAngle, axisStations, ringsAt, loftRings } from '../engine/form/loft.js';
import { frameWave } from '../engine/form/bend.js';
import { clump, flowerHead } from '../engine/form/props.js';
import { pineTree, leaf as geoLeaf, bakeLeaf } from '../engine/form/plants.js';
import { spire as geoPeak, mesa as geoMesa, mesaEdge as mesaEdgeZ } from '../engine/form/rock.js';
import { weightedSampler as sampler, placeOnSurface as place, pickFrom as pick, instanced } from '../engine/form/scatter.js';
import { autoBlink, poseEyes, pickEye, mountEyes, lidShells, eyeFrame } from '../engine/form/eye.js';
import { makeToonMaterial, bindToon, PALETTE, TOON_SHARED } from './toon_qinglv.js';

const sstep = (a, b, x) => ss(seg(x, a, b));
const UP = new THREE.Vector3(0, 1, 0);
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ───────────────────────── 色板（石青、石绿、金、牙白；朱红亭柱） ─────────────────────────
const C = {
  qingDeep: '#1d4aa6', qing: '#2f6cc6', lv: '#1f9a7c', lvLight: '#5cc49c', belly: '#efe7c6', cloudFill: '#f3e6c0',
  gold: '#f2c65a', lip: '#7c2c2e', bellyLine: '#b99a5e',
  finRoot: '#1c7d7a', finMid: '#2f9fae', finBlue: '#3a74c8', finEdge: '#cdeee6',
  rockGreen: '#279a73', rockBlue: '#2a5cb4', rockDeep: '#1d3f92', rockTop: '#78c26a', rockTop2: '#9bd27a', rockOchre: '#b8874f',
  trunk: '#6a3c2a', red: '#c8382a', roof: '#24508e', stone: '#d8cfb6', beam: '#2c7f8a',
  water: '#f4f9ff', waterShade: '#9dbcd8', cloud: '#fff2e4',
};

// ───────────────────────── 身体轮廓（取自设定图侧影，1 像素 ≈ 0.346 单位） ─────────────────────────
//               尾柄 …………………………………………………………………………………………………………………… 吻端
const PX = [-226, -212, -196, -170, -140, -100, -50, 0, 50, 100, 150, 190, 225, 255, 278, 292, 300];
const PT = [24.5, 29, 32, 38, 44, 49, 53, 55, 56, 57, 57, 57, 54, 48, 38, 28, 18];         // 顶线 y（背平：驮山）
const PB = [17.5, 13, 10, 1, -13, -30, -46, -58, -63, -62, -54, -42, -28, -14, -4, 5, 11]; // 底线 y（腹深、下颌大）
const PW = [1.6, 3.5, 6, 11, 18, 27, 36, 42, 45, 46, 46, 45, 41, 33, 24, 15, 5];         // 半宽 z
const X_TAIL = -226, X_SNOUT = 300;

// 眼睛、眉骨、嘴线（侧向角 ph：0 = 体侧最宽处，+π/2 = 背中线，两侧对称）
const EYE_X = 190, EYE_PH = 0.2, RE = 10;
const BROW_X = 186, BROW_PH = 0.5;
const mouthPh = x => lerp(-0.22, -0.33, sstep(298, 215, x)) - 0.13 * sstep(220, 200, x);
// 放样体（未弯曲）：超椭圆截面 + 嘴线台阶 + 眉骨。phi：0 = +Z 侧水平，π/2 = 背中线
const body = profileBody({
  xs: PX, top: PT, bottom: PB, width: PW, exp: [2.3, 2.7],
  deform(p) {
    const ph = sideAngle(p.c, p.s);
    if (p.x > 196) {                                 // 下颌比上颌略宽：嘴线处有台阶（描边能抓到）
      const pm = mouthPh(p.x);
      const st = (1 - sstep(pm - 0.05, pm + 0.05, ph)) * sstep(196, 220, p.x) * sstep(302, 292, p.x) * sstep(-1.45, -1.0, ph);
      const k = 1 + 0.03 * st; p.z *= k; p.y = p.yc + (p.y - p.yc) * k;
    }
    // 眉骨：眼睛上方一道隆起（龙眉）
    const db2 = Math.pow((p.x - BROW_X) / 24, 2) + Math.pow((ph - BROW_PH) / 0.17, 2);
    const bump = 3.4 * Math.exp(-db2);
    if (bump > 1e-3) { const rr = Math.hypot(p.y - p.yc, p.z) || 1; p.y += (p.y - p.yc) / rr * bump; p.z += p.z / rr * bump; }
  },
});
const { top: fT, bottom: fB, width: fW, mid: yMid, point: bodyPoint, normal: bodyNormal } = body;
const phiOf = (ph, side) => side > 0 ? ph : Math.PI - ph;   // 侧向角 → 放样角
// 背部上表面在 (x, z) 处的高度（不含眉骨、台阶这些小起伏）
function surfY(x, z) {
  const yT = fT(x), yB = fB(x), W = fW(x), yc = (yT + yB) / 2, a = (yT - yB) / 2, e = 2 / 2.3;
  const cc = Math.pow(Math.min(1, Math.abs(z) / W), 1 / e), ss = Math.sqrt(Math.max(0, 1 - cc * cc));
  return yc + a * Math.pow(ss, e);
}
const t1Top = (x, z) => surfY(x, z) + 6;

// 身体：aLoft = (x, cosφ, sinφ)；aSurf = (s 背中线起的弧长, 半周长, a 鳞片纵向坐标)
const NROWS = 14, ASPECT = 1.15;     // 背→腹 14 行鳞；鳞长 = 行距 × 1.15
function buildBody(NU, NV) {
  const xs = axisStations(X_TAIL, X_SNOUT - 0.4, NU), rings = ringsAt(bodyPoint, xs, NV), sArr = [], halfs = [];
  const kd = NV / 4, kv = 3 * NV / 4;
  for (const ring of rings) {
    const s = new Float32Array(NV);
    let acc = 0;
    for (let k = kd; k < kv; k++) { acc += ring[k].distanceTo(ring[k + 1]); s[k + 1] = acc; }
    const h1 = acc; acc = 0;
    for (let i = 0; i < NV / 2; i++) { const k = (kd - i + NV) % NV, k2 = (kd - i - 1 + NV) % NV; acc += ring[k].distanceTo(ring[k2]); if (k2 !== kv) s[k2] = acc; }
    const half = (h1 + acc) / 2; s[kd] = 0; s[kv] = half;
    sArr.push(s); halfs.push(half);
  }
  const aArr = new Array(NU); aArr[NU - 1] = 0;
  for (let j = NU - 2; j >= 0; j--) { const hm = (halfs[j] + halfs[j + 1]) / 2; aArr[j] = aArr[j + 1] + (xs[j + 1] - xs[j]) / Math.max(1, hm / NROWS * ASPECT); }
  const loft = [], surf = [];
  for (let j = 0; j < NU; j++) for (let k = 0; k < NV; k++) {
    const phi = k / NV * TAU;
    loft.push(xs[j], Math.cos(phi), Math.sin(phi)); surf.push(sArr[j][k], halfs[j], aArr[j]);
  }
  const g = loftRings(rings, {
    startCap: { p: V3(X_TAIL - 0.8, yMid(X_TAIL), 0), attr: { aLoft: [X_TAIL, 0, 1], aSurf: [halfs[0] * 0.5, halfs[0], aArr[0]] } },
    endCap: { p: V3(X_SNOUT + 0.2, yMid(X_SNOUT), 0), attr: { aLoft: [X_SNOUT, 1, 0], aSurf: [halfs[NU - 1] * 0.5, halfs[NU - 1], 0] } },
    attrs: { aLoft: { data: loft, size: 3 }, aSurf: { data: surf, size: 3 } },
  });
  return { geo: g, halfAt: monotone(xs.map((x, j) => [x, halfs[j]])) };
}

// ───────────────────────── 鳍片（一片“扇骨”）：engine/form/plants.js 的 leaf（局部 X 沿鳍长、Y 横向、Z 法向；根在原点），bakeLeaf 烘到身体空间 ─────────────────────────
function basisAt(origin, xAxis, zHint) {
  const X = xAxis.clone().normalize();
  const Z = zHint.clone().addScaledVector(X, -zHint.dot(X)).normalize();
  const Y = V3().crossVectors(Z, X);
  return new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(origin);
}

// ───────────────────────── 小物件几何（单位尺寸，实例矩阵再缩放）；山石用 engine/form/rock.js 的 spire / mesa ─────────────────────────
const geoClump = () => clump({ flat: 0.72 });
// 五瓣小白花（俯看是一朵梅花）
const geoFlower = () => flowerHead({ disc: { rings: 4, segs: 60, lobes: 2.5, base: 0.35, amp: 0.65, sharp: 0.9, height: r => 0.3 + 0.25 * r * r - 0.1 * Math.pow(r, 4) }, bud: { r: 0.16, y: 0.42 } });
// 六角亭 + 石阶。aCol 固有色，aTrim 金线（檐口、垂脊）
function geoPavilion(stairDrop) {
  const parts = [];
  const add = (g, col, trimFn) => {
    g = g.index ? g.toNonIndexed() : g;
    if (g.attributes.uv) g.deleteAttribute('uv');
    const c = new THREE.Color(col), n = g.attributes.position.count;
    const ca = new Float32Array(n * 3), ta = new Float32Array(n);
    for (let i = 0; i < n; i++) { ca[i * 3] = c.r; ca[i * 3 + 1] = c.g; ca[i * 3 + 2] = c.b; ta[i] = trimFn ? trimFn(i, g) : 0; }
    g.setAttribute('aCol', new THREE.BufferAttribute(ca, 3)); g.setAttribute('aTrim', new THREE.BufferAttribute(ta, 1));
    if (!g.attributes.normal) g.computeVertexNormals();
    parts.push(g);
  };
  add(new THREE.CylinderGeometry(12.5, 13.6, 3.2, 6).translate(0, 1.6, 0), C.stone);
  // 石阶：从台基往 -Z（镜头那一侧）一级级下到下一层台地
  const nS = Math.max(4, Math.round(stairDrop / 1.5)), rise = stairDrop / nS + 3.2 / nS, run = 1.9;
  for (let i = 0; i < nS; i++) { const top = 3.2 - rise * (i + 1); add(new THREE.BoxGeometry(6.4, 4.5, run + 0.1).translate(0, top - 2.25, -(11.6 + run * (i + 0.5))), C.stone); }
  for (let k = 0; k < 6; k++) {                                   // 六根朱红柱
    const a = k / 6 * TAU;
    add(new THREE.CylinderGeometry(0.85, 0.95, 11, 8).translate(9.3 * Math.cos(a), 3.2 + 5.5, 9.3 * Math.sin(a)), C.red);
  }
  add(new THREE.CylinderGeometry(9.5, 9.5, 1.0, 6, 1, true).translate(0, 5.2, 0), C.red);                 // 栏杆
  add(new THREE.CylinderGeometry(9.9, 9.9, 1.7, 6, 1, true).translate(0, 13.6, 0), C.beam);               // 额枋（彩画）
  add(new THREE.CylinderGeometry(12.2, 9.9, 1.2, 6, 1, true).translate(0, 15.0, 0), C.red);               // 斗拱层
  // 屋顶：六角攒尖，凹曲面，翼角起翘
  const Re = 16, Hr = 9.5, lift = 2.8, nR = 14, nA = 120, pos = [], idx = [], rr = [];
  for (let i = 0; i <= nR; i++) {
    const r = i / nR;
    for (let j = 0; j <= nA; j++) {
      const th = j / nA * TAU;
      const sec = ((th % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3) - Math.PI / 6;
      const hex = Math.cos(Math.PI / 6) / Math.cos(sec), corner = Math.pow(Math.abs(Math.cos(3 * th)), 12);
      const R0 = Re * r * hex * (1 + 0.1 * corner * r * r);
      pos.push(R0 * Math.cos(th), 15.6 + Hr * Math.pow(1 - r, 1.7) + lift * corner * Math.pow(r, 3), R0 * Math.sin(th));
      rr.push(Math.max(sstep(0.9, 0.98, r), sstep(0.86, 0.97, corner) * sstep(0.15, 0.3, r)));
    }
  }
  for (let i = 0; i < nR; i++) for (let j = 0; j < nA; j++) { const a = i * (nA + 1) + j, b = a + nA + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const roof = new THREE.BufferGeometry(); roof.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); roof.setIndex(idx); roof.computeVertexNormals();
  roof.setAttribute('aTrimSrc', new THREE.Float32BufferAttribute(rr, 1));
  const rnI = roof.toNonIndexed();
  add(rnI, C.roof, i => rnI.attributes.aTrimSrc.getX(i));
  rnI.deleteAttribute('aTrimSrc');
  add(new THREE.SphereGeometry(1.1, 10, 8).translate(0, 25.9, 0), C.gold, () => 1);
  add(new THREE.ConeGeometry(0.7, 3, 8).translate(0, 28, 0), C.gold, () => 1);
  return mergeGeometries(parts);
}

// ───────────────────────── 弯曲（GLSL 与 JS 一致） ─────────────────────────
// 鱼的游法：横摆（z）为主，上下（y）为辅；包络在头部为 0（s<0.33），往尾巴按 2.4 次方加大
const WAVE = frameWave('kun', { e0: 0.33, sMax: 1.1, pow: 2.4 });
const KUN_UNIF = WAVE.unif, BEND_GLSL = '\n' + WAVE.funcs;
// mode：'vertex' 逐顶点弯（身体、鳍、瀑布、台地）；'rigid' 按 aAnchor 整块弯（山峰、亭）；'inst' 按实例原点弯（松、苔、云）；'none'
// dispPars / disp：顶点位移（扑动、飘摆、瀑布边缘），也原样交给 look.js 的 ID 图；varPars / varBegin：只给着色用的 varying
const hooks = WAVE.modeHooks;
const CATCH = [[-0.27, 0.24, 0.93, 0.9835], [0.26, -0.2, 0.94, 0.9966]];

// ───────────────────────── 片元：祥云、鳞片、折线（GLSL 公共函数） ─────────────────────────
const CLOUD_GLSL = /* glsl */`
float qlSmin( float a, float b, float k ) { float h = clamp( 0.5 + 0.5 * ( b - a ) / k, 0.0, 1.0 ); return mix( b, a, h ) - k * h * ( 1.0 - h ); }
// 祥云（单位尺寸）：四个云头 + 一条往 -u 拖的飘带尾巴。返回有符号距离
float qlCloud( vec2 p ) {
  float d = length( p - vec2( 0.0, 0.1 ) ) - 0.3;
  d = qlSmin( d, length( p - vec2( 0.4, 0.0 ) ) - 0.21, 0.07 );
  d = qlSmin( d, length( p - vec2( -0.34, -0.02 ) ) - 0.19, 0.07 );
  d = qlSmin( d, length( p - vec2( 0.16, 0.33 ) ) - 0.15, 0.05 );
  float u = clamp( p.x, -1.75, -0.2 ), t = ( -0.2 - u ) / 1.55;
  float yc = -0.13 + 0.08 * sin( t * 5.0 ) * t;
  float th = mix( 0.085, 0.012, t );
  d = qlSmin( d, length( vec2( p.x - u, p.y - yc ) ) - th, 0.06 );
  return d;
}
// 云头里的旋涡线（阿基米德螺线）：返回到线的距离（单位尺寸）
float qlCurl( vec2 p, vec2 c, float r, float dir ) {
  vec2 q = p - c; float rho = length( q );
  float th = atan( q.y, q.x ) * dir;
  float pitch = r * 0.8 / 1.4;
  float t = rho / pitch - th / 6.2831853;
  float d = abs( t - floor( t + 0.5 ) ) * pitch;
  return mix( 9.0, d, step( rho, r * 0.82 ) * step( 0.12 * r, rho ) );
}
float qlCurls( vec2 p ) {
  float d = qlCurl( p, vec2( 0.0, 0.1 ), 0.3, 1.0 );
  d = min( d, qlCurl( p, vec2( 0.4, 0.0 ), 0.21, -1.0 ) );
  d = min( d, qlCurl( p, vec2( -0.34, -0.02 ), 0.19, 1.0 ) );
  d = min( d, qlCurl( p, vec2( 0.16, 0.33 ), 0.15, -1.0 ) );
  return d;
}
float qlSeg( vec2 p, vec2 a, vec2 b ) { vec2 pa = p - a, ba = b - a; float h = clamp( dot( pa, ba ) / dot( ba, ba ), 0.0, 1.0 ); return length( pa - ba * h ); }
`;
const DECOR_GLSL = CLOUD_GLSL + /* glsl */`
// 鱼鳞：交错排列的圆，靠前（a 小）的压住靠后的；返回 (到外缘距离, 鳞心 a, 鳞心 b, 随机)
vec4 qlScale( vec2 q ) {
  float bestA = 1e9, bestD = -1.0; vec2 bc = vec2( 0.0 );
  float jb = floor( q.y + 0.5 );
  for ( int dj = -1; dj <= 1; dj ++ ) {
    float j = jb + float( dj );
    float off = 0.5 * mod( j, 2.0 );
    float ia = floor( q.x - off + 0.5 );
    for ( int di = -1; di <= 1; di ++ ) {
      vec2 c = vec2( ia + float( di ) + off, j );
      float d = 0.98 - length( ( q - c ) * vec2( ${ASPECT.toFixed(3)}, 1.0 ) );
      if ( d > 0.0 && c.x < bestA - 1e-3 ) { bestA = c.x; bestD = d; bc = c; }
    }
  }
  return vec4( bestD, bc, fract( sin( dot( bc, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) );
}
float qlSide( vec2 cs ) { float p = atan( cs.y, cs.x ); return cs.x >= 0.0 ? p : ( p >= 0.0 ? 3.14159265 - p : -3.14159265 - p ); }
float qlMouth( float x ) { return mix( -0.22, -0.33, toonSS( 298.0, 215.0, x ) ) - 0.13 * toonSS( 220.0, 200.0, x ); }
float qlBellyPh( float x ) {
  float b = mix( -1.62, -0.95, toonSS( -25.0, 45.0, x ) );
  b = mix( b, -0.56, toonSS( 45.0, 140.0, x ) );
  b = mix( b, -0.46, toonSS( 140.0, 200.0, x ) );
  return mix( b, qlMouth( x ), step( 200.0, x ) );
}
`;
// 身体两侧的祥云纹：(x 中心, s 中心, 尺寸)
const MOTIFS = [[96, 66, 30], [-22, 104, 28], [-112, 54, 24], [-174, 42, 15], [30, 128, 18]];
// 头顶的卷云（填色淡）
const HEADM = [[252, 20, 12], [216, 9, 10]];

// 平面祥云卡片（青绿山水里绕山腰的云带）：朝镜头的面片，片元里画祥云（奶白 + 薰衣草暗部 + 金线卷云 + 背光粉边），
// 中心点跟着身体刚体弯。法线/ID 通道写深度和 ID（挡住后面的线，外轮廓由屏幕描边补一道墨线）。
function makeCloudCards(U, cards) {
  const g = new THREE.PlaneGeometry(2.6, 1.05, 1, 1); g.translate(-0.58, 0.1, 0);
  const ig = new THREE.InstancedBufferGeometry(); ig.index = g.index; ig.setAttribute('position', g.attributes.position);
  const a1 = new Float32Array(cards.length * 4), a2 = new Float32Array(cards.length * 2);
  cards.forEach((c, i) => { a1.set([c.p.x, c.p.y, c.p.z, c.s], i * 4); a2.set([c.flip, c.rot], i * 2); });
  ig.setAttribute('aCard', new THREE.InstancedBufferAttribute(a1, 4)); ig.setAttribute('aCard2', new THREE.InstancedBufferAttribute(a2, 2));
  ig.instanceCount = cards.length;
  const m = new THREE.ShaderMaterial({
    uniforms: { ...U, uToonPass: TOON_SHARED.uToonPass, uInkTime: TOON_SHARED.uInkTime, uExposure: TOON_SHARED.uExposure,
      uCream: { value: new THREE.Color('#fff3e2') }, uLav: { value: new THREE.Color('#c8b6e6') }, uGold: { value: new THREE.Color('#e9b955') },
      uRim: { value: new THREE.Color(PALETTE.pink) }, uObjectId: { value: 977 } },
    vertexShader: KUN_UNIF + BEND_GLSL + /* glsl */`
      attribute vec4 aCard; attribute vec2 aCard2; varying vec2 vP; flat varying float vInst;
      void main() {
        vec3 c = kunBendRigid( aCard.xyz, aCard.x );
        vec4 mv = modelViewMatrix * vec4( c, 1.0 );
        float sc = length( modelMatrix[ 0 ].xyz ) * aCard.w;
        float cr = cos( aCard2.y ), sr = sin( aCard2.y );
        vec2 q = vec2( position.x * aCard2.x, position.y );
        mv.xy += vec2( q.x * cr - q.y * sr, q.x * sr + q.y * cr ) * sc;
        vP = position.xy; vInst = float( gl_InstanceID );
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: CLOUD_GLSL + /* glsl */`
      uniform float uToonPass, uInkTime, uObjectId, uExposure; uniform vec3 uCream, uLav, uGold, uRim;
      varying vec2 vP; flat varying float vInst;
      float h21( vec2 p ) { p = fract( p * vec2( 0.1031, 0.1030 ) ); p += dot( p, p.yx + 33.33 ); return fract( ( p.x + p.y ) * p.x ); }
      void main() {
        float jt = floor( uInkTime );
        vec2 p = vP + ( vec2( h21( vec2( jt, vInst ) ), h21( vec2( vInst, jt + 3.1 ) ) ) - 0.5 ) * 0.006;
        float d = qlCloud( p ), fw = max( fwidth( d ), 1e-4 );
        if ( d > fw * 0.5 ) discard;
        if ( uToonPass > 0.5 ) { gl_FragColor = vec4( 0.5, 0.5, 0.5 + 0.5 * 0.45, fract( uObjectId * 0.7548776662 + vInst * 0.5698402910 + 0.137 ) ); return; }
        // 两档：上半奶白（受光），下半薰衣草（暗部），交界线带一点波
        float sl = p.y - ( -0.02 + 0.045 * sin( p.x * 8.0 + vInst ) );
        float fs = max( fwidth( sl ), 1e-4 );
        vec3 col = mix( uLav, uCream, smoothstep( -fs, fs, sl ) );
        // 背光粉边：靠上沿的一圈
        float rim = ( 1.0 - smoothstep( 0.035 - fw, 0.035 + fw, -d ) ) * smoothstep( -0.05, 0.12, p.y );
        col = mix( col, uRim, rim * 0.75 );
        // 金线：外轮廓内侧一道 + 云头卷线
        float ol = 1.0 - smoothstep( 0.012 - fw, 0.012 + fw, abs( d + 0.022 ) );
        float dc = qlCurls( p ), fc = max( fwidth( dc ), 1e-4 );
        float cl = ( 1.0 - smoothstep( 0.011 - fc, 0.011 + fc, dc ) ) * step( d, -0.03 );
        col = mix( col, uGold, max( ol, cl ) * 0.9 );
        gl_FragColor = vec4( col * uExposure, 1.0 );
        #include <colorspace_fragment>
      }`,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(ig, m);
  mesh.name = 'kun-isle-cloudcards'; mesh.frustumCulled = false; mesh.renderOrder = 1;
  mesh.userData.outline = false; mesh.userData.outlineOccluder = 'own';
  return mesh;
}

/**
 * createKun(opts) → { group, setPose(ts, o), eyeWorld(target, ref), fitShadow(light, o), outlineMeshes, length, eyeRadius, uniforms, fins, eyes, wisps }
 * opts.lod   0.1–1：实例数和网格密度的倍率（大远景 0.35–0.5；低 LOD 时单个装饰自动放大）
 * opts.seed  散布种子（默认 20261103）
 * opts.blinkPeriod / blinkOffset：自动眨眼的周期 / 首次时刻（秒，默认 4 / 1.5）
 * setPose(ts, { blink, look })：blink 0 睁 → 1 闭；look 为世界坐标 Vector3，金眼转向它（限幅）
 * eyeWorld(target, ref)：ref = 相机位置（取近的那只眼）/ 1（+Z 侧）/ -1（-Z 侧，默认）
 * fitShadow(light, { size })：把主光阴影相机罩到鲲身上（方向不变）
 * uniforms.uKunAmpZ / uKunAmpY / uKunWave / uKunOmega：横摆幅度 / 上下幅度 / 波数 / 角频率
 */
export function createKun(opts = {}) {
  const o = { lod: 1, seed: 20261103, blinkPeriod: 4, blinkOffset: 1.5, ...opts };
  const lod = clamp(o.lod, 0.1, 1);
  const N = n => Math.max(3, Math.round(n * lod));
  const LS = 1 / Math.sqrt(Math.max(lod, 0.2));
  const R = mulberry(o.seed);
  const noise = createNoise3D(mulberry(o.seed + 11));

  const U = {
    uKunT: { value: 0 }, uKunAmpY: { value: 10 }, uKunAmpZ: { value: 28 }, uKunWave: { value: 0.85 }, uKunOmega: { value: TAU / 5 },
    uKunHalfL: { value: 300 }, uKunPhY: { value: 1.25 },
  };
  const group = new THREE.Group(); group.name = 'kun';
  const outlineMeshes = [];
  const add = (parent, mesh) => { parent.add(mesh); if (mesh.userData.outline) outlineMeshes.push(mesh); return mesh; };
  const BASE = {
    shade1Tint: [0.6, 0.67, 0.86], shade2Tint: [0.36, 0.41, 0.66], step1: 0.53, step2: 0.2,
    fillColor: PALETTE.kunBelly, fillAmt: 0.75, fillStep: 0.6, fillStep2: 0.94, fillW1: 0.42, fillFlat: 0.5,
    skyAmt: 0.7, skyTint: [0.8, 0.92, 1.15],
    rimAmt: 0.6, rimColor: PALETTE.pink, rimPower: 0.4, rimInside: 0.3, rimDirK: 0.5,
    rimLitAmt: 1, rimLitColor: PALETTE.kunRim, rimLitPower: 0.55, rimLitInside: 0.1, rimLitDirK: 0.55,
  };
  const toon = (x = {}) => makeToonMaterial({ ...BASE, ...x, uniforms: { ...U, ...(x.uniforms || {}) } });
  const col = c => new THREE.Color(c);

  // ═════════════════════════ 身体 ═════════════════════════
  const NU = Math.round(lerp(90, 240, lod)), NV = Math.round(lerp(64, 136, lod) / 4) * 4;
  const { geo: bodyGeo } = buildBody(NU, NV);
  const eyeSecR = ((fT(EYE_X) - fB(EYE_X)) / 2 + fW(EYE_X)) / 2;
  // 眼睛所在处的弧长（给片元里眉线、眼周用）
  const sEye = (() => { let s = 0; const st = 90; for (let i = 0; i < st; i++) { const a = Math.PI / 2 - (Math.PI / 2 - EYE_PH) * i / st, b = Math.PI / 2 - (Math.PI / 2 - EYE_PH) * (i + 1) / st; s += bodyPoint(EYE_X, a).distanceTo(bodyPoint(EYE_X, b)); } return s; })();
  const motifGlsl = (list, fillExpr) => list.map(([mx, ms, mS]) => /* glsl */`
      {
        vec2 mp = vec2( kx + jx * 0.4 - ${mx.toFixed(1)}, -( ks + js * 0.4 - ${ms.toFixed(1)} ) ) / ${mS.toFixed(1)};
        float d = qlCloud( mp ) * ${mS.toFixed(1)};
        float fw = max( fwidth( d ), 1e-4 );
        float fill = 1.0 - smoothstep( -fw, fw, d );
        diffuseColor.rgb = mix( diffuseColor.rgb, ${fillExpr}, fill * 0.94 );
        gold = max( gold, toonLine( d, 0.5 ) );
        gold = max( gold, toonLine( qlCurls( mp ) * ${mS.toFixed(1)}, 0.42 ) * fill );
        inMotif = max( inMotif, fill );
      }`).join('');
  const bodyMat = toon({
    rustTint: [0.64, 0.72, 1.0], rustAmt: 0.4, rustThr: 0.14, patchScale: 0.017,
    algaeColor: '#b5ead0', algaeAmt: 0.28, algaeThr: 0.32,
    spotColor: '#1c2c5e', spotAmt: 0.22, spotThr: 0.64, spotScale: 34,
    uniforms: {
      uKunEye: { value: new THREE.Vector4(EYE_X, EYE_PH, RE, sEye) },
      uQingDeep: { value: col(C.qingDeep) }, uQing: { value: col(C.qing) }, uLv: { value: col(C.lv) }, uLvLight: { value: col(C.lvLight) },
      uBelly: { value: col(C.belly) }, uCloudFill: { value: col(C.cloudFill) }, uGold: { value: col(C.gold) }, uLip: { value: col(C.lip) }, uBellyLine: { value: col(C.bellyLine) },
    },
    ...hooks(U, { mode: 'vertex', varPars: 'attribute vec3 aLoft;\nattribute vec3 aSurf;\nvarying vec3 vLoft;\nvarying vec3 vSurf;\n', varBegin: 'vLoft = aLoft; vSurf = aSurf;' }),
    fragmentPars: 'varying vec3 vLoft;\nvarying vec3 vSurf;\nuniform vec4 uKunEye;\nuniform vec3 uQingDeep, uQing, uLv, uLvLight, uBelly, uCloudFill, uGold, uLip, uBellyLine;\n' + DECOR_GLSL,
    fragmentBase: /* glsl */`
    {
      float kx = vLoft.x, kph = qlSide( vLoft.yz ), ks = vSurf.x, kH = max( vSurf.y, 1.0 ), kbn = clamp( ks / kH, 0.0, 1.0 );
      float kn = toonNoise( vec3( kx * 0.018, ks * 0.03, 3.1 ) );
      float xh = toonSS( 165.0, 80.0, kx );
      vec3 c = mix( uQingDeep, uQing, toonSS( 0.04, 0.32, kbn + kn * 0.05 ) );
      float g0 = mix( 0.52, 0.24, xh );
      c = mix( c, uLv, toonSS( g0 - 0.1, g0 + 0.16, kbn + kn * 0.07 ) );
      c = mix( c, uLvLight, toonSS( 0.6, 0.86, kbn + kn * 0.05 ) * xh );
      c = mix( c, mix( uQing, uLv, 0.4 ), toonSS( -120.0, -205.0, kx ) * 0.55 * ( 1.0 - toonSS( 0.55, 0.9, kbn ) ) );
      float bph = qlBellyPh( kx );
      float belly = toonSS( bph + 0.035, bph - 0.035, kph + kn * 0.035 );
      diffuseColor.rgb = mix( c, uBelly, belly );
    }`,
    fragmentAlbedo: /* glsl */`
    {
      float kx = vLoft.x, kph = qlSide( vLoft.yz ), ks = vSurf.x, kH = max( vSurf.y, 1.0 ), kbn = clamp( ks / kH, 0.0, 1.0 );
      vec3 jq = vec3( kx * 0.05, ks * 0.05, uInkTime * 0.731 );     // 手绘抖动（一拍二）
      float jx = toonNoise( jq ) * 0.5, js = toonNoise( jq + 19.1 ) * 0.5;
      float kn = toonNoise( vec3( kx * 0.018, ks * 0.03, 3.1 ) );
      float bph = qlBellyPh( kx );
      float belly = toonSS( bph + 0.035, bph - 0.035, kph + kn * 0.035 );
      float Rl = kH / 1.5708;                                        // 局部截面半径（弧度 → 长度）
      float gold = 0.0, inMotif = 0.0;
      // 1) 鳃盖线（金线 + 后面一道细墨线）
      float gx = 150.0 - 13.0 * sin( 3.14159 * clamp( ( kbn - 0.06 ) / 0.62, 0.0, 1.0 ) );
      float gm = toonSS( 0.04, 0.12, kbn ) * toonSS( 0.7, 0.6, kbn ) * ( 1.0 - belly );
      gold = max( gold, toonLine( kx + jx - gx, 0.65 ) * gm );
      toonInk = max( toonInk, toonLine( kx + jx - gx + 1.6, 0.3 ) * gm * 0.55 );
      // 2) 祥云纹（体侧），先画，好让鳞片让开
      ${motifGlsl(MOTIFS, 'uCloudFill')}
      ${motifGlsl(HEADM, 'mix( diffuseColor.rgb, uBelly, 0.42 )')}
      // 3) 鱼鳞：鳃盖后、白腹以外、祥云以外
      float zone = toonSS( gx + 1.0, gx - 7.0, kx ) * ( 1.0 - belly ) * toonSS( -222.0, -210.0, kx ) * ( 1.0 - inMotif );
      if ( zone > 0.001 ) {
        vec2 q = vec2( vSurf.z, kbn * ${NROWS.toFixed(1)} ) + vec2( jx, js ) * 0.025;
        vec4 sc = qlScale( q );
        float fq = length( fwidth( q * vec2( ${ASPECT.toFixed(3)}, 1.0 ) ) );
        float lw = 0.05;
        float ln = 1.0 - smoothstep( lw - fq * 0.75, lw + fq * 0.75, sc.x );
        float dens = 1.0 - smoothstep( 0.14, 0.32, fq );
        gold = max( gold, ln * zone * dens * 0.92 );
        diffuseColor.rgb *= 1.0 - 0.12 * ( 1.0 - smoothstep( 0.0, 0.34, sc.x ) ) * zone;
        diffuseColor.rgb *= 1.0 + ( sc.w - 0.5 ) * 0.08 * zone;
      }
      // 4) 眉线、眼下线（眼睛局部坐标，单位 RE：x 向前，y 向背）：眉弧罩住眼睛、往后拖成一缕，尾端卷成云头
      {
        vec2 de = vec2( kx + jx * 0.3 - uKunEye.x, -( ks + js * 0.3 - uKunEye.w ) ) / uKunEye.z;
        float RE = uKunEye.z;
        float ang = atan( de.y, de.x ), rr = length( de * vec2( 0.92, 1.0 ) );
        float arcM = toonSS( 0.15, 0.32, ang ) * toonSS( 1.75, 1.55, ang );
        float wA = mix( 0.05, 0.1, toonSS( 0.2, 1.3, ang ) );
        float brow = toonLine( ( rr - 1.38 ) * RE, wA * RE ) * arcM;
        float tx = clamp( -de.x, 0.0, 3.6 );
        float ty = 1.38 + 0.05 * tx + 0.09 * sin( tx * 1.9 );
        float tailM = toonSS( 0.05, 0.25, -de.x ) * toonSS( 3.75, 3.5, -de.x );
        float wT = mix( 0.1, 0.045, tx / 3.6 );
        brow = max( brow, toonLine( ( de.y - ty ) * RE, wT * RE ) * tailM );
        brow = max( brow, toonLine( qlCurl( de, vec2( -3.95, 1.86 ), 0.46, 1.0 ) * RE, 0.36 ) );
        gold = max( gold, brow );
        float lx = clamp( -de.x, -0.4, 3.0 );
        float ly = -1.12 - 0.05 * lx + 0.06 * sin( lx * 2.2 );
        float lowM = toonSS( -0.6, -0.2, -de.x ) * toonSS( 3.1, 2.7, -de.x );
        gold = max( gold, toonLine( ( de.y - ly ) * RE, mix( 0.05, 0.025, clamp( lx / 3.0, 0.0, 1.0 ) ) * RE ) * lowM * 0.85 );
        float ly2 = -1.62 - 0.08 * lx + 0.08 * sin( lx * 1.8 + 0.6 );
        float lowM2 = toonSS( -0.1, 0.4, -de.x ) * toonSS( 3.4, 2.9, -de.x );
        gold = max( gold, toonLine( ( de.y - ly2 ) * RE, mix( 0.035, 0.018, clamp( lx / 3.0, 0.0, 1.0 ) ) * RE ) * lowM2 * 0.7 );
        toonInk = max( toonInk, toonLine( qlSeg( de, vec2( -0.82, 0.02 ), vec2( -1.9, -0.2 ) ) * RE, 0.42 ) * toonSS( -0.78, -0.95, de.x ) );
      }
      // 5) 嘴线：上唇一道暗红 + 墨线；嘴角下撇
      {
        float pm = qlMouth( kx );
        float dm = ( kph + js * 0.004 - pm ) * Rl;
        float mm = toonSS( 301.0, 297.0, kx ) * toonSS( 196.0, 202.0, kx );
        diffuseColor.rgb = mix( diffuseColor.rgb, uLip, toonSS( 2.2, 0.6, dm ) * step( 0.0, dm ) * mm * 0.85 );
        toonInk = max( toonInk, toonLine( dm, 0.55 ) * mm );
      }
      // 6) 下颌、前腹的褶纹（牙白上的淡金细线，越往后越收）
      {
        float beta = kph + 1.5708, psi = max( bph + 1.5708, 0.05 );
        float q = beta / psi * 9.0 + toonNoise( vec3( kx * 0.03, beta * 3.0, 7.7 ) ) * 0.08;
        float dq = ( fract( q + 0.5 ) - 0.5 ) * psi / 9.0 * Rl;
        float pz = belly * toonSS( 40.0, 95.0, kx ) * toonSS( 297.0, 284.0, kx ) * toonSS( 0.94, 0.86, beta / psi );
        diffuseColor.rgb = mix( diffuseColor.rgb, uBellyLine, toonLine( dq, 0.28 ) * pz * 0.7 );
      }
      toonGold = vec4( uGold, clamp( gold, 0.0, 1.0 ) );
      toonOverlay = vec4( uCloudFill, inMotif * 0.32 * ( 1.0 - gold ) );
    }`,
  });
  const body = add(group, bindToon(new THREE.Mesh(bodyGeo, bodyMat), bodyMat));
  body.name = 'kun-body'; body.frustumCulled = false;

  // ═════════════════════════ 鳍：半透明长鳍（折扇） ═════════════════════════
  const finMats = [];
  const FIN_COLS = {
    pec: { root: '#1c7d7a', mid: '#2f9fae', blue: '#3a74c8', edge: '#cdeee6' },
    tail: { root: '#1b6f7c', mid: '#2884b0', blue: '#2c5cb4', edge: '#a9e2dc' },
  };
  const finMat = ({ mode = 'none', flutA = 3, flutPh = 0, flutW = 1, rays = 10, alpha = 1, cols = FIN_COLS.pec, rayW = 0.34 }) => {
    const ex = { uFlutA: { value: flutA }, uFlutPh: { value: flutPh }, uFlutW: { value: flutW } };
    const m = toon({
      side: THREE.DoubleSide, transparent: true, depthWrite: false,
      shade1Tint: [0.74, 0.82, 0.94], shade2Tint: [0.56, 0.64, 0.84], step2: 0.15,
      rimAmt: 0.3, rimLitAmt: 0.55, fillAmt: 0.28, fillFlat: 0.45, skyAmt: 0.35,
      transColor: '#8fe6d6', transPow: 1.6, outlineW: 0.5,
      uniforms: { ...ex, uRays: { value: rays }, uRayW: { value: rayW }, uFinAlpha: { value: alpha }, uFinRoot: { value: col(cols.root) }, uFinMid: { value: col(cols.mid) }, uFinBlue: { value: col(cols.blue) }, uFinEdge: { value: col(cols.edge) }, uGold: { value: col(C.gold) } },
      ...hooks(U, {
        mode, extraUniforms: ex,
        dispPars: 'attribute vec3 aFin;\nattribute vec3 aFinN;\nuniform float uFlutA, uFlutPh, uFlutW;\n',
        disp: '{ float fu = aFin.x; transformed += aFinN * ( uFlutA * fu * fu * sin( uKunT * uKunOmega * uFlutW - fu * 3.4 + uFlutPh + aFin.y * 0.5 ) ); }',
        varPars: 'varying vec3 vFin;\n', varBegin: 'vFin = aFin;',
      }),
      fragmentPars: 'varying vec3 vFin;\nuniform float uRays, uRayW, uFinAlpha;\nuniform vec3 uFinRoot, uFinMid, uFinBlue, uFinEdge, uGold;\n',
      fragmentBase: /* glsl */`
      {
        float u = vFin.x, av = abs( vFin.y );
        vec3 c = mix( uFinRoot, uFinMid, toonSS( 0.0, 0.4, u ) );
        c = mix( c, uFinBlue, toonSS( 0.25, 0.7, u ) * toonSS( 1.0, 0.3, av ) * 0.55 );
        c = mix( c, uFinEdge, toonSS( 0.78, 1.0, max( u * 0.9, av * 0.92 ) ) * 0.8 );
        diffuseColor.rgb = c;
        diffuseColor.a = mix( 0.97, 0.5, toonSS( 0.04, 0.8, max( u, av * 0.75 ) ) ) * uFinAlpha;
      }`,
      fragmentAlbedo: /* glsl */`
      {
        float u = vFin.x, v = vFin.y, w = max( vFin.z, 0.01 );
        float rq = v * uRays * 0.5;
        float dr = ( fract( rq + 0.5 ) - 0.5 ) / ( uRays * 0.5 ) * w;
        float ray = toonLine( dr, uRayW ) * toonSS( 0.02, 0.1, u ) * ( 1.0 - toonSS( 0.9, 1.0, u ) * 0.4 );
        float edge = toonLine( ( 1.0 - abs( v ) ) * w, 0.6 );
        float g = max( ray * 0.9, edge );
        toonGold = vec4( uGold, g );
        diffuseColor.a = max( diffuseColor.a, g * 0.95 * uFinAlpha );
        toonTrans = 1.0 - g;
      }`,
    });
    finMats.push(m);
    return m;
  };
  // 透明鳍：彩色通道正常混合、不写深度；法线/ID 通道（uToonPass=1）改成不混合、写深度 → 描边、空气透视都按鳍自己的深度算
  // （look.js 的 ID 图本来就把描边物体当实心画，两边一致）
  const finMesh = (geo, mat, name) => {
    const m = bindToon(new THREE.Mesh(geo, mat), mat, { castShadow: false });
    m.name = name; m.frustumCulled = false;
    m.onBeforeRender = () => { const p = TOON_SHARED.uToonPass.value > 0.5; mat.blending = p ? THREE.NoBlending : THREE.NormalBlending; mat.depthWrite = p; };
    return m;
  };

  // —— 尾鳍：两片大扇（深叉）+ 中间三片短扇，竖在 XY 平面，逐顶点弯（随脊柱横摆）——
  const PED = V3(-204, yMid(-208), 0);
  const tailLeaves = [
    { L: 150, W: 36, a: 44, curl: -0.09, z: -0.6 }, { L: 158, W: 38, a: -47, curl: 0.09, z: 0.6 },
    { L: 104, W: 25, a: 22, curl: -0.05, z: -1.4 }, { L: 108, W: 26, a: -24, curl: 0.05, z: 1.4 }, { L: 60, W: 18, a: -2, curl: 0, z: 0 },
  ];
  const tailGeos = tailLeaves.map((t, i) => {
    const g = geoLeaf({ L: t.L, W: t.W, droop: 0.0, cup: 0.04, curl: t.curl, wave: 0.07, asym: 0.12, rootW: 0.28, seed: o.seed + 70 + i });
    const a = THREE.MathUtils.degToRad(180 - t.a);
    return bakeLeaf(g, basisAt(PED.clone().add(V3(0, 0, t.z)), V3(Math.cos(a), Math.sin(a), 0), V3(0, 0, 1)));
  });
  const tailMat = finMat({ mode: 'vertex', flutA: 6, flutPh: 0.6, flutW: 1, rays: 12, cols: FIN_COLS.tail, rayW: 0.45 });
  add(group, finMesh(mergeGeometries(tailGeos), tailMat, 'kun-tail'));

  // —— 腹鳍（一对）、臀鳍（正中）：细长下垂，逐顶点弯 ——
  const lowGeos = [];
  for (const side of [1, -1]) {
    const ph = -1.12, r = bodyPoint(-42, phiOf(ph, side)), n = bodyNormal(-42, phiOf(ph, side));
    r.addScaledVector(n, -2.5);
    [{ L: 74, W: 13, a: 0 }, { L: 58, W: 11, a: -0.24 }].forEach((lf, i) => {
      const d = V3(-0.8, -0.56, 0.24 * side).normalize().applyAxisAngle(V3(0, 0, side), lf.a * side);
      const g = geoLeaf({ L: lf.L, W: lf.W, droop: 0.05, cup: 0.08, curl: -0.05, seed: o.seed + 90 + i + (side > 0 ? 0 : 5) });
      lowGeos.push(bakeLeaf(g, basisAt(r.clone().addScaledVector(n, i * 1.2), d, V3(0, 0.25, side))));
    });
  }
  {
    const r = V3(-152, fB(-152) + 2.5, 0);
    [{ L: 80, W: 15, a: 0.06, z: -0.7 }, { L: 62, W: 12, a: -0.22, z: 0.7 }].forEach((lf, i) => {
      const d = V3(-0.82, -0.57, 0).normalize().applyAxisAngle(V3(0, 0, 1), lf.a);
      const g = geoLeaf({ L: lf.L, W: lf.W, droop: 0.0, cup: 0.05, curl: -0.04, seed: o.seed + 110 + i });
      lowGeos.push(bakeLeaf(g, basisAt(r.clone().add(V3(0, 0, lf.z)), d, V3(0, 0, 1))));
    });
  }
  const lowMat = finMat({ mode: 'vertex', flutA: 3.5, flutPh: 1.7, flutW: 1, rays: 8 });
  add(group, finMesh(mergeGeometries(lowGeos), lowMat, 'kun-lowfins'));

  // —— 胸鳍：三片长鳍叠成折扇（刚体，CPU 摆位：开合 + 划水 + 前后摆），鳍膜在顶点着色器里扑动 ——
  const fins = [];
  const FAN = [{ L: 198, W: 30, a: 0.24, off: -1.2 }, { L: 214, W: 33, a: 0, off: 0 }, { L: 168, W: 26, a: -0.25, off: 1.2 }];
  for (const side of [1, -1]) {
    const x0 = 146, ph = -0.6;
    const root = bodyPoint(x0, phiOf(ph, side)), nrm = bodyNormal(x0, phiOf(ph, side));
    root.addScaledVector(nrm, -3);
    const pivot = new THREE.Group(); pivot.name = 'kun-fin-' + (side > 0 ? 'R' : 'L');
    pivot.position.copy(root);
    const leaves = FAN.map((f, i) => {
      const g = geoLeaf({ L: f.L, W: f.W, droop: 0.1, cup: 0.14, curl: -0.07, wave: 0.07, asym: -0.22, twist: 0.55 * side, seed: o.seed + 130 + i + (side > 0 ? 0 : 7) });
      const m = finMat({ mode: 'none', flutA: 4.5, flutPh: i * 0.7 + (side > 0 ? 0 : 0.4), flutW: 1, rays: 10 });
      const mesh = finMesh(g, m, `kun-fin-${side > 0 ? 'R' : 'L'}${i}`);
      mesh.renderOrder = 3 + (side > 0 ? i : 2 - i);
      pivot.add(mesh); outlineMeshes.push(mesh);
      return { mesh, ...f };
    });
    group.add(pivot);
    fins.push({ side, pivot, leaves, root, x0 });
  }

  // ═════════════════════════ 龙须（两对，长、细、随波飘） ═════════════════════════
  const whiskGeos = [];
  const WHISK = [
    { x: 278, len: 1.0, pts: [[0, 0, 0], [3, -7, 4], [1, -24, 8], [-8, -44, 11], [-22, -60, 12], [-34, -70, 12], [-38, -84, 11], [-30, -94, 10], [-22, -90, 9]] },
    { x: 238, len: 1.0, pts: [[0, 0, 0], [0, -10, 5], [-10, -36, 12], [-30, -64, 16], [-52, -92, 17], [-64, -124, 15], [-60, -154, 12], [-44, -172, 10], [-26, -176, 9]] },
  ];
  WHISK.forEach((w, wi) => {
    for (const side of [1, -1]) {
      const ph = mouthPh(w.x) + 0.05, rp = bodyPoint(w.x, phiOf(ph, side)), rn = bodyNormal(w.x, phiOf(ph, side));
      rp.addScaledVector(rn, -0.8);
      const curve = new THREE.CatmullRomCurve3(w.pts.map(([dx, dy, dz]) => rp.clone().add(V3(dx, dy, dz * side))));
      const TS = 90, RS = 8;
      const g = new THREE.TubeGeometry(curve, TS, 1, RS, false);
      const p = g.attributes.position, nn = g.attributes.normal, along = new Float32Array(p.count), wk = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const seg = Math.floor(i / (RS + 1)), t = seg / TS, c = curve.getPointAt(t);
        const r = lerp(2.3, 0.35, Math.pow(t, 0.7)) * (1 + 0.3 * sstep(0.05, 0, t));
        p.setXYZ(i, c.x + nn.getX(i) * r, c.y + nn.getY(i) * r, c.z + nn.getZ(i) * r);
        along[i] = t; wk[i * 3] = side; wk[i * 3 + 1] = wi; wk[i * 3 + 2] = wi * 1.7 + (side > 0 ? 0 : 0.9);
      }
      g.deleteAttribute('uv'); g.computeVertexNormals();
      g.setAttribute('aAlong', new THREE.BufferAttribute(along, 1)); g.setAttribute('aWhisk', new THREE.BufferAttribute(wk, 3));
      whiskGeos.push(g);
    }
  });
  const whiskMat = toon({
    color: '#f3dea4', shade1: '#d2b06e', shade2: '#a3845a', outlineW: 0.75, rimAmt: 0.55, fillAmt: 0.6,
    uniforms: { uGold: { value: col(C.gold) } }, fragmentPars: 'uniform vec3 uGold;\n',
    fragmentAlbedo: 'toonGold = vec4( uGold, 0.42 );',
    ...hooks(U, {
      mode: 'none',
      dispPars: 'attribute float aAlong;\nattribute vec3 aWhisk;\n',
      disp: /* glsl */`
      {
        float t = aAlong, k = pow( t, 1.5 );
        float w = 6.2831853 / 2.5;
        transformed.x += k * 13.0 * sin( uKunT * w - t * 4.0 + aWhisk.z );
        transformed.z += aWhisk.x * k * 9.0 * sin( uKunT * w * 0.8 - t * 3.0 + aWhisk.z + 1.3 );
        transformed.y += k * 3.0 * sin( uKunT * w * 1.3 - t * 5.0 + aWhisk.z );
      }`,
    }),
  });
  const whiskers = add(group, bindToon(new THREE.Mesh(mergeGeometries(whiskGeos), whiskMat), whiskMat));
  whiskers.name = 'kun-whiskers'; whiskers.frustumCulled = false;

  // ═════════════════════════ 眼睛（金眼） ═════════════════════════
  const makeSclera = () => makeToonMaterial({ color: '#f1e3c2', shade1: '#c9b48e', shade2: '#8a7a74', step1: 0.45, step2: 0.16, rimAmt: 0.5, rimInside: 0.5, rimColor: PALETTE.pink,
    fillAmt: 0.6, fillFlat: 0.35, fillColor: PALETTE.kunBelly, skyAmt: 0.5, outlineW: 1,
    uniforms: {
      uIrisA: { value: 0.8 }, uPupilA: { value: 0.29 },
      uIrisCol: { value: col('#c97d12') }, uIrisCol2: { value: col('#ffd552') }, uRingCol: { value: col('#4a280c') }, uPupilCol: { value: col('#100b08') },
      uReflCol: { value: col('#c9b8ef') },
      uCatch1: { value: new THREE.Vector4(0, 0, 1, 0.985) }, uCatch2: { value: new THREE.Vector4(0, 0, 1, 0.997) }, uCatchCol: { value: col('#fffaf2') },
      uLidU: { value: V3(0, 1, 0) }, uLidL: { value: V3(0, -1, 0) },
    },
    fragmentPars: 'uniform float uIrisA, uPupilA;\nuniform vec3 uIrisCol, uIrisCol2, uRingCol, uPupilCol, uCatchCol, uLidU, uLidL, uReflCol;\nuniform vec4 uCatch1, uCatch2;\n',
    fragmentAlbedo: /* glsl */`
    {
      vec3 d = normalize( vToonObj );
      float ang = acos( clamp( d.z, -1.0, 1.0 ) ) + toonNoise( vec3( d.xy * 6.0, uInkTime * 0.731 ) ) * 0.006;
      float fa = max( fwidth( ang ), 1e-5 );
      float iris = 1.0 - smoothstep( uIrisA - fa, uIrisA + fa, ang );
      float pa = length( vec2( atan( d.x, d.z ) * 1.0, atan( d.y, d.z ) * 0.92 ) );
      float fp = max( fwidth( pa ), 1e-5 );
      float pupil = 1.0 - smoothstep( uPupilA - fp, uPupilA + fp, pa );
      float az = atan( d.y, d.x );
      float stri = 0.5 + 0.5 * sin( az * 30.0 + toonNoise( d * 7.0 ) * 3.0 );
      float rad = smoothstep( uPupilA, uIrisA, ang );
      vec3 ic = mix( uIrisCol2, uIrisCol, smoothstep( 0.3, 0.85, rad ) );
      ic = mix( ic, ic * 0.78, step( 0.62, stri ) * rad );
      float collar = smoothstep( uIrisA - 0.07 - fa, uIrisA - 0.07 + fa, ang ) * iris;
      ic = mix( ic, uRingCol, collar * 0.85 );
      diffuseColor.rgb = mix( diffuseColor.rgb, ic, iris );
      diffuseColor.rgb = mix( diffuseColor.rgb, uPupilCol, pupil );
      toonInk = max( toonInk, ( 1.0 - smoothstep( 0.7 * fa, 2.2 * fa, abs( ang - uIrisA ) ) ) * 0.95 );
      toonGlow += iris * ( 1.0 - pupil ) * ( 1.0 - collar ) * vec3( 0.16, 0.09, 0.0 ) * ( 1.0 - rad * 0.5 );
      float c1 = dot( d, uCatch1.xyz ), c2 = dot( d, uCatch2.xyz );
      float fc = max( fwidth( c1 ), 1e-5 );
      float k = max( smoothstep( uCatch1.w - fc, uCatch1.w + fc, c1 ), smoothstep( uCatch2.w - fc, uCatch2.w + fc, c2 ) );
      float du = dot( d, uLidU ), dl = dot( d, uLidL ), fd = max( fwidth( du ), 1e-5 );
      float front = smoothstep( 0.1, 0.6, d.z );
      float lash = ( 1.0 - smoothstep( 0.1 * front + 0.02 - fd, 0.1 * front + 0.02 + fd, - du ) ) * front;
      float low = ( 1.0 - smoothstep( 0.03 - fd, 0.03 + fd, - dl ) ) * front;
      toonInk = max( toonInk, max( lash * 0.92, low * 0.6 ) );
      float refl = smoothstep( -0.5, -0.4, du ) * ( 1.0 - smoothstep( -0.3, -0.22, du ) ) * smoothstep( 0.35, 0.75, d.z ) * iris * ( 1.0 - pupil );
      toonOverlay = vec4( uReflCol, refl * 0.25 );
      toonOverlay = mix( toonOverlay, vec4( uCatchCol, 1.0 ), k * ( 1.0 - lash ) );
    }`,
  });
  // 眼睑：和头同色（石青），边缘一道墨线、一道金线
  const lidMat = toon({ color: C.qingDeep, rustTint: [0.62, 0.7, 1.0], rustAmt: 0.3, patchScale: 0.08, side: THREE.DoubleSide, fillAmt: 0.18, objectId: bodyMat.userData.toon.uObjectId.value,
    uniforms: { uGold: { value: col(C.gold) } }, fragmentPars: 'uniform vec3 uGold;\n',
    fragmentAlbedo: /* glsl */`
    {
      vec3 d = normalize( vToonObj );
      float e = asin( clamp( abs( d.y ), 0.0, 1.0 ) ), fe = max( fwidth( e ), 1e-5 );
      float front = smoothstep( 0.15, 0.55, d.z );
      float rim = 1.0 - smoothstep( 0.07 - fe, 0.07 + fe, e );
      float fold = ( 1.0 - smoothstep( 0.8 * fe, 1.9 * fe, abs( e - 0.3 ) ) ) * smoothstep( 0.35, 0.7, d.z );
      toonInk = max( toonInk, rim * front * 0.85 );
      toonGold = vec4( uGold, fold * 0.9 );
      if ( ! gl_FrontFacing ) diffuseColor.rgb *= vec3( 0.35, 0.3, 0.5 );     // 眼睑内侧
    }` });
  const eyes = mountEyes({ point: bodyPoint, normal: bodyNormal, x: EYE_X, ph: EYE_PH, inset: 0.6 * RE, gaze: [0.25, -0.1], parent: group, build: (side, eg) => {
    eg.name = 'kun-eye-' + (side > 0 ? 'R' : 'L');
    const scleraMat = makeSclera();
    const ball = add(eg, bindToon(new THREE.Mesh(new THREE.SphereGeometry(RE, 48, 32), scleraMat), scleraMat, { castShadow: false }));
    const lidU = new THREE.Group(), lidL = new THREE.Group(), [shellU, shellL] = lidShells(RE * 1.07, 40, 12);
    add(lidU, bindToon(new THREE.Mesh(shellU, lidMat), lidMat));
    add(lidL, bindToon(new THREE.Mesh(shellL, lidMat), lidMat));
    eg.add(lidU, lidL);
    return { ball, lidU, lidL, mat: scleraMat, frame: eyeFrame(scleraMat.userData.toon) };
  } });

  // ═════════════════════════ 背上的仙岛 ═════════════════════════
  // 三层台地（T1 贴着背、T2 中层、T3 亭台）+ 前端一个小台（T4，驮大松）
  const MESAS = [
    { cx: 12, cz: 0, rx: 150, rz: 36, top: t1Top, bot: (x, z) => surfY(x, z) - 9, dome: 0.8, seed: 1 },
    { cx: -20, cz: 2, rx: 70, rz: 24, top: () => 78, bot: () => 48, seed: 2 },
    { cx: -30, cz: -10, rx: 22, rz: 15, top: () => 90, bot: () => 48, seed: 3 },
    { cx: 100, cz: 2, rx: 38, rz: 24, top: () => 74, bot: () => 48, seed: 4 },
  ];
  const mesaGeos = MESAS.map((m) => {
    const RR = mulberry(o.seed + 500 + m.seed);
    const g = geoMesa(RR, { cx: m.cx, cz: m.cz, rx: m.rx, rz: m.rz, yTop: m.top, yBot: m.bot, dome: m.dome ?? 2.2, seed: m.seed * 0.137 });
    // 记下轮廓函数（瀑布找崖口用；和 geoMesa 里同一组随机数）
    m.rim = g.userData.rim;
    return g;
  });
  // 山石材质（台地、尖峰共用一套着色：下绿上青、台面嫩绿、山脚赭石、竖向皴线、苔点）
  const rockMat = (mode, blueAt = 0.55, extra = {}) => toon({
    shade1Tint: [0.58, 0.66, 0.86], shade2Tint: [0.34, 0.4, 0.66], step1: 0.52, step2: 0.22,
    rustTint: [0.66, 0.74, 1.0], rustAmt: 0.42, rustThr: 0.14, patchScale: 0.03, dabAmt: 0.1, dabScale: 0.11,
    fillAmt: 0.5, skyAmt: 0.75, rimAmt: 0.55, edgeNoise: 0.06, edgeNoiseScale: 0.09,
    uniforms: { uMesa: { value: blueAt > 0.8 ? 1 : 0 }, uBlueAt: { value: blueAt }, uRockGreen: { value: col(C.rockGreen) }, uRockBlue: { value: col(C.rockBlue) }, uRockDeep: { value: col(C.rockDeep) }, uRockTop: { value: col(C.rockTop) }, uRockTop2: { value: col(C.rockTop2) }, uRockOchre: { value: col(C.rockOchre) }, uGold: { value: col(C.gold) } },
    ...hooks(U, { mode, varPars: 'attribute vec4 aRock;\nvarying vec4 vRock;\nvarying vec3 vRockN;\n', varBegin: 'vRock = aRock; vRockN = normal;' }),
    fragmentPars: 'varying vec4 vRock;\nvarying vec3 vRockN;\nuniform float uBlueAt, uMesa;\nuniform vec3 uRockGreen, uRockBlue, uRockDeep, uRockTop, uRockTop2, uRockOchre, uGold;\n',
    fragmentBase: /* glsl */`
    {
      float hf = vRock.x, up = normalize( vRockN ).y;
      float n1 = toonNoise( vToonObj * 0.05 + vRock.w * 13.0 ), n2 = toonNoise( vToonObj * 0.14 + 7.0 );
      vec3 c = mix( uRockGreen, uRockBlue, toonSS( uBlueAt - 0.18, uBlueAt + 0.2, hf + n1 * 0.12 ) );
      c = mix( c, uRockDeep, toonSS( 0.82, 1.0, hf ) * 0.45 );
      float top = max( toonSS( 0.6, 0.78, up + n2 * 0.14 ), uMesa * step( 0.995, hf ) * toonSS( -0.6, 0.0, up ) );
      c = mix( c, mix( uRockTop, uRockTop2, toonSS( -0.3, 0.4, n1 ) ), top );
      c = mix( c, uRockOchre, toonSS( 0.14, 0.03, hf ) * 0.55 * ( 1.0 - top ) );
      diffuseColor.rgb = c;
    }`,
    fragmentAlbedo: /* glsl */`
    {
      float hf = vRock.x, up = normalize( vRockN ).y;
      // 皴线：绕轴的竖向细线（断续、微抖），只画在陡面
      float ang = atan( vRock.z, vRock.y ) / 6.2831853;
      float f = ang * 10.0 + toonNoise( vec3( hf * 5.0, vRock.w * 7.0, uInkTime * 0.37 ) ) * 0.35 + toonNoise( vToonObj * 0.08 ) * 0.25;
      float dd = ( fract( f + 0.5 ) - 0.5 );
      float fw = max( fwidth( f ), 1e-4 );
      float cun = ( 1.0 - smoothstep( 0.075 - fw, 0.075 + fw, abs( dd ) ) ) * toonSS( 0.55, 0.25, abs( up ) ) * toonSS( 0.05, 0.2, hf );
      cun *= smoothstep( -0.2, 0.25, toonNoise( vec3( ang * 40.0, hf * 9.0, vRock.w ) ) );
      cun *= 1.0 - smoothstep( 0.08, 0.3, fw );
      toonInk = max( toonInk, cun * 0.58 );
      // 苔点：台面上的深绿小点
      vec3 Q = vToonObj * 0.42;
      float dn = toonNoise( Q ), fdn = max( fwidth( dn ), 1e-4 );
      float dot1 = smoothstep( 0.48 - fdn, 0.48 + fdn, dn ) * toonSS( 0.55, 0.8, up );
      diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.03, 0.16, 0.08 ), dot1 * 0.75 );
    }`,
    ...extra,
  });
  const mesaMat = rockMat('vertex', 0.86);
  const mesas = add(group, bindToon(new THREE.Mesh(mergeGeometries(mesaGeos), mesaMat), mesaMat));
  mesas.name = 'kun-isle-mesas'; mesas.frustumCulled = false;

  // 十座尖峰（主峰在亭后；镜头侧几座矮的；每座带 1–2 个副峰）
  const PEAKS = [
    { x: -60, z: 10, base: 74, top: 200, r: 30, steps: 6, sub: 4 },
    { x: -4, z: 14, base: 74, top: 158, r: 22, steps: 5, sub: 3 },
    { x: 40, z: 6, base: 74, top: 140, r: 19, steps: 5, sub: 2 },
    { x: -102, z: 6, base: 'T1', top: 146, r: 21, steps: 5, sub: 3 },
    { x: -134, z: -3, base: 'T1', top: 104, r: 15, steps: 4, sub: 2 },
    { x: 130, z: 5, base: 70, top: 124, r: 16, steps: 4, sub: 2 },
    { x: 162, z: -2, base: 'T1', top: 98, r: 12, steps: 3, sub: 1 },
    { x: -86, z: -18, base: 'T1', top: 118, r: 13, steps: 4, sub: 1 },
    { x: 18, z: -24, base: 'T1', top: 104, r: 11, steps: 4, sub: 1 },
    { x: -34, z: 26, base: 'T1', top: 160, r: 16, steps: 5, sub: 2 },
    { x: 78, z: 18, base: 'T1', top: 112, r: 13, steps: 4, sub: 1 },
  ];
  for (const pk of PEAKS) if (pk.base === 'T1') pk.base = t1Top(pk.x, pk.z) - 1;
  const peakGeos = [];
  PEAKS.forEach((pk, i) => {
    const RR = mulberry(o.seed + 600 + i * 17);
    const H = (pk.top - pk.base + 6) * 1.12, lean = [(RR() - 0.5) * 0.2, (RR() - 0.5) * 0.14];
    const parts = [geoPeak(RR, H, pk.r, { steps: pk.steps, lean, seed: i * 0.071 })];
    for (let s2 = 0; s2 < pk.sub; s2++) {
      const k = 0.42 + RR() * 0.32, a = (s2 / Math.max(1, pk.sub) + RR() * 0.2) * TAU, d = pk.r * (0.6 + RR() * 0.35);
      const g = geoPeak(RR, H * k, pk.r * (0.48 + RR() * 0.2), { steps: Math.max(2, pk.steps - 1), lean: [Math.cos(a) * 0.12, Math.sin(a) * 0.1], hfScale: k, seed: i * 0.071 + 0.03 });
      g.translate(Math.cos(a) * d, 0, Math.sin(a) * d * 0.85);
      parts.push(g);
    }
    { const g = geoPeak(RR, H * 0.22, pk.r * 1.25, { steps: 1, lean: [0, 0], hfScale: 0.22, seed: i * 0.071 + 0.05, NH: 12 }); parts.push(g); }
    const g = mergeGeometries(parts.map(p => p.index ? p.toNonIndexed() : p));
    g.translate(pk.x, pk.base - 6, pk.z);
    const an = new Float32Array(g.attributes.position.count).fill(pk.x);
    g.setAttribute('aAnchor', new THREE.BufferAttribute(an, 1));
    peakGeos.push(g);
  });
  const peakGeo = mergeGeometries(peakGeos);
  const peakMat = rockMat('rigid', 0.5);
  const peaks = add(group, bindToon(new THREE.Mesh(peakGeo, peakMat), peakMat));
  peaks.name = 'kun-isle-peaks'; peaks.frustumCulled = false;

  // 红柱六角亭（T3 上），石阶下到 T2
  const PAV = V3(-30, 90, -10);
  const pavGeo = geoPavilion(90 - 78);
  pavGeo.rotateY(-1.1); pavGeo.translate(PAV.x, PAV.y, PAV.z);      // 石阶朝 +X 偏镜头一侧，下到 T2
  pavGeo.setAttribute('aAnchor', new THREE.BufferAttribute(new Float32Array(pavGeo.attributes.position.count).fill(PAV.x), 1));
  const pavMat = toon({
    shade1Tint: [0.6, 0.58, 0.78], shade2Tint: [0.38, 0.36, 0.6], step1: 0.5, step2: 0.2, rimAmt: 0.55, fillAmt: 0.5, outlineW: 0.85,
    uniforms: { uGold: { value: col(C.gold) } },
    ...hooks(U, { mode: 'rigid', varPars: 'attribute vec3 aCol;\nattribute float aTrim;\nvarying vec3 vCol;\nvarying float vTrim;\n', varBegin: 'vCol = aCol; vTrim = aTrim;' }),
    fragmentPars: 'varying vec3 vCol;\nvarying float vTrim;\nuniform vec3 uGold;\n',
    fragmentBase: 'diffuseColor.rgb = vCol;',
    fragmentAlbedo: 'toonGold = vec4( uGold, smoothstep( 0.4, 0.7, vTrim ) );',
  });
  const pav = add(group, bindToon(new THREE.Mesh(pavGeo, pavMat), pavMat));
  pav.name = 'kun-isle-pavilion'; pav.frustumCulled = false;

  // —— 瀑布：从台地崖口泻下，贴着体侧往下流，落进云团。aWf = (沿程 t, 横向 -1..1, 半宽)；aWfSide = 横向单位向量 ——
  const falls = [], fallClouds = [];
  function fallPath({ x0, side, mesa, phEnd, w0, w1, off = 3.5, dropTo = null }) {
    const m = MESAS[mesa];
    const zE = mesaEdgeZ(m, x0, side), yTop = m.top(x0, zE) + 0.4;
    const pts = [V3(x0, yTop + 0.3, zE - side * 4), V3(x0, yTop + 0.6, zE + side * 0.5), V3(x0, yTop - 1.5, zE + side * 3)];
    const nr = [V3(0, 1, 0), V3(0, 0.6, side).normalize(), V3(0, 0, side)];
    if (dropTo !== null) {                                 // 落到下一层台地上
      for (let i = 1; i <= 6; i++) { const y = lerp(yTop - 1.5, dropTo, i / 6); pts.push(V3(x0, y, zE + side * (3 + i * 0.25))); nr.push(V3(0, 0, side)); }
      return { pts, nr, w0, w1 };
    }
    // 找到身体表面 z 与崖口相当的那个侧向角，从那里贴着身体往下
    let ph0 = 1.3;
    for (let ph = 1.4; ph > 0; ph -= 0.01) { const p = bodyPoint(x0, phiOf(ph, side)); if (Math.abs(p.z) >= Math.abs(zE) + 2) { ph0 = ph; break; } }
    const pc = bodyPoint(x0, phiOf(ph0, side)), nc = bodyNormal(x0, phiOf(ph0, side));
    const contact = pc.clone().addScaledVector(nc, off);
    for (let i = 1; i <= 5; i++) { const y = lerp(yTop - 1.5, contact.y + 4, i / 5); pts.push(V3(x0, y, lerp(zE + side * 3, contact.z, Math.pow(i / 5, 2)))); nr.push(V3(0, 0, side)); }
    for (let i = 0; i <= 18; i++) {
      const ph = lerp(ph0, phEnd, i / 18), p = bodyPoint(x0, phiOf(ph, side)), n = bodyNormal(x0, phiOf(ph, side));
      pts.push(p.addScaledVector(n, off + i * 0.06)); nr.push(n);
    }
    return { pts, nr, w0, w1, contact };
  }
  function ribbon({ pts, nr, w0, w1 }, nT = 70, nA = 6) {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const lens = curve.getLengths(nT); const total = lens[lens.length - 1];
    const pos = [], wf = [], sideA = [], idx = [];
    for (let i = 0; i <= nT; i++) {
      const t = i / nT, P = curve.getPointAt(t), T = curve.getTangentAt(t);
      const f = t * (nr.length - 1), i0 = Math.min(nr.length - 2, Math.floor(f));
      const Nn = nr[i0].clone().lerp(nr[i0 + 1], f - i0).normalize();
      const A = V3().crossVectors(T, Nn).normalize();
      const hw = lerp(w0, w1, Math.pow(t, 0.7)) * (1 - 0.35 * sstep(0.85, 1, t));
      for (let j = 0; j <= nA; j++) {
        const v = j / nA * 2 - 1;
        const q = P.clone().addScaledVector(A, v * hw).addScaledVector(Nn, 0.6 * (1 - v * v));   // 中间略鼓
        pos.push(q.x, q.y, q.z); wf.push(t * total, v, hw); sideA.push(A.x, A.y, A.z);
      }
    }
    for (let i = 0; i < nT; i++) for (let j = 0; j < nA; j++) { const a = i * (nA + 1) + j, b = a + nA + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aWf', new THREE.Float32BufferAttribute(wf, 3));
    g.setAttribute('aWfSide', new THREE.Float32BufferAttribute(sideA, 3));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  }
  const FALLS = [
    { x0: 4, side: -1, mesa: 0, phEnd: -0.32, w0: 6.5, w1: 9, cloudAt: [[0.42, 13], [1.0, 22]] },
    { x0: -94, side: -1, mesa: 0, phEnd: 0.18, w0: 4.5, w1: 6.5, cloudAt: [[1.0, 15]] },
    { x0: 40, side: -1, mesa: 1, dropTo: 60, w0: 4, w1: 5, cloudAt: [[1.0, 9]] },
    { x0: -40, side: -1, mesa: 2, dropTo: 58, w0: 2.8, w1: 3.6, cloudAt: [[1.0, 7]] },
    { x0: -44, side: 1, mesa: 0, phEnd: 0.05, w0: 5, w1: 7, cloudAt: [[1.0, 15]] },
    { x0: 92, side: 1, mesa: 3, dropTo: 58, w0: 3.5, w1: 4.5, cloudAt: [[1.0, 8]] },
  ];
  for (const F of FALLS) {
    const path = fallPath(F);
    const g = ribbon(path);
    falls.push(g);
    const curve = new THREE.CatmullRomCurve3(path.pts, false, 'centripetal');
    for (const [t, s] of F.cloudAt) {
      const p = curve.getPointAt(Math.min(1, t)).clone();
      const n = path.nr[Math.min(path.nr.length - 1, Math.round(t * (path.nr.length - 1)))];
      fallClouds.push({ p: p.addScaledVector(n, s * 0.35), s });
    }
  }
  const waterMat = toon({
    color: '#ffffff', shade1Tint: [0.8, 0.84, 0.95], shade2Tint: [0.62, 0.66, 0.86], step1: 0.45, step2: 0.12,
    rimAmt: 0.35, rimLitAmt: 0.6, fillAmt: 0.55, fillFlat: 0.6, skyAmt: 0.3, outlineW: 0.55, side: THREE.DoubleSide,
    uniforms: { uWater: { value: col(C.water) }, uWaterShade: { value: col(C.waterShade) }, uInkTime: TOON_SHARED.uInkTime },
    ...hooks(U, {
      mode: 'vertex', extraUniforms: { uInkTime: TOON_SHARED.uInkTime },
      dispPars: 'attribute vec3 aWf;\nattribute vec3 aWfSide;\nuniform float uInkTime;\n',
      disp: /* glsl */`
      {
        float wt = uInkTime / 12.0;                       // 一拍二
        float ac = aWf.y;
        float ph = aWf.x * 0.14 - wt * 9.0;
        float wob = ( sin( ph + ac * 1.7 + aWf.z ) * 0.5 + sin( ph * 1.7 - 1.3 ) * 0.3 ) * 0.2 * ac * aWf.z;
        transformed += aWfSide * wob;
      }`,
      varPars: 'varying vec3 vWf;\n', varBegin: 'vWf = aWf;',
    }),
    fragmentPars: 'varying vec3 vWf;\nuniform vec3 uWater, uWaterShade;\n',
    fragmentBase: /* glsl */`
    {
      float wt = uInkTime / 12.0;
      float s = vWf.x, ac = vWf.y;
      float flow = s / 7.0 - wt * 2.6;
      float streak = toonNoise( vec3( ac * 3.2 + 3.0, flow * 0.35, 5.1 ) ) + 0.5 * toonNoise( vec3( ac * 7.0, flow * 0.8, 9.3 ) );
      float fs = max( fwidth( streak ), 1e-3 );
      vec3 c = uWater;
      c = mix( c, uWaterShade, smoothstep( 0.22 - fs, 0.22 + fs, streak ) * 0.6 );
      c = mix( c, uWaterShade * 0.85, smoothstep( 0.6 - fs, 0.6 + fs, streak ) * 0.4 );
      c = mix( c, uWater, smoothstep( 0.82, 0.98, abs( ac ) ) * 0.6 );
      diffuseColor.rgb = c;
    }`,
  });
  const water = add(group, bindToon(new THREE.Mesh(mergeGeometries(falls), waterMat), waterMat, { castShadow: false }));
  water.name = 'kun-isle-falls'; water.frustumCulled = false;

  // —— 实例化散布：松（大松手摆 + 小松撒点）、苔点团、小白花、云团 ——
  const inst = (geo, mat, items, name) => instanced(geo, mat, items, name, { bind: bindToon });
  // 台面采样器：顶面（朝上）权重
  const mesaAll = mergeGeometries(mesaGeos.map(g => g.index ? g.toNonIndexed() : g));
  {
    const n = mesaAll.attributes.normal, r = mesaAll.attributes.aRock, w = new Float32Array(n.count), we = new Float32Array(n.count);
    for (let i = 0; i < n.count; i++) { const up = n.getY(i); w[i] = sstep(0.75, 0.95, up) * (r.getX(i) > 0.99 ? 1 : 0); we[i] = sstep(0.2, 0.7, up) * sstep(0.85, 1.0, r.getX(i)); }
    mesaAll.setAttribute('wTop', new THREE.BufferAttribute(w, 1)); mesaAll.setAttribute('wEdge', new THREE.BufferAttribute(we, 1));
  }
  const peakAll = peakGeo.clone();
  {
    const n = peakAll.attributes.normal, r = peakAll.attributes.aRock, w = new Float32Array(n.count);
    for (let i = 0; i < n.count; i++) w[i] = Math.pow(sstep(0.6, 0.9, n.getY(i)), 2) * sstep(0.12, 0.25, r.getX(i)) * sstep(0.85, 0.6, r.getX(i));
    peakAll.setAttribute('wLedge', new THREE.BufferAttribute(w, 1));
  }
  const tp = V3(), tn = V3();
  const nearFall = p => FALLS.some(F => Math.abs(p.x - F.x0) < F.w1 * 1.6 + 3 && Math.sign(p.z) === F.side && Math.abs(p.z) > 12);
  const inPeak = (p, k = 0.92) => PEAKS.some(pk => Math.hypot(p.x - pk.x, (p.z - pk.z) / 0.95) < pk.r * k && p.y < pk.base + (pk.top - pk.base) * 1.12 - 8);
  const nearPav = p => { const dx = p.x - PAV.x, dz = p.z - PAV.z, a = dx * 0.89 - dz * 0.45, b = dx * 0.45 + dz * 0.89; return Math.hypot(dx, dz) < 16 || (a > 0 && a < 36 && Math.abs(b) < 6); };

  // 松树：四种树形模板；大松手摆（迎客松式探出），小松在台面、峰腰平台上撒
  const PINE_C = ['#2c7a55', '#357f4f', '#2a6c52', '#3a8a5c', '#2f7448'];
  const pineTpl = [0, 1, 2, 3].map(k => pineTree(o.seed + 900 + k * 31));
  const pineItems = [[], [], [], []];
  const HERO_PINES = [
    { x: 102, z: -10, y: 74, s: 58, lean: [0.4, 0, -0.3] }, { x: 168, z: -6, y: t1Top(168, -6), s: 40, lean: [0.7, 0, -0.15] },
    { x: -122, z: -16, y: t1Top(-122, -16), s: 44, lean: [-0.3, 0, -0.3] }, { x: -156, z: 6, y: t1Top(-156, 6), s: 32, lean: [-0.65, 0, 0.1] },
    { x: 8, z: -10, y: 78, s: 30, lean: [0.15, 0, -0.35] }, { x: -52, z: -18, y: 78, s: 24, lean: [-0.25, 0, -0.3] },
    { x: 62, z: -24, y: t1Top(62, -24), s: 24, lean: [0.25, 0, -0.5] }, { x: 64, z: 24, y: t1Top(64, 24), s: 28, lean: [0.1, 0, 0.4] },
    { x: -150, z: -20, y: t1Top(-150, -20), s: 22, lean: [-0.4, 0, -0.4] },
  ];
  HERO_PINES.forEach((h, i) => {
    const m = place(V3(h.x, h.y, h.z), UP, { yaw: R() * TAU, scale: V3(h.s, h.s, h.s), sink: 1.2, lean: V3(...h.lean) });
    pineItems[i % 4].push({ m, c: pick(R(), PINE_C) });
  });
  {
    const sT = sampler(mesaAll, 'wTop', o.seed + 1001), sL = sampler(peakAll, 'wLedge', o.seed + 1002);
    let made = 0, tries = 0;
    while (made < N(70) && tries < 3000) {
      tries++; sT.sample(tp, tn);
      if (inPeak(tp, 1.0) || nearPav(tp) || nearFall(tp)) continue;
      const s = (7 + Math.pow(R(), 1.6) * 9) * Math.sqrt(LS);
      pineItems[made % 4].push({ m: place(tp, UP, { yaw: R() * TAU, scale: V3(s, s * (0.9 + R() * 0.3), s), sink: 0.6, lean: V3((R() - 0.5) * 0.3, 0, (R() - 0.5) * 0.3) }), c: pick(R(), PINE_C) });
      made++;
    }
    made = 0; tries = 0;
    while (made < N(46) && tries < 3000) {
      tries++; sL.sample(tp, tn);
      if (nearPav(tp)) continue;
      const s = (5 + R() * 6) * Math.sqrt(LS);
      pineItems[made % 4].push({ m: place(tp, UP, { yaw: R() * TAU, scale: V3(s, s, s), sink: 0.5, lean: tn.clone().setY(0).multiplyScalar(0.6) }), c: pick(R(), PINE_C) });
      made++;
    }
  }
  const pineMat = toon({
    shade1Tint: [0.58, 0.66, 0.82], shade2Tint: [0.34, 0.4, 0.62], step1: 0.5, step2: 0.18, dabAmt: 0.14, dabScale: 0.35,
    rimAmt: 0.55, rimLitAmt: 0.9, rimLitInside: 0.15, fillAmt: 0.45, fillFlat: 0.3, skyAmt: 0.6, edgeNoise: 0.05, outlineW: 0.8,
    uniforms: { uTrunk: { value: col(C.trunk) } },
    ...hooks(U, { mode: 'inst', varPars: 'attribute float aPart;\nvarying float vPart;\n', varBegin: 'vPart = aPart;' }),
    fragmentPars: 'varying float vPart;\nuniform vec3 uTrunk;\n',
    fragmentBase: 'diffuseColor.rgb = mix( uTrunk, diffuseColor.rgb, step( 0.5, vPart ) );',
  });
  pineTpl.forEach((g, k) => { if (pineItems[k].length) add(group, inst(g, pineMat, pineItems[k], 'kun-isle-pines-' + k)); });

  // 苔点团：台地崖口一圈、台面边缘，并漫到背上
  const MOSS = ['#7fb562', '#8fc06a', '#6aa85a', '#9cc870', '#5e9e56', '#86b45e'];
  const mossItems = [];
  {
    const sE = sampler(mesaAll, 'wEdge', o.seed + 1101);
    for (let i = 0; i < N(1100); i++) {
      sE.sample(tp, tn);
      if (nearFall(tp) || nearPav(tp)) continue;
      const r = (1.6 + Math.pow(R(), 1.6) * 3.4) * LS;
      mossItems.push({ m: place(tp, tn, { yaw: R() * TAU, scale: V3(r * (0.9 + R() * 0.3), r * (0.7 + R() * 0.4), r * (0.9 + R() * 0.3)), sink: r * 0.35 }), c: pick(R(), MOSS) });
    }
    // 漫到身体上：岛的四周（背上、两肋上沿）
    const pA = bodyGeo.attributes.position, nA = bodyGeo.attributes.normal, w = new Float32Array(pA.count);
    const P = V3(), Nn = V3();
    const EDGE = { 1: [], '-1': [] };
    for (let xi = -170; xi <= 190; xi += 2) for (const sd of [1, -1]) EDGE[sd].push([xi, Math.abs(mesaEdgeZ(MESAS[0], xi, sd))]);
    const edgeAt = (x, sd) => { const t = EDGE[sd]; const i = clamp(Math.round((x + 170) / 2), 0, t.length - 1); return t[i][1]; };
    for (let i = 0; i < pA.count; i++) {
      P.fromBufferAttribute(pA, i); Nn.fromBufferAttribute(nA, i);
      const patch = noise(P.x * 0.03, P.y * 0.03, P.z * 0.03) + 0.4 * noise(P.x * 0.09 + 7, P.y * 0.09, P.z * 0.09);
      const dz = Math.abs(P.z) - edgeAt(P.x, P.z >= 0 ? 1 : -1);
      w[i] = sstep(-0.3, 0.3, Nn.y) * sstep(-150, -128, P.x) * sstep(168, 150, P.x) * (0.3 + sstep(0.0, 0.4, patch)) * sstep(-1, 1.5, dz) * sstep(5.5, 2, dz);
    }
    const sb = new THREE.BufferGeometry(); sb.setAttribute('position', pA); sb.setAttribute('normal', nA); sb.setIndex(bodyGeo.index); sb.setAttribute('wMoss', new THREE.BufferAttribute(w, 1));
    const sB = sampler(sb, 'wMoss', o.seed + 1102);
    for (let i = 0; i < N(220); i++) {
      sB.sample(tp, tn);
      const r = (2.2 + Math.pow(R(), 1.5) * 3.4) * LS;
      mossItems.push({ m: place(tp, tn, { yaw: R() * TAU, scale: V3(r, r * (0.7 + R() * 0.3), r), sink: r * 0.4 }), c: pick(R(), MOSS) });
    }
  }
  const mossMat = toon({
    shade1Tint: [0.56, 0.66, 0.8], shade2Tint: [0.32, 0.42, 0.6], step1: 0.5, step2: 0.16, dabAmt: 0.16, dabScale: 1.1,
    rimAmt: 0.5, rimLitAmt: 0.9, rimLitInside: 0.15, rimLitPower: 0.5, rimPower: 0.3, fillAmt: 0.45, fillFlat: 0.25, skyAmt: 0.6, edgeNoise: 0.04,
    outlineW: 0.45, instanceId: false, ...hooks(U, { mode: 'inst' }),
  });
  add(group, inst(geoClump(), mossMat, mossItems, 'kun-isle-moss'));

  // 小白花：撒在台面和苔点上
  const FLW = ['#fff6ec', '#fbe8ee', '#fff1e0', '#f6f2ff', '#ffe6da'];
  const flowers = [];
  {
    const sT = sampler(mesaAll, 'wTop', o.seed + 1201);
    for (let i = 0; i < N(320); i++) {
      sT.sample(tp, tn);
      if (inPeak(tp, 0.95) || nearPav(tp) || nearFall(tp)) continue;
      const s = (0.9 + R() * 1.0) * Math.sqrt(LS);
      flowers.push({ m: place(tp, tn, { yaw: R() * TAU, scale: V3(s, s, s), sink: 0.1 }), c: pick(R(), FLW) });
    }
    for (let i = 0; i < mossItems.length; i += 5) {             // 一部分顶在苔点团上
      const e = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      mossItems[i].m.decompose(e, q, sc);
      const up = UP.clone().applyQuaternion(q);
      const s = (0.8 + R() * 0.8) * Math.sqrt(LS);
      flowers.push({ m: place(e.clone().addScaledVector(up, sc.y * 0.62), up, { yaw: R() * TAU, scale: V3(s, s, s), sink: 0 }), c: pick(R(), FLW) });
    }
  }
  const flowerMat = toon({ color: '#ffffff', shade1Tint: [0.78, 0.74, 0.86], shade2Tint: [0.56, 0.52, 0.7], step1: 0.45, step2: 0.16, rimAmt: 0.4, rimInside: 0.55, fillAmt: 0.55, fillFlat: 0.3, skyAmt: 0.7, skyTint: [0.92, 0.92, 1.0], outlineW: 0.5, ...hooks(U, { mode: 'inst' }) });
  add(group, inst(geoFlower(), flowerMat, flowers, 'kun-isle-flowers'));

  // 云：全部用平面祥云卡片——瀑布落点、峰腰云带、岛两头（2.5D：立体山 + 平面云，青绿山水里云就是画出来的）
  const CARDS = [
    ...fallClouds.map((c, i) => ({ p: c.p, s: c.s * 1.25, flip: i % 2 ? -1 : 1, rot: 0.02 * (i % 3 - 1) })),
    { p: V3(-66, 142, -26), s: 44, flip: 1, rot: 0.04 }, { p: V3(-2, 122, -22), s: 30, flip: -1, rot: -0.04 }, { p: V3(56, 110, -18), s: 26, flip: 1, rot: 0.03 },
    { p: V3(-124, 118, -10), s: 30, flip: -1, rot: 0.0 }, { p: V3(-24, 198, 16), s: 28, flip: 1, rot: -0.06 }, { p: V3(124, 100, 12), s: 22, flip: -1, rot: 0.02 },
    { p: V3(156, 74, -26), s: 18, flip: 1, rot: 0.0 }, { p: V3(-164, 70, -14), s: 20, flip: -1, rot: 0.03 }, { p: V3(-90, 160, 22), s: 22, flip: -1, rot: 0.05 },
  ];
  group.add(makeCloudCards(U, CARDS));

  // ═════════════════════════ 姿态 ═════════════════════════
  // JS 版刚体弯曲（和 GLSL 的 kunBendRigid 一致）：给 CPU 摆位的部件（胸鳍）用
  const { rigid: bendRigidJS } = WAVE.js(U);
  const _mb = new THREE.Matrix4();
  const _X = V3(), _Y = V3(), _Z = V3(), _h = V3(), _d = V3();
  function setPose(ts, po = {}) {
    U.uKunT.value = ts;
    // 胸鳍折扇：开合（spread）+ 划水（绕体轴外展）+ 前后摆；三片有相位差，像扇骨依次展开
    const w = U.uKunOmega.value;
    for (const f of fins) {
      bendRigidJS(f.root, f.x0, ts, f.pivot.position);
      const s = f.side;
      const stroke = s * (0.2 * Math.sin(w * ts + 0.6));           // 外展 / 收拢
      const sweep = 0.1 * Math.sin(w * ts + 2.0);                    // 前后
      // 扇子的基准：主轴往后下 38°、略外撇；铰链轴近似体侧外法线
      const base = V3(-Math.cos(0.62) * 0.92, -Math.sin(0.62), 0.5 * s).normalize();
      const hinge = V3(0.1, 0.3, s).normalize();
      const qa = new THREE.Quaternion().setFromAxisAngle(V3(1, 0, 0), stroke);
      base.applyQuaternion(qa); hinge.applyQuaternion(qa);
      base.applyAxisAngle(hinge, sweep);
      f.leaves.forEach((lf, i) => {
        const open = 0.35 + 0.75 * (0.5 + 0.5 * Math.sin(w * ts - i * 0.45 + 0.3));
        _d.copy(base).applyAxisAngle(hinge, lf.a * open * s * -1);
        _X.copy(_d).normalize(); _Z.copy(hinge).addScaledVector(_X, -hinge.dot(_X)).normalize(); _Y.crossVectors(_Z, _X);
        // 镜像那一侧：保持鳍片“前缘朝前”（局部 +Y 指向身体前上方）
        if (s < 0) { _Y.negate(); _Z.negate(); }
        _mb.makeBasis(_X, _Y, _Z);
        lf.mesh.quaternion.setFromRotationMatrix(_mb);
        lf.mesh.position.copy(_Z).multiplyScalar(lf.off * 1.4);
      });
    }
    poseEyes(eyes, po.blink ?? autoBlink(ts, o.blinkPeriod, o.blinkOffset), po.look, group, { lidU: [-0.42, 0.03], lidL: [0.56, -0.03], catches: CATCH });
  }
  const eyeWorld = (target, ref) => pickEye(eyes, target, ref);
  function fitShadow(light, { size = 4096, radius = 400 } = {}) {
    group.updateMatrixWorld(true);
    const c = V3(-10, 20, 0).applyMatrix4(group.matrixWorld);
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
  setPose(0);
  return { group, setPose, eyeWorld, fitShadow, outlineMeshes, length: 600, eyeRadius: RE, wisps: [], uniforms: U, fins, eyes };
}
