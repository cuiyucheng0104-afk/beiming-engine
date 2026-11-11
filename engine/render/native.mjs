#!/usr/bin/env node
// 北冥引擎 · 原生渲染入口（北冥原生 · BNE，基于上游 RAEA 原生运行时；许可边界见 docs/rights/fsl-boundary.md）：任何 route = "b" 的作品目录都用它
// 预检、出草图帧和出片。命令约定（参数、--help、--json 信封、退出码）用 tools/lib/cli.mjs，见 docs/CLI.md。
//   node engine/render/native.mjs <作品目录> [--check-only | --at 0,36,71 | --frame N] [选项]，--help 看全部选项
//
// 步骤（任一步失败立即停止，按附录 C1 的退出码退出，运行目录里留下 run.json 与日志）
//   1 预检     film.json（v1 / v2）→ 交付档位；RAEA_BIN 解析成绝对路径，版本与可执行文件 sha256 对照 engine/native/runtime.lock.json；
//              作品要在 git 工作树里（运行时按工作树认「项目目录」，git archive 导出的目录会被拒绝）；
//              FFmpeg / ffprobe（要 libx264、aac、ebur128、colorspace）；film.json 声明的素材与源码里 staticFile / 'media/x' 字面量
//              引用的素材都在 media/，且 sha256 与 prepare 写的 media/prepared.json 一致（素材在 prepare 之后被改过 → exit 4）。
//              --check-only 到此为止，不启动 GPU（只跑一次运行时的 --help，确认它能启动）。
//   2 GPU 守卫 ComfyUI 队列（COMFY_URL）有任务、nvidia-smi 利用率 > 10% → exit 5；查不到队列只记录（--require-idle-check 时也 exit 5）。
//              草图帧（--at / --frame）同样要过这一关；从不终止别人的进程。
//   3 原生渲染 raea render（流式转发日志、超时 exit 124）；日志里出现 ERROR（例如着色器编译失败——运行时此时仍会 exit 0）一律判失败。
//   4 母版     原生视频轨逐位复制 + 混音 PCM 按 BS.1770 实测线性增益编 AAC 48 kHz → master.mp4（母版不二次有损）；
//   5 网页版   由母版编码 H.264 High / yuv420p / BT.709 有限范围（四个色彩标签写全）+ AAC 48 kHz → web.mp4（交付档位见
//              engine/native/delivery.mjs，默认 D07 的 web-1080p24）；两份成片都对最终 AAC 复测响度与真峰值，超了自动减增益重编。
//              含 AI 生成画面时 mp4 写隐式标识（tools/compliance/lib/aigc.mjs 的 ffmpegMetadataArgs，GB 45438 文件元数据写法）。
//   6 证据     ffprobe 完整解码核对帧数 / 尺寸 / 帧率 / 时长 / 音轨 / 色彩标签；framemd5 逐帧哈希；联系表 contact.jpg；player.html；
//              运行时自带的 raea check（字幕裁切、安全区、对比度、冻帧、响度；P0 / P1 → exit 4）。
//   7 QA 门    仓库的机器 QA（node tools/qa/cli.mjs report，规格 / 色彩 / 响度 / 画面 / 声画 / 底板）→ <运行目录>/qa/report.json；
//              通过才把 run.json 的 status 与 technicalAcceptance 记为 passed，硬门不通过 exit 4。--skip-qa 时 status 记 rendered
//              （渲染器只记实测事实），由编排器或 npm run qa 判定。技术检查通过 ≠ 画面通过：仍要看片。
// 产物：<作品>/out/<run-id>/{master.mp4, web.mp4, run.json, check.json, qa/, render.json, render.log, framemd5.txt, contact.jpg, player.html}
//       run-id = YYYYMMDD-HHMMSS-<短提交>[-dirty]；<作品>/out/latest 是写着最近一次成功 run-id 的指针文件。草图帧在 <run>/stills/f<帧号>.png。
//       编排器（npm run film）用 --run-dir <目录> 指定运行目录、--json 读信封里的 outputs 与 runJson。
// 环境变量：RAEA_BIN（必需）、FFMPEG、FFPROBE、WGPU_BACKEND（Windows 默认 vulkan）、COMFY_URL、BNE_ALLOW_VERSION。超时用 --timeout（秒）。
import { mkdir, readFile, rename, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT, bind, exitWith, fail, getWarnings, log, onCleanup, offCleanup, runQuick, sha256File, spawnStream, warn } from '../native/cli.mjs';
import { defineCommand, isMain, runCli } from '../../tools/lib/cli.mjs';
import { ffmpegBins } from '../../tools/env/lib/ffmpeg.mjs';
import { preflight } from '../../tools/env/preflight.mjs';
import { declaredAssets, hashAsset, readFilmSpec, referencedAssets, sourceFiles } from '../native/film.mjs';
import { resolveRuntime } from '../native/runtime.mjs';
import { SPEC_KINDS, specHash } from '../native/prepare.mjs';
import * as D from '../native/delivery.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// 已验证的原生运行时版本：与 engine/native/runtime.lock.json 的 version 相同（tests/native 核对两处一致）；
// tools/env/spec.json 的 raea.versionSource 按正则读这一行（env:doctor、env:preflight 用）。
export const VALIDATED = '0.1.0-canary.2';
const BIN = () => ffmpegBins(process.env);
const posix = p => p.split(sep).join('/');
const repoRel = p => { const r = relative(ROOT, p); return r.startsWith('..') ? p : posix(r) || '.'; };
const now = () => performance.now() / 1000;
const ANSI = /\u001b\[[0-9;]*m/g;

// ───────── 预检 ─────────
// FFmpeg 先过环境包的快速预检（与 npm run env:doctor 同一套判据：版本 ≥ 7、带 libx264、ffprobe 可用，修复命令也一样），
// 再查这条出片链要的组件（aac、ebur128、colorspace）。原生运行时的版本与哈希按 engine/native/runtime.lock.json 核对（更严：哈希不符即 exit 3）。
async function ffmpegInfo() {
  const pf = await preflight(['ffmpeg']);
  if (!pf.ok) throw fail(EXIT.ENV, 'ffmpeg', `FFmpeg 不合格：${pf.failed.map(c => c.found).join('；')}`, pf.failed[0].fix || '装 FFmpeg ≥ 7（决定 D09），或用 FFMPEG / FFPROBE 指定完整路径；npm run env:doctor 会列出修法');
  const { ffmpeg, ffprobe } = BIN();
  const ver = runQuick(ffmpeg, ['-hide_banner', '-version'], { label: 'FFmpeg', timeoutMs: 15000 });
  if (ver.status !== 0) throw fail(EXIT.ENV, 'ffmpeg', `FFmpeg 不能运行：${ver.stderr.trim().slice(0, 200)}`, '装 FFmpeg ≥ 7，或用 FFMPEG 指定完整路径（npm run env:doctor 会列出修法）');
  const line = (/ffmpeg version \S+/.exec(ver.stdout) || [ver.stdout.split('\n')[0].trim()])[0];
  const enc = runQuick(ffmpeg, ['-hide_banner', '-encoders'], { label: 'FFmpeg', timeoutMs: 15000 }).stdout;
  const fil = runQuick(ffmpeg, ['-hide_banner', '-filters'], { label: 'FFmpeg', timeoutMs: 15000 }).stdout;
  const missing = [[/\blibx264\b/, enc, 'libx264'], [/\baac\b/, enc, 'aac'], [/\bebur128\b/, fil, 'ebur128'], [/\bcolorspace\b/, fil, 'colorspace']].filter(([re, s]) => !re.test(s)).map(x => x[2]);
  if (missing.length) throw fail(EXIT.ENV, 'ffmpeg-build', `这个 FFmpeg 缺 ${missing.join('、')}`, '换一个带 libx264 的完整构建（决定 D09：FFmpeg ≥ 7）；npm run env:doctor 会列出修法');
  const pv = runQuick(ffprobe, ['-hide_banner', '-version'], { label: 'ffprobe', timeoutMs: 15000 });
  if (pv.status !== 0) throw fail(EXIT.ENV, 'ffprobe', 'ffprobe 不能运行', '与 FFmpeg 同一套安装；或用 FFPROBE 指定完整路径');
  return { ffmpeg: line };
}

// 原生运行时按 git 工作树认「项目目录」：作品不在工作树里（例如 git archive 导出的目录）时运行时会 REFUSED，提前说清楚
function checkWorktree(dir) {
  let r;
  try { r = runQuick('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 10000, label: 'git' }); }
  catch (e) { if (e.exitCode === EXIT.ENV) throw fail(EXIT.ENV, 'git', '找不到 git：原生运行时要求作品在 git 工作树里', '装好 git 并放进 PATH'); throw e; }
  if (r.status !== 0) throw fail(EXIT.ENV, 'not-worktree', `作品目录不在 git 工作树里（${repoRel(dir)}）：原生运行时会以「outside raea's home and the project's folder」拒绝渲染`, '在仓库的 git 检出里做作品（films/<名字>/）；git archive 导出的目录先 git init 再用');
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
  if (missing.length) throw fail(EXIT.ENV, 'missing-assets', `media/ 缺少：${missing.slice(0, 8).join('、')}${missing.length > 8 ? ` 等 ${missing.length} 项` : ''}`, `先准备素材：node engine/native/prepare.mjs ${repoRel(spec.dir)}`);
  let prepared = null;
  try { prepared = JSON.parse(await readFile(join(media, 'prepared.json'), 'utf8')); } catch { /* 下面判 */ }
  const hashes = {}, undeclared = [];
  for (const a of names.values()) {
    const h = await hashAsset(join(media, a.name));
    hashes[a.name] = h;
    if (a.undeclared) { undeclared.push(a.name); continue; }
    if (!prepared) throw fail(EXIT.CONTRACT, 'no-prepared', 'media/prepared.json 不存在：素材不是由 prepare 生成的，无法核对', `重新准备：node engine/native/prepare.mjs ${repoRel(spec.dir)}`);
    const want = prepared.assets?.[a.name];
    if (want !== h) throw fail(EXIT.CONTRACT, 'asset-hash', `media/${a.name} 的 sha256 与 prepared.json 记录不符（${want ? '素材在 prepare 之后被改过或替换' : 'prepared.json 里没有这一项'}）`, `重新准备：node engine/native/prepare.mjs ${repoRel(spec.dir)}`);
  }
  // film.json 的素材清单在 prepare 之后改过（例如改了 edge 参数）：media/ 里的东西已经不是清单描述的样子
  const stale = prepared?.specs ? SPEC_KINDS.filter(k => prepared.specs[k] !== undefined && prepared.specs[k] !== specHash(spec.native, k)) : [];
  if (stale.length) throw fail(EXIT.CONTRACT, 'stale-assets', `film.json 的素材清单（${stale.join('、')}）在 prepare 之后改过，media/ 里的素材已过期`, `重新准备：node engine/native/prepare.mjs ${repoRel(spec.dir)} --only ${stale.join(',')}`);
  if (prepared && !prepared.specs) warn('media/prepared.json 是旧格式（没有素材清单指纹），发现不了「清单改了没重做」：重新准备一次即可补上');
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
  if (comfy.checked && (comfy.running || comfy.pending)) throw fail(EXIT.BUSY, 'comfy', `ComfyUI 队列有任务（运行 ${comfy.running}、排队 ${comfy.pending}）`, '等它跑完再渲；从不终止别人的任务');
  if (!comfy.checked) {
    if (a['require-idle-check']) throw fail(EXIT.BUSY, 'idle-unknown', `查不到 ComfyUI 队列（${comfy.reason}），无法确认共享 GPU 空闲`, '确认工作站空闲后去掉 --require-idle-check，或修好 COMFY_URL');
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
  if (nvidia.busy) throw fail(EXIT.BUSY, 'gpu', `GPU 利用率超过 10%：${nvidia.samples.join('；')}`, '共享工作站空闲后再渲');
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
  if (!/^[\w.-]+$/.test(base)) throw fail(EXIT.USAGE, 'bad-value', `--run-id 只能含字母、数字、. _ -：${base}`);
  await mkdir(join(spec.dir, 'out'), { recursive: true });
  for (let i = 1; i < 100; i++) {
    const runId = i === 1 ? base : `${base}-${i}`, runDir = join(spec.dir, 'out', runId);
    try { await mkdir(runDir); return { runDir, runId }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw fail(EXIT.BUSY, 'run-dir', '同一秒内的运行目录已用完', '稍后重试');
}

let tmpSeq = 0;
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}-${++tmpSeq}.part`;   // 每次写一个独立的临时文件：中断清理与失败收尾同时写也不会交错
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, file);
}

// ───────── 原生运行时调用 ─────────
async function raeaRender(rt, spec, args, { label, logFile, timeoutMs, env }) {
  const errors = [];
  let errorTail = 0, stats = null, applied = null, sysinfo = null, backendSeen = null, softwareSeen = false;
  const r = await spawnStream(rt.exe, args, {
    cwd: spec.dir, env, timeoutMs, logFile, quiet: true, label,
    onLine: raw => {
      const l = raw.replace(ANSI, '');
      if (/\bERROR\b/.test(l)) { errors.push(l.trim()); errorTail = 8; log(`  │ ${l}`); return; }
      if (errorTail > 0 && l.trim()) { errors[errors.length - 1] += `\n${l.trim()}`; errorTail--; return; }
      if (/^APPLIED\b/.test(l)) { applied = l.trim(); log(`  │ ${l.trim()}`); }
      if (/REFUSED/.test(l)) log(`  │ ${l.trim()}`);
      if (/SystemInfo/.test(l) && !sysinfo) sysinfo = l.trim();
      const gb = /\b(metal|vulkan|dx12|direct3d ?12|opengl|gles)\b/i.exec(l);
      if (gb && !backendSeen) backendSeen = gb[1].toLowerCase();
      if (/llvmpipe|swiftshader|software rasterizer|Microsoft Basic Render/i.test(l)) softwareSeen = true;
      if (l.startsWith('{') && l.includes('"frames"')) { try { stats = JSON.parse(l); } catch { /* 不是统计行 */ } }
    },
  });
  if (r.code !== 0) {
    const refused = /REFUSED[^\n]*/.exec(`${r.stdout}\n${r.stderr}`.replace(ANSI, ''));
    if (refused && /outside .*project's folder/.test(refused[0])) throw fail(EXIT.ENV, 'not-worktree', `原生运行时拒绝了这个作品目录：${refused[0].trim()}`, '在仓库的 git 检出里做作品（films/<名字>/）；git archive 导出的目录先 git init 再用');
    throw fail(EXIT.FAIL, 'native-render', `${label}失败（运行时退出码 ${r.code ?? r.signal}）${refused ? `：${refused[0].trim()}` : errors[0] ? `：${errors[0].split('\n').slice(0, 4).join(' ')}` : ''}`, `完整日志：${repoRel(logFile)}`);
  }
  if (errors.length) throw fail(EXIT.FAIL, 'native-error', `${label}日志里有 ERROR（运行时仍返回 0，画面可能缺了一层）：${errors[0].split('\n').slice(0, 6).join(' ⏎ ')}`, `完整日志：${repoRel(logFile)}；着色器报错先修对应的 WESL`);
  return { stats, applied, sysinfo, backend: backendSeen, software: softwareSeen };
}

async function ffmpegRun(args, label, timeoutMs) {
  const r = await spawnStream(BIN().ffmpeg, args, { timeoutMs, quiet: true, label });
  if (r.code !== 0) throw fail(EXIT.FAIL, 'ffmpeg', `${label}失败：${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  return r;
}
async function measure(file, timeoutMs) {
  const r = await spawnStream(BIN().ffmpeg, D.loudnessArgs(file), { timeoutMs, quiet: true, label: '响度测量' });
  if (r.code !== 0) throw fail(EXIT.FAIL, 'loudness', `响度测量失败：${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
  return D.parseEbur128(r.stderr);
}
function probe(file) {
  const p = runQuick(BIN().ffprobe, D.probeArgs(file), { timeoutMs: 600000, label: 'ffprobe' });
  if (p.status !== 0) throw fail(EXIT.FAIL, 'probe', `ffprobe 读不了 ${repoRel(file)}：${p.stderr.trim().slice(0, 200)}`);
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

// 仓库的机器 QA 门（tools/qa，P07）：report 子命令跑规格 / 画面 / 底板 / 声画，报告写进 <运行目录>/qa/
async function runQa({ deliver, spec, profile, runDir, timeoutMs }) {
  const qaDir = join(runDir, 'qa');
  const q = await spawnStream(process.execPath, [join(ROOT, 'tools/qa/cli.mjs'), 'report', deliver, '--film', spec.dir, '--profile', profile, '--out', qaDir, '--json'],
    { cwd: ROOT, timeoutMs, quiet: true, label: '机器 QA 门' });
  let envelope = null;
  try { envelope = JSON.parse(q.stdout); } catch { /* 下面按没有信封处理 */ }
  const reportFile = join(qaDir, 'report.json');
  let report = null;
  try { report = JSON.parse(await readFile(reportFile, 'utf8')); } catch { /* QA 没写出报告 */ }
  return { code: q.code, envelope, report, reportFile: report ? reportFile : null, markdown: existsSync(join(qaDir, 'report.md')) ? join(qaDir, 'report.md') : null, stderr: q.stderr };
}

// 用作品描述包的校验器自检 run.json（存在才调；只记录，不影响退出码：校验口径由作品描述包维护）
async function selfCheck(record, expectedFrameCount) {
  const file = join(ROOT, 'engine', 'production', 'project.js');
  if (!existsSync(file)) return null;
  try {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.validateRenderResult !== 'function') return null;
    const r = mod.validateRenderResult(record, { expectedFrameCount });
    return { validator: 'engine/production/project.js#validateRenderResult', ok: r.ok, diagnostics: r.diagnostics ?? [] };
  } catch (e) { return { validator: 'engine/production/project.js#validateRenderResult', ok: null, diagnostics: [{ code: 'validator-crashed', path: '$', message: String(e?.message ?? e) }] }; }
}

// ───────── 命令 ─────────
export const command = defineCommand({
  name: 'native',
  summary: 'B 路线（北冥原生 · BNE）的预检、草图帧与出片：原生母版 + 网页版 + 运行记录 + 成片检查 + 机器 QA',
  usage: [
    'node engine/render/native.mjs <作品目录> [选项]',
    'node engine/render/native.mjs <作品目录> --check-only',
    'node engine/render/native.mjs <作品目录> --at 0,36,71',
  ],
  description: () => [
    '不带选项时：预检 → GPU 守卫 → 原生渲染 → 母版 master.mp4（原生视频轨逐位复制）+ 网页版 web.mp4（D07 交付档）',
    '→ 逐帧哈希、联系表、播放页 → 运行时自带的 raea check → 机器 QA 门；产物在 <作品>/out/<run-id>/，out/latest 指向最近一次成功的运行。',
    `交付档位：${Object.keys(D.PROFILES).join(' / ')}（默认取 film.json，没有就按尺寸与帧率推断）。`,
    '环境变量：RAEA_BIN（必需，运行时不随仓库分发：node engine/native/runtime.mjs fetch --accept-license）、FFMPEG、FFPROBE、',
    'WGPU_BACKEND（Windows 默认 vulkan）、COMFY_URL、BNE_ALLOW_VERSION。作品要在 git 工作树里。',
  ],
  positionals: [{ name: 'film', label: '<作品目录>', describe: 'films/<名字>（film.json 的 route 是 "b"）' }],
  options: {
    'check-only': { type: 'boolean', describe: '只预检（运行时版本与哈希、FFmpeg、素材与 prepared.json 哈希），不启动 GPU' },
    at: { type: 'string', arg: '<帧,帧,…>', describe: '只渲这几帧草图 PNG（<运行目录>/stills/f<帧号>.png），同样要过 GPU 守卫' },
    frame: { type: 'integer', arg: '<帧>', min: 0, describe: '只渲一帧草图 PNG' },
    quality: { type: 'string', arg: '<档>', choices: ['master', 'high', 'draft'], default: 'master', describe: '原生编码质量（draft 用于快速迭代）' },
    profile: { type: 'string', arg: '<档位>', choices: Object.keys(D.PROFILES), describe: '交付档位（覆盖 film.json）' },
    'no-web': { type: 'boolean', describe: '只出母版，不出网页版' },
    'skip-check': { type: 'boolean', describe: '不跑运行时自带的成片检查（run.json 记 not-run）' },
    'skip-qa': { type: 'boolean', describe: '不跑机器 QA 门：run.json 的 status 记 rendered，交给编排器或 npm run qa 判定' },
    lint: { type: 'boolean', describe: '渲染前跑 raea scene lint（只记录，不判失败）' },
    'require-idle-check': { type: 'boolean', describe: '查不到 ComfyUI 队列时也拒绝渲染（exit 5）' },
    'run-id': { type: 'string', arg: '<id>', describe: '指定运行目录名（<作品>/out/<id>/）' },
    'run-dir': { type: 'string', arg: '<目录>', describe: '指定运行目录（给编排器用，例如 <编排器的运行目录>/native）' },
    timeout: { type: 'number', arg: '<秒>', min: 1, describe: '原生渲染与母版封装各自的超时（默认 120 + 2 × 帧数）' },
    mux: { type: 'string', arg: '<copy>', describe: '已停用：母版总是逐位复制原生视频轨（只接受 copy，并提示去掉）' },
    out: { type: 'string', arg: '<路径>', describe: '已停用：产物统一写进运行目录，用 --run-dir' },
  },
  exitCodes: {
    0: '成功', 1: '渲染 / 编码失败（含运行时日志里的 ERROR）', 2: '用法错误', 3: '运行时 / 工具 / 素材缺失或不合格', 4: '契约、成片检查或 QA 硬门不通过',
    5: '共享 GPU 忙', 124: '超时', 130: '收到 SIGINT（已清理）', 143: '收到 SIGTERM（已清理）',
  },
  examples: [
    'node engine/native/prepare.mjs films/my-film && node engine/render/native.mjs films/my-film --check-only',
    'node engine/render/native.mjs films/my-film --at 0,40,107',
    'node engine/render/native.mjs films/my-film --json',
  ],
  run: ctx => run(bind(ctx)),
});

async function run(ctx) {
  const a = ctx.opts;
  const T0 = now(), timing = {};
  if (a.out !== null) throw fail(EXIT.USAGE, 'deprecated-option', '--out 已停用：产物统一写进 <作品>/out/<run-id>/', '编排器用 --run-dir <目录> 指定运行目录，成片是其中的 master.mp4 / web.mp4（--json 信封的 outputs 列出全部）');
  if (a.mux !== null) {
    if (a.mux !== 'copy') throw fail(EXIT.USAGE, 'deprecated-option', `--mux ${a.mux} 已停用：母版只做逐位复制，网页版由母版重新编码`, '去掉 --mux');
    warn('--mux copy 已是默认行为（母版逐位复制原生视频轨），这个参数可以去掉');
  }
  if (a.at !== null && a.frame !== null) throw fail(EXIT.USAGE, 'conflicting-options', '--at 与 --frame 只能用一个', '多帧用 --at 0,36,71');
  const stillFrames = a.at !== null ? parseFrames(a.at) : a.frame !== null ? [a.frame] : null;
  const timeoutS = a.timeout ?? 0;
  const quality = a.quality;

  const spec = await readFilmSpec(ctx.args.film);
  if (stillFrames) for (const f of stillFrames) if (f >= spec.frames) throw fail(EXIT.USAGE, 'frame-range', `帧号 ${f} 超出范围（共 ${spec.frames} 帧，最后一帧是 ${spec.frames - 1}）`);
  const p = D.resolveProfile(spec, a.profile);
  if (p.error) throw fail(a.profile ? EXIT.USAGE : EXIT.CONTRACT, 'profile', p.error, p.hint);
  if (p.note) warn(p.note);
  const fit = p.name.startsWith('custom-') ? [] : D.checkProfileFit(spec, p);
  if (fit.length) throw fail(EXIT.CONTRACT, 'profile-fit', fit.join('；'), '改 film.json 的 size / fps（v2 是 output），或换一个匹配的交付档位（--profile）');
  const audioTarget = D.audioTarget(p, spec.audio);

  // 1 预检
  let t = now();
  const rt = await resolveRuntime();
  if (rt.lock.version !== VALIDATED) warn(`engine/native/runtime.lock.json 的版本 ${rt.lock.version} 与本入口登记的 VALIDATED ${VALIDATED} 不一致：两处要一起改`);
  checkWorktree(spec.dir);
  const tools = { node: process.version, ...(await ffmpegInfo()) };
  const assets = await checkAssets(spec);
  timing.preflight = now() - t;
  const runtime = { version: rt.version, platform: rt.platform, binarySha256: rt.binarySha256, lockedSha256: rt.entry?.binarySha256 ?? null, verified: rt.verified };
  // 准备阶段（资产桥、序列帧、声音脚本）用过的工具版本记在 prepared.json，一并写进 run.json
  for (const k of ['python', 'playwright', 'browser', 'three']) if (assets.prepared?.tools?.[k]) tools[k] = `${assets.prepared.tools[k]}（准备阶段）`;
  log(`预检通过：运行时 ${rt.version}（${rt.platform}，${rt.verified === true ? '哈希与锁一致' : rt.verified === 'unlocked' ? '该平台未锁定' : '未验证版本'}），${Object.keys(assets.hashes).length} 个素材与 prepared.json 一致，交付档位 ${p.name}（${p.source}）`);
  if (a['check-only']) {
    let help = null;
    try { help = runQuick(rt.exe, ['--help'], { timeoutMs: 30000, label: '原生运行时' }); }
    catch (e) { if (e.exitCode === EXIT.TIMEOUT) throw e; throw fail(EXIT.ENV, 'runtime-exec', `原生运行时无法启动：${e.message}`, '检查执行权限；macOS 被隔离的下载包先 xattr -dr com.apple.quarantine <安装目录>；Windows 缺 DLL 时重装发行包'); }
    if (help.status !== 0 && !/usage/i.test(help.stdout + help.stderr)) throw fail(EXIT.ENV, 'runtime-exec', `原生运行时无法启动（退出码 ${help.status}）：${(help.stderr || help.stdout).trim().slice(0, 200)}`);
    log('只做了预检，没有启动 GPU 渲染。');
    return { data: { runtime, profile: p.name, frames: spec.frames, assets: assets.hashes } };
  }

  // 2 GPU 守卫
  const guard = await gpuGuard(a);
  const git = gitInfo();
  const { runDir, runId } = await makeRunDir(spec, a, git);
  const rel = f => posix(relative(spec.dir, join(runDir, f)));
  const env = { ...process.env };
  if (process.platform === 'win32' && !env.WGPU_BACKEND) env.WGPU_BACKEND = 'vulkan';
  const gpus = gpuNames();
  const record = {
    schemaVersion: 1, kind: stillFrames ? 'stills' : 'render-run', command: 'native', status: 'running',
    projectId: spec.id, shotId: 'film', route: 'b', backend: 'native',
    runId, runDir: repoRel(runDir), startedAt: new Date().toISOString(), finishedAt: null,
    sourceCommit: git.commit, dirty: git.dirty, argv: process.argv.slice(1).map(x => (x.startsWith(ROOT) ? repoRel(x) : x)),
    tools: { ...tools, raea: rt.version },
    runtime,
    host: { platform: process.platform, arch: process.arch, release: release(), cpus: cpus().length, memGB: +(totalmem() / 2 ** 30).toFixed(1) },
    device: { gpu: gpus, system: null },
    actualDevice: gpus.join(' / ') || null,
    actualGraphicsBackend: null, requestedGraphicsBackend: env.WGPU_BACKEND || null,
    actualEncoder: null, encoders: { master: null, web: null }, softwareFallback: null,
    profile: { name: p.name, source: p.source, width: p.width, height: p.height, fps: p.fps, color: p.color, audio: audioTarget },
    expected: { width: spec.width, height: spec.height, fps: spec.fps, frames: spec.frames, dur: spec.dur },
    inputs: { film: repoRel(spec.dir), entry: spec.native.entry, sources: {}, assets: assets.hashes, prepared: assets.prepared },
    gpuGuard: guard, outputs: {}, output: null, frameHashes: null, audio: null, aigc: null, checks: {}, qa: null, timing, warnings: [], error: null,
    technicalAcceptance: { status: 'not-run', evidence: [] },
    creativeAcceptance: { status: 'not-reviewed', reviews: [], events: [], styleComparison: [], issues: [] },
    selfCheck: null,
  };
  for (const f of await sourceFiles(spec.dir)) record.inputs.sources[f] = await sha256File(join(spec.dir, f));
  const runJsonPath = join(runDir, 'run.json');
  // run.json 的写入排成一条队：中断清理（信号）与失败收尾（被杀的子进程让渲染抛错）可能同时发生
  let saving = Promise.resolve(), interrupted = false;
  const save = () => (saving = saving.then(async () => { record.timing.total = now() - T0; record.warnings = getWarnings(); await writeJsonAtomic(runJsonPath, record); }));
  await save();
  const parts = [];
  const cleanup = onCleanup(async () => {
    interrupted = true;
    for (const f of parts) await rm(f, { force: true });
    record.status = 'failed'; record.error = { code: 'interrupted', message: '运行被中断（收到 SIGINT / SIGTERM），子进程已终止、半成品已删除' }; record.finishedAt = new Date().toISOString();
    try { await save(); } catch { /* 尽力 */ }
  });
  const noteDevice = r => {
    record.device.system = parseSysinfo(r.sysinfo);
    if (!record.actualDevice && record.device.system?.cpu) record.actualDevice = record.device.system.cpu;
    record.actualGraphicsBackend = r.backend || env.WGPU_BACKEND || null;
    record.softwareFallback = r.software ? true : r.backend ? false : null;
    if (r.software) warn('运行时日志显示用的是软件渲染（llvmpipe / SwiftShader 等）：速度与画面都不代表 GPU 结果');
  };

  try {
    if (a.lint) {
      const l = runQuick(rt.exe, ['scene', 'lint', spec.native.entry, '--json'], { cwd: spec.dir, env, timeoutMs: 120000, label: 'raea scene lint' });
      try { record.checks.sceneLint = JSON.parse(l.stdout); } catch { record.checks.sceneLint = { raw: (l.stdout || l.stderr).slice(0, 4000) }; }
      log('scene lint 结果已记入 run.json（只记录，不判失败）');
    }
    const timeoutMs = 1000 * (timeoutS > 0 ? timeoutS : 120 + 2 * spec.frames);

    // 3a 草图帧（不是成片：不做交付检查与 QA，status 记 rendered）
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
        if (got.length !== stillFrames.length) throw fail(EXIT.CONTRACT, 'stills', `要 ${stillFrames.length} 帧，运行时只写出 ${got.length} 帧`);
        for (let i = 0; i < got.length; i++) await rename(join(dir, got[i]), join(dir, `f${pad(stillFrames[i])}.png`));
      }
      noteDevice(r);
      timing.render = now() - t;
      const outputs = [];
      for (const f of stillFrames) { const file = join(dir, `f${pad(f)}.png`); outputs.push({ path: repoRel(file), sha256: await sha256File(file), kind: 'still' }); }
      record.status = 'rendered'; record.outputs = { stills: outputs }; record.finishedAt = new Date().toISOString();
      await save();
      offCleanup(cleanup);
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
    noteDevice(r);
    record.encoders.master = r.stats?.video ?? null;
    record.nativeStats = r.stats ? { frames: r.stats.frames, fpsInclEncode: r.stats.fps_incl_encode, bytes: r.stats.bytes, video: r.stats.video } : null;
    if (!existsSync(native)) throw fail(EXIT.FAIL, 'native-output', '运行时没有写出 native.mp4', `看 ${repoRel(join(runDir, 'render.log'))}`);
    const nd = D.describeVideo(probe(native));
    const nativeProblems = D.judgeVideo(nd, spec, { audio: false });
    if (nativeProblems.length) throw fail(EXIT.CONTRACT, 'native-contract', `原生输出不符合 film.json：${nativeProblems.join('；')}`, '核对 film.tsx 的 Composition 与 film.json 的尺寸 / 帧率 / 时长是否一致');

    // 声音：实测混音 → 线性增益
    const pcm = spec.native.audio ? join(spec.dir, 'media', spec.native.audio.out || 'mix.wav') : null;
    let plan = { gainDb: 0 }, pcmLoud = null;
    if (pcm) {
      pcmLoud = await measure(pcm, 600000);
      plan = D.planGain(pcmLoud, audioTarget);
      if (!plan.ok) throw fail(EXIT.CONTRACT, 'loudness-plan', plan.reason, '在声音脚本里用 engine.audio.mixing.loudness_to 把真峰值限在 −1.5 dBTP 左右再导出');
      if (plan.limitedByPeak) warn(`为守住真峰值，增益按峰值限定为 ${plan.gainDb} dB（预计 ${plan.expectedI.toFixed(1)} LUFS）`);
    } else warn('film.json 没有 native.audio：母版无声，网页版写入静音立体声轨');
    record.audio = pcm ? { source: repoRel(pcm), sha256: assets.hashes[spec.native.audio.out || 'mix.wav'], measured: pcmLoud, plan: { gainDb: plan.gainDb, limitedByPeak: plan.limitedByPeak }, target: audioTarget } : { source: null };

    // 4 母版（元数据：片名；含 AI 生成画面时写隐式标识，决定 D11）
    const meta = D.metadataArgs({ title: spec.title, aigc: spec.raw.aigc, producer: '北冥引擎（北冥原生 · BNE）', produceId: `${spec.id}/${runId}` });
    record.aigc = spec.raw.aigc?.contains ? { contains: true, label: D.AIGC_LABEL, note: spec.raw.aigc.note ?? null, where: ['mp4 comment（AIGC{…} 隐式标识）', 'player.html（显式标识）'] } : { contains: Boolean(spec.raw.aigc?.contains) };
    t = now();
    const master = join(runDir, 'master.mp4');
    parts.push(`${master}.part`);
    const m = await encodeWithLoudness({
      label: '母版封装', out: master, pcm, audio: audioTarget, gainDb: plan.gainDb, timeoutMs,
      build: (g, part) => D.masterArgs({ video: native, pcm, gainDb: g, out: part, audio: audioTarget, durSeconds: spec.dur, meta }),
    });
    const md = D.describeVideo(probe(master));
    const masterProblems = D.judgeVideo(md, spec, { audio: Boolean(pcm) });
    if (pcm) { const j = D.judgeLoudness(m.loudness, audioTarget); masterProblems.push(...j.problems.map(x => `母版${x}`)); record.audio.master = { ...m.loudness, gainDb: m.gainDb }; }
    record.outputs.master = { path: repoRel(master), sha256: await sha256File(master), encoder: `${record.encoders.master || '原生编码器'}（逐位复制）`, ...md };
    timing.master = now() - t;
    if (masterProblems.length) throw fail(EXIT.CONTRACT, 'master-contract', `母版不合格：${masterProblems.join('；')}`);
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
        build: (g, part) => { const b = D.webArgs({ master, pcm, gainDb: g, out: part, p, audio: audioTarget, sourceColor: { color_space: md.color.matrix, color_range: md.color.range, color_primaries: md.color.primaries }, durSeconds: spec.dur, meta }); colorNote = b.colorNote; return b.args; },
      });
      const wd = D.describeVideo(probe(web));
      const webProblems = D.judgeVideo(wd, spec, { web: true, audio: true, p });
      if (pcm) { const j = D.judgeLoudness(w.loudness, audioTarget); webProblems.push(...j.problems.map(x => `网页版${x}`)); record.audio.web = { ...w.loudness, gainDb: w.gainDb }; }
      record.encoders.web = p.video.codec;
      record.outputs.web = { path: repoRel(web), sha256: await sha256File(web), encoder: p.video.codec, colorNote, ...wd };
      timing.web = now() - t;
      if (webProblems.length) throw fail(EXIT.CONTRACT, 'web-contract', `网页版不合格：${webProblems.join('；')}`);
      deliver = web; deliverDesc = wd;
    }
    record.actualEncoder = [record.encoders.master && `${record.encoders.master}（母版，原生）`, record.encoders.web && `${record.encoders.web}（网页版）`].filter(Boolean).join('；') || null;
    record.output = { path: repoRel(deliver), sha256: (record.outputs.web || record.outputs.master).sha256, width: deliverDesc.width, height: deliverDesc.height, fps: deliverDesc.fps, frames: deliverDesc.frames, pixFmt: deliverDesc.pixFmt, color: deliverDesc.color };

    // 6 验收证据：先出逐帧哈希、联系表、播放页（检查不过时也留着它们定位问题），再跑运行时自带的成片检查
    t = now();
    const md5 = join(runDir, 'framemd5.txt');
    await ffmpegRun(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', master, '-map', '0:v:0', '-f', 'framemd5', md5], '逐帧哈希', 600000);
    const md5Count = (await readFile(md5, 'utf8')).split('\n').filter(l => l && !l.startsWith('#')).length;
    record.frameHashes = { kind: 'ffmpeg-framemd5（母版解码后）', path: repoRel(md5), sha256: await sha256File(md5), frames: md5Count };
    const cols = 5, every = Math.max(1, Math.ceil(spec.frames / 40));
    await ffmpegRun(['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', deliver, '-vf', `select='not(mod(n\\,${every}))',scale=384:-2,tile=${cols}x${Math.ceil(Math.ceil(spec.frames / every) / cols)}:padding=4:color=white`, '-frames:v', '1', '-q:v', '3', join(runDir, 'contact.jpg')], '联系表', 300000);
    await writeFile(join(runDir, 'player.html'), playerHtml(spec, runId, deliver.endsWith('web.mp4') ? 'web.mp4' : 'master.mp4', spec.raw.aigc));
    if (!a['skip-check']) {
      const out = join(runDir, 'check.json');
      const c = await spawnStream(rt.exe, ['check', rel(deliver.endsWith('web.mp4') ? 'web.mp4' : 'master.mp4'), '--manifest', rel('render.json'), '-o', rel('check.json')],
        { cwd: spec.dir, env, timeoutMs: 1000 * (120 + spec.frames), quiet: true, label: 'raea check' });
      let check = null;
      try { check = JSON.parse(await readFile(out, 'utf8')); } catch { /* 下面判 */ }
      if (!check) throw fail(EXIT.FAIL, 'raea-check', `raea check 没有写出结果（退出码 ${c.code}）：${c.stderr.replace(ANSI, '').trim().split('\n').slice(-2).join(' ')}`);
      const issues = check.issues || [];
      const rank = i => String(i?.p ?? i?.severity ?? i?.rank ?? (JSON.stringify(i).match(/\bP[0-3]\b/) || [''])[0]);
      const severe = issues.filter(i => /^P[01]$/.test(rank(i)));
      record.checks.raeaCheck = { ran: true, exitCode: c.code, ok: c.code === 0 && severe.length === 0, file: repoRel(out), passed: check.passed || [], issues };
      for (const l of (check.passed || [])) log(`  ✓ ${l}`);
      for (const i of issues) log(`  ✗ [${rank(i) || '?'}] ${i?.says ?? JSON.stringify(i)}${i?.at !== undefined ? `（${Number(i.at).toFixed(2)} 秒）` : ''}`);
      if (c.code !== 0 || severe.length) throw fail(EXIT.CONTRACT, 'raea-check', `运行时自带的成片检查发现 P0 / P1 问题 ${severe.length || '（退出码 1）'} 项`, `看 ${repoRel(out)} 与 ${repoRel(join(runDir, 'contact.jpg'))}，修好后重渲`);
    } else record.checks.raeaCheck = { ran: false, status: 'not-run' };
    timing.evidence = now() - t;
    const evidence = ['check.json', 'framemd5.txt', 'contact.jpg'].filter(f => existsSync(join(runDir, f))).map(f => repoRel(join(runDir, f)));

    // 7 机器 QA 门
    if (a['skip-qa'] || p.name.startsWith('custom-')) {
      record.qa = { ran: false, reason: a['skip-qa'] ? '--skip-qa' : `自定义档位 ${p.name} 没有对应的 QA 规格` };
      if (!a['skip-qa']) warn(`交付档位是自定义的 ${p.name}：机器 QA 门没有对应规格，没有跑；要交付请改成标准档位`);
      record.status = 'rendered';
      record.technicalAcceptance = { status: 'not-run', evidence };
    } else {
      t = now();
      log('机器 QA 门：node tools/qa/cli.mjs report …');
      const q = await runQa({ deliver, spec, profile: p.name, runDir, timeoutMs: 1000 * (300 + 2 * spec.frames) });
      timing.qa = now() - t;
      const rep = q.report;
      record.qa = { ran: true, exitCode: q.code, report: q.reportFile ? repoRel(q.reportFile) : null, markdown: q.markdown ? repoRel(q.markdown) : null,
        ok: rep?.ok ?? null, summary: rep?.summary ?? null, skipped: rep?.skipped ?? [] };
      for (const c of (rep?.checks || []).filter(c => c.status === 'fail' || c.status === 'warn')) log(`  ${c.status === 'fail' ? '✗' : '!'} ${c.id}：${c.message || c.value}`);
      if (q.code === EXIT.OK && rep?.ok) {
        record.status = 'passed';
        record.technicalAcceptance = { status: 'passed', evidence: [repoRel(q.reportFile), ...evidence] };
      } else if (q.code === EXIT.CONTRACT && rep) {
        record.technicalAcceptance = { status: 'failed', evidence: [repoRel(q.reportFile), ...evidence] };
        throw fail(EXIT.CONTRACT, 'qa-gate', `机器 QA 门不通过：${(rep.summary?.hardFailures || []).join('、') || '见报告'}`, `看 ${repoRel(q.markdown || q.reportFile)}，修好后重渲`);
      } else {
        record.technicalAcceptance = { status: 'blocked', evidence };
        const why = q.envelope?.error?.message || q.stderr.trim().split('\n').slice(-1)[0] || `退出码 ${q.code}`;
        throw fail(q.code === EXIT.ENV ? EXIT.ENV : q.code === EXIT.TIMEOUT ? EXIT.TIMEOUT : EXIT.FAIL, 'qa-run', `机器 QA 门没能跑完（exit ${q.code}）：${why}`, `成片已在 ${repoRel(runDir)}；修好环境后补跑：node tools/qa/cli.mjs report ${repoRel(deliver)} --film ${repoRel(spec.dir)} --out ${repoRel(join(runDir, 'qa'))}`);
      }
    }

    record.finishedAt = new Date().toISOString();
    record.selfCheck = await selfCheck(record, spec.frames);
    await save();
    // out/latest 只在运行目录是 <作品>/out/<run-id>/ 时写；--run-dir 由编排器管理自己的指针
    if (!a['run-dir']) await writeFile(join(spec.dir, 'out', 'latest'), `${runId}\n`);
    offCleanup(cleanup);
    const outputs = [];
    for (const [kind, f] of [['master', 'master.mp4'], ['web', 'web.mp4'], ['run-json', 'run.json'], ['raea-check', 'check.json'], ['qa-report', 'qa/report.json'], ['contact-sheet', 'contact.jpg'], ['player', 'player.html']]) {
      const file = join(runDir, f);
      if (existsSync(file)) outputs.push({ path: repoRel(file), sha256: kind === 'master' ? record.outputs.master.sha256 : kind === 'web' ? record.outputs.web.sha256 : await sha256File(file), kind });
    }
    log(`已出片 ${repoRel(runDir)}/：母版 ${(statSync(master).size / 1e6).toFixed(1)} MB（原生编码器 ${record.encoders.master || '未知'}）${record.outputs.web ? `、网页版 ${(statSync(join(runDir, 'web.mp4')).size / 1e6).toFixed(1)} MB` : ''}；`
      + `${spec.width}×${spec.height} ${spec.fps}fps ${spec.frames} 帧${record.audio?.web ? `，${record.audio.web.I} LUFS / ${record.audio.web.TP} dBTP` : ''}；原生渲染 ${timing.render.toFixed(1)} 秒；`
      + `${record.status === 'passed' ? '机器 QA 通过' : '机器 QA 没跑（status = rendered）'}。技术检查通过 ≠ 画面通过：看 contact.jpg 与整片。`);
    return { outputs, runJson: repoRel(runJsonPath), data: { runId, status: record.status, profile: p.name, frames: spec.frames } };
  } catch (e) {
    offCleanup(cleanup);
    for (const f of parts) if (f.endsWith('.part')) await rm(f, { force: true });
    if (!interrupted) {   // 被信号中断时由清理写 interrupted，这里不覆盖
      record.status = 'failed';
      record.error = e?.code ? { code: e.code, exitCode: e.exitCode, message: e.message, hint: e.hint ?? null } : { code: 'failure.internal', message: String(e?.message || e) };
      record.finishedAt = new Date().toISOString();
      try { record.selfCheck = await selfCheck(record, spec.frames); await save(); } catch { /* 运行目录可能不可写 */ }
    }
    if (e && typeof e === 'object' && 'hint' in e && !String(e.hint ?? '').includes('run.json')) e.hint = `${e.hint ? `${e.hint}；` : ''}运行记录：${repoRel(runJsonPath)}`;
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
  const list = String(s).split(',').map(x => x.trim()).filter(Boolean);
  if (!list.length || list.some(x => !/^\d+$/.test(x))) throw fail(EXIT.USAGE, 'bad-value', `帧号要写成非负整数，逗号分隔：${s}`, '例：--at 0,36,71');
  return list.map(Number);
}

function playerHtml(spec, runId, file, aigc) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(spec.title)} · ${esc(runId)}</title>
<style>:root{color-scheme:dark}body{margin:0;background:#111;color:#ddd;font:14px/1.5 system-ui,sans-serif}main{max-width:min(100vw,${spec.width}px);margin:0 auto;padding:16px}video{width:100%;height:auto;background:#000}p{margin:.5em 0;color:#999}</style>
<main><video src="${esc(file)}" controls preload="metadata"></video><p>${esc(spec.title)} · ${spec.width}×${spec.height} · ${spec.fps} fps · ${spec.frames} 帧 · 运行 ${esc(runId)}（本地看片用；记录见 run.json）</p>${aigc?.contains ? `<p>${esc(D.AIGC_LABEL)}${aigc.note ? `：${esc(aigc.note)}` : ''}</p>` : ''}</main>\n`;
}

if (isMain(import.meta.url)) await exitWith(runCli(command));
