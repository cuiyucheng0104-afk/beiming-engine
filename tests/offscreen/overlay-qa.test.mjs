// 离屏出片 M6 T3 单测：
// 1) engine/overlay（brush、kinetic、text）与 engine/paint/xuan 在离屏宿主里免 DOM 直接可用；
// 2) offscreen probe --events-out 导出纯离屏模块的 events.json 与 timeline.json；
// 3) tools/qa 的 texts 与 plates 在纯 backend=webgpu（无 index.html、设假 BEIMING_CHROME 证明零浏览器）下完整检出缺字、出画、时长、低对比度与底板露边/低密度。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadGpu } from '../../engine/offscreen/load.mjs';
import { createHost } from '../../engine/offscreen/host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OFFSCREEN_CLI = path.join(ROOT, 'engine/offscreen/cli.mjs');
const QA_CLI = path.join(ROOT, 'tools/qa/cli.mjs');
const TEST_PROFILES = path.join(ROOT, 'tests/qa/fixtures/profiles.json');
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

let gpu = null, skipReason = null;
try {
  await import('@napi-rs/canvas');
  gpu = await loadGpu();
  const h = await createHost({ gpu, width: 32, height: 32, fps: 24 });
  h.dispose();
} catch (e) {
  skipReason = e.message;
}

test('engine/overlay（brush、kinetic、text）与 engine/paint/xuan 在 A 路线 createFilm 离屏作品中直接可用且确定', { skip: skipReason || false }, async t => {
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, 'out/bm-ov-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const chFontsDir = path.join(ROOT, 'films/chendu/fonts');
  const filmModUrl = pathToFileURL(path.join(ROOT, 'engine/offscreen/film.mjs')).href;
  const lookModUrl = pathToFileURL(path.join(ROOT, 'engine/offscreen/tsl/look.js')).href;
  const canvasModUrl = pathToFileURL(path.join(ROOT, 'engine/offscreen/canvas.mjs')).href;
  const brushUrl = pathToFileURL(path.join(ROOT, 'engine/overlay/brush.js')).href;
  const kineticUrl = pathToFileURL(path.join(ROOT, 'engine/overlay/kinetic.js')).href;
  const textUrl = pathToFileURL(path.join(ROOT, 'engine/overlay/text.js')).href;
  const xuanUrl = pathToFileURL(path.join(ROOT, 'engine/paint/xuan.js')).href;

  const workFile = path.join(dir, 'offscreen.mjs');
  fs.writeFileSync(workFile, `
import { createFilm } from ${JSON.stringify(filmModUrl)};
import { createLook } from ${JSON.stringify(lookModUrl)};
import { loadFilmFonts } from ${JSON.stringify(canvasModUrl)};
import { buildBrushGlyph, paintBrushGlyph } from ${JSON.stringify(brushUrl)};
import { drawKinetic } from ${JSON.stringify(kineticUrl)};
import { createOverlay, measure } from ${JSON.stringify(textUrl)};
import { xuanPaper } from ${JSON.stringify(xuanUrl)};

export const EV = [{ id: 'ink-hit', frame: 4, t: 4 / 24 }];
export const TIMELINE = { fps: 24, sections: [{ id: 'A', in: 0, out: 12 }], cues: [{ id: 'ink-hit', frame: 4 }] };

export async function build({ THREE, TSL, renderer, width, height, fps, pipeline }) {
  const film = await createFilm({ THREE, TSL, renderer, pipeline, width, height });
  const fonts = await loadFilmFonts(${JSON.stringify(chFontsDir)});
  const fam = fonts.list.fonts[0].family;
  const fontSpec = \`400 36px "\${fam}"\`;

  const xuan = xuanPaper({ width: 64, height: 64, seed: 7 });
  const bg = buildBrushGlyph('渡', {
    font: fontSpec, size: 48,
    strokes: [[[-0.3, -0.3], [0.3, 0.3]]],
    span: [0, 0.8],
  });
  const ov = createOverlay({ halo: [0, 0, 0], glow: [255, 220, 160], fill: [20, 20, 30], ink: [240, 230, 210] });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b2430);
  const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 50);
  camera.position.set(0, 0, 4);
  const look = createLook({ THREE, TSL, renderer }, { width, height, ss: 1, msaa: 0 });

  const renderOverlay = (ctx, t) => {
    if (ov.draw) {
      ctx.drawImage(xuan, 8, 8, 32, 32);
      paintBrushGlyph(bg, Math.min(1, t + 0.4));
      ctx.drawImage(bg.out, 20, 16);
      drawKinetic(ctx, [{ ch: '晨', x: 90, y: 46 }], { effect: 'inkBleed', p: 0.85, font: fontSpec, size: 32, color: '#ffffff', seed: 3, blur: false });
    }
    const w = measure('晨', fontSpec);
    ov.glowText(ctx, '晨', 140, 48, fontSpec, [250, 245, 235], 1, 1, { halo: 0.2, glow: 0.2 });
    ov.rec('sub', '晨', 140, 18, 140 + Math.max(24, w), 52, 1, fontSpec);
  };

  return film.work({
    dur: 0.5, fps, look,
    shots: [{ in: 0, out: 12, shot: { scene, camera, update() {}, look: t => ({ t, kuwahara: false, outline: false, bloom: false }) } }],
    draw: (ctx, t) => renderOverlay(ctx, t),
    texts: t => ov.collect(() => renderOverlay(film.ctx, t)),
  });
}
`);

  const host = await createHost({ gpu, width: 240, height: 120, fps: 24 });
  try {
    const work = await host.load(workFile);
    const a = Buffer.from(await host.renderFrame(work, 4));
    const b = Buffer.from(await host.renderFrame(work, 4));
    assert.ok(a.equals(b), 'overlay + brush + kinetic + xuan 同帧渲染必须确定');
    const tx = work.texts(4);
    assert.equal(tx.length, 1);
    assert.equal(tx[0].text, '晨');
  } finally {
    host.dispose();
  }

  // 验证 offscreen probe --events-out
  const evDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-probe-ev-'));
  t.after(() => fs.rmSync(evDir, { recursive: true, force: true }));
  const pr = spawnSync(process.execPath, [OFFSCREEN_CLI, 'probe', workFile, '--events-out', evDir, '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(pr.status, 0, pr.stderr);
  const pj = JSON.parse(pr.stdout);
  assert.equal(pj.data.evCount, 1);
  assert.equal(pj.data.hasTimeline, true);
  const evOut = JSON.parse(fs.readFileSync(path.join(evDir, 'events.json'), 'utf8'));
  assert.equal(evOut.dur, 0.5);
  assert.equal(evOut.ev.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(evDir, 'timeline.json'), 'utf8')).cues.length, 1);
});

test('免浏览器 QA（texts + plates）：纯 backend=webgpu 作品在假 BEIMING_CHROME 下精准检出全部 5 类问题', { skip: !hasFfmpeg ? '没有 FFmpeg' : (skipReason || false) }, t => {
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const filmDir = fs.mkdtempSync(path.join(ROOT, 'out/bm-qa-offscreen-'));
  t.after(() => fs.rmSync(filmDir, { recursive: true, force: true }));

  // 复用 films/chendu/fonts（BM Text 子集含「 ·冥北样格片风」，不含「图」）与 plates-page/fade.png（256×128 左端直线淡出）
  fs.cpSync(path.join(ROOT, 'films/chendu/fonts'), path.join(filmDir, 'fonts'), { recursive: true });
  const fadePng = path.join(ROOT, 'tests/qa/fixtures/plates-page/fade.png');
  fs.mkdirSync(path.join(filmDir, 'plates'), { recursive: true });
  fs.copyFileSync(fadePng, path.join(filmDir, 'plates/fade.png'));
  fs.writeFileSync(path.join(filmDir, 'plates/plates.json'), JSON.stringify({
    plates: [{ name: 'fade', file: 'fade.png' }],
  }, null, 2));

  const filmModUrl = pathToFileURL(path.join(ROOT, 'engine/offscreen/film.mjs')).href;
  const lookModUrl = pathToFileURL(path.join(ROOT, 'engine/offscreen/tsl/look.js')).href;
  const platesModUrl = pathToFileURL(path.join(ROOT, 'engine/offscreen/tsl/plates.js')).href;
  const canvasModUrl = pathToFileURL(path.join(ROOT, 'engine/offscreen/canvas.mjs')).href;

  fs.writeFileSync(path.join(filmDir, 'offscreen.mjs'), `
import { createFilm } from ${JSON.stringify(filmModUrl)};
import { createLook } from ${JSON.stringify(lookModUrl)};
import { createPlates } from ${JSON.stringify(platesModUrl)};
import { loadFilmFonts } from ${JSON.stringify(canvasModUrl)};

export async function build({ THREE, TSL, renderer, width: W, height: H, fps, pipeline }) {
  const film = await createFilm({ THREE, TSL, renderer, pipeline, width: W, height: H });
  await loadFilmFonts(${JSON.stringify(path.join(filmDir, 'fonts'))});
  const P = await createPlates({ THREE, TSL });
  const { tex } = P.loadPlates(['fade'], { dir: ${JSON.stringify(path.join(filmDir, 'plates'))} });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x16181d);
  const camera = new THREE.OrthographicCamera(0, W, H, 0, -10, 10);
  // 256×128 的 fade.png 拉宽到 800 px 摆在下半幅（左端直线淡出在画内，贴图密度 ≈ 0.32 < 0.6 硬门；不挡上半幅文字）
  const pm = P.plate(tex.fade, 1, { opacity: 1 });
  pm.scale.set(800, 140, 1);
  pm.position.set(600, 70, 0);
  scene.add(pm);

  const look = createLook({ THREE, TSL, renderer }, { width: W, height: H, ss: 1, msaa: 0 });
  const font = '500 26px "BM Text"';
  const boxOf = (ctx, text, x, y) => {
    ctx.font = font;
    const m = ctx.measureText(text);
    const x0 = x - (m.actualBoundingBoxLeft ?? 0), y0 = y - (m.actualBoundingBoxAscent ?? 20);
    const bw = (m.actualBoundingBoxLeft ?? 0) + (m.actualBoundingBoxRight ?? m.width ?? 24);
    const bh = (m.actualBoundingBoxAscent ?? 20) + (m.actualBoundingBoxDescent ?? 6);
    return [x0, y0, bw, bh];
  };

  const itemsAt = f => {
    const list = [
      { id: 'ok', text: '北冥风格', x: 60, y: 70, alpha: 1, font, color: '#f4f1ea' },
      { id: 'out', text: '样片', x: -18, y: 125, alpha: 1, font, color: '#f4f1ea' },
      { id: 'lowc', text: '北冥风', x: 260, y: 125, alpha: 1, font, color: '#383d48' },
      { id: 'miss', text: '风图', x: 60, y: 180, alpha: 1, font, color: '#f4f1ea' },
    ];
    if (f >= 20 && f < 26) list.push({ id: 'short', text: '格', x: 360, y: 70, alpha: 1, font, color: '#f4f1ea' });
    return list;
  };

  return film.work({
    dur: 2, fps, look,
    shots: [{ in: 0, out: 48, shot: { scene, camera, update(t) { pm.position.set(600 - 20 * t, 70, 0); }, look: t => ({ t, kuwahara: false, outline: false, bloom: false, paper: false, vignette: 0, grain: 0 }) } }],
    draw(ctx, t) {
      const f = Math.min(Math.round(t * fps), 47);
      ctx.font = font;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      for (const it of itemsAt(f)) {
        ctx.fillStyle = it.color;
        ctx.fillText(it.text, it.x, it.y);
      }
    },
    texts(t) {
      const f = Math.min(Math.round(t * fps), 47);
      return itemsAt(f).map(it => ({ id: it.id, text: it.text, box: boxOf(film.ctx, it.text, it.x, it.y), alpha: it.alpha, font: it.font }));
    },
  });
}
`);

  fs.writeFileSync(path.join(filmDir, 'film.json'), JSON.stringify({
    schemaVersion: 2,
    id: 'qa-offscreen-fixture',
    title: '离屏 QA 夹具',
    route: 'a',
    backend: 'webgpu',
    output: { profile: 't-360p24', width: 640, height: 360, fps: 24, frameCount: 48 },
    shots: [{ id: 'S1', in: 0, out: 48 }],
    events: [],
    aigc: { contains: false, note: '测试夹具' },
    credits: [],
  }, null, 2));

  const noChromeEnv = { ...process.env, BEIMING_CHROME: '/nonexistent/should-never-launch-chrome' };
  const runQa = args => spawnSync(process.execPath, [QA_CLI, ...args, '--json'], { cwd: ROOT, env: noChromeEnv, encoding: 'utf8', timeout: 120000 });
  const getCheck = (env, id) => env.result.checks.find(c => c.id === id);
  const failedTargets = (env, id) => (getCheck(env, id)?.findings || []).filter(f => f.status === 'fail').map(f => f.target);

  const rt = runQa(['texts', '--film', filmDir, '--profiles-file', TEST_PROFILES]);
  assert.equal(rt.status, 4, rt.stderr);
  const tj = JSON.parse(rt.stdout);
  assert.equal(getCheck(tj, 'texts.contract').status, 'pass');
  assert.deepEqual(failedTargets(tj, 'texts.glyphs'), ['图']);
  assert.deepEqual(failedTargets(tj, 'texts.inframe'), ['out']);
  assert.deepEqual(failedTargets(tj, 'texts.safe-area'), ['out']);
  assert.deepEqual(failedTargets(tj, 'texts.duration'), ['short']);
  assert.deepEqual(failedTargets(tj, 'texts.contrast'), ['lowc']);
  const okFails = tj.result.checks.flatMap(c => (c.findings || []).filter(f => f.target === 'ok' && f.status === 'fail'));
  assert.deepEqual(okFails, [], '合格文字不应有硬失败');

  const rp = runQa(['plates', '--film', filmDir, '--profiles-file', TEST_PROFILES]);
  assert.equal(rp.status, 4, rp.stderr);
  const pj = JSON.parse(rp.stdout);
  assert.equal(getCheck(pj, 'plates.inventory').status, 'pass');
  assert.equal(getCheck(pj, 'plates.straight-fade').status, 'warn');
  assert.ok(getCheck(pj, 'plates.straight-fade').evidence.visible.some(v => v.plate === 'fade' && v.side === 'left'));
  assert.equal(getCheck(pj, 'plates.density').status, 'fail');
});
