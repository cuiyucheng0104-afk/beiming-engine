// serve.mjs 带声分轨调片预览外壳（?preview=1）契约与集成测试：
//   1. createServer 默认（无预览中间件）拒绝 POST（405），即便加 ?preview=1 也绝不改写 HTML 字节；
//   2. createPreviewMiddleware 下：不带 ?preview=1 的 HTML 逐字节原样返回，带 ?preview=1 才注入 preview-client.mjs；
//      Host 非本机回环返回 403；/_preview/state 越界路径返回 403，点目录返回 404；跨源 POST /_preview/rebuild 返回 403；
//   3. C 路线作品夹具：/_preview/state 识别 fps、frames、cuts、mixUrl 与 music/foley/amb 三条分轨；
//      POST /_preview/rebuild 经 film mix 快速重混声音并刷新 mtime 与 QA 摘要，并发重混返回 409 busy。
//   node --test tests/render/preview-serve.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../engine/render/lib/server.mjs';
import { createPreviewMiddleware, PREVIEW_SCRIPT_SRC, PREVIEW_SCRIPT_TAG } from '../../engine/render/lib/preview.mjs';
import { browserOk } from '../ci/browser.mjs';
import { ffmpegBins } from '../../tools/env/lib/ffmpeg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function findVenvDir(repoRoot) {
  const direct = path.join(repoRoot, '.venv');
  if (fs.existsSync(direct)) return direct;
  const g = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' });
  if (g.status === 0 && g.stdout.trim()) {
    const commonDir = path.resolve(repoRoot, g.stdout.trim());
    const mainWorktreeVenv = path.join(path.dirname(commonDir), '.venv');
    if (fs.existsSync(mainWorktreeVenv)) return mainWorktreeVenv;
  }
  return null;
}

function makeWavHeader(numSamples = 480, sampleRate = 48000, numChannels = 2) {
  const bytesPerSample = 2;
  const dataBytes = numSamples * numChannels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  buf.writeUInt16LE(numChannels * bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

function request(port, reqPath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, raw, text: raw.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('Test 1：默认 createServer({ root })（无预览中间件）拒绝 POST（405），且 ?preview=1 也绝不改动 HTML 字节', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-prev-t1-')));
  const exactHtml = '<!doctype html>\n<html><head><meta charset="utf-8"></head><body><h1>Raw</h1>\n</body></html>\n';
  try {
    fs.writeFileSync(path.join(root, 'index.html'), exactHtml, 'utf8');
    const srv = createServer({ root });
    const { port } = await srv.listen(0);
    try {
      const postRes = await request(port, '/_preview/rebuild?dir=.', { method: 'POST' });
      assert.equal(postRes.status, 405);
      assert.equal(postRes.headers.allow, 'GET, HEAD');

      const getPlain = await request(port, '/index.html');
      assert.equal(getPlain.status, 200);
      assert.deepEqual(getPlain.raw, Buffer.from(exactHtml, 'utf8'));

      const getPreview = await request(port, '/index.html?preview=1');
      assert.equal(getPreview.status, 200);
      assert.deepEqual(getPreview.raw, Buffer.from(exactHtml, 'utf8'), '无预览中间件时 ?preview=1 不得改写任何字节');
      assert.equal(getPreview.text.includes('preview-client.mjs'), false);
    } finally {
      await srv.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Test 2：启用 createPreviewMiddleware 时，无 ?preview=1 返回原始字节，带 ?preview=1 注入客户端模块；Host / 路径越界拦截有效', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-prev-t2-')));
  const exactHtml = '<!doctype html>\n<html lang="zh"><head><meta charset="utf-8"></head><body><canvas id="c"></canvas></body></html>';
  const fragHtml = '<canvas id="frag"></canvas>';
  try {
    fs.writeFileSync(path.join(root, 'index.html'), exactHtml, 'utf8');
    fs.mkdirSync(path.join(root, 'films', 'frag'), { recursive: true });
    fs.writeFileSync(path.join(root, 'films', 'frag', 'index.html'), fragHtml, 'utf8');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n', 'utf8');

    const srv = createServer({ root, middleware: createPreviewMiddleware({ root, repoRoot: ROOT }) });
    const { port } = await srv.listen(0);
    try {
      // 无 ?preview=1：逐字节完全一致
      const rawRes = await request(port, '/index.html');
      assert.equal(rawRes.status, 200);
      assert.deepEqual(rawRes.raw, Buffer.from(exactHtml, 'utf8'));

      const dirRawRes = await request(port, '/films/frag/');
      assert.equal(dirRawRes.status, 200);
      assert.deepEqual(dirRawRes.raw, Buffer.from(fragHtml, 'utf8'));

      // preview=0 也不得注入
      const previewZero = await request(port, '/index.html?preview=0');
      assert.deepEqual(previewZero.raw, Buffer.from(exactHtml, 'utf8'));

      // 明确带 ?preview=1：在 </body> 前注入 preview-client.mjs；无 </body> 则追加在末尾
      const injRes = await request(port, '/index.html?preview=1');
      assert.equal(injRes.status, 200);
      assert.match(injRes.headers['content-type'] || '', /^text\/html;\s*charset=utf-8$/i);
      assert.ok(injRes.text.includes(`${PREVIEW_SCRIPT_TAG}</body>`), '应在 </body> 之前注入 preview-client.mjs');

      const fragInj = await request(port, '/films/frag/?preview=1');
      assert.equal(fragInj.status, 200);
      assert.equal(fragInj.text, `${fragHtml}${PREVIEW_SCRIPT_TAG}`);

      // 客户端脚本自身可直接访问，且不含任何外网 CDN 链接
      const clientJs = await request(port, PREVIEW_SCRIPT_SRC);
      assert.equal(clientJs.status, 200);
      assert.match(clientJs.headers['content-type'] || '', /^text\/javascript/);
      assert.doesNotMatch(clientJs.text, /jsdelivr|unpkg|googleapis|https?:\/\//i);

      // 安全边界：DNS 重绑定 Host、目录越界、隐藏点目录、跨源 POST 一律拦截
      const badHost = await request(port, '/index.html?preview=1', { headers: { Host: 'evil.com' } });
      assert.equal(badHost.status, 403);

      const badHostState = await request(port, '/_preview/state?dir=.', { headers: { Host: `evil.com:${port}` } });
      assert.equal(badHostState.status, 403);

      const traversal = await request(port, '/_preview/state?dir=../../etc');
      assert.equal(traversal.status, 403);

      const encodedTraversal = await request(port, '/_preview/state?dir=%2e%2e/%2e%2e/etc');
      assert.equal(encodedTraversal.status, 403);

      const dotDir = await request(port, '/_preview/state?dir=.git');
      assert.equal(dotDir.status, 404);

      const badOrigin = await request(port, '/_preview/rebuild?dir=.', {
        method: 'POST',
        headers: { Origin: 'http://evil.com' },
      });
      assert.equal(badOrigin.status, 403);

      // 仓库根样片镜像（dir=. 且根下无 film.json 时回退读 films/beiming-10s/film.json + out/mix.wav + audio/stems/*.wav）
      fs.mkdirSync(path.join(root, 'films', 'beiming-10s'), { recursive: true });
      fs.writeFileSync(path.join(root, 'films', 'beiming-10s', 'film.json'), JSON.stringify({
        schemaVersion: 2,
        id: 'beiming-10s',
        title: '北冥',
        route: 'a',
        output: { profile: 'beiming-1040p24', width: 1920, height: 1040, fps: 24, frameCount: 240 },
        shots: [{ id: 'A', in: 0, out: 72 }, { id: 'B', in: 72, out: 120 }, { id: 'C', in: 120, out: 240 }],
      }), 'utf8');
      fs.mkdirSync(path.join(root, 'out'), { recursive: true });
      fs.mkdirSync(path.join(root, 'audio', 'stems'), { recursive: true });
      fs.writeFileSync(path.join(root, 'out', 'mix.wav'), makeWavHeader(480));
      fs.writeFileSync(path.join(root, 'audio', 'stems', 'amb.wav'), makeWavHeader(480));
      fs.writeFileSync(path.join(root, 'audio', 'stems', 'ui.wav'), makeWavHeader(480));
      const rootState = JSON.parse((await request(port, '/_preview/state?dir=.')).text);
      assert.equal(rootState.title, '北冥');
      assert.equal(rootState.frames, 240);
      assert.deepEqual(rootState.cuts, [72, 120]);
      assert.match(rootState.mixUrl, /^\/out\/mix\.wav\?v=\d+$/);
      assert.deepEqual(Object.keys(rootState.stems).sort(), ['amb', 'ui']);
    } finally {
      await srv.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const { ffmpeg, ffprobe } = ffmpegBins(process.env);
const hasBin = bin => spawnSync(bin, ['-version'], { encoding: 'utf8' }).status === 0;
const venvDir = findVenvDir(ROOT);
const venvPy = venvDir
  ? (process.platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python'))
  : null;
const pyProbeEnv = venvPy && fs.existsSync(venvPy) ? { ...process.env, BEIMING_PYTHON: venvPy } : process.env;
const hasPyAudio = spawnSync(process.execPath, [path.join(ROOT, 'tools/env/py.mjs'), '-c', 'import numpy, scipy, numba, soundfile, soxr, PIL'], {
  cwd: ROOT,
  env: pyProbeEnv,
  encoding: 'utf8',
}).status === 0;
const rebuildSkip = !hasPyAudio
  ? '缺少 Python 音频依赖（.venv）'
  : (!hasBin(ffmpeg) || !hasBin(ffprobe) ? '缺少 ffmpeg / ffprobe' : (!browserOk ? '缺少 Playwright 无头浏览器' : false));

test('Test 3：C 路线作品夹具状态探测（fps / frames / cuts / mixUrl / 3 条分轨）与 POST /_preview/rebuild 重混刷新 mtime', { timeout: 180_000 }, async t => {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-prev-t3-')));
  try {
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(sandbox, 'package.json'));
    for (const rel of ['routes', 'engine', 'tools']) {
      if (fs.existsSync(path.join(ROOT, rel))) {
        fs.cpSync(path.join(ROOT, rel), path.join(sandbox, rel), {
          recursive: true,
          filter: src => !/[\\/]__pycache__$/.test(src),
        });
      }
    }
    for (const rel of ['node_modules', 'assets', 'fonts']) {
      if (fs.existsSync(path.join(ROOT, rel))) {
        fs.symlinkSync(path.join(ROOT, rel), path.join(sandbox, rel), process.platform === 'win32' ? 'junction' : 'dir');
      }
    }
    if (venvDir && !fs.existsSync(path.join(sandbox, '.venv'))) {
      fs.symlinkSync(venvDir, path.join(sandbox, '.venv'), process.platform === 'win32' ? 'junction' : 'dir');
    }

    const filmRel = 'films/c-preview-fixture';
    const filmDir = path.join(sandbox, filmRel);
    const outDir = path.join(filmDir, 'out');
    const stemsDir = path.join(outDir, 'stems');
    fs.mkdirSync(stemsDir, { recursive: true });

    const filmJson = {
      schemaVersion: 2,
      id: 'c-preview-fixture',
      title: '分轨预览测试片',
      route: 'c',
      backend: 'canvas',
      output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 48 },
      shots: [
        { id: 'S1', in: 0, out: 24, name: '起笔' },
        { id: 'S2', in: 24, out: 48, name: '落印' },
      ],
      events: [
        { id: 'ink-touch', frame: 6, shot: 'S1', visual: 'stroke', desc: '起笔触纸' },
        { id: 'seal-land', frame: 30, shot: 'S2', visual: 'seal', desc: '朱印落定' },
      ],
      audio: { mode: 'script', script: 'mix.py', targetLUFS: -14, truePeakDbTP: -1.0 },
      deliveries: ['web-1080p24'],
      credits: [{ what: '测试夹具画面与合成声', owner: '北冥引擎', license: 'MIT', source: 'films/c-preview-fixture/index.html' }],
      aigc: { contains: false, note: '纯程序化测试夹具' },
      gates: { look: 'required', animatic: 'required', final: 'required' },
      dur: 2,
      fps: 24,
      size: [1920, 1080],
    };
    fs.writeFileSync(path.join(filmDir, 'film.json'), JSON.stringify(filmJson, null, 2) + '\n', 'utf8');

    // 页面约定 v1 最小合规页
    fs.writeFileSync(path.join(filmDir, 'index.html'), [
      '<!doctype html>',
      '<html lang="zh"><head><meta charset="utf-8"><title>分轨预览测试片</title></head>',
      '<body><canvas id="c" width="1920" height="1080"></canvas>',
      '<script type="module">',
      'const cv = document.getElementById("c"), gx = cv.getContext("2d");',
      'window.FPS = window.__RENDER?.fps ?? 24;',
      'window.DUR = 2;',
      'window.TIMELINE = { fps: 24, frameCount: 48, shots: [{ id: "S1", in: 0, out: 24 }, { id: "S2", in: 24, out: 48 }] };',
      'window.EV = [{ t: 0.25, cue: "ink-touch" }, { t: 1.25, cue: "seal-land" }];',
      'window.TEXTS = () => [];',
      'window.LAST_RENDER_T = 0;',
      'window.render = t => { window.LAST_RENDER_T = t; gx.fillStyle = "#18202c"; gx.fillRect(0, 0, cv.width, cv.height); };',
      'window.render(0);',
      'window.READY = true;',
      '</script></body></html>',
    ].join('\n'), 'utf8');

    // 2 秒（48 帧 @ 24fps）合规声音脚本：生成满足 -14 LUFS / <= -1.0 dBTP 的 mix.wav 与 music/foley/amb 三条分轨
    fs.writeFileSync(path.join(filmDir, 'mix.py'), [
      '# -*- coding: utf-8 -*-',
      'import os, sys',
      'import numpy as np',
      'import soundfile as sf',
      'ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))',
      'sys.path.insert(0, ROOT)',
      'from engine.audio.dsp import SR, N, fade, bp, lp, undb',
      'from engine.audio.mixing import master_chain',
      'dur = float(os.environ.get("BEIMING_DUR") or 2.0)',
      'n = N(dur)',
      't = np.arange(n) / SR',
      'rng = np.random.default_rng(42)',
      'env = np.sin(np.pi * np.clip(t / dur, 0.0, 1.0)) ** 0.6',
      'music_m = (0.35 * np.sin(2 * np.pi * 220.0 * t) + 0.20 * np.sin(2 * np.pi * 330.0 * t) + 0.10 * np.sin(2 * np.pi * 440.0 * t)) * env',
      'music = np.column_stack([music_m * 0.96, music_m * 1.04])',
      'noise = bp(rng.standard_normal(n), 500.0, 2600.0) * 0.22 * env',
      'foley = np.column_stack([noise * 1.03, noise * 0.97])',
      'bed = lp(rng.standard_normal(n), 900.0) * 0.08 * env',
      'amb = np.column_stack([bed, bed])',
      'raw = fade(music + foley + amb, 0.02, 0.04)',
      'mix, diag = master_chain(raw, target_lufs=-14.0, max_tp=-1.5)',
      'mix[0] = 0.0; mix[-1] = 0.0',
      'scale = float(undb(diag["masterGainDb"]))',
      'out_mix = os.path.abspath(os.environ.get("BEIMING_AUDIO_OUT") or os.path.join(os.path.dirname(__file__), "out", "mix.wav"))',
      'out_stems = os.path.abspath(os.environ.get("BEIMING_AUDIO_STEMS") or os.path.join(os.path.dirname(out_mix), "stems"))',
      'os.makedirs(os.path.dirname(out_mix), exist_ok=True)',
      'os.makedirs(out_stems, exist_ok=True)',
      'sf.write(out_mix, mix, SR, subtype="PCM_24")',
      'for name, stem in (("music", music), ("foley", foley), ("amb", amb)):',
      '    s = np.clip(fade(stem * scale, 0.02, 0.04), -0.94, 0.94)',
      '    s[0] = 0.0; s[-1] = 0.0',
      '    sf.write(os.path.join(out_stems, f"{name}.wav"), s, SR, subtype="PCM_24")',
    ].join('\n') + '\n', 'utf8');

    // 先写入旧时间戳的初始 WAV 夹具
    const wavBytes = makeWavHeader(960);
    const oldDate = new Date(Date.now() - 60_000);
    const initMix = path.join(outDir, 'mix.wav');
    fs.writeFileSync(initMix, wavBytes);
    fs.utimesSync(initMix, oldDate, oldDate);
    for (const stem of ['music', 'foley', 'amb']) {
      const f = path.join(stemsDir, `${stem}.wav`);
      fs.writeFileSync(f, wavBytes);
      fs.utimesSync(f, oldDate, oldDate);
    }

    const srv = createServer({ root: sandbox, middleware: createPreviewMiddleware({ root: sandbox, repoRoot: sandbox }) });
    const { port } = await srv.listen(0);
    const mtimeFromUrl = u => Number(new URL(u, `http://127.0.0.1:${port}`).searchParams.get('v'));

    try {
      const stRes = await request(port, `/_preview/state?dir=${encodeURIComponent(filmRel)}`);
      assert.equal(stRes.status, 200, stRes.text);
      const st = JSON.parse(stRes.text);
      assert.equal(st.ok, true);
      assert.equal(st.dir, filmRel);
      assert.equal(st.title, '分轨预览测试片');
      assert.equal(st.fps, 24);
      assert.equal(st.frames, 48);
      assert.equal(st.dur, 2);
      assert.deepEqual(st.cuts, [24]);
      assert.equal(st.events.length, 2);
      assert.equal(st.canRebuild, true);
      assert.match(st.mixUrl, /^\/films\/c-preview-fixture\/out\/mix\.wav\?v=\d+$/);
      assert.deepEqual(Object.keys(st.stems).sort(), ['amb', 'foley', 'music']);
      const oldMixV = mtimeFromUrl(st.mixUrl);
      assert.ok(oldMixV > 0);

      await t.test('POST /_preview/rebuild：经 film mix 快速重混声音并更新 mtime 与 QA 摘要；并发请求返回 409 busy', { skip: rebuildSkip }, async () => {
        const origin = `http://127.0.0.1:${port}`;
        // 同时发两条 POST：一条执行重混（200），另一条命中 per-dir 并发锁（409 busy）
        const [a, b] = await Promise.all([
          request(port, `/_preview/rebuild?dir=${encodeURIComponent(filmRel)}`, { method: 'POST', headers: { Origin: origin } }),
          request(port, `/_preview/rebuild?dir=${encodeURIComponent(filmRel)}`, { method: 'POST', headers: { Origin: origin } }),
        ]);
        const [r1, r2] = a.status === 409 ? [b, a] : [a, b];

        assert.equal(r2.status, 409, `并发第二条请求应返回 409 busy：${r2.text}`);
        assert.equal(JSON.parse(r2.text).error, 'busy');

        assert.equal(r1.status, 200, `重混应返回 200：${r1.text}`);
        const rebuilt = JSON.parse(r1.text);
        assert.equal(rebuilt.ok, true);
        assert.equal(rebuilt.rebuilt, true);
        assert.deepEqual(Object.keys(rebuilt.stems).sort(), ['amb', 'foley', 'music']);
        const newMixV = mtimeFromUrl(rebuilt.mixUrl);
        assert.ok(newMixV > oldMixV, `重混后 mixUrl 的 mtime (${newMixV}) 应大于旧值 (${oldMixV})`);
        assert.equal(rebuilt.qaSummary?.ok, true, `声音 QA 应通过：${JSON.stringify(rebuilt.qaSummary)}`);

        // 再查一次 GET /_preview/state，应指向刚重混出的新运行目录产物
        const afterState = JSON.parse((await request(port, `/_preview/state?dir=${encodeURIComponent(filmRel)}`)).text);
        assert.equal(afterState.mixUrl, rebuilt.mixUrl);
        assert.deepEqual(afterState.stems, rebuilt.stems);
        assert.equal(afterState.qaSummary?.ok, true);

        // 在无头浏览器里打开 ?preview=1 页面，验证 HUD 挂载、分轨胶囊与 ←/→ 逐帧驱动 window.render(t)
        const { launchBrowser, resolveAngle } = await import('../../engine/render/lib/gpu.mjs');
        const browser = await launchBrowser({ angle: resolveAngle().angle });
        try {
          const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
          await page.goto(`http://127.0.0.1:${port}/${filmRel}/?preview=1`);
          await page.waitForFunction(() => Boolean(document.getElementById('beiming-preview-shell')?.shadowRoot?.querySelector('.stem-pill')), null, { timeout: 15_000 });
          const hudInfo = await page.evaluate(() => {
            const sr = document.getElementById('beiming-preview-shell').shadowRoot;
            return {
              shot: sr.querySelector('.badge')?.textContent,
              qa: sr.querySelector('.qa-badge')?.textContent,
              stems: [...sr.querySelectorAll('.stem-name')].map(el => el.textContent),
            };
          });
          assert.equal(hudInfo.shot, 'S1');
          assert.match(hudInfo.qa || '', /^QA PASS/);
          assert.deepEqual(hudInfo.stems.sort(), ['AMB', 'FOL', 'MUS']);

          await page.keyboard.press('ArrowRight');
          const renderedT = await page.evaluate(() => window.LAST_RENDER_T);
          assert.ok(Math.abs(renderedT - 1 / 24) < 1e-6, `ArrowRight 应步进到第 1 帧 (1/24s)，收到 ${renderedT}`);

          await page.keyboard.press(']');
          const cutShot = await page.evaluate(() => ({
            t: window.LAST_RENDER_T,
            shot: document.getElementById('beiming-preview-shell').shadowRoot.querySelector('.badge')?.textContent,
          }));
          assert.ok(Math.abs(cutShot.t - 1.0) < 1e-6, `] 应跳到切点 F24 (1.0s)，收到 ${cutShot.t}`);
          assert.equal(cutShot.shot, 'S2');

          // 验证 Solo / Mute 胶囊实时切换状态
          const soloState = await page.evaluate(() => {
            const sr = document.getElementById('beiming-preview-shell').shadowRoot;
            const musPill = [...sr.querySelectorAll('.stem-pill')].find(p => p.querySelector('.stem-name')?.textContent === 'MUS');
            musPill.querySelectorAll('.stem-toggle')[1].click(); // Solo MUS
            return [...sr.querySelectorAll('.stem-pill')].map(p => ({
              name: p.querySelector('.stem-name')?.textContent,
              soloed: p.classList.contains('soloed'),
              dimmed: p.classList.contains('dimmed'),
            }));
          });
          const mus = soloState.find(s => s.name === 'MUS');
          const amb = soloState.find(s => s.name === 'AMB');
          assert.equal(mus?.soloed, true);
          assert.equal(mus?.dimmed, false);
          assert.equal(amb?.dimmed, true);

          // 非北冥渲染页（无 window.READY / window.render）即便打开 ?preview=1 也不挂载 DOM
          fs.writeFileSync(path.join(sandbox, 'plain.html'), '<!doctype html><html><body><p id="only">plain</p></body></html>', 'utf8');
          const plainPage = await browser.newPage();
          await plainPage.goto(`http://127.0.0.1:${port}/plain.html?preview=1`);
          await plainPage.waitForTimeout(200);
          const hasShellOnPlain = await plainPage.evaluate(() => Boolean(document.getElementById('beiming-preview-shell')));
          assert.equal(hasShellOnPlain, false, '非北冥页面不得挂载预览外壳');
          await plainPage.close();
        } finally {
          await browser.close();
        }

        // 验证当声音门禁不通过（退出码 4）时，POST /_preview/rebuild 返回 422 且携带 qaSummary 与 stderr
        fs.writeFileSync(path.join(filmDir, 'mix.py'), [
          '# -*- coding: utf-8 -*-',
          'import os, numpy as np, soundfile as sf',
          'sr = 48000; n = 96000',
          'bad = np.zeros((n, 2), dtype=np.float32)', // 静音混音触发 audio.loudness 硬项不通过（exit 4）
          'out_mix = os.path.abspath(os.environ.get("BEIMING_AUDIO_OUT"))',
          'os.makedirs(os.path.dirname(out_mix), exist_ok=True)',
          'sf.write(out_mix, bad, sr, subtype="PCM_24")',
        ].join('\n') + '\n', 'utf8');
        const failRes = await request(port, `/_preview/rebuild?dir=${encodeURIComponent(filmRel)}`, {
          method: 'POST',
          headers: { Origin: origin },
        });
        assert.equal(failRes.status, 422, `QA 不通过应返回 422：${failRes.text}`);
        const failData = JSON.parse(failRes.text);
        assert.equal(failData.ok, false);
        assert.equal(failData.qaSummary?.ok, false);
        assert.ok(Array.isArray(failData.qaSummary?.hardFailures) && failData.qaSummary.hardFailures.length > 0);
        assert.equal(typeof failData.stderr, 'string');
      });
    } finally {
      await srv.close();
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('serve.mjs 命令行：默认启用 ?preview=1 并在 stderr 打印提示；--no-preview 关闭注入；--json 信封保持不变', { timeout: 30_000 }, async () => {
  // stdout 与 stderr 是两根独立的管道，到达父进程的先后不保证（Windows 上实测信封先到、提示行后到）：
  // 信封与 stderr 里的 ready 提示都到齐才算启动完成，断言才能放心读 stderr
  const startServe = (extraArgs, ready) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'engine/render/serve.mjs'), '--port', '0', '--json', ...extraArgs], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', envelope = null;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`serve.mjs 启动超时：${stderr}`)); }, 15_000);
    const check = () => {
      if (!envelope || !ready.test(stderr)) return;
      clearTimeout(timer);
      resolve({ child, envelope, getStderr: () => stderr });
    };
    child.stdout.on('data', d => {
      stdout += d.toString('utf8');
      if (!envelope && stdout.trim().endsWith('}')) { envelope = JSON.parse(stdout); check(); }
    });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); check(); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
  });

  const stopServe = async child => {
    const exited = new Promise(r => child.once('exit', code => r(code)));
    if (process.platform !== 'win32') child.kill('SIGTERM'); else child.kill();
    return await exited;
  };

  const s1 = await startServe([], /带声分轨调片预览：/);
  try {
    assert.equal(s1.envelope.ok, true);
    assert.deepEqual(Object.keys(s1.envelope.data).sort(), ['port', 'root', 'url']);
    assert.match(s1.getStderr(), /带声分轨调片预览：在页面地址后加 \?preview=1/);
    const withPrev = await request(s1.envelope.data.port, '/?preview=1');
    assert.equal(withPrev.status, 200);
    assert.ok(withPrev.text.includes(PREVIEW_SCRIPT_SRC));
    const withoutPrev = await request(s1.envelope.data.port, '/');
    assert.equal(withoutPrev.text.includes(PREVIEW_SCRIPT_SRC), false);
  } finally {
    const code = await stopServe(s1.child);
    if (process.platform !== 'win32') assert.equal(code, 143);
  }

  const s2 = await startServe(['--no-preview'], /预览服务：/);
  try {
    assert.equal(s2.envelope.ok, true);
    assert.doesNotMatch(s2.getStderr(), /带声分轨调片预览/);
    const noPrevRes = await request(s2.envelope.data.port, '/?preview=1');
    assert.equal(noPrevRes.status, 200);
    assert.equal(noPrevRes.text.includes(PREVIEW_SCRIPT_SRC), false, '--no-preview 时不得注入预览脚本');
  } finally {
    await stopServe(s2.child);
  }
});
