// A 模版的确定性回归（附录 C5：render(t) 必须确定）：node --test tests/style/template-determinism.test.mjs
// 同一页面里先渲 S1 的一帧、再渲 S2 的帧、再回到 S1 的同一帧，像素必须逐字节相同；S2 的帧同理。
// 守的是复核 must-1：两镜共用材质的日出受光边曾只在 S2 里改、S1 不复位，S1 的画面取决于此前渲过哪一帧 S2
// （正常出片时预热以最后一帧结束，S1 一直带着日出后的受光边）。完整的三种渲法比对用 P08 的 tools/baseline/determinism.mjs。
// 要浏览器（playwright-core 的 headless shell）、装了 fontTools 的 Python 与字体缓存（模版页面只认本片字体子集）；缺了就跳过并写明原因。
// 在仓库外搭小仓库（复制 engine/、routes/、tools/new-film.mjs 与 tools/lib，链接 node_modules、assets、fonts），不碰仓库里的 films/。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadLock, cacheStatus, cacheDir, findFontPython } from '../../tools/fonts/lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TPL = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes/a-webgl/template/film.json'), 'utf8'));
const node = (args, cwd) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: process.env, timeout: 120e3 });

test('模版 render(t) 与渲染历史无关：S1 的帧在渲过 S2 前后逐字节相同，S2 同理（需要浏览器、fontTools 与字体缓存）', { timeout: 300e3 }, async t => {
  const lock = loadLock(), cache = cacheDir(lock);
  const ready = cacheStatus(lock, cache, [...new Set(TPL.fonts.map(f => f.source))]).every(s => s.state === 'ok');
  let py = null;
  try { py = await findFontPython(); } catch { py = null; }
  if (!ready || !py) return t.skip(`跳过：${!ready ? `字体缓存 ${cache} 不全（node tools/fonts/fetch.mjs，或设 BEIMING_FONT_CACHE）` : '没有装了 fontTools 与 brotli 的 Python（npm run setup，或设 BEIMING_PYTHON）'}`);

  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-tpl-det-'));
  let film = null, page = null;
  try {
    for (const rel of ['engine', 'routes', 'tools/new-film.mjs', 'tools/lib', 'package.json']) fs.cpSync(path.join(ROOT, rel), path.join(d, rel), { recursive: true });
    for (const rel of ['node_modules', 'assets', 'fonts']) fs.symlinkSync(path.join(ROOT, rel), path.join(d, rel), 'junction');
    let r = node([path.join(d, 'tools/new-film.mjs'), 'a', 'det', '--title', '晨渡', '--quiet'], d);
    assert.equal(r.status, 0, `new-film：${r.stderr}`);
    const dir = path.join(d, 'films/det');
    r = node([path.join(ROOT, 'tools/fonts/subset.mjs'), dir, '--quiet'], ROOT);
    assert.equal(r.status, 0, `subset：${r.stderr}`);

    page = await import(pathToFileURL(path.join(d, 'engine/render/page.mjs')).href);   // 小仓库里的渲染器：静态服务器以小仓库为根
    try { film = await page.openFilm(dir, { w: 640, h: 360, handleSignals: false }); } catch (e) {
      if (/Executable doesn't exist|browserType\.launch/.test(e?.message)) return t.skip(`跳过：没有浏览器（npx playwright-core install chromium-headless-shell）：${e.message.split('\n')[0]}`);
      throw e;
    }
    const fps = TPL.output.fps, [S1, S2] = TPL.shots;
    const shot = async f => { await film.page.evaluate(x => window.render(x), f / fps); film.check(); return film.page.screenshot({ type: 'png' }); };
    const f1 = Math.round((S1.in + S1.out) * 2 / 3), fEarly = S2.in, fLate = S2.out - 2, f2 = Math.round((S2.in + S2.out) / 2);
    const a = await shot(f1);                    // 新页面：预热以最后一帧（日出之后）结束
    await shot(fEarly);                          // 切点后、日出之前
    const b = await shot(f1);
    await shot(fLate);                           // 日出之后
    const c = await shot(f1);
    assert.ok(a.equals(b) && b.equals(c), `S1 第 ${f1} 帧随渲染历史变了（共享材质的逐帧状态没有在每镜每帧写全）`);
    const p = await shot(f2);
    await shot(f1);
    await shot(fLate);
    assert.ok(p.equals(await shot(f2)), `S2 第 ${f2} 帧随渲染历史变了`);
  } finally {
    await film?.close().catch(() => {});
    await page?.closeServer().catch(() => {});
    fs.rmSync(d, { recursive: true, force: true });
  }
});
