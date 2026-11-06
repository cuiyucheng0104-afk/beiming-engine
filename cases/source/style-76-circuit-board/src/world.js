// The doorbell board, in millimetres. An invented layout of a real kind of circuit:
// coin cell BT1 -> push button SW1 -> R1 (current limit) -> C1 (debounce) -> via down / via up -> U1 (the
// "ding-dong" melody chip, its die nested inside the footprint) -> OUT -> three driver transistors Q1-Q3 in
// parallel -> LS1, a planar voice coil (octagonal spiral). The copper pour is ground.
import { measure, octi } from './geo.js';

export const BOARD = { x0: 0, y0: 0, x1: 176, y1: 104, r: 3, inset: 0.6 };
export const CLR = 0.32, VIA_R = 0.42, FENCE_R = 0.36, HOLE_R = 1.6, FID_R = 0.5;
const tr = (id, pts, w, o = {}) => ({ id, pts, w, ...o });

// ---------- parts (positions) ----------
export const BT = [22, 28];                       // coin cell holder centre
export const SW = [24, 64];                       // push button centre
const SWP = [[20.75, 61.75], [27.25, 61.75], [20.75, 66.25], [27.25, 66.25]];
export const R1 = [40, 66.25], C1X = 50;
export const V1 = [58, 66.25], V2 = [70, 54.25];
export const U1 = [86, 48];                       // QFN-16, 12 x 12 body
const UP = [-3.6, -1.2, 1.2, 3.6];
export const PIN_IN = [79.2, 49.2], PIN_OUT = [92.8, 46.8];
export const QX = [106, 114, 122], QY = 40.6;     // driver transistors
export const LS = [139, 64], COIL_R = 13;         // voice coil
export const DIE_AT = [86, 48], DIE_S = 0.022;    // nested die: mm per die unit

// ---------- traces ----------
export const TRACES = [
  // battery + clip -> SW1 pin 1 (energised from the first frame)
  tr('bat', octi([[9.5, 28], [9.5, 55.5], [15.5, 61.75, 'd'], [20.75, 61.75]]), 0.8),
  // the signal path, as the current takes it
  tr('sw_r1', [[27.25, 66.25], [38.8, 66.25]], 0.8),
  tr('r1_c1', [[41.2, 66.25], [50, 66.25]], 0.45),
  tr('c1_v1', [[50, 66.25], V1], 0.45),
  tr('v1_v2', octi([V1, [V2[0], V2[1], 'd']]), 0.45, { layer: 'bottom' }),
  tr('v2_u1', [V2, [70, 49.2], [PIN_IN[0] - 0.6, 49.2]], 0.45),
  // U1 OUT -> the base bus (signal) with three stubs into the bases
  tr('out', octi([[PIN_OUT[0] + 0.6, 46.8], [98, 46.8], [102, 42.8, 'd'], [102, 36], [QX[2], 36]]), 0.45),
  ...QX.map((x, k) => tr('b' + k, [[x, 36], [x, QY - 2.5]], 0.4)),
  // collectors down to the drive bus, the bus to the voice coil
  ...QX.map((x, k) => tr('c' + k, [[x + 1.6, QY + 2.6], [x + 1.6, 50]], 0.7)),
  tr('drive', [[QX[0] + 1.6, 50], [QX[2] + 1.6, 50], [LS[0] - COIL_R, 52.4], [LS[0] - COIL_R, LS[1]]], 1.2),
  // emitters to ground vias
  ...QX.map((x, k) => tr('e' + k, [[x - 1.6, QY + 2.6], [x - 1.6, QY + 5.2]], 0.6)),
  // supply: battery + clip -> U1 VCC (top pin) and to the driver side (idle copper)
  tr('vcc', octi([[34.5, 28], [60, 28], [84.8, 28], [84.8, 41.2 - 0.6]]), 0.6),
  tr('gnd_c1', [[50, 70.25], [50, 73.2]], 0.6),
  tr('gnd_u1', [[87.2, 54.8 + 0.6], [87.2, 58.2]], 0.6),
  tr('ret', octi([[LS[0], LS[1]], [LS[0] + 18, LS[1] + 18, 'd'], [LS[0] + 18, 92]]), 0.9, { layer: 'bottom' }),
];
// the voice coil: an octagonal spiral (every run at 0/45/90°), from the outer start (left) inward, clockwise.
// Edge k lies on the line n_k · p = a_k (n_k at angle π + k·45°), a_k shrinking by one pitch per turn.
export const COIL = (() => {
  const turns = 5.5, pitch = (COIL_R - 3.2) / turns, n = Math.round(turns * 8);
  const N = k => [Math.cos(Math.PI + k * Math.PI / 4), Math.sin(Math.PI + k * Math.PI / 4)], A = k => COIL_R - pitch * k / 8;
  const meet = (k) => { const [a, b] = N(k), [c, d] = N(k + 1), e = A(k), f = A(k + 1), det = a * d - b * c; return [LS[0] + (e * d - b * f) / det, LS[1] + (a * f - e * c) / det]; };
  const pts = [[LS[0] - COIL_R, LS[1]]];
  for (let k = 0; k < n; k++) pts.push(meet(k));
  const [nx, ny] = N(n), a = A(n), last = pts[pts.length - 1];
  const foot = [LS[0] + nx * a, LS[1] + ny * a];                      // the point of the last edge's line nearest the centre
  pts.push(foot, [LS[0], LS[1]]);
  return pts;
})();
TRACES.push(tr('coil', COIL, 0.9, { clrK: 0.7 }));
// support parts a real doorbell board carries (unlit copper): ESD diode D1 on the button line, pull-down R2 on U1's
// input, decoupling capacitor C2 on U1's supply
TRACES.push(tr('d1', [[33, 66.25], [33, 69.6]], 0.45), tr('d1g', [[33, 74.4], [33, 76.4]], 0.6),
  tr('r2', [[74, 49.2], [74, 51.4]], 0.45), tr('r2g', [[74, 56.2], [74, 58.4]], 0.6),
  tr('c2', [[84.8, 34], [86.6, 34]], 0.45), tr('c2g', [[90.2, 34], [92.2, 34]], 0.6));
for (const t of TRACES) t.m = measure(t.pts);
export const byId = id => TRACES.find(t => t.id === id);

// ---------- pads ----------
export const PADS = [
  { x: BT[0], y: BT[1], r: 7.4, shape: 'round', id: 'btm' },                                       // − contact
  { x: 9.5, y: BT[1], w: 3.0, h: 6.2, shape: 'rect', r: 0.4, id: 'btp1' }, { x: 34.5, y: BT[1], w: 3.0, h: 6.2, shape: 'rect', r: 0.4, id: 'btp2' },
  ...SWP.map((p, i) => ({ x: p[0], y: p[1], w: 1.6, h: 1.2, shape: 'rect', r: 0.15, id: 'sw' + i })),
  { x: 38.8, y: 66.25, w: 1.1, h: 1.4, shape: 'rect', r: 0.12, id: 'r1a' }, { x: 41.2, y: 66.25, w: 1.1, h: 1.4, shape: 'rect', r: 0.12, id: 'r1b' },
  { x: 50, y: 66.25, w: 1.4, h: 1.1, shape: 'rect', r: 0.12, id: 'c1a' }, { x: 50, y: 70.25, w: 1.4, h: 1.1, shape: 'rect', r: 0.12, id: 'c1b' },
  ...UP.map((d, i) => ({ x: 79.2, y: U1[1] + d, w: 1.6, h: 0.8, shape: 'rect', r: 0.12, id: 'uL' + i })),
  ...UP.map((d, i) => ({ x: 92.8, y: U1[1] + d, w: 1.6, h: 0.8, shape: 'rect', r: 0.12, id: 'uR' + i })),
  ...UP.map((d, i) => ({ x: U1[0] + d, y: 41.2, w: 0.8, h: 1.6, shape: 'rect', r: 0.12, id: 'uT' + i })),
  ...UP.map((d, i) => ({ x: U1[0] + d, y: 54.8, w: 0.8, h: 1.6, shape: 'rect', r: 0.12, id: 'uB' + i })),
  ...QX.flatMap((x, k) => [
    { x, y: QY - 2.6, w: 1.3, h: 1.1, shape: 'rect', r: 0.12, id: 'qb' + k },
    { x: x - 1.6, y: QY + 2.6, w: 1.3, h: 1.1, shape: 'rect', r: 0.12, id: 'qe' + k },
    { x: x + 1.6, y: QY + 2.6, w: 1.3, h: 1.1, shape: 'rect', r: 0.12, id: 'qc' + k }]),
  { x: 66, y: 36, r: 0.8, shape: 'round', hole: 0.35, id: 'tp1' },
  { x: 33, y: 70.2, w: 1.3, h: 1.1, shape: 'rect', r: 0.12, id: 'd1a' }, { x: 33, y: 73.8, w: 1.3, h: 1.1, shape: 'rect', r: 0.12, id: 'd1b' },
  { x: 74, y: 52.0, w: 1.3, h: 1.1, shape: 'rect', r: 0.12, id: 'r2a' }, { x: 74, y: 55.6, w: 1.3, h: 1.1, shape: 'rect', r: 0.12, id: 'r2b' },
  { x: 87.2, y: 34, w: 1.1, h: 1.3, shape: 'rect', r: 0.12, id: 'c2a' }, { x: 89.6, y: 34, w: 1.1, h: 1.3, shape: 'rect', r: 0.12, id: 'c2b' },
];
export const VIAS = [
  [...V1, 0.55, 0.25], [...V2, 0.55, 0.25], [LS[0], LS[1], 0.7, 0.32],
  [50, 73.2, 0.5, 0.22], [87.2, 58.2, 0.5, 0.22], [33, 76.4, 0.5, 0.22], [74, 58.4, 0.5, 0.22], [92.2, 34, 0.5, 0.22], ...QX.map(x => [x - 1.6, QY + 5.2, 0.5, 0.22]),
];
export const KEEP = [
  { circle: [BT[0], BT[1], 12.2] }, { rect: [20.4, 60.6, 27.6, 67.4] }, { rect: [80.6, 42.6, 91.4, 53.4] },
  ...QX.map(x => ({ rect: [x - 2.6, QY - 1.6, x + 2.6, QY + 1.6] })),
  { circle: [LS[0], LS[1], COIL_R + 0.9] },
  { rect: [32.0, 69.4, 34.0, 74.6] }, { rect: [73.0, 51.2, 75.0, 56.4] }, { rect: [86.4, 33.0, 90.4, 35.0] },
];
export const HOLES = [[5, 5], [171, 5], [5, 99], [171, 99]];
export const FIDS = [[12, 6], [164, 98], [164, 6]];

// ---------- silkscreen ----------
const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const circ = (c, r) => ({ circle: [c[0], c[1], r] });
export const SILK = [
  { ...circ(BT, 11.6), w: 0.22 },
  { pts: [[BT[0] + 6.2, BT[1] - 9.8], [BT[0] + 8.2, BT[1] - 9.8]], w: 0.22 }, { pts: [[BT[0] + 7.2, BT[1] - 10.8], [BT[0] + 7.2, BT[1] - 8.8]], w: 0.22 },
  { pts: box(21.1, 61.1, 26.9, 66.9), w: 0.16 }, { ...circ(SW, 1.75), w: 0.16 }, { ...circ(SW, 1.05), w: 0.12 },
  { pts: [[38.2, 65.15], [41.8, 65.15]], w: 0.12 }, { pts: [[38.2, 67.35], [41.8, 67.35]], w: 0.12 },
  { pts: [[48.9, 67.7], [48.9, 68.8]], w: 0.12 }, { pts: [[51.1, 67.7], [51.1, 68.8]], w: 0.12 },
  { pts: [[81.2, 42.2], [91.2, 42.2], [91.2, 53.8], [80.8, 53.8], [80.8, 42.6], [81.2, 42.2]], w: 0.16 },
  { pts: [[80.0, 41.0], [80.01, 41.0]], w: 0.5 },                                                  // pin-1 dot
  ...QX.flatMap(x => [{ pts: box(x - 2.4, QY - 1.3, x + 2.4, QY + 1.3), w: 0.12 }, { ...circ([x, QY], 0.9), w: 0.08 },
    { pts: [[x - 0.45, QY - 0.6], [x - 0.45, QY + 0.6]], w: 0.08 }, { pts: [[x - 0.45, QY - 0.2], [x + 0.35, QY - 0.7]], w: 0.07 }, { pts: [[x - 0.45, QY + 0.2], [x + 0.35, QY + 0.7]], w: 0.07 }]),
  { ...circ(LS, 15.2), w: 0.24 }, { ...circ(LS, 15.8), w: 0.1, dash: [0.6, 0.6] },
  // speaker symbol beside LS1
  { pts: box(157.2, 50.4, 158.8, 53.6), w: 0.14 }, { pts: [[158.8, 50.4], [160.8, 48.6], [160.8, 55.4], [158.8, 53.6]], w: 0.14 },
  { ...circ([12, 6], 1.3), w: 0.1 }, { ...circ([164, 98], 1.3), w: 0.1 }, { ...circ([164, 6], 1.3), w: 0.1 },
  // D1 (diode, bar toward the line), R2 and C2 outlines
  { pts: [[31.9, 71.3], [34.1, 71.3]], w: 0.12 }, { pts: [[31.9, 71.5], [34.1, 71.5], [33, 72.7], [31.9, 71.5]], w: 0.1 },
  { pts: [[72.9, 51.2], [72.9, 56.4]], w: 0.1 }, { pts: [[75.1, 51.2], [75.1, 56.4]], w: 0.1 },
  { pts: [[88.4, 32.9], [88.4, 35.1]], w: 0.1 }, { pts: [[88.6, 32.9], [88.6, 35.1]], w: 0.1 },
  // title block, bottom left
  { pts: box(4, 84, 46, 96), w: 0.16 }, { pts: [[4, 89.4], [46, 89.4]], w: 0.1 }, { pts: [[30, 89.4], [30, 96]], w: 0.1 },
];
export const DESIG = [
  { text: 'BT1', x: 22, y: 41.6, cap: 1.4, align: 'center' }, { text: 'CR2032 3V', x: 22, y: 43.8, cap: 0.7, align: 'center' },
  { text: 'SW1', x: 20.6, y: 58.5, cap: 0.9, align: 'left' },
  { text: 'R1', x: 40, y: 63.4, cap: 0.8, align: 'center' }, { text: '1K', x: 40, y: 68.2, cap: 0.55, align: 'center' },
  { text: 'C1', x: 52.4, y: 67.8, cap: 0.8, align: 'left' }, { text: '0.1uF', x: 52.4, y: 69.4, cap: 0.5, align: 'left' },
  { text: 'U1', x: 91.2, y: 57.2, cap: 1.0, align: 'right' },
  ...QX.map((x, k) => ({ text: 'Q' + (k + 1), x: x + 2.9, y: QY - 2.0, cap: 0.75, align: 'left' })),
  { text: 'LS1', x: 152.4, y: 46.2, cap: 1.2, align: 'left' }, { text: '8 OHM', x: 152.4, y: 48.2, cap: 0.55, align: 'left' },
  { text: 'TP1', x: 67.4, y: 35.6, cap: 0.6, align: 'left' },
  { text: 'D1', x: 34.6, y: 71.2, cap: 0.7, align: 'left' }, { text: 'ESD', x: 34.6, y: 72.4, cap: 0.45, align: 'left' },
  { text: 'R2', x: 75.8, y: 52.8, cap: 0.7, align: 'left' }, { text: '100K', x: 75.8, y: 54.0, cap: 0.45, align: 'left' },
  { text: 'C2', x: 88.4, y: 31.2, cap: 0.7, align: 'center' },
  { text: '+3V', x: 60, y: 26.0, cap: 0.7, align: 'center' }, { text: 'GND', x: 140, y: 89.6, cap: 0.7, align: 'center' },
  { text: 'DOORBELL', x: 6, y: 85.6, cap: 2.0, align: 'left' },
  { text: 'REV A', x: 6, y: 91.4, cap: 1.1, align: 'left' }, { text: 'SHEET 1 OF 1', x: 32, y: 91.4, cap: 0.8, align: 'left' },
  { text: '2026-10', x: 6, y: 93.8, cap: 0.7, align: 'left' },
];
export const LABELS = [
  { id: 'push', text: '按下', x: 30.0, y: 62.7, cap: 1.5, sw: 0.18, align: 'left' },
  { id: 'pushE', text: 'PUSH', x: 30.05, y: 64.75, cap: 0.6, sw: 0.1, align: 'left' },
  { id: 'chip', text: '芯片', x: 72.2, y: 42.8, cap: 1.6, sw: 0.19, align: 'left' },
  { id: 'chipE', text: 'CHIP', x: 72.25, y: 45.0, cap: 0.7, sw: 0.11, align: 'left' },
  { id: 'spk', text: '扬声器', x: 154.6, y: 57.6, cap: 2.0, sw: 0.24, align: 'left' },
  { id: 'spkE', text: 'SPEAKER', x: 154.65, y: 60.5, cap: 0.85, sw: 0.13, align: 'left' },
  { id: 'ding', text: '叮', x: 155.0, y: 66.4, cap: 6.6, sw: 0.7, align: 'left' },
  { id: 'dong', text: '咚', x: 164.4, y: 66.4, cap: 6.6, sw: 0.7, align: 'left' },
  { id: 'dingE', text: 'DING-DONG', x: 155.1, y: 76.2, cap: 1.5, sw: 0.2, align: 'left' },
];

// ---------- vias: edge fence and ground stitching (only where there is open copper) ----------
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function clearOf(p, m) {
  for (const t of TRACES) { if (t.layer === 'bottom') continue; for (let i = 1; i < t.pts.length; i++) if (segDist(p, t.pts[i - 1], t.pts[i]) < t.w / 2 + CLR + m) return false; }
  for (const q of PADS) { const r = q.r ?? Math.max(q.w, q.h) / 2; if (Math.hypot(p[0] - q.x, p[1] - q.y) < r + CLR + m) return false; }
  for (const k of KEEP) {
    if (k.rect && p[0] > k.rect[0] - m && p[0] < k.rect[2] + m && p[1] > k.rect[1] - m && p[1] < k.rect[3] + m) return false;
    if (k.circle && Math.hypot(p[0] - k.circle[0], p[1] - k.circle[1]) < k.circle[2] + m) return false;
  }
  for (const L of LABELS) { const w = L.text.length * L.cap * 1.5; if (p[0] > L.x - 1 && p[0] < L.x + w + 1 && p[1] > L.y - 1 && p[1] < L.y + L.cap * 1.2 + 1) return false; }
  for (const d of DESIG) { const w = d.text.length * d.cap * 0.95, x0 = d.align === 'center' ? d.x - w / 2 : d.align === 'right' ? d.x - w : d.x; if (p[0] > x0 - 0.8 && p[0] < x0 + w + 0.8 && p[1] > d.y - 0.8 && p[1] < d.y + d.cap + 0.8) return false; }
  for (const h of HOLES) if (Math.hypot(p[0] - h[0], p[1] - h[1]) < 4.2) return false;
  for (const f of FIDS) if (Math.hypot(p[0] - f[0], p[1] - f[1]) < 2.4) return false;
  if (p[0] > 3.4 && p[0] < 46.6 && p[1] > 83.4 && p[1] < 96.6) return false;
  return true;
}
let _st = null, _fe = null;
export function stitch() {
  if (_st) return _st; _st = [];
  for (let y = 6; y < 100; y += 4) for (let x = 6 + ((y / 4) % 2) * 2; x < 172; x += 4) if (clearOf([x, y], 1.0)) _st.push([x, y]);
  return _st;
}
export function fence() {
  if (_fe) return _fe; _fe = [];
  const B = BOARD, i = 2.2;
  for (let x = B.x0 + 8; x <= B.x1 - 8; x += 2.2) { _fe.push([x, B.y0 + i], [x, B.y1 - i]); }
  for (let y = B.y0 + 8; y <= B.y1 - 8; y += 2.2) { _fe.push([B.x0 + i, y], [B.x1 - i, y]); }
  return _fe = _fe.filter(p => clearOf(p, 0.4));
}
export const CHILD = { at: DIE_AT, s: DIE_S };
