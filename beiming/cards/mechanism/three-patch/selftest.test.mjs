import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three-webgpu';
import { attachMaterialPatch, create, patchShaderSource } from './index.mjs';

const change = { stage: 'vertexShader', anchor: 'position', mode: 'after', code: '\nscale();' };
const options = { version: '0.187.0', patches: [change] };
const shader = () => ({ vertexShader: 'position', fragmentShader: 'outColor' });

test('纯补丁按顺序对两个阶段作字面插入和替换，保留输入', () => {
  const original = shader();
  const updated = patchShaderSource(original, { ...options, patches: [change,
    { ...change, anchor: 'scale()', mode: 'before', code: 'offset();' },
    { stage: 'fragmentShader', anchor: 'outColor', mode: 'replace', code: '$&' },
  ] });
  assert.deepEqual(updated, { vertexShader: 'position\noffset();scale();', fragmentShader: '$&' });
  assert.deepEqual(original, shader());
});

test('精确校验版本，只有显式允许的版本可装载', () => {
  for (const version of [undefined, '187', '0.187.1', '0.187.0-dev']) {
    assert.throws(() => patchShaderSource(shader(), { ...options, version }), /version/);
  }
  assert.throws(() => create({ THREE: { REVISION: '186' } }), /version/);
  const handle = create({ THREE: { REVISION: '188' } }, { allowedVersions: ['0.188.0'] });
  assert.equal(typeof handle.dispose, 'function'); // 页面宿主的 create 入口约定
  assert.equal(handle.object, undefined); // 机制不是需要挂入场景的 Object3D
  assert.equal(handle.patchShaderSource(shader(), [change]).vertexShader, 'position\nscale();');
});

test('缺少锚点、重叠重名、拼错阶段或操作都抛错', () => {
  for (const fields of [{ anchor: 'absent' }, { anchor: 'aa' }, { anchor: '' }, { stage: 'geometry' }, { mode: 'append' }]) {
    assert.throws(() => patchShaderSource({ ...shader(), vertexShader: 'aaa' }, { ...options, patches: [{ ...change, ...fields }] }));
  }
});

test('材质保留在先的钩子、动态缓存键和 renderer，补丁快照免受调用方修改', () => {
  const material = new THREE.MeshStandardMaterial();
  let observedRenderer;
  material.onBeforeCompile = function (s, renderer) { observedRenderer = renderer; s.vertexShader += this.name; };
  material.customProgramCacheKey = function () { return this.userData.variant; };
  material.name = '!';
  material.userData.variant = 'a';
  const entry = { ...change };
  attachMaterialPatch(material, { ...options, patches: [entry] });
  const first = material.customProgramCacheKey();
  entry.code = 'mutated';
  assert.equal(material.customProgramCacheKey(), first);
  material.userData.variant = 'b';
  assert.notEqual(material.customProgramCacheKey(), first);
  const s = shader(), renderer = {};
  material.onBeforeCompile(s, renderer);
  assert.equal(observedRenderer, renderer);
  assert.equal(s.vertexShader, 'position\nscale();!');
  assert.ok(material.version > 0);
});

test('等价材质共享缓存键，补丁代码、顺序或已有编译钩子改变则区分', () => {
  function key(patches, hook) {
    const m = new THREE.MeshStandardMaterial();
    if (hook) m.onBeforeCompile = hook;
    create({ THREE }).attachMaterialPatch(m, patches);
    return m.customProgramCacheKey();
  }
  const other = { ...change, code: 'other();' };
  assert.equal(key([change]), key([{ ...change }]));
  assert.notEqual(key([change]), key([other]));
  assert.notEqual(key([change, other]), key([other, change]));
  assert.notEqual(key([change]), key([change], () => {}));
});

test('从 r187 的标准材质取真实模板，漫反射变体不改库存着色器', () => {
  const template = THREE.ShaderLib.standard, anchor = '#include <color_fragment>';
  const red = 'diffuseColor.rgb *= vec3(1., 0., 0.);';
  const material = new THREE.MeshStandardMaterial(), program = { ...template };
  create({ THREE }).attachMaterialPatch(material, [{ stage: 'fragmentShader', mode: 'after', anchor, code: `\n${red}` }]);
  material.onBeforeCompile(program);
  assert.ok(program.fragmentShader.includes(`${anchor}\n${red}`));
  assert.ok(!template.fragmentShader.includes(red));
  assert.equal(program.vertexShader, template.vertexShader);
});

test('后一道补丁失败时不会将前一道的半成品交给编译器', () => {
  const m = new THREE.MeshStandardMaterial();
  attachMaterialPatch(m, { ...options, patches: [change, { ...change, stage: 'fragmentShader' }] });
  const s = shader();
  assert.throws(() => m.onBeforeCompile(s, {}), /anchor/);
  assert.deepEqual(s, shader());
});
