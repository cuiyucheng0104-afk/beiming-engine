// export timeline.js → timeline.json for the Python side (score, mix, cuecheck)
import fs from 'fs'; import path from 'path'; import url from 'url';
const here = path.dirname(url.fileURLToPath(import.meta.url));
const T = await import(path.join(here, '..', 'timeline.js'));
const beats = T.BEAT_F.map(f => f / T.FPS);
fs.writeFileSync(path.join(here, '..', 'timeline.json'), JSON.stringify({ fps: T.FPS, dur: T.DUR, end_f: T.END_F, beat_f: T.BEAT_F, beats, sec: T.SEC, hit: T.HIT }, null, 1));
console.log('timeline.json', beats.length - 1, 'beats, dur', T.DUR);
