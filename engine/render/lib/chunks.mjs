// 北冥引擎 · 分块逐帧渲染（video.mjs 与 shots.mjs 共用）：把帧区间 [a, b) 切成固定的块，几个浏览器从同一个队列取块，
// 每块一个 FFmpeg（截图经管道进去，只做一次色彩换算，编成一段或几段 H.264），块写完先核对帧数再原子改名。
//
// 块的边界只由帧区间与帧率决定（planChunks），与 --workers 无关：同一个区间不管开几路，切出来的块一样，成片逐字节一样；
// 中途停下后（--resume）已写完的块原样复用，补渲剩下的块，结果与一次跑完相同。
//   planChunks(a, b, { chunk, fps })   chunk='auto'：块长 = clamp(ceil(总帧 / 8), 1 秒, 10 秒)，再均分；或给定帧数
//   renderRange(o)                     渲染并返回 { files: { 输出类别: [块文件…] }, hashes, deps, info, contract, warnings, stats }
// 每帧：render(t)（t = 帧号 / fps）→ 截图（png：CDP 无损；jpeg：q95，只用于 --fast 预览）→ sha256 前 16 位记进 hashes →
// 喂给 FFmpeg。任何一块出错（render 抛错、页面报错、上下文丢失、FFmpeg 退出）立即中止所有块，杀掉 FFmpeg，删掉半成品。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openFilm, renderFrame, finalFaultCheck } from '../page.mjs';
import { RenderError } from './errors.mjs';
import { FFMPEG, probe } from './ffmpeg.mjs';
import { sha256 } from './record.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms).unref());
const pad = n => String(n).padStart(6, '0');
export const chunkName = (kind, a, b) => `${kind}-${pad(a)}-${pad(b)}.mp4`;

/**
 * 整片的块：先按镜头边界切（film.json v2 的 shots），每个镜头再各自 planChunks；evaluation 为 sequential 的镜头（有状态、
 * 只能从头顺序渲）整段一块。只渲 [a, b) 的一部分时，与区间相交的部分照同样的规则切。没有镜头表时就是 planChunks(a, b)。
 * 这样 video.mjs 渲整片与 shots.mjs 逐镜头渲，块的边界完全相同。
 */
export function planFilmChunks(a, b, { shots = [], chunk = 'auto', fps = 24 } = {}) {
  const usable = shots.filter(s => Number.isInteger(s.in) && Number.isInteger(s.out)).sort((x, y) => x.in - y.in);
  if (!usable.length) return planChunks(a, b, { chunk, fps });
  const out = [];
  let cur = a;
  for (const s of usable) {
    if (s.in >= b) break;                                             // 区间之后的镜头：不再看（空隙也不能补到 b 之后）
    if (s.out <= cur) continue;                                       // 区间之前的镜头，或与上一个镜头完全重叠
    const lo = Math.max(cur, s.in), hi = Math.min(b, s.out);         // 与上一个镜头重叠的部分已经切过，不重复
    if (cur < lo) out.push(...planChunks(cur, lo, { chunk, fps }));   // 镜头表没覆盖的空隙
    if (hi > lo) {
      if (s.raw?.evaluation === 'sequential') {
        if (lo !== s.in) throw new RenderError('usage.sequential-partial', `镜头 ${s.id} 是 sequential（有状态），只能从它的第一帧 ${s.in} 开始渲`, { hint: `--frames 的起点改成 ${s.in}，或整镜渲 --shot ${s.id}` });
        out.push([lo, hi]);
      } else out.push(...planChunks(s.in, s.out, { chunk, fps }).map(([x, y]) => [Math.max(x, lo), Math.min(y, hi)]).filter(([x, y]) => y > x));
    }
    cur = Math.max(cur, hi);
  }
  if (cur < b) out.push(...planChunks(cur, b, { chunk, fps }));
  return out;
}

export function planChunks(a, b, { chunk = 'auto', fps = 24 } = {}) {
  const total = b - a;
  if (!(total > 0)) return [];
  const size = chunk === 'auto' ? Math.min(Math.max(Math.ceil(total / 8), Math.round(fps)), Math.round(fps * 10)) : chunk;
  const count = Math.max(1, Math.ceil(total / size));
  const out = [];
  for (let i = 0; i < count; i++) out.push([a + Math.round((i * total) / count), a + Math.round(((i + 1) * total) / count)]);
  return out.filter(([x, y]) => y > x);
}

const describeExit = r => (r.error ? `无法运行：${r.error.message}` : r.sig ? `被信号 ${r.sig} 终止` : `退出码 ${r.code}`);

// 把一帧写进 FFmpeg 的 stdin；管道满了就等 drain，同时盯着 FFmpeg 退出和中止信号，绝不无限等待
async function feed(ff, buf, exited, signal, where) {
  const gone = async () => new RenderError('failure.ffmpeg-exited', `FFmpeg 在${where}中途退出（${describeExit(await Promise.race([exited, sleep(5000).then(() => ({ code: '未知' }))]))}）`, {
    hint: 'FFmpeg 自己的报错见上面；常见原因：磁盘满、编码参数不被这个 FFmpeg 支持',
  });
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

/**
 * @param {object} o
 * @param {string} o.dir @param {string} o.query @param {number} o.w @param {number} o.h @param {number} o.fps
 * @param {Array<[number,number]>} o.chunks       planChunks 的结果
 * @param {number} o.workers
 * @param {'png'|'jpeg'} o.intermediate
 * @param {Array<{kind: string, vf: string, args: string[]}>} o.outputs   每块的输出（第一个是主输出）
 * @param {string} o.workDir                       块文件目录（调用方负责创建与清理）
 * @param {boolean} [o.reuse]                      已存在且帧数对的块直接复用（--resume）
 * @param {object} o.openOptions                   openFilm 的选项
 * @param {object} [o.firstFilm]                   已打开的探测页，给第 0 路复用（省一次冷启动）
 * @param {AbortSignal} o.signal @param {Set} o.live  还没退出的子进程（调用方在 exit 钩子里杀）
 * @param {(e: {done:number, total:number, reused:number}) => void} [o.onProgress]
 */
export async function renderRange(o) {
  const { dir, query, fps, chunks, intermediate, outputs, workDir, reuse = false, openOptions, signal: outer, live, onProgress, settle = 'none', frameTimeoutMs } = o;
  const ac = new AbortController();
  const abort = e => { if (!ac.signal.aborted) ac.abort(e); };
  const onOuter = () => abort(outer.reason);
  if (outer.aborted) throw outer.reason;
  outer.addEventListener('abort', onOuter, { once: true });
  const signal = ac.signal;
  const total = chunks.reduce((s, [a, b]) => s + (b - a), 0);
  const hashes = new Map();
  const deps = new Map();
  const external = new Set();
  const warnings = [];
  const perFrame = [];
  let done = 0, rendered = 0, reused = 0, info = null, contract = null;
  const files = Object.fromEntries(outputs.map(x => [x.kind, chunks.map(([a, b]) => path.join(workDir, chunkName(x.kind, a, b)))]));

  // 复用：主输出与所有附加输出都在、帧数对，且有记录逐帧哈希的旁注文件
  const todo = [];
  for (let i = 0; i < chunks.length; i++) {
    const [a, b] = chunks[i];
    if (reuse) {
      const meta = readMeta(files[outputs[0].kind][i]);
      const ok = meta && meta.a === a && meta.b === b && outputs.every(x => fs.existsSync(files[x.kind][i]));
      if (ok && (await Promise.all(outputs.map(x => probe(files[x.kind][i]).then(p => p.video?.frames === b - a).catch(() => false)))).every(Boolean)) {
        meta.hashes.forEach((h, k) => hashes.set(a + k, h));
        for (const [p, s] of Object.entries(meta.deps ?? {})) deps.set(p, s);
        reused++; done += b - a;
        continue;
      }
    }
    todo.push(i);
  }
  onProgress?.({ done, total, reused });

  let next = 0;
  const claim = () => (next < todo.length ? todo[next++] : null);
  const t0 = Date.now();

  async function renderChunk(film, i, k) {
    const [a, b] = chunks[i];
    const partial = outputs.map(x => files[x.kind][i].replace(/\.mp4$/, '.partial.mp4'));
    const input = intermediate === 'png' ? ['-c:v', 'png'] : ['-c:v', 'mjpeg'];
    const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), ...input, '-i', '-'];
    if (outputs.length === 1) args.push('-vf', outputs[0].vf, ...outputs[0].args, path.basename(partial[0]));
    else {
      const labels = outputs.map((_, j) => `[o${j}]`);
      args.push('-filter_complex', `[0:v]split=${outputs.length}${outputs.map((_, j) => `[s${j}]`).join('')};` + outputs.map((x, j) => `[s${j}]${x.vf}${labels[j]}`).join(';'));
      outputs.forEach((x, j) => args.push('-map', labels[j], ...x.args, path.basename(partial[j])));
    }
    const ff = spawn(FFMPEG(), args, { cwd: workDir, stdio: ['pipe', 'ignore', 'inherit'] });
    live.add(ff);
    const exited = new Promise(r => { ff.once('close', (code, sig) => r({ code, sig })); ff.once('error', error => r({ error })); });
    ff.stdin.on('error', () => {});   // FFmpeg 中途退出时的 EPIPE：由 exited 报告
    const stop = () => { try { ff.stdin.destroy(); } catch {} try { ff.kill('SIGKILL'); } catch {} };
    signal.addEventListener('abort', stop, { once: true });
    const blockHashes = [];
    try {
      const early = await Promise.race([new Promise(r => ff.once('spawn', () => r(null))), exited]);
      if (early) throw new RenderError('env.ffmpeg-spawn', `FFmpeg 没能启动（${describeExit(early)}）`, { hint: '运行 ffmpeg -version 确认可用；或设 FFMPEG 为完整路径' });
      for (let f = a; f < b; f++) {
        if (signal.aborted) throw signal.reason;
        const t = f / fps;
        const where = `第 ${k} 路第 ${f} 帧（t=${t.toFixed(4)}s）`;
        const f0 = Date.now();
        await renderFrame(film, t, { timeoutMs: frameTimeoutMs, settle, where, signal });
        const img = await film.capture(intermediate);
        film.check();
        const h = sha256(img).slice(0, 16);
        hashes.set(f, h); blockHashes.push(h);
        await feed(ff, img, exited, signal, where);
        perFrame.push(Date.now() - f0);
        done++; rendered++;
        onProgress?.({ done, total, reused });
      }
      ff.stdin.end();
      const r = await Promise.race([exited, new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })]);
      if (r.code !== 0) throw new RenderError('failure.ffmpeg', `FFmpeg 编码第 ${a}–${b - 1} 帧时${describeExit(r)}`, { hint: 'FFmpeg 自己的报错见上面' });
      for (let j = 0; j < outputs.length; j++) {
        const n = (await probe(partial[j], { signal })).video?.frames;
        if (n !== b - a) throw new RenderError('contract.frame-count', `第 ${a}–${b - 1} 帧这一块编出来是 ${n} 帧，应为 ${b - a} 帧`, { hint: '编码器丢帧或重复帧：带上日志报告' });
      }
      for (let j = 0; j < outputs.length; j++) fs.renameSync(partial[j], files[outputs[j].kind][i]);
      writeMeta(files[outputs[0].kind][i], { a, b, hashes: blockHashes, deps: Object.fromEntries(film.requests) });
    } finally {
      signal.removeEventListener('abort', stop);
      if (ff.exitCode === null && ff.signalCode === null) stop();
      await Promise.race([exited, sleep(10000)]);
      live.delete(ff);
      for (const p of partial) { try { fs.rmSync(p, { force: true }); } catch {} }
    }
  }

  async function worker(k) {
    let film = k === 0 && o.firstFilm ? o.firstFilm : null;
    try {
      if (signal.aborted) throw signal.reason;
      if (claimPeek() === null && !film) return;   // 没活：不必开浏览器
      film ??= await openFilm(dir, { ...openOptions, handleSignals: false, signal });
      info ??= film.info; contract ??= film.contract;
      for (let i = claim(); i !== null; i = claim()) await renderChunk(film, i, k);
      await finalFaultCheck(film);
    } catch (e) {
      abort(e);
      throw e;
    } finally {
      if (film) {
        for (const [p, s] of film.requests) deps.set(p, s);
        for (const u of film.external) external.add(u);
        for (const w of film.warnings) warnings.push(w);
        await film.close();
      }
    }
  }
  const claimPeek = () => (next < todo.length ? todo[next] : null);

  try {
    const n = Math.max(1, Math.min(o.workers, todo.length || 1));
    await Promise.allSettled(Array.from({ length: n }, (_, k) => worker(k)));
    if (signal.aborted) throw signal.reason;
  } finally {
    outer.removeEventListener('abort', onOuter);
  }
  perFrame.sort((x, y) => x - y);
  const q = p => (perFrame.length ? perFrame[Math.min(perFrame.length - 1, Math.floor(p * perFrame.length))] : null);
  return {
    files, deps, info, contract, warnings, external: [...external],
    hashes: Array.from({ length: total }, (_, i) => hashes.get(chunks[0][0] + i) ?? null),
    hashMap: hashes,
    stats: { renderedFrames: rendered, reusedChunks: reused, chunks: chunks.length,
      seconds: +((Date.now() - t0) / 1000).toFixed(2), perFrameMs: { p50: q(0.5), p95: q(0.95), max: perFrame.at(-1) ?? null } },
  };
}

const metaPath = file => `${file}.json`;
function readMeta(file) { try { return JSON.parse(fs.readFileSync(metaPath(file), 'utf8')); } catch { return null; } }
function writeMeta(file, meta) { const tmp = `${metaPath(file)}.tmp`; fs.writeFileSync(tmp, JSON.stringify(meta)); fs.renameSync(tmp, metaPath(file)); }

/** 把几段同参数的 H.264 无损拼接（concat 复制，不重编码），核对帧数后原子改名；metadata 是附加的 -metadata 参数（AIGC 标识） */
export async function concatChunks(list, out, { expectFrames, signal, live, workDir, metadata = [] }) {
  const listFile = path.join(workDir, `concat-${process.pid}-${path.basename(out)}.txt`);
  fs.writeFileSync(listFile, list.map(f => `file '${path.relative(workDir, f).split(path.sep).join('/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const partial = path.join(workDir, `merged-${process.pid}-${path.basename(out)}`);
  try {
    const { must } = await import('./ffmpeg.mjs');
    await must(FFMPEG(), ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.basename(listFile), '-c', 'copy', ...metadata, path.basename(partial)], '拼接', { cwd: workDir, signal, live });
    const p = await probe(partial, { signal });
    if (p.video?.frames !== expectFrames) throw new RenderError('contract.frame-count', `拼接后是 ${p.video?.frames} 帧，应为 ${expectFrames} 帧`, { hint: '块文件不完整或参数不一致：去掉 --resume 重渲' });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.renameSync(partial, out);
    return p;
  } finally {
    fs.rmSync(listFile, { force: true });
    fs.rmSync(partial, { force: true });
  }
}
