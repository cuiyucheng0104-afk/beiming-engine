// 在真游戏里验场景：无头浏览器开一局《一步翻盘》、自动走几回合、截图。只读游戏，不改任何文件。
// 先在游戏仓库里起它自带的本地服务（python3 tools/serve.py 8770），再在北冥仓库根目录：
//   node films/fanpan-arenas/tools/shot.mjs <arena 名> [--turns 6] [--mobile] [--low] [--calm] [--tag 名字] [--port 8770] [--wait 毫秒] [--full] [--clean]
// <arena 名> 是游戏地址里 ?arena= 后面的名字（c、b、harvest、sea、forge、sky、chapel）；写 default 截游戏原来的场地。
// --clean：每张截图之外再存一张藏掉界面（手牌、记录面板、结算面板）的 <tag>-clean.png，只看场景本身。
// 产物：films/fanpan-arenas/out/shots/<arena 名>/<tag>.png（整屏 1280×720；--mobile 是 844×390），并打印 stats 和控制台报错。
// --full：自动把对面城堡血量改成 1 再打到分出胜负（看挨打 / 攻破），中途每隔几回合存一张。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../out/shots');
const argv = process.argv.slice(2), name = argv[0], flag = k => argv.includes('--' + k), opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
if (!name || name.startsWith('--')) { console.error('用法：node films/fanpan-arenas/tools/shot.mjs <arena 名> [--turns 6] [--mobile] [--low] [--calm] [--tag 名字] [--full]'); process.exit(2); }
const mobile = flag('mobile'), turns = +opt('turns', 6), port = opt('port', 8770), wait = +opt('wait', 600);
const tag = opt('tag', [mobile ? 'mobile' : 'desktop', flag('low') ? 'low' : 'high', flag('calm') ? 'calm' : '', flag('full') ? 'full' : ''].filter(Boolean).join('-'));
const dir = path.join(OUT, name); fs.mkdirSync(dir, { recursive: true });
const url = `http://localhost:${port}/board.html?${name === 'default' ? '' : `arena=${name}&`}timer=1&q=${flag('low') ? 'low' : 'high'}${mobile ? '&touch' : ''}${flag('calm') ? '&calm' : ''}`;
const browser = await chromium.launch({ args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--force-color-profile=srgb'] });
const page = await browser.newPage({ viewport: mobile ? { width: 844, height: 390 } : { width: 1280, height: 720 } });
const errs = []; page.on('console', m => { if (['error', 'warning'].includes(m.type())) errs.push(`[${m.type()}] ${m.text()}`); }); page.on('pageerror', e => errs.push(`[pageerror] ${e.message}`));
await page.addInitScript(() => { try { localStorage.setItem('yibu-fanpan.tutorial.v1', '1'); } catch {} });
await page.goto(url, { waitUntil: 'load' }); await page.waitForFunction(() => !!window.__t, null, { timeout: 20000 });
await page.waitForTimeout(800); await page.click('#play'); await page.waitForTimeout(2500);
const auto = n => page.evaluate(async ([n, wait]) => { for (let i = 0; i < n; i++) { if (window.__t.state().winner != null) return i; await window.__t.auto(); await new Promise(r => setTimeout(r, wait)); } return n; }, [n, wait]);
const HIDE = 'body *{visibility:hidden !important} #stage3d canvas{visibility:visible !important}';
const shot = async t => { const f = path.join(dir, t + '.png'); await page.screenshot({ path: f }); console.log('截图', f);
  if (flag('clean')) { const h = await page.addStyleTag({ content: HIDE }); await page.waitForTimeout(250); await page.screenshot({ path: path.join(dir, t + '-clean.png') }); await h.evaluate(e => e.remove()); } };
await auto(turns); await shot(tag);
if (flag('full')) {
  await page.evaluate(() => window.__t.setup(S => { S.base[1] = 2; S.base[0] = 3; })); await page.waitForTimeout(500);
  for (let k = 0; k < 40; k++) { const done = await page.evaluate(() => window.__t.state().winner != null); if (done) break; await auto(3); if (k % 3 === 0) await shot(`${tag}-${k}`); }
  await page.waitForTimeout(1800); await shot(`${tag}-end`);
}
const info = await page.evaluate(() => { const S = window.__t.state(); return { stats: window.__t.board.stats(), base: S.base, winner: S.winner, turn: S.n }; });
const gpu = await page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl2'), e = g?.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
console.log(JSON.stringify({ url, ...info, gpu }, null, 1)); console.log(errs.length ? '控制台报错 / 警告：\n' + errs.join('\n') : '控制台没有报错');
await browser.close(); process.exit(errs.some(e => !e.startsWith('[warning]')) || !String(info.stats.theme).includes(name === 'default' ? '' : 'arena-' + name) ? 1 : 0);
