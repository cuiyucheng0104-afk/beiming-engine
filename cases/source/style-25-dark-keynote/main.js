import { renderFilm, texts, buildEvents, layout, DUR } from './film.js';
const cv = document.getElementById('c'), g = cv.getContext('2d');
await Promise.all(['500 40px Inter', '600 40px Inter', '600 40px InterTight', '500 40px JBMono', '500 40px NotoSC'].map(f => document.fonts.load(f, f.includes('NotoSC') ? '桌面手机手表流明' : '0.3 WLumen')));
layout(g);
window.DUR = DUR;
window.EV = buildEvents();
window.TEXTS = texts;
window.render = t => renderFilm(g, t);
window.READY = true;
