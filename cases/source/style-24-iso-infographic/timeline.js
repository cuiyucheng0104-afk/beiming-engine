// 一封信的旅程 — the single source of time. Picture (film.js), score + foley (mix.py via events.json) and cuecheck.py all read this.
// 120 BPM, 4/4. At 24 fps one beat = exactly 12 frames, a sixteenth = 3 frames, so every cue lands on a whole frame.
export const BPM = 120, BEAT = 60 / BPM, BAR = 4 * BEAT, FPS = 24;
// b(bar, beat, sixteenth) → seconds. bar and beat are 1-based.
export const b = (bar, beat = 1, s16 = 0) => ((bar - 1) * 4 + (beat - 1)) * BEAT + s16 * BEAT / 4;
export const DUR = b(10, 4, 2);                    // 19.75 s (bar 10 beat 4, third sixteenth)

export const T = {
  OPEN: b(1, 1),
  DROP0: b(1, 2),        // envelope starts sliding into the slot
  SLOT: b(1, 3),         // in: metal flap
  MBLINE: b(1, 3),       // mailbox cut line 1.00–1.25
  MBSKIN: b(1, 3, 1),    // skin slides 1.25–1.60
  PILE: b(1, 4),         // lands on the letter pile
  HOP1: b(2, 1),         // lands outside
  HOP2: b(2, 2),
  POIN: b(2, 3),         // onto the belt; post office wall slides away
  BELT: b(2, 4),
  STAMP: b(3, 1),        // departure postmark
  FLIP: b(3, 2),         // sorter flipper
  TRUCKIN: b(3, 3),      // drops into the sack in the truck
  TRUCKGO: b(3, 4),
  TRUCKARR: b(4, 3),
  HOLD: b(4, 4),         // sack lands in the cargo hold
  ROLL: b(5, 1),
  LIFT: b(5, 2),
  TOUCH: b(6, 1),
  BASKET: b(6, 2),
  BELL: b(6, 3),
  BRAKE: b(6, 4),
  SIL: b(7, 1),          // music stops: the held breath
  CLACK: b(7, 3),        // the most important sound: the mail-slot flap
  HSKIN: b(7, 3, 1),
  MAT: b(7, 4),
  STEP0: b(7, 4, 2),     // footsteps every eighth 13.75 … 14.25
  PICK: b(8, 2),
  OPENL: b(8, 3),        // letter opened, inset
  HEART: b(8, 4),
  PULL: b(9, 1),         // scale reveal pull-out 16.0–17.0
  CITYN: b(9, 2),
  CITYS: b(9, 2, 2),
  ISO0: b(9, 3),         // 12 Isotype envelopes, one per sixteenth
  SUN1: b(9, 4),
  SUN2: b(9, 4, 2),
  ARRIVE: b(10, 1),      // arrival postmark + final chord
  END: DUR,
};
T.POLINE = b(2, 1, 1);   // 2.25: post-office cut line 2.25–2.50
T.POSKIN = b(2, 2);      // 2.50: wall slides away 2.50–2.85, open before the letter lands on the belt
T.TRUCKLINE = b(3, 2, 2); // 4.75 truck side cut line
T.HOLDLINE = b(4, 2, 2);  // 6.75 cargo-hold cut line, skin at TRUCKARR
T.HLINE = T.CLACK;        // house cut line 13.00–13.25
export const NISO = 12, KM_PER_ICON = 100;
export const isoT = i => T.ISO0 + i * BEAT / 4;

// stage labels (pins). text, from, to — each stays ≥ reading time
export const STAGES = [
  { id: 'st', text: '寄出', t0: T.OPEN, t1: T.HOP1, instant: true },
  { id: 'st', text: '分拣', t0: T.POSKIN, t1: T.TRUCKIN },
  { id: 'st', text: '陆运', t0: T.TRUCKIN, t1: T.TRUCKARR + BEAT / 2 },
  { id: 'st', text: '航空', t0: T.TRUCKARR + BEAT / 2, t1: T.TOUCH - BEAT / 2 },
  { id: 'st', text: '投递', t0: T.TOUCH - BEAT / 2, t1: T.SIL },
  { id: 'st', text: '送达', t0: T.MAT, t1: T.PULL },
];

// sound + cue events for the mixer (foley types are interpreted by mix.py). `hit: true` = a visual hit that must coincide with a musical onset.
export function events() {
  const E = [];
  const ev = (t, type, o = {}) => E.push({ t: +t.toFixed(6), type, ...o });
  ev(0, 'tempo', { bpm: BPM, dur: DUR, sil0: T.SIL, sil1: T.CLACK });
  ev(T.DROP0, 'slide', { v: .5 });
  ev(T.SLOT, 'flap_metal', { hit: true });
  ev(T.MBLINE, 'pen', { d: .25 });
  ev(T.MBSKIN, 'skin', { v: .5 });
  ev(T.PILE, 'paper_land', { hit: true, v: .7 });
  ev(T.HOP1, 'hop', { hit: true });
  ev(T.HOP2, 'hop', { hit: true });
  ev(T.POLINE, 'pen', { d: .25 });
  ev(T.POIN, 'paper_land', { hit: true, v: .6 });
  ev(T.POSKIN, 'skin', { v: .6 });
  ev(T.BELT, 'belt_start', { hit: true });
  ev(T.STAMP, 'stamp_big', { hit: true });
  ev(T.FLIP, 'flip', { hit: true });
  ev(T.TRUCKLINE, 'pen', { d: .25 });
  ev(T.TRUCKIN, 'sack_thud', { hit: true });
  ev(T.TRUCKIN, 'skin', { v: .4 });
  ev(T.TRUCKGO, 'truck_go', { hit: true, d: T.TRUCKARR - T.TRUCKGO });
  ev(T.TRUCKARR, 'truck_stop', { hit: true });
  ev(T.HOLDLINE, 'pen', { d: .25 });
  ev(T.TRUCKARR, 'skin', { v: .4 });
  ev(T.TRUCKARR, 'loader', { d: T.HOLD - T.TRUCKARR });
  ev(T.HOLD, 'sack_thud', { hit: true, v: .8 });
  ev(T.ROLL, 'jet_roll', { hit: true, d: T.LIFT - T.ROLL });
  ev(T.LIFT, 'liftoff', { hit: true, d: T.TOUCH - T.LIFT });
  ev(T.TOUCH, 'touchdown', { hit: true });
  ev(T.BASKET - BEAT / 2, 'hop0', {});
  ev(T.BASKET, 'basket', { hit: true });
  ev(T.BASKET, 'bike', { d: T.BRAKE - T.BASKET });
  ev(T.BELL, 'bell', { hit: true });
  ev(T.BRAKE, 'brake', { hit: true });
  ev(T.SIL, 'slot_push', { d: T.CLACK - T.SIL });
  ev(T.CLACK, 'clack_slot', { hit: true });
  ev(T.HLINE, 'pen', { d: .25 });
  ev(T.HSKIN, 'skin', { v: .5 });
  ev(T.MAT, 'paper_land', { hit: true, v: .55 });
  ev(T.CLACK + BEAT / 4, 'bike_leave', { d: .75 });   // courier turns and pedals off (chain ticks fade away)
  for (let i = 0; i < 3; i++) ev(T.STEP0 + i * BEAT / 2, 'step', { hit: true, v: .5 });
  ev(T.PICK, 'pickup', { hit: true });
  ev(T.OPENL, 'tear', { hit: true });
  ev(T.OPENL, 'inset', {});
  ev(T.HEART, 'heart', { hit: true });
  ev(T.PULL, 'pullout', { hit: true, d: 1.0 });
  ev(T.CITYN, 'label', { hit: true });
  ev(T.CITYS, 'label', { hit: true });
  for (let i = 0; i < NISO; i++) ev(isoT(i), 'icon', { hit: true, i });
  ev(T.SUN1, 'sun', { hit: true });
  ev(T.SUN2, 'sun', { hit: true });
  ev(T.ARRIVE, 'stamp_big', { hit: true, final: 1 });
  // ambience beds: [t0, t1, kind]
  const bed = (t0, t1, kind, v = 1) => ev(t0, 'bed', { t1, kind, v });
  bed(0, 2.6, 'street');
  bed(2.5, 5.2, 'machine');       // J-cut: machine room 0.5 s before the wall opens
  bed(5.0, 7.3, 'road');
  bed(6.6, 8.7, 'apron');
  bed(8.5, 10.4, 'wind');         // L-cut: the jet tail runs over into the wind
  bed(10.0, 12.0, 'street', .9);
  bed(13.0, 16.4, 'room');
  bed(16.0, DUR, 'air', .7);
  return E;
}
