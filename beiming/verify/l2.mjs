// L2：纯函数确定性门（同一批帧按 sequential、shuffled、single 三种方式各渲一遍再比颜色层），
// 抽帧包围盒核对门（有编号层的三维镜头：编号层反算的包围盒对元数据的 bbox2d，交并比 ≥ 0.95；
// 没有编号层的二维镜头：元数据文字框对文字识别的文字和像素估计的包围盒，四边容差 8 像素）。
// 包围盒口径：像素原点在左上角，取像素外沿，最右一列占到 x + 1。缺证据一律判不过，不判过。
import { createHash } from 'node:crypto';

export const IOU_MIN = 0.95;
export const TEXT_TOL_PX = 8;

/* ---------------- 包围盒与交并比 ---------------- */

/** 宽 × 高的栅格里 inside(下标) 为真的像素的外接范围 { x0, y0, x1, y1 }（像素下标，含两端），四边各外扩 pad 像素并裁到栅格里；一个都没有是 null */
export function boundsOf(width, height, inside, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < width * height; i++) {
    if (!inside(i)) continue;
    const x = i % width, y = (i - x) / width;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (x1 < 0) return null;
  return { x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad), x1: Math.min(width - 1, x1 + pad), y1: Math.min(height - 1, y1 + pad) };
}

/** 编号层里编号属于 ids 的像素的包围盒 [x0, y0, x1, y1]（像素外沿，右、下各加 1）；一个都没有是 null */
export function boxOfIds(width, height, layer, ids) {
  const b = boundsOf(width, height, (i) => ids.includes(layer[i]));
  return b && [b.x0, b.y0, b.x1 + 1, b.y1 + 1];
}

/** 两个矩形 [x0, y0, x1, y1] 的交并比；有一个是空的、或并集面积是 0 时是 null */
export function iou(a, b) {
  if (!a || !b) return null;
  const size = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const inter = size([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  const union = size(a) + size(b) - inter;
  return union > 0 ? inter / union : null;
}

/* ---------------- 纯函数门 ---------------- */

/** 带种子的伪随机（mulberry32），只用来定 shuffled 的次序 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 打乱次序；打乱出来和升序一样时（帧少时会碰上）改用逆序，保证 shuffled 真的换了次序 */
export function shuffledOrder(frames, seed) {
  const out = [...frames], next = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.every((f, i) => f === frames[i]) ? [...frames].reverse() : out;
}

const isNumberList = (c) => (ArrayBuffer.isView(c) && typeof c[0] === 'number') || (Array.isArray(c) && c.every((x) => typeof x === 'number'));
/** 渲出来的东西里的颜色层；不是数的数组（没交、交了别的）是 null */
function colorOf(r) {
  const c = r && typeof r === 'object' && !ArrayBuffer.isView(r) && !Array.isArray(r) ? r.color : r;
  return isNumberList(c) && c.length > 0 ? c : null;
}
const asView = (c) => (ArrayBuffer.isView(c) ? c : Float64Array.from(c));

/** 颜色层的摘要：逐字节的 sha256 */
export function digestOf(color) {
  const v = asView(color);
  return createHash('sha256').update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)).digest('hex');
}

/** 逐分量的最大相对差：|a − b| ÷ max(|a|, |b|)，两边相等（含都是 0、都是 NaN）记 0；长度不同是 Infinity */
export function maxRelErr(a, b) {
  const x = asView(a), y = asView(b);
  if (x.length !== y.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < x.length; i++) {
    if (Object.is(x[i], y[i]) || x[i] === y[i]) continue;
    const d = Math.abs(x[i] - y[i]) / Math.max(Math.abs(x[i]), Math.abs(y[i]));
    worst = Number.isNaN(d) ? Infinity : Math.max(worst, d);
  }
  return worst;
}

/**
 * 纯函数门。sourceAdapter.open() 新开一次求值，返回 { render(帧号) → 颜色层（类型化数组、数的数组，或 { color }），close?() }，可以是异步的。
 * testFrames 是全片帧号（整数帧），去重后至少 2 帧：只有一帧时三种方式的次序完全一样，判不出跨帧状态，返回 bad-input。
 * 三种方式（时间键契约 5.4）：
 *   sequential：开一次，按帧号从小到大渲；shuffled：开一次，按带种子打乱的次序渲；single：每帧新开一次，只渲这一帧。
 * options.compare 'hash'（逐字节相同）或 'relTol'（逐分量相对差 ≤ options.relTol，relTol 必须是 ≥ 0 的有限数）；options.seed 定 shuffled 的次序。
 * 以 sequential 为准比另两种；哪一次没交出颜色层，记一条 error 是 'no-color' 的不一致。
 * 返回 { ok, compare, bitExact, relTol?, frames, orders, mismatches: [{ frame, mode, against, digest | relErr | error }] }。
 * bitExact 只有 hash 档是 true：relTol 档放过了容差以内的差，它的 ok 不能当成「逐位相同」的依据。
 */
export async function runPureFunctionGate(sourceAdapter, testFrames, options = {}) {
  const { compare = 'hash', relTol = 1e-6, seed = 1 } = options ?? {};
  const invalid = (message) => ({ ok: false, compare, bitExact: false, frames: [], orders: {}, mismatches: [{ error: 'bad-input', message }] });
  if (compare !== 'hash' && compare !== 'relTol') return invalid('compare 只收 hash、relTol');
  if (!Number.isFinite(relTol) || relTol < 0) return invalid('relTol 必须是 ≥ 0 的有限数');
  if (!Number.isInteger(seed)) return invalid('seed 必须是整数');
  if (typeof sourceAdapter?.open !== 'function') return invalid('sourceAdapter 必须带 open()');
  if (!Array.isArray(testFrames) || !testFrames.every((f) => Number.isSafeInteger(f) && f >= 0)) return invalid('testFrames 必须是非负整数帧号的数组');
  const frames = [...new Set(testFrames)].sort((a, b) => a - b);
  if (frames.length < 2) return invalid('testFrames 去重后至少要 2 帧');
  const renderAll = async (order) => {
    const session = await sourceAdapter.open();
    const out = new Map();
    try {
      for (const f of order) {
        const color = colorOf(await session.render(f));
        // 帧源可以复用渲染缓冲，在下一次 render 之前保存这一帧。
        out.set(f, color && (compare === 'hash' ? digestOf(color) : Float64Array.from(color)));
      }
    } finally {
      await session?.close?.();
    }
    return out;
  };
  const orders = { sequential: frames, shuffled: shuffledOrder(frames, seed) };
  const got = { single: new Map() };
  const mismatches = [];
  try {
    got.sequential = await renderAll(orders.sequential);
    got.shuffled = await renderAll(orders.shuffled);
    for (const f of frames) got.single.set(f, (await renderAll([f])).get(f));
  } catch (error) {
    return { ok: false, compare, bitExact: false, frames, orders, mismatches: [{ error: 'render-error', message: String(error) }] };
  }
  for (const f of frames) {
    const ref = got.sequential.get(f);
    if (!ref) { mismatches.push({ frame: f, mode: 'sequential', against: 'sequential', error: 'no-color' }); continue; }
    for (const mode of ['shuffled', 'single']) {
      const c = got[mode].get(f);
      if (!c) { mismatches.push({ frame: f, mode, against: 'sequential', error: 'no-color' }); continue; }
      if (compare === 'hash') {
        const a = ref, b = c;
        if (a !== b) mismatches.push({ frame: f, mode, against: 'sequential', digest: { sequential: a, [mode]: b } });
      } else {
        const e = maxRelErr(ref, c);
        if (!(e <= relTol)) mismatches.push({ frame: f, mode, against: 'sequential', relErr: e });
      }
    }
  }
  return { ok: mismatches.length === 0, compare, bitExact: compare === 'hash', ...(compare === 'relTol' ? { relTol } : {}), frames, orders, mismatches };
}

/* ---------------- 包围盒核对门 ---------------- */

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isBox = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3];
const isSize = (s) => Array.isArray(s) && s.length === 2 && s.every((x) => Number.isInteger(x) && x > 0);
const isLayer = (l) => isObj(l) && Number.isInteger(l.width) && l.width > 0 && Number.isInteger(l.height) && l.height > 0
  && (ArrayBuffer.isView(l.data) || Array.isArray(l.data)) && l.data.length === l.width * l.height;

/** 矩形裁到画面 [0, 宽] × [0, 高] 里 */
const clip = (b, w, h) => [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(w, b[2]), Math.min(h, b[3])];
const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

/**
 * 一帧有编号层：逐个实体反算包围盒、对 bbox2d 求交并比。返回 { frame, mode, entities: 每个实体一行, problems: [{ kind, … }] }。
 * 编号层的 0 是背景，不是哪个实体的编号（每帧元数据契约第 2 节）。
 */
function checkObjectIdFrame({ frame, meta, objectId }) {
  const out = { frame, mode: 'objectId', entities: [], problems: [] };
  if (!isLayer(objectId)) { out.problems.push({ kind: 'object-id-size', expected: '编号层的 data 长度等于 宽 × 高' }); return out; }
  if (!Array.isArray(meta.entities)) { out.problems.push({ kind: 'no-entities', expected: '有编号层的帧在元数据里带 entities' }); return out; }
  const ents = meta.entities;
  const bad = ents.findIndex((e) => !isObj(e) || !Number.isInteger(e.id) || e.id < 1 || typeof e.name !== 'string' || !e.name || !isBox(e.bbox2d));
  if (bad >= 0) { out.problems.push({ kind: 'bad-entity', index: bad, expected: 'entities 每一项带 id（≥ 1 的整数）、name、bbox2d [x0, y0, x1, y1]（像素）' }); return out; }
  const [w, h] = meta.size;
  const sx = w / objectId.width, sy = h / objectId.height;
  const known = new Set(ents.map((e) => e.id));
  if (known.size !== ents.length || new Set(ents.map((e) => e.name)).size !== ents.length) {
    out.problems.push({ kind: 'duplicate-entity' });
    return out;
  }
  const strangers = new Set();
  for (const id of objectId.data) if (id !== 0 && !known.has(id)) strangers.add(id);
  if (strangers.size) out.problems.push({ kind: 'unregistered-id', ids: [...strangers] });
  for (const e of ents) {
    // 实体占的像素：它自己的编号，加名字以它的名字加点号开头的实体的（每帧元数据契约 5.3）
    const ids = ents.filter((x) => x.name === e.name || x.name.startsWith(`${e.name}.`)).map((x) => x.id);
    const box = boxOfIds(objectId.width, objectId.height, objectId.data, ids);
    // bbox2d 是投影的外接矩形，可以伸出画面；编号层只看得见画面里的部分，所以先裁到画面里再比
    const reported = clip(e.bbox2d, w, h);
    if (box) {
      const computed = [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy];
      const v = iou(computed, reported) ?? 0;
      out.entities.push({ name: e.name, iou: v, computed, reported });
      if (v < IOU_MIN) out.problems.push({ kind: 'iou', name: e.name, iou: v });
      continue;
    }
    if (area(reported) === 0) {
      out.entities.push({ name: e.name, iou: null, computed: null, reported, status: 'offscreen' });
      continue;
    }
    if (e.visible === 0) {
      out.entities.push({ name: e.name, iou: null, computed: null, reported, status: 'occluded' });
      continue;
    }
    // 实体声明在画面内且未被完全遮挡，但编号层上没有像素证据。
    out.entities.push({ name: e.name, iou: null, computed: null, reported });
    out.problems.push({ kind: 'no-pixels', name: e.name, visible: e.visible ?? null });
  }
  return out;
}

/** 点（像素中心）到矩形的距离（像素，取横竖两个方向里大的那个），在矩形里是 0 */
const distTo = (b, px, py) => Math.max(b[0] - px, px - b[2], b[1] - py, py - b[3], 0);

/**
 * 墨迹归属：每个墨迹像素归离它最近的那个文字框（一样近时归面积小的），相邻文字的墨迹互不侵占；
 * 离哪个框都超过两倍容差的墨迹不归任何框。返回 { boxes: 每个框一个外接矩形（像素外沿）或 null, stray: 没人认领的墨迹像素数 }。
 */
function assignInk(mask, boxes) {
  const reach = 2 * TEXT_TOL_PX;
  const sizes = boxes.map(area);
  const ext = boxes.map(() => null);
  let stray = 0;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[y * mask.width + x] === 0) continue;
      let best = -1, bestD = Infinity;
      for (let k = 0; k < boxes.length; k++) {
        const d = distTo(boxes[k], x + 0.5, y + 0.5);
        if (d < bestD || (d === bestD && best >= 0 && sizes[k] < sizes[best])) { best = k; bestD = d; }
      }
      if (best < 0 || bestD > reach) { stray++; continue; }
      const b = ext[best];
      ext[best] = b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x + 1), Math.max(b[3], y + 1)] : [x, y, x + 1, y + 1];
    }
  }
  return { boxes: ext, stray };
}

/**
 * 一帧没有编号层：元数据文字框逐个对文字识别（内容逐字）和像素估计的包围盒（四边各差不超过 8 像素）。
 * 文字识别必须给（没有它核不了内容）；元数据的 texts 是 null 而画面上有墨迹或识别出了文字，也判不过。
 */
function checkTextFrame({ frame, meta, ocr, inkMask }) {
  const out = { frame, mode: 'text', texts: [], unreported: [], problems: [] };
  if (!Array.isArray(ocr) || !ocr.every((o) => isObj(o) && typeof o.text === 'string' && isBox(o.bbox2d))) {
    out.problems.push({ kind: 'no-ocr', expected: '二维帧带文字识别结果 ocr: [{ text, bbox2d }]，没识别出文字也要给空数组' });
    return out;
  }
  if (inkMask !== undefined && !(isLayer(inkMask) && inkMask.width === meta.size[0] && inkMask.height === meta.size[1])) {
    out.problems.push({ kind: 'ink-mask-size', expected: '墨迹掩膜和画面同宽同高，data 长度等于 宽 × 高' });
    return out;
  }
  if (!Array.isArray(meta.texts)) { out.problems.push({ kind: 'texts-missing' }); return out; }
  const texts = meta.texts;
  const bad = texts.findIndex((t) => !isObj(t) || typeof t.text !== 'string' || !isBox(t.bbox2d));
  if (bad >= 0) { out.problems.push({ kind: 'bad-text', index: bad, expected: 'texts 每一项带 text 和 bbox2d [x0, y0, x1, y1]（像素）' }); return out; }
  const ink = inkMask ? assignInk(inkMask, texts.map((t) => t.bbox2d)) : null;
  const pool = [...ocr];
  texts.forEach((t, i) => {
    let k = -1, nearest = Infinity;
    for (const [j, o] of pool.entries()) {
      if (o.text !== t.text) continue;
      const distance = Math.max(...t.bbox2d.map((v, edge) => Math.abs(v - o.bbox2d[edge])));
      if (distance < nearest) { k = j; nearest = distance; }
    }
    const matched = k >= 0 ? pool.splice(k, 1)[0] : null;
    // 像素估计：给了墨迹掩膜就用归到这个框的墨迹的外接矩形；没给就用文字识别的框
    const estimated = ink ? ink.boxes[i] : matched?.bbox2d ?? null;
    const edgeErr = estimated ? Math.max(...t.bbox2d.map((v, j) => Math.abs(v - estimated[j]))) : null;
    out.texts.push({ text: t.text, reported: t.bbox2d, estimated, edgeErr });
    if (!matched || nearest > TEXT_TOL_PX) out.problems.push({ kind: 'text-content', text: t.text });
    if (!estimated) out.problems.push({ kind: 'text-no-pixels', text: t.text });
    else if (edgeErr > TEXT_TOL_PX) out.problems.push({ kind: 'text-bbox', text: t.text, edgeErr });
  });
  // 文字识别认出来、元数据里却没有的文字；没有哪个文字框认领的墨迹
  out.unreported = pool.map((o) => o.text);
  for (const text of out.unreported) out.problems.push({ kind: 'text-unreported', text });
  if (ink && ink.stray > 0) out.problems.push({ kind: 'ink-unreported', pixels: ink.stray });
  return out;
}

/**
 * 抽帧包围盒核对。framesData 每项 { frame 全片帧号, meta 每帧元数据, objectId?: { width, height, data: Uint32Array },
 * conformance?: 'full'|'limited', ocr?: [{ text, bbox2d }], inkMask?: { width, height, data } }。
 * 有 objectId 的按编号层判；没有的，只有 limited 合规档或显示参考镜头（meta.colorRef 是 display）才按文字框判，其余判不过（缺编号层）。
 * 缺证据一律判不过：抽样是空的（no-samples）、帧或元数据不成形（bad-input）、编号层尺寸对不上（object-id-size）、
 * 有编号层却没有 entities（no-entities）、编号层上有元数据没登记的编号（unregistered-id）、
 * 元数据报在画内又没被挡住的实体在编号层上没有像素（no-pixels）、二维帧没给文字识别（no-ocr）、
 * texts 是 null 而画面有文字（texts-missing）、墨迹没有文字框认领（ink-unreported）。
 * 任一抽样帧任一实体的交并比 < 0.95，或任一文字框内容对不上、四边差 > 8 像素，整次判不过。
 * 返回 { ok, minIou, frames: [...], failures: [{ frame, kind, … }] }。
 */
export function verifySampledBboxes(framesData) {
  const frames = [], failures = [];
  if (!Array.isArray(framesData) || framesData.length === 0) {
    return { ok: false, minIou: null, frames, failures: [{ frame: null, kind: 'no-samples', expected: '至少一个抽样帧' }] };
  }
  let minIou = null;
  for (const fd of framesData) {
    const frame = Number.isSafeInteger(fd?.frame) && fd.frame >= 0 ? fd.frame : null;
    if (!isObj(fd) || frame === null || !isObj(fd.meta) || !isSize(fd.meta.size)) {
      failures.push({ frame, kind: 'bad-input', expected: '每个抽样帧带 frame（整数帧号）和 meta，meta.size 是 [宽, 高]（正整数像素）' });
      frames.push({ frame, mode: 'none' });
      continue;
    }
    let r;
    if (fd.objectId !== undefined && fd.objectId !== null) r = checkObjectIdFrame(fd);
    else if (fd.conformance === 'limited' || fd.meta.colorRef === 'display') r = checkTextFrame(fd);
    else r = { frame, mode: 'none', problems: [{ kind: 'missing-object-id' }] };
    const { problems, ...row } = r;
    frames.push(row);
    for (const e of row.entities ?? []) if (e.iou !== null) minIou = minIou === null ? e.iou : Math.min(minIou, e.iou);
    for (const p of problems) failures.push({ frame, ...p });
  }
  return { ok: failures.length === 0, minIou, frames, failures };
}
