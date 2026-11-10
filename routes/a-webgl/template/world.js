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
import { boatHull } from '../../engine/form/props.js';
import { canvasLayer } from '../../engine/stage/plates.js';
import { dirOf, project, placeOnScreen } from '../../engine/stage/camera.js';
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
  sun: '#FFB26B', sunCore: '#FFF1DA', lamp: '#FFC46B',                  // 强调色：只给太阳与船灯
};

// ───────── 卡通材质族：一族材质共享着色器，每个物体一个 ID（墨线在物体之间也画得出） ─────────
export const TOON = makeToonShared({ fillDir: [0, -1, 0], skyDir: [0, 1, 0] });
export const setToon = g => setToonShared(TOON, g);
const kind = toonKind({ name: 'tpl', shared: TOON, firstId: 1, layers: [patchLayer()] });

// 皴：山石陡面上断续的竖向细线，画在材质里（toonInk），随 uInkTime 一拍二换形——线的沸腾节拍跟山石的绘制节拍一致。
// aRock = (高度比例 hf, cos 绕轴角, sin 绕轴角, 种子)，由 engine/form/rock.js 的 spire 写进几何。
const CUN = {
  vertexPars: 'attribute vec4 aRock;\nvarying vec4 vRock;\nvarying vec3 vRockN;\n',
  vertexBegin: 'vRock = aRock; vRockN = normal;',
  fragmentPars: 'varying vec4 vRock;\nvarying vec3 vRockN;\n',
  fragmentAlbedo: /* glsl */`
  {
    float hf = vRock.x, up = normalize( vRockN ).y;
    float ang = atan( vRock.z, vRock.y ) / 6.2831853;
    float f = ang * 14.0 + toonNoise( vec3( hf * 4.0, vRock.w * 7.0, uInkTime * 0.37 ) ) * 0.4 + toonNoise( vToonObj * 0.05 ) * 0.3;
    float dd = fract( f + 0.5 ) - 0.5, fw = max( fwidth( f ), 1e-4 );
    float cun = ( 1.0 - smoothstep( 0.06 - fw, 0.06 + fw, abs( dd ) ) ) * smoothstep( 0.55, 0.2, abs( up ) ) * smoothstep( 0.04, 0.16, hf );
    cun *= smoothstep( -0.15, 0.3, toonNoise( vec3( ang * 36.0, hf * 7.0, vRock.w + uInkTime * 0.11 ) ) );
    cun *= 1.0 - smoothstep( 0.1, 0.32, fw );   // 远了、细到画不出就淡掉，不闪
    toonInk = max( toonInk, cun * 0.5 );
    diffuseColor.rgb *= mix( 0.86, 1.04, smoothstep( 0.0, 0.85, hf ) );   // 山脚近水更深一点，山顶迎天更亮一点
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
  skyTint: [0.84, 0.88, 1.1], skyAmt: 0.25,
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
};
// 日出过渡：受光侧边缘光从晨前的弱亮边推到逆光的亮边（色彩脚本第二段，由 film.json 的日出事件驱动）
export function sunrise(k) {
  for (const m of [MAT.rock, MAT.rockFar]) { const u = m.userData.toon; u.uRimLitAmt.value = lerp(0.5, 1.3, k); u.uRimAmt.value = lerp(0.45, 0.7, k); }
}

const bind = (geo, mat, o) => kind.bind(new THREE.Mesh(geo, mat), mat, o);

// ───────── 三维主体：孤峰 + 伴峰 + 几块礁石（engine/form/rock.js），名义尺寸按米 ─────────
// 峰高约 130 m：远景里它和渡船（14 m）互为尺度参照（VISUAL-DESIGN §4.1；craft/toon.md A6「太空」）。
const R0 = mulberry(20261110);
const GEO = {
  spire: spire(R0, 132, 18, { steps: 2, lean: [0.06, -0.02], NH: 56, NA: 56, seed: 0.11 }),
  spire2: spire(R0, 80, 13, { steps: 2, lean: [-0.09, 0.03], NH: 44, NA: 48, seed: 0.27 }),
  rocks: [[26, 15, -4, 2, 0.35], [-20, 11, 14, 6, 0.52], [44, 9, 8, -14, 0.63], [-62, 8, 4, -38, 0.71]].map(([x, r, h, z, s]) => ({ x, z, g: spire(R0, h, r, { steps: 1, NH: 14, NA: 32, seed: s }) })),
  hull: boatHull(14, 3.4, 1.7, 0.7),
  canopy: new THREE.CylinderGeometry(1.55, 1.55, 6.2, 18, 1, true, -Math.PI / 2, Math.PI).rotateZ(Math.PI / 2).translate(-0.6, 1.35, 0),
};
// 礁与峰的相对摆位（以礁中心为原点）；两个镜头都把它放到同一个世界位置 ISLET
export const ISLET = new THREE.Vector3(0, 0, 0);
export function buildIslet() {
  const g = new THREE.Group();
  const a = bind(GEO.spire, MAT.rock); a.position.set(10, -3, -4);
  const b = bind(GEO.spire2, MAT.rockFar); b.position.set(-48, -3, -34);
  g.add(a, b);
  for (const r of GEO.rocks) { const m = bind(r.g, MAT.rock); m.position.set(r.x, -4, r.z); g.add(m); }   // 礁石半没在水里：峰不像立在托盘上
  g.position.copy(ISLET);
  return g;
}

// ───────── 乌篷渡船 + 尾迹：位移按时间平滑，起伏与摇晃一拍二（craft/animation.md §2.6，与样片渡船同一做法） ─────────
export function buildBoat() {
  const g = new THREE.Group();
  const canopy = bind(GEO.canopy, MAT.canopy);
  canopy.material.side = THREE.DoubleSide;
  g.add(bind(GEO.hull, MAT.hull), canopy);
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
  float disc = 1. - smoothstep(rd - .035, rd + .01, r);             // 实的日轮：边缘略软，Kuwahara 的高光保护会留住它
  float h = exp(-r * r * 10.) * .5 + exp(-r * r * 45.) * .7;         // 两层日晕
  float star = glint * exp(-r * r * 3.) * (exp(-abs(d.y) * 60.) + exp(-abs(d.x) * 60.) * .5);   // 冲顶那一下的光芒
  gl_FragColor = vec4((color * disc * 1.6 + halo * h * .7 + halo * star * 1.4) * amt, 1.);
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

// ───────── 水面：真的水平面（y = 0），颜色随距离从近暗到远亮；横向波纹与太阳倒影都在世界坐标里，相机怎么动都对 ─────────
const WATER_VS = `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const WATER_FS = `
uniform vec3 uNear, uMid, uFar, uSun, uCam; uniform float uTime, uSunAz, uSunUp, uSeed;
varying vec3 vW;
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21) + uSeed); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y); }
void main(){
  vec3 d = vW - uCam; float dist = length(d.xz);
  float k = smoothstep(80., 4500., dist);
  vec3 col = mix(uNear, uMid, smoothstep(0., .5, k));
  col = mix(col, uFar, smoothstep(.45, 1., k));
  // 横向波纹：世界坐标里的两层长条（一深一浅），越远越密越淡；只随 uTime 平移，任意帧可单独重渲
  float w1 = vn(vec2(vW.x * .004, vW.z * .06 + uTime * .1)), w2 = vn(vec2(vW.x * .015 + 7., vW.z * .2 - uTime * .25));
  float lite = smoothstep(.66, .86, w1 * .6 + w2 * .4), dark = smoothstep(.62, .82, 1. - (w1 * .5 + w2 * .5));
  float fade = 1. - k * .8;
  col = mix(col, mix(uMid, uFar, k * .8 + .2) * 1.06, lite * .5 * fade);
  col = mix(col, uNear * .92, dark * .28 * fade);
  // 太阳倒影：方位接近太阳的一条竖带，近宽远窄，碎成横向的闪；日出后才亮（uSunUp 0→1）
  float az = atan(d.x, -d.z);
  float band = exp(-pow((az - uSunAz) / (.004 + .045 * (1. - k)), 2.));
  float glit = smoothstep(.5, .8, vn(vec2(vW.x * .06, vW.z * .55 + uTime * .9)));
  col += uSun * band * (.15 + .85 * glit) * uSunUp * (.3 + .7 * k);
  gl_FragColor = vec4(col, 1.);
  #include <colorspace_fragment>
}`;
export function buildWater() {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uNear: { value: new THREE.Color(PAL.waterNear) }, uMid: { value: new THREE.Color(PAL.waterMid) }, uFar: { value: new THREE.Color(PAL.waterFar) },
      uSun: { value: new THREE.Color(PAL.sun) }, uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 }, uSunAz: { value: 0 }, uSunUp: { value: 0 }, uSeed: { value: 0.37 },
    },
    vertexShader: WATER_VS, fragmentShader: WATER_FS, toneMapped: false, fog: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000).rotateX(-Math.PI / 2), mat);
  m.userData.outline = false;      // 水面不描边（否则地平线会被描成一条墨线）
  m.receiveShadow = false;
  return m;
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
