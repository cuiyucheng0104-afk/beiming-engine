// engine/overlay 在浏览器里的回归测试：字体先登记再下载、下载期间 document.fonts.check 为 false、
// URL 含括号和引号也能加载、字体没就绪时 buildBrushGlyph 不会把后备字形算进去（R52）。
// 用法：node --test engine/overlay/overlay.test.mjs（需要 playwright-core 的无头 Chrome；起不来就跳过。BEIMING_CHROME 可指定浏览器）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FONT = fs.readFileSync(path.join(ROOT, 'fonts', 'MaShanZheng-400.woff2'));   // 只含“北冥”两个字的子集
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let browser = null, page = null, skip = false;
test.before(async () => {
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: process.env.BEIMING_CHROME || undefined });
  } catch (e) { skip = `启动不了无头 Chrome：${String(e.message).split('\n')[0]}`; return; }
  page = await browser.newPage();
  await page.route('http://bm.test/**', async route => {
    const p = decodeURIComponent(new URL(route.request().url()).pathname);
    if (p === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body></body>' });
    if (p.startsWith('/slow-font/')) { await sleep(700); return route.fulfill({ contentType: 'font/woff2', body: FONT }); }   // 慢慢下载的字体
    if (p.startsWith('/odd font/')) return route.fulfill({ contentType: 'font/woff2', body: FONT });                        // 路径里有空格、括号、引号
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
  });
  await page.goto('http://bm.test/');
});
test.after(async () => { if (browser) await browser.close(); });
const run = (t, fn, arg) => (skip ? t.skip(skip) : page.evaluate(fn, arg));

test('loadFonts：下载期间 document.fonts.check 为 false，下载完为 true（R52）', async t => {
  const r = await run(t, async () => {
    const { loadFonts } = await import('/engine/overlay/text.js');
    const spec = '400 40px "T Slow", sans-serif';
    const p = loadFonts([['T Slow', 'http://bm.test/slow-font/a.woff2', '400']]);
    await new Promise(res => setTimeout(res, 100));
    const during = document.fonts.check(spec, '北冥');
    await p;
    return { during, after: document.fonts.check(spec, '北冥') };
  });
  if (!r) return;
  assert.equal(r.during, false, '下载中 check 应为 false（字体要先登记进 document.fonts）');
  assert.equal(r.after, true);
});

test('loadFonts：URL 里有空格、括号、单双引号也能加载（R52）', async t => {
  const r = await run(t, async () => {
    const { loadFonts } = await import('/engine/overlay/text.js');
    try {
      await loadFonts([['T Odd', 'http://bm.test/odd font/a(1)\'s "x".woff2', '400']]);
      return { ok: document.fonts.check('400 40px "T Odd"', '北'), err: null };
    } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
  });
  if (!r) return;
  assert.equal(r.err, null);
  assert.equal(r.ok, true);
});

test('loadFonts：下载失败时报出字体名，且不在 document.fonts 里留下坏字体', async t => {
  const r = await run(t, async () => {
    const { loadFonts } = await import('/engine/overlay/text.js');
    let err = null;
    try { await loadFonts([['T Missing', 'http://bm.test/fonts/nope.woff2', '400']]); } catch (e) { err = String(e.message); }
    return { err, left: [...document.fonts].some(f => f.family.replace(/"/g, '') === 'T Missing') };
  });
  if (!r) return;
  assert.match(r.err || '', /T Missing/);
  assert.equal(r.left, false);
});

test('buildBrushGlyph：字体还在下载时直接报错，下载完正常预计算（R52）', async t => {
  const r = await run(t, async () => {
    const { loadFonts } = await import('/engine/overlay/text.js');
    const { buildBrushGlyph } = await import('/engine/overlay/brush.js');
    const o = { font: '400 64px "T Brush"', size: 64, strokes: [[[-0.2, 0], [0.2, 0]]], span: [0, 1] };
    const p = loadFonts([['T Brush', 'http://bm.test/slow-font/b.woff2', '400']]);
    await new Promise(res => setTimeout(res, 100));
    let during = null;
    try { buildBrushGlyph('北', o); during = '没有报错（把后备字体的字形算进去了）'; } catch (e) { during = 'threw'; }
    await p;
    const G = buildBrushGlyph('北', o);
    return { during, pixels: G.idx.length };
  });
  if (!r) return;
  assert.equal(r.during, 'threw');
  assert.ok(r.pixels > 100, `字形像素 ${r.pixels}`);
});
