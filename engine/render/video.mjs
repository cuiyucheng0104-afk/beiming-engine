// 北冥引擎 · 逐帧渲染成视频（渲染器 v2，规格见 engine/render/README.md）
//   node engine/render/video.mjs <影片目录> [--out out/video.mp4] [--profile web-1080p24 | --size WxH --fps 24] [--frames a:b | --shot S2]
//                                [--workers 4] [--web web.mp4] [--fast] [--resume] [--plan] [--json] …   完整选项：--help
//
// 流程：预检 FFmpeg → 输出锁（<输出>.lock，同一输出并发第二个退出码 5）→ 渲染槽位 / 共享 GPU 守卫 → 打开探测页（核对页面约定、
//   GPU、帧率）→ 帧区间切成固定的块（与 --workers 无关）→ 几路浏览器取块逐帧渲染 → 每帧无损截图（PNG），FFmpeg 只做一次
//   色彩换算（有限范围 BT.709，写明标记）编成 H.264 → 块拼接（复制，不重编码）→ 核对帧数 = 区间帧数 → 原子改名 → run.json。
// 成片与 --workers 无关（块的边界固定），同一提交、同一浏览器构建、同一 GPU 后端下逐字节可复现——前提是页面通过了确定性检查
//   （render(t) 只依赖 t；tools/baseline 的 determinism 检查）。--fast 改用 JPEG 截图（快约 2 倍、多一代有损），只用于预览。
// 帧率：页面的一拍二 / 一拍三按页面帧率量化。页面帧率 = window.FPS，没声明是引擎默认 24。--fps / --profile / film.json 给的帧率
//   与页面帧率不一致直接失败（退出码 4）；页面确实与帧率无关、或明知节奏会不均还要换帧率时加 --any-fps。
// 失败：任何一块出错（render 抛错、页面报错、缺素材、着色器错误、上下文丢失、软件渲染、FFmpeg 退出、收到 SIGINT / SIGTERM）都会
//   停下其余各块，关掉所有浏览器和 FFmpeg，删掉临时目录 <输出目录>/.segs-*，写 status=failed 的 run.json，以约定的退出码退出。
//   --resume 时块放在 <输出>.parts/，失败后保留，下次加 --resume 只补渲没完成的块。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openFilm, locateFilm, renderFrame, closeServer, ROOT } from './page.mjs';
import { runCli, RenderError, UsageError, EXIT } from './lib/cli.mjs';
import { GPU_POLICIES } from './lib/gpu.mjs';
import { preflight, COLOR, TAGS, x264Args, probe, FFMPEG } from './lib/ffmpeg.mjs';
import { acquireLock } from './lib/lock.mjs';
import { acquireSlot, guardGpu, slotCount } from './lib/slots.mjs';
import { environment, baseRecord, writeRecord, sha256File, selfCheck, repoPath, sha256 } from './lib/record.mjs';
import { resolveProfile } from './lib/profiles.mjs';
import { readFilm, pickShot } from './lib/film.mjs';
import { planChunks, renderRange, concatChunks } from './lib/chunks.mjs';

const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
export const SPEC = {
  command: 'engine/render/video.mjs',
  usage: 'node engine/render/video.mjs <影片目录> [选项]',
  summary: [
    '把影片页面逐帧渲染成 H.264 视频（无声；配声音用 engine/render/lib/mux.mjs）。影片目录要在仓库内、有 index.html，',
    '满足页面约定 v1（window.DUR / render(t) / READY）。不写目录时是仓库根的《北冥》样片。',
  ],
  positionals: { min: 0, max: 1, names: ['影片目录'] },
  options: {
    '--out': { type: 'string', arg: '<文件.mp4>', desc: '输出（默认 out/video.mp4）；旁边写 <输出>.run.json' },
    '--profile': { type: 'string', arg: '<档位>', desc: '交付档位（engine/production/profiles.json，如 web-1080p24、vertical-1080x1920-30）：给出尺寸与帧率' },
    '--size': { type: 'size', arg: 'WxH', desc: '画幅（偶数；默认按档位 / film.json，再默认 1920x1040）' },
    '--fps': { type: 'number', positive: true, arg: '<n>', desc: '帧率（默认按档位 / film.json / 页面的 window.FPS，再默认 24）' },
    '--any-fps': { type: 'flag', desc: '帧率与页面声明的不一致也照渲（一拍二 / 一拍三的节奏可能不均）' },
    '--frames': { type: 'frames', arg: 'a:b', desc: '只渲第 a 到 b−1 帧（整数帧号，含头不含尾）' },
    '--shot': { type: 'string', arg: '<镜头 id>', desc: '只渲 film.json 镜头表里的这一个镜头（v2 的 shots[].in/out）' },
    '--workers': { type: 'int', min: 1, max: 32, default: 4, arg: '<n>', desc: '并行浏览器路数（默认 4；不影响成片内容）' },
    '--chunk': { type: 'int', min: 1, max: 1000000, arg: '<帧数>', desc: '块长（默认按区间自动：总帧 / 8，夹在 1–10 秒）；改它会改变码流' },
    '--query': { type: 'string', default: '', arg: 'k=v&…', desc: '页面 URL 参数（例如 test=kun 渲 lab 自测页）' },
    '--fast': { type: 'flag', desc: '用 JPEG 截图（预览：快、多一代有损）；默认无损 PNG' },
    '--crf': { type: 'int', min: 0, max: 51, arg: '<n>', desc: '主输出的 x264 crf（默认按档位，再默认 14）' },
    '--preset': { type: 'enum', choices: PRESETS, arg: '<名字>', desc: '主输出的 x264 preset（默认按档位，再默认 medium）' },
    '--web': { type: 'string', arg: '<文件.mp4>', desc: '同一遍渲染再出一个网页版（crf 20、码率上限 14M、2 秒关键帧，宽 > 1920 时缩到 1920）' },
    '--web-crf': { type: 'int', min: 0, max: 51, default: 20, arg: '<n>', desc: '网页版的 crf（默认 20）' },
    '--gpu': { type: 'enum', choices: GPU_POLICIES, arg: '<策略>', desc: 'required（默认）：软件渲染判失败 | any：允许并记提示 | software-ok：CI / 无 GPU 机器' },
    '--angle': { type: 'string', arg: '<后端>', desc: 'ANGLE 后端（默认 BEIMING_ANGLE，再默认 macOS metal / Windows vulkan / Linux default）' },
    '--allow-network': { type: 'flag', desc: '放行页面的外网请求（默认拦截并判失败；放行的地址记进 run.json）' },
    '--lenient-assets': { type: 'flag', desc: '非脚本类的本地 404 只记提示（页面自己有回退时用）' },
    '--allow-gl-errors': { type: 'flag', desc: '着色器错误只记提示（调试用，产物不能交付）' },
    '--ready-timeout': { type: 'number', positive: true, arg: '<秒>', desc: '等 window.READY 的上限（默认 BEIMING_READY_TIMEOUT，再默认 180）' },
    '--frame-timeout': { type: 'number', positive: true, arg: '<秒>', desc: '单帧 render(t) 的上限（默认 BEIMING_FRAME_TIMEOUT，再默认 120）' },
    '--settle': { type: 'enum', choices: ['auto', 'none', 'raf2'], default: 'auto', arg: '<方式>', desc: 'render 后截图前：raf2 再等两帧（Vulkan 显示层残留的对策）；auto 只在 vulkan 时用 raf2' },
    '--resume': { type: 'flag', desc: '块放在 <输出>.parts/，失败或中断后保留；再加 --resume 只补渲没完成的块' },
    '--keep-segments': { type: 'flag', desc: '成功后也保留 <输出>.parts/（排查或给镜头缓存用）' },
    '--progress': { type: 'enum', choices: ['text', 'ndjson', 'none'], default: 'text', arg: '<格式>', desc: '进度：text（默认）| ndjson（stderr 每行一个 JSON 事件）| none' },
    '--plan': { type: 'flag', desc: '只试渲几帧，估算总耗时与磁盘占用（不写输出）；磁盘不够预估的 1.5 倍退出码 3' },
    '--slots': { type: 'int', min: 1, max: 256, arg: '<n>', desc: '机器级渲染槽位（默认 RENDER_SLOTS；不设不限）' },
    '--no-wait': { type: 'flag', desc: '槽位满或共享 GPU 忙时不排队，直接退出码 5' },
    '--wait-timeout': { type: 'number', positive: true, arg: '<秒>', desc: '排队的上限（默认 1800 秒，超时退出码 124）' },
    '--no-guard': { type: 'flag', desc: '不查共享 GPU（nvidia-smi 占用 / ComfyUI 队列）' },
    '--run-json': { type: 'string', arg: '<文件>', desc: '运行记录写到哪（默认 <输出>.run.json）' },
    '--json': { type: 'flag', desc: 'stdout 只输出一个结果对象（人看的日志都在 stderr）' },
  },
  examples: [
    'node engine/render/video.mjs . --out out/video.mp4                    《北冥》样片，1920×1040',
    'node engine/render/video.mjs films/x --profile web-1080p24 --web out/x_web.mp4',
    'node engine/render/video.mjs films/x --frames 72:120 --out out/x_72.mp4   只渲 48 帧',
    'node engine/render/video.mjs films/x --plan --json                      估算耗时与磁盘',
    'BEIMING_GPU=software-ok node engine/render/video.mjs films/x --size 320x180   CI / 没有 GPU 的机器',
  ],
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 渲染器自身的版本指纹：engine/render 下脚本与 lib 的内容哈希（断点续跑与镜头缓存的键都含它） */
export function rendererFingerprint() {
  const h = createHash('sha256');
  const files = ['page.mjs', 'video.mjs', 'shots.mjs', ...fs.readdirSync(path.join(HERE, 'lib')).filter(n => n.endsWith('.mjs')).sort().map(n => `lib/${n}`)];
  for (const f of files) { try { h.update(f).update(fs.readFileSync(path.join(HERE, f))); } catch {} }
  return h.digest('hex').slice(0, 16);
}

/** 解析尺寸、帧率请求与档位（命令行 > 档位 > film.json > 默认）；两处显式写法冲突是用法错误 */
export function resolveOutputSpec({ opts, explicit, film }) {
  const profileId = opts['--profile'] ?? film?.output?.profile ?? null;
  const profile = profileId ? resolveProfile(profileId, ROOT) : null;
  const fromFilm = film?.output ?? {};
  let size = opts['--size'] ?? null;
  if (size && profile && explicit.has('--profile') && (size.w !== profile.width || size.h !== profile.height)) {
    throw new UsageError(`--size ${size.w}x${size.h} 与档位 ${profile.id} 的 ${profile.width}x${profile.height} 不一致`, '去掉 --size 按档位出，或换一个档位');
  }
  size ??= profile ? { w: profile.width, h: profile.height } : fromFilm.width && fromFilm.height ? { w: fromFilm.width, h: fromFilm.height } : { w: 1920, h: 1040 };
  let fps = opts['--fps'] ?? null;
  if (fps !== null && profile && explicit.has('--profile') && Math.abs(fps - profile.fps) > 1e-9) {
    throw new UsageError(`--fps ${fps} 与档位 ${profile.id} 的 ${profile.fps} fps 不一致`, '去掉 --fps 按档位出，或换一个档位');
  }
  fps ??= profile?.fps ?? fromFilm.fps ?? null;
  return { size, fps, profile };
}

/** 页面帧率与请求帧率的核对（返回实际渲染帧率） */
export function decideFps({ requested, pageFps, anyFps, log }) {
  const pageRate = pageFps ?? 24;
  const whose = pageFps !== null && pageFps !== undefined ? `页面声明的 window.FPS=${pageFps} ` : '页面帧率 24（页面没有声明 window.FPS，按引擎默认 24 fps 量化）';
  if (requested !== null && Math.abs(requested - pageRate) > 1e-9) {
    if (!anyFps) {
      throw new RenderError('contract-fps-mismatch', `请求的帧率 ${requested} 与${whose}不一致：一拍二 / 一拍三按 ${pageRate} fps 量化，换成 ${requested} fps 节奏会抖`, {
        exitCode: EXIT.CONTRACT,
        hint: `去掉 --fps 按 ${pageRate} fps 渲；页面按别的帧率编写就在页面里声明 window.FPS（或读 window.__RENDER.fps）；确认与帧率无关或接受节奏不均，加 --any-fps`,
      });
    }
    log.warn(`--any-fps：按 ${requested} fps 渲染，但${whose}，一拍二 / 一拍三的节奏可能不均匀`, 'fps-mismatch-allowed');
  }
  return requested ?? pageRate;
}

function makeProgress(log, mode, total) {
  const t0 = Date.now();
  let last = 0, lastDone = -1;
  return ({ done, reused = 0 }) => {
    if (mode === 'none') return;
    const now = Date.now();
    if (done < total && now - last < (mode === 'ndjson' ? 1000 : 2000)) return;
    if (done === lastDone && done < total) return;
    last = now; lastDone = done;
    const fresh = done - reused, secs = (now - t0) / 1000;
    const rate = secs > 0 ? fresh / secs : 0;
    const eta = rate > 0 ? Math.round((total - done) / rate) : null;
    log.progress({ done, total, reused, fps: +rate.toFixed(2), etaSec: eta },
      `渲染 ${done}/${total} 帧（${Math.round((100 * done) / total)}%）${reused ? `，复用 ${reused} 帧` : ''}  ${rate.toFixed(1)} 帧/秒${eta !== null && done < total ? `  预计还要 ${eta} 秒` : ''}`);
  };
}

async function main({ opts, args, explicit, log, signal, cleanup, setRunJson }) {
  cleanup(closeServer);
  const dir = args[0] ?? '.';
  locateFilm(dir);                                         // 找不到页面：退出码 2，不产生任何文件
  if (opts['--frames'] && opts['--shot']) throw new UsageError('--frames 与 --shot 只能写一个');
  const film = readFilm(dir);
  const { size: { w, h }, fps: fpsReq, profile } = resolveOutputSpec({ opts, explicit, film });
  const intermediate = opts['--fast'] ? 'jpeg' : 'png';
  const out = path.resolve(opts['--out'] ?? 'out/video.mp4');
  const web = opts['--web'] ? path.resolve(opts['--web']) : null;
  if (web && web === out) throw new UsageError('--web 不能与 --out 是同一个文件');
  const runJsonPath = path.resolve(opts['--run-json'] ?? `${out}.run.json`);
  const slots = opts['--slots'] ?? slotCount();
  const ff = preflight();                                  // 缺 FFmpeg：退出码 3

  const env = environment(ROOT, { ffmpegVersion: ff.version });
  const record = baseRecord({ command: 'video', argv: process.argv.slice(1).map(a => (path.isAbsolute(a) ? repoPath(ROOT, a) : a)), env,
    projectId: film?.id ?? (path.resolve(dir) === ROOT ? 'beiming' : path.basename(path.resolve(dir))),
    shotId: opts['--shot'] ?? 'film', route: film?.route ?? (path.resolve(dir) === ROOT ? 'a' : null), backend: film?.backend ?? 'page' });
  record.profile = profile ? { id: profile.id, source: profile.source } : null;
  record.film = { dir: repoPath(ROOT, dir), query: opts['--query'] || null, filmJson: film ? repoPath(ROOT, film.file) : null };

  // 计划模式：不写输出，不占锁
  if (opts['--plan']) return planMode({ dir, opts, log, signal, w, h, fpsReq, profile, film, intermediate, out, web });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const release = acquireLock(out);                       // 同一输出并发：退出码 5
  cleanup(release);
  const live = new Set();
  const killAll = () => { for (const p of live) { try { p.kill('SIGKILL'); } catch {} } };
  process.on('exit', killAll);
  cleanup(() => process.removeListener('exit', killAll));
  setRunJson(repoPath(ROOT, runJsonPath));
  const t0 = Date.now();
  let workDir = null, keepWork = false;
  const finishRecord = async (status, extra = {}) => {
    Object.assign(record, extra, { status, finishedAt: new Date().toISOString() });
    record.timing.totalSeconds = +((Date.now() - t0) / 1000).toFixed(2);
    record.warnings = log.warnings;
    record.selfCheck = await selfCheck(ROOT, record, { expectedFrameCount: record.output?.frames });
    writeRecord(runJsonPath, record);
  };
  writeRecord(runJsonPath, record);                       // 先占位：旧的 run.json 不会被误当成这次的结果
  try {
    const slot = await acquireSlot({ slots, wait: !opts['--no-wait'], timeoutMs: (opts['--wait-timeout'] ?? 1800) * 1000, signal, log });
    cleanup(slot);
    record.slots = slot.info;
    record.sharedGpu = await guardGpu({ enabled: !opts['--no-guard'], wait: !opts['--no-wait'], timeoutMs: (opts['--wait-timeout'] ?? 1800) * 1000, signal, log });
    const openOptions = {
      w, h, query: opts['--query'], gpu: opts['--gpu'], angle: opts['--angle'],
      allowNetwork: Boolean(opts['--allow-network']), lenientAssets: Boolean(opts['--lenient-assets']), allowGlErrors: Boolean(opts['--allow-gl-errors']),
      readyTimeoutMs: opts['--ready-timeout'] ? opts['--ready-timeout'] * 1000 : undefined,
      render: { fps: fpsReq, profile: profile?.id ?? null, frameCount: film?.output?.frameCount ?? null }, log,
    };
    if (openOptions.readyTimeoutMs === undefined) delete openOptions.readyTimeoutMs;

    // 1) 探测：页面约定、GPU、帧率（探测页留给第 0 路复用）
    const ts = Date.now();
    const probeFilm = await openFilm(dir, { ...openOptions, handleSignals: false, signal });
    let handedOver = false;
    try {
      const { dur, pageFps } = probeFilm.contract;
      log.info(`GPU：${probeFilm.info.renderer || '未知'}（ANGLE ${probeFilm.info.angle}${probeFilm.info.software ? '，软件渲染' : ''}）`);
      const FPS = decideFps({ requested: fpsReq, pageFps, anyFps: Boolean(opts['--any-fps']), log });
      const TOTAL = Math.round(dur * FPS);
      if (TOTAL < 1) throw new RenderError('contract-dur', `DUR=${dur} 秒 × ${FPS} fps 不到 1 帧`, { exitCode: EXIT.CONTRACT });
      if (Math.abs(dur * FPS - TOTAL) > 1e-6) log.warn(`window.DUR × fps = ${dur * FPS} 不是整数帧，按 ${TOTAL} 帧渲（片长最好是 1/fps 的整数倍）`, 'dur-not-integer-frames');
      const fc = film?.output?.frameCount;
      if (Number.isInteger(fc) && fc !== TOTAL && !opts['--any-fps']) {
        throw new RenderError('contract-frame-count', `页面时长 ${dur} 秒 × ${FPS} fps = ${TOTAL} 帧，与 film.json 的 ${fc} 帧不一致`, { exitCode: EXIT.CONTRACT, hint: 'film.json 是唯一的时间源：让页面的 window.DUR 从 film.json 推出（frameCount / fps）' });
      }
      let a = 0, b = TOTAL;
      if (opts['--frames']) ({ a, b } = opts['--frames']);
      if (opts['--shot']) { const s = pickShot(film, opts['--shot']); a = s.in; b = s.out; }
      if (b > TOTAL) throw new UsageError(`帧区间 ${a}:${b} 超出片长（${TOTAL} 帧，0:${TOTAL}）`);
      const chunks = planChunks(a, b, { chunk: opts['--chunk'] ?? 'auto', fps: FPS });
      const crf = opts['--crf'] ?? profile?.video?.crf ?? 14, preset = opts['--preset'] ?? profile?.video?.preset ?? 'medium';
      const outputs = [{ kind: 'master', file: out, vf: COLOR[intermediate], args: [...x264Args({ crf, preset }), ...TAGS] }];
      if (web) {
        outputs.push({ kind: 'web', file: web, vf: (w > 1920 ? 'scale=1920:-2:flags=lanczos+accurate_rnd,' : '') + COLOR[intermediate],
          args: [...x264Args({ crf: opts['--web-crf'], preset: 'slow', web: true, fps: FPS }), ...TAGS] });
      }
      const settle = opts['--settle'] === 'auto' ? (probeFilm.info.angle === 'vulkan' ? 'raf2' : 'none') : opts['--settle'];
      Object.assign(record, {
        actualDevice: probeFilm.info.renderer || null, actualGraphicsBackend: `ANGLE ${probeFilm.info.angle}`, softwareFallback: probeFilm.info.software,
        gpu: probeFilm.info, page: probeFilm.contract,
        actualEncoder: `libx264 crf ${crf} preset ${preset}（${intermediate === 'png' ? '无损 PNG 截图' : 'JPEG q95 截图'} → yuv420p 有限范围 BT.709）`,
        render: { fps: FPS, width: w, height: h, frames: [a, b], workers: opts['--workers'], chunks: chunks.map(([x, y]) => [x, y]), intermediate, settle, renderer: rendererFingerprint() },
      });
      record.tools.browser = probeFilm.info.browserVersion;
      record.timing.setupSeconds = +((Date.now() - ts) / 1000).toFixed(2);

      // 2) 块目录：默认临时目录（任何结局都删）；--resume / --keep-segments 用 <输出>.parts/
      const persistent = Boolean(opts['--resume'] || opts['--keep-segments']);
      const key = sha256(JSON.stringify({ dir: repoPath(ROOT, dir), q: opts['--query'], w, h, FPS, a, b, chunks, outputs: outputs.map(x => [x.kind, x.vf, x.args]), intermediate, settle, r: record.render.renderer })).slice(0, 16);
      if (persistent) {
        workDir = `${out}.parts`;
        const manifest = readJson(path.join(workDir, 'parts.json'));
        if (manifest && (manifest.key !== key || !depsUnchanged(manifest.deps))) {
          log.info(`${repoPath(ROOT, workDir)} 里的块与这次的参数或源文件不符：清空后重渲`);
          fs.rmSync(workDir, { recursive: true, force: true });
        }
        fs.mkdirSync(workDir, { recursive: true });
      } else {
        workDir = fs.mkdtempSync(path.join(path.dirname(out), '.segs-'));
      }
      keepWork = persistent;
      handedOver = true;
      const tr = Date.now();
      const r = await renderRange({
        dir, query: opts['--query'], w, h, fps: FPS, chunks, workers: opts['--workers'], intermediate, outputs, workDir,
        reuse: Boolean(opts['--resume']), openOptions, firstFilm: probeFilm, signal, live, settle,
        frameTimeoutMs: opts['--frame-timeout'] ? opts['--frame-timeout'] * 1000 : undefined,
        onProgress: makeProgress(log, opts['--progress'], b - a),
      });
      if (persistent) writeJson(path.join(workDir, 'parts.json'), { key, deps: await hashDeps(r.deps) });
      record.timing.renderSeconds = +((Date.now() - tr) / 1000).toFixed(2);
      record.render.reusedChunks = r.stats.reusedChunks;
      record.render.renderedFrames = r.stats.renderedFrames;
      record.render.perFrameMs = r.stats.perFrameMs;
      record.network = { allowed: Boolean(opts['--allow-network']), external: r.external };
      for (const wn of r.warnings) if (!log.warnings.some(x => x.message === wn.message)) log.warnings.push(wn);
      record.frameHashes = { algo: `sha256/16 of ${intermediate} capture`, first: a, values: r.hashes };
      record.deps = { files: r.deps.size, digest: sha256(JSON.stringify([...r.deps.keys()].sort())).slice(0, 16) };

      // 3) 拼接、核对、原子改名
      const te = Date.now();
      const outputsDone = [];
      for (const x of outputs) {
        const p = await concatChunks(r.files[x.kind], x.file, { expectFrames: b - a, signal, live, workDir });
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
      if (persistent && !opts['--keep-segments']) { fs.rmSync(workDir, { recursive: true, force: true }); }
      await finishRecord('rendered');
      log.info(`完成 ${repoPath(ROOT, out)}  ${m.frames} 帧（${a}–${b - 1}）  ${m.width}×${m.height} ${FPS} fps  ${record.timing.totalSeconds}s${r.stats.reusedChunks ? `（复用 ${r.stats.reusedChunks} 块）` : ''}`);
      return { outputs: outputsDone.map(({ probe: _, ...o }) => o), extra: { frames: m.frames, range: [a, b], fps: FPS } };
    } finally {
      if (!handedOver) await probeFilm.close();
    }
  } catch (e) {
    const err = e instanceof RenderError ? { code: e.code, message: e.message, hint: e.hint, exitCode: e.exitCode } : { code: 'internal', message: String(e?.message ?? e), exitCode: 1 };
    await finishRecord('failed', { error: err }).catch(() => {});
    throw e;
  } finally {
    killAll();
    if (workDir && !keepWork) { try { fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { log.warn(`临时目录没删掉：${workDir}（${e.message}）`, 'cleanup'); } }
  }
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, j) => { const t = `${f}.tmp`; fs.writeFileSync(t, JSON.stringify(j)); fs.renameSync(t, f); };
async function hashDeps(deps) {
  const out = {};
  for (const p of [...deps.keys()].sort()) { try { out[p] = await sha256File(path.join(ROOT, p)); } catch { out[p] = null; } }
  return out;
}
function depsUnchanged(recorded) {
  if (!recorded) return false;
  for (const [p, h] of Object.entries(recorded)) {
    let now = null;
    try { now = createHash('sha256').update(fs.readFileSync(path.join(ROOT, p))).digest('hex'); } catch {}
    if (now !== h) return false;
  }
  return true;
}

/** --plan：试渲几帧，量出单帧耗时、单帧编码耗时与体积，估算总时长与磁盘；磁盘不够 1.5 倍退出码 3 */
async function planMode({ dir, opts, log, signal, w, h, fpsReq, profile, film, intermediate, out, web }) {
  const t0 = Date.now();
  const f = await openFilm(dir, {
    w, h, query: opts['--query'], gpu: opts['--gpu'], angle: opts['--angle'], allowNetwork: Boolean(opts['--allow-network']),
    lenientAssets: Boolean(opts['--lenient-assets']), handleSignals: false, signal, log,
    render: { fps: fpsReq, profile: profile?.id ?? null, frameCount: film?.output?.frameCount ?? null },
  });
  const setupSeconds = (Date.now() - t0) / 1000;
  try {
    const FPS = decideFps({ requested: fpsReq, pageFps: f.contract.pageFps, anyFps: Boolean(opts['--any-fps']), log });
    const TOTAL = Math.round(f.contract.dur * FPS);
    let a = 0, b = TOTAL;
    if (opts['--frames']) ({ a, b } = opts['--frames']);
    if (opts['--shot']) { const s = pickShot(film, opts['--shot']); a = s.in; b = s.out; }
    if (b > TOTAL) throw new UsageError(`帧区间 ${a}:${b} 超出片长（${TOTAL} 帧）`);
    const n = Math.min(8, b - a);
    const sample = Array.from({ length: n }, (_, i) => a + Math.floor(((i + 0.5) * (b - a)) / n));
    await renderFrame(f, sample[0] / FPS, { signal }); await f.capture(intermediate);   // 预热一帧，不计时
    const imgs = [], ms = [];
    for (const fr of sample) {
      const s = Date.now();
      await renderFrame(f, fr / FPS, { signal });
      imgs.push(await f.capture(intermediate));
      ms.push(Date.now() - s);
    }
    // 编码：把这几帧真的编一遍，量单帧编码耗时与体积
    const crf = opts['--crf'] ?? profile?.video?.crf ?? 14, preset = opts['--preset'] ?? profile?.video?.preset ?? 'medium';
    const tmp = fs.mkdtempSync(path.join(path.dirname(path.resolve(out)), '.plan-'));
    let encMs = null, bytesPerFrame = null;
    try {
      const file = path.join(tmp, 'sample.mp4');
      const s = Date.now();
      await new Promise((resolve, reject) => {
        const p = spawn(FFMPEG(), ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', intermediate === 'png' ? 'png' : 'mjpeg', '-i', '-',
          '-vf', COLOR[intermediate], ...x264Args({ crf, preset }), ...TAGS, file], { stdio: ['pipe', 'ignore', 'inherit'] });
        p.on('error', reject); p.on('close', c => (c === 0 ? resolve() : reject(new RenderError('ffmpeg-failed', `试编码失败（退出码 ${c}）`))));
        p.stdin.on('error', () => {});
        for (const img of imgs) p.stdin.write(img);
        p.stdin.end();
      });
      encMs = (Date.now() - s) / n;
      bytesPerFrame = fs.statSync(file).size / n;
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    ms.sort((x, y) => x - y);
    const frameMs = ms[Math.floor(ms.length / 2)];
    const frames = b - a, chunks = planChunks(a, b, { chunk: opts['--chunk'] ?? 'auto', fps: FPS }).length;
    const lanes = Math.max(1, Math.min(opts['--workers'], chunks));
    // 每路：渲染与截图串行，编码在 FFmpeg 里并行跟上；多路共享 CPU / GPU，并行效率按 0.75 估（README「性能模型」）
    const perLane = Math.max(frameMs, encMs ?? 0);
    const estSeconds = setupSeconds + (frames * perLane) / 1000 / (lanes > 1 ? lanes * 0.75 : 1) + 1;
    const outBytes = bytesPerFrame * frames * (web ? 1.35 : 1);
    const needBytes = outBytes * 2;                         // 块文件 + 拼接后的输出同时在盘上
    let freeBytes = null;
    try { const st = fs.statfsSync(path.dirname(path.resolve(out))); freeBytes = st.bavail * st.bsize; } catch {}
    const plan = {
      frames, range: [a, b], fps: FPS, size: [w, h], workers: opts['--workers'], lanes, chunks, intermediate,
      sampleFrames: sample, renderCaptureMs: frameMs, encodeMsPerFrame: encMs && +encMs.toFixed(1), bytesPerFrame: Math.round(bytesPerFrame),
      setupSeconds: +setupSeconds.toFixed(2), estSeconds: +estSeconds.toFixed(1), estOutputBytes: Math.round(outBytes), needBytes: Math.round(needBytes), freeBytes,
      gpu: f.info.renderer, software: f.info.software,
    };
    log.info(`计划：${frames} 帧 × ${frameMs} ms（渲染 + 截图），编码 ${plan.encodeMsPerFrame} ms/帧，${lanes} 路 → 约 ${plan.estSeconds} 秒；`
      + `成片约 ${(outBytes / 2 ** 20).toFixed(0)} MB，渲染时需要 ${(needBytes / 2 ** 20).toFixed(0)} MB 磁盘${freeBytes !== null ? `（可用 ${(freeBytes / 2 ** 30).toFixed(1)} GB）` : ''}`);
    if (freeBytes !== null && freeBytes < needBytes * 1.5) {
      throw new RenderError('disk-insufficient', `磁盘不够：预计要 ${(needBytes / 2 ** 20).toFixed(0)} MB，可用 ${(freeBytes / 2 ** 20).toFixed(0)} MB（要求至少 1.5 倍余量）`, { exitCode: EXIT.ENV, hint: '换一个空间更大的 --out 目录，或先清理磁盘' });
    }
    return { extra: { plan } };
  } finally { await f.close(); }
}

const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) await runCli(SPEC, main);
