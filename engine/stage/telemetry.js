// 北冥引擎 · 舞台声画空间遥测传感器（Browser + Node 纯函数 ES 模块，导入期零 DOM 依赖）。
// 把 Three.js 三维角色或 2D Canvas 矩形元素逐帧投射为统一的归一化声学遥测快照，
// 经 install(win) 挂到 window.AUDIO_TELEMETRY(t, f)，由 engine/render/events.mjs --telemetry 采进 kinematics.json，
// 直接驱动 Python 侧 engine/audio/spotting.py、director.screen_scale_to_distance 与 editorial.couple_motion_trajectory。
//
// 坐标约定（三维与二维完全一致）：
//   x       横向归一化位置 ∈ [-1, 1]（-1 左边缘，0 画面正中，+1 右边缘）
//   y       纵向归一化位置 ∈ [-1, 1]（+1 上边缘，0 画面正中，-1 下边缘，与 WebGL NDC 同向）
//   scale   元素占画面垂直高度比例 h/H ∈ [0, 1.5]（直接对应 screen_scale_to_distance 的 screen_ratio）
//   depth   到相机的欧氏距离（米，≥ 0.1；仅三维传感器输出）
//   visible 视锥/视口内可见标志（1 = 在画面视域内且自身可见，0 = 出画、在相机背后或已隐藏）
//   impact  可选瞬态接触强度 ∈ [0, 1]（2D 画布或自定义角色回调提供）
//
//   projectThreeActor(object3d, camera, opts)  纯 4×4 列主序矩阵投影（兼容任意 Three.js 版本与纯对象桩）
//   trackCanvasActor(rect, viewport)           像素坐标矩形/中心点归一化为屏幕声像与高度占比
//   createAudioTelemetry(actors, opts)         组装多角色采样器 { sample(t, f), install(win) }
import { clamp, DEG } from '../core/math.js';

const round5 = v => {
  if (!Number.isFinite(v)) return 0;
  const r = Math.round(v * 1e5) / 1e5;
  return r === 0 ? 0 : r;
};

const isBox3 = b => Boolean(
  b && typeof b === 'object'
  && b.min && b.max
  && Number.isFinite(b.min.x) && Number.isFinite(b.min.y) && Number.isFinite(b.min.z)
  && Number.isFinite(b.max.x) && Number.isFinite(b.max.y) && Number.isFinite(b.max.z)
  && b.max.y >= b.min.y
);

function transformPoint4(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

function invertMat4(te) {
  const n11 = te[0], n21 = te[1], n31 = te[2], n41 = te[3];
  const n12 = te[4], n22 = te[5], n32 = te[6], n42 = te[7];
  const n13 = te[8], n23 = te[9], n33 = te[10], n43 = te[11];
  const n14 = te[12], n24 = te[13], n34 = te[14], n44 = te[15];

  const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
  const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
  const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
  const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;

  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;

  return [
    t11 * inv,
    (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * inv,
    (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * inv,
    (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * inv,
    t12 * inv,
    (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * inv,
    (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * inv,
    (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * inv,
    t13 * inv,
    (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * inv,
    (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * inv,
    (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * inv,
    t14 * inv,
    (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * inv,
    (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * inv,
    (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * inv,
  ];
}

function resolveViewMatrix(camera) {
  if (camera?.matrixWorldInverse?.elements?.length === 16) return camera.matrixWorldInverse.elements;
  if (camera?.matrixWorld?.elements?.length === 16) {
    const inv = invertMat4(camera.matrixWorld.elements);
    if (inv) return inv;
  }
  const px = Number(camera?.position?.x ?? 0) || 0;
  const py = Number(camera?.position?.y ?? 0) || 0;
  const pz = Number(camera?.position?.z ?? 0) || 0;
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    -px, -py, -pz, 1,
  ];
}

function resolveProjectionMatrix(camera) {
  if (camera?.projectionMatrix?.elements?.length === 16) return camera.projectionMatrix.elements;
  const near = Math.max(1e-4, Number(camera?.near ?? 0.1) || 0.1);
  const far = Math.max(near + 1e-2, Number(camera?.far ?? 1000) || 1000);
  const zoom = Math.max(1e-4, Number(camera?.zoom ?? 1) || 1);

  if (typeof camera?.top === 'number' && typeof camera?.bottom === 'number' && typeof camera?.fov !== 'number') {
    const left = Number(camera.left ?? -1);
    const right = Number(camera.right ?? 1);
    const top = Number(camera.top);
    const bottom = Number(camera.bottom);
    const dx = (right - left) / (2 * zoom);
    const dy = (top - bottom) / (2 * zoom);
    const cx = (right + left) * 0.5;
    const cy = (top + bottom) * 0.5;
    const l = cx - dx, r = cx + dx, t = cy + dy, b = cy - dy;
    const w = 1 / Math.max(1e-6, r - l);
    const h = 1 / Math.max(1e-6, t - b);
    const p = 1 / (far - near);
    return [
      2 * w, 0, 0, 0,
      0, 2 * h, 0, 0,
      0, 0, -2 * p, 0,
      -(r + l) * w, -(t + b) * h, -(far + near) * p, 1,
    ];
  }

  const fov = Number(camera?.fov ?? 50) || 50;
  const aspect = Math.max(1e-4, Number(camera?.aspect ?? (16 / 9)) || (16 / 9));
  const top = near * Math.tan(fov * DEG * 0.5) / zoom;
  const height = 2 * top;
  const width = aspect * height;
  return [
    (2 * near) / width, 0, 0, 0,
    0, (2 * near) / height, 0, 0,
    0, 0, -(far + near) / (far - near), -1,
    0, 0, -(2 * far * near) / (far - near), 0,
  ];
}

function transformedBoxHeightY(box, mw) {
  let minY = Infinity, maxY = -Infinity;
  const xs = [box.min.x, box.max.x];
  const ys = [box.min.y, box.max.y];
  const zs = [box.min.z, box.max.z];
  for (let ix = 0; ix < 2; ix++) {
    for (let iy = 0; iy < 2; iy++) {
      for (let iz = 0; iz < 2; iz++) {
        const wy = mw[1] * xs[ix] + mw[5] * ys[iy] + mw[9] * zs[iz] + mw[13];
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }
    }
  }
  return Math.max(0, maxY - minY);
}

function isObjectVisible(obj) {
  for (let cur = obj; cur && typeof cur === 'object'; cur = cur.parent) {
    if (cur.visible === false) return false;
  }
  return true;
}

export function projectThreeActor(object3d, camera, opts = {}) {
  if (!object3d || typeof object3d !== 'object' || !camera || typeof camera !== 'object') {
    return { x: 0, y: 0, scale: 0, depth: 0.1, visible: 0 };
  }

  if (opts.updateMatrices !== false) {
    if (typeof object3d.updateWorldMatrix === 'function') object3d.updateWorldMatrix(true, false);
    else if (typeof object3d.updateMatrixWorld === 'function') object3d.updateMatrixWorld(false);
    if (typeof camera.updateWorldMatrix === 'function') camera.updateWorldMatrix(true, false);
    else if (typeof camera.updateMatrixWorld === 'function') camera.updateMatrixWorld(false);
  }

  const objVisible = isObjectVisible(object3d);
  const mw = object3d.matrixWorld?.elements?.length === 16 ? object3d.matrixWorld.elements : null;
  const directBox = !mw && !object3d.position && isBox3(object3d) ? object3d : null;
  const optBox = isBox3(opts.box) ? opts.box : null;

  let wx, wy, wz, sy = 1;
  if (directBox) {
    wx = (directBox.min.x + directBox.max.x) * 0.5;
    wy = (directBox.min.y + directBox.max.y) * 0.5;
    wz = (directBox.min.z + directBox.max.z) * 0.5;
  } else if (optBox && opts.useBoxCenter) {
    wx = (optBox.min.x + optBox.max.x) * 0.5;
    wy = (optBox.min.y + optBox.max.y) * 0.5;
    wz = (optBox.min.z + optBox.max.z) * 0.5;
    if (mw) sy = Math.hypot(mw[4], mw[5], mw[6]) || 1;
  } else if (mw) {
    if (opts.offset && typeof opts.offset === 'object') {
      const [ox, oy, oz, ow] = transformPoint4(mw, Number(opts.offset.x) || 0, Number(opts.offset.y) || 0, Number(opts.offset.z) || 0);
      const invW = (ow !== 0 && ow !== 1) ? 1 / ow : 1;
      wx = ox * invW; wy = oy * invW; wz = oz * invW;
    } else {
      wx = mw[12]; wy = mw[13]; wz = mw[14];
    }
    sy = Math.hypot(mw[4], mw[5], mw[6]) || 1;
  } else {
    wx = Number(object3d.position?.x ?? 0) || 0;
    wy = Number(object3d.position?.y ?? 0) || 0;
    wz = Number(object3d.position?.z ?? 0) || 0;
    sy = Math.abs(Number(object3d.scale?.y ?? 1)) || 1;
  }

  let worldHeight;
  if (typeof opts.worldHeight === 'number' && Number.isFinite(opts.worldHeight) && opts.worldHeight >= 0) {
    worldHeight = opts.worldHeight;
  } else if (typeof opts.radius === 'number' && Number.isFinite(opts.radius) && opts.radius >= 0) {
    worldHeight = opts.radius * 2;
  } else if (optBox) {
    worldHeight = Math.max(0, optBox.max.y - optBox.min.y);
  } else if (directBox) {
    worldHeight = Math.max(0, directBox.max.y - directBox.min.y);
  } else if (isBox3(object3d.boundingBox)) {
    worldHeight = Math.max(0, object3d.boundingBox.max.y - object3d.boundingBox.min.y) * sy;
  } else if (isBox3(object3d.geometry?.boundingBox)) {
    worldHeight = mw
      ? transformedBoxHeightY(object3d.geometry.boundingBox, mw)
      : Math.max(0, object3d.geometry.boundingBox.max.y - object3d.geometry.boundingBox.min.y) * sy;
  } else if (typeof object3d.geometry?.boundingSphere?.radius === 'number' && Number.isFinite(object3d.geometry.boundingSphere.radius)) {
    worldHeight = Math.max(0, object3d.geometry.boundingSphere.radius * 2) * sy;
  } else {
    worldHeight = 1.0 * sy;
  }

  const vm = resolveViewMatrix(camera);
  const pm = resolveProjectionMatrix(camera);

  const [cx, cy, cz, cw] = transformPoint4(vm, wx, wy, wz);
  const invCw = (cw !== 0 && cw !== 1) ? 1 / cw : 1;
  const xCam = cx * invCw, yCam = cy * invCw, zCam = cz * invCw;
  const depth = Math.max(0.1, Math.hypot(xCam, yCam, zCam));

  const [xClip, yClip, zClip, wClip] = transformPoint4(pm, xCam, yCam, zCam);

  let ndcX, ndcY, ndcZ, projectedHeight;
  if (wClip > 1e-6) {
    ndcX = xClip / wClip;
    ndcY = yClip / wClip;
    ndcZ = zClip / wClip;
    const [, yTopClip, , wTopClip] = transformPoint4(pm, xCam, yCam + worldHeight * 0.5, zCam);
    const [, yBotClip, , wBotClip] = transformPoint4(pm, xCam, yCam - worldHeight * 0.5, zCam);
    projectedHeight = (wTopClip > 1e-6 && wBotClip > 1e-6)
      ? Math.abs(yTopClip / wTopClip - yBotClip / wBotClip)
      : Math.abs(pm[5] * worldHeight) / wClip;
  } else {
    ndcX = (pm[0] * xCam) / depth;
    ndcY = (pm[5] * yCam) / depth;
    ndcZ = 2;
    projectedHeight = Math.abs(pm[5] * worldHeight) / depth;
  }

  const scale = clamp(projectedHeight / 2, 0, 1.5);
  const visible = (
    objVisible
    && wClip > 1e-6
    && ndcZ >= -1 && ndcZ <= 1
    && Math.abs(ndcX) <= 1.15 && Math.abs(ndcY) <= 1.15
  ) ? 1 : 0;

  return {
    x: round5(clamp(ndcX, -1, 1)),
    y: round5(clamp(ndcY, -1, 1)),
    scale: round5(scale),
    depth: round5(depth),
    visible,
  };
}

export function trackCanvasActor(rect, viewport = { width: 1920, height: 1080 }) {
  if (!rect || typeof rect !== 'object') {
    return { x: 0, y: 0, scale: 0, visible: 0, impact: 0 };
  }
  const vw = Math.max(1, Number(viewport?.width) || 1920);
  const vh = Math.max(1, Number(viewport?.height) || 1080);

  const w = Math.max(0, Number(rect.w ?? 0) || 0);
  const h = Math.max(0, Number(rect.h ?? 0) || 0);
  const hasCx = rect.cx !== undefined && rect.cx !== null;
  const hasCy = rect.cy !== undefined && rect.cy !== null;

  const px = hasCx ? Number(rect.cx) : (Number(rect.x ?? 0) + w * 0.5);
  const py = hasCy ? Number(rect.cy) : (Number(rect.y ?? 0) + h * 0.5);
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    return { x: 0, y: 0, scale: 0, visible: 0, impact: 0 };
  }

  const rawX = (px / vw) * 2 - 1;
  // y 与 WebGL NDC 同向：画面顶边 py=0 → +1，中心 py=vh/2 → 0，底边 py=vh → -1
  const rawY = 1 - (py / vh) * 2;
  const scale = clamp(h / vh, 0, 1.5);
  const impact = clamp(Number(rect.impact ?? 0) || 0, 0, 1);

  const hasGeometry = w > 0 || h > 0 || rect.cx !== undefined;
  const inX = w > 0 ? (px + w * 0.5 > 0 && px - w * 0.5 < vw) : (px >= 0 && px <= vw);
  const inY = h > 0 ? (py + h * 0.5 > 0 && py - h * 0.5 < vh) : (py >= 0 && py <= vh);
  const visible = (rect.visible !== false && hasGeometry && inX && inY) ? 1 : 0;

  return {
    x: round5(clamp(rawX, -1, 1)),
    y: round5(clamp(rawY, -1, 1)),
    scale: round5(scale),
    visible,
    impact: round5(impact),
  };
}

function sanitizeChannelSnapshot(raw) {
  if (!raw || typeof raw !== 'object') {
    return { x: 0, y: 0, scale: 0, visible: 0 };
  }
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'visible') {
      if (typeof v === 'boolean') out.visible = v ? 1 : 0;
      else if (typeof v === 'number' && Number.isFinite(v)) out.visible = round5(clamp(v, 0, 1));
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      if (k === 'x' || k === 'y') out[k] = round5(clamp(v, -1, 1));
      else if (k === 'scale') out.scale = round5(clamp(v, 0, 1.5));
      else if (k === 'depth') out.depth = round5(Math.max(0.1, v));
      else if (k === 'impact') out.impact = round5(clamp(v, 0, 1));
      else out[k] = round5(v);
    }
  }
  return out;
}

function defaultViewport(win, fallback) {
  if (fallback && typeof fallback === 'object') return fallback;
  const w = Number(win?.__RENDER?.width ?? win?.innerWidth) || 1920;
  const h = Number(win?.__RENDER?.height ?? win?.innerHeight) || 1080;
  return { width: w, height: h };
}

export function createAudioTelemetry(actors = {}, opts = {}) {
  if (!actors || typeof actors !== 'object' || Array.isArray(actors)) {
    throw new TypeError('createAudioTelemetry：actors 应为 { [actorId]: descriptorOrFn } 对象');
  }
  const entries = Object.entries(actors);
  const defaultWin = opts.targetWindow ?? globalThis.window;

  function sample(t = 0, f = 0) {
    const tt = Number(t) || 0;
    const ff = Number.isFinite(Number(f)) ? Math.round(Number(f)) : 0;
    const snap = {};

    for (const [actorId, desc] of entries) {
      if (typeof desc === 'function') {
        snap[actorId] = sanitizeChannelSnapshot(desc(tt, ff));
        continue;
      }
      if (!desc || typeof desc !== 'object') continue;

      if (desc.kind === 'three') {
        const obj = typeof desc.object === 'function' ? desc.object(tt, ff) : desc.object;
        const cam = typeof desc.camera === 'function' ? desc.camera(tt, ff) : (desc.camera ?? opts.camera);
        const worldHeight = typeof desc.worldHeight === 'function' ? desc.worldHeight(tt, ff) : desc.worldHeight;
        const radius = typeof desc.radius === 'function' ? desc.radius(tt, ff) : desc.radius;
        const box = typeof desc.box === 'function' ? desc.box(tt, ff) : desc.box;
        const base = projectThreeActor(obj, cam, {
          worldHeight,
          radius,
          box,
          offset: desc.offset,
          useBoxCenter: desc.useBoxCenter,
          updateMatrices: desc.updateMatrices,
        });
        if (desc.impact !== undefined) {
          const imp = typeof desc.impact === 'function' ? desc.impact(tt, ff) : desc.impact;
          base.impact = round5(clamp(Number(imp) || 0, 0, 1));
        }
        snap[actorId] = base;
        continue;
      }

      if (desc.kind === 'canvas') {
        const rect = typeof desc.getRect === 'function' ? desc.getRect(tt, ff) : desc.rect;
        const vp = typeof desc.viewport === 'function'
          ? desc.viewport(tt, ff)
          : (desc.viewport ?? defaultViewport(defaultWin, opts.viewport));
        snap[actorId] = trackCanvasActor(rect, vp);
        continue;
      }

      snap[actorId] = sanitizeChannelSnapshot(desc);
    }
    return snap;
  }

  function install(win = defaultWin) {
    if (!win || typeof win !== 'object') {
      throw new TypeError('createAudioTelemetry.install：需要传入目标 window 对象（Node 环境请显式传入桩对象）');
    }
    win.AUDIO_TELEMETRY = (t, f) => sample(t, f);
    return api;
  }

  const api = { sample, install };
  return api;
}
