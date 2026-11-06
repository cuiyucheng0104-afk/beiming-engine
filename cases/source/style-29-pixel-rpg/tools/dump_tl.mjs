// 把 timeline.js 导出成 timeline.json（配乐、混音、拍点核对读它）
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const T = await import(join(here, 'timeline.js'));
writeFileSync(join(here, 'timeline.json'), JSON.stringify({ FPS: T.FPS, A: T.A, B: T.B, NFRAMES: T.NFRAMES, DUR: T.DUR, CUE: T.CUE, SILENCE: T.SILENCE }, null, 1));
console.log('timeline.json', Object.keys(T.CUE).length, 'cues');
