const mod = await import('./film.js');
const draw = await mod.setup(document.getElementById('c'));
window.render = t => draw(t);
render(0); window.READY = true;
