# 成片配乐对位

从 `beiming/observe/index.mjs` 导入 `align`，提供成片与参考配乐的本地媒体路径。

```js
import { align } from './beiming/observe/index.mjs';

const result = align({ music: { filmPath: 'film.mp4', trackPath: 'track.wav', fps: 24 } });
```

成功结果的 `music.metric` 为 `metric:music.align`。配乐的时间 `tTrack` 在成片中对应 `offsetSec + tTrack * stretch`。正偏移表示配乐晚于成片开始，`stretch` 大于 1 表示放慢。`offsetFrames` 按调用方给出的成片 `fps` 换算，默认 24 帧每秒，保留两位小数。

FFmpeg 分别读取两份媒体的首条音轨（`0:a:0`），多音轨文件应将要量测的音轨放在首位。两份包络各自以容器开始为零点，按音频时间戳在起始延迟和内部间隙补静音，并裁去重叠采样。解码使用 8 kHz 单声道、150 Hz 低通和 20 ms RMS 窗。

求解以 20 ms 为偏移步长，以线性插值拉伸成片包络。默认搜索 ±8 秒及 0.990–1.030 倍拉伸，拉伸步长 0.001，可用 `maxOffsetSec`、`stretchRange` 和 `stretchStep` 调整。候选至少覆盖参考配乐的 90%，`overlapRatio` 报告实际覆盖比例。`corr` 的参考侧以整首配乐的中心化能量归一。

偏移候选的绝对值以 `maxOffsetSec` 为上限。例如 0.015 秒只允许零偏移，0.020 秒也允许 ±0.020 秒。拉伸率保留六位小数，搜索区间为 0.000001 到 1,000,000 内的两个实数，步长至少为 0.000001。同步量测最多接受 100,000 个网格候选，每份音频最长 300 秒，候选数与参考配乐完整窗数的乘积最多 100,000,000。超出预算时返回 `usage.bad-argument`。长配乐可缩小偏移或拉伸区间，也可增大拉伸步长。

未舍入的 `corr` 达到 0.5 时，`reliable` 为 `true`。低于 0.5 的候选可用于诊断。静音、平坦包络或覆盖不足时，偏移与拉伸为 `null`，`corr` 为 0，`reliable` 为 `false`。路径不可读、媒体没有音轨、音频不足两个完整窗口或 FFmpeg 不可用时，`align` 返回带错误码的 `{ ok: false, error }`。常规 `stretch` 及别名 `audioEnvelope`、`media` 继续使用原有宽带包络和重叠段相关。

案例 05 的成片与独立配乐在本机重新量测得到偏移 5.48 秒（24 fps 时为 131.52 帧）、拉伸 1.009、相关系数 0.8356、覆盖 98.93%。独立原量测脚本报告 5.48 秒、1.009、0.836。合成媒体用例另验证音轨起点延迟、包时间戳间隙、首音轨选择、高频干扰、已知偏移和拉伸、强尾段被截短时的低相关，以及静音。[回归测试](music-align.test.mjs)
