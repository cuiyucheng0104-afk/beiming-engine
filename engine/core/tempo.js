// 北冥引擎 · 节拍表与声画事件：画面、配乐、拟音、检查读同一张表（"一条时间线驱动一切"）。
// 段落 = 一段固定速度与拍号的音乐；画面上的每个"打点"写成段落里的地址（小节·拍·拍内分数），再换算成秒或帧。
// 地址换算出的秒数按 digits 位小数取整，页面（JS）与 Python（engine/audio/cues.py 的 Tempo）得到同一个数。
// 作品的时间以 film.json v2 为准（整数帧；见 engine/production/timeline.js）：页面读 film.json 的 timeline.sections
// 时用 createTempoFromFrames，事件帧用 tempo.frame（floor：画面先到，与 timeline.js 的 frameOfBeat 取整一致）。
//
//   createTempo(secs, { fps = 24, digits = 6 }) → tempo
//     secs = [{ id, t0, bpm, meter, t1? }]   t0 段落起点（秒）；meter 每小节拍数；t1 省略时取下一段的 t0（末段到无穷）
//     tempo.at(id, bar, beat = 1, frac = 0)   地址 → 秒；bar、beat 从 1 数，frac 是拍内分数（0.5 = 后半拍）
//     tempo.frame(id, bar, beat = 1, frac = 0) 地址 → 结果帧：floor(秒 × fps)（不落整帧时画面先到）
//     tempo.frameOf(t)                        秒 → 所在的那一帧 floor(t × fps)
//     tempo.beat(id) / tempo.bar(id)          该段一拍 / 一小节的秒数
//     tempo.framesPerBeat(id)                 该段一拍的帧数（fps × 60 / bpm，可能不是整数）
//     tempo.section(t)                        t 所在的段落对象（早于第一段取第一段，晚于末段取末段）
//     tempo.cues(map)                         { 名字: [id, bar, beat, frac] } → { 名字: 秒 }（保持 map 的键顺序）
//     tempo.cueFrames(map)                    同上，换成结果帧
//     tempo.offFrame(t)                       t 到最近整帧的距离（秒）
//     tempo.offGrid(t, div = 2)               t 到所在段落 1/div 拍网格的距离（秒）；div = 2 即八分音符网格
//     tempo.toJSON()                          { fps, secs }：原样给 timeline.json，不改调用方的 secs
//
//   createTempoFromFrames(sections, { fps, digits }) → tempo
//     sections = [{ id, start, bpm, meter }]  film.json v2 的 timeline.sections（start 是整数帧）；换成 t0 = start / fps 后同 createTempo
//
//   createEvents({ digits = 6 }) → { EV, ev }
//     ev(t, type, fields)                     记一条声画事件 { t, type, ...fields }；t 按 digits 位小数取整
//     EV                                      事件数组，页面把它挂到 window.EV，engine/render/events.mjs 导出成 events.json
//     约定：带 cue 字段的事件是"画面打点"，engine/audio/cuecheck.py 拿它对拍点、对整帧、对音乐起音
//
// 只做换算与记录，不碰画布、不读时钟；同一张表在浏览器和 node 里都能 import。
// 出处：做法（一份时间线驱动画面、配乐、混音、字幕与检查；打点写成"段·小节·拍"）借鉴第三方风格库
// cases/vendor/lemo-opuscar/TECHNIQUE.md §3「One timeline drives everything」@bebbbe1（MIT，见 THIRD-PARTY.md）；
// 代码由本仓库按 C 路线 66 部风格实验的共用写法重写，不含上游代码。

const fix = (x, digits) => (digits == null ? x : +x.toFixed(digits));
/** 帧号取整的容差（1e-6 帧）：只吸收 t × fps 的浮点误差，与 engine/production/timeline.js 的 FRAME_EPS 相同。 */
const FRAME_EPS = 1e-6;

export function createTempo(secs, { fps = 24, digits = 6 } = {}) {
  if (!secs.length) throw new Error('createTempo：至少要一个段落');
  const list = secs.map((s, i) => ({ ...s, t1: s.t1 ?? (i + 1 < secs.length ? secs[i + 1].t0 : Infinity) }));
  const byId = Object.fromEntries(list.map(s => [s.id, s]));
  const get = id => { const s = byId[id]; if (!s) throw new Error(`节拍表里没有段落 ${id}`); return s; };

  const beat = id => 60 / get(id).bpm;
  const bar = id => get(id).meter * 60 / get(id).bpm;
  const at = (id, b, bt = 1, frac = 0) => {
    const s = get(id);
    return fix(s.t0 + ((b - 1) * s.meter + (bt - 1) + frac) * 60 / s.bpm, digits);
  };
  const frameOf = t => Math.floor(t * fps + FRAME_EPS);
  const frame = (id, b, bt = 1, frac = 0) => frameOf(at(id, b, bt, frac));
  const framesPerBeat = id => fps * 60 / get(id).bpm;
  const section = t => list.find(s => s.t0 - 1e-9 <= t && t < s.t1 - 1e-9) || (t < list[0].t0 ? list[0] : list[list.length - 1]);
  const cues = map => Object.fromEntries(Object.entries(map).map(([k, a]) => [k, at(...a)]));
  const cueFrames = map => Object.fromEntries(Object.entries(map).map(([k, a]) => [k, frame(...a)]));
  const offFrame = t => Math.abs(t * fps - Math.round(t * fps)) / fps;
  const offGrid = (t, div = 2) => {
    const s = section(t), step = 60 / s.bpm / div;
    return Math.abs(t - (s.t0 + Math.round((t - s.t0) / step) * step));
  };
  return { at, frame, frameOf, beat, bar, framesPerBeat, section, cues, cueFrames, offFrame, offGrid, fps, toJSON: () => ({ fps, secs }) };
}

export function createTempoFromFrames(sections, { fps, digits = 6 } = {}) {
  if (!(Number.isInteger(fps) && fps > 0)) throw new Error(`createTempoFromFrames：fps 必须是正整数，收到 ${JSON.stringify(fps)}`);
  if (!Array.isArray(sections) || !sections.length) throw new Error('createTempoFromFrames：至少要一个段落');
  const secs = sections.map((s, i) => {
    if (!(Number.isInteger(s?.start) && s.start >= 0)) throw new Error(`createTempoFromFrames：第 ${i + 1} 段的 start 必须是非负整数帧，收到 ${JSON.stringify(s?.start)}`);
    return { id: s.id, t0: s.start / fps, bpm: s.bpm, meter: s.meter };
  });
  return createTempo(secs, { fps, digits });
}

export function createEvents({ digits = 6 } = {}) {
  const EV = [];
  const ev = (t, type, fields = {}) => { EV.push({ t: fix(t, digits), type, ...fields }); };
  return { EV, ev };
}
