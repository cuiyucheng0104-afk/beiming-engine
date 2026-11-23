import manifest from './card.json' with { type: 'json' };

// 数据卡也会直接装进页面，不能静态引 node:util。页面宿主在任何镜头模块之前登记 Proxy。
const node = globalThis.process;
const isProxy = node?.versions?.node ? (node.getBuiltinModule?.('node:util/types') ?? await import('node:util/types')).isProxy
  : globalThis[Symbol.for('beiming.three.isProxy')];
const bad = (field) => { throw Object.assign(new RangeError(`camera.drift：${field} 不是有效的镜头数据`), { code: 'usage.bad-argument' }); };
const paramsSpec = globalThis.structuredClone(manifest.params);
const inputsKeys = ['size', 'shot', 'fps', 'seed', 'events', 'bbox'];

// 先查描述符，后读数据；实例、Proxy、显式 undefined 与数组空槽都不是 JSON 声明。
function record(value, keys, field) {
  if (!value || typeof value !== 'object' || !isProxy || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) bad(field);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!keys.includes(key) || !d.enumerable || !Object.hasOwn(d, 'value') || d.value === undefined || isProxy(d.value)) bad(field);
  }
  return value;
}
function vector(v, n, field) {
  if (!isProxy || isProxy(v) || !Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length !== n || Reflect.ownKeys(v).length !== n + 1) bad(field);
  return Array.from({ length: n }, (_, i) => {
    const slot = Object.getOwnPropertyDescriptor(v, i);
    if (!slot?.enumerable || !Number.isFinite(slot.value)) bad(field);
    return slot.value;
  });
}

/** 帧号为镜头局部时间。镜头外的烘焙采样保持两端；单帧镜头没有推进。 */
export function evaluate(inputs, params, f, sub = 0) {
  record(inputs, inputsKeys, 'inputs');
  const { size, shot } = inputs;
  const [width, height] = vector(size, 2, 'size');
  const { frames } = record(shot, ['id', 'in', 'frames'], 'shot');
  if (![width, height, frames].every(n => Number.isSafeInteger(n) && n > 0)) bad('画幅或帧数');
  if (!Number.isSafeInteger(f) || !Number.isFinite(sub) || sub < 0 || sub >= 1) bad('f/sub');
  record(params, Object.keys(paramsSpec), 'params');
  const get = k => Object.hasOwn(params, k) ? params[k] : paramsSpec[k].default;
  function number(k) {
    const v = get(k), [min, max] = paramsSpec[k].range;
    if (!Number.isFinite(v) || v < min || v > max) bad(k);
    return v;
  }
  const mode = get('mode');
  if (mode !== 'locked' && mode !== 'linear') bad('mode');
  const start = vector(get('pos'), 3, 'pos'), pan = vector(get('pan'), 2, 'pan');
  const push = number('pushMeters'), zoom = number('zoom'), fov = number('fovYDeg');
  const rad = Math.PI / 180, yaw = number('yawDeg') * rad, pitch = number('pitchDeg') * rad;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  // Ry(yaw) Rx(pitch) 的三列；平移与推进用局部轴，不改变朝向。
  const right = [cy, 0, -sy], up = [sy * sp, cp, cy * sp], back = [sy * cp, -sp, cy * cp];
  const qy = yaw / 2, qx = pitch / 2;
  const quat = [Math.cos(qy) * Math.sin(qx), Math.sin(qy) * Math.cos(qx), -Math.sin(qy) * Math.sin(qx), Math.cos(qy) * Math.cos(qx)];
  const u = mode === 'locked' || frames === 1 ? 0 : Math.max(0, Math.min(1, (f + sub) / (frames - 1)));
  const pos = u === 0 || (!pan[0] && !pan[1] && !push) ? start : start.map((v, i) => v + right[i] * (pan[0] * u) + up[i] * (pan[1] * u) - back[i] * (push * u));
  if (!pos.every(Number.isFinite)) bad('位移超出数值范围');
  const mag = 1 + (zoom - 1) * u, fovDeg = mag === 1 ? fov : 2 * Math.atan(Math.tan(fov * rad / 2) / mag) / rad;
  const yScale = 1 / Math.tan(fovDeg * rad / 2), near = 0.1, far = 100;
  const world = [...right, 0, ...up, 0, ...back, 0, ...pos, 1];
  const proj = [yScale / (width / height), 0, 0, 0, 0, yScale, 0, 0, 0, 0, -(far + near) / (far - near), -1, 0, 0, -2 * near * far / (far - near), 0];
  return { camera: { pos, quat, fovDeg, world, proj } };
}
