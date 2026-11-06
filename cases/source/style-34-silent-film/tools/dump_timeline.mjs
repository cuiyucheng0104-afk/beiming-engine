// timeline.js → timeline.json（配乐、混音、拍点核对读同一份数字）
import fs from 'fs'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const T = await import(pathToFileURL(path.join(root, 'timeline.js')).href);
fs.writeFileSync(path.join(root, 'timeline.json'), JSON.stringify({ fps: T.FPS, dur: T.DUR, sec: T.SEC, hits: T.HITS, hit: T.HIT, cuts: T.CUTS }, null, 1));
console.log('timeline.json: dur', T.DUR, 'hits', Object.keys(T.HIT).length);
