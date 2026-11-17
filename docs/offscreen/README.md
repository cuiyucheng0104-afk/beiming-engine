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

- `build` 可以是 `async`（M3 起）：宿主等它返回，作品可以先载字体子集、画布与底板。
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

`engine/offscreen/tsl/kuwahara.js` 是 `engine/look/kuwahara.js`（8 扇区，cos⁸ 角向 × 高斯径向，alpha 为保护量）的 TSL 版，算法与常数逐项照搬。远近换半径（`farRadius`）是 T2b，见下文「深度换半径」，不给 `far` 参数就是全幅同一半径。真片的每个镜头都用了 `farRadius`（6–7，见 `routes/directing/templates/style-lock.json`）。

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

**深度换半径（M2 T2b）**：`kuwahara(TSL, { …, far: { depth, radius, start, end, near, farClip } })`。每像素按视距 z 在 `radius` 与 `far.radius` 之间做 smoothstep（`start`、`end` 同 GLSL 的 `farStart`、`farEnd`），深度 ≥ 0.9999999 当无穷远（天空、清屏处）；`KR` 仍由调用方按 `ceil(max(radius, far.radius))` 取。视距用 three 的 `perspectiveDepthToViewZ` 从深度换算，它和 GLSL 版用的是同一个公式，并认 `reversedDepthBuffer`。
- 对拍：合成深度图（视距沿 x 从 5 铺到 100，右上角一块天空）下，近处 3 → 远处 8、过渡带 20..120：PSNR 61.19 dB，最大差 1 级，差 5 级以上的像素 0。负对照：TSL 不带 far，PSNR 38.5 dB、大差像素 8773；过渡带挪到 40..140，PSNR 47.5 dB、大差像素 460，都过不了质量门。变异检查：去掉天空特判、把 smoothstep 换成线性，测试都变红。
- 深度约定：WebGPU 的零到一深度与 WebGL 在这个换算上没有差别。用 Dawn 渲一块垂直于视线、离相机 10 与 60 的平面，`pass(scene, camera).getTextureNode('depth')` 经 `perspectiveDepthToViewZ` 换回的视距与真实距离一致（读回与预期的 sRGB 值相同或差 1 级；用例在 `tests/offscreen/kuwahara.test.mjs`）。所以 `pass()` 的深度纹理可以直接当 `far.depth`。
- 耗时（1080p，KR 7，近处 2 → 远处 7，在途 3 帧含读回，同上那台机器，各跑两遍）：不带 far 85.0 / 86.8 fps，带 far 87.3 / 86.2 fps，没有额外成本（循环次数由 KR 决定，每像素半径只改步长）。
- 没做：正交相机不给 `far`（与 GLSL 一致）；深度图来自真实镜头（带蒙皮、实例化、半透明物体）时的行为要等 T3 的 ID 通道接入后在真实镜头上对拍。

### 7.6 TSL 墨线与 ID 通道（M2 T3）

`engine/offscreen/tsl/idpass.js`（`engine/look/ids.js` 的子集）与 `engine/offscreen/tsl/ink.js`（`engine/look/ink.js` 的对应）：ID 图 + 深度 → 边缘（近的一侧拥有这条线）→ 笔画（圆头笔 + 域扭曲抖动 + 笔压 + 断线）。算法与常数逐项照搬，ID 编码相同（HalfFloat，低 11 位 + 高位 × 2048，线宽系数，可见度），哈希是同一个 PCG。用法：`createInk({ THREE, TSL, renderer }, { width, height }).render({ scene, camera, p, t, k, ss, fps })`，结果在 `ink.line`（R 通道 = 覆盖率）；渲完还原渲染目标，合成时 `texture(ink.line.texture)` 取样。

**一致性**：同一个场景（`tests/offscreen/fixtures/ink-scene.mjs`：两个相交的方块、同组部件、半透明线的球、实心遮挡物与地面、不挡线的加色面片、极远处的方块），GLSL 在无头 Chrome 的 WebGL 里跑，TSL 在 Dawn 里跑，320×180：

| 用例 | 与 GLSL 的差 |
|---|---|
| 默认参数（k = 1） | 逐字节相同（PSNR 无穷大，最大差 0） |
| k = 2、换沸腾拍、断线 0.4、笔压 0.5 | 逐字节相同 |
| 折痕阈值 0.004、不透明度 0.8、内线 0.4、farScale 0.3、k = 1.5 | PSNR 95.7 dB，最大差 1 级，大差像素 0 |

三组都带有抗锯齿的中间值（有墨的 4147 / 6774 / 6379 个像素里，覆盖率在 8..246 之间的分别是 2698 / 4444 / 6379 个；第三组不透明度 0.8，最浓只有 204，所以全是中间值），不是只对上了「有墨 / 没墨」。负对照：沸腾拍不同、折痕阈值不同都过不了质量门。变异检查：笔画噪声不翻 y，PSNR 11.9 dB；互相穿插时让 ID 小的一侧画，PSNR 31.4 dB；去掉笔压项，PSNR 29.2 dB，测试都变红。`boilSeed` 另有单测与 `engine/look/ink.js` 的同名函数逐帧对拍（不直接 import 它，那个文件顶层会把仓库的 three r170 装进离屏的 r187 进程）。

**坐标约定**：WebGPU 的屏幕坐标是左上角原点，GLSL 的 `gl_FragCoord` 是左下角。边缘检测对翻转对称；笔画的域扭曲噪声按坐标取值，所以笔画那一遍把 y 翻回 GL 约定，这样同一帧同一参数下笔画与 A 路线逐点一致。深度仍是零到一的透视深度（见 7.5）。

**耗时**（1080p 输出，含读回，在途 3 帧，同上那台机器，各跑两遍）：墨线缓冲 1080p（ss = 1）205 / 266 fps；缓冲 3840×2160（ss = 2，A 路线的默认）77 / 79 fps。只量了 TSL，没有量同场景的 GLSL 版；这个场景的搜索半径不大（线宽 2.5、k = 1），k 大了搜索半径随之变大（最多 16），耗时会更高。

**未支持的 ID 语义**（遇到抛 `Error`，`code` 为 `unsupported.outline`，message 里写明物体与原因，抛错后材质与渲染器状态原样还原，不静默画错）：InstancedMesh、SkinnedMesh、BatchedMesh、变形目标；多材质数组（描边物体与 soft / own 遮挡物）；描边物体带贴图的 alpha 镂空（`alphaTest` 或 `transparent` + `map`）；描边物体的材质自带顶点位移（`positionNode`）；`outlineVertex`、`outlinePerInstance: false`。`outlineOccluder` 的 `'soft'`、`'own'` 在 M3 T3 补上了（包括 auto 判成它们的半透明物体与 Sprite）：沿用物体自己的材质、只临时改混合，同 GLSL 版；对拍场景加了半透明面纱、半透明精灵与 own 遮挡物之后仍与 GLSL 逐字节相同，把 soft 或 own 当成不挡线，PSNR 掉到 24–25 dB。要用到这些的作品，先扩范围再做片。支持的：不透明 Mesh 的 `outline` / `outlineWidth` / `outlineAlpha` / `outlineGroup`、实心遮挡、soft / own 遮挡与 `outlineOccluder: false`、材质 `userData.noId`、`visible = false`、Points / Line / 加色 / 正片叠底 / `colorWrite = false` 不挡线。

**没做**：雾里变淡（`fogFade`，GLSL 版在 fog = null 时也是 0）；与真实镜头的对拍（要等 T4 的合成与 T5 的真片）。

### 7.7 A 风格后期链（M2 T4）

`engine/offscreen/tsl/look.js` 把 `engine/look/index.js` 的后期链按同一个顺序在 TSL 里串起来：主场景（HalfFloat、带深度）→ 墨线（7.6）→ bloom → 调色 → 输出变换（线性 → sRGB 数值）→ Kuwahara（远处换半径，7.5）→ 叠墨线 → 纸纹 → 暗角 →（颗粒）。各道是独立模块：`tsl/{bloom,grade,paper,compose}.js`，共用 `tsl/{noise,pass,color}.js`。参数合并、默认值与种子直接用 `engine/look/index.js` 导出的纯函数（`lookDefaults`、`lookParams`、`grainCellOf`、`grainSeedOf`），语义不另抄一份，风格锁定的 `lookDefaults.params` 原样可用。

用法：`const look = createLook({ THREE, TSL, renderer }, { width, height, ss: 2, msaa: 0, defaults, paper })`；每帧 `look.render(scene, camera, { t, ...每帧参数 })` 画中间缓冲，`pipeline(look.output).render()` 出最终画面。`look.node` 是与 GLSL 版写进目标的字节一致的 sRGB 数值，`look.output` 是它过了 `sRGBTransferEOTF` 的版本：宿主的渲染目标本身是 sRGB 的，直接交 `look.node` 会被编码两次。这一来一回在 8 位上至多差 1 级，是宿主目标约定带来的，不是算法差异。

**一致性**：同一个场景（7.6 的 `ink-scene`），风格锁定 `beiming-original.v1` 的真实参数，GLSL 在无头 Chrome 的 WebGL 里跑 `createLook`（msaa 0），TSL 在 Dawn 里跑，320×180、ss = 2：

| 用例 | PSNR | 最大差 | 大差像素 |
|---|---|---|---|
| 风格锁定的真实参数（曝光 1.6，程序化纸纹） | 60.4 dB | 1 级 | 0 |
| 全部旋钮（调色各字段、墨线色与吸收、Kuwahara 远近换半径、bloom、纸纹放大、暗角、颗粒 size 3 / holdFrames 2） | 60.7 dB | 1 级 | 0 |
| 图片纸纹（合成的 64×64 纸纹图，scale 1.5） | 60.4 dB | 1 级 | 0 |

逐级开关时（各阶段单独打开，调试时测的）：调色 / 暗角 / 颗粒 / 墨线 / Kuwahara / 纸纹 / bloom 各自的最大差都是 1 级。负对照：bloom 关掉、调色改了、纸纹强度改了、墨线关掉、暗角改了，质量门都过不了。变异检查：去掉高光肩，PSNR 31.6 dB；纸齿浮雕光向反了，31.0 dB；图片纸纹不翻 v，33.5 dB；纤维取非转置，最大差 3（只靠「最大差在舍入范围内」那条断言抓住），测试都变红。

**踩到的两个坑**（写在这里，下一个写 TSL 的人别再踩）：
- TSL 里 `toVar()` 与 `Loop` 要在 `Fn(() => …)()` 里才生效；用普通箭头函数包着，循环累加出来全是 0，而且不报错。
- 把 256 个节点连加成一棵表达式树，WGSL 解析器会报 `maximum parser recursive depth reached`；用 `Loop` 累加。

**坐标约定**：纸纹与颗粒按 `gl_FragCoord`（左下角原点）取值，这里用 `glCoord` 翻回 GL 约定；纸纹纹理的行序是自上而下，取样时 v 翻成 1 - v，所以图片纸纹要给「图片的行序（自上而下）」的 `DataTexture`。bloom 是半分辨率的光晕图，调色里按 UV 双线性取样，不能按全分辨率像素 `load`。

**程序化纸纹的中性点**：GLSL 版把整幅纸纹的均值读回 CPU；离屏的读回是异步的，所以在 GPU 里求平均（16×16 的 8 位目标，每格 8×8 个点，再平均到 1×1 的浮点目标），节点直接读它。实测 0.5057，CPU 对同一张图是 0.5063，差异在对拍的 1 级之内。

**MSAA**：`msaa` 默认 0（A 路线默认 4）。msaa = 4 能出画面、深度与墨线照常工作，与 msaa 0 的差只在边缘（PSNR 37.7 dB，最大差 137，1285 个大差像素）；两边 MSAA 的采样位置与解析不保证相同，所以逐字节对拍都用 msaa = 0，msaa = 4 没有与 A 路线对拍过。

**耗时**（1080p、风格锁定的参数、整条链含读回，在途 3 帧，同上那台机器）：

| 配置 | fps |
|---|---|
| ss = 2、msaa 0（A 路线的默认超采样） | 63–65 |
| ss = 2、msaa 4 | 68 |
| ss = 1、msaa 0 | 193 |
| ss = 2、关 Kuwahara | 75 |
| ss = 2、关墨线 | 214 |

墨线在 ss = 2 时是大头（4K 的缓冲，7.6），Kuwahara 约占 15%。只量了 TSL，没有量同场景的 GLSL 版。

**未支持**（遇到抛 `Error`，`code` 为 `unsupported.look` / `unsupported.paper` / `unsupported.outline`，渲染目标原样还原）：雾（`fog`）；`debug` 视图；色调映射（`renderer.toneMapping` 不是 `NoToneMapping`，与风格锁定一致）；纸纹的 `scaleMode`、`anchor`、每帧换图（`tex` / `url`）。**没做的**：在 Node 里把 `assets/plates/paper.png` 解码成 `DataTexture` 并算 `mid`（风格锁定的纸纹是这张图；调用方解码后经 `paper: { tex, mid }` 交进来，图片纸纹的像素模式已用合成图对拍过）；真实镜头（卡通材质、实例化等）上的对拍，留给 T5。

### 7.8 M3：Canvas 2D 与几何桥

M3 的目标是让离屏出真片（计划见 [plan-m3.md](plan-m3.md)）。头两步：

- **Canvas 2D**（`engine/offscreen/canvas.mjs`，可选依赖 `@napi-rs/canvas` 1.1.1，Skia）：`loadCanvas()` 给 `createCanvas`；`loadFilmFonts(dir)` 读作品的字体子集清单 `fonts.json` 并按字族名注册，返回值与浏览器版 `engine/style/fonts.js` 相同（两边共用 `fontsOf`），缺字同样抛 `GlyphError`。woff2 子集可以直接注册，`letterSpacing` 可用。**字形与 Chrome 不逐像素相同**：同一段片名（Ma Shan Zheng 110 px，`北冥渡`）墨量差 2%，PSNR 29.9 dB，差 5 级以上的像素 3.2%，全在字形边缘（两边的抗锯齿与字形微调不同）。片名题字的对拍只能到这个量级；QA 的读字与安全区检查用文字框，不受影响。
- **几何桥**（`engine/offscreen/bridge.mjs`）：`engine/form` 的造型函数顶层 import 了 r170，几何按属性拷进 r187 即可复用（数组共用内存，自定义属性、索引、分组、`userData` 都带过去）。相机工具 `engine/stage/camera.js` 直接操作 r187 的相机就行，不需要桥。所以离屏侧只需要换着色层。

### 7.9 TSL 卡通材质（M3 T2）

`engine/offscreen/tsl/toon.js` 是 `engine/shade/toon.js` 的对应：同一个 `toonKind(spec) → { make, bind, shared }`，参数表 `TOON_BASE`、乘法色调 `tintFrom`、共享状态的写法 `setToonShared` 直接用 GLSL 版导出的，光照合成逐式照搬（三档分色、两道羽化与 fwidth 抗锯齿、交界线噪声、天空冷光、两档补光、两层边缘光与 rimCore 亮芯撕边、墨色、叠加色）。表面层 `tsl/surface.js` 目前只有 `patchLayer`。作品同一份 opts 交给两边：GLSL 钩子写字符串，TSL 版写在 `opts.tsl = { fragmentBase(c), fragmentAlbedo(c), uniforms }` 里，钩子读写 `c.diffuse`、`c.ink`、`c.overlay`，顶点属性直接用 `attribute('aRock')` 取（不需要 GLSL 那样先写 varying）。

**实现方式**：材质继承 `NodeMaterial`、开 `lights`，挂自定义光照模型：`direct()` 逐盏平行光记下方向与阴影量，`finish()` 按 r170 的规则选主光（第一盏投影光，没有就取第一盏平行光），写进属性节点 `toonL`、`toonAtt`，把 `outgoingLight` 置 0（r187 先把各项反射光加总进它、再调 `finish`）；整套合成是 `make()` 时建好的节点，`setupLighting` 把它接在光照输出后面。场景里没有灯时 r187 不走光照模型，`setupOutgoingLight` 交出另一份用 `uKeyDirW`、不接投影的合成（同 GLSL 版）。同一份材质可以放进不同镜头的场景，跟着各自的主光走。

**投影**：主光先 `useR170Shadow(TSL, light)`，滤波照搬 r170 的 `PCFSoftShadowMap`（4 个整纹素 + 12 个按小数位置插值的取样，深度比较最近邻）；r187 已删掉 `PCFSoftShadowMap`（设了会被换成 `PCFShadowMap` 并打一条警告），用 `PCFShadowMap` 即可：这时深度纹理开了硬件比较过滤，但照搬的取样点都先对齐到纹素中心，双线性权重是 1/0/0/0，等于逐纹素比较。投影量化 `smoothstep(shadowLo, shadowHi)` 在材质里做，只在 `shadow.intensity = 1` 时与 GLSL 版相同（不是 1 抛错）。

**一致性**（480×270，后期全关，同一个场景：显式三档色与乘法色调、rimCore、斑块表面层、带两个钩子的柱子）：不带投影、无灯、换墨线时钟、带主光投影，四组都是 PSNR 68.5–68.6 dB、最大差 1 级、大差像素 0。反例：改分档阈值、去掉亮芯、钩子的墨线时钟不同、锈斑量不同、投影量化窗口不同、关掉投影压档，都过不了质量门。换成 r187 默认的阴影滤波（Vogel 圆盘 + 逐像素旋转）PSNR 53.8 dB、大差像素 95，所以滤波必须照搬。

**踩到的坑**：
- **在编译途中现建的节点，它引用的 uniform 之后改值不再上传**（r187）。最初合成节点是在光照模型的 `finish()` 里现建的：结构相同的两个材质串用 uniform（第二个画成第一个的颜色），而且第一帧之后改参数全不生效——墨线时钟、日出时调的边缘光都冻在第一帧。单个场景的对拍测不出来（参数都在第一帧前设好），是《晨渡》逐帧对拍里「先渲第 96 帧再渲第 120 帧、第 120 帧就变了」才暴露的。现在整套合成在 `make()` 时就建成节点，主光方向与阴影量从两个属性节点 `toonL`、`toonAtt` 读，光照模型只给它们赋值；`toon.test.mjs` 有一条「渲染途中改参数」的回归用例。最小复现：同一个 uniform，写在 `colorNode` 里改值即生效，写在 `setupLighting` 或光照模型里现建的节点里就不生效；节点在构造时建好、只在编译时引用则正常。
- 一开始漏了投影量化，阴影边界差了约 0.5% 的像素，我先误以为是两个后端阴影图的光栅化差异；是「改量化窗口」这个反例结果纹丝不动才暴露出来。

**不支持**（抛 `unsupported.toon`）：InstancedMesh、半透明 / `translucent`、`map`、`vertexColors`、`rest`、`outlineVertex`、`defines`、顶点形变钩子的 TSL 版（材质只认片元钩子）、`spec.shade` 等 GLSL 插桩、`paintLayer` / `muralLayer`。只给了 GLSL 钩子、没给 `opts.tsl` 也抛错，不静默少画皴线。

### 7.10 底板、辉光与画布贴图（M3 T4）

`engine/offscreen/tsl/plates.js` 是 `engine/stage/plates.js` 的对应：`await createPlates({ THREE, TSL })` 返回同名同参数的 `loadPlates / plateMat / plate / plateCopy / tileRepeat / canvasLayer / cropPlate / cutoutPlane / glowSprite`。`loadPlates` 读 `plates.json` 与 PNG（`tools/plates/png.mjs` 解码，`dir` 是文件系统路径）；`canvasLayer` 的画布是 Skia，贴图在上传时才读画布像素；`cropPlate`、`glowSprite` 的 GLSL 改成 TSL，`glowSprite` 的材质照样挂 `uniforms`（作品每帧 `mat.uniforms.amt.value = …` 不用改）。贴图约定与 A 路线一致：sRGB、行序按图片、mip 链 + 三线性 + 各向异性 8。作品模块的 `build` 从这一步起可以是 `async`。

**一致性**（480×270，后期全关，天空 `sky_dawn` + 透明云 `clouds_front_a` 做普通底板、软边裁片、抠像面片，两个辉光，一张画布贴图）：PSNR 61.9 dB、最大差 9 级、差 5 级以上的像素 110 个（0.085%，门槛 0.1%）。大差像素全在画布贴图里一块深色矩形的硬边上：贴图缩小显示时走 mip 链，两个后端各自生成 mip（WebGL 驱动对 three 的降采样），硬边处差几级。变异检查：辉光不压扁 36.7 dB、画布不翻 y 31.8 dB、裁片翻转反了 37.1 dB，都过不了门。

### 7.11 验收片《晨渡》：A 路线模版的双实现（M3 T6）

`films/chendu/` 从 A 路线模版建，改成两边都能跑：`world.js` 包成 `makeWorld(rt)`（THREE、卡通材质、表面层、底板工具、几何桥、读贴图由运行时注入），A 路线页面用 `rt-page.js`，离屏用 `offscreen.mjs` 里的那份；片子本身（事件、字体核对、镜头、片名显示层、TEXTS）在 `story.js`，两边共用；手写的着色（皴与层理、松的干枝色、日轮、日晕罩色、水面）各给一份 TSL 版，算法与常数逐式照搬。改结构这一步 A 路线侧九张关键帧（0…191，含切点两侧）与模版原样出的**逐字节相同**。离屏侧在 Node 里垫了一个只会建画布的 `document`（Skia），片名题字、`engine/paint/canvas.js` 的画笔原样可用。

**逐帧对拍**（`node films/chendu/tools/compare.mjs`：参考侧打开作品真正的页面 `index.html?msaa=0`、无损截图，含浏览器合成的显示层；离屏 msaa 0；960×540，九帧 0、40、71、72、90、96、120、150、191）：PSNR 44.8–54.5 dB，差 5 级以上的像素 0.10–0.86%；只有第 90 帧过 M1 的门（0.1%）。残差逐类看过，都不是算法差异：
- 片名、副标题的字形边缘（Skia 与 Chrome 的字形光栅化，7.8）：片名在画面时占大差像素的六成，带字的三帧 PSNR 约 45 dB、不画字约 50–54 dB；
- 画布路径的抗锯齿：程序化远山的剪影边、左下芦苇；
- 缩小显示的画布贴图走 mip 链，两个后端各自生成 mip：S2 近雾的细丝缕在第 534 行附近成一条亮线；
- 几何边缘的光栅化：S1 地平线（水面远边）那一行。

整片的对拍因此不拿 M1 的门判通过：工具照 M1 报告、退出码 4，上面四类写在这里；离屏成片能不能交付，看它过不过出片链的机器 QA 门与用户的三道闸。

**对拍查出的两个真问题**（都已修）：
- 卡通材质的 uniform 冻在第一帧（7.9 的坑）：先渲第 96 帧再渲第 120 帧，第 120 帧的皴线与层理就不对。
- **片名的高低随机器的系统字体变——A 路线模版本身的问题**：`title.js` 逐字画进画布时用 `textBaseline = 'middle'`；作品的字体子集不含空格，Chrome 算 `middle` 用「能覆盖空格的主字体」，落到后备的 sans-serif 上，所以片名的竖直位置取决于这台机器的 sans-serif 度量（本机比按片名字体自己的度量高 9 px@540）。Skia 按片名字体算，两边因此差了 9 px。《晨渡》的 `title.js` 改成 alphabetic 基线 + 按字形自己的墨迹外框居中，两边一致（单独画片名逐像素同外框），代价是《晨渡》页面上的片名比模版原样低几像素（有意改动）。**路线模版没改**（受金标准基线保护，改像素要走 POLICY 审批）。

### 7.12 快速复查

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
