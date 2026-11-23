// camera.cue-kf：时间来自命名事件，帧间不存状态。页面宿主和 Node 求值核共用此入口。
import { installProxyRegistry } from '../../../sources/three/proxy-registry.js';

const isProxy = globalThis.process?.versions?.node ? (await import('node:util/types')).isProxy : installProxyRegistry();
const bad = (why) => { throw Object.assign(new TypeError(`camera.cue-kf：${why}`), { code: 'usage.bad-argument' }); };
const int = Number.isSafeInteger;
const positiveInt = (x) => int(x) && x > 0;
const phase = (x) => Number.isFinite(x) && x >= 0 && x < 1;
const name = (x) => typeof x === 'string' && x.length > 0 && !/\s/u.test(x);
const fps = (x) => typeof x === 'string' && /^[1-9]\d*\/[1-9]\d*$/.test(x);
const zoomValue = (x) => Number.isFinite(x) && x >= 1 / 1024 && x <= 1024;
const optional = (obj, key, fallback) => Object.hasOwn(obj, key) ? obj[key] : fallback;

// 在任何反射前查 Proxy，只取自有数据描述符，不读取访问器，也不对传入的值做字符串转换。
function record(v, fields, label) {
  if (v === null || typeof v !== 'object' || isProxy(v)) bad(label);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null || Array.isArray(v)) bad(label);
  const out = Object.create(null);
  for (const k of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (typeof k !== 'string' || fields && !fields.includes(k) || !d.enumerable || !Object.hasOwn(d, 'value')) bad(label);
    out[k] = d.value;
  }
  return out;
}
function list(v, label) {
  if (isProxy(v) || !Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || Reflect.ownKeys(v).length !== v.length + 1) bad(label);
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, i);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) bad(label);
    out.push(d.value);
  }
  return out;
}
function pair(v, valid, label) {
  const a = list(v, label);
  if (a.length !== 2 || !a.every(valid)) bad(label);
  return a;
}
const point = (v) => pair(v, (x) => Number.isFinite(x) && Math.abs(x) <= Number.MAX_SAFE_INTEGER, '中心须为两个有限的像素坐标');

const KINDS = ['named', 'cut', 'arrive', 'burst', 'shake'];
const EVENT_KEYS = ['id', 'kind', 'frame', 'f', 'sub', 'from', 'shot', 'entity', 'audio', 'sync'];
// 局部 f 可以在镜头之外；全片 frame 只减一次镜头起始帧。保留 sub，不把触发点偷偷舍入到别的帧。
function namedEvents(raw, shotIn) {
  const cues = new Map(), seen = new Set();
  if (isProxy(raw)) bad('无效事件表');
  let limit;
  if (!Array.isArray(raw)) {
    const doc = record(raw, null, '无效事件表');
    if (doc.format !== 'events/0.1') {
      for (const [id, frame] of Object.entries(doc)) {
        if (!name(id) || !int(frame) || frame < 0) bad('事件映射须为名字到全片整数帧');
        cues.set(id, frame - shotIn);
      }
      return cues;
    }
    if (Object.keys(doc).some((k) => !['format', 'film', 'fps', 'frames', 'events'].includes(k)) || !name(doc.film) || !fps(doc.fps) || !positiveInt(doc.frames)) bad('无效的 events/0.1 文档');
    raw = doc.events;
    limit = doc.frames;
  }
  for (const item of list(raw, '无效事件数组')) {
    const e = record(item, EVENT_KEYS, '无效事件条目');
    const local = Object.hasOwn(e, 'f');
    if (!name(e.id) || seen.has(e.id) || !KINDS.includes(e.kind) || !phase(e.sub)) bad('事件须有不重复的 id、种类和子帧相位');
    seen.add(e.id);
    if (local) {
      if (limit !== undefined || !int(e.f) || Object.keys(e).some((k) => !['id', 'kind', 'f', 'sub'].includes(k))) bad('局部事件须用 f，不得混用 frame');
    } else {
      if (!int(e.frame) || e.frame < 0 || e.frame >= (limit ?? Infinity) || !['film', 'tracks'].includes(e.from)) bad('全片事件须有有效的 frame 和 from');
      if (['shot', 'audio', 'entity'].some((k) => Object.hasOwn(e, k) && !name(e[k])) || Object.hasOwn(e, 'audio') !== Object.hasOwn(e, 'sync')
        || Object.hasOwn(e, 'sync') && !['onset', 'pcenter'].includes(e.sync) || e.kind === 'arrive' && !Object.hasOwn(e, 'entity')) bad('无效事件元数据');
    }
    if (e.kind === 'named') cues.set(e.id, (local ? e.f : e.frame - shotIn) + e.sub);
  }
  return cues;
}

function trajectory(moves, events) {
  const segments = list(moves, 'moves 须为稠密数组').map((move) => {
    const m = record(move, ['cue', 'durationFrames', 'cueOffsetFrames', 'from', 'to', 'zoomFrom', 'zoomTo'], '无效运镜条目');
    const offset = optional(m, 'cueOffsetFrames', 0);
    if (!name(m.cue) || !events.has(m.cue)) bad('起点必须引用表内的命名事件');
    if (!int(offset) || !positiveInt(m.durationFrames)) bad('偏移须为整帧，时长须为正整帧');
    if (['zoomFrom', 'zoomTo'].some((k) => Object.hasOwn(m, k) && !zoomValue(m[k]))) bad('放大率须在 [1/1024, 1024]');
    const start = events.get(m.cue) + offset, end = start + m.durationFrames;
    if (Math.abs(start) > Number.MAX_SAFE_INTEGER || Math.abs(end) > Number.MAX_SAFE_INTEGER) bad('关键帧超出安全范围');
    return { start, end, duration: m.durationFrames, from: point(m.from), to: point(m.to), z0: m.zoomFrom, z1: m.zoomTo };
  }).sort((a, b) => a.start - b.start);
  let last;
  for (const s of segments) {
    s.z0 ??= last?.z1 ?? 1;
    s.z1 ??= s.z0;
    if (last && (last.end > s.start || s.z0 !== last.z1 || !s.from.every((v, i) => v === last.to[i]))) bad('运镜不可重叠；段与段之间须保持同一姿态');
    last = s;
  }
  return segments;
}

const TAN_HALF_FOV = Math.tan(20 * Math.PI / 180); // 页面默认竖直视场角 40°
function pose(panX, panY, zoom, speed, height) {
  // 未缩放地图平面离相机 10 米。在这里把屏幕坐标（Y 向下）换成页面世界坐标（Y 向上）。
  const mPerPx = 20 * TAN_HALF_FOV / height;
  const camera = { pos: [panX * mPerPx, -panY * mPerPx || 0, 0], quat: [0, 0, 0, 1], fovDeg: zoom === 1 ? 40 : Math.atan(TAN_HALF_FOV / zoom) * 360 / Math.PI };
  // 列主序；输入输出都是原点在画幅中心、Y 向下的像素。它与 camera 在 z=-10 米处的透视投影相同。
  const matrix = [zoom, 0, 0, 0, 0, zoom, 0, 0, 0, 0, 1, 0, -panX * zoom || 0, -panY * zoom || 0, 0, 1];
  return { panX, panY, zoom, matrix, camera, tracks: { camera }, speed };
}

/**
 * inputs：镜头局部输入（fps、size、seed、shot、events）。size 默认 1920×1080，仅高度用于 px 换米。
 * params.moves 见 schema。f 是局部整数帧，sub 在 [0,1)。输出 panX/Y 是视野中心的未缩放像素偏移，不是地图的位移。
 * speed 是每帧的姿态变化量（px/frame）：中心平移按当前放大率换成屏幕像素，变焦按半个未缩放画幅高度折算，取欧氏长度。
 * 起帧指第一对有运动的相邻帧中较早的一帧，不是位移已达某个百分比的帧。区间之外保持端点姿态，速度为 0。
 */
export function evaluate(inputs, params, f, sub) {
  if (!int(f) || f < 0 || !phase(sub)) bad('无效的局部帧或子帧');
  const i = record(inputs, ['fps', 'size', 'seed', 'shot', 'events'], '无效 inputs'), p = record(params, ['moves'], '无效 params');
  if (Object.hasOwn(i, 'fps') && !fps(i.fps) || Object.hasOwn(i, 'seed') && !int(i.seed)) bad('无效帧率或种子');
  const height = Object.hasOwn(i, 'size') ? pair(i.size, positiveInt, '无效画幅')[1] : 1080;
  const shot = record(optional(i, 'shot', { in: 0 }), ['id', 'in', 'frames'], '无效镜头');
  if (!int(shot.in) || shot.in < 0 || Object.hasOwn(shot, 'id') && !name(shot.id) || Object.hasOwn(shot, 'frames') && !positiveInt(shot.frames)) bad('无效镜头');
  const segments = trajectory(p.moves, namedEvents(optional(i, 'events', []), shot.in)), t = f + sub;
  if (!segments.length) return pose(0, 0, 1, 0, height);
  const s = segments.findLast((segment) => segment.start <= t);
  if (!s) return pose(...segments[0].from, segments[0].z0, 0, height);
  if (t >= s.end) return pose(...s.to, s.z1, 0, height);
  // 线性和 smoothstep 各一半。首尾以平均速度的一半起收，中段更快；不让长运镜开头数帧都挤在同一像素内。
  const u = (t - s.start) / s.duration, w = u * (0.5 + u * (1.5 - u)), slope = (0.5 + 3 * u * (1 - u)) / s.duration;
  const dx = s.to[0] - s.from[0], dy = s.to[1] - s.from[1], dz = s.z1 - s.z0, zoom = s.z0 + dz * w;
  const speed = slope * Math.hypot(dx * zoom, dy * zoom, dz * height / 2);
  return pose(s.from[0] + dx * w, s.from[1] + dy * w, zoom, speed, height);
}
