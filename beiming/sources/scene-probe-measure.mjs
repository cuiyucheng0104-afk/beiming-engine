import { answerQuery } from '../host/page/measure.js';

const EPS = 1e-9;
const PROJECTED_AREA_EPS = 1e-14;
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const delta = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const edit = (kind, details) => ({ kind, ...details });
const bounded = (rows) => ({ items: rows.slice(0, 50), ...(rows.length > 50 && { truncated: rows.length - 50 }) });

function cut(points, side) {
  if (!points.length) return points;
  const result = [];
  let prev = points.at(-1), a = side(prev);
  for (const point of points) {
    const b = side(point);
    if ((a < 0) !== (b < 0)) result.push(lerp(prev, point, a / (a - b)));
    if (b >= 0) result.push(point);
    prev = point;
    a = b;
  }
  return result;
}

function transformPoint(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function nonzeroProjectedArea(poly) {
  if (poly.length < 3) return false;
  const [x, y, d] = poly[0];
  for (let i = 1; i + 1 < poly.length; i++) {
    const [bx, by, bd] = poly[i], [cx, cy, cd] = poly[i + 1];
    if (Math.abs((bx / bd - x / d) * (cy / cd - y / d) - (by / bd - y / d) * (cx / cd - x / d)) > PROJECTED_AREA_EPS) return true;
  }
  return false;
}

function cameraProbe(plan, { camera, meshes, insideTriangles = 0 }) {
  const count = plan.kind === 'probe.tri-budget';
  const { view, left, right, bottom, top } = camera;
  const low = count ? camera.near : EPS;
  const high = count ? camera.far : plan.distance ?? 1;
  const planes = [
    (p) => p[2] - low, (p) => high - p[2],
    (p) => p[0] - left * p[2], (p) => right * p[2] - p[0],
    (p) => p[1] - bottom * p[2], (p) => top * p[2] - p[1],
  ];
  let triangles = insideTriangles;
  const nearest = new Map();
  for (const { names, vertices, indices, visible } of meshes) {
    if (!visible) continue;
    const viewPoints = vertices.map((p) => { const [x, y, z] = transformPoint(view, p); return [x, y, -z]; });
    for (let i = 0; i < indices.length; i += 3) {
      const poly = planes.reduce(cut, [viewPoints[indices[i]], viewPoints[indices[i + 1]], viewPoints[indices[i + 2]]]);
      if (!nonzeroProjectedArea(poly)) continue;
      triangles++;
      if (!count) {
        const depth = Math.min(...poly.map((p) => p[2]));
        if (depth < high - 1e-7 * high) for (const name of names) nearest.set(name, Math.min(nearest.get(name) ?? Infinity, depth));
      }
    }
  }
  if (count) return edit(plan.kind, { triangles, ...(plan.limit !== undefined && { limit: plan.limit, over: triangles > plan.limit }) });
  const rows = [...nearest].map(([a, depth]) => ({ a, depth })).sort((a, b) => a.depth - b.depth || (a.a < b.a ? -1 : 1));
  return edit(plan.kind, { unit: 'm', distance: high, ...bounded(rows) });
}

function section(plan, { meshes }) {
  const axis = plan.axis ?? 'y', dim = 'xyz'.indexOf(axis), offset = plan.offset ?? 0;
  const rows = new Map();
  for (const { names, vertices, indices } of meshes) {
    for (let i = 0; i < indices.length; i += 3) {
      const points = indices.slice(i, i + 3).map((j) => vertices[j]);
      const ds = points.map((p) => p[dim] - offset);
      if (ds.every((v) => Math.abs(v) <= EPS)) continue;
      const unique = [];
      function append(p) {
        const fixed = p.map((v, j) => j === dim ? offset : v);
        if (!unique.some((q) => delta(q, fixed) <= EPS)) unique.push(fixed);
      }
      for (let j = 0; j < 3; j++) {
        const k = (j + 1) % 3;
        if (Math.abs(ds[j]) <= EPS) append(points[j]);
        if (ds[j] * ds[k] < -EPS * EPS) append(lerp(points[j], points[k], ds[j] / (ds[j] - ds[k])));
      }
      if (unique.length !== 2) continue;
      const ends = unique.sort(compare);
      for (const a of names) rows.set(JSON.stringify([a, ends]), { a, ends });
    }
  }
  const items = [...rows.values()].sort((a, b) => (a.a === b.a ? compare(a.ends[0], b.ends[0]) || compare(a.ends[1], b.ends[1]) : a.a < b.a ? -1 : 1));
  return edit(plan.kind, { unit: 'm', axis, offset, ...bounded(items) });
}

export function probeFrames(plan, f) {
  if (plan.kind === 'probe.deform') return [...new Set([plan.rest ?? 0, f])];
  if (plan.kind === 'probe.footslide') return f ? [f - 1, f] : [f];
  if (plan.kind === 'probe.joint-vel') {
    const start = Math.max(0, f - (plan.window ?? 24));
    return Array.from({ length: f - start + 1 }, (_, i) => start + i);
  }
  return [f];
}

export const poseKey = (entity, bone) => bone ? `${entity}#${bone}` : entity;

export function probeTargets(plan) {
  const targets = plan.of.map((name) => ({ name, bone: plan.bone }));
  if (plan.against) targets.push(...plan.against.map((name) => ({ name, bone: plan.againstBone })));
  return targets;
}

const lowest = (points) => points.reduce((y, p) => Math.min(y, p[1]), Infinity);
const byEntity = (meshes, name) => meshes.filter((mesh) => mesh.names.includes(name));
const angle = (a, b) => {
  const sign = a.reduce((d, v, i) => d + v * b[i], 0) < 0 ? -1 : 1;
  return 4 * Math.atan2(Math.hypot(...a.map((v, i) => v - sign * b[i])), Math.hypot(...a.map((v, i) => v + sign * b[i])));
};

export function measureProbe(plan, samples, f) {
  const sample = samples.get(f), { kind, of } = plan;
  if (kind === 'probe.ground') {
    const groups = of.map((name) => [name, byEntity(sample.meshes, name).flatMap((m) => m.vertices)]).filter(([, points]) => points.length);
    return { ...answerQuery('belowGround', groups, plan.tol), kind };
  }
  if (kind === 'probe.section') return section(plan, sample);
  if (kind === 'probe.near-clip' || kind === 'probe.tri-budget') return cameraProbe(plan, sample);

  const tol = plan.tol ?? 1e-6;
  const items = of.map((a) => {
    const pose = Object.hasOwn(sample.poses, a) ? sample.poses[a] : undefined;
    if (kind === 'probe.deform') {
      const reference = samples.get(plan.rest ?? 0);
      const currentRoot = pose?.rootInverse, referenceRoot = Object.hasOwn(reference.poses, a) ? reference.poses[a].rootInverse : undefined;
      if (!currentRoot || !referenceRoot) return { a, unavailable: 'pose' };
      const now = byEntity(sample.meshes, a), rest = byEntity(reference.meshes, a);
      const byId = new Map(rest.map((mesh) => [mesh.id, mesh]));
      let value = 0;
      if (!now.length || now.length !== rest.length) return { a, unavailable: 'topology' };
      for (const mesh of now) {
        const ref = byId.get(mesh.id);
        if (!ref || ref.vertices.length !== mesh.vertices.length || ref.indices.length !== mesh.indices.length
          || ref.indices.some((index, i) => mesh.indices[i] !== index)) return { a, unavailable: 'topology' };
        mesh.vertices.forEach((point, i) => {
          value = Math.max(value, delta(transformPoint(currentRoot, point), transformPoint(referenceRoot, ref.vertices[i])));
        });
      }
      return { a, value };
    }
    if (kind === 'probe.footslide') {
      if (!pose) return { a, unavailable: 'pose' };
      const prev = samples.get(f - 1);
      const onGround = (s) => Math.abs(lowest(byEntity(s.meshes, a).flatMap((m) => m.vertices))) <= (plan.tol ?? 0.005);
      const grounded = onGround(sample);
      return { a, grounded, value: prev && Object.hasOwn(prev.poses, a) && grounded && onGround(prev)
        ? Math.hypot(pose.position[0] - prev.poses[a].position[0], pose.position[2] - prev.poses[a].position[2]) : null };
    }
    const history = [...samples.values()];
    function speed(name) {
      if (history.some((s) => !Object.hasOwn(s.poses, name))) return null;
      return history.slice(1).map((s, i) => angle(history[i].poses[name].rotation, s.poses[name].rotation));
    }
    const own = speed(poseKey(a, plan.bone)), driver = plan.against ? speed(poseKey(plan.against[0], plan.againstBone)) : null;
    if (!own) return { a, unavailable: 'pose' };
    let plateaus = 0;
    own.forEach((v, i) => { if (v <= tol && (i === 0 || own[i - 1] > tol)) plateaus++; });
    const peak = (v) => v?.length && Math.max(...v) > tol ? v.indexOf(Math.max(...v)) : null;
    const lead = peak(driver), follow = peak(own);
    return { a, value: own.at(-1) ?? null, plateaus, lagFrames: lead === null || follow === null ? null : follow - lead };
  });
  return edit(kind, { unit: kind === 'probe.joint-vel' ? 'rad/frame' : kind === 'probe.footslide' ? 'm/frame' : 'm', ...bounded(items) });
}

export function withProbeMeta(meta, probes) {
  if (!probes.length) return meta;
  return { ...meta, ext: { ...meta.ext, 'scene.probes': probes } };
}
