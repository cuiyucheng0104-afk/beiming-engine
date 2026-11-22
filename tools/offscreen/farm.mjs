#!/usr/bin/env node
// 北冥仓库 · 离屏出片 · 切片分发编排器（性能规格 WP3，docs/offscreen/spec-perf-first-principles.md §3）：
// 把 [from, to) 切成若干连续帧段（优先对齐镜头切点，单镜超过 --block 按固定块长均分），分发给若干槽位独立渲染编码，
// 每片是封闭 GOP 的 MP4（-g 与 -video_track_timescale 全段统一、首帧 IDR），最后 ffmpeg concat -c copy 无损合并，
// 并核验：总帧数 = to - from、PTS 严格单调无空洞、BT.709 色彩标记完整、合并前后 framemd5 连续、逐段 sha256 留痕。
//   node tools/offscreen/farm.mjs render <作品.mjs> --out <成片.mp4> --frames a:b [--slots 2] [--shards <n>] [--seams <帧,…>]
//                                                  [--block 240] [--size WxH] [--fps 24] [--mode pro|fast] [--encoder x264|nvenc] [--retries 1]
// --transport local：槽位是本机独立渲染进程（各自一个 GPUDevice），模拟多节点；多机分发走 tools/remote（接入条件见规格书 §5.4）。
// 容错：单块失败只重试该块（--retries 次用尽后整场报失败），已完成的切片不重跑。
// 混卡：不同 GPU/驱动的 NVENC 码流不保证逐字节相同（画质门槛仍满足）；跨机要严格逐字节一致时显式 --encoder x264。
// 确定性（规格 §2 第 3 条）：各片用 --frame-hashes on 记录无损读回哈希，data.frameHashes 与单机整段渲染逐帧比对即无接缝判据。
// 退出码：0 成功；1 切片渲染或合并失败；2 用法错误；3 缺 FFmpeg 等环境；4 拼接契约或核验不符。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineCommand, isMain, runCli, usageError, CliError } from '../lib/cli.mjs';
import { resolveWork, parseSize } from '../../engine/offscreen/cli.mjs';
import { MASTER_CQ, MODES, ENCODER_CHOICES } from '../../engine/offscreen/encode.mjs';
import { concatChunks } from '../../engine/render/lib/chunks.mjs';
import { FFMPEG, FFPROBE, probe, streamSignature, frameMd5, run } from '../../engine/render/lib/ffmpeg.mjs';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const OFFSCREEN_CLI = path.join(ROOT, 'engine', 'offscreen', 'cli.mjs');
const OWNER_MARK = '.offscreen-farm-owner';
const pad = n => String(n).padStart(6, '0');
const sha256File = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const repoRel = p => { const r = path.relative(ROOT, p); return (r.startsWith('..') || path.isAbsolute(r) ? p : r.split(path.sep).join('/')); };

// ── 切片规划（纯函数；边界只由 from/to/target/seams/block 决定，与槽位数无关，同一区间切法永远相同） ──

const splitEven = (a, b, n) => Array.from({ length: n }, (_, i) => [a + Math.round((i * (b - a)) / n), a + Math.round(((i + 1) * (b - a)) / n)]);

/**
 * 把 [from, to) 切成连续帧段：优先对齐 seams（镜头切点）；单镜（或无切点的整段）超过 block 按固定块长均分；
 * 段数不足 target 时平分最长的一段补足；段数多于 target 时就近合并相邻段（合并后仍不得超过 block，办不到就保持更多段）。
 * 返回 [[a, b], …]：恰好覆盖 [from, to)、无重叠、每段长度 ≥ 1 且 ≤ block、段数 ≥ min(target, 总帧数)。
 */
export function planShards({ from, to, target = 1, seams = [], block = 240 }) {
  if (!(Number.isInteger(from) && Number.isInteger(to) && to > from)) throw usageError('bad-frames', `帧区间要写成 a:b 且止 > 起（整数），收到 ${from}:${to}`, '例如 --frames 0:192');
  if (!(Number.isInteger(target) && target >= 1)) throw usageError('bad-value', `--shards 要是 ≥ 1 的整数，收到 ${target}`, null);
  if (!(Number.isInteger(block) && block >= 1)) throw usageError('bad-value', `--block 要是 ≥ 1 的整数，收到 ${block}`, null);
  const cuts = [...new Set((seams || []).filter(s => Number.isInteger(s) && s > from && s < to))].sort((x, y) => x - y);
  let pieces = [];
  let cur = from;
  for (const s of cuts) { pieces.push([cur, s]); cur = s; }
  pieces.push([cur, to]);
  pieces = pieces.flatMap(([a, b]) => splitEven(a, b, Math.max(1, Math.ceil((b - a) / block))));   // 单镜过长 → 块长均分
  const want = Math.min(target, to - from);
  while (pieces.length < want) {                                                                   // 段数不足 → 平分最长段
    let k = 0;
    for (let i = 1; i < pieces.length; i++) if (pieces[i][1] - pieces[i][0] > pieces[k][1] - pieces[k][0]) k = i;
    const [a, b] = pieces[k];
    if (b - a < 2) break;
    pieces.splice(k, 1, [a, a + Math.floor((b - a) / 2)], [a + Math.floor((b - a) / 2), b]);
  }
  while (pieces.length > want) {                                                                   // 段数过多 → 就近合并（守住 block）
    let best = -1, bestLen = Infinity;
    for (let i = 0; i + 1 < pieces.length; i++) {
      const len = pieces[i][1] - pieces[i][0] + pieces[i + 1][1] - pieces[i + 1][0];
      if (len < bestLen) { bestLen = len; best = i; }
    }
    if (best < 0 || bestLen > block) break;
    pieces.splice(best, 2, [pieces[best][0], pieces[best + 1][1]]);
  }
  return pieces;
}

/** film.json v2 的镜头表 → 落在 (from, to) 内的整数切点（镜头 in/out 都是输出帧号）；没有镜头表返回空。 */
export function shotSeams(filmJson, { from, to }) {
  const shots = filmJson && Array.isArray(filmJson.shots) ? filmJson.shots : [];
  const pts = new Set();
  for (const s of shots) for (const p of [s?.in, s?.out]) if (Number.isInteger(p) && p > from && p < to) pts.add(p);
  return [...pts].sort((a, b) => a - b);
}

// ── PTS 核验（纯函数）：呈现时间轴上严格单调、等步长（无空洞）、首帧为 0、帧数正确 ──

export function checkPts(pts, { step, expect }) {
  const errors = [];
  const sorted = [...pts].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] !== step) { errors.push(`第 ${i} 帧 PTS 间隔 ${sorted[i] - sorted[i - 1]} ≠ ${step}（空洞、跳变或重复）`); break; }
  }
  if (sorted.length !== expect) errors.push(`PTS 帧数 ${sorted.length} ≠ 应为 ${expect}`);
  if (sorted.length && sorted[0] !== 0) errors.push(`首帧 PTS = ${sorted[0]}，不是 0`);
  return { ok: errors.length === 0, frames: sorted.length, firstPts: sorted[0] ?? null, errors };
}

// ── 槽位池：并发取块，单块失败只重试该块，已完成的不重跑 ──

/**
 * runShards({ shards, slots, retries, runShard, onStart, onDone }) → 结果数组（与 shards 等长、同序）。
 * runShard(shard, attempt) → { ok, …, error? }，绝不抛错（抛错按该次尝试失败处理）。
 */
export async function runShards({ shards, slots, retries = 1, runShard, onStart = null, onDone = null }) {
  const results = new Array(shards.length);
  let next = 0;
  const attemptOnce = async (i, slot) => {
    const shard = shards[i];
    for (let attempt = 0; ; attempt++) {
      onStart?.(shard, attempt, slot);
      let r;
      try { r = await runShard(shard, attempt); } catch (e) { r = { ok: false, error: { code: 'failure.shard', message: String(e?.message ?? e) } }; }
      if (r.ok || attempt >= retries) return { ...r, attempts: attempt + 1 };
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(slots, shards.length)) }, (_, slot) => (async () => {
    for (;;) {
      const i = next++;
      if (i >= shards.length) break;
      results[i] = await attemptOnce(i, slot);
      onDone?.(results[i], i);
    }
  })());
  await Promise.all(workers);
  return results;
}

// ── 合并与核验 ──

/** ffprobe 逐包 PTS（时间基整数刻度）；解码序里 B 帧会乱序，由 checkPts 按呈现时间轴判定。 */
async function probePts(file) {
  const r = await run(FFPROBE(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts', '-of', 'json', file], { capture: true });
  if (r.code !== 0) throw new CliError('contract.probe', `读不出 PTS：${file}`, { hint: '文件可能不完整；重新生成它' });
  return (JSON.parse(r.stdout || '{}').packets ?? []).map(p => p?.pts).filter(x => x !== undefined && x !== 'N/A').map(Number);
}

/** 流签名与本次请求对不上的项（画幅、帧率、编码、像素格式，给了 timescale 时还有时间基）；全对返回空数组。 */
export function signatureMismatch(sig, { width, height, fps, timescale = null }) {
  const want = { size: `${width}x${height}`, rate: `${fps}/1`, codec: 'h264', pixFmt: 'yuv420p', ...(timescale ? { timeBase: `1/${timescale}` } : {}) };
  return Object.entries(want).filter(([k, x]) => sig[k] !== x).map(([k, x]) => `${k}=${sig[k]}（应为 ${x}）`);
}

/**
 * 无损合并并核验：先逐片对照本次请求的画幅 / 帧率 / 编码 / 像素格式（/ 时间基），不符抛 contract.shard-mismatch（防止别的任务的切片混进来）；
 * 再 ffmpeg concat -c copy（核对各段签名彼此一致，不一致抛 contract.concat-mismatch），
 * 然后核验总帧数、PTS 严格单调无空洞（步长按时间基与帧率换算）、四项 BT.709 色彩标记、合并前后 framemd5 逐帧连续。
 * 返回 { verify: { frames, pts, color, colorOk, md5Continuous }, probe, shardMd5 }。
 */
export async function mergeAndVerify({ files, out, from, to, fps, width, height, timescale = null, workDir }) {
  const expect = to - from;
  const want = { width, height, fps, timescale };
  for (const f of files) {
    const bad = signatureMismatch(await streamSignature(f), want);
    if (bad.length) throw new CliError('contract.shard-mismatch', `切片 ${path.basename(f)} 与本次请求不符：${bad.join('、')}`, { hint: '切片目录里混进了别的任务的产物：重跑（每次运行用独占子目录）' });
  }
  fs.mkdirSync(workDir, { recursive: true });
  await concatChunks(files, out, { expectFrames: expect, workDir });     // 内部已核对段签名一致与合并后帧数
  const p = await probe(out);
  const v = p.video;
  if (!v) throw new CliError('contract.probe', `合并成片没有视频流：${out}`, null);
  const sig = await streamSignature(out);
  const [tbN, tbD] = String(sig.timeBase || '').split('/').map(Number);
  const [frN, frD] = String(sig.rate || '').split('/').map(Number);
  const step = tbN > 0 && tbD > 0 && frN > 0 && frD > 0 ? Math.round((tbD * frD) / (tbN * frN)) : 0;
  const pts = await probePts(out);
  const ptsCheck = step > 0 ? checkPts(pts, { step, expect }) : { ok: false, frames: pts.length, firstPts: null, errors: [`时间基 ${sig.timeBase} 与帧率 ${sig.rate} 算不出整数步长`] };
  const color = v.color;
  const colorOk = color.range === 'tv' && color.space === 'bt709' && color.primaries === 'bt709' && color.transfer === 'bt709';
  const mergedMd5 = await frameMd5(out);
  const shardMd5 = (await Promise.all(files.map(f => frameMd5(f)))).flat();
  const md5Continuous = mergedMd5.length === expect && mergedMd5.every((h, i) => h === shardMd5[i]);
  const verify = { frames: v.frames, fps: v.fps, step, pts: ptsCheck, color, colorOk, md5Continuous };
  if (v.frames !== expect) throw new CliError('contract.frame-count', `合并成片是 ${v.frames} 帧，应为 ${expect} 帧`, { hint: '切片不完整或参数不一致：看 data.shards 各段帧数' });
  if (!ptsCheck.ok) throw new CliError('contract.pts', `PTS 核验未过：${ptsCheck.errors.join('；')}`, { hint: '各片时间基或帧率不一致：确认全部切片用同一命令与 --timescale 生成' });
  if (!colorOk) throw new CliError('contract.color-tags', `色彩标记不完整：${JSON.stringify(color)}`, { hint: '离屏出片应带有限范围 BT.709 四项标记（range=tv, space/primaries/transfer=bt709）' });
  if (!md5Continuous) throw new CliError('contract.md5-discontinuous', '合并成片的逐帧 md5 与各片不连续（拼接处丢帧或变序）', { hint: '用 --keep 保留切片目录逐段排查' });
  return { verify, probe: p, shardMd5 };
}

// ── 子进程：一个槽位渲一片（独立 Node + Dawn 进程，模拟一个节点） ──

function spawnNode(argv, { onSpawn, onExit } = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = '';
    let child;
    try { child = spawn(process.execPath, argv, { cwd: ROOT, windowsHide: true }); }
    catch (e) { return resolve({ code: null, stdout, stderr: String(e?.message ?? e) }); }
    onSpawn?.(child);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-8192); });
    const done = r => { onExit?.(child); resolve(r); };
    child.once('error', e => done({ code: null, stdout, stderr: stderr + String(e?.message ?? e) }));
    child.once('close', code => done({ code: code ?? 1, stdout, stderr }));
  });
}

// 子进程带 --json 时 stdout 只有信封（可能多行美化打印）；保险起见再试「从首个 { 起」与「最后一行」两种取法
const parseEnvelope = text => {
  const s = String(text || '').trim();
  if (!s) return null;
  for (const cand of [s, s.slice(s.indexOf('{')), s.split('\n').reverse().find(l => l.trim().startsWith('{')) ?? '']) {
    try { const j = JSON.parse(cand); if (j && 'exitCode' in j && 'ok' in j) return j; } catch { /* 下一种取法 */ }
  }
  return null;
};
const tail3 = s => String(s || '').trim().split('\n').slice(-3).join(' / ');

export const command = defineCommand({
  name: 'offscreen-farm',
  summary: '离屏出片的切片分发编排器：[from,to) 按镜头切点分片、多槽位并发渲染编码、ffmpeg 无损合并并核验帧数/PTS/色彩/逐段 sha256（单块失败只重试该块）',
  usage: [
    'node tools/offscreen/farm.mjs render <作品.mjs> --out <成片.mp4> --frames a:b [--slots 2] [--shards <n>] [--seams <帧,…>] [--block 240]',
    '                                   [--size WxH] [--fps 24] [--inflight 3] [--mode pro|fast] [--encoder auto|x264|nvenc] [--pix-fmt rgba|yuv420p]',
    '                                   [--crf 14] [--preset medium] [--cq 7] [--query k=v&…] [--retries 1] [--transport local] [--work-dir <目录>] [--keep] [--json]',
  ],
  description: [
    '  切片规则：优先对齐镜头切点（--seams 显式给出，缺省读作品旁的 film.json 镜头表）；单镜超过 --block（默认 240 帧）按块长均分',
    '  编码对齐：各片同分辨率/帧率/编码参数/像素格式，-g 与 -video_track_timescale 全段统一，首帧 IDR，本地 ffmpeg concat -c copy 无损合并',
    '  核验：总帧数 = to-from、PTS 严格单调无空洞、BT.709 色彩标记完整、合并前后 framemd5 连续、逐段 sha256 留痕（data.shards）',
    '  容错：单块失败只重试该块（--retries），已完成的切片不重跑；失败时保留本次的切片子目录（--keep 成功后也保留）',
    '  工作目录：--work-dir 只当父目录，每次运行在其下建独占子目录，切片与本次请求的画幅/帧率/编码对不上就拒绝拼接',
    '  混卡：跨机要码流逐字节一致时显式 --encoder x264；NVENC 各片画质达标即可',
    '  无接缝判据：各片 --frame-hashes on 的无损读回哈希拼起来（data.frameHashes）与单机整段渲染逐帧比对',
  ],
  positionals: [
    { name: 'sub', label: '<render>', describe: '子命令', required: true },
    { name: 'work', label: '<作品.mjs>', describe: '作品模块（仓库内）', required: true },
  ],
  options: {
    out: { type: 'string', arg: '<路径>', describe: '合并成片输出（.mp4）' },
    frames: { type: 'string', arg: '<a:b>', describe: '帧区间（含 a 不含 b），例如 0:192' },
    slots: { type: 'integer', default: 2, min: 1, arg: '<n>', describe: '并发槽位数（本机即同时渲染的独立进程数，默认 2）' },
    shards: { type: 'integer', min: 1, arg: '<n>', describe: '目标切片数（默认与 --slots 相同；单镜过长会自动多切）' },
    seams: { type: 'string', arg: '<帧,…>', describe: '镜头切点（逗号分隔帧号）；缺省读作品目录下 film.json 的镜头表' },
    block: { type: 'integer', default: 240, min: 1, arg: '<n>', describe: '单段最大帧数（默认 240；也是 -g 关键帧间隔）' },
    transport: { type: 'string', default: 'local', choices: ['local'], arg: '<名>', describe: '分发通道：local（本机多进程模拟多节点）。多机经 tools/remote，接入条件见 docs/offscreen/spec-perf-first-principles.md §5.4' },
    retries: { type: 'integer', default: 1, min: 0, arg: '<n>', describe: '单块失败后的重试次数（默认 1；只重试该块）' },
    size: { type: 'string', default: '1920x1080', arg: '<WxH>', describe: '画幅（默认 1920x1080，与 offscreen render 相同）' },
    fps: { type: 'integer', default: 24, min: 1, arg: '<n>', describe: '帧率（默认 24）' },
    inflight: { type: 'integer', default: 3, min: 1, arg: '<n>', describe: '每片同时在途的读回帧数（默认 3，与 offscreen render 相同）' },
    mode: { type: 'string', default: 'pro', choices: MODES, arg: '<档>', describe: '编码档（默认 pro：x264 High + rgba；fast：NVENC cq 7）' },
    encoder: { type: 'string', default: 'auto', choices: ENCODER_CHOICES, arg: '<名>', describe: '编码器（默认 auto 跟随 --mode；混卡/跨机拼接建议显式 x264 或 nvenc，避免各片回退不一致）' },
    'pix-fmt': { type: 'string', choices: ['rgba', 'yuv420p'], arg: '<格式>', describe: '读回与管道像素格式（不写跟随 --mode，与 offscreen render 相同）' },
    crf: { type: 'integer', default: 14, min: 0, arg: '<n>', describe: 'x264 crf（默认 14）' },
    cq: { type: 'integer', default: MASTER_CQ, min: 0, arg: '<n>', describe: `nvenc cq（默认 ${MASTER_CQ}）` },
    preset: { type: 'string', default: 'medium', arg: '<名>', describe: 'x264 preset（默认 medium）' },
    query: { type: 'string', default: '', arg: '<k=v&…>', describe: '交给作品 build 的查询串（与 offscreen render 相同）' },
    'work-dir': { type: 'string', arg: '<目录>', describe: '切片工作目录的父目录（默认系统临时目录）；每次运行在其下新建独占子目录 .offscreen-farm-*，这个目录本身和里面原有的东西都不会被删' },
    keep: { type: 'boolean', describe: '成功后保留本次的切片子目录（路径在 data.workDir；默认只删本次建的子目录，sha256 已记录在信封里）' },
  },
  exitCodes: { 0: '成功', 1: '切片渲染或合并失败', 2: '用法错误', 3: '缺 FFmpeg 等环境', 4: '拼接契约或核验不符' },
  examples: [
    'node tools/offscreen/farm.mjs render lab/offscreen/ink.mjs --out out/offscreen/ink-farm.mp4 --frames 0:192 --slots 2',
    'node tools/offscreen/farm.mjs render films/chendu/offscreen.mjs --out out/offscreen/chendu-farm.mp4 --frames 0:192 --slots 2 --size 3840x2160 --keep --json',
  ],
  async run(ctx) {
    const o = ctx.opts;
    if (ctx.args.sub !== 'render') throw usageError('bad-subcommand', `未知子命令 ${ctx.args.sub}`, '可用：render');
    if (!o.out) throw usageError('missing-out', 'render 需要 --out <成片.mp4>', null);
    if (!o.frames) throw usageError('missing-frames', 'render 需要 --frames a:b（含 a 不含 b 的整数帧号）', '例如 --frames 0:192');
    const fm = /^(\d+):(\d+)$/.exec(o.frames);
    if (!fm || +fm[2] <= +fm[1]) throw usageError('bad-value', `--frames 要写成 a:b 且止 > 起，收到「${o.frames}」`, '例如 --frames 0:192');
    const from = +fm[1], to = +fm[2];
    const file = resolveWork(ctx.args.work);
    const [width, height] = parseSize(o.size);
    const fps = o.fps, inflight = o.inflight;
    const slots = o.slots, block = o.block, retries = o.retries, target = o.shards ?? slots;
    const out = path.resolve(o.out);

    let seams;
    if (o.seams != null) {
      seams = o.seams.split(',').map(s => s.trim()).filter(Boolean).map(Number);
      if (seams.some(s => !Number.isInteger(s) || s < 0)) throw usageError('bad-value', `--seams 要是逗号分隔的非负整数帧号，收到「${o.seams}」`, '例如 --seams 72,144');
    } else {
      const filmJsonPath = path.join(path.dirname(file), 'film.json');
      let filmJson = null;
      try { filmJson = JSON.parse(fs.readFileSync(filmJsonPath, 'utf8')); } catch { /* 没有镜头表：按块长切 */ }
      seams = shotSeams(filmJson, { from, to });
      if (seams.length) ctx.log.info(`镜头切点（film.json）：${seams.join('、')}`);
    }
    const shards = planShards({ from, to, target, seams, block });
    // 用户给的目录只当父目录、绝不删除；每次运行在其下建独占子目录（不同任务共用 --work-dir 也互不覆盖），只清理带本次所有权标记的子目录
    const workBase = o['work-dir'] ? path.resolve(o['work-dir']) : os.tmpdir();
    fs.mkdirSync(workBase, { recursive: true });
    const workDir = fs.mkdtempSync(path.join(workBase, '.offscreen-farm-'));
    const owner = `${process.pid}-${path.basename(workDir)}`;
    fs.writeFileSync(path.join(workDir, OWNER_MARK), owner);
    const live = new Set();
    ctx.onCleanup(() => { for (const c of live) { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } } });

    const gop = block, timescale = fps * 512;
    const shardFile = (a, b) => path.join(workDir, `shard-${pad(a)}-${pad(b)}.mp4`);
    const argvFor = (a, b) => [OFFSCREEN_CLI, 'render', repoRel(file), '--out', shardFile(a, b), '--frames', `${a}:${b}`,
      '--size', `${width}x${height}`, '--fps', String(fps), '--inflight', String(inflight),
      '--mode', o.mode, '--encoder', o.encoder, ...(o['pix-fmt'] ? ['--pix-fmt', o['pix-fmt']] : []),
      '--crf', String(o.crf), '--cq', String(o.cq), '--preset', o.preset, ...(o.query ? ['--query', o.query] : []),
      '--gop', String(gop), '--timescale', String(timescale), '--frame-hashes', 'on', '--json'];
    const t0 = process.hrtime.bigint();
    ctx.out(`切片计划：${shards.length} 段 / ${slots} 槽位 / 块长上限 ${block}（${shards.map(([a, b]) => `${a}:${b}`).join('、')}）`);

    const results = await runShards({
      shards, slots, retries,
      onStart: ([a, b], attempt) => { if (attempt > 0) ctx.log.info(`重试切片 ${a}:${b}（第 ${attempt} 次）`); },
      runShard: async ([a, b], attempt) => {
        const f = shardFile(a, b);
        const r = await spawnNode(argvFor(a, b), { onSpawn: c => live.add(c), onExit: c => live.delete(c) });
        if (r.code !== 0 || !existsSafe(f)) {
          return { ok: false, from: a, to: b, file: f, error: { code: r.code === 3 ? 'env.shard' : 'failure.shard', message: `切片 ${a}:${b} 渲染失败（退出码 ${r.code}）：${tail3(r.stderr)}` } };
        }
        const env = parseEnvelope(r.stdout);
        if (!env?.ok) return { ok: false, from: a, to: b, file: f, error: { code: 'failure.shard', message: `切片 ${a}:${b} 没有成功信封：${tail3(r.stderr) || tail3(r.stdout)}` } };
        const d = env.data;
        if (d.frames !== b - a) return { ok: false, from: a, to: b, file: f, error: { code: 'contract.frame-count', message: `切片 ${a}:${b} 编出来是 ${d.frames} 帧，应为 ${b - a} 帧` } };
        return { ok: true, from: a, to: b, file: f, frames: d.frames, seconds: d.seconds, renderFps: d.renderFps,
          encode: { encoder: d.encoder, mode: d.mode, pixFmt: d.pixFmt, cq: d.cq ?? null }, adapter: d.adapter ?? null, sha256: sha256File(f), frameHashes: d.frameHashes ?? null };
      },
      onDone: r => { if (r.ok) ctx.log.info(`切片 ${r.from}:${r.to} 完成（${r.frames} 帧，${r.seconds}s${r.attempts > 1 ? `，重试 ${r.attempts - 1} 次` : ''}）`); else ctx.log.warn('failure.shard', r.error.message, null); },
    });

    const failed = results.filter(r => !r.ok);
    if (failed.length) {
      // 失败的块全是环境问题（子进程退出 3，如缺 FFmpeg / 可选依赖）时保留 env.* 类别 → 退出码 3，与帮助里的约定一致
      const envOnly = failed.every(r => String(r.error?.code).startsWith('env.'));
      throw new CliError(envOnly ? 'env.shards' : 'failure.shards',`${failed.length}/${results.length} 个切片失败（${failed.map(r => `${r.from}:${r.to}`).join('、')}）：${failed[0].error.message}`, {
        hint: `已完成的切片保留在 ${repoRel(workDir)}；单独重跑失败段：node engine/offscreen/cli.mjs render ${repoRel(file)} --out <切片文件> --frames ${failed[0].from}:${failed[0].to} <同参数>`,
      });
    }
    const first = results[0];
    for (const r of results) {
      const diff = ['encoder', 'pixFmt', 'mode'].filter(k => r.encode[k] !== first.encode[k]);
      if (diff.length || (r.encode.cq ?? null) !== (first.encode.cq ?? null)) {
        throw new CliError('contract.shard-encode-mismatch', `切片 ${r.from}:${r.to} 实际编码（${r.encode.encoder}/${r.encode.pixFmt}）与首片（${first.encode.encoder}/${first.encode.pixFmt}）不同，不能无损拼接`, { hint: '显式 --encoder x264 或 nvenc 固定编码器（缺卡回退会让各片不一致）' });
      }
    }

    const files = results.map(r => r.file);
    const merged = await mergeAndVerify({ files, out, from, to, fps, width, height, timescale, workDir });
    const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
    const ffLine = ffmpegVersionLine();
    if (!o.keep) removeOwnedDir(workDir, owner);
    ctx.out(`合并完成 ${repoRel(out)}  ${to - from} 帧（${from}–${to - 1}）  ${width}×${height} ${fps} fps  编码 ${first.encode.encoder}(${first.encode.pixFmt})  ${seconds.toFixed(1)}s（含传输与拼接，吞吐 ${((to - from) / seconds).toFixed(1)} 帧/秒）`);
    ctx.out(`核验：帧数精确 ✓  PTS 严格单调无空洞（步长 ${merged.verify.step}）✓  BT.709 标记完整 ✓  合并前后 framemd5 连续 ✓`);
    return {
      data: {
        work: repoRel(file), from, to, width, height, fps, slots, gop, timescale, seconds: +seconds.toFixed(2),
        workDir: o.keep ? repoRel(workDir) : null,
        shards: results.map(({ frameHashes, ...r }) => r),
        frameHashes: results.flatMap(r => r.frameHashes ?? []),
        verify: merged.verify,
        adapter: first.adapter,
        env: { node: process.version, ffmpeg: ffLine },
      },
      outputs: [{ path: out, sha256: sha256File(out), kind: 'video' }],
    };
  },
});

function existsSafe(p) { try { fs.accessSync(p); return true; } catch { return false; } }
// 只删本次运行建的子目录：所有权标记内容必须对得上，否则一个文件都不动
function removeOwnedDir(dir, owner) {
  let mark = null;
  try { mark = fs.readFileSync(path.join(dir, OWNER_MARK), 'utf8'); } catch { /* 没有标记：不删 */ }
  if (mark === owner) fs.rmSync(dir, { recursive: true, force: true });
}
function ffmpegVersionLine() {
  try { return String(spawnSync(FFMPEG(), ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 15000 }).stdout || '').split('\n')[0] || null; } catch { return null; }
}

if (isMain(import.meta.url)) runCli(command);
