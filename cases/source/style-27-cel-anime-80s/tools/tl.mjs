// 把 timeline.js 导出成 timeline.json（配乐、混音、拍点核对共用）
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import * as T from '../timeline.js';
const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = { FPS: T.FPS, FPB: T.FPB, BPM: T.BPM, F18: T.F18, F19: T.F19, F20: T.F20, FC: T.FC, END_F: T.END_F, DUR: T.DUR,
  SHOTS: T.SHOTS, CUES: T.CUES, BEATS: T.musicBeats() };
fs.writeFileSync(path.join(here, 'timeline.json'), JSON.stringify(out, null, 1));
console.log('timeline.json', 'DUR', T.DUR.toFixed(3), 'BPM', T.BPM.toFixed(3), 'FC', T.FC);
