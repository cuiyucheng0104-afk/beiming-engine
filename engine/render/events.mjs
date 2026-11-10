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
// 退出码：0 成功；1 页面报错（脚本 / 文档 404、未捕获异常、等 READY 超时）；2 用法错误或找不到页面；
//         4 页面契约不满足（没有 render 函数、DUR 不是有限正数、EV 不是数组）。--help 只打印用法、不启动浏览器。出错只打一行原因。
import fs from 'node:fs';
import path from 'node:path';

const USAGE = `用法：node engine/render/events.mjs <影片目录> [--size 1920x1040] [--query k=v] [--out <目录>] [--probe <probe.json>] [--no-events] [--json]
  导出 window.EV → events.json、window.TIMELINE → timeline.json；--probe 写页面契约探测结果；--json 把结果以一个 JSON 对象打到 stdout`;
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(0); }

const VALUED = new Set(['--size', '--query', '--out', '--probe']);
const FLAGS = new Set(['--no-events', '--json']);
const opt = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUED.has(a)) { if (args[i + 1] === undefined) { console.error(`${a} 后面要跟一个值\n${USAGE}`); process.exit(2); } opt[a] = args[++i]; }
  else if (FLAGS.has(a)) opt[a] = true;
  else if (a.startsWith('-')) { console.error(`不认识的选项 ${a}\n${USAGE}`); process.exit(2); }
  else pos.push(a);
}
if (pos.length !== 1) { console.error(USAGE); process.exit(2); }
const dir = pos[0];
const sm = /^(\d+)x(\d+)$/.exec(opt['--size'] || '1920x1040');
if (!sm || +sm[1] % 2 || +sm[2] % 2 || +sm[1] < 16 || +sm[2] < 16) { console.error('--size 要写成 WxH，且宽高都是 ≥16 的偶数，例如 1920x1080'); process.exit(2); }
const w = +sm[1], h = +sm[2];
const outDir = path.resolve(opt['--out'] || dir), query = opt['--query'] || '';

// 页面服务与浏览器由 page.mjs 提供；动态导入，保证 --help 与用法错误不启动任何东西
const { openFilm, closeServer } = await import('./page.mjs');
let film = null, info, gpu = null;
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
  // 页面错误、缺文件、等 READY 超时、找不到页面：一行原因 + 退出码（page.mjs 的 FilmError 自带建议的退出码）
  console.error(`events.mjs：${String(e?.message || e).split('\n')[0]}`);
  await film?.close?.();
  await closeServer().catch(() => {});
  process.exit(Number.isInteger(e?.exitCode) ? e.exitCode : 1);
}
await film.close();
await closeServer();

const problems = [];
if (!info.hasRender) problems.push('window.render 不是函数');
if (!(typeof info.dur === 'number' && Number.isFinite(info.dur) && info.dur > 0)) problems.push(`window.DUR 应为有限正数，现在是 ${JSON.stringify(info.dur)}`);
if (!Array.isArray(info.ev.ev)) problems.push('window.EV 应为数组');
if (info.fpsRaw !== null && info.fpsDeclared === null) problems.push(`window.FPS 应为正数，现在是 ${info.fpsRaw}`);
const { isSoftwareRenderer } = await import('./page.mjs');
const probe = {
  dur: info.dur, hasRender: info.hasRender, hasTexts: info.hasTexts, texts0: info.texts0,
  evCount: Array.isArray(info.ev.ev) ? info.ev.ev.length : null, hasTimeline: !!info.tl,
  fps: info.fpsDeclared ?? info.timelineFps, fpsDeclared: info.fpsDeclared, timelineFps: info.timelineFps, renderFps: info.fpsDeclared ?? 24,
  contract: info.contract, gpu: gpu || null, software: isSoftwareRenderer(gpu), title: info.title, problems,
};
if (opt['--probe']) { fs.mkdirSync(path.dirname(path.resolve(opt['--probe'])), { recursive: true }); fs.writeFileSync(path.resolve(opt['--probe']), JSON.stringify(probe, null, 1)); }

const written = [];
if (!problems.length && !opt['--no-events']) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(info.ev));
  written.push(path.join(outDir, 'events.json'));
  if (info.tl) { fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(info.tl, null, 1)); written.push(path.join(outDir, 'timeline.json')); }
}
if (opt['--json']) process.stdout.write(JSON.stringify({ ok: !problems.length, exitCode: problems.length ? 4 : 0, command: 'events', probe, outputs: written }) + '\n');
else if (!problems.length) {
  console.error(`events.json  ${probe.evCount} 条  dur ${probe.dur}${opt['--no-events'] ? '（--no-events：未写文件）' : ''}`);
  if (info.tl) console.error(`timeline.json  ${(info.tl.secs || []).length} 段  ${Object.keys(info.tl.cues || {}).length} 个打点`);
}
if (problems.length) { console.error(`页面约定不满足：${problems.join('；')}（见 engine/render/page.mjs 开头的页面约定）`); process.exit(4); }
