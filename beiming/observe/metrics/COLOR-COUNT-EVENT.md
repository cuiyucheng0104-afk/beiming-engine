# 颜色占比事件

`metric:color.count-event` 量每个画面中指定 RGB 颜色的像素占比，找出占比突降的帧。

```js
const reading = await colorCountEvent(videoPath, {
  color: '#F09800',
  similarity: 0.16,
  roi: { x: 1176, y: 192, width: 1080, height: 1920 },
});
```

- `colorCountEvent(filePath, options)` 读取本地视频的第一条视频流。`color` 为 `#RRGGBB`，`similarity` 为 FFmpeg `colorkey` 的 `[0.01, 1]` 容差，默认 `0.16`。匹配依据是 8 位 RGB，输入 alpha 不参与匹配。
- `roi` 默认取全画面，`exclude` 可指定一个在 ROI 内的角标矩形。二者都用 FFmpeg 应用显示旋转后解码像素格的左上坐标和整数宽高，右边界及下边界不计入。先在解码格式中按指定像素裁切，再转换 RGBA。角标里的匹配像素从分子扣除，占比仍以完整 ROI 像素数为分母。
- `detectColorCountEvents(coveragePercent, options)` 可直接量已取得的逐帧占比，数值范围为 `[0, 100]`。两种入口均支持 `lagFrames`（默认 `2`）、`minCoveragePercent`（默认 `0.02`）和 `dropRatio`（默认 `0.5`）。默认在第 `n−2` 帧占比严格大于 `0.02%`，且第 `n` 帧占比严格小于第 `n−2` 帧的一半时命中。相邻命中合并，仅报第一帧。
- 结果 `value` 为事件帧号数组。`details.coveragePercent` 含所有帧的占比，`details.lastAboveThresholdFrame` 是最后一帧严格超过阈值的帧号，无此帧时为 `null`。视频入口还返回 `details.displaySize`、`details.roi` 和 `details.exclude`。
- 帧号从 0 起，按解码显示顺序，变帧率时间戳不改变帧号。视频入口使用 `FFMPEG` 或 `PATH` 中的 FFmpeg，流式读取颜色掩码。缺工具返回 `value: null` 和 `details.code: 'tool-missing'`，解码失败抛错，无事件返回空数组。

## 案例 27 复算

按原量测脚本的右面板裁切、橙色目标和掩码阈值复算。510 个逐帧占比与原报告所用的数据最大相差 `0.000001961` 个百分点，差值来自 FFmpeg `signalstats` 文本输出的舍入。最后一帧超过阈值的是第 386 帧。22 个事件帧与原报告一致。

```text
27 39 51 63 81 99 105 123 135 153 165 188 195 213 225 237 249 336 345 369 376 387
```
