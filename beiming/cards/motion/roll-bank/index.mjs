// Pure-function parallel-transport, curvature-driven banking, and scripted roll frame solver.

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export const DEFAULT_ROLL_BANK_CONFIG = Object.freeze({
  bankGain: 0.42,
  bankSaturation: 0.5,
  gravity: 9.8,
  maxSpeedSq: 3600,
  curvatureHalfSpan: 12,
  curvatureSmoothHalfSpan: 8,
  tightCurlLow: 0.045,
  tightCurlHigh: 0.075,
  verticalGuardLow: 0.8,
  verticalGuardHigh: 0.97,
  fallbackAxis: [0, 0, 1],
  viewRollTargetDot: 0.3,
  viewRollMaxAngleRad: 1.5,
});

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

function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalizeVec3(v, field = 'vector') {
  requireCondition(Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)), `Invalid ${field}`);
  const len = Math.hypot(v[0], v[1], v[2]);
  requireCondition(len > 1e-12, `Invalid ${field}: zero vector`);
  return [v[0] / len, v[1] / len, v[2] / len];
}

function perpendicularFallback(t) {
  const cand = Math.abs(t[1]) < 0.9 ? [t[2], 0, -t[0]] : [0, -t[2], t[1]];
  const l = Math.hypot(cand[0], cand[1], cand[2]);
  if (l > 1e-8) return [cand[0] / l, cand[1] / l, cand[2] / l];
  return [1, 0, 0];
}

function resolveConfig(cfg) {
  const merged = { ...DEFAULT_ROLL_BANK_CONFIG, ...(cfg ?? {}) };
  requireNumber(merged.bankGain, 'bankGain', 0);
  requireNumber(merged.bankSaturation, 'bankSaturation', 0);
  requireNumber(merged.gravity, 'gravity', Number.MIN_VALUE);
  requireNumber(merged.maxSpeedSq, 'maxSpeedSq', Number.MIN_VALUE);
  requireNumber(merged.curvatureHalfSpan, 'curvatureHalfSpan', Number.MIN_VALUE);
  requireNumber(merged.curvatureSmoothHalfSpan, 'curvatureSmoothHalfSpan', 0);
  requireNumber(merged.tightCurlLow, 'tightCurlLow', 0);
  requireNumber(merged.tightCurlHigh, 'tightCurlHigh', 0);
  requireNumber(merged.verticalGuardLow, 'verticalGuardLow', 0, 1);
  requireNumber(merged.verticalGuardHigh, 'verticalGuardHigh', 0, 1);
  normalizeVec3(merged.fallbackAxis, 'fallbackAxis');
  return merged;
}

/**
 * Compute smooth reference up vector at `pos` with tangent `tan`,
 * blending smoothly toward `fallbackAxis` near vertical tangents to prevent gimbal flip.
 */
export function referenceUpAt(pos, tan, options = {}) {
  const cfg = resolveConfig(options.config);
  const p = Array.isArray(pos) ? pos : [0, 0, 0];
  const t = normalizeVec3(tan, 'tangent');

  let ux = 0;
  let uy = 1;
  let uz = 0;

  if (options.radialAnchor) {
    const a = options.radialAnchor;
    const dx = p[0] - a.x;
    const dz = p[2] - a.z;
    const d = Math.hypot(dx, dz) || 1;
    const rIn = a.rIn ?? 21;
    const rOut = a.rOut ?? 31;
    const yLow0 = a.yLow0 ?? 26;
    const yLow1 = a.yLow1 ?? 38;
    const yHigh0 = a.yHigh0 ?? 90;
    const yHigh1 = a.yHigh1 ?? 101;
    const yScale = a.yScale ?? 0.72;
    const w = (1 - smoothstep(rIn, rOut, d)) * (1 - smoothstep(yHigh0, yHigh1, p[1])) * smoothstep(yLow0, yLow1, p[1]);
    ux = (dx / d) * w;
    uy = 1 - w * yScale;
    uz = (dz / d) * w;
  } else if (options.worldUp) {
    const wUp = normalizeVec3(options.worldUp, 'worldUp');
    ux = wUp[0];
    uy = wUp[1];
    uz = wUp[2];
  }

  const k = smoothstep(cfg.verticalGuardLow, cfg.verticalGuardHigh, Math.abs(t[1]));
  if (k > 0) {
    const fb = cfg.fallbackAxis;
    ux = ux * (1 - k) + fb[0] * k;
    uy = uy * (1 - k) + fb[1] * k;
    uz = uz * (1 - k) + fb[2] * k;
  }

  const len = Math.hypot(ux, uy, uz);
  if (len < 1e-12) return perpendicularFallback(t);
  return [ux / len, uy / len, uz / len];
}

/**
 * Carry `prevNormal` onto the plane perpendicular to `tan` and clamp the signed roll step
 * toward `targetNormal` to `[-maxStepRad, +maxStepRad]`. Mutates `prevNormal` in place.
 */
export function rollLimitStep(index, tan, targetNormal, prevNormal, maxStepRad = 5 * DEG2RAD) {
  const t = normalizeVec3(tan, 'tangent');
  let n = normalizeVec3(targetNormal, 'targetNormal');
  requireNumber(maxStepRad, 'maxStepRad', Number.MIN_VALUE);

  let rawAngleRad = 0;
  let clampedAngleRad = 0;

  if (index > 0) {
    const pd = dot3(prevNormal, t);
    let px = prevNormal[0] - t[0] * pd;
    let py = prevNormal[1] - t[1] * pd;
    let pz = prevNormal[2] - t[2] * pd;
    const pl = Math.hypot(px, py, pz);
    if (pl > 1e-12) {
      px /= pl;
      py /= pl;
      pz /= pl;
      const p = [px, py, pz];
      const rx = cross3(p, n);
      rawAngleRad = Math.atan2(dot3(rx, t), dot3(p, n));
      if (Math.abs(rawAngleRad) > maxStepRad) {
        clampedAngleRad = rawAngleRad > 0 ? maxStepRad : -maxStepRad;
        const b = cross3(t, p);
        const c = Math.cos(clampedAngleRad);
        const s = Math.sin(clampedAngleRad);
        const nx = p[0] * c + b[0] * s;
        const ny = p[1] * c + b[1] * s;
        const nz = p[2] * c + b[2] * s;
        const nl = Math.hypot(nx, ny, nz) || 1;
        n = [nx / nl, ny / nl, nz / nl];
      } else {
        clampedAngleRad = rawAngleRad;
      }
    }
  }

  prevNormal[0] = n[0];
  prevNormal[1] = n[1];
  prevNormal[2] = n[2];
  return { normal: n, rawAngleRad, clampedAngleRad };
}

/**
 * Pure minimal-rotation parallel transport (Bishop frame) along a sequence of unit tangents.
 */
export function parallelTransportFrames(tangents, initialNormal = [0, 1, 0]) {
  requireCondition(Array.isArray(tangents) && tangents.length >= 1, 'Invalid tangents');
  const firstT = normalizeVec3(tangents[0], 'tangents[0]');
  const initN = normalizeVec3(initialNormal, 'initialNormal');
  const d0 = dot3(initN, firstT);
  let nx = initN[0] - firstT[0] * d0;
  let ny = initN[1] - firstT[1] * d0;
  let nz = initN[2] - firstT[2] * d0;
  let nl = Math.hypot(nx, ny, nz);
  let curN = nl > 1e-8 ? [nx / nl, ny / nl, nz / nl] : perpendicularFallback(firstT);

  const frames = [];
  for (let i = 0; i < tangents.length; i++) {
    const t = normalizeVec3(tangents[i], `tangents[${i}]`);
    if (i > 0) {
      const prevT = frames[i - 1].tangent;
      const axis = cross3(prevT, t);
      const axisLen = Math.hypot(axis[0], axis[1], axis[2]);
      if (axisLen > 1e-10) {
        const ax = [axis[0] / axisLen, axis[1] / axisLen, axis[2] / axisLen];
        const angle = Math.acos(clamp(dot3(prevT, t), -1, 1));
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const kCrossN = cross3(ax, curN);
        const kDotN = dot3(ax, curN);
        curN = [
          curN[0] * c + kCrossN[0] * s + ax[0] * kDotN * (1 - c),
          curN[1] * c + kCrossN[1] * s + ax[1] * kDotN * (1 - c),
          curN[2] * c + kCrossN[2] * s + ax[2] * kDotN * (1 - c),
        ];
      }
      // Re-orthogonalize to suppress numerical drift
      const d = dot3(curN, t);
      nx = curN[0] - t[0] * d;
      ny = curN[1] - t[1] * d;
      nz = curN[2] - t[2] * d;
      nl = Math.hypot(nx, ny, nz);
      curN = nl > 1e-10 ? [nx / nl, ny / nl, nz / nl] : perpendicularFallback(t);
    }
    const b = normalizeVec3(cross3(t, curN), 'binormal');
    frames.push({ tangent: t, normal: curN, binormal: b, rollRad: 0, bankRad: 0 });
  }
  return frames;
}

/**
 * Precompute roll-limited reference normal field (`railN`) and smoothed curvature bank field (`railK`)
 * along uniformly arc-length-sampled rail points `railPoints[0..n]`.
 */
export function buildRailRollBankFields(railPoints, ds, options = {}) {
  requireCondition(Array.isArray(railPoints) && railPoints.length >= 2, 'Invalid railPoints');
  requireNumber(ds, 'ds', Number.MIN_VALUE);
  const cfg = resolveConfig(options.config);
  const bodyLength = requireNumber(options.bodyLength ?? 172, 'bodyLength', Number.MIN_VALUE);
  const segments = requireNumber(options.segments ?? 300, 'segments', 1);
  const maxRollStepDeg = requireNumber(options.maxRollStepDeg ?? 5, 'maxRollStepDeg', 0.01, 180);

  const n = railPoints.length - 1;
  const railN = new Float64Array((n + 1) * 3);
  const railK = new Float64Array((n + 1) * 3);
  const stepRad = (maxRollStepDeg * DEG2RAD * ds) / (bodyLength / segments);

  const railU = options.railU ?? null;
  const upZoneVec = options.upZoneVec ? normalizeVec3(options.upZoneVec, 'upZoneVec') : null;
  const railW = options.railW ?? null;
  const railS = options.railS ?? null;

  const prevN = [0, 1, 0];
  const useParallelTransport = options.frameMode === 'parallel-transport';
  let prevT = null;
  for (let j = 0; j <= n; j++) {
    const pA = railPoints[Math.max(0, j - 2)];
    const pB = railPoints[Math.min(n, j + 2)];
    const tx = pA[0] - pB[0];
    const ty = pA[1] - pB[1];
    const tz = pA[2] - pB[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    const vT = [tx / tl, ty / tl, tz / tl];

    if (useParallelTransport) {
      let curN;
      if (j === 0) {
        const initU = referenceUpAt(railPoints[0], vT, { config: cfg, worldUp: options.worldUp });
        const d0 = dot3(initU, vT);
        const nx = initU[0] - vT[0] * d0;
        const ny = initU[1] - vT[1] * d0;
        const nz = initU[2] - vT[2] * d0;
        const nl = Math.hypot(nx, ny, nz);
        curN = nl > 1e-8 ? [nx / nl, ny / nl, nz / nl] : perpendicularFallback(vT);
      } else {
        const axis = cross3(prevT, vT);
        const axisLen = Math.hypot(axis[0], axis[1], axis[2]);
        curN = [prevN[0], prevN[1], prevN[2]];
        if (axisLen > 1e-10) {
          const ax = [axis[0] / axisLen, axis[1] / axisLen, axis[2] / axisLen];
          const angle = Math.acos(clamp(dot3(prevT, vT), -1, 1));
          const c = Math.cos(angle);
          const s = Math.sin(angle);
          const kCrossN = cross3(ax, curN);
          const kDotN = dot3(ax, curN);
          curN = [
            curN[0] * c + kCrossN[0] * s + ax[0] * kDotN * (1 - c),
            curN[1] * c + kCrossN[1] * s + ax[1] * kDotN * (1 - c),
            curN[2] * c + kCrossN[2] * s + ax[2] * kDotN * (1 - c),
          ];
        }
        const d = dot3(curN, vT);
        const nx = curN[0] - vT[0] * d;
        const ny = curN[1] - vT[1] * d;
        const nz = curN[2] - vT[2] * d;
        const nl = Math.hypot(nx, ny, nz);
        curN = nl > 1e-10 ? [nx / nl, ny / nl, nz / nl] : perpendicularFallback(vT);
      }
      prevT = vT;
      prevN[0] = curN[0];
      prevN[1] = curN[1];
      prevN[2] = curN[2];
      railN[j * 3] = curN[0];
      railN[j * 3 + 1] = curN[1];
      railN[j * 3 + 2] = curN[2];
      continue;
    }

    let vU = referenceUpAt(railPoints[j], vT, {
      config: cfg,
      radialAnchor: options.radialAnchor,
      worldUp: options.worldUp,
    });

    if (railU && upZoneVec && railU[j] > 0) {
      const w = railU[j];
      const lx = vU[0] + (upZoneVec[0] - vU[0]) * w;
      const ly = vU[1] + (upZoneVec[1] - vU[1]) * w;
      const lz = vU[2] + (upZoneVec[2] - vU[2]) * w;
      const ll = Math.hypot(lx, ly, lz) || 1;
      vU = [lx / ll, ly / ll, lz / ll];
    }

    if (railW && railS && railW[j] > 0) {
      const w = railW[j];
      const ux = vU[0] * (1 - w) - railS[j * 3] * w;
      const uy = vU[1] * (1 - w) + (0.3 - railS[j * 3 + 1]) * w;
      const uz = vU[2] * (1 - w) - railS[j * 3 + 2] * w;
      const ul = Math.hypot(ux, uy, uz) || 1;
      vU = [ux / ul, uy / ul, uz / ul];
    }

    const d = dot3(vU, vT);
    let nx = vU[0] - vT[0] * d;
    let ny = vU[1] - vT[1] * d;
    let nz = vU[2] - vT[2] * d;
    let nSq = nx * nx + ny * ny + nz * nz;
    if (nSq < 1e-6) {
      nx = prevN[0];
      ny = prevN[1];
      nz = prevN[2];
      nSq = nx * nx + ny * ny + nz * nz;
    }
    const nl = Math.sqrt(nSq) || 1;
    const limited = rollLimitStep(j, vT, [nx / nl, ny / nl, nz / nl], prevN, stepRad);
    railN[j * 3] = limited.normal[0];
    railN[j * 3 + 1] = limited.normal[1];
    railN[j * 3 + 2] = limited.normal[2];
  }

  // Smoothed curvature bank vector field (1/m) pointing toward inside of turns
  const halfSpan = cfg.curvatureHalfSpan;
  const invSpan2 = 1 / (halfSpan * halfSpan);
  const mSpan = Math.max(1, Math.round(halfSpan / ds));
  const smoothW = Math.round(cfg.curvatureSmoothHalfSpan / ds);
  const acc = new Float64Array((n + 2) * 3);

  for (let j = 0; j <= n; j++) {
    const a = railPoints[Math.min(n, j + mSpan)];
    const b = railPoints[Math.max(0, j - mSpan)];
    const c = railPoints[j];
    const kx = (a[0] + b[0] - 2 * c[0]) * invSpan2;
    const ky = (a[1] + b[1] - 2 * c[1]) * invSpan2;
    const kz = (a[2] + b[2] - 2 * c[2]) * invSpan2;
    const w = 1 - smoothstep(cfg.tightCurlLow, cfg.tightCurlHigh, Math.hypot(kx, ky, kz));
    acc[(j + 1) * 3] = acc[j * 3] + kx * w;
    acc[(j + 1) * 3 + 1] = acc[j * 3 + 1] + ky * w;
    acc[(j + 1) * 3 + 2] = acc[j * 3 + 2] + kz * w;
  }

  for (let j = 0; j <= n; j++) {
    const j0 = Math.max(0, j - smoothW);
    const j1 = Math.min(n, j + smoothW) + 1;
    const q = 1 / (j1 - j0);
    railK[j * 3] = (acc[j1 * 3] - acc[j0 * 3]) * q;
    railK[j * 3 + 1] = (acc[j1 * 3 + 1] - acc[j0 * 3 + 1]) * q;
    railK[j * 3 + 2] = (acc[j1 * 3 + 2] - acc[j0 * 3 + 2]) * q;
  }

  return { railN, railK, ds };
}

/**
 * Solve continuous banked & rolled frames for a sequence of stations `{ pos, tan, railNormal?, railCurvature?, arclength?, uprightWeight? }`.
 */
export function solveRollBankFrames(stations, options = {}) {
  requireCondition(Array.isArray(stations) && stations.length >= 1, 'Invalid stations');
  const cfg = resolveConfig(options.config);
  const speed = requireNumber(options.speed ?? 20, 'speed', 0);
  const scriptedRollDeg = options.scriptedRollDeg ?? 0;
  const maxTwistStepDeg = requireNumber(options.maxTwistStepDeg ?? 6, 'maxTwistStepDeg', 0.01, 180);
  const viewRollWeight = requireNumber(options.viewRollWeight ?? 0, 'viewRollWeight', 0, 1);
  const observerPos = options.observerPos ?? null;
  if (viewRollWeight > 0 && observerPos) {
    requireCondition(Array.isArray(observerPos) && observerPos.length === 3 && observerPos.every(Number.isFinite), 'Invalid observerPos');
  }

  const v2g = Math.min(speed * speed, cfg.maxSpeedSq) / cfg.gravity;
  const maxTwistRad = maxTwistStepDeg * DEG2RAD;
  const prevViewN = [0, 1, 0];

  // If caller did not pass railNormal, precompute parallel-transport base normals cleanly
  const hasRailNormals = stations.every((st) => Array.isArray(st.railNormal));
  const bishopBase = hasRailNormals
    ? null
    : parallelTransportFrames(
      stations.map((st) => st.tan),
      options.initialNormal ?? referenceUpAt(stations[0].pos ?? [0, 0, 0], stations[0].tan, { config: cfg }),
    );

  const out = [];
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const vT = normalizeVec3(st.tan, `stations[${i}].tan`);
    const vU0 = hasRailNormals ? st.railNormal : bishopBase[i].normal;

    let vK;
    if (Array.isArray(st.railCurvature)) {
      vK = st.railCurvature;
    } else if (stations.length >= 3 && st.pos) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(stations.length - 1, i + 1);
      const p0 = stations[i0].pos;
      const p1 = stations[i1].pos;
      const pc = st.pos;
      const ds0 = Math.hypot(pc[0] - p0[0], pc[1] - p0[1], pc[2] - p0[2]);
      const ds1 = Math.hypot(p1[0] - pc[0], p1[1] - pc[1], p1[2] - pc[2]);
      const h = Math.max(0.5 * (ds0 + ds1), 1e-3);
      vK = [
        (p1[0] + p0[0] - 2 * pc[0]) / (h * h),
        (p1[1] + p0[1] - 2 * pc[1]) / (h * h),
        (p1[2] + p0[2] - 2 * pc[2]) / (h * h),
      ];
    } else {
      vK = [0, 0, 0];
    }

    // Orthogonal unbanked normal for bank angle readout
    const d0 = dot3(vU0, vT);
    let n0x = vU0[0] - vT[0] * d0;
    let n0y = vU0[1] - vT[1] * d0;
    let n0z = vU0[2] - vT[2] * d0;
    const n0Sq = n0x * n0x + n0y * n0y + n0z * n0z;
    const vN0 = n0Sq < 1e-8 ? perpendicularFallback(vT) : [n0x / Math.sqrt(n0Sq), n0y / Math.sqrt(n0Sq), n0z / Math.sqrt(n0Sq)];

    // Centripetal banking
    const kLen = Math.hypot(vK[0], vK[1], vK[2]);
    const bankScale = (v2g * cfg.bankGain) / (1 + v2g * kLen * cfg.bankSaturation);
    const ux = vU0[0] + vK[0] * bankScale;
    const uy = vU0[1] + vK[1] * bankScale;
    const uz = vU0[2] + vK[2] * bankScale;

    const dU = ux * vT[0] + uy * vT[1] + uz * vT[2];
    let nx = ux - vT[0] * dU;
    let ny = uy - vT[1] * dU;
    let nz = uz - vT[2] * dU;
    let nSq = nx * nx + ny * ny + nz * nz;
    let vN;
    if (nSq < 1e-8) {
      const fb = [vT[2], 0, -vT[0]];
      const fbl = Math.hypot(fb[0], fb[1], fb[2]);
      vN = fbl > 1e-8 ? [fb[0] / fbl, fb[1] / fbl, fb[2] / fbl] : perpendicularFallback(vT);
    } else {
      const nl = Math.sqrt(nSq);
      vN = [nx / nl, ny / nl, nz / nl];
    }

    const bankCross = cross3(vN0, vN);
    const bankRad = Math.atan2(dot3(bankCross, vT), dot3(vN0, vN));

    // Optional upright blend near head/neck (e.g. when lifted off a surface)
    const uprightW = st.uprightWeight ?? 0;
    if (uprightW > 0.01) {
      const upx = -vT[0] * vT[1];
      const upy = 1 - vT[1] * vT[1];
      const upz = -vT[2] * vT[1];
      const upSq = upx * upx + upy * upy + upz * upz;
      if (upSq > 0.02) {
        const upl = Math.sqrt(upSq);
        let lx = vN[0] + (upx / upl - vN[0]) * uprightW;
        let ly = vN[1] + (upy / upl - vN[1]) * uprightW;
        let lz = vN[2] + (upz / upl - vN[2]) * uprightW;
        let ll = Math.hypot(lx, ly, lz) || 1;
        lx /= ll;
        ly /= ll;
        lz /= ll;
        const dt = lx * vT[0] + ly * vT[1] + lz * vT[2];
        lx -= vT[0] * dt;
        ly -= vT[1] * dt;
        lz -= vT[2] * dt;
        ll = Math.hypot(lx, ly, lz) || 1;
        vN = [lx / ll, ly / ll, lz / ll];
      }
    }

    // Scripted roll rotation about tangent
    const rollDeg = Array.isArray(scriptedRollDeg)
      ? requireNumber(scriptedRollDeg[i] ?? 0, `scriptedRollDeg[${i}]`)
      : requireNumber(scriptedRollDeg, 'scriptedRollDeg');
    const rollRad = rollDeg * DEG2RAD;
    if (rollRad !== 0) {
      const b0 = cross3(vT, vN);
      const c = Math.cos(rollRad);
      const s = Math.sin(rollRad);
      const rx = vN[0] * c + b0[0] * s;
      const ry = vN[1] * c + b0[1] * s;
      const rz = vN[2] * c + b0[2] * s;
      const rl = Math.hypot(rx, ry, rz) || 1;
      vN = [rx / rl, ry / rl, rz / rl];
    }

    let vB = cross3(vT, vN);

    // Optional observer-facing dorsal roll with twist-rate limiter
    if (viewRollWeight > 0 && observerPos && st.pos) {
      const lx = observerPos[0] - st.pos[0];
      const ly = observerPos[1] - st.pos[1];
      const lz = observerPos[2] - st.pos[2];
      const il = 1 / (Math.hypot(lx, ly, lz) || 1);
      const a = (lx * vN[0] + ly * vN[1] + lz * vN[2]) * il;
      const b = (lx * vB[0] + ly * vB[1] + lz * vB[2]) * il;
      const R = Math.hypot(a, b);
      const ab = Math.abs(b);
      if (R > 0.12 && ab > 0.06) {
        let ph = Math.asin(Math.min(cfg.viewRollTargetDot, 0.9 * R) / R) - Math.atan2(a, ab);
        if (ph > 0) {
          const arclen = st.arclength ?? i;
          ph = Math.min(ph, cfg.viewRollMaxAngleRad)
            * viewRollWeight
            * smoothstep(0.06, 0.3, ab)
            * smoothstep(0.12, 0.35, R)
            * (0.3 + 0.7 * smoothstep(3, 24, arclen));
          const c = Math.cos(ph);
          const s = Math.sin(ph) * (b > 0 ? 1 : -1);
          const rx = vN[0] * c + vB[0] * s;
          const ry = vN[1] * c + vB[1] * s;
          const rz = vN[2] * c + vB[2] * s;
          const rl = Math.hypot(rx, ry, rz) || 1;
          vN = [rx / rl, ry / rl, rz / rl];
        }
      }
      const limited = rollLimitStep(i, vT, vN, prevViewN, maxTwistRad);
      vN = limited.normal;
      vB = cross3(vT, vN);
    }

    const bl = Math.hypot(vB[0], vB[1], vB[2]) || 1;
    vB = [vB[0] / bl, vB[1] / bl, vB[2] / bl];

    out.push({
      tangent: vT,
      normal: vN,
      binormal: vB,
      rollRad,
      bankRad,
    });
  }
  return out;
}

/** Measure maximum adjacent parallel-transport twist step (degrees) along a frame array. */
export function measureMaxTwistJumpDeg(frames) {
  requireCondition(Array.isArray(frames), 'Invalid frames');
  let maxDeg = 0;
  for (let i = 1; i < frames.length; i++) {
    const t = frames[i].tangent ?? frames[i].tan;
    const n = frames[i].normal ?? frames[i].nor;
    const p = frames[i - 1].normal ?? frames[i - 1].nor;
    const d = dot3(p, t);
    let px = p[0] - t[0] * d;
    let py = p[1] - t[1] * d;
    let pz = p[2] - t[2] * d;
    const pl = Math.hypot(px, py, pz);
    if (pl < 1e-9) continue;
    px /= pl;
    py /= pl;
    pz /= pl;
    const c = cross3([px, py, pz], n);
    const angDeg = Math.abs(Math.atan2(dot3(c, t), px * n[0] + py * n[1] + pz * n[2])) * RAD2DEG;
    if (angDeg > maxDeg) maxDeg = angDeg;
  }
  return maxDeg;
}

/** Standard card/0.1 data evaluate entry. */
export function evaluate(ctx, params, frame = ctx?.frame ?? 0, sub = ctx?.sub ?? 0) {
  requireCondition(ctx && typeof ctx === 'object', 'Invalid ctx');
  requireCondition(params && typeof params === 'object', 'Invalid params');

  const fps = parseRate(ctx.fps ?? 60);
  const tick = requireNumber(frame, 'frame') + requireNumber(sub, 'sub', 0, 1);
  const time = requireNumber(ctx.time ?? ctx.uTime ?? tick / fps, 'time');
  const config = resolveConfig(params.config);
  const maxRollStepDeg = requireNumber(params.maxRollStepDeg ?? 5, 'maxRollStepDeg', 0.01, 180);
  const maxTwistStepDeg = requireNumber(params.maxTwistStepDeg ?? 6, 'maxTwistStepDeg', 0.01, 180);
  const scriptedRollDeg = requireNumber(params.scriptedRollDeg ?? 0, 'scriptedRollDeg');
  const speed = requireNumber(params.speed ?? 20, 'speed', 0);
  const viewRollWeight = requireNumber(params.viewRollWeight ?? 0, 'viewRollWeight', 0, 1);

  let stations = ctx.stations;
  if (!Array.isArray(stations)) {
    // Generate a smooth helical curve segment parameterized by time for standalone evaluation
    const count = 33;
    const radius = 25;
    stations = [];
    for (let i = 0; i < count; i++) {
      const a = i * 2;
      const th = (time * 0.5) - a / radius;
      const pos = [radius * Math.cos(th), 15 + a * 0.25, radius * Math.sin(th)];
      const rawT = [Math.sin(th), 0.25, -Math.cos(th)];
      const tl = Math.hypot(rawT[0], rawT[1], rawT[2]);
      stations.push({ pos, tan: [rawT[0] / tl, rawT[1] / tl, rawT[2] / tl], arclength: a });
    }
  }

  const frames = solveRollBankFrames(stations, {
    config,
    speed,
    scriptedRollDeg,
    maxRollStepDeg,
    maxTwistStepDeg,
    viewRollWeight,
    observerPos: ctx.observerPos ?? null,
  });

  let maxBankDeg = 0;
  for (const f of frames) {
    const b = Math.abs(f.bankRad) * RAD2DEG;
    if (b > maxBankDeg) maxBankDeg = b;
  }

  return {
    frames,
    readings: {
      stationCount: frames.length,
      maxTwistStepDeg: measureMaxTwistJumpDeg(frames),
      maxBankDeg,
    },
  };
}
