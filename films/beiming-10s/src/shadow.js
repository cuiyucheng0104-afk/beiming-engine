// src/shadow.js — 让主光（DirectionalLight）的阴影相机刚好罩住一个物体组，光的方向保持不变。物体移动后每帧调一次即可。
// 各个鲲（kun.js 和 kun_*.js 变体）的 fitShadow 都用它，只是罩心、半径、法线偏移各不相同。
//
//   fitShadowTo(light, group, { center, radius, size, normalBias })
//     center      罩心（group 局部坐标，[x, y, z]）
//     radius      罩的半径（group 局部单位；乘 group 的最大缩放）
//     size        阴影贴图边长（像素）；变了就重建贴图
//     normalBias  法线偏移（group 局部单位，同样乘缩放），默认 1.5
import * as THREE from 'three';

export function fitShadowTo(light, group, { center = [0, 0, 0], radius = 380, size = 4096, normalBias = 1.5 } = {}) {
  group.updateMatrixWorld(true);
  const c = new THREE.Vector3(center[0], center[1], center[2]).applyMatrix4(group.matrixWorld);
  const sc = group.matrixWorld.getMaxScaleOnAxis(), R = radius * sc;
  const dir = light.position.clone().sub(light.target.position);
  if (dir.lengthSq() < 1e-9) dir.set(0.75, 0.1, 0.65); dir.normalize();
  light.target.position.copy(c); light.target.updateMatrixWorld();
  light.position.copy(c).addScaledVector(dir, R * 3);
  const cam = light.shadow.camera;
  Object.assign(cam, { left: -R, right: R, top: R, bottom: -R, near: R * 0.5, far: R * 5.5 });
  cam.updateProjectionMatrix();
  if (light.shadow.mapSize.x !== size) { light.shadow.mapSize.set(size, size); light.shadow.map?.dispose(); light.shadow.map = null; }
  light.shadow.normalBias = normalBias * sc; light.shadow.bias = -0.0005; light.shadow.radius = 2;
  light.castShadow = true;
}
