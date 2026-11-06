// 红色自行车 — the single time source. Music grid, hit points, bike choreography and cameras.
// Pure module (no DOM): film.js, tools/dump.mjs and tools/cuecheck.mjs all import it.
export const BPM = 96, BEATS = 3;
export const BEAT = 60 / BPM;            // 0.625 s = 15 frames @ 24 fps
export const BAR = BEAT * BEATS;         // 1.875 s
export const tb = (bar, beat = 1) => bar * BAR + (beat - 1) * BEAT;   // bar 0 starts at 0.0
export const FPS = 24;

// ---- hit points (bar, beat): every visual event lands here; the score plays on the same numbers
export const HIT = {
  knife:   [0, 1],    // 0.000 the first knife stroke (macro)
  pull:    [1, 1],    // 1.875 pull-back begins
  enter:   [2, 1],    // 3.750 front wheel crosses the left frame edge
  bell:    [2, 2],    // 4.375 bicycle bell
  stand:   [4, 1],    // 7.500 rider stands on the pedals: faster, knife every half beat
  brake:   [5, 1],    // 9.375 hard cut to medium + brake
  stop:    [5, 2],    // 10.000 bike stands still, left foot down
  lookUp:  [5, 3],    // 10.625 he lifts his head (inside the silence)
  scrape1: [6, 1],    // 11.250 FIRST SOUND AFTER THE SILENCE: the knife opens the cloud
  scrape2: [6, 3],    // 12.500
  scrape3: [7, 1],    // 13.125
  scrape4: [7, 2],    // 13.750
  scrape5: [7, 3],    // 14.375
  rake:    [8, 1],    // 15.000 light drops to a grazing angle: every ridge lights up
  pedal:   [8, 3],    // 16.250 foot back on the pedal
  away:    [9, 1],    // 16.875 cut: he rides off into the sun
  last:    [10, 1],   // 18.750 final chord, the bike disappears into the sun
};
export const T = Object.fromEntries(Object.entries(HIT).map(([k, [b, bt]]) => [k, tb(b, bt)]));
export const DUR = 19.5;

// ---- world (units = px at zoom 1). Sky plate and field plate share one coordinate system.
export const WORLD = { W: 4400, H: 2000, HZ: 1130, ROAD: 1585 };
export const SUN = { x: 3690, y: 1090, r: 92 };
export const VANISH = [3690, 1150];

// ---- bike choreography. x(t) = bike centre (midpoint between the hubs) on the straight road
const X0 = -166.32, V1 = 380, V2 = 600, RAMP = .3;
export const R_WHEEL = 60, HALF_WB = 105;
const tS = T.stand, tB = T.brake, tStop = T.stop;
const xStand = X0 + V1 * (tS - T.enter);
const xRampEnd = xStand + (V1 + V2) / 2 * RAMP;
const xBrake = xRampEnd + V2 * (tB - tS - RAMP);
export const X_STOP = xBrake + V2 * (tStop - tB) / 2;
export function bikeX(t) {
  if (t < T.enter) return X0 - V1 * (T.enter - t);
  if (t < tS) return X0 + V1 * (t - T.enter);
  if (t < tS + RAMP) { const a = t - tS; return xStand + V1 * a + (V2 - V1) * a * a / (2 * RAMP); }
  if (t < tB) return xRampEnd + V2 * (t - tS - RAMP);
  if (t < tStop) { const a = t - tB, d = tStop - tB; return xBrake + V2 * a - V2 * a * a / (2 * d); }
  return X_STOP;
}
export function bikeV(t) {
  if (t < tS) return V1;
  if (t < tS + RAMP) return V1 + (V2 - V1) * (t - tS) / RAMP;
  if (t < tB) return V2;
  if (t < tStop) return V2 * (1 - (t - tB) / (tStop - tB));
  if (t < T.away) return 0;
  return 1;   // riding away (see awayPos)
}
// ride-away: bezier from the stop point into the sun; depth scale shrinks to 0.08
const BZ = [[X_STOP, WORLD.ROAD], [3260, WORLD.ROAD + 6], [3560, 1215], VANISH];
const bez = (p, u) => { const v = 1 - u; return [0, 1].map(i => v * v * v * p[0][i] + 3 * v * v * u * p[1][i] + 3 * v * u * u * p[2][i] + u * u * u * p[3][i]); };
export function awayU(t) {
  const k = Math.max(0, Math.min(1, (t - T.away) / (T.last - T.away)));
  // pushes off (slow), then perspective: fast near, slow far
  const push = k < .12 ? k * k / .24 : k - .06;
  const kk = Math.max(0, Math.min(1, push / .94));
  return 1 - Math.pow(1 - kk, 1.7);
}
export function bikePose(t) {
  // returns ground point (x,y), scale, facing angle of travel, distance travelled (for wheel rotation)
  if (t < T.away) { const x = bikeX(t); return { x, y: WORLD.ROAD, s: 1, ang: 0, dist: x }; }
  const u = awayU(t), p = bez(BZ, u), q = bez(BZ, Math.min(1, u + .01));
  const s = 1 - .92 * Math.pow(u, .8);
  return { x: p[0], y: p[1], s, ang: Math.atan2(q[1] - p[1], q[0] - p[0]) * .25, dist: X_STOP + u * 1500 };
}
// rear-wheel contact x on the straight road, inverted: when does the rear wheel reach x?
export function rearTime(x) {
  let lo = T.enter - 2, hi = T.stop;
  if (bikeX(hi) - HALF_WB < x) return null;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (bikeX(m) - HALF_WB < x) lo = m; else hi = m; }
  return hi;
}
// knife grid for the repaint: every beat, every half beat while he stands on the pedals
export function knifeGrid() {
  const g = [];
  for (let t = T.enter; t < T.stand - 1e-6; t += BEAT) g.push(t);
  for (let t = T.stand; t < T.brake + 1e-6; t += BEAT / 2) g.push(t);
  g.push(T.stop);
  return g;
}
const GRID = knifeGrid();
export function chunkTime(x) {
  const tr = rearTime(x);
  if (tr === null) return null;
  for (const g of GRID) if (g >= tr - 1e-6) return g;
  return T.stop;
}

// ---- sky scrapes: five knife passes, each opening one band of cloud from the centre outward
export const SCRAPES = [
  { t: T.scrape1, y0: 830, y1: 1200, x0: 2560, pitch: 'A5' },
  { t: T.scrape2, y0: 600, y1: 830, x0: 2560, pitch: 'C#6' },
  { t: T.scrape3, y0: 370, y1: 600, x0: 2480, pitch: 'E6' },
  { t: T.scrape4, y0: 150, y1: 370, x0: 2400, pitch: 'A6' },
  { t: T.scrape5, y0: -60, y1: 150, x0: 2300, pitch: 'C#7' },
];
export const SCRAPE_SPEED = 3400;   // units per second the knife travels outward

// ---- cameras: {x, y, zoom}; one world → screen function for everything
const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const seg = (t, a, b) => clamp((t - a) / (b - a));
const eio = k => { k = clamp(k); return k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
const ss = k => { k = clamp(k); return k * k * (3 - 2 * k); };
const lz = (a, b, k) => Math.exp(lerp(Math.log(a), Math.log(b), k));   // zoom interpolated in log space
const WIDE0 = { x: 1130, y: 1380, zoom: .85 };
const TILT_END = 935;   // tilt-up end: the rider's raised head sits ~900 px down the frame
export function camera(t) {
  if (t < T.pull) {                                   // 1 · macro slide along the paint
    const k = t / T.pull;
    return { x: lerp(560, 760, k), y: lerp(1800, 1785, k), zoom: 3.3, shot: 1 };
  }
  if (t < T.enter) {                                  // 1 · pull back to the grey field
    const k = eio(seg(t, T.pull, T.enter));
    return { x: lerp(760, WIDE0.x, ss(k)), y: lerp(1785, WIDE0.y, k), zoom: lz(3.3, WIDE0.zoom, k), shot: 1 };
  }
  if (t < T.brake) {                                  // 2 · truck with the bike (soft follow), slight push
    const bx = bikeX(t), w = 140, target = bx + 230;
    const x = WIDE0.x + w * Math.log1p(Math.exp((target - WIDE0.x) / w));
    const k = seg(t, T.enter, T.brake);
    return { x, y: lerp(WIDE0.y, 1420, ss(k)), zoom: lerp(WIDE0.zoom, 1.02, ss(k)), shot: 2 };
  }
  if (t < T.scrape1) {                                // 3 · medium, push in through the silence
    const k = seg(t, T.brake, T.scrape1);
    return { x: lerp(X_STOP - 30, X_STOP + 10, ss(k)), y: lerp(1385, 1372, k), zoom: lerp(1.72, 1.98, ss(k)), shot: 3 };
  }
  if (t < T.scrape3) {                                // 4 · low wide, tilt up from the rider to the sky
    const k = seg(t, T.scrape1, T.scrape3);
    return { x: X_STOP + 20, y: lerp(1235, TILT_END, eio(k)), zoom: 1.25, shot: 4 };   // his head + shoulders stay in the bottom fifth
  }
  if (t < T.away) {                                   // 5 · crane out to the whole painting, hold for the light
    const k = eio(seg(t, T.scrape3, T.rake + .3));
    const drift = seg(t, T.rake + .3, T.away);
    return { x: lerp(X_STOP + 20, 2330, k) + drift * 30, y: lerp(TILT_END, 1035, k), zoom: lz(1.25, .6, k) * (1 + drift * .02), shot: 5 };
  }
  const k = seg(t, T.away, DUR);                      // 6 · locked wide, very slow push toward the sun
  return { x: lerp(3130, 3230, ss(k)), y: lerp(1250, 1210, ss(k)), zoom: lerp(1.0, 1.1, ss(k)), shot: 6 };
}
// sky parallax: during the truck the far sky moves slower than the field
export function skyCam(t, cam) {
  if (t >= T.brake) return cam;
  return { ...cam, x: 2200 + (cam.x - 2200) * .55 };
}
export const toScreen = (cam, x, y, W = 1920, H = 1080) => [(x - cam.x) * cam.zoom + W / 2, (y - cam.y) * cam.zoom + H / 2];

// ---- rider states (0..1 blends)
export function riderState(t) {
  const stand = ss(seg(t, T.stand - .25, T.stand)) * (1 - ss(seg(t, T.brake - .15, T.brake + .2)));
  const foot = ss(seg(t, T.brake + .25, T.stop)) * (1 - ss(seg(t, T.pedal - .3, T.pedal)));
  // head: anticipation dip, then up; settles slightly lower when the light peaks; back to the road for the ride-away
  const dip = Math.sin(Math.PI / 2 * seg(t, T.lookUp - .22, T.lookUp)) * .22 * (1 - ss(seg(t, T.lookUp, T.lookUp + .25)));
  const up = ss(seg(t, T.lookUp, T.lookUp + .45)) * (1 - .35 * ss(seg(t, T.rake, T.rake + 1))) * (1 - ss(seg(t, T.pedal, T.away)));
  return { stand, foot, head: up - dip, brakeLean: Math.sin(Math.PI * seg(t, T.brake, T.stop + .2)) };
}
// distance-driven wheel and crank angles
export function wheelAngle(t) { return bikePose(t).dist / R_WHEEL; }
export function crankAngle(t) {
  if (t < T.away) { const d = Math.min(bikeX(t), X_STOP - 30); return d / R_WHEEL / 2.4; }
  return X_STOP / R_WHEEL / 2.4 + awayU(t) * 22;
}

// ---- light keys (post): the raking light is the climax
export const LIGHT = [
  [0, { light: [-.86, -.3, .42], amb: .66, dif: .72, spec: .22, gain: [1, 1, 1], lift: [.02, .02, .025], sat: 1, expo: 1 }],
  [T.enter, { light: [-.3, -.55, .78], amb: .86, dif: .24, spec: .12, gain: [1, 1, 1], lift: [.02, .02, .025], sat: 1, expo: 1 }],
  [T.scrape1, { light: [-.3, -.55, .78], amb: .86, dif: .24, spec: .12, gain: [1, 1, 1], lift: [.02, .02, .025], sat: 1, expo: 1 }],
  [T.scrape3, { light: [.75, -.3, .58], amb: .8, dif: .36, spec: .2, gain: [1.06, 1, .93], lift: [.03, .015, .02], sat: 1.05, expo: 1.02 }],
  [T.rake - .45, { light: [.9, -.2, .38], amb: .7, dif: .62, spec: .24, gain: [1.08, 1, .9], lift: [.03, .012, .02], sat: 1.06, expo: 1.03 }],
  [T.rake, { light: [.97, -.1, .17], amb: .5, dif: 1.35, spec: .3, gain: [1.12, 1.0, .86], lift: [.035, .01, .02], sat: 1.1, expo: 1.06 }],
  [T.rake + 1.3, { light: [.84, -.24, .48], amb: .74, dif: .5, spec: .26, gain: [1.08, 1, .9], lift: [.03, .012, .02], sat: 1.06, expo: 1.02 }],
  [DUR, { light: [.84, -.24, .48], amb: .74, dif: .5, spec: .26, gain: [1.08, 1, .9], lift: [.03, .012, .02], sat: 1.06, expo: 1.02 }],
];
export function lightAt(t) {
  let i = 0; while (i < LIGHT.length - 2 && t >= LIGHT[i + 1][0]) i++;
  const [t0, a] = LIGHT[i], [t1, b] = LIGHT[i + 1], k = t1 === T.rake ? Math.pow(seg(t, t0, t1), 2) : ss(seg(t, t0, t1));
  const o = {};
  for (const key in a) o[key] = Array.isArray(a[key]) ? a[key].map((v, j) => lerp(v, b[key][j], k)) : lerp(a[key], b[key], k);
  return o;
}

// ---- events for the mixer (all on the grid)
export function events() {
  const ev = [];
  ev.push({ t: T.knife, type: 'knife_first', cue: HIT.knife });
  for (const g of GRID) if (g < T.stop - 1e-6) ev.push({ t: g, type: 'knife_lay', cue: 'grid', pan: 0 });
  ev.push({ t: T.enter, type: 'enter', cue: HIT.enter });
  ev.push({ t: T.bell, type: 'bell', cue: HIT.bell });
  ev.push({ t: T.stand, type: 'stand', cue: HIT.stand });
  ev.push({ t: T.brake, type: 'brake', cue: HIT.brake });
  ev.push({ t: T.stop, type: 'foot', cue: HIT.stop });
  ev.push({ t: T.lookUp, type: 'cloth', cue: HIT.lookUp });
  SCRAPES.forEach((s, i) => ev.push({ t: s.t, type: 'scrape', i, cue: HIT['scrape' + (i + 1)] }));
  ev.push({ t: T.rake, type: 'rake', cue: HIT.rake });
  ev.push({ t: T.pedal, type: 'pedal', cue: HIT.pedal });
  ev.push({ t: T.away, type: 'away', cue: HIT.away });
  ev.push({ t: T.last, type: 'last', cue: HIT.last });
  return ev;
}
