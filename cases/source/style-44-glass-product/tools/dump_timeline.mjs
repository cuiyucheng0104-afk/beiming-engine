// timeline.js → timeline.json（配乐、混音、核对脚本读同一份数字）
import fs from 'fs'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const m = await import(pathToFileURL(path.join(HERE, 'timeline.js')).href);
fs.writeFileSync(path.join(HERE, 'timeline.json'), JSON.stringify({ BPM: m.BPM, BEAT: m.BEAT, BAR: m.BAR, FPS: m.FPS, DUR: m.DUR, T: m.T, SHOTS: m.SHOTS, EV: m.EV, PART_DELAY: m.PART_DELAY }, null, 1));
console.log('timeline.json written');
