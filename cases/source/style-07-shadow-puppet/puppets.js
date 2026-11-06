// 渔夫还珠 — the carved pieces: fisherman (10 pieces + beard), boat, oar, net, pearl, dragon (head, jaw, 7 body segments),
// wave strips (3 rows × 3 swap variants), spray, rain-cloud, title plaque.
// Units = cloth px at camera 1×. Every piece is a transmittance sprite (carve.js); drawn with multiply.
import { piece, drawPiece, fill, cut, cutLine, ink, within, smooth, poly, scales, scalesOpen, lattice, coin, cloud, beads, beadLine, plum, waves, meander, flameTongue, cutTaper, strata, DYE } from './carve.js';
import { mulberry, clamp, lerp } from '/core/lib.js';

// ---------- matrices: [a,b,c,d,e,f]  x' = a x + c y + e ----------
export const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
export const Tm = (x, y) => [1, 0, 0, 1, x, y];
export const Rm = a => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
export const Sm = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];
export const ap = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
export const chain = (...Ms) => Ms.reduce((A, B) => mul(A, B));
export function put(g, M, p, alpha = 1) {
  g.save(); g.globalCompositeOperation = 'multiply'; g.globalAlpha = alpha; g.setTransform(...M); drawPiece(g, p); g.restore();
}
export function rivet(g, M, x, y, r = 3.4) {
  const [px, py] = ap(M, x, y), k = Math.hypot(M[0], M[1]);
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'multiply';
  g.beginPath(); g.arc(px, py, r * .74 * k, 0, 7); g.strokeStyle = '#2e1c10'; g.lineWidth = r * .52 * k; g.stroke();
  g.beginPath(); g.arc(px, py, r * .45 * k, 0, 7); g.fillStyle = '#b58a5e'; g.fill(); g.restore();
}
// Control rods: from the attach point toward the puppeteer, below the cloth; soft and dark
export function rods(g, pts, k, alpha = .6) {
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'multiply'; g.filter = `blur(${(2.2 * k).toFixed(2)}px)`; g.globalAlpha = alpha;
  for (const [p, e, w] of pts) {
    g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(e[0], e[1]); g.strokeStyle = '#2a1a10'; g.lineWidth = w * k; g.stroke();
    g.beginPath(); g.arc(p[0], p[1], w * .9 * k, 0, 7); g.fillStyle = '#2a1a10'; g.fill();
  }
  g.restore();
}

const P = {};
export const PIECES = P;

// ======================= Fisherman (faces right) =======================
// torso pivot = waist; y up is negative
export const FJ = { neck: [6, -118], shF: [16, -102], shB: [2, -106], hipF: [10, 4], hipB: [-8, 2], rod: [4, -110] };
export const ARM = { a: 56, b: 50 };
const torsoPts = [[-30, 8], [-31, -30], [-30, -70], [-26, -98], [-14, -116], [2, -122], [16, -118], [28, -104], [36, -80], [37, -50], [34, -18], [31, 8]];
function fTorso() {
  const body = q => smooth(q, torsoPts);
  return piece([-42, -132, 48, 20], g => {
    fill(g, DYE.yellow, body);
    within(g, body, () => {
      for (let y = -88; y < -16; y += 17) for (let x = -20 + ((y / 17) & 1) * 8; x < 32; x += 17) coin(g, x, y, 5.2);
      cutLine(g, 1.4, q => { q.moveTo(20, -114); q.quadraticCurveTo(8, -60, 14, 4); });           // placket
    });
    ink(g, 2.1, body);
    // cloud collar (vermilion), four lobes around the neck
    const col = q => smooth(q, [[-18, -112], [-24, -100], [-12, -92], [0, -98], [10, -90], [24, -98], [22, -110], [10, -122], [-4, -122]]);
    fill(g, DYE.red, col); cloud(g, -8, -106, 5, 0, 1.1); cloud(g, 12, -104, 5, 2, 1.1, -1); ink(g, 1.6, col);
    // sash
    const sash = q => poly(q, [[-32, -14], [36, -18], [37, 0], [-32, 4]]);
    fill(g, DYE.red, sash); within(g, sash, () => meander(g, -28, -4, 34, 4.2, 1.1)); ink(g, 1.6, sash);
    const tail = q => smooth(q, [[30, -6], [44, 8], [40, 22], [34, 10]]);
    fill(g, DYE.red, tail); cutLine(g, 1, q => { q.moveTo(34, -2); q.lineTo(39, 16); }); ink(g, 1.4, tail);
  }, { seed: 11 });
}
function fLeg(dark) {
  const leg = q => smooth(q, [[-17, -6], [16, -6], [17, 40], [14, 96], [18, 132], [-14, 134], [-12, 96], [-16, 40]]);
  return piece([-24, -12, 30, 150], g => {
    fill(g, dark ? DYE.brown : '#7a4a22', leg);
    within(g, leg, () => lattice(g, -16, 4, 18, 96, 11, 2.4));
    ink(g, 2, leg);
    const shoe = q => smooth(q, [[-15, 112], [16, 110], [30, 128], [28, 140], [-16, 140]]);
    fill(g, DYE.ink, shoe); cutLine(g, 1.2, q => { q.moveTo(-10, 132); q.lineTo(24, 132); });
  }, { seed: dark ? 13 : 12 });
}
const facePts = [[2, -2], [14, -6], [18, -14], [21, -20], [26, -27], [27, -31], [22, -35], [24, -41], [23, -48], [19, -58], [8, -66], [-8, -64], [-18, -56], [-21, -38], [-16, -16], [-8, -4]];
function fHead() {
  const K = 1.25;
  return piece([-90, -150, 100, 14], g => {
    g.scale(K, K);
    const head = q => smooth(q, facePts);
    fill(g, DYE.skin, head);
    // open-cut face: cut the face out, keep the outline and features as thin strips
    cut(g, q => smooth(q, facePts.map(([x, y]) => [x * .74 + 2, (y + 34) * .76 - 34]).filter((p, i) => i > 1 && i < 11)));
    ink(g, 2.3, q => smooth(q, facePts.slice(1, 11), false));
    ink(g, 1.5, q => { q.moveTo(19, -42.5); q.quadraticCurveTo(12, -46.5, 4, -44.5); });       // brow
    ink(g, 1.1, q => { q.moveTo(17, -38.5); q.quadraticCurveTo(12, -41, 7, -38.6); q.quadraticCurveTo(12, -36.4, 17, -38.5); });   // eye
    g.beginPath(); g.arc(13.5, -38.6, 1.5, 0, 7); g.fillStyle = DYE.ink; g.fill();
    ink(g, 1.2, q => { q.moveTo(22, -24); q.lineTo(16, -23); });                                // mouth
    ink(g, 1.1, q => { q.moveTo(18, -31); q.quadraticCurveTo(14, -29, 13, -32); });             // nostril
    // back of head: hair knot in ink, ear
    const hair = q => smooth(q, [[-8, -64], [-18, -56], [-21, -38], [-16, -18], [-8, -20], [-6, -40], [0, -60]]);
    fill(g, DYE.ink, hair); for (let k = 0; k < 5; k++) cutLine(g, .7, q => { q.moveTo(-4 - k * 3, -60); q.quadraticCurveTo(-16 - k, -42, -12 - k, -24); });
    ink(g, 1.3, q => { q.moveTo(-2, -36); q.bezierCurveTo(-8, -38, -9, -28, -3, -28.5); });
    // conical straw hat (斗笠): wide brim, diamond lattice, ink rim, chin strap
    const hat = q => smooth(q, [[-58, -50], [-30, -66], [-6, -84], [6, -90], [18, -82], [40, -64], [66, -50], [64, -45], [6, -54], [-58, -45]]);
    fill(g, DYE.hide, hat); within(g, hat, () => lattice(g, -60, -92, 70, -44, 9, 1.8));
    ink(g, 2.2, hat); ink(g, 1.4, q => { q.moveTo(-50, -50); q.quadraticCurveTo(4, -60, 58, -50); });
    ink(g, 1.2, q => { q.moveTo(12, -54); q.quadraticCurveTo(14, -30, 6, -6); }, DYE.brown);
    g.beginPath(); g.arc(6, -90, 3, 0, 7); g.fillStyle = DYE.red; g.fill();
  }, { seed: 14 });
}
function fBeard() {   // loose piece, pivot at the chin, swings
  const b = q => smooth(q, [[-6, -2], [8, -4], [10, 14], [6, 36], [0, 52], [-4, 34], [-8, 12]]);
  return piece([-14, -8, 16, 58], g => {
    fill(g, DYE.ink, b);
    for (let k = 0; k < 3; k++) cutTaper(g, [[-3 + k * 3, 4], [-2 + k * 3.4, 24], [-1 + k * 2, 44]], 1.6);
  }, { seed: 15 });
}
function fUpper() {   // sleeve, pivot at shoulder, hangs toward +y
  const s = q => smooth(q, [[-15, -8], [14, -8], [17, 20], [15, 46], [10, 62], [-10, 64], [-15, 44], [-18, 18]]);
  return piece([-24, -14, 24, 70], g => {
    fill(g, DYE.teal, s); within(g, s, () => { for (let y = 6; y < 56; y += 12) cutTaper(g, [[-11, y], [0, y + 3], [11, y]], 3.4); });
    ink(g, 2, s);
  }, { seed: 16 });
}
function fFore() {
  const s = q => smooth(q, [[-12, -6], [12, -6], [13, 24], [12, 44], [-12, 44], [-13, 22]]);
  return piece([-18, -10, 18, 56], g => {
    fill(g, DYE.teal, s); within(g, s, () => { for (let y = 4; y < 34; y += 11) cutTaper(g, [[-9, y], [0, y + 3], [9, y]], 3); });
    ink(g, 2, s);
    const cuff = q => poly(q, [[-12, 38], [12, 38], [12, 48], [-12, 48]]);
    fill(g, DYE.red, cuff); ink(g, 1.4, cuff);
  }, { seed: 17 });
}
function fHand() {
  const h = q => smooth(q, [[-8, -4], [8, -4], [11, 6], [8, 14], [0, 17], [-8, 12], [-10, 4]]);
  return piece([-14, -8, 14, 22], g => { fill(g, DYE.skin, h); ink(g, 1.6, h); ink(g, 1, q => { q.moveTo(-4, 8); q.lineTo(5, 9); }); }, { seed: 18 });
}

// ======================= Boat, oar, net, pearl =======================
function boat() {
  const hull = q => smooth(q, [[-238, -46], [-212, -8], [-150, 0], [0, 4], [150, 0], [214, -14], [252, -62], [262, -58], [232, 6], [200, 34], [120, 50], [-120, 50], [-196, 34], [-226, 6], [-250, -40]]);
  return piece([-270, -140, 275, 60], g => {
    // arched mat cabin at the stern
    const cab = q => smooth(q, [[20, 2], [14, -60], [36, -106], [80, -124], [124, -110], [146, -64], [150, 2]]);
    fill(g, DYE.hide2, cab); within(g, cab, () => lattice(g, 10, -130, 154, 4, 12, 2.6)); ink(g, 2.2, cab);
    ink(g, 1.6, q => { q.moveTo(20, -40); q.quadraticCurveTo(80, -70, 148, -40); });
    fill(g, DYE.gold, hull);
    within(g, hull, () => {
      for (let x = -190; x < 200; x += 26) coin(g, x, 24, 6.5);
      cutLine(g, 2, q => { q.moveTo(-220, 8); q.quadraticCurveTo(0, 16, 226, 0); });
      cutLine(g, 1.6, q => { q.moveTo(-180, 40); q.quadraticCurveTo(0, 46, 186, 36); });
    });
    ink(g, 2.4, hull);
    cloud(g, 236, -36, 10, 0, 1.6); cloud(g, -232, -26, 9, 0, 1.6, -1);
  }, { seed: 21 });
}
function oarBlade() {
  const b = q => smooth(q, [[-9, -6], [9, -6], [13, 30], [11, 70], [0, 82], [-11, 70], [-13, 30]]);
  return piece([-18, -10, 18, 88], g => { fill(g, DYE.gold, b); within(g, b, () => { cutTaper(g, [[0, 10], [0, 40], [0, 72]], 5); }); ink(g, 2, b); }, { seed: 22 });
}
function netBundle() {
  const b = q => smooth(q, [[-26, -8], [-10, -22], [14, -18], [30, 0], [22, 22], [0, 30], [-22, 18]]);
  return piece([-34, -28, 38, 36], g => { fill(g, '#5a3a20', b); within(g, b, () => lattice(g, -30, -26, 34, 34, 8, 2.2)); ink(g, 2, b); }, { seed: 23 });
}
function netOpen() {   // fan of mesh, pivot at the rope knot (top centre)
  const fan = q => smooth(q, [[-8, 0], [8, 0], [150, 120], [110, 160], [0, 176], [-110, 160], [-150, 120]]);
  return piece([-170, -10, 170, 190], g => {
    fill(g, '#4a2e18', fan);
    within(g, fan, () => lattice(g, -170, 0, 170, 190, 15, 2.1));
    ink(g, 2.2, fan);
    for (let k = -6; k <= 6; k++) { const a = k / 6 * 1.05, r = 170; g.beginPath(); g.arc(Math.sin(a) * r * .82, Math.cos(a) * r * .98, 4.2, 0, 7); g.fillStyle = DYE.ink; g.fill(); }
  }, { seed: 24 });
}
function netBag() {    // closed bag around the pearl, pivot at the top knot
  const bag = q => smooth(q, [[-6, 0], [6, 0], [44, 50], [52, 96], [30, 124], [0, 130], [-30, 124], [-52, 96], [-44, 50]]);
  return piece([-60, -6, 60, 138], g => {
    fill(g, '#4a2e18', bag);
    within(g, bag, () => lattice(g, -60, 0, 60, 138, 13, 2.3));
    cut(g, q => q.arc(0, 88, 30, 0, 7));     // the pearl sits in a clear window of the bag
    ink(g, 2, bag); ink(g, 1.6, q => q.arc(0, 88, 30, 0, 7));
  }, { seed: 25 });
}
function pearl() {     // flaming pearl: disc fully cut through (brightest), bead ring, flame tongues
  return piece([-48, -48, 48, 48], g => {
    for (let k = 0; k < 9; k++) {
      g.save(); g.rotate(k / 9 * Math.PI * 2); g.translate(0, -26);
      g.beginPath(); flameTongue(g, 20, 14, k % 2 ? 1 : -1); g.fillStyle = k % 2 ? DYE.orange : DYE.red; g.fill(); g.lineWidth = 1.3; g.strokeStyle = DYE.ink; g.stroke(); g.restore();
    }
    g.beginPath(); g.arc(0, 0, 27, 0, 7); g.fillStyle = DYE.yellow; g.fill(); g.lineWidth = 2; g.strokeStyle = DYE.ink; g.stroke();
    const pts = []; for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2; pts.push([Math.cos(a) * 22.5, Math.sin(a) * 22.5]); } beads(g, pts, 2);
    cut(g, q => q.arc(0, 0, 17, 0, 7));
    cutLine(g, 2.2, q => { q.arc(0, 0, 17, 0, 7); });
  }, { seed: 26, tex: true });
}

// ======================= Dragon (faces left) =======================
// head pivot = neck joint (right side); the snout points to -x
export const DJ = { hinge: [-118, 6], mouth: [-238, 4], eye: [-168, -58], whisk: [-282, -12], whisk2: [-262, 2] };
function dHead() {
  return piece([-330, -250, 120, 70], g => {
    // antlers (ink, branched) behind
    const horn = (x0, y0, s) => ink(g, 9 * s, q => { q.moveTo(x0, y0); q.bezierCurveTo(x0 + 40 * s, y0 - 60 * s, x0 + 90 * s, y0 - 110 * s, x0 + 150 * s, y0 - 150 * s); q.moveTo(x0 + 60 * s, y0 - 70 * s); q.quadraticCurveTo(x0 + 70 * s, y0 - 120 * s, x0 + 50 * s, y0 - 150 * s); q.moveTo(x0 + 110 * s, y0 - 118 * s); q.quadraticCurveTo(x0 + 140 * s, y0 - 120 * s, x0 + 170 * s, y0 - 100 * s); }, '#3a2414');
    horn(-120, -84, 1); horn(-90, -80, .8);
    // mane: vermilion flame tongues sweeping back
    for (let k = 0; k < 7; k++) {
      g.save(); g.translate(-60 + k * 26, -64 + k * 12); g.rotate(1.1 + k * .12);
      g.beginPath(); flameTongue(g, 92 - k * 6, 34, k % 2 ? 1 : -1); g.fillStyle = k % 2 ? DYE.red : DYE.orange; g.fill(); g.lineWidth = 1.8; g.strokeStyle = DYE.ink; g.stroke();
      cutTaper(g, [[0, -8], [3, -40], [8, -70]], 4); g.restore();
    }
    // skull + upper jaw (jade), open scales on the cheek
    const head = q => smooth(q, [[40, -30], [0, -78], [-70, -96], [-140, -98], [-196, -84], [-236, -64], [-270, -54], [-300, -54], [-318, -36], [-312, -14], [-292, -4], [-250, 2], [-200, 6], [-140, 14], [-90, 30], [-30, 34], [36, 20]]);
    fill(g, DYE.jade, head);
    within(g, head, () => {
      scalesOpen(g, -110, -70, 30, 26, 9);
      for (let k = 0; k < 3; k++) cutTaper(g, [[-290 + k * 20, -46], [-250 + k * 20, -40], [-212 + k * 18, -44]], 4);
    });
    ink(g, 2.6, head);
    // brow ridge (gold flame)
    const brow = q => smooth(q, [[-210, -76], [-180, -104], [-140, -110], [-120, -96], [-150, -82]]);
    fill(g, DYE.yellow, brow); cloud(g, -158, -96, 8, 0, 1.4); ink(g, 1.8, brow);
    // nose bulb with a curl
    const nose = q => smooth(q, [[-300, -54], [-318, -74], [-296, -88], [-270, -76], [-272, -56]]);
    fill(g, DYE.yellow, nose); cloud(g, -294, -72, 8, 1, 1.4, -1); ink(g, 1.8, nose);
    // eye: ring with a solid pupil (antagonist: solid, staring)
    g.beginPath(); g.arc(-168, -58, 20, 0, 7); g.fillStyle = DYE.white; g.fill(); g.lineWidth = 3; g.strokeStyle = DYE.ink; g.stroke();
    cut(g, q => { q.arc(-168, -58, 14, 0, 7); });
    g.beginPath(); g.arc(-172, -58, 8, 0, 7); g.fillStyle = DYE.ink; g.fill();
    // upper teeth cut as glowing holes
    cut(g, q => { for (let x = -286; x < -150; x += 18) { q.moveTo(x, 2); q.lineTo(x + 9, 2); q.lineTo(x + 4.5, 16); q.closePath(); } }, 'nonzero');
    // neck lobe + rivet seat
    const lobe = q => { q.arc(0, 0, 38, 0, 7); };
    fill(g, DYE.jade, lobe); within(g, lobe, () => scalesOpen(g, -40, -40, 40, 40, 8)); ink(g, 2.2, lobe);
  }, { seed: 31 });
}
function dJaw() {      // lower jaw, pivot at the hinge
  const j = q => smooth(q, [[18, -10], [-30, -2], [-90, 6], [-150, 6], [-176, 14], [-170, 30], [-120, 34], [-60, 32], [0, 24], [24, 10]]);
  return piece([-190, -24, 40, 50], g => {
    fill(g, DYE.jade, j);
    within(g, j, () => { for (let x = -150; x < 0; x += 22) coin(g, x, 20, 5); });
    cut(g, q => { for (let x = -164; x < -40; x += 18) { q.moveTo(x, -4); q.lineTo(x + 9, -4); q.lineTo(x + 4.5, -16); q.closePath(); } }, 'nonzero');
    ink(g, 2.4, j);
    // beard tuft (vermilion)
    const tuft = q => smooth(q, [[-120, 30], [-104, 64], [-120, 92], [-140, 60]]);
    fill(g, DYE.red, tuft); cutTaper(g, [[-124, 40], [-122, 64], [-126, 84]], 3); ink(g, 1.6, tuft);
  }, { seed: 32 });
}
function dSeg(i) {    // body segment i (0 = neck), pivot at the front joint, extends to +x
  const L = 150 - i * 10, Hh = 66 - i * 5;
  return piece([-Hh - 6, -Hh - 70, L + Hh + 8, Hh + 12], g => {
    // dorsal fin: vermilion flame tongues along the top
    for (let k = 0; k < 4; k++) {
      g.save(); g.translate(18 + k * L / 4, -Hh * .78); g.rotate(.5);
      g.beginPath(); flameTongue(g, 58 - i * 4, 26, 1); g.fillStyle = k % 2 ? DYE.red : DYE.orange; g.fill(); g.lineWidth = 1.6; g.strokeStyle = DYE.ink; g.stroke(); g.restore();
    }
    const body = q => smooth(q, [[-Hh * .7, -Hh * .7], [L * .3, -Hh], [L * .75, -Hh * .9], [L + Hh * .6, -Hh * .5], [L + Hh * .7, Hh * .4], [L * .75, Hh * .85], [L * .3, Hh * .9], [-Hh * .7, Hh * .7], [-Hh, 0]]);
    fill(g, DYE.jade, body);
    within(g, body, () => scalesOpen(g, -Hh, -Hh, L + Hh, Hh * .35, 11 - i * .6));
    // belly plates (gold) with stripe cuts
    const belly = q => smooth(q, [[-Hh * .8, Hh * .25], [L + Hh * .65, Hh * .2], [L * .75, Hh * .85], [L * .3, Hh * .9], [-Hh * .7, Hh * .7]]);
    within(g, body, () => { fill(g, DYE.yellow, belly); for (let x = -Hh * .5; x < L + Hh * .5; x += 16) cutLine(g, 2.2, q => { q.moveTo(x, Hh * .36); q.quadraticCurveTo(x + 5, Hh * .6, x + 2, Hh * .82); }); });
    ink(g, 2.4, body);
    ink(g, 1.6, q => { q.moveTo(-Hh * .8, Hh * .25); q.quadraticCurveTo(L * .5, Hh * .32, L + Hh * .65, Hh * .2); });
    if (i === 6) {   // tail fin
      for (let k = 0; k < 3; k++) { g.save(); g.translate(L + Hh * .5, 0); g.rotate(1.2 + k * .55); g.beginPath(); flameTongue(g, 70, 30, k % 2 ? 1 : -1); g.fillStyle = DYE.red; g.fill(); g.lineWidth = 1.6; g.strokeStyle = DYE.ink; g.stroke(); g.restore(); }
    }
  }, { seed: 40 + i });
}
export const SEGLEN = i => 150 - i * 10;

// ======================= Sea, spray, rain-cloud =======================
// row r (0 back, 1 mid, 2 front), variant v (0..2: crest phase for the 12 fps swap)
export const WAVE_X0 = -300, WAVE_X1 = 2700;
function waveRow(r, v) {
  const per = [200, 170, 230][r], amp = [40, 48, 56][r], ph = v / 3 + r * .21, band = [118, 112, 260][r];
  const col = ['#4f9a93', DYE.teal, '#285a86'][r];
  const top = x => { let u = ((x / per + ph) % 1 + 1) % 1; const h = u < .72 ? Math.pow(u / .72, 1.7) : Math.pow(1 - (u - .72) / .28, .6); return -amp * h; };
  const bot = x => band + 10 * Math.sin(x / 47 + r);
  return piece([WAVE_X0, -amp - 30, WAVE_X1, band + 24], g => {
    const shape = q => { q.moveTo(WAVE_X0, bot(WAVE_X0)); for (let x = WAVE_X0; x <= WAVE_X1; x += 4) q.lineTo(x, top(x)); for (let x = WAVE_X1; x >= WAVE_X0; x -= 6) q.lineTo(x, bot(x)); q.closePath(); };
    fill(g, col, shape);
    within(g, shape, () => {
      scalesOpen(g, WAVE_X0, 26, WAVE_X1, band + 20, 15 + r * 2);
      for (let x = WAVE_X0 - per; x < WAVE_X1 + per; x += per) {
        const xc = x - ((ph % 1) * per) + per * .72 - 14; cloud(g, xc, -amp * .62, amp * .3, 0, 2.2, 1);
        cutTaper(g, [[xc - per * .5, -amp * .1 + 8], [xc - per * .25, -amp * .3 + 6], [xc - 6, -amp * .66]], 4.5);
      }
    });
    ink(g, 2.2, shape);
  }, { seed: 50 + r * 3 + v, ss: 1.25 });
}
function spray(v) {    // breaking spray around the dragon's breach: carved crest tongues (teal)
  return piece([-260, -260, 260, 40], g => {
    const R = mulberry(77 + v);
    for (let k = 0; k < 9; k++) {
      const x = -220 + k * 55 + (R() - .5) * 20, h = 90 + R() * 90 - Math.abs(x) * .18;
      g.save(); g.translate(x, 20); g.rotate((x / 260) * 1.1 + (R() - .5) * .2);
      g.beginPath(); flameTongue(g, h, 74, x < 0 ? -1 : 1); g.fillStyle = k % 2 ? DYE.teal : DYE.blue; g.fill(); g.lineWidth = 2; g.strokeStyle = DYE.ink; g.stroke();
      cloud(g, 0, -h * .7, 9, 0, 1.6, x < 0 ? -1 : 1); cutTaper(g, [[0, -10], [2, -h * .3], [4, -h * .55]], 4); g.restore();
    }
  }, { seed: 60 + v });
}
// rain-cloud: a long jade cloud coil (echoes the dragon's body) — pivot at its centre, pearl window at (0,0)
function rainCloud() {
  return piece([-580, -200, 580, 170], g => {
    const lobes = [[-480, 30, 62], [-400, -30, 84], [-290, -78, 96], [-165, -50, 92], [-150, 40, 70], [-30, -88, 112], [100, -46, 96], [210, -92, 88], [320, -40, 92], [430, 10, 74], [-330, 50, 66], [10, 52, 84], [230, 50, 74], [500, 46, 50]];
    const all = q => { for (const [x, y, r] of lobes) { q.moveTo(x + r, y); q.arc(x, y, r, 0, 7); } };
    fill(g, DYE.jade, all, 'nonzero');
    g.lineWidth = 4.4; g.strokeStyle = DYE.ink; for (const [x, y, r] of lobes) { g.beginPath(); g.arc(x, y, r, 0, 7); g.stroke(); }
    g.fillStyle = DYE.jade; for (const [x, y, r] of lobes) { g.beginPath(); g.arc(x, y, r - 2.3, 0, 7); g.fill(); }
    within(g, all, () => {
      for (const [x, y, r] of lobes) { cloud(g, x + r * .08, y - r * .02, r * .66, x * .013, 3.6, x < 0 ? -1 : 1); }
      for (let k = 0; k < 9; k++) cutTaper(g, [[-470 + k * 115, 80], [-440 + k * 115, 104], [-400 + k * 115, 118]], 6);
    });
    // trailing scroll tails at both ends (the dragon's last shape)
    for (const sx of [-1, 1]) {
      const tail = q => smooth(q, [[sx * 520, 10], [sx * 580, -40], [sx * 560, -120], [sx * 520, -150], [sx * 545, -96], [sx * 540, -40], [sx * 490, 0]]);
      fill(g, DYE.jade, tail); cutTaper(g, [[sx * 548, -20], [sx * 556, -70], [sx * 538, -126]], 5); ink(g, 2.2, tail);
    }
    cut(g, q => q.arc(-150, 70, 34, 0, 7));
    fill(g, DYE.jade, q => { q.arc(-150, 70, 46, 0, 7); q.arc(-150, 70, 34, 0, 7); }, 'evenodd');
    ink(g, 2.4, q => q.arc(-150, 70, 46, 0, 7)); ink(g, 2, q => q.arc(-150, 70, 34, 0, 7));
    beads(g, Array.from({ length: 14 }, (_, k) => [-150 + Math.cos(k / 14 * 6.283) * 40, 70 + Math.sin(k / 14 * 6.283) * 40]), 2.2);
  }, { seed: 70 });
}
function rainVeil(v) {   // veil hanging from the cloud, cut with slanted tapered slits (rain glows through), ragged hem
  return piece([-560, -10, 600, 800], g => {
    const hem = x => 690 + 50 * Math.sin(x / 61) + 30 * Math.sin(x / 23 + 1);
    const veil = q => { q.moveTo(-380, 0); q.lineTo(400, 0); for (let x = 540; x >= -500; x -= 10) q.lineTo(x, hem(x)); q.closePath(); };
    fill(g, '#6f979c', veil);
    const R = mulberry(91 + v * 13);
    within(g, veil, () => {
      for (let k = 0; k < 420; k++) {
        const x = -540 + R() * 1120, y = ((R() * 900 - 80) + v * 45), L = 70 + R() * 90;
        cutTaper(g, [[x, y], [x + L * .1, y + L * .5], [x + L * .2, y + L]], 3.4 + R() * 2.6);
      }
      for (let k = 0; k < 26; k++) { const x = -520 + k * 41; cutTaper(g, [[x + 20, hem(x) - 150 - (k % 3) * 40], [x + 26, hem(x) - 60], [x + 30, hem(x) + 20]], 14); }   // ragged fringe
    });
  }, { seed: 80 + v, ss: 1.5 });
}
// ======================= Title plaque =======================
function plaque() {
  return piece([-330, -110, 330, 110], g => {
    const board = q => smooth(q, [[-310, -88], [0, -98], [310, -88], [322, 0], [310, 88], [0, 98], [-310, 88], [-322, 0]]);
    fill(g, '#3b2312', board);
    within(g, board, () => { meander(g, -300, -72, 300, 7, 2); meander(g, -300, 84, 300, 7, 2); });
    ink(g, 3, board);
    const inner = q => smooth(q, [[-284, -58], [0, -66], [284, -58], [292, 0], [284, 58], [0, 66], [-284, 58], [-292, 0]]);
    ink(g, 2, inner, DYE.red);
    for (const sx of [-1, 1]) {
      const c = q => q.arc(sx * 300, 0, 34, 0, 7);
      fill(g, DYE.jade, c); cloud(g, sx * 300, 0, 22, 0, 2, sx); ink(g, 2, c);
    }
    g.save(); g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000';
    g.font = '900 104px "Noto Serif SC"'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.letterSpacing = '14px';
    g.fillText('渔夫还珠', 7, 6); g.restore();
  }, { seed: 90 });
}

export function buildPieces() {
  Object.assign(P, {
    torso: fTorso(), legF: fLeg(false), legB: fLeg(true), head: fHead(), beard: fBeard(),
    upper: fUpper(), fore: fFore(), hand: fHand(),
    boat: boat(), blade: oarBlade(), bundle: netBundle(), net: netOpen(), bag: netBag(), pearl: pearl(),
    dHead: dHead(), dJaw: dJaw(), dSeg: Array.from({ length: 7 }, (_, i) => dSeg(i)),
    waves: [0, 1, 2].map(r => [0, 1, 2].map(v => waveRow(r, v))), spray: [0, 1].map(spray),
    cloud: rainCloud(), veil: [0, 1].map(rainVeil), plaque: plaque(),
  });
  return P;
}

// ======================= Drawing the fisherman =======================
// pose: {x, y (waist, world), rot, head, hF:[x,y], hB:[x,y] (world hand targets), legF, legB, beard (swing)}
function ik(S, H, a, b, bend = 1) {
  const dx = H[0] - S[0], dy = H[1] - S[1], d = clamp(Math.hypot(dx, dy), Math.abs(a - b) + 1, a + b - .5), th = Math.atan2(dy, dx);
  const al = Math.acos(clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1));
  const E = [S[0] + a * Math.cos(th + bend * al), S[1] + a * Math.sin(th + bend * al)];
  const W = [E[0] + b * Math.cos(Math.atan2(H[1] - E[1], H[0] - E[0])), E[1] + b * Math.sin(Math.atan2(H[1] - E[1], H[0] - E[0]))];
  return { E, W };
}
export function fisherFrame(p) {
  const Mt = chain(Tm(p.x, p.y), Rm(p.rot));
  return { Mt, shF: ap(Mt, ...FJ.shF), shB: ap(Mt, ...FJ.shB), neck: ap(Mt, ...FJ.neck) };
}
function drawArm(g, C, S, H, bend) {
  const { E, W } = ik(S, H, ARM.a, ARM.b, bend);
  const a1 = Math.atan2(E[1] - S[1], E[0] - S[0]) - Math.PI / 2, a2 = Math.atan2(W[1] - E[1], W[0] - E[0]) - Math.PI / 2;
  const Mu = chain(C, Tm(...S), Rm(a1)), Mf = chain(C, Tm(...E), Rm(a2)), Mh = chain(C, Tm(...W), Rm(a2));
  put(g, Mu, P.upper); put(g, Mf, P.fore); put(g, Mh, P.hand);
  rivet(g, C, ...S, 3.6); rivet(g, C, ...E, 3.2);
  return W;
}
// between(): called after the back arm, before the front arm (held props sit between the palms)
export function drawFisher(g, C, p, between) {
  const F = fisherFrame(p), Mt = chain(C, F.Mt);
  drawArm(g, C, F.shB, p.hB, p.bendB ?? 1);
  const Ml = chain(C, Tm(p.x, p.y), Rm(p.rot - (p.bend || 0)));
  put(g, chain(Ml, Tm(...FJ.hipB), Rm(p.legB || 0)), P.legB);
  put(g, Mt, P.torso);
  put(g, chain(Ml, Tm(...FJ.hipF), Rm(p.legF || 0)), P.legF);
  rivet(g, Mt, ...FJ.hipF, 3.4);
  const Mh = chain(Mt, Tm(...FJ.neck), Rm(p.head || 0));
  put(g, chain(Mh, Tm(16 * 1.25, -6 * 1.25), Rm(p.beard || 0)), P.beard);
  put(g, Mh, P.head);
  rivet(g, Mt, ...FJ.neck, 3.2);
  if (between) between();
  drawArm(g, C, F.shF, p.hF, p.bendF ?? 1);
  return F;
}

// ======================= Drawing the dragon =======================
// spine: array of world points from the neck joint to the tail; head angle extra; jaw open (rad)
function sampleSpine(pts, n) {      // Catmull-Rom → dense polyline with cumulative length
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(j => .5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
    }
  }
  out.push(pts[pts.length - 1]);
  const L = [0]; for (let i = 1; i < out.length; i++) L.push(L[i - 1] + Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));
  return { pts: out, L };
}
function atLen(sp, s) {
  const { pts, L } = sp; let i = 1; while (i < L.length - 1 && L[i] < s) i++;
  const u = clamp((s - L[i - 1]) / Math.max(1e-6, L[i] - L[i - 1])), a = pts[i - 1], b = pts[i];
  return { p: [lerp(a[0], b[0], u), lerp(a[1], b[1], u)], ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}
export function dragonGeom(d) {
  const sp = sampleSpine(d.spine, 14);
  const segs = []; let s = 0;
  for (let i = 0; i < 7; i++) { const a = atLen(sp, s), b = atLen(sp, s + SEGLEN(i)); segs.push({ p: a.p, ang: Math.atan2(b.p[1] - a.p[1], b.p[0] - a.p[0]) }); s += SEGLEN(i) * .92; }
  const h0 = atLen(sp, 0), h1 = atLen(sp, 40);
  const neckAng = Math.atan2(h1.p[1] - h0.p[1], h1.p[0] - h0.p[0]);   // points along the body (to +x side)
  const Mh = chain(Tm(...h0.p), Rm(neckAng + (d.head || 0)));
  const Mj = chain(Mh, Tm(...DJ.hinge), Rm(-(d.jaw || 0)));
  return { segs, Mh, Mj, mouth: ap(Mh, DJ.mouth[0], DJ.mouth[1] + 4 + (d.jaw || 0) * 40), eye: ap(Mh, ...DJ.eye), lip: ap(Mh, ...DJ.whisk), lip2: ap(Mh, ...DJ.whisk2) };
}
// whiskers: two dark strips from the lip, angles from the pendulum sim (wh = [a0..a7])
function whisker(g, C, base, a0, ang, len, w) {
  let p = base; g.save(); g.globalCompositeOperation = 'multiply'; g.setTransform(1, 0, 0, 1, 0, 0);
  const k = Math.hypot(C[0], C[1]); g.lineCap = 'round'; g.strokeStyle = '#4a0f0b';
  let a = a0;
  for (let i = 0; i < ang.length; i++) {
    a += ang[i]; const q = [p[0] + Math.cos(a) * len, p[1] + Math.sin(a) * len];
    const s0 = ap(C, ...p), s1 = ap(C, ...q); g.lineWidth = w * k * (1 - i / ang.length * .7); g.beginPath(); g.moveTo(...s0); g.lineTo(...s1); g.stroke(); p = q;
  }
  g.restore();
}
export function drawDragon(g, C, d, inMouth) {
  const G = dragonGeom(d);
  for (let i = 6; i >= 0; i--) {
    const sg = G.segs[i];
    put(g, chain(C, Tm(...sg.p), Rm(sg.ang)), P.dSeg[i]);
  }
  for (let i = 1; i < 7; i++) rivet(g, C, ...G.segs[i].p, 5);
  put(g, G.Mj ? chain(C, G.Mj) : C, P.dJaw);
  if (inMouth) inMouth(G);
  put(g, chain(C, G.Mh), P.dHead);
  rivet(g, chain(C, G.Mh), 0, 0, 6); rivet(g, chain(C, G.Mh), ...DJ.hinge, 4.5);
  const hdAng = Math.atan2(G.Mh[1], G.Mh[0]) + Math.PI;    // snout direction
  whisker(g, C, G.lip, hdAng - .5, d.wh || [], 28, 7.5);
  whisker(g, C, G.lip2, hdAng - .1, (d.wh2 || []), 26, 6.5);
  return G;
}
