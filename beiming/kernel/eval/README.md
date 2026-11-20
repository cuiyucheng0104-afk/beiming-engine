# kernel/eval/：求值小件

纯函数，不依赖任何渲染库，页面和 node 两边都能引用。现在只有最小出帧链路用到的几样。

| 文件 | 管什么 |
|---|---|
| `time.mjs` | 镜头局部帧号换成全片帧号 `globalFrame(f, shotIn)`、`hold(f, n)`、一帧的子帧采样相位 `shutterSubs(angleDeg, samples)` |
| `rng.mjs` | 命名随机流：`streamName(seed, shotId, arg)` 展开流名，`stream(name)` 按流名开一条流（`next()` 出 `[0, 1)` 的数，`u32()` 出 32 位无符号整数，`name` 是流名，只读） |
| `input.mjs` | 镜头输入 `shotInput(film, shotId, events)`：从片子描述算出帧源 `open` 的第一个参数 `{ film, output: { size, fps }, shot, assets?, events?, overlays?, tokens? }`，镜头条目原样；`eventsTable(film)`：把片子描述的事件和切点展开成事件表（帧号只认整数，时刻算式不会展开）；`renderingOf(shot)`：一个镜头出帧用的那一套 `source`、`host`、`mode`、`entry` |

口径：

- 时间是整数帧，子帧相位在 `[0, 1)`。
- 子帧采样在快门窗口 `[0, 快门角 ÷ 360)` 里居中分层：第 i 个取 `(i + 0.5) ÷ 个数 × 窗口长度`。
- 随机流的序列只由流名决定：流名散列成四个 32 位状态，再用 sfc32 出数。算法由测试里的两个数钉住。

测试：`node --test 'beiming/kernel/eval/*.test.mjs'`
