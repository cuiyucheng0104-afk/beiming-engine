// 北冥引擎 · 运动轨迹：朝向、逐帧积分的路径、贝塞尔曲线。全部确定性：同样的参数永远得到同样的轨迹，任意帧可单独重渲。
//
//   headingQuat(h, roll, out)        让物体本地 +X 指向航向 h、+Y 尽量朝上，再绕自身 X 轴滚转 roll（弧度）
//   integratePath(p0, dirAt, speedAt, { t0, steps, fps })   从 t0 起按 航向 × 速度 逐帧积分（取每帧中点），
//                                    返回 at(t, out)：帧间线性插值，t 超出范围时夹到两端
//   bezierPoints(a, b, c, d, n)      三次贝塞尔曲线上等参数间隔的 n + 1 个点
import * as THREE from 'three';
import { clamp } from '../core/math.js';

export function headingQuat(h, roll, out = new THREE.Quaternion()) {
  const x = h.clone(), y = new THREE.Vector3(0, 1, 0).addScaledVector(x, -x.y).normalize(), z = new THREE.Vector3().crossVectors(x, y);
  out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  return out.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), roll));
}

export function integratePath(p0, dirAt, speedAt, { t0 = 0, steps, fps = 24 }) {
  const path = [p0];
  for (let k = 1; k <= steps; k++) { const ts = t0 + (k - 0.5) / fps; path.push(path[k - 1].clone().addScaledVector(dirAt(ts), speedAt(ts) / fps)); }
  return (t, out = new THREE.Vector3()) => {
    const k = clamp((t - t0) * fps, 0, steps), k0 = Math.floor(k), k1 = Math.min(steps, k0 + 1);
    return out.copy(path[k0]).lerp(path[k1], k - k0);
  };
}

export function bezierPoints(a, b, c, d, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, wa = (1 - u) ** 3, wb = 3 * (1 - u) ** 2 * u, wc = 3 * (1 - u) * u * u, wd = u ** 3;
    pts.push(new THREE.Vector3().addScaledVector(a, wa).addScaledVector(b, wb).addScaledVector(c, wc).addScaledVector(d, wd));
  }
  return pts;
}
