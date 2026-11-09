// 北冥引擎 · 导出声画事件表：打开影片页面，把 window.EV 写成 events.json，页面有 window.TIMELINE 时再写 timeline.json。
//   node engine/render/events.mjs <影片目录> [--size 1920x1040] [--query k=v] [--out <目录>]
// events.json  = { dur: window.DUR, ev: window.EV || [] }（紧凑 JSON）
// timeline.json = window.TIMELINE 原样（缩进 1），一般是 { ...tempo.toJSON(), dur, cues, t }，给 mix.py 与 cuecheck 读
// 默认写进影片目录本身；换内容出第二版时用 --query 传参、--out 换目录，免得覆盖正片的事件表。
// 事件表由页面在加载时算好（engine/core/tempo.js 的 createEvents），这里不调用 render(t)，不渲帧。
import fs from 'fs';
import path from 'path';
import { openFilm, closeServer, takeSize } from './page.mjs';

const args = process.argv.slice(2);
const { w, h } = takeSize(args);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dir = args[0];
if (!dir || dir.startsWith('--')) { console.error('用法：node engine/render/events.mjs <影片目录> [--out <目录>]'); process.exit(2); }
const outDir = path.resolve(opt('--out', dir)), query = opt('--query', '');

const { browser, page } = await openFilm(dir, { w, h, query });
const { ev, tl } = await page.evaluate(() => ({ ev: { dur: window.DUR, ev: window.EV || [] }, tl: window.TIMELINE || null }));
await browser.close();
await closeServer();

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(ev));
console.log(`events.json  ${ev.ev.length} 条  dur ${ev.dur}`);
if (tl) {
  fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(tl, null, 1));
  console.log(`timeline.json  ${(tl.secs || []).length} 段  ${Object.keys(tl.cues || {}).length} 个打点`);
}
