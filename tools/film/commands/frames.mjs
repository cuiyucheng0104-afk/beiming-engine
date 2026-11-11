// 北冥仓库 · film stills / film render：逐帧静帧（风格关键帧、指定帧段或镜头），已渲过且输入没变的帧直接复用。
//   A / C：先探测页面契约，再把要渲的帧分给 N 路 engine/render/still.mjs（每路一个无头 Chrome，t = 帧号 / fps，JPEG q92）
//   B：    engine/render/native.mjs --at（PNG，按请求顺序命名，这里映射回帧号）
// 帧缓存：<作品>/out/cache/frames/<输入哈希>/f000123.jpg —— 页面源码、画幅、查询串、渲染器任何一项变了就是新的一份。
// 产物：<运行目录>/stills/（stills）或 frames/（render）+ frames.json（帧号、时刻、镜头、sha256、是否复用）+ contact.jpg + run.json；
// render --clip 另把连续帧段按帧率拼成 range.mp4（看动作用，不是交付件）。
import fs from 'node:fs';
import path from 'node:path';
import { usage } from '../lib/exit.mjs';
import { loadFilm } from '../lib/spec.mjs';
import { gateStatus, assertFinalAllowed } from '../lib/gates.mjs';
import { ROOT, rel, sha256File } from '../lib/repo.mjs';
import { parseFrames, parseTimes } from '../lib/args.mjs';
import { openSession, closeSession, addOutput } from '../lib/session.mjs';
import { runSteps } from '../lib/pipeline.mjs';
import { frameCacheDir, linkOrCopy } from '../lib/cache.mjs';
import { writeContactSheet } from '../lib/deliver.mjs';
import { imageSize } from '../lib/media.mjs';
import { nativeStills, nativeKey, raeaInfo, prepare as nativePrepare } from '../lib/native-steps.mjs';
import { probe as pageProbe, pageTrees } from '../../../engine/render/build.mjs';
import { envelope } from '../lib/output.mjs';
import { withRunJson } from './build.mjs';

const STILL = path.join(ROOT, 'engine/render/still.mjs');
const frameSizes = async files => files.map(file => ({ file, ...imageSize(file) }));

const COMMON = {
  '--profile': { type: 'string', arg: '<档位>', help: '交付档位（决定画幅；默认 film.json 的 output.profile）' },
  '--size': { type: 'string', arg: '<宽x高>', help: '改画幅（只看构图时可用小画幅）' },
  '--query': { type: 'string', arg: '<k=v>', help: '原样传给页面的查询串' },
  '--workers': { type: 'int', min: 1, max: 16, arg: '<n>', help: '并行渲染路数（默认 2；帧少时自动减少）' },
  '--page': { type: 'string', arg: '<目录>', help: '页面目录（默认作品目录）' },
  '--out-root': { type: 'string', arg: '<目录>', help: '运行目录的上层（默认 <作品>/out）' },
  '--gpu': { type: 'enum', values: ['required', 'any', 'software-ok'], arg: '<required|any|software-ok>', help: '落到软件渲染时是否放行（默认 required）' },
  '--no-cache': { type: 'bool', help: '不复用已渲过的帧' },
  '--timeout': { type: 'int', min: 10, arg: '<秒>', help: '每路渲染的超时' },
};

export const stillsSpec = {
  positionals: [{ name: '作品目录', describe: '作品目录，例如 films/my-film（相对当前目录）', required: true }],
  options: {
    '--frames': { type: 'string', arg: '<帧号>', help: '要看的帧：48、72:120（半开区间）、0:240:24、0,48,96' },
    '--times': { type: 'string', arg: '<秒,秒>', help: '按秒给时刻（四舍五入到整帧）' },
    ...COMMON,
  },
};
export const renderSpec = {
  positionals: [{ name: '作品目录', describe: '作品目录，例如 films/my-film（相对当前目录）', required: true }],
  options: {
    '--frames': stillsSpec.options['--frames'],
    '--shot': { type: 'string', arg: '<镜头 id>', help: '渲整个镜头（按 film.json 的镜头表）' },
    '--clip': { type: 'bool', help: '把连续帧段拼成 range.mp4（看动作用）' },
    '--final': { type: 'bool', help: '终渲质量：先查 look / animatic 闸（D08），没通过或没有用户豁免时退出码 4；不给帧段时等于 build --final' },
    ...COMMON,
  },
};

export const STILLS_DOC = {
  summary: '风格关键帧（D08 第一道闸 look）：按交付画幅渲几张静帧并拼成联系表',
  usage: ['npm run film -- stills <作品目录> [--frames 0,48,96 | --times 1.5,2.9] [选项]'],
  description: [
    '不给帧号时，每个镜头取中间一帧；只有一个镜头时取片长 1/6、1/2、5/6 处。已渲过且输入没变的帧直接复用。',
    '产物：<作品>/out/<run-id>/stills/f000048.jpg … frames.json contact.jpg run.json；更新 out/latest-stills。',
    '给用户看完，按用户原话记录：npm run film -- review approve look <作品目录> --quote "…" --source "…" --reviewer "…"',
  ],
  examples: ['npm run film -- stills films/my-film', 'npm run film -- stills films/my-film --frames 0,48,96'],
};

export const RENDER_DOC = {
  summary: '只渲指定帧段或镜头（逐帧静帧，帧级复用：同一命令第二次 0 帧重渲）',
  usage: ['npm run film -- render <作品目录> (--frames a:b[,…] | --shot <镜头 id>) [--clip] [--final] [选项]'],
  description: [
    'A / C 用 engine/render/still.mjs，B 用 native.mjs --at。帧号从 0 起，a:b 是半开区间（含 a 不含 b），与 film.json 的镜头表同口径。',
    '产物：<作品>/out/<run-id>/frames/ frames.json contact.jpg run.json（--clip 时另有 range.mp4）；更新 out/latest-render。',
    '--final：先查闸门（look → animatic，决定 D08），没有用户认可或用户豁免记录时退出码 4、一帧不渲；不给帧段时等于 build --final（整片终渲）。',
    '（整片按镜头局部重渲属于渲染器 v2，P04·R4 合入后这里改为转调 video.mjs --shots。）',
  ],
  examples: ['npm run film -- render films/my-film --frames 0:24', 'npm run film -- render films/my-film --shot S2 --clip'],
};

function defaultStills(ctx) {
  const real = ctx.shots.filter(s => !s.implicit);
  if (real.length) return real.map(s => Math.floor((s.in + s.out - 1) / 2));
  const n = ctx.frames;
  return [...new Set([Math.floor(n / 6), Math.floor(n / 2), Math.floor(n * 5 / 6)].map(f => Math.min(n - 1, f)))];
}

const tStr = (f, fps) => String(f / fps);

async function renderPageFrames(ctx, frames, cacheDir) {
  const todo = frames.filter(f => !fs.existsSync(path.join(cacheDir, `f${String(f).padStart(6, '0')}.jpg`)));
  if (!todo.length) return 0;
  const workers = Math.max(1, Math.min(ctx.opts.workers || 2, Math.ceil(todo.length / 4)));
  const chunks = Array.from({ length: workers }, () => []);
  todo.forEach((f, i) => chunks[i % workers].push(f));
  const batches = [];
  for (const [k, c] of chunks.entries()) for (let i = 0; i < c.length; i += 300) batches.push({ k, frames: c.slice(i, i + 300) });
  const runBatch = async (b, idx) => {
    const out = path.join(ctx.run.work, `stills-${idx}`);
    const times = b.frames.map(f => tStr(f, ctx.fps));
    await ctx.exec(process.execPath, [STILL, ctx.film.pageDir, ...times, '--size', `${ctx.width}x${ctx.height}`, ...(ctx.query ? ['--query', ctx.query] : []), '--out', out, '--prefix', 'f'],
      { label: `静帧 ${b.frames.length} 张（still.mjs 第 ${idx + 1} 路）`, timeoutSec: ctx.opts.timeout || 180 + b.frames.length * 8, stallSec: 300, logFile: ctx.logFile(`stills-${idx}`) });
    b.frames.forEach((f, i) => {
      const src = path.join(out, `f${times[i]}.jpg`);
      if (!fs.existsSync(src)) ctx.fail(1, 'still-missing', `still.mjs 没有写出第 ${f} 帧（${path.basename(src)}）`, `看 ${ctx.relLog(`stills-${idx}`)}`);
      fs.renameSync(src, path.join(cacheDir, `f${String(f).padStart(6, '0')}.jpg`));
    });
    fs.rmSync(out, { recursive: true, force: true });
  };
  // 每路一个进程；路数以内并行
  let next = 0;
  const pool = Array.from({ length: workers }, async () => {
    while (next < batches.length) { const i = next++; await runBatch(batches[i], i); }
  });
  await Promise.all(pool);
  return todo.length;
}

export async function runFrames(kind, opts, positionals) {
  if (kind === 'stills' && opts.frames && opts.times) throw usage('--frames 与 --times 只能给一个');
  if (kind === 'render' && opts.frames && opts.shot) throw usage('--frames 与 --shot 只能给一个');
  // 终渲质量的帧段也要过闸（D08）：先判闸门，拒绝时不建运行目录、一帧不渲
  let gateBasis = null;
  if (opts.final) {
    if (opts.size) throw usage('--final 只按交付档位出帧，不能再用 --size 改画幅', '要别的画幅就换档位：--profile <档位>');
    const film = loadFilm(positionals[0], { page: opts.page ? path.resolve(opts.page) : null });
    const status = await gateStatus(film);
    gateBasis = { checked: true, by: status.by, basis: assertFinalAllowed(film, status) };
  }
  if (kind === 'render' && !opts.frames && !opts.shot) throw usage('render 要给 --frames <帧段> 或 --shot <镜头 id>', '例：npm run film -- render films/my-film --frames 72:120；整片终渲用 npm run film -- build <作品目录> --final');
  const ctx = await openSession({ command: kind, kind, filmArg: positionals[0], opts: { gpu: 'required', ...opts } });
  ctx.gateBasis = gateBasis;
  let error = null, output = null;
  let frames = [];
  const extra = {};
  try {
    if (opts.frames) frames = parseFrames(opts.frames, ctx.frames);
    else if (opts.times) frames = parseTimes(opts.times, ctx.fps, ctx.frames);
    else if (opts.shot) {
      const s = ctx.shots.find(x => x.id === opts.shot && !x.implicit);
      if (!s) ctx.fail(2, 'shot-unknown', `film.json 的镜头表里没有 ${opts.shot}`, `可用镜头：${ctx.shots.filter(x => !x.implicit).map(x => x.id).join('、') || '（没有镜头表：用 --frames）'}`);
      frames = Array.from({ length: s.out - s.in }, (_, i) => s.in + i);
      ctx.renderScope = s.id;
    } else frames = defaultStills(ctx);
    if (opts.clip) {
      const contiguous = frames.every((f, i) => !i || f === frames[i - 1] + 1);
      if (!contiguous || frames.length < 2) ctx.fail(2, 'clip-range', '--clip 只用于连续帧段（例：--frames 72:120 或 --shot S2）');
    }
    const destName = kind === 'stills' ? 'stills' : 'frames';
    const dest = path.join(ctx.run.dir, destName);
    fs.mkdirSync(dest, { recursive: true });
    let rendered = 0, cacheKey;
    if (ctx.film.route === 'b') {
      const ext = 'png';
      const r = raeaInfo();
      if (r.ok) ctx.raea = r;
      await runSteps(ctx, [nativePrepare]);   // 原生静帧也要求 media/ 齐全；输入没变时直接跳过
      cacheKey = nativeKey(ctx);
      const cdir = frameCacheDir(ctx.outRoot, cacheKey);
      const todo = opts.noCache ? frames : frames.filter(f => !fs.existsSync(path.join(cdir, `f${String(f).padStart(6, '0')}.${ext}`)));
      ctx.currentStep = 'native-stills';
      if (todo.length) { await nativeStills(ctx, todo, cdir); rendered = todo.length; }
      for (const f of frames) linkOrCopy(path.join(cdir, `f${String(f).padStart(6, '0')}.${ext}`), path.join(dest, `f${String(f).padStart(6, '0')}.${ext}`));
      extra.ext = ext;
    } else {
      await runSteps(ctx, [pageProbe]);
      ctx.gpu = ctx.meta.probe?.gpu || null;
      cacheKey = ctx.hashJson({
        step: 'frames@1', trees: pageTrees(ctx), size: `${ctx.width}x${ctx.height}`, fps: ctx.fps, query: ctx.query || '',
        renderer: ['page.mjs', 'still.mjs'].map(f => ctx.fileHash(path.join(ROOT, 'engine/render', f))), playwright: ctx.tools.playwright, browser: ctx.tools.browser,
        angle: process.env.BEIMING_ANGLE || null, chrome: process.env.BEIMING_CHROME || null, platform: `${process.platform}-${process.arch}`,
      });
      const cdir = frameCacheDir(ctx.outRoot, cacheKey);
      if (opts.noCache) for (const f of frames) fs.rmSync(path.join(cdir, `f${String(f).padStart(6, '0')}.jpg`), { force: true });
      ctx.currentStep = 'stills';
      const t0 = Date.now();
      rendered = await renderPageFrames(ctx, frames, cdir);
      ctx.timing.stills = +((Date.now() - t0) / 1000).toFixed(2);
      ctx.steps.push({ id: 'stills', title: '逐帧静帧（still.mjs）', status: rendered ? 'done' : 'cached', rendered, reused: frames.length - rendered, seconds: ctx.timing.stills });
      for (const f of frames) linkOrCopy(path.join(cdir, `f${String(f).padStart(6, '0')}.jpg`), path.join(dest, `f${String(f).padStart(6, '0')}.jpg`));
      extra.ext = 'jpg';
    }
    ctx.currentStep = null;
    const shotOf = f => (ctx.shots.find(s => f >= s.in && f < s.out) || ctx.shots.at(-1)).id;
    const list = frames.map(f => {
      const p = path.join(dest, `f${String(f).padStart(6, '0')}.${extra.ext}`);
      return { frame: f, t: +(f / ctx.fps).toFixed(6), shot: shotOf(f), cut: ctx.cuts.includes(f), path: rel(p), sha256: sha256File(p) };
    });
    fs.writeFileSync(path.join(ctx.run.dir, 'frames.json'), JSON.stringify({ film: ctx.film.id, run: ctx.run.id, fps: ctx.fps, width: ctx.width, height: ctx.height, rendered, reused: frames.length - rendered, cacheKey, frames: list }, null, 1) + '\n');
    // 联系表：最多 48 格（均匀抽），帧号、时间码、镜头、切点都标上
    const pick = list.length <= 48 ? list : Array.from({ length: 48 }, (_, i) => list[Math.round(i * (list.length - 1) / 47)]);
    ctx.currentStep = 'contact';
    await writeContactSheet(ctx, { tiles: pick.map(x => ({ file: path.join(ROOT, x.path), frame: x.frame, shot: x.shot, cut: x.cut })), out: path.join(ctx.run.dir, 'contact.jpg') });
    if (opts.clip) {
      ctx.currentStep = 'clip';
      await ctx.exec(ctx.media.FFMPEG(), ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(ctx.fps), '-start_number', String(frames[0]), '-i', path.join(dest, `f%06d.${extra.ext}`),
        '-frames:v', String(frames.length), '-vf', 'format=yuv420p', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-movflags', '+faststart', path.join(ctx.run.dir, 'range.mp4')], { label: '帧段拼片', timeoutSec: 900 });
    }
    ctx.currentStep = null;
    addOutput(ctx, path.join(ctx.run.dir, 'contact.jpg'), 'contact');
    addOutput(ctx, path.join(ctx.run.dir, 'frames.json'), 'frames-manifest');
    if (opts.clip) addOutput(ctx, path.join(ctx.run.dir, 'range.mp4'), 'clip');
    extra.rendered = rendered; extra.reused = frames.length - rendered; extra.frames = frames;
    // 静帧不是交付件：技术验收就是编排器核对「要的帧都在、画幅对」，证据是 frames.json（逐帧 sha256）
    const sizes = await frameSizes(list.map(x => path.join(ROOT, x.path)));
    const off = sizes.filter(s => s.width !== ctx.width || s.height !== ctx.height);
    if (off.length) ctx.fail(4, 'frames-size', `${off.length} 张帧图的画幅不是 ${ctx.width}×${ctx.height}（例：${rel(off[0].file)} 是 ${off[0].width}×${off[0].height}）`, '看 logs/ 下渲染器的输出');
    ctx.art.frames = path.join(ctx.run.dir, 'frames.json');
    ctx.nonDeliverable = true;
    ctx.specCheck = { status: 'passed', evidence: [rel(ctx.art.frames)], by: 'tools/film 帧图核对（帧数齐全、画幅一致、逐帧 sha256；不是交付 QA）', summary: `${frames.length} 帧 ${ctx.width}×${ctx.height}` };
    output = { path: rel(dest), sha256: sha256File(ctx.art.frames), width: ctx.width, height: ctx.height, fps: ctx.fps, frames: frames.length, kind: `${extra.ext}-sequence` };
    ctx.log(`${kind === 'stills' ? '关键帧' : '帧段'}：${frames.length} 帧，新渲 ${rendered}，复用 ${frames.length - rendered}`);
  } catch (e) { error = e; }
  const body = await closeSession(ctx, { error, complete: !error, output, extra: { framesRendered: extra.rendered ?? null, framesReused: extra.reused ?? null } });
  if (error) { error.runJson = rel(path.join(ctx.run.dir, 'run.json')); error.outputs = withRunJson(ctx); error.warnings = ctx.warnings; throw error; }
  return { ctx, body, extra };
}

export async function framesCommand(kind, opts, positionals) {
  const { ctx, extra } = await runFrames(kind, opts, positionals);
  const dirName = kind === 'stills' ? 'stills' : 'frames';
  const human = [
    `${kind === 'stills' ? '风格关键帧' : '帧段'}：${ctx.film.relDir} → ${rel(ctx.run.dir)}/`,
    `  ${extra.frames.length} 帧（${extra.frames.length > 8 ? `${extra.frames[0]}…${extra.frames.at(-1)}` : extra.frames.join('、')}），新渲 ${extra.rendered}，复用 ${extra.reused}`,
    `  帧图       ${rel(path.join(ctx.run.dir, dirName))}/`,
    `  联系表     ${rel(path.join(ctx.run.dir, 'contact.jpg'))}`,
    kind === 'stills' ? `下一步：把联系表给用户看；用户认可后 npm run film -- review approve look ${ctx.film.relDir} --quote "<原话>" --source "<出处>" --reviewer "<审阅人>"` : null,
  ].filter(Boolean).join('\n');
  return {
    env: envelope({ command: `film ${kind}`, exitCode: 0, outputs: withRunJson(ctx), runJson: rel(path.join(ctx.run.dir, 'run.json')), warnings: ctx.warnings, data: { runId: ctx.run.id, runDir: rel(ctx.run.dir), frames: extra.frames, rendered: extra.rendered, reused: extra.reused } }),
    human,
  };
}

// render 的入口：--final 不给帧段 = 整片终渲（与 build --final 相同，闸门照查）
export async function renderEntry(opts, positionals) {
  if (opts.final && !opts.frames && !opts.shot) {
    if (opts.clip) throw usage('--clip 只用于 --frames / --shot 帧段');
    const { buildCommand } = await import('./build.mjs');
    process.stderr.write('render --final 没给帧段：按整片终渲处理（等价 build --final）\n');
    const { clip, ...rest } = opts;
    return buildCommand(rest, positionals, 'build', 'render');
  }
  return framesCommand('render', opts, positionals);
}
