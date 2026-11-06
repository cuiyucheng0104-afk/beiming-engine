// 逐帧读取画面状态（window.PROBE），写 out/probe.json，供 cuecheck.py 判定"画面事件发生在哪一帧"
// 用法（在库根目录）：node <film>/probe.mjs <film>
import fs from 'fs'; import path from 'path';
const LIB = process.env.LIB || '@@LEMO_ROOT@@';
const { openDemo, closeServer } = await import(path.join(LIB, 'core/render/page.mjs'));
const dir = process.argv[2];
const { browser, page } = await openDemo(dir, { q: 'ssaa=1' });
const out = await page.evaluate(() => { const fps = 24, n = Math.round(window.DUR * fps), r = []; for (let f = 0; f <= n; f++) r.push(window.PROBE(f / fps)); return { fps, frames: r }; });
fs.writeFileSync(path.join(dir, 'out', 'probe.json'), JSON.stringify(out));
console.log('probe frames', out.frames.length);
await browser.close(); closeServer();
