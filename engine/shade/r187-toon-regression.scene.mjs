// 北冥引擎 · 卡通着色回归标定场景（页面侧）：同一套场景在 three r170 与 r187 下各渲一遍，由 r187-toon-regression.mjs 读回像素对拍。
// 扩展名用 .mjs：这是回归夹具，不是 engine 的公开模块（不进 tests/engine 的 API 快照）。
// 只依赖 three（页面的 import map 指到哪一版就是哪一版）与 engine/shade；场景完全确定：不用时间、不用随机数。
//
//   QW / QH / REGIONS     整帧 = 2 × 2 个子区（每个 QW × QH）；REGIONS 的 x / y 是 GL 视口坐标（左下原点），读回的像素也是自下而上；
//                         ids = 这个子区的法线 / ID 通道里应当出现的 [物体 ID, 实例数]（每族材质的物体 ID 从 1 起编，表面层四个物体各是自己那一族的 1 号）
//   VARIANTS              base（标定场景）与故意改坏的变体：只渲、只读回它所属的那个子区（pass: 'id' 的读法线 / ID 通道）
//                           kind: 'negative'   负对照：大幅扰动，PSNR 必须明显跌破门限
//                           kind: 'ablation'   逐特性消融：只关掉一项特性，必须过不了门（证明这项特性在画面里、门看得见）
//                           kind: 'identity'   正对照：什么都不改，必须过门（证明变体这条路的裁剪、通道与金标准对得上；排在最后，顺带查残留像素）
//                           mat: { 材质名: 覆盖的参数 }（all = 这个场景的全部材质）；depthDeform: false = 摘掉阴影深度材质
//   renderSuite(names) → { revision, gpu, frames: { base: { color, id }, idref: { 子区名 }, 变体名: { crop } } }   都是 RGBA8 的 base64；
//                         color / id 是整帧（id = 旧的 uToonPass = 1 通道：视空间法线 + 物体 / 实例 ID 写在 alpha），crop 是一个子区；
//                         idref 是每个场景单独渲的 QW × QH 法线 / ID 参照（不走拼图的视口 / 裁剪），执行器拿它核拼图里的子区位置与内容
//
// 子区覆盖：bands-rim-fill-sky   三档分档 + 羽化 + edgeNoise + 双色亮芯撕边边缘光（rimCore / rimBreak）+ 两档下方补光 + 天空冷光
//           shadow-deform        平行光量化投影 + 顶点形变钩子 vertexBegin + bind 挂的 makeDepthMaterial（投影跟着形体弯）
//           surface-layers       patchLayer（color / tint 两种锈斑）、paintLayer、muralLayer；场景里没有灯，走 uKeyDirW 主光方向
//           instanced-tints      InstancedMesh：每个实例自己的三档色调（实例色 × 乘法色调）+ 实例化投影
import * as THREE from 'three';
import { toonKind, makeToonShared, setToonShared } from './toon.js';
import { patchLayer, paintLayer, muralLayer } from './surface.js';

export const QW = 320, QH = 240;
export const REGIONS = [
  { id: 'bands-rim-fill-sky', x: 0, y: QH, ids: [[1, 1], [2, 1]] }, { id: 'shadow-deform', x: QW, y: QH, ids: [[1, 1], [2, 1], [3, 1], [4, 1]] },
  { id: 'surface-layers', x: 0, y: 0, ids: [[1, 1]] }, { id: 'instanced-tints', x: QW, y: 0, ids: [[1, 1], [2, 12]] },
];
const A = 'bands-rim-fill-sky', B = 'shadow-deform', C = 'surface-layers', D = 'instanced-tints';
const neg = (region, what, v) => ({ kind: 'negative', region, what, ...v }), abl = (region, what, v) => ({ kind: 'ablation', region, what, ...v });
export const VARIANTS = {
  base: {},
  'neg-step1': neg(A, '分档阈值 step1 整体 +0.12', { mat: { hard: { step1: 0.67 }, soft: { step1: 0.72 } } }),
  'neg-shadow-quant': neg(B, '投影量化窗口放开到 0..1（等于不量化）', { mat: { all: { shadowLo: 0, shadowHi: 1 } } }),
  'neg-rim-off': neg(A, '关掉背光侧与受光侧边缘光', { mat: { all: { rimAmt: 0, rimLitAmt: 0 } } }),
  'neg-depth-deform-off': neg(B, '摘掉带顶点形变的阴影深度材质（投影不跟形体弯）', { depthDeform: false }),
  'abl-band3': abl(A, '第三档并进第二档（三档变两档）', { mat: { hard: { shade2: '#7a2f45' }, soft: { shade2: '#24464f' } } }),
  'abl-feather': abl(A, '绳结的羽化 0.14 / 0.1 收成硬边', { mat: { soft: { feather1: 0.02, feather2: 0.02 } } }),
  'abl-edge-noise': abl(A, '关掉明暗交界线噪声 edgeNoise', { mat: { hard: { edgeNoise: 0 } } }),
  'abl-rim-core-back': abl(A, '关掉背光侧边缘光亮芯（绳结的 rimColor2）', { mat: { soft: { rimColor2: null } } }),
  'abl-rim-core-lit': abl(A, '关掉受光侧边缘光亮芯（球的 rimLitColor2）', { mat: { hard: { rimLitColor2: null } } }),
  'abl-rim-break': abl(A, '关掉边缘光撕边 rimBreak', { mat: { hard: { rimBreak: 0 } } }),
  'abl-fill': abl(A, '关掉下方补光', { mat: { all: { fillAmt: 0 } } }),
  'abl-sky': abl(A, '关掉天空冷光', { mat: { all: { skyAmt: 0 } } }),
  'abl-patch': abl(C, '关掉 patchLayer 的锈斑 / 藻斑 / 斑点 / 斑驳', { mat: { patch: { rustAmt: 0, algaeAmt: 0, spotAmt: 0, dabAmt: 0 }, tint: { rustAmt: 0, algaeAmt: 0, spotAmt: 0, dabAmt: 0 } } }),
  'abl-paint-stroke': abl(C, '关掉 paintLayer 的干笔笔触', { mat: { paint: { strokeAmt: 0 } } }),
  'abl-paint-grain': abl(C, '关掉 paintLayer 的颜料颗粒', { mat: { paint: { grainAmt: 0 } } }),
  'abl-mural': abl(C, '关掉 muralLayer 的风化', { mat: { mural: { muralAmt: 0 } } }),
  'abl-key-dir': abl(C, '没有灯时的主光方向 uKeyDirW 换一个方向', { keyDir: [-0.6, 0.5, 0.6] }),
  'abl-inst-tint': abl(D, '实例的两档阴影色调抹平成同一档', { mat: { inst: { shade1Tint: [0.8, 0.82, 0.9], shade2Tint: [0.8, 0.82, 0.9] } } }),
  'abl-id-outline-w': abl(B, '法线 / ID 通道：芦苇的描边权重 outlineW 1 → 0.5', { pass: 'id', mat: { reed: { outlineW: 0.5 } } }),
  'abl-id-instance': abl(D, '法线 / ID 通道：关掉实例 ID（整批实例同一个 ID）', { pass: 'id', mat: { inst: { instanceId: false } } }),
  'same-color': { kind: 'identity', region: B, what: '变体路径正对照：不改参数，只渲彩色的一个子区' },
  'same-id': { kind: 'identity', region: D, what: '变体路径正对照：不改参数，只渲法线 / ID 通道的一个子区', pass: 'id' },
};

const over = (v, key) => ({ ...v.mat?.all, ...v.mat?.[key] });   // 这个变体对某个材质的参数覆盖
const camera = (pos, at, fov = 30) => { const c = new THREE.PerspectiveCamera(fov, QW / QH, 1, 100); c.position.set(...pos); c.lookAt(...at); return c; };
function sunLight(scene, pos, shadow) {   // shadow = 阴影贴图边长（不写不投影）；故意给得低，投影边缘占好几个屏幕像素，采样核与量化的差别才量得出来
  const sun = new THREE.DirectionalLight(0xffffff, 1); sun.position.set(...pos); scene.add(sun);
  if (!shadow) return sun;
  sun.castShadow = true; sun.shadow.mapSize.set(shadow, shadow); sun.shadow.bias = -0.002;
  Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 30 });
  return sun;
}
const ground = (kind, color, opts) => { const g = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), kind.make({ color, shade1Tint: [0.12, 0.12, 0.22], edgeNoise: 0, rimAmt: 0, ...opts })); g.rotation.x = -Math.PI / 2; return kind.bind(g, g.material, { castShadow: false }); };

function bands(v) {
  const shared = makeToonShared({ fillDir: [0.2, -1, 0.3], skyDir: [0, 1, 0] });
  const kind = toonKind({ name: 's5-bands', shared, rimCore: true, skyStepUniform: true });
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#2a2d52'); sunLight(scene, [5, 3, 1.5]);   // 侧光：三档都露在镜头里
  // 球：受光侧边缘光比背光侧宽、会盖住它，所以背光侧的亮芯放在绳结上看（绳结不开受光侧边缘光）
  const hard = kind.make({ color: '#c8553d', shade1: '#7a2f45', shade2: '#3a1d40', step1: 0.55, feather1: 0.02, step2: 0.3, feather2: 0.03, edgeNoise: 0.05, edgeNoiseScale: 2.2,
    rimColor: '#ffd9a0', rimAmt: 1, rimColor2: '#ffffff', rimCore: 0.1, rimBreak: 0.25, rimNoiseScale: 3,
    rimLitColor: '#fff2c0', rimLitAmt: 0.9, rimLitColor2: '#ffffff', fillAmt: 0.8, skyAmt: 0.7, skyStep: 0.3, ...over(v, 'hard') });
  const soft = kind.make({ color: '#4f8f6a', shade1: '#24464f', shade2: '#141f3a', step1: 0.6, feather1: 0.14, step2: 0.35, feather2: 0.1, edgeNoise: 0,
    rimColor: '#ffd9a0', rimAmt: 1, rimPower: 0.35, rimInside: 0.5, rimColor2: '#ff7a3c', rimCore: 0.08, fillAmt: 0.6, fillFlat: 0.2, skyAmt: 0.5, skyStep: 0.1, ...over(v, 'soft') });
  const ball = kind.bind(new THREE.Mesh(new THREE.SphereGeometry(1.15, 48, 32)), hard); ball.position.x = -1.3;
  const knot = kind.bind(new THREE.Mesh(new THREE.TorusKnotGeometry(0.75, 0.28, 128, 24)), soft); knot.position.x = 1.25;
  scene.add(ball, knot);
  return { scene, cam: camera([0, 0.4, 7.6], [0, 0, 0]), shared: [shared] };
}

function shadow(v) {
  const kind = toonKind({ name: 's5-shadow' });
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#8a7fb8'); sunLight(scene, [4, 7, 3], 128);
  scene.add(ground(kind, '#d8c8a8', over(v, 'ground')));
  const reedMat = kind.make({ color: '#5c9e58', uniforms: { uS5Bend: { value: 1.3 } }, vertexPars: 'uniform float uS5Bend;\n',
    vertexBegin: 'float s5t = position.y / 3.2 + 0.5;\ntransformed.x += uS5Bend * s5t * s5t * 1.6;\ntransformed.z += uS5Bend * sin( s5t * 3.0 ) * 0.4;\n', ...over(v, 'reed') });
  const reed = kind.bind(new THREE.Mesh(new THREE.BoxGeometry(0.5, 3.2, 0.5, 2, 24, 2)), reedMat); reed.position.set(-1.6, 1.6, 0);
  if (v.depthDeform === false) reed.customDepthMaterial = undefined;
  const ball = kind.bind(new THREE.Mesh(new THREE.SphereGeometry(0.8, 40, 28)), kind.make({ color: '#d98a4a', ...over(v, 'ball') })); ball.position.set(1.5, 1.5, 0.6);
  const ring = kind.bind(new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.22, 20, 64)), kind.make({ color: '#6a7fc8', ...over(v, 'ring') })); ring.position.set(0.2, 0.9, -1.6); ring.rotation.x = 0.6;
  scene.add(reed, ball, ring);
  return { scene, cam: camera([0.3, 4.8, 7.6], [0.3, 0.7, 0], 32), shared: [kind.shared] };
}

function surface(v) {
  const shared = makeToonShared({ keyDir: v.keyDir || [0.4, 0.7, 0.6] });   // 没有灯：主光方向取 uKeyDirW
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#e9e2d0');
  const patch = { patchScale: 1.4, rustAmt: 0.9, rustThr: 0.05, algaeAmt: 0.8, algaeThr: 0.2, spotAmt: 0.8, spotThr: 0.45, spotScale: 5, dabAmt: 0.35, dabScale: 3 };
  const items = [
    ['patch', toonKind({ name: 's5-patch', shared, layers: [patchLayer()] }), { color: '#7fa3a8', ...patch }, new THREE.SphereGeometry(0.9, 40, 28)],
    ['tint', toonKind({ name: 's5-patch-tint', shared, layers: [patchLayer({ rust: 'tint', core: false, algaeK: 0.6 })] }), { color: '#c9b27a', ...patch }, new THREE.CylinderGeometry(0.7, 0.8, 1.8, 32, 4)],
    ['paint', toonKind({ name: 's5-paint', shared, layers: [paintLayer] }), { color: '#8fae5c', ...patch, patchStretch: 0.6, rustAmt: 0.5, rustBreak: 0.2, rustPool: 0.6, rustSpatter: 0.8, rustDapple: 0.15,
      spotCluster: 0.6, strokeAmt: 0.45, strokeScale: 3, grainAmt: 0.4, grainScale: 9 }, new THREE.SphereGeometry(0.9, 40, 28)],
    ['mural', toonKind({ name: 's5-mural', shared, layers: [muralLayer] }), { color: '#b5523a', muralAmt: 1, muralScale: 1.6 }, new THREE.BoxGeometry(1.5, 1.5, 1.5)],
  ];
  items.forEach(([key, kind, opts, geo], i) => { const m = kind.bind(new THREE.Mesh(geo), kind.make({ ...opts, ...over(v, key) })); m.position.x = -3 + 2 * i; m.rotation.set(0.5, 0.6 + 0.3 * i, 0); scene.add(m); });
  return { scene, cam: camera([0, 0, 11], [0, 0, 0]), shared: [shared] };
}

function instanced(v) {
  const kind = toonKind({ name: 's5-inst' });
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#31424f'); sunLight(scene, [-3, 8, 4], 256);
  const g = ground(kind, '#b9c2b0', over(v, 'ground')); g.position.y = -0.7; scene.add(g);
  const mat = kind.make({ color: '#ffffff', edgeNoise: 0.04, edgeNoiseScale: 1.5, rimAmt: 0.6, ...over(v, 'inst') });
  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.55, 2), mat, 12), o = new THREE.Object3D();
  const hues = ['#d9534f', '#e08e45', '#e6c84f', '#9bc53d', '#4fae6a', '#3fa7a0', '#4f8fd9', '#5b6ee1', '#8a5bd6', '#c05bbf', '#d95b8a', '#a0a0a0'];
  for (let i = 0; i < 12; i++) {
    o.position.set(-2.4 + 1.6 * (i % 4), 0.25 * (i % 3), 1.5 - 1.5 * Math.floor(i / 4)); o.rotation.set(0.3 * i, 0.7 * i, 0); o.scale.setScalar(0.8 + 0.05 * (i % 5)); o.updateMatrix();
    mesh.setMatrixAt(i, o.matrix); mesh.setColorAt(i, new THREE.Color(hues[i]));
  }
  scene.add(kind.bind(mesh, mat));
  return { scene, cam: camera([0, 5, 8.5], [0, 0, 0.4], 32), shared: [kind.shared] };
}

const BUILD = [bands, shadow, surface, instanced];
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

export function renderSuite(names = ['base']) {
  const W = QW * 2, H = QH * 2;
  // 与 engine/stage/film.js 的 createFilm 同样的渲染器设置
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1); renderer.setSize(W, H); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
  // 软阴影：r170 是 PCFSoftShadowMap；r187 已删掉它（设了会退回 PCFShadowMap 并告警），直接给 PCFShadowMap，采样核由 quantizeShadow 换回 r170 的
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.REVISION === '170' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap; renderer.setScissorTest(true);
  const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  const rt = new THREE.WebGLRenderTarget(W, H); rt.scissorTest = true;
  // 一个子区渲一遍。渲到渲染目标时 three 用的是目标自己的视口 / 裁剪（阴影通道结束后还会按它重设），所以两边都设
  function draw(part, r, idPass) {
    part.shared.forEach(S => setToonShared(S, { pass: idPass ? 1 : 0 }));
    renderer.setViewport(r.x, r.y, QW, QH); renderer.setScissor(r.x, r.y, QW, QH); rt.viewport.set(r.x, r.y, QW, QH); rt.scissor.set(r.x, r.y, QW, QH);
    renderer.setRenderTarget(idPass ? rt : null); renderer.render(part.scene, part.cam);
  }
  function read(idPass, x, y, w, h) {
    const px = new Uint8Array(w * h * 4);
    if (idPass) renderer.readRenderTargetPixels(rt, x, y, w, h, px); else { renderer.setRenderTarget(null); gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    return b64(px);
  }
  // 独立参照：自己的 QW × QH 渲染目标、默认的整幅视口、不开裁剪，不经过上面的 draw
  function idRef(part) {
    const one = new THREE.WebGLRenderTarget(QW, QH), px = new Uint8Array(QW * QH * 4);
    part.shared.forEach(S => setToonShared(S, { pass: 1 }));
    renderer.setRenderTarget(one); renderer.render(part.scene, part.cam); renderer.readRenderTargetPixels(one, 0, 0, QW, QH, px);
    one.dispose();
    return b64(px);
  }
  const frames = {};
  for (const name of names) {
    const v = VARIANTS[name];
    if (name === 'base') {
      const parts = BUILD.map(f => f(v)); frames.base = {};
      for (const idPass of [false, true]) { parts.forEach((p, i) => draw(p, REGIONS[i], idPass)); frames.base[idPass ? 'id' : 'color'] = read(idPass, 0, 0, W, H); }
      frames.idref = Object.fromEntries(parts.map((p, i) => [REGIONS[i].id, idRef(p)]));
    } else {
      const i = REGIONS.findIndex(r => r.id === v.region), r = REGIONS[i], idPass = v.pass === 'id';
      draw(BUILD[i](v), r, idPass); frames[name] = { crop: read(idPass, r.x, r.y, QW, QH) };
    }
  }
  return { revision: THREE.REVISION, gpu: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '', frames };
}
