import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { iou } from './compare.mjs';
import { CUBES, probeObservations } from './probe-observations.mjs';

const TABLES = fileURLToPath(new URL('../../calib/table/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('fixtures/', import.meta.url));
const hash = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const vector = (v, n) => Array.isArray(v) && v.length === n && Array.from(v).every(Number.isFinite);
const range = (v, lo, hi) => Number.isFinite(v) && lo <= v && v <= hi;
const max = (xs) => xs.length ? Math.max(...xs) : NaN;
function median(xs) {
  if (!xs.length || !xs.every(Number.isFinite)) return NaN;
  const sorted = xs.toSorted((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return (sorted[mid] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2;
}

// 区间含两端；确定性两行随档位选指标，绝不互借读数。
const items = [
  ['color-linearity', '颜色线性度', { colorLinearityMaxRelErr: [0, 0.02], colorZeroMaxAbsErr: [0, 0.005] }],
  ['depth', '平面深度', { depthMedianRelErr: [0, 0.02] }],
  ['object-id-meta', '编号层与元数据包围盒', { objectIdMetaMinIou: [0.95, 1] }],
  ['normal-space', '法线空间', { normalMedianDeg: [0, 2] }],
  ['camera-convention', '相机约定', { cameraAnchorMaxPx: [0, 1] }],
  ['shuffled-order', '乱序求值', 'shuffled'],
  ['repeat-twice', '重复两遍', 'repeat'],
];
export const SUITE_ITEMS = Object.freeze(items.map(([id, title]) => Object.freeze({ id, title })));
const limitedExempt = new Set(['depth', 'object-id-meta', 'normal-space', 'camera-convention']);

function normalAngle({ expected, got } = {}) {
  if (!vector(expected, 3) || !vector(got, 3)) return NaN;
  const dot = got.reduce((sum, x, i) => sum + x * expected[i], 0);
  const len = Math.hypot(...expected) * Math.hypot(...got);
  if (!(len > 0 && Number.isFinite(len))) return NaN;
  return Math.acos(Math.max(-1, Math.min(1, dot / len))) * 180 / Math.PI;
}

// 按帧号配对，不按数组下标配。乱序要真的换序；重渲则以原顺序再采一遍。
function compareRuns(seq, run, name, tier) {
  const valid = (xs) => Array.isArray(xs) && xs.length >= (name === 'shuffled' ? 2 : 1) &&
    Array.from(xs).every((s) => Number.isSafeInteger(s?.frame) && s.frame >= 0);
  if (!valid(seq) || !valid(run) || seq.length !== run.length ||
      seq.some((s, i) => i && s.frame <= seq[i - 1].frame) ||
      run.some((s, i) => s.frame !== seq[i].frame) !== (name === 'shuffled')) return {};
  const byFrame = new Map(run.map((s) => [s.frame, s]));
  if (byFrame.size !== seq.length || !seq.every((s) => byFrame.has(s.frame))) return {};
  const hasNormals = seq.some((s) => Object.hasOwn(s, 'normalDigest')) || run.some((s) => Object.hasOwn(s, 'normalDigest'));
  let mismatches = 0, minDb = Infinity, maxFrac = 0;
  for (const first of seq) {
    const next = byFrame.get(first.frame);
    if (tier === 'hash-same-machine') {
      if (!hash(first.digest) || !hash(next.digest)) return {};
      if (hasNormals && (!hash(first.normalDigest) || !hash(next.normalDigest))) return {};
      if (first.digest !== next.digest || (hasNormals && first.normalDigest !== next.normalDigest)) mismatches++;
    } else {
      const a = first.rgb8, b = next.rgb8;
      if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length || a.length % 3) return {};
      let squared = 0, above = 0, pixelMax = 0;
      for (let i = 0; i < a.length; i++) {
        if (![a[i], b[i]].every((x) => Number.isInteger(x) && range(x, 0, 255))) return {};
        const d = Math.abs(a[i] - b[i]);
        squared += d * d; pixelMax = Math.max(pixelMax, d);
        if (i % 3 === 2) { if (pixelMax > 5) above++; pixelMax = 0; }
      }
      minDb = Math.min(minDb, 10 * Math.log10(255 ** 2 / (squared / a.length)));
      maxFrac = Math.max(maxFrac, above / (a.length / 3));
    }
  }
  return tier === 'hash-same-machine' ? { [`${name}MaxDiff`]: mismatches }
    : { [`${name}PsnrDb`]: minDb, [`${name}FracAbove5`]: maxFrac };
}

export function evaluateSourceConformance({ source, machine = null, conformance = 'full', determinism, readings, observations = {} }) {
  if (!['full', 'limited'].includes(conformance)) throw new RangeError('未知合规档');
  if (conformance === 'limited' && source !== 'legacy-page' && !(typeof source === 'string' && /^ext\.[a-z0-9][a-z0-9-]*$/.test(source))) {
    throw new RangeError('只有 legacy-page 和 ext.<名字> 可使用 limited 合规档');
  }
  if (!['hash-same-machine', 'tolerance'].includes(determinism)) throw new RangeError('未知确定性档');
  const values = { ...readings };
  observations ??= {};
  if (['three', 'blender'].includes(source) || Object.hasOwn(observations, 'objectIdMetaIous')) {
    const ious = Object.hasOwn(observations, 'objectIdMetaIous') ? observations.objectIdMetaIous : readings?.objectIdMetaIous;
    const overlaps = CUBES.map((name) => ious && Object.hasOwn(ious, name) ? ious[name] : null);
    values.objectIdMetaMinIou = overlaps.every((v) => range(v, 0, 1)) ? Math.min(...overlaps) : NaN;
  }
  if (Object.hasOwn(observations, 'normals')) values.normalMedianDeg = Array.isArray(observations.normals)
    ? median(Array.from(observations.normals, (v) => v ? normalAngle(v) : NaN)) : NaN;
  for (const name of ['shuffled', 'repeat']) {
    if (Object.hasOwn(observations, name)) {
      // 提供原始观测时只信重算结果，不能让外面附带的汇总掩盖坏帧。
      for (const metric of ['MaxDiff', 'PsnrDb', 'FracAbove5']) delete values[`${name}${metric}`];
      Object.assign(values, compareRuns(observations.sequential, observations[name], name, determinism));
    }
  }
  const rows = items.map(([id, title, rule]) => {
    const threshold = typeof rule !== 'string' ? Object.fromEntries(Object.entries(rule).map(([k, bounds]) => [k, [...bounds]])) : determinism === 'hash-same-machine'
      ? { [`${rule}MaxDiff`]: [0, 0] }
      : { [`${rule}PsnrDb`]: [50, null], [`${rule}FracAbove5`]: [0, 0.001] };
    if (conformance === 'limited' && limitedExempt.has(id)) {
      return { id, title, status: 'exempt', measured: null, threshold, reason: 'limited 档免测此项' };
    }
    const measured = {}, errors = [];
    for (const [key, [lo, hi]] of Object.entries(threshold)) {
      const v = values[key];
      // 完全相同的像素 PSNR 为正无穷；报告仍可无损写成 JSON。
      const infinitePsnr = hi === null && v === Infinity;
      measured[key] = infinitePsnr ? '+Infinity' : Number.isFinite(v) ? v : null;
      if (!infinitePsnr && !range(v, lo, hi ?? Infinity)) errors.push(`${key} ${Number.isFinite(v) ? '超出阈值' : '缺失或无效'}`);
    }
    return { id, title, status: errors.length ? 'fail' : 'pass', measured, threshold,
      ...(errors.length && { reason: errors.join('；') }) };
  });
  return { source, machine, conformance, determinism, ok: rows.every((r) => r.status !== 'fail'), rows };
}

function repeatReadings(records, source, tier) {
  const hashes = records.filter((r) => r.unit === 'sha256');
  const key = (r) => `${r.scene}/${r.what.split(' ')[0]}`;
  if (new Set(hashes.map(key)).size !== (source === 'three' ? 6 : 21) || new Set(hashes.map(key)).size !== hashes.length) return {};
  if (source === 'three') return { repeatMaxDiff: hashes.filter((r) => r.expected !== '相同' || r.got !== '相同').length };
  if (!hashes.every((r) => hash(r.expected) && hash(r.got))) return {};
  const different = hashes.filter((r) => r.expected !== r.got);
  if (tier === 'hash-same-machine') return { repeatMaxDiff: different.length };
  // 每一个哈希不同的文件都必须有它自己的两项指标，不能从别的文件补数。
  const psnr = [], fractions = [];
  for (const h of different) {
    const pair = records.filter((r) => key(r) === key(h));
    const db = pair.filter((r) => r.unit.startsWith('dB') && r.what.includes('PSNR'));
    const frac = pair.filter((r) => r.unit === 'ratio' && r.what.includes('差 5 级'));
    if (db.length !== 1 || frac.length !== 1) return {};
    const value = db[0].got === '无穷大（截到 0 到 1 后差为 0）' ? Infinity : db[0].got;
    if ((!Number.isFinite(value) && value !== Infinity) || !range(frac[0].got, 0, 1)) return {};
    psnr.push(value); fractions.push(frac[0].got);
  }
  return { repeatPsnrDb: Math.min(Infinity, ...psnr), repeatFracAbove5: Math.max(0, ...fractions) };
}

function tableReadings(column, source, tier) {
  const select = (name, scene) => {
    const rows = Array.isArray(column.rows) ? column.rows.filter((r) => r?.row === name && r.status === 'measured') : [];
    if (rows.length !== 1 || !Array.isArray(rows[0].readings)) return [];
    return rows[0].readings.filter((r) => typeof r?.what === 'string' && typeof r.unit === 'string' && (!scene || r.scene === scene));
  };
  const complete = (rows, count) => rows.length === count && new Set(rows.map((r) => r.what)).size === count;
  const colors = select('颜色层的线性度', 'probe-gray-chart').filter((r) => r.unit === 'linear');
  const relative = [], zero = [];
  if (complete(colors, 32) && colors.every((r) => vector(r.expected, 3) && vector(r.got, 3))) {
    for (const { expected, got } of colors) expected.forEach((x, i) => {
      if (x === 0) zero.push(Math.abs(got[i]));
      else relative.push(Math.abs((got[i] - x) / x));
    });
  }
  const planes = select('深度口径', 'probe-plane-steps').filter((r) => r.unit === 'm' && /planeDepthM|vs 平面深度/.test(r.what));
  // P7 存了各方块的单独渲原始框，P8 旧表只有合渲框，单独渲须由该机的补测提供。
  const objectIdMetaIous = {};
  if (source === 'three') {
    const occlusion = select('可见比例的成本', 'probe-occlusion');
    for (const name of CUBES) {
      const boxes = occlusion.filter((r) => r.unit === 'px' && r.what === `${name} 单独渲编号层反算包围盒 [x0, y0, x1, y1]`);
      if (boxes.length === 1 && vector(boxes[0].expected, 4) && vector(boxes[0].got, 4)) {
        objectIdMetaIous[name] = iou(boxes[0].expected, boxes[0].got);
      }
    }
  }
  const anchors = select('坐标与相机', 'probe-axes-turntable').filter((r) => r.unit === 'px' &&
    /单独渲编号层|渲染·/.test(r.what));
  const projectionError = ({ expected, got }) => {
    const n = expected?.length;
    if (![2, 4].includes(n) || !vector(expected, n) || !vector(got, n)) return NaN;
    const diff = got.map((x, i) => Math.abs(x - expected[i]));
    return n === 2 ? Math.hypot(...diff) : max(diff);
  };
  return {
    colorLinearityMaxRelErr: max(relative), colorZeroMaxAbsErr: max(zero),
    depthMedianRelErr: complete(planes, 8) ? median(planes.map(({ expected, got }) =>
      Number.isFinite(expected) && expected > 0 && Number.isFinite(got) ? Math.abs((got - expected) / expected) : NaN)) : NaN,
    objectIdMetaIous,
    cameraAnchorMaxPx: complete(anchors, source === 'three' ? 10 : 13) ? max(anchors.map(projectionError)) : NaN,
    ...repeatReadings(select('确定性'), source, tier),
  };
}

function optionalJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return null; }
}

export function loadProbeSuiteReport(source, { machine = 'mac', conformance = 'full', tableDir = TABLES } = {}) {
  if (!['three', 'blender'].includes(source) || !['mac', 'linux-5090'].includes(machine)) throw new RangeError('未知探针表或机器');
  if (conformance !== 'full') throw new RangeError('Three 与 Blender 探针列要求 full 合规档');
  const column = optionalJson(join(tableDir, `${source}${machine === 'mac' ? '' : `.${machine}`}.json`));
  const supplement = optionalJson(join(tableDir === TABLES ? FIXTURES : tableDir, `v4-${source}.${machine}.json`));
  if (column && (column.machine !== machine || column.format !== 'probe-column/0.1' ||
      (source === 'three' ? column.source !== 'three' : !column.source?.startsWith('blender-cycles')))) throw new Error('探针列的机器、来源或格式不匹配');
  if (supplement && (supplement.machine !== machine || supplement.source !== source || supplement.format !== 'v4-probe/0.1')) {
    throw new Error('补测记录的机器、来源或格式不匹配');
  }
  const determinism = source === 'blender' && machine === 'linux-5090' ? 'tolerance' : 'hash-same-machine';
  const observations = supplement ? probeObservations(supplement, column) : {};
  return evaluateSourceConformance({ source, machine, conformance, determinism,
    readings: column ? tableReadings(column, source, determinism) : {}, observations });
}
