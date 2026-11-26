// 核心帧源对上层的接口（帧源接口契约 3.2 的 caps、open 与会话的 manifest、render、query、close）。宿主是 node 这一侧：
// 每次 render 起一次渲染程序 core-render render-pack，从场景包出层；元数据（相机、实体的包围盒与深度范围、场景查询）在这里
// 直接读场景包算，不问渲染器。镜头条目是 build-script 模式，entry 指向场景包（目录或它的 pack.json，相对片子描述所在的目录）。
// 只进看板、不出成片：env.tier 是 final 时 open 报错。装载之前的判定（宿主、作者模式、锁、卡、资产、叠加层）和场景查询的写法
// 与 three 帧源共用 ../three/plan.mjs；元数据的算式与页面宿主共用 ../../host/page/measure.js。
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { answerQuery, clipStats, lumaStats, measureEntity } from '../../host/page/measure.js';
import { killProcessTree, runWithWatchdog } from '../../jobs/watchdog.mjs';
import { renderingOf } from '../../kernel/eval/input.mjs';
import { SourceError, declared, planFrame, planOpen, planQuery } from '../three/plan.mjs';
import { HOST, caps } from './caps.mjs';
import { OUT, PRESETS, buildRenderer, sourceKey } from './chassis/build.mjs';

export { SourceError };
const { structuredClone } = globalThis;
const ENV_KEYS = ['lock', 'tier', 'workspace', 'filmDir'];
const NOT_YET = '核心帧源还没过门：只进看板、不出成片';
/** 内核出的层文件（render-pack --passes 的文件名与分量，见 path/README.md「读场景包」） */
const LAYERS = {
  color: ['color.f32', ['R', 'G', 'B', 'A']],
  depth: ['depth.f32', ['Z']],
  objectId: ['objectId.u32', ['id']],
  normal: ['normal.f32', ['X', 'Y', 'Z']],
  denoiseAlbedo: ['denoiseAlbedo.f32', ['R', 'G', 'B']],
  denoiseNormal: ['denoiseNormal.f32', ['X', 'Y', 'Z']],
};
const bad = (message) => new SourceError('usage.bad-argument', message);
const show = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pad = (n, width) => String(n).padStart(width, '0');
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** 编好的渲染程序：环境变量 BEIMING_CORE_RENDER，再没有就取 chassis/build.mjs 按这份内核源码编好的那份；都没有报 env.missing-tool，不现编 */
export function findRenderer() {
  if (process.env.BEIMING_CORE_RENDER) return process.env.BEIMING_CORE_RENDER;
  const bin = join(OUT, 'bin', `core-render-${sourceKey()}${process.platform === 'win32' ? '.exe' : ''}`);
  if (existsSync(bin)) return bin;
  throw new SourceError('env.missing-tool', `没有编好的渲染程序 core-render（${basename(bin)}）：先用 chassis/build.mjs 的 buildRenderer 编一份（要 cargo），或设 BEIMING_CORE_RENDER 指向编好的程序`);
}

const lastJson = (text) => JSON.parse(text.trim().split('\n').at(-1));
/** core-render 退出码不是 0：stderr 最后一行是 {"error":{code,at,message}} 就报那个码，否则原样报错 */
function failure(stderr, cmd, code) {
  const lines = stderr.trim().split('\n');
  let e;
  try { e = JSON.parse(lines.at(-1)).error; } catch { /* 不是带码的错 */ }
  return e?.code ? new SourceError(e.code, `场景包 ${e.at}：${e.message}`) : new Error(`core-render ${cmd} 退出码 ${code}：${lines.slice(-5).join('\n')}`);
}

/** 起一次 core-render；退出码不是 0 时，stderr 最后一行是 {"error":{code,at,message}} 就报那个码，否则原样报错。
 *  给了 seed 时内核的种子就是它（THREERT_SEED），外层环境里的 THREERT_SEED、THREERT_HWRT 不传下去。
 *  进程由 jobs 的看门狗管（受管进程树）：给了 deadline（performance.now() 的毫秒）时，到点先 SIGTERM、过宽限 SIGKILL 整棵进程树，
 *  报 timeout.budget。显卡租约由作业拿（调度器的 core 道），这里不另要。procs 是帧源的在跑进程集合，stop 时照它收 */
async function run(bin, args, seed, deadline, procs) {
  const { THREERT_SEED: _s, THREERT_HWRT: _h, ...env } = process.env;
  if (seed !== undefined) env.THREERT_SEED = String(seed);
  const frameTimeoutMs = deadline === undefined ? undefined : Math.min(2 ** 31 - 1, Math.max(1, Math.ceil(deadline - performance.now())));
  try {
    return await runWithWatchdog({ quotas: frameTimeoutMs === undefined ? {} : { frameTimeoutMs } }, ({ watchdog }) => watchdog.runFrame(0, () => new Promise((ok, fail) => {
      const child = watchdog.spawnManaged(bin, [...args, '--presets', PRESETS], { stdio: ['ignore', 'pipe', 'pipe'], env });
      procs.add(child);
      const out = [], err = [];
      child.stdout.on('data', (b) => out.push(b));
      child.stderr.on('data', (b) => err.push(b));
      child.on('error', fail);
      child.on('close', (code, signal) => {
        procs.delete(child);
        if (code === 0) return ok(lastJson(Buffer.concat(out).toString('utf8')));
        fail(failure(Buffer.concat(err).toString('utf8'), args[0], code ?? signal));
      });
    })));
  } catch (e) {
    if (e?.code !== 'timeout.frame') throw e;
    throw Object.assign(new SourceError('timeout.budget', `timeout.budget：核心作业用完了声明的墙钟预算 maxWallMs，core-render ${args[0]} 的进程树已被杀`), { killed: e.killed, survivors: e.survivors });
  }
}

// ------------------------------------------------------------------------------------------------ 读场景包（只读元数据要的几样）

/** 二进制表按 f32 或 u32 读成数组（带 byteOffset） */
const table = (dir, file) => {
  const b = readFileSync(join(dir, file));
  return file.endsWith('.u32') ? new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4) : new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

/** GLB 里每个网格的顶点位置（全部图元的 POSITION 摊平成 [x, y, z, …]）。内核读过、校验过这个文件，这里不再查 */
function meshPositions(file) {
  const b = readFileSync(file);
  const jsonLen = b.readUInt32LE(12), json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen));
  const bin = 20 + jsonLen + 8;
  return json.meshes.map((m) => m.primitives.flatMap((p) => {
    const acc = json.accessors[p.attributes.POSITION], view = json.bufferViews[acc.bufferView];
    const start = bin + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0), stride = view.byteStride ?? 12;
    return Array.from({ length: acc.count * 3 }, (_, i) => b.readFloatLE(start + Math.floor(i / 3) * stride + (i % 3) * 4));
  }));
}

/** 场景包目录：entry 是目录，或者目录里的 pack.json */
const packDir = (filmDir, entry) => {
  const p = resolve(filmDir, entry);
  return basename(p) === 'pack.json' ? dirname(p) : p;
};

/** 读进场景包里元数据要的几样：清单、实例表、每帧的实例矩阵与相机行、每个网格的顶点 */
function loadPack(dir) {
  const m = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8'));
  const rows = table(dir, m.instances.file);
  const cam = m.frames.camera;
  // 相机表每行的列：mat16 占 16 个数，别的各占 1 个
  const col = {}; let w = 0;
  for (const f of cam.fields) { col[f] = w; w += f === 'mat16' ? 16 : 1; }
  return {
    m,
    rows: Array.from({ length: m.instances.shape[0] }, (_, i) => ({ mesh: rows[i * 4], entity: rows[i * 4 + 2], name: m.instances.names[i], class: m.instances.class[i] })),
    instances: table(dir, m.frames.instances.file),
    camera: table(dir, cam.file), camCols: col, camWidth: w,
    meshes: meshPositions(join(dir, m.geometry.file)),
  };
}

const det3 = (a) => a[0] * (a[5] * a[10] - a[9] * a[6]) - a[4] * (a[1] * a[10] - a[9] * a[2]) + a[8] * (a[1] * a[6] - a[5] * a[2]);
const apply = (a, x, y, z) => [a[0] * x + a[4] * y + a[8] * z + a[12], a[1] * x + a[5] * y + a[9] * z + a[13], a[2] * x + a[6] * y + a[10] * z + a[14]];

/** 第 k 帧每个实体画出来的顶点（世界坐标）：{ 实体名: { id, class, points } }。照内核的规矩，左上 3×3 行列式为 0 的行这一帧不画 */
function entityPoints(pack, k) {
  const out = {}, n = pack.rows.length;
  pack.rows.forEach((r, i) => {
    const a = Array.from(pack.instances.subarray((k * n + i) * 16, (k * n + i + 1) * 16));
    if (Math.abs(det3(a)) <= 1e-30) return;
    const e = (out[r.name] ??= { id: r.entity, class: r.class, points: [] });
    const v = pack.meshes[r.mesh];
    for (let j = 0; j < v.length; j += 3) e.points.push(apply(a, v[j], v[j + 1], v[j + 2]));
  });
  return out;
}

/** 第 k 帧的相机：元数据的 camera（不含快门角）与 view（相机到世界的逆）、proj */
function cameraAt(pack, k, size) {
  const row = pack.camera.subarray(k * pack.camWidth, (k + 1) * pack.camWidth), c = pack.camCols;
  const world = Array.from(row.subarray(c.mat16, c.mat16 + 16));
  const fov = row[c.fovY], { near, far, sensorHeight } = pack.m.camera;
  const t = 1 / Math.tan(fov / 2);
  const proj = [t * size[1] / size[0], 0, 0, 0, 0, t, 0, 0, 0, 0, -(far + near) / (far - near), -1, 0, 0, (-2 * far * near) / (far - near), 0];
  // shortcut: 相机矩阵当刚体求逆（转置旋转、反推平移）；场景包的相机要带缩放时换成一般的 4×4 求逆
  const r = (i, j) => world[j * 4 + i];
  const p = [world[12], world[13], world[14]];
  const view = [r(0, 0), r(0, 1), r(0, 2), 0, r(1, 0), r(1, 1), r(1, 2), 0, r(2, 0), r(2, 1), r(2, 2), 0, 0, 0, 0, 1];
  for (let i = 0; i < 3; i++) view[12 + i] = -(r(0, i) * p[0] + r(1, i) * p[1] + r(2, i) * p[2]);
  const dof = c.focusDist !== undefined ? { focusDist: row[c.focusDist], fstop: row[c.fstop], sensorHeightM: sensorHeight } : {};
  return { camera: { world, proj, fovYDeg: (fov * 180) / Math.PI, near, far, ...dof }, view, proj };
}

// ------------------------------------------------------------------------------------------------ 一次 render 的计划

/**
 * 交不出的请求报带码的错：要的输出没声明 → contract.unsupported-output；快门参数出值域 → usage.bad-argument；
 * 快门角 0 配多个子帧 → contract.shutter-conflict；快门角大于 0 → contract.unsupported-option（内核没有运动模糊）；
 * 采样数、缩放出值域 → usage.bad-argument。取值次序：这次调用 → 锁文件 → 镜头条目 → 能力声明。
 */
export function planRender(c, shot, size, tier, opts, want, locked) {
  if (!Array.isArray(want) || want.some((n) => typeof n !== 'string') || new Set(want).size !== want.length) throw bad('want 必须是不重复的输出名数组');
  const missing = want.filter((n) => n !== 'meta' && !declared(c, n));
  if (missing.length) throw new SourceError('contract.unsupported-output', `核心帧源交不出：${missing.join('、')}`);
  if (!record(opts ?? {}) || (opts?.shutter !== undefined && !record(opts.shutter))) throw bad('opts 和 opts.shutter 必须是对象');
  const o = opts ?? {}, mine = o.shutter ?? {}, theirs = record(shot.shutter) ? shot.shutter : {};
  const angleDeg = mine.angleDeg ?? theirs.angleDeg ?? 0;
  const shutterSamples = mine.samples ?? locked.shutterSamples ?? theirs.samples ?? 1;
  if (typeof angleDeg !== 'number' || !(angleDeg >= 0 && angleDeg <= 360)) throw bad(`快门角必须在 [0, 360] 度，给的是 ${show(angleDeg)}`);
  if (!Number.isInteger(shutterSamples) || shutterSamples < 1) throw bad(`子帧采样数必须是不小于 1 的整数，给的是 ${show(shutterSamples)}`);
  if (angleDeg === 0 && shutterSamples > 1) throw new SourceError('contract.shutter-conflict', `快门角是 0，子帧采样数却是 ${shutterSamples}`);
  if (angleDeg > 0) throw new SourceError('contract.unsupported-option', `核心帧源的运动模糊还没做：生效的快门角是 ${angleDeg} 度，只能出快门角 0 的帧`);
  const preset = record(shot.tiers?.[tier]) ? shot.tiers[tier] : {};
  const scale = o.scale ?? preset.scale ?? c[tier].scale;
  const samples = o.samples ?? preset.samples ?? c[tier].samples;
  if (typeof scale !== 'number' || !(scale > 0 && scale <= 1)) throw bad(`scale 必须在 (0, 1]，给的是 ${show(scale)}`);
  if (!Number.isInteger(samples) || samples < 1 || samples > 2 ** 32 - 1) throw bad(`每像素采样数必须是不小于 1 的整数，给的是 ${show(samples)}`);
  return {
    angleDeg,
    samples,
    size: [Math.max(1, Math.round(size[0] * scale)), Math.max(1, Math.round(size[1] * scale))],
    // 没要颜色层就是「只要元数据」：不出像素
    layers: want.includes('color') ? want.filter((n) => n !== 'meta') : [],
  };
}

// ------------------------------------------------------------------------------------------------ 作业准入

/** 每档每像素采样数的上限：草稿档不超过终稿档的默认采样数（终稿档在 open 时就拒，不进准入） */
export const SPP_MAX = { draft: caps('').final.samples };
/** 每档墙钟预算 maxWallMs 的上限。核心作业不被终渲抢占（jobs/DETAILS「调度器的道」），这个数就是同一块卡上的终渲最多被一个核心作业
 *  挡住多久：草稿档 10 分钟。看板一次只出少量帧，一个作业渲不完就拆成几个，在 core 道里排队，终渲在两个作业之间插得进去 */
export const WALL_MAX = { draft: 10 * 60 * 1000 };
/** 一次准入里全部 pack-info 加起来的时限。准入在 HTTP 处理里同步跑（submit 是同步的），这个数就是一次提交最多把服务端挡住多久；
 *  pack-info 只读场景包的清单与网格计数、不碰显卡，两块板的小包几毫秒，留足大包的余量又不让挂住的程序拖住服务端：5 秒 */
export const ADMIT_MS = 5000;
const BUDGET_KEYS = { maxTriangles: Number.MAX_SAFE_INTEGER, spp: 2 ** 32 - 1, maxWallMs: 2 ** 31 - 1 };

/**
 * 核心作业的准入，入队之前判。budget 是作业声明的 { maxTriangles, spp, maxWallMs }，三项都是正整数（maxWallMs 不超过 2³¹−1）：
 * 缺一项、多一项或值不对报 usage.budget-required。之后报 contract.over-budget 的四种：声明的 spp、maxWallMs 超过这一档的上限（SPP_MAX、WALL_MAX）；
 * 镜头生效的采样数（planRender 的取值次序，这次调用不给 opts）超过声明的 spp；场景包在要渲的帧上画出来的三角形数
 * （core-render pack-info 一行统计里的 triangles，每帧一次）超过 maxTriangles；全部 pack-info 加起来超过 ADMIT_MS 也报这个码。
 * shots 是 [{ shot: 镜头条目, frames: [镜头局部帧号] }]，场景包相对 filmDir；bin 不给时用 findRenderer()（没有报 env.missing-tool）。
 * 交回 { triangles: 各帧里最多的那一帧的三角形数, samples: 生效采样数里最大的 }。
 */
export function admitBudget({ budget, tier, filmDir, shots, bin }) {
  if (!record(budget) || Object.keys(budget).some((k) => !Object.hasOwn(BUDGET_KEYS, k))
    || Object.entries(BUDGET_KEYS).some(([k, max]) => !Number.isSafeInteger(budget[k]) || budget[k] < 1 || budget[k] > max)) {
    throw new SourceError('usage.budget-required', `核心作业要声明预算 budget：{ maxTriangles, spp, maxWallMs } 三项正整数，给的是 ${show(budget)}`);
  }
  const over = (message) => new SourceError('contract.over-budget', message);
  const limit = SPP_MAX[tier];
  if (limit === undefined) throw new SourceError('contract.unsupported-mode', `${NOT_YET}（这次的档位是 ${show(tier)}）`);
  if (budget.spp > limit) throw over(`声明的每像素采样数 ${budget.spp} 超过 ${tier} 档的上限 ${limit}`);
  if (budget.maxWallMs > WALL_MAX[tier]) throw over(`声明的墙钟预算 ${budget.maxWallMs} ms 超过 ${tier} 档的上限 ${WALL_MAX[tier]} ms`);
  const c = caps('');
  let triangles = 0, samples = 0;
  const until = performance.now() + ADMIT_MS;
  for (const { shot, frames } of shots) {
    const { samples: n } = planRender(c, shot, [1, 1], tier, {}, ['color'], {});
    if (n > budget.spp) throw over(`镜头 ${shot.id} 的每像素采样数是 ${n}，超过声明的 ${budget.spp}`);
    samples = Math.max(samples, n);
    const dir = packDir(filmDir, renderingOf(shot).entry);
    for (const f of new Set(frames)) {
      bin ??= findRenderer();
      const left = Math.ceil(until - performance.now());
      const r = left > 0 ? spawnSync(bin, ['pack-info', dir, '--frame', String(f), '--presets', PRESETS], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: left, killSignal: 'SIGKILL' }) : null;
      if (!r || r.error?.code === 'ETIMEDOUT') throw over(`准入的 ${ADMIT_MS} ms 里数不完要渲的帧的三角形（停在镜头 ${shot.id} 第 ${f} 帧）：少渲几帧，或把场景包拆小`);
      if (r.error) throw r.error.code === 'ENOENT' ? new SourceError('env.missing-tool', `起不了渲染程序 ${basename(bin)}`) : r.error;
      if (r.status !== 0) throw failure(r.stderr, 'pack-info', r.status ?? r.signal);
      const info = lastJson(r.stdout);
      if (info.triangles > budget.maxTriangles) throw over(`镜头 ${shot.id} 第 ${f} 帧场景包画出来 ${info.triangles} 个三角形，超过声明的 ${budget.maxTriangles}`);
      triangles = Math.max(triangles, info.triangles);
    }
  }
  return { triangles, samples };
}

// ------------------------------------------------------------------------------------------------ 帧源

/**
 * 起帧源。bin 是渲染程序 core-render（不给时取环境变量 BEIMING_CORE_RENDER，再没有就按 chassis/build.mjs 现编或取编好的那份）。
 * maxWallMs 是作业声明的墙钟预算：从起帧源算起，这个帧源起的每个 core-render 进程到点就被看门狗杀掉（timeout.budget）；不给不限时。
 * 返回 { caps, open, stop }；stop 强杀这个帧源还在跑的 core-render 进程树（作业取消、测试收尾时不留孤儿进程）。
 */
export async function startSource({ bin = process.env.BEIMING_CORE_RENDER, maxWallMs } = {}) {
  if (maxWallMs !== undefined && (!Number.isSafeInteger(maxWallMs) || maxWallMs < 1)) throw bad(`maxWallMs 必须是正整数，给的是 ${show(maxWallMs)}`);
  const deadline = maxWallMs === undefined ? undefined : performance.now() + maxWallMs;
  if (!bin) {
    try { bin = buildRenderer().bin; } catch (e) { throw e.missing ? new SourceError('env.missing-tool', `编不出渲染程序 core-render：${e.message}`) : e; }
  }
  // shortcut: 版本是工作树里内核源码的摘要；bin 是从别处给的时它不一定就是这份源码编的
  const CAPS = caps(sourceKey());
  const procs = new Set();

  async function open(input, env) {
    const missingEnv = ENV_KEYS.filter((k) => !record(env) || env[k] === undefined);
    if (!record(input) || !record(input.shot) || missingEnv.length) throw bad(`input、input.shot 必须是对象，env 要有 ${ENV_KEYS.join('、')}`);
    const locked = planOpen(CAPS, input, env);
    if (env.tier === 'final') throw new SourceError('contract.unsupported-mode', `${NOT_YET}（这次 env.tier 是 final）`);
    const { shot, output } = input, { entry } = renderingOf(shot);
    if (typeof entry !== 'string' || !entry) throw bad('build-script 模式的镜头要写 entry：场景包的目录或它的 pack.json');
    const dir = packDir(env.filmDir, entry);
    const info = await run(bin, ['pack-info', dir], undefined, deadline, procs);
    const frames = shot.out - shot.in;
    if (frames > info.frames) throw bad(`场景包 ${info.id} 只有 ${info.frames} 帧，镜头要 ${frames} 帧`);
    const pack = loadPack(dir);
    const entities = [...new Map(pack.rows.map((r) => [r.entity, { id: r.entity, name: r.name, class: r.class }])).values()].sort((a, b) => a.id - b.id);
    const timeline = input.events?.events ?? [];
    let renders = 0, closed = false;
    const live = () => { if (closed) throw bad('会话已经关了'); };

    return {
      manifest: () => ({ frames, entities: entities.map((e) => ({ ...e })) }),

      /** 渲一帧：层写在 env.workspace 下的 r<会话内序号>-f<帧号>/，交回元数据和层引用；场景包第 f 帧就是镜头局部第 f 帧 */
      async render(f, opts, want) {
        live();
        planFrame(frames, f);
        const plan = planRender(CAPS, shot, output.size, env.tier, opts, want, locked);
        const t0 = performance.now();
        const { camera, view, proj } = cameraAt(pack, f, plan.size);
        const ents = Object.entries(entityPoints(pack, f)).map(([name, e]) => {
          const g = measureEntity(view, proj, plan.size, e.points);
          return { id: e.id, name, class: e.class, bbox2d: g.bbox2d, bbox3d: g.bbox3d, visible: null, pxArea: g.pxArea, depth: g.depth };
        }).sort((a, b) => a.id - b.id);
        const stateMs = performance.now() - t0;
        const pixels = plan.layers.length > 0;
        let stats = null, layers = {}, hashColor = null, res = null;
        if (pixels) {
          const sub = `r${pad(renders++, 3)}-f${pad(f, 4)}`, out = join(resolve(env.workspace), sub);
          await mkdir(out, { recursive: true });
          const [w, h] = plan.size;
          res = await run(bin, ['render-pack', dir, '--frame', String(f), '--spp', String(plan.samples), '--width', String(w), '--height', String(h), '--no-denoise', '-o', join(out, 'preview.png'), '--passes', out], locked.seed, deadline, procs);
          for (const name of plan.layers) {
            const [file, components] = LAYERS[name];
            layers[name] = { file: `${sub}/${file}`, shape: [h, w, components.length], components, hash: sha256(await readFile(join(out, file))) };
          }
          const bytes = await readFile(join(out, LAYERS.color[0]));
          const rgba = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
          hashColor = sha256(bytes);
          stats = { luma: lumaStats(rgba), ...(shot.colorRef === 'display' ? clipStats(rgba) : {}), noise: null, tris: res.triangles };
        }
        const t = res?.timings_ms ?? {};
        const meta = {
          format: 'meta/0.1',
          film: input.film,
          shot: shot.id,
          frame: shot.in + f,
          shotFrame: f,
          seed: locked.seed,
          fps: output.fps,
          size: plan.size,
          colorRef: shot.colorRef,
          units: { meter: 1, up: 'Y', hand: 'right' },
          camera: { ...camera, shutterAngleDeg: plan.angleDeg },
          entities: ents,
          lights: null,
          events: timeline.filter((e) => e.frame === shot.in + f).map((e) => ({ id: e.id, frame: e.frame })),
          texts: [],
          stats,
          source: {
            id: shot.source, renderer: CAPS.id, host: HOST, version: CAPS.version, tier: env.tier,
            ...(res ? { gpu: res.adapter, backend: res.backend, samples: plan.samples } : {}),
          },
          timing: { stateMs: stateMs + (t.pack_ms ?? 0), renderMs: t.trace_ms ?? 0, readbackMs: t.readback_ms ?? 0 },
          origin: { host: ['camera', 'entities', 'lights', 'stats', 'source', 'timing'], shot: [], kernel: ['events'] },
          hash: { color: hashColor },
        };
        return { meta, layers };
      },

      /** 场景查询在第 f 帧的状态上答，坐标是世界坐标、米，地面是 y = 0；只答 bbox3d、belowGround，算式见 measure.js 的 answerQuery */
      async query(f, q) {
        live();
        planFrame(frames, f);
        const { kind, of, tol } = planQuery(CAPS, q, entities.map((e) => e.name));
        const at = entityPoints(pack, f);
        // 这一帧不画的实体没有顶点，不进结果
        return answerQuery(kind, of.filter((n) => at[n]).map((n) => [n, at[n].points]), tol);
      },

      async close() { closed = true; },
    };
  }

  const stop = async () => {
    // spawnManaged 在 POSIX 上起的是进程组长，整组一起杀
    for (const child of procs) if (child.pid) killProcessTree(child.pid, { processGroup: process.platform !== 'win32' });
  };
  return { caps: () => structuredClone(CAPS), open, stop };
}
