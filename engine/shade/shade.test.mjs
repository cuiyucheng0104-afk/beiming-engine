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
  const keep = THREE.ShaderChunk.shadowmap_pars_fragment, MOVED = /fx22：投影量化锚点缺失（three r170）：投影块 shadowmap_pars_fragment 不是对拍过的原文/;
  try {
    THREE.ShaderChunk.shadowmap_pars_fragment = keep.replaceAll('return mix( 1.0, shadow, shadowIntensity );', 'return mix(1.0, shadow, shadowIntensity);');
    assert.throws(() => quantizeShadow(lib.fragmentShader, 'a', 'b', who), MOVED);
    // 同一句返回在块里不止一处（r170：getShadow 与 getPointShadow）：只坏其中一处也报，不能靠另一处还在就放行、漏打这一处
    const RET = 'return mix( 1.0, shadow, shadowIntensity );', at = [keep.indexOf(RET), keep.lastIndexOf(RET)];
    assert.ok(at[0] >= 0 && at[1] > at[0], 'r170 的投影块里这句返回有两处');
    for (const [i, alt] of [[at[0], 'return mix(1.0, shadow, shadowIntensity);'], [at[1], 'return mix(1.0, shadow, shadowIntensity);'], [at[0], 'return shadow;'], [at[1], 'return 1.0 - shadowIntensity * ( 1.0 - shadow );']]) {
      THREE.ShaderChunk.shadowmap_pars_fragment = keep.slice(0, i) + alt + keep.slice(i + RET.length);
      assert.throws(() => quantizeShadow(lib.fragmentShader, 'a', 'b', who), MOVED, `第 ${i} 字节处的返回改成「${alt}」`);
    }
    // 函数按函数头认（float getShadow( / float getPointShadow(），不看形参叫什么：形参连同它的返回一起改名，GLSL 语义不变，这一处却不是原文了
    for (const head of ['float getShadow(', 'float getPointShadow(']) {
      const i = keep.indexOf(head), j = keep.indexOf(RET, i);
      assert.ok(i >= 0 && j > i && keep.slice(i, j).includes('float shadowIntensity'), `r170 的投影块里有 ${head}`);
      THREE.ShaderChunk.shadowmap_pars_fragment = keep.slice(0, i) + keep.slice(i, j).replace('float shadowIntensity', 'float shadowStrength') + 'return mix( 1.0, shadow, shadowStrength );' + keep.slice(j + RET.length);
      assert.throws(() => quantizeShadow(lib.fragmentShader, 'a', 'b', who), MOVED, `${head} 的形参改名成 shadowStrength`);
    }
    // 函数体里多出一句别的写法的 return（原来那句还在）：那条路出去的投影没有量化，也报
    THREE.ShaderChunk.shadowmap_pars_fragment = keep.slice(0, at[0]) + 'if ( shadowRadius < 0.0 ) return shadow;\n\t\t' + keep.slice(at[0]);
    assert.throws(() => quantizeShadow(lib.fragmentShader, 'a', 'b', who), MOVED, 'getShadow 里多了一句提前返回');
    // 只多一段注释（语义没变）也不是对拍过的原文了：报错，不去猜改过的文本里哪些返回还算数
    THREE.ShaderChunk.shadowmap_pars_fragment = keep.slice(0, at[0]) + '// Early return if fully lit\n\t\t/* return shadow; */ ' + keep.slice(at[0]);
    assert.throws(() => quantizeShadow(lib.fragmentShader, 'a', 'b', who), MOVED, '投影块里多了一段注释');
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

test('FX22 投影量化只认对拍过的投影块原文（three r170 / r187 发行包里的）：这段文本怎么改都报错，不交出漏换了返回的着色器', async t => {
  const frag = THREE.ShaderLib.toon.fragmentShader, keep = THREE.ShaderChunk.shadowmap_pars_fragment, RET = 'return mix( 1.0, shadow, shadowIntensity );';
  // r187 的投影块（可选依赖 three-webgpu = three@0.187.0）：quantizeShadow 按块的原文认，不看 THREE.REVISION，换进来就走 r187 那一路
  const r187 = await import('three-webgpu').then(m => m.ShaderChunk.shadowmap_pars_fragment, () => null);
  if (!r187) t.diagnostic('没装 three-webgpu：只核 r170 的投影块');
  const out = chunk => { THREE.ShaderChunk.shadowmap_pars_fragment = chunk; return quantizeShadow(frag, 'a', 'b', 'fx22'); };
  const first = (c, from, to) => { assert.ok(c.includes(from), `投影块里有「${from}」`); return c.replace(from, () => to); };
  // 都是合法 GLSL。前两种语义没变；后面几种是按文本数函数体 / 数返回的核法放行过的：头一个 getShadow 的返回没量化，照常出图
  const REWRITES = {
    '头一处返回里夹一段块注释': c => first(c, RET, 'return mix( 1.0, shadow, /* mix weight */shadowIntensity );'),
    '末尾多一个换行': c => c + '\n',
    '注释顶替空格：float/**/getShadow 与 return/**/mix': c => first(first(c, 'float getShadow(', 'float/**/getShadow('), RET, 'return/**/mix( 1.0, shadow, shadowIntensity );'),
    '注释顶替空格的函数头 + 形参连同返回改名': c => first(first(first(c, 'float getShadow(', 'float/**/getShadow('), 'float shadowIntensity', 'float shadowStrength'), RET, 'return mix( 1.0, shadow, shadowStrength );'),
    '宏给函数起别名 + 形参连同返回改名': c => first(first(first(c, 'float getShadow(', '#define BM_FN getShadow\n\tfloat BM_FN('), 'float shadowIntensity', 'float shadowStrength'), RET, 'return mix( 1.0, shadow, shadowStrength );'),
    '预处理死分支里留原句并多一个 }，真正的返回走别名': c => first(c, RET, `#if 0\n\t\t${RET} }\n\t\t#endif\n\t\tfloat k = shadowIntensity; return mix( 1.0, shadow, k );`),
    '宏把 return 藏起来，死分支里留原句': c => first(c, RET, `#if 0\n\t\t${RET}\n\t\t#endif\n\t\t#define BM_RET return\n\t\tBM_RET mix( 1.0, shadow, shadowIntensity );`),
  };
  try {
    for (const [rev, chunk, n] of [['170', keep, 2], ['187', r187, 5]]) {
      if (!chunk) continue;
      const stock = out(chunk);
      assert.deepEqual([chunk.split(RET).length - 1, stock.split('return mix( 1.0, smoothstep( a, b, shadow ), shadowIntensity );').length - 1, stock.includes(RET)], [n, n, false], `r${rev} 的投影块原样：${n} 处返回全换掉`);
      for (const [what, rewrite] of Object.entries(REWRITES))
        assert.throws(() => out(rewrite(chunk)), /fx22：投影量化锚点缺失（three r170）：投影块 shadowmap_pars_fragment 不是对拍过的原文（three r170 \/ r187 发行包里的；现在这段是 \d+:\w+\.\w+）/, `r${rev}：${what}`);
    }
  } finally { THREE.ShaderChunk.shadowmap_pars_fragment = keep; }
});

test('FX22 锚点只认生效代码里的：写在注释里的不算数，生效的不止一处也报错（材质参数里的一段注释不能把补丁引进注释里）', () => {
  const frag = THREE.ShaderLib.toon.fragmentShader, INC = '#include <shadowmap_pars_fragment>', who = 'fx22';
  const pars = c => frag.replace('#include <common>', () => '#include <common>\n' + c), clean = quantizeShadow(frag, 'a', 'b', who);
  assert.ok(frag.indexOf('#include <common>') < frag.indexOf(INC), '材质参数（fragmentPars）插在投影块的 #include 前面');
  // 注释里先提到这条 #include（块注释、行注释、跨行块注释里顶着行首写、注释记号互相嵌着）：补丁照样落在生效的那一条上，注释原样留着
  for (const c of [`/* ${INC} */`, `// ${INC}`, `/*\n${INC}\n*/`, `// 行注释里的 /* 不开块注释\n/* 块注释里的 // 不开行注释 */ // ${INC}`]) {
    const out = quantizeShadow(pars(c), 'a', 'b', who);
    assert.equal(out, clean.replace('#include <common>', () => '#include <common>\n' + c), `材质参数里写了「${c}」`);
    assert.equal(out.split('smoothstep( a, b, shadow )').length, clean.split('smoothstep( a, b, shadow )').length, '量化的返回一处不少');
  }
  // 生效的指令被注释掉、或者不在行首（three 只展开行首的 #include）：没有可打的地方，报缺失
  for (const [what, to] of [['行注释掉', '// ' + INC], ['块注释掉', `/* ${INC} */`], ['不在行首', 'float bmX; ' + INC]])
    assert.throws(() => quantizeShadow(frag.replace(INC, () => to), 'a', 'b', who), /fx22：着色器锚点缺失「#include <shadowmap_pars_fragment>」/, what);
  // 条件取决于编译宏时，仍可能有两处生效。three 也会展开 include 后有多个空格的指令。
  const n = inject.patchErrors().length;
  for (const c of [`#if USE_SHADOWMAP\n${INC}\n#endif`, `#ifdef USE_SHADOWMAP\n\t#include  <shadowmap_pars_fragment>\n#endif`, INC])
    assert.throws(() => quantizeShadow(pars(c), 'a', 'b', who), /^ShaderPatchError: \[BEIMING_SHADER_PATCH_ERROR\] fx22：着色器锚点不唯一「#include <shadowmap_pars_fragment>」：生效代码里有 2 处/, c);
  assert.deepEqual([inject.patchErrors().length - n, inject.patchErrors().at(-1).fn, inject.patchErrors().at(-1).anchor], [3, 'inject', INC], '照样记进补丁错误记录');
  // 不是 #include 的锚点、三种插法、顶点钩子，同一条规矩
  const src = '// void main() {\n/* void main() { */\nvoid main() {\n}';
  assert.deepEqual(['after', 'before', 'replace'].map(mode => inject(src, 'void main() {', 'X', mode, who)),
    ['// void main() {\n/* void main() { */\nvoid main() {\nX\n}', '// void main() {\n/* void main() { */\nX\nvoid main() {\n}', '// void main() {\n/* void main() { */\nX\n}']);
  assert.throws(() => inject('void main() {\n}\n#ifndef SKIP_MAIN\nvoid main() {\n}\n#endif', 'void main() {', 'X', 'after', who), /fx22：着色器锚点不唯一「void main\(\) \{」：生效代码里有 2 处/);
  const v = THREE.ShaderLib.toon.vertexShader, note = '// 形变写在 #include <begin_vertex> 后面\n/* void main() { */\n';
  assert.equal(patchVertex(v, { vertexPars: note, vertexBegin: 'transformed.x += 1.0;\n' }, {}, who), patchVertex(v, { vertexBegin: 'transformed.x += 1.0;\n' }, {}, who).replace('#include <common>\n', () => '#include <common>\n' + note));
});

test('FX22 原始着色器的常量死分支里有唯一投影锚点时抛错，仍可给生效分支打补丁', () => {
  const inc = '#include <shadowmap_pars_fragment>', chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  const frag = `#if 0\n${inc}\n#else\n${chunk}\n#endif`;
  const count = inject.patchErrors().length;
  assert.throws(() => quantizeShadow(frag, 'a', 'b', 'fx22'), /fx22：着色器锚点缺失「#include <shadowmap_pars_fragment>」/);
  assert.deepEqual(inject.patchErrors().slice(count).map(r => [r.fn, r.anchor]), [['inject', inc]]);
  for (const [before, after] of [
    [`#if 00 // 常量假\n${inc}\n#elif 0u\n${inc}\n#else\n`, '\n#endif'],
    ['#if 1\n', `\n#elif USE_MAP\n${inc}\n#else\n${inc}\n#endif`],
    [`#if USE_MAP\n#elif 1\n#else\n${inc}\n#endif\n`, ''],
    [`#if /* 条件 */ \\\r\n0\n#ifdef USE_MAP\n#else\n${inc}\n#endif\n#else\n`, '\n#endif'],
    [`// #if 0\n/*\n#if 0\n*/\n`, ''],
  ]) assert.equal(inject(before + inc + after, inc, 'X', 'replace'), before + 'X' + after);
});

test('FX22 跨行块注释保留逻辑行，three 展开循环内的锚点不能用于补丁', () => {
  const inc = '#include <shadowmap_pars_fragment>', put = src => inject(src, inc, 'X', 'replace');
  const loop = `#pragma unroll_loop_start\nfor ( int i = 0; i < 0; i ++ ) {\n${inc}\n}\n#pragma unroll_loop_end`;
  const splitComment = `/*\n${loop.replace(inc, `*/\n${inc}\n/*`)}\n*/`;
  for (const disabled of [`#if 1 /*\n*/ && 0\n${inc}\n#endif`, `#if 0\nfloat bmX; /*\r\n*/ #endif\n${inc}\n#endif`, loop, splitComment]) {
    assert.throws(() => put(disabled), { name: 'ShaderPatchError' }, disabled);
    assert.equal(put(`${disabled}\n${inc}`), `${disabled}\nX`);
  }
  assert.throws(() => put(`#pragma unroll_loop_start\n${inc}`), { name: 'ShaderPatchError' });
  const note = '// three 使用 #pragma unroll_loop_start 展开循环\n';
  assert.equal(put(note + inc), note + 'X');
  const enabled = '#if 0 /*\n*/ || 1\n';
  assert.equal(put(`${enabled}${inc}\n#endif`), `${enabled}X\n#endif`);
});

test('FX22 条件指令续行上的 include 不能作为锚点', () => {
  const inc = '#include <shadowmap_pars_fragment>';
  for (const newline of ['\n', '\r\n']) {
    const hidden = ['#if 1', '#else', '#if 0 \\', inc, '#endif', '#endif'].join(newline);
    assert.throws(() => inject(hidden, inc, 'X', 'replace'), /着色器锚点缺失「#include <shadowmap_pars_fragment>」/);
    assert.equal(inject(`${hidden}\n${inc}`, inc, 'X', 'replace'), `${hidden}\nX`);
  }
});

test('FX22 重叠循环头各自起配，零次循环吞掉的唯一锚点报缺失', () => {
  const inc = '#include <shadowmap_pars_fragment>';
  const hidden = `#if 0
#pragma unroll_loop_start
for ( int i = a; i < b; i ++ ) {
#endif
#pragma unroll_loop_start
for ( int i = 0; i < 0; i ++ ) {}
#pragma unroll_loop_end
${inc}
}
#pragma unroll_loop_end`;
  assert.throws(() => inject(hidden, inc, 'X', 'replace'), /着色器锚点缺失「#include <shadowmap_pars_fragment>」/);
  assert.equal(inject(`${hidden}\n${inc}`, inc, 'X', 'replace'), `${hidden}\nX`);
});

test('FX22 唯一命中也要证明分支生效：常量表达式、未知宏及其后续分支', () => {
  const inc = '#include <common>', put = src => inject(src, inc, 'X', 'replace');
  for (const condition of ['(0)', '0 || 0', '0x0', '!(1 && (0 || 1))']) {
    const disabled = `#if ${condition}\n${inc}\n#endif`;
    assert.throws(() => put(disabled), /着色器锚点缺失/, condition);
    assert.equal(put(`${disabled}\n${inc}`), `${disabled}\nX`, condition);
  }
  for (const guard of ['#ifdef FLAG', '#ifndef FLAG', '#if FLAG\n#else', '#if FLAG\n#elif 1', '#if (2 + 3) == 5']) {
    assert.throws(() => put(`${guard}\n${inc}\n#endif`), /无法确认.*生效/, guard);
  }
  assert.equal(put(`#if 0x1 && (!0 || 0)\n${inc}\n#endif`), '#if 0x1 && (!0 || 0)\nX\n#endif');
});

test('FX22 true / false 不是 GLSL 预处理常量：未知宏分支拒绝，Kleene 可确定短路放行', () => {
  const inc = '#include <common>', put = src => inject(src, inc, 'X', 'replace', 'fx22-n5');
  const before = inject.patchErrors().length;
  const uncertain = [
    `#define true 0\n#if true\n${inc}\n#endif`,
    `#define false 1\n#if false\nfloat x;\n#else\n${inc}\n#endif`,
    `#if true\n${inc}\n#endif`,
    `#if false\n${inc}\n#endif`,
    `#if !false\n${inc}\n#endif`,
    `#if 0 || true\n${inc}\n#endif`,
    `#if 1 && true\n${inc}\n#endif`,
    `#define true 1 || 1\n#if 0 && true\nfloat x;\n#else\n${inc}\n#endif`,
    `#define true 1 || 1\n#if true && 0\nfloat x;\n#else\n${inc}\n#endif`,
    `#define false 1) && 0 && (0\n#if (1 || false)\n${inc}\n#endif`,
    `#if defined(FLAG)\n${inc}\n#endif`,
    `#if 0 || defined(FLAG)\n${inc}\n#endif`,
    `#if 1 || defined()\n${inc}\n#endif`,
    `#if 1 || +\n${inc}\n#endif`,
    `#if 1 || (1 + 2)\n${inc}\n#endif`,
  ];
  for (const src of uncertain) {
    assert.throws(() => put(src), { name: 'ShaderPatchError', message: /fx22-n5：无法确认着色器锚点「#include <common>」所在的条件分支生效/ }, src);
  }
  const dead = [`#if 0 && true\n${inc}\n#endif`, `#if true && 0\n${inc}\n#endif`, `#if 0 && defined(FLAG)\n${inc}\n#endif`];
  for (const src of dead) {
    assert.throws(() => put(src), { name: 'ShaderPatchError', message: /fx22-n5：着色器锚点缺失「#include <common>」/ }, src);
  }
  for (const src of [`#define true 0\n#if true\n${inc}\n#endif\n${inc}`, `#define false 1\n#if false\n${inc}\n#endif\n${inc}`]) {
    assert.throws(() => put(src), { name: 'ShaderPatchError', message: /fx22-n5：着色器锚点不唯一「#include <common>」：生效代码里有 2 处/ }, src);
  }
  for (const [src, want] of [
    [`#if 1 || false\n${inc}\n#endif`, `#if 1 || false\nX\n#endif`],
    [`#if false || 1\n${inc}\n#endif`, `#if false || 1\nX\n#endif`],
    [`#define false 0\n#if false || 1\n${inc}\n#endif`, `#define false 0\n#if false || 1\nX\n#endif`],
    [`#define false (0)\n#if false || 1\n${inc}\n#endif`, `#define false (0)\n#if false || 1\nX\n#endif`],
    [`#if 1 || defined(FLAG)\n${inc}\n#endif`, `#if 1 || defined(FLAG)\nX\n#endif`],
    [`#if defined FLAG || 1\n${inc}\n#endif`, `#if defined FLAG || 1\nX\n#endif`],
    [`#if 1 || false\n${inc}\n#else\n${inc}\n#endif`, `#if 1 || false\nX\n#else\n${inc}\n#endif`],
    [`#if 0 && true\nfloat x;\n#else\n${inc}\n#endif`, `#if 0 && true\nfloat x;\n#else\nX\n#endif`],
    [`#if true && 0\nfloat x;\n#else\n${inc}\n#endif`, `#if true && 0\nfloat x;\n#else\nX\n#endif`],
    [`#if 0 && defined(FLAG)\nfloat x;\n#else\n${inc}\n#endif`, `#if 0 && defined(FLAG)\nfloat x;\n#else\nX\n#endif`],
    [`#if 0 && true\n${inc}\n#else\n${inc}\n#endif`, `#if 0 && true\n${inc}\n#else\nX\n#endif`],
    [`#if !(0 && true)\n${inc}\n#endif`, `#if !(0 && true)\nX\n#endif`],
    [`#if 1\n${inc}\n#elif false\n${inc}\n#endif`, `#if 1\nX\n#elif false\n${inc}\n#endif`],
  ]) {
    assert.equal(put(src), want, src);
  }
  assert.equal(inject.patchErrors().length - before, uncertain.length + dead.length + 2);
});

test('FX22 以前的补丁插进去的文本里不找锚点：材质钩子在死分支里另写一套锚点、再把原来的盖住，补丁不落进死分支；投影块整个没了也报补丁错', () => {
  const frag = THREE.ShaderLib.toon.fragmentShader, INC = '#include <shadowmap_pars_fragment>', who = 'fx22', Q = 'smoothstep( a, b, shadow )';
  const clean = quantizeShadow(frag, 'a', 'b', who), withPars = pars => clean.replace('#include <common>', () => '#include <common>\n' + pars);
  const chain = pars => quantizeShadow(inject(frag, '#include <common>', pars, 'after', who), 'a', 'b', who);   // engine/shade/toon.js 的顺序：先插片元参数，再量化投影
  // 钩子文本里的锚点不算数（死分支里的、直接写的都一样）：补丁落在原来那一条上，钩子文本原样留着
  for (const pars of [`#if 0\n${INC}\n#endif\n`, INC + '\n', `#if 0\n${INC}\n#endif\n/* *\\\n/\n`])
    assert.equal(chain(pars), withPars(pars), JSON.stringify(pars));
  // 「/* *\换行/」是一段合法的注释（GLSL ES 3.00 先接行续接再认注释）：后面原来的锚点还生效，不能当成被注释掉了；
  // 注释记号被行续接拆开的照样是注释：里面的锚点不算
  assert.equal(chain('/* *\\\n/\n').split(Q).length, clean.split(Q).length);
  assert.throws(() => inject(`/\\\n* ${INC}\n*\\\r\n/ float x;`, INC, 'X', 'replace', who), /着色器锚点缺失/);
  assert.equal(inject(`/\\\n/ 行注释接到下一行 \\\n${INC}\n${INC}`, INC, 'X', 'replace', who), `/\\\n/ 行注释接到下一行 \\\n${INC}\nX`);
  // 钩子文本把原来的锚点盖住了（开了一段没收尾的块注释，哪怕它在 three 会整段删掉的 0 次循环里）：报缺失，不拿钩子里的那条顶替
  const n = inject.patchErrors().length;
  for (const hide of ['/*\n', '#pragma unroll_loop_start\nfor ( int i = 0; i < 0; i ++ ) {\n/*\n}\n#pragma unroll_loop_end\n'])
    assert.throws(() => chain(`#if 0\n${INC}\n#endif\n` + hide), /^ShaderPatchError: \[BEIMING_SHADER_PATCH_ERROR\] fx22：着色器锚点缺失「#include <shadowmap_pars_fragment>」/, JSON.stringify(hide));
  assert.equal(inject.patchErrors().length - n, 2);
  // 顶点钩子同一条规矩；同一个锚点后面接着插两次，各自的文本都不当锚点
  const v = THREE.ShaderLib.toon.vertexShader, fake = '#if 0\n#include <begin_vertex>\nvoid main() {\n#include <beginnormal_vertex>\n#endif\n', hooks = { vertexBegin: 'transformed.x += 1.0;\n', vertexNormal: 'objectNormal.y = 0.0;\n' };
  assert.equal(patchVertex(v, { ...hooks, vertexPars: fake }, {}, who), patchVertex(v, hooks, {}, who).replace('#include <common>\n', () => '#include <common>\n' + fake));
  assert.equal(inject(inject('A\nB', 'A', 'A', 'after', who), 'A', 'x', 'after', who), 'A\nx\nA\nB');
  // 投影块整个没了（three 升级拿掉了）、或者被换成会改写 replaceAll 的 String 对象：抛的是 ShaderPatchError、记进补丁错误记录，不是 TypeError
  const keep = THREE.ShaderChunk.shadowmap_pars_fragment;
  try {
    for (const bad of [undefined, null, Object.assign(new String(keep), { replaceAll: () => keep })]) {
      THREE.ShaderChunk.shadowmap_pars_fragment = bad;
      assert.throws(() => quantizeShadow(frag, 'a', 'b', who), /^ShaderPatchError: \[BEIMING_SHADER_PATCH_ERROR\] fx22：投影量化锚点缺失（three r\d+）：投影块 shadowmap_pars_fragment 没了/, String(bad));
    }
    assert.deepEqual(inject.patchErrors().slice(-3).map(e => e.fn), ['quantizeShadow', 'quantizeShadow', 'quantizeShadow']);
  } finally { THREE.ShaderChunk.shadowmap_pars_fragment = keep; }
});
