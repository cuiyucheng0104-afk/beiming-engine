#!/usr/bin/env node
// 北冥引擎 · 原生层 · 序列帧图集：把任何「会动的画面」变成原生场景能贴的一张图集 PNG + 说明 JSON。
// 这是 render anything 的接口：A 路 / C 路的页面作品、现成视频、一组图片，都先在这里变成序列帧，
// 原生端用 engine/native/layers.tsx 的 <SequencePlane> 按帧号取格子（原生 ImagePlane 的 grid / frame）。
//
// 三种输入
//   page    满足页面约定的作品目录（window.DUR / render(t) / READY，见 engine/render/page.mjs），用无头 Chrome 逐帧渲
//   video   任意 FFmpeg 能解码的视频文件，按 fps 抽帧
//   frames  一个图片目录（按文件名排序）
// 输出
//   <out>.png   格子图集：cols × rows 个 cell 大小的格子，从左到右、从上到下；多余格子透明
//   <out>.json  { grid:[cols, rows], frames, fps, cell:[w, h], source, sha256 }
//
// 命令行
//   node engine/native/sequence.mjs page   <作品目录> --from 0 --until 2 --fps 12 --size 1920x1040 --cell 480x260 --out <图集.png> [--query k=v]
//   node engine/native/sequence.mjs video  <文件.mp4> --from 0 --until 2 --fps 12 --cell 480x270 --out <图集.png>
//   node engine/native/sequence.mjs frames <图片目录> --fps 12 --cell 480x270 --out <图集.png>
// 代码里：import { makeSequence } from 'engine/native/sequence.mjs'; await makeSequence({ kind, src, from, until, fps, size, cell, out })
//
// 限制：图集最长边不超过 8192 像素（常见 GPU 纹理上限），超了就报错让你缩小 cell 或减少帧数；整张图集一次进显存，
// 所以它适合几秒的小窗口 / 屏幕 / 贴图动画，不适合把整部长片塞进一个面片。
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX = 8192;
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
function run(args) {
  const p = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (p.error) throw p.error;
  if (p.status !== 0) throw new Error(`ffmpeg 失败：${p.stderr}`);
}
const pair = (s, name) => { const m = /^(\d+)x(\d+)$/.exec(String(s)); if (!m) throw new Error(`${name} 要写成 WxH`); return [+m[1], +m[2]]; };

export function layout(n, [cw, ch]) {
  const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * ch / cw)))), rows = Math.ceil(n / cols);
  if (cols * cw > MAX || rows * ch > MAX) throw new Error(`图集 ${cols * cw}×${rows * ch} 超过 ${MAX}：缩小 cell 或减少帧数`);
  return [cols, rows];
}

async function pageFrames(dir, tmp, { from, until, fps, size, query }) {
  const { openFilm, closeServer } = await import('../render/page.mjs');
  const [w, h] = size;
  const { browser, page } = await openFilm(dir, { w, h, query });
  const dur = await page.evaluate(() => window.DUR);
  const end = Math.min(until ?? dur, dur), n = Math.max(1, Math.round((end - from) * fps));
  try {
    for (let i = 0; i < n; i++) {
      await page.evaluate(t => window.render(t), from + i / fps);
      await page.screenshot({ path: join(tmp, `f${String(i).padStart(5, '0')}.png`), type: 'png' });
    }
  } finally { await browser.close(); await closeServer(); }
  return n;
}

function videoFrames(file, tmp, { from, until, fps }) {
  run(['-ss', String(from), ...(until !== undefined ? ['-t', String(until - from)] : []), '-i', file, '-vf', `fps=${fps}`, '-start_number', '0', join(tmp, 'f%05d.png')]);
}

async function dirFrames(src, tmp) {
  const files = (await readdir(src)).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort();
  if (!files.length) throw new Error(`${src} 里没有图片`);
  files.forEach((f, i) => run(['-i', join(src, f), join(tmp, `f${String(i).padStart(5, '0')}.png`)]));
}

export async function makeSequence({ kind, src, from = 0, until, fps = 12, size = [1920, 1080], cell, out, query = '' }) {
  if (!['page', 'video', 'frames'].includes(kind)) throw new Error(`kind 只能是 page / video / frames：${kind}`);
  if (!cell || !out) throw new Error('需要 cell 与 out');
  const tmp = await mkdtemp(join(tmpdir(), 'bne-seq-'));
  try {
    if (kind === 'page') await pageFrames(src, tmp, { from, until, fps, size, query });
    else if (kind === 'video') videoFrames(src, tmp, { from, until, fps });
    else await dirFrames(src, tmp);
    const n = (await readdir(tmp)).filter(f => f.endsWith('.png')).length;
    if (!n) throw new Error('没有得到任何帧');
    const [cols, rows] = layout(n, cell);
    await mkdir(dirname(resolve(out)), { recursive: true });
    run(['-framerate', String(fps), '-start_number', '0', '-i', join(tmp, 'f%05d.png'), '-vf',
      `scale=${cell[0]}:${cell[1]}:flags=lanczos,format=rgba,tile=${cols}x${rows}:nb_frames=${n}:color=0x00000000`, '-frames:v', '1', resolve(out)]);
    const sha256 = createHash('sha256').update(await readFile(resolve(out))).digest('hex');
    const sheet = { grid: [cols, rows], frames: n, fps, cell, source: { kind, src: String(src), from, until: until ?? null }, sha256 };
    await writeFile(resolve(out).replace(/\.png$/i, '') + '.json', JSON.stringify(sheet, null, 2) + '\n');
    return sheet;
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [kind, src, ...rest] = process.argv.slice(2);
  const opt = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  if (!kind || !src || !opt('--out')) { console.error('用法见 engine/native/sequence.mjs 文件开头的注释'); process.exit(2); }
  const sheet = await makeSequence({
    kind, src, from: Number(opt('--from') ?? 0), until: opt('--until') !== undefined ? Number(opt('--until')) : undefined,
    fps: Number(opt('--fps') ?? 12), size: opt('--size') ? pair(opt('--size'), '--size') : undefined, cell: pair(opt('--cell'), '--cell'),
    out: opt('--out'), query: opt('--query') || '',
  });
  console.log(JSON.stringify(sheet));
}
