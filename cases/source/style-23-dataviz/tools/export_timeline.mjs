// timeline.js → timeline.json (for mix.py and cuecheck.py)
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TL = await import(path.join(HERE, 'timeline.js'));
const out = { BPM: TL.BPM, B: TL.B, FPS: TL.FPS, BEATS: TL.BEATS, DUR: TL.DUR, RATE: TL.RATE, K: TL.K, STEP_B: TL.STEP_B,
  TEETH: TL.TEETH, TOOTH: TL.TOOTH, MORPH: TL.MORPH, MARKS: TL.MARKS, LEVELS: TL.LEVELS, EV: TL.buildEvents() };
fs.writeFileSync(path.join(HERE, 'timeline.json'), JSON.stringify(out, null, 1));
console.log('timeline.json:', out.EV.length, 'events,', out.MARKS.length, 'marks, dur', out.DUR.toFixed(3));
