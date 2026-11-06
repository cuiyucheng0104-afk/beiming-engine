// timeline.js → timeline.json（配乐、混音、核对脚本共用）
import fs from 'fs'; import path from 'path'; import url from 'url';
const here = path.dirname(url.fileURLToPath(import.meta.url));
const T = await import(path.join(here, '../timeline.js'));
const out = { BPM: T.BPM, FPS: T.FPS, B: T.B, BAR: T.BAR, DUR: T.DUR, DUR_BEATS: T.DUR_BEATS, SEC: T.SEC, FLOORS: T.FLOORS, HIT: T.HIT, SPARKS: T.SPARKS };
fs.writeFileSync(path.join(here, '../timeline.json'), JSON.stringify(out, null, 1));
console.log('timeline.json', T.DUR.toFixed(4), 's');
