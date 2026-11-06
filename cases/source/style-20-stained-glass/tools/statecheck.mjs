// Frame-exact picture cue check: for every visual cue, the first rendered frame whose cue variable switches on,
// compared with the cue's beat time. Run from $LIB: node <film>/tools/statecheck.mjs <film>
import path from 'path'; import fs from 'fs';
const LIB = process.env.LIB || '@@LEMO_ROOT@@';
const { openDemo, closeServer } = await import(path.join(LIB, 'core/render/page.mjs'));
const dir = path.resolve(process.argv[2] || path.dirname(path.dirname(new URL(import.meta.url).pathname)));
const TL = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'))); const FPS = TL.FPS;
const { browser, page } = await openDemo(dir);
const cues = await page.evaluate(() => window.VCUES);
let worst = 0; const rows = [];
for (const c of cues) {
  const fe = Math.round(c.t * FPS);
  const vals = await page.evaluate(([fe, n, fps]) => { const out = []; for (let f = fe - 3; f <= fe + 3; f++) out.push(window.CUESTATE(f / fps)[n]); return out; }, [fe, c.name, FPS]);
  const k = vals.findIndex(v => v > 0); const on = k < 0 ? null : fe - 3 + k;
  const dev = on === null ? null : (on / FPS - c.t) * 1000; if (dev !== null) worst = Math.max(worst, Math.abs(dev));
  rows.push(`${c.name.padEnd(12)} beat ${(c.t / TL.BEAT).toFixed(2).padStart(6)}  cue frame ${String(fe).padStart(3)} (${(fe / FPS - c.t) * 1000 === 0 ? 'exact' : ((fe / FPS - c.t) * 1000).toFixed(2) + ' ms'})  first lit frame ${on}  deviation ${dev === null ? 'NONE' : dev.toFixed(1) + ' ms'}`);
}
console.log(rows.join('\n')); console.log('max |picture - beat| =', worst.toFixed(1), 'ms');
await browser.close(); closeServer();
