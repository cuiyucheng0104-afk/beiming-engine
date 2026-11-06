import { g, C, paperFinish } from './paper.js';
import { loadFonts } from './glyph.js';
import { renderFilm, texts, events, DUR } from './film.js';
import { frame } from './frames.js';
const Q = new URLSearchParams(location.search);
await loadFonts();
window.DUR = DUR;
window.EV = events();
window.render = t => {
  if (Q.has('frame')) { frame(Q.get('frame'), t); paperFinish(); return; }
  renderFilm(t); paperFinish();
};
window.TEXTS = t => texts(t);
window.READY = true;
