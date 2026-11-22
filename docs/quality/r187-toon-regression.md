# r187 卡通着色回归：对 r170 金标准

本页由 `node engine/shade/r187-toon-regression.mjs --write` 生成，数据在同名的 `.json` 里；不要手改，重跑即可。

结论：**过门**。`engine/shade`（patch.js / toon.js / surface.js）在 three r187 下实渲的画面，逐项对 r170 金标准 PSNR ≥ 45 dB 且差 > 1 级的像素 ≤ 0.1%（12 / 12 项过门，其中 12 项逐字节相同）；负对照 4 / 4 组跌破 35 dB；逐特性消融 16 / 16 组被门拦住；拼图布局核对 8 / 8 条对上；r170 对冻结的金标准（基线 `b5f463e`）没变；两版页面控制台告警 0 条。

- 实际运行平台：darwin-arm64，Node v24.13.1，无头 Chrome 153.0.8010.12，ANGLE 后端 metal
- WebGL 渲染器：ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)
- 这份读数只代表上面这台机器；别的显卡或软件渲染要在那台机器上重跑

## 怎么比的

两张互相独立的测试页，各自的 import map 把 `three` 指到 r170（`three`）或 r187（`three-webgpu` 别名包），渲同一套确定性标定场景（`engine/shade/r187-toon-regression.scene.mjs`），渲染器设置与 `createFilm` 相同（sRGB 输出、不做色调映射、不开抗锯齿、软阴影）。整帧 640 × 480，分成 2 × 2 个 320 × 240 子区；彩色只比 RGB，法线 / ID 通道（旧的 uToonPass = 1：视空间法线 + 物体 / 实例 ID）同样的 2 × 2 布局、比 RGBA。PSNR 按区域内全部像素（含背景）合并计算；只看 PSNR 时，占画面很小的特性整项坏掉也过得去，所以过门还要求差 > 1 级的像素不超过 0.1%。

| 子区 | 覆盖的特性 |
|---|---|
| `bands-rim-fill-sky` | 三档分档、羽化、明暗交界线噪声 edgeNoise、双色亮芯撕边边缘光（rimCore / rimBreak）、两档下方补光、天空冷光 |
| `shadow-deform` | 平行光量化投影、顶点形变钩子 vertexBegin、makeDepthMaterial 阴影对齐 |
| `surface-layers` | patchLayer（color / tint 两种锈斑）、paintLayer、muralLayer 三种表面风化层；没有灯时的主光方向 uKeyDirW |
| `instanced-tints` | InstancedMesh 每个实例独立的三档色调、实例化投影 |

## r187 对 r170

| 项 | 内容 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 |
|---|---|---|---|---|---|
| `frame` | 彩色整帧（2 × 2 子区） | 逐字节相同 | 0 | 0.000% | 0.000% |
| `bands-rim-fill-sky` | 彩色子区 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `shadow-deform` | 彩色子区 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `surface-layers` | 彩色子区 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `instanced-tints` | 彩色子区 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `id-frame` | 法线 + 物体 / 实例 ID 通道整帧（uToonPass = 1，RGBA 四通道） | 逐字节相同 | 0 | 0.000% | 0.000% |
| `id:bands-rim-fill-sky` | 法线 / ID 通道子区 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `id:shadow-deform` | 法线 / ID 通道子区 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `id:surface-layers` | 法线 / ID 通道子区 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `id:instanced-tints` | 法线 / ID 通道子区 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `same-color` | 变体路径正对照：不改参数，只渲彩色的一个子区 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `same-id` | 变体路径正对照：不改参数，只渲法线 / ID 通道的一个子区 | 逐字节相同 | 0 | 0.000% | 0.000% |

## 拼图布局核对（各版自己比自己）

上表两边用的是同一套拼图画法，画错了位置会一起错。这里每个场景再单独渲一张 320 × 240 的法线 / ID 参照（自己的渲染目标，不设子区视口），拼图里对应的子区对它要过门且最大差不超过 1 级（SwiftShader 上逐字节相同；macOS Metal 上实例化那个子区实测有 2 个字节差 1 级，在法线的 z 分量上），并且通道里要有这个场景全部的物体 / 实例 ID。彩色拼图直接画在画布上，没有单独的参照；彩色子区画错了位置时，下一节按子区冻结的缩略图会变。

| 项 | 内容 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 | 预期的 ID | 没找到的 ID |
|---|---|---|---|---|---|---|---|
| `r170:bands-rim-fill-sky` | 拼图里的法线 / ID 子区对单独渲的参照 | 逐字节相同 | 0 | 0.000% | 0.000% | 2 个 | 无 |
| `r170:shadow-deform` | 拼图里的法线 / ID 子区对单独渲的参照 | 逐字节相同 | 0 | 0.000% | 0.000% | 4 个 | 无 |
| `r170:surface-layers` | 拼图里的法线 / ID 子区对单独渲的参照 | 逐字节相同 | 0 | 0.000% | 0.000% | 1 个 | 无 |
| `r170:instanced-tints` | 拼图里的法线 / ID 子区对单独渲的参照 | 98.99 dB | 1 | 0.000% | 0.000% | 13 个 | 无 |
| `r187:bands-rim-fill-sky` | 拼图里的法线 / ID 子区对单独渲的参照 | 逐字节相同 | 0 | 0.000% | 0.000% | 2 个 | 无 |
| `r187:shadow-deform` | 拼图里的法线 / ID 子区对单独渲的参照 | 逐字节相同 | 0 | 0.000% | 0.000% | 4 个 | 无 |
| `r187:surface-layers` | 拼图里的法线 / ID 子区对单独渲的参照 | 逐字节相同 | 0 | 0.000% | 0.000% | 1 个 | 无 |
| `r187:instanced-tints` | 拼图里的法线 / ID 子区对单独渲的参照 | 98.99 dB | 1 | 0.000% | 0.000% | 13 个 | 无 |

## r170 对冻结的金标准

上面两节的 r170 与 r187 跑的是同一份 `engine/shade`，两版一起改坏时互比照样全等。所以 r170 这边另外对一份冻结的金标准（`engine/shade/r187-toon-regression.golden.json`，基线 `b5f463e`，缩略图冻结于 swiftshader：ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)），它不随待测代码重生：

- 着色器摘要：4 族材质 × 4 组参数，各取卡通 / 阴影深度材质在 r170 下 `onBeforeCompile` 之后的顶点与片元源码（共 64 段）与 uniform 初值的 SHA-256，逐字节比。没有变化。
- 缩略图：r170 彩色帧每个子区的 16 × 12 块均值（每块 20 × 20 像素），块均值差最大不超过 12 级、平均不超过 0.15 级。容差是给不同显卡 / 软件渲染在投影与物体边缘上的出入留的（macOS Metal 对 SwiftShader 实测最大 6 级、平均不到 0.08 级）；分档阈值整体挪 0.08 时最大 8 到 48 级、平均 0.26 到 1.5 级。

| 子区 | 最大块均值差 | 平均块均值差 | 判定 |
|---|---|---|---|
| `bands-rim-fill-sky` | 2 级 | 0.077 级 | 没变 |
| `shadow-deform` | 6 级 | 0.06 级 | 没变 |
| `surface-layers` | 1 级 | 0.07 级 | 没变 |
| `instanced-tints` | 1 级 | 0.053 级 | 没变 |

有意改画面时才重冻（`--freeze <基线提交>`），先按 `docs/style-baselines/POLICY.md` 审批；不是有意改的，这里变红就是回退。

## 负对照（在 r187 上故意改坏，再对 r170 金标准）

每一条只在它所属的子区里算，必须 < 35 dB 才算被拦住。

| 项 | 改了什么 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 |
|---|---|---|---|---|---|
| `neg-step1` | 分档阈值 step1 整体 +0.12 | 30.65 dB | 78 | 10.708% | 9.290% |
| `neg-shadow-quant` | 投影量化窗口放开到 0..1（等于不量化） | 32.59 dB | 77 | 4.543% | 3.557% |
| `neg-rim-off` | 关掉背光侧与受光侧边缘光 | 22.79 dB | 235 | 3.452% | 3.372% |
| `neg-depth-deform-off` | 摘掉带顶点形变的阴影深度材质（投影不跟形体弯） | 24.6 dB | 135 | 1.919% | 1.882% |

## 逐特性消融（在 r187 上只关掉一项特性，再对 r170 金标准）

每一条只在它所属的子区里算（法线 / ID 通道的两条比那个通道），必须过不了门：说明这项特性确实在标定画面里，坏了门看得见。

| 项 | 关掉了什么 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 |
|---|---|---|---|---|---|
| `abl-band3` | 第三档并进第二档（三档变两档） | 35.43 dB | 64 | 6.520% | 5.195% |
| `abl-feather` | 绳结的羽化 0.14 / 0.1 收成硬边 | 44.65 dB | 38 | 4.859% | 2.475% |
| `abl-edge-noise` | 关掉明暗交界线噪声 edgeNoise | 38.69 dB | 146 | 3.399% | 2.210% |
| `abl-rim-core-back` | 关掉背光侧边缘光亮芯（绳结的 rimColor2） | 39.93 dB | 100 | 1.008% | 0.953% |
| `abl-rim-core-lit` | 关掉受光侧边缘光亮芯（球的 rimLitColor2） | 37.26 dB | 65 | 1.608% | 1.533% |
| `abl-rim-break` | 关掉边缘光撕边 rimBreak | 33.65 dB | 148 | 2.270% | 1.723% |
| `abl-fill` | 关掉下方补光 | 23.35 dB | 189 | 14.129% | 13.634% |
| `abl-sky` | 关掉天空冷光 | 31.64 dB | 69 | 6.121% | 5.396% |
| `abl-patch` | 关掉 patchLayer 的锈斑 / 藻斑 / 斑点 / 斑驳 | 26.53 dB | 130 | 12.570% | 11.724% |
| `abl-paint-stroke` | 关掉 paintLayer 的干笔笔触 | 40.9 dB | 48 | 1.798% | 1.470% |
| `abl-paint-grain` | 关掉 paintLayer 的颜料颗粒 | 48.46 dB | 26 | 2.936% | 1.184% |
| `abl-mural` | 关掉 muralLayer 的风化 | 31.76 dB | 97 | 6.245% | 5.961% |
| `abl-key-dir` | 没有灯时的主光方向 uKeyDirW 换一个方向 | 30.7 dB | 80 | 8.672% | 8.352% |
| `abl-inst-tint` | 实例的两档阴影色调抹平成同一档 | 41.71 dB | 46 | 3.116% | 2.744% |
| `abl-id-outline-w` | 法线 / ID 通道：芦苇的描边权重 outlineW 1 → 0.5 | 30.08 dB | 64 | 6.311% | 6.311% |
| `abl-id-instance` | 法线 / ID 通道：关掉实例 ID（整批实例同一个 ID） | 23.98 dB | 148 | 18.173% | 16.317% |

## 两版之间的差异与处理

- 投影采样核（唯一会改变画面的差异）：r187 删掉了 PCFSoftShadowMap，PCFShadowMap 改成深度纹理 + 硬件比较采样（sampler2DShadow）+ 按屏幕像素旋转的 5 点 Vogel 圆盘，投影边缘带屏幕空间抖动。`quantizeShadow` 在 r187 下把这段换回 r170 PCFSoftShadowMap 的确定性 3 × 3 双线性核（取样点落在纹素中心，硬件比较在那里等于单个纹素的 step）。不换核时过不了门：开发时临时关掉换核、在 macOS Metal 上量过一次，投影所在的两个子区只有 36 到 39 dB（一次性实验的读数，本执行器不复现它；要复现就把 `quantizeShadow` 里换核那一支临时关掉再跑）。
- 软阴影类型：r187 下把 `renderer.shadowMap.type` 设成 PCFSoftShadowMap 会被 three 退回 PCFShadowMap 并告警；标定场景在 r187 下直接设 PCFShadowMap，两版都没有告警。`engine/stage/film.js` 的 `createFilm` 默认值仍写死 PCFSoftShadowMap（不在本次改动范围），整条出片链切到 r187 时要跟着改成 PCFShadowMap。
- 版本告警：`engine/shade` 以前只认 r170，在 r187 下每次加载都告警；现在 r170 / r187 都不告警，别的版本照旧告警（对拍时另开一页把 r187 的版本号改成 999 实测，告警在）；着色器锚点缺失时两版都直接抛错。
- 不影响卡通着色的差异：meshtoon 片元去掉了 `#include <packing>`（卡通栈不用其中的函数）；`lights_fragment_begin` / `lights_fragment_end` 多了 SunLight、光照探针网格、Lambert / Phong 的 IBL，MeshToonMaterial 都不走（卡通合成只取第一盏平行光的方向与投影，颜色全按参数给定，没有光照衰减参与）；`color_fragment` 把顶点色与带 alpha 的顶点色合成一支，实例色结果相同；`common` 把 `inverseTransformDirection` 改名并留了同义宏；深度材质多了反向深度分支，默认不开。
- 阴影深度：r170 把深度打包进 RGBA8 颜色纹理，r187 直接用深度纹理；带顶点形变的 `makeDepthMaterial` 两版都照常生效（r187 只用它的顶点形变，片元输出不再被读）。
- 没有覆盖的：r170 的 PCFShadowMap（17 点核）在 r187 下没有等价物，r187 的 PCF 一律按上面的软阴影核出；VSMShadowMap、点光源与聚光灯投影、translucent / noId 材质、three 自带的非卡通材质不在这套对拍里；paintLayer 的海绵点 rustDapple 与 muralLayer 的细碎点 dotAmt 在标定机位下被按屏幕频率淡出，画面里没有，这两个子项没有比到。
