# 合成收尾

接收[帧源](../kernel/contracts/source/CONTRACT.md)与[输出通道](../kernel/contracts/passes/CONTRACT.md)，按[片子描述](../kernel/contracts/film/CONTRACT.md)交付成片。公共入口在 `index.mjs`；跨组件交接遵循[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)，引用旧目录须命中白名单。

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
