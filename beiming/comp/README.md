# 合成收尾

接收[帧源](../kernel/contracts/source/CONTRACT.md)与[输出通道](../kernel/contracts/passes/CONTRACT.md)，按[片子描述](../kernel/contracts/film/CONTRACT.md)交付成片。公共入口在 `index.mjs`；跨组件交接遵循[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。

## 混用镜头

`frames[shotId].overlay` 接收 `{ pattern, start?, kind?: 'png', opacity? }`。带 `%0Nd` 的直通 RGBA PNG 与底图逐帧配对，`start` 默认 0，`opacity` 默认 1，值域 `(0, 1]`。叠加在 AgX 或 sRGB 显示变换之后、收尾与 BT.709 转换之前。

```js
const overlay = await renderAnchoredOverlayFrames({ meta, params, outDir: overlayDir })
await composeMixedFilm({ ...deliverOpts, overlayShot: 's01', overlay })
```

`meta` 按局部帧号排列，尺寸与底图一致。`params.callouts` 指定实体、可选锚点名、文字及相对偏移。换机位只需传入新帧和新 `meta`。传入已启动的 `pageSource` 会用 three 页面宿主渲染 `x7-overlay.shot.js`，省略则由 `overlay.anchored` 离屏绘制。`overlayDir` 是父目录已存在的新目录。交付开启 `web` 和 `contact`，切点来自片子镜头表。`run.json` 的编码参数记录叠加输入路径。

## 显示变换：AgX 查找表

场景参考镜头的 AgX 查找表怎么烘、sha256 怎么进锁、第 6 级的读数与还没换的算子链，见 [lut/README.md](lut/README.md)。

## 流式输出

`encode(opts)`、`deliver(opts)` 默认同步。传 `sinkFactory` 后返回 Promise，参数错误也会拒绝。例如 `await deliver({ ...opts, sinkFactory: openEncoderSink })`。

每个输出调用一次 `sinkFactory({ path, preset, args, timeoutMs, expectedFrames })`，返回 `{ write, finish, abort }` 或其 Promise。各端收到相同的 yuv420p 字节，块可跨帧；全部 `write(chunk)` 完成才读取下一块。`args` 从 `pipe:0` 读输入，不含输出文件名。

- `openFileSink({ path })`（别名 `openSink`）原样保存字节，可用于导出裸 YUV。
- `openEncoderSink(spec)`（别名 `startEncoderSink`）送入 FFmpeg；`timeoutMs` 覆盖单个管道进程的整个生命周期，包括等待 drain。`finish()` 关闭输入，确认输入与产物非空、退出码为 0，且收到 `-progress pipe:1` 的完成回报，才从同目录临时文件原子发布。`encode` 会传入预期帧数，独立调用也可指定；帧数不符不发布。
- `await sink.abort()` 可重复调用，未发布的文件会清理，不覆盖已有成品。多路 `encode` 不回滚已发布的其他端。需要整包原子发布用 `deliver`：每个工厂须在 `finish()` 时交出对应预设的 MP4。若宿主被强杀，确认相关进程已退出，再清理该次遗留的 `.beiming-*`。

## 事件拟音

在 `events/0.1` 条目中选 `foley.impact`、`foley.step`、`foley.metal` 或 `foley.cloth`。例如 `{ "id": "step1", "kind": "named", "from": "film", "frame": 24, "sub": 0.5, "audio": "foley.step", "sync": "pcenter" }`。

`mixEvents(events, { seed })` 输出 48 kHz 立体声。前导、接触、主体与余响按 `frame + sub` 对齐起音（`onset`）或接触重心（`pcenter`）。每种材质轮换四个变体，每次独立微调噪声、音高和均衡；`deliver` 使用锁定的全片种子，同一输入可逐位重放。

非静音母带按 320k 母版与 192k 网页预设试编 AAC。真峰值超标或集成响度偏离目标超过 0.9 LU（距 ±1 LU 窗口边缘不足 0.1 LU）时，从原混音重限幅并补偿响度；`deliver` 还会在发布前复量实际成片。运行 `node --test --test-name-pattern=X5-R4-Red beiming/comp/x5.test.mjs` 复测四种材质；设 `X5_FULL_MATRIX=1` 可展开间隔与衣料全矩阵。

## Python 程序化声音脚本

`runAudioScript({ script, events, outPath, workDir, args, python, cwd, env, timeoutMs, expectedFrames, fps })` 不经 shell 调用事件表驱动的 `.py` 声音脚本（如 numpy 程序化合成的 `sound.py`）：

- `resolvePython(explicitPython?)` 按 `explicitPython` → `BEIMING_PYTHON` → `BEIMING_PY` → `PYTHON` → 仓库 `.venv` → 系统 `python3` 解析解释器（优先选含 `numpy` 的环境）。
- 向脚本传入 `--events <events.json> --out <out.wav>`（以及可选附加 `args`），并设置 `BEIMING_EVENTS`、`BEIMING_AUDIO_OUT`、`BEIMING_FRAMES`、`BEIMING_FPS`。`events` 可传 JSON 路径或内存事件表对象。
- 校验退出码为 0，输出为 48 kHz 单声道或立体声 WAV、样本有限且与 `expectedFrames` 对齐，并自动收集同目录伴随的 `report.json` 与 `stems/*.wav`。
- `deliver({ ...opts, audioScript: { script, events?, args?, python?, at?, gainDb?, mastered?, timeoutMs? } })` 将脚本作为第一阶段声音工序并写入 `run.json` 的 `audio-script` 步骤（路径脱敏为 `<script>`、`<events>`、`<work>`、`<arg-path:i>`，分隔符统一为 `/`）。`mastered: true` 时跳过二次 `masterAudio` 限幅以保留脚本自带母带（拒绝全零静音与响度/峰值越界），并执行成片 `measureLoudness` 与 `measureAac` 交付核验。
