// 涨潮一米 — the one timeline. Picture (main.js), score + foley (mix.py via events.json) and checks (tools/cuecheck.py)
// all read these numbers. 88 BPM, 4/4: one beat = 0.6818 s, one bar = 2.727 s. Every key action sits on the grid.
export const BPM = 88;
export const BEAT = 60 / BPM;
export const b = n => n * BEAT;

export const T = {
  houseOff: b(2),     // 1.364  relay: house lights cut (0.25 s)
  fan: b(3),          // 2.045  projector fan spins up in the dark
  lamp: b(4),         // 2.727  lamp strikes: the sun clock starts at sunrise
  r1: b(5),           // 3.409  readout 01 lands
  trace: b(10),       // 6.818  the projector traces one hangar's evening shadow (fill + edge)
  measure: b(10.5),   // 7.159  the measured line has grown from the wall to the shadow's tip: its length lands
  sunset: b(12),      // 8.182  sun goes down; the water layer washes in (the turn)
  r2: b(12.5),        // 8.523  readout 02 lands once the wash has spread (the model has moved clear of it)
  traceOff: b(14),    // 9.545  the traced shadow and its measure are washed away
  tick8: b(15),       // 10.227 metronome doubles
  tick16: b(17),      // 11.591 and doubles again
  sill: b(17.5),      // 11.932 the level tops the sill (+0.974 m): the bowl behind it starts to fill
  top: b(19),         // 12.955 +1.00 m: everything stops (near-silence)
  hit: b(21),         // 14.318 the pick-out: only what is flooded stays lit; "+1 m" lands
  line2: b(23),       // 15.682 second line of the readout lands
  crest: b(25),       // 17.045 the crane tops out, brass turns
  coda: b(27),        // 18.409 the opening note returns
  end: b(28),         // 19.091 last downbeat
  dur: 19.5,
};

// sun clock: local time (PDT, hours) from sunrise to sunset while the beats b4..b12 pass. Not linear: the clock runs
// slow at both ends (long shadows) and fast through noon: h = rise + (set - rise) · (k − a·sin(2πk)/2π)
export const CLOCK = { t0: T.lamp, t1: T.sunset, a: .65 };

// water level / fill key (metres above MHHW) as a function of time; monotone keys
export const LEVEL = [
  [T.sunset, 0.0], [b(13), 0.06], [b(14), 0.24], [b(15), 0.47], [b(16), 0.72], [T.tick16, 0.95], [T.sill, 0.974], [T.top, 1.0],
];

// metronome ticks: quarters, then eighths, then sixteenths, up to the top
export const TICKS = (() => {
  const out = [];
  for (let k = 12; k < 15; k++) out.push(b(k));
  for (let k = 15; k < 17; k += .5) out.push(b(k));
  for (let k = 17; k < 19; k += .25) out.push(b(k));
  return out;
})();
// picked-out buildings flash on this grid (a 32nd-note during the cascade, a 16th before it)
export const PICK_GRID = { early: BEAT / 4, cascade: BEAT / 8 };
