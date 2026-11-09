// 舞台行为自检（无头 Chromium + GPU）：减少动态、禁用 WebGL、暂停 / 继续、改尺寸、鼠标目光、换场景过渡、销毁；
// 首帧后时间停住（与海报对齐）、“时”这一步的放大动作与拍点事件、上下文恢复不刷警告。
// 先从仓库根起服务：python3 -m http.server 8101 --bind 127.0.0.1
//   node site/dev/stage/check.mjs        截图在 out/dev-stage/shots/check-*.png
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';
import { chromeArgs } from './probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SHOTS = path.join(ROOT, 'out/dev-stage/shots');
const BASE = process.env.STAGE_BASE || 'http://127.0.0.1:8101/site/dev/stage/index.html';
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const ok = (name, pass, note) => { results.push({ name, pass, note }); console.log(`${pass ? '通过' : '失败'}  ${name}  ${note}`); };

async function open(browser, query, { w = 1440, h = 900, reduced = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('页面错误 ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/hero-poster/.test(m.text())) errors.push('控制台 ' + m.text().slice(0, 200)); });
  page.on('response', r => { if (r.status() >= 400 && !/hero-poster/.test(r.url())) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(`${BASE}?ui=0&${query}`);
  await page.waitForFunction(() => window.__ready !== undefined, null, { timeout: 120000 });
  return { ctx, page, errors };
}
const frames = page => page.evaluate(() => window.__stage.debug.info.frames);
const wait = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ args: chromeArgs() });

// ① 减少动态：只画一帧，不起循环；改层时补画一帧
{
  const { ctx, page, errors } = await open(browser, 'poster=0&reduced=1&scene=layers&layer=4');
  const f0 = await frames(page); await wait(1500); const f1 = await frames(page);
  await page.evaluate(() => window.__stage.setLayer(1)); await wait(300); const f2 = await frames(page);
  await page.evaluate(() => window.__stage.play()); await wait(600); const f3 = await frames(page);
  await page.screenshot({ path: path.join(SHOTS, 'check-reduced.png') });
  ok('减少动态', f0 >= 1 && f1 === f0 && f2 === f1 + 1 && f3 === f2 && !errors.length, `首帧后 ${f0}→${f1}（1.5 秒不变）；setLayer 补画 → ${f2}；play() 被忽略 → ${f3}；错误 ${errors.length}`);
  await ctx.close();
}

// ② 禁用 WebGL：createStage 返回 null，页面不报错
{
  const b2 = await chromium.launch({ args: [...chromeArgs(), '--disable-3d-apis', '--disable-webgl'] });
  const ctx = await b2.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${BASE}?ui=0&scene=hero`);
  await page.waitForFunction(() => window.__ready !== undefined, null, { timeout: 60000 });
  const r = await page.evaluate(() => [window.__ready, window.__stage]);
  ok('禁用 WebGL', r[0] === 'null' && r[1] === null && !errors.length, `__ready=${r[0]}，stage=${r[1]}，页面错误 ${errors.length}`);
  await b2.close();
}

// ③ 实时：暂停 / 继续、隐藏标签页、改尺寸、鼠标目光、换场景、销毁
{
  const { ctx, page, errors } = await open(browser, 'poster=0&scene=hero&layer=4');
  await wait(800);
  const a = await frames(page); await wait(500); const b = await frames(page);
  await page.evaluate(() => window.__stage.pause()); await wait(150); const c = await frames(page); await wait(600); const d = await frames(page);
  await page.evaluate(() => window.__stage.play()); await wait(500); const e = await frames(page);
  ok('暂停 / 继续', b > a + 10 && d === c && e > d + 10, `播放 0.5 秒 +${b - a} 帧；暂停 0.6 秒 +${d - c}；继续 0.5 秒 +${e - d}`);

  // 改尺寸：防抖后重建渲染目标，画布缓冲跟着变
  await page.setViewportSize({ width: 1000, height: 700 }); await wait(500);
  const db = await page.evaluate(() => ({ ...window.__stage.debug.info.drawingBuffer, pr: window.__stage.debug.info.pr }));
  ok('改尺寸', Math.abs(db.w - Math.round(1000 * db.pr)) <= 1 && Math.abs(db.h - Math.round(700 * db.pr)) <= 1, `1000×700 → 缓冲 ${db.w}×${db.h}（像素比 ${db.pr}）`);
  await page.setViewportSize({ width: 1440, height: 900 }); await wait(500);

  // 鼠标目光：指针在左上 / 右下时，金眼的朝向不同（取眼珠的世界朝向）
  const gaze = await page.evaluate(async () => {
    const S = window.__stage, kun = S.debug.kun, out = [];
    S.pause();
    for (const p of [[-1, 1], [1, -1]]) {
      S.debug.renderAt(5, { pointer: p });
      const e = kun.eyes.find(x => x.side === -1), q = e.ball.getWorldQuaternion(new (e.ball.quaternion.constructor)());
      const v = { x: 0, y: 0, z: 1 }; const { x, y, z, w } = q;          // 把 +Z 转到世界：眼珠的视线方向
      const ix = w * v.x + y * v.z - z * v.y, iy = w * v.y + z * v.x - x * v.z, iz = w * v.z + x * v.y - y * v.x, iw = -x * v.x - y * v.y - z * v.z;
      out.push([ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x].map(n => +n.toFixed(3)));
    }
    return out;
  });
  const dot = gaze[0].reduce((s, v, i) => s + v * gaze[1][i], 0);
  ok('鼠标目光', dot < 0.995, `指针左上 → 视线 ${gaze[0]}；右下 → ${gaze[1]}；夹角 ${(Math.acos(Math.min(1, dot)) * 180 / Math.PI).toFixed(1)}°`);
  for (const [n, p] of [['left', [-1, 0.6]], ['right', [1, -0.6]]]) {
    await page.evaluate(p => window.__stage.debug.renderAt(5, { pointer: p }), p);
    await page.screenshot({ path: path.join(SHOTS, `check-gaze-${n}.png`), clip: { x: 520, y: 300, width: 420, height: 260 } });
  }

  // 换场景：hero → layers 在 1.2 秒内平滑过渡（相机位置逐帧变化，没有跳变）
  await page.evaluate(() => window.__stage.play());
  const path2 = await page.evaluate(async () => {
    const S = window.__stage, cam = S.debug.camera, pts = [];
    S.setScene('layers', 0);
    const t0 = performance.now();
    await new Promise(done => (function tick() { pts.push([performance.now() - t0, cam.position.x, cam.position.y, cam.position.z]); if (performance.now() - t0 < 1600) requestAnimationFrame(tick); else done(); })());
    return pts;
  });
  let maxStep = 0, total = 0;
  for (let i = 1; i < path2.length; i++) { const s = Math.hypot(path2[i][1] - path2[i - 1][1], path2[i][2] - path2[i - 1][2], path2[i][3] - path2[i - 1][3]); maxStep = Math.max(maxStep, s); total += s; }
  ok('换场景过渡', path2.length > 30 && maxStep < total * 0.12, `${path2.length} 帧，相机总位移 ${total.toFixed(0)}，单帧最大 ${maxStep.toFixed(1)}（${(maxStep / total * 100).toFixed(1)}%）`);
  await page.screenshot({ path: path.join(SHOTS, 'check-layers-after-blend.png') });

  // 隐藏标签页：visibilitychange 时停循环
  const hid = await page.evaluate(async () => {
    const S = window.__stage;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    const f0 = S.debug.info.frames; await new Promise(r => setTimeout(r, 400)); const f1 = S.debug.info.frames;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 400)); const f2 = S.debug.info.frames;
    return [f0, f1, f2];
  });
  ok('标签页隐藏', hid[1] === hid[0] && hid[2] > hid[1] + 5, `隐藏 0.4 秒 +${hid[1] - hid[0]} 帧；恢复 0.4 秒 +${hid[2] - hid[1]}`);

  // 节奏：第 4 层鲲的姿态时间一拍三（每秒约 8 个不同值），墨线种子一拍二（约 12 个）；第 3 层姿态每帧都变
  const rhythm = await page.evaluate(async () => {
    const S = window.__stage, U = S.debug.kun.uniforms, C = S.debug.renderer;
    const sample = async layer => {
      S.setLayer(layer); await new Promise(r => setTimeout(r, 200));
      const ts = new Set(), n = { f: 0 };
      await new Promise(done => { const t0 = performance.now(); (function tick() { ts.add(U.uKunT.value.toFixed(5)); n.f++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else done(); })(); });
      return { poses: ts.size, frames: n.f };
    };
    const a = await sample(4), b = await sample(3);
    S.setLayer(4);
    return { l4: a, l3: b };
  });
  ok('一拍三 / 平滑', rhythm.l4.poses >= 7 && rhythm.l4.poses <= 10 && rhythm.l3.poses >= rhythm.l3.frames - 3, `第 4 层 1 秒 ${rhythm.l4.frames} 帧里姿态 ${rhythm.l4.poses} 个；第 3 层 ${rhythm.l3.frames} 帧里 ${rhythm.l3.poses} 个`);

  // 上下文丢失 / 恢复：派发 stage:lost / stage:restored，恢复后继续出帧
  const lost = await page.evaluate(async () => {
    const S = window.__stage, cv = document.getElementById('stage-canvas'), ev = [];
    cv.addEventListener('stage:lost', () => ev.push('lost')); cv.addEventListener('stage:restored', () => ev.push('restored'));
    const ext = S.debug.renderer.getContext().getExtension('WEBGL_lose_context');
    ext.loseContext(); await new Promise(r => setTimeout(r, 300));
    const f0 = S.debug.info.frames; await new Promise(r => setTimeout(r, 300)); const f1 = S.debug.info.frames;
    ext.restoreContext(); await new Promise(r => setTimeout(r, 1200));
    const f2 = S.debug.info.frames;
    return { ev, f0, f1, f2 };
  });
  await page.screenshot({ path: path.join(SHOTS, 'check-restored.png') });
  ok('上下文丢失 / 恢复', lost.ev.join() === 'lost,restored' && lost.f1 === lost.f0 && lost.f2 > lost.f1 + 10, `事件 ${lost.ev.join(' → ')}；丢失期间 +${lost.f1 - lost.f0} 帧；恢复后 1.2 秒 +${lost.f2 - lost.f1} 帧`);

  // 销毁：之后不再出帧、不报错
  const dis = await page.evaluate(async () => {
    const S = window.__stage; S.dispose();
    const f0 = S.debug.info.frames; await new Promise(r => setTimeout(r, 400)); return [f0, S.debug.info.frames];
  });
  ok('销毁', dis[0] === dis[1] && !errors.length, `销毁后 0.4 秒 +${dis[1] - dis[0]} 帧；页面错误 ${errors.length}${errors.length ? '：' + errors.join(' | ') : ''}`);
  await ctx.close();
}

// ④ 预热期间就销毁（createStage 刚返回、管线还在分帧预热）：不报错、不再出帧
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/hero-poster/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  await page.goto(`${BASE}?ui=0&poster=0&scene=hero`);
  await page.waitForFunction(() => window.__stage !== undefined, null, { timeout: 120000 });
  const r = await page.evaluate(async () => {
    const S = window.__stage; const warmBefore = S.debug.info.warmSteps.length; S.dispose();
    await new Promise(res => setTimeout(res, 1500));
    const ff = await S.firstFrame;
    return { warmBefore, frames: S.debug.info.frames, ff };
  });
  ok('预热中销毁', r.frames === 0 && r.ff.disposed && !errors.length, `销毁时预热到第 ${r.warmBefore} 步；之后出帧 ${r.frames}；firstFrame → ${JSON.stringify(r.ff)}；错误 ${errors.length}`);
  await ctx.close();
}

// ⑤ 首帧后时间先停 1 秒（交叉淡入期间与海报同一姿态）；“时”这一步动作放大、每拍派发 stage:beat；上下文恢复不刷警告
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const warns = [];
  page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') warns.push(m.text().slice(0, 160)); });
  await page.goto(`${BASE}?ui=0&poster=0&scene=hero`);
  await page.waitForFunction(() => window.__ready !== undefined, null, { timeout: 120000, polling: 100 });
  const hold = await page.evaluate(async () => {
    const S = window.__stage, ts = [];
    for (let i = 0; i < 6; i++) { ts.push(+S.debug.info.t.toFixed(3)); await new Promise(r => setTimeout(r, 150)); }
    await new Promise(r => setTimeout(r, 1500)); ts.push(+S.debug.info.t.toFixed(3));
    return ts;
  });
  ok('首帧后时间停住', hold.slice(0, 5).every(t => t === 0) && hold.at(-1) > 0.3, `首帧后每 0.15 秒：${hold.slice(0, 6).join(' ')}；再过 1.5 秒 t = ${hold.at(-1)}`);

  const fx = await page.evaluate(async () => {
    const S = window.__stage, ev = [];
    const on = e => ev.push(e.detail.frame);
    document.getElementById('stage-canvas').addEventListener('stage:beat', on);
    S.setScene('layers', 0.9); S.setLayer(4);
    await new Promise(r => setTimeout(r, 2500));
    const i0 = S.debug.info; ev.length = 0;
    await new Promise(r => setTimeout(r, 1000));
    const n = ev.length, mult3 = ev.every(f => f % 3 === 0);
    S.setLayer(3); await new Promise(r => setTimeout(r, 1500));
    const i1 = S.debug.info;
    document.getElementById('stage-canvas').removeEventListener('stage:beat', on);
    return { boost: +i0.boost.toFixed(2), flicks: i0.flicks.length, beats: n, mult3, boostBack: +i1.boost.toFixed(2) };
  });
  ok('时：放大动作与拍点', fx.boost > 0.95 && fx.flicks >= 1 && fx.beats >= 7 && fx.beats <= 9 && fx.mult3 && fx.boostBack < 0.05,
    `第 4 层放大量 ${fx.boost}、已甩尾 ${fx.flicks} 次；1 秒 stage:beat ${fx.beats} 次（帧号都是 3 的倍数：${fx.mult3}）；回到第 3 层放大量 ${fx.boostBack}`);

  const rest = await page.evaluate(async () => {
    const S = window.__stage, cv = document.getElementById('stage-canvas');
    const done = new Promise(r => cv.addEventListener('stage:restored', r, { once: true }));
    S.debug.loseContext(); await new Promise(r => setTimeout(r, 400)); S.debug.restoreContext();
    await Promise.race([done, new Promise(r => setTimeout(r, 15000))]);
    const f0 = S.debug.info.frames; await new Promise(r => setTimeout(r, 600));
    return { t: S.debug.info.t, more: S.debug.info.frames - f0 };
  });
  const bad = warns.filter(w => /does not belong to this context|INVALID_OPERATION/.test(w));
  ok('上下文恢复不刷警告', bad.length === 0 && rest.more > 10, `恢复后 0.6 秒 +${rest.more} 帧、t = ${rest.t.toFixed(2)}；“不属于此上下文”警告 ${bad.length} 条`);
  await ctx.close();
}

await browser.close();
const failed = results.filter(r => !r.pass).length;
console.log(failed ? `${failed} 项失败` : `全部 ${results.length} 项通过`);
process.exitCode = failed ? 1 : 0;
