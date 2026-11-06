// timeline.js -> timeline.json (for mix.py and cuecheck.py)
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const m = await import(pathToFileURL(path.join(here, 'timeline.js')).href);
writeFileSync(path.join(here, 'timeline.json'), JSON.stringify({ bpm: m.BPM, beat: m.BEAT, fps: m.FPS, dur: m.DUR, HIT: m.HIT, T: m.T, CAM: m.CAM }, null, 1));
console.log('timeline.json', m.BPM, 'BPM', m.DUR.toFixed(4), 's');
