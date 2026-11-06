// Cue check: the picture's onsets against the music's.
//   node tools/cuecheck.mjs <film>      (run from $LIB; needs out/score.json from mix.py)
// For every cue the page registers (window.PROBE), find the first rendered frame where its light is on, and compare
// that frame's time with the measured onset of the sound placed for it (score.json: onset = first sample above
// 10 % of that sound's peak). Also reports where each cue sits on the 120 BPM grid (beat, or frame grid only).
import fs from 'fs'; import path from 'path';
import { openDemo, closeServer } from '@@LEMO_ROOT@@/core/render/page.mjs';
const dir = process.argv[2], fps = 30, beat = 0.5;
const score = JSON.parse(fs.readFileSync(path.join(dir, 'out/score.json'), 'utf8'));
const { browser, page } = await openDemo(dir);
const first = await page.evaluate(fps => {
  const n = Math.round(window.DUR * fps), on = {};
  for (let f = 0; f < n; f++) { const p = window.PROBE(f / fps); for (const [k, v] of Object.entries(p)) if (v && !(k in on)) on[k] = f; }
  return on;
}, fps);
await browser.close(); closeServer();
let worst = 0, n = 0, missing = [];
const rows = [];
for (const [name, f] of Object.entries(first).sort((a, b) => a[1] - b[1])) {
  const s = score[name]; if (!s) { missing.push(name); continue; }
  const tv = f / fps, dev = (s.onset - tv) * 1000, b = tv / beat, onBeat = Math.abs(b - Math.round(b)) < 1e-6;
  worst = Math.max(worst, Math.abs(dev)); n++;
  rows.push(`${name.padEnd(8)} frame ${String(f).padStart(3)}  picture ${tv.toFixed(3)} s  sound ${s.onset.toFixed(4)} s  dev ${dev >= 0 ? '+' : ''}${dev.toFixed(1)} ms  ${onBeat ? 'beat ' + Math.round(b) : 'frame grid (' + ((tv % beat) * 1000).toFixed(0) + ' ms after beat ' + Math.floor(b) + ')'}`);
}
console.log(rows.join('\n'));
console.log(`\n${n} cues checked, worst picture-sound deviation ${worst.toFixed(1)} ms` + (missing.length ? `; no sound registered for: ${missing.join(', ')}` : ''));
process.exit(worst <= 1.0 && !missing.length ? 0 : 1);
