// 北冥仓库 · 出片编排 · D 路线（北冥光追 · 物理路径追踪，决定 D13）步骤定义。
// 与页面型（engine/render/build.mjs）和 B 原生（tools/film/lib/native-steps.mjs）平级，共用运行目录、缓存、联系表、播放页、机器 QA 与 run.json：
//   preflight  经 engine/pathtrace/runtime.mjs 的 resolvePathtrace 解析并核对 threert-render 可执行文件与预设目录；
//              跑 threert-render info 记录 GPU / 后端并拦截软件渲染（--gpu required 时退出码 3）
//   bundle     经 engine/pathtrace/bundle.mjs 的 bundlePathtraceFilm 打包 scene.ts → work/scene.bundle.js，
//              并在 QuickJS / Node 侧逐帧探测写出 events.json、timeline.json 与 work/texts.json
//   mix        复用 engine/render/build.mjs 的 mix（mix.py / wav → audio/mix.wav）
//   cuecheck   复用 engine/render/build.mjs 的 cuecheck（film.json 写了 cuecheck 时跑）
//   pathtrace  启动常驻进程 threert-render serve --presets <presetsDir>，通过 stdin 喂入 JSONL 逐帧任务；
//              帧级缓存存于 <outRoot>/cache/pt-frames/<sceneKey>/f_NNNNNN.png（未改动镜头与帧 0 秒硬链接复用）；
//              PNG 序列经 FFmpeg 一次性换算为 BT.709 tv yuv420p（libx264 CRF 14/20 或 --encoder nvenc h264_nvenc，精确 CFR）→ work/video.mp4
//   mux / preview  复用 engine/render/build.mjs 的 mux（→ master.mp4）与 preview（→ animatic.mp4）
// 另导出 renderPathtraceFrames（供 film stills / film render 调帧级缓存）与 planPathtrace（供 film plan 试渲估算）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXIT, FilmError } from './exit.mjs';
import { ROOT } from './repo.mjs';
import { linkOrCopy } from './cache.mjs';
import { mix, cuecheck, mux, preview } from '../../../engine/render/build.mjs';
import { COLOR, TAGS } from '../../../engine/render/lib/ffmpeg.mjs';

const SOFTWARE_RE = /swiftshader|llvmpipe|lavapipe|softpipe|software|basic render|\bwarp\b/i;
const pad6 = n => String(n).padStart(6, '0');
const ptFrameName = n => `f_${pad6(n)}.png`;

const listRel = (runDir, sub) => {
  const d = path.join(runDir, sub);
  return fs.existsSync(d) ? fs.readdirSync(d).filter(n => fs.statSync(path.join(d, n)).isFile()).sort().map(n => `${sub}/${n}`) : [];
};

async function loadRuntimeMod(override = null) {
  if (override) return override;
  const file = path.join(ROOT, 'engine/pathtrace/runtime.mjs');
  if (!fs.existsSync(file)) {
    throw new FilmError(EXIT.ENV, 'pathtrace-module-missing', '找不到光追运行时模块 engine/pathtrace/runtime.mjs',
      '确认仓库包含 engine/pathtrace/，并安装光追运行时缓存或设 BEIMING_PT_BIN');
  }
  return import(pathToFileURL(file).href);
}

async function loadBundleMod(override = null) {
  if (override) return override;
  const file = path.join(ROOT, 'engine/pathtrace/bundle.mjs');
  if (!fs.existsSync(file)) {
    throw new FilmError(EXIT.ENV, 'pathtrace-bundle-missing', '找不到光追打包模块 engine/pathtrace/bundle.mjs',
      '确认仓库包含 engine/pathtrace/');
  }
  return import(pathToFileURL(file).href);
}

export async function ensurePathtraceRuntime(ctx, opts = {}) {
  if (ctx.ptRuntime && ctx.nativeDevice) return ctx.ptRuntime;
  const mod = await loadRuntimeMod(opts.runtime);
  let rt;
  try {
    rt = await mod.resolvePathtrace({ env: ctx.env || process.env, cwd: ROOT });
  } catch (e) {
    throw new FilmError(EXIT.ENV, e?.code || 'pathtrace-missing', e?.message || '找不到光追运行时 threert-render',
      e?.hint || '把光追运行时装进默认缓存 ~/.cache/beiming/pathtrace/<version>/，或设 BEIMING_PT_BIN 指向 threert-render 可执行文件');
  }
  let info = opts.gpuInfo || null;
  if (!info) {
    const r = await ctx.exec(rt.exe, ['info'], { label: '光追运行时设备探测（threert-render info）', quiet: true, timeoutSec: 30, sweep: false });
    try { info = JSON.parse(String(r.stdout || '').trim()); } catch { info = { adapter: String(r.stdout || '').trim() || 'Unknown GPU', backend: 'wgpu', hwrt: false }; }
  }
  const adapter = info.adapter || 'Unknown GPU';
  const software = info.device_type === 'Cpu' || SOFTWARE_RE.test(adapter);
  if (software) {
    const msg = `光追运行时落到了软件渲染（${adapter}）：正式出片与关键帧要求硬件 GPU`;
    if ((ctx.opts?.gpu ?? 'required') === 'required') {
      ctx.fail(EXIT.ENV, 'software-render', msg, '检查 NVIDIA Vulkan / Apple Metal 驱动是否可用；仅在 CI 冒烟时加 --gpu software-ok');
    }
    ctx.warn('software-render', msg);
    ctx.gpu = adapter;
  }
  const backendLabel = `wgpu / ${info.backend || 'GPU'} (ThreeRT${info.hwrt ? ', HWRT' : ''})`;
  ctx.ptRuntime = rt;
  ctx.nativeDevice = { device: adapter, backend: backendLabel, hwrt: !!info.hwrt, oidn: !!rt.oidn, software };
  return rt;
}

function effectiveFilmJson(ctx) {
  if (ctx.filmEffective?.path && fs.existsSync(ctx.filmEffective.path)) {
    try { return JSON.parse(fs.readFileSync(ctx.filmEffective.path, 'utf8')); } catch { /* 退回原始 film.json */ }
  }
  return ctx.film.raw;
}

export function resolvePathtraceConfig(film, shots, kind) {
  const pt = film.pathtrace || film.raw?.pathtrace || {};
  const seed = Number.isInteger(pt.seed) ? pt.seed : 42;
  const denoise = pt.denoise || 'auto';
  const isAnimatic = kind === 'animatic';
  const preset = isAnimatic ? 'preview' : (pt.preset || 'cinematic');
  const baseSpp = isAnimatic ? (pt.animaticSpp || 4) : (pt.spp || 32);
  const shotSpp = isAnimatic ? {} : (pt.shotSpp && typeof pt.shotSpp === 'object' ? pt.shotSpp : {});
  const sppForFrame = f => {
    if (!isAnimatic) {
      const s = shots.find(x => !x.implicit && f >= x.in && f < x.out);
      if (s && Number.isInteger(shotSpp[s.id]) && shotSpp[s.id] > 0) return shotSpp[s.id];
    }
    return baseSpp;
  };
  return { preset, baseSpp, shotSpp, denoise, seed, overlay: pt.overlay || 'none', sppForFrame };
}

function preparePresetsDir(rt, denoise, workDir, ctx) {
  if (denoise === 'oidn' && !rt.oidn && ctx?.warn) {
    ctx.warn('denoise-oidn-unavailable', '当前光追运行时未编译 OIDN，已按 auto 回退到内置小波降噪');
  }
  if (denoise !== 'none') return { dir: rt.presetsDir, effectiveDenoise: denoise === 'oidn' && !rt.oidn ? 'wavelet' : denoise };
  const custom = path.join(workDir, 'presets-nodenoise');
  fs.mkdirSync(custom, { recursive: true });
  for (const name of fs.existsSync(rt.presetsDir) ? fs.readdirSync(rt.presetsDir) : []) {
    if (!name.endsWith('.json')) continue;
    const raw = JSON.parse(fs.readFileSync(path.join(rt.presetsDir, name), 'utf8'));
    if (raw.native && typeof raw.native === 'object') raw.native.denoise = false;
    fs.writeFileSync(path.join(custom, name), JSON.stringify(raw, null, 2) + '\n');
  }
  return { dir: custom, effectiveDenoise: 'none' };
}

export function ptFrameCacheDir(outRoot, sceneKey, { keep = 4 } = {}) {
  const base = path.join(outRoot, 'cache', 'pt-frames');
  const dir = path.join(base, sceneKey);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const now = new Date();
    fs.utimesSync(dir, now, now);
    const others = fs.readdirSync(base).filter(n => n !== sceneKey)
      .map(n => ({ p: path.join(base, n), t: fs.statSync(path.join(base, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const o of others.slice(Math.max(0, keep - 1))) fs.rmSync(o.p, { recursive: true, force: true });
  } catch { /* 清理失败不影响本次运行 */ }
  return dir;
}

function readSppManifest(cacheDir) {
  try { return JSON.parse(fs.readFileSync(path.join(cacheDir, 'spp.json'), 'utf8')) || {}; } catch { return {}; }
}

function writeSppManifest(cacheDir, map) {
  const tmp = path.join(cacheDir, `spp.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(map) + '\n');
  fs.renameSync(tmp, path.join(cacheDir, 'spp.json'));
}

// 与 tools/qa/checks/texts.mjs 的 pickFrame 同口径：挑每条文字峰值不透明度的代表帧，用来渲一张关掉文字的对照帧量 WCAG 对比度
function pickContrastFrames(textsPath) {
  if (!textsPath || !fs.existsSync(textsPath)) return [];
  let doc;
  try { doc = JSON.parse(fs.readFileSync(textsPath, 'utf8')); } catch { return []; }
  const tracks = new Map();
  for (const fr of Array.isArray(doc?.frames) ? doc.frames : []) {
    if (!Number.isInteger(fr?.frame)) continue;
    for (const it of Array.isArray(fr.items) ? fr.items : []) {
      if (!it || typeof it !== 'object' || !it.text) continue;
      const alpha = Number.isFinite(it.alpha) ? it.alpha : 1;
      if (alpha <= 0.02) continue;
      const key = `${it.id ?? it.text}\u0000${it.text}`;
      let list = tracks.get(key);
      if (!list) { list = []; tracks.set(key, list); }
      list.push({ frame: fr.frame, alpha });
    }
  }
  const picked = new Set();
  for (const list of tracks.values()) {
    const top = Math.max(...list.map(x => x.alpha));
    const best = list.filter(x => x.alpha >= top - 1e-6).map(x => x.frame).sort((a, b) => a - b);
    if (best.length) picked.add(best[Math.floor(best.length / 2)]);
  }
  return [...picked].sort((a, b) => a - b);
}

async function runServeJobs(ctx, rt, presetsDir, jobs, label) {
  if (!jobs.length) return { adapter: ctx.nativeDevice?.device || null, traceMs: 0, jobs: 0 };
  const input = jobs.map(j => JSON.stringify(j)).join('\n') + '\n';
  const timeoutSec = ctx.opts?.timeout || Math.max(300, jobs.length * 45);
  const r = await ctx.exec(rt.exe, ['serve', '--presets', presetsDir], {
    label, input, quiet: true, timeoutSec, stallSec: ctx.opts?.stall || 600,
  });
  const lines = String(r.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
  let adapter = null, traceMs = 0;
  const results = new Map();
  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.ready && msg.adapter) adapter = msg.adapter;
    if (msg.id !== undefined) {
      if (msg.ok === false) {
        ctx.fail(EXIT.RUN, 'pathtrace-job-failed', `threert-render 第 ${msg.id} 号任务失败：${msg.error || line.slice(0, 200)}`,
          ctx.currentStep ? `完整输出见 ${ctx.relLog(ctx.currentStep)}` : null);
      }
      results.set(msg.id, msg);
      traceMs += Number(msg.stats?.timings_ms?.trace_ms || 0);
    }
  }
  for (const j of jobs) {
    if (!fs.existsSync(j.out)) {
      ctx.fail(EXIT.RUN, 'pathtrace-frame-missing', `threert-render 没有写出帧图 ${path.basename(j.out)}`,
        ctx.currentStep ? `完整输出见 ${ctx.relLog(ctx.currentStep)}` : null);
    }
  }
  return { adapter, traceMs, jobs: jobs.length, results };
}

export function createPreflightStep(opts = {}) {
  return {
    id: 'preflight', title: '光追运行时与设备预检（engine/pathtrace/runtime.mjs）',
    async run(ctx) {
      const rt = await ensurePathtraceRuntime(ctx, opts);
      return {
        version: rt.version, exe: rt.exe, verified: rt.verified, oidn: rt.oidn,
        device: ctx.nativeDevice.device, backend: ctx.nativeDevice.backend, hwrt: ctx.nativeDevice.hwrt,
      };
    },
  };
}

export function createBundleStep(opts = {}) {
  return {
    id: 'bundle', title: '场景打包与帧探针（engine/pathtrace/bundle.mjs）',
    key: async ctx => {
      const rt = await ensurePathtraceRuntime(ctx, opts);
      return ctx.hashJson({
        step: 'pt-bundle@1',
        film: ctx.hashTree(ctx.film.dir, { exclude: ['out', 'media', 'review', 'events.json', 'timeline.json'] }),
        enginePt: fs.existsSync(path.join(ROOT, 'engine/pathtrace')) ? ctx.hashTree(path.join(ROOT, 'engine/pathtrace')) : null,
        runtimeVersion: rt.version,
        width: ctx.width, height: ctx.height, fps: ctx.fps, frames: ctx.frames,
      });
    },
    outputs: () => ({ bundle: 'work/scene.bundle.js', events: 'events.json', timeline: 'timeline.json', texts: 'work/texts.json' }),
    async run(ctx) {
      const rt = await ensurePathtraceRuntime(ctx, opts);
      const { bundlePathtraceFilm } = await loadBundleMod(opts.bundler);
      const outBundle = path.join(ctx.run.work, 'scene.bundle.js');
      let res;
      try {
        res = await bundlePathtraceFilm({
          filmDir: ctx.film.dir,
          entry: ctx.film.entry || 'scene.ts',
          outBundle,
          probeOut: ctx.run.dir,
          film: effectiveFilmJson(ctx),
          width: ctx.width,
          height: ctx.height,
          fps: ctx.fps,
          sdkDir: rt.sdkDir,
          presetsDir: rt.presetsDir,
          env: ctx.env,
        });
      } catch (e) {
        const code = e?.exitCode === EXIT.ENV ? EXIT.ENV : e?.exitCode === EXIT.USAGE ? EXIT.USAGE : (e?.exitCode || EXIT.CONTRACT);
        throw new FilmError(code, e?.code || 'pathtrace-bundle-failed', `光追场景打包或探测失败：${e?.message || e}`, e?.hint || null);
      }
      if (res.frameCount !== ctx.frames) {
        ctx.fail(EXIT.CONTRACT, 'pathtrace-frames-mismatch', `光追打包探测帧数 ${res.frameCount} 与本次规格 ${ctx.frames} 不一致`, '检查 film.json 的 output.frameCount');
      }
      return {
        bundleSha256: res.bundleSha256, frameCount: res.frameCount, fps: res.fps,
        width: res.width, height: res.height,
      };
    },
  };
}

function computeSceneKey(ctx, rt, bundlePath, cfg, effectiveDenoise) {
  const assetsDir = path.join(ctx.film.dir, 'assets');
  return ctx.hashJson({
    step: 'pt-frames@1',
    bundle: ctx.fileHash(bundlePath),
    assets: fs.existsSync(assetsDir) ? ctx.hashTree(assetsDir) : null,
    declaredAssets: ctx.film.raw?.assets || null,
    binarySha256: rt.binarySha256,
    presets: rt.presetsDir && fs.existsSync(rt.presetsDir) ? ctx.hashTree(rt.presetsDir) : null,
    width: ctx.width, height: ctx.height, fps: ctx.fps,
    seed: cfg.seed, preset: cfg.preset, denoise: effectiveDenoise,
  });
}

export function createPathtraceStep(opts = {}) {
  return {
    id: 'pathtrace', title: '逐帧物理路径追踪与编码（threert-render serve + FFmpeg）',
    key: async ctx => {
      const rt = await ensurePathtraceRuntime(ctx, opts);
      const cfg = resolvePathtraceConfig(ctx.film, ctx.shots, ctx.kind);
      const effDenoise = cfg.denoise === 'oidn' && !rt.oidn ? 'wavelet' : cfg.denoise;
      const perFrameSpp = Array.from({ length: ctx.frames }, (_, f) => cfg.sppForFrame(f));
      return ctx.hashJson({
        step: 'pt-video@1',
        scene: computeSceneKey(ctx, rt, ctx.art.bundle, cfg, effDenoise),
        spp: perFrameSpp,
        kind: ctx.kind,
        ffmpeg: ctx.tools.ffmpeg,
        ...(ctx.opts?.encoder && ctx.opts.encoder !== 'x264' ? { encoder: ctx.opts.encoder } : {}),
      });
    },
    outputs: ctx => ({ video: 'work/video.mp4', contrast: listRel(ctx.run.dir, 'work/contrast') }),
    restored: (ctx, meta) => {
      if (meta?.device) ctx.nativeDevice = meta.device;
    },
    async run(ctx) {
      const rt = await ensurePathtraceRuntime(ctx, opts);
      const bundlePath = ctx.art.bundle || path.join(ctx.run.work, 'scene.bundle.js');
      const cfg = resolvePathtraceConfig(ctx.film, ctx.shots, ctx.kind);
      const { dir: presetsDir, effectiveDenoise } = preparePresetsDir(rt, cfg.denoise, ctx.run.work, ctx);
      const sceneKey = computeSceneKey(ctx, rt, bundlePath, cfg, effectiveDenoise);
      const cacheDir = ptFrameCacheDir(ctx.outRoot, sceneKey);
      const sppMap = ctx.opts?.noCache ? {} : readSppManifest(cacheDir);
      const framesDir = path.join(ctx.run.work, 'frames');
      fs.mkdirSync(framesDir, { recursive: true });

      const jobs = [];
      let reused = 0;
      for (let f = 0; f < ctx.frames; f++) {
        const name = ptFrameName(f);
        const frameSpp = cfg.sppForFrame(f);
        const cached = path.join(cacheDir, name);
        const dest = path.join(framesDir, name);
        if (!ctx.opts?.noCache && sppMap[String(f)] === frameSpp && fs.existsSync(cached)) {
          linkOrCopy(cached, dest);
          reused++;
        } else {
          jobs.push({
            id: f + 1,
            game: bundlePath,
            assets: ctx.film.dir,
            room: ctx.film.id,
            seed: cfg.seed,
            state: { frame: f },
            seq: f,
            time: f / ctx.fps,
            spp: frameSpp,
            preset: cfg.preset,
            width: ctx.width,
            height: ctx.height,
            out: dest,
            _frame: f,
          });
        }
      }

      // 成片有画面文字时，顺带在同一常驻进程里渲几张关掉文字的对照帧（state.hideTexts = true），供机器 QA 量三维文字对比度
      const contrastFrames = ctx.kind === 'build' ? pickContrastFrames(ctx.art.texts || path.join(ctx.run.work, 'texts.json')) : [];
      const contrastDir = path.join(ctx.run.work, 'contrast');
      const contrastJobs = [];
      if (contrastFrames.length) {
        fs.mkdirSync(contrastDir, { recursive: true });
        for (const f of contrastFrames) {
          const offName = `off_${pad6(f)}.png`;
          const cachedOff = path.join(cacheDir, offName);
          const destOff = path.join(contrastDir, offName);
          const frameSpp = cfg.sppForFrame(f);
          if (!ctx.opts?.noCache && sppMap[`off:${f}`] === frameSpp && fs.existsSync(cachedOff)) {
            linkOrCopy(cachedOff, destOff);
          } else {
            contrastJobs.push({
              id: ctx.frames + f + 1,
              game: bundlePath,
              assets: ctx.film.dir,
              room: ctx.film.id,
              seed: cfg.seed,
              state: { frame: f, hideTexts: true },
              seq: f,
              time: f / ctx.fps,
              spp: frameSpp,
              preset: cfg.preset,
              width: ctx.width,
              height: ctx.height,
              out: destOff,
              _contrastFrame: f,
            });
          }
        }
      }

      const wireJobs = [...jobs, ...contrastJobs].map(({ _frame, _contrastFrame, ...clean }) => clean);
      let serveStats = { adapter: null, traceMs: 0 };
      if (wireJobs.length) {
        ctx.log(`  路径追踪：新渲 ${jobs.length} 帧${contrastJobs.length ? `（另含文字对照 ${contrastJobs.length} 帧）` : ''}，复用 ${reused} 帧 · preset=${cfg.preset}`);
        serveStats = await runServeJobs(ctx, rt, presetsDir, wireJobs, `路径追踪渲染（threert-render serve，${wireJobs.length} 张）`);
        if (serveStats.adapter && ctx.nativeDevice) ctx.nativeDevice.device = serveStats.adapter;
        for (const j of jobs) {
          linkOrCopy(j.out, path.join(cacheDir, ptFrameName(j._frame)));
          sppMap[String(j._frame)] = j.spp;
        }
        for (const j of contrastJobs) {
          linkOrCopy(j.out, path.join(cacheDir, `off_${pad6(j._contrastFrame)}.png`));
          sppMap[`off:${j._contrastFrame}`] = j.spp;
        }
        writeSppManifest(cacheDir, sppMap);
      } else {
        ctx.log(`  路径追踪：${ctx.frames} 帧全部命中帧缓存（${sceneKey}）`);
      }

      for (const f of contrastFrames) {
        const srcOn = path.join(framesDir, ptFrameName(f));
        const destOn = path.join(contrastDir, `on_${pad6(f)}.png`);
        if (fs.existsSync(srcOn)) linkOrCopy(srcOn, destOn);
      }

      const outVideo = path.join(ctx.run.work, 'video.mp4');
      const useNvenc = ctx.opts?.encoder === 'nvenc';
      const crf = ctx.kind === 'animatic' ? 20 : 14;
      const cq = ctx.kind === 'animatic' ? 22 : 18;
      const vCodec = useNvenc
        ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(cq), '-b:v', '0', '-profile:v', 'high', '-level:v', '4.1']
        : ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-profile:v', 'high', '-level:v', '4.1', '-x264-params', 'ref=4'];
      try {
        await ctx.exec(ctx.media.FFMPEG(), [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-framerate', String(ctx.fps),
          '-i', path.join(framesDir, 'f_%06d.png'),
          '-frames:v', String(ctx.frames),
          '-vf', COLOR.png,
          ...vCodec,
          '-r', String(ctx.fps),
          ...TAGS,
          '-movflags', '+faststart',
          outVideo,
        ], { label: '光追 PNG 序列编码（work/video.mp4）', timeoutSec: ctx.opts?.timeout || 1800, quiet: true });
      } finally {
        fs.rmSync(framesDir, { recursive: true, force: true });
      }

      const info = await ctx.media.probe(ctx.exec, outVideo);
      const bad = [];
      if (info.frames !== ctx.frames) bad.push(`帧数 ${info.frames}（应为 ${ctx.frames}）`);
      if (info.width !== ctx.width || info.height !== ctx.height) bad.push(`画幅 ${info.width}×${info.height}（应为 ${ctx.width}×${ctx.height}）`);
      if (Math.abs(info.fps - ctx.fps) > 1e-6) bad.push(`帧率 ${info.fpsRaw}（应为 ${ctx.fps}）`);
      if (bad.length) ctx.fail(EXIT.CONTRACT, 'pathtrace-video-contract', `光追中间件视频与作品描述不符：${bad.join('、')}`, `看 ${ctx.relLog('pathtrace')}`);

      const encoder = ctx.media.encoderInfo(outVideo)
        || (useNvenc ? `h264_nvenc · preset p5 · cq ${cq} High@4.1` : `libx264 CRF ${crf} High@4.1`);
      return {
        sceneKey, preset: cfg.preset, baseSpp: cfg.baseSpp, shotSpp: cfg.shotSpp, denoise: effectiveDenoise, seed: cfg.seed,
        rendered: jobs.length, reused, contrastFrames: contrastFrames.length,
        traceMs: Math.round(serveStats.traceMs),
        frames: info.frames, color: info.color, pixFmt: info.pixFmt,
        encoder, device: ctx.nativeDevice,
      };
    },
  };
}

export function pathtraceSteps({ kind = 'build', runtime = null, bundler = null, gpuInfo = null } = {}) {
  const opts = { runtime, bundler, gpuInfo };
  const preflight = createPreflightStep(opts);
  const bundle = createBundleStep(opts);
  const pathtrace = createPathtraceStep(opts);
  return kind === 'animatic'
    ? [preflight, bundle, mix, pathtrace, preview]
    : [preflight, bundle, mix, cuecheck, pathtrace, mux];
}

export const PATHTRACE_STEP_IDS = {
  build: ['preflight', 'bundle', 'mix', 'cuecheck', 'pathtrace', 'mux'],
  animatic: ['preflight', 'bundle', 'mix', 'pathtrace', 'preview'],
};

/**
 * 供 film stills / film render 渲染选定帧并落进 <outRoot>/cache/pt-frames/<sceneKey>/f_NNNNNN.png，
 * 再硬链接到 destDir/fNNNNNN.png（与 frames.mjs 的清单及 --clip 命名一致）。
 */
export async function renderPathtraceFrames(ctx, frames, destDir, opts = {}) {
  const preflight = createPreflightStep(opts);
  const bundle = createBundleStep(opts);
  const { runSteps } = await import('./pipeline.mjs');
  await runSteps(ctx, [preflight, bundle], { noCache: !!ctx.opts?.noCache });

  const rt = ctx.ptRuntime;
  const bundlePath = ctx.art.bundle || path.join(ctx.run.work, 'scene.bundle.js');
  const cfg = resolvePathtraceConfig(ctx.film, ctx.shots, 'build');
  const { dir: presetsDir, effectiveDenoise } = preparePresetsDir(rt, cfg.denoise, ctx.run.work, ctx);
  const sceneKey = computeSceneKey(ctx, rt, bundlePath, cfg, effectiveDenoise);
  const cacheDir = ptFrameCacheDir(ctx.outRoot, sceneKey);
  const sppMap = ctx.opts?.noCache ? {} : readSppManifest(cacheDir);
  const scratchDir = path.join(ctx.run.work, 'pt-stills');
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });

  const jobs = [];
  for (const f of frames) {
    const frameSpp = cfg.sppForFrame(f);
    const cached = path.join(cacheDir, ptFrameName(f));
    if (!ctx.opts?.noCache && sppMap[String(f)] === frameSpp && fs.existsSync(cached)) continue;
    jobs.push({
      id: f + 1,
      game: bundlePath,
      assets: ctx.film.dir,
      room: ctx.film.id,
      seed: cfg.seed,
      state: { frame: f },
      seq: f,
      time: f / ctx.fps,
      spp: frameSpp,
      preset: cfg.preset,
      width: ctx.width,
      height: ctx.height,
      out: path.join(scratchDir, ptFrameName(f)),
      _frame: f,
    });
  }

  ctx.currentStep = 'pathtrace-stills';
  const t0 = Date.now();
  try {
    if (jobs.length) {
      const wire = jobs.map(({ _frame, ...clean }) => clean);
      const stats = await runServeJobs(ctx, rt, presetsDir, wire, `光追静帧（threert-render serve，${wire.length} 张）`);
      if (stats.adapter && ctx.nativeDevice) ctx.nativeDevice.device = stats.adapter;
      for (const j of jobs) {
        linkOrCopy(j.out, path.join(cacheDir, ptFrameName(j._frame)));
        sppMap[String(j._frame)] = j.spp;
      }
      writeSppManifest(cacheDir, sppMap);
    }
    for (const f of frames) {
      linkOrCopy(path.join(cacheDir, ptFrameName(f)), path.join(destDir, `f${pad6(f)}.png`));
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
  const seconds = +((Date.now() - t0) / 1000).toFixed(2);
  ctx.timing.stills = seconds;
  ctx.steps.push({ id: 'stills', title: '光追静帧（threert-render serve）', status: jobs.length ? 'done' : 'cached', rendered: jobs.length, reused: frames.length - jobs.length, seconds });
  ctx.currentStep = null;
  return { rendered: jobs.length, reused: frames.length - jobs.length, cacheKey: sceneKey, ext: 'png' };
}

/**
 * 供 film plan 试渲 2 帧估算整片路径追踪耗时与磁盘占用（只读：临时目录结束即删）。
 */
export async function planPathtrace({ film, profile, frames, exec, onInterrupt, opts = {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'film-pt-plan-'));
  const undo = onInterrupt ? onInterrupt(() => fs.rmSync(tmp, { recursive: true, force: true })) : () => {};
  try {
    const warnings = [];
    const fakeCtx = {
      film, width: profile.width, height: profile.height, fps: profile.fps, frames,
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
      opts: { gpu: 'any', ...opts },
      warn: (code, message) => warnings.push({ code, message }),
      fail: (exitCode, code, message, hint) => { throw new FilmError(exitCode, code, message, hint); },
      exec: (cmd, args, o = {}) => exec(cmd, args, { cwd: ROOT, env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, quiet: true, ...o }),
    };
    const rt = await ensurePathtraceRuntime(fakeCtx, opts);
    const { bundlePathtraceFilm } = await loadBundleMod(opts.bundler);
    const bundlePath = path.join(tmp, 'scene.bundle.js');
    await bundlePathtraceFilm({
      filmDir: film.dir, entry: film.entry || 'scene.ts', outBundle: bundlePath, probeOut: tmp,
      film: film.raw, width: profile.width, height: profile.height, fps: profile.fps,
      sdkDir: rt.sdkDir, presetsDir: rt.presetsDir, env: fakeCtx.env,
    });
    const shots = film.shots;
    const cfg = resolvePathtraceConfig(film, shots, 'build');
    const { dir: presetsDir } = preparePresetsDir(rt, cfg.denoise, tmp, fakeCtx);
    const sampleFrames = [...new Set([0, Math.floor(frames / 2)].filter(f => f >= 0 && f < frames))];
    const jobs = sampleFrames.map((f, i) => ({
      id: i + 1, game: bundlePath, assets: film.dir, room: film.id, seed: cfg.seed,
      state: { frame: f }, seq: f, time: f / profile.fps, spp: cfg.sppForFrame(f),
      preset: cfg.preset, width: profile.width, height: profile.height, out: path.join(tmp, ptFrameName(f)),
    }));
    const t0 = Date.now();
    await runServeJobs(fakeCtx, rt, presetsDir, jobs, '光追估算试渲');
    const elapsedMs = Math.max(1, Date.now() - t0);
    const sampleBytes = jobs.reduce((s, j) => s + (fs.existsSync(j.out) ? fs.statSync(j.out).size : 0), 0);
    const avgPngBytes = Math.round(sampleBytes / Math.max(1, jobs.length));
    const sampleSppAvg = jobs.reduce((s, j) => s + j.spp, 0) / Math.max(1, jobs.length);
    const totalSpp = Array.from({ length: frames }, (_, f) => cfg.sppForFrame(f)).reduce((a, b) => a + b, 0);
    const perFrameMs = Math.round((elapsedMs / Math.max(1, jobs.length)) * ((totalSpp / Math.max(1, frames)) / Math.max(1, sampleSppAvg)));
    const estSeconds = Math.max(1, Math.round((perFrameMs * frames) / 1000));
    const estOutputBytes = Math.round(frames * avgPngBytes * 0.25);
    const needBytes = Math.round(frames * avgPngBytes * 2.2);
    let freeBytes = null;
    try { const st = fs.statfsSync(film.dir); freeBytes = Number(st.bavail) * Number(st.bsize); } catch { /* 平台不支持时略过 */ }
    if (freeBytes !== null && freeBytes < needBytes * 1.5) {
      throw new FilmError(EXIT.ENV, 'disk-low', `可用磁盘 ${(freeBytes / 2 ** 30).toFixed(1)} GB 小于估算所需的 1.5 倍（${((needBytes * 1.5) / 2 ** 30).toFixed(1)} GB）`,
        '清理旧运行目录或缓存（out/cache/pt-frames/）后再出片');
    }
    return {
      warnings,
      plan: {
        frames, lanes: 1, perLaneFrameMs: perFrameMs, estSeconds, estOutputBytes, needBytes, freeBytes,
        gpu: fakeCtx.nativeDevice?.device || null, software: !!fakeCtx.nativeDevice?.software,
        preset: cfg.preset, baseSpp: cfg.baseSpp,
      },
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    undo();
  }
}
