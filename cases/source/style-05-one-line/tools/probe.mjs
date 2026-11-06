// 打印每段、每个标记区间的路径长度与平均笔速（调 marks 用）：node tools/probe.mjs（需 LIB）
import path from 'path'; import { fileURLToPath } from 'url';
const LIB = process.env.LIB || '@@LEMO_ROOT@@';
const { openDemo, closeServer } = await import(path.join(LIB, 'core/render/page.mjs'));
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { browser, page } = await openDemo(HERE, { warnings: true });
const out = await page.evaluate(() => {
  const P = window.PATH, rows = [];
  P.segs.forEach((sg, si) => {
    const [a, b] = P.range[si];
    // 时间断点：段首、各标记、段尾
    const ts = [sg.t[0], ...(sg.marks || []).map(m => m.t), sg.t[1]].sort((x, y) => x - y);
    for (let k = 0; k < ts.length - 1; k++) {
      let i0 = a, i1 = a; while (i0 < b && P.T[i0] < ts[k]) i0++; i1 = i0; while (i1 < b && P.T[i1] < ts[k + 1]) i1++;
      const L = P.S[i1] - P.S[i0], dt = ts[k + 1] - ts[k];
      rows.push(`${sg.id.padEnd(6)} ${ts[k].toFixed(3)}→${ts[k + 1].toFixed(3)}  L=${L.toFixed(0).padStart(4)}  v=${(L / dt).toFixed(0).padStart(5)}`);
    }
  });
  const hits = window.EV.filter(e => e.type === 'hit').map(e => `${e.id}:${(e.t ?? NaN).toFixed(4)}/${e.beat.toFixed(4)}`);
  return rows.join('\n') + '\n' + hits.join('  ');
});
console.log(out);
await browser.close(); closeServer();
