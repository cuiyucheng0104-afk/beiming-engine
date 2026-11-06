// timeline.js → timeline.json（给 mix.py / cuecheck.py）
import { timelineJSON } from '../timeline.js';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const here = dirname(dirname(fileURLToPath(import.meta.url)));
writeFileSync(join(here, 'timeline.json'), JSON.stringify(timelineJSON(), null, 1));
console.log('timeline.json', timelineJSON().dur);
