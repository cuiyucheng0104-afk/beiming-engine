// timeline.js -> timeline.json (read by the score, the mixer and the beat check)
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TL = await import(path.join(here, 'timeline.js'));
const out = { BPM: TL.BPM, BEAT: TL.BEAT, FPS: TL.FPS, BEATS: TL.BEATS, DUR: TL.DUR, SECS: TL.SECS, CUE: TL.CUE, T: TL.T };
fs.writeFileSync(path.join(here, 'timeline.json'), JSON.stringify(out, null, 1));
console.log('timeline.json', 'BPM', TL.BPM, 'DUR', TL.DUR.toFixed(4));
