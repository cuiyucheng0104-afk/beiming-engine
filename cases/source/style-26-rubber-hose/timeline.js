// timeline.js — the single source of time: tempo sections, beat grid, hit points, shots.
// No imports, so node can read it too (build.sh exports timeline.json for the score, the mix and cuecheck).
// Every beat is an even number of frames at 24 fps: 144 BPM = 10 frames, 180 BPM = 8 frames.
export const FPS = 24;
export const SECS = [
  { id: 'A', bpm: 144, beats: 8 },   // breathe: countdown to 7:00
  { id: 'B', bpm: 144, beats: 12 },  // ring: curtain, blanket
  { id: 'C', bpm: 180, beats: 12 },  // bugle: accelerate
  { id: 'D', bpm: 180, beats: 2 },   // band stop: silence, freeze
  { id: 'E', bpm: 144, beats: 4 },   // slap + tuba, near silence
  { id: 'F', bpm: 144, beats: 6 },   // boing back, bow, grab the iris
  { id: 'G', bpm: 144, beats: 6 },   // end roundel
];
{ let t = 0; for (const s of SECS) { s.t0 = t; s.beat = 60 / s.bpm; s.t1 = t + s.beats * s.beat; t = s.t1; } }
export const DUR = SECS[SECS.length - 1].t1;
const SEC = Object.fromEntries(SECS.map(s => [s.id, s]));
// time of beat b (0-based, fractional allowed) in section id
export const T = (id, b = 0) => SEC[id].t0 + b * SEC[id].beat;
export const secAt = t => SECS.find(s => t < s.t1) || SECS[SECS.length - 1];
// continuous beat count since the start (used for breathing)
export function beatsAt(t) {
  let n = 0;
  for (const s of SECS) { if (t >= s.t1) { n += s.beats; continue; } return n + Math.max(0, t - s.t0) / s.beat; }
  return n;
}
export const snapF = t => Math.round(t * FPS) / FPS;

// Hit points: [section, beat]. Every key action, cut and text landing sits on one of these.
export const HIT = {
  irisOpen: ['A', 0], tick0: ['A', 0],
  pullStart: ['A', 1], pullEnd: ['A', 7],
  ring: ['B', 0], reach1: ['B', 1], grabCurtain: ['B', 3], curtainOpen: ['B', 4], retract1: ['B', 5],
  cutBed: ['B', 6], pillow: ['B', 6], reach2: ['B', 7], yank: ['B', 8], shiver: ['B', 9],
  trumpet: ['C', 0], inhale: ['C', 1], blast: ['C', 2], ch1: ['C', 2], ch2: ['C', 3], ch3: ['C', 4],
  danceMax: ['C', 8], handRise: ['C', 10], handTop: ['C', 11],
  stop: ['D', 0],
  slap: ['E', 0], snore: ['E', 1], feebleTick: ['E', 2], peel: ['E', 3],
  boing: ['F', 0], wobble: ['F', 1], bow: ['F', 3], reachIris: ['F', 4.5], grabIris: ['F', 5],   // the bow holds 1.5 beats, then a fast half-beat reach
  irisShut: ['G', 0], hop1: ['G', 1], hop2: ['G', 2], hop3: ['G', 3], wink: ['G', 4], hatPop: ['G', 5],
};
export const H = Object.fromEntries(Object.entries(HIT).map(([k, [s, b]]) => [k, T(s, b)]));

// Shots: [t0, id]. Cuts happen only on hits.
export const SHOTS = [
  [0, 'open'],              // iris on the clock face, pull back to the bedroom
  [H.ring, 'ring'],         // medium on the clock, truck left with the arm
  [H.cutBed, 'bed'],        // the bed: pillow, blanket
  [H.trumpet, 'bugle'],     // two-shot, push in
  [H.slap, 'slap'],         // high close on the nightstand
  [H.boing, 'boing'],       // tilt up with the bounce, bow, iris
];
export const shotAt = t => { let s = SHOTS[0]; for (const x of SHOTS) if (t >= x[0] - 1e-6) s = x; return s; };

export const EXPORT = { fps: FPS, dur: DUR, secs: SECS, hit: HIT, h: H, shots: SHOTS };
