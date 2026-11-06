// 页面入口：字体 → 模型 → 片子；导出 DUR / EV / TEXTS / render / READY
import { buildTree, buildSeed } from './model.js';
import { makeFilm } from './film.js';
import { DUR, timelineJSON } from './timeline.js';
const cv = document.getElementById('c'), g = cv.getContext('2d');
await Promise.all([
  ...['300', '400', '500', '600'].map(w => document.fonts.load(`${w} 40px Rajdhani`)),
  document.fonts.load('20px ShareTechMono'),
  document.fonts.load('400 30px NotoSC', '种子扫描'), document.fonts.load('500 30px NotoSC', '种子扫描'),
]);
const tree = buildTree(), seed = buildSeed();
const film = makeFilm(tree, seed);
window.DUR = DUR;
window.EV = film.events();
window.TIMELINE = timelineJSON();
window.render = t => film.render(g, t);
const tc = document.createElement('canvas'); tc.width = 1920; tc.height = 1080; const tg = tc.getContext('2d');
window.TEXTS = t => film.texts(tg, t);
window.STATS = { edges: tree.parts.reduce((s, P) => s + P.pieces.reduce((a, c) => a + c.e.length / 2, 0), 0), verts: tree.parts.reduce((s, P) => s + P.pieces.reduce((a, c) => a + c.n, 0), 0) };
window.READY = true;
