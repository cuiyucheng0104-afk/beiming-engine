// 校准场景检查器：查格式、查单位、从规格重算 expected 并比对。只用 Node 标准库。
// 格式说明见同目录 README.md。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 'calib-scene/0.1';

// 探针表的 12 行，按口径名引用。
export const PROBE_ROWS = [
  '颜色层的线性度', '显示变换', '深度口径', '编号层的边缘', '坐标与相机', '时间键',
  '快门相位', '子帧累积和后期的先后', '显示变换的整形曲线', '可见比例的成本', '确定性', '耗时',
];

// 数值字段必须以下列后缀之一结尾（最长的先匹配）。整数后缀另查整数。
export const UNIT_SUFFIXES = ['MPerFrame', 'RadPerFrame', 'Linear', 'Ratio', 'Frame', 'Index', 'Fps', 'Deg', 'Rad', 'Dir', 'Px', 'M'];
const INTEGER_SUFFIXES = new Set(['Frame', 'Index']);
const INTEGER_PATHS = new Set(['camera.widthPx', 'camera.heightPx']);

// 前面紧跟 Per 的（如 fooPerFrame）是表里没有的复合单位，不猜，返回 null。
export function unitOf(key) {
  const u = UNIT_SUFFIXES.find(s => key.endsWith(s) && key.length > s.length && /[a-z0-9]/.test(key[key.length - s.length - 1])) ?? null;
  return u && !key.slice(0, -u.length).endsWith('Per') ? u : null;
}

// 容差字段的取值范围：大于 0，不超过上限（README 第 2 节）。
export const TOLERANCE_MAX = { toleranceRatio: 0.1, tolerancePx: 2, minIouRatio: 1 };

// 走遍所有叶子：数组里的数归它所在的字段名管。带单位后缀的字段只能是有限的数。
export function checkUnits(node, path = '', key = null, out = []) {
  if (typeof node !== 'number' && !(node && typeof node === 'object') && key && unitOf(key)) {
    out.push(`${path}：${key} 带单位后缀，值必须是数，写的是 ${JSON.stringify(node)}`);
  } else if (typeof node === 'number') {
    const u = key && unitOf(key);
    if (!u) out.push(`${path}：数值字段「${key}」没带单位后缀`);
    else if ((INTEGER_SUFFIXES.has(u) || INTEGER_PATHS.has(path)) && !Number.isInteger(node)) out.push(`${path}：${key} 必须是整数`);
    if (!Number.isFinite(node)) out.push(`${path}：不是有限数`);
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => checkUnits(v, `${path}[${i}]`, key, out));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) if (k !== 'ext') checkUnits(v, path ? `${path}.${k}` : k, k, out);
  }
  return out;
}

// ---------- 格式 ----------

const TOP = { req: ['format', 'id', 'title', 'probeRows', 'colorSpace', 'frameRange', 'frameRateFps', 'camera', 'backgroundLinear', 'objects', 'expected'], opt: ['ext'] };
const CAMERA = { req: ['positionM', 'lookAtM', 'upDir', 'yFovDeg', 'widthPx', 'heightPx', 'nearM', 'farM'], opt: ['shutterAngleDeg', 'shutterOpens', 'apertureDiameterM', 'focusDistanceM'] };
const SHAPES = { box: ['sizeM'], plane: ['sizeM'], sphere: ['radiusM'], cylinder: ['radiusM', 'heightM'] };
const OBJECT_BASE = { req: ['id', 'idIndex', 'shape', 'positionM', 'emissionLinear'], opt: ['rotation', 'motion'] };
const MOTIONS = { linear: ['velocityMPerFrame'], spin: ['pivotM', 'axisDir', 'angularVelocityRadPerFrame'] };
const EXPECTED = {
  pixelHits: { req: ['atFrame', 'pixelPx', 'intendedHitIds', 'hits', 'toleranceRatio'] },
  projectPoint: { req: ['objectId', 'atFrame', 'subFrameRatio', 'localPointM', 'pixelPx', 'tolerancePx'], opt: ['sampleAt'] },
  patchColor: { req: ['objectId', 'pixelPx', 'valueLinear', 'toleranceRatio'] },
  projectedBox: { req: ['objectId', 'atFrame', 'boxMinPx', 'boxMaxPx', 'minIouRatio'] },
  projectedWidth: { req: ['objectId', 'atFrame', 'widthPx', 'tolerancePx'] },
};

function fields(obj, req, opt, where, out) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { out.push(`${where}：必须是对象`); return false; }
  for (const k of req) if (!(k in obj)) out.push(`${where}：缺必填字段 ${k}`);
  for (const k of Object.keys(obj)) if (!req.includes(k) && !opt.includes(k)) out.push(`${where}：未知字段 ${k}`);
  for (const [k, v] of Object.entries(obj)) if (v === null) out.push(`${where}.${k}：不得为 null`);
  return true;
}
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every(x => typeof x === 'number');

export function checkFormat(s) {
  const out = [];
  if (!fields(s, TOP.req, TOP.opt, '顶层', out)) return out;
  if (s.format !== FORMAT) out.push(`format 应为 ${FORMAT}`);
  if (!Array.isArray(s.probeRows) || !s.probeRows.length || s.probeRows.some(r => !PROBE_ROWS.includes(r))) out.push('probeRows：必须是探针表口径名的非空数组');
  if (s.colorSpace !== 'scene-linear-rec709') out.push('colorSpace 应为 scene-linear-rec709');
  fields(s.frameRange, ['startFrame', 'endFrame'], [], 'frameRange', out);
  if (s.frameRange && s.frameRange.startFrame !== 0) out.push('frameRange：startFrame 必须是 0（帧号从 0 起）');
  if (s.frameRange && s.frameRange.endFrame < s.frameRange.startFrame) out.push('frameRange：endFrame 小于 startFrame');
  if (fields(s.camera, CAMERA.req, CAMERA.opt, 'camera', out)) {
    const c = s.camera;
    for (const k of ['positionM', 'lookAtM', 'upDir']) if (!isVec(c[k], 3)) out.push(`camera.${k}：必须是 3 个数`);
    if ('shutterOpens' in c && c.shutterOpens !== 'frameStart') out.push('camera.shutterOpens 只能是 frameStart');
    if (('shutterOpens' in c) !== ('shutterAngleDeg' in c)) out.push('camera：shutterAngleDeg 和 shutterOpens 要么都写要么都不写');
    if (!(c.nearM > 0 && c.farM > c.nearM)) out.push('camera：必须 0 < nearM < farM');
    try { cameraBasis(c); } catch (err) { out.push(`camera：${err.message}`); }
  }
  if (!isVec(s.backgroundLinear, 3)) out.push('backgroundLinear：必须是 3 个数');
  const ids = new Set(), idx = new Set();
  (Array.isArray(s.objects) ? s.objects : []).forEach((o, i) => {
    const w = `objects[${i}]`;
    const shapeReq = SHAPES[o?.shape];
    if (!shapeReq) { out.push(`${w}：shape 只能是 ${Object.keys(SHAPES).join('、')}`); return; }
    fields(o, [...OBJECT_BASE.req, ...shapeReq], OBJECT_BASE.opt, w, out);
    if (ids.has(o.id)) out.push(`${w}：id 重复 ${o.id}`);
    if (!(o.idIndex >= 1) || idx.has(o.idIndex)) out.push(`${w}：idIndex 必须 ≥1 且不重复（0 留给背景）`);
    ids.add(o.id); idx.add(o.idIndex);
    if (!isVec(o.positionM, 3) || !isVec(o.emissionLinear, 3)) out.push(`${w}：positionM、emissionLinear 必须是 3 个数`);
    if ('sizeM' in o && !isVec(o.sizeM, o.shape === 'box' ? 3 : 2)) out.push(`${w}：sizeM 个数不对`);
    if (o.rotation && fields(o.rotation, ['axisDir', 'angleRad'], [], `${w}.rotation`, out) && !isVec(o.rotation.axisDir, 3)) out.push(`${w}.rotation.axisDir：必须是 3 个数`);
    if (o.motion) {
      const mReq = MOTIONS[o.motion.kind];
      if (!mReq) out.push(`${w}.motion.kind 只能是 ${Object.keys(MOTIONS).join('、')}`);
      else fields(o.motion, ['kind', ...mReq], [], `${w}.motion`, out);
    }
  });
  if (!Array.isArray(s.objects) || !s.objects.length) out.push('objects：必须是非空数组');
  if (!Array.isArray(s.expected) || !s.expected.length) out.push('expected：必须是非空数组');
  (Array.isArray(s.expected) ? s.expected : []).forEach((e, i) => {
    const w = `expected[${i}]`;
    const spec = EXPECTED[e?.kind];
    if (!spec) { out.push(`${w}：kind 只能是 ${Object.keys(EXPECTED).join('、')}`); return; }
    fields(e, ['kind', 'source', ...spec.req], spec.opt ?? [], w, out);
    if (typeof e.source !== 'string' || !e.source.trim()) out.push(`${w}：source 必须写算式出处`);
    if ('objectId' in e && !ids.has(e.objectId)) out.push(`${w}：objectId ${e.objectId} 不存在`);
    if ('atFrame' in e && s.frameRange && (e.atFrame < s.frameRange.startFrame || e.atFrame > s.frameRange.endFrame)) out.push(`${w}：atFrame 不在 frameRange 里`);
    if ('subFrameRatio' in e && !(e.subFrameRatio >= 0 && e.subFrameRatio < 1)) out.push(`${w}：subFrameRatio 必须在 [0,1)`);
    if ('pixelPx' in e && !isVec(e.pixelPx, 2)) out.push(`${w}：pixelPx 必须恰好是 2 个数`);
    if ('sampleAt' in e && e.sampleAt !== 'shutterMid') out.push(`${w}：sampleAt 只能是 shutterMid`);
    if ('intendedHitIds' in e && (!Array.isArray(e.intendedHitIds) || e.intendedHitIds.some(id => !ids.has(id)))) out.push(`${w}：intendedHitIds 必须是物体名数组`);
    for (const [k, max] of Object.entries(TOLERANCE_MAX)) if (k in e && !(e[k] > 0 && e[k] <= max)) out.push(`${w}：${k} 必须大于 0 且不超过 ${max}，写的是 ${e[k]}`);
  });
  return out;
}

// ---------- 几何 ----------

const sub = (a, b) => a.map((x, i) => x - b[i]);
const add = (a, b) => a.map((x, i) => x + b[i]);
const mul = (a, k) => a.map(x => x * k);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => mul(a, 1 / Math.hypot(...a));
const matVec = (m, v) => m.map(r => dot(r, v));
const matT = m => [0, 1, 2].map(j => m.map(r => r[j]));
const matMul = (a, b) => a.map(r => [0, 1, 2].map(j => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

// 罗德里格斯公式；右手定则，正角度绕轴逆时针（从轴尖往回看）。
export function axisAngle(axis, angle) {
  const [x, y, z] = norm(axis), c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [[t * x * x + c, t * x * y - s * z, t * x * z + s * y], [t * x * y + s * z, t * y * y + c, t * y * z - s * x], [t * x * z - s * y, t * y * z + s * x, t * z * z + c]];
}

// 物体在时刻 t（帧 + 子帧）的世界变换：p_world = R · p_local + T。
export function objectTransform(o, t) {
  const rs = o.rotation ? axisAngle(o.rotation.axisDir, o.rotation.angleRad) : I3;
  const m = o.motion;
  if (m?.kind === 'spin') {
    const rm = axisAngle(m.axisDir, m.angularVelocityRadPerFrame * t);
    return { R: matMul(rm, rs), T: add(matVec(rm, sub(o.positionM, m.pivotM)), m.pivotM) };
  }
  if (m?.kind === 'linear') return { R: rs, T: add(o.positionM, mul(m.velocityMPerFrame, t)) };
  return { R: rs, T: o.positionM };
}
const toWorld = (o, t, p) => { const { R, T } = objectTransform(o, t); return add(matVec(R, p), T); };

// 建不出基（前向长度为零、up 为零或与前向平行）或视场角不在 (0, 180) 时抛错。
export function cameraBasis(c) {
  const d = sub(c.lookAtM, c.positionM), u = c.upDir;
  if (!(Math.hypot(...d) > 1e-9)) throw new Error('lookAtM 与 positionM 重合，前向长度为零');
  if (!(Math.hypot(...u) > 1e-9)) throw new Error('upDir 长度为零');
  const fwd = norm(d), side = cross(fwd, norm(u));
  if (!(Math.hypot(...side) > 1e-9)) throw new Error('upDir 与前向平行，建不出基');
  if (!(c.yFovDeg > 0 && c.yFovDeg < 180)) throw new Error(`yFovDeg 必须在 (0, 180) 开区间，写的是 ${c.yFovDeg}`);
  const right = norm(side), up = cross(right, fwd);
  const f = (c.heightPx / 2) / Math.tan((c.yFovDeg * Math.PI / 180) / 2);
  return { fwd, right, up, f };
}

// 针孔投影。像素坐标原点在图像左上角，u 向右、v 向下，像素 (i,j) 的中心是 (i+0.5, j+0.5)。
export function project(c, p) {
  const { fwd, right, up, f } = cameraBasis(c);
  const d = sub(p, c.positionM), depth = dot(d, fwd);
  return [c.widthPx / 2 + f * dot(d, right) / depth, c.heightPx / 2 - f * dot(d, up) / depth];
}

// 局部空间里射线 o + s·d 与形体的第一个交点参数 s（> 0），没有返回 null。
function hitLocal(o, ro, rd) {
  const EPS = 1e-12;
  const firstPositive = list => { const v = list.filter(s => s > EPS).sort((a, b) => a - b); return v.length ? v[0] : null; };
  if (o.shape === 'plane') {
    if (Math.abs(rd[2]) < EPS) return null;
    const s = -ro[2] / rd[2], x = ro[0] + s * rd[0], y = ro[1] + s * rd[1];
    return s > EPS && Math.abs(x) <= o.sizeM[0] / 2 && Math.abs(y) <= o.sizeM[1] / 2 ? s : null;
  }
  if (o.shape === 'box') {
    let lo = -Infinity, hi = Infinity;
    for (let i = 0; i < 3; i++) {
      const h = o.sizeM[i] / 2;
      if (Math.abs(rd[i]) < EPS) { if (Math.abs(ro[i]) > h) return null; continue; }
      const a = (-h - ro[i]) / rd[i], b = (h - ro[i]) / rd[i];
      lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
    }
    return lo <= hi ? firstPositive([lo, hi]) : null;
  }
  if (o.shape === 'sphere') {
    const b = dot(ro, rd), a = dot(rd, rd), cc = dot(ro, ro) - o.radiusM ** 2, disc = b * b - a * cc;
    return disc < 0 ? null : firstPositive([(-b - Math.sqrt(disc)) / a, (-b + Math.sqrt(disc)) / a]);
  }
  if (o.shape === 'cylinder') { // 轴沿局部 Y，中心在原点
    const r = o.radiusM, h = o.heightM / 2, cand = [];
    const a = rd[0] ** 2 + rd[2] ** 2, b = ro[0] * rd[0] + ro[2] * rd[2], cc = ro[0] ** 2 + ro[2] ** 2 - r * r;
    if (a > EPS) {
      const disc = b * b - a * cc;
      if (disc >= 0) for (const s of [(-b - Math.sqrt(disc)) / a, (-b + Math.sqrt(disc)) / a]) if (Math.abs(ro[1] + s * rd[1]) <= h) cand.push(s);
    }
    if (Math.abs(rd[1]) > EPS) for (const y of [-h, h]) {
      const s = (y - ro[1]) / rd[1];
      if ((ro[0] + s * rd[0]) ** 2 + (ro[2] + s * rd[2]) ** 2 <= r * r) cand.push(s);
    }
    return firstPositive(cand);
  }
  throw new Error(`未知形体 ${o.shape}`);
}

// 穿过像素的射线依次打到哪些物体（每个物体只记第一个交点），由近到远。
export function raycast(scene, pixel, t) {
  const c = scene.camera, { fwd, right, up, f } = cameraBasis(c);
  const d = add(add(mul(right, (pixel[0] - c.widthPx / 2) / f), mul(up, -(pixel[1] - c.heightPx / 2) / f)), fwd); // 前向分量为 1
  const len = Math.hypot(...d);
  const hits = [];
  for (const o of scene.objects) {
    const { R, T } = objectTransform(o, t), Rt = matT(R);
    const s = hitLocal(o, matVec(Rt, sub(c.positionM, T)), matVec(Rt, d));
    if (s !== null) hits.push({ objectId: o.id, planeDepthM: s, rayDistanceM: s * len });
  }
  return hits.sort((a, b) => a.planeDepthM - b.planeDepthM);
}

function corners(o) {
  const [x, y, z = 0] = o.sizeM.map(v => v / 2), out = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of (o.shape === 'box' ? [-1, 1] : [0])) out.push([sx * x, sy * y, sz * z]);
  return out;
}

// 物体在相机前方向上的深度范围（第 t 帧），用来查裁剪面。
function depthRange(s, o, t) {
  const c = s.camera, { fwd } = cameraBasis(c), { R, T } = objectTransform(o, t);
  const dc = dot(sub(T, c.positionM), fwd);
  if (o.shape === 'sphere') return [dc - o.radiusM, dc + o.radiusM];
  if (o.shape === 'cylinder') {
    const a = Math.abs(dot(matVec(R, [0, 1, 0]), fwd)), e = a * o.heightM / 2 + o.radiusM * Math.sqrt(Math.max(0, 1 - a * a));
    return [dc - e, dc + e];
  }
  const ds = corners(o).map(p => dot(sub(add(matVec(R, p), T), c.positionM), fwd));
  return [Math.min(...ds), Math.max(...ds)];
}

// 物体在 frameRange 的任一整数帧上全部或部分落在 [nearM, farM] 之外就报。
export function checkClip(s) {
  const out = [], { nearM, farM } = s.camera;
  for (const o of s.objects) for (let t = s.frameRange.startFrame; t <= s.frameRange.endFrame; t++) {
    const [lo, hi] = depthRange(s, o, t);
    if (lo < nearM || hi > farM) { out.push(`${o.id}：第 ${t} 帧深度 ${r6(lo)} 到 ${r6(hi)} 米，超出裁剪面 [${nearM}, ${farM}]`); break; }
  }
  return out;
}

// ---------- 重算 expected ----------

const r6 = x => Math.round(x * 1e6) / 1e6;
const byId = (s, id) => s.objects.find(o => o.id === id);

// 返回这一条标准答案应有的「答案字段」。输入字段（帧、像素、物体等）原样取自条目。
export function computeExpected(s, e) {
  const o = e.objectId ? byId(s, e.objectId) : null;
  switch (e.kind) {
    case 'pixelHits': {
      const hits = raycast(s, e.pixelPx, e.atFrame);
      const got = hits.map(h => h.objectId);
      if (JSON.stringify(got) !== JSON.stringify(e.intendedHitIds)) return { error: `像素 ${e.pixelPx} 重算打到 [${got.join('、') || '背景'}]，意图是 [${e.intendedHitIds.join('、') || '背景'}]` };
      return { hits: hits.map(h => ({ objectId: h.objectId, planeDepthM: r6(h.planeDepthM), rayDistanceM: r6(h.rayDistanceM) })) };
    }
    case 'projectPoint': {
      // sampleAt = shutterMid：子帧由快门算，快门从帧起点打开、开 shutterAngleDeg / 360 帧，中点在一半处。
      if (e.sampleAt === 'shutterMid' && !('shutterAngleDeg' in s.camera)) return { error: 'sampleAt 是 shutterMid，但相机没写快门' };
      const subFrame = e.sampleAt === 'shutterMid' ? s.camera.shutterAngleDeg / 360 / 2 : e.subFrameRatio;
      const px = { pixelPx: project(s.camera, toWorld(o, e.atFrame + subFrame, e.localPointM)).map(r6) };
      return e.sampleAt === 'shutterMid' ? { subFrameRatio: r6(subFrame), ...px } : px;
    }
    case 'patchColor': {
      // 中心像素由色块位置投影出来（startFrame 时刻），再确认它最先打到这块面片。
      const pixelPx = project(s.camera, toWorld(o, s.frameRange.startFrame, [0, 0, 0])).map(r6);
      const first = raycast(s, pixelPx, s.frameRange.startFrame)[0];
      if (first?.objectId !== e.objectId) return { error: `像素 ${pixelPx} 最先打到的是 ${first?.objectId ?? '背景'}，不是 ${e.objectId}` };
      return { pixelPx, valueLinear: o.emissionLinear };
    }
    case 'projectedBox': {
      if (!['box', 'plane'].includes(o.shape)) return { error: 'projectedBox 只支持 box、plane' };
      const px = corners(o).map(p => project(s.camera, toWorld(o, e.atFrame, p)));
      return { boxMinPx: [0, 1].map(i => r6(Math.min(...px.map(p => p[i])))), boxMaxPx: [0, 1].map(i => r6(Math.max(...px.map(p => p[i])))) };
    }
    case 'projectedWidth': {
      if (o.shape !== 'cylinder') return { error: 'projectedWidth 只支持 cylinder' };
      const ctr = toWorld(o, e.atFrame, [0, 0, 0]), { right } = cameraBasis(s.camera);
      const a = project(s.camera, add(ctr, mul(right, o.radiusM))), b = project(s.camera, sub(ctr, mul(right, o.radiusM)));
      return { widthPx: r6(Math.abs(a[0] - b[0])) };
    }
  }
  return { error: `未知 kind ${e.kind}` };
}

// 两个答案逐项比：字符串要相等，数要在 1e-5（大于 1 时按相对）以内；任一边不是有限数就报。
function diff(want, got, path, out) {
  if (typeof want === 'number') {
    if (!Number.isFinite(want) || !Number.isFinite(got)) out.push(`${path}：写的是 ${got}，重算是 ${want}，不是有限数`);
    else if (Math.abs(want - got) > 1e-5 * Math.max(1, Math.abs(want))) out.push(`${path}：写的是 ${got}，重算是 ${want}`);
  } else if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) out.push(`${path}：写了 ${Array.isArray(got) ? got.length : 0} 项，重算是 ${want.length} 项 ${JSON.stringify(want)}`);
    else want.forEach((w, i) => diff(w, got[i], `${path}[${i}]`, out));
  } else if (want && typeof want === 'object') {
    for (const k of Object.keys(want)) diff(want[k], got?.[k], `${path}.${k}`, out);
  } else if (want !== got) out.push(`${path}：写的是 ${JSON.stringify(got)}，重算是 ${JSON.stringify(want)}`);
}

export function checkExpected(s) {
  const out = [];
  s.expected.forEach((e, i) => {
    const want = computeExpected(s, e);
    if (want.error) out.push(`expected[${i}]：${want.error}`);
    else diff(want, e, `expected[${i}]`, out);
  });
  return out;
}

// 一个场景的全部问题；格式不过就不往下重算。
export function checkScene(s, dirName) {
  const out = checkFormat(s);
  if (s?.id !== dirName) out.push(`id「${s?.id}」和目录名「${dirName}」不一致`);
  out.push(...checkUnits(s));
  if (!out.length) out.push(...checkClip(s), ...checkExpected(s));
  return out;
}

export const CALIB_DIR = dirname(fileURLToPath(import.meta.url));

export function loadScenes(dir = CALIB_DIR) {
  return readdirSync(dir).filter(n => n.startsWith('probe-') && statSync(join(dir, n)).isDirectory()).sort()
    .map(name => ({ name, scene: JSON.parse(readFileSync(join(dir, name, 'scene.json'), 'utf8')) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const scenes = loadScenes();
  let bad = 0;
  for (const { name, scene } of scenes) {
    const problems = checkScene(scene, name);
    if (problems.length) { bad++; console.log(`${name}：有问题 ${problems.length} 处`); for (const p of problems) console.log(`  - ${p}`); }
    else console.log(`${name}：通过，核对标准答案 ${scene.expected.length} 个`);
  }
  console.log(`${scenes.length} 个场景，${bad} 个有问题`);
  process.exitCode = bad || scenes.length !== 7 ? 1 : 0;
}
