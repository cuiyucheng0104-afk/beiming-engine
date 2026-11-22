// 可控与可复现的两项回归作业（04 §12、07 V14）：
// 局部性回归（改一个参数，实际变了的帧必须全落在 explainParam 预测的 affects 里）、
// 加锁重建回归（同一份片子描述加同一份锁独立重渲两遍，哈希档逐帧逐位相同，容差档守 P8 口径），
// 外加进看板「可控与可复现」栏的一行记录。帧对象是 { frame, width, height, color, channels?, shot? }。
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { explainParam } from '../kernel/explain.mjs';
import { applyFilmWrite, getFilmRev } from '../kernel/patch-apply.mjs';
import { digestOf } from './l2.mjs';

/** P8 的容差口径：PSNR 不低于 50 dB，且单像素最大通道差超过 5/255 的像素不多于 0.1% */
export const P8_PSNR_MIN_DB = 50;
export const P8_MAX_DIFF_FRAC = 0.001;
export const P8_DIFF_LEVEL = 5 / 255;

const { validate } = await loadContracts();
const TIERS = ['hash', 'hash-same-machine', 'tolerance'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ints = (v) => Array.isArray(v) && v.every((n) => Number.isSafeInteger(n) && n >= 0);
function deepFreeze(v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) Object.values(Object.freeze(v)).forEach(deepFreeze);
  return v;
}

/* ---------------- 帧对比较 ---------------- */

// 8 位整数按 ÷255 归一，浮点和普通数组按 [0, 1] 标尺直接比；别的类型不收
const scaleOf = (c) => (c instanceof Uint8Array || c instanceof Uint8ClampedArray ? 255
  : c instanceof Float32Array || c instanceof Float64Array || Array.isArray(c) ? 1 : 0);

function readFrame(frame, who) {
  if (!isObj(frame)) throw new TypeError(`${who}不是帧对象 { width, height, color, channels? }`);
  const { width, height, color } = frame;
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) throw new RangeError(`${who}的宽高必须是正整数`);
  const scale = scaleOf(color);
  if (!scale) throw new TypeError(`${who}的 color 只收 Uint8Array、Uint8ClampedArray、Float32Array、Float64Array 和数的数组`);
  if (Array.isArray(color)) {
    for (let i = 0; i < color.length; i++) if (!Object.hasOwn(color, i) || typeof color[i] !== 'number') throw new TypeError(`${who}的 color 第 ${i} 项是空洞或不是数`);
  }
  const channels = frame.channels ?? color.length / (width * height);
  if (![1, 3, 4].includes(channels)) throw new RangeError(`${who}的通道数只收 1、3、4`);
  if (color.length !== width * height * channels) throw new RangeError(`${who}的 color 长度应是 ${width} × ${height} × ${channels}`);
  return { width, height, channels, color, scale };
}

function diffFrames(frameA, frameB, diffLevel, where = '') {
  if (!Number.isFinite(diffLevel) || diffLevel < 0) throw new RangeError('diffLevel 必须是 ≥ 0 的有限数');
  const a = readFrame(frameA, `${where}前一幅`), b = readFrame(frameB, `${where}后一幅`);
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
    throw new RangeError(`${where}两幅尺寸不一致：${a.width}×${a.height}×${a.channels} 对 ${b.width}×${b.height}×${b.channels}`);
  }
  if (a.color.constructor !== b.color.constructor) throw new TypeError(`${where}两幅的数组类型不同，字节没法比`);
  const totalPixels = a.width * a.height;
  let sum = 0, maxAbsDiff = 0, gt5Pixels = 0;
  for (let p = 0, i = 0; p < totalPixels; p++) {
    let worst = 0;
    for (let c = 0; c < a.channels; c++, i++) {
      const x = a.color[i], y = b.color[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError(`${where}第 ${i} 个分量不是有限数`);
      const d = Math.abs(x - y) / a.scale;
      sum += d * d;
      if (d > worst) worst = d;
    }
    if (worst > diffLevel) gt5Pixels++;
    if (worst > maxAbsDiff) maxAbsDiff = worst;
  }
  const mse = sum / (totalPixels * a.channels);
  const sha256A = digestOf(a.color), sha256B = digestOf(b.color);
  return Object.freeze({
    identical: sha256A === sha256B, sha256A, sha256B,
    mse, psnrDb: mse === 0 ? Infinity : 10 * Math.log10(1 / mse), maxAbsDiff,
    gt5Pixels, totalPixels, fracGt5: gt5Pixels / totalPixels,
  });
}

/**
 * 比两幅帧。identical 看颜色层字节的 SHA-256（哈希档用，+0 与 −0 算不同）；
 * mse、psnrDb 对全部分量算，gt5Pixels 是「任一通道差严格大于 diffLevel」的像素数（容差档用）。
 * 坏输入一律抛错：结构、类型不对抛 TypeError，宽高、通道数、长度、尺寸不一致、NaN 或无穷抛 RangeError。
 */
export function compareFramePair(frameA, frameB, options = {}) {
  return diffFrames(frameA, frameB, options?.diffLevel ?? P8_DIFF_LEVEL);
}

/* ---------------- 两项作业共用的校验 ---------------- */

function needGate(tier, { psnrMinDb, maxDiffFrac, diffLevel }) {
  if (!TIERS.includes(tier)) throw new RangeError(`tier 只收 ${TIERS.join('、')}`);
  if (typeof psnrMinDb !== 'number' || Number.isNaN(psnrMinDb)) throw new RangeError('psnrMinDb 必须是数');
  if (!(maxDiffFrac >= 0 && maxDiffFrac <= 1)) throw new RangeError('maxDiffFrac 必须在 [0, 1] 内');
  if (!Number.isFinite(diffLevel) || diffLevel < 0) throw new RangeError('diffLevel 必须是 ≥ 0 的有限数');
  return { hash: tier !== 'tolerance', within: (cmp) => cmp.psnrDb >= psnrMinDb && cmp.fracGt5 <= maxDiffFrac };
}

function contractErrors(obj) {
  const r = validate(obj);
  return [...r.schemaErrors, ...Object.values(r.violations).flat()];
}

function needFilm(film) {
  if (!isObj(film) || film.format !== 'film/3.0') throw new TypeError('片子描述不是 film/3.0');
  const errors = contractErrors(film);
  if (errors.length) throw new Error(`片子描述不合 film/3.0 契约：${errors.join('；')}`);
}

/** 渲染器交回的帧按帧号排好：[0, total) 每帧正好一幅，缺帧、重复、越界都抛错 */
function frameList(result, total, who) {
  if (!Array.isArray(result)) throw new TypeError(`${who}没有交回帧数组`);
  const out = new Array(total);
  for (const frame of result) {
    if (!isObj(frame)) throw new TypeError(`${who}交回的帧不是对象`);
    if (!Number.isSafeInteger(frame.frame) || frame.frame < 0 || frame.frame >= total) throw new RangeError(`${who}交回的帧号 ${frame.frame} 不在 [0, ${total}) 内`);
    if (out[frame.frame]) throw new Error(`${who}的第 ${frame.frame} 帧重复`);
    out[frame.frame] = frame;
  }
  for (let f = 0; f < total; f++) if (!out[f]) throw new Error(`${who}缺第 ${f} 帧`);
  return out;
}

/* ---------------- 局部性回归 ---------------- */

/**
 * 局部性回归：把 patch（patch/0.1）作用到 film 上，改动前后各调一次 renderFilm(片子描述的副本, { phase: 'before' | 'after' })，
 * 交回全片 [0, output.frames) 的帧数组；实际变了的帧必须全落在预测的影响范围里。
 * 预测：补丁每个操作的路径（rename 另加新路径）在改动前、改动后的片子描述上各问一次 explainParam，取并集；
 * 一帧算在范围里，要帧号落在某条预测的半开区间里、它所在的镜头在那条预测的镜头表里；帧上标了 shot 的，标的镜头也得在里面。
 * 算不算「变了」：哈希档（hash、hash-same-machine）看字节，容差档（tolerance）看是否超出 P8 口径。
 * 判定：有变化帧落在范围外是 leaked-outside-affects；一帧都没变是 no-frames-changed（allowNoOp 为真时放行）；否则 ok。
 */
export async function runLocalityTest({
  film, patch, renderFilm, explainContext = {}, tier = 'hash', allowNoOp = false,
  psnrMinDb = P8_PSNR_MIN_DB, maxDiffFrac = P8_MAX_DIFF_FRAC, diffLevel = P8_DIFF_LEVEL,
} = {}) {
  if (typeof renderFilm !== 'function') throw new TypeError('renderFilm 必须是函数');
  if (typeof allowNoOp !== 'boolean') throw new TypeError('allowNoOp 必须是布尔值');
  const gate = needGate(tier, { psnrMinDb, maxDiffFrac, diffLevel });
  needFilm(film);
  if (!isObj(patch)) throw new TypeError('补丁必须是 patch/0.1 对象');
  const written = applyFilmWrite(film, patch, { rev: getFilmRev(film) ?? patch.rev });
  if (!written.ok) throw new Error(`补丁作用不上（第 ${written.step} 步 ${written.code}）：${written.message}`);
  const after = written.film, total = film.output.frames;
  if (after.output.frames !== total) throw new RangeError('补丁改了总帧数，前后没法逐帧比');

  const paths = [...new Set(patch.ops.flatMap((op) => (op.op === 'rename' ? [op.path, op.path.slice(0, op.path.lastIndexOf('/') + 1) + op.to] : [op.path])))];
  const affects = [];
  for (const path of paths) {
    let found = 0, why;
    // 新加的键改动前问不到，删掉的键改动后问不到：两边各问一次，问到的都算
    for (const doc of [film, after]) {
      try {
        affects.push({ ...explainParam(doc, path, explainContext).affects, table: doc.shots });
        found++;
      } catch (err) {
        why = err;
      }
    }
    if (!found) throw new Error(`参数 ${path} 改动前后都说不出影响范围：${why.message}`, { cause: why });
  }
  const inside = (f, labels = []) => affects.some(({ shots, frameRange: [from, to], table }) => from <= f && f < to
    && table.some((s) => s.in <= f && f < s.out && shots.includes(s.id)) && labels.every((id) => shots.includes(id)));
  const predicted = {
    shots: [...new Set(affects.flatMap((a) => a.shots))],
    frameRanges: [...new Set(affects.map((a) => JSON.stringify(a.frameRange)))].map((s) => JSON.parse(s)),
    frameCount: Array.from({ length: total }, (_, f) => f).filter((f) => inside(f)).length,
  };

  const before = frameList(await renderFilm(structuredClone(film), { phase: 'before' }), total, '改动前那一遍');
  const now = frameList(await renderFilm(structuredClone(after), { phase: 'after' }), total, '改动后那一遍');
  const changedFrames = [], leakedFrames = [];
  let unchangedOutsideCount = 0;
  for (let f = 0; f < total; f++) {
    const cmp = diffFrames(before[f], now[f], diffLevel, `第 ${f} 帧`);
    const changed = gate.hash ? !cmp.identical : !gate.within(cmp);
    if (!changed) {
      if (!inside(f)) unchangedOutsideCount++;
      continue;
    }
    changedFrames.push(f);
    if (!inside(f, [before[f].shot, now[f].shot].filter((id) => id !== undefined))) leakedFrames.push(f);
  }
  const reason = leakedFrames.length ? 'leaked-outside-affects' : !changedFrames.length && !allowNoOp ? 'no-frames-changed' : 'ok';
  return deepFreeze({
    format: 'locality-regression/0.1', pass: reason === 'ok', reason, filmId: film.id, tier, allowNoOp, paths,
    predicted, totalFrames: total, changedFrames, leakedFrames, unchangedOutsideCount,
  });
}

/* ---------------- 加锁重建回归 ---------------- */

/**
 * 加锁重建回归：同一份 film 加同一份 lock，调两次 renderLocked(片子描述的副本, 锁的副本, { run: 1 | 2 })，两遍必须是独立重渲。
 * 每遍交回全片的帧数组，或 { frames, deliverables }（deliverables 是「文件名 → 哈希字符串」）。
 * 哈希档：每帧颜色层逐位相同，deliverables 逐键相同；容差档：每帧 PSNR ≥ psnrMinDb 且超差像素比例 ≤ maxDiffFrac，不比 deliverables。
 * 开渲之前就拒：缺锁、锁不合 lock/1.0、锁的片号或修订号和片子描述对不上。
 * shortcut: 不跑 lock-check 的跨文件不变量（一致性夹具的锁是只钉帧源的部分锁，过不了），要查锁钉没钉全时由调用方先过 lock-check/0.1。
 */
export async function runRebuildTest({
  film, lock, renderLocked, tier = 'hash-same-machine',
  psnrMinDb = P8_PSNR_MIN_DB, maxDiffFrac = P8_MAX_DIFF_FRAC, diffLevel = P8_DIFF_LEVEL,
} = {}) {
  if (typeof renderLocked !== 'function') throw new TypeError('renderLocked 必须是函数');
  const gate = needGate(tier, { psnrMinDb, maxDiffFrac, diffLevel });
  needFilm(film);
  if (!isObj(lock)) throw new TypeError('缺锁：加锁重建要带和片子描述配套的锁');
  if (lock.format !== 'lock/1.0') throw new TypeError('锁不是 lock/1.0');
  const errors = contractErrors(lock);
  if (errors.length) throw new Error(`锁不合 lock/1.0 契约：${errors.join('；')}`);
  if (lock.film !== film.id) throw new Error(`锁是给片子 ${lock.film} 出的，手里的片子是 ${film.id}`);
  const rev = getFilmRev(film);
  if (rev !== undefined && lock.rev !== rev) throw new Error(`修订号对不上：片子描述是 rev ${rev}，锁是 rev ${lock.rev ?? '（没写）'}`);

  const total = film.output.frames, runs = [];
  for (const run of [1, 2]) {
    const out = await renderLocked(structuredClone(film), structuredClone(lock), { run });
    const packed = isObj(out);
    const deliverables = packed ? out.deliverables : undefined;
    if (deliverables !== undefined && (!isObj(deliverables) || Object.values(deliverables).some((v) => typeof v !== 'string'))) {
      throw new TypeError(`第 ${run} 遍的 deliverables 必须是「文件名 → 哈希字符串」的对象`);
    }
    runs.push({ frames: frameList(packed ? out.frames : out, total, `第 ${run} 遍`), deliverables: deliverables ?? {} });
  }
  const failedFrames = [];
  let identicalFrames = 0, worstPsnrDb = Infinity, worstFracGt5 = 0;
  for (let f = 0; f < total; f++) {
    const a = runs[0].frames[f], b = runs[1].frames[f];
    const cmp = diffFrames(a, b, diffLevel, `第 ${f} 帧`);
    // 同一块内存才算（Node 的小 Buffer 共用一个池，光看 buffer 相同会冤枉各自重渲的两遍）
    if (a.color === b.color || (ArrayBuffer.isView(a.color) && a.color.buffer === b.color.buffer && a.color.byteOffset === b.color.byteOffset)) {
      throw new Error(`第 ${f} 帧两遍交回的是同一块缓冲区，不是独立重渲`);
    }
    if (cmp.identical) identicalFrames++;
    if (gate.hash ? !cmp.identical : !gate.within(cmp)) failedFrames.push(f);
    worstPsnrDb = Math.min(worstPsnrDb, cmp.psnrDb);
    worstFracGt5 = Math.max(worstFracGt5, cmp.fracGt5);
  }
  const [d1, d2] = runs.map((r) => r.deliverables);
  const mismatchedDeliverables = gate.hash ? [...new Set([...Object.keys(d1), ...Object.keys(d2)])].filter((k) => d1[k] !== d2[k]).sort() : [];
  const reason = failedFrames.length ? (gate.hash ? 'frames-differ' : 'outside-tolerance') : mismatchedDeliverables.length ? 'deliverable-mismatch' : 'ok';
  return deepFreeze({
    format: 'rebuild-regression/0.1', pass: reason === 'ok', reason, filmId: film.id, rev: lock.rev ?? null, tier,
    totalFrames: total, identicalFrames, failedFrames, mismatchedDeliverables, worstPsnrDb, worstFracGt5,
  });
}

/* ---------------- 看板行 ---------------- */

const builtRows = new WeakSet();
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;

function reportOf(report, name, format, filmId, shapeOk, passOf) {
  if (!isObj(report) || report.format !== format || typeof report.pass !== 'boolean' || typeof report.reason !== 'string'
      || !TIERS.includes(report.tier) || !Number.isSafeInteger(report.totalFrames) || !shapeOk(report)) {
    throw new TypeError(`${name} 不是 ${format} 报告`);
  }
  if (report.filmId !== filmId) throw new Error(`这一行写的是片子 ${filmId}，${name} 报告是片子 ${report.filmId} 的`);
  if (report.pass !== passOf(report) || report.pass !== (report.reason === 'ok')) throw new Error(`${name} 报告自相矛盾：pass、reason 和它带的帧表对不上`);
  return report;
}

/**
 * 看板「可控与可复现」栏的一行（controllability-row/0.1）。locality、rebuild 是两项作业交回的报告，至少给一项；
 * l2PassRate 是 L2 纯函数门通过率（[0, 1] 或 null），legacyNightlyPass 是旧作品夜间重建的结果（布尔或 null）。
 * overallPass：给了的项全过才是 true（l2PassRate 要正好是 1）。交回的行深冻结，无穷大的 PSNR 记 null，可直接写成 JSON。
 */
export function buildControllabilityRow({ filmId, recordedAt, l2PassRate = null, locality = null, rebuild = null, legacyNightlyPass = null } = {}) {
  if (typeof filmId !== 'string' || !filmId) throw new TypeError('filmId 必须是不空的字符串');
  if (typeof recordedAt !== 'string' || !ISO_TIME.test(recordedAt) || Number.isNaN(Date.parse(recordedAt))) throw new RangeError('recordedAt 必须是带时区的 ISO 8601 时刻');
  if (l2PassRate !== null && !(typeof l2PassRate === 'number' && l2PassRate >= 0 && l2PassRate <= 1)) throw new RangeError('l2PassRate 必须是 [0, 1] 内的数或 null');
  if (legacyNightlyPass !== null && typeof legacyNightlyPass !== 'boolean') throw new TypeError('legacyNightlyPass 必须是布尔值或 null');
  if (locality === null && rebuild === null) throw new Error('局部性回归和加锁重建回归的报告至少要给一项');
  const loc = locality === null ? null : reportOf(locality, 'locality', 'locality-regression/0.1', filmId,
    (r) => Array.isArray(r.paths) && r.paths.every((p) => typeof p === 'string') && Number.isSafeInteger(r.predicted?.frameCount) && ints(r.changedFrames) && ints(r.leakedFrames),
    (r) => r.leakedFrames.length === 0 && (r.changedFrames.length > 0 || r.allowNoOp === true));
  const reb = rebuild === null ? null : reportOf(rebuild, 'rebuild', 'rebuild-regression/0.1', filmId,
    (r) => (r.rev === null || Number.isSafeInteger(r.rev)) && Number.isSafeInteger(r.identicalFrames) && ints(r.failedFrames) && Array.isArray(r.mismatchedDeliverables)
      && typeof r.worstPsnrDb === 'number' && !Number.isNaN(r.worstPsnrDb) && Number.isFinite(r.worstFracGt5),
    (r) => r.failedFrames.length === 0 && r.mismatchedDeliverables.length === 0);
  const row = deepFreeze({
    format: 'controllability-row/0.1', filmId, recordedAt, l2PassRate,
    locality: loc && {
      pass: loc.pass, reason: loc.reason, tier: loc.tier, paths: [...loc.paths], totalFrames: loc.totalFrames,
      predictedFrames: loc.predicted.frameCount, changedFrames: loc.changedFrames.length, leakedFrames: loc.leakedFrames.length,
    },
    rebuild: reb && {
      pass: reb.pass, reason: reb.reason, tier: reb.tier, rev: reb.rev, totalFrames: reb.totalFrames, identicalFrames: reb.identicalFrames,
      failedFrames: reb.failedFrames.length, worstPsnrDb: Number.isFinite(reb.worstPsnrDb) ? reb.worstPsnrDb : null, worstFracGt5: reb.worstFracGt5,
    },
    legacyNightlyPass,
    overallPass: (loc?.pass ?? true) && (reb?.pass ?? true) && (l2PassRate ?? 1) === 1 && legacyNightlyPass !== false,
  });
  builtRows.add(row);
  return row;
}

/** 把一行追加进 JSONL 文件（目录不在就建），交回这一行。只收 buildControllabilityRow 交回的行：手拼的、读回来改过的都不收。 */
export async function appendControllabilityRow(filePath, row) {
  if (!builtRows.has(row)) throw new TypeError('只收 buildControllabilityRow 交回的行');
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(row)}\n`);
  return row;
}
