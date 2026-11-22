// 北冥引擎 · 编号图与后期回归的标定场景（页面侧）：同一个场景在 three r170 与 r187 下各渲一遍，由 r187-look-regression.mjs 读回对拍。
// 扩展名用 .mjs：这是回归夹具，不是 engine 的公开模块（不进 tests/engine 的 API 快照）。
// 只依赖 three（页面的 import map 把 three 与 three/addons/ 指到哪一版就是哪一版）、engine/shade 与 engine/look；
// 场景完全确定：不用随机数，时间只有每帧参数里写死的 t。
//
//   W / H                 画幅 640 × 480
//   IDS                   ids.js 给各物体编的号（按场景遍历顺序）。彩屑是 2100 个实例的 InstancedMesh，排在最前，只露出其中 6 个：
//                         实例 2046 / 2047 / 2048 正好跨过 11 位低段（ID 2047 → (2047, 0)，2048 → (0, 1)，2049 → (1, 1)），后面的物体全在高段
//   EXPECT_IDS            ID 图里应当出现的全部编号；BALL = 球的线宽系数与两种可见度（露出的、被半透明玻璃挡着的）
//   STAGES                逐级读回的画面：{ id, what, p }，p 是 look.render 的每帧参数（debug 视图、只开一道的 solo-*、整帧 final）
//   VARIANTS              故意改坏的变体（只在 r187 上渲，对 r170 金标准）：
//                           kind 'ablation'  逐道消融：只关一道后期 / 只改坏 ID 图的一个分支，必须过不了门
//                           kind 'negative'  负对照：大幅扰动，整帧 PSNR 必须明显跌破门限
//                           kind 'identity'  正对照：什么都不改，必须过门（变体这条路自己没有偏差）
//                           pass 'id' 读 ID 图（半浮点原值），否则读整帧；ids = 场景开关，look = 覆盖的每帧参数
//   CORRUPTIONS / corrupt(name)   片段补丁没命中的故意改错（FX22）：把 three 的一段着色器原文改掉，之后建的材质一编译就该抛错；
//                         每项 { what, anchor（报错里应当点名的锚点）, shadowOnly（只在渲阴影的那条路径上编译）, run }
//   build(v) → { scene, camera }
//   renderSuite(names) → { revision, gpu, shaders, frames: { base: { id, <各级> }, <变体>: { id | final } } }
//                         id 是 Uint16Array（半浮点 RGBA 原值，自下而上），其余是 Uint8Array（RGBA8，自下而上）；
//                         shaders 是这一趟交给 WebGL 编译的全部着色器源码（three 展开 #include、加完前缀之后的最终文本，去重），冻结的金标准拿它算摘要
//   patchBuild() → { revision, stages: { compile, look, ids } }   三条编译路径各用一个新渲染器建一遍场景：
//                         renderer.compile、look.render（含阴影深度材质）、单独的 ID 图；每条 null = 没出错，否则是抛出的错误信息
//   pack(typedArray) → Promise<base64(gzip)>   读回的像素压一下再交给 Node（ID 图压到百分之一）
import * as THREE from 'three';
import { toonKind } from '../shade/toon.js';
import { createLook } from './index.js';
import { createIdPass } from './ids.js';

export const W = 640, H = 480;
const CONFETTI = 2100, SHOWN = [0, 1, 2046, 2047, 2048, 2099];
export const IDS = { confetti: SHOWN.map(i => i + 1), ball: CONFETTI + 1, pebbles: CONFETTI + 2, body: CONFETTI + 3, leaf: CONFETTI + 4, reed: CONFETTI + 5, duo: CONFETTI + 6 };
export const EXPECT_IDS = [...IDS.confetti, IDS.ball, IDS.pebbles, IDS.body, IDS.leaf, IDS.reed, IDS.duo];
export const BALL = { width: 1.6, alpha: 0.7, glass: 0.45 };

export const P_BASE = {
  t: 0.5,
  outline: { width: 3, color: '#1a1420', wobble: 1, breakup: 0.1, tint: 0.2 },
  kuwahara: { radius: 4, strength: 1 },
  bloom: { strength: 0.6, threshold: 0.8, radius: 0.6 },
  grade: { exposure: 1.1, warmth: 0.15, lift: 0.02, gamma: 0.95, gain: 1.05, saturation: 1.15, shoulder: 0.9 },
  fog: { color: '#b8c4e0', colorHigh: '#e8e0d0', density: 0.035, start: 4, max: 0.8, falloff: 3, sky: 0.3 },
  paper: { strength: 0.13 },
  vignette: 0.35,
  grain: { amount: 0.25 },
};
const OFF = { t: P_BASE.t, outline: false, kuwahara: false, bloom: false, grade: false, fog: false, paper: false, vignette: 0, grain: 0 };
const solo = (key, what) => ({ id: 'solo-' + key, what: `只开${what}，其余各道都关`, p: { ...OFF, [key]: P_BASE[key] } });
const view = (debug, what) => ({ id: 'view-' + debug, what: `中间缓冲：${what}`, p: { ...P_BASE, debug } });
export const STAGES = [
  view('id', '超采样 2 倍的 ID 图（按编号上色）'), view('depth', 'ID 图的深度'), view('edge', '边缘检测（强度 / 半线宽 / 深度差）'), view('line', '墨线笔画'),
  view('bloom', 'bloom 光晕'), view('paper', '程序化纸纹'), view('kuwahara', '雾 → bloom → 调色 → OutputPass → Kuwahara 之后的颜色'),
  { id: 'solo-output', what: '各道都关：主场景（MSAA、半浮点线性）直接过 OutputPass', p: OFF },
  solo('outline', '墨线'), solo('fog', '空气透视雾'), solo('bloom', ' bloom'), solo('grade', '调色'), solo('kuwahara', ' Kuwahara'),
  solo('paper', '纸纹'), solo('vignette', '暗角'), solo('grain', '颗粒'),
  { id: 'final', what: '整帧合成（各道全开）', p: P_BASE },
];

const abl = (what, look) => ({ kind: 'ablation', what, look }), ablId = (what, ids) => ({ kind: 'ablation', pass: 'id', what, ids });
const neg = (what, look) => ({ kind: 'negative', what, look });
export const VARIANTS = {
  'abl-outline': abl('关掉墨线', { outline: false }),
  'abl-fog': abl('关掉空气透视雾', { fog: false }),
  'abl-bloom': abl('关掉 bloom', { bloom: false }),
  'abl-grade': abl('调色换回中性默认（OutputPass 仍在）', { grade: false }),
  'abl-kuwahara': abl('关掉 Kuwahara 笔触', { kuwahara: false }),
  'abl-paper': abl('关掉纸纹', { paper: false }),
  'abl-vignette': abl('关掉暗角', { vignette: 0 }),
  'abl-grain': abl('关掉颗粒', { grain: 0 }),
  'abl-id-instance': ablId('彩屑不再逐实例编号（整批实例同一个 ID）', { perInstance: false }),
  'abl-id-shared': ablId('卵石改成逐实例编号（本来整批共用一个 ID）', { shared: false }),
  'abl-id-group': ablId('躯干与头不再同组（各编各的号，相接处出线）', { group: false }),
  'abl-id-cutout': ablId('叶片不按贴图 alpha 镂空', { cutout: false }),
  'abl-id-cut-uv': ablId('叶片贴图的 UV 变换（repeat / offset）不生效', { cutUv: false }),
  'abl-id-vertex': ablId('芦苇的顶点位移不交给 ID 图（不给 outlineVertex）', { vertex: false }),
  'abl-id-width': ablId('球的线宽系数 1.6 → 1', { width: 1 }),
  'abl-id-alpha': ablId('球的线可见度 0.7 → 1', { alpha: 1 }),
  'abl-id-soft': ablId('半透明玻璃不再半挡（改成不挡线）', { soft: false }),
  'abl-id-own': ablId('ShaderMaterial 挡块不再用自身材质挡线（改成不挡线）', { own: false }),
  'abl-id-false': ablId('不挡线的幽灵块改成实心挡线', { ghost: 'solid' }),
  'abl-id-noid': ablId('双材质方块的 noId 那一组照常进 ID 图', { noId: false }),
  'neg-exposure': neg('调色曝光 1.1 → 1.8', { grade: { exposure: 1.8 } }),
  'neg-fog-dense': neg('雾的密度 0.035 → 0.5、从 0 起', { fog: { density: 0.5, start: 0, max: 1 } }),
  'neg-ink-thick': neg('墨线线宽 3 → 14', { outline: { width: 14 } }),
  'same-final': { kind: 'identity', what: '变体路径正对照：不改参数，重建场景再渲整帧' },
  'same-id': { kind: 'identity', pass: 'id', what: '变体路径正对照：不改参数，重建场景再渲 ID 图' },
};

// FX22：把 three 的一段着色器原文改掉（等于升级后上游改了这段文字），engine/shade 的补丁在这里应当直接抛错、点名缺的锚点
const edit = (obj, key, from, to, all = true) => { if (!obj[key].includes(from)) throw new Error(`corrupt：three r${THREE.REVISION} 的 ${key} 里本来就没有「${from}」`); obj[key] = all ? obj[key].replaceAll(from, to) : obj[key].replace(from, () => to); };
// 上游把一处 #include 就地展开成块的原文：three 自己照常编译、画面不变，按 #include 找锚点的补丁却没处落
const inline = (lib, chunk) => edit(lib, 'vertexShader', `#include <${chunk}>`, THREE.ShaderChunk[chunk]);
export const CORRUPTIONS = {
  'toon-light': { what: '卡通合成替换的那一行光照原文被改写', anchor: 'vec3 outgoingLight = reflectedLight.directDiffuse', run: () => edit(THREE.ShaderLib.toon, 'fragmentShader', 'reflectedLight.directDiffuse + reflectedLight.indirectDiffuse', 'reflectedLight.indirectDiffuse + reflectedLight.directDiffuse') },
  'toon-begin-vertex': { what: '卡通顶点着色器的 #include <begin_vertex> 被展开成原文', anchor: '#include <begin_vertex>', run: () => inline(THREE.ShaderLib.toon, 'begin_vertex') },
  'toon-beginnormal': { what: '卡通顶点着色器的 #include <beginnormal_vertex> 被展开成原文（材质带 vertexNormal 钩子）', anchor: '#include <beginnormal_vertex>', run: () => inline(THREE.ShaderLib.toon, 'beginnormal_vertex') },
  'shadow-return': { what: '投影块里 getShadow 的返回写法变了', anchor: '投影量化锚点缺失', run: () => edit(THREE.ShaderChunk, 'shadowmap_pars_fragment', 'return mix( 1.0, shadow, shadowIntensity );', 'return mix(1.0, shadow, shadowIntensity);') },
  // 同一句返回在投影块里有好几处（r170 两处、r187 五处）：只有头一处变了，其余几处原样。头一处正是标定场景用的那个 getShadow
  'shadow-return-first': { what: '投影块里只有头一处 getShadow 的返回写法变了，其余几处原样', anchor: '投影量化锚点缺失', run: () => edit(THREE.ShaderChunk, 'shadowmap_pars_fragment', 'return mix( 1.0, shadow, shadowIntensity );', 'return mix(1.0, shadow, shadowIntensity);', false) },
  // 头一个 getShadow 的形参连同它的返回一起改名（GLSL 语义不变），其余几处原样：按形参名去数函数的核法会跟着少数一个、放行
  'shadow-param-rename': { what: '投影块里头一个 getShadow 的形参 shadowIntensity 连同它的返回一起改了名，其余几处原样', anchor: '投影量化锚点缺失', run: () => {
    edit(THREE.ShaderChunk, 'shadowmap_pars_fragment', 'float shadowIntensity, float shadowBias', 'float shadowStrength, float shadowBias', false);
    edit(THREE.ShaderChunk, 'shadowmap_pars_fragment', 'return mix( 1.0, shadow, shadowIntensity );', 'return mix( 1.0, shadow, shadowStrength );', false);
  } },
  // 合法 GLSL、语义没变，但投影块不是对拍过的原文了：按文本数返回的核法在这两种改写上都漏换过头一处、照常出图
  'shadow-return-comment': { what: '投影块里头一处 getShadow 的返回里夹了一段块注释，其余几处原样', anchor: '投影量化锚点缺失', run: () => edit(THREE.ShaderChunk, 'shadowmap_pars_fragment', 'return mix( 1.0, shadow, shadowIntensity );', 'return mix( 1.0, shadow, /* mix weight */shadowIntensity );', false) },
  'shadow-comment-space': { what: '投影块里头一个 getShadow 的函数头与返回各用一段块注释顶替了空格，其余几处原样', anchor: '投影量化锚点缺失', run: () => {
    edit(THREE.ShaderChunk, 'shadowmap_pars_fragment', 'float getShadow(', 'float/**/getShadow(', false);
    edit(THREE.ShaderChunk, 'shadowmap_pars_fragment', 'return mix( 1.0, shadow, shadowIntensity );', 'return/**/mix( 1.0, shadow, shadowIntensity );', false);
  } },
  'depth-begin-vertex': { what: '阴影深度材质顶点着色器的 #include <begin_vertex> 被展开成原文（只在渲阴影时编译）', anchor: '#include <begin_vertex>', shadowOnly: true, run: () => inline(THREE.ShaderLib.depth, 'begin_vertex') },
  'pcf-kernel': { what: '投影块的软阴影采样核换了写法', anchor: '软阴影采样锚点缺失', run: () => THREE.REVISION === '170'
    ? edit(THREE.ShaderChunk, 'shadowmap_pars_fragment', 'SHADOWMAP_TYPE_PCF_SOFT', 'SHADOWMAP_TYPE_SOFT_PCF')
    : edit(THREE.ShaderChunk, 'shadowmap_pars_fragment', 'vogelDiskSample( 0, 5, phi )', 'vogelDiskSample( 0, 8, phi )') },
};
export function corrupt(name) {
  if (!Object.hasOwn(CORRUPTIONS, name)) throw new Error(`corrupt：没有「${name}」这种改法，可选 ${Object.keys(CORRUPTIONS).join(' / ')}`);
  CORRUPTIONS[name].run();
}

const BEND = 'float s6t = position.y / 2.6 + 0.5;\ntransformed.x += uS6Bend * s6t * s6t * 1.2;\n';
function leafTexture(cutUv) {
  const n = 16, px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) px.set([70 + 8 * x, 150 + 4 * y, 60, ((x >> 2) + (y >> 2)) % 2 ? 0 : 255], (y * n + x) * 4);
  const tex = new THREE.DataTexture(px, n, n, THREE.RGBAFormat); tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (cutUv !== false) { tex.repeat.set(1.5, 1.5); tex.offset.set(0.25, 0.125); }
  tex.needsUpdate = true;
  return tex;
}

export function build(v = {}) {
  const I = v.ids || {}, kind = toonKind({ name: 's6' }), scene = new THREE.Scene(), o = new THREE.Object3D();
  scene.background = new THREE.Color('#7f8fc4');
  const camera = new THREE.PerspectiveCamera(32, W / H, 1, 60); camera.position.set(0, 3.2, 10); camera.lookAt(0, 1.2, 0);
  const sun = new THREE.DirectionalLight(0xffffff, 1); sun.position.set(5, 9, 6); sun.castShadow = true; sun.shadow.mapSize.set(256, 256); sun.shadow.bias = -0.002;
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 30 });
  const at = (m, x, y, z) => { m.position.set(x, y, z); return m; };
  const toon = (geo, opts, bind) => { const m = kind.make(opts); return kind.bind(new THREE.Mesh(geo, m), m, bind); };
  const plain = (geo, mat, userData) => { const m = new THREE.Mesh(geo, mat); Object.assign(m.userData, userData); return m; };

  const ground = toon(new THREE.PlaneGeometry(40, 40), { color: '#cdbf9c', edgeNoise: 0, rimAmt: 0 }, { outline: false, castShadow: false }); ground.rotation.x = -Math.PI / 2;

  // 彩屑：逐实例 ID，跨过 11 位低段；没露出的实例缩成 0
  const cm = kind.make({ color: '#ffffff', rimAmt: 0.5 }), confetti = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.3), cm, CONFETTI);
  o.scale.setScalar(0); o.updateMatrix(); for (let i = 0; i < CONFETTI; i++) confetti.setMatrixAt(i, o.matrix);
  SHOWN.forEach((i, n) => { o.position.set(-3.3 + 0.8 * n, 3.6 - 0.1 * (n % 2), 0); o.rotation.set(0.4 * n, 0.9 * n, 0); o.scale.setScalar(1); o.updateMatrix(); confetti.setMatrixAt(i, o.matrix); confetti.setColorAt(i, new THREE.Color().setHSL(n / 6, 0.7, 0.55)); });
  kind.bind(confetti, cm, { perInstance: I.perInstance });

  const ball = at(toon(new THREE.SphereGeometry(0.85, 40, 28), { color: '#c8553d', shade1: '#7a2f45', shade2: '#3a1d40', rimColor: '#ffd9a0' }), -2.7, 0.85, 0.4);
  Object.assign(ball.userData, { outlineWidth: I.width ?? BALL.width, outlineAlpha: I.alpha ?? BALL.alpha });

  // 卵石：整批实例共用一个 ID，互相挨着的地方不出线
  const pm = kind.make({ color: '#8d99a6' }), pebbles = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.34, 1), pm, 5);
  for (let i = 0; i < 5; i++) { o.position.set(-1.5 + 0.5 * i, 0.3 + 0.08 * (i % 2), 2.4); o.rotation.set(0.5 * i, 0.3 * i, 0); o.scale.setScalar(1 - 0.08 * i); o.updateMatrix(); pebbles.setMatrixAt(i, o.matrix); }
  kind.bind(pebbles, pm, { perInstance: I.shared === false });

  // 躯干 + 头：开关写在父节点上（子物体继承），同组共用一个 ID
  const body = new THREE.Group(); if (I.group !== false) body.userData.outlineGroup = 'body';
  body.add(at(toon(new THREE.BoxGeometry(0.9, 1.4, 0.6), { color: '#4f8f6a', shade1: '#24464f' }), 0.5, 0.7, 0), at(toon(new THREE.SphereGeometry(0.48, 32, 24), { color: '#e3c9a0' }), 0.5, 1.7, 0));

  // 叶片：three 自带材质 + 带 alpha 的贴图，按 alphaTest 镂空；贴图带 repeat / offset
  const leaf = at(plain(new THREE.PlaneGeometry(1.7, 1.7), new THREE.MeshBasicMaterial({ map: leafTexture(I.cutUv), alphaTest: I.cutout === false ? 0 : 0.5, side: THREE.DoubleSide }), { outline: true }), 2.3, 2.6, -0.6);

  // 芦苇：材质里做顶点位移（带阴影深度材质与法线钩子），同样的 GLSL 经 outlineVertex 交给 ID 图
  const uS6Bend = { value: 1.1 };
  const reed = at(toon(new THREE.BoxGeometry(0.4, 2.6, 0.4, 2, 20, 2), { color: '#5c9e58', uniforms: { uS6Bend }, vertexPars: 'uniform float uS6Bend;\n', vertexBegin: BEND,
    vertexNormal: 'objectNormal = normalize( objectNormal );\n', ...(I.vertex === false ? {} : { outlineVertex: { head: 'uniform float uS6Bend;\n', body: BEND, uniforms: { uS6Bend } } }) }), 2.2, 1.3, 1.2);

  // 挡线的几种：false（彩色里挡着芦苇根，ID 图里不挡）、'own'（卡通材质自身实心挡）、soft（透明材质半挡）、自动判成 own 的 ShaderMaterial、显式 'solid'
  const ghost = at(plain(new THREE.BoxGeometry(1.1, 0.9, 0.2), new THREE.MeshBasicMaterial({ color: '#d9b25b' }), { outlineOccluder: I.ghost ?? false }), 2.3, 0.45, 2.3);
  const pillar = at(toon(new THREE.BoxGeometry(0.25, 2.4, 0.25), { color: '#6a7fc8', vertexNormal: 'objectNormal = normalize( objectNormal );\n' }, { outline: false }), 0.5, 1.2, 1.5); pillar.userData.outlineOccluder = 'own';
  const glass = at(plain(new THREE.PlaneGeometry(1.2, 2.6), new THREE.MeshBasicMaterial({ color: '#9fd0ff', transparent: true, opacity: BALL.glass }), I.soft === false ? { outlineOccluder: false } : {}), -3.1, 1.2, 2);
  const block = at(plain(new THREE.BoxGeometry(0.5, 1.1, 0.3), new THREE.ShaderMaterial({ vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1. ); }', fragmentShader: 'void main(){ gl_FragColor = vec4( .35, .12, .4, 1. ); }' }),
    I.own === false ? { outlineOccluder: false } : {}), -0.9, 0.55, 3.1);
  const lamp = at(plain(new THREE.SphereGeometry(0.22, 24, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(5, 3.6, 1.6) }), { outlineOccluder: 'solid' }), 1.5, 3.3, 0.3);   // 线性 HDR 的亮点：bloom 与高光保护

  // 双材质方块：±x 两个面用 noId 材质（这两组不进 ID 图），其余照常描边
  const na = kind.make({ color: '#b07a4a' }), nb = kind.make({ color: '#e0d0b0', noId: I.noId !== false });
  const duo = at(plain(new THREE.BoxGeometry(1, 1, 1), [nb, nb, na, na, na, na], { outline: true }), -0.9, 2.3, -1.2); duo.rotation.set(0.3, 0.7, 0); duo.castShadow = duo.receiveShadow = true;

  scene.add(sun, ground, confetti, ball, pebbles, body, leaf, reed, ghost, pillar, glass, block, lamp, duo);
  return { scene, camera };
}

function createRenderer() {   // 与 engine/stage/film.js 的 createFilm 同样的渲染器设置
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1); renderer.setSize(W, H); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
  // 软阴影：r187 已删掉 PCFSoftShadowMap，给 PCFShadowMap，采样核由 engine/shade 的 quantizeShadow 换回 r170 的（见 engine/shade/r187-toon-regression.mjs）
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.REVISION === '170' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  return renderer;
}
// 变体的每帧参数：写对象的项只覆盖 P_BASE 里的同名字段，false / 数字整项替换
const withLook = look => ({ ...P_BASE, ...Object.fromEntries(Object.entries(look || {}).map(([k, x]) => [k, x && typeof x === 'object' ? { ...P_BASE[k], ...x } : x])) });
const idTarget = () => new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture: new THREE.DepthTexture(W, H, THREE.FloatType) });
const lookOf = renderer => createLook(renderer, W, H, { refHeight: H, fps: 24 });   // 像素量按本画幅标定（k = 1），与 1080 标定的成片同样的线宽与笔触半径

export function renderSuite(names = ['base']) {
  const renderer = createRenderer(), gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  const shaders = new Set(), shaderSource = gl.shaderSource.bind(gl); gl.shaderSource = (sh, src) => { shaders.add(src); shaderSource(sh, src); };
  const look = lookOf(renderer), ids = createIdPass(renderer), rt = idTarget();
  const final = (part, p) => { look.render(part.scene, part.camera, p); renderer.setRenderTarget(null); const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
  const idMap = part => { ids.render(part.scene, part.camera, rt); const px = new Uint16Array(W * H * 4); renderer.readRenderTargetPixels(rt, 0, 0, W, H, px); renderer.setRenderTarget(null); return px; };
  const frames = {};
  for (const name of names) {
    if (name === 'base') {
      const part = build();
      frames.base = Object.fromEntries(STAGES.map(s => [s.id, final(part, s.p)]));   // 先渲整条后期链，再单独渲 ID 图（成片里也是主场景先编译）
      frames.base.id = idMap(part);
    } else {
      const v = VARIANTS[name], part = build(v);
      frames[name] = v.pass === 'id' ? { id: idMap(part) } : { final: final(part, withLook(v.look)) };
    }
  }
  return { revision: THREE.REVISION, gpu: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '', shaders: [...shaders], frames };
}

export function patchBuild() {
  const stage = fn => { const renderer = createRenderer(); try { fn(renderer, build()); return null; } catch (e) { return String(e && e.message || e); } finally { renderer.dispose(); renderer.forceContextLoss(); } };
  return { revision: THREE.REVISION, stages: {
    compile: stage((renderer, part) => renderer.compile(part.scene, part.camera)),
    look: stage((renderer, part) => lookOf(renderer).render(part.scene, part.camera, P_BASE)),
    ids: stage((renderer, part) => createIdPass(renderer).render(part.scene, part.camera, idTarget())),
  } };
}

export async function pack(arr) {
  const zipped = new Uint8Array(await new Response(new Blob([arr]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  let s = ''; for (let i = 0; i < zipped.length; i += 0x8000) s += String.fromCharCode.apply(null, zipped.subarray(i, i + 0x8000));
  return btoa(s);
}
