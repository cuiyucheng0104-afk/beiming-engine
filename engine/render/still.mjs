// 北冥引擎 · 渲静帧（渲染器 v2，规格见 engine/render/README.md）
//   node engine/render/still.mjs <影片目录> <t> [<t> ...] [--range a:b:step]            按秒取时（样张、联系表；默认 JPEG q92）
//   node engine/render/still.mjs <影片目录> --frame 0,72,239 | --frames a:b[:step] [--fps 24]   按整数帧取（QA、金标准；默认无损 PNG）
//   其余：[--size WxH | --profile 档位] [--query k=v] [--out out/stills] [--prefix s_] [--format png|jpeg] [--texts] [--json] …   完整选项：--help
// 按秒：--range 按整数下标生成 a、a+step、…（≤ b），不累加浮点误差，按算出的时刻原值渲；文件名里的时刻能用两位小数精确表示时写
//   两位（s_0.50.jpg），否则写到能精确表示的位数（s_0.0416667.jpg）；直接写的时刻，文件名照写法保留（9.95 → s_9.95.jpg）。
// 按帧：t = 帧号 / fps，文件名 <前缀>f000072.png（帧号补 6 位）；fps 默认按档位 / film.json / 页面的 window.FPS，再默认 24，
//   与页面声明的帧率不一致退出码 4（--any-fps 放行）。这样取的帧与 video.mjs 第 N 帧是同一时刻。
// 步长为 0 / 负数 / 漏写、时刻不是数字、不认识的选项都直接报错退出（码 2），不会死循环或乱出图。
// 每张先写 <名>.partial 再改名；页面报错、着色器错误、上下文丢失时这一张不保留，以约定的非零码退出。输出目录旁写运行记录。
// --texts：每张截完图再读一次 window.TEXTS(t)（页面约定 v1 推荐的文字报告），连同形状核对写进运行记录；
//   默认不读——TEXTS 若有副作用，会改变后面几张的画面。
import fs from 'node:fs';
import path from 'node:path';
import { isMain, runCli } from '../../tools/lib/cli.mjs';
import { openFilm, locateFilm, renderFrame, closeServer, ROOT } from './page.mjs';
import { parseTime, rangeTimes } from './args.mjs';
import { RenderError } from './lib/errors.mjs';
import { renderCommand, pickOptions, parseFrames, positiveNumber } from './lib/command.mjs';
import { resolveAngle, resolveGpuPolicy } from './lib/gpu.mjs';
import { acquireLock } from './lib/lock.mjs';
import { environment, baseRecord, writeRecord, sha256, repoPath, selfCheck } from './lib/record.mjs';
import { readFilm } from './lib/film.mjs';
import { checkTexts } from './lib/contract.mjs';
import { resolveOutputSpec, decideFps } from './video.mjs';

export const command = renderCommand({
  name: 'engine/render/still.mjs',
  summary: '渲几张静帧：按秒（位置参数、--range）用于样张与联系表，按整数帧（--frame / --frames）用于 QA 与金标准',
  usage: ['node engine/render/still.mjs <影片目录> [<t> ...] [--range a:b:step] [--frame 0,72 | --frames a:b[:step]] [选项]'],
  positionals: [
    { name: 'dir', label: '<影片目录>', describe: '仓库内的影片目录（《北冥》样片是 .）' },
    { name: 'times', label: '[<t> ...]', describe: '时刻（秒），可写多个', variadic: true, required: false },
  ],
  options: {
    range: { type: 'string', arg: 'a:b:step', describe: '按秒：a、a+step、…（≤ b）' },
    frame: { type: 'list', split: ',', arg: 'N[,N…]', describe: '按整数帧：逗号分隔的帧号（可重复）' },
    frames: { type: 'string', arg: 'a:b[:step]', describe: '按整数帧：第 a 到 b−1 帧，可隔 step 帧取一张' },
    ...pickOptions(['fps', 'any-fps', 'profile', 'size', 'query']),
    out: { type: 'string', default: 'out/stills', arg: '<目录>', describe: '输出目录（默认 out/stills）' },
    prefix: { type: 'string', arg: '<前缀>', describe: '文件名前缀（按秒默认 s_，按帧默认空）' },
    format: { type: 'string', choices: ['png', 'jpeg'], arg: 'png|jpeg', describe: '图片格式（按秒默认 jpeg，按帧默认 png）' },
    quality: { type: 'integer', min: 1, max: 100, default: 92, arg: '<1–100>', describe: 'JPEG 质量（默认 92）' },
    texts: { type: 'boolean', describe: '每张截完图再读 window.TEXTS(t)，连同形状核对写进运行记录' },
    ...pickOptions(['gpu', 'angle', 'allow-network', 'lenient-assets', 'allow-gl-errors', 'ready-timeout', 'frame-timeout', 'settle', 'progress']),
    'run-json': { type: 'string', arg: '<文件>', describe: '运行记录（默认 <输出目录>/<前缀>still.run.json）' },
  },
  examples: [
    'node engine/render/still.mjs . --range 0:9.5:0.5 9.95 --out out/stills      《北冥》样张（s_0.00.jpg …）',
    'node engine/render/still.mjs . --frame 0,72,239 --out out/golden            按帧取无损 PNG（f000000.png …）',
    'node engine/render/still.mjs . --query test=kun 0 1.6 3.2 --out out/lab/kun   lab 自测页',
  ],
}, main);

async function main({ opts, args, log, life, signal, setRunJson }) {
  life.defer(closeServer);
  const { dir, times } = args;
  locateFilm(dir);
  for (const k of ['ready-timeout', 'frame-timeout']) positiveNumber(opts[k], `--${k}`);
  resolveGpuPolicy(opts.gpu ?? undefined); resolveAngle(opts.angle ?? undefined);
  const film = readFilm(dir);
  const { size: { w, h }, fps: fpsReq, profile } = resolveOutputSpec({ opts, film });
  for (const m of profile?.warnings ?? []) log.warn(m, 'profiles', '档位表归作品描述包维护：engine/production/profiles.json');
  const byFrame = Boolean(opts.frame.length || opts.frames);
  const shots = times.map(s => ({ t: parseTime(s), label: s.trim(), frame: null }));
  if (opts.range) shots.push(...rangeTimes(opts.range).map(x => ({ ...x, frame: null })));
  const frames = [];
  for (const s of opts.frame) {
    if (!/^\d+$/.test(s)) throw new RenderError('usage.bad-value', `--frame 要写整数帧号（收到「${s}」）`, { hint: '例如 --frame 0,72,239' });
    frames.push(Number(s));
  }
  if (opts.frames) { const { a, b, step } = parseFrames(opts.frames, { allowStep: true }); for (let f = a; f < b; f += step) frames.push(f); }
  if (frames.length > 100000) throw new RenderError('usage.bad-value', `一次最多 100000 张（收到 ${frames.length}）`, { hint: '加大 --frames 的步长' });
  if (!shots.length && !frames.length) throw new RenderError('usage.missing-argument', '缺少时刻或帧号', { hint: '写时刻（秒）、--range、--frame 或 --frames' });
  const prefix = opts.prefix ?? (shots.length ? 's_' : '');
  const timeFormat = opts.format ?? 'jpeg', frameFormat = opts.format ?? 'png';
  const ext = f => (f === 'png' ? 'png' : 'jpg');
  const names = new Set();
  const plan = [
    ...shots.map(s => ({ ...s, format: timeFormat, name: `${prefix}${s.label}.${ext(timeFormat)}` })),
    ...frames.map(f => ({ t: null, frame: f, label: `f${String(f).padStart(6, '0')}`, format: frameFormat, name: `${prefix}f${String(f).padStart(6, '0')}.${ext(frameFormat)}` })),
  ];
  for (const p of plan) {
    if (names.has(p.name)) throw new RenderError('usage.duplicate', `${p.frame === null ? `时刻 ${p.label}` : `第 ${p.frame} 帧`} 重复了：文件 ${p.name} 会被覆盖`, { hint: '去掉重复的时刻或帧号' });
    names.add(p.name);
  }

  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  life.defer(acquireLock(path.join(outDir, `.${prefix}still`)));
  const runJsonPath = path.resolve(opts['run-json'] ?? path.join(outDir, `${prefix}still.run.json`));
  setRunJson(repoPath(ROOT, runJsonPath));
  const env = environment(ROOT);
  const isRoot = path.resolve(dir) === ROOT;
  const record = baseRecord({ command: 'still', argv: process.argv.slice(1).map(a => (path.isAbsolute(a) ? repoPath(ROOT, a) : a)), env,
    projectId: film?.id ?? (isRoot ? 'beiming' : path.basename(path.resolve(dir))), shotId: 'stills',
    route: film?.route ?? (isRoot ? 'a' : null), backend: film?.backend ?? (isRoot ? 'three' : null) });
  record.film = { dir: repoPath(ROOT, dir), query: opts.query || null };
  const t0 = Date.now();
  const outputs = [];
  let finished = false;
  const finish = async (status, extra = {}) => {
    finished = true;
    Object.assign(record, extra, { status, finishedAt: new Date().toISOString(), warnings: log.warnings });
    record.timing.totalSeconds = +((Date.now() - t0) / 1000).toFixed(2);
    record.outputs = outputs;
    record.selfCheck = await selfCheck(ROOT, record);
    writeRecord(runJsonPath, record);
  };
  life.defer(async () => {
    if (finished) return;
    const e = signal.reason;
    record.stage = 'failed';
    await finish('failed', { error: { code: e?.code ?? 'failure.internal', message: String(e?.message ?? e ?? '未知错误'), hint: e?.hint ?? null, exitCode: e?.exitCode ?? 1 } }).catch(() => {});
  });

  const openOptions = {
    w, h, query: opts.query, gpu: opts.gpu ?? undefined, angle: opts.angle ?? undefined, allowNetwork: opts['allow-network'],
    lenientAssets: opts['lenient-assets'], allowGlErrors: opts['allow-gl-errors'], handleSignals: false, log, life, signal,
    render: { fps: fpsReq, profile: profile?.id ?? null, frameCount: film?.output?.frameCount ?? null },
  };
  if (opts['ready-timeout']) openOptions.readyTimeoutMs = opts['ready-timeout'] * 1000;
  const f = await openFilm(dir, openOptions);
  life.closer(() => f.close());
  const fps = byFrame ? decideFps({ requested: fpsReq, pageFps: f.contract.pageFps, anyFps: opts['any-fps'], log }) : fpsReq;
  const total = byFrame ? Math.round(f.contract.dur * fps) : null;
  const settle = opts.settle === 'auto' ? (f.info.angle === 'vulkan' ? 'raf2' : 'none') : opts.settle;
  Object.assign(record, { actualDevice: f.info.renderer || null, actualGraphicsBackend: `ANGLE ${f.info.angle}`, softwareFallback: f.info.software, gpu: f.info, page: f.contract,
    actualEncoder: `${timeFormat === frameFormat ? frameFormat : `${timeFormat}+${frameFormat}`} 截图`, render: { fps, width: w, height: h, settle } });
  record.tools.browser = f.info.browserVersion;
  const texts = opts.texts ? [] : null;
  for (const [i, p] of plan.entries()) {
    if (p.frame !== null && p.frame >= total) throw new RenderError('usage.frames-out-of-range', `第 ${p.frame} 帧超出片长（${total} 帧，帧号 0–${total - 1}）`, { hint: '帧号从 0 开始；最后一帧是 round(DUR × fps) − 1' });
    const t = p.frame !== null ? p.frame / fps : p.t;
    const s0 = Date.now();
    await renderFrame(f, t, { settle, signal, where: p.frame !== null ? `第 ${p.frame} 帧（t=${t.toFixed(4)}s）` : `t=${p.label}s`, timeoutMs: opts['frame-timeout'] ? opts['frame-timeout'] * 1000 : undefined });
    const img = await f.capture(p.format, opts.quality);
    f.check();
    const file = path.join(outDir, p.name), tmp = `${file}.partial`;
    fs.writeFileSync(tmp, img);
    fs.renameSync(tmp, file);
    outputs.push({ path: repoPath(ROOT, file), sha256: sha256(img), kind: 'still', t, frame: p.frame });
    if (texts) {
      const r = await f.page.evaluate(async x => {
        if (typeof window.TEXTS !== 'function') return { missing: true };
        try { let v = window.TEXTS(x); if (v && typeof v.then === 'function') v = await v; return { value: JSON.parse(JSON.stringify(v ?? null)) }; } catch (e) { return { error: String(e?.message ?? e) }; }
      }, t);
      const c = checkTexts(r, { w, h });
      texts.push({ name: p.name, t, frame: p.frame, ...c });
      for (const m of c.problems) log.warn(`${p.name}：${m}`, 'texts-shape', '文字报告的条目写成 { text, box: [x, y, w, h], alpha, font }（页面约定 v1，README「页面约定」）');
    }
    log.progress({ stage: 'still', done: i + 1, total: plan.length, file: repoPath(ROOT, file) }, `${repoPath(ROOT, file)}  ${Date.now() - s0}ms`);
  }
  if (texts) record.texts = texts;
  record.stage = 'rendered';
  await finish('running');
  return { outputs: outputs.map(({ path: p, sha256: s, kind }) => ({ path: p, sha256: s, kind })), data: { count: outputs.length, dir: repoPath(ROOT, outDir), texts: texts ? texts.map(x => ({ name: x.name, entries: x.entries?.length ?? 0, problems: x.problems })) : null } };
}

if (isMain(import.meta.url)) await runCli(command);
