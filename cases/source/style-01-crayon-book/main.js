// Entry: deterministic render(t) for the capture tools
import { makeComp } from './gl.js';
import { BOIL } from './crayon.js';
const comp = makeComp(document.getElementById('gl'));
await document.fonts.load('400 80px "ZCOOL KuaiLe"', '完');
const M = await import('./film.js');
window.DUR = M.DUR; window.EV = M.EV; window.TEXTS = M.TEXTS;
window.render = t => { BOIL.step = Math.floor(t * 12 + 1e-6); M.frame(comp, t); };
window.READY = true;
