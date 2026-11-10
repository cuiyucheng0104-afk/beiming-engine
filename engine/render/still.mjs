// 北冥引擎 · 渲静帧（渲染器 v2，规格见 engine/render/README.md）
//   node engine/render/still.mjs <影片目录> <t> [<t> ...] [--range a:b:step]            按秒取时（样张、联系表；默认 JPEG q92）
//   node engine/render/still.mjs <影片目录> --frame 0,72,239 | --frames a:b[:step] [--fps 24]   按整数帧取（QA、金标准；默认无损 PNG）
//   其余：[--size WxH | --profile 档位] [--query k=v] [--out out/stills] [--prefix s_] [--format png|jpeg] [--json] …   完整选项：--help
// 按秒：--range 按整数下标生成 a、a+step、…（≤ b），不累加浮点误差，按算出的时刻原值渲；文件名里的时刻能用两位小数精确表示时写
//   两位（s_0.50.jpg），否则写到能精确表示的位数（s_0.0416667.jpg）；直接写的时刻，文件名照写法保留（9.95 → s_9.95.jpg）。
// 按帧：t = 帧号 / fps，文件名 <前缀>f000072.png（帧号补 6 位）；fps 默认按档位 / film.json / 页面的 window.FPS，再默认 24，
//   与页面声明的帧率不一致退出码 4（--any-fps 放行）。这样取的帧与 video.mjs 第 N 帧是同一时刻。
// 步长为 0 / 负数 / 漏写、时刻不是数字、不认识的选项都直接报错退出（码 2），不会死循环或乱出图。
// 每张先写 <名>.partial 再改名；页面报错、着色器错误、上下文丢失时这一张不保留，以约定的非零码退出。输出目录旁写运行记录。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFilm, locateFilm, renderFrame, closeServer, ROOT } from './page.mjs';
import { parseTime, rangeTimes } from './args.mjs';
import { runCli, UsageError } from './lib/cli.mjs';
import { GPU_POLICIES } from './lib/gpu.mjs';
import { acquireLock } from './lib/lock.mjs';
import { environment, baseRecord, writeRecord, sha256, repoPath, selfCheck } from './lib/record.mjs';
import { readFilm } from './lib/film.mjs';
import { resolveOutputSpec, decideFps } from './video.mjs';

export const SPEC = {
  command: 'engine/render/still.mjs',
  usage: 'node engine/render/still.mjs <影片目录> [<t> ...] [--range a:b:step] [--frame 0,72 | --frames a:b[:step]] [选项]',
  summary: ['渲几张静帧。按秒（位置参数、--range）用于样张与联系表，按整数帧（--frame / --frames）用于 QA 与金标准。'],
  positionals: { min: 1, max: Infinity, names: ['影片目录', '时刻'] },
  options: {
    '--range': { type: 'string', arg: 'a:b:step', desc: '按秒：a、a+step、…（≤ b）' },
    '--frame': { type: 'list', arg: 'N[,N…]', desc: '按整数帧：逗号分隔的帧号' },
    '--frames': { type: 'frames', allowStep: true, arg: 'a:b[:step]', desc: '按整数帧：第 a 到 b−1 帧，可隔 step 帧取一张' },
    '--fps': { type: 'number', positive: true, arg: '<n>', desc: '按帧取时的帧率（默认按档位 / film.json / 页面 window.FPS，再默认 24）' },
    '--any-fps': { type: 'flag', desc: '帧率与页面声明的不一致也照渲' },
    '--profile': { type: 'string', arg: '<档位>', desc: '交付档位：给出尺寸与帧率' },
    '--size': { type: 'size', arg: 'WxH', desc: '画幅（默认按档位 / film.json，再默认 1920x1040）' },
    '--query': { type: 'string', default: '', arg: 'k=v&…', desc: '页面 URL 参数（例如 test=kun）' },
    '--out': { type: 'string', default: 'out/stills', arg: '<目录>', desc: '输出目录（默认 out/stills）' },
    '--prefix': { type: 'string', arg: '<前缀>', desc: '文件名前缀（按秒默认 s_，按帧默认空）' },
    '--format': { type: 'enum', choices: ['png', 'jpeg'], arg: 'png|jpeg', desc: '图片格式（按秒默认 jpeg，按帧默认 png）' },
    '--quality': { type: 'int', min: 1, max: 100, default: 92, arg: '<1–100>', desc: 'JPEG 质量（默认 92）' },
    '--gpu': { type: 'enum', choices: GPU_POLICIES, arg: '<策略>', desc: 'required（默认）| any | software-ok' },
    '--angle': { type: 'string', arg: '<后端>', desc: 'ANGLE 后端（默认 BEIMING_ANGLE，再默认平台值）' },
    '--allow-network': { type: 'flag', desc: '放行外网请求（记进运行记录）' },
    '--lenient-assets': { type: 'flag', desc: '非脚本类的本地 404 只记提示' },
    '--allow-gl-errors': { type: 'flag', desc: '着色器错误只记提示（调试用）' },
    '--ready-timeout': { type: 'number', positive: true, arg: '<秒>', desc: '等 window.READY 的上限（默认 180）' },
    '--frame-timeout': { type: 'number', positive: true, arg: '<秒>', desc: '单帧 render(t) 的上限（默认 120）' },
    '--settle': { type: 'enum', choices: ['auto', 'none', 'raf2'], default: 'auto', arg: '<方式>', desc: 'render 后再等两帧（auto：只在 vulkan 时）' },
    '--run-json': { type: 'string', arg: '<文件>', desc: '运行记录（默认 <输出目录>/<前缀>still.run.json）' },
    '--json': { type: 'flag', desc: 'stdout 只输出一个结果对象' },
  },
  examples: [
    'node engine/render/still.mjs . --range 0:9.5:0.5 9.95 --out out/stills      《北冥》样张（s_0.00.jpg …）',
    'node engine/render/still.mjs . --frame 0,72,239 --out out/golden            按帧取无损 PNG（f000000.png …）',
    'node engine/render/still.mjs . --query test=kun 0 1.6 3.2 --out out/lab/kun   lab 自测页',
  ],
};

async function main({ opts, args, explicit, log, cleanup, setRunJson }) {
  cleanup(closeServer);
  const [dir, ...times] = args;
  locateFilm(dir);
  const film = readFilm(dir);
  const { size: { w, h }, fps: fpsReq, profile } = resolveOutputSpec({ opts, explicit, film });
  const byFrame = Boolean(opts['--frame'] || opts['--frames']);
  const shots = times.map(s => ({ t: parseTime(s), label: s.trim(), frame: null }));
  if (opts['--range']) shots.push(...rangeTimes(opts['--range']).map(x => ({ ...x, frame: null })));
  const frames = [];
  if (opts['--frame']) for (const s of opts['--frame']) {
    if (!/^\d+$/.test(s)) throw new UsageError(`--frame 要写整数帧号（收到 ${s}）`, '例如 --frame 0,72,239');
    frames.push(Number(s));
  }
  if (opts['--frames']) { const { a, b, step } = opts['--frames']; for (let f = a; f < b; f += step) frames.push(f); }
  if (frames.length > 100000) throw new UsageError(`一次最多 100000 张（收到 ${frames.length}）`);
  if (!shots.length && !frames.length) throw new UsageError('缺少时刻或帧号', '写时刻（秒）、--range、--frame 或 --frames');
  const prefix = opts['--prefix'] ?? (shots.length ? 's_' : '');
  const timeFormat = opts['--format'] ?? 'jpeg', frameFormat = opts['--format'] ?? 'png';
  const ext = f => (f === 'png' ? 'png' : 'jpg');
  const names = new Set();
  const plan = [
    ...shots.map(s => ({ ...s, format: timeFormat, name: `${prefix}${s.label}.${ext(timeFormat)}` })),
    ...frames.map(f => ({ t: null, frame: f, label: `f${String(f).padStart(6, '0')}`, format: frameFormat, name: `${prefix}f${String(f).padStart(6, '0')}.${ext(frameFormat)}` })),
  ];
  for (const p of plan) {
    if (names.has(p.name)) throw new UsageError(`${p.frame === null ? `时刻 ${p.label}` : `第 ${p.frame} 帧`} 重复了：文件 ${p.name} 会被覆盖`);
    names.add(p.name);
  }

  const outDir = path.resolve(opts['--out']);
  fs.mkdirSync(outDir, { recursive: true });
  cleanup(acquireLock(path.join(outDir, `.${prefix}still`)));
  const runJsonPath = path.resolve(opts['--run-json'] ?? path.join(outDir, `${prefix}still.run.json`));
  setRunJson(repoPath(ROOT, runJsonPath));
  const env = environment(ROOT);
  const record = baseRecord({ command: 'still', argv: process.argv.slice(1).map(a => (path.isAbsolute(a) ? repoPath(ROOT, a) : a)), env,
    projectId: film?.id ?? (path.resolve(dir) === ROOT ? 'beiming' : path.basename(path.resolve(dir))), shotId: 'stills',
    route: film?.route ?? (path.resolve(dir) === ROOT ? 'a' : null), backend: film?.backend ?? 'page' });
  record.film = { dir: repoPath(ROOT, dir), query: opts['--query'] || null };
  const t0 = Date.now();
  const outputs = [];
  let f = null;
  const finish = async (status, extra = {}) => {
    Object.assign(record, extra, { status, finishedAt: new Date().toISOString(), warnings: log.warnings });
    record.timing.totalSeconds = +((Date.now() - t0) / 1000).toFixed(2);
    record.outputs = outputs;
    record.selfCheck = await selfCheck(ROOT, record);
    writeRecord(runJsonPath, record);
  };
  try {
    const openOptions = {
      w, h, query: opts['--query'], gpu: opts['--gpu'], angle: opts['--angle'], allowNetwork: Boolean(opts['--allow-network']),
      lenientAssets: Boolean(opts['--lenient-assets']), allowGlErrors: Boolean(opts['--allow-gl-errors']), handleSignals: false, log,
      render: { fps: fpsReq, profile: profile?.id ?? null, frameCount: film?.output?.frameCount ?? null },
    };
    if (opts['--ready-timeout']) openOptions.readyTimeoutMs = opts['--ready-timeout'] * 1000;
    f = await openFilm(dir, openOptions);
    cleanup(() => f.close());
    const fps = byFrame ? decideFps({ requested: fpsReq, pageFps: f.contract.pageFps, anyFps: Boolean(opts['--any-fps']), log }) : fpsReq;
    const total = byFrame ? Math.round(f.contract.dur * fps) : null;
    const settle = opts['--settle'] === 'auto' ? (f.info.angle === 'vulkan' ? 'raf2' : 'none') : opts['--settle'];
    Object.assign(record, { actualDevice: f.info.renderer || null, actualGraphicsBackend: `ANGLE ${f.info.angle}`, softwareFallback: f.info.software, gpu: f.info, page: f.contract,
      actualEncoder: `${timeFormat === frameFormat ? frameFormat : `${timeFormat}+${frameFormat}`} 截图`, render: { fps, width: w, height: h, settle } });
    record.tools.browser = f.info.browserVersion;
    for (const p of plan) {
      if (p.frame !== null && p.frame >= total) throw new UsageError(`第 ${p.frame} 帧超出片长（${total} 帧，帧号 0–${total - 1}）`, '帧号从 0 开始；最后一帧是 round(DUR × fps) − 1');
      const t = p.frame !== null ? p.frame / fps : p.t;
      const s0 = Date.now();
      await renderFrame(f, t, { settle, where: p.frame !== null ? `第 ${p.frame} 帧（t=${t.toFixed(4)}s）` : `t=${p.label}s`, timeoutMs: opts['--frame-timeout'] ? opts['--frame-timeout'] * 1000 : undefined });
      const img = await f.capture(p.format, opts['--quality']);
      f.check();
      const file = path.join(outDir, p.name), tmp = `${file}.partial`;
      fs.writeFileSync(tmp, img);
      fs.renameSync(tmp, file);
      outputs.push({ path: repoPath(ROOT, file), sha256: sha256(img), kind: 'still', t, frame: p.frame });
      log.info(`${repoPath(ROOT, file)}  ${Date.now() - s0}ms`);
    }
    await finish('rendered');
    return { outputs: outputs.map(({ path: p, sha256: s, kind }) => ({ path: p, sha256: s, kind })) };
  } catch (e) {
    await finish('failed', { error: { code: e.code ?? 'internal', message: String(e.message), hint: e.hint ?? null, exitCode: e.exitCode ?? 1 } }).catch(() => {});
    throw e;
  }
}

const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) await runCli(SPEC, main);
