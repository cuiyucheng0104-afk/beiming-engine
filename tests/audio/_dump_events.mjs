// tests/audio 的辅助脚本（不是测试）：在 Node 里直接加载作品的 timeline.js（不开浏览器），按 engine/render/events.mjs 的外形
// 写出 events.json（{ dur, ev }）与 timeline.json（window.TIMELINE），给 C 路线的拍点核对测试用。
//   node tests/audio/_dump_events.mjs <作品目录>
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const film = resolve(process.argv[2] ?? '.');
const tl = await import(pathToFileURL(join(film, 'timeline.js')).href);
const files = [['events.json', { dur: tl.DUR, ev: tl.EV }, 0], ['timeline.json', tl.TIMELINE, 1]];
for (const [name, value, indent] of files) await writeFile(join(film, name), JSON.stringify(value, null, indent || undefined));
console.log(`${tl.EV.length} 个事件，片长 ${tl.DUR} 秒`);
