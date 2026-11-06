// 《后退的冰川》 Columbia Glacier, 1986–2026, on public-domain Landsat imagery. Satellite-briefing style.
// render(t) is a pure function of t: camera from keyframes, plates and scans from timeline.js,
// every mark through the one camera (engine.project).
import { clamp, lerp, seg, ss, eio, eo, ei, back, hash, vnoise } from '/core/lib.js';
import { Engine, makeCamera, project, unproject, kmPerPx } from './engine.js';
import { C, text, hair, pathLL, brackets, cross, readout, beginTexts, endTexts } from './overlay.js';
import { T, RINGS, BEAT } from './timeline.js';

const W = 1920, H = 1080;
const gl = new Engine(document.getElementById('gl'));
const cv = document.getElementById('ov'), ctx = cv.getContext('2d');
const load = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('image ' + src)); i.src = src; });
let V, BOX;
const YEARS = RINGS.map(r => r.year);
const SENSOR = { 1986: 'LANDSAT 5 TM', 2005: 'LANDSAT 5 TM', 2010: 'LANDSAT 5 TM', 2015: 'LANDSAT 8 OLI', 2020: 'LANDSAT 8 OLI', 2026: 'LANDSAT 8 OLI' };

// ------------------------------------------------------------------ places
const pt = k => V.points[k];               // [lon, lat]
let FLOW, CUM, KM;
function flowAt(km) {                      // point on the flowline at distance km from the 1986 front
  let i = 1; while (i < CUM.length - 1 && CUM[i] < km) i++;
  const u = clamp((km - CUM[i - 1]) / Math.max(1e-9, CUM[i] - CUM[i - 1]));
  return [lerp(FLOW[i - 1][0], FLOW[i][0], u), lerp(FLOW[i - 1][1], FLOW[i][1], u)];
}
function flowUpTo(km) { const out = []; for (let i = 0; i < FLOW.length && CUM[i] < km; i++) out.push(FLOW[i]); out.push(flowAt(km)); return out; }

// ------------------------------------------------------------------ camera
const LINE = { t0: T.range0, t1: T.rangeEnd };
const lineU = t => { const u = seg(t, LINE.t0, LINE.t1); return 0.5 * eio(u) + 0.5 * ss(u); };
let KEYS;
function camKeys() {
  const c = pt('centre'), A = pt('f1986'), B = pt('f2026');
  const mid = flowAt(KM * 0.5);
  const G = [B[0] - 0.012, B[1] + 0.035];   // today's glacier: the front and the ice above it
  return [
    { t: 0, ll: [-147.02, 60.86], d: 185, tilt: 38, hd: 9, sx: 0, sy: 60 },
    { t: T.dive0, ll: [-147.02, 60.88], d: 172, tilt: 37, hd: 8.5, sx: 0, sy: 60, e: 'lin' },
    { t: T.lock, ll: c, d: 51.5, tilt: 0, hd: 0, sx: -150, sy: 0, e: 'dive' },
    { t: T.y1986, ll: c, d: 50.3, tilt: 0, hd: -0.3, sx: -150, sy: 0, e: 'lin' },
    { t: T.y2026, ll: c, d: 47.2, tilt: 0, hd: -2.0, sx: -150, sy: 0, e: 'acc' },            // the creep speeds up with the rings...
    { t: T.y2026 + 0.45, ll: c, d: 46.9, tilt: 0, hd: -2.06, sx: -150, sy: 0, e: 'o' },       // ...and brakes with the last one
    { t: T.range0, ll: A, d: 34, tilt: 0, hd: -2.3, sx: -150, sy: 230, e: 'io' },             // push in on the marked 1986 front: it sits on the lower third
    { t: T.rangeEnd, ll: B, d: 30, tilt: 0, hd: 6, sx: -300, sy: -210, e: 'track' },          // push in and chase the tip (tip high in frame, the line trailing)
    { t: T.sil0, ll: mid, d: 57, tilt: 0, hd: 6, sx: -260, sy: 30, e: 'io' },                 // pull back: the whole distance
    { t: T.turn, ll: mid, d: 55.5, tilt: 0, hd: 5.5, sx: -260, sy: 30, e: 'lin' },            // the held breath: barely moving
    { t: T.frame + 0.6, ll: G, d: 31, tilt: 0, hd: 2, sx: 300, sy: 20, e: 'io' },              // slow push to today's ice as colour comes back
    { t: T.coda, ll: G, d: 29.6, tilt: 0, hd: 1.5, sx: 300, sy: 20, e: 'lin' },
    { t: T.dur, ll: G, d: 39, tilt: 0, hd: 0.4, sx: 300, sy: 20, e: 'in' },                   // on the last low hit the climb back begins
  ];
}
const EASE = { io: eio, o: eo, in: t => t * t * (1.6 - 0.6 * t), lin: t => t, track: t => t, acc: t => 0.4 * t + 0.6 * Math.pow(t, 2.6), dive: t => ss(Math.pow(t, 0.8)) };
function camAt(t) {
  let i = 0; while (i < KEYS.length - 2 && t > KEYS[i + 1].t) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const u = (EASE[b.e] || eio)(seg(t, a.t, b.t));
  const d = Math.exp(lerp(Math.log(a.d), Math.log(b.d), u));
  const k = Math.abs(Math.log(b.d / a.d)) > 1.0 ? clamp((1 / d - 1 / a.d) / (1 / b.d - 1 / a.d)) : u;   // the ground does not skate in a big zoom
  let lon = lerp(a.ll[0], b.ll[0], k), lat = lerp(a.ll[1], b.ll[1], k);
  if (b.e === 'track') {
    const kp = eio(seg(t, a.t, a.t + 0.75)), p = flowAt(KM * lineU(t));
    return { lon: lerp(a.ll[0], p[0], kp), lat: lerp(a.ll[1], p[1], kp), d: Math.exp(lerp(Math.log(a.d), Math.log(b.d), kp)), tilt: 0,
      heading: lerp(a.hd, b.hd, kp), sx: lerp(a.sx, b.sx, kp), sy: lerp(a.sy, b.sy, kp), fov: 30 };
  }
  return { lon, lat, d, tilt: lerp(a.tilt, b.tilt, u), heading: lerp(a.hd, b.hd, u), sx: lerp(a.sx, b.sx, u), sy: lerp(a.sy, b.sy, u), fov: 30 };
}

// ------------------------------------------------------------------ time on the ground
function scanSpan(cam) {   // latitudes of the frame's top and bottom edge (for scans that cross the whole frame)
  const top = unproject(cam, W / 2 + cam.sx, -60), bot = unproject(cam, W / 2 + cam.sx, H + 60);
  return [top ? top[0] : 61.6, bot ? bot[0] : 60.9];
}
function plateState(t, cam) {
  if (t < T.y1986) return { A: 'd2026', B: 'd2026', scan: -90, glow: 0, yr: 2026 };
  const [n, s] = scanSpan(cam);
  for (let i = 1; i < RINGS.length; i++) {
    const r = RINGS[i], t0 = r.t - r.sweep;
    if (t < t0) return { A: 'd' + RINGS[i - 1].year, B: 'd' + RINGS[i - 1].year, scan: -90, glow: 0, yr: RINGS[i - 1].year };
    if (t < r.t) { const u = seg(t, t0, r.t); return { A: 'd' + RINGS[i - 1].year, B: 'd' + r.year, scan: lerp(n, s, u), glow: 1, yr: RINGS[i - 1].year, next: r.year }; }
  }
  return { A: 'd2026', B: 'd2026', scan: -90, glow: 0, yr: 2026 };
}
// the photograph under the map is 1986: between the map's print and the first ring the plate is 1986
function plateFor(t, cam) {
  const p = plateState(t, cam);
  if (t >= T.mapOn && t < T.y1986) {
    if (t < PRINT.t0) return p;                                                     // before the print starts: still 2026
    if (t >= PRINT.t1) return { A: 'd1986', B: 'd1986', scan: -90, glow: 0, yr: 1986 };   // printed (and then torn off): 1986 underneath
    const ms = mapState(t, cam);
    // while printing: 1986 swaps in only north of the print head, under the paper (the shader's soft swap is +-40 px)
    return { A: 'd2026', B: 'd1986', scan: ms.print + 46 * kmPerPx(cam) / 111.2, glow: 0, yr: 2026 };
  }
  return p;
}
function ringScan(y, t, cam) {   // the ring prints behind the scan: visible north of the returned latitude
  const r = RINGS.find(r => r.year === y);
  if (y === 1986) return t < T.y1986 ? null : -90;
  if (t < r.t - r.sweep) return null;
  if (t >= r.t) return -90;
  const [n, s] = scanSpan(cam); return lerp(n, s, seg(t, r.t - r.sweep, r.t));
}

// ------------------------------------------------------------------ map (the claim)
const PRINT = { t0: T.mapOn, t1: T.mapOn + 0.62 };
const TEAR = { t0: T.tear, t1: T.y1986 - 0.06 };
function mapState(t, cam) {
  if (t < PRINT.t0 || t >= TEAR.t1) return { map: 0, print: 90, tear: -90 };
  const [n, s] = scanSpan(cam);
  const print = t < PRINT.t1 ? lerp(n, s, ss(seg(t, PRINT.t0, PRINT.t1))) : -90;
  const tear = t < TEAR.t0 ? -90 : lerp(s, n, ei(seg(t, TEAR.t0, TEAR.t1)) * 0.4 + seg(t, TEAR.t0, TEAR.t1) * 0.6);
  return { map: 1, print, tear };
}

// ------------------------------------------------------------------ loading
async function init() {
  V = await fetch('assets/vectors.json').then(r => r.json());
  FLOW = V.flow; CUM = V.cum; KM = V.km;
  BOX = { det: V.det, ctx: V.ctx, bmng: V.bmng };
  const names = ['bmng', 'ctx', ...YEARS.map(y => 'd' + y), 'd2026c'];
  const imgs = await Promise.all(names.map(n => load(`assets/${n}.jpg`)));
  names.forEach((n, i) => gl.upload(n, imgs[i]));
  const [mf, ic] = await Promise.all([load('assets/mapfield.png'), load('assets/ice26.png')]);
  gl.upload('mapfield', mf); gl.upload('ice26', ic, false);
  KEYS = camKeys();
  await Promise.all(['300 124px BC', '500 26px PM', '400 22px PM', '500 32px SC', '400 24px SC', '600 64px SS'].map(f => document.fonts.load(f, '哥伦比亚冰川1986')));
  window.EV = events();
  window.READY = true;
}

// ------------------------------------------------------------------ render
const BEAT_T = n => n * BEAT;
function render(t) {
  t = clamp(t, 0, T.dur - 1e-4);
  beginTexts();
  const cp = camAt(t);
  const cam = makeCamera(cp, W, H);
  const ps = plateFor(t, cam);
  const ms = mapState(t, cam);
  const iu = seg(t, T.turn, T.turn + 1.5);                       // colour climbs the trunk from the front, 1.5 s
  const iceU = t < T.turn ? -1 : 0.03 + 1.05 * (0.55 * eo(iu) + 0.45 * iu);
  const corr = ss(seg(t, T.markA - 0.4, T.markA + 0.4)) * (1 - ss(seg(t, T.turn, T.turn + 1.0)));
  const clean = ps.A === 'd2026' && ps.B === 'd2026' && corr > 0;   // the cleaned 2026 plate blends in while the corridor is measured
  gl.draw({
    cam, box: BOX, A: ps.A, B: clean ? 'd2026c' : ps.B, scan: clean ? 90 : ps.scan, glow: ps.glow,
    a2: clamp((Math.log(260) - Math.log(cam.alt)) / Math.log(2.6)),
    grey: ss(seg(t, T.dive0 + 0.15, T.lock - 0.1)),
    ice: iceU, iceLift: ss(seg(t, T.turn, T.turn + 0.6)), other: 0.72 * ss(seg(t, T.turn - 0.2, T.turn + 0.8)),
    detail: 0.8 + 0.5 * ss(seg(Math.log(cam.alt), Math.log(120), Math.log(30))),
    clarity: 0.35 + 0.45 * ss(seg(Math.log(cam.alt), Math.log(120), Math.log(30))),
    contrast: 1.0 + 0.1 * ss(seg(t, T.y1986, T.y2026)),
    paint: t < T.dive0 ? lerp(210, H + 120, eo(seg(t, 0, T.dive0))) : 4000,
    map: ms.map, print: ms.print, tear: ms.tear,
    corr, denoise: corr, corrClar: 0.55 * corr, blend: clean ? corr : 0,
    haze: 1 - ss(seg(t, T.dive0 + 0.3, T.lock - 0.2)),
  });

  ctx.clearRect(0, 0, W, H);
  drawBands(t, cam);
  drawRings(t, cam);
  drawMapNames(t, cam, ms);
  drawRange(t, cam);
  drawReticle(t, cam);
  drawHud(t, cam, ps);
  drawReading(t);
  drawCard(t, cam);
  return endTexts();
}

// ------------------------------------------------------------------ rings and the lost bands
const lc = document.createElement('canvas'); lc.width = W; lc.height = H; const lx = lc.getContext('2d');
function bandPath(c, cam, yPrev, yNew) {
  const a = V.fronts[yPrev], b = V.fronts[yNew].slice().reverse();
  c.beginPath(); pathLL(c, cam, a); pathLL(c, cam, b, { first: false }); c.closePath();
}
function drawBands(t, cam) {
  if (t < T.y2005 - 0.1) return;
  const fadeAll = 1 - 0.75 * ss(seg(t, T.turn - 0.3, T.turn + 0.8));
  for (let i = 1; i < RINGS.length; i++) {
    const r = RINGS[i], ag = t - r.t;
    if (ag < 0) continue;
    const a = (0.5 * Math.exp(-ag * 3.0) + 0.09 * (1 - ss(seg(t, T.markA - 0.3, T.markA + 0.3)))) * fadeAll;
    lx.clearRect(0, 0, W, H); lx.fillStyle = '#fff'; bandPath(lx, cam, String(RINGS[i - 1].year), String(r.year)); lx.fill();
    ctx.save(); ctx.globalAlpha = a; ctx.drawImage(lc, 0, 0); ctx.restore();
  }
}
// year labels: which end of each front, and which side
const LAB = { 1986: { end: 0, dx: -22, dy: 8, al: 'right' }, 2005: { end: 1, dx: 22, dy: 10, al: 'left' }, 2010: { end: 0, dx: -22, dy: 10, al: 'right' },
  2015: { end: 1, dx: 22, dy: 22, al: 'left' }, 2020: { end: 1, dx: 22, dy: 16, al: 'left' }, 2026: { end: 0, dx: -20, dy: -10, al: 'right' } };
function drawRings(t, cam) {
  if (t < T.y1986) return;
  const printed = YEARS.filter(y => ringScan(y, t, cam) !== null);
  const newest = printed[printed.length - 1];
  const glob = 1 - 0.55 * ss(seg(t, T.markA - 0.3, T.markA + 0.4)) * (1 - ss(seg(t, T.rangeEnd, T.sil0))) - 0.35 * ss(seg(t, T.frame - 0.3, T.frame + 0.5));
  for (const y of printed) {
    const sl = ringScan(y, t, cam), r = RINGS.find(r => r.year === y), age = t - r.t;
    const isNew = y === newest;
    const flash = (age >= 0 ? Math.exp(-age * 5) : 0) + (y === 2026 && t >= T.coda ? 0.8 * Math.exp(-(t - T.coda) * 3) : 0);
    const breathe = y === 2026 && t > T.sil0 && t < T.turn ? 0.4 * (0.5 - 0.5 * Math.cos((t - T.sil0) * Math.PI * 2 / (BEAT * 2))) : 0;
    const a = (isNew ? 1 : 0.8) * glob;
    hair(ctx, () => pathLL(ctx, cam, V.fronts[y], { keep: (lo, la) => la > sl }),
      { w: (isNew ? 2.6 : 1.7) + 2.4 * flash + 1.2 * breathe, alpha: a, haloCol: 'rgba(3,6,8,.62)', halo: 3.6, cap: 'round' });
    // the label prints when the ring lands
    if (age >= 0) {
      const L = LAB[y], f = V.fronts[y], p = f[L.end ? f.length - 1 : 0];
      const [x, yy] = project(cam, p[1], p[0]);
      if (y === 2026 && t < T.turn) continue;           // the HUD carries 2026 while the ring lands; the tag comes with the reading
      const la = (isNew ? 1 : 0.9) * (1 - 0.35 * ss(seg(t, T.frame - 0.3, T.frame + 0.5))) * ss(seg(y === 2026 ? t - T.turn : age, y === 2026 ? 0.4 : 0, y === 2026 ? 0.6 : 0.12)) * (1 - ss(seg(t, T.range0, T.range0 + 0.4)) * (y === 1986 || y === 2026 ? 0 : 1));
      hair(ctx, () => { ctx.moveTo(x, yy); ctx.lineTo(x + L.dx * 0.7, yy + L.dy * 0.4); }, { w: 1.2, alpha: la * 0.8, halo: 2 });
      text(ctx, String(y), x + L.dx, yy + L.dy + 9, { font: `500 ${isNew ? 28 : 26}px PM`, align: L.al, alpha: la, halo: 8, id: 'ring-' + y });
    }
  }
}

// ------------------------------------------------------------------ the map's lettering: it outlives the page
function drawMapNames(t, cam, ms) {
  if (t < T.mapOn + 0.3 || t > T.range0 + 0.2) return;
  const p = pt('tongue');
  const [x, y] = project(cam, p[1], p[0]);
  const over = t >= TEAR.t0 + 0.1;                         // once the page is gone: pale ink with a dark halo
  const a = ss(seg(t, T.mapOn + 0.3, T.mapName)) * (1 - ss(seg(t, T.markA - 0.1, T.range0)));
  const col = over ? C.mapPale : C.mapInk;
  text(ctx, '冰 川', x, y, { font: '600 66px SS', col, align: 'center', track: 10, alpha: a, halo: over ? 12 : 0, id: 'map-name' });
  text(ctx, '哥伦比亚冰川 · 地图', x, y + 46, { font: '500 26px SC', col, align: 'center', track: 1, alpha: a, halo: over ? 7 : 0, id: 'map-sub' });
  // over the open water, a dashed reminder of where the map's ice edge was (it stays only until the rings start)
}

// ------------------------------------------------------------------ the range line
const tick5 = [5, 10, 15, 20];
function drawRange(t, cam) {
  if (t < T.markA - 0.05 || t > T.frame) return;
  const fade = 1 - ss(seg(t, T.frame - 0.6, T.frame - 0.1));
  const A = pt('f1986'), B = pt('f2026');
  // A: the 1986 front, bracketed
  const [ax, ay] = project(cam, A[1], A[0]);
  const ua = back(seg(t, T.markA - 0.18, T.markA + 0.12), 2.2);
  const ra = lerp(90, 34, ua);
  brackets(ctx, ax - ra, ay - ra, ax + ra, ay + ra, { len: 12, alpha: ss(seg(t, T.markA - 0.18, T.markA)) * fade });
  text(ctx, '前缘', ax + 50, ay + 12, { font: '500 30px SC', align: 'left', alpha: ss(seg(t, T.markA, T.markA + 0.15)) * fade * (1 - 0.4 * ss(seg(t, T.sil0, T.turn))), id: 'lab-a' });
  if (t < T.range0) return;
  const u = lineU(t), km = KM * u;
  const line = flowUpTo(km);
  hair(ctx, () => pathLL(ctx, cam, line), { w: 3.2, alpha: fade, halo: 4, haloCol: 'rgba(3,6,8,.66)', cap: 'round' });
  // ticks: every km, longer every 5 km with a number
  const kpp = kmPerPx(cam);
  for (let k = 1; k <= Math.floor(km); k++) {
    const p0 = flowAt(k), p1 = flowAt(Math.min(KM, k + 0.05)), p_ = flowAt(Math.max(0, k - 0.05));
    const [x0, y0] = project(cam, p0[1], p0[0]), [x1, y1] = project(cam, p1[1], p1[0]), [x2, y2] = project(cam, p_[1], p_[0]);
    let nx = -(y1 - y2), ny = x1 - x2; const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    const big = tick5.includes(k), L = big ? 16 : 8;
    hair(ctx, () => { ctx.moveTo(x0 - nx * L, y0 - ny * L); ctx.lineTo(x0 + nx * L, y0 + ny * L); }, { w: big ? 2 : 1.4, alpha: fade, halo: 2.4 });
    if (big) text(ctx, String(k), x0 + nx * 34, y0 + ny * 34 + 8, { font: '500 24px PM', align: 'center', alpha: fade * 0.95 * (1 - ss(seg(t, T.sil0, T.turn))), halo: 8 });
  }
  // tip reticle with the distance rolling beside it
  if (t < T.rangeEnd) {
    const [tx, ty] = project(cam, line[line.length - 1][1], line[line.length - 1][0]);
    ctx.save(); ctx.globalAlpha = fade; ctx.strokeStyle = C.ink; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(tx, ty, 14, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    cross(ctx, tx, ty, 26, { gap: 16, alpha: fade });
    text(ctx, km.toFixed(1) + ' km', tx + 36, ty - 18, { font: '500 26px PM', alpha: fade, halo: 8 });
  }
  // B: the 2026 front, bracketed when the line arrives
  if (t >= T.rangeEnd - 0.2) {
    const [bx, by] = project(cam, B[1], B[0]);
    const ub = back(seg(t, T.rangeEnd - 0.2, T.rangeEnd + 0.1), 2.2), rb = lerp(90, 34, ub);
    brackets(ctx, bx - rb, by - rb, bx + rb, by + rb, { len: 12, alpha: ss(seg(t, T.rangeEnd - 0.2, T.rangeEnd)) * fade });
    text(ctx, '2026 前缘', bx - 48, by - 48, { font: '500 30px SC', align: 'right', alpha: ss(seg(t, T.rangeEnd, T.rangeEnd + 0.15)) * fade * (1 - ss(seg(t, T.turn, T.turn + 0.35))), id: 'lab-b' });
  }
}

// ------------------------------------------------------------------ the reading (right third)
function drawReading(t) {
  if (t < T.range0 - 0.1 || t > T.frame) return;
  const a = ss(seg(t, T.range0 - 0.1, T.range0 + 0.2)) * (1 - ss(seg(t, T.frame - 0.5, T.frame - 0.125)));   // gone before the frame closes
  const km = KM * lineU(t);
  const landed = t >= T.rangeEnd;
  const pop = landed ? 1 + 0.09 * Math.exp(-(t - T.rangeEnd) * 9) * Math.cos((t - T.rangeEnd) * 30) : 1;
  readout(ctx, 1300, 560, { label: '后退距离', value: (landed ? KM : km).toFixed(1), unit: '公里', note: 'Landsat 实测 · 沿主流线 1986→2026', alpha: a, dim: landed ? 1 : 0.62, pop, rep: KM.toFixed(1) });
}

// ------------------------------------------------------------------ the reticle: searches, locks, becomes the frame
function groundBox(cam, pts) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of pts) { const [x, y] = project(cam, p[1], p[0]); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}
const FRAME = [96, 196, 1824, 952];       // the end card's frame (screen)
function drawReticle(t, cam) {
  if (t < T.dive0 - 0.1) return;
  const fronts = YEARS.flatMap(y => [V.fronts[y][0], V.fronts[y][V.fronts[y].length - 1]]);
  let [gx0, gy0, gx1, gy1] = groundBox(cam, fronts);
  const m = 40; gx0 -= m; gy0 -= m; gx1 += m; gy1 += m;
  let box, alpha = 1, join = 0;
  if (t < T.lock) {
    // searching: a small reticle hunting around the target, converging as we fall
    const u = seg(t, T.dive0, T.lock);
    const [cx, cy] = project(cam, pt('centre')[1], pt('centre')[0]);
    const j = (1 - u) * 90;
    const sx = cx + (vnoise(t * 3.1) - 0.5) * 2 * j, sy = cy + (vnoise(t * 2.7 + 9) - 0.5) * 2 * j;
    const r = lerp(70, 120, u);
    box = [sx - r, sy - r * 0.8, sx + r, sy + r * 0.8]; alpha = ss(seg(t, T.dive0 - 0.1, T.dive0 + 0.2));
    cross(ctx, sx, sy, 18, { alpha: alpha * 0.9 });
  } else {
    const k = back(seg(t, T.lock, T.lock + 0.32), 2.4);   // snaps with overshoot onto the corridor
    const [cx, cy] = [(gx0 + gx1) / 2, (gy0 + gy1) / 2];
    const s = lerp(0.62, 1, k);
    box = [cx - (gx1 - gx0) / 2 * s, cy - (gy1 - gy0) / 2 * s, cx + (gx1 - gx0) / 2 * s, cy + (gy1 - gy0) / 2 * s];
    alpha = 1 - 0.45 * ss(seg(t, T.lock + 0.6, T.mapOn + 0.3)) - 0.4 * ss(seg(t, T.markA - 0.4, T.markA));
    if (t > T.turn - 0.2) {
      // the brackets leave the corridor and close into the frame
      const fu = back(seg(t, T.frame - 0.38, T.frame), 1.6);
      const ice = groundBox(cam, [pt('f2026'), [pt('f2026')[0] - 0.05, pt('f2026')[1] + 0.12], [pt('f2026')[0] + 0.05, pt('f2026')[1] + 0.02]]);
      const pre = ss(seg(t, T.turn - 0.2, T.turn + 0.6));
      const mid_ = [lerp(box[0], ice[0] - 30, pre), lerp(box[1], ice[1] - 30, pre), lerp(box[2], ice[2] + 30, pre), lerp(box[3], ice[3] + 30, pre)];
      const kick = t >= T.coda ? 18 * Math.exp(-(t - T.coda) * 3.2) : 0;     // on the last low hit the frame draws in once
      box = mid_.map((v, i) => lerp(v, FRAME[i], fu) + (i < 2 ? kick : -kick));
      alpha = lerp(alpha, 1, pre);
      join = 0.5 * ss(seg(t, T.frame, T.title + 0.2));      // the corners grow towards each other: a frame
    }
  }
  brackets(ctx, box[0], box[1], box[2], box[3], { len: 34, w: 2, alpha, join });
}

// ------------------------------------------------------------------ instruments (screen space)
function niceBar(kpp) { const want = 260 * kpp; for (const k of [1, 2, 5, 10, 20, 50]) if (k >= want * 0.6) return k; return 50; }
function drawHud(t, cam, ps) {
  const a = ss(seg(t, 0.0, 0.4));
  const ah = a * (1 - ss(seg(t, T.frame - 0.5, T.frame - 0.125)));
  // date of the scene on screen (a counter: it reports where it lands)
  let date = V.dates[String(ps.yr)], sen = SENSOR[ps.yr];
  if (t < T.mapOn) { date = '2026-08-27'; sen = 'LANDSAT 8 OLI'; }
  const big = t >= T.y1986 && t < T.markA;
  text(ctx, date, 72, 96, { font: `500 ${big ? 34 : 28}px PM`, alpha: ah, halo: 8 });
  text(ctx, sen, 72, 130, { font: '400 22px PM', alpha: ah * 0.85, halo: 6 });
  text(ctx, '视高 ' + Math.round(cam.alt) + ' km', 72, 164, { font: '400 22px PM', col: 'rgba(242,245,246,.8)', alpha: ah, halo: 6 });
  // coordinates of the frame centre
  const c = unproject(cam, W / 2 + cam.sx, H / 2 + cam.sy);
  if (c) text(ctx, `${c[0].toFixed(2)}°N  ${(-c[1]).toFixed(2)}°W`, W - 72, 96, { font: '400 22px PM', align: 'right', alpha: ah * 0.9, halo: 6 });
  // scale bar from the same camera
  const kpp = kmPerPx(cam), k = niceBar(kpp), px = k / kpp;
  const sa = a * (1 - ss(seg(t, T.frame - 0.5, T.frame - 0.125)));
  hair(ctx, () => { ctx.moveTo(72, 1000); ctx.lineTo(72 + px, 1000); ctx.moveTo(72, 990); ctx.lineTo(72, 1010); ctx.moveTo(72 + px, 990); ctx.lineTo(72 + px, 1010); }, { w: 2, alpha: sa });
  text(ctx, k + ' km', 72, 980, { font: '400 22px PM', alpha: sa, halo: 6 });
  text(ctx, '影像：USGS Landsat 5/8 · NASA Blue Marble', W - 72, 1010, { font: '400 22px SC', align: 'right', col: 'rgba(242,245,246,.78)', alpha: a, halo: 5 });
}

// ------------------------------------------------------------------ the end card, inside the frame
function drawCard(t, cam) {
  if (t < T.frame) return;
  // the plate wipes in from the frame's left edge as the brackets close (no cross-fade over the reading: it has gone)
  const wu = eo(seg(t, T.frame, T.title + 0.1)), x = 170, y = 420, X1 = FRAME[0] + 2 + (900 - FRAME[0]) * wu;
  ctx.save(); ctx.globalAlpha = ss(seg(t, T.frame, T.frame + 0.12));
  const g = ctx.createLinearGradient(FRAME[0], 0, Math.max(X1, FRAME[0] + 1), 0);
  g.addColorStop(0, 'rgba(4,7,10,.72)'); g.addColorStop(0.7, 'rgba(4,7,10,.5)'); g.addColorStop(1, 'rgba(4,7,10,0)');
  ctx.fillStyle = g; ctx.fillRect(FRAME[0] + 2, FRAME[1] + 2, X1 - FRAME[0] - 2, FRAME[3] - FRAME[1] - 4); ctx.restore();
  const line = (t0, t1) => { const u = seg(t, t0, t1); return [ss(u), 22 * (1 - eo(u))]; };
  const [a1, o1] = line(T.frame + 0.02, T.frame + 0.3), [a2, o2] = line(T.frame + 0.12, T.frame + 0.38);
  text(ctx, '哥伦比亚冰川', x - o1, y, { font: '600 76px SS', track: 6, alpha: a1, halo: 12, id: 'card-title' });
  text(ctx, '阿拉斯加', x + 4 - o2, y + 62, { font: '500 32px SC', track: 3, alpha: a2 * 0.95, halo: 8, id: 'card-place' });
  hair(ctx, () => { ctx.moveTo(x + 4, y + 104); ctx.lineTo(x + 4 + 420 * eo(seg(t, T.frame + 0.15, T.title)), y + 104); }, { w: 1.2, alpha: 0.8 * a1, halo: 0 });
  const [a3, o3] = line(T.title - 0.22, T.title);
  text(ctx, '1986 → 2026', x + 4 - o3, y + 160, { font: '500 30px PM', alpha: a3, halo: 8, id: 'card-years' });
  // the reading lands in the card on the title beat, with the same small pop as the range line's landing
  const b = ss(seg(t, T.title - 0.1, T.title)), pop = t >= T.title ? 1 + 0.08 * Math.exp(-(t - T.title) * 9) * Math.cos((t - T.title) * 30) : 1;
  const w = text(ctx, '后退 ', x + 4, y + 232, { font: '500 40px SC', col: C.amber, alpha: b, halo: 10, id: 'card-r1' });
  const w2 = text(ctx, KM.toFixed(1), x + 4 + w, y + 232, { font: '400 64px BC', col: C.amber, alpha: b, halo: 12, id: 'card-r2', scale: pop });
  text(ctx, ' 公里', x + 4 + w + w2 * pop, y + 232, { font: '500 40px SC', col: C.amber, alpha: b, halo: 10, id: 'card-r3' });
}

// ------------------------------------------------------------------ sound and cue events (for mix.py and cuecheck)
function events() {
  const E = [];
  const ev = (t, type, o = {}) => E.push({ t: +t.toFixed(4), type, ...o });
  ev(T.scanIn, 'scan_in'); ev(T.dive0, 'dive'); ev(T.lock, 'lock');
  ev(T.mapOn, 'map_print'); ev(T.mapName, 'map_name'); ev(T.tear, 'tear');
  RINGS.forEach((r, i) => { ev(r.t, r.year === 2026 ? 'stop' : 'ring', { year: r.year, i, sweep: r.sweep }); if (r.sweep) ev(r.t - r.sweep, 'scan', { d: r.sweep, year: r.year }); });
  // ticks on the grid that divide to accelerate: quarters, eighths, sixteenths
  for (let t = T.lock + BEAT; t < T.y2005 - 1e-6; t += BEAT) ev(t, 'tick', { v: t < T.y1986 ? 0.4 : 0.6 });
  for (let t = T.y2005; t < T.y2015 - 1e-6; t += BEAT / 2) ev(t, 'tick', { v: 0.75 });
  for (let t = T.y2015; t < T.y2026 - 1e-6; t += BEAT / 4) ev(t, 'tick', { v: 0.9 });
  ev(T.markA, 'mark'); ev(T.range0, 'range');
  // ratchet: one tooth per km as the tip passes it (times from the same easing as the line)
  for (let k = 1; k < Math.floor(KM) + 1; k++) {
    let lo = T.range0, hi = T.rangeEnd;
    for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (KM * lineU(mid) < k) lo = mid; else hi = mid; }
    ev(hi, 'ratchet', { k, big: tick5.includes(k) ? 1 : 0 });
  }
  ev(T.rangeEnd, 'range_end'); ev(T.rangeEnd, 'pull'); ev(T.sil0, 'silence');
  ev(T.turn, 'turn'); ev(T.frame, 'frame'); ev(T.title, 'title'); ev(T.coda, 'coda');
  return E.sort((a, b) => a.t - b.t);
}

window.DUR = T.dur;
window.render = render;
window.TEXTS = t => render(t);
init().catch(e => { console.error(e); throw e; });
