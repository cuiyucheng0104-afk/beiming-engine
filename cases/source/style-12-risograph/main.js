import { makeRiso } from './riso.js';
import { W, H, plate } from './draw.js';
import { renderFilm, DUR, EV, probe, texts } from './film.js';
import { clear, layer, g as _g } from './draw.js';
import * as DR from './draw.js';
import { figure, runPose, divePose } from './diver.js';
const Q = new URLSearchParams(location.search);
const out = document.getElementById('c');
const print = makeRiso(out, W, H);
await document.fonts.load('900 100px "Noto Sans SC"', '跳水扑通');
if (!document.fonts.check('900 100px "Noto Sans SC"', '跳水扑通')) throw new Error('font not loaded');
window.DUR = DUR; window.EV = EV;
let last = -1;
const at = t => { if (t !== last) { print(plate, renderFilm(t)); last = t; } };
window.render = t => {
  if (Q.get('test') === 'poses') {   // pose test sheet: run cycle (top), dive by action time (bottom)
    clear();
    for (let i = 0; i < 8; i++) layer(() => { const G = DR.g; G.save(); G.translate(140 + i * 230, 470); G.scale(-1, 1); figure(runPose(i / 8, .3), 380); G.restore(); }, 4);
    [0, .1, .2, .3, .45, .6, .8, 1.0, 1.15].forEach((u, i) => layer(() => { const G = DR.g; G.save(); G.translate(120 + i * 210, 830); G.scale(-1, 1); figure(divePose(u), 300); G.restore(); }, 4));
    print(plate, { seed: 1, off: [[0, 0], [2, -2], [0, 0]] }); return;
  }
  last = -1; at(t);
};
window.PROBE = t => { at(t); return probe(); };
window.TEXTS = t => { at(t); return texts(); };
window.READY = true;
