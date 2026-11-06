// timeline.js → timeline.json (read by mix.py and cuecheck.py)
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import * as T from '../timeline.js';
const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = { BPM: T.BPM, BEAT: T.BEAT, FPS: T.FPS, DUR: T.DUR, NIGHT: T.NIGHT, WIN: T.WIN, CARDS: T.CARDS, EV: T.events() };
fs.writeFileSync(path.join(HERE, 'timeline.json'), JSON.stringify(out, null, 1));
console.log('timeline.json', T.CARDS.length, 'cards', out.EV.length, 'events', 'dur', T.DUR);
