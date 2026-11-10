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
// 调用前相机的世界矩阵要是新的（aimCamera 会更新）；改了 zoom / filmOffset / setViewOffset 之后先 updateProjectionMatrix。
// 屏幕坐标都指相机此刻实际渲出的 W×H 画面：placeOnScreen / screenToWorld 和 project / screenToPlane 一样计入 zoom、filmOffset
// 和 setViewOffset（分块渲染时按整幅画面摆，就在开分块之前摆好）。placeOnScreen 摆的是世界位置，面片挂在带变换的父节点下也对：
// 会换算到父节点空间（父节点有不等比缩放又带旋转时，面片会被剪切，换不回纯 TRS，仍按最接近的分解写入）。
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

// 深度 D 处的画面矩形（相机局部坐标），与 three r170 PerspectiveCamera.updateProjectionMatrix 同一套 zoom / filmOffset / view 规则：
// 屏幕 (cx, cy) → 局部 (x, y)，屏幕宽高 → 局部宽高。zoom = 1、filmOffset = 0、不分块时和原来的式子逐位相同。
function frameAt(cam, D) {
  const hh = D * Math.tan(cam.fov * DEG / 2) / cam.zoom, hw = hh * cam.aspect;
  const sx = cam.filmOffset ? D * cam.filmOffset / cam.getFilmWidth() : 0;
  const v = cam.view && cam.view.enabled ? cam.view : null;
  return { hh, hw, sx, v, fw: v ? 2 * hw * v.width / v.fullWidth : 0, fh: v ? 2 * hh * v.height / v.fullHeight : 0 };
}
const localX = (F, W, cx) => F.v ? -F.hw + F.v.offsetX * 2 * F.hw / F.v.fullWidth + F.sx + cx / W * F.fw : (cx / W - 0.5) * 2 * F.hw + F.sx;
const localY = (F, H, cy) => F.v ? F.hh - F.v.offsetY * 2 * F.hh / F.v.fullHeight - cy / H * F.fh : (0.5 - cy / H) * 2 * F.hh;
const spanX = (F, W, wpx) => F.v ? wpx / W * F.fw : wpx / W * 2 * F.hw;
const spanY = (F, H, hpx) => F.v ? hpx / H * F.fh : hpx / H * 2 * F.hh;

const IDENTITY = new THREE.Matrix4(), _wm = new THREE.Matrix4(), _pi = new THREE.Matrix4(), _ws = new THREE.Vector3();
export function placeOnScreen(mesh, cam, W, H, cx, cy, wpx, D, hpx) {
  const F = frameAt(cam, D);
  const x = localX(F, W, cx), y = localY(F, H, cy);
  const w = spanX(F, W, wpx), h = hpx !== undefined ? spanY(F, H, hpx) : w / (mesh.userData.aspect || 1);
  mesh.position.set(x, y, -D).applyMatrix4(cam.matrixWorld);
  cam.getWorldQuaternion(mesh.quaternion);
  mesh.scale.set(w, h, 1);
  // 上面是世界变换；挂在带变换的父节点下时换到父节点空间（父节点是单位变换时跳过，结果与直接写入逐位相同）
  const parent = mesh.parent;
  if (parent) {
    parent.updateWorldMatrix(true, false);
    if (!parent.matrixWorld.equals(IDENTITY)) {
      _wm.compose(mesh.position, mesh.quaternion, _ws.set(w, h, 1)).premultiply(_pi.copy(parent.matrixWorld).invert());
      _wm.decompose(mesh.position, mesh.quaternion, mesh.scale);
    }
  }
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
  const F = frameAt(cam, D);
  return out.set(localX(F, W, cx), localY(F, H, cy), -D).applyMatrix4(cam.matrixWorld);
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
