// The single source of time for picture, score, foley and checks.
// Tempo map: every beat is a whole number of frames at 24 fps (90 BPM = 16 frames, 120 BPM = 12 frames),
// so every visual hit can land on its music cue with 0 ms error.
export const FPS = 24;
export const DUR = 475 / 24;   // 19.79 s, a whole number of frames

export const SECS = [
  { id: 'A', t0: 0, t1: 4, bpm: 90, meter: 3, key: 'C', mood: 'lullaby' },        // drawing the boat (2 bars of 3/4)
  { id: 'B', t0: 4, t1: 9, bpm: 120, meter: 4, key: 'Am', mood: 'storm' },        // rain: faster, minor (2 bars + a 2/4 bar)
  { id: 'S', t0: 9, t1: 10, bpm: 90, meter: 3, key: '-', mood: 'silence' },       // near-silence (fermata)
  { id: 'C', t0: 10, t1: DUR, bpm: 90, meter: 3, key: 'C', mood: 'sun' },         // sun, coloured drops, rainbow, page turn
];
const SEC = Object.fromEntries(SECS.map(s => [s.id, s]));
export const beatLen = id => 60 / SEC[id].bpm;
// bar and beat are 1-based; frac is a fraction of a beat (0.5 = the "and")
export function at(id, bar, beat = 1, frac = 0) {
  const s = SEC[id]; return +(s.t0 + ((bar - 1) * s.meter + (beat - 1) + frac) * 60 / s.bpm).toFixed(6);
}

// Visual hits. Each one is a [section, bar, beat, frac] address on the music grid.
// The score (mix.py) places its notes from the same addresses; cuecheck.py compares both.
const A = (...a) => ['A', ...a], B = (...a) => ['B', ...a], S = (...a) => ['S', ...a], C = (...a) => ['C', ...a];
export const CUES = {
  hull: A(1, 1), sail: A(1, 2), flag: A(1, 3),
  eyes: A(2, 1),
  pud0: A(2, 1), pud1: A(2, 1, .5), pud2: A(2, 2), pud3: A(2, 2, .5),
  ripple: A(2, 3),
  cloud0: B(1, 1), cloud1: B(1, 2), cloud2: B(1, 3), frown: B(1, 4),
  wash: B(2, 1),
  drop0: B(2, 2), drop1: B(2, 2, .5), drop2: B(2, 3), drop3: B(2, 3, .5), drop4: B(2, 4), drop5: B(2, 4, .5),
  rock0: B(2, 2), rock1: B(2, 3), rock2: B(2, 4), sink: B(3, 1), rock3: B(3, 2),
  silence: S(1, 1), drip: S(1, 1, .5), lookup: S(1, 2),
  sun: C(1, 1),
  sw0: C(1, 1, .5), sw1: C(1, 2), sw2: C(1, 2, .5),
  sunface: C(1, 3), ray: C(1, 3, .5),
  pull: C(2, 1),
  col0: C(2, 1), col1: C(2, 1, .5), col2: C(2, 2), col3: C(2, 2, .5), col4: C(2, 3), col5: C(2, 3, .5),
  band0: C(3, 1), band1: C(3, 1, .5), band2: C(3, 2), band3: C(3, 2, .5), band4: C(3, 3), band5: C(3, 3, .5),
  sailaway: C(3, 1), under: C(4, 1),
  lift: C(4, 3), land: C(5, 1), wan: C(5, 2),
};
export const T = Object.fromEntries(Object.entries(CUES).map(([k, a]) => [k, at(...a)]));
