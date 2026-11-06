// 北冥引擎 · 机位与屏幕坐标：相机朝向，屏幕像素 ↔ 世界坐标，按屏幕像素摆面片。
// 2.5D 合成的基本动作是"在起始机位下把底板摆到画面上的 (x, y)、离相机 D 米"——之后相机怎么动，视差都由真实透视产生。
// 角度约定：yaw 向左为正（与相机 rotation.y 同号），pitch 向上为正，弧度；W×H 是摆镜头用的画面像素尺寸。
//
//   aimCamera(cam, pos, yaw, pitch, roll)     摆相机：Euler YXZ（先偏航后俯仰，地平线不会歪）并更新世界矩阵
//   dirOf(yaw, pitch) / yawPitchOf(dir)       角度 ↔ 单位方向
//   wrapAngle(a)                              角度折回 (-π, π]
//   placeOnScreen(mesh, cam, W, H, cx, cy, wpx, D, hpx)   面片放到屏幕 (cx, cy)、宽 wpx（hpx 缺省按 userData.aspect）、视线深度 D
//   fillScreen(mesh, cam, W, H, D)            面片在深度 D 处正好铺满画面
//   placeStrip(mesh, cam, W, H, a, b, hpx, dy)   面片铺成从世界点 a 到 b 的屏幕条带（高 hpx，下移 dy 像素），深度取两端平均
//   screenToWorld(cam, W, H, cx, cy, D)       屏幕像素 + 深度 → 世界坐标
//   screenToPlane(cam, W, H, cx, cy, plane)   屏幕像素的视线与平面（缺省水平面 y = 0）的交点
//   project(cam, W, H, p) / projectAll(cam, W, H, pts, zMin)   世界坐标 → 屏幕 { x, y, z }（z = 到相机平面的距离）；后者只留 z > zMin 的点
// 调用前相机的世界矩阵要是新的（aimCamera 会更新）。
import * as THREE from 'three';
import { clamp, DEG } from '../core/math.js';

export function aimCamera(cam, pos, yaw, pitch, roll = 0) {
  cam.position.copy(pos);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(pitch, yaw, roll);
  cam.updateMatrixWorld(true);
}
export function dirOf(yaw, pitch, out = new THREE.Vector3()) {
  return out.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}
export const yawPitchOf = d => ({ yaw: Math.atan2(-d.x, -d.z), pitch: Math.asin(clamp(d.y, -1, 1)) });
export const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

export function placeOnScreen(mesh, cam, W, H, cx, cy, wpx, D, hpx) {
  const hh = D * Math.tan(cam.fov * DEG / 2), hw = hh * cam.aspect;
  const x = (cx / W - 0.5) * 2 * hw, y = (0.5 - cy / H) * 2 * hh;
  const w = wpx / W * 2 * hw, h = hpx !== undefined ? hpx / H * 2 * hh : w / (mesh.userData.aspect || 1);
  mesh.position.set(x, y, -D).applyMatrix4(cam.matrixWorld);
  cam.getWorldQuaternion(mesh.quaternion);
  mesh.scale.set(w, h, 1);
  return mesh;
}
export const fillScreen = (mesh, cam, W, H, D) => placeOnScreen(mesh, cam, W, H, W / 2, H / 2, W, D, H);
export function placeStrip(mesh, cam, W, H, a, b, hpx, dy = 0) {
  const pa = project(cam, W, H, a), pb = project(cam, W, H, b);
  const len = Math.hypot(pb.x - pa.x, pb.y - pa.y), cx = (pa.x + pb.x) / 2, cy = (pa.y + pb.y) / 2 + dy;
  placeOnScreen(mesh, cam, W, H, cx, cy, len, (pa.z + pb.z) / 2, hpx);
  mesh.rotateZ(-Math.atan2(pb.y - pa.y, pb.x - pa.x));
  return mesh;
}

export function screenToWorld(cam, W, H, cx, cy, D, out = new THREE.Vector3()) {
  const hh = D * Math.tan(cam.fov * DEG / 2), hw = hh * cam.aspect;
  return out.set((cx / W - 0.5) * 2 * hw, (0.5 - cy / H) * 2 * hh, -D).applyMatrix4(cam.matrixWorld);
}
const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2();
export function screenToPlane(cam, W, H, cx, cy, plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), out = new THREE.Vector3()) {
  _ray.setFromCamera(_ndc.set(cx / W * 2 - 1, 1 - cy / H * 2), cam);
  return _ray.ray.intersectPlane(plane, out);
}

const _pv = new THREE.Vector3(), _pc = new THREE.Vector3();
export function project(cam, W, H, p) {
  _pc.copy(p).applyMatrix4(cam.matrixWorldInverse);
  _pv.copy(p).project(cam);
  return { x: (_pv.x * 0.5 + 0.5) * W, y: (0.5 - _pv.y * 0.5) * H, z: -_pc.z };
}
export function projectAll(cam, W, H, pts, zMin = 0) {
  const out = [];
  for (const p of pts) { const s = project(cam, W, H, p); if (s.z > zMin) out.push({ x: s.x, y: s.y }); }
  return out;
}
