// 渔夫还珠 — the single source of time. Every cut, action, light and sound reads from here.
// Beat lengths are whole frames at 24 fps: 80 BPM = 0.75 s = 18 frames, 160 BPM = 0.375 s = 9 frames,
// so every beat lands exactly on a frame (0 ms quantisation error).
export const FPS = 24;
export const SECS = [
  { id: 'A', t: 0.0,   bpm: 80,  beats: 10 },   // 慢板: lamps, rowing, net, pearl
  { id: 'B', t: 7.5,   bpm: 160, beats: 10 },   // 急急风: waves, dragon, off the screen
  { id: 'S', t: 11.25, bpm: 160, beats: 4 },    // gong, then silence
  { id: 'D', t: 12.75, bpm: 80,  beats: 7 },    // 慢板 (ku-yin): return, rain, bow, lamps out
];
export const DUR = 18.0;
export const at = (id, b) => { const s = SECS.find(x => x.id === id); return +(s.t + b * 60 / s.bpm).toFixed(4); };

// Hit points: name → [section, beat]. The picture and the score both read these.
export const HIT = {
  lamp1: ['A', 0], lamp2: ['A', 1], lamp3: ['A', 2],
  oar1: ['A', 1], oar2: ['A', 2], oar3: ['A', 3], oar4: ['A', 4], oar5: ['A', 5],
  titleIn: ['A', 3], titleSet: ['A', 3.5],
  oarDown: ['A', 5.5], netUp: ['A', 6], cast: ['A', 7], titleOut: ['A', 7],
  splash: ['A', 8], pearl: ['A', 9], steal2: ['A', 9.5],
  surge: ['B', 0], breach: ['B', 2], liang: ['B', 4], offscreen: ['B', 5], crash: ['B', 9],
  gong: ['S', 0], silence: ['S', 1], sizzle: ['S', 2],
  ting: ['D', 0], handover: ['D', 1], jaw: ['D', 1.5], swap: ['D', 2], bow: ['D', 3],
  snuff3: ['D', 4], snuff2: ['D', 5], clap: ['D', 6], gutter: ['D', 6.5],
};
export const T = Object.fromEntries(Object.entries(HIT).map(([k, [s, b]]) => [k, at(s, b)]));
export const timelineJSON = () => ({ fps: FPS, dur: DUR, secs: SECS, hit: HIT, t: T });
