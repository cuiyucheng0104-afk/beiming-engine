// 调试：打印若干时刻的相机、卡片脚底、光标位置。node tools/probe.mjs <film> t1 t2 ...
import { openDemo, closeServer } from '@@LEMO_ROOT@@/core/render/page.mjs';
const [dir, ...ts] = process.argv.slice(2);
const { browser, page } = await openDemo(dir);
for (const t of ts) { const d = await page.evaluate(t => { window.render(t); const D = window.DBG; return { t, cam: D.cam.map(v => +v.toFixed(1)), card: D.card && [Math.round(D.card.x), Math.round(D.card.y)], cur: D.cu && [Math.round(D.cu.x), Math.round(D.cu.y)], scr: D.cardScr && [Math.round(D.cardScr.x), Math.round(D.cardScr.y)], A: ['slot','r3','toast','settb','toggle','trash'].map(k => { const p = window.__A(k, 0, 0); return p ? k + ':' + Math.round(p.x) + ',' + Math.round(p.y) + ' ' + Math.round(p.w) : k + ':-'; }).join(' ') }; }, +t); console.log(JSON.stringify(d)); }
await browser.close(); closeServer();
