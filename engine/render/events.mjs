#!/usr/bin/env node
// 北冥引擎 · 导出声画事件表，并探测页面约定：打开影片页面（等 window.READY），把 window.EV 写成 events.json，
// 页面有 window.TIMELINE 时再写 timeline.json；--probe 另写一份页面契约探测结果（JSON），供 tools/film 在出片前把关。
// A 北冥风格路线 · WebGL 三渲二与 C 北冥代码动画风格 · 86 式的页面都用它（页面约定见 engine/render/page.mjs 开头，加固计划附录 C5）。
//   node engine/render/events.mjs <影片目录> [--size 1920x1040] [--query k=v] [--out <目录>] [--probe <probe.json>] [--no-events] [--json]
// events.json  = { dur: window.DUR, ev: window.EV || [] }（紧凑 JSON）
// timeline.json = window.TIMELINE 原样（缩进 1），一般是 { ...tempo.toJSON(), dur, cues, t }，给 mix.py 与 cuecheck 读
// probe.json   = { dur, hasRender, hasTexts, texts0, evCount, hasTimeline, fps, fpsDeclared, timelineFps, renderFps, contract, gpu, software, title, problems }
//   fpsDeclared = window.FPS（没声明为 null）；timelineFps = TIMELINE.fps；renderFps = video.mjs 量化用的页面帧率（window.FPS，没声明按 24）
//   fps = fpsDeclared ?? timelineFps（旧字段，保留兼容）；contract = window.BEIMING_CONTRACT（缺省 1）
// 默认写进影片目录本身；--out 换目录（tools/film 写进运行目录，不碰作品源码），--no-events 只探测不写事件表。
// 事件表由页面在加载时算好（engine/core/tempo.js 的 createEvents），这里不调用 render(t)，不渲帧。
// 参数、--help（无副作用、不启动浏览器）、--json 信封与退出码按命令约定库 tools/lib/cli.mjs（docs/CLI.md）：
//   0 成功；1 页面报错（脚本 / 文档 404、未捕获异常、等 READY 超时）；2 用法错误或找不到页面；4 页面契约不满足
//   （没有 render 函数、DUR 不是有限正数、EV 不是数组）。--json 时 data = { probe, written }。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli } from '../../tools/lib/cli.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRel = p => path.relative(REPO, p).split(path.sep).join('/');   // 信封里的路径：仓库相对、正斜杠（docs/CLI.md 第 2 节）

export const command = defineCommand({
  name: 'c:events',
  summary: '导出页面的声画事件表（window.EV → events.json、window.TIMELINE → timeline.json），并探测页面约定',
  usage: ['node engine/render/events.mjs <影片目录> [--size 1920x1040] [--query k=v] [--out <目录>] [--probe <probe.json>] [--no-events] [--json]'],
  description: [
    '打开影片页面、等 window.READY，不调用 render(t)、不渲帧。页面约定见 engine/render/page.mjs 开头（附录 C5）。',
    '出片时由 npm run film -- build 的 probe 步骤调用（写进运行目录，不碰作品源码）；单独用时默认写进影片目录本身。',
  ],
  positionals: [{ name: 'dir', label: '<影片目录>', describe: '含 index.html 的页面目录（作品目录，或《北冥》样片的仓库根 .）' }],
  options: {
    size: { type: 'string', arg: '<宽x高>', default: '1920x1040', describe: '页面画幅（偶数，默认 1920x1040）' },
    query: { type: 'string', arg: '<k=v>', default: '', describe: '原样传给页面的查询串' },
    out: { type: 'string', arg: '<目录>', describe: 'events.json / timeline.json 写到哪个目录（默认影片目录）' },
    probe: { type: 'string', arg: '<probe.json>', describe: '另写一份页面契约探测结果' },
    'no-events': { type: 'boolean', describe: '只探测，不写事件表' },
  },
  examples: ['node engine/render/events.mjs films/my-film --out /tmp/ev --probe /tmp/ev/probe.json'],
  exitCodes: { 0: '成功', 1: '页面报错（脚本或文档 404、未捕获异常、等 READY 超时）', 2: '用法错误或找不到页面', 4: '页面契约不满足' },
  async run(ctx) {
    const dir = ctx.args.dir;
    const sm = /^(\d+)x(\d+)$/.exec(ctx.opts.size);
    if (!sm || +sm[1] % 2 || +sm[2] % 2 || +sm[1] < 16 || +sm[2] < 16) throw new CliError('usage.bad-value', `--size 要写成 宽x高，且宽高都是 ≥16 的偶数，收到「${ctx.opts.size}」`, { hint: '例如 --size 1920x1080' });
    const w = +sm[1], h = +sm[2];
    const outDir = path.resolve(ctx.opts.out || dir), query = ctx.opts.query || '';

    // 页面服务与浏览器由 page.mjs 提供；动态导入，保证 --help 与用法错误不启动任何东西
    const { openFilm, closeServer, isSoftwareRenderer } = await import('./page.mjs');
    let film = null, info, gpu = null;
    const shut = async () => { await film?.close?.().catch(() => {}); await closeServer().catch(() => {}); };
    ctx.onCleanup(shut);
    try {
      film = await openFilm(dir, { w, h, query });
      gpu = film.gpu;
      info = await film.page.evaluate(() => {
        const tl = window.TIMELINE || null;
        let texts0 = null;
        try { texts0 = typeof window.TEXTS === 'function' ? (window.TEXTS(0) || []).length : null; } catch { texts0 = 'error'; }
        const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
        return {
          ev: { dur: window.DUR, ev: window.EV || [] }, tl,
          dur: window.DUR, hasRender: typeof window.render === 'function', hasTexts: typeof window.TEXTS === 'function', texts0,
          fpsDeclared: num(window.FPS), fpsRaw: window.FPS === undefined ? null : String(window.FPS), timelineFps: tl ? num(tl.fps) : null,
          contract: window.BEIMING_CONTRACT ?? 1, title: document.title || null,
        };
      });
      film.check();
    } catch (e) {
      // 页面错误、缺文件、等 READY 超时、找不到页面：一行原因 + 退出码（page.mjs 的错误自带建议的退出码）
      await shut();
      const code = Number.isInteger(e?.exitCode) ? e.exitCode : 1;
      throw new CliError(code === 2 ? 'usage.page' : code === 4 ? 'contract.page' : code === 3 ? 'env.page' : 'failure.page', String(e?.message || e).split('\n')[0], { hint: '先单独打开页面看控制台报错（npm run serve 或浏览器开 index.html）', exitCode: code });
    }
    await shut();

    const problems = [];
    if (!info.hasRender) problems.push('window.render 不是函数');
    if (!(typeof info.dur === 'number' && Number.isFinite(info.dur) && info.dur > 0)) problems.push(`window.DUR 应为有限正数，现在是 ${JSON.stringify(info.dur)}`);
    if (!Array.isArray(info.ev.ev)) problems.push('window.EV 应为数组');
    if (info.fpsRaw !== null && info.fpsDeclared === null) problems.push(`window.FPS 应为正数，现在是 ${info.fpsRaw}`);
    const probe = {
      dur: info.dur, hasRender: info.hasRender, hasTexts: info.hasTexts, texts0: info.texts0,
      evCount: Array.isArray(info.ev.ev) ? info.ev.ev.length : null, hasTimeline: !!info.tl,
      fps: info.fpsDeclared ?? info.timelineFps, fpsDeclared: info.fpsDeclared, timelineFps: info.timelineFps, renderFps: info.fpsDeclared ?? 24,
      contract: info.contract, gpu: gpu || null, software: isSoftwareRenderer(gpu), title: info.title, problems,
    };
    const written = [];
    if (ctx.opts.probe) {
      const pf = path.resolve(ctx.opts.probe);
      fs.mkdirSync(path.dirname(pf), { recursive: true });
      fs.writeFileSync(pf, JSON.stringify(probe, null, 1));
    }
    if (!problems.length && !ctx.opts['no-events']) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(info.ev));
      written.push(path.join(outDir, 'events.json'));
      if (info.tl) { fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(info.tl, null, 1)); written.push(path.join(outDir, 'timeline.json')); }
    }
    const outputs = written.map(f => ({ path: repoRel(f), sha256: null, kind: path.basename(f, '.json') }));
    if (problems.length) {
      return { exitCode: 4, error: { code: 'contract.page-contract', message: `页面约定不满足：${problems.join('；')}`, hint: '见 engine/render/page.mjs 开头的页面约定（附录 C5）' }, outputs, data: { probe, written: outputs.map(o => o.path) } };
    }
    ctx.log.info(`events.json  ${probe.evCount} 条  dur ${probe.dur}${ctx.opts['no-events'] ? '（--no-events：未写文件）' : ''}`);
    if (info.tl) ctx.log.info(`timeline.json  ${(info.tl.secs || []).length} 段  ${Object.keys(info.tl.cues || {}).length} 个打点`);
    return { outputs, data: { probe, written: outputs.map(o => o.path) } };
  },
});

if (isMain(import.meta.url)) await runCli(command);
