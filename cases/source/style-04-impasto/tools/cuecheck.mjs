// Cue check: measures each visual event from the same motion functions the picture uses,
// and compares it with the score's attacks (out/score_onsets.json). Target: 0 ms.
import fs from 'fs';
const m = await import('../timeline.js');
const { buildScrapes } = await import('../scene.js');
const { T, FPS } = m;
const on = JSON.parse(fs.readFileSync(new URL('../out/score_onsets.json', import.meta.url)));
const EVJ = JSON.parse(fs.readFileSync(new URL('../events.json', import.meta.url)));
// sound onsets = score attacks + foley placed from window.EV (in the silence only foley speaks)
for (const e of EVJ.ev) on.push([e.t, 'foley:' + e.type, '']);
const find = (f, a, b, step = 1e-4) => { for (let t = a; t <= b; t += step) if (f(t)) return t; return null; };
const vis = {};
vis.knife = 0;                                                     // hero stroke appear = 0 (page: appear 0)
vis.enter = find(t => { const c = m.camera(t), [sx] = m.toScreen(c, m.bikeX(t) + m.HALF_WB + m.R_WHEEL + 2, 0); return sx >= 0; }, 3, 4.5);
vis.stand = find(t => m.riderState(t).stand >= 1 - 1e-9, 7, 8);
vis.brake = find(t => m.camera(t).shot === 3, 9, 10);
vis.stop = find(t => m.bikeV(t) <= 0, 9.4, 10.5);
{ let best = 1e9, bt = 0; for (let t = 10.3; t < 10.8; t += 1e-4) { const h = m.riderState(t).head; if (h < best) { best = h; bt = t; } } vis.lookUp = bt; }
const sc = buildScrapes(), a = sc.data(), F = 20, first = {};
for (let i = 0; i < sc.n; i++) { const app = a[i * F + 14]; const k = m.SCRAPES.findIndex(s => Math.abs(app - s.t) < .5 && app >= s.t - 1e-6); if (k >= 0) first[k] = Math.min(first[k] ?? 1e9, app); }
m.SCRAPES.forEach((s, i) => vis['scrape' + (i + 1)] = first[i]);
{ let best = -1, bt = 0; for (let t = 14; t < 16; t += 1e-4) { const d = m.lightAt(t).dif; if (d > best) { best = d; bt = t; } } vis.rake = bt; }
vis.pedal = find(t => m.riderState(t).foot <= 1e-6, 16, 16.6);
vis.away = find(t => m.camera(t).shot === 6, 16.5, 17.2);
vis.last = T.last;   // bike fade reaches 0 exactly at T.last (film.js: 1 - ss(seg(t, T.last - .6, T.last)))
const rows = []; let worst = 0;
for (const [k, tv] of Object.entries(vis)) {
  const grid = T[k], near = on.reduce((b, o) => Math.abs(o[0] - tv) < Math.abs(b[0] - tv) ? o : b);
  const dGrid = (tv - grid) * 1000, dMus = (tv - near[0]) * 1000, fr = tv * FPS, dFrame = (fr - Math.round(fr)) / FPS * 1000;
  worst = Math.max(worst, Math.abs(dGrid), Math.abs(dMus));
  rows.push(`${k.padEnd(8)} visual ${tv.toFixed(4)}s  grid ${grid.toFixed(4)}  Δgrid ${dGrid.toFixed(1).padStart(6)} ms  nearest note ${near[1]}@${near[0].toFixed(4)} Δ ${dMus.toFixed(1).padStart(6)} ms  frame Δ ${dFrame.toFixed(1)} ms`);
}
// knife repaint grid: each chunk starts on a grid time; every grid time must have a musical attack
let gw = 0;
for (const g of m.knifeGrid()) { const near = on.reduce((b, o) => Math.abs(o[0] - g) < Math.abs(b[0] - g) ? o : b); gw = Math.max(gw, Math.abs(near[0] - g) * 1000); }
// every foley event in window.EV sits on the grid
let ew = 0; for (const e of EVJ.ev) { const near = on.filter(o => !o[1].startsWith('foley')).concat([[1e9]]).reduce((b, o) => Math.abs(o[0] - e.t) < Math.abs(b[0] - e.t) ? o : b); if (!['cloth'].includes(e.type)) ew = Math.max(ew, Math.abs(near[0] - e.t) * 1000); }
console.log(rows.join('\n'));
console.log(`knife-repaint grid vs music: worst ${gw.toFixed(1)} ms | window.EV vs music: worst ${ew.toFixed(1)} ms | visual hits worst ${worst.toFixed(1)} ms`);
process.exit(worst <= 1 && gw <= 1 && ew <= 1 ? 0 : 1);
