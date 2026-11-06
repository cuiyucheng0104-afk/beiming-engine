import { makeComp } from './engine/comp.js';
import { renderScene, PMW, PMH } from './engine/scene.js';
import * as STORY from './story.js';

const cv = document.getElementById('gl');
const comp = makeComp(cv);
const mk = (w = 1920, h = 1080) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const L = { G: mk(), S: mk(), R: mk(), O: mk(), M: mk(), P: mk(PMW, PMH) };
const Lc = {}; for (const k in L) Lc[k] = L[k].getContext('2d');
await document.fonts.load('900 80px "Noto Serif SC"', '浴火重生');

window.DUR = STORY.DUR; window.EV = STORY.EV; window.VCUES = STORY.VCUES;
window.TEXTS = t => STORY.texts(t);
window.CUESTATE = t => STORY.cueState(t);
window.render = t => renderScene(Lc, L, comp, STORY.state(t));
window.READY = true;
