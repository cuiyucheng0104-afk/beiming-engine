// three r170 着色器锚点（Node，不开浏览器）：engine/shade 往 three 内置材质里注入片段时靠的锚点，换 three 版本或改补丁时
// 在单元测试里就报出来（以前只有要浏览器的 engine/look/gpu.test.mjs 抓得到）。
//   · 用 three 自带的 ShaderLib 源码跑一遍各种材质族的 onBeforeCompile（卡通、表面层、亮芯、天光阈值、顶点钩子、
//     弯曲钩子、阴影深度材质）：全部锚点都找得到，注入的片段确实进了着色器；
//   · engine 七层源码里写到的每个 #include <块名> 在 THREE.ShaderChunk 里都存在；
//   · 故意写错锚点、或 three 的块里少了投影量化锚点时，直接抛错并说出是哪个锚点（不会悄悄失效）；
//   · engine/look/compose.js 的纸纹变体（锚点、面积取样）对得上 FINAL_FS，默认仍用 FINAL_FS 原文。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { ROOT } from './lib/browser.mjs';
import { inject, patchVertex, quantizeShadow, makeDepthMaterial } from '../../engine/shade/patch.js';
import { toonKind } from '../../engine/shade/toon.js';
import { patchLayer, paintLayer, muralLayer } from '../../engine/shade/surface.js';
import { pitchWave, pitchYawWave, pitchYawLinearWave, frameWave } from '../../engine/form/bend.js';
import { anchoredFinalFs, FINAL_FS, createCompose } from '../../engine/look/compose.js';

// 模拟 WebGLRenderer 编译前交给 onBeforeCompile 的对象
const shaderOf = lib => ({ vertexShader: THREE.ShaderLib[lib].vertexShader, fragmentShader: THREE.ShaderLib[lib].fragmentShader, uniforms: {}, defines: {} });
const compile = (mat, lib) => { const sh = shaderOf(lib); mat.onBeforeCompile(sh, null); return sh; };

test('three 版本：engine/shade 按 r170 写，升级 three 时这一组测试是第一道关', () => {
  assert.equal(THREE.REVISION, '170', '升级 three 后先跑本文件，锚点逐条对过再改这里');
});

test('卡通材质族：各种组合在 r170 的 MeshToonMaterial 源码上都能注入，片段确实进了着色器', () => {
  const kinds = {
    plain: toonKind({ name: 'a1' }),
    layers: toonKind({ name: 'a2', layers: [patchLayer(), paintLayer, muralLayer] }),
    tint: toonKind({ name: 'a3', layers: [patchLayer({ rust: 'tint', core: false })], rimCore: true, skyStepUniform: true }),
    hooks: toonKind({ name: 'a4', shade: { rimNormal: 'normalize( N + vec3( 0.0, 0.1, 0.0 ) )', bands: 'm1 = m1;', final: 'col = col;', passPre: 'toonId = toonId;' } }),
  };
  const opts = [{}, { rest: true }, { noId: true, translucent: true },
    { vertexPars: 'uniform float uA4;', vertexMainStart: 'float a4 = uA4;', vertexBegin: 'transformed.y += 0.0;', vertexNormal: 'objectNormal = objectNormal;',
      fragmentPars: 'uniform float uF4;', fragmentBase: 'diffuseColor.rgb *= 1.0;', fragmentAlbedo: 'toonInk = 0.0;', fragmentNormal: 'normal = normal;' }];
  for (const [name, kind] of Object.entries(kinds)) {
    for (const o of opts) {
      const sh = compile(kind.make(o), 'toon');
      const tag = `${name} ${JSON.stringify(Object.keys(o))}`;
      assert.match(sh.vertexShader, /varying vec3 vToonObj;/, `${tag}：顶点 own.head`);
      assert.match(sh.vertexShader, /vToonInst = float\( gl_InstanceID \);/, `${tag}：顶点 own.project`);
      assert.match(sh.fragmentShader, /uniform float uStep1, uFeather1/, `${tag}：片元参数在 #include <common> 后`);
      assert.match(sh.fragmentShader, /smoothstep\( uShadowLo, uShadowHi, shadow \)/, `${tag}：投影量化`);
      assert.match(sh.fragmentShader, /float toonInk = 0\.0;/, `${tag}：反照率钩子在 #include <color_fragment> 后`);
      assert.match(sh.fragmentShader, /float hl = 0\.5 \* dot\( N, L \) \+ 0\.5 \+ en;/, `${tag}：卡通光照替换了 outgoingLight 那一行`);
      assert.doesNotMatch(sh.fragmentShader, /vec3 outgoingLight = reflectedLight\.directDiffuse/, `${tag}：原来的光照合成行被替换掉`);
      assert.match(sh.fragmentShader, /if \( uToonPass > 0\.5 \) \{/, `${tag}：输出模式在 #include <dithering_fragment> 后`);
      if (o.vertexBegin) {
        for (const s of [o.vertexPars, o.vertexMainStart, o.vertexBegin, o.vertexNormal]) assert.ok(sh.vertexShader.includes(s), `${tag}：顶点钩子 ${s}`);
        for (const s of [o.fragmentPars, o.fragmentBase, o.fragmentAlbedo, o.fragmentNormal]) assert.ok(sh.fragmentShader.includes(s), `${tag}：片元钩子 ${s}`);
        // 有顶点钩子时挂的阴影深度材质：同样的形变在 r170 的 MeshDepthMaterial 源码上也注入得进去
        const d = compile(kind.depth(kind.make(o)), 'depth');
        assert.ok(d.vertexShader.includes(o.vertexBegin) && d.vertexShader.includes(o.vertexPars), `${tag}：深度材质带同样的顶点形变`);
      }
    }
  }
  assert.match(compile(kinds.tint.make({}), 'toon').fragmentShader, /uniform vec3 uRimColor2, uRimLitColor2;/, 'rimCore 族的亮芯参数');
  assert.match(compile(kinds.tint.make({}), 'toon').fragmentShader, /uniform float uSkyStep;/, 'skyStepUniform 族的天光阈值');
});

test('弯曲钩子：四种形式 × 四种模式在 r170 的卡通与深度材质上都能注入', () => {
  for (const [name, form] of Object.entries({ pitchWave, pitchYawWave, pitchYawLinearWave, frameWave })) {
    const f = form('fish'), U = {};   // 只看注入，不编译：uniform 的值用不到
    for (const mode of ['vertex', 'rigid', 'inst', 'none']) {
      const hk = f.modeHooks(U, { mode }), kind = toonKind({ name: `bend-${name}-${mode}` });
      const mat = kind.make({ uniforms: U, ...hk }), sh = compile(mat, 'toon');
      if (mode !== 'none') assert.match(sh.vertexShader, /fishBend|fishIM|BendRigid/, `${name} ${mode}：弯曲函数进了顶点着色器`);
      const d = makeDepthMaterial({ hooks: hk, uniforms: U, key: `d-${name}-${mode}`, who: name });
      assert.doesNotThrow(() => compile(d, 'depth'), `${name} ${mode}：深度材质`);
    }
  }
});

test('engine 七层源码里写到的 #include <块名>，THREE.ShaderChunk 里都有', () => {
  const layers = ['core', 'form', 'shade', 'stage', 'look', 'paint', 'overlay'];
  const seen = new Map();
  for (const L of layers) {
    for (const f of fs.readdirSync(path.join(ROOT, 'engine', L))) {
      if (!/\.m?js$/.test(f) || f.endsWith('.test.mjs')) continue;
      const src = fs.readFileSync(path.join(ROOT, 'engine', L, f), 'utf8');
      for (const m of src.matchAll(/#include\s*<(\w+)>/g)) {
        if (!seen.has(m[1])) seen.set(m[1], new Set());
        seen.get(m[1]).add(`engine/${L}/${f}`);
      }
    }
  }
  assert.ok(seen.size >= 15, `应当扫到引擎用到的块（实际 ${seen.size} 个）`);
  const missing = [...seen].filter(([name]) => typeof THREE.ShaderChunk[name] !== 'string').map(([n, files]) => `${n}（${[...files].join('、')}）`);
  assert.deepEqual(missing, [], `three r${THREE.REVISION} 的 ShaderChunk 里没有这些块`);
});

test('锚点写错就直接报错，说出是哪个锚点（不会悄悄失效）', () => {
  const v = THREE.ShaderLib.toon.vertexShader;
  assert.throws(() => inject(v, '#include <no_such_chunk>', 'x', 'after', 't1'), /t1：着色器锚点缺失「#include <no_such_chunk>」/);
  assert.throws(() => patchVertex(v.replace('#include <begin_vertex>', ''), { vertexBegin: 'x' }, {}, 't2'), /t2：着色器锚点缺失「#include <begin_vertex>」/);
  assert.throws(() => patchVertex(v.replace('void main() {', 'void main(){'), {}, {}, 't3'), /t3：着色器锚点缺失「void main\(\) \{」/);
  const kind = toonKind({ name: 't4' }), mat = kind.make({});
  const sh = shaderOf('toon'); sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', '');
  assert.throws(() => mat.onBeforeCompile(sh, null), /t4：着色器锚点缺失「#include <dithering_fragment>」/);
  // three 的投影块里少了量化锚点（升级后 getShadow 的返回写法变了）
  const keep = THREE.ShaderChunk.shadowmap_pars_fragment;
  try {
    THREE.ShaderChunk.shadowmap_pars_fragment = keep.replaceAll('return mix( 1.0, shadow, shadowIntensity );', 'return shadow;');
    assert.throws(() => quantizeShadow(THREE.ShaderLib.toon.fragmentShader, 'a', 'b', 't5'), /t5：投影量化锚点缺失/);
  } finally { THREE.ShaderChunk.shadowmap_pars_fragment = keep; }
  // inject 用函数替换：代码里的 $& / $1 不被当成替换模式
  assert.ok(inject('A#B', '#', 'x$&y', 'after').includes('x$&y'));
});

test('compose.js：纸纹锚点变体只换取样那一行，对得上当前的 FINAL_FS；对不上时报错', () => {
  const fs2 = anchoredFinalFs();
  assert.notEqual(fs2, FINAL_FS);
  assert.match(fs2, /uniform vec2 uRes, uPaperSize, uPaperPos, uPaperOrigin; uniform float uPaperZoom;/);
  assert.match(fs2, /\(\(gl_FragCoord\.xy - uPaperPos\) \/ uPaperZoom \+ uPaperOrigin\) \/ uPaperSize/);
  assert.equal(fs2.split('\n').length, FINAL_FS.split('\n').length, '只改行内内容，不增删行');
  assert.throws(() => anchoredFinalFs(FINAL_FS.replace('gl_FragCoord.xy / uPaperSize', 'vUv')), /锚点变体对不上/);
  // 与加面积取样之前的写法逐字相同（两个替换直接写在这里）
  const before = FINAL_FS.replace('float pp = texture2D(tPaper, gl_FragCoord.xy / uPaperSize).r;', 'float pp = texture2D(tPaper, ((gl_FragCoord.xy - uPaperPos) / uPaperZoom + uPaperOrigin) / uPaperSize).r;')
    .replace('uniform vec2 uRes, uPaperSize;', 'uniform vec2 uRes, uPaperSize, uPaperPos, uPaperOrigin; uniform float uPaperZoom;');
  assert.equal(fs2, before);
});

test('compose.js：按 paper.layer 的返回值选着色器——都不带用 FINAL_FS 原文；texels → 面积取样；anchor + texels → 两样都换', () => {
  const made = [], drawn = [];
  const fx = { material: (fs, uniforms) => { const m = { fs, uniforms, dispose() { m.disposed = true; } }; made.push(m); return m; }, draw: m => drawn.push(m) };
  const C = createCompose(fx);
  const base = { src: null, line: null, ink: { color: '#203040', tint: .3, darken: .5 }, vignette: 0, grain: 0, grainSeed: 0, w: 64, h: 32 };
  const paper = { tex: null, strength: .12, mid: .5, w: 1024, h: 1024 };
  C.render({ ...base, paper });
  assert.equal(drawn.at(-1), made[0]); assert.equal(made[0].fs, FINAL_FS, '默认（pixel 模式、不带锚点）：着色器源码与以前一字不差');
  C.render({ ...base, ink: null, paper: { ...paper, w: 1365.33, h: 1365.33, texels: [1024, 1024] } });
  const area = drawn.at(-1), u = area.uniforms;
  assert.notEqual(area, made[0]);
  assert.ok(area.fs.includes('float pp = paperArea(gl_FragCoord.xy / uPaperSize * uPaperTexels, .5 * uPaperTexels / (uPaperSize));'), '取样点与像素半宽按纸纹像素算');
  assert.ok(area.fs.includes('uniform vec2 uRes, uPaperSize, uPaperTexels;') && /float paperArea\(vec2 u, vec2 hw\)[\s\S]*void main\(\)\{/.test(area.fs), '面积取样函数在 main 之前');
  assert.match(area.fs, /textureLod\(tPaper, \(b - \.5 \+ a\) \/ uPaperTexels, 0\.\)/, '放大时只取第 0 级（不让 mip 糊进相邻格）');
  assert.deepEqual([u.uPaperTexels.value.x, u.uPaperTexels.value.y, u.uPaperSize.value.x], [1024, 1024, 1365.33]);
  assert.deepEqual([u.uInk.value.toArray(), u.uInkTint.value, u.uInkDark.value], [made[0].uniforms.uInk.value.toArray(), .3, .5], 'ink 为空时沿用上一次的墨色（各变体共用）');
  C.render({ ...base, paper: { ...paper, texels: [512, 256], anchor: { pos: [10, 4], origin: [3, 2], zoom: 2 } } });
  const both = drawn.at(-1);
  assert.ok(both.fs.includes('float pp = paperArea(((gl_FragCoord.xy - uPaperPos) / uPaperZoom + uPaperOrigin) / uPaperSize * uPaperTexels, .5 * uPaperTexels / (uPaperSize * uPaperZoom));'), '锚点的缩放也算进像素半宽');
  assert.deepEqual([both.uniforms.uPaperZoom.value, both.uniforms.uPaperPos.value.toArray(), both.uniforms.uPaperTexels.value.toArray()], [2, [10, 28], [512, 256]], '锚点换成左下原点');
  C.render({ ...base, paper: { ...paper, texels: [1024, 1024] } });
  assert.equal(drawn.at(-1), area, '变体建一次、反复用');
  assert.equal(made.length, 3);
  C.dispose();
  assert.ok(made.every(m => m.disposed), 'dispose 释放默认与全部变体');
});
