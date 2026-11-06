// 博物志·鹦鹉螺 — the single source of time. Everything (picture, score, foley, checks) reads these numbers.
// 90 BPM at 24 fps: one beat = 2/3 s = exactly 16 frames, an eighth = 8, a sixteenth = 4, a thirty-second = 2.
export const BPM = 90, SPB = 60 / BPM, FPS = 24;
export const T = b => b * SPB;                 // beat → seconds
export const BEATS = 30;                       // 7 bars of 4/4 + 2 beats of held final plate
export const DUR = BEATS * SPB;                // 20.000 s = 480 frames

// every cue in beats (b0 = first frame)
export const C = {
  // first pass: the outline, cut in runs (run A is already two thirds cut on frame 0)
  runA: [-4.5, 1.5], runB: [2, 2.75], runC: [3, 3.75], runD: [4, 4.75], runE: [5, 5.75],
  pullout: [3, 6],
  // second and third passes
  h1: [6, 9], h2: [9, 11.5], h3: [10.5, 11.5],
  // magnification roundel
  ring: [12, 12.75], burnish: [12.5, 13], flight: [13, 15], ground: [12.5, 13], land: 15,
  wall: [15, 16],
  septa: [16, 16.5, 17, 17.5, 17.75, 18, 18.25, 18.5, 18.625, 18.75, 18.875, 19, 19.125, 19.25, 19.375, 19.5],
  lab1: { zh: 16, zhStep: 0.25, la: 16.5, laStep: 0.125 },     // 气室 / camerae
  lab2: { zh: 17.75, zhStep: 0.25, la: 18.25, laStep: 0.125 }, // 体管 / siphunculus
  stop: 19.5,                                   // last septum: everything stops
  clock: 20,                                    // the one small sound inside the silence
  first: 21,                                    // first sound after the silence: drop + bowed cello + red line
  red: [21, 23],
  chambers: { t0: 22, step: 0.25 },             // one wash per chamber, on sixteenths (all dry by b27)
  pullback: [23, 24.5],
  shellWash: 24,
  stripes: { t0: 24.5, step: 0.25, n: 9 },
  latin: { t0: 24.5, step: 0.0625 },            // italic name, cut glyph by glyph (one frame per glyph)
  title: { t0: 25, step: 0.25 },                // 鹦鹉螺
  plate: { t0: 25.75, step: 0.125 },            // Pl. III (done by b26.4; the finished plate holds b27–b30)
  cadence: 27,
};
export const LABELS = {
  lab1: { zh: '气室', la: 'camerae' },
  lab2: { zh: '体管', la: 'siphunculus' },
  title: '鹦鹉螺', latin: 'Nautilus pompilius L.', plate: 'Pl. III',
};
