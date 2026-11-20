// post.hdr-chain 的自测（不起浏览器）：交回的通道长什么样、打开还没有的功能要报错。「加了这条链颜色层逐位不变」的实渲核对在 cards/m1a-cards.test.mjs。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three-webgpu';
import { create } from './three.js';

test('post.hdr-chain：交回一张全屏通道网格，材质带 tInput，不混合、不测深度；片元着色器只按像素坐标取一次输入', () => {
  const handle = create({ THREE }, { ao: false, bloom: false }), { material } = handle.object;
  assert.deepEqual(Object.keys(handle), ['object', 'dispose']);
  assert.ok(handle.object.isMesh && Object.hasOwn(material.uniforms, 'tInput'));
  assert.deepEqual([material.blending, material.depthTest, material.depthWrite], [THREE.NoBlending, false, false]);
  assert.equal(material.fragmentShader.match(/texelFetch\(tInput, ivec2\(gl_FragCoord\.xy\), 0\)/g).length, 1);
  assert.ok(!/texture\(|texture2D\(/.test(material.fragmentShader));
  handle.dispose();
});

test('post.hdr-chain：环境光遮蔽和泛光这一版没有，打开就报错', () => {
  assert.throws(() => create({ THREE }, { ao: true, bloom: false }), /ao/);
  assert.throws(() => create({ THREE }, { ao: false, bloom: true }), /bloom/);
});
