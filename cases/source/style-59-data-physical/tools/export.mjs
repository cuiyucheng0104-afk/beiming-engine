// timeline.js → out/timeline.json（给 mix.py 与 cuecheck.py 读同一套数字）
import fs from 'fs'; import path from 'path'; import { pathToFileURL } from 'url';
const dir = path.resolve(process.argv[2] || '.');
const TL = await import(pathToFileURL(path.join(dir, 'timeline.js')));
const out = { BPM: TL.BPM, BEAT: TL.BEAT, BAR: TL.BAR, DUR: TL.DUR, T: TL.T, IN: TL.IN, MM: TL.MM, TOTAL: TL.TOTAL, PENTA: TL.PENTA, MONTH_NOTE: TL.MONTH_NOTE,
  UNIT_BEATS: TL.UNIT_BEATS, FEED_ON: Array.from({ length: 12 }, (_, m) => TL.FEED_ON(m)), LAST_BEAT: TL.LAST_BEAT, SEC: TL.SEC, WETTEST: TL.WETTEST };
fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
fs.writeFileSync(path.join(dir, 'out/timeline.json'), JSON.stringify(out, null, 1));
console.log('timeline.json', out.DUR, 's', out.BPM, 'BPM', 'total', out.TOTAL);
