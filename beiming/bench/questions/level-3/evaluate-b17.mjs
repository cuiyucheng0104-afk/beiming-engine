// B17 离线测量协议：几何读数以米为单位，画框归一化；双机位的投影和质心均为像素。
// 一个数组槽对应一帧（或一个已知零件），不能跳过数组空洞、用最后一帧或自报的极值代替。
import { Buffer } from 'node:buffer';
import { checkAssertion, scopeRange } from '../../../verify/predicates.mjs';

const finite = Number.isFinite;
const nonnegative = x => finite(x) && x >= 0;
const rgb = x => Number.isInteger(x) && x >= 0 && x <= 255;
const index = (i, n) => Number.isInteger(i) && i >= 0 && i < n;
function dense(xs, n, test) {
  if (!Array.isArray(xs) || xs.length !== n) return false;
  for (let i = 0; i < n; i++) if (!Object.hasOwn(xs, i) || !test(xs[i], i)) return false;
  return true;
}
const vec = (v, n, check = finite) => dense(v, n, check);
const xyz = v => vec(v, 3);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const distance = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
const box = b => vec(b, 4) && b[2] > b[0] && b[3] > b[1];
const margin = ([x0, y0, x1, y1], [w, h]) => Math.min(x0 / w, y0 / h, 1 - x1 / w, 1 - y1 / h);
const between = (x, pair) => vec(pair, 2) && x >= pair[0] && x <= pair[1];
const ratio = frame => frame.keyFill[1] > 0 ? frame.keyFill[0] / frame.keyFill[1] : NaN;
const isDelivery = d => d === null || (vec(d?.size, 2, x => Number.isSafeInteger(x) && x > 0)
  && typeof d.fps === 'string' && /^[1-9]\d*\/[1-9]\d*$/.test(d.fps) && Number.isSafeInteger(d.frames) && d.frames > 0 && typeof d.audio === 'string');
const delivered = (q, r) => r.delivery !== null && ['fps', 'frames', 'audio'].every(k => r.delivery[k] === q.deliverable[k]) && same(r.delivery.size, q.deliverable.size);
const targetsOK = (targets, rest) => dense(targets, 3, xyz) && targets.every((p, i) => distance(p, rest[i]) < 1e-8);
const lumaPixels = 48 * 27;
const rasterOK = s => typeof s === 'string' && s.length === lumaPixels / 3 * 4 && /^[A-Za-z0-9+/]+$/.test(s);
function clipRatio(frame) {
  let clips = 0;
  for (const y of Buffer.from(frame.lumaRaster, 'base64')) if (y === 255) clips++;
  return clips / lumaPixels;
}

// ROI 的亮度直接从同一帧的像素和部件掩膜计算，不读取生产方的材质均值。
function separated(frame, minGap) {
  const pixels = Buffer.from(frame.lumaRaster, 'base64');
  const mask = Buffer.from(frame.materialMask, 'base64');
  const counts = [0, 0, 0, 0], sums = [0, 0, 0, 0];
  for (let i = 0; i < mask.length; i++) {
    const id = mask[i];
    if (id > 3) return false;
    counts[id]++; sums[id] += pixels[i];
  }
  const [, emit, metal, matte] = sums.map((s, i) => s / counts[i]);
  return emit - metal > minGap && metal - matte > minGap;
}

export function validLevel3Reading(q, r) {
  const n = q.deliverable.frames;
  if (!isDelivery(r?.delivery)) return false;
  if (q.id === '31-1') return dense(r.takes, 2, take => {
    const count = take?.anchors?.length;
    return Number.isInteger(count) && count > 0 && count < n && typeof take.overlayKey === 'string' && /^[a-f0-9]{24}$/.test(take.overlayKey)
      && dense(take.anchors, count, p => vec(p, 2)) && dense(take.centers, count, p => p === null || vec(p, 2))
      && dense(take.boxes, count, box) && dense(take.corners, n, p => vec(p, 3, rgb));
  });
  if (!['3-1', '1-2'].includes(q.id) || !dense(r.rest, 3, xyz)) return false;
  return dense(r.frames, n, f => dense(f?.positions, 3, xyz) && box(f.bounds) && finite(f.cameraHeightM)
    && vec(f.keyFill, 2, nonnegative) && (q.id === '3-1' ? vec(f.gapsM, 3) : rasterOK(f.materialMask) && rasterOK(f.lumaRaster)));
}

const stable = (cur, prev, eps) => cur.positions.every((p, i) => distance(p, prev.positions[i]) <= eps);
const judges = {
  'deliver.spec': (q, r) => delivered(q, r),
  'assembly.settle': (_, r, a) => targetsOK(a.targets, r.rest) && index(a.restFrom, r.frames.length)
    && dense(a.starts, 3, (start, i) => {
      const probe = start + a.probeFrames;
      if (!index(start, a.restFrom) || !index(probe, a.restFrom) || probe <= start) return false;
      const dist = f => distance(r.frames[f].positions[i], a.targets[i]);
      const initial = dist(start);
      const distances = r.frames.slice(start, probe + 1).map((_, j) => dist(start + j));
      const tau = distances.findIndex(d => d <= initial / Math.E);
      return initial >= a.minTravelM && between(tau, a.tauFrames) && between(distances.at(-1) / initial, a.remaining)
        && r.frames.slice(0, start).every(f => distance(f.positions[i], r.frames[start].positions[i]) <= a.maxStepM)
        && distances.every((d, j) => !j || d < distances[j - 1]);
    }) && r.frames.slice(a.restFrom).every((f, i, fs) => (i === 0 || stable(f, fs[i - 1], a.maxStepM))
      && f.positions.every((p, j) => distance(p, a.targets[j]) <= a.maxRestErrorM)),
  'assembly.contact': (_, r, a) => index(a.from, r.frames.length) && r.frames.slice(a.from)
    .every(f => f.gapsM.every(g => g >= -a.maxDepthM && g <= a.maxGapM)),
  'camera.coverage': (q, r, a) => r.frames.every(f => margin(f.bounds, [1, 1]) >= a.margin)
    && (q.id === '1-2' ? delivered(q, r) : index(a.from, r.frames.length)
      && r.frames.every(f => f.cameraHeightM >= a.minHeightM && between(ratio(f), a.keyFill))
      && r.frames.slice(a.from).every(f => f.gapsM.every(g => g <= a.maxGapM))),
  'overlay.tracking': (q, r, a) => r.takes[0].overlayKey === r.takes[1].overlayKey && r.takes.every(t =>
    t.anchors.length === a.frames && t.anchors.every((p, i) => t.centers[i] !== null && distance(p, t.centers[i]) <= a.maxErrorPx
      && margin(t.boxes[i], q.deliverable.size) >= a.margin)),
  'camera.displacement': (_, r, a) => r.takes.every(t => t.anchors.length >= a.frames) && a.frames > 0 && Number.isInteger(a.frames)
    && r.takes[0].anchors.slice(0, a.frames).every((p, i) => distance(p, r.takes[1].anchors[i]) > a.minDisplacementPx),
  'edit.hard-cut': (_, r, a) => vec(a.firstRGB, 3, rgb) && vec(a.secondRGB, 3, rgb) && !same(a.firstRGB, a.secondRGB)
    && r.takes.every(t => t.anchors.length === a.at && t.corners.every((p, i) => same(p, i < a.at ? a.firstRGB : a.secondRGB))),
  'assembly.excursion': (_, r, a) => targetsOK(a.targets, r.rest) && index(a.peakFrame, r.frames.length)
    && a.targets.every((target, part) => {
      const ds = r.frames.map(f => distance(f.positions[part], target));
      return ds[0] <= a.returnToleranceM && ds.at(-1) <= a.returnToleranceM && ds[a.peakFrame] >= a.minTravelM
        && ds.every((d, i) => i === 0 || (i <= a.peakFrame ? d >= ds[i - 1] - 1e-9 : d <= ds[i - 1] + 1e-9));
    }),
  'lighting.exposure': (_, r, a) => r.frames.every(f => between(ratio(f), a.keyFill) && clipRatio(f) <= a.maxClipRatio),
  'material.separation': (_, r, a) => r.frames.every(f => separated(f, a.minLumaGap)),
};

function predicate(text, q, r) {
  const { assertion: a, bound: b, errors } = checkAssertion(text);
  if (!a || errors.some(e => e.evidence !== 'predicate.planned')) return false;
  if (a.cmp && !['camera.height', 'key_fill_ratio', 'highlight_clip_ratio'].includes(a.name)) return false;
  const n = q.deliverable.frames;
  const range = scopeRange(a.scope, { output: { frames: n } });
  if (!range || range[0] < 0 || range[1] > n || range[0] >= range[1]) return false;
  const [lo, hi] = range;
  const frames = r.frames?.slice(lo, hi);
  const mixed = q.id === '31-1';
  const compare = x => finite(x) && (a.cmp?.op === 'in' ? between(x, [a.cmp.lo, a.cmp.hi])
    : a.cmp?.op === '>=' ? x >= a.cmp.value : a.cmp?.op === '<=' && x <= a.cmp.value);
  const meters = v => v.value * (v.unit === 'mm' ? 0.001 : 1);
  const supports = b.a?.name === 'part.*' && b.b?.name === 'support';
  switch (a.name) {
    case 'delivery': {
      if (!delivered(q, r)) return false;
      const d = r.delivery;
      const [num, den] = d.fps.split('/').map(Number);
      const fields = { width: d.size[0], height: d.size[1], fps: num / den, frames: d.frames };
      return Object.entries(b).every(([k, v]) => k === 'output' ? v.name === 'output' : Object.hasOwn(fields, k) && fields[k] === v.value);
    }
    case 'at_rest': return !mixed && b.entity.name === 'hero' && frames.every((f, i) => !i || stable(f, frames[i - 1], 1e-6));
    case 'contact': return q.id === '3-1' && supports && frames.every(f => f.gapsM.every(g => g <= meters(b.max)));
    case 'no_intersect': return q.id === '3-1' && supports && frames.every(f => f.gapsM.every(g => -g <= (b.tol ? meters(b.tol) : 0)));
    case 'inside_frame': return b.entity.name === 'hero' && (mixed
      ? r.takes.every(t => t.boxes.length >= hi && t.boxes.slice(lo, hi).every(box => margin(box, q.deliverable.size) >= (b.margin?.value ?? 0)))
      : frames.every(f => margin(f.bounds, [1, 1]) >= (b.margin?.value ?? 0)));
    case 'camera.height': return !mixed && frames.every(f => compare(f.cameraHeightM));
    case 'cut_at': return mixed && index(b.at.value, n) && b.at.value > 0 && r.takes.every(t => !same(t.corners[b.at.value - 1], t.corners[b.at.value]));
    case 'no_ghost': return mixed && r.takes.every(t => !same(t.corners[0], t.corners.at(-1)) && t.corners.slice(lo, hi)
      .every((p, i) => same(p, lo + i < b.cut.value ? t.corners[0] : t.corners.at(-1))));
    case 'key_fill_ratio': return !mixed && b.subject.name === 'film' && frames.every(f => compare(ratio(f)));
    case 'highlight_clip_ratio': return q.id === '1-2' && b.entity.name === 'film' && frames.every(f => compare(clipRatio(f)));
    default: return false;
  }
}

// 外部题库可以换阈值、增减评分项，但不能拿别题的测量结构求值。
const metricsById = new Map([
  ['3-1', ['deliver.spec', 'assembly.settle', 'assembly.contact', 'camera.coverage']],
  ['31-1', ['overlay.tracking', 'camera.displacement', 'edit.hard-cut', 'deliver.spec']],
  ['1-2', ['assembly.excursion', 'lighting.exposure', 'material.separation', 'camera.coverage']],
]);

export function scoreLevel3(question, reading) {
  const valid = validLevel3Reading(question, reading);
  const base = question.basePredicates.map(text => ({ predicate: text, pass: valid && predicate(text, question, reading) }));
  const items = question.scoring.map(({ metric, args, weight }) => ({ metric, weight,
    pass: valid && metricsById.get(question.id).includes(metric) && judges[metric](question, reading, args ?? {}),
  }));
  const basePass = base.every(it => it.pass);
  const scoringPass = items.every(it => it.pass);
  const sum = items.reduce((acc, it) => acc + (it.pass ? it.weight : 0), 0);
  const score = Math.abs(1 - sum) < 1e-12 ? 1 : sum;
  return { valid, base, basePass, items, scoringPass, score, pass: valid && basePass && scoringPass };
}
