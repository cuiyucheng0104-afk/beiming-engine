# 感知：细则

[README.md](README.md) 是接口索引与预算说明；这里放 `compare` 与 `align` 的完整参数、容差与退化判定口径。

## `compare(a, b, options?)`

- 支持 RGB 图像对象、PNG 路径/缓冲或 `{ video, frame?, fps? }` 视频帧（一个输入对象只能给一种来源，`path`、`video`、`videoPath`、`rgb`、`data` 多给即报错）。
- 复用白名单 `tools/baseline/lib/metrics.mjs` 与 `tools/eval/lib/metrics.mjs`（PSNR、SSIM、maxDiff、fracAbove1/2、seamDeltaE、paletteDeltaE、lineCoverage、grainEnergy），并补 Rec.709 亮度分位差（`lumaP05`/`lumaP50`/`lumaP95`）与可选的超差像素占比：
  - 给 `pixelDiffThreshold`（顶层或写在 `tolerance` 里都行，两处校验相同且都给须相等：必须是 0 到 1 的有限数，`null`、布尔、字符串、`NaN` 或越界都报 `usage.bad-argument`）；
  - 一个像素的差取三通道最大的整数级数 `m`，按 `m > pixelDiffThreshold * 255` 判超差，不留浮点松弛，超差像素占比记为 `fracAboveThreshold` 一行，占比超过 `tolerance.pixelDiffMaxRatio`（默认 0）即不通过（阈值写成 `k / 255` 时差 `k` 级通过、差 `k + 1` 级不通过，比 `1/255` 略小的 `0.003921568627` 下差一级不通过）。
- 输出结构化 `rows` 与容差判定 `pass`（成对指标先用未舍入的差判定再格式化；亮度分位差先在 0 到 255 的整数灰阶上相减再除以 255，相邻一级恒为 `1/255`）。
- 支持 `heatmapPath`（别名 `heatmapOut`）写出差异热图，热图目标与任一输入实际读取的文件是同一文件（PNG 或视频，含软链、硬链）时报错不写。
- 顶层选项只认 `tolerance`、`pixelDiffThreshold`、`heatmapPath`、`heatmapOut`、`heatmapGain`、`metrics`；容差键只认 `psnrMin`、`ssimMin`、`maxDiff`、`maxFracAbove1`、`maxFracAbove2`、`pixelDiffThreshold`、`pixelDiffMaxRatio` 与 `max<指标>`（如 `maxSeamDeltaE`、`maxLumaP95Diff`，兼容 `<指标>Max` 写法），拼错的顶层选项、容差键或 `metrics` 里的未知指标名报 `usage.bad-argument`；小于 8x8 的图改用整幅单窗口 SSIM。

## `align(request)`

支持单选或组合调用四种对齐：

1. `cuts`：单调最优切点匹配 `pairs`/`missed`/`extra`（截断后仍保留 `missedCount`/`extraCount` 总数）。
2. `stretch`：20ms 能量包络或经 ffmpeg 抽 PCM 算 RMS 包络的网格互相关偏移与拉伸比求解，`corr < 0.5` 标 `reliable: false`。
3. `composition`：包围盒中心偏移、面积比与 `iou`。
4. `camera`：`>= 4` 组 3D-2D 点对的 7 参数阻尼高斯-牛顿相机拟合，输出对齐 `meta/0.1` 的列主序 `world`/`proj`、世界坐标 `pos`、相机到世界的轴角向量 `rotation`（弧度）与 `fovY`（度），都是不截断的双精度数，只用这七个参数就能重建相机，`rmsePx`/`maxErrPx` 用返回的矩阵复算。
   - `converged` 只在 `rmsePx <= 1`、无点在相机后方且 `degenerate` 为假时为真。
   - `degenerate` 由两道门给出：一是点集本身，重合、独立世界点不足 4 个（世界坐标相差不超过点集半径的 `1e-9` 视为同一点）、共线或共面且正对相机，在减质心、除以点集半径后的坐标上判定；二是解处的可辨识性，把位置按点集半径、角度与 `fovY` 按弧度归一后求重投影残差雅可比的 `J^T J`（7x7），最小与最大特征值之比低于 `1e-7` 即 7 个自由度局部不可唯一辨识（如正对平面的四角加光轴上一点，或相机距点集约 10 倍半径以上、`fovY` 约 11° 以下透视过弱时）。
   - 求解与两道门都在减去质心后的局部坐标里做，长度量按点集半径归一，结果再加回质心，世界坐标整体大平移不影响判定（回归覆盖半径 `2^-20`、平移 `262144` 及半径 `1e-9` 到 `1e9`）；`near`/`far` 或点坐标极端到 `world`/`proj` 出现非有限数时报 `usage.bad-argument`，不返回矩阵。
