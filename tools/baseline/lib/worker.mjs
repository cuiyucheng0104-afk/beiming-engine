#!/usr/bin/env node
// 北冥仓库 · 截帧子进程：打开一个页面（用「被测工作树」自己的 engine/render/page.mjs 的 openFilm，所以旧提交按旧渲染器渲），
// 按给定顺序调 window.render(t)，整页截 PNG（与 still / video 出片同一条截图路径），算像素哈希，写结果文件。
// 只由 tools/baseline/lib/capture.mjs 调用：node worker.mjs <spec.json>
//
// spec：{ tree, dir, pageId, query, perturb, w, h, clip, times, fps, outDir, resultFile, gpu, frameTimeoutMs, order, sequential }
//   order        'asc'（按时间升序，默认）| 'given'（按给的顺序）| 'shuffle:<种子>'（确定性乱序）
//   sequential   { from }：从 from 帧起逐帧 render 到最后一个要截的帧，只在要截的帧截图（模拟单 worker 顺序出片）
//   gpu          'required'（落到软件渲染即失败，exit 3）| 'any' | 'software-ok'
// 退出码：0 成功；1 页面报错 / 渲染失败；3 软件渲染被拒、缺浏览器；4 页面不满足约定（缺 DUR / render）；124 单帧超时
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { decodePNG, pixelSha256 } from './png.mjs';
import { resolveTimes, frameId, frameFile } from './sets.mjs';
import { backendOf, isSoftware } from './platform.mjs';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const result = { ok: false, groupId: spec.groupId, pageId: spec.pageId, renderer: null, browserVersion: null, DUR: null, frames: [], error: null };
const finish = (code, error = null) => {
  result.ok = code === 0;
  result.error = error;
  fs.writeFileSync(spec.resultFile, JSON.stringify(result, null, 1));
  process.exit(code);
};
// openFilm 的旧版本遇到页面错误会直接 process.exit(1)：退出前把已经截到的帧和原因写下来
process.on('exit', code => {
  if (!fs.existsSync(spec.resultFile)) {
    result.error = result.error || { code: 'page-error', message: `页面报错或渲染器退出（退出码 ${code}），详见上面的日志` };
    try { fs.writeFileSync(spec.resultFile, JSON.stringify(result, null, 1)); } catch { /* 退出途中 */ }
  }
});

function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const withTimeout = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`${what}超过 ${ms / 1000} 秒`), { timeout: true })), ms); })])
    .finally(() => clearTimeout(timer));
};

const pageMjs = path.join(spec.tree, 'engine/render/page.mjs');
if (!fs.existsSync(pageMjs)) finish(3, { code: 'no-renderer', message: `被测工作树里没有 engine/render/page.mjs：${spec.tree}` });
const { openFilm, closeServer } = await import(pathToFileURL(pageMjs).href);

let film;
try {
  // perturb 只加在网址上、不进帧编号：用来证明闸门对一个已知的小改动足够灵敏（compare --perturb），不能用于登记基线
  film = await openFilm(spec.dir, { w: spec.w, h: spec.h, query: [spec.query, spec.perturb].filter(Boolean).join('&') });
} catch (e) {
  const code = e?.exitCode === 2 ? 4 : /Executable doesn't exist|browserType\.launch/i.test(e?.message || '') ? 3 : 1;
  finish(code, { code: code === 3 ? 'no-browser' : 'open-failed', message: String(e?.message || e).split('\n')[0] });
}
const { page, browser } = film;
const close = async () => { try { await withTimeout(film.close ? film.close() : browser.close(), 10000, '关浏览器'); } catch { /* 已尽力 */ } try { await closeServer(); } catch { /* 无 */ } };

try {
  result.browserVersion = browser.version();
  result.renderer = film.gpu || await page.evaluate(() => {
    const g = document.createElement('canvas').getContext('webgl2');
    const e = g && g.getExtension('WEBGL_debug_renderer_info');
    return e ? String(g.getParameter(e.UNMASKED_RENDERER_WEBGL)) : '';
  });
  const backend = backendOf(result.renderer);
  if (spec.gpu === 'required' && isSoftware(backend)) {
    await close();
    finish(3, { code: 'software-fallback', message: `WebGL 落到了软件渲染（${result.renderer.slice(0, 90)}）`, hint: '检查 BEIMING_ANGLE 与显卡驱动；CI 与有意的软件渲染加 --gpu software-ok' });
  }
  const info = await page.evaluate(() => ({ DUR: window.DUR, render: typeof window.render, FPS: window.FPS ?? null }));
  if (!(typeof info.DUR === 'number' && Number.isFinite(info.DUR) && info.DUR > 0) || info.render !== 'function') {
    await close();
    finish(4, { code: 'page-contract', message: `页面不满足约定：window.DUR=${JSON.stringify(info.DUR)}，window.render 是 ${info.render}` });
  }
  result.DUR = info.DUR;
  result.pageFps = info.FPS;
  let entries = resolveTimes(spec.times, info.DUR, spec.fps);
  if (spec.order?.startsWith('shuffle:')) {
    const R = mulberry(Number(spec.order.slice(8)) || 1);
    entries = entries.slice();
    for (let i = entries.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [entries[i], entries[j]] = [entries[j], entries[i]]; }
  } else if (spec.order !== 'given') entries = entries.slice().sort((a, b) => a.t - b.t);
  fs.mkdirSync(spec.outDir, { recursive: true });

  const shoot = async e => {
    const id = frameId({ pageId: spec.pageId, query: spec.query, clip: spec.clip }, spec.w, spec.h, e);
    const png = await withTimeout(page.screenshot({
      type: 'png',
      ...(spec.clip ? { clip: { x: spec.clip[0], y: spec.clip[1], width: spec.clip[2], height: spec.clip[3] } } : {}),
    }), spec.frameTimeoutMs, `截图 ${id} `);
    const file = path.join(spec.outDir, frameFile(id));
    fs.writeFileSync(file, png);
    const img = decodePNG(png);
    result.frames.push({
      id, page: spec.pageId, t: e.t, ...(e.f != null ? { f: e.f } : {}), w: spec.w, h: spec.h,
      ...(spec.query ? { query: spec.query } : {}), ...(spec.clip ? { clip: spec.clip } : {}),
      width: img.width, height: img.height, file,
      pixelSha256: pixelSha256(img), pngSha256: crypto.createHash('sha256').update(png).digest('hex'), bytes: png.length,
    });
  };
  const render = async t => {
    await withTimeout(page.evaluate(x => window.render(x), t), spec.frameTimeoutMs, `render(${t}) `);
    film.check?.();
  };

  if (spec.sequential) {
    const want = new Map(entries.filter(e => e.f != null).map(e => [e.f, e]));
    if (want.size !== entries.length) throw new Error('顺序模式只接受整数帧（times.frames）');
    const last = Math.max(...want.keys());
    for (let f = spec.sequential.from; f <= last; f++) {
      await render(f / spec.fps);
      if (want.has(f)) await shoot(want.get(f));
    }
  } else {
    for (const e of entries) { await render(e.t); await shoot(e); }
  }
  await close();
  finish(0);
} catch (e) {
  await close();
  finish(e.timeout ? 124 : 1, { code: e.timeout ? 'timeout' : 'render-failed', message: String(e?.message || e).split('\n')[0] });
}
