// The one time source for picture, score, foley and checks. 120 BPM, 4/4, C major.
// b(bar, beat, n16) → seconds: bar and beat are 1-based, n16 = extra sixteenths.
export const BPM = 120, BEAT = 60 / BPM, BAR = 4 * BEAT, S16 = BEAT / 4, FPS = 24;
export const b = (bar, beat = 1, n16 = 0) => (bar - 1) * BAR + (beat - 1) * BEAT + n16 * S16;
export const DUR = b(10, 4, 3);                       // 19.875: the full board holds 1.0 s (24 frames)

export const SEC = [                                    // sections (music states)
  { id: 'question', t0: 0, t1: b(2, 4), chords: [[b(1), 'C'], [b(2), 'Am']] },
  { id: 'light', t0: b(2, 4), t1: b(5), chords: [[b(3), 'F'], [b(4), 'G']] },
  { id: 'scatter', t0: b(5), t1: b(7), chords: [[b(5), 'C'], [b(6), 'Am'], [b(6, 3), 'F']] },
  { id: 'rewind', t0: b(7), t1: b(7, 3) },
  { id: 'answer', t0: b(7, 3), t1: b(9, 3), chords: [[b(7, 3), 'F'], [b(8), 'C'], [b(8, 3), 'Am'], [b(9), 'F'], [b(9, 3), 'G']] },
  { id: 'silence', t0: b(9, 3), t1: b(10) },
  { id: 'slap', t0: b(10), t1: DUR, chords: [[b(10), 'C']] },
];

// writing windows [start, land]; `land` is where the glyph group must be finished (a strong beat for keywords)
export const W = {
  tian: [b(1), b(1, 3)],                  // 天 lands 1.0
  weishenmeshi: [b(1, 3), b(2)],          // 为什么是 lands 2.0
  lan: [b(2), b(2, 3)],                   // 蓝 lands 3.0
  deq: [b(2, 3), b(2, 4)],                // 的？ lands 3.5
  sun: [b(2, 4, 1), b(3)],                // sun circle lands 4.0
  rays: [b(3), b(3, 2)],                  // 8 rays, 4.0–4.5
  arrow: [b(3, 2), b(3, 3)],              // hollow white-light arrow lands 5.0
  baiguang: [b(3, 3), b(4)],              // 白光 lands 6.0
  waves: [0, 1, 2, 3, 4, 5, 6].map(k => [b(4) + k * 2 * S16, b(4) + k * 2 * S16 + 5 / FPS]),   // one wave per 8th, red → violet
  dots: [0, 1, 2, 3, 4, 5, 6, 7].map(k => b(5) + k * S16),                                    // molecule taps on 16ths
  kongqi: [b(5, 3), b(6)],                // 空气分子 lands 10.0
  red: [b(6), b(6, 3)],                   // red arrow straight through, lands 11.0
  bounce: [b(6), b(6, 2), b(6, 3), b(6, 3, 2), b(6, 4), b(6, 4, 1), b(6, 4, 2), b(6, 4, 3), b(7)],   // blue zig-zag: 8ths then 16ths
  spray: [0, 1, 2, 3, 4, 5, 6, 7].map(k => b(6, 3) + k * S16),                                     // second blue pen: 16ths 11.0–11.875
  erase: [b(7), b(7, 3)],                 // rewind 12.0–13.0: blue un-draws in reverse at 2×, eraser on the trail
  whip: [b(7, 2, 3), b(7, 3)],            // whip to the answer patch 12.875–13.0 (lands on the F strum)
  lanGuang: [b(7, 3), b(8)],              // 蓝光 lands 14.0
  boChangDuan: [b(8), b(8, 3)],           // 波长短， lands 15.0
  zuiRongYiBei: [b(8), b(9)],             // 最容易被 (second black pen, overlapping) lands 16.0
  sanShe: [b(9), b(9, 3)],                // 散射 lands 17.0
  circle: [b(9) + 2 * S16, b(9, 3)],      // blue pen circles 蓝 twice, lands 17.0 with 散射
  capOn: b(9, 3, 1),                      // 17.125 cap clicks on
  magnetIn: b(9, 3, 1),                   // magnet floats in during the silence
  slap: b(10),                            // 18.0 — the most important sound
  full: b(10, 2, 3),                      // 18.875 full-board view lands, then holds 1.0 s (24 frames)
};
// keyword landings checked against the score (name → time)
export const KEY = {
  '天': W.tian[1], '蓝(题)': W.lan[1], '？': W.deq[1], '太阳': W.sun[1], '白光箭头': W.arrow[1], '白光': W.baiguang[1],
  '空气分子': W.kongqi[1], '红箭头': W.red[1], '蓝光': W.lanGuang[1], '波长短': W.boChangDuan[1], '最容易被': W.zuiRongYiBei[1],
  '散射': W.sanShe[1], '圈蓝': W.circle[1], '磁贴': W.slap, '全板': W.full,
};
export const TL = { BPM, BEAT, BAR, S16, FPS, DUR, SEC, W, KEY };
