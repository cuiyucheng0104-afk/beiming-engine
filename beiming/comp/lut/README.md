# AgX 查找表

场景参考镜头（`colorRef: scene`）的显示变换是 AgX、外观 Medium High Contrast、显示 sRGB，取 Blender 自带的色彩配置；代码在本目录。交付链现在的做法是对数整形加一张 65³ 表（`bake-agx.mjs` 的 `bakeAgxLut`，ffmpeg `lut3d` 四面体插值）。

**表不进仓库，sha256 进锁。** `deliver` 读 `view.lutPath`，算文件全部字节的 sha256，和锁文件 `lock.view[<style.view.scene>]` 比，不同就报错（`../deliver.mjs` 的查找表一段）。复现：在装着 Blender 的机器上调 `bakeAgxLut({ blenderBin, gridSize: 65, outPath })`，它起一个后台 Blender（`-b -noaudio --factory-startup`）跑 `bake_agx.py` 的 `bake`，用同一份 `config.ocio` 的 OCIO 处理器在整形后的网格上逐点直算，写成每个数 6 位小数的 `.cube`，返回 `sha256:…`；同一个 Blender 版本、同一个格数烘出的文件逐字节相同。苹果 M5 Pro 上的 Blender 5.2.0 LTS 烘出的是 `sha256:6b092a8464eff504ab34f5f869d199e29687add8054b44312f47720571e64d09`，锁里写这个值；换了 Blender 版本要重烘、重写锁。

**65³ 表达不到第 6 级的色彩门。** 对拍阶梯第 6 级（[`beiming/sources/core/chassis/level6.mjs`](../../sources/core/chassis/level6.mjs) 的 color）拿它对 Blender 直出比，门是浮点最大绝对差 1e-4、8 位最大级差 1（阈值文件 `beiming/verify/floor-gate.json` 的 `math.level6`）。苹果 M5 Pro、Blender 5.2.0 LTS 上的读数：

| 做法 | 灰阶 0 到 16（82 个） | 饱和色（51 个） | 黄色折点一带（34 个） | 判 |
|---|---|---|---|---|
| 65³ 表加对数整形 | 浮点 1.66e-3，8 位 1 级 | 浮点 2.90e-2，8 位 8 级 | 浮点 2.90e-2，8 位 8 级 | 不过 |
| Blender 自带的表加它的分配变换（算子链） | 浮点 1.74e-5，8 位 0 级 | 浮点 1.86e-5，8 位 0 级 | 浮点 1.74e-5，8 位 0 级 | 过 |

浮点的标准答案是同一份配置的 OCIO 处理器直算，它对 Blender 存的 16 位 PNG 最大差 3.0e-5（16 位一级是 1.5e-5）；8 位对 Blender 存的 8 位 PNG（关抖动）。65³ 表差得最多的是 (0.5, 0.5, 0) 的蓝分量（0.0936 对 0.0645）：整条链里有两张三维表、一次 log 式对比度和几次色域矩阵，65³ 的格子在饱和色上插不准。

算子链（`bake-agx.mjs` 的 `agxChain`、`applyAgxChain`）照 OCIO 默认优化之后的处理器逐个算子做：色域矩阵、log2 分配（−12.47393 到 12.5260688 档）、`luminance_compensation_bt2020.cube`（37³）、外观的 log 式对比度（1.2，枢轴 0.4）、`AgX_Base_sRGB.cube`（57³）、2.4 次方、sRGB 编码；矩阵与参数由 `bake_agx.py` 的 `chain` 从 Blender 当场取，两张表直接读 Blender 自带的 `.cube`。剩下约 2e-5 的差来自 OCIO 处理器里对数与幂的快速近似（单测它的 log2(8) 得 3.0000129）。要换成算子链，锁要钉三样：`config.ocio`、`AgX_Base_sRGB.cube`、`luminance_compensation_bt2020.cube` 的 sha256（Blender 5.2.0 LTS 上依次是 `sha256:47a7d83e79c1d21f49ba6c505efe311da723471688c614b5c366e1da7eb8ea3a`、`sha256:e707a36f3e90ee79bc342332febf91334c02ce3974cac700ece00ca9d4507491`、`sha256:e3f5adcd8c08f77a96be141e8d504d58125cc80216a7a641abc970c85840cfd2`；第 6 级的报告里也记着），而锁契约的 `lock.view` 一个视图只放一个哈希，所以交付链还没换：要先改锁契约，再把算子链写成 ffmpeg 滤镜链接进 `../stitch.mjs`。在那之前第 6 级判的是交付链的 65³ 表，结论是 `blocked-on-contract`（色彩一半不过），算子链只是候选。

**用场景参考镜头的作品要知道：** 现在的交付链对 Blender 直出，灰阶最多差 1 级，饱和色和黄色折点一带最多差 8 级（8 位，浮点 2.9e-2）。这是 65³ 表本来就有的偏差，不是第 6 级改出来的，第 6 级只是第一次把它量出来；改锁契约、换成算子链之前一直如此。
