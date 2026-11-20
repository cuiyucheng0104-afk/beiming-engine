// Blender 帧源的宿主（node 一侧）：帧源对上层的接口就在这里。起一个常驻的后台 Blender（-b -noaudio --factory-startup），
// 用标准输入输出上按行分隔的 JSON 和 worker.py 说话；一个进程同一时刻只装一个镜头，装载和各帧都在这一个进程里做。
// 计划（装不装得了、要的输出交不交得出、生效的快门、输出尺寸）是这里的纯函数，不碰 Blender；交不出的请求一律报带错误码的错。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { caps, DRAFT_MAX_SIZE } from './caps.mjs';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'worker.py');
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
 * 装载之前：装不了就报错，装得了返回 { seed, shutterSamples?, entry }。
 * 先后照帧源接口契约 5.14：宿主或作者模式没声明 → 没有锁文件又缺种子、用了卡或资产 → 有装不了的输入。
 */
export function planOpen(c, input, env) {
  if (!record(input) || !record(own(input, 'shot')) || !record(env)) throw bad('input、input.shot 和 env 必须是对象');
  const shot = own(input, 'shot'), renderer = record(own(shot, 'renderer')) ? own(shot, 'renderer') : shot;
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
  // shortcut: 卡、资产、叠加层都还没接：带着来就报错，不少装一样照常装载；接的时候在这里读锁里的版本和哈希
  const unfit = [cards && '卡', assets && '资产', overlays && '叠加层'].filter(Boolean);
  if (unfit.length) throw new SourceError('contract.unsupported-input', `${c.id} 帧源还没接${unfit.join('、')}`);
  if (typeof entry !== 'string' || !entry) throw bad(`${show(mode)} 模式的镜头必须写 entry`);
  if (lock === null) return { seed: own(shot, 'seed'), entry };
  if (!record(lock)) throw bad('lock 必须是对象或 null');
  const shotLock = own(own(lock, 'shots'), shotId);
  const seed = own(own(lock, 'seeds'), shotId), shutterSamples = record(shotLock) ? own(shotLock, 'shutterSamples') : undefined;
  if (!Number.isInteger(seed) || !Number.isInteger(shutterSamples)) throw bad(`锁文件里没有镜头 ${show(shotId)} 的种子或子帧采样数`);
  return { seed, shutterSamples, entry };
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
function startWorker(blenderBin, scratch, limitMs, handshakeMs, stopMs) {
  const child = spawn(blenderBin, ['-b', '-noaudio', '--factory-startup', '--python', WORKER, '--', scratch], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    else waiter.fail(msg.code ? new SourceError(msg.code, msg.message) : new Error(msg.message));
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
 * 起一个 Blender 帧源：一个常驻的 Blender 进程。交回 { caps, open, stop, device }：caps 和 open 是帧源接口，
 * stop 关掉进程并清掉临时目录，device 是实际用的后端（{ backend, gpu? }）。没有 Blender 报 env.missing-tool。
 * open 得到的会话有 manifest、render、query、close；同一时刻只能有一个没关的会话。
 */
export async function startSource({ blenderBin = findBlender(), limitMs, handshakeMs = limitMs ?? 60000, stopMs = 5000 } = {}) {
  if (!blenderBin) throw new SourceError('env.missing-tool', '找不到 Blender：设环境变量 BEIMING_BLENDER 指向它的可执行文件，或者把 blender 放进 PATH');
  for (const ms of [handshakeMs, stopMs, ...(limitMs === undefined ? [] : [limitMs])]) {
    if (!finite(ms) || ms <= 0 || ms > 2147483647) throw bad('超时毫秒数必须在 (0, 2147483647]');
  }
  const scratch = await mkdtemp(join(tmpdir(), 'beiming-blender-'));
  let worker, hello;
  const stop = async () => {
    try { await worker?.stop(); } finally { await rm(scratch, { recursive: true, force: true }); }
  };
  try {
    worker = startWorker(blenderBin, scratch, limitMs, handshakeMs, stopMs);
    hello = await worker.call('hello');
    if (typeof hello.version !== 'string' || typeof hello.backend !== 'string') throw new Error('Blender 握手缺少版本或后端');
  } catch (e) {
    await stop();
    throw e;
  }
  const { version, ...device } = hello;
  const CAPS = caps(version);
  let current = null;

  async function open(input, env) {
    // lock 必须写出来，哪怕是 null：忘了传当场报错
    const missing = ENV_KEYS.filter((k) => own(env, k) === undefined);
    if (missing.length) throw bad(`env 缺 ${missing.join('、')}`);
    const locked = planOpen(CAPS, input, env);
    if (current) throw bad('这个 Blender 进程里还有没关的会话：先 close 再 open');
    const { shot, output } = input, frames = shot.out - shot.in;
    // 事件表是上层展开好的，帧号是全片帧号；镜头输入不带事件表时每帧的 events 是空数组
    const timeline = input.events?.events ?? [];
    const session = {};
    current = session;
    let entities;
    try {
      ({ entities } = await worker.call('open', {
        entry: resolve(env.filmDir, locked.entry), frames, fps: output.fps, size: output.size, seed: locked.seed,
        tokens: input.tokens ?? {}, tier: env.tier, colorRef: shot.colorRef,
      }));
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
        const res = await worker.call('render', { f, plan, workspace: resolve(env.workspace), dir });
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
          stats: res.stats,
          source: {
            id: shot.source, renderer: CAPS.id, host: CAPS.hosts[0], version, tier: env.tier,
            ...(res.device.gpu ? { gpu: res.device.gpu } : {}), backend: res.device.backend,
            ...(pixels ? { samples: res.samples } : {}), ...(res.denoise ? { denoise: res.denoise } : {}),
          },
          timing: res.timing,
          origin: { host: ['camera', 'entities', 'lights', 'stats', 'source', 'timing'], shot: [], kernel: ['events'] },
          hash: { color: pixels ? res.layers.color.hash : null },
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

  return { caps: () => caps(version), open, stop, device };
}
