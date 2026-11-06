// 明日早晨 — the single source of time. Picture (film.js), score (score.py), foley (mix.py) and
// cuecheck.py all read these numbers (Python through timeline.json, written by tools/tl.mjs).
// 144 BPM = exactly 10 frames per beat at 24 fps, so every beat is a whole frame (0 ms drift).
export const FPS = 24;
// beat lengths in frames: A print (8) · B three steps (16) · C stop (4) · D accelerando (16) · E ornament (8)
const LEN = [
  ...Array(8).fill(10), ...Array(16).fill(10), ...Array(4).fill(10),
  10, 10, 9, 9, 8, 8, 8, 7, 7, 7, 6, 6, 6, 6, 6, 6,
  ...Array(8).fill(10),
];
export const BEAT_F = []; { let f = 0; for (const l of LEN) { BEAT_F.push(f); f += l; } BEAT_F.push(f); }
export const END_F = 477;                       // 19.875 s
export const DUR = END_F / FPS;
export const SEC = { A: 0, B: 8, C: 24, D: 28, E: 44 };   // first beat index of each section
// time of (possibly fractional) global beat b; fractions interpolate inside that beat
export function bt(b) {
  const i = Math.floor(b + 1e-9), fr = b - i;
  const f0 = BEAT_F[i], f1 = BEAT_F[i + 1] ?? f0 + 10;
  return (f0 + (f1 - f0) * fr) / FPS;
}
export const bf = b => Math.round(bt(b) * FPS);            // frame of beat b
export const beatLen = i => (BEAT_F[i + 1] - BEAT_F[i]) / FPS;
// global beat index at time t (fractional)
export function beatAt(t) {
  const f = t * FPS;
  let i = 0; while (i < BEAT_F.length - 2 && BEAT_F[i + 1] <= f + 1e-6) i++;
  return i + (f - BEAT_F[i]) / (BEAT_F[i + 1] - BEAT_F[i]);
}
// "on twos" stepped time, re-phased at every beat so a pose change lands on the beat frame exactly
export function twosB(t) {
  const i = Math.floor(beatAt(t) + 1e-9), f0 = BEAT_F[i], f = Math.round(t * FPS * 1000) / 1000;
  return (f0 + Math.floor((f - f0) / 2 + 1e-6) * 2) / FPS;
}
// every visual hit: name → global beat (x.6 = the swung off-beat: 60 % of a 10-frame beat = 6 frames, a whole frame)
export const HIT = {
  pen: 0, plateWall: 2, plateFloor: 3, plateCounter: 4, plateMachine: 5, sun: 6, leverUp: 7,
  lever: 8, pop: 10, medal1: 11, knob: 12, pour: 13, call2: 14, medal2: 15,
  hatch: 16, arm: 17, paper: 18, medal3: 19, wide: 20, arrow23: 21, hop: 22, ready: 23,
  stop: 24, ding: 28, freeze: 44, fold: 44.6, petals: 45, lock: 46, ring1: 47, ring2: 48, button: 50,
};
export const D_BEATS = 16;                                  // accelerando cycles start at SEC.D + i
