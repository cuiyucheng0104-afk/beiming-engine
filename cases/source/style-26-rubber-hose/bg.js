// bg.js — the bedroom, painted once into a cached canvas (backgrounds never boil; they stay in the middle greys)
import * as T from './toon.js';
import { P } from './parts.js';
import { mulberry } from '/core/lib.js';
import { wash, makeBG, withCanvas } from './bgkit.js';
export { drawBG } from './bgkit.js';
const { ell, arc, rr, rect, spline } = T;

export const FLOOR_Y = 1010, NS = { x: 900, top: 724 }, BED_X = 1110, WIN = { x0: 150, x1: 500, y0: 210, y1: 640 };
export function paintBedroom() {
  const bg = makeBG(-320, -140, 2520, 1260, 1.4), X0 = -320, W = 2840;
  withCanvas(bg, (g, raw) => {
    // ceiling moulding
    wash(rect(X0 - 10, -150, W + 20, 70), '#3A3E41', { seed: 31, edge: 0 });
    wash(rect(X0 - 10, -84, W + 20, 18), '#5A5F63', { seed: 32 });
    // wallpaper: mid grey + vertical ribbon stripes + small four-dot flowers
    wash(rect(X0 - 10, -66, W + 20, 760), '#878D92', { line: false, seed: 33, edge: 0 });
    raw();
    for (let x = X0; x < X0 + W; x += 90) { g.fillStyle = 'rgba(250,252,255,.08)'; g.fillRect(x, -66, 30, 760); g.fillStyle = 'rgba(20,24,28,.10)'; g.fillRect(x + 30, -66, 4, 760); }
    for (let x = X0 + 60; x < X0 + W; x += 90) for (let y = -20; y < 680; y += 84) {
      const yy = y + ((x / 90) % 2) * 42; g.fillStyle = 'rgba(25,28,32,.22)';
      for (const [dx, dy] of [[0, -7], [7, 0], [0, 7], [-7, 0]]) { g.beginPath(); g.arc(x + dx, yy + dy, 3.4, 0, 7); g.fill(); }
    }
    // wainscot panels
    wash(rect(X0 - 10, 694, W + 20, 316), '#5D6266', { seed: 34, edge: .1 });
    wash(rect(X0 - 10, 684, W + 20, 18), '#3F4346', { seed: 35 });
    for (let x = X0 + 30; x < X0 + W - 100; x += 190) wash(rr(x, 730, 150, 230, 8), '#686D71', { seed: x, edge: .14, lw: 2.6 });
    wash(rect(X0 - 10, 984, W + 20, 26), '#33373A', { seed: 36 });
    // floorboards + a round rug
    wash(rect(X0 - 10, 1010, W + 20, 260), '#6E7377', { line: false, seed: 37, edge: 0 });
    raw(); g.strokeStyle = 'rgba(25,28,30,.35)'; g.lineWidth = 2.4;
    for (let y = 1040; y < 1260; y += 34 + (y - 1010) * .18) { g.beginPath(); g.moveTo(X0, y); g.lineTo(X0 + W, y); g.stroke(); }
    wash(ell(1500, 1110, 560, 70), '#7C8185', { seed: 38, edge: .12 });
    wash(ell(1500, 1110, 470, 52), '#91969A', { seed: 39, edge: .1 });
    // window: frame, sky panes with soft clouds, sill
    const { x0, x1, y0, y1 } = WIN;
    wash(rr(x0 - 26, y0 - 26, x1 - x0 + 52, y1 - y0 + 52, 8), '#3C4043', { seed: 40 });
    wash(rect(x0, y0, x1 - x0, y1 - y0), '#B2B7BB', { seed: 41, edge: .06 });
    const rnd = mulberry(5); raw();
    for (let i = 0; i < 9; i++) { g.fillStyle = 'rgba(235,238,240,.5)'; g.beginPath(); g.ellipse(x0 + rnd() * (x1 - x0), y0 + 60 + rnd() * 160, 40 + rnd() * 50, 16 + rnd() * 10, 0, 0, 7); g.fill(); }
    wash(rect(x0 - 4, y0 + 300, x1 - x0 + 8, y1 - y0 - 300), '#8E9398', { seed: 42, edge: .05 });   // rooftops far away
    raw(); g.fillStyle = 'rgba(60,64,68,.35)';
    for (const [rx, rw, rh] of [[x0 + 10, 70, 60], [x0 + 95, 90, 95], [x0 + 200, 60, 50], [x0 + 268, 80, 80]]) g.fillRect(rx, y0 + 300 - rh + 30, rw, rh);
    wash(rect((x0 + x1) / 2 - 9, y0, 18, y1 - y0), '#3C4043', { seed: 43 });
    wash(rect(x0, (y0 + y1) / 2 - 9, x1 - x0, 18), '#3C4043', { seed: 44 });
    wash(rr(x0 - 46, y1 + 20, x1 - x0 + 92, 26, 6), '#4A4E52', { seed: 45 });
    // curtain rod
    wash(rr(x0 - 120, y0 - 70, x1 - x0 + 240, 16, 8), '#2E3235', { seed: 46 });
    for (const bx of [x0 - 128, x1 + 128]) wash(ell(bx, y0 - 62, 16, 16), '#2E3235', { seed: bx });
    // shelf on the wall above the bed head: books
    wash(rr(1180, 360, 260, 18, 4), '#3F4346', { seed: 47 });
    let bx = 1196; for (const [w, h, c] of [[26, 92, '#5A5F63'], [22, 80, '#9EA3A7'], [30, 100, '#4A4E52'], [24, 70, '#B3B8BB'], [28, 88, '#686D71']]) { wash(rr(bx, 360 - h, w, h, 3), c, { seed: bx, edge: .06, lw: 2.4 }); bx += w + 4; }
    // shadows on the floor under furniture
    raw(); g.filter = 'blur(14px)'; g.fillStyle = 'rgba(15,17,19,.32)';
    g.beginPath(); g.ellipse(NS.x, FLOOR_Y + 8, 150, 20, 0, 0, 7); g.fill();
    g.beginPath(); g.ellipse(BED_X + 410, FLOOR_Y + 10, 470, 24, 0, 0, 7); g.fill();
    g.filter = 'none';
  });
  return bg;
}
