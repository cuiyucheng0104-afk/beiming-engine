// page contract: window.READY, window.render(t), window.DUR, window.EV, window.TEXTS(t)
import { textures } from './engine/toon.js';
import { DUR } from './timeline.js';
import { renderFilm, events } from './film.js';
const cv = document.getElementById('c'), g = cv.getContext('2d');
await Promise.all(['80px Slab', '700 44px NotoSC', '900 112px SerifSC'].map(f => document.fonts.load(f, f.includes('Slab') ? '123' : '明日早晨吐司咖啡报纸晨')));
textures();
window.DUR = DUR;
window.EV = events();
window.render = t => renderFilm(g, t);
window.TEXTS = t => { const rec = []; renderFilm(g, t, rec); return rec; };
window.READY = true;
