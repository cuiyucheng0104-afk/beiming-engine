// 悬索桥为何不倒 — the single source of time. Everything (picture, score, foley, checks) reads these numbers.
// 96 BPM, 4/4, beat = 0.625 s = 15 frames at 24 fps; the grid starts at OFF = 0.25 s (frame 6).
export const BPM = 96, BEAT = 60 / BPM, OFF = 0.25, FPS = 24, DUR = 19.875;
export const b = k => +(OFF + k * BEAT).toFixed(6);

// Sections (beats). Silence: b21 → b23.
export const SECS = [
  { id: 'wall',    b0: 0,  b1: 6,  note: '证据落墙：照片、磁贴、标题' },
  { id: 'span',    b0: 6,  b1: 14, note: '骑尺寸线：1280 米' },
  { id: 'load',    b0: 14, b1: 21, note: '荷载磁贴逐块挂缆（加速），力流向塔' },
  { id: 'silence', b0: 21, b1: 23, note: '静默，只剩房间底噪' },
  { id: 'verdict', b0: 23, b1: 31.4, note: '红磁贴砸上塔顶 → 擦成残影 → 结论 → 整墙拉远（减速）' },
];

// Visual hits, in beats. Every one of these must land on the grid (tools/cuecheck.mjs).
export const HIT = {
  landTower: 0, pinTower1: 1, pinTower2: 1.5,
  title: 1.5,                   // marker starts writing 为何不倒？ (with the second pin)
  landBay: 3, pinBay1: 3.5, pinBay2: 4,
  landCable: 5, pinCable: 5.5,
  extL: 7, dimStart: 7, extR: 11.5, dimEnd: 12, label: 12,
  loads: [14, 15, 16, 16.5, 17, 17.5, 18, 18.25, 18.5, 18.75],   // 1/4 → 1/8 → 1/16: the acceleration
  flow: 19, tops: 20, base: 21,
  verdict: 23,                  // first sound after the silence: two red magnets slam onto the tower tops
  erase: 24, writeA: 25, writeB: 26.5, pull: 25.5, settle: 28.5,
};
export const H = Object.fromEntries(Object.entries(HIT).map(([k, v]) => [k, Array.isArray(v) ? v.map(b) : b(v)]));

// The wall (board px). Elevation drawn to one scale: 1,280 m main span = 3,000 px.
export const BOARD = { w: 6400, h: 3600 };
export const S = 3000 / 1280;                    // px per metre
export const WL = 3150;                          // water line
export const XL = 1500, XR = 4500, XM = 3000;    // towers, mid-span
export const TT = Math.round(WL - 227 * S);      // tower top (227 m above water)
export const DK = Math.round(WL - 67 * S);       // deck (67 m above water)
export const LOW = DK - 8;                       // main cable's low point at mid-span
export const XAL = Math.round(XL - 343 * S), XAR = Math.round(XR + 343 * S);   // anchorages (343 m side spans)
export const cableY = x => x >= XL && x <= XR ? LOW + (TT - LOW) * ((x - XM) / (XR - XM)) ** 2
  : (() => { const xa = x < XL ? XAL : XAR, xt = x < XL ? XL : XR, u = (x - xt) / (xa - xt); return TT + (DK - 10 - TT) * u + 60 * u * (1 - u); })();
