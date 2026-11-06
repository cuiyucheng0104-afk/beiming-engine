// Picture vs music: every named hit in the timeline is checked against (1) the picture's event list, (2) the frame grid,
// (3) the nearest note onset in the score, (4) the pen strokes that start on it. Target: 0 ms everywhere.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TL = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'timeline.json')));
const EV = JSON.parse(fs.readFileSync(path.join(HERE, 'events.json'))).ev;
const ONS = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'music_onsets.json')));
const ms = x => (x * 1000).toFixed(1).padStart(7);
// hits that must have a note starting on them (the silence and pure camera beats excepted)
const MUSICAL = ['open', 'eave', 'tiles', 'wire', 'pole', 'clothes', 'full', 'bikeIn', 'bell1', 'bikeOut', 'sky', 'wall', 'roof', 'land', 'lid', 'lantern2', 'sign', 'push', 'margin', 'title', 'end'];
const PEN = ['eave', 'tiles', 'wire', 'pole', 'clothes', 'full'];
let worst = 0, rows = [];
for (const [name, t] of Object.entries(TL.hit)) {
  const evs = EV.filter(e => e.hit === name);
  const dEv = evs.length ? Math.max(...evs.map(e => Math.abs(e.t - t))) : NaN;
  const frame = t * TL.fps, dFr = Math.abs(frame - Math.round(frame)) / TL.fps;
  let dMus = NaN; if (MUSICAL.includes(name)) dMus = Math.min(...ONS.map(o => Math.abs(o[0] - t)));
  let dPen = NaN; if (PEN.includes(name)) dPen = Math.min(...EV.filter(e => e.type === 'pen').map(e => Math.abs(e.t - t)));
  for (const d of [dEv, dFr, dMus, dPen]) if (!isNaN(d)) worst = Math.max(worst, d);
  rows.push(`${name.padEnd(9)} t=${t.toFixed(3).padStart(7)} frame ${Math.round(frame).toString().padStart(3)}  picture ${isNaN(dEv) ? '      –' : ms(dEv)} ms  grid ${ms(dFr)} ms  music ${isNaN(dMus) ? '      –' : ms(dMus)} ms  pen ${isNaN(dPen) ? '      –' : ms(dPen)} ms`);
}
// footsteps land on beats
const steps = EV.filter(e => e.type === 'step'), beatT = TL.beats.map(b => b.t);
const dStep = Math.max(...steps.map(s => Math.min(...beatT.map(b => Math.abs(b - s.t)))));
worst = Math.max(worst, dStep);
console.log(rows.join('\n'));
console.log(`steps: ${steps.length} on the beat grid, worst ${ms(dStep)} ms`);
console.log(`WORST OFFSET: ${ms(worst)} ms`);
process.exit(worst > .0006 ? 1 : 0);
