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
function solve(min, max, target, { ca, sa, ce, se }, kx, ky, orbit) {
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
  // 最近角点的正深度要能与舍入噪声区分；随盒子一起缩放容差，保留小尺度侧视盒的解。
  if (!Number.isFinite(d) || !(d - nearest > Math.abs(nearest) * 1e-12)) bad('盒退化或尺度不可表示，没有八角都在相机前方的最小取景距离');
  return d;
}

// 宿主会逐帧调 evaluate，有的还会每帧重建 params。只记上一份数值键与不可变标量距离，
// 因而同一个静态设置只解一次；改过 bbox、乱序求帧、调用方改动上次的返回值都不会污染结果。
let last;
export function evaluate(inputs, params, f, sub = 0) {
  const p = argumentsOf(inputs, params, f, sub);
  fields(p.bbox, ['min', 'max']);
  const min = vector(p.bbox.min), max = vector(p.bbox.max);
  if (min.some((v, k) => v > max[k])) bad('bbox 各轴的 min 不得超过 max');
  if (p.view !== 'fixed' && p.view !== 'orbit') bad('view 只能是 fixed 或 orbit');
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
