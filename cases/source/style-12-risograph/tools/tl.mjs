// timeline.js → timeline.json (for mix.py and the cue check)
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = await import(path.join(here, 'timeline.js'));
const o = {}; for (const [k, v] of Object.entries(T)) if (typeof v !== 'function') o[k] = v;
fs.writeFileSync(path.join(here, 'timeline.json'), JSON.stringify(o, null, 1));
console.log('timeline.json', Object.keys(o).join(' '));
