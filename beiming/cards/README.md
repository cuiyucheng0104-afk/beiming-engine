# 技术卡

卡文件和数据层实现在 `cards/<类>/<名>/`，时间线、事件、随机流与插值在 `kernel/eval/`。卡格式、装载顺序、目录归属和旧目录引用白名单见[卡文件](../kernel/contracts/card-file/CONTRACT.md)、[运行时](../kernel/contracts/card-runtime/CONTRACT.md)与[组件契约](../kernel/contracts/)。

## 扫参

```js
await sweepCard(card, { params: { fovDeg: [30, 60] }, metrics: ['camera.fovDeg'] })
```

从 `index.mjs` 导入。`axes` 也接受 `{ param, values }` 或 `parseSweepAxis('fovDeg=30,60')` 的字符串写法。轴覆盖 `baseParams`，最多 64 格。`frames` 或 `times`（秒）最多 6 项，默认第 0 帧、24 fps。`inputs` 固定场景与种子，`events`、`shotIn` 解析时刻参数。

数据层卡直接求值。帧源卡在第三个参数传 `{ evaluateCell }`，回调接收 `params`、`resolvedParams`、`frame`、`time`、`cellIndex`。返回 `readings`、数值字段或 `{ rgb, width, height, channels, referenceRgb }`。RGB 字节归一化，浮点保留原值。亮度按 Rec.709，全帧亮度 SSIM、RGB 的 PSNR 和最大差需参考帧。

`rows` 按 `columns` 读取，`totalCells` 含全部采样时刻。响应最多 800 UTF-8 字节，省略行数见 `omittedRows`。传 `outDir` 时，相对此目录的 `artifacts.cellsPath` 指向含完整读数和逐格 SHA-256 的 `cells.json`。
