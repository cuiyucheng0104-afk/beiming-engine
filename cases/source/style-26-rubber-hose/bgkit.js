// bgkit.js — cached greyscale watercolour background helpers (wash, paper grain, cached canvas, camera mapping)
// Contrast rule: walls are mid-grey so they recede; the characters' white and ink black must be brighter/darker than anywhere in the background
import * as T from './toon.js';
import { P } from './parts.js';
import { mulberry } from '/core/lib.js';
const { shape, stroke, ell, arc, rr, rect, spline, quad } = T;

// Watercolour flat wash: base colour + soft mottling + pigment pooling at the edges + thin grey line
export function wash(pts, col, o = {}) {
  const g = T.g, Pth = shape(pts, { fill: col, stroke: false, boil: 0 });
  const rnd = mulberry(o.seed ?? 7);
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.clip(Pth);
  const bb = pts.map(p => T.tx(p[0], p[1])), xs = bb.map(p => p[0]), ys = bb.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const n = Math.min(110, Math.max(8, ((x1 - x0) * (y1 - y0)) / 9000 | 0));
  g.filter = 'blur(10px)';
  for (let i = 0; i < n; i++) { const r = 20 + rnd() * 90; g.fillStyle = rnd() > .5 ? `rgba(30,28,25,${.03 + rnd() * .05})` : `rgba(255,253,245,${.03 + rnd() * .05})`; g.beginPath(); g.ellipse(x0 + rnd() * (x1 - x0), y0 + rnd() * (y1 - y0), r, r * (.5 + rnd() * .6), rnd() * 3, 0, 7); g.fill(); }
  if ((o.edge ?? .16) > 0) { g.filter = 'blur(7px)'; g.strokeStyle = `rgba(20,18,16,${o.edge ?? .16})`; g.lineWidth = 26; g.stroke(Pth); }
  g.filter = 'none'; g.restore();
  if (o.line !== false) T.outline(Pth, o.lw ?? 3.2, o.lineCol ?? '#2A2927');
  return Pth;
}
export function paperGrain(g, w, h, seed = 3) {
  const rnd = mulberry(seed); g.setTransform(1, 0, 0, 1, 0, 0);
  for (let i = 0; i < w * h / 900; i++) { g.fillStyle = rnd() > .5 ? 'rgba(20,18,15,.06)' : 'rgba(255,255,250,.05)'; g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2); }
}
export function withCanvas(bg, fn) {
  const prev = T.g, oldB = T.BASE.slice(), oldL = T.S.lwScale, { PS, ox, oy } = bg;
  T.init(bg.cv); T.BASE.splice(0, 6, PS, 0, 0, PS, -ox * PS, -oy * PS); T.S.lwScale = PS; T.frame(0, { amp: 0 });
  const raw = () => T.g.setTransform(PS, 0, 0, PS, -ox * PS, -oy * PS);
  fn(T.g, raw); T.g.setTransform(1, 0, 0, 1, 0, 0);
  paperGrain(T.g, bg.cv.width, bg.cv.height, ox + 3);
  T.BASE.splice(0, 6, ...oldB); T.S.lwScale = oldL; T.init(prev.canvas);
}
export function makeBG(x0, y0, x1, y1, PS) { const cv = document.createElement('canvas'); cv.width = Math.round((x1 - x0) * PS); cv.height = Math.round((y1 - y0) * PS); return { cv, ox: x0, oy: y0, PS, w: x1 - x0, h: y1 - y0 }; }
// Draw the background to the scene canvas for a shot: cam = {x,y,z} maps a world point to the frame centre; squash = the whole background breathes with the beat (around pivotY)
export function drawBG(sg, bg, cam, squash = 0, pivotY = 1220) {
  const z = cam.z, ox = 960 - cam.x * z, oy = 540 - cam.y * z;
  sg.save(); sg.setTransform(z, 0, 0, z, ox, oy);
  if (squash) { sg.translate(0, pivotY); sg.scale(1 - squash * .4, 1 + squash); sg.translate(0, -pivotY); }
  sg.drawImage(bg.cv, bg.ox, bg.oy, bg.w, bg.h); sg.restore();
}
export const camBase = cam => [cam.z, 0, 0, cam.z, 960 - cam.x * cam.z, 540 - cam.y * cam.z];

