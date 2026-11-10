// {{TITLE}} · 两个镜头共用的世界：色指定、卡通材质、三维主体（孤峰、伴峰、礁石、乌篷渡船）、水面、太阳、手绘层与底板读取。
// 每个镜头各建一个场景（底板要按各自的起始机位摆），几何和材质在这里只建一次、两个场景共用。
// 工艺出处（路线手册「模版示范了什么」一节逐条对照）：
//   色指定与明度结构 → routes/directing/VISUAL-DESIGN.md §2–§3、craft/toon.md 判据 2/5/7/11
//   皴线（材质里画的线，沸腾节拍跟着物体走）→ craft/toon.md 判据 8
//   底板读登记表的关键位置、截断边留在画外 → craft/two-five-d.md §1.2、§2.1、§2.7
//   水面用真的水平面（不用竖卡片冒充地面）、船与水的接触 → craft/two-five-d.md §4.1–§4.2
// 确定性：随机只来自 mulberry 种子，时间只由调用方传入；不用 Date.now / Math.random。
import * as THREE from 'three';
import { toonKind, makeToonShared, setToonShared } from '../../engine/shade/toon.js';
import { patchLayer } from '../../engine/shade/surface.js';
import { spire } from '../../engine/form/rock.js';
import { pineTree } from '../../engine/form/plants.js';
import { boatHull } from '../../engine/form/props.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { canvasLayer } from '../../engine/stage/plates.js';
import { aimCamera, dirOf, project, placeOnScreen } from '../../engine/stage/camera.js';
import { mulberry, lerp, DEG } from '../../engine/core/math.js';

// ───────── 色指定（只用画风 beiming-original@v1 的色板与它的规则；明度用 OKLab L 核对过，见手册） ─────────
// 背光的峰看到的主要是一影：一影比身后天空暗 0.25 以上（L 0.43 对 0.69），主体在灰度缩略图里仍是第一落点。
// 最暗的黑留给前景（L 0.28），远山向天色收拢（远浅近深），强调色（暖金）只给太阳与船灯。
export const PAL = {
  ink: '#2A2D52',                                           // 墨线与皴线：深蓝灰，不用纯黑
  rockLit: '#7D78B8', rockShade1: '#454A80', rockShade2: '#2C2F58',   // 亮 / 一影 / 二影：阴影换色相（往天空的蓝紫走），不压黑
  rockRim: '#F2A0A6', rockRimLit: '#FFD3B0', rockFill: '#B98AA6',     // 背光侧粉、受光侧桃；下方补光 = 水面反上来的晨光
  rust: '#5F5394',
  ridgeFar: '#A79AD6', ridgeMid: '#8E7CC3', ridgeLight: '#F7A98F',     // 远山浅、中山深；朝太阳一侧的山脊亮边
  mist: '#D9C3E3', mistWarm: '#F3C3BE',                                 // 雾：淡紫，靠太阳一侧偏暖
  fore: '#232544', foreRim: '#6F74B5',                                  // 前景剪影：全片最暗；挨着天空的边一道冷光
  waterNear: '#353866', waterMid: '#6F6AAB', waterFar: '#DDB0C4',       // 水面：近暗、远亮（倒映地平线的粉）
  hull: '#3A3556', hullShade: '#25223D', canopy: '#2E2B4A', wake: '#E9D9EE',
  pine: '#4B5A88', pineShade1: '#2F3B66', pineShade2: '#1F2748', trunk: '#3A2F4E',   // 松：比峰再暗一档，剪影在天上一眼可读
  reflect: '#2E3160',                                                   // 水里的倒影：峰的二影色，比水面暗
  sun: '#FFA45C', sunCore: '#FFF4E0', lamp: '#FFC46B',                  // 强调色：只给太阳与船灯（日晕偏橙，日轮白热）
  sunGlazeIn: '#FFD27A', sunGlazeOut: '#FF9A5C',                        // 太阳四周的罩色：近处暖黄、外圈橙（同属太阳的强调色）
};

// ───────── 卡通材质族：一族材质共享着色器，每个物体一个 ID（墨线在物体之间也画得出） ─────────
export const TOON = makeToonShared({ fillDir: [0, -1, 0], skyDir: [0, 1, 0] });
export const setToon = g => setToonShared(TOON, g);
const kind = toonKind({ name: 'tpl', shared: TOON, firstId: 1, layers: [patchLayer()] });

// 皴：山石陡面上断续的竖向细线，画在材质里（toonInk），随 uInkTime 一拍二换形——线的沸腾节拍跟山石的绘制节拍一致。
// 层理：石峰一级级的台阶，在陡面上画断续的横向裂隙（按物体空间的高度，约 9 m 一层，层距与起伏随种子变）。
// 竖皴 + 横向层理是「石头」的读法；只有竖向的明暗条，峰看上去像打磨过的柱子（craft/toon.md 判据 8：线跟着形走）。
// aRock = (高度比例 hf, cos 绕轴角, sin 绕轴角, 种子)，由 engine/form/rock.js 的 spire 写进几何。
const CUN = {
  vertexPars: 'attribute vec4 aRock;\nvarying vec4 vRock;\nvarying vec3 vRockN;\n',
  vertexBegin: 'vRock = aRock; vRockN = normal;',
  fragmentPars: 'varying vec4 vRock;\nvarying vec3 vRockN;\n',
  fragmentAlbedo: /* glsl */`
  {
    float hf = vRock.x, up = normalize( vRockN ).y;
    float ang = atan( vRock.z, vRock.y ) / 6.2831853;
    float steep = smoothstep( 0.55, 0.2, abs( up ) );
    float f = ang * 10.0 + toonNoise( vec3( hf * 4.0, vRock.w * 7.0, uInkTime * 0.37 ) ) * 0.45 + toonNoise( vToonObj * 0.05 ) * 0.3;
    float dd = fract( f + 0.5 ) - 0.5, fw = max( fwidth( f ), 1e-4 );
    float cun = ( 1.0 - smoothstep( 0.1 - fw, 0.1 + fw, abs( dd ) ) ) * steep * smoothstep( 0.04, 0.16, hf );   // 笔宽要经得住后期的 Kuwahara（细到 1–2 px 的线会被抹掉）
    cun *= smoothstep( -0.15, 0.3, toonNoise( vec3( ang * 36.0, hf * 7.0, vRock.w + uInkTime * 0.11 ) ) );
    cun *= 1.0 - smoothstep( 0.1, 0.32, fw );   // 远了、细到画不出就淡掉，不闪
    // 层理：横向的断续裂隙；层面高度带一点起伏（不是尺子画的），只在一半左右的周长上出现
    float sy = vToonObj.y / ( 8.0 + 3.0 * fract( vRock.w * 13.7 ) ) + toonNoise( vec3( ang * 5.0, vRock.w * 3.0, 0.0 ) ) * 0.55 + toonNoise( vec3( ang * 23.0, hf * 2.0, uInkTime * 0.21 ) ) * 0.12;
    float sd = fract( sy + 0.5 ) - 0.5, sw = max( fwidth( sy ), 1e-4 );
    float strata = ( 1.0 - smoothstep( 0.07 - sw, 0.07 + sw, abs( sd ) ) ) * steep * smoothstep( 0.06, 0.18, hf ) * ( 1.0 - smoothstep( 0.92, 1.0, hf ) );
    strata *= smoothstep( 0.05, 0.35, toonNoise( vec3( ang * 9.0, floor( sy ) * 1.7, vRock.w ) ) );
    strata *= 1.0 - smoothstep( 0.12, 0.35, sw );
    toonInk = max( toonInk, max( cun * 0.7, strata * 0.62 ) );
    diffuseColor.rgb *= mix( 0.86, 1.04, smoothstep( 0.0, 0.85, hf ) ) * ( 1.0 - 0.06 * strata );   // 山脚近水更深一点，山顶迎天更亮一点；裂隙里略暗
  }`,
};
const ROCK = {
  color: PAL.rockLit, shade1: PAL.rockShade1, shade2: PAL.rockShade2,
  step1: 0.55, feather1: 0.02, step2: 0.22, feather2: 0.03,           // 画风默认附近；亮面略小于半球
  shadowDepth: 0.5, castShade: 1, shadowLo: 0.42, shadowHi: 0.58,
  edgeNoise: 0.05, edgeNoiseScale: 0.03,                                // 交界线手绘抖动；频率按 100 m 量级的峰换算
  rimColor: PAL.rockRim, rimAmt: 0.45, rimPower: 0.32, rimInside: 0.34, rimDirK: 0.5,
  rimLitColor: PAL.rockRimLit, rimLitAmt: 0.5, rimLitPower: 0.5, rimLitInside: 0.12, rimLitDirK: 0.55,
  fillColor: PAL.rockFill, fillAmt: 0.5, fillStep: 0.55, fillStep2: 0.9, fillW1: 0.45, fillFlat: 0.5,
  skyTint: [0.84, 0.88, 1.1], skyAmt: 0.07,                            // 天光只轻轻点一下朝上的台阶面：太亮会把每级台阶描成一圈圈亮环
  rustColor: PAL.rust, rustAmt: 0.35, rustThr: 0.12, patchScale: 0.022, inkColor: PAL.ink,
  ...CUN,
};
export const MAT = {
  rock: kind.make(ROCK),
  rockFar: kind.make({ ...ROCK, color: '#8781BF', shade1: '#545A90', shade2: '#3A3E6C', rustAmt: 0.15 }),   // 远一点的峰：亮一档（空气透视）
  hull: kind.make({ color: PAL.hull, shade1: PAL.hullShade, shade2: '#1B1930', step1: 0.55, step2: 0.22, edgeNoise: 0.02, edgeNoiseScale: 0.3,
    rimColor: PAL.rockRim, rimAmt: 0.3, rimLitColor: PAL.rockRimLit, rimLitAmt: 0.6, rimLitPower: 0.5, fillColor: PAL.rockFill, fillAmt: 0.3, inkColor: PAL.ink }),
  canopy: kind.make({ color: PAL.canopy, shade1: '#221F38', shade2: '#16142A', step1: 0.6, step2: 0.25, edgeNoise: 0.03, edgeNoiseScale: 0.5,
    rimColor: PAL.rockRim, rimAmt: 0.35, rimLitColor: PAL.rockRimLit, rimLitAmt: 0.7, rimLitPower: 0.55, inkColor: PAL.ink }),
  // 松：针叶团与干枝两种固有色（几何里的 aPart：0 干枝、1 针叶），其余与山石同一套光
  pine: kind.make({ color: PAL.pine, shade1: PAL.pineShade1, shade2: PAL.pineShade2, step1: 0.5, step2: 0.2, edgeNoise: 0.06, edgeNoiseScale: 0.8,
    rimColor: PAL.rockRim, rimAmt: 0.5, rimLitColor: PAL.rockRimLit, rimLitAmt: 0.8, rimLitPower: 0.5, rimLitInside: 0.15,
    fillColor: PAL.rockFill, fillAmt: 0.35, fillFlat: 0.3, skyAmt: 0.4, inkColor: PAL.ink,
    uniforms: { uTrunk: { value: new THREE.Color(PAL.trunk) } },
    vertexPars: 'attribute float aPart;\nvarying float vPart;\n', vertexBegin: 'vPart = aPart;',
    fragmentPars: 'varying float vPart;\nuniform vec3 uTrunk;\n',
    fragmentBase: 'diffuseColor.rgb = mix( uTrunk, diffuseColor.rgb, step( 0.5, vPart ) );' }),
};
// 日出过渡：受光侧边缘光从晨前的弱亮边推到逆光的亮边（色彩脚本第二段，由 film.json 的日出事件驱动）
export function sunrise(k) {
  for (const m of [MAT.rock, MAT.rockFar, MAT.pine]) { const u = m.userData.toon; u.uRimLitAmt.value = lerp(m === MAT.pine ? 0.8 : 0.5, 1.7, k); u.uRimAmt.value = lerp(0.45, 0.7, k); }
}

const bind = (geo, mat, o) => kind.bind(new THREE.Mesh(geo, mat), mat, o);

// ───────── 三维主体：一组山水画式的峰（主峰 + 肩峰 + 笋峰，后面一座伴峰）+ 礁石 + 峰顶的松，名义尺寸按米 ─────────
// 剪影先于着色（craft/toon.md 判据 1）：主客三峰高低错落（132 / 74 / 52 m）、台阶状收分（steps）、各自略斜，
// 峰顶的松给出「山水」的读法和尺度；峰约 130 m、渡船 14 m、船夫 1.7 m，远景里互为尺度参照（VISUAL-DESIGN §4.1）。
// PEAKS 同时交给水面算倒影（同一份数字，倒影和峰永远对得上）。
const R0 = mulberry(20261110);
export const PEAKS = [
  { id: 'main', at: [10, -3, -4], H: 132, Rb: 18, lean: [0.06, -0.02], steps: 4, NH: 72, NA: 64, seed: 0.11, mat: 'rock' },
  { id: 'shoulder', at: [-8, -3, 4], H: 74, Rb: 15, lean: [-0.12, 0.02], steps: 3, NH: 48, NA: 48, seed: 0.19, mat: 'rock' },
  { id: 'needle', at: [36, -3, 10], H: 54, Rb: 7.5, lean: [0.1, 0.04], steps: 3, NH: 40, NA: 36, seed: 0.33, mat: 'rock' },
  { id: 'far', at: [-52, -3, -36], H: 84, Rb: 13, lean: [-0.09, 0.03], steps: 3, NH: 48, NA: 48, seed: 0.27, mat: 'rockFar' },
];
const GEO = {
  peaks: PEAKS.map(p => spire(R0, p.H, p.Rb, { steps: p.steps, lean: p.lean, NH: p.NH, NA: p.NA, seed: p.seed })),
  rocks: [[26, 15, -4, 2, 0.35], [-24, 11, 14, 8, 0.52], [48, 9, 8, -14, 0.63], [-66, 8, 4, -38, 0.71]].map(([x, r, h, z, s]) => ({ x, z, g: spire(R0, h, r, { steps: 1, NH: 14, NA: 32, seed: s }) })),
  pines: pines(),
  hull: boatHull(14, 3.4, 1.7, 0.7),
  canopy: new THREE.CylinderGeometry(1.55, 1.55, 6.2, 18, 1, true, -Math.PI / 2, Math.PI).rotateZ(Math.PI / 2).translate(-0.6, 1.35, 0),
  ferryman: ferryman(),
};
// 峰顶（spire 的顶点在 lean × H 处）
function peakTop(p) { return new THREE.Vector3(p.at[0] + p.lean[0] * p.H, p.at[1] + p.H, p.at[2] + p.lean[1] * p.H); }
// 松：主峰顶一大一小、肩峰顶一棵、笋峰顶一棵；树形用 engine/form/plants.js 的 pineTree，种子固定
function pines() {
  const put = [[0, 15, 0.5, [1.2, 0, -0.8]], [0, 9, 2.2, [-1.6, 0, 1.0]], [1, 11, 1.4, [0.4, 0, 0.6]], [2, 8, 3.1, [0.3, 0, 0.2]]];
  const geos = put.map(([pi, s, yaw, off], k) => {
    const g = pineTree(4100 + k * 37), top = peakTop(PEAKS[pi]);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(top.x + off[0], top.y - 1.6, top.z + off[2]),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.05 * (k - 1.5), yaw, 0.08 * (k % 2 ? 1 : -1))), new THREE.Vector3(s, s, s));
    return g.applyMatrix4(m);
  });
  return mergeGeometries(geos);
}
// 船夫：立在船尾撑篙（身体、头、斗笠、竹篙）。远景里只有十几像素，读的是斗笠的三角和斜篙这两笔
function ferryman() {
  const body = new THREE.CylinderGeometry(0.22, 0.34, 1.25, 10).translate(-5.4, 1.0 + 0.62, 0);
  const head = new THREE.SphereGeometry(0.17, 10, 8).translate(-5.4, 2.42, 0);
  const hat = new THREE.ConeGeometry(0.55, 0.3, 14).translate(-5.4, 2.66, 0);
  const pole = new THREE.CylinderGeometry(0.045, 0.045, 7.4, 6).rotateZ(-0.62).translate(-5.4 - 1.9, 1.3, 0.25);
  return mergeGeometries([body, head, hat, pole].map(g => g.toNonIndexed()));
}
// 峰轴上高度比例 h 处的世界点（含 spire 的斜与 ISLET 偏移）：构图时拿它当「主体落点」
export function peakPoint(id, h = 0.45) {
  const p = PEAKS.find(q => q.id === id);
  return new THREE.Vector3(ISLET.x + p.at[0] + p.lean[0] * p.H * h * h, ISLET.y + p.at[1] + p.H * h, ISLET.z + p.at[2] + p.lean[1] * p.H * h * h);
}
// 构图先定屏幕位置，再反算机位（与底板「按屏幕像素摆」同一个思路，craft/two-five-d.md §1.2）：
//   地平线落在 horizonY（只由俯仰决定，滚转为 0 时是精确解）；主体上的点 subject 落在横坐标 subjectX（偏航单调，二分 60 次）。
//   frameCamera(cam, pos, { horizonY, subject, subjectX }, DW, DH) → { yaw, pitch }（弧度），并把相机摆好
export function frameCamera(cam, pos, { horizonY, subject, subjectX }, DW, DH) {
  const pitch = Math.atan((horizonY - DH / 2) / (DH / 2) * Math.tan(cam.fov * DEG / 2));
  let lo = -Math.PI / 3, hi = Math.PI / 3;          // 偏航越大（向左转），主体越往画右
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    aimCamera(cam, pos, mid, pitch);
    if (project(cam, DW, DH, subject).x < subjectX) lo = mid; else hi = mid;
  }
  const yaw = (lo + hi) / 2;
  aimCamera(cam, pos, yaw, pitch);
  return { yaw, pitch };
}
// 礁与峰的相对摆位（以礁中心为原点）；两个镜头都把它放到同一个世界位置 ISLET
export const ISLET = new THREE.Vector3(0, 0, 0);
export function buildIslet() {
  const g = new THREE.Group();
  PEAKS.forEach((p, i) => { const m = bind(GEO.peaks[i], MAT[p.mat]); m.position.set(...p.at); g.add(m); });
  for (const r of GEO.rocks) { const m = bind(r.g, MAT.rock); m.position.set(r.x, -4, r.z); g.add(m); }   // 礁石半没在水里：峰不像立在托盘上
  g.add(bind(GEO.pines, MAT.pine));
  g.position.copy(ISLET);
  return g;
}

// ───────── 乌篷渡船 + 尾迹：位移按时间平滑，起伏与摇晃一拍二（craft/animation.md §2.6，与样片渡船同一做法） ─────────
export function buildBoat() {
  const g = new THREE.Group();
  const canopy = bind(GEO.canopy, MAT.canopy);
  canopy.material.side = THREE.DoubleSide;
  g.add(bind(GEO.hull, MAT.hull), canopy, bind(GEO.ferryman, MAT.canopy));
  return g;
}
// h = 一拍二的拍号（hold(f, 2)）：同一拍内姿态不变；seed 区分两只船
export function boatPose(boat, base, speed, t, h, seed = 1) {
  const R = mulberry(seed * 977 + h);   // 每拍一个确定的随机数，不用 Math.random
  boat.position.set(base.x + speed * t, 0.22 * Math.sin(h * 0.9 + seed) + 0.06 * (R() - 0.5), base.z);
  boat.rotation.set(0.02 * Math.sin(h * 0.7 + seed), 0, 0.025 * Math.sin(h * 0.55 + 2 * seed));
}
// 尾迹：平铺在水面上的一条 V 形淡色条带，接在船尾，随船走（船与水的接触；样片用的是屏幕条带，这里直接放在真水面上）
export function buildWake() {
  const { ctx, tex } = canvasLayer(512, 128);
  const g = ctx.createLinearGradient(0, 0, 512, 0); g.addColorStop(0, 'rgba(233,217,238,0)'); g.addColorStop(0.75, 'rgba(233,217,238,0.55)'); g.addColorStop(1, 'rgba(233,217,238,0.9)');
  ctx.strokeStyle = g; ctx.lineCap = 'round';
  for (const s of [-1, 1]) { ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(512, 64 + s * 6); ctx.quadraticCurveTo(260, 64 + s * 22, 0, 64 + s * 58); ctx.stroke(); }
  ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(512, 64); ctx.lineTo(120, 64); ctx.stroke();
  tex.needsUpdate = true;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(36, 9).rotateX(-Math.PI / 2).translate(-18 - 6.5, 0.06, 0),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, fog: false }));
  m.userData.outline = false; m.renderOrder = 4.8;
  return m;
}

// ───────── 太阳：一个世界方向（方位固定、仰角随时间升起）；两个镜头看到的是同一个太阳，光向跨切点一致 ─────────
// 升起的时刻由 film.json 的日出事件决定：事件那一帧太阳中心正好在 elevCross（镜头 S2 把远山山脊摆在它上方一点，
// 于是太阳核心在事件帧刚好露出一线——拍点帧就是结果帧，craft/animation.md §5.4）。
export const SUN = { az: 11.5 * DEG, elevCross: 0.55 * DEG, rate: 1.3 * DEG, coreDeg: 0.7 * DEG, keyElev: 5 * DEG };
const SUN_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;
const SUN_FS = `
uniform vec3 color, halo; uniform float amt, glint, rd; varying vec2 vUv;
void main(){
  vec2 d = (vUv - .5) * 2.; float r = length(d);
  float disc = 1. - smoothstep(rd - .02, rd + .006, r);              // 实的日轮：白热的芯，边缘略软（HDR 超过 1，Kuwahara 的高光保护会留住它）
  float corona = exp(-pow(max(r - rd, 0.) / .09, 2.)) * (1. - disc);  // 贴着日轮的一圈饱和暖色：后期的高光肩压过之后，日轮仍是暖的，不发灰
  float h = exp(-r * r * 9.) * .55 + exp(-r * r * 40.) * .9;          // 两层日晕
  float star = glint * exp(-r * r * 2.5) * (exp(-abs(d.y) * 55.) + exp(-abs(d.x) * 55.) * .45);   // 冲顶那一下的光芒
  gl_FragColor = vec4((color * disc * 3.2 + halo * (corona * 1.8 + h) + mix(halo, color, .5) * star * 3.5) * amt, 1.);
}`;
export function sunDisc({ order = 0.6 } = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(PAL.sunCore) }, halo: { value: new THREE.Color(PAL.sun) }, amt: { value: 1 }, glint: { value: 0 }, rd: { value: 0.2 } },
    vertexShader: SUN_VS, fragmentShader: SUN_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.renderOrder = order; m.frustumCulled = false; m.userData.outline = false;
  return m;
}
// 日光的罩色（glaze）：太阳四周一圈暖色的透明罩染，从近日轮的暖黄过渡到外圈的橙，越往外越透明（普通混合，不是加色）。
// 在亮的晨空上加色只会让天更白，日轮反而读不出来；罩一层暖色，白热的日轮才「亮」出来——水彩画太阳的做法：留白的日轮 + 四周罩暖色。
const GLAZE_FS = `
uniform vec3 inner, outer; uniform float amt, squash; varying vec2 vUv;
void main(){
  vec2 d = (vUv - .5) * 2.; d.y *= squash; float r = length(d);
  float a = amt * (exp(-r * r * 4.5) * .75 + exp(-r * r * 18.) * .25) * (1. - smoothstep(.85, 1., r));
  gl_FragColor = vec4(mix(inner, outer, smoothstep(.05, .7, r)), a);
}`;
export function sunGlaze({ order = 0.55 } = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { inner: { value: new THREE.Color(PAL.sunGlazeIn) }, outer: { value: new THREE.Color(PAL.sunGlazeOut) }, amt: { value: 0 }, squash: { value: 1.15 } },
    vertexShader: SUN_VS, fragmentShader: GLAZE_FS, transparent: true, depthWrite: false, toneMapped: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.renderOrder = order; m.frustumCulled = false; m.userData.outline = false;
  return m;
}
export function makeSun(fEvent, fps) {
  const elev = f => SUN.elevCross + SUN.rate * (f - fEvent) / fps;
  const dir = (f, out = new THREE.Vector3()) => dirOf(-SUN.az, elev(f), out);
  const screen = (cam, W, H, f) => project(cam, W, H, cam.position.clone().addScaledVector(dir(f ?? fEvent), 1e4));
  return {
    az: SUN.az, fEvent, elev, dir,
    keyDir: () => dirOf(-SUN.az, SUN.keyElev),            // 卡通主光：同一方位、固定低仰角的逆光（只取方向）
    screenX: (cam, W, H) => screen(cam, W, H).x,
    screenY: (cam, W, H, f) => screen(cam, W, H, f).y,
    // 把日轮摆到太阳当前的位置（视深 D 处，按像素给大小）；冲顶那一帧亮一下（glint，前后约 5 帧）
    place(disc, cam0, W, H, f, { size = 300, D = 15000 } = {}) {
      const p = screen(cam0, W, H, f);
      placeOnScreen(disc, cam0, W, H, p.x, p.y, size, D, size);
      disc.material.uniforms.glint.value = Math.exp(-Math.pow((f - fEvent) / 5, 2));
      return p;
    },
  };
}

// ───────── 主光：只给方向和投影（颜色全由色板给）；方向对准太阳 ─────────
export function keyLight(dirToSun, target) {
  const L = new THREE.DirectionalLight('#ffffff', 1);
  L.position.copy(target).addScaledVector(dirToSun, 600);
  L.target.position.copy(target);
  L.castShadow = true;
  L.shadow.mapSize.set(2048, 2048);
  Object.assign(L.shadow.camera, { left: -150, right: 150, top: 170, bottom: -40, near: 100, far: 1400 });
  L.shadow.bias = -0.0004; L.shadow.normalBias = 1.2;
  return L;
}

// ───────── 水面：真的水平面（y = 0），远处像镜子、近处看得进水里；倒影、碎波、太阳倒影都在世界坐标里，相机怎么动都对 ─────────
// 天空的倒影：水面每个像素按「地平线镜像」去天空底板上取色（远处的东西，倒影在屏幕上就是关于地平线的镜像），
// 所以水面带着天空的粉、橙、紫色带——《北冥》江面的做法（media/shot_1.6.jpg），不是一块平涂的暗色。
// 峰的倒影是算出来的，不是贴图：水面一点 P 的反射光线来自「水下镜像相机 → P」的延长线，它在离 P 水平 s·d 处升到 s·h 高
// （h 相机高、d 相机到 P 的水平距离）；找这条线离每座峰轴线最近的点，按 spire 的收分公式比半径，就知道是不是照到了峰。
// 时钟：波纹流动一拍一（uTime，水与雾每帧都动）；倒影的扰动一拍二（uHeld = hold(f, 2)，《北冥》倒影的节拍，VISUAL-DESIGN §5）。
const NREF = PEAKS.length;
const WATER_VS = `varying vec3 vW; varying vec4 vClip;
void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vClip = projectionMatrix * viewMatrix * w; gl_Position = vClip; }`;
const WATER_FS = `
#define NREF ${NREF}
uniform vec3 uNear, uMid, uFar, uSun, uCam, uRefCol; uniform float uTime, uSunAz, uSunUp, uSeed, uHeld, uSkyFlip;
uniform vec4 uRefA[NREF], uRefB[NREF];   // A = (x, z, 可见高, 底半径)；B = (斜 x, 斜 z, 没入水下的深度, 0)
uniform sampler2D uSky; uniform vec4 uSkyRect; uniform vec3 uView;   // 天空底板在设计稿上的矩形 (左, 上, 宽, 高)；(设计宽, 设计高, 地平线 y)
varying vec3 vW; varying vec4 vClip;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21) + uSeed); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y); }
void main(){
  vec3 d = vW - uCam; float dist = length(d.xz);
  float k = smoothstep(80., 4500., dist);                 // 0 近 → 1 远
  vec3 body = mix(uNear, uMid, smoothstep(0., .6, k));    // 看进水里的颜色：近暗远亮
  // 波纹：r1 长涌、r2 碎波，随 uTime 流动（一拍一）；r3 只给倒影的扰动，随拍号 uHeld 跳（一拍二）
  float r1 = vn(vec2(vW.x * .004, vW.z * .06 + uTime * .1));
  float r2 = vn(vec2(vW.x * .018 + 7., vW.z * .22 - uTime * .25));
  float r3 = vn(vec2(vW.x * .045 + 3., vW.z * .5 + uHeld * 1.7));
  // 地平线镜像：屏幕上离地平线 below 像素的点，倒影取天空里地平线以上 below 像素处的颜色；越近被波纹拉得越碎
  vec2 ndc = vClip.xy / vClip.w;
  vec2 px = vec2((ndc.x * .5 + .5) * uView.x, (.5 - ndc.y * .5) * uView.y);
  float below = max(0., px.y - uView.z), wob = (r2 - .5) * .8 + (r3 - .5) * .7;
  float my = uView.z - below * (1. + .45 * wob * (1. - .6 * k)), mx = px.x + (r3 - .5) * 16. * (1. - k);
  vec2 suv = vec2((mx - uSkyRect.x) / uSkyRect.z, 1. - (my - uSkyRect.y) / uSkyRect.w);
  if (uSkyFlip > .5) suv.x = 1. - suv.x;
  vec3 sky = texture2D(uSky, clamp(suv, vec2(.002), vec2(.998))).rgb;
  float fr = mix(.38, .88, smoothstep(.0, .65, k));       // 反射比例：远处近乎镜面，近处看得进水里（菲涅耳的画法近似）
  vec3 col = mix(body, sky * mix(vec3(.74, .72, .88), vec3(.94, .93, .98), k), fr);
  // 碎波：横向短条的亮与暗（不是贯穿整幅的长线），越远越密越淡
  float lite = smoothstep(.7, .88, r1 * .45 + r2 * .55) * smoothstep(.4, .7, r3);
  float dark = smoothstep(.64, .86, 1. - (r1 * .55 + r2 * .45)) * smoothstep(.3, .6, r3);
  float fade = 1. - k * .7;
  col = mix(col, mix(uMid, uFar, .55) * 1.12, lite * .4 * fade);
  col = mix(col, body * .82, dark * .38 * fade);
  // 峰的倒影：暗、边被波纹打断
  vec2 u = vW.xz - uCam.xz; float refl = 0.;
  for (int i = 0; i < NREF; i++) {
    vec4 A = uRefA[i], B = uRefB[i];
    float s0 = dot(A.xy - vW.xz, u) / dot(u, u);        // 反射线离峰轴最近处（水平参数）
    if (s0 <= 0.) continue;
    float h = (s0 * uCam.y + B.z) / (A.z + B.z);         // 那一点在峰上的高度比例（峰底没入水下 B.z 米）
    if (h > 1.) continue;
    vec2 ax = A.xy + B.xy * (A.z + B.z) * h * h;         // spire 的斜：越高越偏
    float r = A.w * pow(max(0., 1. - pow(h, 1.85)), .6) * 1.06;
    float jit = ((r3 - .5) * .9 + (vn(vec2(vW.z * .45 + float(i) * 7.1, uHeld * 3.7)) - .5) * .6) * r * (.3 + .6 * (1. - h));
    float dd = length(vW.xz + s0 * u - ax) + jit;
    refl = max(refl, (1. - smoothstep(r * .8, r * 1.02, dd)) * (1. - h * .35));
  }
  refl *= 1. - lite * .8;
  col = mix(col, uRefCol, refl * .8);
  // 太阳倒影：方位接近太阳的一条竖带，近宽远窄，碎成横向的闪；日出后才亮（uSunUp 0→1）
  float az = atan(d.x, -d.z);
  float band = exp(-pow((az - uSunAz) / (.005 + .05 * (1. - k)), 2.));
  float glit = smoothstep(.48, .78, vn(vec2(vW.x * .06, vW.z * .55 + uTime * .9))) * smoothstep(.3, .6, r3);
  col += uSun * band * (.22 + 1.15 * glit) * uSunUp * (.55 + .45 * k);
  gl_FragColor = vec4(col, 1.);
  #include <colorspace_fragment>
}`;
// sky：天空底板贴图（loadPlate 读的那张）；skyRect：它在起始机位下摆在设计稿上的矩形 [左, 上, 宽, 高]（与 placeOnScreen 同一组数）
export function buildWater({ sky, skyRect, DW, DH }) {
  const flip = sky.repeat.x < 0 ? 1 : 0;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uNear: { value: new THREE.Color(PAL.waterNear) }, uMid: { value: new THREE.Color(PAL.waterMid) }, uFar: { value: new THREE.Color(PAL.waterFar) },
      uSun: { value: new THREE.Color(PAL.sun) }, uCam: { value: new THREE.Vector3() }, uRefCol: { value: new THREE.Color(PAL.reflect) },
      uTime: { value: 0 }, uSunAz: { value: 0 }, uSunUp: { value: 0 }, uSeed: { value: 0.37 }, uHeld: { value: 0 },
      uRefA: { value: PEAKS.map(p => new THREE.Vector4(ISLET.x + p.at[0], ISLET.z + p.at[2], p.H + p.at[1], p.Rb)) },
      uRefB: { value: PEAKS.map(p => new THREE.Vector4(p.lean[0], p.lean[1], -p.at[1], 0)) },
      uSky: { value: sky }, uSkyFlip: { value: flip }, uSkyRect: { value: new THREE.Vector4(...skyRect) }, uView: { value: new THREE.Vector3(DW, DH, DH * 0.7) },
    },
    vertexShader: WATER_VS, fragmentShader: WATER_FS, toneMapped: false, fog: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000).rotateX(-Math.PI / 2), mat);
  m.userData.outline = false;      // 水面不描边（否则地平线会被描成一条墨线）
  m.receiveShadow = false;
  return m;
}
// 每帧更新水面：相机位置、时间、拍号、地平线（水平方向无穷远处在屏幕上的 y，倒影按它镜像）
const _hz = new THREE.Vector3();
export function waterFrame(water, cam, DW, DH, { t, held, sunAz, sunUp }) {
  const u = water.material.uniforms;
  u.uCam.value.copy(cam.position); u.uTime.value = t; u.uHeld.value = held; u.uSunAz.value = sunAz; u.uSunUp.value = sunUp;
  const fwd = cam.getWorldDirection(_hz); fwd.y = 0; fwd.normalize();
  u.uView.value.z = project(cam, DW, DH, fwd.multiplyScalar(1e7).add(cam.position)).y;
}

// ───────── 手绘层：程序化画出的山脊剪影（远浅近深，朝太阳的坡带一道暖亮边） ─────────
// sunU = 太阳在这张图上的横向位置（0..1）：越靠近太阳，山脊亮边越亮——光向和画面里的太阳一致（craft/two-five-d.md §2.5）。
export function ridgeTexture({ seed, color, light, base = 0.62, amp = 0.3, sunU = 0.7, haze = PAL.mist, w = 2048, h = 512 }) {
  const { ctx, tex } = canvasLayer(w, h), R = mulberry(seed);
  const ph = Array.from({ length: 6 }, () => R() * 6.283);
  const y = new Float32Array(w + 1);
  for (let x = 0; x <= w; x++) {
    const u = x / w;
    const n = 0.5 * Math.sin(u * 6.1 + ph[0]) + 0.26 * Math.sin(u * 13.7 + ph[1]) + 0.13 * Math.sin(u * 31 + ph[2]) + 0.06 * Math.sin(u * 71 + ph[3]);
    const peak = Math.pow(Math.max(0, Math.sin(u * 3.3 + ph[4])), 6) * 0.45;   // 一两处更陡的峰，山形才不像正弦波
    y[x] = h * (base - amp * (n * 0.6 + peak));
  }
  ctx.beginPath(); ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += 2) ctx.lineTo(x, y[x]);
  ctx.lineTo(w, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, h * (base - amp), 0, h);    // 上实下虚：山脚没进雾里
  g.addColorStop(0, color); g.addColorStop(0.5, color); g.addColorStop(1, haze);
  ctx.fillStyle = g; ctx.fill();
  // 朝太阳的坡：沿山脊描一道暖亮边，坡越朝太阳、离太阳越近越亮
  ctx.lineCap = 'round';
  for (let x = 2; x < w; x += 2) {
    const slope = (y[x + 1] - y[x - 1]) / 2, near = Math.exp(-Math.pow((x / w - sunU) / 0.32, 2));
    const a = Math.max(0, Math.min(1, slope * 0.9)) * (0.25 + 0.75 * near);
    if (a < 0.02) continue;
    ctx.strokeStyle = light; ctx.globalAlpha = a * 0.8; ctx.lineWidth = 2.2 + 2 * near;
    ctx.beginPath(); ctx.moveTo(x - 2, y[x - 2] + 1.2); ctx.lineTo(x, y[x] + 1.2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  tex.needsUpdate = true;
  return { tex, topAt: u => y[Math.round(Math.min(1, Math.max(0, u)) * w)] / h };   // topAt(u)：横向位置 u 处山脊顶在图上的高度比例
}

// ───────── 雾带：横向四方连续的软雾（上下高斯淡出，没有硬边）；靠太阳一侧偏暖 ─────────
// 四方连续：噪声只用整数周期的正弦叠加，左右两端无缝，可以 RepeatWrapping 横向循环、按时间平移。
export function mistTexture({ seed = 1, w = 2048, h = 256, warmU = -1 } = {}) {
  const { ctx, tex } = canvasLayer(w, h), R = mulberry(seed);
  const ph = Array.from({ length: 8 }, () => R() * 6.283);
  const img = ctx.createImageData(w, h), d = img.data;
  const c0 = new THREE.Color(PAL.mist), c1 = new THREE.Color(PAL.mistWarm);
  const per = u => 0.5 + 0.22 * Math.sin(6.2832 * 2 * u + ph[0]) + 0.14 * Math.sin(6.2832 * 5 * u + ph[1]) + 0.08 * Math.sin(6.2832 * 11 * u + ph[2]) + 0.05 * Math.sin(6.2832 * 23 * u + ph[3]);
  for (let x = 0; x < w; x++) {
    const u = x / w, dens = Math.min(1, Math.max(0, per(u))), off = 0.06 * Math.sin(6.2832 * 3 * u + ph[4]) + 0.03 * Math.sin(6.2832 * 7 * u + ph[5]);
    const warm = warmU < 0 ? 0 : Math.exp(-Math.pow((((u - warmU + 1.5) % 1) - 0.5) / 0.18, 2));
    const r = (c0.r + (c1.r - c0.r) * warm) * 255, g = (c0.g + (c1.g - c0.g) * warm) * 255, b = (c0.b + (c1.b - c0.b) * warm) * 255;
    for (let yy = 0; yy < h; yy++) {
      const v = (yy / h - 0.5 - off) / (0.16 + 0.08 * dens);
      const streak = 0.85 + 0.15 * Math.sin(yy * 0.31 + 6.2832 * 9 * u + ph[6]);   // 很淡的横向丝缕
      const a = Math.exp(-v * v) * (0.35 + 0.65 * dens) * streak;
      const o = (yy * w + x) * 4; d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = Math.min(255, a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.wrapS = THREE.RepeatWrapping; tex.needsUpdate = true;
  return tex;
}

// ───────── 前景剪影：左下角的岸石与芦苇（全片最暗）；挨着天空的边一道冷光。截断边（左、下）永远在画外 ─────────
export function foregroundTexture({ seed = 5, w = 1600, h = 700 } = {}) {
  const { ctx, tex } = canvasLayer(w, h), R = mulberry(seed);
  const top = x => {   // 岸石的上沿：左高右低，右端圆钝地收进画内
    const u = x / w;
    return h * (0.3 + 0.55 * Math.pow(u, 1.6) + 0.05 * Math.sin(u * 23 + 1.3) + 0.03 * Math.sin(u * 57 + 0.4));
  };
  ctx.beginPath(); ctx.moveTo(0, h);
  for (let x = 0; x <= w * 0.86; x += 4) ctx.lineTo(x, top(x));
  ctx.quadraticCurveTo(w * 0.93, h * 0.97, w * 0.99, h);
  ctx.closePath();
  ctx.fillStyle = PAL.fore; ctx.fill();
  ctx.save(); ctx.clip();                             // 冷光只画在剪影里面
  ctx.strokeStyle = PAL.foreRim; ctx.lineWidth = 7; ctx.globalAlpha = 0.55; ctx.filter = 'blur(2px)';
  ctx.beginPath(); for (let x = 0; x <= w * 0.86; x += 4) ctx[x ? 'lineTo' : 'moveTo'](x, top(x) + 3); ctx.stroke();
  ctx.restore();
  // 芦苇：一簇细茎，弯向右（风从左来），线宽按笔压变化
  ctx.fillStyle = PAL.fore;
  for (let i = 0; i < 46; i++) {
    const x0 = w * (0.04 + 0.5 * R()), y0 = top(x0) + 6, len = h * (0.18 + 0.32 * R()), bend = 0.18 + 0.3 * R(), wd = 2.2 + 3 * R();
    ctx.beginPath(); ctx.moveTo(x0 - wd, y0);
    ctx.quadraticCurveTo(x0 + len * bend * 0.4, y0 - len * 0.6, x0 + len * bend, y0 - len);
    ctx.quadraticCurveTo(x0 + len * bend * 0.4 + wd * 0.3, y0 - len * 0.6, x0 + wd, y0);
    ctx.fill();
  }
  tex.needsUpdate = true;
  return tex;
}

// ───────── 底板：读共享登记表 assets/plates/plates.json，按 file 取图、取关键位置（不往代码里手抄坐标） ─────────
// engine/stage/plates.js 的 loadPlates 按页面相对的 url 取图，作品页在 films/<名>/ 下会取错，这里按登记表的 file 自己拼地址。
const PLATES = new URL('../../assets/plates/', import.meta.url);
let REG = null;
export async function plateMeta(name) {
  REG ??= await (await fetch(new URL('plates.json', PLATES))).json();
  const m = REG.plates.find(p => p.name === name);
  if (!m) throw new Error(`assets/plates/plates.json 里没有底板 ${name}`);
  return m;
}
export async function loadPlate(name, { flipX = false } = {}) {
  const m = await plateMeta(name);
  const t = await new THREE.TextureLoader().loadAsync(new URL(m.file, PLATES).href);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8;
  if (flipX) { t.wrapS = THREE.RepeatWrapping; t.repeat.x = -1; t.offset.x = 1; }
  t.userData.meta = m;
  return t;
}
