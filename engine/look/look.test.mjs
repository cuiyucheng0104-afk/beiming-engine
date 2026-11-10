// engine/look 的回归测试（Node，不需要 GPU）：node --test engine/look/look.test.mjs
// 用一个只记账的假渲染器把整条后期管线跑一遍，检查参数怎么走到着色器、mip 链怎么建、资源怎么释放。
// 画面层面的验证（光晕剖面、纸纹 / 颗粒、墨线宽度、ID 图读回）在 engine/look/gpu.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import * as LOOK from './index.js';   // 按命名空间取：修改前的代码缺新导出时，只让相关用例失败，不让整个文件加载失败
const { createLook, LOOK_BASE } = LOOK;
const lookParams = (...a) => LOOK.lookParams(...a), lookDefaults = (...a) => LOOK.lookDefaults(...a);
import { createBloom } from './bloom.js';
import { createInk } from './ink.js';
import { createIdPass } from './ids.js';
import { mergeParam } from './params.js';
import { toonKind } from '../shade/toon.js';

// 假渲染器：记下每次 render 时挂在哪个目标上、画的是什么
function fakeRenderer() {
  let rt = null; const cc = new THREE.Color(0, 0, 0);
  const r = {
    draws: [], autoClear: true, shadowMap: { autoUpdate: true, enabled: false },
    getRenderTarget: () => rt, setRenderTarget: t => { rt = t; },
    getClearColor: c => c.copy(cc), setClearColor: c => cc.set(c), getClearAlpha: () => 1,
    clear() {}, readRenderTargetPixels() {},
    render(obj) { r.draws.push({ target: rt, material: obj.material, obj }); },
    toneMapping: THREE.NoToneMapping, outputColorSpace: THREE.SRGBColorSpace, toneMappingExposure: 1,
  };
  return r;
}
const fakeFx = () => {
  const fx = { draws: [] };
  fx.material = (fs, uniforms, defines = {}) => ({ fs, uniforms, defines, dispose() {} });
  fx.draw = (m, target) => fx.draws.push({ m, target });
  return fx;
};
const outlined = (n = 3) => {
  const scene = new THREE.Scene();
  for (let i = 0; i < n; i++) { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); m.userData.outline = true; m.position.x = i; scene.add(m); }
  return scene;
};
// 数 ID 材质（顶点着色器带 uBaseId 的 ShaderMaterial）被释放了几次
function countIdDisposals(fn) {
  const orig = THREE.ShaderMaterial.prototype.dispose, seen = new Set();
  THREE.ShaderMaterial.prototype.dispose = function () { if (/uBaseId/.test(this.vertexShader)) seen.add(this); return orig.call(this); };
  try { fn(); } finally { THREE.ShaderMaterial.prototype.dispose = orig; }
  return seen.size;
}

test('R39 每帧参数写成数字：换成约定字段，grade 写数字报错', () => {
  const D = lookDefaults();
  const r = lookParams({ paper: 0.12, bloom: 0.6, kuwahara: 0.5, outline: 0.4, fog: 0.05 }, D);
  assert.equal(r.paper.strength, 0.12); assert.equal(r.paper.scale, 1);
  assert.equal(r.bloom.strength, 0.6); assert.equal(r.bloom.threshold, LOOK_BASE.bloom.threshold);
  assert.equal(r.kuwahara.strength, 0.5); assert.equal(r.kuwahara.radius, LOOK_BASE.kuwahara.radius);
  assert.equal(r.outline.opacity, 0.4); assert.equal(r.outline.color, LOOK_BASE.outline.color);
  assert.deepEqual(r.fog, { density: 0.05 });
  assert.equal(lookParams({ outline: 0 }, D).outline.opacity, 0);
  assert.throws(() => lookParams({ grade: 1.1 }, D), /grade/);
  // 原有写法不变
  assert.equal(lookParams({ outline: false, fog: null }, D).outline, null);
  assert.equal(lookParams({}, D).fog, null);
  assert.equal(lookParams({ vignette: { strength: .3 }, grain: .5 }, D).vignette, .3);
  assert.equal(lookParams({ grain: { amount: .4 } }, D).grain, .4);
});

test('R39 opts.defaults 与 LOOK_BASE 逐项合并（缺字段不再是 undefined）', () => {
  const D = lookDefaults({ outline: { width: 3 }, paper: 0.2, fog: { density: .01 }, kuwahara: false });
  assert.equal(D.outline.width, 3);
  for (const k of Object.keys(LOOK_BASE.outline)) assert.notEqual(D.outline[k], undefined, `outline.${k}`);
  assert.equal(D.outline.color, LOOK_BASE.outline.color);
  assert.equal(D.paper.strength, 0.2); assert.equal(D.paper.scale, 1);
  assert.deepEqual(D.fog, { density: .01 });
  assert.equal(D.kuwahara, false); assert.equal(lookParams({}, D).kuwahara, null);
  assert.equal(D.vignette, LOOK_BASE.vignette);
  // 完整的一套（例如 src/look.js 的 LOOK_DEFAULTS）合并后逐字段不变
  const full = { ...LOOK_BASE, outline: { ...LOOK_BASE.outline, width: 2.6, color: '#2A2D52' }, grain: 0.3 };
  const M = lookDefaults(full);
  assert.deepEqual(M.outline, full.outline); assert.equal(M.grain, 0.3);
  assert.equal(mergeParam(7, null), 7);   // params.mergeParam 自身的约定不变（作品站也在用这个模块）
});

test('R39 只写了部分字段的 defaults：墨线着色器拿到的都是数，不是 undefined', () => {
  const r = fakeRenderer(), look = createLook(r, 64, 64, { defaults: { outline: { width: 2 } } });
  look.render(outlined(1), new THREE.PerspectiveCamera(), { t: 0 });
  const edge = r.draws.find(d => d.material?.uniforms?.uDepthThr)?.material.uniforms;
  assert.ok(edge, '画了边缘 pass');
  for (const k of ['uDepthThr', 'uInner', 'uSil', 'uOpacity', 'uHalfW']) assert.equal(typeof edge[k].value, 'number', k);
  const stroke = r.draws.find(d => d.material?.defines?.SR !== undefined)?.material;
  assert.ok(Number.isInteger(stroke.defines.SR), '搜索半径是整数（pressure 缺失时以前是 NaN）');
  look.dispose();
});

test('R31 bloom：mip 链按 refHeight 多降级数，输出取自与标定分辨率同尺寸的那一级', () => {
  const run = (w, h, refHeight) => {
    const fx = fakeFx(), b = createBloom(fx, { refHeight }); b.resize(w, h);
    const out = b.render({ isTexture: true }, { threshold: .7, knee: .2, radius: .6 });
    const sizes = fx.draws.map(d => [d.target.width, d.target.height]);
    return { b, out, sizes, firstFs: fx.draws[0].m.fs };
  };
  const a = run(1920, 1040, 1080), k = run(3840, 2080, 1080), legacy = run(3840, 2080, 0);
  assert.equal(a.b.skip, 0); assert.equal(a.b.levels, 7);
  assert.equal(k.b.skip, 1); assert.equal(k.b.levels, 8);
  assert.equal(legacy.b.skip, 0); assert.equal(legacy.b.levels, 7);
  assert.deepEqual([a.out.image.width, a.out.image.height], [960, 520]);
  assert.deepEqual([k.out.image.width, k.out.image.height], [960, 520]);   // 4K 的光晕从 960×520 那一级取，与 1040 相同
  const coarsest = s => s.reduce((m, x) => (x[0] < m[0] ? x : m), [1e9, 0]);
  assert.deepEqual(coarsest(a.sizes), [15, 8]); assert.deepEqual(coarsest(k.sizes), [15, 8]);   // 最粗一级相对画面一样大
  assert.doesNotMatch(k.firstFs, /uThr/, '4K 先做一次不带阈值的 2×2 盒子平均');
  assert.match(a.firstFs, /uThr/, '1040 直接预滤（和修改前一样）');
});

test('R35 墨线搜索半径：随分辨率放宽上限，并计入 farScale / inner > 1', () => {
  const run = (H, p) => {
    const fx = fakeFx(), ink = createInk(fx), ss = 2, k = H / 1080;
    const ids = { width: Math.round(H * 16 / 9) * ss, height: H * ss, texture: {}, depthTexture: {} };
    const tgt = { texture: {} };
    ink.render({ ids, edge: tgt, line: tgt, camera: new THREE.PerspectiveCamera(), p: { ...LOOK_BASE.outline, ...p }, fog: null, t: 0, k, ss, maxWidth: 1 });
    return fx.draws.at(-1).m.defines.SR;
  };
  assert.equal(run(2080, { width: 6, pressure: 0, farScale: 1 }), 13);   // 修改前被钳在 8
  assert.equal(run(1040, { width: 6, pressure: 0, farScale: 1 }), 7);
  assert.equal(run(1040, { width: 9, pressure: 0, farScale: 1 }), 8);    // 1040 的上限仍是 8
  assert.equal(run(1040, { width: 2.6, farScale: 3, pressure: 0 }), 8);  // farScale 3：半线宽 7.5，修改前只估到 4
  assert.equal(run(1040, { width: 1, farScale: 3, pressure: 0 }), 4);    // 修改前估成 2（只算了 width），半线宽 2.9 的笔被截成方块
  // 《北冥》正片参数：1040 与原生 4K 都和修改前一样（5 / 8）
  const film = { width: 2.6, pressure: 0.35, farScale: 0.55, inner: 0.55 };
  assert.equal(run(1040, film), 5); assert.equal(run(2080, film), 8);
});

test('R32 原生 4K：图片纸纹平铺与颗粒格子按整数倍放大，1040 不变', () => {
  const tex = new THREE.Texture(); tex.image = { width: 1024, height: 1024 };
  const compose = (W, H) => {
    const r = fakeRenderer(), look = createLook(r, W, H, {}), target = new THREE.WebGLRenderTarget(4, 4);
    look.render(new THREE.Scene(), new THREE.PerspectiveCamera(), { t: 1, outline: false, kuwahara: false, bloom: false, paper: { strength: .12, tex }, grain: .65, target });
    const u = r.draws.filter(x => x.target === target).at(-1).material.uniforms;
    look.dispose(); return u;
  };
  const a = compose(1920, 1040), b = compose(3840, 2080);
  assert.equal(a.uGrainCell.value, 1); assert.deepEqual(a.uPaperSize.value.toArray(), [1024, 1024]);
  assert.equal(b.uGrainCell.value, 2); assert.deepEqual(b.uPaperSize.value.toArray(), [2048, 2048]);
});

test('R42 look.dispose：释放 ID 通道缓存的材质，不删 three 全局共享的全屏几何', async () => {
  let shared = 0; new FullScreenQuad()._mesh.geometry.addEventListener('dispose', () => shared++);
  const r = fakeRenderer(), look = createLook(r, 64, 64, {}); await look.ready;
  look.render(outlined(3), new THREE.PerspectiveCamera(), { t: 0 });
  assert.equal(countIdDisposals(() => look.dispose()), 3, '三个描边网格的 ID 材质都要释放');
  assert.equal(shared, 0, 'look.dispose 不能删全局共享的全屏几何');
});

test('R40 ID 通道：材质不可见的网格原样跳过；不挡线物体换不可见材质，子物体照常参与', () => {
  const r = fakeRenderer(), ids = createIdPass(r);
  const scene = outlined(3);
  const ghost = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ visible: false })); scene.add(ghost);
  const ghostChild = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ visible: false })); scene.children[0].add(ghostChild);   // 继承 outline:true
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending }));
  const child = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); child.userData.outline = true; glow.add(child); scene.add(glow);
  const multi = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial({ visible: false })]); multi.userData.outline = true; scene.add(multi);
  const ghostMat = ghost.material, ghostChildMat = ghostChild.material, multiMats = multi.material;
  let during = null;
  r.render = () => { during = { ghost: ghost.material, ghostChild: ghostChild.material, glowVisible: glow.visible, glowMatVisible: glow.material.visible, child: child.material, multi: multi.material }; };
  ids.render(scene, new THREE.PerspectiveCamera(), null);
  assert.equal(during.ghost, ghostMat, '材质 visible=false 的网格不换 ID 材质（不再成为实心挡线物）');
  assert.equal(during.ghostChild, ghostChildMat, '继承了描边的隐形子物体也不描边');
  assert.equal(during.glowVisible, true, '不挡线的物体不靠 visible=false 隐藏（那样会连子物体一起剪掉）');
  assert.equal(during.glowMatVisible, false);
  assert.match(during.child.vertexShader, /uBaseId/, '子物体照常换上 ID 材质');
  assert.ok(Array.isArray(during.multi) && /uBaseId/.test(during.multi[0].vertexShader) && during.multi[1] === multiMats[1], '多材质：只换可见的组');
  assert.equal(glow.material.blending, THREE.AdditiveBlending, '渲完换回原材质');
  assert.equal(multi.material, multiMats);
  assert.equal(countIdDisposals(() => ids.dispose()), 5, '3 个描边网格 + 子物体 + 多材质网格的 ID 材质');
});

test('R33 ID 通道：soft 遮挡的材质自带 onBeforeRender 改混合时，回调之后重新套上挡线混合', () => {
  const r = fakeRenderer(), ids = createIdPass(r);
  const scene = outlined(1);
  const veil = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ transparent: true, opacity: .5 }));
  veil.material.onBeforeRender = () => { veil.material.blending = THREE.NormalBlending; veil.material.depthWrite = true; };
  scene.add(veil);
  let seen = null;
  r.render = () => { veil.material.onBeforeRender(); seen = { blending: veil.material.blending, depthWrite: veil.material.depthWrite }; };
  ids.render(scene, new THREE.PerspectiveCamera(), null);
  assert.equal(seen.blending, THREE.CustomBlending); assert.equal(seen.depthWrite, false);
  assert.equal(veil.material.blending, THREE.NormalBlending, '渲完恢复');
});

test('R33 回归 noId：只跳过用 noId 材质画的那一个网格（多材质时那一组），挂在下面的普通网格照常挡线 / 描边', () => {
  const kind = toonKind({ name: 'r33ids' });
  const r = fakeRenderer(), ids = createIdPass(r);
  const scene = outlined(1);
  const isId = m => !!m && /uBaseId/.test(m.vertexShader || '');
  const id = m => isId(m) ? { base: m.uniforms.uBaseId.value, w: m.uniforms.uWidth.value } : null;
  // 1) 卡通 noId 父物体（outline:false）+ 普通不透明子网格（自己不写 userData）：子网格在主渲染里是实心的，应当挡线
  const pm = kind.make({ noId: true }), parent = kind.bind(new THREE.Mesh(new THREE.PlaneGeometry(), pm), pm, { outline: false });
  const child = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); parent.add(child); scene.add(parent);
  // 2) 卡通 noId 父物体按默认 outline:true 绑定：自己不描边，子物体照常继承描边
  const pm2 = kind.make({ noId: true }), parent2 = kind.bind(new THREE.Mesh(new THREE.PlaneGeometry(), pm2), pm2);
  const child2 = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); parent2.add(child2); scene.add(parent2);
  // 3) 通用写法：任意材质写 userData.noId = true，下面同样挂一个不透明子网格
  const gm = new THREE.MeshBasicMaterial(); gm.userData.noId = true;
  const generic = new THREE.Mesh(new THREE.PlaneGeometry(), gm), gChild = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  generic.add(gChild); scene.add(generic);
  // 4) 多材质：noId 的那一组不画，其余组照常（实心挡线 / 软遮挡沿用自身材质）
  const multi = new THREE.Mesh(new THREE.BoxGeometry(), [kind.make({ noId: true }), new THREE.MeshBasicMaterial()]); scene.add(multi);
  const veil = new THREE.MeshBasicMaterial({ transparent: true, opacity: .5 });
  const multiSoft = new THREE.Mesh(new THREE.BoxGeometry(), [kind.make({ noId: true }), veil]); scene.add(multiSoft);
  const all = [parent, child, parent2, child2, generic, gChild, multi, multiSoft], before = all.map(o => o.material);
  const tag = m => isId(m) ? 'id' : m.visible === false ? 'hide' : m === veil ? 'veil' : 'own';
  let d = null;
  r.render = () => {
    d = { parent: parent.material.visible, child: id(child.material), parent2: parent2.material.visible, child2: id(child2.material),
      generic: generic.material.visible, gChild: id(gChild.material),
      multi: multi.material.map(tag), multiSolid: id(multi.material[1]), multiSoft: multiSoft.material.map(tag), veilBlend: veil.blending };
  };
  ids.render(scene, new THREE.PerspectiveCamera(), null);
  assert.equal(d.parent, false, 'noId 网格本身不画进 ID 图（不描边、不挡线）');
  assert.deepEqual(d.child, { base: 0, w: 0 }, `noId 网格下面的普通子网格照常实心挡线，读到 ${JSON.stringify(d.child)}（上一轮：继承 outlineOccluder=false 被跳过）`);
  assert.equal(d.parent2, false, 'outline:true 绑定的 noId 网格本身也不描边');
  assert.ok(d.child2 && d.child2.base > 0 && d.child2.w === 1, `子物体照常继承 outline:true 描边，读到 ${JSON.stringify(d.child2)}`);
  assert.equal(d.generic, false, '任意材质写 userData.noId = true 同样生效');
  assert.deepEqual(d.gChild, { base: 0, w: 0 });
  assert.deepEqual(d.multi, ['hide', 'id'], '多材质：noId 的组不画，另一组照常换 ID 材质');
  assert.deepEqual(d.multiSolid, { base: 0, w: 0 });
  assert.deepEqual(d.multiSoft, ['hide', 'veil'], '多材质软遮挡：noId 的组不画，另一组沿用自身材质');
  assert.equal(d.veilBlend, THREE.CustomBlending);
  assert.deepEqual(all.map(o => o.material), before, '渲完全部换回原材质');
  assert.equal(veil.blending, THREE.NormalBlending);
});
