// 调试：逐帧打印运动模糊强度（相机甩镜时），node tools/blurprobe.mjs <film>
import { openDemo, closeServer } from '@@LEMO_ROOT@@/core/render/page.mjs';
const [dir] = process.argv.slice(2);
const { browser, page } = await openDemo(dir);
const r = await page.evaluate(() => { const o = []; for (let f = 0; f < 576; f++) { window.render(f / 30); const D = window.DBG; const m = Math.max(D.bx, D.by); if (m > .6 || Math.hypot(D.vx, D.vy) > 40) o.push([f, +(f / 30).toFixed(2), +D.bx.toFixed(1), +D.by.toFixed(1), Math.round(D.vx), Math.round(D.vy)]); } return o; });
for (const x of r) console.log(x.join('\t'));
await browser.close(); closeServer();
