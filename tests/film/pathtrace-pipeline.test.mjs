// D 路线（北冥光追 · 物理路径追踪，决定 D13）出片流水线测试：
//   1. engine/production/film.js check 对 D 路线作品目录通过，并拦截未知镜头 shotSpp 与残留时间字段
//   2. pathtrace-steps：缺运行时退出 3（含 BEIMING_PT_BIN 提示）；软件渲染按 --gpu required 拦截
//   3. renderPathtraceFrames（stills / render）：首轮渲染落进 out/cache/pt-frames/<sceneKey>/f_NNNNNN.png，次轮 0 帧重渲
//   4. animatic（半分辨率 preview 4 SPP）与 build（CRF 14 BT.709 tv + shotSpp 分镜采样 + QA 离线 texts.json 与 WCAG 对比度实测）
//   5. 修改单镜 shotSpp 时，未改动镜头全部命中帧缓存，只重渲改动镜头；--encoder nvenc 区分步骤缓存键
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FilmError } from '../../tools/film/lib/exit.mjs';
import { preflight as envPreflight } from '../../tools/env/preflight.mjs';
import { exec as rawExec, isolatedEnv } from '../../tools/film/lib/proc.mjs';
import { fileHash, hashJson, hashTree, rel } from '../../tools/film/lib/repo.mjs';
import { createRunDir } from '../../tools/film/lib/rundir.mjs';
import { loadFilm } from '../../tools/film/lib/spec.mjs';
import { openSession, closeSession, addOutput } from '../../tools/film/lib/session.mjs';
import { runSteps } from '../../tools/film/lib/pipeline.mjs';
import { deliverSteps } from '../../tools/film/lib/deliver.mjs';
import { createPathtraceStep, pathtraceSteps, renderPathtraceFrames } from '../../tools/film/lib/pathtrace-steps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILM_JS = path.join(ROOT, 'engine/production/film.js');

// 替身渲染器采用当前 node 原生可执行文件 + --import 预加载钩子（与 tests/native/rt.test.mjs 423c04c、tests/film/helpers.mjs 同法）：
// Linux / macOS / Windows 均直接启动原生二进制，不依赖 POSIX sh shebang 或 Windows .cmd（避免无 Git Bash 或 spawn EINVAL）。
function makeMockRuntime(tmpDir, { deviceType = 'DiscreteGpu', adapter = 'Mock RTX 5090' } = {}) {
  const presetsDir = path.join(tmpDir, 'mock-pt', 'presets');
  const sdkDir = path.join(tmpDir, 'mock-pt', 'sdk');
  const callsLog = path.join(tmpDir, 'serve-calls.jsonl');
  const hookPath = path.join(tmpDir, 'mock-pt', 'mock-threert-hook.mjs');
  fs.mkdirSync(presetsDir, { recursive: true });
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  for (const name of ['cinematic', 'preview']) {
    fs.writeFileSync(path.join(presetsDir, `${name}.json`), JSON.stringify({ name, native: { spp: 32, denoise: true } }, null, 2) + '\n');
  }
  const exe = process.execPath;
  const hookScript = `import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CALLS = ${JSON.stringify(callsLog)};
const INFO = ${JSON.stringify({ adapter, backend: 'Vulkan', device_type: deviceType, driver: 'NVIDIA', hwrt: deviceType === 'DiscreteGpu' })};

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function writeTestPng(file, W, H, frame, hideTexts) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  const shot2 = frame >= 12;
  const baseR = shot2 ? 24 : 52;
  const baseG = shot2 ? 30 : 42;
  const baseB = shot2 ? 44 : 28;
  const barX = Math.floor(((frame * 37) % Math.max(1, W - 80)));
  // 比例坐标确保在任意分辨率下文字框与背景对比分明
  const tx0 = Math.floor(W * 0.2), tx1 = Math.floor(W * 0.5);
  const ty0 = Math.floor(H * 0.2), ty1 = Math.floor(H * 0.32);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1);
    raw[row] = 0;
    const grad = Math.floor((y / Math.max(1, H)) * 28);
    let r = baseR + grad, g = baseG + grad, b = baseB + grad;
    for (let x = 0; x < W; x++) {
      let pr = r, pg = g, pb = b;
      if (x >= barX && x < barX + 64) { pr += 55; pg += 45; pb += 35; }
      if (!hideTexts && shot2 && x >= tx0 && x < tx1 && y >= ty0 && y < ty1) {
        const stripe = ((x + y) % 7) !== 0;
        if (stripe) { pr = 242; pg = 245; pb = 250; }
      }
      const p = row + 1 + x * 3;
      raw[p] = pr; raw[p + 1] = pg; raw[p + 2] = pb;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
}

const sub = process.argv[1] ? path.basename(process.argv[1]) : '';
if (sub === 'info' && process.argv.length === 2) {
  process.stdout.write(JSON.stringify(INFO) + '\\n');
  process.exit(0);
}
if (sub === 'serve' && process.argv[2] === '--presets') {
  const stdin = fs.readFileSync(0, 'utf8');
  process.stdout.write(JSON.stringify({ ready: true, adapter: INFO.adapter, init_ms: 5 }) + '\\n');
  for (const line of stdin.split(/\\r?\\n/).map(s => s.trim()).filter(Boolean)) {
    const job = JSON.parse(line);
    fs.appendFileSync(CALLS, JSON.stringify(job) + '\\n');
    writeTestPng(job.out, job.width, job.height, job.state?.frame ?? 0, Boolean(job.state?.hideTexts));
    process.stdout.write(JSON.stringify({ id: job.id, ok: true, stats: { timings_ms: { trace_ms: 4.2 } } }) + '\\n');
  }
  process.exit(0);
}
`;
  fs.writeFileSync(hookPath, hookScript);
  const hookFlag = `--import ${pathToFileURL(hookPath).href}`;
  const binarySha256 = createHash('sha256').update(hookScript).digest('hex');

  const withEnv = (base = process.env) => ({
    ...base,
    NODE_OPTIONS: [base.NODE_OPTIONS, hookFlag].filter(Boolean).join(' '),
  });
  const attach = ctx => {
    ctx.env = withEnv(ctx.env);
    return ctx;
  };

  const runtime = {
    async resolvePathtrace() {
      return { exe, homeDir: path.join(tmpDir, 'mock-pt'), presetsDir, sdkDir, version: '0.1.1-beiming.1', platform: `${process.platform}-${os.arch()}`, binarySha256, verified: true, oidn: false };
    },
  };
  const bundler = {
    async bundlePathtraceFilm({ outBundle, probeOut, film, width, height, fps }) {
      const frameCount = film.output.frameCount;
      fs.mkdirSync(path.dirname(outBundle), { recursive: true });
      const code = `// mock bundle for ${film.id}\nexport const FRAMES = ${frameCount};\n`;
      fs.writeFileSync(outBundle, code);
      const bundleSha256 = createHash('sha256').update(code).digest('hex');
      const eventsPath = path.join(probeOut, 'events.json');
      const timelinePath = path.join(probeOut, 'timeline.json');
      const textsPath = path.join(probeOut, 'work', 'texts.json');
      fs.mkdirSync(path.dirname(textsPath), { recursive: true });
      fs.writeFileSync(eventsPath, JSON.stringify({ events: film.events || [] }, null, 2) + '\n');
      fs.writeFileSync(timelinePath, JSON.stringify({ fps, frameCount, shots: film.shots }, null, 2) + '\n');
      const box = [Math.floor(width * 0.2), Math.floor(height * 0.2), Math.floor(width * 0.3), Math.floor(height * 0.12)];
      const frames = [];
      for (let f = 12; f < frameCount; f++) {
        frames.push({ frame: f, t: +(f / fps).toFixed(6), items: [{ id: 'badge', text: 'WONDERX', box, alpha: 1 }] });
      }
      fs.writeFileSync(textsPath, JSON.stringify({ schemaVersion: 1, fps, frameCount, width, height, frames }, null, 2) + '\n');
      return { bundlePath: outBundle, bundleSha256, eventsPath, timelinePath, textsPath, frameCount, fps, width, height };
    },
  };
  const readCalls = () => (fs.existsSync(callsLog) ? fs.readFileSync(callsLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)) : []);
  const clearCalls = () => fs.rmSync(callsLog, { force: true });
  return { exe, presetsDir, sdkDir, runtime, bundler, withEnv, attach, readCalls, clearCalls };
}

// 不依赖 FFmpeg / Python 预检的轻量运行上下文（供 CI 的 unit 与 windows-paths 在无 FFmpeg 环境下验证光追预检、帧级缓存与缓存键）
function makeLightCtx({ filmDir, outRoot, kind = 'build', opts = {}, env = process.env }) {
  const film = loadFilm(filmDir);
  const run = createRunDir(outRoot);
  const runEnv = isolatedEnv(env, run.tmp);
  const warnings = [];
  const ctx = {
    command: kind,
    kind,
    opts,
    film,
    width: film.width,
    height: film.height,
    fps: film.fps,
    frames: film.frameCount,
    shots: film.shots,
    outRoot,
    run,
    tools: { node: process.versions.node, ffmpeg: 'mock-ffmpeg-8' },
    env: runEnv,
    warnings,
    art: {},
    meta: {},
    steps: [],
    timing: {},
    gpu: null,
    nativeDevice: null,
    ptRuntime: null,
    currentStep: null,
    rel,
    hashTree,
    hashJson,
    fileHash,
    log: () => {},
    warn: (code, message) => { warnings.push({ code, message }); },
    fail: (exitCode, code, message, hint) => { throw new FilmError(exitCode, code, message, hint); },
    logFile: step => path.join(run.logs, `${step}.log`),
    relLog: step => rel(path.join(run.logs, `${step}.log`)),
  };
  ctx.exec = (cmd, args, o = {}) => {
    const logFile = o.logFile !== undefined ? o.logFile : (ctx.currentStep ? ctx.logFile(ctx.currentStep) : null);
    return rawExec(cmd, args, { cwd: ROOT, env: ctx.env, ...o, logFile });
  };
  return ctx;
}

function writeSilentToneWav(file, durationSec = 1.5, sampleRate = 48000) {
  const samples = Math.round(durationSec * sampleRate);
  const channels = 2;
  const dataSize = samples * channels * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  // 温和的 220 Hz 正弦波，让 mux.mjs 的两遍 loudnorm 稳定收敛到 -14 LUFS
  for (let i = 0; i < samples; i++) {
    const env = Math.min(1, i / 480, (samples - 1 - i) / 480);
    const v = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 6000 * env);
    const o = 44 + i * 4;
    buf.writeInt16LE(v, o);
    buf.writeInt16LE(v, o + 2);
  }
  fs.writeFileSync(file, buf);
}

function createTempRouteDFilm(name, overrides = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-film-work-'));
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  writeSilentToneWav(path.join(dir, 'tone.wav'), 1.5);
  fs.writeFileSync(path.join(dir, 'scene.ts'), '// mock route D scene\nexport default {};\n');
  const filmJson = {
    schemaVersion: 2,
    id: name,
    title: '光追流水线测试片',
    route: 'd',
    backend: 'pathtrace',
    entry: 'scene.ts',
    output: { profile: 'web-1080p24', width: 1920, height: 1080, fps: 24, frameCount: 36 },
    shots: [
      { id: 'S01', in: 0, out: 12, transition: 'cut' },
      { id: 'S02', in: 12, out: 36, transition: 'cut' },
    ],
    events: [
      { id: 'reveal-lock', frame: 12, shot: 'S02', visual: '铭牌切入显现' },
    ],
    audio: { mode: 'wav', wav: 'tone.wav' },
    deliveries: ['web-1080p24'],
    pathtrace: {
      preset: 'cinematic',
      spp: 24,
      animaticSpp: 4,
      denoise: 'auto',
      seed: 2026,
      shotSpp: { S02: 48 },
      overlay: 'none',
    },
    credits: [{ what: '路径追踪运行时（ThreeRT）', owner: 'meshy-dev / ThreeRT contributors', license: 'MIT', source: 'https://github.com/meshy-dev/ThreeRT' }],
    aigc: { contains: false, note: '程序化几何与测试正弦波音频' },
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'film.json'), JSON.stringify(filmJson, null, 2) + '\n');
  return { dir, rel: dir, cleanup: () => fs.rmSync(parent, { recursive: true, force: true }) };
}

test('film.js check：D 路线作品目录通过，shotSpp 未知镜头与时间字段被拦截', () => {
  const f = createTempRouteDFilm(`pt-chk-${process.pid}`);
  try {
    const ok = spawnSync(process.execPath, [FILM_JS, 'check', f.dir, '--json'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);
    const j = JSON.parse(ok.stdout);
    assert.equal(j.ok, true);

    const bad = JSON.parse(fs.readFileSync(path.join(f.dir, 'film.json'), 'utf8'));
    bad.pathtrace.shotSpp = { S99: 64 };
    bad.pathtrace.holdSec = 1.5;
    fs.writeFileSync(path.join(f.dir, 'film.json'), JSON.stringify(bad, null, 2) + '\n');
    const fail = spawnSync(process.execPath, [FILM_JS, 'check', f.dir, '--json'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(fail.status, 4);
    const fj = JSON.parse(fail.stdout);
    const diags = fj.data?.diagnostics || fj.result?.diagnostics || fj.diagnostics || [];
    const codes = diags.map(d => d.code);
    assert.ok(codes.includes('pathtrace-shot-unknown'), JSON.stringify(fj));
    assert.ok(codes.includes('orphan-time-field'), JSON.stringify(fj));
  } finally {
    f.cleanup();
  }
});

test('pathtrace preflight 与帧级缓存（不依赖 FFmpeg）：缺少运行时退出 3、软件渲染退出 3、stills 单帧缓存复用与 nvenc 缓存键区分', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-preflight-'));
  const f = createTempRouteDFilm(`pt-pre-${process.pid}`);
  try {
    const missingRuntime = {
      async resolvePathtrace() {
        const err = new Error('未找到 threert-render 可执行文件');
        err.code = 'env.pathtrace-missing';
        err.hint = '设 BEIMING_PT_BIN 指向 threert-render 可执行文件';
        throw err;
      },
    };
    const ctx1 = makeLightCtx({ filmDir: f.dir, outRoot: path.join(tmp, 'out1'), kind: 'build', opts: { gpu: 'required' } });
    let caught = null;
    try {
      await runSteps(ctx1, pathtraceSteps({ kind: 'build', runtime: missingRuntime }).slice(0, 1));
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.exitCode, 3);
    assert.match(`${caught.message} ${caught.hint}`, /BEIMING_PT_BIN/);

    const swMock = makeMockRuntime(path.join(tmp, 'sw'), { deviceType: 'Cpu', adapter: 'llvmpipe (LLVM 19)' });
    const ctx2 = swMock.attach(makeLightCtx({ filmDir: f.dir, outRoot: path.join(tmp, 'out2'), kind: 'build', opts: { gpu: 'required' } }));
    let swErr = null;
    try {
      await runSteps(ctx2, pathtraceSteps({ kind: 'build', runtime: swMock.runtime, bundler: swMock.bundler }).slice(0, 1));
    } catch (e) { swErr = e; }
    assert.ok(swErr);
    assert.equal(swErr.exitCode, 3);
    assert.equal(swErr.short, 'software-render');

    // 在无 FFmpeg 的 unit / windows-paths 环境也直接验证 stills 帧级缓存命中、shotSpp 覆盖与 nvenc 缓存键区分
    const hwMock = makeMockRuntime(path.join(tmp, 'hw'));
    const cacheOutRoot = path.join(tmp, 'out-cache');
    const sCtx1 = hwMock.attach(makeLightCtx({ filmDir: f.dir, outRoot: cacheOutRoot, kind: 'stills', opts: { gpu: 'required' } }));
    const sr1 = await renderPathtraceFrames(sCtx1, [6, 24], path.join(sCtx1.run.dir, 'stills'), { runtime: hwMock.runtime, bundler: hwMock.bundler });
    assert.equal(sr1.rendered, 2);
    assert.equal(sr1.reused, 0);
    const firstCalls = hwMock.readCalls();
    assert.equal(firstCalls.find(j => j.state.frame === 6)?.spp, 24, 'S01 应用基准 24 SPP');
    assert.equal(firstCalls.find(j => j.state.frame === 24)?.spp, 48, 'S02 应用 shotSpp 覆盖的 48 SPP');

    hwMock.clearCalls();
    const sCtx2 = hwMock.attach(makeLightCtx({ filmDir: f.dir, outRoot: cacheOutRoot, kind: 'stills', opts: { gpu: 'required' } }));
    const sr2 = await renderPathtraceFrames(sCtx2, [6, 24], path.join(sCtx2.run.dir, 'stills'), { runtime: hwMock.runtime, bundler: hwMock.bundler });
    assert.equal(sr2.rendered, 0);
    assert.equal(sr2.reused, 2);
    assert.equal(hwMock.readCalls().length, 0);

    const ptStep = createPathtraceStep({ runtime: hwMock.runtime, bundler: hwMock.bundler });
    const x264Key = await ptStep.key({ ...sCtx2, kind: 'build', opts: { ...sCtx2.opts, encoder: 'x264' } });
    const nvencKey = await ptStep.key({ ...sCtx2, kind: 'build', opts: { ...sCtx2.opts, encoder: 'nvenc' } });
    assert.notEqual(x264Key, nvencKey, '--encoder nvenc 应与默认 x264 拥有不同的 pathtrace 视频编码缓存键');
  } finally {
    f.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('D 路线完整流水线：stills 帧缓存复用、animatic 半分辨率预演、build 终检（含离线 texts.json + 对比度实测）与分镜 shotSpp 局部重渲', async t => {
  const pre = await envPreflight(['ffmpeg', 'python:audio']);
  if (!pre.ok) {
    t.skip(`缺少完整封装/交付预检依赖（${pre.failed.map(c => c.id).join('、')}；CI 的 unit / windows-paths 跳过，在 smoke-render 中执行）`);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-pipe-'));
  const outRoot = path.join(tmp, 'out');
  const mock = makeMockRuntime(tmp);
  const f = createTempRouteDFilm(`pt-e2e-${process.pid}`);
  try {
    // 1. stills：首轮渲 2 张（S01、S02 各取中间帧），落进 pt-frames/<sceneKey>/f_NNNNNN.png；第二轮 0 张新渲
    const sCtx1 = mock.attach(await openSession({ command: 'stills', kind: 'stills', filmArg: f.dir, opts: { gpu: 'required', outRoot } }));
    const sDest1 = path.join(sCtx1.run.dir, 'stills');
    const sr1 = await renderPathtraceFrames(sCtx1, [6, 24], sDest1, { runtime: mock.runtime, bundler: mock.bundler });
    sCtx1.art.frames = path.join(sCtx1.run.dir, 'frames.json');
    fs.writeFileSync(sCtx1.art.frames, '{"frames":2}\n');
    sCtx1.nonDeliverable = true;
    sCtx1.specCheck = { status: 'passed', evidence: ['frames.json'], by: 'test', summary: '2 frames' };
    const sBody1 = await closeSession(sCtx1, { complete: true, output: { path: 'stills', sha256: 'a'.repeat(64), width: 1920, height: 1080, fps: 24, frames: 2 } });
    assert.equal(sr1.rendered, 2);
    assert.equal(sr1.reused, 0);
    assert.ok(fs.existsSync(path.join(outRoot, 'cache', 'pt-frames', sr1.cacheKey, 'f_000006.png')));
    assert.ok(fs.existsSync(path.join(sDest1, 'f000006.png')));
    assert.equal(sBody1.validation.ok, true, JSON.stringify(sBody1.validation));

    mock.clearCalls();
    const sCtx2 = mock.attach(await openSession({ command: 'stills', kind: 'stills', filmArg: f.dir, opts: { gpu: 'required', outRoot } }));
    const sr2 = await renderPathtraceFrames(sCtx2, [6, 24], path.join(sCtx2.run.dir, 'stills'), { runtime: mock.runtime, bundler: mock.bundler });
    sCtx2.art.frames = path.join(sCtx2.run.dir, 'frames.json');
    fs.writeFileSync(sCtx2.art.frames, '{"frames":2}\n');
    sCtx2.nonDeliverable = true;
    sCtx2.specCheck = { status: 'passed', evidence: ['frames.json'], by: 'test', summary: '2 frames' };
    await closeSession(sCtx2, { complete: true, output: { path: 'stills', sha256: 'a'.repeat(64), width: 1920, height: 1080, fps: 24, frames: 2 } });
    assert.equal(sr2.rendered, 0);
    assert.equal(sr2.reused, 2);
    assert.equal(mock.readCalls().length, 0, '命中 pt-frames 缓存时不应再起 serve 渲染任务');

    // 2. animatic：半分辨率 960x540、preset=preview、animaticSpp=4
    mock.clearCalls();
    const aCtx = mock.attach(await openSession({ command: 'animatic', kind: 'animatic', filmArg: f.dir, opts: { gpu: 'required', outRoot } }));
    assert.equal(aCtx.width, 960);
    assert.equal(aCtx.height, 540);
    await runSteps(aCtx, [...pathtraceSteps({ kind: 'animatic', runtime: mock.runtime, bundler: mock.bundler }), ...deliverSteps({ kind: 'animatic' })]);
    addOutput(aCtx, aCtx.art.animatic, 'animatic');
    const aInfo = await aCtx.media.probe(aCtx.exec, aCtx.art.animatic);
    aCtx.nonDeliverable = true;
    aCtx.specCheck = { status: 'passed', evidence: ['animatic.mp4'], by: 'test', summary: 'animatic ok' };
    const aBody = await closeSession(aCtx, {
      complete: true,
      output: { path: 'animatic.mp4', sha256: aCtx.outputs[0].sha256, width: aInfo.width, height: aInfo.height, fps: aInfo.fps, frames: aInfo.frames },
    });
    const aCalls = mock.readCalls();
    assert.equal(aCalls.length, 36);
    assert.ok(aCalls.every(j => j.preset === 'preview' && j.spp === 4 && j.width === 960 && j.height === 540));
    assert.equal(aBody.status, 'rendered');
    assert.equal(aBody.validation.ok, true, JSON.stringify(aBody.validation));

    // 3. build：复用 stills 已渲过的第 6、24 帧（36 - 2 = 34 张新渲 + 1 张 hideTexts 对比度帧），过真实机器 QA 门
    mock.clearCalls();
    const bCtx = mock.attach(await openSession({ command: 'build', kind: 'build', filmArg: f.dir, opts: { gpu: 'required', outRoot } }));
    await runSteps(bCtx, [...pathtraceSteps({ kind: 'build', runtime: mock.runtime, bundler: mock.bundler }), ...deliverSteps({ kind: 'build' })]);
    for (const [k, kd] of Object.entries({ master: 'master', web: 'web', player: 'player', contact: 'contact', poster: 'poster', qaReport: 'qa-report' })) {
      addOutput(bCtx, bCtx.art[k], kd);
    }
    const mInfo = await bCtx.media.probe(bCtx.exec, bCtx.art.master);
    const bBody = await closeSession(bCtx, {
      complete: true,
      output: { path: 'master.mp4', sha256: bCtx.outputs.find(o => o.kind === 'master').sha256, width: mInfo.width, height: mInfo.height, fps: mInfo.fps, frames: mInfo.frames },
    });
    const bCalls = mock.readCalls();
    const normalJobs = bCalls.filter(j => !j.state?.hideTexts);
    const contrastJobs = bCalls.filter(j => j.state?.hideTexts === true);
    assert.equal(normalJobs.length, 34, '第 6 与第 24 帧已在 stills 缓存，应只补渲其余 34 帧');
    assert.equal(contrastJobs.length, 1, '应为 S02 文字代表帧渲 1 张关文字对照帧');
    assert.ok(normalJobs.filter(j => j.state.frame < 12).every(j => j.spp === 24), 'S01 应用基准 24 SPP');
    assert.ok(normalJobs.filter(j => j.state.frame >= 12).every(j => j.spp === 48), 'S02 应用 shotSpp 覆盖的 48 SPP');
    assert.equal(bCtx.meta.mux.videoCopied, true, 'work/video.mp4 已具备完整 BT.709 tv 标记，封装应直接逐位复制画面');
    assert.equal(mInfo.color.range, 'tv');
    assert.equal(mInfo.color.space, 'bt709');
    assert.equal(bCtx.qa.status, 'passed', bCtx.qa.message);
    const qaChecks = Object.fromEntries(bCtx.qa.report.checks.map(c => [c.id, c]));
    assert.equal(qaChecks['texts.inframe'].status, 'pass');
    assert.equal(qaChecks['texts.safe-area'].status, 'pass');
    assert.ok(['pass', 'warn'].includes(qaChecks['texts.duration'].status), '1.0s 超过 0.8s 硬下限（低于导演建议 1.72s 软项时记 warn）');
    assert.equal(qaChecks['texts.glyphs'].status, 'pass');
    assert.equal(qaChecks['texts.contrast'].status, 'pass');
    assert.ok(qaChecks['texts.contrast'].evidence.rows[0].ratio > 7, '实测发光字与深色背景的 WCAG 对比度应远高于 4.5:1');
    assert.equal(bBody.status, 'passed');
    assert.equal(bBody.validation.ok, true, JSON.stringify(bBody.validation));
    assert.equal(bBody.actualDevice, 'Mock RTX 5090');
    assert.equal(bBody.tools.pathtrace, '0.1.1-beiming.1');

    // 4. 仅把 S02 的 shotSpp 从 48 提到 64：S01 的 12 帧全部复用，只重渲 S02 的 24 帧（+ 1 张对照帧）
    const updated = JSON.parse(fs.readFileSync(path.join(f.dir, 'film.json'), 'utf8'));
    updated.pathtrace.shotSpp = { S02: 64 };
    fs.writeFileSync(path.join(f.dir, 'film.json'), JSON.stringify(updated, null, 2) + '\n');
    mock.clearCalls();
    const bCtx2 = mock.attach(await openSession({ command: 'build', kind: 'build', filmArg: f.dir, opts: { gpu: 'required', outRoot, noQa: true } }));
    await runSteps(bCtx2, pathtraceSteps({ kind: 'build', runtime: mock.runtime, bundler: mock.bundler }));
    await closeSession(bCtx2, { complete: false });
    const bCalls2 = mock.readCalls();
    const normal2 = bCalls2.filter(j => !j.state?.hideTexts);
    assert.equal(bCtx2.meta.pathtrace.reused, 12, 'S01 的 12 帧未改采样数，应全部复用');
    assert.equal(normal2.length, 24, '只重渲 S02 的 24 帧');
    assert.ok(normal2.every(j => j.state.frame >= 12 && j.spp === 64));
  } finally {
    f.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
