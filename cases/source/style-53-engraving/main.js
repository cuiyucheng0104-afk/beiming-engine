// page contract: window.READY, window.render(t), window.DUR, window.EV, window.TEXTS
import { makeFilm } from './film.js';
const ctx = document.getElementById('c').getContext('2d');
await Promise.all(['600 40px "Noto Serif SC"', '500 40px "Bodoni Moda"', '600 40px "Bodoni Moda"', 'italic 400 40px "Bodoni Moda"'].map(f => document.fonts.load(f, '气室体管鹦鹉螺Pl. IIIcameraesiphunculusNautilus')));
// the plate is engraved at 2× and reduced onto the 1920×1080 canvas: fine hatching stays line, never grey or moiré
const SS = 2, big = document.createElement('canvas'); big.width = 1920 * SS; big.height = 1080 * SS;
const bctx = big.getContext('2d');
const film = makeFilm({ ss: SS });
window.DUR = film.DUR; window.EV = film.EV; window.TEXTS = film.TEXTS; window.CAM = film.camAt;
window.render = t => { film.render(bctx, t); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(big, 0, 0, 1920, 1080); };
window.READY = true;
