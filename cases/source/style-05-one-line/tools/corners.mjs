// 列出城市段的拐角（弧长、坐标），配合渐快的目标弧长选拍点
import path from 'path'; import { fileURLToPath } from 'url';
const LIB = process.env.LIB || '@@LEMO_ROOT@@';
const { openDemo, closeServer } = await import(path.join(LIB, 'core/render/page.mjs'));
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { browser, page } = await openDemo(HERE);
const seg = process.argv[2] || 'city';
console.log(await page.evaluate((seg) => {
  const P = window.PATH, si = P.segs.findIndex(s => s.id === seg), [a, b] = P.range[si], out = [];
  for (let i = a + 2; i < b - 2; i++) if (P.TURN[i] > 0.9 && P.TURN[i] >= P.TURN[i - 1] && P.TURN[i] >= P.TURN[i + 1]) {
    const s = P.S[i] - P.S[a]; if (out.length && s - out.at(-1)[0] < 4) continue; out.push([s, P.X[i], P.Y[i]]);
  }
  return `total ${(P.S[b] - P.S[a]).toFixed(0)}\n` + out.map(o => `${o[0].toFixed(0)}  (${o[1].toFixed(0)},${o[2].toFixed(0)})`).join('\n');
}, seg));
await browser.close(); closeServer();
