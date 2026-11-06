// 《后退的冰川》 single source of time. 80 BPM, 4/4: one beat = 0.75 s, one bar = 3.0 s.
// Every cue is written in beats; tools/export.mjs writes timeline.json for mix.py and the checks.
export const BPM = 80;
export const BEAT = 60 / BPM;
const b = n => +(n * BEAT).toFixed(4);

export const B = {          // cue -> beat
  scanIn: 0,     // black frame painted in by a scan
  dive0: 1,      // dive starts
  lock: 3,       // reticle snaps onto the glacier
  mapOn: 4,      // printed map starts printing (bar 2)
  mapName: 5,    // the map's name lands
  tear: 6,       // scanner bar tears the map away
  y1986: 7,      // first ring (the photograph under the map)
  y2005: 9,
  y2010: 10,
  y2015: 10.5,
  y2020: 11,
  y2026: 12,     // last ring brakes (bar 4)
  markA: 12.5,   // bracket on the 1986 front
  range0: 14,    // range line starts growing
  rangeEnd: 17,  // reading lands
  sil0: 18,      // near-silence
  turn: 20,      // colour returns (bar 6): the first sound after the silence
  frame: 21.5,   // reticle brackets close into the frame
  title: 22,     // title card fully in
  coda: 24,      // last low hit, the lock ping answered
  dur: 26,
};
export const T = Object.fromEntries(Object.entries(B).map(([k, v]) => [k, b(v)]));

// rings: year, landing time, scan sweep (spacing tells the speed: 1.5, .75, .375, .375, .75 s)
export const RINGS = [
  { year: 1986, t: T.y1986, sweep: 0.0 },
  { year: 2005, t: T.y2005, sweep: 0.62 },
  { year: 2010, t: T.y2010, sweep: 0.5 },
  { year: 2015, t: T.y2015, sweep: 0.3 },
  { year: 2020, t: T.y2020, sweep: 0.3 },
  { year: 2026, t: T.y2026, sweep: 0.55 },
];
