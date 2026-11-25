#!/usr/bin/env node
// 北冥 · 渲染内核的回归基线：改内核的内部结构、要求「渲染结果不变」时用。先在改之前记一份基线，每改一步再跑一遍与它比。
//   node beiming/sources/core/chassis/regress.mjs --record   记下当前内核在这台机器上的基线
//   node beiming/sources/core/chassis/regress.mjs --check    再跑一遍，与基线比
// 退出码：0 全同；4 有不同；3 缺工具链（git、cargo、npm、网络、显卡），或这块显卡还没有基线。
// 基线按「显卡名加后端」分文件，放在 regress-baseline/ 下，进仓库；换了显卡或后端要在那台机器上另记一份。比四样：
//   level2   第 2 级的 24 个读数（22 个金属白炉、2 个矩形面光，level2.mjs 的 furnace 与 analytic），全精度，逐位相等。
//   upstream 上游自带的渲染测试（tools/test-render.ts）的全部场景，用我们的程序跑，软件求交（THREERT_HWRT=0）与硬件求交
//            各一遍：每个场景的状态与原始浮点输出的 sha256。离线内核不支持的（实时）、被切掉的功能、缺素材的场景没有输出，
//            只比状态。记基线时每种求交连跑两遍，两遍输出不同的场景登记为不稳定，以后只比状态；已登记的重记时保留。
//   cargo    ../path/ 下 cargo test --locked：不许有失败，通过数不许比基线少（加了测试变多只提示）。
//   perf     新进程里第一帧的毫秒数（显卡初始化、着色器与管线的首次编译、场景装载；16×16、1 采样）与一个固定场景
//            256 采样的稳态秒数，各取三次的中位数。只作记录：比基线慢 10% 以上给告警，不参与判定。
// 每一遍的原始输出留在 out/chassis/regress/upstream-<sw|hw>/（被忽略），要量两个版本差多少时拿去逐像素比。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli } from '../../../../tools/lib/cli.mjs';
import { COMMIT, KERNEL, OUT, PRESETS, UPSTREAM, buildRenderer, cargoPath, ensureNodeModules, ensureUpstream, freshTarget, missing, sourceKey } from './build.mjs';
import { analytic, furnace } from './level2.mjs';

const WORK = path.join(OUT, 'regress');
export const BASELINES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'regress-baseline');
// 计时用的固定场景：上游的 light/many-shadowed（24 盏带阴影的点光照漫反射平面，每个着色点都要过一遍灯光求值）
export const PERF = { scene: 'light-many-shadowed', width: 1920, height: 1080, spp: 256, trials: 3, warn: 0.1 };
// 驱动和系统会把编过的着色器存起来（苹果的系统缓存关不掉），同一份着色器第二次起就量不到编译。所以给计时场景的材质
// 挂一个什么也不改的材质函数，里面比较用的那个数每次都不同（平面的 uv 不超过 1，条件永不成立）：每次都是没编过的着色器
const perfScene = nonce => `import { MaterialFunction } from "@threert/scene";
import build from ${JSON.stringify(path.join(UPSTREAM, 'tests', 'render', `${PERF.scene}.ts`))};
const F = new MaterialFunction("regress_nonce", { params: {}, code: "if (i.uv.x > ${nonce}.0) { o.base = vec3<f32>(0.0); }" });
export default function () {
  const r = build();
  r.scene.traverse(o => { if (o.material) o.material.shader = F.with({}); });
  return r;
}
`;
const MODES = { sw: '软件求交', hw: '硬件求交' };
// 只比原始输出、不比状态的上游场景：上游测试判它用的解析值照上游自己的着色模型算，移植之后不适用，状态不再说明对错
export const OUTPUT_ONLY = {
  'surface/wet-layer-gltf': '湿与干的亮度比，上游的解析值 0.549 照上游的高光模型算；材质改走移植的原理化 BSDF 之后读数是 0.5689，上游测试判它不过',
};
const sha256 = data => createHash('sha256').update(data).digest('hex');
const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1];

/** 基线的文件名：显卡名加后端，小写，其余字符换成连字符 */
export const baselineName = gpu => `${`${gpu.adapter}-${gpu.backend}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`;

/** 子进程的环境：去掉会改渲染结果的两个变量（种子、求交方式），由各处自己设 */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!('THREERT_SEED' in extra)) delete env.THREERT_SEED;
  if (!('THREERT_HWRT' in extra)) delete env.THREERT_HWRT;
  return env;
}

/** 用上游自带的 tools/test-render.ts 把它的全部场景跑一遍，返回 { 场景编号: '状态 sha256' }；没有输出的场景只有状态 */
function upstreamPass(bin, mode) {
  const out = path.join(WORK, `upstream-${mode}`);
  fs.rmSync(out, { recursive: true, force: true }); // 上一遍留下的原始输出不能算进这一遍
  fs.mkdirSync(out, { recursive: true });
  const log = fs.openSync(path.join(out, 'run.log'), 'w');
  // 它有场景不过就退出 1（被切掉的功能必然不过），所以不看退出码，看它写没写出结果
  spawnSync(process.execPath, [path.join(UPSTREAM, 'tools', 'test-render.ts'), '--out', out, '--json', path.join(out, 'results.json')],
    { cwd: UPSTREAM, stdio: ['ignore', log, log], env: cleanEnv({ THREERT_BIN: bin, THREERT_GPU_LOCK: path.join(WORK, 'gpu.lock'), ...(mode === 'sw' && { THREERT_HWRT: '0' }) }) });
  fs.closeSync(log);
  // 它按文件名的次序跑、每个文件出一条结果，原始输出以文件名命名
  const files = fs.readdirSync(path.join(UPSTREAM, 'tests', 'render')).filter(f => f.endsWith('.ts') && f !== 'lib.ts').sort();
  let results;
  try { results = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).results; } catch { throw new Error(`上游的渲染测试（${MODES[mode]}）没跑完，渲染程序可能中途退出了；日志在 ${path.join(out, 'run.log')}`); }
  const scenes = Object.fromEntries(results.map((r, k) => {
    const raw = path.join(out, files[k].replace(/\.ts$/, '.raw'));
    return [r.id, fs.existsSync(raw) ? `${r.status} ${sha256(fs.readFileSync(raw))}` : r.status];
  }));
  if (results.length !== files.length || Object.keys(scenes).length !== files.length) throw new Error(`上游的渲染测试（${MODES[mode]}）：${files.length} 个场景文件，结果 ${results.length} 条、编号 ${Object.keys(scenes).length} 个，对不上`);
  return scenes;
}

/** 一种求交方式跑 passes 遍：第一遍的结果，加上各遍之间不同的场景（不稳定，只留状态） */
function upstream(bin, mode, passes, known = []) {
  const runs = Array.from({ length: passes }, () => upstreamPass(bin, mode));
  const unstable = [...new Set([...known, ...Object.keys(runs[0]).filter(id => runs.some(r => r[id] !== runs[0][id]))])].filter(id => id in runs[0]).sort();
  const scenes = { ...runs[0] };
  for (const id of unstable) scenes[id] = scenes[id].split(' ')[0];
  return { unstable, scenes };
}

async function level2(bin) {
  const f = await furnace(bin), a = await analytic(bin);
  return Object.fromEntries([...f.rows.map(r => [`白炉 ${r.distribution} ${r.roughness}`, r.ours]), ...a.map(x => [`面光 ${x.name}`, x.mean])]);
}

function cargoTests() {
  // 编好的程序已经在缓存里时 buildRenderer 不碰构建目录：这里自己确认测试是从现在这份源码编的
  freshTarget(path.join(OUT, 'target'), sourceKey());
  const r = spawnSync(cargoPath(), ['test', '--locked'], { cwd: KERNEL, encoding: 'utf8', maxBuffer: 1 << 28, env: cleanEnv({ CARGO_TARGET_DIR: path.join(OUT, 'target') }) });
  if (r.error) throw r.error;
  const sums = [...r.stdout.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)];
  if (!sums.length) throw new Error(`cargo test 没跑起来（编不过？）：\n${r.stderr.split('\n').slice(-30).join('\n')}`);
  const total = k => sums.reduce((s, m) => s + +m[k], 0);
  return { passed: total(1), failed: total(2), ignored: total(3), failures: [...r.stdout.matchAll(/^test (\S+) \.\.\. FAILED$/gm)].map(m => m[1]) };
}

/** 一个新的渲染进程、一份没编过的着色器：先渲 16×16、1 采样（整段耗时几乎全是初始化与编译），再渲 256 采样取采样那一段的耗时 */
async function perfTrial(bin, nonce) {
  const src = path.join(WORK, 'perf.scene.js'), game = path.join(WORK, 'perf.js');
  fs.writeFileSync(src, perfScene(nonce));
  const b = spawnSync(process.execPath, [path.join(UPSTREAM, 'tools', 'bundle-game.ts'), src, '-o', game], { cwd: UPSTREAM, encoding: 'utf8' });
  if (b.status !== 0) throw new Error(`打计时场景的包失败：${b.stderr}`);
  const p = spawn(bin, ['serve', '--presets', PRESETS], { cwd: UPSTREAM, stdio: ['pipe', 'pipe', 'ignore'], env: cleanEnv() });
  const lines = createInterface({ input: p.stdout })[Symbol.asyncIterator]();
  const render = async job => {
    p.stdin.write(`${JSON.stringify({ game, assets: UPSTREAM, out: path.join(WORK, 'perf.png'), denoise: false, ...job })}\n`);
    const reply = JSON.parse((await lines.next()).value ?? '{"ok":false,"error":"渲染进程退出了"}');
    if (!reply.ok) throw new Error(`计时场景没渲出来：${reply.error}`);
    return reply.stats.timings_ms;
  };
  try {
    if ((await lines.next()).done) throw missing('core-render serve 没起来（拿不到显卡？）');
    const first = await render({ id: 1, spp: 1, width: 16, height: 16 });
    const steady = await render({ id: 2, spp: PERF.spp, width: PERF.width, height: PERF.height });
    return { firstFrameMs: first.total_ms, steadyS: steady.trace_ms / 1000 };
  } finally {
    await new Promise(resolve => { p.on('close', resolve); p.stdin.end(); });
  }
}

/**
 * 对当前内核量一遍。passes 是上游场景每种求交跑几遍（记基线时 2，用来找出不稳定的场景）；known(显卡) 给出已登记的不稳定场景 { sw, hw }。
 * 返回的对象就是基线文件的内容。
 */
export async function measure({ passes = 1, known = () => ({}), log = () => {} } = {}) {
  const t0 = Date.now(), seconds = {};
  const stage = async (name, title, fn) => {
    const t = Date.now();
    log(`[${((t - t0) / 1000).toFixed(0)} s] ${title}`);
    const r = await fn();
    seconds[name] = Math.round((Date.now() - t) / 100) / 10;
    return r;
  };
  ensureUpstream();
  const { bin, key } = await stage('build', '构建：从 beiming/sources/core/path/ 编 core-render', () => buildRenderer());
  ensureNodeModules();
  const info = spawnSync(bin, ['info'], { encoding: 'utf8', env: cleanEnv() });
  if (info.status !== 0) throw missing(`core-render info 没跑起来（拿不到显卡？）：${(info.stderr || String(info.error)).trim().split('\n').slice(-3).join(' ')}`);
  const gpu = JSON.parse(info.stdout);
  fs.mkdirSync(WORK, { recursive: true });
  const m = { format: 1, gpu: { adapter: gpu.adapter, backend: gpu.backend, driver: gpu.driver }, kernel: key, upstreamCommit: COMMIT };
  m.level2 = await stage('level2', '第 2 级的 24 个读数', () => level2(bin));
  m.upstream = {};
  for (const mode of Object.keys(MODES)) {
    // 这块显卡没有硬件求交时，「硬件求交」那一遍和软件求交是同一条路，不重复跑
    m.upstream[mode] = mode === 'hw' && !gpu.hwrt ? null : await stage(`upstream-${mode}`, `上游的渲染测试，${MODES[mode]}${passes > 1 ? `，${passes} 遍` : ''}`, () => upstream(bin, mode, passes, known(m.gpu)[mode]));
  }
  m.cargo = await stage('cargo', 'cargo test --locked', () => cargoTests());
  m.perf = await stage('perf', `计时：${PERF.scene} ${PERF.width}×${PERF.height}、${PERF.spp} 采样，${PERF.trials} 次`, async () => {
    const trials = [], nonce = Math.floor(Date.now() / 1000) % 4e6 * 4 + 1; // 每秒、每次都不同，小于 2^24（单精度里是整数）
    for (let k = 0; k < PERF.trials; k++) trials.push(await perfTrial(bin, nonce + k));
    const samples = { firstFrameMs: trials.map(t => t.firstFrameMs), steadyS: trials.map(t => t.steadyS) };
    return { scene: PERF.scene, width: PERF.width, height: PERF.height, spp: PERF.spp, firstFrameMs: median(samples.firstFrameMs), steadyS: median(samples.steadyS), samples };
  });
  seconds.total = Math.round((Date.now() - t0) / 100) / 10;
  log(`[${seconds.total.toFixed(0)} s] 完成`);
  return { measurement: m, seconds };
}

/** 基线与现在的两份量出来的结果比：diffs 是判不过的，warnings 只提示 */
export function compare(base, now) {
  const diffs = [], warnings = [];
  const keys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys(base.level2, now.level2)) {
    const [a, b] = [base.level2[k], now.level2[k]];
    if (!Object.is(a, b)) diffs.push(`读数「${k}」：基线 ${a}，现在 ${b}${a && b ? `，相对差 ${(b / a - 1).toExponential(2)}` : ''}`);
  }
  for (const mode of Object.keys(MODES)) {
    const [a, b] = [base.upstream[mode], now.upstream[mode]];
    if (!a || !b) {
      if (a || b) diffs.push(`上游场景（${MODES[mode]}）：${a ? '基线有、这次没跑' : '基线没有、这次跑了'}（显卡的硬件求交能力变了？）`);
      continue;
    }
    const unstable = new Set(a.unstable);
    for (const id of keys(a.scenes, b.scenes)) {
      // 已登记不稳定的只比状态
      // 已登记只比原始输出的不比状态
      const [x, y] = [a.scenes[id], b.scenes[id]].map(s => (unstable.has(id) ? s?.split(' ')[0] : id in OUTPUT_ONLY ? s?.split(' ')[1] ?? s : s));
      if (x === y) continue;
      const [sx, sy] = [x, y].map(s => s?.split(' ')[0] ?? '没有这个场景');
      diffs.push(`上游场景 ${id}（${MODES[mode]}）：${sx === sy ? `状态都是 ${sx}，原始输出不同` : `状态 ${sx} → ${sy}`}`);
    }
  }
  if (now.cargo.failed > 0) diffs.push(`cargo test：${now.cargo.failed} 个失败（${now.cargo.failures.join('、')}）`);
  if (now.cargo.passed < base.cargo.passed) diffs.push(`cargo test：通过数 ${base.cargo.passed} → ${now.cargo.passed}，少了`);
  if (now.cargo.passed > base.cargo.passed) warnings.push(`cargo test：通过数 ${base.cargo.passed} → ${now.cargo.passed}（多了测试）`);
  const pct = (a, b) => `${b >= a ? '+' : ''}${((b / a - 1) * 100).toFixed(1)}%`;
  const [p, q] = [base.perf, now.perf];
  if (q.steadyS > p.steadyS * (1 + PERF.warn)) warnings.push(`稳态变慢：${p.steadyS.toFixed(3)} s → ${q.steadyS.toFixed(3)} s（${pct(p.steadyS, q.steadyS)}，超过 ${PERF.warn * 100}%）`);
  if (q.firstFrameMs > p.firstFrameMs * (1 + PERF.warn)) warnings.push(`第一帧变慢：${p.firstFrameMs.toFixed(0)} ms → ${q.firstFrameMs.toFixed(0)} ms（${pct(p.firstFrameMs, q.firstFrameMs)}）`);
  if (base.gpu.driver !== now.gpu.driver) warnings.push(`驱动与记基线时不同：${base.gpu.driver || '（空）'} → ${now.gpu.driver || '（空）'}`);
  return { diffs, warnings };
}

/** 一份量出来的结果里各类场景的个数（两种求交各一组） */
export function tally(m) {
  return Object.fromEntries(Object.keys(MODES).filter(mode => m.upstream[mode]).map(mode => {
    const u = m.upstream[mode], count = {};
    for (const s of Object.values(u.scenes)) count[s.split(' ')[0]] = (count[s.split(' ')[0]] ?? 0) + 1;
    return [mode, { scenes: Object.keys(u.scenes).length, ...count, withOutput: Object.entries(u.scenes).filter(([id, x]) => x.includes(' ') || u.unstable.includes(id)).length, unstable: u.unstable.length }];
  }));
}

export const command = defineCommand({
  name: 'chassis-regress',
  summary: '渲染内核的回归基线：记下或核对第 2 级读数、上游场景的原始输出摘要、cargo test 通过数与两项计时',
  usage: ['node beiming/sources/core/chassis/regress.mjs --record', 'node beiming/sources/core/chassis/regress.mjs --check'],
  options: {
    record: { type: 'boolean', describe: '记下当前内核在这台机器上的基线（写 regress-baseline/<显卡加后端>.json）' },
    check: { type: 'boolean', describe: '再跑一遍，与这块显卡的基线比' },
  },
  exitCodes: { 0: '记好了，或与基线全同', 2: '用法错误', 3: '缺工具链，或这块显卡还没有基线', 4: '与基线有不同' },
  async run(ctx) {
    if (!ctx.opts.record === !ctx.opts.check) throw new CliError('usage.regress-mode', '--record 与 --check 要且只要一个', '先 --record 记基线，改完内核再 --check');
    const read = file => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
    const run = async opts => {
      try {
        return await measure({ log: s => ctx.log.info(s), ...opts });
      } catch (e) {
        if (e.missing) throw new CliError('env.chassis-toolchain', `缺工具链：${e.missing}`, '要 git、cargo（Rust 1.100.0，可以在 ~/.cargo/bin）、npm、第一次取源码时的网络，以及能跑 wgpu 的显卡');
        throw e;
      }
    };
    const summary = (m, seconds) => {
      for (const [mode, t] of Object.entries(tally(m))) ctx.out(`上游场景（${MODES[mode]}）：${JSON.stringify(t)}${m.upstream[mode].unstable.length ? `；不稳定：${m.upstream[mode].unstable.join('、')}` : ''}`);
      ctx.out(`cargo test：${m.cargo.passed} 过、${m.cargo.failed} 失败、${m.cargo.ignored} 忽略；第一帧 ${m.perf.firstFrameMs.toFixed(0)} ms，稳态 ${m.perf.steadyS.toFixed(3)} s（各 ${PERF.trials} 次：${JSON.stringify(m.perf.samples)}）`);
      ctx.out(`各段秒数：${JSON.stringify(seconds)}`);
    };
    if (ctx.opts.record) {
      // 已登记的不稳定场景从这块显卡的旧基线带过来
      const known = gpu => {
        const old = read(path.join(BASELINES, baselineName(gpu)));
        return { sw: old?.upstream.sw?.unstable, hw: old?.upstream.hw?.unstable };
      };
      const { measurement: m, seconds } = await run({ passes: 2, known });
      const file = path.join(BASELINES, baselineName(m.gpu));
      fs.mkdirSync(BASELINES, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(m, null, 1)}\n`);
      summary(m, seconds);
      ctx.out(`基线写到 ${file}`);
      return { data: { baseline: file, seconds, tally: tally(m) }, outputs: [{ path: file, kind: 'report' }] };
    }
    const { measurement: now, seconds } = await run({});
    fs.writeFileSync(path.join(WORK, 'last.json'), `${JSON.stringify(now, null, 1)}\n`);
    const file = path.join(BASELINES, baselineName(now.gpu));
    const base = read(file);
    if (!base) throw new CliError('env.regress-baseline', `这块显卡（${now.gpu.adapter}，${now.gpu.backend}）还没有基线：${file}`, '在改内核之前的提交上运行 regress.mjs --record');
    const { diffs, warnings } = compare(base, now);
    for (const mode of Object.keys(MODES)) if (now.upstream[mode] && base.upstream[mode]) now.upstream[mode].unstable = base.upstream[mode].unstable; // 汇总里照基线的登记显示
    summary(now, seconds);
    ctx.out(`基线记于内核 ${base.kernel}，现在是 ${now.kernel}`);
    for (const w of warnings) ctx.out(`提示 ${w}`);
    for (const d of diffs) ctx.out(`✗ ${d}`);
    ctx.out(diffs.length ? `与基线有 ${diffs.length} 处不同；这次量到的全部结果在 ${path.join(WORK, 'last.json')}` : '与基线全同');
    return { data: { baseline: file, seconds, tally: tally(now), diffs, warnings }, warnings, ...(diffs.length && { error: { code: 'contract.chassis-regress', message: `与基线有 ${diffs.length} 处不同`, hint: `逐条见上；原始输出在 ${WORK}` } }) };
  },
});

if (isMain(import.meta.url)) await runCli(command);
