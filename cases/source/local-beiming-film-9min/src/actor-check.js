// Local-only Canvas 2D smoke/contact sheet. No world renderer or remote GPU.
// Run: node src/actor-check.js [output-directory]; default /tmp/beiming-actor-check.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || '/tmp/beiming-actor-check');
await fs.mkdir(out, { recursive: true });
const html = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#1D2445;color:#E9DCC9;font:14px monospace}
main{display:grid;grid-template-columns:repeat(3,480px);gap:12px;padding:12px}
figure{margin:0}canvas{display:block;width:480px;height:260px;background:linear-gradient(#4F5BBF,#9C8FD8 46%,#F2A0A6 70%,#FFB26B)}
figcaption{height:28px;padding:6px 2px}
</style><main></main><script type="module">
const api = await import('/src/actors.js'); window.api = api;
window.cases = [
 ['profile',83.75,.6,{}],['deck',231,.5,{}],['helm',206,.5,{}],
 ['rope',18,.58,{}],['radio',128,.5,{talking:true}],['switch',366,.65,{lights:0}],
 ['glasses',318,.48,{}],['shell',533,.5,{}],['wake',528,.5,{}],
 ['profile',322,.5,{glasses:false,talking:true}],['switch',185,.15,{}],['glasses',335,.75,{}]
];
for(const [mode,t,progress,more] of window.cases){
 const f=document.createElement('figure'), c=document.createElement('canvas'), cap=document.createElement('figcaption');
 c.width=960;c.height=520; const g=c.getContext('2d');g.scale(.5,.5);
 api.drawActor(g,t,1920,1040,{mode,progress,...more});
 cap.textContent=mode+' / '+t+'s / p='+progress+(more.glasses===false?' / bare eye':'');
 f.append(c,cap);document.querySelector('main').append(f);
} window.READY=true;
</script>`;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    res.setHeader('Content-Type', 'text/javascript'); res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1488, height: 1224 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.READY, null, { timeout: 60000 });
  const report = await page.evaluate(() => {
    const { drawActor, ACTOR_MODES, actorLightState } = window.api;
    const c = document.createElement('canvas'); c.width = 480; c.height = 260;
    const g = c.getContext('2d', { willReadFrequently: true });
    let passed = 0, renders = 0; const fail = [];
    const check = (value, title) => { if (value) passed++; else fail.push(title); };
    const hash = () => {
      const d = g.getImageData(0, 0, c.width, c.height).data; let n = 2166136261, alpha = 0;
      for (let i = 0; i < d.length; i++) { n = Math.imul(n ^ d[i], 16777619); if (i % 4 === 3 && d[i]) alpha++; }
      return { hash: n >>> 0, alpha };
    };
    const render = (mode, t, opts = {}) => {
      g.reset();g.scale(.25,.25);drawActor(g,t,1920,1040,{mode,progress:.53,...opts});renders++;return hash();
    };
    for (const mode of ACTOR_MODES) {
      const a=render(mode,137.5); render('profile',529,{glasses:false}); const b=render(mode,137.5);
      check(a.hash===b.hash,mode+': frame-order determinism');
      check(a.alpha>40 && a.alpha<c.width*c.height*.95,mode+': nonempty transparent layer');
      check(b.hash===render(mode,137.5+1/24).hash,mode+': held two-frame pose');
      for (const t of [0,60,120,180,240,300,360,420,480,540]) check(render(mode,t).alpha>40,mode+': '+t+'s');
      // API must not clear a composited target and must preserve inherited state.
      g.reset();g.translate(7,9);g.scale(.23,.23);g.globalAlpha=.61;g.lineWidth=17;g.setLineDash([3,7]);
      const state=()=>JSON.stringify([Array.from(g.getTransform().toFloat64Array()),g.globalAlpha,g.lineWidth,g.getLineDash(),g.globalCompositeOperation]);
      const before=state(), clear=g.clearRect;g.clearRect=()=>{throw new Error('target cleared by '+mode)};
      drawActor(g,204,1920,1040,{mode,progress:.4,mirror:true});g.clearRect=clear;
      check(state()===before,mode+': caller state preserved');
    }
    const withGlass=render('profile',330), noGlass=render('profile',330,{glasses:false});
    check(withGlass.hash!==noGlass.hash,'glasses flag changes profile pixels');
    check([330,330.25,330.5,330.75].some(t=>render('profile',t,{talking:true}).hash!==render('profile',t,{talking:false}).hash),'subtle speech changes lip pixels across a phrase');
    check(render('rope',18,{progress:.58}).hash!==render('rope',18,{progress:.95}).hash,'rope tied/released differ');
    check(render('glasses',318,{progress:.48}).hash!==render('glasses',318,{progress:1}).hash,'glasses removed/worn differ');
    const lights=actorLightState(1,0);check(lights.cabin===0&&lights.red===1&&lights.green===1,'navigation lights survive blackout');
    // Verify actual navigation lamp pixels, not just the state helper.
    render('switch',370,{progress:1,lights:0});
    const pixel=(x,y)=>Array.from(g.getImageData(Math.round(x*.25),Math.round(y*.25),1,1).data);
    const red=pixel(960-218,572-49), green=pixel(960-73,572-49);
    check(red[0]>200&&red[1]<120&&red[3]===255,'red lamp visible at lights=0');
    check(green[1]>200&&green[0]<120&&green[3]===255,'green lamp visible at lights=0');
    // Actual 4K canvas, design-space transform inherited once.
    const hi=document.createElement('canvas');hi.width=3840;hi.height=2080;const hg=hi.getContext('2d');hg.scale(2,2);
    drawActor(hg,533,1920,1040,{mode:'shell'});
    check(hg.getImageData(1920,1040,1,1).data[3]>0,'4K design-space placement');
    return { passed, failures:fail, renders, navigationPixels:{red,green} };
  });
  await page.screenshot({ path: path.join(out, 'contact.png'), fullPage: true });
  const data = await page.evaluate(() => [...document.querySelectorAll('canvas')].map(c => c.toDataURL('image/png').split(',')[1]));
  for (const [i, name] of [[0,'profile'],[3,'rope'],[6,'glasses-removed'],[7,'shell'],[9,'profile-bare']]) {
    await fs.writeFile(path.join(out, name+'.png'), Buffer.from(data[i], 'base64'));
  }
  await fs.writeFile(path.join(out,'report.json'), JSON.stringify({...report, errors},null,2));
  console.log(JSON.stringify({...report,errors,output:out},null,2));
  if (errors.length || report.failures.length) process.exitCode=1;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
