// engine/shade 的回归测试（Node，不需要 GPU）：node --test engine/shade/shade.test.mjs
// 着色器在 GPU 上的行为（ID 图读回、壁画层导数）在 engine/look/gpu.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { colorOf, inject, patchVertex, quantizeShadow, makeDepthMaterial } from './patch.js';
import { toonKind, tintFrom } from './toon.js';
import { muralLayer } from './surface.js';

test('R41 colorOf：[r,g,b] 按 sRGB 解释（与 engine/look/params.js 的 toColor 一致），不认识的类型报错', () => {
  const ref = new THREE.Color().setRGB(.8, .5, .3, THREE.SRGBColorSpace);
  assert.equal(colorOf([.8, .5, .3]).getHexString(), ref.getHexString());
  assert.equal(colorOf('#cc804d').getHexString(), 'cc804d');
  assert.equal(colorOf(0x336699).getHexString(), '336699');
  const c = new THREE.Color('#123456'), d = colorOf(c); assert.notEqual(d, c); assert.equal(d.getHexString(), '123456');
  assert.equal(colorOf(undefined).getHexString(), 'ffffff');
  assert.throws(() => colorOf({ r: 1, g: 0, b: 0 }), TypeError);
  assert.throws(() => colorOf(true), TypeError);
});

test('R41 tintFrom 与卡通材质的颜色参数接受数组', () => {
  const t = tintFrom('#808080', [.2, .2, .4]);
  const base = new THREE.Color('#808080'), sh = new THREE.Color().setRGB(.2, .2, .4, THREE.SRGBColorSpace);
  assert.ok(Math.abs(t.x - sh.r / base.r) < 1e-9 && Math.abs(t.z - sh.b / base.b) < 1e-9, '阴影色调不再静默变白');
  const kind = toonKind({ name: 'r41' });
  const m = kind.make({ color: [.8, .5, .3], shade1: [.4, .25, .15], inkColor: [0, 0, 0], fillColor: [1, 0, 0] });
  assert.equal(m.color.getHexString(), new THREE.Color().setRGB(.8, .5, .3, THREE.SRGBColorSpace).getHexString());
  assert.equal(m.userData.toon.uInkColor.value.getHexString(), '000000');
  assert.equal(m.userData.toon.uFillColor.value.getHexString(), 'ff0000');
  assert.ok(m.userData.toon.uShade1Tint.value.x < 1, '阴影档按给定颜色');
  // 十六进制写法结果不变
  assert.equal(kind.make({ color: '#d2b48c' }).color.getHexString(), 'd2b48c');
});

test('R33 noId：标记记在材质上（material.userData.noId），bind 不改会被子物体继承的 userData 开关', () => {
  const kind = toonKind({ name: 'r33a' });
  const m = kind.make({ noId: true });
  assert.equal(m.userData.noId, true, 'engine/look 的 ID 图按材质跳过用它画的网格');
  for (const outline of [true, false]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), m); kind.bind(mesh, m, { outline });
    // outlineOccluder / outline 在 ids.js 里由子物体继承：写 false 会把挂在下面的普通实心网格也变成「不挡线」「不描边」
    assert.equal(mesh.userData.outlineOccluder, undefined, `outline:${outline} 时不写可继承的 outlineOccluder`);
    assert.equal(mesh.userData.outline, outline, `outline:${outline} 原样记下（子物体照常继承调用方给的值）`);
  }
  const m2 = kind.make({}), mesh2 = new THREE.Mesh(new THREE.BoxGeometry(), m2); kind.bind(mesh2, m2);
  assert.equal(m2.userData.noId, undefined, '普通材质不带 noId');
  assert.equal(mesh2.userData.outline, true); assert.equal(mesh2.userData.outlineOccluder, undefined, '普通材质不受影响');
});

test('R33 translucent：只在 uToonPass 切换时改混合，同一通道里别人临时改的混合不被冲掉', () => {
  const kind = toonKind({ name: 'r33b' });
  const m = kind.make({ translucent: true, opacity: .5 }), S = kind.shared;
  assert.equal(m.blending, THREE.NormalBlending); assert.equal(m.depthWrite, false);
  m.blending = THREE.CustomBlending;              // ids.js 给软遮挡打的补丁
  m.onBeforeRender();                             // 同一通道（彩色 / engine/look 的 ID 图都是 uToonPass = 0）
  assert.equal(m.blending, THREE.CustomBlending, '补丁保留');
  m.blending = THREE.NormalBlending;              // ids.js 渲完恢复
  S.uToonPass.value = 1; m.onBeforeRender();      // 旧的法线 / ID 通道：不混合、写深度
  assert.equal(m.blending, THREE.NoBlending); assert.equal(m.depthWrite, true);
  S.uToonPass.value = 0; m.onBeforeRender();
  assert.equal(m.blending, THREE.NormalBlending); assert.equal(m.depthWrite, false);
});

test('R37 壁画层：分支只按 uniform 判断，toonMuralK 只进风化量（负值按 0）', () => {
  const post = muralLayer.post;
  const cond = post.match(/if\s*\(([^)]*)\)\s*\{/)[1];
  assert.doesNotMatch(cond, /toonMuralK/, '分支条件里不能有逐像素的 toonMuralK（fwidth 会落进非一致控制流）');
  assert.match(cond, /uMuralAmt/);
  assert.match(post, /max\(\s*toonMuralK\s*,\s*0\.0\s*\)/);
  // 分支内部不能再有依赖逐像素量的 if（fwidth 都在一致控制流里）
  const body = post.slice(post.indexOf('{') + 1, post.lastIndexOf('}'));
  assert.doesNotMatch(body, /\bif\s*\(/);
});

test('FX22 片段补丁没命中直接抛错：inject / patchVertex / quantizeShadow 的锚点被改掉时点名缺的锚点，不出没打补丁的着色器', () => {
  const lib = THREE.ShaderLib.toon, who = 'fx22', gone = '/* 上游改了这一段 */';
  const missing = anchor => new RegExp(`fx22：着色器锚点缺失「${anchor.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}」`);
  // inject：三种插法都先核锚点
  for (const mode of ['after', 'before', 'replace']) assert.throws(() => inject(lib.fragmentShader.replace('#include <color_fragment>', gone), '#include <color_fragment>', 'x', mode, who), missing('#include <color_fragment>'));
  // patchVertex：五个锚点逐个改掉，都报；给了 vertexNormal 钩子时 #include <beginnormal_vertex> 也算（以前这一处悄悄跳过）
  const hooks = { vertexPars: 'uniform float uFx;\n', vertexMainStart: 'float fxT = 0.0;\n', vertexNormal: 'objectNormal = normalize( objectNormal );\n', vertexBegin: 'transformed.x += uFx;\n' }, own = { project: 'fxT = 1.0;' };
  const patched = patchVertex(lib.vertexShader, hooks, own, who);
  for (const code of [...Object.values(hooks), own.project]) assert.ok(patched.includes(code), `补丁没打进去：${code}`);
  for (const anchor of ['#include <common>', 'void main() {', '#include <beginnormal_vertex>', '#include <begin_vertex>', '#include <project_vertex>'])
    assert.throws(() => patchVertex(lib.vertexShader.replace(anchor, gone), hooks, own, who), missing(anchor));
  assert.ok(patchVertex(lib.vertexShader.replace('#include <beginnormal_vertex>', gone), { ...hooks, vertexNormal: '' }, own, who).includes(hooks.vertexBegin), '没给 vertexNormal 钩子的不要求有这个锚点');
  // quantizeShadow：片元里的 #include、投影块里 getShadow 的返回写法、软阴影采样核，三处任何一处对不上都报
  assert.throws(() => quantizeShadow(lib.fragmentShader.replace('#include <shadowmap_pars_fragment>', gone), 'a', 'b', who), missing('#include <shadowmap_pars_fragment>'));
  const keep = THREE.ShaderChunk.shadowmap_pars_fragment;
  try {
    THREE.ShaderChunk.shadowmap_pars_fragment = keep.replaceAll('return mix( 1.0, shadow, shadowIntensity );', 'return mix(1.0, shadow, shadowIntensity);');
    assert.throws(() => quantizeShadow(lib.fragmentShader, 'a', 'b', who), /fx22：投影量化锚点缺失/);
    THREE.ShaderChunk.shadowmap_pars_fragment = keep.replaceAll('SHADOWMAP_TYPE_PCF_SOFT', 'SHADOWMAP_TYPE_SOFT_PCF');   // 既不是 r187 的写法，也没有 r170 自带的软阴影核
    assert.throws(() => quantizeShadow(lib.fragmentShader, 'a', 'b', who), /fx22：软阴影采样锚点缺失（three r170）：SHADOWMAP_TYPE_PCF_SOFT/);
  } finally { THREE.ShaderChunk.shadowmap_pars_fragment = keep; }
  assert.match(quantizeShadow(lib.fragmentShader, 'a', 'b', who), /smoothstep\( a, b, shadow \)/, '原样的 r170 投影块照常量化');
  // 整个材质：卡通材质与阴影深度材质的 onBeforeCompile 在原文被改掉时同步抛出（WebGLRenderer 编译前调的就是它）
  const shaderOf = (l, edit = x => x) => ({ uniforms: {}, defines: {}, vertexShader: edit(l.vertexShader), fragmentShader: edit(l.fragmentShader) });
  const kind = toonKind({ name: 'fx22' }), mat = kind.make({ vertexBegin: 'transformed.y += 0.1;\n' }), depth = makeDepthMaterial({ hooks: { vertexBegin: 'transformed.y += 0.1;\n' }, who });
  assert.doesNotThrow(() => { mat.onBeforeCompile(shaderOf(lib)); depth.onBeforeCompile(shaderOf(THREE.ShaderLib.depth)); });
  const light = 'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;';
  assert.throws(() => mat.onBeforeCompile(shaderOf(lib, x => x.replace(light, light.replace('directDiffuse + reflectedLight.indirectDiffuse', 'indirectDiffuse + reflectedLight.directDiffuse')))), missing(light));
  assert.throws(() => depth.onBeforeCompile(shaderOf(THREE.ShaderLib.depth, x => x.replace('#include <begin_vertex>', THREE.ShaderChunk.begin_vertex))), missing('#include <begin_vertex>'));
});
