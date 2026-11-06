// 把 timeline.js 导出成 timeline.json，给 mix.py 与 cuecheck 用
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TL = await import(path.join(HERE, 'src/timeline.js'));
const out = { BPM: TL.BPM, BEAT: TL.BEAT, DUR: TL.DUR, T: TL.T, UP: TL.UP, LAND: TL.LAND, UPDUR: TL.UPDUR, DOWNDUR: TL.DOWNDUR, GAP: TL.GAP };
fs.writeFileSync(path.join(HERE, 'timeline.json'), JSON.stringify(out, null, 1));
console.log('timeline.json written');
