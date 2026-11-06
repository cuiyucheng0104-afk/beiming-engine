// timeline.js → out/timeline.json（配乐、混音、核对脚本读同一份数字）
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = await import(path.join(HERE, 'timeline.js'));
fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'out/timeline.json'), JSON.stringify({ FPS: T.FPS, DUR: T.DUR, SECS: T.SECS, HIT: T.HIT, HT: T.HT, SIGN: T.SIGN }, null, 1));
console.log('timeline →', path.join(HERE, 'out/timeline.json'), Object.keys(T.HT).length, 'hits');
