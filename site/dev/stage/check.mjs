// 舞台行为自检（无头 Chromium + GPU）：减少动态、禁用 WebGL、暂停 / 继续、改尺寸、鼠标目光、换场景过渡、销毁；
// 首帧后时间停住（与海报对齐）、“时”这一步的放大动作与拍点事件、上下文恢复不刷警告；
// 五层各自的画面、实时帧率、降档那一帧不闪空白（FINAL-10）、CPU 探针判档（Chrome 降速模拟，FINAL-16）。
// 先从仓库根起服务：python3 -m http.server 8101 --bind 127.0.0.1
//   node site/dev/stage/check.mjs [--skip-probe] [--only 6,8]     截图在 out/dev-stage/shots/check-*.png
// STAGE_BASE 换测试页地址（端口），STAGE_SHOTS 换截图目录。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';
import { chromeArgs } from './probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SHOTS = process.env.STAGE_SHOTS ? path.resolve(process.env.STAGE_SHOTS) : path.join(ROOT, 'out/dev-stage/shots');
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

// --only 1,8：只跑这几段（编号见各段注释）
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i < 0 ? null : new Set(process.argv[i + 1].split(',').map(Number)); })();
const want = n => !ONLY || ONLY.has(n);

const browser = await chromium.launch({ args: chromeArgs() });

// ① 减少动态：只画一帧，不起循环；改层时补画一帧
if (want(1)) {
  const { ctx, page, errors } = await open(browser, 'poster=0&reduced=1&scene=layers&layer=4');
  const f0 = await frames(page); await wait(1500); const f1 = await frames(page);
  await page.evaluate(() => window.__stage.setLayer(1)); await wait(300); const f2 = await frames(page);
  await page.evaluate(() => window.__stage.play()); await wait(600); const f3 = await frames(page);
  await page.screenshot({ path: path.join(SHOTS, 'check-reduced.png') });
  ok('减少动态', f0 >= 1 && f1 === f0 && f2 === f1 + 1 && f3 === f2 && !errors.length, `首帧后 ${f0}→${f1}（1.5 秒不变）；setLayer 补画 → ${f2}；play() 被忽略 → ${f3}；错误 ${errors.length}`);
  await ctx.close();
}

// ② 禁用 WebGL：createStage 返回 null，页面不报错
if (want(2)) {
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
if (want(3)) {
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
if (want(4)) {
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
if (want(5)) {
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

// ⑥ 五层：形（素模，纸色透出）→ 光（上色）→ 笔（落墨）→ 景（天空铺满）→ 时（同景，动作一拍三，见上面的节奏检查）
if (want(6)) {
  const { ctx, page, errors } = await open(browser, 'poster=0&scene=layers&progress=0.5&layer=4');
  await page.evaluate(() => window.__stage.firstFrame);
  const L = await page.evaluate(() => {
    const S = window.__stage, cv = document.getElementById('stage-canvas');
    S.pause();
    // 画布原尺寸读（缩小会把一两像素宽的墨线平均掉）；只数鲲身上不透明的像素：饱和度（上色）、亮度梯度（墨线）
    const W = cv.width, H = cv.height;
    const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
    const g = c2.getContext('2d', { willReadFrequently: true });
    const out = [];
    let kunMask = null;
    for (let x = 0; x <= 4; x++) {
      S.setLayer(x); S.debug.renderAt(2);
      g.clearRect(0, 0, W, H); g.drawImage(cv, 0, 0);
      const d = g.getImageData(0, 0, W, H).data;
      const lum = new Float32Array(W * H);
      let cover = 0;
      for (let p = 0, i = 0; p < W * H; p++, i += 4) {
        if (d[i + 3] > 127) cover++;
        lum[p] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      }
      if (x === 0) { kunMask = new Uint8Array(W * H); for (let p = 0; p < W * H; p++) kunMask[p] = d[p * 4 + 3] >= 250 ? 1 : 0; }
      let n = 0, sat = 0, grad = 0;
      for (let y = 1; y < H - 1; y++) for (let xx = 1; xx < W - 1; xx++) {
        const p = y * W + xx; if (!kunMask[p]) continue;
        const i = p * 4, r = d[i], gg = d[i + 1], b = d[i + 2], mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        n++; sat += mx > 0 ? (mx - mn) / mx : 0;
        grad += Math.abs(lum[p + 1] - lum[p - 1]) + Math.abs(lum[p + W] - lum[p - W]);
      }
      out.push({ layer: x, cover: +(cover / (W * H)).toFixed(3), sat: +(sat / n).toFixed(3), grad: +(grad / n).toFixed(4) });
    }
    return out;
  });
  await page.evaluate(() => { window.__stage.setLayer(0); window.__stage.debug.renderAt(2); });
  await page.screenshot({ path: path.join(SHOTS, 'check-layer-0-form.png') });
  const [f, s, k, j, t] = L;
  // 形：只有鲲（纸色透出）、几乎不饱和；光：上色；笔：墨线让鲲身上的亮度梯度明显变大；景、时：天空铺满
  const pass = f.cover < 0.6 && f.sat < 0.2 && s.sat > f.sat + 0.2 && k.grad > s.grad * 1.05 && j.cover > 0.99 && t.cover > 0.99 && !errors.length;
  ok('五层', pass, L.map(x => `第 ${x.layer} 层 覆盖 ${x.cover} 饱和 ${x.sat} 梯度 ${x.grad}`).join('；') + `；错误 ${errors.length}`);
  await ctx.close();
}

// ⑦ 实时帧率：1440×900 首屏第 4 层跑 5 秒，rAF 间隔中位数与 onStats 读数（Mac 有 GPU 时应 ≥ 50 fps）
if (want(7)) {
  const { ctx, page, errors } = await open(browser, 'poster=0&scene=hero&layer=4');
  await page.evaluate(() => window.__stage.firstFrame);
  await wait(1500);
  const r = await page.evaluate(async () => {
    const iv = []; let last = performance.now(); const s0 = window.__statsLog.length;
    await new Promise(done => { const end = last + 5000; (function tick(now) { iv.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else done(); })(last); });
    const st = window.__statsLog.slice(s0);
    return { iv: iv.slice(2).sort((a, b) => a - b), fps: st.map(s => s.fps), pr: [...new Set(st.map(s => s.pixelRatio))], gpu: st.at(-1)?.gpu };
  });
  const med = r.iv[r.iv.length >> 1], fps = 1000 / med;
  ok('实时帧率', fps >= 50 && !errors.length, `rAF 间隔中位 ${med.toFixed(1)} ms ≈ ${fps.toFixed(1)} fps；onStats ${r.fps.join(' ')}；像素比 ${r.pr.join(' / ')}；${r.gpu}`);
  await ctx.close();
}

// ⑧ 降档那一帧不闪空白（FINAL-10）：每帧在舞台画完之后（同一帧、同一个任务里）读一下画布，
//    再用一个每帧占住主线程 30 ms 的回调把帧间隔拖到 > 22 ms，等调节器降档。降档改像素比、改画布尺寸会清空绘图缓冲；
//    改尺寸发生在画完之后，这一帧就是空白的（浏览器会把它显示出来）
if (want(8)) {
  const { ctx, page, errors } = await open(browser, 'poster=0&scene=hero&layer=4');
  await page.evaluate(() => window.__stage.firstFrame);
  await wait(1800);                                    // 首帧后停 1 秒、再缓 0.6 秒
  const r = await page.evaluate(async () => {
    const S = window.__stage, cv = document.getElementById('stage-canvas');
    const W = 64, H = 36, c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
    const g = c2.getContext('2d', { willReadFrequently: true });
    const rows = []; let on = true;
    // rAF 回调按注册顺序执行：舞台的循环在上一帧开头就注册了下一帧，这里在本帧结尾注册，所以总在舞台画完之后读
    const probe = () => {
      const i = S.debug.info;
      g.clearRect(0, 0, W, H); g.drawImage(cv, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data; let a = 0;
      for (let k = 3; k < d.length; k += 4) a += d[k];
      rows.push({ step: i.step, pr: i.pr, frames: i.frames, alpha: +(a / (W * H * 255)).toFixed(3), w: cv.width });
      if (on) requestAnimationFrame(probe);
    };
    const slow = () => { const t = performance.now(); while (performance.now() - t < 30) { /* 占住主线程 */ } if (on) requestAnimationFrame(slow); };
    const step0 = S.debug.info.step;
    requestAnimationFrame(probe); requestAnimationFrame(slow);
    await new Promise(res => { const t0 = performance.now(); (function w() { if (S.debug.info.step >= step0 + 2 || performance.now() - t0 > 9000) res(); else setTimeout(w, 50); })(); });
    on = false;
    await new Promise(res => setTimeout(res, 200));
    return { step0, rows, log: S.debug.info.prLog };
  });
  const downs = r.rows.filter((x, i) => i > 0 && x.step > r.rows[i - 1].step);
  const blank = r.rows.filter(x => x.alpha < 0.5);
  const atDown = r.rows.filter((x, i) => i > 0 && x.step > r.rows[i - 1].step && x.alpha < 0.5);
  ok('降档那一帧不闪空白', downs.length >= 1 && blank.length === 0 && !errors.length,
    `取样 ${r.rows.length} 帧，降档 ${downs.length} 次（像素比 ${[...new Set(r.rows.map(x => x.pr))].join(' → ')}）；空白帧 ${blank.length}（降档那一帧 ${atDown.length}）；错误 ${errors.length}`);
  await ctx.close();

  // 高刷屏：舞台最多约 60 帧每秒，120 Hz 屏上隔一次 rAF 才画。改尺寸（这里用 debug.setPixelRatio 触发 resize）清空绘图缓冲之后，
  // 紧接着的那一次 rAF 必须重画，不能按节奏跳过，否则空白画布会被显示出来。无头浏览器只有 60 Hz，用一个 8.33 ms 一批的 rAF 模拟
  const c2 = await browser.newContext({ viewport: { width: 1200, height: 750 } });
  const p2 = await c2.newPage();
  const e2 = [];
  p2.on('pageerror', e => e2.push(e.message));
  await p2.addInitScript(() => {
    let q = [], id = 0, n = 0; const t0 = performance.now();
    window.requestAnimationFrame = cb => { q.push([++id, cb]); return id; };
    window.cancelAnimationFrame = h => { q = q.filter(([i]) => i !== h); };
    (function tick() {
      n++;
      const now = t0 + n * (1000 / 120), batch = q; q = [];
      for (const [, cb] of batch) { try { cb(now); } catch (e) { console.error(e); } }
      setTimeout(tick, Math.max(0, t0 + (n + 1) * (1000 / 120) - performance.now()));
    })();
  });
  await p2.goto(`${BASE}?ui=0&poster=0&scene=hero&layer=4`);
  await p2.waitForFunction(() => window.__ready !== undefined, null, { timeout: 120000 });
  await p2.evaluate(() => window.__stage.firstFrame);
  await wait(1500);
  const hz = await p2.evaluate(async () => {
    const S = window.__stage, frames = () => S.debug.info.frames, drew = [];
    const f0 = frames(); await new Promise(r => setTimeout(r, 1000)); const perSec = frames() - f0;
    for (let k = 0; k < 6; k++) {
      // 等到某一批 rAF 里舞台刚画完一帧，在下一批之前改像素比；再看紧接着那一批里舞台有没有画
      await new Promise(res => { let last = frames(); (function w() { requestAnimationFrame(() => { const f = frames(); if (f !== last) res(); else { last = f; w(); } }); })(); });
      const before = frames();
      S.debug.setPixelRatio(k % 2 ? 1.25 : 1);
      drew.push(await new Promise(res => requestAnimationFrame(() => res(frames() > before))));
    }
    return { perSec, drew };
  });
  ok('高刷屏改尺寸后立即重画', hz.perSec <= 70 && hz.drew.every(Boolean) && !e2.length,
    `模拟 120 Hz：1 秒画 ${hz.perSec} 帧（隔帧画）；改尺寸后紧接着的 rAF 重画 ${hz.drew.filter(Boolean).length}/${hz.drew.length} 次；错误 ${e2.length}`);
  await c2.close();
}

// ⑨ CPU 探针判档（FINAL-16）：Chrome 降速 1 / 2 / 3 / 4 / 6 倍，看探针读数、预估、判档值（× 1.2）与舞台的决定。
//    这只是在这台机器上模拟慢 CPU，不等于真机验证
if (want(9) && !process.argv.includes('--skip-probe')) {
  const rows = [];
  for (const rate of [1, 2, 3, 4, 6]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await page.goto(`${BASE}?ui=0&poster=0&scene=hero`);
    // 推迟建鲲时 createStage 要等访客停下来（needScroll 时还要先滚动），这里不等它：拿到决定就记下
    await page.waitForFunction(() => window.__ready !== undefined || (window.__stageEvents || []).some(e => e.type === 'stage:deferred' || e.type === 'stage:skipped'), null, { timeout: 120000 });
    const r = await page.evaluate(() => {
      const ev = (window.__stageEvents || []).find(e => e.type === 'stage:deferred' || e.type === 'stage:skipped');
      const i = window.__stage ? window.__stage.debug.info : null;
      return { ev: ev ? { type: ev.type, ...ev.detail } : null, info: i ? { probeMs: i.probeMs, estMs: i.estMs, judgeMs: i.judgeMs } : null };
    });
    const decision = r.ev ? (r.ev.type === 'stage:skipped' ? '不建（只留海报）' : r.ev.needScroll ? '推迟到滚动过、停下来再建' : '推迟到停下来再建') : '直接建';
    const est = r.ev?.estMs ?? r.info?.estMs, judge = r.ev?.judgeMs ?? r.info?.judgeMs;
    rows.push({ rate, decision, estMs: Math.round(est), judgeMs: Math.round(judge), probeMs: r.info ? +r.info.probeMs.toFixed(2) : +(est / 46).toFixed(2) });
    await ctx.close();
  }
  // 判档必须按判档值（预估 × 1.2）落在 300 / 500 / 800 三条线的哪一边
  const expect = j => (j > 800 ? '不建（只留海报）' : j > 500 ? '推迟到滚动过、停下来再建' : j > 300 ? '推迟到停下来再建' : '直接建');
  const consistent = rows.every(x => x.decision === expect(x.judgeMs) && Math.abs(x.judgeMs - x.estMs * 1.2) <= 2);
  ok('CPU 探针判档（降速模拟）', consistent && rows[0].decision === '直接建',
    rows.map(x => `${x.rate} 倍：探针 ${x.probeMs} ms，预估 ${x.estMs}，判档 ${x.judgeMs} → ${x.decision}`).join('；'));
}

await browser.close();
const failed = results.filter(r => !r.pass).length;
console.log(failed ? `${failed} 项失败` : `全部 ${results.length} 项通过`);
process.exitCode = failed ? 1 : 0;
