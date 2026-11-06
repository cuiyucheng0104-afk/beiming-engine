import * as film from './film.js';
const cv = document.getElementById('c'), g = cv.getContext('2d');
for (const w of [400, 500, 600, 700]) await document.fonts.load(`${w} 40px Jost`);
for (const w of [500, 700]) await document.fonts.load(`${w} 40px NotoSC`, '寄出分拣陆运航空投递送达北城南港公里天示意不按比例');
window.DUR = film.DUR; window.EV = film.events();
window.render = t => { g.setTransform(1, 0, 0, 1, 0, 0); g.filter = 'none'; g.globalAlpha = 1; film.render(g, t); };
window.TEXTS = t => film.texts();
window.READY = true;
