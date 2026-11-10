// 北冥仓库 · 出片编排 · 三条路线共用的交付步骤：网页版、海报、联系表、播放页、机器 QA。
//   web      master 之外另编一份网页版（从最高质量的画面源编一次，色彩一次性转 BT.709 tv；声音复制母版 AAC）→ web.mp4
//   label    film.json 的 aigc.contains = true 时，给 master.mp4 与 web.mp4 写隐式 AIGC 标识（mp4 comment，决定 D11）：
//            字符串由 tools/compliance/lib/aigc.mjs 的 ffmpegMetadataArgs 生成（ProduceID = <作品 id>@<run-id>），只改容器元数据，
//            码流逐位不变；写完读回核对，run.json 的 aigc 记下写入的 comment
//   poster   本次运行的海报帧（film.json 的 poster / posterFrame，缺省片长 60% 处）→ poster.jpg
//   contact  联系表：概览（约每 1–2 秒一格，含片尾帧）+ 每个切点前 3 后 3 帧的逐帧条；标帧号、时间码、镜头号与切点 → contact.jpg
//            只取本次运行的帧（从本次的视频里按帧号解码），不会混进旧静帧（加固计划 TOOLS-08）
//   player   单文件播放页：标题、画幅、时长、镜头分段与切点来自 film.json 与 ffprobe；逐帧步进、跳切点 → player.html
//   qa       node tools/qa/cli.mjs report（机器 QA 门）→ qa/report.json、report.md、contact.jpg；硬门不过退出码 4
// 这些步骤都很轻，不进缓存（--from 时照常重跑）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './repo.mjs';
import { runQa } from './qa.mjs';
import { ffmpegMetadataArgs, parseImplicitLabel, EXPLICIT } from '../../compliance/lib/aigc.mjs';

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

// 隐式标识的参数：kinds 取 film.json 的 aigc.kinds（visual / voice / music），没写按 visual；tools 取 aigc.tools（生成工具名，写进人读说明）
export function aigcLabel(ctx) {
  const a = ctx.film.raw?.aigc;
  if (!a || a.contains !== true) return null;
  const kinds = Array.isArray(a.kinds) && a.kinds.length && a.kinds.every(k => EXPLICIT[k]) ? a.kinds : ['visual'];
  const tools = Array.isArray(a.tools) ? a.tools.filter(t => typeof t === 'string' && t.trim()) : [];
  const opts = { producer: '北冥引擎 Beiming Engine', produceId: `${ctx.film.id}@${ctx.run.id}`, kinds, tools };
  const args = ffmpegMetadataArgs(opts);
  return { ...opts, args, comment: args[1].replace(/^comment=/, '') };
}

export const label = {
  id: 'label', title: '隐式 AIGC 标识（mp4 comment，D11）',
  when: ctx => (aigcLabel(ctx) ? true : 'film.json 没有声明 aigc.contains = true'),
  async run(ctx) {
    const L = aigcLabel(ctx);
    const files = [ctx.art.master, ctx.art.web, ctx.art.animatic].filter(f => f && fs.existsSync(f));
    for (const f of files) {
      await ctx.media.setMetadata(ctx.exec, f, L.args, { logFile: ctx.logFile('label') });
      const got = await ctx.media.readComment(ctx.exec, f);
      const parsed = parseImplicitLabel(got);
      if (got !== L.comment || !parsed.ok) ctx.fail(1, 'aigc-label', `${path.basename(f)} 的隐式 AIGC 标识没写进去或读回不一致：${parsed.problems.join('；') || '内容不同'}`, '检查 FFmpeg 版本（≥ 7）；看 logs/label.log');
    }
    ctx.aigc = { contains: true, comment: L.comment, kinds: L.kinds, tools: L.tools, files: files.map(f => ctx.rel(f)), by: 'tools/compliance/lib/aigc.mjs ffmpegMetadataArgs' };
    return { files: files.map(f => path.basename(f)), comment: L.comment };
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
  await ctx.exec(...ctx.py([CONTACT, out, '--manifest', mf]), { label: '联系表（tools/contact_sheet.py）', timeoutSec: 600, logFile: ctx.logFile('contact'), quiet: true, sweep: false });
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
    await ctx.exec(...ctx.py([PLAYER, video, path.join(ctx.run.dir, 'player.html'), '--meta', mf, '--embed', ctx.opts.embed || 'auto']), { label: '播放页', timeoutSec: 600, logFile: ctx.logFile('player'), quiet: true, sweep: false });
    return { video: path.basename(video) };
  },
};

export const qa = {
  id: 'qa', title: '机器 QA 门（tools/qa/cli.mjs，P07）',
  when: ctx => (ctx.opts.noQa ? '加了 --no-qa' : true),
  outputs: () => ({ qaReport: 'qa/report.json' }),
  async run(ctx) {
    // 页面型作品把页面目录交给 QA（文字、底板两组要打开页面逐帧读；《北冥》样片的页面在仓库根）；B 没有页面，QA 自己跳过这两组
    const pageDir = ctx.film.route !== 'b' ? ctx.film.pageDir : null;
    // QA 要整片解码好几遍、文字组还要逐帧开页面：总时限按帧数给（每帧约 1.5 秒上限，最少 15 分钟）
    const r = await runQa({ master: ctx.art.master, film: ctx.film, profile: ctx.profile, runDir: ctx.run.dir, exec: ctx.exec, pageDir, timeoutSec: ctx.opts.timeout ? Math.max(ctx.opts.timeout, 900) : Math.max(900, Math.round(ctx.frames * 1.5)) });
    for (const o of r.outputs || []) if (o?.path && /^qa-/.test(String(o.kind || ''))) ctx.qaOutputs = [...(ctx.qaOutputs || []), o];
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
  if (kind === 'animatic') return [label, contact, player];
  return [web, label, poster, contact, player, qa];
}
