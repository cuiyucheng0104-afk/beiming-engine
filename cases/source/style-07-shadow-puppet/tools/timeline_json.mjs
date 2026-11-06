// node tools/timeline_json.mjs → out/timeline.json (the score, mixer and cue check read it)
import fs from 'fs'; import path from 'path'; import url from 'url';
const HERE = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const { timelineJSON } = await import(url.pathToFileURL(path.join(HERE, 'timeline.js')));
fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'out/timeline.json'), JSON.stringify(timelineJSON(), null, 1));
console.log('timeline →', path.join(HERE, 'out/timeline.json'));
