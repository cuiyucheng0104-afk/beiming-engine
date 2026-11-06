// 把 timeline.js（唯一时间源）导出为 timeline.json，供 mix.py 与检查脚本读取
import { BPM, BEAT, DUR, FPS, CUE, SECS, SCRAPS, VISCUES, events } from '../timeline.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const out = fileURLToPath(new URL('../timeline.json', import.meta.url));
writeFileSync(out, JSON.stringify({ BPM, BEAT, DUR, FPS, CUE, SECS, SCRAPS, VISCUES, EV: events() }, null, 1));
console.log('timeline.json', events().length, 'events');
