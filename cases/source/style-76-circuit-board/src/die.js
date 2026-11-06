// Inside U1: the die of the melody chip, drawn as a board of its own (nested in U1's footprint).
// Units: 1 unit = 22 µm (world.js DIE_S). The chain is the one a ding-dong chip really has:
// IN (bond pad) -> Schmitt trigger (cleans the bouncing button) -> D flip-flop (latches one press) ->
// a 16-step sequencer clocked by the on-chip oscillator -> two tone ROM cells (叮, 咚) -> output driver -> OUT pad.
import { measure, octi } from './geo.js';

export const BOARD = { x0: -160, y0: -70, x1: 160, y1: 70, r: 3, inset: 0.8 };
export const CLR = 1.4, VIA_R = 1.1, FENCE_R = 1.0;
const tr = (id, pts, w, o = {}) => ({ id, pts, w, ...o });
const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

export const IN = [-150, -30], OUT = [150, 30];
export const SCH = [-122, -30], DFF = [-90, -30];
export const SEQ = Array.from({ length: 16 }, (_, i) => [-58 + i * 11.6, -30]);
export const ROM1 = [24, 22], ROM2 = [74, 22], DRV = [118, 30];
export const OSC = [-90, 18];

export const TRACES = [
  tr('in', [[IN[0] + 5, -30], [SCH[0] - 9, -30]], 2.4),
  tr('sch', [[SCH[0] + 9, -30], [DFF[0] - 9, -30]], 2.4),
  tr('dff', [[DFF[0] + 9, -30], [SEQ[0][0] - 4.5, -30]], 2.4),
  tr('scan', [[SEQ[0][0] - 4.5, -30], [SEQ[15][0] + 4.5, -30]], 1.6),
  tr('addr', octi([[SEQ[15][0] + 4.5, -30], [136, -30], [136, -8], [6, -8], [0, -2, 'd'], [0, ROM1[1]], [ROM1[0] - 17, ROM1[1]]]), 2.0),
  tr('r12', [[ROM1[0] + 17, ROM1[1]], [ROM2[0] - 17, ROM2[1]]], 2.4),
  tr('r2d', octi([[ROM2[0] + 17, ROM2[1]], [100, 22], [108, 30, 'd'], [DRV[0] - 8, 30]]), 2.4),
  tr('outp', [[DRV[0] + 8, 30], [OUT[0] - 5, 30]], 3.2),
  // the clock: oscillator -> sequencer (idle copper until the clock starts)
  tr('clk', octi([[OSC[0] + 10, OSC[1]], [-70, 18], [-62, 10, 'd'], [-62, -18], [SEQ[15][0], -18]]), 1.2),
  // supply rails along the top and bottom edges
  tr('vdd', [[-146, -56], [146, -56]], 3.0), tr('vss', [[-146, 56], [146, 56]], 3.0),
];
for (const t of TRACES) t.m = measure(t.pts);
export const byId = id => TRACES.find(t => t.id === id);

// bond pads around the edge, the IN and OUT pads among them
export const PADS = [];
for (let x = -140; x <= 140; x += 20) PADS.push({ x, y: -64, r: 3.6, shape: 'square', id: 'bt' + x }, { x, y: 64, r: 3.6, shape: 'square', id: 'bb' + x });
for (let y = -50; y <= 50; y += 20) PADS.push({ x: -152, y, r: 3.6, shape: 'square', id: 'bl' + y }, { x: 152, y, r: 3.6, shape: 'square', id: 'br' + y });
// cell pins
const pin = (p, id) => ({ x: p[0], y: p[1], w: 2.6, h: 3.4, shape: 'rect', r: 0.4, id });
PADS.push(pin([SCH[0] - 9, -30], 'schI'), pin([SCH[0] + 9, -30], 'schO'), pin([DFF[0] - 9, -30], 'dffI'), pin([DFF[0] + 9, -30], 'dffO'));
SEQ.forEach((p, i) => PADS.push({ x: p[0], y: p[1], r: 2.0, shape: 'square', id: 'sq' + i }));
PADS.push(pin([ROM1[0] - 17, ROM1[1]], 'r1I'), pin([ROM1[0] + 17, ROM1[1]], 'r1O'), pin([ROM2[0] - 17, ROM2[1]], 'r2I'), pin([ROM2[0] + 17, ROM2[1]], 'r2O'));
PADS.push(pin([DRV[0] - 8, 30], 'drI'), pin([DRV[0] + 8, 30], 'drO'), pin([OSC[0] + 10, OSC[1]], 'oscO'));

export const KEEP = [
  { rect: [SCH[0] - 10, -40, SCH[0] + 10, -20] }, { rect: [DFF[0] - 10, -42, DFF[0] + 10, -18] },
  { rect: [SEQ[0][0] - 6, -37, SEQ[15][0] + 6, -23] },
  { rect: [ROM1[0] - 19, ROM1[1] - 16, ROM1[0] + 19, ROM1[1] + 16] }, { rect: [ROM2[0] - 19, ROM2[1] - 16, ROM2[0] + 19, ROM2[1] + 16] },
  { rect: [DRV[0] - 9, 22, DRV[0] + 9, 38] }, { rect: [OSC[0] - 12, 8, OSC[0] + 12, 28] },
];

// silkscreen: one symbol per cell
const tri = (c, s) => [[c[0] - s * 0.6, c[1] - s * 0.7], [c[0] + s * 0.7, c[1]], [c[0] - s * 0.6, c[1] + s * 0.7], [c[0] - s * 0.6, c[1] - s * 0.7]];
export const SCH_SYM = [tri(SCH, 9), [[SCH[0] - 3.4, -27.4], [SCH[0] - 1.4, -27.4], [SCH[0] - 1.4, -32.6], [SCH[0] + 0.6, -32.6]], [[SCH[0] - 2.4, -27.4], [SCH[0] - 2.4, -32.6], [SCH[0] - 0.4, -32.6]]];
export const DFF_SYM = [box(DFF[0] - 7, -41, DFF[0] + 7, -19), [[DFF[0] - 7, -23.5], [DFF[0] - 4.5, -21.5], [DFF[0] - 7, -19.5]]];
export const SEQ_SYM = SEQ.map(p => box(p[0] - 4.6, -36, p[0] + 4.6, -24));
export const ROM_SYM = [box(ROM1[0] - 15, ROM1[1] - 14, ROM1[0] + 15, ROM1[1] + 14), box(ROM2[0] - 15, ROM2[1] - 14, ROM2[0] + 15, ROM2[1] + 14)];
export const DRV_SYM = [tri(DRV, 8), [[DRV[0] + 5.6, 30], [DRV[0] + 6.4, 30]]];
export const OSC_SYM = [box(OSC[0] - 9, 10, OSC[0] + 9, 26), [[OSC[0] - 6, 21], [OSC[0] - 6, 15], [OSC[0] - 2, 15], [OSC[0] - 2, 21], [OSC[0] + 2, 21], [OSC[0] + 2, 15], [OSC[0] + 6, 15]]];
export const SILK = [
  ...[...SCH_SYM, ...DFF_SYM, ...SEQ_SYM, ...ROM_SYM, ...DRV_SYM, ...OSC_SYM].map(pts => ({ pts, w: 0.9 })),
  { pts: box(-157, -67, 157, 67), w: 0.8, dash: [3, 2.4] },
];
// standard-cell rows: the die's own texture, outlines only
for (let r = 0; r < 4; r++) for (let c = 0; c < 9; c++) {
  const x = -146 + c * 13, y = 36 + r * -0 + 0; if (r > 0) continue;
  SILK.push({ pts: box(x, 34, x + 10, 46), w: 0.4 });
}
for (let c = 0; c < 22; c++) { const x = -140 + c * 13; SILK.push({ pts: box(x, -50, x + 10, -44), w: 0.35 }); }
for (let c = 0; c < 8; c++) { const x = -40 + c * 12; SILK.push({ pts: box(x, 40, x + 9, 48), w: 0.35 }); }
export const DESIG = [
  { text: 'IN', x: IN[0] + 6, y: -40, cap: 4.2, align: 'left' },
  { text: 'OUT', x: OUT[0] - 6, y: 38, cap: 4.2, align: 'right' },
  { text: 'SCHMITT', x: SCH[0], y: -17, cap: 3.0, align: 'center' },
  { text: 'DFF', x: DFF[0], y: -16, cap: 3.0, align: 'center' },
  { text: 'SEQ 0-15', x: SEQ[0][0] - 4.6, y: -42, cap: 3.0, align: 'left' },
  { text: 'OSC', x: OSC[0], y: 30, cap: 3.0, align: 'center' },
  { text: 'ROM', x: ROM1[0] - 15, y: 3.4, cap: 3.0, align: 'left' },
  { text: 'DRV', x: DRV[0], y: 40, cap: 3.0, align: 'center' },
  { text: 'U1 DIE', x: -146, y: -48 + 0, cap: 2.2, align: 'left' },
];
export const LABELS = [
  { id: 'rom1', text: '叮', x: ROM1[0] - 7.2, y: ROM1[1] - 6.2, cap: 12, sw: 1.3, align: 'left' },
  { id: 'rom2', text: '咚', x: ROM2[0] - 7.2, y: ROM2[1] - 6.2, cap: 12, sw: 1.3, align: 'left' },
];
export const VIAS = [];
let _st = null;
export function stitch() {
  if (_st) return _st; _st = [];
  const ok = p => {
    for (const k of KEEP) if (p[0] > k.rect[0] - 4 && p[0] < k.rect[2] + 4 && p[1] > k.rect[1] - 4 && p[1] < k.rect[3] + 4) return false;
    for (const t of TRACES) for (let i = 1; i < t.pts.length; i++) {
      const a = t.pts[i - 1], b = t.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
      const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
      if (Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy) < t.w / 2 + CLR + 3) return false;
    }
    for (const q of PADS) if (Math.abs(p[0] - q.x) < 9 && Math.abs(p[1] - q.y) < 9) return false;
    if (p[1] > 30 && p[1] < 50 && p[0] < 0) return false;
    if (p[1] > -52 && p[1] < -42) return false;
    if (Math.abs(p[0]) > 144 || Math.abs(p[1]) > 58) return false;
    return true;
  };
  for (let y = -50; y <= 52; y += 8) for (let x = -140 + ((y / 8) & 1) * 4; x <= 140; x += 8) if (ok([x, y])) _st.push([x, y]);
  return _st;
}
export function fence() { return []; }
export const CHILD = null;
