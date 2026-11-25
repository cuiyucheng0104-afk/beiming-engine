import { argumentsOf, bad, fields, vector } from './arguments.mjs';

// 声明中的角度范围为 [−180°, 180°]。轴向视线必须精确为零，否则角点会虚增一个投影宽度。
function sinDeg(deg) {
  if (deg % 180 === 0) return 0;
  if (Math.abs(deg) === 90) return Math.sign(deg);
  return Math.sin(deg * Math.PI / 180);
}
function cosDeg(deg) {
  if (Math.abs(deg) === 90) return 0;
  return Math.cos(deg * Math.PI / 180);
}

// p 是相对于目标点的角点，z 为它在相机后轴上的分量。投影的深度是 d−z，
// 所以每个角点都要求 d ≥ z + max(|x_cam|/kx, |y_cam|/ky)，kx、ky 是安全框半张角的正切。
function cornerBounds(min, max, target, { ca, sa, ce, se }, kx, ky, orbit) {
  let d = -Infinity, nearest = -Infinity;
  for (const X of [min[0], max[0]]) for (const Y of [min[1], max[1]]) for (const Z of [min[2], max[2]]) {
    const x = X - target[0], y = Y - target[1], z = Z - target[2];
    if (!orbit) {
      const h = x * sa + z * ca, back = h * ce + y * se;
      nearest = Math.max(nearest, back);
      d = Math.max(d, back + Math.max(Math.abs(x * ca - z * sa) / kx, Math.abs(y * ce - h * se) / ky));
    } else {
      // 整圈固定半径，不用逐帧试。令 h = x sin(a) + z cos(a)，侧投影 = x cos(a) − z sin(a)。
      // 两者随 a 绕半径 r 的圆，任意 A*h+B*侧投影 在一圈上的最大值就是 r*hypot(A,B)。
      const r = Math.hypot(x, z);
      nearest = Math.max(nearest, y * se + r * Math.abs(ce));
      d = Math.max(d, y * se + r * Math.hypot(ce, 1 / kx));
      for (const sign of [-1, 1]) d = Math.max(d, y * (se + sign * ce / ky) + r * Math.abs(ce - sign * se / ky));
    }
  }
  return [d, nearest];
}

function solve(min, max, target, axes, kx, ky, orbit) {
  const [d, nearest] = cornerBounds(min, max, target, axes, kx, ky, orbit);
  // 最近角点的正深度要能与舍入噪声区分；随盒子一起缩放容差，保留小尺度侧视盒的解。
  if (!Number.isFinite(d) || !(d - nearest > Math.abs(nearest) * 1e-12)) bad('盒退化或尺度不可表示，没有八角都在相机前方的最小取景距离');
  return d;
}

function box({ min, max } = {}) {
  min = vector(min); max = vector(max);
  if (min.some((v, k) => v > max[k])) bad('bbox 各轴的 min 不得超过 max');
  return { min, max };
}

// 单调队列保存窗口内尚可能成为最大值的下标，每项只入队、出队一次。
function centeredMax(values, radius) {
  const queue = [];
  let head = 0, next = 0;
  return values.map((_, f) => {
    while (next < values.length && next <= f + radius) {
      while (queue.length > head && values[queue.at(-1)] <= values[next]) queue.pop();
      queue.push(next++);
    }
    while (queue[head] < f - radius) head++;
    return values[queue[head]];
  });
}

function dynamicTrack(boxes, p, elevation) {
  const ca = cosDeg(p.azimuthDeg), sa = sinDeg(p.azimuthDeg);
  const ce = cosDeg(elevation), se = sinDeg(elevation);
  const ky = p.margin * Math.tan(p.fovYDeg * Math.PI / 360), kx = ky * p.aspect;
  const floor = p.groundY + p.groundClearanceM;
  const constraints = boxes.map(({ min, max }) => {
    const target = min.map((v, i) => v / 2 + max[i] / 2);
    if (se === 0) target[1] = Math.max(target[1], floor);
    const [frustum, nearest] = cornerBounds(min, max, target, { ca, sa, ce, se }, kx, ky, p.view === 'orbit');
    const ground = se > 0 ? Math.max(0, (floor - target[1]) / se) : 0;
    const hard = Math.max(p.nearClipM, nearest + p.nearClipM, ground);
    return { target, hard, raw: Math.max(frustum, hard) };
  });
  const raw = constraints.map(c => c.raw);
  const envelope = p.useSlidingMax ? centeredMax(raw, p.windowFrames) : raw;
  let smooth = envelope[0];
  const track = constraints.map(({ target, hard, raw }, f) => {
    if (f > 0) smooth = p.smoothAlpha * envelope[f] + (1 - p.smoothAlpha) * smooth;
    const distance = Math.max(smooth, p.useSlidingMax ? raw : hard);
    const h = distance * ce;
    const position = [target[0] + h * sa, target[1] + distance * se, target[2] + h * ca];
    if (!Number.isFinite(distance) || !position.every(Number.isFinite)) bad('动态相机位置超出有限数范围');
    return { position, target, distance, fovYDeg: p.fovYDeg };
  });
  // 低机位朝向时，增加距离只会让相机更低。整个镜头一起改为水平，不逐帧跳俯仰角。
  if (se < 0 && track.some(({ position }) => position[1] < floor)) return dynamicTrack(boxes, p, 0);
  const s = sinDeg(p.azimuthDeg / 2), c = cosDeg(p.azimuthDeg / 2), t = sinDeg(elevation / 2), u = cosDeg(elevation / 2);
  return { track, quat: [-c * t, s * u, s * t, c * u] };
}

let lastDynamic;
function dynamic(p, f) {
  if (!Array.isArray(p.bboxes) || !p.bboxes.length) bad('bboxes 必须是非空逐帧包围盒数组或 null');
  const boxes = p.bboxes.map(b => { fields(b, ['min', 'max']); return box(b); });
  const key = [p.view, p.azimuthDeg, p.elevationDeg, p.margin, p.fovYDeg, p.aspect, p.windowFrames, p.smoothAlpha,
    p.groundY, p.groundClearanceM, p.nearClipM, p.useSlidingMax];
  for (const { min, max } of boxes) key.push(...min, ...max);
  if (!lastDynamic || key.length !== lastDynamic.key.length || !key.every((v, i) => Object.is(v, lastDynamic.key[i]))) {
    lastDynamic = { key, ...dynamicTrack(boxes, p, p.elevationDeg) };
  }
  const { track, quat } = lastDynamic;
  const { target, position, distance, fovYDeg } = track[Math.min(track.length - 1, Math.max(0, f))];
  return { target: [...target], distance, camera: { pos: [...position], quat: [...quat], fovDeg: fovYDeg } };
}

// 宿主会逐帧调 evaluate，有的还会每帧重建 params。只记上一份数值键与不可变标量距离，
// 因而同一个静态设置只解一次；改过 bbox、乱序求帧、调用方改动上次的返回值都不会污染结果。
let last;
export function evaluate(inputs, params, f, sub = 0) {
  const p = argumentsOf(inputs, params, f, sub);
  fields(p.bbox, ['min', 'max']);
  const { min, max } = box(p.bbox);
  if (p.view !== 'fixed' && p.view !== 'orbit') bad('view 只能是 fixed 或 orbit');
  if (p.bboxes !== null) return dynamic(p, f);
  const target = min.map((v, i) => v / 2 + max[i] / 2);
  const a = p.azimuthDeg, e = p.elevationDeg;
  const axes = { ca: cosDeg(a), sa: sinDeg(a), ce: cosDeg(e), se: sinDeg(e) };
  // 整圈的半径与当前方位无关，只有固定视角求距时才将方位角计入缓存键。
  const orbit = p.view === 'orbit';
  const key = [...min, ...max, p.view, orbit ? 0 : p.azimuthDeg, p.elevationDeg, p.margin, p.fovYDeg, p.aspect];
  if (!last || !key.every((v, i) => Object.is(v, last.key[i]))) {
    const ky = p.margin * Math.tan(p.fovYDeg * Math.PI / 360);
    last = { key, distance: solve(min, max, target, axes, ky * p.aspect, ky, orbit) };
  }
  const distance = last.distance, h = distance * axes.ce;
  const pos = [target[0] + h * axes.sa, target[1] + distance * axes.se, target[2] + h * axes.ca];
  if (!pos.every(Number.isFinite)) bad('相机位置超出有限数范围');
  const sa = sinDeg(a / 2), ca = cosDeg(a / 2), se = sinDeg(e / 2), ce = cosDeg(e / 2);
  return { target, distance, camera: { pos, quat: [-ca * se, sa * ce, sa * se, ca * ce], fovDeg: p.fovYDeg } };
}
