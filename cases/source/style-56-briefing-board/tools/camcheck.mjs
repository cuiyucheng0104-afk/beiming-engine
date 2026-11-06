// Camera check: before the reveal (H.pull) the camera never shows the secondary layer (notes, source card,
// the HAER overview print) and never both side edges of the board; prints the max visible share of the board width.
//   cd $LIB && node <film>/tools/camcheck.mjs <film>
import path from 'path';
const FILM = path.resolve(process.argv[2] || '.'), LIB = process.env.LIB || process.cwd();
const { openDemo, closeServer } = await import(path.join(LIB, 'core/render/page.mjs'));
const T = await import(path.join(FILM, 'timeline.js'));
const { browser, page } = await openDemo(FILM, { w: 1920, h: 1080 });
const zones = { notes: [5625, 2470, 6320, 3270], srcCard: [4090, 1440, 4910, 1830], elevPrint: [4240, 660, 5780, 1340] };
const r = await page.evaluate(({ end, zones }) => {
  const out = { bad: [], maxShare: 0 };
  for (let f = 0; f / 24 < end; f++) {
    const t = f / 24, c = [[0, 0], [1920, 0], [0, 1080], [1920, 1080]].map(p => window.TOWORLD(p, t));
    const xs = c.map(p => p[0]), ys = c.map(p => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    out.maxShare = Math.max(out.maxShare, (Math.min(6400, x1) - Math.max(0, x0)) / 6400);
    if (x0 < 0 && x1 > 6400) out.bad.push([t, 'both edges']);
    for (const [k, z] of Object.entries(zones)) if (x1 > z[0] && x0 < z[2] && y1 > z[1] && y0 < z[3]) out.bad.push([+t.toFixed(3), k]);
  }
  return out;
}, { end: T.H.pull, zones });
await browser.close(); closeServer();
const seen = {}; for (const [t, k] of r.bad) (seen[k] ??= []).push(t);
for (const [k, ts] of Object.entries(seen)) console.log(`BAD ${k}: ${ts.length} frames, ${ts[0]}–${ts[ts.length - 1]} s`);
console.log(`camcheck: max visible share of the board width before the reveal ${(r.maxShare * 100).toFixed(1)} %` + (r.bad.length ? '' : ' — OK'));
process.exit(r.bad.length ? 1 : 0);
