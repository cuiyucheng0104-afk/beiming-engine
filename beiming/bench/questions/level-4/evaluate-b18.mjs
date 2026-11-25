// B18 四级垫脚题离线测量与判分器（后期链 41-1 / 多段扫掠脊线 41-2 / 粒子闭式重放 41-3）。
// 所有门限数值唯一从 gates-m4.json（或调用方显式传入的 customGates）加载，绝不信任被测读数自报的极值或结论。
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { checkAssertion, scopeRange } from '../../../verify/predicates.mjs';

const DEFAULT_GATES_PATH = path.join(import.meta.dirname, 'gates-m4.json');
const RAD2DEG = 180 / Math.PI;
const finite = Number.isFinite;
const nonnegative = (x) => finite(x) && x >= 0;
const positive = (x) => finite(x) && x > 0;

function isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function dense(xs, n, test) {
  if (!Array.isArray(xs) || xs.length !== n) return false;
  for (let i = 0; i < n; i++) {
    if (!Object.hasOwn(xs, i) || !test(xs[i], i)) return false;
  }
  return true;
}

const vec = (v, n, check = finite) => dense(v, n, check);
const xyz = (v) => vec(v, 3);
const xy = (v) => vec(v, 2);
const unitVec3 = (v) => xyz(v) && Math.abs(Math.hypot(v[0], v[1], v[2]) - 1) <= 1e-3;
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const dist3 = (a, b) => Math.hypot(...a.map((v, idx) => v - b[idx]));
const dot3 = (a, b) => a.reduce((acc, v, idx) => acc + v * b[idx], 0);
const cross3 = ([ax, ay, az], [bx, by, bz]) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
const box = (b) => vec(b, 4) && b[2] > b[0] && b[3] > b[1];
const margin = ([x0, y0, x1, y1], [w, h]) => Math.min(x0 / w, y0 / h, 1 - x1 / w, 1 - y1 / h);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

const isDelivery = (d) =>
  d === null
  || (vec(d?.size, 2, (x) => Number.isSafeInteger(x) && x > 0)
    && typeof d.fps === 'string'
    && /^[1-9]\d*\/[1-9]\d*$/.test(d.fps)
    && Number.isSafeInteger(d.frames)
    && d.frames > 0
    && typeof d.audio === 'string');

const delivered = (q, r) =>
  r.delivery !== null
  && ['fps', 'frames', 'audio'].every((k) => r.delivery[k] === q.deliverable[k])
  && same(r.delivery.size, q.deliverable.size);

const GATE_SCHEMA = Object.freeze({
  stepping_stone_1_post_chain: ['finalSrgbPsnrMinDb', 'finalSrgbRmseMax', 'finalSrgbDiffGe5PxRatioMaxPct'],
  stepping_stone_2_dragon_spine: ['positionRmseMaxM', 'maxTwistJumpErrorDeg'],
  stepping_stone_3_particle_replay: ['screenPosErrorMaxPx'],
  full_shot_fire_breath: [
    'peakPositionMaxRelError',
    'plumeLengthMaxRelError',
    'bloomRadiusMaxRelError',
    'fireVigorMaxRelError',
  ],
});

/**
 * 加载并校验 M4 四道门公开阈值表。
 * 支持不传参（默认读同目录 gates-m4.json）、传入文件路径、JSON 字符串或自定义阈值覆盖对象。
 */
export function loadM4Gates(customGates = null) {
  const defaultRaw = JSON.parse(fs.readFileSync(DEFAULT_GATES_PATH, 'utf8'));
  let override = null;
  if (typeof customGates === 'string') {
    const trimmed = customGates.trim();
    override = trimmed.startsWith('{')
      ? JSON.parse(trimmed)
      : JSON.parse(fs.readFileSync(path.resolve(customGates), 'utf8'));
  } else if (isPlainObj(customGates)) {
    override = customGates;
  } else if (customGates !== null && customGates !== undefined) {
    throw new TypeError('customGates 必须是对象、JSON 字符串或文件路径');
  }

  const resolvedGates = {};
  for (const [gateKey, metricKeys] of Object.entries(GATE_SCHEMA)) {
    const baseGate = defaultRaw.gates?.[gateKey] ?? defaultRaw[gateKey] ?? {};
    const topGate = isPlainObj(override?.[gateKey]) ? override[gateKey] : null;
    const nestedGate = isPlainObj(override?.gates?.[gateKey]) ? override.gates[gateKey] : null;

    const merged = {};
    for (const mKey of metricKeys) {
      const defVal = baseGate[mKey];
      const topVal = topGate && Object.hasOwn(topGate, mKey) ? topGate[mKey] : undefined;
      const nestedVal = nestedGate && Object.hasOwn(nestedGate, mKey) ? nestedGate[mKey] : undefined;
      let val = defVal;
      if (topVal !== undefined && nestedVal !== undefined) {
        val = topVal !== defVal ? topVal : nestedVal;
      } else if (topVal !== undefined) {
        val = topVal;
      } else if (nestedVal !== undefined) {
        val = nestedVal;
      }
      if (!positive(val)) {
        throw new RangeError(`gates-m4 门限 ${gateKey}.${mKey} 必须是正有限数，收到 ${String(val)}`);
      }
      merged[mKey] = val;
    }
    resolvedGates[gateKey] = Object.freeze(merged);
  }

  const source = typeof override?.source === 'string' ? override.source : defaultRaw.source;
  const lockPolicy = typeof override?.lockPolicy === 'string' ? override.lockPolicy : defaultRaw.lockPolicy;
  if (typeof source !== 'string' || !source || typeof lockPolicy !== 'string' || !lockPolicy) {
    throw new TypeError('gates-m4 缺少 source 或 lockPolicy');
  }

  return Object.freeze({
    format: defaultRaw.format ?? 'gates-m4/0.1',
    id: defaultRaw.id ?? 'gates-m4',
    level: 4,
    source,
    lockPolicy,
    ...resolvedGates,
    gates: Object.freeze({ ...resolvedGates }),
  });
}

function decodeRgbRaster(b64, width, height) {
  if (typeof b64 !== 'string' || b64.length === 0 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
  const expectedBytes = width * height * 3;
  const expectedBase64Len = Math.ceil(expectedBytes / 3) * 4;
  if (b64.length !== expectedBase64Len) return null;
  const buf = Buffer.from(b64, 'base64');
  return buf.length === expectedBytes ? buf : null;
}

function hasDynamicRange(buf, minSpan = 32) {
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    if (hi - lo >= minSpan) return true;
  }
  return false;
}

function measureSrgbPair(refBuf, candBuf, width, height) {
  const pixelCount = width * height;
  let sumSq = 0;
  let diffGe5Pixels = 0;
  for (let p = 0; p < pixelCount; p++) {
    const idx = p * 3;
    const dr = Math.abs(candBuf[idx] - refBuf[idx]);
    const dg = Math.abs(candBuf[idx + 1] - refBuf[idx + 1]);
    const db = Math.abs(candBuf[idx + 2] - refBuf[idx + 2]);
    if (Math.max(dr, dg, db) >= 5) diffGe5Pixels++;
    const nr = dr / 255;
    const ng = dg / 255;
    const nb = db / 255;
    sumSq += nr * nr + ng * ng + nb * nb;
  }
  const rmse = Math.sqrt(sumSq / (pixelCount * 3));
  const psnrDb = rmse === 0 ? Infinity : -20 * Math.log10(rmse);
  const diffGe5Pct = (diffGe5Pixels / pixelCount) * 100;
  return { rmse, psnrDb, diffGe5Pct };
}

function twistStepDeg(prevNormal, curTangent, curNormal) {
  const d = dot3(prevNormal, curTangent);
  let px = prevNormal[0] - curTangent[0] * d;
  let py = prevNormal[1] - curTangent[1] * d;
  let pz = prevNormal[2] - curTangent[2] * d;
  const pl = Math.hypot(px, py, pz);
  if (pl < 1e-9) return 0;
  px /= pl;
  py /= pl;
  pz /= pl;
  const c = cross3([px, py, pz], curNormal);
  return Math.atan2(dot3(c, curTangent), px * curNormal[0] + py * curNormal[1] + pz * curNormal[2]) * RAD2DEG;
}

function validParticleList(list, minCount) {
  return Array.isArray(list)
    && list.length >= minCount
    && dense(list, list.length, (pt) =>
      isPlainObj(pt)
      && xy(pt.refPx)
      && xy(pt.candPx)
      && xy(pt.randomAccessPx)
      && positive(pt.weight));
}

export function validSteppingStoneReading(question, reading) {
  if (!isPlainObj(question) || !isPlainObj(reading)) return false;
  const n = question.deliverable?.frames;
  if (!Number.isInteger(n) || n <= 0 || !isDelivery(reading.delivery)) return false;

  if (question.id === '41-1') {
    const p = reading.patch;
    if (!isPlainObj(p)
      || typeof p.version !== 'string'
      || typeof p.patched !== 'boolean'
      || typeof p.templateIntact !== 'boolean'
      || typeof p.patchKey !== 'string'
      || !/^[a-f0-9]{24}$/.test(p.patchKey)
      || typeof p.expectedPatchKey !== 'string'
      || !/^[a-f0-9]{24}$/.test(p.expectedPatchKey)) {
      return false;
    }
    return dense(reading.frames, n, (f, idx) => {
      if (!isPlainObj(f) || f.frame !== idx) return false;
      if (!Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width !== 48 || f.height !== 27) return false;
      const refBuf = decodeRgbRaster(f.refSrgb, f.width, f.height);
      const candBuf = decodeRgbRaster(f.candSrgb, f.width, f.height);
      return Boolean(refBuf && candBuf && hasDynamicRange(refBuf, 32));
    });
  }

  if (question.id === '41-2') {
    const arclengths = reading.arclengths;
    const m = Array.isArray(arclengths) ? arclengths.length : 0;
    if (m < 16 || !dense(arclengths, m, nonnegative)) return false;
    if (arclengths[0] !== 0 || arclengths[m - 1] < 100) return false;
    for (let i = 1; i < m; i++) {
      if (!(arclengths[i] > arclengths[i - 1])) return false;
    }
    const validFrames = dense(reading.frames, n, (f, idx) =>
      isPlainObj(f)
      && f.frame === idx
      && finite(f.timeSec)
      && box(f.bounds)
      && nonnegative(f.impulseOffsetNormM)
      && nonnegative(f.swimOffsetNormM)
      && dense(f.refPositions, m, xyz)
      && dense(f.candPositions, m, xyz)
      && dense(f.refNormals, m, unitVec3)
      && dense(f.candNormals, m, unitVec3)
      && dense(f.candTangents, m, unitVec3));
    if (!validFrames) return false;
    for (let i = 1; i < n; i++) {
      if (!(reading.frames[i].timeSec > reading.frames[i - 1].timeSec)) return false;
    }
    return reading.frames[n - 1].timeSec - reading.frames[0].timeSec >= 20;
  }

  if (question.id === '41-3') {
    return dense(reading.frames, n, (f, idx) => {
      if (!isPlainObj(f) || f.frame !== idx || !Number.isInteger(f.checkFrame) || f.checkFrame <= 0 || !box(f.bounds)) {
        return false;
      }
      const layers = f.layers;
      if (!isPlainObj(layers)
        || !validParticleList(layers.fire, 24)
        || !validParticleList(layers.emb, 4)
        || !validParticleList(layers.smoke, idx >= 2 ? 1 : 0)) {
        return false;
      }
      const mp = f.minpxProbe;
      if (!isPlainObj(mp)
        || ![mp.origPx, mp.clampedPx, mp.minPx, mp.energyScale, mp.conservedEnergy, mp.origAreaEnergy].every(positive)) {
        return false;
      }
      const sp = f.softProbe;
      if (!isPlainObj(sp)
        || ![sp.sceneDepth, sp.particleDepth, sp.softnessM].every(positive)
        || !finite(sp.fade)) {
        return false;
      }
      const pp = f.premultProbe;
      if (!isPlainObj(pp)
        || !vec(pp.emitRgb, 3, nonnegative)
        || !vec(pp.smokeRgb, 3, nonnegative)
        || !nonnegative(pp.alphaOcc)
        || pp.alphaOcc > 1
        || !vec(pp.outRgba, 4, nonnegative)
        || !vec(pp.bgRgba, 4, nonnegative)
        || !vec(pp.blendedRgba, 4, nonnegative)) {
        return false;
      }
      const ep = f.emitPoolProbe;
      if (!isPlainObj(ep)
        || !Array.isArray(ep.emitters)
        || ep.emitters.length < 2
        || !dense(ep.emitters, ep.emitters.length, (e) => isPlainObj(e) && xyz(e.position) && positive(e.intensity))
        || !isPlainObj(ep.pooled)
        || !xyz(ep.pooled.position)
        || !nonnegative(ep.pooled.intensity)
        || !Number.isInteger(ep.pooled.activeCount)) {
        return false;
      }
      const bp = f.bakeProbe;
      return isPlainObj(bp)
        && finite(bp.timeSec)
        && vec(bp.sequentialValues, 4)
        && vec(bp.bakedValues, 4)
        && vec(bp.randomAccessValues, 4);
    });
  }

  return false;
}

function judgePostShaderPatch(_, r) {
  const p = r.patch;
  return p.version === '0.187.0'
    && p.patched === true
    && p.templateIntact === true
    && p.patchKey === p.expectedPatchKey;
}

function judgePostSrgbPsnr(_, r, args, gates) {
  const gate = gates[args.gateRef ?? 'stepping_stone_1_post_chain'];
  if (!gate) return false;
  return r.frames.every((f) => {
    const refBuf = decodeRgbRaster(f.refSrgb, f.width, f.height);
    const candBuf = decodeRgbRaster(f.candSrgb, f.width, f.height);
    const { rmse, psnrDb } = measureSrgbPair(refBuf, candBuf, f.width, f.height);
    return psnrDb >= gate.finalSrgbPsnrMinDb && rmse <= gate.finalSrgbRmseMax;
  });
}

function judgePostSrgbDiffGe5(_, r, args, gates) {
  const gate = gates[args.gateRef ?? 'stepping_stone_1_post_chain'];
  if (!gate) return false;
  return r.frames.every((f) => {
    const refBuf = decodeRgbRaster(f.refSrgb, f.width, f.height);
    const candBuf = decodeRgbRaster(f.candSrgb, f.width, f.height);
    const { diffGe5Pct } = measureSrgbPair(refBuf, candBuf, f.width, f.height);
    return diffGe5Pct <= gate.finalSrgbDiffGe5PxRatioMaxPct;
  });
}

function judgeSpinePositionRmse(_, r, args, gates) {
  const gate = gates[args.gateRef ?? 'stepping_stone_2_dragon_spine'];
  if (!gate) return false;
  let totalSq = 0;
  let totalCount = 0;
  for (const f of r.frames) {
    let frameSq = 0;
    const m = f.refPositions.length;
    for (let i = 0; i < m; i++) {
      const d = dist3(f.candPositions[i], f.refPositions[i]);
      frameSq += d * d;
    }
    const frameRmse = Math.sqrt(frameSq / m);
    if (!(frameRmse < gate.positionRmseMaxM)) return false;
    totalSq += frameSq;
    totalCount += m;
  }
  const globalRmse = Math.sqrt(totalSq / totalCount);
  return globalRmse < gate.positionRmseMaxM;
}

function judgeSpineTwistJump(_, r, args, gates) {
  const gate = gates[args.gateRef ?? 'stepping_stone_2_dragon_spine'];
  if (!gate) return false;
  let maxExcessTwistDeg = 0;
  for (const f of r.frames) {
    const m = f.candNormals.length;
    for (let i = 0; i < m; i++) {
      if (Math.abs(dot3(f.candTangents[i], f.candNormals[i])) > 1e-3) return false;
      if (i > 0) {
        const candStep = twistStepDeg(f.candNormals[i - 1], f.candTangents[i], f.candNormals[i]);
        const refStep = twistStepDeg(f.refNormals[i - 1], f.candTangents[i], f.refNormals[i]);
        let diff = Math.abs(candStep - refStep);
        if (diff > 180) diff = 360 - diff;
        if (diff > maxExcessTwistDeg) maxExcessTwistDeg = diff;
      }
    }
  }
  return maxExcessTwistDeg < gate.maxTwistJumpErrorDeg;
}

function judgeSpineKinematicsCoupling(_, r) {
  const maxImpulse = Math.max(...r.frames.map((f) => f.impulseOffsetNormM));
  const minSwim = Math.min(...r.frames.map((f) => f.swimOffsetNormM));
  if (!(maxImpulse > 0.25 && minSwim > 0.05)) return false;
  const expectedSpan = r.arclengths[r.arclengths.length - 1] - r.arclengths[0];
  for (const f of r.frames) {
    let polyLen = 0;
    for (let i = 1; i < f.candPositions.length; i++) {
      polyLen += dist3(f.candPositions[i], f.candPositions[i - 1]);
    }
    if (polyLen < expectedSpan * 0.7 || polyLen > expectedSpan * 1.35) return false;
  }
  return true;
}

function judgeParticleScreenReplay(_, r, args, gates) {
  const gate = gates[args.gateRef ?? 'stepping_stone_3_particle_replay'];
  if (!gate) return false;
  for (const f of r.frames) {
    for (const key of ['fire', 'emb', 'smoke']) {
      const list = f.layers[key];
      if (!list || list.length === 0) continue;
      let wSum = 0;
      let refCx = 0;
      let refCy = 0;
      let candCx = 0;
      let candCy = 0;
      let sqSum = 0;
      for (const pt of list) {
        const w = pt.weight;
        wSum += w;
        refCx += pt.refPx[0] * w;
        refCy += pt.refPx[1] * w;
        candCx += pt.candPx[0] * w;
        candCy += pt.candPx[1] * w;
        const err = Math.hypot(pt.candPx[0] - pt.refPx[0], pt.candPx[1] - pt.refPx[1]);
        sqSum += err * err;
      }
      if (!(wSum > 0)) return false;
      const centroidErr = Math.hypot(candCx / wSum - refCx / wSum, candCy / wSum - refCy / wSum);
      const particleRmse = Math.sqrt(sqSum / list.length);
      if (!(centroidErr < gate.screenPosErrorMaxPx && particleRmse < gate.screenPosErrorMaxPx)) {
        return false;
      }
    }
  }
  return true;
}

function judgeParticleRandomAccessBake(_, r) {
  let minHx = Infinity;
  let maxHx = -Infinity;
  for (const f of r.frames) {
    for (const key of ['fire', 'emb', 'smoke']) {
      for (const pt of f.layers[key]) {
        const diff = Math.hypot(pt.randomAccessPx[0] - pt.candPx[0], pt.randomAccessPx[1] - pt.candPx[1]);
        if (diff > 1e-9) return false;
      }
    }
    const { sequentialValues: seq, bakedValues: baked, randomAccessValues: rnd } = f.bakeProbe;
    for (let c = 0; c < 4; c++) {
      if (Math.abs(baked[c] - seq[c]) > 1e-9 || Math.abs(rnd[c] - baked[c]) > 1e-9) return false;
    }
    if (baked[0] < minHx) minHx = baked[0];
    if (baked[0] > maxHx) maxHx = baked[0];
  }
  return maxHx - minHx > 1e-3;
}

function judgeParticleEnergySoftPool(_, r) {
  for (const f of r.frames) {
    const mp = f.minpxProbe;
    const expectedClamped = Math.max(mp.origPx, mp.minPx);
    const ratio = mp.origPx / expectedClamped;
    const expectedScale = ratio * ratio;
    const expectedEnergy = expectedClamped * expectedClamped * mp.energyScale;
    if (!(mp.origPx < mp.minPx)) return false;
    if (Math.abs(mp.clampedPx - expectedClamped) > 1e-6) return false;
    if (Math.abs(mp.energyScale - expectedScale) > 1e-6) return false;
    if (Math.abs(expectedEnergy - mp.origAreaEnergy) / mp.origAreaEnergy > 1e-5) return false;

    const sp = f.softProbe;
    const expectedFade = clamp01((sp.sceneDepth - sp.particleDepth) / sp.softnessM);
    if (!(expectedFade > 0.05 && expectedFade < 0.95)) return false;
    if (Math.abs(sp.fade - expectedFade) > 1e-6) return false;

    const pp = f.premultProbe;
    const a = pp.alphaOcc;
    for (let c = 0; c < 3; c++) {
      const expOut = pp.emitRgb[c] + pp.smokeRgb[c] * a;
      const expBlend = pp.outRgba[c] + pp.bgRgba[c] * (1 - pp.outRgba[3]);
      if (Math.abs(pp.outRgba[c] - expOut) > 1e-6 || Math.abs(pp.blendedRgba[c] - expBlend) > 1e-6) {
        return false;
      }
    }
    if (Math.abs(pp.outRgba[3] - a) > 1e-6) return false;

    const ep = f.emitPoolProbe;
    let sumI = 0;
    let wx = 0;
    let wy = 0;
    let wz = 0;
    for (const em of ep.emitters) {
      sumI += em.intensity;
      wx += em.position[0] * em.intensity;
      wy += em.position[1] * em.intensity;
      wz += em.position[2] * em.intensity;
    }
    if (!(sumI > 0) || ep.pooled.activeCount !== ep.emitters.length) return false;
    if (Math.abs(ep.pooled.intensity - sumI) > 1e-5) return false;
    const expPos = [wx / sumI, wy / sumI, wz / sumI];
    if (dist3(ep.pooled.position, expPos) > 1e-5) return false;
  }
  return true;
}

const judges = {
  'deliver.spec': (q, r) => delivered(q, r),
  'post.shader-patch': judgePostShaderPatch,
  'post.srgb-psnr': judgePostSrgbPsnr,
  'post.srgb-diff-ge5': judgePostSrgbDiffGe5,
  'spine.position-rmse': judgeSpinePositionRmse,
  'spine.twist-jump': judgeSpineTwistJump,
  'spine.kinematics-coupling': judgeSpineKinematicsCoupling,
  'particle.screen-replay': judgeParticleScreenReplay,
  'particle.random-access-bake': judgeParticleRandomAccessBake,
  'particle.energy-soft-pool': judgeParticleEnergySoftPool,
};

const metricsById = new Map([
  ['41-1', ['deliver.spec', 'post.shader-patch', 'post.srgb-psnr', 'post.srgb-diff-ge5']],
  ['41-2', ['deliver.spec', 'spine.position-rmse', 'spine.twist-jump', 'spine.kinematics-coupling']],
  ['41-3', ['deliver.spec', 'particle.screen-replay', 'particle.random-access-bake', 'particle.energy-soft-pool']],
]);

function evaluateBase(text, q, r) {
  const { assertion: a, bound: b, errors } = checkAssertion(text);
  if (!a || errors.some((e) => e.evidence !== 'predicate.planned')) return false;
  const n = q.deliverable.frames;
  const range = scopeRange(a.scope, { output: { frames: n } });
  if (!range || range[0] < 0 || range[1] > n || range[0] >= range[1]) return false;
  const [lo, hi] = range;
  const frames = r.frames?.slice(lo, hi) ?? [];
  switch (a.name) {
    case 'delivery': {
      if (!delivered(q, r)) return false;
      const d = r.delivery;
      const [num, den] = d.fps.split('/').map(Number);
      const fields = { width: d.size[0], height: d.size[1], fps: num / den, frames: d.frames };
      return Object.entries(b).every(([k, v]) =>
        k === 'output' ? v.name === 'output' : Object.hasOwn(fields, k) && fields[k] === v.value);
    }
    case 'no_cut':
      return frames.length === hi - lo;
    case 'encoded_readback':
      return delivered(q, r) && frames.every((f) => typeof f.candSrgb === 'string' && f.candSrgb.length > 0);
    case 'inside_frame':
      return b.entity?.name === 'hero'
        && frames.every((f) => box(f.bounds) && margin(f.bounds, [1, 1]) >= (b.margin?.value ?? 0));
    default:
      return false;
  }
}

export function scoreSteppingStone(question, reading, opts = {}) {
  const gates = loadM4Gates(opts.gates ?? null);
  const valid = validSteppingStoneReading(question, reading);
  const allowedMetrics = metricsById.get(question?.id) ?? [];
  const base = (question?.basePredicates ?? []).map((text) => ({
    predicate: text,
    pass: valid && evaluateBase(text, question, reading),
  }));
  const items = (question?.scoring ?? []).map(({ metric, args, weight }) => ({
    metric,
    weight,
    pass: Boolean(
      valid
      && allowedMetrics.includes(metric)
      && judges[metric]?.(question, reading, args ?? {}, gates),
    ),
  }));
  const basePass = base.length > 0 && base.every((it) => it.pass);
  const scoringPass = items.length > 0 && items.every((it) => it.pass);
  const sum = items.reduce((acc, it) => acc + (it.pass ? it.weight : 0), 0);
  const score = Math.abs(1 - sum) < 1e-12 ? 1 : sum;
  return {
    valid,
    base,
    basePass,
    items,
    scoringPass,
    score,
    pass: valid && basePass && scoringPass,
  };
}
