// B19 第 4 级整镜公开题（42-1 峡谷吐息整镜）离线测量与判分器。
// 唯一从 gates-m4.json#full_shot_fire_breath（或调用方显式传入的 customGates）加载四特征门限，
// 逐代表帧与相邻帧对独立复算亮峰位置偏差、主轴长度误差、泛光横向半径误差与帧间活力误差，严防空洞/NaN/自报极值。
import { Buffer } from 'node:buffer';
import { checkAssertion, scopeRange } from '../../../verify/predicates.mjs';
import { loadM4Gates } from './evaluate-b18.mjs';

export { loadM4Gates };

const finite = Number.isFinite;
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
const xy = (v) => vec(v, 2);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const box = (b) => vec(b, 4) && b[2] > b[0] && b[3] > b[1];
const margin = ([x0, y0, x1, y1], [w, h]) => Math.min(x0 / w, y0 / h, 1 - x1 / w, 1 - y1 / h);

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

function rgbBytes(b64, expectedByteLength) {
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== expectedByteLength) return null;
  return buf;
}

function validBloomMoments(m) {
  return isPlainObj(m) && positive(m.transverseSqSum) && positive(m.weightSum);
}

/**
 * 严格校验第 4 级整镜题读数结构：拒收稀疏空洞数组、缺帧、NaN/非正数、倒置跨度或损坏的像素缓冲。
 */
export function validLevel4ShotReading(q, r) {
  if (!isPlainObj(q) || !isPlainObj(r)) return false;
  if (!vec(q.deliverable?.size, 2, (x) => Number.isSafeInteger(x) && x > 0)) return false;
  if (!Number.isSafeInteger(q.deliverable?.frames) || q.deliverable.frames <= 0) return false;
  if (!isDelivery(r.delivery)) return false;

  const [W, H] = q.deliverable.size;
  if (!vec(r.rasterSize, 2, (x) => Number.isSafeInteger(x) && x >= 16 && x <= 512)) return false;
  const [rw, rh] = r.rasterSize;
  const byteLen = rw * rh * 3;

  const repCount = r.checkFrames?.length;
  if (!Number.isSafeInteger(repCount) || repCount < 5) return false;
  if (!dense(r.checkFrames, repCount, (f, idx) =>
    Number.isSafeInteger(f) && f >= 2790 && f < 2790 + Math.max(96, q.deliverable.frames) && (idx === 0 || f > r.checkFrames[idx - 1]))) {
    return false;
  }

  const framesOk = dense(r.frames, repCount, (f, idx) => {
    if (!isPlainObj(f) || f.frame !== idx || f.checkFrame !== r.checkFrames[idx]) return false;
    if (!box(f.bounds)) return false;
    if (!xy(f.refPeakPx) || !xy(f.candPeakPx)) return false;
    if (f.refPeakPx[0] <= 0 || f.refPeakPx[0] >= W || f.refPeakPx[1] <= 0 || f.refPeakPx[1] >= H) return false;
    if (f.candPeakPx[0] < 0 || f.candPeakPx[0] > W || f.candPeakPx[1] < 0 || f.candPeakPx[1] > H) return false;
    if (!finite(f.refSpanMinPx) || !finite(f.refSpanMaxPx) || !(f.refSpanMaxPx > f.refSpanMinPx)) return false;
    if (!finite(f.candSpanMinPx) || !finite(f.candSpanMaxPx) || !(f.candSpanMaxPx > f.candSpanMinPx)) return false;
    if (!positive(f.refPlumeLengthPx) || !positive(f.candPlumeLengthPx)) return false;
    if (!positive(f.refBloomRadiusPx) || !positive(f.candBloomRadiusPx)) return false;
    if (!validBloomMoments(f.refBloomMoments) || !validBloomMoments(f.candBloomMoments)) return false;
    if (rgbBytes(f.refSrgb, byteLen) === null || rgbBytes(f.candSrgb, byteLen) === null) return false;
    return true;
  });
  if (!framesOk) return false;

  const pairCount = repCount - 1;
  const pairsOk = dense(r.vigorPairs, pairCount, (vp, idx) =>
    isPlainObj(vp)
    && vec(vp.pair, 2, (x) => Number.isSafeInteger(x))
    && vp.pair[0] === r.checkFrames[idx]
    && vp.pair[1] === r.checkFrames[idx + 1]
    && Number.isSafeInteger(vp.unionCount)
    && vp.unionCount >= 8
    && positive(vp.refHdrDelta)
    && positive(vp.candHdrDelta)
    && positive(vp.refFinalDelta)
    && positive(vp.candFinalDelta));

  return pairsOk;
}

function resolveFullShotGate(gates, args) {
  const key = args?.gateRef ?? 'full_shot_fire_breath';
  const gate = gates?.gates?.[key] ?? gates?.[key];
  if (!isPlainObj(gate)) {
    throw new Error(`未找到门限组 ${String(key)}`);
  }
  return gate;
}

function judgeShotPeakPosition(q, r, args, gates) {
  const gate = resolveFullShotGate(gates, args);
  const [W, H] = q.deliverable.size;
  for (const f of r.frames) {
    const dx = Math.abs(f.candPeakPx[0] - f.refPeakPx[0]) / W;
    const dy = Math.abs(f.candPeakPx[1] - f.refPeakPx[1]) / H;
    const maxRelErr = Math.max(dx, dy);
    const hypotRelErr = Math.hypot(dx, dy);
    if (!(maxRelErr <= gate.peakPositionMaxRelError && hypotRelErr <= gate.peakPositionMaxRelError)) {
      return false;
    }
  }
  return true;
}

function judgeShotPlumeLength(_q, r, args, gates) {
  const gate = resolveFullShotGate(gates, args);
  for (const f of r.frames) {
    const refSpanLen = f.refSpanMaxPx - f.refSpanMinPx;
    const candSpanLen = f.candSpanMaxPx - f.candSpanMinPx;
    if (!(refSpanLen > 0 && candSpanLen > 0)) return false;
    const relErrFromSpan = Math.abs(candSpanLen - refSpanLen) / refSpanLen;
    const relErrFromLength = Math.abs(f.candPlumeLengthPx - f.refPlumeLengthPx) / f.refPlumeLengthPx;
    const relErr = Math.max(relErrFromSpan, relErrFromLength);
    if (!(relErr <= gate.plumeLengthMaxRelError)) {
      return false;
    }
  }
  return true;
}

function judgeShotBloomRadius(_q, r, args, gates) {
  const gate = resolveFullShotGate(gates, args);
  for (const f of r.frames) {
    const refMomentRadius = Math.sqrt(f.refBloomMoments.transverseSqSum / f.refBloomMoments.weightSum);
    const candMomentRadius = Math.sqrt(f.candBloomMoments.transverseSqSum / f.candBloomMoments.weightSum);
    if (!(refMomentRadius > 0 && candMomentRadius > 0)) return false;
    const relErrFromMoments = Math.abs(candMomentRadius - refMomentRadius) / refMomentRadius;
    const relErrFromRadius = Math.abs(f.candBloomRadiusPx - f.refBloomRadiusPx) / f.refBloomRadiusPx;
    const relErr = Math.max(relErrFromMoments, relErrFromRadius);
    if (!(relErr <= gate.bloomRadiusMaxRelError)) {
      return false;
    }
  }
  return true;
}

function judgeShotFireVigor(_q, r, args, gates) {
  const gate = resolveFullShotGate(gates, args);
  let refHdrSum = 0;
  let candHdrSum = 0;
  let refFinalSum = 0;
  let candFinalSum = 0;
  for (const vp of r.vigorPairs) {
    refHdrSum += vp.refHdrDelta;
    candHdrSum += vp.candHdrDelta;
    refFinalSum += vp.refFinalDelta;
    candFinalSum += vp.candFinalDelta;
    const pairHdrErr = Math.abs(vp.candHdrDelta - vp.refHdrDelta) / vp.refHdrDelta;
    const pairFinalErr = Math.abs(vp.candFinalDelta - vp.refFinalDelta) / vp.refFinalDelta;
    if (!(pairHdrErr <= gate.fireVigorMaxRelError && pairFinalErr <= gate.fireVigorMaxRelError)) {
      return false;
    }
  }
  const n = r.vigorPairs.length;
  const refHdrMean = refHdrSum / n;
  const candHdrMean = candHdrSum / n;
  const refFinalMean = refFinalSum / n;
  const candFinalMean = candFinalSum / n;
  const hdrMeanRelErr = Math.abs(candHdrMean - refHdrMean) / refHdrMean;
  const finalMeanRelErr = Math.abs(candFinalMean - refFinalMean) / refFinalMean;
  return hdrMeanRelErr <= gate.fireVigorMaxRelError && finalMeanRelErr <= gate.fireVigorMaxRelError;
}

const judges = {
  'deliver.spec': (q, r) => delivered(q, r),
  'shot.peak-position': judgeShotPeakPosition,
  'shot.plume-length': judgeShotPlumeLength,
  'shot.bloom-radius': judgeShotBloomRadius,
  'shot.fire-vigor': judgeShotFireVigor,
};

const ALLOWED_METRICS = new Set([
  'deliver.spec',
  'shot.peak-position',
  'shot.plume-length',
  'shot.bloom-radius',
  'shot.fire-vigor',
]);

function evaluateBase(text, q, r) {
  const { assertion: a, bound: b, errors } = checkAssertion(text);
  if (!a || errors.some((e) => e.evidence !== 'predicate.planned')) return false;
  const n = q.deliverable.frames;
  const range = scopeRange(a.scope, { output: { frames: n } });
  if (!range || range[0] < 0 || range[1] > n || range[0] >= range[1]) return false;
  const frames = r.frames ?? [];
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
      return frames.length >= 5 && frames.every((f, idx) => idx === 0 || f.checkFrame > frames[idx - 1].checkFrame);
    case 'encoded_readback':
      return delivered(q, r) && frames.every((f) => typeof f.candSrgb === 'string' && f.candSrgb.length > 0);
    case 'inside_frame':
      return b.entity?.name === 'hero'
        && frames.every((f) => box(f.bounds) && margin(f.bounds, [1, 1]) >= (b.margin?.value ?? 0));
    default:
      return false;
  }
}

export function scoreLevel4Shot(question, reading, opts = {}) {
  const gates = loadM4Gates(opts.gates ?? null);
  const isLevel4Shot = question?.level === 4
    && (question?.id === '42-1'
      || question?.ext?.['bench.fullShot'] === true
      || question?.ext?.['bench.variantOf'] === '42-1');
  const valid = Boolean(isLevel4Shot && validLevel4ShotReading(question, reading));
  const base = (question?.basePredicates ?? []).map((text) => ({
    predicate: text,
    pass: valid && evaluateBase(text, question, reading),
  }));
  const items = (question?.scoring ?? []).map(({ metric, args, weight }) => ({
    metric,
    weight,
    pass: Boolean(
      valid
      && ALLOWED_METRICS.has(metric)
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
