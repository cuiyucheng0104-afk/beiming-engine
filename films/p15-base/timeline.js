// 《概念样片》唯一时间源：节拍表、画面打点、声画事件。页面（film.js）、mix.py、cuecheck 读的都是这里的数字。
// 120 BPM、4/4：一拍 0.5 秒 = 24 fps 下 12 帧，每个打点都落在整帧上。改节奏只改 SECS 与 CUES。
import { createTempo, createEvents } from '../../engine/core/tempo.js';

export const FPS = 24;
export const DUR = 3;                       // 72 帧

export const SECS = [{ id: 'A', t0: 0, bpm: 120, meter: 4 }];
const tempo = createTempo(SECS, { fps: FPS });

// 画面打点：[段落, 小节, 拍, 拍内分数]
export const CUES = {
  s1: ['A', 1, 2],      // 第一笔
  s2: ['A', 1, 3],      // 第二笔
  s3: ['A', 1, 4],      // 第三笔
  title: ['A', 2, 1],   // 片名落定
  seal: ['A', 2, 2],    // 钤印
};
export const T = tempo.cues(CUES);
export const BEAT = tempo.beat('A');

// 声画事件：带 cue 的是画面打点（cuecheck 会对整帧、对拍、对音乐起音）
const { EV, ev } = createEvents();
['s1', 's2', 's3'].forEach((k, i) => ev(T[k], 'stroke', { cue: k, dur: 0.4, pan: -0.5 + i * 0.5 }));
ev(T.title, 'title', { cue: 'title', dur: 0.6 });
ev(T.seal, 'seal', { cue: 'seal', pan: 0.35 });
ev(0, 'room', { t1: DUR });
export { EV };

// 给 engine/render/events.mjs 写 timeline.json
export const TIMELINE = { ...tempo.toJSON(), dur: DUR, cues: CUES, t: T };
