// timeline.js -> out/timeline.json (for mix.py and cuecheck.py)
import { BPM, BEAT, DUR, BEATS, HIT, TICKS, HUSH, SOUNDER } from '../timeline.js';
import { writeFileSync, mkdirSync } from 'fs';
const here = new URL('..', import.meta.url).pathname;
mkdirSync(here + 'out', { recursive: true });
writeFileSync(here + 'out/timeline.json', JSON.stringify({ BPM, BEAT, DUR, BEATS, HIT, TICKS, HUSH, SOUNDER }, null, 1));
console.log('timeline.json', Object.keys(HIT).length, 'hits; sounder', SOUNDER.map(s => s[0]).join(' '));
