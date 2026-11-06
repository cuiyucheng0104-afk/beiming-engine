// 地球的一秒 — the single source of truth: tempo, beat grid, every mark, every cue.
// Pure ES module (no browser APIs): the page imports it, tools/export_timeline.mjs writes timeline.json for Python.
export const BPM = 90, B = 60 / BPM, FPS = 24;          // 1 beat = 16 frames, 1/32 note = 2 frames
export const T = b => b * B;
export const BEATS = 29.75, DUR = T(BEATS);              // 19.833 s = 476 frames (tail held so the last note rings out)

// ---------- facts (FACTS.md) ----------
export const RATE = { birth: 4.2, bolt: 44 };            // per second: US Census Bureau (Jan 2025) · NASA OTD (44 ± 5)

// ---------- chart geometry (world px at zoom 1) ----------
export const X0 = -700, X1 = 700, PW = X1 - X0, AXY = 200;
export const LANE = { birth: [-90, 20], bolt: [70, 180] };          // [top, bottom] before the day morph
export const DAYH = { birth: 48 };                                  // births band height at the end (area ∝ count, equal density)
DAYH.bolt = DAYH.birth * RATE.bolt / RATE.birth;                    // 628.6 px

// ---------- the one second: every mark on the grid ----------
// births on beats; bolts quarter → eighth → sixteenth → thirty-second notes (divide the beat, keep the tempo)
const hsh = n => { n = Math.sin(n * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };
export const BIRTH_B = [4, 11, 13.5, 15];
const boltB = [6, 7, 7.5, 8, 8.5, 9, 9.5];
for (let b = 10; b < 12 - 1e-9; b += .25) if (b !== 11) boltB.push(b);
for (let b = 12; b < 16 - 1e-9; b += .125) if (b !== 13.5 && b !== 15) boltB.push(b);
export const BOLT_B = boltB;
export const MARKS = [...BIRTH_B.map(b => ({ b, kind: 'birth' })), ...BOLT_B.map(b => ({ b, kind: 'bolt' }))]
  .sort((a, b) => a.b - b.b);
export const U_TOTAL = MARKS.length;                                 // 48 marks → evenly spread over the second
MARKS.forEach((m, i) => {
  m.u = i;
  m.n = MARKS.slice(0, i + 1).filter(k => k.kind === m.kind).length;  // 1-based count within its kind
  const jit = m.kind === 'bolt' ? (hsh(i * 3.1 + 2) - .5) * .6 : 0;
  m.sec = (i + .5 + jit) / U_TOTAL;                                  // position inside the second (illustrative; the count is the fact)
  m.v = m.kind === 'birth' ? .5 + (hsh(i * 5.7) - .5) * .35 : .12 + hsh(i * 7.3 + 1) * .76;   // lane-relative height
  m.t = T(m.b);
});
// playhead: piecewise-linear through the marks (it speeds up as marks densify)
const PH = [[T(3.5), -.5], ...MARKS.map(m => [m.t, m.u]), [T(16), U_TOTAL - .5], [T(17), U_TOTAL - .5]];
export function playU(t) {
  if (t <= PH[0][0]) return PH[0][1];
  for (let i = 0; i < PH.length - 1; i++) if (t <= PH[i + 1][0]) { const [a, ua] = PH[i], [b, ub] = PH[i + 1]; return ua + (ub - ua) * (t - a) / (b - a); }
  return PH[PH.length - 1][1];
}
export const playSec = t => Math.max(0, Math.min(1, (playU(t) + .5) / U_TOTAL));

// ---------- the scale switch: ratchet second → minute → hour → day ----------
export const LEVELS = [
  { F: 1, end: '1 秒', ticks: ['0', '0.25', '0.5', '0.75', '1 秒'], per: '/秒' },
  { F: 60, end: '1 分', ticks: ['0', '15 秒', '30 秒', '45 秒', '1 分'], per: '/分' },
  { F: 3600, end: '1 时', ticks: ['0', '15 分', '30 分', '45 分', '1 时'], per: '/时' },
  { F: 86400, end: '1 天', ticks: ['0', '6 时', '12 时', '18 时', '1 天'], per: '/天' },
];
export const STEP_B = [20, 21, 22];                                  // each step = 4 ratchet teeth on 1/32 notes
export const TEETH = 4, TOOTH = .125, TOOTH_EASE = .09;
export function logF(t) {                                            // stepped, each tooth eased
  let lf = 0;
  STEP_B.forEach((b0, s) => {
    const a = Math.log(LEVELS[s].F), z = Math.log(LEVELS[s + 1].F);
    for (let k = 0; k < TEETH; k++) {
      const tb = T(b0 + k * TOOTH), e = Math.max(0, Math.min(1, (t - tb) / T(TOOTH_EASE)));
      lf += (z - a) / TEETH * (1 - Math.pow(1 - e, 3));
    }
  });
  return lf;
}
export const scaleF = t => Math.exp(logF(t));
export const levelAt = t => { let l = 0; STEP_B.forEach((b, s) => { if (t >= T(b)) l = s + 1; }); return l; };
export const MORPH = [22.5, 24];                                     // lanes become equal-density area blocks

// ---------- key beats ----------
export const K = {
  axis: [0, 1],                      // pencil draws the axis right → left
  ticks: [1, 1.5, 2, 2.5, 3],        // five ticks, left → right
  labels: [0.25, 0.5],               // lane labels 出生 / 闪电 typeset while the axis is drawn
  noteBirth: [4.125, 5.25],           // leader + "1 个婴儿出生" (blue)
  flip: [5.5, 5.9],                  // blue → red lead (wooden click)
  noteBolt: [6.125, 6.875],            // leader + "1 道闪电" (red)
  settle: 16,                        // counters settle on the facts
  riser: [16.5, 18],
  silence: [18, 20],                 // true digital silence, every layer
  hover: [17, 20],                   // pencil hesitates over "1 秒"
  tap: 20,                           // the tap that breaks the second open (first sound after the silence)
  flinch: [20, 20.75],
  notesFade: [20, 20.6],
  back: [23, 23.25],                 // pencil returns from the lower right
  bracket: [23.25, 23.625],          // red bracket along the lightning block
  ratio: [23.625, 24.375],           // "约 10 倍" (44 / 4.2 = 10.5)
  strike: [25, 25.4],                // pencil strikes 一秒 in the title
  rewrite: [25.5, 26.25],            // writes 一天
  exit: [26.5, 27.5],
  last: 28,                          // the next second's first birth note (music)
};

// ---------- events for the mixer (also exported to events.json by the page) ----------
export function buildEvents() {
  const E = [], at = (b, type, o = {}) => E.push({ t: +T(b).toFixed(6), b, type, ...o });
  at(K.axis[0], 'axis', { dur: T(K.axis[1] - K.axis[0]) });
  K.ticks.forEach((b, i) => at(b, 'tick', { i }));
  K.labels.forEach((b, i) => at(b, 'label', { i }));
  MARKS.forEach(m => at(m.b, m.kind, { n: m.n, u: m.u, gap: T(nextGap(m)) }));
  at(K.noteBirth[0], 'write', { dur: T(K.noteBirth[1] - K.noteBirth[0]), lead: 'blue' });
  at(K.flip[0], 'flip', { dur: T(K.flip[1] - K.flip[0]) });
  at(K.noteBolt[0], 'write', { dur: T(K.noteBolt[1] - K.noteBolt[0]), lead: 'red' });
  at(K.settle, 'settle');
  at(K.riser[0], 'riser', { dur: T(K.riser[1] - K.riser[0]) });
  at(K.silence[0], 'silence', { dur: T(K.silence[1] - K.silence[0]) });
  at(K.tap, 'tap');
  STEP_B.forEach((b0, s) => { at(b0, 'scale', { level: s + 1 }); for (let k = 0; k < TEETH; k++) at(b0 + k * TOOTH, 'tooth', { level: s + 1, k }); });
  at(MORPH[0], 'morph', { dur: T(MORPH[1] - MORPH[0]) });
  at(K.back[0], 'enter', { dur: T(K.back[1] - K.back[0]) });
  at(K.bracket[0], 'write', { dur: T(K.bracket[1] - K.bracket[0]), lead: 'red', kind: 'bracket' });
  at(K.ratio[0], 'write', { dur: T(K.ratio[1] - K.ratio[0]), lead: 'red' });
  at(K.strike[0], 'strike', { dur: T(K.strike[1] - K.strike[0]) });
  at(K.rewrite[0], 'write', { dur: T(K.rewrite[1] - K.rewrite[0]), lead: 'red' });
  at(K.exit[0], 'exit', { dur: T(K.exit[1] - K.exit[0]) });
  at(K.last, 'last');
  return E.sort((a, b) => a.t - b.t);
}
function nextGap(m) {
  const i = MARKS.indexOf(m), nx = MARKS[i + 1], pv = MARKS[i - 1];
  return Math.min(nx ? nx.b - m.b : 2, pv ? m.b - pv.b : 2);
}
