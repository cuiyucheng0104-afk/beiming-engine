// timeline.js -> timeline.json (for mix.py and cuecheck.py)
import { writeFileSync } from 'fs';
const D = process.argv[2];
const m = await import(D + '/timeline.js');
writeFileSync(D + '/timeline.json', JSON.stringify({ bpm: m.BPM, beat: m.BEAT, dur: m.DUR, B: m.B, T: m.T }, null, 1));
console.log('timeline.json', m.DUR);
