// timeline.js → timeline.json（给 mix.py / cuecheck.py）
import fs from 'fs'; import path from 'path'; import vm from 'vm';
const D = process.argv[2] || '.';
const ctx = { globalThis: {} }; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(D, 'timeline.js'), 'utf8'), ctx);
const { TL } = ctx; const o = { ...TL }; delete o.at;
o.beats = {}; for (const s of TL.SECS) o.beats[s.id] = [...Array(s.beats + 1)].map((_, b) => TL.at(s.id, b));
fs.writeFileSync(path.join(D, 'timeline.json'), JSON.stringify(o, null, 1)); console.log('timeline.json', Object.keys(o.T).length, 'hits');
