// Blender 帧源的宿主（node 一侧）：帧源对上层的接口就在这里。起一个常驻的后台 Blender（-b -noaudio --factory-startup），
// 用标准输入输出上按行分隔的 JSON 和 worker.py 说话；一个进程同一时刻只装一个镜头，装载和各帧都在这一个进程里做。
// 计划（装不装得了、要的输出交不交得出、生效的快门、输出尺寸）是这里的纯函数，不碰 Blender；交不出的请求一律报带错误码的错。
// 两种作者模式：build-script 调镜头的入口文件搭场景；cards-data 不写镜头代码，跑固定装载脚本（卡的运行时接口契约 3.4 的六步），
// 和页面宿主 host/page/runtime.js 同构：这里做装载之前的检查、解参数和先后要求，并在求值核里跑数据层的卡（算 tracks）；
// 第 1 到 6 步里碰场景的部分在 worker 里（loader.py），资产的载入在 assets.py。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashCardContents, validateCard } from '../../cards/index.mjs';
import { checkInstanceNames, expandOverlays, implFor, orderPairs, parseCardRef, resolveParams, unfitReason } from '../../cards/runtime.mjs';
import { caps, DRAFT_MAX_SIZE } from './caps.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'worker.py');
const BEIMING = resolve(HERE, '../..');
// 数据层的卡产出的轨道里，这个帧源有地方写的只有相机轨道
const WRITABLE_TRACKS = ['tracks.camera'];
const CARD_ENTRIES = ['create', 'evaluate'];
const ASSET_REF = /^asset:[a-z0-9][a-z0-9-]*@[1-9][0-9]*$/;
// 资产文件的种类看扩展名：.json 是本帧源自己的零件清单（kit-spec/0.1，硬表面几何、材质和灯光），其余三种用 Blender 自带的导入器或追加
const ASSET_KINDS = { '.json': 'kit', '.glb': 'glb', '.gltf': 'glb', '.stl': 'stl', '.blend': 'blend' };
/** 帧源自带的资产：资产引用 → 文件。起帧源时 assets 里写了同一个引用的，用写的那份 */
export const BUILTIN_ASSETS = Object.freeze({ 'asset:rtx-card@1': join(HERE, 'rtx-card.json') });
const MAC_APP = '/Applications/Blender.app/Contents/MacOS/Blender';
const CYCLES_MAX_SAMPLES = 2 ** 24; // CyclesRenderSettings.samples 的 RNA 上界
const ENV_KEYS = ['lock', 'tier', 'workspace', 'filmDir'];

export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const bad = (message) => new SourceError('usage.bad-argument', message);
const show = (v) => {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v) ?? Object.prototype.toString.call(v); } catch { return Object.prototype.toString.call(v); }
};
const used = (v) => (Array.isArray(v) ? v.length > 0 : v !== null && typeof v === 'object' && Object.keys(v).length > 0);
const own = (table, key) => table != null && Object.hasOwn(table, key) ? table[key] : undefined;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pad = (n, width) => String(n).padStart(width, '0');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** 出帧的那一套：带 renderer 对象的镜头取 renderer 里的，否则取镜头条目顶层的 */
const renderingOf = (shot) => (record(own(shot, 'renderer')) ? own(shot, 'renderer') : shot);
/** 镜头能用的资产：镜头条目的 assets 在前（第 1 步载入、零件进 entities），全片的 assets 在后（ctx.assets.load 时才载） */
const assetsOf = (input) => [
  ...Object.entries(record(own(own(input, 'shot'), 'assets')) ? input.shot.assets : {}).map(([alias, ref]) => ({ alias, ref, shot: true })),
  ...Object.entries(record(own(input, 'assets')) ? input.assets : {}).map(([alias, ref]) => ({ alias, ref, shot: false })),
];

/** 找 Blender：环境变量 BEIMING_BLENDER 写了就只认它；没写就依次看 macOS 的应用目录和 PATH 里的 blender。找不到返回 null。 */
export function findBlender(env = process.env) {
  if (env.BEIMING_BLENDER) return existsSync(env.BEIMING_BLENDER) ? env.BEIMING_BLENDER : null;
  const onPath = (env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'blender'));
  return [MAC_APP, ...onPath].find((p) => existsSync(p)) ?? null;
}

/** 声明过的输出：outputs 里出现并且取值不是 false；lightgroup:<名> 看 lightgroup:* 这个键 */
export const declared = (c, name) => {
  const key = name.startsWith('lightgroup:') ? 'lightgroup:*' : name;
  return Object.hasOwn(c.outputs, key) && c.outputs[key] !== false;
};

/**
 * 读进提供给帧源的卡，和页面宿主的 loadCards 同一个算法。dirs 是卡目录，相对 beiming/（例如 cards/camera/spline）。
 * 每张卡的卡文件先过校验（泄露门禁、结构、CF 各条），再照锁文件的算法算内容哈希：卡目录全部文件按路径排序，各自的 SHA-256 连同路径再算一次。
 * 返回 { 卡名: { card, sha256 } }。
 */
export async function loadCards(dirs) {
  const library = {};
  for (const dir of dirs) {
    const abs = resolve(BEIMING, dir), rel = relative(BEIMING, abs);
    if (rel.startsWith('..') || rel === '' || isAbsolute(rel) || resolve(BEIMING, rel) !== abs) throw bad(`卡目录 ${dir} 不在 beiming/ 里`);
    const names = (await readdir(abs, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => relative(abs, join(e.parentPath, e.name)).split(sep).join('/'));
    const hashes = {};
    for (const name of names) hashes[name] = sha256(await readFile(join(abs, name)));
    const card = JSON.parse(await readFile(join(abs, 'card.json'), 'utf8')), verdict = validateCard(card);
    if (!verdict.ok) throw new Error(`卡目录 ${dir} 的卡文件没过校验：${JSON.stringify({ schemaErrors: verdict.schemaErrors, violations: verdict.violations, leaks: verdict.leaks })}`);
    if (library[card.id]) throw new Error(`卡 ${card.id} 提供了两份`);
    library[card.id] = { card, sha256: hashCardContents(hashes) };
  }
  return library;
}

/**
 * 读进提供给帧源的资产：帧源自带的（BUILTIN_ASSETS）加 given（{ 资产引用: 文件路径 }，同一个引用以 given 为准）。
 * 返回 { 资产引用: { path, kind, sha256 } }：sha256 照锁文件的写法，是 sha256: 加文件内容的 SHA-256。
 * shortcut: 帧源接口契约没有把资产的文件交给帧源的通道（第 6 节留空），这里由起帧源的人给；契约定了以后改从那里取
 */
export async function loadAssets(given = {}) {
  if (!record(given)) throw bad('assets 必须是 { 资产引用: 文件路径 }');
  const library = {};
  for (const [ref, path] of Object.entries({ ...BUILTIN_ASSETS, ...given })) {
    if (!ASSET_REF.test(ref)) throw bad(`资产引用必须写成 asset:<名>@<版本>，给的是 ${show(ref)}`);
    if (typeof path !== 'string' || !path) throw bad(`资产 ${ref} 的文件路径必须是字符串`);
    const kind = ASSET_KINDS[extname(path).toLowerCase()];
    if (!kind) throw bad(`资产 ${ref} 的文件 ${show(extname(path))} 不是这个帧源载得了的种类（${Object.keys(ASSET_KINDS).join('、')}）`);
    const abs = resolve(path);
    library[ref] = { path: abs, kind, sha256: `sha256:${sha256(await readFile(abs))}` };
  }
  return library;
}

/**
 * 装载之前：装不了就报错，装得了返回 { seed, shutterSamples?, entry? }（entry 只有 build-script 模式有）。
 * library 是提供给帧源的卡（见 loadCards），assets 是提供给帧源的资产（见 loadAssets），都只有 cards-data 模式用。
 * 先后照帧源接口契约 5.14：宿主或作者模式没声明 → 没有锁文件又缺种子、用了卡或资产 → 有装不了的输入 → 实例名 → 锁文件对不对得上。
 * 一个卡实例装得了，要提供了这张卡、锁文件锁的版本和内容哈希就是提供的这一份、它有落在这个帧源或数据层的实现；
 * 数据层的卡还要它产出的轨道这个帧源都有地方写。一个资产装得了，要提供了它、锁文件里记了它、记的哈希就是提供的这一份。
 */
export function planOpen(c, input, env, library = {}, assetLib = {}) {
  if (!record(input) || !record(own(input, 'shot')) || !record(env)) throw bad('input、input.shot 和 env 必须是对象');
  const shot = own(input, 'shot'), renderer = renderingOf(shot);
  const source = own(renderer, 'source'), host = own(renderer, 'host'), mode = own(renderer, 'mode'), entry = own(renderer, 'entry');
  const tier = own(env, 'tier'), lock = own(env, 'lock');
  if (source !== c.id) throw bad(`出这个镜头的帧源是 ${show(source)}，不是 ${c.id}`);
  if (!['draft', 'final'].includes(tier)) throw bad(`档位只能是 draft、final，给的是 ${show(tier)}`);
  if (!c.hosts.includes(host) || !c.modes.includes(mode)) throw new SourceError('contract.unsupported-mode', `${c.id} 帧源不支持宿主 ${show(host)} 加作者模式 ${show(mode)}`);
  const cards = used(own(shot, 'cards')), overlays = used(own(input, 'overlays')), assets = used(own(shot, 'assets')) || used(own(input, 'assets'));
  const shotId = own(shot, 'id');
  if (lock === null) {
    const seed = own(shot, 'seed');
    if (!Number.isInteger(seed)) throw new SourceError('env.lock-required', `没有锁文件，镜头 ${show(shotId)} 又没写 seed`);
    if (cards || overlays || assets) throw new SourceError('env.lock-required', `没有锁文件，镜头 ${show(shotId)} 却用了${cards ? '卡' : overlays ? '叠加层' : '资产'}`);
  }
  if (lock !== null && !record(lock)) throw bad('lock 必须是对象或 null');
  if (mode === 'cards-data') {
    if (entry !== undefined) throw bad('cards-data 模式的镜头不写 entry');
    const why = (use) => {
      const reason = unfitReason(library, lock, use, c.id);
      if (reason) return reason;
      const { card } = library[parseCardRef(use).name];
      const stray = implFor(card, c.id).livesIn === 'data' ? card.ports.out.filter((p) => !WRITABLE_TRACKS.includes(p.type)).map((p) => p.type) : [];
      return stray.length ? `卡 ${card.id} 产出的 ${stray.join('、')} 这个帧源没有地方写` : null;
    };
    const assetWhy = (ref) => {
      const have = own(assetLib, ref), locked = own(own(lock, 'assets'), ref);
      if (!have) return `没有提供资产 ${show(ref)}`;
      if (locked === undefined) return `锁文件里没有资产 ${ref}`;
      return locked === have.sha256 ? null : `提供的资产 ${ref} 和锁文件锁的哈希对不上`;
    };
    const listed = lock === null ? [] : [
      ...(Array.isArray(own(shot, 'cards')) ? shot.cards : []).map((x) => ({ ...x, what: '卡' })),
      ...expandOverlays(Array.isArray(own(input, 'overlays')) ? input.overlays : []).map((x) => ({ ...x, what: '叠加层' })),
    ];
    const unfit = [
      ...listed.map((x) => [x, why(x.use)]).filter(([, reason]) => reason).map(([x, reason]) => `${x.what} ${x.as}（${reason}）`),
      ...(lock === null ? [] : assetsOf(input)).map((a) => [a, assetWhy(a.ref)]).filter(([, reason]) => reason).map(([a, reason]) => `资产 ${a.alias}（${reason}）`),
    ];
    // 不少装一样照常装载
    if (unfit.length) throw new SourceError('contract.unsupported-input', `${c.id} 帧源装不了：${unfit.join('；')}`);
    checkInstanceNames(listed.map((x) => x.as));
  } else {
    // build-script 模式不接卡、资产、叠加层：带着来就报错，不少装一样照常装载
    const unfit = [cards && '卡', assets && '资产', overlays && '叠加层'].filter(Boolean);
    if (unfit.length) throw new SourceError('contract.unsupported-input', `${c.id} 帧源的 ${show(mode)} 模式不接${unfit.join('、')}`);
    if (typeof entry !== 'string' || !entry) throw bad(`${show(mode)} 模式的镜头必须写 entry`);
  }
  const withEntry = mode === 'cards-data' ? {} : { entry };
  if (lock === null) return { seed: own(shot, 'seed'), ...withEntry };
  const film = own(lock, 'film');
  if (film !== undefined && film !== own(input, 'film')) throw bad(`锁文件是片子 ${show(film)} 的，不是 ${show(own(input, 'film'))}`);
  const lockedVer = own(own(own(lock, 'sources'), c.id), 'version');
  if (lockedVer !== undefined && lockedVer !== c.version) throw new SourceError('contract.unsupported-input', `锁文件锁的 ${c.id} 版本是 ${show(lockedVer)}，当前帧源是 ${c.version}`);
  const shotLock = own(own(lock, 'shots'), shotId);
  const seed = own(own(lock, 'seeds'), shotId), shutterSamples = record(shotLock) ? own(shotLock, 'shutterSamples') : undefined;
  if (!Number.isInteger(seed) || !Number.isInteger(shutterSamples)) throw bad(`锁文件里没有镜头 ${show(shotId)} 的种子或子帧采样数`);
  return { seed, shutterSamples, ...withEntry };
}

/**
 * 一次 render 的计划。shot 是镜头条目，size 是画幅 [宽, 高]（像素），locked 是 planOpen 的返回值。
 * 返回 { angleDeg, shutterSamples, size, samples, denoise, layers }：layers 是这次要交的像素输出，空数组就是只要元数据。
 * 取值次序：这次调用 → 锁文件 → 镜头条目 → 能力声明。
 */
export function planRender(c, shot, size, tier, opts = {}, want, locked = {}) {
  if (!Array.isArray(want) || want.some((n) => typeof n !== 'string') || new Set(want).size !== want.length) throw bad('want 必须是不重复的输出名数组');
  const missing = want.filter((n) => n !== 'meta' && !declared(c, n));
  if (missing.length) throw new SourceError('contract.unsupported-output', `这个帧源交不出：${missing.join('、')}`);

  if (!record(shot) || !Array.isArray(size) || size.length !== 2 || !size.every((n) => Number.isInteger(n) && n >= 1)) throw bad('shot 和 size 格式不合法');
  if (!record(opts)) throw bad('opts 和 shutter 必须是对象');
  const shutterOpt = own(opts, 'shutter');
  if (shutterOpt !== undefined && !record(shutterOpt)) throw bad('opts 和 shutter 必须是对象');
  const shotShutter = record(own(shot, 'shutter')) ? own(shot, 'shutter') : undefined;
  const angleDeg = shutterOpt !== undefined && Object.hasOwn(shutterOpt, 'angleDeg')
    ? shutterOpt.angleDeg
    : (shotShutter !== undefined && Object.hasOwn(shotShutter, 'angleDeg') ? shotShutter.angleDeg : 0);
  const shutterSamples = shutterOpt !== undefined && Object.hasOwn(shutterOpt, 'samples')
    ? shutterOpt.samples
    : (own(locked, 'shutterSamples') ?? (shotShutter !== undefined && Object.hasOwn(shotShutter, 'samples') ? shotShutter.samples : undefined) ?? c.motionBlur.samples ?? 1);
  if (!finite(angleDeg) || angleDeg < 0 || angleDeg > 360) throw bad(`快门角必须在 [0, 360] 度，给的是 ${show(angleDeg)}`);
  // 原生运动模糊没有子帧：快门窗口里的时刻由 Cycles 逐样本取。子帧采样数只照契约验值域和自相矛盾，默认取 1
  if (!Number.isInteger(shutterSamples) || shutterSamples < 1) throw bad(`子帧采样数必须是不小于 1 的整数，给的是 ${show(shutterSamples)}`);
  if (angleDeg === 0 && shutterSamples > 1) throw new SourceError('contract.shutter-conflict', `快门角是 0，子帧采样数却是 ${show(shutterSamples)}`);
  // 开着原生运动模糊时，conflicts 里列的输出取不到一个确定的时刻：报错，不出帧
  const clash = c.motionBlur.mode === 'native' && angleDeg > 0 ? want.filter((n) => (c.motionBlur.conflicts ?? []).includes(n)) : [];
  if (clash.length) throw new SourceError('contract.output-conflict', `开着原生运动模糊（快门角 ${show(angleDeg)} 度）不能同时要：${clash.join('、')}`);

  if (!['draft', 'final'].includes(tier) || !Object.hasOwn(c, tier)) throw bad(`未知档位 ${show(tier)}`);
  const defaults = c[tier];
  const rawPreset = record(own(shot, 'tiers')) ? own(shot.tiers, tier) : undefined;
  const preset = record(rawPreset) ? rawPreset : {};
  const hasScale = Object.hasOwn(opts, 'scale'), hasPresetScale = Object.hasOwn(preset, 'scale');
  const asked = hasScale ? opts.scale : (hasPresetScale ? preset.scale : undefined);
  const samples = Object.hasOwn(opts, 'samples') ? opts.samples : (Object.hasOwn(preset, 'samples') ? preset.samples : defaults.samples);
  if (asked !== undefined && (!finite(asked) || asked <= 0 || asked > 1)) throw bad(`scale 必须在 (0, 1]，给的是 ${show(asked)}`);
  if (!Number.isInteger(samples) || samples < 1) throw bad(`每像素采样数必须是不小于 1 的整数，给的是 ${show(samples)}`);
  if (samples > CYCLES_MAX_SAMPLES) throw new SourceError('contract.unsupported-option', `Cycles 每像素最多 ${CYCLES_MAX_SAMPLES} 个样本，要的是 ${show(samples)}`);
  // 草稿档的上限：每像素采样数不超过能力声明里草稿档的数，输出分辨率不超过 960 × 540（宽 ≤ 960 且高 ≤ 540）。
  // 没点名缩放时默认值自动往下取到上限之内；点名要的超了上限就报错，不换一个值出帧
  const [maxW, maxH] = DRAFT_MAX_SIZE;
  const fit = Math.min(maxW / size[0], maxH / size[1]);
  const scale = asked ?? (tier === 'draft' ? Math.min(defaults.scale, fit) : defaults.scale);
  const out = [Math.max(1, Math.round(size[0] * scale)), Math.max(1, Math.round(size[1] * scale))];
  if (tier === 'draft' && samples > c.draft.samples) throw new SourceError('contract.unsupported-option', `草稿档每像素最多 ${c.draft.samples} 个样本，要的是 ${show(samples)}`);
  if (tier === 'draft' && (out[0] > maxW || out[1] > maxH)) {
    if (asked !== undefined) throw new SourceError('contract.unsupported-option', `草稿档输出分辨率不超过 ${maxW} × ${maxH}，scale ${show(asked)} 要的是 ${out[0]} × ${out[1]}`);
    out[0] = Math.min(out[0], maxW);
    out[1] = Math.min(out[1], maxH);
  }

  // Blender 的 resolution_x/y 会把界外尺寸静默截断，交不了的画幅要在请求前报 F18。
  if (out.some((n) => n < 4 || n > 65536)) throw new SourceError('contract.unsupported-option', `Blender 每边支持 4 到 65536 像素，要的是 ${out.join(' × ')}`);
  return {
    angleDeg,
    shutterSamples,
    size: out,
    samples,
    denoise: defaults.denoise !== undefined,
    // 没要颜色层就是「只要元数据」：不出像素
    layers: want.includes('color') ? want.filter((n) => n !== 'meta') : [],
  };
}

/** 起 worker 进程，交回 { call, stop }。call 一次只发一条请求；limitMs 给了的话，一条请求超过这么多毫秒就杀掉进程。 */
function startWorker(blenderBin, scratch, limitMs, handshakeMs, stopMs, cpuOnly = false) {
  const child = spawn(blenderBin, ['-b', '-noaudio', '--factory-startup', '--python', WORKER, '--', scratch, ...(cpuOnly ? ['--cpu'] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
  const tail = [];
  let nextId = 1, waiter, terminal, stopping, queue = Promise.resolve();
  const note = (line) => { tail.push(line.slice(-1024)); if (tail.length > 5) tail.shift(); };
  const finish = (error) => {
    terminal ??= error;
    waiter?.fail(terminal);
    waiter = undefined;
  };
  const abort = (reason) => {
    finish(new Error(`${reason}：${tail.join(' | ')}`));
    child.kill('SIGKILL');
  };
  createInterface({ input: child.stderr }).on('line', note);
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (terminal) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      note(line);
      if (waiter && waiter.op !== 'hello') abort('Blender 应答不是 JSON');
      return;
    }
    if (!waiter || msg?.id !== waiter.id || typeof msg.ok !== 'boolean' ||
        (msg.ok ? !record(msg.result) : typeof msg.message !== 'string')) {
      note(line);
      abort('Blender 应答格式或序号错误');
      return;
    }
    if (msg.ok) waiter.ok(msg.result);
    // 固定装载脚本半路报带错误码的错时，它到那时为止记的账跟着错一起交回（load）
    else waiter.fail(msg.code ? Object.assign(new SourceError(msg.code, msg.message), record(msg.load) ? { load: msg.load } : {}) : new Error(msg.message));
    waiter = undefined;
  });
  // 子进程退出时，管道可能先报 EPIPE。让 exit 事件把实际退出原因交给等待方。
  child.stdin.on('error', () => {});
  const gone = new Promise((done) => {
    child.once('error', (e) => {
      finish(e.code === 'ENOENT' ? new SourceError('env.missing-tool', e.message) : e);
      done();
    });
    child.once('exit', (code, signal) => {
      finish(new Error(`Blender 进程已退出（${signal ? `信号 ${signal}` : `退出码 ${code}`}）：${tail.join(' | ')}`));
      done();
    });
  });
  const send = async (op, body) => {
    if (terminal) throw terminal;
    if (stopping) throw new Error('Blender 进程正在停止');
    const id = nextId++, line = JSON.stringify({ id, op, ...body });
    const timeout = op === 'hello' ? handshakeMs : limitMs;
    const timer = timeout ? setTimeout(() => abort(`Blender ${op} 超过 ${timeout} 毫秒`), timeout) : null;
    try {
      return await new Promise((ok, fail) => {
        waiter = { id, op, ok, fail };
        child.stdin.write(`${line}\n`);
      });
    } finally { clearTimeout(timer); }
  };
  const call = (op, body = {}) => {
    const run = queue.then(() => send(op, body));
    queue = run.catch(() => {});
    return run;
  };
  const stop = () => {
    if (!stopping) stopping = (async () => {
      if (!terminal) child.stdin.end(`${JSON.stringify({ op: 'quit' })}\n`);
      let expired = false;
      const timer = setTimeout(() => { expired = true; abort(`Blender stop 超过 ${stopMs} 毫秒`); }, stopMs);
      try { await gone; } finally { clearTimeout(timer); }
      if (expired) throw terminal;
    })();
    return stopping;
  };
  return { call, stop };
}

/**
 * cards-data 模式装载之前在 node 一侧备好的东西：交给 worker 的装载单，和数据层的卡（evaluate 形状，在这里的求值核里跑）。
 * 卡实例：镜头条目的 cards 在前，叠加层展开出的在后；各带用的那份实现、换算好的参数。
 */
async function prepareCards(input, locked, library, assetLib) {
  const { shot, output } = input, frames = shot.out - shot.in, events = input.events?.events ?? [];
  const listed = [...(shot.cards ?? []).map((x) => ({ ...x, overlay: false })), ...expandOverlays(input.overlays).map((x) => ({ ...x, overlay: true }))];
  const instances = listed.map((x) => {
    const { card } = library[parseCardRef(x.use).name], impl = implFor(card, 'blender');
    return { as: x.as, use: x.use, overlay: x.overlay, card, impl, params: resolveParams(card, x.params, { events, shotIn: shot.in }) };
  });
  const data = [];
  for (const i of instances.filter((x) => x.impl.shape === 'evaluate')) {
    const module = await import(pathToFileURL(resolve(BEIMING, i.impl.entry)).href);
    // 一份实现对外只能有一个卡入口，并且就是卡文件声明的形状
    const entries = CARD_ENTRIES.filter((k) => typeof module[k] === 'function');
    if (entries.length !== 1 || entries[0] !== 'evaluate') throw new Error(`卡 ${i.use} 的实现 ${i.impl.entry} 对外的卡入口是 ${entries.join('、') || '没有'}，卡文件声明的是 evaluate`);
    data.push({ ...i, module });
  }
  const filming = data.filter((i) => i.card.ports.out.some((p) => p.type === 'tracks.camera'));
  if (filming.length > 1) throw new Error(`镜头 ${shot.id} 有 ${filming.length} 个产出相机轨道的卡实例，取哪一个契约还没定`);
  const named = Object.fromEntries(events.filter((e) => e.kind === 'named').map((e) => [e.id, e.frame - shot.in]));
  const job = {
    mode: 'cards-data',
    shot: { id: shot.id, in: shot.in },
    params: shot.params ?? {},
    roles: shot.roles ?? {},
    events: named,
    // 资产的文件路径由帧源自己补：planOpen 已经核过提供了、锁文件里的哈希对得上
    assets: assetsOf(input).map((a) => ({ ...a, path: assetLib[a.ref].path, kind: assetLib[a.ref].kind })),
    instances: instances.map((i) => ({
      as: i.as, use: i.use, overlay: i.overlay, impl: i.impl.entry, shape: i.impl.shape, entry: resolve(BEIMING, i.impl.entry),
      kind: i.card.kind, params: i.params, paramNames: Object.keys(i.card.params),
    })),
    pairs: orderPairs(instances.filter((i) => !i.overlay)),
    tracksCamera: filming.length > 0,
    // 有读世界包围盒的数据层卡时，worker 装载完量出每个实体第 −1 到第 frames 帧的世界包围盒，交给求值核当 inputs.bbox
    needBbox: data.some((i) => i.card.ports.in.some((p) => p.type === 'bbox-world')),
  };
  /** 数据轨道在第 t 帧（sub = 0）的值：各个数据层的卡按书写顺序求值，每个时刻现算，不留跨帧的状态；交回 { t, camera? } */
  const inputsOf = (bbox) => Object.freeze({
    fps: output.fps, size: [...output.size], seed: locked.seed, shot: { id: shot.id, in: shot.in, frames },
    events: events.map((e) => ({ id: e.id, kind: e.kind, f: e.frame - shot.in, sub: e.sub })),
    ...(bbox ? { bbox } : {}),
  });
  const segmentAt = (inputs, t) => {
    const out = { t };
    for (const i of data) {
      const segment = i.module.evaluate(inputs, structuredClone(i.params), t, 0);
      if (!segment?.camera) continue;
      const { pos, quat, fovDeg } = segment.camera;
      const ok = Array.isArray(pos) && pos.length === 3 && Array.isArray(quat) && quat.length === 4 && [...pos, ...quat, fovDeg].every(finite) && fovDeg > 0 && fovDeg < 180;
      if (!ok) throw new Error(`卡实例 ${i.as} 在第 ${t} 帧交的相机轨道不合法：${show(segment.camera)}`);
      out.camera = { pos: [...pos], quat: [...quat], fovDeg };
    }
    return out;
  };
  return { job, frames, filming: filming.length > 0, inputsOf, segmentAt };
}

/**
 * 起一个 Blender 帧源：一个常驻的 Blender 进程。交回 { caps, open, stop, device }：caps 和 open 是帧源接口，
 * stop 关掉进程并清掉临时目录，device 是实际用的后端（{ backend, gpu? }）。没有 Blender 报 env.missing-tool。
 * cards 是提供给这个帧源的卡目录（见 loadCards）；提供了卡，能力声明里才有「卡加数据」模式，镜头用的卡才装得了。
 * assets 是另外提供的资产 { 资产引用: 文件路径 }（见 loadAssets），帧源自带的 asset:rtx-card@1 不用给。
 * device 是 'auto'（有显卡用显卡）或 'cpu'（只用 CPU：同一台机器上颜色层逐位可复现，纯函数门按哈希比时用）。
 * open 得到的会话有 manifest、render、query、close；同一时刻只能有一个没关的会话。
 */
export async function startSource({ blenderBin = findBlender(), limitMs, handshakeMs = limitMs ?? 60000, stopMs = 5000, cards = [], assets = {}, device: use = 'auto' } = {}) {
  if (!blenderBin) throw new SourceError('env.missing-tool', '找不到 Blender：设环境变量 BEIMING_BLENDER 指向它的可执行文件，或者把 blender 放进 PATH');
  for (const ms of [handshakeMs, stopMs, ...(limitMs === undefined ? [] : [limitMs])]) {
    if (!finite(ms) || ms <= 0 || ms > 2147483647) throw bad('超时毫秒数必须在 (0, 2147483647]');
  }
  if (!Array.isArray(cards)) throw bad('cards 必须是卡目录的数组');
  if (!['auto', 'cpu'].includes(use)) throw bad(`device 只能是 auto、cpu，给的是 ${show(use)}`);
  const library = await loadCards(cards), assetLib = await loadAssets(assets);
  // 目录名带进程号：几个进程同时起帧源时，各自认得出哪些临时目录是自己的
  const scratch = await mkdtemp(join(tmpdir(), `beiming-blender-${process.pid}-`));
  let worker, hello;
  const stop = async () => {
    try { await worker?.stop(); } finally { await rm(scratch, { recursive: true, force: true }); }
  };
  try {
    worker = startWorker(blenderBin, scratch, limitMs, handshakeMs, stopMs, use === 'cpu');
    hello = await worker.call('hello');
    if (typeof hello.version !== 'string' || typeof hello.backend !== 'string') throw new Error('Blender 握手缺少版本或后端');
  } catch (e) {
    await stop();
    throw e;
  }
  const { version, ...device } = hello;
  const CAPS = caps(version, library);
  let current = null;

  async function open(input, env) {
    // lock 必须写出来，哪怕是 null：忘了传当场报错
    const missing = ENV_KEYS.filter((k) => own(env, k) === undefined);
    if (missing.length) throw bad(`env 缺 ${missing.join('、')}`);
    const locked = planOpen(CAPS, input, env, library, assetLib);
    if (current) throw bad('这个 Blender 进程里还有没关的会话：先 close 再 open');
    const { shot, output } = input, frames = shot.out - shot.in;
    // 事件表是上层展开好的，帧号是全片帧号；镜头输入不带事件表时每帧的 events 是空数组
    const timeline = input.events?.events ?? [];
    const session = {};
    current = session;
    let entities, prepared, inputs;
    try {
      const common = { frames, fps: output.fps, size: output.size, seed: locked.seed, tokens: input.tokens ?? {}, tier: env.tier, colorRef: shot.colorRef };
      if (renderingOf(shot).mode === 'cards-data') {
        prepared = await prepareCards(input, locked, library, assetLib);
        const opened = await worker.call('open', { ...common, ...prepared.job });
        entities = opened.entities;
        // worker 交的是第 −1 帧起的逐帧数组，换成以帧号为键的表：求值核按 bbox[实体名][f] 取，f 可以是 −1
        inputs = prepared.inputsOf(record(opened.bbox)
          ? Object.fromEntries(Object.entries(opened.bbox).map(([name, boxes]) => [name, Object.fromEntries(boxes.map((b, k) => [k - 1, b]).filter(([, b]) => b))]))
          : undefined);
      } else {
        ({ entities } = await worker.call('open', { ...common, entry: resolve(env.filmDir, locked.entry) }));
      }
    } catch (e) {
      current = null;
      throw e;
    }
    const inRange = (f) => { if (!Number.isInteger(f) || f < 0 || f >= frames) throw bad(`帧号必须是 [0, ${frames}) 里的整数，给的是 ${show(f)}`); };
    let renders = 0;

    return Object.assign(session, {
      manifest: () => ({ frames, entities: entities.map((e) => ({ ...e })) }),

      /** 渲一帧：各层写到 env.workspace 下面的 r<会话内请求序号>-f<帧号>/<通道名>.<类型>，交回元数据和层引用 */
      async render(f, opts, want) {
        if (current !== session) throw bad('会话已经关了');
        inRange(f);
        const plan = planRender(CAPS, shot, output.size, env.tier, opts ?? {}, want, locked);
        const dir = `r${pad(renders++, 3)}-f${pad(f, 4)}`;
        // 第 5 步要的轨道值：出第 f 帧交 f − 1、f、f + 1 三个整帧，原生运动模糊的快门窗口落在这里面
        const tracks = prepared?.filming ? [f - 1, f, f + 1].map((t) => prepared.segmentAt(inputs, t)) : [];
        const res = await worker.call('render', { f, plan, workspace: resolve(env.workspace), dir, ...(prepared ? { tracks } : {}) });
        const readings = res.readings && Object.keys(res.readings).length ? res.readings : undefined;
        const pixels = plan.layers.length > 0;
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
          camera: { ...res.camera, shutterAngleDeg: plan.angleDeg },
          entities: res.entities,
          lights: null,
          events: timeline.filter((e) => e.frame === shot.in + f).map((e) => ({ id: e.id, frame: e.frame })),
          texts: null,
          ...(readings ? { readings } : {}),
          stats: res.stats,
          source: {
            id: shot.source, renderer: CAPS.id, host: CAPS.hosts[0], version, tier: env.tier,
            ...(res.device.gpu ? { gpu: res.device.gpu } : {}), backend: res.device.backend,
            ...(pixels ? { samples: res.samples } : {}), ...(res.denoise ? { denoise: res.denoise } : {}),
          },
          timing: res.timing,
          origin: { host: ['camera', 'entities', 'lights', 'stats', 'source', 'timing'], shot: readings ? ['readings'] : [], kernel: ['events'] },
          hash: { color: pixels ? res.layers.color.hash : null },
          // 固定装载脚本记的账：做了哪几步、各种次序、相机从哪来、每个卡实例是谁调的、并进镜头之后叫什么
          ...(res.load ? { ext: { 'blender.load': res.load } } : {}),
        };
        return { meta, layers: res.layers };
      },

      /** 场景查询一种都没声明（能力声明的 sceneQuery 是空的）：问什么都报 contract.unsupported-query */
      async query(_f, q) {
        throw new SourceError('contract.unsupported-query', `这个帧源不答 ${show(record(q) ? own(q, 'kind') : undefined)} 查询`);
      },

      async close() {
        if (current !== session) return;
        current = null;
        await worker.call('close');
      },
    });
  }

  return { caps: () => caps(version, library), open, stop, device };
}
