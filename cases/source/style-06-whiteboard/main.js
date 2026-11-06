const mod = await import('./film.js');
const F = await mod.build();
const ctx = document.getElementById('c').getContext('2d');
window.DUR = F.dur; window.EV = F.ev; window.TEXTS = F.TEXTS; window.LAND = F.LAND;
window.render = t => F.render(ctx, t);
window.READY = true;
