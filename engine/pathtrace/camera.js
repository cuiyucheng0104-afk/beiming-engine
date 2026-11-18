// 北冥引擎 · 光追摄影机视锥贴合与屏幕像素投影工具（D 路线 · 北冥光追，决定 D13）
//
// 职责：提供纯帧号确定性随机种子（frameSeed）、近裁面三维铭牌精准视锥贴合（placeInCameraFrustum，
// 自动将局部 Z 厚度钳制在 z <= 0.0015m 以消除广角透视百叶窗拉伸）以及世界空间物体/包围盒向屏幕像素
// 包围盒 [x, y, w, h] 的精确透视投影（projectBoxToPixels，供 probe 阶段生成 work/texts.json 桥接 QA）。
// 本模块为纯 ESM JavaScript（配套 camera.d.ts），不依赖外部运行时即可在任意 Node 22.0+ 与 QuickJS 渲染器中同构运行。
//
// 导出接口：
//   MAX_WAFER_THICKNESS_M                                        三维 HUD 晶片最大厚度常量（0.0015 米）
//   frameSeed(seed, frame)                                       由全局种子与整数帧号派生无符号 32 位确定性种子
//   placeInCameraFrustum(mesh, camera, dist, pxBox, w, h)        按像素框 [x,y,w,h] 将网格贴合至视锥前 dist 米处
//   projectBoxToPixels(target, camera, screenW, screenH)         将网格或世界包围盒投影为屏幕像素框 [x,y,w,h] | null
//
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine

/** 近裁面三维 HUD 晶片允许的最大局部 Z 轴厚度（1.5 毫米），防止广角视锥边缘拉出侧面伪影。 */
export const MAX_WAFER_THICKNESS_M = 0.0015;

/**
 * 由基础种子与整数帧号生成确定性 32 位无符号整数种子（evaluation: "absolute"）。
 * 同一 (seed, frame) 在任意平台、乱序或分段重渲时结果恒定一致。
 */
export function frameSeed(seed, frame) {
  let h = ((Math.trunc(seed) | 0) ^ Math.imul((Math.trunc(frame) | 0) + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function toVec3(v, fallback) {
  if (Array.isArray(v) && v.length >= 3) {
    return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
  }
  if (v && typeof v === 'object' && 'x' in v && 'y' in v && 'z' in v) {
    return [Number(v.x) || 0, Number(v.y) || 0, Number(v.z) || 0];
  }
  return fallback;
}

function writeVec3(dst, x, y, z) {
  if (typeof dst.set === 'function') {
    dst.set(x, y, z);
  } else {
    dst.x = x;
    dst.y = y;
    dst.z = z;
  }
}

function writeQuat(dst, q) {
  if (!dst) return;
  if (typeof dst.set === 'function') {
    dst.set(q[0], q[1], q[2], q[3]);
  } else if (typeof dst.copy === 'function') {
    dst.copy({ x: q[0], y: q[1], z: q[2], w: q[3] });
  } else {
    dst.x = q[0];
    dst.y = q[1];
    dst.z = q[2];
    dst.w = q[3];
  }
}

function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm3(v, fallback) {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : fallback;
}

function rotateByQuat(v, q) {
  const [vx, vy, vz] = v;
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + qy * tz - qz * ty,
    vy + qw * ty + qz * tx - qx * tz,
    vz + qw * tz + qx * ty - qy * tx,
  ];
}

/** 由正交基三列向量 [right, up, back] 生成单位四元数 [x, y, z, w]。 */
function quatFromBasis(right, up, back) {
  const m11 = right[0], m12 = up[0], m13 = back[0];
  const m21 = right[1], m22 = up[1], m23 = back[1];
  const m31 = right[2], m32 = up[2], m33 = back[2];
  const trace = m11 + m22 + m33;
  let x, y, z, w;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    w = 0.25 / s;
    x = (m32 - m23) * s;
    y = (m13 - m31) * s;
    z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
    w = (m32 - m23) / s;
    x = 0.25 * s;
    y = (m12 + m21) / s;
    z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
    w = (m13 - m31) / s;
    x = (m12 + m21) / s;
    y = 0.25 * s;
    z = (m23 + m32) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
    w = (m21 - m12) / s;
    x = (m13 + m31) / s;
    y = (m23 + m32) / s;
    z = 0.25 * s;
  }
  const len = Math.hypot(x, y, z, w) || 1;
  return [x / len, y / len, z / len, w / len];
}

function resolveCameraFrame(camera, screenW, screenH) {
  if (!(screenW > 0 && screenH > 0)) {
    throw new RangeError(`画幅宽高必须为正数，收到 ${screenW}x${screenH}`);
  }
  if (typeof camera.updateWorldMatrix === 'function') {
    camera.updateWorldMatrix(true, false);
  } else if (typeof camera.updateMatrixWorld === 'function') {
    camera.updateMatrixWorld();
  }

  let pos = toVec3(camera.position, [0, 0, 0]);
  let right = [1, 0, 0];
  let up = [0, 1, 0];
  let back = [0, 0, 1];
  let forward = [0, 0, -1];

  const el = camera.matrixWorld?.elements;
  if (el && el.length >= 16) {
    const rx = Number(el[0]), ry = Number(el[1]), rz = Number(el[2]);
    const ux = Number(el[4]), uy = Number(el[5]), uz = Number(el[6]);
    const bx = Number(el[8]), by = Number(el[9]), bz = Number(el[10]);
    if (Math.hypot(rx, ry, rz) > 1e-8 && Math.hypot(ux, uy, uz) > 1e-8 && Math.hypot(bx, by, bz) > 1e-8) {
      pos = [Number(el[12]) || 0, Number(el[13]) || 0, Number(el[14]) || 0];
      right = norm3([rx, ry, rz], [1, 0, 0]);
      up = norm3([ux, uy, uz], [0, 1, 0]);
      back = norm3([bx, by, bz], [0, 0, 1]);
      forward = [-back[0], -back[1], -back[2]];
    }
  } else if (camera.target !== undefined) {
    const rawTarget = (camera.target && typeof camera.target === 'object' && 'position' in camera.target)
      ? camera.target.position
      : camera.target;
    const tgt = toVec3(rawTarget, [0, 0, 0]);
    const upRef = norm3(toVec3(camera.up, [0, 1, 0]), [0, 1, 0]);
    forward = norm3(sub3(tgt, pos), [0, 0, -1]);
    back = [-forward[0], -forward[1], -forward[2]];
    right = norm3(cross3(forward, upRef), [1, 0, 0]);
    up = norm3(cross3(right, forward), [0, 1, 0]);
  } else if (camera.quaternion) {
    const q = [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w];
    right = norm3(rotateByQuat([1, 0, 0], q), [1, 0, 0]);
    up = norm3(rotateByQuat([0, 1, 0], q), [0, 1, 0]);
    back = norm3(rotateByQuat([0, 0, 1], q), [0, 0, 1]);
    forward = [-back[0], -back[1], -back[2]];
  }

  const fovDeg = Number.isFinite(camera.fov) && camera.fov > 0 ? camera.fov : 50;
  const near = Number.isFinite(camera.near) && camera.near > 0 ? camera.near : 0.01;
  const halfHUnit = Math.tan((fovDeg * Math.PI) / 360);
  const halfWUnit = halfHUnit * (screenW / screenH);

  return { pos, right, up, forward, back, fovDeg, near, halfHUnit, halfWUnit };
}

/**
 * 将三维网格（单位平面 PlaneGeometry(1,1) 或薄晶片 BoxGeometry(1,1,1)）精确贴合到摄影机视锥前方 dist 米处，
 * 使其在 screenW × screenH 画面上恰好覆盖像素框 pxBox = [x, y, w, h]（左上角原点）。
 * 同时强制将 mesh.scale.z 钳制在 z <= 0.0015m，避免近裁面透视拉伸出百叶窗伪影。
 */
export function placeInCameraFrustum(mesh, camera, dist, pxBox, screenW, screenH) {
  if (!(dist > 0 && Number.isFinite(dist))) {
    throw new RangeError(`视锥贴合距离 dist 必须为正数，收到 ${dist}`);
  }
  const cf = resolveCameraFrame(camera, screenW, screenH);
  const [bx, by, bw, bh] = pxBox;
  const halfH = dist * cf.halfHUnit;
  const halfW = dist * cf.halfWUnit;

  const cxPx = bx + bw * 0.5;
  const cyPx = by + bh * 0.5;
  const ndcX = (cxPx / screenW) * 2 - 1;
  const ndcY = 1 - (cyPx / screenH) * 2;
  const worldW = (bw / screenW) * 2 * halfW;
  const worldH = (bh / screenH) * 2 * halfH;

  const px = cf.pos[0] + cf.forward[0] * dist + cf.right[0] * (ndcX * halfW) + cf.up[0] * (ndcY * halfH);
  const py = cf.pos[1] + cf.forward[1] * dist + cf.right[1] * (ndcX * halfW) + cf.up[1] * (ndcY * halfH);
  const pz = cf.pos[2] + cf.forward[2] * dist + cf.right[2] * (ndcX * halfW) + cf.up[2] * (ndcY * halfH);

  const rawScaleZ = Number(mesh.scale?.z);
  const clampedZ = Number.isFinite(rawScaleZ) && rawScaleZ > 0
    ? Math.min(rawScaleZ, MAX_WAFER_THICKNESS_M)
    : MAX_WAFER_THICKNESS_M;

  writeVec3(mesh.position, px, py, pz);
  writeQuat(mesh.quaternion, quatFromBasis(cf.right, cf.up, cf.back));
  writeVec3(mesh.scale, worldW, worldH, clampedZ);

  if (typeof mesh.updateWorldMatrix === 'function') {
    mesh.updateWorldMatrix(true, true);
  } else if (typeof mesh.updateMatrixWorld === 'function') {
    mesh.updateMatrixWorld();
  }

  return {
    position: [px, py, pz],
    scale: [worldW, worldH, clampedZ],
    box: [bx, by, bw, bh],
  };
}

function cornersFromMinMax(min, max) {
  const xs = min[0] === max[0] ? [min[0]] : [min[0], max[0]];
  const ys = min[1] === max[1] ? [min[1]] : [min[1], max[1]];
  const zs = min[2] === max[2] ? [min[2]] : [min[2], max[2]];
  const out = [];
  for (const x of xs) for (const y of ys) for (const z of zs) out.push([x, y, z]);
  return out;
}

function localBoundsOfMesh(mesh) {
  const posAttr = mesh.geometry?.attributes?.position;
  if (posAttr?.array && posAttr.array.length >= 3) {
    const step = posAttr.itemSize ?? 3;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i + 2 < posAttr.array.length; i += step) {
      const x = Number(posAttr.array[i]);
      const y = Number(posAttr.array[i + 1]);
      const z = Number(posAttr.array[i + 2]);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    if (Number.isFinite(x0)) return [[x0, y0, z0], [x1, y1, z1]];
  }
  const bb = mesh.geometry?.boundingBox;
  if (bb) {
    return [toVec3(bb.min, [-0.5, -0.5, 0]), toVec3(bb.max, [0.5, 0.5, 0])];
  }
  return [[-0.5, -0.5, 0], [0.5, 0.5, 0]];
}

function worldCornersOfTarget(target) {
  if (Array.isArray(target) && target.length === 2) {
    return cornersFromMinMax(toVec3(target[0], [0, 0, 0]), toVec3(target[1], [0, 0, 0]));
  }
  if (target && typeof target === 'object') {
    if ('min' in target && 'max' in target) {
      return cornersFromMinMax(toVec3(target.min, [0, 0, 0]), toVec3(target.max, [0, 0, 0]));
    }
    if ('center' in target && 'size' in target) {
      const c = toVec3(target.center, [0, 0, 0]);
      const s = toVec3(target.size, [0, 0, 0]);
      return cornersFromMinMax(
        [c[0] - s[0] * 0.5, c[1] - s[1] * 0.5, c[2] - s[2] * 0.5],
        [c[0] + s[0] * 0.5, c[1] + s[1] * 0.5, c[2] + s[2] * 0.5],
      );
    }
    if ('position' in target && 'scale' in target) {
      const m = target;
      if (typeof m.updateWorldMatrix === 'function') m.updateWorldMatrix(true, false);
      else if (typeof m.updateMatrixWorld === 'function') m.updateMatrixWorld();

      const [lMin, lMax] = localBoundsOfMesh(m);
      const localCorners = cornersFromMinMax(lMin, lMax);
      const el = m.matrixWorld?.elements;
      if (el && el.length >= 16) {
        return localCorners.map(([x, y, z]) => {
          const w = Number(el[3]) * x + Number(el[7]) * y + Number(el[11]) * z + Number(el[15]) || 1;
          return [
            (Number(el[0]) * x + Number(el[4]) * y + Number(el[8]) * z + Number(el[12])) / w,
            (Number(el[1]) * x + Number(el[5]) * y + Number(el[9]) * z + Number(el[13])) / w,
            (Number(el[2]) * x + Number(el[6]) * y + Number(el[10]) * z + Number(el[14])) / w,
          ];
        });
      }
      const pos = toVec3(m.position, [0, 0, 0]);
      const scl = toVec3(m.scale, [1, 1, 1]);
      const q = m.quaternion
        ? [m.quaternion.x, m.quaternion.y, m.quaternion.z, m.quaternion.w]
        : [0, 0, 0, 1];
      return localCorners.map(([x, y, z]) => {
        const r = rotateByQuat([x * scl[0], y * scl[1], z * scl[2]], q);
        return [pos[0] + r[0], pos[1] + r[1], pos[2] + r[2]];
      });
    }
  }
  throw new TypeError('projectBoxToPixels: target 必须是三维网格、{min, max}、{center, size} 或 [min, max]');
}

/**
 * 将三维网格或世界空间包围盒透视投影为屏幕像素框 [x, y, w, h]（左上角原点，单位 px）。
 * 若整个包围盒完全位于摄影机近裁面后方，则返回 null。
 */
export function projectBoxToPixels(target, camera, screenW, screenH) {
  const cf = resolveCameraFrame(camera, screenW, screenH);
  const corners = worldCornersOfTarget(target);
  if (!corners.length) return null;

  const camSpace = corners.map(w => {
    const rel = sub3(w, cf.pos);
    return [dot3(rel, cf.right), dot3(rel, cf.up), dot3(rel, cf.forward)];
  });
  if (camSpace.every(c => c[2] <= cf.near)) return null;

  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const [vx, vy, rawVz] of camSpace) {
    const vz = Math.max(rawVz, cf.near);
    const ndcX = vx / (vz * cf.halfWUnit);
    const ndcY = vy / (vz * cf.halfHUnit);
    const px = (ndcX + 1) * 0.5 * screenW;
    const py = (1 - ndcY) * 0.5 * screenH;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  return [minX, minY, Math.max(0, maxX - minX), Math.max(0, maxY - minY)];
}
