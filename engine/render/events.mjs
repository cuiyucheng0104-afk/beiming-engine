#!/usr/bin/env node
// 北冥引擎 · 导出声画事件表，并探测页面约定：打开影片页面（等 window.READY），把 window.EV 写成 events.json，
// 页面有 window.TIMELINE 时再写 timeline.json；--probe 另写一份页面契约探测结果（JSON），供 tools/film 在出片前把关。
// A 北冥风格路线 · WebGL 三渲二与 C 北冥代码动画风格 · 86 式的页面都用它（页面约定见 engine/render/page.mjs 开头，加固计划附录 C5）。
//   node engine/render/events.mjs <影片目录> [--size 1920x1040] [--query k=v] [--out <目录>] [--probe <probe.json>] [--no-events] [--json]
// events.json  = { dur: window.DUR, ev: window.EV || [] }（紧凑 JSON）
// timeline.json = window.TIMELINE 原样（缩进 1），一般是 { ...tempo.toJSON(), dur, cues, t }，给 mix.py 与 cuecheck 读
// probe.json   = { dur, hasRender, hasTexts, texts0, evCount, hasTimeline, fps, fpsDeclared, timelineFps, renderFps, contract, gpu, software, title, problems }
//   fpsDeclared = window.FPS（没声明为 null）；timelineFps = TIMELINE.fps；renderFps = video.mjs 量化用的页面帧率（window.FPS，没声明按 24）
//   fps = fpsDeclared ?? timelineFps（旧字段，保留兼容）；contract = window.BEIMING_CONTRACT（缺省 1）
// 默认写进影片目录本身；--out 换目录（tools/film 写进运行目录，不碰作品源码），--no-events 只探测不写事件表。
// 事件表由页面在加载时算好（engine/core/tempo.js 的 createEvents），这里不调用 render(t)，不渲帧。
// 参数、--help（无副作用、不启动浏览器）、--json 信封与退出码按命令约定库 tools/lib/cli.mjs（docs/CLI.md）：
//   0 成功；1 页面报错（脚本 / 文档 404、未捕获异常、等 READY 超时）；2 用法错误或找不到页面；4 页面契约不满足
//   （没有 render 函数、DUR 不是有限正数、EV 不是数组）。--json 时 data = { probe, written }。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli } from '../../tools/lib/cli.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRel = p => path.relative(REPO, p).split(path.sep).join('/');   // 信封里的路径：仓库相对、正斜杠（docs/CLI.md 第 2 节）
const clamp255 = v => (v < 0 ? 0 : v > 255 ? 255 : v);
function percentileFromHist(hist, total, q) {
  const target = total * q;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return 255;
}

export const command = defineCommand({
  name: 'c:events',
  summary: '导出页面的声画事件表（window.EV → events.json、window.TIMELINE → timeline.json），并探测页面约定',
  usage: ['node engine/render/events.mjs <影片目录> [--size 1920x1040] [--query k=v] [--out <目录>] [--probe <probe.json>] [--no-events] [--json]'],
  description: [
    '打开影片页面、等 window.READY，不调用 render(t)、不渲帧。页面约定见 engine/render/page.mjs 开头（附录 C5）。',
    '出片时由 npm run film -- build 的 probe 步骤调用（写进运行目录，不碰作品源码）；单独用时默认写进影片目录本身。',
  ],
  positionals: [{ name: 'dir', label: '<影片目录>', describe: '含 index.html 的页面目录（作品目录，或《北冥》样片的仓库根 .）' }],
  options: {
    size: { type: 'string', arg: '<宽x高>', default: '1920x1040', describe: '页面画幅（偶数，默认 1920x1040）' },
    query: { type: 'string', arg: '<k=v>', default: '', describe: '原样传给页面的查询串' },
    out: { type: 'string', arg: '<目录>', describe: 'events.json / timeline.json / kinematics.json 写到哪个目录（默认影片目录）' },
    probe: { type: 'string', arg: '<probe.json>', describe: '另写一份页面契约探测结果' },
    telemetry: { type: 'boolean', describe: '逐帧执行 render(t) 采集真实画面运动能量、运动重心声像、切点与页面 AUDIO_TELEMETRY 轨迹（写 kinematics.json）' },
    'telemetry-scale': { type: 'string', arg: '<除数>', default: '8', describe: '遥测采样缩略除数（默认 8，即 1920x1040 按 240x130 采样）' },
    'no-events': { type: 'boolean', describe: '只探测，不写事件表' },
  },
  examples: ['node engine/render/events.mjs films/my-film --out /tmp/ev --probe /tmp/ev/probe.json'],
  exitCodes: { 0: '成功', 1: '页面报错（脚本或文档 404、未捕获异常、等 READY 超时）', 2: '用法错误或找不到页面', 4: '页面契约不满足' },
  async run(ctx) {
    const dir = ctx.args.dir;
    const sm = /^(\d+)x(\d+)$/.exec(ctx.opts.size);
    if (!sm || +sm[1] % 2 || +sm[2] % 2 || +sm[1] < 16 || +sm[2] < 16) throw new CliError('usage.bad-value', `--size 要写成 宽x高，且宽高都是 ≥16 的偶数，收到「${ctx.opts.size}」`, { hint: '例如 --size 1920x1080' });
    const w = +sm[1], h = +sm[2];
    const div = ctx.opts.telemetry ? Number(ctx.opts['telemetry-scale']) : 1;
    if (ctx.opts.telemetry && !(Number.isFinite(div) && div >= 1 && div <= 32)) {
      throw new CliError('usage.bad-value', `--telemetry-scale 应为 1..32 之间的数，收到「${ctx.opts['telemetry-scale']}」`, { hint: '默认 8' });
    }
    const openW = ctx.opts.telemetry ? Math.max(32, Math.round(w / div) & ~1) : w;
    const openH = ctx.opts.telemetry ? Math.max(32, Math.round(h / div) & ~1) : h;
    const outDir = path.resolve(ctx.opts.out || dir), query = ctx.opts.query || '';

    // 页面服务与浏览器由 page.mjs 提供；动态导入，保证 --help 与用法错误不启动任何东西
    const { openFilm, closeServer, isSoftwareRenderer } = await import('./page.mjs');
    let film = null, info, gpu = null;
    const shut = async () => { await film?.close?.().catch(() => {}); await closeServer().catch(() => {}); };
    ctx.onCleanup(shut);
    try {
      film = await openFilm(dir, { w: openW, h: openH, query });
      gpu = film.gpu;
      info = await film.page.evaluate(() => {
        const tl = window.TIMELINE || null;
        let texts0 = null;
        try { texts0 = typeof window.TEXTS === 'function' ? (window.TEXTS(0) || []).length : null; } catch { texts0 = 'error'; }
        let kin = null, kinErr = null;
        try {
          if (typeof window.KINEMATICS === 'function') kin = window.KINEMATICS();
          else if (window.KINEMATICS && typeof window.KINEMATICS === 'object') kin = window.KINEMATICS;
        } catch (err) { kinErr = String(err?.message || err); }
        const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
        return {
          ev: { dur: window.DUR, ev: window.EV || [] }, tl, kin, kinErr,
          hasAudioTelemetry: typeof window.AUDIO_TELEMETRY === 'function',
          dur: window.DUR, hasRender: typeof window.render === 'function', hasTexts: typeof window.TEXTS === 'function', texts0,
          fpsDeclared: num(window.FPS), fpsRaw: window.FPS === undefined ? null : String(window.FPS), timelineFps: tl ? num(tl.fps) : null,
          contract: window.BEIMING_CONTRACT ?? 1, title: document.title || null,
        };
      });
      film.check();

      // 逐帧真遥测采样：执行 window.render(f / fps)，同步提取 GPU 亮度平面帧间运动能量、横向视觉重心声像、切点跳变与场景发声体轨迹
      if (ctx.opts.telemetry && info.hasRender && typeof info.dur === 'number' && Number.isFinite(info.dur) && info.dur > 0 && !info.kinErr) {
        const { captureGpuFrame } = await import('./lib/yuv.mjs');
        const fps = info.fpsDeclared ?? info.timelineFps ?? 24;
        const nFrames = Math.max(1, Math.round(info.dur * fps));
        const yLen = openW * openH;
        const blurY = src => {
          const dst = new Float32Array(yLen);
          for (let y = 0; y < openH; y++) {
            const y0 = Math.max(0, y - 1) * openW, y1 = y * openW, y2 = Math.min(openH - 1, y + 1) * openW;
            for (let x = 0; x < openW; x++) {
              const x0 = Math.max(0, x - 1), x2 = Math.min(openW - 1, x + 1);
              dst[y1 + x] = (
                src[y0 + x0] + src[y0 + x] + src[y0 + x2] +
                src[y1 + x0] + src[y1 + x] + src[y1 + x2] +
                src[y2 + x0] + src[y2 + x] + src[y2 + x2]
              ) / 9;
            }
          }
          return dst;
        };
        const luma = [], contrast = [], rawDiff = [], motionPan = [];
        const dynTracks = {};
        let prevBlur = null, lastPan = 0;
        for (let f = 0; f < nFrames; f++) {
          const t = f / fps;
          const yuv = await captureGpuFrame(film, t, { w: openW, h: openH, format: 'yuv420', samples: 1, fps, dur: info.dur, where: `遥测帧 ${f}` });
          const yPlane = yuv.subarray(0, yLen);
          const curBlur = blurY(yPlane);
          let sumY = 0;
          const hist = new Uint32Array(256);
          for (let i = 0; i < yLen; i++) {
            const v = clamp255(Math.round((yPlane[i] - 16) * (255 / 219)));
            sumY += v;
            hist[v]++;
          }
          luma.push(+(sumY / (yLen * 255)).toFixed(4));
          const p05 = percentileFromHist(hist, yLen, 0.05), p95 = percentileFromHist(hist, yLen, 0.95);
          contrast.push(+((p95 - p05) / 255).toFixed(4));

          if (prevBlur) {
            let dSum = 0, wxSum = 0, wActive = 0;
            for (let y = 0; y < openH; y++) {
              const row = y * openW;
              for (let x = 0; x < openW; x++) {
                const d = Math.abs(curBlur[row + x] - prevBlur[row + x]) / 219;
                dSum += d;
                if (d > 0.018) {
                  const nx = (x / Math.max(1, openW - 1)) * 2 - 1;
                  wxSum += d * nx;
                  wActive += d;
                }
              }
            }
            const md = dSum / yLen;
            rawDiff.push(md);
            if (wActive > 0.25) lastPan = lastPan * 0.35 + (wxSum / wActive) * 0.65;
            motionPan.push(+Math.max(-1, Math.min(1, lastPan)).toFixed(4));
          } else {
            rawDiff.push(0);
            motionPan.push(0);
          }
          prevBlur = curBlur;

          if (info.hasAudioTelemetry) {
            const snap = await film.page.evaluate(({ tt, ff }) => window.AUDIO_TELEMETRY(tt, ff), { tt: t, ff: f });
            if (snap && typeof snap === 'object') {
              for (const [tk, chs] of Object.entries(snap)) {
                if (!chs || typeof chs !== 'object') continue;
                const dst = (dynTracks[tk] ??= {});
                for (const [ck, cv] of Object.entries(chs)) {
                  if (typeof cv === 'number' && Number.isFinite(cv)) {
                    (dst[ck] ??= new Array(f).fill(0)).push(+cv.toFixed(5));
                  }
                }
              }
            }
          }
        }
        // 分离切点巨跳与连续运动归一化
        const sortedDiff = [...rawDiff.slice(1)].sort((a, b) => a - b);
        const medDiff = sortedDiff.length ? sortedDiff[Math.floor(sortedDiff.length * 0.5)] : 0.01;
        const p92Diff = sortedDiff.length ? sortedDiff[Math.floor(sortedDiff.length * 0.92)] : 0.05;
        const cutFlags = new Array(nFrames).fill(0), holdFlags = new Array(nFrames).fill(0), motion = new Array(nFrames).fill(0);
        const detectedCuts = [];
        for (let f = 1; f < nFrames; f++) {
          const prev = f > 1 ? rawDiff[f - 1] : medDiff, next = f + 1 < nFrames ? rawDiff[f + 1] : medDiff;
          const localBase = Math.max(0.012, Math.min(prev, next));
          if (rawDiff[f] > 0.065 && rawDiff[f] > localBase * 3.8) {
            cutFlags[f] = 1;
            detectedCuts.push(f);
            motion[f] = motion[f - 1];
          } else {
            motion[f] = +Math.min(1, rawDiff[f] / Math.max(0.025, p92Diff * 1.35)).toFixed(4);
            if (rawDiff[f] < Math.max(0.0018, medDiff * 0.18)) holdFlags[f] = 1;
          }
        }
        if (nFrames > 1) motion[0] = motion[1];
        const baseTracks = (info.kin && typeof info.kin === 'object')
          ? (info.kin.tracks && typeof info.kin.tracks === 'object' ? { ...info.kin.tracks } : {})
          : {};
        info.kin = {
          fps,
          dur: info.dur,
          sampleSize: [openW, openH],
          detectedCuts,
          tracks: {
            ...baseTracks,
            ...dynTracks,
            screen: { luma, contrast, motion, x: motionPan, cut: cutFlags, hold: holdFlags },
          },
        };
      }
    } catch (e) {
      // 页面错误、缺文件、等 READY 超时、找不到页面：一行原因 + 退出码（page.mjs 的错误自带建议的退出码）
      await shut();
      const code = Number.isInteger(e?.exitCode) ? e.exitCode : 1;
      throw new CliError(code === 2 ? 'usage.page' : code === 4 ? 'contract.page' : code === 3 ? 'env.page' : 'failure.page', String(e?.message || e).split('\n')[0], { hint: '先单独打开页面看控制台报错（npm run serve 或浏览器开 index.html）', exitCode: code });
    }
    await shut();

    const problems = [];
    if (!info.hasRender) problems.push('window.render 不是函数');
    if (!(typeof info.dur === 'number' && Number.isFinite(info.dur) && info.dur > 0)) problems.push(`window.DUR 应为有限正数，现在是 ${JSON.stringify(info.dur)}`);
    if (!Array.isArray(info.ev.ev)) problems.push('window.EV 应为数组');
    if (info.fpsRaw !== null && info.fpsDeclared === null) problems.push(`window.FPS 应为正数，现在是 ${info.fpsRaw}`);
    if (info.kinErr) problems.push(`window.KINEMATICS 报错：${info.kinErr}`);
    const probe = {
      dur: info.dur, hasRender: info.hasRender, hasTexts: info.hasTexts, texts0: info.texts0,
      evCount: Array.isArray(info.ev.ev) ? info.ev.ev.length : null, hasTimeline: !!info.tl, hasKinematics: !!info.kin,
      fps: info.fpsDeclared ?? info.timelineFps, fpsDeclared: info.fpsDeclared, timelineFps: info.timelineFps, renderFps: info.fpsDeclared ?? 24,
      contract: info.contract, gpu: gpu || null, software: isSoftwareRenderer(gpu), title: info.title, problems,
    };
    const written = [];
    if (ctx.opts.probe) {
      const pf = path.resolve(ctx.opts.probe);
      fs.mkdirSync(path.dirname(pf), { recursive: true });
      fs.writeFileSync(pf, JSON.stringify(probe, null, 1));
    }
    if (!problems.length && !ctx.opts['no-events']) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(info.ev));
      written.push(path.join(outDir, 'events.json'));
      if (info.tl) { fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(info.tl, null, 1)); written.push(path.join(outDir, 'timeline.json')); }
      if (info.kin) { fs.writeFileSync(path.join(outDir, 'kinematics.json'), JSON.stringify(info.kin)); written.push(path.join(outDir, 'kinematics.json')); }
    }
    const outputs = written.map(f => ({ path: repoRel(f), sha256: null, kind: path.basename(f, '.json') }));
    if (problems.length) {
      return { exitCode: 4, error: { code: 'contract.page-contract', message: `页面约定不满足：${problems.join('；')}`, hint: '见 engine/render/page.mjs 开头的页面约定（附录 C5）' }, outputs, data: { probe, written: outputs.map(o => o.path) } };
    }
    ctx.log.info(`events.json  ${probe.evCount} 条  dur ${probe.dur}${ctx.opts['no-events'] ? '（--no-events：未写文件）' : ''}`);
    if (info.tl) ctx.log.info(`timeline.json  ${(info.tl.secs || []).length} 段  ${Object.keys(info.tl.cues || {}).length} 个打点`);
    return { outputs, data: { probe, written: outputs.map(o => o.path) } };
  },
});

if (isMain(import.meta.url)) await runCli(command);
