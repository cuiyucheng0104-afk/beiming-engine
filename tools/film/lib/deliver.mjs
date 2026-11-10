// 北冥仓库 · 出片编排 · 三条路线共用的交付步骤：网页版、海报、联系表、播放页、机器 QA。
//   web      master 之外另编一份网页版（从最高质量的画面源编一次，色彩一次性转 BT.709 tv；声音复制母版 AAC）→ web.mp4
//   poster   本次运行的海报帧（film.json 的 poster / posterFrame，缺省片长 60% 处）→ poster.jpg
//   contact  联系表：概览（约每 1–2 秒一格，含片尾帧）+ 每个切点前 3 后 3 帧的逐帧条；标帧号、时间码、镜头号与切点 → contact.jpg
//            只取本次运行的帧（从本次的视频里按帧号解码），不会混进旧静帧（加固计划 TOOLS-08）
//   player   单文件播放页：标题、画幅、时长、镜头分段与切点来自 film.json 与 ffprobe；逐帧步进、跳切点 → player.html
//   qa       node tools/qa/cli.mjs delivery（P07）→ qa/report.json；硬门不过退出码 4
// 这些步骤都很轻，不进缓存（--from 时照常重跑）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './repo.mjs';
import { runQa } from './qa.mjs';

const CONTACT = path.join(ROOT, 'tools/contact_sheet.py');
const PLAYER = path.join(ROOT, 'tools/make_html.py');

// 画面源：A / C 用逐帧中间件（work/video.mp4，比母版少一代有损）；B 用原生母版
const pictureSource = ctx => ctx.art.video || ctx.art.master || ctx.art.animatic;

export const web = {
  id: 'web', title: '网页版（H.264 High@4.1，BT.709 tv）',
  key: ctx => ctx.hashJson({ step: 'web@1', src: ctx.fileHash(pictureSource(ctx)), master: ctx.fileHash(ctx.art.master), fps: ctx.fps, ffmpeg: ctx.tools.ffmpeg }),
  outputs: () => ({ web: 'web.mp4' }),
  async run(ctx) {
    const src = pictureSource(ctx);
    const info = await ctx.media.probe(ctx.exec, src, { count: false });
    await ctx.media.encodeWeb(ctx.exec, { src, srcInfo: info, audioFrom: ctx.art.master, out: path.join(ctx.run.dir, 'web.mp4'), fps: ctx.fps, logFile: ctx.logFile('web'), timeoutSec: ctx.opts.timeout || 1800 });
    return { from: ctx.rel(src), colorIn: info.color };
  },
};

export const poster = {
  id: 'poster', title: '海报帧',
  outputs: () => ({ poster: 'poster.jpg' }),
  async run(ctx) {
    const f = Math.min(ctx.frames - 1, Math.round(ctx.film.posterFrame * ctx.fps / ctx.film.fps));
    const dir = path.join(ctx.run.work, 'poster');
    const got = await ctx.media.extractFrames(ctx.exec, pictureSource(ctx), [f], dir, { logFile: ctx.logFile('poster') });
    await ctx.exec(ctx.media.FFMPEG(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', got.get(f), '-q:v', '2', path.join(ctx.run.dir, 'poster.jpg')], { label: '海报 JPEG', quiet: true, sweep: false });
    fs.rmSync(dir, { recursive: true, force: true });
    return { frame: f };
  },
};

// 联系表取哪些帧：概览约 20 格（短片逐几帧、长片按半秒 / 整秒的倍数放宽，间隔落在整齐的帧数上）+ 片尾帧；
// 每个切点 c 取 c−3 … c+2（前 3 后 3）。例：24 fps × 240 帧 → 每 12 帧（0.5 秒）一格，共 21 格；72 帧 → 每 4 帧一格。
export function contactPlan({ frames, fps, cuts, maxStrips = 16, target = 20 }) {
  const raw = frames / target;
  const q = raw >= fps / 2 ? fps / 2 : raw >= fps / 4 ? fps / 4 : 1;
  const step = Math.max(1, Math.ceil(raw / q) * q);
  const overview = [];
  for (let f = 0; f < frames; f += step) overview.push(Math.round(f));
  if (overview.at(-1) !== frames - 1) overview.push(frames - 1);
  const strips = cuts.slice(0, maxStrips).map(c => ({ cut: c, frames: [c - 3, c - 2, c - 1, c, c + 1, c + 2].filter(f => f >= 0 && f < frames) }));
  return { overview, strips, truncated: Math.max(0, cuts.length - maxStrips) };
}

function shotOf(shots, f) { return (shots.find(s => f >= s.in && f < s.out) || shots.at(-1)).id; }

export async function writeContactSheet(ctx, { tiles, strips = [], out, header = {} }) {
  const manifest = {
    title: ctx.film.title, film: ctx.film.id, run: ctx.run.id, profile: ctx.profile.id, width: ctx.width, height: ctx.height, fps: ctx.fps, frames: ctx.frames,
    kind: ctx.kind, final: !!ctx.final, shots: ctx.shots.filter(s => !s.implicit).map(s => ({ id: s.id, in: s.in, out: s.out })), cuts: ctx.cuts,
    tiles, strips, ...header,
  };
  const mf = path.join(ctx.run.work, 'contact.json');
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 1));
  await ctx.exec(ctx.python, [CONTACT, out, '--manifest', mf], { label: '联系表（tools/contact_sheet.py）', timeoutSec: 600, logFile: ctx.logFile('contact'), quiet: true, sweep: false });
  return out;
}

export const contact = {
  id: 'contact', title: '联系表（本次运行的帧）',
  outputs: () => ({ contact: 'contact.jpg' }),
  async run(ctx) {
    const plan = contactPlan({ frames: ctx.frames, fps: ctx.fps, cuts: ctx.cuts });
    const want = [...new Set([...plan.overview, ...plan.strips.flatMap(s => s.frames)])];
    const dir = path.join(ctx.run.work, 'contact-frames');
    const got = await ctx.media.extractFrames(ctx.exec, pictureSource(ctx), want, dir, { logFile: ctx.logFile('contact') });
    const tile = f => ({ file: got.get(f), frame: f, shot: shotOf(ctx.shots, f), cut: ctx.cuts.includes(f) });
    await writeContactSheet(ctx, {
      tiles: plan.overview.map(tile), strips: plan.strips.map(s => ({ cut: s.cut, tiles: s.frames.map(tile) })),
      out: path.join(ctx.run.dir, 'contact.jpg'), header: { truncatedStrips: plan.truncated },
    });
    fs.rmSync(dir, { recursive: true, force: true });
    return { tiles: plan.overview.length, strips: plan.strips.length, truncatedStrips: plan.truncated };
  },
};

export const player = {
  id: 'player', title: '播放页（tools/make_html.py）',
  outputs: () => ({ player: 'player.html' }),
  async run(ctx) {
    const video = ctx.art.web || ctx.art.animatic || ctx.art.master;
    const meta = {
      title: ctx.film.title, film: ctx.film.id, run: ctx.run.id, kind: ctx.kind, final: !!ctx.final, profile: ctx.profile.id, fps: ctx.fps, frames: ctx.frames,
      width: ctx.width, height: ctx.height, duration: ctx.frames / ctx.fps,
      shots: ctx.shots.filter(s => !s.implicit).map(s => ({ id: s.id, in: s.in, out: s.out })), cuts: ctx.cuts,
      aigc: ctx.film.raw?.aigc?.contains === true ? (ctx.film.raw.aigc.note || '含 AI 生成画面') : null,
    };
    const mf = path.join(ctx.run.work, 'player.json');
    fs.writeFileSync(mf, JSON.stringify(meta, null, 1));
    await ctx.exec(ctx.python, [PLAYER, video, path.join(ctx.run.dir, 'player.html'), '--meta', mf, '--embed', ctx.opts.embed || 'auto'], { label: '播放页', timeoutSec: 600, logFile: ctx.logFile('player'), quiet: true, sweep: false });
    return { video: path.basename(video) };
  },
};

export const qa = {
  id: 'qa', title: '机器 QA 门（tools/qa/cli.mjs，P07）',
  when: ctx => (ctx.opts.noQa ? '加了 --no-qa' : true),
  outputs: () => ({ qaReport: 'qa/report.json' }),
  async run(ctx) {
    const r = await runQa({ master: ctx.art.master, film: ctx.film, profile: ctx.profile, runDir: ctx.run.dir, exec: ctx.exec, timeoutSec: ctx.opts.timeout || 900 });
    ctx.qa = r;
    if (r.status === 'not-run') {
      if (ctx.final) ctx.fail(3, r.reason || 'qa-missing', `终渲必须过机器 QA：${r.message}`, '先合入 / 安装 tools/qa/cli.mjs（P07），或去掉 --final 出工作版');
      ctx.warn(r.reason || 'qa-missing', `${r.message}；run.json 的技术验收记为 not-run`);
    } else if (r.status === 'failed') {
      ctx.log(`  ${r.message}`);
    } else ctx.log(`  ${r.message}`);
    return { status: r.status, failed: r.failed || [], warned: r.warned || [] };
  },
};

export function deliverSteps({ kind = 'build' } = {}) {
  if (kind === 'animatic') return [contact, player];
  return [web, poster, contact, player, qa];
}
