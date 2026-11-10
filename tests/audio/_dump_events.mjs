// tests/audio 的辅助脚本（不是测试）：不开浏览器，直接 import 作品的 timeline.js，写 events.json / timeline.json，
// 外形与 engine/render/events.mjs 打开页面导出的相同（{ dur, ev } 与 window.TIMELINE）。
//   node tests/audio/_dump_events.mjs <作品目录>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = path.resolve(process.argv[2] || '.');
const m = await import(pathToFileURL(path.join(dir, 'timeline.js')).href);
fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify({ dur: m.DUR, ev: m.EV }));
fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(m.TIMELINE, null, 1));
process.stdout.write(`events ${m.EV.length} · dur ${m.DUR}\n`);
