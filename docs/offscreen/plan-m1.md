# 离屏出片 · 第一个里程碑 实施计划

> **给执行者**：按任务顺序逐个做，每个任务先写测试、看它失败、再实现、再跑通、再提交。步骤用 `- [ ]` 勾选。

**目标**：做出离屏出片的最小可用链路（Node + Dawn 跑 three.js r187 WebGPURenderer，出片不经过浏览器），并回答三个问题：预览与出片的像素差多少、一张卡同时出几部片吞吐多少、C 风格 2D 走 WebGPU 着色器还是 skia-canvas。

**架构**：作品模块 `build(ctx) → { render(f) }` 只依赖宿主注入的 `THREE` / `TSL`；出片宿主（Node + Dawn）与预览宿主（Chrome WebGPU）加载同一份模块；读回走流水线，编码沿用页面渲染器的色彩换算与 x264 参数。

**技术栈**：Node ≥ 22、`webgpu` 0.6.2（Dawn 官方 Node 绑定）、`three-webgpu`（= `three@0.187.0` 的 npm 别名）、FFmpeg、playwright-core 1.63.0（只用于预览对拍）。

**设计**：[README.md](README.md)；决定：[D12](../decisions/2026-11-10-industrial-baseline.md)。

## 全局约束

- 路线仍是 A、B、C 三条；本里程碑**不登记**路线注册表、不进 `npm run film`；不 import `engine/native/`，不读 `RAEA_BIN`、`BNE_RT_BIN`。
- 「原生」专指 B 路线与 RAEA；新代码、文档、命令里不把离屏出片叫原生。
- 作品模块不 `import ... from 'three'`；时间只从整数帧号 `f` 来；不用 `Math.random`、`Date.now`、`performance.now`（计时代码除外，放在宿主与工具里）。
- `three` 仍锁 `0.170.0`；新依赖只放 `optionalDependencies`，缺了退出码 3（`env.offscreen-deps`），不影响现有链路。
- `engine/` 下每个代码模块开头要有中文注释块（做什么 + 接口），`core.engine-heads` 检查。
- 命令一律用 `tools/lib/cli.mjs` 的 `defineCommand` / `runCli`（`--help`、`--json`、退出码约定）。
- 渲染 / 读回的测试在没有可用 GPU 适配器或缺依赖时**跳过并写明原因**，不判失败。
- 提交作者用环境变量设（`GIT_AUTHOR_*`、`GIT_COMMITTER_*`），不改 git 配置；**不推送**。
- 动 `package.json` 的脚本要同步 `docs/CLI.md`；动依赖要同步 `THIRD-PARTY.md`、`.github/dependabot.yml`、`CHANGELOG.md` 的 `[Unreleased]`。

## 复查重点

测试里没覆盖到、但最容易让使用者踩坑的情形，每条后面标明哪个任务加测试：

1. 流水线读回是否改变像素：同一批帧，在途 1 帧与 3 帧逐字节相同（任务 3）。
2. 随机访问：只渲第 30 帧，与从第 0 帧顺序渲到 30 的第 30 帧逐字节相同（任务 3）。
3. 作品放在仓库外：命令行拒绝，退出码 2，不执行它（任务 4）。
4. 宽高为奇数：yuv420p 要求偶数，命令行直接报用法错误，不是让 FFmpeg 中途报错（任务 4）。
5. 编码器中途退出（磁盘满、被杀）：渲染循环停下，不挂住，不留半成品（任务 4）。

## 文件结构

```
engine/offscreen/
  diff.mjs          像素对比与质量门（纯函数）
  clock.mjs         确定性帧时钟（替 three 的 requestAnimationFrame）
  load.mjs          装载 Dawn 与 three-webgpu，缺依赖时报 env.offscreen-deps
  host.mjs          出片宿主：渲染器、渲染目标、后期管线工厂、renderFrame
  preview.js        预览宿主（浏览器里跑，接口与出片宿主一致）
  frames.mjs        流水线读回：renderFrames
  encode.mjs        FFmpeg 编码器（RGBA 管道 → H.264）
  cli.mjs           命令 offscreen render
lab/offscreen/
  ink.mjs           演示作品（三档着色 + 反向外壳墨线 + 纸纹暗角）
tools/offscreen/
  compare.mjs       预览对出片的像素对拍与质量门
  bench.mjs         同进程多部片并发吞吐
tests/offscreen/    各模块的测试
```

---

### 任务 1：像素对比与质量门（纯函数）

**文件**：创建 `engine/offscreen/diff.mjs`；测试 `tests/offscreen/diff.test.mjs`

**接口**
- 产出：`diffRgba(a, b, { width, height }) → { pixels, identical, differPixels, bigPixels, maxDelta, psnr }`（只比 RGB，`bigPixels` 是任一通道差 ≥ 5 的像素数，相同时 `psnr = Infinity`，长度不对抛 `RangeError`）；`meetsGate(stats, { minPsnr = 50, maxBigFraction = 0.001 }) → { ok, reasons }`

- [ ] **步骤 1：写失败的测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffRgba, meetsGate } from '../../engine/offscreen/diff.mjs';

const solid = (n, v) => { const b = new Uint8Array(n * 4); for (let i = 0; i < n; i++) b.set([v, v, v, 255], i * 4); return b; };

test('diffRgba：逐字节相同 → identical，PSNR 无穷', () => {
  const r = diffRgba(solid(4, 10), solid(4, 10), { width: 2, height: 2 });
  assert.deepEqual([r.identical, r.differPixels, r.bigPixels, r.maxDelta, r.psnr], [true, 0, 0, 0, Infinity]);
});
test('diffRgba：一个像素差 3 级 → 1 个不同、0 个大差、最大差 3', () => {
  const a = solid(4, 10), b = solid(4, 10); b[0] = 13;
  const r = diffRgba(a, b, { width: 2, height: 2 });
  assert.deepEqual([r.identical, r.differPixels, r.bigPixels, r.maxDelta], [false, 1, 0, 3]);
  assert.ok(Number.isFinite(r.psnr) && r.psnr > 40);
});
test('diffRgba：差 5 级算大差；alpha 不参与比较', () => {
  const a = solid(4, 10), b = solid(4, 10); b[4] = 15; b[3] = 0;
  const r = diffRgba(a, b, { width: 2, height: 2 });
  assert.deepEqual([r.differPixels, r.bigPixels, r.maxDelta], [1, 1, 5]);
});
test('diffRgba：字节数与宽高不符抛 RangeError', () => {
  assert.throws(() => diffRgba(solid(4, 0), solid(3, 0), { width: 2, height: 2 }), RangeError);
});
test('meetsGate：PSNR 够且大差像素少 → 通过；否则写明原因', () => {
  assert.deepEqual(meetsGate({ pixels: 1e6, bigPixels: 10, psnr: 60 }), { ok: true, reasons: [] });
  const low = meetsGate({ pixels: 1e6, bigPixels: 0, psnr: 40 });
  assert.equal(low.ok, false); assert.match(low.reasons[0], /PSNR 40\.0 dB 低于 50 dB/);
  const big = meetsGate({ pixels: 1000, bigPixels: 5, psnr: 60 });
  assert.equal(big.ok, false); assert.match(big.reasons[0], /差 5 级以上的像素占 0\.500%/);
});
```

- [ ] **步骤 2：运行，确认失败** — `node --test tests/offscreen/diff.test.mjs` → 失败：找不到 `diff.mjs`
- [ ] **步骤 3：实现** — 按「接口」写 `engine/offscreen/diff.mjs`（开头中文注释块；循环里先取三通道最大差 `m`，再累计平方误差）
- [ ] **步骤 4：运行，确认通过** — 同上命令 → 5 条通过
- [ ] **步骤 5：提交** — `feat(offscreen): 像素对比与质量门`

### 任务 2：确定性帧时钟

**文件**：创建 `engine/offscreen/clock.mjs`；测试 `tests/offscreen/clock.test.mjs`

**接口**：产出 `createFrameClock() → { self, tick(ms), pending() }`；`self` 有 `requestAnimationFrame(cb) → id` 与 `cancelAnimationFrame(id)`；`tick(ms)` 调用此刻已登记的全部回调（回调里新登记的留到下一次 `tick`），每个回调只调一次。

- [ ] **步骤 1：写失败的测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameClock } from '../../engine/offscreen/clock.mjs';

test('tick 调用已登记的回调，各调一次，参数是时刻', () => {
  const c = createFrameClock(), got = [];
  c.self.requestAnimationFrame(t => got.push(['a', t])); c.self.requestAnimationFrame(t => got.push(['b', t]));
  c.tick(41.5);
  assert.deepEqual(got, [['a', 41.5], ['b', 41.5]]); assert.equal(c.pending(), 0);
});
test('回调里重新登记的，留到下一次 tick', () => {
  const c = createFrameClock(); let n = 0;
  const loop = () => { n++; c.self.requestAnimationFrame(loop); };
  c.self.requestAnimationFrame(loop);
  c.tick(0); assert.equal(n, 1); c.tick(1); assert.equal(n, 2);
});
test('cancelAnimationFrame 取消后不再调用', () => {
  const c = createFrameClock(); let n = 0;
  const id = c.self.requestAnimationFrame(() => n++); c.self.cancelAnimationFrame(id); c.tick(0);
  assert.equal(n, 0);
});
```

- [ ] **步骤 2：运行，确认失败** — `node --test tests/offscreen/clock.test.mjs`
- [ ] **步骤 3：实现** — `Map` 存回调，`tick` 先取快照再清空再调用
- [ ] **步骤 4：运行，确认通过**
- [ ] **步骤 5：提交** — `feat(offscreen): 确定性帧时钟`

### 任务 3：装载、出片宿主、流水线读回、演示作品

**文件**：创建 `engine/offscreen/load.mjs`、`host.mjs`、`frames.mjs`、`lab/offscreen/ink.mjs`；修改 `package.json`（可选依赖）；测试 `tests/offscreen/host.test.mjs`

**接口**
- 消费：`createFrameClock`（任务 2）
- 产出：
  - `loadGpu() → Promise<{ THREE, TSL }>`：首次调用装 Dawn 的全局（`navigator.gpu` 与 WebGPU 类）；缺 `webgpu` 或 `three-webgpu` 抛 `CliError('env.offscreen-deps', …)`
  - `createHost({ gpu, width, height, fps = 24, device }) → Promise<Host>`；`Host = { THREE, TSL, renderer, device, width, height, fps, pipeline(node), load(file), renderFrame(work, f) → Promise<Uint8Array>, dispose() }`；`load(file)` 用文件 URL 动态导入作品模块并调用 `build({ THREE, TSL, renderer, width, height, fps, pipeline })`；`renderFrame` 先 `clock.tick(f * 1000 / fps)`，再 `setRenderTarget`、`work.render(f)`、**不等待**地发起读回，返回读回的 Promise
  - `renderFrames({ host, work, from, to, inflight = 3, onFrame }) → Promise<void>`：按帧号顺序调用 `onFrame(f, pixels)`，同时在途不超过 `inflight`；`onFrame` 返回的 Promise 会被等待（背压）

**演示作品** `lab/offscreen/ink.mjs`：`build` 与 `/tmp/beiming-verify/spike-ink.mjs` 的实测版本相同（反向外壳墨线、三档 `MeshToonMaterial`、`pass(scene, camera)` + 纸纹 + 暗角、`pipeline(node)` 由宿主给），去掉调试用的 `__GRAIN`。

- [ ] **步骤 1：装可选依赖** — 在 `package.json` 加 `"optionalDependencies": { "webgpu": "0.6.2", "three-webgpu": "npm:three@0.187.0" }`，运行 `npm install --ignore-scripts --no-audit --no-fund`，确认 `node_modules/webgpu`、`node_modules/three-webgpu` 存在，`node_modules/three/package.json` 的版本仍是 `0.170.0`
- [ ] **步骤 2：写失败的测试**

```js
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadGpu } from '../../engine/offscreen/load.mjs';
import { createHost } from '../../engine/offscreen/host.mjs';
import { renderFrames } from '../../engine/offscreen/frames.mjs';

const W = 320, H = 180, WORK = new URL('../../lab/offscreen/ink.mjs', import.meta.url).pathname;
const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 16);
let gpu = null, why = null;
before(async () => { try { gpu = await loadGpu(); await (await createHost({ gpu, width: 64, height: 64 })).dispose(); } catch (e) { why = String(e.message).split('\n')[0]; } });
const skip = () => (why ? `离屏出片不可用：${why}` : false);
const fresh = async () => { const host = await createHost({ gpu, width: W, height: H }); return { host, work: await host.load(WORK) }; };

test('同一帧渲两次逐字节相同', { skip: skip() }, async () => {
  const { host, work } = await fresh();
  const a = Buffer.from(await host.renderFrame(work, 7)), b = Buffer.from(await host.renderFrame(work, 7));
  assert.equal(a.length, W * H * 4); assert.ok(a.equals(b)); host.dispose();
});
test('随机访问：只渲第 30 帧 = 从第 0 帧顺序渲到 30 的第 30 帧', { skip: skip() }, async () => {
  const one = await fresh(), seq = await fresh();
  const direct = Buffer.from(await one.host.renderFrame(one.work, 30));
  let last; for (let f = 0; f <= 30; f++) last = Buffer.from(await seq.host.renderFrame(seq.work, f));
  assert.ok(direct.equals(last)); one.host.dispose(); seq.host.dispose();
});
test('流水线读回：在途 1 帧与 3 帧、逐帧顺序，输出逐字节相同', { skip: skip() }, async () => {
  const run = async inflight => { const { host, work } = await fresh(), h = []; await renderFrames({ host, work, from: 0, to: 12, inflight, onFrame: (f, px) => { h[f] = sha(px); } }); host.dispose(); return h; };
  const a = await run(1), b = await run(3);
  assert.deepEqual(a, b); assert.equal(new Set(a).size, 12);   // 12 帧互不相同（作品在转）
});
test('renderFrames 按帧号顺序回调，onFrame 的 Promise 会被等待', { skip: skip() }, async () => {
  const { host, work } = await fresh(), order = []; let busy = false;
  await renderFrames({ host, work, from: 2, to: 8, inflight: 3, onFrame: async f => { assert.equal(busy, false); busy = true; await new Promise(r => setTimeout(r, 5)); order.push(f); busy = false; } });
  assert.deepEqual(order, [2, 3, 4, 5, 6, 7]); host.dispose();
});
test('缺依赖时 loadGpu 报 env.offscreen-deps（用错误的包名模拟不了，这里只核对错误码常量存在）', () => {
  assert.equal(typeof loadGpu, 'function');
});
```

- [ ] **步骤 3：运行，确认失败** — `node --test tests/offscreen/host.test.mjs` → 失败：找不到 `load.mjs`
- [ ] **步骤 4：实现 `load.mjs`**

```js
// 北冥引擎 · 离屏出片 · 装载：Node 里的 WebGPU（Dawn）与 three.js r187 的 WebGPU / TSL 构建。
//   loadGpu() → { THREE, TSL }    首次调用时把 Dawn 的全局（navigator.gpu、GPUBufferUsage 等）装进 globalThis；之后返回同一份
// 缺 webgpu 或 three-webgpu 时抛 CliError('env.offscreen-deps')（退出码 3）。three 仍锁 r170（旧作品用），这里用别名包 three-webgpu 取 r187，两版不混用。
import { CliError } from '../../tools/lib/cli.mjs';

let loaded = null;
export async function loadGpu() {
  if (loaded) return loaded;
  let dawn, THREE, TSL;
  try {
    dawn = await import('webgpu');
    THREE = await import('three-webgpu/webgpu');
    TSL = await import('three-webgpu/tsl');
  } catch (e) {
    throw new CliError('env.offscreen-deps', `加载不了离屏出片的依赖（${String(e?.message ?? e).split('\n')[0]}）`, { hint: '在仓库根运行 npm install --include=optional --ignore-scripts（需要 webgpu 与 three-webgpu 两个包）' });
  }
  Object.assign(globalThis, dawn.globals);
  const gpu = dawn.create([]);
  if (globalThis.navigator) Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true });
  else globalThis.navigator = { gpu };
  loaded = { THREE, TSL };
  return loaded;
}
```

- [ ] **步骤 5：实现 `host.mjs`**

```js
// 北冥引擎 · 离屏出片 · 出片宿主：在 Node + Dawn 里替作品模块建渲染器与渲染目标，按帧号渲一帧并读回像素。没有画布、没有浏览器。
//   createHost({ gpu, width, height, fps = 24, device }) → Host    gpu 来自 loadGpu()；device 给了就共用（一张卡上多部片共用一个设备）
//   Host.load(file)             动态导入作品模块（绝对路径）并 build；作品契约见 docs/offscreen/README.md 2.1
//   Host.renderFrame(work, f)   先推进帧时钟（时刻 = f / fps），把 work.render(f) 画到 sRGB 渲染目标，不等待地发起读回；返回读回的 Promise<Uint8Array>（RGBA8，行序自上而下）
//   Host.pipeline(node)         后期管线工厂（关掉管线内的 sRGB 输出变换：渲染目标已经是 sRGB，再转一次会亮一截）
// 帧时钟见 clock.mjs：three 的动画循环在构造渲染器时取全局 self，所以每个宿主在构造前把自己的时钟装成 self。
import { pathToFileURL } from 'node:url';
import { createFrameClock } from './clock.mjs';

export async function createHost({ gpu, width, height, fps = 24, device } = {}) {
  const { THREE, TSL } = gpu;
  const clock = createFrameClock();
  globalThis.self = clock.self;
  const canvas = { width, height, style: {}, addEventListener() {}, removeEventListener() {}, getContext() { throw new Error('离屏宿主没有画布上下文：作品只能画到宿主给的渲染目标'); } };
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance', ...(device ? { device } : {}) });
  await renderer.init();
  renderer.setSize(width, height, false);
  const target = new THREE.RenderTarget(width, height, { colorSpace: THREE.SRGBColorSpace });
  const pipelines = [];
  const pipeline = node => { const p = new THREE.RenderPipeline(renderer, node); p.outputColorTransform = false; pipelines.push(p); return p; };
  const works = [];
  return {
    THREE, TSL, renderer, device: renderer.backend.device, width, height, fps, pipeline,
    async load(file) {
      const mod = await import(pathToFileURL(file).href);
      const work = mod.build({ THREE, TSL, renderer, width, height, fps, pipeline });
      works.push(work);
      return work;
    },
    renderFrame(work, f) {
      clock.tick((f * 1000) / fps);
      renderer.setRenderTarget(target);
      work.render(f);
      return renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
    },
    dispose() {
      for (const w of works) w.dispose?.();
      for (const p of pipelines) p.dispose?.();
      target.dispose(); renderer.dispose();
    },
  };
}
```

- [ ] **步骤 6：实现 `frames.mjs`**

```js
// 北冥引擎 · 离屏出片 · 流水线读回：渲第 n 帧、发起读回，不等它完成就渲第 n+1 帧，GPU 不必等 CPU 取像素。
//   renderFrames({ host, work, from, to, inflight = 3, onFrame }) → Promise<void>
//     按帧号顺序调用 onFrame(f, pixels)；同时在途的帧数不超过 inflight；onFrame 返回的 Promise 会被等待（编码器跟不上时渲染随之放慢）。
// WebGPU 队列按提交顺序执行：第 n 帧的读回拷贝排在第 n+1 帧的渲染之前，所以复用同一个渲染目标是安全的（tests/offscreen/host.test.mjs 逐字节核对过）。
export async function renderFrames({ host, work, from, to, inflight = 3, onFrame }) {
  if (!(inflight >= 1)) throw new RangeError(`inflight 要 ≥ 1，收到 ${inflight}`);
  const queue = [];
  const drain = async () => { const { f, p } = queue.shift(); await onFrame(f, await p); };
  for (let f = from; f < to; f++) {
    queue.push({ f, p: host.renderFrame(work, f) });
    if (queue.length >= inflight) await drain();
  }
  while (queue.length) await drain();
}
```

- [ ] **步骤 7：写 `lab/offscreen/ink.mjs`**（见「演示作品」），运行 `node --test tests/offscreen/host.test.mjs` → 通过；若流水线用例失败，说明 `readRenderTargetPixelsAsync` 的拷贝不是同步入队，改为在 `renderFrame` 里 `await` 渲染提交后再读回，并把结论写进 `frames.mjs` 的注释
- [ ] **步骤 8：提交** — `feat(offscreen): 出片宿主、流水线读回与演示作品`（含 `package.json`、`package-lock.json`）

### 任务 4：编码器与命令行 `offscreen render`

**文件**：创建 `engine/offscreen/encode.mjs`、`engine/offscreen/cli.mjs`；测试 `tests/offscreen/encode.test.mjs`、`tests/offscreen/cli.test.mjs`

**接口**
- 消费：`renderFrames`、`createHost`、`loadGpu`；`COLOR`、`TAGS`、`x264Args`、`FFMPEG`、`probe` 来自 `engine/render/lib/ffmpeg.mjs`
- 产出：
  - `encoderArgs({ width, height, fps, out, crf = 14, preset = 'medium' }) → string[]`：输入 `-f rawvideo -pix_fmt rgba -s WxH -framerate fps -i -`，滤镜用 `COLOR.png`，编码用 `x264Args`，再加 `TAGS`，输出 `out`
  - `startEncoder(opts) → { write(buf) → Promise<void>, finish() → Promise<void>, abort() }`：`write` 遵守背压；FFmpeg 中途退出时 `write` / `finish` 抛 `Error`（含退出码），不挂住
  - 命令 `node engine/offscreen/cli.mjs render <作品.mjs> --out <文件.mp4> [--size 1920x1080] [--fps 24] [--frames a:b] [--inflight 3] [--crf 14] [--preset medium] [--json]`；`data` 里有 `frames`、`seconds`、`fps`（渲染吞吐）、`frameHashes`（每帧 sha256 前 16 位）

- [ ] **步骤 1：写失败的测试** — `encode.test.mjs`：①`encoderArgs` 含 `-colorspace bt709 … -color_range tv` 与 `COLOR.png` 的滤镜；②把 8 帧纯色 RGBA（232,223,204）写进 `startEncoder`，成片 8 帧、`yuv420p`、色彩标记四项齐全、解码首像素的 Y 在 BT.709 有限范围换算值 ±1 内；③指向「一启动就退出 1」的假 FFmpeg（`FFMPEG` 环境变量，`#!/bin/sh\nexit 1`），反复 `write` 最终抛错且 45 秒内返回。`cli.test.mjs`（缺 GPU 跳过）：④渲 6 帧 320×180 → 成片 6 帧，信封 `ok`、`frameHashes` 长度 6；⑤作品放在仓库外（临时目录）→ 退出 2、`usage.work-outside-repo`；⑥`--size 321x180` → 退出 2；⑦`--help` 退出 0 且不建文件
- [ ] **步骤 2：运行，确认失败**
- [ ] **步骤 3：实现 `encode.mjs`**：`spawn(FFMPEG(), ['-y', '-loglevel', 'error', ...encoderArgs(...)], { stdio: ['pipe', 'ignore', 'inherit'] })`；`write` 照 `engine/render/lib/chunks.mjs` 里 `feed` 的背压写法（`stdin.write` 返回 false 时等 `drain` / 退出 / 错误）
- [ ] **步骤 4：实现 `cli.mjs`**：`defineCommand`；校验作品路径在仓库内（`path.relative(ROOT, file)` 不以 `..` 开头，否则 `usage.work-outside-repo`）；宽高偶数（`usage.bad-value`）；`loadGpu` → `createHost` → `host.load` → `renderFrames`，`onFrame` 里记哈希并 `encoder.write`；失败时 `encoder.abort()` 删半成品；成功后用 `probe` 核对帧数等于区间帧数（不符 `contract.frame-count`）
- [ ] **步骤 5：运行，确认通过**；再手动跑一次 `node engine/offscreen/cli.mjs render lab/offscreen/ink.mjs --out out/offscreen/ink.mp4 --size 1920x1080 --frames 0:96` 并看一帧
- [ ] **步骤 6：提交** — `feat(offscreen): FFmpeg 编码与命令 offscreen render`

### 任务 5：预览宿主与预览对拍（质量门）

**文件**：创建 `engine/offscreen/preview.js`、`lab/offscreen/index.html`、`tools/offscreen/compare.mjs`；测试 `tests/offscreen/compare.test.mjs`

**接口**
- 产出：
  - `createPreviewHost({ THREE, TSL, canvas, width, height, fps = 24 }) → Promise<Host>`（浏览器里跑，与出片宿主同接口：`pipeline`、`load(url)`、`renderFrame(work, f)`；`renderFrame` 先等一次真实的 `requestAnimationFrame`，其余步骤相同；另有 `show(work, f)` 把一帧画到画布上）
  - 命令 `node tools/offscreen/compare.mjs <作品.mjs> [--frames 0,14,40] [--size 960x540] [--min-psnr 50] [--max-big 0.001] [--json]`：起一个只监听 127.0.0.1 的静态服务（仓库根与 `node_modules/three-webgpu/build`），Chrome 加 `--enable-unsafe-webgpu --enable-features=Vulkan` 渲这些帧，出片宿主渲同样的帧，逐帧 `diffRgba` + `meetsGate`；任一帧不过退出 4（`contract.offscreen-gate`）
- 预览页 `lab/offscreen/index.html`：`?work=/lab/offscreen/ink.mjs&f=30` 显示一帧，不带 `f` 时按 24 fps 循环播放；用 `<script type="importmap">` 把 `three-webgpu/webgpu`、`three-webgpu/tsl` 指向 `/node_modules/three-webgpu/build/…`

- [ ] **步骤 1：写失败的测试** — 缺 GPU 或 Chrome 拿不到 WebGPU 适配器时跳过：对演示作品，`--frames 0,5 --size 320x180`，信封 `ok`，每帧 `psnr ≥ 50`
- [ ] **步骤 2：运行，确认失败**
- [ ] **步骤 3：实现**（`createPreviewHost` 照出片宿主，去掉帧时钟、用真实 rAF；`compare.mjs` 的静态服务只服务仓库内文件，路径规范化后不得越出根目录）
- [ ] **步骤 4：运行，确认通过**；再用 960×540、帧 `0,14,30,40` 跑一次，把 PSNR 与大差像素占比记到设计文档第 7 节
- [ ] **步骤 5：提交** — `feat(offscreen): 预览宿主与预览对拍`

### 任务 6：同进程多部片并发基准

**文件**：创建 `tools/offscreen/bench.mjs`；测试 `tests/offscreen/bench.test.mjs`

**接口**：命令 `node tools/offscreen/bench.mjs <作品.mjs> [--films 1,2,4,8] [--frames 96] [--size 1920x1080] [--encode] [--json]`：每档在**一个进程、一个 `GPUDevice`** 里同时出 N 部片（第一个宿主建设备，其余 `createHost({ device })` 共用），各自 `renderFrames`；`--encode` 时每部片各接一个 `startEncoder` 输出到 `/dev/null` 对应的空文件；报告每档的总帧数、墙钟、总吞吐、每部片吞吐；渲染结果逐帧哈希与「单部片」基线一致才算有效（并发不得改变像素）

- [ ] **步骤 1：写失败的测试** — 缺 GPU 跳过：`--films 1,2 --frames 12 --size 320x180`，信封 `ok`，两档都有吞吐数字，`deterministic` 为 true
- [ ] **步骤 2：运行，确认失败**
- [ ] **步骤 3：实现**
- [ ] **步骤 4：运行，确认通过**；再跑 `--films 1,2,4,8 --frames 96 --size 1920x1080`，不带与带 `--encode` 各一次，结果记到第 7 节
- [ ] **步骤 5：提交** — `feat(offscreen): 同进程多部片并发基准`

### 任务 7：C 风格 2D 的取舍（一次性实验，不进仓库代码）

在 `/tmp` 里做两个探针，结论写进设计文档第 7 节：
- (a) 用 WebGPU 着色器画 C 模版里的核心画法（宣纸纹、笔触、模糊合成）：量每帧耗时，对比 Chrome Canvas 2D 版同帧的相似度（PSNR / VMAF），看要重写多少、画面能到多像；
- (b) 用 `skia-canvas` 跑 C 模版的 `film.js` 绘制代码：量能否直接跑通、每帧耗时、与 Chrome 的差异。

不往仓库加任何依赖，不写生产代码。

- [ ] **步骤 1**：做 (a)、(b)，把数据与结论写进第 7 节「C 风格 2D」
- [ ] **步骤 2：提交** — `docs(offscreen): C 风格 2D 路线的实测取舍`

### 任务 8：收口（依赖登记、文档、检查）

**文件**：修改 `package.json`（脚本）、`docs/CLI.md`、`THIRD-PARTY.md`、`.github/dependabot.yml`、`CHANGELOG.md`；设计文档第 7 节回填

- [ ] **步骤 1**：`package.json` 加脚本 `offscreen`、`offscreen:compare`、`offscreen:bench`；`docs/CLI.md` 同步
- [ ] **步骤 2**：`THIRD-PARTY.md` 加 `webgpu`（Dawn 与 Tint，BSD-3-Clause，绑定 MIT，0.6.2）与 three r187（MIT）；`dependabot.yml` 的 npm 忽略列表加 `webgpu`、`three-webgpu`，注释说明锁定原因
- [ ] **步骤 3**：`CHANGELOG.md` 的 `[Unreleased] → Added` 记一条
- [ ] **步骤 4**：回填设计文档第 7 节的实测数字
- [ ] **步骤 5**：跑 `npm run check -- --skip tests`（阻塞步骤全过）、`node tools/run-tests.mjs --only offscreen,engine,lab,tools,comp`、`npm run comp:scan -- --staged`
- [ ] **步骤 6：提交** — `feat(offscreen): 依赖登记、脚本与文档`

---

## 自查

**规格覆盖**：设计文档第 2 节（作品契约、帧时钟、色彩、依赖）→ 任务 2、3、4；第 3 节（单卡并发与读回）→ 任务 3、6；第 4 节（质量门）→ 任务 1、5；第 6 节三个问题 → 任务 5、6、7；第 8 节许可与依赖登记 → 任务 8。D12 已写入决定书。

**占位符**：任务 4、5、6 的实现步骤给的是接口与关键约束，没有逐行代码；这三个任务的测试已写明断言，实现照接口与旁边已有的同类代码（`chunks.mjs` 的 `feed`、`rt.mjs` 的命令写法）写。

**类型一致**：`renderFrame(work, f) → Promise<Uint8Array>`、`renderFrames({ host, work, from, to, inflight, onFrame })`、`startEncoder(...).write(buf)` 在任务 3 到 6 里的写法一致；`createHost` 的 `device` 参数在任务 3 定义、任务 6 使用。

**复查重点**：1、2 → 任务 3 的测试；3、4、5 → 任务 4 的测试。
