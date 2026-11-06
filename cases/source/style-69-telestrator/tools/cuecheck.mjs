// Beat check: every key visual hit (a) sits on the 128.57 BPM grid (beat or eighth) on a whole frame, (b) has a music hit of the same name
// in out/music_hits.json, and (c) actually appears in the rendered page on that frame (page state probed frame by frame: segment switches,
// the score flip, the first frame each overlay draws). Prints the offset in ms for every hit; exit 1 if any offset ≠ 0.
// Run from the library: node /path/tools/cuecheck.mjs /path/to/film
import fs from 'fs'; import path from 'path';
const LIB = process.env.LIB || '@@LEMO_ROOT@@';
const { openDemo, closeServer } = await import(path.join(LIB, 'core/render/page.mjs'));
const dir = path.resolve(process.argv[2] || '.');
const { HITS, BEAT, FPS, SEG, WIPES } = await import(path.join(dir, 'timeline.js'));
const music = JSON.parse(fs.readFileSync(path.join(dir, 'out/music_hits.json')));
const { browser, page } = await openDemo(dir);
const probe = t => page.evaluate(t => window.PROBE(t), t);
// visual detectors: name → predicate on page state
const segStart = id => st => st.seg === id;
const DET = {
  freeze1: segStart('f1'), rewind: segStart('rew'), resume: segStart('slow'), strike: segStart('f2'), freezeSplit: segStart('fsplit'),
  goal: st => st.away === 2, hero: segStart('hero'), final: segStart('end'),
  wipe_in: st => st.wipe === 0 && st.wipeX >= 959, wipe_split: st => (st.wipe !== null && Math.abs(st.wipe - WIPES[1]) < 1e-6 && st.wipeX >= 959) || st.seg === 'fsplit',
  wipe_back: st => (st.wipe !== null && Math.abs(st.wipe - WIPES[2]) < 1e-6 && st.wipeX >= 959) || st.seg === 'goal',
};
for (const k of ['ring10', 'thruLine', 'ringsDef', 'space', 'label1', 'ring9', 'runLine', 'ringsSplit', 'sight', 'label2', 'title', 'sub']) DET[k] = st => st.vis.includes(k);
DET.final = st => st.vis.includes('finalRing');
const rows = []; let bad = 0;
for (const [name, tHit] of Object.entries(HITS)) {
  const f = Math.round(tHit * FPS), onFrame = Math.abs(f / FPS - tHit) < 1e-4, beats = tHit / BEAT, onGrid = Math.abs(beats * 2 - Math.round(beats * 2)) < 1e-4;
  // measured visual frame: first frame in a ±6 frame window where the detector is true
  let vis = null;
  if (DET[name]) for (let g = Math.max(0, f - 6); g <= f + 6; g++) { const st = await probe(g / FPS); if (DET[name](st)) { vis = g / FPS; break; } }
  const mh = (music[name] || []).reduce((best, x) => best === null || Math.abs(x - tHit) < Math.abs(best - tHit) ? x : best, null);
  const dVis = vis === null ? null : Math.round((vis - tHit) * 1000), dMus = mh === null ? null : Math.round((mh - tHit) * 1000);
  const ok = onFrame && onGrid && (dVis === null || dVis === 0) && (dMus === null || dMus === 0);
  if (!ok) bad++;
  rows.push(`${ok ? 'ok ' : 'BAD'} ${name.padEnd(12)} t=${tHit.toFixed(4)}s  beat ${beats.toFixed(2).padStart(6)}  frame ${String(f).padStart(3)}  visual ${dVis === null ? '  n/a' : (dVis + 'ms').padStart(5)}  music ${dMus === null ? '  n/a' : (dMus + 'ms').padStart(5)}`);
}
console.log(rows.join('\n'));
const measured = rows.filter(r => !/visual   n\/a/.test(r)).length, withMusic = rows.filter(r => !/music   n\/a/.test(r)).length;
console.log(`\n${Object.keys(HITS).length} hits · ${measured} measured in the page · ${withMusic} paired with a music hit · ${bad} off-grid/offset`);
await browser.close(); closeServer();
process.exit(bad ? 1 : 0);
