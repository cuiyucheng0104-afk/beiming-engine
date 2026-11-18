// 《林间擂台》B 版 · 小工具：把 px.js 里画的「脚下的圈」「战力牌」「城门血量牌」存成 PNG（marks/ 目录），film.json 再把它们登记进 media/。
// 原生运行时不跑 Canvas 2D，所以这几张小图先在无头浏览器里画好。改了 px.js 的 ring / badge 或棋子的战力后重跑：
//   node films/fanpan-b/marks.mjs
import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeExecutable } from '../../engine/render/page.mjs';
import { UNITS, HP } from './layout.js';

const here = dirname(fileURLToPath(import.meta.url)), out = resolve(here, 'marks');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: chromeExecutable?.() });
const page = await browser.newPage();
await page.route('http://marks.invalid/**', async route => {
  const name = new URL(route.request().url()).pathname.slice(1);
  if (name === '') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8">' });
  route.fulfill({ contentType: 'text/javascript', body: await readFile(resolve(here, name), 'utf8') });
});
await page.goto('http://marks.invalid/');
const want = [['ring-teal', 'ring', { team: 'teal' }], ['ring-red', 'ring', { team: 'red' }], ['plaque-own', 'plaque', { hp: HP.own, team: 'teal' }], ['plaque-foe', 'plaque', { hp: HP.foe, team: 'red' }]];
for (const u of UNITS) { const team = u.team === 'own' ? 'teal' : 'red', key = `badge-${team}-${u.str}`; if (!want.some(w => w[0] === key)) want.push([key, 'badge', { n: u.str, team }]); }
const made = await page.evaluate(async list => {
  const PX = await import('/px.js');
  // 光柱用的软片：白底，透明度两侧淡出、两头淡出（和 C 版 film.js 里那张同一个公式，只是放进了透明通道）
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), img = g.createImageData(64, 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const a = Math.sin(Math.PI * x / 63) ** 2 * Math.sin(Math.PI * Math.min(1, y / 50)) ** .7, i = (y * 64 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = Math.round(a * 255); }
  g.putImageData(img, 0, 0);
  return [...list.map(([name, fn, args]) => [name, PX[fn](args).toDataURL('image/png')]), ['shaft', c.toDataURL('image/png')]];
}, want);
for (const [name, url] of made) await writeFile(resolve(out, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
await browser.close();
console.log(`已写出 ${made.length} 张：${made.map(m => m[0]).join(' ')}`);
