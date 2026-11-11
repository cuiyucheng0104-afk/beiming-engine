# 三条路线的执行面：技术分档与代码入口

> 读者：要知道画面在哪里执行、做到哪一步的人｜状态：技术分档说明｜依据：2026-11-12，按决定 D01、D03、D04、D06 修订

本页只讲每条路线的**执行面**：画面在哪里算、代码入口、已实现与未完成、怎么验收。选路线见 [routes/README.md](../routes/README.md)；做作品的步骤在三份路线手册里；引擎工程的任务状态以[工程待办](routes/work-breakdown.md)的 T / H 编号为准（`npm run plan:next`）。三条路线新建作品都用 `npm run new`，出片都用 `npm run film -- build films/<名字>`。

## A · 北冥风格路线 · WebGL 三渲二

| 项 | 内容 |
|---|---|
| 执行面 | 页面渲染器 `engine/render`：无头 Chrome（playwright-core 锁定的 headless shell）+ WebGL（ANGLE；Windows 默认 Vulkan、macOS Metal）+ Canvas 2D；FFmpeg 编码 |
| 画面语言 | 三色分档卡通着色、屏幕空间 ID 墨线、Kuwahara 笔触、AI 生成后整理的绘画底板视差、Canvas 2D 人物、显示层独立合成 |
| 代码入口 | `engine/`（九层）、`routes/a-webgl/template/`（作品模版）、`src/`（《北冥》样片，只读基准）、`lab/`（模块自测） |
| 页面约定 | `window.DUR / render(t) / READY`，可选 `TEXTS`；确定性，渲染路径不用 `Date.now` 与无种子随机（完整约定见 [engine/render/README.md](../engine/render/README.md)） |
| 已实现 | 模版出片 `npm run film -- build`；《北冥》`npm run beiming:build`；1080p 与 4K 实测已记录：4K 下三维、墨线、纸纹、显示层是原生 4K，绘画底板为放大（AI 原图 ×2，见 [渲染与 4K](渲染与4K.md)） |
| 验收 | 机器 QA 门（帧数、尺寸、音轨、完整解码、文字、底板密度）；视觉与动作人工验收；改了共享画面跑金标准比对；4K 成绩只属于这条路线 |
| 未完成 | FrameState 与跨后端适配、完整人物表演（工程待办 T04、T08） |

## B · 北冥原生 · BNE

| 项 | 内容 |
|---|---|
| 执行面 | 上游原生运行时 RAEA `0.1.0-canary.2`（Rust + Bevy，原生 GPU）；不随仓库分发，`RAEA_BIN` 指向可执行文件；编码器按实际记录 |
| 代码入口 | `engine/native/`（TSX 组件库、准备阶段、资产桥、交付）、`engine/render/native.mjs`（唯一出片入口）、`routes/b-native/template/`；`examples/raea/` 是《北冥》10 秒例片 |
| 命令 | `npm run film -- build films/<名字>`；底层 `npm run b:prepare`、`b:preflight`、`b:render`（旧名 `native:*`、`raea:*` 保留一个版本）；运行时三平台归档与可执行文件哈希锁在 `engine/native/runtime.lock.json`，`npm run b:runtime -- status` 核对 |
| 资产桥 | 程序化造型 → GLB（几何、顶点色、骨骼或 morph 动画）→ 原生场景；外部 GLB、图片、视频、A / C 的页面作品也能进同一个场景 |
| 已实现 | 模版与例片出片；资产转换与回读验证；运行时版本锁与源码对照 |
| 验收 | 实际设备、图形后端、编码路径分别记录；不能用 WebGL 的 Vulkan 记录代替原生 GPU 证据 |
| 未完成 | A 路线墨线、Kuwahara、卡通材质的原生等价；人物表演；Windows / 5090 上用新入口重跑（工程待办 T08、T10–T12） |
| 许可 | RAEA 以 FSL-1.1-ALv2 发布，只作内部制作层：交付成片，不对外提供产品、SDK 或渲染服务，见 [fsl-boundary.md](rights/fsl-boundary.md) 与 [THIRD-PARTY](../THIRD-PARTY.md)。目录 `examples/raea/`、`docs/raea/` 与命令 `raea:*` 沿用上游项目名（内部目录沿用），不是对外名称 |

## C · 北冥代码动画风格 · 86 式

| 项 | 内容 |
|---|---|
| 执行面 | 与 A 共用页面渲染器 `engine/render`；画法用 Canvas 2D、SVG、DOM/CSS、WebGL 各自实现，没有统一着色器；不是第三个 GPU 后端（D01） |
| 代码入口 | `routes/c-style/template/`（可直接出片的 C 模版）、`routes/c-style/STYLES.md`（86 式索引）、`cases/vendor/`（两套风格库的只读快照：Lemo 66 + SY 20）、`cases/source/`（历史成片源码） |
| 用法 | 新片用 C 模版出片；取方法后在模版里重写或落到 A、B；复刻历史作品见 [REPLICATE.md](../routes/c-style/REPLICATE.md) |
| 状态 | 风格库为固定快照，逐文件 SHA256 校验；Lemo 的 66 种各有一部历史风格实验，源码可还原 |
| 验收 | 新片过同一道机器 QA 门；历史成片看还原后的源码与观看版；风格名与实现要对得上，不能只改标签 |
| 边界 | 风格库是第三方 MIT 实现，保留原作者版权与许可；**不删除、不改写、不冒充原创**，明细见 [THIRD-PARTY](../THIRD-PARTY.md) |

## 三条路线共用的规矩

1. **证据分路线**：A 的 WebGL 数据、B 的原生设备与编码器、C 的历史成片，三者不互相引用为对方成绩。三条路线共用同一道 QA 门；B 的原生片没有页面，文字检查不适用，底板只做静态找边，贴图密度记「不适用」。
2. **状态三分离**：已输出、技术检查通过、用户认可是三件事；归档里的历史成片不等于被认可，被否定的版本不进入作品站。
3. **许可不可移除**：风格库与 [cases/licenses](../cases/licenses) 的许可证、署名必须保留；原生运行时按其自身许可单独处理。
4. **新作品独立目录**：作品放 `films/<名字>/`；《北冥》原版 `src/` 与基准帧不动。
5. **整数帧驱动**：全局帧、镜头局部帧、动作相位分开；有状态模拟先验证顺序与跳帧（`npm run determinism`），再分段并行。

RTX 工作站是执行环境，不是路线名：装环境、让 WebGL 用上独显、远程出片见 [RTX工作站.md](RTX工作站.md)。
