// 北冥仓库 · 出片编排 · 一次运行的上下文：作品、档位、运行目录、作品锁、隔离的 TMPDIR、旧位置工作区、信号处理与 run.json。
//   const ctx = await openSession({ command, kind, filmArg, opts })   kind = build | animatic | stills | render
//   … 跑步骤 …
//   await closeSession(ctx, { error, complete })   无论成败都调用：结束子进程、还原旧位置、删临时目录、写 run.json、更新 latest、放锁
// run.json 字段（附录 C8，兼容 engine/production/project.js 的 validateRenderResult）：
//   schemaVersion 1、kind、final、status（running → failed | blocked | passed；accepted 只由 final 闸的用户认可写入）、
//   projectId、shotId（整片 film）、route、backend、sourceCommit、dirty、argv、tools{node,playwright,browser,ffmpeg,python?,raea?}、
//   actualDevice、actualGraphicsBackend、actualEncoder、softwareFallback、profile、output{path,sha256,width,height,fps,frames,pixFmt,color,audio}、
//   outputs[{path,sha256,kind}]、frameHashes（解码后的逐帧 md5）、timing{步骤: 秒}、steps[]、
//   technicalAcceptance{status, evidence[]}（只由 QA 判定）、creativeAcceptance{status, reviews[]}、warnings[]、error
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, FilmError, asFilmError } from './exit.mjs';
import { ROOT, rel, gitInfo, toolVersions, pythonBin, hashTree, hashJson, fileHash, sha256File } from './repo.mjs';
import { loadFilm, shotsAt, cutsOf } from './spec.mjs';
import { resolveProfile, framesAt } from './profiles.mjs';
import { parseSize } from './args.mjs';
import { createRunDir, acquireLock, setLatest, writeAtomic } from './rundir.mjs';
import { exec as rawExec, killAll, isolatedEnv, which } from './proc.mjs';
import { Legacy } from './legacy.mjs';
import * as media from './media.mjs';

let current = null;
let signalled = false;

function onSignal(sig) {
  const code = sig === 'SIGINT' ? EXIT.SIGINT : sig === 'SIGTERM' ? EXIT.SIGTERM : EXIT.SIGTERM;
  if (signalled) { process.exit(code); }
  signalled = true;
  process.stderr.write(`\n收到 ${sig}：结束子进程、还原旧位置、写 run.json 后退出……\n`);
  const ctx = current;
  const err = new FilmError(code, 'interrupted', `收到 ${sig}，已中断`, '原因排除后重跑；输入没变的步骤会复用缓存');
  (ctx ? closeSession(ctx, { error: err, complete: false }) : killAll()).finally(() => process.exit(code));
}

export function installSignals() {
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, onSignal);
}

// ANGLE 的渲染器字符串 → { device, backend }
export function parseGpu(s) {
  if (!s) return { device: null, backend: null };
  const m = /^ANGLE \((.*)\)$/.exec(s.trim());
  const body = m ? m[1] : s;
  const backend = /Metal/i.test(body) ? 'Metal' : /Vulkan/i.test(body) ? 'Vulkan' : /Direct3D11|D3D11/i.test(body) ? 'D3D11' : /OpenGL/i.test(body) ? 'OpenGL' : null;
  let device = null;
  const r = /Renderer:\s*([^,]+)/.exec(body);
  if (r) device = r[1].trim();
  else {
    const v = /Vulkan [\d.]+ \((.+?) \(0x[0-9A-Fa-f]+\)\)/.exec(body);
    if (v) device = v[1].trim();
    else { const d = /,\s*([^,]+?)\s*(?:\(0x[0-9A-Fa-f]+\))?\s*(?:Direct3D|D3D)/.exec(body); if (d) device = d[1].trim(); }
  }
  return { device: device || s, backend: backend ? `WebGL2 / ANGLE ${backend}` : 'WebGL2 / ANGLE' };
}

export async function openSession({ command, kind, filmArg, opts }) {
  const warnings = [], notes = [];
  const film = loadFilm(filmArg, { page: opts.page ? path.resolve(opts.page) : null });
  warnings.push(...film.warnings);
  if (film.route !== 'b' && !fs.existsSync(path.join(film.pageDir, 'index.html'))) {
    throw new FilmError(EXIT.USAGE, 'page-missing', `页面目录 ${rel(film.pageDir)} 下没有 index.html`, film.pageDir === film.dir ? '页面型作品（A / C）要有 index.html；用 film new 生成的作品自带' : '检查 --page 或 film.json 的 page');
  }
  const rp = path.relative(ROOT, film.pageDir);
  if (film.route !== 'b' && (rp.startsWith('..') || path.isAbsolute(rp))) {
    throw new FilmError(EXIT.USAGE, 'page-outside', `页面目录 ${film.pageDir} 不在仓库里：页面由仓库根的本地服务器提供`, '把作品放在仓库的 films/ 下（npm run new 生成的就是）');
  }
  if (opts.size && opts.final) throw new FilmError(EXIT.USAGE, 'size-final', '--final 只按交付档位出片，不能再用 --size 改画幅', '要别的画幅就换档位：--profile <档位>');
  const size = opts.size ? parseSize(opts.size) : null;
  if (size && film.route === 'b') throw new FilmError(EXIT.USAGE, 'size-native', 'B 路线的画幅来自 film.json（native.mjs 与 film.tsx 都读它），不能用 --size 覆盖', '改 film.json 的 size');
  const profile = resolveProfile(film, { override: opts.profile || null, size }, warnings);
  let width = profile.width, height = profile.height;
  if (kind === 'animatic' && film.route !== 'b' && !size) {
    const even = v => Math.max(16, Math.round(v / 4) * 2);
    width = even(width); height = even(height);
    notes.push({ code: 'animatic-half', message: `预演按半分辨率 ${width}×${height} 渲染，后期开关由页面读 previs=1 决定` });
  }
  if (opts.final && profile.custom) throw new FilmError(EXIT.CONTRACT, 'profile-required', '终渲要按明确的交付档位出片，但 film.json 没有 output.profile', `在 film.json 写 output.profile，或加 --profile <档位>（新作品默认 web-1080p24，决定 D07）`);
  const fps = profile.fps;
  const frames = framesAt(film, fps, warnings);
  if (film.route === 'b' && (profile.width !== film.width || profile.height !== film.height || fps !== film.fps)) {
    throw new FilmError(EXIT.CONTRACT, 'profile-native-mismatch', `档位 ${profile.id} 要 ${profile.width}×${profile.height}@${fps}，但 B 作品的 film.json 是 ${film.width}×${film.height}@${film.fps}（原生渲染按 film.json 出片）`,
      `改 film.json 的 size / fps 与档位一致，或换档位（--profile）`);
  }
  const shots = shotsAt(film, fps);
  const cuts = cutsOf(shots);
  const k = fps / film.fps;
  const markFrames = [...new Set(film.events.map(e => Math.round(e.frame * k)).filter(f => f >= 0 && f < frames))];
  let query = opts.query || '';
  if (kind === 'animatic') query = query ? `${query}&previs=1` : 'previs=1';
  const audio = opts.audio ? audioOverride(film, opts.audio) : film.audio;
  const outRoot = opts.outRoot ? path.resolve(opts.outRoot) : path.join(film.dir, 'out');

  const lock = acquireLock(outRoot, { command, kind }, warnings);
  let run;
  try { run = createRunDir(outRoot); } catch (e) { lock.release(); throw e; }
  const python = pythonBin();
  const tools = toolVersions({ python });
  const git = gitInfo();
  const env = isolatedEnv(process.env, run.tmp);

  const ctx = {
    command, kind, final: !!opts.final, opts, film, profile, width, height, fps, frames, shots, cuts, markFrames, query, audio,
    outRoot, run, lock, python, tools, git, env, warnings, notes, startedAt: new Date().toISOString(),
    art: {}, meta: {}, steps: [], timing: {}, qa: null, gpu: null, nativeDevice: null, raea: null, outputs: [],
    legacy: new Legacy(path.join(run.work, 'legacy-backup')), media, rel, hashTree, hashJson, fileHash,
    log: m => process.stderr.write(`${m}\n`),
    warn: (code, message) => { warnings.push({ code, message }); process.stderr.write(`[警告] ${message}\n`); },
    note: (code, message) => { notes.push({ code, message }); },
    fail: (exitCode, code, message, hint) => { throw new FilmError(exitCode, code, message, hint); },
    logFile: step => path.join(run.logs, `${step}.log`),
    relLog: step => rel(path.join(run.logs, `${step}.log`)),
  };
  // 子进程默认在仓库根运行、用隔离的 TMPDIR，输出记进当前步骤的日志
  ctx.exec = (cmd, args, o = {}) => {
    const logFile = o.logFile !== undefined ? o.logFile : (ctx.currentStep ? ctx.logFile(ctx.currentStep) : null);
    return rawExec(cmd, args, { cwd: ROOT, env: ctx.env, ...o, logFile });
  };
  current = ctx;
  try { await preflight(ctx); } catch (e) { await closeSession(ctx, { error: e }); throw e; }
  writeRunJson(ctx, { status: 'running' });
  ctx.log(`作品 ${film.relDir}（${film.routeInfo.brand}）· ${kind}${ctx.final ? '（终渲）' : ''} · 档位 ${profile.id} ${width}×${height}@${fps} · ${frames} 帧 · 运行目录 ${rel(run.dir)}`);
  return ctx;
}

// --audio 覆盖：none | x.wav（直接用这条混音）| x.py / x.sh / x.mjs（跑这个声音脚本）；路径相对当前目录
function audioOverride(film, raw) {
  if (film.route === 'b') throw new FilmError(EXIT.USAGE, 'audio-native', 'B 路线的声音由 film.json 的 native.audio 在准备阶段生成，不能用 --audio 覆盖', '改 film.json 的 native.audio');
  if (raw === 'none') return { mode: 'none', override: true };
  const p = path.resolve(raw);
  if (!fs.existsSync(p)) throw new FilmError(EXIT.USAGE, 'audio-missing', `--audio 指的文件不存在：${raw}`);
  const ext = path.extname(p).toLowerCase();
  if (ext === '.wav') return { mode: 'wav', path: p, override: true };
  if (['.py', '.sh', '.mjs', '.js'].includes(ext)) return { mode: 'script', path: p, override: true };
  throw new FilmError(EXIT.USAGE, 'audio-type', `--audio 只接受 none、.wav 混音或 .py / .sh / .mjs 声音脚本：${raw}`);
}

// 开工前查齐外部依赖：缺什么一次说清，退出码 3（不先渲十分钟再在混音一步失败）
async function preflight(ctx) {
  const missing = [];
  for (const t of [media.FFMPEG(), media.FFPROBE()]) if (!which(t)) missing.push(`${t}（FFmpeg ≥ 7，带 libx264 / aac / loudnorm / ebur128）`);
  const hasPy = !!which(ctx.python);
  if (!hasPy) missing.push(`Python（${ctx.python}）：设 PYTHON=<装了 requirements.txt 的 python>`);
  const page = ctx.film.route !== 'b';
  const a = ctx.audio;
  const script = a.mode === 'script' ? path.extname(a.path).toLowerCase() : null;
  const needsSh = (page && ctx.kind === 'build' && a.mode !== 'none') || script === '.sh';
  if (needsSh && !which('sh')) missing.push('sh（音画封装 engine/render/mux.sh 与 .sh 声音脚本要 POSIX sh；Windows 请装 Git Bash 并把 sh 放进 PATH；P04·R3 的 mux.mjs 合入后去掉此依赖）');
  if (hasPy) {
    const mods = ['PIL'];
    const audioPython = (page && (script === '.py' || script === '.sh' || (ctx.film.cuecheck && a.mode !== 'none'))) || (!page && ctx.film.native?.audio);
    if (audioPython && ['build', 'animatic'].includes(ctx.kind)) mods.push('numpy', 'scipy', 'soundfile', 'soxr', 'numba');
    const code = `import importlib.util,sys\nbad=[m for m in ${JSON.stringify(mods)} if importlib.util.find_spec(m) is None]\nprint(','.join(bad))\nsys.exit(1 if bad else 0)`;
    try { await rawExec(ctx.python, ['-c', code], { cwd: ROOT, env: ctx.env, quiet: true, timeoutSec: 60, label: 'Python 依赖预检', sweep: false }); }
    catch (e) { const bad = String(e.details?.stdout || '').trim(); missing.push(`Python 包 ${bad || mods.join(',')}（${ctx.python}）：pip install -r requirements.txt，或设 PYTHON=<已装好的 python>`); }
  }
  if (missing.length) throw new FilmError(EXIT.ENV, 'env-missing', `出片前预检：缺 ${missing.length} 项依赖`, missing.join('；'));
}

const STATUS_FOR_EXIT = code => (code === EXIT.ENV || code === EXIT.BUSY || code === EXIT.USAGE ? 'blocked' : 'failed');

export function runJsonBody(ctx, extra = {}) {
  const gpu = parseGpu(ctx.gpu && !ctx.nativeDevice ? ctx.gpu : null);
  const nd = ctx.nativeDevice;
  const device = nd ? nd.device : gpu.device;
  const backend = nd ? nd.backend : gpu.backend;
  const qa = ctx.qa;
  const technical = qa && qa.status !== 'not-run'
    ? { status: qa.status === 'passed' ? 'passed' : 'failed', evidence: qa.reportPath ? [rel(qa.reportPath)] : [], summary: qa.message, failed: qa.failed || [] }
    : { status: 'not-run', evidence: [], summary: qa?.message || null };
  return {
    schemaVersion: 1, kind: ctx.kind, final: ctx.final, status: 'running',
    projectId: ctx.film.id, shotId: ctx.kind === 'render' && ctx.renderScope ? ctx.renderScope : 'film', route: ctx.film.route, backend: ctx.film.backend,
    title: ctx.film.title, film: ctx.film.relDir, runId: ctx.run.id, runDir: rel(ctx.run.dir), command: `film ${ctx.command}`,
    startedAt: ctx.startedAt, finishedAt: null,
    sourceCommit: ctx.git.commit, dirty: ctx.git.dirty, argv: process.argv.slice(2),
    tools: { ...ctx.tools, ...(ctx.raea ? { raea: ctx.raea.version } : {}) },
    actualDevice: device || null, actualGraphicsBackend: backend || null,
    actualEncoder: ctx.film.route === 'b' ? (nd?.encoder || null) : ctx.art.video ? 'libx264（video.mjs crf 14）' + (ctx.art.master && ctx.meta.mux?.muxer?.includes('mux.sh') ? ' → libx264（mux.sh crf 19）' : '') : null,
    softwareFallback: /swiftshader|llvmpipe|software/i.test(String(ctx.gpu || '')),
    profile: { id: ctx.profile.id, source: ctx.profile.source, width: ctx.width, height: ctx.height, fps: ctx.fps, lufs: ctx.profile.lufs, lufsTol: ctx.profile.lufsTol, truePeak: ctx.profile.truePeak, ...(ctx.profile.sizeOverride ? { sizeOverride: true } : {}), ...(ctx.profile.custom ? { custom: true, base: ctx.profile.base } : {}) },
    expected: { frames: ctx.frames, width: ctx.width, height: ctx.height, fps: ctx.fps, shots: ctx.shots.filter(s => !s.implicit).map(s => ({ id: s.id, in: s.in, out: s.out })), cuts: ctx.cuts },
    output: null, outputs: ctx.outputs, frameHashes: [], frameHashKind: null,
    timing: ctx.timing, steps: ctx.steps,
    technicalAcceptance: technical,
    creativeAcceptance: { status: 'not-reviewed', events: [], styleComparison: [], issues: [], reviews: [] },
    gates: ctx.gateBasis || null,
    warnings: ctx.warnings, notes: ctx.notes, error: null,
    ...extra,
  };
}

export function writeRunJson(ctx, extra = {}) {
  const body = runJsonBody(ctx, extra);
  writeAtomic(path.join(ctx.run.dir, 'run.json'), JSON.stringify(body, null, 2) + '\n');
  return body;
}

export function addOutput(ctx, file, kind) {
  if (!file || !fs.existsSync(file)) return;
  const r = rel(file);
  if (ctx.outputs.some(o => o.path === r)) return;
  ctx.outputs.push({ path: r, sha256: sha256File(file), kind });
}

// 结束一次运行：无论成败都走这里
export async function closeSession(ctx, { error = null, complete = false, status = null, output = null, frameHashes = null, extra = {} } = {}) {
  if (ctx.closed) return ctx.closed;
  ctx.closed = (async () => {
    const fe = error ? asFilmError(error) : null;
    await killAll().catch(() => {});
    const restored = ctx.legacy.restore();
    const restoredRel = restored.map(r => ({ path: rel(r.path), action: r.action }));
    for (const d of [ctx.run.tmp, path.join(ctx.run.work, 'legacy-backup')]) fs.rmSync(d, { recursive: true, force: true });
    const st = fe ? STATUS_FOR_EXIT(fe.exitCode) : (status || 'passed');
    const body = runJsonBody(ctx, {
      status: st, finishedAt: new Date().toISOString(), output, frameHashes: frameHashes || [], frameHashKind: frameHashes?.length ? `decoded-md5:${output?.path || ''}` : null,
      error: fe ? { code: fe.code, message: fe.message, hint: fe.hint || null, exitCode: fe.exitCode, step: ctx.currentStep || null } : null,
      legacyRestored: restoredRel, ...extra,
    });
    try { writeAtomic(path.join(ctx.run.dir, 'run.json'), JSON.stringify(body, null, 2) + '\n'); } catch { /* 磁盘满等极端情况 */ }
    if (!fe && complete && st !== 'failed') setLatest(ctx.outRoot, ctx.kind, ctx.run.id);
    ctx.lock.release();
    if (current === ctx) current = null;
    return body;
  })();
  return ctx.closed;
}
