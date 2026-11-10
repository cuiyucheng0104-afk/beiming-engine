// engine/stage 的回归测试（Node，不需要 GPU）：node --test engine/stage/stage.test.mjs
// 抠像面片在 GPU 上的混合结果（半透明边和天空混、不和黑色混）在 engine/look/gpu.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { aimCamera, placeOnScreen, fillScreen, placeStrip, screenToWorld, project } from './camera.js';
import { cutoutPlane, plate } from './plates.js';
import { DEG } from '../core/math.js';

const W = 1920, H = 1040;
const shotC = () => { const cam = new THREE.PerspectiveCamera(31, W / H, 1, 5000); aimCamera(cam, new THREE.Vector3(0, 6, 0), -3 * DEG, 23 * DEG); return cam; };
// 面片四角投到屏幕上 → 中心与宽高
function screenRect(mesh, cam, w = W, h = H) {
  mesh.updateWorldMatrix(true, false);
  const pts = [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]].map(([x, y]) => project(cam, w, h, new THREE.Vector3(x, y, 0).applyMatrix4(mesh.matrixWorld)));
  const cx = pts.reduce((a, p) => a + p.x, 0) / 4, cy = pts.reduce((a, p) => a + p.y, 0) / 4;
  return { cx, cy, w: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y), h: Math.hypot(pts[3].x - pts[0].x, pts[3].y - pts[0].y) };
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const unitPlane = () => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1)); m.userData.aspect = 1; return m; };

test('R44 placeOnScreen：面片挂在带平移 / 旋转 / 缩放的父节点下也摆在要求的屏幕位置', () => {
  for (const setup of [
    p => p.position.set(0, 6, 0),                                                    // 镜头 C 的 world 组放在 DECK
    p => { p.position.set(3, 6, -2); p.rotation.set(0, 20 * DEG, 0); },
    p => { p.position.set(-4, 1, 2); p.rotation.set(.1, -.3, .05); p.scale.setScalar(2.5); },
  ]) {
    const cam = shotC(), scene = new THREE.Scene(), parent = new THREE.Group(); setup(parent); scene.add(parent);
    const mesh = unitPlane(); parent.add(mesh);
    placeOnScreen(mesh, cam, W, H, 1300, 430, 600, 60, 300);
    const r = screenRect(mesh, cam);
    assert.ok(near(r.cx, 1300, 1e-6) && near(r.cy, 430, 1e-6), `中心 ${r.cx}, ${r.cy}`);
    assert.ok(near(r.w, 600, 1e-5) && near(r.h, 300, 1e-5), `宽高 ${r.w} × ${r.h}`);
  }
});

test('R44 placeOnScreen / fillScreen / screenToWorld 计入 cam.zoom 与 filmOffset，与 project 一致', () => {
  for (const tweak of [c => { c.zoom = 2; }, c => { c.zoom = .7; }, c => { c.filmOffset = 4; }, c => { c.zoom = 1.5; c.filmOffset = -3; }]) {
    const cam = shotC(); tweak(cam); cam.updateProjectionMatrix();
    const mesh = unitPlane(); new THREE.Scene().add(mesh);
    placeOnScreen(mesh, cam, W, H, 1440, 260, 480, 60, 260);
    const r = screenRect(mesh, cam);
    assert.ok(near(r.cx, 1440, 1e-6) && near(r.cy, 260, 1e-6) && near(r.w, 480, 1e-5) && near(r.h, 260, 1e-5), JSON.stringify(r));
    fillScreen(mesh, cam, W, H, 30);
    const f = screenRect(mesh, cam);
    assert.ok(near(f.cx, W / 2, 1e-6) && near(f.cy, H / 2, 1e-6) && near(f.w, W, 1e-5) && near(f.h, H, 1e-5), JSON.stringify(f));
    const p = project(cam, W, H, screenToWorld(cam, W, H, 1440, 260, 60));
    assert.ok(near(p.x, 1440, 1e-6) && near(p.y, 260, 1e-6) && near(p.z, 60, 1e-9));
  }
});

test('R44 setViewOffset：屏幕坐标指渲出的那一块（与 project 同一套），placeStrip 前后对得上', () => {
  const cam = shotC(); cam.setViewOffset(W, H, 480, 260, 960, 520);
  const mesh = unitPlane(); new THREE.Scene().add(mesh);
  placeOnScreen(mesh, cam, 960, 520, 480, 260, 200, 60, 100);
  const r = screenRect(mesh, cam, 960, 520);
  assert.ok(near(r.cx, 480, 1e-6) && near(r.cy, 260, 1e-6) && near(r.w, 200, 1e-5) && near(r.h, 100, 1e-5), JSON.stringify(r));
  cam.clearViewOffset(); cam.zoom = 2; cam.updateProjectionMatrix();
  const a = new THREE.Vector3(-10, 0, -80), b = new THREE.Vector3(12, -2, -90);
  placeStrip(mesh, cam, W, H, a, b, 30);
  const pa = project(cam, W, H, a), pb = project(cam, W, H, b), s = screenRect(mesh, cam);
  assert.ok(near(s.cx, (pa.x + pb.x) / 2, 1e-6) && near(s.cy, (pa.y + pb.y) / 2, 1e-6));
  assert.ok(near(s.w, Math.hypot(pb.x - pa.x, pb.y - pa.y), 2), `条带长度 ${s.w}`);
});

test('R44 挂在场景根下、zoom = 1 时与修改前的公式逐位相同（正片画面不变）', () => {
  const old = (mesh, cam, cx, cy, wpx, D, hpx) => {   // 修改前的实现
    const hh = D * Math.tan(cam.fov * DEG / 2), hw = hh * cam.aspect;
    const x = (cx / W - 0.5) * 2 * hw, y = (0.5 - cy / H) * 2 * hh;
    const w = wpx / W * 2 * hw, h = hpx !== undefined ? hpx / H * 2 * hh : w / (mesh.userData.aspect || 1);
    mesh.position.set(x, y, -D).applyMatrix4(cam.matrixWorld); cam.getWorldQuaternion(mesh.quaternion); mesh.scale.set(w, h, 1);
  };
  const cam = new THREE.PerspectiveCamera(16, W / H, 5, 40000); aimCamera(cam, new THREE.Vector3(1.3, 33, -7), .02, 1.4 * DEG);
  for (const [cx, cy, wpx, D, hpx] of [[960, 150, 2350, 20000], [1235, 575, 1500, 2300], [1250, 300, 1500, 2500, 190], [960, 520, 1920, 30, 1040]]) {
    const a = plate({ image: { width: 1600, height: 900 } }, 0), b = plate({ image: { width: 1600, height: 900 } }, 0);
    const scene = new THREE.Scene(); scene.add(a); new THREE.Scene().add(b);
    placeOnScreen(a, cam, W, H, cx, cy, wpx, D, hpx); old(b, cam, cx, cy, wpx, D, hpx);
    assert.deepEqual(a.position.toArray(), b.position.toArray()); assert.deepEqual(a.quaternion.toArray(), b.quaternion.toArray()); assert.deepEqual(a.scale.toArray(), b.scale.toArray());
  }
});

test('R30 抠像面片的深度遮罩进透明队列，排在更远的底板之后、彩色层之前', () => {
  const tex = new THREE.Texture(); tex.image = { width: 4, height: 4 };
  const g = cutoutPlane(tex, { order: 9, cut: 0.45 });
  const mask = g.children.find(o => o.material.colorWrite === false), color = g.children.find(o => o.material.colorWrite !== false);
  assert.equal(mask.material.transparent, true, '遮罩是透明材质：three 不会把它提到全部透明底板之前画');
  assert.equal(mask.material.depthWrite, true); assert.equal(mask.material.alphaTest, 0.45);
  assert.ok(mask.renderOrder < color.renderOrder && mask.renderOrder > 7, '底板 order ≤ 7 < 遮罩 < 彩色层');
  // three r170 的透明队列：groupOrder → renderOrder → 远到近；遮罩确实排在 order 7 的底板之后、彩色层之前
  const back = plate(tex, 7); back.position.z = -100; mask.position.z = color.position.z = -30;
  const list = [color, back, mask].map((o, i) => ({ id: i, groupOrder: 0, renderOrder: o.renderOrder, z: -o.position.z, o }));
  list.sort((a, b) => a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder || b.z - a.z || a.id - b.id);
  assert.deepEqual(list.map(x => x.o), [back, mask, color]);
});
