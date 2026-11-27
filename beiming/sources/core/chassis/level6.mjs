#!/usr/bin/env node
// 北冥 · 对拍阶梯第 6 级：成品图的降噪接法与色彩链。两半各自判，各有自己的门（阈值文件 beiming/verify/floor-gate.json 的 math.level6）。
//   降噪一半
//     denoise   判。oidn-parity.mjs 的量法：同一个降噪器、同一份输入。本机 Blender 现搭小场景，Cycles 渲一帧存 Noisy Image、
//               Denoising Albedo、Denoising Normal 与它自己降噪后的 Combined；三层喂带 OIDN 的 core-render denoise（同设备、预过滤
//               ACCURATE、质量 HIGH），和 Combined 逐分量比：|差| ≤ denoise × max(1, |Combined|)。设备默认 CPU 加本机显卡
//               （macOS Metal，Linux CUDA）；两台机器各跑一遍。
//     features  只记不判。核心自己的降噪特征层（render-pack --passes 的 denoiseAlbedo、denoiseNormal）对参考包收敛图里 Cycles 的
//               Denoising Albedo、Denoising Normal：每个（场景包, 帧）一行，逐分量的平均绝对差、99 分位、最大，与差超过 0.01 的像素占比。
//               参考包的设置是 Blender 默认的「跟反射」与「按粗糙度加权」都开，核心两样都没有（条文 STRUCTURES.md「输出通道」），差就在这里。
//               要参考包根目录（--root 或 BEIMING_CORE_LADDER_ROOT），没有就不跑这一项。
//   色彩一半
//     color     判。AgX、外观 Medium High Contrast、显示 sRGB，两种做法各对 Blender 直出比：
//                 lut65  本机 Blender 现烘 65³ 表（comp/lut/bake-agx.mjs：对数整形加四面体插值，交付链现在用的就是它）
//                 chain  Blender 自带的 AgX 表加它的分配变换：OCIO 处理器（默认优化之后）的算子逐个照做，三维表读 Blender 自带的 .cube
//               浮点对 OCIO 处理器直算（另记它对 Blender 存的 16 位 PNG 差多少，说明直算就是 Blender 存图的那一条），8 位对 Blender 存的
//               8 位 PNG（关抖动）。样本：灰阶 0 到 16 每 1/8 档；三原色与三种二次色跨八档亮度，加三个混色；黄色折点一带每 1/4 档。
//               门：浮点最大绝对差 ≤ colorFloat，8 位最大级差 ≤ color8bit。判的是交付链真在用的那一种（DELIVERED，现在是 65³ 表）；
//               算子链只是候选，两种都记。交付链换不了算子链：锁契约的 lock.view 一个视图只钉一个哈希，算子链要钉三样文件，
//               要先改锁契约。所以 65³ 表不过、算子链过时报 blocked-on-contract，不算过。
//     isolation 判（负对照）。帧源出片链永不经 post.rs 的调色：在 out/ 下的源码副本里把 post::finish 的曝光乘 0.25 另编，
//               同一个场景包经 source.mjs 出一帧：color 层必须逐字节不变，预览 PNG 必须变（变了才说明改动生效）。
//   node beiming/sources/core/chassis/level6.mjs [--only denoise,features,color,isolation（几项用逗号连）] [--devices cpu,metal] [--root <参考包根目录>]
//       [--feature-spp 64] [--out 报告.json]
//   Blender 照 build.mjs 的 findBlender 找（BEIMING_BLENDER、macOS 的应用目录、PATH），一律后台（-b）、不出声（-noaudio）。
// 退出码：0 判的几项全过；4 有一项不过；3 缺 Blender、OIDN 库、工具链或参考包；2 用法错误。
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { CliError, defineCommand, isMain, runCli } from '../../../../tools/lib/cli.mjs';
import { agxChain, applyAgxChain, applyShaperAndLut, bakeAgxLut, parseCube, runBlenderJob } from '../../../comp/lut/bake-agx.mjs';
import { readExr } from '../../../verify/exr/exr.mjs';
import { THRESHOLDS } from '../../../verify/floorgate.mjs';
import { startSource } from '../source.mjs';
import { OUT, PRESETS, buildRenderer, findBlender, missing } from './build.mjs';
import { MATCH } from './level3.mjs';
import { runParity } from './oidn-parity.mjs';
import { platesPack, writePack } from './scenepack.mjs';

const WORK = path.join(OUT, 'level6');
export const LIMITS = THRESHOLDS.math.level6;
export const PARTS = ['denoise', 'features', 'color', 'isolation'];
/** 交付链（comp/deliver.mjs 读 lock.view 的一张 .cube）现在用的色彩做法；换了交付链才改这里 */
export const DELIVERED = 'lut65';
/** 交付链的做法不过、候选过：卡在锁契约，不算过 */
export const colorStatus = (methods) => (methods[DELIVERED].pass ? 'pass' : Object.values(methods).some((m) => m.pass) ? 'blocked-on-contract' : 'fail');
/** 本机显卡对应的 OIDN 设备 */
export const GPU_DEVICE = { darwin: 'metal', linux: 'cuda' };
/** 特征层差的「明显」线：反照率与法线分量都在 0 到 1 上下，0.01 是 8 位里两三级 */
export const FEATURE_OVER = 0.01;
/** 负对照：post::finish 的曝光乘 0.25（只动预览 PNG 那一路） */
export const POST_INJECT = [{ file: 'path/src/post.rs', from: 'px: img.px.iter().map(|c| *c * exposure).collect() };', to: 'px: img.px.iter().map(|c| *c * exposure * 0.25).collect() };' }];

const sha256 = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const readF32 = (file) => { const b = fs.readFileSync(file); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

// ---------- 色彩一半 ----------

/** 色彩链的样本：{ gray, saturated, knee }，每个是线性光 [r, g, b] 的数组 */
export function colorSamples() {
  const gray = [0, ...Array.from({ length: 81 }, (_, k) => 2 ** (-6 + k / 8))].map((v) => [v, v, v]);
  const primaries = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1]];
  const saturated = [[3.2, 0.8, 0.4], [0.05, 1, 0.3], [0.3, 0.05, 1], ...[0.125, 0.25, 0.5, 1, 2, 4, 8, 16].flatMap((v) => primaries.map((p) => p.map((c) => c * v)))];
  const knee = [[0.4, 0.4, 0], ...Array.from({ length: 33 }, (_, k) => 2 ** (-4 + k / 4)).map((v) => [v, v, 0])];
  return { gray, saturated, knee };
}

const to8 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255);

/**
 * 一组样本的读数：ours、refFloat、ref8 是同样长的 [r, g, b] 数组（ref8 是 8 位 PNG 读回的 0 到 1）。
 * 返回 { n, floatMaxAbs, worst: { rgb, channel, ours, ref }, levels8 }：levels8 是 ours 截到 0 到 1、乘 255 取整之后和 ref8 的最大级差。
 */
export function compareColor(values, ours, refFloat, ref8) {
  let floatMaxAbs = 0, levels8 = 0, worst = null;
  values.forEach((rgb, i) => {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(ours[i][c] - refFloat[i][c]);
      if (!(d <= floatMaxAbs)) { floatMaxAbs = Number.isNaN(d) ? Infinity : d; worst = { rgb, channel: 'RGB'[c], ours: ours[i][c], ref: refFloat[i][c] }; }
      levels8 = Math.max(levels8, Math.abs(to8(ours[i][c]) - Math.round(ref8[i][c] * 255)));
    }
  });
  return { n: values.length, floatMaxAbs, worst, levels8 };
}

/** 一种做法过不过：每组的浮点与 8 位都在门内 */
export const colorPass = (sets) => Object.values(sets).every((r) => r.floatMaxAbs <= LIMITS.colorFloat && r.levels8 <= LIMITS.color8bit);

export async function runColor({ blenderBin, log = () => {} }) {
  if (!blenderBin) throw missing('Blender（色彩一半要本机 Blender 的色彩配置与存图）');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-level6-color-'));
  try {
    const sets = colorSamples(), all = Object.values(sets).flat();
    const job = async (mode, extra = {}) => {
      const out = path.join(work, `${mode}-${extra.depth ?? 'f'}.json`);
      await runBlenderJob(blenderBin, { mode, values: all, outPath: out, ...extra });
      return JSON.parse(fs.readFileSync(out, 'utf8'));
    };
    log('色彩：Blender 直出（OCIO 直算、16 位与 8 位 PNG）');
    const ref = await job('ocio'), d16 = await job('direct', { depth: 16 }), d8 = await job('direct', { depth: 8 });
    let ocioVs16 = 0;
    ref.forEach((p, i) => p.forEach((v, c) => { ocioVs16 = Math.max(ocioVs16, Math.abs(v - d16[i][c])); }));
    log('色彩：烘 65³ 表，取 Blender 自带的算子链');
    const cube = path.join(work, 'agx-mhc.cube');
    const lutSha256 = await bakeAgxLut({ blenderBin, gridSize: 65, outPath: cube });
    const lut = parseCube(fs.readFileSync(cube, 'utf8'));
    const chain = await agxChain({ blenderBin, workDir: work });
    const judge = (fn) => {
      let at = 0;
      const out = {};
      for (const [name, values] of Object.entries(sets)) {
        const idx = values.map((_, k) => at + k);
        at += values.length;
        out[name] = compareColor(values, values.map(fn), idx.map((k) => ref[k]), idx.map((k) => d8[k]));
      }
      return { sets: out, pass: colorPass(out) };
    };
    const methods = { lut65: { ...judge((v) => applyShaperAndLut(v, lut)), lock: lutSha256 }, chain: { ...judge((v) => applyAgxChain(v, chain)), lock: chain.files } };
    const status = colorStatus(methods);
    return { blender: chain.blender, ocio: chain.ocio, view: { display: chain.display, view: chain.view, look: chain.look }, limits: { float: LIMITS.colorFloat, levels8: LIMITS.color8bit }, ocioVs16, methods, delivered: DELIVERED, candidate: 'chain', status, pass: status === 'pass' };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

/** 负对照：同一个场景包经帧源出一帧，正常的程序与 post.rs 改坏的程序各一遍，比 color 层与预览 PNG 的哈希 */
export async function runIsolation({ log = () => {} } = {}) {
  const plain = buildRenderer().bin;
  log('负对照：另编一份 post::finish 改坏的程序');
  const broken = buildRenderer({ inject: POST_INJECT }).bin;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-level6-iso-'));
  try {
    const dir = path.join(tmp, 'plates');
    writePack(dir, platesPack());
    const once = async (bin, name) => {
      const workspace = path.join(tmp, name);
      fs.mkdirSync(workspace);
      const src = await startSource({ bin });
      const input = { film: 'level6-isolation', output: { size: [64, 36], fps: '24/1' }, shot: { id: 's01', in: 0, out: 1, source: 'core', host: 'offscreen', mode: 'build-script', entry: dir, colorRef: 'scene', seed: 7, tiers: { draft: { samples: 8, scale: 1 } } } };
      const s = await src.open(input, { lock: null, tier: 'draft', workspace, filmDir: tmp });
      const r = await s.render(0, {}, ['color']);
      await s.close();
      const file = path.join(workspace, r.layers.color.file);
      return { color: sha256(fs.readFileSync(file)), preview: sha256(fs.readFileSync(path.join(path.dirname(file), 'preview.png'))) };
    };
    const a = await once(plain, 'plain'), b = await once(broken, 'broken');
    return { inject: POST_INJECT.map((x) => `${x.file}：${x.to.trim()}`), plain: a, broken: b, colorSame: a.color === b.color, previewChanged: a.preview !== b.preview, pass: a.color === b.color && a.preview !== b.preview };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- 降噪一半 ----------

export function runDenoise({ devices, log = () => {} }) {
  return devices.map((device) => {
    log(`降噪：${device}，预过滤 accurate`);
    const { record, line } = runParity({ device, prefilter: 'accurate' });
    log(line);
    const { maxAbs, maxRel, worst, pass, bitwiseEqual, noisyVsCombined, blender, oidn, kernel, platform } = record;
    return { device, platform, blender, oidn, kernel, maxAbs, maxRel, worst, bitwiseEqual, noisyVsCombined, limit: LIMITS.denoise, pass };
  });
}

/** 两张同样长的特征图（每像素三个分量）的差：{ meanAbs, p99Abs, maxAbs, over }；over 是任一分量差超过 FEATURE_OVER 的像素占比 */
export function featureDiff(core, ref) {
  if (core.length !== ref.length || core.length % 3) throw new Error(`特征层大小不同：${core.length} 与 ${ref.length}`);
  const d = new Float64Array(core.length);
  let sum = 0, over = 0;
  for (let i = 0; i < core.length; i++) { d[i] = Math.abs(core[i] - ref[i]); sum += d[i]; }
  for (let p = 0; p < core.length / 3; p++) if (Math.max(d[3 * p], d[3 * p + 1], d[3 * p + 2]) > FEATURE_OVER) over++;
  const sorted = [...d].sort((x, y) => x - y);
  return { meanAbs: sum / d.length, p99Abs: sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))], maxAbs: sorted.at(-1), over: over / (core.length / 3) };
}

/** 参考包根目录里的全部取值点按（场景包, 帧）归组：[{ pack, frame, size, ref }] */
export function featurePoints(root) {
  const file = path.join(root, 'coverage.json');
  if (!fs.existsSync(file)) throw missing(`参考包根目录 ${root} 里没有 coverage.json`);
  const by = new Map();
  for (const p of JSON.parse(fs.readFileSync(file, 'utf8')).points) {
    const pack = path.basename(p.scenePackDir), key = `${pack}#${p.frame}`;
    if (!by.has(key)) by.set(key, { pack, frame: p.frame, size: p.size, ref: p.ref });
  }
  return [...by.values()];
}

/** 核心出一帧的降噪特征层：{ albedo, normal }，RGB/XYZ 浮点、行主序 */
function renderFeatures(bin, packDir, { frame, size: [w, h], spp, override }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-level6-feat-'));
  try {
    const dir = path.join(tmp, 'passes');
    const r = spawnSync(bin, ['render-pack', packDir, '-o', path.join(tmp, 'o.png'), '--passes', dir, '--frame', String(frame), '--spp', String(spp),
      '--width', String(w), '--height', String(h), '--no-denoise', '--presets', PRESETS, '--override', JSON.stringify({ native: override })],
    { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, THREERT_SEED: '0' } });
    if (r.status !== 0) throw Object.assign(new Error(`render-pack ${path.basename(packDir)} 失败：${r.stderr.trim().split('\n').at(-1)}`), /adapter|GPU|显卡/i.test(r.stderr) ? { missing: 'GPU' } : {});
    return { albedo: readF32(path.join(dir, 'denoiseAlbedo.f32')), normal: readF32(path.join(dir, 'denoiseNormal.f32')) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function runFeatures({ root, spp, log = () => {} }) {
  const { bin } = buildRenderer();
  return featurePoints(root).map((g) => {
    const dir = path.join(root, 'refs', g.ref);
    const ref = JSON.parse(fs.readFileSync(path.join(dir, 'ref.json'), 'utf8'));
    const e = readExr(fs.readFileSync(path.join(dir, 'converged.exr')));
    const plane = (name, comps) => {
      const n = e.width * e.height, out = new Float32Array(3 * n);
      comps.forEach((c, j) => { const src = e.channels[`${name}.${c}`]; for (let i = 0; i < n; i++) out[3 * i + j] = src[i]; });
      return out;
    };
    log(`特征层：${g.pack} 第 ${g.frame} 帧`);
    const core = renderFeatures(bin, path.join(root, 'scene-packs', g.pack), { frame: g.frame, size: [e.width, e.height], spp, override: MATCH(ref) });
    return { pack: g.pack, frame: g.frame, size: [e.width, e.height], spp, refSamples: ref.converged?.samples ?? null,
      albedo: featureDiff(core.albedo, plane('denoiseAlbedo', ['R', 'G', 'B'])), normal: featureDiff(core.normal, plane('denoiseNormal', ['X', 'Y', 'Z'])) };
  });
}

// ---------- 合起来 ----------

export async function runLevel6({ only, devices, root, featureSpp = 64, log = () => {} }) {
  const want = (p) => !only || only.includes(p);
  const report = { format: 'beiming.core.level6/1', limits: { ...LIMITS }, platform: `${process.platform}-${process.arch}` };
  if (want('denoise')) report.denoise = runDenoise({ devices, log });
  if (want('features')) report.features = root ? runFeatures({ root, spp: featureSpp, log }) : { skipped: '没给参考包根目录' };
  if (want('color')) report.color = await runColor({ blenderBin: findBlender(), log });
  if (want('isolation')) report.isolation = await runIsolation({ log });
  report.denoiseHalf = report.denoise ? { pass: report.denoise.every((r) => r.pass) } : null;
  report.colorHalf = report.color || report.isolation ? { status: report.color?.status ?? null, pass: (report.color?.pass ?? true) && (report.isolation?.pass ?? true) } : null;
  report.ok = [report.denoiseHalf, report.colorHalf].every((h) => h === null || h.pass);
  return report;
}

const e3 = (x) => (x === null || x === undefined ? '—' : x.toExponential(3));

export const command = defineCommand({
  name: 'chassis-level6',
  summary: '对拍阶梯第 6 级：降噪接法（同一降噪器同一输入）与色彩链（AgX 对 Blender 直出），两半各自判',
  usage: ['node beiming/sources/core/chassis/level6.mjs [--only denoise,features,color,isolation] [--devices cpu,metal] [--root <参考包根目录>] [--feature-spp 64] [--out 报告.json]'],
  options: {
    only: { type: 'string', arg: '<项,…>', describe: '只跑这几项（逗号连）：denoise、features、color、isolation' },
    devices: { type: 'string', arg: '<设备,…>', describe: '降噪对拍的设备（cpu、cuda、metal），默认 CPU 加本机显卡' },
    root: { type: 'string', arg: '<目录>', describe: '参考包根目录（特征层对比用）；默认读 BEIMING_CORE_LADDER_ROOT' },
    'feature-spp': { type: 'string', arg: '<N>', describe: '特征层对比时核心每像素的采样数（默认 64）' },
    out: { type: 'string', arg: '<文件>', describe: '报告写到哪里（默认 out/chassis/level6/report.json）' },
  },
  exitCodes: { 0: '判的几项全过', 2: '用法错误', 3: '缺 Blender、OIDN 库、工具链或参考包', 4: '有一项不过' },
  async run(ctx) {
    const only = ctx.opts.only?.split(',');
    if (only?.some((p) => !PARTS.includes(p))) throw new CliError('usage.bad-argument', `--only 只认 ${PARTS.join('、')}`);
    const devices = (ctx.opts.devices ?? ['cpu', GPU_DEVICE[process.platform]].filter(Boolean).join(',')).split(',');
    if (devices.some((d) => !['cpu', 'cuda', 'metal'].includes(d))) throw new CliError('usage.bad-argument', '--devices 只认 cpu、cuda、metal');
    const featureSpp = Number(ctx.opts['feature-spp'] ?? 64);
    if (!Number.isInteger(featureSpp) || featureSpp <= 0) throw new CliError('usage.bad-argument', '--feature-spp 要正整数');
    let report;
    try {
      report = await runLevel6({ only, devices, root: ctx.opts.root ?? process.env.BEIMING_CORE_LADDER_ROOT, featureSpp, log: (s) => ctx.log.info(s) });
    } catch (e) {
      if (e.missing || e.exit === 3 || e.code === 'env.missing-tool') throw new CliError('env.chassis-toolchain', `缺：${e.missing ?? e.message}`, '要本机 Blender（与 oidn-lock.json 对得上的 OIDN 库）、cargo 与能跑 wgpu 的显卡；参考包由标准答案机出，不在仓库里');
      throw e;
    }
    const file = path.resolve(ctx.opts.out ?? path.join(WORK, 'report.json'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    for (const r of report.denoise ?? []) ctx.out(`${r.pass ? '✓' : '✗'} 降噪 ${r.platform} ${r.device}：最大绝对差 ${e3(r.maxAbs)}，最大相对差 ${e3(r.maxRel)}，判据比值 ${r.worst.ratio?.toFixed(4)}（门 ${r.limit}）${r.bitwiseEqual ? '，逐位相同' : ''}`);
    for (const r of Array.isArray(report.features) ? report.features : []) ctx.out(`· 特征层 ${r.pack}#${r.frame}：反照率平均 ${e3(r.albedo.meanAbs)}、最大 ${e3(r.albedo.maxAbs)}、超 ${FEATURE_OVER} 的像素 ${(100 * r.albedo.over).toFixed(2)}%；法线平均 ${e3(r.normal.meanAbs)}、最大 ${e3(r.normal.maxAbs)}、超 ${FEATURE_OVER} 的像素 ${(100 * r.normal.over).toFixed(2)}%（只记）`);
    if (report.color) {
      for (const [name, m] of Object.entries(report.color.methods)) {
        const sets = Object.entries(m.sets).map(([k, r]) => `${k} 浮点 ${e3(r.floatMaxAbs)}、8 位 ${r.levels8} 级`).join('；');
        ctx.out(`${m.pass ? '✓' : '✗'} 色彩 ${name}${report.color.delivered === name ? '（交付链）' : '（候选，交付链没接）'}：${sets}（门 浮点 ${LIMITS.colorFloat}、8 位 ${LIMITS.color8bit} 级）`);
      }
      ctx.out(`· OCIO 直算对 Blender 存的 16 位 PNG：最大差 ${e3(report.color.ocioVs16)}（Blender ${report.color.blender}，OCIO ${report.color.ocio}）`);
    }
    if (report.isolation) ctx.out(`${report.isolation.pass ? '✓' : '✗'} 负对照 帧源出片链不经 post.rs：color 层${report.isolation.colorSame ? '逐字节不变' : '变了'}，预览 PNG ${report.isolation.previewChanged ? '变了' : '没变（改动没生效）'}`);
    ctx.out(`降噪一半：${report.denoiseHalf ? (report.denoiseHalf.pass ? '过' : '不过') : '没跑'}；色彩一半：${report.colorHalf ? (report.colorHalf.pass ? '过' : report.colorHalf.status === 'blocked-on-contract' ? '不过（交付链的 65³ 表不过门，候选的算子链过，换链要先改锁契约）' : '不过') : '没跑'}`);
    ctx.out(`报告：${file}`);
    return { data: report, outputs: [{ path: file, kind: 'report' }], ...(!report.ok && { error: { code: 'contract.chassis-level6', message: '第 6 级有不过的项', hint: `明细见 ${file}` } }) };
  },
});

if (isMain(import.meta.url)) await runCli(command);
