# 离屏出片（offscreen）：设计与第一个里程碑

读者｜做引擎工程、要把新作品改到离屏出片的人与 agent　状态｜第一个里程碑实验入口（2026-11-17，未接入正式出片链）　依据｜[决定书 D12](../decisions/2026-11-10-industrial-baseline.md)

**一句话**：A、C 的新作品用 three.js r187 的 WebGPURenderer 与 TSL 写成**作品模块**；同一份模块在 Chrome 的 WebGPU 里预览，在 Node + Dawn 里离屏出片，出片不经过浏览器。旧作品与 86 式风格库照旧走页面渲染器（`engine/render`）。

## 1. 为什么

页面渲染器在 RTX 4070 笔记本上实测（2026-11-17，A 模版 1080p，4 路）：

| 量 | 实测 |
|---|---|
| 页面绘制加 1 像素同步读回 | 每帧约 14.5 ms；这是包含 CPU 提交与同步的墙钟，不是 GPU 时间戳测量 |
| 整片稳态 | 约 20–25 帧/秒，含取帧、传输与编码，不能直接据此算 GPU 空闲比例 |
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
| `webgpu`（Dawn 官方 Node 绑定） | 0.6.2 | npm 元数据 MIT；包内 LICENSE.md 实际为 BSD-3-Clause，按原文履行义务 | 出片宿主的 GPU 设备 |
| `three-webgpu`（npm 别名，指向 `three@0.187.0`） | 0.187.0 | MIT | 作品模块的 THREE / TSL |

两项都放 `optionalDependencies`，缺了只影响离屏出片（退出码 3，提示怎么装），不影响现有链路。`three` 仍锁 r170；两版不混用，预览页用自己的 import map 指向 `three-webgpu`。`webgpu` 包解压后约 131 MiB（五个平台的 `dawn.node` 都在包里）。链路上没有 RAEA 与 vork，也不 import `engine/native/`：以后若做「客户提交作品描述与参数、系统自动出片」的线上服务，这条链路不受它们的许可限制。

## 3. 单卡并发与读回

- 一个 Node 进程里可以开多部片：每部片一个 `WebGPURenderer` 与一个渲染目标，共用一个 `GPUDevice`（构造时传 `device`）。
- 读回走流水线：渲第 n 帧、发起读回，不等它完成就渲第 n+1 帧；同时在途的帧数有上限（`inflight`，默认 3）。WebGPU 队列按提交顺序执行，第 n 帧的拷贝排在第 n+1 帧的渲染之前，所以复用同一个渲染目标是安全的；输出顺序按帧号。
- 编码默认 libx264（与页面渲染器同参数，终渲母版用它）。并发时 x264 会先成为瓶颈，所以可用 `--encoder nvenc` 改走显卡的 h264_nvenc（恒定质量 cq，色彩换算与标记不变），实测见 7.4；GPU 侧转 YUV（读回字节从 4 B/像素降到 1.5 B/像素）与 Dawn→CUDA 零拷贝尚未做。

## 4. 质量门

同一台机器上，预览与出片**不承诺逐字节相同**：Chrome 内置的 Dawn 与 npm 包版本不同，浮点运算、格式与驱动可能产生差异。当前正式对拍工具在演示作品的两种画幅、10 个采样帧上逐字节相同（第 7 节）；此前一次性原型曾有差 1 级等差异，未定位根因，不把它归因成 Dawn 版本差异。

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

平台：Linux、NVIDIA RTX 4070 Laptop 8 GiB、驱动 620.70.06、Node 26.8.2、three r187、Dawn Node 绑定 0.6.2、Chrome headless shell 153.0.8010.12。未在 macOS、Windows、5090 或云卡上重跑，不把这些平台写成已验证。

### 7.1 预览与出片

同一个 `lab/offscreen/ink.mjs` 在两边渲帧 `0,14,30,40,191`：960×540 与 1920×1080 均逐字节相同。另以 `191,3,77,30` 乱序对拍通过。把浏览器侧旋转故意多加 0.02 rad 的临时作品，质量门报 PSNR 27.14 dB、差 5 级以上像素 1.600%，退出 4，说明不是一个总放行的比较器。

这是演示作品通过，不是北冥完整画风通过：反向外壳线不能代替现有屏幕 ID 墨线；尚未迁移深度感知 Kuwahara、复杂材质、阴影、底板与文字 QA。演示作品也没有经过用户 look 签认。

### 7.2 单卡并发

1080p、每部 192 帧、同进程共用一个 GPUDevice；两次运行的总吞吐（帧/秒）。计时遍只渲染、读回和可选编码，**不做逐帧哈希**；另跑不计时的验证遍，逐帧核对并发与单部片一致。早期把哈希混进计时得到的 117–134 帧/秒不是纯渲染读回吞吐，已作废。

| 同时出片部数 | 渲染 + RGBA 读回 | 带 x264 medium crf14 编码 |
|---|---|---|
| 1 | 170.5–198.3 | 31.5–45.3 |
| 2 | 181.1–200.1 | 39.0–50.6 |
| 4 | 221.6–236.2 | 40.3–48.6 |
| 8 | 191.3–253.4 | 37.8–45.0 |

验证遍的帧哈希在并发与单部片之间一致；不是在计时遍旁同步计算哈希。两轮期间有其他桌面与测试负载，不能把波动范围当专用机器的性能保证，也不能把单卡最优并发写死。独立单条 CLI 渲 192 帧 1080p，含启动与编码约 4.98–5.32 秒（CLI 保留记录帧哈希，因此与基准的计时口径不同）。**这些数字不与旧 A 模版作加速倍数比较，两者场景与后期复杂度不同。** 本里程碑只是有界读回与并发测量，不是已完成的 GPU 满载调度器；编码后的吞吐明显低于只读回，编码仍是后续优化重点。

### 7.3 C 风格 2D 的取舍

一次性原型，不加入生产依赖，尺寸 640×360，均含完整 RGBA 读回：

| 对照 | 吞吐 | 画质与结论 |
|---|---|---|
| 既有 C 模版，Chrome Canvas 2D | 128.2 帧/秒 | 四帧参考 `30,72,128,176` |
| 同份 C 模版绘制代码，Skia Canvas 4.0.1 GPU | 149.5 帧/秒 | Vulkan / RTX 4070；PSNR 42.07 / 41.90 / 39.62 / 38.12 dB，未过 50 dB 门槛 |
| 同份 C 模版绘制代码，Skia CPU | 41.9 帧/秒 | PSNR 37.91–41.45 dB，未过门槛 |
| 新的 WebGPU 解析笔触 + Gaussian 湿边 + multiply 配方 | 480.1 帧/秒 | 对同配方 CPU 参考 PSNR 72.26 dB、最大差 1 级；仅内核原型，不是旧 C 模版整片 |

Skia 适配只换宿主画布、视口与字体登记，字形用同一份 OFL TTF；未改山体、笔触、合成绘制代码。新 WebGPU 配方与旧 C 模版不同，不能横比上述吞吐宣称整片加速。

**取舍**：新 C 作品优先在同一 WebGPU 设备上实现绘制与后期；Skia 保留为旧片按需迁移候选，不加进本里程碑依赖。完整文字、路径、纸齿与柔性模糊仍需逐项迁移、过质量门与用户 look 闸。不能把这次实验写成已支持全部 86 式。

### 7.4 编码器：x264 与 NVENC

`--encoder x264|nvenc`（`offscreen render` 与 `offscreen:bench` 都有）。默认 x264，码流与此前相同。

**画质与单路速度**（ffmpeg 单独跑，不含离屏渲染）：取 `media/beiming.mp4` 前 10 秒（1920×1040、240 帧，含 CPU 解码源片），分别用 libx264 medium crf18 与 h264_nvenc p5 cq18 重编码，再对原片算 PSNR。

| 编码器 | 单路 | 码率 | 对原片 PSNR 平均 / 最差帧 |
|---|---|---|---|
| libx264 medium crf18 | 85 fps | 15.0 Mbps | 45.6 / 44.0 dB |
| h264_nvenc p5 cq18 | 206 fps | 15.2 Mbps | 43.7 / 37.2 dB |

同码率下 NVENC 平均低约 2 dB，最差帧低约 7 dB，所以**终渲母版仍走 x264**；NVENC 用于预览与高并发。8 路 NVENC 同时编码全部成功（每路 30–32 fps，合计约 246 fps），没有碰到会话数上限；这只是这台机器与当前驱动的结果，不能外推到别的消费卡或数据中心卡。原片本身是 x264 编码的，所以这里的 PSNR 衡量的是「再编码损失」，不是对无损源的绝对画质。

**离屏链路吞吐**（`offscreen:bench --encode`，演示作品 `ink.mjs`，1080p，每部 480 帧，同进程多部并发）。注意口径：离屏默认 x264 是 crf14，NVENC 用 cq18，两者**质量并不等价**，这里比的是「各自默认设置下的整链路吞吐」。

| 同时出片部数 | x264 crf14 | NVENC cq18 |
|---|---|---|
| 4（x264 共 4 次、NVENC 共 5 次） | 62.7–75.2，中位 71.0 | 110.2–160.1，中位 126.4 |
| 1（单次） | 52.6 | 93.3 |
| 2（单次） | 69.4 | 94.5 |
| 8（单次） | 57.2 | 101.1 |

单位：总吞吐，帧/秒。每次运行的逐帧哈希都与单部片基线一致。4 部并发中位数之比约 1.8 倍。运行期间桌面合成器、语音识别与播放器还在占 GPU（15–47%），NVENC 的跑间波动明显大于 x264（同配置出现过 110 与 160）；单次档位的数字只能看量级。

**剩下的瓶颈**：换 NVENC 后总吞吐仍低于只渲染读回的 170–253 帧/秒。NVENC 运行时采样到 Node 主线程约 90–97%，GPU 利用率 15–20%、编码器引擎约 57%，主线程（读回拷贝与管道写入，约 8 MB/帧）是头号嫌疑；CPU 色彩换算单路约 860 fps，不是瓶颈。**这只是两三次采样得出的假设，未做专门验证。**

### 7.5 TSL Kuwahara 对 GLSL（M2 T2a）

`engine/offscreen/tsl/kuwahara.js` 是 `engine/look/kuwahara.js`（8 扇区，cos⁸ 角向 × 高斯径向，alpha 为保护量）的 TSL 版，算法与常数逐项照搬。**范围：不带远近换半径**（`farRadius`，要深度图）。真片的每个镜头都用了 `farRadius`（6–7，见 `routes/directing/templates/style-lock.json`），所以接进真实镜头之前还要做深度版（T2b），现在的版本不能直接顶替。

**一致性**：同一张合成输入（色块、斜纹渐变、确定性噪点、灯点保护区），GLSL 在无头 Chrome 的 WebGL 里跑，TSL 在 Dawn 里跑，320×180 / 640×360 下，半径 2、4、8（强度 0.7）与 q 取 4 的组合：PSNR 60.8–61.3 dB，最大差 1 级，差 5 级以上的像素为 0（约 12% 的像素有 ±1 的舍入差）。负对照：TSL 的 q 调成 3、GLSL 保持 8，质量门不过。变异检查：把 cos⁸ 改成 cos⁴，PSNR 降到 46.5 dB、最大差 13，测试变红。参考侧用的是页面渲染器同一个浏览器与启动参数（`tests/offscreen/glsl-reference.mjs`）。

**耗时**（1080p，RTX 4070 Laptop，桌面与其他负载共用 GPU，噪声约 ±1 ms；单次或三次量级，不是保证）：

| 采样半径 KR | 流水线吞吐（在途 3 帧，含读回） | 同步口径，仅 Kuwahara：TSL / GLSL（Chrome） |
|---|---|---|
| 基线（贴图直出 + 读回） | 216–228 fps | — |
| 4、5 | 215–225 fps（被读回限制，Kuwahara 看不出额外成本） | KR 4：≈ 0 / 4.5 ms |
| 6 | ≈ 106 fps | 6.5 / 7.0 ms |
| 7（真片 `farRadius` 6.5–7 的档位） | 81–84 fps（三次） | 10.0 / 8.7 ms |
| 8 | 66 fps | 12.2 / 11.0 ms |
| 10 | 45 fps | — |

TSL 版与现有 GLSL 版在同一量级（KR 6–8 差在 ±15% 内，两边计时口径不完全相同），没有因为换成 TSL 变慢。成本是 Kuwahara 本身的：KR ≥ 6 起它成为 GPU 瓶颈，真片的 KR 7 档单部片就被压到约 83 fps，比读回上限低一大截；并发时 GPU 会先饱和。可选的优化（半分辨率 Kuwahara、减少采样）会改画面，要过 look 闸，目前没有做。

### 7.6 快速复查

```sh
npm run offscreen -- render lab/offscreen/ink.mjs --out out/offscreen/ink.mp4 --frames 0:192 --size 1920x1080
npm run offscreen:compare -- lab/offscreen/ink.mjs --frames 0,14,30,40,191 --size 1920x1080
npm run offscreen:bench -- lab/offscreen/ink.mjs --films 1,2,4,8 --frames 192 --size 1920x1080
npm run offscreen:bench -- lab/offscreen/ink.mjs --films 1,2,4,8 --frames 192 --size 1920x1080 --encode
npm run offscreen:bench -- lab/offscreen/ink.mjs --films 4 --frames 480 --size 1920x1080 --encode --encoder nvenc
```

只执行仓库内受信作品模块，不是任意代码沙箱；以后对外服务必须加独立的任务参数校验与执行隔离。上述命令输出技术实验结果，不表示已通过 `film --final` 或用户交付认可。

## 8. 风险

- three r187 的 WebGPURenderer 与 TSL 仍在快速演进，升级可能改像素；锁版本，升级时重采金标准。
- `webgpu` 包与 Chrome 内置的 Dawn 版本不同，像素差可能随两边的升级变大；质量门会把它拦下来。
- Linux 上无头浏览器要加 `--enable-unsafe-webgpu --enable-features=Vulkan` 才拿得到 NVIDIA 适配器；这两个开关只用于预览，不改页面渲染器的启动参数。
- 渲染器许可干净不等于素材能对外：做线上服务前，86 式的 MIT 署名与客户素材要另查。
