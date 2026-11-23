// 离屏实验宿主（Node + Dawn WebGPU）：仅供 three 帧源在实验对拍模式下渲染 host:'any'（或实验指定 offscreen）镜头，
// 并与页面宿主（Chromium WebGL2）做双宿主像素对拍（PSNR ≥ 50 dB 且单通道差 > 5/255 的像素占比 ≤ 0.1%）。
// 严禁进入主线验收与基准考题；不引用 engine/offscreen/ 旧目录，保持架构守卫 100% 绿灯。
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderingOf } from '../../kernel/eval/input.mjs';
import { stream, streamName } from '../../kernel/eval/rng.mjs';
import { caps, VERSION } from '../../sources/three/caps.mjs';
import { resolveThreeHost, THREE_HOSTS } from '../../sources/three/hosts.mjs';
import { planFrame, planOpen, planRender, SourceError } from '../../sources/three/plan.mjs';

const bad = (message) => new SourceError('usage.bad-argument', message);
const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createFrameClock() {
  const queue = new Map();
  let seq = 0;
  const self = {
    requestAnimationFrame: (cb) => { queue.set(++seq, cb); return seq; },
    cancelAnimationFrame: (id) => { queue.delete(id); },
  };
  return {
    self,
    tick(ms) {
      const cbs = [...queue.values()];
      queue.clear();
      for (const cb of cbs) cb(ms);
    },
  };
}

let gpuCache = null;
let initChain = Promise.resolve();
function withInitLock(fn) {
  const run = initChain.then(fn, fn);
  initChain = run.catch(() => {});
  return run;
}

/**
 * 探测并装载 Node + Dawn WebGPU 与 three-webgpu。
 * 成功时返回 { available: true, THREE, adapter }；无 Dawn 依赖或无可用 GPU 适配器时返回 { available: false, reason }。
 */
export async function probeOffscreenGpu() {
  try {
    if (!gpuCache) {
      const dawn = await import('webgpu');
      const THREE = await import('three-webgpu/webgpu');
      Object.assign(globalThis, dawn.globals);
      const gpu = dawn.create([]);
      if (globalThis.navigator) Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true });
      else Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true });
      gpuCache = { THREE };
    }
    const adapter = await globalThis.navigator?.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { available: false, reason: 'Dawn 未找到可用的 WebGPU 适配器' };
    return { available: true, THREE: gpuCache.THREE, adapter };
  } catch (e) {
    return { available: false, reason: String(e?.message ?? e).split('\n')[0] };
  }
}

/**
 * 将线性光 Float32Array RGBA（[0..1]）或已量化的 Uint8Array / Uint8ClampedArray 转为 8-bit RGBA Uint8Array（0..255）。
 */
export function linearRgbaToUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof Uint8ClampedArray) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (!(data instanceof Float32Array)) throw bad('像素缓冲区必须是 Uint8Array、Uint8ClampedArray 或 Float32Array');
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const clamped = v <= 0 || Number.isNaN(v) ? 0 : v >= 1 ? 1 : v;
    out[i] = Math.round(clamped * 255);
  }
  return out;
}

const COMPARE_OPT_KEYS = ['width', 'height', 'minPsnr', 'maxDiff5Ratio'];

/**
 * 双宿主像素对拍比较器：
 * 计算 page 宿主与 offscreen 宿主在同一帧上的 RGB 三通道精确 PSNR（dB）以及任意 RGB 通道差值 > 5（8-bit 0..255 级）的像素占比。
 * 默认门槛：PSNR ≥ 50 dB 且 diffOver5Ratio ≤ 0.001（0.1%）；两帧完全一致时 psnrDb 为 Infinity。
 */
export function compareHostFrames(pageRgba, offscreenRgba, opts = {}) {
  if (!isPlainObj(opts)) throw bad('compareHostFrames 的 opts 必须是普通对象');
  for (const k of Object.keys(opts)) {
    if (!COMPARE_OPT_KEYS.includes(k)) throw bad(`compareHostFrames 的 opts 不认识键 ${k}`);
  }
  const { width, height, minPsnr = 50, maxDiff5Ratio = 0.001 } = opts;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw bad(`width 与 height 必须是正整数，给的是 ${String(width)}×${String(height)}`);
  }
  if (typeof minPsnr !== 'number' || !Number.isFinite(minPsnr) || minPsnr <= 0) {
    throw bad(`minPsnr 必须是大于 0 的有限数，给的是 ${String(minPsnr)}`);
  }
  if (typeof maxDiff5Ratio !== 'number' || !Number.isFinite(maxDiff5Ratio) || maxDiff5Ratio < 0 || maxDiff5Ratio > 1) {
    throw bad(`maxDiff5Ratio 必须是 [0, 1] 内的有限数，给的是 ${String(maxDiff5Ratio)}`);
  }

  const p8 = linearRgbaToUint8(pageRgba);
  const o8 = linearRgbaToUint8(offscreenRgba);
  const pixelCount = width * height;
  const expectedLength = pixelCount * 4;
  if (p8.length !== expectedLength || o8.length !== expectedLength) {
    throw bad(`RGBA 缓冲区长度必须等于 ${expectedLength}（${width}×${height}×4），实际为 ${p8.length} 与 ${o8.length}`);
  }

  let sqErrorSum = 0;
  let diffOver5Count = 0;
  let maxChannelDiff = 0;

  for (let i = 0; i < pixelCount; i++) {
    const base = i * 4;
    const dr = Math.abs(p8[base] - o8[base]);
    const dg = Math.abs(p8[base + 1] - o8[base + 1]);
    const db = Math.abs(p8[base + 2] - o8[base + 2]);
    const m = Math.max(dr, dg, db);
    if (m > maxChannelDiff) maxChannelDiff = m;
    if (m > 5) diffOver5Count++;
    sqErrorSum += dr * dr + dg * dg + db * db;
  }

  const mse = sqErrorSum / (pixelCount * 3);
  const psnrDb = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  const diffOver5Ratio = diffOver5Count / pixelCount;
  const ok = psnrDb >= minPsnr && diffOver5Ratio <= maxDiff5Ratio;

  return {
    ok,
    psnrDb,
    mse,
    diffOver5Count,
    diffOver5Ratio,
    maxChannelDiff,
    pixelCount,
    width,
    height,
  };
}

/**
 * 启动 Node + Dawn 离屏实验宿主。
 * 主线验收（mainline: true）或基准考题（exam: true）下调用一律报 SourceError('contract.unsupported-mode')。
 */
export async function openOffscreenHost(opts = {}) {
  if (opts !== undefined && !isPlainObj(opts)) throw bad('openOffscreenHost 的 opts 必须是普通对象');
  if (opts?.mainline === true || opts?.mainlineAcceptance === true || opts?.exam === true) {
    throw new SourceError('contract.unsupported-mode', 'three 离屏实验宿主（offscreen）严禁用于主线验收或基准考题');
  }

  const library = isPlainObj(opts?.cards) ? opts.cards : {};
  const CAPS = caps(library, { experimentalHosts: true });
  const probed = await probeOffscreenGpu();
  if (!probed.available) {
    throw new SourceError('env.webgpu-unavailable', `Node + Dawn 离屏实验宿主不可用：${probed.reason}`);
  }
  const { THREE, adapter } = probed;
  const device = await adapter.requestDevice({ requiredFeatures: [...adapter.features] });
  const sessions = new Set();
  let hostClosed = false;

  async function open(input, env = {}) {
    if (hostClosed) throw new Error('离屏实验宿主已关闭');
    if (!isPlainObj(input) || !isPlainObj(input.shot) || !isPlainObj(input.output)) {
      throw bad('input 必须是包含 shot 与 output 的普通对象');
    }
    if (!isPlainObj(env)) throw bad('env 必须是普通对象');
    if (env.mainline === true || env.mainlineAcceptance === true || env.exam === true || input.exam === true || input.shot.exam === true) {
      throw new SourceError('contract.unsupported-mode', 'three 离屏实验宿主（offscreen）严禁用于主线验收或基准考题');
    }
    if (typeof env.filmDir !== 'string' || !env.filmDir.trim()) {
      throw bad('env.filmDir 必须是非空路径字符串');
    }

    const resolvedHosts = resolveThreeHost(input.shot, {
      allowExperimental: true,
      mainline: Boolean(env.mainline || env.mainlineAcceptance),
      exam: Boolean(env.exam || input.exam || input.shot.exam),
    });
    const allowed = Array.isArray(resolvedHosts) ? resolvedHosts : [resolvedHosts];
    if (!allowed.includes('offscreen')) {
      throw new SourceError('contract.unsupported-mode', `镜头 ${input.shot.id} 解析出的宿主为 ${allowed.join('、')}，不允许在 offscreen 实验宿主上打开`);
    }

    const tier = env.tier ?? 'final';
    const locked = planOpen(CAPS, input, { ...env, tier, lock: env.lock ?? null }, library);
    const { mode, entry } = renderingOf(input.shot);
    if (mode !== 'native-code' || typeof entry !== 'string' || !entry.trim()) {
      throw new SourceError('contract.unsupported-mode', `离屏实验宿主当前只支持 native-code 镜头入口，给的是 ${String(mode)}`);
    }

    const [baseW, baseH] = input.output.size;
    const [fpsNum, fpsDen = 1] = String(input.output.fps ?? '24/1').split('/').map(Number);
    const fps = fpsNum > 0 && fpsDen > 0 ? fpsNum / fpsDen : 24;
    const clock = createFrameClock();
    const canvas = {
      width: baseW,
      height: baseH,
      style: {},
      addEventListener() {},
      removeEventListener() {},
      getContext() { throw new Error('离屏实验宿主无 DOM 画布上下文'); },
    };

    let renderer;
    await withInitLock(async () => {
      globalThis.self = clock.self;
      renderer = new THREE.WebGPURenderer({ canvas, antialias: false, device });
      await renderer.init();
    });
    renderer.setSize(baseW, baseH, false);

    const entryUrl = pathToFileURL(resolve(env.filmDir, entry)).href;
    const mod = await import(entryUrl);
    if (typeof mod.build !== 'function') {
      renderer.dispose();
      throw bad(`镜头入口 ${entry} 没有导出 build(ctx) 函数`);
    }

    const frames = input.shot.out - input.shot.in;
    const rng = (arg) => stream(streamName(locked.seed, input.shot.id, arg));
    const events = (input.events?.events ?? []).filter((e) => e.kind === 'named');
    const ctx = {
      THREE,
      renderer,
      size: [baseW, baseH],
      fps: input.output.fps,
      frames,
      params: input.shot.params ?? {},
      seed: locked.seed,
      rng,
      shot: Object.freeze({ id: input.shot.id, in: input.shot.in, frames }),
      tokens: structuredClone(input.tokens ?? {}),
      events: Object.freeze(Object.fromEntries(events.map((e) => [e.id, e.frame - input.shot.in]))),
      tracks: {},
      cards: { use() { throw new SourceError('contract.unsupported-mode', '离屏实验宿主 native-code 探针不接卡'); } },
      assets: { load(ref) { throw new Error(`资产 ${ref} 未装载`); } },
      anchor(entity, name) { throw new Error(`没有锚点 ${entity}#${name}`); },
    };

    const loaded = await mod.build(ctx);
    const names = Object.keys(loaded.entities ?? {}).sort();
    const manifest = {
      frames,
      entities: names.map((name, idx) => ({
        id: idx + 1,
        name,
        class: loaded.entities[name]?.isPoints ? 'particles' : names.some((n) => n.startsWith(`${name}.`)) ? 'assembly' : 'part',
      })),
    };
    const rt = new THREE.RenderTarget(baseW, baseH, {
      type: THREE.FloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });

    let sessionClosed = false;
    const session = {
      manifest: () => structuredClone(manifest),

      async render(f, renderOpts = {}, want = ['color', 'meta']) {
        if (sessionClosed || hostClosed) throw new Error('离屏实验会话已关闭');
        planFrame(frames, f);
        const plan = planRender(CAPS, input.shot, [baseW, baseH], tier, renderOpts, want, locked);
        const [w, h] = plan.size;
        rt.setSize(w, h);
        renderer.setSize(w, h, false);

        const sum = new Float64Array(w * h * 4);
        for (const sub of plan.subs) {
          clock.tick(((f + sub) * 1000) / fps);
          loaded.state?.(f, sub);
          if (loaded.camera?.isPerspectiveCamera) {
            const wantAspect = w / h;
            if (loaded.camera.aspect !== wantAspect) {
              loaded.camera.aspect = wantAspect;
              loaded.camera.updateProjectionMatrix();
            }
          }
          loaded.scene.updateMatrixWorld(true);
          loaded.camera.updateMatrixWorld(true);
          renderer.setRenderTarget(rt);
          renderer.render(loaded.scene, loaded.camera);
          const subPx = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h);
          for (let i = 0; i < sum.length; i++) sum[i] += subPx[i];
        }

        const colorF32 = Float32Array.from(sum, (v) => v / plan.subs.length);
        const rgba = linearRgbaToUint8(colorF32);
        return {
          width: w,
          height: h,
          rgba,
          colorF32,
          meta: {
            format: 'meta/0.1',
            film: input.film,
            shot: input.shot.id,
            shotFrame: f,
            size: [w, h],
            source: {
              id: input.shot.source,
              renderer: CAPS.id,
              host: 'offscreen',
              version: VERSION,
              tier,
              backend: THREE_HOSTS.offscreen.backend,
              experimental: true,
              samples: plan.pixelSamples,
            },
          },
        };
      },

      async close() {
        if (sessionClosed) return;
        sessionClosed = true;
        sessions.delete(session);
        loaded.dispose?.();
        rt.dispose();
        renderer.dispose();
      },
    };

    sessions.add(session);
    return session;
  }

  async function close() {
    if (hostClosed) return;
    hostClosed = true;
    for (const s of [...sessions]) await s.close();
    device.destroy();
  }

  return {
    caps: () => structuredClone(CAPS),
    open,
    close,
    stop: close,
  };
}

export const startOffscreenSource = openOffscreenHost;
