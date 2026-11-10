#!/usr/bin/env node
// 北冥引擎 · 原生渲染入口（北冥原生 · BNE）：任何 route = "b" 的作品目录都用它预检、出草图帧和出片。
//   node engine/render/native.mjs <作品目录> [--check-only | --at 0,36,71 | --frame N] [选项]，--help 看全部选项
//
// 步骤（任一步失败立即停止，按附录 C1 的退出码退出，运行目录里留下 run.json 与日志）
//   1 预检     film.json（v1 / v2）→ 交付档位；RAEA_BIN 解析成绝对路径，版本与可执行文件 sha256 对照 engine/native/runtime.lock.json；
//              FFmpeg / ffprobe（要 libx264、aac、ebur128、colorspace）；film.json 声明的素材与源码里 staticFile / 'media/x' 字面量
//              引用的素材都在 media/，且 sha256 与 prepare 写的 media/prepared.json 一致（素材在 prepare 之后被改过 → exit 4）。
//              --check-only 到此为止，不启动 GPU。
//   2 GPU 守卫 ComfyUI 队列（COMFY_URL）有任务、nvidia-smi 利用率 > 10% → exit 5；查不到队列只记录（--require-idle-check 时也 exit 5）。
//              草图帧（--at / --frame）同样要过这一关；从不终止别人的进程。
//   3 原生渲染 raea render（流式转发日志、超时 exit 124）；日志里出现 ERROR（例如着色器编译失败——运行时此时仍会 exit 0）一律判失败。
//   4 母版     原生视频轨逐位复制 + 混音 PCM 按 BS.1770 实测线性增益编 AAC 48 kHz → master.mp4；
//   5 网页版   由母版编码 H.264 High / yuv420p / BT.709 有限范围（四个色彩标签写全）+ AAC 48 kHz → web.mp4（交付档位见
//              engine/native/delivery.mjs，默认 D07 的 web-1080p24）；两份成片都对最终 AAC 复测响度与真峰值，超了自动减增益重编。
//   6 验收     ffprobe 完整解码核对帧数 / 尺寸 / 帧率 / 时长 / 音轨 / 色彩标签；运行时自带的 raea check（P0 / P1 → exit 4）；
//              framemd5 逐帧哈希；联系表 contact.jpg；player.html。技术检查不替代看片。
// 产物：<作品>/out/<run-id>/{master.mp4, web.mp4, run.json, check.json, render.json, render.log, framemd5.txt, contact.jpg, player.html}
//       run-id = YYYYMMDD-HHMMSS-<短提交>[-dirty]；<作品>/out/latest 是写着最近一次成功 run-id 的指针文件。草图帧在 <run>/stills/f<帧号>.png。
// 环境变量：RAEA_BIN（必需）、FFMPEG、FFPROBE、WGPU_BACKEND（Windows 默认 vulkan）、COMFY_URL、BNE_ALLOW_VERSION、BNE_RENDER_TIMEOUT（秒）。
import { mkdir, readFile, rename, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT, exitWith, getWarnings, isMain, log, onCleanup, offCleanup, runCli, runQuick, sha256File, spawnStream, warn } from '../native/cli.mjs';
import { declaredAssets, hashAsset, readFilmSpec, referencedAssets, sourceFiles } from '../native/film.mjs';
import { resolveRuntime } from '../native/runtime.mjs';
import * as D from '../native/delivery.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FFMPEG = () => process.env.FFMPEG || 'ffmpeg';
const FFPROBE = () => process.env.FFPROBE || 'ffprobe';
const posix = p => p.split(sep).join('/');
const repoRel = p => { const r = relative(ROOT, p); return r.startsWith('..') ? p : posix(r) || '.'; };
const now = () => performance.now() / 1000;
const ANSI = /\u001b\[[0-9;]*m/g;

const USAGE = `node engine/render/native.mjs <作品目录> [选项]
  （无选项）              预检 → GPU 守卫 → 原生渲染 → 母版 master.mp4 + 网页版 web.mp4 → 验收，产物在 <作品>/out/<run-id>/
  --check-only            只预检（运行时版本与哈希、FFmpeg、素材与 prepared.json 哈希），不启动 GPU
  --at 0,36,71            只渲这几帧 PNG（<run>/stills/f<帧号>.png），同样要过 GPU 守卫
  --frame N               只渲一帧 PNG
  --quality master|high|draft   原生编码质量（默认 master；draft 用于快速迭代）
  --profile <档位>         交付档位（默认取 film.json，没有就按尺寸帧率推断）：${Object.keys(D.PROFILES).join(' / ')}
  --no-web                只出母版
  --skip-check            不跑运行时自带的成片检查（run.json 记为 not-run）
  --lint                  渲染前跑 raea scene lint（只记录，不判失败）
  --require-idle-check    查不到 ComfyUI 队列时也拒绝渲染（exit 5）
  --run-id <id> / --run-dir <目录>   指定运行目录（给编排器用）
  --timeout <秒>           原生渲染超时（默认 120 + 2 × 帧数；也可用 BNE_RENDER_TIMEOUT）
  --json                  stdout 只输出一个 JSON 信封；日志在 stderr
退出码：0 成功 · 1 渲染 / 编码失败（含日志里的 ERROR）· 2 用法 · 3 运行时 / 工具 / 素材缺失 · 4 契约或验收不通过
        · 5 共享 GPU 忙 · 124 超时 · 130 / 143 中断（已清理）`;

const SPEC = {
  '--check-only': 'bool', '--at': 'string', '--frame': 'string', '--quality': 'string', '--profile': 'string',
  '--no-web': 'bool', '--skip-check': 'bool', '--lint': 'bool', '--require-idle-check': 'bool',
  '--run-id': 'string', '--run-dir': 'string', '--timeout': 'string', '--mux': 'string', '--out': 'string',
};

// ───────── 预检 ─────────
function ffmpegInfo() {
  const ver = runQuick(FFMPEG(), ['-hide_banner', '-version'], { label: 'FFmpeg', timeoutMs: 15000 });
  if (ver.status !== 0) throw new CliError(EXIT.ENV, 'ffmpeg', `FFmpeg 不能运行：${ver.stderr.trim().slice(0, 200)}`, '装 FFmpeg ≥ 7，或用 FFMPEG 指定完整路径');
  const line = (/ffmpeg version \S+/.exec(ver.stdout) || [ver.stdout.split('\n')[0].trim()])[0];
  const major = Number((/version\s+n?(\d+)/.exec(line) || [])[1]);
  const enc = runQuick(FFMPEG(), ['-hide_banner', '-encoders'], { label: 'FFmpeg', timeoutMs: 15000 }).stdout;
  const fil = runQuick(FFMPEG(), ['-hide_banner', '-filters'], { label: 'FFmpeg', timeoutMs: 15000 }).stdout;
  const missing = [[/\blibx264\b/, enc, 'libx264'], [/\baac\b/, enc, 'aac'], [/\bebur128\b/, fil, 'ebur128'], [/\bcolorspace\b/, fil, 'colorspace']].filter(([re, s]) => !re.test(s)).map(x => x[2]);
  if (missing.length) throw new CliError(EXIT.ENV, 'ffmpeg-build', `这个 FFmpeg 缺 ${missing.join('、')}`, '换一个带 libx264 的完整构建（docs/decisions D09：FFmpeg ≥ 7）');
  if (major && major < 7) warn(`FFmpeg ${major} 低于约定的 7（D09），结果可能与基线不同`);
  const pv = runQuick(FFPROBE(), ['-hide_banner', '-version'], { label: 'ffprobe', timeoutMs: 15000 });
  if (pv.status !== 0) throw new CliError(EXIT.ENV, 'ffprobe', 'ffprobe 不能运行', '与 FFmpeg 同一套安装；或用 FFPROBE 指定完整路径');
  return { ffmpeg: line };
}

async function checkAssets(spec) {
  const media = join(spec.dir, 'media');
  const declared = declaredAssets(spec);
  const referenced = await referencedAssets(spec.dir);
  const names = new Map(declared.map(a => [a.name, a]));
  for (const r of referenced) if (!names.has(r)) names.set(r, { name: r, kind: 'file', from: null, undeclared: true });
  const missing = [];
  for (const a of names.values()) {
    const p = join(media, a.name);
    if (!existsSync(p)) { missing.push(a.name); continue; }
    if (a.kind === 'frames') {
      let sheet;
      try { sheet = JSON.parse(await readFile(`${p}.json`, 'utf8')); } catch { missing.push(`${a.name}.json`); continue; }
      for (let i = 0; i < sheet.frames; i++) if (!existsSync(join(p, `${String(i).padStart(6, '0')}.png`))) { missing.push(`${a.name}/${String(i).padStart(6, '0')}.png`); break; }
    }
  }
  if (missing.length) throw new CliError(EXIT.ENV, 'missing-assets', `media/ 缺少：${missing.slice(0, 8).join('、')}${missing.length > 8 ? ` 等 ${missing.length} 项` : ''}`, `先准备素材：node engine/native/prepare.mjs ${repoRel(spec.dir)}`);
  let prepared = null;
  try { prepared = JSON.parse(await readFile(join(media, 'prepared.json'), 'utf8')); } catch { /* 下面判 */ }
  const hashes = {}, undeclared = [];
  for (const a of names.values()) {
    const h = await hashAsset(join(media, a.name));
    hashes[a.name] = h;
    if (a.undeclared) { undeclared.push(a.name); continue; }
    if (!prepared) throw new CliError(EXIT.CONTRACT, 'no-prepared', 'media/prepared.json 不存在：素材不是由 prepare 生成的，无法核对', `重新准备：node engine/native/prepare.mjs ${repoRel(spec.dir)}`);
    const want = prepared.assets?.[a.name];
    if (want !== h) throw new CliError(EXIT.CONTRACT, 'asset-hash', `media/${a.name} 的 sha256 与 prepared.json 记录不符（${want ? '素材在 prepare 之后被改过或替换' : 'prepared.json 里没有这一项'}）`, `重新准备：node engine/native/prepare.mjs ${repoRel(spec.dir)}`);
  }
  if (undeclared.length) warn(`源码引用了未在 film.json 声明的素材：${undeclared.join('、')}（无法由 prepare 复现；请写进 native.images / models / sequences）`);
  return { hashes, prepared: prepared ? { film: prepared.film, tools: prepared.tools ?? null } : null, undeclared };
}

// ───────── GPU 守卫 ─────────
async function gpuGuard(a) {
  const base = process.env.COMFY_URL || 'http://127.0.0.1:8188';
  const comfy = { url: base, checked: false };
  try {
    const url = new URL('queue', base.endsWith('/') ? base : `${base}/`);
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    comfy.status = r.status;
    if (!r.ok) comfy.reason = `HTTP ${r.status}`;
    else {
      const q = await r.json();
      comfy.checked = true;
      comfy.running = q.queue_running?.length ?? 0;
      comfy.pending = q.queue_pending?.length ?? 0;
    }
  } catch (e) { comfy.reason = e.name === 'TimeoutError' ? '超时' : e.cause?.code || e.message; }
  if (comfy.checked && (comfy.running || comfy.pending)) throw new CliError(EXIT.BUSY, 'comfy-busy', `ComfyUI 队列有任务（运行 ${comfy.running}、排队 ${comfy.pending}）`, '等它跑完再渲；从不终止别人的任务');
  if (!comfy.checked) {
    if (a['require-idle-check']) throw new CliError(EXIT.BUSY, 'idle-unknown', `查不到 ComfyUI 队列（${comfy.reason}），无法确认共享 GPU 空闲`, '确认工作站空闲后去掉 --require-idle-check，或修好 COMFY_URL');
    if (process.env.COMFY_URL) warn(`COMFY_URL 查询失败（${comfy.reason}），按「未检查」记录`);
  }
  const nvidia = { available: false, busy: false };
  try {
    const p = runQuick('nvidia-smi', ['--query-gpu=name,utilization.gpu', '--format=csv,noheader,nounits'], { timeoutMs: 5000, label: 'nvidia-smi' });
    if (p.status === 0) {
      nvidia.available = true;
      nvidia.samples = p.stdout.trim().split(/\r?\n/).filter(Boolean);
      nvidia.busy = nvidia.samples.some(l => Number(l.split(',').at(-1).trim()) > 10);
    }
  } catch (e) { if (e.exitCode !== EXIT.ENV) throw e; }
  if (nvidia.busy) throw new CliError(EXIT.BUSY, 'gpu-busy', `GPU 利用率超过 10%：${nvidia.samples.join('；')}`, '共享工作站空闲后再渲');
  return { comfy, nvidia };
}

function gpuNames() {
  try {
    if (process.platform === 'darwin') {
      const p = runQuick('system_profiler', ['SPDisplaysDataType', '-json'], { timeoutMs: 10000, label: 'system_profiler' });
      return (JSON.parse(p.stdout).SPDisplaysDataType || []).map(g => g.sppci_model || g._name).filter(Boolean);
    }
    const n = runQuick('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], { timeoutMs: 5000 });
    if (n.status === 0) return n.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (process.platform === 'win32') {
      const w = runQuick('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }'], { timeoutMs: 10000 });
      return w.stdout.trim().split(/\r?\n/).filter(Boolean);
    }
    const l = runQuick('lspci', [], { timeoutMs: 5000 });
    return l.stdout.split('\n').filter(x => /VGA|3D controller/.test(x)).map(x => x.split(': ').slice(1).join(': '));
  } catch { return []; }
}

// ───────── 运行目录 ─────────
function gitInfo() {
  try {
    const c = runQuick('git', ['-C', ROOT, 'rev-parse', '--short=7', 'HEAD'], { timeoutMs: 5000 });
    const full = runQuick('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { timeoutMs: 5000 });
    const s = runQuick('git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no'], { timeoutMs: 10000 });
    if (c.status !== 0) return { short: 'nogit', commit: null, dirty: null };
    return { short: c.stdout.trim(), commit: full.stdout.trim(), dirty: s.stdout.trim().length > 0 };
  } catch { return { short: 'nogit', commit: null, dirty: null }; }
}
const stamp = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

async function makeRunDir(spec, a, git) {
  if (a['run-dir']) { const d = resolve(a['run-dir']); await mkdir(d, { recursive: true }); return { runDir: d, runId: d.split(/[\\/]/).pop() }; }
  const base = a['run-id'] || `${stamp(new Date())}-${git.short}${git.dirty ? '-dirty' : ''}`;
  if (!/^[\w.-]+$/.test(base)) throw new CliError(EXIT.USAGE, 'run-id', `--run-id 只能含字母、数字、. _ -：${base}`);
  await mkdir(join(spec.dir, 'out'), { recursive: true });
  for (let i = 1; i < 100; i++) {
    const runId = i === 1 ? base : `${base}-${i}`, runDir = join(spec.dir, 'out', runId);
    try { await mkdir(runDir); return { runDir, runId }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new CliError(EXIT.BUSY, 'run-dir', '同一秒内的运行目录已用完', '稍后重试');
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.part`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, file);
}

// ───────── 原生运行时调用 ─────────
async function raeaRender(rt, spec, args, { label, logFile, timeoutMs, env }) {
  const errors = [];
  let errorTail = 0, stats = null, applied = null, sysinfo = null;
  const r = await spawnStream(rt.exe, args, {
    cwd: spec.dir, env, timeoutMs, logFile, quiet: true, label,
    onLine: raw => {
      const l = raw.replace(ANSI, '');
      if (/\bERROR\b/.test(l)) { errors.push(l.trim()); errorTail = 8; log(`  │ ${l}`); return; }
      if (errorTail > 0 && l.trim()) { errors[errors.length - 1] += `\n${l.trim()}`; errorTail--; return; }
      if (/^APPLIED\b/.test(l)) { applied = l.trim(); log(`  │ ${l.trim()}`); }
      if (/SystemInfo/.test(l) && !sysinfo) sysinfo = l.trim();
      if (l.startsWith('{') && l.includes('"frames"')) { try { stats = JSON.parse(l); } catch { /* 不是统计行 */ } }
    },
  });
  if (r.code !== 0) throw new CliError(EXIT.FAIL, 'native-render', `${label}失败（运行时退出码 ${r.code ?? r.signal}）${errors[0] ? `：${errors[0].split('\n').slice(0, 4).join(' ')}` : ''}`, `完整日志：${repoRel(logFile)}`);
  if (errors.length) throw new CliError(EXIT.FAIL, 'native-error', `${label}日志里有 ERROR（运行时仍返回 0，画面可能缺了一层）：${errors[0].split('\n').slice(0, 6).join(' ⏎ ')}`, `完整日志：${repoRel(logFile)}；着色器报错先修对应的 WESL`);
  return { stats, applied, sysinfo };
}

async function ffmpegRun(args, label, timeoutMs) {
  const r = await spawnStream(FFMPEG(), args, { timeoutMs, quiet: true, label });
  if (r.code !== 0) throw new CliError(EXIT.FAIL, 'ffmpeg', `${label}失败：${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  return r;
}
async function measure(file, timeoutMs) {
  const r = await spawnStream(FFMPEG(), D.loudnessArgs(file), { timeoutMs, quiet: true, label: '响度测量' });
  if (r.code !== 0) throw new CliError(EXIT.FAIL, 'loudness', `响度测量失败：${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
  return D.parseEbur128(r.stderr);
}
function probe(file) {
  const p = runQuick(FFPROBE(), D.probeArgs(file), { timeoutMs: 600000, label: 'ffprobe' });
  if (p.status !== 0) throw new CliError(EXIT.FAIL, 'probe', `ffprobe 读不了 ${repoRel(file)}：${p.stderr.trim().slice(0, 200)}`);
  return JSON.parse(p.stdout);
}

// 编码 + 复测响度；真峰值超了就减增益重编（最多 3 次）
async function encodeWithLoudness({ label, build, out, pcm, audio, gainDb, timeoutMs }) {
  let g = gainDb, last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const part = `${out}.part`;
    await ffmpegRun(build(g, part), label, timeoutMs);
    if (!pcm) { await rename(part, out); return { gainDb: g, loudness: null }; }
    last = await measure(part, timeoutMs);
    if (last.TP <= audio.tpMax || attempt === 3) { await rename(part, out); break; }
    const cut = last.TP - audio.tpMax + 0.2;
    warn(`${label}编码后真峰值 ${last.TP} dBTP 高于 ${audio.tpMax}，增益再减 ${cut.toFixed(1)} dB 重编`);
    g -= cut;
  }
  return { gainDb: g, loudness: last };
}

// ───────── 主流程 ─────────
export async function main(argv = process.argv.slice(2)) {
  return runCli({ command: 'native', usage: USAGE, spec: SPEC, argv, main: run });
}

async function run(a) {
  const T0 = now(), timing = {};
  if (a._.length !== 1) throw new CliError(EXIT.USAGE, 'usage', a._.length ? `只能给一个作品目录，收到 ${a._.length} 个` : '缺少作品目录', '用法：node engine/render/native.mjs films/<名字>（--help 看选项）');
  if (a.out) throw new CliError(EXIT.USAGE, 'deprecated', '--out 已停用：产物统一写进 <作品>/out/<run-id>/', '用 --run-dir <目录> 指定运行目录');
  if (a.mux) warn(`--mux 已停用（${a.mux}）：母版总是逐位复制原生视频轨，网页版由母版重新编码`);
  const quality = a.quality || 'master';
  if (!['master', 'high', 'draft'].includes(quality)) throw new CliError(EXIT.USAGE, 'quality', `--quality 只能是 master / high / draft：${quality}`);
  const stillFrames = a.at !== undefined ? parseFrames(a.at) : a.frame !== undefined ? parseFrames(a.frame) : null;
  if (a.at !== undefined && a.frame !== undefined) throw new CliError(EXIT.USAGE, 'usage', '--at 与 --frame 只能用一个');
  const timeoutS = Number(a.timeout ?? process.env.BNE_RENDER_TIMEOUT ?? 0);
  if (a.timeout !== undefined && !(timeoutS > 0)) throw new CliError(EXIT.USAGE, 'timeout', `--timeout 要写正数秒：${a.timeout}`);

  const spec = await readFilmSpec(a._[0]);
  if (stillFrames) for (const f of stillFrames) if (f >= spec.frames) throw new CliError(EXIT.USAGE, 'frame-range', `帧号 ${f} 超出范围（共 ${spec.frames} 帧，最后一帧是 ${spec.frames - 1}）`);
  const p = D.resolveProfile(spec, a.profile);
  if (p.error) throw new CliError(a.profile ? EXIT.USAGE : EXIT.CONTRACT, 'profile', p.error, p.hint);
  if (p.note) warn(p.note);
  const fit = p.name.startsWith('custom-') ? [] : D.checkProfileFit(spec, p);
  if (fit.length) throw new CliError(EXIT.CONTRACT, 'profile-fit', fit.join('；'), '改 film.json 的 size / fps，或换一个匹配的交付档位（--profile）');
  const audioTarget = D.audioTarget(p, spec.audio);

  // 1 预检
  let t = now();
  const rt = await resolveRuntime();
  const tools = { node: process.version, ...ffmpegInfo() };
  const assets = await checkAssets(spec);
  timing.preflight = now() - t;
  const rtInfo = { version: rt.version, platform: rt.platform, binarySha256: rt.binarySha256, verified: rt.verified };
  log(`预检通过：运行时 ${rt.version}（${rt.platform}，${rt.verified === true ? '哈希与锁一致' : rt.verified === 'unlocked' ? '该平台未锁定' : '未验证版本'}），${Object.keys(assets.hashes).length} 个素材与 prepared.json 一致，交付档位 ${p.name}（${p.source}）`);
  if (a['check-only']) {
    let help = null;
    try { help = runQuick(rt.exe, ['--help'], { timeoutMs: 30000, label: '原生运行时' }); } catch (e) { if (e.exitCode === EXIT.TIMEOUT) throw e; throw new CliError(EXIT.ENV, 'runtime-exec', `原生运行时无法启动：${e.message}`, '检查执行权限；macOS 被隔离的下载包先 xattr -dr com.apple.quarantine <安装目录>；Windows 缺 DLL 时重装发行包'); }
    if (help.status !== 0 && !/usage/i.test(help.stdout + help.stderr)) throw new CliError(EXIT.ENV, 'runtime-exec', `原生运行时无法启动（退出码 ${help.status}）：${(help.stderr || help.stdout).trim().slice(0, 200)}`);
    log('只做了预检，没有启动 GPU 渲染。');
    return { outputs: [], runJson: null, info: { runtime: rtInfo, profile: p.name, assets: assets.hashes } };
  }

  // 2 GPU 守卫
  const guard = await gpuGuard(a);
  const git = gitInfo();
  const { runDir, runId } = await makeRunDir(spec, a, git);
  const rel = f => posix(relative(spec.dir, join(runDir, f)));
  const env = { ...process.env };
  if (process.platform === 'win32' && !env.WGPU_BACKEND) env.WGPU_BACKEND = 'vulkan';
  const record = {
    schemaVersion: 1, kind: 'render-result', status: 'running', projectId: spec.id, shotId: 'film', route: 'b', backend: 'native',
    runId, runDir: repoRel(runDir), startedAt: new Date().toISOString(),
    sourceCommit: git.commit, dirty: git.dirty, argv: process.argv.slice(1).map(x => (x.startsWith(ROOT) ? repoRel(x) : x)),
    tools: { ...tools, raea: rtInfo },
    actualDevice: { gpu: gpuNames(), host: null }, actualGraphicsBackend: { requested: env.WGPU_BACKEND || '运行时默认', reported: null }, softwareFallback: null,
    encoder: null, profile: { name: p.name, source: p.source, width: p.width, height: p.height, fps: p.fps, color: p.color, audio: audioTarget },
    expected: { width: spec.width, height: spec.height, fps: spec.fps, frames: spec.frames, dur: spec.dur },
    inputs: { film: repoRel(spec.dir), entry: spec.native.entry, sources: {}, assets: assets.hashes, prepared: assets.prepared },
    gpuGuard: guard, outputs: {}, output: null, frameHashes: null, audio: null, checks: {}, timing,
    technicalAcceptance: { status: 'not-run', evidence: [] }, creativeAcceptance: { status: 'not-run', reviews: [] }, warnings: [],
  };
  for (const f of await sourceFiles(spec.dir)) record.inputs.sources[f] = await sha256File(join(spec.dir, f));
  const runJsonPath = join(runDir, 'run.json');
  const save = async () => { record.timing.total = now() - T0; record.warnings = getWarnings(); await writeJsonAtomic(runJsonPath, record); };
  await save();
  const parts = [];
  const cleanup = onCleanup(async () => {
    for (const f of parts) await rm(f, { force: true });
    record.status = 'failed'; record.error = { code: 'interrupted', message: '运行被中断' }; record.finishedAt = new Date().toISOString();
    try { await save(); } catch { /* 尽力 */ }
  });

  try {
    if (a.lint) {
      const l = runQuick(rt.exe, ['scene', 'lint', spec.native.entry, '--json'], { cwd: spec.dir, env, timeoutMs: 120000, label: 'raea scene lint' });
      try { record.checks.sceneLint = JSON.parse(l.stdout); } catch { record.checks.sceneLint = { raw: (l.stdout || l.stderr).slice(0, 4000) }; }
      log('scene lint 结果已记入 run.json（只记录，不判失败）');
    }
    const timeoutMs = 1000 * (timeoutS > 0 ? timeoutS : 120 + 2 * spec.frames);

    // 3a 草图帧
    if (stillFrames) {
      t = now();
      const dir = join(runDir, 'stills');
      await mkdir(dir, { recursive: true });
      const args = stillFrames.length === 1
        ? ['render', spec.native.entry, '--frame', String(stillFrames[0]), '-o', rel(`stills/f${pad(stillFrames[0])}.png`)]
        : ['render', spec.native.entry, '--at', stillFrames.join(','), '-o', `${rel('stills')}/`];
      log(`原生草图帧：${stillFrames.join(', ')}（${spec.width}×${spec.height}）`);
      const r = await raeaRender(rt, spec, args, { label: '原生草图帧', logFile: join(runDir, 'render.log'), timeoutMs, env });
      if (stillFrames.length > 1) {
        const got = (await readdir(dir)).filter(f => /^frame-\d+\.png$/.test(f)).sort();
        if (got.length !== stillFrames.length) throw new CliError(EXIT.CONTRACT, 'stills', `要 ${stillFrames.length} 帧，运行时只写出 ${got.length} 帧`);
        for (let i = 0; i < got.length; i++) await rename(join(dir, got[i]), join(dir, `f${pad(stillFrames[i])}.png`));
      }
      record.actualDevice.host = parseSysinfo(r.sysinfo);
      timing.render = now() - t;
      const outputs = [];
      for (const f of stillFrames) { const file = join(dir, `f${pad(f)}.png`); outputs.push({ path: repoRel(file), sha256: await sha256File(file), kind: 'still' }); }
      record.status = 'passed'; record.kind = 'stills'; record.outputs = { stills: outputs }; record.finishedAt = new Date().toISOString();
      await save();
      log(`草图帧已写到 ${repoRel(dir)}/（文件名是帧号）。草图帧不是成片，不做交付检查。`);
      return { outputs: [...outputs, { path: repoRel(runJsonPath), sha256: await sha256File(runJsonPath), kind: 'run-json' }], runJson: repoRel(runJsonPath) };
    }

    // 3b 原生渲染
    t = now();
    const native = join(runDir, 'native.mp4');
    parts.push(native);
    log(`原生渲染：${spec.width}×${spec.height} ${spec.fps}fps ${spec.frames} 帧，质量 ${quality}，后端 ${env.WGPU_BACKEND || '运行时默认'}`);
    const r = await raeaRender(rt, spec, ['render', spec.native.entry, '-o', rel('native.mp4'), '--quality', quality, '--manifest', rel('render.json')],
      { label: '原生渲染', logFile: join(runDir, 'render.log'), timeoutMs, env });
    timing.render = now() - t;
    record.encoder = r.stats?.video ?? null;
    record.actualDevice.host = parseSysinfo(r.sysinfo);
    record.nativeStats = r.stats ? { frames: r.stats.frames, fpsInclEncode: r.stats.fps_incl_encode, bytes: r.stats.bytes, video: r.stats.video } : null;
    if (!existsSync(native)) throw new CliError(EXIT.FAIL, 'native-output', '运行时没有写出 native.mp4', `看 ${repoRel(join(runDir, 'render.log'))}`);
    const nd = D.describeVideo(probe(native));
    const nativeProblems = D.judgeVideo(nd, spec, { audio: false });
    if (nativeProblems.length) throw new CliError(EXIT.CONTRACT, 'native-contract', `原生输出不符合 film.json：${nativeProblems.join('；')}`, '核对 film.tsx 的 Composition 与 film.json 的尺寸 / 帧率 / 时长是否一致');

    // 声音：实测混音 → 线性增益
    const pcm = spec.native.audio ? join(spec.dir, 'media', spec.native.audio.out || 'mix.wav') : null;
    let plan = { gainDb: 0 }, pcmLoud = null;
    if (pcm) {
      pcmLoud = await measure(pcm, 600000);
      plan = D.planGain(pcmLoud, audioTarget);
      if (!plan.ok) throw new CliError(EXIT.CONTRACT, 'loudness-plan', plan.reason, '在声音脚本里用 engine.audio.mixing.loudness_to 把真峰值限在 −1.5 dBTP 左右再导出');
      if (plan.limitedByPeak) warn(`为守住真峰值，增益按峰值限定为 ${plan.gainDb} dB（预计 ${plan.expectedI.toFixed(1)} LUFS）`);
    } else warn('film.json 没有 native.audio：母版无声，网页版写入静音立体声轨');
    record.audio = pcm ? { source: repoRel(pcm), sha256: assets.hashes[spec.native.audio.out || 'mix.wav'], measured: pcmLoud, plan: { gainDb: plan.gainDb, limitedByPeak: plan.limitedByPeak }, target: audioTarget } : { source: null };

    // 4 母版
    t = now();
    const master = join(runDir, 'master.mp4');
    parts.push(`${master}.part`);
    const m = await encodeWithLoudness({
      label: '母版封装', out: master, pcm, audio: audioTarget, gainDb: plan.gainDb, timeoutMs,
      build: (g, part) => D.masterArgs({ video: native, pcm, gainDb: g, out: part, audio: audioTarget, durSeconds: spec.dur }),
    });
    const md = D.describeVideo(probe(master));
    const masterProblems = D.judgeVideo(md, spec, { audio: Boolean(pcm) });
    if (pcm) { const j = D.judgeLoudness(m.loudness, audioTarget); masterProblems.push(...j.problems.map(x => `母版${x}`)); record.audio.master = { ...m.loudness, gainDb: m.gainDb }; }
    record.outputs.master = { path: repoRel(master), sha256: await sha256File(master), ...md };
    timing.master = now() - t;
    if (masterProblems.length) throw new CliError(EXIT.CONTRACT, 'master-contract', `母版不合格：${masterProblems.join('；')}`);
    await rm(native, { force: true });

    // 5 网页版
    let deliver = master, deliverDesc = md;
    if (p.web && !a['no-web']) {
      t = now();
      const web = join(runDir, 'web.mp4');
      parts.push(`${web}.part`);
      let colorNote = '';
      const w = await encodeWithLoudness({
        label: '网页版编码', out: web, pcm, audio: audioTarget, gainDb: m.gainDb, timeoutMs: 1000 * (300 + 2 * spec.frames),
        build: (g, part) => { const b = D.webArgs({ master, pcm, gainDb: g, out: part, p, audio: audioTarget, sourceColor: { color_space: md.color.matrix, color_range: md.color.range, color_primaries: md.color.primaries }, durSeconds: spec.dur }); colorNote = b.colorNote; return b.args; },
      });
      const wd = D.describeVideo(probe(web));
      const webProblems = D.judgeVideo(wd, spec, { web: true, audio: true, p });
      if (pcm) { const j = D.judgeLoudness(w.loudness, audioTarget); webProblems.push(...j.problems.map(x => `网页版${x}`)); record.audio.web = { ...w.loudness, gainDb: w.gainDb }; }
      record.outputs.web = { path: repoRel(web), sha256: await sha256File(web), colorNote, ...wd };
      timing.web = now() - t;
      if (webProblems.length) throw new CliError(EXIT.CONTRACT, 'web-contract', `网页版不合格：${webProblems.join('；')}`);
      deliver = web; deliverDesc = wd;
    }
    record.output = { path: repoRel(deliver), sha256: (record.outputs.web || record.outputs.master).sha256, width: deliverDesc.width, height: deliverDesc.height, fps: deliverDesc.fps, frames: deliverDesc.frames, pixFmt: deliverDesc.pixFmt, color: deliverDesc.color };

    // 6 验收证据：先出逐帧哈希、联系表、播放页（检查不过时也留着它们定位问题），再跑运行时自带的成片检查
    t = now();
    const md5 = join(runDir, 'framemd5.txt');
    await ffmpegRun(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', master, '-map', '0:v:0', '-f', 'framemd5', md5], '逐帧哈希', 600000);
    const md5Count = (await readFile(md5, 'utf8')).split('\n').filter(l => l && !l.startsWith('#')).length;
    record.frameHashes = { kind: 'ffmpeg-framemd5（母版解码后）', path: repoRel(md5), sha256: await sha256File(md5), frames: md5Count };
    const cols = 5, every = Math.max(1, Math.ceil(spec.frames / 40));
    await ffmpegRun(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', deliver, '-vf', `select='not(mod(n\\,${every}))',scale=384:-2,tile=${cols}x${Math.ceil(Math.ceil(spec.frames / every) / cols)}:padding=4:color=white`, '-frames:v', '1', '-q:v', '3', join(runDir, 'contact.jpg')], '联系表', 300000);
    await writeFile(join(runDir, 'player.html'), playerHtml(spec, runId, deliver.endsWith('web.mp4') ? 'web.mp4' : 'master.mp4'));
    if (!a['skip-check']) {
      const out = join(runDir, 'check.json');
      const c = await spawnStream(rt.exe, ['check', rel(deliver.endsWith('web.mp4') ? 'web.mp4' : 'master.mp4'), '--manifest', rel('render.json'), '-o', rel('check.json')],
        { cwd: spec.dir, env, timeoutMs: 1000 * (120 + spec.frames), quiet: true, label: 'raea check' });
      let check = null;
      try { check = JSON.parse(await readFile(out, 'utf8')); } catch { /* 下面判 */ }
      if (!check) throw new CliError(EXIT.FAIL, 'raea-check', `raea check 没有写出结果（退出码 ${c.code}）：${c.stderr.replace(ANSI, '').trim().split('\n').slice(-2).join(' ')}`);
      const issues = check.issues || [];
      const rank = i => String(i?.p ?? i?.severity ?? i?.rank ?? (JSON.stringify(i).match(/\bP[0-3]\b/) || [''])[0]);
      const severe = issues.filter(i => /^P[01]$/.test(rank(i)));
      record.checks.raeaCheck = { ran: true, exitCode: c.code, ok: c.code === 0 && severe.length === 0, file: repoRel(out), passed: check.passed || [], issues };
      for (const l of (check.passed || [])) log(`  ✓ ${l}`);
      for (const i of issues) log(`  ✗ [${rank(i) || '?'}] ${i?.says ?? JSON.stringify(i)}${i?.at !== undefined ? `（${Number(i.at).toFixed(2)} 秒）` : ''}`);
      if (c.code !== 0 || severe.length) throw new CliError(EXIT.CONTRACT, 'raea-check', `运行时自带的成片检查发现 P0 / P1 问题 ${severe.length || '（退出码 1）'} 项`, `看 ${repoRel(out)} 与 ${repoRel(join(runDir, 'contact.jpg'))}，修好后重渲`);
    } else record.checks.raeaCheck = { ran: false, status: 'not-run' };
    timing.evidence = now() - t;

    record.status = 'passed';
    record.technicalAcceptance = { status: 'not-run', evidence: ['run.json', 'check.json', 'framemd5.txt', 'contact.jpg'].filter(f => existsSync(join(runDir, f))) };
    record.finishedAt = new Date().toISOString();
    await save();
    await writeFile(join(spec.dir, 'out', 'latest'), `${runId}\n`);
    offCleanup(cleanup);
    const outputs = [];
    for (const [kind, f] of [['master', 'master.mp4'], ['web', 'web.mp4'], ['run-json', 'run.json'], ['raea-check', 'check.json'], ['contact-sheet', 'contact.jpg']]) {
      const file = join(runDir, f);
      if (existsSync(file)) outputs.push({ path: repoRel(file), sha256: kind === 'master' ? record.outputs.master.sha256 : kind === 'web' ? record.outputs.web.sha256 : await sha256File(file), kind });
    }
    log(`已出片 ${repoRel(runDir)}/：母版 ${(statSync(master).size / 1e6).toFixed(1)} MB（原生编码器 ${record.encoder || '未知'}）${record.outputs.web ? `、网页版 ${(statSync(join(runDir, 'web.mp4')).size / 1e6).toFixed(1)} MB` : ''}；`
      + `${spec.width}×${spec.height} ${spec.fps}fps ${spec.frames} 帧${record.audio?.web ? `，${record.audio.web.I} LUFS / ${record.audio.web.TP} dBTP` : ''}；原生渲染 ${timing.render.toFixed(1)} 秒。技术检查通过 ≠ 画面通过：看 contact.jpg 与整片。`);
    return { outputs, runJson: repoRel(runJsonPath) };
  } catch (e) {
    offCleanup(cleanup);
    for (const f of parts) if (f.endsWith('.part')) await rm(f, { force: true });
    record.status = 'failed';
    record.error = e instanceof CliError ? { code: e.code, exitCode: e.exitCode, message: e.message, hint: e.hint } : { code: 'internal', message: String(e?.message || e) };
    record.finishedAt = new Date().toISOString();
    try { await save(); } catch { /* 运行目录可能不可写 */ }
    if (e instanceof CliError && !e.hint.includes('run.json')) e.hint = `${e.hint ? `${e.hint}；` : ''}运行记录：${repoRel(runJsonPath)}`;
    if (e && typeof e === 'object') e.runJson = repoRel(runJsonPath);
    throw e;
  }
}

const pad = n => String(n).padStart(6, '0');
// bevy 的 SystemInfo 日志行 → { os, cpu, cores, memory }
function parseSysinfo(line) {
  if (!line) return null;
  const get = k => (new RegExp(`${k}: "([^"]*)"`).exec(line) || [])[1] ?? null;
  return { os: get('os'), cpu: get('cpu'), cores: Number(get('core_count')) || null, memory: get('memory') };
}
function parseFrames(s) {
  const list = String(s).split(',').map(x => x.trim()).filter(Boolean).map(Number);
  if (!list.length || list.some(n => !Number.isInteger(n) || n < 0)) throw new CliError(EXIT.USAGE, 'frames', `帧号要写成非负整数，逗号分隔：${s}`);
  return list;
}

function playerHtml(spec, runId, file) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(spec.title)} · ${esc(runId)}</title>
<style>:root{color-scheme:dark}body{margin:0;background:#111;color:#ddd;font:14px/1.5 system-ui,sans-serif}main{max-width:min(100vw,${spec.width}px);margin:0 auto;padding:16px}video{width:100%;height:auto;background:#000}p{margin:.5em 0;color:#999}</style>
<main><video src="${esc(file)}" controls preload="metadata"></video><p>${esc(spec.title)} · ${spec.width}×${spec.height} · ${spec.fps} fps · ${spec.frames} 帧 · 运行 ${esc(runId)}（本地看片用；记录见 run.json）</p></main>\n`;
}

if (isMain(import.meta.url)) await exitWith(main());
