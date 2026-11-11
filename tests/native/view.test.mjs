// B 路线视图数学（engine/native/view.js）：镜头分段、投影 / 反投影、卡片四角与旋转、按屏幕框摆卡片、天空跟镜头、载具朝向。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../../engine/native/view.js';

const SIZE = [1920, 1080];
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('shotAt：分段、段内进度、缓动与越界', () => {
  const shots = [{ until: 1, eye: [[0, 0, 10], [0, 0, 8]], at: [0, 0, 0], fov: 40 }, { until: 3, eye: [5, 0, 10], at: [0, 0, 0], fov: [40, 30], ease: 'ss' }];
  assert.equal(V.shotAt(0.5, shots).index, 0);
  assert.deepEqual(V.shotAt(0.5, shots).eye, [0, 0, 9]);
  const s = V.shotAt(2, shots);
  assert.equal(s.index, 1);
  assert.ok(near(s.u, 0.5));
  assert.ok(near(s.fov, 35));
  assert.equal(V.shotAt(9, shots).index, 1);
  assert.throws(() => V.shotAt(0, [{ until: 1, eye: [0, 0, 1], at: [0, 0, 0], fov: 40, ease: 'bogus' }]));
});

test('投影：视线中心落在画面中心；竖直视场；相机背后 depth ≤ 0', () => {
  const cam = { eye: [0, 0, 10], at: [0, 0, 0], fov: 60 };
  const c = V.project([0, 0, 0], cam, SIZE);
  assert.ok(near(c.x, 960) && near(c.y, 540) && near(c.depth, 10));
  const top = V.project([0, 10 * Math.tan(Math.PI / 6), 0], cam, SIZE);   // 半竖直视场 30°
  assert.ok(near(top.y, 0, 1e-6));
  assert.ok(V.project([0, 0, 20], cam, SIZE).depth < 0);
});

test('unproject 是 project 的逆', () => {
  const cam = { eye: [3, 4, 20], at: [-1, 2, 0], fov: 38 };
  for (const [x, y, d] of [[100, 200, 5], [1800, 1000, 40], [960, 540, 12]]) {
    const p = V.project(V.unproject(x, y, d, cam, SIZE), cam, SIZE);
    assert.ok(near(p.x, x, 1e-6) && near(p.y, y, 1e-6) && near(p.depth, d, 1e-9));
  }
});

test('卡片：默认朝 +Z；旋转按 XYZ 欧拉；faceYaw 让正面朝向机位', () => {
  const r = V.cardRect({ position: [0, 0, 0], width: 4, aspect: 2 });
  assert.deepEqual(r, [[-2, -1, 0], [2, -1, 0], [2, 1, 0], [-2, 1, 0]]);
  const yaw = V.faceYaw([0, 0, 0], [10, 0, 0]);
  assert.ok(near(yaw, Math.PI / 2));
  const q = V.cardRect({ position: [0, 0, 0], width: 4, aspect: 2, rotation: [0, yaw, 0] });
  for (const p of q) assert.ok(near(p[0], 0, 1e-9), '转 90° 后卡片落在 x = 0 的平面里');
  const ax = V.cardAxes([0.3, -0.7, 0.2]);
  const dot = ax.x[0] * ax.y[0] + ax.x[1] * ax.y[1] + ax.x[2] * ax.y[2];
  assert.ok(near(dot, 0, 1e-12) && near(Math.hypot(...ax.x), 1) && near(Math.hypot(...ax.y), 1), '局部轴正交归一');
});

test('cardInView：水平机位下，卡片的屏幕框与要求的一致（截断边可以放到画外）', () => {
  const cam = { eye: [0, 2, 30], at: [10, 2, 0], fov: 40 };
  const c = V.cardInView({ cam, left: -0.3, cy: 0.6, width: 0.9, depth: 25 }, SIZE);
  const box = V.screenBox(V.cardRect({ ...c, aspect: 1.5 }).map(p => V.project(p, cam, SIZE)));
  assert.ok(near(box[0], -0.3 * 1920, 1e-6) && near(box[2], 0.6 * 1920, 1e-6));
  assert.ok(near((box[1] + box[3]) / 2, 0.6 * 1080, 1e-6));
});

test('edgeVisible：画内、画外、穿过画面三种情况', () => {
  const P = (x, y) => ({ x, y, depth: 1 });
  assert.equal(V.edgeVisible([P(100, 100), P(100, 400)], SIZE), true);
  assert.equal(V.edgeVisible([P(-50, 100), P(-50, 900)], SIZE), false);
  assert.equal(V.edgeVisible([P(-500, 500), P(2500, 500)], SIZE), true);
  assert.equal(V.edgeVisible([{ x: 100, y: 100, depth: -1 }, { x: 200, y: 100, depth: -2 }], SIZE), false);
});

test('skyShift：只平移不转动时为 0；向右摇镜头，天空向左移（像在无穷远）', () => {
  const pan = [{ until: 2, eye: [[0, 0, 10], [5, 0, 10]], at: [[0, 0, 0], [5, 0, 0]], fov: 40 }];
  for (const t of [0, 1, 1.9]) { const [dx, dy] = V.skyShift(t, pan, SIZE); assert.ok(near(dx, 0, 1e-6) && near(dy, 0, 1e-6)); }
  const turn = [{ until: 2, eye: [0, 0, 10], at: [[0, 0, 0], [3, 0, 0]], fov: 40 }];
  const [dx] = V.skyShift(1.99, turn, SIZE);
  const f = 540 / Math.tan(Math.PI * 20 / 180), yaw = Math.atan(3 * 0.995 / 10);
  assert.ok(dx < 0 && near(dx, -f * Math.tan(yaw), 2), `dx = ${dx}`);
  // 切到下一段归零
  const two = [...turn, { until: 4, eye: [0, 0, 10], at: [0, 0, 0], fov: 40 }];
  assert.deepEqual(V.skyShift(2, two, SIZE).map(v => Math.round(v)), [0, 0]);
});

test('headingYaw / behind：前向 +X 的模型朝速度方向，尾迹在船尾后（审查 R04）', () => {
  const v = [0.5, 0, -0.65], yaw = V.headingYaw(v);
  const fwd = V.cardAxes([0, yaw, 0]).x;            // 模型局部 +X 转到世界
  const n = Math.hypot(v[0], v[2]);
  assert.ok(near(fwd[0], v[0] / n) && near(fwd[2], v[2] / n), '船头与速度同向');
  const p = [1, 0, 2], w = V.behind(p, yaw, 4, -0.3);
  const d = [w[0] - p[0], w[2] - p[2]];
  assert.ok(near((d[0] * v[0] + d[1] * v[2]) / n, -4), '尾迹在船尾正后方 4 米');
  assert.ok(near(w[1], -0.3));
});
