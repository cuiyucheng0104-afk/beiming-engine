// 北冥引擎 · 页面型作品（A 北冥风格路线 · WebGL 三渲二、C 北冥代码动画风格 · 86 式）的出片步骤库。
// 由 tools/film（npm run film -- build|animatic）按 film.json 编排调用；本文件只定义「每一步做什么」，
// 运行目录、缓存、闸门、QA、run.json、联系表与网页版都由 tools/film 负责。所有渲染仍交给现有工具，不重写它们：
//   probe     engine/render/events.mjs   打开页面等 READY：页面契约（render 是函数、DUR 有限正数、round(DUR×fps) = 帧数）、
//                                        GPU 是否落到软件渲染；window.EV → events.json、window.TIMELINE → timeline.json（写进运行目录）
//   mix       film.json 的 audio         script（.py / .sh / .mjs）或 wav；产物 audio/mix.wav（+ stems/、score_onsets.json）
//   cuecheck  engine.audio.cuecheck      film.json 写了 cuecheck 才跑；超差即停（退出码 4）
//   video     engine/render/video.mjs    逐帧 → work/video.mp4；核对帧数、画幅、帧率
//   mux       engine/render/mux.sh       两遍线性 loudnorm → master.mp4；无声片补一条静音 AAC（不经 mux.sh）
//   preview   （预演）                    画面逐位复制 + 混音或拍点提示音 → animatic.mp4，不做响度归一
// 现有脚本写死的位置（mix.py 读作品目录的 events.json / timeline.json、写 out/mix.wav；cuecheck 读作品目录与 out/）
// 由 ctx.legacy 临时放置、事后还原：运行结束后作品目录与 out/ 下不留这些文件，产物只在 out/<run-id>/。
// 声音脚本另可读环境变量：BEIMING_FILM、BEIMING_RUN、BEIMING_AUDIO_OUT（直接写到这里最好）、BEIMING_EVENTS、BEIMING_TIMELINE、
// BEIMING_DUR、BEIMING_FPS、BEIMING_FRAMES、BEIMING_WIDTH、BEIMING_HEIGHT、BEIMING_PROFILE。
//
//   pageSteps({ kind: 'build' | 'animatic' }) → 步骤数组（tools/film/lib/pipeline.mjs 的格式）
//   node engine/render/build.mjs <影片目录> [--workers 4] [--skip-video] [--json]   旧入口（npm run c:build），转调 node tools/film/cli.mjs build
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineCommand, isMain, runCli } from '../../tools/lib/cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const R = p => path.join(HERE, p);

// 页面依赖的源码：作品目录（不含产物）+ 页面常用的共享目录；页面目录不是作品目录时（《北冥》样片在仓库根）再加页面源码。
// engine/ 里只算页面会 import 的层：render（渲染器本身另按文件哈希）、audio（Python 声音库）、native（B 路线）、production（Node 侧校验）不进画面
const SHARED_TREES = ['engine', 'fonts', 'assets', 'src'];
const ENGINE_NOT_PAGE = ['render', 'audio', 'native', 'production'];
const FILM_EXCLUDE = ['out', 'media', 'review', 'events.json', 'timeline.json'];
const PAGE_EXCLUDE = ['node_modules', 'cases', 'out', 'films', 'docs', 'media', 'site', 'tests', 'tools', 'examples', 'routes', 'audio', 'lab', '.github', '.claude', 'engine', 'fonts', 'assets', 'src'];
export function pageTrees(ctx) {
  const t = { film: ctx.hashTree(ctx.film.dir, { exclude: FILM_EXCLUDE }) };
  for (const d of SHARED_TREES) t[d] = ctx.hashTree(path.join(ROOT, d), d === 'engine' ? { exclude: ENGINE_NOT_PAGE } : {});
  if (path.resolve(ctx.film.pageDir) !== path.resolve(ctx.film.dir)) t.page = ctx.hashTree(ctx.film.pageDir, { exclude: PAGE_EXCLUDE });
  try { t.three = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/three/package.json'), 'utf8')).version; } catch { t.three = null; }
  return t;
}
const sizeArg = ctx => `${ctx.width}x${ctx.height}`;
// 运行目录下某个子目录里的文件（相对运行目录），给缓存登记分轨这类数量不定的产物
const listRel = (runDir, sub) => {
  const d = path.join(runDir, sub);
  return fs.existsSync(d) ? fs.readdirSync(d).filter(n => fs.statSync(path.join(d, n)).isFile()).sort().map(n => `${sub}/${n}`) : [];
};
const queryArgs = ctx => (ctx.query ? ['--query', ctx.query] : []);

export const probe = {
  id: 'probe', title: '页面契约与事件表（engine/render/events.mjs）',
  outputs: () => ({ events: 'events.json', timeline: 'timeline.json', probe: 'work/probe.json' }),
  async run(ctx) {
    const pf = path.join(ctx.run.work, 'probe.json');
    await ctx.exec(process.execPath, [R('events.mjs'), ctx.film.pageDir, '--size', sizeArg(ctx), ...queryArgs(ctx), '--out', ctx.run.dir, '--probe', pf],
      { label: '页面探测（events.mjs）', timeoutSec: 300, stallSec: 240, okCodes: [0, 4] });
    let p;
    try { p = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch { ctx.fail(1, 'probe-missing', '页面探测没有写出结果（events.mjs 中途退出）', `看 ${ctx.relLog('probe')}`); }
    if (p.problems?.length) ctx.fail(4, 'page-contract', `页面约定不满足：${p.problems.join('；')}`, '页面要设 window.DUR（有限正数）、window.render(t)（函数）并在资源就绪后置 window.READY = true（附录 C5）');
    const want = ctx.frames, got = Math.round(p.dur * ctx.fps);
    if (got !== want) ctx.fail(4, 'page-frames', `页面 DUR = ${p.dur} 秒，按 ${ctx.fps} fps 是 ${got} 帧，作品描述要求 ${want} 帧`, '改页面的时长或 film.json 的帧数，让两者一致（时间只有一个来源）');
    if (Math.abs(p.dur * ctx.fps - got) > 1e-6) ctx.warn('page-dur-fractional', `页面 DUR × fps = ${(p.dur * ctx.fps).toFixed(4)}，不是整数帧`);
    // 页面帧率：video.mjs 按 window.FPS 量化一拍二 / 一拍三（没声明按 24）。与档位帧率不同时节奏会抖：终渲拒绝，工作版告警后加 --any-fps
    const pageRate = p.renderFps ?? p.fpsDeclared ?? 24;
    ctx.anyFps = false;
    if (pageRate !== ctx.fps) {
      const whose = p.fpsDeclared ? `页面声明 window.FPS = ${p.fpsDeclared}` : '页面没有声明 window.FPS（按引擎默认 24 fps 量化）';
      const msg = `${whose}，档位 ${ctx.profile.id} 要 ${ctx.fps} fps：一拍二 / 一拍三与节拍网格会错位`;
      if (ctx.final) ctx.fail(4, 'page-fps', msg, `终渲前让页面按 ${ctx.fps} fps 编写并声明 window.FPS = ${ctx.fps}，或换与页面一致的档位（--profile）`);
      ctx.warn('page-fps', `${msg}（工作版照出，按 --any-fps 渲染）`);
      ctx.anyFps = true;
    }
    if (p.timelineFps && p.timelineFps !== ctx.fps) ctx.warn('timeline-fps', `页面时间轴 TIMELINE.fps = ${p.timelineFps}，渲染按 ${ctx.fps} fps：拍点网格按别的帧率算过，声画打点可能差半帧`);
    if (p.software) {
      const msg = `WebGL 落到了软件渲染（${String(p.gpu).slice(0, 80)}）：每帧慢 5–15 倍，像素也与硬件渲染不同`;
      if (ctx.opts.gpu === 'required') ctx.fail(3, 'software-render', msg, 'macOS 设 BEIMING_ANGLE=metal、Windows / Linux RTX 设 BEIMING_ANGLE=vulkan；只在 CI 冒烟时加 --gpu software-ok');
      ctx.warn('software-render', msg);
    }
    if (!p.hasTexts) ctx.warn('no-texts', '页面没有 window.TEXTS(t)：文字安全区、停留时长与缺字检查无从做起（附录 C5 推荐提供）');
    return { dur: p.dur, gpu: p.gpu, software: p.software, evCount: p.evCount, hasTimeline: p.hasTimeline, hasTexts: p.hasTexts, pageFps: pageRate, fpsDeclared: p.fpsDeclared ?? null, timelineFps: p.timelineFps ?? null, anyFps: ctx.anyFps, title: p.title };
  },
};

// 现有声音脚本写死的输出位置（按约定）：页面目录与作品目录下的 out/
const legacyOut = ctx => [...new Set([path.join(ctx.film.pageDir, 'out'), path.join(ctx.film.dir, 'out')])];

function placeEventsForLegacy(ctx) {
  // C 路线 mix.py / cuecheck 只认作品目录里的 events.json、timeline.json：临时放一份，运行结束还原
  if (ctx.art.events) ctx.legacy.place(path.join(ctx.film.dir, 'events.json'), ctx.art.events);
  if (ctx.art.timeline) ctx.legacy.place(path.join(ctx.film.dir, 'timeline.json'), ctx.art.timeline);
}

const mix = {
  id: 'mix', title: '声音',
  when: ctx => (ctx.audio.mode === 'none' ? '无声片（audio.mode = none）' : true),
  key: ctx => ctx.hashJson({
    step: 'mix@1', mode: ctx.audio.mode, path: ctx.rel(ctx.audio.path), audio: ctx.fileHash(ctx.audio.path),
    scriptDir: ctx.audio.mode === 'script' && !ctx.audio.path.startsWith(ctx.film.dir + path.sep) ? ctx.hashTree(path.dirname(ctx.audio.path), { exclude: ['out', 'check', 'stems', 'samples'] }) : null,
    film: ctx.hashTree(ctx.film.dir, { exclude: FILM_EXCLUDE }), engineAudio: ctx.hashTree(path.join(ROOT, 'engine/audio')),
    events: ctx.art.events ? ctx.fileHash(ctx.art.events) : null, timeline: ctx.art.timeline ? ctx.fileHash(ctx.art.timeline) : null,
    python: ctx.tools.python || null, samples: process.env.BEIMING_SAMPLES || null, frames: ctx.frames, fps: ctx.fps,
  }),
  outputs: ctx => ({ mix: 'audio/mix.wav', onsets: 'audio/score_onsets.json', stems: listRel(ctx.run.dir, 'audio/stems') }),
  async run(ctx) {
    const audioDir = path.join(ctx.run.dir, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    const out = path.join(audioDir, 'mix.wav');
    if (ctx.audio.mode === 'wav') {
      fs.copyFileSync(ctx.audio.path, out);
      return checkWav(ctx, out, { source: ctx.rel(ctx.audio.path) });
    }
    const script = ctx.audio.path, ext = path.extname(script).toLowerCase();
    const outs = legacyOut(ctx);
    for (const o of outs) for (const n of ['mix.wav', 'stems', 'score_onsets.json']) ctx.legacy.protect(path.join(o, n));
    placeEventsForLegacy(ctx);
    const env = {
      ...ctx.env,
      BEIMING_FILM: ctx.film.dir, BEIMING_RUN: ctx.run.dir, BEIMING_AUDIO_OUT: out,
      BEIMING_EVENTS: ctx.art.events || '', BEIMING_TIMELINE: ctx.art.timeline || '',
      BEIMING_DUR: String(ctx.frames / ctx.fps), BEIMING_FPS: String(ctx.fps), BEIMING_FRAMES: String(ctx.frames),
      BEIMING_WIDTH: String(ctx.width), BEIMING_HEIGHT: String(ctx.height), BEIMING_PROFILE: ctx.profile.id,
    };
    const t0 = Date.now() - 2000;
    const [cmd, args] = ext === '.py' ? ctx.py([script, ctx.film.dir]) : ext === '.sh' ? [ctx.sh || 'sh', [script]] : ['.mjs', '.js'].includes(ext) ? [process.execPath, [script, ctx.film.dir]] : [null, null];
    if (!cmd) ctx.fail(4, 'audio-script-type', `声音脚本只支持 .py / .sh / .mjs：${ctx.rel(script)}`);
    await ctx.exec(cmd, args, { label: `声音脚本 ${ctx.rel(script)}`, env, timeoutSec: ctx.opts.timeout || 1800, stallSec: ctx.opts.stall || 600 });
    if (!fs.existsSync(out)) {
      const hit = outs.map(o => path.join(o, 'mix.wav')).find(f => fs.existsSync(f) && fs.statSync(f).mtimeMs >= t0);
      if (!hit) ctx.fail(1, 'mix-no-output', `声音脚本跑完了，但没有写出 mix.wav`, `脚本应写到 $BEIMING_AUDIO_OUT（${ctx.rel(out)}），或按旧约定写 <作品>/out/mix.wav`);
      fs.copyFileSync(hit, out);
      const dir = path.dirname(hit);
      if (fs.existsSync(path.join(dir, 'score_onsets.json'))) fs.copyFileSync(path.join(dir, 'score_onsets.json'), path.join(audioDir, 'score_onsets.json'));
      if (fs.existsSync(path.join(dir, 'stems'))) fs.cpSync(path.join(dir, 'stems'), path.join(audioDir, 'stems'), { recursive: true });
      ctx.note('legacy-audio-out', `声音脚本按旧约定写到 ${ctx.rel(hit)}，已收进运行目录并将在结束时还原原位置`);
    }
    return checkWav(ctx, out, { script: ctx.rel(script) });
  },
};

async function checkWav(ctx, file, extra) {
  const r = await ctx.exec(ctx.media.FFPROBE(), ['-v', 'error', '-show_entries', 'stream=codec_type,sample_rate,channels:format=duration', '-of', 'json', file], { label: 'ffprobe mix.wav', quiet: true, sweep: false });
  let j = {};
  try { j = JSON.parse(r.stdout); } catch { /* 下面判 */ }
  const a = (j.streams || []).find(s => s.codec_type === 'audio');
  if (!a) ctx.fail(4, 'mix-not-audio', `${ctx.rel(file)} 不是可读的音频文件`);
  const dur = Number(j.format?.duration), want = ctx.frames / ctx.fps;
  if (Number(a.sample_rate) !== 48000) ctx.warn('mix-rate', `混音是 ${a.sample_rate} Hz，交付要 48 kHz（封装时会重采样）`);
  if (a.channels !== 2) ctx.warn('mix-channels', `混音是 ${a.channels} 声道，交付要立体声`);
  if (Math.abs(dur - want) > 0.05) ctx.warn('mix-duration', `混音 ${dur.toFixed(3)} 秒，画面 ${want.toFixed(3)} 秒（封装时补静音或截断）`);
  return { ...extra, sampleRate: Number(a.sample_rate), channels: a.channels, duration: dur };
}

const cuecheck = {
  id: 'cuecheck', title: '声画拍点核对（engine.audio.cuecheck）',
  when: ctx => (!ctx.film.cuecheck ? 'film.json 没有 cuecheck' : !ctx.art.mix ? '没有混音' : !ctx.art.timeline ? '页面没有导出 window.TIMELINE' : true),
  key: ctx => ctx.hashJson({
    step: 'cuecheck@1', cfg: ctx.film.cuecheck, events: ctx.fileHash(ctx.art.events), timeline: ctx.fileHash(ctx.art.timeline),
    mix: ctx.fileHash(ctx.art.mix), onsets: ctx.art.onsets ? ctx.fileHash(ctx.art.onsets) : null, code: ctx.hashTree(path.join(ROOT, 'engine/audio')),
  }),
  outputs: () => ({ cuecheckLog: 'audio/cuecheck.txt' }),
  async run(ctx) {
    placeEventsForLegacy(ctx);
    const fo = path.join(ctx.film.dir, 'out');
    ctx.legacy.place(path.join(fo, 'mix.wav'), ctx.art.mix);
    if (ctx.art.onsets) ctx.legacy.place(path.join(fo, 'score_onsets.json'), ctx.art.onsets);
    const c = ctx.film.cuecheck, a = ['-m', 'engine.audio.cuecheck', ctx.film.dir];
    if (c.silence?.length) a.push('--silence', c.silence.join(','));
    if (c.grid) a.push('--grid', String(c.grid));
    if (c.tolMs != null) a.push('--tol-ms', String(c.tolMs));
    if (c.quietDb != null) a.push('--quiet-db', String(c.quietDb));
    const r = await ctx.exec(...ctx.py(a), { label: '拍点核对', timeoutSec: 600, okCodes: [0, 1] });
    fs.writeFileSync(path.join(ctx.run.dir, 'audio', 'cuecheck.txt'), r.stdout);
    if (r.code !== 0 || !/CUECHECK OK/.test(r.stdout)) ctx.fail(4, 'cuecheck-failed', '声画拍点核对不通过（CUECHECK FAIL）', `逐条偏差见 ${ctx.rel(path.join(ctx.run.dir, 'audio', 'cuecheck.txt'))}；改 timeline.js 的打点或 mix.py 的起音`);
    return { ok: true };
  },
};

const video = {
  id: 'video', title: '逐帧渲染（engine/render/video.mjs）',
  key: ctx => ctx.hashJson({
    step: 'video@2', trees: pageTrees(ctx), args: videoArgs(ctx),
    renderer: ['page.mjs', 'video.mjs', 'args.mjs'].map(f => (fs.existsSync(R(f)) ? ctx.fileHash(R(f)) : null)), playwright: ctx.tools.playwright, browser: ctx.tools.browser,
    angle: process.env.BEIMING_ANGLE || null, chrome: process.env.BEIMING_CHROME || null, platform: `${process.platform}-${process.arch}`,
    frameTimeout: process.env.BEIMING_FRAME_TIMEOUT || null,
  }),
  outputs: () => ({ video: 'work/video.mp4' }),
  restored: (ctx, meta) => { ctx.gpu = meta.gpu || ctx.gpu; },
  async run(ctx) {
    const out = path.join(ctx.run.work, 'video.mp4');
    const per = Math.ceil(ctx.frames / ctx.opts.workers);
    const timeoutSec = ctx.opts.timeout || Math.round(240 + per * (ctx.opts.gpu === 'required' ? 6 : 12));
    let r;
    try {
      r = await ctx.exec(process.execPath, [R('video.mjs'), ctx.film.pageDir, ...videoArgs(ctx), '--out', out],
        { label: '逐帧渲染（video.mjs）', timeoutSec, stallSec: ctx.opts.stall || 300 });
    } finally {
      // video.mjs 在部分失败路径上会留下 .segs-*（加固计划 TOOLS-08）：段目录只会出现在输出旁，这里统一扫掉
      for (const n of fs.existsSync(ctx.run.work) ? fs.readdirSync(ctx.run.work) : []) if (n.startsWith('.segs-')) fs.rmSync(path.join(ctx.run.work, n), { recursive: true, force: true });
    }
    const gpu = (/GPU：(.+)/.exec(r.stdout) || [])[1]?.trim() || null;
    const info = await ctx.media.probe(ctx.exec, out);
    const bad = [];
    if (info.frames !== ctx.frames) bad.push(`帧数 ${info.frames}（应为 ${ctx.frames}）`);
    if (info.width !== ctx.width || info.height !== ctx.height) bad.push(`画幅 ${info.width}×${info.height}（应为 ${ctx.width}×${ctx.height}）`);
    if (Math.abs(info.fps - ctx.fps) > 1e-6) bad.push(`帧率 ${info.fpsRaw}（应为 ${ctx.fps}）`);
    if (bad.length) ctx.fail(4, 'video-contract', `逐帧视频与作品描述不符：${bad.join('、')}`, '多半是页面 DUR 与 film.json 不一致，或渲染中途丢帧；看 logs/video.log');
    ctx.gpu = gpu;
    return { gpu, workers: ctx.opts.workers, frames: info.frames, color: info.color, pixFmt: info.pixFmt, encoder: ctx.media.encoderInfo(out), args: videoArgs(ctx) };
  },
};

// 传给 video.mjs 的参数：画幅、帧率、路数、查询串；页面帧率与档位不同的工作版加 --any-fps。
// 渲染器 v2（P04）认 --gpu / --profile 时一并传（看 video.mjs 的用法文字，不写死版本）。--profile 只在画幅与帧率正好是档位的
// 时候传：v2 把「--size 与档位不一致」当用法错误，而预演（半分辨率）与 --size 改画幅的工作版本来就不按档位出。
function videoArgs(ctx) {
  const a = ['--size', sizeArg(ctx), '--fps', String(ctx.fps), '--workers', String(ctx.opts.workers), ...queryArgs(ctx)];
  if (ctx.anyFps) a.push('--any-fps');
  if (ctx.supports('video.mjs', '--gpu')) a.push('--gpu', ctx.opts.gpu);
  const onProfile = !ctx.profile.custom && ctx.width === ctx.profile.width && ctx.height === ctx.profile.height && ctx.fps === ctx.profile.fps;
  if (onProfile && ctx.supports('video.mjs', '--profile')) a.push('--profile', ctx.profile.id);
  return a;
}

const mux = {
  id: 'mux', title: '音画封装（engine/render/mux.sh）',
  key: ctx => ctx.hashJson({
    step: 'mux@2', video: ctx.fileHash(ctx.art.video), mix: ctx.art.mix ? ctx.fileHash(ctx.art.mix) : null, fps: ctx.fps,
    muxer: ctx.fileHash(R('mux.sh')), ffmpeg: ctx.tools.ffmpeg,
  }),
  outputs: () => ({ master: 'master.mp4' }),
  async run(ctx) {
    const out = path.join(ctx.run.dir, 'master.mp4'), tmp = path.join(ctx.run.work, 'master.partial.mp4');
    let loud = null, copied = true;
    // mux.sh 的响度目标固定为 −14 LUFS / 真峰值 −1.2 dBTP；档位要别的目标（broadcast −23）时它做不到，等 P04·R3 的 mux.mjs
    if (ctx.art.mix && Number.isFinite(ctx.profile.lufs) && Math.abs(ctx.profile.lufs - MUX_SH_LUFS) > 0.05) {
      const msg = `档位 ${ctx.profile.id} 要 ${ctx.profile.lufs} LUFS，engine/render/mux.sh 只会归一到 ${MUX_SH_LUFS} LUFS`;
      if (ctx.final) ctx.fail(4, 'mux-loudness-target', msg, '换 −14 LUFS 的档位出片，或等渲染器 v2 的 mux.mjs（P04·R3）按档位归一');
      ctx.warn('mux-loudness-target', `${msg}：工作版照出，QA 的响度项会判不过`);
    }
    try {
      if (!ctx.art.mix) {
        ctx.warn('silent-film', '没有声音：母版里放一条静音 AAC（48 kHz 立体声），响度检查应按无声片处理');
        await ctx.media.muxSimple(ctx.exec, { video: ctx.art.video, audio: null, out: tmp, duration: ctx.frames / ctx.fps, logFile: ctx.logFile('mux') });
      } else {
        const r = await ctx.exec(ctx.sh || 'sh', [R('mux.sh'), ctx.art.video, ctx.art.mix, tmp, String(ctx.fps), '0'], { label: '音画封装（mux.sh）', timeoutSec: ctx.opts.timeout || 1800, stallSec: 600 });
        const I = /I:\s*(-?[\d.]+)\s*LUFS/.exec(r.stdout), P = /Peak:\s*(-?[\d.]+)\s*dBFS/.exec(r.stdout);
        loud = { integratedLUFS: I ? Number(I[1]) : null, truePeakDbTP: P ? Number(P[1]) : null, by: 'mux.sh 末尾的 ebur128 摘要' };
        copied = /直接拷贝/.test(r.stdout);
      }
      fs.renameSync(tmp, out);
    } finally { fs.rmSync(tmp, { force: true }); }
    return { loudness: loud, muxer: ctx.art.mix ? 'engine/render/mux.sh' : 'ffmpeg 复制画面 + 静音 AAC', videoCopied: copied, encoder: ctx.media.encoderInfo(out) };
  },
};
const MUX_SH_LUFS = -14;

// 预演：不经 mux.sh（不重编码画面、不做响度归一）；声音用作品混音，没有就按事件与切点生成提示音
const preview = {
  id: 'preview', title: '预演封装（复制画面 + 临时声）',
  outputs: () => ({ animatic: 'animatic.mp4' }),
  async run(ctx) {
    let audio = ctx.art.mix || null, temp = audio ? 'mix' : 'none';
    if (!audio && (ctx.cuts.length || ctx.markFrames.length)) {
      audio = path.join(ctx.run.work, 'clicks.wav');
      ctx.media.clickTrack({ file: audio, frames: ctx.frames, fps: ctx.fps, marks: [...ctx.markFrames.map(f => ({ frame: f, kind: 'event' })), ...ctx.cuts.map(f => ({ frame: f, kind: 'cut' }))] });
      temp = 'clicks';
    }
    await ctx.media.muxSimple(ctx.exec, { video: ctx.art.video, audio, out: path.join(ctx.run.dir, 'animatic.mp4'), duration: ctx.frames / ctx.fps, logFile: ctx.logFile('preview') });
    return { tempSound: temp };
  },
};

export function pageSteps({ kind = 'build' } = {}) {
  return kind === 'animatic' ? [probe, mix, video, preview] : [probe, mix, cuecheck, video, mux];
}

export const PAGE_STEP_IDS = { build: ['probe', 'mix', 'cuecheck', 'video', 'mux'], animatic: ['probe', 'mix', 'video', 'preview'] };

// 旧入口（npm run c:build，保留一个版本）：转调统一出片命令；--skip-video 等价于 --to cuecheck。
// 参数、--help、--json 与退出码按命令约定库（tools/lib/cli.mjs）；退出码就是统一出片命令的退出码。
export const legacyCommand = defineCommand({
  name: 'c:build',
  summary: '旧入口：已并入统一出片命令 npm run film -- build（本命令转调它，保留一个版本）',
  usage: ['node engine/render/build.mjs <影片目录> [--workers N] [--skip-video] [--json]'],
  description: ['等价于 node tools/film/cli.mjs build <影片目录> [--workers N] [--to cuecheck]；产物在 <影片目录>/out/<run-id>/。新命令见 npm run film -- build --help。'],
  positionals: [{ name: 'film', label: '<影片目录>', describe: '作品目录，例如 films/my-film' }],
  options: {
    workers: { type: 'integer', min: 1, max: 32, arg: '<N>', describe: '页面渲染并行路数（默认 4）' },
    'skip-video': { type: 'boolean', describe: '只做声音与拍点核对（等价 --to cuecheck）' },
  },
  exitCodes: { 0: '成功', 1: '运行失败', 2: '用法错误', 3: '缺环境', 4: '契约 / QA / 闸门不通过', 5: '作品被占用', 124: '超时', 130: '收到 SIGINT，已清理', 143: '收到 SIGTERM，已清理' },
  async run(ctx) {
    const args = ['build', ctx.args.film, ...(ctx.opts.workers ? ['--workers', String(ctx.opts.workers)] : []), ...(ctx.opts['skip-video'] ? ['--to', 'cuecheck'] : []), '--json'];
    process.stderr.write(`[迁移提示] engine/render/build.mjs 已并入 npm run film -- build；本次转调 node tools/film/cli.mjs ${args.join(' ')}\n`);
    const p = spawnSync(process.execPath, [path.join(ROOT, 'tools/film/cli.mjs'), ...args], { cwd: process.cwd(), stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 << 20 });
    let env = null;
    try { env = JSON.parse(p.stdout); } catch { /* 下面按失败处理 */ }
    if (!env) return { exitCode: p.status ?? 1, error: { code: 'failure.film-cli', message: `统一出片命令没有给出结果（退出码 ${p.status ?? p.signal}）`, hint: '看上面 stderr 的输出' } };
    if (!ctx.json && env.ok) ctx.out(`出片完成：${env.data?.runDir || env.runJson}`);
    return { exitCode: env.exitCode, error: env.error, outputs: env.outputs, runJson: env.runJson, warnings: env.warnings, data: env.data };
  },
});

if (isMain(import.meta.url)) await runCli(legacyCommand);
