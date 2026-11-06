// timeline.js → out/timeline.json (read by the score, the mixer and cuecheck)
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = await import(path.join(HERE, 'timeline.js'));
fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'out', 'timeline.json'), JSON.stringify({ fps: T.FPS, dur: T.DUR, secs: T.SECS, beat: T.BEAT, hit: T.H, beats: T.beats() }, null, 1));
console.log('timeline.json:', Object.keys(T.H).length, 'hits,', T.beats().length, 'beats, dur', T.DUR);
