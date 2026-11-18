#!/usr/bin/env node
// 北冥仓库 · 离屏出片 · 预览对拍（质量门）：同一个作品模块，在 Chrome 的 WebGPU 里（预览，lab/offscreen/index.html）与 Node + Dawn 里（出片）
// 各渲同几帧，逐帧比像素，按 docs/offscreen/README.md 第 4 节的门槛判定：PSNR ≥ 50 dB，且差 5 级以上的像素 ≤ 0.1%。
//   node tools/offscreen/compare.mjs <作品.mjs> [--frames 0,14,40] [--size 960x540] [--fps 24] [--min-psnr 50] [--max-big 0.001] [--json]
// 预览用页面渲染器同一个无头浏览器与同一份启动参数，只在后面追加 WebGPU 开关（WEBGPU_ARGS），不改页面渲染器的参数。
// 静态服务用 engine/render/lib/server.mjs（只监听 127.0.0.1，只给仓库与 node_modules 里的文件）。
// 退出码：0 全部通过 · 2 用法错误 · 3 缺依赖或拿不到 WebGPU 适配器 · 4 有帧没过门槛 · 1 渲染失败。
// 信封 data：{ frames: [{ f, ok, identical, psnr, maxDelta, differFraction, bigFraction, reasons }], gate, size, adapter, browser }
//   （psnr 为 null 表示两边逐字节相同）
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli, usageError } from '../lib/cli.mjs';
import { createServer } from '../../engine/render/lib/server.mjs';
import { chromeArgs, chromeExecutable, defaultAngle } from '../../engine/render/lib/gpu.mjs';
import { loadGpu } from '../../engine/offscreen/load.mjs';
import { createHost } from '../../engine/offscreen/host.mjs';
import { resolveWork, parseSize } from '../../engine/offscreen/cli.mjs';
import { diffRgba, meetsGate } from '../../engine/offscreen/diff.mjs';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
/** 无头浏览器拿 WebGPU 适配器要的开关（只用于预览与对拍） */
export const WEBGPU_ARGS = Object.freeze(['--enable-unsafe-webgpu', ...(process.platform === 'linux' ? ['--enable-features=Vulkan'] : [])]);

export function parseFrames(s) {
  const parts = String(s ?? '').split(',').map(x => x.trim());
  if (!parts.length || parts.some(x => !/^\d+$/.test(x))) throw usageError('bad-value', `--frames 要写成逗号分隔的帧号，收到「${s}」`, '例如 --frames 0,14,40');
  return parts.map(Number);
}

/** 在预览页里渲这些帧，返回每帧的 RGBA Buffer */
async function previewFrames({ rel, width, height, fps, frames, query, ctx }) {
  const srv = createServer({ root: ROOT });
  const { url } = await srv.listen(0);
  let browser = null;
  const close = async () => { await browser?.close().catch(() => {}); await srv.close(); };
  const undo = ctx.onCleanup(close);
  try {
    const { chromium } = await import('playwright-core');
    try {
      browser = await chromium.launch({ executablePath: chromeExecutable(), args: [...chromeArgs(defaultAngle()), ...WEBGPU_ARGS] });
    } catch (e) {
      // 没装浏览器是环境问题（CI 的 windows-paths 任务就不装），退出码 3，其余启动错误原样抛
      if (/Executable doesn't exist|browserType\.launch/i.test(String(e?.message ?? e))) {
        throw new CliError('env.browser', `无头浏览器起不来：${String(e?.message ?? e).split('\n')[0]}`, { hint: 'npm run setup（或 npx playwright-core install chromium-headless-shell）；BEIMING_CHROME 可指定浏览器', cause: e });
      }
      throw e;
    }
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e?.message ?? e)));
    const qSuffix = query ? `&q=${encodeURIComponent(query)}` : '';
    await page.goto(`${url}lab/offscreen/index.html?work=/${encodeURI(rel)}&size=${width}x${height}&fps=${fps}&api=1${qSuffix}`);
    await page.waitForFunction(() => window.READY === true, null, { timeout: 60000 });
    const err = (await page.evaluate(() => window.PREVIEW_ERROR ?? null)) ?? pageErrors[0] ?? null;
    if (err) {
      if (/WebGPU|adapter/i.test(err)) throw new CliError('env.webgpu-unavailable', `预览页拿不到 WebGPU：${err}`, { hint: `无头浏览器要带 ${WEBGPU_ARGS.join(' ')}；node tools/rtx/gpucheck.mjs 看浏览器落在哪块 GPU` });
      throw new CliError('failure.preview', `预览页出错：${err}`, { hint: '在浏览器里打开 lab/offscreen/index.html?work=… 看控制台' });
    }
    const out = [];
    for (const f of frames) {
      const b64 = await page.evaluate(async f => { const { host, work } = window.offscreen; return (await host.renderFrame(work, f)).toBase64(); }, f);
      out.push(Buffer.from(b64, 'base64'));
    }
    return { pixels: out, browser: browser.version() };
  } finally {
    await close();
    undo();
  }
}

export const command = defineCommand({
  name: 'offscreen-compare',
  summary: '离屏出片的预览对拍：同一作品在 Chrome WebGPU 与 Node + Dawn 里各渲几帧，逐帧比像素、过质量门',
  usage: ['node tools/offscreen/compare.mjs <作品.mjs> [--frames 0,14,40] [--size 960x540] [--fps 24] [--min-psnr 50] [--max-big 0.001] [--json]'],
  positionals: [{ name: 'work', label: '<作品.mjs>', describe: '作品模块（仓库内）', required: true }],
  options: {
    frames: { type: 'string', default: '0,14,40', arg: '<f,f,…>', describe: '要比的帧号（默认 0,14,40）' },
    size: { type: 'string', default: '960x540', arg: '<WxH>', describe: '画幅（默认 960x540）' },
    fps: { type: 'integer', default: 24, arg: '<n>', describe: '帧率（默认 24）' },
    query: { type: 'string', default: '', arg: '<k=v&…>', describe: '传给两边作品 build({ query }) 的查询参数（如 msaa=0&notext=1）' },
    'min-psnr': { type: 'number', default: 50, arg: '<dB>', describe: 'PSNR 下限（默认 50）' },
    'max-big': { type: 'number', default: 0.001, arg: '<比例>', describe: '差 5 级以上的像素占比上限（默认 0.001 = 0.1%）' },
  },
  exitCodes: { 0: '全部帧过门槛', 1: '渲染失败', 2: '用法错误', 3: '缺依赖或拿不到 WebGPU 适配器', 4: '有帧没过门槛' },
  examples: ['node tools/offscreen/compare.mjs lab/offscreen/ink.mjs', 'node tools/offscreen/compare.mjs films/chendu/offscreen.mjs --frames 0,48,72 --query msaa=0&notext=1'],
  async run(ctx) {
    const file = resolveWork(ctx.args.work);
    const [width, height] = parseSize(ctx.opts.size);
    const frames = parseFrames(ctx.opts.frames);
    const fps = ctx.opts.fps, query = ctx.opts.query || '', gate = { minPsnr: ctx.opts['min-psnr'], maxBigFraction: ctx.opts['max-big'] };
    const rel = path.relative(ROOT, file).split(path.sep).join('/');

    const host = await createHost({ gpu: await loadGpu(), width, height, fps, query });
    const info = host.device.adapterInfo ?? {};
    const adapter = { vendor: info.vendor ?? null, architecture: info.architecture ?? null, description: info.description ?? null };
    const dawnSoft = /swiftshader|llvmpipe|lavapipe|microsoft basic render|\bwarp\b/i.test(`${adapter.vendor} ${adapter.description}`);
    if (defaultAngle() === 'swiftshader' && !dawnSoft) {
      host.dispose();
      throw new CliError('env.software-angle', 'BEIMING_ANGLE=swiftshader 强制浏览器走软件光栅，无法与 Dawn 硬件 GPU 做同卡对拍', { hint: '取消 BEIMING_ANGLE=swiftshader 后重跑对拍' });
    }
    const offscreen = [];
    try {
      const work = await host.load(file);
      for (const f of frames) offscreen.push(Buffer.from(await host.renderFrame(work, f)));
    } finally { host.dispose(); }

    const preview = await previewFrames({ rel, width, height, fps, frames, query, ctx });
    const rows = frames.map((f, i) => {
      const s = diffRgba(preview.pixels[i], offscreen[i], { width, height });
      const g = meetsGate(s, gate);
      return {
        f, ok: g.ok, identical: s.identical, psnr: Number.isFinite(s.psnr) ? +s.psnr.toFixed(2) : null, maxDelta: s.maxDelta,
        differFraction: +(s.differPixels / s.pixels).toFixed(6), bigFraction: +(s.bigPixels / s.pixels).toFixed(6), reasons: g.reasons,
      };
    });
    for (const r of rows) ctx.out(`第 ${r.f} 帧  ${r.ok ? '通过' : '不通过'}  ${r.identical ? '逐字节相同' : `PSNR ${r.psnr} dB，不同像素 ${(r.differFraction * 100).toFixed(2)}%，差 5 级以上 ${(r.bigFraction * 100).toFixed(3)}%，最大差 ${r.maxDelta}`}${r.reasons.length ? `（${r.reasons.join('；')}）` : ''}`);
    const data = { work: rel, size: `${width}x${height}`, fps, gate, adapter, browser: preview.browser, frames: rows };
    const bad = rows.filter(r => !r.ok);
    if (bad.length) {
      return { data, error: new CliError('contract.offscreen-gate', `${bad.length}/${rows.length} 帧没过质量门：${bad.map(r => `第 ${r.f} 帧 ${r.reasons.join('；')}`).join('｜')}`, { hint: '先在预览页看这几帧；差异集中在后期或模糊时，查作品是否用了随帧变化的随机数或依赖浏览器时钟' }) };
    }
    return { data };
  },
});

if (isMain(import.meta.url)) runCli(command);
