// 一伞三景 — the single source of time. 80 BPM, one beat = 0.75 s = 18 frames at 24 fps.
export const BPM = 80, BEAT = 60 / BPM, FPS = 24;
export const b = n => Math.round(n * BEAT * 1e6) / 1e6;
export const DUR = 19.75;

// key beats (beat numbers); every visual hit below lands exactly on b(n)
export const BEATS = {
  key: 1, sky: 2, water: 3, wood: 4, red: 5,          // printing, block by block
  gust: 6, tug: 7, tear: 8, breakout: 10,               // the wind; the umbrella leaves the print
  v1: 11, v1cart: 10.5, bounce: 12,                      // view 1 檐雨
  s2a: 12.75, v2: 13.5, v2cart: 13.25, splash: 14.5,             // view 2 浪尖
  s3a: 15.5, v3: 16, v3cart: 16, v3seal: 16.5,        // view 3 远岳初晴
  apex: 18, ma: 18, maEnd: 20,                           // ma: silence
  shaku: 20, reach: 21, catch: 22, pullA: 22.5, pullB: 23.75, clear: 24, seal: 25,
};
export const T = Object.fromEntries(Object.entries(BEATS).map(([k, n]) => [k, b(n)]));
export const REVEAL = 0.3;          // a colour block sweeps in over 0.3 s and lands on its beat
export const KEY_REVEAL = 0.75;     // the first (key) block takes the whole first beat
// the five blocks of the opening print, in printing order
export const PRINT = [['key', T.key], ['sky', T.sky], ['water', T.water], ['wood', T.wood], ['red', T.red]];
// hyoshigi clappers that accelerate from the tear to the breakout (beats)
export const CLAP = [8.5, 9, 9.333333, 9.583333, 9.75, 9.875, 9.9375];
// taiko roll that accelerates through the gust (beats)
export const ROLL = [6, 6.5, 7, 7.333333, 7.583333, 7.75, 7.875, 7.9375];
