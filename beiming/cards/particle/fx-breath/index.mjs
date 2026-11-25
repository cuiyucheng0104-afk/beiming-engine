// fx.breath（data 落点）：闭式指数阻尼吐息射流、光束、余烬与烟尘尾流求值器。
// 任意时刻 t 的粒子三维位置、尺寸、透明度权重与屏幕投影均由出生属性 aR 与闭式阻尼积分直接算出，无跨帧状态。

import { sampleSoftViewZ } from '../soft/three.js';

export const NOMINAL_DRAG = Object.freeze({
  fire: 2.6,
  emb: 1.1,
  smoke: 2.2,
});

function bad(message) {
  return Object.assign(new TypeError(message), { code: 'usage.bad-argument' });
}

function assertNum(x, name, min = -Infinity, max = Infinity) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) {
    throw bad(`Invalid ${name}`);
  }
  return x;
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const fract = (x) => x - Math.floor(x);
const mix = (a, b, t) => a + (b - a) * t;
const step = (edge, x) => (x < edge ? 0 : 1);
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

function norm3(x, y, z) {
  const l = Math.hypot(x, y, z);
  if (!(l > 1e-12)) throw bad('Zero-length direction vector');
  return [x / l, y / l, z / l];
}

function cross3(ax, ay, az, bx, by, bz) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

export function mulMat4Vec4(m, offset, x, y, z, w) {
  return [
    m[offset] * x + m[offset + 4] * y + m[offset + 8] * z + m[offset + 12] * w,
    m[offset + 1] * x + m[offset + 5] * y + m[offset + 9] * z + m[offset + 13] * w,
    m[offset + 2] * x + m[offset + 6] * y + m[offset + 10] * z + m[offset + 14] * w,
    m[offset + 3] * x + m[offset + 7] * y + m[offset + 11] * z + m[offset + 15] * w,
  ];
}

/** 闭式指数阻尼位移：dist = v0 * (1 - exp(-age * drag)) / drag，在 drag -> 0 处连续收敛到 v0 * age */
export function closedFormDragDistance(v0, age, drag) {
  const v = assertNum(v0, 'v0', 0);
  const a = assertNum(age, 'age', 0);
  const k = assertNum(drag, 'drag', 0);
  if (a === 0 || v === 0) return 0;
  const ka = k * a;
  if (ka < 1e-6) {
    return v * a * (1 - 0.5 * ka + (ka * ka) / 6);
  }
  return (v * (1 - Math.exp(-ka))) / k;
}

/** 构造射流方向的正交基 { dir, up, right } */
export function jetBasis(dir, refAxis = [0.37, 0.0, -0.93]) {
  if (!Array.isArray(dir) || dir.length !== 3) throw bad('Invalid dir');
  const [dx, dy, dz] = norm3(
    assertNum(dir[0], 'dir[0]'),
    assertNum(dir[1], 'dir[1]'),
    assertNum(dir[2], 'dir[2]'),
  );
  const c0 = cross3(dx, dy, dz, refAxis[0], refAxis[1], refAxis[2]);
  const up = norm3(c0[0], c0[1] + 0.001, c0[2]);
  const right = cross3(up[0], up[1], up[2], dx, dy, dz);
  return { dir: [dx, dy, dz], up, right };
}

/** 将世界坐标投影到屏幕像素坐标 [xPx, yPx, viewZ]；位于近平面后方时返回 null */
export function projectWorldPoint(viewMatrix, projMatrix, mOffset, worldPos, width, height) {
  const mv = mulMat4Vec4(viewMatrix, mOffset, worldPos[0], worldPos[1], worldPos[2], 1.0);
  if (mv[2] >= -0.1) return null;
  const clip = mulMat4Vec4(projMatrix, mOffset, mv[0], mv[1], mv[2], mv[3]);
  if (Math.abs(clip[3]) < 1e-6) return null;
  const xPx = ((clip[0] / clip[3]) * 0.5 + 0.5) * width;
  const yPx = (0.5 - (clip[1] / clip[3]) * 0.5) * height;
  return [xPx, yPx, mv[2]];
}

/** 生成确定性四维出生属性表 aR（每个粒子 4 个 [0, 1) 浮点数） */
export function makeDeterministicBirthAttributes(count, seed = 11) {
  const n = assertNum(count, 'count', 1, 65536);
  const s = assertNum(seed, 'seed', 0);
  const out = new Float32Array(n * 4);
  let state = (s | 0) || 1;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < n * 4; i++) out[i] = next();
  return out;
}

/** 求值主火舌/光束粒子点云及其屏幕投影质心（支持 dragScale 消融与任意帧随机访问） */
export function evaluateFireParticles(state, options = {}) {
  if (!state || typeof state !== 'object') throw bad('Invalid fire state');
  const dragScale = assertNum(options.dragScale ?? 1.0, 'dragScale', 1e-3, 100);
  const baseDrag = assertNum(state.drag ?? NOMINAL_DRAG.fire, 'drag', 1e-4, 100);
  const k = baseDrag * dragScale;
  const speedBase = assertNum(state.speedMps ?? 70.0, 'speedMps', 1e-3, 2000);
  const uTime = assertNum(state.uTime, 'uTime');
  const uRoar = assertNum(state.uRoar ?? 1.0, 'uRoar', 0, 10);
  const uLen = assertNum(state.uLen ?? 1e4, 'uLen', 0.1, 1e6);
  const uBeam = assertNum(state.uBeam ?? 0.0, 'uBeam', 0, 1);
  const uReach = assertNum(state.uReach ?? 1.0, 'uReach', 0.01, 50);
  const [mx, my, mz] = state.uMouth;
  const [dx, dy, dz] = state.uDir;
  const aR = state.aR;
  const n = Math.floor(aR.length / 4);
  const vm = state.viewMatrix;
  const pm = state.projMatrix;
  const mOff = state.matrixOffset ?? 0;
  const [W, H] = state.viewport ?? [1920, 1080];

  if (uRoar < 0.01) return { cx: NaN, cy: NaN, count: 0, particles: [] };

  const c0 = cross3(dx, dy, dz, 0.37, 0.0, -0.93);
  const up = norm3(c0[0], c0[1] + 0.001, c0[2]);
  const rt = cross3(up[0], up[1], up[2], dx, dy, dz);

  const particles = [];
  let sx = 0;
  let sy = 0;
  let cnt = 0;

  for (let i = 0; i < n; i++) {
    const a0 = aR[i * 4];
    const a1 = aR[i * 4 + 1];
    const a2 = aR[i * 4 + 2];
    const a3 = aR[i * 4 + 3];
    const life = (0.75 + 0.5 * a3) * mix(1.0, 0.6, uBeam);
    const age = fract(uTime / life + a0);
    const a = age * life;
    const ang = a1 * 6.283;
    const sp = Math.sqrt(a2) * mix(0.20, 0.15, uBeam);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const d = norm3(
      dx + (rt[0] * ca + up[0] * sa) * sp,
      dy + (rt[1] * ca + up[1] * sa) * sp,
      dz + (rt[2] * ca + up[2] * sa) * sp,
    );
    const v0 = speedBase * uReach * (0.6 + 0.4 * a3);
    const dist = mix((v0 * (1.0 - Math.exp(-a * k))) / k, age * uLen * 1.12, uBeam);
    const wob = mix(1.0, 0.5, uBeam);
    const lick = step(0.78, fract(a0 * 7.31 + a2 * 3.7));
    const a2w = age * age * 2.2 * wob;
    const wx = Math.sin(a * 9.0 + a0 * 40.0) * a2w;
    const wy = Math.cos(a * 7.0 + a1 * 40.0) * a2w + age * age * 4.5 * wob;
    const wz = Math.sin(a * 8.0 + a2 * 40.0) * a2w;
    const lScale = lick * age * mix(1.5, 2.6, uBeam);
    const sRt = Math.sin(uTime * 13.0 + a1 * 50.0);
    const cUp = Math.cos(uTime * 11.0 + a0 * 50.0);
    const lx = (rt[0] * sRt + up[0] * cUp) * lScale;
    const ly = (rt[1] * sRt + up[1] * cUp) * lScale;
    const lz = (rt[2] * sRt + up[2] * cUp) * lScale;

    const world = [mx + d[0] * dist + wx + lx, my + d[1] * dist + wy + ly, mz + d[2] * dist + wz + lz];
    const sizeM = mix(0.9, 7.0, Math.pow(age, 0.8)) * (0.7 + 0.6 * a2) * mix(1.0, 0.95, uBeam) * (1.0 + 0.10 * (uReach - 1.0));
    const vK = uRoar * smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(uLen * 0.90, uLen * 1.06, dist))
      * mix(1.0, 0.26, uBeam) * (1.0 + mix(0.8, 3.0, uBeam) * lick);

    let px = null;
    if (vm && pm) {
      const p = projectWorldPoint(vm, pm, mOff, world, W, H);
      if (p && p[0] >= 0 && p[0] < W && p[1] >= 0 && p[1] < H) {
        px = [p[0], p[1]];
        sx += p[0];
        sy += p[1];
        cnt++;
      }
    }
    particles.push({ slot: i, world, age: a, lifeNorm: age, sizeM, weight: vK, ...(px ? { px } : {}) });
  }
  return {
    cx: cnt > 0 ? sx / cnt : NaN,
    cy: cnt > 0 ? sy / cnt : NaN,
    count: cnt,
    particles,
  };
}

/** 求值尾流余烬粒子点云及其屏幕质心（标称 drag = 1.1） */
export function evaluateEmberParticles(state, options = {}) {
  if (!state || typeof state !== 'object') throw bad('Invalid ember state');
  const dragScale = assertNum(options.dragScale ?? 1.0, 'dragScale', 1e-3, 100);
  const k = (state.drag ?? NOMINAL_DRAG.emb) * dragScale;
  const uTime = assertNum(state.uTime, 'uTime');
  const uT0 = assertNum(state.uT0, 'uT0');
  const uSpan = assertNum(state.uSpan, 'uSpan', 1e-4);
  const emP = state.emP;
  const emD = state.emD;
  const emB = state.emB;
  const uFall = state.uFall ?? [0.6, 1.25];
  const aR = state.aR;
  const n = Math.floor(aR.length / 4);
  const vm = state.viewMatrix;
  const pm = state.projMatrix;
  const mOff = state.matrixOffset ?? 0;
  const [W, H] = state.viewport ?? [1920, 1080];

  const particles = [];
  let sx = 0;
  let sy = 0;
  let cnt = 0;

  for (let i = 0; i < n; i++) {
    const a0 = aR[i * 4];
    const a1 = aR[i * 4 + 1];
    const a2 = aR[i * 4 + 2];
    const a3 = aR[i * 4 + 3];
    const a = uTime - uT0 - a0 * uSpan;
    const life = 3.2 + 2.5 * a3;
    if (a < 0 || a > life) continue;
    const x = a0 * 11.0;
    const idx = Math.min(Math.floor(x), 10);
    const fr = x - idx;
    if (fract(a1 * 7.77 + a3 * 3.31) * 0.7 + 0.03 > mix(emB[idx], emB[idx + 1], fr)) continue;

    const ox = mix(emP[idx * 3], emP[(idx + 1) * 3], fr);
    const oy = mix(emP[idx * 3 + 1], emP[(idx + 1) * 3 + 1], fr);
    const oz = mix(emP[idx * 3 + 2], emP[(idx + 1) * 3 + 2], fr);
    const dj = norm3(
      mix(emD[idx * 3], emD[(idx + 1) * 3], fr),
      mix(emD[idx * 3 + 1], emD[(idx + 1) * 3 + 1], fr),
      mix(emD[idx * 3 + 2], emD[(idx + 1) * 3 + 2], fr),
    );
    const c0 = cross3(dj[0], dj[1], dj[2], 0.37, 0.0, -0.93);
    const up = norm3(c0[0], c0[1] + 0.001, c0[2]);
    const rt = cross3(up[0], up[1], up[2], dj[0], dj[1], dj[2]);
    const ang = a1 * 6.283;
    const sp = Math.sqrt(a2) * 0.55;
    const d = norm3(
      dj[0] + (rt[0] * Math.cos(ang) + up[0] * Math.sin(ang)) * sp,
      dj[1] + (rt[1] * Math.cos(ang) + up[1] * Math.sin(ang)) * sp,
      dj[2] + (rt[2] * Math.cos(ang) + up[2] * Math.sin(ang)) * sp,
    );
    const v0 = 46.0 * (0.5 + 0.5 * a3);
    const dist = (v0 * (1 - Math.exp(-a * k))) / k;
    const wx = Math.sin(a * 2.3 + a0 * 30.0) * a * 1.4;
    const wy = a * uFall[0] - a * a * uFall[1];
    const wz = Math.cos(a * 1.9 + a1 * 30.0) * a * 1.4;
    const world = [ox + d[0] * dist + wx, oy + d[1] * dist + wy, oz + d[2] * dist + wz];
    const sizeM = (0.10 + 0.22 * a2) * (1.0 + 0.5 * Math.sin(a * 17.0 + a0 * 50.0));
    const vA = (1.0 - a / life) * (0.6 + 0.4 * Math.sin(a * 23.0 + a2 * 60.0));

    let px = null;
    if (vm && pm) {
      const p = projectWorldPoint(vm, pm, mOff, world, W, H);
      if (p && p[0] >= 0 && p[0] < W && p[1] >= 0 && p[1] < H) {
        px = [p[0], p[1]];
        sx += p[0];
        sy += p[1];
        cnt++;
      }
    }
    particles.push({ slot: i, world, age: a, sizeM, weight: vA, ...(px ? { px } : {}) });
  }
  return {
    cx: cnt > 0 ? sx / cnt : NaN,
    cy: cnt > 0 ? sy / cnt : NaN,
    count: cnt,
    particles,
  };
}

/** 求值尾流烟尘粒子点云及其屏幕质心（标称 drag = 2.2） */
export function evaluateSmokeParticles(state, options = {}) {
  if (!state || typeof state !== 'object') throw bad('Invalid smoke state');
  const dragScale = assertNum(options.dragScale ?? 1.0, 'dragScale', 1e-3, 100);
  const k = (state.drag ?? NOMINAL_DRAG.smoke) * dragScale;
  const uTime = assertNum(state.uTime, 'uTime');
  const uT0 = assertNum(state.uT0, 'uT0');
  const uSpan = assertNum(state.uSpan, 'uSpan', 1e-4);
  const uSR = assertNum(state.uSR ?? 1.0, 'uSR', 0.01);
  const uSK = state.uSK ?? [1.2, 0.9, 1.0];
  const emP = state.emP;
  const emD = state.emD;
  const emB = state.emB;
  const aR = state.aR;
  const n = Math.floor(aR.length / 4);
  const vm = state.viewMatrix;
  const pm = state.projMatrix;
  const mOff = state.matrixOffset ?? 0;
  const [W, H] = state.viewport ?? [1920, 1080];

  const particles = [];
  let sx = 0;
  let sy = 0;
  let cnt = 0;

  for (let i = 0; i < n; i++) {
    const a0 = aR[i * 4];
    const a1 = aR[i * 4 + 1];
    const a2 = aR[i * 4 + 2];
    const a3 = aR[i * 4 + 3];
    const a = uTime - uT0 - a0 * uSpan;
    const life = (2.8 + 1.7 * a3) * uSK[2];
    const lf = clamp(a / life, 0, 1);
    const x = a0 * 11.0;
    const idx = Math.min(Math.floor(x), 10);
    const fr = x - idx;
    const vA = step(0, a) * smoothstep(0.13, 0.30, lf) * (1 - smoothstep(0.5, 1, lf))
      * smoothstep(0.05, 0.45, mix(emB[idx], emB[idx + 1], fr));
    if (vA <= 0) continue;

    const ox = mix(emP[idx * 3], emP[(idx + 1) * 3], fr);
    const oy = mix(emP[idx * 3 + 1], emP[(idx + 1) * 3 + 1], fr);
    const oz = mix(emP[idx * 3 + 2], emP[(idx + 1) * 3 + 2], fr);
    const dj = norm3(
      mix(emD[idx * 3], emD[(idx + 1) * 3], fr),
      mix(emD[idx * 3 + 1], emD[(idx + 1) * 3 + 1], fr),
      mix(emD[idx * 3 + 2], emD[(idx + 1) * 3 + 2], fr),
    );
    const c0 = cross3(dj[0], dj[1], dj[2], 0.37, 0.0, -0.93);
    const up = norm3(c0[0], c0[1] + 0.001, c0[2]);
    const rt = cross3(up[0], up[1], up[2], dj[0], dj[1], dj[2]);
    const ang = a1 * 6.283;
    const sp = 0.08 + Math.sqrt(a2) * 0.22;
    const d = norm3(
      dj[0] + (rt[0] * Math.cos(ang) + up[0] * Math.sin(ang)) * sp,
      dj[1] + (rt[1] * Math.cos(ang) + up[1] * Math.sin(ang)) * sp,
      dj[2] + (rt[2] * Math.cos(ang) + up[2] * Math.sin(ang)) * sp,
    );
    const dist = (62.0 * uSR * (0.6 + 0.4 * a3) * (1 - Math.exp(-a * k))) / k;
    const wx = Math.sin(a * 1.6 + a0 * 40.0) * a * 1.3;
    const wy = a * uSK[0] + a * a * uSK[1];
    const wz = Math.cos(a * 1.3 + a1 * 40.0) * a * 1.3;
    const world = [ox + d[0] * dist + wx, oy + d[1] * dist + wy, oz + d[2] * dist + wz];
    const sizeM = mix(1.6, 9.5, Math.sqrt(lf)) * (0.7 + 0.6 * a2) * (1.0 + 0.25 * (uSR - 1.0));

    let px = null;
    if (vm && pm) {
      const p = projectWorldPoint(vm, pm, mOff, world, W, H);
      if (p && p[0] >= 0 && p[0] < W && p[1] >= 0 && p[1] < H) {
        px = [p[0], p[1]];
        sx += p[0];
        sy += p[1];
        cnt++;
      }
    }
    particles.push({ slot: i, world, age: a, lifeNorm: lf, sizeM, weight: vA, ...(px ? { px } : {}) });
  }
  return {
    cx: cnt > 0 ? sx / cnt : NaN,
    cy: cnt > 0 ? sy / cnt : NaN,
    count: cnt,
    particles,
  };
}

/** 计算二维图像缓冲（像素中心 x+0.5, y+0.5）的能量加权质心 */
export function computeBufferCentroid(arr, offset, W, H, threshold = 0) {
  let sx = 0;
  let sy = 0;
  let sw = 0;
  let active = 0;
  for (let y = 0; y < H; y++) {
    const row = offset + y * W;
    for (let x = 0; x < W; x++) {
      const v = arr[row + x];
      if (v > threshold) {
        sx += (x + 0.5) * v;
        sy += (y + 0.5) * v;
        sw += v;
        active++;
      }
    }
  }
  return { cx: sw > 0 ? sx / sw : NaN, cy: sw > 0 ? sy / sw : NaN, totalWeight: sw, activePixels: active };
}

function samplePuff(puff, u, v) {
  const ix = clamp(Math.floor(u * 256), 0, 255);
  const iy = clamp(Math.floor(v * 256), 0, 255);
  const o = (iy * 256 + ix) * 4;
  return [puff[o] / 255, puff[o + 3] / 255];
}

/** 16×16 公告板求积 + 软深度衰减计算主火舌屏幕能量质心（支持 dragScale 消融） */
export function computeFireRasterCentroid(p, fi, vzBuf, vzOff, W, H, { dragScale = 1.0 } = {}) {
  const k = NOMINAL_DRAG.fire * assertNum(dragScale, 'dragScale', 1e-3, 100);
  const uTime = p.fire_uTime.data[fi];
  const uRoar = p.fire_uRoar.data[fi];
  const uLen = p.fire_uLen.data[fi];
  const uBeam = p.fire_uBeam.data[fi];
  const uReach = p.fire_uReach.data[fi];
  const mx = p.fire_uMouth.data[fi * 3];
  const my = p.fire_uMouth.data[fi * 3 + 1];
  const mz = p.fire_uMouth.data[fi * 3 + 2];
  const dx = p.fire_uDir.data[fi * 3];
  const dy = p.fire_uDir.data[fi * 3 + 1];
  const dz = p.fire_uDir.data[fi * 3 + 2];
  const aR = p.fire_aR.data;
  const n = p.fire_aR.shape[0];
  const puff = p.tPuff_rgba8.data;
  const vm = p.view_matrix.data;
  const pm = p.proj_matrix.data;
  const mOff = fi * 16;

  if (uRoar < 0.01) return { cx: NaN, cy: NaN, count: 0 };

  const c0 = cross3(dx, dy, dz, 0.37, 0.0, -0.93);
  const up = norm3(c0[0], c0[1] + 0.001, c0[2]);
  const rt = cross3(up[0], up[1], up[2], dx, dy, dz);

  let sx = 0;
  let sy = 0;
  let sw = 0;
  let active = 0;
  const NQ = 16;

  for (let i = 0; i < n; i++) {
    const a0 = aR[i * 4];
    const a1 = aR[i * 4 + 1];
    const a2 = aR[i * 4 + 2];
    const a3 = aR[i * 4 + 3];
    const life = (0.75 + 0.5 * a3) * mix(1.0, 0.6, uBeam);
    const age = fract(uTime / life + a0);
    const a = age * life;
    const ang = a1 * 6.283;
    const sp = Math.sqrt(a2) * mix(0.20, 0.15, uBeam);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const d = norm3(
      dx + (rt[0] * ca + up[0] * sa) * sp,
      dy + (rt[1] * ca + up[1] * sa) * sp,
      dz + (rt[2] * ca + up[2] * sa) * sp,
    );
    const v0 = 70.0 * uReach * (0.6 + 0.4 * a3);
    const dist = mix((v0 * (1.0 - Math.exp(-a * k))) / k, age * uLen * 1.12, uBeam);
    const wob = mix(1.0, 0.5, uBeam);
    const lick = step(0.78, fract(a0 * 7.31 + a2 * 3.7));
    const a2w = age * age * 2.2 * wob;
    let cx = mx + d[0] * dist + Math.sin(a * 9.0 + a0 * 40.0) * a2w;
    let cy = my + d[1] * dist + Math.cos(a * 7.0 + a1 * 40.0) * a2w + age * age * 4.5 * wob;
    let cz = mz + d[2] * dist + Math.sin(a * 8.0 + a2 * 40.0) * a2w;
    const lScale = lick * age * mix(1.5, 2.6, uBeam);
    const sRt = Math.sin(uTime * 13.0 + a1 * 50.0);
    const cUp = Math.cos(uTime * 11.0 + a0 * 50.0);
    cx += (rt[0] * sRt + up[0] * cUp) * lScale;
    cy += (rt[1] * sRt + up[1] * cUp) * lScale;
    cz += (rt[2] * sRt + up[2] * cUp) * lScale;

    const sz = mix(0.9, 7.0, Math.pow(age, 0.8)) * (0.7 + 0.6 * a2) * mix(1.0, 0.95, uBeam) * (1.0 + 0.10 * (uReach - 1.0));
    const mv = mulMat4Vec4(vm, mOff, cx, cy, cz, 1.0);
    if (mv[2] >= -0.1) continue;
    const fd = mulMat4Vec4(vm, mOff, d[0], d[1], d[2], 0.0);
    const fl = Math.hypot(fd[0], fd[1]);
    const fdx = fl > 1e-4 ? fd[0] / fl : 1.0;
    const fdy = fl > 1e-4 ? fd[1] / fl : 0.0;
    const rot = a0 * 6.283 + a * 2.0;
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);

    const vK = uRoar * smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(uLen * 0.90, uLen * 1.06, dist))
      * mix(1.0, 0.26, uBeam) * (1.0 + mix(0.8, 3.0, uBeam) * lick);
    const vCore = (1.0 - smoothstep(0.0, 0.24, age)) * (1.0 - Math.sqrt(a2)) * (1.0 - lick);
    const s0 = smoothstep(0.0, 0.30, age);
    const s1 = smoothstep(0.30, 0.85, age);
    const r = mix(mix(4.2, 3.0, s0), 0.9, s1) + 7.0 * vCore;
    const g = mix(mix(2.3, 0.62, s0), 0.06, s1) + 5.2 * vCore;
    const b = mix(mix(0.7, 0.06, s0), 0.015, s1) + 2.6 * vCore;
    const lum = r + g + b;
    const fade = 1.0 - smoothstep(0.55, 1.0, age);
    const areaFactor = (sz / -mv[2]) ** 2 * (lick > 0.5 ? (2.4 + 1.2 * a3) * fl * 0.62 : 1.0);
    const baseW = lum * fade * vK * areaFactor;
    if (baseW <= 0) continue;

    let anyIn = false;
    for (let j = 0; j < NQ; j++) {
      const qy = (j + 0.5) / NQ - 0.5;
      for (let qk = 0; qk < NQ; qk++) {
        const qx = (qk + 0.5) / NQ - 0.5;
        const [tr, ta] = samplePuff(puff, qx + 0.5, qy + 0.5);
        const puffW = ta * (0.10 + 2.3 * tr * tr * tr);
        if (puffW <= 0) continue;
        const rqx = qx * cr - qy * sr;
        const rqy = qx * sr + qy * cr;
        const lqx = fdx * qx * (2.4 + 1.2 * a3) * fl - fdy * qy * 0.62;
        const lqy = fdy * qx * (2.4 + 1.2 * a3) * fl + fdx * qy * 0.62;
        const ox = mix(rqx, lqx, lick) * sz;
        const oy = mix(rqy, lqy, lick) * sz;
        const clip = mulMat4Vec4(pm, mOff, mv[0] + ox, mv[1] + oy, mv[2], mv[3]);
        const xPx = ((clip[0] / clip[3]) * 0.5 + 0.5) * W;
        const yPx = (0.5 - (clip[1] / clip[3]) * 0.5) * H;
        if (xPx < 0 || xPx >= W || yPx < 0 || yPx >= H) continue;
        const zSoft = sampleSoftViewZ(vzBuf, vzOff, W, H, xPx, yPx, mv[2], 3.0);
        const w = baseW * puffW * zSoft;
        if (w > 0) {
          sx += xPx * w;
          sy += yPx * w;
          sw += w;
          anyIn = true;
        }
      }
    }
    if (anyIn) active++;
  }
  return { cx: sw > 0 ? sx / sw : NaN, cy: sw > 0 ? sy / sw : NaN, count: active };
}

/** 像素中心光栅化 + 软深度衰减计算余烬屏幕能量质心（支持 dragScale 消融） */
export function computeEmberRasterCentroid(p, fi, vzBuf, vzOff, W, H, { dragScale = 1.0 } = {}) {
  const kDrag = NOMINAL_DRAG.emb * assertNum(dragScale, 'dragScale', 1e-3, 100);
  const uTime = p.fire_uTime.data[fi];
  const uT0 = p.wake_uT0.data[0];
  const uSpan = p.wake_uSpan.data[0];
  const emP = p.wake_uEmP.data;
  const emD = p.wake_uEmD.data;
  const emB = p.wake_uEmB.data;
  const uFall = p.wake_uFall.data;
  const aR = p.emb_aR.data;
  const n = p.emb_aR.shape[0];
  const vm = p.view_matrix.data;
  const pm = p.proj_matrix.data;
  const mOff = fi * 16;

  let sx = 0;
  let sy = 0;
  let sw = 0;
  let active = 0;

  for (let i = 0; i < n; i++) {
    const a0 = aR[i * 4];
    const a1 = aR[i * 4 + 1];
    const a2 = aR[i * 4 + 2];
    const a3 = aR[i * 4 + 3];
    const a = uTime - uT0 - a0 * uSpan;
    const life = 3.2 + 2.5 * a3;
    let k = step(0.0, a) * step(a, life);
    if (k < 0.5) continue;

    const x = a0 * 11.0;
    const idx = Math.min(Math.floor(x), 10);
    const f = x - idx;
    const ox = mix(emP[idx * 3], emP[(idx + 1) * 3], f);
    const oy = mix(emP[idx * 3 + 1], emP[(idx + 1) * 3 + 1], f);
    const oz = mix(emP[idx * 3 + 2], emP[(idx + 1) * 3 + 2], f);
    const dj = norm3(
      mix(emD[idx * 3], emD[(idx + 1) * 3], f),
      mix(emD[idx * 3 + 1], emD[(idx + 1) * 3 + 1], f),
      mix(emD[idx * 3 + 2], emD[(idx + 1) * 3 + 2], f),
    );
    k *= step(fract(a1 * 7.77 + a3 * 3.31) * 0.7 + 0.03, mix(emB[idx], emB[idx + 1], f));
    if (k < 0.5) continue;

    const c0 = cross3(dj[0], dj[1], dj[2], 0.37, 0.0, -0.93);
    const up = norm3(c0[0], c0[1] + 0.001, c0[2]);
    const rt = cross3(up[0], up[1], up[2], dj[0], dj[1], dj[2]);
    const ang = a1 * 6.283;
    const sp = Math.sqrt(a2) * 0.55;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const d = norm3(
      dj[0] + (rt[0] * ca + up[0] * sa) * sp,
      dj[1] + (rt[1] * ca + up[1] * sa) * sp,
      dj[2] + (rt[2] * ca + up[2] * sa) * sp,
    );
    const v0 = 46.0 * (0.5 + 0.5 * a3);
    const dist = (v0 * (1.0 - Math.exp(-a * kDrag))) / kDrag;
    const cx = ox + d[0] * dist + Math.sin(a * 2.3 + a0 * 30.0) * a * 1.4;
    const cy = oy + d[1] * dist + a * uFall[0] - a * a * uFall[1];
    const cz = oz + d[2] * dist + Math.cos(a * 1.9 + a1 * 30.0) * a * 1.4;
    const sz = (0.10 + 0.22 * a2) * (1.0 + 0.5 * Math.sin(a * 17.0 + a0 * 50.0));
    const vA = k * (1.0 - a / life) * (0.6 + 0.4 * Math.sin(a * 23.0 + a2 * 60.0));
    if (vA <= 0) continue;

    const mv = mulMat4Vec4(vm, mOff, cx, cy, cz, 1.0);
    if (mv[2] >= -0.1) continue;
    const cClip = mulMat4Vec4(pm, mOff, mv[0], mv[1], mv[2], mv[3]);
    const cNdcX = cClip[0] / cClip[3];
    const cNdcY = cClip[1] / cClip[3];
    const scaleX = (pm[mOff] * sz) / -mv[2];
    const scaleY = (pm[mOff + 5] * sz) / -mv[2];
    const halfW = Math.abs(scaleX) * 0.5 * W * 0.5;
    const halfH = Math.abs(scaleY) * 0.5 * H * 0.5;
    const cxPx = (cNdcX * 0.5 + 0.5) * W;
    const cyPx = (0.5 - cNdcY * 0.5) * H;
    const x0 = Math.max(0, Math.floor(cxPx - halfW - 1));
    const x1 = Math.min(W - 1, Math.ceil(cxPx + halfW + 1));
    const y0 = Math.max(0, Math.floor(cyPx - halfH - 1));
    const y1 = Math.min(H - 1, Math.ceil(cyPx + halfH + 1));
    if (x0 > x1 || y0 > y1) continue;

    let anyIn = false;
    for (let py = y0; py <= y1; py++) {
      const ndcY = 1.0 - ((py + 0.5) / H) * 2.0;
      const qy = (ndcY - cNdcY) / scaleY;
      if (qy < -0.5 || qy > 0.5) continue;
      for (let px = x0; px <= x1; px++) {
        const ndcX = ((px + 0.5) / W) * 2.0 - 1.0;
        const qx = (ndcX - cNdcX) / scaleX;
        if (qx < -0.5 || qx > 0.5) continue;
        const aDisk = smoothstep(1.0, 0.0, Math.hypot(qx, qy) * 2.0);
        if (aDisk <= 0) continue;
        const zSoft = sampleSoftViewZ(vzBuf, vzOff, W, H, px + 0.5, py + 0.5, mv[2], 1.5);
        const w = vA * aDisk * aDisk * zSoft;
        if (w > 0) {
          sx += (px + 0.5) * w;
          sy += (py + 0.5) * w;
          sw += w;
          anyIn = true;
        }
      }
    }
    if (anyIn) active++;
  }
  return { cx: sw > 0 ? sx / sw : NaN, cy: sw > 0 ? sy / sw : NaN, count: active };
}

/** 半分辨率 Porter-Duff 预乘遮挡累积 + 软深度衰减计算浓烟屏幕质心（支持 dragScale 消融） */
export function computeSmokeRasterCentroid(p, fi, vzBuf, vzOff, W, H, { dragScale = 1.0 } = {}) {
  const kDrag = NOMINAL_DRAG.smoke * assertNum(dragScale, 'dragScale', 1e-3, 100);
  const uTime = p.fire_uTime.data[fi];
  const uT0 = p.wake_uT0.data[0];
  const uSpan = p.wake_uSpan.data[0];
  const uSR = p.wake_uSR.data[0];
  const uSK = p.wake_uSK.data;
  const uGain = p.wake_uGain.data[0];
  const emP = p.wake_uEmP.data;
  const emD = p.wake_uEmD.data;
  const emB = p.wake_uEmB.data;
  const aR = p.smoke_aR.data;
  const n = p.smoke_aR.shape[0];
  const puff = p.tPuff_rgba8.data;
  const vm = p.view_matrix.data;
  const pm = p.proj_matrix.data;
  const mOff = fi * 16;

  const SW = W >> 1;
  const SH = H >> 1;
  const accAlpha = new Float32Array(SW * SH);
  let active = 0;

  for (let i = 0; i < n; i++) {
    const a0 = aR[i * 4];
    const a1 = aR[i * 4 + 1];
    const a2 = aR[i * 4 + 2];
    const a3 = aR[i * 4 + 3];
    const a = uTime - uT0 - a0 * uSpan;
    const life = (2.8 + 1.7 * a3) * uSK[2];
    const lf = clamp(a / life, 0.0, 1.0);
    const x = a0 * 11.0;
    const idx = Math.min(Math.floor(x), 10);
    const f = x - idx;
    const vA = step(0.0, a) * smoothstep(0.13, 0.30, lf) * (1.0 - smoothstep(0.5, 1.0, lf))
      * smoothstep(0.05, 0.45, mix(emB[idx], emB[idx + 1], f));
    if (vA <= 0) continue;

    const ox = mix(emP[idx * 3], emP[(idx + 1) * 3], f);
    const oy = mix(emP[idx * 3 + 1], emP[(idx + 1) * 3 + 1], f);
    const oz = mix(emP[idx * 3 + 2], emP[(idx + 1) * 3 + 2], f);
    const dj = norm3(
      mix(emD[idx * 3], emD[(idx + 1) * 3], f),
      mix(emD[idx * 3 + 1], emD[(idx + 1) * 3 + 1], f),
      mix(emD[idx * 3 + 2], emD[(idx + 1) * 3 + 2], f),
    );
    const c0 = cross3(dj[0], dj[1], dj[2], 0.37, 0.0, -0.93);
    const up = norm3(c0[0], c0[1] + 0.001, c0[2]);
    const rt = cross3(up[0], up[1], up[2], dj[0], dj[1], dj[2]);
    const ang = a1 * 6.283;
    const sp = 0.08 + Math.sqrt(a2) * 0.22;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const d = norm3(
      dj[0] + (rt[0] * ca + up[0] * sa) * sp,
      dj[1] + (rt[1] * ca + up[1] * sa) * sp,
      dj[2] + (rt[2] * ca + up[2] * sa) * sp,
    );
    const dist = (62.0 * uSR * (0.6 + 0.4 * a3) * (1.0 - Math.exp(-a * kDrag))) / kDrag;
    const cx = ox + d[0] * dist + Math.sin(a * 1.6 + a0 * 40.0) * a * 1.3;
    const cy = oy + d[1] * dist + a * uSK[0] + a * a * uSK[1];
    const cz = oz + d[2] * dist + Math.cos(a * 1.3 + a1 * 40.0) * a * 1.3;
    const sz = mix(1.6, 9.5, Math.sqrt(lf)) * (0.7 + 0.6 * a2) * (1.0 + 0.25 * (uSR - 1.0));
    const rot = a0 * 6.283 + a * 0.5 * (a2 - 0.5);
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);

    const mv = mulMat4Vec4(vm, mOff, cx, cy, cz, 1.0);
    if (mv[2] >= -0.1) continue;
    const farFade = smoothstep(4.0, 18.0, -mv[2]);
    if (farFade <= 0) continue;

    let minX = SW;
    let maxX = -1;
    let minY = SH;
    let maxY = -1;
    for (const qy of [-0.5, 0.5]) {
      for (const qx of [-0.5, 0.5]) {
        const rqx = qx * cr - qy * sr;
        const rqy = qx * sr + qy * cr;
        const clip = mulMat4Vec4(pm, mOff, mv[0] + rqx * sz, mv[1] + rqy * sz, mv[2], mv[3]);
        const sxp = ((clip[0] / clip[3]) * 0.5 + 0.5) * SW;
        const syp = (0.5 - (clip[1] / clip[3]) * 0.5) * SH;
        if (sxp < minX) minX = sxp;
        if (sxp > maxX) maxX = sxp;
        if (syp < minY) minY = syp;
        if (syp > maxY) maxY = syp;
      }
    }
    const x0 = Math.max(0, Math.floor(minX));
    const x1 = Math.min(SW - 1, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(SH - 1, Math.ceil(maxY));
    if (x0 > x1 || y0 > y1) continue;
    active++;

    const cClip = mulMat4Vec4(pm, mOff, mv[0], mv[1], mv[2], mv[3]);
    const cNdcX = cClip[0] / cClip[3];
    const cNdcY = cClip[1] / cClip[3];
    const scaleX = (pm[mOff] * sz) / -mv[2];
    const scaleY = (pm[mOff + 5] * sz) / -mv[2];

    for (let syi = y0; syi <= y1; syi++) {
      const ndcY = 1.0 - ((syi + 0.5) / SH) * 2.0;
      const rqy = (ndcY - cNdcY) / scaleY;
      const fy = Math.min(H - 1, syi * 2);
      for (let sxi = x0; sxi <= x1; sxi++) {
        const ndcX = ((sxi + 0.5) / SW) * 2.0 - 1.0;
        const rqx = (ndcX - cNdcX) / scaleX;
        const qx = rqx * cr + rqy * sr;
        const qy = -rqx * sr + rqy * cr;
        if (qx < -0.5 || qx > 0.5 || qy < -0.5 || qy > 0.5) continue;
        const [, ta] = samplePuff(puff, qx + 0.5, qy + 0.5);
        if (ta <= 0) continue;
        const fx = Math.min(W - 1, sxi * 2);
        const szV = vzBuf[vzOff + fy * W + fx];
        const zSoft = clamp((mv[2] - szV) / 3.5, 0, 1);
        const aFrag = ta * vA * uGain * zSoft * farFade;
        if (aFrag > 0) {
          const pIdx = syi * SW + sxi;
          accAlpha[pIdx] = Math.min(1.0, accAlpha[pIdx] * (1.0 - aFrag) + aFrag);
        }
      }
    }
  }
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const w = accAlpha[y * SW + x];
      if (w > 1e-4) {
        sx += (x * 2 + 1.0) * w;
        sy += (y * 2 + 1.0) * w;
        sw += w;
      }
    }
  }
  return { cx: sw > 0 ? sx / sw : NaN, cy: sw > 0 ? sy / sw : NaN, count: active };
}

/** 对整套粒子数据集计算给定 dragScale 下的三层屏幕位置 RMSE 与质心偏移（单位：px） */
export function evaluateDragAblation(p, checkFrames, dragScale) {
  const mult = assertNum(dragScale, 'dragScale', 1e-3, 100);
  const W = p.viewport.data[0];
  const H = p.viewport.data[1];
  const allFrames = Array.from(p.frames.data);
  const out = { fire: [], emb: [], smoke: [] };

  for (const f of checkFrames) {
    const fi = allFrames.indexOf(f);
    if (fi < 0) throw bad(`Frame ${f} missing in particles dataset`);
    const vm = p.view_matrix.data;
    const pm = p.proj_matrix.data;
    const mOff = fi * 16;
    const uTime = p.fire_uTime.data[fi];

    const fireState = {
      uTime,
      uRoar: p.fire_uRoar.data[fi],
      uLen: p.fire_uLen.data[fi],
      uBeam: p.fire_uBeam.data[fi],
      uReach: p.fire_uReach.data[fi],
      uMouth: [p.fire_uMouth.data[fi * 3], p.fire_uMouth.data[fi * 3 + 1], p.fire_uMouth.data[fi * 3 + 2]],
      uDir: [p.fire_uDir.data[fi * 3], p.fire_uDir.data[fi * 3 + 1], p.fire_uDir.data[fi * 3 + 2]],
      aR: p.fire_aR.data,
      viewMatrix: vm,
      projMatrix: pm,
      matrixOffset: mOff,
      viewport: [W, H],
    };
    const f0 = evaluateFireParticles(fireState, { dragScale: 1.0 });
    const f1 = evaluateFireParticles(fireState, { dragScale: mult });
    if (f0.count > 0) {
      let sumSq = 0;
      let cnt = 0;
      let sx0 = 0;
      let sy0 = 0;
      let sx1 = 0;
      let sy1 = 0;
      for (let i = 0; i < f0.particles.length; i++) {
        const p0 = f0.particles[i].px;
        const p1 = projectWorldPoint(vm, pm, mOff, f1.particles[i].world, W, H);
        if (!p0 || !p1) continue;
        const sh = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        sumSq += sh * sh;
        sx0 += p0[0];
        sy0 += p0[1];
        sx1 += p1[0];
        sy1 += p1[1];
        cnt++;
      }
      if (cnt > 0) {
        out.fire.push({
          frame: f,
          rmsePx: Math.sqrt(sumSq / cnt),
          centroidShiftPx: Math.hypot(sx1 / cnt - sx0 / cnt, sy1 / cnt - sy0 / cnt),
        });
      }
    }

    const wakeBase = {
      uTime,
      uT0: p.wake_uT0.data[0],
      uSpan: p.wake_uSpan.data[0],
      uSR: p.wake_uSR.data[0],
      uSK: p.wake_uSK.data,
      uFall: p.wake_uFall.data,
      emP: p.wake_uEmP.data,
      emD: p.wake_uEmD.data,
      emB: p.wake_uEmB.data,
      viewMatrix: vm,
      projMatrix: pm,
      matrixOffset: mOff,
      viewport: [W, H],
    };

    const e0 = evaluateEmberParticles({ ...wakeBase, aR: p.emb_aR.data }, { dragScale: 1.0 });
    const e1 = evaluateEmberParticles({ ...wakeBase, aR: p.emb_aR.data }, { dragScale: mult });
    if (e0.count > 0) {
      let sumSq = 0;
      let cnt = 0;
      let sx0 = 0;
      let sy0 = 0;
      let sx1 = 0;
      let sy1 = 0;
      for (let i = 0; i < e0.particles.length; i++) {
        const p0 = e0.particles[i].px;
        const p1 = projectWorldPoint(vm, pm, mOff, e1.particles[i].world, W, H);
        if (!p0 || !p1) continue;
        const sh = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        sumSq += sh * sh;
        sx0 += p0[0];
        sy0 += p0[1];
        sx1 += p1[0];
        sy1 += p1[1];
        cnt++;
      }
      if (cnt > 0) {
        out.emb.push({
          frame: f,
          rmsePx: Math.sqrt(sumSq / cnt),
          centroidShiftPx: Math.hypot(sx1 / cnt - sx0 / cnt, sy1 / cnt - sy0 / cnt),
        });
      }
    }

    const s0 = evaluateSmokeParticles({ ...wakeBase, aR: p.smoke_aR.data }, { dragScale: 1.0 });
    const s1 = evaluateSmokeParticles({ ...wakeBase, aR: p.smoke_aR.data }, { dragScale: mult });
    if (s0.count > 0) {
      let sumSq = 0;
      let cnt = 0;
      let sx0 = 0;
      let sy0 = 0;
      let sx1 = 0;
      let sy1 = 0;
      for (let i = 0; i < s0.particles.length; i++) {
        const p0 = s0.particles[i].px;
        const p1 = projectWorldPoint(vm, pm, mOff, s1.particles[i].world, W, H);
        if (!p0 || !p1) continue;
        const sh = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        sumSq += sh * sh;
        sx0 += p0[0];
        sy0 += p0[1];
        sx1 += p1[0];
        sy1 += p1[1];
        cnt++;
      }
      if (cnt > 0) {
        out.smoke.push({
          frame: f,
          rmsePx: Math.sqrt(sumSq / cnt),
          centroidShiftPx: Math.hypot(sx1 / cnt - sx0 / cnt, sy1 / cnt - sy0 / cnt),
        });
      }
    }
  }
  return out;
}

function parseFps(fps) {
  if (typeof fps === 'string') {
    const m = /^(\d+)\/(\d+)$/.exec(fps);
    if (!m || Number(m[2]) === 0) throw bad('Invalid fps');
    return Number(m[1]) / Number(m[2]);
  }
  return assertNum(fps ?? 60, 'fps', 1e-3, 10000);
}

export function evaluate(ctx, params, frame = ctx?.frame ?? 0, sub = ctx?.sub ?? 0) {
  if (!ctx || typeof ctx !== 'object') throw bad('Invalid ctx');
  const spec = params?.spec;
  if (!spec || typeof spec !== 'object') throw bad('Missing params.spec');
  const count = assertNum(spec.count ?? 64, 'spec.count', 1, 4096);
  if (!Number.isInteger(count)) throw bad('spec.count must be integer');
  const seed = assertNum(spec.seed ?? 11, 'spec.seed', 0, 1000000);
  const mouth = spec.mouth ?? [-8, 1.5, 0];
  const direction = spec.direction ?? [0.95, 0.1, 0.29];
  if (!Array.isArray(mouth) || mouth.length !== 3 || !mouth.every(Number.isFinite)) throw bad('Invalid spec.mouth');
  if (!Array.isArray(direction) || direction.length !== 3 || !direction.every(Number.isFinite)) throw bad('Invalid spec.direction');
  norm3(direction[0], direction[1], direction[2]);

  const roar = assertNum(spec.roar ?? 0.85, 'spec.roar', 0, 4);
  const beam = assertNum(spec.beam ?? 0, 'spec.beam', 0, 1);
  const beamLengthM = assertNum(spec.beamLengthM ?? 30, 'spec.beamLengthM', 0.1, 100000);
  const reach = assertNum(spec.reach ?? 1.4, 'spec.reach', 0.01, 20);
  const drag = assertNum(spec.drag ?? NOMINAL_DRAG.fire, 'spec.drag', 1e-4, 50);
  const speedMps = assertNum(spec.speedMps ?? 70.0, 'spec.speedMps', 0.1, 1000);

  const fps = parseFps(ctx.fps ?? 60);
  const f = assertNum(frame, 'frame');
  const s = assertNum(sub, 'sub', 0, 1);
  const uTime = assertNum(ctx.time ?? ctx.uTime ?? (f + s) / fps, 'uTime');
  const viewport = ctx.viewport ?? ctx.size ?? [1920, 1080];
  if (!Array.isArray(viewport) || viewport.length !== 2 || !viewport.every((v) => v > 0)) {
    throw bad('Invalid viewport');
  }

  const aR = makeDeterministicBirthAttributes(count, seed);
  const res = evaluateFireParticles({
    uTime,
    uRoar: roar,
    uLen: beamLengthM,
    uBeam: beam,
    uReach: reach,
    uMouth: mouth,
    uDir: direction,
    drag,
    speedMps,
    aR,
    viewMatrix: ctx.camera?.matrixWorldInverse,
    projMatrix: ctx.camera?.projectionMatrix,
    viewport,
  });

  let totalWeight = 0;
  for (const pt of res.particles) totalWeight += pt.weight;

  return {
    particles: res.particles,
    readings: {
      alive: res.particles.length,
      projectedCount: res.count,
      centroidX: Number.isFinite(res.cx) ? res.cx : 0,
      centroidY: Number.isFinite(res.cy) ? res.cy : 0,
      totalWeight,
    },
  };
}
