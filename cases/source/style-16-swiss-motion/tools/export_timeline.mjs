// timeline.js → timeline.json（给 mix.py / cuecheck.py 读同一组数字）
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const m = await import(path.join(here, 'timeline.js'));
const out = { BPM: m.BPM, BEAT: m.BEAT, E8: m.E8, E16: m.E16, BAR: m.BAR, FPS: m.FPS, DUR: m.DUR, T: m.T, HARM: m.HARM, SECS: m.SECS };
fs.writeFileSync(path.join(here, 'timeline.json'), JSON.stringify(out, null, 1));
console.log('timeline.json written');
