// 北冥引擎 · 逐帧渲染成视频
//   node engine/render/video.mjs <影片目录> [--size 1920x1040] [--fps 24] [--workers 4] [--query k=v] [--out out/video.mp4]
// 时间轴切成 N 段，每段一个独立的无头 Chrome；每帧 JPEG 截图经管道送进 FFmpeg（x264 crf 14），最后无损拼接。
// 因为 render(t) 是确定性的，分段并行与单进程顺序渲染得到的是同一部片子。
import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { openFilm, closeServer, takeSize } from './page.mjs';

const args = process.argv.slice(2);
const { w, h } = takeSize(args);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const dir = args[0] || '.';
const FPS = +opt('--fps', 24), WORKERS = +opt('--workers', 4), query = opt('--query', '');
const out = path.resolve(opt('--out', 'out/video.mp4'));
fs.mkdirSync(path.dirname(out), { recursive: true });
const tmp = fs.mkdtempSync(path.join(path.dirname(out), '.segs-'));
const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const probe = await openFilm(dir, { w, h, query });
const DUR = await probe.page.evaluate(() => window.DUR);
console.log(`GPU：${probe.gpu || '未知'}`);
await probe.browser.close();
const TOTAL = Math.round(DUR * FPS), per = Math.ceil(TOTAL / WORKERS), t0 = Date.now();

async function worker(k) {
  const a = k * per, b = Math.min(TOTAL, a + per);
  if (a >= b) return null;
  const { browser, page } = await openFilm(dir, { w, h, query });
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', `seg_${k}.mp4`], { cwd: tmp, stdio: ['pipe', 'inherit', 'inherit'] });
  const closed = new Promise(r => ff.on('close', r));
  for (let f = a; f < b; f++) {
    await page.evaluate(t => window.render(t), f / FPS);
    const jpg = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(jpg)) await new Promise(r => ff.stdin.once('drain', r));
    if ((f - a) % 60 === 0) console.log(`段 ${k}  ${f - a}/${b - a}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  const code = await closed;
  await browser.close();
  if (code !== 0) throw new Error(`FFmpeg 在第 ${k} 段退出码 ${code}`);
  return `seg_${k}.mp4`;
}

try {
  const segs = (await Promise.all([...Array(WORKERS)].map((_, k) => worker(k)))).filter(Boolean);
  fs.writeFileSync(path.join(tmp, 'list.txt'), segs.map(s => `file '${s}'`).join('\n'));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'merged.mp4'], { cwd: tmp, stdio: 'inherit' });
  fs.renameSync(path.join(tmp, 'merged.mp4'), out);
  console.log(`完成 ${out}  ${TOTAL} 帧  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  console.error('渲染失败：', e.message); process.exitCode = 1;
} finally {
  cleanup(); await closeServer();
}
