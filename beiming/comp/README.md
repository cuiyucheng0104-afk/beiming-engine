# 合成收尾

对帧源产物做合成和收尾处理。

通过契约接收帧源产物，并交付合成结果。跨组件通过契约交接，引用旧目录须命中白名单。

业务契约：[帧源接口](../kernel/contracts/source/CONTRACT.md)（帧产物的来源）、[输出通道](../kernel/contracts/passes/CONTRACT.md)（各通道的数值定义）、[片子描述](../kernel/contracts/film/CONTRACT.md)（画风与成片交付规格）。

## 流式输出

`encode(opts)` 和 `deliver(opts)` 默认同步。传入 `sinkFactory` 后用 `await` 取得结果。例如 `await deliver({ ...opts, sinkFactory: openEncoderSink })` 按原预设交付母版和网页片。所有入口均从 `index.mjs` 导入。

每个输出调用一次 `sinkFactory({ path, preset, args, timeoutMs })`。`args` 是读 `pipe:0` 的 FFmpeg 参数，末尾留给输出文件名。工厂返回 `{ write, finish, abort }`，也可返回其 Promise。拼接器将同一份 yuv420p 字节分发给各端，块可跨帧，全部 `write(chunk)` 完成才继续读取。用于 `deliver` 的工厂须在 `finish()` 完成时将符合预设的 MP4 写到指定 `path`，整包核验通过后才发布。

- `openFileSink({ path })`（`openSink`）原样保存字节，可配合 `encode` 导出裸 YUV。
- `openEncoderSink({ path, args, timeoutMs })`（`startEncoderSink`）把字节送入 FFmpeg。两种输出端都在同目录暂存，`finish()` 关闭输入并原子重命名，编码端还会核对退出码。取消时 `await sink.abort()` 可重复调用；中途失败或取消会回收资源，已有成品会保留。

## 事件拟音

在 `events/0.1` 条目里设置 `audio` 为 `foley.impact`、`foley.step`、`foley.metal` 或 `foley.cloth`，`sync` 为 `onset` 或 `pcenter`。例如 `{ "id": "step1", "kind": "named", "from": "film", "frame": 24, "sub": 0.5, "audio": "foley.step", "sync": "pcenter" }`。

音色包含前导、接触瞬态、主体与余响。`mixEvents(events, { seed })` 按材质轮换音高与均衡，依 `frame + sub` 对齐起音或感知重心，返回 48 kHz 立体声。`deliver` 使用 `film.lock` 的全片种子。

通用约定见[契约目录](../kernel/contracts/)、[契约写法约定](../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。
