// 逐帧采样画面里每个元素的状态（用真正的 render 代码），找出每个画面事件"到位"的那一帧 → out/probe.json
// 用法：node tools/probe.mjs   （LIB 环境变量或默认 @@LEMO_ROOT@@）
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = process.env.LIB || '@@LEMO_ROOT@@';
const { openDemo, closeServer } = await import(path.join(LIB, 'core/render/page.mjs'));
const { browser, page } = await openDemo(HERE, { q: 'ss=1' });
const FPS = 30, n = 20 * FPS;
const frames = await page.evaluate(n => { const out = []; for (let f = 0; f <= n; f++) out.push(window.PROBE(f / 30)); return out; }, n);
fs.writeFileSync(path.join(HERE, 'out', 'probe.json'), JSON.stringify(frames));
console.log('probe frames', frames.length);
await browser.close(); closeServer();
