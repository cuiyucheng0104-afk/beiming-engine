// timeline.js → timeline.json（给 Python 用）。用法：node tools/export_timeline.mjs
import fs from 'fs'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tl = await import(pathToFileURL(path.join(HERE, 'timeline.js')).href);
const cells = tl.GRID_STAGES.map((st, s) => [...Array(st.cols * st.rows)].map((_, i) => ({ i, delay: tl.cellDelay(s, i), src: tl.cellSrc(s, i) })));
const out = { FPS: tl.FPS, NF: tl.NF, DUR: tl.DUR, BARS: tl.BARS, BEATS: tl.BEATS, T: tl.T, SHOTS: tl.SHOTS, GRID_POOL: tl.GRID_POOL, POOL_N: tl.POOL_N,
  GRID_STAGES: tl.GRID_STAGES, GRID_RECUT: tl.GRID_RECUT, cells, FLASH: tl.FLASH, LIGHTS_OFF: tl.LIGHTS_OFF, TEXT: tl.TEXT };
fs.writeFileSync(path.join(HERE, 'timeline.json'), JSON.stringify(out, null, 1));
console.log('timeline.json', tl.NF, 'frames', tl.DUR.toFixed(3), 's');
