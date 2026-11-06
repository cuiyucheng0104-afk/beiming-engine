// The one word in the film: 归, cut as a plate of type into the night sky.
// The plate is drawn on a canvas each frame: an ink block with a ragged knife edge and a paper rim, and the five strokes of
// the character cut into it one by one, in stroke order, each swept by the knife in its own direction, chips at the blade.
import { mulberry } from '/core/lib.js';
import { INK, PAPER, cut } from './textures.js';

export const FONT = `'NotoSerifSC', serif`;
export const PLATE = { S: 1024, px: 700, ch: '归', grow: .018 };   // grow: the cut letters are widened by 1.8% of the em (≈ +20% stroke width) so 归 reads at a distance

// split the glyph into its five strokes: the two strokes of the left part are separate pieces; the right part (彐)
// is one piece, cut into its three horizontals by the gaps between them
function strokeMasks() {
  const { S, px, ch } = PLATE;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  g.font = `700 ${px}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff';
  g.fillText(ch, S / 2, S / 2 + px * .04);
  const a = g.getImageData(0, 0, S, S).data, on = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) on[i] = a[i * 4 + 3] > 100 ? 1 : 0;
  // connected components (4-neighbour flood fill)
  const lab = new Int32Array(S * S).fill(-1), comps = [];
  for (let i = 0; i < S * S; i++) {
    if (!on[i] || lab[i] >= 0) continue;
    const id = comps.length, st = [i]; lab[i] = id;
    let n = 0, sx = 0, sy = 0, x0 = S, y0 = S, x1 = 0, y1 = 0;
    while (st.length) {
      const p = st.pop(), x = p % S, y = (p / S) | 0; n++; sx += x; sy += y;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const q of [p - 1, p + 1, p - S, p + S]) if (q >= 0 && q < S * S && on[q] && lab[q] < 0) { lab[q] = id; st.push(q); }
    }
    comps.push({ id, n, cx: sx / n, cy: sy / n, x0, y0, x1, y1 });
  }
  const big = comps.filter(k => k.n > 300).sort((p, q) => q.n - p.n);
  const right = big.reduce((m, k) => (k.cx > m.cx ? k : m), big[0]);
  const left = big.filter(k => k !== right).sort((p, q) => p.cx - q.cx).slice(0, 2);   // 丨 then 丿
  // the horizontals of 彐: row counts of the right piece, three peaks
  const rows = new Float32Array(S);
  for (let y = right.y0; y <= right.y1; y++) for (let x = right.x0; x <= right.x1; x++) if (lab[y * S + x] === right.id) rows[y]++;
  const thr = (right.x1 - right.x0) * .45, bands = [];
  let inB = false, b0 = 0;
  for (let y = right.y0; y <= right.y1 + 1; y++) {
    const h = rows[y] > thr;
    if (h && !inB) { inB = true; b0 = y; } else if (!h && inB) { inB = false; bands.push([b0, y]); }
  }
  let cuts;
  if (bands.length >= 3) { const m = bands.map(([p, q]) => (p + q) / 2); cuts = [(m[0] + m[1]) / 2, (m[1] + m[2]) / 2]; }
  else { const h = right.y1 - right.y0; cuts = [right.y0 + h / 3, right.y0 + 2 * h / 3]; }
  // stroke list: mask test + sweep direction + box
  const strokes = [];
  const mk = (test, box, dir) => {
    const m = document.createElement('canvas'); m.width = m.height = S;
    const mg = m.getContext('2d'), im = mg.createImageData(S, S);
    for (let y = box[1]; y <= box[3]; y++) for (let x = box[0]; x <= box[2]; x++) { const i = y * S + x; if (test(i, y)) { im.data[i * 4] = 237; im.data[i * 4 + 1] = 229; im.data[i * 4 + 2] = 205; im.data[i * 4 + 3] = 255; } }
    mg.putImageData(im, 0, 0);
    // widen the cut: stamp the stroke on a disc of offsets (a dilation), so thin serif strokes survive the distance
    const G = Math.round(px * PLATE.grow), d = document.createElement('canvas'); d.width = d.height = S;
    const dg = d.getContext('2d');
    for (const rr of [G, G * .7, G * .4, 0]) { const n = rr ? Math.max(8, Math.round(rr * 1.6)) : 1;
      for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2; dg.drawImage(m, Math.round(Math.cos(a) * rr), Math.round(Math.sin(a) * rr)); } }
    strokes.push({ m: d, box: [box[0] - G, box[1] - G, box[2] + G, box[3] + G], dir });
  };
  for (const k of left) mk(i => lab[i] === k.id, [k.x0, k.y0, k.x1, k.y1], 'down');
  const yb = [right.y0, cuts[0], cuts[1], right.y1 + 1];
  for (let j = 0; j < 3; j++) mk((i, y) => lab[i] === right.id && y >= yb[j] && y < yb[j + 1], [right.x0, Math.floor(yb[j]), right.x1, Math.ceil(yb[j + 1])], 'right');
  // the glyph's box, for the reading check
  const G = Math.round(px * PLATE.grow);
  const all = big.reduce((m, k) => [Math.min(m[0], k.x0 - G), Math.min(m[1], k.y0 - G), Math.max(m[2], k.x1 + G), Math.max(m[3], k.y1 + G)], [S, S, 0, 0]);
  return { strokes, box: all };
}

let MASKS = null;
export function plateInfo() { if (!MASKS) MASKS = strokeMasks(); return MASKS; }

// st = { block: 0|1, strokes: [5 × 0..1], press: 0..1 }
export function plateCanvas(c, st) {
  const { S } = PLATE, { strokes } = plateInfo();
  if (!c) { c = document.createElement('canvas'); c.width = c.height = S; }
  const g = c.getContext('2d'), R = mulberry(1803);
  g.clearRect(0, 0, S, S);
  if (!st.block) return c;
  // the paper mount the block is set in: a broad paper band all round, so the ink plate stands out of the ink sky
  // as a printed object (the red's rule: a paper ring where something sits on ink)
  { const o = 6, e2 = S - o; g.fillStyle = PAPER; g.beginPath();
    const ed = (x0, y0, x1, y1) => { for (let i = 0; i <= 24; i++) { const u = i / 24, j = (R() - .5) * 6; g.lineTo(x0 + (x1 - x0) * u + (y0 === y1 ? 0 : j), y0 + (y1 - y0) * u + (y0 === y1 ? j : 0)); } };
    ed(o, o, e2, o); ed(e2, o, e2, e2); ed(e2, e2, o, e2); ed(o, e2, o, o); g.closePath(); g.fill(); }
  // the ink block, its edge cut by hand
  const m = 72, e = S - m;
  g.fillStyle = INK; g.beginPath();
  const edge = (x0, y0, x1, y1) => { for (let i = 0; i <= 24; i++) { const u = i / 24, j = (R() - .5) * 9; g.lineTo(x0 + (x1 - x0) * u + (y0 === y1 ? 0 : j), y0 + (y1 - y0) * u + (y0 === y1 ? j : 0)); } };
  edge(m, m, e, m); edge(e, m, e, e); edge(e, e, m, e); edge(m, e, m, m); g.closePath(); g.fill();
  // the paper rim: a cut line inside the edge, broken where the knife lifted
  const rim = (o, w, gap) => {
    for (const [x0, y0, x1, y1] of [[o, o, S - o, o], [S - o, o, S - o, S - o], [S - o, S - o, o, S - o], [o, S - o, o, o]]) {
      const n = 7;
      for (let k = 0; k < n; k++) { if (R() < gap) continue; const u0 = k / n, u1 = (k + .92) / n; cut(g, x0 + (x1 - x0) * u0, y0 + (y1 - y0) * u0, x0 + (x1 - x0) * u1, y0 + (y1 - y0) * u1, w, R, PAPER, .15); }
    }
  };
  rim(100, 9, .08);
  if (st.press > 0) { rim(124, 6, .1); for (const [x, y] of [[38, 38], [S - 38, 38], [38, S - 38], [S - 38, S - 38]]) { g.fillStyle = INK; g.fillRect(x - 14, y - 14, 28, 28); } }   // pressed: a second rim and the four ink registration marks on the paper mount
  // the strokes, each swept by the knife
  strokes.forEach((s, i) => {
    const p = st.strokes[i] || 0; if (p <= 0) return;
    const [x0, y0, x1, y1] = s.box;
    g.save(); g.beginPath();
    let fx, fy;
    if (s.dir === 'down') { const y = y0 + (y1 - y0 + 2) * p; g.rect(x0 - 4, y0 - 4, x1 - x0 + 8, y - y0 + 4); fx = (x0 + x1) / 2; fy = y; }
    else { const x = x0 + (x1 - x0 + 2) * p; g.rect(x0 - 4, y0 - 4, x - x0 + 4, y1 - y0 + 8); fx = x; fy = (y0 + y1) / 2; }
    g.clip(); g.drawImage(s.m, 0, 0); g.restore();
    if (p < 1) for (let k = 0; k < 9; k++) { const xx = fx + (R() - .3) * 40, yy = fy + (R() - .5) * 40; cut(g, xx, yy, xx + 6 + R() * 10, yy - 4 - R() * 6, 4, R, PAPER); }
  });
  // nicks of the knife across the cut letters
  g.save(); g.globalCompositeOperation = 'source-atop';
  const N = mulberry(77);
  for (let k = 0; k < 10; k++) { const x = 220 + N() * 600, y = 200 + N() * 620; if (st.strokes.some(v => v > 0)) cut(g, x, y, x + 6 + N() * 10, y + (N() - .5) * 2, 1.4, N, INK); }
  g.restore();
  return c;
}
