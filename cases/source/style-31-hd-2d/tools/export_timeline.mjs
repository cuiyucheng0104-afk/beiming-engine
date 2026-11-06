// timeline.js → timeline.json（mix.py 与 cuecheck.py 读它）
import fs from 'fs'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TL = await import(pathToFileURL(path.join(here, 'timeline.js')).href);
const out = { bpm: TL.BPM, fps: TL.FPS, spb: TL.SPB, dur: TL.DUR, durBeats: TL.DUR_BEATS, shots: TL.SHOTS, cues: TL.CUES, pops: TL.POP_BEATS, events: TL.events() };
fs.writeFileSync(path.join(here, 'timeline.json'), JSON.stringify(out, null, 1));
console.log('timeline.json', out.events.length, 'events, dur', out.dur);
