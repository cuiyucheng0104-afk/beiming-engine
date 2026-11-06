// Asks the page where every pole is on screen at its beat, and when each steam puff is born (frame-exact).
// Run from the library root:  node <film>/tools/probe.mjs <film>   → <film>/out/probe.json
import fs from 'fs'; import path from 'path';
const LIB = process.env.LIB || '@@LEMO_ROOT@@';
const { openDemo, closeServer } = await import(path.join(LIB, 'core/render/page.mjs'));
const dir = path.resolve(process.argv[2]);
const { browser, page } = await openDemo(dir);
const out = await page.evaluate(() => {
  const FPS = 30, poles = window.CHECK.poles();
  // puff births: the frame at which the number of steam sprites jumps (the chuffs), between 4.5 s and 8.2 s
  const births = []; let prev = window.CHECK.puffs(4.5 - 1 / FPS);
  for (let f = Math.round(4.5 * FPS); f <= Math.round(7.95 * FPS); f++) { const n = window.CHECK.puffs(f / FPS); if (n > prev) births.push(f / FPS); prev = n; }
  const plate = []; for (let f = Math.round(15.8 * FPS); f <= Math.round(18.3 * FPS); f++) plate.push([f, window.CHECK.plateBox(f / FPS)]);
  const tassel = []; for (let f = Math.round(11.7 * FPS); f <= Math.round(12.3 * FPS); f++) tassel.push([f, window.CHECK.tasselBox(f / FPS)]);
  return { poles, births, plate, tassel, cues: window.CUES };
});
fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
fs.writeFileSync(path.join(dir, 'out', 'probe.json'), JSON.stringify(out));
console.log('probe: poles', out.poles.length, 'puff births', out.births.length);
await browser.close(); closeServer();
