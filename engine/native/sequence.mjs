#!/usr/bin/env node
// 北冥引擎 · 原生层 · 序列帧：把任何「会动的画面」变成原生场景能用的素材——一张图集 PNG + 说明 JSON，或一个逐帧 PNG 目录。
// 这是 render anything 的接口：A 路 / C 路的页面作品、现成视频、一组图片，都先在这里变成序列帧，
// 原生端用 engine/native/layers.tsx 的 <SequencePlane>（图集贴三维面片）或 <FrameSequence>（逐帧 PNG 叠在页面层）按帧号取用。
//
// 三种输入
//   page    满足页面约定的作品目录（window.DUR / render(t) / READY，见 engine/render/page.mjs），用无头 Chrome 逐帧渲；
//           alpha: true 时页面背景透明、截图保留 alpha（例如只画片名的页面）；crop: [x, y, w, h] 只截这一块（像素）
//   video   任意 FFmpeg 能解码的视频文件，按 fps 抽帧
//   frames  一个图片目录（按文件名排序）
// 两种输出（output）
//   atlas（默认） <out>.png 格子图集：cols × rows 个 cell 大小的格子，从左到右、从上到下；多余格子透明
//                 <out>.json { grid:[cols, rows], frames, fps, cell:[w, h], source, sha256 }
//   frames        <out>/000000.png … 逐帧 PNG（cell 不给就保持原尺寸）+ <out>.json { frames, fps, size:[w, h], source, files }
//
// 命令行
//   node engine/native/sequence.mjs page   <作品目录> --from 0 --until 2 --fps 12 --size 1920x1040 --cell 480x260 --out <图集.png> [--query k=v] [--alpha] [--crop x,y,w,h]
//   node engine/native/sequence.mjs video  <文件.mp4> --from 0 --until 2 --fps 12 --cell 480x270 --out <图集.png>
//   node engine/native/sequence.mjs frames <图片目录> --fps 12 --cell 480x270 --out <图集.png>
//   加 --output frames 时 --out 是目录；page 每帧 render(t) 的超时用 --frame-timeout（秒，默认 30）。FFmpeg 认 FFMPEG / FFPROBE（ffmpegBins）。
//   退出码：0 · 1 渲染 / 抽帧失败 · 2 用法 · 3 缺 FFmpeg / 输入 · 4 图集超限 · 124 超时
// 代码里：import { makeSequence } from 'engine/native/sequence.mjs'; await makeSequence({ kind, src, from, until, fps, size, cell, out, output, alpha, crop, frameTimeoutMs })
//
// 限制：图集最长边不超过 8192 像素（常见 GPU 纹理上限），超了就报错让你缩小 cell 或减少帧数；整张图集一次进显存，
// 所以它适合几秒的小窗口 / 屏幕 / 贴图动画；更长或全画幅的叠层用 output: "frames"。
import { copyFile, mkdtemp, mkdir, readdir, rm, writeFile, readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, bind, exitWith, fail, log, onCleanup, offCleanup, runQuick } from './cli.mjs';
import { defineCommand, isMain, runCli } from '../../tools/lib/cli.mjs';
import { ffmpegBins } from '../../tools/env/lib/ffmpeg.mjs';

const MAX = 8192;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// 记录里的来源路径：仓库内写相对仓库根的路径，仓库外只写文件名（不把本机绝对路径写进素材记录）
const portable = src => { const r = relative(ROOT, resolve(String(src))); return r.startsWith('..') || isAbsolute(r) ? basename(String(src)) : r.split(sep).join('/'); };
const ffmpeg = () => ffmpegBins(process.env).ffmpeg;
function run(args, timeoutMs = 600000) {
  const p = runQuick(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { timeoutMs, label: 'FFmpeg' });
  if (p.status !== 0) throw fail(EXIT.FAIL, 'ffmpeg', `FFmpeg 失败：${p.stderr.trim().slice(0, 400)}`);
}
const pair = (s, name) => { const m = /^(\d+)x(\d+)$/.exec(String(s)); if (!m) throw fail(EXIT.USAGE, 'bad-value', `${name} 要写成 WxH：${s}`); return [+m[1], +m[2]]; };

export function layout(n, [cw, ch]) {
  const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * ch / cw)))), rows = Math.ceil(n / cols);
  if (cols * cw > MAX || rows * ch > MAX) throw fail(EXIT.CONTRACT, 'atlas-size', `图集 ${cols * cw}×${rows * ch} 超过 ${MAX}`, '缩小 cell、降低 fps 或减少帧数；更长的序列用 output: "frames"');
  return [cols, rows];
}

// 一帧的帧号：第 n 帧 = floor((t − start) · fps)，loop 时取模，否则夹在首尾（与 layers.tsx 的 sequenceFrame 同式）
export function frameIndex(sheet, t, start = 0, fps = sheet.fps, loop = false) {
  const n = Math.floor((t - start) * fps + 1e-6);
  if (loop) return ((n % sheet.frames) + sheet.frames) % sheet.frames;
  return Math.max(0, Math.min(sheet.frames - 1, n));
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(fail(EXIT.TIMEOUT, 'timeout', `${what} 超过 ${ms / 1000} 秒`, '页面 render(t) 卡住了：单独打开页面查控制台；确实慢就加 --frame-timeout <秒>（默认 30）')), ms).unref())]);

async function pageFrames(dir, tmp, { from, until, fps, size, query, alpha, crop, frameTimeoutMs }) {
  const { openFilm, closeServer } = await import('../render/page.mjs');
  const [w, h] = size;
  const { browser, page } = await openFilm(dir, { w, h, query });
  const close = onCleanup(async () => { await browser.close().catch(() => {}); await closeServer().catch(() => {}); });
  try {
    const dur = await page.evaluate(() => window.DUR);
    if (!(dur > 0)) throw fail(EXIT.CONTRACT, 'page-contract', `页面 ${dir} 没有给出 window.DUR`);
    const end = Math.min(until ?? dur, dur), n = Math.max(1, Math.round((end - from) * fps));
    if (alpha) await page.evaluate(() => { document.documentElement.style.background = 'transparent'; document.body.style.background = 'transparent'; });
    const clip = crop ? { x: crop[0], y: crop[1], width: crop[2], height: crop[3] } : undefined;
    for (let i = 0; i < n; i++) {
      await withTimeout(page.evaluate(t => window.render(t), from + i / fps), frameTimeoutMs, `页面第 ${i} 帧 render(t)`);
      await page.screenshot({ path: join(tmp, `f${String(i).padStart(5, '0')}.png`), type: 'png', omitBackground: Boolean(alpha), clip });
    }
    return n;
  } finally { offCleanup(close); await close(); }
}

function videoFrames(file, tmp, { from, until, fps }) {
  if (!existsSync(file)) throw fail(EXIT.ENV, 'missing-input', `找不到视频 ${file}`);
  run(['-ss', String(from), ...(until !== undefined ? ['-t', String(until - from)] : []), '-i', file, '-vf', `fps=${fps}`, '-start_number', '0', join(tmp, 'f%05d.png')]);
}

async function dirFrames(src, tmp) {
  if (!existsSync(src)) throw fail(EXIT.ENV, 'missing-input', `找不到图片目录 ${src}`);
  const files = (await readdir(src)).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort();
  if (!files.length) throw fail(EXIT.ENV, 'missing-input', `${src} 里没有图片`);
  files.forEach((f, i) => run(['-i', join(src, f), join(tmp, `f${String(i).padStart(5, '0')}.png`)]));
}

export async function makeSequence({ kind, src, from = 0, until, fps = 12, size = [1920, 1080], cell, out, query = '', output = 'atlas', alpha = false, crop, frameTimeoutMs = 30000 }) {
  if (!['page', 'video', 'frames'].includes(kind)) throw fail(EXIT.USAGE, 'bad-value', `kind 只能是 page / video / frames：${kind}`);
  if (!['atlas', 'frames'].includes(output)) throw fail(EXIT.USAGE, 'bad-value', `output 只能是 atlas / frames：${output}`);
  if (!out || (output === 'atlas' && !cell)) throw fail(EXIT.USAGE, 'bad-value', output === 'atlas' ? '图集需要 cell 与 out' : '需要 out');
  if (crop && !(Array.isArray(crop) && crop.length === 4 && crop.every(v => Number.isInteger(v) && v >= 0))) throw fail(EXIT.USAGE, 'bad-value', 'crop 要写成 [x, y, w, h] 四个非负整数');
  const tmp = await mkdtemp(join(tmpdir(), 'bne-seq-'));
  const drop = onCleanup(() => rm(tmp, { recursive: true, force: true }));
  try {
    if (kind === 'page') await pageFrames(src, tmp, { from, until, fps, size, query, alpha, crop, frameTimeoutMs });
    else if (kind === 'video') videoFrames(src, tmp, { from, until, fps });
    else await dirFrames(src, tmp);
    const list = (await readdir(tmp)).filter(f => f.endsWith('.png')).sort();
    const n = list.length;
    if (!n) throw fail(EXIT.FAIL, 'no-frames', '没有得到任何帧');
    const source = { kind, src: portable(src), from, until: until ?? null, ...(alpha ? { alpha: true } : {}), ...(crop ? { crop } : {}) };
    if (output === 'frames') {
      const dir = resolve(out), staging = `${dir}.part`;
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      for (let i = 0; i < n; i++) {
        const name = `${String(i).padStart(6, '0')}.png`;
        if (cell) run(['-i', join(tmp, list[i]), '-vf', `scale=${cell[0]}:${cell[1]}:flags=lanczos,format=rgba`, join(staging, name)]);
        else await copyFile(join(tmp, list[i]), join(staging, name));   // 临时目录可能在另一个卷上，不能 rename
      }
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);
      const first = runQuick(ffmpegBins(process.env).ffprobe, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(dir, '000000.png')], { label: 'ffprobe' }).stdout.trim().split(',').map(Number);
      const sheet = { output: 'frames', frames: n, fps, size: first, source, files: '000000.png…' };
      await writeFile(`${dir}.json`, JSON.stringify(sheet, null, 2) + '\n');
      return sheet;
    }
    const [cols, rows] = layout(n, cell);
    await mkdir(dirname(resolve(out)), { recursive: true });
    const part = resolve(out).replace(/\.png$/i, '') + '.part.png';
    run(['-framerate', String(fps), '-start_number', '0', '-i', join(tmp, 'f%05d.png'), '-vf',
      `scale=${cell[0]}:${cell[1]}:flags=lanczos,format=rgba,tile=${cols}x${rows}:nb_frames=${n}:color=0x00000000`, '-frames:v', '1', part]);
    await rename(part, resolve(out));
    const sha256 = createHash('sha256').update(await readFile(resolve(out))).digest('hex');
    const sheet = { grid: [cols, rows], frames: n, fps, cell, source, sha256 };
    await writeFile(resolve(out).replace(/\.png$/i, '') + '.json', JSON.stringify(sheet, null, 2) + '\n');
    return sheet;
  } finally { offCleanup(drop); await drop(); }
}

export const command = defineCommand({
  name: 'native:sequence',
  summary: '把页面作品、视频或图片目录变成原生场景能用的序列帧（图集 PNG 或逐帧 PNG 目录）',
  usage: ['node engine/native/sequence.mjs <page|video|frames> <输入> --out <图集.png | 目录> [选项]'],
  description: '图集最长边不超过 8192 像素；更长或全画幅的叠层用 --output frames。film.json 里的 sequences 由 prepare 调用同一个函数。',
  positionals: [
    { name: 'kind', label: '<page|video|frames>', describe: '输入种类：页面作品目录、视频文件、图片目录' },
    { name: 'src', label: '<输入>', describe: '作品目录 / 视频文件 / 图片目录' },
  ],
  options: {
    out: { type: 'string', arg: '<路径>', describe: '图集 PNG（--output atlas）或逐帧目录（--output frames）；必填' },
    from: { type: 'number', arg: '<秒>', describe: '起点（默认 0；frames 输入不用）' },
    until: { type: 'number', arg: '<秒>', describe: '终点（默认到页面 / 视频结尾）' },
    fps: { type: 'number', arg: '<N>', min: 1, describe: '采样帧率（默认 12）' },
    size: { type: 'string', arg: '<WxH>', describe: 'page 的渲染尺寸（默认 1920x1080）' },
    cell: { type: 'string', arg: '<WxH>', describe: '每格尺寸（图集必需；逐帧输出时可选，用来缩放）' },
    output: { type: 'string', arg: '<atlas|frames>', choices: ['atlas', 'frames'], describe: '图集（默认）或逐帧 PNG 目录' },
    alpha: { type: 'boolean', describe: 'page：透明背景、保留 alpha' },
    crop: { type: 'string', arg: '<x,y,w,h>', describe: 'page：只截这一块（像素）' },
    query: { type: 'string', arg: '<k=v>', describe: '原样传给页面' },
    'frame-timeout': { type: 'number', arg: '<秒>', min: 1, describe: 'page：每帧 render(t) 的超时（默认 30）' },
  },
  exitCodes: { 0: '成功', 1: '渲染 / 抽帧失败', 2: '用法错误', 3: '缺 FFmpeg 或输入', 4: '图集超限或页面契约不符', 124: '超时' },
  examples: ['node engine/native/sequence.mjs page films/a-demo --from 0 --until 2 --fps 12 --size 1920x1040 --cell 480x260 --out out/screen.png'],
  async run(ctx) {
    bind(ctx);
    const a = ctx.opts;
    const { kind, src } = ctx.args;
    if (!['page', 'video', 'frames'].includes(kind)) throw fail(EXIT.USAGE, 'bad-value', `输入种类只能是 page / video / frames：${kind}`, '例：node engine/native/sequence.mjs video clip.mp4 --cell 480x270 --out out/clip.png');
    if (!a.out) throw fail(EXIT.USAGE, 'missing-option', '缺少 --out', '图集写 --out <图集.png>；逐帧写 --output frames --out <目录>');
    const sheet = await makeSequence({
      kind, src, from: a.from ?? 0, until: a.until ?? undefined, fps: a.fps ?? 12,
      size: a.size ? pair(a.size, '--size') : undefined, cell: a.cell ? pair(a.cell, '--cell') : undefined,
      out: a.out, query: a.query || '', output: a.output || 'atlas', alpha: Boolean(a.alpha),
      crop: a.crop ? a.crop.split(',').map(Number) : undefined, frameTimeoutMs: 1000 * (a['frame-timeout'] ?? 30),
    });
    log(`序列帧：${sheet.frames} 帧 → ${a.out}`);
    return { outputs: [{ path: portable(a.out), sha256: sheet.sha256 ?? null, kind: sheet.output === 'frames' ? 'frames' : 'atlas' }], data: sheet };
  },
});

if (isMain(import.meta.url)) await exitWith(runCli(command));
