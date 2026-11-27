// V11：渲染期记录必须能替代 QA 的画面解码、浏览器和离屏重渲，但不能替代交付规格/音轨解码。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { haveFfmpeg, tmp, cleanup, clip, ffmpeg, qa, check, writeJson, ROOT, FIXTURES, TEST_PROFILES } from './helpers.mjs';
import { browserOk } from '../ci/browser.mjs';
import { RENDERER_DIRS, framemd5 } from '../render/helpers.mjs';
import { CHECKS } from '../../tools/qa/lib/checks.mjs';
import { parseVideoStreamSha256 } from '../../engine/render/lib/video-stream-hash.mjs';

const skip = !haveFfmpeg && '需要 FFmpeg ≥7';
const skipBrowser = skip || (!browserOk && '没有配置 Chromium');
const width = 640, height = 360, fps = 24, frameCount = 48;
const spec = { width, height, fps, frameCount };
const profile = ['--profile', 't-360p24', '--profiles-file', TEST_PROFILES];
const noCalls = { launch: 0, render: 0, offscreen: 0, luma: 0 };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
after(cleanup);

// 只在被测 QA 子进程旁听实际调用（不替换结果）。无记录的对照组验证计数器确实会动。
async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  const name = specifier === 'playwright-core' ? 'chromium' :
    /\/tools\/qa\/lib\/offscreen\.mjs$/.test(resolved.url) ? 'openOffscreen' :
    /\/tools\/qa\/lib\/frames\.mjs$/.test(resolved.url) ? 'streamLuma' :
    /\/tools\/qa\/lib\/page\.mjs$/.test(resolved.url) ? 'openPage' : null;
  if (!name) return resolved;
  const original = JSON.stringify(resolved.url + '?v11-original');
  const wrap = name === 'chromium' ? `const launch = real.launch.bind(real); real.launch = (...a) => { count('launch'); return launch(...a); }; export { real as chromium };` :
    name === 'openPage' ? `export async function openPage(...a) { const h = await real(...a); await h.page.exposeFunction('__v11Rendered', () => count('render')); await h.page.evaluate(() => { const render = window.render; window.render = async (...a) => { await window.__v11Rendered(); return render(...a); }; }); return h; }` :
    `export function ${name}(...a) { count('${name === 'streamLuma' ? 'luma' : 'offscreen'}'); return real(...a); }`;
  const src = `export * from ${original}; import {${name} as real} from ${original}; import {appendFileSync} from 'node:fs'; const count = k => appendFileSync(process.env.V11_CALLS, k+'\\n'); ${wrap}`;
  return { url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true };
}

function fixture(n = frameCount) {
  const repo = tmp(), film = join(repo, 'films/demo'), run = join(film, 'out/20261122-150000-abc0011');
  const work = join(run, 'work'), mp4 = join(run, 'master.mp4');
  for (const dir of [work, join(repo, 'engine'), join(repo, 'docs/quality')]) fs.mkdirSync(dir, { recursive: true });
  writeJson(join(repo, 'package.json'), { private: true, type: 'module' });
  writeJson(join(repo, 'docs/quality/known-issues.json'), { issues: [] });
  writeJson(join(film, 'film.json'), { schemaVersion: 2, id: 'demo', route: 'a', title: '零重渲夹具',
    output: { ...spec, frameCount: n, profile: 't-360p24' }, shots: [{ id: 'S1', in: 0, out: n }],
    events: [{ id: 'tone', frame: 12, audio: 'tone' }], aigc: { contains: false } });
  fs.writeFileSync(join(film, 'index.html'), `<script>window.DUR=${n / fps};window.TEXTS=()=>[];window.render=()=>{};window.READY=true</script>`);
  const calls = join(repo, 'calls'), hook = join(repo, 'count.mjs');
  fs.writeFileSync(hook, `export ${resolve.toString()}`);
  const register = `import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(hook).href)});`;
  const preload = '--import=data:text/javascript;base64,' + Buffer.from(register).toString('base64');
  function invoke(args, { browser = false } = {}) {
    fs.writeFileSync(calls, '');
    const r = qa([...args, ...profile], { cwd: repo, env: { V11_CALLS: calls,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '),
      ...(browser ? {} : { BEIMING_CHROME: join(repo, 'no-qa-browser') }) } });
    r.calls = { ...noCalls };
    for (const k of fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean)) r.calls[k]++;
    return r;
  }
  return { repo, film, run, work, mp4, invoke };
}
function code(r, want) { assert.equal(r.code, want, `${r.stderr}\n${JSON.stringify(r.env?.error)} ${JSON.stringify(r.env?.result?.summary)}`); }

function streamHash(mp4) {
  const { stdout } = ffmpeg(['-i', mp4, '-map', '0:v:0', '-c', 'copy', '-f', 'streamhash', '-hash', 'sha256', '-']);
  const hash = parseVideoStreamSha256(stdout);
  assert.ok(hash, `unexpected streamhash output: ${stdout}`);
  return hash;
}

async function visualRecord(mp4, n = frameCount, visual) {
  const { createVisualCollector, telemetrySize } = await import('../../engine/render/lib/visual-telemetry.mjs');
  const { w, h } = telemetrySize(width, height, n);
  const raw = execFileSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-i', mp4, '-map', '0:v:0', '-vf', `scale=${w}:${h}:flags=area,format=gray`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: width * height * frameCount });
  const size = w * h, collector = createVisualCollector({ width, height, fps, frames: n, visual });
  assert.equal(raw.length, size * n);
  // 第一个输入流故意断在一帧的像素中间；再检查第二块能接续该分析器。
  const cut = Math.min(17, n - 1);
  await collector.readChunk(Readable.from([raw.subarray(0, 13), raw.subarray(13, cut * size)]), cut);
  await collector.readChunk(Readable.from([raw.subarray(cut * size)]), n - cut);
  const hashes = Array.from({ length: n }, (_, f) => createHash('sha256').update(raw.subarray(f * size, (f + 1) * size)).digest('hex'));
  return { ...collector.finish(hashes), videoStreamSha256: streamHash(mp4) };
}

async function pageRecords(fix, bad = false) {
  const { mergePageQaChunks } = await import('../../engine/render/lib/page-qa.mjs');
  fs.copyFileSync(join(FIXTURES, 'plates-page/fade.png'), join(fix.film, 'fade.png'));
  const face = { family: 'Demo', weight: '500', status: 'loaded', style: 'normal', bin: fs.readFileSync(join(ROOT, 'fonts/Barlow-500.woff2')).toString('base64') };
  const item = { id: 'label', text: bad ? 'B' : '5', font: '500 20px Demo', box: [bad ? -4 : 80, 80, 16, 20], alpha: 1 };
  const [x,y,w,h] = item.box, box = [x,y,x+w,y+h];
  const z = bad ? 1 : 0.2;
  const plate = { file: 'films/demo/fade.png', iw: 256, ih: 128, flipY: true, wrapS: false, wrapT: false, crop: null,
    clip: [[-z,z,0,1],[z,z,0,1],[-z,-z,0,1],[z,-z,0,1]], uv: [[0,1],[1,1],[0,0],[1,0]], opacity: 1 };
  const part = (a,b) => ({ info: { hasTexts: true, dur: frameCount / fps, viewport: [width, height] }, fonts: { faces: [face], set: [], errors: [] }, three: '182', externalRequests: [], rows: Array.from({ length: b - a }, (_, i) => {
    const f = a + i, visible = !bad || (f >= 16 && f < 19);
    return { f, texts: visible ? [item] : [], textsError: null, runs: [], dom: [], plates: [plate],
      contrast: visible ? [{ id: item.id, text: item.text, box, via: 'text', separable: true, ratio: bad ? 1.2 : 12 }] : [] };
  }) });
  const records = mergePageQaChunks([part(0, 17), part(17, frameCount)], spec);
  const hash = streamHash(fix.mp4);
  for (const doc of Object.values(records)) doc.videoStreamSha256 = hash;
  return records;
}

function assert38(r) {
  const report = r.env.result;
  assert.deepEqual(report.skipped, []);
  assert.deepEqual(report.checks.map(c => c.id).sort(), Object.keys(CHECKS).sort());
  assert.equal(report.checks.length, 38);
  assert.deepEqual(report.checks.filter(c => c.evidence?.notRun || c.findings?.some(f => f.key === 'not-run')).map(c => c.id), []);
  assert.equal(check(r.env, 'sync.events').evidence.events[0].id, 'tone');
  assert.deepEqual(r.calls, noCalls);
}

test('V11：自动发现三份记录；38 项全部执行；显式覆盖不会吞掉越界、短字、缺字、低对比与过低贴图密度', { skip }, async () => {
  const fx = fixture();
  clip(fx.mp4, { size: `${width}x${height}`, rate: fps, dur: frameCount/fps, audio: "aevalsrc='0.125*sin(2*PI*440*t)*gte(t,0.5)':s=48000:d=2" });
  const telemetry = await visualRecord(fx.mp4);
  assert.deepEqual([telemetry.analysisWidth, telemetry.analysisHeight, telemetry.clearLuma], [telemetry.series.w, telemetry.series.h, 0]);
  writeJson(join(fx.work, 'telemetry.json'), telemetry);
  const good = await pageRecords(fx);
  for (const key of ['texts', 'plates']) writeJson(join(fx.work, key + '.json'), good[key]);
  const reportArgs = ['report', fx.mp4, '--no-sheet'];
  const auto = fx.invoke(reportArgs);
  code(auto, 0); assert38(auto);
  assert.equal(check(auto.env, 'texts.contrast').evidence.rows[0].ratio, 12);
  assert.equal(check(auto.env, 'texts.glyphs').status, 'pass');
  assert.ok(check(auto.env, 'plates.density').evidence.rows[0].texelPerPx > 1);
  assert.deepEqual(json(join(fx.run, 'qa/report.json')), auto.env.result);

  const manifest = json(join(fx.film, 'film.json'));
  manifest.events[0].frame -= 3;
  writeJson(join(fx.film, 'film.json'), manifest);
  const late = fx.invoke(reportArgs);
  code(late, 4); assert38(late);
  assert.deepEqual(late.env.result.summary.hardFailures, ['sync.events']);
  manifest.events[0].frame += 3;
  writeJson(join(fx.film, 'film.json'), manifest);

  const bad = await pageRecords(fx, true);
  const texts = writeJson(join(fx.repo, 'other-texts.json'), bad.texts), plates = writeJson(join(fx.repo, 'other-plates.json'), bad.plates);
  const telemetryFile = join(fx.work, 'telemetry.json');
  fs.renameSync(telemetryFile, join(fx.repo, 'other-telemetry.json')); fs.writeFileSync(telemetryFile, '{');
  const explicit = fx.invoke([...reportArgs, '--texts', texts, '--plates', plates, '--telemetry', join(fx.repo, 'other-telemetry.json')]);
  code(explicit, 4); assert38(explicit);
  assert.deepEqual(explicit.env.result.summary.hardFailures.sort(), ['texts.inframe', 'texts.safe-area', 'texts.duration', 'texts.contrast', 'texts.glyphs', 'plates.density'].sort());
  assert.deepEqual(check(explicit.env, 'texts.inframe').findings[0].frames, [16, 19]);
  assert.equal(check(explicit.env, 'texts.contrast').evidence.rows[0].ratio, 1.2);
  assert.equal(check(explicit.env, 'plates.density').evidence.rows[0].texelPerPx, 0.356);

  fs.writeFileSync(join(fx.film, 'offscreen.mjs'), 'throw new Error("QA 不得打开离屏宿主")');
  const viaRun = fx.invoke(['plates', '--film', fx.film, '--offscreen', '--run-dir', fx.run]);
  code(viaRun, 0); assert.deepEqual(viaRun.calls, noCalls);
  assert.deepEqual(check(viaRun.env, 'plates.density'), check(auto.env, 'plates.density'));
  for (const key of ['texts', 'plates', 'telemetry']) {
    const args = key === 'telemetry' ? ['visual', fx.mp4] : [key, '--film', fx.film];
    const missing = fx.invoke([...args, '--run-dir', fx.run, '--' + key, join(fx.repo, 'absent.json')]);
    code(missing, 2); assert.equal(missing.env.error.code, 'usage.no-file'); assert.deepEqual(missing.calls, noCalls);
  }
  for (const key of ['texts', 'plates']) {
    const other = key === 'texts' ? 'plates' : 'texts';
    const file = writeJson(join(fx.work, `${key}.json`), { ...good[key], videoStreamSha256: '0'.repeat(64) });
    const args = [...reportArgs, '--skip', `delivery,visual,sync,${other}`];
    const wrong = fx.invoke([...args, '--' + key, file]);
    code(wrong, 2); assert.match(wrong.env.error.code, /^usage\./); assert.deepEqual(wrong.calls, noCalls);
    const discovered = fx.invoke(args);
    assert.notEqual(discovered.code, 0, `不得用自动发现的异源 ${key}.json 放行`);
    const viaRun = fx.invoke([key, '--run-dir', fx.run]);
    assert.notEqual(viaRun.code, 0, `运行目录有 master.mp4 时也须核对 ${key} 的指纹`);
    writeJson(file, good[key]);
  }
});

test('V11：真实视觉记录与解码得同样黑场和静帧；缺失/损坏自动回退，坏显式记录不回退', { skip }, async () => {
  const fx = fixture();
  clip(fx.mp4, { size: `${width}x${height}`, dur: frameCount/fps, src: 'color=gray:s={S}:r={R}:d={D}', vf: "drawbox=color=black:t=fill:enable='lt(n,5)',lutyuv=y='clip(val+20,0,255)':enable='eq(n,25)'", audio: 'none' });
  const file = join(fx.work, 'telemetry.json'), args = ['visual', fx.mp4];
  const decoded = fx.invoke(args);
  code(decoded, 4); assert.equal(decoded.calls.luma, 1);
  for (const id of ['visual.black', 'visual.freeze', 'visual.flicker']) assert.equal(check(decoded.env, id).status, 'fail', id);
  const telemetry = await visualRecord(fx.mp4);
  writeJson(file, telemetry);
  const offline = fx.invoke([...args, '--telemetry', file]);
  code(offline, 4); assert.deepEqual(offline.calls, noCalls);
  assert.deepEqual(offline.env.result.visualSeries, decoded.env.result.visualSeries);
  for (const c of decoded.env.result.checks) assert.deepEqual(check(offline.env, c.id).findings, c.findings);

  for (const [why, damage] of [['坏 JSON', () => fs.writeFileSync(file, '{')],
    ['缺末帧哈希', () => writeJson(file, { ...telemetry, frameHashes: telemetry.frameHashes.slice(1) })],
    ['帧率不同', () => writeJson(file, { ...telemetry, fps: 25 })],
    ['原始画幅不同但分析尺寸相同', () => writeJson(file, { ...telemetry, width: 1280, height: 720 })],
    ['缺少码流指纹', () => writeJson(file, { ...telemetry, videoStreamSha256: undefined })],
    ['码流指纹格式错误', () => writeJson(file, { ...telemetry, videoStreamSha256: 'bad' })],
    ['统计越界', () => writeJson(file, { ...telemetry, series: { ...telemetry.series, blackRatio: telemetry.series.blackRatio.map(() => 2) } })]]) {
    damage();
    const auto = fx.invoke(args);
    code(auto, 4); assert.equal(auto.calls.luma, 1, why);
    assert.ok(auto.env.warnings.some(w => /遥测|telemetry/i.test(w)), why);
    assert.deepEqual(auto.env.result.visualSeries, decoded.env.result.visualSeries, why);
    const bad = fx.invoke([...args, '--telemetry', file]);
    code(bad, 2); assert.match(bad.env.error.code, /^usage\./, why); assert.deepEqual(bad.calls, noCalls);
  }
});

test('V11：只改 MP4 显示方向也必须重新分析画面', { skip }, async () => {
  const fx = fixture(12), original = join(fx.repo, 'original.mp4');
  clip(original, { size: `${width}x${height}`, dur: 12 / fps, audio: 'none' });
  const file = writeJson(join(fx.work, 'telemetry.json'), await visualRecord(original, 12));
  ffmpeg(['-display_rotation', '180', '-i', original, '-c', 'copy', fx.mp4]);
  assert.equal(streamHash(fx.mp4), streamHash(original));
  const args = ['visual', fx.mp4], auto = fx.invoke(args);
  assert.equal(auto.calls.luma, 1, '显示矩阵变化，旧像素坐标不能作证');
  assert.ok(auto.env.warnings.some(w => /显示矩阵/.test(w)));
  const explicit = fx.invoke([...args, '--telemetry', file]);
  code(explicit, 2); assert.match(explicit.env.error.code, /^usage\./);
});

test('V11：无底板页写空投影表，离线仍有采样帧数', async () => {
  const fx = fixture(3);
  const { mergePageQaChunks } = await import('../../engine/render/lib/page-qa.mjs');
  const rows = [0, 1, 2].map(f => ({ f, runs: [], dom: [], plates: [], contrast: [] }));
  const part = { rows, three: null, info: { hasTexts: true }, fonts: { faces: [], set: [], errors: [] }, externalRequests: [] };
  const { plates } = mergePageQaChunks([part], { ...spec, frameCount: rows.length });
  assert.deepEqual(plates.placements, []);
  if (haveFfmpeg) {
    writeJson(join(fx.work, 'plates.json'), plates);
    const r = fx.invoke(['plates', '--run-dir', fx.run]);
    code(r, 0); assert.deepEqual(r.calls, noCalls);
    assert.deepEqual(check(r.env, 'plates.inventory').evidence, { plates: [], frames: 3, projected: false });
  }
});

test('V11：纯离线读取也须核对页面记录与作品的帧数', { skip }, async () => {
  const fx = fixture(4);
  const { mergePageQaChunks } = await import('../../engine/render/lib/page-qa.mjs');
  const rows = [0, 1, 2].map(f => ({ f, texts: [], runs: [], dom: [], plates: [], contrast: [] }));
  const part = { rows, three: null, info: { hasTexts: true, dur: 3 / fps }, fonts: { faces: [], set: [], errors: [] }, externalRequests: [] };
  const records = mergePageQaChunks([part], { ...spec, frameCount: 3 });
  for (const key of ['texts', 'plates']) {
    const file = writeJson(join(fx.work, `${key}.json`), records[key]);
    const r = fx.invoke([key, '--film', fx.film, '--' + key, file]);
    code(r, 2); assert.match(r.env.error.code, /^usage\./); assert.deepEqual(r.calls, noCalls);
  }
});

test('V11：旧片无记录仍打开页面逐帧；浏览器不可用不算通过', { skip }, () => {
  const fx = fixture(3), args = ['texts', '--film', fx.film, '--run-dir', fx.run];
  const absent = fx.invoke(args);
  code(absent, 3); assert.equal(absent.calls.launch, 1);
  if (!skipBrowser) {
    const live = fx.invoke(args, { browser: true });
    code(live, 0); assert.equal(live.calls.launch, 1); assert.equal(live.calls.render, 3);
  }
});

for (const samples of [1, 2]) test(`V11：真实 video CLI 编码并采集（${samples} 次采样），QA 自动消费原始输出，报告复现 three 底板密度失败`, { skip: skipBrowser, timeout: 180000 }, async () => {
  const fx = fixture(24);
  // 真实渲染入口独立运行；临时仓库不提供 tools/qa 或 QA 的间接依赖。
  for (const dir of RENDERER_DIRS) fs.cpSync(join(ROOT, dir), join(fx.repo, dir), { recursive: true });
  fs.mkdirSync(join(fx.repo, 'engine/production'), { recursive: true });
  fs.copyFileSync(TEST_PROFILES, join(fx.repo, 'engine/production/profiles.json'));
  fs.symlinkSync(join(ROOT, 'node_modules'), join(fx.repo, 'node_modules'), 'junction');
  const page = samples === 2 ? join(fx.film, 'page') : fx.film;
  fs.mkdirSync(page, { recursive: true });
  const filmFile = join(fx.film, 'film.json'), manifest = json(filmFile);
  if (samples === 2) {
    manifest.qa = { visual: { blackPixel: 0.17 }, plates: { maxStdPx: 8, minCoverage: 0.4 } };
    writeJson(filmFile, manifest);
  }
  fs.copyFileSync(join(FIXTURES, 'plates-page/fade.png'), join(page, 'fade.png'));
  fs.copyFileSync(join(ROOT, 'fonts/Barlow-500.woff2'), join(page, 'demo.woff2'));
  const html = fs.readFileSync(join(FIXTURES, 'plates-page/index.html'), 'utf8');
  assert.ok(html.includes('window.TEXTS = () => [];'));
  fs.writeFileSync(join(page, 'index.html'), html.replace('window.TEXTS = () => [];', `
    const face = await new FontFace('Demo', 'url(./demo.woff2)', { weight:'500' }).load(); document.fonts.add(face);
    const overlay = document.createElement('canvas'); overlay.width = W; overlay.height = H;
    overlay.style.cssText='position:absolute;inset:0;z-index:2'; document.body.append(overlay);
    const c = overlay.getContext('2d'), baseRender = window.render, font='500 24px Demo';
    window.render = t => { baseRender(t); c.fillStyle='#222'; c.fillRect(48,48,56,40); c.font=font; c.fillStyle='#fff'; c.fillText('5',60,76); };
    window.TEXTS = () => [{ id:'digit', text:'5', box:[57,52,22,30], alpha:1, font }];`));
  const render = (out, extra = []) => {
    const r = spawnSync(process.execPath, [join(fx.repo, 'engine/render/video.mjs'), page, '--size', `${width}x${height}`, '--fps', String(fps), '--out', out, ...extra, '--workers', '2', '--chunk', '12', '--samples', String(samples), '--gpu', 'software-ok', '--angle', 'swiftshader', '--no-guard', '--progress', 'none', '--json'],
      { cwd: fx.repo, encoding: 'utf8', timeout: 90000 });
    assert.equal(r.status, 0, `${r.error || ''}\n${r.stderr}\n${r.stdout}`);
    return json(`${out}.run.json`);
  };
  const original = join(fx.run, 'baseline.mp4'), baseline = render(original);
  const captureArgs = ['--qa-records', fx.work, ...(samples === 2 ? ['--qa-film', filmFile, '--resume', '--keep-segments'] : [])];
  const captured = render(fx.mp4, captureArgs);
  if (samples === 2) {
    manifest.shots[0].evaluation = 'absolute';
    writeJson(filmFile, manifest);
    assert.equal(render(fx.mp4, captureArgs).render.reusedChunks, 0, '作品改了取样求值方式后须重新采集');
    assert.equal(render(fx.mp4, captureArgs).render.reusedChunks, 2, '求值方式相同可续用两个分片');
  }
  assert.deepEqual(captured.render.chunks, [[0, 12], [12, 24]]);
  assert.deepEqual(framemd5(fx.mp4), framemd5(original), '编码后逐帧像素不受采集影响');
  assert.deepEqual(captured.frameHashes.values, baseline.frameHashes.values, '采集前后逐帧像素一致');
  const telemetry = json(join(fx.work, 'telemetry.json'));
  assert.equal(telemetry.frameCount, 24);
  assert.equal(telemetry.frameHashes.length, 24);
  assert.ok(telemetry.frameHashes.every(h => /^[0-9a-f]{64}$/.test(h)));
  assert.deepEqual(telemetry.frameHashes.map(h => h.slice(0,16)), captured.frameHashes.values);
  const { loadProfiles, resolveProfile } = await import('../../tools/qa/lib/profiles.mjs');
  const { visual } = resolveProfile(loadProfiles({ file: TEST_PROFILES }), manifest.output.profile, manifest);
  assert.equal(telemetry.config.blackPixel, visual.blackPixel);
  const decoded = await visualRecord(fx.mp4, 24, visual);
  assert.deepEqual(telemetry.series, decoded.series, '分片采集对齐最终成片的逐帧解码统计');
  for (const key of ['telemetry', 'texts', 'plates']) {
    assert.equal(json(join(fx.work, `${key}.json`)).videoStreamSha256, decoded.videoStreamSha256, key);
  }
  if (samples === 2) {
    const record = json(join(fx.work, 'plates.json'));
    assert.deepEqual(record.images[0].analysis.options, manifest.qa.plates);
    fs.renameSync(join(page, 'fade.png'), join(page, 'fade-original.png'));
  }
  // video CLI 按约定出无声片，复制原视频流，加带第 12 帧起音的音轨供 sync 实测。
  const silent = join(fx.run, 'silent.mp4'); fs.renameSync(fx.mp4, silent);
  ffmpeg(['-i', silent, '-f', 'lavfi', '-i', "aevalsrc='0.33*sin(2*PI*440*t)*gte(t,0.5)':s=48000:d=1", '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', fx.mp4]);
  const report = fx.invoke(['report', fx.mp4, '--no-sheet']);
  code(report, 4); assert38(report);
  assert.equal(check(report.env, 'texts.glyphs').status, 'pass');
  const contrast = check(report.env, 'texts.contrast').evidence.rows[0];
  assert.equal(contrast.id, 'digit'); assert.ok(contrast.ratio > 4.5, JSON.stringify(contrast));
  assert.equal(check(report.env, 'plates.inventory').evidence.frames, 24);
  assert.equal(check(report.env, 'plates.straight-fade').status, 'warn');
  assert.equal(check(report.env, 'plates.density').evidence.rows[0].texelPerPx, 0.32);
  assert.equal(check(report.env, 'plates.density').status, 'fail');
});

test('V11-R2-Red：分片合并拒收重帧/缺帧，且被顶替成同规格全黑片的 master.mp4 不得借旧遥测蒙混通过 visual.black', { skip }, async () => {
  const { mergePageQaChunks } = await import('../../engine/render/lib/page-qa.mjs');
  const mkPart = frames => ({
    rows: frames.map(f => ({ f, runs: [], dom: [], plates: [], contrast: [] })),
    three: null,
    info: { hasTexts: true },
    fonts: { faces: [], set: [], errors: [] },
    externalRequests: [],
  });
  assert.throws(() => mergePageQaChunks([mkPart([0, 1]), mkPart([1, 3])], { ...spec, frameCount: 4 }), /帧|frame|连续/i);

  // 用全黑同规格成片顶替原成片（旧 work/telemetry.json 仍留在运行目录）：自动发现必须因码流指纹不符告警并回退真解码判黑场失败
  const fx = fixture(12);
  clip(fx.mp4, { size: `${width}x${height}`, dur: 12 / fps, audio: 'none' });
  const brightTelemetry = await visualRecord(fx.mp4, 12);
  const file = writeJson(join(fx.work, 'telemetry.json'), brightTelemetry);
  clip(fx.mp4, { size: `${width}x${height}`, dur: 12 / fps, src: 'color=black:s={S}:r={R}:d={D}', audio: 'none' });
  assert.notEqual(streamHash(fx.mp4), brightTelemetry.videoStreamSha256);
  const args = ['visual', fx.mp4, '--run-dir', fx.run];
  const r = fx.invoke(args);
  assert.equal(r.calls.luma, 1, '换片后必须重新解码画面');
  code(r, 4);
  assert.equal(check(r.env, 'visual.black').status, 'fail');
  assert.ok(r.env.warnings.some(w => /遥测|telemetry/i.test(w)));
  const explicit = fx.invoke([...args, '--telemetry', file]);
  code(explicit, 2); assert.match(explicit.env.error.code, /^usage\./); assert.deepEqual(explicit.calls, noCalls);
});
