#!/usr/bin/env node
// 北冥仓库 · 无 GPU 冒烟出片（CI 的 smoke-render job；本机也能跑）：用小尺寸把三条路线的模版与《北冥》真实走一遍出片链路，
// 检查帧数、尺寸、音轨、画面不是黑屏 / 纯色，拼一张接触印，再交给 P08 的金标准工具比对（还没有清单时首次采集）。
//   node tests/ci/smoke-render.mjs                          全部阶段（a c b beiming golden）
//   node tests/ci/smoke-render.mjs --only beiming,golden    只跑其中几段
//   node tests/ci/smoke-render.mjs --plan                   只打印每段要跑的命令，不执行
// 软件渲染：CI 上设 BEIMING_ANGLE=swiftshader（Linux 无显卡）；macOS 本机同样用 BEIMING_ANGLE=swiftshader 模拟。
//
// 阶段：
//   a        new-film a → films/<临时名>/build.sh --size 384x208（关键帧 → 声音 → 逐帧 → 封装）→ 核对成片与中段关键帧
//   c        new-film c → film.json 的 size 改成 320x180 → engine/render/build.mjs（事件 → 混音 → 拍点 → 逐帧 → 封装 → 海报 → 核对）
//   b        new-film b → engine/native/prepare.mjs（资产桥导出 GLB、底板、声音；不需要原生运行时）→ 声明的素材齐全、
//            prepared.json 的哈希与文件一致；再准备一遍，两次产物逐字节相同（资产桥的确定性）
//   b-render 只在设了 RAEA_BIN（原生运行时，仓库不分发）时运行：engine/render/native.mjs 以小尺寸出片并核对；没设就跳过并写明
//   beiming  《北冥》1.5 / 4.0 / 7.6 秒与 lab 自测页 look 的静帧（默认 384x208）→ 不是黑屏、不是纯色
//   golden   tools/baseline/golden.mjs（P08）：tests/golden/<平台键>/manifest.json 在就 compare，不在就 capture 并把结果放进 --out
//   最后总会把本次的静帧拼成 <out>/contact.jpg（只用来看一眼，不参与判定）。
// 成片核对（a、c、b-render）：尺寸、帧数 = round(dur × fps)、帧率、H.264 yuv420p、BT.709 有限范围且标注完整、AAC 48 kHz 立体声、
//   积分响度 −14 ± 1 LUFS、真峰值 ≤ −1.0 dBTP（D07）、中段一帧不是黑屏或纯色。这些是冒烟级的规格核对，完整的机器 QA 门见 tools/qa（P07）。
// 平台键：默认 <系统>-swiftshader（BEIMING_ANGLE=swiftshader 时；CI 上是 linux-swiftshader）。不是软件渲染时不做金标准比对，
//   除非用 --golden compare 并用 --platform 指明平台键。
// 软件渲染放行：设了 BEIMING_ANGLE=swiftshader 时，子进程环境里加 BEIMING_GPU=software-ok（渲染器 v2 要求显式允许软件渲染；
//   旧渲染器忽略这个变量）。
// 临时作品建在 films/ci-smoke-<路线>-<随机>/（页面服务只认仓库内的目录），结束、出错或被中断时都会删掉；--keep 保留。
// 产物都复制到 --out（默认 out/ci/smoke/），report.json 用附录 C2 信封。
//
// 退出码：0 全部通过（golden 首次采集也算通过，但写进 warnings）；1 出片或核对失败；2 用法错误；3 缺浏览器、FFmpeg、sh、Python 依赖；
//   4 金标准比对不一致；124 某一步超时；130 / 143 被中断（已清理临时作品与子进程）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  ROOT, EXIT, CliError, parseArgs, envelope, writeReport, isMain, run, onSignals, resolvePython, pythonEnv, probeCapability,
  inActions, annotate, stepSummary, mdCell, table, fmtSec,
} from '../../tools/run-tests.mjs';

const PHASES = ['a', 'c', 'b', 'b-render', 'beiming', 'golden'];
const NEEDS = {   // 每段要的能力（预检；缺了 exit 3）
  a: ['browser', 'ffmpeg', 'sh', 'python', 'python:numpy+scipy+soundfile+numba'],
  c: ['browser', 'ffmpeg', 'sh', 'python', 'python:numpy+scipy+soundfile+numba'],
  b: ['browser', 'python', 'python:numpy+soundfile'],
  'b-render': ['ffmpeg', 'sh', 'python', 'python:numpy+soundfile'],
  beiming: ['browser', 'ffmpeg'],
  golden: [],
};
const TILE = [384, 208];   // 接触印每格的尺寸（与静帧尺寸无关）
const SPEC = {
  only: { type: 'list' }, skip: { type: 'list' }, out: { type: 'string' }, python: { type: 'string' }, root: { type: 'string' },
  'size-a': { type: 'string' }, 'size-c': { type: 'string' }, 'size-beiming': { type: 'string' },
  golden: { type: 'string' }, platform: { type: 'string' }, 'golden-set': { type: 'list' },
  keep: { type: 'bool' }, plan: { type: 'bool' }, json: { type: 'bool' }, report: { type: 'string' }, timeout: { type: 'int' }, help: { type: 'bool', short: 'h' },
};
export const HELP = `北冥仓库 · 无 GPU 冒烟出片（CI smoke-render）

用法：node tests/ci/smoke-render.mjs [参数]

  --only <阶段,…> / --skip <阶段,…>   阶段：${PHASES.join('、')}
  --out <目录>            产物与报告目录（默认 out/ci/smoke）
  --size-a <WxH>          A 模版出片尺寸（默认 384x208，与 1920x1040 同比例）
  --size-c <WxH>          C 模版出片尺寸（默认 320x180）
  --size-beiming <WxH>    《北冥》静帧尺寸（默认 384x208）
  --golden <模式>         auto（默认：有清单就比对，没有就采集）、compare、capture、off
  --platform <平台键>     金标准平台键（默认 <系统>-swiftshader，CI 上是 linux-swiftshader；不是软件渲染时没有默认值）
  --golden-set <名,…>     金标准集合（默认 beiming-core,lab）
  --python <解释器>       Python（默认依次找 BEIMING_PY、PYTHON、tools/env/py.mjs、.venv、python3…）
  --timeout <秒>          每一步的时限（默认 600）
  --keep                  保留 films/ 下的临时作品（排查用）
  --plan                  只打印每段要跑的命令，不执行、不建任何文件
  --json / --report <文件> 附录 C2 信封（stdout 只有 JSON / 另写一份文件）
  -h, --help              显示本说明

环境：CI 上设 BEIMING_ANGLE=swiftshader；需要 playwright-core 的 chromium-headless-shell、FFmpeg（ffmpeg + ffprobe）、POSIX sh、
      装了 requirements 的 Python。b-render 另要 RAEA_BIN（原生运行时，仓库不分发；没有就跳过这一段）。
退出码：0 通过；1 失败；2 用法错误；3 环境缺失；4 金标准不一致；124 超时；130/143 被中断`;

const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sizeOf = (s, name) => {
  const m = /^(\d+)x(\d+)$/.exec(s || '');
  if (!m || +m[1] % 2 || +m[2] % 2 || +m[1] < 16 || +m[2] < 16) throw new CliError(EXIT.USAGE, 'usage.bad-value', `--${name} 要写成 WxH（偶数、≥16），现在是「${s}」`);
  return [+m[1], +m[2]];
};

// ffprobe → { video: {width,height,frames,fps,pixFmt}, audio: {sampleRate,channels} | null }
export function probeMedia(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
    'stream=codec_type,codec_name,profile,width,height,r_frame_rate,nb_read_frames,pix_fmt,color_range,color_space,color_primaries,color_transfer,sample_rate,channels',
    '-of', 'json', file], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`ffprobe 读不了 ${file}：${(r.stderr || '').trim().split('\n').pop()}`);
  const streams = JSON.parse(r.stdout).streams || [];
  const v = streams.find(s => s.codec_type === 'video'), a = streams.find(s => s.codec_type === 'audio');
  const [n, d] = (v?.r_frame_rate || '0/1').split('/').map(Number);
  return {
    video: v ? {
      codec: v.codec_name, profile: v.profile, width: v.width, height: v.height, frames: +v.nb_read_frames, fps: d ? n / d : 0, pixFmt: v.pix_fmt,
      color: { range: v.color_range || null, space: v.color_space || null, primaries: v.color_primaries || null, transfer: v.color_transfer || null },
    } : null,
    audio: a ? { codec: a.codec_name, sampleRate: +a.sample_rate, channels: a.channels } : null,
  };
}
// 有限范围 BT.709，四项标注齐全（D07；62ad28e 起整条出片链路都这样写）
export const isBt709Tv = c => !!c && c.range === 'tv' && c.space === 'bt709' && c.primaries === 'bt709' && c.transfer === 'bt709';
// 画面统计（一张图，或视频里的第 n 帧）：YMIN / YLOW / YAVG / YHIGH / YMAX
function lumaStats(file, frame = null) {
  const vf = (frame == null ? '' : `select=eq(n\\,${frame}),`) + 'signalstats,metadata=print:file=-';
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', file, '-vf', vf, '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8', timeout: 120000 });
  const get = k => { const m = new RegExp(`signalstats\\.${k}=([\\d.]+)`).exec(r.stdout); return m ? +m[1] : null; };
  return { ymin: get('YMIN'), ylow: get('YLOW'), yavg: get('YAVG'), yhigh: get('YHIGH'), ymax: get('YMAX') };
}
// 不是黑屏（最亮处 ≥ 32）也不是纯色（10%–90% 分位的亮度差 ≥ 6）
export const notBlank = s => s.ymax != null && s.ymax >= 32 && s.yhigh - s.ylow >= 6;
function loudness(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8', timeout: 120000 });
  const txt = r.stderr || '';
  const i = /I:\s+(-?[\d.]+) LUFS/.exec(txt.slice(txt.lastIndexOf('Summary:'))), p = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(txt.slice(txt.lastIndexOf('Summary:')));
  return { lufs: i ? +i[1] : null, truePeak: p && p[1] !== '-inf' ? +p[1] : null };
}

class Phase {
  constructor(id, title) { Object.assign(this, { id, title, status: 'not-run', durationMs: 0, reason: null, checks: [], outputs: [], details: {} }); }
  check(name, ok, value, expected) { this.checks.push({ name, ok: !!ok, value, expected }); process.stderr.write(`  ${ok ? '✓' : '✗'} ${name}：${typeof value === 'object' ? JSON.stringify(value) : value}${ok ? '' : `（应为 ${expected}）`}\n`); return ok; }
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  const warnings = [];
  const phases = [];
  const created = [];   // 本次建的临时作品目录（结束时删）
  const finish = (exitCode, extra = {}, error = null) => {
    const env = envelope({ exitCode, command: 'smoke-render', error, warnings, ...extra });
    if (opts?.json) process.stdout.write(JSON.stringify(env, null, 2) + '\n');
    writeReport(opts?.report, env);
    if (error) process.stderr.write(`${error.message}${error.hint ? `\n${error.hint}` : ''}\n`);
    return exitCode;
  };
  let ctx;
  try {
    opts = parseArgs(argv, SPEC);
    if (opts.help) { process.stdout.write(HELP + '\n'); return EXIT.OK; }
    for (const n of [...opts.only, ...opts.skip]) if (!PHASES.includes(n)) throw new CliError(EXIT.USAGE, 'usage.bad-value', `不认识的阶段「${n}」`, `可用：${PHASES.join('、')}`);
    const golden = opts.golden || 'auto';
    if (!['auto', 'compare', 'capture', 'off'].includes(golden)) throw new CliError(EXIT.USAGE, 'usage.bad-value', `--golden 只能是 auto、compare、capture、off，现在是「${golden}」`);
    if (opts.root && !fs.existsSync(path.resolve(opts.root))) throw new CliError(EXIT.USAGE, 'usage.bad-value', `--root 指向的目录不存在：${opts.root}`);
    const root = opts.root ? fs.realpathSync(path.resolve(opts.root)) : ROOT;   // 真实路径：被调用的工具按真实路径判断自己是不是入口
    const software = (process.env.BEIMING_ANGLE || '').toLowerCase() === 'swiftshader';
    const osKey = process.platform === 'win32' ? 'win' : process.platform;
    if (golden === 'compare' && !opts.platform && !software) throw new CliError(EXIT.USAGE, 'usage.bad-value', '--golden compare 在非软件渲染下要用 --platform 指明平台键（例如 darwin-metal-apple-m5）');
    ctx = {
      root, opts, golden, warnings, created,
      out: path.resolve(opts.out || path.join(root, 'out/ci/smoke')),
      sizeA: sizeOf(opts['size-a'] || '384x208', 'size-a'), sizeC: sizeOf(opts['size-c'] || '320x180', 'size-c'),
      sizeB: sizeOf(opts['size-beiming'] || '384x208', 'size-beiming'),
      platform: opts.platform || (software ? `${osKey}-swiftshader` : null), sets: opts['golden-set'].length ? opts['golden-set'] : ['beiming-core', 'lab'],
      timeoutMs: 1000 * (opts.timeout || 600), tag: crypto.randomBytes(3).toString('hex'),
      // 渲染器 v2（P04）默认拒绝软件渲染；CI 本来就只有软件渲染，显式放行（旧渲染器不认这个变量，没有影响）
      childEnv: software && !process.env.BEIMING_GPU ? { BEIMING_GPU: 'software-ok' } : {},
    };
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    opts = opts || { json: argv.includes('--json') };
    return finish(e.exitCode, {}, e);
  }
  const ids = PHASES.filter(p => (!opts.only.length || opts.only.includes(p)) && !opts.skip.includes(p) && !(p === 'golden' && ctx.golden === 'off'));

  if (opts.plan) {
    const o = opts.json ? process.stderr : process.stdout;
    for (const id of ids) o.write(`[${id}]\n${planOf(id, ctx).map(l => `  ${l}`).join('\n')}\n`);
    return finish(EXIT.OK, { phases: ids.map(id => ({ id, status: 'planned', commands: planOf(id, ctx) })) });
  }

  // 预检：缺能力直接 exit 3，列出哪一段要什么
  const capCtx = { root: ctx.root, python: () => (ctx.py === undefined ? (ctx.py = resolvePython(ctx.root, opts.python)) : ctx.py) };
  const missing = [];
  for (const id of ids) for (const cap of NEEDS[id]) { const r = probeCapability(cap, capCtx); if (!r.ok) missing.push(`${id} 需要 ${cap}：${r.detail}`); }
  if (missing.length) {
    const e = new CliError(EXIT.ENV, 'ENV_MISSING', `冒烟出片的环境不全：\n  ${[...new Set(missing)].join('\n  ')}`,
      '装好后重跑（npx playwright-core install chromium-headless-shell；FFmpeg ≥ 7；pip install -r requirements.txt），或用 --only / --skip 只跑具备条件的阶段');
    return finish(e.exitCode, {}, e);
  }
  if (!process.env.BEIMING_ANGLE) warnings.push('没有设 BEIMING_ANGLE：本机会用默认 GPU 后端；要模拟 CI 设 BEIMING_ANGLE=swiftshader');
  ctx.pyExe = ids.some(id => NEEDS[id].includes('python')) ? pyExecutable(ctx.py) : null;
  fs.mkdirSync(ctx.out, { recursive: true });

  const filmsDir = path.join(ctx.root, 'films'), hadFilms = fs.existsSync(filmsDir);
  const cleanup = () => {
    if (opts.keep) return;
    for (const d of created) fs.rmSync(d, { recursive: true, force: true });
    if (!hadFilms) { try { fs.rmdirSync(filmsDir); } catch { /* 不空或不存在 */ } }   // films/ 是本次建的就一并删掉
  };
  onSignals(code => {
    cleanup();
    const e = new CliError(code, 'INTERRUPTED', `收到 ${code === EXIT.SIGINT ? 'SIGINT' : 'SIGTERM'}，已结束子进程并删除临时作品`);
    finish(code, { phases }, e);
  });

  let exitCode = EXIT.OK, error = null;
  try {
    for (const id of ids) {
      const ph = new Phase(id, TITLES[id]);
      phases.push(ph);
      process.stderr.write(`\n▶ ${id} · ${ph.title}\n`);
      if (inActions()) process.stdout.write(`::group::smoke ${id} · ${ph.title}\n`);
      const t0 = Date.now();
      try {
        await RUNNERS[id](ph, ctx);
        if (ph.status === 'not-run') ph.status = ph.checks.every(c => c.ok) ? 'pass' : 'fail';
        if (ph.status === 'fail' && !ph.reason) ph.reason = ph.checks.filter(c => !c.ok).map(c => c.name).join('、');
      } catch (e) {
        ph.status = e.timedOut ? 'timeout' : 'fail';
        ph.exitCode = e.exitCode ?? (e.timedOut ? EXIT.TIMEOUT : EXIT.FAIL);
        ph.reason = e.message;
        process.stderr.write(`  ✗ ${e.message}\n`);
      }
      ph.durationMs = Date.now() - t0;
      if (inActions()) process.stdout.write('::endgroup::\n');
    }
    const sheet = contactSheet(phases, ctx);
    if (sheet) phases.push(sheet);
  } finally {
    cleanup();
  }

  const bad = phases.filter(p => ['fail', 'timeout'].includes(p.status));
  if (bad.length) {
    const codes = bad.map(p => p.exitCode ?? (p.status === 'timeout' ? EXIT.TIMEOUT : EXIT.FAIL));
    exitCode = [EXIT.ENV, EXIT.TIMEOUT, EXIT.BUSY, EXIT.CONTRACT].find(c => codes.includes(c)) ?? EXIT.FAIL;
    error = new CliError(exitCode, exitCode === EXIT.CONTRACT ? 'GOLDEN_MISMATCH' : 'SMOKE_FAILED', `${bad.map(p => `${p.id}（${p.reason}）`).join('；')}`,
      '看上面 ✗ 的核对项；产物在 ' + path.relative(process.cwd(), ctx.out) + '，加 --keep 可保留临时作品排查');
  }
  for (const p of phases) if (p.status === 'warn') warnings.push(`${p.id}：${p.reason}`);
  const outputs = phases.flatMap(p => p.outputs);
  printHuman(phases);
  reportActions(phases);
  return finish(exitCode, { outputs, phases }, error);
}

const TITLES = { a: 'A 模版出片', c: 'C 模版出片', b: 'B 模版素材准备（资产桥）', 'b-render': 'B 模版出片（需原生运行时）', beiming: '《北冥》与 lab 静帧', golden: '金标准（P08）', contact: '接触印' };

// 命令一览（--plan 与报告共用）
function planOf(id, ctx) {
  const r = p => path.relative(ctx.root, p).split(path.sep).join('/');
  const film = route => `films/ci-smoke-${route}-${ctx.tag}`;
  switch (id) {
    case 'a': return [`node tools/new-film.mjs a ${film('a').slice(6)} --title 冒烟试映`, `PYTHON=<python> sh ${film('a')}/build.sh --size ${ctx.sizeA.join('x')}`, `核对 ${film('a')}/out/film.mp4 与 out/stills/`];
    case 'c': return [`node tools/new-film.mjs c ${film('c').slice(6)} --title 冒烟试映`, `把 ${film('c')}/film.json 的 size 改成 [${ctx.sizeC}]`, `BEIMING_PY=<python> node engine/render/build.mjs ${film('c')}`, `核对 ${film('c')}/out/${film('c').slice(6)}.mp4 与 poster.jpg`];
    case 'b': return [`node tools/new-film.mjs b ${film('b').slice(6)} --title 冒烟试映`, `PYTHON=<python> node engine/native/prepare.mjs ${film('b')}`,
      `核对 ${film('b')}/media/ 的素材与 prepared.json，再准备一遍比对哈希`];
    case 'b-render': return process.env.RAEA_BIN
      ? [`把 ${film('b')}/film.json 的 size 改成 [${ctx.sizeC}]`, `RAEA_BIN=${process.env.RAEA_BIN} node engine/render/native.mjs ${film('b')} --quality draft`, '核对成片规格']
      : ['跳过：没有设 RAEA_BIN（原生运行时不随仓库分发）'];
    case 'beiming': return [`node engine/render/still.mjs . 1.5 4.0 7.6 --size ${ctx.sizeB.join('x')} --out ${r(path.join(ctx.out, 'beiming'))}`,
      `node engine/render/still.mjs . 1.0 --query test=look --size ${ctx.sizeB.join('x')} --out ${r(path.join(ctx.out, 'lab'))} --prefix look_`];
    case 'golden': return ctx.platform
      ? [`tests/golden/${ctx.platform}/manifest.json 在：node tools/baseline/golden.mjs compare ${ctx.sets.map(s => `--set ${s}`).join(' ')} --platform ${ctx.platform}`,
        `不在：node tools/baseline/golden.mjs capture ${ctx.sets.map(s => `--set ${s}`).join(' ')} --platform ${ctx.platform} → 复制到 ${r(path.join(ctx.out, 'golden-capture'))}`]
      : ['跳过：不是软件渲染（BEIMING_ANGLE≠swiftshader）且没有 --platform；本机 GPU 的金标准用 node tools/baseline/golden.mjs 自己比对'];
    default: return [];
  }
}

// tools/env/py.mjs 是个 Node 包装：shell 脚本与 build.mjs 要的是解释器本身的路径
function pyExecutable(py) {
  const r = spawnSync(py.cmd, [...py.pre, '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', env: pythonEnv(), timeout: 30000 });
  const exe = (r.stdout || '').trim().split(/\r?\n/).pop();
  if (r.status !== 0 || !exe) throw new CliError(EXIT.ENV, 'PYTHON_MISSING', `取不到 Python 解释器路径（${py.label}）`);
  return exe;
}

// 从子命令的输出里挑出最能说明原因的一行：先找中文的失败描述（各工具第一次报错时写的就是根因），
// 再找 XxxError（跳过 execFileSync 的「Command failed」包装），都没有就取最后三行
export function explainFailure(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .filter(l => !/^at\s|^Node\.js v\d|^\^+$|^[{}()[\]]+$|^(code|status|signal|output|pid|stdout|stderr|errno|syscall|path|spawnargs):/.test(l));
  return lines.find(l => /(失败|出错|错误|缺少|超时|不一致|不存在|找不到|拒绝|不合法)/.test(l))
    || lines.find(l => /\b\w*Error\b/.test(l) && !/Command failed/.test(l))
    || lines.slice(-3).join(' / ');
}

async function step(ctx, label, cmd, args, env = {}) {
  process.stderr.write(`  $ ${[cmd === process.execPath ? 'node' : cmd, ...args].join(' ')}\n`);
  const r = await run(cmd, args, { cwd: ctx.root, env: { ...pythonEnv(), ...ctx.childEnv, ...env }, timeoutMs: ctx.timeoutMs, stdout: 'pipe', stderr: 'pipe' });
  if (r.timedOut) throw Object.assign(new Error(`${label} 超过 ${ctx.timeoutMs / 1000} 秒，已结束`), { timedOut: true, exitCode: EXIT.TIMEOUT });
  if (r.error) throw new Error(`${label} 启动失败：${r.error.message}`);
  if (r.code !== 0) throw new Error(`${label} 退出码 ${r.code}：${explainFailure(r.stdout + '\n' + r.stderr)}`);
  return r;
}

async function newFilm(ph, ctx, route) {
  const name = `ci-smoke-${route}-${ctx.tag}`;
  const dir = path.join(ctx.root, 'films', name);
  if (fs.existsSync(dir)) throw new CliError(EXIT.BUSY, 'BUSY', `films/${name} 已存在（另一个冒烟在跑？）`);
  ctx.created.push(dir);
  await step(ctx, 'new-film', process.execPath, [path.join(ctx.root, 'tools/new-film.mjs'), route, name, '--title', '冒烟试映']);
  ph.check('new-film 建出作品目录', fs.existsSync(path.join(dir, 'film.json')), `films/${name}`, '存在 film.json');
  return { name, dir, rel: `films/${name}`, film: JSON.parse(fs.readFileSync(path.join(dir, 'film.json'), 'utf8')) };
}

function keep(ph, ctx, src, dstRel, kind) {
  const dst = path.join(ctx.out, dstRel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  ph.outputs.push({ path: path.relative(ctx.root, dst).split(path.sep).join('/'), sha256: sha256(dst), kind });
  return dst;
}

function checkFilm(ph, file, { w, h, frames, fps, audio = true }) {
  const m = probeMedia(file);
  ph.details.media = m;
  const v = m.video, c = v?.color;
  ph.check('画面尺寸', v && v.width === w && v.height === h, v ? `${v.width}x${v.height}` : '无画面', `${w}x${h}`);
  ph.check('帧数', v && v.frames === frames, v?.frames, frames);
  ph.check('帧率', v && Math.abs(v.fps - fps) < 1e-6, v?.fps, fps);
  ph.check('编码 H.264 yuv420p', v && v.codec === 'h264' && v.pixFmt === 'yuv420p', v ? `${v.codec} ${v.pixFmt}` : '无画面', 'h264 yuv420p');
  ph.check('色彩：BT.709 有限范围，标注齐全', isBt709Tv(c), c ? `${c.range}/${c.space}/${c.primaries}/${c.transfer}` : '无', 'tv/bt709/bt709/bt709');
  if (audio) {
    ph.check('音轨 AAC 48 kHz 立体声', m.audio && m.audio.codec === 'aac' && m.audio.sampleRate === 48000 && m.audio.channels === 2,
      m.audio ? `${m.audio.codec} ${m.audio.sampleRate} Hz × ${m.audio.channels}` : '无音轨', 'aac 48000 Hz × 2');
    const l = loudness(file);
    ph.details.loudness = l;
    ph.check('积分响度 −14 ± 1 LUFS', l.lufs != null && Math.abs(l.lufs + 14) <= 1, l.lufs == null ? '测不出' : `${l.lufs} LUFS`, '−15 … −13 LUFS');
    ph.check('真峰值 ≤ −1.0 dBTP', l.truePeak != null && l.truePeak <= -1.0, l.truePeak == null ? '测不出' : `${l.truePeak} dBTP`, '≤ −1.0 dBTP');
  }
  const mid = Math.floor(frames / 2), s = lumaStats(file, mid);
  ph.details.midFrame = { frame: mid, ...s };
  ph.check(`第 ${mid} 帧不是黑屏或纯色`, notBlank(s), `YMAX ${s.ymax}，YLOW–YHIGH ${s.ylow}–${s.yhigh}`, 'YMAX ≥ 32 且 YHIGH − YLOW ≥ 6');
}

const RUNNERS = {
  async a(ph, ctx) {
    const f = await newFilm(ph, ctx, 'a');
    const [w, h] = ctx.sizeA;
    await step(ctx, 'A 出片（build.sh）', 'sh', [path.join(f.dir, 'build.sh'), '--size', `${w}x${h}`], { PYTHON: ctx.pyExe });
    const mp4 = path.join(f.dir, 'out/film.mp4');
    if (!ph.check('成片存在', fs.existsSync(mp4), `${f.rel}/out/film.mp4`, '存在')) return;
    checkFilm(ph, mp4, { w, h, frames: Math.round(f.film.dur * f.film.fps), fps: f.film.fps });
    keep(ph, ctx, mp4, 'a/film.mp4', 'video');
    const stills = fs.readdirSync(path.join(f.dir, 'out/stills')).filter(x => x.endsWith('.jpg')).sort((x, y) => parseFloat(x.slice(2)) - parseFloat(y.slice(2)));
    ph.check('关键帧 3 张', stills.length === 3, stills.length, 3);
    stills.forEach((s, i) => {
      const dst = keep(ph, ctx, path.join(f.dir, 'out/stills', s), `a/${s}`, 'still');
      if (i === 1) { const st = lumaStats(dst); ph.check(`中段关键帧 ${s} 不是黑屏或纯色`, notBlank(st), `YMAX ${st.ymax}，YLOW–YHIGH ${st.ylow}–${st.yhigh}`, 'YMAX ≥ 32 且 YHIGH − YLOW ≥ 6'); }
    });
  },

  async c(ph, ctx) {
    const f = await newFilm(ph, ctx, 'c');
    const [w, h] = ctx.sizeC;
    const fj = path.join(f.dir, 'film.json');
    fs.writeFileSync(fj, JSON.stringify({ ...f.film, size: [w, h] }, null, 2) + '\n');
    await step(ctx, 'C 出片（build.mjs）', process.execPath, [path.join(ctx.root, 'engine/render/build.mjs'), f.dir], { BEIMING_PY: ctx.pyExe });
    const mp4 = path.join(f.dir, 'out', `${f.name}.mp4`), poster = path.join(f.dir, 'out/poster.jpg');
    if (!ph.check('成片存在', fs.existsSync(mp4), `${f.rel}/out/${f.name}.mp4`, '存在')) return;
    checkFilm(ph, mp4, { w, h, frames: Math.round(f.film.dur * f.film.fps), fps: f.film.fps });
    keep(ph, ctx, mp4, 'c/film.mp4', 'video');
    if (ph.check('海报存在', fs.existsSync(poster), `${f.rel}/out/poster.jpg`, '存在')) {
      const dst = keep(ph, ctx, poster, 'c/poster.jpg', 'still');
      const st = lumaStats(dst);
      ph.check('海报不是黑屏或纯色', notBlank(st), `YMAX ${st.ymax}，YLOW–YHIGH ${st.ylow}–${st.yhigh}`, 'YMAX ≥ 32 且 YHIGH − YLOW ≥ 6');
    }
  },

  async b(ph, ctx) {
    const f = await newFilm(ph, ctx, 'b');
    const prepare = () => step(ctx, 'B 素材准备（prepare.mjs）', process.execPath, [path.join(ctx.root, 'engine/native/prepare.mjs'), f.dir], { PYTHON: ctx.pyExe });
    await prepare();
    const media = path.join(f.dir, 'media'), manifest = path.join(media, 'prepared.json');
    if (!ph.check('prepared.json 存在', fs.existsSync(manifest), `${f.rel}/media/prepared.json`, '存在')) return;
    keep(ph, ctx, manifest, 'b/prepared.json', 'manifest');
    const snapshot = () => {
      const out = {};
      for (const x of fs.readdirSync(media).sort()) {
        const p = path.join(media, x);
        if (fs.statSync(p).isFile()) out[x] = { size: fs.statSync(p).size, sha256: sha256(p) };
      }
      return out;
    };
    const assets = snapshot();
    ph.details.assets = assets;
    const native = f.film.native || {};
    const want = [...(native.images || []).map(i => i.to), ...(native.models || []).map(m => m.to), ...(native.sequences || []).map(q => q.to), ...(native.audio?.out ? [native.audio.out] : [])];
    ph.check('film.json 声明的素材都已生成', want.length > 0 && want.every(x => assets[x]), want.filter(x => !assets[x]).join('、') || `${want.length} 个齐全`, '齐全');
    const glbs = Object.keys(assets).filter(x => x.endsWith('.glb'));
    ph.check('至少导出一个 GLB', glbs.length > 0, glbs.join('、') || '无', '≥ 1 个');
    for (const g of glbs) {
      const magic = fs.readFileSync(path.join(media, g)).subarray(0, 4).toString('latin1');
      ph.check(`${g} 是 glTF 二进制`, magic === 'glTF', magic, 'glTF');
    }
    let recorded = {};
    try { recorded = JSON.parse(fs.readFileSync(manifest, 'utf8')).assets || {}; } catch { /* 下一条核对会失败 */ }
    const wrong = want.filter(x => recorded[x] !== assets[x]?.sha256);
    ph.check('prepared.json 记录的哈希与文件一致', !wrong.length, wrong.join('、') || `${want.length} 个一致`, '全部一致');
    // 资产桥的确定性：同一份 film.json 再准备一遍，产物逐字节相同（B 路线的复现依据就是 prepared.json 里的哈希）
    await prepare();
    const again = snapshot();
    const changed = want.filter(x => again[x]?.sha256 !== assets[x]?.sha256);
    ph.check('再准备一遍，产物逐字节相同', !changed.length, changed.join('、') || `${want.length} 个相同`, '全部相同');
    ctx.bFilm = f;
  },

  // 只在本机有原生运行时（RAEA_BIN）时跑：小尺寸出片，按与 A、C 相同的规格核对。仓库不分发运行时（D03），CI 上总是跳过。
  async 'b-render'(ph, ctx) {
    const bin = process.env.RAEA_BIN;
    if (!bin || !fs.existsSync(bin)) {
      ph.status = 'skip';
      ph.reason = bin ? `RAEA_BIN 指向的 ${bin} 不存在` : '没有设 RAEA_BIN（原生运行时不随仓库分发）：B 路线只核对到素材准备';
      process.stderr.write(`  · ${ph.reason}\n`);
      return;
    }
    let f = ctx.bFilm;
    if (!f) {
      f = await newFilm(ph, ctx, 'b');
      await step(ctx, 'B 素材准备（prepare.mjs）', process.execPath, [path.join(ctx.root, 'engine/native/prepare.mjs'), f.dir], { PYTHON: ctx.pyExe });
    }
    const [w, h] = ctx.sizeC;
    const fj = path.join(f.dir, 'film.json');
    const film = { ...JSON.parse(fs.readFileSync(fj, 'utf8')), size: [w, h] };
    fs.writeFileSync(fj, JSON.stringify(film, null, 2) + '\n');
    await step(ctx, 'B 出片（native.mjs）', process.execPath, [path.join(ctx.root, 'engine/render/native.mjs'), f.dir, '--quality', 'draft'], { RAEA_BIN: bin });
    const outRel = film.native?.output || `out/${f.name}.mp4`, mp4 = path.join(f.dir, ...outRel.split('/'));
    if (!ph.check('成片存在', fs.existsSync(mp4), `${f.rel}/${outRel}`, '存在')) return;
    checkFilm(ph, mp4, { w, h, frames: Math.round(film.dur * film.fps), fps: film.fps });
    keep(ph, ctx, mp4, 'b/film.mp4', 'video');
    const mid = Math.floor(Math.round(film.dur * film.fps) / 2), still = path.join(ctx.out, 'b', `mid_${mid}.jpg`);
    const x = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vf', `select=eq(n\\,${mid})`, '-frames:v', '1', '-q:v', '3', still]);
    if (x.status === 0 && fs.existsSync(still)) ph.outputs.push({ path: path.relative(ctx.root, still).split(path.sep).join('/'), sha256: sha256(still), kind: 'still' });
  },

  async beiming(ph, ctx) {
    const size = ctx.sizeB.join('x'), outB = path.join(ctx.out, 'beiming'), outL = path.join(ctx.out, 'lab');
    fs.rmSync(outB, { recursive: true, force: true }); fs.rmSync(outL, { recursive: true, force: true });
    const still = path.join(ctx.root, 'engine/render/still.mjs');
    await step(ctx, '《北冥》静帧', process.execPath, [still, '.', '1.5', '4.0', '7.6', '--size', size, '--out', outB]);
    await step(ctx, 'lab 自测页 look', process.execPath, [still, '.', '1.0', '--query', 'test=look', '--size', size, '--out', outL, '--prefix', 'look_']);
    for (const [dir, rel] of [[outB, 'beiming'], [outL, 'lab']]) {
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => x.endsWith('.jpg')).sort() : [];
      ph.check(`${rel} 静帧已生成`, files.length > 0, files.join('、') || '无', '≥ 1 张');
      for (const x of files) {
        const p = path.join(dir, x), st = lumaStats(p);
        ph.check(`${rel}/${x} 不是黑屏或纯色`, notBlank(st), `YMAX ${st.ymax}，YLOW–YHIGH ${st.ylow}–${st.yhigh}`, 'YMAX ≥ 32 且 YHIGH − YLOW ≥ 6');
        ph.outputs.push({ path: path.relative(ctx.root, p).split(path.sep).join('/'), sha256: sha256(p), kind: 'still' });
      }
    }
  },

  // P08 的金标准工具：只依赖 capture / compare 两个子命令、--set、--json 与附录 C1 退出码（不一致 → 4）
  async golden(ph, ctx) {
    const tool = path.join(ctx.root, 'tools/baseline/golden.mjs');
    if (!fs.existsSync(tool)) { ph.status = 'skip'; ph.reason = 'tools/baseline/golden.mjs 还没合入（P08），本次没有金标准比对'; process.stderr.write(`  · ${ph.reason}\n`); return; }
    if (!ctx.platform) {
      ph.status = 'skip';
      ph.reason = '不是软件渲染（BEIMING_ANGLE≠swiftshader）：冒烟只比对 SwiftShader 金标准；本机 GPU 的金标准用 node tools/baseline/golden.mjs compare 自己比对';
      process.stderr.write(`  · ${ph.reason}\n`);
      return;
    }
    const manifestRel = `tests/golden/${ctx.platform}/manifest.json`, manifest = path.join(ctx.root, manifestRel);
    const help = spawnSync(process.execPath, [tool, '--help'], { cwd: ctx.root, encoding: 'utf8', timeout: 30000 });
    const platformArgs = /--platform\b/.test(help.stdout || '') ? ['--platform', ctx.platform] : [];
    const sets = ctx.sets.flatMap(s => ['--set', s]);
    const mode = ctx.golden === 'auto' ? (fs.existsSync(manifest) ? 'compare' : 'capture') : ctx.golden;
    ph.details.mode = mode; ph.details.platform = ctx.platform; ph.details.sets = ctx.sets;
    if (mode === 'compare') {
      if (!fs.existsSync(manifest)) throw new CliError(EXIT.CONTRACT, 'GOLDEN_MISSING', `没有 ${manifestRel}：先用 --golden capture 采集并按 tests/ci/README.md 提交`);
      process.stderr.write(`  $ node tools/baseline/golden.mjs compare ${[...sets, ...platformArgs].join(' ')} --json\n`);
      const r = await run(process.execPath, [tool, 'compare', ...sets, ...platformArgs, '--json'], { cwd: ctx.root, env: { ...process.env, ...ctx.childEnv }, timeoutMs: ctx.timeoutMs, stdout: 'capture', stderr: 'pipe' });
      let j = null; try { j = JSON.parse(r.stdout); } catch { /* 按退出码判 */ }
      ph.details.result = j;
      if (r.timedOut) throw Object.assign(new Error('golden compare 超时'), { timedOut: true, exitCode: EXIT.TIMEOUT });
      if (r.code !== 0) {
        ph.status = 'fail'; ph.exitCode = r.code === EXIT.CONTRACT ? EXIT.CONTRACT : EXIT.FAIL;
        ph.reason = `golden compare 退出码 ${r.code}${j?.error?.message ? `：${j.error.message}` : ''}（像素有变化：确认是有意改动后按 docs/style-baselines/POLICY.md 走基线更新）`;
        return;
      }
      ph.check(`与 ${manifestRel} 一致`, true, '0 差异', '0 差异');
      return;
    }
    // capture：把采集结果放进 --out/golden-capture/（保持仓库相对路径，下载后在仓库根目录解开即可）
    process.stderr.write(`  $ node tools/baseline/golden.mjs capture ${[...sets, ...platformArgs].join(' ')} --json\n`);
    const before = fs.existsSync(path.dirname(manifest));
    const r = await run(process.execPath, [tool, 'capture', ...sets, ...platformArgs, '--json'], { cwd: ctx.root, env: { ...process.env, ...ctx.childEnv }, timeoutMs: ctx.timeoutMs, stdout: 'capture', stderr: 'pipe' });
    if (r.timedOut) throw Object.assign(new Error('golden capture 超时'), { timedOut: true, exitCode: EXIT.TIMEOUT });
    if (r.code !== 0) throw new Error(`golden capture 退出码 ${r.code}：${(r.stderr || '').trim().split('\n').pop()}`);
    if (!ph.check(`采集写出了 ${manifestRel}`, fs.existsSync(manifest), fs.existsSync(manifest) ? '存在' : '不存在', `存在（平台键要等于 ${ctx.platform}）`)) return;
    const dst = path.join(ctx.out, 'golden-capture', 'tests/golden', ctx.platform);
    fs.cpSync(path.dirname(manifest), dst, { recursive: true });
    for (const x of walkFiles(dst)) ph.outputs.push({ path: path.relative(ctx.root, x).split(path.sep).join('/'), sha256: sha256(x), kind: x.endsWith('manifest.json') ? 'golden-manifest' : 'golden-frame' });
    if (!before && process.env.CI !== 'true') ctx.warnings.push(`本机采集写进了 tests/golden/${ctx.platform}/（未跟踪），确认无用后可删除`);
    ph.status = 'warn';
    ph.reason = `首次运行：还没有 ${manifestRel}，本次只采集未比对。下载工件 golden-capture，在仓库根目录解开，只提交 manifest.json（帧图按 docs/style-baselines/POLICY.md 放 Release 或 LFS）`;
  },
};
function walkFiles(d, out = []) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkFiles(p, out); else out.push(p); } return out; }

// 把本次的静帧缩放到同一格子里拼成一张（不参与判定）
function contactSheet(phases, ctx) {
  const stills = phases.flatMap(p => p.outputs.filter(o => o.kind === 'still').map(o => path.join(ctx.root, o.path)));
  if (!stills.length || spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) return null;
  const ph = new Phase('contact', TITLES.contact);
  const t0 = Date.now(), tmp = fs.mkdtempSync(path.join(ctx.out, '.tiles-'));
  try {
    const [W, H] = TILE;
    stills.forEach((s, i) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', s, '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=white`, path.join(tmp, `t_${String(i).padStart(3, '0')}.png`)]));
    const cols = Math.min(4, stills.length), rows = Math.ceil(stills.length / cols);
    const out = path.join(ctx.out, 'contact.jpg');
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(tmp, 't_%03d.png'), '-vf', `tile=${cols}x${rows}:padding=4:margin=4:color=white`, '-frames:v', '1', '-q:v', '3', out]);
    if (r.status === 0 && fs.existsSync(out)) {
      ph.outputs.push({ path: path.relative(ctx.root, out).split(path.sep).join('/'), sha256: sha256(out), kind: 'contact-sheet' });
      fs.writeFileSync(path.join(ctx.out, 'contact.json'), JSON.stringify({ columns: cols, tiles: stills.map(s => path.relative(ctx.root, s).split(path.sep).join('/')) }, null, 2) + '\n');
      ph.status = 'pass'; ph.reason = `${stills.length} 张，${cols} 列`;
    } else { ph.status = 'warn'; ph.reason = '接触印没拼成（不影响判定）'; }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  ph.durationMs = Date.now() - t0;
  return ph;
}

const STATUS = { pass: '通过', fail: '失败', warn: '通过（有提示）', skip: '跳过', timeout: '超时', 'not-run': '未运行' };
function printHuman(phases) {
  const rows = phases.map(p => [p.id, p.title, STATUS[p.status] || p.status, `${p.checks.filter(c => c.ok).length}/${p.checks.length}`, p.durationMs ? fmtSec(p.durationMs) : '-', p.reason || '']);
  process.stderr.write(`\n冒烟出片汇总（tests/ci/smoke-render.mjs）\n${table(['阶段', '名称', '结果', '核对', '用时', '说明'], rows)}\n`);
}
function reportActions(phases) {
  if (!inActions()) return;
  for (const p of phases) {
    if (['fail', 'timeout'].includes(p.status)) annotate('error', p.reason || '失败', { title: `冒烟出片：${p.id} · ${p.title}` });
    else if (p.status === 'warn' || p.status === 'skip') annotate('notice', p.reason || '', { title: `冒烟出片：${p.id} · ${p.title}` });
  }
  stepSummary(['### 冒烟出片（smoke-render）', '', '| 阶段 | 名称 | 结果 | 核对 | 用时 | 说明 |', '|---|---|---|---|---|---|',
    ...phases.map(p => `| ${p.id} | ${mdCell(p.title)} | ${STATUS[p.status] || p.status} | ${p.checks.filter(c => c.ok).length}/${p.checks.length} | ${p.durationMs ? fmtSec(p.durationMs) : '-'} | ${mdCell(p.reason || '')} |`), ''].join('\n'));
}

if (isMain(import.meta.url)) process.exitCode = await main();
