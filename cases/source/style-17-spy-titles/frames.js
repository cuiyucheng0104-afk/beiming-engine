// 风格帧：直接调用成片的绘制代码，取三个关键时刻
import { renderFilm } from './film.js';
import { T, B } from './timeline.js';
const AT = { fall: B(3.2), file: B(12.4), freeze: B(24.6), safe: B(30), title: B(37) };
export function frame(name, t) { renderFilm(AT[name] ?? t); }
