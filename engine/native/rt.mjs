#!/usr/bin/env node
// 北冥引擎 · 原生层 · 光追外部后端（rt）适配器：把一个外部的无头光追渲染器接成 B 路线（北冥原生 · BNE）的第二个外部后端候选。
// 它出写实光照的分层图（颜色、深度、物体编号、相机空间法线），北冥在浏览器里用 engine/look/layers.js 做描边、色阶与纸纹。
// 上游项目名与许可只写在 engine/native/rt.lock.json（upstream / license 字段）；我方一律叫 rt，环境变量叫 BNE_RT_BIN。
// 它是第三方预览许可软件（不是开源）：只作内部制作层与学术研究，仓库不放它的源码、shader、文档原文与二进制，只当外部命令行工具调用。
// 不提供 fetch 下载：由人按 rt.lock.json 的 downloadBase 与各平台 archive 下载官方发行包、核对 sha256 后解包，再把 BNE_RT_BIN 指向可执行文件。
//
//   node engine/native/rt.mjs status [--json]
//        读 BNE_RT_BIN：运行 <exe> --version 解析版本，与锁比对；算可执行文件 sha256，与锁比对（锁里是 null 记 'unlocked'）
//   node engine/native/rt.mjs render <场景.json> --out <目录> [--at 秒 | --frames a:b] [--seed N] [--size WxH]
//        在场景文件所在目录 spawn 外部渲染器（颜色 + 深度 + 物体编号 + 视空间法线，std/final 档），日志原样转出；成功后用 readLayers 核对产物
//        着色器缓存默认放 ASCII 路径（VORK_CACHE_DIR 的值由本命令设置；路径含非 ASCII 字符时改放文件系统根下的 bne-rt-cache）
//
// 代码里：
//   resolveRt({ env, cwd, lock }) → { exe, version, platform, binarySha256, lock, entry, verified, versionText }
//        verified：true 哈希与锁一致；'unlocked' 该平台锁里还没有哈希；'allowed' 用 BNE_ALLOW_VERSION 放行的未验证版本
//        没设 BNE_RT_BIN / 文件缺失或不可执行 / 版本不符 / 哈希不符 → exit 3（env.*）
//   buildScene({ model, camera, sun, sky, resolution, exposure }) → 场景对象（纯函数；默认值取自实测可用的最小场景）
//   renderArgs({ scene, out, at | frames, channels, seed, profile, resolution }) → argv 数组（纯函数）
//   readLayers(dir, frame = 0) → { dir, frame, files: { color, depth, ids, normal, meta }, depthUnit, objectIds, meta }
//        校验一帧的四个 PNG 与 meta.json 都在，缺哪个报哪个（exit 4，contract.*）
// 退出码：0 · 2 用法 · 3 渲染器缺失或不合格 · 4 产物不全 · 1 渲染器非 0 退出 · 124 超时。
import { access, constants, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, bind, exitWith, fail, log, runQuick, sha256File, spawnStream, warn } from './cli.mjs';
import { defineCommand, isMain, runCli } from '../../tools/lib/cli.mjs';
import { platformKey } from './runtime.mjs';

export const LOCK_PATH = join(dirname(fileURLToPath(import.meta.url)), 'rt.lock.json');
export const loadLock = async () => JSON.parse(await readFile(LOCK_PATH, 'utf8'));

const NO_BIN_HINT = '由人按 engine/native/rt.lock.json 的 downloadBase 下载官方发行包、核对 sha256 后解包，再把 BNE_RT_BIN 设为可执行文件的完整路径';
const NON_ASCII = /[^ -~]/;   // 可打印 ASCII 之外的字符

export async function resolveRt({ env = process.env, cwd = process.cwd(), lock } = {}) {
  lock ??= await loadLock();
  const raw = env.BNE_RT_BIN;
  if (!raw) throw fail(EXIT.ENV, 'no-rt', '没有设置 BNE_RT_BIN（光追渲染器不随仓库分发）', NO_BIN_HINT);
  const exe = resolve(cwd, raw);
  try { await access(exe, process.platform === 'win32' ? constants.F_OK : constants.X_OK); }
  catch { throw fail(EXIT.ENV, 'bad-rt', `BNE_RT_BIN 指向的文件不存在或不可执行：${exe}`, NO_BIN_HINT); }
  const p = runQuick(exe, ['--version'], { env: { ...env, VORK_NO_UPDATE_NOTIFIER: '1' }, timeoutMs: 30000, label: '光追渲染器 --version' });
  const versionText = (p.stdout || '').trim();
  const version = /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(versionText)?.[1];
  if (p.status !== 0 || !version) throw fail(EXIT.ENV, 'bad-rt', `${exe} --version 没有给出可识别的版本（退出码 ${p.status}，输出「${versionText.slice(0, 80)}」）`, NO_BIN_HINT);
  if (version !== lock.version && version !== env.BNE_ALLOW_VERSION) {
    throw fail(EXIT.ENV, 'rt-version', `已验证的版本是 ${lock.version}，BNE_RT_BIN 是 ${version}`, `换回 ${lock.version}；新版本要先重跑分层风格化验收，再用 BNE_ALLOW_VERSION=${version} 临时放行`);
  }
  let real = exe;
  try { real = await realpath(exe); } catch { /* 用 exe */ }
  const binarySha256 = await sha256File(real);
  const platform = platformKey(), entry = lock.platforms?.[platform] ?? null;
  let verified;
  if (version !== lock.version) { verified = 'allowed'; warn(`rt ${version} 是用 BNE_ALLOW_VERSION 放行的未验证版本，哈希不做核对`); }
  else if (!entry?.binarySha256) { verified = 'unlocked'; warn(`rt.lock.json 里 ${platform} 还没有可执行文件哈希（实测值 ${binarySha256}）：核对来源后补进锁`); }
  else if (entry.binarySha256 !== binarySha256) {
    throw fail(EXIT.ENV, 'rt-hash', `BNE_RT_BIN 的 sha256 ${binarySha256} 与锁定值 ${entry.binarySha256} 不符（同名版本被替换或被改动过）`, '重新下载官方发行包并核对归档 sha256');
  } else verified = true;
  return { exe, version, platform, binarySha256, lock, entry, verified, versionText };
}

// 场景：照实测可用的最小场景生成（米、右手、Y 向上，version 2）。太阳的方向与颜色、能量那组数值是渲染器自己的天空生成器算出来的，
// 这里原样写死为默认值（取自实测场景），不自己推导公式；要改太阳方向先在渲染器里实测再替换整组。
export const DEFAULT_SKY = { aerosol_density: 1, air_density: 1, altitude: 100, ozone_density: 1, sun_elevation: 0.62, sun_rotation: 2.3 };
export const DEFAULT_SUN = { angle: 0.00951204, color: [0.91080576, 1, 0.83157516], energy: 146.24628, rotation: [-0.330832, 0.34556672, 0, 0.8781423] };
export const DEFAULT_CAMERA = { translation: [17, 5, 40], target: [0, 1.5, 0] };

export function buildScene({ model, camera = {}, sun = {}, sky = {}, resolution = [1920, 1040], exposure = -1.7 } = {}) {
  if (!model) throw fail(EXIT.USAGE, 'no-model', 'buildScene 需要 model（GLB 文件名，相对场景文件）');
  return {
    version: 2,
    materials: { sky: { inputs: { ...DEFAULT_SKY, ...sky }, program: 'std/sky' } },
    nodes: [
      { type: 'asset', file: model },
      { material: 'sky', name: 'sky', shape: 'environment', type: 'light' },
      { ...DEFAULT_SUN, ...sun, name: 'sky_sun', shape: 'sun', type: 'light' },
      { type: 'camera', ...DEFAULT_CAMERA, ...camera },
    ],
    render: { resolution: [...resolution], display: { program: 'std/agx', inputs: { exposure } } },
  };
}

export const CHANNELS = ['color', 'depth', 'object_index', 'view_normal'];

export function renderArgs({ scene, out, at, frames, channels = CHANNELS, seed = 42, profile = 'std/final', resolution } = {}) {
  if (!scene || !out) throw fail(EXIT.USAGE, 'args', 'renderArgs 需要 scene 与 out');
  const when = frames ? ['--frame-start', String(frames[0]), '--frame-end', String(frames[1])] : ['--at', String(at ?? 0)];
  const size = resolution ? ['--set', `resolution=${Array.isArray(resolution) ? resolution.join('x') : resolution}`] : [];
  return ['render', scene, '--profile', profile, ...when, '--out', out, '--channels', channels.join(','), '--set', `seed=${seed}`, ...size, '--diagnostics'];
}

export async function readLayers(dir, frame = 0) {
  const stem = String(frame).padStart(6, '0');
  const files = { color: `${stem}.png`, depth: `${stem}.depth.png`, ids: `${stem}.object_index.png`, normal: `${stem}.view_normal.png`, meta: 'meta.json' };
  const missing = [];
  for (const k of Object.keys(files)) {
    files[k] = join(dir, files[k]);
    try { if (!(await stat(files[k])).isFile()) throw new Error('not a file'); } catch { missing.push(basename(files[k])); }
  }
  if (missing.length) throw fail(EXIT.CONTRACT, 'layers-missing', `${dir} 缺少第 ${frame} 帧的分层文件：${missing.join('、')}`, '确认渲染命令带了 --channels color,depth,object_index,view_normal，且渲染成功');
  let meta;
  try { meta = JSON.parse(await readFile(files.meta, 'utf8')); } catch (e) { throw fail(EXIT.CONTRACT, 'meta-invalid', `meta.json 不是合法 JSON：${e.message}`); }
  const fr = meta.frames?.find(f => f.index === frame);
  if (!fr) throw fail(EXIT.CONTRACT, 'meta-frame', `meta.json 里没有第 ${frame} 帧`, '检查 --at / --frames 与读取的帧号是否一致');
  if (!(fr.depth_unit_m > 0)) throw fail(EXIT.CONTRACT, 'meta-depth-unit', `meta.json 第 ${frame} 帧没有有效的 depth_unit_m`);
  return { dir, frame, files, depthUnit: fr.depth_unit_m, objectIds: meta.object_ids ?? [], meta };
}

// 缓存与输出默认放 ASCII 路径（Windows 中文路径会让部分工具出编码问题）
function cacheDir(env) {
  const base = process.platform === 'win32' ? env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local') : env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const dir = join(base, 'beiming', 'rt-shader-cache');
  if (!NON_ASCII.test(dir)) return dir;
  warn(`默认缓存路径含非 ASCII 字符（${dir}），改放 ${parse(process.cwd()).root}bne-rt-cache`);
  return join(parse(process.cwd()).root, 'bne-rt-cache');
}

async function cmdStatus() {
  const r = await resolveRt();
  log(`rt ${r.version}（${r.platform}）：${r.exe}`);
  log(`  可执行文件 sha256 ${r.binarySha256.slice(0, 16)}…  ${r.verified === true ? '与 rt.lock.json 一致' : r.verified === 'unlocked' ? '该平台尚未锁定' : '未验证版本（BNE_ALLOW_VERSION）'}`);
  return { data: { exe: r.exe, version: r.version, platform: r.platform, verified: r.verified, binarySha256: r.binarySha256 } };
}

async function cmdRender(a, scenePath) {
  if (a.at !== undefined && a.frames) throw fail(EXIT.USAGE, 'at-frames', '--at 与 --frames 只能给一个');
  const frames = a.frames ? a.frames.split(':').map(Number) : null;
  if (frames && !(frames.length === 2 && frames.every(Number.isInteger) && frames[0] >= 0 && frames[1] >= frames[0])) throw fail(EXIT.USAGE, 'frames', `--frames 要写成 起始:结束（整数，含两端），收到 ${a.frames}`);
  const scene = resolve(scenePath);
  try { await access(scene, constants.R_OK); } catch { throw fail(EXIT.USAGE, 'no-scene', `找不到场景文件 ${scene}`); }
  const out = resolve(a.out);
  if (NON_ASCII.test(out)) warn(`输出目录含非 ASCII 字符（${out}），Windows 上部分工具会出编码问题，建议改用 ASCII 路径`);
  const rt = await resolveRt();
  await mkdir(out, { recursive: true });
  const env = { ...process.env, VORK_CACHE_DIR: process.env.VORK_CACHE_DIR || cacheDir(process.env), VORK_NO_UPDATE_NOTIFIER: '1' };
  await mkdir(env.VORK_CACHE_DIR, { recursive: true });
  const args = renderArgs({ scene: basename(scene), out: out + '/', at: a.at, frames, seed: a.seed, resolution: a.size });
  log(`${rt.exe} ${args.join(' ')}`);
  const r = await spawnStream(rt.exe, args, { cwd: dirname(scene), env, timeoutMs: (a.timeout ?? 1800) * 1000, label: '光追渲染' });
  if (r.code !== 0) throw fail(EXIT.FAIL, 'rt-render', `光追渲染器退出码 ${r.code}`, '看上面转出的日志；场景坐标、模型路径（相对场景文件）与显卡 Vulkan 光追支持是常见原因');
  // --at 渲出的那一帧，帧号是「秒 × 帧率」（不一定是 0）：从刚写出的 meta.json 里取
  let first = 0, last = 0;
  if (frames) [first, last] = frames;
  else { try { first = last = JSON.parse(await readFile(join(out, 'meta.json'), 'utf8')).frames[0].index; } catch { /* 交给 readLayers 报缺什么 */ } }
  const got = [];
  for (let f = first; f <= last; f++) got.push(await readLayers(out, f));
  log(`产物齐全：${got.length} 帧分层 → ${out}`);
  return { data: { out, frames: got.map(g => g.frame), depthUnit: got[0].depthUnit, objects: got[0].objectIds.length, rt: { version: rt.version, verified: rt.verified, binarySha256: rt.binarySha256 } } };
}

export const command = defineCommand({
  name: 'b:rt',
  summary: '光追外部后端（rt）的核对与渲染：出分层图给 engine/look/layers.js 风格化；渲染器不随仓库分发，许可见 rt.lock.json',
  usage: ['node engine/native/rt.mjs status [--json]', 'node engine/native/rt.mjs render <场景.json> --out <目录> [--at 秒 | --frames a:b] [--seed N] [--size WxH] [--timeout 秒]'],
  description: [
    '  status  核对 BNE_RT_BIN：版本与可执行文件 sha256 是否与 engine/native/rt.lock.json 一致',
    '  render  在场景文件所在目录调用外部渲染器，出颜色 / 深度 / 物体编号 / 视空间法线四层，成功后核对产物；本命令不下载渲染器',
  ],
  positionals: [{ name: 'sub', label: '<status|render>', describe: '子命令', required: true }, { name: 'scene', label: '[场景.json]', describe: 'render：场景文件', required: false }],
  options: {
    out: { type: 'string', arg: '<目录>', describe: 'render：输出目录（建议 ASCII 路径）' },
    at: { type: 'string', arg: '<秒>', describe: 'render：渲一张静帧（默认 0；可写 1/24）' },
    frames: { type: 'string', arg: '<a:b>', describe: 'render：整段渲染，帧号含两端' },
    seed: { type: 'integer', arg: '<N>', describe: 'render：随机种子（默认 42）' },
    size: { type: 'string', arg: '<WxH>', describe: 'render：覆盖场景里的分辨率' },
    timeout: { type: 'integer', arg: '<秒>', describe: 'render：超时（默认 1800）' },
  },
  exitCodes: { 0: '成功', 1: '渲染器非 0 退出', 2: '用法错误', 3: '渲染器缺失、版本或哈希不符', 4: '产物不全', 124: '超时' },
  examples: ['node engine/native/rt.mjs status', 'node engine/native/rt.mjs render scene.json --out out/rt/shot --at 0'],
  async run(ctx) {
    bind(ctx);
    const { sub, scene } = ctx.args;
    if (sub === 'status') return cmdStatus();
    if (sub === 'render') {
      if (!scene || !ctx.opts.out) throw fail(EXIT.USAGE, 'render-args', 'render 需要 <场景.json> 与 --out <目录>');
      return cmdRender({ ...ctx.opts }, scene);
    }
    throw fail(EXIT.USAGE, 'bad-subcommand', `未知子命令 ${sub}`, '可用：status、render');
  },
});

if (isMain(import.meta.url)) await exitWith(runCli(command));
