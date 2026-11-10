// 北冥引擎 · 逐帧渲染成视频
//   node engine/render/video.mjs <影片目录> [--size 1920x1040] [--fps 24] [--any-fps] [--workers 4] [--query k=v] [--out out/video.mp4]
// 时间轴切成 N 段，每段一个独立的无头 Chrome；每帧 JPEG 截图经管道送进 FFmpeg（x264 crf 14），最后无损拼接。
// 因为 render(t) 是确定性的，分段并行与单进程顺序渲染得到的是同一部片子。拼接后核对帧数 = round(DUR × fps)。
//
// 帧率：页面的一拍二 / 一拍三按“页面帧率”量化，换个帧率渲染节奏就会抖（30 fps 时一拍二停 2、3、2、3 帧）。
//   页面帧率 = 页面声明的 window.FPS；没声明就是引擎默认的 24（engine/stage/film.js 与 engine/core/clock.js 的默认值，
//   《北冥》即如此）。不写 --fps 按页面帧率渲；--fps 与页面帧率不一致直接报错（退出码 2）。
//   页面确实与帧率无关、或明知节奏会不均还要换帧率时，加 --any-fps 跳过这项检查（会打印提示）。
// 色彩：截图是全范围 BT.601 的 JPEG；分段编码时显式转成有限范围 BT.709 并写明标记（1-1-1、tv），
//   结果不随 FFmpeg 版本的隐式范围协商而变。从成片取帧比静帧要精确解码（做法见 mux.sh 开头），
//   FFmpeg 默认的快速 yuv→rgb 会整体读暗约 2 级。
// 失败：任何一段出错（render 抛错、页面报错或缺文件、FFmpeg 中途退出、收到 SIGINT / SIGTERM / SIGHUP）都会
//   停下其余各段，关掉所有浏览器和 FFmpeg，等子进程都退出后删掉临时目录 <输出目录>/.segs-*，以非零码退出
//   （用法错误 2，渲染失败 1，信号 128+n）；不会挂住，也不会留下半成品。第二次 Ctrl-C 立即强退。
//   单帧 render(t) 超过 BEIMING_FRAME_TIMEOUT 秒（默认 300）没返回也按失败处理。
import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { openFilm, closeServer, takeSize, FilmError } from './page.mjs';
import { takeOptions, positiveInt, positiveNumber, UsageError } from './args.mjs';

const USAGE = '用法：node engine/render/video.mjs <影片目录> [--size WxH] [--fps 24] [--any-fps] [--workers 4] [--query k=v] [--out out/video.mp4]';
const args = process.argv.slice(2);
let dir, w, h, fpsArg, anyFps, WORKERS, query, out;
try {
  ({ w, h } = takeSize(args));
  const o = takeOptions(args, ['--fps', '--workers', '--query', '--out'], { flags: ['--any-fps'] });
  if (args.length > 1) throw new UsageError(`多余的参数：${args.slice(1).join(' ')}`);
  dir = args[0] || '.';
  fpsArg = o['--fps'] === undefined ? null : positiveNumber(o['--fps'], '--fps');
  anyFps = Boolean(o['--any-fps']);
  WORKERS = o['--workers'] === undefined ? 4 : positiveInt(o['--workers'], '--workers');
  query = o['--query'] ?? '';
  out = path.resolve(o['--out'] ?? 'out/video.mp4');
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(e.message); console.error(USAGE); process.exit(2);
}

// 截图（全范围 BT.601）→ 有限范围 BT.709，并写明标记
const COLOR = 'scale=in_range=full:in_color_matrix=bt601:out_range=limited:out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,'
  + 'format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
const TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

const sleep = ms => new Promise(r => setTimeout(r, ms).unref());
// 单帧 render(t) 的上限（秒）：页面卡死（例如死循环）时这一段判失败，而不是永远等下去
const FRAME_TIMEOUT = (Number(process.env.BEIMING_FRAME_TIMEOUT) > 0 ? Number(process.env.BEIMING_FRAME_TIMEOUT) : 300) * 1000;
const ac = new AbortController();
const live = new Set();            // 还没退出的 FFmpeg 子进程
let tmp = null;
function removeTmp() {
  if (!tmp) return;
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); tmp = null; }
  catch (e) { console.error(`[清理] 临时目录没删掉：${tmp}（${e.message}）`); }
}
// 兜底：无论从哪条路退出，都杀掉残留的 FFmpeg、删临时目录（浏览器由 Playwright 自己的 exit 钩子杀掉）
process.on('exit', () => {
  for (const p of live) { try { p.kill('SIGKILL'); } catch {} }
  removeTmp();
});
let stopping = 0;
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(sig, () => {
    if (stopping++) process.exit(code);
    console.error(`\n收到 ${sig}：停下各段，关闭浏览器和 FFmpeg，清理临时文件…（再按一次 Ctrl-C 立即退出）`);
    process.exitCode = code;
    ac.abort(Object.assign(new Error(`收到 ${sig}，已中止`), { exitCode: code }));
    sleep(20000).then(() => process.exit(code));
  });
}

const describeExit = r => r.error ? `无法运行：${r.error.message}` : r.sig ? `被信号 ${r.sig} 终止` : `退出码 ${r.code}`;
// 报错里照实写出页面给的值：NaN / Infinity 照原样（JSON.stringify 会把它们写成 null），没设置写 undefined，别的类型注明类型
function show(v) {
  if (v === undefined) return 'undefined（没有设置）';
  if (v === null || typeof v === 'number') return String(v);
  try { return `${JSON.stringify(v) ?? String(v)}（${typeof v}）`; } catch { return `${String(v)}（${typeof v}）`; }
}
function stopFfmpeg(ff) {
  try { ff.stdin.destroy(); } catch {}
  try { ff.kill('SIGKILL'); } catch {}
}

// 把一帧写进 FFmpeg 的 stdin；管道满了就等 drain，同时盯着 FFmpeg 退出和中止信号，绝不无限等待
async function feed(ff, buf, exited, k) {
  const { signal } = ac;
  const gone = async () => new Error(`FFmpeg 在第 ${k} 段中途退出（${describeExit(await Promise.race([exited, sleep(5000).then(() => ({ code: '未知' }))]))}）`);
  if (ff.exitCode !== null || ff.signalCode !== null || ff.stdin.destroyed || !ff.stdin.writable) throw await gone();
  if (ff.stdin.write(buf)) return;
  let onDrain, onAbort;
  const why = await Promise.race([
    new Promise(r => { onDrain = () => r('drain'); ff.stdin.once('drain', onDrain); }),
    new Promise(r => { onAbort = () => r('abort'); signal.addEventListener('abort', onAbort, { once: true }); }),
    exited.then(() => 'exit'),
  ]);
  ff.stdin.off('drain', onDrain); signal.removeEventListener('abort', onAbort);
  if (why === 'abort') throw signal.reason;
  if (why === 'exit') throw await gone();
}

async function worker(k, a, b, ctx) {
  const { signal } = ac;
  let film = null, ff = null, exited = null;
  const stop = () => { if (ff) stopFfmpeg(ff); film?.close(); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    film = await openFilm(dir, { w, h, query, handleSignals: false, signal });
    if (signal.aborted) throw signal.reason;
    ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(ctx.FPS), '-c:v', 'mjpeg', '-i', '-',
      '-vf', COLOR, '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', ...TAGS, `seg_${k}.mp4`],
      { cwd: tmp, stdio: ['pipe', 'inherit', 'inherit'] });
    live.add(ff);
    exited = new Promise(r => { ff.once('close', (code, sig) => r({ code, sig })); ff.once('error', error => r({ error })); });
    ff.stdin.on('error', () => {});   // FFmpeg 中途退出时的 EPIPE：由 exited 报告
    const early = await Promise.race([new Promise(r => ff.once('spawn', () => r(null))), exited]);
    if (early) throw new Error(`第 ${k} 段 FFmpeg 没能启动（${describeExit(early)}）`);
    for (let f = a; f < b; f++) {
      if (signal.aborted) throw signal.reason;
      const where = `第 ${k} 段第 ${f} 帧（t=${(f / ctx.FPS).toFixed(4)}s）`;
      let timer;
      try {
        const stuck = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`超过 ${FRAME_TIMEOUT / 1000} 秒没有返回（BEIMING_FRAME_TIMEOUT 可调）`)), FRAME_TIMEOUT);
        });
        await Promise.race([film.page.evaluate(t => window.render(t), f / ctx.FPS), stuck]);
      } catch (e) { throw signal.aborted ? signal.reason : new Error(`${where}render 出错：${e.message}`); }
      finally { clearTimeout(timer); }
      const jpg = await film.page.screenshot({ type: 'jpeg', quality: 95 });
      film.check();
      await feed(ff, jpg, exited, k);
      if ((f - a) % 60 === 0) console.log(`段 ${k}  ${f - a}/${b - a}  ${((Date.now() - ctx.t0) / 1000).toFixed(0)}s`);
    }
    ff.stdin.end();
    const r = await Promise.race([exited, new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })]);
    if (r.code !== 0) throw new Error(`FFmpeg 在第 ${k} 段${describeExit(r)}`);
    return `seg_${k}.mp4`;
  } finally {
    signal.removeEventListener('abort', stop);
    if (ff) {
      if (ff.exitCode === null && ff.signalCode === null) stopFfmpeg(ff);
      await Promise.race([exited, sleep(10000)]);
      live.delete(ff);
    }
    await film?.close();
  }
}

// 运行一个子进程（拼接），可被中止
function run(cmd, argv, cwd, what) {
  const { signal } = ac;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const p = spawn(cmd, argv, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
    live.add(p);
    const onAbort = () => { try { p.kill('SIGKILL'); } catch {} };
    signal.addEventListener('abort', onAbort, { once: true });
    const done = r => {
      live.delete(p); signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(signal.reason);
      else if (r.code === 0) resolve();
      else reject(new Error(`${what}失败：${cmd} ${describeExit(r)}`));
    };
    p.once('error', error => done({ error }));
    p.once('close', (code, sig) => done({ code, sig }));
  });
}

const countFrames = file => parseInt(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
  '-show_entries', 'stream=nb_read_packets', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' }), 10);

let exitCode = 0;
try {
  // 1) 探测：时长、页面帧率、GPU
  const probe = await openFilm(dir, { w, h, query, handleSignals: false, signal: ac.signal });
  let DUR, pageFps;
  try {
    [DUR, pageFps] = await probe.page.evaluate(() => [window.DUR, window.FPS]);
    probe.check();
  } finally { await probe.close(); }
  console.log(`GPU：${probe.gpu || '未知'}`);
  if (typeof DUR !== 'number' || !Number.isFinite(DUR) || DUR <= 0) throw new FilmError(`页面的 window.DUR 必须是正数（秒），收到 ${show(DUR)}`);
  if (pageFps !== undefined && pageFps !== null && !(typeof pageFps === 'number' && Number.isFinite(pageFps) && pageFps > 0)) {
    throw new FilmError(`页面的 window.FPS 必须是正数，收到 ${show(pageFps)}`);
  }
  const declared = pageFps ?? null;
  const pageRate = declared ?? 24;   // 没声明：按引擎默认 24 fps 量化（engine/stage/film.js、engine/core/clock.js）
  const whose = declared !== null ? `页面声明的 window.FPS=${declared}` : '页面帧率 24（页面没有声明 window.FPS，按引擎默认 24 fps 量化）';
  if (fpsArg !== null && Math.abs(fpsArg - pageRate) > 1e-9) {
    if (!anyFps) {
      throw new FilmError(`--fps ${fpsArg} 与${whose}不一致：一拍二 / 一拍三按 ${pageRate} fps 量化，换成 ${fpsArg} fps 节奏会抖。`
        + `去掉 --fps 按 ${pageRate} fps 渲；页面按别的帧率编写就在页面里声明 window.FPS；确认与帧率无关或接受节奏不均，加 --any-fps`, 2);
    }
    console.error(`[提示] --any-fps：按 ${fpsArg} fps 渲染，但${whose}，一拍二 / 一拍三的节奏可能不均匀`);
  }
  const FPS = fpsArg ?? pageRate;
  const TOTAL = Math.round(DUR * FPS);
  if (TOTAL < 1) throw new FilmError(`DUR=${DUR} 秒 × ${FPS} fps 不到 1 帧`);

  // 2) 分段并行渲染：任何一段失败就中止其余各段
  const N = Math.min(WORKERS, TOTAL), per = Math.ceil(TOTAL / N);
  const plan = [];
  for (let k = 0; k * per < TOTAL; k++) plan.push([k, k * per, Math.min(TOTAL, (k + 1) * per)]);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  tmp = fs.mkdtempSync(path.join(path.dirname(out), '.segs-'));
  const ctx = { FPS, t0: Date.now() };
  await Promise.allSettled(plan.map(([k, a, b]) => worker(k, a, b, ctx).catch(e => { if (!ac.signal.aborted) ac.abort(e); throw e; })));
  if (ac.signal.aborted) throw ac.signal.reason;

  // 3) 无损拼接并核对帧数
  fs.writeFileSync(path.join(tmp, 'list.txt'), plan.map(([k]) => `file 'seg_${k}.mp4'`).join('\n') + '\n');
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'merged.mp4'], tmp, '拼接');
  const frames = countFrames(path.join(tmp, 'merged.mp4'));
  if (frames !== TOTAL) throw new Error(`拼接后是 ${frames} 帧，应为 ${TOTAL} 帧（DUR=${DUR} × ${FPS} fps）`);
  if (ac.signal.aborted) throw ac.signal.reason;
  fs.renameSync(path.join(tmp, 'merged.mp4'), out);
  console.log(`完成 ${out}  ${TOTAL} 帧  ${((Date.now() - ctx.t0) / 1000).toFixed(1)}s`);
} catch (e) {
  console.error('渲染失败：', e?.message ?? e);
  exitCode = e?.exitCode ?? 1;
} finally {
  removeTmp();                 // 各段的 FFmpeg 都已退出（worker 的 finally 里等过），这时才删
  await closeServer();
}
process.exitCode = exitCode;
// 正常情况下所有句柄都已关闭、进程自然退出；万一还有东西挂着，5 秒后强制退出（定时器 unref，不会拖住正常退出）
sleep(5000).then(() => process.exit(exitCode));
