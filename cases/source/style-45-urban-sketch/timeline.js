// 早餐铺开门 — the single time source: tempo map, bar grid, named hits.
// Picture (film.js), score (music/score.py via out/timeline.json), foley (mix.py) and cuecheck all read these numbers.
export const FPS = 24;
// A: 90 BPM 3/4 (beat = 16 frames), bars A1–A6 = 0–12 s · silence 12–13 s · B: 72 BPM 3/4 (beat = 20 frames) from 13 s
export const SECS = [
  { id: 'A', t: 0.0, bpm: 90, meter: 3, bars: 6 },
  { id: 'SIL', t: 12.0, dur: 1.0 },
  { id: 'B', t: 13.0, bpm: 72, meter: 3, bars: 3 },
];
export const DUR = 19.5;
const sec = id => SECS.find(s => s.id === id);
// beat time: section, bar (1-based), beat (1-based, may be fractional: 2.5 = the "and" of 2)
export function bt(id, bar, beat = 1) {
  const s = sec(id), b = 60 / s.bpm;
  return +(s.t + ((bar - 1) * s.meter + (beat - 1)) * b).toFixed(6);
}
export const BEAT = { A: 60 / 90, B: 60 / 72 };

// Named hits: [section, bar, beat]
export const HIT = {
  open:     ['A', 1, 1],    // the pen writes the date in the corner
  eave:     ['A', 1, 2],    // the first eave line, in one breath
  tiles:    ['A', 1, 3],    // tile lines rain down
  wire:     ['A', 2, 1],    // the wire pulled across in one stroke
  pole:     ['A', 2, 2],    // laundry pole
  clothes:  ['A', 2, 3],    // clothes hung
  full:     ['A', 3, 1],    // pull back to the street; band enters; walkers start
  bikeIn:   ['A', 4, 1],    // bicycle enters
  bell1:    ['A', 4, 2],    // first bell
  bell2:    ['A', 4, 3.5],  // second bell (swung off-beat)
  bikeOut:  ['A', 5, 1],
  sky:      ['A', 5, 2],    // sky colour starts to arrive
  wall:     ['A', 6, 1],    // walls ochre
  roof:     ['A', 6, 2],    // roofs grey-violet
  land:     ['A', 6, 3],    // camera lands on the shop; pen writes the sign
  silence:  ['SIL', 0, 0],
  lid:      ['B', 1, 1],    // THE sound: lid pops, steam, first lantern, punch-in
  lantern2: ['B', 1, 2],    // lid lands askew, second lantern
  sign:     ['B', 1, 3],    // sign board turns red
  push:     ['B', 2, 1],    // closest on the sign
  margin:   ['B', 2, 2],    // arrive in the margin, title starts
  title:    ['B', 2, 3],    // title's last stroke; subtitle starts
  end:      ['B', 3, 1],    // final chord
};
export function hitT(name) {
  const [id, bar, beat] = HIT[name];
  if (id === 'SIL') return sec('SIL').t;
  return bt(id, bar, beat);
}
export const H = Object.fromEntries(Object.keys(HIT).map(k => [k, hitT(k)]));
// every beat of the film (for footsteps and the grid check)
export function beats() {
  const out = [];
  for (const s of SECS) if (s.bpm) for (let bar = 1; bar <= s.bars; bar++) for (let b = 1; b <= s.meter; b++) out.push({ sec: s.id, bar, beat: b, t: bt(s.id, bar, b) });
  return out;
}
