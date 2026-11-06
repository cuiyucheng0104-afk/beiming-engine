// Canvas-drawn sprites and plates. Everything is ink, paper and one red; seeded, so every worker draws the same pixels.
import { mulberry } from '/core/lib.js';

export const INK = '#16171b', PAPER = '#ede5cd', RED = '#c4332b', YELLOW = '#dfa443';

// A short knife cut: blunt entry, tapered exit, a little wobble.
export function cut(g, x0, y0, x1, y1, w, R, col, taper = .85) {
  const n = 8, dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len, wob = (R() - .5) * len * .04;
  g.fillStyle = col; g.beginPath();
  for (let i = 0; i <= n; i++) {
    const s = i / n, ww = w * (1 - s * taper) * .5, b = Math.sin(s * Math.PI) * wob;
    g.lineTo(x0 + dx * s + nx * (ww + b), y0 + dy * s + ny * (ww + b));
  }
  for (let i = n; i >= 0; i--) {
    const s = i / n, ww = w * (1 - s * taper) * .5, b = Math.sin(s * Math.PI) * wob;
    g.lineTo(x0 + dx * s - nx * (ww - b), y0 + dy * s - ny * (ww - b));
  }
  g.fill();
}

// A tapered stroke along a polyline (w0 at the start, w1 at the end).
function ribbon(g, pts, w0, w1, col) {
  const L = [], Rr = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const w = (w0 + (w1 - w0) * i / (pts.length - 1)) / 2;
    L.push([pts[i][0] - dy * w, pts[i][1] + dx * w]); Rr.push([pts[i][0] + dy * w, pts[i][1] - dx * w]);
  }
  g.fillStyle = col; g.beginPath();
  L.forEach((p, i) => i ? g.lineTo(...p) : g.moveTo(...p));
  for (let i = Rr.length - 1; i >= 0; i--) g.lineTo(...Rr[i]);
  g.closePath(); g.fill();
}
export const bez = (p0, p1, p2, p3, n = 16) => {
  const o = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    o.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
  }
  return o;
};
const quadPts = (a, c, b, n = 14) => { const o = []; for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; o.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]); } return o; };

// ------------------------------------------------------------------ pines (windbreak belts)
// 8 variants, each 256×512. Bottom-centre of a tile is the trunk foot.
export function pineAtlas() {
  const TW = 256, TH = 512, N = 8;
  const c = document.createElement('canvas'); c.width = TW * N; c.height = TH;
  const g = c.getContext('2d');
  for (let v = 0; v < N; v++) {
    const R = mulberry(101 + v * 17), ox = v * TW + TW / 2;
    const top = 24 + R() * 30, foot = TH - 6;
    g.fillStyle = INK; g.fillRect(ox - 3, top + 40, 6, foot - top - 40);
    const tiers = 6 + Math.floor(R() * 4), lean = (R() - .5) * 12;
    for (let i = 0; i < tiers; i++) {
      const s = i / (tiers - 1);
      const yb = foot - 30 - (foot - 30 - top - 40) * s;
      const cx = ox + lean * s;
      const hwL = (1 - s * .9) * (62 + R() * 26) + 6, hwR = (1 - s * .9) * (62 + R() * 26) + 6;
      const yt = yb - (70 + 40 * (1 - s)) * (.8 + R() * .3);
      g.fillStyle = INK; g.beginPath(); g.moveTo(cx, yt);
      g.quadraticCurveTo(cx + hwR * .35, yt + (yb - yt) * .55, cx + hwR, yb + 6 + R() * 10);
      const nR = 3 + Math.floor(R() * 3);
      for (let k = 1; k <= nR; k++) { const u = 1 - k / (nR + 1); g.lineTo(cx + hwR * u + 4, yb - 10 - R() * 8); g.lineTo(cx + hwR * (u - .5 / (nR + 1)), yb + R() * 12); }
      g.lineTo(cx, yb - 16);
      const nL = 3 + Math.floor(R() * 3);
      for (let k = nL; k >= 1; k--) { const u = 1 - k / (nL + 1); g.lineTo(cx - hwL * (u + .5 / (nL + 1)), yb + R() * 12); g.lineTo(cx - hwL * u - 4, yb - 10 - R() * 8); }
      g.lineTo(cx - hwL, yb + 6 + R() * 10);
      g.quadraticCurveTo(cx - hwL * .35, yt + (yb - yt) * .55, cx, yt);
      g.fill();
      for (const side of [-1, 1]) {
        if (R() < .25) continue;
        const hw = side < 0 ? hwL : hwR, u = .35 + R() * .45;
        const x = cx + side * hw * u, y = yt + (yb - yt) * (.35 + .55 * u);
        cut(g, x - side * hw * .3, y - 10, x + side * hw * .15, y + 2, 6 + R() * 4, R, PAPER);
      }
    }
    cut(g, ox + lean, top - 10, ox + lean, top + 50, 7, R, INK);
  }
  return c;
}

// ------------------------------------------------------------------ steam wisps (from the demo kit)
// 4 wisps, 1024×256 each, stacked: lens-shaped clusters of horizontal paper cuts.
export function mistAtlas() {
  const W = 1024, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H * 4;
  const g = c.getContext('2d');
  for (let v = 0; v < 4; v++) {
    const R = mulberry(880 + v * 29), oy = v * H;
    for (let y = 30; y < H - 30; y += 8 + R() * 8) {
      const s = (y - 30) / (H - 60), env = Math.pow(Math.sin(s * Math.PI), .7);
      const half = W * .46 * env * (.7 + R() * .3), cx = W / 2 + (R() - .5) * 120;
      let x = cx - half;
      while (x < cx + half) {
        const len = 40 + R() * 260, gap = 10 + R() * 90;
        if (R() < .7) {
          const x1 = Math.min(cx + half, x + len), wv = Math.sin(x * .01 + v) * 3;
          cut(g, x, oy + y + wv, x1, oy + y + wv + (R() - .5) * 4, 4 + R() * 8 * env, R, PAPER, .9);
        }
        x += len + gap;
      }
    }
  }
  return c;
}

// ------------------------------------------------------------------ moon and sun
export function moonCanvas(S = 1024) {
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d'), R = mulberry(77), m = S / 2;
  g.strokeStyle = PAPER; g.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const r = 210 + i * 70 + R() * 20, a0 = R() * 6, sw = Math.PI * (.7 + R() * .9);
    g.lineWidth = 4 - i * .6; g.beginPath();
    for (let s = 0; s <= 1; s += .01) { const a = a0 + sw * s, rr = r * (1 + Math.sin(s * 9 + i) * .012); g.lineTo(m + Math.cos(a) * rr, m + Math.sin(a) * rr * .96); }
    g.stroke();
  }
  g.fillStyle = PAPER; g.beginPath(); g.arc(m, m, 150, 0, Math.PI * 2); g.fill();
  g.strokeStyle = PAPER; g.lineWidth = 3; g.beginPath(); g.arc(m + 4, m - 2, 168, -1.2, 1.4); g.stroke();
  for (const [dx, dy, L] of [[-62, -48, 70], [-20, -20, 95], [-80, 8, 60], [-30, 38, 85], [-58, 66, 50]]) {
    const x = m + dx + (R() - .5) * 10, y = m + dy;
    cut(g, x, y, x + L, y + (R() - .5) * 4, 9, R, INK);
  }
  return c;
}

// ================================================================== 雪夜小站: the film's own sprites
// ------------------------------------------------------------------ steam puffs from the engine
// 4 puffs, 512×512 each in a 2×2 atlas: a paper body built from round lobes, ink cuts under it (the shadow side),
// and the rim broken into horizontal paper wisps — steam is a paper field carrying ink cuts.
export function puffAtlas() {
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S * 2;
  const g = c.getContext('2d');
  for (let v = 0; v < 4; v++) {
    const R = mulberry(5150 + v * 37), ox = (v % 2) * S, oy = Math.floor(v / 2) * S;
    const tc = document.createElement('canvas'); tc.width = tc.height = S; const q = tc.getContext('2d');
    // lobes
    q.fillStyle = PAPER;
    const lobes = [];
    for (let i = 0; i < 9; i++) {
      const a = R() * Math.PI * 2, r = 40 + R() * 95;
      const x = S / 2 + Math.cos(a) * r * 1.1, y = S / 2 + Math.sin(a) * r * .75 - 10, rr = 70 + R() * 60;
      lobes.push([x, y, rr]); q.beginPath(); q.arc(x, y, rr, 0, 7); q.fill();
    }
    q.beginPath(); q.arc(S / 2, S / 2, 120, 0, 7); q.fill();
    // ink cuts on the underside of the body: horizontal, thicker toward the bottom
    q.save(); q.globalCompositeOperation = 'source-atop';
    for (let y = S / 2 - 20; y < S - 30; y += 9 + R() * 7) {
      const k = (y - S / 2 + 20) / (S / 2), n = 2 + Math.floor(R() * 3);
      for (let j = 0; j < n; j++) { const x = 60 + R() * (S - 200); if (R() < .35 + k * .5) cut(q, x, y, x + 40 + R() * 150, y + (R() - .5) * 3, 2.5 + k * 7, R, INK, .9); }
    }
    // a few fine ink cuts across the top too, so the puff reads on paper ground
    for (let i = 0; i < 6; i++) { const x = 120 + R() * 240, y = 110 + R() * 140; cut(q, x, y, x + 30 + R() * 80, y + (R() - .5) * 2, 2 + R() * 1.5, R, INK, .9); }
    q.restore();
    // the rim breaks into horizontal paper wisps
    q.save(); q.globalCompositeOperation = 'destination-out';
    for (let y = 20; y < S - 10; y += 6 + R() * 5) {
      for (let j = 0; j < 4; j++) { const x = R() * S; cut(q, x, y, x + 20 + R() * 60, y + (R() - .5) * 2, 3 + R() * 3, R, '#000', .2); }
    }
    q.restore();
    for (let i = 0; i < 18; i++) {   // loose wisps outside the body
      const [lx, ly, lr] = lobes[Math.floor(R() * lobes.length)], a = R() * Math.PI * 2;
      const x = lx + Math.cos(a) * (lr + 10), y = ly + Math.sin(a) * (lr * .6 + 8);
      cut(q, x - 30, y, x + 40 + R() * 60, y + (R() - .5) * 3, 4 + R() * 5, R, PAPER, .9);
    }
    g.drawImage(tc, ox, oy);
  }
  return c;
}

// ------------------------------------------------------------------ a station lamp: the warm yellow is light itself
export function lampCanvas(S = 256) {
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), R = mulberry(909), m = S / 2;
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + (R() - .5) * .2, r0 = 44 + R() * 6, r1 = 70 + R() * 50;
    cut(g, m + Math.cos(a) * r0, m + Math.sin(a) * r0, m + Math.cos(a) * r1, m + Math.sin(a) * r1, 5 + R() * 3, R, YELLOW);
  }
  g.fillStyle = YELLOW; g.beginPath(); g.arc(m, m, 34, 0, 7); g.fill();
  g.fillStyle = INK; g.fillRect(m - 34, m - 3, 68, 6);   // the lamp's glazing bar
  return c;
}

// ------------------------------------------------------------------ frost on the window: feathery paper cuts in the corners
export function frostCanvas(W = 1000, H = 900) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), R = mulberry(4242);
  const fern = (x, y, a, len, w, d) => {
    const x1 = x + Math.cos(a) * len, y1 = y + Math.sin(a) * len;
    cut(g, x, y, x1, y1, w, R, PAPER, .8);
    if (d <= 0) return;
    for (let k = 1; k < 5; k++) {
      const u = k / 5, px = x + (x1 - x) * u, py = y + (y1 - y) * u;
      for (const s of [-1, 1]) if (R() < .8) fern(px, py, a + s * (.7 + R() * .3), len * (.3 + R() * .15) * (1 - u * .5), w * .6, d - 1);
    }
  };
  for (const [cx, cy, a0] of [[0, 0, .6], [W, 0, Math.PI - .6], [0, H, -.6], [W, H, Math.PI + .6]]) {
    for (let i = 0; i < 6; i++) fern(cx, cy, a0 + (R() - .5) * 1.1, 120 + R() * 130, 7, 2);
  }
  // a paper frame line where the glazing bead meets the opening
  g.strokeStyle = PAPER; g.lineWidth = 9; g.strokeRect(6, 6, W - 12, H - 12);
  return c;
}

// ------------------------------------------------------------------ the red lantern, waking in stages
// st = { wick: 0|1, rows: 0..1 (the body printed row by row, from the middle out), done: 0..1 (tassel, ring, light) }
export const LANT = { W: 512, H: 704, cx: 256, cy: 350, rx: 205, ry: 228 };
export function lanternCanvas(c, st) {
  const { W, H, cx, cy, rx, ry } = LANT;
  if (!c) { c = document.createElement('canvas'); c.width = W; c.height = H; }
  const g = c.getContext('2d'), R = mulberry(1225);
  g.clearRect(0, 0, W, H);
  const lit = st.rows > 0;
  // the cord and the caps are always there: paper lines on the dark of the carriage
  g.fillStyle = PAPER; g.fillRect(cx - 2, 0, 4, 82);
  const cap = (y0, h, w) => { g.fillStyle = INK; g.fillRect(cx - w / 2, y0, w, h); g.strokeStyle = PAPER; g.lineWidth = 4; g.strokeRect(cx - w / 2 + 2, y0 + 2, w - 4, h - 4); };
  // the body: unlit, a ghost of broken paper ribs; lit, red printed row by row with ink ribs cut through it
  const half = (y) => { const u = (y - cy) / ry; return u * u >= 1 ? 0 : rx * Math.sqrt(1 - u * u); };
  if (!lit) {
    for (let k = -3; k <= 3; k++) {
      const f = k / 3.5;
      for (let y = cy - ry + 12; y < cy + ry - 12; y += 26) {
        if (R() < .45) continue;
        const x0 = cx + half(y) * f, x1 = cx + half(y + 18) * f;
        cut(g, x0, y, x1, y + 18, 3.2, R, PAPER, .6);
      }
    }
  } else {
    const rowH = 15, nRows = Math.ceil(ry * 2 / rowH);
    // paper ring under the red where it sits on ink
    g.fillStyle = PAPER;
    for (let i = 0; i < nRows; i++) {
      const y = cy - ry + i * rowH, d = Math.abs(i + .5 - nRows / 2) / (nRows / 2);
      if (d > st.rows * 1.04) continue;
      const hw = Math.max(half(y), half(y + rowH)) + 6;
      g.fillRect(cx - hw, y - (i === 0 ? 6 : 0), hw * 2, rowH + 1 + (i === nRows - 1 ? 6 : 0));
    }
    g.fillStyle = RED;
    for (let i = 0; i < nRows; i++) {
      const y = cy - ry + i * rowH, d = Math.abs(i + .5 - nRows / 2) / (nRows / 2);
      if (d > st.rows * 1.04) continue;
      // each band is a flat stab of red, its ends following the lantern's outline (a hair off register, as printed)
      g.beginPath();
      const steps = 6;
      for (let s = 0; s <= steps; s++) { const yy = y + rowH * s / steps; g.lineTo(cx - half(yy) + (i % 2 ? 1.5 : -1), yy); }
      for (let s = steps; s >= 0; s--) { const yy = y + rowH * s / steps; g.lineTo(cx + half(yy) + (i % 2 ? 1.5 : -1), yy); }
      g.closePath(); g.fill();
    }
    // ink ribs: meridians cut through the red
    g.save(); g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, 7); g.clip();
    for (let k = -3; k <= 3; k++) {
      const f = k / 3.5;
      g.strokeStyle = INK; g.lineWidth = k === 0 ? 6 : 5; g.beginPath();
      for (let y = cy - ry; y <= cy + ry; y += 6) g.lineTo(cx + half(y) * f, y);
      g.stroke();
    }
    // two horizontal ink cuts across the waist
    for (const yy of [cy - 70, cy + 70]) cut(g, cx - rx, yy, cx + rx, yy + 2, 4, R, INK, .1);
    g.restore();
  }
  cap(82, 38, 190); cap(cy + ry - 8, 36, 170);
  // the wick: one red point in the middle of the dark
  if (st.wick && !lit) {
    g.fillStyle = PAPER; g.beginPath(); g.arc(cx, cy + 20, 27, 0, 7); g.fill();
    g.fillStyle = RED; g.beginPath(); g.arc(cx, cy + 20, 22, 0, 7); g.fill();
  }
  // tassel: red strands under the bottom cap; light: a few warm cuts radiating from the lantern
  if (st.done > 0) {
    const n = 9, y0 = cy + ry + 28, len = 62 * st.done;
    g.fillStyle = PAPER; g.fillRect(cx - 34, y0 - 2, 68, len + 8);
    for (let i = 0; i < n; i++) { const x = cx - 28 + i * 7; g.fillStyle = RED; g.fillRect(x, y0, 5, len * (.85 + .15 * ((i * 7) % 3) / 2)); }
  } else {
    g.strokeStyle = PAPER; g.lineWidth = 3; g.strokeRect(cx - 28, cy + ry + 30, 56, 50);
  }
  return c;
}
