// timeline.js -> timeline.json (for mix.py and cuecheck.py). usage: node tools/export.mjs <film_dir>
import fs from 'fs'; import path from 'path';
const D = process.argv[2];
const src = fs.readFileSync(path.join(D, 'timeline.js'), 'utf8');
const m = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
fs.writeFileSync(path.join(D, 'timeline.json'), JSON.stringify({ bpm: m.BPM, beat: m.BEAT, T: m.T, LEVEL: m.LEVEL, TICKS: m.TICKS }, null, 1));
console.log('timeline.json written');
