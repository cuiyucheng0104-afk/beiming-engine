// film.js — 岛屿之光: one silkscreen travel poster printed on camera.
// render(t) is a pure function of t (no Math.random / Date.now); every time comes from timeline.js.
import { makeTextures, paperSheet, ink, wipeRegion, wipeFront, squeegee, inkFinish, bandSteps,
  polyPath, rectPath, circlePath, ringPath, unionPath, mulberry, hash, mix, clamp, lerp } from './engine/silk.js';
import { B, bt, DUR, PULLS, ITEMS, CUE, events } from './timeline.js';

const W = 1920, H = 1080;
const ss = t => { t = clamp(t); return t * t * (3 - 2 * t); };
const eio = t => { t = clamp(t); return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const eo = t => 1 - Math.pow(1 - clamp(t), 3);
const ei = t => Math.pow(clamp(t), 3);
const seg = (t, a, b) => clamp((t - a) / (b - a));
const tb = b => bt(b);

// ---------- palette (≤ 6 inks + paper) ----------
export const INK = {
  paper: '#F3E9D2', sky: '#8CC3CF', sea: '#2E8C83', sand: '#E9C46A', red: '#D2452F', near: '#1D2B33', accent: '#FFF1C4',
};
INK.orange = mix(INK.red, INK.sand, .5);       // split-fountain blend of red + sand on the blade

// ---------- world ----------
const PO = [-500, -750], PW = 1000, PH = 1500;   // poster (units) on the bench, centred on the origin
const TX = 770, HY = 690;                        // tower axis, horizon
let ctx, T;

// ---------- poster geometry (poster units, 1000×1500) ----------
const bodyX = (y, side) => { const k = (y - 360) / 280; return TX + side * lerp(34, 52, k); };
function stripe(y0, y1, sx0 = -1, sx1 = 1) {
  return polyPath([[lerp(TX, bodyX(y0, -1), -sx0) , y0], [lerp(TX, bodyX(y0, 1), sx1), y0], [lerp(TX, bodyX(y1, 1), sx1), y1], [lerp(TX, bodyX(y1, -1), -sx0), y1]]);
}
function gull(x, y, s) {
  return polyPath([[x - s, y - .25 * s], [x - .55 * s, y - .6 * s], [x, y - .05 * s], [x + .55 * s, y - .6 * s], [x + s, y - .25 * s], [x + .55 * s, y - .4 * s], [x, y + .16 * s], [x - .55 * s, y - .4 * s]]);
}
function buildGeo() {
  const G = {};
  const body = polyPath([[TX - 34, 360], [TX + 34, 360], [TX + 52, 640], [TX - 52, 640]]);
  const beamL = polyPath([[TX, 322], [26, 288], [26, 424]]);
  const beamR = polyPath([[TX, 322], [974, 300], [974, 346]]);
  G.beam = unionPath([beamL, beamR]);
  G.towerKnock = unionPath([body, beamL, beamR]);
  // 1 sky: solid field, then stepped bands thinning toward the horizon; tower body and beams stay paper; tower shade face in sky ink
  const shadeFace = polyPath([[TX + 12, 360], [TX + 34, 360], [TX + 52, 640], [TX + 20, 640]]);
  G.sky = { path: unionPath([rectPath(26, 26, 948, 444), bandSteps(26, 948, 470, HY, 5), shadeFace]), knock: G.towerKnock };
  // 2 sea: flat body, glints + foam + sail knocked to paper; far islet on the horizon
  const glints = [], r = mulberry(5);
  for (let i = 0; i < 26; i++) {
    const y = 712 + Math.pow(r(), 1.3) * 300, x = 40 + r() * 620, w = 14 + r() * 70 * (1 - (y - 700) / 600);
    if (x + w > 560 && y > 760) continue;
    glints.push(rectPath(x, y, w, 3 + (y - 700) / 90));
  }
  const beachTop = [[26, 905], [120, 915], [240, 945], [360, 990], [470, 1050], [560, 1140]];
  const foam = polyPath([...beachTop.map(([x, y]) => [x, y - 14]), ...beachTop.slice().reverse().map(([x, y]) => [x + 6, y - 4])]);
  const foam2 = polyPath([[26, 866], [140, 874], [260, 902], [380, 944], [470, 990], [462, 998], [372, 954], [252, 912], [134, 884], [26, 877]]);
  const sail = polyPath([[296, 796], [296, 724], [344, 796]]);
  G.sea = { path: unionPath([rectPath(26, HY, 948, 1140 - HY), polyPath([[70, HY], [110, 676], [160, 664], [214, 672], [262, HY]])]), knock: unionPath([...glints, foam, foam2, sail]) };
  // 3 sand: beach, lit face of the headland, keeper's house wall
  const headland = [[540, 800], [585, 725], [630, 682], [690, 652], [702, 642], [850, 640], [910, 650], [974, 668], [974, 1010], [880, 985], [800, 950], [700, 900], [620, 850]];
  G.sand = { path: unionPath([polyPath([...beachTop, [26, 1140]]), polyPath(headland), rectPath(632, 604, 78, 46)]) };
  // 4 red: tower stripes, roof cap, house roof, boat hull
  G.red = { path: unionPath([stripe(410, 456), stripe(520, 566), polyPath([[TX - 40, 297], [TX + 40, 297], [TX + 22, 274], [TX, 262], [TX - 22, 274]]),
    polyPath([[622, 606], [671, 576], [720, 606]]), polyPath([[246, 798], [352, 798], [338, 814], [262, 814]])]) };
  // 5 accent (half a beat after red): the lamp
  G.lamp = { path: rectPath(TX - 27, 298, 54, 50) };
  // 6 near: shade facets, rocks, gallery, lantern cage, door, windows, gulls, mast, grass
  const rocks = polyPath([[600, 1140], [650, 1092], [712, 1070], [770, 1078], [830, 1050], [900, 1036], [974, 1046], [974, 1140]]);
  const shadeR = polyPath([[850, 640], [910, 650], [974, 668], [974, 1010], [880, 985], [858, 900], [884, 808], [862, 712]]);
  const shadeL = polyPath([[540, 800], [620, 850], [700, 900], [800, 950], [880, 985], [862, 948], [780, 912], [694, 866], [628, 822], [584, 790]]);
  const cage = unionPath([rectPath(TX - 52, 346, 104, 14), rectPath(TX - 30, 296, 5, 52), rectPath(TX - 2.5, 296, 5, 52), rectPath(TX + 25, 296, 5, 52), rectPath(TX - 3, 244, 6, 20), circlePath(TX, 242, 6)]);
  const door = rectPath(TX - 10, 606, 20, 34), win = unionPath([rectPath(TX - 6, 470, 12, 22), rectPath(652, 616, 14, 14), rectPath(686, 616, 14, 22)]);
  const mast = rectPath(294, 716, 4, 84);
  const grass = [];
  for (let i = 0; i < 9; i++) { const x = 40 + i * 52 + hash(i) * 20, y = 1140 - (i > 6 ? 40 : 0); grass.push(polyPath([[x - 14, y], [x - 6, y - 40 - hash(i + 3) * 30], [x, y - 12], [x + 6, y - 52 - hash(i + 7) * 30], [x + 12, y - 10], [x + 20, y - 30 - hash(i + 9) * 20], [x + 22, y]])); }
  const gulls = unionPath([gull(250, 540, 26), gull(318, 506, 18), gull(420, 566, 14)]);
  G.near = { path: unionPath([rocks, shadeR, shadeL, cage, door, win, mast, gulls, ...grass]) };
  // sun (accent, after the split fountain): disc + rings sitting on the horizon, reflection bars on the sea
  const sunSky = new Path2D(); sunSky.addPath(circlePath(300, HY, 98)); sunSky.addPath(ringPath(300, HY, 122, 134)); sunSky.addPath(ringPath(300, HY, 156, 164));
  const refl = []; for (let i = 0; i < 6; i++) { const w = 150 - i * 20; refl.push(rectPath(300 - w / 2 + (i % 2) * 8, 704 + i * 17, w, 6)); }
  G.sunSky = sunSky; G.sunSea = unionPath(refl);
  G.skyRect = rectPath(26, 26, 948, HY - 26);
  return G;
}
let G;

// ---------- pulls ----------
const PB = { full: [0, -20, 1000, 1540], sky: [26, 26, 948, HY - 26], band: [26, 1150, 948, 330], title: [26, 40, 948, 250] };
const pull = id => PULLS.find(p => p.id === id);
const prog = (id, t) => { const p = pull(id); return seg(t, tb(p.b0), tb(p.b1)); };
// the split-fountain blade in the sky close-up is tilted ~10° (STYLE §6), so its ragged front is sheared the same way;
// the wipe box is widened by the shear so the front clears the whole sky before the landing (no pop on the last frame)
const STL = 74, SY0 = -80, SY1 = 760, SYC = (SY0 + SY1) / 2, SK = 2 * STL / (SY1 - SY0);
const SHEAR = new DOMMatrix([1, 0, -SK, 1, SK * SYC, 0]);
const PB_SUNSET = [26 - 70, 26, 948 + 140, HY - 26];
const boxOf = p => p.id === 'sunset' ? PB_SUNSET : PB[p.reg];
function clipFor(id, t) {
  const p = pull(id), c = wipeRegion(boxOf(p), p.dir, prog(id, t), p.b0 * 3 + 1, 30);
  if (id !== 'sunset') return c;
  const sh = new Path2D(); sh.addPath(c, SHEAR); return sh;
}

// ---------- loose layers (registration slip) ----------
const LOOSE_OFF = { sky: [-30, -16, -.010], sea: [22, 10, .006], sand: [-16, 26, -.006], red: [34, -10, .012], lamp: [40, -14, .014], near: [-24, 18, .009] };
const LOOSE_H = { sky: 8, sea: 26, sand: 44, red: 62, lamp: 70, near: 84 };
function looseness(t) {
  if (t >= tb(CUE.snap)) return 0;
  return ss(seg(t, tb(CUE.lift) + .15, tb(CUE.silence) + .2));
}
// inside the near-silence the stack keeps breathing: a steady multi-plane rise (deeper layers drift less), and at b18 the top layer slips once
const silenceK = t => seg(t, tb(CUE.silence), tb(CUE.drop));
const slideK = t => eo(seg(t, tb(CUE.slide), tb(CUE.slide) + .42));

// ---------- camera ----------
function camAt(t) {
  const K = (a, b, k) => ({ cx: lerp(a.cx, b.cx, k), cy: lerp(a.cy, b.cy, k), z: lerp(a.z, b.z, k), roll: lerp(a.roll || 0, b.roll || 0, k), sq: lerp(a.sq ?? 1, b.sq ?? 1, k) });
  const FULL = { cx: 0, cy: -40, z: .74 };          // pushed in: the poster reads bigger against the bench
  if (t < tb(2)) {                                         // log-zoom pull-back out of the mesh, anchored on the stencil corner
    const k = eio(seg(t, 0, tb(2))), A = [PO[0] + 20, PO[1] + 20], C1 = [0, -520], z1 = 1.45;
    const z = Math.exp(lerp(Math.log(9), Math.log(z1), k)), s = [lerp(-140, (A[0] - C1[0]) * z1, k), lerp(-90, (A[1] - C1[1]) * z1, k)];
    return { cx: A[0] - s[0] / z, cy: A[1] - s[1] / z, z, roll: 0, sq: 1 };
  }
  if (t < tb(4)) return K({ cx: 0, cy: -520, z: 1.45 }, { cx: 0, cy: -560, z: 1.2, roll: -.035 }, ss(seg(t, tb(2), tb(4))));
  if (t < tb(6)) {                                         // follow the first blade down
    const y = PO[1] + wipeFront(PB.full, 'down', prog('sky', t), 30);
    return { cx: 0, cy: clamp(y - 60, -560, -250), z: 1.2, roll: lerp(-.035, -.015, seg(t, tb(4), tb(6))), sq: 1 };
  }
  if (t < tb(7)) return K({ cx: 0, cy: -250, z: 1.2, roll: -.015 }, FULL, eo(seg(t, tb(6), tb(7))));
  const P0 = { cx: 0, cy: -55, z: .78 };
  if (t < tb(14)) return K(FULL, P0, ss(seg(t, tb(7), tb(14))));
  const P1 = { cx: 40, cy: -70, z: .84, roll: -.06, sq: .84 }, P2 = { cx: 96, cy: -150, z: .93, roll: -.10, sq: .77 };
  if (t < tb(16)) return K(P0, P1, eio(seg(t, tb(14), tb(16))));
  if (t < tb(19.5)) { const k = seg(t, tb(16), tb(19.5)); return K(P1, P2, lerp(k, ss(k), .35)); }   // one continuous crane through the silence (no hold)
  if (t < tb(20)) return K(P2, P0, ei(seg(t, tb(19.5), tb(20))));
  const SKY0 = { cx: -300, cy: -392, z: 1.6, roll: .012 }, SKY1 = { cx: 300, cy: -392, z: 1.6, roll: .012 };
  if (t < tb(20.5)) { const k = seg(t, tb(20), tb(20.5)), a = 7 * (1 - k) * (1 - k); return { cx: P0.cx + Math.sin(t * 95) * a, cy: P0.cy + Math.cos(t * 81) * a, z: P0.z, roll: 0, sq: 1 }; }
  if (t < tb(22)) return K(P0, SKY0, eio(seg(t, tb(20.5), tb(22))));
  if (t < tb(26)) return K(SKY0, SKY1, seg(t, tb(22), tb(26)));
  const F2 = { cx: 0, cy: 18, z: .69 }, F3 = { cx: 0, cy: 30, z: .705 };
  if (t < tb(27)) return K(SKY1, F2, eo(seg(t, tb(26), tb(27))));
  if (t < tb(32)) return K(F2, F3, ss(seg(t, tb(27), tb(32))));
  const END = { cx: 26, cy: 14, z: .60 };
  if (t < tb(33.3)) return K(F3, END, eo(seg(t, tb(32), tb(33.3))));
  return K(END, { cx: 28, cy: 14, z: .606 }, seg(t, tb(33.3), DUR));
}
function applyCam(c) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.translate(W / 2, H / 2); ctx.rotate(c.roll); ctx.scale(c.z, c.z * c.sq); ctx.translate(-c.cx, -c.cy); }
function toScreen(c, x, y) {               // world → screen (the one mapping every text box uses)
  const dx = (x - c.cx) * c.z, dy = (y - c.cy) * c.z * c.sq, cs = Math.cos(c.roll), sn = Math.sin(c.roll);
  return [W / 2 + dx * cs - dy * sn, H / 2 + dx * sn + dy * cs];
}

// ---------- bench ----------
let BENCH;
function buildBench() {
  const r = mulberry(31), planks = [], stains = [], tapes = [];
  const x0 = -2600, x1 = 2600, y0 = -1700, y1 = 1700, ph = 190;
  const tones = ['#6E5039', '#664A34', '#73553C', '#6A4C35', '#5F4430'];
  for (let y = y0, k = 0; y < y1; y += ph, k++) {
    const grain = new Path2D(), knots = new Path2D();
    for (let g = 0; g < 7; g++) { const gy = y + 16 + g * 25 + r() * 8, amp = 3 + r() * 5, f = .002 + r() * .003, p0 = r() * 6; grain.moveTo(x0, gy); for (let x = x0; x <= x1; x += 40) grain.lineTo(x, gy + amp * Math.sin(x * f + p0) + 2 * Math.sin(x * f * 3.7)); }
    for (let q = 0; q < 3; q++) knots.ellipse(x0 + r() * (x1 - x0), y + 30 + r() * (ph - 60), 22 + r() * 18, 7 + r() * 5, 0, 0, 7);
    planks.push({ y, color: tones[k % 5], grain, knots });
  }
  const cols = [INK.sky, INK.sea, INK.red, INK.near, INK.sand];
  const avoid = (x, y) => x > -680 && x < 680 && y > -930 && y < 930;
  for (let i = 0; i < 5; i++) {
    let x, y, n = 0; do { x = x0 + 400 + r() * (x1 - x0 - 800); y = y0 + 300 + r() * (y1 - y0 - 600); n++; } while (avoid(x, y) && n < 40);
    const R = 80 + r() * 90, pts = [], m = 13; for (let j = 0; j < m; j++) { const a = j / m * 6.283, rr = R * (.55 + .6 * r()) * (j % 3 ? 1 : 1.25); pts.push([x + Math.cos(a) * rr * 1.6, y + Math.sin(a) * rr * .45]); }
    const path = new Path2D(); pts.forEach((q, j) => { const nq = pts[(j + 1) % m]; if (!j) path.moveTo((q[0] + nq[0]) / 2, (q[1] + nq[1]) / 2); else path.quadraticCurveTo(q[0], q[1], (q[0] + nq[0]) / 2, (q[1] + nq[1]) / 2); }); path.closePath();
    if (r() < .4) { const sm = new Path2D(); sm.rect(x - R * 2.4, y - 5, R * 1.8, 10 + r() * 6); path.addPath(sm); }
    stains.push({ path, col: mix(cols[i % 5], '#5E432E', .84) });     // old ink soaked into the wood: close to the plank colour
  }
  for (let i = 0; i < 6; i++) { let x, y, n = 0; do { x = x0 + 400 + r() * (x1 - x0 - 800); y = y0 + 300 + r() * (y1 - y0 - 600); n++; } while (avoid(x, y) && n < 40); tapes.push({ x, y, w: 60 + r() * 120, h: 22 + r() * 8, a: (r() - .5) * .6, torn: r() < .6 }); }
  return { planks, stains, tapes, x0, x1, ph };
}
function bench() {
  const TB = BENCH || (BENCH = buildBench());
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#6B4E36'; ctx.fillRect(0, 0, W, H); ctx.restore();
  for (const p of TB.planks) {
    ctx.fillStyle = p.color; ctx.fillRect(TB.x0, p.y, TB.x1 - TB.x0, TB.ph);
    ctx.fillStyle = 'rgba(35,22,12,.55)'; ctx.fillRect(TB.x0, p.y, TB.x1 - TB.x0, 5);
    ctx.fillStyle = 'rgba(255,230,190,.07)'; ctx.fillRect(TB.x0, p.y + 5, TB.x1 - TB.x0, 3);
    ctx.save(); ctx.strokeStyle = 'rgba(40,24,12,.22)'; ctx.lineWidth = 2; ctx.stroke(p.grain); ctx.fillStyle = 'rgba(40,24,12,.25)'; ctx.fill(p.knots); ctx.restore();
  }
  for (const s0 of TB.stains) { ctx.save(); ctx.globalAlpha = .38; ctx.fillStyle = s0.col; ctx.fill(s0.path); ctx.restore(); }
  for (const tp of TB.tapes) {
    ctx.save(); ctx.translate(tp.x, tp.y); ctx.rotate(tp.a); ctx.fillStyle = 'rgba(214,196,152,.8)';
    ctx.beginPath(); ctx.moveTo(-tp.w / 2, -tp.h / 2); ctx.lineTo(tp.w / 2, -tp.h / 2);
    if (tp.torn) for (let k = 0; k <= 5; k++) ctx.lineTo(tp.w / 2 + (k % 2 ? -6 : 3), -tp.h / 2 + tp.h * k / 5); else ctx.lineTo(tp.w / 2, tp.h / 2);
    ctx.lineTo(-tp.w / 2, tp.h / 2); ctx.closePath(); ctx.fill(); ctx.restore();
  }
}
function regTape() {
  const [x, y] = PO, w = PW, h = PH, L = 70, th = 18; ctx.fillStyle = '#D9C38A';
  for (const [px, py, sx, sy] of [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]]) {
    ctx.fillRect(Math.min(px, px + sx * L), py + (sy < 0 ? -th : 0) - sy * 2, L, th);
    ctx.fillRect(px + (sx < 0 ? -th : 0) - sx * 2, Math.min(py, py + sy * L), th, L);
  }
}

// ---------- poster ----------
const REG = { sky: [1.5, -1], sea: [-1.2, 1.4], sand: [2, 1.2], red: [-1.6, -1.2], lamp: [1.2, 1.6], near: [-1, 1], sunset: [1.4, -1.2], sun: [-1.2, 1], band: [1, 1.2], title: [-1.4, .8] };
const TEXT = {};                       // text boxes (poster units), filled by the paint functions
function paperFill() { const p = ctx.createPattern(T.paper, 'repeat'); p.setTransform(new DOMMatrix([.6, 0, 0, .6, 0, 0])); return p; }

function drawPoster(t, c) {
  ctx.save(); ctx.translate(PO[0], PO[1]);
  ctx.save(); ctx.globalAlpha = .26; ctx.fillStyle = '#000'; ctx.fillRect(8, 12, PW, PH); ctx.restore();
  paperSheet(ctx, T, 0, 0, PW, PH);
  const L = looseness(t), tilt = 1 - c.sq;
  const drift = k => [Math.sin(t * 1.3 + k) * 6 * L, Math.cos(t * 1.1 + k * 2) * 5 * L];
  // split fountain sunset: stepped bands of sand → orange → red. Its stencil blocks everything already printed in the sky
  // (headland, house, islet, lantern, gulls) — drawn right above the sky ink so those shapes stay; beams and tower body stay paper
  const sunset = () => { if (prog('sunset', t) > 0) ink(ctx, { path: G.skyRect, paint: (g) => {
    g.save(); const k = new Path2D(); k.addPath(G.skyRect); k.addPath(G.towerKnock); g.clip(k, 'evenodd');
    g.fillStyle = INK.red; g.fillRect(26, 26, 948, HY - 26);
    g.fillStyle = INK.orange; g.fillRect(26, 26, 948, 454); g.fill(bandSteps(26, 948, 480, 640, 5));
    g.fillStyle = INK.sand; g.fillRect(26, 26, 948, 274); g.fill(bandSteps(26, 948, 300, 450, 5));
    g.restore();
  } }, { color: INK.red, reg: REG.sunset, clip: prog('sunset', t) < 1 ? clipFor('sunset', t) : null }); };
  const sunDisc = () => {                        // the sun sits under the later inks too (islet, gulls stay on top)
    if (prog('sun', t) <= 0) return;
    ctx.save(); ctx.beginPath(); ctx.rect(26, 26, 948, HY - 26); ctx.clip();
    ink(ctx, { path: G.sunSky }, { color: INK.accent, reg: REG.sun, clip: prog('sun', t) < 1 ? clipFor('sun', t) : null, sheen: 1 });
    ctx.restore();
  };
  // the six base inks
  ['sky', 'sea', 'sand', 'red', 'lamp', 'near'].forEach((id, k) => {
    const p = prog(id, t); if (p <= 0) return;
    const part = G[id], color = INK[pull(id).ink];
    ctx.save();
    if (L > 0) {
      const sk = silenceK(t), dep = LOOSE_H[id] / 84, sl = id === 'near' ? slideK(t) : 0;
      const [ox, oy, rot] = LOOSE_OFF[id], [dx, dy] = drift(k), hgt = LOOSE_H[id] * L * (.6 + tilt * 6) * (1 + .45 * sk);
      const px = (-38 * dep * sk + 34 * sl) * L, py = (-20 * dep * sk + 12 * sl) * L;     // multi-plane parallax: top layers travel further
      ctx.translate(500, 700); ctx.rotate((rot + .012 * sl) * L); ctx.translate(-500, -700);
      ctx.translate(ox * L + dx + px, oy * L + dy - hgt + py);
      // paper-thickness shadow of the loose layer
      ctx.save(); ctx.translate(7 + hgt * .35, 11 + hgt * .55); ctx.globalAlpha = .22 * L; ctx.fillStyle = '#1a120c';
      if (part.knock) { const q = new Path2D(); q.addPath(part.path); q.addPath(part.knock); ctx.fill(q, 'evenodd'); } else ctx.fill(part.path); ctx.restore();
    }
    ink(ctx, part, { color, reg: REG[id], clip: p < 1 ? clipFor(id, t) : null, sheen: 1, trap: 1 });
    ctx.restore();
    if (id === 'sky') { sunset(); sunDisc(); }
  });
  // sun (accent, half a beat after the sunset)
  if (prog('sun', t) > 0) {
    const cl = prog('sun', t) < 1 ? clipFor('sun', t) : null;
    ink(ctx, { path: G.sunSea }, { color: INK.accent, reg: REG.sun, clip: cl ? wipeRegion([26, 26, 948, 900], 'down', prog('sun', t), 9, 30) : null, sheen: .6 });
  }
  // info band (near) with the island name knocked out to paper
  if (prog('band', t) > 0) ink(ctx, { path: rectPath(26, 1160, 948, 314), paint: (g) => {
    g.fillStyle = INK.near; g.fillRect(26, 1160, 948, 314);
    g.fillStyle = paperFill(); g.font = '400 128px QK'; g.textBaseline = 'alphabetic';
    trackText(g, '白鸥岛', 66, 1306, 10, 'BAND_NAME');
  } }, { color: INK.near, reg: REG.band, clip: prog('band', t) < 1 ? clipFor('band', t) : null });
  // title (near ink, chosen by contrast against the sand band) + Latin line
  if (prog('title', t) > 0) ink(ctx, { path: rectPath(26, 40, 948, 250), paint: (g) => {
    g.fillStyle = INK.near; g.font = '400 178px QK'; g.textBaseline = 'alphabetic';
    trackCentered(g, '岛屿之光', 470, 196, 34, 'TITLE');
    g.font = '800 44px BSD'; trackCentered(g, 'ISLAND LIGHT', 470, 268, 20, 'LATIN');
  } }, { color: INK.near, reg: REG.title, clip: prog('title', t) < 1 ? clipFor('title', t) : null });
  // info items, stamped left to right
  ITEMS.forEach((it, k) => {
    const p = seg(t, tb(it.b) - .18, tb(it.b)); if (p <= 0) return;
    const box = [[60, 1318, 880, 22], [62, 1352, 290, 110], [372, 1352, 280, 110], [672, 1352, 290, 110]][k];
    const clip = p < 1 ? wipeRegion(box, 'right', p, 40 + k, 14) : null;
    ctx.save(); if (clip) ctx.clip(clip); ctx.translate(...REG.title);
    if (it.id === 'rule') { ctx.fillStyle = INK.red; ctx.fillRect(66, 1326, 868, 7); }
    else {
      const [x] = box, lab = { ferry: '渡轮', height: '灯高', sunset: '日落' }[it.id];
      ctx.fillStyle = INK.sky; ctx.font = '700 38px NotoSC'; trackText(ctx, lab, x + 4, 1392, 8, 'L_' + it.id);
      ctx.fillStyle = INK.accent;
      if (it.id === 'ferry') { ctx.font = '700 62px NotoSC'; trackText(ctx, '每日三班', x + 2, 1454, 2, 'V_' + it.id); }
      if (it.id === 'height') { ctx.font = '800 76px BSD'; const w = trackText(ctx, '32', x + 2, 1454, 2, 'V_' + it.id); ctx.font = '700 44px NotoSC'; trackText(ctx, '米', x + 10 + w, 1452, 0, 'U_' + it.id); }
      if (it.id === 'sunset') { ctx.font = '800 76px BSD'; trackText(ctx, '18:40', x + 2, 1454, 3, 'V_' + it.id); }
    }
    ctx.restore();
  });
  inkFinish(ctx, T, 0, 0, PW, PH);
  // wet sheen behind each blade, going matte within ~0.6 s of the landing (a material change, not a fade transition)
  for (const p of PULLS) {
    const a = tb(p.b0), b = tb(p.b1); if (t < a || t > b + .6) continue;
    const wet = 1 - seg(t, b, b + .6), box = boxOf(p), f = wipeFront(box, p.dir, prog(p.id, t), 30);
    ctx.save(); ctx.beginPath(); ctx.rect(26, 26, 948, 1448); ctx.clip(); ctx.globalAlpha = wet;
    if (p.id === 'sunset') ctx.transform(1, 0, -SK, 1, SK * SYC, 0);
    let g;
    if (p.dir === 'down') { g = ctx.createLinearGradient(0, f - 360, 0, f); ctx.fillStyle = g; }
    else { g = ctx.createLinearGradient(f - 420, 0, f, 0); }
    g.addColorStop(0, 'rgba(255,250,235,0)'); g.addColorStop(.7, 'rgba(255,250,235,.07)'); g.addColorStop(1, 'rgba(255,250,235,.26)');
    ctx.fillStyle = g;
    if (p.dir === 'down') ctx.fillRect(box[0], Math.max(box[1], f - 360), box[2], Math.min(360, f - box[1]));
    else ctx.fillRect(Math.max(box[0], f - 420), box[1], Math.min(420, f - box[0]), box[3]);
    ctx.restore();
  }
  ctx.restore();
}
function trackText(g, s, x, y, tr, id) {
  let xx = x; for (const ch of s) { g.fillText(ch, xx, y); xx += g.measureText(ch).width + tr; }
  const w = xx - x - tr; if (id) { const m = g.measureText(s); TEXT[id] = [x, y - (m.actualBoundingBoxAscent || 50), x + w, y + (m.actualBoundingBoxDescent || 8)]; }
  return w;
}
function trackCentered(g, s, cx, y, tr, id) {
  let w = 0; for (const ch of s) w += g.measureText(ch).width + tr; w -= tr;
  return trackText(g, s, cx - w / 2, y, tr, id);
}

// ---------- screen (hinged frame + mesh) ----------
const SBOX = [PO[0] - 74, PO[1] - 74, PW + 148, PH + 148], SFW = 46;
function screenLift(t) {
  const up1 = ss(seg(t, tb(CUE.lift), tb(CUE.lift) + .4)), down = ei(seg(t, tb(CUE.drop), tb(CUE.snap)));
  const up2 = ss(seg(t, tb(CUE.final), tb(CUE.final) + .4));
  if (t < tb(CUE.drop)) return up1;
  if (t < tb(CUE.final)) return 1 - down;
  return up2;
}
function screen(t, c) {
  const lift = screenLift(t); if (lift >= 1) return;
  const [x, y, w, h] = SBOX, fw = SFW, k = 1 - .55 * lift, sh = 30 * lift + 8;
  ctx.save(); ctx.translate(0, y); ctx.scale(1, k); ctx.translate(0, -y);
  // ring shadow (even-odd), never a full rectangle
  ctx.save(); ctx.globalAlpha = .24 + .1 * lift; ctx.fillStyle = '#000';
  const shp = new Path2D(); shp.rect(x + sh * .6, y + sh, w, h); shp.rect(x + sh * .6 + fw, y + sh + fw, w - fw * 2, h - fw * 2); ctx.fill(shp, 'evenodd'); ctx.restore();
  // mesh: faint tint while printing, threads read only when the camera is close
  ctx.save(); ctx.beginPath(); ctx.rect(x + fw, y + fw, w - fw * 2, h - fw * 2); ctx.clip();
  ctx.fillStyle = 'rgba(236,214,128,.05)'; ctx.fillRect(x, y, w, h);
  // emulsion outside the open stencil
  const emu = new Path2D(); emu.rect(x, y, w, h); emu.rect(PO[0] + 20, PO[1] + 20, PW - 40, PH - 40);
  ctx.globalAlpha = .5; ctx.fillStyle = '#2E6F78'; ctx.fill(emu, 'evenodd'); ctx.globalAlpha = 1;
  const meshA = clamp((c.z - 1.15) / 2.5);
  if (meshA > 0) {
    const st = 3.4, x0 = c.cx - W / 2 / c.z - 10, x1 = c.cx + W / 2 / c.z + 10, y0 = c.cy - H / 2 / c.z - 10, y1 = c.cy + H / 2 / c.z + 10;
    ctx.lineWidth = .9; ctx.strokeStyle = `rgba(92,78,40,${.22 * meshA})`; ctx.beginPath();
    for (let xx = Math.floor(x0 / st) * st; xx < x1; xx += st) { ctx.moveTo(xx, y0); ctx.lineTo(xx, y1); }
    for (let yy = Math.floor(y0 / st) * st; yy < y1; yy += st) { ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); }
    ctx.stroke();
    ctx.lineWidth = .35; ctx.strokeStyle = `rgba(255,250,225,${.35 * meshA})`; ctx.beginPath();     // thread highlights: light through the weave
    for (let xx = Math.floor(x0 / st) * st; xx < x1; xx += st) { ctx.moveTo(xx - .3, y0); ctx.lineTo(xx - .3, y1); }
    for (let yy = Math.floor(y0 / st) * st; yy < y1; yy += st) { ctx.moveTo(x0, yy - .3); ctx.lineTo(x1, yy - .3); }
    ctx.stroke();
  }
  ctx.restore();
  // aluminium frame, inner lip, tape, hinge clamps
  const fr = new Path2D(); fr.rect(x, y, w, h); fr.rect(x + fw, y + fw, w - fw * 2, h - fw * 2);
  ctx.fillStyle = '#B7B2A6'; ctx.fill(fr, 'evenodd');
  const inner = new Path2D(); inner.rect(x + fw - 6, y + fw - 6, w - fw * 2 + 12, h - fw * 2 + 12); inner.rect(x + fw, y + fw, w - fw * 2, h - fw * 2);
  ctx.fillStyle = '#8E897E'; ctx.fill(inner, 'evenodd'); ctx.fillStyle = '#D6D1C4'; ctx.fillRect(x, y, w, 6);
  ctx.fillStyle = '#3C6E9E'; ctx.fillRect(x + fw, y + fw, w - fw * 2, 11); ctx.fillRect(x + fw, y + h - fw - 11, w - fw * 2, 11); ctx.fillRect(x + fw, y + fw, 11, h - fw * 2); ctx.fillRect(x + w - fw - 11, y + fw, 11, h - fw * 2);
  ctx.restore();
  // hinge clamps on the top edge (fixed to the bench)
  for (const hx of [x + 170, x + w - 250]) { ctx.fillStyle = '#4A4540'; ctx.fillRect(hx, y - 46, 80, 50); ctx.fillStyle = '#9A958B'; ctx.fillRect(hx + 8, y - 40, 64, 14); ctx.fillStyle = '#2D2A27'; ctx.beginPath(); ctx.arc(hx + 40, y - 12, 10, 0, 7); ctx.fill(); }
}

// ---------- squeegee ----------
function beadFor(id) {
  if (id === 'sunset') { const y0 = -80, y1 = 760, tt = y => (y - y0) / (y1 - y0); return [{ t0: tt(26), t1: tt(370), color: INK.sand }, { t0: tt(370), t1: tt(550), color: INK.orange }, { t0: tt(550), t1: tt(HY), color: INK.red }]; }
  return [{ t0: .03, t1: .97, color: INK[pull(id).ink] }];
}
function blades(t) {
  const S = (a, b, lead, o) => squeegee(ctx, [PO[0] + a[0], PO[1] + a[1]], [PO[0] + b[0], PO[1] + b[1]], lead, o);
  // set down (b1.5 → b2) and loaded by the pour (b3)
  if (t >= tb(1.5) && t < tb(4)) {
    const k = eo(seg(t, tb(1.5), tb(2))), y = lerp(-520, -64, k), fill = eo(seg(t, tb(3), tb(3) + .2));
    S([-60, y], [1060, y], [0, 1], { beads: fill > 0 ? [{ t0: lerp(.48, .03, fill), t1: lerp(.52, .97, fill), color: INK.sky }] : [], scale: 1.3, seed: 2, roll: 0, bead: 24 * fill + .01 });
    if (t >= tb(3) && t < tb(3) + .3) {               // pour stream
      const s = 1 - seg(t, tb(3) + .1, tb(3) + .3);
      ctx.fillStyle = INK.sky; ctx.fillRect(PO[0] + 500 - 9 * s, PO[1] - 1400, 18 * s, 1340);
    }
    return;
  }
  for (const p of PULLS) {
    const a = tb(p.b0), b = tb(p.b1), EXIT = .25;
    if (t < a || t > b + EXIT || (p.id === 'title' && t > b)) continue;   // title blade goes to rest (below)
    const box = boxOf(p);
    // steady linear pull; after the landing the blade is lifted away fast and leaves frame
    const f = wipeFront(box, p.dir, prog(p.id, t), 30) + 12 + (t > b ? 1600 * ei((t - b) / EXIT) : 0);
    if (p.dir === 'down') {
      const x0 = p.reg === 'full' ? -60 : box[0] - 34, x1 = p.reg === 'full' ? 1060 : box[0] + box[2] + 34;
      S([x0, f], [x1, f], [0, 1], { beads: beadFor(p.id), seed: p.b0 * 7, roll: f / 30, scale: 1.3 });
    } else {
      // close-up: blade tilted ~10° and the handle reduced to a short stub that runs out of the top of frame (STYLE §6), so the frame is not cut in two
      const nl = Math.hypot(SY1 - SY0, 2 * STL);
      S([f + STL, SY0], [f - STL, SY1], [(SY1 - SY0) / nl, 2 * STL / nl], { beads: beadFor(p.id), seed: 11, roll: f / 30, scale: 1.45, bead: 30, handle: .8, handleSpan: [0, .19] });
    }
  }
  // after the title, the squeegee is laid down on the bench
  if (t >= tb(28)) {
    const k = eio(seg(t, tb(28), tb(CUE.rest)));
    const cx = lerp(0, 860, k), cy = lerp(PO[1] + 290 + 12, 40, k), ang = lerp(0, Math.PI / 2, k), L = 560;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    squeegee(ctx, [cx - ux * L, cy - uy * L], [cx + ux * L, cy + uy * L], [-uy, ux], { beads: [{ t0: .05, t1: .95, color: INK.near }], seed: 4, roll: 0, scale: 1.3, bead: 10 });
  }
}

// ---------- frame ----------
export function render(t) {
  const c = camAt(t);
  applyCam(c);
  bench();
  regTape();
  drawPoster(t, c);
  screen(t, c);
  blades(t);
}

// ---------- texts for readcheck ----------
const TEXT_LIST = [
  { id: 'TITLE', text: '岛屿之光', from: 27.5 }, { id: 'LATIN', text: 'ISLAND LIGHT', from: 27.5 }, { id: 'BAND_NAME', text: '白鸥岛', from: 26.5 },
  { id: 'L_ferry', text: '渡轮 每日三班', from: 29.5, box2: 'V_ferry' }, { id: 'L_height', text: '灯高 32米', from: 30, box2: 'U_height' }, { id: 'L_sunset', text: '日落 18:40', from: 30.5, box2: 'V_sunset' },
];
export function texts(t) {
  const c = camAt(t), out = [];
  for (const e of TEXT_LIST) {
    if (t < tb(e.from) - .18 || !TEXT[e.id]) continue;
    let [x0, y0, x1, y1] = TEXT[e.id];
    if (e.box2 && TEXT[e.box2]) { const b = TEXT[e.box2]; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
    const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => toScreen(c, PO[0] + x, PO[1] + y));
    out.push({ id: e.id, text: e.text, x0: Math.min(...pts.map(p => p[0])), y0: Math.min(...pts.map(p => p[1])), x1: Math.max(...pts.map(p => p[0])), y1: Math.max(...pts.map(p => p[1])) });
  }
  return out;
}

export function setup(canvas) {
  ctx = canvas.getContext('2d');
  T = makeTextures(INK.paper, 54);
  G = buildGeo();
  // prime text boxes once (paint functions record them)
  render(DUR - .01);
  return { dur: DUR, ev: events() };
}
