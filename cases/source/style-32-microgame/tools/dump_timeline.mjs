// 把 timeline.js 导出成 JSON，给 mix.py / cuecheck.py 读
import fs from 'fs'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const T = await import(pathToFileURL(path.join(root, 'timeline.js')).href);
const hits = Object.fromEntries(Object.keys(T.HIT).map(k => [k, { f: T.hf(k), t: T.ht(k) }]));
fs.mkdirSync(path.join(root, 'out'), { recursive: true });
fs.writeFileSync(path.join(root, 'out', 'timeline.json'), JSON.stringify({ fps: T.FPS, nf: T.NF, dur: T.DUR, segs: T.SEGS, beats: T.BEATS, hits, push: T.PUSH, shrink: T.SHRINK }, null, 1));
console.log('timeline →', path.join(root, 'out', 'timeline.json'), 'dur', T.DUR, 'frames', T.NF);
