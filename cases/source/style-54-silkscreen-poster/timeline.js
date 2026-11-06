// timeline.js — the single source of time for picture, score, foley and checks.
// 120 BPM, 4/4: one beat = 0.5 s = exactly 12 frames at 24 fps, so every beat, eighth and sixteenth lands on a frame (0 ms grid error).
export const BPM = 120, B = 60 / BPM, FPS = 24;
export const bt = b => +(b * B).toFixed(6);          // beat index → seconds
export const DUR = bt(38.5);                         // 19.25 s

// Poster pulls: id, ink, direction, region (poster units), start beat, landing beat (landing = the hit)
export const PULLS = [
  { id: 'sky',    ink: 'sky',    dir: 'down',  reg: 'full',  b0: 4,    b1: 6 },
  { id: 'sea',    ink: 'sea',    dir: 'down',  reg: 'full',  b0: 8,    b1: 9 },
  { id: 'sand',   ink: 'sand',   dir: 'down',  reg: 'full',  b0: 10,   b1: 11 },
  { id: 'red',    ink: 'red',    dir: 'down',  reg: 'full',  b0: 11.5, b1: 12 },
  { id: 'lamp',   ink: 'accent', dir: 'down',  reg: 'full',  b0: 12,   b1: 12.5 },
  { id: 'near',   ink: 'near',   dir: 'down',  reg: 'full',  b0: 12.5, b1: 13 },
  { id: 'sunset', ink: 'split',  dir: 'right', reg: 'sky',   b0: 22,   b1: 26 },
  { id: 'sun',    ink: 'accent', dir: 'down',  reg: 'sky',   b0: 26,   b1: 26.5 },
  { id: 'band',   ink: 'near',   dir: 'down',  reg: 'band',  b0: 26.5, b1: 27 },
  { id: 'title',  ink: 'accent', dir: 'down',  reg: 'title', b0: 27.5, b1: 28 },
];
// Info items stamped left to right on half beats (landing beat)
export const ITEMS = [
  { id: 'rule', b: 29 }, { id: 'ferry', b: 29.5 }, { id: 'height', b: 30 }, { id: 'sunset', b: 30.5 },
];
// Other cues (beats)
export const CUE = {
  open: 0,          // spring-reverb guitar "drip" on the bare mesh
  blade: 2,         // squeegee set down on the screen
  pour: 3,          // ink poured: wet squelch
  groove: 4,        // band groove starts with the first pull
  lift: 14,         // screen lifts, layers come loose
  loose: 14.5,      // layers start drifting (paper slides)
  silence: 16,      // music drops out (near-silence, sea only)
  slide: 18,        // inside the silence the top (near-ink) layer slips once: a soft paper brush
  drop: 19.75,      // screen falls back
  snap: 20,         // registration clamp: the most important sound
  rest: 28.5,       // squeegee laid down on the bench
  final: 32,        // screen lifts, fast pull-back
  last: 34,         // last low note
};

// Event list for the mixer and the cue check (all times from beats)
export function events() {
  const ev = [{ t: 0, type: 'grid', bpm: BPM, beat: B, fps: FPS, dur: DUR }];
  for (const p of PULLS) ev.push({ t: bt(p.b0), type: 'pull', id: p.id, ink: p.ink, dir: p.dir, dur: bt(p.b1) - bt(p.b0) }, { t: bt(p.b1), type: 'land', id: p.id });
  for (const it of ITEMS) ev.push({ t: bt(it.b), type: 'item', id: it.id, k: ITEMS.indexOf(it) });
  for (const [k, b] of Object.entries(CUE)) ev.push({ t: bt(b), type: k });
  ev.sort((a, b) => a.t - b.t);
  return ev;
}
