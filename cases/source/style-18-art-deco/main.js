// 页面契约：DUR / EV / render(t) / TEXTS(t) / READY
import * as film from './film.js';
const cv = document.getElementById('c'), g = cv.getContext('2d');
await Promise.all(['80px Italiana', '80px Poiret', '80px Limelight', "80px 'ZCOOL XiaoWei'"].map(f => document.fonts.load(f, f.includes('ZCOOL') ? '天台顶层落成之夜' : '1929')));
window.DUR = film.DUR;
window.EV = film.events();
window.TEXTS = t => film.texts(t);
window.render = t => film.renderFilm(g, t);
window.READY = true;
