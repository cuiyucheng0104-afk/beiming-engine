// 北冥引擎 · 节拍表与声画事件：画面、配乐、拟音、检查读同一张表（"一条时间线驱动一切"）。
// 段落 = 一段固定速度与拍号的音乐；画面上的每个"打点"写成段落里的地址（小节·拍·拍内分数），再换算成秒。
// 地址换算出的秒数按 digits 位小数取整，页面（JS）与 Python（engine/audio/cues.py 的 Tempo）得到同一个数。
//
//   createTempo(secs, { fps = 24, digits = 6 }) → tempo
//     secs = [{ id, t0, bpm, meter, t1? }]   t0 段落起点（秒）；meter 每小节拍数；t1 省略时取下一段的 t0（末段到无穷）
//     tempo.at(id, bar, beat = 1, frac = 0)   地址 → 秒；bar、beat 从 1 数，frac 是拍内分数（0.5 = 后半拍）
//     tempo.beat(id) / tempo.bar(id)          该段一拍 / 一小节的秒数
//     tempo.section(t)                        t 所在的段落对象（早于第一段取第一段，晚于末段取末段）
//     tempo.cues(map)                         { 名字: [id, bar, beat, frac] } → { 名字: 秒 }（保持 map 的键顺序）
//     tempo.offFrame(t)                       t 到最近整帧的距离（秒）
//     tempo.offGrid(t, div = 2)               t 到所在段落 1/div 拍网格的距离（秒）；div = 2 即八分音符网格
//     tempo.toJSON()                          { fps, secs }：原样给 timeline.json，不改调用方的 secs
//
//   createEvents({ digits = 6 }) → { EV, ev }
//     ev(t, type, fields)                     记一条声画事件 { t, type, ...fields }；t 按 digits 位小数取整
//     EV                                      事件数组，页面把它挂到 window.EV，engine/render/events.mjs 导出成 events.json
//     约定：带 cue 字段的事件是"画面打点"，engine/audio/cuecheck.py 拿它对拍点、对整帧、对音乐起音
//
// 只做换算与记录，不碰画布、不读时钟；同一张表在浏览器和 node 里都能 import。

const fix = (x, digits) => (digits == null ? x : +x.toFixed(digits));

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
  const section = t => list.find(s => s.t0 - 1e-9 <= t && t < s.t1 - 1e-9) || (t < list[0].t0 ? list[0] : list[list.length - 1]);
  const cues = map => Object.fromEntries(Object.entries(map).map(([k, a]) => [k, at(...a)]));
  const offFrame = t => Math.abs(t * fps - Math.round(t * fps)) / fps;
  const offGrid = (t, div = 2) => {
    const s = section(t), step = 60 / s.bpm / div;
    return Math.abs(t - (s.t0 + Math.round((t - s.t0) / step) * step));
  };
  return { at, beat, bar, section, cues, offFrame, offGrid, fps, toJSON: () => ({ fps, secs }) };
}

export function createEvents({ digits = 6 } = {}) {
  const EV = [];
  const ev = (t, type, fields = {}) => { EV.push({ t: fix(t, digits), type, ...fields }); };
  return { EV, ev };
}
