// 第三章：由 src/chapters/ch3_cues.js 的 EVENTS() 重新导出 sfx/ch3.json（改了第三章时间后跑：node tools/gen_sfx_ch3.mjs）
import fs from 'fs';
import path from 'path'; import { fileURLToPath } from 'url';
const P = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // 工程根目录
const { EVENTS } = await import(P + '/src/chapters/ch3_cues.js');
const out = [];
for (const e of EVENTS()) for (const s of e.snd) { const o = { ev: e.id, ...s }; for (const k of ['gain', 'pan']) if (o[k] !== undefined) o[k] = +(+o[k]).toFixed(2); if (o.pan === 0) delete o.pan; out.push(o); }
const lines = out.map(o => '    ' + JSON.stringify(o));
const txt = `{\n  "chap": "ch3",\n  "note": "由 src/chapters/ch3_cues.js 的 EVENTS() 生成（每条 ev 引用本章事件，画面改了声音自动跟）。翻页与台灯的声音由共用层自动配。",\n  "events": [\n${lines.join(',\n')}\n  ]\n}\n`;
fs.writeFileSync(P + '/sfx/ch3.json', txt);
console.log(out.length, 'entries');
