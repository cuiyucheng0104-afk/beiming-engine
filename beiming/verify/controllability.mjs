// 可控与可复现的两项回归作业（04 §12、07 V14）：
// 局部性回归（改一个参数，实际变了的帧必须全落在 explainParam 预测的 affects 里）、
// 加锁重建回归（同一份片子描述加同一份锁独立重渲两遍，哈希档逐帧逐位相同，容差档守 P8 口径），
// 外加进看板「可控与可复现」栏的一行记录。帧对象是 { frame, width, height, color, channels?, shot? }。
import { Buffer } from 'node:buffer';
import { appendFile, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { types } from 'node:util';
import { checks as filmChecks } from '../kernel/contracts/film/check.mjs';
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
const inUnit = (v) => typeof v === 'number' && v >= 0 && v <= 1;
// node:util 的 types 全是「带不带某种内部槽」的判断（Map、Set、Date、Proxy……），换了原型也认得出
const NATIVE = Object.values(types).filter((is) => typeof is === 'function');
const exotic = (v) => NATIVE.some((is) => is(v));
// 模块装载时 Object.prototype 上有的名字；之后谁往上加了项，带着它的普通对象都不再算普通对象
const OBJECT_PROTO_KEYS = new Set(Reflect.ownKeys(Object.prototype));
/** 本 realm 或别的 realm 的 Object.prototype：原型是空，自有项只有那几个标准名字，都是不可枚举的函数（访问器只有 __proto__），带不了数据 */
function objectProto(proto) {
  return !exotic(proto) && Object.getPrototypeOf(proto) === null && Reflect.ownKeys(proto).every((key) => {
    const desc = Object.getOwnPropertyDescriptor(proto, key);
    return OBJECT_PROTO_KEYS.has(key) && !desc.enumerable && typeof (key === '__proto__' ? desc.get : desc.value) === 'function';
  }) && typeof proto.hasOwnProperty === 'function' && proto.constructor?.name === 'Object';
}
/**
 * 普通对象：内容全在自有属性里，照自有属性读不会漏。原型只认空和 Object.prototype（objectProto 认得的），
 * 所以类实例（extends null 的也是）、Object.create(带着项的原型或 Proxy) 都不算；内容在内部槽或陷阱里的（Map、Set、Date、Proxy）换了原型也不算。
 * 先认内部槽再碰对象：Proxy 的陷阱一个都不触发。
 */
function isPlainRecord(v) {
  if (v === null || typeof v !== 'object' || exotic(v) || Array.isArray(v) || Object.prototype.toString.call(v) !== '[object Object]') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || objectProto(proto);
}
const BAD_OPTIONS = '参数必须是普通对象：类实例、Map、数组、Proxy 和带继承项的对象不收';
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
  const totalPixels = a.width * a.height, count = totalPixels * a.channels, full = a.scale * a.scale;
  // 平方和在原始刻度上累加，最后归一一次：8 位帧累加的是整数，和 P8（kernel/conformance/suite.mjs）同一个算式，
  // 恰好 50 dB 的帧不会因为逐分量先除 255 算成 49.99999999999771
  let sumSq = 0, maxAbsDiff = 0, gt5Pixels = 0;
  for (let p = 0, i = 0; p < totalPixels; p++) {
    let worst = 0;
    for (let c = 0; c < a.channels; c++, i++) {
      const x = a.color[i], y = b.color[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError(`${where}第 ${i} 个分量不是有限数`);
      const d = Math.abs(x - y);
      sumSq += d * d;
      if (d > worst) worst = d;
    }
    worst /= a.scale;
    if (worst > diffLevel) gt5Pixels++;
    if (worst > maxAbsDiff) maxAbsDiff = worst;
  }
  const sha256A = digestOf(a.color), sha256B = digestOf(b.color);
  return Object.freeze({
    identical: sha256A === sha256B, sha256A, sha256B,
    mse: sumSq / (count * full), psnrDb: sumSq === 0 ? Infinity : 10 * Math.log10(full / (sumSq / count)), maxAbsDiff,
    gt5Pixels, totalPixels, fracGt5: gt5Pixels / totalPixels,
  });
}

/**
 * 比两幅帧。identical 看颜色层字节的 SHA-256（哈希档用，+0 与 −0 算不同）；
 * mse、psnrDb 对全部分量算（8 位帧照 P8 的整数平方和），gt5Pixels 是「任一通道差严格大于 diffLevel」的像素数（容差档用）。
 * 坏输入一律抛错：结构、类型不对抛 TypeError，宽高、通道数、长度、尺寸不一致、NaN 或无穷抛 RangeError。
 */
export function compareFramePair(frameA, frameB, options = {}) {
  return diffFrames(frameA, frameB, options?.diffLevel ?? P8_DIFF_LEVEL);
}

/* ---------------- 两项作业共用的校验 ---------------- */

function needGate(tier, { psnrMinDb, maxDiffFrac, diffLevel }) {
  if (!TIERS.includes(tier)) throw new RangeError(`tier 只收 ${TIERS.join('、')}`);
  if (!Number.isFinite(psnrMinDb)) throw new RangeError('psnrMinDb 必须是有限数');
  if (!inUnit(maxDiffFrac)) throw new RangeError('maxDiffFrac 必须在 [0, 1] 内');
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

/** 入口快照：作业进行中调用方再改原对象，校验、渲染和报告用的仍是这一份。不是对象的原样交回，留给后面的校验照原话拒 */
function snapshot(v, who) {
  if (!isObj(v)) return v;
  try {
    return structuredClone(v);
  } catch (err) {
    throw new TypeError(`${who}存不成快照：带着函数之类复制不了的值`, { cause: err });
  }
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

const typedSlice = Object.getPrototypeOf(Uint8Array.prototype).slice;
/** 帧源可以复用缓冲区和帧对象，下一遍会原地覆写：下一遍开渲之前把这一遍每帧另存一份（像素是独立副本，数组类型不变） */
function keep(frames, who) {
  return frames.map((frame, f) => {
    const { color } = readFrame(frame, `${who}第 ${f} 帧`);
    return { ...frame, color: Array.isArray(color) ? color.slice() : typedSlice.call(color) };
  });
}

/* ---------------- 局部性回归 ---------------- */

/**
 * 局部性回归：把 patch（patch/0.1）作用到 film 上，改动前后各调一次 renderFilm(片子描述的副本, { phase: 'before' | 'after' })，
 * 交回全片 [0, output.frames) 的帧数组；实际变了的帧必须全落在预测的影响范围里。
 * 预测：补丁每个操作的路径（rename 另加新路径）在改动前、改动后的片子描述上各问一次 explainParam，取并集；
 * 一帧算在范围里，要帧号落在某条预测的半开区间里、它所在的镜头在那条预测的镜头表里；帧上标了 shot 的，标的镜头也得在里面。
 * 算不算「变了」：哈希档（hash、hash-same-machine）看字节，容差档（tolerance）看是否超出 P8 口径。
 * 报告的 predicted.frameRanges 是按镜头表收紧后的区间（每条预测和它点名的每个镜头取交集），并起来正好是 predicted.frameCount 帧。
 * 判定：有变化帧落在范围外是 leaked-outside-affects；一帧都没变是 no-frames-changed（allowNoOp 为真时放行）；否则 ok。
 * 改动前那一遍的帧当场另存，帧源复用缓冲区、后一遍原地覆写也照样比得出来。
 * film、patch 在入口各存一份快照，之后只认快照：渲染期间调用方改了原对象，后一遍和报告不受影响。
 * 异步函数：坏参数（选项容器不是普通对象在内）不在调用现场抛，交回的 Promise 以对应的错拒绝。
 */
export async function runLocalityTest(options = {}) {
  if (!isPlainRecord(options)) throw new TypeError(BAD_OPTIONS);
  const {
    film: givenFilm, patch: givenPatch, renderFilm, explainContext = {}, tier = 'hash', allowNoOp = false,
    psnrMinDb = P8_PSNR_MIN_DB, maxDiffFrac = P8_MAX_DIFF_FRAC, diffLevel = P8_DIFF_LEVEL,
  } = options;
  // 修订号记在调用方那个对象上（patch-apply 的 WeakMap），快照带不走，入口读一次
  const film = snapshot(givenFilm, '片子描述'), patch = snapshot(givenPatch, '补丁'), rev = getFilmRev(givenFilm);
  if (typeof renderFilm !== 'function') throw new TypeError('renderFilm 必须是函数');
  if (typeof allowNoOp !== 'boolean') throw new TypeError('allowNoOp 必须是布尔值');
  const gate = needGate(tier, { psnrMinDb, maxDiffFrac, diffLevel });
  needFilm(film);
  if (!isObj(patch)) throw new TypeError('补丁必须是 patch/0.1 对象');
  const written = applyFilmWrite(film, patch, { rev: rev ?? patch.rev });
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
    frameRanges: [...new Set(affects.flatMap(({ shots, frameRange: [from, to], table }) => table.filter((s) => shots.includes(s.id))
      .map((s) => [Math.max(from, s.in), Math.min(to, s.out)]).filter(([lo, hi]) => lo < hi).map((x) => JSON.stringify(x))))].map((s) => JSON.parse(s)),
    frameCount: Array.from({ length: total }, (_, f) => f).filter((f) => inside(f)).length,
  };

  const before = keep(frameList(await renderFilm(structuredClone(film), { phase: 'before' }), total, '改动前那一遍'), '改动前那一遍');
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
    format: 'locality-regression/0.1', pass: reason === 'ok', reason, filmId: film.id, tier, gate: { psnrMinDb, maxDiffFrac, diffLevel }, allowNoOp, paths,
    predicted, totalFrames: total, changedFrames, leakedFrames, unchangedOutsideCount,
  });
}

/* ---------------- 加锁重建回归 ---------------- */

// 锁「钉没钉全」的几条：全片级的卡、帧源、模版、查找表、叠加层卡，镜头用的卡和资产。上游同一个规则码既报「锁里没有这一项」，
// 也报「锁里写了却和片子描述对不上」（主版本、宿主、from）；allowPartialLock 只放过前一种，认的是下面这几句原话。
// 认不出来的一律照拒：上游改了措辞，没钉全的锁会被拒收（V14-14 的夹具用例会红），不会把对不上的放过去。
// 资产是例外：版本写在键名 asset:<名>@<版本> 里，上游只查整个键，「没钉」和「钉了同名的另一个版本」报同一句，由 assetClashes 另查
const N = '[^\\s，]+';
const NOT_PINNED = Object.fromEntries(Object.entries({
  LK1: [`片子描述里有 ${N}，cards 里没有它绑的 ${N}`],
  LK4: [`镜头 ${N}(?: 的 renderer)? 的帧源 ${N} 不在 sources 里`],
  LK8: [`predicates\\.base 引用了 ${N}，templates 里没有 ${N}`],
  LK9: [`style\\.view\\.scene 是 ${N}，view 里没有这个键`],
  LK10: ['片子描述有叠加层，cards 里没有 two-d\\.overlay'],
  D3: [`镜头 ${N} 的 ${N} 在锁文件 cards 里没有`, `资产 ${N} 在锁文件 assets 里没有`],
}).map(([id, list]) => [id, new RegExp(`^(?:${list.join('|')})$`)]));

/** 片子描述要的资产锁里没有、却钉着同名的另一个版本：是对不上，不是没钉全 */
function assetClashes(film, lock) {
  const stem = (ref) => ref.slice(0, ref.lastIndexOf('@') + 1), pinned = Object.keys(lock.assets ?? {});
  return [...new Set([...film.shots.flatMap((s) => Object.values(s.assets ?? {})), ...Object.values(film.assets ?? {})])]
    .filter((ref) => !pinned.includes(ref))
    .flatMap((ref) => pinned.filter((key) => stem(key) === stem(ref)).map((key) => `D3 资产 ${ref} 在锁里钉的是另一个版本 ${key}`));
}

/**
 * 交付件表只收普通对象（isPlainRecord）：自有键都是不空的文件名，值都是可枚举的不空哈希字符串，不带 Symbol 键、访问器、不可枚举的键和继承来的项。
 * 读得到却不在自有可枚举数据属性里的内容（Map、类实例、原型链上的项、Proxy 的陷阱），照普通对象读会读成空表，两遍摘要不同也判一致，所以直接拒。
 * 每个键只读一次，交回的是副本。
 */
function fileTable(table, who) {
  const bad = (why) => new TypeError(`${who}的 deliverables 必须是「文件名 → 哈希字符串」的普通对象：${why}`);
  if (!isPlainRecord(table)) throw bad('Map、Set、Date、Proxy、类实例和带继承项的对象不收');
  return Object.fromEntries(Reflect.ownKeys(table).map((key) => {
    if (typeof key !== 'string' || key === '') throw bad('键必须是不空的字符串，不收 Symbol 键');
    const desc = Object.getOwnPropertyDescriptor(table, key);
    if (!('value' in desc) || !desc.enumerable || typeof desc.value !== 'string' || desc.value === '') throw bad(`${key} 必须是可枚举的数据属性、值是不空的字符串，不收访问器和不可枚举的键`);
    return [key, desc.value];
  }));
}

/**
 * 加锁重建回归：同一份 film 加同一份 lock，调两次 renderLocked(片子描述的副本, 锁的副本, { run: 1 | 2 })，两遍必须是独立重渲。
 * 每遍交回全片的帧数组，或 { frames, deliverables }（deliverables 是「文件名 → 哈希字符串」的普通对象，Map、类实例这些直接抛 TypeError）。
 * 哈希档：每帧颜色层逐位相同，deliverables 逐键相同；容差档：每帧 PSNR ≥ psnrMinDb 且超差像素比例 ≤ maxDiffFrac，不比 deliverables。
 * 开渲之前就拒：缺锁、锁不合 lock/1.0、修订号和片子描述对不上、锁和片子描述过不了出锁时（kernel/lock-gen.mjs）那套跨文件核对
 * （lock-check/0.1 的全部不变量加片子描述一侧的 D3：片号、种子、镜头表、卡、帧源、模版、查找表、资产）。
 * allowPartialLock 为真时只放过「锁里没有这一项」（NOT_PINNED）：锁里写了却对不上的（模版、卡的主版本，帧源的宿主，卡的 from，
 * 同名资产钉的是另一个版本）照拒，
 * 片号、种子、镜头表照查；放过了东西的，报告的 lockCheck 记 partial。
 * 第一遍的帧和交付件表当场另存，帧源在第二遍里原地覆写也照样比得出来。
 * film、lock 在入口各存一份快照，核对、两遍渲染、报告的 filmId 和 rev 都只认快照：第一遍开渲后调用方换了原锁，第二遍用的仍是核过的那一份。
 * 异步函数：坏参数（选项容器不是普通对象在内）和坏 deliverables 都不在调用现场抛，交回的 Promise 以对应的错拒绝；第一遍的 deliverables 坏了就停，不调第二遍。
 */
export async function runRebuildTest(options = {}) {
  if (!isPlainRecord(options)) throw new TypeError(BAD_OPTIONS);
  const {
    film: givenFilm, lock: givenLock, renderLocked, tier = 'hash-same-machine', allowPartialLock = false,
    psnrMinDb = P8_PSNR_MIN_DB, maxDiffFrac = P8_MAX_DIFF_FRAC, diffLevel = P8_DIFF_LEVEL,
  } = options;
  // 核过的和两遍渲的必须是同一份：入口存快照，之后不再读调用方的对象（修订号记在原对象上，也在入口读）
  const film = snapshot(givenFilm, '片子描述'), lock = snapshot(givenLock, '锁'), rev = getFilmRev(givenFilm);
  if (typeof renderLocked !== 'function') throw new TypeError('renderLocked 必须是函数');
  if (typeof allowPartialLock !== 'boolean') throw new TypeError('allowPartialLock 必须是布尔值');
  const gate = needGate(tier, { psnrMinDb, maxDiffFrac, diffLevel });
  needFilm(film);
  if (!isObj(lock)) throw new TypeError('缺锁：加锁重建要带和片子描述配套的锁');
  if (lock.format !== 'lock/1.0') throw new TypeError('锁不是 lock/1.0');
  const errors = contractErrors(lock);
  if (errors.length) throw new Error(`锁不合 lock/1.0 契约：${errors.join('；')}`);
  if (rev !== undefined && lock.rev !== rev) throw new Error(`修订号对不上：片子描述是 rev ${rev}，锁是 rev ${lock.rev ?? '（没写）'}`);
  const cross = validate({ format: 'lock-check/0.1', lock, film });
  const found = Object.entries({ ...cross.violations, D3: filmChecks.D3({ format: 'film-check/0.1', film, lock }) }).flatMap(([id, list]) => list.map((m) => [id, m]));
  const fatal = [...cross.schemaErrors, ...found.filter(([id, m]) => !(allowPartialLock && NOT_PINNED[id]?.test(m))).map(([id, m]) => `${id} ${m}`), ...assetClashes(film, lock)];
  if (fatal.length) throw new Error(`锁和片子描述对不上：${fatal.join('；')}`);
  const lockCheck = found.length ? 'partial' : 'full';

  const total = film.output.frames, runs = [];
  for (const run of [1, 2]) {
    const out = await renderLocked(structuredClone(film), structuredClone(lock), { run });
    const packed = isObj(out);
    // 只交帧数组就是不带交付件表；数组上挂着 deliverables 的不能当没看见
    if (!packed && out?.deliverables !== undefined) throw new TypeError(`第 ${run} 遍的 deliverables 挂在帧数组上：要带交付件表就交回 { frames, deliverables }`);
    const given = packed ? out.deliverables : undefined;
    const deliverables = given === undefined ? {} : fileTable(given, `第 ${run} 遍`);
    const frames = frameList(packed ? out.frames : out, total, `第 ${run} 遍`);
    // 第一遍的像素和交付件表当场另存；原来那块缓冲区只留着认「两遍是不是同一块」
    runs.push({ frames: run === 1 ? keep(frames, '第 1 遍') : frames, buffers: frames.map((frame) => frame.color), deliverables });
  }
  const failedFrames = [];
  let identicalFrames = 0, worstPsnrDb = Infinity, worstFracGt5 = 0;
  for (let f = 0; f < total; f++) {
    const a = runs[0].buffers[f], b = runs[1].buffers[f];
    const cmp = diffFrames(runs[0].frames[f], runs[1].frames[f], diffLevel, `第 ${f} 帧`);
    // 同一块内存才算（Node 的小 Buffer 共用一个池，光看 buffer 相同会冤枉各自重渲的两遍）
    if (a === b || (ArrayBuffer.isView(a) && a.buffer === b.buffer && a.byteOffset === b.byteOffset)) {
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
    format: 'rebuild-regression/0.1', pass: reason === 'ok', reason, filmId: film.id, rev: lock.rev ?? null, tier, gate: { psnrMinDb, maxDiffFrac, diffLevel }, lockCheck,
    totalFrames: total, identicalFrames, failedFrames, mismatchedDeliverables, worstPsnrDb, worstFracGt5,
  });
}

/* ---------------- 看板行 ---------------- */

const builtRows = new WeakSet();
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/;
// 一行的体积上界：路径只留首尾各 4 条、每条 96 个字符，片号和作业号各 128 个字符，其余都是数和枚举。
// 一行远小于 Node 一次 write 的块（512 KiB），追加是一次 O_APPEND 写，不会被别的写入者从中间插开
const MAX_ROW_BYTES = 8192, MAX_NAME = 128, PATH_SAMPLES = 4, PATH_CHARS = 96, FRAME_SAMPLES = 3;
const badArg = (Type, message) => Object.assign(new Type(message), { code: 'usage.bad-argument' });
const headTail = (list, n) => (list.length <= 2 * n ? [...list] : [...list.slice(0, n), ...list.slice(-n)]);
/** 实心数组：没有空洞、没有多出来的自有属性，每项过 itemOk。every 会跳过空洞，这里逐个下标查；键数先比，极长的空洞数组不用走完 */
function dense(v, itemOk) {
  if (!Array.isArray(v) || Reflect.ownKeys(v).length !== v.length + 1) return false;
  for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v, i) || !itemOk(v[i], i)) return false;
  return true;
}
/** 帧号表：[0, total) 里严格升序的整数 */
const frameTable = (v, total) => dense(v, (n, i) => Number.isSafeInteger(n) && n >= 0 && n < total && (i === 0 || n > v[i - 1]));
/** 名字表：不空、不重复的字符串 */
const nameTable = (v) => dense(v, (s) => typeof s === 'string' && s !== '') && new Set(v).size === v.length;
const gateOk = (g) => isObj(g) && Number.isFinite(g.psnrMinDb) && inUnit(g.maxDiffFrac) && Number.isFinite(g.diffLevel) && g.diffLevel >= 0;
const gateOf = ({ psnrMinDb, maxDiffFrac, diffLevel }) => ({ psnrMinDb, maxDiffFrac, diffLevel });
/** 容差档的门限不比 P8 松才算数；哈希档不看门限 */
const holdsP8 = (r) => !r || r.tier !== 'tolerance' || (r.gate.psnrMinDb >= P8_PSNR_MIN_DB && r.gate.maxDiffFrac <= P8_MAX_DIFF_FRAC && r.gate.diffLevel <= P8_DIFF_LEVEL);

// reasonOf 照报告自己带的帧表和读数重算 reason；计数、范围互相对不上时交回 null
function reportOf(report, name, format, filmId, shapeOk, reasonOf) {
  if (!isObj(report) || report.format !== format || typeof report.pass !== 'boolean' || typeof report.reason !== 'string'
      || !TIERS.includes(report.tier) || !Number.isSafeInteger(report.totalFrames) || report.totalFrames < 1 || !gateOk(report.gate) || !shapeOk(report)) {
    throw badArg(TypeError, `${name} 不是 ${format} 报告`);
  }
  if (report.filmId !== filmId) throw badArg(Error, `这一行写的是片子 ${filmId}，${name} 报告是片子 ${report.filmId} 的`);
  if (report.reason !== reasonOf(report) || report.pass !== (report.reason === 'ok')) throw badArg(Error, `${name} 报告自相矛盾：pass、reason 和它带的帧表、读数对不上`);
  return report;
}

function localityReason(r) {
  const { frameRanges, frameCount, shots } = r.predicted, total = r.totalFrames;
  const inRange = (f) => frameRanges.some(([from, to]) => from <= f && f < to);
  const changed = new Set(r.changedFrames), leaked = new Set(r.leakedFrames), outside = total - frameCount;
  // 预测区间并起来盖住多少帧（不逐帧数：手拼的报告可以把 totalFrames 写得极大）
  let covered = 0, reach = 0;
  for (const [from, to] of [...frameRanges].sort((x, y) => x[0] - y[0])) {
    const lo = Math.max(from, reach);
    if (to > lo) [covered, reach] = [covered + to - lo, to];
  }
  // 报告里的区间已按镜头表收紧：不出全片，并起来正好是 frameCount 帧；有预测帧就得有预测镜头
  const sound = frameRanges.every(([from, to]) => from >= 0 && from < to && to <= total) && frameCount === covered && (frameCount === 0 || shots.length > 0)
    && r.leakedFrames.every((f) => changed.has(f)) && r.changedFrames.every((f) => inRange(f) || leaked.has(f))
    && changed.size - leaked.size <= frameCount && r.unchangedOutsideCount <= outside && r.unchangedOutsideCount >= outside - leaked.size;
  return !sound ? null : leaked.size ? 'leaked-outside-affects' : !changed.size && !r.allowNoOp ? 'no-frames-changed' : 'ok';
}

/** 照片子描述的镜头表核预测：点名的镜头都在表里、每个都有预测帧落在里面，每条区间都落在点名的镜头里（镜头表首尾相接不重叠，和各镜头的交集加起来够长就是全落在里面） */
function predictedFitsFilm({ shots, frameRanges }, film) {
  const named = film.shots.filter((s) => shots.includes(s.id));
  const overlap = ([from, to], s) => Math.max(0, Math.min(to, s.out) - Math.max(from, s.in));
  return named.length === shots.length && named.every((s) => frameRanges.some((range) => overlap(range, s) > 0))
    && frameRanges.every((range) => named.reduce((sum, s) => sum + overlap(range, s), 0) === range[1] - range[0]);
}

function rebuildReason(r) {
  const hash = r.tier !== 'tolerance', failed = r.failedFrames.length, differing = r.totalFrames - r.identicalFrames;
  const within = r.worstPsnrDb >= r.gate.psnrMinDb && r.worstFracGt5 <= r.gate.maxDiffFrac;
  const sound = r.identicalFrames >= 0 && differing >= 0 && (differing > 0 || (r.worstPsnrDb === Infinity && r.worstFracGt5 === 0))
    && (hash ? failed === differing : failed <= differing && (failed === 0) === within && !r.mismatchedDeliverables.length);
  return !sound ? null : failed ? (hash ? 'frames-differ' : 'outside-tolerance') : r.mismatchedDeliverables.length ? 'deliverable-mismatch' : 'ok';
}

/**
 * 看板「可控与可复现」栏的一行（controllability-row/0.1）。locality、rebuild 是两项作业交回的报告，至少给一项；
 * l2PassRate 是 L2 纯函数门通过率（[0, 1] 或 null），legacyNightlyPass 是旧作品夜间重建的结果（布尔或 null），jobId 是这次作业的编号（可不给）。
 * film（可不给）是两项作业用的那份片子描述：给了就核片号、总帧数，并照镜头表核 predicted（点名的镜头都在表里、各有预测帧，区间都落在点名的镜头里）。
 * 补丁改了镜头号或切点的报告，预测是照改动前后两张镜头表并起来的，和单独一张表对不上，不要带 film。
 * 报告不照单全收：帧表、计数、读数、门限照两项作业的判定规则重算一遍，和报告写的 pass、reason 对不上就拒收；两份报告都给了，totalFrames 要相同（不带 film 也查）。
 * overallPass：给了的项全过才是 true（l2PassRate 要正好是 1；容差档的门限比 P8 松的不算过）。
 * 交回的行深冻结、体积有上界（长表只留总数和首尾样例），无穷大的 PSNR 记 null，可直接写成 JSON。坏参数抛的错都带 code: 'usage.bad-argument'。
 */
export function buildControllabilityRow(options = {}) {
  if (!isPlainRecord(options)) throw badArg(TypeError, BAD_OPTIONS);
  const { filmId, recordedAt, jobId = null, film = null, l2PassRate = null, locality = null, rebuild = null, legacyNightlyPass = null } = options;
  if (typeof filmId !== 'string' || !filmId) throw badArg(TypeError, 'filmId 必须是不空的字符串');
  if (filmId.length > MAX_NAME) throw badArg(RangeError, `filmId 不超过 ${MAX_NAME} 个字符`);
  if (jobId !== null && typeof jobId !== 'string') throw badArg(TypeError, 'jobId 必须是字符串或 null');
  if (jobId !== null && (!jobId || jobId.length > MAX_NAME)) throw badArg(RangeError, `jobId 是 1 到 ${MAX_NAME} 个字符`);
  if (typeof recordedAt !== 'string' || !ISO_TIME.test(recordedAt) || Number.isNaN(Date.parse(recordedAt))) throw badArg(RangeError, 'recordedAt 必须是带时区的 ISO 8601 时刻');
  if (l2PassRate !== null && !inUnit(l2PassRate)) throw badArg(RangeError, 'l2PassRate 必须是 [0, 1] 内的数或 null');
  if (legacyNightlyPass !== null && typeof legacyNightlyPass !== 'boolean') throw badArg(TypeError, 'legacyNightlyPass 必须是布尔值或 null');
  if (locality === null && rebuild === null) throw badArg(Error, '局部性回归和加锁重建回归的报告至少要给一项');
  const loc = locality === null ? null : reportOf(locality, 'locality', 'locality-regression/0.1', filmId,
    (r) => typeof r.allowNoOp === 'boolean' && nameTable(r.paths) && isObj(r.predicted) && nameTable(r.predicted.shots)
      && dense(r.predicted.frameRanges, (x) => Array.isArray(x) && x.length === 2 && dense(x, Number.isSafeInteger))
      && Number.isSafeInteger(r.predicted.frameCount) && Number.isSafeInteger(r.unchangedOutsideCount)
      && frameTable(r.changedFrames, r.totalFrames) && frameTable(r.leakedFrames, r.totalFrames),
    localityReason);
  const reb = rebuild === null ? null : reportOf(rebuild, 'rebuild', 'rebuild-regression/0.1', filmId,
    (r) => (r.rev === null || (Number.isSafeInteger(r.rev) && r.rev >= 0)) && ['full', 'partial'].includes(r.lockCheck)
      && Number.isSafeInteger(r.identicalFrames) && frameTable(r.failedFrames, r.totalFrames)
      && nameTable(r.mismatchedDeliverables)
      && typeof r.worstPsnrDb === 'number' && !Number.isNaN(r.worstPsnrDb) && inUnit(r.worstFracGt5),
    rebuildReason);
  if (loc && reb && loc.totalFrames !== reb.totalFrames) throw badArg(Error, `locality 报告是 ${loc.totalFrames} 帧，rebuild 报告是 ${reb.totalFrames} 帧，不是同一份片子描述的`);
  if (film !== null) {
    try {
      needFilm(film);
    } catch (err) {
      throw Object.assign(err, { code: 'usage.bad-argument' });
    }
    if (film.id !== filmId) throw badArg(Error, `这一行写的是片子 ${filmId}，film 是片子 ${film.id}`);
    for (const [name, r] of [['locality', loc], ['rebuild', reb]]) {
      if (r && r.totalFrames !== film.output.frames) throw badArg(Error, `${name} 报告是 ${r.totalFrames} 帧，片子描述的 output.frames 是 ${film.output.frames}`);
    }
    if (loc && !predictedFitsFilm(loc.predicted, film)) throw badArg(Error, 'locality 报告的 predicted 和片子描述的镜头表对不上：点名的镜头要都在表里、各有预测帧，区间要都落在点名的镜头里');
  }
  const row = deepFreeze({
    format: 'controllability-row/0.1', filmId, recordedAt, jobId, l2PassRate,
    locality: loc && {
      pass: loc.pass, reason: loc.reason, tier: loc.tier, gate: gateOf(loc.gate),
      pathCount: loc.paths.length, paths: headTail(loc.paths, PATH_SAMPLES).map((p) => p.slice(0, PATH_CHARS)), totalFrames: loc.totalFrames,
      predictedFrames: loc.predicted.frameCount, changedFrames: loc.changedFrames.length, leakedFrames: loc.leakedFrames.length, leakedSample: headTail(loc.leakedFrames, FRAME_SAMPLES),
    },
    rebuild: reb && {
      pass: reb.pass, reason: reb.reason, tier: reb.tier, gate: gateOf(reb.gate), lockCheck: reb.lockCheck, rev: reb.rev,
      totalFrames: reb.totalFrames, identicalFrames: reb.identicalFrames, failedFrames: reb.failedFrames.length, failedSample: headTail(reb.failedFrames, FRAME_SAMPLES),
      worstPsnrDb: Number.isFinite(reb.worstPsnrDb) ? reb.worstPsnrDb : null, worstFracGt5: reb.worstFracGt5,
    },
    legacyNightlyPass,
    overallPass: (loc?.pass ?? true) && (reb?.pass ?? true) && holdsP8(loc) && holdsP8(reb) && (l2PassRate ?? 1) === 1 && legacyNightlyPass !== false,
  });
  builtRows.add(row);
  return row;
}

const LOCK_STALE_MS = 10000, LOCK_WAIT_MS = 30000;
const appendQueues = new Map(); // 规范化的目标路径 → 排在最后的那次写入

/** 锁文件（目标路径加 .lock，独占创建）挡住别的进程；握锁的进程死了留下的，过了 LOCK_STALE_MS 就清掉 */
async function withLockFile(target, job) {
  const lockPath = `${target}.lock`, deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await open(lockPath, 'wx')).close();
      break;
    } catch (err) {
      // Windows 上锁文件正在被删时独占创建报 EPERM、EBUSY，和「有人握着」一样等
      if (err.code !== 'EEXIST' && !(process.platform === 'win32' && ['EPERM', 'EBUSY'].includes(err.code))) throw err;
      const held = await stat(lockPath).catch(() => null);
      // shortcut: 两个进程同时清同一个过期锁，可能有一个删掉对方刚建的新锁；每行本来就是一次原子追加，这把锁是第二道，等真有长事务要保护时换成带持有者标记的锁
      if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) await rm(lockPath, { force: true });
      else if (Date.now() > deadline) throw new Error(`等锁文件 ${lockPath} 超过 ${LOCK_WAIT_MS / 1000} 秒，没写进去`, { cause: err });
      else await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await job();
  } finally {
    await rm(lockPath, { force: true, maxRetries: 3 }); // Windows 上别的进程正探这个文件时删会报 EBUSY、EPERM，重试几次
  }
}

/**
 * 把一行追加进 JSONL 文件（目录不在就建），交回这一行。只收 buildControllabilityRow 交回的行：手拼的、读回来改过的都不收。
 * 并发追加逐行完整：同一个进程里按规范化的目标路径排队，别的进程靠锁文件挡，每行又是一次不超过 MAX_ROW_BYTES 的追加写。
 */
export async function appendControllabilityRow(filePath, row) {
  if (!builtRows.has(row)) throw new TypeError('只收 buildControllabilityRow 交回的行');
  const line = `${JSON.stringify(row)}\n`;
  if (Buffer.byteLength(line) > MAX_ROW_BYTES) throw new RangeError(`这一行超过 ${MAX_ROW_BYTES} 字节`);
  await mkdir(dirname(filePath), { recursive: true });
  const target = join(await realpath(dirname(filePath)), basename(filePath));
  const mine = (appendQueues.get(target) ?? Promise.resolve()).then(() => withLockFile(target, () => appendFile(target, line)));
  const tail = mine.catch(() => {});
  appendQueues.set(target, tail);
  try {
    await mine;
  } finally {
    if (appendQueues.get(target) === tail) appendQueues.delete(target);
  }
  return row;
}
