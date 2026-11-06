// Cue check: every visual event of the picture (read from scenes/film.json, not from the plan) against
//  (1) the music grid (96 BPM sixteenths from OFF), (2) its foley event in events.json, (3) a score onset (audio/score.json).
//   node tools/cuecheck.mjs        exit 1 if any visual hit is off the grid or has no sound at the same instant (> 1 ms)
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const F = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = await import(path.join(F, 'timeline.js'));
const sc = JSON.parse(fs.readFileSync(path.join(F, 'scenes/film.json'))), ev = JSON.parse(fs.readFileSync(path.join(F, 'events.json'))).ev;
const score = JSON.parse(fs.readFileSync(path.join(F, 'audio/score.json'))).map(r => r[0]);
const vis = [];
for (const e of sc.elements) {
  const A = e.arrive;
  if (e.type === 'print' && A) vis.push(['photo lands  ' + e.id, A.t + (A.land ?? .55) * (A.d ?? .6)]);
  if (e.type === 'magnet' && A) vis.push(['magnet clacks ' + (e.id || ''), A.t + Math.PI / 44]);
  if (e.type === 'ink' && e.t != null && e.t > 0) {
    if (e.kind === 'write') vis.push(['marker writes ' + e.text, e.t]);
    if (e.kind === 'dim') { vis.push(['dimension starts', e.t]); vis.push(['dimension arrowhead', e.t + e.d]); }
    if (e.kind === 'line' && e.arrow) vis.push(['force arrow lands', e.t + e.d]);
    if (e.kind === 'line' && !e.arrow && e.d <= .15) vis.push(['extension line tap', e.t + e.d]);
  }
}
vis.push(['eraser starts', T.H.erase]);
const g = T.BEAT / 4; let bad = 0, onScore = 0; const rows = [];
for (const [what, t] of vis.sort((a, b) => a[1] - b[1])) {
  const k = Math.round((t - T.OFF) / g), off = (t - (T.OFF + k * g)) * 1000;
  const snd = ev.some(e => Math.abs(e.t - t) <= .001), mus = score.some(s => Math.abs(s - t) <= .001); onScore += mus;
  const ok = Math.abs(off) <= 1 && snd; bad += !ok;
  rows.push(`${ok ? 'OK ' : 'BAD'} ${t.toFixed(4).padStart(8)} s  beat ${(k / 4).toFixed(2).padStart(6)}  ${off >= 0 ? '+' : ''}${off.toFixed(2)} ms  foley ${snd ? 'yes' : 'NO '}  score ${mus ? 'yes' : ' - '}  ${what}`);
}
console.log(rows.join('\n'));
const offs = vis.map(([, t]) => Math.abs(((t - T.OFF) / g - Math.round((t - T.OFF) / g)) * g * 1000));
console.log(`cuecheck: ${vis.length - bad}/${vis.length} visual hits on the 1/16 grid with foley at the same instant; max offset ${Math.max(...offs).toFixed(2)} ms; ${onScore} also carry a score onset`);
process.exit(bad ? 1 : 0);
