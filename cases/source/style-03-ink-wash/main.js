import { makeComp, layerSet } from './engine/comp.js';
import { DUR } from './timeline.js';
import * as FILM from './film.js';
const q = new URLSearchParams(location.search);
const comp = makeComp(document.getElementById('c'));
const A = layerSet(), B = layerSet(), TMP = layerSet();
await document.fonts.load('80px MaShanZheng', '鹤出留白墨戏');
FILM.init();
window.DUR = DUR;
window.EV = FILM.events();
window.TEXTS = t => FILM.textsAt(t);
window.render = t => {
  A.clear(); B.clear();
  const o = FILM.frame(t, A, B, TMP) || {};
  comp(A, B, o);
};
window.READY = true;
