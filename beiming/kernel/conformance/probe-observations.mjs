// V4 补测的离线核验。只依赖校准规格，不启动帧源，也不采用录制脚本写的摘要作判定。
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { cameraBasis, objectTransform, raycast } from '../../calib/check.mjs';
import { stream, streamName } from '../eval/rng.mjs';
import { boundsOf, iou } from './compare.mjs';

const scene = (name) => JSON.parse(readFileSync(new URL(`../../calib/${name}/scene.json`, import.meta.url), 'utf8'));
const SCENE = scene('probe-axes-turntable'), OCCLUSION = scene('probe-occlusion');
export const FRAMES = Object.freeze([0, 12, 24, 36, 48]), SEED = 20261122, SHOT = 's01';
export const CUBES = Object.freeze(OCCLUSION.objects.map((o) => o.id));
const entityIds = [...CUBES].sort(); // 帧源将全部实体名按字节序从 1 编号，与规格的 idIndex 不是一回事。
const INTERIOR = [-0.75, 0, 0.75].flatMap((dx) => [-0.75, 0, 0.75].map((dy) => [dx, dy]));
export const { widthPx: W, heightPx: H } = SCENE.camera;
const BASIS = cameraBasis(SCENE.camera);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const n = Math.hypot(...a); return n > 0 ? a.map((v) => v / n) : [0, 0, 0]; };
export const deg = (a, b) => (Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * 180) / Math.PI;
export const toCamera = (n) => [dot(n, BASIS.right), dot(n, BASIS.up), -dot(n, BASIS.fwd)];
const sameArray = (a, b) => Array.isArray(a) && a.length === b.length && b.every((v, i) => a[i] === v);
const hex = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);

/** 像素中心与周围八个点都打到同一端头球，才是这个球的内部样本。 */
function sphereNormalAt(x, y, t) {
  const first = (px) => raycast(SCENE, px, t)[0] ?? null;
  const hit = first([x + 0.5, y + 0.5]);
  const o = SCENE.objects.find((s) => s.id === hit?.objectId);
  if (o?.shape !== 'sphere' || !INTERIOR.every(([dx, dy]) => first([x + 0.5 + dx, y + 0.5 + dy])?.objectId === o.id)) return null;
  const { fwd, right, up, f } = BASIS;
  const d = [0, 1, 2].map((i) => right[i] * (x + 0.5 - W / 2) / f - up[i] * (y + 0.5 - H / 2) / f + fwd[i]);
  const p = SCENE.camera.positionM.map((v, i) => v + hit.planeDepthM * d[i]);
  const center = objectTransform(o, t).T;
  return { object: o.id, world: unit(p.map((v, i) => v - center[i])) };
}

export function spherePixels(t) {
  const out = [], { right, up, fwd, f } = BASIS;
  for (const o of SCENE.objects.filter((s) => s.shape === 'sphere')) {
    const d = objectTransform(o, t).T.map((v, i) => v - SCENE.camera.positionM[i]), z = dot(d, fwd);
    const cx = W / 2 + f * dot(d, right) / z, cy = H / 2 - f * dot(d, up) / z, rad = Math.ceil(f * o.radiusM / z) + 2;
    for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(H - 1, Math.ceil(cy + rad)); y++) {
      for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(W - 1, Math.ceil(cx + rad)); x++) {
        const hit = sphereNormalAt(x, y, t);
        if (hit) out.push({ x, y, ...hit });
      }
    }
  }
  return out;
}

export function shuffledFrames() {
  const s = stream(streamName(SEED, SHOT, 'conformance/shuffle')), out = [...FRAMES];
  do {
    for (let i = out.length - 1; i > 0; i--) { const j = s.u32() % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  } while (out.every((v, i) => v === FRAMES[i]));
  return out;
}

// 离线加载多张表只需求交一次；每次都核对完整的像素集合，不能用重复样本补数。
let expectedNormals;
function validNormalSamples(samples) {
  expectedNormals ??= new Map(FRAMES.flatMap((f) => spherePixels(f).map((p) =>
    [`${f}/${p.object}@${p.x},${p.y}`, toCamera(p.world)])));
  if (!Array.isArray(samples) || samples.length !== expectedNormals.size) return false;
  const unseen = new Map(expectedNormals);
  const unitVector = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) && Math.abs(Math.hypot(...v) - 1) < 1e-3;
  for (const n of samples) {
    if (typeof n?.object !== 'string' || !Number.isSafeInteger(n.frame) || !Array.isArray(n.pixel) || n.pixel.length !== 2 || !n.pixel.every(Number.isSafeInteger)) return false;
    const key = `${n.frame}/${n.object}@${n.pixel}`, expected = unseen.get(key);
    if (!expected || !unitVector(n.expected) || !unitVector(n.got) || deg(expected, n.expected) >= 1e-3) return false;
    unseen.delete(key);
  }
  return unseen.size === 0;
}

function validTurntableOrder(rec) {
  const shuffled = shuffledFrames();
  const matches = (run, frames) => Array.isArray(run) && run.length === frames.length && frames.every((f, i) => run[i]?.frame === f);
  if (!sameArray(rec.frameOrder?.sequential, FRAMES) || !sameArray(rec.frameOrder?.shuffled, shuffled) ||
      !matches(rec.sequential, FRAMES) || !matches(rec.shuffled, shuffled)) return false;
  const runs = [...rec.sequential, ...rec.shuffled];
  if (rec.source === 'blender' && rec.machine === 'linux-5090') {
    const first = rec.sequential[0].rgb8;
    return runs.every(({ rgb8 }) => Array.isArray(rgb8) && rgb8.length === W * H * 3 &&
      rgb8.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) && rec.sequential.some(({ rgb8 }) => rgb8.some((v, i) => v !== first[i]));
  }
  return runs.every((r) => hex(r.digest) && hex(r.normalDigest)) && new Set(rec.sequential.map((r) => r.digest)).size > 1;
}

// runs 只存非零的最大连续段 [起始下标, 长度]。零背景、左上原点、逐行、小端 uint32 与帧源层文件完全相同。
function cubeIou(row, name, w, h) {
  if (row?.id !== entityIds.indexOf(name) + 1 || !hex(row.pixelSha256) || !Array.isArray(row.runs) || !row.runs.length || row.runs.length > w * h / 2) return null;
  const box = row.metaBBox;
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite) ||
      !(0 <= box[0] && box[0] < box[2] && box[2] <= w && 0 <= box[1] && box[1] < box[3] && box[3] <= h)) return null;
  const bytes = Buffer.alloc(w * h * 4);
  let end = -1;
  for (const run of row.runs) {
    if (!Array.isArray(run) || run.length !== 2) return null;
    const [start, count] = run;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start <= end || count <= 0 || start + count > w * h) return null;
    end = start + count;
    for (let i = start; i < end; i++) bytes.writeUInt32LE(row.id, i * 4);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== row.pixelSha256) return null;
  const b = boundsOf(w, h, (i) => bytes.readUInt32LE(i * 4) === row.id);
  return iou(b && [b.x0, b.y0, b.x1 + 1, b.y1 + 1], box); // 包围盒用像素外沿。
}

function cubeIous(evidence) {
  const { widthPx: w, heightPx: h } = OCCLUSION.camera;
  if (evidence?.scene !== OCCLUSION.id || evidence.frame !== 0 || !sameArray(evidence.size, [w, h]) ||
      !Array.isArray(evidence.objects) || evidence.objects.length > CUBES.length) return {};
  return Object.fromEntries(CUBES.map((name) => {
    const rows = evidence.objects.filter((r) => r?.name === name);
    return [name, rows.length === 1 ? cubeIou(rows[0], name, w, h) : null];
  }));
}

function validProvenance(rec, column) {
  if (rec?.format !== 'v4-probe/0.1' || !['three', 'blender'].includes(rec.source) || !['mac', 'linux-5090'].includes(rec.machine)) return false;
  const p = rec.provenance, mac = rec.machine === 'mac';
  if (typeof p?.platform !== 'string' || !(mac ? /^darwin [\d.]+ (arm64|x64)$/ : /^linux [\w.+-]+ x64$/).test(p.platform) ||
      typeof p.sourceVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(p.sourceVersion)) return false;
  if (column && (column.machine !== rec.machine || typeof column.version !== 'string' || p.sourceVersion !== column.version.split(' ')[0])) return false;
  return rec.source !== 'blender' || p.device?.backend === (mac ? 'CPU' : 'OPTIX');
}

/** 各行独立。编号层证据坏了不连累转台；法线坏了不连累帧序。上层负责按阈值判通过。 */
export function probeObservations(rec, column) {
  if (!validProvenance(rec, column)) return {};
  const turntable = rec.geometry?.scene === 'beiming/calib/probe-axes-turntable/scene.json' && sameArray(rec.geometry.size, [W, H]);
  return { normals: turntable && validNormalSamples(rec.normals) ? rec.normals : null, sequential: rec.sequential,
    shuffled: turntable && validTurntableOrder(rec) ? rec.shuffled : null,
    ...(rec.source === 'blender' && { objectIdMetaIous: cubeIous(rec.objectIdEvidence) }) };
}
