// 北冥引擎 · 穹顶面片：按 水平角 / 仰角 把底板贴在以原点为心的一块球面上。
// 摇镜、仰拍时天空和天际线不变形、不穿帮；挂到一个 Group 上，Group 放在相机位置（无视差）或附近（少量视差）。
// 水平角 yaw：0 = -Z 方向，正值向左（与相机 rotation.y 同号）；仰角 pitch 向上为正；单位弧度。
// uv：画面左 → 右 u 0 → 1，下 → 上 v 0 → 1（贴图上边在高处）。
//
//   domeGeo(R, yawC, yawSpan, pitchLo, pitchHi, sx, sy)   球面网格：中心水平角 yawC、跨度 yawSpan、仰角从 pitchLo 到 pitchHi
//   domePlate(map, order, R, yawC, yawSpan, pitchLo, pitchHi, o)   贴上底板材质（双面，o 同 plateMat）的穹顶面片
import * as THREE from 'three';
import { lerp } from '../core/math.js';
import { plateMat } from './plates.js';

export function domeGeo(R, yawC, yawSpan, pitchLo, pitchHi, sx = 64, sy = 48) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= sy; j++) {
    const v = j / sy, pit = lerp(pitchLo, pitchHi, v), cp = Math.cos(pit), sp = Math.sin(pit);
    for (let i = 0; i <= sx; i++) {
      const u = i / sx, yaw = yawC + yawSpan * (0.5 - u);
      pos.push(-Math.sin(yaw) * cp * R, sp * R, -Math.cos(yaw) * cp * R);
      uv.push(u, v);
    }
  }
  for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) {
    const a = j * (sx + 1) + i, b = a + 1, c = a + sx + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export function domePlate(map, order, R, yawC, yawSpan, pitchLo, pitchHi, o = {}) {
  const m = new THREE.Mesh(domeGeo(R, yawC, yawSpan, pitchLo, pitchHi), plateMat(map, { side: THREE.DoubleSide, ...o }));
  m.renderOrder = order; m.frustumCulled = false; m.userData.outline = false;
  return m;
}
