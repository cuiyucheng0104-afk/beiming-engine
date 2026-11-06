// 北冥引擎 · 渲静帧
//   node engine/render/still.mjs <影片目录> <t> [<t> ...] [--range a:b:step] [--size 1920x1040] [--query k=v] [--out out/stills] [--prefix s_]
import fs from 'fs';
import path from 'path';
import { openFilm, closeServer, takeSize } from './page.mjs';

const args = process.argv.slice(2);
const take = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
const { w, h } = takeSize(args);
const outDir = take('--out') || 'out/stills', query = take('--query') || '', prefix = take('--prefix') || 's_', range = take('--range');
const [dir, ...times] = args;
if (range) {
  const [a, b, step] = range.split(':').map(Number);
  for (let t = a; t <= b + 1e-9; t += step) times.push(t.toFixed(2));
}
if (!dir || !times.length) { console.error('用法：node engine/render/still.mjs <影片目录> <t> ... [--range a:b:step]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const { browser, page } = await openFilm(dir, { w, h, query });
for (const t of times) {
  const t0 = Date.now();
  await page.evaluate(x => window.render(x), parseFloat(t));
  const file = path.join(outDir, `${prefix}${t}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 92 });
  console.log(file, `${Date.now() - t0}ms`);
}
await browser.close();
await closeServer();
