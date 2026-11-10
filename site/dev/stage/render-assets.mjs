// 渲染舞台交付图（无头 Chromium + GPU 真渲，同一套实时代码），再交给 encode_assets.py 压成 JPG。
// 先从仓库根起服务：python3 -m http.server 8101 --bind 127.0.0.1
//   node site/dev/stage/render-assets.mjs [名字 ...]       不给名字就全部出
// 中间 PNG 在 out/dev-stage/assets-raw/，成品写到 site/assets/（hero-poster*.jpg、stage-*.jpg、og.jpg）。
// 环境变量：STAGE_BASE 换出图页地址（端口），STAGE_ASSETS_OUT 把成品写到别的目录（先出一份对比，确认再覆盖），
//           STAGE_RAW 换中间 PNG 的目录。
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';
import { chromeArgs } from './probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const RAW = process.env.STAGE_RAW ? path.resolve(process.env.STAGE_RAW) : path.join(ROOT, 'out/dev-stage/assets-raw');
const OUTDIR = process.env.STAGE_ASSETS_OUT ? path.resolve(process.env.STAGE_ASSETS_OUT) : path.join(ROOT, 'site/assets');
const BASE = process.env.STAGE_BASE || 'http://127.0.0.1:8101/site/dev/stage/capture.html';

// 拆层静帧的机位：画面居中（静帧单独成图，不需要给左侧文字让位），五张同一机位、同一时刻
const STILL = { ref: 16 / 9, fov: 30, ax: 0.0, ay: 0.08, size: 0.72, yaw: 0.42, pitch: 0.17, roll: 0 };
const T_STILL = 2;
// 分享图：首屏机位按 1200×630 稍微收一点（cover 裁切会切掉上下），左边留给题签和片名
const OG = { ref: 1200 / 630, fov: 30, ax: 0.40, ay: 0.16, size: 0.62, yaw: 27.5 * Math.PI / 180, pitch: 5.7 * Math.PI / 180, roll: 1.7 * Math.PI / 180 };
// “形”这张在页面上缩小到约一半显示（桌面静态版约 750 宽）：外轮廓按 2.2 倍线宽取样，压在半透明鳍上的线画实（FINAL-12）。
// 1440×900、像素比 1 的页面截图上量剪影边（每点取 3×3 里最暗的像素）对纸色的对比：鲲身中位 3.5:1 → 6.4:1、
// 鳍 2.7:1 → 6.3:1；≥ 3:1 的边界点鲲身 67% → 93%，鳍 42% → 94%
const FORM_LOOK = { outline: 2.2, lineK: 1, lineSolid: 1 };

const JOBS = [
  // 首屏海报：与实时第一帧同一机位、同一时刻（t = 0）、同一 lod（桌面 0.75）；按 1.5 倍像素渲，再缩到 1920×1080
  { name: 'hero-poster', vp: [1920, 1080], dsf: 1.5, q: 'scene=hero&layer=4&lod=0.75', call: ['frame', 0, { scene: 'hero', layer: 4 }], out: [1920, 1080], kb: 300 },
  // 竖屏海报（手机、竖拿的平板）：3:4 参考画幅（rig.js，FINAL-15），lod 与手机实时一致（0.3）。
  // 比 3:4 窄的竖屏只裁左右：390×844 上看到的是中间 887 像素宽、1920 高的一条，与以前 1080×1920 的清晰度相同
  { name: 'hero-poster-portrait', vp: [1440, 1920], dsf: 1, q: 'scene=hero&layer=4&lod=0.3', call: ['frame', 0, { scene: 'hero', layer: 4 }], out: [1440, 1920], kb: 300 },
  ...[['form', 0], ['shade', 1], ['look', 2], ['stage', 3]].map(([k, L]) => (
    { name: `stage-${k}`, vp: [1600, 900], dsf: 1.5, q: `scene=layers&layer=${L}&lod=0.75`, call: ['frame', T_STILL, { scene: 'layers', layer: L, tune: STILL, ...(k === 'form' ? { look: FORM_LOOK } : {}) }], out: [1600, 900], kb: 200 })),
  // 时：静帧表现不了步进，用洋葱皮——“时”这一步的放大动作（摆尾进行到约 0.78），当前姿态 + 往前三拍的姿态
  // （每拍隔 3 帧），淡叠在鲲身后。以前用的是平时的慢动作，和“景”那张几乎分不出来（平均像素差 0.9）
  { name: 'stage-time', vp: [1600, 900], dsf: 1.5, q: 'scene=layers&layer=4&lod=0.75', call: ['onion', T_STILL, { scene: 'layers', tune: STILL, step: 3, ghosts: [0.55, 0.36, 0.2], timeFx: { boost: 1, flicks: [T_STILL - 15 / 24] } }], out: [1600, 900], kb: 200 },
  // 分享图（FINAL-11 / ART-19）：首屏画面 + 与首屏同款的题签与墨色毛笔标题（capture.html 的 og）
  { name: 'og', vp: [1200, 630], dsf: 1.5, q: 'scene=hero&layer=4&lod=0.75', call: ['og', 0, { scene: 'hero', tune: OG, titleX: 0.065, titleY: 0.53, titleSize: 0.33, labelSize: 18 }], out: [1200, 630], kb: 250 },
];

const want = process.argv.slice(2);
const jobs = want.length ? JOBS.filter(j => want.includes(j.name)) : JOBS;
fs.mkdirSync(RAW, { recursive: true });

const browser = await chromium.launch({ args: chromeArgs() });
const report = [];
for (const j of jobs) {
  const ctx = await browser.newContext({ viewport: { width: j.vp[0], height: j.vp[1] }, deviceScaleFactor: j.dsf });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.error('[页面错误]', e.message); process.exitCode = 1; });
  page.on('console', m => { if (m.type() === 'error') console.error('[页面]', m.text().slice(0, 300)); });
  await page.goto(`${BASE}?${j.q}`);
  await page.waitForFunction(() => window.__ready !== undefined, null, { timeout: 120000 });
  if ((await page.evaluate(() => window.__ready)) !== true) throw new Error(`${j.name}：舞台不可用`);
  const [fn, t, o] = j.call;
  const url = await page.evaluate(async ([fn, t, o]) => await window.__capture[fn](t, o), [fn, t, o]);
  const info = await page.evaluate(() => window.__capture.info());
  const file = path.join(RAW, j.name + '.png');
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  report.push({ name: j.name, raw: path.relative(ROOT, file), canvas: info.canvas, gpu: info.gpu, lod: info.lod, triangles: info.triangles });
  console.log(`渲染 ${j.name}：画布 ${info.canvas.join('×')}，${info.gpu}，lod ${info.lod}，${info.triangles} 三角形`);
  await ctx.close();
}
await browser.close();

// 压成 JPG（Pillow：Lanczos 缩放 + 按体积上限二分质量）
fs.mkdirSync(OUTDIR, { recursive: true });
const spec = jobs.map(j => ({ name: j.name, raw: path.join(RAW, j.name + '.png'), out: path.join(OUTDIR, j.name + '.jpg'), size: j.out, kb: j.kb }));
const res = execFileSync('python3', [path.join(HERE, 'encode_assets.py'), JSON.stringify(spec)], { encoding: 'utf8' });
process.stdout.write(res);
