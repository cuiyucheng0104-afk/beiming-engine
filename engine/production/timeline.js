// 北冥引擎 · 作品时间轴：镜头表与事件表是唯一时间源，整数帧是唯一时间单位，秒只由 帧 / fps 推出。
// 纯函数、不读文件、不碰画布，浏览器页面和 Node 都能 import（页面可以 fetch film.json 后直接用）。
// 输入是 film.json v2 的对象（或它的片段）；v1（{dur, fps, size}）只在 timingOf 里兼容读取，完整升级见 film.js。
//
// 帧 ↔ 秒
//   frameToSeconds(f, fps)                    f / fps（精确除法）
//   secondsToFrame(t, fps, mode)              mode：floor = t 所在的那一帧（声音落点、画面先到的量化）
//                                                  ceil  = t ≥ T 的第一帧（阈值事件"从 T 起出现"）
//                                                  round = 最近的帧；exact = 必须正好落在整帧上，否则抛错
//   timecode(f, fps) / parseTimecode(tc, fps) "HH:MM:SS:FF"（非丢帧）
//   timingOf(json)                            v1 / v2 → { version, fps, frameCount, seconds, width, height, shots }
// 镜头
//   checkShots(shots, frameCount)             半开区间 [in, out)、首尾相接、覆盖 [0, frameCount) 的诊断（不抛错）
//   shotAt(film, f) / localFrame(film, f)     帧 → 镜头 / { shot, local, frame }；globalFrame(film, id, local) 反过来
//   cutList(film)                             切点 [{ frame, from, to, transition }]（不含第 0 帧）
//   stageShots(film, byId)                    给 engine/stage/film.js 的 run({ shots })：[{ at: in / fps, shot }]
//   pageTiming(json)                          页面读 film.json 的统一入口（v1 / v2）：DUR、镜头起止秒、t → { shot, local, frame }、事件秒；
//                                             window.DUR = timing.DUR 满足页面约定 v1 的 round(DUR × fps) = frameCount（附录 C5）
//   retimeShot(film, id, { out | length }, { mode: 'ripple' | 'roll' })
//                                             改一个镜头的出点：ripple 后续镜头、事件、刻意画面（qa.intentional）、豁免帧段、海报帧、角色起点整体顺延，总帧数随之变；
//                                             roll 只挪本镜与下一镜之间的切点，总帧数不变。返回新对象，不改入参
//   timingSignature / eventsSignature / shotSignature(film, id)
//                                             稳定的 JSON 文本：前两个给闸门判断"认可之后切点 / 事件改没改"，
//                                             shotSignature 与镜头在片中的位置无关（只含长度、本镜字段、局部帧事件），给镜头级缓存键
// 节拍（与 engine/core/tempo.js 同一公式，存储一律用帧）
//   beatGrid(timeline, { fps, frameCount })   三种写法统一成拍点帧表：
//                                               { sections: [{ id, start, bpm, meter }] }  按 BPM 分段（start 为整数帧）
//                                               { beats: [f0, f1, …], meter? }             逐拍帧表（每拍起点，严格递增整数帧）
//                                               { bars: [[n, n, n, n], …], start? }        小节数组（每小节逐拍帧数）
//                                             → { form, fps, frameCount, beats[], barStarts[], sections[] }
//   frameOfBeat(grid, beat)                   绝对拍号（0 起，可带小数）→ 帧位置（可能是小数；事件帧取 floor，画面先到）
//   beatAt(grid, f)                           帧 → { beat, bar, beatInBar, frac, section }（bar、beatInBar 从 1 数）
//   beatOf(grid, sectionId, bar, beat, frac)  "段·小节·拍"地址 → 绝对拍号（与 tempo.at 的地址写法一致）
//   offGrid(grid)                             不落整帧的拍点：[{ beat, frame, errorMs }]
//   sectionsFromTempo(secs, fps) / tempoSecs(timeline, fps) / filmTempo(film)
//                                             与 tempo.js 的 { id, t0, bpm, meter } 互转；filmTempo 返回 createTempoFromFrames 的对象（页面与 Node 同一套换算）
// 给旧消费者的导出（engine/audio/cues.py、cuecheck.py 读的外形）
//   legacyTimeline(film) → { fps, frameCount, dur, secs?, shots, t }    legacyEvents(film) → { dur, ev: [{ t, type, id, frame, shot, cue? }] }
//
// 出错一律抛 TimelineError（code、message、hint），不静默修正。
import { createTempoFromFrames } from '../core/tempo.js';

/** 帧号比较的容差：1e-6 帧（24 fps 下约 42 纳秒），只用来吸收浮点乘法误差。 */
export const FRAME_EPS = 1e-6;

export class TimelineError extends Error {
  /** @param {string} code @param {string} message @param {string} [hint] */
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'TimelineError';
    this.code = code;
    this.hint = hint;
  }
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const posInt = v => Number.isInteger(v) && v > 0;
const nonNegInt = v => Number.isInteger(v) && v >= 0;

function assertFps(fps) {
  if (!posInt(fps)) throw new TimelineError('fps-invalid', `fps 必须是正整数，收到 ${JSON.stringify(fps)}`, '交付档位的帧率都是整数（24 / 25 / 30）');
}

// ───────────────────────── 帧 ↔ 秒 ─────────────────────────

export function frameToSeconds(frame, fps) {
  assertFps(fps);
  if (!Number.isFinite(frame)) throw new TimelineError('frame-invalid', `帧号必须是有限数字，收到 ${JSON.stringify(frame)}`);
  return frame / fps;
}

export function secondsToFrame(seconds, fps, mode = 'floor') {
  assertFps(fps);
  if (!Number.isFinite(seconds)) throw new TimelineError('seconds-invalid', `秒数必须是有限数字，收到 ${JSON.stringify(seconds)}`);
  const x = seconds * fps;
  switch (mode) {
    case 'floor': return Math.floor(x + FRAME_EPS);
    case 'ceil': return Math.ceil(x - FRAME_EPS);
    case 'round': return Math.round(x);
    case 'exact': {
      const r = Math.round(x);
      if (Math.abs(x - r) > FRAME_EPS) {
        throw new TimelineError('not-on-frame', `${seconds} 秒 × ${fps} fps = ${+x.toFixed(6)} 帧，不落在整帧上`, '时间写成整数帧；确实要取整时明确用 floor（画面先到）或 ceil（t ≥ T 的第一帧）');
      }
      return r;
    }
    default: throw new TimelineError('mode-invalid', `取整方式只能是 floor / ceil / round / exact，收到 ${mode}`);
  }
}

export function timecode(frame, fps) {
  assertFps(fps);
  if (!nonNegInt(frame)) throw new TimelineError('frame-invalid', `时间码只接受非负整数帧，收到 ${JSON.stringify(frame)}`);
  const ff = frame % fps, s = Math.floor(frame / fps);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff, String(fps - 1).length)}`;
}

export function parseTimecode(tc, fps) {
  assertFps(fps);
  const m = /^(\d+):([0-5]\d):([0-5]\d)[:;](\d+)$/.exec(String(tc).trim());
  if (!m) throw new TimelineError('timecode-invalid', `时间码写法不对：${tc}`, '写成 HH:MM:SS:FF，例如 00:00:03:12');
  const [h, mi, s, f] = m.slice(1).map(Number);
  if (f >= fps) throw new TimelineError('timecode-invalid', `帧位 ${f} 超出 ${fps} fps 的范围（0–${fps - 1}）`);
  return ((h * 60 + mi) * 60 + s) * fps + f;
}

/**
 * 读出一份 film.json（v1 或 v2）的时间与画幅，不做完整校验。
 * v1：frameCount = round(dur × fps)，整片视为一个镜头 S1。
 */
export function timingOf(json) {
  if (!isObj(json)) throw new TimelineError('film-invalid', 'film.json 顶层必须是对象');
  if (json.schemaVersion === 2) {
    const o = json.output ?? {};
    assertFps(o.fps);
    if (!posInt(o.frameCount)) throw new TimelineError('framecount-invalid', `output.frameCount 必须是正整数，收到 ${JSON.stringify(o.frameCount)}`);
    const shots = Array.isArray(json.shots) ? json.shots.map(s => ({ id: s.id, in: s.in, out: s.out })) : [];
    return { version: 2, fps: o.fps, frameCount: o.frameCount, seconds: o.frameCount / o.fps, width: o.width, height: o.height, shots };
  }
  assertFps(json.fps);
  if (!(typeof json.dur === 'number' && json.dur > 0 && Number.isFinite(json.dur))) {
    throw new TimelineError('dur-invalid', `v1 记录的 dur 必须是正数（秒），收到 ${JSON.stringify(json.dur)}`);
  }
  const frameCount = Math.round(json.dur * json.fps);
  if (frameCount < 1) throw new TimelineError('dur-invalid', `dur × fps 不足一帧：${json.dur} × ${json.fps}`);
  const [width, height] = Array.isArray(json.size) ? json.size : [undefined, undefined];
  return { version: 1, fps: json.fps, frameCount, seconds: frameCount / json.fps, width, height, shots: [{ id: 'S1', in: 0, out: frameCount }] };
}

// ───────────────────────── 镜头 ─────────────────────────

/**
 * 镜头表的结构诊断。shots 为 [{ id, in, out }]；返回 [{ code, path, message, hint }]，空数组表示通过。
 */
export function checkShots(shots, frameCount) {
  const out = [];
  const push = (code, path, message, hint = '') => out.push({ code, path, message, hint });
  if (!Array.isArray(shots) || !shots.length) {
    push('shots-missing', 'shots', 'shots 必须是非空数组：至少一个镜头覆盖整片', '整片一个镜头时写 [{ "id": "S1", "in": 0, "out": <frameCount> }]');
    return out;
  }
  const seen = new Set();
  let expectIn = 0;
  shots.forEach((s, i) => {
    const p = `shots[${i}]`;
    if (!isObj(s)) { push('shot-invalid', p, '镜头必须是对象'); return; }
    if (typeof s.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s.id)) push('shot-id-invalid', `${p}.id`, `镜头 id 只能用字母、数字、点、下划线、短横线，且字母或数字开头：${JSON.stringify(s.id)}`);
    else if (seen.has(s.id)) push('shot-id-duplicate', `${p}.id`, `镜头 id 重复：${s.id}`);
    else seen.add(s.id);
    if (!nonNegInt(s.in)) push('shot-frame-invalid', `${p}.in`, `in 必须是非负整数帧，收到 ${JSON.stringify(s.in)}`, '时间只写整数帧；秒由 帧 / fps 推出');
    if (!nonNegInt(s.out)) push('shot-frame-invalid', `${p}.out`, `out 必须是非负整数帧，收到 ${JSON.stringify(s.out)}`, '时间只写整数帧；秒由 帧 / fps 推出');
    if (!nonNegInt(s.in) || !nonNegInt(s.out)) { expectIn = nonNegInt(s.out) ? s.out : expectIn; return; }
    if (s.out <= s.in) push('shot-empty', p, `镜头 ${s.id} 的 out（${s.out}）必须大于 in（${s.in}）：区间是 [in, out)`);
    if (s.in !== expectIn) {
      const kind = s.in > expectIn ? `空隙 [${expectIn}, ${s.in})` : `重叠 [${s.in}, ${expectIn})`;
      push('shots-not-contiguous', `${p}.in`, `镜头 ${s.id} 的 in=${s.in} 与上一镜的出点 ${expectIn} 不衔接（${kind}）`,
        i ? `改切点用 node engine/production/film.js retime <作品> --shot ${shots[i - 1]?.id} --out <帧>，后续镜头与事件整体顺延；手改就把后面每一镜的 in / out 与事件一起改` : '第一个镜头从第 0 帧开始');
    }
    expectIn = s.out;
  });
  if (posInt(frameCount) && nonNegInt(expectIn) && expectIn !== frameCount) {
    push('shots-coverage', `shots[${shots.length - 1}].out`, `最后一个镜头止于 ${expectIn}，但 output.frameCount = ${frameCount}：镜头表要正好覆盖 [0, ${frameCount})`,
      '改总长就改最后一镜的 out 和 output.frameCount（retime 会一起改）');
  }
  return out;
}

function requireShots(film) {
  const fps = film?.output?.fps, n = film?.output?.frameCount;
  assertFps(fps);
  const d = checkShots(film?.shots, n);
  if (d.length) throw new TimelineError(d[0].code, d[0].message, d[0].hint);
  return film.shots;
}

export function shotIndex(film, shotId) {
  return Array.isArray(film?.shots) ? film.shots.findIndex(s => s.id === shotId) : -1;
}

export function shotAt(film, frame) {
  const shots = requireShots(film);
  if (!Number.isInteger(frame) || frame < 0 || frame >= film.output.frameCount) return null;
  let lo = 0, hi = shots.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, s = shots[mid];
    if (frame < s.in) hi = mid - 1;
    else if (frame >= s.out) lo = mid + 1;
    else return { ...s, index: mid, length: s.out - s.in };
  }
  return null;
}

export function localFrame(film, frame) {
  const s = shotAt(film, frame);
  if (!s) throw new TimelineError('frame-out-of-range', `第 ${frame} 帧不在 [0, ${film.output.frameCount}) 内`);
  return { shot: s.id, local: frame - s.in, frame };
}

export function globalFrame(film, shotId, local) {
  requireShots(film);
  const i = shotIndex(film, shotId);
  if (i < 0) throw new TimelineError('shot-unknown', `没有镜头 ${shotId}`, `可用：${film.shots.map(s => s.id).join('、')}`);
  const s = film.shots[i];
  if (!Number.isInteger(local) || local < 0 || local >= s.out - s.in) throw new TimelineError('local-out-of-range', `镜头 ${shotId} 的局部帧 ${local} 超出 [0, ${s.out - s.in})`);
  return s.in + local;
}

export function cutList(film) {
  const shots = requireShots(film), fps = film.output.fps;
  return shots.slice(1).map((s, i) => ({ frame: s.in, seconds: s.in / fps, from: shots[i].id, to: s.id, transition: s.transition ?? 'cut' }));
}

export function stageShots(film, byId) {
  const shots = requireShots(film), fps = film.output.fps;
  return shots.map(s => {
    const shot = byId instanceof Map ? byId.get(s.id) : byId?.[s.id];
    if (!shot) throw new TimelineError('shot-builder-missing', `镜头 ${s.id} 没有对应的镜头对象`, '把 film.json 里的每个镜头 id 都交给 stageShots 的第二个参数');
    return { at: s.in / fps, shot };
  });
}

/**
 * 页面读 film.json 的统一入口（纯函数，浏览器与 Node 都能用）：
 *   const timing = pageTiming(await (await fetch('./film.json')).json());
 *   window.DUR = timing.DUR;                         // 页面约定 v1：round(DUR × fps) = output.frameCount
 *   const { shot, local } = timing.at(t);            // t 所在的镜头与镜头内秒数（帧取 floor：画面先到）
 *   const T = timing.event('title.bei').t;           // 事件的结果帧换成秒
 * 镜头与事件都从 film.json 来：改一个镜头的 out（film.js retime），页面的切点与事件时刻跟着变，不改页面代码。
 * @returns {{ version, fps, frameCount, DUR, width, height, shots: Array<{id, in, out, t0, t1, dur}>, events: Array<{id, frame, t, shot, end?, t1?, audio?, visual?, sync?}>,
 *             at(t: number), frameOf(t: number), shot(id: string), event(id: string) }}
 */
export function pageTiming(json) {
  const tm = timingOf(json);
  const { fps, frameCount } = tm;
  const film = { output: { fps, frameCount }, shots: tm.shots };
  requireShots(film);
  const shots = tm.shots.map(s => ({ id: s.id, in: s.in, out: s.out, t0: s.in / fps, t1: s.out / fps, dur: (s.out - s.in) / fps }));
  const byId = new Map(shots.map(s => [s.id, s]));
  const events = (tm.version === 2 && Array.isArray(json.events) ? json.events : []).filter(isObj).map(e => {
    const out = { id: e.id, frame: e.frame, t: e.frame / fps, shot: e.shot };
    if (Number.isInteger(e.end)) { out.end = e.end; out.t1 = e.end / fps; }
    for (const k of ['audio', 'visual', 'sync', 'domain']) if (e[k] !== undefined) out[k] = e[k];
    return out;
  });
  const evById = new Map(events.map(e => [e.id, e]));
  const frameOf = t => Math.min(frameCount - 1, Math.max(0, Math.floor(t * fps + FRAME_EPS)));
  return {
    version: tm.version, fps, frameCount, DUR: frameCount / fps, width: tm.width, height: tm.height, shots, events,
    frameOf,
    at(t) {
      if (!Number.isFinite(t)) throw new TimelineError('seconds-invalid', `秒数必须是有限数字，收到 ${JSON.stringify(t)}`);
      const frame = frameOf(t), s = shotAt(film, frame);
      return { shot: s.id, index: s.index, local: t - s.in / fps, localFrame: frame - s.in, frame };
    },
    shot(id) {
      const s = byId.get(id);
      if (!s) throw new TimelineError('shot-unknown', `没有镜头 ${id}`, `可用：${shots.map(x => x.id).join('、')}`);
      return s;
    },
    event(id) {
      const e = evById.get(id);
      if (!e) throw new TimelineError('event-unknown', `没有事件 ${id}`, '事件写在 film.json 的 events[]（id、frame、shot）');
      return e;
    },
  };
}

// ───────────────────────── 改切点 ─────────────────────────

const clone = v => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

const QA_RANGE_LISTS = ['intentional', 'holds', 'blackouts', 'flashes'];
/**
 * film.qa 里所有帧区间（刻意画面与豁免的帧段）：[{ label, get() → [a, b], set(a, b) }]。
 * 刻意画面写 from / to（也认 in / out），豁免写 frames: [a, b)。改切点时它们和事件一样跟着镜头走。
 */
export function qaRanges(film) {
  const q = isObj(film?.qa) ? film.qa : null, out = [];
  if (!q) return out;
  for (const list of QA_RANGE_LISTS) {
    (Array.isArray(q[list]) ? q[list] : []).forEach((it, k) => {
      if (!isObj(it)) return;
      const [fa, fb] = it.in !== undefined || it.out !== undefined ? ['in', 'out'] : ['from', 'to'];
      if (!Number.isInteger(it[fa]) || !Number.isInteger(it[fb])) return;
      out.push({ label: `qa.${list}[${k}]`, get: () => [it[fa], it[fb]], set: (a, b) => { it[fa] = a; it[fb] = b; } });
    });
  }
  (Array.isArray(q.waivers) ? q.waivers : []).forEach((w, k) => {
    if (!isObj(w) || !Array.isArray(w.frames) || !w.frames.every(Number.isInteger)) return;
    out.push({ label: `qa.waivers[${k}].frames`, get: () => [w.frames[0], w.frames[1]], set: (a, b) => { w.frames = [a, b]; } });
  });
  return out;
}

/**
 * 改镜头出点。ripple：本镜之后的一切（镜头、事件、停顿、海报帧、后面镜头的角色起点）整体平移 delta，总帧数随之变；
 * roll：只挪本镜与下一镜之间的切点，总帧数不变。冲突（事件会落到镜头外等）一律抛错，不替你删改。
 * 贴着切点的事件跟着切点走：本镜里 end 正好等于旧出点的（整镜铺底、到切点为止的声音）改到新出点；
 * roll 时下一镜里正好落在旧切点上的事件（切点上的那一声、显示层出现）改到新切点。
 * @returns {{ film: object, delta: number, mode: string, frameCount: {from: number, to: number}, moved: object }}
 */
export function retimeShot(film, shotId, change = {}, { mode = 'ripple' } = {}) {
  requireShots(film);
  if (!['ripple', 'roll'].includes(mode)) throw new TimelineError('mode-invalid', `mode 只能是 ripple 或 roll，收到 ${mode}`);
  const i = shotIndex(film, shotId);
  if (i < 0) throw new TimelineError('shot-unknown', `没有镜头 ${shotId}`, `可用：${film.shots.map(s => s.id).join('、')}`);
  const shot = film.shots[i], oldOut = shot.out;
  const hasOut = change.out !== undefined, hasLen = change.length !== undefined;
  if (hasOut === hasLen) throw new TimelineError('retime-args', '只给 out 或 length 中的一个', '例：{ out: 132 } 或 { length: 60 }');
  const newOut = hasOut ? change.out : shot.in + change.length;
  if (!Number.isInteger(newOut) || newOut <= shot.in) throw new TimelineError('retime-args', `新的出点必须是大于入点 ${shot.in} 的整数帧，收到 ${JSON.stringify(newOut)}`);
  const delta = newOut - oldOut;
  const next = clone(film);
  const result = { film: next, delta, mode, frameCount: { from: film.output.frameCount, to: film.output.frameCount }, moved: { shots: [], events: [], ranges: [], origins: [] } };
  if (delta === 0) return result;

  const events = Array.isArray(next.events) ? next.events : [];
  const ranges = qaRanges(next);
  const shotIdx = new Map(next.shots.map((s, k) => [s.id, k]));
  const conflicts = [];

  if (mode === 'roll') {
    if (i === next.shots.length - 1) throw new TimelineError('retime-args', `镜头 ${shotId} 是最后一镜，没有下一镜可以 roll`, '改总长用 ripple');
    const after = next.shots[i + 1];
    if (newOut >= after.out) throw new TimelineError('retime-args', `roll 后下一镜 ${after.id} 会变成空镜头（新切点 ${newOut} ≥ 它的出点 ${after.out}）`);
    const onCut = e => e.shot === after.id && e.frame === oldOut;   // 切点上的事件：跟着切点走
    for (const e of events) {
      if (e.shot === shot.id && e.frame >= newOut) conflicts.push(`事件 ${e.id}（第 ${e.frame} 帧）属于 ${shot.id}，会落进 ${after.id}`);
      if (e.shot === shot.id && e.end !== undefined && e.end !== oldOut && e.end > newOut && e.end <= oldOut) conflicts.push(`事件 ${e.id} 的 end=${e.end} 会越过新切点 ${newOut}`);
      if (e.shot === after.id && e.frame < newOut && !onCut(e)) conflicts.push(`事件 ${e.id}（第 ${e.frame} 帧）属于 ${after.id}，会落进 ${shot.id}`);
      if (onCut(e) && e.end !== undefined && e.end <= newOut) conflicts.push(`事件 ${e.id} 贴着切点开始，挪到第 ${newOut} 帧后会超过它的 end=${e.end}`);
    }
    if (conflicts.length) throw new TimelineError('retime-conflict', `roll 冲突：\n- ${conflicts.join('\n- ')}`, '先把这些事件改到新切点的正确一侧（或改它的 shot），再 roll');
    for (const e of events) {
      if (onCut(e)) { e.frame = newOut; result.moved.events.push({ id: e.id, frame: [oldOut, newOut] }); }
      else if (e.shot === shot.id && e.end === oldOut) { e.end = newOut; result.moved.events.push({ id: e.id, end: [oldOut, newOut] }); }
    }
    // 贴着切点的刻意画面 / 豁免帧段跟着切点走（到切点为止的、从切点开始的）；其余区间留在原来的全局帧
    for (const r of ranges) {
      const [a, b] = r.get();
      if (b === oldOut && a < newOut) { r.set(a, newOut); result.moved.ranges.push({ label: r.label, from: [a, b], to: [a, newOut] }); }
      else if (a === oldOut && newOut < b) { r.set(newOut, b); result.moved.ranges.push({ label: r.label, from: [a, b], to: [newOut, b] }); }
    }
    // 下一镜里从切点起算的角色时钟（起点 = 旧切点）跟着切点走；其余起点不动（内容留在原来的全局时刻）
    if (isObj(after.actorClockOrigin)) {
      for (const [track, f] of Object.entries(after.actorClockOrigin)) {
        if (f === oldOut) { after.actorClockOrigin[track] = newOut; result.moved.origins.push({ shot: after.id, track, from: f, to: newOut }); }
      }
    }
    next.shots[i].out = newOut;
    after.in = newOut;
    result.moved.shots.push({ id: shot.id, out: [oldOut, newOut] }, { id: after.id, in: [oldOut, newOut] });
    return result;
  }

  // ripple：节拍主导的片子改镜头长度会让后面的画面离开音乐网格，不替你决定
  if (next.drive === 'beat' || events.some(e => e.beat !== undefined && (shotIdx.get(e.shot) ?? -1) > i)) {
    throw new TimelineError('beat-locked', `节拍主导：ripple 会把 ${shotId} 之后的画面整体挪离节拍网格`, '用 roll 在两镜之间挪切点（总长不变），或先改 timeline 再手改 shots 与事件');
  }
  if (delta < 0) {
    for (const e of events) {
      if (e.shot !== shot.id) continue;
      if (e.frame >= newOut) conflicts.push(`事件 ${e.id}（第 ${e.frame} 帧）会落到镜头 ${shot.id} 的新出点 ${newOut} 之外`);
      else if (e.end !== undefined && e.end !== oldOut && e.end > newOut && e.end < oldOut) conflicts.push(`事件 ${e.id} 的 end=${e.end} 落在被剪掉的 [${newOut}, ${oldOut}) 里`);
    }
    for (const r of ranges) {
      // 从被剪掉的 [newOut, oldOut) 里开始、或在里面结束的区间没有归宿；到出点为止或跨过切点的跟着出点缩短
      const [a, b] = r.get();
      if (a >= newOut && a < oldOut) conflicts.push(`${r.label} [${a}, ${b}) 从被剪掉的 [${newOut}, ${oldOut}) 里开始`);
      else if (a < newOut && b > newOut && b < oldOut) conflicts.push(`${r.label} [${a}, ${b}) 在被剪掉的 [${newOut}, ${oldOut}) 里结束`);
    }
    if (Number.isInteger(next.posterFrame) && next.posterFrame >= newOut && next.posterFrame < oldOut) conflicts.push(`posterFrame=${next.posterFrame} 落在被剪掉的 [${newOut}, ${oldOut}) 里`);
    if (conflicts.length) throw new TimelineError('retime-conflict', `缩短 ${shotId} 冲突：\n- ${conflicts.join('\n- ')}`, '先把这些事件 / 刻意画面 / 豁免帧段 / 海报帧挪到新出点之前，再改');
  }

  next.shots[i].out = newOut;
  result.moved.shots.push({ id: shot.id, out: [oldOut, newOut] });
  for (let k = i + 1; k < next.shots.length; k++) {
    const s = next.shots[k], from = [s.in, s.out];
    s.in += delta; s.out += delta;
    result.moved.shots.push({ id: s.id, in: [from[0], s.in], out: [from[1], s.out] });
    if (isObj(s.actorClockOrigin)) {
      // 后面的镜头整段平移：它的角色时钟也是镜头内容的一部分，跟着平移（镜头内的一拍 n 相位不变）
      for (const [track, f] of Object.entries(s.actorClockOrigin)) {
        if (Number.isInteger(f)) { s.actorClockOrigin[track] = f + delta; result.moved.origins.push({ shot: s.id, track, from: f, to: f + delta }); }
      }
    }
  }
  for (const e of events) {
    const k = shotIdx.get(e.shot) ?? -1;
    if (k > i) {
      const f0 = e.frame;
      e.frame += delta;
      if (e.end !== undefined) e.end += delta;
      result.moved.events.push({ id: e.id, frame: [f0, e.frame] });
    } else if (k === i && e.end !== undefined && e.end >= oldOut) {
      e.end += delta;   // 到切点为止（end = 旧出点）的跟着新出点走；跨切点延续的声音（L-cut）跟着后面的镜头走
      result.moved.events.push({ id: e.id, end: [e.end - delta, e.end] });
    }
  }
  for (const r of ranges) {
    // 后面镜头里的整体平移；到本镜出点为止（或跨过切点）的终点跟着出点走，与事件的 end 同一规则
    const [a, b] = r.get();
    if (a >= oldOut) { r.set(a + delta, b + delta); result.moved.ranges.push({ label: r.label, from: [a, b], to: [a + delta, b + delta] }); }
    else if (b >= oldOut) { r.set(a, b + delta); result.moved.ranges.push({ label: r.label, from: [a, b], to: [a, b + delta] }); }
  }
  if (Number.isInteger(next.posterFrame) && next.posterFrame >= oldOut) next.posterFrame += delta;
  next.output.frameCount += delta;
  if (typeof next.dur === 'number') next.dur = next.output.frameCount / next.output.fps;   // v1 兼容镜像字段同步
  result.frameCount.to = next.output.frameCount;
  return result;
}

// ───────────────────────── 签名（闸门与缓存键的材料） ─────────────────────────

/** 键排序后的 JSON：同样的内容永远得到同样的文本。 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObj(value)) return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

export function timingSignature(film) {
  const o = film?.output ?? {};
  return stableStringify({ fps: o.fps, frameCount: o.frameCount, shots: (film?.shots ?? []).map(s => [s.id, s.in, s.out, s.transition ?? 'cut']) });
}

export function eventsSignature(film) {
  const ev = [...(film?.events ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return stableStringify(ev.map(e => [e.id, e.frame, e.shot, e.end ?? null, e.audio ?? null, e.beat ?? null]));
}

/** 与镜头位置无关的签名：只平移不改内容的镜头签名不变（ripple 前面的镜头不会让它重渲）。 */
export function shotSignature(film, shotId) {
  requireShots(film);
  const i = shotIndex(film, shotId);
  if (i < 0) throw new TimelineError('shot-unknown', `没有镜头 ${shotId}`);
  const s = film.shots[i], o = film.output;
  const { in: _in, out: _out, actorClockOrigin, ...fields } = s;
  const origins = isObj(actorClockOrigin) ? Object.fromEntries(Object.entries(actorClockOrigin).map(([k, f]) => [k, f - s.in])) : undefined;
  const events = (film.events ?? []).filter(e => e.shot === s.id).map(e => ({ ...e, frame: e.frame - s.in, end: e.end === undefined ? undefined : e.end - s.in }))
    .sort((a, b) => a.frame - b.frame || String(a.id).localeCompare(String(b.id)));
  const ranges = qaRanges(film).map(r => [r.label.replace(/\[\d+\].*$/, ''), ...r.get()]).filter(([, a, b]) => a < s.out && b > s.in)
    .map(([list, a, b]) => [list, Math.max(a, s.in) - s.in, Math.min(b, s.out) - s.in]).sort((x, y) => x[1] - y[1] || x[2] - y[2] || x[0].localeCompare(y[0]));
  return stableStringify({ fps: o.fps, width: o.width, height: o.height, length: s.out - s.in, shot: fields, originsLocal: origins, events, ranges });
}

// ───────────────────────── 节拍 ─────────────────────────

function sectionGrid(sections, fps, frameCount) {
  const secs = [], beats = [], barStarts = [];
  let prevStart = -1;
  sections.forEach((s, k) => {
    const p = `timeline.sections[${k}]`;
    if (!isObj(s)) throw new TimelineError('timeline-invalid', `${p} 必须是对象`);
    if (typeof s.id !== 'string' || !s.id) throw new TimelineError('timeline-invalid', `${p}.id 必须是非空字符串`);
    if (!nonNegInt(s.start)) throw new TimelineError('timeline-invalid', `${p}.start 必须是非负整数帧，收到 ${JSON.stringify(s.start)}`, 'tempo.js 的 t0 秒数换成帧：t0 × fps（必须正好是整数）');
    if (s.start <= prevStart) throw new TimelineError('timeline-invalid', `${p}.start 必须严格递增`);
    if (k === 0 && s.start !== 0) throw new TimelineError('timeline-invalid', `第一个段落要从第 0 帧开始（收到 ${s.start}）`, '片头没有音乐网格时，用一段同速的引子段覆盖');
    if (!(typeof s.bpm === 'number' && s.bpm > 0 && Number.isFinite(s.bpm))) throw new TimelineError('timeline-invalid', `${p}.bpm 必须是正数`);
    if (!posInt(s.meter)) throw new TimelineError('timeline-invalid', `${p}.meter（每小节拍数）必须是正整数`);
    prevStart = s.start;
  });
  sections.forEach((s, k) => {
    const end = k + 1 < sections.length ? sections[k + 1].start : frameCount;
    const fpb = fps * 60 / s.bpm, firstBeat = beats.length;
    for (let n = 0; ; n++) {
      const f = s.start + n * fpb;
      if (f >= end - FRAME_EPS) break;
      if (n % s.meter === 0) barStarts.push(beats.length);
      beats.push(f);
    }
    secs.push({ id: s.id, start: s.start, end, bpm: s.bpm, meter: s.meter, framesPerBeat: fpb, firstBeat, beatCount: beats.length - firstBeat });
  });
  return { secs, beats, barStarts };
}

export function beatGrid(timeline, { fps, frameCount } = {}) {
  assertFps(fps);
  if (!posInt(frameCount)) throw new TimelineError('framecount-invalid', `frameCount 必须是正整数，收到 ${JSON.stringify(frameCount)}`);
  if (!isObj(timeline)) throw new TimelineError('timeline-invalid', 'timeline 必须是对象');
  const forms = ['sections', 'beats', 'bars'].filter(k => timeline[k] !== undefined);
  if (forms.length !== 1) throw new TimelineError('timeline-invalid', `timeline 必须且只能用一种写法：sections（按 BPM 分段）、beats（逐拍帧表）或 bars（小节数组），收到 ${forms.join(' + ') || '都没有'}`);
  const form = forms[0];
  let secs = [], beats = [], barStarts = [];
  if (form === 'sections') {
    if (!Array.isArray(timeline.sections) || !timeline.sections.length) throw new TimelineError('timeline-invalid', 'timeline.sections 必须是非空数组');
    ({ secs, beats, barStarts } = sectionGrid(timeline.sections, fps, frameCount));
  } else if (form === 'beats') {
    const b = timeline.beats;
    if (!Array.isArray(b) || !b.length) throw new TimelineError('timeline-invalid', 'timeline.beats 必须是非空数组');
    b.forEach((f, k) => {
      if (!nonNegInt(f)) throw new TimelineError('timeline-invalid', `timeline.beats[${k}] 必须是非负整数帧，收到 ${JSON.stringify(f)}`);
      if (k && f <= b[k - 1]) throw new TimelineError('timeline-invalid', `timeline.beats 必须严格递增（第 ${k} 拍 ${f} ≤ ${b[k - 1]}）`);
    });
    if (b[b.length - 1] >= frameCount) throw new TimelineError('timeline-invalid', `最后一拍 ${b[b.length - 1]} 超出片长 [0, ${frameCount})`);
    const meter = timeline.meter ?? 4;
    if (!posInt(meter)) throw new TimelineError('timeline-invalid', 'timeline.meter 必须是正整数');
    beats = [...b];
    for (let k = 0; k < beats.length; k += meter) barStarts.push(k);
    secs = [{ id: timeline.id ?? 'M', start: b[0], end: frameCount, bpm: null, meter, framesPerBeat: null, firstBeat: 0, beatCount: beats.length }];
  } else {
    const bars = timeline.bars, start = timeline.start ?? 0;
    if (!Array.isArray(bars) || !bars.length) throw new TimelineError('timeline-invalid', 'timeline.bars 必须是非空数组：每小节一个"逐拍帧数"数组');
    if (!nonNegInt(start)) throw new TimelineError('timeline-invalid', 'timeline.start 必须是非负整数帧');
    let f = start;
    bars.forEach((bar, k) => {
      if (!Array.isArray(bar) || !bar.length || !bar.every(posInt)) throw new TimelineError('timeline-invalid', `timeline.bars[${k}] 必须是正整数数组（这一小节每拍几帧），收到 ${JSON.stringify(bar)}`);
      barStarts.push(beats.length);
      for (const n of bar) { beats.push(f); f += n; }
    });
    if (f > frameCount) throw new TimelineError('timeline-invalid', `小节数组合计到第 ${f} 帧，超出片长 ${frameCount}`);
    secs = [{ id: timeline.id ?? 'M', start, end: frameCount, bpm: null, meter: null, framesPerBeat: null, firstBeat: 0, beatCount: beats.length }];
  }
  return { form, fps, frameCount, beats, barStarts, sections: secs };
}

export function frameOfBeat(grid, beat) {
  if (!(typeof beat === 'number' && Number.isFinite(beat) && beat >= 0)) throw new TimelineError('beat-invalid', `拍号必须是非负数（0 起），收到 ${JSON.stringify(beat)}`);
  const b = grid.beats, k = Math.floor(beat + FRAME_EPS), frac = beat - k;
  if (k >= b.length) {
    const s = grid.sections[grid.sections.length - 1];
    if (s.framesPerBeat) return s.start + (beat - s.firstBeat) * s.framesPerBeat;
    throw new TimelineError('beat-out-of-range', `拍号 ${beat} 超出节拍表（共 ${b.length} 拍）`);
  }
  if (Math.abs(frac) < FRAME_EPS) return b[k];
  const nextF = k + 1 < b.length ? b[k + 1] : (grid.sections.find(s => k >= s.firstBeat && k < s.firstBeat + s.beatCount)?.framesPerBeat ?? (b[k] - b[k - 1] || 0)) + b[k];
  return b[k] + frac * (nextF - b[k]);
}

export function beatAt(grid, frame) {
  const b = grid.beats;
  if (!(Number.isFinite(frame) && frame >= b[0] - FRAME_EPS)) return null;
  let lo = 0, hi = b.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (b[mid] <= frame + FRAME_EPS) lo = mid; else hi = mid - 1; }
  const nextF = lo + 1 < b.length ? b[lo + 1] : grid.frameCount;
  const frac = nextF > b[lo] ? Math.min(1, Math.max(0, (frame - b[lo]) / (nextF - b[lo]))) : 0;
  let bar = 0;
  while (bar + 1 < grid.barStarts.length && grid.barStarts[bar + 1] <= lo) bar++;
  const section = grid.sections.find(s => lo >= s.firstBeat && lo < s.firstBeat + s.beatCount) ?? grid.sections[grid.sections.length - 1];
  return { beat: lo + frac, bar: bar + 1, beatInBar: lo - grid.barStarts[bar] + 1, frac, section: section.id };
}

export function beatOf(grid, sectionId, bar, beat = 1, frac = 0) {
  const s = grid.sections.find(x => x.id === sectionId);
  if (!s) throw new TimelineError('section-unknown', `节拍表里没有段落 ${sectionId}`, `可用：${grid.sections.map(x => x.id).join('、')}`);
  if (!posInt(bar) || !posInt(beat)) throw new TimelineError('beat-invalid', '小节与拍都从 1 数，必须是正整数');
  if (s.meter) return s.firstBeat + (bar - 1) * s.meter + (beat - 1) + frac;
  const barIdx = grid.barStarts.findIndex(k => k >= s.firstBeat) + bar - 1;
  if (barIdx >= grid.barStarts.length) throw new TimelineError('beat-out-of-range', `第 ${bar} 小节超出节拍表`);
  return grid.barStarts[barIdx] + (beat - 1) + frac;
}

export function offGrid(grid) {
  return grid.beats.map((f, beat) => ({ beat, frame: f, errorMs: Math.abs(f - Math.round(f)) / grid.fps * 1000 }))
    .filter(x => x.errorMs > FRAME_EPS / grid.fps * 1000);
}

export function sectionsFromTempo(secs, fps) {
  assertFps(fps);
  if (!Array.isArray(secs) || !secs.length) throw new TimelineError('timeline-invalid', 'tempo 段落表必须是非空数组');
  return secs.map((s, k) => {
    let start;
    try { start = secondsToFrame(s.t0, fps, 'exact'); }
    catch { throw new TimelineError('not-on-frame', `段落 ${s.id ?? k} 的 t0=${s.t0} 秒不落在整帧上（${fps} fps）`, '段落起点要落在整帧；换速度时先算好每拍帧数'); }
    return { id: s.id, start, bpm: s.bpm, meter: s.meter };
  });
}

export function tempoSecs(timeline, fps) {
  assertFps(fps);
  if (!Array.isArray(timeline?.sections)) throw new TimelineError('timeline-form', 'tempo.js 只表达按 BPM 分段的写法；逐拍帧表与小节数组没有对应的 secs');
  return timeline.sections.map(s => ({ id: s.id, t0: s.start / fps, bpm: s.bpm, meter: s.meter }));
}

export function filmTempo(film) {
  const fps = film?.output?.fps;
  tempoSecs(film?.timeline, fps);   // 只接受按 BPM 分段的写法，其他写法在这里报 timeline-form
  return createTempoFromFrames(film.timeline.sections, { fps });
}

// ───────────────────────── 给旧消费者的导出 ─────────────────────────

export function legacyTimeline(film) {
  requireShots(film);
  const { fps, frameCount } = film.output;
  const t = {};
  for (const e of film.events ?? []) t[e.id] = e.frame / fps;
  const out = { fps, frameCount, dur: frameCount / fps, shots: film.shots.map(s => ({ id: s.id, in: s.in, out: s.out, t0: s.in / fps, t1: s.out / fps })), t };
  if (Array.isArray(film.timeline?.sections)) out.secs = tempoSecs(film.timeline, fps);
  return out;
}

export function legacyEvents(film) {
  requireShots(film);
  const { fps, frameCount } = film.output;
  const ev = [...(film.events ?? [])].sort((a, b) => a.frame - b.frame || String(a.id).localeCompare(String(b.id))).map(e => {
    const row = { t: e.frame / fps, type: e.visual ?? e.domain ?? 'event', id: e.id, frame: e.frame, shot: e.shot };
    if (e.end !== undefined) row.t1 = e.end / fps;
    if (e.audio !== undefined) row.audio = e.audio;
    if (e.beat !== undefined || e.cue) row.cue = e.id;
    return row;
  });
  return { dur: frameCount / fps, ev };
}
