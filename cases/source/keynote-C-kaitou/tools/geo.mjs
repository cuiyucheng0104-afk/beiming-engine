// 在真实页面里求值一段 JS（几何/投影检查用）：node tools/geo.mjs '<expr>' [query]
import path from 'path'; import { fileURLToPath } from 'url';
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = process.env.LIB || '@@LEMO_ROOT@@';
const { openDemo, closeServer } = await import(path.join(LIB, 'core/render/page.mjs'));
const { browser, page } = await openDemo(HERE, { q: process.argv[3] || 'ss=1' });
const r = await page.evaluate(e => eval(e), process.argv[2]);
console.log(JSON.stringify(r));
await browser.close(); closeServer();
