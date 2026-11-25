// Pure-function trajectory-swept body spine solver composing:
//   - motion.impulse (event-driven thrust impulse field)
//   - motion.swim (traveling lateral/heave wave along arclength)
//   - motion.roll-bank (parallel-transport + curvature banking + scripted/view roll)

import { impulseDisplacementAt } from '../impulse/index.mjs';
import {
  DEFAULT_ROLL_BANK_CONFIG,
  buildRailRollBankFields,
  measureMaxTwistJumpDeg,
  solveRollBankFrames,
} from '../roll-bank/index.mjs';
import { DEFAULT_SWIM_CONFIG, swimOffsetAt } from '../swim/index.mjs';

function badArgument(message) {
  return Object.assign(new TypeError(message), { code: 'usage.bad-argument' });
}

function requireCondition(condition, message) {
  if (!condition) throw badArgument(message);
}

function requireNumber(value, field, min = -Infinity, max = Infinity) {
  requireCondition(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, `Invalid ${field}`);
  return value;
}

function parseRate(fps) {
  if (typeof fps === 'string') {
    const match = /^(\d+)\/(\d+)$/.exec(fps);
    requireCondition(Boolean(match), 'Invalid fps');
    const den = Number(match[2]);
    requireCondition(den > 0, 'Invalid fps');
    return requireNumber(Number(match[1]) / den, 'fps', Number.MIN_VALUE);
  }
  return requireNumber(fps, 'fps', Number.MIN_VALUE);
}

function clamp(x, min = 0, max = 1) {
  return x < min ? min : x > max ? max : x;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Fritsch-Carlson monotone cubic Hermite interpolator through strictly increasing `xs`.
 */
export function monotoneCubic(xs, ys) {
  requireCondition(Array.isArray(xs) && Array.isArray(ys) && xs.length >= 2 && xs.length === ys.length, 'Invalid monotoneCubic keys');
  const n = xs.length;
  const d = new Float64Array(n - 1);
  const m = new Float64Array(n);

  for (let i = 0; i < n - 1; i++) {
    requireNumber(xs[i], `xs[${i}]`);
    requireNumber(ys[i], `ys[${i}]`);
    requireCondition(xs[i + 1] > xs[i], 'monotoneCubic requires strictly increasing xs');
    d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  }
  requireNumber(xs[n - 1], `xs[${n - 1}]`);
  requireNumber(ys[n - 1], `ys[${n - 1}]`);

  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]);
  }

  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (x > xs[mid + 1]) lo = mid + 1;
      else hi = mid;
    }
    const i = lo;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i]
      + (t3 - 2 * t2 + t) * h * m[i]
      + (-2 * t3 + 3 * t2) * ys[i + 1]
      + (t3 - t2) * h * m[i + 1];
  };
}

function evalNonuniformCatmullRomAxis(x0, x1, x2, x3, dt0, dt1, dt2, w) {
  let t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
  let t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
  t1 *= dt1;
  t2 *= dt1;
  const c0 = x1;
  const c1 = t1;
  const c2 = -3 * x1 + 3 * x2 - 2 * t1 - t2;
  const c3 = 2 * x1 - 2 * x2 + t1 + t2;
  const w2 = w * w;
  return c0 + c1 * w + c2 * w2 + c3 * w2 * w;
}

function distSq3(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Pure-JS open centripetal Catmull-Rom 3D spline with arc-length parameterization.
 */
export class CentripetalCatmullRom {
  constructor(points, arcLengthDivisions = 12000) {
    requireCondition(Array.isArray(points) && points.length >= 2, 'CentripetalCatmullRom requires at least 2 points');
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      requireCondition(Array.isArray(p) && p.length === 3 && p.every(Number.isFinite), `Invalid controlPoint[${i}]`);
    }
    this.points = points.map((p) => [p[0], p[1], p[2]]);
    this.divisions = Math.round(requireNumber(arcLengthDivisions, 'arcLengthDivisions', 4, 200000));
    this.lengths = this.#buildLengths(this.divisions);
    this.totalLength = this.lengths[this.divisions];
  }

  getPoint(t) {
    const pts = this.points;
    const l = pts.length;
    const p = (l - 1) * t;
    let intPoint = Math.floor(p);
    let weight = p - intPoint;
    if (weight < 0) {
      intPoint = 0;
      weight = 0;
    } else if (intPoint >= l - 1) {
      intPoint = l - 2;
      weight = 1;
    }

    const p1 = pts[intPoint];
    const p2 = pts[intPoint + 1];
    const p0 = intPoint > 0
      ? pts[intPoint - 1]
      : [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1], 2 * pts[0][2] - pts[1][2]];
    const p3 = intPoint + 2 < l
      ? pts[intPoint + 2]
      : [2 * pts[l - 1][0] - pts[l - 2][0], 2 * pts[l - 1][1] - pts[l - 2][1], 2 * pts[l - 1][2] - pts[l - 2][2]];

    let dt0 = Math.pow(distSq3(p0, p1), 0.25);
    let dt1 = Math.pow(distSq3(p1, p2), 0.25);
    let dt2 = Math.pow(distSq3(p2, p3), 0.25);
    if (dt1 < 1e-4) dt1 = 1.0;
    if (dt0 < 1e-4) dt0 = dt1;
    if (dt2 < 1e-4) dt2 = dt1;

    return [
      evalNonuniformCatmullRomAxis(p0[0], p1[0], p2[0], p3[0], dt0, dt1, dt2, weight),
      evalNonuniformCatmullRomAxis(p0[1], p1[1], p2[1], p3[1], dt0, dt1, dt2, weight),
      evalNonuniformCatmullRomAxis(p0[2], p1[2], p2[2], p3[2], dt0, dt1, dt2, weight),
    ];
  }

  #buildLengths(divisions) {
    const cache = new Float64Array(divisions + 1);
    let last = this.getPoint(0);
    let sum = 0;
    for (let i = 1; i <= divisions; i++) {
      const cur = this.getPoint(i / divisions);
      sum += Math.hypot(cur[0] - last[0], cur[1] - last[1], cur[2] - last[2]);
      cache[i] = sum;
      last = cur;
    }
    return cache;
  }

  arclengthAtControlIndex(k) {
    const div = this.divisions;
    const f = (k / (this.points.length - 1)) * div;
    const i = Math.min(div - 1, Math.max(0, Math.floor(f)));
    return lerp(this.lengths[i], this.lengths[i + 1], f - i);
  }

  uToT(u) {
    const lens = this.lengths;
    const il = lens.length;
    const target = u * lens[il - 1];
    let low = 0;
    let high = il - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const cmp = lens[mid] - target;
      if (cmp < 0) low = mid + 1;
      else if (cmp > 0) high = mid - 1;
      else {
        high = mid;
        break;
      }
    }
    const i = Math.max(0, Math.min(il - 2, high));
    if (lens[i] === target) return i / (il - 1);
    const segLen = lens[i + 1] - lens[i];
    const frac = segLen > 0 ? (target - lens[i]) / segLen : 0;
    return (i + frac) / (il - 1);
  }

  getSpacedPoints(n) {
    const pts = new Array(n + 1);
    for (let i = 0; i <= n; i++) {
      pts[i] = this.getPoint(this.uToT(i / n));
    }
    return pts;
  }
}

/**
 * Compile an immutable arc-length-sampled rail + precomputed parallel-transport & curvature bank fields.
 */
export function compileRail(trajectory, options = {}) {
  requireCondition(trajectory && typeof trajectory === 'object', 'Invalid trajectory');
  const bodyLength = requireNumber(options.bodyLength ?? 172, 'bodyLength', Number.MIN_VALUE);
  const segments = Math.round(requireNumber(options.segments ?? 300, 'segments', 2));
  const maxRollStepDeg = requireNumber(options.maxRollStepDeg ?? 5, 'maxRollStepDeg', 0.01, 180);
  const rollBankConfig = { ...DEFAULT_ROLL_BANK_CONFIG, ...(options.rollBankConfig ?? {}) };

  let pts;
  let ds;
  let sTot;
  let curve = null;

  if (Array.isArray(trajectory.railPoints) && trajectory.railPoints.length >= 2) {
    pts = trajectory.railPoints.map((p) => [p[0], p[1], p[2]]);
    ds = requireNumber(trajectory.ds, 'ds', Number.MIN_VALUE);
    sTot = ds * (pts.length - 1);
  } else {
    const divisions = trajectory.arcLengthDivisions ?? 12000;
    const spacing = requireNumber(trajectory.railSampleSpacing ?? 0.25, 'railSampleSpacing', Number.MIN_VALUE);
    curve = new CentripetalCatmullRom(trajectory.controlPoints, divisions);
    sTot = curve.totalLength;
    requireCondition(sTot > 1e-6, 'Rail total length must be positive');
    const n = Math.max(2, Math.ceil(sTot / spacing));
    pts = curve.getSpacedPoints(n);
    ds = sTot / n;
  }

  const n = pts.length - 1;

  // Build time -> arclength mapping sOf(t)
  let sOf;
  if (Array.isArray(trajectory.timeKeys) && trajectory.timeKeys.length >= 2) {
    const mode = trajectory.timeKeyMode ?? 'arclength';
    const sorted = trajectory.timeKeys
      .map((row) => {
        requireCondition(Array.isArray(row) && row.length >= 2, 'Invalid timeKey');
        const t = requireNumber(row[0], 'timeKey.t');
        const v = requireNumber(row[1], 'timeKey.value');
        const frac = row[2] === undefined ? 0 : requireNumber(row[2], 'timeKey.frac');
        const s = mode === 'cpIndex' && curve ? curve.arclengthAtControlIndex(v + frac) : v;
        return [t, s];
      })
      .sort((a, b) => a[0] - b[0]);
    sOf = monotoneCubic(
      sorted.map((k) => k[0]),
      sorted.map((k) => k[1]),
    );
  } else {
    const speed = requireNumber(trajectory.speed ?? 20, 'speed', 0);
    const startS = requireNumber(trajectory.startS ?? 0, 'startS');
    sOf = (t) => startS + speed * t;
  }

  let sPhase = 0;
  if (Array.isArray(trajectory.sRef) && trajectory.sRef.length === 2) {
    sPhase = requireNumber(trajectory.sRef[1], 'sRef[1]') - sOf(requireNumber(trajectory.sRef[0], 'sRef[0]'));
  }

  // Optional rail zones (quiet, up, seat)
  let railQ = null;
  let railU = null;
  let railW = null;
  const railS = trajectory.railS ?? null;
  if (Array.isArray(trajectory.zones) && trajectory.zones.length > 0) {
    railQ = new Float64Array(n + 2);
    railU = new Float64Array(n + 2);
    railW = new Float64Array(n + 2);
    for (const z of trajectory.zones) {
      const sA = z.fromCp !== undefined && curve ? curve.arclengthAtControlIndex(z.fromCp) : requireNumber(z.fromS, 'zone.fromS');
      const sB = z.toCp !== undefined && curve ? curve.arclengthAtControlIndex(z.toCp) : requireNumber(z.toS, 'zone.toS');
      const edge = z.edge ?? 8;
      const arr = z.kind === 'quiet' ? railQ : z.kind === 'up' ? railU : railW;
      const j0 = Math.max(0, Math.floor((sA - edge) / ds));
      const j1 = Math.min(n, Math.ceil((sB + edge) / ds));
      for (let j = j0; j <= j1; j++) {
        const w = smoothstep(sA - edge, sA, j * ds) * (1 - smoothstep(sB, sB + edge, j * ds));
        if (w > arr[j]) arr[j] = w;
      }
    }
    if (trajectory.railWOverride) {
      railW.set(trajectory.railWOverride);
    }
    for (let j = 0; j <= n; j++) {
      if (railW[j] > railQ[j]) railQ[j] = railW[j];
    }
  }

  const { railN, railK } = buildRailRollBankFields(pts, ds, {
    config: rollBankConfig,
    bodyLength,
    segments,
    maxRollStepDeg,
    frameMode: options.frameMode ?? trajectory.frameMode ?? 'rail-up',
    radialAnchor: trajectory.radialAnchor ?? null,
    upZoneVec: trajectory.upZoneVec ?? null,
    railU,
    railW: trajectory.railWOverride ? railW : null,
    railS,
  });

  const pathAt = (s) => {
    const f = clamp(s, 0, sTot - 0.001) / ds;
    const i = Math.min(n - 1, Math.floor(f));
    const u = f - i;
    const a = pts[i];
    const b = pts[i + 1];
    return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
  };

  return Object.freeze({
    pts,
    n,
    ds,
    sTot,
    sOf,
    sPhase,
    speedDt: trajectory.speedDt ?? 0.03,
    railN,
    railK,
    railQ,
    railW,
    railS,
    pathAt,
    curve,
  });
}

/**
 * Sample an interpolated spine frame `{ pos, tan, nor, bin, s }` at arclength `a` in `[0, bodyLength]`.
 */
export function sampleSpineFrameAt(rawFrames, bodyLength, a) {
  requireCondition(Array.isArray(rawFrames) && rawFrames.length >= 2, 'Invalid rawFrames');
  const ns = rawFrames.length - 1;
  const f = clamp(a / bodyLength, 0, 1) * ns;
  const i = Math.min(ns - 1, Math.floor(f));
  const u = f - i;
  const f0 = rawFrames[i];
  const f1 = rawFrames[i + 1];

  const pos = [
    lerp(f0.pos[0], f1.pos[0], u),
    lerp(f0.pos[1], f1.pos[1], u),
    lerp(f0.pos[2], f1.pos[2], u),
  ];

  let tx = lerp(f0.tan[0], f1.tan[0], u);
  let ty = lerp(f0.tan[1], f1.tan[1], u);
  let tz = lerp(f0.tan[2], f1.tan[2], u);
  const tl = Math.hypot(tx, ty, tz) || 1;
  const tan = [tx / tl, ty / tl, tz / tl];

  let nx = lerp(f0.nor[0], f1.nor[0], u);
  let ny = lerp(f0.nor[1], f1.nor[1], u);
  let nz = lerp(f0.nor[2], f1.nor[2], u);
  const nd = nx * tan[0] + ny * tan[1] + nz * tan[2];
  nx -= tan[0] * nd;
  ny -= tan[1] * nd;
  nz -= tan[2] * nd;
  const nl = Math.hypot(nx, ny, nz) || 1;
  const nor = [nx / nl, ny / nl, nz / nl];

  let bx = tan[1] * nor[2] - tan[2] * nor[1];
  let by = tan[2] * nor[0] - tan[0] * nor[2];
  let bz = tan[0] * nor[1] - tan[1] * nor[0];
  const bl = Math.hypot(bx, by, bz) || 1;
  const bin = [bx / bl, by / bl, bz / bl];

  return { pos, tan, nor, bin, s: a };
}

/**
 * Evaluate the full swept body spine at `time` on a compiled rail.
 */
export function sweepSpineAt(rail, time, options = {}) {
  requireCondition(rail && typeof rail.pathAt === 'function' && typeof rail.sOf === 'function', 'Invalid compiled rail');
  requireNumber(time, 'time');

  const bodyLength = requireNumber(options.bodyLength ?? 172, 'bodyLength', Number.MIN_VALUE);
  const segments = Math.round(requireNumber(options.segments ?? 300, 'segments', 2));
  const speedDt = requireNumber(options.speedDt ?? rail.speedDt ?? 0.03, 'speedDt', 1e-5, 1);

  const sh = rail.sOf(time);
  const spd = (rail.sOf(time + speedDt) - rail.sOf(time - speedDt)) / (2 * speedDt);
  const absSpd = Math.max(0, spd);

  const swimAmplitude = requireNumber(options.swimAmplitude ?? 1, 'swimAmplitude', 0);
  const swimCalm = typeof options.swimCalm === 'function' ? options.swimCalm(time) : requireNumber(options.swimCalm ?? 1, 'swimCalm', 0);
  const swimStir = typeof options.swimStir === 'function' ? options.swimStir(time) : requireNumber(options.swimStir ?? 0, 'swimStir', 0);
  const swimPhaseDeg = requireNumber(options.swimPhaseDeg ?? 0, 'swimPhaseDeg');
  const swimConfig = options.swimConfig ? { ...DEFAULT_SWIM_CONFIG, ...options.swimConfig } : DEFAULT_SWIM_CONFIG;
  const impulses = Array.isArray(options.impulses) ? options.impulses : [];

  const swimStateBase = {
    config: swimConfig,
    time,
    headS: sh,
    sPhase: rail.sPhase,
    speed: absSpd,
    bodyLength,
    amplitude: swimAmplitude,
    calm: swimCalm,
    stir: swimStir,
    phaseDeg: swimPhaseDeg,
  };

  const railTangentAt = (s) => {
    const sHi = clamp(s + 0.6, 0, rail.sTot - 0.001);
    const sLo = clamp(s - 0.6, 0, rail.sTot - 0.001);
    let pPlus = rail.pathAt(sHi);
    let pMinus = rail.pathAt(sLo);
    let tx = pMinus[0] - pPlus[0];
    let ty = pMinus[1] - pPlus[1];
    let tz = pMinus[2] - pPlus[2];
    let tl = Math.hypot(tx, ty, tz);
    if (tl < 1e-9) {
      if (s <= 0) {
        pPlus = rail.pathAt(Math.min(1.2, rail.sTot - 0.001));
        pMinus = rail.pathAt(0);
      } else {
        pPlus = rail.pathAt(rail.sTot - 0.001);
        pMinus = rail.pathAt(Math.max(0, rail.sTot - 1.201));
      }
      tx = pMinus[0] - pPlus[0];
      ty = pMinus[1] - pPlus[1];
      tz = pMinus[2] - pPlus[2];
      tl = Math.hypot(tx, ty, tz) || 1;
    }
    return [tx / tl, ty / tl, tz / tl];
  };

  // Pass 1: spine center positions along rail + swim wave + optional seat + impulses
  const centers = new Array(segments + 1);
  for (let i = 0; i <= segments; i++) {
    const a = (bodyLength * i) / segments;
    const s = sh - a;
    const p = rail.pathAt(s);
    const vT = railTangentAt(s);

    let qz = 0;
    let wS = 0;
    let sj = 0;
    let su = 0;
    if (rail.railQ) {
      const f = clamp(s, 0, rail.sTot - 0.001) / rail.ds;
      sj = Math.min(rail.n - 1, Math.floor(f));
      su = f - sj;
      qz = lerp(rail.railQ[sj], rail.railQ[sj + 1], su);
      if (rail.railW) wS = lerp(rail.railW[sj], rail.railW[sj + 1], su);
    }

    if (swimAmplitude > 0) {
      const sw = swimOffsetAt(a, vT, { ...swimStateBase, quiet: qz });
      p[0] += sw.offset[0];
      p[1] += sw.offset[1];
      p[2] += sw.offset[2];
    }

    if (wS > 0.001 && typeof options.seatOffsetFn === 'function') {
      options.seatOffsetFn(a, sj, su, wS, time, p);
    }

    if (typeof options.tailOffsetFn === 'function') {
      options.tailOffsetFn(a, time, p);
    }

    if (impulses.length > 0) {
      const imp = impulseDisplacementAt(impulses, time, a, bodyLength);
      p[0] += imp.offset[0];
      p[1] += imp.offset[1];
      p[2] += imp.offset[2];
    }

    centers[i] = p;
  }

  // Pass 2: optional neck aim bend (gaze target averaged over 5 temporal taps, head point stays fixed)
  if (options.aim) {
    const scaleK = options.aim.scaleK ?? 1;
    let lookW = 0;
    const gT = [0, 0, 0];
    if (typeof options.aim.sampleTarget === 'function') {
      for (let k = -2; k <= 2; k++) {
        const tapW = (3 - Math.abs(k)) / 9;
        const sample = options.aim.sampleTarget(time + k * 0.07);
        if (sample && sample.weight > 0) {
          const w = tapW * sample.weight;
          lookW += w;
          gT[0] += sample.target[0] * w;
          gT[1] += sample.target[1] * w;
          gT[2] += sample.target[2] * w;
        }
      }
    } else if (Array.isArray(options.aim.target) && (options.aim.weight ?? 0) > 0) {
      lookW = options.aim.weight;
      gT[0] = options.aim.target[0] * lookW;
      gT[1] = options.aim.target[1] * lookW;
      gT[2] = options.aim.target[2] * lookW;
    }

    const head = centers[0];
    if (lookW > 1e-5) {
      gT[0] /= lookW;
      gT[1] /= lookW;
      gT[2] /= lookW;
      const dist = Math.hypot(gT[0] - head[0], gT[1] - head[1], gT[2] - head[2]);
      lookW *= smoothstep(3.5, 10, dist);
    }

    if (lookW > 0.001 && segments >= 3) {
      const c3 = centers[3];
      let zx = head[0] - c3[0];
      let zy = head[1] - c3[1];
      let zz = head[2] - c3[2];
      const zl = Math.hypot(zx, zy, zz) || 1;
      zx /= zl;
      zy /= zl;
      zz /= zl;

      let gx = gT[0] - head[0];
      let gy = gT[1] - head[1];
      let gz = gT[2] - head[2];
      const gl = Math.hypot(gx, gy, gz) || 1;
      gx /= gl;
      gy /= gl;
      gz /= gl;

      const dt = zx * gx + zy * gy + zz * gz;
      const vx = gx - zx * dt;
      const vy = gy - zy * dt;
      const vz = gz - zz * dt;
      const pl = Math.hypot(vx, vy, vz);
      if (pl > 0.02) {
        const ang = Math.atan2(pl, dt);
        const amp = (lookW * 3.5 * scaleK * Math.min(ang, 1.5)) / 1.2 * (1 - smoothstep(2.6, 3.05, ang));
        const A0 = 8.5 * scaleK;
        const scale = -amp / pl;
        const dx = vx * scale;
        const dy = vy * scale;
        const dz = vz * scale;
        for (let i = 1; i <= segments; i++) {
          const q = ((bodyLength * i) / segments) / A0;
          if (q > 7) break;
          const w = q * Math.exp(1 - q);
          centers[i][0] += dx * w;
          centers[i][1] += dy * w;
          centers[i][2] += dz * w;
        }
      }
    }
  }

  // Pass 3: solve continuous roll-bank frames along final spine centers
  const stations = new Array(segments + 1);
  for (let i = 0; i <= segments; i++) {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(segments, i + 1);
    const p0 = centers[i0];
    const p1 = centers[i1];
    let tx = p1[0] - p0[0];
    let ty = p1[1] - p0[1];
    let tz = p1[2] - p0[2];
    let tl = Math.hypot(tx, ty, tz);
    const a = (bodyLength * i) / segments;
    const s = sh - a;
    let tanVec;
    if (tl < 1e-9) {
      tanVec = railTangentAt(s);
    } else {
      tanVec = [tx / tl, ty / tl, tz / tl];
    }

    const f = clamp(s, 0, rail.sTot - 0.001) / rail.ds;
    const j = Math.min(rail.n - 1, Math.floor(f));
    const u = f - j;
    const k3 = j * 3;
    const railNormal = [
      lerp(rail.railN[k3], rail.railN[k3 + 3], u),
      lerp(rail.railN[k3 + 1], rail.railN[k3 + 4], u),
      lerp(rail.railN[k3 + 2], rail.railN[k3 + 5], u),
    ];
    const railCurvature = [
      lerp(rail.railK[k3], rail.railK[k3 + 3], u),
      lerp(rail.railK[k3 + 1], rail.railK[k3 + 4], u),
      lerp(rail.railK[k3 + 2], rail.railK[k3 + 5], u),
    ];

    let uprightWeight = 0;
    if (rail.railW && i < segments * 0.2) {
      const q = a / 12;
      uprightWeight = lerp(rail.railW[j], rail.railW[j + 1], u) * Math.exp(-q * q);
    }

    stations[i] = {
      pos: centers[i],
      tan: tanVec,
      railNormal,
      railCurvature,
      arclength: a,
      uprightWeight,
    };
  }

  const rollBankConfig = {
    ...DEFAULT_ROLL_BANK_CONFIG,
    ...(options.rollBankConfig ?? {}),
    ...(options.bankGain !== undefined ? { bankGain: options.bankGain } : {}),
  };

  const viewRollWeight = typeof options.viewRollWeight === 'function'
    ? options.viewRollWeight(time)
    : requireNumber(options.viewRollWeight ?? 0, 'viewRollWeight', 0, 1);
  const observerPos = typeof options.observerPos === 'function'
    ? options.observerPos(time)
    : options.observerPos ?? null;

  const solved = solveRollBankFrames(stations, {
    config: rollBankConfig,
    speed: absSpd,
    scriptedRollDeg: options.scriptedRollDeg ?? 0,
    maxTwistStepDeg: options.maxTwistStepDeg ?? 6,
    viewRollWeight,
    observerPos,
  });

  const rawFrames = new Array(segments + 1);
  for (let i = 0; i <= segments; i++) {
    rawFrames[i] = {
      pos: centers[i],
      tan: solved[i].tangent,
      nor: solved[i].normal,
      bin: solved[i].binormal,
      s: (bodyLength * i) / segments,
    };
  }

  let nodes;
  if (Array.isArray(options.sampleArclengths)) {
    nodes = options.sampleArclengths.map((a) => sampleSpineFrameAt(rawFrames, bodyLength, a));
  } else if (options.sampleCount !== undefined) {
    const count = Math.round(requireNumber(options.sampleCount, 'sampleCount', 2));
    nodes = new Array(count);
    for (let i = 0; i < count; i++) {
      const a = (bodyLength * i) / (count - 1);
      nodes[i] = sampleSpineFrameAt(rawFrames, bodyLength, a);
    }
  } else {
    nodes = rawFrames;
  }

  return {
    time,
    headS: sh,
    speed: spd,
    nodes,
    rawFrames,
    head: { ...rawFrames[0], s: sh, speed: spd },
  };
}

/** Standard card/0.1 data evaluate entry. */
export function evaluate(ctx, params, frame = ctx?.frame ?? 0, sub = ctx?.sub ?? 0) {
  requireCondition(ctx && typeof ctx === 'object', 'Invalid ctx');
  requireCondition(params && typeof params === 'object', 'Invalid params');

  const fps = parseRate(ctx.fps ?? 60);
  const tick = requireNumber(frame, 'frame') + requireNumber(sub, 'sub', 0, 1);
  const time = requireNumber(ctx.time ?? ctx.uTime ?? tick / fps, 'time');

  const bodyLength = requireNumber(params.bodyLength ?? 40, 'bodyLength', 0.1);
  const segments = Math.round(requireNumber(params.segments ?? 80, 'segments', 2));
  const sampleCount = Math.round(requireNumber(params.sampleCount ?? 41, 'sampleCount', 2));
  const maxRollStepDeg = requireNumber(params.maxRollStepDeg ?? 5, 'maxRollStepDeg', 0.01, 180);
  const maxTwistStepDeg = requireNumber(params.maxTwistStepDeg ?? 6, 'maxTwistStepDeg', 0.01, 180);
  const bankGain = requireNumber(params.bankGain ?? 0.42, 'bankGain', 0);

  const rail = ctx.compiledRail ?? compileRail(params.trajectory, {
    bodyLength,
    segments,
    maxRollStepDeg,
    rollBankConfig: { bankGain },
  });

  const sampleArclengths = ctx.sampleArclengths ?? params.trajectory?.sampleArclengths;
  const impulses = ctx.impulses ?? params.trajectory?.impulses ?? [];

  const swept = sweepSpineAt(rail, time, {
    bodyLength,
    segments,
    ...(sampleArclengths ? { sampleArclengths } : { sampleCount }),
    swimAmplitude: requireNumber(params.swimAmplitude ?? 1, 'swimAmplitude', 0),
    swimCalm: requireNumber(params.swimCalm ?? 1, 'swimCalm', 0),
    swimStir: requireNumber(params.swimStir ?? 0, 'swimStir', 0),
    swimPhaseDeg: requireNumber(params.swimPhaseDeg ?? 0, 'swimPhaseDeg'),
    bankGain,
    scriptedRollDeg: requireNumber(params.scriptedRollDeg ?? 0, 'scriptedRollDeg'),
    maxTwistStepDeg,
    impulses,
    aim: ctx.aim ?? null,
    viewRollWeight: ctx.viewRollWeight ?? 0,
    observerPos: ctx.observerPos ?? null,
  });

  return {
    spine: {
      time: swept.time,
      headS: swept.headS,
      speed: swept.speed,
      nodes: swept.nodes,
    },
    readings: {
      nodeCount: swept.nodes.length,
      headS: swept.headS,
      speedMps: swept.speed,
      maxTwistStepDeg: measureMaxTwistJumpDeg(swept.nodes),
    },
  };
}
