# 感知

从产物提取可供验收使用的观测结果。

通过契约接收待观察的产物，并交接观测记录。跨组件通过契约交接，引用旧目录须命中白名单。

业务契约：[输出通道](../kernel/contracts/passes/CONTRACT.md)（可读取的通道）、[每帧元数据](../kernel/contracts/meta/CONTRACT.md)（相机、实体与读数）、[参考包](../kernel/contracts/ref-pack/CONTRACT.md)（对照用的标准答案）。

通用约定见[契约目录](../kernel/contracts/)、[契约写法约定](../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。

## 曲线与时间遥测

均从 [index.mjs](index.mjs) 导出，同步执行，回答序列化后不超过 600 token，装不下就保留最显著的条目并置 `truncated: true`；参数不对返回 `{ ok: false, error: { code: 'usage.bad-argument', message } }`，不抛异常。

- `curves(input, { track | entity, quantity?, range? })`：不渲染，读 `tracks/0.1`（`{ indexJson, bin }` 或已解码的轨道映射），回答 `peaks`、`zeroPlateaus`、`monotonicSegments` 和 `easing`（`hold`、`step`、`linear`、`ease-in`、`ease-out`、`ease-in-out`、`oscillating`）。实体没有轨道时，`input` 给 `{ tracks, metas }`，回退读 `meta/0.1` 的 `screenX`、`screenY`、`pxArea`、`visible`，`source` 为 `'meta'`。
- `telemetry(input, { range? })`：八分之一分辨率亮度平面上的帧间运动能量、横向重心（-1 到 1）、`detectedCuts`、`holdSpans`、亮度分位与 `flicker`（`detected`、`reversalRate`、`maxAmplitude`、`spans`），算法同 `engine/render/events.mjs`。`input` 三选一：`{ width, height, frames, fps?, rangeMode? }`、`{ kinematics }`、`{ videoPath, scaleDiv? }`（ffmpeg 抽平面，不经 shell）；都可带 `audio: { loudnessLufs, truePeakDbtp, events, onsets }`，回 `onsetOffsets` 与 `maxOnsetFrameDelta`。

字段口径见 [curves.mjs](curves.mjs) 与 [telemetry.mjs](telemetry.mjs) 的文件头。
