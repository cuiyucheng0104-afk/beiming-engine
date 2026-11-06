// 一次性：从 Google Fonts CSS API 下载字体子集到 fonts/，生成 fonts.css（OFL）
// 用法：node tools/fetch_fonts.mjs <工程目录>
import fs from 'fs'; import path from 'path';
const D = process.argv[2] || '.';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const fams = [
  ['Long Cang', `family=Long+Cang&text=${encodeURIComponent('朱砂一滴锦鲤春夏秋冬')}`],
  ['Noto Serif SC', `family=Noto+Serif+SC:wght@500;700&text=${encodeURIComponent('一滴朱红鲤')}`],
  ['IBM Plex Mono', `family=IBM+Plex+Mono:wght@400&text=${encodeURIComponent('Ø 0123456789mIVX–·/')}`],
];
let out = '', n = 0; fs.mkdirSync(path.join(D, 'fonts'), { recursive: true });
for (const [name, q] of fams) {
  let css = await (await fetch(`https://fonts.googleapis.com/css2?${q}&display=block`, { headers: { 'User-Agent': UA } })).text();
  if (!css.includes('@font-face')) throw new Error('bad css for ' + name + ': ' + css.slice(0, 200));
  for (const u of [...new Set(css.match(/https:\/\/[^)]+/g) || [])]) {
    const f = `g${n++}.woff2`;
    fs.writeFileSync(path.join(D, 'fonts', f), Buffer.from(await (await fetch(u)).arrayBuffer()));
    css = css.split(u).join('fonts/' + f);
  }
  out += css;
}
fs.writeFileSync(path.join(D, 'fonts.css'), out); console.log('font files', n);
