# r187 卡通着色回归：对 r170 金标准

本页由 `node engine/shade/r187-toon-regression.mjs --write` 生成，数据在同名的 `.json` 里；不要手改，重跑即可。

结论：**过门**。`engine/shade`（patch.js / toon.js / surface.js）在 three r187 下实渲的画面，逐项对 r170 金标准 PSNR ≥ 45 dB；负对照全部跌破 35 dB；两版页面控制台告警 0 条。

- 实际运行平台：darwin-arm64，Node v24.13.1，无头 Chrome 153.0.8010.12，ANGLE 后端 metal
- WebGL 渲染器：ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)
- 这份读数只代表上面这台机器；别的显卡或软件渲染要在那台机器上重跑

## 怎么比的

两张互相独立的测试页，各自的 import map 把 `three` 指到 r170（`three`）或 r187（`three-webgpu` 别名包），渲同一套确定性标定场景（`engine/shade/r187-toon-regression.scene.mjs`），渲染器设置与 `createFilm` 相同（sRGB 输出、不做色调映射、不开抗锯齿、软阴影）。整帧 640 × 480，分成 2 × 2 个 320 × 240 子区；彩色只比 RGB，法线 / ID 通道比 RGBA。PSNR 按区域内全部像素（含背景）合并计算。

| 子区 | 覆盖的特性 |
|---|---|
| `bands-rim-fill-sky` | 三档分档、羽化、明暗交界线噪声 edgeNoise、双色亮芯撕边边缘光（rimCore / rimBreak）、两档下方补光、天空冷光 |
| `shadow-deform` | 平行光量化投影、顶点形变钩子 vertexBegin、makeDepthMaterial 阴影对齐 |
| `surface-layers` | patchLayer（color / tint 两种锈斑）、paintLayer、muralLayer 三种表面风化层；没有灯时的主光方向 uKeyDirW |
| `instanced-tints` | InstancedMesh 每个实例独立的三档色调、实例化投影 |
| `id-pass` | 旧的 uToonPass = 1 通道：视空间法线 + 物体 / 实例 ID |

## r187 对 r170

| 项 | 内容 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 |
|---|---|---|---|---|---|
| `frame` | 彩色整帧（2 × 2 子区） | 逐字节相同 | 0 | 0.000% | 0.000% |
| `bands-rim-fill-sky` | 彩色子区 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `shadow-deform` | 彩色子区 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `surface-layers` | 彩色子区 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `instanced-tints` | 彩色子区 | 逐字节相同 | 0 | 0.000% | 0.000% |
| `id-pass` | 法线 + 物体 / 实例 ID 通道整帧（uToonPass = 1，RGBA 四通道） | 逐字节相同 | 0 | 0.000% | 0.000% |

## 负对照（在 r187 上故意改坏，再对 r170 金标准）

每一条只在它所属的子区里算，必须 < 35 dB 才算被拦住。

| 项 | 改了什么 | PSNR | 最大单通道差 | 差 > 1 级的像素 | 差 > 5 级的像素 |
|---|---|---|---|---|---|
| `neg-step1` | 分档阈值 step1 整体 +0.12 | 31.47 dB | 78 | 11.287% | 9.449% |
| `neg-shadow-quant` | 投影量化窗口放开到 0..1（等于不量化） | 32.6 dB | 77 | 4.543% | 3.557% |
| `neg-rim-off` | 关掉背光侧与受光侧边缘光 | 22.47 dB | 235 | 3.624% | 3.518% |
| `neg-depth-deform-off` | 摘掉带顶点形变的阴影深度材质（投影不跟形体弯） | 24.6 dB | 135 | 1.919% | 1.881% |

## 两版之间的差异与处理

- 投影采样核（唯一会改变画面的差异）：r187 删掉了 PCFSoftShadowMap，PCFShadowMap 改成深度纹理 + 硬件比较采样（sampler2DShadow）+ 按屏幕像素旋转的 5 点 Vogel 圆盘，投影边缘带屏幕空间抖动。`quantizeShadow` 在 r187 下把这段换回 r170 PCFSoftShadowMap 的确定性 3 × 3 双线性核（取样点落在纹素中心，硬件比较在那里等于单个纹素的 step）。不换核时同一套场景实测：整帧 40.47 dB、`shadow-deform` 36.16 dB、`instanced-tints` 39.31 dB，过不了门（macOS Metal）。
- 软阴影类型：r187 下把 `renderer.shadowMap.type` 设成 PCFSoftShadowMap 会被 three 退回 PCFShadowMap 并告警；标定场景在 r187 下直接设 PCFShadowMap，两版都没有告警。`engine/stage/film.js` 的 `createFilm` 默认值仍写死 PCFSoftShadowMap（不在本次改动范围），整条出片链切到 r187 时要跟着改成 PCFShadowMap。
- 版本告警：`engine/shade` 以前只认 r170，在 r187 下每次加载都告警；现在 r170 / r187 都不告警，别的版本照旧告警（对拍时另开一页把 r187 的版本号改成 999 实测，告警在）；着色器锚点缺失时两版都直接抛错。
- 不影响卡通着色的差异：meshtoon 片元去掉了 `#include <packing>`（卡通栈不用其中的函数）；`lights_fragment_begin` / `lights_fragment_end` 多了 SunLight、光照探针网格、Lambert / Phong 的 IBL，MeshToonMaterial 都不走（卡通合成只取第一盏平行光的方向与投影，颜色全按参数给定，没有光照衰减参与）；`color_fragment` 把顶点色与带 alpha 的顶点色合成一支，实例色结果相同；`common` 把 `inverseTransformDirection` 改名并留了同义宏；深度材质多了反向深度分支，默认不开。
- 阴影深度：r170 把深度打包进 RGBA8 颜色纹理，r187 直接用深度纹理；带顶点形变的 `makeDepthMaterial` 两版都照常生效（r187 只用它的顶点形变，片元输出不再被读）。标定场景里两版投影逐字节相同。
- 没有覆盖的：r170 的 PCFShadowMap（17 点核）在 r187 下没有等价物，r187 的 PCF 一律按上面的软阴影核出；VSMShadowMap、点光源与聚光灯投影、three 自带的非卡通材质不在这套对拍里。
