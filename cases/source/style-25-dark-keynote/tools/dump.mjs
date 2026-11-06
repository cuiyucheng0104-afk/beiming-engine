// timeline.js → timeline.json（配乐 / 混音 / 核对共用）
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import * as T from '../timeline.js';
const D = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = { bpm: T.BPM, beat: T.BEAT, bar: T.BAR, s16: T.S16, dur: T.DUR, KB: T.KB, K: T.K, notes: T.dotNotes(), gridTicks: T.gridTicks() };
fs.writeFileSync(path.join(D, 'timeline.json'), JSON.stringify(out, null, 1));
console.log('timeline.json', out.notes.length, 'notes, dur', out.dur);
