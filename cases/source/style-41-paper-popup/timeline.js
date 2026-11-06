// 《纸龙》唯一时间源：段落、BPM、拍点、剪切点。画面、配乐、拟音、核对脚本都读这里（mix.py 读导出的 events.json 中的 timeline 字段）。
export const FPS = 60;
export const SECS = [
  { id: 'open',   t: 0.0,  bpm: 100, beats: 4 },   // 书翻开、城堡弹起
  { id: 'castle', t: 2.4,  bpm: 100, beats: 8 },   // 拉片、吊桥、士兵
  { id: 'dragon', t: 7.2,  bpm: 100, beats: 6 },   // 纸龙钻出、盘旋（十六分音符加速）
  { id: 'hush',   t: 10.8, bpm: 100, beats: 2 },   // 静默
  { id: 'night',  t: 12.0, bpm: 100, beats: 8 },   // 翻页入夜、纸烟花（高潮）
  { id: 'close',  t: 16.8, bpm: 80,  beats: 4 },   // 减速：书合上、书脊
];
export const DUR = 19.8;
const S = Object.fromEntries(SECS.map(s => [s.id, s]));
// 段内第 b 拍（可为分数）的绝对时间，取到微秒避免浮点尾巴
export const B = (id, b) => Math.round((S[id].t + b * 60 / S[id].bpm) * 1e6) / 1e6;

// 画面关键事件 → [段, 拍]
export const HIT = {
  creak: ['open', 1], coverUp: ['open', 2], popHills: ['open', 3], popTowers: ['open', 3.5],
  popKeep: ['castle', 0], popWall: ['castle', .5], popFront: ['castle', .75], flags: ['castle', 1],
  tab: ['castle', 2], bridgeLand: ['castle', 4],
  sway1: ['castle', 5], sway2: ['castle', 6], sway3: ['castle', 7],
  rustle: ['dragon', 0], headOut: ['dragon', 1], emerge: ['dragon', 2],
  stop: ['hush', 0], blink: ['hush', 1], grab: ['hush', 1.5],
  turn: ['night', 0], nightHills: ['night', 1.5], leafDown: ['night', 2], nightFront: ['night', 2.25], moon: ['night', 3.5],
  fw1: ['night', 4], fw2: ['night', 5], fw3: ['night', 6], fw4: ['night', 7],
  bw1: ['night', 4.5], bw2: ['night', 5.5], bw3: ['night', 6.5], bw4: ['night', 7.5],
  fold: ['close', 0], dive: ['close', 1], shut: ['close', 2], tailIn: ['close', 3],
};
export const T = Object.fromEntries(Object.entries(HIT).map(([k, [s, b]]) => [k, B(s, b)]));
// 剪切点（新镜头开始）
export const CUTS = [0, B('castle', 0), B('castle', 5), B('dragon', 0), B('hush', 0), B('night', 0), B('night', 4), B('close', 0), B('close', 2)];
