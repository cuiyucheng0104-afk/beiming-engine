// 早餐铺开门 — the static page: an old street at dawn, drawn in stroke order (ink A + time A) with washes in the colour layer.
// World = one sketchbook page, 5120 × 2880. The painting occupies x 140–4260; the right margin (x > 4300) stays blank for the title.
import { H as HIT } from './timeline.js';
import { rng, fbm, n2, hex, mix3, lerp, clamp, ellipse, spline, penStroke, rasterPen, wash, reserve, dab, TAU } from './engine.js';

export const W = 5120, H = 2880;
export const WIN_A = [0, 5.8], WIN_B = [100, 1];
export const GROUND = 2060, CURB = 2175, STREET = 2400;
// houses, left to right (frontal elevation)
export const HOUSES = [
  { id: 'h1', x0: 160, x1: 900, eave: 1090, ridge: 930, floor: 1500, wall: hex('#e3d4b2'), wood: hex('#a98663') },
  { id: 'h2', x0: 900, x1: 1700, eave: 1000, ridge: 820, floor: 1460, wall: hex('#d7ae72'), wood: hex('#9c7754') },
  { id: 'h3', x0: 1700, x1: 2780, eave: 1120, ridge: 960, floor: 1520, wall: hex('#ddd2bb'), wood: hex('#b38a60') },
  { id: 'shop', x0: 2780, x1: 3840, eave: 1100, ridge: 940, shop: 1 },
  { id: 'h5', x0: 3840, x1: 4250, eave: 1040, ridge: 880, floor: 1480, wall: hex('#d4ad78'), wood: hex('#a07a55') },
];
export const SHOP = { x0: 2780, x1: 3840, eave: 1100, beam: 1450,
  sign: { x0: 3010, x1: 3610, y0: 1170, y1: 1400 },
  lanterns: [{ x: 2905, y: 1262, rx: 78, ry: 92 }, { x: 3715, y: 1262, rx: 78, ry: 92 }],
  steamer: { x: 3060, top: 1560, base: 1820, w: 300 }, stove: { x0: 2880, x1: 3240, y0: 1820 },
};
export const POLES = [{ x: 600, top: 600 }, { x: 2560, top: 560 }, { x: 4120, top: 620 }];
export const NOTE = { text: '十月卅一  晨六时  晴  老街', x: 300, y: 470, size: 64 };
export const TITLE = { text: '早餐铺开门', x: 4380, y: 1345, size: 124 };
export const SUBTITLE = { text: '六点整', x: 4392, y: 1500, size: 70 };

const C = {
  sky: hex('#a7c2da'), skyDeep: hex('#8fb0cf'), dawn: hex('#f0d6ae'), cloud: hex('#c2bdd0'),
  roof: hex('#8f92aa'), roofLit: hex('#b3b4c4'), violet: hex('#5a5f82'), ground: hex('#d9cfb7'), curb: hex('#c7bba0'), street: hex('#cfc6b4'),
  pole: hex('#8a7a68'), shirt: hex('#9fb8cd'), pants: hex('#7f879a'), towel: hex('#e1c79e'),
  shopWood: hex('#c79d6c'), shopDark: hex('#7a6656'), brick: hex('#bb8c6c'), bamboo: hex('#d6b679'), board: hex('#cfa978'),
};
const shade = (c, k = .45) => mix3(c, C.violet, k);

function cv(w, h, fill) { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d', { willReadFrequently: true }); if (fill) { x.fillStyle = fill; x.fillRect(0, 0, w, h); } return [c, x]; }

// Page edges: left, right and bottom break into dabs; the top fades into the sky; the right margin is left blank
export function pageMask(x, y) {
  const n = (fbm(x * .004, y * .004, 5, 3) - .5) * 150 + (n2(x * .03, y * .03, 8) - .5) * 40;
  const dl = x - 150 + n, dr = 4250 - x + n, db = 2600 - y + n, dt = y - 300 + n * 1.4;
  return Math.min(dl, dr, db, dt);
}
export const inPage = (x, y, m = 0) => pageMask(x, y) > m;
export const houseAt = x => HOUSES.find(h => x >= h.x0 && x < h.x1);
// roof profile: the roof's top edge at x (ridge with sloped hips at both ends)
export function roofTop(x) {
  const h = houseAt(x); if (!h) return 1e9;
  const k = Math.min(x - h.x0, h.x1 - x) / 70; return lerp(h.eave - 30, h.ridge, clamp(k));
}
export const inShop = (x, y) => x >= SHOP.x0 && x < SHOP.x1 && y >= roofTop(x) - 30 && y < GROUND + 10;
export function region(x, y) {
  if (inShop(x, y)) return 'shop';
  if (y < roofTop(x) - 20) return 'sky';
  const h = houseAt(x); if (h && y < h.eave + 34) return 'roof';
  if (y < GROUND + 6) return 'wall';
  return 'ground';
}

export function buildWorld() {
  const [colorC, cx] = cv(W, H, '#fff');
  const [inkAC, ia] = cv(W, H), [timeAC, ta] = cv(W, H, '#fff'), [inkBC, ib] = cv(W, H), [timeBC, tb] = cv(W, H, '#fff');
  ta.globalCompositeOperation = 'darken'; tb.globalCompositeOperation = 'darken';
  const R = rng(4545);
  const strokes = [];                 // [t0, dur, length, bright] for the pen foley
  let seedN = 1;
  // a group of strokes drawn one after another between t0 and t1, in the order given (real stroke order)
  const group = (list, t0, t1, bright = 1) => {
    const sts = list.filter(s => s && s.pts && s.pts.length > 1).map(s => penStroke(s.pts, { w: 2.8, wob: 1.05, over: 5, gap: .4, seed: seedN++, ...s.o }));
    const lift = .012, L = sts.reduce((a, s) => a + s.L, 0), speed = Math.max(1e-6, (t1 - t0 - lift * sts.length) / L);
    let t = t0;
    for (const st of sts) { const d = Math.max(.008, st.L * speed); rasterPen(ia, ta, st, t, d, WIN_A); strokes.push([+t.toFixed(4), +d.toFixed(4), Math.round(st.L), bright]); t += d + lift; }
    return sts;
  };
  const S = (pts, o = {}) => ({ pts, o });
  const line = (x0, y0, x1, y1, o) => S([[x0, y0], [x1, y1]], { smooth: false, ...o });
  const rect = (x0, y0, x1, y1, o) => S([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0 + 4]], { smooth: false, ...o });

  // ---------- roof strokes ----------
  const roofStrokes = h => {
    const L = h.x0 - 34, Rr = h.x1 + 34, e = h.eave, r = h.ridge;
    const eave = S([[L - 6, e - 26], [L + 30, e - 4], [lerp(L, Rr, .5), e + 4], [Rr - 30, e - 4], [Rr + 6, e - 28]], { w: 3.2, over: 7 });
    const ridge = S([[h.x0 + 40, r - 14], [h.x0 + 70, r], [h.x1 - 70, r], [h.x1 - 40, r - 14]], { w: 3.1 });
    const hipL = S([[h.x0 + 70, r + 2], [L + 22, e - 8]], { smooth: false }), hipR = S([[h.x1 - 70, r + 2], [Rr - 22, e - 8]], { smooth: false });
    return { eave, ridge, hips: [hipL, hipR] };
  };
  const tileLines = h => {
    const out = [], e = h.eave, r = h.ridge, step = 40;
    for (let x = h.x0 + 70; x < h.x1 - 60; x += step + (R() - .5) * 8) {
      if (R() < .18) continue;
      const k = (x - (h.x0 + h.x1) / 2) / ((h.x1 - h.x0) / 2);
      const y0 = r + 8 + R() * 10, y1 = e - 12 - R() * 14 - (R() < .4 ? (e - r) * .35 * R() : 0);
      out.push(S([[x, y0], [x + k * 10, lerp(y0, y1, .5)], [x + k * 18, y1]], { w: 1.7, wob: .7, over: 2, gap: .5 }));
    }
    // tile ends along the eave: tiny scallops
    for (let x = h.x0 - 10; x < h.x1 + 10; x += 40) out.push(S([[x, h.eave - 6], [x + 9, h.eave + 2], [x + 20, h.eave - 5]], { w: 1.5, wob: .4, over: 1 }));
    return out;
  };
  const beam = h => S([[h.x0 - 10, h.eave + 30], [h.x1 + 10, h.eave + 30]], { w: 2.2, gap: .7 });

  // ---------- a house front (walls, windows, shutters) ----------
  const houseStrokes = h => {
    const out = [], fl = h.floor, w = h.x1 - h.x0;
    out.push(line(h.x0 + 4, h.eave + 30, h.x0 + 2, GROUND, { w: 2.6 }), line(h.x1 - 3, h.eave + 30, h.x1 - 1, GROUND, { w: 2.6 }));
    out.push(S([[h.x0 - 6, fl], [h.x1 + 6, fl + 3]], { w: 2.4, gap: .5 }), S([[h.x0 - 6, fl + 26], [h.x1 + 6, fl + 28]], { w: 1.6, gap: .6 }));
    // upper windows: a frame and a few lattice marks
    const nwin = Math.max(1, Math.round(w / 360));
    for (let i = 0; i < nwin; i++) {
      const cxw = h.x0 + w * (i + .5) / nwin, ww = Math.min(210, w / nwin * .55), y0 = h.eave + 110, y1 = fl - 70;
      out.push(rect(cxw - ww / 2, y0, cxw + ww / 2, y1, { w: 2.2 }));
      for (let k = 1; k < 4; k++) out.push(line(cxw - ww / 2 + ww * k / 4, y0 + 6, cxw - ww / 2 + ww * k / 4 + 1, y1 - 6, { w: 1.3, wob: .5, over: 1 }));
      out.push(line(cxw - ww / 2 + 6, lerp(y0, y1, .45), cxw + ww / 2 - 6, lerp(y0, y1, .45), { w: 1.3, wob: .5, over: 1 }));
      out.push(line(cxw - ww / 2 - 14, y1 + 10, cxw + ww / 2 + 14, y1 + 12, { w: 2 }));                         // sill
    }
    // ground floor: wooden shutters (vertical boards) + a door
    const gy0 = fl + 60;
    const door = h.x0 + w * (h.id === 'h2' ? .72 : h.id === 'h3' ? .22 : .5);
    out.push(rect(door - 85, gy0 + 40, door + 85, GROUND, { w: 2.4 }));
    out.push(line(door, gy0 + 46, door + 1, GROUND - 4, { w: 1.4 }));
    for (let x = h.x0 + 40; x < h.x1 - 40; x += 46 + (R() - .5) * 6) {
      if (Math.abs(x - door) < 110) continue;
      const yb = GROUND - 4, yt = gy0 + 10 + R() * 18; if (R() < .22) continue;
      out.push(line(x, yt, x + (R() - .5) * 3, yb - R() * 30, { w: 1.4, wob: .6, over: 2, gap: .3 }));
    }
    out.push(S([[h.x0 + 30, gy0], [h.x1 - 30, gy0 + 2]], { w: 2.2 }));
    return out;
  };

  // ---------- poles + wires ----------
  const poleStrokes = p => [
    line(p.x - 12, p.top, p.x - 14, GROUND + 100, { w: 2.6 }), line(p.x + 12, p.top + 6, p.x + 14, GROUND + 100, { w: 2.6, gap: .4 }),
    line(p.x - 70, p.top + 22, p.x + 70, p.top + 18, { w: 2.4 }), line(p.x - 50, p.top + 62, p.x + 50, p.top + 60, { w: 2 }),
    ...[-55, 0, 55].map(dx => S([[p.x + dx - 5, p.top + 12], [p.x + dx + 5, p.top + 12]], { w: 3, over: 0 })),
  ];
  const wires = (a, b) => [0, 1, 2].map(k => {
    const xa = a.x + (k - 1) * 55, xb = b.x + (k - 1) * 55, ya = a.top + 16 + k * 2, yb = b.top + 16 + k * 2, sag = 80 + k * 18;
    const pts = [...Array(13)].map((_, i) => { const u = i / 12; return [lerp(xa, xb, u), lerp(ya, yb, u) + sag * 4 * u * (1 - u)]; });
    return S(pts, { w: 1.6, wob: .8, over: 6, gap: .2 });
  });

  // ---------- laundry ----------
  const LP = { x0: 1560, y0: 1330, x1: 2430, y1: 1250 };
  const lpY = x => lerp(LP.y0, LP.y1, (x - LP.x0) / (LP.x1 - LP.x0));
  const shirt = (x) => { const y = lpY(x) + 4; return [
    S([[x - 70, y + 2], [x - 118, y + 30], [x - 134, y + 98], [x - 92, y + 108], [x - 72, y + 70], [x - 66, y + 250], [x + 70, y + 252], [x + 72, y + 68], [x + 92, y + 106], [x + 132, y + 92], [x + 116, y + 26], [x + 70, y - 2]], { w: 2.4, smooth: true }),
    S([[x - 24, y], [x, y + 34], [x + 24, y - 2]], { w: 2 }), line(x, y + 40, x + 2, y + 240, { w: 1.3, gap: .6 }),
    line(x - 70, y - 8, x - 64, y + 14, { w: 3, over: 0 }), line(x + 70, y - 10, x + 64, y + 12, { w: 3, over: 0 })]; };
  const pants = (x) => { const y = lpY(x) + 4; return [
    S([[x - 62, y], [x - 70, y + 300], [x - 18, y + 304], [x, y + 90], [x + 18, y + 304], [x + 70, y + 300], [x + 62, y]], { w: 2.4, smooth: false }),
    line(x - 62, y + 26, x + 62, y + 24, { w: 1.6 }), line(x - 58, y - 8, x - 52, y + 14, { w: 3, over: 0 }), line(x + 58, y - 10, x + 52, y + 12, { w: 3, over: 0 })]; };
  const towel = (x) => { const y = lpY(x) + 4; return [
    S([[x - 60, y], [x - 64, y + 150], [x - 30, y + 158], [x + 20, y + 150], [x + 62, y + 156], [x + 58, y]], { w: 2.2 }),
    line(x - 56, y + 122, x + 58, y + 126, { w: 1.3, gap: .5 }), line(x - 56, y + 132, x + 58, y + 136, { w: 1.3, gap: .5 })]; };

  // ---------- the shop (open front, sign board, two lanterns, stove + steamer, a table) ----------
  const shopStrokes = () => {
    const s = SHOP, out = [];
    out.push(line(s.x0 + 8, s.eave + 30, s.x0 + 10, GROUND + 4, { w: 3 }), line(s.x0 + 34, s.eave + 32, s.x0 + 36, GROUND, { w: 1.8, gap: .5 }));
    out.push(line(s.x1 - 8, s.eave + 30, s.x1 - 10, GROUND + 4, { w: 3 }), line(s.x1 - 34, s.eave + 32, s.x1 - 36, GROUND, { w: 1.8, gap: .5 }));
    out.push(S([[s.x0, s.beam], [s.x1, s.beam + 4]], { w: 2.8 }), S([[s.x0 + 30, s.beam + 30], [s.x1 - 30, s.beam + 32]], { w: 1.6, gap: .5 }));
    return out;
  };
  const signStrokes = () => { const g = SHOP.sign; return [rect(g.x0, g.y0, g.x1, g.y1, { w: 3 }), rect(g.x0 + 18, g.y0 + 16, g.x1 - 18, g.y1 - 16, { w: 1.5, gap: .5 }),
    line(g.x0 + 60, SHOP.eave + 30, g.x0 + 64, g.y0, { w: 1.6 }), line(g.x1 - 60, SHOP.eave + 30, g.x1 - 64, g.y0, { w: 1.6 })]; };
  const lanternStrokes = L => {
    const top = L.y - L.ry, bot = L.y + L.ry, out = [];
    out.push(line(L.x, SHOP.eave + 30, L.x + 1, top - 22, { w: 1.4, over: 0 }));
    out.push(rect(L.x - 30, top - 22, L.x + 30, top + 2, { w: 2 }), rect(L.x - 30, bot - 2, L.x + 30, bot + 22, { w: 2 }));
    out.push(S(ellipse(L.x, L.y, L.rx, L.ry, 26, -Math.PI / 2).concat([[L.x + 4, top]]), { w: 2.6 }));
    for (const k of [-.62, -.25, .25, .62]) out.push(S([...Array(9)].map((_, i) => { const a = -Math.PI / 2 + i / 8 * Math.PI; return [L.x + k * L.rx * Math.cos(a), L.y + L.ry * Math.sin(a)]; }), { w: 1.3, wob: .5, over: 0, gap: .4 }));
    for (const dx of [-8, 0, 8]) out.push(S([[L.x + dx, bot + 22], [L.x + dx * 1.6 + 2, bot + 90]], { w: 1.2, wob: .6, over: 1 }));
    return out;
  };
  const stoveStrokes = () => {
    const st = SHOP.stove, sm = SHOP.steamer, out = [];
    out.push(rect(st.x0, st.y0, st.x1, GROUND, { w: 2.8 }));
    for (let y = st.y0 + 48; y < GROUND - 10; y += 48) out.push(line(st.x0 + 6, y, st.x1 - 6, y + 2, { w: 1.2, wob: .6, over: 1, gap: .5 }));
    for (let y = st.y0, r = 0; y < GROUND - 40; y += 48, r++) for (let x = st.x0 + (r % 2 ? 60 : 30); x < st.x1 - 20; x += 90) if (R() < .7) out.push(line(x, y + 6, x, y + 42, { w: 1.1, over: 0 }));
    out.push(S([[2985, GROUND - 4], [2990, 1940], [3060, 1922], [3130, 1940], [3135, GROUND - 4]], { w: 2.4 }));     // fire mouth
    const x0 = sm.x - sm.w / 2, x1 = sm.x + sm.w / 2;
    for (let k = 0; k < 3; k++) { const y0 = sm.top + k * ((sm.base - sm.top) / 3), y1 = y0 + (sm.base - sm.top) / 3;
      out.push(S([[x0 + 6, y0], [x0, y1], [x1, y1 + 1], [x1 - 6, y0]], { w: 2.6, smooth: false }));
      for (let x = x0 + 30; x < x1 - 20; x += 38) out.push(line(x, y0 + 12, x + 1, y1 - 10, { w: 1, wob: .4, over: 0, gap: .3 }));
    }
    out.push(S([[x0 - 30, sm.base + 2], [x1 + 30, sm.base + 4]], { w: 2.2 }));           // wok rim
    return out;
  };
  const interiorStrokes = () => [
    S([[2840, 1520], [3780, 1524]], { w: 1.5, gap: .5 }),
    ...[0, 1, 2, 3, 4].map(k => S(ellipse(3330 + k * 70, 1585, 26, 12, 12), { w: 1.4, over: 1 })),            // bowls on the shelf
    line(3300, 1610, 3700, 1612, { w: 1.8 }),
    S([[3380, 1840], [3760, 1842]], { w: 2.6 }), line(3400, 1846, 3398, GROUND - 2, { w: 2.2 }), line(3740, 1846, 3744, GROUND - 2, { w: 2.2 }),   // table
    rect(3300, 1930, 3360, 1950, { w: 1.8 }), line(3306, 1952, 3304, GROUND - 2, { w: 1.6 }), line(3354, 1952, 3356, GROUND - 2, { w: 1.6 }),
    rect(3780, 1930, 3830, 1950, { w: 1.8 }),
    S([[3460, 1838], [3470, 1800], [3520, 1796], [3530, 1838]], { w: 1.6 }), S([[3580, 1838], [3585, 1812], [3625, 1810], [3630, 1838]], { w: 1.6 }),   // bowls on the table
  ];
  const groundStrokes = () => {
    const out = [S([[150, GROUND + 4], [4250, GROUND + 8]], { w: 2.4, gap: .5 }), S([[150, CURB], [1400, CURB + 4], [2800, CURB + 2], [4250, CURB + 6]], { w: 2.6, gap: .6 }),
      S([[150, CURB + 24], [4250, CURB + 30]], { w: 1.4, gap: .8 })];
    for (let x = 260; x < 4200; x += 150 + R() * 120) out.push(line(x, GROUND + 14, x - 30, CURB - 8, { w: 1.2, wob: .5, over: 1 }));
    for (let i = 0; i < 26; i++) { const x = 200 + R() * 3950, y = CURB + 70 + R() * 380; out.push(line(x, y, x + 50 + R() * 90, y + (R() - .5) * 6, { w: 1.2, wob: .6, over: 2 })); }
    return out;
  };

  // ================= stroke order on the timeline =================
  const [h1, h2, h3, , h5] = HOUSES;
  const r2 = roofStrokes(h2), r1 = roofStrokes(h1), r3 = roofStrokes(h3), rs = roofStrokes(HOUSES[3]), r5 = roofStrokes(h5);
  group([r2.eave], HIT.eave, 1.05, 1);                                       // A1.2: the first eave line, in one breath
  group([r2.ridge, ...r2.hips, beam(h2)], 1.06, 1.32, 1);
  group(tileLines(h2), HIT.tiles, 1.98, 1.25);                                 // A1.3: tiles rain down (bright, hi-hat)
  group(wires(POLES[0], POLES[1]), HIT.wire, 2.40, .9);                         // A2.1: wires pulled across
  group([r1.eave, r1.ridge, ...r1.hips, beam(h1)], 2.41, 2.66, 1);
  group([S([[LP.x0 - 20, LP.y0 + 2], [LP.x1 + 30, LP.y1 - 2]], { w: 2.8, over: 8 }), line(LP.x1, LP.y1, LP.x1 + 40, LP.y1 + 60, { w: 2 }), line(LP.x0, LP.y0, LP.x0 - 10, LP.y0 + 50, { w: 2 })], HIT.pole, 2.90, 1);   // A2.2 laundry pole
  group([...tileLines(h1), ...poleStrokes(POLES[0]), ...houseStrokes(h2).slice(0, 12)], 2.91, 3.32, 1.15);
  group([...shirt(1720), ...pants(1960), ...towel(2210)], HIT.clothes, 3.95, 1);   // A2.3 clothes
  // A3: pull back — the rest of the street drawn fast, left to right
  group([...houseStrokes(h1), ...houseStrokes(h2).slice(12)], HIT.full, 4.32, 1.05);
  group([r3.eave, r3.ridge, ...r3.hips, ...tileLines(h3), beam(h3), ...houseStrokes(h3)], 4.32, 4.78, 1.15);
  group([...poleStrokes(POLES[1]), ...wires(POLES[1], POLES[2])], 4.78, 4.95, 1);
  group([rs.eave, rs.ridge, ...rs.hips, ...tileLines(HOUSES[3]), beam(HOUSES[3]), ...shopStrokes(), ...signStrokes(), ...lanternStrokes(SHOP.lanterns[0]), ...lanternStrokes(SHOP.lanterns[1])], 4.95, 5.25, 1.1);
  group([...stoveStrokes(), ...interiorStrokes()], 5.25, 5.45, 1.05);
  group([r5.eave, r5.ridge, ...r5.hips, ...tileLines(h5), beam(h5), ...houseStrokes(h5), ...poleStrokes(POLES[2])], 5.45, 5.62, 1.1);
  group(groundStrokes(), 5.62, 5.78, .95);

  // ================= washes (colour layer; revealed by the arrival field) =================
  const R2 = rng(99);
  // sky: big soft washes, paler upward; a warm dawn band low behind the roofs; clouds reserved
  for (let i = 0; i < 64; i++) {
    const x = 200 + R2() * 4000, y = 360 + R2() * 700, k = clamp((y - 300) / 700);
    if (R2() > .35 + k * .8) continue;
    wash(cx, ellipse(x, y, 260 + R2() * 380, 90 + R2() * 120, 24, R2()), R2() < .3 ? C.skyDeep : C.sky, { a: .1 + .14 * k, j: 30, layers: 2, edge: .12, seed: i * 7 + 3, freq: .006 });
  }
  for (let i = 0; i < 18; i++) { const x = 200 + R2() * 4000, y = 820 + R2() * 220; wash(cx, ellipse(x, y, 300 + R2() * 300, 60 + R2() * 50, 22, R2()), C.dawn, { a: .14, j: 24, layers: 2, edge: .05, seed: 300 + i, freq: .007 }); }
  for (const [x, y, rx] of [[1300, 560, 300], [2350, 470, 380], [3500, 600, 280]]) {
    reserve(cx, ellipse(x, y, rx, rx * .26, 24), .85, 22, x | 0);
    wash(cx, ellipse(x + rx * .05, y + rx * .12, rx * .8, rx * .1, 18), C.cloud, { a: .22, j: 12, layers: 2, edge: .1, seed: y | 0 });
  }
  // houses: wall local colour, a cool shadow band under the eave and on the right of the upper floor, wood shutters, windows
  for (const h of HOUSES) {
    if (h.shop) continue;
    const off = { dx: 3, dy: 2 };
    wash(cx, [[h.x0 + 4, h.eave + 30], [h.x1, h.eave + 30], [h.x1 + 4, GROUND], [h.x0, GROUND]], h.wall, { a: .5, j: 7, layers: 3, edge: .35, seed: h.x0, ...off });
    wash(cx, [[h.x0 + 2, h.eave + 26], [h.x1 + 6, h.eave + 26], [h.x1, h.eave + 120], [h.x0 + 40, h.eave + 96]], shade(h.wall, .5), { a: .38, j: 8, layers: 2, edge: .25, seed: h.x0 + 1 });
    wash(cx, [[h.x0 + 40, h.floor + 62], [h.x1 - 36, h.floor + 62], [h.x1 - 30, GROUND - 2], [h.x0 + 36, GROUND - 2]], h.wood, { a: .45, j: 5, layers: 2, edge: .3, seed: h.x0 + 2, ...off });
    wash(cx, [[h.x0, h.floor + 2], [h.x1, h.floor + 2], [h.x1, h.floor + 70], [h.x0, h.floor + 60]], shade(h.wood, .5), { a: .4, j: 4, layers: 2, edge: .2, seed: h.x0 + 3 });
    const w = h.x1 - h.x0, nwin = Math.max(1, Math.round(w / 360));
    for (let i = 0; i < nwin; i++) { const cxw = h.x0 + w * (i + .5) / nwin, ww = Math.min(210, w / nwin * .55), y0 = h.eave + 110, y1 = h.floor - 70;
      wash(cx, [[cxw - ww / 2, y0], [cxw + ww / 2, y0], [cxw + ww / 2, y1], [cxw - ww / 2, y1]], shade(h.wood, .6), { a: .42, j: 4, layers: 2, edge: .3, seed: cxw | 0, dx: 4, dy: 3 }); }
    const door = h.x0 + w * (h.id === 'h2' ? .72 : h.id === 'h3' ? .22 : .5);
    wash(cx, [[door - 85, h.floor + 100], [door + 85, h.floor + 100], [door + 85, GROUND], [door - 85, GROUND]], shade(h.wood, .6), { a: .38, j: 4, layers: 2, edge: .3, seed: door | 0, dx: 3 });
    // roof
    const L = h.x0 - 34, Rr = h.x1 + 34;
    wash(cx, [[h.x0 + 60, h.ridge], [h.x1 - 60, h.ridge], [Rr, h.eave - 6], [L, h.eave - 6]], C.roof, { a: .55, j: 6, layers: 3, edge: .35, seed: h.x0 + 5, dx: 3, dy: 3 });
    wash(cx, [[h.x0 + 70, h.ridge + 4], [h.x1 - 70, h.ridge + 4], [h.x1 - 40, lerp(h.ridge, h.eave, .4)], [h.x0 + 40, lerp(h.ridge, h.eave, .45)]], C.roofLit, { a: .25, j: 8, layers: 2, edge: .05, seed: h.x0 + 6 });
  }
  // laundry (pale), poles
  const cloth = (poly, col, s) => wash(cx, poly, col, { a: .5, j: 4, layers: 2, edge: .35, seed: s, dx: 4, dy: 3 });
  { const y = lpY(1720) + 4, x = 1720; cloth([[x - 70, y], [x - 130, y + 30], [x - 134, y + 98], [x - 72, y + 70], [x - 66, y + 250], [x + 70, y + 252], [x + 72, y + 68], [x + 132, y + 92], [x + 116, y + 26], [x + 70, y]], C.shirt, 71); }
  { const y = lpY(1960) + 4, x = 1960; cloth([[x - 62, y], [x - 70, y + 300], [x - 18, y + 304], [x, y + 90], [x + 18, y + 304], [x + 70, y + 300], [x + 62, y]], C.pants, 72); }
  { const y = lpY(2210) + 4, x = 2210; cloth([[x - 60, y], [x - 64, y + 150], [x - 30, y + 158], [x + 20, y + 150], [x + 62, y + 156], [x + 58, y]], C.towel, 73); }
  for (const p of POLES) wash(cx, [[p.x - 14, p.top], [p.x + 14, p.top], [p.x + 16, GROUND + 100], [p.x - 16, GROUND + 100]], C.pole, { a: .45, j: 2, layers: 2, edge: .3, seed: p.x, dx: 3 });
  // ground: pale stone, darker curb, the street
  wash(cx, [[150, GROUND + 4], [4250, GROUND + 8], [4250, CURB], [150, CURB]], C.ground, { a: .4, j: 10, layers: 2, edge: .15, seed: 81 });
  wash(cx, [[150, GROUND + 4], [4250, GROUND + 8], [4250, GROUND + 50], [150, GROUND + 40]], shade(C.ground, .5), { a: .25, j: 8, layers: 2, edge: .05, seed: 82 });
  wash(cx, [[150, CURB], [4250, CURB + 6], [4250, CURB + 34], [150, CURB + 28]], C.curb, { a: .45, j: 4, layers: 2, edge: .2, seed: 83 });
  wash(cx, [[150, CURB + 34], [4250, CURB + 40], [4250, 2640], [150, 2640]], C.street, { a: .3, j: 14, layers: 2, edge: .05, seed: 84, freq: .008 });
  // the shop: warm wood, a dark interior, brick stove, bamboo steamer, the sign board (pale, the red comes later)
  { const s = SHOP;
    wash(cx, [[s.x0 + 60, HOUSES[3].ridge], [s.x1 - 60, HOUSES[3].ridge], [s.x1 + 34, s.eave - 6], [s.x0 - 34, s.eave - 6]], C.roof, { a: .55, j: 6, layers: 3, edge: .35, seed: 91, dx: 3, dy: 3 });
    wash(cx, [[s.x0, s.eave + 26], [s.x1, s.eave + 26], [s.x1, s.beam + 30], [s.x0, s.beam + 30]], C.shopWood, { a: .5, j: 6, layers: 3, edge: .35, seed: 92, dx: 3, dy: 2 });
    wash(cx, [[s.x0 + 36, s.beam + 32], [s.x1 - 36, s.beam + 32], [s.x1 - 36, GROUND], [s.x0 + 36, GROUND]], C.shopDark, { a: .42, j: 8, layers: 3, edge: .2, seed: 93 });
    wash(cx, [[s.x0 + 36, s.beam + 32], [s.x1 - 36, s.beam + 32], [s.x1 - 36, s.beam + 160], [s.x0 + 36, s.beam + 130]], shade(C.shopDark, .5), { a: .3, j: 8, layers: 2, edge: .05, seed: 94 });
    for (const xx of [s.x0, s.x1 - 36]) wash(cx, [[xx, s.eave + 30], [xx + 36, s.eave + 30], [xx + 36, GROUND], [xx, GROUND]], shade(C.shopWood, .3), { a: .55, j: 2, layers: 2, edge: .3, seed: xx | 0, dx: 3 });
    wash(cx, [[s.stove.x0, s.stove.y0], [s.stove.x1, s.stove.y0], [s.stove.x1, GROUND], [s.stove.x0, GROUND]], C.brick, { a: .55, j: 4, layers: 3, edge: .35, seed: 95, dx: 4, dy: 2 });
    wash(cx, [[2990, GROUND], [2992, 1944], [3060, 1926], [3130, 1944], [3132, GROUND]], hex('#3c2e2a'), { a: .55, j: 3, layers: 2, edge: .2, seed: 96 });
    const sm = s.steamer; wash(cx, [[sm.x - sm.w / 2 + 6, sm.top], [sm.x + sm.w / 2 - 6, sm.top], [sm.x + sm.w / 2, sm.base], [sm.x - sm.w / 2, sm.base]], C.bamboo, { a: .55, j: 4, layers: 3, edge: .35, seed: 97, dx: 4, dy: 2 });
    wash(cx, [[sm.x + sm.w * .15, sm.top], [sm.x + sm.w / 2 - 6, sm.top], [sm.x + sm.w / 2, sm.base], [sm.x + sm.w * .2, sm.base]], shade(C.bamboo, .4), { a: .3, j: 4, layers: 2, edge: .1, seed: 98 });
    const g = s.sign; wash(cx, [[g.x0, g.y0], [g.x1, g.y0], [g.x1, g.y1], [g.x0, g.y1]], C.board, { a: .5, j: 4, layers: 2, edge: .3, seed: 99, dx: 4, dy: 3 });
    wash(cx, [[3380, 1840], [3760, 1842], [3760, 1866], [3380, 1864]], C.shopWood, { a: .55, j: 3, layers: 2, edge: .3, seed: 100 });
    // lanterns stay paper-white: their red arrives as an event
    for (const L of s.lanterns) reserve(cx, ellipse(L.x, L.y, L.rx + 8, L.ry + 6, 24), 1, 3, L.x | 0);
  }

  // ================= page edges: fray into dabs, nothing edge to edge =================
  { const [mc, mx] = cv(W, H); mx.fillStyle = '#fff';
    for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 4) if (pageMask(x, y) < 0) mx.fillRect(x, y, 4, 4);
    const Rm = rng(31);
    for (let i = 0; i < 26000; i++) { const x = 60 + Rm() * 4300, y = 200 + Rm() * 2520, m = pageMask(x, y); if (m > 0 && m < 70 && Rm() < (1 - m / 70) * .5) dab(mx, x, y, 3 + Rm() * 8, Rm() * TAU, [255, 255, 255], .95, i); }
    cx.globalCompositeOperation = 'source-over'; cx.drawImage(mc, 0, 0);
    for (const c of [ia]) { c.save(); c.globalCompositeOperation = 'destination-out'; c.drawImage(mc, 0, 0); c.restore(); }
    cx.globalCompositeOperation = 'multiply';
    for (let i = 0; i < 7000; i++) { const x = 60 + Rm() * 4300, y = 900 + Rm() * 1800, m = pageMask(x, y); if (m < 0 && m > -80 && Rm() < (1 + m / 80) * .6) { const k = Rm(); dab(cx, x, y, 5 + Rm() * 12, Rm() * TAU, k < .4 ? C.ground : k < .7 ? HOUSES[1].wall : C.roof, .25 + Rm() * .3, 40000 + i); } }
    cx.globalCompositeOperation = 'source-over';
  }

  // ================= pack into texture data =================
  const pack = (r, g) => { const out = new Uint8Array(W * H * 4); const A = r.getImageData(0, 0, W, H).data; for (let i = 0, n = W * H; i < n; i++) out[i * 4] = A[i * 4 + 3];
    const Bd = g.getImageData(0, 0, W, H).data; for (let i = 0, n = W * H; i < n; i++) { out[i * 4 + 1] = Bd[i * 4 + 3]; out[i * 4 + 3] = 255; } return out; };
  const packT = (r, g) => { const out = new Uint8Array(W * H * 4); const A = r.getImageData(0, 0, W, H).data, Bd = g.getImageData(0, 0, W, H).data;
    for (let i = 0, n = W * H; i < n; i++) { out[i * 4] = A[i * 4]; out[i * 4 + 1] = Bd[i * 4]; out[i * 4 + 3] = 255; } return out; };
  const ink = pack(ia, ib), time = packT(ta, tb);
  return { W, H, color: colorC, ink, time, winA: WIN_A, winB: WIN_B, strokes };
}

// colour arrival field: one time per cell, by region (each region has its own source and moment)
export function arrival(gw, gh, src) {
  const F = new Float32Array(gw * gh), cw = W / gw, ch = H / gh;
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    const x = (i + .5) * cw, y = (j + .5) * ch, s = src[region(x, y)];
    if (!s) { F[j * gw + i] = 999; continue; }
    const nz = (fbm(x * .0024, y * .0024, 17, 4) - .5) * 2 * (s.amp ?? 170) + (fbm(x * .011, y * .011, 23, 2) - .5) * (s.amp ?? 170) * .35;
    const d = Math.max(0, Math.hypot(x - s.x, (y - s.y) * (s.sy ?? 1)) + nz);
    F[j * gw + i] = s.t + d / s.v;
  }
  return F;
}
