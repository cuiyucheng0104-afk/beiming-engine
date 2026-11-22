// 曲线摘要：不渲染，直接读连续轨道（tracks/0.1）回答一条曲线长什么样；实体没有轨道时回退读每帧元数据（meta/0.1）的屏幕轨迹。
//   curves(input, request)
//     input    { indexJson, bin }（tracks/0.1 编码）、已解码的「轨道名 → { type, samples }」，或 { tracks?, metas? } 把轨道和元数据一起给
//     request  { track } 或 { entity }，可带 quantity 与 range: [起帧, 止帧]（含端点）；轨道的第 i 个样本是第 i 帧
//   quantity：scalar 轨道不用给；vec3、quat 可取分量 x、y、z、w；vec3、camera（位置）、bbox（中心）可取 speed（相邻帧位移，米每帧，缺省值），
//     camera 还可取 fovDeg（度）。元数据回退取 screenX、screenY（包围盒中心除以画宽或画高，原点左上，缺省 screenX）、pxArea、visible。
//     给 entity 时，没有同名轨道或 quantity 是上面四个屏幕量，就读元数据，source 是 'meta'。
//   成功返回 { ok: true, source, range, samples, min, max, first, last, easing, easingRange, peaks, zeroPlateaus, monotonicSegments, counts, truncated }：
//     monotonicSegments  [{ start, end, dir: 'up' | 'down', delta }]；回摆不到容差的抖动不算转向，段两头贴着端值的平台剪掉
//     peaks              [{ frame, value, kind: 'max' | 'min' }]，相邻单调段的交界，区间两端不算
//     zeroPlateaus       [[起帧, 止帧], ...]，连续至少 3 帧贴着 0
//     easing             幅度最大那段单调段（easingRange）的缓动：step、linear、ease-in、ease-out、ease-in-out；没有单调段是 hold，
//                        幅度不小于值域四分之一的单调段有 3 段及以上是 oscillating
//   容差取值域的千分之一，且不小于最大绝对值（至少按 1 算）的百万分之一。参数不对返回 { ok: false, error: { code, message } }，不抛异常。
// 预算：回答序列化后 estimateTokens ≤ 600；装不下时留最显著的峰谷、最长的零平台、幅度最大的单调段，truncated 为 true，counts 是截断前的总数。

import { decodeTracks } from '../kernel/eval/tracks.mjs';
import { normalizeMetas, withinBudget } from './query.mjs';

export const SUMMARY_TOKEN_LIMIT = 600;
// 零平台最短帧数；缓动判读的阈值都是归一化进度（0 到 1）
const PLATEAU_FRAMES = 3;
const STEP_SHARE = 0.85;
const OSCILLATION_SHARE = 0.25;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, limit = 64) => {
  const chars = Array.from(s);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : s;
};
const sig = (v) => Number(v.toPrecision(5));

/** 结构化错误；只有子进程那三类码（env、timeout、failure）原样带出，其余都算参数不对 */
export function fail(error) {
  const code = /^(env|timeout|failure)\./.test(error?.code) ? error.code : 'usage.bad-argument';
  return { ok: false, error: { code, message: clip(String(error?.message ?? error), 160) } };
}

/** 连续为真的下标段 [[起, 止], ...]（含端点），只留长度不小于 minLen 的 */
export function runs(flags, minLen = 1) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (flags[i]) { if (start < 0) start = i; }
    else if (start >= 0) { if (i - start >= minLen) out.push([start, i - 1]); start = -1; }
  }
  return out;
}

/** 按 caps 从宽到紧重建回答，取第一个装得进 600 token 的；build(0) 只该剩定长字段 */
export function fit(build, caps = [24, 16, 12, 8, 5, 3, 1, 0]) {
  for (const cap of caps) {
    const out = build(cap);
    if (withinBudget(JSON.stringify(out), SUMMARY_TOKEN_LIMIT)) return out;
  }
  return { ok: true, truncated: true };
}

/** 一维序列的形态，下标从 0 起：最小最大值下标、值域、容差、单调段、转折点（带显著度）、零平台 */
export function shape(values) {
  let lo = 0, hi = 0, peak = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < values[lo]) lo = i;
    if (values[i] > values[hi]) hi = i;
    peak = Math.max(peak, Math.abs(values[i]));
  }
  const span = values[hi] - values[lo];
  const tol = Math.max(span * 1e-3, 1e-6 * Math.max(1, peak));
  const segments = [], peaks = [];
  let from = 0, ext = 0, dir = 0;
  const close = (to) => {
    let start = from, end = to;
    while (start + 1 < end && Math.abs(values[start + 1] - values[from]) <= tol) start++;
    while (end - 1 > start && Math.abs(values[end - 1] - values[to]) <= tol) end--;
    segments.push({ start, end, dir: dir > 0 ? 'up' : 'down', delta: values[end] - values[start] });
  };
  // 之字形转折：沿当前方向一直追极值，回摆超过容差才算转向。逐步比较会把慢坡的每一步都当成平的。
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[ext];
    if (dir === 0) {
      if (Math.abs(d) > tol) { dir = Math.sign(d); ext = i; }
    } else if (d * dir > 0) ext = i;
    else if (-d * dir > tol) {
      close(ext);
      peaks.push({ index: ext, kind: dir > 0 ? 'max' : 'min' });
      from = ext; dir = -dir; ext = i;
    }
  }
  if (dir) close(ext);
  peaks.forEach((p, k) => { p.prominence = Math.min(Math.abs(segments[k].delta), Math.abs(segments[k + 1].delta)); });
  return { lo, hi, span, segments, peaks, zeros: runs(values.map((v) => Math.abs(v) <= tol), PLATEAU_FRAMES) };
}

function easingOf(values, { segments, span }) {
  if (!segments.length) return ['hold', null];
  if (segments.filter((s) => Math.abs(s.delta) >= span * OSCILLATION_SHARE).length >= 3) return ['oscillating', null];
  const { start, end, delta } = segments.reduce((best, s) => (Math.abs(s.delta) > Math.abs(best.delta) ? s : best));
  // 归一化进度：u 是段内时间比例，返回值是走完的幅度比例
  const at = (u) => {
    const x = start + u * (end - start), i = Math.min(end - 1, Math.floor(x));
    return (values[i] + (values[i + 1] - values[i]) * (x - i) - values[start]) / delta;
  };
  let jump = 0;
  for (let i = start; i < end; i++) jump = Math.max(jump, Math.abs(values[i + 1] - values[i]));
  const mid = at(0.5);
  const kind = jump >= Math.abs(delta) * STEP_SHARE ? 'step'
    : mid < 0.4 ? 'ease-in'
      : mid > 0.6 ? 'ease-out'
        : at(0.25) < 0.19 && at(0.75) > 0.81 ? 'ease-in-out' : 'linear';
  return [kind, [start, end]];
}

const META_QUANTITIES = {
  screenX: (e, [w]) => (e.bbox2d[0] + e.bbox2d[2]) / 2 / w,
  screenY: (e, [, h]) => (e.bbox2d[1] + e.bbox2d[3]) / 2 / h,
  pxArea: (e) => e.pxArea,
  visible: (e) => e.visible,
};

function trackSeries({ type, samples }, quantity) {
  if (type === 'scalar') return samples;
  if (type === 'camera' && quantity === 'fovDeg') return samples.map((s) => s.fovDeg);
  const points = type === 'camera' ? samples.map((s) => s.pos)
    : type === 'bbox' ? samples.map((s) => s.min.map((v, k) => (v + s.max[k]) / 2)) : samples;
  const axis = quantity.length === 1 ? 'xyzw'.indexOf(quantity) : -1;
  if (axis >= 0 && axis < (points[0]?.length ?? 0)) return points.map((p) => p[axis]);
  if (quantity === 'speed' && type !== 'quat') {
    const speed = points.map((p, i) => (i ? Math.hypot(...p.map((v, k) => v - points[i - 1][k])) : 0));
    // 第 0 帧没有前一帧，沿用第 1 帧，免得开头多出一个假台阶
    if (speed.length > 1) speed[0] = speed[1];
    return speed;
  }
  throw new Error(`${type} 轨道取不了 ${clip(quantity, 24)}`);
}

/** 曲线摘要入口；任何非法输入都返回结构化错误，不抛异常 */
export function curves(input, request) {
  try {
    if (!isPlain(input)) throw new Error('要给 tracks/0.1（{ indexJson, bin }）、已解码的轨道映射，或 { tracks, metas }');
    const named = (v) => typeof v === 'string' && v !== '';
    if (!isPlain(request) || !(named(request.track) || named(request.entity))) throw new Error('request 要给 track（轨道名）或 entity（实体名）');
    const { track, entity, range, shot } = request;
    if (request.quantity !== undefined && !named(request.quantity)) throw new Error('quantity 要是非空字符串');
    if (shot !== undefined && !named(shot)) throw new Error('shot 要是非空字符串');
    if (range !== undefined && !(Array.isArray(range) && range.length === 2 && range.every(Number.isInteger) && range[0] >= 0 && range[0] <= range[1])) {
      throw new Error('range 要是 [起帧, 止帧]：非负整数，起不大于止');
    }
    const bundle = Object.hasOwn(input, 'metas') || (Object.hasOwn(input, 'tracks') && !Array.isArray(input.tracks?.samples));
    const packed = (bundle ? input.tracks : input) ?? {};
    if (!isPlain(packed)) throw new Error('tracks 要是 { indexJson, bin } 或轨道映射');
    const tracks = Object.hasOwn(packed, 'indexJson') ? decodeTracks(packed.indexJson, packed.bin) : packed;
    const name = track ?? entity;
    const useMeta = track === undefined && (!Object.hasOwn(tracks, name) || Object.hasOwn(META_QUANTITIES, request.quantity ?? ''));

    let frames, values, quantity, type;
    if (useMeta) {
      if (!bundle || input.metas === undefined) throw new Error(`实体 ${clip(name)} 没有轨道，要回退就给 metas`);
      quantity = request.quantity ?? 'screenX';
      if (!Object.hasOwn(META_QUANTITIES, quantity)) throw new Error(`元数据回退只有 ${Object.keys(META_QUANTITIES).join('、')}`);
      const metas = normalizeMetas(input.metas);
      if (typeof metas === 'string') throw new Error(metas);
      const scoped = shot !== undefined ? metas.filter((m) => m.shot === shot) : metas;
      if (!scoped.length) throw new Error(`元数据里没有镜头 ${clip(shot)}`);
      const singleShot = shot !== undefined || new Set(scoped.map((m) => m.shot)).size <= 1;
      const rows = scoped.flatMap((m) => {
        const e = (m.entities ?? []).find((x) => x.name === name);
        const v = e && META_QUANTITIES[quantity](e, m.size);
        const f = singleShot ? (m.shotFrame ?? m.frame) : m.frame;
        return Number.isFinite(v) && (!range || (f >= range[0] && f <= range[1])) ? [[f, v]] : [];
      });
      if (!rows.length) throw new Error(`元数据里这段帧没有实体 ${clip(name)} 的 ${quantity}`);
      rows.sort((x, y) => x[0] - y[0]);
      frames = rows.map((r) => r[0]);
      values = rows.map((r) => r[1]);
    } else {
      if (!Object.hasOwn(tracks, name)) throw new Error(`没有轨道 ${clip(name)}；现有 ${clip(Object.keys(tracks).join('、') || '（空）', 80)}`);
      ({ type } = tracks[name]);
      if (!Array.isArray(tracks[name].samples) || !tracks[name].samples.length) throw new Error(`轨道 ${clip(name)} 没有样本`);
      quantity = type === 'scalar' ? undefined : request.quantity ?? 'speed';
      const all = trackSeries(tracks[name], quantity);
      const [a, b] = range ?? [0, all.length - 1];
      if (b >= all.length) throw new Error(`range 超出轨道的 0 到 ${all.length - 1} 帧`);
      values = all.slice(a, b + 1);
      if (!values.every(Number.isFinite)) throw new Error(`轨道 ${clip(name)} 的样本要是有限数`);
      frames = values.map((_, i) => a + i);
    }

    const sh = shape(values);
    const [easing, easingSpan] = easingOf(values, sh);
    const point = (i) => ({ frame: frames[i], value: sig(values[i]) });
    const counts = { peaks: sh.peaks.length, zeroPlateaus: sh.zeros.length, monotonicSegments: sh.segments.length };
    const head = {
      ok: true, source: useMeta ? 'meta' : 'tracks', ...(useMeta ? { entity: clip(name) } : { track: clip(name), type }), quantity,
      range: [frames[0], frames.at(-1)], samples: values.length, min: point(sh.lo), max: point(sh.hi),
      first: sig(values[0]), last: sig(values.at(-1)), easing, easingRange: easingSpan && easingSpan.map((i) => frames[i]),
    };
    return fit((cap) => {
      const top = (list, score, order) => [...list].sort((x, y) => score(y) - score(x)).slice(0, cap).sort((x, y) => order(x) - order(y));
      return {
        ...head,
        peaks: top(sh.peaks, (p) => p.prominence, (p) => p.index).map((p) => ({ ...point(p.index), kind: p.kind })),
        zeroPlateaus: top(sh.zeros, (z) => z[1] - z[0], (z) => z[0]).map((z) => z.map((i) => frames[i])),
        monotonicSegments: top(sh.segments, (s) => Math.abs(s.delta), (s) => s.start)
          .map((s) => ({ start: frames[s.start], end: frames[s.end], dir: s.dir, delta: sig(s.delta) })),
        counts, truncated: cap < Math.max(...Object.values(counts)),
      };
    });
  } catch (error) {
    return fail(error);
  }
}
