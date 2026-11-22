# 合成收尾

对帧源产物做合成和收尾处理。

通过契约接收帧源产物，并交付合成结果。跨组件通过契约交接，引用旧目录须命中白名单。

业务契约：[帧源接口](../kernel/contracts/source/CONTRACT.md)（帧产物的来源）、[输出通道](../kernel/contracts/passes/CONTRACT.md)（各通道的数值定义）、[片子描述](../kernel/contracts/film/CONTRACT.md)（画风与成片交付规格）。

## 流式输出

`encode(opts)` 和 `deliver(opts)` 默认同步。传入 `sinkFactory` 后始终返回 Promise，参数错误也通过拒绝报告。例如 `await deliver({ ...opts, sinkFactory: openEncoderSink })` 按原预设交付母版和网页片。所有入口均从 `index.mjs` 导入。

每个输出调用一次 `sinkFactory({ path, preset, args, timeoutMs, expectedFrames })`。`args` 是读 `pipe:0` 的 FFmpeg 参数，末尾留给输出文件名。工厂返回 `{ write, finish, abort }`，也可返回其 Promise。拼接器将同一份 yuv420p 字节分发给各端，块可跨帧，全部 `write(chunk)` 完成才继续读取。用于 `deliver` 的工厂须在 `finish()` 完成时将符合预设的 MP4 写到指定 `path`，整包核验通过后才发布。

- `openFileSink({ path })`（`openSink`）原样保存字节，可配合 `encode` 导出裸 YUV。
- `openEncoderSink({ path, args, timeoutMs })`（`startEncoderSink`）把字节送入 FFmpeg。`timeoutMs` 从各管道进程启动计时，覆盖其整个生命周期（含等待背压），不随 `write` 重置，也不是整次 `deliver` 的时限。两种输出端均在目标同目录暂存，`finish()` 关闭输入后原子发布；编码端还要求有非空输入、非空产物、退出码 0 和 FFmpeg 在标准输出的 `-progress pipe:1` 完成回报。`encode`/`deliver` 会传 `expectedFrames`，独立调用也可提供；帧数不符不发布。若替换编码器程序，须兼容这一 FFmpeg 进度协议。
- 取消时 `await sink.abort()`，可重复调用。未发布的输出端失败或取消不会覆盖其原成品。多路 `encode` 按端发布，某端失败不回滚其他已发布的文件；需要整包原子发布用 `deliver`。若宿主被强杀，来不及执行清理，调用方须先确认相关进程均已退出，再清理本次运行遗留的 `.beiming-*` 文件或目录，不要删除其他正在运行的任务。

## 事件拟音

在 `events/0.1` 条目里设置 `audio` 为 `foley.impact`、`foley.step`、`foley.metal` 或 `foley.cloth`，`sync` 为 `onset` 或 `pcenter`。例如 `{ "id": "step1", "kind": "named", "from": "film", "frame": 24, "sub": 0.5, "audio": "foley.step", "sync": "pcenter" }`。

音色包含前导、接触瞬态、主体与余响。`mixEvents(events, { seed })` 依 `frame + sub` 对齐起音或接触重心，返回 48 kHz 立体声。每种材质轮换四个变体，按全片种子和本材质的触发序号生成每次的噪声、音高和均衡。衣料摩擦经过两级低通，控制网页 AAC 编码后的真峰值。`deliver` 从 `film.lock` 取全片种子，同一输入可逐位重放。

复测衣料 AAC：设置环境变量 `X5_FULL_MATRIX=1`，运行 `node --test --test-name-pattern=X5-R3-Red beiming/comp/x5.test.mjs`。全量为 24 个种子 × 两种底噪 × 四种触发次数，分别读取母版与网页片的解码响度、真峰值；默认只跑固定抽样。

通用约定见[契约目录](../kernel/contracts/)、[契约写法约定](../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。
