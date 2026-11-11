// tests/audio 的辅助脚本（不是测试）：在 Node 里直接加载作品的 timeline.js（不开浏览器），按 engine/render/events.mjs 的外形
// 写出 events.json（{ dur, ev }）与 timeline.json（window.TIMELINE），给 C 路线的拍点核对测试用。
//   node tests/audio/_dump_events.mjs <作品目录>
// C 模版（routes/c-style/template）的事件表由 timeline.js 的 buildEvents(scene) 算：scene 要画布才能算声像，这里给居中的声像、
// 按片名字数（竖排时每字一笔，与 film.js 的 title.chars 同口径）的题字笔数——拍点核对只看时刻，声像不影响结果。
// 旧写法（timeline.js 直接导出 EV）照用。
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const film = resolve(process.argv[2] ?? '.');
const tl = await import(pathToFileURL(join(film, 'timeline.js')).href);
const title = JSON.parse(await readFile(join(film, 'film.json'), 'utf8')).title ?? '';
const chars = [...title];
const vertical = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff01-\uff5e·]+$/u.test(title) && chars.length <= 8;   // 同 film.js 的 CJK
const EV = tl.EV ?? tl.buildEvents({ chars: vertical ? chars.length : 1, pan: () => 0 });
const files = [['events.json', { dur: tl.DUR, ev: EV }, 0], ['timeline.json', tl.TIMELINE, 1]];
for (const [name, value, indent] of files) await writeFile(join(film, name), JSON.stringify(value, null, indent || undefined));
console.log(`${EV.length} 个事件，片长 ${tl.DUR} 秒`);
