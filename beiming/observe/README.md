# 感知

从产物提取可供验收使用的观测结果。

通过契约接收待观察的产物，并交接观测记录。跨组件通过契约交接，引用旧目录须命中白名单。

业务契约：[输出通道](../kernel/contracts/passes/CONTRACT.md)（可读取的通道）、[每帧元数据](../kernel/contracts/meta/CONTRACT.md)（相机、实体与读数）、[参考包](../kernel/contracts/ref-pack/CONTRACT.md)（对照用的标准答案）。

通用约定见[契约目录](../kernel/contracts/)、[契约写法约定](../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。

## 曲线与时间遥测

均从 [index.mjs](index.mjs) 导出，同步执行，回答序列化后不超过 600 token，装不下就保留最显著的条目并置 `truncated: true`；参数不对返回 `{ ok: false, error: { code: 'usage.bad-argument', message } }`，不抛异常。

- `curves(input, { track | entity, shot?, quantity?, range? })`：不渲染，读 `tracks/0.1`（`{ indexJson, bin }` 或已解码的轨道映射），回答 `peaks`、`zeroPlateaus`、`monotonicSegments` 和 `easing`（`hold`、`step`、`linear`、`ease-in`、`ease-out`、`ease-in-out`、`oscillating`）。实体没有轨道时，`input` 给 `{ tracks, metas }`，回退读 `meta/0.1` 的 `screenX`、`screenY`、`pxArea`、`visible`，优先按 `shot` 过滤并用 `shotFrame` 对齐局部帧号，`source` 为 `'meta'`。
- `telemetry(input, { range? })`：八分之一分辨率亮度平面上的帧间运动能量、横向重心（-1 到 1）、`detectedCuts`、`holdSpans`、亮度分位与 `flicker`（含逐帧与隔帧频闪的 `detected`、`reversalRate`、`maxAmplitude`、`spans`），算法同 `engine/render/events.mjs`。`input` 三选一：`{ width, height, frames, fps?, rangeMode? }`、`{ kinematics }`、`{ videoPath, scaleDiv? }`（ffmpeg 抽平面，不经 shell）；都可带 `audio: { loudnessLufs, truePeakDbtp, events, onsets }`，回 `onsetOffsets` 与 `maxOnsetFrameDelta`。

字段口径见 [curves.mjs](curves.mjs) 与 [telemetry.mjs](telemetry.mjs) 的文件头。

## 画面比对与对齐拟合

均从 [index.mjs](index.mjs) 按名导出，同步执行，回答序列化后不超过 500 token，超限时按优先级截断并置 `truncated: true`；参数不对返回 `{ ok: false, error: { code: 'usage.bad-argument', message } }`，不抛异常。

- `compare(a, b, options?)`：支持 RGB 图像对象、PNG 路径/缓冲或 `{ video, frame?, fps? }` 视频帧，复用白名单 `tools/baseline/lib/metrics.mjs` 与 `tools/eval/lib/metrics.mjs`（PSNR、SSIM、maxDiff、fracAbove1/2、seamDeltaE、paletteDeltaE、lineCoverage、grainEnergy）并补 Rec.709 亮度分位差（`lumaP05`/`lumaP50`/`lumaP95`），输出结构化 `rows` 与容差判定 `pass`，支持 `heatmapPath` 写出差异热图。
- `align(request)`：支持单选或组合调用四种对齐：`cuts`（单调最优切点匹配 `pairs`/`missed`/`extra`）、`stretch`（20ms 能量包络或经 ffmpeg 抽 PCM 算 RMS 包络的网格互相关偏移与拉伸比求解，`corr < 0.5` 标 `reliable: false`）、`composition`（包围盒中心偏移、面积比与 `iou`）、`camera`（`>= 4` 组 3D-2D 点对的 7 参数阻尼高斯-牛顿相机拟合，输出对齐 `meta/0.1` 的列主序 `world`/`proj`、`pos`/`rotation`/`fovY` 与重投影 `rmsePx`）。

字段口径见 [compare.mjs](compare.mjs) 与 [align.mjs](align.mjs) 的文件头。
