// 把 timeline.js 导出为 timeline.json，给 mix.py / cuecheck.py 用
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tl = await import(path.join(here, 'timeline.js'));
fs.writeFileSync(path.join(here, 'timeline.json'), JSON.stringify({ fps: tl.FPS, dur: tl.DUR, secs: tl.SECS, hit: tl.HIT, t: tl.T }, null, 1));
for (const [k, v] of Object.entries(tl.T)) { const f = v * tl.FPS; if (Math.abs(f - Math.round(f)) > 1e-6) console.log('NOT ON FRAME', k, v, f); }
console.log('timeline.json written,', Object.keys(tl.T).length, 'hits');
