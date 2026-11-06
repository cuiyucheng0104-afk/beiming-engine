// Downloads Google Fonts (OFL) subsets for exactly the characters used on screen → fonts/
// node tools/fetch_fonts.mjs   (needs a network connection; the result is kept in fonts/)
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
import { TEXT } from '../timeline.js';
const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const all = [...new Set(TEXT() + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .:/·-→×')].join('');
const cjk = [...new Set([...all].filter(c => c.charCodeAt(0) > 0x2e80))].join('');
const latin = [...new Set([...all].filter(c => c.charCodeAt(0) < 0x2e80))].join('');
const jobs = [
  ['NotoSansSC-900.woff2', 'Noto+Sans+SC:wght@900', cjk],
  ['NotoSansSC-500.woff2', 'Noto+Sans+SC:wght@500', cjk],
  ['InterTight-900.woff2', 'Inter+Tight:wght@900', latin],
  ['InterTight-700.woff2', 'Inter+Tight:wght@700', latin],
  ['DMMono-500.woff2', 'DM+Mono:wght@500', latin],
];
for (const [file, fam, text] of jobs) {
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${fam}&text=${encodeURIComponent(text)}`, { headers: { 'User-Agent': UA } })).text();
  const urls = [...css.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]);
  if (urls.length !== 1) throw new Error(`${fam}: expected one font file, got ${urls.length}\n${css}`);
  const buf = Buffer.from(await (await fetch(urls[0], { headers: { 'User-Agent': UA } })).arrayBuffer());
  fs.writeFileSync(path.join(HERE, 'fonts', file), buf);
  console.log(file, buf.length, 'bytes', [...text].length, 'chars');
}
console.log('CJK:', cjk);
