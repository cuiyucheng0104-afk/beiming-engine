// engine/stage/telemetry.js 单元测试：三维视锥投影（NDC pan、h/H 画面占比、米制景深、视锥与背后裁剪）、
// 2D 画布矩形归一化、AUDIO_TELEMETRY 安装契约（对齐 engine/render/events.mjs）与无状态确定性。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  projectThreeActor,
  trackCanvasActor,
  createAudioTelemetry,
} from '../../engine/stage/telemetry.js';
import { scanFiles } from '../../tools/baseline/lib/scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('projectThreeActor：透视相机左/中/右 NDC 声像、近大远小 h/H 比例与欧氏景深精确匹配几何光学', () => {
  // fov = 90° => tan(45°) = 1，深度 D 处视锥全高 = 2 * D，高 1m 的物体占比 scale = 1 / (2 * D)
  const cam = new THREE.PerspectiveCamera(90, 16 / 9, 0.1, 100);
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  cam.updateMatrixWorld(true);

  const actor = new THREE.Object3D();

  // 正中近景 D = 1m => scale = 0.5, depth = 1
  actor.position.set(0, 0, -1);
  const near = projectThreeActor(actor, cam, { worldHeight: 1.0 });
  assert.deepEqual(near, { x: 0, y: 0, scale: 0.5, depth: 1, visible: 1 });

  // 正中远景 D = 4m => scale = 0.125, depth = 4
  actor.position.set(0, 0, -4);
  const far = projectThreeActor(actor, cam, { worldHeight: 1.0 });
  assert.deepEqual(far, { x: 0, y: 0, scale: 0.125, depth: 4, visible: 1 });
  assert.ok(near.scale > far.scale * 3.5 && near.depth < far.depth);

  // 左侧与右侧横移（D = 2m 处半宽 = 2 * 16/9 = 3.55556m，x = ±1.77778m 对应 ndcX = ±0.5）
  actor.position.set(-16 / 9, 0.5, -2);
  const left = projectThreeActor(actor, cam, { worldHeight: 1.0 });
  assert.equal(left.x, -0.5);
  assert.equal(left.y, 0.25);
  assert.equal(left.scale, 0.25);
  assert.ok(Math.abs(left.depth - Math.hypot(16 / 9, 0.5, 2)) < 1e-4);
  assert.equal(left.visible, 1);

  actor.position.set(16 / 9, -0.5, -2);
  const right = projectThreeActor(actor, cam, { worldHeight: 1.0 });
  assert.equal(right.x, 0.5);
  assert.equal(right.y, -0.25);
  assert.equal(right.scale, 0.25);
  assert.equal(right.visible, 1);
});

test('projectThreeActor：相机背后、超出远裁面、视锥外与隐藏层级一律标记 visible = 0，depth 下限 0.1m', () => {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.2, 50);
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  cam.updateMatrixWorld(true);

  const group = new THREE.Group();
  const actor = new THREE.Object3D();
  group.add(actor);

  // 1) 在相机背后 (z = +3)：不翻转左右符号，visible 严格为 0
  actor.position.set(1.5, 0, 3);
  const behind = projectThreeActor(actor, cam, { worldHeight: 1.2 });
  assert.equal(behind.visible, 0);
  assert.ok(behind.x > 0, '相机右后方物体不应因负 w 翻转到左侧');
  assert.ok(Math.abs(behind.depth - Math.hypot(1.5, 0, 3)) < 1e-4);

  // 2) 与相机重合：depth 夹到 ≥ 0.1，visible = 0
  actor.position.set(0, 0, 0);
  const atEye = projectThreeActor(actor, cam, { worldHeight: 1.0 });
  assert.equal(atEye.depth, 0.1);
  assert.equal(atEye.visible, 0);

  // 3) 横向大幅出画 (|ndcX| > 1.15)：x 夹到 [-1, 1]，visible = 0
  actor.position.set(-20, 0, -4);
  const offLeft = projectThreeActor(actor, cam, { worldHeight: 1.0 });
  assert.equal(offLeft.x, -1);
  assert.equal(offLeft.visible, 0);

  // 4) 超出远裁面 (z = -80 < -far)：ndcZ > 1，visible = 0
  actor.position.set(0, 0, -80);
  const beyondFar = projectThreeActor(actor, cam, { worldHeight: 1.0 });
  assert.equal(beyondFar.visible, 0);
  assert.equal(beyondFar.depth, 80);

  // 5) 自身或父节点隐藏：visible = 0
  actor.position.set(0, 0, -5);
  assert.equal(projectThreeActor(actor, cam).visible, 1);
  group.visible = false;
  assert.equal(projectThreeActor(actor, cam).visible, 0);
  group.visible = true;
  actor.visible = false;
  assert.equal(projectThreeActor(actor, cam).visible, 0);
});

test('projectThreeActor：支持正交相机、Box3 包围盒与零依赖纯对象桩（Duck-Typed Mock）', () => {
  // 正交相机：视域高 10m (top=5, bottom=-5)，高 2.5m 的物体占比恒为 0.25
  const ortho = new THREE.OrthographicCamera(-8, 8, 5, -5, 0.1, 50);
  ortho.position.set(0, 0, 10);
  ortho.lookAt(0, 0, 0);
  ortho.updateMatrixWorld(true);

  const geom = new THREE.BoxGeometry(1, 2.5, 1);
  geom.computeBoundingBox();
  const mesh = new THREE.Mesh(geom);
  mesh.position.set(4, 0, 0);
  const pOrtho = projectThreeActor(mesh, ortho);
  assert.equal(pOrtho.x, 0.5);
  assert.equal(pOrtho.y, 0);
  assert.equal(pOrtho.scale, 0.25);
  assert.ok(Math.abs(pOrtho.depth - Math.hypot(4, 0, 10)) < 1e-4);
  assert.equal(pOrtho.visible, 1);

  // 显式传入世界空间 Box3
  const worldBox = new THREE.Box3(new THREE.Vector3(-1, -1.5, -4), new THREE.Vector3(1, 1.5, -2));
  const pBox = projectThreeActor(mesh, ortho, { box: worldBox, useBoxCenter: true });
  assert.equal(pBox.x, 0);
  assert.equal(pBox.scale, 0.3);

  // 纯普通 JS 桩对象（无 THREE 实例、无 matrixWorld）
  const mockObj = { position: { x: 0, y: 0, z: -5 }, scale: { x: 1, y: 2, z: 1 }, visible: true };
  const mockCam = { fov: 90, aspect: 16 / 9, near: 0.1, far: 100, position: { x: 0, y: 0, z: 0 } };
  const pMock = projectThreeActor(mockObj, mockCam, { radius: 0.5 });
  assert.deepEqual(pMock, { x: 0, y: 0, scale: 0.1, depth: 5, visible: 1 });
});

test('trackCanvasActor：2D 像素矩形与中心点归一化、占比夹紧、视口越界与碰撞脉冲', () => {
  const vp = { width: 1920, height: 1080 };

  // 左上角 (x, y, w, h) 写法：中心 (192, 270) => x = -0.8, y = +0.5, scale = 216/1080 = 0.2
  const r1 = trackCanvasActor({ x: 96, y: 162, w: 192, h: 216, impact: 0.75 }, vp);
  assert.deepEqual(r1, { x: -0.8, y: 0.5, scale: 0.2, visible: 1, impact: 0.75 });

  // 中心点 (cx, cy) 写法：正中特写 h = 540 => scale = 0.5
  const r2 = trackCanvasActor({ cx: 960, cy: 540, w: 400, h: 540 }, vp);
  assert.deepEqual(r2, { x: 0, y: 0, scale: 0.5, visible: 1, impact: 0 });

  // 完全移出右边界：visible = 0，x 夹紧到 +1
  const offRight = trackCanvasActor({ x: 1950, y: 400, w: 120, h: 120 }, vp);
  assert.equal(offRight.x, 1);
  assert.equal(offRight.visible, 0);

  // 未给尺寸且未给 cx 的空矩形：visible = 0
  const empty = trackCanvasActor({ x: 200, y: 200, w: 0, h: 0 }, vp);
  assert.equal(empty.visible, 0);

  // 超大贴脸元素：scale 上限夹在 1.5
  const huge = trackCanvasActor({ cx: 960, cy: 540, w: 2400, h: 2160, impact: 2.5 }, vp);
  assert.equal(huge.scale, 1.5);
  assert.equal(huge.impact, 1);
  assert.equal(huge.visible, 1);
});

test('createAudioTelemetry：安装 window.AUDIO_TELEMETRY 并与 events.mjs 逐帧采集契约完全兼容', () => {
  const cam = new THREE.PerspectiveCamera(90, 16 / 9, 0.1, 100);
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  cam.updateMatrixWorld(true);

  const ship = new THREE.Object3D();
  const mockWin = { __RENDER: { width: 1920, height: 1080 } };

  const tel = createAudioTelemetry({
    ship: {
      kind: 'three',
      camera: cam,
      worldHeight: 1.2,
      object: (t) => {
        ship.position.set(-4 + 8 * t, 0, -3);
        return ship;
      },
    },
    spark: {
      kind: 'canvas',
      getRect: (t, f) => ({
        cx: 192 + f * 64,
        cy: 540,
        w: 96,
        h: 108,
        visible: f >= 2 && f <= 18,
        impact: f === 10 ? 0.92 : 0,
      }),
    },
    wind: (t) => ({ x: t * 2 - 1, y: 0, scale: 0.4, visible: true, speed: 3.5 * t }),
  }, { targetWindow: mockWin });

  tel.install();
  assert.equal(typeof mockWin.AUDIO_TELEMETRY, 'function');

  // 逐帧模拟 engine/render/events.mjs 第 160–172 行的 dynTracks 聚合逻辑
  const nFrames = 24;
  const dynTracks = {};
  for (let f = 0; f < nFrames; f++) {
    const t = f / 24;
    const snap = mockWin.AUDIO_TELEMETRY(t, f);
    for (const [tk, chs] of Object.entries(snap)) {
      const dst = (dynTracks[tk] ??= {});
      for (const [ck, cv] of Object.entries(chs)) {
        if (typeof cv === 'number' && Number.isFinite(cv)) {
          (dst[ck] ??= new Array(f).fill(0)).push(+cv.toFixed(5));
        }
      }
    }
  }

  assert.deepEqual(Object.keys(dynTracks).sort(), ['ship', 'spark', 'wind']);
  for (const chs of Object.values(dynTracks)) {
    for (const arr of Object.values(chs)) {
      assert.equal(arr.length, nFrames, '每个通道必须严格对齐全部帧数，无缺帧错位');
    }
  }
  assert.ok(dynTracks.ship.x[0] < -0.5 && dynTracks.ship.x[23] > 0.5);
  assert.equal(dynTracks.spark.visible[0], 0);
  assert.equal(dynTracks.spark.visible[10], 1);
  assert.equal(dynTracks.spark.impact[10], 0.92);
  assert.equal(dynTracks.wind.visible[5], 1);

  // 无状态确定性：逆序或跳帧采样与顺序采样逐位一致
  const sForward = tel.sample(10 / 24, 10);
  const sAfterJump = (tel.sample(23 / 24, 23), tel.sample(0, 0), tel.sample(10 / 24, 10));
  assert.deepEqual(sForward, sAfterJump);
});

test('projectThreeActor：任意旋转平移机位与层级父子变换下与 THREE.Vector3.project 逐位对齐', () => {
  const cam = new THREE.PerspectiveCamera(52, 1920 / 1080, 0.1, 200);
  cam.position.set(4.2, 2.6, 7.5);
  cam.lookAt(-1.0, 0.8, -2.5);
  cam.updateMatrixWorld(true);

  const parent = new THREE.Group();
  parent.position.set(-1.5, 0.4, -2.0);
  parent.rotation.y = 0.45;
  const child = new THREE.Object3D();
  child.position.set(1.2, 0.5, -0.8);
  parent.add(child);

  const res = projectThreeActor(child, cam, { worldHeight: 1.6 });
  const worldPos = child.getWorldPosition(new THREE.Vector3());
  const expectedNdc = worldPos.clone().project(cam);
  const expectedDepth = cam.position.distanceTo(worldPos);

  assert.ok(Math.abs(res.x - expectedNdc.x) <= 2e-5);
  assert.ok(Math.abs(res.y - expectedNdc.y) <= 2e-5);
  assert.ok(Math.abs(res.depth - expectedDepth) <= 2e-5);
  assert.equal(res.visible, 1);

  const tel = createAudioTelemetry({});
  assert.deepEqual(tel.sample(0, 0), {});
  assert.throws(() => tel.install(null), TypeError);
});

test('telemetry.js 满足引擎确定性扫描（零非确定性时间或随机 API）', () => {
  const res = scanFiles(ROOT, ['engine/stage/telemetry.js'], []);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.findings, []);
});
