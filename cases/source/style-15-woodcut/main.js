// 灯塔守夜 · 入口：DUR / EV / TEXTS / render(t) / READY
import { DUR, K } from './timeline.js';
import { SHOTS, CAPTION } from './shots.js';
import { captionBox } from './stage.js';
const cv = document.getElementById('cv'), g = cv.getContext('2d');
await document.fonts.load('900 54px "Noto Serif SC"', CAPTION);
const EV = [];
for (const s of SHOTS) EV.push(...s.events());
EV.sort((a, b) => a.t - b.t);
window.DUR = DUR;
window.EV = EV;
window.TEXTS = t => t >= K.caption ? [{ id: 'caption', text: CAPTION, ...Object.fromEntries(['x0', 'y0', 'x1', 'y1'].map((k, i) => [k, captionBox(CAPTION)[i]])) }] : [];
window.render = t => {
  g.setTransform(1, 0, 0, 1, 0, 0);
  const s = SHOTS.find(s => t >= s.t0 - 1e-6 && t < s.t1 - 1e-6) || SHOTS[SHOTS.length - 1];
  s.draw(g, t, t - s.t0);
};
window.READY = true;
