// 鲤鱼跃龙门 — the single source of time. Every visual event, every music cue and every foley hit reads these numbers.
// 13 frames per beat at 24 fps → 110.77 BPM; every beat lands on a whole frame.
export const FPS = 24;
export const B = 13 / 24;                 // one beat (s)
export const BPM = 60 / B;                // 110.769…
export const BEATS = 36;                  // 9 bars of 4/4
export const DUR = BEATS * B;             // 19.5 s
export const b = x => x * B;              // beat → seconds

// sections (bar grid)
export const SECS = [
  { id: 'fold',    b0: 0,  b1: 4 },
  { id: 'cut',     b0: 4,  b1: 12 },
  { id: 'unfold',  b0: 12, b1: 16 },
  { id: 'climb',   b0: 16, b1: 25 },
  { id: 'silence', b0: 25, b1: 28 },
  { id: 'dragon',  b0: 28, b1: 36 },
];

// ----- hits, in beats -----
export const HB = {
  land: 1,                 // red sheet lands on the table
  foldStart: 2, fold: 3,   // fold swings over, presses flat on b3
  scissorsIn: 4,
  snips: [5, 6, 7, 8, 8.5, 9, 9.5, 10, 10.25, 10.5, 10.75, 11],   // 3 quarters → 5 eighths → 4 sixteenths
  offcut: 11,              // waste ring drops, scissors leave
  flapLift: 11.5, unfold: 12,
  lift: 15.5, peel: 16, settle: 17,
  gateUp: 18,              // the gate stands up from the far bank
  plaque: 20,              // 龙门 lights
  copies: [17, 18, 19, 20, 20.5, 21, 21.5, 22, 22.25, 22.5, 22.75, 23, 23.25, 23.5],   // 4 quarters → 4 eighths → 6 sixteenths
  launch: 24, apex: 25,    // silence b25 → b28
  burst: 28, unfold2: 28.5, unfold3: 29,
  fuIn: 29.5, fuFold: 30,
  fuSnips: [30.5, 30.75, 31, 31.25],
  fuFlap: 31.5, fuLand: 32,
  end: 36,
};
// same hits in seconds, quantised to the nearest frame (beats are already whole frames; eighths/sixteenths move ≤ 1/48 s).
// Picture, foley and the cue notes of the score all use these quantised times, so they coincide exactly.
export const qf = t => Math.round(t * FPS) / FPS;
export const H = Object.fromEntries(Object.entries(HB).map(([k, v]) => [k, Array.isArray(v) ? v.map(x => qf(b(x))) : qf(b(v))]));
export const SILENCE = [b(25), b(28)];
