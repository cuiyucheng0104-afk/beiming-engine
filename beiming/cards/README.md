# 技术卡

卡在 `cards/<类>/<名>/`，时间线在 `kernel/eval/`。[契约](../kernel/contracts/)

## 扫参

```js
import { sweepCard } from './index.mjs';
await sweepCard(card, { params: { fovDeg: [30, 60] }, metrics: ['camera.fovDeg'] });
```

`axes` 可用 `{ param, values }` 或字符串 `'fovDeg=30,60'`。轴覆盖 `baseParams`，最多 64 格，每格最多 6 个 `frames` 或 `times`（秒），默认第 0 帧、24 fps。`inputs` 固定场景与种子，`events`、`shotIn` 解析时刻。

数据卡直接运行。第三参 `{ evaluateCell }` 接收 `params`、`resolvedParams`、`frame`、`time`、`cellIndex`，返回 `readings`、数值字段或 `{ rgb, width, height, channels, referenceRgb }`。字节像素归一化，浮点按原值。Rec.709 亮度指标有 `lumaMean`、`lumaMin`、`lumaMax`、`lumaP05`、`lumaP50`、`lumaP95`、`lumaP99` 和 `contrast`（P95−P05）。另有 `highlightClipRatio`、`shadowCrushRatio`，以及需参考帧的 `psnr`、`ssim`、`maxDiff`。

`columns` 对应 `rows`，数值舍入到 4 位小数。响应限 800 UTF-8 字节，`totalCells` 含各时刻，`omittedRows` 为省略行数。传 `outDir` 时，`artifacts.cellsPath` 指向目录内含原始读数与逐格 SHA-256 的 `cells.json`。求值前检查路径，拒绝业务软链和外来文件，可重写摘要有效的旧产物。入参或目录无效报 `usage.bad-argument`，求值、量测、表头超限或产物格式与摘要错误报 `contract.bad-value`。
