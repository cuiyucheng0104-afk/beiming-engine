// 雪夜小站 — the one time source. 60 BPM, 5/4 (3+2), one bar = 5 s: every story section is one bar.
// Every time below is written in beats (b) and turned into seconds by B(); the picture (scene.js), the score and
// foley (mix.py, via events.json + timeline.json) and the cue check (tools/cuecheck.py) all read these numbers.
export const BPM = 60, METER = 5;
export const B = (beat) => beat * 60 / BPM;                  // beat number (from 0) → seconds (exact: triplets land on 30 fps frames)
export const BAR = (bar, beat = 0) => B(bar * METER + beat); // bar index (from 0), beat inside the bar

export const T = {
  DUR: B(19.9),                       // the bar runs to 20 s; the plate holds 1.9 s after the press (STYLE §4: ≥ 1.8 s)
  // bar 0 — the rails: the camera passes one telegraph pole on every beat
  poles: [1, 2, 3, 4, 5, 6, 7].map(B),   // beats 5–7: the poles keep the quarter pulse while the steam doubles it
  bellFar: B(0),
  // bar 1 — the steam: the engine exhales faster and faster, then the whiteout
  chuffs: [5, 6, 6.5, 7, 7 + 1 / 3, 7 + 2 / 3, 7 + 5 / 6].map(B),   // quarter → eighth → triplet → sextuplet (all on 30 fps frames)
  whiteIn: B(7.8), whitePeak: B(8), whiteOut: B(8.2),
  creak: B(8.5),
  arrive: B(10),                       // the camera has decelerated to the window
  // bar 2 — one red waking
  wick: B(10),                         // a single red point (first melodic note)
  body: B(11), bodyEnd: B(11.5),       // the lantern prints row by row
  done: B(12),                         // tassel, cap and the paper ring register
  silence: [B(13), B(15)],             // locked frame, near silence
  // bar 3 — the rise and the plate of type in the sky
  bell: B(15),                         // the first sound after the silence: the great bell; the camera rises
  block: B(16),                        // an ink block lands in the sky
  knives: [16.5, 17, 17 + 1 / 3, 17 + 2 / 3, 17 + 5 / 6].map(B),   // the five strokes of 归, accelerating into the press
  press: B(18),                        // the plate is pressed; the chord resolves
  hold: B(17),                         // the camera has eased into its hold (reading time starts)
};
// every cue the score and the picture must share: [name, beat]
export const CUES = [
  ['bellFar', 0], ...[1, 2, 3, 4, 5, 6, 7].map(b => ['pole', b]),
  ...[5, 6, 6.5, 7, 7 + 1 / 3, 7 + 2 / 3, 7 + 5 / 6].map(b => ['chuff', b]),
  ['whitePeak', 8], ['creak', 8.5], ['wick', 10], ['body', 11], ['done', 12], ['silence', 13], ['bell', 15],
  ['block', 16], ...[16.5, 17, 17 + 1 / 3, 17 + 2 / 3, 17 + 5 / 6].map(b => ['knife', b]), ['press', 18],
];
