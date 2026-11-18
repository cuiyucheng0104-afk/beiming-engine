import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScenes, checkScene, checkUnits, checkExpected, unitOf, project, raycast, axisAngle } from './check.mjs';

const clone = x => JSON.parse(JSON.stringify(x));
const scenes = loadScenes();
const get = name => clone(scenes.find(s => s.name === name).scene);

test('六个场景都在，全部通过', () => {
  assert.deepEqual(scenes.map(s => s.name), ['probe-axes-turntable', 'probe-gray-chart', 'probe-moving-cube', 'probe-occlusion', 'probe-plane-steps', 'probe-thin-geometry']);
  for (const { name, scene } of scenes) assert.deepEqual(checkScene(scene, name), [], name);
});

test('平面距离改 10%，深度答案对不上', () => {
  const s = get('probe-plane-steps');
  s.objects[2].positionM[2] *= 1.1;
  assert.ok(checkScene(s, 'probe-plane-steps').some(p => p.includes('planeDepthM')));
});

test('删掉一个单位后缀，单位检查能查出来', () => {
  const s = get('probe-thin-geometry');
  s.objects[0].radius = s.objects[0].radiusM; delete s.objects[0].radiusM;
  const units = checkUnits(s);
  assert.equal(units.length, 1);
  assert.match(units[0], /radius/);
});

test('单位后缀与整数', () => {
  assert.equal(unitOf('velocityMPerFrame'), 'MPerFrame');
  assert.equal(unitOf('yFovDeg'), 'Deg');
  assert.equal(unitOf('radius'), null);
  assert.equal(unitOf('M'), null);
  assert.equal(checkUnits({ atFrame: 1.5 }).length, 1);
  assert.equal(checkUnits({ camera: { widthPx: 640.5 } }).length, 1);
  assert.equal(checkUnits({ pixelPx: [1.5, 2.5] }).length, 0);
});

test('投影与射线：光轴上的点落在画面中心，深度和距离相同', () => {
  const c = { positionM: [0, 0, 0], lookAtM: [0, 0, -1], upDir: [0, 1, 0], yFovDeg: 90, widthPx: 200, heightPx: 100 };
  assert.deepEqual(project(c, [0, 0, -3]), [100, 50]);
  const q = project(c, [3, 3, -3]); assert.ok(Math.abs(q[0] - 150) < 1e-9 && Math.abs(q[1]) < 1e-9); // tan(45°)=1：f = 50 像素
  const scene = { camera: c, objects: [{ id: 'p', shape: 'plane', sizeM: [10, 10], positionM: [0, 0, -2] }] };
  const [h] = raycast(scene, [150, 50], 0);
  assert.equal(h.planeDepthM, 2);
  assert.ok(Math.abs(h.rayDistanceM - 2 * Math.SQRT2) < 1e-12);
});

test('旋转是右手系：绕 +Y 转 90 度把 +X 转到 −Z', () => {
  const m = axisAngle([0, 1, 0], Math.PI / 2);
  const v = m.map(r => r[0]);
  assert.ok(Math.abs(v[0]) < 1e-12 && Math.abs(v[1]) < 1e-12 && Math.abs(v[2] + 1) < 1e-12);
});

test('未知字段和缺字段都算格式问题', () => {
  const s = get('probe-occlusion');
  s.extra = 1; delete s.camera.nearM;
  const p = checkScene(s, 'probe-occlusion');
  assert.ok(p.some(x => x.includes('未知字段 extra')));
  assert.ok(p.some(x => x.includes('缺必填字段 nearM')));
});

const hitsOf = s => s.expected.filter(e => e.kind === 'pixelHits').map(e => e.intendedHitIds.join(','));
const problems = (name, fn) => { const s = get(name); fn(s); return checkScene(s, name); };

test('求交意图：遮挡场景恰好覆盖五种情形，灰阶场景至少一条背景', () => {
  assert.deepEqual(hitsOf(get('probe-occlusion')).sort(), ['', 'cube-far', 'cube-mid,cube-far', 'cube-near', 'cube-near,cube-mid,cube-far']);
  assert.ok(hitsOf(get('probe-gray-chart')).includes(''));
});

test('求交意图：像素实际打到的和意图不一致要报（旧的背景像素、旧的中远像素）', () => {
  const a = problems('probe-gray-chart', s => { const e = s.expected[31]; e.pixelPx = [320.5, 90.5]; e.hits = [{ objectId: 'ldr-05', planeDepthM: 2, rayDistanceM: 2.032489 }]; });
  assert.ok(a.some(p => p.includes('意图是 [背景]')), a.join('\n'));
  const b = problems('probe-occlusion', s => { const e = s.expected[4]; e.pixelPx = [339.5, 180.5]; e.hits = [e.hits[0]]; });
  assert.ok(b.some(p => p.includes('意图是 [cube-mid、cube-far]')), b.join('\n'));
});

test('退化相机和非有限数都要报', () => {
  const cases = [
    ['probe-axes-turntable', s => { s.camera.upDir = [-3, -2, -4]; }, /平行/],
    ['probe-moving-cube', s => { s.camera.positionM = [0, 5, -5]; s.camera.lookAtM = [0, 0, -5]; }, /平行/],
    ['probe-axes-turntable', s => { s.camera.yFovDeg = 0; }, /yFovDeg/],
    ['probe-occlusion', s => { s.camera.yFovDeg = 180; }, /yFovDeg/],
    ['probe-occlusion', s => { s.camera.lookAtM = [0, 0, 0]; }, /重合/],
  ];
  for (const [name, fn, re] of cases) assert.ok(problems(name, fn).some(p => re.test(p)), name);
  const s = get('probe-moving-cube'); s.expected[0].pixelPx[0] = NaN;
  assert.ok(checkExpected(s).some(p => p.includes('不是有限数')));
});

test('带单位后缀的字段写成字符串、布尔、null 都报', () => {
  assert.ok(problems('probe-plane-steps', s => { s.camera.nearM = '10cm'; }).some(p => p.includes('nearM')));
  assert.ok(problems('probe-thin-geometry', s => { s.objects[0].radiusM = '0.002'; }).some(p => p.includes('radiusM')));
  assert.ok(problems('probe-thin-geometry', s => { s.camera.yFovDeg = '40'; }).some(p => p.includes('yFovDeg')));
  assert.equal(checkUnits({ tolerancePx: true }).length, 1);
  assert.equal(checkUnits({ emissionLinear: [null, 0, 0] }).length, 1);
});

test('快门中点和色块中心由规格算：改快门角、挪色块都报', () => {
  assert.ok(problems('probe-moving-cube', s => { s.camera.shutterAngleDeg = 360; }).some(p => p.includes('expected[3].subFrameRatio')));
  assert.ok(problems('probe-gray-chart', s => { s.objects[1].positionM[0] += 0.03; }).some(p => p.includes('expected[1].pixelPx[0]')));
});

test('容差、裁剪面、像素坐标个数', () => {
  assert.ok(problems('probe-plane-steps', s => { s.expected[0].toleranceRatio = -1; }).some(p => p.includes('toleranceRatio')));
  assert.ok(problems('probe-thin-geometry', s => { s.expected[0].tolerancePx = 1e9; }).some(p => p.includes('tolerancePx')));
  assert.ok(problems('probe-plane-steps', s => { s.camera.farM = 3; }).some(p => p.includes('plane-5m') && p.includes('裁剪面')));
  assert.ok(problems('probe-plane-steps', s => { s.objects[0].positionM[2] = -0.05; }).some(p => p.includes('plane-1m') && p.includes('裁剪面')));
  assert.ok(problems('probe-plane-steps', s => { s.expected[1].pixelPx = [122.5, 150.5, 1]; }).some(p => p.includes('恰好是 2 个数')));
});

test('转台竖杆：静态旋转和运动旋转反过来乘，投影至少差 5 像素', () => {
  const s = get('probe-axes-turntable'), o = s.objects.find(x => x.id === 'turntable-arm');
  assert.ok(o.rotation);
  const mv = (m, v) => m.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  const ans = s.expected.filter(e => e.objectId === 'turntable-arm');
  assert.equal(ans.length, 2);
  for (const e of ans) {
    const rs = axisAngle(o.rotation.axisDir, o.rotation.angleRad), rm = axisAngle(o.motion.axisDir, o.motion.angularVelocityRadPerFrame * e.atFrame);
    const T = mv(rm, o.positionM), wrong = project(s.camera, mv(rs, mv(rm, e.localPointM)).map((x, i) => x + T[i]));
    assert.ok(Math.hypot(wrong[0] - e.pixelPx[0], wrong[1] - e.pixelPx[1]) >= 5, `第 ${e.atFrame} 帧`);
  }
});

test('startFrame 不是 0 要报', () => {
  assert.ok(problems('probe-plane-steps', s => { s.frameRange = { startFrame: 5, endFrame: 5 }; s.expected.forEach(e => { e.atFrame = 5; }); }).some(p => p.includes('startFrame')));
});

test('不在单位表里的后缀不猜', () => {
  assert.equal(unitOf('fooPerFrame'), null);
  assert.equal(unitOf('fooPerM'), null);
  assert.equal(checkUnits({ fooPerFrame: 1 }).length, 1);
});
