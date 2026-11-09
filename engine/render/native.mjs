#!/usr/bin/env node
// 北冥引擎 · 原生渲染入口（北冥原生 · BNE）：任何原生作品目录（有 film.json，route = "b"）都用它出片。
//   node engine/render/native.mjs <作品目录> [--check-only] [--at 0,48,96] [--quality master|high|draft] [--mux mux.sh|copy] [--out 路径.mp4]
//
// 步骤：
//   1. 版本预检：RAEA_BIN 指向的原生运行时（安装包 share/raea/VERSION）必须等于已验证版本 0.1.0-canary.2；
//      换版本要先重新验证，临时放行用 BNE_ALLOW_VERSION=<版本>。另查 ffmpeg / ffprobe / sh。
//   2. 素材检查：film.json native.models / images / sequences / audio 声明的产物，以及 film.tsx 里字面量 staticFile('x') 与
//      'media/x' 引用的文件，都必须已在作品 media/ 下（先跑 node engine/native/prepare.mjs <作品目录>）。
//   --check-only 到此为止，不启动 GPU。
//   3. 共享 GPU 检查：ComfyUI 队列（COMFY_URL，默认 127.0.0.1:8188）有任务、或 nvidia-smi 利用率 > 10% 时退出；从不终止别人的进程。
//   4. 原生渲染：raea render <entry> -o out/native.mp4 --quality master --manifest out/render.json（日志存 out/render.*.log）。
//      --at 时只渲这几帧 PNG 到 out/stills/ 供查看，然后结束。
//   5. 封装：sh engine/render/mux.sh（两遍 loudnorm 到 −14 LUFS / −1.2 dBTP，x264 重编码画面）→ native.output（默认 out/<目录名>.mp4）；
//      --mux copy（或 film.json native.mux）：画面逐位复制原生编码，只把声音做同样的两遍线性 loudnorm 后编 AAC——
//      用于和原生渲染逐帧比对，或需要保留 master 画质时。没有声音时只复制视频轨，并在报告里写明无声。
//   6. 输出核对：ffprobe 完整解码，帧数 = round(dur × fps)、尺寸 = size、帧率 = fps、有 AAC（有声时）、时长误差 < 0.05 秒；
//      结果写到输出旁的 technical.json。技术检查不替代看片。
// 环境变量：RAEA_BIN（必需）、FFMPEG、FFPROBE、WGPU_BACKEND（Windows 默认 vulkan）、COMFY_URL、BNE_ALLOW_VERSION。
import { access, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const VALIDATED = '0.1.0-canary.2';
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.error(`原生渲染停止：${e?.message ?? e}`); process.exit(1); });
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ffmpeg = process.env.FFMPEG || 'ffmpeg', ffprobe = process.env.FFPROBE || 'ffprobe';
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const dirArg = args.find((a, i) => !a.startsWith('--') && !['--at', '--quality', '--out', '--mux'].includes(args[i - 1]));
if (!dirArg || args.includes('--help')) { console.log('node engine/render/native.mjs <作品目录> [--check-only] [--at 0,48,96] [--quality master|high|draft] [--mux mux.sh|copy] [--out 路径.mp4]'); process.exit(dirArg ? 0 : 2); }
const dir = resolve(dirArg);
const rel = p => relative(process.cwd(), p) || '.';

function run(bin, a, { cwd = dir, env = process.env } = {}) {
  const p = spawnSync(bin, a, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (p.error) throw p.error;
  return p;
}
function must(p, label) { if (p.status !== 0) throw new Error(`${label} 失败（${p.status}）：${p.stderr}\n${p.stdout}`); return p; }

const film = JSON.parse(await readFile(resolve(dir, 'film.json'), 'utf8'));
if (film.route !== 'b') throw new Error(`${rel(dir)}/film.json 的 route 是 ${film.route}，原生渲染只处理 "b"`);
const N = film.native || {}, entry = N.entry || 'film.tsx';
const [W, H] = film.size, FPS = film.fps, FRAMES = Math.round(film.dur * FPS);
const output = resolve(dir, opt('--out') || N.output || `out/${basename(dir)}.mp4`);
const mux = opt('--mux') || N.mux || 'mux.sh';
if (!['mux.sh', 'copy'].includes(mux)) throw new Error(`--mux 只能是 mux.sh 或 copy：${mux}`);

// 1. 版本预检（canary.2 没有 --version，安装包的 share/raea/VERSION 是版本声明）
const raea = process.env.RAEA_BIN;
if (!raea) throw new Error('请把 RAEA_BIN 设为单独安装的原生运行时可执行文件的完整路径');
const exe = await realpath(raea);
const version = (await readFile(resolve(dirname(exe), '../share/raea/VERSION'), 'utf8')).trim();
const runtime = `RAEA ${version} (package VERSION)`;
if (version !== VALIDATED && version !== process.env.BNE_ALLOW_VERSION) throw new Error(`已验证的运行时版本是 ${VALIDATED}，这里是 ${version}；先重新验证，或设 BNE_ALLOW_VERSION=${version} 临时放行`);
must(run(ffmpeg, ['-version']), 'FFmpeg'); must(run(ffprobe, ['-version']), 'ffprobe');
const sh = run('sh', ['-c', 'exit 0']);
if (sh.error || sh.status !== 0) throw new Error('封装要用 sh 运行 engine/render/mux.sh（Windows 请装 Git Bash 并把 sh 放进 PATH）');

// 2. 素材检查
const source = await readFile(resolve(dir, entry), 'utf8');
const need = new Set();
for (const m of source.matchAll(/staticFile\(\s*['"]([^'"]+)['"]\s*\)/g)) need.add(m[1]);
for (const m of source.matchAll(/['"]media\/([^'"]+)['"]/g)) need.add(m[1]);
for (const list of [N.images, N.models, N.sequences]) for (const x of list || []) need.add(x.to);
const audio = N.audio ? resolve(dir, 'media', N.audio.out || 'mix.wav') : null;
const missing = [];
for (const f of need) { try { await access(resolve(dir, 'media', f)); } catch { missing.push(f); } }
if (audio) { try { await access(audio); } catch { missing.push(relative(resolve(dir, 'media'), audio)); } }
if (missing.length) throw new Error(`media/ 缺少：${missing.join('、')}。先运行 node engine/native/prepare.mjs ${rel(dir)}`);
if (args.includes('--check-only')) {
  console.log(`${runtime}\n运行时、工具与 ${need.size + (audio ? 1 : 0)} 个素材齐全；未启动 GPU 渲染。`);
  process.exit(0);
}

// 3. 共享 GPU：只检查，不终止任何进程
let queue;
try {
  const r = await fetch(`${process.env.COMFY_URL || 'http://127.0.0.1:8188'}/queue`, { signal: AbortSignal.timeout(2500) });
  if (r.ok) queue = await r.json();
} catch { /* 没装 ComfyUI 不是错误 */ }
if (queue?.queue_running?.length || queue?.queue_pending?.length) throw new Error('ComfyUI 队列有任务，等它跑完再渲。');
const gpu = (() => {
  const p = spawnSync('nvidia-smi', ['--query-gpu=name,utilization.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000 });
  if (p.error || p.status !== 0) return { available: false, busy: false };
  const lines = p.stdout.trim().split('\n');
  return { available: true, samples: lines, busy: lines.some(l => Number(l.split(',').at(-1).trim()) > 10) };
})();
if (gpu.busy) throw new Error('GPU 利用率超过 10%，共享工作站空闲后再渲。');

// 4. 原生渲染
const out = resolve(dir, 'out');
await mkdir(out, { recursive: true });
const env = { ...process.env };
if (process.platform === 'win32' && !env.WGPU_BACKEND) env.WGPU_BACKEND = 'vulkan';
if (opt('--at')) {
  await mkdir(resolve(out, 'stills'), { recursive: true });
  const p = run(raea, ['render', entry, '--at', opt('--at'), '-o', 'out/stills/'], { env });
  must(p, '原生静帧');
  console.log(`静帧已写到 ${rel(resolve(out, 'stills'))}/（帧号 ${opt('--at')}）`);
  process.exit(0);
}
console.log(`原生渲染：${runtime}，后端 ${env.WGPU_BACKEND || '运行时默认'}，${W}×${H} ${FPS}fps ${FRAMES} 帧`);
const t0 = Date.now();
const native = run(raea, ['render', entry, '-o', 'out/native.mp4', '--quality', opt('--quality') || 'master', '--manifest', 'out/render.json'], { env });
await writeFile(resolve(out, 'render.stdout.log'), native.stdout || '');
await writeFile(resolve(out, 'render.stderr.log'), native.stderr || '');
must(native, `原生渲染（见 ${rel(resolve(out, 'render.stderr.log'))}）`);
const renderSeconds = (Date.now() - t0) / 1000;

// 5. 封装声音
await mkdir(dirname(output), { recursive: true });
if (audio && mux === 'copy') {
  // 画面逐位保留原生编码；声音做与 mux.sh 相同的两遍线性 loudnorm（−14 LUFS / −1.2 dBTP）后编 AAC
  const first = must(run(ffmpeg, ['-hide_banner', '-nostats', '-i', audio, '-af', 'loudnorm=I=-14:TP=-1.2:LRA=11:print_format=json', '-f', 'null', '-']), '响度测量');
  const m = JSON.parse(first.stderr.match(/\{\s*"input_i"[\s\S]*?\}/)[0]);
  const ln = `loudnorm=I=-14:TP=-1.2:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  must(run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', resolve(out, 'native.mp4'), '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', `${ln},aresample=48000`, '-c:a', 'aac', '-b:a', '320k', '-t', String(film.dur), '-movflags', '+faststart', output]), '封装（复制画面）');
} else if (audio) {
  const p = run('sh', [resolve(ROOT, 'engine/render/mux.sh'), resolve(out, 'native.mp4'), audio, output, String(FPS), '0'], { cwd: ROOT });
  must(p, '封装（engine/render/mux.sh）');
  process.stdout.write(p.stdout);
} else {
  must(run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', resolve(out, 'native.mp4'), '-map', '0:v:0', '-c:v', 'copy', '-movflags', '+faststart', output]), '复制视频轨');
}

// 6. 输出核对
const probe = JSON.parse(must(run(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames:format=duration,size', '-of', 'json', output]), '输出检查').stdout);
const video = probe.streams.find(s => s.codec_type === 'video'), sound = probe.streams.find(s => s.codec_type === 'audio');
const checks = {
  frames: Number(video?.nb_read_frames) === FRAMES,
  size: video?.width === W && video?.height === H,
  fps: video?.r_frame_rate === `${FPS}/1`,
  audio: audio ? sound?.codec_name === 'aac' : true,
  duration: Math.abs(Number(probe.format.duration) - film.dur) <= 0.05,
};
const sha256 = createHash('sha256').update(await readFile(output)).digest('hex');
const report = { film: relative(ROOT, dir).split(sep).join('/'), runtime, backend: env.WGPU_BACKEND || 'runtime default', platform: process.platform, gpuBefore: gpu, renderSeconds, expected: { frames: FRAMES, width: W, height: H, fps: FPS, dur: film.dur, audio: Boolean(audio) }, mux: audio ? mux : 'none', checks, probe, sha256, note: audio ? '技术检查；画面、动作、黑场 / 静帧与响度另行看片。' : '无声：film.json 没有声明 native.audio。技术检查不替代看片。' };
await writeFile(resolve(dirname(output), 'technical.json'), JSON.stringify(report, null, 2) + '\n');
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
if (failed.length) throw new Error(`输出不符合 film.json 的契约：${failed.join('、')}（见 ${rel(resolve(dirname(output), 'technical.json'))}）`);
console.log(`已出片 ${rel(output)}：${W}×${H}，${FPS}fps，${FRAMES} 帧${audio ? '，AAC' : '，无声'}；原生渲染 ${renderSeconds.toFixed(1)} 秒。画面仍需人工看片。`);
