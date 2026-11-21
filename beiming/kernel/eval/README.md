# kernel/eval/：求值小件

纯函数，不依赖任何渲染库，页面和 node 两边都能引用。统一入口是 `index.mjs`，也可按文件引用。

| 文件 | 管什么 |
|---|---|
| `time.mjs` | 镜头局部帧号换成全片帧号 `globalFrame(f, shotIn)`、`hold(f, n)`、一帧的子帧采样相位 `shutterSubs(angleDeg, samples)` |
| `rng.mjs` | 命名随机流：`streamName(seed, shotId, arg)` 展开流名，`stream(name)` 按流名开一条流（`next()` 出 `[0, 1)` 的数，`u32()` 出 32 位无符号整数，`name` 是流名，只读） |
| `input.mjs` | 镜头输入 `shotInput(film, shotId, events)`：从片子描述算出帧源 `open` 的第一个参数 `{ film, output: { size, fps }, shot, assets?, events?, overlays?, tokens? }`，镜头条目原样；`eventsTable(film)`：把片子描述的事件和切点展开成事件表；`renderingOf(shot)`：一个镜头出帧用的那一套 `source`、`host`、`mode`、`entry` |
| `events.mjs` | `expandEventFrames(film)` 按事件名返回全片整数帧号，`eventsTable` 用这份结果生成按帧号、标识排序的 `events/0.1` 表 |
| `tracks.mjs` | `encodeTracks(trackMap, meta)` 写索引与字节，`decodeTracks(indexJson, bin)` 还原轨道 |
| `interp.mjs` | `clampShotSample`、`evalClosedForm`、`interpVec3`、`slerpQuat`、`interpQuat` 处理本镜头内的子帧样本 |

## 事件时刻

`eventsTable(film)` 按片子描述契约 5.3 检查事件、叠加层和旁白的时刻。时刻可以直接写非负整数帧号。算式的基点只允许 `cut(<非负十进制整数>)` 或 `event(<id>)`。切点帧号无前导零，且须是相邻镜头的交界帧，例如切点在第 180 帧时，`cut(180) + 12` 得到第 192 帧。`event(cue)` 取命名事件 `cue` 展开后的全片帧号，允许向后文引用。基点可直接使用，也可加减无前导零的十进制正整数帧偏移，运算符两边各一个空格。

时刻不合法时抛出 `RangeError` 并拒收这份片子描述。`.code` 使用已登记的 `contract.bad-value`，`.reason` 区分具体原因，例如 `invalid_expression`、`undefined_cut` 或 `event_cycle`。

## 轨道读写

以下索引布局、样本格式与坐标系为本次实现选择，待轨道契约正式定稿。

`trackMap` 是按轨道名索引的对象，每项形如 `{ type: 'vec3', samples: [[0, 1, 2], [3, 4, 5]] }`。每个数组元素对应一帧，坐标以米计，采用右手系，Y 向上。

| `type` | 一帧样本 | 每帧分量数 |
|---|---|---:|
| `scalar` | 数，单位由轨道定义 | 1 |
| `vec3` | `[x, y, z]`，米 | 3 |
| `quat` | `[x, y, z, w]`，无量纲 | 4 |
| `camera` | `{ pos, quat, fovDeg }`，位置以米计，视场角以度计 | 8 |
| `bbox` | `{ min, max }`，两个三维点，米 | 6 |

编码结果的 `indexJson` 形如 `{ format: 'tracks/0.1', meta, tracks: [{ name, type, stride, offset, count }] }`。`meta` 保存调用方提供的 JSON 元数据副本，默认 `{}`。不能序列化为 JSON 的元数据会抛出 `TypeError`。索引按轨道名升序排列，每项只允许上列五个字段。`stride` 是每帧分量数，`offset` 是相对 `bin` 起点的字节偏移，`count` 是样本帧数。`bin` 是 `Uint8Array`，轨道顺序与索引一致，每个样本按上表字段顺序紧凑写成小端 float32，每个分量占 4 字节。解码结果使用普通数组，数值为写入时舍入到单精度的值。

## 子帧采样

镜头局部采样区间为 `[0, shotFrames)`。`clampShotSample(f, sub, shotFrames)` 校验局部整数帧 `f` 和相位 `sub ∈ [0, 1)`，返回 `f + sub`，单位为帧。`evalClosedForm(fn, f, sub, shotFrames)` 把该时刻交给 `fn`，末帧保留相位。`interpVec3(samples, f, sub, shotFrames)` 和 `interpQuat(samples, f, sub, shotFrames)` 都从本镜头的第一个样本起计帧，末帧保持本镜头的末样本。向量逐分量线性插值，四元数按短弧球面插值，接近共线时归一化线性插值。`slerpQuat(q0, q1, t)` 接收 `[0, 1]` 内的无量纲相位。

## 时间和随机流


- 时间是整数帧，子帧相位在 `[0, 1)`。
- 子帧采样在快门窗口 `[0, 快门角 ÷ 360)` 里居中分层：第 i 个取 `(i + 0.5) ÷ 个数 × 窗口长度`。
- 随机流的序列只由流名决定：流名散列成四个 32 位状态，再用 sfc32 出数。算法由测试里的两个数钉住。

测试：`node --test 'beiming/kernel/eval/*.test.mjs'`
