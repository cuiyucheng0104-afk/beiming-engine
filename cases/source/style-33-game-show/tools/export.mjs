// timeline.mjs → timeline.json（配乐、拟音、拍点核对共用的数字）
import fs from 'fs'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T = await import(pathToFileURL(path.join(here, 'timeline.mjs')).href);
const out = { BPM: T.BPM, BEAT: T.BEAT, BAR: T.BAR, FPS: T.FPS, DUR: T.DUR, SCENES: T.SCENES, CUTS: T.CUTS, QA: T.QA, K: T.K, SILENCE: T.SILENCE, ARR: T.ARR, EV: T.events() };
fs.writeFileSync(path.join(here, 'timeline.json'), JSON.stringify(out, null, 1));
console.log('timeline.json', out.EV.length, 'events, dur', out.DUR);
