import { renderFilm, texts } from './film.js';
import { DUR, buildEvents } from './timeline.js';
const cv = document.getElementById('c'), g = cv.getContext('2d');
await Promise.all(['600 40px Caveat', '400 40px "Ma Shan Zheng"', '400 20px "IBM Plex Mono"', '500 20px "IBM Plex Mono"',
  '500 26px "Noto Sans SC"', '700 66px "Noto Serif SC"'].map(f => document.fonts.load(f, '地球的一秒天出生闪电个婴儿道每万分时1')));
window.DUR = DUR;
window.EV = buildEvents();
window.render = t => renderFilm(g, t);
window.TEXTS = t => texts(t);
window.READY = true;
