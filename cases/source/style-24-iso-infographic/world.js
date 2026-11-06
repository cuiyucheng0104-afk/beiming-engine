// 一封信的旅程 — the world: two floating boards (北城, 南港), stations, vehicles, cutaway containers.
import { tri, hex, mix, rgb, clamp, lerp, seg, eo, eio, ss, back, hash, TAU, C30, S30, hatch, cutLine, person } from './engine.js';

// ---------- palette (one hue per meaning; red is reserved for the letter) ----------
export const COL = {
  bg: '#F2ECDF', ink: '#2B2433', paper: '#FBF6EA',
  red: '#D8392E', post: '#2F8F5B', sand: '#D6C5A6', grass: '#A5C48C', water: '#76AECB',
  road: '#6E6873', mustard: '#E5B53E', lav: '#9786BE', steel: '#C9CDD2', white: '#EEE9DE',
};
export const TR = {
  red: tri(COL.red), post: tri(COL.post), sand: tri(COL.sand), grass: tri(COL.grass, .18, .2), water: tri(COL.water),
  road: tri(COL.road), mustard: tri(COL.mustard), lav: tri(COL.lav), steel: tri(COL.steel), white: tri(COL.white, .25, .16),
  cream: tri('#F4EBD8', .3, .14), dark: tri('#4A4352'), wall: tri('#E3D6BC', .25, .18), roof: tri('#7A7280'),
  wood: tri('#C9B089'), sack: tri('#CDB58C'), tree: tri('#7FAE6A', .2, .22), trunk: tri('#8A6F55'),
};

// ---------- boards ----------
export const BN = { x0: 0, y0: 0, x1: 60, y1: 40, name: '北城' };
export const BS = { x0: 106, y0: -64, x1: 162, y1: -18, name: '南港' };
const ZBOT = -5;

// key places
export const MB = { x: 8, y: 31.9 };                                // mailbox centre
export const PO = { x0: 14, y0: 22, x1: 30, y1: 28, h: 5.2, beltY: 25, beltZ: 1.85, stampX: 22, flipX: 25.4 };
export const TRUCK0 = { x: 34.5, y: 25 };
export const PLANE0 = { x: 50.5, y: 35.5 };
export const HOUSE = { x0: 140, y0: -40, x1: 150, y1: -33, h: 4.6, doorX: 144.9, slotZ: 1.6 };
export const PLANE1 = { x: 122, y: -27 };
export const MAPC = { x: 80.5, y: -12, z: 1.5 };

// ---------- path helpers ----------
export function polyLen(P) { const L = [0]; for (let i = 1; i < P.length; i++) L.push(L[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], (P[i][2] || 0) - (P[i - 1][2] || 0))); return L; }
export function polyAt(P, L, u) { // u ∈ [0,1] by arc length → [x,y,z, heading]
  const s = clamp(u) * L[L.length - 1]; let i = 1; while (i < L.length - 1 && L[i] < s) i++;
  const a = P[i - 1], b = P[i], f = (s - L[i - 1]) / ((L[i] - L[i - 1]) || 1);
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2] || 0, b[2] || 0, f), Math.atan2(b[1] - a[1], b[0] - a[0])];
}
// Catmull-Rom resample for smooth vehicle paths
export function smooth(P, n = 16) {
  const out = []; for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    for (let j = 0; j < n; j++) { const t = j / n, t2 = t * t, t3 = t2 * t; out.push([0, 1, 2].map(k => .5 * ((2 * (p1[k] || 0)) + (-(p0[k] || 0) + (p2[k] || 0)) * t + (2 * (p0[k] || 0) - 5 * (p1[k] || 0) + 4 * (p2[k] || 0) - (p3[k] || 0)) * t2 + (-(p0[k] || 0) + 3 * (p1[k] || 0) - 3 * (p2[k] || 0) + (p3[k] || 0)) * t3))); }
  } out.push([...P[P.length - 1].slice(0, 2), P[P.length - 1][2] || 0]); return out;
}
export const TRUCK_PATH = smooth([[34.5, 25], [37.5, 25], [41, 26.6], [45.5, 29.2], [48.2, 30.8], [49.6, 31]], 14);   // heading stays ≤ ~31°, so the cut-open +y side keeps facing the camera through the turn
export const TRUCK_L = polyLen(TRUCK_PATH);
export const FLIGHT = smooth([[50.5, 35.5, 0], [57, 35.5, 0], [64, 34.5, 3], [76, 26, 9.5], [92, 4, 14], [104, -16, 8.5], [110, -25.5, 2.2], [113, -27, 0], [122, -27, 0]], 18);
export const FLIGHT_L = polyLen(FLIGHT);
export const BIKE_PATH = smooth([[124.6, -22.4], [131, -22.4], [136.5, -22.6], [140, -25.5], [142.8, -29.6], [144.2, -31.4]], 14);
export const BIKE_L = polyLen(BIKE_PATH);

// ---------- planar drawing on a world plane: (u,v) in world units along U and V ----------
export function onPlane(iso, o, U, V, fn) {
  const g = iso.g, s0 = iso.L(o[0], o[1], o[2]), su = iso.L(o[0] + U[0], o[1] + U[1], o[2] + U[2]), sv = iso.L(o[0] + V[0], o[1] + V[1], o[2] + V[2]);
  g.save(); g.transform(su[0] - s0[0], su[1] - s0[1], sv[0] - s0[0], sv[1] - s0[1], s0[0], s0[1]); fn(g); g.restore();
}
const scr = (iso, pts) => pts.map(p => iso.L(p[0], p[1], p[2]));
function clipPoly(g, sp) { g.beginPath(); sp.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath(); g.clip(); }
function fillPoly(iso, sp, c, a = 1) { iso.poly(sp, c, a); }

// ---------- background lattice + board slabs ----------
export function drawBackground(iso) {
  const g = iso.g, k = iso.cam.k;
  g.fillStyle = COL.bg; g.fillRect(0, 0, iso.W, iso.H);
  // isometric dot lattice on a deep plane (z = -9): spacing chosen by zoom so it stays ~34–68 px
  let sp = 1; while (sp * k < 34) sp *= 2; while (sp * k > 68) sp /= 2;
  const z = -9, [x0, y0] = iso.unP(0, 0, z), [x1, y1] = iso.unP(iso.W, iso.H, z), [x2, y2] = iso.unP(iso.W, 0, z), [x3, y3] = iso.unP(0, iso.H, z);
  const ax = Math.min(x0, x1, x2, x3), bx = Math.max(x0, x1, x2, x3), ay = Math.min(y0, y1, y2, y3), by = Math.max(y0, y1, y2, y3);
  g.fillStyle = 'rgba(120,100,80,.16)'; const r = clamp(k * sp * .035, 1.1, 2.4);
  for (let x = Math.floor(ax / sp) * sp; x <= bx; x += sp) for (let y = Math.floor(ay / sp) * sp; y <= by; y += sp) {
    const [sx, sy] = iso.P(x, y, z); if (sx < -4 || sx > iso.W + 4 || sy < -4 || sy > iso.H + 4) continue; g.fillRect(sx - r, sy - r, 2 * r, 2 * r);
  }
}
export function drawBoard(iso, B) {
  const g = iso.g;
  iso.add(-1e6, () => {
    const c = [[B.x0, B.y0], [B.x1, B.y0], [B.x1, B.y1], [B.x0, B.y1]].map(p => iso.P(p[0] + 3, p[1] + 3, ZBOT - 3));
    g.save(); g.filter = `blur(${clamp(iso.cam.k * 3, 3, 60)}px)`; iso.poly(c, 'rgba(110,86,60,0.22)'); g.restore();
    const band = (axis, z0, z1, col) => {
      const P = axis === 'x' ? [[B.x1, B.y0, z1], [B.x1, B.y1, z1], [B.x1, B.y1, z0], [B.x1, B.y0, z0]] : [[B.x0, B.y1, z1], [B.x1, B.y1, z1], [B.x1, B.y1, z0], [B.x0, B.y1, z0]];
      iso.poly(P.map(p => iso.P(...p)), tri(col)[axis === 'x' ? 2 : 1]);
    };
    for (const ax of ['x', 'y']) { band(ax, ZBOT, -3.2, '#8E7558'); band(ax, -3.2, -1.2, '#B39672'); band(ax, -1.2, -.5, '#C9B28C'); band(ax, -.5, 0, '#8DB36F'); }
    // pebbles in the bottom stratum
    for (let i = 0; i < 70; i++) {
      const ax = i % 2 ? 'x' : 'y', q = hash(i * 3.7 + B.x0), zz = -4.6 + hash(i * 9.1 + B.y0) * 1.1;
      const p = ax === 'x' ? iso.P(B.x1, lerp(B.y0, B.y1, q), zz) : iso.P(lerp(B.x0, B.x1, q), B.y1, zz);
      g.beginPath(); g.ellipse(p[0], p[1], .28 * iso.cam.k, .14 * iso.cam.k, 0, 0, TAU); g.fillStyle = iso.col('#6F5A44', .45); g.fill();
    }
    // top
    iso.poly([[B.x0, B.y0, 0], [B.x1, B.y0, 0], [B.x1, B.y1, 0], [B.x0, B.y1, 0]].map(p => iso.P(...p)), TR.grass[0]);
  }, 0);
}
// ground decals (layer 0)
export const flatRect = (iso, x0, y0, x1, y1, c, z = .02, o = {}) => iso.flat([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z, c, o);
function dashes(iso, x0, y0, x1, y1, z = .04) { // road centre dashes
  const n = Math.floor(Math.hypot(x1 - x0, y1 - y0) / 2);
  for (let i = 0; i < n; i++) { const a = (i + .2) / n, b2 = (i + .6) / n; iso.line3([[lerp(x0, x1, a), lerp(y0, y1, a), z], [lerp(x0, x1, b2), lerp(y0, y1, b2), z]], '#F3EBDA', .14, { world: true, layer: 0, depth: -8e5, cap: 'butt' }); }
}
export function tree(iso, x, y, s = 1, kind = 0) {
  // small context detail: fades out under high zoom and during focus+context (iso.treeA), so it never balloons into giant discs
  const a = iso.treeA ?? 1; if (a <= .01) return;
  const A0 = iso.alpha; iso.alpha = A0 * a;
  iso.cyl(x, y, 0, .18 * s, 1.1 * s, TR.trunk, { n: 6 });
  if (kind) iso.cone(x, y, .8 * s, .9 * s, 2.4 * s, TR.tree, { n: 7 });
  else iso.sphere(x, y, 1.7 * s, .95 * s, TR.tree);
  iso.alpha = A0;
}
function windows(iso, x, y, z, w, d, h, face, n, rows) { // little window decal on +y or +x face
  return () => {
    const g = iso.g;
    for (let r = 0; r < rows; r++) for (let i = 0; i < n; i++) {
      const u0 = (i + .3) / n, u1 = (i + .7) / n, v0 = z + h * (r + .35) / (rows + .3), v1 = v0 + h * .3 / (rows + .3);
      const P = face === 'y' ? [[x + w * u0, y + d, v0], [x + w * u1, y + d, v0], [x + w * u1, y + d, v1], [x + w * u0, y + d, v1]] : [[x + w, y + d * u0, v0], [x + w, y + d * u1, v0], [x + w, y + d * u1, v1], [x + w, y + d * u0, v1]];
      iso.poly(scr(iso, P), face === 'y' ? '#8FA9B8' : '#6F8A9B');
    }
  };
}
export function block(iso, x, y, w, d, h, t3 = TR.wall, roof = true) {
  iso.box(x, y, 0, w, d, h, t3, { decal: () => { if (iso.cam.k > 9) { windows(iso, x, y, 0, w, d, h, 'y', Math.max(1, Math.round(w / 1.6)), Math.max(1, Math.round(h / 1.8)))(); windows(iso, x, y, 0, w, d, h, 'x', Math.max(1, Math.round(d / 1.6)), Math.max(1, Math.round(h / 1.8)))(); } } });
  if (roof) iso.roof(x, y, h, w, d, Math.min(w, d) * .45, TR.roof, { ridge: w > d ? 'x' : 'y', over: .12 });
}

// ---------- cutaway box: opening on its +y face (local frame) ----------
// st = {line, skin}: line 0..1 draws the cut line; skin 0..1 slides the +y skin out along +y and fades it.
export function cutBox(iso, x, y, z, w, d, h, t3, st, inside, o = {}) {
  const g = iso.g, Y = y + d, th = o.th ?? .16, top = !!o.top, zTop = top ? z + h : (o.openTop ?? (z + h - th));
  const X = x + w, Z = z + h, zf = z + (o.floorTh ?? 0);
  if (st.skin <= 0) iso.boxNow(x, y, z, w, d, h, t3, o.box || {});
  else {
    iso.boxNow(x, y, z, w, d, h, t3, { ...(o.box || {}), skip: top ? [0, 1] : [1], decal: null });
    const opening = top
      ? [[x + th, Y, zf], [X - th, Y, zf], [X - th, Y, Z], [X - th, y + th, Z], [x + th, y + th, Z], [x + th, Y, Z]]
      : [[x + th, Y, zf], [X - th, Y, zf], [X - th, Y, zTop], [x + th, Y, zTop]];
    g.save(); clipPoly(g, scr(iso, opening));
    const back = o.inner || hex(mix(t3[2] || t3, '#2B2433', .35)), side = hex(mix(back, '#2B2433', .2)), floor = o.floor || hex(mix(t3[1] || t3, '#FFF7E6', .1));
    fillPoly(iso, scr(iso, [[x + th, y + th, z], [X - th, y + th, z], [X - th, y + th, Z + 1], [x + th, y + th, Z + 1]]), back);
    fillPoly(iso, scr(iso, [[x + th, y + th, z], [x + th, Y, z], [x + th, Y, Z + 1], [x + th, y + th, Z + 1]]), side);
    fillPoly(iso, scr(iso, [[x + th, y + th, z + .001], [X - th, y + th, z + .001], [X - th, Y, z + .001], [x + th, Y, z + .001]]), floor);
    if (o.backDecal) o.backDecal(g, y + th);
    iso.sub(() => inside && inside(iso));
    g.restore();
    // hatched section rims (fade in over the last 40 % of the slide)
    const ra = seg(st.skin, .6, 1);
    if (ra > 0) {
      g.save(); g.globalAlpha = ra;
      const rim = (P) => hatch(g, scr(iso, P), { sp: clamp(iso.cam.k * .09, 4, 9) });
      rim([[x, Y, z], [x + th, Y, z], [x + th, Y, Z], [x, Y, Z]]);
      rim([[X - th, Y, z], [X, Y, z], [X, Y, Z], [X - th, Y, Z]]);
      if (top) {
        rim([[x, y, Z], [X, y, Z], [X, y + th, Z], [x, y + th, Z]]);
        rim([[x, y, Z], [x + th, y, Z], [x + th, Y, Z], [x, Y, Z]]);
        rim([[X - th, y, Z], [X, y, Z], [X, Y, Z], [X - th, Y, Z]]);
      } else rim([[x + th, Y, zTop], [X - th, Y, zTop], [X - th, Y, Z], [x + th, Y, Z]]);
      g.restore();
    }
    // the skins, sliding out along their normals and fading (motion, then alpha)
    if (st.skin < 1) {
      const off = eo(st.skin) * (o.slide ?? 1.6), a = 1 - seg(st.skin, .1, .75);
      if (a > 0) {
        if (top) iso.poly(scr(iso, [[x, y, Z + off], [X, y, Z + off], [X, Y, Z + off], [x, Y, Z + off]]), t3[0], a);
        iso.poly(scr(iso, [[x, Y + off, z], [X, Y + off, z], [X, Y + off, Z], [x, Y + off, Z]]), t3[1], a);
        if (o.skinDecal) { g.save(); g.globalAlpha = a; o.skinDecal(g, Y + off); g.restore(); }
      }
    }
  }
  if (st.skin <= 0 && o.skinDecal) o.skinDecal(g, Y);
  if (st.line > 0 && st.skin < .5) cutLine(g, scr(iso, top ? [[x, Y, z + .02], [x, Y, Z], [x, y, Z], [X, y, Z], [X, Y, Z], [X, Y, z + .02]] : [[x, Y, z + .02], [x, Y, Z], [X, Y, Z], [X, Y, z + .02]]), st.line, { lw: 2.5 });
}

// ---------- the letter ----------
// lying flat, long side along local x. pm = postmark progress (0 none, 1 stamped). Draws in the current local frame.
export const ENV = { w: 1.6, d: 1.1, h: .09 };
export function drawEnvelopeNow(iso, x, y, z, rot = 0, o = {}) {
  const { w, d, h } = ENV, s = o.s || 1;
  iso.push(x, y, z, rot, s);
  const K = iso.keep; iso.keep = true;
  iso.boxNow(-w / 2, -d / 2, 0, w, d, h, TR.red, {});
  onPlane(iso, [-w / 2, -d / 2, h + .001], [1, 0, 0], [0, 1, 0], g => {
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = iso.col('#A92A22'); g.lineWidth = .06; g.beginPath(); g.moveTo(.05, .05); g.lineTo(w / 2, d * .56); g.lineTo(w - .05, .05); g.stroke();
    // address strokes
    g.strokeStyle = iso.col('#F6E9DC', .9); g.lineWidth = .05;
    for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(w * .22, d * (.68 + i * .1)); g.lineTo(w * (.62 - i * .1), d * (.68 + i * .1)); g.stroke(); }
    // stamp (postal green, perforated)
    g.fillStyle = iso.col('#F6EFE0'); g.fillRect(w * .76, d * .12, .3, .36); g.fillStyle = iso.col(COL.post); g.fillRect(w * .76 + .04, d * .12 + .04, .22, .28);
    if (o.pm > 0) postmarkMark(g, w * .74, d * .34, .3, o.pm, o.pmText || ['北城', '10·31'], iso);
  });
  iso.keep = K; iso.pop();
}
// round postmark in ink: double ring + city + date + wavy cancel lines. drawn in the current (planar) transform
export function postmarkMark(g, cx, cy, r, a, txt, iso = null, o = {}) {
  if (a <= 0) return;
  const sc = o.pop ? lerp(1.35, 1, eo(a)) : 1, ink = o.ink || 'rgba(43,36,51,.86)';
  g.save(); g.translate(cx, cy); g.scale(sc, sc); g.rotate(o.rot ?? -.18); g.globalAlpha *= clamp(a * 3);
  g.strokeStyle = ink; g.lineWidth = r * .07; g.beginPath(); g.arc(0, 0, r, 0, TAU); g.stroke();
  g.lineWidth = r * .04; g.beginPath(); g.arc(0, 0, r * .78, 0, TAU); g.stroke();
  g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `700 ${r * .38}px NotoSC`; g.fillText(txt[0], 0, -r * .32);
  g.font = `500 ${r * .34}px Jost`; g.fillText(txt[1], 0, r * .2);
  g.beginPath(); g.moveTo(-r * .55, r * .02); g.lineTo(r * .55, r * .02); g.lineWidth = r * .03; g.stroke();
  g.lineWidth = r * .06; for (let i = 0; i < 3; i++) { g.beginPath(); for (let j = 0; j <= 16; j++) { const xx = r * 1.1 + j * r * .12 * (o.wave ?? 1), yy = -r * .35 + i * r * .35 + Math.sin(j * .9) * r * .07; j ? g.lineTo(xx, yy) : g.moveTo(xx, yy); } g.stroke(); }
  // worn ink: knock out a few speckles (deterministic)
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 26; i++) { g.beginPath(); g.arc((hash(i * 4.1) - .5) * r * 2.2, (hash(i * 7.3) - .5) * r * 2.2, r * .03 * (1 + hash(i)), 0, TAU); g.fill(); }
  g.restore();
}

// ---------- mailbox (post green, rounded top, slot on +y face) ----------
function vaultX(iso, x0, x1, yc, zc, r, t3, n = 12) { // half cylinder along x, flat side down
  const ring = []; for (let i = 0; i <= n; i++) { const a = Math.PI * i / n; ring.push([yc + Math.cos(a) * r, zc + Math.sin(a) * r]); }
  iso.face3(ring.map(p => [x0, p[0], p[1]]), t3, { out: [-1, 0, 0] });
  const sides = []; for (let i = 0; i < n; i++) sides.push(i);
  sides.sort((a, b) => (ring[a][0] + ring[a][1]) - (ring[b][0] + ring[b][1]));
  for (const i of sides) iso.face3([[x0, ring[i][0], ring[i][1]], [x1, ring[i][0], ring[i][1]], [x1, ring[i + 1][0], ring[i + 1][1]], [x0, ring[i + 1][0], ring[i + 1][1]]], t3, { out: [0, ring[i][0] + ring[i + 1][0] - 2 * yc, 1] });
  iso.face3(ring.map(p => [x1, p[0], p[1]]), t3, { out: [1, 0, 0] });
}
export function mailbox(iso, st, inside) {
  const x0 = MB.x - 1.2, y0 = MB.y - 1.0, w = 2.4, d = 2.0;
  iso.add(MB.x + MB.y + 2, () => {
    iso.boxNow(MB.x - .7, MB.y - .6, 0, 1.4, 1.2, .55, TR.dark);
    cutBox(iso, x0, y0, .55, w, d, 3.25, TR.post, st, inside, {
      th: .14, openTop: 3.55, slide: 1.4,
      skinDecal: (g, Y) => {
        iso.poly(scr(iso, [[x0 + .4, Y, 3.0], [x0 + w - .4, Y, 3.0], [x0 + w - .4, Y, 3.28], [x0 + .4, Y, 3.28]]), '#1F2A26');
        // envelope pictogram plate
        iso.poly(scr(iso, [[x0 + .75, Y, 1.55], [x0 + w - .75, Y, 1.55], [x0 + w - .75, Y, 2.45], [x0 + .75, Y, 2.45]]), '#F3EEE2');
        onPlane(iso, [x0 + .75, Y, 2.45], [1, 0, 0], [0, 0, -1], g2 => { g2.strokeStyle = iso.col(COL.post); g2.lineWidth = .07; g2.strokeRect(.12, .14, .66, .55); g2.beginPath(); g2.moveTo(.12, .14); g2.lineTo(.45, .45); g2.lineTo(.78, .14); g2.stroke(); });
      },
    });
    iso.boxNow(x0 - .15, y0 - .15, 3.8, w + .3, d + .3, .26, TR.post);
    vaultX(iso, x0 - .05, x0 + w + .05, MB.y, 4.06, 1.1, TR.post);
  });
}
// mailbox interior: letter pile
export function letterPile(iso) {
  for (let i = 0; i < 7; i++) { const r = hash(i * 3.3); iso.box(MB.x - .8 + r * .3, MB.y - .65 + hash(i * 5.1) * .3, .56 + i * .05, 1.3, .95, .05, i % 3 ? TR.white : TR.cream, { cull: false }); }
}

// ---------- post office: long sand building, +y wall cut away, belt + stamp + sorter inside ----------
export function postOffice(iso, t, st, inside) {
  const { x0, y0, x1, y1, h } = PO;
  const band = (Y) => iso.poly(scr(iso, [[x0, Y + .01, h - .9], [x1, Y + .01, h - .9], [x1, Y + .01, h - .25], [x0, Y + .01, h - .25]]), TR.post[1]);
  iso.add(x0 + y0 + 12, () => {
    cutBox(iso, x0, y0, 0, x1 - x0, y1 - y0, h, TR.wall, st, inside, {
      th: .22, slide: 2.4, top: true, inner: '#BFAF93', floor: '#E7DCC6',
      box: { decal: () => { iso.poly(scr(iso, [[x1 + .01, y0, h - .9], [x1 + .01, y1, h - .9], [x1 + .01, y1, h - .25], [x1 + .01, y0, h - .25]]), TR.post[2]); } },
      backDecal: (g, yb) => { // pigeonholes on the back wall
        for (let r = 0; r < 3; r++) for (let i = 0; i < 9; i++) { const xx = x0 + 1 + i * 1.5, zz = 2.6 + r * .62; iso.poly(scr(iso, [[xx, yb + .01, zz], [xx + 1.2, yb + .01, zz], [xx + 1.2, yb + .01, zz + .46], [xx, yb + .01, zz + .46]]), (i * 3 + r) % 4 ? '#A8977C' : '#9A8970'); }
      },
      skinDecal: (g, Y) => {
        windows(iso, x0, Y - (y1 - y0), 0, x1 - x0, y1 - y0, h - 1.2, 'y', 6, 1)();
        iso.poly(scr(iso, [[x0 + 1, Y, 0], [x0 + 2.6, Y, 0], [x0 + 2.6, Y, 2.6], [x0 + 1, Y, 2.6]]), '#5E5868');
        band(Y);
        onPlane(iso, [x0 + 6.5, Y + .02, h - .25], [1, 0, 0], [0, 0, -1], g2 => { g2.fillStyle = iso.col('#F3EEE2'); g2.fillRect(0, .08, 3, .5); g2.strokeStyle = iso.col(COL.post); g2.lineWidth = .06; g2.strokeRect(1.1, .16, .8, .34); g2.beginPath(); g2.moveTo(1.1, .16); g2.lineTo(1.5, .38); g2.lineTo(1.9, .16); g2.stroke(); });
      },
    });
  });
}
// belt + machines (drawn inside the PO sub-queue)
export function poInside(iso, t, beltPhase, stampZ, flipA, whites) {
  const { beltY, beltZ, stampX, flipX } = PO;
  iso.box(14.4, beltY - .8, beltZ - .25, 13.6, 1.6, .25, TR.road, { cull: false, bias: -9 });       // belt top
  for (let i = 0; i < 6; i++) iso.box(15 + i * 2.4, beltY - .1, 0, .2, .2, beltZ - .25, TR.dark, { cull: false, bias: -30 });
  // belt rollers stripes
  iso.add(15 + beltY + beltZ + .1, () => { const g = iso.g; for (let i = 0; i < 26; i++) { const xx = 14.4 + ((i * .55 + beltPhase) % 13.6); iso.poly(scr(iso, [[xx, beltY - .8, beltZ + .002], [xx + .08, beltY - .8, beltZ + .002], [xx + .08, beltY + .8, beltZ + .002], [xx, beltY + .8, beltZ + .002]]), '#5D5763'); } });
  // white letters riding the belt (context)
  for (const wx of whites) if (wx > 14.6 && wx < 27.6) iso.box(wx - .75, beltY - .5, beltZ, 1.5, 1.0, .07, TR.white, { cull: false, bias: 6 });
  // stamp machine: back post + arm + head
  iso.box(stampX - .4, beltY - 2.2, 0, .8, .7, 4.1, TR.steel, { cull: false });
  iso.box(stampX - .35, beltY - 2.0, 3.6, .7, 2.0, .45, TR.steel, { cull: false, bias: 8 });
  iso.box(stampX - .45, beltY - .55, stampZ, .9, 1.1, .5, TR.dark, { cull: false, bias: 9 });
  iso.box(stampX - .12, beltY - .1, stampZ + .5, .24, .24, 3.6 - stampZ - .5, TR.steel, { cull: false, bias: 8.5 });
  // sorter flipper + chute toward the truck
  iso.push(flipX, beltY - .8, beltZ + .02, flipA); iso.box(0, 0, 0, .14, 1.6, .5, TR.mustard, { cull: false }); iso.pop();
  iso.prism([[flipX + .2, beltY - .7], [30.2, beltY - .7], [30.2, beltY + .7], [flipX + .2, beltY + .7]], beltZ - .5, .12, TR.steel, { cull: false, bias: -.4 });
  // bins at the end
  iso.box(27.9, beltY - 1, 0, 1.6, 2, 1.4, TR.wood, { cull: false });
  // a worker at the back
  iso.bill(16.8, 23.0, 0, (g) => person(g, { C: c => iso.col(c), body: COL.post, hat: 'cap', hatColor: '#24704A', skin: '#C99773', h: 2.6, arm: .6 + Math.sin(Math.floor(t * 12) * .9) * .5 }), { cull: false, bias: -4 });
}

// ---------- truck (local frame: forward = +x) ----------
export function truck(iso, x, y, rot, st, inside, t = 0) {
  iso.push(x, y, 0, rot);
  iso.add(x + y + 2.5, () => {
    // wheels behind first (far side), cargo, cab
    const wheel = (wx) => iso.cylNow(wx, -1.45, .55, .55, 2.9, TR.dark, { axis: 'y', n: 14, capColor: '#3A3440' });
    wheel(-2); wheel(1.4);
    cutBox(iso, -3, -1.4, .75, 5.6, 2.8, 2.7, TR.post, st, inside, { th: .12, slide: 1.4, top: true, inner: '#2D5A40', floor: '#C7B79A',   // side + roof open, so the letter stays in view through the turn
      skinDecal: (g, Y) => { iso.poly(scr(iso, [[-2.8, Y, 1.7], [2.4, Y, 1.7], [2.4, Y, 2.1], [-2.8, Y, 2.1]]), '#F3EEE2'); } });
    iso.boxNow(2.6, -1.3, .6, 2.2, 2.6, 2.1, TR.post, { decal: () => {
      iso.poly(scr(iso, [[4.8, -1.0, 1.7], [4.8, 1.0, 1.7], [4.8, 1.0, 2.5], [4.8, -1.0, 2.5]]), '#8FA9B8');
      iso.poly(scr(iso, [[3.0, 1.3, 1.7], [4.3, 1.3, 1.7], [4.3, 1.3, 2.5], [3.0, 1.3, 2.5]]), '#8FA9B8');
    } });
    wheel(3.7);
  });
  iso.pop();
}
// mail sacks inside the truck / hold
export function sack(iso, x, y, z, s = 1, open = false) {
  iso.box(x - .45 * s, y - .4 * s, z, .9 * s, .8 * s, .8 * s, TR.sack, { cull: false });
  iso.box(x - .2 * s, y - .18 * s, z + .8 * s, .4 * s, .36 * s, .18 * s, TR.sack, { cull: false });
}

// ---------- plane (local: forward = +x). gear 0..1 ----------
export function plane(iso, x, y, z, rot, st, inside, gear = 1, bank = 0) {
  iso.push(x, y, z, rot);
  iso.add(x + y + z + 3, () => {
    iso.sub(() => {
      const fz = 1.6;
      // far wing, tail plane far
      iso.prism([[-.4, -.5], [1.6, -.5], [-1.4, -5.6], [-2.4, -5.6]], fz - .3, .14, TR.white, { cull: false });
      iso.prism([[-5.2, -.3], [-4.4, -.3], [-5.5, -2.2], [-6.0, -2.2]], fz + .3, .1, TR.white, { cull: false });
      iso.cyl(-.6, -2.6, fz - .75, .38, 1.4, TR.steel, { axis: 'x', n: 12, cull: false });
      if (gear > .05) { iso.box(.2, -.7, 0, .2, .2, (fz - 1.05) * gear + .05, TR.dark, { cull: false }); iso.box(3.6, -.1, 0, .2, .2, (fz - 1.05) * gear + .05, TR.dark, { cull: false }); }
      // fuselage
      iso.add(.5 + fz, () => {
        iso.cylNow(-5.6, 0, fz, 1.08, 10.2, TR.white, { axis: 'x', n: 22, stripe: i => (i === 5 || i === 6) ? hex(mix(COL.post, '#231A2C', .1)) : null });
        iso.sphereNow(4.6, 0, fz, 1.06, TR.white, { hi: false });
        // windows row + cheat line
        for (let i = 0; i < 11; i++) { const xx = -3.4 + i * .7; if (xx > -2.9 && xx < .7) continue; iso.poly(scr(iso, [[xx, 1.0, fz + .35], [xx + .32, 1.0, fz + .35], [xx + .32, .98, fz + .62], [xx, .98, fz + .62]]), '#6F8A9B'); }
        iso.poly(scr(iso, [[3.9, .7, fz + .5], [4.6, .5, fz + .55], [4.6, .45, fz + .8], [3.9, .62, fz + .82]]), '#4E6474');
        // cargo window cutaway on the +y side
        const g = iso.g, X0 = -2.7, X1 = .5, Z0 = fz - .75, Z1 = fz + .55, Y = 1.03;
        if (st.skin > 0) {
          g.save(); clipPoly(g, scr(iso, [[X0, Y, Z0], [X1, Y, Z0], [X1, Y, Z1], [X0, Y, Z1]]));
          iso.poly(scr(iso, [[X0, -1, Z0 - .4], [X1, -1, Z0 - .4], [X1, -1, Z1 + .5], [X0, -1, Z1 + .5]]), '#4C4656');
          iso.poly(scr(iso, [[X0, -1, Z0], [X1, -1, Z0], [X1, Y, Z0], [X0, Y, Z0]]), '#7C7484');
          iso.sub(() => inside && inside(iso));
          g.restore();
          const ra = seg(st.skin, .6, 1);
          if (ra > 0) { g.save(); g.globalAlpha = ra; const sp = clamp(iso.cam.k * .09, 4, 9);
            hatch(g, scr(iso, [[X0 - .14, Y, Z0 - .12], [X1 + .14, Y, Z0 - .12], [X1 + .14, Y, Z0], [X0 - .14, Y, Z0]]), { sp });
            hatch(g, scr(iso, [[X0 - .14, Y, Z1], [X1 + .14, Y, Z1], [X1 + .14, Y, Z1 + .12], [X0 - .14, Y, Z1 + .12]]), { sp });
            hatch(g, scr(iso, [[X0 - .14, Y, Z0], [X0, Y, Z0], [X0, Y, Z1], [X0 - .14, Y, Z1]]), { sp });
            hatch(g, scr(iso, [[X1, Y, Z0], [X1 + .14, Y, Z0], [X1 + .14, Y, Z1], [X1, Y, Z1]]), { sp }); g.restore(); }
          if (st.skin < 1) { const off = eo(st.skin) * 1.3, a = 1 - seg(st.skin, .1, .75); if (a > 0) iso.poly(scr(iso, [[X0, Y + off, Z0], [X1, Y + off, Z0], [X1, Y + off, Z1], [X0, Y + off, Z1]]), TR.white[1], a); }
        }
        if (st.line > 0 && st.skin < .5) cutLine(g, scr(iso, [[X0, Y, Z0], [X0, Y, Z1], [X1, Y, Z1], [X1, Y, Z0], [X0, Y, Z0]]), st.line, { lw: 2.5 });
      });
      // tail fin (stands on the fuselage, xz plane)
      iso.prism([[-5.6, -.08], [-4.0, -.08], [-4.0, .08], [-5.6, .08]], fz + .6, .05, TR.white, { cull: false, bias: .4 });
      iso.add(-4.6 + fz + 2, () => { const p = [[-5.7, 0, fz + .7], [-4.3, 0, fz + .9], [-5.4, 0, fz + 3.0], [-6.1, 0, fz + 3.0]]; iso.face3(p, TR.post, { both: true, color: TR.post[1] }); });
      // near wing + engine + tail plane near
      iso.prism([[-.4, .5], [1.6, .5], [-1.4, 5.6], [-2.4, 5.6]], fz - .3, .14, TR.white, { cull: false });
      iso.cyl(-.6, 2.6, fz - .75, .38, 1.4, TR.steel, { axis: 'x', n: 12, cull: false });
      iso.prism([[-5.2, .3], [-4.4, .3], [-5.5, 2.2], [-6.0, 2.2]], fz + .3, .1, TR.white, { cull: false });
      if (gear > .05) iso.box(.2, .5, 0, .2, .2, (fz - 1.05) * gear + .05, TR.dark, { cull: false });
    });
  });
  iso.pop();
}

let _layer = null;
function layer(iso) { if (!_layer) { const c = document.createElement('canvas'); c.width = iso.W; c.height = iso.H; _layer = c.getContext('2d'); } _layer.setTransform(1, 0, 0, 1, 0, 0); return _layer; }
// ---------- the recipient's house (+y wall is the door wall) ----------
export function house(iso, t, st, inside) {
  const { x0, y0, x1, y1, h, doorX, slotZ } = HOUSE;
  iso.add(x0 + y0 + 9, () => {
    cutBox(iso, x0, y0, 0, x1 - x0, y1 - y0, h, TR.wall, st, inside, { th: .2, slide: 2.0, top: true, inner: '#E6DAC2', floor: '#D9C29C',
      backDecal: (g, yb) => {
        iso.poly(scr(iso, [[x0 + 2, yb + .01, 1.6], [x0 + 4.2, yb + .01, 1.6], [x0 + 4.2, yb + .01, 3.4], [x0 + 2, yb + .01, 3.4]]), '#9DC3D8');
        iso.poly(scr(iso, [[x0 + 6.4, yb + .01, 2.2], [x0 + 7.6, yb + .01, 2.2], [x0 + 7.6, yb + .01, 3.2], [x0 + 6.4, yb + .01, 3.2]]), COL.mustard);
      },
      skinDecal: (g, Y) => {
        iso.poly(scr(iso, [[doorX - .8, Y, 0], [doorX + .8, Y, 0], [doorX + .8, Y, 2.9], [doorX - .8, Y, 2.9]]), '#5C5468');
        iso.poly(scr(iso, [[doorX - .55, Y + .01, slotZ - .1], [doorX + .55, Y + .01, slotZ - .1], [doorX + .55, Y + .01, slotZ + .14], [doorX - .55, Y + .01, slotZ + .14]]), '#C9A34A');
        iso.poly(scr(iso, [[doorX - .45, Y + .02, slotZ - .04], [doorX + .45, Y + .02, slotZ - .04], [doorX + .45, Y + .02, slotZ + .08], [doorX - .45, Y + .02, slotZ + .08]]), '#1E1A24');
        iso.poly(scr(iso, [[x0 + 1, Y, 1.4], [x0 + 3, Y, 1.4], [x0 + 3, Y, 3.0], [x0 + 1, Y, 3.0]]), '#8FA9B8');
        iso.poly(scr(iso, [[x1 - 3, Y, 1.4], [x1 - 1, Y, 1.4], [x1 - 1, Y, 3.0], [x1 - 3, Y, 3.0]]), '#8FA9B8');
      },
    });
    const lift = eo(st.skin) * 3.2, ra = 1 - seg(st.skin, .1, .75);
    if (ra > 0) { // the roof lifts and fades as one piece (drawn on its own layer so its faces don't ghost through each other)
      const L = layer(iso), g0 = iso.g; L.clearRect(0, 0, iso.W, iso.H); iso.g = L;
      iso.sub(() => { iso.roof(x0, y0, h + lift, x1 - x0, y1 - y0, 2.6, TR.roof, { ridge: 'x', over: .3 }); iso.box(x0 + 7.4, y0 + 1.6, h + .6 + lift, .8, .8, 2.0, TR.wall, { bias: 4 }); });
      iso.g = g0; g0.save(); g0.setTransform(1, 0, 0, 1, 0, 0); g0.globalAlpha = ra; g0.drawImage(L.canvas, 0, 0); g0.restore();
    }
  });
}
export function houseInside(iso, t, envDraw, recip) {
  const { x0, y0, x1, y1, doorX } = HOUSE;
  flatIn(iso, [[doorX - .75, y1 - 1.5], [doorX + .75, y1 - 1.5], [doorX + .75, y1 - .3], [doorX - .75, y1 - .3]], .012, '#6D6478');  // doormat
  flatIn(iso, [[x0 + 5.6, y0 + 2], [x0 + 9, y0 + 2], [x0 + 9, y0 + 5], [x0 + 5.6, y0 + 5]], .01, '#B5A6CF');                          // rug
  iso.box(x0 + 1.2, y0 + 1.2, 0, 2.2, 1.4, 1.1, TR.wood, { cull: false });       // table
  iso.cyl(x0 + 1.8, y0 + 1.7, 1.1, .1, .9, TR.dark, { cull: false });
  iso.cone(x0 + 1.8, y0 + 1.7, 1.8, .45, .5, TR.mustard, { cull: false });
  iso.box(x1 - 1.8, y0 + .6, 0, 1.2, 2.6, 2.4, TR.lav, { cull: false });         // cupboard
  if (envDraw) envDraw();
  if (recip) recip();
}
function flatIn(iso, pts, z, c) { iso.add(-1e3, () => iso.poly(pts.map(p => iso.L(p[0], p[1], z)), c)); }

// ---------- bike + courier billboard (unit = world units) ----------
export function bikeBill(g, t, k, dir = 1, pedal = 0, lean = 0, C = (c => c)) {
  g.save(); g.scale(dir, 1);
  const wr = .55, ink = '#2B2433';
  g.lineCap = 'round'; g.lineJoin = 'round';
  const wheel = (cx) => { g.beginPath(); g.arc(cx, -wr, wr, 0, TAU); g.lineWidth = .14; g.strokeStyle = C(ink); g.stroke(); g.beginPath(); g.arc(cx, -wr, .1, 0, TAU); g.fillStyle = C(ink); g.fill(); };
  wheel(-.85); wheel(.85);
  g.strokeStyle = C(COL.post); g.lineWidth = .12; g.beginPath(); g.moveTo(-.85, -wr); g.lineTo(-.15, -1.25); g.lineTo(.55, -1.25); g.lineTo(.85, -wr); g.moveTo(-.15, -1.25); g.lineTo(.05, -wr); g.lineTo(-.85, -wr); g.moveTo(.55, -1.25); g.lineTo(.65, -1.55); g.stroke();
  // front basket
  g.fillStyle = C('#CDB58C'); g.beginPath(); g.moveTo(.62, -1.2); g.lineTo(1.35, -1.2); g.lineTo(1.25, -1.62); g.lineTo(.7, -1.62); g.closePath(); g.fill();
  g.fillStyle = C('#B49B70'); g.fillRect(.95, -1.62, .35, .42);
  // courier
  const pa = pedal * TAU;
  g.save(); g.translate(-.15, -1.2);
  g.strokeStyle = C('#3E3846'); g.lineWidth = .17; g.beginPath(); g.moveTo(0, 0); g.lineTo(.25 + Math.cos(pa) * .25, .55 + Math.sin(pa) * .25); g.moveTo(0, 0); g.lineTo(.25 - Math.cos(pa) * .25, .55 - Math.sin(pa) * .25); g.stroke();
  g.rotate(.25 + lean);
  const B = tri(COL.post); g.beginPath(); g.moveTo(-.25, 0); g.lineTo(-.14, -.95); g.lineTo(.18, -.95); g.lineTo(.26, 0); g.closePath(); g.fillStyle = C(B[1]); g.fill();
  g.beginPath(); g.moveTo(.02, 0); g.lineTo(.02, -.95); g.lineTo(.18, -.95); g.lineTo(.26, 0); g.closePath(); g.fillStyle = C(B[2]); g.fill();
  g.strokeStyle = C(B[2]); g.lineWidth = .13; g.beginPath(); g.moveTo(.1, -.85); g.lineTo(.62, -.35); g.stroke();
  g.beginPath(); g.arc(0, -1.18, .22, 0, TAU); g.fillStyle = C('#C99773'); g.fill();
  g.beginPath(); g.arc(0, -1.24, .23, Math.PI, TAU); g.fillStyle = C('#24704A'); g.fill(); g.fillRect(0, -1.26, .36, .06);
  g.restore();
  g.restore();
}

// ---------- clouds: flat isometric puffs ----------
export const CLOUDS = [[70, 22, 9, 1.2], [84, 6, 11, 1.6], [98, -10, 8, 1.1], [62, 6, 12, .9], [106, 4, 13, 1.3], [78, -14, 10, 1.0], [120, -50, 9, .9], [28, 6, 10, .8]];
export function cloud(iso, x, y, z, s, a) {
  if (a <= 0) return;
  iso.add(x + y + z, () => {
    const g = iso.g, k = iso.cam.k; g.save(); g.globalAlpha = a;
    const puffs = [[0, 0, 1.6], [1.6, -.8, 1.2], [-1.5, .7, 1.1], [.6, 1.2, 1.0], [2.6, .3, .9]];
    for (const [dx, dy, r] of puffs) { const [sx, sy] = iso.P(x + dx * s * 2, y + dy * s * 2, z); g.beginPath(); g.ellipse(sx, sy + r * s * k * .5, r * s * k * 2.4, r * s * k * 1.2, 0, 0, TAU); g.fillStyle = '#E6E0D4'; g.fill(); }
    for (const [dx, dy, r] of puffs) { const [sx, sy] = iso.P(x + dx * s * 2, y + dy * s * 2, z); g.beginPath(); g.ellipse(sx, sy, r * s * k * 2.4, r * s * k * 1.2, 0, 0, TAU); g.fillStyle = '#FFFDF7'; g.fill(); }
    g.restore();
  }, 1);
}

// ---------- static dressing for both boards ----------
export function dressNorth(iso) {
  // street + sidewalk + runway
  flatRect(iso, 0, 33.2, 38.5, 37.6, '#7C7681', .03);
  dashes(iso, 0.5, 35.4, 38, 35.4);
  flatRect(iso, 0, 29.6, 38.5, 33.2, '#DCD2BE', .025);
  flatRect(iso, 30.2, 23.2, 41, 26.8, '#7C7681', .03);                // dock apron + access road
  iso.flat([[40.5, 23.2], [44.5, 25.4], [48.8, 29.4], [52, 29.4], [52, 32.6], [46.6, 32.6], [42.3, 28.6], [40.5, 26.8]], .03, '#7C7681');
  flatRect(iso, 39.5, 33, 60, 38, '#5E5866', .035);                    // runway
  for (let i = 0; i < 8; i++) flatRect(iso, 41 + i * 2.5, 35.3, 42.4 + i * 2.5, 35.7, '#F3EBDA', .04);
  for (let i = 0; i < 4; i++) { flatRect(iso, 40.1, 33.5 + i * 1.1, 40.9, 34.0 + i * 1.1, '#F3EBDA', .04); }
  // city blocks behind (far side), trees
  const B = [[2, 2, 5, 4, 5.5], [8.5, 2, 4, 5, 7.5], [14, 2, 6, 4, 4.5], [22, 2, 4, 4, 6], [2, 9, 4, 5, 4], [7.5, 9.5, 5, 4, 3.5], [32, 4, 5, 6, 3.4], [39, 3, 4, 4, 5], [45, 4, 6, 5, 3], [53, 3, 5, 6, 4.2], [2, 18, 5, 6, 3.2]];
  for (const b of B) block(iso, b[0], b[1], b[2], b[3], b[4]);
  const TRE = [[13, 10], [16, 11.5], [27, 12], [30.5, 15], [36, 12], [43, 14], [49, 12.5], [56, 14], [58, 20], [3, 27], [10, 25], [36, 30], [57, 27], [33, 17.5], [24, 16], [19, 15], [53, 22], [45, 20]];
  TRE.forEach((p, i) => tree(iso, p[0], p[1], .8 + hash(i) * .5, i % 3 === 0));
}
export function dressSouth(iso) {
  flatRect(iso, 107, -30, 135, -24, '#5E5866', .035);                 // runway
  for (let i = 0; i < 9; i++) flatRect(iso, 109 + i * 2.6, -27.2, 110.4 + i * 2.6, -26.8, '#F3EBDA', .04);
  flatRect(iso, 120, -23.6, 138.5, -21.4, '#C9DDB2', .03);              // bike lane (pale)
  iso.flat([[136.5, -23.6], [138.5, -23.6], [146, -32.2], [143.6, -32.2]], .03, '#C9DDB2');
  // pond (water)
  iso.flat([[150, -62], [160, -62], [160, -53], [154, -50], [150, -53]], .02, COL.water);
  // blocks + trees
  const B = [[108, -62, 5, 5, 4], [115, -62, 4, 6, 6], [121, -61, 6, 4, 3.5], [129, -62, 5, 5, 5], [136, -61, 5, 4, 3.6], [108, -52, 4, 5, 3.2], [113, -50, 5, 4, 4.5], [125, -52, 4, 6, 3], [131, -50, 6, 4, 4], [153, -44, 6, 5, 3.4], [153, -36, 6, 6, 4]];
  for (const b of B) block(iso, b[0], b[1], b[2], b[3], b[4]);
  const TRE = [[110, -41], [116, -40], [122, -42], [128, -40], [134, -41], [139, -45], [146, -46], [157, -26], [159, -20.5], [112, -21], [118, -20.5], [131, -19.8], [150, -24], [140, -20], [146, -21], [139, -55]];
  TRE.forEach((p, i) => tree(iso, p[0], p[1], .8 + hash(i + 9) * .5, i % 3 === 1));
}
