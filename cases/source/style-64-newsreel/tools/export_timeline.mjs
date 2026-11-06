// timeline.js -> timeline.json (for the Python tools)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const { TL } = await import(join(HERE, 'timeline.js'));
writeFileSync(join(HERE, 'timeline.json'), JSON.stringify(TL, null, 1));
console.log('timeline.json', TL.DUR, 's');
