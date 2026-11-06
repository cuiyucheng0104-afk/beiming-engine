// timeline.js → timeline.json（给 score.py / mix.py / cuecheck.py 读同一组数字）
import fs from 'fs'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = await import(pathToFileURL(path.join(HERE, 'timeline.js')).href);
const out = { FPS: T.FPS, BEAT_FRAMES: T.BEAT_FRAMES, BEAT: T.BEAT, BPM: T.BPM, DUR: T.DUR, CUE: T.CUE, TYPING: T.TYPING, OUT_DT: T.OUT_DT, LOG_DT: T.LOG_DT, SECTIONS: T.SECTIONS };
fs.writeFileSync(path.join(HERE, 'timeline.json'), JSON.stringify(out, null, 1));
console.log('timeline.json', T.BPM.toFixed(3), 'BPM, DUR', T.DUR);
