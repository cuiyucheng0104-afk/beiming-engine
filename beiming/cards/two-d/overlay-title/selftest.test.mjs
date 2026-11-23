// overlay.title 的自测（不起浏览器）：平面网格顶点、真字体锁定字形覆盖（含大小写英文、数字、中文片名与越界拒收）、文字框位置和大小、入场动效与纯函数摆法。实渲的核对在 cards/m1a-cards.test.mjs。
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

test('overlay.title：交回正对相机的平面网格（4 顶点 2 三角形）和一个根实体', () => {
  const { handle, mesh } = mounted();
  assert.equal(mesh.geometry.attributes.position.count, 4);
  assert.deepEqual(Object.keys(handle), ['object', 'entities', 'apply', 'meta', 'dispose']);
  assert.deepEqual(handle.entities, { plane: { object: mesh, root: true } });
});

test('overlay.title：支持大写、小写英文与中文片名；落定之后文字框高 129.6 像素（画面高的 0.12）、上下左右居中', () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} 应是 ${b}`);
  const widths = {};
  for (const text of ['北冥', 'RTX 5090', 'Hello World']) {
    const m = mounted({ text });
    pose(m, 60);
    const [{ id, text: got, bbox2d: [x0, y0, x1, y1] }] = m.handle.meta(60).texts;
    assert.deepEqual([id, got], ['line', text]);
    close(y1 - y0, 129.6);
    close((y0 + y1) / 2, 540);
    close((x0 + x1) / 2, 960);
    widths[text] = x1 - x0;
    assert.ok(widths[text] > 129.6);
    m.handle.dispose();
  }
  assert.ok(widths['北冥'] < widths['RTX 5090'] && widths['RTX 5090'] < widths['Hello World']);
});

test('overlay.title：平面离相机 distance 米，字高按视场角换成米', () => {
  const m = mounted(), { position, scale } = pose(m, 60);
  assert.deepEqual(position, [0, 0, -1]);
  const worldH = 0.12 * 2 * Math.tan((20 * Math.PI) / 180);
  assert.ok(Math.abs(scale[0] - worldH) < 1e-12 && scale[0] === scale[1] && scale[2] === 1);
  const far = pose(mounted({ distance: 4 }), 60);
  assert.ok(far.position[2] === -4 && Math.abs(far.scale[0] - 4 * worldH) < 1e-12);
});

test('overlay.title：入场前不画也不交文字框；入场支持 rise/settle/fade 三种纯函数动效；落定之后每一帧的摆法相同', () => {
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

  const settleMid = pose(mounted({ motion: 'settle' }), 24);
  assert.ok(settleMid.visible && settleMid.opacity === 0.875 && settleMid.scale[0] < settled.scale[0] && settleMid.position[1] < 0);
  assert.deepEqual(pose(mounted({ motion: 'settle' }), 36), settled);

  const fadeMid = pose(mounted({ motion: 'fade' }), 24);
  assert.ok(fadeMid.visible && fadeMid.opacity === 0.875 && fadeMid.position[1] === 0);
  assert.deepEqual(pose(mounted({ motion: 'fade' }), 36), settled);
});

test('overlay.title：摆法只由时刻定：先摆别的帧再回来，结果相同', () => {
  const m = mounted(), first = pose(m, 20, 0.25);
  pose(m, 90);
  pose(m, 3);
  assert.deepEqual(pose(m, 20, 0.25), first);
});

test('overlay.title：锁定字体覆盖外的生僻字或表情报错；空白或未知动效报错；没挂在透视相机下面报错', () => {
  assert.throws(() => mounted({ text: '北冥𪚥' }), /字形表/);
  assert.throws(() => mounted({ text: 'RTX 🚀' }), /字形表/);
  assert.throws(() => mounted({ text: '  ' }), /亮点|墨迹/);
  assert.throws(() => mounted({ motion: 'spin' }), /动效/);
  const loose = create({ THREE, size: SIZE }, params);
  assert.throws(() => loose.apply(0, 0), /透视相机/);
});
