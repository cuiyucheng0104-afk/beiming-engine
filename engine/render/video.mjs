// 北冥引擎 · 逐帧渲染成视频（渲染器 v2，规格见 engine/render/README.md）
//   node engine/render/video.mjs [<影片目录>] [--out <文件.mp4>] [--profile web-1080p24 | --size WxH --fps 24] [--frames a:b | --shot S2]
//                                [--workers 4] [--web <文件.mp4>] [--fast] [--resume] [--plan] [--json] …   完整选项：--help
//
// 流程：预检 FFmpeg → 输出锁（<输出>.lock，同一输出并发第二个退出码 5）→ 渲染槽位 / 共享 GPU 守卫 → 打开探测页（核对页面约定、
//   GPU、帧率）→ 帧区间切成固定的块（与 --workers 无关）→ 几路浏览器取块逐帧渲染 → 每帧无损截图（PNG），FFmpeg 只做一次
//   色彩换算（有限范围 BT.709，写明标记）编成 H.264 → 块拼接（复制，不重编码）→ 核对帧数 = 区间帧数 → 原子改名 → run.json。
// 输出位置（附录 C4）：写了 --out 就是它（运行记录 <输出>.run.json）；没写时是运行目录——作品 films/<名>/out/<运行号>/master.mp4、
//   《北冥》样片 out/beiming/<运行号>/master.mp4，运行记录是同目录的 run.json，成功后更新指针文件 <…>/out/latest。
// 成片与 --workers 无关（块的边界固定），同一提交、同一浏览器构建、同一 GPU 后端下逐字节可复现——前提是页面通过了确定性检查
//   （render(t) 只依赖 t；tools/baseline 的 determinism 检查）。--fast 改用 JPEG 截图（快约 2 倍、多一代有损），只用于预览。
// 帧率：页面的一拍二 / 一拍三按页面帧率量化。页面帧率 = window.FPS，没声明是引擎默认 24。--fps / --profile / film.json 给的帧率
//   与页面帧率不一致直接失败（退出码 4）；页面确实与帧率无关、或明知节奏会不均还要换帧率时加 --any-fps。
// 失败：任何一块出错（render 抛错、页面报错、缺素材、着色器错误、上下文丢失、软件渲染、FFmpeg 退出、收到 SIGINT / SIGTERM）都会
//   停下其余各块，关掉所有浏览器和 FFmpeg，删掉临时目录 <输出目录>/.segs-*，写 status=failed 的运行记录，以约定的退出码退出。
//   --resume 时块放在 <输出>.parts/，失败后保留，下次加 --resume 只补渲没完成的块：开渲前先写下这次的参数键（parts.json），
//   参数、浏览器构建或 GPU 后端变了就整个清空重渲；每块的旁注另记渲它时加载过的文件的内容哈希，文件变了的块重渲。
// AIGC（D11）：film.json 声明 aigc.contains 时，成片的 comment 元数据写隐式标识（tools/compliance/lib/aigc.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isMain, runCli } from '../../tools/lib/cli.mjs';
import { openFilm, locateFilm, renderFrame, closeServer, ROOT } from './page.mjs';
import { RenderError } from './lib/errors.mjs';
import { renderCommand, pickOptions, parseSize, parseFrames, positiveNumber } from './lib/command.mjs';
import { resolveAngle, resolveGpuPolicy } from './lib/gpu.mjs';
import { preflight, COLOR, TAGS, x264Args, FFMPEG } from './lib/ffmpeg.mjs';
import { acquireLock } from './lib/lock.mjs';
import { acquireSlot, guardGpu, slotCount } from './lib/slots.mjs';
import { environment, baseRecord, writeRecord, writeLatest, sha256File, selfCheck, repoPath, sha256, runId as makeRunId } from './lib/record.mjs';
import { resolveProfile } from './lib/profiles.mjs';
import { readFilm, pickShot } from './lib/film.mjs';
import { planFilmChunks, renderRange, concatChunks } from './lib/chunks.mjs';
import { aigcMetadata } from './lib/mux.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms).unref());

/** 渲染器自身的版本指纹：engine/render 下脚本与 lib 的内容哈希（断点续跑与镜头缓存的键都含它） */
export function rendererFingerprint() {
  const h = createHash('sha256');
  const files = ['page.mjs', 'video.mjs', 'shots.mjs', ...fs.readdirSync(path.join(HERE, 'lib')).filter(n => n.endsWith('.mjs')).sort().map(n => `lib/${n}`)];
  for (const f of files) { try { h.update(f).update(fs.readFileSync(path.join(HERE, f))); } catch {} }
  return h.digest('hex').slice(0, 16);
}

/** 解析尺寸、帧率请求与档位（命令行 > 档位 > film.json > 默认）；两处显式写法冲突是用法错误 */
export function resolveOutputSpec({ opts, film }) {
  const profileId = opts.profile ?? film?.output?.profile ?? null;
  const profile = profileId ? resolveProfile(profileId, ROOT) : null;
  const fromFilm = film?.output ?? {};
  let size = opts.size ? parseSize(opts.size) : null;
  if (size && profile && opts.profile && (size.w !== profile.width || size.h !== profile.height)) {
    throw new RenderError('usage.conflict', `--size ${size.w}x${size.h} 与档位 ${profile.id} 的 ${profile.width}x${profile.height} 不一致`, { hint: '去掉 --size 按档位出，或换一个档位' });
  }
  size ??= profile ? { w: profile.width, h: profile.height } : fromFilm.width && fromFilm.height ? { w: fromFilm.width, h: fromFilm.height } : { w: 1920, h: 1040 };
  let fps = positiveNumber(opts.fps ?? null, '--fps');
  if (fps !== null && profile && opts.profile && Math.abs(fps - profile.fps) > 1e-9) {
    throw new RenderError('usage.conflict', `--fps ${fps} 与档位 ${profile.id} 的 ${profile.fps} fps 不一致`, { hint: '去掉 --fps 按档位出，或换一个档位' });
  }
  fps ??= profile?.fps ?? fromFilm.fps ?? null;
  return { size, fps, profile };
}

/** 页面帧率与请求帧率的核对（返回实际渲染帧率） */
export function decideFps({ requested, pageFps, anyFps, log }) {
  const pageRate = pageFps ?? 24;
  const whose = pageFps !== null && pageFps !== undefined ? `页面声明的 window.FPS=${pageFps} ` : '页面帧率 24（页面没有声明 window.FPS，按引擎默认 24 fps 量化）';
  if (requested !== null && requested !== undefined && Math.abs(requested - pageRate) > 1e-9) {
    if (!anyFps) {
      throw new RenderError('contract.fps-mismatch', `请求的帧率 ${requested} 与${whose}不一致：一拍二 / 一拍三按 ${pageRate} fps 量化，换成 ${requested} fps 节奏会抖`, {
        hint: `去掉 --fps 按 ${pageRate} fps 渲；页面按别的帧率编写就在页面里声明 window.FPS（或读 window.__RENDER.fps）；确认与帧率无关或接受节奏不均，加 --any-fps`,
      });
    }
    log.warn(`--any-fps：按 ${requested} fps 渲染，但${whose}，一拍二 / 一拍三的节奏可能不均匀`, 'fps-mismatch-allowed');
  }
  return requested ?? pageRate;
}

/** 进度：text 每 2 秒一行，ndjson 每秒一个事件；附带已用时间与预计剩余时间 */
export function makeProgress(log, total, { label = '渲染' } = {}) {
  const t0 = Date.now();
  let last = 0, lastDone = -1;
  return ({ done, reused = 0 }) => {
    const now = Date.now();
    if (done < total && now - last < (log.ndjson ? 1000 : 2000)) return;
    if (done === lastDone && done < total) return;
    last = now; lastDone = done;
    const fresh = done - reused, secs = (now - t0) / 1000;
    const rate = secs > 0 ? fresh / secs : 0;
    const eta = rate > 0 ? Math.round((total - done) / rate) : null;
    log.progress({ stage: label, done, total, reused, fps: +rate.toFixed(2), elapsedSec: +secs.toFixed(1), etaSec: eta },
      `${label} ${done}/${total} 帧（${Math.round((100 * done) / Math.max(1, total))}%）${reused ? `，复用 ${reused} 帧` : ''}  ${rate.toFixed(1)} 帧/秒${eta !== null && done < total ? `  预计还要 ${eta} 秒` : ''}`);
  };
}

/** 帧区间：--frames / --shot（互斥）；超出片长是用法错误 */
export function frameRange({ opts, film, total }) {
  let a = 0, b = total;
  if (opts.frames) ({ a, b } = parseFrames(opts.frames));
  if (opts.shot) { const s = pickShot(film, opts.shot); a = s.in; b = s.out; }
  if (b > total) throw new RenderError('usage.frames-out-of-range', `帧区间 ${a}:${b} 超出片长（${total} 帧，0:${total}）`, { hint: `整片是 --frames 0:${total}；帧号含头不含尾` });
  return { a, b };
}

/** 运行目录（附录 C4）：作品 films/<名>/out/<运行号>/，《北冥》样片 out/beiming/<运行号>/；同一秒重名时等到下一秒 */
async function runDirectory(dir, env) {
  const abs = path.resolve(dir);
  const outRoot = abs === ROOT ? path.join(ROOT, 'out', 'beiming') : path.join(abs, 'out');
  for (let i = 0; ; i++) {
    const id = makeRunId(env);
    const d = path.join(outRoot, id);
    if (!fs.existsSync(d) || i >= 3) return { outRoot, id, dir: d };
    await sleep(1000 - (Date.now() % 1000) + 5);
  }
}

const OPTIONS = {
  out: { type: 'string', arg: '<文件.mp4>', describe: '输出；不写时是运行目录 films/<名>/out/<运行号>/master.mp4（《北冥》是 out/beiming/<运行号>/）' },
  ...pickOptions(['profile', 'size', 'fps', 'any-fps']),
  frames: { type: 'string', arg: 'a:b', describe: '只渲第 a 到 b−1 帧（整数帧号，含头不含尾）' },
  shot: { type: 'string', arg: '<镜头 id>', describe: '只渲 film.json 镜头表里的这一个镜头（v2 的 shots[].in/out）' },
  ...pickOptions(['workers', 'chunk', 'query', 'fast', 'crf', 'preset']),
  web: { type: 'string', arg: '<文件.mp4>', describe: '同一遍渲染再出一个网页版（crf 20、码率上限 14M、2 秒关键帧，宽 > 1920 时缩到 1920）' },
  'web-crf': { type: 'integer', min: 0, max: 51, default: 20, arg: '<n>', describe: '网页版的 crf（默认 20）' },
  ...pickOptions(['gpu', 'angle', 'allow-network', 'lenient-assets', 'allow-gl-errors', 'ready-timeout', 'frame-timeout', 'settle']),
  resume: { type: 'boolean', describe: '块放在 <输出>.parts/，失败或中断后保留；再加 --resume 只补渲没完成的块' },
  'keep-segments': { type: 'boolean', describe: '成功后也保留 <输出>.parts/（排查或给镜头缓存用）' },
  ...pickOptions(['progress']),
  plan: { type: 'boolean', describe: '只试渲几帧，估算总耗时与磁盘占用（不写输出）；磁盘不够预估的 1.5 倍退出码 3' },
  ...pickOptions(['slots', 'no-wait', 'wait-timeout', 'no-guard', 'run-json']),
};

export const command = renderCommand({
  name: 'engine/render/video.mjs',
  summary: '把影片页面逐帧渲染成 H.264 视频（无声；配声音用 engine/render/lib/mux.mjs）',
  usage: ['node engine/render/video.mjs [<影片目录>] [选项]'],
  description: [
    '影片目录要在仓库内、有 index.html，满足页面约定 v1（window.DUR / render(t) / READY，见 engine/render/README.md）。',
    '不写目录时是仓库根的《北冥》样片。环境变量 BEIMING_GPU、BEIMING_ANGLE 是 --gpu、--angle 的默认值。',
  ],
  positionals: [{ name: 'dir', label: '<影片目录>', describe: '仓库内的影片目录（默认 .，即《北冥》样片）', required: false, default: '.' }],
  options: OPTIONS,
  examples: [
    'node engine/render/video.mjs . --out out/video.mp4                    《北冥》样片，1920×1040',
    'node engine/render/video.mjs films/x --profile web-1080p24             出到 films/x/out/<运行号>/master.mp4',
    'node engine/render/video.mjs films/x --frames 72:120 --out out/x_72.mp4   只渲 48 帧',
    'node engine/render/video.mjs films/x --plan --json                      估算耗时与磁盘',
    'BEIMING_GPU=software-ok node engine/render/video.mjs films/x --size 320x180   CI / 没有 GPU 的机器',
  ],
}, main);

async function main({ opts, args, log, life, signal, setRunJson }) {
  life.defer(closeServer);
  const dir = args.dir ?? '.';
  locateFilm(dir);                                         // 找不到页面：退出码 2，不产生任何文件
  if (opts.frames && opts.shot) throw new RenderError('usage.conflict', '--frames 与 --shot 只能写一个', { hint: '--shot 等于该镜头的 --frames in:out' });
  if (opts.frames) parseFrames(opts.frames);                // 先校验写法，免得开了浏览器才报用法错误
  for (const k of ['ready-timeout', 'frame-timeout', 'wait-timeout']) positiveNumber(opts[k], `--${k}`);
  resolveGpuPolicy(opts.gpu ?? undefined); resolveAngle(opts.angle ?? undefined);   // --gpu / BEIMING_GPU、--angle / BEIMING_ANGLE 写错：开浏览器之前就报（退出码 2）
  const film = readFilm(dir);
  if (opts.shot) pickShot(film, opts.shot);
  const { size: { w, h }, fps: fpsReq, profile } = resolveOutputSpec({ opts, film });
  for (const m of profile?.warnings ?? []) log.warn(m, 'profiles', '档位表归作品描述包维护：engine/production/profiles.json');
  const intermediate = opts.fast ? 'jpeg' : 'png';
  const slots = opts.slots ?? slotCount();
  const ff = preflight();                                  // 缺 FFmpeg：退出码 3
  const env = environment(ROOT, { ffmpegVersion: ff.version });

  // 输出位置：--out，或运行目录（附录 C4）
  let out, runDir = null;
  if (opts.out) out = path.resolve(opts.out);
  else if (!opts.plan) { runDir = await runDirectory(dir, env); out = path.join(runDir.dir, 'master.mp4'); }
  else out = path.join(path.resolve(dir) === ROOT ? path.join(ROOT, 'out', 'beiming') : path.join(path.resolve(dir), 'out'), 'plan.mp4');   // --plan 不写输出：按运行目录的位置量磁盘、放试编码的临时文件
  const web = opts.web ? path.resolve(opts.web) : null;
  if (web && web === out) throw new RenderError('usage.conflict', '--web 不能与输出是同一个文件', { hint: '网页版另起一个文件名，例如 out/x_web.mp4' });
  const runJsonPath = path.resolve(opts['run-json'] ?? (runDir ? path.join(runDir.dir, 'run.json') : `${out}.run.json`));

  const isRoot = path.resolve(dir) === ROOT;
  const record = baseRecord({ command: 'video', argv: process.argv.slice(1).map(a => (path.isAbsolute(a) ? repoPath(ROOT, a) : a)), env,
    projectId: film?.id ?? (isRoot ? 'beiming' : path.basename(path.resolve(dir))),
    shotId: opts.shot ?? 'film', route: film?.route ?? (isRoot ? 'a' : null), backend: film?.backend ?? (isRoot ? 'three' : null) });
  record.runId = runDir?.id ?? makeRunId(env);
  record.profile = profile ? { id: profile.id, source: profile.source } : null;
  record.film = { dir: repoPath(ROOT, dir), query: opts.query || null, filmJson: film ? repoPath(ROOT, film.file) : null };
  const aigc = aigcMetadata({ film: film?.raw ?? null, runId: record.runId });
  record.aigc = aigc.comment ? { comment: aigc.comment, kinds: aigc.kinds, tools: aigc.tools, produceId: aigc.produceId } : null;

  const openOptions = {
    w, h, query: opts.query, gpu: opts.gpu ?? undefined, angle: opts.angle ?? undefined,
    allowNetwork: opts['allow-network'], lenientAssets: opts['lenient-assets'], allowGlErrors: opts['allow-gl-errors'],
    render: { fps: fpsReq, profile: profile?.id ?? null, frameCount: film?.output?.frameCount ?? null }, log, life,
  };
  if (opts['ready-timeout']) openOptions.readyTimeoutMs = opts['ready-timeout'] * 1000;

  // 计划模式：不写输出，不占锁
  if (opts.plan) return planMode({ dir, opts, log, signal, w, h, fpsReq, profile, film, intermediate, out, web, openOptions });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  life.defer(acquireLock(out));                            // 同一输出并发：退出码 5
  setRunJson(repoPath(ROOT, runJsonPath));
  const t0 = Date.now();
  let workDir = null, keepWork = false, finished = false;
  const finishRecord = async (status, extra = {}) => {
    finished = true;
    Object.assign(record, extra, { status, finishedAt: new Date().toISOString() });
    record.timing.totalSeconds = +((Date.now() - t0) / 1000).toFixed(2);
    record.warnings = log.warnings;
    record.selfCheck = await selfCheck(ROOT, record, { expectedFrameCount: record.output?.frames });
    writeRecord(runJsonPath, record);
  };
  writeRecord(runJsonPath, record);                       // 先占位：旧的运行记录不会被误当成这次的结果
  // 收尾（逆序执行）：先写失败记录（锁还在手里），再删临时目录
  life.defer(() => { if (workDir && !keepWork) fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  life.defer(async () => {
    if (finished) return;
    const e = signal.reason;
    const err = e instanceof RenderError || e?.code ? { code: e.code, message: e.message, hint: e.hint ?? null, exitCode: e.exitCode } : { code: 'failure.internal', message: String(e?.message ?? e ?? '未知错误'), hint: null, exitCode: 1 };
    record.stage = 'failed';
    await finishRecord('failed', { error: err }).catch(() => {});
  });

  const slot = await acquireSlot({ slots, wait: !opts['no-wait'], timeoutMs: (opts['wait-timeout'] ?? 1800) * 1000, signal, log });
  life.defer(slot);
  record.slots = slot.info;
  record.sharedGpu = await guardGpu({ enabled: !opts['no-guard'], wait: !opts['no-wait'], timeoutMs: (opts['wait-timeout'] ?? 1800) * 1000, signal, log });

  // 1) 探测：页面约定、GPU、帧率（探测页留给第 0 路复用）
  const ts = Date.now();
  const probeFilm = await openFilm(dir, { ...openOptions, handleSignals: false, signal });
  let handedOver = false;
  try {
    const { dur, pageFps } = probeFilm.contract;
    log.info(`GPU：${probeFilm.info.renderer || '未知'}（ANGLE ${probeFilm.info.angle}${probeFilm.info.software ? '，软件渲染' : ''}）`);
    const FPS = decideFps({ requested: fpsReq, pageFps, anyFps: opts['any-fps'], log });
    const TOTAL = Math.round(dur * FPS);
    if (TOTAL < 1) throw new RenderError('contract.dur', `DUR=${dur} 秒 × ${FPS} fps 不到 1 帧`, { hint: 'window.DUR 至少要有一帧长（1 / fps 秒）' });
    if (Math.abs(dur * FPS - TOTAL) > 1e-6) log.warn(`window.DUR × fps = ${dur * FPS} 不是整数帧，按 ${TOTAL} 帧渲（片长最好是 1/fps 的整数倍）`, 'dur-not-integer-frames');
    const fc = film?.output?.frameCount;
    if (Number.isInteger(fc) && fc !== TOTAL && !opts['any-fps']) {
      throw new RenderError('contract.frame-count', `页面时长 ${dur} 秒 × ${FPS} fps = ${TOTAL} 帧，与 film.json 的 ${fc} 帧不一致`, { hint: 'film.json 是唯一的时间源：让页面的 window.DUR 从 film.json 推出（frameCount / fps）' });
    }
    const { a, b } = frameRange({ opts, film, total: TOTAL });
    const chunks = planFilmChunks(a, b, { shots: film?.shots ?? [], chunk: opts.chunk ?? 'auto', fps: FPS });
    const crf = opts.crf ?? profile?.video?.crf ?? 14, preset = opts.preset ?? profile?.video?.preset ?? 'medium';
    const outputs = [{ kind: 'master', file: out, vf: COLOR[intermediate], args: [...x264Args({ crf, preset }), ...TAGS] }];
    if (web) {
      outputs.push({ kind: 'web', file: web, vf: (w > 1920 ? 'scale=1920:-2:flags=lanczos+accurate_rnd,' : '') + COLOR[intermediate],
        args: [...x264Args({ crf: opts['web-crf'], preset: 'slow', web: true, fps: FPS }), ...TAGS] });
    }
    const settle = opts.settle === 'auto' ? (probeFilm.info.angle === 'vulkan' ? 'raf2' : 'none') : opts.settle;
    Object.assign(record, {
      actualDevice: probeFilm.info.renderer || null, actualGraphicsBackend: `ANGLE ${probeFilm.info.angle}`, softwareFallback: probeFilm.info.software,
      gpu: probeFilm.info, page: probeFilm.contract,
      actualEncoder: `libx264 crf ${crf} preset ${preset}（${intermediate === 'png' ? '无损 PNG 截图' : 'JPEG q95 截图'} → yuv420p 有限范围 BT.709）`,
      render: { fps: FPS, width: w, height: h, frames: [a, b], workers: opts.workers, chunks: chunks.map(([x, y]) => [x, y]), intermediate, settle, renderer: rendererFingerprint() },
    });
    record.tools.browser = probeFilm.info.browserVersion;
    record.timing.setupSeconds = +((Date.now() - ts) / 1000).toFixed(2);

    // 2) 块目录：默认临时目录（任何结局都删）；--resume / --keep-segments 用 <输出>.parts/
    const persistent = Boolean(opts.resume || opts['keep-segments']);
    const { browserVersion: browser, angle, software } = probeFilm.info;   // 换了浏览器构建或 GPU 后端，像素可能不同：不能与旧块混拼
    const key = sha256(JSON.stringify({ dir: repoPath(ROOT, dir), q: opts.query, w, h, FPS, a, b, chunks, outputs: outputs.map(x => [x.kind, x.vf, x.args]), intermediate, settle, r: record.render.renderer, browser, angle, software })).slice(0, 16);
    if (persistent) {
      workDir = `${out}.parts`;
      // 开渲前先写下参数键：中断或失败后换了参数再续跑，旧块一块都不留（源文件变没变由每块的旁注核对，见 lib/chunks.mjs）
      if (fs.existsSync(workDir) && readJson(path.join(workDir, 'parts.json'))?.key !== key) {
        log.info(`${repoPath(ROOT, workDir)} 里的块与这次的参数不符：清空后重渲`);
        fs.rmSync(workDir, { recursive: true, force: true });
      }
      fs.mkdirSync(workDir, { recursive: true });
      writeJson(path.join(workDir, 'parts.json'), { key });
    } else {
      workDir = fs.mkdtempSync(path.join(path.dirname(out), '.segs-'));
    }
    keepWork = persistent;
    handedOver = true;
    const tr = Date.now();
    const r = await renderRange({
      dir, query: opts.query, w, h, fps: FPS, chunks, workers: opts.workers, intermediate, outputs, workDir,
      reuse: Boolean(opts.resume), key, openOptions, firstFilm: probeFilm, signal, live: life.procs, settle,
      frameTimeoutMs: opts['frame-timeout'] ? opts['frame-timeout'] * 1000 : undefined,
      onProgress: makeProgress(log, b - a),
    });
    record.timing.renderSeconds = +((Date.now() - tr) / 1000).toFixed(2);
    record.render.reusedChunks = r.stats.reusedChunks;
    record.render.renderedFrames = r.stats.renderedFrames;
    record.render.perFrameMs = r.stats.perFrameMs;
    record.network = { allowed: Boolean(opts['allow-network']), external: r.external };
    for (const wn of r.warnings) log.warn(wn.message, wn.code, wn.hint ?? null);
    record.frameHashes = { algo: `sha256/16 of ${intermediate} capture`, first: a, values: r.hashes };
    // 输入指纹：页面实际加载过的每个本地文件的内容哈希（脚本、贴图、字体、底板……），换机复现时先比它
    const inputs = await hashDeps(new Map([...r.deps].filter(([, st]) => st >= 200 && st < 300)));
    record.inputs = { files: Object.keys(inputs).length, digest: sha256(JSON.stringify(Object.entries(inputs))).slice(0, 16), missing: Object.entries(inputs).filter(([, h]) => h === null).map(([p]) => p) };

    // 3) 拼接、核对、原子改名
    const te = Date.now();
    const outputsDone = [];
    for (const x of outputs) {
      const p = await concatChunks(r.files[x.kind], x.file, { expectFrames: b - a, signal, live: life.procs, workDir, metadata: aigc.args });
      const sha = await sha256File(x.file);
      outputsDone.push({ path: repoPath(ROOT, x.file), sha256: sha, kind: x.kind === 'master' ? 'video' : 'web', probe: p });
    }
    record.timing.encodeSeconds = +((Date.now() - te) / 1000).toFixed(2);
    const m = outputsDone[0].probe.video;
    record.output = {
      path: outputsDone[0].path, sha256: outputsDone[0].sha256, width: m.width, height: m.height, fps: m.fps, frames: m.frames,
      duration: +(m.frames / FPS).toFixed(6), codec: m.codec, pixFmt: m.pixFmt, color: m.color,
    };
    if (outputsDone[1]) record.web = { path: outputsDone[1].path, sha256: outputsDone[1].sha256, ...outputsDone[1].probe.video };
    if (persistent && !opts['keep-segments']) { fs.rmSync(workDir, { recursive: true, force: true }); }
    record.stage = 'rendered';
    await finishRecord('running');
    if (runDir) writeLatest(runDir.outRoot, runDir.id);
    log.info(`完成 ${repoPath(ROOT, out)}  ${m.frames} 帧（${a}–${b - 1}）  ${m.width}×${m.height} ${FPS} fps  ${record.timing.totalSeconds}s${r.stats.reusedChunks ? `（复用 ${r.stats.reusedChunks} 块）` : ''}`);
    return {
      outputs: outputsDone.map(({ probe: _, ...o }) => o),
      data: { frames: m.frames, range: [a, b], fps: FPS, width: m.width, height: m.height, runId: record.runId, runDir: runDir ? repoPath(ROOT, runDir.dir) : null, reusedChunks: r.stats.reusedChunks, renderedFrames: r.stats.renderedFrames },
    };
  } finally {
    if (!handedOver) await probeFilm.close();
  }
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, j) => { const t = `${f}.tmp`; fs.writeFileSync(t, JSON.stringify(j)); fs.renameSync(t, f); };
async function hashDeps(deps) {
  const out = {};
  for (const p of [...deps.keys()].sort()) { try { out[p] = await sha256File(path.join(ROOT, p)); } catch { out[p] = null; } }
  return out;
}

/**
 * --plan：按真实的并行方式试渲一小段，估算整片耗时与磁盘；磁盘不够预估的 1.5 倍退出码 3（README「镜头缓存、续跑与估算」）。
 * 做法：打开与正式渲染相同路数的浏览器（量出起浏览器的时间），每路先渲一帧预热（着色器编译，不计入单帧），再同时各渲 k 帧，
 * 每路一个 FFmpeg 按正式参数编码，等全部编码结束。这样量到的“每路每帧”已经含了几路争 GPU / CPU、截图与编码的开销，
 * 不再用固定的并行效率去猜（单路量完乘效率在本机实测会少估 30–40%）。
 */
async function planMode({ dir, opts, log, signal, w, h, fpsReq, film, intermediate, out, web, profile, openOptions }) {
  const t0 = Date.now();
  const f = await openFilm(dir, { ...openOptions, handleSignals: false, signal });
  const setupSeconds = (Date.now() - t0) / 1000;
  const extra = [];
  const tmp = { dir: null };
  try {
    const FPS = decideFps({ requested: fpsReq, pageFps: f.contract.pageFps, anyFps: opts['any-fps'], log });
    const TOTAL = Math.round(f.contract.dur * FPS);
    const { a, b } = frameRange({ opts, film, total: TOTAL });
    const frames = b - a;
    const chunks = planFilmChunks(a, b, { shots: film?.shots ?? [], chunk: opts.chunk ?? 'auto', fps: FPS });
    const lanes = Math.max(1, Math.min(opts.workers, chunks.length));
    const k = Math.max(1, Math.min(8, Math.floor(frames / lanes) - 1));
    const crf = opts.crf ?? profile?.video?.crf ?? 14, preset = opts.preset ?? profile?.video?.preset ?? 'medium';
    const settle = opts.settle === 'auto' ? (f.info.angle === 'vulkan' ? 'raf2' : 'none') : opts.settle;

    // 1) 起其余几路浏览器（正式渲染时它们也要起）
    const ts = Date.now();
    for (let i = 1; i < lanes; i++) extra.push(openFilm(dir, { ...openOptions, handleSignals: false, signal }));
    const films = [f, ...(await Promise.all(extra))];
    const lanesSeconds = (Date.now() - ts) / 1000;

    // 2) 每路预热一帧（着色器编译），计入起步时间
    const starts = films.map((_, i) => a + Math.min(frames - k - 1, Math.floor(((i + 0.5) * frames) / lanes)));
    const tw = Date.now();
    await Promise.all(films.map((film_, i) => renderFrame(film_, Math.max(a, starts[i]) / FPS, { signal, settle }).then(() => film_.capture(intermediate))));
    const warmSeconds = (Date.now() - tw) / 1000;

    // 3) 几路同时各渲 k 帧，每路一个 FFmpeg 按正式参数编码
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    tmp.dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(out)), '.plan-'));
    const renderMs = [];
    const tc = Date.now();
    const lane = async (film_, i) => {
      const file = path.join(tmp.dir, `lane${i}.mp4`);
      const p = spawn(FFMPEG(), ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', intermediate === 'png' ? 'png' : 'mjpeg', '-i', '-',
        '-vf', COLOR[intermediate], ...x264Args({ crf, preset }), ...TAGS, file], { stdio: ['pipe', 'ignore', 'inherit'] });
      openOptions.life?.track(p);
      const exited = new Promise(r => { p.once('close', code => r(code)); p.once('error', () => r(-1)); });
      p.stdin.on('error', () => {});
      for (let j = 1; j <= k; j++) {
        const s0 = Date.now();
        await renderFrame(film_, Math.min(b - 1, Math.max(a, starts[i]) + j) / FPS, { signal, settle });
        const img = await film_.capture(intermediate);
        renderMs.push(Date.now() - s0);
        if (!p.stdin.write(img)) await Promise.race([new Promise(r => p.stdin.once('drain', r)), exited]);
      }
      p.stdin.end();
      const code = await exited;
      if (code !== 0) throw new RenderError('failure.ffmpeg', `试编码失败（退出码 ${code}）`, { hint: 'FFmpeg 自己的报错见上面' });
      return fs.statSync(file).size;
    };
    const sizes = await Promise.all(films.map(lane));
    const calSeconds = (Date.now() - tc) / 1000;
    const perLaneFrameMs = (calSeconds * 1000) / k;                 // 每路每帧（含争用、截图、编码与一块的收尾）
    const bytesPerFrame = sizes.reduce((x, y) => x + y, 0) / (lanes * k);
    renderMs.sort((x, y) => x - y);
    const outBytes = bytesPerFrame * frames * (web ? 1.35 : 1);
    const concatSeconds = 0.3 + outBytes / 250e6;
    const estSeconds = setupSeconds + lanesSeconds + warmSeconds + (frames / lanes) * perLaneFrameMs / 1000 + concatSeconds;
    const needBytes = outBytes * 2;                                  // 块文件 + 拼接后的输出同时在盘上
    let freeBytes = null;
    try { const st = fs.statfsSync(path.dirname(path.resolve(out))); freeBytes = st.bavail * st.bsize; } catch {}
    const plan = {
      frames, range: [a, b], fps: FPS, size: [w, h], workers: opts.workers, lanes, chunks: chunks.length, intermediate,
      sampleFramesPerLane: k, setupSeconds: +setupSeconds.toFixed(2), lanesSeconds: +lanesSeconds.toFixed(2), warmSeconds: +warmSeconds.toFixed(2),
      perLaneFrameMs: Math.round(perLaneFrameMs), renderCaptureMs: renderMs[Math.floor(renderMs.length / 2)] ?? null, bytesPerFrame: Math.round(bytesPerFrame),
      estSeconds: +estSeconds.toFixed(1), estOutputBytes: Math.round(outBytes), needBytes: Math.round(needBytes), freeBytes,
      gpu: f.info.renderer, software: f.info.software,
    };
    log.info(`计划：${frames} 帧，${lanes} 路，每路每帧约 ${plan.perLaneFrameMs} ms（含争用、截图与编码）→ 约 ${plan.estSeconds} 秒；`
      + `成片约 ${(outBytes / 2 ** 20).toFixed(0)} MB，渲染时需要 ${(needBytes / 2 ** 20).toFixed(0)} MB 磁盘${freeBytes !== null ? `（可用 ${(freeBytes / 2 ** 30).toFixed(1)} GB）` : ''}`);
    if (freeBytes !== null && freeBytes < needBytes * 1.5) {
      throw new RenderError('env.disk-insufficient', `磁盘不够：预计要 ${(needBytes / 2 ** 20).toFixed(0)} MB，可用 ${(freeBytes / 2 ** 20).toFixed(0)} MB（要求至少 1.5 倍余量）`, { hint: '换一个空间更大的 --out 目录，或先清理磁盘' });
    }
    return { data: { plan } };
  } finally {
    if (tmp.dir) fs.rmSync(tmp.dir, { recursive: true, force: true });
    await Promise.all([f, ...extra].map(x => Promise.resolve(x).then(y => y.close()).catch(() => {})));
  }
}

if (isMain(import.meta.url)) await runCli(command);
