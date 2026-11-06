// timeline.js → timeline.json (for mix.py and cuecheck.py)
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = await import(path.join(HERE, 'timeline.js'));
fs.writeFileSync(path.join(HERE, 'timeline.json'), JSON.stringify({ fps: M.FPS, dur: M.DUR, secs: M.SECS, cues: M.CUES, t: M.T }, null, 1));
console.log('timeline.json', Object.keys(M.CUES).length, 'cues');
