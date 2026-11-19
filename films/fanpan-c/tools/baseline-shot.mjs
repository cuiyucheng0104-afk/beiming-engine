// 截一张游戏现在的对战盘做基线（对比图左上那一格）。只读游戏仓库，经它自带的本地服务：
// 先在游戏仓库里 python3 tools/serve.py 8771，再 node films/fanpan-c/tools/baseline-shot.mjs <输出目录>，得到 <输出目录>/now-1.png
import { chromium } from 'playwright-core';
import { chromeExecutable } from '../../../engine/render/page.mjs';
const out = process.argv[2];
const b = await chromium.launch({ executablePath: chromeExecutable?.(), args: ['--use-angle=default', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('console', m => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 200)); });
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
await p.goto('http://localhost:8771/board.html?timer&q=high&theme=f5', { waitUntil: 'load' });
await p.waitForTimeout(3000);
await p.click('#play').catch(e => console.log('click', String(e).slice(0, 120)));
await p.waitForTimeout(6000);
const r = await p.evaluate(async () => {
  const t = window.__t; const log = [];
  for (let i = 0; i < 8; i++) { try { await t.auto(); log.push('auto' + i); } catch (e) { log.push('x ' + e.message); break; } await new Promise(r => setTimeout(r, 2500)); }
  return { log, units: t.state()?.board?.filter(Boolean).length };
});
console.log(JSON.stringify(r));
await p.waitForTimeout(2500);
await p.screenshot({ path: out + '/now-1.png' });
await b.close();
