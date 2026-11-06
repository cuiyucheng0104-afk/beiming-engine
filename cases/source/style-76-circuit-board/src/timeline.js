// 《叮咚》 — the one source of time. Picture (main.js), score and foley (mix.py, via events.json) and the cue
// check (tools/cuecheck.mjs) all read these numbers. 120 BPM: one beat = 0.5 s = 15 frames at 30 fps.
export const FPS = 30, BPM = 120, BEAT = 60 / BPM, BAR = 4 * BEAT;
export const DUR = 19.8;
export const F = n => n / FPS;                       // frame -> seconds
export const B = n => n * BEAT;                      // beat (from 0) -> seconds

export const T = {
  press: B(3),                                       // 1.5  contact closes
  bounce: [45, 48, 52, 56].map(F),                   // the contact bounces: on at these frames…
  bounceOff: [47, 50, 54].map(F),                    // …and off at these
  launch: B(4),                                      // 2.0  the current leaves SW1
  r1: B(8),                                          // 4.0  through R1 (the stream thins)
  c1: B(10),                                         // 5.0  C1 node flashes
  viaDn: B(11), viaUp: B(12),                        // 5.5 / 6.0 through the board and back
  u1: B(14),                                         // 7.0  U1 input pin
  plunge: B(16), inside: B(18),                      // 8.0 -> 9.0 into the die
  sch: B(18), dff: B(19),                            // 9.0 Schmitt, 9.5 flip-flop
  // the sequencer: 16 steps, accelerating from eighths to the frame rate (frames from the start of the film)
  seq: [300, 308, 315, 323, 330, 334, 338, 342, 345, 347, 349, 351, 353, 355, 357, 359].map(F),
  rom1: B(22), rom2: B(23),                          // 11.0 叮 cell, 11.5 咚 cell
  stop: B(24),                                       // 12.0 everything stops (silence)
  out: B(26),                                        // 13.0 the output fires: first sound after the silence
  q: [B(28), B(29), B(30)],                          // 14.0 / 14.5 / 15.0 bases of Q1–Q3: silver in, amber out
  coil: B(31),                                       // 15.5 amber reaches the voice coil (after the whip)
  hush: B(32),                                       // 16.0 near-silence
  ding: B(33),                                       // 16.5 叮
  dong: B(35),                                       // 17.5 咚, every trace lights
};
// labels: [start, plotting time]
export const PLOT = {
  // every label finishes plotting on a beat
  push: [0.25, 0.75], pushE: [0.75, 0.25],
  chip: [5.75, 0.75], chipE: [6.25, 0.25],
  rom1: [T.rom1, 0.5], rom2: [T.rom2, 0.5],
  spk: [B(31) + 0.1, 0.4], spkE: [B(31) + 0.25, 0.25],
  ding: [T.ding, 0.5], dong: [T.dong, 0.5], dingE: [T.dong, 0.5],
};
// the cue map, for TREATMENT.md and the check: [name, time, beat (or null when on the frame grid only)]
export const CUES = [
  ['press', T.press], ['launch', T.launch], ['r1', T.r1], ['c1', T.c1], ['viaDn', T.viaDn], ['viaUp', T.viaUp], ['u1', T.u1],
  ['plunge', T.plunge], ['sch', T.sch], ['dff', T.dff], ...T.seq.map((t, i) => ['seq' + i, t]), ['rom1', T.rom1], ['rom2', T.rom2],
  ['stop', T.stop], ['out', T.out], ['q0', T.q[0]], ['q1', T.q[1]], ['q2', T.q[2]], ['coil', T.coil], ['hush', T.hush], ['ding', T.ding], ['dong', T.dong],
];
