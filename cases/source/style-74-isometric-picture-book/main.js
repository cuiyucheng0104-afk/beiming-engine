const cv = document.getElementById('c'), g = cv.getContext('2d');
const CJK = '清晨和面烘烤上架营业中';
await Promise.all([document.fonts.load('700 40px NotoSerifSC', CJK), document.fonts.load('500 40px NotoSerifSC', CJK),
  document.fonts.load('600 40px Newsreader', '0123456789:'), document.fonts.load('500 40px Newsreader', '0123456789:')]);
const film = await import('./film.js');
window.DUR = film.DUR; window.EV = film.events(); window.TEXTS = film.texts; window.PROBE = film.probe;
window.SHOTS = [[0], ...film.CUTS.map(c => [c])];   // one cut on the beat (same angle)
window.render = t => { g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; film.render(g, t); };
window.READY = true;
