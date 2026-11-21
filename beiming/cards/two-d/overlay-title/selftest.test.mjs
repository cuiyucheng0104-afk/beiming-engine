// overlay.title 的自测（不起浏览器）：网格的亮点数、文字框的位置和大小、入场前后和落定之后的摆法。实渲的核对在 cards/m1a-cards.test.mjs。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three-webgpu';
import { create } from './three.js';

const SIZE = [1920, 1080];
const params = { text: 'RTX 5090', enter: 12, settleFrames: 24, ink: '#F4F0E9', heightFrac: 0.12, distance: 1 };

/** 把卡交回的网格挂到一台竖直视场角 40 度的透视相机下面 */
function mounted(over = {}) {
  const camera = new THREE.PerspectiveCamera(40, SIZE[0] / SIZE[1], 0.1, 100);
  const handle = create({ THREE, size: SIZE }, { ...params, ...over });
  camera.add(handle.object);
  return { camera, handle, mesh: handle.object };
}
const pose = ({ handle, mesh }, f, sub = 0) => {
  handle.apply(f, sub);
  return { visible: mesh.visible, position: mesh.position.toArray(), scale: mesh.scale.toArray(), opacity: mesh.material.opacity };
};

test('overlay.title：RTX 5090 这一行有 112 个亮点，每个亮点两个三角形；交一个根实体', () => {
  const { handle, mesh } = mounted();
  assert.equal(mesh.geometry.attributes.position.count, 112 * 6);
  assert.deepEqual(Object.keys(handle), ['object', 'entities', 'apply', 'meta', 'dispose']);
  assert.deepEqual(handle.entities, { plane: { object: mesh, root: true } });
});

test('overlay.title：落定之后文字框高 129.6 像素（画面高的 0.12）、上下左右居中，宽是 47 格', () => {
  const m = mounted();
  pose(m, 60);
  const [{ id, text, bbox2d: [x0, y0, x1, y1] }] = m.handle.meta(60).texts;
  assert.deepEqual([id, text], ['line', 'RTX 5090']);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} 应是 ${b}`);
  close(y1 - y0, 129.6);
  close((y0 + y1) / 2, 540);
  close((x0 + x1) / 2, 960);
  // 8 个字，每个字 5 格宽、字间 1 格：墨迹宽 47 格；一格是 129.6 ÷ 7 像素
  close(x1 - x0, (47 * 129.6) / 7);
});

test('overlay.title：平面离相机 distance 米，一格的边长按视场角换成米', () => {
  const m = mounted(), { position, scale } = pose(m, 60);
  assert.deepEqual(position, [0, 0, -1]);
  const cell = (0.12 * 2 * Math.tan((20 * Math.PI) / 180)) / 7;
  assert.ok(Math.abs(scale[0] - cell) < 1e-12 && scale[0] === scale[1] && scale[2] === 1);
  const far = pose(mounted({ distance: 4 }), 60);
  assert.ok(far.position[2] === -4 && Math.abs(far.scale[0] - 4 * cell) < 1e-12);
});

test('overlay.title：入场前不画也不交文字框；入场当中从下往上升、由淡到实；落定之后每一帧的摆法相同', () => {
  const m = mounted();
  assert.equal(pose(m, 11).visible, false);
  assert.equal(pose(m, 12).visible, false);
  assert.deepEqual(m.handle.meta(12), { texts: [] });
  const mid = pose(m, 24);
  assert.ok(mid.visible && mid.opacity === 0.875 && mid.position[1] < 0);
  assert.ok(m.handle.meta(24).texts[0].bbox2d[1] > m.handle.meta(60).texts[0].bbox2d[1]);
  const settled = pose(m, 36);
  assert.deepEqual([settled.opacity, settled.position[1]], [1, 0]);
  for (const f of [37, 42, 119]) assert.deepEqual(pose(m, f), settled);
  assert.deepEqual(pose(m, 41, 0.75), settled);
});

test('overlay.title：摆法只由时刻定：先摆别的帧再回来，结果相同', () => {
  const m = mounted(), first = pose(m, 20, 0.25);
  pose(m, 90);
  pose(m, 3);
  assert.deepEqual(pose(m, 20, 0.25), first);
});

test('overlay.title：字形表里没有的字报错；没挂在透视相机下面报错', () => {
  assert.throws(() => mounted({ text: 'rtx' }), /字形表/);
  assert.throws(() => mounted({ text: '  ' }), /亮点/);
  const loose = create({ THREE, size: SIZE }, params);
  assert.throws(() => loose.apply(0, 0), /透视相机/);
});
