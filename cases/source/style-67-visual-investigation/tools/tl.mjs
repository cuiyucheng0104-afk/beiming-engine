// timeline.js → timeline.json (for mix.py and the cue check). Usage: node tools/tl.mjs <project>
import fs from 'fs'; import path from 'path'; import vm from 'vm';
const dir = process.argv[2] || path.dirname(path.dirname(new URL(import.meta.url).pathname));
const ctx = {}; vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(dir, 'timeline.js'), 'utf8'), ctx);
const TL = ctx.TL, T = TL.T;
const at = Object.fromEntries(Object.entries(TL.AT).map(([k, b]) => [k, { b, t: T(b) }]));
const out = { bpm: TL.BPM, fps: TL.FPS, beats: TL.BEATS, spb: TL.SPB, dur: TL.DUR, sec: TL.SEC, at, ev: TL.EV.map(e => ({ ...e, t: T(e.b) })) };
fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(out, null, 1));
console.log('timeline.json', out.ev.length, 'events, dur', out.dur);
