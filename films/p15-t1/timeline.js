// 《北冥》的时间：film.json 是唯一时间源（片长 dur、帧率 fps、节拍段落 tempo、画面打点 cues），这里只做换算。
// 改节奏、改片长、挪打点只改 film.json：画面（film.js）、声音（mix.py 读导出的 events.json / timeline.json）、
// 拍点核对（engine/audio/cuecheck.py）都读同一组数字，不在两处各写一个数。
//   FPS DUR FRAMES SECS CUES      原样来自 film.json（SECS = tempo，CUES = 打点地址 [段落, 小节, 拍, 拍内分数]）
//   T                              { 打点: 秒 }（6 位小数；拍点那一帧就是"结果帧"：笔已收、字已落、印已钤）
//   BEAT                           第一段一拍的秒数
//   ACT                            每个动作的时间窗 { t0, t1 }：从打点倒推"起步"（提前几拍），不另写绝对时刻
//   buildEvents(scene) → EV        声画事件表（engine/render/events.mjs 导出为 events.json）；scene 来自 film.js（声像、题字字数）
//   TIMELINE                       给 timeline.json：{ fps, secs, dur, cues, t, act }
// 写错时（缺打点、打点不在整帧、段落不存在、片长不是整帧）页面直接抛错，渲染器以非零退出码停下，报错写明改哪里。
import FILM from './film.json' with { type: 'json' };
import { createTempo, createEvents } from '../../engine/core/tempo.js';

const fail = msg => { throw new Error(`film.json：${msg}`); };
const fix = x => +x.toFixed(6);

export const FPS = FILM.fps;
export const DUR = FILM.dur;
export const FRAMES = Math.round(DUR * FPS);
if (!(Number.isInteger(FPS) && FPS > 0)) fail(`fps 应为正整数，现在是 ${JSON.stringify(FPS)}`);
if (!(DUR > 0) || Math.abs(DUR * FPS - FRAMES) > 1e-6) fail(`dur × fps 应为整数帧（现在 ${DUR} × ${FPS} = ${DUR * FPS}）`);

export const SECS = FILM.tempo;
if (!Array.isArray(SECS) || !SECS.length) fail('缺少 tempo（节拍段落 [{ id, t0, bpm, meter }]）');
const tempo = createTempo(SECS, { fps: FPS });
export const CUES = FILM.cues || {};
export const T = tempo.cues(CUES);
export const BEAT = tempo.beat(SECS[0].id);

// 本模版用到的打点：缺了就说清楚缺哪个（新增打点随意，删这几个要同时改 film.js 与 mix.py）
const NEED = ['touch', 's1', 's2', 's3', 'title', 'seal'];
for (const k of NEED) if (!(k in T)) fail(`cues 缺少 "${k}"（本模版的画面与声音都按它编排）`);
for (const [k, t] of Object.entries(T)) {
  if (t < 0 || t >= DUR) fail(`打点 ${k} 在 ${t} 秒，超出片长 [0, ${DUR})`);
  if (Math.abs(t * FPS - Math.round(t * FPS)) > 1e-4) fail(`打点 ${k} 落在第 ${(t * FPS).toFixed(3)} 帧，不是整帧：把速度换成每拍整帧的值（${FPS} fps 下 72 / 90 / 120 / 144 BPM 每拍 20 / 16 / 12 / 10 帧），或改拍内分数`);
}

// 动作窗口：结果落在打点上，起步按"提前几拍"倒推（tempo 一改，窗口跟着伸缩）
const win = (t0, t1) => ({ t0: fix(Math.max(0, t0)), t1: fix(Math.max(t0, t1)) });
export const ACT = {
  s1: win(T.touch, T.s1),                          // 主峰：触纸那一拍起笔，一笔成山，收笔落在拍上
  s2: win(T.s2 - 0.75 * BEAT, T.s2),               // 次峰：提前 3/4 拍起笔
  s3: win(T.s3 - 0.75 * BEAT, T.s3),               // 远山：淡墨湿笔，提前 3/4 拍
  w1: win(T.s3 + 0.25 * BEAT, T.s3 + 0.75 * BEAT), // 水纹：远山落定后在水面一掠，两笔在后半拍上
  w2: win(T.s3 + 0.75 * BEAT, T.s3 + 1.25 * BEAT),
  mist: win(T.s3, T.s3 + 2 * BEAT),                // 云：远山落定后两拍里漫开（山腰与山脚）
  breath: win(T.s3 + 2 * BEAT, T.title - BEAT),    // 呼吸：什么都不新添，声音只剩房间底噪
  title: win(T.title - BEAT, T.title),             // 题字：提前一拍起笔，落定在第 3 小节第 1 拍
  seal: win(T.seal - 0.5 * BEAT, T.seal),          // 钤印：提前半拍印影落下，拍点上印定
};

// 声画事件：带 cue 的是画面打点（cuecheck 对整帧、对拍、对音乐起音）；其余是拟音与环境的时间窗
export function buildEvents(scene) {
  const { EV, ev } = createEvents();
  ev(0, 'room', { t1: DUR });
  ev(T.touch, 'touch', { cue: 'touch', pan: scene.pan('s1', 0) });
  for (const k of ['s1', 's2', 's3']) {
    const a = ACT[k];
    ev(a.t0, 'stroke', { id: k, dur: fix(a.t1 - a.t0), pan0: scene.pan(k, 0), pan1: scene.pan(k, 1), wet: k === 's3' ? 1 : 0 });
    ev(a.t1, 'land', { cue: k, pan: scene.pan(k, 1) });
  }
  for (const k of ['w1', 'w2']) {
    const a = ACT[k];
    ev(a.t0, 'stroke', { id: k, dur: fix(a.t1 - a.t0), pan0: scene.pan(k, 0), pan1: scene.pan(k, 1), wet: 0, light: 1 });
  }
  ev(ACT.mist.t0, 'mist', { t1: ACT.mist.t1 });
  if (ACT.breath.t1 > ACT.breath.t0) ev(ACT.breath.t0, 'breath', { t1: ACT.breath.t1 });
  const n = Math.max(1, scene.chars), d = (ACT.title.t1 - ACT.title.t0) / n;
  for (let i = 0; i < n; i++) ev(ACT.title.t0 + i * d, 'write', { dur: fix(d), pan: scene.pan('title', i / n) });
  ev(T.title, 'title', { cue: 'title', pan: scene.pan('title', 1) });
  ev(T.seal, 'seal', { cue: 'seal', pan: scene.pan('seal', 1) });
  return EV;
}

export const TIMELINE = { ...tempo.toJSON(), dur: DUR, cues: CUES, t: T, act: ACT };
