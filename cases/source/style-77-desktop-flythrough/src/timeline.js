// 灵感送达 — the one clock. 112.5 BPM: a beat = 0.5333 s = 16 frames at 30 fps, a 16th = 4 frames, a bar = 2.1333 s.
// Picture (film.js, shots.js), score (audio/compose.py), foley (audio/foley.py) and the check (tools/cuecheck.py) all read these numbers.
// Pure module (no imports): the page imports it, and node dumps it to out/timeline.json for the Python side.
export const BPM = 112.5, FPS = 30;
export const BEAT = 60 / BPM, BAR = 4 * BEAT, S16 = BEAT / 4;
export const b = n => +(n * BEAT).toFixed(6);              // beat n (fractions on the 16th grid: .25, .5, .75)
export const NBEATS = 37;
export const DUR = b(NBEATS);                                // 19.7333 s, 592 frames

// chords, one per bar (C major); notes are MIDI
export const CHORDS = [
  { bar: 0, name: 'Fmaj7', notes: [53, 57, 60, 64], root: 41 },
  { bar: 1, name: 'Em7', notes: [52, 55, 59, 62], root: 40 },
  { bar: 2, name: 'Dm9', notes: [50, 53, 57, 60, 64], root: 38 },
  { bar: 3, name: 'G7sus', notes: [55, 60, 62, 65], root: 43 },
  { bar: 4, name: 'Fmaj7', notes: [53, 57, 60, 64], root: 41 },
  { bar: 5, name: 'Am7', notes: [57, 60, 64, 67], root: 45 },
  { bar: 6, name: 'Fmaj9', notes: [53, 57, 60, 64, 67], root: 41 },
  { bar: 7, name: 'G6', notes: [55, 59, 62, 64], root: 43 },
  { bar: 8, name: 'Cmaj9', notes: [48, 55, 59, 62, 64], root: 36 },
  { bar: 9, name: 'Cmaj9', notes: [48, 55, 59, 62, 64], root: 36 },
];

// every hit point: [id, beat]. The picture, the score and the foley all land on these.
export const HIT = {
  lampOn: 1,                 // the desk lamp clicks on
  noteLand: 4,               // the camera settles over the sticky note (bar 1)
  bulbPop: 6,                // sticker pop: the pixel bulb stands up
  qFlash: 8,                 // the "？" flashes (bar 2)
  hop1: [11, 12],            // take-off (whip starts) → landing as the drawer stops open (bar 3)
  drawerOpen: [11.5, 12],    // the drawer slides out, lands on the downbeat
  musicGap: 11.5,            // half a beat of air before the drawer
  hop2: [12.25, 13],
  hop3: [13.25, 14],         // into the drawer city
  bulbLight: 16,             // the bulb lights up (bar 4) and the city's windows follow, one per 16th
  windows: [16, 19.75],
  hop4: [19, 19.75],         // the bulb hops onto the printed paper plane
  planePop: 20,              // the plane pops up from the print (bar 5) with the bulb aboard
  silence: [21, 24],         // near silence: only the vinyl and one paper creak
  creak: 22,
  launch: 24,                // the first sound after the silence: the launch (bar 6)
  roll: [28, 29],            // barrel roll over the mug (bar 7)
  tap1: 30, tap2: 30.5,      // the plane taps the notebook twice
  hop5: [30.75, 31.5],       // the bulb hops off
  stampUp: [31, 31.75],      // the stamp leaps from its pad
  slam: 32,                  // the stamp slams: 已送达 (bar 8)
  stampBack: [32.5, 33],
  titleDrop: [33.5, 34],    // the title card falls onto the open middle of the desk and lands on beat 34, then holds still to the end (1.6 s)
  cc: [34.5, 35, 35.5, 36, 36.25],   // curtain call after the title: note, drawer, lamp, notebook (one 8th apart), the bulb a 16th after its notebook
};
export const T = Object.fromEntries(Object.entries(HIT).map(([k, v]) => [k, Array.isArray(v) ? v.map(b) : b(v)]));
