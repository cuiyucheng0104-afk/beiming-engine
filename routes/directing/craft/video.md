# 代码渲染视频工程

> 范围：把"代码画出的每一帧"可靠地变成可交付的视频文件。主体是 **A 北冥风格路线 · WebGL 三渲二**（`engine/render`、`build.sh`、`audio/`）；**B 北冥原生路线 · BNE** 只覆盖包装、封装与交付检查（`examples/raea/tools/`）；**C 北冥代码动画风格 · 86 式** 不是第三套渲染后端（`docs/TRACKS.md:43`），本章只把它的历史出片链路和快照里可借鉴的工程实现当参照。
> 解决什么：确定性、分辨率无关、色彩管线、编码封装、声音响度、质量门、性能与故障。页面内的色彩空间以 [threejs.md §2](threejs.md) 为准，动画时钟以 [animation.md](animation.md) 为准，底板的纹素密度以 [two-five-d.md §2.2](two-five-d.md) 为准。
> 怎么用：先读 §0 一页结论；出片按 §9 的顺序；质检命令在 §6；排查用 §8。
> 标注与术语统一见 [README](README.md)：【仓库实证】（含·复算／·渲染／·实测／·文档／·代码）、【通用工艺】、【推断】、【未实现】（正文里不加括号的"未实现"同义）。`$甲`、`$乙`、`<研究工作区>` 三个路径缩写的展开见本章「出处与许可」与 README。基线 `origin/main 3b97946`，只读检出。
> 基线：本章所有实跑都在 **macOS / Apple M5 Pro / Chrome Headless Shell 153.0.8010.12（ANGLE Metal）/ FFmpeg 8.0.1 / Node 24.13.1** 上完成，**没有重跑 Windows 或 RTX 5090**；5090 的数字一律引用仓库文档。实跑期间本机同时跑着别的渲染任务（负载均值 9–37），所以计时只表示量级，不是基准。实跑产物与日志在 `<研究工作区>/video-run/`（见附录 A）。

---

## 0. 一页结论

1. **确定性在同机同后端上成立。**【仓库实证】同一帧在"同页乱序重渲 / 新浏览器乱序加重复 / 顺序推进后再渲"三种情形下，8 个关键帧的无损 PNG 哈希全部相同；同参数整片渲两次，MP4 的 sha256 完全相同。改 worker 数会改变码流（不改变源帧）。
2. **交付文件的色彩标记不是文档建议的那一套。**【仓库实证】母带与网页版都是"全范围 + BT.601 矩阵 + 原色/传递未标"（VUI：`video_full_range_flag=1`、`matrix_coefficients=5`、`colour_primaries=2`、`transfer_characteristics=2`）。仓库的验收手册建议的是 BT.709 有限范围（`docs/routes/validation-and-rtx.md:33`）。忽略标记的播放链会把画面 PSNR 从 38.2 dB 拉到 26.8 dB。
3. **最大的一代画质损失在截图格式。**【仓库实证】逐帧 JPEG q95（4:2:0）对无损帧只有 37.7–40.4 dB；母带累计三代有损（JPEG → crf 14 → crf 19），网页版四代。无损截图可以做到每帧约 80 ms（JPEG 约 45 ms），像素与普通 PNG 完全一致。
4. **成片响度是 −14.9 LUFS，不是 −14。**【仓库实证】混音本身已经是 −14.1 LUFS / −1.7 dBTP；封装时 loudnorm 第一遍对这条 10 秒声轨测成 −13.18 LUFS（文件末尾测量偏差），线性第二遍于是把整片多压了约 0.9 dB。
5. **网页版 H.264 Level 5.0、没有固定关键帧间隔。**【仓库实证】`slow` 预设 5 个参考帧 × 1040 高触发 Level 5.0；GOP 只靠场景切点。
6. **质量门大多只"打印"不"判定"。** 帧数/尺寸只打印（`build.sh:44`），响度只打印（`engine/render/mux.sh:27`）；黑场、静帧、色彩标签、最终响度阈值、文字可读性都 【未实现】 自动检查。颗粒逐帧变化会让 `freezedetect` 对卡帧失明（已实测），需要"缩小 + 模糊"的代理再检。
7. **失败清理不完整。**【仓库实证】探测页失败、缺 ffmpeg 时输出目录留下 `.segs-*`；渲染中途收到 SIGTERM，node 与 ffmpeg 挂住不退出；软件渲染只告警、照常出片；没有重试、没有输出锁。
8. **优先做的三件事**：① 无损取帧 + 编码时一次性 RGB→BT.709 有限范围并写全四个色彩标签；② 一个交付质检脚本（帧数/时间戳/尺寸/标签/黑场/代理静帧/切点/ebur128/哈希）；③ 渲染器的信号处理与失败清理（C 路线快照里有现成的 MIT 实现可参照，移植须保留署名）。

---

## 1. 三条路线的出片链路

### 1.1 A 北冥风格路线 · WebGL 三渲二

```text
src/main.js（镜头表、后期配方、显示层）
 └─ engine/stage/film.js  run()：设 window.DUR / render(t) / TEXTS，预热后置 window.READY
     └─ engine/render/page.mjs  本地静态服务 + 无头 Chrome（ANGLE）+ 等 READY + 报 GPU 字符串
         ├─ still.mjs  单帧 → JPEG q92（样张、联系表）
         └─ video.mjs  切 N 段，每段一个浏览器 → JPEG q95 → ffmpeg(mjpeg→libx264 crf14) → concat -c copy
audio/mix.py（48 kHz，−14 LUFS，真峰值 −1.7）→ out/mix.wav → audio/check.py（自检）
engine/render/mux.sh  两遍 loudnorm(linear) + libx264 crf19 slow + AAC 256k + faststart → 母带
build.sh 第 5 步      两遍 9 Mbps → 网页版 → tools/make_html.py → 单文件 HTML
```

证据：`build.sh:19-44`、`engine/render/page.mjs:3-8`、`engine/render/video.mjs:3-4,31-32,50`、`engine/render/mux.sh:2-4,21-24`、`audio/build.sh:9-17`。

### 1.2 B 北冥原生路线 · BNE

`npm run raea:prepare`（`examples/raea/tools/prepare.mjs`：复制底板、导出模型、生成声音并两遍线性 loudnorm 成 `media/mix.wav`，`prepare.mjs:34-42`）→ `npm run raea:render`（`examples/raea/tools/render.mjs`：查 ComfyUI 队列与 `nvidia-smi` 占用 → 原生运行时 `render film.tsx --quality master` → `-c:v copy` + AAC 320k + `-t 10` 封装 → ffprobe 合约断言 → `delivery/technical.json`，`render.mjs:45-70`）。画面像素路径在原生运行时内部：GPU 合成后转 NV12/P010、CPU 读回再编码，不经过逐帧图片（`docs/raea/architecture.md:18-19,91`）。本次 **未实跑** B 路线渲染（本机未配置运行时可执行文件路径）。

### 1.3 C 北冥代码动画风格 · 86 式

C 是"方法与案例资料层"，新片的执行落回 A 或 B（`docs/TRACKS.md:43`）。历史成片各自带 `build.sh`，调用快照里风格库甲的渲染核心：先 `core/render/video.mjs` 逐帧，再 `mix.py`，再 `core/render/mux.sh`，最后跑提示音核对（例：`cases/source/style-01-crayon-book/build.sh:8-16`）。`cases/catalog.json` 的 `requirements` 字段显示 66 个案例依赖那套固定提交的运行时。两点纪律：`status=historical-render` 只代表出过片，**它们用过的编码参数不等于被认可的交付规格**；`rejected` 的案例不能拿来当参数范例。

快照里的渲染核心比 A 路线现用版本多了不少工程防护（输出锁、残留段清理、SIGTERM、静音与损坏音频处理、BT.709 开关、文字可读时长检查），本章第 7、8 节会逐条对照。

---

## 2. 确定性

### 2.1 契约

页面只要满足四条就能被渲染：`window.DUR`、确定性的 `window.render(t)`、资源就绪后才置的 `window.READY`、可选的 `window.TEXTS(t)`（`engine/render/page.mjs:3-8`）。`engine/stage/film.js:35-53` 是 A 路线的标准实现。【仓库实证】

### 2.2 时间只来自整数帧号

- 渲染器按整数帧调用：`window.render(f / FPS)`（`engine/render/video.mjs:35`）。页面先夹住 t，再用 `frameOf(t, fps) = round(t·fps)` 还原帧号（`engine/stage/film.js:39-41`、`engine/core/clock.js:11`）。一拍二、一拍三从帧号量化，不从 `t*8` 之类的浮点乘法取（`engine/core/clock.js:3,12-13`）。
- 颗粒种子取 `floor(t·fps + 1e-6)`（`engine/look/index.js:137`），墨线沸腾取 `floor(t·boilFps)`（`engine/look/index.js:4`、`src/look.js:27`）。
- 风险一：**渲染帧率与场景帧率不一致时没有任何报错。**【推断】`film.run` 的 fps 默认 24（`engine/stage/film.js:35`），后期颗粒的 fps 也默认 24（`engine/look/index.js:17,65`），而 `video.mjs --fps` 可以随便填（`video.mjs:14`），页面又不导出自己的帧率。用 30 fps 渲时，`round(t·24)` 会出现不规则的重复帧号，一拍二节奏和颗粒都会成对重复。手册已要求两者一致（`docs/routes/validation-and-rtx.md:30`），但代码没有断言。 动画节奏上的后果见 [animation.md §2.7](animation.md)。
- 风险二：`still.mjs --range` 把时间格式化成两位小数（`engine/render/still.mjs:14`），t 不等于 f/24；做逐帧比对时直接给 `f/24`（手册同样提醒，`docs/routes/validation-and-rtx.md:183,220`）。

### 2.3 随机必须带种子

- 引擎提供整数哈希 `hashi` 与 Mulberry32 `mulberry`（`engine/core/math.js:19-31`），着色器里用 PCG 整数哈希（`engine/look/glsl.js:9-17`），颗粒和纸纹都只吃整数种子（`engine/look/compose.js:43-44`、`engine/look/paper.js:25-29`）。【仓库实证】
- 隐患：单纯形噪声工厂的默认随机源是 `Math.random`（`engine/core/noise.js:28,50`）。本次逐个检查调用点，`src/` 里全部传了 `mulberry(固定种子)`（例 `src/girl.js:82-85`、`src/kun.js:149-150`），所以现片不受影响；但新镜头漏传种子时不会报错，每个 worker 会得到不同的噪声场，分段处会跳。源码对照里也点过这一条（`docs/raea/architecture.md:32`）。【仓库实证】修法：把种子改成必填参数。【推断】
- 声音同样确定：`engine/audio/dsp.py:2`、`audio/mix.py:11`。本次把混音跑了两遍，`out/mix.wav` 的 sha256 都是 `aebcb955…`。【仓库实证】

### 2.4 墙钟不进画面

全仓 `engine/ src/ lab/` 检索：`Date.now` 只出现在渲染工具的日志计时里（`video.mjs:25,38,52`、`still.mjs:21,25`）；`performance.now` 只出现在构建耗时统计（`src/kun_bronze.js:499`，写进 `debug.timings`）和 `lab/` 自测计时。README 的"没有 `Date.now`、没有无种子随机"（`README.md:140`）与代码一致。【仓库实证】

【通用工艺】把这条做成门禁：`rg -n "Date\.now|performance\.now|Math\.random\(\)|new THREE\.Clock|getDelta" src engine`，命中处逐个列进白名单（日志计时允许，画面路径不允许）。仓库目前 【未实现】 这道门禁。

### 2.5 资源就绪之后才置 READY

| 资源 | 现在怎么等 | 失败时会怎样 |
|---|---|---|
| 字体 | `FontFace(..., {display:'block'})` 逐个 `load()` 后再等 `document.fonts.ready`（`engine/overlay/text.js:20-26`），`src/main.js:27` 在建镜头前 await | 加载失败抛错 → 页面错误 → 渲染器退出（`page.mjs:74`）。但**子集里缺字会静默回退系统 sans-serif**（`engine/overlay/text.js:28`），跨机会不一致【推断】 |
| 底板贴图 | `TextureLoader.loadAsync` 全部完成（`engine/stage/plates.js:14-26`） | 缺图 → 页面错误 → 退出【推断】 |
| 外部纸纹 | 读不到就换程序化纸纹（`engine/look/paper.js:38-49`） | **静默降级**，画面变了也不报错【仓库实证·代码】 |
| 着色器、贴图上传、阴影贴图 | `warm` 时刻每个镜头先渲一帧，再回到 t=0 才置 READY（`engine/stage/film.js:50-53`，时刻表 `src/main.js:49`） | — |
| 总超时 | 等 READY 最多 180 秒（`page.mjs:83`） | 超时抛错退出 |

`page.mjs` 只对 `script`/`document` 的 4xx 立即退出（`page.mjs:76-80`），图片、字体、fetch 的 404 不在这条规则里。【仓库实证】

【通用工艺】READY 的前置清单：字体已加载且覆盖本片全部字形；所有贴图已解码并在预热帧里上传；每种材质变体都至少编译过一次；异步画布（`createImageBitmap` 等）已完成；最后在 t₀ 渲一帧。"可选资源"必须在代码里显式声明为可选，其余一律失败即停。

### 2.6 有状态模拟

单帧接口不等于可以随机访问。契约把镜头分成 `absolute | baked | sequential` 三类（`docs/routes/contracts.md:133`），手册给了顺序/单帧/乱序/分段四种对照（`docs/routes/validation-and-rtx.md:181-232`）。现片的抽测见下一节：顺序推进 60→84→150 与直接跳帧结果相同，说明被测帧按"绝对求值"行事——这只覆盖了抽测的帧，不是全片证明。【仓库实证】

### 2.7 怎样验证（本次实跑）

脚本 `<研究工作区>/video-run/tools/det.mjs` 直接调用检出目录的 `openFilm()`，用 `page.screenshot({type:'png'})` 取无损帧再算 sha256；整片用原版 `video.mjs`。

| 用例 | 做法 | 结果 |
|---|---|---|
| 同页乱序重渲 | 一个页面先升序渲 12/71/72/84/119/120/150/230，再倒序重渲 | 8/8 哈希相同 |
| 新浏览器乱序 + 重复 | 新页面按 150,12,230,84,84,72,120,71,119 渲 | 全部与上一行相同；84 两次相同 |
| 顺序推进 vs 跳帧 | 新页面从 60 顺序推到 84，再推到 150 | 84、150 与直接跳帧相同 |
| JPEG 截图是否稳定 | 同帧 JPEG q95 截两次 | 字节相同 |
| 整片可复现 | 同参数 `--workers 4` 渲两次 | MP4 sha256 都是 `c2111204…` |
| worker 数的影响 | `--workers 1` 对 `--workers 4` | 码流不同；解码帧只有 21/240 逐像素相同，PSNR 平均 44.2 dB，最差 42.0 dB（第 183 帧，紧跟 180 处的段界） |
| 跨后端（同一台机器） | `BEIMING_ANGLE=swiftshader` 对 Metal | PSNR 45.9–51.8 dB，SSIM 0.998；逐像素相同 60.3–60.4%，差超过 2 级的 0.11–0.72%；差值热图集中在藤壶/海葵的墨线边和显示层卡片描边（`det/diff_swiftshader_f150.png`） |
| 跨机器 | 仓库文档：Mac 对 RTX 工作站 | 无损截图逐像素相同 58–76%、差超过 2 级 0.5–3.6%、PSNR 43–51 dB；视频 SSIM 0.9715（逐帧最低 0.9635）；差异在显示层文字边缘和零星墨线（`docs/渲染与4K.md:46-56`） |

结论与做法：

- **同机同后端**：比较无损帧哈希（PNG 或 `ffmpeg -f framemd5 -pix_fmt rgb24`），必须完全相同。不要拿 JPEG 或 H.264 的文件哈希证明像素一致（`docs/routes/validation-and-rtx.md:220`）。
- **成片哈希依赖 worker 数**：要复现成片字节，渲染记录里必须写 worker 数；要证明"同一部片子"，以源帧哈希为准。
- **跨后端、跨机器**：比较无损帧的 SSIM/PSNR，再看差值热图的位置。墨线来自 ID 图的边缘判定，对浮点差敏感；显示层文字受系统光栅化影响（`page.mjs:51` 已关字体微调，但不能消除系统差异）。每次记录 Chrome 版本、`--use-angle`、`UNMASKED_RENDERER` 字符串、系统版本与字体文件哈希。
- **阈值**【通用工艺，待验证】：同设备同后端要求逐像素一致；手册提议的"同设备浮点差"暂定阈值是最大通道差 ≤2/255 且超过 1/255 的像素 ≤0.1%（`docs/routes/validation-and-rtx.md:220`）。本次跨后端实测已经超过这个阈值（0.11–0.72% 的像素差超过 2 级），所以跨后端要另设门槛，例如无损帧 SSIM ≥0.995、差超过 16 级的像素 ≤0.5%，且热图只落在线条和文字边缘。
- 颗粒是逐像素噪声，会把逐像素指标整体压低（`docs/渲染与4K.md:69`）；比较构图一致性时先模糊再比（见 3.4）。

---

## 3. 分辨率无关

### 3.1 设计高度与倍率 K

- 镜头按 1040 高的设计稿摆位；渲染器、后期、显示层用实际像素 W×H；`K = H / designHeight`，设计宽度 `DW = W / K`（`engine/stage/film.js:3-4,19-21`、`src/main.js:19-22`）。K=1 时与按实际像素摆完全一致。【仓库实证】
- 后期的像素量（线宽、抖动、笔触半径）按 **1080** 高标定，内部乘 `H/1080`（`engine/look/index.js:15,93`、`src/look.js:21`）；显示层按 **1040** 高缩放，`S = H/1040`（`engine/overlay/text.js:11`）。两个标定高度并存是有意的，风格手册写明了这一点，并且要求不要靠提高设备像素比来放大线宽（`docs/routes/beiming-style.md:128`）。渲染器固定 `deviceScaleFactor: 1`、`setPixelRatio(1)`（`page.mjs:73`、`film.js:24`）。
- Canvas 2D 的坑：`filter: blur()` 与 `shadowBlur` 不随 `setTransform` 缩放，必须手动乘倍率。人物层这样做了（`src/shotB.js:36,40`，注释写明"画布滤镜的长度不随变换缩放"），显示层的模糊与辉光乘了 `S`（`engine/overlay/text.js:47-48`）。新写的 2D 层要照此处理。【仓库实证】
- 宽高比变了，设计宽度也跟着变（`film.js:21`）。实测 1920×1040 与 1920×1080 的同一时刻，横向构图有轻微差别（`<研究工作区>/video-run/res/cmp_1040_vs_1080.jpg`）。换画幅要重看构图、字幕与安全区（`docs/routes/validation-and-rtx.md:31`）。【仓库实证】

### 3.2 超采样只作用于墨线

- `ss` 只放大 ID 图、边缘图和笔画图：它们在 `W·ss × H·ss` 上计算（`engine/look/index.js:11,78-84`）；正片用 `ss: 2`、主场景 `msaa: 4`（`src/main.js:24`）。合成时对 2 倍笔画图做一次双线性取样，恰好等于 2×2 盒滤波，线条自带抗锯齿（`engine/look/compose.js:7,28`）。主场景只有 MSAA 4，**不是整帧超采样**。【仓库实证】
- 【推断】`ss` 改成 3 或 4 时，单次双线性取样只平均到中间的 2×2 个纹素，不再是盒滤波，细线会闪烁或断开；要改 `ss` 就得加一道显式下采样（或者给笔画图生成 mipmap）。
- 【通用工艺】需要整帧超采样时，在页面内按 2 倍尺寸渲染再用一道下采样 pass 输出（像素成本 4 倍），不要通过 `deviceScaleFactor` 放大。

### 3.3 哪些东西不会随分辨率变清楚

- **位图底板**：本片 11 张底板宽 3072–4344 像素（本次用 Pillow 读尺寸）。在 3840×2080 下推镜时，底板被放大，4K 不会多出细节。【推断】
- **颗粒**：每个输出像素一个噪声值（`engine/look/compose.js:42-47`），4K 的颗粒更细，而且是另一组随机实现。
- **纸纹**：程序化纸纹按 `max(.5, H/1080)` 缩放（`engine/look/paper.js:13,59`），但外部纸纹图是按**输出像素**平铺的（`compose.js:34` 用 `gl_FragCoord / uPaperSize`，`paper.js:68-72` 的平铺尺寸 = 图片像素 × scale），正片的 `scale` 是 1（`src/look.js:45`，各镜头只改 strength，例 `src/shotA.js:151`）。【推断】所以 4K 下纸纹相对画幅细了一半——文档说"原生 4K 纸纹细腻"（`docs/渲染与4K.md:9`），这既是观感上的优点，也意味着纸纹随分辨率变了。想要各分辨率一致，就把 `paper.scale` 设成 `H/1080`。
- **字体与小字**：会按 `S` 放大，矢量字形本身随分辨率变清楚。
- **材质内画线**：线宽按 `fwidth` 恒定在 1–3 个输出像素，Kuwahara 半径却按高度放大，原生 4K 下镜头 C 的鲲腹褶沟线几乎被抹掉，而屏幕墨线正常（【仓库实证·实测】，复现命令与原因见 [toon.md §5.3 与失败模式 F16](toon.md)）。`docs/渲染与4K.md:62-66` 的 4K 对比没有覆盖这类线。

### 3.4 实测：4K 与 1040 的构图一致性

同一时刻分别渲 3840×2080 和 1920×1040，把 4K 缩回 1040 再比：不模糊时 SSIM 0.73–0.79（被颗粒主导，与 `docs/渲染与4K.md:75` 的 0.767 一致）；两边都做 σ=2.5 的高斯模糊后，SSIM 是 0.960（3.5 秒）、0.960（6.0 秒）、0.942（9.6 秒，片名笔刷字）。构图一致，差异在颗粒、纸纹和片名笔触。【仓库实证】

### 3.5 尺寸约束与 4K 策略

- `--size` 必须是偶数且不小于 16（`page.mjs:55-63`），这是 4:2:0 的要求。1040 = 65×16，2080 = 130×16，正好对齐宏块。【推断】
- 出片用原生 4K，不用 RTX 视频超分：超分会在平涂区长出"蚯蚓纹"，端到端也更慢（`docs/渲染与4K.md:5-11,58-66`、`docs/RTX工作站.md:56-66`）。【仓库实证·文档】

---

## 4. 色彩管线

### 4.1 页面里：线性工作空间到 sRGB

页面内的色彩空间流转——线性 HDR 主场景 → 雾、bloom、调色（线性）→ OutputPass（本片不做色调映射，只做 sRGB 编码）→ Kuwahara、叠墨线、纸纹、暗角、颗粒在 sRGB 值上算 → 显示层 2D 画布叠在最上层、不经后期 → 浏览器强制 sRGB 输出配置——以 [threejs.md §2.2](threejs.md) 为准（【仓库实证】`engine/look/index.js:3-6`、`engine/stage/film.js:2,25,30-33`、`engine/render/page.mjs:51`）。本章只讲帧离开浏览器之后。

笔触与墨线放在显示空间里算，是一种画法上的取舍（像在纸上调色），不是错误；这意味着改 OutputPass 的设置会连带改变笔触观感。【推断】

### 4.2 帧离开浏览器：JPEG 是 BT.601 全范围 4:2:0

`video.mjs` 每帧 `page.screenshot({type:'jpeg', quality:95})`（`video.mjs:36`），`still.mjs` 用 q92（`still.mjs:24`）。本次 ffprobe 截图：`mjpeg, yuvj420p, color_range=pc, color_space=bt470bg`——也就是 4:2:0 色度抽样、全范围、BT.601 矩阵。与同帧无损 PNG 比：第 84 帧 PSNR 40.4 dB / SSIM 0.958，第 150 帧 37.7 dB / 0.955，蓝通道最差（35.8 dB）。【仓库实证】

### 4.3 编码器实际写了什么

| 文件 | pix_fmt | 范围 | 矩阵 | 原色 / 传递 | Level | 证据 |
|---|---|---|---|---|---|---|
| 中间件（`video.mjs` 产出） | yuvj420p | pc（全） | bt470bg | 未标 | 4.0 | `video.mjs:31-32` |
| 母带（`mux.sh` 产出） | yuvj420p | pc（全） | bt470bg | 未标 | 5.0 | `mux.sh:21-24` |
| 网页版（`build.sh` 第 5 步） | yuvj420p | pc（全） | bt470bg | 未标 | 5.0 | `build.sh:37-39` |

母带的 H.264 VUI 逐字段读出来是：`video_full_range_flag=1`、`colour_primaries=2`（未指定）、`transfer_characteristics=2`（未指定）、`matrix_coefficients=5`（BT.470BG，即 BT.601）、`max_num_ref_frames=5`、`level_idc=50`。原因：mjpeg 解码出的全范围帧直接进了 x264，`-pix_fmt yuv420p` 和 `format=yuv420p` 都不做范围转换，整条链路没有任何 `-color_*` 参数。【仓库实证】

这与文档里的"完整色彩范围"一致（`docs/渲染与4K.md:17`），但与验收手册建议的交付规格（H.264、8-bit yuv420p、BT.709 原色/传递/矩阵、有限范围 `tv`）不一致（`docs/routes/validation-and-rtx.md:33-34,294`）。

### 4.4 风险有多大（实测）

把母带的 VUI 改写成"有限范围 + BT.709"（像素不变，只改标签），模拟一条不认全范围标记的播放链，再与无损帧比：

| 解读方式 | 第 84 帧对无损 PNG 的 PSNR | 平均亮度 YAVG |
|---|---|---|
| 无损 PNG（基准） | — | 134.9 |
| 按标记正确解码 | 38.2 dB | 135.2 |
| 当成有限范围 BT.709 | **26.8 dB** | **140.4** |

误读会抬高对比、改变色相。【仓库实证】【通用工艺】浏览器大多认这些标记；部分硬件解码器、电视、剪辑软件和转码平台会忽略全范围标记或默认按 BT.709 解释，必须在目标平台上用灰阶卡实看。

### 4.5 转换写法要先验证（FFmpeg 8.0.1 实测）

用已知 RGB 色块（含 16/128/235 中性灰、本片墨色 #2A2D52、雾紫 #9C8FD8、显示层白 #EAF6FF）模拟"Chrome JPEG → BT.709 有限范围"，无损编码后读出原始 YUV，按精确公式解回 RGB：

| 写法 | 4:4:4 | 4:2:0 中性灰 128 的码值 | 4:2:0 最大误差 |
|---|---|---|---|
| 单步 `scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709` | 准确（≤2.4） | Y=125（应为 126）、Cr=127（应为 128） | 3.7 级；灰 128 解回 R 偏 −2.9 |
| `colorspace=space=bt709:ispace=bt470bg:range=tv:irange=pc:primaries=bt709:iprimaries=bt709:trc=bt709:itrc=bt709` | 准确 | Y=126、Cb=Cr=128 | 2.3 级 |
| 先 `format=gbrp` 回到 RGB，再 `scale=out_range=tv:out_color_matrix=bt709` | 准确 | Y=126、Cb=Cr=128 | 2.4 级 |

所以在 4:2:0 上，单步写法会让中性灰偏暗 1 级、偏青 1 级。【仓库实证】C 路线快照的 BT.709 开关用的正是单步写法（`$甲/core/render/mux.sh:80-82`），它的注释说新旧画面"最多差 ±3"（同文件第 15 行），与本次测得的偏差量级吻合。【推断】注意：本次也看到 ffmpeg 自己抽帧解码会掩盖或放大这类误差，判断转换对错要读原始 YUV，或者显式指定解码矩阵。

### 4.6 推荐管线

【通用工艺】为主，括号里是本次已验证的部分：

1. **无损取帧**：用 CDP `Page.captureScreenshot({format:'png', optimizeForSpeed:true})`。实测 1080 下每帧约 80 ms，同一轮里 Playwright 普通 PNG 要 308 ms，两者解码像素完全相同（framemd5 一致）；另一轮里 JPEG q95 约 45 ms。【仓库实证】截图必须包含显示层画布：显示层是 WebGL 之上的独立 2D 画布（`film.js:30-33`），只对 WebGL 做 `readPixels` 会漏掉字幕和界面。
2. **只做一次色彩转换**：PNG 经管道送 ffmpeg（`-f image2pipe -c:v png -i -`），编码时 `-vf "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"`，并写全 `-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv`。RGB→YUV 这一步本次实测中性色准确。这样也省掉了 4:2:0 → 4:4:4 → 4:2:0 的二次色度重采样。
3. **传递函数标签**：页面内容是按 sRGB 显示设计的。交付惯例写 BT.709；macOS 的 QuickTime 系播放器对 BT.709 传递按另一条显示伽马解释（常说的 QuickTime gamma shift），暗部会略亮、略灰。两种标签方案：传递标 `bt709`，或标 `iec61966-2-1`（即 sRGB）；在 Safari／QuickTime、Chrome、VLC 和目标平台上各看一次灰阶卡后再定【通用工艺】。
4. **验证**：做一页已知色块的测试页 → 渲染 → 编码 → 读原始 YUV 按标签解回 → 每块误差 ≤2 级；同时断言 ffprobe 的四个色彩字段。
5. **不能马上改管线时**：现有像素就是 BT.601 全范围，范围与矩阵标签是对的；至少把原色、传递补成 bt709（像素本来就是 sRGB 原色），并在交付说明里写明"全范围"。【推断】只改标签不能修正像素，手册也强调了这一点（`docs/routes/validation-and-rtx.md:40`）。

---

## 5. 编码与封装

### 5.1 现有参数与实测

| 产物 | 位置 | 视频参数 | 实测码率 / 体积（10 秒） | Level / 参考帧 | 关键帧（帧号） |
|---|---|---|---|---|---|
| 中间件 | `video.mjs:31-32` | libx264 `medium` crf 14 | 89.0 Mbps / 111 MB | 4.0 / 4 | 0, 60, 120, 165, 180（段界 + 场景切） |
| 母带 | `mux.sh:21-24` | libx264 `slow` crf 19，`-r 24`，AAC 256k，faststart | 44.0 Mbps / 55.3 MB | 5.0 / 5 | 0, 72, 124, 165, 222 |
| 网页版 | `build.sh:37-39` | 两遍 9 Mbps，maxrate 14M，bufsize 18M，AAC 192k，faststart | 9.0 Mbps / 11.5 MB | 5.0 / 5 | 0, 72, 124, 165, 218 |
| 单文件 HTML | `tools/make_html.py:8,64` | 网页版 base64 内嵌 | 15.4 MB | — | — |

母带与网页版的 `moov` 都在 `mdat` 之前（faststart 生效）。【仓库实证】

### 5.2 代际损失

以 det 脚本的无损帧为基准，按标记正确解码后比较（PSNR dB / SSIM）：

| 帧 | 中间件（JPEG→crf14） | 母带（再 crf19） | 网页版（再 9 Mbps） |
|---|---|---|---|
| 12 | 37.31 / 0.942 | 36.31 / 0.923 | 34.26 / 0.866 |
| 71 | 36.81 / 0.934 | 34.75 / 0.884 | 33.33 / 0.843 |
| 72 | 40.11 / 0.953 | 39.33 / 0.944 | 37.29 / 0.905 |
| 84 | 39.65 / 0.950 | 38.22 / 0.928 | 35.20 / 0.840 |
| 119 | 39.39 / 0.945 | 36.90 / 0.898 | 35.27 / 0.848 |
| 120 | 39.73 / 0.950 | 37.51 / 0.914 | 35.40 / 0.853 |
| 150 | 36.85 / 0.942 | 34.89 / 0.903 | 32.82 / 0.842 |
| 230 | 37.73 / 0.944 | 36.24 / 0.919 | 33.64 / 0.846 |

单看 JPEG 一步：第 84 帧 40.4 dB、第 150 帧 37.7 dB——中间件的损失主要来自截图格式。网页版的 SSIM 掉到 0.84–0.87，主要是逐像素颗粒被抹平。【仓库实证】

【通用工艺】每一代有损都会叠加。母带和网页版都应当从同一份无损源（或无损/高码率的中间格式）各自编码一次；网页版现在是从母带转码，音频也是 AAC→AAC（`build.sh:38`）。

### 5.3 crf、预设与颗粒

【通用工艺】带逐像素颗粒的画面是编码器最难处理的内容。可选做法：交付母带用 crf 14–16、`slow` 或更慢的预设；颗粒重的片子加 `-tune grain`，网页版给更高码率，或者为分发版单独降低页面内颗粒强度。C 路线快照的工艺说明给出过同样的建议（`$甲/TECHNIQUE.md:117`，§6）。天空大面积渐变如果出现色带，可以考虑 10-bit，但网页兼容性会下降。这些在 A 路线都 【未实现】，需要在目标设备上看片后再定。

### 5.4 关键帧间隔与网页播放

三处编码都没有设 `-g`（`video.mjs:31-32`、`mux.sh:23`、`build.sh:37-38`），所以用的是 x264 默认最大间隔 250 帧（24 fps 下约 10.4 秒），另外在场景切处自动插关键帧。10 秒样片只在切点有关键帧；长片里一个长镜头内的拖动定位可能要等上 10 秒的解码。【推断】【通用工艺】网页版加 `-g 48 -keyint_min 24`（约 2 秒）。

### 5.5 Level 与参考帧

【仓库实证】母带与网页版是 Level 5.0、5 个参考帧。【推断】算术：1920×1040 是 120×65 = 7800 个宏块，5 个参考帧要 39000，超过 Level 4.x 的解码缓冲上限 32768，所以 x264 标成 5.0；参考帧降到 4 个是 31200，能落在 4.1。【通用工艺】网页版加 `-profile:v high -level 4.1`（x264 会自动限制参考帧数），或者 `-x264-params ref=4`；部分老硬件只解到 4.1/4.2。

### 5.6 并行分段与无损拼接

- 做法：总帧数按 worker 数切段，每段一个浏览器和一个 ffmpeg，最后 `concat -c copy`，再把临时目录里的合成文件改名为输出——没有半截文件（`video.mjs:25-29,30-33,48-51`）。【仓库实证】
- 实测：240 帧；时间戳从 0 到 9.958333 均匀递增，相邻差都是 1/24；段首（0/60/120/180）都是 IDR 帧。同参数两次的 sha256 相同；worker 数不同时码流不同（见 2.7）。【仓库实证】
- 【通用工艺】`concat` 要求各段编码参数、时间基一致，且是闭合 GOP；同一条命令产出的段满足这些条件。手册另外要求混拼前核对色彩与音轨参数，A、B 两条路线的 H.264 不能因为都是 H.264 就直接拼（`docs/routes/validation-and-rtx.md:38`）。
- 声音不分段，全片一次混完（`docs/routes/validation-and-rtx.md:232`）。
- 段级重试、断点续跑：【未实现】（手册把它们列为"不能说已经上线"，`docs/routes/validation-and-rtx.md:18`）。

### 5.7 母带与网页版两档

- 现有：`out/beiming{,_4k}.mp4`（仓库称"母带"，实际是高码率的 H.264 分发件）、`out/beiming_web.mp4`（网页版，4K 时也缩到 1920 宽）、`out/beiming.html`（单文件，`build.sh:32-42`）。单文件 HTML 的体积约是视频的 4/3，播放前要在内存里解码 base64（`tools/make_html.py:41-43`），只适合短片。【推断】
- 【通用工艺】建议的两档：

| 档位 | 视频 | 色彩 | 音频 | 用途 |
|---|---|---|---|---|
| 高码率分发版（仓库现称母带） | H.264 High，crf 14–16，`slow` | BT.709 有限范围，四个标签写全 | AAC-LC 48 kHz 256–320 kbps；给剪辑的版本另存 PCM | 平台上传 |
| 网页 | H.264 High@4.1，crf 18–20 + maxrate/bufsize（或两遍），`-g 48`，faststart | 同上 | AAC-LC 48 kHz 192 kbps，从 PCM 母带直接编码 | 网页内嵌、预览 |

行业意义上的母带——最高质量的交付与归档件：无损序列（PNG、FFV1）或 ProRes 4444／422 HQ，配 24-bit WAV；需要反复剪辑时也用它：【未实现】。

### 5.8 声音：48 kHz、两遍线性 loudnorm、真峰值

**混音**【仓库实证】：采样率 48000（`engine/audio/dsp.py:21`），内部 float64，输出 24-bit PCM（`audio/mix.py:263`）。先按 BS.1770 积分响度把总增益调到 −14 LUFS，再用 4 倍过采样检测的前视限制器把真峰值压到 −1.7 dBTP，按"限制后实测"迭代修正（`audio/mix.py:255`、`audio/cues.json:6-9`、`engine/audio/mixing.py:64-72`、`engine/audio/dsp.py:371-385`）。本次实跑：内部测量 −14.05 LUFS / −1.70 dBTP；ffmpeg ebur128 复测 −14.1 LUFS、LRA 8.2、真峰值 −1.7 dBFS。

**自检**【仓库实证】：`audio/check.py` 检查格式（48 kHz、双声道、**480000 个采样**——即 10 秒写死在第 33 行，换片长必须改）、ebur128、模拟 `mux.sh` 的两遍 loudnorm 并确认第二遍走的是线性（39-42 行）、频段能量、首尾与切点跳变、单声道兼容、提示音带内信噪比和音高（需要 librosa）。

**封装**【仓库实证】：`mux.sh` 第一遍测量、第二遍以 `linear=true` 归一到 I=−14、TP=−1.2、LRA=11，`aresample=48000`，音频短于画面时补静音，AAC 256k，最后打印 ebur128 摘要（`mux.sh:9-15,21-24,27`）。没有阈值判定。

**实测结果**【仓库实证】：母带 −14.9 LUFS，真峰值 −2.4 dBFS；网页版（AAC→AAC 192k）−15.0 LUFS。文档里的"约 −14.9 LUFS"（`docs/渲染与4K.md:17`）就是这个现象。

**原因定位**（本次测试）：

| 输入 | ebur128 积分响度 | loudnorm 第一遍 `input_i` |
|---|---|---|
| 原 10 秒混音 | −14.1 | **−13.18** |
| 前面补 20 秒静音 | −14.1 | −13.28 |
| 后面补 20 秒静音 | −14.1 | **−14.11** |
| 原混音循环 3 遍（30 秒） | −14.1 | −13.78 |

只有在**末尾**补静音时 loudnorm 才测对，所以偏差来自 loudnorm 第一遍对文件结尾的处理。本片最响的时刻在片尾（`audio/mix.py:41` 的注释），于是被测"偏响"约 0.9 LU，线性第二遍按 −14 −(−13.18) = −0.82 dB 给整片减了增益。【仓库实证·实测】偏差的具体机制（结尾一段被重复计入）是【推断】。`audio/check.py` 的报告里其实已经记着第二遍输出 −14.87 LUFS（`report.json` 的 `mux_loudnorm.output_i`），但 `audio/build.sh:16` 只打印归一化类型，没有打印这个数。

**修法**【通用工艺】：

1. 混音已经按 `premaster`（−14 LUFS、−1.7 dBTP）出好并通过 `check.py` 时，封装就不要再做 loudnorm，直接 `-c:a aac -b:a 256k`，然后对最终 AAC 文件用 ebur128 复测，按交付门槛判定。交付门槛只在 ProjectSpec 的 `audio` 一处定义：积分响度 −14±1 LU、真峰值不高于 −1.2 dBTP（`docs/routes/templates/project-beiming.json:12`；`docs/routes/validation-and-rtx.md:37`；PRODUCTION-SPEC §5），本章不另写数字。
2. 确实要在封装时归一，就用 BS.1770 测量（ebur128 或 `engine/audio/meter.integrated`）算出增益，用 `volume=…dB` 施加，再复测。
3. AAC 编码会抬高样本间峰值，混音阶段（`premaster`）的真峰值留在 −1.5 到 −2 dBTP 之间比较稳（A 样片取 −1.7）。这是混音建议，不是交付门槛。
4. 网页版音频从 PCM 混音直接编码，不要 AAC 转 AAC。
5. 10 秒左右的短片，除积分响度和真峰值外，另报最大短期响度（3 s）和最大瞬时响度（400 ms）：积分响度受门限和片尾测量影响大（上表 0.9 LU 的偏差就是例子），LRA 对 10 秒片段的参考价值也有限。`ebur128` 的逐行输出里有 M（瞬时）、S（短期）两列，取最大值即可【通用工艺】。

**B 路线**：`prepare.mjs:34-42` 同样两遍线性 loudnorm，但没有检查第二遍是否真的走了线性；`render.mjs:64` 封装 AAC 320k 并用 `-t 10` 截断。入库后的复核记录是 −14.02 LUFS / −3.06 dBTP（`docs/raea/publication-validation.json`）。

---

## 6. 质量门

| 检查 | A 现状 | B 现状 | C 快照 | 本次在 A 成片上实跑 | 缺口 |
|---|---|---|---|---|---|
| 帧数 / 时长 / 尺寸 / 帧率 | `build.sh:44` 完整解码计数，**只打印** | `render.mjs:68` 断言 1920×1040、24/1、240 帧、AAC、时长误差 ≤0.05 秒 | — | 240 帧，24/1，时间戳均匀 | A 需要断言 |
| 完整解码 | 同上 | 同上 | — | 计数即完整解码 | 手册模板有 `-xerror` 解码（`validation-and-rtx.md:263-283`），【未实现】脚本 |
| 色彩标签 | 无 | 无 | 有 BT.709 开关（`$甲/core/render/mux.sh:23,80-85`） | pc / bt470bg / 未标 | 【未实现】 |
| 黑场 | 无 | 记录里写明需另行检查（`render.mjs:70`） | 工艺说明建议做（`$甲/TECHNIQUE.md:128`，§8） | 手册参数 `d=0.08:pix_th=0.02` 未检出 | 【未实现】 |
| 静帧 | 无 | 同上 | — | `n=-50dB:d=0.75` 未检出；放宽到 `-40dB:0.25` 也未检出 | **颗粒让检测失明**，见下 |
| 切点核对 | 无 | — | — | `scene>0.25` 检出 3.0 秒、5.0 秒两处（分数 0.456），与镜头表一致（`src/main.js:40`） | 【未实现】 |
| 响度 | 混音 WAV 有完整自检（`audio/check.py`）；最终文件只打印（`mux.sh:27`） | 准备阶段归一；记录 −14.02 | 封装后偏离 ±1 LU 或峰值高于 −1 dB 时告警（`$甲/core/render/mux.sh:95-98`） | −14.9 LUFS / −2.4 dBTP | A 缺最终文件阈值 |
| 联系表 | `build.sh:20-21` + `tools/contact_sheet.py` | 历史记录里人工看过 4 fps 联系表 | `core/render/sheet.py` | 21 张样张拼图正常（`<研究工作区>/video-run/contact_sheet.jpg`） | — |
| 文字可读时长 / 安全区 | 页面提供 `window.TEXTS`（`film.js:49`、`src/hud.js:362`），**没有任何检查器读取** | 原生运行时自带检查（`docs/raea/experiment-qa.json` 的 `raea_check`） | 有可读时长检查（`$甲/core/render/readcheck.mjs:1-9`） | 直接拿快照的检查器跑 A 成片：服务根不同，`/node_modules/three` 返回 404，不能直接用 | 【未实现】 |
| 软件渲染 | 只告警（`page.mjs:89`） | 渲染前 `nvidia-smi` 占用 >10% 拒跑（`render.mjs:52-53`），这是占用检查，不是软件渲染检查 | 同样只告警；注释写明新版无头浏览器在 macOS 上 `gl` 会回退软件渲染（`$甲/core/render/browser.mjs:3,9-19`） | 见 7.2 | 契约规定任务要求 5090 时软件回退不能算完成（`docs/routes/contracts.md:151`）；自动判失败 【未实现】 |
| 渲染记录 | 模板 `docs/routes/templates/render-result.json`、校验函数 `engine/production/project.js:371` | `delivery/technical.json` 写 sha256 与 probe | — | — | 渲染器不消费契约（`project.js:10-11`），【未实现】自动填写 |
| 人工审片 | 必须看整片（`AGENTS.md:38`）；已输出、技术通过、人工认可是三件事（`docs/TRACKS.md:57`） | 同左 | 交付前清单（`$甲/DIRECTOR.md:113-119`，§11） | 本次只看了联系表，**没有替代整片审看** | — |

**颗粒与静帧检测**【仓库实证】：用第 84 帧做一段 1.5 秒的"画面卡住、颗粒照常逐帧变化"的样例，`freezedetect=n=-50dB:d=0.75` 检测不出来；先 `scale=240:-2,gblur=sigma=2` 再检测就能抓到。同样的预处理放在真成片上不会误报（本片镜头一直在动，一拍二、一拍三的角色也不会让整帧静止）。手册已提醒不要为了一拍三放宽阈值（`docs/routes/validation-and-rtx.md:285`）。

**建议的交付质检命令**（macOS/Linux，【通用工艺】组合；每一条的同等命令都在本次成片上跑过）：

```sh
F=out/beiming.mp4
ffprobe -v error -count_frames -show_entries stream=codec_name,profile,level,pix_fmt,color_range,color_space,color_transfer,color_primaries,width,height,sample_aspect_ratio,r_frame_rate,avg_frame_rate,nb_read_frames,sample_rate,channels:format=duration,size -of json "$F" > probe.json
ffprobe -v error -select_streams v:0 -show_entries frame=best_effort_timestamp_time -of csv=p=0 "$F" > pts.txt    # 相邻差应全为 1/24
ffmpeg -hide_banner -nostats -i "$F" -an -vf blackdetect=d=0.08:pix_th=0.02 -f null - 2> black.log
ffmpeg -hide_banner -nostats -i "$F" -an -vf "scale=240:-2,gblur=sigma=2,freezedetect=n=-50dB:d=0.75" -f null - 2> freeze.log
ffmpeg -hide_banner -nostats -i "$F" -an -vf "select='gt(scene,0.25)',metadata=print:key=lavfi.scene_score" -f null - 2> scene.log   # 对照镜头表
ffmpeg -hide_banner -nostats -i "$F" -vn -af ebur128=peak=true -f null - 2> loud.log
shasum -a 256 "$F"
```

判定条件写进脚本：帧数 = round(DUR×fps)、尺寸与帧率符合项目记录、四个色彩字段符合目标、时间戳等间隔、无未豁免的黑场/静帧、切点与镜头表相差不超过 1 帧、I 与真峰值在门槛内。阈值和豁免按分镜逐条写，不要为了过检放宽。

---

## 7. 性能与故障

### 7.1 吞吐与 worker

- 默认值：`video.mjs` 4 个 worker（`video.mjs:14`）；`build.sh` 1080 用 4 个、4K 用 `WORKERS_4K`（默认 8）（`build.sh:10,13`）。文档实测：1080 时 Mac 10.9 秒（4 个）、RTX 工作站 13.1 秒（6 个）；4K 时 Mac 50.8 秒、RTX 31.4 秒（10 个）；6 个加到 10 个只快约 2 秒（`docs/渲染与4K.md:32-44`、`docs/RTX工作站.md:52`）。【仓库实证·文档】
- 本次（共享负载下）：4 个 worker 两次分别 10.6 秒、12.6 秒；1 个 worker 14.4 秒。【仓库实证】
- 单帧拆账（1080 / 4K）【仓库实证】：`render(t)` 的 JS 调用约 2 ms 就返回——GPU 的活在截图时才真正完成；JPEG 截图 45 / 239 ms；Playwright PNG 229 / 921 ms；CDP 快速 PNG（1080）80 ms。瓶颈在浏览器里的回读与图片编码，所以加 worker 有用，直到 CPU 或 GPU 饱和。
- 每个 worker 的显存【推断】：4K 下每个 worker 约 2 GB（底板纹理约 0.35–0.37 GB，后期渲染目标约 1.6 GB，按 `engine/look/index.js:78-87` 的格式与 `ss=2` 估算），6 个 worker 加上浏览器开销，与文档记录的显存峰值 18.8 GB 量级一致（`docs/渲染与4K.md:42`）。逐项估算表和降显存的顺序见 [threejs.md §7.4](threejs.md)。
- 探测页开销：`video.mjs` 为了读 `DUR` 先完整打开一次页面（`video.mjs:21-24`），Metal 下等 READY 约 1.5 秒。【仓库实证】

### 7.2 GPU 后端与软件渲染

- `BEIMING_ANGLE` 选 ANGLE 后端：macOS 默认 `metal`，其他平台不传参数（`page.mjs:9-10,47-53`）；`BEIMING_CHROME` 指定浏览器可执行文件（`page.mjs:72`）。Windows 双显卡机器上默认 D3D11 会选中核显、WebGL 建不起来，要用 `vulkan`（`docs/RTX工作站.md:7-15,72`）。`tools/rtx/gpucheck.mjs` 依次试 default/d3d11/vulkan/gl，打印实际 GPU 名称和一个重着色器的帧时间（`gpucheck.mjs:5-31`），在 Windows 上默认用系统 Chrome（第 4 行）。【仓库实证】
- 本次在 macOS 实测【仓库实证】：

| `BEIMING_ANGLE` | 实际渲染器 | 等 READY | 单帧（渲染 + PNG 截图） |
|---|---|---|---|
| metal | ANGLE Metal，Apple M5 Pro | 1.5 秒 | 0.26–0.28 秒 |
| gl | **静默回退 SwiftShader** | 27.6 秒 | 1.5–3.8 秒 |
| swiftshader | SwiftShader | 33.1 秒 | 2.8–4.0 秒 |

后两行 `page.mjs` 都打印了"正在用软件渲染"的提示，但照常往下跑。也就是说，环境变量写错一个值，就会慢约 5–15 倍地出片，像素还不同（见 2.7）。C 路线快照的注释记录过同一现象（新版无头浏览器在 macOS 上 `gl` 回退软件渲染，约慢 6 倍，`$甲/core/render/browser.mjs:3`）。【通用工艺】默认把 SwiftShader / llvmpipe / Microsoft Basic Render 当作失败，只有显式允许时才继续；在渲染记录里写入 UA、`--use-angle` 和 `UNMASKED_RENDERER`。
- 记录实际 GPU、图形后端和编码器；Vulkan 不等于 NVENC，原生路线默认的 OpenH264 也不能写成 NVENC（`AGENTS.md:41`、`ROUTES.md:95`）。

### 7.3 失败、重试与残留（本次复现）

| 场景 | 实测现象 | 代码原因 |
|---|---|---|
| 探测页脚本 404（`--query test=__nope__`） | 退出码 1；输出目录留下空的 `.segs-*` | 临时目录在探测前就建了（`video.mjs:17`）；`page.mjs:78` 直接 `process.exit(1)`，跳过了清理 |
| 渲染中收到 SIGTERM | 浏览器被关 → 打印"渲染失败"，临时目录被删；但 node 和两个 ffmpeg **一直挂着不退出**，ffmpeg 守着已删除的段目录和半截段文件等输入；结束 ffmpeg 后 node 仍不退出，最后只能 SIGKILL | 只处理了 SIGINT（`video.mjs:19`）；worker 抛错后没人关 ffmpeg 的 stdin；`Promise.all` 先失败返回 |
| PATH 里没有 ffmpeg | 抛出未捕获的 `spawn ffmpeg ENOENT`，进程崩溃（退出码 1），留下 `.segs-*` | `spawn` 没挂 `error` 监听（`video.mjs:31`） |
| 混音全静音 | `mux.sh` 退出码 222：`measured_I=-inf` 超出范围 | 没有处理测不出响度的情况（`mux.sh:10-12`） |
| 软件渲染 | 只告警，照常出片 | `page.mjs:89` |

另外从代码推出来的【推断】：某个 worker 出错时，`Promise.all` 立刻失败，其他 worker 仍会把各自的段渲完才结束，白白耗时；没有任何重试；没有输出锁，两个渲染写同一个 `--out` 会互相覆盖；`DUR` 不做合法性检查（`video.mjs:22-25`）；`mux.sh` 直接写目标文件，第二遍失败可能留下半截文件；`build.sh:36` 用 `mktemp -d` 建的两遍日志目录从不清理；READY 超时与探测页失败走同一条路径，也会留下 `.segs-*`。

C 路线快照里已有对应实现，可以作为补强 A 路线的参照（MIT，移植时保留派生说明与许可，`THIRD-PARTY.md:36`）：输出锁与过期接管、启动时清理残留段、失败时先杀编码器再删目录、处理 SIGINT/SIGTERM（`$甲/core/render/video.mjs:17-37`）；`DUR` 校验（第 42 行）；ffmpeg 缺失或提前退出的处理（第 51-54、63 行）；整机渲染并发名额（`core/render/slot.mjs:1-2`）；静音与损坏音频处理（`core/render/mux.sh:41-69`）；失败时删掉半截输出（第 90-91 行）。

### 7.4 共享机纪律

- 共享 GPU 先查队列和负载，不终止别人的任务（`AGENTS.md:41`）。B 路线的包装会查 ComfyUI 队列和 `nvidia-smi` 占用（`render.mjs:45-53`），但手册明确说这不是可靠的预约机制（`docs/routes/validation-and-rtx.md:16`）。A 路线的渲染器没有任何占用检查：【未实现】。
- 计时只能在空闲时测，并记录同时运行的任务（`docs/RTX工作站.md:76`）。本次计时有外部负载，所以只作量级参考。

---

## 8. 失败模式 → 修法

| # | 症状 | 根因 | 怎么确认 | 修法 | 状态 |
|---|---|---|---|---|---|
| 1 | 并行段的段首跳变，和顺序渲染对不上 | 镜头有累计状态，或者用了没播种的随机 | 无损帧哈希：顺序推进 / 跳帧 / 新页面 | 改成按帧号求值（absolute），或先烘焙（baked）；顺序型从片头回放再丢弃预热帧 | 契约有（`contracts.md:133`），工具 【未实现】 |
| 2 | 同一帧渲两次结果不同 | 墙钟、无种子随机、没等资源就绪 | 同页重渲比 PNG 哈希 | 去掉墙钟与无种子随机；READY 前预热 | 现片实测通过 |
| 3 | 一拍二节奏乱、颗粒成对重复 | `--fps` 与场景 fps 不一致 | 对照页面 fps 与命令行参数 | 页面导出 `window.FPS`，渲染器断言一致 | 【推断】，【未实现】 |
| 4 | 跨机器差异集中在文字边 | 系统字形光栅化不同 | 差值热图 | 记录并接受；关键字形可预渲染成贴图 | 文档已记录 |
| 5 | 某台机器上字体变了 | 子集缺字，回退到系统 sans-serif | 用 `TEXTS` 的文本对照字体子集 | 构建时校验子集覆盖全部字形 | 【推断】，【未实现】 |
| 6 | 纸纹悄悄变成程序化纸纹 | 外部纸纹加载失败被吞掉（`paper.js:48`） | 看网络 404 与纸纹均值 | 必需资源失败即报错 | 【未实现】 |
| 7 | 4K 下纸纹比 1080 细 | 外部纸纹按输出像素平铺 | 4K 缩回 1040 后对比纸纹 | `paper.scale = H/1080` | 【推断】 |
| 8 | `ss` 改大后墨线闪烁或断线 | 单次双线性取样不再是盒滤波 | 放大看细线 | 加显式下采样 | 【推断】 |
| 9 | 在某些平台/电视上发灰或死黑 | 全范围 + BT.601 标记被忽略 | ffprobe 标签；改标签模拟 | 无损取帧 + 一次 RGB→BT.709 tv + 写全标签 | 实测风险 |
| 10 | 中性灰偏青、偏暗 1 级 | 4:2:0 上单步 `scale` 换矩阵 | 色块回读原始 YUV | 用 `colorspace` 滤镜，或先回 RGB | 实测 |
| 11 | 颗粒糊成块、网页版发软 | 逐像素颗粒难压；代际叠加 | 代际 PSNR/SSIM，放大看 | 从无损源各编一次；`-tune grain`；提高网页码率或分发版降颗粒 | 实测损失，修法属【通用工艺】 |
| 12 | 老设备播不了网页版 | Level 5.0（5 个参考帧 × 1040 高） | ffprobe `level` | `-level 4.1` 或 `ref=4` | 实测 |
| 13 | 网页里拖动定位慢 | 没设 GOP，默认最长 250 帧 | 列关键帧 | `-g 48` | 实测 |
| 14 | 成片 −14.9 LUFS，不是 −14 | loudnorm 第一遍末尾测量偏差 + 重复归一 | 比 ebur128 与 loudnorm `input_i` | 已母带化就不再 loudnorm；或按 BS.1770 算增益 | 实测 |
| 15 | 网页版响度再低 0.1 LU、音质二次损失 | AAC→AAC 转码 | ebur128 | 网页版音频从 PCM 母带编码 | 实测 |
| 16 | 静音或测不出响度时封装失败 | 测量值为 −inf | `mux.sh` 退出码 222 | 识别静音并跳过归一，给出告警 | 实测；C 快照已处理 |
| 17 | 卡帧了却检测不出 | 颗粒逐帧变化让 `freezedetect` 失明 | 合成卡帧样例 | 缩小 + 模糊代理再检测 | 实测 |
| 18 | 黑场、漏帧、重复帧没被发现 | 没有交付质检 | `blackdetect`、`-count_frames`、时间戳差 | 第 6 节的质检脚本 | 【未实现】（手册有模板） |
| 19 | 出片慢 5–15 倍、像素也不同 | ANGLE 后端不可用，回退 SwiftShader | 渲染器 GPU 字符串 | 默认判失败 | 实测 |
| 20 | Windows 上建不起 WebGL | ANGLE D3D11 选中核显 | `tools/rtx/gpucheck.mjs` | `BEIMING_ANGLE=vulkan` | 文档已记录 |
| 21 | 输出目录残留 `.segs-*` | 先建临时目录，失败时 `process.exit` 跳过清理 | `ls -a` 输出目录 | 统一在退出与信号时清理；启动时清残留 | 实测 |
| 22 | SIGTERM 后进程挂死 | 没处理 SIGTERM；ffmpeg stdin 没关 | `ps` | 处理 SIGTERM，失败时杀编码器 | 实测 |
| 23 | 缺 ffmpeg 直接崩溃 | `spawn` 没有错误监听 | 去掉 PATH 实验 | 启动前 `ffmpeg -version` 预检 | 实测 |
| 24 | 两个渲染写同一个输出 | 没有锁 | — | 输出锁（参照 C 快照） | 【推断】 |
| 25 | 4K 多 worker 显存不够或中途失败 | 每个 worker 约 2 GB | 监控显存与进程 | 降 worker；先查共享机占用 | 【推断】+ 文档 |
| 26 | 改了 worker 数，成片哈希变了 | 分段位置影响编码 | 比较解码帧 | 渲染记录写 worker 数；以源帧哈希为准 | 实测 |
| 27 | 单文件 HTML 太大、打开慢 | base64 内嵌 | 看体积 | 长片改成外链视频 | 【推断】 |

---

## 9. 给 agent 的出片顺序

1. **预检**：`ffmpeg -version`；查共享机负载；渲一张静帧，确认日志里的 GPU 字符串不是软件渲染。
2. **确定性冒烟**：同一帧在同页渲两次、在新页面渲一次，比较 PNG 哈希；含有有状态模拟的镜头，加做"顺序推进 vs 跳帧"。
3. **样张与联系表**：`still.mjs --range` 加 `tools/contact_sheet.py`，看构图和关键帧。
4. **声音**：在隔离副本里运行 `sh audio/build.sh`（把 `audio/` 与 `engine/audio/` 复制到别处再跑：它第 9 行调用的 `audio/mix.py` 会重写被跟踪的 `audio/CREDITS`，`audio/mix.py:277`；`npm run build` 也会经 `build.sh:25` 走到这一步），读 `audio/check/report.json`，同时看 `mux_loudnorm.output_i`。
5. **整片**：`video.mjs`；记录尺寸、fps、worker 数、GPU 字符串、ANGLE 后端、Chrome 版本。
6. **封装与两档交付**：`mux.sh`，再出网页版；注意第 4、5 节的已知问题。
7. **交付质检**：第 6 节的命令，按项目门槛判定。
8. **审片**：agent 做代理审片——联系表、关键动作帧条、切点前后逐帧、逐帧变化曲线（DIRECTING 步骤 10 的命令）；全速带声的完整观看由用户或指定审片人做，记下原话，agent 不代填。技术检查通过不能替代观看（`AGENTS.md:38`）。
9. **记录**：按 `docs/routes/templates/render-result.json` 填写；`technicalAcceptance` 与 `creativeAcceptance` 分开写。

不要在共享检出目录里跑 `audio/mix.py`、`sh audio/build.sh` 或 `npm run build`：它们都会重写被 git 跟踪的 `audio/CREDITS`（`audio/mix.py:277`）。需要隔离时，把 `audio/` 与 `engine/audio/` 复制到别处再跑（本次就是这样做的，重写出的 CREDITS 与原文件一致）。

---

## 10. 未实现清单

- 渲染器断言"页面 fps = 渲染 fps"；页面导出 `window.FPS`。
- 无损取帧（PNG / CDP 快速 PNG）与一次性 BT.709 有限范围转换、四个色彩标签。
- 交付质检脚本：帧数、时间戳、尺寸、色彩标签、黑场、代理静帧、切点对镜头表、最终文件响度阈值、sha256。
- 对最终 AAC 文件的响度判定；封装阶段跳过重复归一，或按 BS.1770 增益归一。
- 文字可读时长与安全区检查（数据源 `window.TEXTS` 已在页面里）。
- 软件渲染判失败；A 路线渲染前的共享机占用检查。
- SIGTERM 处理、失败时清理编码器与临时目录、输出锁、段级重试、断点续跑、检查点恢复。
- 渲染器自动填写 RenderResult（契约校验函数已有，但没被渲染器调用）。
- 网页版的 GOP、Level 设置；从无损源分别编码母带与网页版；无损或高码率中间格式。
- 跨机器、跨后端的自动对照工具（无损帧 SSIM + 差值热图）。
- 噪声工厂的种子改为必填；墙钟与无种子随机的检索门禁。
- 字体子集的字形覆盖校验；必需资源（含外部纸纹）加载失败即报错。

---

## 11. 出处与许可

- **路径缩写**：`$甲` = `cases/vendor/lemo-opuscar`（风格库甲，固定提交 `bebbbe1a`，MIT，LemoLab）；`$乙` = `cases/vendor/sy-style-100`（风格库乙，固定提交 `e41dee31`，MIT，肖雄 XIAOXIONG）；`<研究工作区>` = 研究期的临时目录，未入库（说明见 [README](README.md) §8）。快照只读，许可与署名不得删改（`AGENTS.md:51,56`；`THIRD-PARTY.md:32-38`）。

- **风格库甲** = `cases/vendor/lemo-opuscar`：MIT（LemoLab），固定提交 `bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00`（`THIRD-PARTY.md:10`）。本章引用了它的 `core/render/video.mjs`、`core/render/mux.sh`、`core/render/readcheck.mjs`、`core/render/slot.mjs`、`TECHNIQUE.md` §6/§8、`DIRECTOR.md` §11，均为转述，没有复制代码。快照不得就地修改（`AGENTS.md:56`）；移植时保留派生说明与许可（`THIRD-PARTY.md:36`）。
- **风格库乙** = `cases/vendor/sy-style-100`：许可见 `THIRD-PARTY.md:9` 与其目录内 LICENSE。本章没有引用它的代码。
- **原生运行时** = RAEA，FSL-1.1-ALv2（`THIRD-PARTY.md:11`），包装要求的固定版本是 `0.1.0-canary.2`（`examples/raea/tools/render.mjs:14`）。不在本仓库分发，单独取得；许可含 Competing Use 限制（不得用于与许可方竞争的用途），两年后转为 Apache-2.0；B 路线做商用交付前先核对条款。
- **本次实跑的工具链**：Chrome Headless Shell 153.0.8010.12（Playwright 1.63.0，浏览器修订号 1243），three 0.170.0，FFmpeg 8.0.1（Homebrew，libx264），Node 24.13.1，Python 3.12（numpy 2.5.3、scipy 1.18.1、soundfile 0.14.0、numba 0.67.0、Pillow 12.3.0；借用本机另一个项目的虚拟环境，只读使用）。

---

## 附录 A：实跑命令与产物

工作目录：只读检出根（下文简写 `$R`）；产物目录 `<研究工作区>/video-run/`（简写 `$V`）。所有输出都写在 `$V`，检出目录里被 git 跟踪的文件没有改动（实跑前后 `git status --short` 均为空）。

| # | 命令 | 结果 / 产物 |
|---|---|---|
| 1 | `node $V/tools/det.mjs` | 同帧哈希对照，`$V/det/det.json`、`$V/det/*.png`、`$V/logs/det.log` |
| 2 | `cd $R && node engine/render/video.mjs . --size 1920x1040 --fps 24 --workers 4 --out $V/v_w4_a.mp4`（再跑一次输出 `v_w4_b.mp4`，以及 `--workers 1` 输出 `v_w1.mp4`） | 10.6 / 12.6 / 14.4 秒；sha256 见 `$V/logs/evidence.txt`（重复的两个文件比对后已删除） |
| 3 | `ffprobe -count_frames …`、`ffmpeg -i … -c copy -bsf:v trace_headers -frames:v 1 -f null -` | 色彩字段、VUI、Level、关键帧、时间戳 |
| 4 | 复制 `audio/` 与 `engine/audio/` 到 `$V/audio-copy/` 后：`PYTHON=<venv python> sh audio/build.sh`；再跑一次 `audio/mix.py` | 混音与自检，两次 `mix.wav` 逐字节相同 |
| 5 | `cd $R && sh engine/render/mux.sh $V/v_w4_a.mp4 $V/audio-copy/out/mix.wav $V/final_a.mp4 24 0` | 母带，−14.9 LUFS / −2.4 dBTP |
| 6 | 按 `build.sh:37-39` 的两条命令出 `$V/web_a.mp4`；`python3 $R/tools/make_html.py $V/web_a.mp4 $V/film_single.html` | 网页版 9.0 Mbps，单文件 HTML 15.4 MB |
| 7 | 对 `mix.wav` 分别跑 `ebur128` 与 `loudnorm` 第一遍；前补 / 后补 20 秒静音、循环 3 遍再测 | loudnorm 末端偏差 |
| 8 | 色块测试：Pillow 生成色块 → 模拟 BT.601 全范围 → 三种转换写法 → 读原始 YUV 按精确公式解回（`$V/color/patch/`） | 4.5 节的表 |
| 9 | 改 VUI 模拟误读：`-bsf:v h264_metadata=video_full_range_flag=0:matrix_coefficients=1:colour_primaries=1:transfer_characteristics=1` | 4.4 节的表 |
| 10 | 代际损失：从中间件、母带、网页版按标记解出 8 帧，对无损 PNG 算 PSNR/SSIM | `$V/logs/generation_loss.txt`（三列依次是中间件 / 母带 / 网页版；JPEG 单步的数字来自第 1 条的 `J1_*.jpg`） |
| 11 | `node $V/tools/shotcost.mjs`；`W=3840 H=2080 N=12 node $V/tools/shotcost.mjs`；`node $V/tools/cdpshot.mjs` | 单帧拆账；快速 PNG 与普通 PNG 像素一致 |
| 12 | `BEIMING_ANGLE={metal,gl,swiftshader} node $V/tools/backend.mjs be_<名>` | 后端回退与跨后端差异，`$V/logs/backend.log`、`$V/det/diff_swiftshader_f150.png` |
| 13 | `cd $R && node engine/render/still.mjs . --range 0:9.5:0.5 9.95 --size 1920x1040 --out $V/stills --prefix s_`，再 `python tools/contact_sheet.py …` | `$V/contact_sheet.jpg` |
| 14 | `still.mjs . 3.5 6.0 9.6` 分别用 `--size 3840x2080`、`1920x1080`、`1920x1040` | 4K 构图 SSIM；画幅对比 `$V/res/cmp_1040_vs_1080.jpg` |
| 15 | `blackdetect`、`freezedetect`（原样与代理）、`select='gt(scene,0.25)'`、`signalstats` | 第 6 节结果；卡帧样例 `$V/qa/stuck_with_grain.mp4` |
| 16 | 故障复现：`video.mjs --query test=__nope__`；渲染中 `kill -TERM`；`PATH=/usr/bin:/bin` 去掉 ffmpeg；全静音 WAV 进 `mux.sh` | 7.3 节的表；挂住的测试进程是本次自己启动的，已结束 |
| 17 | 在快照目录里跑可读时长检查器：`node core/render/readcheck.mjs $R --size 1920x1040` | 服务根不同，`/node_modules/three` 404，不能直接使用 |
