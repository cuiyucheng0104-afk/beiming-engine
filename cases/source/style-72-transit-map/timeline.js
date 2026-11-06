// 《十年》 TEN YEARS — direction: the beat grid, growth phases, camera, printed furniture, overlays, sound cues.
// The single source of time: every visual event below is written in beats of one grid (112.5 BPM, 16 frames a beat at 30 fps);
// mix.py reads the same beats back from events.json, so picture and score land on the same frames.
import { clamp, lerp, seg, ss, eio, eo, ei, back, monotone, hash } from '/core/lib.js';

export const BPM = 112.5, BEAT = 60 / BPM;          // 0.5333 s
export const B = n => n * BEAT;
const DUR = B(37);                                  // 19.733 s
const W = v => v * 100;
const K = (x, y, zpx, tilt, head, ap, extra = {}) => ({ x: W(x), y: W(y), z: zpx / 100, tilt, head, ap, ...extra });

// ------------------------------------------------------------------ the cue map (beats)
export const CUE = {
  open: 0, red: 0, blueStart: 6, meet: 11, wedding: 15, dive: 17, surface: 19, newHome: 21,
  ringStart: 22, rainy: 25, southGate: 26, bridgeN: 26.5, bridgeS: 27.5, silence: 29, land: 31,
  veilOn: 32.5, veilOff: 35.2, endChime: 35, end: 37,
};
const FALL = .42;                                   // the engine drops a capsule for 0.42 s before it lands

// ------------------------------------------------------------------ growth phases (keys in beats → seconds)
const P = (path, a, b, keys, extra = {}) => ({ path, a, b, t0: 0, t1: 0, keys: keys.map(([bt, s]) => [B(bt), s]), ...extra });
const PHASES = [
  P('1', 'BY', 'JBN', [[0, 'BY'], [1, 'CZW'], [2, 'ZBC'], [3, 'DYF'], [4, 'JB'], [5, 'XY'], [6, 'SZ'], [7, 'JBN']], { year: 2016, yearLabel: '2016' }),
  P('2', 'SD', 'NM', [[6, 'SD'], [7, 'KFG'], [8, 'YT'], [9, 'DYY'], [11, 'XY'], [12, 'TJ'], [13, 'HL'], [14, 'NM']], { year: 2018, yearLabel: '2018' }),
  // into the river at x 10.7, out at 11.9 (the band's edge + the tunnel margin), on the beat both times
  P('3', 'HL', 'XJ', [[15, 'HL'], [16, 'GB'], [17, [10.7, 11.35]], [19, [11.9, 11.35]], [20, 'XC'], [21, 'XJ']], { year: 2021, yearLabel: '2021' }),
  // the ring: two tips leave 出租屋 in opposite directions and meet at 新家
  P('R', 'CZW', 'XJ', [[22, 'CZW'], [23.5, 'FMJ'], [25, 'YT'], [26.5, [11.3, 6.6]], [27, 'LY'], [29, [15.15, 8.8]], [31, 'XJ']], { year: 2026, yearLabel: '2026' }),
  P('R', 'CZW', 'XJ', [[22, 'CZW'], [23.5, 'XQ'], [26, 'NM'], [27.5, [11.3, 12.55]], [28, 'HZ'], [29, [15.15, 10.8]], [31, 'XJ']], { year: 2026, aLast: true }),
];
const DONE = { '1': B(7), '2': B(14), '3': B(21), 'R': B(31) };

// ------------------------------------------------------------------ helpers filled at init
let H = null;
function phaseTip(idx, t) { const o = H.PH[idx]; const s = o.t0 >= t ? o.s0 : o.t1 <= t ? o.s1 : lerp(o.s0, o.s1, clamp(o.f(t))); return H.pointAt(o.path, s); }
function smoothTip(idx, t, span = .35) { let x = 0, y = 0; for (let k = -4; k <= 4; k++) { const q = phaseTip(idx, t + k * span / 4); x += q[0]; y += q[1]; } return [x / 9, y / 9]; }

// ------------------------------------------------------------------ camera
const lz = (a, b, u) => Math.exp(lerp(Math.log(a), Math.log(b), u));
function mixCam(a, b, u) { return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: lz(a.z, b.z, u), tilt: lerp(a.tilt, b.tilt, u), head: lerp(a.head, b.head, u), ap: lerp(a.ap || 0, b.ap || 0, u), far: lerp(a.far || 5, b.far || 5, u) }; }
function keyTrack(keys) {   // monotone keyframes per channel; zoom interpolated in log
  const ch = ['x', 'y', 'lz', 'tilt', 'head', 'ap', 'far'], ks = keys.map(([t, c]) => [t, { ...c, lz: Math.log(c.z), far: c.far || 5 }]);
  const f = Object.fromEntries(ch.map(k => [k, monotone(ks.map(([t, c]) => [t, c[k]]))]));
  return t => ({ x: f.x(t), y: f.y(t), z: Math.exp(f.lz(t)), tilt: f.tilt(t), head: f.head(t), ap: f.ap(t), far: f.far(t) });
}
// shot 1 (B0–B6): the cartouche and the first tip in one frame, then the camera takes off and rides the red tip
function shot1(t) {
  const a0 = mixCam(K(2.3, 10.35, 172, 26, -6, 10), K(3.4, 10.25, 165, 24, -4, 11), ss(seg(t, 0, 2.2)));
  const tp = smoothTip(0, t, .45);
  const ride = { x: tp[0] + 150, y: tp[1] + 10, z: 1.85, tilt: 20, head: 4, ap: 16 };
  return mixCam(a0, ride, eio(seg(t, 2.45, 3.2)));
}
let TR2 = null, TR5 = null, TR7 = null;
function initCam() {
  // shots 2–4 (B6–B22): glide north to the blue tip, push in on the fall, follow south, drop low over the river, breathe on 新家
  TR2 = keyTrack([
    [B(6), shot1(B(6))],
    [B(7.7), K(7.45, 6.9, 175, 28, -4, 10)],
    [B(9.5), K(7.3, 8.7, 210, 36, 2, 16)],
    [B(11), K(7.3, 9.25, 255, 42, 6, 18)],
    [B(12), K(7.45, 9.6, 240, 40, 8, 16)],
    [B(13.5), K(7.9, 11.0, 205, 34, 0, 12)],
    [B(15), K(8.9, 11.35, 195, 40, -6, 16)],
    [B(16), K(9.95, 11.32, 205, 50, -12, 22)],
    [B(17), K(10.72, 11.34, 232, 57, -16, 26)],
    [B(18), K(11.3, 11.34, 240, 58, -10, 26)],
    [B(19), K(11.95, 11.32, 228, 56, -4, 24)],
    [B(20), K(13.45, 10.95, 180, 46, 2, 20)],
    [B(21), K(14.75, 10.1, 165, 40, 6, 16)],
    [B(22), K(14.95, 9.95, 178, 36, 8, 14)],
  ]);
  // shot 7 (B31–B37): rise from the low sweep to the whole sheet
  TR7 = keyTrack([
    [B(31), shot6(B(31))],
    [B(32.5), K(13.3, 9.6, 104, 32, 0, 12)],
    [B(34), K(9.0, 9.1, 84, 8, 0, 3)],
    [B(35), K(8.15, 8.95, 76, 0, 0, 0)],
    [B(37), K(8.1, 8.9, 74, 0, 0, 0)],
  ]);
}
function shot5(t) {   // hard cut on B22: the whole network, a continuous pull-back while the ring is drawn (levels of detail)
  const u = 1 - Math.pow(1 - seg(t, B(22), B(29)), 1.6);
  return mixCam(K(8.7, 9.1, 106, 16, 8, 7), K(8.6, 9.0, 80, 3, 0, 1.5), u);
}
function shot6(t) {   // hard cut on B29: a low oblique sweep on 新家, shallow focus, the two tips coming in from the blur
  const u = seg(t, B(29), B(31));
  return { x: W(15.05), y: W(9.8), z: lz(1.75, 2.15, ss(u)), tilt: lerp(57, 60, u), head: lerp(26, 6, ss(u)), ap: 24, far: 9 };
}
function camera(t) {
  if (t < B(6)) return shot1(t);
  if (t < B(22)) {
    const c = TR2(t);
    if (t < B(6) + .55) return mixCam(shot1(t), c, eio(seg(t, B(6), B(6) + .55)));
    const k = t - B(11); if (k > -.3 && k < .8) c.z *= 1 + .07 * Math.exp(-Math.abs(k) * 6);   // the slam: a short push
    const d = t - B(CUE.dive); if (d > -.25 && d < 1.0) c.z *= 1 + .085 * Math.exp(-Math.abs(d) * 4.5);   // the dive: a push into the water
    return c;
  }
  if (t < B(29)) return shot5(t);
  if (t < B(31)) return shot6(t);
  const c = TR7(t), k = t - B(31); if (k >= 0 && k < .6) c.z *= 1 + .05 * Math.exp(-k * 9) * Math.cos(k * 30);   // the landing thud
  return c;
}

// ------------------------------------------------------------------ sheet, cartouche, regions
const SHEET = [W(-1.6), W(2.4), W(17.8), W(15.4)];
const INKC = '#1b1c1e', RED = '#E3002B';
function rt(c, R, id, s, x, y, size, a = 1, screen = false) {   // register a printed line for window.TEXTS
  if (!R || !R.regW) return;
  const w = c.measureText(s).width, al = c.textAlign, x0 = al === 'center' ? x - w / 2 : al === 'right' ? x - w : x, y0 = y - size * .9, y1 = y + size * .25;
  if (screen) R.regS(id, s, x0, y0, x0 + w, y1, a); else R.regW(id, s, x0, y0, x0 + w, y1, a, 12);
}
function furniture(c, t, view, k) {
  const { F, INK, MUTED } = k, x = W(-0.75);
  // cartouche, north-west of the first station: the map's name is the film's title
  c.save(); c.textBaseline = 'alphabetic'; c.textAlign = 'left';
  c.fillStyle = INK; c.fillRect(x, W(8.45), 90, 10);
  const reg = t < B(6);   // read at the start; at the end it is furniture again
  c.font = F(800, 64); c.fillText('十年', x, W(9.2)); if (reg) rt(c, k, 'title', '十年', x, W(9.2), 64);
  c.font = F(600, 30); c.fillText('TEN YEARS', x, W(9.58)); if (reg) rt(c, k, 'title-en', 'TEN YEARS', x, W(9.58), 30);
  c.font = F(600, 24); c.fillStyle = MUTED; c.fillText('虚构线网', x, W(9.98)); if (reg) rt(c, k, 'note', '虚构线网', x, W(9.98), 24);
  c.font = F(500, 19); c.fillText('A fictional network', x, W(10.26)); if (reg) rt(c, k, 'note-en', 'A fictional network', x, W(10.26), 19);
  c.font = F(700, 22); c.fillStyle = INK; c.fillText('2016 — 2026', x, W(10.62));
  c.restore();
  // printed regions: what each bank of the river stands for
  c.save(); c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.fillStyle = 'rgba(74,71,64,.42)';
  c.font = F(800, 58); c.fillText('那些年', W(1.0), W(14.3)); c.font = F(600, 34); c.fillText('THOSE YEARS', W(1.0), W(14.75));
  c.textAlign = 'right'; c.font = F(800, 58); c.fillText('后来', W(17.2), W(4.25)); c.font = F(600, 34); c.fillText('LATER', W(17.2), W(4.7));
  c.restore();
}
function riverLabels(c, t, view, { F }) {
  for (const [x, y] of [[11.3, 8.0], [12.3, 3.4]]) {
    c.save(); c.fillStyle = '#5f88ad'; c.textBaseline = 'middle'; c.textAlign = 'center';
    c.translate(W(x), W(y)); c.rotate(-Math.PI / 2); c.font = F(700, 22); c.fillText('那条江', 0, -12); c.font = F(600, 17); c.fillText('That River', 0, 12);
    c.restore();
  }
}

// ------------------------------------------------------------------ interchanges that fall: 相遇 (red + blue) and 新家 (the ring closes)
const drops = { XY: true, XJ: true };
function dropRing(c, n, k2, { capsule, INK }) {
  if (k2 < 0) return;
  const big = n.id === 'XJ', cols = big ? ['#00975A', '#7E3F98', '#E3002B', '#0A6CB4'] : ['#E3002B', '#0A6CB4'], T = big ? 1.1 : .9;
  if (k2 < T) { const v = k2 / T; c.save(); c.globalAlpha *= (1 - v) * .75; c.lineWidth = big ? 8 : 7; c.strokeStyle = INK; c.beginPath(); c.arc(n.cx, n.cy, 30 + (big ? 230 : 200) * eo(v), 0, 7); c.stroke();
    cols.forEach((col, i) => { c.lineWidth = big ? 6 : 5; c.strokeStyle = col; c.beginPath(); c.arc(n.cx, n.cy, 24 + (big ? 255 - 38 * i : 170 - 45 * i) * eo(clamp(v * (1.12 + .14 * i))), 0, 7); c.stroke(); });
    c.restore(); }
  capsule(c, n, 1 + .2 * Math.exp(-k2 * 13) * Math.cos(k2 * 40), 7);
}

// ------------------------------------------------------------------ trains on finished track
function trains(c, t, { PATHS, train }) {
  const v = veil(t);
  for (const path of Object.values(PATHS)) {
    const done = DONE[path.line]; if (t < done + .25) continue;
    const L = path.total, n = Math.max(1, Math.floor(L / 400)), gap = L / n, sp = 200, a0 = seg(t, done + .25, done + .7);
    for (let k = 0; k < n; k++) for (const dir of [1, -1]) {
      let s = (k * gap + hash(L + k * 7 + dir) * gap + dir * (t - done) * sp) % L; if (s < 0) s += L;
      const edge = path.line === 'R' ? 1 : clamp(Math.min(s - 25, L - 25 - s) / 40);
      if (edge <= 0) continue;
      train(c, path, s, path.color, a0 * edge * (path.line === 'R' ? 1 : 1 - .7 * v));
    }
  }
}

// ------------------------------------------------------------------ the end: the ring stays lit under a paper veil, "you are here"
function veil(t) { return ss(seg(t, B(CUE.veilOn), B(34))) * (1 - ss(seg(t, B(CUE.veilOff), B(36.4)))); }
const LIT = ['CZW', 'FMJ', 'YT', 'LY', 'XJ', 'HZ', 'NM', 'XQ'];
function stationDim(n, t, v) { if (v <= 0) return 1; return LIT.includes(n.id) ? 1 : 1 - .8 * v; }
function highlight(c, t, { PATHS, subPath }, top = false) {
  const g = veil(t); if (g <= 0) return;
  const p = PATHS['R']; c.save(); c.lineCap = 'round';
  if (!top) { c.strokeStyle = `rgba(126,63,152,${.2 * g})`; c.lineWidth = 60; c.beginPath(); subPath(c, p, 0, p.total); c.stroke(); }
  else { c.strokeStyle = '#7E3F98'; c.lineWidth = 15; c.beginPath(); subPath(c, p, 0, p.total); c.stroke(); }
  c.restore();
}
function hereMarker(c, t, K) { const { F, INK } = K;
  const t0 = B(CUE.land); if (t < t0) return;
  const n = H.SNODE.XJ, x = n.cx, y = n.cy, a = seg(t, t0, t0 + .12);
  c.save();
  const ph = ((t - t0) % BEAT) / BEAT;   // one pulse per beat
  c.globalAlpha = a * (1 - ph) * .7; c.strokeStyle = RED; c.lineWidth = 4; c.beginPath(); c.arc(x, y, 24 + 44 * eo(ph), 0, 7); c.stroke();
  c.globalAlpha = a; c.fillStyle = RED; c.beginPath(); c.arc(x, y, 17 * back(seg(t, t0, t0 + .25), 3), 0, 7); c.fill(); c.lineWidth = 4; c.strokeStyle = '#fff'; c.stroke();
  // a printed callout to the north-east, on a paper block with a soft shadow (it sits over the ring)
  const bx = x + 46, by = y - 104;
  c.fillStyle = 'rgba(244,240,231,.95)'; c.shadowColor = 'rgba(0,0,0,.16)'; c.shadowBlur = 14; c.shadowOffsetY = 4;
  c.beginPath(); c.roundRect(bx - 4, by - 2, 236, 96, 8); c.fill(); c.shadowColor = 'transparent';
  c.fillStyle = RED; c.fillRect(bx + 8, by + 10, 8, 74);
  c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.fillStyle = INK;
  c.font = F(800, 40); c.fillText('你在这里', bx + 30, by + 46); rt(c, K, 'here', '你在这里', bx + 30, by + 46, 40, a);
  c.font = F(600, 26); c.fillStyle = '#3d3a34'; c.fillText('You are here', bx + 30, by + 80); rt(c, K, 'here-en', 'You are here', bx + 30, by + 80, 26, a);
  c.restore();
}
function annotations(c, t, view, k) { hereMarker(c, t, k); }

// ------------------------------------------------------------------ the counter (screen space): a year drum that lands only on story years
const YEARS = [[0, 2016], [B(6), 2018], [B(15), 2021], [B(31), 2026]];
const SPIN = [[B(5.5), B(6), 2016, 2018, 1], [B(14.5), B(15), 2018, 2021, 1], [B(22), B(31), 2021, 2026, 6]];
export const SPINS = SPIN;
const E = u => u * u * u * (u * (u * 6 - 15) + 10);           // smootherstep: the drum wakes, races, settles
const dE = u => 30 * u * u * (u - 1) * (u - 1);
function yearCells(t) {
  const sp = SPIN.find(([a, b]) => t > a && t < b);
  const held = YEARS.filter(([a]) => a <= t).pop()[1];
  const dig = v => String(v).split('').map(Number);
  if (!sp) return { cells: dig(held).map(p => ({ pos: p, blur: 0 })), value: String(held) };
  const [a, b, y0, y1, k] = sp, u = (t - a) / (b - a), d0 = dig(y0), d1 = dig(y1);
  const first = d0.findIndex((p, i) => p !== d1[i]);
  const cells = d0.map((p, i) => {
    if (i < first) return { pos: p, blur: 0 };
    const N = ((d1[i] - p + 10) % 10) + 10 * (i === 3 ? k : 0), pos = p + N * E(u), speed = N * dE(u) / (b - a);
    return { pos: pos % 10, blur: clamp(speed / 26) };
  });
  return { cells, value: null };
}
function drum(c, x, y, w, h, pos, F, blur = 0) {
  c.save(); c.beginPath(); c.roundRect(x, y, w, h, 5); c.clip();
  const g = c.createLinearGradient(0, y, 0, y + h); g.addColorStop(0, '#9c968a'); g.addColorStop(.18, '#efe9dc'); g.addColorStop(.5, '#faf6ee'); g.addColorStop(.82, '#efe9dc'); g.addColorStop(1, '#9c968a');
  c.fillStyle = g; c.fillRect(x, y, w, h);
  const d = Math.floor(pos) % 10, f = pos - Math.floor(pos);
  c.font = F(800, h * .7); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#1b1c1e';
  const n = blur > .05 ? 7 : 1;
  for (let k = 0; k < n; k++) { const off = n > 1 ? (k / (n - 1) - .5) * blur * h * .9 : 0; c.globalAlpha = n > 1 ? .26 : 1;
    for (const dd of [-1, 0, 1, 2]) c.fillText(String((d + dd + 10) % 10), x + w / 2, y + h / 2 + (dd - f) * h + 2 + off); }
  c.globalAlpha = 1;
  const sh = c.createLinearGradient(0, y, 0, y + h); sh.addColorStop(0, 'rgba(0,0,0,.35)'); sh.addColorStop(.25, 'rgba(0,0,0,0)'); sh.addColorStop(.75, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,.35)'); c.fillStyle = sh; c.fillRect(x, y, w, h);
  c.restore();
}
function odometer(c, t, F, R) {
  const x = 46, y = 40, w = 430, rh = 86, h = 26 + rh;
  c.save();
  c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = 18; c.shadowOffsetY = 6;
  c.beginPath(); c.roundRect(x, y, w, h, 14); const pg = c.createLinearGradient(0, y, 0, y + h); pg.addColorStop(0, '#2a2d31'); pg.addColorStop(1, '#17191c'); c.fillStyle = pg; c.fill();
  c.shadowColor = 'transparent'; c.lineWidth = 1.5; c.strokeStyle = 'rgba(255,255,255,.12)'; c.stroke();
  for (const [sx, sy] of [[x + 12, y + 12], [x + w - 12, y + 12], [x + 12, y + h - 12], [x + w - 12, y + h - 12]]) { c.beginPath(); c.arc(sx, sy, 3.2, 0, 7); c.fillStyle = '#8b8577'; c.fill(); }
  const ry = y + 18;
  c.fillStyle = '#efe8d8'; c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.font = F(700, 24); c.fillText('年份', x + 30, ry + 34); rt(c, R, 'odo', '年份', x + 30, ry + 34, 24, 1, true);
  c.font = F(500, 17); c.fillStyle = '#aaa395'; c.fillText('Year', x + 30, ry + 60); rt(c, R, 'odo-en', 'Year', x + 30, ry + 60, 17, 1, true);
  const { cells, value } = yearCells(t);
  let cx = x + w - 30 - 4 * 42;
  if (value && R && R.regS) R.regS('odo-value', value, cx, ry + 6, cx + 4 * 42, ry + 66, 1);
  for (const q of cells) { drum(c, cx, ry + 6, 38, 60, q.pos, F, q.blur); cx += 42; }
  c.restore();
}
function overlay(c, t, O) { odometer(c, t, O.F, O); }

// ------------------------------------------------------------------ labels by shot (names show in held views, never flashed)
const HUBS = ['BY', 'CZW', 'XY', 'HL', 'XJ'];
const WORK = ['DYF', 'JB', 'SZ'];   // 第一份工 · 加班 · 升职: the first line's story, held long enough to read
function labelOnly(t) {
  if (t < B(6)) return ['BY'];
  if (t < B(11)) return WORK;
  if (t < B(16)) return ['XY', ...WORK];
  if (t < B(22)) return ['XJ'];
  if (t < B(29)) return HUBS;
  if (t < B(33)) return ['XJ'];
  return [...HUBS, 'YT', 'NM'];
}
// in the final whole view the names are furniture; the line meant to be read there is "you are here"
const regLabel = (n, t) => t < B(31) || n.id === 'XJ';
function labelFade(n, t) {
  if (WORK.includes(n.id)) return ss(seg(t, B(7), B(7.5))) * (1 - ss(seg(t, B(14.5), B(15))));   // printed once the glide has settled on the line
  if (n.id === 'XJ') { const l = B(CUE.land); return 1 - ss(seg(t, l - FALL - .12, l - FALL)) + ss(seg(t, l + .15, l + .45)); }
  return 1;
}

// ------------------------------------------------------------------ cues for the score (film time; beats kept for the check)
const CUES = [];
for (const [name, bt] of Object.entries(CUE)) CUES.push({ t: B(bt), type: 'cue', name, beat: bt });
CUES.push({ t: B(CUE.meet) - FALL, type: 'fall', id: 'XY' }, { t: B(CUE.land) - FALL, type: 'fall', id: 'XJ' });
for (const [a, b, y0, y1, k] of SPIN) CUES.push({ t: a, t1: b, type: 'spin', y0, y1, k });
CUES.push({ t: B(6), type: 'cut', kind: 'glide' }, { t: B(22), type: 'cut', kind: 'hard' }, { t: B(29), type: 'cut', kind: 'hard' }, { t: B(31), type: 'cut', kind: 'rise' });

export const DATA = {
  DUR, SHEET, PHASES, camera, furniture, riverLabels, annotations, overlay, trains, highlight, veil, stationDim,
  drops, dropRing, labelOnly, regLabel, labelFade,
  roundelPos: { '1': [1.0, 11.0], '2': [7.3, 3.45], '3': [9.9, 10.45], 'R': [4.7, 13.25] },
  roundelAlpha: (t, id) => 1 - .5 * veil(t),
  roundelScale: z => clamp(Math.pow(.9 / z, .55), 1, 1.8),
  LABEL_PREF: { BY: 's', CZW: 'nw', FMJ: 'e', XJ: 'nw', JBN: 'n', XY: 'ne', HL: 'sw', SD: 'e', NM: 'e', DYF: 'n', JB: 'n', SZ: 'ne' },
  cues: CUES,
  init(h) {
    H = h; initCam();
    // the felt-tip glide under every drawing tip: speed (G/s) and screen pan sampled every 20 ms, for mix.py
    h.PH.forEach((o, i) => {
      const sp = [], pan = [];
      for (let t = o.t0; t <= o.t1 + 1e-6; t += .02) {
        const a = phaseTip(i, t - .01), b = phaseTip(i, t + .01); sp.push(+(Math.hypot(b[0] - a[0], b[1] - a[1]) / .02 / 100).toFixed(2));
        const q = h.toScreen(h.basis(camera(t)), ...phaseTip(i, t)); pan.push(q ? +clamp((q[0] - 960) / 960, -1, 1).toFixed(2) : 0);
      }
      CUES.push({ t: o.t0, t1: o.t1, type: 'pen', line: o.path.line, sp, pan });
    });
  },
};
