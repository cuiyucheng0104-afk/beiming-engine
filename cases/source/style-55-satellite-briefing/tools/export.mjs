// timeline.js -> timeline.json (bpm, beat, cues in seconds and beats, rings) for mix.py and cuecheck.py
import fs from 'fs'; import path from 'path'; import url from 'url';
const here = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const TL = await import(url.pathToFileURL(path.join(here, 'timeline.js')).href);
fs.writeFileSync(path.join(here, 'timeline.json'), JSON.stringify({ bpm: TL.BPM, beat: TL.BEAT, T: TL.T, B: TL.B, rings: TL.RINGS }, null, 1));
console.log('timeline.json', Object.keys(TL.T).length, 'cues');
