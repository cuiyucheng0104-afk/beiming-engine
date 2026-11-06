// 全片逐帧状态采样（真实页面代码）：书页角度、台灯、各章 probe() → out/probe_full.json；每 0.25 s 一次画面文字 → out/texts.json
// 用法：node tools/probe_full.mjs [起 止]   （默认 20 180；LIB 环境变量或默认 @@LEMO_ROOT@@）
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = process.env.LIB || '@@LEMO_ROOT@@';
const { openDemo, closeServer } = await import(path.join(LIB, 'core/render/page.mjs'));
const a = +(process.argv[2] ?? 20), b = +(process.argv[3] ?? 180);
const { browser, page } = await openDemo(HERE, { q: 'ss=1' });
const frames = await page.evaluate(([a, b]) => { const out = []; for (let f = Math.round(a * 30); f <= Math.round(b * 30); f++) out.push({ f, ...window.PROBE2(f / 30) }); return out; }, [a, b]);
const texts = await page.evaluate(([a, b]) => { const out = []; for (let t = a; t <= b + 1e-9; t += .25) out.push({ t: +t.toFixed(2), texts: window.TEXTS(t).map(x => ({ id: x.id, text: x.text, chap: x.chap, box: [x.x0, x.y0, x.x1, x.y1].map(v => Math.round(v)) })) }); return out; }, [Math.max(0, a - 20), b]);
fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'out', 'probe_full.json'), JSON.stringify(frames));
const T = await import(path.join(HERE, 'src/shared/texts.js'));
fs.writeFileSync(path.join(HERE, 'out', 'texts.json'), JSON.stringify({ allowed: [...T.ALLOWED], placeholders: [...T.PLACEHOLDERS], samples: texts }));
console.log('probe_full frames', frames.length, 'text samples', texts.length);
await browser.close(); closeServer();
