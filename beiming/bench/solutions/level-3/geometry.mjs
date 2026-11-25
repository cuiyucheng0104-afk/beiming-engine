// Offline geometry witnesses: the authored solids are exact, unrotated box meshes. Sample
// the source trajectories, then independently project their corners and intersect camera rays.
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { evaluate as fit } from '../../../cards/camera/fit/evaluate.mjs';

const HERE = import.meta.dirname;
const PYTHON = path.resolve(HERE, '..', '..', '..', '..', 'tools', 'env', 'py.mjs');
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, x, j) => s + x * b[j], 0);
const unit = a => a.map(x => x / Math.hypot(...a));
const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];

function view(pos, target, fov, aspect) {
  const front = unit(sub(target, pos)), right = unit(cross(front, [0, 1, 0])), up = cross(right, front);
  const ky = Math.tan(fov * Math.PI / 360), kx = ky * aspect;
  return { pos, front, right, up, kx, ky };
}

function corners(box) {
  return Array.from({ length: 8 }, (_, i) => box.min.map((x, j) => (i & (1 << j)) ? box.max[j] : x));
}

function projectedBounds(boxes, { pos, front, right, up, kx, ky }) {
  const xs = [], ys = [];
  for (const p of boxes.flatMap(corners)) {
    const v = sub(p, pos), depth = dot(front, v);
    if (!(depth > 0)) throw new RangeError('标准工程网格越过相机平面');
    xs.push(0.5 + 0.5 * dot(right, v) / (depth * kx));
    ys.push(0.5 - 0.5 * dot(up, v) / (depth * ky));
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function gap(a, b) {
  // Exact signed separation of these two axis-aligned convex polyhedra: Euclidean
  // closest distance if separated; least separating translation if intersecting.
  const delta = a.min.map((x, j) => Math.max(x - b.max[j], b.min[j] - a.max[j]));
  return Math.max(...delta) <= 0 ? Math.max(...delta) : Math.hypot(...delta.map(x => Math.max(0, x)));
}

function firstFace({ min, max }, pos, dir) {
  let near = 0, far = Infinity, face = -1;
  for (let j = 0; j < 3; j++) {
    if (dir[j] === 0) {
      if (pos[j] < min[j] || pos[j] > max[j]) return null;
      continue;
    }
    const lo = (min[j] - pos[j]) / dir[j], hi = (max[j] - pos[j]) / dir[j];
    const t = Math.min(lo, hi);
    if (t > near) { near = t; face = j * 2 + Number(lo > hi); }
    far = Math.min(far, Math.max(lo, hi));
    if (far < near) return null;
  }
  return face < 0 ? null : { near, face };
}

function raster(boxes, shades, camera) {
  // Uniform stratified samples of the *entire* frame, not a subject-only crop. The
  // same depth test yields the material-ID mask used for the three luminance ROIs.
  const { pos, front, right, up, kx, ky } = camera;
  const w = 48, h = 27, pixels = Buffer.alloc(w*h), mask = Buffer.alloc(w*h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = ((2*x + 1)/w - 1)*kx, v = (1 - (2*y + 1)/h)*ky;
    const dir = front.map((z, j) => z + u*right[j] + v*up[j]);
    let closest = Infinity, id = -1, face;
    for (let i = 0; i < boxes.length; i++) {
      const hit = firstFace(boxes[i], pos, dir);
      if (hit && hit.near < closest) { closest = hit.near; id = i; face = hit.face; }
    }
    if (id !== -1) {
      const value = Math.round(255 * Math.min(1, Math.max(0, shades[id][face])));
      pixels[y*w + x] = value;
      mask[y*w + x] = id + 1;
    }
  }
  return { lumaRaster: pixels.toString('base64'), materialMask: mask.toString('base64') };
}

function sample(film, disabled) {
  const result = spawnSync(process.execPath, [PYTHON, '-I', '-B', path.join(HERE, 'geometry.py')], {
    input: JSON.stringify({ film, disabled }), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`离线几何计算失败：${result.stderr.trim()}`);
  const { frames, rest } = JSON.parse(result.stdout);
  const { size, fps } = film.output, aspect = size[0] / size[1];
  const [shot] = film.shots, { solids, fixedCamera } = shot.params;
  const boxes = frames.map(({ positions }) => positions.map((c, i) => ({
    min: sub(c, solids[i].half), max: c.map((x, j) => x + solids[i].half[j]),
  })));
  const bboxes = boxes.map(row => ({ min: [0, 1, 2].map(j => Math.min(...row.map(b => b.min[j]))),
    max: [0, 1, 2].map(j => Math.max(...row.map(b => b.max[j]))) }));
  const fitParams = disabled === 'camera.fit' ? null : shot.cards.find(c => c.use === 'camera.fit@1')?.params;
  const params = fitParams && { ...fitParams, aspect, bboxes };
  for (const [f, row] of frames.entries()) {
    const { camera, target } = params ? fit({}, params, f) : { camera: fixedCamera, target: fixedCamera.target };
    const pose = view(camera.pos, target, camera.fovDeg, aspect);
    row.bounds = projectedBounds(boxes[f], pose);
    row.cameraHeightM = camera.pos[1];
    if (row.faceShades) {
      Object.assign(row, raster(boxes[f], row.faceShades, pose));
      delete row.faceShades;
    } else {
      row.gapsM = boxes[f].map((box, i, list) => i === 0 ? box.min[1] : gap(box, list[i - 1]));
    }
  }
  return { output: { size, fps, frames: frames.length, audio: film.audio.mode }, rest, frames };
}

// The reference exam revisits identical films with different scoring thresholds. Cache only
// computed observations, never verdicts; use full film contents and give callers isolated copies.
const cache = new Map();
export function buildGeometryReading(question, film, disabled = null) {
  if (question.id !== film.exam || !['3-1', '1-2'].includes(film.exam)) throw new Error('题号与几何标准工程不符');
  const key = JSON.stringify([film, disabled]);
  if (!cache.has(key)) {
    const reading = sample(film, disabled);
    if (cache.size >= 12) cache.delete(cache.keys().next().value);
    cache.set(key, reading);
  }
  return globalThis.structuredClone(cache.get(key));
}
