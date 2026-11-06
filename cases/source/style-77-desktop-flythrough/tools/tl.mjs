// node tools/tl.mjs → out/timeline.json: the one clock (timeline.js) for the Python side (score, foley, cue check)
import fs from 'fs';
const dir = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
const src = fs.readFileSync(dir + '/src/timeline.js', 'utf8');
const M = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const out = { BPM: M.BPM, FPS: M.FPS, BEAT: M.BEAT, BAR: M.BAR, S16: M.S16, NBEATS: M.NBEATS, DUR: M.DUR, CHORDS: M.CHORDS, HIT: M.HIT, T: M.T };
fs.mkdirSync(dir + '/out', { recursive: true });
fs.writeFileSync(dir + '/out/timeline.json', JSON.stringify(out, null, 1));
console.log('timeline', M.BPM, 'BPM, dur', M.DUR);
