// 《追帽子》页面入口：window.render(t) 画第 t 秒；?scene=frames.xxx 渲染风格帧/测试场景。
const Q = new URLSearchParams(location.search);
const cv = document.getElementById('c'), g = cv.getContext('2d');
await document.fonts.load('900 80px "Noto Serif SC"', '那顶帽子……原来是猴子的');
const film = await import('./film.js');
const mods = {};
window.EV = film.events();
window.DUR = film.DUR;
window.TEXTS = t => film.texts(t);
window.render = async t => {
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (Q.has('scene')) {
    const [file, fn] = Q.get('scene').split('.');
    const m = mods[file] || (mods[file] = await import('./' + file + '.js'));
    g.fillStyle = '#000'; g.fillRect(0, 0, 1920, 1080);
    await m[fn](g, t, Object.fromEntries(Q)); return;
  }
  film.renderFilm(g, t);
};
window.READY = true;
