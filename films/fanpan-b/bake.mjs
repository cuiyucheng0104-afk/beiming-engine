// 《沉水擂台》B 版 · 烘图：原生运行时不跑 Canvas 2D，所以 cards.js 画的像素片先在无头浏览器里画好、存成 PNG（baked/ 目录）。
//   baked/cards.png + cards.json   所有像素片拼成的一张图集（最近邻采样），和每张片在图集里的位置
//   baked/glow.png                 灯晕、光柱、水汽的软边图集（线性采样）
//   baked/units/*.png              十条棋子序列帧，加了一圈深色边和一圈队色边
// 改了 cards.js、ink.js 或 plan.js 里的棋子 / 血量后重跑：node films/fanpan-b/bake.mjs
import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeExecutable } from '../../engine/render/page.mjs';
import { UNITS } from './plan.js';

const here = dirname(fileURLToPath(import.meta.url)), out = resolve(here, 'baked');
await mkdir(resolve(out, 'units'), { recursive: true });
const browser = await chromium.launch({ executablePath: chromeExecutable?.() });
const page = await browser.newPage();
page.on('pageerror', e => { console.error(String(e)); process.exitCode = 1; });
await page.route('http://bake.invalid/**', async route => {
  const name = new URL(route.request().url()).pathname.slice(1);
  if (name === '') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8">' });
  const type = extname(name) === '.png' ? 'image/png' : 'text/javascript';
  route.fulfill({ contentType: type, body: await readFile(resolve(here, name)) });
});
await page.goto('http://bake.invalid/');
const made = await page.evaluate(async units => {
  const C = await import('/cards.js');
  // 货架式装箱：按高度排序，一行行往下放，四周各留 2 像素透明边
  const pack = (set, width) => {
    const names = Object.keys(set).sort((a, b) => set[b].height - set[a].height || a.localeCompare(b)), rects = {};
    let x = 2, y = 2, rowH = 0;
    for (const n of names) { const c = set[n]; if (x + c.width + 2 > width) { x = 2; y += rowH + 4; rowH = 0; } rects[n] = [x, y, c.width, c.height]; x += c.width + 4; rowH = Math.max(rowH, c.height); }
    const sheet = document.createElement('canvas'); sheet.width = width; sheet.height = y + rowH + 2;
    const g = sheet.getContext('2d'); for (const n of names) g.drawImage(set[n], rects[n][0], rects[n][1]);
    return { url: sheet.toDataURL('image/png'), size: [sheet.width, sheet.height], rects };
  };
  const sheets = {};
  for (const u of units) {
    const img = new Image(); img.src = `/units/${u.atlas}.png`; await img.decode();
    sheets[u.atlas] = C.outline(img, u.team).toDataURL('image/png');
  }
  return { cards: pack(C.sprites(), 512), glow: pack(C.glows(), 256), sheets };
}, UNITS.map(u => ({ atlas: u.atlas, team: u.team })));
const png = url => Buffer.from(url.split(',')[1], 'base64');
await writeFile(resolve(out, 'cards.png'), png(made.cards.url));
await writeFile(resolve(out, 'glow.png'), png(made.glow.url));
await writeFile(resolve(out, 'cards.json'), JSON.stringify({ cards: { size: made.cards.size, rects: made.cards.rects }, glow: { size: made.glow.size, rects: made.glow.rects } }, null, 1) + '\n');
for (const [name, url] of Object.entries(made.sheets)) await writeFile(resolve(out, 'units', `${name}.png`), png(url));
await browser.close();
console.log(`图集 ${made.cards.size.join('×')}，${Object.keys(made.cards.rects).length} 张像素片；软边图集 ${made.glow.size.join('×')}；棋子 ${Object.keys(made.sheets).length} 条`);
