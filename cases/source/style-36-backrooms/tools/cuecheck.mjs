// 拍点核对：画面实测的视觉事件（window.VIS，从机位/对焦/磁带函数量出来）+ 混音里每个声音的实际放置时间（out/audio_cues.json）
// 都与 72 BPM 网格比较；另外从成片混音里实测静默区间与冲击起点。用法：node tools/cuecheck.mjs（在 LIB 下由 build.sh 调用）
import fs from 'fs'; import path from 'path';
const LIB = process.env.LIB || '@@LEMO_ROOT@@';
const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { openDemo, closeServer } = await import(path.join(LIB, 'core/render/page.mjs'));
const B = 60 / 72, FPS = 24;
const { browser, page } = await openDemo(HERE);
const vis = await page.evaluate(() => window.VIS());
await browser.close(); closeServer();
const A = JSON.parse(fs.readFileSync(path.join(HERE, 'out/audio_cues.json'), 'utf8'));
let worst = 0, n = 0; const rows = [];
const row = (kind, what, beat, t) => {
  const g = beat * B, d = t == null ? NaN : (t - g) * 1000; n++;
  if (!Number.isFinite(d)) worst = Infinity; else worst = Math.max(worst, Math.abs(d));
  const fr = Math.abs(g * FPS - Math.round(g * FPS)) < 1e-6 ? '帧对齐' : '非整帧!';
  rows.push(`${kind}  拍 ${String(beat).padEnd(5)} 网格 ${g.toFixed(4)}s  实测 ${t == null ? '—' : t.toFixed(4)}s  偏差 ${Number.isFinite(d) ? d.toFixed(2).padStart(6) : '  缺失'} ms  ${fr}  ${what}`);
};
for (const v of vis) row('画面', v.what, v.beat, v.t);
for (const c of A.cues) row('声音', c.type, c.beat, c.t);
// 成片混音实测：静默区间、静默后第一声
try {
  const buf = fs.readFileSync(path.join(HERE, 'out/mix.wav'));
  // 解析 WAV（float32 立体声）
  let o = 12, data = null, ch = 2, sr = 48000;
  while (o < buf.length) { const id = buf.toString('ascii', o, o + 4), sz = buf.readUInt32LE(o + 4); if (id === 'fmt ') { ch = buf.readUInt16LE(o + 10); sr = buf.readUInt32LE(o + 12); } if (id === 'data') { data = new Float32Array(buf.buffer.slice(buf.byteOffset + o + 8, buf.byteOffset + o + 8 + sz)); break; } o += 8 + sz + (sz & 1); }
  const nfr = data.length / ch; let z0 = -1, z1 = -1;
  for (let i = Math.round(14 * B * sr); i < Math.round(17 * B * sr); i++) { const s = Math.abs(data[i * ch]) + Math.abs(data[i * ch + 1]); if (s === 0 && z0 < 0) z0 = i; if (z0 >= 0 && s > 0) { z1 = i; break; } }
  row('混音实测', '数字零开始', 14.5, z0 / sr); row('混音实测', '静默后第一声（冲击起点）', 16, z1 / sr);
  console.log(`静默长度 ${((z1 - z0) / sr).toFixed(4)} s`);
} catch (e) { console.log('混音未找到：', e.message); }
console.log(rows.join('\n'));
console.log(`\n共 ${n} 项，最大偏差 ${worst.toFixed(2)} ms`);
process.exit(worst <= 1 ? 0 : 1);
