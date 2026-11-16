# 离屏出片（offscreen）：设计与第一个里程碑

读者｜做引擎工程、要把新作品改到离屏出片的人与 agent　状态｜实验（2026-11-17，第一个里程碑进行中）　依据｜[决定书 D12](../decisions/2026-11-10-industrial-baseline.md)

**一句话**：A、C 的新作品用 three.js r187 的 WebGPURenderer 与 TSL 写成**作品模块**；同一份模块在 Chrome 的 WebGPU 里预览，在 Node + Dawn 里离屏出片，出片不经过浏览器。旧作品与 86 式风格库照旧走页面渲染器（`engine/render`）。

## 1. 为什么

页面渲染器在 RTX 4070 笔记本上实测（2026-11-17，A 模版 1080p，4 路）：

| 量 | 实测 |
|---|---|
| GPU 真正干活 | 每帧约 14.5 ms，单路上限约 69 帧/秒 |
| 整片稳态 | 约 20–25 帧/秒：GPU 大约三分之二的时间在等 |
| 一帧从页面回到 Node | base64 经 CDP，1080p 一帧 36 ms；4 路合计约 78–84 帧/秒封顶，换 WebSocket 也一样 |

浏览器里最贵的是取帧与搬运，不是渲染。离屏出片把渲染留在 GPU 上，用 `mapAsync` 把像素直接读进 Node 内存，没有 CDP、base64 与进程间搬运；一个进程里可以开多部片，共用一个 GPU 设备，由我们自己排队。

## 2. 架构

```
作品模块  build(ctx) → { render(f), dispose?() }      只依赖注入进来的 THREE / TSL，不 import three，不碰 DOM
   ├── 预览宿主：Chrome 页面（lab/offscreen/），WebGPU      创作、look 闸
   └── 出片宿主：Node + Dawn（engine/offscreen/）           终渲、批量并发
                └→ 读回（流水线）→ FFmpeg 编码 → 成片
```

### 2.1 作品模块契约

```js
export function build({ THREE, TSL, renderer, width, height, fps, pipeline }) {
  // 建场景、材质、后期；只在这里分配资源
  return {
    render(f) { /* 按整数帧号 f 作画，画到宿主当前的渲染目标 */ },
    dispose() { /* 可选：释放 build 里建的资源 */ },
  };
}
```

- `THREE`、`TSL` 由宿主注入，作品**不写 `import ... from 'three'`**：仓库里 `three` 锁在 r170（旧作品用），裸导入在 Node 里会拿到旧版。
- `pipeline(outputNode)` 是宿主给的后期管线工厂，返回 `RenderPipeline`，已关掉管线内的色彩输出变换（见 2.3）。作品不要自己 `new RenderPipeline`。
- 时间只从 `f` 来：不用 TSL 的 `time` / `deltaTime`，不用 `Date.now`、`performance.now`、`Math.random`；随机一律 `engine/core/math.js` 的 `mulberry(种子)` 或 TSL `hash`。
- `render(f)` 只画，不读回、不换渲染目标；宿主负责渲染目标、帧时钟与读回。

### 2.2 确定性帧时钟

three 只在 `requestAnimationFrame` 回调里推进节点帧号，场景 pass 按帧号去重：帧号不动，`pass(scene, camera)` 只渲第一次。出片宿主把 three 登记的回调存起来，每出一帧手动调用一次（时刻 = f / fps 秒），帧号每帧加一；预览宿主每帧先等一次真实的 `requestAnimationFrame`。两边都是「每帧一次」，与浏览器的节奏相同。

### 2.3 色彩

宿主给的渲染目标是 sRGB（`colorSpace: SRGBColorSpace`）：作品直接 `renderer.render(scene, camera)` 时，three 在写入时转成 sRGB。后期管线默认在着色器里也转一次 sRGB，叠在一起会亮一截（实测背景 232 → 244），所以 `pipeline()` 统一设 `outputColorTransform = false`。读回的是 sRGB 8 位 RGBA，编码沿用页面渲染器的色彩换算（`engine/render/lib/ffmpeg.mjs` 的 `COLOR.png`、`TAGS`）：有限范围 BT.709 yuv420p，四项色彩标记完整。

### 2.4 依赖与版本并存

| 依赖 | 版本 | 许可 | 用途 |
|---|---|---|---|
| `webgpu`（Dawn 官方 Node 绑定） | 0.6.2 | 绑定 MIT；Dawn 与 Tint BSD-3-Clause | 出片宿主的 GPU 设备 |
| `three-webgpu`（npm 别名，指向 `three@0.187.0`） | 0.187.0 | MIT | 作品模块的 THREE / TSL |

两项都放 `optionalDependencies`，缺了只影响离屏出片（退出码 3，提示怎么装），不影响现有链路。`three` 仍锁 r170；两版不混用，预览页用自己的 import map 指向 `three-webgpu`。`webgpu` 包解压后约 131 MiB（五个平台的 `dawn.node` 都在包里）。链路上没有 RAEA 与 vork，也不 import `engine/native/`：以后若做「客户提交作品描述与参数、系统自动出片」的线上服务，这条链路不受它们的许可限制。

## 3. 单卡并发与读回

- 一个 Node 进程里可以开多部片：每部片一个 `WebGPURenderer` 与一个渲染目标，共用一个 `GPUDevice`（构造时传 `device`）。
- 读回走流水线：渲第 n 帧、发起读回，不等它完成就渲第 n+1 帧；同时在途的帧数有上限（`inflight`，默认 3）。WebGPU 队列按提交顺序执行，第 n 帧的拷贝排在第 n+1 帧的渲染之前，所以复用同一个渲染目标是安全的；输出顺序按帧号。
- 编码先用 libx264（与页面渲染器同参数）。并发时 CPU 编码会先成为瓶颈：第一个里程碑只测量，GPU 侧转 YUV（读回字节从 4 B/像素降到 1.5 B/像素）与 NVENC 留到第二个里程碑按数据决定。

## 4. 质量门

同一台机器上，预览与出片**不保证逐字节相同**：两边的 Dawn 版本不同（Chrome 内置的与 npm 包里的），浮点在最后一位有出入。实测（演示作品 960×540 第 30 帧，去掉纸纹扰动）：86.51% 像素相同，13.49% 差 1 级，差 5 级以上的不到万分之一，PSNR 60.1 dB；不带后期的简单场景三帧逐字节相同。

门槛（`tools/offscreen/compare.mjs` 判定）：同机同帧，预览对出片 **PSNR ≥ 50 dB**，且**差 5 级以上的像素 ≤ 0.1%**。另外：

- 出片自身必须确定：同一作品同一帧渲两次逐字节相同；流水线、在途帧数、同进程并发都不改变输出。
- 金标准以离屏出片为准，平台键单开（与页面渲染器的不混）；画风认可仍走 look 闸（D08）。

## 5. 与现有链路的关系

- 路线仍是 A、B、C 三条（D12）。登记时 A、C 的 `backends` 加 `webgpu`，`renderers` 加第三项 `offscreen`；**第一个里程碑不登记**，不进 `npm run film` 出片链，照 rt 后端的先例做成链路之外的实验入口。
- 「原生」在仓库里专指 B 路线与 RAEA（`backend: native`、`engine/native/`）；离屏出片不叫原生。
- 机器 QA 的文字检查靠探 Canvas 2D 的 `fillText`，WebGPU 画的字查不到；接进出片链时，作品要照页面约定给出 `TEXTS`。

## 6. 第一个里程碑

回答三个问题，并留下可用的实验入口：

1. 预览与出片的像素差多少：按第 4 节的门槛，在演示作品上实测。
2. 一张卡同时出几部片、总吞吐多少：`tools/offscreen/bench.mjs` 测 1、2、4、8 部同进程并发，分「只渲染读回」与「带编码」两档。
3. C 风格的 2D 走 WebGPU 着色器，还是出片时改用 skia-canvas：在 `/tmp` 里做一次性探针，结论写进第 7 节，不往仓库加依赖。

交付物：`engine/offscreen/`（加载、作品契约、宿主、编码与命令行）、`lab/offscreen/`（预览页与演示作品）、`tools/offscreen/`（对拍与基准）、`tests/offscreen/`。实施计划见 [plan-m1.md](plan-m1.md)。

## 7. 实测结果

（第一个里程碑完成后填写。）

## 8. 风险

- three r187 的 WebGPURenderer 与 TSL 仍在快速演进，升级可能改像素；锁版本，升级时重采金标准。
- `webgpu` 包与 Chrome 内置的 Dawn 版本不同，像素差可能随两边的升级变大；质量门会把它拦下来。
- Linux 上无头浏览器要加 `--enable-unsafe-webgpu --enable-features=Vulkan` 才拿得到 NVIDIA 适配器；这两个开关只用于预览，不改页面渲染器的启动参数。
- 渲染器许可干净不等于素材能对外：做线上服务前，86 式的 MIT 署名与客户素材要另查。
