// Evaluate render(t) on every frame (no capture) and report any page error: node tools/framescan.mjs <film> [fps]
import { openDemo, closeServer } from '@@LEMO_ROOT@@/core/render/page.mjs';
const dir = process.argv[2], fps = +(process.argv[3] || 30);
const { browser, page } = await openDemo(dir);
const res = await page.evaluate(fps => { const bad = []; const n = Math.round(window.DUR * fps); for (let f = 0; f < n; f++) { try { window.render(f / fps); } catch (e) { bad.push([f, String(e)]); if (bad.length > 5) break; } } return bad; }, fps);
console.log(res.length ? res : 'all frames ok');
await browser.close(); closeServer();
