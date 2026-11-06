// timeline.js → out/timeline.json (for mix.py and the cue check)
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import * as TL from '../timeline.js';
const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'out', 'timeline.json'), JSON.stringify({ BPM: TL.BPM, SPB: TL.SPB, FPS: TL.FPS, DUR: TL.DUR, BEATS: TL.BEATS, C: TL.C }, null, 1));
console.log('timeline', TL.BPM, 'BPM', TL.DUR.toFixed(3), 's');
