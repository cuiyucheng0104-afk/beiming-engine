// 涨潮一米 — Treasure Island, San Francisco Bay, as a 1:2000 white model. render(t) is a pure function of t:
// camera from keys, projection state from timeline.js, every number from data/stats.json (tools/prep.py).
import * as THREE from 'three';
import { clamp, lerp, seg, ss, eio, eo, track, monotone } from '/core/lib.js';
import { makeStudio, PAL, S } from './studio.js';
import { makeOverlay, W, H, font } from './overlay.js';
import { T, BEAT, b, CLOCK, LEVEL, TICKS, PICK_GRID } from './timeline.js';

const DUR = T.dur; window.DUR = DUR;
const QS = new URLSearchParams(location.search);
const get = (u, kind) => fetch(u).then(r => { if (!r.ok) throw new Error(u); return kind === 'bin' ? r.arrayBuffer() : r.json(); });
const [M, ST, TB, KB] = await Promise.all([get('data/model.json'), get('data/stats.json'), get('data/terrain.bin', 'bin'), get('data/key.bin', 'bin')]);
const TERR = new Float32Array(TB), KEY = new Float32Array(KB);

// ------------------------------------------------------------------ the level (fill key) and when the water reaches each building
const levelAt = monotone(LEVEL);
const level = t => t < T.sunset ? 0 : t > T.top ? 1 : clamp(levelAt(t), 0, 1);
function timeOfLevel(k) {            // first time the level reaches k (bisection on the monotone curve)
  if (k <= 0) return T.sunset;
  let lo = T.sunset, hi = T.top;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (level(m) >= k) hi = m; else lo = m; }
  return hi;
}
const PICK = new Map();               // building index -> the grid time its pick-out flashes (and its glass note sounds)
for (const [kb, bi] of ST.flood_order) {
  const tr = timeOfLevel(kb), grid = kb >= ST.sill_m - 1e-6 ? PICK_GRID.cascade : PICK_GRID.early;
  let tq = T.sunset + Math.ceil((tr - T.sunset) / grid - 1e-6) * grid;
  if (kb <= 0) tq = T.sunset + 2 * PICK_GRID.early;     // footprints already touching today's high water
  PICK.set(bi, Math.min(tq, T.top));
}

const ST_ = makeStudio(W, H, M, KEY);
const { U, camera, post, renderer, house, sun, hemi, scene } = ST_;
ST_.build(PICK, TERR);
const OV = makeOverlay(document.getElementById('ov'));

const proj3 = (x, y, z) => { const v = new THREE.Vector3(x, y, z).project(camera); return v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2 ? [(v.x * .5 + .5) * W, (-v.y * .5 + .5) * H] : null; };
const BR = [ST.breach[0] * S, .0007, ST.breach[1] * S];

// ------------------------------------------------------------------ sun (Treasure Island, 2026-06-21, PDT)
const SUNT = ST.sun;
function sunAt(h) {
  const i = clamp(Math.floor(h * 12), 0, SUNT.length - 2), k = h * 12 - i;
  let a0 = SUNT[i][1], a1 = SUNT[i + 1][1]; if (a1 - a0 > 180) a0 += 360; if (a0 - a1 > 180) a1 += 360;
  return [lerp(a0, a1, k) % 360, lerp(SUNT[i][2], SUNT[i + 1][2], k)];
}
const NM = ST.north_in_model, EM = ST.east_in_model;
const sunVec = (az, el) => {
  const A = THREE.MathUtils.degToRad(az), E = THREE.MathUtils.degToRad(el), c = Math.cos(E);
  return new THREE.Vector3(c * (Math.sin(A) * EM[0] + Math.cos(A) * NM[0]), Math.sin(E), c * (Math.sin(A) * EM[1] + Math.cos(A) * NM[1])).normalize();
};
const clockK = k => k - CLOCK.a * Math.sin(2 * Math.PI * k) / (2 * Math.PI);     // slow at dawn and dusk, fast at noon
const clockH = t => lerp(ST.sunrise_h, ST.sunset_h, clockK(seg(t, CLOCK.t0, CLOCK.t1)));
const hhmm = h => { const m = Math.round(h * 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

// ------------------------------------------------------------------ the traced shadow (STYLE §8, the sun clock): hangar #154 at b10
// The real shadow comes from the sun's shadow map; this is the projector tracing it: the ground footprint of the hangar's
// shadow on flat ground (hull of the footprint and the footprint moved along the sun by h / tan(elevation)).
const TRB = 154;
const TRACE = (() => {
  const ring = M.p.find(p => p[0] === TRB)[1][0], [base, hgt] = M.b[TRB];
  const h = clockH(T.trace), [az, el] = sunAt(h), sv = sunVec(az, el);
  const dx = -sv.x, dz = -sv.z, dl = Math.hypot(dx, dz), ux = dx / dl, uz = dz / dl;
  const L = hgt / Math.tan(THREE.MathUtils.degToRad(el));
  const pts = ring.concat(ring.map(([x, z]) => [x + ux * L, z + uz * L]));
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cr = (o, a, c) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const lo = [], hi = [];
  for (const p of pts) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of pts.slice().reverse()) { while (hi.length > 1 && cr(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  const hull = lo.slice(0, -1).concat(hi.slice(0, -1));
  const gAt = (x, z) => { const c = clamp(Math.floor((x - M.origin[0]) / M.cell), 0, M.grid[0] - 1), r = clamp(Math.floor((z - M.origin[1]) / M.cell), 0, M.grid[1] - 1); return Math.max(TERR[r * M.grid[0] + c], 0); };
  let gy = 0; for (const [x, z] of hull) gy = Math.max(gy, gAt(x, z));
  let A = ring[0]; for (const p of ring) if (p[0] * ux + p[1] * uz > A[0] * ux + A[1] * uz) A = p;
  return { hull, L, el, az, h, ux, uz, A, B: [A[0] + ux * L, A[1] + uz * L], y: Math.max(gy, base) };
})();
const TR = (() => {
  const y = TRACE.y * S + .00022, shape = new THREE.Shape(TRACE.hull.map(([x, z]) => new THREE.Vector2(x * S, z * S)));
  const gf = new THREE.ShapeGeometry(shape); gf.rotateX(Math.PI / 2); gf.translate(0, y, 0);
  const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide };
  const fill = new THREE.Mesh(gf, new THREE.MeshBasicMaterial({ color: new THREE.Color('#5aa8ff').multiplyScalar(.55), opacity: 0, ...add }));
  const pos = [], w = 1.6;                                // edge: a 3.2 m ribbon of light along the hull, on the ground
  const n = TRACE.hull.length;
  for (let i = 0; i < n; i++) {
    const [x0, z0] = TRACE.hull[i], [x1, z1] = TRACE.hull[(i + 1) % n], l = Math.hypot(x1 - x0, z1 - z0) || 1;
    const nx = -(z1 - z0) / l * w, nz = (x1 - x0) / l * w;
    const q = [[x0 - nx, z0 - nz], [x1 - nx, z1 - nz], [x1 + nx, z1 + nz], [x0 + nx, z0 + nz]].map(([x, z]) => [x * S, y + .00002, z * S]);
    pos.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]);
  }
  const ge = new THREE.BufferGeometry(); ge.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const edge = new THREE.Mesh(ge, new THREE.MeshBasicMaterial({ color: new THREE.Color('#bfeaff').multiplyScalar(1.4), opacity: 0, ...add }));
  fill.renderOrder = edge.renderOrder = 5; scene.add(fill, edge);
  return { fill, edge };
})();

// ------------------------------------------------------------------ camera: [t, [tx, ty, tz, azimuth°, elevation°, distance]]
// azimuth 0 = camera on the +z side of the target (south-east shore of the model), 180 = on the -z side (north-west shore)
const CAM = track([
  [0.0, [0.652, .0018, -.032, 236, 13, .056]],
  [T.houseOff, [0.657, .0018, -.031, 242, 12.5, .052]],
  [T.lamp, [0.662, .0018, -.03, 248, 12, .049]],
  [b(6), [0.10, 0, .0, 262, 30, 1.2]],                 // crane up and back: the whole island, morning side light
  [b(8.5), [0.0, 0, .005, 250, 33, .9]],               // slow orbit with the sun, on its lit side, closing in
  [b(10.25), [-.075, 0, .02, 238, 36, .5]],            // in on the hangar whose evening shadow gets traced
  [T.sunset, [-.03, 0, .01, 222, 37, .56]],
  [b(13.5), [0.22, 0, -.01, 168, 31, .72]],             // the level climbs every facade: hold it wide
  [b(14.75), [0.635, .001, .015, 96, 17, .25]],        // swoop down to the low east-shore angle at the sill
  [b(17), [0.641, .001, .018, 101, 14, .215]],
  [T.top, [0.645, .001, .02, 106, 13, .19]],
  [T.hit, [0.646, .001, .02, 108, 12.5, .182]],
  [b(25), [0.585, 0, -.11, 168, 50, .64]],               // crane up over the flooded quarter
  [DUR, [0.58, 0, -.106, 174, 53, .61]],
]);
const tgt = new THREE.Vector3();
function setCamera(t) {
  const [tx, ty, tz, az, el, d] = CAM(t);
  tgt.set(tx, ty, tz);
  const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
  camera.position.set(tx + d * Math.sin(a) * Math.cos(e), ty + d * Math.sin(e), tz + d * Math.cos(a) * Math.cos(e));
  camera.updateProjectionMatrix(); camera.lookAt(tgt); camera.updateMatrixWorld();
  post.dof.focus = d; post.dof.aper = lerp(1.15, 5.0, seg(d, .05, 1.0)); post.dof.maxCoc = 14;
}

// ------------------------------------------------------------------ light state
const PREFLICK = b(3.75);
function setLight(t) {
  const off = ss(seg(t, T.houseOff, T.houseOff + .25));             // house lights cut fast (a relay)
  const houseK = lerp(1, .035, off);
  house.intensity = 1.35 * houseK; hemi.intensity = .2 * houseK + .012;
  scene.environmentIntensity = lerp(.035, .5, houseK); scene.backgroundIntensity = lerp(.42, 1, houseK);
  post.bloom.threshold = lerp(1.6, .85, off);
  post.dof.aoAmt = QS.has('noao') ? 0 : .8 * (1 - ss(seg(t, T.lamp, T.lamp + .8)));
  // projector: a pre-flash a sixteenth early, then the strike with a flicker
  const pre = t > PREFLICK && t < PREFLICK + .07 ? .35 : 0;
  const strike = seg(t, T.lamp, T.lamp + .08), flick = t > T.lamp && t < T.lamp + .3 ? .62 + .38 * Math.abs(Math.cos((t - T.lamp) * 62)) : 1;
  U.uProj.value = Math.max(pre, strike * flick);
  U.uNow.value = t;
  // the sun clock
  const h = clockH(t), [az, el] = sunAt(h), sv = sunVec(az, el);
  const sunOn = t >= T.lamp ? 1 - ss(seg(t, T.sunset - .2, T.sunset + .25)) : 0;
  sun.position.copy(sv).multiplyScalar(5); sun.target.position.set(0, 0, 0); sun.target.updateMatrixWorld();
  sun.intensity = 2.5 * sunOn * ss(seg(el, -1.5, 7)) * strike;
  sun.color.set('#fff1e2').lerp(new THREE.Color('#ffa262'), 1 - seg(el, 2, 25));
  U.uSunOn.value = sunOn;
  house.target.position.set(0, 0, 0); house.target.updateMatrixWorld();
  // the water layer: a wash from the projector axis at sunset, then the level
  U.uWaterOn.value = t >= T.sunset ? 1 : 0;
  U.uWashR.value = t < T.sunset ? -1 : lerp(0, 1.25, eo(seg(t, T.sunset, T.sunset + BEAT * 1.6)));
  U.uKey.value = level(t);
  // the stop: the projector sags; the pick-out: everything else goes dark
  U.uDim.value = t < T.top ? 1 : t < T.hit ? lerp(1, .2, ss(seg(t, T.top, T.top + .22))) : 1;
  U.uPick.value = ss(seg(t, T.hit, T.hit + .12));
  { const k = U.uPick.value;                     // the pick-out: the room falls to projector black around it
    scene.environmentIntensity *= lerp(1, .12, k); hemi.intensity *= lerp(1, .08, k); }
  // the traced shadow: a fill of light on the ground + a bright edge, from b10 until the water washes it away
  { const a = Math.min(eo(seg(t, T.trace, T.trace + .12)), 1 - ss(seg(t, T.traceOff - .75, T.traceOff)));
    const fl = Math.exp(-Math.max(t - T.trace, 0) / .18) * (t >= T.trace ? 1 : 0);
    TR.fill.material.opacity = a * (.34 + .5 * fl); TR.edge.material.opacity = a * (.9 + .1 * fl);
    TR.fill.visible = TR.edge.visible = a > .001; }
  U.uHitT.value = T.hit;
}

// ------------------------------------------------------------------ overlay
const curve = (arr, k) => { const i = clamp(k, 0, 1) * (arr.length - 1), i0 = Math.floor(i); return arr[Math.min(i0, arr.length - 1)]; };
function drawOverlay(t) {
  const { txt, readout, pin, g } = OV;
  OV.begin();
  const left = Math.max(OV.env(t, T.r1, T.sunset - .1), OV.env(t, T.r2, DUR + 1));
  OV.scrim(left);
  // identity, top-left (quiet), on a faint dark gradient so the source line never sits on the plate's edge or the water line
  const ia = OV.env(t, .25, DUR + 1, .6);
  OV.idScrim(ia);
  txt('id1', '金银岛 · 旧金山湾 · 1:2000 白模', 104, 62, 'sc5', 24, '#f2f4f6', ia, { ls: 2, shadow: 10 });
  txt('id2', `${ST.centroid_lonlat[1].toFixed(3)}°N  ${Math.abs(ST.centroid_lonlat[0]).toFixed(3)}°W  ·  DataSF · USGS 3DEP · NOAA`, 104, 94, 'mono', 18, 'rgba(232,236,240,.8)', ia, { ls: 1, shadow: 6 });

  // 01 the sun clock
  const h = clockH(t);
  readout(t, T.r1, T.sunset - .1, { id: 'r1', idx: '01', name: '太阳钟', big: hhmm(h), bigId: null, col: PAL.sun,
    labels: [['l', '夏至 · 2026 年 6 月 21 日']], note: 'NOAA 太阳位置算法',
    legend: (X, Y, a) => {
      const k = seg(t, CLOCK.t0, CLOCK.t1);
      g.save(); g.globalAlpha = a; g.fillStyle = 'rgba(255,255,255,.22)'; g.fillRect(X, Y + 1, 320, 2);
      g.fillStyle = PAL.sun; g.fillRect(X, Y, 320 * k, 4); g.beginPath(); g.arc(X + 320 * k, Y + 2, 5, 0, 7); g.fill(); g.restore();
      txt('r1a', `日出 ${hhmm(ST.sunrise_h)}`, X, Y + 32, 'sc3', 20, 'rgba(230,234,240,.8)', a);
      txt('r1b', `日落 ${hhmm(ST.sunset_h)}`, X + 320, Y + 32, 'sc3', 20, 'rgba(230,234,240,.8)', a, { right: true });
    } });

  // 02 the rising level
  const k = level(t), area = curve(ST.area_curve, k), nb = curve(ST.bld_curve, k);
  readout(t, T.r2, T.hit, { id: 'r2', idx: '02', name: '水位', big: `+${k.toFixed(2)}`, bigId: null, unit: 'm', col: PAL.flood,
    labels: [['l', '高于今天的平均大潮高潮位']], note: 'NOAA 9414290 旧金山站 · 1983–2001 基准',
    legend: (X, Y, a) => {
      g.save(); g.globalAlpha = a; g.fillStyle = PAL.flood; g.fillRect(X, Y - 6, 26, 12); g.fillStyle = PAL.pick; g.fillRect(X, Y + 30, 26, 12); g.restore();
      txt(null, `被淹陆地  ${area.toFixed(1)} 公顷`, X + 40, Y + 6, 'sc3', 22, 'rgba(236,240,244,.92)', a);
      txt(null, `进水建筑  ${nb} 栋`, X + 40, Y + 42, 'sc3', 22, 'rgba(236,240,244,.92)', a);
    } });

  // 03 the pick-out: +1 m
  const l2 = eo(seg(t, T.line2, T.line2 + .35));
  readout(t, T.hit, DUR + 1, { id: 'r3', idx: '03', name: '一米之后', big: '+1', unit: 'm', col: PAL.pick, bigPx: 150,
    labels: [['a', `${ST.flooded_buildings} 栋建筑进水`, 1], ['b', `${ST.flooded_ha.toFixed(1)} 公顷陆地被淹`, l2]],
    note: '浴缸模型 · 示意 · 不计海堤与排水',
    legend: (X, Y, a) => {
      g.save(); g.globalAlpha = a; g.fillStyle = PAL.pick; g.fillRect(X, Y, 64, 5); g.fillStyle = PAL.flood; g.fillRect(X + 72, Y, 64, 5); g.restore();
      txt('r3c', `共 ${ST.buildings} 栋 · 岛上陆地 ${Math.round(ST.land_ha)} 公顷`, X + 152, Y + 8, 'sc3', 20, 'rgba(230,234,240,.78)', a);
    } });

  // the traced shadow's measure: a line from the hangar's wall to the tip of its shadow, ticks every 10 m, grows b10 -> b10.5
  { const a = Math.min(eo(seg(t, T.trace, T.trace + .1)), 1 - ss(seg(t, T.traceOff - .3, T.traceOff)));
    const gy = TRACE.y * S + .0003, P = (x, z) => proj3(x * S, gy, z * S);
    const g_ = eo(seg(t, T.trace, T.measure)), [ax, az_] = TRACE.A, len = TRACE.L * g_;
    const pa = P(ax, az_), pb = P(ax + TRACE.ux * len, az_ + TRACE.uz * len);
    if (a > 0 && pa && pb) {
      g.save(); g.globalAlpha = a; g.lineCap = 'round';
      g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 5; g.beginPath(); g.moveTo(...pa); g.lineTo(...pb); g.stroke();
      g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.beginPath(); g.moveTo(...pa); g.lineTo(...pb); g.stroke();
      const sx = pb[0] - pa[0], sy = pb[1] - pa[1], sl = Math.hypot(sx, sy) || 1, nx = -sy / sl, ny = sx / sl;
      for (let m = 0; m <= len + 1e-6; m += 10) {
        const p = P(ax + TRACE.ux * m, az_ + TRACE.uz * m); if (!p) continue; const k = m % 50 === 0 ? 9 : 6;
        g.beginPath(); g.moveTo(p[0] - nx * k, p[1] - ny * k); g.lineTo(p[0] + nx * k, p[1] + ny * k); g.stroke();
      }
      g.fillStyle = '#ffffff'; for (const p of [pa, pb]) { g.beginPath(); g.arc(p[0], p[1], 3.5, 0, 7); g.fill(); }
      g.restore();
    }
    const mid = P(ax + TRACE.ux * TRACE.L * .5, az_ + TRACE.uz * TRACE.L * .5);
    pin(t, T.trace, T.traceOff, mid, { id: 'p_sh', text: '影长', sub: `${Math.round(TRACE.L)} m`, len: 84, dx: 70, col: '#ffffff', subCol: '#ffe2bd' });
  }

  // the breach: where the water first tops the edge
  pin(t, T.sill, DUR + 1, proj3(...BR), { id: 'p_sill', text: '从这里漫过岸线', sub: `+${ST.sill_m.toFixed(2)} m`, len: 96, dx: 150, col: '#bfeaff', subCol: '#bfeaff' });
}

// ------------------------------------------------------------------ events for the mix (window.EV) and checks
const EV = [];
const ev = (t, type, o = {}) => EV.push({ t: +t.toFixed(5), type, ...o });
ev(T.houseOff, 'relay'); ev(T.fan, 'fan'); ev(PREFLICK, 'flick'); ev(T.lamp, 'lamp'); ev(T.r1, 'readout');
for (let k = 5; k < 12; k++) ev(b(k), 'hour', { k: k - 4, el: +sunAt(clockH(b(k)))[1].toFixed(1) });
ev(T.trace, 'trace', { L: +TRACE.L.toFixed(1) }); ev(T.measure, 'measure');
ev(T.sunset, 'sunset'); ev(T.r2, 'readout');
TICKS.forEach(t0 => ev(t0, 'tick', { div: t0 < T.tick8 - 1e-6 ? 1 : t0 < T.tick16 - 1e-6 ? 2 : 4 }));
{ const slots = new Map(); for (const tq of PICK.values()) { const key = tq.toFixed(5); slots.set(key, (slots.get(key) || 0) + 1); }
  [...slots.entries()].sort((a, c) => +a[0] - +c[0]).forEach(([k0, n], i) => ev(+k0, 'pick', { n, i, cascade: +k0 >= T.sill - 1e-6 ? 1 : 0 })); }
ev(T.sill, 'sill'); ev(T.sill, 'pin'); ev(T.top, 'top'); ev(T.hit, 'hit'); ev(T.hit, 'readout'); ev(T.line2, 'land');
ev(T.crest, 'crest'); ev(T.coda, 'coda'); ev(T.end, 'end');
EV.sort((a, c) => a.t - c.t);
window.EV = EV;
window.TL = { bpm: 60 / BEAT, beat: BEAT, T, LEVEL, TICKS };
window.TRACE = TRACE;

// ------------------------------------------------------------------ render
// frames are sampled half a frame ahead, so a change on a beat shows on the nearest frame (±20.8 ms), not the next one
const LEAD = 1 / 48;
window.render = t0 => {
  const t = t0 + LEAD;
  setCamera(t); setLight(t);
  renderer.shadowMap.needsUpdate = true;
  post.composer.render();
  drawOverlay(t);
};
window.TEXTS = t => { window.render(t); return OV.texts(); };   // readcheck sees the same lead

await document.fonts.ready;
await Promise.all(['300 20px SC', '500 20px SC', '200 20px IT', '400 20px IT', '400 20px PM'].map(f => document.fonts.load(f, '金银岛0')));
window.render(QS.has('t') ? +QS.get('t') : 0);
window.READY = true;
