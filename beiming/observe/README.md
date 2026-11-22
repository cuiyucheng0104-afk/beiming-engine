# 感知

从产物提取可供验收使用的观测结果。

通过契约接收待观察的产物，并交接观测记录。跨组件通过契约交接，引用旧目录须命中白名单。

业务契约：[输出通道](../kernel/contracts/passes/CONTRACT.md)（可读取的通道）、[每帧元数据](../kernel/contracts/meta/CONTRACT.md)（相机、实体与读数）、[参考包](../kernel/contracts/ref-pack/CONTRACT.md)（对照用的标准答案）。

通用约定见[契约目录](../kernel/contracts/)、[契约写法约定](../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。

## 曲线与时间遥测

均从 [index.mjs](index.mjs) 导出，同步执行，回答序列化后不超过 600 token，装不下就保留最显著的条目并置 `truncated: true`；参数不对返回 `{ ok: false, error: { code: 'usage.bad-argument', message } }`，不抛异常。

- `curves(input, { track | entity, shot?, quantity?, range? })`：不渲染，读 `tracks/0.1`（`{ indexJson, bin }` 或已解码的轨道映射），回答 `peaks`、`zeroPlateaus`、`monotonicSegments` 和 `easing`（`hold`、`step`、`linear`、`ease-in`、`ease-out`、`ease-in-out`、`oscillating`）。实体没有轨道时，`input` 给 `{ tracks, metas }`，回退读 `meta/0.1` 的 `screenX`、`screenY`、`pxArea`、`visible`，只有显式给 `shot` 时才按它过滤并改用镜头内帧号 `shotFrame`，省略时 `range` 一律按全片帧号 `frame`，`source` 为 `'meta'`。
- `telemetry(input, { range? })`：八分之一分辨率亮度平面上的帧间运动能量、横向重心（-1 到 1）、`detectedCuts`、`holdSpans`、亮度分位与 `flicker`（含逐帧与隔帧频闪的 `detected`、`reversalRate`、`maxAmplitude`、`spans`），算法同 `engine/render/events.mjs`。`input` 三选一：`{ width, height, frames, fps?, rangeMode? }`、`{ kinematics }`、`{ videoPath, scaleDiv? }`（ffmpeg 抽平面，不经 shell）；都可带 `audio: { loudnessLufs, truePeakDbtp, events, onsets }`，回 `onsetOffsets` 与 `maxOnsetFrameDelta`。

字段口径见 [curves.mjs](curves.mjs) 与 [telemetry.mjs](telemetry.mjs) 的文件头。

## 画面比对与对齐拟合

均从 [index.mjs](index.mjs) 按名导出，同步执行，回答序列化后不超过 500 token，超限时按优先级截断并置 `truncated: true`；参数不对返回 `{ ok: false, error: { code: 'usage.bad-argument', message } }`，不抛异常。

- `compare(a, b, options?)`：支持 RGB 图像对象、PNG 路径/缓冲或 `{ video, frame?, fps? }` 视频帧（一个输入对象只能给一种来源，`path`、`video`、`videoPath`、`rgb`、`data` 多给即报错），复用白名单 `tools/baseline/lib/metrics.mjs` 与 `tools/eval/lib/metrics.mjs`（PSNR、SSIM、maxDiff、fracAbove1/2、seamDeltaE、paletteDeltaE、lineCoverage、grainEnergy）并补 Rec.709 亮度分位差（`lumaP05`/`lumaP50`/`lumaP95`）与可选的超差像素占比（给 `pixelDiffThreshold`，顶层或写在 `tolerance` 里都行，两处校验相同且都给须相等：必须是 0 到 1 的有限数，`null`、布尔、字符串、`NaN` 或越界都报 `usage.bad-argument`；一个像素的差取三通道最大的整数级数 `m`，按 `m > pixelDiffThreshold * 255` 判超差，不留浮点松弛，超差像素占比记为 `fracAboveThreshold` 一行，占比超过 `tolerance.pixelDiffMaxRatio`（默认 0）即不通过，所以阈值写成 `k / 255` 时差 `k` 级通过、差 `k + 1` 级不通过，比 `1/255` 略小的 `0.003921568627` 下差一级不通过），输出结构化 `rows` 与容差判定 `pass`（成对指标先用未舍入的差判定再格式化；亮度分位差先在 0 到 255 的整数灰阶上相减再除以 255，相邻一级恒为 `1/255`），支持 `heatmapPath`（别名 `heatmapOut`）写出差异热图，热图目标与任一输入实际读取的文件是同一文件（PNG 或视频，含软链、硬链）时报错不写。顶层选项只认 `tolerance`、`pixelDiffThreshold`、`heatmapPath`、`heatmapOut`、`heatmapGain`、`metrics`；容差键只认 `psnrMin`、`ssimMin`、`maxDiff`、`maxFracAbove1`、`maxFracAbove2`、`pixelDiffThreshold`、`pixelDiffMaxRatio` 与 `max<指标>`（如 `maxSeamDeltaE`、`maxLumaP95Diff`，兼容 `<指标>Max` 写法），拼错的顶层选项、容差键或 `metrics` 里的未知指标名报 `usage.bad-argument`；小于 8x8 的图改用整幅单窗口 SSIM。
- `align(request)`：支持单选或组合调用四种对齐：`cuts`（单调最优切点匹配 `pairs`/`missed`/`extra`）、`stretch`（20ms 能量包络或经 ffmpeg 抽 PCM 算 RMS 包络的网格互相关偏移与拉伸比求解，`corr < 0.5` 标 `reliable: false`）、`composition`（包围盒中心偏移、面积比与 `iou`）、`camera`（`>= 4` 组 3D-2D 点对的 7 参数阻尼高斯-牛顿相机拟合，输出对齐 `meta/0.1` 的列主序 `world`/`proj`（双精度不截断）、`pos`/`rotation`/`fovY`，`rmsePx`/`maxErrPx` 用返回的矩阵复算；`converged` 只在 `rmsePx <= 1`、无点在相机后方且 `degenerate` 为假时为真，`degenerate` 由两道门给出：一是点集本身，重合、独立世界点不足 4 个（同一世界点重复给不算数，世界坐标相差不超过点集半径的 `1e-9` 即视为同一点）、共线或共面且正对相机，在减质心、除以点集半径后的坐标上判定；二是解处的可辨识性，把位置按点集半径、角度与 `fovY` 按弧度归一后求重投影残差雅可比的 `J^T J`（7x7），最小与最大特征值之比低于 `1e-7` 即 7 个自由度局部不可唯一辨识，例如正对平面的四角加光轴上一点，三维点不共面，但相机前后移动可由 `fovY` 完全补偿，重投影误差为 0 也不算收敛；相机离点集很远、透视很弱时这个比值同样会掉到门限以下，照标 `degenerate`（实测 8 点立体点集撑满画面时，距离约为点集半径 10 倍、`fovY` 约 11° 起触发，8 倍、14° 仍正常）。两道门与求解用的长度量都按点集半径（各点到质心的最大距离）归一，半径在 `1e-9` 到 `1e9` 之间有回归测试，超出这个范围不保证收敛，届时如实给 `converged: false`；`near`/`far` 或点坐标极端到 `world`/`proj` 出现非有限数时报 `usage.bad-argument`，不返回矩阵）。`cuts` 截断后仍保留 `missedCount`/`extraCount` 总数。

字段口径见 [compare.mjs](compare.mjs) 与 [align.mjs](align.mjs) 的文件头。
